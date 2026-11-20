/*
 * 栅格运算内核（纯计算，不依赖 Cesium，可直接在 Node 里单测）
 * ---------------------------------------------------------------------------
 * P1-4.6「栅格运算与分级渲染」的内核部分，提供三件事：
 *
 *   1) **栅格计算器**：一个小型表达式引擎，支持
 *        dem / slope / aspect / shade 四个波段变量，
 *        运算符 + - * / % ^ 以及比较与三元表达式，
 *        函数 abs sqrt log log10 exp pow min max floor ceil round
 *              sin cos tan atan mod clamp ifelse
 *      例：`slope * 2 + dem * 0.1`、`ifelse(dem > 500, 1, 0)`
 *
 *   2) **分级（分类）断点**：自然断点（Jenks）、等距、分位数、几何级数。
 *      自然断点用经典 DP 算法（Jenks 动态规划），
 *      样本量超过阈值时先做等距抽样，保证 512² 格网也能在毫秒级算完。
 *
 *   3) **统计与直方图**：最小/最大/平均/中位数/标准差 + 等宽分箱直方图。
 *
 * 所有函数都是纯函数：不读 DOM、不读 window，可以直接
 * `require('../js/raster-ops.js')` 做单元测试。
 *
 * 对外 API（window.LERasterOps）：
 *   parse(expr)                 → AST
 *   evaluate(expr, env)         → number | Float32Array
 *   stats(values)               → { count, min, max, mean, median, std, sum }
 *   histogram(values, bins)     → { bins: [{min,max,count}], maxCount, binWidth }
 *   breaks(values, method, k)   → number[]（长度 k+1 的分界）
 *   classify(values, breaks)    → { classes: Int32Array, table: [...] }
 */
(function (root) {
  'use strict';

  /* ============================================================ 表达式解析 */

  const OPS = {
    '+': 1, '-': 1, '*': 2, '/': 2, '%': 2,
    '<': 4, '>': 4, '<=': 4, '>=': 4, '==': 4, '!=': 4,
    '&&': 3, '||': 3,
  };

  function tokenize(src) {
    const s = String(src == null ? '' : src);
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      // 数字
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j])) j++;
        const num = Number(s.slice(i, j));
        if (!isFinite(num)) throw new Error('无法识别的数字：' + s.slice(i, j));
        toks.push({ t: 'num', v: num });
        i = j;
        continue;
      }
      // 标识符
      if (/[A-Za-z_一-龥]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_一-龥]/.test(s[j])) j++;
        toks.push({ t: 'id', v: s.slice(i, j) });
        i = j;
        continue;
      }
      // 运算符（最长匹配）
      const two = s.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
        toks.push({ t: 'op', v: two });
        i += 2;
        continue;
      }
      if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' ||
          ch === '<' || ch === '>' || ch === '^' || ch === '(' || ch === ')' ||
          ch === ',' || ch === '?' || ch === ':') {
        toks.push({ t: (ch === '(' || ch === ')' || ch === ',' || ch === '?' || ch === ':') ? ch : 'op', v: ch });
        i++;
        continue;
      }
      throw new Error('表达式里出现无法识别的字符：' + ch);
    }
    toks.push({ t: 'end' });
    return toks;
  }

  /** 递归下降解析 → AST。 */
  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expect(t) {
      const tk = next();
      if (tk.t !== t) throw new Error('表达式语法错误：期望 ' + t + '，实际 ' + tk.t);
      return tk;
    }

    function parseExpr() { return parseTernary(); }

    function parseTernary() {
      const cond = parseBinary(0);
      if (peek().t === '?') {
        next();
        const a = parseExpr();
        expect(':');
        const b = parseExpr();
        return { k: 'ternary', cond: cond, a: a, b: b };
      }
      return cond;
    }

    function parseBinary(minPrec) {
      let left = parseUnary();
      for (;;) {
        const tk = peek();
        if (tk.t !== 'op') break;
        const prec = OPS[tk.v];
        if (prec == null || prec < minPrec) break;
        next();
        // ^ 右结合
        const right = parseBinary(tk.v === '^' ? prec : prec + 1);
        left = { k: 'bin', op: tk.v, a: left, b: right };
      }
      return left;
    }

    function parseUnary() {
      const tk = peek();
      if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
        next();
        return { k: 'un', op: tk.v, a: parseUnary() };
      }
      return parsePow();
    }

    function parsePow() {
      const base = parsePrimary();
      if (peek().t === 'op' && peek().v === '^') {
        next();
        const exp = parseUnary(); // 右结合
        return { k: 'bin', op: '^', a: base, b: exp };
      }
      return base;
    }

    function parsePrimary() {
      const tk = next();
      if (tk.t === 'num') return { k: 'num', v: tk.v };
      if (tk.t === 'id') {
        if (peek().t === '(') {
          next();
          const args = [];
          if (peek().t !== ')') {
            for (;;) {
              args.push(parseExpr());
              if (peek().t === ',') { next(); continue; }
              break;
            }
          }
          expect(')');
          return { k: 'call', name: tk.v.toLowerCase(), args: args };
        }
        return { k: 'var', name: tk.v };
      }
      if (tk.t === '(') {
        const e = parseExpr();
        expect(')');
        return e;
      }
      throw new Error('表达式语法错误：无法解析 "' + tk.v + '"');
    }

    const ast = parseExpr();
    if (peek().t !== 'end') throw new Error('表达式语法错误：多余的内容');
    return ast;
  }

  /* ============================================================ 表达式求值 */

  const FUNCS = {
    abs: (a) => Math.abs(a),
    sqrt: (a) => Math.sqrt(a),
    log: (a) => Math.log(a),
    log10: (a) => Math.log10(a),
    exp: (a) => Math.exp(a),
    pow: (a, b) => Math.pow(a, b),
    min: (a, b) => (b == null ? Math.min.apply(null, a) : Math.min(a, b)),
    max: (a, b) => (b == null ? Math.max.apply(null, a) : Math.max(a, b)),
    floor: (a) => Math.floor(a),
    ceil: (a) => Math.ceil(a),
    round: (a) => Math.round(a),
    sin: (a) => Math.sin(a),
    cos: (a) => Math.cos(a),
    tan: (a) => Math.tan(a),
    atan: (a) => Math.atan(a),
    mod: (a, b) => a % b,
    clamp: (a, lo, hi) => Math.min(Math.max(a, lo), hi),
    ifelse: (c, a, b) => (c !== 0 ? a : b),
  };

  function evalNode(node, env, idx) {
    switch (node.k) {
      case 'num': return node.v;
      case 'var': {
        const v = env[node.name];
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        // 数组 → 按元素取
        const x = v[idx == null ? 0 : idx];
        return x == null ? 0 : x;
      }
      case 'un': {
        const a = evalNode(node.a, env, idx);
        return node.op === '-' ? -a : a;
      }
      case 'bin': {
        const a = evalNode(node.a, env, idx);
        const b = evalNode(node.b, env, idx);
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? 0 : a / b;
          case '%': return b === 0 ? 0 : a % b;
          case '^': return Math.pow(a, b);
          case '<': return a < b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          case '!=': return a !== b ? 1 : 0;
          case '&&': return (a !== 0 && b !== 0) ? 1 : 0;
          case '||': return (a !== 0 || b !== 0) ? 1 : 0;
          default: throw new Error('未知运算符：' + node.op);
        }
      }
      case 'ternary': {
        const c = evalNode(node.cond, env, idx);
        return c !== 0 ? evalNode(node.a, env, idx) : evalNode(node.b, env, idx);
      }
      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) throw new Error('未知函数：' + node.name);
        const args = node.args.map((a) => evalNode(a, env, idx));
        return fn.apply(null, args);
      }
      default:
        throw new Error('无法求值的节点');
    }
  }

  /** 环境里数组变量的长度（0 表示纯标量环境）。 */
  function envLength(env) {
    let n = 0;
    for (const k in env) {
      if (!Object.prototype.hasOwnProperty.call(env, k)) continue;
      const v = env[k];
      if (v && typeof v.length === 'number' && typeof v !== 'string') n = Math.max(n, v.length);
    }
    return n;
  }

  /**
   * 求值。env 里的数组变量会逐元素运算，返回 Float32Array；
   * 全是标量时返回 number。
   */
  function evaluate(src, env) {
    const ast = typeof src === 'string' ? parse(src) : src;
    const e = env || {};
    const n = envLength(e);
    if (!n) {
      const v = evalNode(ast, e, 0);
      return isFinite(v) ? v : 0;
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = evalNode(ast, e, i);
      out[i] = isFinite(v) ? v : 0;
    }
    return out;
  }

  /* ============================================================== 统计量 */

  function stats(values) {
    const n = values ? values.length : 0;
    if (!n) return { count: 0, min: 0, max: 0, mean: 0, median: 0, std: 0, sum: 0 };
    let sum = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!isFinite(v)) continue;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const mean = sum / n;
    let vs = 0;
    for (let i = 0; i < n; i++) {
      const d = values[i] - mean;
      if (isFinite(d)) vs += d * d;
    }
    const std = Math.sqrt(vs / n);
    const sorted = Array.prototype.slice.call(values).filter(isFinite).sort(function (a, b) { return a - b; });
    const median = sorted.length
      ? (sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
      : 0;
    return {
      count: n,
      min: isFinite(min) ? min : 0,
      max: isFinite(max) ? max : 0,
      mean: mean,
      median: median,
      std: std,
      sum: sum,
    };
  }

  /** 等宽分箱直方图。 */
  function histogram(values, binCount) {
    const k = Math.max(2, Math.min(200, binCount | 0 || 20));
    const s = stats(values);
    const span = (s.max - s.min) || 1;
    const width = span / k;
    const bins = [];
    for (let i = 0; i < k; i++) {
      bins.push({ min: s.min + i * width, max: s.min + (i + 1) * width, count: 0 });
    }
    let maxCount = 0;
    for (let i = 0; i < (values ? values.length : 0); i++) {
      const v = values[i];
      if (!isFinite(v)) continue;
      let b = Math.floor((v - s.min) / width);
      if (b < 0) b = 0;
      if (b > k - 1) b = k - 1;
      bins[b].count++;
      if (bins[b].count > maxCount) maxCount = bins[b].count;
    }
    return { bins: bins, maxCount: maxCount, binWidth: width, stats: s };
  }

  /* ========================================================== 分级断点 */

  const BREAK_METHODS = ['自然断点', '等距', '分位数', '几何级数'];

  function sortedFinite(values) {
    const out = [];
    for (let i = 0; i < (values ? values.length : 0); i++) {
      const v = values[i];
      if (isFinite(v)) out.push(v);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function equalIntervalBreaks(lo, hi, k) {
    const out = [];
    for (let i = 0; i <= k; i++) out.push(lo + ((hi - lo) * i) / k);
    return out;
  }

  function quantileBreaks(sorted, k) {
    const n = sorted.length;
    const out = [];
    for (let i = 0; i <= k; i++) {
      const pos = (i / k) * (n - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(n - 1, lo + 1);
      const f = pos - lo;
      out.push(sorted[lo] + (sorted[hi] - sorted[lo]) * f);
    }
    return out;
  }

  function geometricBreaks(lo, hi, k) {
    const out = [];
    const a = Math.max(1e-9, Math.abs(lo));
    const b = Math.max(a * 1.0000001, Math.abs(hi));
    for (let i = 0; i <= k; i++) out.push(a * Math.pow(b / a, i / k));
    if (lo < 0) for (let i = 0; i <= k; i++) out[i] = -out[k - i];
    return out;
  }

  /**
   * 自然断点（Jenks 动态规划）。
   *
   * 经典实现复杂度 O(k·n²)。这里先对排序后的唯一值做**等距抽样**
   * （上限 JENKS_MAX_SAMPLES），把复杂度压到可接受范围；
   * 断点再按原始 min/max 做端点修正，保证首尾严格包住全部数据。
   */
  const JENKS_MAX_SAMPLES = 1200;

  function jenksBreaks(sorted, k) {
    const n = sorted.length;
    if (!n) return [];
    const lo = sorted[0];
    const hi = sorted[n - 1];
    if (k <= 1 || hi <= lo) return [lo, hi];

    // 唯一值
    const uniq = [];
    for (let i = 0; i < n; i++) {
      if (!uniq.length || sorted[i] > uniq[uniq.length - 1]) uniq.push(sorted[i]);
    }
    let data = uniq;
    if (uniq.length > JENKS_MAX_SAMPLES) {
      const step = uniq.length / JENKS_MAX_SAMPLES;
      data = [];
      for (let i = 0; i < JENKS_MAX_SAMPLES; i++) {
        data.push(uniq[Math.floor(i * step)]);
      }
    }
    const m = data.length;
    if (m <= k) {
      const out = [];
      for (let i = 0; i <= k; i++) {
        out.push(data[Math.min(m - 1, Math.round((i / k) * (m - 1)))]);
      }
      out[0] = lo;
      out[k] = hi;
      return out;
    }

    // mats1[l][j] = 用 l 类划分 data[0..j] 的最小方差和
    // mats2[l][j] = 达到该值时，前 l-1 类覆盖 data[0..i] 的切分点 i
    const K = k;
    const width = m + 1;
    const mats1 = [];
    const mats2 = [];
    for (let l = 0; l <= K; l++) {
      mats1.push(new Float64Array(width).fill(Infinity));
      mats2.push(new Int32Array(width).fill(-1));
    }
    // 第 1 类覆盖 data[0..j]，没有前驱类
    for (let j = 0; j < m; j++) {
      const d = data[j] - data[0];
      mats1[1][j] = (d * d) / 4;
      mats2[1][j] = -1;
    }
    for (let l = 2; l <= K; l++) {
      for (let j = l; j < m; j++) {
        let best = Infinity;
        let besti = -1;
        for (let i = l - 1; i < j; i++) {
          const base = mats1[l - 1][i];
          if (base === Infinity) continue;
          const d = data[j] - data[i + 1];
          const cost = base + (d * d) / 4;
          if (cost < best) { best = cost; besti = i; }
        }
        mats1[l][j] = best;
        mats2[l][j] = besti;
      }
    }
    // 回溯出各级上界
    const bounds = [];
    let j = m - 1;
    for (let l = K; l >= 2; l--) {
      const i = mats2[l][j];
      if (i < 0) return equalIntervalBreaks(lo, hi, K);
      bounds.unshift(data[j]);
      j = i;
    }
    // 第 1 类：覆盖 data[0..j]
    bounds.unshift(data[j]);
    bounds.unshift(lo);
    if (bounds.length !== K + 1) {
      return equalIntervalBreaks(lo, hi, K);
    }
    bounds[0] = lo;
    bounds[K] = hi;
    // 保证严格递增（重复值合并到下一个）
    for (let i = 1; i <= K; i++) {
      if (bounds[i] < bounds[i - 1]) bounds[i] = bounds[i - 1];
    }
    return bounds;
  }

  /**
   * 计算分级断点。
   * @param {Float32Array|number[]} values
   * @param {string} method 自然断点 / 等距 / 分位数 / 几何级数
   * @param {number} k 级数
   * @returns {number[]} 长度 k+1
   */
  function breaks(values, method, k) {
    const kk = Math.max(1, Math.min(50, k | 0 || 5));
    const sorted = sortedFinite(values);
    if (!sorted.length) return [0, 1];
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    if (hi <= lo) return [lo, hi];
    let out;
    switch (method) {
      case '等距':
        out = equalIntervalBreaks(lo, hi, kk);
        break;
      case '分位数':
        out = quantileBreaks(sorted, kk);
        break;
      case '几何级数':
        out = geometricBreaks(lo, hi, kk);
        break;
      case '自然断点':
      default:
        out = jenksBreaks(sorted, kk);
        break;
    }
    out[0] = lo;
    out[kk] = hi;
    return out;
  }

  /**
   * 按断点把每个像元归类。
   * @returns { classes: Int32Array, table: [{index,min,max,label,count}] }
   */
  function classify(values, brks) {
    const n = values ? values.length : 0;
    const k = Math.max(1, (brks.length || 1) - 1);
    const classes = new Int32Array(n);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      let c = 0;
      if (!isFinite(v)) {
        c = -1;
      } else {
        // 找到 v 落在哪个区间 (brks[c], brks[c+1]]，端点归入上一类
        let lo = 0;
        let hi = k - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (v > brks[mid]) lo = mid; else hi = mid - 1;
        }
        c = lo;
      }
      classes[i] = c;
      if (c >= 0) counts[c]++;
    }
    const table = [];
    for (let c = 0; c < k; c++) {
      table.push({
        index: c,
        min: brks[c],
        max: brks[c + 1],
        label: formatRange(brks[c], brks[c + 1]),
        count: counts[c],
      });
    }
    return { classes: classes, table: table };
  }

  function formatRange(a, b) {
    const r = function (x) {
      const v = Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100;
      return String(v);
    };
    return r(a) + ' ~ ' + r(b);
  }

  /* ============================================================== 对外 API */

  const api = {
    parse: parse,
    evaluate: evaluate,
    stats: stats,
    histogram: histogram,
    breaks: breaks,
    classify: classify,
    formatRange: formatRange,
    BREAK_METHODS: BREAK_METHODS,
    FUNCS: Object.keys(FUNCS),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LERasterOps = api;
})(typeof window !== 'undefined' ? window : globalThis);

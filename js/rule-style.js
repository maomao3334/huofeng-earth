/*
 * 矢量规则样式内核（纯计算，不依赖 Cesium，可直接在 Node 里单测）
 * ---------------------------------------------------------------------------
 * P1-4.7「矢量规则样式」的内核部分，对标 QGIS 的**规则渲染器**与
 * **分级渲染器**：
 *
 *   1) **要素属性表达式**：QGIS 的表达式语法子集，可以对单个要素的属性求值。
 *      支持数字、字符串（'...' / "..."）、字段名（可用中文）、比较、逻辑、
 *      三元、函数（upper/lower/trim/concat/abs/round/floor/ceil/min/max/
 *      coalesce/substr/length/str/num/ifelse/like/matches）。
 *
 *   2) **分级（graduated / categorized）**：按字段把要素分档，
 *      分档方式支持 自然断点 / 等距 / 分位数 / 几何级数，
 *      并可让**点大小、线宽**随级别递增（QGIS 的 graduated renderer 行为）。
 *
 *   3) **规则渲染器**：一组有序规则，每条规则 = 条件表达式 + 符号（颜色/大小/线宽），
 *      **第一条命中的规则生效**（与 QGIS 一致）；未命中任何规则的要素可选择隐藏。
 *
 * 所有函数都是纯函数：不读 DOM、不读 window、不碰 Cesium，
 * 可以直接 `require('../js/rule-style.js')` 做单元测试。
 *
 * 对外 API（window.LERuleStyle）：
 *   parseExpr(src)                → AST
 *   evalExpr(src, props)           → number | string | boolean
 *   condition(src, props)          → boolean
 *   classes(values, method, k)     → [{min,max,label,count,color}]
 *   categorical(values)            → [{key,label,count,color}]
 *   matchRules(rules, props)       → {symbol, rule} | null
 *   evaluateRuleSet(rules, props)  → symbol
 */
(function (root) {
  'use strict';

  /* 复用栅格内核的断点算法（浏览器用 window.LERasterOps，Node 用 require）。 */
  const Ops = (function () {
    if (typeof window !== 'undefined' && window.LERasterOps) return window.LERasterOps;
    if (typeof require === 'function') {
      try { return require('./raster-ops.js'); } catch (err) { return null; }
    }
    return null;
  })();

  /* ============================================================ 表达式解析 */

  const PREC = {
    '||': 1,
    '&&': 2,
    '==': 3, '!=': 3,
    '<': 4, '<=': 4, '>': 4, '>=': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, '%': 6,
  };

  function tokenize(src) {
    const s = String(src == null ? '' : src);
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      // 字符串 / 字段名
      //   双引号 "人口"  → 字段名（与 QGIS 一致）
      //   单引号 '北京'  → 字符串字面量
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        let buf = '';
        while (j < s.length && s[j] !== quote) {
          if (s[j] === '\\' && j + 1 < s.length) {
            const nxt = s[j + 1];
            buf += nxt === 'n' ? '\n' : nxt === 't' ? '\t' : nxt;
            j += 2;
            continue;
          }
          buf += s[j];
          j++;
        }
        if (j >= s.length) throw new Error('字符串没有闭合引号');
        toks.push({ t: quote === '"' ? 'field' : 'str', v: buf });
        i = j + 1;
        continue;
      }
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
      // 标识符（允许中文）
      if (/[A-Za-z_一-龥]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_一-龥]/.test(s[j])) j++;
        const word = s.slice(i, j);
        const low = word.toLowerCase();
        // 布尔字面量
        if (low === 'true' || low === 'false') {
          toks.push({ t: 'bool', v: low === 'true' });
          i = j;
          continue;
        }
        // null
        if (low === 'null') {
          toks.push({ t: 'null' });
          i = j;
          continue;
        }
        toks.push({ t: 'id', v: word });
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
      // 单个 '=' 表示相等（QGIS 表达式写法），'==' 也支持
      if (ch === '=') {
        toks.push({ t: 'op', v: '==' });
        i++;
        continue;
      }
      if ('+-*/%<>=^!(),?:'.indexOf(ch) >= 0) {
        toks.push({ t: (ch === '(' || ch === ')' || ch === ',' || ch === '?' || ch === ':') ? ch : 'op', v: ch });
        i++;
        continue;
      }      throw new Error('表达式里出现无法识别的字符：' + ch);
    }
    toks.push({ t: 'end' });
    return toks;
  }

  function parseExpr(src) {
    const toks = tokenize(src);
    let p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expect(t) {
      const tk = next();
      if (tk.t !== t) throw new Error('表达式语法错误：期望 ' + t + '，实际 ' + (tk.v || tk.t));
      return tk;
    }

    function parseTernary() {
      const cond = parseBinary(1);
      if (peek().t === '?') {
        next();
        const a = parseTernary();
        expect(':');
        const b = parseTernary();
        return { k: 'ternary', cond: cond, a: a, b: b };
      }
      return cond;
    }

    function parseBinary(minPrec) {
      let left = parseUnary();
      // QGIS 风格的 IS NULL / IS NOT NULL
      const isTk = peek();
      if (isTk.t === 'id' && String(isTk.v).toUpperCase() === 'IS') {
        next();
        let neg = false;
        const nTk = peek();
        if (nTk.t === 'id' && String(nTk.v).toUpperCase() === 'NOT') {
          next();
          neg = true;
        }
        const nullTk = peek();
        if ((nullTk.t === 'id' && String(nullTk.v).toUpperCase() === 'NULL') || nullTk.t === 'null') {
          next();
          left = { k: 'isnull', a: left, neg: neg };
        } else {
          throw new Error('表达式语法错误：IS 后面必须是 NULL');
        }
      }
      for (;;) {
        const tk = peek();
        if (tk.t !== 'op') break;
        const prec = PREC[tk.v];
        if (prec == null || prec < minPrec) break;
        next();
        const right = parseBinary(prec + 1);
        left = { k: 'bin', op: tk.v, a: left, b: right };
      }
      return left;
    }

    function parseUnary() {
      const tk = peek();
      if (tk.t === 'op' && (tk.v === '-' || tk.v === '+' || tk.v === '!')) {
        next();
        return { k: 'un', op: tk.v, a: parseUnary() };
      }
      return parsePower();
    }

    function parsePower() {
      const base = parsePrimary();
      if (peek().t === 'op' && peek().v === '^') {
        next();
        return { k: 'bin', op: '^', a: base, b: parseUnary() };
      }
      return base;
    }

    function parsePrimary() {
      const tk = next();
      if (tk.t === 'num') return { k: 'num', v: tk.v };
      if (tk.t === 'str') return { k: 'str', v: tk.v };
      if (tk.t === 'bool') return { k: 'bool', v: tk.v };
      if (tk.t === 'null') return { k: 'null' };
      if (tk.t === 'field') return { k: 'var', name: tk.v };
      if (tk.t === 'id') {
        if (peek().t === '(') {
          next();
          const args = [];
          if (peek().t !== ')') {
            for (;;) {
              args.push(parseTernary());
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
        const e = parseTernary();
        expect(')');
        return e;
      }
      throw new Error('表达式语法错误：无法解析 "' + (tk.v || tk.t) + '"');
    }

    const ast = parseTernary();
    if (peek().t !== 'end') throw new Error('表达式语法错误：多余的内容');
    return ast;
  }

  /* ============================================================ 表达式求值 */

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v == null || v === '') return 0;
    const n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  function toStr(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v == null) return false;
    const s = toStr(v).trim().toLowerCase();
    if (s === '' || s === 'false' || s === '0') return false;
    return true;
  }

  /** SQL LIKE 的 % / _ 翻译成正则。 */
  function likeToRegExp(pattern) {
    let out = '^';
    const p = String(pattern);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '%') out += '.*';
      else if (c === '_') out += '.';
      else if ('\\^$.|?*+()[]{}'.indexOf(c) >= 0) out += '\\' + c;
      else out += c;
    }
    return new RegExp(out + '$', 'i');
  }

  const FUNCS = {
    upper: (a) => toStr(a).toUpperCase(),
    lower: (a) => toStr(a).toLowerCase(),
    trim: (a) => toStr(a).trim(),
    concat: function () {
      const args = Array.prototype.slice.call(arguments);
      return args.map(toStr).join('');
    },
    abs: (a) => Math.abs(toNum(a)),
    round: (a) => Math.round(toNum(a)),
    floor: (a) => Math.floor(toNum(a)),
    ceil: (a) => Math.ceil(toNum(a)),
    sqrt: (a) => Math.sqrt(toNum(a)),
    min: function () {
      const args = Array.prototype.slice.call(arguments);
      let best = Infinity;
      for (const a of args) { const n = toNum(a); if (isFinite(n) && n < best) best = n; }
      return best === Infinity ? 0 : best;
    },
    max: function () {
      const args = Array.prototype.slice.call(arguments);
      let best = -Infinity;
      for (const a of args) { const n = toNum(a); if (isFinite(n) && n > best) best = n; }
      return best === -Infinity ? 0 : best;
    },
    coalesce: function () {
      const args = Array.prototype.slice.call(arguments);
      for (const a of args) {
        if (a != null && a !== '') return a;
      }
      return args.length ? args[args.length - 1] : null;
    },
    substr: function (a, start, len) {
      const s = toStr(a);
      const st = Math.max(0, (toNum(start) | 0) - 1);
      if (len == null) return s.slice(st);
      return s.slice(st, st + (toNum(len) | 0));
    },
    length: (a) => toStr(a).length,
    str: (a) => toStr(a),
    num: (a) => { const n = toNum(a); return isFinite(n) ? n : 0; },
    ifelse: (c, a, b) => (truthy(c) ? a : b),
    like: (a, p) => likeToRegExp(p).test(toStr(a)),
    matches: function (a, p) {
      try { return new RegExp(String(p), 'i').test(toStr(a)); } catch (err) { return false; }
    },
    // QGIS 同名函数，方便从 QGIS 表达式直接迁移
    to_int: (a) => Math.trunc(toNum(a)),
    to_real: (a) => toNum(a),
    to_string: (a) => toStr(a),
    empty: (a) => a == null || a === '',
    'if': (c, a, b) => (truthy(c) ? a : b),
  };

  function evalNode(node, props) {
    switch (node.k) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'bool': return node.v;
      case 'null': return null;
      case 'isnull': {
        const v = evalNode(node.a, props);
        const isNull = v == null || v === '';
        return node.neg ? !isNull : isNull;
      }
      case 'var': {
        const v = props ? props[node.name] : undefined;
        return v === undefined ? null : v;
      }
      case 'un': {
        const a = evalNode(node.a, props);
        if (node.op === '-') return -toNum(a);
        if (node.op === '+') return toNum(a);
        return !truthy(a);
      }
      case 'bin': {
        const a = evalNode(node.a, props);
        const b = evalNode(node.b, props);
        switch (node.op) {
          case '+': {
            // 任一侧是字符串就做字符串拼接（QGIS 行为更接近显式 concat，
            // 但数字 + 字符串在 QGIS 里会报错，这里给出更宽容的字符串语义）
            if (typeof a === 'string' || typeof b === 'string') {
              const an = toNum(a), bn = toNum(b);
              if (isFinite(an) && isFinite(bn)) return an + bn;
              return toStr(a) + toStr(b);
            }
            return toNum(a) + toNum(b);
          }
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': { const d = toNum(b); return d === 0 ? 0 : toNum(a) / d; }
          case '%': { const d = toNum(b); return d === 0 ? 0 : toNum(a) % d; }
          case '^': return Math.pow(toNum(a), toNum(b));
          case '<': return compare(a, b) < 0;
          case '<=': return compare(a, b) <= 0;
          case '>': return compare(a, b) > 0;
          case '>=': return compare(a, b) >= 0;
          case '==': return looseEq(a, b);
          case '!=': return !looseEq(a, b);
          case '&&': return truthy(a) && truthy(b);
          case '||': return truthy(a) || truthy(b);
          default: throw new Error('未知运算符：' + node.op);
        }
      }
      case 'ternary':
        return truthy(evalNode(node.cond, props))
          ? evalNode(node.a, props)
          : evalNode(node.b, props);
      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) throw new Error('未知函数：' + node.name);
        const args = node.args.map((a) => evalNode(a, props));
        return fn.apply(null, args);
      }
      default:
        throw new Error('无法求值的节点');
    }
  }

  /** 比较：两边都是数字就按数值比，否则按字符串比。 */
  function compare(a, b) {
    const an = toNum(a);
    const bn = toNum(b);
    if (isFinite(an) && isFinite(bn)) return an < bn ? -1 : (an > bn ? 1 : 0);
    const as = toStr(a);
    const bs = toStr(b);
    return as < bs ? -1 : (as > bs ? 1 : 0);
  }

  function looseEq(a, b) {
    if (a == null || b == null) return a == null && b == null;
    if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
    const an = toNum(a);
    const bn = toNum(b);
    if (isFinite(an) && isFinite(bn)) return an === bn;
    return toStr(a) === toStr(b);
  }

  /**
   * 对一组要素属性求值表达式。
   * @param {string|object} src 表达式字符串或已解析的 AST
   * @param {object} props 要素属性
   * @returns {*} number | string | boolean
   */
  function evalExpr(src, props) {
    const ast = typeof src === 'string' ? parseExpr(src) : src;
    if (!ast) return null;
    const v = evalNode(ast, props || {});
    return v === undefined ? null : v;
  }

  /** 求值成布尔（规则条件）。 */
  function condition(src, props) {
    if (src == null || String(src).trim() === '') return true;
    return truthy(evalExpr(src, props));
  }

  /* ============================================================ 分级 */

  const BREAK_METHODS = ['自然断点', '等距', '分位数', '几何级数'];

  /** 分类色板（与 js/layer-style.js 保持一致）。 */
  const PALETTE = ['#4c9be8', '#57c2a8', '#9ed14f', '#ffd166', '#f0955c', '#e5645c', '#c05fb0', '#8a7ae0'];

  function paletteAt(i, n) {
    if (n <= 1) return PALETTE[0];
    const t = Math.max(0, Math.min(1, i / (n - 1)));
    const idx = Math.max(0, Math.min(PALETTE.length - 1, Math.round(t * (PALETTE.length - 1))));
    return PALETTE[idx];
  }

  function numericValues(values) {
    const out = [];
    for (let i = 0; i < (values ? values.length : 0); i++) {
      const n = toNum(values[i]);
      if (isFinite(n)) out.push(n);
    }
    return out;
  }

  /**
   * 按数值分档。
   *
   * 断点与分档**完全复用栅格内核**（js/raster-ops.js），保证
   * 「矢量分级」和「栅格分级」用同一套算法与同一条边界约定：
   *   第 0 档覆盖 [brks[0], brks[1]]，第 c 档（c>0）覆盖 (brks[c], brks[c+1]]，
   *   端点值归入**较低**的一档，最小值本身落在第 0 档。
   *
   * @param {number[]} values 每个要素的字段值
   * @param {string} method 自然断点 / 等距 / 分位数 / 几何级数
   * @param {number} k 级数
   * @returns {Array<{min,max,label,count,color}>}
   */
  function classes(values, method, k) {
    const kk = Math.max(2, Math.min(20, k | 0 || 5));
    const nums = numericValues(values);
    if (!nums.length) return [];
    let brks;
    let counts;
    if (Ops && typeof Ops.breaks === 'function' && typeof Ops.classify === 'function') {
      brks = Ops.breaks(nums, method, kk);
      const cls = Ops.classify(nums, brks);
      counts = cls.table.map((t) => t.count);
    } else {
      const lo = Math.min.apply(null, nums);
      const hi = Math.max.apply(null, nums);
      brks = [];
      for (let i = 0; i <= kk; i++) brks.push(lo + ((hi - lo) * i) / kk);
      counts = new Array(kk).fill(0);
      for (let i = 0; i < nums.length; i++) {
        let c = 0;
        while (c < kk - 1 && nums[i] > brks[c + 1]) c++;
        counts[c]++;
      }
    }
    const out = [];
    for (let c = 0; c < kk; c++) {
      const lo = brks[c];
      const hi = brks[c + 1];
      out.push({
        min: lo,
        max: hi,
        label: fmtRange(lo, hi),
        count: counts[c] || 0,
        color: paletteAt(c, kk),
      });
    }
    return out;
  }

  /**
   * 按取值分档（枚举字段）。
   * @returns {Array<{key,label,count,color}>}
   */
  function categorical(values, maxClasses) {
    const seen = new Map();
    const order = [];
    for (let i = 0; i < (values ? values.length : 0); i++) {
      const v = values[i];
      const key = v == null ? '' : String(v);
      if (!seen.has(key)) {
        seen.set(key, 0);
        order.push(key);
      }
      seen.set(key, seen.get(key) + 1);
    }
    // 按出现次数降序，取前 maxClasses 个，其余归入「其它」
    order.sort((a, b) => seen.get(b) - seen.get(a));
    const cap = Math.max(2, Math.min(30, maxClasses | 0 || 20));
    const out = [];
    const n = Math.min(order.length, cap);
    for (let i = 0; i < n; i++) {
      const key = order[i];
      out.push({
        key: key,
        label: key === '' ? '（空）' : key,
        count: seen.get(key),
        color: paletteAt(i, n),
      });
    }
    if (order.length > n) {
      let other = 0;
      for (let i = n; i < order.length; i++) other += seen.get(order[i]);
      out.push({ key: '__OTHER__', label: '其它（' + (order.length - n) + ' 项）', count: other, color: '#5b6b78' });
    }
    return out;
  }

  function fmtRange(a, b) {
    const r = function (x) {
      const v = Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100;
      return String(v);
    };
    return r(a) + ' ~ ' + b;
  }

  /* ============================================================ 规则渲染器 */

  const DEFAULT_SYMBOL = {
    color: null,
    pointSize: null,
    lineWidth: null,
    fillAlpha: null,
  };

  /**
   * 一条规则：{ id, label, enabled, condition, symbol }
   * 规则按顺序求值，**第一条命中的生效**（QGIS 行为）。
   */
  function matchRules(rules, props) {
    if (!rules || !rules.length) return null;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r || r.enabled === false) continue;
      let hit = false;
      try {
        hit = condition(r.condition, props);
      } catch (err) {
        hit = false;
      }
      if (hit) {
        return { rule: r, symbol: Object.assign({}, DEFAULT_SYMBOL, r.symbol || {}) };
      }
    }
    return null;
  }

  /** 求出该要素应使用的符号（没命中规则时返回 null）。 */
  function evaluateRuleSet(rules, props) {
    const m = matchRules(rules, props);
    return m ? m.symbol : null;
  }

  /** 规则的合法性检查：返回错误信息数组（空 = 全对）。 */
  function validateRules(rules) {
    const errs = [];
    for (let i = 0; i < (rules ? rules.length : 0); i++) {
      const r = rules[i];
      const where = '第 ' + (i + 1) + ' 条规则';
      if (!r) { errs.push(where + '为空'); continue; }
      if (!r.condition || !String(r.condition).trim()) {
        errs.push(where + '缺少条件表达式');
        continue;
      }
      try {
        parseExpr(r.condition);
      } catch (err) {
        errs.push(where + '表达式错误：' + err.message);
      }
    }
    return errs;
  }

  /* ============================================================== 对外 API */

  const api = {
    parseExpr: parseExpr,
    evalExpr: evalExpr,
    condition: condition,
    classes: classes,
    categorical: categorical,
    matchRules: matchRules,
    evaluateRuleSet: evaluateRuleSet,
    validateRules: validateRules,
    paletteAt: paletteAt,
    likeToRegExp: likeToRegExp,
    BREAK_METHODS: BREAK_METHODS,
    PALETTE: PALETTE,
    FUNCS: Object.keys(FUNCS),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LERuleStyle = api;
})(typeof window !== 'undefined' ? window : globalThis);

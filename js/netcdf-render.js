/*
 * 气象栅格渲染内核（纯计算，不依赖 DOM / Cesium）
 * ---------------------------------------------------------------------------
 * P2-4.11「NetCDF / 气象栅格叠加」的渲染部分。
 *
 * 与 js/netcdf.js 分开：
 *   · netcdf.js 负责「读懂文件」
 *   · netcdf-render.js 负责「把场画成颜色」
 *
 * 之所以拆开：色带、分级、拉伸这些逻辑是**纯数值**的，
 * 放到 Node 里可以毫秒级做回归测试（tools/test-nc.js），
 * 不用起浏览器、不用加载 10 MB 的 Cesium。
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LENetCDFRender = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 色带
   * ================================================================ */

  /**
   * 气象色带。控制点写成 [t, r, g, b]，t ∈ [0,1]。
   * 温度用「蓝→红」是气象业务惯例（冷→热）；风速用青→紫。
   */
  const RAMPS = {
    temperature: {
      label: '气温（冷蓝→暖红）',
      points: [
        [0.00, 40, 60, 160], [0.20, 60, 140, 210], [0.40, 110, 200, 230],
        [0.55, 190, 225, 210], [0.70, 245, 235, 190], [0.85, 245, 170, 110],
        [1.00, 200, 70, 60],
      ],
    },
    windspeed: {
      label: '风速（青→紫）',
      points: [
        [0.00, 20, 60, 120], [0.25, 30, 140, 180], [0.50, 60, 190, 175],
        [0.70, 170, 150, 200], [0.85, 215, 110, 180], [1.00, 140, 40, 130],
      ],
    },
    winddir: {
      label: '风向（色环）',
      points: [
        [0.00, 220, 60, 60], [0.16, 240, 150, 60], [0.33, 230, 220, 80],
        [0.50, 110, 210, 110], [0.66, 90, 190, 220], [0.83, 150, 120, 220],
        [1.00, 220, 60, 60],
      ],
    },
    pressure: {
      label: '气压（紫→黄）',
      points: [
        [0.00, 70, 40, 130], [0.30, 90, 120, 190], [0.55, 140, 200, 210],
        [0.78, 240, 225, 140], [1.00, 235, 140, 60],
      ],
    },
    humidity: {
      label: '湿度（黄→蓝）',
      points: [
        [0.00, 245, 240, 210], [0.30, 230, 220, 150], [0.55, 190, 205, 180],
        [0.78, 120, 180, 210], [1.00, 60, 120, 190],
      ],
    },
    precip: {
      label: '降水（浅→深）',
      points: [
        [0.00, 235, 240, 245], [0.30, 160, 210, 235], [0.55, 90, 165, 225],
        [0.78, 40, 105, 200], [1.00, 20, 60, 160],
      ],
    },
    diverging: {
      label: '发散（负→正，蓝白红）',
      points: [
        [0.00, 33, 102, 172], [0.25, 90, 160, 210], [0.50, 245, 245, 240],
        [0.75, 230, 140, 100], [1.00, 165, 20, 30],
      ],
    },
    gray: {
      label: '灰度',
      points: [[0, 20, 24, 28], [1, 235, 238, 240]],
    },
    viridis: {
      label: 'Viridis',
      points: [
        [0.00, 68, 1, 84], [0.25, 59, 82, 139], [0.50, 33, 145, 140],
        [0.75, 94, 201, 98], [1.00, 253, 231, 37],
      ],
    },
    terrain: {
      label: '地形',
      points: [
        [0.00, 0, 160, 200], [0.15, 40, 190, 160], [0.30, 80, 210, 130],
        [0.45, 130, 225, 175], [0.60, 180, 235, 195], [0.72, 215, 225, 140],
        [0.85, 245, 200, 110], [1.00, 175, 135, 155],
      ],
    },
  };

  /** 按「要素类型」挑一个默认色带。 */
  function defaultRamp(kind) {
    switch (kind) {
      case 'temperature': return 'temperature';
      case 'wind-speed': return 'windspeed';
      case 'wind-dir': return 'winddir';
      case 'pressure': return 'pressure';
      case 'humidity': return 'humidity';
      case 'precipitation': return 'precip';
      // 【U/V 分量是有符号的】
      //   东向为正、西向为负 —— 用 viridis 这种顺序色带会把 +10 和 -10
      //   都画成「低值」，正负完全分不出来。必须用发散色带 + 关于 0 对称的拉伸。
      case 'wind-u':
      case 'wind-v': return 'diverging';
      default: return 'viridis';
    }
  }

  /** 这个要素是不是「有符号」（需要关于 0 对称的拉伸）。 */
  function isSigned(kind) {
    return kind === 'wind-u' || kind === 'wind-v';
  }

  function rampPoints(name) {
    const r = RAMPS[name] || RAMPS.viridis;
    return r.points;
  }

  function rampLabel(name) {
    return (RAMPS[name] || RAMPS.viridis).label;
  }

  /**
   * 取 t∈[0,1] 处的 RGB。
   * @returns {[number,number,number]}
   */
  function sampleRamp(name, t) {
    const pts = rampPoints(name);
    if (!isFinite(t)) return [0, 0, 0];
    t = Math.max(0, Math.min(1, t));
    if (pts.length === 1) return [pts[0][1], pts[0][2], pts[0][3]];
    let i = 0;
    while (i < pts.length - 2 && t > pts[i + 1][0]) i++;
    const a = pts[i], b = pts[i + 1];
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    return [
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
      Math.round(a[3] + (b[3] - a[3]) * f),
    ];
  }

  /* ================================================================
   * 场统计与拉伸
   * ================================================================ */

  /** 忽略 NaN 的统计。 */
  function stats(values) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0, nan = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isFinite(v)) { nan++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n++;
    }
    if (!n) return { min: null, max: null, mean: null, count: 0, nan: nan };
    return { min: min, max: max, mean: sum / n, count: n, nan: nan };
  }

  /** 按分位数取拉伸区间（抗离群点）。 */
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.max(0, Math.min(sorted.length - 1,
      Math.round((sorted.length - 1) * p)));
    return sorted[i];
  }

  function sortedFinite(values) {
    const out = [];
    for (let i = 0; i < values.length; i++) if (isFinite(values[i])) out.push(values[i]);
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /**
   * 计算拉伸区间。
   * @param {Float64Array|number[]} values
   * @param {string} mode 'minmax' | 'percentile' | 'stddev'
   * @param {number} p 分位数参数（percentile 模式用，默认 0.02/0.98）
   */
  function stretchRange(values, mode, p) {
    const st = stats(values);
    if (st.count === 0) return { min: 0, max: 1, mode: mode, stats: st };
    let lo, hi;
    if (mode === 'percentile') {
      const sorted = sortedFinite(values);
      lo = percentile(sorted, p != null ? p : 0.02);
      hi = percentile(sorted, p != null ? 1 - (p != null ? p : 0.02) : 0.98);
    } else if (mode === 'symmetric') {
      // 关于 0 对称：[-m, +m]，正负分量才能一眼看出方向
      const m = Math.max(Math.abs(st.min || 0), Math.abs(st.max || 0));
      lo = -m; hi = m;
    } else if (mode === 'stddev') {
      const m = st.mean;
      let varSum = 0;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!isFinite(v)) continue;
        varSum += (v - m) * (v - m);
      }
      const sd = Math.sqrt(varSum / st.count);
      lo = m - 2 * sd;
      hi = m + 2 * sd;
    } else {
      lo = st.min;
      hi = st.max;
    }
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi <= lo) hi = lo + 1;
    return { min: lo, max: hi, mode: mode || 'minmax', stats: st };
  }

  /* ================================================================
   * 场 → RGBA
   * ================================================================ */

  /**
   * 把一个二维场渲染成 RGBA 缓冲。
   *
   * 【关键设计：垂直方向要翻转】
   *   NetCDF 栅格第 0 行通常是**北**（纬度最大），
   *   而 canvas 的第 0 行是**上**（对应纬度最小）。
   *   不翻转的话整张图就是上下颠倒的 —— 北方的数据画到了南边。
   *
   * @param {object} slice  {data, width, height, lons, lats}
   * @param {object} opts   {min, max, ramp, transparentBelow}
   * @returns {{rgba:Uint8ClampedArray, width, height, min, max}}
   */
  function fieldToRGBA(slice, opts) {
    opts = opts || {};
    const w = slice.width, h = slice.height;
    const n = w * h;
    const rgba = new Uint8ClampedArray(n * 4);
    const lo = opts.min != null ? opts.min : 0;
    const hi = opts.max != null ? opts.max : 1;
    const span = hi - lo || 1;
    const ramp = opts.ramp || 'viridis';
    // 低于这个值视为 NoData，透明（避免 -9999 把整幅图染成一片）
    const noDataCut = opts.transparentBelow != null ? opts.transparentBelow : null;
    const lats = slice.lats;
    // 【上下翻转的方向不能想当然】
    //   canvas 第 0 行 = 顶部 = **北**（经度轴同理，右边是东）。
    //   NetCDF 场的第 0 行是**北**还是**南**取决于文件：
    //     · lats 降序（[54,53,…]，第 0 行是北）→ 直接照抄，不用翻；
    //     · lats 升序（[37,…,54]，第 0 行是南）→ 要翻。
    //   早先写成「lats 降序就翻」，正好反了，整张图上下颠倒。
    let flip = false;
    if (lats && lats.length >= 2) {
      flip = lats[0] < lats[lats.length - 1];   // 升序才需要翻
    }

    for (let y = 0; y < h; y++) {
      const srcY = flip ? (h - 1 - y) : y;
      for (let x = 0; x < w; x++) {
        const v = slice.data[srcY * w + x];
        const o = (y * w + x) * 4;
        if (!isFinite(v) || (noDataCut != null && v <= noDataCut)) {
          rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 0;
          continue;
        }
        let t = (v - lo) / span;
        t = Math.max(0, Math.min(1, t));
        const c = sampleRamp(ramp, t);
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
      }
    }
    return { rgba: rgba, width: w, height: h, min: lo, max: hi };
  }

  /**
   * 按经纬度边界把场重采样成目标尺寸（最近邻）。
   *
   * 为什么要重采样：NetCDF 网格常常是 0.25° 之类，
   * 直接贴到地球上会被拉伸变形；重采样到贴合屏幕的分辨率既快又好看。
   *
   * @param {object} slice  {data,width,height,lons,lats}
   * @param {number} outW
   * @param {number} outH
   * @returns {{data:Float64Array,width,height}}
   */
  function resample(slice, outW, outH) {
    const w = slice.width, h = slice.height;
    const out = new Float64Array(outW * outH);
    const lons = slice.lons, lats = slice.lats;
    if (!lons || !lats || lons.length < 2 || lats.length < 2) {
      // 没有坐标轴 → 直接按比例缩放（最近邻）
      for (let y = 0; y < outH; y++) {
        const sy = Math.min(h - 1, Math.floor(y * h / outH));
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(w - 1, Math.floor(x * w / outW));
          out[y * outW + x] = slice.data[sy * w + sx];
        }
      }
      return { data: out, width: outW, height: outH };
    }

    const lonMin = Math.min(lons[0], lons[lons.length - 1]);
    const lonMax = Math.max(lons[0], lons[lons.length - 1]);
    const latMin = Math.min(lats[0], lats[lats.length - 1]);
    const latMax = Math.max(lats[0], lats[lats.length - 1]);
    const lonStep = (lonMax - lonMin) / (w - 1);
    const latStep = (latMax - latMin) / (h - 1);
    const lonAsc = lons[lons.length - 1] > lons[0];
    const latAsc = lats[lats.length - 1] > lats[0];

    for (let y = 0; y < outH; y++) {
      // 目标图第 0 行 = 南（canvas 顶 = 北）
      const lat = latMax - (latMax - latMin) * (y / Math.max(1, outH - 1));
      let sy = latAsc ? (lat - latMin) / latStep : (latMax - lat) / latStep;
      sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
      for (let x = 0; x < outW; x++) {
        const lon = lonMin + (lonMax - lonMin) * (x / Math.max(1, outW - 1));
        let sx = lonAsc ? (lon - lonMin) / lonStep : (lonMax - lon) / lonStep;
        sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
        out[y * outW + x] = slice.data[sy * w + sx];
      }
    }
    return { data: out, width: outW, height: outH };
  }

  /**
   * 计算场覆盖的经纬度矩形。
   * @returns {null|{west,south,east,north}}
   */
  function boundsOf(slice) {
    if (!slice || !slice.lons || !slice.lats) return null;
    const lons = slice.lons, lats = slice.lats;
    if (!lons.length || !lats.length) return null;
    return {
      west: Math.min(lons[0], lons[lons.length - 1]),
      east: Math.max(lons[0], lons[lons.length - 1]),
      south: Math.min(lats[0], lats[lats.length - 1]),
      north: Math.max(lats[0], lats[lats.length - 1]),
    };
  }

  /* ================================================================
   * 风场符号（箭头）
   * ================================================================ */

  /**
   * 在场上抽样生成箭头（用于矢量场显示）。
   *
   * @param {object} u  {data,width,height}
   * @param {object} v  {data,width,height}
   * @param {object} opts {step, minSpeed, maxSpeed, lengthDeg}
   * @returns {Array<{lon,lat,dir,speed}>}
   */
  function sampleArrows(u, v, opts) {
    opts = opts || {};
    const step = Math.max(1, opts.step || 6);
    const out = [];
    const st = stats(u.data);
    const stv = stats(v.data);
    const maxSpeed = opts.maxSpeed != null ? opts.maxSpeed
      : Math.max(1e-6, Math.sqrt(
        Math.max(Math.abs(st.min || 0), Math.abs(st.max || 0)) ** 2 +
        Math.max(Math.abs(stv.min || 0), Math.abs(stv.max || 0)) ** 2));
    const w = u.width, h = u.height;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        const a = u.data[i], b = v.data[i];
        if (!isFinite(a) || !isFinite(b)) continue;
        const speed = Math.sqrt(a * a + b * b);
        if (opts.minSpeed != null && speed < opts.minSpeed) continue;
        // 【统一用气象学的「来向」约定，与 windFromUV 一致】
        //   向东吹（u>0）来自西方 → 270°。
        let dir = (270 - Math.atan2(b, a) * 180 / Math.PI) % 360;
        if (dir < 0) dir += 360;
        // toDir：箭头真正指向的方向（数学角）
        const toDir = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
        out.push({
          x: x, y: y,
          u: a, v: b,
          speed: speed,
          dir: dir,        // 气象来向（北=0）
          toDir: toDir,    // 数学去向（东=0）
          norm: Math.min(1, speed / maxSpeed),
        });
      }
    }
    return out;
  }

  return {
    RAMPS: RAMPS,
    rampPoints: rampPoints,
    rampLabel: rampLabel,
    sampleRamp: sampleRamp,
    defaultRamp: defaultRamp,
    isSigned: isSigned,
    stats: stats,
    sortedFinite: sortedFinite,
    percentile: percentile,
    stretchRange: stretchRange,
    fieldToRGBA: fieldToRGBA,
    resample: resample,
    boundsOf: boundsOf,
    sampleArrows: sampleArrows,
  };
});

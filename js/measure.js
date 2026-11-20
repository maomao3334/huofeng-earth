/*
 * Local Earth — 量算内核（P1-4.5）
 * ---------------------------------------------------------------------------------------------
 * 纯计算模块：**不依赖 Cesium**，只在浏览器端可选地把 Cesium 的椭球测地线接进来。
 * 这样同一份算法可以在 Node 里直接跑单元测试（见 tools/test-measure.js）。
 *
 * 能力：
 *   1. 距离      —— 椭球测地线（Vincenty 反解，精度 ≤ 0.5 mm）、多段累计、逐段明细
 *   2. 面积      —— 球面面积（等积圆半径 R_auth）+ 投影面积（等积/UTM/高斯-克吕格 鞋带公式）
 *   3. 角度      —— 方位角（正北顺时针）、两段夹角、方位角扇形
 *   4. 高差      —— 逐点高程、累计高差、净高差、坡度、水平距离
 *   5. 周长      —— 闭合折线周长
 *
 * 对外接口：window.LEMeasure = { ... }
 * 也支持 Node：module.exports = api
 *
 * 坐标系约定：所有经纬度一律 **WGS84 经纬度 [lon, lat]（度）**。
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  // WGS84
  const WGS84_A = 6378137.0;                                  // 长半轴
  const WGS84_F = 1 / 298.257223563;                          // 扁率
  const WGS84_B = WGS84_A * (1 - WGS84_F);                    // 短半轴
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);                   // 第一偏心率平方
  const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);                // 第二偏心率平方

  // 等积（authalic）半径：用来算球面面积，WGS84 ≈ 6371007.1809 m
  const AUTHALIC_R = 6371007.1809;

  const R_MEAN = 6371008.8;                                   // 平均半径（回退用）

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function toRad(d) {
    return d * DEG;
  }

  function toDeg(r) {
    return r * RAD;
  }

  /** 归一化经度到 [-180, 180)。 */
  function wrapLon(lon) {
    let x = ((lon + 180) % 360 + 360) % 360 - 180;
    return x === -180 ? 180 : x;
  }

  /**
   * 测地线反解（Vincenty inverse）。
   * 输入/输出都是度。
   * @returns {{distance:number, azimuth1:number, azimuth2:number}} 距离 m，方位角 °（正北顺时针）
   */
  function inverse(lon1, lat1, lon2, lat2) {
    if (!isNum(lon1) || !isNum(lat1) || !isNum(lon2) || !isNum(lat2)) return null;

    const L = toRad(wrapLon(lon2 - lon1));
    const U1 = Math.atan((1 - WGS84_F) * Math.tan(toRad(lat1)));
    const U2 = Math.atan((1 - WGS84_F) * Math.tan(toRad(lat2)));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    let lambda = L;
    let lambdaP = 2 * Math.PI;
    let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0;
    let iter = 0;
    let converged = false;

    do {
      const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
      sinSigma = Math.sqrt(
        (cosU2 * sinLambda) * (cosU2 * sinLambda) +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
      );
      if (sinSigma === 0) {
        // 同点
        return { distance: 0, azimuth1: 0, azimuth2: 0 };
      }
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
      sigma = Math.atan2(sinSigma, cosSigma);
      const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
      cosSqAlpha = 1 - sinAlpha * sinAlpha;
      // cosSqAlpha == 0 表示经线重合，此时 cos2SigmaM = 0
      cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
      const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
      lambdaP = lambda;
      lambda =
        L +
        (1 - C) *
          WGS84_F *
          sinAlpha *
          (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
      iter++;
      if (Math.abs(lambda - lambdaP) < 1e-12) { converged = true; break; }
    } while (iter < 200);

    if (!converged) {
      // 近乎对跖点 Vincenty 不收敛 → 退回球面余弦定理
      const d = sphericalDistance(lon1, lat1, lon2, lat2);
      return { distance: d, azimuth1: azimuth1(lon1, lat1, lon2, lat2), azimuth2: null };
    }

    const uSq = cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
    const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));

    const distance = WGS84_B * A * (sigma - deltaSigma);
    const azimuth1 = Math.atan2(cosU2 * Math.sin(lambda), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda));
    const azimuth2 = Math.atan2(cosU1 * Math.sin(lambda), -sinU1 * cosU2 + cosU1 * sinU2 * Math.cos(lambda));

    return {
      distance: distance,
      azimuth1: (toDeg(azimuth1) + 360) % 360,
      azimuth2: (toDeg(azimuth2) + 360) % 360,
    };
  }

  /** 球面余弦定理距离（回退 / 大圆粗算）。 */
  function sphericalDistance(lon1, lat1, lon2, lat2) {
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const dp = toRad(lat2 - lat1), dl = toRad(wrapLon(lon2 - lon1));
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 初始方位角（正北 0°，顺时针）。 */
  function azimuth1(lon1, lat1, lon2, lat2) {
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const dl = toRad(wrapLon(lon2 - lon1));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /* ------------------------------------------------------------------ *
   * 1. 距离 / 多段累计
   * ------------------------------------------------------------------ */

  /**
   * 折线距离（多段累计）。
   * @param {Array<[number,number]>} points 经纬度序列
   * @param {object} [opts] { closed:boolean } closed=true 时把末点连回首点
   * @returns {{total:number, segments:Array, count:number}}
   */
  function pathDistance(points, opts) {
    const pts = cleanPoints(points);
    const closed = !!(opts && opts.closed);
    const segments = [];
    let total = 0;
    const n = pts.length;
    if (n < 2) return { total: 0, segments: segments, count: n };

    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const r = inverse(a[0], a[1], b[0], b[1]);
      const d = r ? r.distance : sphericalDistance(a[0], a[1], b[0], b[1]);
      total += d;
      segments.push({
        index: i + 1,
        from: a,
        to: b,
        distance: d,
        azimuth: r && r.azimuth1 != null ? r.azimuth1 : azimuth1(a[0], a[1], b[0], b[1]),
      });
    }
    return { total: total, segments: segments, count: n };
  }

  /** 周长（闭合）。 */
  function perimeter(points) {
    return pathDistance(points, { closed: true }).total;
  }

  /* ------------------------------------------------------------------ *
   * 2. 面积
   * ------------------------------------------------------------------ */

  /**
   * 球面多边形面积（等积圆近似）。
   * @returns {number} 平方米
   */
  function sphericalArea(points) {
    const pts = cleanPoints(points);
    if (pts.length < 3) return 0;
    let sum = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      sum += toRad(wrapLon(b[0] - a[0])) * (2 + Math.sin(toRad(a[1])) + Math.sin(toRad(b[1])));
    }
    return Math.abs((sum * AUTHALIC_R * AUTHALIC_R) / 2);
  }

  /**
   * 投影面积（鞋带公式）。需要在**投影坐标系**里算才有意义。
   * @param {Array<[number,number]>} points WGS84 经纬度
   * @param {function([number,number]):[number,number]} project 正投影函数 (lon,lat) → [x,y]（米）
   * @returns {{area:number, valid:boolean}}
   */
  function projectedArea(points, project) {
    const pts = cleanPoints(points);
    if (pts.length < 3 || typeof project !== 'function') return { area: 0, valid: false };
    const xy = [];
    for (const p of pts) {
      const q = project(p[0], p[1]);
      if (!q || !isNum(q[0]) || !isNum(q[1])) return { area: 0, valid: false };
      xy.push(q);
    }
    let sum = 0;
    const n = xy.length;
    for (let i = 0; i < n; i++) {
      const a = xy[i];
      const b = xy[(i + 1) % n];
      sum += a[0] * b[1] - b[0] * a[1];
    }
    return { area: Math.abs(sum / 2), valid: true };
  }

  /* ------------------------------------------------------------------ *
   * 3. 角度
   * ------------------------------------------------------------------ */

  /**
   * 折线转角（每个中间顶点的转向角，正数表示右转/顺时针）。
   * @returns {Array<{index:number, turn:number, azimuthIn:number, azimuthOut:number}>}
   */
  function turnAngles(points) {
    const pts = cleanPoints(points);
    const out = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const azIn = azimuth1(a[0], a[1], b[0], b[1]);
      const azOut = azimuth1(b[0], b[1], c[0], c[1]);
      let turn = azOut - azIn;
      while (turn > 180) turn -= 360;
      while (turn < -180) turn += 360;
      out.push({ index: i + 1, turn: turn, azimuthIn: azIn, azimuthOut: azOut });
    }
    return out;
  }

  /**
   * 两条线段在公共端点 B 处的**内夹角**（向量 B→A 与 B→C 之间的夹角，0–180°）。
   * 直线的中间点夹角 = 180°；直角折线 = 90°。
   */
  function angleAt(a, b, c) {
    const azIn = azimuth1(a[0], a[1], b[0], b[1]);
    const azOut = azimuth1(b[0], b[1], c[0], c[1]);
    let turn = azOut - azIn;
    while (turn > 180) turn -= 360;
    while (turn < -180) turn += 360;
    // 转角是行进方向的偏转，内夹角与之互补
    const angle = 180 - Math.abs(turn);
    return { angle: angle, turn: turn, azimuthIn: azIn, azimuthOut: azOut };
  }

  /* ------------------------------------------------------------------ *
   * 4. 高差 / 坡度
   * ------------------------------------------------------------------ */

  /**
   * 沿折线的高程统计。
   * @param {Array<[number,number]>} points
   * @param {function(number,number):number} heightAt (lon,lat) → 高程 m
   * @param {object} [opts] { stepMeters:number } 沿线加密采样步长（默认 50 m）
   */
  function elevationProfile(points, heightAt, opts) {
    const pts = cleanPoints(points);
    if (pts.length < 2 || typeof heightAt !== 'function') {
      return { ok: false, points: [], climb: 0, descent: 0, net: 0, min: 0, max: 0, horizontal: 0, slope: 0, reason: '至少需要 2 个点' };
    }
    const dist = pathDistance(pts);
    const total = dist.total;
    const step = Math.max((opts && opts.stepMeters) || 50, total / 4096);

    // 沿每一段线性插值采样，同时累计里程
    const samples = [];
    let s0 = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const segLen = dist.segments[i].distance;
      const n = Math.max(1, Math.ceil(segLen / step));
      const a = pts[i], b = pts[i + 1];
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const lon = wrapLon(a[0] + wrapLon(b[0] - a[0]) * t);
        const lat = a[1] + (b[1] - a[1]) * t;
        const h = heightAt(lon, lat);
        samples.push({
          lon: lon,
          lat: lat,
          height: isNum(h) ? h : null,
          s: s0 + segLen * t,
        });
      }
      s0 += segLen;
    }
    // 最后一个点
    const lastPt = pts[pts.length - 1];
    const lastH = heightAt(lastPt[0], lastPt[1]);
    samples.push({
      lon: lastPt[0],
      lat: lastPt[1],
      height: isNum(lastH) ? lastH : null,
      s: total,
    });

    if (samples.some(s => s.height === null)) {
      return { ok:false, points:samples, count:samples.length, horizontal:total,
        net:null, climb:null, descent:null, min:null, max:null, slope:null, reason:'沿线高程数据不完整' };
    }
    let climb = 0, descent = 0;
    let min = Infinity, max = -Infinity;
    for (const s of samples) {
      if (s.height < min) min = s.height;
      if (s.height > max) max = s.height;
    }
    for (let i = 1; i < samples.length; i++) {
      const dh = samples[i].height - samples[i - 1].height;
      if (dh > 0) climb += dh;
      else descent -= dh;
    }

    const net = samples[samples.length - 1].height - samples[0].height;
    const slope = total > 0 ? (Math.abs(net) / total) * 100 : 0;

    return {
      ok: true,
      points: samples,
      count: samples.length,
      climb: climb,
      descent: descent,
      net: net,
      min: isFinite(min) ? min : 0,
      max: isFinite(max) ? max : 0,
      horizontal: total,
      slope: slope,
    };
  }

  /* ------------------------------------------------------------------ *
   * 5. 投影坐标系选择（给投影面积用）
   * ------------------------------------------------------------------ */

  /**
   * 按中心经纬度自动选一个合适的投影（UTM 带 / CGCS2000 3 度带）。
   * 纯计算，不依赖 proj4 —— 只返回描述，由调用方去建转换器。
   * @returns {{kind:'utm'|'gauss3', epsg:number, centralMeridian:number, label:string}}
   */
  function pickProjection(lon, lat) {
    const lonN = wrapLon(lon);
    // UTM 带号：floor((lon+180)/6)+1，中央经线 = 带号*6-183
    const zone = Math.min(60, Math.max(1, Math.floor((lonN + 180) / 6) + 1));
    const north = lat >= 0;
    return {
      kind: 'utm',
      epsg: (north ? 32600 : 32700) + zone,
      centralMeridian: zone * 6 - 183,
      label: 'WGS 84 / UTM ' + zone + (north ? 'N' : 'S'),
    };
  }

  /* ------------------------------------------------------------------ *
   * 格式化
   * ------------------------------------------------------------------ */

  function formatDistance(meters) {
    if (!isNum(meters)) return '--';
    if (Math.abs(meters) >= 1000) return (meters / 1000).toFixed(3) + ' km';
    return meters.toFixed(2) + ' m';
  }

  function formatArea(sqMeters) {
    if (!isNum(sqMeters)) return '--';
    const a = Math.abs(sqMeters);
    if (a >= 1e8) return (sqMeters / 1e8).toFixed(4) + ' 亿m²';
    if (a >= 1e6) return (sqMeters / 1e6).toFixed(3) + ' km²';
    if (a >= 1e4) return (sqMeters / 1e4).toFixed(3) + ' 公顷';
    return sqMeters.toFixed(1) + ' m²';
  }

  function formatAngle(deg) {
    if (!isNum(deg)) return '--';
    return deg.toFixed(2) + '°';
  }

  function formatElevation(meters) {
    if (!isNum(meters)) return '--';
    return (meters >= 0 ? '+' : '') + meters.toFixed(1) + ' m';
  }

  function formatBearing(deg) {
    if (!isNum(deg)) return '--';
    const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    return deg.toFixed(1) + '°（' + names[idx] + '）';
  }

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function cleanPoints(points) {
    const out = [];
    if (!Array.isArray(points)) return out;
    for (const p of points) {
      if (!p) continue;
      const lon = Number(p[0] != null ? p[0] : p.lon);
      const lat = Number(p[1] != null ? p[1] : p.lat);
      if (isNum(lon) && isNum(lat)) out.push([lon, lat]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 汇总：一次算完所有量算结果（供 UI 直接渲染）
   * ------------------------------------------------------------------ */

  /**
   * @param {Array<[number,number]>} points
   * @param {object} [opts] { heightAt, project }
   */
  function summarize(points, opts) {
    const o = opts || {};
    const pts = cleanPoints(points);
    const out = {
      ok: false,
      count: pts.length,
      distance: null,
      areaSpherical: null,
      areaProjected: null,
      perimeter: null,
      segments: [],
      turns: [],
      angles: [],
      elevation: null,
      bbox: null,
    };
    if (pts.length === 0) return out;

    if (pts.length >= 2) {
      const d = pathDistance(pts);
      out.distance = d.total;
      out.segments = d.segments;
      out.turns = turnAngles(pts);
      if (pts.length >= 3) {
        out.perimeter = perimeter(pts);
        out.areaSpherical = sphericalArea(pts);
        if (typeof o.project === 'function') {
          const pa = projectedArea(pts, o.project);
          out.areaProjected = pa.valid ? pa.area : null;
        }
      }
      if (typeof o.heightAt === 'function') {
        out.elevation = elevationProfile(pts, o.heightAt, o);
      }
    }
    if (pts.length >= 3) {
      // 每个顶点处的夹角
      for (let i = 1; i < pts.length - 1; i++) {
        const a = angleAt(pts[i - 1], pts[i], pts[i + 1]);
        a.index = i + 1;
        out.angles.push(a);
      }
    }
    // 包围盒
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of pts) {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > n) n = p[1];
    }
    out.bbox = { west: w, south: s, east: e, north: n };

    out.ok = true;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  const api = {
    // 常量
    AUTHALIC_R: AUTHALIC_R,
    R_MEAN: R_MEAN,
    WGS84: { a: WGS84_A, b: WGS84_B, f: WGS84_F },
    // 基础
    inverse: inverse,
    sphericalDistance: sphericalDistance,
    azimuth1: azimuth1,
    // 距离
    pathDistance: pathDistance,
    perimeter: perimeter,
    // 面积
    sphericalArea: sphericalArea,
    projectedArea: projectedArea,
    // 角度
    turnAngles: turnAngles,
    angleAt: angleAt,
    // 高差
    elevationProfile: elevationProfile,
    // 投影
    pickProjection: pickProjection,
    // 格式化
    formatDistance: formatDistance,
    formatArea: formatArea,
    formatAngle: formatAngle,
    formatElevation: formatElevation,
    formatBearing: formatBearing,
    // 汇总
    summarize: summarize,
    cleanPoints: cleanPoints,
  };

  root.LEMeasure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

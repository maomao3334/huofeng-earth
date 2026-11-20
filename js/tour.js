/*
 * Tour / 电影运镜 · 内核（P2-4.10）
 * ---------------------------------------------------------------------------
 * 纯计算，不依赖 Cesium / DOM，可以在 Node 里直接 require 来单测。
 *
 * 对外 API：
 *   window.LETour = module.exports = {
 *     parseTour, serializeTour, normalizeTour,
 *     sampleTour, easeInOut, catmullRom, interpolateCamera,
 *     tourDuration, buildKeyframes, cameraAt,
 *   }
 *
 * 【Tour 文件格式（自研，JSON，UTF-8）】
 * {
 *   "version": 1,
 *   "name": "我的航线",
 *   "fov": 60,                       // 可选：视场角（度）
 *   "keyframes": [
 *     { "lon": 116.39, "lat": 39.90, "height": 3000,
 *       "heading": 45, "pitch": -30, "duration": 4,   // duration = 到下一帧的秒数
 *       "name": "北京 · 起始" },
 *     ...
 *   ]
 * }
 *
 * 【为什么不直接用 Google Earth 的 .kmz tour】
 *   1) GEP 的 tour 是 KMZ 里的一个加密/私有二进制格式，格式未公开；
 *   2) 本软件坚持纯离线 + 自研可读格式，用户能用记事本改航线；
 *   3) 导出的 HTML 播放器同样自研，零依赖。
 *
 * 【插值方式】
 *   相机轨迹用 **Catmull-Rom 样条**穿过所有关键帧 —— 比线性插值平滑，
 *   不会在关键帧之间拐硬角（Google Earth 的 tour 也是样条手感）。
 *   但**高度**用对数插值：地球尺度上高度是指数量级的，
 *   线性插值会让「从 1000 m 飞到 100000 m」的中间段几乎贴着地面爬行。
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LETour = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;

  /* ------------------------------------------------------------------ *
   * 解析 / 序列化
   * ------------------------------------------------------------------ */

  /**
   * 解析 Tour 文件（JSON 字符串或已解析的对象）。
   * @returns {{ok:boolean, error?:string, tour?:object}}
   */
  function parseTour(input) {
    let obj = input;
    if (typeof input === 'string') {
      try {
        obj = JSON.parse(input);
      } catch (err) {
        return { ok: false, error: '不是合法的 JSON：' + err.message };
      }
    }
    if (!obj || typeof obj !== 'object') return { ok: false, error: '内容不是对象' };
    if (!Array.isArray(obj.keyframes)) return { ok: false, error: '缺少 keyframes 数组' };
    const norm = normalizeTour(obj);
    if (!norm.ok) return norm;
    return { ok: true, tour: norm.tour };
  }

  /**
   * 规范化：把关键帧里的数值钳到合理范围，并补齐缺省值。
   * 单帧非法不应该让整个 Tour 报废 —— 跳过它并记录原因。
   */
  function normalizeTour(obj) {
    const frames = [];
    const skipped = [];
    (obj.keyframes || []).forEach(function (k, i) {
      const lon = Number(k.lon != null ? k.lon : k.longitude);
      const lat = Number(k.lat != null ? k.lat : k.latitude);
      const height = Number(k.height != null ? k.height : k.altitude);
      if (!isFinite(lon) || !isFinite(lat) || !isFinite(height)) {
        skipped.push({ index: i, reason: '经纬度或高度不是数字' });
        return;
      }
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        skipped.push({ index: i, reason: '经纬度超出范围' });
        return;
      }
      const dur = Number(k.duration);
      frames.push({
        lon: lon,
        lat: lat,
        height: Math.max(1, height),
        heading: normAngle(Number(k.heading) || 0),
        pitch: Math.max(-90, Math.min(0, Number(k.pitch) || 0)),
        roll: Number(k.roll) || 0,
        // duration 是「到下一帧」的秒数；最后一帧的 duration 不参与插值
        duration: isFinite(dur) && dur > 0 ? dur : 0,
        name: k.name ? String(k.name) : ('第 ' + (i + 1) + ' 站'),
      });
    });
    if (!frames.length) return { ok: false, error: '没有有效的关键帧' };
    // 【duration 的语义】
    //   第 i 帧的 duration = 「从第 i 帧飞到第 i+1 帧要几秒」，
    //   所以**只有最后一帧**的 duration 无意义。
    //   早先版本把第一帧的 duration 清零了 —— 那会直接削掉航线总时长，
    //   往返序列化后时长对不上。
    return {
      ok: true,
      tour: {
        version: Number(obj.version) || VERSION,
        name: obj.name ? String(obj.name) : '未命名航线',
        fov: isFinite(Number(obj.fov)) ? Number(obj.fov) : null,
        keyframes: frames,
        skipped: skipped,
      },
    };
  }

  /** 把角度规整到 [0, 360)。 */
  function normAngle(deg) {
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  /** 序列化成 JSON 字符串（带缩进，人可读）。 */
  function serializeTour(tour) {
    const out = {
      version: tour.version || VERSION,
      name: tour.name || '未命名航线',
      keyframes: (tour.keyframes || []).map(function (k) {
        return {
          lon: round(k.lon, 7),
          lat: round(k.lat, 7),
          height: round(k.height, 2),
          heading: round(k.heading, 2),
          pitch: round(k.pitch, 2),
          name: k.name || '',
          duration: round(k.duration || 0, 3),
        };
      }),
    };
    if (tour.fov != null) out.fov = tour.fov;
    return JSON.stringify(out, null, 2);
  }

  function round(n, d) {
    const v = Number(n);
    if (!isFinite(v)) return 0;
    const p = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * p) / p;
  }

  /* ------------------------------------------------------------------ *
   * 插值
   * ------------------------------------------------------------------ */

  /** 缓动：三次平滑，t ∈ [0,1] → [0,1]。 */
  function easeInOut(t) {
    const x = Math.max(0, Math.min(1, Number(t) || 0));
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  /**
   * Catmull-Rom 样条（给定四个控制点，u ∈ [0,1] 取 p1→p2 之间）。
   */
  function catmullRom(p0, p1, p2, p3, u) {
    const u2 = u * u;
    const u3 = u2 * u;
    return 0.5 * (
      2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3
    );
  }

  /**
   * 线性插值角度（走最短弧，避免 350°→10° 转 340°）。
   */
  function lerpAngle(a, b, t) {
    let d = ((b - a) % 360 + 540) % 360 - 180;
    return a + d * t;
  }

  /**
   * 在关键帧序列里取 t 时刻的相机状态。
   *
   * @param {Array} frames 已规范化的关键帧（每个 frame.duration = 到下一帧的秒数）
   * @param {number} t     累计秒数
   * @returns {{lon,lat,height,heading,pitch,roll,index,u,segment}}
   */
  function cameraAt(frames, t) {
    const list = frames || [];
    if (!list.length) return null;
    if (list.length === 1) {
      const f = list[0];
      return {
        lon: f.lon, lat: f.lat, height: f.height,
        heading: f.heading, pitch: f.pitch, roll: f.roll,
        index: 0, u: 0, segment: 0,
      };
    }

    // 定位到所在的时间段
    let acc = 0;
    let i = 0;
    while (i < list.length - 2 && acc + list[i].duration <= t) {
      acc += list[i].duration;
      i++;
    }
    // 到了最后一段（i = length-2）就停住。
    // 【为什么不能写成 length-1】
    //   那样最后一段的 p2 会越界，t 恰好等于总时长时返回的是**倒数第二帧**，
    //   终点永远到不了。
    if (i > list.length - 2) i = list.length - 2;
    if (i < 0) i = 0;
    const dur = list[i].duration > 0 ? list[i].duration : 1;
    const local = Math.max(0, Math.min(dur, t - acc));
    const u = dur > 0 ? local / dur : 0;

    const p1 = list[i];
    const p2 = list[i + 1];
    if (!p2) {
      return {
        lon: p1.lon, lat: p1.lat, height: p1.height,
        heading: p1.heading, pitch: p1.pitch, roll: p1.roll,
        index: i, u: 0, segment: i, name: p1.name,
      };
    }
    const p0 = list[i - 1] || p1;
    const p3 = list[i + 2] || p2;

    const e = easeInOut(u);

    // 经纬度走样条；高度走对数插值（地球尺度下高度是指数量级）
    const lon = catmullRom(p0.lon, p1.lon, p2.lon, p3.lon, e);
    const lat = catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, e);
    const h1 = Math.log(Math.max(1, p1.height));
    const h2 = Math.log(Math.max(1, p2.height));
    const h0 = Math.log(Math.max(1, p0.height));
    const h3 = Math.log(Math.max(1, p3.height));
    const height = Math.exp(catmullRom(h0, h1, h2, h3, e));

    // 朝向走最短弧 + 线性
    const heading = normAngle(lerpAngle(p1.heading, p2.heading, e));
    const pitch = p1.pitch + (p2.pitch - p1.pitch) * e;
    const roll = p1.roll + (p2.roll - p1.roll) * e;

    return {
      lon: lon, lat: lat, height: height,
      heading: heading, pitch: pitch, roll: roll,
      index: i, u: u, segment: i,
      name: e < 0.5 ? p1.name : p2.name,
    };
  }

  /** Tour 总时长（秒）。 */
  function tourDuration(frames) {
    const list = frames || [];
    let total = 0;
    for (let i = 0; i < list.length - 1; i++) total += list[i].duration || 0;
    return total;
  }

  /**
   * 均匀采样整条航线，用于导出 HTML 播放器（把样条烘成密集轨迹点）。
   *
   * @param {Array} frames
   * @param {number} step 采样间隔（秒）
   * @returns {Array} 采样点
   */
  function sampleTour(frames, step) {
    const list = frames || [];
    const total = tourDuration(list);
    if (!list.length || total <= 0) return [];
    const s = step > 0 ? step : Math.max(0.05, total / 600);
    const out = [];
    for (let t = 0; t <= total + 1e-9; t += s) {
      const c = cameraAt(list, t);
      if (c) out.push({ t: round(t, 3), lon: c.lon, lat: c.lat, height: c.height,
                        heading: c.heading, pitch: c.pitch });
    }
    // 补上精确终点
    const last = cameraAt(list, total);
    if (last && (!out.length || out[out.length - 1].t < total - 1e-6)) {
      out.push({ t: round(total, 3), lon: last.lon, lat: last.lat, height: last.height,
                 heading: last.heading, pitch: last.pitch });
    }
    return out;
  }

  /**
   * 把当前相机位置录成一个关键帧（追加到 Tour 里）。
   */
  function buildKeyframes(tour, camera, opts) {
    opts = opts || {};
    const t = tour && Array.isArray(tour.keyframes) ? tour.keyframes.slice() : [];
    const last = t[t.length - 1];
    const dur = opts.duration != null ? Number(opts.duration) : (last ? 4 : 0);
    t.push({
      lon: Number(camera.lon),
      lat: Number(camera.lat),
      height: Number(camera.height),
      heading: normAngle(Number(camera.heading) || 0),
      pitch: Number(camera.pitch) || 0,
      roll: Number(camera.roll) || 0,
      duration: Math.max(0, dur),
      name: opts.name || ('第 ' + (t.length + 1) + ' 站'),
    });
    return {
      version: (tour && tour.version) || VERSION,
      name: (tour && tour.name) || opts.name || '未命名航线',
      fov: tour && tour.fov != null ? tour.fov : null,
      keyframes: t,
    };
  }

  return {
    VERSION: VERSION,
    parseTour: parseTour,
    normalizeTour: normalizeTour,
    serializeTour: serializeTour,
    normAngle: normAngle,
    easeInOut: easeInOut,
    catmullRom: catmullRom,
    lerpAngle: lerpAngle,
    cameraAt: cameraAt,
    tourDuration: tourDuration,
    sampleTour: sampleTour,
    buildKeyframes: buildKeyframes,
  };
});

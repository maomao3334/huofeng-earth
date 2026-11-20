/*
 * 时间轴 / 历史影像 · 内核（P2-4.9）
 * ---------------------------------------------------------------------------
 * 纯计算，不依赖 Cesium / DOM，可以在 Node 里直接 require 来单测。
 *
 * 对外 API：
 *   window.LETimeline = module.exports = {
 *     TIME_RE, parseTime, formatTime,
 *     groupByDate, sortFrames, pickFrame, nearestFrame,
 *     buildTimeline, describeIntervals, intervalsBetween,
 *   }
 *
 * 【为什么需要「帧」这个概念】
 *   历史影像的本质是：同一套空间范围、不同拍摄时间的若干张影像。
 *   用户拖时间轴 → 软件决定「这一时刻该显示哪一张」。
 *   所以核心问题只有一个：**给定时间 t，从候选帧里挑哪一帧**。
 *
 * 【挑选规则】
 *   1) 只在候选帧里挑 —— 没有帧的时段显示「无数据」，绝不偷偷拿别的时相顶替。
 *   2) 「最接近」而不是「不超过」：
 *        - 离 t 最近的帧优先；
 *        - 距离相同则取**更早**的那帧（历史影像里「上一期」比「下一期」更保守，
 *          不会把还没发生的事提前显示出来）。
 *   3) 容差：|t - frame| 超过 tolerance 就算「无数据」。
 *      默认 tolerance = 半个帧间隔 —— 也就是说，只有相邻两帧的中间点才判空，
 *      避免时间轴一大半时间是灰的。
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LETimeline = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 时间戳识别：2017-04-01 / 20170401 / 2017 / 2017-04 / 20170401T101530 */
  const TIME_RE = /(\d{4})(?:[-_/]?(\d{2}))?(?:[-_/]?(\d{2}))?(?:[T ](\d{2}))?(?:[:_]?(\d{2}))?(?:[:_]?(\d{2}))?/;

  /**
   * 从任意字符串里抠出一个时间戳。
   * @returns {Date|null}
   */
  function parseTime(input) {
    if (input == null) return null;
    if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
    if (typeof input === 'number' && isFinite(input)) {
      // 10 位当秒，13 位当毫秒
      const ms = input > 1e11 ? input : input * 1000;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(input).trim();
    if (!s) return null;
    const m = TIME_RE.exec(s);
    if (!m) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    const y = +m[1];
    const mo = m[2] != null ? +m[2] : 1;
    const da = m[3] != null ? +m[3] : 1;
    const hh = m[4] != null ? +m[4] : 0;
    const mm = m[5] != null ? +m[5] : 0;
    const ss = m[6] != null ? +m[6] : 0;
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mm > 59 || ss > 59) return null;
    const d = new Date(y, mo - 1, da, hh, mm, ss);
    if (isNaN(d.getTime())) return null;
    // 【为什么要回查】
    //   JS 的 Date 会把「2 月 31 日」自动进位成「3 月 3 日」，
    //   于是 2017-02-31 这种根本不存在的日期会被悄悄解析成 3 月 3 日，
    //   历史影像就落在了错误的期次上。必须回查每个分量是否与输入一致。
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
    if (d.getHours() !== hh || d.getMinutes() !== mm || d.getSeconds() !== ss) return null;
    return d;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /**
   * 格式化成给人看的时间标签。
   * 精度按「原始数据给到哪一级」走，避免把 2017-04-01 显示成 2017-04-01 00:00:00。
   */
  function formatTime(date, withTime) {
    if (!date) return '未知时间';
    const d = date instanceof Date ? date : parseTime(date);
    if (!d) return '未知时间';
    const base = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (!withTime) return base;
    return base + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /**
   * 从数据集/文件名里猜时间。
   * @param {object} ds 数据集对象
   * @returns {Date|null}
   */
  function guessTime(ds) {
    if (!ds) return null;
    const candidates = [];
    if (ds.time) candidates.push(ds.time);
    if (ds.date) candidates.push(ds.date);
    if (ds.acquiredAt) candidates.push(ds.acquiredAt);
    if (ds.createdAt) candidates.push(ds.createdAt);
    if (ds.geo && ds.geo.acquiredAt) candidates.push(ds.geo.acquiredAt);
    if (ds.source && ds.source.acquiredAt) candidates.push(ds.source.acquiredAt);
    if (ds.name) candidates.push(ds.name);
    if (ds.id) candidates.push(ds.id);
    for (let i = 0; i < candidates.length; i++) {
      const t = parseTime(candidates[i]);
      if (t) return t;
    }
    return null;
  }

  /**
   * 把候选帧按时间排序（升序）。
   * 没有时间的排在最后，保持稳定顺序。
   */
  function sortFrames(frames) {
    return (frames || []).slice().sort(function (a, b) {
      const ta = a.time ? a.time.getTime() : Infinity;
      const tb = b.time ? b.time.getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      return (a.order || 0) - (b.order || 0);
    });
  }

  /**
   * 在候选帧里挑最接近 t 的一帧。
   *
   * @param {Array} frames 已按时间排序的帧
   * @param {Date|number|string} at 目标时刻
   * @param {object} opts
   *   tolerance 毫秒容差。
   *            · **不传（默认）** → 采用「跨度覆盖」语义：
   *              目标落在 [最早帧, 最晚帧] 区间内时，永远返回最近的一帧
   *              （跟 Google Earth Pro 的历史影像一致 —— 归档期内不会莫名其妙空一块）；
   *              落在区间**外**才判「无数据」（不拿离得老远的一期硬顶）。
   *            · **给了数字** → 采用「距离容差」语义：
   *              |t - frame| 超过该值就判无数据（可用于「只在特定时相附近有效」的场景）。
   *   strict    true 时永远返回最接近的一帧（连跨度外也返回），用于「跳到最早/最晚一期」。
   * @returns {{frame:object|null, gap:number, reason:string}}
   */
  function pickFrame(frames, at, opts) {
    opts = opts || {};
    const t = parseTime(at);
    const list = sortFrames(frames).filter(function (f) { return f && f.time; });
    if (!list.length) return { frame: null, gap: Infinity, reason: 'no-frames' };
    if (!t) return { frame: null, gap: Infinity, reason: 'no-target-time' };

    const target = t.getTime();
    let best = null;
    let bestGap = Infinity;
    let bestIsEarlier = false;
    for (let i = 0; i < list.length; i++) {
      const ft = list[i].time.getTime();
      const gap = Math.abs(ft - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = list[i];
        bestIsEarlier = ft <= target;
      } else if (gap === bestGap && best && ft < best.time.getTime()) {
        // 距离相同：取更早的那一帧。
        // 历史影像里「上一期」比「下一期」保守 —— 不会把还没拍的事提前显示出来。
        best = list[i];
        bestIsEarlier = true;
      }
    }

    if (opts.strict) {
      return { frame: best, gap: bestGap, reason: bestIsEarlier ? 'nearest-earlier' : 'nearest-later' };
    }

    if (opts.tolerance != null) {
      // 距离容差语义
      if (bestGap > opts.tolerance) {
        return { frame: null, gap: bestGap, reason: 'outside-tolerance' };
      }
    } else {
      // 跨度覆盖语义：归档区间外判无数据
      const first = list[0].time.getTime();
      const last = list[list.length - 1].time.getTime();
      if (target < first || target > last) {
        return { frame: null, gap: bestGap, reason: 'outside-span' };
      }
    }
    return {
      frame: best,
      gap: bestGap,
      reason: bestIsEarlier ? 'nearest-earlier' : 'nearest-later',
    };
  }

  /** 自动容差：相邻帧间隔的一半（帧只有一帧时为 null = 不判空）。 */
  function autoTolerance(list) {
    if (list.length < 2) return null;
    let min = Infinity;
    for (let i = 1; i < list.length; i++) {
      const d = list[i].time.getTime() - list[i - 1].time.getTime();
      if (d > 0 && d < min) min = d;
    }
    return isFinite(min) ? min / 2 : null;
  }

  /** 离 t 最近的一帧（不考虑容差），用于「跳到上一期/下一期」。 */
  function nearestFrame(frames, at) {
    const r = pickFrame(frames, at, { strict: true });
    return r.frame;
  }

  /**
   * 按时间把帧分组（例如按年 / 按月），返回 [{key, label, frames}]。
   */
  function groupByDate(frames, granularity) {
    const list = sortFrames(frames);
    const g = granularity || 'year';
    const out = [];
    const map = new Map();
    list.forEach(function (f, i) {
      if (!f.time) return;
      const d = f.time;
      let key;
      let label;
      if (g === 'month') {
        key = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
        label = key;
      } else if (g === 'day') {
        key = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
        label = key;
      } else {
        key = String(d.getFullYear());
        label = key + ' 年';
      }
      if (!map.has(key)) {
        const grp = { key: key, label: label, frames: [] };
        map.set(key, grp);
        out.push(grp);
      }
      map.get(key).frames.push(f);
    });
    out.forEach(function (grp) {
      grp.frames.forEach(function (f, i) { f.groupKey = grp.key; f.groupLabel = grp.label; });
    });
    return out;
  }

  /**
   * 描述相邻帧之间的间隔，用来做时间轴刻度。
   * @returns {Array<{from:Date,to:Date,days:number,label:string}>}
   */
  function intervalsBetween(frames) {
    const list = sortFrames(frames).filter(function (f) { return f.time; });
    const out = [];
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1].time;
      const to = list[i].time;
      const days = Math.round((to - from) / 86400000);
      out.push({ from: from, to: to, days: days, label: days + ' 天' });
    }
    return out;
  }

  /**
   * 生成时间轴描述（给 UI 用的完整信息）。
   *
   * @param {Array} frames  候选帧 [{id,name,time,bounds,url,...}]
   * @param {object} opts
   * @returns {object} {frames, from, to, span, count, groups, intervals}
   */
  function buildTimeline(frames, opts) {
    opts = opts || {};
    const list = sortFrames(frames);
    const timed = list.filter(function (f) { return f.time; });
    const from = timed.length ? timed[0].time : null;
    const to = timed.length ? timed[timed.length - 1].time : null;
    const span = from && to ? to.getTime() - from.getTime() : 0;
    return {
      frames: list,
      timedFrames: timed,
      from: from,
      to: to,
      span: span,
      spanDays: Math.round(span / 86400000),
      count: timed.length,
      groups: groupByDate(list, opts.granularity || 'year'),
      intervals: intervalsBetween(list),
    };
  }

  /**
   * 描述「时间轴上某个位置显示什么」—— 给 UI 状态栏用。
   */
  function describeIntervals(timeline, at, opts) {
    const r = pickFrame(timeline.frames, at, opts);
    if (!r.frame) {
      return {
        ok: false,
        reason: r.reason,
        gapDays: isFinite(r.gap) ? Math.round(r.gap / 86400000) : null,
        text: r.reason === 'no-frames' ? '无历史影像' : '该时段无影像',
      };
    }
    return {
      ok: true,
      frame: r.frame,
      reason: r.reason,
      gapDays: Math.round(r.gap / 86400000),
      text: formatTime(r.frame.time) + ' · ' + (r.frame.name || r.frame.id || ''),
    };
  }

  return {
    TIME_RE: TIME_RE,
    parseTime: parseTime,
    formatTime: formatTime,
    guessTime: guessTime,
    sortFrames: sortFrames,
    pickFrame: pickFrame,
    nearestFrame: nearestFrame,
    autoTolerance: autoTolerance,
    groupByDate: groupByDate,
    intervalsBetween: intervalsBetween,
    buildTimeline: buildTimeline,
    describeIntervals: describeIntervals,
  };
});

/*
 * 时间轴 / 历史影像 · 装载层（P2-4.9）
 * ---------------------------------------------------------------------------
 * 负责把「一堆带日期的影像数据集」变成一个可以拖动的时间轴：
 *
 *   1. 扫描本地影像清单 / 数据仓库，找出带时间的候选帧
 *   2. 为每一帧建一个 ImageryProvider
 *   3. 只让「当前时间对应的那一帧」可见，其余隐藏 —— 这就是时间轴的切换
 *   4. 帧之间平滑淡入淡出（可选）
 *
 * 对外 API：window.LETimelineShell
 *   scan()                 → 扫描候选帧
 *   build(frames)          → 建立时间轴
 *   setTime(t)             → 跳到某时刻
 *   play() / pause()       → 播放
 *   step(dir)              → 上一期 / 下一期
 *   dispose()              → 拆除
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const T = window.LETimeline;

  const state = {
    le: null,
    ready: false,
    frames: [],       // [{id,name,time,provider,layer,entry,visible}]
    layers: [],
    currentIndex: -1,
    playing: false,
    playTimer: null,
    intervalMs: 1200,
    listeners: [],
  };

  function byId(id) { return document.getElementById(id); }

  function getLE() { return state.le || window.LE; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  function emit(kind, payload) {
    state.listeners.forEach(function (fn) {
      try { fn(kind, payload); } catch (err) { console.error(err); }
    });
  }

  /* ------------------------------------------------------------------ *
   * 扫描候选帧
   * ------------------------------------------------------------------ */

  /**
   * 从本地影像清单 + 数据仓库清单里找带时间的候选帧。
   *
   * 【时间从哪来】
   *   优先用数据集里显式的时间字段；没有就从**名字/目录名**里抠 ——
   *   国产卫星影像的目录名几乎都带拍摄日期（GF2_..._20170401_...），
   *   这条路比要求用户手工填日期现实得多。
   */
  async function scan() {
    const frames = [];

    /* --- 来源 1：本地影像清单 data/local/imagery.json --- */
    // 这是权威来源：仓库入库的影像也会写进这份清单，
    // 所以只需要扫这一处，vault 那份只是兜底。
    const li = window.LELocalImagery;
    if (li && typeof li.list === 'function') {
      let list = [];
      try { list = li.list(); } catch (err) { list = []; }
      list.forEach(function (ds) {
        const time = T.guessTime(ds);
        if (!time) return;
        // 取原始数据集对象（带 url / scheme / minzoom），provider 构造要用
        const full = (typeof li.getDataset === 'function') ? (li.getDataset(ds.id) || ds) : ds;
        frames.push({
          id: 'local:' + ds.id,
          datasetId: ds.id,
          name: ds.name || ds.id,
          time: time,
          bounds: ds.bounds || null,
          source: 'local-imagery',
          ref: full,
        });
      });
    }

    /* --- 来源 2：数据仓库 data/local/vault.json（清单里没有的兜底） --- */
    const vault = window.LEVault;
    if (vault && typeof vault.list === 'function') {
      let list = [];
      try { list = vault.list(); } catch (err) { list = []; }
      list.forEach(function (ds) {
        if (!ds || ds.kind !== 'imagery') return;
        const time = T.guessTime(ds);
        if (!time) return;
        // 仓库数据集本身没有 url，要回到本地影像清单里找同一个 id 的条目
        let full = ds;
        if (li && typeof li.getDataset === 'function') {
          full = li.getDataset(ds.id) || ds;
        }
        frames.push({
          id: 'vault:' + ds.id,
          datasetId: ds.id,
          name: ds.name || ds.id,
          time: time,
          bounds: ds.geo ? [ds.geo.west, ds.geo.south, ds.geo.east, ds.geo.north] : null,
          source: 'vault',
          ref: full,
        });
      });
    }

    /* --- 去重（同一个数据集可能被两个来源看到） --- */
    const seen = new Set();
    const uniq = [];
    frames.forEach(function (f) {
      const key = f.datasetId;
      if (seen.has(key)) return;
      seen.add(key);
      uniq.push(f);
    });

    uniq.sort(function (a, b) { return a.time - b.time; });
    return uniq;
  }

  /* ------------------------------------------------------------------ *
   * 建立时间轴
   * ------------------------------------------------------------------ */

  function providerFor(frame) {
    const ref = frame.ref || {};
    const li = window.LELocalImagery;
    // 本地影像模块已经封装了「.jpg / .png 混合瓦片 + 无数据透明瓦片」这些细节，
    // 这里直接复用它的 provider 构造逻辑（通过公开的 makeProvider）。
    if (li && typeof li.makeProvider === 'function') {
      try { return li.makeProvider(ref); } catch (err) { /* fallthrough */ }
    }
    // 退路：标准 XYZ 模板
    if (!ref.url) return null;
    const geographic = /geographic|4326/i.test(String(ref.scheme || ''));
    let rectangle;
    if (Array.isArray(ref.bounds) && ref.bounds.length === 4) {
      rectangle = C.Rectangle.fromDegrees.apply(C.Rectangle, ref.bounds.map(Number));
    }
    return new C.UrlTemplateImageryProvider({
      url: String(ref.url).replace(/\{ext\}/g, 'jpg'),
      tilingScheme: geographic ? new C.GeographicTilingScheme() : new C.WebMercatorTilingScheme(),
      rectangle: rectangle,
      minimumLevel: isFinite(Number(ref.minzoom)) ? Number(ref.minzoom) : 0,
      maximumLevel: isFinite(Number(ref.maxzoom)) ? Number(ref.maxzoom) : 22,
      credit: ref.attribution || '历史影像（仅本机）',
    });
  }

  /**
   * 建立时间轴：给每一帧挂一个 ImageryLayer，但**全部先隐藏**。
   * 只有当前帧会显示。
   */
  async function build(frames) {
    dispose();
    const le = getLE();
    if (!le || !le.viewer) throw new Error('应用尚未就绪');
    const list = (frames && frames.length) ? frames : await scan();
    if (!list.length) {
      toast('没有找到带日期的历史影像', 'error', 4000);
      return null;
    }

    const timeline = T.buildTimeline(list);
    const built = [];
    for (let i = 0; i < timeline.timedFrames.length; i++) {
      const frame = timeline.timedFrames[i];
      const provider = providerFor(frame);
      if (!provider) continue;
      const layer = le.viewer.imageryLayers.addImageryProvider(provider);
      layer.show = false;                       // 先全部藏起来
      layer.alpha = 1;
      built.push({
        id: frame.id,
        name: frame.name,
        time: frame.time,
        bounds: frame.bounds,
        provider: provider,
        layer: layer,
        source: frame.source,
      });
    }

    state.frames = built;
    state.currentIndex = -1;
    // 把时间轴的第一帧显示出来，让用户马上看到东西
    if (built.length) setIndex(0);
    emit('built', { count: built.length, timeline: timeline });
    return timeline;
  }

  /* ------------------------------------------------------------------ *
   * 切换
   * ------------------------------------------------------------------ */

  function setIndex(i) {
    if (!state.frames.length) return;
    const idx = Math.max(0, Math.min(state.frames.length - 1, i));
    state.frames.forEach(function (f, k) {
      if (f.layer) f.layer.show = (k === idx);
    });
    state.currentIndex = idx;
    const f = state.frames[idx];
    syncClock(f.time);
    emit('time', {
      index: idx,
      time: f.time,
      name: f.name,
      text: T.formatTime(f.time) + ' · ' + f.name,
      total: state.frames.length,
    });
  }

  /**
   * 把 Cesium 时钟拨到该期影像的拍摄时刻。
   *
   * 【为什么必须同步】
   *   太阳位置由 viewer.clock.currentTime 决定。只换影像不拨时钟的话，
   *   画面里是「2017 年的卫星图 + 今天正午的光照」—— 时相是假的。
   *   拨到拍摄时刻后，阴影方向、地物亮度才对得上那期影像，
   *   这也正是 Google Earth Pro 历史影像的行为。
   *
   *   注意：Cesium 的时钟范围被限制在 ±5 万年以内，这里做一次有效性检查。
   */
  function syncClock(time) {
    const le = getLE();
    if (!le || !le.viewer || !le.viewer.clock || !time) return false;
    try {
      const jd = C.JulianDate.fromDate(time);
      if (!jd || isNaN(jd.dayNumber)) return false;
      le.viewer.clock.currentTime = jd;
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * 跳到某个时刻。
   * @returns {object} pickFrame 的结果
   */
  function setTime(at, opts) {
    if (!state.frames.length) return null;
    const r = T.pickFrame(state.frames, at, opts);
    if (!r.frame) {
      // 【没有对应期次时，必须把所有历史影像图层都藏掉】
      //   只发一个 'nodata' 事件而留着旧图层显示，用户会看到
      //   「这个时刻有影像」—— 那是上一期的影像被留在了屏幕上，纯属误导。
      state.frames.forEach(function (f) { if (f.layer) f.layer.show = false; });
      state.currentIndex = -1;
      emit('nodata', { at: at, reason: r.reason, text: '该时段无影像' });
      return r;
    }
    const idx = state.frames.indexOf(r.frame);
    if (idx >= 0) setIndex(idx);
    return r;
  }

  function step(dir) {
    if (!state.frames.length) return;
    const next = state.currentIndex + (dir > 0 ? 1 : -1);
    if (next < 0 || next >= state.frames.length) return;
    setIndex(next);
  }

  /* ------------------------------------------------------------------ *
   * 播放
   * ------------------------------------------------------------------ */

  function play() {
    if (state.playing || !state.frames.length) return;
    state.playing = true;
    state.playTimer = setInterval(function () {
      if (state.currentIndex >= state.frames.length - 1) {
        pause();
        return;
      }
      setIndex(state.currentIndex + 1);
    }, state.intervalMs);
    emit('play', { playing: true });
  }

  function pause() {
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    state.playing = false;
    emit('play', { playing: false });
  }

  function setIntervalMs(ms) {
    const n = Number(ms);
    if (!isFinite(n) || n < 100) return;
    state.intervalMs = n;
    if (state.playing) { pause(); play(); }
  }

  function dispose() {
    pause();
    const le = getLE();
    state.frames.forEach(function (f) {
      try {
        if (f.layer && le && le.viewer) le.viewer.imageryLayers.remove(f.layer, true);
      } catch (err) { /* ignore */ }
    });
    state.frames = [];
    state.currentIndex = -1;
    emit('disposed', {});
  }

  function getState() {
    const f = state.currentIndex >= 0 ? state.frames[state.currentIndex] : null;
    return {
      count: state.frames.length,
      index: state.currentIndex,
      playing: state.playing,
      intervalMs: state.intervalMs,
      current: f ? { name: f.name, time: f.time, text: T.formatTime(f.time) } : null,
      frames: state.frames.map(function (x, i) {
        return { i: i, name: x.name, time: x.time, visible: i === state.currentIndex };
      }),
    };
  }

  function init(le) {
    state.le = le || window.LE;
    state.ready = true;
  }

  window.LETimelineShell = {
    init: init,
    scan: scan,
    build: build,
    setTime: setTime,
    setIndex: setIndex,
    step: step,
    play: play,
    pause: pause,
    setIntervalMs: setIntervalMs,
    dispose: dispose,
    getState: getState,
    on: function (fn) { state.listeners.push(fn); return fn; },
    off: function (fn) {
      const i = state.listeners.indexOf(fn);
      if (i >= 0) state.listeners.splice(i, 1);
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

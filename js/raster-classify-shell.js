/*
 * 栅格分类 · 装载层（P3-4.15）
 * ---------------------------------------------------------------------------
 * 把「分类器」接进地球：
 *
 *   1) **数据源**：从数据仓库（LEVault）里挑已入库的栅格，或直接选本地文件
 *      （GeoTIFF / ASC / PGM 等，交给 LEVaultRaster 解码）
 *   2) **格网**：把源栅格按当前视野重采样成一张经纬度对齐的多波段格网
 *      （保留原始数值，分类需要真实波段值）
 *   3) **样本点**：在地图上单击采样，归到当前选定的类别
 *   4) **运行**：最小距离 / 最大似然 → 分类图（影像层）+ 混淆矩阵
 *
 * 全程离线、零外部进程：不调 QGIS、不调 GDAL、不起 Python。
 *
 * 对外 API：window.LERasterClassifyShell
 *   sources() / loadSource(id) / buildGrid(opts) / addSample(lon, lat, classId)
 *   removeSample(id) / clearSamples() / samples() / classes()
 *   classify(opts) / kmeans(opts) / getState()
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const RC = window.LERasterClassify;

  const state = {
    le: null,
    sources: [],          // {id, name, kind, bands, bounds, file?}
    activeSourceId: '',
    grid: null,           // {w,h,west,south,east,north,bands:[{name,data}]}
    samples: [],          // {id, lon, lat, classId}
    classes: [
      { id: 1, name: '类别 1', color: '#e6194b' },
      { id: 2, name: '类别 2', color: '#3cb44b' },
      { id: 3, name: '类别 3', color: '#4363d8' },
      { id: 4, name: '类别 4', color: '#f58231' },
      { id: 5, name: '类别 5', color: '#911eb4' },
    ],
    activeClassId: 1,
    lastResult: null,
    listeners: [],
    listenersBound: false,
    sampleSeq: 0,
    picking: false,
  };

  function getLE() { return state.le || window.LE; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3600);
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

  function init(le) {
    state.le = le || window.LE;
    if (state.listenersBound) return;
    state.listenersBound = true;
  }
  function on(fn) {
    if (typeof fn === 'function') state.listeners.push(fn);
    return fn;
  }
  function off(fn) {
    const i = state.listeners.indexOf(fn);
    if (i >= 0) state.listeners.splice(i, 1);
  }

  /* ------------------------------------------------------------------ *
   * ① 数据源
   * ------------------------------------------------------------------ */

  /**
   * 列出可用作分类输入的栅格。
   *
   * 优先取数据仓库里已入库的栅格数据集（imagery / dem），
   * 仓库没有就返回空列表（用户可以再选本地文件）。
   */
  function sources() {
    const out = [];
    const vault = window.LEVault;
    if (vault && typeof vault.list_all === 'function') {
      let list = [];
      try { list = vault.list_all() || []; } catch (err) { list = []; }
      list.forEach(function (ds) {
        if (!ds) return;
        const kind = String(ds.kind || ds.type || '');
        if (kind !== 'imagery' && kind !== 'dem' && kind !== 'raster') return;
        out.push({
          id: 'vault:' + ds.id,
          name: ds.name || ds.id,
          kind: kind,
          vaultId: ds.id,
          bands: ds.bands || null,
          bounds: ds.bounds || null,
          local: false,
        });
      });
    }
    return out;
  }

  /**
   * 载入一个数据源（解码成可重采样的源结构）。
   * @returns {Promise<object>} { ok, src, info }
   */
  async function loadSource(id) {
    const VR = window.LEVaultRaster;
    if (!VR) return { ok: false, error: '栅格解码内核未加载（js/vault-raster.js）' };

    // 本地文件源（由 UI 选文件后塞进来）
    if (id && id.indexOf('file:') === 0) {
      const file = state.localFile;
      if (!file) return { ok: false, error: '没有本地文件' };
      try {
        const src = await VR.decodeRaster(file, {});
        state.activeSourceId = id;
        state.source = src;
        state.sourceInfo = { name: file.name, kind: src.kind, bands: src.bands.length };
        emit('source', state.sourceInfo);
        return { ok: true, src: src, info: state.sourceInfo };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    }

    // 仓库里的数据集：仓库已经把栅格切成瓦片，不再保留原始多波段，
    // 因此只作为「单波段」处理：DEM 直接用 LEDemTiles 采样。
    if (id && id.indexOf('vault:') === 0) {
      const vaultId = id.slice(6);
      const vault = window.LEVault;
      let ds = null;
      try {
        const list = vault.list_all ? (vault.list_all() || []) : [];
        ds = list.find(function (d) { return d && d.id === vaultId; }) || null;
      } catch (err) { ds = null; }
      if (!ds) return { ok: false, error: '数据仓库里找不到这个数据集' };
      state.activeSourceId = id;
      state.source = null;
      state.sourceInfo = {
        name: ds.name || vaultId,
        kind: ds.kind || 'imagery',
        bands: 1,
        vaultId: vaultId,
      };
      emit('source', state.sourceInfo);
      return { ok: true, src: null, info: state.sourceInfo };
    }

    return { ok: false, error: '未知的数据源：' + id };
  }

  /** 由 UI 调用：设置本地文件源。 */
  async function useLocalFile(file) {
    state.localFile = file;
    return loadSource('file:' + (file && file.name ? file.name : 'local'));
  }

  /* ------------------------------------------------------------------ *
   * ② 格网
   * ------------------------------------------------------------------ */

  /**
   * 直接设置格网（跳过重采样）。
   * 供「用现成格网做分类」的场景：外部已经算好了多波段格网时，
   * 或者测试里注入人造格网。
   * @param {object} grid {w,h,west,south,east,north,bands:[{name,data}]}
   */
  function setGrid(grid) {
    state.grid = grid || null;
    emit('grid', state.grid
      ? { w: state.grid.w, h: state.grid.h, bands: state.grid.bands.length }
      : null);
    return state.grid;
  }

  /**
   * 构建多波段格网。
   *
   * 两种输入：
   *   - 有原始栅格（本地 GeoTIFF 等）：用 LEVaultRaster.resampleBands 重采样
   *   - 只有 DEM：用 LEDemTiles 采样高程做单波段
   *
   * @param {object} opts { size, west, south, east, north }
   * @returns {Promise<object>} 格网
   */
  async function buildGrid(opts) {
    opts = opts || {};
    const size = Math.max(32, Math.min(1024, Number(opts.size) || 256));
    const rect = opts.west != null
      ? { west: opts.west, south: opts.south, east: opts.east, north: opts.north }
      : currentViewRect();
    const w = size, h = size;

    if (state.source) {
      const VR = window.LEVaultRaster;
      const res = VR.resampleBands(state.source, {
        width: w, height: h,
        west: rect.west, south: rect.south, east: rect.east, north: rect.north,
      });
      const names = res.bands.map(function (_, i) { return '波段 ' + (i + 1); });
      const grid = {
        w: w, h: h,
        west: rect.west, south: rect.south, east: rect.east, north: rect.north,
        // 像元中心位置约定：'center' = 像元中心落在格网内（重采样路径）
        pixelMode: 'center',
        bands: res.bands.map(function (data, i) { return { name: names[i], data: data }; }),
      };
      state.grid = grid;
      emit('grid', { w: w, h: h, bands: grid.bands.length });
      return grid;
    }

    // DEM 单波段
    if (window.LEDemTiles && typeof window.LEDemTiles.ensureRect === 'function') {
      try {
        await window.LEDemTiles.ensureRect(rect.west, rect.south, rect.east, rect.north);
      } catch (err) { /* ignore */ }
    }
    const data = new Float32Array(w * h);
    const dx = (rect.east - rect.west) / (w - 1);
    const dy = (rect.north - rect.south) / (h - 1);
    for (let row = 0; row < h; row++) {
      const lat = rect.north - row * dy;
      for (let col = 0; col < w; col++) {
        data[row * w + col] = sampleHeight(rect.west + col * dx, lat);
      }
    }
    const grid = {
      w: w, h: h,
      west: rect.west, south: rect.south, east: rect.east, north: rect.north,
      // 像元中心位置约定：'corner' = 角点落在格网内（DEM 采样路径）
      pixelMode: 'corner',
      bands: [{ name: '高程', data: data }],
    };
    state.grid = grid;
    emit('grid', { w: w, h: h, bands: 1 });
    return grid;
  }

  function sampleHeight(lon, lat) {
    if (window.LEDemTiles && window.LEDemTiles.covers && window.LEDemTiles.covers(lon, lat)) {
      const h = window.LEDemTiles.heightAt(lon, lat);
      if (h != null && isFinite(h)) return h;
    }
    const le = getLE();
    if (le && typeof le.heightAt === 'function') {
      const h = le.heightAt(lon, lat);
      if (h != null && isFinite(h)) return h;
    }
    return 0;
  }

  function currentViewRect() {
    const le = getLE();
    const viewer = le && le.viewer;
    if (!viewer) return { west: 116, south: 39, east: 117, north: 40 };
    try {
      const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
      const west = C.Math.toDegrees(r.west);
      const east = C.Math.toDegrees(r.east);
      const south = C.Math.toDegrees(r.south);
      const north = C.Math.toDegrees(r.north);
      if (east > west && north > south &&
          Math.abs(east - west) < 359 && Math.abs(north - south) < 179) {
        return {
          west: Math.max(-180, west), east: Math.min(180, east),
          south: Math.max(-90, south), north: Math.min(90, north),
        };
      }
    } catch (err) { /* fallthrough */ }
    const c = viewer.camera.positionCartographic;
    const lon = C.Math.toDegrees(c.longitude);
    const lat = C.Math.toDegrees(c.latitude);
    return { west: lon - 0.5, east: lon + 0.5, south: lat - 0.5, north: lat + 0.5 };
  }

  /* ------------------------------------------------------------------ *
   * ③ 样本点
   * ------------------------------------------------------------------ */

  function classes() {
    return state.classes.map(function (c) { return Object.assign({}, c); });
  }

  function addClass(name, color) {
    const id = state.classes.length + 1;
    const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
      '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080'];
    state.classes.push({
      id: id,
      name: name || ('类别 ' + id),
      color: color || palette[(id - 1) % palette.length],
    });
    emit('classes', classes());
    return state.classes[state.classes.length - 1];
  }

  function removeClass(id) {
    const i = state.classes.findIndex(function (c) { return c.id === id; });
    if (i < 0) return false;
    state.classes.splice(i, 1);
    // 该类别的样本点也一并去掉，避免出现「无类别」的悬空样本
    state.samples = state.samples.filter(function (s) { return s.classId !== id; });
    if (state.activeClassId === id) {
      state.activeClassId = state.classes.length ? state.classes[0].id : 0;
    }
    emit('samples', samples());
    emit('classes', classes());
    return true;
  }

  function setActiveClass(id) {
    state.activeClassId = Number(id) || state.activeClassId;
    emit('activeClass', state.activeClassId);
  }

  function samples() {
    return state.samples.map(function (s) { return Object.assign({}, s); });
  }

  function addSample(lon, lat, classId) {
    const cid = Number(classId || state.activeClassId) || 1;
    state.sampleSeq++;
    const s = {
      id: 's' + state.sampleSeq,
      lon: Number(lon),
      lat: Number(lat),
      classId: cid,
    };
    state.samples.push(s);
    emit('samples', samples());
    return s;
  }

  function removeSample(id) {
    const before = state.samples.length;
    state.samples = state.samples.filter(function (s) { return s.id !== id; });
    if (state.samples.length !== before) {
      emit('samples', samples());
      return true;
    }
    return false;
  }

  function clearSamples() {
    state.samples = [];
    emit('samples', samples());
  }

  /* ------------------------------------------------------------------ *
   * ④ 运行分类
   * ------------------------------------------------------------------ */

  /** 类别配色（分类图用）。 */
  function classColor(id) {
    const c = state.classes.find(function (x) { return x.id === id; });
    return c ? c.color : '#888888';
  }

  /**
   * 渲染分类图（Canvas → PNG dataURL）。
   * @returns {string} dataURL
   */
  function renderClassImage(classes, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const colorCache = {};
    state.classes.forEach(function (c) {
      const hex = String(c.color || '#888888').replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16) || 128;
      const g = parseInt(hex.slice(2, 4), 16) || 128;
      const b = parseInt(hex.slice(4, 6), 16) || 128;
      colorCache[c.id] = [r, g, b];
    });
    for (let i = 0; i < classes.length; i++) {
      const cid = classes[i];
      const rgb = colorCache[cid] || [40, 40, 40];
      const o = i * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  /**
   * 监督分类。
   * @param {object} opts { method, size }
   * @returns {Promise<object>} { ok, png, bounds, stats, table, confusion }
   */
  async function classify(opts) {
    opts = opts || {};
    if (!RC) throw new Error('栅格分类内核未加载（js/raster-classify.js）');
    const grid = state.grid || await buildGrid({ size: opts.size });
    const samples = state.samples.filter(function (s) {
      return state.classes.some(function (c) { return c.id === s.classId; });
    });
    if (!samples.length) {
      return { ok: false, error: '还没有训练样本点。请先在地图上单击采样。' };
    }
    const usedClasses = state.classes.filter(function (c) {
      return samples.some(function (s) { return s.classId === c.id; });
    });
    if (usedClasses.length < 2) {
      return { ok: false, error: '至少要有 2 个类别各带样本点才能分类。' };
    }

    const method = RC.METHODS.indexOf(opts.method) >= 0 ? opts.method : RC.METHODS[0];
    const model = RC.train(grid, samples, usedClasses, { method: method });
    const cls = RC.classifyGrid(model, grid);
    const conf = RC.evaluate(model, grid, samples);
    const png = renderClassImage(cls.classes, grid.w, grid.h);

    const result = {
      ok: true,
      kind: 'raster',
      method: method,
      png: png,
      bounds: [grid.west, grid.south, grid.east, grid.north],
      classes: cls.classes,
      grid: grid,
      model: model,
      confusion: conf,
      stats: {
        方法: method,
        波段数: grid.bands.length,
        样本点: samples.length,
        有效像元: grid.w * grid.h,
        总体精度: (conf.accuracy * 100).toFixed(1) + '%',
      },
      table: {
        columns: ['类别', '像元数', '占比', '生产者精度', '用户精度', 'F1'],
        rows: usedClasses.map(function (c) {
          const row = cls.table.find(function (t) { return t.classId === c.id; });
          const pc = conf.perClass[conf.ids.indexOf(c.id)];
          const count = row ? row.count : 0;
          return [
            c.name,
            count,
            ((count / (grid.w * grid.h)) * 100).toFixed(1) + '%',
            pc ? (pc.recall * 100).toFixed(1) + '%' : '—',
            pc ? (pc.precision * 100).toFixed(1) + '%' : '—',
            pc ? pc.f1.toFixed(3) : '—',
          ];
        }),
      },
      ms: 0,
    };
    state.lastResult = result;
    emit('result', result);
    return result;
  }

  /**
   * 非监督分类（K-Means）。
   * @param {object} opts { k, size }
   */
  async function kmeans(opts) {
    opts = opts || {};
    if (!RC) throw new Error('栅格分类内核未加载（js/raster-classify.js）');
    const grid = state.grid || await buildGrid({ size: opts.size });
    const k = Math.max(2, Math.min(12, Number(opts.k) || 5));
    const res = RC.kmeans(grid, k, {});
    const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
      '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080'];
    const rgb = res.classes.map(function (_, i) { return palette[i % palette.length]; });
    const png = renderClassImage(res.classes, grid.w, grid.h);
    const result = {
      ok: true,
      kind: 'raster',
      method: 'K-Means',
      png: png,
      bounds: [grid.west, grid.south, grid.east, grid.north],
      classes: res.classes,
      grid: grid,
      stats: {
        方法: 'K-Means（非监督）',
        类别数: k,
        有效像元: res.valid || 0,
      },
      table: {
        columns: ['聚类', '像元数', '占比'],
        rows: res.table.map(function (t, i) {
          return [
            '聚类 ' + (t.classId + 1),
            t.count,
            ((t.count / (grid.w * grid.h)) * 100).toFixed(1) + '%',
          ];
        }),
      },
      colors: rgb,
      ms: 0,
    };
    state.lastResult = result;
    emit('result', result);
    return result;
  }

  /** 把分类结果挂到地球上（影像层）。 */
  async function addResultLayer(result, name) {
    const le = getLE();
    if (!result || !result.png) return null;
    if (!window.LELayers || typeof window.LELayers.addImageOverlay !== 'function') return null;
    return window.LELayers.addImageOverlay(le, {
      url: result.png,
      rectangle: result.bounds,
      name: name || '分类结果',
      credit: '原生分类引擎',
      opacity: 0.85,
    });
  }

  function getState() {
    return {
      sources: sources(),
      activeSourceId: state.activeSourceId,
      grid: state.grid
        ? { w: state.grid.w, h: state.grid.h, bands: state.grid.bands.length }
        : null,
      samples: samples(),
      classes: classes(),
      activeClassId: state.activeClassId,
      lastResult: state.lastResult
        ? { method: state.lastResult.method, stats: state.lastResult.stats }
        : null,
    };
  }

  window.LERasterClassifyShell = {
    init: init,
    on: on,
    off: off,
    sources: sources,
    loadSource: loadSource,
    useLocalFile: useLocalFile,
    buildGrid: buildGrid,
    setGrid: setGrid,
    currentViewRect: currentViewRect,
    classes: classes,
    addClass: addClass,
    removeClass: removeClass,
    setActiveClass: setActiveClass,
    samples: samples,
    addSample: addSample,
    removeSample: removeSample,
    clearSamples: clearSamples,
    classify: classify,
    kmeans: kmeans,
    addResultLayer: addResultLayer,
    classColor: classColor,
    getState: getState,
    METHODS: RC ? RC.METHODS : ['最小距离', '最大似然'],
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

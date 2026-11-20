/*
 * NetCDF 气象栅格叠加 · 装载层（P2-4.11）
 * ---------------------------------------------------------------------------
 * 把一个 .nc 文件读成地球上的气象叠加层：
 *
 *   1. 读文件：浏览器内直接解析（js/netcdf.js），不经后端转换
 *   2. 选要素：变量 / 时刻 / 高度层 / 色带 / 拉伸区间
 *   3. 叠加：渲染成 Cesium 影像图层（栅格），可再叠加风向箭头（矢量）
 *
 * 对外 API：window.LENetCDFShell
 *   openFile(file)            读入并解析 .nc
 *   loadArrayBuffer(buf, name)
 *   setVariable(name)         换要素
 *   setTimeIndex(i) / setLevelIndex(i)
 *   setRamp(name) / setStretch(mode)
 *   apply()                   重新渲染并更新图层
 *   show() / hide() / remove()
 *   getState()
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const NC = window.LENetCDF;
  const R = window.LENetCDFRender;

  const state = {
    le: null,
    dataset: null,
    desc: null,
    fileName: '',
    variable: null,
    timeIndex: 0,
    levelIndex: 0,
    ramp: null,
    stretch: 'auto',
    autoStretch: true,
    layer: null,          // Cesium imagery layer
    entity: null,         // Cesium entity（风矢箭头）
    entry: null,          // 图层管理面板里的条目
    overlay: null,        // SingleTileImageryProvider
    visible: false,
    listeners: [],
    listenersBound: false,
    lastSlice: null,
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
    // 【不要在这里订阅自己的 on】
    //   state.listeners 就是 emit 的分发目标；在 init 里再注册一个转发函数，
    //   等于让 emit('nc') 调用自己 → 无限递归 → 爆栈。
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
   * 读取
   * ------------------------------------------------------------------ */

  /**
   * 读一个 File 对象。
   * @param {File} file
   * @returns {Promise<boolean>} 是否成功
   */
  async function openFile(file) {
    if (!file) return false;
    status('正在读取 ' + file.name + ' …');
    try {
      const buf = await file.arrayBuffer();
      return loadArrayBuffer(buf, file.name);
    } catch (err) {
      toast('读取失败：' + (err && err.message ? err.message : err), 'error');
      status('');
      return false;
    }
  }

  /**
   * 载入已经读好的二进制。
   * @param {ArrayBuffer} buffer
   * @param {string} name
   */
  function loadArrayBuffer(buffer, name) {
    const r = NC.parse(buffer);
    if (!r.ok) {
      toast('不是可用的 NetCDF 文件：' + r.error, 'error', 6000);
      status('');
      emit('nc', { ok: false, error: r.error });
      return false;
    }
    state.dataset = r.dataset;
    state.desc = NC.describe(r.dataset);
    state.fileName = name || 'NetCDF 数据';
    state.timeIndex = 0;
    state.levelIndex = 0;

    // 挑一个默认要素：优先气象要素里最像「温度 / 风」的那个
    const cand = pickDefaultVariable(state.desc);
    state.variable = cand;
    state.ramp = R.defaultRamp(cand ? cand.kind : 'other');
    state.autoStretch = true;

    emit('nc', { ok: true, desc: state.desc });
    status('已载入 ' + state.fileName + '（' +
      state.desc.vars.length + ' 个变量）');
    return true;
  }

  /** 选一个默认要素。 */
  function pickDefaultVariable(desc) {
    const priority = ['temperature', 'wind-u', 'pressure', 'humidity',
      'precipitation', 'wind-speed', 'other'];
    for (const kind of priority) {
      const v = desc.vars.find(function (x) {
        return x.kind === kind && x.spatial && !x.isCoord && x.ok;
      });
      if (v) return v;
    }
    return desc.vars.find(function (x) { return x.spatial && !x.isCoord && x.ok; }) || null;
  }

  /* ------------------------------------------------------------------ *
   * 取切片
   * ------------------------------------------------------------------ */

  function currentSlice() {
    if (!state.dataset || !state.variable) return null;
    const r = NC.slice2d(state.dataset, state.variable.name, {
      timeIndex: state.timeIndex,
      levelIndex: state.levelIndex,
    });
    if (!r.ok) return null;
    state.lastSlice = r;
    return r;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  /**
   * 把当前切片渲染成 RGBA 画布。
   * @returns {null|{canvas, min, max}}
   */
  function renderCanvas() {
    const slice = currentSlice();
    if (!slice) return null;
    // 有符号的分量（U/V）默认用关于 0 对称的拉伸，否则正负分不出来
    const mode = state.stretch === 'auto'
      ? (state.variable && R.isSigned(state.variable.kind) ? 'symmetric' : 'percentile')
      : state.stretch;
    const rg = R.stretchRange(slice.data, mode, 0.02);
    const rgba = R.fieldToRGBA(slice, {
      min: rg.min, max: rg.max, ramp: state.ramp || 'viridis',
    });
    const canvas = document.createElement('canvas');
    canvas.width = rgba.width;
    canvas.height = rgba.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(rgba.width, rgba.height);
    img.data.set(rgba.rgba);
    ctx.putImageData(img, 0, 0);
    return { canvas: canvas, min: rg.min, max: rg.max, slice: slice };
  }

  /**
   * 重新渲染并更新地球上的图层。
   * @returns {boolean}
   */
  function apply() {
    const le = getLE();
    if (!le || !le.viewer) return false;
    if (!state.dataset || !state.variable) return false;

    const rendered = renderCanvas();
    if (!rendered) {
      toast('这个变量没有可用的经纬度网格', 'error');
      return false;
    }

    const bounds = R.boundsOf(rendered.slice);
    if (!bounds) {
      toast('缺少经纬度坐标轴，无法叠加到地球上', 'error');
      return false;
    }

    const dataUrl = rendered.canvas.toDataURL('image/png');
    const rectangle = C.Rectangle.fromDegrees(
      bounds.west, bounds.south, bounds.east, bounds.north);

    // 【不能复用旧的 provider】
    //   SingleTileImageryProvider 一旦创建就把图像冻住了；
    //   换变量/换时刻必须新建 provider 再替换图层。
    const provider = new C.SingleTileImageryProvider({
      url: dataUrl,
      rectangle: rectangle,
      tileWidth: rendered.canvas.width,
      tileHeight: rendered.canvas.height,
      credit: 'NetCDF · ' + state.fileName,
    });

    // 移除旧图层
    if (state.layer) {
      try { le.viewer.imageryLayers.remove(state.layer, true); } catch (e) { /* noop */ }
      state.layer = null;
    }

    state.overlay = provider;
    state.layer = le.viewer.imageryLayers.addImageryProvider(provider);
    state.visible = true;

    // 图层管理条目
    if (state.entry) {
      try {
        state.entry.name = overlayName();
        if (state.entry.imageryLayer) state.entry.imageryLayer = state.layer;
      } catch (e) { /* noop */ }
    } else {
      const entry = le.registerLayer({
        name: overlayName(),
        type: 'imagery',
        imageryLayer: state.layer,
        remove: function () {
          removeLayer();
        },
        zoomTo: function () { le.flyTo({ rectangle: rectangle }); },
        flyTo: function () { le.flyTo({ rectangle: rectangle }); },
      });
      state.entry = entry;
      if (window.LELayerOrder) window.LELayerOrder.addUser(entry);
    }

    emit('nc', { ok: true, applied: true, bounds: bounds });
    status(overlayName() + '（' + state.variable.label + '）');
    return true;
  }

  function overlayName() {
    const parts = ['NetCDF'];
    if (state.variable) parts.push(state.variable.label);
    if (state.desc && state.desc.levels.length > 1) {
      parts.push(state.desc.levels[state.levelIndex].label);
    }
    if (state.desc && state.desc.times.length > 1) {
      parts.push(state.desc.times[state.timeIndex]);
    }
    return parts.join(' · ');
  }

  /* ------------------------------------------------------------------ *
   * 风矢箭头（矢量叠加）
   * ------------------------------------------------------------------ */

  /**
   * 在场上撒风向箭头。
   *
   * 【为什么单独一层】
   *   栅格是「色块」，看不出风往哪吹；箭头补上方向信息，
   *   两者一起才是完整的风场产品（和 QGIS 的符号化叠加一个道理）。
   */
  function showWindArrows(opts) {
    opts = opts || {};
    const le = getLE();
    if (!le || !le.viewer || !state.dataset) return false;

    // 找 U/V 变量
    const u = state.desc.vars.find(function (v) { return v.kind === 'wind-u'; });
    const v = state.desc.vars.find(function (v) { return v.kind === 'wind-v'; });
    if (!u || !v) {
      toast('这个文件里没有成对的 U/V 风场分量', 'error');
      return false;
    }
    const su = NC.slice2d(state.dataset, u.name,
      { timeIndex: state.timeIndex, levelIndex: state.levelIndex });
    const sv = NC.slice2d(state.dataset, v.name,
      { timeIndex: state.timeIndex, levelIndex: state.levelIndex });
    if (!su.ok || !sv.ok) { toast('风场切片失败', 'error'); return false; }

    const arrows = R.sampleArrows(su, sv, { step: opts.step || 8 });
    if (!arrows.length) { toast('这个层上没有有效风矢量', 'error'); return false; }

    const b = R.boundsOf(su);
    if (!b) { toast('风场缺少经纬度轴', 'error'); return false; }
    const lonStep = (b.east - b.west) / Math.max(1, su.width - 1);
    const latStep = (b.north - b.south) / Math.max(1, su.height - 1);
    // 纬度降序（北在前）时，第 0 行在北边
    const latAsc = su.lats && su.lats.length >= 2 && su.lats[0] < su.lats[su.lats.length - 1];

    hideWindArrows();

    const pts = arrows.map(function (a) {
      const lon = b.west + a.x * lonStep;
      const lat = latAsc
        ? b.south + a.y * latStep
        : b.north - a.y * latStep;
      return {
        lon: lon, lat: lat,
        dir: a.toDir,          // 箭头指向（数学角）
        speed: a.speed,
        norm: a.norm,
      };
    });

    state.entity = le.viewer.entities.add({
      name: 'NetCDF 风矢',
      polyline: {
        positions: pts.map(function (p) {
          return C.Cartesian3.fromDegrees(p.lon, p.lat, 0);
        }),
        width: 2,
        material: new C.PolylineArrowMaterialProperty(
          new C.Color(1.0, 0.78, 0.3, 0.95)),
        clampToGround: false,
      },
    });

    emit('nc', { ok: true, arrows: pts.length });
    status('已叠加 ' + pts.length + ' 个风向箭头');
    return true;
  }

  function hideWindArrows() {
    const le = getLE();
    if (state.entity && le && le.viewer) {
      try { le.viewer.entities.remove(state.entity); } catch (e) { /* noop */ }
    }
    state.entity = null;
  }

  /* ------------------------------------------------------------------ *
   * 图层控制
   * ------------------------------------------------------------------ */

  function show() {
    const le = getLE();
    if (!state.layer || !le || !le.viewer) return false;
    state.layer.alpha = 0.75;
    state.visible = true;
    emit('nc', { ok: true, visible: true });
    return true;
  }

  function hide() {
    if (!state.layer) return false;
    state.layer.alpha = 0;
    state.visible = false;
    emit('nc', { ok: true, visible: false });
    return true;
  }

  function removeLayer() {
    const le = getLE();
    if (state.layer && le && le.viewer) {
      try { le.viewer.imageryLayers.remove(state.layer, true); } catch (e) { /* noop */ }
    }
    state.layer = null;
    state.entry = null;
    hideWindArrows();
    emit('nc', { ok: true, removed: true });
  }

  /* ------------------------------------------------------------------ *
   * 设置项
   * ------------------------------------------------------------------ */

  function setVariable(name) {
    const v = state.desc ? state.desc.vars.find(function (x) { return x.name === name; }) : null;
    if (!v) return false;
    state.variable = v;
    state.ramp = R.defaultRamp(v.kind);
    emit('nc', { ok: true, variable: name });
    return true;
  }

  function setTimeIndex(i) {
    if (!state.desc || !state.desc.times.length) return false;
    state.timeIndex = Math.max(0, Math.min(state.desc.times.length - 1, i | 0));
    emit('nc', { ok: true, timeIndex: state.timeIndex });
    return true;
  }

  function setLevelIndex(i) {
    if (!state.desc || !state.desc.levels.length) return false;
    state.levelIndex = Math.max(0, Math.min(state.desc.levels.length - 1, i | 0));
    emit('nc', { ok: true, levelIndex: state.levelIndex });
    return true;
  }

  function setRamp(name) {
    state.ramp = name;
    emit('nc', { ok: true, ramp: name });
    return true;
  }

  function setStretch(mode) {
    state.stretch = mode || 'minmax';
    emit('nc', { ok: true, stretch: state.stretch });
    return true;
  }

  function getState() {
    return {
      loaded: !!state.dataset,
      fileName: state.fileName,
      desc: state.desc,
      variable: state.variable,
      timeIndex: state.timeIndex,
      levelIndex: state.levelIndex,
      ramp: state.ramp,
      stretch: state.stretch,
      visible: state.visible,
      hasLayer: !!state.layer,
      imageryLayer: state.layer,
      entity: state.entity,
      hasArrows: !!state.entity,
    };
  }

  window.LENetCDFShell = {
    init: init,
    openFile: openFile,
    loadArrayBuffer: loadArrayBuffer,
    apply: apply,
    renderCanvas: renderCanvas,
    currentSlice: currentSlice,
    setVariable: setVariable,
    setTimeIndex: setTimeIndex,
    setLevelIndex: setLevelIndex,
    setRamp: setRamp,
    setStretch: setStretch,
    showWindArrows: showWindArrows,
    hideWindArrows: hideWindArrows,
    show: show,
    hide: hide,
    removeLayer: removeLayer,
    getState: getState,
    overlayName: overlayName,
    on: on,
    off: off,
  };
})();

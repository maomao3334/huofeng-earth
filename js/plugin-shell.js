/*
 * 插件式扩展机制 · 外壳（P3-4.17）
 * ---------------------------------------------------------------------------
 * 内核 js/plugins.js 负责注册、校验、沙箱执行；
 * 本文件负责把插件**接进本软件**：
 *
 *   · 把插件的算法清单塞进分析工具箱（和原生算法并列，可搜索、可运行）；
 *   · 跑完之后和原生算法一样把结果挂到地球上（矢量 → 图层，栅格 → 影像层）；
 *   · 插件的安装 / 卸载 / 导入 / 导出（本地 JSON 文件，零外部进程）；
 *   · 本地存储：插件装好后下次启动还在。
 *
 * 关键设计：工具箱拿的是「一份算法清单」。原生算法来自 LEAnalysis，
 * 插件算法来自 LEPlugins。外壳把两份清单**合并**后交给工具箱，
 * 工具箱那边一行都不用改。
 *
 * 对外 API（window.LEPluginShell）：
 *   init(le) / list() / install(json) / uninstall(id) / run(id, params)
 *   runToLayer(id, params) / exportOne(id) / exportAll()
 *   mergeAlgorithms()   ← 工具箱用它拼清单
 *   sample()            ← 内置示例插件源码（给用户当模板）
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'le.plugins';

  const state = {
    le: null,
    loaded: false,
    listeners: [],
  };

  function byId(id) { return document.getElementById(id); }
  function kernel() { return window.LEPlugins; }
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
    for (const fn of state.listeners) {
      try { fn(kind, payload); } catch (err) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------ 持久化 */

  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      return [];
    }
  }

  function writeStore(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------ 安装 */

  /**
   * 安装一个插件（清单对象或 JSON 字符串）。
   * 校验不通过会抛中文错误。
   */
  function install(input) {
    const k = kernel();
    if (!k) throw new Error('插件内核未加载');
    let obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); }
      catch (err) { throw new Error('插件 JSON 解析失败：' + err.message); }
    }
    const v = k.validate(obj);
    if (!v.ok) throw new Error('插件校验失败：' + v.errors.join('；'));
    const stored = k.register(obj);

    const list = readStore().filter((x) => x.id !== stored.id);
    list.push({
      id: stored.id, name: stored.name, version: stored.version, group: stored.group,
      description: stored.description, parameters: stored.parameters,
      source: stored.source, author: stored.author,
    });
    writeStore(list);
    emit('installed', stored);
    refreshToolbox();
    if (v.warnings.length) {
      toast('插件已安装，但有提示：' + v.warnings[0], 'warn', 5000);
    }
    return stored;
  }

  function uninstall(id) {
    const k = kernel();
    if (!k) return false;
    const p = k.get(id);
    if (!p) return false;
    if (p.builtin) throw new Error('内置插件不能卸载');
    k.unregister(id);
    writeStore(readStore().filter((x) => x.id !== id));
    emit('uninstalled', { id: id });
    refreshToolbox();
    return true;
  }

  /** 启动时把上次装好的插件重新注册进来。 */
  function restore() {
    const k = kernel();
    if (!k) return 0;
    let n = 0;
    for (const item of readStore()) {
      try {
        k.register(item);
        n++;
      } catch (err) {
        console.warn('[插件] 恢复失败：' + item.id, err);
      }
    }
    state.loaded = true;
    return n;
  }

  /* ------------------------------------------------------------ 工具箱集成 */

  /**
   * 把插件算法和原生算法合并成一份清单。
   * 工具箱（js/qgis-toolbox.js）优先读这个函数，读不到再退回 LEAnalysis。
   */
  function mergeAlgorithms() {
    const native = window.LEAnalysis && typeof window.LEAnalysis.algorithms === 'function'
      ? window.LEAnalysis.algorithms() : [];
    const k = kernel();
    const plugins = k ? k.list() : [];
    return native.concat(plugins);
  }

  /** 让工具箱重新拉一次清单。 */
  function refreshToolbox() {
    const tb = window.LEQgisToolbox;
    if (!tb) return;
    try {
      if (typeof tb.reloadAlgorithms === 'function') tb.reloadAlgorithms();
      else if (typeof tb.open === 'function' && tb.isOpen && tb.isOpen()) tb.open();
    } catch (err) {
      console.warn('[插件] 刷新工具箱失败', err);
    }
  }

  /* ------------------------------------------------------------ 运行 */

  /**
   * 运行插件并把结果加载为地球图层。
   * 与原生算法完全一致的输出形态。
   */
  async function runToLayer(id, params, opts) {
    opts = opts || {};
    const le = getLE();
    const k = kernel();
    if (!k) throw new Error('插件内核未加载');
    const p = k.get(id);
    if (!p) throw new Error('未找到插件：' + id);

    const startedAt = Date.now();
    const res = await k.run(id, params);
    const ms = Date.now() - startedAt;

    if (res.kind === 'error') {
      throw new Error(res.error || '插件执行失败');
    }
    if (res.kind === 'table') {
      return { result: res, entry: null, ms: ms };
    }
    const name = opts.name || (p.name + ' 结果');

    if (res.kind === 'vector' && res.geojson) {
      const blob = new Blob([JSON.stringify(res.geojson)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      try {
        if (window.LEImports && typeof window.LEImports.importGeoJsonUrl === 'function') {
          const entry = await window.LEImports.importGeoJsonUrl(le, url, name);
          return { result: res, entry: entry, ms: ms };
        }
        throw new Error('GeoJSON 导入通道不可用');
      } finally {
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      }
    }
    if (res.kind === 'raster' && res.png) {
      if (window.LELayers && typeof window.LELayers.addImageOverlay === 'function') {
        const entry = window.LELayers.addImageOverlay(le, {
          url: res.png,
          rectangle: res.bounds,
          name: name,
          credit: '插件：' + p.name,
          opacity: opts.opacity != null ? opts.opacity : 0.85,
        });
        return { result: res, entry: entry, ms: ms };
      }
      throw new Error('影像图层通道不可用');
    }
    throw new Error('无法识别的结果类型：' + res.kind);
  }

  /* ------------------------------------------------------------ 导出 */

  function exportOne(id) {
    const k = kernel();
    if (!k) throw new Error('插件内核未加载');
    return k.exportOne(id);
  }

  function exportAll() {
    const k = kernel();
    if (!k) throw new Error('插件内核未加载');
    return k.exportAll();
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ------------------------------------------------------------ 示例插件 */

  /**
   * 内置示例插件：给用户当模板。
   * 演示怎么读 DEM、怎么拿矢量、怎么返回矢量结果。
   */
  const SAMPLE_PLUGIN = {
    id: 'demo.elevation-profile',
    name: '示例 · 沿线高程剖面',
    version: '1.0.0',
    group: '示例插件',
    builtin: true,
    description: '沿一条线要素采样 DEM 高程，输出剖面表格与折线（演示插件怎么用 ctx.dem 与 ctx.vector）',
    parameters: [
      { name: 'INPUT', type: 'vector', description: '输入线要素' },
      { name: 'STEP_M', type: 'number', default: 200, description: '采样步长（米）' },
    ],
    source: [
      'function run(params, ctx) {',
      '  var feat = ctx.vector.byId(params.INPUT);',
      '  if (!feat) {',
      '    return { kind: "table", table: { columns: ["提示"], rows: [["没有可用的线要素"]] } };',
      '  }',
      '  var pts = feat.points || [];',
      '  if (pts.length < 2) {',
      '    return { kind: "table", table: { columns: ["提示"], rows: [["线要素至少要两个点"]] } };',
      '  }',
      '  var rows = [];',
      '  var coords = [];',
      '  for (var i = 0; i < pts.length - 1; i++) {',
      '    var a = pts[i], b = pts[i + 1];',
      '    var dlon = b.lon - a.lon, dlat = b.lat - a.lat;',
      '    var distM = Math.sqrt(dlon * dlon * 85000 + dlat * dlat * 111000);',
      '    var n = Math.max(1, Math.round(distM / Math.max(1, params.STEP_M || 200)));',
      '    for (var s = 0; s < n; s++) {',
      '      var t = s / n;',
      '      var lon = a.lon + dlon * t, lat = a.lat + dlat * t;',
      '      var h = ctx.dem.heightAt(lon, lat);',
      '      rows.push([i, +(distM * t).toFixed(0), +(h == null ? 0 : h).toFixed(1)]);',
      '      coords.push([lon, lat]);',
      '    }',
      '  }',
      '  var last = pts[pts.length - 1];',
      '  var lh = ctx.dem.heightAt(last.lon, last.lat);',
      '  rows.push([pts.length - 2, 0, +(lh == null ? 0 : lh).toFixed(1)]);',
      '  coords.push([last.lon, last.lat]);',
      '  return {',
      '    kind: "table",',
      '    stats: { 采样点数: rows.length, DEM 覆盖: ctx.dem.covers(pts[0].lon, pts[0].lat) ? "是" : "否" },',
      '    table: { columns: ["段号", "里程（米）", "高程（米）"], rows: rows },',
      '  };',
      '}',
    ].join('\n'),
  };

  /* ------------------------------------------------------------ 初始化 */

  function init(le) {
    state.le = le;
    const k = kernel();
    if (!k) return;
    const n = restore();
    // 示例插件始终可用（builtin，不能卸载）
    try { k.register(SAMPLE_PLUGIN); } catch (err) { /* ignore */ }
    state.loaded = true;
    emit('ready', { restored: n });
  }

  window.LEPluginShell = {
    init: init,
    install: install,
    uninstall: uninstall,
    restore: restore,
    list: function () { return kernel() ? kernel().list() : []; },
    get: function (id) { return kernel() ? kernel().get(id) : null; },
    run: function (id, params) { return kernel().run(id, params); },
    runToLayer: runToLayer,
    mergeAlgorithms: mergeAlgorithms,
    refreshToolbox: refreshToolbox,
    exportOne: exportOne,
    exportAll: exportAll,
    download: download,
    sample: function () { return JSON.parse(JSON.stringify(SAMPLE_PLUGIN)); },
    on: function (fn) { if (typeof fn === 'function') state.listeners.push(fn); },
    off: function (fn) {
      state.listeners = state.listeners.filter(function (f) { return f !== fn; });
    },
  };
})();

/*
 * 本地地球 Local Earth — 应用入口
 * 职责：创建 Cesium Viewer、加载本地公版底图/示例数据、提供全局 LE 接口、
 *       初始化各功能模块（layers / importers / tools / ui）。
 * 离线约束：所有资源使用相对路径，由本地 serve.ps1 提供；页面 CSP 禁止外部请求。
 */
(function () {
  'use strict';

  const C = window.Cesium;
  if (!C) {
    document.getElementById('status-text').textContent = 'CesiumJS 加载失败：请确认 vendor/cesium 完整。';
    return;
  }

  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  const state = {
    layers: new Map(),
    ready: false,
    baseLayerReady: false,
    samples: { countries: null, places: null },
  };

  /* ------------------------------ UI 基础 ------------------------------ */

  let toastTimer = null;
  function toast(message, kind, ms) {
    const el = byId('toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.remove('hidden', 'error', 'ok');
    if (kind) el.classList.add(kind);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 3200);
  }

  function status(message, kind) {
    const el = byId('status-text');
    if (!el) return;
    el.textContent = message;
    if (kind === 'error') el.style.color = 'var(--danger)';
    else el.style.color = '';
  }

  function setLoading(show, text) {
    const el = byId('loading');
    if (!el) return;
    if (show) byId('loading-text').textContent = text || '正在加载…';
    el.classList.toggle('hidden', !show);
  }

  let coordRaf = 0;
  function setCoords(lon, lat, height) {
    if (coordRaf) return;
    coordRaf = requestAnimationFrame(() => {
      coordRaf = 0;
      const el = byId('coords-text');
      if (!el) return;
      const fmt = (v) => (v == null || !isFinite(v) ? '--' : v.toFixed(6));
      const fmtH = (h) => {
        if (h == null || !isFinite(h)) return '--';
        return Math.abs(h) >= 1000 ? (h / 1000).toFixed(2) + ' km' : h.toFixed(0) + ' m';
      };
      el.textContent = '纬度 ' + fmt(lat) + '　经度 ' + fmt(lon) + '　高度 ' + fmtH(height);
      el.dataset.lon = lon == null ? '' : String(lon);
      el.dataset.lat = lat == null ? '' : String(lat);
      el.dataset.height = height == null ? '' : String(height);
    });
  }

  /* ---------------------------- Viewer 初始化 ---------------------------- */

  const viewer = new C.Viewer('viewer', {
    baseLayer: false,
    terrainProvider: new C.EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
    requestRenderMode: false,
    contextOptions: { webgl: { alpha: false, antialias: true } },
  });

  const scene = viewer.scene;

  // 渲染循环异常时把完整堆栈打到控制台，便于定位（Cesium 默认只弹面板）
  try {
    scene.renderError.addEventListener(function (sc, error) {
      console.error('[Cesium renderError]', error && (error.stack || error.message || error));
    });
  } catch (err) {
    console.warn('renderError 监听失败', err);
  }

  scene.globe.baseColor = C.Color.fromCssColorString('#0a1622');
  scene.globe.showGroundAtmosphere = true;
  scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;
  // 【地形浮雕光照】globe.enableLighting 是 Cesium 编译 ENABLE_VERTEX_LIGHTING /
  // ENABLE_DAYNIGHT_SHADING 的总闸门。写死 false 会让逐顶点地形法线算了却没人用，
  // 地形完全不受光（用户看到的「只有高画质才有 3D、沟壑丘陵是平的」就是这个原因）。
  // 这里不再强制关掉：由 js/terrain-relief.js 统一接管
  // （3D 地形开启时开、关闭时关，并与「实时光照」模块协商光源方向）。
  // Cesium 的 Globe 默认值本来就是 false，未加载 relief 模块时行为不变。
  scene.globe.enableLighting = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 30;
  scene.screenSpaceCameraController.maximumZoomDistance = 5.0e7;

  /** 本地底图：NASA Blue Marble（公有领域），不访问网络。
   *  优先使用本地 XYZ 瓦片（z0–z5，21600×10800 高清来源），失败回退单幅 5400×2700。
   *
   *  【必须把 ImageryLayer 注册进图层栈】
   *  之前这里 addImageryProvider() 的返回值被丢掉了，于是底图对
   *  LELayerOrder 完全不可见：adoptOrphans() 认不出它，它也就没有 orderKind，
   *  栈序由 Cesium 的插入时刻决定，可能浮到用户导入层之上，把导入的
   *  影像整片盖掉。现在返回的图层会注册为 system 层，类别 'base'，
   *  由 LELayerOrder 钉死在最底。
   */
  function addLocalBaseImage() {
    try {
      const tiled = new C.UrlTemplateImageryProvider({
        url: 'data/public/tiles/blue-marble/{z}/{x}/{y}.jpg',
        minimumLevel: 0,
        maximumLevel: 5,
        credit: 'NASA Blue Marble (public domain)',
      });
      const layer = viewer.imageryLayers.addImageryProvider(tiled);
      registerBaseLayer(layer, '本地底图·NASA 蓝马赛克（离线）');
      state.baseLayerReady = true;
      state.baseLayerKind = 'tiles';
      return;
    } catch (err) {
      console.warn('高清瓦片底图不可用，回退单幅底图', err);
    }
    try {
      const provider = new C.SingleTileImageryProvider({
        url: 'data/samples/world.topo.bathy.200412.3x5400x2700.jpg',
        rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90),
        tileWidth: 5400,
        tileHeight: 2700,
        credit: 'NASA Blue Marble (public domain)',
      });
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      registerBaseLayer(layer, '本地底图·NASA 蓝马赛克（单幅）');
      state.baseLayerReady = true;
      state.baseLayerKind = 'single';
    } catch (err) {
      console.error(err);
      status('本地底图加载失败：' + err.message, 'error');
    }
  }

  /** 把底图图层登记进图层栈并钉在最底。 */
  function registerBaseLayer(layer, name) {
    if (!layer) return;
    try {
      const entry = layerApi({
        name,
        type: 'imagery',
        system: true,
        visible: true,
        imageryLayer: layer,
        remove: () => viewer.imageryLayers.remove(layer, true),
      });
      if (window.LELayerOrder) window.LELayerOrder.addSystem(entry, 'base');
    } catch (err) {
      console.warn('底图图层登记失败', err);
    }
  }

  /* ------------------------------- 图层注册 ------------------------------- */

  function layerApi(desc) {
    const entry = Object.assign(
      {
        id: desc.id || 'layer-' + Math.random().toString(36).slice(2, 9),
        name: desc.name || '未命名图层',
        type: desc.type || 'overlay',
        system: !!desc.system,
        visible: desc.visible !== false,
        zoomTo:
          desc.zoomTo ||
          (typeof desc.flyTo === 'function' ? () => desc.flyTo() : undefined),
        remove:
          desc.remove ||
          (() => {
            if (desc.datasource) viewer.dataSources.remove(desc.datasource, true);
            if (desc.imageryLayer) viewer.imageryLayers.remove(desc.imageryLayer, true);
            if (desc.primitive) viewer.entities.removeAll();
          }),
      },
      desc
    );

    entry.setVisible = function (on) {
      entry.visible = !!on;
      if (entry.datasource) entry.datasource.show = entry.visible;
      if (entry.imageryLayer) entry.imageryLayer.show = entry.visible;
      if (entry.onVisible) entry.onVisible(entry.visible);
      refreshLayers();
    };

    entry.setOpacity = function (alpha) {
      if (entry.imageryLayer) entry.imageryLayer.alpha = Math.max(0, Math.min(1, alpha));
    };

    state.layers.set(entry.id, entry);
    if (entry.datasource && entry.visible === false) entry.datasource.show = false;
    refreshLayers();
    return entry;
  }

  function removeLayer(id) {
    const entry = state.layers.get(id);
    if (!entry) return;
    try {
      entry.remove();
    } catch (err) {
      console.error(err);
    }
    state.layers.delete(id);
    refreshLayers();
  }

  function listLayers() {
    return Array.from(state.layers.values());
  }

  function refreshLayers() {
    if (window.LEUI && typeof window.LEUI.refreshLayers === 'function') {
      window.LEUI.refreshLayers(listLayers());
    }
  }

  /* ------------------------------ 视角与选择 ------------------------------ */

  function flyTo(target) {
    if (!target) return;
    if (target.rectangle) {
      viewer.camera.flyTo({ destination: target.rectangle, duration: 1.6 });
      return;
    }
    if (target instanceof C.Entity) {
      viewer.flyTo(target, { duration: 1.6 }).catch(() => {});
      return;
    }
    if (target.datasource) {
      viewer.flyTo(target.datasource, { duration: 1.6 }).catch(() => {});
      return;
    }
    const height = target.height != null ? target.height : 2500;
    const dest = C.Cartesian3.fromDegrees(target.longitude, target.latitude, height);
    const orientation = target.heading != null
      ? {
          heading: C.Math.toRadians(target.heading || 0),
          pitch: C.Math.toRadians(target.pitch || -90),
          roll: 0,
        }
      : undefined;
    viewer.camera.flyTo({ destination: dest, orientation, duration: target.duration || 1.6 });
  }

  function flyHome() {
    viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(105, 32, 2.0e7),
      duration: 1.4,
    });
  }

  let is2D = false;
  function toggle2D() {
    is2D = !is2D;
    if (is2D) scene.morphTo2D(1.0);
    else scene.morphTo3D(1.0);
    const btn = byId('btn-2d');
    if (btn) btn.textContent = is2D ? '3D' : '2D';
  }

  let selectedEntity = null;
  function selectEntity(entity) {
    selectedEntity = entity;
    if (!entity) return;
    const name = entity.name || '未命名地物';
    status('已选择：' + name);
    if (window.LEUI && typeof window.LEUI.showInfo === 'function') {
      window.LEUI.showInfo(entity);
    }
  }

  /* ---------------------------- 文件与拖放 ---------------------------- */

  function openFileDialog() {
    const input = byId('file-input');
    if (input) input.click();
  }

  function currentApi() {
    return window.LE;
  }

  /* ------------------------------- 示例数据 ------------------------------- */

  async function loadSampleVectors() {
    try {
      const countries = await C.GeoJsonDataSource.load(
        'data/samples/ne_110m_admin_0_countries.geojson',
        {
          stroke: C.Color.fromCssColorString('#7fb2e5').withAlpha(0.85),
          strokeWidth: 1.2,
          fill: false,
          clampToGround: false,
        }
      );
      if (window.LEImports && typeof LEImports.sanitizeDataSource === 'function') {
        LEImports.sanitizeDataSource(countries);
      }
      // 国界只描边：显式关闭 polygon 填充，避免低画质/无地形时 GeoJSON 默认白色面盖住底图
      try {
        const ents = countries.entities.values;
        for (let i = 0; i < ents.length; i++) {
          const polygon = ents[i].polygon;
          if (!polygon) continue;
          polygon.fill = false;
          polygon.material = C.Color.TRANSPARENT;
          polygon.outline = true;
        }
      } catch (err) {
        /* ignore */
      }
      countries.name = '国界（Natural Earth）';
      viewer.dataSources.add(countries);
      state.samples.countries = countries;
      // 【贴地】110m 国界是以**多边形**加载的，Cesium 会把它画在高度 0（海平面），
      // 在高原边境上与真实地形差出上百像素（用户报「国界线偏了」）。
      // 地形数据源此时还没初始化（boot() 里 LETerrain.init 在本函数之后），
      // 所以这里先登记、地形就绪后再由 drapeSampleBorders() 转成贴地折线。
      state.samples.countriesDraped = false;
      layerApi({
        id: 'sample-countries',
        name: '国界 · Natural Earth',
        type: 'vector',
        datasource: countries,
        zoomTo: undefined,
        remove: () => viewer.dataSources.remove(countries, true),
      });
    } catch (err) {
      console.error(err);
      toast('国界数据加载失败：' + err.message, 'error', 4200);
    }
  }

  /**
   * 把 110m「国界（Natural Earth）」层转成贴地折线。
   *
   * 【为什么需要】
   *   这层是以多边形加载的，Cesium 把多边形画在高度 0（海平面）。在高原边境
   *   （地面 3819 m）上，相机高 6000 m / 俯角 −30° 时这个高度差对应约
   *   **196 px** 的屏幕视差 —— 用户看到的就是「国界线偏了」。
   *   10m 层已经转成贴地折线，两层同时显示、位置却差 196 px。
   *
   * 【为什么延后到地形就绪后】
   *   boot() 里 loadSampleVectors() 在 LETerrain.init() **之前**执行，
   *   那时没有地形数据源，任何贴地高度都取到 0。
   */
  function drapeSampleBorders() {
    const ds = state.samples.countries;
    if (!ds || state.samples.countriesDraped) return 0;
    if (!window.LEImports || typeof LEImports.drapeDataSourceToTerrain !== 'function') return 0;
    try {
      const n = LEImports.drapeDataSourceToTerrain(ds, {
        color: C.Color.fromCssColorString('#7fb2e5').withAlpha(0.85),
        width: 1.2,
        sampler: 'analytic',
        // 顶点数少（几千），瓦片就绪后用渲染网格重算一次，
        // 让线严格贴合用户看到的地形面（解析 DEM 与渲染面可差 ~135 m）。
        redrape: 'settle',
      });
      state.samples.countriesDraped = true;
      console.debug('[main] 110m 国界已贴地：' + n + ' 条折线');
      return n;
    } catch (err) {
      console.warn('[main] 110m 国界贴地失败', err);
      return 0;
    }
  }

  /**
   * 地形就绪 / DEM 到位后，重新贴地国界。
   *
   * 【为什么需要两段】
   *   1. 地形瓦片就绪（tileLoadProgressEvent 归零）→ 用**渲染网格**重算，
   *      因为解析 DEM 与 Cesium 实际渲染的地形面最大可差 ~135 m（分块 DEM
   *      边界附近最明显）。网格采样才与用户看到的起伏完全一致。
   *   2. DEM 塔是**异步加载**的：boot() 里贴地时全国金字塔索引刚建、瓦片还在
   *      下载，此时 heightAt 全返回 0，线被贴在海平面（高度 2 m = 0 + 抬升）。
   *      必须有一个巡检循环，等 DEM 到位后把线抬到真正的地面。
   *
   * 【节流】地形是流式加载的，一次启动会「就绪」十几次；每次全量重贴地
   *   会造成明显卡顿，所以最短间隔 5 s；巡检用 8 个探针顶点做变更检测，
   *   没变就不动。
   */
  function bindBorderRedrapeOnSettle() {
    const globe = viewer.scene && viewer.scene.globe;
    if (!globe) return;
    let settled = false;
    let timer = null;
    let lastAt = 0;
    const MIN_INTERVAL = 5000;

    const runMesh = function () {
      if (!state.samples.countriesDraped) return;
      if (!window.LEImports || typeof LEImports.redrapeDrapedDataSources !== 'function') return;
      try {
        const n = LEImports.redrapeDrapedDataSources('settle', 'mesh');
        if (n) console.debug('[main] 国界按渲染网格重新贴地：' + n + ' 条折线');
      } catch (err) {
        console.debug('[main] 国界重贴地失败', err);
      }
    };

    const onSettled = function () {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, lastAt + MIN_INTERVAL - performance.now());
      timer = setTimeout(function () {
        timer = null;
        lastAt = performance.now();
        runMesh();
      }, Math.max(800, wait));
    };

    const onProgress = function (e) {
      if (e && e.queueLength) settled = false;
      else onSettled();
    };

    try {
      globe.tileLoadProgressEvent.addEventListener(onProgress);
    } catch (err) {
      console.debug('[main] 地形就绪监听失败', err);
    }

    // DEM 异步到位巡检：探针高度变了就重算（8 个探针，开销可忽略）
    const tick = function () {
      if (state.samples.countriesDraped && window.LEImports &&
          typeof LEImports.tickDrapedDataSources === 'function') {
        try {
          const changed = LEImports.tickDrapedDataSources(2);
          if (changed) console.debug('[main] DEM 到位，重新贴地 ' + changed + ' 组国界');
        } catch (err) {
          /* ignore */
        }
      }
    };
    state.borderTickTimer = setInterval(tick, 1500);
  }

  /**
   * 地形 Provider 重建（夸张系数变化）后重算**所有**已登记的贴地图元。
   *
   * 【为什么在 main.js 里包装而不是改 js/terrain.js】
   *   js/terrain.js 由另一个会话维护，改动容易互相覆盖。这里用包装的方式
   *   挂钩子：不动对方文件，只在外部补一层回调。
   *
   * 重建 Provider 后地形高度整体变了（夸张系数生效），贴地要素必须跟着变，
   * 否则夸张到 2× 时线会贴在 1× 的高度上、沉进山体。
   */
  function bindBorderRedrapeOnRebuild() {
    const T = window.LETerrain;
    if (!T || typeof T.setExaggeration !== 'function') return;
    if (T.__leRedrapeHooked) return;
    const orig = T.setExaggeration;
    T.setExaggeration = function (value) {
      const r = orig.apply(this, arguments);
      // setExaggeration 内部是节流重建（EXAG_REBUILD_DELAY），延迟后重算
      setTimeout(function () {
        if (!window.LEImports || typeof LEImports.redrapeDrapedDataSources !== 'function') return;
        try {
          const n = LEImports.redrapeDrapedDataSources('rebuild', 'analytic');
          if (n) console.debug('[main] 地形重建后重新贴地：' + n + ' 条折线');
        } catch (err) {
          console.debug('[main] 重建后重贴地失败', err);
        }
      }, 600);
      return r;
    };
    T.__leRedrapeHooked = true;
  }

  async function loadSamplePlaces() {
    try {
      const places = await C.GeoJsonDataSource.load(
        'data/samples/ne_110m_populated_places_simple.geojson',
        { markerSize: 0, clampToGround: false }
      );
      if (window.LEImports && typeof LEImports.sanitizeDataSource === 'function') {
        LEImports.sanitizeDataSource(places);
      }
      places.show = false;
      places.name = '地名索引（Natural Earth）';
      await viewer.dataSources.add(places);
      state.samples.places = places;
    } catch (err) {
      console.warn('地名索引加载失败', err);
    }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  function bindViewerEvents() {
    const handler = new C.ScreenSpaceEventHandler(scene.canvas);

    handler.setInputAction((movement) => {
      if (window.LE && window.LE.state.measureActive) return;
      const picked = scene.pick(movement.position);
      if (picked && picked.id instanceof C.Entity) {
        selectEntity(picked.id);
      }
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((movement) => {
      const ray = viewer.camera.getPickRay(movement.endPosition);
      const pos = ray ? scene.globe.pick(ray, scene) : null;
      if (pos) {
        const carto = C.Cartographic.fromCartesian(pos);
        setCoords(
          C.Math.toDegrees(carto.longitude),
          C.Math.toDegrees(carto.latitude),
          carto.height
        );
      } else {
        setCoords(null, null, null);
      }
    }, C.ScreenSpaceEventType.MOUSE_MOVE);

    byId('coords-text').addEventListener('click', () => {
      const el = byId('coords-text');
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(
          () => toast('坐标已复制', 'ok'),
          () => toast('复制失败', 'error')
        );
      }
    });

    // 相机位置（帮助定位问题，也让用户知道当前视点高度）
    const updateCameraText = () => {
      const carto = viewer.camera.positionCartographic;
      if (!carto) return;
      const lon = C.Math.toDegrees(carto.longitude).toFixed(4);
      const lat = C.Math.toDegrees(carto.latitude).toFixed(4);
      const h = carto.height;
      const hs = Math.abs(h) >= 1000 ? (h / 1000).toFixed(1) + ' km' : h.toFixed(0) + ' m';
      const el = byId('camera-text');
      if (el) el.textContent = '相机 ' + lat + ', ' + lon + ' · ' + hs;
    };
    viewer.camera.changed.addEventListener(updateCameraText);
    updateCameraText();
  }

  function bindChromeEvents() {
    byId('btn-open').addEventListener('click', openFileDialog);
    byId('btn-home').addEventListener('click', flyHome);
    byId('btn-2d').addEventListener('click', toggle2D);
    byId('btn-help').addEventListener('click', () => window.LEUI && window.LEUI.toggleHelp(true));
    byId('btn-qgis').addEventListener('click', () => window.LEQgisToolbox && window.LEQgisToolbox.toggle());
    const btnPlugin = byId('btn-plugin');
    if (btnPlugin) {
      btnPlugin.addEventListener('click', () => window.LEPluginUI && window.LEPluginUI.toggle());
    }
    byId('help-close').addEventListener('click', () => window.LEUI && window.LEUI.toggleHelp(false));
    byId('btn-goto').addEventListener('click', () => window.LEUI && window.LEUI.promptGoto());
    byId('btn-measure-distance').addEventListener('click', () =>
      window.LETools && window.LETools.startMeasure('distance')
    );
    byId('btn-measure-area').addEventListener('click', () =>
      window.LETools && window.LETools.startMeasure('area')
    );
    byId('btn-measure-angle').addEventListener('click', () =>
      window.LETools && window.LETools.startMeasure('angle')
    );
    byId('btn-measure-elevation').addEventListener('click', () =>
      window.LETools && window.LETools.startMeasure('elevation')
    );
    byId('btn-clear-measure').addEventListener('click', () =>
      window.LETools && window.LETools.clearMeasure()
    );

    const input = byId('file-input');
    input.addEventListener('change', () => {
      if (window.LEImports) window.LEImports.importFiles(input.files);
      input.value = '';
    });

    const folderBtn = byId('btn-open-folder');
    const folderInput = byId('folder-input');
    if (folderBtn && folderInput) {
      folderBtn.addEventListener('click', () => folderInput.click());
      folderInput.addEventListener('change', () => {
        if (window.LEImports && folderInput.files.length) {
          window.LEImports.importFiles(folderInput.files);
        }
        folderInput.value = '';
      });
    }

    const impReportBtn = byId('btn-import-report');
    if (impReportBtn) {
      impReportBtn.addEventListener('click', () => {
        if (window.LEImportReport) window.LEImportReport.toggle();
      });
    }

    window.addEventListener('error', (ev) => {
      console.error(ev.error || ev.message);
      status('发生错误：' + (ev.message || '未知'), 'error');
    });
    window.addEventListener('unhandledrejection', (ev) => {
      console.error(ev.reason);
    });
  }

  /* ------------------------------- 全局 API ------------------------------- */

  const LE = {
    Cesium: C,
    viewer,
    scene,
    state,
    status,
    setStatus: (text) => status(text),
    toast,
    setLoading,
    setCoords,
    flyTo,
    flyHome,
    toggle2D,
    selectEntity,
    openFileDialog,
    registerLayer: layerApi,
    removeLayer,
    listLayers,
    refreshLayers,
    getSelected: () => selectedEntity,
    hasGeoTiff: () => !!window.GeoTIFF,
    // 本地 3D 地形高度（米）；未启用地形时返回 0，供 KML 贴地渲染使用
    heightAt: (lon, lat) =>
      window.LETerrain && window.LETerrain.isEnabled() ? window.LETerrain.heightAt(lon, lat) : 0,
    isTerrainEnabled: () => !!(window.LETerrain && window.LETerrain.isEnabled()),
  };

  window.LE = LE;

  function initModules() {
    const order = [
      ['LEOnlineStatus', 'init'],
      ['LELayers', 'init'],
      ['LEImports', 'init'],
      ['LETools', 'init'],
      ['LEUI', 'init'],
      ['LEQgisToolbox', 'init'],
      ['LEModels', 'init'],
      ['LEModelsUI', 'init'],
      ['LETiles3DShell', 'init'],
      ['LETiles3DUI', 'init'],
      ['LETimelineShell', 'init'],
      ['LETimelineUI', 'init'],
      ['LETourShell', 'init'],
      ['LETourUI', 'init'],
      ['LENetCDFShell', 'init'],
      ['LENetCDFUI', 'init'],
      ['LEPluginShell', 'init'],
      ['LEPluginUI', 'init'],
    ];
    for (const [name, fn] of order) {
      const mod = window[name];
      if (mod && typeof mod[fn] === 'function') {
        try {
          mod[fn](LE);
        } catch (err) {
          console.error('模块初始化失败：' + name, err);
          toast('模块初始化失败：' + name, 'error', 4000);
        }
      }
    }
  }

  async function boot() {
    setLoading(true, '正在加载本地底图…');
    addLocalBaseImage();
    bindChromeEvents();
    bindViewerEvents();
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(105, 32, 2.0e7),
    });

    const versionEl = byId('help-version');
    if (versionEl) {
      versionEl.textContent =
        '版本 0.1.0 · CesiumJS ' + (C.VERSION || '1.146') + ' · 数据全部本地读取';
    }

    await Promise.all([loadSampleVectors(), loadSamplePlaces()]);

    // 性能调度器在挂载前先探测设备，并让地形延迟加载东亚/全球大源，启动更快
    if (window.LEPerf && typeof window.LEPerf.preboot === 'function') {
      try {
        window.LEPerf.preboot();
      } catch (err) {
        console.warn('[main] 性能预探测失败', err);
      }
    }

    // 3D 地形：在导入 KML 之前加载，这样 relativeToGround/clampToGround 的箭头能贴合地形
    if (window.LETerrain && typeof window.LETerrain.init === 'function') {
      try {
        await window.LETerrain.init(LE);
      } catch (err) {
        console.error('[main] 3D 地形初始化失败', err);
      }
    }

    // 国界贴地：必须在地形初始化**之后**（此前没有地形数据源，高度全是 0）
    drapeSampleBorders();
    bindBorderRedrapeOnSettle();
    bindBorderRedrapeOnRebuild();

    initModules();

    // 挂上性能调度器（探测设备、应用档位、实时帧率自动降级）
    if (window.LEPerf && typeof window.LEPerf.init === 'function') {
      try {
        window.LEPerf.init(LE);
      } catch (err) {
        console.warn('[main] 性能调度器初始化失败', err);
      }
    }

    // 底图/矢量/地形基础已就绪：先关闭全屏加载层，让界面可交互；后续数据加载走状态栏进度
    setLoading(false);
    status('就绪 · 正在按需加载数据…');

    const params = new URLSearchParams(location.search);

    // ?demo=<本地相对路径>：启动后自动加载示例数据（便于演示与自动化验证）
    const demo = params.get('demo');
    if (demo && window.LEImports && typeof window.LEImports.importUrl === 'function') {
      try {
        await window.LEImports.importUrl(demo);
      } catch (err) {
        console.error(err);
        toast('演示数据加载失败：' + err.message, 'error', 5000);
      }
    }

    // ?tiles=<本地 XYZ 模板>：例如 data/samples/tiles/{z}/{x}/{y}.png
    const tiles = params.get('tiles');
    if (tiles) {
      try {
        window.LELayers.addXyzTemplate(LE, { name: '本地瓦片', template: tiles });
      } catch (err) {
        console.error(err);
        toast('本地瓦片加载失败：' + err.message, 'error', 5000);
      }
    }

    // ?dem=<本地阴影图>&demBounds=w,s,e,n ：例如 data/public/dem/N25E102-hillshade.png
    const dem = params.get('dem');
    if (dem) {
      try {
        const bounds = (params.get('demBounds') || '102,25,103,26')
          .split(',')
          .map(Number);
        window.LELayers.addImageOverlay(LE, {
          name: '本地 DEM 阴影',
          url: dem,
          rectangle: bounds,
          opacity: 0.9,
          visible: params.get('demVisible') !== '0',
          orderKind: 'hillshade',
        });
      } catch (err) {
        console.error(err);
        toast('DEM 阴影加载失败：' + err.message, 'error', 5000);
      }
    }

    // ?cam=lon,lat,height[,pitch] ：可选，启动后定位相机（便于分享视角/自动化截图）
    const cam = params.get('cam');
    if (cam) {
      try {
        const parts = cam.split(',').map(Number);
        if (parts.length >= 3 && parts.every((v) => isFinite(v))) {
          viewer.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(parts[0], parts[1], parts[2]),
            orientation: {
              heading: 0,
              pitch: C.Math.toRadians(parts.length >= 4 ? parts[3] : -45),
              roll: 0,
            },
            duration: 0,
          });
        }
      } catch (err) {
        console.warn('相机参数解析失败', err);
      }
    }

    state.ready = true;
    setLoading(false);
    status('就绪 · 完全离线运行（拖放数据或点击“打开数据”）');
    setCoords(null, null, null);
    document.dispatchEvent(new CustomEvent('local-earth-ready', { detail: LE }));
  }

  boot().catch((err) => {
    console.error(err);
    setLoading(false);
    status('启动失败：' + err.message, 'error');
    toast('启动失败：' + err.message, 'error', 6000);
  });
})();

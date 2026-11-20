/*
 * 本地地球 · 性能调度器（LEPerf）
 * - 自动探测设备性能（GPU/核心数/内存/移动端），选择 高画质 / 均衡 / 流畅
 * - 自动根据实时帧率降级，避免开项目后浏览卡死
 * - 提供手动切换（性能按钮）、?perf=auto|high|medium|low、localStorage 记忆
 * - 调用地形（LETerrain.setQuality）与 KML 点云（LEKml.setQuality）降载接口
 */
(function () {
  'use strict';

  const MODE_ORDER = ['auto', 'low', 'medium', 'high'];
  const MODE_LABEL = { auto: '自动', low: '流畅', medium: '均衡', high: '高画质' };
  /*
   * 画质档位。
   *
   * 【LOD 是谁决定的：screenSpaceError × provider 上报的几何误差】
   *
   * Cesium 挑 LOD 用的是「瓦片上报的几何误差 / 屏幕空间误差」的比值。
   * 本项目的 provider（js/terrain-normals.js 的 NormalHeightmapTerrainProvider）
   * 覆盖了 getLevelMaximumGeometricError，改为上报**真实顶点间距**（k = 1.0，保守）：
   *   ge(L) = 1.0 × (L 级瓦片跨度 / (grid-1)) × 高程夸张系数
   *
   * 【注意】官方 CustomHeightmapTerrainProvider 写死了 64×2 的高度图假设，
   * 会把误差报小 8 倍以上 → Cesium 提前停止细化 → 30 m 的 GLO-30 DEM
   * 被抽稀成 38~76 m 的顶点间距 → 沟壑和丘陵消失。
   * 这个 bug 修好之后，**grid 也间接决定 LOD 深度**（grid 越大 → 同一 LOD 上报
   * 误差越小 → Cesium 愿意再往下细化一层）。
   *
   * 顶点间距 = 瓦片跨度 / (grid-1)。要吃下 30 m 的 GLO-30 DEM，
   * 顶点间距必须 ≲ 25 m，否则采样混叠，沟壑被抽掉、丘陵被抹平。
   *
   * 【实测】相机 9 km 高度、昆明一带（浮雕开启、imagery=0、hillshade=0）：
   *
   *   档位   grid  sse   最深层  顶点间距  瓦片数  帧耗时 p50  起伏 RMS
   *   高画质  65   1.0    L15      9.6 m    480    8.8 ms    29.24
   *   均衡    49   1.6    L15     12.7 m    350    6.1 ms    23.67
   *   流畅    41   2.0    L15     15.3 m    201    4.4 ms    22.29
   *
   * 三档都落在 ≤25 m 的顶点间距内 → 30 m DEM 的沟壑与丘陵都能渲染成几何起伏。
   * 帧耗时全部远低于 16.7 ms 的 60 fps 预算。
   */
  const PROFILES = {
    high: {
      resolutionScale: 1.0,
      screenSpaceError: 1.0,
      grid: 65,
      detailHillshade: true,
      imageryDetail: 'high',
      pointSubsample: 1,
      heavy: true,
      /*
       * 影像瓦片预热预算（张）。
       * 见下面「影像瓦片预热」一节 —— 这是**缓存预热**，
       * 不改变任何图层的可见性，也不改变图层列表。
       */
      imageryPrefetch: 120,
    },
    medium: {
      resolutionScale: 0.85,
      screenSpaceError: 1.6,
      grid: 49,
      detailHillshade: true,
      imageryDetail: 'medium',
      pointSubsample: 2,
      heavy: true,
      imageryPrefetch: 60,
    },
    low: {
      resolutionScale: 0.7,
      screenSpaceError: 2.0,
      grid: 41,
      detailHillshade: true,
      imageryDetail: 'low',
      pointSubsample: 4,
      heavy: false,
      // 流畅档不预热：预热会占带宽，反而拖慢正在进行的加载
      imageryPrefetch: 0,
    },
  };
  const STORE_KEY = 'localEarth.perfMode';
  const state = {
    mode: 'auto',
    tier: 'medium',
    effective: 'medium',
    le: null,
    pending: false,
    frames: 0,
    windowStart: 0,
    lowWindows: 0,
    highWindows: 0,
    lastApply: 0,
    heavyScheduled: false,
    imageryWarmPending: null,   // 地形忙时被推迟的影像预热档位
    timer: null,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function readStoredMode() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(STORE_KEY);
      if (raw && MODE_ORDER.indexOf(raw) >= 0) return raw;
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  function writeStoredMode(mode) {
    try {
      if (window.localStorage) window.localStorage.setItem(STORE_KEY, mode);
    } catch (err) {
      /* ignore */
    }
  }

  function detectGPU() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const info = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return String(info || '');
    } catch (err) {
      return '';
    }
  }

  function detectTier() {
    const gpu = detectGPU().toLowerCase();
    const cores = Number(navigator.hardwareConcurrency) || 4;
    const mem = Number(navigator.deviceMemory) || 4;
    const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent || '');
    if (!gpu) return 'medium';
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(gpu)) return 'low';
    if (mobile && (cores <= 6 || mem <= 4)) return 'low';
    let score = 0;
    if (cores >= 8) score += 2;
    else if (cores >= 6) score += 1;
    else if (cores <= 4) score -= 1;
    if (mem >= 8) score += 2;
    else if (mem >= 6) score += 1;
    else if (mem <= 4) score -= 1;
    if (/nvidia|geforce|radeon|rx \d|apple m\d|arc|discrete/i.test(gpu)) score += 2;
    else if (/intel|uhd|iris|vega|mali|adreno/i.test(gpu)) score += 0;
    if (mobile) score -= 2;
    if (score >= 4) return 'high';
    if (score <= -1) return 'low';
    return 'medium';
  }

  function profileFor(mode) {
    const m = mode === 'auto' ? state.tier : mode;
    return { key: m, ...PROFILES[m] };
  }

  function updateButton() {
    const btn = byId('btn-perf');
    if (!btn) return;
    const label = MODE_LABEL[state.mode] || '自动';
    const eff = state.mode === 'auto' ? '·' + MODE_LABEL[state.effective] : '';
    btn.textContent = '性能：' + label + eff;
    btn.title =
      '性能模式：' +
      label +
      (state.mode === 'auto' ? '（当前实际：' + MODE_LABEL[state.effective] + '）' : '') +
      '；点击切换 自动 → 流畅 → 均衡 → 高画质';
  }

  function notify(text) {
    const le = state.le;
    if (le && typeof le.toast === 'function') le.toast(text, 'info', 3500);
  }

  function scheduleHeavyLoad(profile) {
    if (!profile.heavy || state.heavyScheduled) return;
    state.heavyScheduled = true;
    const run = () => {
      try {
        const T = window.LETerrain;
        if (T && typeof T.loadHeavySources === 'function') {
          T.loadHeavySources().catch(() => {});
        }
      } catch (err) {
        console.warn('[LEPerf] 后台地形数据加载失败', err);
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      setTimeout(run, 2500);
    }
  }

  /* ------------------------------ 影像瓦片预热 ------------------------------
   *
   * 【目的】
   *   相机停在某处后，用户往往马上会小幅平移/缩放。
   *   这时 Cesium 要的是**当前视野外一圈**的瓦片 ——
   *   它们此刻还没下载，所以用户会看到「边走边糊」。
   *
   *   预热就是把这一圈瓦片提前下载+解码好放进共享缓存
   *   （js/local-imagery.js 的 window.LEImagery.prefetch），
   *   等 Cesium 真的要用时，共享缓存直接命中 → 那一帧立刻有图。
   *
   * 【为什么不靠「少加载几个图层」来提速】
   *   图层列表是产品决策，不该由性能档位偷偷改。
   *   这里只做**缓存预热**：图层一个不少、可见性一个不改，
   *   只是把「本来迟早要下的瓦片」提前下好。
   *
   * 【为什么按档位给不同的预热预算】
   *   · 高画质：视野更大、层级更深 → 预算大（120 张）
   *   · 均衡：中（60 张）
   *   · 流畅：0 —— 预热会占带宽，反而拖慢正在进行的加载
   *
   * 【为什么等地形忙完再预热】
   *   地形加载期间带宽已经被 DEM 细源吃满了
   *   （实测同源在途峰值 433 个 DEM 请求），
   *   这时候插预热只会让两边都更慢。
   */
  let motionEpoch = 0, moving = false;
  function nearNationalTerrain(viewer) {
    const dem = window.LEDemTiles, p = viewer.camera.positionCartographic;
    return !!(dem && dem.streaming && p && p.height < 18000 &&
        dem.covers(Cesium.Math.toDegrees(p.longitude), Cesium.Math.toDegrees(p.latitude)));
  }
  function stationaryError(viewer, profile) {
    if (nearNationalTerrain(viewer)) {
      // Lower canvas resolution must not relax the final mountain geometry.
      // During navigation the separate moving threshold still applies.
      return Math.min(profile.screenSpaceError, 1.2);
    }
    return profile.screenSpaceError;
  }
  function bindMotion(viewer) {
    if (!window.LEDemTiles || !window.LEDemTiles.streaming) return;
    const scene = viewer.scene, camera = viewer.camera, canvas = scene.canvas;
    let timer;
    function restore() {
      clearTimeout(timer);
      moving = false;
      const profile = currentProfile();
      scene.globe.maximumScreenSpaceError = stationaryError(viewer, profile);
      if (window.LETerrain) window.LETerrain.setQuality({ imageryDetail: nearNationalTerrain(viewer) ? 'high' : profile.imageryDetail });
      scene.requestRender();
    }
    function start() {
      moving = true; motionEpoch++;
      clearTimeout(timer);
      scene.globe.maximumScreenSpaceError = Math.max(4, currentProfile().screenSpaceError * 2.5);
      window.LEDemTiles.discardOldDetail();
      scene.requestRender();
    }
    function end() { clearTimeout(timer); timer = setTimeout(restore, 140); }
    camera.moveStart.addEventListener(start);
    camera.moveEnd.addEventListener(end);
    canvas.addEventListener('wheel', function () { start(); end(); }, { passive: true });
  }

  function warmImagery(profile) {
    const budget = profile.imageryPrefetch || 0;
    if (!budget) return;
    try {
      const I = window.LEImagery;
      if (!I || typeof I.prefetch !== 'function') return;
      const viewer = state.le && state.le.viewer;
      if (!viewer) return;

      // 【必须等相机就位】
      //   刚启动时相机还在默认的全球视角（高度 2×10⁷ m），
      //   这时算出来的视野矩形是整个地球 → 层级算出来是 1 → 预取毫无意义。
      //   等相机高度落到合理范围（< 5×10⁵ m）再预热。
      const cam = viewer.camera.positionCartographic;
      const height = cam ? cam.height : Infinity;
      if (!isFinite(height) || height > 500000) {
        state.imageryWarmPending = profile.key;
        return;
      }

      // 相机正好看得见的范围，取它的外接矩形再放大一圈
      let rect = null;
      try {
        rect = viewer.camera.computeViewRectangle();
      } catch (err) {
        rect = null;
      }
      const C = window.Cesium;
      const toDeg = C && C.Math ? C.Math.toDegrees : function (r) { return (r * 180) / Math.PI; };
      if (!rect) {
        // 没有可计算的范围（相机朝天/地下）→ 用屏幕中心点附近的小范围
        const c = cam;
        if (!c) return;
        const d = 0.5;
        rect = {
          west: c.longitude - d,
          east: c.longitude + d,
          south: c.latitude - d,
          north: c.latitude + d,
        };
      }
      const west = toDeg(rect.west);
      const east = toDeg(rect.east);
      const south = toDeg(rect.south);
      const north = toDeg(rect.north);
      if (!isFinite(west) || !isFinite(east) || !isFinite(south) || !isFinite(north)) return;

      // 视野跨度过大（比如还是全球视角）→ 不预取
      if (east - west > 60) {
        state.imageryWarmPending = profile.key;
        return;
      }

      // 放大 1.6 倍 → 覆盖「小幅平移/缩放后」才会用到的瓦片
      const cx = (west + east) / 2;
      const cy = (south + north) / 2;
      const hw = Math.max((east - west) * 0.8, 0.35);
      const hh = Math.max((north - south) * 0.8, 0.35);

      // 层级：按跨度算一个「当前视野大致对应」的层级，
      // 再往上补两级（父子层级都要有，才不会出现层级切换时的空窗）。
      const span = Math.max(hw * 2, hh * 2);
      const base = Math.max(1, Math.min(13, Math.ceil(Math.log2(360 / Math.max(span, 1e-6)))));
      const levels = [base, Math.min(14, base + 1), Math.min(14, base + 2)];

      const epoch = motionEpoch;
      const obsolete = function () { return moving || epoch !== motionEpoch; };
      const run = function () {
        if (obsolete()) return;
        const chain = levels.reduce(function (acc, lv) {
          return acc.then(function () {
            return I
              .prefetch(
                { west: cx - hw, south: cy - hh, east: cx + hw, north: cy + hh },
                lv,
                { limit: Math.max(12, Math.floor(budget / levels.length)), background: true, obsolete: obsolete }
              )
              .catch(function () {
                return null;
              });
          });
        }, Promise.resolve());
        return chain;
      };

      // 地形还在加载就先不预热 —— 那时带宽被 DEM 细源占满了
      if (terrainBusy()) {
        state.imageryWarmPending = profile.key;
        return;
      }
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 6000 });
      } else {
        setTimeout(run, 1200);
      }
    } catch (err) {
      /* ignore */
    }
  }

  function applyProfile(profile, reason) {
    const le = state.le;
    state.effective = profile.key;
    state.lastApply = Date.now();
    try {
      const viewer = le && le.viewer;
      if (viewer) {
        viewer.resolutionScale = profile.resolutionScale;
        if (viewer.scene && viewer.scene.globe) {
          viewer.scene.globe.maximumScreenSpaceError = moving ? Math.max(4, profile.screenSpaceError * 2.5) : stationaryError(viewer, profile);
        }
      }
      const T = window.LETerrain;
      if (T && typeof T.setQuality === 'function') {
        T.setQuality({
          grid: profile.grid,
          detailHillshade: profile.detailHillshade,
          imageryDetail: viewer && nearNationalTerrain(viewer) ? 'high' : profile.imageryDetail,
          deferHeavy: true,
        });
      }
      const K = window.LEKml;
      if (K && typeof K.setQuality === 'function') {
        K.setQuality({ pointSubsample: profile.pointSubsample });
      }
      scheduleHeavyLoad(profile);
      warmImagery(profile);
    } catch (err) {
      console.warn('[LEPerf] 应用性能档位失败', err);
    }
    updateButton();
    if (reason === 'auto') {
      notify('已自动切换到「' + MODE_LABEL[state.effective] + '」模式，保证浏览流畅');
    }
  }

  function currentProfile() {
    return profileFor(state.mode);
  }

  function apply() {
    applyProfile(currentProfile());
  }

  function cycleMode() {
    const idx = MODE_ORDER.indexOf(state.mode);
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
    setMode(next, 'manual');
    return next;
  }

  function setMode(mode, reason) {
    if (MODE_ORDER.indexOf(mode) < 0) mode = 'auto';
    state.mode = mode;
    writeStoredMode(mode);
    if (mode === 'auto') state.tier = detectTier();
    state.lowWindows = 0;
    state.highWindows = 0;
    applyProfile(currentProfile(), reason);
    return mode;
  }

  /**
   * 地形是否还在加载中。
   *
   * 【为什么要挡】自动降档会调 setQuality({grid})，grid 一变就重建 Provider，
   * 而 Cesium 的 `terrainProvider` setter 直接 `quadtree.invalidateAllTiles()`，
   * **把已经建好的瓦片全部作废重来**。
   *
   * 实测（RTX 2080 Ti / 48 核，tier 判定为 high）：加载到第 16.3 秒时
   * 帧率短暂低于 16 fps → 自动降级 high→medium（grid 65→49）→
   * 重建 Provider → 已建好的 845 个瓦片全部作废重做，
   * 累计建瓦片数从 898 涨到 1464（= 重建了一遍），就绪时间被拖长数秒。
   *
   * 所以：**地形加载期间不做自动升/降档**，只统计不决策。
   * 加载结束后自动档位照常工作。
   */
  function terrainBusy() {
    try {
      if (window.LEDemTiles && window.LEDemTiles.streaming && state.le && state.le.viewer &&
          (moving || !state.le.viewer.scene.globe.tilesLoaded)) return true;
      const N = window.LETerrainNormals;
      if (!N || !N.stats) return false;
      const s = N.stats;
      // 最近 3 秒内还在建瓦片 → 认为加载中
      const last = s.last && s.last.at ? s.last.at : 0;
      if (s.built > 0 && performance.now() - last < 3000) return true;
    } catch (err) {
      /* ignore */
    }
    return false;
  }

  function onFrame() {
    const scene = state.le && state.le.viewer && state.le.viewer.scene;
    if (!scene || scene.mode === 2 || scene.mode === 1) return; // 2D/哥伦布视图不统计
    const now = performance.now();
    if (!state.windowStart) state.windowStart = now;
    state.frames += 1;
    const elapsed = now - state.windowStart;
    if (elapsed < 1800) return;
    const fps = (state.frames * 1000) / elapsed;
    state.frames = 0;
    state.windowStart = now;
    if (state.mode !== 'auto') {
      // 手动档位也要能补上被推迟的预热
      if (state.imageryWarmPending && !terrainBusy()) {
        const p = profileFor(state.imageryWarmPending);
        state.imageryWarmPending = null;
        warmImagery(p);
      }
      return;
    }
    // 地形加载期间不切换档位（会作废全部已建瓦片）
    if (terrainBusy()) {
      state.lowWindows = 0;
      state.highWindows = 0;
      return;
    }
    // 地形忙完之后，把之前推迟的影像预热补上
    if (state.imageryWarmPending) {
      const p = profileFor(state.imageryWarmPending);
      state.imageryWarmPending = null;
      warmImagery(p);
    }
    if (fps < 16) {
      state.lowWindows += 1;
      state.highWindows = 0;
      if (state.lowWindows >= 2 && state.effective !== 'low') {
        const next = state.effective === 'high' ? 'medium' : 'low';
        state.tier = next;
        state.lowWindows = 0;
        applyProfile(profileFor(next), 'auto');
      }
    } else if (fps > 50) {
      state.highWindows += 1;
      state.lowWindows = 0;
      if (state.highWindows >= 6 && state.effective !== 'high') {
        const next = state.effective === 'low' ? 'medium' : 'high';
        state.tier = next;
        state.highWindows = 0;
        applyProfile(profileFor(next));
      }
    } else {
      state.lowWindows = 0;
      state.highWindows = 0;
    }
  }

  function bindButton() {
    const btn = byId('btn-perf');
    if (!btn) return;
    btn.addEventListener('click', () => {
      cycleMode();
    });
  }

  /** 在 LETerrain.init 之前调用：只做设备探测、按档位设置 deferHeavy / grid，避免启动加载 40MB */
  function preboot() {
    const params = new URLSearchParams(location.search);
    const urlMode = params.get('perf');
    const stored = readStoredMode();
    state.mode = urlMode && MODE_ORDER.indexOf(urlMode) >= 0 ? urlMode : stored || 'auto';
    if (urlMode) writeStoredMode(urlMode);
    state.tier = detectTier();
    const p = currentProfile();
    state.effective = p.key;
    try {
      const T = window.LETerrain;
      if (T && typeof T.setQuality === 'function') {
        T.setQuality({
          grid: p.grid,
          detailHillshade: p.detailHillshade,
          imageryDetail: p.imageryDetail,
          deferHeavy: true,
        });
      }
    } catch (err) {
      /* ignore */
    }
    return p.key;
  }

  function init(le) {
    state.le = le;
    if (!le || !le.viewer) return;
    const params = new URLSearchParams(location.search);
    const urlMode = params.get('perf');
    if (urlMode && MODE_ORDER.indexOf(urlMode) >= 0) state.mode = urlMode;
    state.tier = detectTier();
    bindButton();
    bindMotion(le.viewer);
    applyProfile(currentProfile());
    try {
      le.viewer.scene.postRender.addEventListener(onFrame);
    } catch (err) {
      console.warn('[LEPerf] 帧率监听失败', err);
    }
    console.info(
      '[LEPerf] GPU=' + detectGPU() + ' cores=' + navigator.hardwareConcurrency + ' tier=' + state.tier + ' mode=' + state.mode
    );
  }

  window.LEPerf = {
    preboot,
    init,
    setMode,
    cycleMode,
    getMode: () => state.mode,
    getTier: () => state.tier,
    getEffective: () => state.effective,
    getProfile: () => ({ ...currentProfile() }),
  };
})();

/*
 * 实时光照（P1）
 * - 侧栏「实时光照」开关 + 0–24h 时间滑杆（固定日期 2024-04-03 UTC，显示 UTC / 本地时间）
 * - 打开时 viewer.scene.globe.enableLighting = true，并用 viewer.clock.currentTime 驱动 Cesium Sun
 * - globe.dynamicAtmosphereLighting / dynamicAtmosphereLightingFromSun 视版本设置（1.146 均支持）
 * - 「阴影增强」降低已注册影像层 alpha，让 3D 地形配套的本地 hillshade 更明显
 * - URL 参数：?lighting=1&sun=9.5（sun 单位：小时，UTC）
 *
 * 对外 API：window.LELighting
 *   init(le) / setEnabled(on) / setTime(hours) / getState() / toggle()
 *   reset() / setShadowEnhance(on) / isEnabled()
 *
 * 顶点法线（逐顶点地形起伏光照，GE Pro 风格）：
 *   自 js/terrain-normals.js 起，LOCAL 地形 Provider 为 NormalHeightmapTerrainProvider，
 *   其 hasVertexNormals === true（见该文件头部的 Cesium 1.146 逆向记录）。
 *   Cesium Globe 片元着色器因此走 ENABLE_VERTEX_LIGHTING 分支：
 *   diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalize(v_normalEC))
 *                              * u_lambertDiffuseMultiplier + u_vertexShadowDarkness, 0.0, 1.0)
 *   即按逐顶点 ECEF 法线做兰伯特光照，可见地形起伏明暗。
 *   若使用官方 CustomHeightmapTerrainProvider（hasVertexNormals 硬编码 false），
 *   则退回 ENABLE_DAYNIGHT_SHADING（椭球面法线，只有昼夜明暗，无地形起伏阴影）。
 */
(function () {
  'use strict';

  const C = window.Cesium;

  // 固定日期：2024-04-03（避免不同日期导致演示/截图对比不稳定）
  const BASE_DATE_UTC = Date.UTC(2024, 3, 3, 0, 0, 0);
  const BASE_DATE_LABEL = '2024-04-03';
  const DEFAULT_HOURS = 12;

  const state = {
    le: null,
    enabled: false,
    hours: DEFAULT_HOURS,
    shadowEnhance: false,
    bound: false,
    saved: null,
    savedClock: null,
    savedImagery: [],
    lastSun: null,
    hasVertexNormals: null,
    showRenderLoopNote: '',
    changeListeners: [],
  };

  /**
   * 注册「实时光照开关变化」回调。
   *
   * js/terrain-relief.js 用它来让位：用户打开实时光照时，地形浮雕改用太阳方向；
   * 关掉实时光照时，浮雕恢复自己的固定方向光。两边不会互相覆盖光源。
   */
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    state.changeListeners.push(fn);
    return function () {
      const i = state.changeListeners.indexOf(fn);
      if (i >= 0) state.changeListeners.splice(i, 1);
    };
  }

  function fireChange(on) {
    for (const fn of state.changeListeners.slice()) {
      try {
        fn(!!on);
      } catch (err) {
        console.warn('[LELighting] 变更回调失败', err);
      }
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function getLE() {
    return state.le || window.LE;
  }

  function viewerOf() {
    const le = getLE();
    return le && le.viewer ? le.viewer : null;
  }

  /**
   * GEP 模式（js/gep-mode.js）是否开着。
   *
   * GEP 模式把「卫星 × 晕渲」预先烘焙进影像瓦片，并要求
   * globe.enableLighting === false（顶点光照会二次压暗）。
   * 本模块里有两处逻辑会把 enableLighting 拉回 true、
   * 以及一处会把影像层 alpha 乘 0.35，两处都必须给 GEP 模式让路。
   */
  function gepModeOn() {
    try {
      return !!(window.LEGepMode && typeof window.LEGepMode.isGepMode === 'function' &&
        window.LEGepMode.isGepMode());
    } catch (err) {
      return false;
    }
  }

  // 实时读取当前地形 Provider 是否带逐顶点法线（Globe 本身在 1.146 没有该属性，
  // 真正的判据是 viewer.terrainProvider.hasVertexNormals）
  function liveHasVertexNormals() {
    const viewer = viewerOf();
    if (!viewer || !viewer.terrainProvider) return false;
    return viewer.terrainProvider.hasVertexNormals === true;
  }

  function toDate(hours) {
    return new Date(BASE_DATE_UTC + hours * 3600 * 1000);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatHM(date) {
    return pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes());
  }

  function formatLocal(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  /* --------------------------- 太阳方位/高度（近似） --------------------------- */

  // 近似天文算法（NOAA 简化）：返回 { azimuthDeg（自北顺时针）, altitudeDeg }
  function solarPosition(dateMs, lonDeg, latDeg) {
    const rad = Math.PI / 180;
    const jd = dateMs / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
    const eps = (23.439 - 0.0000004 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const gmstHours = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
    const lstDeg = gmstHours * 15 + lonDeg;
    let H = lstDeg * rad - ra;
    H = Math.atan2(Math.sin(H), Math.cos(H));
    const lat = latDeg * rad;
    const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    const altitude = Math.asin(clamp(sinAlt, -1, 1));
    const cosAlt = Math.cos(altitude);
    let azimuth = 0;
    if (Math.abs(cosAlt) > 1e-9) {
      const sinA = (-Math.sin(H) * Math.cos(dec)) / cosAlt;
      const cosA = (Math.sin(dec) - Math.sin(lat) * sinAlt) / (Math.cos(lat) * cosAlt || 1e-9);
      azimuth = Math.atan2(sinA, cosA);
      if (azimuth < 0) azimuth += 2 * Math.PI;
    }
    return {
      azimuthDeg: (azimuth / rad) % 360,
      altitudeDeg: altitude / rad,
    };
  }

  function observerLonLat() {
    const viewer = viewerOf();
    if (!viewer) return { lon: 105, lat: 32 };
    try {
      const carto = viewer.camera.positionCartographic;
      if (carto && isFinite(carto.longitude)) {
        return { lon: C.Math.toDegrees(carto.longitude), lat: C.Math.toDegrees(carto.latitude) };
      }
    } catch (err) {
      /* ignore */
    }
    return { lon: 105, lat: 32 };
  }

  function computeSun() {
    const { lon, lat } = observerLonLat();
    const pos = solarPosition(toDate(state.hours).getTime(), lon, lat);
    state.lastSun = pos;
    return pos;
  }

  /* ------------------------------- UI ------------------------------- */

  function reflectUI() {
    const toggle = byId('lighting-toggle');
    if (toggle) {
      toggle.textContent = state.enabled ? '关闭光照' : '开启光照';
      toggle.classList.toggle('tool-active', state.enabled);
      toggle.title = state.enabled ? '关闭太阳光照，恢复默认时钟' : '开启太阳光照（按下方时间计算日照）';
    }
    const badge = byId('lighting-state');
    if (badge) {
      badge.textContent = state.enabled ? '开' : '关';
      badge.classList.toggle('on', state.enabled);
    }
    const slider = byId('lighting-time');
    if (slider && document.activeElement !== slider) slider.value = String(state.hours);
    const timeVal = byId('lighting-time-value');
    const date = toDate(state.hours);
    if (timeVal) timeVal.textContent = formatHM(date);
    const sun = computeSun();
    const utcEl = byId('lighting-utc');
    if (utcEl) utcEl.textContent = 'UTC ' + formatHM(date);
    const localEl = byId('lighting-local');
    if (localEl) localEl.textContent = '本地 ' + formatLocal(date);
    const sunEl = byId('lighting-sun');
    if (sunEl) {
      const az = isFinite(sun.azimuthDeg) ? sun.azimuthDeg.toFixed(0) : '--';
      const alt = isFinite(sun.altitudeDeg) ? sun.altitudeDeg.toFixed(0) : '--';
      sunEl.textContent = '方位 ' + az + '° · 高度 ' + alt + '°';
    }
    const enhance = byId('lighting-shadow-enhance');
    if (enhance) enhance.checked = state.shadowEnhance;
    const note = byId('lighting-note');
    if (note) {
      const vn = liveHasVertexNormals();
      note.textContent = state.enabled
        ? state.shadowEnhance
          ? '光照已开启 + 阴影增强（已降低影像层透明度以突出本地 hillshade）。'
          : vn
            ? '光照已开启：可见昼夜明暗与逐顶点地形起伏光照（GE Pro 风格）。'
            : '光照已开启：可见昼夜明暗；当前地形 Provider 无顶点法线，无地形起伏阴影。'
        : vn
          ? '地形带逐顶点法线：开启光照后可见地形起伏明暗。'
          : '当前地形 Provider 无顶点法线：仅昼夜明暗，无地形起伏阴影。';
    }
    const section = byId('lighting-section');
    if (section) section.classList.toggle('lit', state.enabled);
  }

  function updateClock() {
    const viewer = viewerOf();
    if (!viewer) return;
    try {
      viewer.clock.currentTime = C.JulianDate.fromDate(toDate(state.hours));
    } catch (err) {
      console.warn('[LELighting] 设置时钟失败', err);
    }
  }

  function applyGlobe(on) {
    const viewer = viewerOf();
    if (!viewer || !viewer.scene || !viewer.scene.globe) return null;
    const globe = viewer.scene.globe;
    if (on) {
      if (!state.saved) {
        state.saved = {
          enableLighting: !!globe.enableLighting,
          dynamicAtmosphereLighting:
            typeof globe.dynamicAtmosphereLighting === 'boolean' ? globe.dynamicAtmosphereLighting : null,
          dynamicAtmosphereLightingFromSun:
            typeof globe.dynamicAtmosphereLightingFromSun === 'boolean'
              ? globe.dynamicAtmosphereLightingFromSun
              : null,
          lightingFadeOutDistance:
            typeof globe.lightingFadeOutDistance === 'number' ? globe.lightingFadeOutDistance : null,
          lightingFadeInDistance:
            typeof globe.lightingFadeInDistance === 'number' ? globe.lightingFadeInDistance : null,
          nightFadeOutDistance: typeof globe.nightFadeOutDistance === 'number' ? globe.nightFadeOutDistance : null,
          nightFadeInDistance: typeof globe.nightFadeInDistance === 'number' ? globe.nightFadeInDistance : null,
        };
        state.savedClock = viewer.clock.currentTime ? C.JulianDate.clone(viewer.clock.currentTime) : null;
      }
      globe.enableLighting = true;
      // 1.146 支持；旧版本没有这些属性，赋值只是普通字段，不影响运行
      try {
        globe.dynamicAtmosphereLighting = true;
        globe.dynamicAtmosphereLightingFromSun = true;
      } catch (err) {
        /* ignore */
      }
      // Cesium 默认只在相机远离地表（约 10000–20000 km）时才应用光照（lightingFadeDistance）。
      // 本地使用相机高度通常只有几十公里，如不调整则完全看不到昼夜明暗，这里把渐变距离拉近到地面附近。
      try {
        if (typeof globe.lightingFadeOutDistance === 'number') globe.lightingFadeOutDistance = 0;
        if (typeof globe.lightingFadeInDistance === 'number') globe.lightingFadeInDistance = 1000;
        if (typeof globe.nightFadeOutDistance === 'number') globe.nightFadeOutDistance = 0;
        if (typeof globe.nightFadeInDistance === 'number') globe.nightFadeInDistance = 5e6;
      } catch (err) {
        /* ignore */
      }
      try {
        viewer.scene.sun && (viewer.scene.sun.show = true);
      } catch (err) {
        /* ignore */
      }
      state.enabled = true;
      updateClock();
    } else {
      const saved = state.saved || { enableLighting: false };
      globe.enableLighting = !!saved.enableLighting;
      // 【与地形浮雕协同】js/terrain-relief.js 常驻开启 globe.enableLighting
      // （否则 Cesium 不会编译 ENABLE_VERTEX_LIGHTING，地形起伏就完全不受光）。
      // 所以关掉「实时光照」时不能把它一起关掉，否则地形会瞬间变成一片平。
      //
      // 【GEP 模式让路】但 GEP 模式（js/gep-mode.js）**必须**保持
      // enableLighting=false —— 它的观感来自「烘焙影像 × 晕渲」的乘法合成，
      // 再叠一层逐顶点光照会二次压暗，破坏 GEP 观感。
      // 所以 GEP 模式优先，这里不把 enableLighting 拉回 true。
      if (!gepModeOn()) {
        try {
          if (window.LETerrainRelief && typeof window.LETerrainRelief.isEnabled === 'function' &&
              window.LETerrainRelief.isEnabled()) {
            globe.enableLighting = true;
          }
        } catch (err) {
          /* ignore */
        }
      }
      if (saved.dynamicAtmosphereLighting != null) {
        try {
          globe.dynamicAtmosphereLighting = saved.dynamicAtmosphereLighting;
        } catch (err) {
          /* ignore */
        }
      }
      if (saved.dynamicAtmosphereLightingFromSun != null) {
        try {
          globe.dynamicAtmosphereLightingFromSun = saved.dynamicAtmosphereLightingFromSun;
        } catch (err) {
          /* ignore */
        }
      }
      if (saved.lightingFadeOutDistance != null) globe.lightingFadeOutDistance = saved.lightingFadeOutDistance;
      if (saved.lightingFadeInDistance != null) globe.lightingFadeInDistance = saved.lightingFadeInDistance;
      if (saved.nightFadeOutDistance != null) globe.nightFadeOutDistance = saved.nightFadeOutDistance;
      if (saved.nightFadeInDistance != null) globe.nightFadeInDistance = saved.nightFadeInDistance;
      if (state.savedClock) {
        try {
          viewer.clock.currentTime = C.JulianDate.clone(state.savedClock);
        } catch (err) {
          /* ignore */
        }
      }
      state.saved = null;
      state.savedClock = null;
      state.enabled = false;
    }
    return {
      enableLighting: !!globe.enableLighting,
      dynamicAtmosphereLighting: globe.dynamicAtmosphereLighting,
      dynamicAtmosphereLightingFromSun: globe.dynamicAtmosphereLightingFromSun,
    };
  }

  /* --------------------------- 阴影增强 --------------------------- */

  function isShadowName(name) {
    return /阴影|hillshade|shade/i.test(String(name || ''));
  }

  /**
   * 烘焙层（GEP 模式的卫星 × 晕渲 乘法合成层）。
   *
   * isShadowName() 的正则 /阴影|hillshade|shade/i **匹配不到** "baked"，
   * 所以烘焙层会被 registeredImagery() 当成普通影像层收进去，
   * 然后被 setShadowEnhance() 的 alpha *= 0.35 **二次压暗** ——
   * 烘焙层已经自带晕渲，再压 0.35 就等于把 GEP 观感毁掉。
   * 这里显式排除。
   */
  function isBakedName(name) {
    return /烘焙|baked/i.test(String(name || ''));
  }

  function registeredImagery() {
    const le = getLE();
    if (!le || typeof le.listLayers !== 'function') return [];
    return le.listLayers().filter(
      (l) => l.type === 'imagery' && l.imageryLayer && !isShadowName(l.name) && !isBakedName(l.name)
    );
  }

  function setShadowEnhance(on) {
    const viewer = viewerOf();
    if (!viewer) return false;
    on = !!on;
    if (on) {
      // 【GEP 模式】烘焙层已自带晕渲，阴影增强对它没有意义；
      // 而且 registeredImagery() 已显式排除烘焙层（见 isBakedName）。
      // 这里直接拒绝，避免用户以为阴影增强生效了。
      if (gepModeOn()) {
        const le = getLE();
        if (le && le.toast) {
          le.toast('GEP 模式下阴影增强不可用（烘焙影像已自带晕渲）', 'error', 3600);
        }
        state.shadowEnhance = false;
        reflectUI();
        return false;
      }
      const terrainOn = !!(window.LETerrain && window.LETerrain.isEnabled && window.LETerrain.isEnabled());
      if (!terrainOn) {
        const le = getLE();
        if (le && le.toast) le.toast('阴影增强需要先开启 3D 地形（地形配套本地 hillshade）', 'error', 4200);
        state.shadowEnhance = false;
        reflectUI();
        return false;
      }
      const layers = registeredImagery().filter((l) => l.visible !== false);
      state.savedImagery = [];
      for (const entry of layers) {
        const layer = entry.imageryLayer;
        const alpha = typeof layer.alpha === 'number' ? layer.alpha : 1;
        state.savedImagery.push({ entry, alpha });
        layer.alpha = Math.max(0.12, Math.min(1, alpha * 0.35));
      }
      state.shadowEnhance = true;
      const le = getLE();
      if (le && le.toast) {
        le.toast(
          state.savedImagery.length
            ? '阴影增强：已降低 ' + state.savedImagery.length + ' 个影像层透明度'
            : '阴影增强：当前没有可降低的影像层（底图不在图层面板中）',
          'ok',
          3200
        );
      }
    } else {
      for (const item of state.savedImagery) {
        try {
          item.entry.imageryLayer.alpha = item.alpha;
        } catch (err) {
          /* ignore */
        }
      }
      state.savedImagery = [];
      state.shadowEnhance = false;
    }
    reflectUI();
    return state.shadowEnhance;
  }

  /* ------------------------------- 公开 API ------------------------------- */

  function setEnabled(on) {
    const viewer = viewerOf();
    if (!viewer) return false;
    on = !!on;
    if (on === state.enabled && !on) {
      reflectUI();
      return state.enabled;
    }
    applyGlobe(on);
    if (!on && state.shadowEnhance) setShadowEnhance(false);
    if (on) updateClock();
    fireChange(on);
    reflectUI();
    const le = getLE();
    if (le && le.status) {
      const date = toDate(state.hours);
      le.status(
        on
          ? '实时光照已开启：UTC ' + formatHM(date) + '（' + BASE_DATE_LABEL + '）'
          : '实时光照已关闭，时钟已恢复'
      );
    }
    return state.enabled;
  }

  function setTime(hours) {
    const h = Number(hours);
    state.hours = clamp(isFinite(h) ? h : DEFAULT_HOURS, 0, 24);
    if (state.enabled) updateClock();
    reflectUI();
    return state.hours;
  }

  function reset() {
    if (state.enabled) setEnabled(false);
    state.hours = DEFAULT_HOURS;
    state.shadowEnhance = false;
    reflectUI();
    const le = getLE();
    if (le && le.status) le.status('实时光照已重置（关闭光照，时间恢复 12:00 UTC）');
    return getState();
  }

  function toggle() {
    return setEnabled(!state.enabled);
  }

  function terrainProviderLabel() {
    const viewer = viewerOf();
    if (!viewer || !viewer.terrainProvider) return null;
    const provider = viewer.terrainProvider;
    try {
      if (C.CustomHeightmapTerrainProvider && provider instanceof C.CustomHeightmapTerrainProvider) {
        // NormalHeightmapTerrainProvider 是它的子类，带顶点法线，需要区分开
        if (provider.constructor && provider.constructor.name === 'NormalHeightmapTerrainProvider') {
          return 'NormalHeightmapTerrainProvider';
        }
        return 'CustomHeightmapTerrainProvider';
      }
      if (C.EllipsoidTerrainProvider && provider instanceof C.EllipsoidTerrainProvider) {
        return 'EllipsoidTerrainProvider';
      }
    } catch (err) {
      /* ignore */
    }
    return provider.constructor ? provider.constructor.name : null;
  }

  function getState() {
    const viewer = viewerOf();
    const globe = viewer && viewer.scene ? viewer.scene.globe : null;
    const sun = state.lastSun || computeSun();
    const date = toDate(state.hours);
    const terrain = window.LETerrain && window.LETerrain.stats ? window.LETerrain.stats() : null;
    return {
      enabled: state.enabled,
      hours: state.hours,
      date: BASE_DATE_LABEL,
      utc: formatHM(date),
      local: formatLocal(date),
      sun: {
        azimuthDeg: sun.azimuthDeg,
        altitudeDeg: sun.altitudeDeg,
        note: '近似天文计算（NOAA 简化公式），用于面板显示',
      },
      shadowEnhance: state.shadowEnhance,
      shadowEnhancedLayers: state.savedImagery.length,
      globe: globe
        ? {
            enableLighting: !!globe.enableLighting,
            dynamicAtmosphereLighting:
              typeof globe.dynamicAtmosphereLighting === 'boolean' ? globe.dynamicAtmosphereLighting : null,
            dynamicAtmosphereLightingFromSun:
              typeof globe.dynamicAtmosphereLightingFromSun === 'boolean'
                ? globe.dynamicAtmosphereLightingFromSun
                : null,
            lightingFadeOutDistance:
              typeof globe.lightingFadeOutDistance === 'number' ? globe.lightingFadeOutDistance : null,
            lightingFadeInDistance:
              typeof globe.lightingFadeInDistance === 'number' ? globe.lightingFadeInDistance : null,
            nightFadeOutDistance: typeof globe.nightFadeOutDistance === 'number' ? globe.nightFadeOutDistance : null,
            nightFadeInDistance: typeof globe.nightFadeInDistance === 'number' ? globe.nightFadeInDistance : null,
            terrainProvider: terrainProviderLabel(),
            hasVertexNormals:
              viewer.terrainProvider && typeof viewer.terrainProvider.hasVertexNormals === 'boolean'
                ? viewer.terrainProvider.hasVertexNormals
                : null,
          }
        : null,
      terrainEnabled: terrain ? !!terrain.enabled : null,
      clock: viewer && viewer.clock && viewer.clock.currentTime
        ? C.JulianDate.toIso8601(viewer.clock.currentTime)
        : null,
      limitation: liveHasVertexNormals()
        ? null
        : 'terrainProvider.hasVertexNormals=false：Cesium 只会做昼夜（day/night）明暗，'
          + '不会对地形起伏做逐顶点光照，因此看不到地形自阴影；可开「阴影增强」叠加本地 hillshade。',
    };
  }

  /* ------------------------------- 绑定/初始化 ------------------------------- */

  function bindUI() {
    if (state.bound) return;
    state.bound = true;
    const toggleBtn = byId('lighting-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', () => toggle());
    const resetBtn = byId('lighting-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => reset());
    const slider = byId('lighting-time');
    if (slider) {
      slider.value = String(state.hours);
      slider.addEventListener('input', () => setTime(parseFloat(slider.value)));
    }
    const enhance = byId('lighting-shadow-enhance');
    if (enhance) {
      enhance.addEventListener('change', () => setShadowEnhance(enhance.checked));
    }
    // 相机移动时更新太阳方位显示（观察点随相机变化），节流
    const viewer = viewerOf();
    if (viewer) {
      let raf = 0;
      const onChange = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (state.enabled) reflectUI();
        });
      };
      try {
        viewer.camera.changed.addEventListener(onChange);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function init(le) {
    state.le = le || window.LE;
    bindUI();
    // 记录地形 Provider 是否有顶点法线（如实显示在状态/文档中）
    const viewer = viewerOf();
    if (viewer && viewer.terrainProvider) {
      state.hasVertexNormals =
        typeof viewer.terrainProvider.hasVertexNormals === 'boolean'
          ? viewer.terrainProvider.hasVertexNormals
          : null;
    }
    const params = new URLSearchParams(location.search);
    const sun = params.get('sun');
    if (sun != null && sun !== '') {
      const h = Number(sun);
      if (isFinite(h)) state.hours = clamp(h, 0, 24);
    }
    const lightingParam = (params.get('lighting') || '').toLowerCase();
    const shouldEnable = lightingParam === '1' || lightingParam === 'true' || lightingParam === 'on';
    if (shouldEnable) {
      applyGlobe(true);
      updateClock();
      state.enabled = true;
    }
    reflectUI();
    return getState();
  }

  window.LELighting = {
    init,
    setEnabled,
    setTime,
    getState,
    toggle,
    reset,
    setShadowEnhance,
    isEnabled: () => state.enabled,
    // 阴影增强当前是否开着（js/gep-mode.js 用它决定是否要关掉阴影增强）
    isShadowEnhanceOn: () => state.shadowEnhance,
    onChange,
    getSunPosition: () => computeSun(),
    // 测试/诊断辅助：当前地形 Provider 是否带逐顶点法线（true 表示有地形起伏光照）
    hasVertexNormals: () => liveHasVertexNormals(),
  };

  // 模块自行初始化：main.js 在启动完成后派发 local-earth-ready
  function boot() {
    if (window.LE && window.LE.viewer) {
      init(window.LE);
      return;
    }
    document.addEventListener('local-earth-ready', (ev) => init((ev && ev.detail) || window.LE), {
      once: true,
    });
  }
  boot();
})();

/*
 * 地形浮雕光照（terrain relief shading）
 *
 * 背景
 * ----
 * 本项目的地形 provider 是 js/terrain-normals.js 的 NormalHeightmapTerrainProvider，
 * 它给每个顶点算了 ECEF 法线，provider.hasVertexNormals === true。
 * 但 Cesium 1.146 的 Globe 片元着色器里，这个开关还要再过一道闸门：
 *
 *   // GlobeSurfaceTileProvider.getShaderProgram(...)
 *   _ = t.enableLighting;              // ← 来自 globe.enableLighting
 *   V = terrainProvider.hasVertexNormals;
 *   _ ? (V ? push("ENABLE_VERTEX_LIGHTING")
 *          : push("ENABLE_DAYNIGHT_SHADING"))
 *     : push(都不 push)
 *
 * 而 js/main.js 里写死了 `scene.globe.enableLighting = false`。
 * 于是实际编译出来的着色器**两个分支都没有**：
 *   - 没有 ENABLE_VERTEX_LIGHTING → 逐顶点法线算了但没人用；
 *   - 没有 ENABLE_DAYNIGHT_SHADING → 连昼夜明暗都没有。
 *
 * 结果就是：地形几何完全不受光，屏幕上的「立体感」只能靠另外贴的
 * hillshade 栅格图 —— 也就是一张平铺的贴图，它不随地形起伏变化，
 * 于是用户看到的「只有高画质能看 3D 地形、沟壑和丘陵没有立体」就是这么来的。
 *
 * 实证（浏览器内实测，见 docs/GE-PRO.md）：
 *   enableLighting=false 时翻转光照方向 → 画面逐像素差异 0.000（光照完全无效）
 *   enableLighting=true  时翻转光照方向 → diffStd 22.2 / diffHpRms 2.10（逐顶点法线生效）
 *
 * 本模块负责
 * ------------
 * 1. 打开 globe.enableLighting，让 Globe 走 ENABLE_VERTEX_LIGHTING 分支；
 * 2. 装一个固定方向光（DirectionalLight），让「地形浮雕」不依赖时钟里的太阳位置
 *    —— Google Earth Pro 就是用固定方向光 + 逐顶点法线做地形起伏光照的（见 docs/GE-PRO.md）；
 * 3. 与 js/lighting.js（实时光照）协同：用户打开实时光照时改用太阳方向，
 *    关掉实时光照时恢复固定方向光，两边不互相打架；
 * 4. 调 lambertDiffuseMultiplier / vertexShadowDarkness，让浮雕既看得清又不至于全黑。
 *
 * 对外 API：window.LETerrainRelief
 *   init(le)                 模块在 local-earth-ready 时自动调用
 *   setEnabled(on)           => boolean
 *   isEnabled()              => boolean
 *   setFixedLight(on)        => boolean   固定方向光 / 跟随太阳
 *   getState()               => { enabled, mode, light, lambert, shadowDarkness, hasVertexNormals }
 *   applyTo(le)              立即把配置刷到 viewer 上
 */

(function () {
  'use strict';

  const C = window.Cesium;

  /**
   * 固定方向光的方向（ECEF，指向光源）。
   *
   * 【为什么不用太阳】太阳位置随时钟变化，夜里地形就全黑了；
   * 而地形「浮雕」是常驻可读的浏览辅助（Google Earth Pro 的地形起伏也是常驻的）。
   * 这里选一个固定的西南方向、仰角 45°，与本地预烘焙 hillshade
   * （tools/make_dem_hillshade.py 用 az=315°、alt=45°）保持一致，
   * 这样「几何浮雕」和「贴图晕渲」的明暗方向不会互相打架。
   */
  const FIXED_AZIMUTH_DEG = 315; // 西北方向（0=北，90=东）
  const FIXED_ALTITUDE_DEG = 45;

  const state = {
    le: null,
    enabled: true, // 地形开着就应当有浮雕
    fixedLight: true, // 默认固定方向光；实时光照打开时临时让位
    saved: null, // 用户实时光照打开前保存的场景状态
    applied: false,
  };

  /**
   * 把方位角/仰角换算成 ECEF 方向向量。
   *
   * 【方向约定】Cesium 的 DirectionalLight.direction 表示「光线前进方向」，
   * 着色器里用的是 `lightDirectionWC = normalize(-direction)`（指向光源）。
   * 所以这里必须传「光线前进方向」，也就是**背离光源**的那个向量，
   * 传反了地形会整片变暗（实测平均亮度 108 → 33）。
   */
  function directionFromAzAlt(azimuthDeg, altitudeDeg, lonDeg, latDeg) {
    const az = (azimuthDeg * Math.PI) / 180;
    const alt = (altitudeDeg * Math.PI) / 180;
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    // 局部 ENU → ECEF
    const east = [-Math.sin(lon), Math.cos(lon), 0];
    const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
    const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const ca = Math.cos(alt);
    const sa = Math.sin(alt);
    // 方位角 0 = 北，顺时针增大；这里先算「指向光源」的向量
    const toLight = [
      ca * (Math.sin(az) * east[0] + Math.cos(az) * north[0]) + sa * up[0],
      ca * (Math.sin(az) * east[1] + Math.cos(az) * north[1]) + sa * up[1],
      ca * (Math.sin(az) * east[2] + Math.cos(az) * north[2]) + sa * up[2],
    ];
    // 取反 → 光线前进方向
    return new C.Cartesian3(-toLight[0], -toLight[1], -toLight[2]);
  }

  function viewerOf() {
    if (state.le && state.le.viewer) return state.le.viewer;
    return window.LE && window.LE.viewer ? window.LE.viewer : null;
  }

  /**
   * GEP 模式（js/gep-mode.js）是否开着。
   *
   * GEP 模式要求 globe.enableLighting === false（乘法合成已含晕渲）。
   * 本模块是「常驻开启顶点光照」的那一方，所以必须给 GEP 模式让路。
   */
  function gepModeOn() {
    try {
      return !!(window.LEGepMode && typeof window.LEGepMode.isGepMode === 'function' &&
        window.LEGepMode.isGepMode());
    } catch (err) {
      return false;
    }
  }

  /** 相机所在经纬度（固定方向光按相机位置走，保持远近一致的入射角）。 */
  function cameraLonLat() {
    const viewer = viewerOf();
    if (!viewer) return { lon: 102.4, lat: 25.05 };
    try {
      const c = viewer.camera.positionCartographic;
      if (!c) return { lon: 102.4, lat: 25.05 };
      return {
        lon: C.Math.toDegrees(c.longitude),
        lat: C.Math.toDegrees(c.latitude),
      };
    } catch (err) {
      return { lon: 102.4, lat: 25.05 };
    }
  }

  function hasVertexNormals(viewer) {
    if (!viewer || !viewer.terrainProvider) return false;
    return !!viewer.terrainProvider.hasVertexNormals;
  }

  /** 实时光照（js/lighting.js）是否开着。 */
  function realTimeLightingOn() {
    try {
      if (window.LELighting && typeof window.LELighting.isEnabled === 'function') {
        return !!window.LELighting.isEnabled();
      }
    } catch (err) {
      /* ignore */
    }
    return false;
  }

  function buildFixedLight(viewer) {
    const ll = cameraLonLat();
    const dir = directionFromAzAlt(FIXED_AZIMUTH_DEG, FIXED_ALTITUDE_DEG, ll.lon, ll.lat);
    return new C.DirectionalLight({
      direction: dir,
      intensity: 1.35,
      color: C.Color.WHITE,
    });
  }

  /**
   * 把浮雕配置刷到 viewer 上。
   * @param {boolean} withLight 是否要接管 scene.light
   */
  function applyTo(le, withLight) {
    le = le || state.le;
    const viewer = (le && le.viewer) || viewerOf();
    if (!viewer || !viewer.scene || !viewer.scene.globe) return false;
    const globe = viewer.scene.globe;

    // 【GEP 模式让路】GEP 模式（js/gep-mode.js）的观感来自
    // 「卫星影像 × 逐像元晕渲」的**乘法合成**（晕渲已烘焙进影像瓦片）。
    // 顶点光照会在此之上再压一层明暗，等于二次晕渲，破坏 GEP 观感。
    // 所以 GEP 模式下这里不碰 enableLighting —— 保持 false。
    if (gepModeOn()) {
      state.applied = true;
      return true;
    }

    // 1) 关键闸门：打开后 Globe 才会编译 ENABLE_VERTEX_LIGHTING / ENABLE_DAYNIGHT_SHADING
    globe.enableLighting = true;

    // 2) 近距离也要有明暗：Cesium 默认 10013 km 才渐入，本地几十公里根本看不到
    try {
      if (typeof globe.lightingFadeOutDistance === 'number') globe.lightingFadeOutDistance = 0;
      if (typeof globe.lightingFadeInDistance === 'number') globe.lightingFadeInDistance = 1000;
    } catch (err) {
      /* ignore */
    }

    // 3) 浮雕强度：默认 0.9 会把背光面压得很黑（实测平均亮度从 142 → 73），
    //    沟壑与丘陵的层次看不清楚。调到 0.75 并把 shadowDarkness 从 0.3 降到 0.18，
    //    让背光面仍能分辨出坡度，而不是一片死黑。
    try {
      globe.lambertDiffuseMultiplier = 0.75;
      globe.vertexShadowDarkness = 0.18;
    } catch (err) {
      /* ignore */
    }

    // 4) 光源
    if (withLight !== false) {
      try {
        if (state.fixedLight && !realTimeLightingOn()) {
          if (!state.saved) {
            state.saved = { light: viewer.scene.light };
          }
          viewer.scene.light = buildFixedLight(viewer);
        }
      } catch (err) {
        console.warn('[LETerrainRelief] 固定方向光安装失败', err);
      }
    }
    state.applied = true;
    return true;
  }

  function setEnabled(on) {
    const viewer = viewerOf();
    if (!viewer || !viewer.scene || !viewer.scene.globe) return false;
    on = !!on;
    state.enabled = on;
    const globe = viewer.scene.globe;
    if (on) {
      applyTo(state.le, true);
    } else {
      globe.enableLighting = false;
      // 恢复实时光照可能保存过的光源
      if (state.saved && state.saved.light) {
        try {
          viewer.scene.light = state.saved.light;
        } catch (err) {
          /* ignore */
        }
      }
      state.saved = null;
      state.applied = false;
    }
    return state.enabled;
  }

  /**
   * 固定方向光 ⇄ 跟随太阳。
   * 打开实时光照时 js/lighting.js 会把 clock 设成用户选的时刻，
   * Cesium 的默认 SunLight 会跟着 clock 走 —— 此时浮雕方向应该跟着太阳，
   * 否则「光照滑杆」和「地形浮雕」会互相矛盾。
   */
  function setFixedLight(on) {
    const viewer = viewerOf();
    if (!viewer) return false;
    state.fixedLight = !!on;
    if (!state.enabled) return state.fixedLight;
    if (state.fixedLight) {
      applyTo(state.le, true);
    } else {
      // 让回默认 SunLight（跟随 clock）
      try {
        viewer.scene.light = new C.SunLight({
          intensity: 2.0,
          color: C.Color.WHITE,
        });
      } catch (err) {
        console.warn('[LETerrainRelief] 切换到太阳光失败', err);
      }
    }
    return state.fixedLight;
  }

  function getState() {
    const viewer = viewerOf();
    const globe = viewer && viewer.scene ? viewer.scene.globe : null;
    const light = viewer && viewer.scene ? viewer.scene.light : null;
    return {
      enabled: state.enabled,
      mode: state.fixedLight ? 'fixed' : 'sun',
      hasVertexNormals: hasVertexNormals(viewer),
      lambert: globe ? globe.lambertDiffuseMultiplier : null,
      shadowDarkness: globe ? globe.vertexShadowDarkness : null,
      enableLighting: globe ? !!globe.enableLighting : null,
      light: light ? light.constructor.name : null,
      fixedAzimuthDeg: FIXED_AZIMUTH_DEG,
      fixedAltitudeDeg: FIXED_ALTITUDE_DEG,
    };
  }

  function init(le) {
    state.le = le || state.le;
    const viewer = viewerOf();
    if (!viewer) return false;
    applyTo(state.le, true);

    // 相机移动时更新固定方向光（让入射角跟着视角走）
    try {
      viewer.camera.changed.addEventListener(function () {
        if (!state.enabled || !state.fixedLight) return;
        if (realTimeLightingOn()) return;
        try {
          viewer.scene.light = buildFixedLight(viewer);
        } catch (err) {
          /* ignore */
        }
      });
    } catch (err) {
      /* ignore */
    }

    // 实时光照开关变化时同步
    try {
      if (window.LELighting && window.LELighting.onChange) {
        window.LELighting.onChange(function (on) {
          if (!state.enabled) return;
          if (on) {
            // 让位给太阳光
            try {
              viewer.scene.light = new C.SunLight({ intensity: 2.0, color: C.Color.WHITE });
            } catch (err) {
              /* ignore */
            }
          } else if (state.fixedLight) {
            applyTo(state.le, true);
          }
        });
      }
    } catch (err) {
      /* ignore */
    }

    console.debug('[LETerrainRelief] 地形浮雕光照已启用（逐顶点法线 + 固定方向光）');
    return true;
  }

  window.LETerrainRelief = {
    init: init,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setFixedLight: setFixedLight,
    isFixedLight: () => state.fixedLight,
    getState: getState,
    applyTo: (le) => applyTo(le, true),
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

/*
 * GEP 保真模式（Google Earth Pro 式乘法合成）
 * ---------------------------------------------------------------------------
 * 【为什么】
 *   GEP 的屏幕像素 = 卫星影像 × 逐像元晕渲（**乘法合成**）。
 *   Cesium 1.146 没有影像层的 blendMode（整包 grep 出现 0 次），
 *   customShader 也没挂在 Globe 上，地形光照只有 ENABLE_VERTEX_LIGHTING
 *   （Gouraud 逐顶点）。所以做「乘法」的唯一路径是**预烘焙**：
 *   把晕渲预先乘进影像瓦片（tools/make_baked30.py）。
 *
 * 【实测结论】tools/verify_gep_roadmap.py（四项独立检验）
 *   F0_default（当前默认）        corrGEP 同源 0.7800 / 独立 0.6344
 *   G2_baked30_nolight             corrGEP 同源 0.8095 / 独立 0.7244
 *   H4_baked30_nolight_a100        corrGEP 同源 0.8104 / 独立 0.7249
 *   G8_baked30v2                   corrGEP 同源 0.8057 / 独立 0.7696
 *   → 烘焙 + 关顶点光照是明确的方向。
 *
 * 【P2 的坑：区域关顶点光照做不到】
 *   路线图原计划「只在烘焙生效区域关顶点光照」。这条路**走不通**：
 *     · globe.enableLighting 是 Cesium 的**全局标量**，Globe 构造器里只有
 *       `this.enableLighting = !1` 一个字段，没有逐区域/逐瓦片的通道；
 *     · enableLighting=false 不是「无光照」，它让着色器切到
 *       ENABLE_DAYNIGHT_SHADING 分支（仍有昼夜明暗），而不是把光照整体关掉。
 *   所以改成**显式的双模式开关**：
 *     · 「浮雕模式」（默认）= 卫星影像 + 顶点光照（当前行为，不变）
 *     · 「GEP 模式」      = 烘焙影像层 + globe.enableLighting = false
 *
 * 【GEP 模式下必须处理的两处反向逻辑】
 *   1. js/lighting.js applyGlobe(false) 里有一段「地形浮雕开着就把
 *      enableLighting 拉回 true」的协同逻辑 —— GEP 模式下必须让路，
 *      否则关掉实时光照会顺手把顶点光照又打开。
 *   2. js/lighting.js setShadowEnhance() 会把 registeredImagery() 里
 *      所有影像层 alpha 乘 0.35 —— 烘焙层会被**二次压暗**。
 *      isShadowName() 的正则 /阴影|hillshade|shade/i 匹配不到 "baked"，
 *      所以要显式排除烘焙层。
 *
 * 对外 API：window.LEGepMode
 *   init(le)
 *   setMode('relief' | 'gep')   => 'relief' | 'gep'
 *   getMode()                   => 'relief' | 'gep'
 *   isGepMode()                 => boolean
 *   toggle()                    => 新模式
 *   getState()                  => { mode, enableLighting, bakedLayer, ... }
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const state = {
    le: null,
    mode: 'relief',     // 'relief' = 卫星 + 顶点光照（默认）；'gep' = 烘焙 + 关顶点光照
    bakedEntries: [],   // 已挂载的烘焙影像层 entry
    savedAlpha: null,   // 切回浮雕模式时恢复卫星影像 alpha
    inited: false,
  };

  function getLE() {
    return state.le || window.LE;
  }

  function viewerOf() {
    const le = getLE();
    return le && le.viewer ? le.viewer : null;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /* ------------------------------------------------------------------ *
   * 烘焙层查找
   * ------------------------------------------------------------------ */

  /** 名称含「烘焙」的影像层（js/terrain.js 挂载时按这个名字登记）。 */
  function isBakedName(name) {
    return /烘焙|baked/i.test(String(name || ''));
  }

  function bakedLayers(le) {
    const layers = (le && le.listLayers && le.listLayers()) || [];
    return layers.filter((l) => l.type === 'imagery' && l.imageryLayer && isBakedName(l.name));
  }

  function satelliteLayers(le) {
    const layers = (le && le.listLayers && le.listLayers()) || [];
    return layers.filter(
      (l) => l.type === 'imagery' && l.imageryLayer && !isBakedName(l.name) && !isShadowName(l.name)
    );
  }

  /** 与 js/lighting.js 的 isShadowName 保持一致（阴影/晕渲层不该算卫星底图）。 */
  function isShadowName(name) {
    return /阴影|hillshade|shade/i.test(String(name || ''));
  }

  /* ------------------------------------------------------------------ *
   * 模式切换
   * ------------------------------------------------------------------ */

  /**
   * 关掉顶点光照。
   *
   * 【为什么不能靠 js/lighting.js 的 applyGlobe(false)】
   *   它在「地形浮雕开着」时会把 enableLighting 拉回 true。GEP 模式下
   *   必须让路，所以这里直接改 globe，并让 lighting.js 知道
   *   「GEP 模式优先」（见 js/lighting.js 里的 gepModeGuard）。
   */
  function disableVertexLighting() {
    const viewer = viewerOf();
    if (!viewer || !viewer.scene || !viewer.scene.globe) return false;
    try {
      viewer.scene.globe.enableLighting = false;
    } catch (err) {
      console.warn('[LEGepMode] 关顶点光照失败', err);
      return false;
    }
    return true;
  }

  /** 让 js/terrain-relief.js 重新开顶点光照（浮雕模式）。 */
  function enableReliefLighting() {
    const relief = window.LETerrainRelief;
    if (relief && typeof relief.applyTo === 'function') {
      try {
        relief.applyTo(getLE());
        return true;
      } catch (err) {
        console.warn('[LEGepMode] 恢复浮雕光照失败', err);
      }
    }
    // 兜底：直接开
    const viewer = viewerOf();
    if (viewer && viewer.scene && viewer.scene.globe) {
      viewer.scene.globe.enableLighting = true;
      return true;
    }
    return false;
  }

  function setBakedVisible(on) {
    const le = getLE();
    const layers = bakedLayers(le);
    for (const l of layers) {
      try {
        l.imageryLayer.show = !!on;
      } catch (err) {
        /* ignore */
      }
    }
    return layers.length;
  }

  function setSatelliteAlpha(alpha) {
    const le = getLE();
    const layers = satelliteLayers(le);
    for (const l of layers) {
      try {
        l.imageryLayer.alpha = alpha;
      } catch (err) {
        /* ignore */
      }
    }
    return layers.length;
  }

  /**
   * 切到 GEP 模式：烘焙层可见 + 关顶点光照。
   *
   * 【卫星层保持显示、烘焙层 alpha=1 叠在它上面】
   *   烘焙瓦片只覆盖 lon 102.13~102.68 / lat 24.77~25.40 这一小块，
   *   而卫星影像层是**全球范围**的。关掉卫星层会让区域外变成蓝马赛克底图；
   *   把卫星层 alpha 归零同样不行（区域外就没有影像了）。
   *   正确做法是：卫星层保持显示（区域外由它兜底），烘焙层**叠在它上面**
   *   且 alpha=1（区域内的像素完全被烘焙层替换）。
   *   见 js/terrain.js mountBakedImagery() 的说明。
   */
  async function enterGepMode() {
    const le = getLE();
    if (!le || !le.viewer) return false;
    let n = setBakedVisible(true);
    if (!n) {
      // 烘焙层可能还没挂上（loadBuiltinDemOverlays 是异步的）——
      // 退而求其次：直接按已知的清单挂一张。
      n = await mountBakedFallback(le);
      if (n) setBakedVisible(true);
    }
    if (!n) {
      toast('本机没有预烘焙影像层，无法进入 GEP 模式', 'error', 4200);
      return false;
    }
    disableVertexLighting();
    // 阴影增强会把烘焙层二次压暗，GEP 模式下必须关掉
    if (window.LELighting && typeof window.LELighting.isShadowEnhanceOn === 'function') {
      try {
        if (window.LELighting.isShadowEnhanceOn()) window.LELighting.setShadowEnhance(false);
      } catch (err) {
        /* ignore */
      }
    }
    state.mode = 'gep';
    reflectUI();
    return true;
  }

  /**
   * 兜底挂载：如果 loadBuiltinDemOverlays 还没跑完（异步），
   * 直接按 data/public/dem/overlays.json 的清单挂一张烘焙层。
   */
  async function mountBakedFallback(le) {
    try {
      if (window.LETerrain && typeof window.LETerrain.mountBakedOverlay === 'function') {
        const n = await window.LETerrain.mountBakedOverlay(le);
        return n || 0;
      }
    } catch (err) {
      console.warn('[LEGepMode] 兜底挂载烘焙层失败', err);
    }
    return 0;
  }

  function enterReliefMode() {
    const le = getLE();
    setBakedVisible(false);
    // 先把 mode 切回去，再恢复浮雕光照：
    // relief.applyTo() 会检查 gepModeOn()，若此时还是 'gep' 会直接跳过、
    // 顶点光照就恢复不了。
    state.mode = 'relief';
    enableReliefLighting();
    reflectUI();
    return true;
  }

  function setMode(mode) {
    mode = mode === 'gep' ? 'gep' : 'relief';
    if (mode === state.mode) return state.mode;
    if (mode === 'gep') {
      // enterGepMode 是异步的（可能要现取 overlays.json 清单），
      // 所以立刻把 mode 标成 'gep'，否则等待期间 lighting.js 的
      // gepModeOn() 会返回 false，把 enableLighting 又拉回 true。
      // 若挂载失败，enterGepMode 会把 mode 退回 'relief'。
      state.mode = 'gep';
      enterGepMode().then((ok) => {
        if (!ok) {
          state.mode = 'relief';
          reflectUI();
        }
      });
      return state.mode;
    }
    enterReliefMode();
    return state.mode;
  }

  function toggle() {
    return setMode(state.mode === 'gep' ? 'relief' : 'gep');
  }

  function getMode() {
    return state.mode;
  }

  function isGepMode() {
    return state.mode === 'gep';
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && typeof le.toast === 'function') le.toast(msg, kind || 'ok', ms || 3000);
  }

  function reflectUI() {
    const btn = byId('gep-mode-toggle');
    if (btn) {
      const on = state.mode === 'gep';
      btn.textContent = on ? 'GEP 模式：开' : 'GEP 模式：关';
      btn.classList.toggle('tool-active', on);
      btn.title = on
        ? '当前使用烘焙影像（卫星 × 晕渲 乘法合成）并关闭顶点光照；点击切回浮雕模式'
        : '切换到 GEP 模式：烘焙影像 + 关闭顶点光照（更接近 Google Earth Pro 的观感）';
    }
    const badge = byId('gep-mode-state');
    if (badge) {
      badge.textContent = state.mode === 'gep' ? '开' : '关';
      badge.classList.toggle('on', state.mode === 'gep');
    }
  }

  function bindUI() {
    const btn = byId('gep-mode-toggle');
    if (btn && !btn.__gepBound) {
      btn.__gepBound = true;
      btn.addEventListener('click', () => toggle());
    }
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  function init(le) {
    state.le = le || state.le;
    bindUI();
    reflectUI();
    // URL 参数 ?gep=1 直接进 GEP 模式（便于 A/B 与截图复现）
    try {
      const p = new URLSearchParams(location.search).get('gep');
      if (p === '1' || p === 'true') setMode('gep');
    } catch (err) {
      /* ignore */
    }
    state.inited = true;
    return true;
  }

  function getState() {
    const viewer = viewerOf();
    const globe = viewer && viewer.scene ? viewer.scene.globe : null;
    const le = getLE();
    const baked = bakedLayers(le);
    return {
      mode: state.mode,
      enableLighting: globe ? !!globe.enableLighting : null,
      bakedCount: baked.length,
      bakedVisible: baked.length ? !!baked[0].imageryLayer.show : false,
      shadowEnhance:
        window.LELighting && typeof window.LELighting.isShadowEnhanceOn === 'function'
          ? window.LELighting.isShadowEnhanceOn()
          : null,
    };
  }

  window.LEGepMode = {
    init: init,
    setMode: setMode,
    getMode: getMode,
    isGepMode: isGepMode,
    toggle: toggle,
    getState: getState,
    isBakedName: isBakedName,
  };

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

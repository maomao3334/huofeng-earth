/*
 * 本地 3D 地形（多源 heightmap + 地形夸张 + 卫星影像）
 * - 示例区高分辨率源：data/public/dem/N25E102-terrain.json + .bin（1025² int16，102–103E / 25–26N，≈1″）
 * - 东亚源（懒加载）：data/public/dem/eastasia-terrain.json + .bin（4750×3000 int16，55–150E / 0–60N，0.02°）
 * - 全球源（懒加载）：data/public/dem/world-terrain.json + .bin（3600×1700 int16，-180–180E / -85–85N，0.1°）
 * - 通过 Cesium.CustomHeightmapTerrainProvider（33×33/瓦片，见 TERRAIN_GRID 说明）生成地形
 * - 提供 heightAt(lon,lat) 给 KML 渲染器做“箭头贴地”；地形夸张只在此处乘，保证网格与箭头一致
 * - 开启时按 world → eastasia → N25 细节 的顺序叠加坡向阴影图（N25 细节按相机高度挂载）
 * - 卫星影像：本地 Sentinel-2 cloudless（EOX，CC BY 4.0）EPSG:3857 瓦片，三级覆盖
 *   （z0–7 东亚 / z8–11 全国 / z12–14 四川盆地）
 * 完全离线，不访问网络。原始数据保留 Int16Array，双线性采样时就地换算，避免复制千万级浮点数组。
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const HIGH_META_URL = 'data/public/dem/N25E102-terrain.json';
  const HIGH_FALLBACK_FILE = 'N25E102-terrain.bin';
  const EASTASIA_META_URL = 'data/public/dem/eastasia-terrain.json';
  const EASTASIA_FALLBACK_FILE = 'eastasia-terrain.bin';
  const WORLD_META_URL = 'data/public/dem/world-terrain.json';
  const WORLD_FALLBACK_FILE = 'world-terrain.bin';

  // 随应用分发的高精度 DEM 叠加层清单（内置 30 m 级 DEM，索引几 KB、瓦片按视野懒加载）
  const BUILTIN_DEM_MANIFEST_URL = 'data/public/dem/overlays.json';

  // 每块地形瓦片的高度采样数由性能档位控制（state.grid）：
  // 低 17（289 点/瓦片，快） / 中 33（1089 点，默认） / 高 49（2401 点，细）。
  // 任何 2^n+1（或任意宽高）Provider 都兼容；这里提供 9..65 的离散档位，便于 perf 调度器调用。
  const QUALITY_GRID_DEFAULT = 33;
  const QUALITY_GRIDS = [9, 17, 25, 33, 41, 49, 57, 65];
  const QUALITY_IMAGERY_LEVELS = ['low', 'medium', 'high'];
  const EDGE_FADE_DEG = 0.005; // 示例区外边缘淡出（无更粗数据时的旧行为）
  const EASTASIA_EDGE_FADE_DEG = 0.05; // 东亚 bbox 边缘 ↔ 全球数据的平滑混合带
  const BLEND_DEG = 0.02; // 示例区 ↔ 下一级数据的边界过渡带（约 2 km）
  const WORLD_LAT_FADE_DEG = 0.1; // 全球 bbox 纬度边缘（±85°）淡出

  const EXAG_MIN = 1.0;
  const EXAG_MAX = 3.0;
  const EXAG_REBUILD_DELAY = 250; // 松手后等待重建的节流（ms）
  const EXAG_STORAGE_KEY = 'localEarth.terrainExaggeration';

  // N25 细节阴影：只在相机低于该高度（近景）时挂载，减少常驻纹理/绘制调用与显存占用
  const DETAIL_HILLSHADE_MAX_HEIGHT = 700000; // 700 km
  const DETAIL_HILLSHADE_CHECK_MS = 300; // 相机变化后延迟检查（节流）

  // 阴影图层（自底向上：world → eastasia → N25 细节）
  const WORLD_HILLSHADE_NAME = '全球地形阴影（3D 地形配套）';
  const EASTASIA_HILLSHADE_NAME = '东亚地形阴影（3D 地形配套）';
  const DETAIL_HILLSHADE_NAME = 'SRTM 地形阴影（示例区高精度）';
  // 旧版本自动阴影名，仅用于清理
  const LEGACY_HILLSHADE_NAMES = ['中国地形阴影（3D 地形配套）', 'SRTM 地形阴影（3D 地形配套）'];
  const WORLD_HILLSHADE_URL = 'data/public/dem/world-hillshade.png';
  const EASTASIA_HILLSHADE_FALLBACK_URL = 'data/public/dem/eastasia-hillshade.png';
  const N25_HILLSHADE_URL = 'data/public/dem/N25E102-hillshade.png';
  const N25_HILLSHADE_RECT = [102, 25, 103, 26];
  // 阴影层的色键：假彩色高程图里海洋被写成纯色 rgb(30,60,88)，把它抠成透明，
  // 让底图从海洋透出来（否则整幅假彩色图会盖住地球，见 syncHillshade 注释）。
  const HILLSHADE_OCEAN_KEY = [30, 60, 88];
  // 色键判定阈值：着色器比较的是「像素色与键色的最大通道差」，差值 < 阈值即判同色。
  // 阈值 6 足以吃掉 JPEG/PNG 压缩噪声，又不会误伤靠海的低洼陆地。
  const HILLSHADE_OCEAN_KEY_THRESHOLD = 6;
  // 阴影层不透明度：只做点缀，压过底图就会把地球变成一个没有地貌的蓝球。
  const HILLSHADE_OPACITY = 0.85;
  // 内置高精度叠加层（30 m GLO-30）晕渲图的不透明度。
  // 【为什么是 0.45 而不是 1.0】这张图是平铺贴图，不随地形几何起伏；
  // 全不透明时它会把 3D 地形自己的逐顶点光照整个盖住，用户就只看到一张
  // 「假彩色地图」而不是立体地形（实测：不透明时地形几何浮雕的贡献为 0）。
  // 半透明后几何浮雕透出来，贴图只负责补充 30 m 级的细部明暗。
  const OVERLAY_HILLSHADE_OPACITY = 0.45;
  const HILLSHADE_REMOVE_NAMES = [WORLD_HILLSHADE_NAME, EASTASIA_HILLSHADE_NAME, DETAIL_HILLSHADE_NAME].concat(
    LEGACY_HILLSHADE_NAMES
  );

  // 卫星影像（Sentinel-2 cloudless，EOX，CC BY 4.0；本地 EPSG:3857 瓦片）
  // 顺序自底向上：主影像（z0–7 东亚）→ 全国高清（z8–11）→ 超清（z12–14 四川盆地）
  //
  // 【Cesium 的选级机制 —— 决定一切的前提】
  // Cesium 给每个影像 provider **只选一个层级**，公式见 vendor/cesium/index.cjs 的 zmt()：
  //     level = clamp(round(log2( maxRadius * 2π * cos(lat) / (tileWidth * X0) / 地形几何误差 )),
  //                   minimumLevel, maximumLevel)
  // 其中「地形几何误差」= terrainProvider.getLevelMaximumGeometricError(地形LOD)，
  // 而 X0 与矩形宽度取自 **provider.tilingScheme**（Web Mercator 全世界），
  // **不是** provider.rectangle。所以：
  //   1) 影像层级 ≈ 地形 LOD，两者一一对应 —— 不存在「矩形太宽所以选不高级别」；
  //   2) provider.rectangle 只决定「这一级里要拉哪些瓦片」；
  //   3) **minimumLevel 向上钳制是洪水之源**：当地形 LOD < minimumLevel 时，
  //      Cesium 会把整个 provider.rectangle 在 minimumLevel 上的瓦片全部拉一遍
  //      （实测全国矩形 minLevel=9 → 一次性 6532 张 = 全国 z9 全量）。
  //
  // 因此这里的规则是：
  //   - minimumLevel 一律 0（绝不上钳，让层级自然跟随地形 LOD）；
  //   - maximumLevel 必须 <= 该矩形在磁盘上真正存在的最高层级，否则越界瓦片 404；
  //   - 每个 provider 的矩形按「该层级的磁盘覆盖范围」逐层收窄：
  //       主影像  东亚窗口(55–150E/0–60N)  → 磁盘有 z0–7
  //       全国层  中国窗口(72–136E/17–55N) → 磁盘有 z0–11（z0–7 取自东亚窗口的子集）
  //       超清层  四川窗口(101–104E/24–26.5N)→ 磁盘有 z0–14（逐级取更小窗口）
  //   - 各窗口互为包含（东亚 ⊃ 中国 ⊃ 四川），所以任何层级上请求到的瓦片都存在。
  //
  // 覆盖范围与 tools/fetch_s2_imagery.py 的下载计划严格对应：改了矩形就要重下瓦片，
  // 否则运行时是一堆 404（Cesium 会按透明处理，但白板/闪烁很明显）。
  const IMAGERY_URL = 'data/public/imagery/s2cloudless/{z}/{x}/{y}.jpg';
  const IMAGERY_CREDIT = 'Sentinel-2 cloudless by EOX IT Services GmbH (CC BY 4.0)';
  const IMAGERY_MAIN_NAME = '卫星影像（Sentinel-2 cloudless）';
  const IMAGERY_WIDE_NAME = '卫星影像·宽域高清（z8–11 全国）';
  const IMAGERY_ULTRA_NAME = '卫星影像·超清（z12–14）';
  // 预烘焙影像层（卫星 × 30 m DEM 晕渲，乘法合成）的名字前缀。
  // 【名字里必须带「烘焙」】js/lighting.js 的 isBakedName() 正则
  // /烘焙|baked/i 靠它识别，并把烘焙层排除出「阴影增强」的压暗名单；
  // js/gep-mode.js 也靠它找出烘焙层。
  const BAKED_IMAGERY_NAME_PREFIX = '预烘焙影像 · ';

  // 【在线模式】用户把左上角徽章切到「在线」时启用的全球在线影像层。
  // 同一个数据源（EOX Sentinel-2 cloudless，CC BY 4.0），只是瓦片从网上取，
  // 因此**全球任意地点**都有 z0–14 的影像，不受本机那三级缓存的窗口限制。
  // 离线模式下这个层根本不会被创建，保证一个字节都不出网。
  //
  // 【瓦片行列顺序】EOX 的 `g`（GoogleMapsCompatible）TileMatrixSet，其
  // ResourceURL 模板是 **行在前、列在后**：`.../default/g/{z}/{row}/{col}.jpg`。
  // 而 Cesium 的 UrlTemplateImageryProvider 是 **列在前、行在后**（x=col, y=row）。
  // 之前这里写成 `{z}/{x}/{y}`，等于把行列转置了：屏幕上拿到的是别的经纬度上的
  // 瓦片（比如撒哈拉沙漠的沙白被铺到印度洋上），表现就是全球视角下一片惨白、
  // 颜色数极低（实测 nearWhite 33%、唯一色 6195）。改正后 nearWhite 1.2%、
  // 唯一色 20322，与本地缓存 `{z}/{x}/{y}.jpg`（本地盘就是按 col/row 存的，
  // 见 tools/download_s2_tiles.py）完全一致。
  const IMAGERY_ONLINE_NAME = '卫星影像·在线（全球）';
  const IMAGERY_ONLINE_URL =
    (typeof window !== 'undefined' && window.HUOFENGEARTH_ONLINE_IMAGERY_URL) || '';
  const IMAGERY_LAYER_SPECS = [
    {
      name: IMAGERY_MAIN_NAME,
      // 东亚窗口：z0–7 在磁盘上完整（每个层级都覆盖 55–150E/0–60N）
      rectangle: [55, 0, 150, 60],
      minLevel: 0,
      maxLevel: 7,
      alpha: 0.92,
      opacityBlend: true,
    },
    {
      name: IMAGERY_WIDE_NAME,
      // 全国：72–136E / 17–55N（与 DEM 金字塔同一范围）
      // z0–7 的瓦片落在东亚窗口内（东亚 ⊃ 全国），z8–11 有全国窗口的瓦片
      rectangle: [72, 17, 136, 55],
      minLevel: 0,
      maxLevel: 11,
      alpha: 1.0,
    },
    {
      name: IMAGERY_ULTRA_NAME,
      // 四川盆地：z12–14 只在这一小块上有瓦片
      rectangle: [101, 24, 104, 26.5],
      minLevel: 0,
      maxLevel: 14,
      alpha: 1.0,
    },
  ];
  const IMAGERY_LAYER_NAMES = IMAGERY_LAYER_SPECS.map((spec) => spec.name)
    .concat([IMAGERY_ONLINE_NAME]);

  const state = {
    le: null,
    // 高分辨率示例区源
    high: null,
    highReady: false,
    highLoading: null,
    // 东亚源（懒加载）
    eastasia: null,
    eastasiaReady: false,
    eastasiaFailed: false,
    eastasiaLoading: null,
    // 全球源（懒加载）
    world: null,
    worldReady: false,
    worldFailed: false,
    worldLoading: null,
    // 全国分块 DEM 金字塔（js/dem-tiles.js，视口级加载）
    demTilesReady: false,
    demTilesLoading: null,
    // 内置高精度 DEM 叠加层清单（data/public/dem/overlays.json）的缓存，
    // 供 mountBakedOverlay() 兜底挂载预烘焙影像层（js/gep-mode.js 用）。
    builtinManifest: null,
    // 地形 Provider / 开关状态
    provider: null,
    providerExag: null,
    providerGrid: null,
    tilingScheme: null,
    enabled: false,
    ready: false,
    // 逐顶点地形法线（GE Pro 风格的地形起伏光照）；默认开启，
    // 置 false 可回退到官方 CustomHeightmapTerrainProvider（无顶点法线）。
    vertexNormals: true,
    // 地形夸张（只在 heightAt 出口乘，Provider 与 LEKml 贴地共用该值）
    exaggeration: 1.0,
    exagTimer: null,
    // 性能档位（setQuality）
    grid: QUALITY_GRID_DEFAULT,
    detailHillshade: true,
    imageryDetail: 'high',
    deferHeavy: false,
    heavyLoaded: false,
    heavyPromise: null,
    // 重建性能统计 / 延后重建
    rebuildPending: false,
    perf: {
      lastRebuildMs: null,
      lastRebuildAt: null,
      rebuildCount: 0,
      grid: QUALITY_GRID_DEFAULT,
      tileSamples: QUALITY_GRID_DEFAULT * QUALITY_GRID_DEFAULT,
      lastReason: null,
      // 大源被跳过的原因（'dem-covered' = 视野已被本地高精度 DEM 覆盖）
      heavySkipped: null,
    },
    // 卫星影像
    imageryEnabled: true,
    // 用户手动隐藏的自带影像层名（主影像/宽域/超清）。
    // 记录用户意图，syncImagery 时据此不把用户关掉的层重新打开。
    imageryUserHidden: [],
    // 相机高度门控的 N25 细节阴影
    detailHillshadeMounted: false,
    cameraHandlerBound: false,
    // 地形瓦片就绪监听（就绪后重新贴地）
    terrainSettledBound: false,
    terrainSettledHandler: null,
    terrainSettledTimer: null,
  };

  const existsCache = new Map();

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function smoothstep(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  function normalizeExaggeration(value) {
    const n = Number(value);
    const v = clamp(isFinite(n) ? n : 1, EXAG_MIN, EXAG_MAX);
    return Math.round(v * 10) / 10; // 与滑杆 step=0.1 一致
  }

  function readStoredExaggeration() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(EXAG_STORAGE_KEY);
      if (raw == null || raw === '') return null;
      const v = Number(raw);
      return isFinite(v) ? normalizeExaggeration(v) : null;
    } catch (err) {
      return null;
    }
  }

  function writeStoredExaggeration(value) {
    try {
      if (window.localStorage) window.localStorage.setItem(EXAG_STORAGE_KEY, String(value));
    } catch (err) {
      // 隐私模式等场景忽略
    }
  }

  /** 读取一份 heightmap 元数据 + int16 数据（保留 Int16Array，scale/offset 采样时换算）。 */
  async function loadSource(metaUrl, fallbackFile) {
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) throw new Error('地形元数据读取失败：' + metaRes.status);
    const meta = await metaRes.json();
    const base = new URL(metaUrl, location.href);
    const fileUrl = new URL(meta.file || fallbackFile, base).href;
    const binRes = await fetch(fileUrl);
    if (!binRes.ok) throw new Error('地形数据读取失败：' + binRes.status);
    const buf = await binRes.arrayBuffer();
    const count = meta.width * meta.height;
    if (buf.byteLength !== count * 2) {
      throw new Error('地形数据大小不符：' + buf.byteLength + ' != ' + count * 2);
    }
    const width = Number(meta.width);
    const height = Number(meta.height);
    const west = Number(meta.west);
    const south = Number(meta.south);
    const east = Number(meta.east);
    const north = Number(meta.north);
    return {
      meta,
      data: new Int16Array(buf),
      width,
      height,
      west,
      south,
      east,
      north,
      scale: Number(meta.scale) || 1,
      offset: Number(meta.offset) || 0,
      resolutionDeg:
        Number(meta.resolutionDeg) || (width > 1 ? (east - west) / (width - 1) : 0),
      hillshadeUrl: meta.hillshade ? new URL(meta.hillshade, base).href : null,
    };
  }

  /** 单源双线性采样；坐标先夹到 bbox 内（用于示例区边缘延拓）。 */
  function sourceHeightAt(src, lon, lat) {
    const { data, width, height, west, south, east, north, scale, offset } = src;
    const fx = clamp(((lon - west) / (east - west)) * (width - 1), 0, width - 1);
    const fy = clamp(((north - lat) / (north - south)) * (height - 1), 0, height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = x0 + 1 < width ? x0 + 1 : x0;
    const y1 = y0 + 1 < height ? y0 + 1 : y0;
    const tx = fx - x0;
    const ty = fy - y0;
    const row0 = y0 * width;
    const row1 = y1 * width;
    const v =
      data[row0 + x0] * (1 - tx) * (1 - ty) +
      data[row0 + x1] * tx * (1 - ty) +
      data[row1 + x0] * (1 - tx) * ty +
      data[row1 + x1] * tx * ty;
    return v * scale + offset;
  }

  /** bbox 边缘平滑系数：距离边界 >= fadeDeg 时为 1，边界处为 0。 */
  function edgeFade(lon, lat, src, fadeDeg) {
    const d = Math.min(lon - src.west, src.east - lon, lat - src.south, src.north - lat);
    if (d >= fadeDeg) return 1;
    if (d <= 0) return 0;
    return smoothstep(d / fadeDeg);
  }

  function inBox(src, lon, lat) {
    return !!src && lon >= src.west && lon <= src.east && lat >= src.south && lat <= src.north;
  }

  /** 到 bbox 外部的距离（内部为 0）。 */
  function outsideDistance(src, lon, lat) {
    const dx = lon < src.west ? src.west - lon : lon > src.east ? lon - src.east : 0;
    const dy = lat < src.south ? src.south - lat : lat > src.north ? lat - src.north : 0;
    return Math.hypot(dx, dy);
  }

  function rectOverlaps(src, west, east, south, north) {
    return !!src && !(east < src.west || west > src.east || north < src.south || south > src.north);
  }

  function maybeRequestEastAsia() {
    if (state.deferHeavy) return; // 延迟加载大源：只能由 loadHeavySources() 显式触发
    if (state.eastasia || state.eastasiaLoading || state.eastasiaFailed) return;
    if (!state.highReady) return;
    ensureEastAsiaLoaded(state.le).catch(() => {});
  }

  function maybeRequestWorld() {
    if (state.deferHeavy) return; // 延迟加载大源：只能由 loadHeavySources() 显式触发
    if (state.world || state.worldLoading || state.worldFailed) return;
    if (!state.highReady) return;
    ensureWorldLoaded(state.le).catch(() => {});
  }

  /* --------------------------- 分级高度（不含夸张） --------------------------- */

  /** 全球 0.1° 源；纬度 ±85° 边缘 0.1° 内淡出到 0。 */
  function worldHeightAt(lon, lat) {
    const world = state.world;
    if (!world || !inBox(world, lon, lat)) return 0;
    const v = sourceHeightAt(world, lon, lat);
    const dLat = Math.min(lat - world.south, world.north - lat);
    if (dLat >= WORLD_LAT_FADE_DEG) return v;
    return v * smoothstep(dLat / WORLD_LAT_FADE_DEG);
  }

  /** 东亚 0.02° 源；bbox 边缘 0.05° 内与全球源平滑混合（无全球源时淡出到 0）。 */
  function eastAsiaHeightAt(lon, lat) {
    const ea = state.eastasia;
    if (!ea || !inBox(ea, lon, lat)) return 0;
    const v = sourceHeightAt(ea, lon, lat);
    const dEdge = Math.min(lon - ea.west, ea.east - lon, lat - ea.south, ea.north - lat);
    const t = smoothstep(clamp(dEdge / EASTASIA_EDGE_FADE_DEG, 0, 1));
    if (t >= 1) return v;
    if (!state.world) return v * t;
    return v * t + worldHeightAt(lon, lat) * (1 - t);
  }

  /**
   * 多源组合高度（米，未乘夸张）：
   * 0) 全国分块 DEM 金字塔（LEDemTiles）—— 视口级加载；
   * 1) 示例区 1″ → 高分辨率双线性（有更粗数据时保持原值，边界过渡在外侧处理）；
   * 2) 示例区外 0.02° 过渡带 → 高分辨率边缘延拓值 ↔ 下一级源平滑混合；
   * 3) 东亚 0.02° → 东亚网格，bbox 边缘与全球 0.05° 混合；
   * 4) 全球 0.1° → 全球网格，|lat| 接近 85° 时淡出；
   * 5) 其它（|lat|>85 等）→ 0。
   *
   * 【精度优先】全国金字塔最细一层只有 0.0125°（≈1261 m/px），
   * 而示例区 1″ 源是 ≈28 m/px。旧逻辑「落在全国 bbox 内就无条件用金字塔」，
   * 于是 1″ 源永远轮不到，细小沟谷/凹地全被抹平。
   * 现在由 LEDemTiles 内部按分辨率仲裁（dem-tiles.js 的 registerFinerSource），
   * 这里把 1″ 源注册给它：金字塔发现自己比 1″ 粗时，就让 1″ 顶上来。
   */
  function rawHeightAt(lon, lat) {
    const high = state.high;
    const eastasia = state.eastasia;
    const world = state.world;

    // 0) 全国分块 DEM：命中即返回（其内部会先比精度，必要时让位给 1″ 源）
    if (window.LEDemTiles && window.LEDemTiles.covers && window.LEDemTiles.covers(lon, lat)) {
      const h = window.LEDemTiles.heightAt(lon, lat);
      if (h !== null && h !== undefined && isFinite(h)) return h;
    }

    if (high && inBox(high, lon, lat)) {
      const v = sourceHeightAt(high, lon, lat);
      return eastasia || world ? v : v * edgeFade(lon, lat, high, EDGE_FADE_DEG);
    }

    if (high) {
      const dOut = outsideDistance(high, lon, lat);
      if (dOut > 0 && dOut < BLEND_DEG) {
        const hv = sourceHeightAt(high, lon, lat);
        const t = smoothstep(dOut / BLEND_DEG); // 0=示例区边缘，1=过渡带外沿
        if (eastasia && inBox(eastasia, lon, lat)) {
          return hv * (1 - t) + eastAsiaHeightAt(lon, lat) * t;
        }
        if (world && inBox(world, lon, lat)) return hv * (1 - t) + worldHeightAt(lon, lat) * t;
      }
    }

    if (eastasia && inBox(eastasia, lon, lat)) {
      maybeRequestEastAsia();
      return eastAsiaHeightAt(lon, lat);
    }

    if (world && inBox(world, lon, lat)) {
      maybeRequestWorld();
      return worldHeightAt(lon, lat);
    }

    // 需要更粗数据但尚未加载：后台开始加载（本次仍返回 0，不阻塞渲染）
    if (!eastasia) maybeRequestEastAsia();
    if (!world) maybeRequestWorld();
    return 0;
  }

  // Measurements need source elevations even when the map is flat or exaggerated.
  // A missing sample is distinct from a valid zero-metre elevation.
  function measurementHeightAt(lon, lat) {
    const local = window.LEDemTiles?.heightAt(lon, lat);
    if (Number.isFinite(local)) return local;
    for (const source of [state.high, state.eastasia, state.world]) {
      if (inBox(source, lon, lat)) return sourceHeightAt(source, lon, lat);
    }
    return null;
  }

  async function loadMeasurementHeights(points) {
    const needsEastAsia = points.some(p => p[0] >= 55 && p[0] <= 150 && p[1] >= 0 && p[1] <= 60);
    if (needsEastAsia) await ensureEastAsiaLoaded(undefined, true);
    if (points.some(p => measurementHeightAt(p[0], p[1]) === null)) await ensureWorldLoaded(undefined, true);
  }

  /** 地形高度（米）；已乘地形夸张系数。Provider 与 KML 贴地都走这里，保证一致。 */
  function heightAt(lon, lat) {
    if (!isFinite(lon) || !isFinite(lat)) return 0;
    // 快速路径：数据尚未加载/非有限坐标直接 0，避免每个瓦片采样点走完整优先级链
    if (!state.high && !state.eastasia && !state.world && !state.demTilesReady) return 0;
    return rawHeightAt(lon, lat) * state.exaggeration;
  }

  /**
   * 地形瓦片高度网格的缓存。
   *
   * 【为什么需要】一次启动要建 ~900 个瓦片，每个瓦片 65² = 4225 个采样点，
   * 实测共 3,852,467 次 heightAt 调用（0.63 µs/次，纯 CPU 2.4 s）。
   * 而 Cesium 的 LOD 树会**反复请求同一个瓦片**（换父级、重新细分、
   * 瓦片重新入队），每次都重新采样一遍纯属浪费。
   *
   * 高度网格是 (x, y, level, grid, exaggeration) 的**纯函数** ——
   * 同样的输入必然给出同样的输出，所以缓存是安全的。
   *
   * 失效条件：改网格密度（grid）或改夸张系数（exag）→ 整表作废；
   * 换数据源（loadHeavySources）→ 整表作废。
   */
  const tileHeightCache = new Map();
  const TILE_HEIGHT_CACHE_MAX = 1200;

  function tileCacheKey(x, y, level) {
    // level ≤ 20、x/y ≤ 2^20 → 用数字键避免字符串分配
    return ((x * 1048576 + y) * 32 + level);
  }

  function clearTileHeightCache() {
    tileHeightCache.clear();
  }

  /** 返回某地形瓦片的高度数组（Float32Array，row-major，北→south，与 HeightmapTerrainData 约定一致）。 */
  function tileHeights(x, y, level, grid) {
    // 【缓存】同一瓦片被重复请求时直接复用（Cesium 的 LOD 树会反复要同一块）
    const ck = tileCacheKey(x, y, level);
    const cached = tileHeightCache.get(ck);
    if (cached && cached.length === grid * grid) return cached;

    const out = computeTileHeights(x, y, level, grid);
    if (grid === state.grid) {
      if (tileHeightCache.size >= TILE_HEIGHT_CACHE_MAX) tileHeightCache.delete(tileHeightCache.keys().next().value);
      tileHeightCache.set(ck, out);
    }
    return out;
  }

  function computeTileHeights(x, y, level, grid) {
    const scheme = state.tilingScheme;
    const rect = scheme.tileXYToRectangle(x, y, level);
    const west = C.Math.toDegrees(rect.west);
    const east = C.Math.toDegrees(rect.east);
    const south = C.Math.toDegrees(rect.south);
    const north = C.Math.toDegrees(rect.north);
    const size = grid;
    const out = new Float32Array(size * size);
    const exag = state.exaggeration;
    if (state.demTilesReady && window.LEDemTiles && window.LEDemTiles.streaming &&
        (window.LEDemTiles.overlayGrid(west,south,east,north,size,exag,out) ||
         window.LEDemTiles.fineGrid(west,south,east,north,size,exag,out))) return out;

    // 快速路径 0：瓦片完全落在全国分块 DEM 覆盖范围内 → 直接用分块源采样
    // （分块源自身按视口分级加载，命中率高；未命中的瓦片由上层 ensureRect 预取后重采样）
    if (state.demTilesReady && window.LEDemTiles && window.LEDemTiles.covers) {
      if (window.LEDemTiles.covers(west, north) && window.LEDemTiles.covers(east, south)) {
        for (let j = 0; j < size; j++) {
          const lat = north - ((north - south) * j) / (size - 1);
          const row = j * size;
          for (let i = 0; i < size; i++) {
            const lon = west + ((east - west) * i) / (size - 1);
            out[row + i] = heightAt(lon, lat);
          }
        }
        return out;
      }
    }

    // 快速路径 1：与已加载数据范围无交集 → 全 0（极区/区域外平地）
    const cover = state.world || state.eastasia || state.high;
    if (!cover) return out;
    if (!rectOverlaps(cover, west, east, south, north)) return out;

    // 快速路径 2：瓦片不与示例区/东亚相交（只会用到全球 0.1° 源）→ 直接单源采样，跳过组合分支
    if (state.world && !rectOverlaps(state.high, west, east, south, north) && !rectOverlaps(state.eastasia, west, east, south, north)) {
      for (let j = 0; j < size; j++) {
        const lat = north - ((north - south) * j) / (size - 1);
        const row = j * size;
        for (let i = 0; i < size; i++) {
          const lon = west + ((east - west) * i) / (size - 1);
          out[row + i] = worldHeightAt(lon, lat) * exag;
        }
      }
      return out;
    }

    // 快速路径 3：瓦片不与示例区相交（只会用到东亚/全球）→ 二分分支更少
    if (!rectOverlaps(state.high, west, east, south, north)) {
      for (let j = 0; j < size; j++) {
        const lat = north - ((north - south) * j) / (size - 1);
        const row = j * size;
        for (let i = 0; i < size; i++) {
          const lon = west + ((east - west) * i) / (size - 1);
          out[row + i] = (state.eastasia && inBox(state.eastasia, lon, lat) ? eastAsiaHeightAt(lon, lat) : worldHeightAt(lon, lat)) * exag;
        }
      }
      return out;
    }

    // 常规路径（示例区及其过渡带）
    // CustomHeightmapTerrainProvider/HeightmapTerrainData 约定：buffer 第一行是瓦片最北行（north→south）
    for (let j = 0; j < size; j++) {
      const lat = north - ((north - south) * j) / (size - 1);
      const row = j * size;
      for (let i = 0; i < size; i++) {
        const lon = west + ((east - west) * i) / (size - 1);
        out[row + i] = heightAt(lon, lat);
      }
    }
    return out;
  }

  /**
   * 采样调度器（帧预算批处理）。
   *
   * 【为什么需要它】实测：单瓦片采样 65×65 = 4225 个点只要 ~0.5 ms，
   * 但每次 `setTimeout(fn, 0)` 的宏任务跳转在瓦片突发期实测要等 10~100 ms。
   * 原来「每瓦片一跳」= 900 个瓦片各付一次跳转，采样阶段被拉长到数秒；
   * 而 Cesium 同一时刻并不会把这些瓦片合并处理，跳转换不来任何并行度。
   *
   * 【现在的做法】
   *   - 每帧有 SAMPLE_BUDGET_MS 的同步采样预算，预算内直接同步采样并 resolve
   *     （省掉宏任务跳转，采样阶段从秒级降到百毫秒级）；
   *   - 预算用尽就把剩余瓦片排队，用 requestAnimationFrame 在下一帧继续，
   *     主线程始终留出渲染时间，不会出现「无响应」；
   *   - 没有 rAF 可用时（后台标签页）退回 setTimeout(0)，保证不会卡死。
   *
   * 【为什么分两档预算】
   * 固定 6 ms/帧是**交互期**的预算：它保证拖动相机时主线程不被采样占满。
   * 但**启动加载期**不是交互期 —— 用户在看加载动画，不是在拖动，
   * 这段时间里主线程少让一点给渲染是划算的。
   *
   * 【实测结论：这一档对总加载时间没有影响】
   * 基准（相机 9 km、昆明、grid 65、~900 瓦片）对比 `?samplebudget=`：
   *   6 ms → 10826 ms    20 ms → 10873 ms    40 ms → 11558 ms
   * 也就是说采样**不在关键路径上**：主线程采样总耗时远小于
   * 「细分 worker 池」的耗时（worker 净 33.6 s，池全程饱和）。
   * 真正的瓶颈是 worker 数量（见 js/terrain-normals.js 的 TESS_WORKER_COUNT）
   * 和 Cesium 的 LOD 过冲（见 GEOMETRIC_ERROR_SPACING_FACTOR）。
   *
   * 所以这里保留两档预算，作用是**安全阀**而不是提速手段：
   * 加载期给主线程多一点额度，避免密集采样把渲染帧挤掉；
   * 采样突发停止后自动回落，保证之后的交互依旧顺滑。
   */
  const SAMPLE_BUDGET_MS = 6;       // 稳定期（交互优先）
  const SAMPLE_BUDGET_LOAD_MS = 14;  // 加载期（全力推进）
  const SAMPLE_WINDOW_MS = 16;      // 一帧的时长
  // 采样突发停止多久后视为「已进入稳定期」
  const LOAD_PHASE_IDLE_MS = 2000;

  /** 采样预算（毫秒）。可用 ?samplebudget= 覆盖（便于基准测试）。 */
  function resolveSampleBudgets() {
    let load = SAMPLE_BUDGET_LOAD_MS;
    let idle = SAMPLE_BUDGET_MS;
    try {
      const params = new URLSearchParams(location.search);
      const v = Number(params.get('samplebudget'));
      if (isFinite(v) && v > 0) { load = v; idle = v; }
    } catch (err) {
      /* ignore */
    }
    return { load: load, idle: idle };
  }
  const SAMPLE_BUDGETS = resolveSampleBudgets();

  /**
   * 采样队列的排空方式：'raf'（原实现）或 'macro'（setTimeout(0)）。
   * 可用 ?sampleflush= 覆盖（便于 A/B 基准测试）。
   *
   * 【第三轮的实测结论】默认保持 'raf'。
   * 直觉上 'macro'（不等下一帧）应该更快 —— 启动期 rAF 只有 ~20 Hz，
   * 349 个待采样瓦片只被 flush 了 18 次（排队等待累计 131 s）。
   * 但 5 次重复的中位数对比给出相反结果：
   *   raf   = 7955 ms
   *   macro = 8222 ms
   * 即把采样挪出帧节奏反而更慢（采样和渲染抢同一条主线程时间片，
   * 而 'raf' 版本让采样落在帧间隙里，反而被渲染流水线顺带推进）。
   * 所以「排队等待 131 s」不是瓶颈的度量：等待期间主线程并没有闲置。
   */
  function resolveSampleFlushMode() {
    try {
      const params = new URLSearchParams(location.search);
      const v = params.get('sampleflush');
      if (v === 'raf' || v === 'macro') return v;
    } catch (err) {
      /* ignore */
    }
    return 'raf';
  }
  const SAMPLE_FLUSH_MODE = resolveSampleFlushMode();

  const sampleQueue = [];
  let sampleScheduled = false;
  let sampleWindowStart = 0;
  let sampleWindowUsed = 0;
  // 最近一次收到采样任务的时刻；用来判断当前处于「加载期」还是「稳定期」
  let lastSampleRequestAt = 0;
  // 采样阶段统计（诊断用）：同步完成的次数、排队等待的总时长、实际采样耗时
  const sampleStats = {
    requests: 0,
    syncDone: 0,
    queued: 0,
    sampleMs: 0,
    queueWaitMs: 0,
    flushes: 0,
    flushItems: 0,
    flushLog: [],
  };

  /**
   * 采样任务进入队列的时刻（诊断用；与 dispatch 日志做相关性分析）。
   *
   * 上限 4000 条：入队/完成两处都会写，不设上限的话长时间运行会一直涨。
   */
  const SAMPLE_LOG_MAX = 4000;
  const sampleResolveLog = [];
  function sampleLogPush(entry) {
    // 批量淘汰而不是逐条 shift()：shift() 每次要搬 4000 个元素，
    // 在百万次采样的热路径上不划算。一次砍掉 1000 条，均摊成本可忽略。
    if (sampleResolveLog.length >= SAMPLE_LOG_MAX) sampleResolveLog.splice(0, 1000);
    sampleResolveLog.push(entry);
  }

  /** 当前应使用的采样预算（毫秒）。加载期放宽，稳定期收紧。 */
  function sampleBudgetMs() {
    return performance.now() - lastSampleRequestAt < LOAD_PHASE_IDLE_MS
      ? SAMPLE_BUDGETS.load
      : SAMPLE_BUDGETS.idle;
  }

  function flushSampleQueue() {
    sampleScheduled = false;
    if (!sampleQueue.length) return;
    const t0 = performance.now();
    const budget = sampleBudgetMs();
    // 至少处理一个，避免预算为 0 时死循环
    let n = 0;
    sampleStats.flushes += 1;
    sampleStats.flushLog.push([Math.round(t0), sampleQueue.length]);
    if (sampleStats.flushLog.length > 200) sampleStats.flushLog.shift();
    while (sampleQueue.length && (n === 0 || performance.now() - t0 < budget)) {
      const job = sampleQueue.shift();
      n += 1;
      sampleStats.flushItems += 1;
      const tJob = performance.now();
      sampleStats.queueWaitMs += tJob - job.at;
      try {
        job.fn();
      } catch (err) {
        console.warn('[LETerrain] 采样任务异常', err);
      }
      sampleStats.sampleMs += performance.now() - tJob;
      sampleLogPush([Math.round(performance.now()), 1, job.key || 0]);
    }
    if (sampleQueue.length) scheduleSampleFlush();
  }

  function scheduleSampleFlush() {
    if (sampleScheduled) return;
    sampleScheduled = true;
    if (SAMPLE_FLUSH_MODE === 'raf') {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          // rAF 回调里再走一次 setTimeout(0)，把采样挪到本帧渲染之后，
          // 避免采样与渲染在同一帧抢时间片。
          setTimeout(flushSampleQueue, 0);
        });
      } else {
        setTimeout(flushSampleQueue, 0);
      }
    } else {
      // 【第三轮：不再等下一帧】
      // 原来的 rAF → setTimeout(0) 链把采样排到了「下一帧之后」，
      // 而启动加载期主线程正忙（细分跨度内 scene.render 占 62.7%），
      // rAF 实测只有 ~20 Hz（flush 间隔 p50 = 50 ms，p90 = 349 ms）。
      // 结果：349 个待采样瓦片只被 flush 了 18 次，排队等待累计 131 s。
      // 采样是**细分派发的前置**（要先有高度才能建网格），
      // 于是整条细分流水线被这个采样节流拖住：
      // 562 次派发摊在 3.5 s 里（158 瓦片/s），而池本身能跑 715 瓦片/s。
      //
      // 改成 setTimeout(0) 宏任务：与帧率解耦，主线程一有空就排空队列。
      setTimeout(flushSampleQueue, 0);
    }
  }

  /**
   * 把一个采样任务排进预算队列。
   *
   * 关键：不能用「队列为空就同步做」当快速路径 —— 900 个瓦片在同一批里到达时，
   * 每个都会看到队列为空，从而全部同步执行（900 × 0.5 ms = 450 ms 卡顿）。
   * 正确做法是**按帧窗口限流**：每个 16 ms 窗口内最多同步采样若干 ms，
   * 超出的排队等下一帧。
   *
   * 预算取两档：加载期 14 ms（见 sampleBudgetMs 的说明），稳定期 6 ms。
   */
  function enqueueSample(fn, key) {
    const now = performance.now();
    sampleStats.requests += 1;
    // 上限统一由 sampleLogPush 处理；这里不再单独判断，
    // 否则入队记录会在日志满时静默停止，配对关系就断了。
    sampleLogPush([Math.round(now), 0, key || 0]);
    // 有新任务到达 → 说明地形瓦片还在陆续加载，处于「加载期」
    lastSampleRequestAt = now;
    if (now - sampleWindowStart >= SAMPLE_WINDOW_MS) {
      // 新的一帧窗口：预算清零
      sampleWindowStart = now;
      sampleWindowUsed = 0;
    }
    const budget = sampleBudgetMs();
    if (sampleWindowUsed < budget) {
      const t0 = performance.now();
      try {
        fn();
      } catch (err) {
        console.warn('[LETerrain] 采样异常', err);
      }
      sampleWindowUsed += performance.now() - t0;
      sampleStats.syncDone += 1;
      sampleStats.sampleMs += performance.now() - t0;
      sampleLogPush([Math.round(performance.now()), 1, key || 0]);
      return;
    }
    sampleStats.queued += 1;
    sampleQueue.push({ fn: fn, at: now, key: key || 0 });
    scheduleSampleFlush();
  }

  function createProvider() {
    if (!state.tilingScheme) state.tilingScheme = new C.GeographicTilingScheme();
    const grid = state.grid;
    // 逐顶点法线：让 Globe 走 ENABLE_VERTEX_LIGHTING 分支，产生地形起伏光照
    // （与 Google Earth Pro 的 igVertexFormatVA 逐顶点法线 + 方向光同一模型）。
    // 官方 CustomHeightmapTerrainProvider 永远拿不到顶点法线（hasVertexNormals 固定 false），
    // 因此这里改用 js/terrain-normals.js 里的子类；不可用时自动回退官方实现。
    const useNormals = state.vertexNormals !== false && window.LETerrainNormals &&
      typeof window.LETerrainNormals.createProvider === 'function' &&
      window.LETerrainNormals.isSupported();
    const Provider = useNormals
      ? function (opts) { return window.LETerrainNormals.createProvider(opts); }
      : function (opts) { return new C.CustomHeightmapTerrainProvider(opts); };
    const provider = new Provider({
      width: grid,
      height: grid,
      tilingScheme: state.tilingScheme,
      credit: 'SRTM / ETOPO / AWS Terrain Tiles (public domain, open data)',
      // 每个瓦片的高度采样延后到独立宏任务，避免大量瓦片在同一帧内同步计算造成长时间无响应；
      // Cesium 的 requestTileGeometry 支持 Promise 返回值。
      // 若该瓦片落在全国分块 DEM 范围内，先确保对应 DEM 瓦片已到达，
      // 再采样 —— 否则会采到空值造成地形「凹坑」，而且要等 Cesium 重试才恢复。
      //
      // 【采样调度（性能修复）】
      // 原来的写法是每个瓦片都 `setTimeout(sample, 0)`：一次宏任务跳转。
      // 但实测**采样本身极便宜**：单瓦片 65×65 = 4225 个采样点只要 ~0.5 ms，
      // 而一次宏任务跳转在瓦片突发期要等 10~100 ms —— 900 个瓦片各等一跳，
      // 就把「采样阶段」拉长到好几秒，而 Cesium 在同一时刻并不会批处理它们。
      //
      // 现在改成「帧预算批处理」：
      //   - 采样总预算（默认 6 ms/帧）内**同步**完成，直接 resolve；
      //   - 预算用尽则把剩余瓦片排进队列，在下一帧（rAF）继续，
      //     保证主线程始终能喘口气、渲染不被饿死；
      //   - 只有真正需要等网络的瓦片（DEM 未到位）才走 ensureRect 异步路径。
      // 这样单帧内的同步采样量有上限，同时绝大多数瓦片省掉一次宏任务跳转。
      callback: function (x, y, level) {
        return new Promise(function (resolve) {
          const sample = function () {
            let heights = null;
            try {
              heights = tileHeights(x, y, level, grid);
            } catch (err) {
              console.warn('[LETerrain] 瓦片高度采样失败', err);
            }
            resolve(heights || new Float32Array(grid * grid));
          };
          const scheme = state.tilingScheme;
          const rect = scheme.tileXYToRectangle(x, y, level);
          const west = C.Math.toDegrees(rect.west);
          const east = C.Math.toDegrees(rect.east);
          const south = C.Math.toDegrees(rect.south);
          const north = C.Math.toDegrees(rect.north);
          // 瓦片身份（诊断用）：level/x/y 打包成一个整数，便于跨阶段配对时间线
          const tileKey = ((level * 2048 + x) * 2048 + y) | 0;
          const canPreload =
            state.demTilesReady &&
            window.LEDemTiles &&
            typeof window.LEDemTiles.ensureRect === 'function' &&
            window.LEDemTiles.covers(west, north) &&
            window.LEDemTiles.covers(east, south);
          if (canPreload) {
            // 预取 DEM 瓦片（有上限，避免一次拖动拉爆网络）
            Promise.resolve(window.LEDemTiles.ensureRect(west, south, east, north, true))
              .then(function () { enqueueSample(sample, tileKey); })
              .catch(function () { enqueueSample(sample, tileKey); });
            return;
          }
          enqueueSample(sample, tileKey);
        });
      },
    });
    const dem = window.LEDemTiles;
    if (dem && dem.streaming) {
      const original = provider.requestTileGeometry;
      let sampling = 0;
      provider.requestTileGeometry = function (x, y, level, request) {
        if (level > 3 && sampling >= 20) return undefined;
        if (state.demTilesReady && level >= 8) {
          const rect = state.tilingScheme.tileXYToRectangle(x, y, level);
          const deg = C.Math.toDegrees;
          const w = deg(rect.west), s = deg(rect.south), e = deg(rect.east), n = deg(rect.north);
          // The resident one-arcsecond source precedes Terrarium in heightAt.
          if (!(inBox(state.high, w, s) && inBox(state.high, e, n)) &&
              !dem.detailReady(w,s,e,n,level)) return undefined;
        }
        const next = original.call(this, x, y, level, request);
        if (!next || typeof next.then !== 'function') return next;
        sampling++;
        return next.finally(function () { sampling--; });
      };
    }
    return provider;
  }

  function makeProvider() {
    state.provider = createProvider();
    state.providerExag = state.exaggeration;
    state.providerGrid = state.grid;
    // 几何误差上报要乘上高程夸张系数（夸张越大 → 同样的网格逼近误差越大）。
    // 不设置的话 provider 会按 exag=1 上报，LOD 选得比实际浅。
    if (state.provider && typeof state.provider.setExaggeration === 'function') {
      state.provider.setExaggeration(state.exaggeration);
    }
    // CustomHeightmapTerrainProvider 没有实现 availability（getter 函数体为空），
    // Cesium 内部 sampleTerrainMostDetailed 与相机贴地都强依赖它，缺失时会抛异常
    // 或直接跳过地形采样。补一个最小可用垫片（见 js/draping.js）。
    if (window.LEDraping && typeof window.LEDraping.installAvailabilityShim === 'function') {
      window.LEDraping.installAvailabilityShim(state.provider);
    }
    return state.provider;
  }

  function ensureTiling() {
    if (!state.provider || state.providerGrid !== state.grid || state.providerExag !== state.exaggeration) {
      makeProvider();
    }
    return state.provider;
  }

  /**
   * 重建 Provider（Cesium 只在 provider 实例变化时重新请求瓦片），并重新贴地。
   * 触发条件：夸张系数或地形网格与当前 Provider 不一致（同值不重建）。
   * 通过 requestAnimationFrame + setTimeout(0) 延后执行，避免阻塞当前滑杆/点击事件；
   * 记录重建耗时到 console.debug 与 stats().perf。
   */
  function rebuildProvider(reason, force) {
    if (!state.enabled || !state.le || !state.highReady) return false;
    const stale = function () {
      if (force) return true; // 数据源集合变化（如 loadHeavySources 后）需要强制刷新
      return !state.provider || state.providerExag !== state.exaggeration || state.providerGrid !== state.grid;
    };
    if (!stale()) return false;
    if (state.rebuildPending) return true; // 已排队，执行时取最新 grid/exag
    state.rebuildPending = true;
    const run = function () {
      state.rebuildPending = false;
      if (!state.enabled || !state.le) return;
      if (!stale()) return;
      const t0 = performance.now();
      try {
        // 网格密度 / 夸张系数 / 数据源变了 → 缓存的高度网格全部作废
        clearTileHeightCache();
        makeProvider();
        state.le.viewer.terrainProvider = state.provider;
        redrape(state.le);
        // 夸张后地形可能高于相机：重建后检查一次离地间隙，避免相机埋进山体造成卡顿
        ensureCameraClearance(state.le, 400);
        const ms = Math.round((performance.now() - t0) * 10) / 10;
        state.perf.lastRebuildMs = ms;
        state.perf.lastRebuildAt = Date.now();
        state.perf.rebuildCount += 1;
        state.perf.lastReason = reason || 'exaggeration';
        state.perf.grid = state.grid;
        state.perf.tileSamples = state.grid * state.grid;
        console.debug(
          '[LETerrain] rebuild ms=' + ms + ' grid=' + state.grid + ' exag=' + state.exaggeration + ' reason=' + (reason || 'exaggeration')
        );
        if (typeof state.le.status === 'function') {
          state.le.status('地形已重建（网格 ' + state.grid + '²，' + ms + ' ms）');
        }
      } catch (err) {
        console.warn('[LETerrain] 重建地形 Provider 失败', err);
      }
    };
    // 延后到下一帧 + 宏任务，先让当前 UI 事件（点击/滑杆松手）完成。
    // 注意：页面在后台时 requestAnimationFrame 不触发，会让 provider 重建被无限期推迟
    // （表现为 setVertexNormals 返回 true 但 provider 实际没换）。
    // 这里加一个 setTimeout 兜底：rAF 先到就用 rAF，否则超时后由定时器执行。
    let done = false;
    const once = function () {
      if (done) return;
      done = true;
      setTimeout(run, 0);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(once);
      setTimeout(once, 120);
    } else {
      setTimeout(once, 0);
    }
    return true;
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadHigh() {
    if (state.high) return state.high;
    if (state.highLoading) return state.highLoading;
    state.highLoading = (async () => {
      const src = await loadSource(HIGH_META_URL, HIGH_FALLBACK_FILE);
      state.high = src;
      state.highReady = true;
      state.ready = true;
      registerFinerSource();
      return src;
    })();
    try {
      return await state.highLoading;
    } finally {
      state.highLoading = null;
    }
  }

  /**
   * 把本模块里「比全国金字塔更细」的高程源注册给 LEDemTiles。
   *
   * 全国金字塔最细一层是 0.0125°（≈1261 m/px），而 1″ 源是 ≈28 m/px。
   * 若不注册，LEDemTiles 命中全国 bbox 就直接返回 1261 m 的值，
   * 1″ 数据永远用不上 —— 细小的凹陷、沟谷因此在 3D 地形上「消失」。
   *
   * 注册的回调遵守同一套契约：(lon, lat, maxResolutionDeg) => 高程 | null，
   * 只在「自己更细且覆盖该点」时返回值。
   */
  function registerFinerSource() {
    if (!window.LEDemTiles || typeof window.LEDemTiles.registerFinerSource !== 'function') return;
    window.LEDemTiles.registerFinerSource(function (lon, lat, maxResolutionDeg) {
      const high = state.high;
      if (!high) return null;
      const myRes = high.resolutionDeg;
      // 自己不比对方细就不出场（避免用粗源冒充精细源）
      if (!(myRes < maxResolutionDeg)) return null;
      if (!inBox(high, lon, lat)) return null;
      return sourceHeightAt(high, lon, lat);
    }, (w,s,e,n) => rectOverlaps(state.high,w,e,s,n));
  }

  /** 懒加载东亚数据（约 28.5 MB）；失败时回退到全球/示例区，并 toast 提示。 */
  async function ensureEastAsiaLoaded(le, background = false) {
    if (state.eastasia) return true;
    if (state.eastasiaFailed) return false;
    if (state.eastasiaLoading) return state.eastasiaLoading;
    if (le) state.le = le;
    const target = background ? null : state.le;
    state.eastasiaLoading = (async () => {
      if (target && typeof target.setLoading === 'function') {
        target.setLoading(true, '正在加载东亚地形数据（0.02°，约 28.5 MB）…');
      }
      if (target && typeof target.status === 'function') {
        target.status('正在加载东亚地形数据（0.02°，约 28.5 MB）…');
      }
      try {
        const src = await loadSource(EASTASIA_META_URL, EASTASIA_FALLBACK_FILE);
        state.eastasia = src;
        state.eastasiaReady = true;
        if (target && typeof target.status === 'function') {
          target.status('东亚地形数据已就绪（55–150E / 0–60N，0.02°）');
        }
        return true;
      } catch (err) {
        state.eastasiaFailed = true;
        console.error('[LETerrain] 东亚地形加载失败', err);
        if (target && typeof target.toast === 'function') {
          target.toast('东亚地形数据加载失败，已回退为全球/示例区地形：' + err.message, 'error', 6000);
        }
        if (target && typeof target.status === 'function') {
          target.status('东亚地形不可用，3D 地形仅覆盖全球/示例区', 'error');
        }
        return false;
      } finally {
        if (target && typeof target.setLoading === 'function') target.setLoading(false);
        state.eastasiaLoading = null;
      }
    })();
    return state.eastasiaLoading;
  }

  /** 懒加载全球数据（约 12 MB）；失败时继续用东亚/示例区，并 toast 提示。 */
  async function ensureWorldLoaded(le, background = false) {
    if (state.world) return true;
    if (state.worldFailed) return false;
    if (state.worldLoading) return state.worldLoading;
    if (le) state.le = le;
    const target = background ? null : state.le;
    state.worldLoading = (async () => {
      if (target && typeof target.setLoading === 'function') {
        target.setLoading(true, '正在加载全球地形数据（0.1°，约 12 MB）…');
      }
      if (target && typeof target.status === 'function') {
        target.status('正在加载全球地形数据（0.1°，约 12 MB）…');
      }
      try {
        const src = await loadSource(WORLD_META_URL, WORLD_FALLBACK_FILE);
        state.world = src;
        state.worldReady = true;
        if (target && typeof target.status === 'function') {
          target.status('全球地形数据已就绪（-180–180E / -85–85N，0.1°）');
        }
        return true;
      } catch (err) {
        state.worldFailed = true;
        console.error('[LETerrain] 全球地形加载失败', err);
        if (target && typeof target.toast === 'function') {
          target.toast('全球地形数据加载失败，已回退为东亚/示例区地形：' + err.message, 'error', 6000);
        }
        if (target && typeof target.status === 'function') {
          target.status('全球地形不可用，3D 地形仅覆盖东亚/示例区', 'error');
        }
        return false;
      } finally {
        if (target && typeof target.setLoading === 'function') target.setLoading(false);
        state.worldLoading = null;
      }
    })();
    return state.worldLoading;
  }

  /** 首次开启地形时按需加载：东亚 → 全球（约 40 MB），并可被 loadHeavySources() 外部触发。 */
  async function ensureTerrainSources(le) {
    if (le) state.le = le;
    try {
      // 【性能】两个大源并行下载：原来是串行 await（东亚 28.5 MB 下载完才开始全球 12.2 MB），
      // 实测两者都在 4~6 s 内就绪，并行后省掉一段串行等待。
      await Promise.all([ensureEastAsiaLoaded(state.le), ensureWorldLoaded(state.le)]);
    } finally {
      state.heavyLoaded = true;
    }
    return state.eastasiaReady || state.worldReady;
  }

  /**
   * 当前视野是否已经被「本地高精度 DEM」完全覆盖。
   *
   * 【为什么要判断这个 —— 40 MB 大源多数时候是白下载的】
   *
   * 东亚源（0.02°，55–150E / 0–60N，28.5 MB）和全球源（0.1°，12.2 MB）
   * 是「粗」数据：0.02° ≈ 2.2 km/px，0.1° ≈ 11 km/px。
   * 而本机自带的全国分块 DEM 金字塔最细一层是 0.0125°（≈1.4 km/px），
   * 叠加层更是 30 m 级 —— 也就是说**对全国范围内的任何视角，
   * 分块金字塔/叠加层都比这两个大源更精细**。
   *
   * 实测（相机 9 km、昆明、1280×800）：
   *   带大源   settledMs = 15853
   *   不带大源 settledMs = 10051     ← 一样快，还省了 40 MB 网络与内存
   *
   * 所以大源只在「视野超出本地 DEM 覆盖范围」时才值得下载
   * （例如飞到境外、飞到极区、或飞到金字塔 72–136E / 17–55N 之外）。
   */
  function heavySourcesNeeded(le) {
    const target = le || state.le;
    // 明确关闭（?heavy=0）时一律不加载
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('heavy') === '0') return false;
    } catch (err) {
      /* ignore */
    }
    // 本地 DEM 覆盖已就绪 → 用视口矩形判断
    if (state.demTilesReady && window.LEDemTiles && typeof window.LEDemTiles.covers === 'function') {
      const rect = currentViewRect(target);
      if (rect) {
        // 四个角都在本地 DEM 覆盖内 → 视野完全被更精细的本地数据覆盖
        const c = window.LEDemTiles.covers;
        const inside =
          c(rect.west, rect.north) &&
          c(rect.east, rect.north) &&
          c(rect.west, rect.south) &&
          c(rect.east, rect.south);
        if (inside) {
          state.perf.heavySkipped = 'dem-covered';
          return false;
        }
      }
    }
    state.perf.heavySkipped = null;
    return true;
  }

  /** 当前视野的经纬矩形（度）；拿不到时返回 null。 */
  function currentViewRect(le) {
    const target = le || state.le;
    if (!target || !target.viewer || !target.viewer.scene) return null;
    try {
      const scene = target.viewer.scene;
      const camera = target.viewer.camera;
      let rect = null;
      try {
        rect = camera.computeViewRectangle(scene.globe.ellipsoid);
      } catch (err) {
        rect = null;
      }
      if (!rect) return null;
      const w = C.Math.toDegrees(rect.west);
      const e = C.Math.toDegrees(rect.east);
      const s = C.Math.toDegrees(rect.south);
      const n = C.Math.toDegrees(rect.north);
      if (!isFinite(w) || !isFinite(e) || !isFinite(s) || !isFinite(n)) return null;
      // 视野横跨整个球面时无法判断，一律当作「需要」
      if (e - w > 300 || n - s > 150) return null;
      return { west: w, east: e, south: s, north: n };
    } catch (err) {
      return null;
    }
  }

  /**
   * 显式加载东亚 + 全球大源（供性能调度器在空闲时调用；deferHeavy=true 时不会自动加载）。
   * 返回 Promise<{eastasia, world}>；失败已由 ensure* 内部 toast/回退，不再抛出。
   * 完成后刷新 provider（新源参与地形采样）与阴影/影像层顺序。
   */
  async function loadHeavySources(le) {
    if (le) state.le = le;
    if (state.heavyPromise) return state.heavyPromise;
    if (state.heavyLoaded && state.eastasiaReady && state.worldReady) {
      return { eastasia: true, world: true };
    }
    // 【性能】视野已被本地高精度 DEM 覆盖 → 不下载 40 MB 大源。
    // 例外：已经加载过（或正在加载）就照常走完，避免状态不一致。
    if (!state.eastasia && !state.eastasiaLoading && !state.world && !state.worldLoading) {
      if (!heavySourcesNeeded(state.le)) {
        state.heavyLoaded = true;
        return { eastasia: false, world: false };
      }
    }
    const target = state.le;
    state.heavyPromise = (async () => {
      try {
        await ensureTerrainSources(target);
      } catch (err) {
        console.warn('[LETerrain] 大范围地形加载失败（已回退）', err);
      } finally {
        state.heavyPromise = null;
      }
      if (state.enabled && state.le) {
        // 【性能】这里**不能**再无脑 rebuildProvider('heavy-sources', true)。
        // 换 provider 会让 Cesium 的 globe.terrainProvider setter 调
        // quadtree.invalidateAllTiles() → **所有已经建好的瓦片全部作废重来**。
        // 实测：provider 在 t=2553 ms 设过一次，大源在 t=5460 ms 就绪，
        // t=5499 ms 又设一次 → 前面建好的几百个瓦片全部白建，
        // 单这一项就占掉约 1.5 s（15853 → 14232 ms）。
        //
        // 现在改成：只有当新源**真的会改变采样结果**时才重建。
        // 具体判据见 heavySourcesChangeHeights()。
        if (heavySourcesChangeHeights()) {
          rebuildProvider('heavy-sources', true);
        } else {
          // 采样结果不变 → 网格不用重建，但阴影层仍需按新源同步
          console.debug('[LETerrain] 大源已就绪但不影响当前视野采样，跳过 Provider 重建');
        }
        syncTerrainLayers(state.le);
      }
      return { eastasia: state.eastasiaReady, world: state.worldReady };
    })();
    return state.heavyPromise;
  }

  /**
   * 新加载的大源是否会改变当前视野的采样高度。
   *
   * 大源（东亚 0.02° / 全球 0.1°）只在「本地 DEM 没覆盖的地方」才有意义。
   * 采样优先级（见 rawHeightAt）是：
   *   本地分块 DEM/叠加层 > 示例区 1″ > 东亚 0.02° > 全球 0.1°
   * 所以只要当前视野**完全**被本地 DEM 覆盖，大源加进来也不会改变任何一个采样值，
   * 重建 Provider 就是纯粹的浪费（而且代价是作废全部瓦片）。
   */
  function heavySourcesChangeHeights() {
    if (!state.demTilesReady || !window.LEDemTiles || typeof window.LEDemTiles.covers !== 'function') {
      return true; // 拿不准 → 保守重建
    }
    const rect = currentViewRect(state.le);
    if (!rect) return true;
    const c = window.LEDemTiles.covers;
    const inside =
      c(rect.west, rect.north) &&
      c(rect.east, rect.north) &&
      c(rect.west, rect.south) &&
      c(rect.east, rect.south);
    return !inside;
  }

  /* ------------------------------ 卫星影像（三级覆盖） ------------------------------ */

  function findImageryLayer(le, name) {
    const layers = (le && le.listLayers && le.listLayers()) || [];
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].name === name) return layers[i];
    }
    return null;
  }

  function addImageryLayer(le, spec) {
    if (!le || !le.viewer || !C.UrlTemplateImageryProvider) return null;
    const existing = findImageryLayer(le, spec.name);
    if (existing) return existing;
    const isOnline = !!spec.online;
    // EOX Sentinel-2 cloudless 为 EPSG:3857（Web Mercator）瓦片，256×256 JPEG
    // 【spec.url 覆盖】默认用本地 S2 缓存（IMAGERY_URL）或在线源；
    // 预烘焙层（卫星 × 晕渲）走自己的 URL，所以这里允许 spec.url 覆盖。
    const url = spec.url || (isOnline ? IMAGERY_ONLINE_URL : IMAGERY_URL);
    const provider = new C.UrlTemplateImageryProvider({
      url: url,
      tilingScheme: new C.WebMercatorTilingScheme(),
      rectangle: C.Rectangle.fromDegrees(spec.rectangle[0], spec.rectangle[1], spec.rectangle[2], spec.rectangle[3]),
      minimumLevel: spec.minLevel,
      maximumLevel: spec.maxLevel,
      tileWidth: 256,
      tileHeight: 256,
      // 数据覆盖外/缺失的 JPEG 瓦片按透明处理，避免在蓝马赛克底图上出现白色方块
      hasAlphaChannel: true,
      credit: spec.credit || IMAGERY_CREDIT,
    });
    // 低层级/范围外瓦片缺失时按透明处理，避免 Cesium 抛错刷屏（浏览器网络日志仍可能显示 404）
    try {
      provider.errorEvent.addEventListener(function (err) {
        console.debug('[LETerrain] imagery tile unavailable (' + spec.name + '): ' + (err && err.message ? err.message : err));
      });
    } catch (err) {
      /* ignore */
    }
    const imageryLayer = le.viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.alpha = spec.alpha;
    imageryLayer.show = true;
    const entry = le.registerLayer({
      name: spec.name,
      type: 'imagery',
      imageryLayer,
      remove: () => le.viewer.imageryLayers.remove(imageryLayer, true),
      zoomTo: () =>
        le.flyTo({
          rectangle: C.Rectangle.fromDegrees(spec.rectangle[0], spec.rectangle[1], spec.rectangle[2], spec.rectangle[3]),
        }),
    });
    // 注册到图层栈：自带卫星影像属于「系统层」，永远排在用户导入层之下。
    // 【orderKind】预烘焙影像层用 'baked'（排名 2.5），必须压在超清层之上 ——
    //   它只覆盖一小块区域，区域外的像素要靠超清层兜底。
    if (window.LELayerOrder) window.LELayerOrder.addSystem(entry, spec.orderKind || 'satellite');
    return entry;
  }

  function removeAllImageryLayers(le) {
    for (let i = 0; i < IMAGERY_LAYER_NAMES.length; i++) {
      const entry = findImageryLayer(le, IMAGERY_LAYER_NAMES[i]);
      if (entry) {
        try {
          le.removeLayer(entry.id);
        } catch (err) {
          console.warn('[LETerrain] 移除卫星影像失败', err);
        }
        if (window.LELayerOrder) window.LELayerOrder.remove(entry);
      }
    }
  }

  /** 当前 imageryDetail 档位启用的影像层（low: 主影像；medium: 主+宽域；high: 三层）。 */
  function activeImagerySpecs() {
    const count = state.imageryDetail === 'low' ? 1 : state.imageryDetail === 'medium' ? 2 : 3;
    const specs = IMAGERY_LAYER_SPECS.slice(0, count);
    // 在线模式：额外叠一层全球在线影像（覆盖范围不受本地窗口限制）
    if (onlineEnabled()) specs.push(ONLINE_SPEC);
    return specs;
  }

  /**
   * 在线影像层是否开启。
   *
   * 【为什么只看显式的「在线」档】LEOnlineStatus.getMode() 默认是 'auto'，
   * 而 auto 模式下 canUseNetwork() 在联网机器上返回 true —— 于是这颗全球在线
   * 瓦片层**默认就挂上了**，既违反「完全离线」的要求（标准 6），又因为它被
   * addSystem(...,'satellite') 推到图层栈顶端而盖住其它层。
   * 现在改成：只有用户明确把徽章切到「在线」档才启用这一层。
   */
  function onlineEnabled() {
    if (!IMAGERY_ONLINE_URL) return false;
    if (!window.LEOnlineStatus) return false;
    if (typeof window.LEOnlineStatus.getMode === 'function') {
      try {
        return window.LEOnlineStatus.getMode() === 'online';
      } catch (err) {
        return false;
      }
    }
    // 没有 getMode 的旧接口：退回 canUseNetwork（此时无法区分 auto，显式在线语义交给上层）
    if (typeof window.LEOnlineStatus.canUseNetwork !== 'function') return false;
    try { return !!window.LEOnlineStatus.canUseNetwork(); } catch (err) { return false; }
  }

  const ONLINE_SPEC = {
    name: IMAGERY_ONLINE_NAME,
    rectangle: [-180, -85.0511, 180, 85.0511],
    minLevel: 0,
    maxLevel: 14,
    alpha: 1.0,
    online: true,
  };

  /**
   * 把当前档位启用的影像层按 主→宽域→超清 的相对顺序整理好。
   *
   * 【重要】这里**不再**直接调用 imageryLayers.raiseToTop()。
   * 过去每次相机变化都会调用它，把自带卫星影像硬压到最顶层，
   * 于是：① 用户导入的图层没法置顶；② 置顶了，一缩放又被压下去。
   *
   * 现在改为把「期望栈序」交给 LELayerOrder 统一维护：
   * 系统层（阴影 / 卫星影像）内部相对有序，但永远排在用户层之下；
   * 用户在图层面板里的手工排序会被完整保留。
   */
  function raiseActiveImagery(le) {
    le = le || state.le;
    if (!le || !le.viewer || !le.viewer.imageryLayers || !state.imageryEnabled) return;
    if (!window.LELayerOrder) return;
    try {
      // 把当前仍存在的系统层补登记进图层栈，再由图层栈统一写回 Cesium。
      window.LELayerOrder.adoptOrphans();
      window.LELayerOrder.apply();
    } catch (err) {
      console.warn('[LETerrain] 整理影像层级失败', err);
    }
  }

  /** 保证当前档位的影像层存在、可见，并按 主影像 → 宽域高清 → 超清 的顺序叠放。 */
  function syncImagery(le) {
    le = le || state.le;
    if (!le || !le.viewer) return;
    if (!state.imageryEnabled) {
      removeAllImageryLayers(le);
      return;
    }
    const active = activeImagerySpecs();
    const activeNames = active.map((spec) => spec.name);
    // 该档位不需要的层移除（保证 low/medium/high 切换后图层数量正确、去重）
    for (let i = 0; i < IMAGERY_LAYER_NAMES.length; i++) {
      const name = IMAGERY_LAYER_NAMES[i];
      if (activeNames.indexOf(name) !== -1) continue;
      const extra = findImageryLayer(le, name);
      if (extra) {
        try {
          le.removeLayer(extra.id);
        } catch (err) {
          console.warn('[LETerrain] 移除影像层失败', err);
        }
        if (window.LELayerOrder) window.LELayerOrder.remove(extra);
      }
    }
    for (let i = 0; i < active.length; i++) {
      const spec = active[i];
      const entry = addImageryLayer(le, spec);
      if (!entry) continue;
      // 可见性以**用户的操作**为准：用户在图层面板里手动关掉的层，
      // 不因为缩放/画质切换被重新打开（这是「自带影像关不掉」的老 bug）。
      const userHidden = state.imageryUserHidden.indexOf(spec.name) !== -1;
      const on = !userHidden;
      if (typeof entry.setVisible === 'function') entry.setVisible(on);
      else if (entry.imageryLayer) entry.imageryLayer.show = on;
      if (entry.imageryLayer) entry.imageryLayer.alpha = spec.alpha;
    }
    // 最后统一整理一次层级（内部相对顺序），不再抢用户层的顶。
    raiseActiveImagery(le);
  }

  /**
   * 记录用户对某个自带影像层的显隐操作。
   * 供图层面板调用：用户手动关掉某个卫星影像层后，syncImagery 不再把它打开。
   */
  function setImageryLayerVisible(name, on) {
    if (!name) return false;
    const idx = state.imageryUserHidden.indexOf(name);
    if (on && idx !== -1) state.imageryUserHidden.splice(idx, 1);
    else if (!on && idx === -1) state.imageryUserHidden.push(name);
    const entry = findImageryLayer(state.le, name);
    if (entry) {
      if (typeof entry.setVisible === 'function') entry.setVisible(!!on);
      else if (entry.imageryLayer) entry.imageryLayer.show = !!on;
    }
    return true;
  }

  /** 侧栏「卫星影像」开关；返回切换后的启用状态（同时控制主影像/宽域/超清三层）。 */
  function toggleImagery(le) {
    le = le || state.le;
    if (!le) return state.imageryEnabled;
    // 以 state.imageryEnabled 为唯一真值来源。
    // 过去这里判断「任一图层是否可见」，用户手动关掉某个层后，
    // 再点开关反而变成「开」，越点越乱。
    if (state.imageryEnabled) {
      state.imageryEnabled = false;
      removeAllImageryLayers(le);
    } else {
      state.imageryEnabled = true;
      syncImagery(le);
    }
    return state.imageryEnabled;
  }

  /* ------------------------------ 阴影图层 ------------------------------ */

  /**
   * 探测资源是否存在。
   *
   * 【为什么不用 HEAD】
   *   早期用 fetch(url, {method:'HEAD'})。但本地服务器对 HEAD 会回
   *   Content-Length 却不写 body，在 HTTP/2 下 Chromium 直接把这条请求
   *   标记成 net::ERR_ABORTED（应用层其实收到了 200）。
   *   隐患是：只要服务器对 HEAD 的处理稍有不同（代理、超时、chunked），
   *   fetch 就会抛错、这里就判定「文件不存在」，阴影层**静默不挂载**——
   *   表现就是地球又变回没有地形起伏的样子，而且没有任何报错。
   *   改用 Range 请求只取 1 个字节：服务端普遍支持 Range（serve.ps1 也支持），
   *   既能确认真实存在，又不下载整个 PNG（世界晕渲图有 800 KB+）。
   */
  async function urlExists(url) {
    if (existsCache.has(url)) return existsCache.get(url);
    let ok = false;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
      });
      // 206 = 服务器支持 Range 并正常返回；200 = 不支持 Range 但文件在
      ok = !!(res && (res.status === 200 || res.status === 206));
      // 把这一小段读完再结束（206 只有 1 字节）。不要提前 cancel()：
      // 主动中断流会让 Chromium 把它记成一条 net::ERR_ABORTED 的失败请求，
      // 在网络面板和自动化测试里都是噪声。
      if (res && res.arrayBuffer) { try { await res.arrayBuffer(); } catch (e) { /* ignore */ } }
    } catch (err) {
      ok = false;
    }
    existsCache.set(url, ok);
    return ok;
  }

  function findHillshadeLayer(le, name) {
    const layers = (le && le.listLayers && le.listLayers()) || [];
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].name === name) return layers[i];
    }
    return null;
  }

  /**
   * 判断已挂载的阴影层是否已经符合期望规格（用于差量同步）。
   *
   * 比对项：provider 的 URL、矩形、透明度、色键。
   * 其中色键必须比对**实际写入 Cesium 的值**：写入前做过 sRGB→线性换算，
   * 所以这里用同样的换算函数重算一遍再比，避免「看起来一样但实际不同」。
   */
  function hillshadeSpecMatches(entry, spec) {
    if (!entry || !entry.imageryLayer) return false;
    const layer = entry.imageryLayer;
    const provider = layer.imageryProvider;
    if (!provider) return false;

    const url = String((provider._resource && provider._resource.url) || provider._url || '');
    if (!url || url.indexOf(spec.url) === -1) return false;

    // 矩形（provider 里是弧度，spec 里是度）
    const rect = provider.rectangle;
    if (rect) {
      const want = spec.rectangle;
      const DEG = 57.29577951308232;
      const eps = 0.02;
      if (Math.abs(rect.west * DEG - want[0]) > eps || Math.abs(rect.south * DEG - want[1]) > eps ||
          Math.abs(rect.east * DEG - want[2]) > eps || Math.abs(rect.north * DEG - want[3]) > eps) {
        return false;
      }
    }

    // 透明度
    const wantAlpha = spec.opacity != null ? spec.opacity : 1;
    if (Math.abs((layer.alpha == null ? 1 : layer.alpha) - wantAlpha) > 0.001) return false;

    // 色键
    if (spec.colorToAlpha == null) {
      if (layer.colorToAlpha) return false;
    } else {
      if (!layer.colorToAlpha) return false;
      const want = window.LELayers && window.LELayers.toCesiumColor
        ? window.LELayers.toCesiumColor(spec.colorToAlpha, true)
        : null;
      if (!want) return false;
      if (Math.abs(layer.colorToAlpha.red - want.color.red) > 1e-6) return false;
      if (Math.abs(layer.colorToAlpha.green - want.color.green) > 1e-6) return false;
      if (Math.abs(layer.colorToAlpha.blue - want.color.blue) > 1e-6) return false;
      const wantT = window.LELayers && window.LELayers.linearThresholdFromSrgbDelta
        ? window.LELayers.linearThresholdFromSrgbDelta(want.rgb255,
            spec.colorToAlphaThreshold != null ? spec.colorToAlphaThreshold : 0)
        : null;
      if (wantT != null && Math.abs((layer.colorToAlphaThreshold || 0) - wantT) > 1e-9) return false;
    }
    return true;
  }

  function removeHillshadeLayers(le) {
    const layers = (le.listLayers && le.listLayers()) || [];
    for (let i = 0; i < layers.length; i++) {
      if (HILLSHADE_REMOVE_NAMES.indexOf(layers[i].name) !== -1) {
        try {
          le.removeLayer(layers[i].id);
        } catch (err) {
          console.warn('[LETerrain] 移除地形阴影失败', err);
        }
      }
    }
    state.detailHillshadeMounted = false;
  }

  function cameraHeightOf(le) {
    try {
      return le.viewer.camera.positionCartographic.height;
    } catch (err) {
      return 0;
    }
  }

  function detailHillshadeAllowed(le) {
    // 性能档位（detailHillshade=false 时低档不挂）+ 相机高度（远景无细节需求）
    return state.detailHillshade && cameraHeightOf(le) <= DETAIL_HILLSHADE_MAX_HEIGHT;
  }

  function mountDetailHillshade(le) {
    if (state.detailHillshadeMounted) return;
    if (!state.highReady || !window.LELayers || typeof window.LELayers.addImageOverlay !== 'function') return;
    if (findHillshadeLayer(le, DETAIL_HILLSHADE_NAME)) {
      state.detailHillshadeMounted = true;
      return;
    }
    window.LELayers.addImageOverlay(le, {
      name: DETAIL_HILLSHADE_NAME,
      url: N25_HILLSHADE_URL,
      rectangle: N25_HILLSHADE_RECT,
      opacity: 1.0,
      orderKind: 'hillshade',
    });
    state.detailHillshadeMounted = true;
  }

  function unmountDetailHillshade(le) {
    if (!state.detailHillshadeMounted) return;
    const entry = findHillshadeLayer(le, DETAIL_HILLSHADE_NAME);
    if (entry) {
      try {
        le.removeLayer(entry.id);
      } catch (err) {
        console.warn('[LETerrain] 移除细节阴影失败', err);
      }
    }
    state.detailHillshadeMounted = false;
  }

  /** 相机离地安全抬升：夸张后地形可能高于相机（例如 6 km 高度、地面 2 km×3×），否则会出现“埋进山体”的瓦片风暴/卡死。 */
  function ensureCameraClearance(le, minClearance) {
    le = le || state.le;
    if (!le || !state.enabled || !le.viewer) return false;
    try {
      const cam = le.viewer.camera;
      const carto = cam.positionCartographic;
      if (!carto) return false;
      const lon = C.Math.toDegrees(carto.longitude);
      const lat = C.Math.toDegrees(carto.latitude);
      const ground = heightAt(lon, lat); // 已含夸张
      const clearance = minClearance == null ? 400 : minClearance;
      if (!isFinite(ground) || carto.height >= ground + clearance) return false;
      const newHeight = ground + clearance;
      const heading = cam.heading;
      const pitch = cam.pitch;
      const roll = cam.roll;
      cam.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, newHeight),
        orientation: { heading: heading, pitch: pitch, roll: roll },
      });
      console.debug('[LETerrain] camera clearance lift: ' + Math.round(carto.height) + 'm -> ' + Math.round(newHeight) + 'm (ground ' + Math.round(ground) + 'm)');
      return true;
    } catch (err) {
      console.warn('[LETerrain] 相机离地安全检查失败', err);
      return false;
    }
  }

  /** 相机高度跨阈值时挂载/卸载 N25 细节阴影（近景才需要，远景减少纹理与绘制调用）。 */
  function syncDetailHillshade(le) {
    le = le || state.le;
    if (!le || !state.enabled) return;
    const params = new URLSearchParams(location.search);
    if (params.get('hillshade') === '0') return;
    ensureCameraClearance(le, 400);
    if (detailHillshadeAllowed(le)) {
      const wasMounted = state.detailHillshadeMounted;
      mountDetailHillshade(le);
      // 只有阴影层**新挂上**时才需要整理一次层级。
      // 过去这里无条件调用 syncImagery()，而它会被每次相机变化触发，
      // 于是自带卫星影像被反复「复活 + 提到最顶层」——
      // 这正是「自带影像关不掉」「用户图层置顶后一缩放又下沉」的根因。
      if (!wasMounted) raiseActiveImagery(le);
    } else {
      unmountDetailHillshade(le);
    }
  }

  /**
   * 监听「地形瓦片全部就绪」，就绪后重新贴地一次。
   *
   * 【为什么必须有】导入 KMZ 的瞬间地形瓦片往往还没建好，贴地高度只能基于
   * 解析 DEM（与渲染面差几米），旧实现里甚至会基于 Cesium 在瓦片未就绪时
   * 返回的垃圾射线拾取值（实测 −2368 m），整片沉到地平线以下。
   * 这些高度一旦固化进 Primitive / Entity 的顶点就再也不会更新，
   * 于是表现为「KMZ 贴地显示坏掉」。
   *
   * Cesium 没有「地形加载完成」事件，但 globe.tilesLoaded 是实时布尔量：
   * 从 false 变 true 表示所有可见瓦片都已就绪，此时重贴一次即可对齐渲染面。
   * tileLoadProgressEvent 作为事件源（更及时），轮询作为兜底。
   */
  function bindTerrainSettled(le) {
    if (state.terrainSettledBound || !le || !le.viewer) return;
    const globe = le.viewer.scene && le.viewer.scene.globe;
    if (!globe) return;
    state.terrainSettledBound = true;
    let settled = false;
    let timer = null;
    let lastDrapeAt = 0;
    // 最短重贴地间隔：地形是流式加载的，每加载完一批瓦片就会再次「就绪」，
    // 不限流的话一次地形加载会触发十几次全量重贴地（每次要重造全部 Primitive）。
    const MIN_DRAPE_INTERVAL_MS = 3000;

    const onSettled = function () {
      if (settled) return;
      settled = true;
      // 稍等一拍再贴：确保 Cesium 已经把新瓦片的网格建好并可插值
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, lastDrapeAt + MIN_DRAPE_INTERVAL_MS - performance.now());
      timer = setTimeout(function () {
        timer = null;
        if (!state.enabled) return;
        lastDrapeAt = performance.now();
        console.debug('[LETerrain] 地形瓦片已就绪，重新贴地');
        redrape(state.le || le);
      }, Math.max(500, wait));
    };
    const onProgress = function (queueLength) {
      if (queueLength) settled = false;
      else onSettled();
    };
    try {
      globe.tileLoadProgressEvent.addEventListener(onProgress);
      state.terrainSettledHandler = onProgress;
    } catch (err) {
      console.debug('[LETerrain] 地形就绪监听失败（将用轮询兜底）', err);
    }
    // 轮询兜底：某些情况下 tileLoadProgressEvent 不触发
    state.terrainSettledTimer = setInterval(function () {
      try {
        if (globe.tilesLoaded) onSettled();
        else settled = false;
      } catch (err) {
        /* ignore */
      }
    }, 2000);
  }

  function bindCameraTierChanges(le) {
    if (state.cameraHandlerBound || !le || !le.viewer) return;
    state.cameraHandlerBound = true;
    let timer = null;
    const handler = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        syncDetailHillshade(le);
        // 全国分块 DEM：按相机高度换层并预取视野瓦片
        if (state.demTilesReady && window.LEDemTiles && typeof window.LEDemTiles.updateForCamera === 'function') {
          try {
            window.LEDemTiles.updateForCamera(le);
          } catch (err) {
            console.debug('[LETerrain] 分块 DEM 预取失败', err);
          }
        }
      }, DETAIL_HILLSHADE_CHECK_MS);
    };
    try {
      le.viewer.camera.changed.addEventListener(handler);
    } catch (err) {
      console.warn('[LETerrain] 相机高度监听失败', err);
    }
  }

  /**
   * 3D 地形开启时按 world → eastasia → N25 细节 的顺序叠加阴影图。
   * 关闭 / ?hillshade=0 时全部移除；按名称去重，避免重复叠加。
   * N25 细节只在相机低于 DETAIL_HILLSHADE_MAX_HEIGHT 时挂载（降低远景纹理/绘制开销）。
   *
   * 【为什么这三张图不能不透明地铺满地球】
   *   这三张 PNG 不是灰色晕渲，而是**假彩色高程图**：海洋被写成纯色 rgb(30,60,88)
   *   （世界图 63% 的像素、东亚图 42% 的像素都是这个颜色），陆地上是渐变的绿→红。
   *   过去以 opacity 1.0 整幅贴上去，等于用一张「假彩色海洋」把整个地球盖住：
   *   默认全球视角下测到 uniqueColors 只有 2707（单看阴影层），看上去是一个
   *   没有地貌的蓝色球 —— 这正是「打开后地球图像有问题」的成因。
   *
   * 【现在的做法】
   *   1) colorToAlpha = rgb(30,60,88) + 阈值 6：把海洋像素抠成全透明，
   *      底图（NASA 蓝马赛克）从海洋处透出来，陆地保留起伏着色；
   *   2) opacity 0.85：阴影只做点缀，不再压掉底图细节；
   *   3) N25 细节图是纯高程配色（无海洋色），不做色键，保持不透明以免近景发虚。
   *
   * 【差量同步：为什么不再「先删后装」】
   *   旧实现每次都 removeHillshadeLayers() 再逐个 addImageOverlay()。
   *   但 syncHillshade() 会被调用多次（apply() 的加载完成回调、
   *   loadHeavySources()、性能档位切换…），于是：
   *     · 第二次同步会把**第一次还没加载完**的 PNG 请求 abort 掉
   *       （浏览器控制台可见 net::ERR_ABORTED），再重新下载一遍；
   *     · 屏幕上表现为阴影层「闪一下才稳定」；
   *     · 大 PNG（世界晕渲图有好几 MB）白下载一次。
   *   现在改成**按名称比对规格**：规格没变就原样保留（不重建、不重下），
   *   只有 URL / 矩形 / 透明度 / 色键真的变了才替换那个层。
   */
  async function syncHillshade(le, on) {
    try {
      if (!on) {
        removeHillshadeLayers(le);
        return;
      }
      const params = new URLSearchParams(location.search);
      if (params.get('hillshade') === '0') {
        removeHillshadeLayers(le);
        return;
      }
      if (!window.LELayers || typeof window.LELayers.addImageOverlay !== 'function') return;

      const overlays = [];

      // 1) 全球底图阴影
      if (state.worldReady && state.world) {
        const url = state.world.hillshadeUrl || WORLD_HILLSHADE_URL;
        if (await urlExists(url)) {
          overlays.push({
            name: WORLD_HILLSHADE_NAME,
            url,
            rectangle: [state.world.west, state.world.south, state.world.east, state.world.north],
            opacity: HILLSHADE_OPACITY,
            colorToAlpha: HILLSHADE_OCEAN_KEY,
            colorToAlphaThreshold: HILLSHADE_OCEAN_KEY_THRESHOLD,
            orderKind: 'hillshade',
          });
        }
      }

      // 2) 东亚 0.02° 覆盖
      if (state.eastasiaReady && state.eastasia) {
        const url = state.eastasia.hillshadeUrl || EASTASIA_HILLSHADE_FALLBACK_URL;
        if (await urlExists(url)) {
          overlays.push({
            name: EASTASIA_HILLSHADE_NAME,
            url,
            rectangle: [state.eastasia.west, state.eastasia.south, state.eastasia.east, state.eastasia.north],
            opacity: HILLSHADE_OPACITY,
            colorToAlpha: HILLSHADE_OCEAN_KEY,
            colorToAlphaThreshold: HILLSHADE_OCEAN_KEY_THRESHOLD,
            orderKind: 'hillshade',
          });
        }
      }

      // 3) 示例区 N25 高精度细节（近景才挂载，≈54 m/px）
      if (detailHillshadeAllowed(le) && (await urlExists(N25_HILLSHADE_URL))) {
        overlays.push({
          name: DETAIL_HILLSHADE_NAME,
          url: N25_HILLSHADE_URL,
          rectangle: N25_HILLSHADE_RECT,
          opacity: 1.0,
          orderKind: 'hillshade',
        });
        state.detailHillshadeMounted = true;
      }

      if (!overlays.length) {
        removeHillshadeLayers(le);
        return;
      }
      // 异步检查期间地形可能已被关闭，避免“关了又出现阴影层”
      if (!state.enabled) return;

      // 差量同步：规格相同的层保留不动，只替换真正变化的层。
      const wanted = new Map();
      for (const o of overlays) wanted.set(o.name, o);

      // 1) 换掉规格已经变化的层
      for (const name of Array.from(wanted.keys())) {
        const spec = wanted.get(name);
        const existing = findHillshadeLayer(le, name);
        if (!existing) continue;
        if (hillshadeSpecMatches(existing, spec)) {
          wanted.delete(name);   // 已经是期望状态，不用动
          continue;
        }
        try {
          le.removeLayer(existing.id);
        } catch (err) {
          console.warn('[LETerrain] 替换地形阴影层失败', err);
        }
      }

      // 2) 移除已经不该存在的层（例如细节图超出挂载条件）
      const layers = (le.listLayers && le.listLayers()) || [];
      for (let i = 0; i < layers.length; i++) {
        const nm = layers[i].name;
        if (HILLSHADE_REMOVE_NAMES.indexOf(nm) === -1) continue;
        if (wanted.has(nm)) continue;
        try {
          le.removeLayer(layers[i].id);
        } catch (err) {
          console.warn('[LETerrain] 移除地形阴影失败', err);
        }
      }
      state.detailHillshadeMounted = !!findHillshadeLayer(le, DETAIL_HILLSHADE_NAME);

      // 3) 补上缺的层
      for (const overlay of wanted.values()) {
        window.LELayers.addImageOverlay(le, overlay);
        if (overlay.name === DETAIL_HILLSHADE_NAME) state.detailHillshadeMounted = true;
      }
    } catch (err) {
      console.warn('[LETerrain] 阴影图同步失败', err);
    }
  }

  /** 阴影层全部就绪后，把卫星影像提到最上层（确保“影像在地形阴影之上”）。 */
  async function syncTerrainLayers(le) {
    await syncHillshade(le, true);
    syncImagery(le);
  }

  /* ------------------------------ 开关与初始化 ------------------------------ */

  function redrape(le) {
    // 顺序很重要：必须**先**失效瓦片索引，再重算贴地。
    // 旧实现是「先贴地、后 invalidate」，于是重贴地用的还是**上一轮**的瓦片索引
    // （旧层级/旧数据），算出来的高度和当前渲染面对不上 —— 表现为贴地要素
    // 仍然沉在地下或浮在半空。
    if (window.LEDraping && typeof window.LEDraping.invalidate === 'function') {
      try {
        window.LEDraping.invalidate();
      } catch (err) {
        /* ignore */
      }
    }
    if (window.LEKml && typeof window.LEKml.redrape === 'function') {
      try {
        window.LEKml.redrape(le.viewer);
      } catch (err) {
        console.warn(err);
      }
    }
    // 绘制内容（点/线/面）同样需要重新贴地 —— 地形开关、夸张系数、DEM 层级变化后，
    // 之前按旧高度摆放的顶点会埋进地下或浮在空中。
    if (window.LEDraw && typeof window.LEDraw.redrape === 'function') {
      try {
        window.LEDraw.redrape();
      } catch (err) {
        console.warn(err);
      }
    }
  }

  function apply(le) {
    le = le || state.le;
    if (!le) return false;
    if (!state.highReady) return false;

    // 直接调用 apply（未经过 init/toggle）时，后台懒加载更粗的源，就绪后刷地形瓦片；
    // deferHeavy=true（性能档位）时绝不自动加载大源，等 loadHeavySources() 显式触发。
    //
    // 【为什么要分成两条互斥的路】
    //   syncTerrainLayers() 会先 removeHillshadeLayers() 再把阴影层重新挂一遍，
    //   如果这里既立即调用一次、又在大源加载完成后再调用一次，阴影层就会被
    //   「拆了装、装了拆」，屏幕上表现为地形阴影闪一下才稳定。
    //   所以：需要补加载大源时，只在加载完成回调里同步；不需要时，当场同步一次。
    const eaMissing = !state.eastasia && !state.eastasiaFailed;
    const worldMissing = !state.world && !state.worldFailed;
    const willLoadSources = !state.deferHeavy && (eaMissing || worldMissing);
    if (willLoadSources) {
      ensureTerrainSources(le)
        .then((ok) => {
          if (state.enabled && state.le) {
            if (ok) {
              // 【性能】只有当大源真的改变了采样结果时才换 provider。
              // 换 provider = quadtree.invalidateAllTiles() = 所有已建瓦片作废重来。
              // 视野若已被本地高精度 DEM 覆盖，大源加进来也不改变任何采样值，
              // 此时重建纯属浪费（实测约 1.5 s）。
              if (heavySourcesChangeHeights()) {
                try {
                  makeProvider();
                  state.le.viewer.terrainProvider = state.provider;
                } catch (err) {
                  console.warn(err);
                }
              } else {
                console.debug('[LETerrain] 大源已就绪但不影响当前视野采样，跳过 Provider 重建');
              }
            }
            syncTerrainLayers(state.le);
            redrape(state.le);
          }
        })
        .catch(() => {
          // 大源加载失败也要把已就绪的部分（阴影/影像）铺上，否则地球是空的。
          if (state.enabled && state.le) {
            syncTerrainLayers(state.le);
            redrape(state.le);
          }
        });
    }

    le.viewer.terrainProvider = ensureTiling();
    le.viewer.scene.globe.depthTestAgainstTerrain = true;
    // 粗网格地形在掠射角下会因背面剔除露出黑洞；关闭背面剔除后显示真实地表
    le.viewer.scene.globe.backFaceCulling = false;
    state.enabled = true;
    // 地形浮雕光照：打开 globe.enableLighting 之后 Cesium 才会编译
    // ENABLE_VERTEX_LIGHTING，逐顶点法线才会真正参与着色（否则地形完全不受光）。
    if (window.LETerrainRelief && typeof window.LETerrainRelief.applyTo === 'function') {
      window.LETerrainRelief.applyTo(le);
    }
    bindCameraTierChanges(le);
    bindTerrainSettled(le);
    if (!willLoadSources) {
      syncTerrainLayers(le);
      redrape(le);
    }

    const parts = [];
    if (state.worldReady) parts.push('全球 0.1°');
    if (state.eastasiaReady) parts.push('东亚 0.02°');
    parts.push('示例区 1″');
    const exagDesc = state.exaggeration !== 1 ? '，夸张 ' + state.exaggeration.toFixed(1) + '×' : '';
    const heavyDesc = state.deferHeavy && !state.eastasiaReady && !state.worldReady ? '，大范围地形按需加载' : '';
    if (typeof le.status === 'function') {
      le.status('3D 地形已开启（' + parts.join(' + ') + '，网格 ' + state.grid + '²' + exagDesc + heavyDesc + '；箭头按地形高度贴地）');
    }
    return true;
  }

  function disable(le) {
    le = le || state.le;
    if (!le) return;
    le.viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    le.viewer.scene.globe.depthTestAgainstTerrain = false;
    le.viewer.scene.globe.backFaceCulling = true;
    state.enabled = false;
    syncHillshade(le, false);
    state.detailHillshadeMounted = false;
    redrape(le);
    if (typeof le.status === 'function') le.status('3D 地形已关闭（椭球地形）');
  }

  async function ensureLoaded(le) {
    if (le) state.le = le;
    await loadHigh();
    return state.highReady;
  }

  /**
   * 挂载「数据仓库」里导入的高精度 DEM（js/vault.js 生成的金字塔）。
   *
   * 数据源：data/local/dem/sources.json —— 仓库每次挂载 DEM 都往这里追加一条。
   * 每条形如：
   *   { id, name, bbox:[w,s,e,n], index:'data/local/dem/<id>/index.json',
   *     base:'data/local/dem/<id>/' }
   *
   * 挂载后由 js/dem-tiles.js 的 overlay 机制负责加载与采样，
   * **优先级高于**全国分块金字塔（导入的精度通常更高）。
   *
   * 失败不影响主流程：本地数据缺失是正常情况。
   */
  async function loadVaultDemOverlays(le) {
    if (!window.LEDemTiles || typeof window.LEDemTiles.addOverlay !== 'function') return 0;
    let list = null;
    try {
      const res = await fetch('data/local/dem/sources.json', { cache: 'no-cache' });
      if (!res.ok) return 0;
      list = await res.json();
    } catch (err) {
      return 0;
    }
    if (!list || !Array.isArray(list.sources) || !list.sources.length) return 0;

    let n = 0;
    for (const spec of list.sources) {
      if (!spec || !spec.index) continue;
      const ov = await window.LEDemTiles.addOverlay({
        id: spec.id,
        name: spec.name,
        index: spec.index,
        base: spec.base || '',
      });
      if (ov) n++;
    }
    if (n && le && typeof le.status === 'function') {
      le.status('已挂载本地高精度 DEM：' + n + ' 份');
    }
    console.debug('[LETerrain] 本地 DEM 叠加层：' + n);
    return n;
  }

  /**
   * 挂载**随应用分发**的高精度 DEM 叠加层（data/public/dem/overlays.json）。
   *
   * 与 loadVaultDemOverlays 的区别：后者读的是「数据仓库」里用户自己导入的
   * （data/local/，本机专属、版本库忽略）；这里读的是**内置**清单，
   * 随数据包一起分发，索引只有几 KB，瓦片按视野懒加载。
   *
   * 为什么要内置：全国分块金字塔最细一层是 0.0125°（≈1261 m/px），
   * 自己的源瓦片只有 Terrarium z11（≈76 m/px），再细的细节就丢了；
   * 而高程叠加层能把昆明这类区域拉到 30 m，沟谷与凹地才看得出来。
   *
   * 清单形如：
   *   { "sources": [ { "id", "name", "index", "base", "hillshade", "bbox" } ] }
   */
  async function loadBuiltinDemOverlays(le) {
    if (!window.LEDemTiles || typeof window.LEDemTiles.addOverlay !== 'function') return 0;
    let list = null;
    try {
      const res = await fetch(BUILTIN_DEM_MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) return 0;
      list = await res.json();
    } catch (err) {
      return 0;
    }
    if (!list || !Array.isArray(list.sources) || !list.sources.length) return 0;
    state.builtinManifest = list;

    let n = 0;
    for (const spec of list.sources) {
      if (!spec || !spec.index) continue;
      const ov = await window.LEDemTiles.addOverlay({
        id: spec.id,
        name: spec.name,
        index: spec.index,
        base: spec.base || '',
      });
      if (!ov) continue;
      n++;
      // 叠加层自带晕渲图时挂一张阴影层（Cesium 的 heightmap 路径给不出顶点法线，
      // 地形起伏只能靠晕渲图参与着色，见 write_hillshade 的说明）。
      if (spec.hillshade && typeof window.LELayers !== 'undefined' &&
          typeof window.LELayers.addImageOverlay === 'function') {
        mountOverlayHillshade(le, spec);
      }
      // 叠加层自带**预烘焙影像**（卫星 × 逐像元晕渲）时挂一张影像层。
      // 这是 GEP 观感的核心：Cesium 没有 blendMode，乘法合成只能预烘焙。
      if (spec.baked) {
        mountBakedImagery(le, spec);
      }
    }
    if (n) console.debug('[LETerrain] 内置高精度 DEM 叠加层：' + n);
    return n;
  }

  /**
   * 兜底挂载预烘焙影像层。
   *
   * js/gep-mode.js 在用户点「GEP 模式」时调用：内置叠加层清单
   * （loadBuiltinDemOverlays 是异步的）可能还没处理完，
   * 这里自己取清单（缓存过就复用）再挂。
   * @returns {Promise<number>} 挂上的层数
   */
  async function mountBakedOverlay(le) {
    le = le || state.le;
    if (!le || !le.viewer) return 0;
    let list = state.builtinManifest;
    if (!list) {
      try {
        const res = await fetch(BUILTIN_DEM_MANIFEST_URL, { cache: 'no-cache' });
        if (!res.ok) return 0;
        list = await res.json();
        state.builtinManifest = list;
      } catch (err) {
        return 0;
      }
    }
    if (!list || !Array.isArray(list.sources)) return 0;
    let n = 0;
    for (const spec of list.sources) {
      if (!spec || !spec.baked) continue;
      if (mountBakedImagery(le, spec)) n++;
    }
    return n;
  }

  /**
   * 挂载预烘焙影像层（卫星 × 30 m DEM 晕渲，乘法合成）。
   *
   * 【为什么是「叠在超清层之上」而不是替换超清层】
   *   实测：913 张烘焙瓦片**全部**落在超清层的 rectangle [101,24,104,26.5] 内
   *   （z12–14），而超清层本身有 17526 张 z14 瓦片。
   *   烘焙实际只覆盖 lon 102.13~102.68 / lat 24.77~25.40（约 0.55° × 0.63°）。
   *   如果用烘焙层**替换**超清层，超清层其余区域的 z14 瓦片就没人提供，
   *   Cesium 会一路掉到 z11 —— 出现明显的**分辨率断崖**。
   *   所以：烘焙层作为**额外一层**叠在超清层之上（alpha=1），
   *   区域外仍由超清层兜底，区域内被烘焙层完全覆盖。
   *
   * 【层序】用 LELayerOrder.addSystem(entry, 'baked') 登记，
   *   排名 2.5 → **压在**超清层（satellite，排名 2）之上。
   *   烘焙层只覆盖一小块区域，区域外的像素要靠超清层兜底；
   *   若烘焙层排在超清层**下面**，区域内看到的是普通卫星影像，烘焙就白做了。
   *
   * 【默认不显示】烘焙层默认 show=false —— 它只在 GEP 模式（js/gep-mode.js）
   *   打开时才可见，默认仍是「卫星 + 顶点光照」的浮雕模式。
   */
  function mountBakedImagery(le, spec) {
    try {
      if (!spec.baked || !spec.baked.url) return null;
      const name = BAKED_IMAGERY_NAME_PREFIX + (spec.name || spec.id);
      if (findImageryLayer(le, name)) return findImageryLayer(le, name);
      // 【路径解析】baked.url 是**根相对**路径（data/public/imagery/...），
      // 不能拿 DEM 的 base（data/public/dem/overlays/kunming-glo30/）当基准，
      // 否则会拼成 data/public/dem/overlays/data/public/imagery/... 而 404。
      // 所以以应用根（location.href）为基准解析。
      const url = new URL(spec.baked.url, location.href).href;
      const bbox = spec.baked.bbox || spec.bbox;
      if (!bbox) return null;
      const entry = addImageryLayer(le, {
        name: name,
        url: url,
        rectangle: bbox,
        minLevel: spec.baked.minLevel != null ? spec.baked.minLevel : 12,
        maxLevel: spec.baked.maxLevel != null ? spec.baked.maxLevel : 14,
        alpha: 1,
        credit: IMAGERY_CREDIT,
        orderKind: 'baked',
      });
      if (!entry) return null;
      entry.terrainManaged = true;
      // 默认隐藏：GEP 模式才打开（js/gep-mode.js 的 enterGepMode 会设 show=true）
      try {
        entry.imageryLayer.show = false;
      } catch (err) {
        /* ignore */
      }
      console.debug('[LETerrain] 已挂载预烘焙影像层：' + name);
      return entry;
    } catch (err) {
      console.warn('[LETerrain] 预烘焙影像层挂载失败：' + (spec.name || spec.id), err);
      return null;
    }
  }

  /** 给一份内置叠加层挂上它的晕渲图（同一区域已有层则跳过）。 */
  function mountOverlayHillshade(le, spec) {
    try {
      if (!spec.hillshade || !spec.bbox) return;
      const name = '高精度地形阴影 · ' + (spec.name || spec.id);
      if (findHillshadeLayer(le, name)) return;
      const url = new URL(spec.hillshade, new URL(spec.base || '', location.href)).href;
      window.LELayers.addImageOverlay(le, {
        name: name,
        url: url,
        rectangle: spec.bbox,
        // 【为什么不再是不透明 1.0】
        // 过去这层是 opacity=1.0 的整幅假彩色晕渲图，直接盖在 30 m DEM 区域上。
        // 它有两宗罪：
        //   1) 它是**平铺在地球表面的贴图**，不随地形几何起伏，
        //      所以用户看到的「沟壑 / 丘陵的立体感」其实来自这张图，而不是 3D 地形；
        //   2) 它完全不透明，把 3D 地形自己的逐顶点光照结果整个盖掉，
        //      于是真几何的浮雕一点也看不出来。
        // 现在改成半透明（OVERLAY_HILLSHADE_OPACITY），让几何浮雕透出来；
        // 同时它仍然保留在「阴影」层位（orderKind: 'hillshade'），排在卫星影像之下。
        opacity: OVERLAY_HILLSHADE_OPACITY,
        orderKind: 'hillshade',
      });
    } catch (err) {
      console.warn('[LETerrain] 内置晕渲图挂载失败：' + (spec.name || spec.id), err);
    }
  }

  async function toggle(le) {
    le = le || state.le;
    if (!le) return;
    if (state.enabled) {
      disable(le);
      return false;
    }
    await ensureLoaded(le);
    // 首次开启时懒加载东亚 + 全球数据（约 40 MB）；deferHeavy 时只加载 N25，等 loadHeavySources()
    if (!state.deferHeavy) {
      await ensureTerrainSources(le);
    }
    return apply(le);
  }

  async function init(le) {
    state.le = le;
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('imagery') === '0') state.imageryEnabled = false;

      // 逐顶点地形法线（GE Pro 风格的地形起伏光照）：URL ?vn=0 可关闭做 A/B 对照
      const vnParam = params.get('vn');
      if (vnParam === '0' || vnParam === 'false' || vnParam === 'off') {
        state.vertexNormals = false;
      }

      // 地形夸张：URL ?exag= 优先于 localStorage
      const exagParam = params.get('exag');
      if (exagParam != null && exagParam !== '') {
        const v = Number(exagParam);
        if (isFinite(v)) state.exaggeration = normalizeExaggeration(v);
      } else {
        const stored = readStoredExaggeration();
        if (stored != null) state.exaggeration = stored;
      }

      await ensureLoaded(le);

      // 全国分块 DEM 金字塔：索引只有几 KB，立即可用；
      // 实际瓦片按相机视野在后台逐块拉取，不阻塞首屏。
      if (params.get('demtiles') !== '0' && window.LEDemTiles) {
        state.demTilesLoading = Promise.resolve(window.LEDemTiles.init())
          .then(function (idx) {
            state.demTilesReady = !!idx;
            // 挂载本地导入的高精度 DEM（叠加在全国金字塔之上，优先级更高）
            loadVaultDemOverlays(le).then(function () {
              // 内置高精度 DEM（随数据包分发）同样挂成叠加层
              return loadBuiltinDemOverlays(le);
            }).then(function () {
              // 叠加 DEM 挂上后，之前按「无 overlay」算出的高度网格作废
              clearTileHeightCache();
              if (window.LEDemTiles.updateForCamera) window.LEDemTiles.updateForCamera(le);
            });
            if (idx && window.LEDemTiles.updateForCamera) {
              window.LEDemTiles.updateForCamera(le);
            }
            return idx;
          })
          .catch(function () {
            state.demTilesReady = false;
            return null;
          });
      }

      if (params.get('terrain') !== '0') {
        // deferHeavy=true（性能档位）：只 await N25（≈2.1MB），不 await 东亚/全球（≈40MB）；
        // 大范围地形由 LEPerf 空闲时调用 loadHeavySources() 触发。
        if (!state.deferHeavy) {
          await ensureTerrainSources(le);
        }
        apply(le);
      } else {
        // 不开启地形时仍可按需显示卫星影像（独立图层）
        syncImagery(le);
      }
    } catch (err) {
      console.error('[LETerrain] 初始化失败', err);
      if (le && typeof le.toast === 'function') {
        le.toast('3D 地形加载失败：' + err.message, 'error', 5000);
      }
    }

    // 跟随「在线 / 离线」工作模式：模式一变，立刻把在线影像层加上或撤掉。
    if (window.LEOnlineStatus && typeof window.LEOnlineStatus.onChange === 'function') {
      window.LEOnlineStatus.onChange(function () {
        syncImagery(le);
      });
    }
  }

  /* ------------------------------ 夸张设置 ------------------------------ */

  function setExaggeration(value) {
    const next = normalizeExaggeration(value);
    // 先持久化（拖动/重置都记忆），再由节流重建 Provider
    writeStoredExaggeration(next);
    if (next === state.exaggeration) return state.exaggeration;
    state.exaggeration = next;
    if (state.exagTimer) clearTimeout(state.exagTimer);
    state.exagTimer = setTimeout(() => {
      state.exagTimer = null;
      rebuildProvider();
    }, EXAG_REBUILD_DELAY);
    return state.exaggeration;
  }

  function getExaggeration() {
    return state.exaggeration;
  }

  /* ------------------------------ 性能档位 ------------------------------ */

  function normalizeGrid(value) {
    const n = Number(value);
    if (!isFinite(n)) return state.grid;
    let best = QUALITY_GRIDS[0];
    let bestD = Infinity;
    for (let i = 0; i < QUALITY_GRIDS.length; i++) {
      const d = Math.abs(QUALITY_GRIDS[i] - n);
      if (d < bestD) {
        bestD = d;
        best = QUALITY_GRIDS[i];
      }
    }
    return best;
  }

  function normalizeImageryDetail(value) {
    const s = String(value == null ? '' : value).toLowerCase();
    return QUALITY_IMAGERY_LEVELS.indexOf(s) !== -1 ? s : state.imageryDetail;
  }

  /** deferHeavy 关闭后，若地形已开启且大源尚未加载，则后台补加载（不阻塞调用方）。 */
  function maybeTriggerHeavyLoad() {
    if (state.deferHeavy) return;
    if (state.eastasiaReady && state.worldReady) return;
    if (!state.enabled || !state.highReady) return;
    loadHeavySources(state.le).catch(() => {});
  }

  /**
   * 性能档位 API（供 js/perf.js 调用，init 之前调用也安全：只记录配置，不重建/不加载）：
   *   setQuality({ grid: 17|33|49, detailHillshade: boolean, imageryDetail: 'low'|'medium'|'high', deferHeavy: boolean })
   * 返回是否已生效（配置被接受）；grid 变化的 Provider 重建异步/延后执行。
   */
  function setQuality(options) {
    if (!options || typeof options !== 'object') return false;
    let changed = false;
    let gridChanged = false;
    let detailChanged = false;
    let imageryChanged = false;
    let deferChanged = false;

    if (options.grid != null) {
      const g = normalizeGrid(options.grid);
      if (g !== state.grid) {
        state.grid = g;
        gridChanged = true;
        changed = true;
      }
    }
    if (options.detailHillshade != null) {
      const d = !!options.detailHillshade;
      if (d !== state.detailHillshade) {
        state.detailHillshade = d;
        detailChanged = true;
        changed = true;
      }
    }
    if (options.imageryDetail != null) {
      const lv = normalizeImageryDetail(options.imageryDetail);
      if (lv !== state.imageryDetail) {
        state.imageryDetail = lv;
        imageryChanged = true;
        changed = true;
      }
    }
    if (options.deferHeavy != null) {
      const d = !!options.deferHeavy;
      if (d !== state.deferHeavy) {
        state.deferHeavy = d;
        deferChanged = true;
        changed = true;
      }
    }
    if (!changed) return true;

    state.perf.grid = state.grid;
    state.perf.tileSamples = state.grid * state.grid;

    // init 之前（state.le 为空）只记录配置：不建 Provider、不加载数据，避免拖慢首屏
    if (state.le && state.enabled) {
      if (gridChanged) rebuildProvider('quality-grid');
      if (detailChanged) syncDetailHillshade(state.le);
      if (imageryChanged) syncImagery(state.le);
      raiseActiveImagery(state.le);
      // 重建/挂载可能延后到下一帧：再补一次置顶，保证阴影层不会压住影像
      setTimeout(() => {
        if (state.le && state.enabled) raiseActiveImagery(state.le);
      }, 350);
    } else if (state.le) {
      if (imageryChanged) syncImagery(state.le);
      // grid/detail 在下次 apply（开启地形）时按新配置创建
    }
    if (deferChanged && !state.deferHeavy) maybeTriggerHeavyLoad();
    return true;
  }

  function getQuality() {
    return {
      grid: state.grid,
      detailHillshade: state.detailHillshade,
      imageryDetail: state.imageryDetail,
      deferHeavy: state.deferHeavy,
    };
  }

  /* ------------------------------ 公开 API ------------------------------ */

  function sourceStats(src) {
    if (!src) return null;
    return {
      bbox: [src.west, src.south, src.east, src.north],
      width: src.width,
      height: src.height,
      resolutionDeg: src.resolutionDeg,
      minHeight: src.meta.minHeight,
      maxHeight: src.meta.maxHeight,
      rowOrder: src.meta.rowOrder,
      file: src.meta.file,
      hillshade: src.hillshadeUrl,
    };
  }

  function sourceState(src, ready, failed, loading) {
    return {
      ready,
      failed,
      loading: !!loading,
      source: sourceStats(src),
    };
  }

  function imageryStats(le) {
    const layers = IMAGERY_LAYER_SPECS.map((spec) => {
      const entry = findImageryLayer(le, spec.name);
      return {
        name: spec.name,
        rectangle: spec.rectangle,
        minLevel: spec.minLevel,
        maxLevel: spec.maxLevel,
        alpha: spec.alpha,
        present: !!entry,
        visible: entry ? entry.visible !== false : false,
      };
    });
    return {
      enabled: state.imageryEnabled,
      quality: state.imageryDetail,
      layers,
      layer: !!findImageryLayer(le, IMAGERY_MAIN_NAME),
      url: IMAGERY_URL,
      credit: IMAGERY_CREDIT,
    };
  }

  window.LETerrain = {
    init,
    ensureLoaded,
    apply,
    disable,
    toggle,
    heightAt,
    measurementHeightAt,
    loadMeasurementHeights,
    isEnabled: () => state.enabled,
    isReady: () => state.ready,
    setExaggeration,
    getExaggeration,
    rebuildProvider,
    /**
     * 开关「逐顶点地形法线」（GE Pro 风格的地形起伏光照）。
     * 切换后需要重建 Provider 并重新请求瓦片。
     */
    setVertexNormals: function (on) {
      const next = !!on;
      if (state.vertexNormals === next) return false;
      state.vertexNormals = next;
      rebuildProvider('vertex-normals', true);
      return true;
    },
    hasVertexNormals: () => !!state.vertexNormals,
    toggleImagery,
    isImageryEnabled: () => state.imageryEnabled,
    // 兜底挂载预烘焙影像层（js/gep-mode.js 在用户点「GEP 模式」时调用）
    mountBakedOverlay,
    setImageryLayerVisible,
    setQuality,
    getQuality,
    loadHeavySources,
    stats: () => ({
      ready: state.ready,
      enabled: state.enabled,
      exaggeration: state.exaggeration,
      quality: getQuality(),
      grid: state.grid,
      sampleStats: sampleStats,
      sampleResolveLog: sampleResolveLog,
      heavyLoaded: state.heavyLoaded,
      heavyLoading: !!state.heavyPromise,
      providerGrid: state.providerGrid,
      perf: {
        lastRebuildMs: state.perf.lastRebuildMs,
        lastRebuildAt: state.perf.lastRebuildAt,
        rebuildCount: state.perf.rebuildCount,
        lastReason: state.perf.lastReason,
        heavySkipped: state.perf.heavySkipped,
        grid: state.perf.grid,
        tileSamples: state.perf.tileSamples,
        providerExag: state.providerExag,
        providerGrid: state.providerGrid,
        rebuildPending: state.rebuildPending,
      },
      loading: {
        high: !!state.highLoading,
        eastasia: !!state.eastasiaLoading,
        world: !!state.worldLoading,
      },
      // 全国分块 DEM 金字塔（视口级加载）
      demTiles: state.demTilesReady && window.LEDemTiles
        ? window.LEDemTiles.stats()
        : { ready: false },
      // 兼容旧字段：默认返回示例区源信息
      meta: state.high
        ? {
            bbox: [state.high.west, state.high.south, state.high.east, state.high.north],
            width: state.high.width,
            height: state.high.height,
            minHeight: state.high.meta.minHeight,
            maxHeight: state.high.meta.maxHeight,
          }
        : null,
      high: sourceStats(state.high),
      eastasia: sourceState(state.eastasia, state.eastasiaReady, state.eastasiaFailed, state.eastasiaLoading),
      // 兼容旧字段（内容为东亚源；china-terrain 文件保留但不再加载）
      china: sourceState(state.eastasia, state.eastasiaReady, state.eastasiaFailed, state.eastasiaLoading),
      world: sourceState(state.world, state.worldReady, state.worldFailed, state.worldLoading),
      imagery: imageryStats(state.le),
      detailHillshadeMounted: state.detailHillshadeMounted,
      provider: state.provider ? state.provider.constructor.name : null,
      tilingScheme: state.tilingScheme ? state.tilingScheme.constructor.name : null,
    }),
  };
})();

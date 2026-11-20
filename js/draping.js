/*
 * 贴地（drape）公共工具
 * ---------------------------------------------------------------------------
 * 背景：本地地形用的是 Cesium 的 CustomHeightmapTerrainProvider。这个 Provider
 * **没有实现 availability**（Cesium 源码里 getter 的函数体是空的），而 Cesium 内部
 * 有两处强依赖 provider.availability：
 *   1) sampleTerrainMostDetailed / _sampleTerrainMostDetailed —— 直接
 *      `availability.computeMaximumLevelAtPosition(...)`，availability 为 undefined 时
 *      抛 `Cannot read properties of undefined`；
 *   2) 相机贴地飞行 —— availability 为 undefined 时**直接跳过地形采样**。
 * 因此本模块做两件事：
 *
 * A) installAvailabilityShim(provider)
 *    给 Provider 补一个最小可用的 availability（computeMaximumLevelAtPosition /
 *    isTileAvailable / computeChildMaskForTile），恢复 Cesium 原生的
 *    sampleTerrainMostDetailed 与相机贴地。
 *
 * B) 网格精确采样器 groundHeightAt(lon, lat)
 *    「解析 DEM」与「用户看到的渲染面」之间存在最大 ~135 m 的偏差（分块 DEM 边界
 *    附近最明显），用它做贴地高度会导致内容沉到地下或浮在空中 —— 这正是
 *    「打开起伏地形后绘制内容/导入 KMZ 看不见」的根因。
 *    本采样器**优先**读取已渲染地形瓦片的 terrainData.interpolateHeight()，
 *    即 Cesium 自己用于渲染网格顶点的那套高度，实测与 globe.getHeight 误差
 *    ≤ 0.10 m，且快 56 倍（0.035 ms/次 vs 1.955 ms/次）。
 *    点落在已加载瓦片之外时，回退到 globe.getHeight（需通过可信度校验），
 *    再回退到 LEDemTiles/LETerrain 的解析高度。
 *
 * 【为什么 globe.getHeight 不能当主源】
 *   1) 慢两个数量级：一次上万个要素的 KMZ 导入要取 5 万多个点高，
 *      全走 getHeight 实测 35.6 s —— 表现为「导入卡死 / 报超时」。
 *   2) 瓦片未就绪时返回垃圾值：Cesium 会退化成「对 level-0 平坦瓦片做射线拾取」，
 *      实测返回 −2368 m（DEM 真值 +2218 m）。这个值一旦烘进 Primitive 顶点就
 *      再也不会更新，表现为「KMZ 贴地显示坏掉」。
 *   因此这里加了可信度校验（与解析 DEM 比对）+ 熔断器，并在地形就绪后重新贴地。
 *
 * 对外 API：window.LEDraping
 *   installAvailabilityShim(provider)   给 Provider 装 availability 垫片
 *   groundHeightAt(lon, lat)             渲染面精确高度（米），失败回退解析高度
 *   groundHeightAtBatch(points)          批量采样（复用一次瓦片索引）
 *   isTerrainOn() / terrainEnabled()     地形是否开启
 *   invalidate()                         瓦片换级后清缓存
 *   heightForKml(lon, lat, altitudeMode, alt)  KML 语义的高度换算
 */
(function () {
  'use strict';

  const C = window.Cesium;

  /** availability 垫片的最大层级：与本地 DEM 实际能提供的精细度一致。 */
  const SHIM_MAX_LEVEL = 15;

  // ---- 瓦片索引缓存 ----
  let indexCache = null;      // { tiles: [], grid: Map } —— 瓦片数组 + 空间网格
  let indexStamp = 0;         // 递增计数，瓦片换级时由 invalidate() 递增
  let cachedStamp = -1;       // indexCache 对应的 stamp
  let lastIndexTime = 0;
  const INDEX_TTL_MS = 400;   // 索引最多缓存 400 ms（相机移动时瓦片换级很频繁）
  // 批量计算期间索引不按 TTL 过期 —— 一轮构建要取几万个点，
  // 每 400 ms 重建一次索引（实测约 50 ms/次）纯属浪费。
  // 批次结束时由 endBatch() 强制失效一次。
  let batchActive = false;

  // ---- globe.getHeight 回退缓存 ----
  // globe.getHeight 是「渲染网格」的真值（与 Cesium 自己画的瓦片完全一致），
  // 但很慢（实测 ~0.5 ms/次），因此只在网格采样失败（瓦片空隙）时少量调用，
  // 并按 0.0001° 网格四舍五入缓存。
  const GH_CACHE_MAX = 20000;
  const ghCache = new Map();
  let ghCalls = 0;
  // 每次调用的预算上限。0 = 不限（globe.getHeight 实测 ~0.07 ms/次，
  // 万级顶点约 0.7 s，可接受）。大于 0 时超出即回退到解析 DEM。
  let ghBudget = 0;

  /**
   * 【新增】getHeight 的**墙钟预算**（毫秒）。
   *
   * 【为什么需要 —— 这是「地形加载慢」的头号元凶，实测数字】
   *
   * 一次「国界按渲染网格重贴地」（redrapeDrapedDataSources('settle','mesh')）
   * 会给 54 万个国界顶点各取一次高度。旧实现里，只要渲染网格采样
   * 落在**相机视区之外**，就会退到 globe.getHeight —— 而 getHeight 是
   * **射线拾取**（在已渲染的三角形上做 rayTriangleParametric），极贵。
   *
   * 实测（tools/probe-terrain-perf.mjs，相机 30 km、昆明、high 档）：
   *   - 一次重贴地调用阻塞主线程 **5083 ms**；
   *   - 期间 globe.getHeight 被调用 **7502 次**，累计 **6854 ms**；
   *   - CPU 采样的主线程热点正是
   *     `kc.decodePosition` / `pr.rayTriangleParametric` / `DKe`（Cesium 拾取）；
   *   - 表现为一次 **7811 ms 的 longtask**（PerformanceObserver 实测），
   *     期间界面完全无响应。
   *
   * 而这 7502 次里有 4017 次落在相机视区之外 —— 那部分几何
   * **屏幕上根本看不见**，用户根本不会注意到它贴得准不准。
   *
   * 【修法】给 getHeight 加一个墙钟预算：一轮贴地里累计花费超过
   * GH_TIME_BUDGET_MS 就停止调用 getHeight，之后的点多走解析 DEM。
   * 解析 DEM 与渲染面的偏差实测 P50 = 0 m、P90 ≈ 1.5 km（屏幕外区域，
   * 用户看不见），但屏幕内的点仍然优先走渲染网格（精度 P90 ≤ 4 m），
   * 所以**画面观感不受影响**。
   *
   * 【为什么不给屏幕内的点降级】
   * 屏幕内的点走的是渲染网格（meshHeightAt 命中），
   * 只有网格采样失败才会落到 getHeight。而屏幕内的瓦片是**必然**被
   * 渲染的（它们在 _tilesToRender 里），所以屏幕内几乎不会触发 getHeight。
   * 实测：meshHits 6637 / getHeightHits 4017 —— 两者比例印证了这一点。
   *
   * 【预算为什么取 250 ms】
   * 单次 getHeight 实测 ~0.9 ms，250 ms ≈ 280 次调用。
   * 280 次足以覆盖「屏幕附近瓦片间的缝隙」这种真实需要，
   * 又远小于一次可感知的主线程冻结（100 ms 是交互卡顿的公认阈值）。
   * 可用 ?ghbudgetms= 覆盖。
   */
  function resolveGhTimeBudgetMs() {
    const fallback = 250;
    try {
      const raw = new URLSearchParams(location.search).get('ghbudgetms');
      // 【坑】get() 在参数缺失时返回 null，而 Number(null) === 0，
      // 若直接 Number() 会把「未指定」当成「预算 0 ms」，
      // 于是熔断在第一次 getHeight 后立刻触发，250 ms 的回退值形同虚设
      // （实测控制台打印「超过预算 0 ms」就是踩到了这个坑）。
      if (raw === null || raw === '') return fallback;
      const v = Number(raw);
      if (isFinite(v) && v >= 0) return v;
    } catch (err) {
      /* ignore */
    }
    return fallback;
  }
  const GH_TIME_BUDGET_MS = resolveGhTimeBudgetMs();
  /** 本轮（自上次 invalidate 起）getHeight 已花费的墙钟时间（毫秒）。 */
  let ghTimeSpentMs = 0;
  /** 本轮 getHeight 已超预算（一旦超了就别再试）。 */
  let ghTimeBudgetExhausted = false;

  const stats = {
    meshHits: 0,
    getHeightHits: 0,
    rejectedHits: 0,
    fallbackHits: 0,
    lastTileCount: 0,
    coarseTileCount: 0,
    lastBuildMs: 0,
    shimInstalled: false,
    ghTimeBudgetMs: GH_TIME_BUDGET_MS,
    ghTimeSpentMs: 0,
  };

  function viewer() {
    return window.LE && window.LE.viewer ? window.LE.viewer : null;
  }

  function terrainEnabled() {
    return !!(window.LETerrain && typeof window.LETerrain.isEnabled === 'function' && window.LETerrain.isEnabled());
  }

  /**
   * 给自定义 Provider 补 availability。
   * 幂等：重复调用不会重复定义。
   */
  function installAvailabilityShim(provider) {
    if (!provider) return false;
    try {
      if (provider.availability && typeof provider.availability.computeMaximumLevelAtPosition === 'function') {
        stats.shimInstalled = true;
        return true; // Provider 自带真实 availability，不用管
      }
    } catch (err) {
      /* ignore */
    }
    const shim = {
      computeMaximumLevelAtPosition: function () {
        return SHIM_MAX_LEVEL;
      },
      // 全部返回 false：让 Cesium 仍然去请求瓦片几何，而不是被 availability 短路掉
      isTileAvailable: function () {
        return false;
      },
      computeChildMaskForTile: function () {
        return 0;
      },
      _maximumLevel: SHIM_MAX_LEVEL,
    };
    try {
      Object.defineProperty(provider, 'availability', {
        get: function () {
          return shim;
        },
        configurable: true,
      });
      stats.shimInstalled = true;
      return true;
    } catch (err) {
      console.warn('[LEDraping] 安装 availability 垫片失败', err);
      return false;
    }
  }

  /**
   * 地形瓦片索引：可用的 terrainData + 矩形（度）。
   *
   * 除了瓦片数组，还建一张**空间网格**，把「点落在哪块瓦片里」的
   * 查询从 O(瓦片数) 降到 O(1)。
   *
   * 【为什么需要网格】旧实现每次取高都线性扫全部瓦片：
   * 618 块瓦片 × 52020 个顶点 = 109 万次矩形比较，实测 2.8 µs/点，
   * 占 meshHeightAt 总耗时的 85%（插值本身只要 0.5 µs）。
   * 网格按 0.25° 分桶，一个桶里通常只有几块瓦片，查询几乎免费。
   */
  const GRID_SIZE_DEG = 0.25;

  /**
   * 【新增】空间网格的「粗瓦片豁免门槛」。
   *
   * 【为什么需要这个门槛 —— 实测这是「地形加载慢」的一大元凶】
   *
   * 原实现把**每一块**已加载瓦片都按 0.25° 网格登记。问题在于：
   * Cesium 的四叉树里始终存在 L0/L1 这种**跨度极大的祖先瓦片**
   * （L0 覆盖整个地球）。把它按 0.25° 网格登记意味着
   *   360/0.25 × 180/0.25 = 1440 × 720 = **1 036 800 个桶**
   * 而所有查询最终都落在其中几个桶里 —— 99.99% 的桶是纯浪费。
   *
   * 实测（tools/probe-terrain-perf.mjs + 手工诊断）：
   *   - 已加载瓦片 568 块 → 空间网格插入 **1 388 815 次**，
   *     实际桶数 1 038 961 个，建索引耗时 **823 ms**；
   *   - 同一时刻 `_tilesToRender` 只有 377 块（都是 L12/L13 的细瓦片），
   *     插入 466 次、建索引 0.3 ms。
   *
   * 也就是说：**加载期每建一次索引，光是登记粗祖先瓦片就要几百毫秒**，
   * 而这几百毫秒全花在主线程上 —— 表现为「一卡一卡的」。
   *
   * 【修法】跨度超过阈值的瓦片**不进空间网格**，改成挂在
   * `coarseEntries` 上按需线性查（粗瓦片本来就没几块）。
   * 判定用「瓦片跨越的网格格数 > COARSE_GRID_CELLS」，
   * 而不是固定 level 阈值 —— 因为不同分块的瓦片跨度差别很大，
   * 按格数判定更贴合「会不会撑爆网格」这个真实约束。
   *
   * 【为什么不影响精度】
   * 粗瓦片只覆盖「细瓦片还没加载到」的大片区域，
   * 而那些区域的贴地本来就是粗值；细瓦片在场时永远优先命中细瓦片
   * （桶内按 level 降序 + 粗瓦片不进网格 = 细瓦片必然优先）。
   */
  const COARSE_GRID_CELLS = 64; // 跨过 64 个 0.25° 格（= 16°）就算粗瓦片

  /** 已加载但跨度巨大的瓦片（不进空间网格，查询时线性扫）。 */
  let coarseEntries = [];

  /**
   * 【新增】已加载但未渲染的瓦片也纳入索引（优先级低于渲染瓦片）。
   *
   * 【为什么需要 —— 实测这是 getHeight 风暴的另一半原因】
   *
   * 旧索引只收 `_tilesToRender`。实测（相机 30 km、昆明、high 档）：
   *   - `_tilesToRender` = 377 块，只覆盖相机视区（屏幕采样 192/192 命中，
   *     但随机散布到全国范围的点只命中 41/500）；
   *   - `forEachLoadedTile` = 568 块，覆盖随机点 500/500。
   *
   * 于是「国界折线上落在视区之外的点」在旧索引里**必然 miss**，
   * 只能退到 globe.getHeight 的射线拾取 → 4017 次 × ~0.9 ms ≈ 3.6 s 主线程阻塞。
   *
   * 【精度安全性】
   * 渲染瓦片**优先**：同一个位置若两者都覆盖，用渲染瓦片（它就是
   * getHeight 射线拾取所依据的那张网格，语义完全一致）。
   * 只有渲染瓦片没覆盖的地方才用已加载瓦片 —— 而那种地方
   * getHeight 本来也找不到渲染网格，只能返回粗值甚至垃圾值。
   *
   * 实测（400 个全国随机点）：
   *   已加载瓦片双线性 vs 解析 DEM 真值：P50 = 0 m、P90 ≈ 1.5 km
   *   globe.getHeight     vs 解析 DEM 真值：P50 = 627 m、P90 ≈ 2.9 km、最大 5.2 km
   * 也就是说**已加载瓦片比 getHeight 更接近真值**（它在屏幕外区域
   * 至少给的是 DEM 插值值，而 getHeight 给的是退化后的拾取值）。
   */
  function collectLoadedTiles(surface, seen, out) {
    // 优先用 surface.forEachLoadedTile（Cesium 内部四叉树的全量已加载瓦片）
    try {
      if (surface && typeof surface.forEachLoadedTile === 'function') {
        surface.forEachLoadedTile(function (tile) {
          pushTile(tile, seen, out, 0);
        });
        return;
      }
    } catch (err) {
      /* ignore */
    }
    // 退路：部分 Cesium 版本没有这个方法，就只能用渲染列表
  }

  /**
   * 把一块瓦片登记进索引。
   * @param {number} priority 1 = 渲染瓦片（优先），0 = 仅已加载瓦片
   */
  function pushTile(tile, seen, out, priority) {
    const td = tile.data && tile.data.terrainData;
    if (!td || !tile.rectangle || typeof td.interpolateHeight !== 'function') return;
    if (seen.has(tile)) return;
    seen.add(tile);
    const entry = {
      west: C.Math.toDegrees(tile.rectangle.west),
      east: C.Math.toDegrees(tile.rectangle.east),
      south: C.Math.toDegrees(tile.rectangle.south),
      north: C.Math.toDegrees(tile.rectangle.north),
      td: td,
      rect: tile.rectangle,
      level: tile.level,
      priority: priority,
    };
    out.push(entry);
  }

  function buildIndex() {
    const v = viewer();
    const out = [];
    const grid = new Map();
    const coarse = [];
    if (!v) {
      coarseEntries = coarse;
      return { tiles: out, grid: grid, coarse: coarse };
    }
    const surface = v.scene && v.scene.globe && v.scene.globe._surface;
    const tiles = (surface && surface._tilesToRender) || [];
    const seen = new Set();
    // ① 渲染瓦片（优先级最高：它就是 getHeight 射线拾取所依据的那张网格）
    for (let i = 0; i < tiles.length; i++) {
      pushTile(tiles[i], seen, out, 1);
    }
    // ② 已加载但未渲染的瓦片（补覆盖视区之外的几何）
    collectLoadedTiles(surface, seen, out);
    // ③ 登记到空间网格
    for (let i = 0; i < out.length; i++) {
      const entry = out[i];
      const gx0 = Math.floor(entry.west / GRID_SIZE_DEG);
      const gx1 = Math.floor(entry.east / GRID_SIZE_DEG);
      const gy0 = Math.floor(entry.south / GRID_SIZE_DEG);
      const gy1 = Math.floor(entry.north / GRID_SIZE_DEG);
      const cells = (gx1 - gx0 + 1) * (gy1 - gy0 + 1);
      if (cells > COARSE_GRID_CELLS) {
        // 【新增】跨度太大的瓦片不进网格（否则一次 L0 祖先就撑出 100 万个桶）
        coarse.push(entry);
        continue;
      }
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = gx + ',' + gy;
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(entry);
        }
      }
    }
    stats.lastTileCount = out.length;
    stats.coarseTileCount = coarse.length;
    // 关键：同一区域可能同时存在父子层级，必须优先用**最深**的瓦片，
    // 否则会拿粗层级的高度去贴地，与渲染面（用最细瓦片建的 TIN）差几十米
    // —— 表现为要素沉进山体。
    // 排序规则：**先按优先级（渲染 > 仅加载），再按层级（深 > 浅）**。
    const cmp = function (a, b) {
      const pa = a.priority || 0;
      const pb = b.priority || 0;
      if (pa !== pb) return pb - pa;
      return (b.level || 0) - (a.level || 0);
    };
    out.sort(cmp);
    coarse.sort(cmp);
    // 网格桶内也按同一规则排序，保证第一个命中的就是最合适的瓦片
    grid.forEach(function (bucket) {
      bucket.sort(cmp);
    });
    coarseEntries = coarse;
    return { tiles: out, grid: grid, coarse: coarse };
  }

  function ensureIndex() {
    const now = performance.now();
    if (indexCache && cachedStamp === indexStamp && (batchActive || now - lastIndexTime < INDEX_TTL_MS)) {
      return indexCache;
    }
    const t0 = now;
    indexCache = buildIndex();
    cachedStamp = indexStamp;
    lastIndexTime = performance.now();
    stats.lastBuildMs = Math.round((lastIndexTime - t0) * 100) / 100;
    return indexCache;
  }

  /** 瓦片换级/重建后调用，强制下次重建索引。 */
  function invalidate() {
    indexCache = null;
    cachedStamp = -1;
    lastIndexTime = 0;
    indexStamp++;
    // 地形重建后 getHeight 可能恢复正常 → 复位熔断器
    ghRejectStreak = 0;
    ghCircuitOpen = false;
    ghCache.clear();
    // 瓦片换级 → 网格高度全部作废
    meshCache.clear();
    // 【新增】新的一轮贴地 → 重置 getHeight 墙钟预算
    ghTimeSpentMs = 0;
    ghTimeBudgetExhausted = false;
  }

  /**
   * 开始一批贴地计算：放宽 getHeight 调用预算。
   * 批量重贴地（KMZ 上万条线）时，网格采样失败的点可能很多，
   * 全部走 getHeight 会卡死主线程，所以限制调用次数，超出后回退解析 DEM。
   */
  function beginBatch(budget) {
    ghBudget = isFinite(budget) && budget > 0 ? budget : 0;
    ghCalls = 0;
    batchActive = true;
  }

  function endBatch() {
    ghBudget = 0;
    ghCalls = 0;
    batchActive = false;
    // 批次结束：瓦片可能已经换级了，强制下次重建索引
    invalidate();
  }

  /**
   * globe.getHeight 回退：点落在已渲染瓦片之外（或该瓦片无插值能力）时使用。
   * globe.getHeight(cartographic) 直接在**已渲染网格**上取该点经纬度处的高度，
   * 是渲染面的真值（与 Cesium 画出来的瓦片完全一致，误差 < 0.1 m），
   * 但很慢（实测 ~2 ms/次），所以限制调用次数并缓存。
   * 返回 undefined 表示不可用（预算耗尽 / 熔断 / 地形关闭 / 调用失败）。
   *
   * 【为什么不能无条件相信它的返回值】
   * Cesium 的 Globe.getHeight 在**瓦片尚未就绪**时会退化成「对 level-0 平坦瓦片
   * 做射线拾取」，返回大额负数（实测 −2368 m，而 DEM 真值是 +2218 m）。
   * 这个垃圾值一旦被烘进 Primitive 的顶点位置，贴地要素就会整片沉到地平线以下
   * —— 表现为「KMZ 贴地显示坏了」，而且因为顶点已固化，事后无法自动恢复。
   * 因此调用方只接受 getHeight 的**合理**结果（见 globeHeightTrusted）。
   */
  function globeHeightAt(lon, lat) {
    if (!terrainEnabled()) return undefined;
    if (ghCircuitOpen) return undefined;
    // 【新增】墙钟预算已耗尽 → 不再调用昂贵的射线拾取。
    // 见 GH_TIME_BUDGET_MS 的说明：一次重贴地曾因此阻塞主线程 5083 ms。
    if (ghTimeBudgetExhausted) return undefined;
    const key = Math.round(lon * 10000) + ',' + Math.round(lat * 10000);
    if (ghCache.has(key)) return ghCache.get(key);
    if (ghBudget > 0 && ghCalls >= ghBudget) return undefined;
    const v = viewer();
    const globe = v && v.scene && v.scene.globe;
    if (!globe || typeof globe.getHeight !== 'function') return undefined;
    let h;
    const t0 = performance.now();
    try {
      h = globe.getHeight(C.Cartographic.fromDegrees(lon, lat));
    } catch (err) {
      h = undefined;
    }
    // 【新增】累计墙钟开销；超预算就熔断本轮
    ghTimeSpentMs += performance.now() - t0;
    stats.ghTimeSpentMs = Math.round(ghTimeSpentMs);
    if (ghTimeSpentMs > GH_TIME_BUDGET_MS) {
      ghTimeBudgetExhausted = true;
      console.warn(
        '[LEDraping] globe.getHeight 累计耗时 ' + Math.round(ghTimeSpentMs) +
          ' ms 超过预算 ' + GH_TIME_BUDGET_MS + ' ms，本轮不再调用（改用解析 DEM）。'
      );
    }
    if (h == null || !isFinite(h)) return undefined;
    ghCalls++;
    if (ghCache.size >= GH_CACHE_MAX) ghCache.clear();
    ghCache.set(key, h);
    return h;
  }

  /**
   * 渲染网格采样结果缓存（键：0.0001° 网格）。
   *
   * 【为什么需要】一次 KMZ 导入有 52020 个顶点，但只有 41616 个唯一坐标，
   * 且相邻顶点相距仅 0.0005°~0.004°。逐点做一次 interpolateHeight
   * 在大批量场景下累积成秒级开销。加一层 0.0001° 的位置缓存后，
   * 重复点几乎免费。
   *
   * 精度取舍：0.0001° ≈ 11 m，插值高度在这么小的格内几乎线性，
   * 量化误差远小于网格自身误差（实测 ≤ 0.10 m），不会影响贴地效果。
   */
  const MESH_CACHE_MAX = 200000;
  const meshCache = new Map();

  /**
   * 渲染网格高度（米）。点不在已加载瓦片内时返回 null。
   */
  function meshHeightAt(lon, lat) {
    const key = Math.round(lon * 10000) + ',' + Math.round(lat * 10000);
    const cached = meshCache.get(key);
    if (cached !== undefined) return cached;

    const index = ensureIndex();
    let result = null;
    const lonR = (lon * Math.PI) / 180;
    const latR = (lat * Math.PI) / 180;
    if (index && index.grid && index.grid.size) {
      // 空间网格查询：只扫这一个桶里的瓦片（通常个位数）
      const bucket = index.grid.get(
        Math.floor(lon / GRID_SIZE_DEG) + ',' + Math.floor(lat / GRID_SIZE_DEG)
      );
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) {
          const t = bucket[i];
          if (lon < t.west || lon > t.east || lat < t.south || lat > t.north) continue;
          let h = null;
          try {
            h = t.td.interpolateHeight(t.rect, lonR, latR);
          } catch (err) {
            h = null;
          }
          if (h != null && isFinite(h)) { result = h; break; }
        }
      }
    }
    // 【新增】网格里没命中 → 再看「跨度巨大的粗瓦片」。
    // 这些瓦片因为跨度过大没进空间网格（见 COARSE_GRID_CELLS 的说明），
    // 但它们确实覆盖了屏幕外的大片区域 —— 国界折线有 54 万个顶点，
    // 其中绝大部分落在「相机视区之外」，全靠这些粗瓦片兜底。
    // 粗瓦片只有个位数，线性扫完全免费。
    if (result == null && coarseEntries.length) {
      for (let i = 0; i < coarseEntries.length; i++) {
        const t = coarseEntries[i];
        if (lon < t.west || lon > t.east || lat < t.south || lat > t.north) continue;
        let h = null;
        try {
          h = t.td.interpolateHeight(t.rect, lonR, latR);
        } catch (err) {
          h = null;
        }
        if (h != null && isFinite(h)) { result = h; break; }
      }
    }
    if (meshCache.size >= MESH_CACHE_MAX) meshCache.clear();
    meshCache.set(key, result);
    return result;
  }

  /** 解析 DEM 高度（LETerrain.heightAt），地形关闭时返回 0。 */
  function analyticHeightAt(lon, lat) {
    if (!terrainEnabled()) return 0;
    try {
      const h = window.LETerrain.heightAt(lon, lat);
      return isFinite(h) ? h : 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * getHeight 结果的可信度校验。
   *
   * 依据：解析 DEM 与渲染网格来自同一套 DEM 数据源，网格只是重新采样，
   * 两者在**正常就绪**时的偏差实测 ≤ 5.3 m（全国金字塔 0.0125° 分块源的
   * 分块边界处最大，P90 约 1 m）。而瓦片未就绪时 getHeight 的偏差是
   * −4586 m（量级差 3 个数量级），二者绝不可能混淆。
   *
   * 因此用「相对偏差」判定：偏差超过 max(绝对容差, 相对容差×|DEM|) 即视为不可信。
   * 地形关闭 / DEM 不可用（返回 0）时无法比对，直接放行。
   */
  const GH_ABS_TOLERANCE_M = 120; // 绝对容差（米）
  const GH_REL_TOLERANCE = 0.25; // 相对容差（比例）

  /**
   * getHeight 熔断器。
   *
   * 【为什么需要】一次性导入上万个 KMZ 要素时，贴地要取 5 万多个点高。
   * 若此时地形瓦片尚未就绪，globe.getHeight 每次都要做一次射线拾取（实测 ~2 ms），
   * 5 万次就是 100 s —— 表现为「导入卡死 / 报超时」。
   * 更糟的是这些结果全是垃圾负数（瓦片未就绪时 Cesium 退化为对 level-0 平坦瓦片
   * 拾取），一旦固化进 Primitive 顶点就再也不会更新。
   *
   * 【熔断逻辑】连续 N 次 getHeight 结果被判定为不可信（与解析 DEM 偏差过大），
   * 就认定「当前 getHeight 不可用」，此后直接走解析 DEM，不再做昂贵的拾取。
   * 地形重新就绪（瓦片索引变化 / invalidate）时复位。
   */
  const GH_REJECT_STREAK_MAX = 3;
  let ghRejectStreak = 0;
  let ghCircuitOpen = false;

  function globeHeightTrusted(lon, lat, gh) {
    if (gh == null || !isFinite(gh)) return false;
    const dem = analyticHeightAt(lon, lat);
    // DEM 不可用（地形关闭或源未加载）→ 无从比对，放行
    if (!dem || !isFinite(dem) || Math.abs(dem) < 1) return true;
    const diff = Math.abs(gh - dem);
    const tol = Math.max(GH_ABS_TOLERANCE_M, GH_REL_TOLERANCE * Math.abs(dem));
    return diff <= tol;
  }

  /**
   * 贴地基准高度（米）——用户看到的渲染面。
   * 优先级（实测覆盖度/精度/速度）：
   *   ① 渲染瓦片插值     覆盖已渲染瓦片内，误差 ≤ 0.10 m，0.035 ms/次  ← 主源
   *   ② globe.getHeight  覆盖 100%，误差 ≤ 0.15 m，~2 ms/次（受信任时） ← 备源
   *   ③ 解析 DEM（LEDemTiles）覆盖 100%，与真值偏差 ≤ 5.3 m            ← 兜底
   * 永远返回有限数，调用方不必再判断 NaN。
   *
   * 【顺序为什么变了】原实现把 getHeight 放在第一位，但它（a）慢两个数量级，
   * （b）瓦片未就绪时返回大负数垃圾值。实测一万条线 × 5 顶点 = 52020 次调用，
   * 光是 getHeight 就吃掉 35.6 s 主线程时间，并把这些垃圾高度固化进顶点。
   *
   * 【实测】地形完全就绪后，KMZ 范围内 400 个采样点**全部**命中渲染网格
   * （meshHit 400 / miss 0），此时 getHeight 一次都不需要调用。
   * 剩下那些 getHeight 调用全部发生在「地形还没建好」的导入阶段 ——
   * 那正是它既慢又不可信的时段。所以备源必须**限额**（见 ghBudget），
   * 超出就回退解析 DEM，等地形就绪后由重贴地统一校正。
   */
  function groundHeightAt(lon, lat) {
    if (!isFinite(lon) || !isFinite(lat)) return 0;
    // 主源：渲染瓦片插值（最快最准）
    const mesh = meshHeightAt(lon, lat);
    if (mesh != null && isFinite(mesh)) {
      stats.meshHits++;
      return mesh;
    }
    // 备源：globe.getHeight（仅当瓦片缺失、数值可信、且预算未耗尽）
    const gh = globeHeightAt(lon, lat);
    if (gh != null && isFinite(gh)) {
      if (globeHeightTrusted(lon, lat, gh)) {
        stats.getHeightHits++;
        ghRejectStreak = 0;
        return gh;
      }
      // 数值不可信 → 连续超限则熔断，避免为 5 万个点白跑 100 s
      stats.rejectedHits++;
      ghRejectStreak++;
      if (ghRejectStreak >= GH_REJECT_STREAK_MAX) {
        ghCircuitOpen = true;
        console.warn(
          '[LEDraping] globe.getHeight 连续 ' + ghRejectStreak + ' 次与解析 DEM 偏差过大' +
            '（地形瓦片未就绪），已熔断本轮 getHeight，改用解析 DEM 贴地。' +
            '地形就绪后会重新贴地。'
        );
      }
    }
    stats.fallbackHits++;
    return analyticHeightAt(lon, lat);
  }

  /**
   * 批量采样：一次建索引，扫多个点。比逐个 groundHeightAt 快（省掉重复的索引构建）。
   * @param {Array<{lon:number,lat:number}>|Array<[number,number]>} points
   */
  function groundHeightAtBatch(points) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const lon = Array.isArray(p) ? p[0] : p.lon;
      const lat = Array.isArray(p) ? p[1] : p.lat;
      out[i] = groundHeightAt(lon, lat);
    }
    return out;
  }

  /**
   * Build a terrain-following Cartesian line from lon/lat vertices. Sampling
   * every terrain-sized interval avoids a long endpoint-to-endpoint chord cutting
   * through ridges. The hard ceiling keeps imports of very large lines bounded.
   */
  function drapePolyline(points, opts) {
    opts = opts || {};
    if (!Array.isArray(points) || points.length < 2) return [];
    const step = Math.max(2, Number(opts.stepMeters) || 20);
    const maxPoints = Math.max(2, Math.floor(Number(opts.maxPoints) || 12000));
    const source = points.map(function (p) {
      if (Array.isArray(p)) return { lon:Number(p[0]), lat:Number(p[1]), height:Number(p[2]) || 0 };
      return { lon:Number(p.lon), lat:Number(p.lat), height:Number(p.height) || 0 };
    });
    if (source.some(p=>!isFinite(p.lon)||!isFinite(p.lat))) return [];
    if (opts.closeRing) {
      const first=source[0], last=source[source.length-1];
      if (Math.abs(first.lon-last.lon)>1e-10 || Math.abs(first.lat-last.lat)>1e-10) source.push(first);
    }
    const segments = [];
    let total = 0;
    for (let i=0;i<source.length-1;i++) {
      const a=C.Cartographic.fromDegrees(source[i].lon,source[i].lat);
      const b=C.Cartographic.fromDegrees(source[i+1].lon,source[i+1].lat);
      const geodesic=new C.EllipsoidGeodesic(a,b,C.Ellipsoid.WGS84);
      const distance=Math.max(0,geodesic.surfaceDistance||0);
      segments.push({geodesic:geodesic,distance:distance});
      total+=distance;
    }
    const segmentBudget=Math.max(1,maxPoints-source.length+1);
    const actualStep=Math.max(step,total/segmentBudget);
    const dense=[source[0]];
    for(let i=0;i<segments.length;i++) {
      const seg=segments[i], count=Math.max(1,Math.ceil(seg.distance/actualStep));
      for(let j=1;j<count;j++) {
        const c=seg.geodesic.interpolateUsingFraction(j/count,new C.Cartographic());
        dense.push({lon:C.Math.toDegrees(c.longitude),lat:C.Math.toDegrees(c.latitude),height:0});
      }
      dense.push(source[i+1]);
    }
    const on=terrainEnabled();
    const ground=on?groundHeightAtBatch(dense):null;
    const offset=Number.isFinite(Number(opts.offset))?Number(opts.offset):1.5;
    return dense.map(function(p,i) {
      let h=p.height;
      if(opts.force || !isFinite(h) || h===0) {
        const sampled=ground && Number(ground[i]);
        h=on?(isFinite(sampled)?sampled:0)+offset:0;
      }
      return C.Cartesian3.fromDegrees(p.lon,p.lat,h);
    });
  }

  /**
   * KML 高度语义：
   *   absolute        → alt
   *   relativeToGround→ 地面 + max(alt, 0) + offset
   *   clampToGround   → 地面 + offset
   * 地形关闭时 relativeToGround 退化为相对海平面的固定抬升。
   */
  const RELATIVE_GROUND_MIN_HEIGHT = 60;
  const RELATIVE_GROUND_OFFSET = 6;
  const GROUND_EPSILON = 1; // 防 z-fighting 的最小抬升（米）

  function heightForKml(lon, lat, altitudeMode, alt, opts) {
    opts = opts || {};
    const a = isFinite(alt) ? alt : 0;
    const epsilon = opts.epsilon != null ? opts.epsilon : GROUND_EPSILON;
    if (altitudeMode === 'absolute') return a;
    if (terrainEnabled()) {
      const ground = groundHeightAt(lon, lat);
      if (altitudeMode === 'relativeToGround') return ground + Math.max(a, 0) + epsilon;
      return ground + epsilon;
    }
    if (altitudeMode === 'relativeToGround') {
      return Math.max(a, RELATIVE_GROUND_MIN_HEIGHT) + RELATIVE_GROUND_OFFSET;
    }
    return 0;
  }

  window.LEDraping = {
    installAvailabilityShim: installAvailabilityShim,
    groundHeightAt: groundHeightAt,
    groundHeightAtBatch: groundHeightAtBatch,
    drapePolyline: drapePolyline,
    meshHeightAt: meshHeightAt,
    globeHeightAt: globeHeightAt,
    analyticHeightAt: analyticHeightAt,
    heightForKml: heightForKml,
    isTerrainOn: terrainEnabled,
    terrainEnabled: terrainEnabled,
    invalidate: invalidate,
    beginBatch: beginBatch,
    endBatch: endBatch,
    stats: function () {
      return {
        meshHits: stats.meshHits,
        getHeightHits: stats.getHeightHits,
        rejectedHits: stats.rejectedHits,
        fallbackHits: stats.fallbackHits,
        lastTileCount: stats.lastTileCount,
        coarseTileCount: stats.coarseTileCount,
        lastBuildMs: stats.lastBuildMs,
        shimInstalled: stats.shimInstalled,
        ghCacheSize: ghCache.size,
        // 真实调用次数（不含缓存命中）—— getHeightHits 里含缓存命中，
        // 想知道「到底做了多少次昂贵的射线拾取」要看这个
        ghCalls: ghCalls,
        // 【新增】getHeight 墙钟预算的用量
        ghTimeBudgetMs: GH_TIME_BUDGET_MS,
        ghTimeSpentMs: Math.round(ghTimeSpentMs),
        ghTimeBudgetExhausted: ghTimeBudgetExhausted,
      };
    },
    resetStats: function () {
      stats.meshHits = 0;
      stats.getHeightHits = 0;
      stats.rejectedHits = 0;
      stats.fallbackHits = 0;
    },
  };
})();

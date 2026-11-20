/*
 * 分块 DEM 金字塔（全国离线高程）
 * ---------------------------------------------------------------------------
 * 背景：旧的地形链路把整块高程当成一个 .bin 一次性 fetch 进内存
 *   （world 12 MB + eastasia 28 MB + 示例区 26 MB ≈ 67 MB），首屏必卡；
 *   而且全国部分只有 0.02°（≈2.2 km）栅格，看全国是一片糊。
 *
 * 本模块改为「金字塔 + 视口瓦片」：
 *   - index.json 描述多个分辨率层级（每层覆盖 72–136E / 17–55N）；
 *   - 每层按 256×256 像素切成 int16 小瓦片；
 *   - 运行时按相机高度选择层级，只拉取当前视野相交的瓦片；
 *   - 采样时若某瓦片尚未到达，就向下回退到已缓存的粗层级，
 *     保证任何时刻都有高程（不会出「地形空洞」）。
 *
 * 关键性能点：
 *   - 瓦片是 128 KB 的小文件，fetch 天然并行、不阻塞；
 *   - 缓存上限按层设置，切换层级时丢弃旧层瓦片，避免内存无限增长；
 *   - heightAt 走「先算瓦片号 → 命中缓存 → 双线性」的最短路径，
 *     不做任何跨层搜索（跨层回退只在瓦片未命中时发生，且有上限）。
 *
 * 对外 API（window.LEDemTiles）：
 *   init()                 读取 index.json（极小，几 KB）
 *   heightAt(lon, lat)     → 高程（米）；未覆盖返回 null
 *   updateForCamera(le)    按相机高度选层并预取视野瓦片
 *   setEnabled(on)         开关
 *   stats()                运行状态
 *   redrape()              数据更新后通知外部重新贴地
 */
(function () {
  'use strict';

  const INDEX_URL = 'data/public/dem/cn/index.json';

  // 每个相机高度区间用哪一层。数值来自「该层级像素覆盖的地面尺度」
  // 与「屏幕上一个像素大致能分辨多少米地形」的匹配。
  const LEVEL_BY_HEIGHT = [
    { maxHeight: 120000, level: 3 },   // < 120 km：最细层
    { maxHeight: 400000, level: 2 },   // < 400 km
    { maxHeight: 1200000, level: 1 },  // < 1200 km
    { maxHeight: Infinity, level: 0 }, // 更远：最粗层
  ];

  // 【屏幕分辨率驱动的层选择】
  //
  // 【为什么需要】按相机高度选层，在有了更细的 L4 之后就过时了：
  // 9 km 高度永远选 L3，L4 哪怕建出来了也用不上 —— 而 L4 才是能带出
  // 「山腰凹陷」的那一层（见 docs/TERRAIN-DETAIL-LOSS.md §3.5：
  // L4=570 m/px 时源数据保留率 1.04，源被完全吃满）。
  //
  // 【怎么算】屏幕上 1 个像素对应多少地面米（ground sample distance），
  // 是「这个视野需要多细的高程」的直接度量。取地形瓦片的顶点间距：
  // 地形网格是 grid×grid 覆盖一整块 Cesium 瓦片（见 js/terrain.js 的
  // tileHeights），所以顶点间距 ≈ 瓦片跨度 / (grid-1)。
  // 当「DEM 像元 > 顶点间距」时，DEM 就成了瓶颈 —— 该换更细的层。
  //
  // 【为什么不用固定阈值】地形网格密度（perf.js 的 65/49/41）和
  // Cesium 的 LOD 都会变，用「DEM 层 vs 顶点间距」的相对关系比
  // 写死某个米数更稳。
  // 【选择规则】从**最细的层**往下找，选第一个满足
  //     DEM 像元尺寸 <= 顶点间距 * 2
  // 的层。理由是 Nyquist：地形网格的顶点间距是它能表达的最细尺度，
  // DEM 再细也表达不出来；反过来 DEM 比顶点间距粗很多时，
  // 网格就只是在插值一条平滑曲线 —— 山腰凹陷在数据里就没有了。
  //
  // 【各层的像元尺寸】（全国 72-136E / 17-55N）
  //     L4 = 570 m   L3 = 1140 m   L2 = 2280 m   L1 = 4560 m   L0 = 9120 m


  // 允许用 URL 参数覆盖（?demlevel=4），便于 A/B 对照。
  function forcedLevel() {
    try {
      const params = new URLSearchParams(location.search);
      const raw = params.get('demlevel');
      // 【坑】Number(null) === 0 —— 参数缺失时会被当成「强制用 L0」。
      // 必须先判 raw === null。
      if (raw === null || raw === '') return null;
      const v = Number(raw);
      if (isFinite(v) && v >= 0) return Math.floor(v);
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  // 每层缓存瓦片上限（超出后按 LRU 淘汰）
  // L4 是 10240×6080 的整幅图（119 MB），瓦片数比 L3 多 4 倍，
  // 缓存上限要相应放大，否则拖动时会被 LRU 反复淘汰。
  const TILE_CACHE_LIMIT = { 0: 96, 1: 160, 2: 220, 3: 260, 4: 520 };

  const state = {
    index: null,
    indexReady: false,
    indexFailed: false,
    enabled: true,
    level: 2,
    // 每层：level -> Map(key -> {data:Int16Array, t:number})
    tiles: {},
    // 每层待请求队列，避免同一瓦片重复发起
    pending: {},
    // 视野外多取一圈，减少拖动时的空档
    margin: 0.18,
    stats: {
      level: 2,
      loaded: 0,
      requests: 0,
      bytes: 0,
      hitRate: 1,
      // 屏幕分辨率驱动的层选择诊断（见 pickLevelByScreenResolution）
      screenVertexSpacing: 0,   // 当前近景地形网格的顶点间距（米）
      groundPerPixel: 0,        // 屏幕 1 像素对应的地面距离（米）
      screenCapMeters: 0,       // 层选择天花板：像元细于此值就分辨不出了（米）
      screenChosenMeters: 0,    // 选中层的像元尺寸（米）
    },
    hits: 0,
    misses: 0,
    onChange: null,
    /**
     * 叠加金字塔（本地导入的高精度 DEM）。
     * 每个 overlay 是一份独立的 {index, base, tiles, pending}，
     * 采样时**先查 overlay 再查全国金字塔** —— 导入的数据精度更高，优先。
     */
    overlays: [],
    /**
     * 更细高程源的回调（由 terrain.js 注册）：
     *   (lon, lat, maxResolutionDeg) => 高程(米) | null
     * 全国金字塔最细只有 ≈1261 m/px，而本机还带 1″(≈28 m/px) 源，
     * 没有这个回调时那些精细数据会被金字塔完全盖住。
     */
    finerSource: null,
  };

  function levelMeta(level) {
    if (!state.index || !state.index.levels) return null;
    for (let i = 0; i < state.index.levels.length; i++) {
      if (state.index.levels[i].level === level) return state.index.levels[i];
    }
    return null;
  }

  /**
   * 层级元数据查表（level → meta）。
   *
   * levelMeta() 是线性扫描，而它在逐顶点采样路径上被反复调用
   * （实测 385 万次采样 × 每次数次扫描）。层级数只有 4 个，
   * 查表是 O(1)。
   */
  let metaMap = null;

  function levelMetaFast(level) {
    if (!metaMap) {
      metaMap = new Map();
      const lv = state.index && state.index.levels;
      if (lv) for (let i = 0; i < lv.length; i++) metaMap.set(lv[i].level, lv[i]);
    }
    const m = metaMap.get(level);
    return m === undefined ? null : m;
  }

  /**
   * 采样顺序缓存：从当前层往下的层级序列（由细到粗）。
   *
   * 【为什么需要缓存】heightAt() 是**逐顶点**调用的 —— 一次 KMZ/地形导入
   * 实测 3,852,467 次。而旧实现每次都执行
   *   levels.map().filter().sort()
   * 来算这个顺序，每次分配 3 个新数组。
   * 3.85 M × 3 个数组 = 1100 万次分配，纯属自找的 GC 压力。
   *
   * 层级序列只在「索引加载完成」或「当前层变化」时才会变，
   * 所以缓存起来即可。
   */
  let orderCacheKey = '';
  let orderCache = [];

  function levelOrder() {
    if (!state.indexReady || !state.index.levels) return [];
    const key = String(state.level);
    if (key === orderCacheKey) return orderCache;
    const order = state.index.levels
      .map(function (l) { return l.level; })
      .filter(function (l) { return l <= state.level; })
      .sort(function (a, b) { return b - a; });
    orderCacheKey = key;
    orderCache = order;
    return order;
  }

  /** 索引就绪后重建顺序缓存。 */
  function resetOrderCache() {
    orderCacheKey = '';
    orderCache = [];
  }

  /**
   * 瓦片缓存的键。
   *
   * 【为什么用数字而不是字符串】原来的 `tx + ':' + ty` 每次调用都要做字符串
   * 拼接 + 分配一个短命字符串。sampleTile() 是**逐顶点**调用的
   * （实测 385 万次），于是就是 385 万次字符串分配。
   * 改成数字键（tx * 2^20 + ty，ty 远小于 2^20）后，Map 的键是数字，
   * 没有分配也没有字符串哈希。
   */
  function tileKey(tx, ty) {
    return tx * 1048576 + ty;
  }

  function cacheOf(level) {
    if (!state.tiles[level]) state.tiles[level] = new Map();
    return state.tiles[level];
  }

  function pendingOf(level) {
    if (!state.pending[level]) state.pending[level] = new Map();
    return state.pending[level];
  }

  /* ------------------------------------------------------------------ 初始化 */

  async function init() {
    if (state.indexReady) return state.index;
    if (state.indexFailed) return null;
    try {
      // 来源归因诊断：?attrib=1 打开（默认关闭，heightAt 是热点函数）
      try {
        if (new URLSearchParams(location.search).get('attrib') === '1') attribEnabled = true;
      } catch (err) { /* ignore */ }
      const res = await fetch(INDEX_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('索引读取失败：' + res.status);
      const json = await res.json();
      if (!json || !json.levels || !json.levels.length) throw new Error('索引格式不正确');
      state.index = json;
      state.indexReady = true;
      resetOrderCache();
      console.debug('[LEDemTiles] 索引就绪，层级 ' + json.levels.map((l) => 'L' + l.level).join(','));
      // 细源并行启动（失败不阻塞金字塔）
      initFineSource();
      return json;
    } catch (err) {
      state.indexFailed = true;
      console.warn('[LEDemTiles] 索引不可用，全国分块地形停用：', err);
      return null;
    }
  }

  /* ------------------------------------------------------------------ 瓦片加载 */

  /**
   * 拉取一个瓦片。返回 true/false 表示是否成功。
   * 失败不抛错（上层会回退到粗层级），只统计计数。
   */
  function fetchTile(level, tx, ty) {
    const meta = levelMeta(level);
    if (!meta) return Promise.resolve(false);
    const key = tileKey(tx, ty);
    const pend = pendingOf(level);
    if (pend.has(key)) return pend.get(key);

    const url = 'data/public/dem/cn/l' + level + '/' + tx + '/' + ty + '.bin';
    const result = fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        const expect = meta.tileSize * meta.tileSize * 2;
        if (buf.byteLength !== expect) throw new Error('瓦片大小不符');
        const data = new Int16Array(buf);
        const cache = cacheOf(level);
        cache.set(key, { data: data, t: Date.now() });
        state.stats.requests += 1;
        state.stats.bytes += buf.byteLength;
        state.stats.loaded = cache.size;
        evict(level);
        return true;
      })
      .catch(function (err) {
        // 瓦片缺失是正常情况（越界/数据空洞），只 debug 不刷错误
        console.debug('[LEDemTiles] 瓦片不可用 l' + level + '/' + tx + '/' + ty + '：' + err.message);
        return false;
      })
      .finally(function () {
        pend.delete(key);
      });
    pend.set(key, result);
    return result;
  }

  /** LRU 淘汰，保证内存有上限。 */
  function evict(level) {
    const cache = cacheOf(level);
    const limit = TILE_CACHE_LIMIT[level] || 160;
    if (cache.size <= limit) return;
    // 【保护区】飞行途中被 LEFlyGate 钉住的瓦片不淘汰 ——
    // 否则相机高度剧变时粗层瓦片会把刚拉好的细层冲掉，
    // 落地时又得重拉，屏幕上就是「相机到了、瓦片没了」的空洞。
    const protect = PIN && PIN.keys;
    const entries = [];
    for (const kv of cache) {
      if (protect && protect.has(level + ':' + kv[0])) continue;
      entries.push([kv[0], kv[1].t]);
    }
    entries.sort(function (a, b) { return a[1] - b[1]; });
    const drop = Math.min(entries.length, cache.size - limit);
    for (let i = 0; i < drop; i++) cache.delete(entries[i][0]);
    state.stats.loaded = cache.size;
  }

  /* ------------------------------------------------------------------ 采样 */

  /**
   * 计算某经纬度在指定层级中的瓦片号与像素内坐标。
   * 栅格按 north→south 排列（与 Cesium HeightmapTerrainData 约定一致）。
   *
   * 【为什么有 scratch 版本】本函数是**逐顶点**调用的（实测 385 万次），
   * 每次返回一个新对象 = 385 万次短命对象分配 → GC 压力。
   * scratchLocate() 复用同一个对象，调用方必须**立即**取值，不得持有引用。
   */
  function locate(meta, lon, lat) {
    const t = meta.tileSize;
    const res = (meta.east - meta.west) / (meta.width - 1);
    const fx = (lon - meta.west) / res;
    const fy = (meta.north - lat) / res;
    if (fx < 0 || fy < 0 || fx > meta.width - 1 || fy > meta.height - 1) return null;
    const tx = Math.floor(fx / t);
    const ty = Math.floor(fy / t);
    return { tx: tx, ty: ty, ix: fx - tx * t, iy: fy - ty * t };
  }

  /** locate() 的无分配版本：结果写进复用的 scratch 对象。 */
  const _loc = { tx: 0, ty: 0, ix: 0, iy: 0 };
  function scratchLocate(meta, lon, lat) {
    const t = meta.tileSize;
    const res = (meta.east - meta.west) / (meta.width - 1);
    const fx = (lon - meta.west) / res;
    const fy = (meta.north - lat) / res;
    if (fx < 0 || fy < 0 || fx > meta.width - 1 || fy > meta.height - 1) return null;
    const tx = Math.floor(fx / t);
    const ty = Math.floor(fy / t);
    _loc.tx = tx;
    _loc.ty = ty;
    _loc.ix = fx - tx * t;
    _loc.iy = fy - ty * t;
    return _loc;
  }

  /** 从缓存瓦片做双线性采样；瓦片缺失返回 null。 */
  function sampleTile(meta, tx, ty, ix, iy) {
    const cache = cacheOf(meta.level);
    const hit = cache.get(tileKey(tx, ty));
    if (!hit) return null;
    const t = meta.tileSize;
    const d = hit.data;
    // 瓦片内坐标 → 瓦片像素索引
    const x0 = Math.floor(ix);
    const y0 = Math.floor(iy);
    const tx2 = ix - x0;
    const ty2 = iy - y0;
    const x1 = x0 + 1 < t ? x0 + 1 : x0;
    const y1 = y0 + 1 < t ? y0 + 1 : y0;
    const r0 = y0 * t;
    const r1 = y1 * t;
    const v =
      d[r0 + x0] * (1 - tx2) * (1 - ty2) +
      d[r0 + x1] * tx2 * (1 - ty2) +
      d[r1 + x0] * (1 - tx2) * ty2 +
      d[r1 + x1] * tx2 * ty2;
    return v;
  }

  /* ------------------------------------------------------------------ *
   * 细源层（运行时直取的精细高程，z11 或 z12）
   * ------------------------------------------------------------------ */

  /**
   * 【为什么要这一层 —— 见 docs/TERRAIN-DETAIL-LOSS.md】
   *
   * 全国金字塔最细一层是 L4（570 m/px）。但实测的细节保留率显示：
   *
   *   λ=100 m 尺度上    L3(1140m) = 0.104    L4(570m) = 0.201
   *   λ= 60 m 尺度上    L3(1140m) = 0.081    L4(570m) = 0.156
   *
   * 而细源（z11 源 76 m/px）的**理论上限**是 0.534 / 0.454。
   * 也就是说 L4 只吃到了源潜力的 38%，剩下的 62% 仍然被金字塔
   * 构建时的降采样丢掉了 —— 这就是「山腰凹陷还是看不出来」的原因。
   *
   * 【为什么不继续建 L5/L6】
   * 全国规则金字塔建到 76 m/px 需要 20480×12160 = int16 **10 GB**，
   * 远超数据包能承受的体积（整个 data/ 现在才 4.2 GB）。
   * 而源瓦片是 PNG：
   *   - 同样的分辨率，数据量小 6 倍；
   *   - 天然是「金字塔」（每个 tile 自带层级 LOD），不用另建；
   *   - 已经全量缓存，离线可用。
   *
   * 【z12 = SRTM 1 弧秒级别】
   * tools/build_srtm_z12.py 用 AWS 的 SRTM 1″ 原始块（3601×3601 大端
   * int16）本地重采样成 z12 Terrarium PNG。z12 像元尺度在北纬 36.6 是
   * **30.7 m**、北纬 25 是 34.6 m —— 跟 SRTM 1″（30.9 m 等纬）同级，
   * 也跟 GEP 自带的 SRTM 1″ 同级。实测（2026-11-17）重建结果与 AWS
   * 官方 terrarium z12 的相关系数 **0.999910**、平均差 0.66 m。
   *
   * 【它与 overlay 的关系】
   * 本层在精度仲裁里排在 overlay 之后、全国金字塔之前：
   *   overlay（用户导入，通常 ≤30 m）> 细源（z12 ≈31 m / z11 ≈76 m）> 全国金字塔（≥570 m）
   *
   * 【格式】
   * Terrarium PNG：elevation = R*256 + G + B/256 - 32768（米）。
   * 瓦片按 WebMercator 索引 z/x/y，每张 256×256。
   * 投影必须用 atan(sinh(...)) 形式（与 tools/make_china_dem.py 的
   * inv_merc_lat 一致），用 tan 会导致空间完全错位。
   */

  /**
   * 细源（运行时直取的精细高程层）。
   *
   * 【级别可配置 + 自动探测】
   * 目录约定：data/public/dem/_terrarium_cache/{z}/{x}/{y}.png
   * 探测顺序见 FINE_LEVELS —— 取**第一个真正有瓦片**的级别。
   *
   * 【z12 是主力，z11 是兼容回退】
   * z12（SRTM 1″ 重建）是现在唯一构建的级别，2026-11-17 起
   * `_terrarium_cache/11/` 已删除。但 **z11 这一档要留着**：
   * 手里有旧数据包（只带 z11）的用户不能因此打不开地形 ——
   * 探测到 z12 不存在就自动退回 z11，功能降级但不中断。
   * 这也是 `?finez=N` 能强制级别的意义。
   *
   * 【z12 是 SRTM 1″ 级别】
   * z12 在北纬 36.6 是 30.7 m/px，在北纬 25 是 34.6 m/px，
   * 跟 SRTM 1 弧秒（30.9 m 等纬）基本同级 —— 这正是 GEP 的数据量级。
   * z11 只有 61–76 m/px，理论上还有一半细节没吃进来。
   */
  const FINE_LEVELS = [
    { z: 12, name: 'SRTM 1″ → z12 (31–36 m)' },
    { z: 11, name: 'Terrarium z11 (61–76 m)' },
  ];

  const FINE_SRC = {
    id: 'terrarium-fine',
    name: 'Terrarium 细源',
    z: 11,
    base: 'data/public/dem/_terrarium_cache/',
    // 缓存里只有中国陆地这个范围（z12 缓存按 71–137E / 16–56N 建）
    west: 71.0, east: 137.0, south: 16.0, north: 56.0,
    tiles: new Map(),
    pending: new Set(),
    // 已确认不存在的瓦片（key → 时间戳），避免每帧重试
    missing: new Map(),
    // 曾被 LRU 淘汰过的瓦片键（key → 时间戳）。
    // 【为什么要记】被淘汰的瓦片再次被预取时，网络上会**重新下载**
    // （浏览器缓存能不能兜住取决于服务器发不发 Cache-Control）。
    // 有了这张表就能量化「重复下载」到底有多少 —— 诊断用。
    evicted: new Map(),
    stats: { loaded: 0, requests: 0, bytes: 0, calls: 0, refetched: 0, lastWanted: null },
    ready: false,
    // 【全局预算】本次会话已**发起**的细源拉取次数（去重后的唯一瓦片数）。
    //
    // 【为什么必须是全局而不是每次调用】
    //   旧实现里 fineMaxTiles() 是「每次 ensureFineRect 的上限」。
    //   但 Cesium 的 LOD 链会把同一个视野拆成 **12 个层级矩形**
    //   （实测 22.5° → 0.176°），每个矩形各自取满上限 → 总量无界。
    //   实测：finemax=512 时单个矩形就能要 512 张，
    //   冷启动累计请求 3836 次 / 577.9 MB，而且因为 ensureRect 是
    //   采样的前置条件（terrain.js 的 callback 里 await 它），
    //   地形瓦片被拖到 8 s 之后才采样 → Cesium 只渲染出 **1 块** level 6 粗瓦片，
    //   画面停在低精度状态 —— 这就是「加载太慢」的成因。
    //
    //   改成全局预算后：无论 LOD 链拆出多少个矩形，
    //   整个会话的细源拉取量都被 fineBudget() 卡住。
    budgetUsed: 0,
    // 本次「需求重置」的序号：相机大幅移动时重置预算，
    // 让新视野有机会再拿一批瓦片（否则拖动一次就永久用完预算）。
    budgetEpoch: 0,
    // 上一次重置预算时的相机经纬度（用于判断「相机是否移动了足够远」）
    lastBudgetPos: null,
    // 「保护区」瓦片键集合（相机脚下），LRU 淘汰时跳过。见 evictFine。
    protectKeys: null,
    // 焦点瓦片（相机脚下那张）：ensureFineRect 超预算时按到它的距离取舍。
    focus: null,
    // 渲染瓦片 → 细源瓦片命中表的增量缓存（renderedFineTiles 用）。
    // 键是渲染瓦片的矩形，值是该瓦片顶点网格穿过的细源瓦片及命中次数。
    // 相机移动会不断产生新键，缓存上限 8000 条后整体清空。
    renderCache: new Map(),
  };

  /** 当前生效级别的瓦片根目录。 */
  function fineBase() {
    return FINE_SRC.base + FINE_SRC.z + '/';
  }

  /** WebMercator 的归一化 y（0..1）→ 纬度。
   *  必须与 tools/make_china_dem.py 的 inv_merc_lat 保持一致：
   *  它接收的是**归一化** y，不是瓦片索引。 */
  function fineSrcLatFromY(yNorm) {
    const t = Math.PI * (1 - 2 * yNorm);
    return Math.atan(Math.sinh(t)) * (180 / Math.PI);
  }

  /** 经纬度 → z11 瓦片索引（分数）。
   *  【坑】标准 WebMercator 是 y = (1 - log(...)/π)/2 * n，
   *  不是 (0.5 - log(...)/π) * n —— 后者差一个 2 倍，
   *  实测会让 36.6°N 落到 y=576 而不是 y=800，瓦片全取错。 */
  function fineSrcTileXY(lon, lat) {
    const n = 1 << FINE_SRC.z;
    const x = ((lon + 180) / 360) * n;
    const rad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    return { x: x, y: y };
  }

  function fineSrcKey(tx, ty) {
    return tx * 1048576 + ty;
  }

  /**
   * 拉取并解码一张 z11 源瓦片。
   * 存的是解码后的 Float32Array(256*256)，避免每次采样都解 PNG。
   */
  const streaming = new URLSearchParams(location.search).get('terrainstream') !== '0';
  const batchFine = new URLSearchParams(location.search).get('finegrid') !== '0';
  let batchMeshes = 0;
  const detailJobs = new Map(), retryAfter = new Map();
  const detailStats = { peak: 0, aborted: 0, transient: 0, worker: 0, fallback: 0 };
  const DETAIL_SLOTS = 4;
  let decoder, decoderDisabled = false, decodeSequence = 0;
  const decoding = new Map();
  let fallbackTail = Promise.resolve();
  function fallbackDecode(blob) {
    detailStats.fallback++;
    const job = fallbackTail.then(function () {
      return new Promise(function (resolve) {
        if (document.hidden) setTimeout(resolve, 16); else requestAnimationFrame(resolve);
      }).then(function () { return decodeTerrariumBlob(blob); });
    });
    fallbackTail = job.catch(function () {});
    return job;
  }
  function workerDecode(blob) {
    if (decoderDisabled || !window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) {
      return fallbackDecode(blob);
    }
    return new Promise(function (resolve, reject) {
      if (!decoder) {
        decoder = new Worker('js/workers/dem-decode.js');
        decoder.onmessage = function (e) {
          const j = decoding.get(e.data.id);
          if (!j) return;
          decoding.delete(e.data.id);
          if (e.data.error) j.reject(new Error(e.data.error));
          else { detailStats.worker++; j.resolve(new Float32Array(e.data.buffer)); }
        };
        decoder.onerror = function () {
          decoderDisabled = true;
          decoder.terminate(); decoder = null;
          for (const j of decoding.values()) j.reject(new Error('DEM worker unavailable'));
          decoding.clear();
        };
      }
      const id = ++decodeSequence;
      decoding.set(id, { resolve: resolve, reject: reject });
      try { decoder.postMessage({ id: id, blob: blob }); }
      catch (e) { decoding.delete(id); reject(e); }
    }).catch(function () {
      return fallbackDecode(blob);
    });
  }

  // Called by Cesium before accepting a child mesh. Returning false leaves its
  // drawable parent in place. Undispatched work lives in Cesium's view-prioritized
  // traversal, not in a second FIFO. No whole-view promise can block a child.
  function detailReady(w, s, e, n, level) {
    if (!state.enabled || level < FINE_SRC.z - 1 ||
        e < FINE_SRC.west || w > FINE_SRC.east || n < FINE_SRC.south || s > FINE_SRC.north) return true;
    if (!FINE_SRC.ready) return fineInitState !== 'running';
    const a = fineSrcTileXY(Math.max(w, FINE_SRC.west), Math.min(n, FINE_SRC.north));
    const b = fineSrcTileXY(Math.min(e, FINE_SRC.east), Math.max(s, FINE_SRC.south));
    const now = performance.now();
    let ready = true;
    // Half-pixel interpolation at the tile edge may need the next PNG.
    const halo = FINE_SRC.z === 12 ? 0.002 : 0;
    for (let y = Math.floor(a.y-halo); y <= Math.floor(b.y+halo); ++y) {
      for (let x = Math.floor(a.x-halo); x <= Math.floor(b.x+halo); ++x) {
        const key = fineSrcKey(x, y);
        if (FINE_SRC.tiles.has(key) || FINE_SRC.missing.has(key)) continue;
        const retry = retryAfter.get(key);
        if (retry && retry.until > now) {
          if (retry.count < 3) ready = false; // keep parent during short retries
          continue;
        }
        ready = false;
        const job = detailJobs.get(key);
        if (job) { job.lastSeen = now; continue; }
        if (detailJobs.size < DETAIL_SLOTS) fetchFineTile(x, y);
      }
    }
    return ready;
  }
  function discardOldDetail() {
    const now = performance.now();
    for (const j of detailJobs.values()) {
      if (now - j.lastSeen > 900 && j.controller && !j.controller.signal.aborted) j.controller.abort();
    }
  }

  function fetchFineTile(tx, ty) {
    const key = fineSrcKey(tx, ty);
    if (streaming && detailJobs.has(key)) return detailJobs.get(key).promise;
    if (FINE_SRC.pending.has(key)) return Promise.resolve(false);
    if (FINE_SRC.tiles.has(key)) return Promise.resolve(true);
    FINE_SRC.pending.add(key);
    const url = fineBase() + tx + '/' + ty + '.png';
    // 【诊断】本次拉取是不是「以前拉过、但被 LRU 淘汰了又拉一遍」——
    // 这是细源重复请求的根源，也是首屏慢的主要来源。
    const seenBefore = FINE_SRC.evicted.has(key);
    FINE_SRC.stats.calls += 1;
    if (seenBefore) FINE_SRC.stats.refetched += 1;
    FINE_SRC.stats.lastWanted = url;
    const job = { controller: streaming ? new AbortController() : null, lastSeen: performance.now() };
    if (streaming) {
      detailJobs.set(key, job);
      detailStats.peak = Math.max(detailStats.peak, detailJobs.size);
    }
    job.promise = fetch(url, job.controller ? { signal: job.controller.signal } : undefined)
      .then(function (res) {
        if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
        return res.blob();
      })
      .then(function (blob) {
        return streaming ? workerDecode(blob) : decodeTerrariumBlob(blob);
      })
      .then(function (elev) {
        retryAfter.delete(key);
        const dim = 1 << FINE_SRC.z;
        FINE_SRC.tiles.set(key, { data: elev, t: Date.now(),
          north: fineSrcLatFromY(ty/dim), south: fineSrcLatFromY((ty+1)/dim) });
        FINE_SRC.stats.loaded = FINE_SRC.tiles.size;
        FINE_SRC.stats.requests += 1;
        FINE_SRC.stats.bytes += 256 * 256 * 4;
        evictFine();
        return true;
      })
      .catch(function (err) {
        // 源瓦片缺失是正常情况（超出中国陆地范围）。
        // 【必须记住失败】否则每一帧都会重试同一张不存在的瓦片 ——
        // 实测这样一次视野预取会打出 40064 个 404 请求。
        if (!streaming || err.status === 404 || err.status === 410) FINE_SRC.missing.set(key, Date.now());
        else if (err.name === 'AbortError') detailStats.aborted++;
        else {
          detailStats.transient++;
          const count = Math.min(3, ((retryAfter.get(key) || {}).count || 0) + 1);
          retryAfter.set(key, { count: count, until: performance.now() + [0, 250, 1000, 15000][count] });
        }
        console.debug('[LEDemTiles] 细源瓦片不可用 ' + tx + '/' + ty + '：' + err.message);
        return false;
      })
      .finally(function () {
        FINE_SRC.pending.delete(key);
        if (streaming) {
          detailJobs.delete(key);
        if (state.viewer && !state.viewer.isDestroyed()) state.viewer.scene.requestRender();
        }
      });
    return job.promise;
  }

  /**
   * 细源瓦片缓存上限（每张解码后 256 KB）。
   *
   * 【为什么从 512 提高到 1536】
   *   60 km 相机实测：渲染顶点网格真正需要约 1141 张细源瓦片。
   *   缓存只有 512 张时，LRU 会淘汰掉 981 张 —— 一旦某张被淘汰，
   *   下次预取又要**重新下载**它（refetched），网络往返白费。
   *   1536 张 ≈ 393 MB 内存，偏大；所以配合顶点间距剪枝（见
   *   fineVertexSlack）把实际需求压到 1000 张以内。
   *
   * 【可调】?finecache=N
   */
  function fineCacheLimit() {
    // Each decoded tile is exactly 256 KiB. Larger user overrides remain explicit.
    const def = streaming ? (navigator.deviceMemory && navigator.deviceMemory <= 4 ? 256 : 512) : 1536;
    try {
      const v = Number(new URLSearchParams(location.search).get('finecache'));
      if (isFinite(v) && v >= 16) return Math.min(8192, Math.floor(v));
    } catch (err) { /* ignore */ }
    return def;
  }
  const FINE_PROTECT_RADIUS = 1;   // 保护区半径（瓦片数），1 = 3x3
  function evictFine() {
    const limit = fineCacheLimit();
    if (FINE_SRC.tiles.size <= limit) return;
    const protect = FINE_SRC.protectKeys;
    const entries = [];
    for (const kv of FINE_SRC.tiles) {
      if (protect && protect.has(kv[0])) continue;   // 保护区不淘汰
      entries.push([kv[0], kv[1].t]);
    }
    entries.sort(function (a, b) { return a[1] - b[1]; });
    const drop = Math.min(entries.length, FINE_SRC.tiles.size - limit);
    for (let i = 0; i < drop; i++) {
      FINE_SRC.tiles.delete(entries[i][0]);
      // 记住被淘汰过的键：下次再要这张时要能识别出「这是重拉」。
      FINE_SRC.evicted.set(entries[i][0], Date.now());
    }
    FINE_SRC.stats.loaded = FINE_SRC.tiles.size;
  }

  /**
   * 设定「保护区」——相机脚下这几个瓦片不许被 LRU 淘汰。
   *
   * 【为什么必要】见 evictFine 的注释：纯 LRU 在高空会把脚下瓦片冲掉，
   * 造成「有些地方突然没有精度改善」。
   */
  function setFineProtect(lon, lat) {
    if (!isFinite(lon) || !isFinite(lat)) return;
    const t = fineSrcTileXY(lon, lat);
    const cx = Math.floor(t.x);
    const cy = Math.floor(t.y);
    FINE_SRC.focus = { tx: cx, ty: cy };
    const keys = new Set();
    for (let dy = -FINE_PROTECT_RADIUS; dy <= FINE_PROTECT_RADIUS; dy++) {
      for (let dx = -FINE_PROTECT_RADIUS; dx <= FINE_PROTECT_RADIUS; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= (1 << FINE_SRC.z) || ty >= (1 << FINE_SRC.z)) continue;
        keys.add(fineSrcKey(tx, ty));
      }
    }
    FINE_SRC.protectKeys = keys;
  }

  /**
   * 解码 Terrarium PNG → Float32Array(256*256) 高程。
   * elevation = R*256 + G + B/256 - 32768
   */
  function decodeTerrariumBlob(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        try {
          const cv = document.createElement('canvas');
          cv.width = 256;
          cv.height = 256;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 256, 256);
          const d = ctx.getImageData(0, 0, 256, 256).data;
          const out = new Float32Array(256 * 256);
          for (let i = 0, p = 0; i < out.length; i++, p += 4) {
            out[i] = d[p] * 256 + d[p + 1] + d[p + 2] / 256 - 32768;
          }
          URL.revokeObjectURL(url);
          resolve(out);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('PNG 解码失败'));
      };
      img.src = url;
    });
  }

  /**
   * 从 z11 细源取高程（米）；未命中返回 null。
   * 瓦片未缓存时**不回退**（异步加载中），由上层按金字塔兜底。
   */
  function fineSrcHeightAt(lon, lat) {
    if (!FINE_SRC.ready) return null;
    if (lon < FINE_SRC.west || lon > FINE_SRC.east) return null;
    if (lat < FINE_SRC.south || lat > FINE_SRC.north) return null;
    const t = fineSrcTileXY(lon, lat);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const hit = FINE_SRC.tiles.get(fineSrcKey(tx, ty));
    if (!hit) return null;
    if (streaming && FINE_SRC.z === 12) {
      // build_srtm_z12.py stores samples at pixel CENTERS, in rows linear in
      // latitude inside each Mercator tile. Sample that exact grid, including seams.
      const px=(t.x-tx)*256-0.5, py=(hit.north-lat)/(hit.north-hit.south)*256-0.5;
      const x0=Math.floor(px), y0=Math.floor(py), fx=px-x0, fy=py-y0;
      function read(x,y) {
        if (x>=0 && x<256 && y>=0 && y<256) return hit.data[y*256+x];
        const next=FINE_SRC.tiles.get(fineSrcKey(tx+(x<0?-1:x>=256?1:0),ty+(y<0?-1:y>=256?1:0)));
        return next ? next.data[((y+256)%256)*256+((x+256)%256)] : NaN;
      }
      const a=read(x0,y0), b=read(x0+1,y0), c=read(x0,y0+1), d=read(x0+1,y0+1);
      if (a>-9000 && b>-9000 && c>-9000 && d>-9000)
        return a*(1-fx)*(1-fy)+b*fx*(1-fy)+c*(1-fx)*fy+d*fx*fy;
      let sum=0, weight=0;
      for (const [v,k] of [[a,(1-fx)*(1-fy)],[b,fx*(1-fy)],[c,(1-fx)*fy],[d,fx*fy]]) {
        if(v>-9000 && k>0){sum+=v*k;weight+=k;}
      }
      return weight ? sum/weight : null; // NoData is not a ten-kilometre-deep valley.
    }
    // 瓦片内像素坐标（0..256）
    const px = (t.x - tx) * 256;
    const py = (t.y - ty) * 256;
    const x0 = Math.min(255, Math.max(0, Math.floor(px)));
    const y0 = Math.min(255, Math.max(0, Math.floor(py)));
    const x1 = Math.min(255, x0 + 1);
    const y1 = Math.min(255, y0 + 1);
    const fx = Math.min(1, Math.max(0, px - x0));
    const fy = Math.min(1, Math.max(0, py - y0));
    const d = hit.data;
    const r0 = y0 * 256;
    const r1 = y1 * 256;
    return (
      d[r0 + x0] * (1 - fx) * (1 - fy) +
      d[r0 + x1] * fx * (1 - fy) +
      d[r1 + x0] * (1 - fx) * fy +
      d[r1 + x1] * fx * fy
    );
  }

  /** 细源的像元尺度（度）。≈76 m/px。 */
  function fineSrcResolutionDeg() {
    const n = 1 << FINE_SRC.z;
    return (360 / n) / 256;
  }

  /**
   * 细源像元的**地面尺度**（米）。
   *
   * z12 在北纬 36.6 是 30.7 m/px，赤道附近约 27 m，越往北越大。
   * 用 30° 作为中位参考（与统计里的 cos(π/6) 一致）。
   */
  function fineSrcResolutionMeters() {
    return fineSrcResolutionDeg() * 111320 * Math.cos(Math.PI / 6);
  }

  /**
   * 细源预取的门限：**屏幕分辨率**粗于细源时，不拉细源瓦片。
   *
   * 【判据】
   *   屏幕每像素对应的地面距离 > 细源像元 × 4（细源 31 m → 门限 124 m/px）
   *   时，细源在屏幕上是**分辨不出来的** —— 拉下来是纯浪费带宽和时间。
   *
   * 【为什么不用「顶点间距」做判据】
   *   曾试过「渲染网格顶点间距 > 细源像元 × 4 就跳过」，**是错的**。
   *   实测（§6.3.1）渲染网格的每一个顶点都取自细源（rms = 0），
   *   **哪怕顶点间距已经是 2446 m** —— 细源照样进了几何。
   *   顶点间距粗不会让细源失效，只会让它「被采样得更稀」。
   *   实测 60 000 m 高度时顶点间距 2446 m、屏幕 88 m/px，
   *   细源仍占采样的 87.5 %。
   *   → 只有**屏幕分辨率**才是「看不看得见」的正确判据。
   *
   * 【实测对照（108.9E/36.6N，z12 细源 31 m/px）】
   *   相机高度 | 屏幕 m/px | 细源占比 | 决定
   *   -----------|-----------|---------|------
   *      6 000 m |     9     |  97.8 %  | 拉
   *     20 000 m |    29     |  95.4 %  | 拉
   *     40 000 m |    59     |  44.5 %  | 拉
   *     60 000 m |    88     |  87.5 %  | 拉
   *    100 000 m |   147     |   0 %   | **跳**（细源已无贡献）
   *    200 000 m |   294     |   0 %   | **跳**
   *   20 000 km  | 29 416    |   0 %   | **跳**（省 1217 张 / 157 MB）
   *
   *   门限 124 m/px 正好落在「细源占比 87.5 %」与「0 %」之间 ——
   *   这不是拍脑袋，是从实测曲线里读出来的。
   *
   * 【怎么关掉】
   *   ?finesrc=0 全关；?finemax=0 只关预取但保留采样。
   */
  function finePrefetchUseful(groundPerPixel) {
    if (fineMaxTiles() <= 0) return false;
    if (!isFinite(groundPerPixel) || groundPerPixel <= 0) return true; // 算不出就照旧
    return groundPerPixel <= fineSrcResolutionMeters() * 4;
  }

  /**
   * 当前渲染网格的顶点间距（米）—— **仅用于诊断**。
   *
   * 取 Cesium 正在渲染的地形瓦片里**最细的那层**（level 最大 = 顶点最密），
   * 换算成地面间距：span = 2πR / 2^level，顶点数 = grid。
   *
   * 【注意】粗粒度的祖先瓦片会一直留在渲染列表里（实测 6 km 近景下
   *   _tilesToRender 同时含 level 2/14/15/16，共 460 张）。祖先瓦片是
   *   「还没被细分时的替身」，不代表画面上的实际几何密度 ——
   *   取最小 level 会得到 level 2（间距 626 km），完全失真。
   *   代表画面最细几何的是 **level 最大的那批**。
   *
   * 【注意】这个值**不能**用来判断细源有没有用 —— 见 finePrefetchUseful
   *   的注释：顶点间距粗时细源照样进几何（实测 rms = 0）。
   */
  function renderedVertexSpacing(viewer) {
    if (!viewer) return 0;
    let level = -1;
    let found = false;
    try {
      const tiles = viewer.scene.globe._surface._tilesToRender;
      if (tiles) {
        for (const t of tiles) {
          if (!found || t.level > level) { level = t.level; found = true; }
        }
      }
    } catch (err) {
      /* ignore */
    }
    if (!found || level < 0) return 0;
    const R = 6378137;
    let grid = 0;
    try {
      const st = stats();
      if (st && st.terrainGrid > 1) grid = st.terrainGrid;
    } catch (err) {
      /* ignore */
    }
    if (!grid) grid = 65;
    const span = 2 * Math.PI * R / Math.pow(2, level);
    const s = span / (grid - 1);
    return isFinite(s) && s > 0 ? s : 0;
  }

  /** 确保某个矩形内的细源瓦片都已加载（或已确认缺失）。 */
  function ensureFineRect(west, south, east, north, groundPerPixel) {
    if (streaming) return Promise.resolve(true); // visible child geometry owns fine demand
    if (!FINE_SRC.ready) return Promise.resolve(false);
    // 【屏幕分辨率门控】屏幕每像素的地面距离已经粗于细源 4 倍时，
    // 拉下来的瓦片在屏幕上看不出来 —— 不拉。
    // 实测默认视角（相机 20 000 km）省掉 1217 张 / 157 MB。
    let gpp = groundPerPixel;
    if (gpp === undefined && state.viewer) {
      // 没传就自己算 —— ensureLoaded 可能在相机更新之前被调用。
      let h = 0;
      try {
        const c = state.viewer.camera.positionCartographic;
        if (c) h = c.height;
      } catch (err) {
        /* ignore */
      }
      gpp = groundMetersPerPixel(state.viewer, h);
    }
    if (!finePrefetchUseful(gpp)) {
      state.stats.fineSkippedByResolution = (state.stats.fineSkippedByResolution || 0) + 1;
      return Promise.resolve(true);
    }

    // 【LOD 剪枝】只给「会被真正渲染」的层级拉细源。
    //
    // 【为什么】terrain.js 的 provider callback 传给 ensureRect 的矩形
    //   就是 Cesium 正在请求的那一块地形瓦片，跨度 = 360/2^level。
    //   冷启动时 Cesium 的 LOD 链会依次请求 L0(22.5°) → L15(0.0055°)，
    //   每一级都触发一次 ensureRect —— 而 L0–L8 只是**占位祖先**，
    //   它们的顶点间距（4.9 km 起）远粗于细源（27–35 m），
    //   拉它们的细源瓦片是 100 % 的浪费。
    //   实测 finemax=512 时这 9 次调用里有 8 次是在粗层上，共拉了
    //   3836 次请求 / 577.9 MB，而且把采样拖到 8 s 之后。
    //
    // 【怎么判】读 Cesium 实际在渲染的 level 集合
    //   （scene.globe._surface._tilesToRender，排除 upsampledFromParent 的替身）。
    //   读不到就保守处理（不剪枝），保证功能不退化。
    const span = Math.max(Math.abs(east - west), Math.abs(north - south));
    const level = cesiumLevelOfSpan(span);
    if (level >= 0) {
      const rendered = renderedLevelSet();
      if (rendered.size && !rendered.has(level)) {
        // 这一级不在渲染集合里 → 它是占位祖先 → 不拉细源
        state.stats.fineSkippedByAncestor = (state.stats.fineSkippedByAncestor || 0) + 1;
        return Promise.resolve(true);
      }
    }
    // 【必须裁剪到有效范围】不裁剪的话，视野矩形稍微越界就会算出
    // 几万张不存在的瓦片（实测一次调用打出 40064 个请求，全是 404）。
    const w = Math.max(west, FINE_SRC.west);
    const e = Math.min(east, FINE_SRC.east);
    const s = Math.max(south, FINE_SRC.south);
    const n = Math.min(north, FINE_SRC.north);
    if (w > e || s > n) return Promise.resolve(true);

    // 【候选集 = 真正会被渲染的地形瓦片所穿过的细源瓦片】
    //
    // 【为什么不用「当前 LOD 矩形」】
    //   provider callback 传的矩形是**单块** Cesium 瓦片。LOD 链里
    //   每一级各传一块 → 每级在自己的小矩形里选细源瓦片，
    //   结果既漏掉中间层，又在粗层上白拉。
    //
    // 【实测证据】
    //   60 km 相机：贡献点（关细源 vs 开细源高程不同的顶点）
    //   落在 level 9/10/11/12 **四级**上、经度 101.60–103.45、
    //   纬度 25.36–26.74、距相机 0.50–1.95°。
    //   只按「相机脚下最近 N 张」选 → 半径只有 0.7° →
    //   覆盖不到 1.3° 处的贡献带 → 细源贡献直接归零（实测 0.00%）。
    //
    // 【正确做法】用 renderedFineTiles()：Cesium 实际在渲染的地形瓦片，
    //   它们顶点网格穿过的细源瓦片 —— 就是会被真正采样的那些。
    //   读不到渲染集合时退回「当前矩形」，功能不退化。
    const renderedSet = renderedFineTiles();
    const focus = focusPoint();
    const cand = [];
    const seenKeys = new Set();
    const pushCand = function (tx, ty) {
      const key = fineSrcKey(tx, ty);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      if (FINE_SRC.tiles.has(key) || FINE_SRC.pending.has(key)) return;
      if (FINE_SRC.missing.has(key)) return;
      let d = 0;
      if (focus) {
        const dx = tx - focus.tx;
        const dy = ty - focus.ty;
        d = dx * dx + dy * dy;
      }
      cand.push([d, tx, ty, key]);
    };

    if (renderedSet && renderedSet.size) {
      // 按「被采样的顶点数」降序排 —— 命中越多的细源瓦片越该先拉。
      // 这比「按到相机的距离」准：近场常被 overlay 覆盖（细源白拉），
      // 而真正需要细源的是 overlay 之外、仍被顶点网格采样的地方。
      const entries = [];
      for (const [k, hits] of renderedSet) entries.push([-hits, k]);
      entries.sort(function (a, b) { return a[0] - b[0]; });
      for (const en of entries) {
        const p = en[1].split('/');
        pushCand(Number(p[0]), Number(p[1]));
      }
    } else {
      const t0 = fineSrcTileXY(w, n);
      const t1 = fineSrcTileXY(e, s);
      const x0 = Math.max(0, Math.floor(t0.x));
      const x1 = Math.min((1 << FINE_SRC.z) - 1, Math.floor(t1.x));
      const y0 = Math.max(0, Math.floor(t0.y));
      const y1 = Math.min((1 << FINE_SRC.z) - 1, Math.floor(t1.y));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) pushCand(tx, ty);
      }
    }
    if (!cand.length) return Promise.resolve(true);

    // 【上限护栏】视野突然变大（比如相机拉到斜视角）时瓦片数会暴涨。
    // 细源是锦上添花，不是必需项 —— 超预算就少取一些，宁可细一点也别打爆网络。
    //
    // 【现在是全局预算】budget 是整个会话还能再拉多少张，
    //   不是「这一次调用可以拉多少张」。见 fineBudget 的注释。
    const budget = fineBudget() - FINE_SRC.budgetUsed;
    if (budget <= 0) {
      state.stats.fineBudgetExhausted = (state.stats.fineBudgetExhausted || 0) + 1;
      return Promise.resolve(true);
    }
    const MAX_TILES = budget;
    if (cand.length > MAX_TILES) {
      cand.sort(function (a, b) { return a[0] - b[0]; });
      cand.length = MAX_TILES;
    }
    const promises = [];
    for (let i = 0; i < cand.length; i++) {
      promises.push(fetchFineTile(cand[i][1], cand[i][2]));
    }
    // 记账：这批算进全局预算。
    FINE_SRC.budgetUsed += cand.length;
    if (!promises.length) return Promise.resolve(true);
    return Promise.all(promises).then(function () { return true; });
  }

  /**
   * Cesium **实际在渲染**的地形瓦片所覆盖的细源瓦片集合（精确，无空洞）。
   *
   * 【为什么不能用「并集外接矩形」】
   *   489 块渲染瓦片散布在一个大矩形里，中间有大片空洞（那是更粗的
   *   层级占据的地方，或者干脆没瓦片）。用外接矩形会把洞里的细源瓦片
   *   也算成「需要」—— 那是纯浪费。
   *
   * 【怎么做才精确】
   *   逐块渲染瓦片，遍历它的 65×65 顶点网格，把每个顶点映射到细源瓦片，
   *   取并集 —— 这就是「真正会被采样到的细源瓦片」。
   *   比「按瓦片矩形推算」精确：矩形推算会把顶点网格没碰到的
   *   边角细源瓦片也算进去。
   *
   * 【开销】489 块 × 65×65 = 207 万次映射，只在预取时算一次，
   *   实测 < 30 ms，可以接受。
   *
   * 【返回】Map（'tx/ty' → 命中顶点数），读不到渲染集合时返回 null。
   *   命中次数 = 这块细源瓦片会被采样多少个顶点 → 越该先拉。
   */
  function renderedFineTiles() {
    const viewer = state.viewer;
    if (!viewer || !viewer.scene || !viewer.scene.globe) return null;
    const out = new Map();
    let count = 0;
    let grid = 65;
    try {
      const st = stats();
      if (st && st.terrainGrid > 1) grid = st.terrainGrid;
    } catch (err) {
      /* ignore */
    }
    try {
      const tiles = viewer.scene.globe._surface._tilesToRender;
      if (!tiles) return null;
      for (const t of tiles) {
        if (!t) continue;
        if (t.upsampledFromParent) continue;
        const rect = t.rectangle || t._rectangle;
        if (!rect) continue;
        const w = C2deg(rect.west), e = C2deg(rect.east);
        const s = C2deg(rect.south), n = C2deg(rect.north);
        if (!isFinite(w) || !isFinite(e) || !isFinite(s) || !isFinite(n)) continue;
        if (w < FINE_SRC.west || e > FINE_SRC.east) continue;
        if (s < FINE_SRC.south || n > FINE_SRC.north) continue;
        count++;
        // 【增量缓存】同一块渲染瓦片的顶点→细源映射是**静态**的
        //   （只取决于瓦片矩形和细源 z），渲染集没变就不用重算。
        //   旧实现每次调用都重算全部瓦片的 65×65 网格（≈200 万次），
        //   而 ensureFineRect 一次会话会被调 1000+ 次 → 纯 CPU 空转
        //   （实测 35 km 相机：1085 次 ensureRect 累计 22.7 s，
        //     其中大量条目「0 个网络请求却耗 164 ms」）。
        const ckey = t.__fineHitsKey || (t.__fineHitsKey = w.toFixed(5) + '/' + s.toFixed(5) + '/' + e.toFixed(5) + '/' + n.toFixed(5));
        let entry = FINE_SRC.renderCache.get(ckey);
        if (!entry) {
          entry = computeTileFineHits(w, s, e, n, grid);
          // 【缓存上限】相机移动会不断产生新瓦片，缓存无限增长会吃内存。
          if (FINE_SRC.renderCache.size > 8000) FINE_SRC.renderCache.clear();
          FINE_SRC.renderCache.set(ckey, entry);
        }
        if (entry.skipped) {
          state.stats.fineSkippedByCoarse = (state.stats.fineSkippedByCoarse || 0) + 1;
          continue;
        }
        for (const [k, hits] of entry.hits) out.set(k, (out.get(k) || 0) + hits);
      }
    } catch (err) {
      return null;
    }
    return count ? out : null;
  }

  /**
   * 单块渲染瓦片的顶点网格 → 细源瓦片命中表（可缓存）。
   *
   * @returns {{skipped: boolean, hits: Map}}
   *   skipped=true 表示该层顶点间距过粗（欠采样细源），整层跳过。
   */
  function computeTileFineHits(w, s, e, n, grid) {
    // 【顶点间距剪枝】该层的顶点间距远粗于细源像元时，
    // 顶点采样会强烈欠采样细源（单点采样，丢掉大量细节），
    // 拉这些细源瓦片性价比最低。
    // 阈值用倍数表示：细源像元 × K（默认 16）。
    //   level 9  顶点间距 610 m / 34.6 m = 17.6×  → 剪
    //   level 10 300 m / 34.6 m =  8.7×  → 留
    //   level 11 152 m / 34.6 m =  4.4×  → 留
    //   level 12  78 m / 34.6 m =  2.3×  → 留
    const fineMeters = fineSrcResolutionMeters();
    const stepI = (e - w) / (grid - 1);
    const stepJ = (n - s) / (grid - 1);
    const vsMeters = stepI * 111320 * Math.cos((C2deg(n) * Math.PI) / 180);
    if (vsMeters > fineMeters * fineVertexSlack()) {
      return { skipped: true, hits: new Map() };
    }
    const hits = new Map();
    for (let j = 0; j < grid; j++) {
      const lat = n - stepJ * j;
      const ty = Math.floor(fineSrcTileXY(w, lat).y);
      for (let i = 0; i < grid; i++) {
        const lon = w + stepI * i;
        const tx = Math.floor(fineSrcTileXY(lon, lat).x);
        const k = tx + '/' + ty;
        hits.set(k, (hits.get(k) || 0) + 1);
      }
    }
    return { skipped: false, hits: hits };
  }

  /**
   * 顶点间距剪枝的倍数阈值（诊断可调：?fineK=N，默认 16）。
   *
   * 【含义】某渲染层的顶点间距 > 细源像元 × K 时，
   *   这一层的顶点采样会强烈欠采样细源，拉它的细源瓦片性价比最低。
   *
   * 【实测（60 km 相机，z12 细源 34.6 m/px @北纬 25）】
   *   level  跨度      顶点间距   倍数    贡献点（原始 finemax=512）
   *     9   0.3516°   610 m      17.6×      2 003  (0.7 %)
   *    10   0.1758°   300 m       8.7×     40 008 (13.7 %)
   *    11   0.0879°   152 m       4.4×    226 143 (77.6 %)
   *    12   0.0440°    78 m       2.3×     23 277 ( 8.0 %)
   *   → K=16 正好只剪掉 level 9（贡献最小的一层），保留 99.3 % 的贡献。
   */
  function fineVertexSlack() {
    const def = 16;
    try {
      const v = Number(new URLSearchParams(location.search).get('fineK'));
      if (isFinite(v) && v >= 1) return Math.min(256, Math.floor(v));
    } catch (err) { /* ignore */ }
    return def;
  }

  /**
   * 细源单次预取上限（诊断可调：?finemax=N）。
   *
   * 【为什么要有上限】视野在高空能覆盖几千张 z12 瓦片（90 KB/张），
   * 全拉一遍就是几百 MB，会把主线程和网络一起压死。
   * 默认 64 张是「脚下 8×8 块」左右的量，够覆盖一个近景视野。
   *
   * 【现在是全局预算，不是「每次调用的上限」】
   *   旧语义：每次 ensureFineRect 各自取满 N 张。
   *   问题：Cesium 的 LOD 链把同一视野拆成 12 个层级矩形（实测
   *   22.5° → 0.176°），每个都取满 → 总量 = 12 × N，无界。
   *   实测 finemax=512 时累计请求 3836 次 / 577.9 MB。
   *   新语义：整个会话（一次 epoch 内）细源拉取总量 ≤ N。
   *   epoch 由相机大幅移动重置（见 resetFineBudget）。
   */
  function fineMaxTiles() {
    // 【默认值 64 → 1536】
    //   语义变了：现在是**整个会话的全局预算**，不是「每次调用的上限」。
    //   旧默认 64 在新语义下等于「整个会话只准拉 64 张」——
    //   实测 60 km 相机需要约 1475 张才能覆盖全部贡献点，
    //   64 张只能覆盖 0.5° 半径 → 贡献从 28.5 % 掉到 0 %。
    //
    //   【1536 是实测出来的饱和点】按相机高度实测真实需求：
    //     9 km   →   23 张      35 km →  567 张
    //    20 km   →  135 张      60 km → 1475 张  ← 峰值
    //   100 km   →    1 张     150 km →   1 张（顶点间距剪枝把粗层全剪了）
    //   60 km 下 finemax=1024 只拉到 1025 张 → 像素差 3.87 %；
    //   finemax=1536 拉到 1460 张 → 与 2048 **像素完全一致**（0 差异）。
    //   1536 张 ≈ 400 MB 内存 / 235 MB 网络，是「完整覆盖」与「不失控」的平衡点。
    const def = 1536;
    try {
      const v = Number(new URLSearchParams(location.search).get('finemax'));
      if (isFinite(v) && v >= 1) return Math.min(4096, Math.floor(v));
    } catch (err) { /* ignore */ }
    return def;
  }

  /**
   * 细源的**全局预算**（整个会话共可拉多少张）。
   *
   * 【为什么必须是全局的】见 fineMaxTiles 的注释 —— 12 个 LOD 矩形
   * 各自取满上限就是无界的。实测 finemax=512 时：
   *   - 细源请求 3836 次 / 577.9 MB
   *   - ensureRect 单次最慢 8174 ms
   *   - 因为 terrain.js 的 provider callback 会 **await ensureRect**，
   *     采样被推迟到细源全部下载完之后 → Cesium 只渲染出 **1 块** level 6
   *     粗瓦片，画面停在低精度状态。
   *   改成 finemax=16 后：渲染瓦片 376 块（level 14/15），
   *   总字节 75.7 MB —— 这才是「加载快 + 画面细」的样子。
   */
  function fineBudget() {
    return fineMaxTiles();
  }

  /** 重置全局预算（相机大幅移动时调用，给新视野一次机会）。 */
  function resetFineBudget() {
    FINE_SRC.budgetUsed = 0;
    FINE_SRC.budgetEpoch += 1;
  }

  /**
   * 这个矩形对应的 **Cesium 地形 LOD 层级**（由瓦片跨度反推）。
   *
   * 【为什么需要】
   *   terrain.js 的 provider callback 传给 ensureRect 的矩形，
   *   就是 Cesium 正在请求的那一块地形瓦片的矩形，
   *   所以跨度 = 360/2^level（Web Mercator）→ level 可直接反推。
   *
   * 【为什么重要】
   *   Cesium 渲染时，**比当前 LOD 粗的层级只是"占位祖先"**，
   *   它们的顶点间距远大于细源分辨率 —— 细源在那些顶点上必输，
   *   拉它们纯属浪费。实测冷启动时 LOD 链会依次请求
   *   L0(22.5°) → L1 → … → L15(0.0055°)，每一级都独立触发一次
   *   ensureRect，于是粗层的细源瓦片被反复拉了一遍又一遍。
   */
  function cesiumLevelOfSpan(spanDeg) {
    if (!isFinite(spanDeg) || spanDeg <= 0) return -1;
    const level = Math.round(Math.log2(360 / spanDeg));
    return level >= 0 && level <= 22 ? level : -1;
  }

  /**
   * 该 LOD 层级上，**细源能不能赢过金字塔**。
   *
   * 【判据】地形网格是 grid×grid 个顶点覆盖整块瓦片，
   *   顶点间距 = 瓦片跨度 / (grid - 1)。
   *   细源像元 ≈ 27–35 m/px，金字塔最细层 L4 ≈ 1261 m/px。
   *   顶点间距比细源像元还细 → 那个顶点上细源必然赢（金字塔更粗）；
   *   但顶点间距远粗于细源像元时，细源只是「被采样得更稀」，
   *   仍然比金字塔细 —— 它依然是唯一的高精度来源。
   *
   *   → 所以真正的问题是「这一级会不会被**渲染**」。
   *
   * 【实测的渲染层级（探针 tools/probe-fine-usage.mjs）】
   *   相机 9 km  → 渲染 level 14/15（顶点间距 9.6–19 m）
   *   相机 60 km → 渲染 level 9–12（顶点间距 44–344 m）
   *   相机 250 km→ 渲染 level 6–8
   *   粗于这些的层级只是占位祖先。
   *
   * 【怎么判定「当前会被渲染的最粗层级」】
   *   直接问 Cesium：读 scene.globe._surface._tilesToRender 里
   *   实际在渲染的 level 集合（ancestor 不算，up=1 的替身不算）。
   *   provider callback 触发时 Cesium 已经选好级别，这一读法是准的。
   *   读不到就保守处理（不跳过任何层级）。
   */
  function renderedLevelSet() {
    const out = new Set();
    const viewer = state.viewer;
    if (!viewer || !viewer.scene || !viewer.scene.globe) return out;
    try {
      const tiles = viewer.scene.globe._surface._tilesToRender;
      if (!tiles) return out;
      for (const t of tiles) {
        if (!t) continue;
        // upsampledFromParent = 用父级几何放大的替身，不代表这级的真实几何
        if (t.upsampledFromParent) continue;
        const lv = t.level != null ? t.level : t._level;
        if (lv == null) continue;
        out.add(lv);
      }
    } catch (err) {
      /* ignore */
    }
    return out;
  }


  /**
   * 当前应优先保证的「焦点瓦片」（相机脚下那张）。
   *
   * 【为什么单独要一个】
   * ensureFineRect 超预算时按到焦点的距离取最近的若干张，
   * 但焦点的瓦片本身可能因为「已在缓存」而不在候选里 —— 这没问题。
   * 真正的问题是：焦点必须**始终**被包含，且它的邻域要被保护不被淘汰。
   */
  function focusPoint() {
    const t = FINE_SRC.focus;
    if (!t) return null;
    return t;
  }

  /**
   * 相机当前所在的经纬度（探测用）。
   *
   * 【为什么需要】细源探测点如果全用硬编码城市，可能恰好落在
   * 数据尚未建好的区域（分批建库时很常见），导致整层被判为不可用。
   * 相机位置是用户正在看的地方，那里的数据最可能已就绪。
   */
  function cameraProbePoint() {
    try {
      const v = state.viewer;
      if (!v || !v.camera) return null;
      const c = v.camera.positionCartographic;
      if (!c) return null;
      if (!isFinite(c.longitude) || !isFinite(c.latitude)) return null;
      return [c.longitude * (180 / Math.PI), c.latitude * (180 / Math.PI)];
    } catch (err) {
      return null;
    }
  }

  /** 细源探测的状态：'idle' | 'running' | 'done'。 */
  let fineInitState = 'idle';
  /** 是否已经用相机位置重探过一次（避免每帧重试）。 */
  let fineRetryWithCamera = false;

  /**
   * 细源是否可用：**逐级探测**，取第一个真正有瓦片的级别。
   *
   * 【为什么要探测而不是写死】
   * z12（SRTM 1″ 重建）是新数据，z11 是旧数据。最终目标是让 z11 目录
   * 直接删掉、只留 z12 —— 但代码不应该因为「某个级别目录不存在」
   * 就整个地形失效。逐级探测让两种布局都能跑。
   *
   * 用户可以在 URL 里用 ?finesrc=0 关掉它，?finez=11 强制某个级别。
   */
  function initFineSource() {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('finesrc') === '0') return Promise.resolve(false);
      var forcedZ = params.get('finez');
    } catch (err) { forcedZ = null; }
    if (fineInitState === 'running') return Promise.resolve(false);
    // 上一轮已探完但还没用相机位置重探过 → 允许再探一次
    if (fineInitState === 'done' && (FINE_SRC.ready || fineRetryWithCamera)) {
      return Promise.resolve(FINE_SRC.ready);
    }
    fineInitState = 'running';

    // 探测点：多个，覆盖不同区域。
    // 【为什么要多个】只探一个点的话，那个点缺数据（比如边界处
    // 正好没建到）就会让整层细源被判为不可用 —— 哪怕全国 99% 的
    // 区域都有数据。多点探测取「任一成功」，容错性好得多。
    //
    // 【为什么要相机位置优先】硬编码的城市点可能恰好在数据未建的
    // 区域（分批建库时很常见）。相机位置几乎总是用户正在看的
    // 地方 —— 那里的数据最可能已经就绪。
    var PROBE_POINTS = [
      [102.42, 25.03],   // 昆明
      [116.40, 39.90],   // 北京
      [113.26, 23.13],   // 广州
      [108.94, 34.34],   // 西安
      [87.62, 43.82],    // 乌鲁木齐
      [91.14, 29.65],    // 拉萨
    ];
    // 相机位置插到最前面
    var camPt = cameraProbePoint();
    if (camPt) {
      // 相机位置可用 → 这是「用相机重探」的那一轮
      fineRetryWithCamera = true;
      PROBE_POINTS.unshift(camPt);
    }
    var candidates = FINE_LEVELS.slice();
    if (forcedZ) {
      candidates = FINE_LEVELS.filter(function (L) { return String(L.z) === String(forcedZ); });
      if (!candidates.length) {
        console.warn('[LEDemTiles] 未知细源级别 ' + forcedZ);
        return Promise.resolve(false);
      }
    }

    function tryLevel(i) {
      if (i >= candidates.length) return Promise.resolve(false);
      var L = candidates[i];
      FINE_SRC.z = L.z;
      FINE_SRC.name = L.name;
      // 换级别时旧瓦片必须清掉 —— 缓存键只含 tx/ty，不含 z
      FINE_SRC.tiles.clear();
      FINE_SRC.pending.clear();
      FINE_SRC.missing.clear();
      FINE_SRC.evicted.clear();
      // 逐个探测点试，第一个成功就用这个级别
      function tryPoint(j) {
        if (j >= PROBE_POINTS.length) return Promise.resolve(false);
        var pt = PROBE_POINTS[j];
        var t = fineSrcTileXY(pt[0], pt[1]);
        var tx = Math.floor(t.x);
        var ty = Math.floor(t.y);
        return fetchFineTile(tx, ty).then(function (ok) {
          if (ok) return true;
          return tryPoint(j + 1);
        });
      }
      return tryPoint(0).then(function (ok) {
        if (ok) {
          FINE_SRC.ready = true;
          fineInitState = 'done';
          console.debug('[LEDemTiles] 细源就绪：' + L.name +
            '（≈' + Math.round(fineSrcResolutionDeg() * 111320) + ' m/px @' +
            PROBE_POINTS[0][1].toFixed(1) + 'N）');
          return true;
        }
        // 这个级别没有数据，试下一个
        return tryLevel(i + 1);
      });
    }
    return tryLevel(0).then(function (ok) {
      fineInitState = 'done';
      if (!ok) {
        console.debug('[LEDemTiles] 细源不可用（所有级别都没有瓦片）');
      }
      return ok;
    });
  }

  /* ------------------------------------------------------------------ *
   * 叠加金字塔（本地导入的高精度 DEM）
   * ------------------------------------------------------------------ */

  /**
   * 挂载一份本地 DEM 金字塔。
   *
   * 数据由「数据仓库」（js/vault.js）生成，结构与全国金字塔**完全一致**：
   *   <base>/index.json
   *   <base>/l{n}/{tx}/{ty}.bin   （256×256 int16-le，北→南）
   * 因此这里可以复用同一套「按层级选瓦片 → 双线性采样」的逻辑，
   * 只是索引与瓦片路径换成了自己的。
   *
   * 优先级：**overlay 高于全国金字塔**。导入的 DEM 通常是
   * 0.3~30 m 精度，而全国金字塔最细层是 ~76 m，所以导入数据应当覆盖它。
   *
   * @param {object} spec { id, name, index: '相对路径/index.json', base: '相对路径/' }
   */
  async function addOverlay(spec) {
    if (!spec || !spec.index) return null;
    const id = spec.id || ('ov' + state.overlays.length);
    // 已经在就更新索引即可
    let ov = state.overlays.find((o) => o.id === id);
    if (!ov) {
      ov = {
        id: id,
        name: spec.name || id,
        index: null,
        indexReady: false,
        base: spec.base || '',
        tiles: {},
        pending: {},
        level: 0,
        stats: { loaded: 0, requests: 0, bytes: 0 },
      };
      state.overlays.push(ov);
    }
    ov.base = spec.base || ov.base;
    try {
      const res = await fetch(spec.index, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json || !json.levels || !json.levels.length) throw new Error('索引格式不正确');
      ov.index = json;
      ov.indexReady = true;
      ov.level = 0;
      ov._order = null; // 层级顺序缓存作废（overlayOrder 会重建）
      console.debug('[LEDemTiles] 叠加 DEM 就绪：' + (ov.name || id));
      return ov;
    } catch (err) {
      console.warn('[LEDemTiles] 叠加 DEM 不可用：' + (ov.name || id), err);
      ov.indexReady = false;
      return null;
    }
  }

  /** 卸载一份叠加 DEM。 */
  function removeOverlay(id) {
    const i = state.overlays.findIndex((o) => o.id === id);
    if (i < 0) return false;
    state.overlays.splice(i, 1);
    return true;
  }

  function overlayLevelMeta(ov, level) {
    if (!ov.index || !ov.index.levels) return null;
    for (let i = 0; i < ov.index.levels.length; i++) {
      if (ov.index.levels[i].level === level) return ov.index.levels[i];
    }
    return null;
  }

  function overlayCache(ov, level) {
    if (!ov.tiles[level]) ov.tiles[level] = new Map();
    return ov.tiles[level];
  }

  function overlayPending(ov, level) {
    if (!ov.pending[level]) ov.pending[level] = new Map();
    return ov.pending[level];
  }

  /** 拉一份叠加 DEM 的瓦片。 */
  function fetchOverlayTile(ov, level, tx, ty) {
    const meta = overlayLevelMeta(ov, level);
    if (!meta) return Promise.resolve(false);
    const key = tileKey(tx, ty);
    const pend = overlayPending(ov, level);
    if (pend.has(key)) return pend.get(key);
    const url = ov.base + 'l' + level + '/' + tx + '/' + ty + '.bin';
    const result = fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        const expect = meta.tileSize * meta.tileSize * 2;
        if (buf.byteLength !== expect) throw new Error('瓦片大小不符');
        overlayCache(ov, level).set(key, { data: new Int16Array(buf), t: Date.now() });
        ov.stats.requests += 1;
        ov.stats.bytes += buf.byteLength;
        return true;
      })
      .catch(function (err) {
        console.debug('[LEDemTiles] 叠加瓦片不可用 ' + ov.id + ' l' + level + '/' + tx + '/' + ty + '：' + err.message);
        return false;
      })
      .finally(function () { pend.delete(key); });
    pend.set(key, result);
    return result;
  }

  /** 在一份 overlay 的缓存瓦片上采样；缺失返回 null。 */
  // Use a single cache lookup per mesh when the entire rectangle lies in one
  // resident tile of the highest-priority overlay. Crossing any seam or a
  // higher-priority coverage boundary falls back to the ordinary point sampler.
  function overlayGrid(w, s, e, n, size, exag, out) {
    if (!state.enabled || attribEnabled) return false;
    for (const ov of state.overlays) {
      const b = ov.indexReady && ov.index.bbox;
      if (!b || e < b[0] || s > b[3] || w > b[2] || n < b[1]) continue;
      if (w < b[0] || e > b[2] || s < b[1] || n > b[3]) return false;
      const meta = overlayLevelMeta(ov, overlayOrder(ov)[0]);
      if (!meta) return false;
      const a = locate(meta, w, n), z = locate(meta, e, s);
      if (!a || !z || a.tx !== z.tx || a.ty !== z.ty) return false;
      const hit = overlayCache(ov, meta.level).get(tileKey(a.tx, a.ty));
      if (!hit) return false;
      const t = meta.tileSize, res = (meta.east-meta.west)/(meta.width-1), d = hit.data;
      const xs = new Int32Array(size), fs = new Float64Array(size);
      for (let i=0; i<size; i++) {
        const ix = ((w+(e-w)*i/(size-1))-meta.west)/res-a.tx*t;
        xs[i]=Math.floor(ix); fs[i]=ix-xs[i];
      }
      for (let j=0; j<size; j++) {
        const iy=(meta.north-(n-(n-s)*j/(size-1)))/res-a.ty*t;
        const y=Math.floor(iy), fy=iy-y, r=y*t, rr=Math.min(t-1,y+1)*t;
        for (let i=0; i<size; i++) {
          const x=xs[i], xx=Math.min(t-1,x+1), fx=fs[i];
          out[j*size+i]=(d[r+x]*(1-fx)*(1-fy)+d[r+xx]*fx*(1-fy)+d[rr+x]*(1-fx)*fy+d[rr+xx]*fx*fy)*exag;
        }
      }
      return true;
    }
    return false;
  }

  // A resident z12 tile uses separable longitude/latitude coordinates. Resolve the
  // source once for the grid, but retain the scalar path for seams, overrides and NoData.
  function fineGrid(w,s,e,n,size,exag,out) {
    if (!batchFine || !streaming || !state.enabled || !state.indexReady || attribEnabled ||
        !FINE_SRC.ready || FINE_SRC.z !== 12 || w < FINE_SRC.west || e > FINE_SRC.east ||
        s < FINE_SRC.south || n > FINE_SRC.north) return false;
    if (state.finerSource && (!state.finerIntersects || state.finerIntersects(w,s,e,n))) return false;
    for (const ov of state.overlays) {
      const b=ov.indexReady && ov.index.bbox;
      if (b && !(e<b[0] || w>b[2] || n<b[1] || s>b[3])) return false;
    }
    const order=levelOrder();
    if (!order.length || fineSrcResolutionDeg()>=layerResolutionDeg(levelMetaFast(order[0]))) return false;
    const dim=1<<FINE_SRC.z, a=fineSrcTileXY(w,n), tx=Math.floor(a.x), ty=Math.floor(a.y);
    const tile=FINE_SRC.tiles.get(fineSrcKey(tx,ty));
    if (!tile) return false;
    const xp=lon=>(((lon+180)/360)*dim-tx)*256-.5;
    const yp=lat=>(tile.north-lat)/(tile.north-tile.south)*256-.5;
    if (xp(w)<0 || xp(e)>=255 || yp(n)<0 || yp(s)>=255) return false;
    const xi=new Uint8Array(size), fx=new Float64Array(size), d=tile.data;
    for(let i=0;i<size;i++){const x=xp(w+(e-w)*i/(size-1));xi[i]=Math.floor(x);fx[i]=x-xi[i];}
    for(let j=0;j<size;j++){
      const y=yp(n-(n-s)*j/(size-1)), row=Math.floor(y), fy=y-row;
      for(let i=0;i<size;i++){
        const k=row*256+xi[i], f=fx[i], a=d[k], b=d[k+1], c=d[k+256], v=d[k+257];
        if (!(a>-9000&&b>-9000&&c>-9000&&v>-9000)) return false;
        out[j*size+i]=(a*(1-f)*(1-fy)+b*f*(1-fy)+c*(1-f)*fy+v*f*fy)*exag;
      }
    }
    batchMeshes++;
    return true;
  }
  function sampleOverlayTile(ov, meta, tx, ty, ix, iy) {
    const hit = overlayCache(ov, meta.level).get(tileKey(tx, ty));
    if (!hit) return null;
    const t = meta.tileSize;
    const d = hit.data;
    const x0 = Math.floor(ix);
    const y0 = Math.floor(iy);
    const tx2 = ix - x0;
    const ty2 = iy - y0;
    const x1 = x0 + 1 < t ? x0 + 1 : x0;
    const y1 = y0 + 1 < t ? y0 + 1 : y0;
    const r0 = y0 * t;
    const r1 = y1 * t;
    return (
      d[r0 + x0] * (1 - tx2) * (1 - ty2) +
      d[r0 + x1] * tx2 * (1 - ty2) +
      d[r1 + x0] * (1 - tx2) * ty2 +
      d[r1 + x1] * tx2 * ty2
    );
  }

  /** 该经纬度是否落在 overlay 范围内。 */
  function overlayCovers(ov, lon, lat) {
    if (!ov.indexReady || !ov.index.bbox) return false;
    const b = ov.index.bbox;
    return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  }

  /**
   * overlay 的采样顺序（由细到粗）。
   *
   * 【为什么缓存】overlayHeightAt() 是逐顶点调用的（实测 385 万次），
   * 旧实现每次都 levels.map().sort() 分配两个新数组。
   * overlay 的层级集合只在索引加载时变化，缓存即可。
   */
  function overlayOrder(ov) {
    if (ov._order) return ov._order;
    const order = (ov.index && ov.index.levels
      ? ov.index.levels.map(function (l) { return l.level; }).sort(function (a, b) { return b - a; })
      : []);
    ov._order = order;
    return order;
  }

  /**
   * 从 overlay 取高程；未命中返回 null。
   * 从**最细层**开始，瓦片未缓存时向下回退到更粗的层。
   */
  function overlayHeightAt(ov, lon, lat) {
    if (!ov.indexReady) return null;
    if (!overlayCovers(ov, lon, lat)) return null;
    const levels = overlayOrder(ov);
    for (let i = 0; i < levels.length; i++) {
      const meta = overlayLevelMeta(ov, levels[i]);
      if (!meta) continue;
      const loc = scratchLocate(meta, lon, lat);
      if (!loc) continue;
      const v = sampleOverlayTile(ov, meta, loc.tx, loc.ty, loc.ix, loc.iy);
      if (v !== null) return v;
    }
    return null;
  }

  /**
   * 选一份 overlay 该用哪一层。
   *
   * 【为什么 overlay 也需要选层】
   *   overlay 是用户导入的 DEM，精度通常 ≤30 m（例：昆明 GLO-30 是 26.8 m/px）。
   *   旧实现**永远取最细那一层**（levels[0]）。多层 overlay 下这是纯浪费：
   *   高空时粗层就够显示，却仍去下最细层。
   *
   * 【怎么选】
   *   天花板 = 屏幕 1 px 能分辨的最细地面特征 = groundPerPixel / 2。
   *   在 overlay 的层里找**最粗但仍不低于天花板**的那一层；
   *   若所有层都细于天花板，保持最细层（见下面的说明）。
   *
   * 【效果】
   *   20 000 km：overlay 26.8 m 远细于天花板 → 仍是最细层。
   *   近景 9 km：屏幕 1 px ≈ 13 m → 天花板 6.5 m → 26.8 m 合格 → 最细层。
   *   多层 overlay（有粗层时）：高空自动退到粗层，少下很多瓦片。
   *
   * 【注意】这个天花板只影响**预取**（ensureOverlayRect）；
   *   采样端 overlayHeightAt() 本来就是「从最细层开始、没命中再退粗层」，
   *   不受影响 —— 加载了哪层就采样哪层，没加载的层自然被跳过。
   */
  function overlayPickLevel(ov, groundPerPixel) {
    const levels = overlayOrder(ov);
    if (!levels.length) return null;
    const finest = levels[0];
    const finestMeta = overlayLevelMeta(ov, finest);
    if (!finestMeta) return null;
    if (!(groundPerPixel > 0)) return finest;

    const capMeters = groundPerPixel / 2;
    // Ordered fine to coarse: choose the finest level that does not oversample.
    for (let i = 0; i < levels.length; i++) {
      const meta = overlayLevelMeta(ov, levels[i]);
      if (!meta) continue;
      const meters = overlayMeters(meta);
      if (meters >= capMeters) return levels[i];
    }
    return levels[levels.length-1];
  }

  /** 某一层 overlay 的像元尺寸（米，北纬 30 度口径）。 */
  function overlayMeters(meta) {
    if (!meta) return 0;
    const resDeg = meta.resDeg || ((meta.east - meta.west) / Math.max(1, meta.width - 1));
    return resDeg * 111320 * Math.cos(Math.PI / 6);
  }

  /**
   * 这份 overlay 在当前屏幕分辨率下**还有没有必要预取**。
   *
   * 【判据】overlay 的价值 = 「它比当前金字塔层细，且这个差距是屏幕看得出来的」。
   *   金字塔当前层像元 = pyMeters；overlay 最细层像元 = ovMeters。
   *   - ovMeters >= pyMeters → overlay 不比金字塔细，**白下**。
   *   - 屏幕 1 px 已比 overlay 还粗（groundPerPixel >= ovMeters*2）→
   *     overlay 的细节在屏幕上分不出来，**白下**。
   *
   * 【为什么不能简单地「不加载」】
   *   金字塔最细层 L4 是 602 m/px，overlay 是 26.8 m/px —— 差 22 倍。
   *   一旦不加载，近景的沟谷、凹地就全被 602 m 的栅格抹平，
   *   这正是用户最早报的「有些地方还是没有精度改善」。
   *   所以判据必须严格：只有「overlay 细不过屏幕」或「不比金字塔细」才跳过。
   *
   * 【实测】默认视图 20 000 km → 屏幕 1 px ≈ 29 416 m，
   *   overlay 26.8 m ≪ 29 416/2 → 跳过 66 张瓦片 / 8 MB；
   *   近景 9 km → 屏幕 1 px ≈ 13 m → 26.8 m > 13/2 → 照常加载。
   */
  function overlayPrefetchUseful(ov, groundPerPixel) {
    if (!ov || !ov.indexReady) return false;
    const levels = overlayOrder(ov);
    if (!levels.length) return false;
    const finestMeta = overlayLevelMeta(ov, levels[0]);
    if (!finestMeta) return false;
    const ovMeters = overlayMeters(finestMeta);

    // 屏幕比 overlay 还粗 → 画面上分辨不出来
    if (groundPerPixel > 0 && groundPerPixel >= ovMeters * 2) return false;

    // overlay 不比当前金字塔层细 → 没有增量信息
    const pyMeta = levelMetaFast(state.level);
    if (pyMeta) {
      const pyMeters = overlayMeters({
        resDeg: pyMeta.resDeg,
        east: pyMeta.east, west: pyMeta.west, width: pyMeta.width,
      });
      if (pyMeters && ovMeters >= pyMeters) return false;
    }
    return true;
  }

  /**
   * 确保某矩形内的 overlay 瓦片都已加载（供地形 Provider 预取）。
   */
  function ensureOverlayRect(ov, west, south, east, north, explicit) {
    if (!ov.indexReady) return Promise.resolve(false);
    // 【屏幕分辨率闸】这份 overlay 在当前高度画不出差别 → 不下。
    // 判据见 overlayPrefetchUseful：只有「比屏幕粗」或「不比金字塔细」才跳。
    // Explicit small targets need their own DEM regardless of camera distance.
    const target = explicit && east>=west && north>=south && east-west<=0.25 && north-south<=0.25;
    if (!target && !overlayPrefetchUseful(ov, state.stats.groundPerPixel)) {
      noteOverlaySkipped(ov);
      return Promise.resolve(false);
    }
    // 按屏幕分辨率选层：粗于天花板但仍能显示的层优先（少下瓦片）。
    let level = overlayPickLevel(ov, state.stats.groundPerPixel);
    if (target) {
      for (const lv of overlayOrder(ov)) {
        const candidate=overlayLevelMeta(ov,lv);
        if (candidate && tilesInView(candidate,{west,south,east,north})<=16) { level=lv; break; }
      }
    }
    if (level === null) return Promise.resolve(false);
    const meta = overlayLevelMeta(ov, level);
    if (!meta) return Promise.resolve(false);
    const res = (meta.east - meta.west) / (meta.width - 1);
    const t = meta.tileSize;
    const x0 = Math.max(0, Math.floor((west - meta.west) / res / t));
    const x1 = Math.min(meta.cols - 1, Math.floor((east - meta.west) / res / t));
    const y0 = Math.max(0, Math.floor((meta.north - north) / res / t));
    const y1 = Math.min(meta.rows - 1, Math.floor((meta.north - south) / res / t));
    const promises = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = tileKey(tx, ty);
        if (overlayCache(ov, meta.level).has(key)) continue;
        promises.push(fetchOverlayTile(ov, meta.level, tx, ty));
      }
    }
    if (!promises.length) return Promise.resolve(true);
    return Promise.all(promises).then(function () { return true; });
  }

  /**
   * overlay 预取被屏幕分辨率挡掉时，记一笔（诊断用）。
   * 与 fineSkippedByResolution 同一口径。
   */
  function noteOverlaySkipped(ov) {
    state.stats.overlaySkippedByResolution = (state.stats.overlaySkippedByResolution || 0) + 1;
    void ov;
  }

  /* ------------------------------------------------------------------ *
   * 采样（全国金字塔）
   * ------------------------------------------------------------------ */

  /**
   * 取高程（米）。从当前层开始，若瓦片未缓存则向下回退到更粗的层，
   * 再粗就没有了（返回 null，由 terrain.js 用其它源补齐）。
   *
   * 【精度优先级】全国金字塔最细一层是 0.0125°（≈1261 m/px），
   * 而本机还带着 1″（≈28 m/px）的示例区高程源和用户导入的精细 DEM。
   * 旧实现只要「落在全国 bbox 内」就无条件返回金字塔值，
   * 于是在昆明这类地区 **1″ 源永远轮不到**，细小的沟谷、凹地全被 1261 m
   * 的栅格抹平 —— 这是 3D 地形看起来「没有细节」的主因。
   *
   * 现在改为按**实际像元尺度**决定谁优先：
   *   1) 叠加金字塔（用户导入，通常最细）→ 永远优先；
   *   2) 全国金字塔当前层 → 只有当它比「同位置的更细源」还粗时才用；
   *   3) 更细源（N25 1″ 等）→ 优先于比它粗的金字塔层。
   * 粗源只作为**兜底**（精细源没覆盖到的地方）。
   */
  /**
   * 来源归因计数器（诊断用）。
   *
   * 【为什么需要】
   * 用户报「有些地方还是没有精度改善」——光看 stats() 的分辨率数字
   * 看不出来，因为 heightAt 每次都在四个来源之间仲裁：
   *   overlay（用户导入）> external（terrain.js 注册的 1″ 源）
   *   > fine（z12 细源）> pyramid（金字塔当前层）
   * 只有知道**实际是哪个来源出的值**，才能判断「没改善」是因为
   * 细源没就绪、没覆盖到，还是被别的源抢先了。
   *
   * 开销：一个对象自增，heightAt 是热点函数（约 385 万次/启动），
   * 所以默认关闭，用 ?attrib=1 打开。
   */
  let attribEnabled = false;
  const attrib = { overlay: 0, external: 0, fine: 0, pyramid: 0, none: 0 };
  function attribCount(k) {
    if (attribEnabled) attrib[k] += 1;
  }

  function heightAt(lon, lat) {
    if (!state.enabled) return null;
    if (!isFinite(lon) || !isFinite(lat)) return null;

    // 0) 叠加金字塔优先（本地导入的高精度 DEM 覆盖全国金字塔）
    for (let i = 0; i < state.overlays.length; i++) {
      const ov = state.overlays[i];
      const v = overlayHeightAt(ov, lon, lat);
      if (v !== null && v !== undefined && isFinite(v)) {
        state.hits += 1;
        attribCount('overlay');
        return v;
      }
    }

    if (!state.indexReady) return null;
    const order = levelOrder();
    if (!order.length) return null;
    if (streaming) {
      // A verified finer source does not need a resident coarse tile below it.
      const res=layerResolutionDeg(levelMetaFast(order[0]));
      const external=finerSourceAt(lon,lat,res);
      if(Number.isFinite(external)){state.hits++;attribCount('external');return external;}
      if(fineSrcResolutionDeg()<res){
        const fine=fineSrcHeightAt(lon,lat);
        if(Number.isFinite(fine)){state.hits++;attribCount('fine');return fine;}
      }
    }

    // 逐层采样：一旦某层比当前已知的更细源还粗，就先让更细源出场。
    for (let i = 0; i < order.length; i++) {
      const m = levelMetaFast(order[i]);
      if (!m) continue;
      const loc = scratchLocate(m, lon, lat);
      if (!loc) continue;
      const v = sampleTile(m, loc.tx, loc.ty, loc.ix, loc.iy);
      if (v === null) continue;
      if(streaming){state.hits++;attribCount('pyramid');return v;}

      // 这层比外部更细源粗吗？粗的话先问外部源（terrain.js 注册的高精度源）。
      const layerRes = layerResolutionDeg(m);

      // 【细源】同样参与精度仲裁 —— 只有当它比当前层更细时才顶上来。
      // 顺序：terrain.js 的 1″ 源（≈28 m）> 细源（z12 ≈31 m / z11 ≈76 m）> 本层。
      const external = finerSourceAt(lon, lat, layerRes);
      if (external !== null && external !== undefined && isFinite(external)) {
        state.hits += 1;
        attribCount('external');
        return external;
      }
      const fineRes = fineSrcResolutionDeg();
      if (fineRes < layerRes) {
        const fine = fineSrcHeightAt(lon, lat);
        if (fine !== null && isFinite(fine)) {
          state.hits += 1;
          attribCount('fine');
          return fine;
        }
      }
      state.hits += 1;
      attribCount('pyramid');
      return v;
    }
    state.misses += 1;
    attribCount('none');
    return null;
  }

  /** 某层的像元尺度（度）。 */
  function layerResolutionDeg(meta) {
    if (!meta) return Infinity;
    if (meta.resDeg) return meta.resDeg;
    const w = meta.width || 1;
    return (meta.east - meta.west) / Math.max(1, w - 1);
  }

  /**
   * 询问 terrain.js 那边登记的「更细高程源」（例如 1″ 示例区）。
   * terrain.js 通过 registerFinerSource() 注册，函数签名：
   *   (lon, lat, maxResolutionDeg) => 高程(米) 或 null（表示此处不覆盖/不够细）
   * 这样 dem-tiles 不需要知道别的源是什么样子，只比分辨率。
   */
  function finerSourceAt(lon, lat, maxResolutionDeg) {
    if (!state.finerSource) return null;
    try {
      return state.finerSource(lon, lat, maxResolutionDeg);
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ 视口预取 */

  function pickLevel(cameraHeight) {
    const forced = forcedLevel();
    if (forced !== null && levelMetaFast(forced)) return forced;
    const h = isFinite(cameraHeight) ? cameraHeight : 2000000;
    for (let i = 0; i < LEVEL_BY_HEIGHT.length; i++) {
      if (h < LEVEL_BY_HEIGHT[i].maxHeight) return LEVEL_BY_HEIGHT[i].level;
    }
    return LEVEL_BY_HEIGHT[LEVEL_BY_HEIGHT.length - 1].level;
  }

  /**
   * 视野内允许加载的 DEM 瓦片数上限。
   *
   * 【为什么要护栏】DEM 层的选择现在由「屏幕分辨率」驱动，低空会选到
   * 最细的 L4。但 L4 的瓦片跨度只有 L3 的一半 —— 同一视野的瓦片数 x4，
   * 字节数也 x4（L4 整幅 119 MB vs L3 31 MB）。拖动时这会直接打满网络，
   * 让「地形就绪」变慢，反而拖累交互。
   *
   * 【预算怎么定】按相机高度分档。低空视野小，可以少取；
   * 高空视野大，多取一些也无所谓（但那时本来也该用粗层）。
   */
  function viewTileBudget(cameraHeight) {
    const h = isFinite(cameraHeight) ? cameraHeight : 2000000;
    if (h < 20000) return 96;    // < 20 km：近景，视野小
    if (h < 100000) return 160;  // < 100 km
    if (h < 400000) return 220;
    return 260;
  }

  /**
   * 某个 DEM 层在给定视野矩形内需要多少张瓦片。
   * 与 updateForCamera() 里的取瓦片逻辑同口径。
   */
  function tilesInView(meta, rect) {
    if (!meta || !rect) return 0;
    const res = (meta.east - meta.west) / (meta.width - 1);
    const t = meta.tileSize;
    let west = rect.west, east = rect.east, south = rect.south, north = rect.north;
    if (east < west) { east = 180; west = -180; }
    const m = state.margin;
    west -= (east - west) * m;
    east += (east - west) * m;
    south -= (north - south) * m;
    north += (north - south) * m;
    const x0 = Math.max(0, Math.floor((west - meta.west) / res / t));
    const x1 = Math.min(meta.cols - 1, Math.floor((east - meta.west) / res / t));
    const y0 = Math.max(0, Math.floor((meta.north - north) / res / t));
    const y1 = Math.min(meta.rows - 1, Math.floor((meta.north - south) / res / t));
    if (x1 < x0 || y1 < y0) return 0;
    return (x1 - x0 + 1) * (y1 - y0 + 1);
  }

  /**
   * 【屏幕分辨率驱动】算出当前视野需要的 DEM 层。
   *
   * 返回 level 数字，或 null（表示算不出来，调用方回退到 pickLevel）。
   *
   * 【推导】
   *   地形网格是 grid×grid 个顶点覆盖一整块 Cesium 地形瓦片。
   *   Cesium 地形瓦片的地面跨度随 LOD 变化，但**近景**那一块（用户真正在看的）
   *   的跨度可以从「相机高度 + 屏幕高度 + 垂直视场角」算出来：
   *       近景瓦片跨度 ≈ 相机高度 × (屏幕高 / 视场角对应的高覆盖比)
   *   实践中更稳的做法是直接用 Cesium 的**几何误差**：
   *       terrainProvider.getLevelMaximumGeometricError(level)
   *   加上当前 LOD 层，就能反推出近景瓦片的地面跨度。
   *
   * 但本模块不依赖 Cesium（它可以单独用），所以这里用一个**更直接**的量：
   *   屏幕 1 像素对应多少地面米 = (近景地面跨度) / (屏幕高度像素)
   * 再和地形网格的顶点间距比较：
   *   顶点间距 = 近景瓦片跨度 / (grid - 1)
   *
   * 若「DEM 像元尺寸」显著大于「顶点间距」，说明网格有能力承载更细的
   * DEM，而当前层不够细 → 升级到更细的层。
   */
  /**
   * 屏幕每像素对应的地面距离（米）。
   *
   *   groundPerPixel = cameraHeight × tan(fov / screenHeight)
   *
   * 屏幕高 800 px、fov 60° 时约为 cameraHeight × 0.00147：
   *   6 km → 9.7 m/px；20 km → 31 m/px；200 km → 324 m/px；
   *   20 000 km → 29 416 m/px。
   *
   * 这是「数据有没有用」的判据：细源是 31 m/px，
   * 屏幕每像素的地面距离一旦远大于它，数据在屏幕上就分辨不出来。
   */
  function groundMetersPerPixel(viewer, cameraHeight) {
    if (!viewer || !isFinite(cameraHeight) || cameraHeight <= 0) return 0;
    let screenH = 0;
    try {
      screenH = viewer.scene.canvas.clientHeight;
    } catch (err) {
      screenH = 0;
    }
    if (!screenH) return 0;
    let fov = 60 * Math.PI / 180;
    try {
      const cam = viewer.camera;
      if (cam && typeof cam.frustum === 'object' && cam.frustum.fov) fov = cam.frustum.fov;
    } catch (err) {
      /* ignore */
    }
    const perPixelRad = fov / screenH;
    const g = cameraHeight * Math.tan(perPixelRad);
    return isFinite(g) && g > 0 ? g : 0;
  }

  function pickLevelByScreenResolution(viewer, cameraHeight) {
    const forced = forcedLevel();
    if (forced !== null && levelMetaFast(forced)) return forced;

    // 索引里最细的层（有了 L4 就是 4）
    let finest = 0;
    if (state.index && state.index.levels) {
      for (const l of state.index.levels) {
        if (l.level > finest) finest = l.level;
      }
    }
    if (finest <= 3) return null; // 索引里没有比 L3 更细的层

    // 地形网格密度：地形 provider 的网格宽（= grid）。
    // 【注意】Cesium 的 CustomHeightmapTerrainProvider 把这个存在**私有**
    // 字段 _width 上（实测 vendor 里没有公开的 width getter），
    // 我们的 NormalHeightmapTerrainProvider 另存了一份 _leWidth。
    // 两个都要试，否则拿到 undefined 就一路退化成 L0。
    let grid = 0;
    try {
      const tp = viewer.terrainProvider;
      if (tp) {
        const cand = [tp._leWidth, tp._width, tp.width];
        for (const c of cand) {
          if (typeof c === 'number' && c > 1) { grid = c; break; }
        }
      }
    } catch (err) {
      /* ignore */
    }
    if (!grid) return null;

    // 屏幕高度（像素）
    let screenH = 0;
    try {
      screenH = viewer.scene.canvas.clientHeight;
    } catch (err) {
      /* ignore */
    }
    if (!screenH) return null;

    // 近景地面跨度：相机高度与「屏幕能看到的地平距离」的比值。
    // 用相机的视场角算：垂直视场角 fov，屏幕上 1 像素张角 = fov/screenH，
    // 该角度对应的地面距离（正切关系）≈ height * tan(fov/screenH)。
    // 这是**贴地斜视**时近景的地面采样距离，与「屏幕分辨率」的物理意义一致。
    let fov = 60 * Math.PI / 180;
    try {
      const cam = viewer.camera;
      if (cam && typeof cam.frustum === 'object' && cam.frustum.fov) fov = cam.frustum.fov;
    } catch (err) {
      /* ignore */
    }
    const perPixelRad = fov / screenH;
    const groundPerPixel = isFinite(cameraHeight) && cameraHeight > 0
      ? cameraHeight * Math.tan(perPixelRad)
      : 0;
    if (!(groundPerPixel > 0)) return null;

    // 顶点间距：近景瓦片跨度 / (grid-1)。近景瓦片跨度由「地面每像素 × 屏幕
    // 高度 × 放大系数」估：一个近景瓦片大致铺满屏幕高度的一部分。
    // 取屏幕高度的 1/4 作为近景瓦片覆盖的像素数（保守）。
    const nearTileSpan = groundPerPixel * screenH * 0.25;
    const vertexSpacing = nearTileSpan / (grid - 1);
    if (!(vertexSpacing > 0)) return null;

    // 从**最细**的层往下找，选第一个「DEM 像元 <= 顶点间距 * 2」的层。
    // （Nyquist：DEM 比网格还细表达不出来；比网格粗很多则细节在数据里就没了。）
    //
    // 【为什么是"最细优先"而不是"够用即可"】
    //   顶点间距在近景只有几米，而 DEM 像元是几百米 —— 任何一层的 DEM
    //   都比顶点间距粗，所以"够用即可"会永远选最粗的 L0。
    //   真正要表达的是"哪一层最细且还负担得起"：细层的代价是瓦片数与
    //   字节数，所以要同时看**视野内需要多少张瓦片**。
    let chosen = null;
    let chosenMeters = Infinity;
    for (let lv = finest; lv >= 0; lv--) {
      const m = levelMetaFast(lv);
      if (!m) continue;
      const resDeg = m.resDeg || ((m.east - m.west) / Math.max(1, m.width - 1));
      const meters = resDeg * 111320 * Math.cos(Math.PI / 6);
      if (meters > chosenMeters) continue;
      chosen = lv;
      chosenMeters = meters;
      // 已经细到「像元 < 顶点间距 * 2」就不能再细了（再细也表达不出来）
      if (meters <= vertexSpacing * 2) break;
    }
    if (chosen === null) return null;

    // 【天花板：粗于屏幕分辨率的层是纯浪费】
    //   上面这圈只管"别太粗"，没管"别太细"。高空时两者差得很远：
    //     20 000 km 高度 → 屏幕 1 px ≈ 29 416 m
    //     L3 像元 = 1140 m  ← 比屏幕分辨率细 26 倍，屏幕上根本分辨不出
    //   于是高空反而去拉 L3 的 209 张瓦片（26 MB），
    //   而每张像元比一个像素还细 —— 纯属白下。
    //
    //   天花板 = 「屏幕 1 px 能分辨的最细地面特征」。
    //   DEM 像元细到这个尺度以下就再也画不出新东西了，
    //   所以选**不比屏幕分辨率细 2 倍以上**的那一层（即像元 >= 屏幕px/2）。
    //   20 000 km 时：像元 >= 14 708 m → L0（9120 m）不合格、
    //   L1（4560 m）合格 → 选 L1，比原来的 L3 少 200 张瓦片。
    //   近景 9 km 时：屏幕 1 px ≈ 13 m → 像元 >= 6.5 m → L4（570 m）
    //   仍然合格，不受影响。
    //
    //   注意这是**降级**（变粗），只会减少下载量，不会引入新数据。
    const screenCapMeters = groundPerPixel / 2;
    if (chosenMeters < screenCapMeters) {
      for (let lv = chosen - 1; lv >= 0; lv--) {
        const m = levelMetaFast(lv);
        if (!m) continue;
        const resDeg = m.resDeg || ((m.east - m.west) / Math.max(1, m.width - 1));
        const meters = resDeg * 111320 * Math.cos(Math.PI / 6);
        if (meters >= screenCapMeters) { chosen = lv; chosenMeters = meters; break; }
        if (lv === 0) { chosen = 0; chosenMeters = meters; }
      }
    }
    state.stats.screenCapMeters = Math.round(screenCapMeters);
    state.stats.screenChosenMeters = Math.round(chosenMeters);

    // 【预算护栏】选最细的层会让"视野内瓦片数"暴涨：
    //   L3 的瓦片跨度 1108 m，L4 只有 554 m —— 同一视野的瓦片数 x4，
    //   字节数也 x4（L4 整幅 119 MB）。拖动时会直接把网络打满。
    // 这里按"视野内瓦片数不超过预算"来降级，
    // 预算随相机高度放宽（高空视野大，理应多取）。
    const budget = viewTileBudget(cameraHeight);
    const rect = viewRectFromScreen(viewer, cameraHeight);
    const cnt = tilesInView(levelMetaFast(chosen), rect);
    state.stats.demTilesInView = cnt;
    state.stats.demBudgetTiles = budget;
    if (cnt > budget) {
      for (let lv = chosen - 1; lv >= 0; lv--) {
        const m = levelMetaFast(lv);
        if (!m) continue;
        if (tilesInView(m, rect) <= budget) { chosen = lv; break; }
        if (lv === 0) chosen = 0;
      }
    }
    state.stats.screenVertexSpacing = vertexSpacing;
    state.stats.groundPerPixel = groundPerPixel;
    return chosen;
  }

  /**
   * 按当前相机位置选择层级，并预取视野内瓦片。
   * 返回本轮发起的请求数。
   */
  function updateForCamera(le) {
    if (!state.enabled || !state.indexReady) return 0;
    const viewer = le && le.viewer;
    if (!viewer || !viewer.camera) return 0;
    // 记下 viewer，细源探测要用相机位置（见 cameraProbePoint）
    state.viewer = viewer;

    // 【保护区】把相机脚下的细源瓦片标记为不可淘汰。
    // 不设的话，纯 LRU 在高空（视野几千张瓦片）会把脚下那张冲掉，
    // 脚下区域的高程立刻回落到粗 30 倍的金字塔 —— 实测相机 40000 m 时
    // 细源占比只剩 13%，降到 9000 m 又是 98.8%。见 evictFine 的注释。
    let camLon = null;
    let camLat = null;
    try {
      const camC = viewer.camera.positionCartographic;
      if (camC && isFinite(camC.longitude) && isFinite(camC.latitude)) {
        camLon = camC.longitude * (180 / Math.PI);
        camLat = camC.latitude * (180 / Math.PI);
        setFineProtect(camLon, camLat);
      }
    } catch (err) {
      /* ignore */
    }

    // 【全局预算重置】相机大幅移动后，新视野需要它自己的那批细源瓦片。
    //
    // 【为什么需要重置】细源预取现在是**全局预算**（见 fineBudget）：
    //   整个会话最多拉 N 张。冷启动那一波用完之后，如果用户拖动地图
    //   到另一个城市，预算已经耗尽 → 新区域永远拿不到细源。
    //
    // 【重置条件】相机中心移动超过细源瓦片的一半（z12 约 0.146°，
    //   取 0.1°）。太小的抖动不重置，避免反复重置把预算变成无界。
    if (camLon !== null) {
      const last = FINE_SRC.lastBudgetPos;
      if (!last) {
        FINE_SRC.lastBudgetPos = { lon: camLon, lat: camLat };
      } else {
        const dx = camLon - last.lon;
        const dy = camLat - last.lat;
        // 经度要按 cos(lat) 折算，否则高纬地区横向移动会被严重低估
        const mx = dx * Math.cos((camLat * Math.PI) / 180);
        const my = dy;
        if (Math.sqrt(mx * mx + my * my) > 0.1) {
          resetFineBudget();
          FINE_SRC.lastBudgetPos = { lon: camLon, lat: camLat };
        }
      }
    }

    // 【为什么在这里补一次探测】
    // initFineSource() 是在 DEM 索引就绪时跑的，那时还没有 viewer，
    // 拿不到相机位置 —— 只能用硬编码城市点探测。如果那些点恰好
    // 落在还没建好的区域（比如分批建库），整层细源会被判为不可用。
    // 相机位置此刻已经确定，而且正是用户在看的地方，用它再探一次
    // 的成功率最高。只重探一次（fineRetryWithCamera 置位）。
    if (!FINE_SRC.ready && fineInitState === 'done' && !fineRetryWithCamera) {
      initFineSource();
    }

    let height = 2000000;
    try {
      height = viewer.camera.positionCartographic.height;
    } catch (err) {
      /* ignore */
    }
    // 屏幕每像素的地面距离（米）。自己算一遍，不依赖选层逻辑 ——
    // 选层在某些情况下会提前 return null（拿不到 grid / screenH），
    // 但细源预取的门限必须始终有值。
    const groundPerPixel = groundMetersPerPixel(viewer, height);
    if (groundPerPixel > 0) state.stats.groundPerPixel = groundPerPixel;
    // 渲染网格的顶点间距（米）。细源能不能进几何，取决于它。
    const vertexSpacing = renderedVertexSpacing(viewer);
    if (vertexSpacing > 0) state.stats.renderedVertexSpacing = vertexSpacing;
    const want = pickLevelByScreenResolution(viewer, height);
    const level = want === null ? pickLevel(height) : want;
    const changed = level !== state.level;
    state.level = level;
    state.stats.level = level;

    const meta = levelMeta(level);
    if (!meta) return 0;

    // 视野矩形：Cesium 1.146 在 3D 模式下 camera.computeViewRectangle 永远返回
    // 整个球面（-180..180），不能直接用。改成从屏幕四角射线打到地表取极值，
    // 与 js/analysis.js 的 currentViewRect 同源思路。
    const rect = viewRectFromScreen(viewer, height);
    let west = rect.west;
    let east = rect.east;
    let south = rect.south;
    let north = rect.north;
    // 处理跨 180° 经线
    if (east < west) {
      const tmp = east;
      east = 180;
      west = -180;
      void tmp;
    }
    const m = state.margin;
    west -= (east - west) * m;
    east += (east - west) * m;
    south -= (north - south) * m;
    north += (north - south) * m;

    const res = (meta.east - meta.west) / (meta.width - 1);
    const t = meta.tileSize;
    const x0 = Math.max(0, Math.floor((west - meta.west) / res / t));
    const x1 = Math.min(meta.cols - 1, Math.floor((east - meta.west) / res / t));
    const y0 = Math.max(0, Math.floor((meta.north - north) / res / t));
    const y1 = Math.min(meta.rows - 1, Math.floor((meta.north - south) / res / t));

    const cache = cacheOf(level);
    const pend = pendingOf(level);
    let started = 0;
    const promises = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = tileKey(tx, ty);
        if (cache.has(key) || pend.has(key)) continue;
        started += 1;
        promises.push(fetchTile(level, tx, ty));
      }
    }
    // 叠加 DEM：只预取**落在其范围内**的瓦片（范围外的瓦片本来就不存在）
    for (let i = 0; i < state.overlays.length; i++) {
      const ov = state.overlays[i];
      if (!ov.indexReady) continue;
      const b = ov.index.bbox;
      if (!b) continue;
      if (east < b[0] || west > b[2] || north < b[1] || south > b[3]) continue;
      promises.push(ensureOverlayRect(ov, west, south, east, north));
    }
    // z11 细源（≈76 m/px）：与金字塔并行预取。
    // 带上 groundPerPixel —— 屏幕分辨率粗于细源时不拉（见 finePrefetchUseful）。
    promises.push(ensureFineRect(west, south, east, north,
      state.stats.groundPerPixel));
    if (changed && typeof state.onChange === 'function') {
      try {
        state.onChange('level', level);
      } catch (err) {
        /* ignore */
      }
    }
    if (promises.length) {
      Promise.all(promises).then(function () {
        if (typeof state.onChange === 'function') {
          try {
            state.onChange('tiles', level);
          } catch (err) {
            /* ignore */
          }
        }
      });
    }
    return started;
  }

  function C2deg(rad) {
    return (rad * 180.0) / Math.PI;
  }

  /**
   * 由屏幕四角射线反算可视地表范围（度）。
   *
   * 首选 Cesium 内置的 `camera.computeViewRectangle(globe.ellipsoid)`：3D 模式下
   * 它是能用的，能给出真正的可视矩形。只有当它返回整个球面（跨度 360°/180°）
   * 或抛错时，才改用「屏幕四角射线打地表」自己算。
   */
  function viewRectFromScreen(viewer, cameraHeight) {
    const C = window.Cesium;
    const scene = viewer.scene;
    const camera = viewer.camera;

    // --- 首选：Cesium 内置 ---
    let rect = null;
    try {
      rect = camera.computeViewRectangle(scene.globe.ellipsoid);
    } catch (err) {
      rect = null;
    }
    if (rect && isFinite(rect.west) && isFinite(rect.south) && isFinite(rect.east) && isFinite(rect.north)) {
      const west = C2deg(rect.west);
      const east = C2deg(rect.east);
      const south = C2deg(rect.south);
      const north = C2deg(rect.north);
      if (east - west < 359 && north - south < 179 && east > west && north > south) {
        return {
          west: Math.max(-180, west),
          east: Math.min(180, east),
          south: Math.max(-90, south),
          north: Math.min(90, north),
        };
      }
    }

    // --- 备选：屏幕四角射线打地表 ---
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    let hits = 0;

    try {
      const canvas = viewer.canvas;
      const w = canvas.clientWidth || canvas.width;
      const h = canvas.clientHeight || canvas.height;
      if (w > 0 && h > 0) {
        const pts = [
          [0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2],
          [w / 2, 0], [w / 2, h], [0, h / 2], [w, h / 2],
        ];
        for (let i = 0; i < pts.length; i++) {
          let ray = null;
          try {
            ray = camera.getPickRay(new C.Cartesian2(pts[i][0], pts[i][1]));
          } catch (err) {
            ray = null;
          }
          if (!ray) continue;
          let hit = null;
          try { hit = scene.globe.pick(ray, scene); } catch (err) { hit = null; }
          if (!hit) {
            try { hit = scene.globe.pick(ray, scene, scene.globe.ellipsoid); } catch (err) { hit = null; }
          }
          if (!hit) continue;
          const cc = scene.globe.ellipsoid.cartesianToCartographic(hit);
          if (!cc) continue;
          const lon = C2deg(cc.longitude);
          const lat = C2deg(cc.latitude);
          if (!isFinite(lon) || !isFinite(lat)) continue;
          hits += 1;
          if (lon < west) west = lon;
          if (lon > east) east = lon;
          if (lat < south) south = lat;
          if (lat > north) north = lat;
        }
      }
    } catch (err) {
      hits = 0;
    }

    if (hits < 2 || east - west > 180) {
      // 射线取不到：按相机高度估一个范围
      const c = camera.positionCartographic;
      const lon = C2deg(c.longitude);
      const lat = C2deg(c.latitude);
      const span = Math.max(0.5, Math.min(20, (cameraHeight || 200000) / 900000));
      west = lon - span;
      east = lon + span;
      south = lat - span * 0.6;
      north = lat + span * 0.6;
    }
    return {
      west: Math.max(-180, west),
      east: Math.min(180, east),
      south: Math.max(-90, south),
      north: Math.min(90, north),
    };
  }

  /**
   * 确保某个地理矩形内的所有瓦片都已加载（或已确认缺失）。
   * 返回 Promise：地形 Provider 在采样前 await 它，
   * 避免「瓦片还没到就采样」导致地形空洞，也避免反复重建 Provider。
   */
  // Explicit region consumers (e.g. import-and-fly) may warm the center.
  // Do not allocate a list for an unbounded extent or compete with visible children.
  async function warmExplicitDetail(w,s,e,n) {
    if (!FINE_SRC.ready || !(e>=w && n>=s) || e-w>2 || n-s>2) return;
    const x=(w+e)/2, y=(n+s)/2;
    if (x<FINE_SRC.west || x>FINE_SRC.east || y<FINE_SRC.south || y>FINE_SRC.north) return;
    if (finerSourceAt(x,y,fineSrcResolutionDeg()) != null) return;
    const t=fineSrcTileXY(x,y), tx=Math.floor(t.x), ty=Math.floor(t.y), key=fineSrcKey(tx,ty);
    if (FINE_SRC.tiles.has(key) || FINE_SRC.missing.has(key) || detailJobs.size>=DETAIL_SLOTS) return;
    const retry=retryAfter.get(key);
    if (!retry || retry.until<=performance.now()) await fetchFineTile(tx,ty);
  }
  function ensureRect(west, south, east, north, meshRequest) {
    if (!state.enabled) return Promise.resolve(false);
    const promises = [];
    // 叠加 DEM 优先：它更精细，先确保它到位
    for (let i = 0; i < state.overlays.length; i++) {
      const ov = state.overlays[i];
      if (!ov.indexReady) continue;
      const b = ov.index.bbox;
      if (b && !(east < b[0] || west > b[2] || north < b[1] || south > b[3])) {
        promises.push(ensureOverlayRect(ov, west, south, east, north, !meshRequest));
      }
    }
    if (!state.indexReady) return Promise.resolve(false);
    const meta = levelMeta(state.level);
    if (!meta) return Promise.resolve(false);
    const res = (meta.east - meta.west) / (meta.width - 1);
    const t = meta.tileSize;
    const x0 = Math.max(0, Math.floor((west - meta.west) / res / t));
    const x1 = Math.min(meta.cols - 1, Math.floor((east - meta.west) / res / t));
    const y0 = Math.max(0, Math.floor((meta.north - north) / res / t));
    const y1 = Math.min(meta.rows - 1, Math.floor((meta.north - south) / res / t));
    const cache = cacheOf(state.level);
    const pend = pendingOf(state.level);
    const skipPyramid = streaming && cesiumLevelOfSpan(Math.max(east-west, north-south)) < 5;
    for (let ty = y0; !skipPyramid && ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = tileKey(tx, ty);
        if (cache.has(key)) continue;
        promises.push(fetchTile(state.level, tx, ty));
      }
    }
    // 【祖先剪枝】Cesium 请求的粗层瓦片只是**占位祖先**，
    // 真正被渲染的是更细的层级。实测 60 km 相机渲染集合是
    // level 9/10/11/12，而 L0/L1 的 633 张金字塔瓦片纯属白下：
    // 每个地形瓦片只采样自己的矩形，L0 的采样结果只有 L0 自己用，
    // 而 L0 从不被渲染。
    // 这两次 ensureRect 各耗时 7.5 s —— 是「加载太慢」的最大单项。
    const ancLevel = cesiumLevelOfSpan(Math.max(east - west, north - south));
    if (!streaming && ancLevel >= 0) {
      const rendered = renderedLevelSet();
      if (rendered.size && !rendered.has(ancLevel)) {
        state.stats.pyrSkippedByAncestor = (state.stats.pyrSkippedByAncestor || 0) + 1;
        promises.length = 0;
      }
    }
    // 屏幕分辨率门限：屏幕每像素的地面距离、或渲染网格的顶点间距
    // 粗于细源 4 倍时，不拉细源。
    // ensureLoaded 走的是「按显式矩形补齐」的路径（预热 / 缓存窗口），
    // 那里同样不该在高空拉一堆看不见的瓦片。
    const gpp = state.stats.groundPerPixel;
    if (streaming) {
      if (!meshRequest) promises.push(warmExplicitDetail(west,south,east,north));
      return Promise.all(promises).then(function () { return true; });
    }
    if (!promises.length) {
      // 即使金字塔没有瓦片要取，细源仍可能需要预取
      return ensureFineRect(west, south, east, north, gpp).then(function () { return true; });
    }
    // z11 细源与金字塔并行预取：谁先到谁先被采样用到
    const finePromise = ensureFineRect(west, south, east, north, gpp);
    return Promise.all([Promise.all(promises), finePromise]).then(function () {
      return true;
    });
  }

  /** 该经纬度是否落在全国金字塔**或任一叠加 DEM**覆盖范围内。 */
  function covers(lon, lat) {
    for (let i = 0; i < state.overlays.length; i++) {
      if (overlayCovers(state.overlays[i], lon, lat)) return true;
    }
    if (!state.index) return false;
    const b = state.index.bbox;
    return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  }

  /* ------------------------------------------------------------------ 对外 */

  function setEnabled(on) {
    state.enabled = !!on;
    if (!on) {
      // 关闭时清空缓存，释放内存
      state.tiles = {};
      state.pending = {};
      state.stats.loaded = 0;
      for (let i = 0; i < state.overlays.length; i++) {
        state.overlays[i].tiles = {};
        state.overlays[i].pending = {};
      }
    }
    if (typeof state.onChange === 'function') {
      try {
        state.onChange('enabled', state.enabled);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function stats() {
    const total = state.hits + state.misses;
    return {
      ready: state.indexReady,
      failed: state.indexFailed,
      enabled: state.enabled,
      level: state.level,
      levels: state.index ? state.index.levels.map(function (l) { return l.level; }) : [],
      bbox: state.index ? state.index.bbox : null,
      loadedTiles: state.stats.loaded,
      requests: state.stats.requests,
      megabytes: Math.round((state.stats.bytes / 1048576) * 10) / 10,
      hitRate: total ? Math.round((state.hits / total) * 1000) / 1000 : 1,
      overlays: state.overlays.map(function (ov) {
        return {
          id: ov.id,
          name: ov.name,
          ready: ov.indexReady,
          bbox: ov.index ? ov.index.bbox : null,
          levels: ov.index ? ov.index.levels.map(function (l) { return l.level; }) : [],
          requests: ov.stats.requests,
          megabytes: Math.round((ov.stats.bytes / 1048576) * 10) / 10,
          // 当前按屏幕分辨率选中的层（见 overlayPickLevel）
          pickedLevel: ov.indexReady ? overlayPickLevel(ov, state.stats.groundPerPixel) : null,
          // 选中层的像元尺寸（米）
          pickedMeters: (function () {
            if (!ov.indexReady) return 0;
            const lv = overlayPickLevel(ov, state.stats.groundPerPixel);
            const m = overlayLevelMeta(ov, lv);
            if (!m) return 0;
            const resDeg = m.resDeg || ((m.east - m.west) / Math.max(1, m.width - 1));
            return Math.round(resDeg * 111320 * Math.cos(Math.PI / 6));
          })(),
        };
      }),
      // 屏幕分辨率驱动的层选择诊断（见 pickLevelByScreenResolution）
      screenVertexSpacing: state.stats.screenVertexSpacing,
      groundPerPixel: state.stats.groundPerPixel,
      // 层选择的「天花板」诊断：像元尺寸（米）与上限
      screenCapMeters: state.stats.screenCapMeters,
      screenChosenMeters: state.stats.screenChosenMeters,
      // overlay 预取被屏幕分辨率挡掉的次数
      overlaySkippedByResolution: state.stats.overlaySkippedByResolution || 0,
      // 细源（z12 ≈31 m 或 z11 ≈76 m）诊断
      fineSource: {
        streaming: streaming, inFlight: detailJobs.size, batchMeshes:batchMeshes, streamStats: Object.assign({}, detailStats),
        ready: FINE_SRC.ready,
        level: FINE_SRC.z,
        name: FINE_SRC.name,
        loaded: FINE_SRC.tiles.size,
        requests: FINE_SRC.stats.requests,
        megabytes: Math.round((FINE_SRC.stats.bytes / 1048576) * 10) / 10,
        // 【重复下载诊断】calls = 实际发起 fetch 的次数；
        //   refetched = 其中「曾被 LRU 淘汰过又拉一遍」的次数。
        //   refetched/calls 高 → 缓存上限太小或预取在churn。
        calls: FINE_SRC.stats.calls,
        refetched: FINE_SRC.stats.refetched,
        refetchPct: FINE_SRC.stats.calls
          ? Math.round((FINE_SRC.stats.refetched / FINE_SRC.stats.calls) * 1000) / 10 : 0,
        evicted: FINE_SRC.evicted.size,
        missing: FINE_SRC.missing.size,
        lastWanted: FINE_SRC.stats.lastWanted,
        // 【屏幕分辨率门控】因为「屏幕分辨率或顶点间距粗于细源 4 倍」
        // 而跳过的预取次数。>0 说明当前视野拉细源是浪费。
        skippedByResolution: state.stats.fineSkippedByResolution || 0,
        // 【LOD 剪枝】因为「这一级只是占位祖先、不会被渲染」而跳过的次数。
        skippedByAncestor: state.stats.fineSkippedByAncestor || 0,
        // 【全局预算】已用 / 总量，以及因预算耗尽而跳过的次数。
        budgetUsed: FINE_SRC.budgetUsed,
        budgetTotal: fineBudget(),
        budgetExhausted: state.stats.fineBudgetExhausted || 0,
        budgetEpoch: FINE_SRC.budgetEpoch,
        // 门控的判据本身：屏幕每像素地面距离 / 渲染顶点间距 vs 细源像元尺度
        groundPerPixel: state.stats.groundPerPixel
          ? Math.round(state.stats.groundPerPixel) : 0,
        renderedVertexSpacing: state.stats.renderedVertexSpacing
          ? Math.round(state.stats.renderedVertexSpacing) : 0,
        prefetchUseful: finePrefetchUseful(state.stats.groundPerPixel),
        resMeters: Math.round(fineSrcResolutionDeg() * 111320 * Math.cos(Math.PI / 4)),
        // 各级别的实际像元尺度（北纬 25 / 36.6 / 45）
        resByLat: {
          lat25: Math.round(fineSrcResolutionDeg() * 111320 * Math.cos(25 * Math.PI / 180)),
          lat366: Math.round(fineSrcResolutionDeg() * 111320 * Math.cos(36.6 * Math.PI / 180)),
          lat45: Math.round(fineSrcResolutionDeg() * 111320 * Math.cos(45 * Math.PI / 180)),
        },
      },
    };
  }

  window.LEDemTiles = {
    streaming: streaming, detailReady: detailReady, discardOldDetail: discardOldDetail, overlayGrid: overlayGrid, fineGrid:fineGrid,
    init: init,
    heightAt: heightAt,
    updateForCamera: updateForCamera,
    ensureRect: ensureRect,
    covers: covers,
    setEnabled: setEnabled,
    stats: stats,
    pickLevel: pickLevel,
    /**
     * 各层的实际加载情况（诊断用）：
     *   { 0: {loaded, bytes}, 3: {...}, ... }
     * 用来验证「L4 是不是真被用上了」——只看 state.level 不够，
     * 因为 levelOrder 会按分辨率从细到粗依次尝试。
     */
    levelStats: function () {
      const out = {};
      for (const lv of Object.keys(state.tiles)) {
        const m = state.tiles[lv];
        let bytes = 0;
        for (const t of m.values()) bytes += (t.data ? t.data.length : 0) * 2;
        out[lv] = { loaded: m.size, bytes: bytes };
      }
      return out;
    },
    onChange: function (fn) { state.onChange = fn; },
    /**
     * 来源归因统计（诊断用，需 ?attrib=1）。
     * 返回 { overlay, external, fine, pyramid, none } —— 各来源实际出值的次数。
     * 用来回答「这个点的细源到底有没有顶上来」。
     */
    attribution: function () {
      const total = attrib.overlay + attrib.external + attrib.fine + attrib.pyramid + attrib.none;
      const pct = function (k) {
        return total ? Math.round((attrib[k] / total) * 1000) / 10 : 0;
      };
      return {
        enabled: attribEnabled,
        total: total,
        overlay: attrib.overlay,
        external: attrib.external,
        fine: attrib.fine,
        pyramid: attrib.pyramid,
        none: attrib.none,
        pctFine: pct('fine'),
        pctPyramid: pct('pyramid'),
      };
    },
    /** 归因计数清零（探针分段统计用）。 */
    resetAttribution: function () {
      attrib.overlay = 0; attrib.external = 0; attrib.fine = 0;
      attrib.pyramid = 0; attrib.none = 0;
    },
    indexUrl: INDEX_URL,
    // 叠加金字塔（本地导入的高精度 DEM）
    addOverlay: addOverlay,
    removeOverlay: removeOverlay,
    listOverlays: function () {
      return state.overlays.map(function (ov) {
        return {
          id: ov.id, name: ov.name, ready: ov.indexReady,
          bbox: ov.index ? ov.index.bbox : null,
        };
      });
    },
    overlayHeightAt: overlayHeightAt,
    /**
     * 注册「更细高程源」回调（terrain.js 用它把 1″ 源接进来）。
     * 回调签名 (lon, lat, maxResolutionDeg) => 高程(米) | null。
     * maxResolutionDeg 是调用方（金字塔当前层）的像元尺度：
     * 回调只应在「自己比 maxResolutionDeg 更细且覆盖该点」时返回值。
     */
    registerFinerSource: function (fn, intersects) {
      state.finerSource = typeof fn === 'function' ? fn : null;
      state.finerIntersects = typeof intersects === 'function' ? intersects : null;
    },
  };

  /* ==================================================================== *
   * 飞前闸门 LEFlyGate
   * ==================================================================== *
   *
   * 【要解决的问题】
   *   导入 KMZ 后相机**直接跳**到目标区，落点那一刻目标区的
   *   DEM / 影像都还没到，屏幕上出现：
   *     · 一片「黑色多边形洞」（= globe.baseColor #0a1622 露出来）
   *     · 高度错位的贴地线
   *   原因不是数据缺失（三个 s2cloudless 层严格嵌套覆盖），而是**时序**：
   *   飞行途中影像处于 TRANSITIONING，子瓦片纹理尚未就位。
   *   实测时间线见 docs/IMAGERY-READY-API.md §2。
   *
   * 【本闸门做什么】
   *   飞行**之前**先把目标矩形准备好：
   *     1) ensureRect —— 拉目标矩形的 DEM 瓦片；
   *     2) pin 保护区 —— 防止飞行途中被 LRU 淘汰；
   *     3) 轮询 Cesium 内部状态 —— 目标矩形内瓦片 terrainState===6
   *        且影像 state===READY(4)；
   *     4) 全部满足（或超时）后才执行真正的 flyTo。
   *
   * 【设计约束】
   *   · 纯**增量**模块：不改任何既有函数行为，只新增 window.LEFlyGate。
   *   · 有总超时（默认 6 s）：闸门卡住时照飞，绝不把用户锁死。
   *   · 闸门失败**不抛错**，只返回 { ok:false, reason }，调用方照常飞。
   */
  const FLY_GATE = {
    /** 总开关：置 false 可让闸门完全旁路（用于 A/B 对照测量）。 */
    enabled: true,
    /**
     * 「主线程静默」的判定窗口（毫秒）。
     *
     * 【为什么要可调】
     *   KMZ 的几何构建是**分块**跑的：连续几个 50~500 ms 的长任务之间
     *   会夹着 100~400 ms 的间隙。只看「刚刚有没有长任务」会误判成已完成。
     *   窗口越大越保守（等更久），代价是每次定位多等这么久。
     *   实测（tools/probe-kmz-final.mjs）：
     *     600 ms  → 仍偶有 1~2 张黑洞瓦片
     *     1500 ms → 落点 0 黑洞
     */
    idleMs: 1500,
    /** 等主线程静默的上限（毫秒）；超时照飞，绝不锁死用户。 */
    idleTimeoutMs: 3000,
    /**
     * 预取还在下载时，允许在原预算之外再多等多久（毫秒）。
     *
     * 【为什么需要】
     *   慢网络实测（4× CPU + 800 KB/s）：预取本身要十几秒，
     *   而调用方给的预算是 6 s —— 闸门在预取**正常进行中**就判 timeout-none
     *   放行，落点照样露底色。这个额度就是让闸门等预取真的跑完。
     *
     * 【实测数据】
     *   顺序下三层（z11/z12/z13）累计 36 s；改成**并行**后
     *   总时间 ≈ 最慢那一层（实测 z12 单层 35 s），
     *   所以 35 s 级别的预取需要这个额度兜底。
     */
    extraBudgetMs: 40000,
    /** 飞行前等待目标区就绪；返回 { ok, reason, waitedMs, ready, total }。 */
    prepare: function (rect, opts) {
      opts = opts || {};
      const budgetMs = opts.timeoutMs != null ? opts.timeoutMs : 6000;
      const t0 = performance.now();
      const out = { ok: false, reason: '', waitedMs: 0, ready: 0, total: 0 };

      if (!FLY_GATE.enabled) { out.reason = 'disabled'; return Promise.resolve(out); }
      if (!rect) { out.reason = 'no-rect'; return Promise.resolve(out); }
      if (![rect.west, rect.south, rect.east, rect.north].every(isFinite)) {
        out.reason = 'bad-rect';
        return Promise.resolve(out);
      }

      // 【坐标系归一：闸门内部一律「度」】
      //
      //   【这是本闸门最大的一个坑，之前一直踩着】
      //   调用方（js/kml-native.js flyToBounds、js/importers.js fitDataSource）
      //   传进来的是**度**（实测 west=102.248, south=24.913）；
      //   而闸门内部要跟 Cesium 的矩形对象比较
      //   （tile.rectangle 是**弧度**），两者直接比必然错：
      //     · tileIntersects 永远 false → 目标区瓦片一个都匹配不上
      //       → readyStats 一直 total=0 → pollReady 判 timeout-none；
      //     · prefetchImagery 用「度」算 Web Mercator 行列
      //       → (102+180)/360*2^z 溢出 → 请求到不存在的瓦片 → 404。
      //   实测（tools/probe-gate-units.mjs）：
      //     闸门收到的 raw      = {west:102.248, south:24.913, ...}   ← 度
      //     换算成度            = {west:5858.40, ...}                 ← 荒谬
      //     flyTo 收到的 raw    = {west:1.7846, south:0.4348, ...}    ← 弧度（正确）
      //
      //   所以这里做一次显式归一：闸门内部统一用「度」，
      //   只在跟 Cesium 矩形比较时（tileIntersects）才换算成弧度。
      //   判据用**量级**：|值| > 2π + ε 只可能是度（弧度最大 π）。
      const norm = normalizeGateRect(rect);
      const west = norm.west, south = norm.south, east = norm.east, north = norm.north;
      out.units = norm.units;

      // --- 1) pin 保护区：目标矩形的 DEM 瓦片不许被 LRU 淘汰 ---
      const pinned = pinRect(west, south, east, north);

      // --- 1b) 等主线程静默 ---
      // 【为什么必须先等这一下】
      //   导入 KMZ 时，几何构建是一连串 200~400 ms 的长任务。
      //   如果在构建还没完时就起飞，Cesium 的影像状态机被饿死，
      //   落点那一帧目标区有一半瓦片还在 TRANSITIONING → 露底色（黑洞）。
      //   实测 A/B：不等静默 → 落点 14 帧黑洞（最严重 33 张）；
      //             等静默   → 落点 0 帧黑洞。
      // 这一步有独立的上限（默认 2.5 s），超时也照飞，绝不把用户锁死。
      const idleMs = opts.idleMs != null ? opts.idleMs
        : (FLY_GATE.idleMs != null ? FLY_GATE.idleMs : 1500);
      const idleTimeoutMs = opts.idleTimeoutMs != null ? opts.idleTimeoutMs
        : (FLY_GATE.idleTimeoutMs != null ? FLY_GATE.idleTimeoutMs : 3000);
      const idlePromise = opts.waitIdle === false
        ? Promise.resolve({ ok: false, waitedMs: 0, reason: 'skipped' })
        : waitMainThreadIdle(idleMs, idleTimeoutMs);

      // 【deadline 必须在「等静默」之后再结算】
      //   实测（慢网络 4× CPU + 800 KB/s，tools/probe-kmz-final.mjs）：
      //     闸门 waitedMs=6665，ok=false reason=timeout-none，ready=0/total=0。
      //   拆开看：等静默就花了 2565 ms，6 s 预算只剩 3.4 s 给预取 ——
      //   而预取那一层自己就要 9.4 s（9 张瓦片）。于是预取被 deadline 砍断，
      //   pollReady 判 timeout-none 放行，落点照样露底色。
      //   正确做法：预算是给「轮询」的，等静默有独立上限；
      //   轮询的 deadline 从**静默结束**算起，预取还在跑时再延到硬上限。
      //
      //   所以 deadline 是**动态**的：这里记下「静默结束的时刻」，
      //   pollReady 的截止时间从那一刻起算。
      const idleDoneMark = { at: t0 };
      idlePromise.then(function () { idleDoneMark.at = performance.now(); });

      // --- 2) 拉 DEM ---
      const ensurePromise = Promise.resolve()
        .then(function () { return ensureRect(west, south, east, north); })
        .catch(function () { return false; });

      // --- 2b) 预取影像：把目标矩形的卫星瓦片先下到共享缓存 ---
      // 【为什么必须提前预取】相机还在千里之外时，Cesium **不会**去请求
      // 目标区的瓦片（不在当前视野），所以「等 Cesium 把影像准备好」
      // 等到的是相机飞过去之后 —— 那时洞已经露出来了。
      // 预取把下载**前移**到飞行之前，飞行途中瓦片已在缓存里，
      // 落地时直接贴上，不再有 TRANSITIONING 的空窗。
      const prefetchPromise = prefetchImagery(west, south, east, north);

      // --- 3) 轮询 Cesium 内部就绪状态 ---
      // 【deadline 从「等静默结束」算起，而不是从 prepare() 入口算起】
      //   实测（慢网络 4× CPU + 800 KB/s，tools/probe-kmz-final.mjs）：
      //     闸门 waitedMs=6665，ok=false reason=timeout-none，ready=0/total=0。
      //   拆开看：等静默就花了 2565 ms，6 s 预算只剩 3.4 s 给预取 ——
      //   而预取那一层自己就要 9.4 s（9 张瓦片）。于是预取被 deadline 砍断，
      //   pollReady 判 timeout-none 放行，落点照样露底色。
      //   正确做法：预算是给「轮询」的，等静默有独立上限；
      //   预取还在跑时再延到硬上限（extraBudgetMs）。
      const extraBudgetMs = FLY_GATE.extraBudgetMs != null ? FLY_GATE.extraBudgetMs : 20000;
      const pollPromise = idlePromise.then(function () {
        const dl = idleDoneMark.at + budgetMs;
        const hardDl = dl + extraBudgetMs;
        return pollReady(west, south, east, north, dl, hardDl, prefetchPromise);
      });

      return Promise.all([ensurePromise, prefetchPromise, pollPromise, idlePromise]).then(function (r) {
        out.waitedMs = Math.round(performance.now() - t0);
        out.ready = r[2].ready;
        out.total = r[2].total;
        out.ok = r[2].ok;
        out.reason = r[2].reason;
        out.imagery = r[1];
        out.idle = r[3];
        // 闸门只是「尽量等」，超时也放行
        return out;
      });
    },

    /**
     * 把目标矩形钉住（保护其 DEM 瓦片不被 LRU 淘汰）。
     * 返回 { keys: n }，unpinRect 可解除。
     */
    pin: function (rect) {
      if (!rect) return { keys: 0 };
      return pinRect(rect.west, rect.south, rect.east, rect.north);
    },
    unpin: function () { unpinAll(); },
    /** 诊断：当前钉住了多少张瓦片。 */
    pinnedCount: function () { return PIN.keys.size; },
  };

  /* ------------------------------ 闸门内部实现 ------------------------------ */

  /**
   * 把闸门收到的矩形归一成**度**（闸门的内部规范单位）。
   *
   * 【为什么选「度」做规范单位】
   *   调用方（js/kml-native.js flyToBounds、js/importers.js fitDataSource）
   *   传进来的是度；而 DEM 金字塔自己的索引（meta.east/west/north/south，
   *   见 js/dem-tiles.js 的 DEM_INDEX）也是度；影像预取的行列换算
   *   （tileRangeForRect / wmtsTileRange）也吃度。
   *   所以闸门内部一律用**度**，只在跟 Cesium 的矩形对象比较时
   *   （tile.rectangle 是弧度）才换算 —— 见 tileIntersects()。
   *
   * 【怎么判「是不是度」】
   *   弧度的取值范围是 [-π, π]，所以只要任一边 |值| > π，就一定是度。
   *   这里用 2π + 1e-9 作阈值留一点安全余量。
   *
   * @param {{west,south,east,north}} rect
   * @returns {{west,south,east,north,units:'deg'|'rad'}} 归一后的度矩形
   */
  function normalizeGateRect(rect) {
    const vals = [rect.west, rect.south, rect.east, rect.north];
    const looksLikeDegrees = vals.some(function (v) { return Math.abs(v) > Math.PI * 2 + 1e-9; });
    if (looksLikeDegrees) {
      return { west: rect.west, south: rect.south, east: rect.east, north: rect.north, units: 'deg' };
    }
    // 传进来的是弧度 → 换成度
    const R2D = 180 / Math.PI;
    return {
      west: rect.west * R2D, south: rect.south * R2D,
      east: rect.east * R2D, north: rect.north * R2D,
      units: 'rad',
    };
  }

  /**
   * 主线程忙碌度监视器。
   *
   * 【为什么需要它】
   *   实测（tools/probe-kmz-gateab.mjs，A/B 对照）：
   *     A 基线（不等静默）→ 落点有 **14 帧**黑洞，最严重一帧 **33 张**目标瓦片
   *                        处于 TRANSITIONING（露底色）；
   *     B 等主线程静默后放行 → 落点 **0 帧**黑洞。
   *   同时 B 组的 longtask 数量从 22 个（总 4315 ms）降到 9 个（946 ms）。
   *
   * 【机理】
   *   Cesium 的影像状态机（UNLOADED→RECEIVED→TEXTURE_LOADED→READY）
   *   是在**渲染循环**里推进的；主线程被 KMZ 几何构建这类长任务占住时，
   *   状态机走不完，落点那一帧就露底色。
   *   飞行途中相机高度剧烈变化又会让 Cesium 同时请求大量瓦片，
   *   两者叠加 → 落点必然有洞。
   *
   * 【为什么用 longtask / long-animation-frame 观测】
   *   它们直接给出「主线程被连续占用多久」，比数帧率准。
   *   浏览器不支持时退化成「按固定静默时长等」。
   */
  const MAIN = { lastBlockEnd: 0, count: 0, totalMs: 0, supported: false, observer: null };
  (function initMainWatch() {
    if (typeof PerformanceObserver === 'undefined') return;
    const mark = function (end, dur) {
      if (end > MAIN.lastBlockEnd) MAIN.lastBlockEnd = end;
      MAIN.count++;
      MAIN.totalMs += dur || 0;
    };
    try {
      // 优先用 long-animation-frame：它把「渲染被长脚本/长任务卡住」也算进去，
      // 比 longtask 更贴近「这一帧没画出来」。
      const po = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        for (const e of entries) {
          const d = e.blockingDuration != null ? e.blockingDuration : e.duration;
          mark(e.startTime + (e.duration || 0), d);
        }
      });
      po.observe({ type: 'long-animation-frame', buffered: true });
      MAIN.observer = po;
      MAIN.supported = true;
      return;
    } catch (err) { /* 浏览器不支持，退回 longtask */ }
    try {
      const po2 = new PerformanceObserver(function (list) {
        for (const e of list.getEntries()) mark(e.startTime + e.duration, e.duration);
      });
      po2.observe({ entryTypes: ['longtask'] });
      MAIN.observer = po2;
      MAIN.supported = true;
    } catch (err2) { MAIN.observer = null; }
  })();

  /**
   * 等主线程安静下来。
   *
   * @param {number} quietMs  连续「没有阻塞」至少要多久才算静默
   * @param {number} timeoutMs 上限（保证闸门不会无限等）
   * @returns {Promise<{ok:boolean, waitedMs:number, reason:string}>}
   */
  function waitMainThreadIdle(quietMs, timeoutMs) {
    quietMs = quietMs != null ? quietMs : 600;
    timeoutMs = timeoutMs != null ? timeoutMs : 2500;
    const t0 = performance.now();
    return new Promise(function (resolve) {
      const check = function () {
        const now = performance.now();
        const silent = now - MAIN.lastBlockEnd;
        if (silent >= quietMs) {
          resolve({ ok: true, waitedMs: Math.round(now - t0), reason: 'idle' });
          return;
        }
        if (now - t0 >= timeoutMs) {
          resolve({ ok: false, waitedMs: Math.round(now - t0), reason: 'idle-timeout' });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  /**
   * 预取目标矩形的卫星影像瓦片。
   *
   * 【为什么预取一条「层级带」而不是单层】
   *   相机落点高度约 28 km 时，Cesium 渲染的是 Web Mercator 的 z12–z14；
   *   而按矩形跨度算出来的层级只有 z11 —— 比实际渲染层级**粗两级**。
   *   实测（tools/probe-kmz-visual.mjs）：只预取 z11 时，相机落点那一帧
   *   目标区仍有 **2 张黑洞瓦片**；补上 z12–z14 后降到 0。
   *   原因：z11 瓦片在 Cesium 里是**父级**，到达时要等它裂成 z12/z13 子瓦片，
   *   那个「裂变过渡期」就是露底色（TRANSITIONING）的窗口。
   *   所以这里预取 span 对应层级**到 +3 级**，把父子都下好。
   *
   * 【为什么不交给 Cesium 自己去请求】相机不在目标区时 Cesium 不会请求
   *   那里的瓦片，所以只能自己下到共享缓存（js/local-imagery.js 的
   *   LEImagery.prefetch 会命中同一个 Resource.fetchImage 缓存）。
   */
  function prefetchImagery(west, south, east, north) {
    const out = { requested: 0, ok: 0, failed: 0, levels: [] };
    if (!window.LEImagery || typeof window.LEImagery.prefetch !== 'function') {
      out.reason = 'no-prefetch-api';
      return Promise.resolve(out);
    }
    // 【先确保卫星影像层存在，再预取】
    //   实测（慢网络 4× CPU + 800 KB/s，tools/probe-prefetch-timing.mjs）：
    //     闸门入口处的影像图层栈**只有 1 层**（蓝马赛克），
    //     卫星 s2cloudless 三层（主/宽域/超清）**根本还没建**。
    //   而 LEImagery.prefetch 只遍历「已存在且 show」的 provider ——
    //   没有层就没有 provider 可遍历 → requested=0（实测耗时 0~5 ms）。
    //   所以预取之前必须先把卫星影像层挂上，否则整个预取是空转。
    //
    //   为什么这时候还没建？js/terrain.js 的 syncTerrainLayers() 要等
    //   「大源（东亚/全球 DEM）加载完」才执行；在慢网络下那要十几秒，
    //   而用户导入 KMZ ��刻就触发了飞行 —— 于是飞行时只有蓝马赛克，
    //   落点必然是低分辨率底图 + 空洞。
    //
    //   这里在预取之前调一次 LETERrain.ensureLoaded()，把卫星影像层先建出来。
    const ensureLayers = ensureSatelliteImageryLayers();
    // 跨度 → Web Mercator 层级
    const span = Math.max(east - west, (north - south) * Math.cos((north * Math.PI) / 180));
    if (!isFinite(span) || span <= 0) return ensureLayers.then(function () { return out; });
    const base = Math.max(1, Math.min(11, Math.ceil(Math.log2(360 / Math.max(span, 1e-6)))));

    // 层级带：base .. base+3（父子都下好，消灭 TRANSITIONING 空窗）
    const levels = [];
    for (let lv = base; lv <= Math.min(14, base + 3); lv++) levels.push(lv);
    out.levels = levels;

    // 限流：每层最多 120 张，避免飞行前把带宽吃满。
    const LIMIT = 120;
    return ensureLayers.then(function () {
    // 【层级带要**并行**下，不能一层一层排队】
    //   实测（慢网络 4× CPU + 800 KB/s）：
    //     顺序执行 → level 11 用了 1.0 s、level 12 用了 **34.9 s**，
    //     累计 36 s —— 而闸门的硬上限只有 26 s（6 s 预算 + 20 s 额度），
    //     必然超时放行，落点照样露底色。
    //   原因：带宽管道是**共享**的，一层一层排队等于把同一个管道
    //   串行用 N 次。改成并行后各层同时挤管道，总时间 ≈ 最慢那一层。
    return Promise.all(levels.map(function (lv) {
      return window.LEImagery.prefetch(
        { west: west, south: south, east: east, north: north },
        lv,
        { limit: LIMIT }
      ).then(function (r) {
        return {
          requested: (r && r.requested) || 0,
          ok: (r && r.ok) || 0,
          failed: (r && r.failed) || 0,
        };
      }).catch(function () { return { requested: 0, ok: 0, failed: 0 }; });
    })).then(function (parts) {
      const acc = { requested: 0, ok: 0, failed: 0 };
      for (const p of parts) {
        acc.requested += p.requested;
        acc.ok += p.ok;
        acc.failed += p.failed;
      }
      out.requested = acc.requested;
      out.ok = acc.ok;
      out.failed = acc.failed;
      return out;
    }).catch(function () {
      out.reason = 'prefetch-failed';
      return out;
    });
    });
  }

  /**
   * 确保卫星影像层（s2cloudless 主/宽域/超清）已经挂到 viewer 上。
   *
   * 【为什么需要】
   *   LEImagery.prefetch 只遍历 viewer.imageryLayers 里**已存在且 show** 的
   *   provider。慢网络下用户导入 KMZ 时机很早，js/terrain.js 的
   *   syncTerrainLayers() 还在等「大源 DEM 加载完」，卫星影像层压根没建 ——
   *   实测闸门入口处图层栈只有 1 层（蓝马赛克），预取 requested=0（空转）。
   *
   * 【怎么保证能建出来】
   *   两步：
   *     1) LETERrain.apply() —— 同步走一遍「挂地形 + 挂卫星影像层」的流程。
   *        它内部会调 syncTerrainLayers() → syncImagery()，
   *        卫星层是**当场**建出来的（不等大源）。
   *        实测这一步之后图层栈从 1 层变成 4 层（蓝马赛克 + 三层 s2cloudless）。
   *     2) LETERrain.ensureLoaded() —— 确保高精源就绪（大源可能要十几秒，
   *        这里加上限，超时也放行）。
   *   只有 apply() 失败时才退到 ensureLoaded()。
   *
   * @returns {Promise<{ok:boolean, waitedMs:number, reason:string}>}
   */
  function ensureSatelliteImageryLayers() {
    const t0 = performance.now();
    const T = window.LETerrain;
    if (!T) {
      return Promise.resolve({ ok: false, waitedMs: 0, reason: 'no-terrain-api' });
    }
    // 已经有卫星层了就不用等。
    if (hasSatelliteImageryLayer()) {
      return Promise.resolve({ ok: true, waitedMs: 0, reason: 'already' });
    }

    // --- 第 1 步：apply()，同步把卫星影像层挂上 ---
    try {
      if (typeof T.apply === 'function') T.apply(state.le);
    } catch (err) {
      /* ignore —— 下面还有 ensureLoaded 兜底 */
    }
    if (hasSatelliteImageryLayer()) {
      return Promise.resolve({ ok: true, waitedMs: Math.round(performance.now() - t0), reason: 'applied' });
    }

    // --- 第 2 步：ensureLoaded()，等高精源（带上限） ---
    if (typeof T.ensureLoaded !== 'function') {
      return Promise.resolve({ ok: false, waitedMs: Math.round(performance.now() - t0), reason: 'no-terrain-api' });
    }
    const TIMEOUT = 8000;
    let settled = false;
    return new Promise(function (resolve) {
      function done(reason) {
        if (settled) return;
        settled = true;
        resolve({ ok: hasSatelliteImageryLayer(), waitedMs: Math.round(performance.now() - t0), reason: reason });
      }
      let p;
      try {
        p = Promise.resolve(T.ensureLoaded());
      } catch (err) {
        done('ensure-threw');
        return;
      }
      if (!p || typeof p.then !== 'function') { done('ensure-not-promise'); return; }
      p.then(function () { done('loaded'); }, function () { done('ensure-failed'); });
      // 上限：超时也放行，绝不把用户锁死
      setTimeout(function () { done('timeout'); }, TIMEOUT);
    });
  }

  /** 图层栈里是否已经有卫星影像层（s2cloudless / 超清 / 在线）。 */
  function hasSatelliteImageryLayer() {
    try {
      const ls = state.viewer && state.viewer.imageryLayers;
      if (!ls) return false;
      for (let i = 0; i < ls.length; i++) {
        const l = ls.get(i);
        if (!l || !l.show) continue;
        const p = l.imageryProvider;
        if (!p || !p._resource || !p._resource.url) continue;
        const u = String(p._resource.url);
        if (u.indexOf('s2cloudless') !== -1) return true;
      }
    } catch (err) { /* ignore */ }
    return false;
  }

  /**
   * 保护区（pin）：飞行途中目标区的 DEM 瓦片不许被 LRU 淘汰。
   *
   * 【为什么需要】evict() 是纯 LRU，飞行途中相机高度剧烈变化会触发
   * 大量 ensureRect，粗层瓦片会把刚拉好的细层瓦片冲掉；落地时又得重拉，
   * 于是「相机到了、瓦片没了」，正是用户看到的空洞。
   */
  const PIN = { keys: new Set() };

  /** 计算某矩形在给定 DEM 层级上的瓦片键集合。 */
  function rectTileKeys(level, west, south, east, north) {
    const meta = levelMeta(level);
    if (!meta) return [];
    const res = (meta.east - meta.west) / (meta.width - 1);
    const t = meta.tileSize;
    const x0 = Math.max(0, Math.floor((west - meta.west) / res / t));
    const x1 = Math.min(meta.cols - 1, Math.floor((east - meta.west) / res / t));
    const y0 = Math.max(0, Math.floor((meta.north - north) / res / t));
    const y1 = Math.min(meta.rows - 1, Math.floor((meta.north - south) / res / t));
    const keys = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) keys.push(level + ':' + tileKey(tx, ty));
    }
    return keys;
  }

  /**
   * 钉住一个矩形：把覆盖它的各层瓦片键放进 PIN.keys。
   * evict() 会跳过这些键。
   */
  function pinRect(west, south, east, north) {
    if (!state.indexReady) return { keys: 0 };
    const levels = [];
    const ls = state.index && state.index.levels;
    if (ls) for (let i = 0; i < ls.length; i++) levels.push(ls[i].level);
    // 叠加 DEM 层级也在其中（overlay 的层号可能与金字塔重合，按键前缀区分）
    let n = 0;
    for (const lv of levels) {
      const keys = rectTileKeys(lv, west, south, east, north);
      for (const k of keys) { if (!PIN.keys.has(k)) { PIN.keys.add(k); n++; } }
    }
    return { keys: n };
  }

  function unpinAll() { PIN.keys.clear(); }

  /**
   * 轮询 Cesium 内部状态，判断目标矩形内的瓦片是否「地形已就绪 + 影像已就绪」。
   *
   * 【判据来源】docs/IMAGERY-READY-API.md §1：
   *   · 地形：tile.data.terrainState === 6（READY）
   *   · 影像：tile.data.imagery[i].readyImagery.state === 4（READY）
   *   · 渲染集合：scene.globe._surface._tilesToRender
   *
   * 【两阶段判据】
   *   阶段 A（相机还在远处）：目标瓦片不在渲染集合里，无法用 Cesium 状态判定。
   *     这时用**预取结果**判定 —— 预取已把目标矩形的影像瓦片下好并解码，
   *     飞行途中 Cesium 请求同一张时直接命中缓存，不会再有 TRANSITIONING 空窗。
   *     所以「预取全部成功」即可放行。
   *   阶段 B（相机已到目标区）：渲染集合里有目标瓦片了，用 Cesium 的真实
   *     状态判定（terrainState===6 且影像 state===4）——这是权威判据。
   *
   * @param prefetchPromise 预取 Promise（阶段 A 的判据来源）
   */
  function pollReady(west, south, east, north, deadline, hardDeadline, prefetchPromise) {
    const out = { ok: false, reason: '', ready: 0, total: 0, mode: '' };
    return new Promise(function (resolve) {
      let prefetchResult = null;
      let prefetchDone = false;
      if (prefetchPromise && typeof prefetchPromise.then === 'function') {
        prefetchPromise.then(function (r) { prefetchResult = r; prefetchDone = true; },
          function () { prefetchDone = true; });
      } else {
        prefetchDone = true;
      }

      // 当前的截止时间：预取还在跑 → 用硬上限；预取已结束 → 用原 deadline。
      function limit() {
        return prefetchDone ? deadline : (hardDeadline || deadline);
      }

      function check() {
        const st = readyStats(west, south, east, north);
        out.ready = st.ready;
        out.total = st.total;
        out.mode = st.mode;

        // 阶段 B：渲染集合里有目标瓦片 → 权威判据
        if (st.mode === 'render' && st.total > 0) {
          if (st.ready >= st.total) {
            out.ok = true;
            out.reason = 'ready';
            resolve(out);
            return;
          }
          if (performance.now() >= limit()) {
            out.ok = false;
            out.reason = 'timeout-partial';
            resolve(out);
            return;
          }
          setTimeout(check, 120);
          return;
        }

        // 阶段 A：相机还没到 → 预取成功即可放行
        if (prefetchDone && prefetchResult) {
          const p = prefetchResult;
          if (p.requested > 0 && p.failed === 0 && p.ok >= p.requested) {
            out.ok = true;
            out.reason = 'prefetched';
            out.ready = p.ok;
            out.total = p.requested;
            resolve(out);
            return;
          }
        }
        if (performance.now() >= limit()) {
          out.ok = false;
          out.reason = st.total > 0 ? 'timeout-partial' : 'timeout-none';
          resolve(out);
          return;
        }
        setTimeout(check, 120);
      }
      check();
    });
  }

  /**
   * 目标矩形内「这一帧要画的瓦片」里，DEM+影像都已就绪的比例。
   *
   * 【为什么不能只看 _tilesToRender】
   *   相机还在千里之外时，目标区的瓦片**根本不在渲染集合里**
   *   （Cesium 只渲染当前视野），于是 total=0 —— 闸门既不知道好没好，
   *   也没法放行，只能干等到超时。这就是实测里「等满 6 s、ready=0/0」的原因。
   *   所以下面分两路：
   *     · 相机**已经**在目标区附近 → 用 _tilesToRender 判定（最准）
   *     · 相机还在远处 → 用「影像图层自己的瓦片缓存」判定
   *       （预取已经把瓦片下好了，缓存里有就是就绪）
   */
  function readyStats(west, south, east, north) {
    const out = { ready: 0, total: 0, mode: 'none' };
    const viewer = state.viewer;
    if (!viewer || !viewer.scene || !viewer.scene.globe) return out;
    let tiles;
    try {
      tiles = viewer.scene.globe._surface._tilesToRender;
    } catch (err) { return out; }

    // --- 路 1：渲染集合里有目标区的瓦片 → 直接判定 ---
    if (tiles && tiles.length) {
      for (const tile of tiles) {
        if (!tile) continue;
        if (!tileIntersects(tile, west, south, east, north)) continue;
        const ts = tile.data && tile.data.terrainState;
        if (ts !== 6) continue;   // 地形未就绪 → 不进分母
        out.total++;
        if (imageryReady(tile)) out.ready++;
      }
      if (out.total > 0) {
        out.mode = 'render';
        return out;
      }
    }

    // --- 路 2：相机还没到目标区 → 查影像图层的瓦片缓存 ---
    const cached = cachedImageryStats(west, south, east, north);
    out.mode = 'cache';
    out.ready = cached.ready;
    out.total = cached.total;
    return out;
  }

  /**
   * 统计目标矩形内、**影像图层缓存**里已经就绪的瓦片数。
   *
   * 【真 API】（已核实，见 docs/IMAGERY-READY-API.md §1.2）
   *   viewer.imageryLayers.get(i)._imageryCache["x,y,level"].state
   *   state: 0 UNLOADED / 1 TRANSITIONING / 2 RECEIVED / 3 TEXTURE_LOADED
   *          / 4 READY / 5 FAILED / 6 INVALID
   *
   * 【注意】这只反映 Cesium **已经请求过**的瓦片。
   * 预取（LEImagery.prefetch）走的是共享 URL 缓存，不经过 Cesium 的状态机，
   * 所以预取好的瓦片**不会**出现在 _imageryCache 里 ——
   * 它们的就绪由预取结果（requested/ok/failed）判定，见 pollReady 阶段 A。
   */
  function cachedImageryStats(west, south, east, north) {
    const out = { ready: 0, total: 0 };
    const viewer = state.viewer;
    if (!viewer || !viewer.imageryLayers) return out;
    let layers;
    try { layers = viewer.imageryLayers; } catch (err) { return out; }

    for (let i = 0; i < layers.length; i++) {
      const l = layers.get(i);
      if (!l || !l.show) continue;
      const p = l.imageryProvider;
      if (!p || !p.tilingScheme) continue;
      const maxL = p.maximumLevel != null ? p.maximumLevel : 14;
      const minL = p.minimumLevel != null ? p.minimumLevel : 0;
      const cache = l._imageryCache;
      if (!cache) continue;
      for (let lv = Math.max(0, minL); lv <= Math.min(18, maxL); lv++) {
        const range = wmtsTileRange(p.tilingScheme, west, south, east, north, lv);
        if (!range) continue;
        for (let x = range.x0; x <= range.x1; x++) {
          for (let y = range.y0; y <= range.y1; y++) {
            const im = cache[x + ',' + y + ',' + lv];
            if (!im) continue;
            out.total++;
            // FAILED(5) / INVALID(6) / UNLOADED(0) 都不能算就绪
            if (im.state !== 5 && im.state !== 6 && im.state !== 0) out.ready++;
          }
        }
      }
    }
    return out;
  }

  /**
   * 给定 tilingScheme，计算某层级覆盖矩形的瓦片范围。
   * 与 js/local-imagery.js 的 tileRangeForRect 同构，但这里支持任意
   * tilingScheme（地理 vs Web Mercator），所以先按 scheme 的投影换算。
   */
  function wmtsTileRange(tilingScheme, west, south, east, north, level) {
    if (!tilingScheme) return null;
    const n = Math.pow(2, level);
    try {
      const p0 = tilingScheme.positionToTileXY(
        C.Cartographic.fromDegrees(west, north), level);
      const p1 = tilingScheme.positionToTileXY(
        C.Cartographic.fromDegrees(east, south), level);
      if (!p0 || !p1) return null;
      // positionToTileXY 已经处理了投影，直接用它的结果
      const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x);
      const y0 = Math.min(p0.y, p1.y), y1 = Math.max(p0.y, p1.y);
      if (x1 < x0 || y1 < y0) return null;
      return {
        x0: Math.max(0, x0), x1: Math.min(n - 1, x1),
        y0: Math.max(0, y0), y1: Math.min(n - 1, y1),
      };
    } catch (err) {
      return null;
    }
  }

  /** 瓦片的**所有**影像层是否都已 READY。 */
  function imageryReady(tile) {
    const imgs = tile.data && tile.data.imagery;
    if (!imgs || !imgs.length) return true;   // 没有影像层 → 不算缺
    for (const im of imgs) {
      if (!im) continue;
      const r = im.readyImagery;
      // readyImagery 为空说明还在从父瓦片过渡（TRANSITIONING）
      if (!r || r.state !== 4) return false;
    }
    return true;
  }

  /** 瓦片是否与给定经纬度矩形相交（用瓦片的地理矩形）。 */
  function tileIntersects(tile, west, south, east, north) {
    let r = tile.rectangle;
    if (!r) {
      const bounds = tile.boundingVolume && tile.boundingVolume.boundingRectangle;
      if (bounds) r = bounds;
    }
    if (!r) {
      // 拿不到矩形就保守地算它相关（宁可多等）
      return true;
    }
    // 【单位】tile.rectangle 是 Cesium 的 Rectangle，存的是**弧度**；
    //   而闸门内部一律用**度**。这里必须换算，否则永远比不相交
    //   （102° vs 1.78 rad —— 实测这正是 readyStats 一直 total=0 的原因）。
    const D2R = Math.PI / 180;
    const tWest = r.west * D2R, tSouth = r.south * D2R;
    const tEast = r.east * D2R, tNorth = r.north * D2R;
    const gWest = west * D2R, gSouth = south * D2R;
    const gEast = east * D2R, gNorth = north * D2R;
    return !(tNorth < gSouth || tSouth > gNorth || tEast < gWest || tWest > gEast);
  }

  let navigationId = 0;
  let warming = null;
  // Preparation can continue in the background. An old selection must never
  // steal the camera after the user has selected another layer.
  FLY_GATE.navigate = function (rect, fly, manual) {
    const id = ++navigationId;
    if (!FLY_GATE.enabled) return fly();
    const key = [rect.west,rect.south,rect.east,rect.north].join(',');
    if (!warming || warming.key !== key) {
      const entry = {key:key};
      entry.promise = Promise.resolve().then(()=>FLY_GATE.prepare(rect,{timeoutMs:6000}))
        .catch(()=>null).finally(()=>{if(warming===entry)warming=null;});
      warming = entry;
    }
    let timer;
    const deadline = new Promise(resolve=>{timer=setTimeout(resolve,manual ? 450 : 1500);});
    return Promise.race([warming.promise,deadline]).then(()=>{
      clearTimeout(timer);
      return id === navigationId ? fly() : false;
    });
  };
  window.LEFlyGate = FLY_GATE;
})();

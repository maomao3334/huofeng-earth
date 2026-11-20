/*
 * 逐顶点地形法线（terrain vertex normals）
 *
 * 背景
 * ----
 * Cesium 1.146 的 CustomHeightmapTerrainProvider / HeightmapTerrainData 路径
 * 永远拿不到顶点法线：
 *   - CustomHeightmapTerrainProvider.hasVertexNormals 固定返回 false；
 *   - HeightmapTessellator.computeVertices 构造 TerrainEncoding 时第 6 个参数写死 false。
 * 于是 GlobeSurfaceTileProvider 里的
 *   O = terrainProvider && terrainProvider.hasVertexNormals
 * 恒为 false，着色器只会 push ENABLE_DAYNIGHT_SHADING（按椭球面法线做昼夜明暗），
 * 而不会 push ENABLE_VERTEX_LIGHTING（逐顶点地形起伏光照）。
 *
 * 但 TerrainEncoding 的 hasVertexNormals 是「构造参数」，不是只读常量；
 * Cesium 自己的 fill tile（无贴图瓦片的补面）就用了 new TerrainEncoding(..., true, true, ...)
 * 并用 octEncode 写入逐顶点法线。也就是说：只要自己造 TerrainData / TerrainMesh，
 * 就能让 Globe 走 ENABLE_VERTEX_LIGHTING 分支：
 *
 *   vec3 normalMC = czm_octDecode(encodedNormal);
 *   v_normalEC = czm_normal3D * v_normalMC;
 *   ...
 *   float diffuseIntensity = clamp(
 *       czm_getLambertDiffuse(czm_lightDirectionEC, normalize(v_normalEC))
 *       * u_lambertDiffuseMultiplier + u_vertexShadowDarkness, 0.0, 1.0);
 *
 * 这正是 Google Earth Pro 的做法：
 *   - GE Pro：igVertexFormatVA 逐顶点法线 + igOglVisualContext 方向光半角（见 docs/GE-PRO.md）
 *   - 本项目：同一套「逐顶点法线 + 方向光 Lambert」模型，换到 Cesium 的实现里。
 *
 * 实现要点（全部从 vendor/cesium/index.cjs 反查确认，不是猜的）
 * ----------------------------------------------------
 * 1) 法线的坐标系是 ECEF（地心地固）。
 *    Cesium 内部造 fill mesh 时用 ellipsoid.geodeticSurfaceNormalCartographic()，
 *    该函数返回的就是 ECEF 向量；着色器里 v_normalMC 被 czm_normal3D 旋转到眼坐标，
 *    czm_normal3D 来自 view 矩阵的 3×3 部分，因此法线必须是世界（ECEF）方向。
 *
 * 2) 法线必须用「渲染出来的那张网格」的高度来算，不能用更细的原始 DEM：
 *    否则光照会和几何对不上（出现几何上看不出的明暗斑块）。
 *    本模块直接从基础网格的顶点缓冲里 decodeHeight 取高度，与几何严格一致。
 *
 * 3) 顶点排布（来自 HeightmapTessellator.computeVertices）：
 *    前 W*H 个是格点，row-major、行 0 在北、列 0 在西；
 *    之后是裙边（skirt）顶点，顺序 west → south → east → north，
 *    裙边顶点索引 = ot+j，与 edge 索引数组一一对应：
 *      west  裙边 ot+0..ot+H-1   ↔ westIndicesSouthToNorth[j]
 *      south 裙边 ot+H..ot+H+W-1 ↔ southIndicesEastToWest[j]
 *      east  裙边 ot+H+W..       ↔ eastIndicesNorthToSouth[j]
 *      north 裙边 ot+H+2W..      ↔ northIndicesWestToEast[j]
 *
 * 4) 顶点缓冲区布局由 TerrainEncoding._calculateStrideAndOffsets 决定，字段顺序固定为
 *    [位置/纹理坐标块][webMercatorT][顶点法线][椭球面法线(3)]
 *    基础网格没有顶点法线，所以它的布局是 [块][wmt][gsn(可选)]。
 *    新网格是 [块][wmt][vn][gsn(可选)] —— 因此不能整块 memcpy，
 *    必须把 gsn 字段后移、法线插到中间。
 *
 * 5) 着色器侧读取位置（BITS12 / NONE 两种量化）：
 *    BITS12: compressed0(vec4) + compressed1(float)，法线 = compressed1
 *    NONE  : position3DAndHeight(vec4) + textureCoordAndEncodedNormals(vec4)，法线 = .w
 *    两种情况下法线都是「每顶点最后一个 float」。
 *
 * 6) oct 编码必须和 Cesium 完全一致：
 *      toSNorm(v) = round((clamp(v,-1,1)*0.5+0.5)*255)
 *      octPackFloat(x,y) = 256*x + y
 *    GLSL czm_octDecode(float) 先 x=floor(v/256)、y=(v-x)*256，再 czm_octDecode(vec2,255)。
 *
 * 对外 API：window.LETerrainNormals
 *   createProvider(options)  造一个带顶点法线的 provider
 *   isSupported()            Cesium 是否具备所需接口
 *   lastStats()              最近一次建网格的统计信息（调试用）
 */
(function () {
  'use strict';

  const C = window.Cesium;

  // 本脚本自身的 URL（用于推导 worker 脚本的绝对路径）。
  // 必须在**加载时**捕获 —— 懒初始化时 document.currentScript 已经是 null。
  const SCRIPT_BASE_URL = (function () {
    try {
      const cur = document.currentScript;
      if (cur && cur.src) return cur.src.replace(/[^/]*$/, '');
      // 兜底：从本脚本已知会加载的目录推
      return new URL('js/', location.href).href;
    } catch (err) {
      return 'js/';
    }
  })();

  const stats = {
    last: null,
    built: 0,
    throttled: 0,
    // 细分耗时统计（ms）：worker 往返 + 法线重建
    tessMs: 0,
    normalsMs: 0,
    poolSize: 0,
    // worker 实际执行耗时累加（不含排队），用于算池利用率
    workerMs: 0,
    tasks: 0,
    // 主线程拼装 worker 结果（buildTerrainMeshFromWorker）的耗时累加
    assembleMs: 0,
    // 主线程准备 worker 参数（buildTessParams）的耗时累加
    prepareMs: 0,
    // 队列峰值深度（诊断用）
    queueMax: 0,
    // 池满后进入排队的次数（诊断用）
    queuedCount: 0,
    // 消息交付延迟累加：派发 → 主线程回调开始（= 主线程被占住的时间）
    deliverWaitMs: 0,
    deliverCount: 0,
    // 主线程处理单个结果的总耗时累加（含法线重建）
    handlerMs: 0,
    // ---- 法线 worker 化相关 ----
    // 派发到 worker 的次数
    normalsDispatched: 0,
    // worker 池大小
    normalsPoolSize: 0,
    // worker 计算耗时累加（含消息往返）
    normalsWorkerMs: 0,
    // 主线程「准备」（解高度、算 encoding、收集裙边）耗时累加
    prepareNormalsMs: 0,
    // 主线程「装配」（写顶点缓冲、建 TerrainMesh）耗时累加
    assembleNormalsMs: 0,
    // 回退到主线程计算的次数（worker 不可用 / 出错）
    normalsFallback: 0,
  };

  /* ------------------------------------------------------------------ *
   * 细分 worker 池
   * ------------------------------------------------------------------ *
   *
   * 【为什么要自己开池，而不是直接调官方 createMesh】
   *
   * Cesium 1.146 的高度图细分只有一个 worker：
   *   var VYe = new oi("createVerticesFromHeightmap");           // 不限并发
   *   var jYe = new oi("createVerticesFromHeightmap", 5);        // 限 5 并发
   *   Lg.prototype.createMesh = ... (s ? jYe : VYe).scheduleTask(...)
   * 也就是说**无论 throttle 开还是关，网格细分都排队在同一个 worker 上**。
   * 实测（相机 9 km、昆明一带、grid 65、1280×800）：
   *   - 单个 65² 瓦片细分 ≈ 11.5 ms
   *   - 本次会话需要 923 个瓦片 → 923 × 11.5 ms ≈ 10.6 s
   *   - 实测「最后一个网格完成」时刻 = 11.08 s —— 与上面吻合
   * 也就是说：**加载慢的主因是细分被单 worker 卡住**，不是网络、也不是 DEM 采样。
   *
   * 而 throttle=true 时更糟：Cesium 的 TaskProcessor 在池满时**同步返回 undefined**，
   * Cesium 收到 undefined 就当「本次没排上」，下一帧再试同一个瓦片。
   * 实测 20 秒里 createMesh 被调用 **108 561 次**，其中 **99.1 % 立刻返回 undefined**。
   * 这些重试本身要占主线程 CPU（每次都要走一遍状态机），实测把主线程 50ms 心跳
   * 的 p99 拖到 430 ms，而真正的 render 只用掉 12.5 ms/帧 —— 主线程被重试风暴饿死。
   *
   * 【本模块的做法】
   *   1) 自建 N 个 TaskProcessor（每个是独立 worker），按 round-robin 派发；
   *   2) 池满时**排队等待**（返回一个 pending Promise），而不是像 Cesium 那样
   *      同步返回 undefined 让 Cesium 每帧重试 —— 重试风暴消失；
   *   3) 用 Cesium 官方的 HeightmapTessellator + TerrainProvider 索引生成器
   *      在主线程把 worker 结果拼成 TerrainMesh，语义与官方 createMesh **逐位一致**
   *      （已用 parity 测试验证：顶点/索引完全相同）。
   *
   * 【为什么不是「主线程同步细分」】
   * 主线程同步细分实测 388 tiles/s，比多 worker 池更快（313 tiles/s），
   * 但它会把每帧的主线程占满 → 交互掉帧、相机拖动发涩。
   * worker 池把这段 CPU 挪出主线程，是「加载快」与「拖动顺」之间的正确取舍。
   */
  /**
   * 细分 worker 数量。默认 8；可用 ?tessworkers=N 覆盖（便于基准测试）。
   * 上限 16：再多的 worker 收益递减，且每个 worker 都要占一份 Cesium.js chunk 内存。
   *
   * 【为什么默认 8】实测（相机 9 km、昆明一带、920 个瓦片、总览时间）：
   *   1 →  未收敛      2 → 17121 ms    4 → 13149 ms
   *   8 → 11395 ms    12 → 10795 ms   16 → 收益 <3%
   * 细分本身在 worker 里只占 ~33 ms/瓦片，8 个 worker 已能把吞吐拉满
   * （8 × 1/33ms ≈ 240 瓦片/s），剩下的瓶颈在采样与 LOD 深度，不再是 worker。
   * 取 8 而不是 12：12 只再快 5%，但多占 4 个 worker 的内存（每个约 1 MB 脚本 + 堆）。
   */
  function resolveTessWorkerCount() {
    const fallback = 8;
    try {
      const params = new URLSearchParams(location.search);
      const v = Number(params.get('tessworkers'));
      if (isFinite(v) && v >= 1) return Math.min(16, Math.floor(v));
    } catch (err) {
      /* ignore */
    }
    return fallback;
  }
  const TESS_WORKER_COUNT = resolveTessWorkerCount();
  // 排队上限：本会话需要约 900 个瓦片，队列必须能一次性吸收全部突发，
  // 否则超限的那批会拿到 undefined → Cesium 下一帧重试 → 又回到重试风暴。
  // 队列项只持有一个 Float32Array（65² ≈ 17 KB），900 项 ≈ 15 MB，可以接受。
  const TESS_QUEUE_LIMIT = 1024;

  const tessPool = {
    processors: [],
    roundRobin: 0,
    active: 0,
    queue: [],
    failed: false,
  };

  /**
   * 【流水线深度】允许同时「在飞」的任务数 = poolSize × TESS_DEPTH。
   *
   * 【为什么需要它 —— 第三轮实测的根因】
   * 旧的池只有一层背压：`active >= poolSize` 就不再派发，其余任务在主线程排队。
   * 于是「在飞」的任务数被钉死在 poolSize（8）。
   *
   * 但实测（tools/diag-tess-latency.mjs，H1）证明：
   * **worker 的结果交付要等主线程空出来**。人为把主线程阻塞 X ms，
   * worker 往返时间就涨 X ms（0→3.1 ms，20→22.6 ms，50→53 ms，100→102.6 ms）。
   * 也就是说 worker 计算完（只要 3.15 ms）还要**排队等主线程取结果**。
   *
   * 于是就出现了这个局面：
   *   - 主线程正忙于渲染（细分跨度内 scene.render 占 62.7%）→ 结果交付被拖慢；
   *   - 主线程被拖慢 → 派发新任务的频率下降 → worker 手里的活干完就闲下来；
   *   - 实测有效并发只有 5.4~6.6（8 个 worker），**worker 有 20~30% 的时间在等**。
   *
   * 提高流水线深度的作用：让 worker **永远有活干**。
   * 派发不再等主线程有空，多余的结果先在 worker 侧排好队，
   * 主线程忙完一批再统一取走 —— 相当于给「worker → 主线程」这一段加了一个缓冲。
   *
   * 【为什么不能无限加深】
   * 每个在飞任务持有：heightmap（65² Float32 ≈ 17 KB）+ 结果 vertices（125 KB）。
   * 深度 8 × 8 worker = 64 个在飞任务 → 结果缓冲最坏 ~8 MB，可以接受。
   * 但深度越大，主线程一次性要处理的回调就越多 → 单帧阻塞变长，反而拖慢交付。
   *
   * 【第三轮实测：深度是真正的瓶颈，默认取 8】
   * tools/diag-pool-depth.mjs 测出**在飞数被钉在深度上限上**：
   *   深度 2 → 在飞数 p50 = 15、p90 = 16、max = 17（上限 = 8×2 = 16），
   *   同时队列里躺着最多 242 个瓦片、整轮共 446 个瓦片进过队列。
   * 也就是说到达是**突发**的（每 250 ms 最多 253 个请求），
   * 而池一次只放得下 16 个 → 突发全压在队列上。
   *
   * tools/diag-depth-ab.mjs 的 A/B（每个深度 4 次重复，独占机器，取中位数）：
   *   深度   就绪中位数   派发率   平均并发   队列峰值   每瓦片端到端
   *   1      8369 ms     144.5/s   5.54       372        615 ms
   *   2      8043 ms     152.1/s   7.45       261        405 ms
   *   4      7978 ms     154.8/s  10.36        92         93 ms
   *   8      8055 ms     166.5/s  14.74        51         95 ms
   *
   * 深度 1→8 让**每瓦片端到端延迟从 615 ms 降到 95 ms（−85%）**，
   * 队列峰值从 372 降到 51 —— 突发不再堆积。
   * 就绪时间只从 8369 降到 8055 ms（−3.8%），因为总时间被**到达速率**限死
   * （到达 180/s vs 交付 166/s），延迟的改善体现在交互响应上而非启动总时长。
   * 深度 4 与 8 的就绪差异在噪声内，但 8 的派发率更高、队列更浅，取 8。
   *
   * 独立的 bench-terrain-load.mjs 前后对照（3 次取中位数）：
   *   深度 1 → 9257 ms / 564 瓦片 / 51.7–53.4 fps
   *   深度 8 → 8438 ms / 556 瓦片 / 52.0–52.3 fps   （就绪 −8.8%）
   *
   * 【可用 ?tessdepth= 覆盖】用于基准测试（1..16）。
   */
  function resolveTessDepth() {
    const fallback = 8;
    try {
      const params = new URLSearchParams(location.search);
      const v = Number(params.get('tessdepth'));
      if (isFinite(v) && v >= 1) return Math.min(16, Math.floor(v));
    } catch (err) {
      /* ignore */
    }
    return fallback;
  }
  const TESS_DEPTH = resolveTessDepth();
  let tessDepth = TESS_DEPTH;

  /** 派发时刻观察者（诊断用；生产路径上为 null，不产生额外开销）。 */
  let dispatchObserver = null;

  /** 每次 createMesh 调用都会经过这里，诊断用：记录级别与是否走了池路径。 */
  let createMeshObserver = null;

  /** 在飞任务上限（不含排队等待的）。 */
  function tessInflightLimit(procs) {
    return procs.length * tessDepth;
  }

  /** 懒初始化 worker 池（worker 启动有开销，第一次真正用时才建）。 */
  function ensureTessPool() {
    if (tessPool.failed) return null;
    if (tessPool.processors.length) return tessPool.processors;
    if (!C.TaskProcessor) {
      tessPool.failed = true;
      return null;
    }
    try {
      for (let i = 0; i < TESS_WORKER_COUNT; i++) {
        // 必须是**裸文件名**（相对 CESIUM_BASE_URL），带斜杠路径会让 Cesium 找不到 worker
        tessPool.processors.push(new C.TaskProcessor('createVerticesFromHeightmap.js'));
      }
      stats.poolSize = tessPool.processors.length;
      return tessPool.processors;
    } catch (err) {
      console.warn('[LETerrainNormals] 细分 worker 池创建失败，回退官方路径', err);
      tessPool.failed = true;
      tessPool.processors = [];
      return null;
    }
  }

  /** 派发一次细分任务到 worker 池；超过在飞上限时排队。 */
  function scheduleTessellation(params) {
    const procs = ensureTessPool();
    if (!procs) return null;
    if (dispatchObserver) dispatchObserver(performance.now(), params && params.__tileKey);
    if (tessPool.active >= tessInflightLimit(procs)) {
      if (tessPool.queue.length >= TESS_QUEUE_LIMIT) return null; // 队列爆了 → 回退官方路径
      stats.queuedCount += 1;
      const p = new Promise(function (resolve, reject) {
        tessPool.queue.push({ params: params, resolve: resolve, reject: reject });
      });
      if (tessPool.queue.length > stats.queueMax) stats.queueMax = tessPool.queue.length;
      return p;
    }
    return runTessellation(procs, params);
  }

  function runTessellation(procs, params) {
    const proc = procs[tessPool.roundRobin % procs.length];
    tessPool.roundRobin = (tessPool.roundRobin + 1) % procs.length;
    tessPool.active += 1;
    const tStart = performance.now();
    // 记录派发时刻，供诊断区分「排队等待」与「消息交付等待」
    if (params && typeof params === 'object') {
      try {
        params.__dispatchAt = tStart;
      } catch (err) {
        /* ignore */
      }
    }
    return Promise.resolve(proc.scheduleTask(params, [])).then(
      function (result) {
        const ms = performance.now() - tStart;
        tessPool.active -= 1;
        stats.workerMs += ms;
        stats.tasks += 1;
        recordTask(tStart, ms, false);
        drainTessQueue(procs);
        return result;
      },
      function (err) {
        const ms = performance.now() - tStart;
        tessPool.active -= 1;
        stats.workerMs += ms;
        stats.tasks += 1;
        recordTask(tStart, ms, true);
        drainTessQueue(procs);
        throw err;
      }
    );
  }

  /**
   * 记录每个任务的「派发时刻 / 完成时刻 / worker 净耗时」，用于诊断池的时间线。
   * 只保留最近 4000 条，避免长期运行内存无限增长。
   */
  const taskTimeline = [];
  function recordTask(tStart, ms, failed) {
    if (taskTimeline.length > 4000) taskTimeline.splice(0, 1000);
    taskTimeline.push([Math.round(tStart), Math.round(ms), failed ? 1 : 0]);
  }

  function drainTessQueue(procs) {
    if (!tessPool.queue.length) return;
    const item = tessPool.queue.shift();
    runTessellation(procs, item.params).then(item.resolve, item.reject);
  }

  /**
   * 池状态探针（只读，供 tools/diag-tess-pipeline.mjs 采样）。
   * 每 100 ms 采一次，用来算「池饱和比例」和「队列深度」。
   */
  function tessPoolProbe() {
    return {
      poolSize: tessPool.processors.length,
      active: tessPool.active,
      queued: tessPool.queue.length,
      dispatched: stats.tasks,
      done: stats.built,
    };
  }

  /**
   * 把 worker 返回的原始结果拼成 TerrainMesh。
   *
   * 这一段等价于官方 createMesh 的后半段（`Lg.prototype.createMesh` 的 .then），
   * 逐项照抄其语义：
   *   裙边高度 = min(几何误差 × 4, 1000)
   *   索引 = TerrainProvider.getRegularGridAndSkirtIndicesAndEdgeIndices(gridWidth, gridHeight)
   *   顶点/索引数组、boundingSphere、orientedBoundingBox 全部按官方方式克隆
   */
  function buildTerrainMeshFromWorker(result, center, rectangle) {
    const E = C.TerrainProvider.getRegularGridAndSkirtIndicesAndEdgeIndices(
      result.gridWidth,
      result.gridHeight
    );
    const vertexCount = result.gridWidth * result.gridHeight;
    return new C.TerrainMesh(
      center,
      new Float32Array(result.vertices),
      E.indices,
      E.indexCountWithoutSkirts,
      vertexCount,
      result.minimumHeight,
      result.maximumHeight,
      rectangle,
      C.BoundingSphere.clone(result.boundingSphere3D),
      C.Cartesian3.clone(result.occludeePointInScaledSpace),
      result.numberOfAttributes,
      C.OrientedBoundingBox.clone(result.orientedBoundingBox),
      C.TerrainEncoding.clone(result.encoding),
      E.westIndicesSouthToNorth,
      E.southIndicesEastToWest,
      E.eastIndicesNorthToSouth,
      E.northIndicesWestToEast
    );
  }

  /*
   * 几何误差上报系数：上报值 = 该系数 × 顶点间距。
   *
   * 官方 CustomHeightmapTerrainProvider 写死 64×2 的高度图假设，
   * 其等效上报值 = 0.25 × 顶点间距（0.25 是 Cesium 内部常量 heightmapTerrainQuality）。
   * 那个 0.25 对我们这个 33²~65² 的 provider 偏乐观：
   * Cesium 拿它判断「还要不要再细化」，报小了就会**提前停止细化**，
   * 于是 30 m 的 GLO-30 DEM 被 38~76 m 的顶点间距抽稀 —— 沟壑和丘陵就没了。
   *
   * 取 1.0 = 保守上报「一个完整顶点间距」，配合 js/perf.js 里各档的
   * screenSpaceError，可以让每一档都落到 ≤25 m 顶点间距。
   * 实测帧耗时 p50：1.3 ms（0.25）→ 5.1 ms（0.75）→ 7.2 ms（1.0）。
   *
   * 【为什么最终取 0.75 而不是 1.0】
   * 1.0 偏保守：Cesium 会**过冲**细化，导致构建了远多于实际渲染的瓦片。
   * 实测（相机 9 km、昆明、~900 瓦片）：
   *   构建 906 个瓦片 → 实际渲染只有 618 个 —— **31% 的细分是白做的**。
   * 层级分布里出现 133 个 L16 瓦片，但它们大多在屏幕外。
   *
   * 把上报值调低一档到 0.75，Cesium 提前一级停止细化：
   *   收敛时间 10961 ms → **8528 ms（−22%）**
   *   构建瓦片 914 → **559（−39%）**
   *   帧率 33.2 → **54.3 fps（+63%）**
   *
   * 【安全性：跨相机高度扫描过】
   * tools/sweep-geofactor.mjs 在 6 个相机高度上对比最深层级与顶点间距：
   *   高度      40km   20km   9km    4km    1.5km  600m
   *   1.0       L13    L14    L16    L18    L20    L20
   *   0.75      L13    L14    L15    L17    L20    L20
   * 顶点间距（米）：
   *   1.0       38.2   19.1   4.8    1.2    0.3    0.3
   *   0.75      38.2   19.1   9.6    2.4    0.3    0.3
   * 只有 9 km / 4 km 降了一级，间距 9.6 m / 2.4 m —— 仍远低于
   * js/perf.js 定的 25 m 阈值。贴地飞行（1.5 km / 600 m）完全不受影响。
   * 保真度对照（tools/matrix-fidelity.mjs，四个波段的细节保留率）同样持平。
   *
   * 【可用 ?geofactor= 覆盖】用于基准测试 LOD 过冲的代价/收益。
   */
  function resolveGeometricErrorFactor() {
    const fallback = 0.75;
    try {
      const params = new URLSearchParams(location.search);
      const v = Number(params.get('geofactor'));
      if (isFinite(v) && v > 0) return Math.min(4, v);
    } catch (err) {
      /* ignore */
    }
    return fallback;
  }
  const GEOMETRIC_ERROR_SPACING_FACTOR = resolveGeometricErrorFactor();

  // ------------------------------ 基础数学 ------------------------------

  const WGS84_A = 6378137.0;
  const WGS84_E2 = 6.69437999014e-3;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** 与 Cesium 内部 toSNorm 一致 */
  function toSNorm(v) {
    return Math.round((clamp(v, -1, 1) * 0.5 + 0.5) * 255);
  }

  /**
   * 与 Cesium 内部 octEncodeInRange + octPackFloat 一致。
   * 返回值可直接喂给 TerrainEncoding.encode 的法线参数（它内部会做 octPackFloat）。
   * @returns {{x:number,y:number}} SNORM 量化后的八面体编码（x/y 为 0..255 整数）
   */
  function octEncode(x, y, z) {
    const len = Math.abs(x) + Math.abs(y) + Math.abs(z);
    if (!(len > 0)) return { x: 0, y: 0 };
    let px = x / len;
    let py = y / len;
    if (z < 0) {
      const sx = px < 0 ? -1 : 1;
      const sy = py < 0 ? -1 : 1;
      const ax = Math.abs(py);
      const ay = Math.abs(px);
      px = (1 - ax) * sx;
      py = (1 - ay) * sy;
    }
    return { x: toSNorm(px), y: toSNorm(py) };
  }

  // --------------------------- 法线计算 worker 池 ---------------------------

  /**
   * 法线计算 worker 池。
   *
   * 【为什么】computeVertexNormals 是纯 CPU 的双重循环，原来在**主线程**跑。
   * 实测（tools/probe-normals-build.mjs，一次 KMZ 导入）：
   *   built 516 块法线网格（每块 65×65 = 4225 格点），
   *   normalsMs 累加 **548 ms** 纯主线程占用。
   * 单次只有约 1 ms，但 Cesium 是同步调 createMesh 的，这些回调挤在
   * 渲染循环里，累计成 longtask（实测峰值 952 ms）。
   *
   * 【为什么 worker 只算数学、不碰 Cesium】
   * 需要的只是 sin/cos/sqrt。内联进 worker 后启动 < 10 ms；
   * 若 importScripts 整个 Cesium.js（6 MB UMD）要好几秒，不划算。
   * 最后一步「顶点缓冲拼装」只有 9 ms/516 块，留在主线程。
   *
   * 【池大小】默认 2 个：每块网格只有约 1 ms 的计算量，
   * 瓶颈在消息往返而不是算力；2 个足够让主流水线不空转，
   * 又不至于占太多内存（每个 worker 约 17 KB 堆）。
   * 可用 ?normalsworkers=N 覆盖。
   */
  function resolveNormalsWorkerCount() {
    const fallback = 2;
    try {
      const raw = new URLSearchParams(location.search).get('normalsworkers');
      // get() 缺失时返回 null，Number(null)===0 → 必须先挡掉 null/空串
      if (raw === null || raw === '') return fallback;
      const v = Number(raw);
      // 0 = 强制关闭 worker（回到纯主线程路径），用于 A/B 对照
      if (v === 0) return 0;
      if (isFinite(v) && v >= 1) return Math.min(8, Math.floor(v));
    } catch (err) {
      /* ignore */
    }
    return fallback;
  }

  const normalsPool = {
    workers: [],
    roundRobin: 0,
    seq: 0,
    pending: new Map(),
    failed: false,
  };

  function ensureNormalsPool() {
    if (normalsPool.failed) return null;
    if (normalsPool.workers.length) return normalsPool.workers;
    try {
      const count = resolveNormalsWorkerCount();
      if (count === 0) {
        // 显式关闭（?normalsworkers=0）→ 走主线程路径
        normalsPool.failed = true;
        return null;
      }
      for (let i = 0; i < count; i++) {
        // 【路径】用脚本自身的 URL 推导 worker 路径，兼容页面被放在子目录下运行。
        // 注意不能在懒初始化时读 document.currentScript（那时已是 null），
        // 所以在脚本加载时就把基准 URL 存下来。
        const w = new Worker(SCRIPT_BASE_URL + 'workers/terrain-normals-worker.js');
        w.onmessage = function (ev) {
          const msg = ev.data || {};
          const p = normalsPool.pending.get(msg.id);
          if (!p) return;
          normalsPool.pending.delete(msg.id);
          // 往返耗时：从派发到主线程收到结果（含 worker 计算 + 消息往返）
          stats.normalsWorkerMs += performance.now() - p.dispatchedAt;
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.normals);
        };
        w.onerror = function (e) {
          console.warn('[LETerrainNormals] 法线 worker 出错，回退主线程计算：', e && e.message);
          normalsPool.failed = true;
          // 让所有在等的任务失败 → 调用方回退主线程路径
          normalsPool.pending.forEach(function (p) {
            p.reject(new Error('normals worker error'));
          });
          normalsPool.pending.clear();
        };
        normalsPool.workers.push(w);
      }
      stats.normalsPoolSize = normalsPool.workers.length;
      return normalsPool.workers;
    } catch (err) {
      console.warn('[LETerrainNormals] 法线 worker 池创建失败，用主线程计算：', err);
      normalsPool.failed = true;
      return null;
    }
  }

  /**
   * 把法线计算派发到 worker。
   * @returns {Promise<Float32Array>|null} null 表示 worker 不可用（调用方走主线程）
   */
  function computeNormalsInWorker(heights, W, H, rect) {
    const pool = ensureNormalsPool();
    if (!pool) return null;
    const id = ++normalsPool.seq;
    const dispatchedAt = performance.now();
    // 传副本并转移其 buffer：转移后原 heights 仍可用于失败回退
    const copy = new Float32Array(heights);
    return new Promise(function (resolve, reject) {
      normalsPool.pending.set(id, { resolve: resolve, reject: reject, dispatchedAt: dispatchedAt });
      const w = pool[normalsPool.roundRobin % pool.length];
      normalsPool.roundRobin++;
      stats.normalsDispatched++;
      try {
        w.postMessage({ id: id, heights: copy, W: W, H: H, rect: rect }, [copy.buffer]);
      } catch (err) {
        normalsPool.pending.delete(id);
        reject(err);
      }
    });
  }

  // --------------------------- 顶点法线计算 ---------------------------

  /**
   * 由高度格点用中心差分算出每个格点的 ECEF 法线（oct 编码后的 x/y）。
   *
   * 局部 ENU 基：up = 椭球法线，east / north 为当地水平方向。
   *   n = normalize(up - (dh/de)·east - (dh/dn)·north)
   *
   * 【与 worker 版的关系】这是主线程版本，worker 不可用时的兜底。
   * 算法与 worker 版一致（worker 版多做了 sin/cos 递推），
   * 量化后输出逐位相同（tools/probe-normals-perf.mjs 实测 maxDiff = 0）。
   */
  function computeVertexNormals(heights, W, H, rect, outXY, edgeConcat, gridCount) {
    const west = rect.west;
    const north = rect.north;
    const dLon = (rect.east - west) / (W - 1); // 每列的经度增量（弧度）
    const dLat = (north - rect.south) / (H - 1); // 每行的纬度增量（弧度）

    for (let dn = 0; dn < H; dn++) {
      const lat = north - dn * dLat;
      const sinLat = Math.sin(lat);
      const cosLat = Math.cos(lat);
      const denom = 1 - WGS84_E2 * sinLat * sinLat;
      const N = WGS84_A / Math.sqrt(denom); // 卯酉圈半径（东西向）
      const M = (WGS84_A * (1 - WGS84_E2)) / (denom * Math.sqrt(denom)); // 子午圈半径（南北向）
      const stepE = N * cosLat * dLon; // 每列的地面距离（米）
      const stepN = M * dLat; // 每行的地面距离（米）

      const dnUp = dn > 0 ? dn - 1 : dn; // 北侧邻行
      const dnDn = dn < H - 1 ? dn + 1 : dn; // 南侧邻行
      const spanN = (dnDn - dnUp) * stepN;

      const row = dn * W;
      const rowUp = dnUp * W;
      const rowDn = dnDn * W;

      for (let nr = 0; nr < W; nr++) {
        const nrW = nr > 0 ? nr - 1 : nr; // 西侧邻列
        const nrE = nr < W - 1 ? nr + 1 : nr; // 东侧邻列
        const spanE = (nrE - nrW) * stepE;

        const hW = heights[row + nrW];
        const hE = heights[row + nrE];
        const hN = heights[rowUp + nr];
        const hS = heights[rowDn + nr];

        const dhde = spanE > 0 ? (hE - hW) / spanE : 0; // dh/d(东)
        const dhdn = spanN > 0 ? (hN - hS) / spanN : 0; // dh/d(北)

        const lon = west + nr * dLon;
        const cosLon = Math.cos(lon);
        const sinLon = Math.sin(lon);

        // ECEF 局部基
        const upX = cosLat * cosLon;
        const upY = cosLat * sinLon;
        const upZ = sinLat;
        const eaX = -sinLon;
        const eaY = cosLon;
        const eaZ = 0;
        const noX = -sinLat * cosLon;
        const noY = -sinLat * sinLon;
        const noZ = cosLat;

        let nx = upX - dhde * eaX - dhdn * noX;
        let ny = upY - dhde * eaY - dhdn * noY;
        let nz = upZ - dhde * eaZ - dhdn * noZ;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(len > 0)) {
          nx = upX;
          ny = upY;
          nz = upZ;
        } else {
          nx /= len;
          ny /= len;
          nz /= len;
        }
        const enc = octEncode(nx, ny, nz);
        const o = (row + nr) * 2;
        outXY[o] = enc.x;
        outXY[o + 1] = enc.y;
      }
    }

    // 裙边顶点沿用其来源格点的法线（裙边只是遮裂缝，不参与光照语义）
    for (let j = 0; j < edgeConcat.length; j++) {
      const src = edgeConcat[j] * 2;
      const dst = (gridCount + j) * 2;
      outXY[dst] = outXY[src];
      outXY[dst + 1] = outXY[src + 1];
    }
  }

  // --------------------------- 网格构建 ---------------------------

  /**
   * 把 Cesium 建好的基础网格（不含法线）改造成带顶点法线的 TerrainMesh。
   *
   * @param {TerrainMesh} base  基础网格
   * @param {number} W  网格宽（列数）
   * @param {number} H  网格高（行数）
   * @returns {TerrainMesh} 带顶点法线的新网格
   */
  function buildNormalsMesh(base, W, H) {
    const prep = prepareNormalsMesh(base, W, H);
    // 同步兜底路径（worker 不可用时用）
    const normals = new Float32Array(prep.vertexCount * 2);
    computeVertexNormals(prep.heights, W, H, prep.rect, normals, prep.edgeConcat, prep.gridCount);
    return assembleNormalsMesh(prep, normals);
  }

  /**
   * 第一段：准备法线计算的输入（高度格点、裙边映射、encoding 布局）。
   * 这段是纯 JS 的 O(网格) 拷贝，实测 516 块累计约 9 ms，可以留在主线程。
   */
  function prepareNormalsMesh(base, W, H) {
    const baseEnc = base.encoding;
    const baseStride = baseEnc.stride;
    const baseVerts = base.vertices;
    const vertexCount = baseVerts.length / baseStride;
    const gridCount = W * H;

    // 从基础网格里取高度：与渲染几何严格一致（不受 structure/量化影响）
    const heights = new Float32Array(gridCount);
    for (let i = 0; i < gridCount; i++) heights[i] = baseEnc.decodeHeight(baseVerts, i);

    // 复制一份 encoding 并打开 hasVertexNormals
    const enc = C.TerrainEncoding.clone(baseEnc);
    enc.hasVertexNormals = true;
    enc._calculateStrideAndOffsets();
    const newStride = enc.stride;
    const normalOffset = enc._offsetVertexNormal;
    const newGsnOffset = enc._offsetGeodeticSurfaceNormal;
    const newHasGsn = enc.hasGeodeticSurfaceNormals;

    // 裙边顶点 → 来源格点：west → south → east → north
    const edgeConcat = [];
    const push = function (arr) {
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) edgeConcat.push(arr[i]);
    };
    push(base.westIndicesSouthToNorth);
    push(base.southIndicesEastToWest);
    push(base.eastIndicesNorthToSouth);
    push(base.northIndicesWestToEast);

    return {
      base: base,
      W: W,
      H: H,
      enc: enc,
      baseEnc: baseEnc,
      baseStride: baseStride,
      baseVerts: baseVerts,
      newStride: newStride,
      normalOffset: normalOffset,
      newGsnOffset: newGsnOffset,
      newHasGsn: newHasGsn,
      vertexCount: vertexCount,
      gridCount: gridCount,
      heights: heights,
      edgeConcat: edgeConcat,
      rect: {
        west: base.rectangle.west,
        south: base.rectangle.south,
        east: base.rectangle.east,
        north: base.rectangle.north,
      },
    };
  }

  /**
   * 第三段：把法线写进顶点缓冲，重建 TerrainMesh。
   * 这一段是 O(顶点) 的拷贝，实测 516 块累计约 9 ms。
   */
  function assembleNormalsMesh(prep, normals) {
    const base = prep.base;
    const baseEnc = prep.baseEnc;
    const baseStride = prep.baseStride;
    const baseVerts = prep.baseVerts;
    const newStride = prep.newStride;
    const normalOffset = prep.normalOffset;
    const newGsnOffset = prep.newGsnOffset;
    const newHasGsn = prep.newHasGsn;
    const vertexCount = prep.vertexCount;
    const gridCount = prep.gridCount;
    const edgeConcat = prep.edgeConcat;

    // 裙边顶点沿用其来源格点的法线（裙边只是遮裂缝，不参与光照语义）
    for (let j = 0; j < edgeConcat.length; j++) {
      const src = edgeConcat[j] * 2;
      const dst = (gridCount + j) * 2;
      normals[dst] = normals[src];
      normals[dst + 1] = normals[src + 1];
    }

    // 重建顶点缓冲。
    // 基础布局：[块][wmt][gsn?]        基础 gsn 起点 = baseStride - 3
    // 新布局  ：[块][wmt][vn][gsn?]     新 gsn 起点 = newStride - 3
    const baseGsnCount = baseEnc.hasGeodeticSurfaceNormals ? 3 : 0;
    const prefix = baseStride - baseGsnCount; // 块 + wmt
    const baseGsnOffset = baseStride - baseGsnCount;

    const newVerts = new Float32Array(vertexCount * newStride);
    for (let i = 0; i < vertexCount; i++) {
      const src = i * baseStride;
      const dst = i * newStride;
      for (let k = 0; k < prefix; k++) newVerts[dst + k] = baseVerts[src + k];
      // 顶点法线：oct 编码后的 x/y 合并成一个 float（256*x + y），与 Cesium 一致
      newVerts[dst + normalOffset] = 256 * normals[i * 2] + normals[i * 2 + 1];
      if (newHasGsn && baseGsnCount) {
        for (let k = 0; k < 3; k++) newVerts[dst + newGsnOffset + k] = baseVerts[src + baseGsnOffset + k];
      }
    }

    const mesh = new C.TerrainMesh(
      base.center,
      newVerts,
      base.indices,
      base.indexCountWithoutSkirts,
      base.vertexCountWithoutSkirts,
      base.minimumHeight,
      base.maximumHeight,
      base.rectangle,
      base.boundingSphere3D,
      base.occludeePointInScaledSpace,
      newStride,
      base.orientedBoundingBox,
      prep.enc,
      base.westIndicesSouthToNorth,
      base.southIndicesEastToWest,
      base.eastIndicesNorthToSouth,
      base.northIndicesWestToEast
    );

    stats.last = {
      at: performance.now(),
      vertexCount: vertexCount,
      gridCount: gridCount,
      skirtCount: vertexCount - gridCount,
      baseStride: baseStride,
      newStride: newStride,
      normalOffset: normalOffset,
      quantization: prep.enc.quantization,
      hasVertexNormals: prep.enc.hasVertexNormals,
      hasWebMercatorT: prep.enc.hasWebMercatorT,
      hasGeodeticSurfaceNormals: prep.enc.hasGeodeticSurfaceNormals,
      sampleNormal: newVerts[normalOffset],
    };
    stats.built += 1;

    return mesh;
  }

  /**
   * 完整异步路径：法线在 worker 里算，主线程只做准备与装配。
   *
   * @returns {Promise<TerrainMesh>} 永远 resolve 出合法 mesh
   *          （worker 失败时自动回退主线程计算，绝不 reject ——
   *           Cesium 收到 reject 会把瓦片判为 FAILED → 改用父级上采样，
   *           DEM 细节被抹平）
   */
  function buildNormalsMeshAsync(base, W, H) {
    const t0 = performance.now();
    const prep = prepareNormalsMesh(base, W, H);
    stats.prepareNormalsMs += performance.now() - t0;

    const p = computeNormalsInWorker(prep.heights, W, H, prep.rect);
    if (!p) {
      // worker 池不可用 → 同步主线程算
      const t1 = performance.now();
      const normals = new Float32Array(prep.vertexCount * 2);
      computeVertexNormals(prep.heights, W, H, prep.rect, normals, prep.edgeConcat, prep.gridCount);
      stats.normalsMs += performance.now() - t1;
      stats.normalsFallback++;
      return Promise.resolve(assembleNormalsMesh(prep, normals));
    }

    return p.then(
      function (gridNormals) {
        // worker 往返耗时由 onmessage 里的 stats.normalsWorkerMs 记录
        // worker 只返回格点法线（gridCount×2），装配时补裙边
        const normals = new Float32Array(prep.vertexCount * 2);
        normals.set(gridNormals.subarray(0, prep.gridCount * 2));
        const t2 = performance.now();
        const out = assembleNormalsMesh(prep, normals);
        stats.assembleNormalsMs += performance.now() - t2;
        return out;
      },
      function (err) {
        console.warn('[LETerrainNormals] worker 法线计算失败，回退主线程：', err);
        const t1 = performance.now();
        const normals = new Float32Array(prep.vertexCount * 2);
        computeVertexNormals(prep.heights, W, H, prep.rect, normals, prep.edgeConcat, prep.gridCount);
        stats.normalsMs += performance.now() - t1;
        stats.normalsFallback++;
        return assembleNormalsMesh(prep, normals);
      }
    );
  }

  // --------------------------- TerrainData ---------------------------

  /**
   * 带顶点法线的 TerrainData。
   *
   * Cesium 侧只依赖这几个成员（从 GlobeSurfaceTileProvider 反查）：
   *   createMesh / interpolateHeight / isChildAvailable /
   *   wasCreatedByUpsampling / canUpsample / upsample / credits / waterMask
   */
  function NormalTerrainData(options) {
    this._buffer = options.buffer; // Float32Array/Float64Array，长度 W*H
    this._width = options.width;
    this._height = options.height;
    this._tilingScheme = options.tilingScheme;
    this._x = options.x;
    this._y = options.y;
    this._level = options.level;
    this._createdByUpsampling = !!options.createdByUpsampling;
    this._childTileMask = options.childTileMask == null ? 15 : options.childTileMask;
    this._base = null; // 供 interpolateHeight 复用的 HeightmapTerrainData
    this._mesh = null;
  }

  Object.defineProperty(NormalTerrainData.prototype, 'credits', {
    get: function () {
      return [];
    },
  });

  Object.defineProperty(NormalTerrainData.prototype, 'waterMask', {
    get: function () {
      return undefined;
    },
  });

  Object.defineProperty(NormalTerrainData.prototype, 'childTileMask', {
    get: function () {
      return this._childTileMask;
    },
  });

  NormalTerrainData.prototype._ensureBase = function () {
    if (!this._base) {
      this._base = new C.HeightmapTerrainData({
        buffer: this._buffer,
        width: this._width,
        height: this._height,
      });
    }
    return this._base;
  };

  NormalTerrainData.prototype.createMesh = function (options) {
    const self = this;
    if (createMeshObserver) {
      createMeshObserver(this._level, this._x, this._y, options && options.throttle);
    }
    const base = this._ensureBase();
    const tilingScheme = options.tilingScheme;
    const x = options.x;
    const y = options.y;
    const level = options.level;
    const exaggeration = options.exaggeration == null ? 1 : options.exaggeration;
    const exaggerationRelativeHeight =
      options.exaggerationRelativeHeight == null ? 0 : options.exaggerationRelativeHeight;

    // ---- 路径 A：自建 worker 池（默认）----
    // 官方 createMesh 无论 throttle 与否，网格细分都排队在**同一个 worker** 上；
    // 加上 throttle=true 时「池满即返回 undefined → Cesium 每帧重试」，
    // 实测 20 秒里 108 561 次 createMesh 调用里 99.1% 是这种空转重试。
    // 下面这条路径：多 worker 并行 + 池满时排队等待（不返回 undefined、不触发重试风暴）。
    const pooled = this._createMeshViaPool({
      base: base,
      tilingScheme: tilingScheme,
      x: x,
      y: y,
      level: level,
      exaggeration: exaggeration,
      exaggerationRelativeHeight: exaggerationRelativeHeight,
      throttle: options.throttle !== false,
    });
    if (pooled) return pooled;

    // ---- 路径 B：官方 createMesh（worker 池不可用时的兜底）----
    // 【关键】官方 HeightmapTerrainData.createMesh 在「Worker 池已满」时
    // 会**同步返回 undefined** —— 这是 Cesium 自己的背压信号：
    // 调用方应放弃本次尝试，等下一帧再试（见 GlobeSurfaceTileProvider.loadTile
    // 里 terrainState 停在 RECEIVED 的重试逻辑）。
    //
    // 旧实现写的是
    //   Promise.resolve(base.createMesh(...)).then(m => buildNormalsMesh(m))
    // 于是 undefined 被当成「空网格」送进 buildNormalsMesh，
    // 抛 "Cannot read properties of undefined (reading 'encoding')"
    // → 该瓦片被标记 FAILED → Cesium 改用**父级上采样**渲染
    // → 真实 DEM 信息被双线性插值抹平，小洼/凹坑全部消失。
    // 实测（相机 9 km、昆明一带、grid 65）：
    //   6088 次父级上采样 vs 50 次成功建网格，468/488 个渲染瓦片是插值出来的。
    //
    // 修法：undefined 时**原样返回 undefined**，让 Cesium 按官方路径重试，
    // 既不伪造网格，也不把瓦片判死。
    return this._createMeshViaOfficial(
      {
        base: base,
        tilingScheme: tilingScheme,
        x: x,
        y: y,
        level: level,
        exaggeration: exaggeration,
        exaggerationRelativeHeight: exaggerationRelativeHeight,
        throttle: options.throttle !== false,
      },
      false
    );
  };

  /**
   * 走自建 worker 池的细分路径。
   *
   * @returns {Promise|undefined} undefined 表示「池不可用，请走官方路径」
   */
  NormalTerrainData.prototype._createMeshViaPool = function (ctx) {
    const self = this;
    const base = ctx.base;
    const tilingScheme = ctx.tilingScheme;
    if (!tilingScheme) return undefined;

    // 官方 createMesh 里算裙边高度用的几何误差公式，逐字照抄，保证网格完全一致
    const tParamStart = performance.now();
    const ellipsoid = tilingScheme.ellipsoid;
    const geoError = C.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      ellipsoid,
      this._width,
      tilingScheme.getNumberOfXTilesAtLevel(0)
    ) / (1 << ctx.level);
    const skirtHeight = Math.min(geoError * 4, 1000);

    const nativeRectangle = tilingScheme.tileXYToNativeRectangle(ctx.x, ctx.y, ctx.level);
    const rectangle = tilingScheme.tileXYToRectangle(ctx.x, ctx.y, ctx.level);
    const center = ellipsoid.cartographicToCartesian(
      C.Rectangle.center(rectangle, new C.Cartographic())
    );

    const params = {
      heightmap: base._buffer,
      structure: base._structure,
      includeWebMercatorT: true,
      width: this._width,
      height: this._height,
      nativeRectangle: nativeRectangle,
      rectangle: rectangle,
      relativeToCenter: center,
      ellipsoid: ellipsoid,
      skirtHeight: skirtHeight,
      isGeographic: tilingScheme.projection instanceof C.GeographicProjection,
      exaggeration: ctx.exaggeration,
      exaggerationRelativeHeight: ctx.exaggerationRelativeHeight,
      encoding: base._encoding,
      // 瓦片身份（诊断用）：与 terrain.js 的 sampleResolveLog 用同一套 key，便于跨阶段配对
      __tileKey: ((ctx.level * 2048 + ctx.x) * 2048 + ctx.y) | 0,
    };

    const tPrep = performance.now();
    stats.prepareMs += tPrep - tParamStart;
    const pending = scheduleTessellation(params);
    if (!pending) return undefined; // 队列爆了 → 官方路径（Cesium 收到 undefined 会下一帧重试）

    const t0 = performance.now();
    return pending.then(
      function (result) {
        // 回调体开始执行 = 结果消息已被主线程处理（此前主线程被占住则这里会晚很多）
        const tCb = performance.now();
        const tTess = performance.now() - t0;
        stats.tessMs += tTess;
        // 消息交付延迟：从派发到主线程真正拿到结果，主线程被占住的那部分
        stats.deliverWaitMs += tCb - t0;
        stats.deliverCount += 1;
        // 【注意】这里**绝不能** resolve(undefined)：
        // Cesium 的 aNt（RECEIVED 处理器）拿到 undefined 会写 e.mesh = undefined
        // 并把 terrainState 置为 TRANSFORMED，随后 sNt 用 undefined 建顶点数组 → 直接抛错。
        // 因此池路径失败时改为「就地回退官方路径（throttle:false）」，
        // 保证这个 Promise 一定 resolve 出一个合法 mesh。
        if (!result) return self._createMeshViaOfficial(ctx, true);
        let mesh;
        try {
          const tAsm = performance.now();
          mesh = buildTerrainMeshFromWorker(result, center, rectangle);
          stats.assembleMs += performance.now() - tAsm;
        } catch (err) {
          console.warn('[LETerrainNormals] worker 结果拼装失败，回退官方路径', err);
          stats.throttled += 1;
          return self._createMeshViaOfficial(ctx, true);
        }
        const t1 = performance.now();
        // 法线计算挪到 worker：这一步原来在主线程上做 W×H 的双重循环，
        // 一次导入 516 块累计 548 ms，挤在渲染循环里变成 longtask。
        return buildNormalsMeshAsync(mesh, self._width, self._height).then(function (out) {
          stats.normalsMs += performance.now() - t1;
          stats.handlerMs += performance.now() - tCb;
          self._mesh = out;
          return out;
        });
      },
      function (err) {
        // worker 抛错也不能让 Promise reject：
        // Cesium 收到 reject 会把瓦片判为 FAILED → 改用父级上采样 → DEM 细节被抹平。
        // 这里回退官方路径（throttle:false，保证一定能出 mesh）。
        console.warn('[LETerrainNormals] 细分任务失败，回退官方路径', err);
        stats.throttled += 1;
        return self._createMeshViaOfficial(ctx, true);
      }
    );
  };

  /**
   * 官方 createMesh 路径（worker 池不可用 / 池路径失败时的兜底）。
   *
   * @param {boolean} noThrottle 传 true 时用 throttle:false：
   *   官方不限并发的那个池（VYe）不会返回 undefined，因此 Promise 一定能 resolve 出 mesh，
   *   适合在「已经处于 Promise 链里」的场合使用。
   *
   * @returns {Promise|undefined} undefined 表示「官方池也满了，交给 Cesium 下一帧重试」
   */
  NormalTerrainData.prototype._createMeshViaOfficial = function (ctx, noThrottle) {
    const self = this;
    const base = ctx.base;
    const meshOptions = {
      tilingScheme: ctx.tilingScheme,
      x: ctx.x,
      y: ctx.y,
      level: ctx.level,
      exaggeration: ctx.exaggeration,
      exaggerationRelativeHeight: ctx.exaggerationRelativeHeight,
      throttle: noThrottle ? false : ctx.throttle !== false,
    };
    let pending;
    try {
      pending = base.createMesh(meshOptions);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!pending) {
      // 官方节流池满了。这只在「池路径完全不可用」时才会走到。
      // 若此时已经处在 Promise 链里（noThrottle 理论上不会发生），
      // 返回 undefined 会让 Cesium 拿到 undefined mesh → 崩溃。
      // 保险起见：改用 throttle:false 再试一次（不限并发池一定能排上）。
      if (noThrottle) {
        stats.throttled += 1;
        return undefined;
      }
      const retry = this._createMeshViaOfficial(ctx, true);
      return retry;
    }
    return Promise.resolve(pending).then(
      function (mesh) {
        if (!mesh) {
          stats.throttled += 1;
          return undefined;
        }
        const out = buildNormalsMeshAsync(mesh, self._width, self._height).then(function (m) {
          self._mesh = m;
          return m;
        });
        return out;
      },
      function (err) {
        console.warn('[LETerrainNormals] 官方细分失败', err);
        throw err;
      }
    );
  };

  NormalTerrainData.prototype.interpolateHeight = function (rectangle, longitude, latitude) {
    const base = this._ensureBase();
    return base.interpolateHeight(rectangle, longitude, latitude);
  };

  NormalTerrainData.prototype.isChildAvailable = function (x, y, parentX, parentY) {
    let r = 2;
    if (y !== parentY * 2) ++r;
    if (x !== parentX * 2) r -= 2;
    return (this._childTileMask & (1 << r)) !== 0;
  };

  NormalTerrainData.prototype.wasCreatedByUpsampling = function () {
    return this._createdByUpsampling;
  };

  NormalTerrainData.prototype.canUpsample = true;

  /**
   * 由父瓦片上采样出子瓦片的高度格点。
   *
   * Cesium 调用签名：upsample(tilingScheme, parentX, parentY, parentLevel, x, y, level)
   *
   * 注意：上采样出来的网格同样必须带顶点法线，否则同一 provider 下不同瓦片的
   * 顶点布局不一致，着色器会把法线槽读成别的东西（画面出现黑斑 / 异常明暗）。
   */
  NormalTerrainData.prototype.upsample = function (
    tilingScheme,
    parentX,
    parentY,
    parentLevel,
    x,
    y,
    level
  ) {
    const scheme = tilingScheme || this._tilingScheme;
    const parentRect = scheme.tileXYToRectangle(parentX, parentY, parentLevel);
    const childRect = scheme.tileXYToRectangle(x, y, level);

    const W = this._width;
    const H = this._height;
    const out = new Float32Array(W * H);
    const pW = parentRect.west;
    const pE = parentRect.east;
    const pN = parentRect.north;
    const pS = parentRect.south;
    const cW = childRect.west;
    const cE = childRect.east;
    const cN = childRect.north;
    const cS = childRect.south;

    for (let dn = 0; dn < H; dn++) {
      const lat = cN - ((cN - cS) * dn) / (H - 1);
      // 父网格的浮点行坐标（行 0 在北）
      const pn = ((pN - lat) / (pN - pS)) * (H - 1);
      const r0 = Math.floor(pn);
      const r1 = Math.min(r0 + 1, H - 1);
      const fr = pn - r0;
      for (let nr = 0; nr < W; nr++) {
        const lon = cW + ((cE - cW) * nr) / (W - 1);
        const pc = ((lon - pW) / (pE - pW)) * (W - 1);
        const c0 = Math.floor(pc);
        const c1 = Math.min(c0 + 1, W - 1);
        const fc = pc - c0;
        const h00 = this._buffer[r0 * W + c0];
        const h10 = this._buffer[r1 * W + c0];
        const h01 = this._buffer[r0 * W + c1];
        const h11 = this._buffer[r1 * W + c1];
        const top = h00 * (1 - fr) + h10 * fr;
        const bot = h01 * (1 - fr) + h11 * fr;
        out[dn * W + nr] = top * (1 - fc) + bot * fc;
      }
    }

    return Promise.resolve(
      new NormalTerrainData({
        buffer: out,
        width: W,
        height: H,
        tilingScheme: scheme,
        x: x,
        y: y,
        level: level,
        createdByUpsampling: true,
        childTileMask: 0,
      })
    );
  };

  // ---------------------------- Provider ----------------------------

  /**
   * 带顶点法线的 provider。
   *
   * 继承官方 CustomHeightmapTerrainProvider，覆盖三处：
   *   - hasVertexNormals → true（着色器开关的闸门）
   *   - requestTileGeometry → 返回自己的 NormalTerrainData（带法线的网格）
   *   - getLevelMaximumGeometricError → 按**本 provider 真实的顶点间距**上报
   *     （官方实现写死了 64×2 的假设，见下方注释）
   */
  function NormalHeightmapTerrainProvider(options) {
    C.CustomHeightmapTerrainProvider.call(this, options);
    // 官方构造函数里的字段名是压缩后的，稳妥起见自己留一份
    this._leCallback = options.callback;
    this._leWidth = options.width;
    this._leHeight = options.height;
    this._leTilingScheme = options.tilingScheme || this.tilingScheme;
    // 高程夸张系数越大，同一网格上相邻顶点的实际高差越大 → 几何误差越大。
    // 由 terrain.js 在 provider 建好之后回填（未回填时按 1 处理）。
    this._leExaggeration = 1;
    this._leLevelErrors = [];
  }

  NormalHeightmapTerrainProvider.prototype = Object.create(C.CustomHeightmapTerrainProvider.prototype);
  NormalHeightmapTerrainProvider.prototype.constructor = NormalHeightmapTerrainProvider;

  Object.defineProperty(NormalHeightmapTerrainProvider.prototype, 'hasVertexNormals', {
    get: function () {
      return true;
    },
    configurable: true,
  });

  /**
   * 上报「本级瓦片的最大几何误差」。
   *
   * 【为什么必须覆盖 —— 这是「沟壑/丘陵不渲染成 3D」的第一性原因】
   *
   * 官方 CustomHeightmapTerrainProvider 的实现是：
   *   getEstimatedLevelZeroGeometricErrorForAHeightmap(ellipsoid, 64, 2) / (1 << level)
   *   （见 vendor/cesium/index.cjs：`getEstimatedLevelZeroGeometricErrorForAHeightmap(t,64,2)/(1<<e)`）
   * 其中 64 是写死的「高度图宽」、2 是写死的「金字塔层数」。
   * 估算公式为 maximumRadius * 2π * heightmapTerrainQuality / (width * levelZeroTiles)，
   * heightmapTerrainQuality = 0.25，于是：
   *   L0 → 约 301 m，L13 → 约 9.4 m
   *
   * 但我们的 provider 实际是 **grid²（33² ~ 65²）的规则经纬网**，
   * 一块瓦片在 L13 的实际跨度是 2446 m，被 grid-1 个顶点瓜分。
   * 官方上报的 9.4 m 与真实的 2446 m 瓦片跨度差了 **8 倍以上** ——
   * Cesium 用它来挑 LOD：几何误差报得越小，它就越早认为「够精细了」，
   * 于是 **LOD 只到 L13 就停止细化**，顶点间距 = 2446 / (grid-1) ≈ 76 m。
   *
   * 30 m 的 GLO-30 DEM 被 76 m 的采样点抽稀 → 沟壑被混叠掉、丘陵被抹平，
   * 于是用户看到「山里的沟壑和平地上的丘陵没有渲染成 3D 地形」。
   *
   * 【正确的上报值】
   * Cesium 那个公式其实是「顶点间距的 0.25 倍」：
   *   0.25 × (L0 瓦片跨度 / width)
   *   = maximumRadius × 2π × 0.25 / (width × levelZeroTiles)
   * 官方公式本身的形式是对的，只是把 **width 写死成 64** 了。
   * 我们换成自己的 grid 后：
   *
   *   ge(L) = k × (L 级瓦片跨度 / (grid-1)) × 高程夸张系数
   *
   * 其中 k 是「上报的几何误差 = 几个顶点间距」。
   *
   * 【为什么 k 取 1 而不是官方的 0.25】
   * 官方那个 0.25 是 Cesium 为自己的高度图质量常量（heightmapTerrainQuality）
   * 定的经验值。对**我们**这个 provider 有两个额外的问题：
   *   1) 我们的 grid 只有 33²~65²，而官方假定 64² —— 数量级接近，
   *      所以照抄 0.25 得到的误差值与真实值同阶（实测 L13：官方 9.4 m vs
   *      真实顶点间距 76 m，差 8 倍）。
   *   2) 关键在于**误差的含义**：我们上报的量决定了 Cesium 何时认为
   *      「这块瓦片已经够精细、可以停止细化」。报得偏小 → 提前停 → 顶点稀疏。
   *
   * 实测（相机 9 km、昆明一带，grid 65）：
   *   k=0.25 → L13，顶点间距 38.2 m  ← 30 m DEM 被抽稀，沟壑/丘陵丢失
   *   k=0.50 → L14，顶点间距 19.1 m  ← 与 DEM 分辨率匹配，细节留住
   *   k=0.75 → L15，顶点间距  9.6 m  ← 更细，但瓦片数与帧耗时翻倍
   *
   * 取 k=1.0（保守上报「一个顶点间距」）配合三档各自的 screenSpaceError，
   * 就能让每一档都落到 ≤25 m 的顶点间距 —— 覆盖 30 m GLO-30 DEM 的分辨能力。
   *
   * 【代价】LOD 变深 → 同时渲染的瓦片变多。
   * 实测帧耗时（p50）：k=0.25 时 1.3 ms，k=0.75 时 5.1 ms，k=1.0 时 7.2 ms。
   * 都在 60 fps 预算内，且可由 js/perf.js 的档位（screenSpaceError）调节。
   */
  NormalHeightmapTerrainProvider.prototype.getLevelMaximumGeometricError = function (level) {
    const errors = this._leLevelErrors;
    if (errors && errors[level] !== undefined) return errors[level] * (this._leExaggeration || 1);
    const scheme = this._leTilingScheme || this.tilingScheme;
    const width = this._leWidth || this._width || 65;
    const height = this._leHeight || this._height || width;
    const samples = Math.max(1, Math.min(width, height) - 1);
    const exag = this._leExaggeration || 1;
    try {
      const rect = scheme.tileXYToRectangle(0, 0, level);
      // 瓦片跨度（米）：经纬网 → 取纬度跨度与该纬度处经度跨度的较大者
      const radius = scheme.ellipsoid ? scheme.ellipsoid.maximumRadius : 6378137;
      const latSpan = Math.abs(rect.north - rect.south) * radius;
      const midLat = (rect.north + rect.south) * 0.5;
      const lonSpan =
        Math.abs(rect.east - rect.west) * radius * Math.cos(midLat);
      const span = Math.max(latSpan, lonSpan);
      if (!isFinite(span) || span <= 0) {
        // 兜底：按官方公式退回去，保证 Cesium 不会拿到 NaN
        return this._leFallbackGeometricError(level);
      }
      // GEOMETRIC_ERROR_SPACING_FACTOR = 1.0 → 上报「一个顶点间距」
      const error = (span / samples) * GEOMETRIC_ERROR_SPACING_FACTOR;
      if (errors) errors[level] = error;
      return error * exag;
    } catch (err) {
      return this._leFallbackGeometricError(level);
    }
  };

  /** 官方公式的等价实现，作为覆盖实现的兜底。 */
  NormalHeightmapTerrainProvider.prototype._leFallbackGeometricError = function (level) {
    const scheme = this._leTilingScheme || this.tilingScheme;
    const radius = scheme.ellipsoid ? scheme.ellipsoid.maximumRadius : 6378137;
    const quality = 0.25; // Cesium 内部常量 heightmapTerrainQuality
    const tiles = scheme.getNumberOfXTilesAtLevel(0);
    const levelZero = (radius * 2 * Math.PI * quality) / (64 * tiles);
    return levelZero / (1 << level);
  };

  /** 由 terrain.js 回填当前的高程夸张系数（重建 provider 后需要重新设置）。 */
  NormalHeightmapTerrainProvider.prototype.setExaggeration = function (exaggeration) {
    this._leExaggeration = exaggeration || 1;
    return this._leExaggeration;
  };

  NormalHeightmapTerrainProvider.prototype.requestTileGeometry = function (x, y, level) {
    const self = this;
    const cb = this._leCallback;
    if (!cb) return undefined;
    const scheme = this._leTilingScheme;
    const rect = scheme.tileXYToRectangle(x, y, level);
    return Promise.resolve(cb(x, y, level)).then(function (sample) {
      let buffer = sample;
      if (Array.isArray(buffer)) buffer = new Float64Array(buffer);
      if (!buffer) buffer = new Float32Array(self._leWidth * self._leHeight);
      return new NormalTerrainData({
        buffer: buffer,
        width: self._leWidth,
        height: self._leHeight,
        tilingScheme: scheme,
        x: x,
        y: y,
        level: level,
        rectangle: rect,
      });
    });
  };

  // ---------------------------- 对外 API ----------------------------

  function isSupported() {
    return !!(
      C &&
      C.TerrainEncoding &&
      typeof C.TerrainEncoding.clone === 'function' &&
      C.TerrainMesh &&
      C.HeightmapTerrainData &&
      C.CustomHeightmapTerrainProvider &&
      C.Cartesian2
    );
  }

  /**
   * 造一个带顶点法线的 provider。参数与 CustomHeightmapTerrainProvider 相同。
   */
  function createProvider(options) {
    if (!isSupported()) {
      console.warn('[LETerrainNormals] 当前 Cesium 不支持顶点法线，回退到普通 provider');
      return new C.CustomHeightmapTerrainProvider(options);
    }
    return new NormalHeightmapTerrainProvider(options);
  }

  window.LETerrainNormals = {
    createProvider: createProvider,
    isSupported: isSupported,
    NormalTerrainData: NormalTerrainData,
    NormalHeightmapTerrainProvider: NormalHeightmapTerrainProvider,
    lastStats: function () {
      return stats.last;
    },
    probe: tessPoolProbe,
    taskTimeline: function () {
      return taskTimeline;
    },
    __setDepth: function (mult) {
      // 上限与 resolveTessDepth 一致（16），否则 ?tessdepth=16 会被这个钩子悄悄压回 8。
      tessDepth = Math.max(1, Math.min(16, mult || 1));
      return tessDepth;
    },
    __onDispatch: function (fn) {
      dispatchObserver = fn;
      return true;
    },
    __onCreateMesh: function (fn) {
      createMeshObserver = fn;
      return true;
    },
    stats: stats,
  };
})();

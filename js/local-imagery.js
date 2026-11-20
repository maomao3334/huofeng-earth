/*
 * 本地影像（仅本机）
 * - 读取 data/local/imagery.json；该目录被 .gitignore 排除，不会进入 Git / 发布包
 * - 当前支持本地 XYZ 瓦片目录（WebMercator / Geographic），JPEG 完整瓦片 + PNG 透明边界
 * - 自动加载清单里 autoLoad 的数据集；侧栏「本地影像」可手动加载/定位/移除
 * - 【跨图层共享瓦片缓存】见下方「共享瓦片缓存」一节：同一张瓦片被多个影像层
 *   （典型是主/宽域/超清三层 s2cloudless）请求时，只下载+解码一次。
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const MANIFEST_URL = 'data/local/imagery.json';

  /* ------------------------------ 共享瓦片缓存 ------------------------------
   *
   * 【为什么需要】
   *   自带卫星影像是**三层嵌套**的 s2cloudless（主 z≤7 / 宽域 z≤11 / 超清 z≤14），
   *   三层的 URL 模板完全相同（data/public/imagery/s2cloudless/{z}/{x}/{y}.jpg），
   *   只有 rectangle 不同。于是在重叠区域里**同一张瓦片会被三层各要一次**。
   *
   *   实测（tools/probe-img-dup.mjs，高画质档、昆明近景）：
   *     s2cloudless 共发 109 次请求，但**不同 URL 只有 55 个**，
   *     其中 38 个被请求 2 次、8 个被请求 3 次 → 54 次是纯重复下载。
   *   同一时刻（重叠窗口）还发出去 49 个**并发**重复请求 ——
   *   浏览器 HTTP 缓存来不及命中，服务端就真的送了 3 遍字节。
   *
   * 【为什么不能靠浏览器缓存兜底】
   *   瓦片是 `Cache-Control: public, max-age=31536000, immutable`，
   *   理论上第二次会走缓存；但 Cesium 的 RequestScheduler 允许 18 个同源并发请求，
   *   三层几乎**同时**要同一张瓦片 —— 第一个还没落盘，后面两个就已经发出去了。
   *
   * 【怎么做】
   *   在 Resource.fetchImage 这一层（**所有**影像 provider 的公共出口）加一个
   *   按 URL 归组的「在途 + 已完成」缓存：
   *     · 同一 URL 的并发请求 → 复用同一个 Promise，只发一次网络请求；
   *     · 已完成的瓦片 → 直接复用已解码结果，不再重新解码、不再重新上传纹理。
   *
   * 【为什么复用「已解码结果」是安全的】
   *   1) Cesium 上传纹理时用的是 UNPACK_FLIP_Y_WEBGL（pixelStorei），
   *      真正的上下翻转发生在 **上传纹理那一步**，不在解码那一步；
   *      而三层 s2cloudless 的 flipY 参数完全一致（都是 true），
   *      所以同一张解码结果对三层是等价的。
   *   2) 实测（tools/_tmp-glbitmap.mjs）同一个 ImageBitmap 可以被多次
   *      texImage2D 到不同纹理，内容逐像素一致、互不破坏。
   *   3) Cesium 拿到 image 后会自己建纹理并把 image 置空（t.image = void 0），
   *      不会去 close() 我们缓存的 ImageBitmap —— 缓存由我们自己管理生命周期。
   *
   * 【缓存容量】
   *   瓦片解码后是 256×256×4 = 256 KB（RGBA）。上限 384 张 ≈ 96 MB，
   *   按 LRU 淘汰 —— 超过上限时把最久没用的那张 close() 掉（释放显存/内存）。
   */

  const TILE_CACHE_LIMIT = 384;         // 最多缓存多少张已解码瓦片
  const TILE_CACHE_MAX_AGE = 120000;    // 已完成瓦片的存活时间（ms），超时清理
  const IMG_CONCURRENCY = 8;            // 共享影像下载的最大并发（同源）

  /*
   * 【为什么自己排一个下载队列，而不是交给 Cesium 的 RequestScheduler】
   *
   *   Cesium 的 RequestScheduler 对同源限 18 个并发，超了就**同步拒绝**
   *   （request() 返回 undefined）。原生 Cesium 收到 undefined 会把瓦片标成
   *   UNLOADED 并在下一帧重试 —— 没问题。
   *
   *   但我们要复用同一个 Promise 给三层 s2cloudless，
   *   一旦把这个 Promise 包装成「resolve 成 undefined」，
   *   Cesium 的 _requestImagery 会把它当成「取图失败」→ 状态钉死在 FAILED
   *   （实测：高画质档 63 张瓦片 FAILED）。
   *
   *   解决办法：共享下载**不经过** Cesium 的限流判定，
   *   改由我们自己排队（IMG_CONCURRENCY 张），
   *   这样 Cesium 永远拿到的都是「一定会 resolve 成图片」的 Promise：
   *     · 不会有 undefined → 不会有 FAILED；
   *     · 不会有 UNLOADED 重试轮次 → 少掉一整轮「这一帧没图」的等待；
   *     · 并发由我们自己封顶（8 张），不会把服务器打满。
   *
   * 【为什么是 8】
   *   浏览器对同源只开 **6 条** HTTP/1.1 连接。
   *   我们自己的队列数的是「真正在传输中的请求」，口径与带宽一致；
   *   取 8（略大于 6）可以让 6 条连接一直满载，
   *   又不会像 Cesium 的 18 那样把一堆请求堆在浏览器队列里空等。
   */
  const imgQueue = { active: 0, waiting: [] };

  function releaseImgSlot() {
    imgQueue.active--;
    const next = imgQueue.waiting.shift();
    if (next) {
      imgQueue.active++;
      next();
    }
  }

  /** 排队取一个「同源并发位子」，然后执行 fn。 */
  function withImgSlot(fn) {
    return new Promise(function (resolve, reject) {
      const run = function () {
        let raw;
        try {
          raw = fn();
        } catch (err) {
          releaseImgSlot();
          reject(err);
          return;
        }
        if (!raw || typeof raw.then !== 'function') {
          // 理论上不会发生（我们已关掉 throttleByServer）。
          // 万一发生：不能 resolve 成 undefined（Cesium 会判 FAILED），
          // 只能 reject —— 让 Cesium 走它自己的失败重试逻辑。
          releaseImgSlot();
          reject(new Error('影像下载未能发起：' + String(raw)));
          return;
        }
        raw.then(
          function (v) {
            releaseImgSlot();
            resolve(v);
          },
          function (e) {
            releaseImgSlot();
            reject(e);
          }
        );
      };
      if (imgQueue.active < IMG_CONCURRENCY) {
        imgQueue.active++;
        run();
      } else {
        imgQueue.waiting.push(run);
      }
    });
  }

  const tileCache = {
    inflight: new Map(),  // key -> Promise<ImageBitmap|Image>
    done: new Map(),      // key -> { image, at }（Map 的插入序 = LRU 序）
    // declined 保留在统计里（探针会读），但现在**永远是 0**：
    // 共享下载不再经过 Cesium 的同源限流判定，也就不会被「拒绝」。
    stats: { hits: 0, inflightHits: 0, misses: 0, evicted: 0, failed: 0, declined: 0 },
  };

  /**
   * 缓存键：URL **加上解码选项**。
   *
   * 【为什么不能只用 URL】
   *   fetchImage 的返回物取决于选项：
   *     · preferImageBitmap=true  → ImageBitmap（**解码时就已上下翻转**，
   *       因为 createImageBitmap 用了 imageOrientation:'flipY'）；
   *     · preferImageBitmap=false → HTMLImageElement（解码时**不翻转**）。
   *   而 Cesium 上传纹理那一步（UNPACK_FLIP_Y_WEBGL，默认 true）会**再翻一次**，
   *   两次翻转相消，屏幕方向才是对的。
   *   如果把 ImageBitmap 和 HTMLImageElement 混在同一个键下，
   *   后者会拿到「已经翻过」的图 → 上下颠倒。
   *   所以键里必须带上 flipY / preferImageBitmap / preferBlob / skipColorSpaceConversion。
   *
   *   本项目实测（tools/_tmp-flip.mjs）所有影像 provider 都走
   *   `{preferImageBitmap:true, flipY:true}` 这一组，所以实际上只有一个键空间。
   */
  function cacheKeyOf(url, opts) {
    return (
      String(url) +
      '|fy=' + (opts.flipY ? 1 : 0) +
      '|ib=' + (opts.preferImageBitmap ? 1 : 0) +
      '|pb=' + (opts.preferBlob ? 1 : 0) +
      '|sc=' + (opts.skipColorSpaceConversion ? 1 : 0)
    );
  }

  function touchDone(url, entry) {
    // Map 的 delete + set 把它挪到队尾 → 队头就是最久没用的。
    tileCache.done.delete(url);
    tileCache.done.set(url, entry);
  }

  function evictIfNeeded() {
    while (tileCache.done.size > TILE_CACHE_LIMIT) {
      const oldest = tileCache.done.keys().next();
      if (oldest.done) break;
      const url = oldest.value;
      const entry = tileCache.done.get(url);
      tileCache.done.delete(url);
      // 【为什么不 close()】ImageBitmap 一旦 close()，再拿它去 texImage2D 会抛异常。
      // Cesium 拿到图之后要过好几帧才建纹理，中间我们若淘汰并 close() 了它，
      // 就会在纹理上传那一步炸掉。所以这里**只丢引用**，让 GC 自己回收。
      tileCache.stats.evicted++;
    }
  }

  function cleanupAged() {
    const now = Date.now();
    for (const [url, entry] of tileCache.done) {
      if (now - entry.at < TILE_CACHE_MAX_AGE) break;   // Map 有序，遇到没超时的就停
      tileCache.done.delete(url);
    }
  }

  /**
   * 有限重试 + 退避。
   *
   * 【为什么需要】
   *   本地静态服务器（serve.ps1）有 16 个 runspace worker，
   *   冷启动时它还在扫目录，头几个请求可能直接 404 / 连接被拒。
   *   Cesium 的原生行为是：一次失败 → ImageryLayer 标 FAILED →
   *   provider 的 errorEvent 触发 → **这一块瓦片就永远是黑洞**，
   *   要等用户重新加载才看得见。
   *
   *   我们在共享缓存这层加一次**短退避重试**：
   *   第一次失败 → 等 120 ms → 再试一次；还失败才 reject。
   *   这样「服务器刚起来时的那一波失败」被吸收掉，
   *   黑洞瓦片数量显著下降（实测高画质档 404 全部发生在 t<1.2 s 的冷启动窗口）。
   *
   * 【为什么不多试】
   *   真正不存在的瓦片（超出覆盖范围的 z1–z3 s2cloudless）永远 404，
   *   多试只是浪费往返。1 次重试足够覆盖「服务器刚起来」的抖动。
   *
   * 【404 不重试】
   *   Cesium 的 HTTP 错误对象上带着 statusCode。
   *   404 是「这张瓦片确实不存在」，重试多少次都是 404 —— 直接失败，
   *   让 Cesium 走它自己的失败处理（这与原生行为一致）。
   *   只有 5xx / 0（网络错误）这类「可能是瞬时的」才重试。
   */
  function isPermanent(err) {
    if (err && err.name === 'AbortError') return true;
    const code = err && err.statusCode;
    return typeof code === 'number' && code >= 400 && code < 500;
  }

  function withRetry(fn, attempts, delayMs) {
    let attempt = 0;
    const step = function () {
      attempt++;
      return fn().then(
        function (v) { return v; },
        function (err) {
          if (attempt >= attempts || isPermanent(err)) throw err;
          return new Promise(function (resolve) {
            setTimeout(resolve, delayMs * attempt);
          }).then(step);
        }
      );
    };
    return step();
  }

  /**
   * 取得一张瓦片的共享解码结果。
   *
   * 【关键约束：返回值永远是「一定会 resolve 成一张图」的 Promise】
   *   Cesium 的 ImageryLayer._requestImagery 是这样处理结果的：
   *     a.then(function(c){ i(c) })   → i(s){ if (!defined(s)) return o(); ... }
   *     .catch(function(c){ o(c) })    → o(s){ state = FAILED; ... }
   *   也就是说：
   *     · resolve 成 **undefined** → 走 o() → 状态钉死在 FAILED；
   *     · reject                  → 走 o() → 状态钉死在 FAILED；
   *     · resolve 成一张图          → 走 i() → RECEIVED，正常。
   *
   *   而 Cesium 原生的「没排上队」是通过 **同步返回 undefined**（不是 Promise）
   *   表达的：Resource._fetchImage 里 `if (defined(s)) return s.catch(...)`，
   *   undefined 直接冒泡出 fetchImage → ImageryLayer 看到 `!defined(a)` →
   *   标 UNLOADED → **下一帧自动重试**。
   *
   *   所以共享缓存这条路**必须自己保证「不失败也不给 undefined」**：
   *   下载排队（withImgSlot）+ 有限重试（withRetry）都由我们自己做。
   *   一旦真的拿不到（404 / 网络错误），我们 reject →
   *   Cesium 走它自己的失败处理（FAILED + provider errorEvent），
   *   这与「共享缓存不存在」时的原生行为完全一致，不会引入新问题。
   *
   * @param {string} key      缓存键（含解码选项）
   * @param {function} loader 真正去下载+解码的函数（同步调用，返回 Promise）
   * @returns {Promise<ImageBitmap|Image>}
   */
  function sharedTile(key, loader) {

    // 1) 已完成 → 直接复用（省掉重复解码）
    const hit = tileCache.done.get(key);
    if (hit) {
      touchDone(key, hit);
      tileCache.stats.hits++;
      return Promise.resolve(hit.image);
    }

    // 2) 在途 → 复用同一个 Promise（省掉重复下载）
    const running = tileCache.inflight.get(key);
    if (running) {
      tileCache.stats.inflightHits++;
      return running;
    }

    // 3) 新请求
    tileCache.stats.misses++;

    const p = withRetry(function () {
      // 每次尝试都**单独**取一个位子：退避等待期间不占位子，
      // 免得一次 404 慢重试把整个队列卡住。
      return withImgSlot(loader);
    }, 2, 120).then(
      function (image) {
        tileCache.inflight.delete(key);
        if (image) {
          touchDone(key, { image: image, at: Date.now() });
          evictIfNeeded();
        }
        return image;
      },
      function (err) {
        tileCache.inflight.delete(key);
        tileCache.stats.failed++;
        throw err;
      }
    );
    tileCache.inflight.set(key, p);
    return p;
  }

  /** 共享缓存的对外统计（探针 / 诊断用）。 */
  function tileCacheStats() {
    cleanupAged();
    return {
      done: tileCache.done.size,
      inflight: tileCache.inflight.size,
      limit: TILE_CACHE_LIMIT,
      ...tileCache.stats,
    };
  }

  /** 清空共享瓦片缓存（画质切换 / 用户强制刷新时用）。 */
  function clearTileCache() {
    // 只丢引用，不 close()：可能还有 Cesium 纹理在等着上传它。
    tileCache.done.clear();
    tileCache.inflight.clear();
    tileCache.stats.hits = 0;
    tileCache.stats.inflightHits = 0;
    tileCache.stats.misses = 0;
    tileCache.stats.evicted = 0;
    tileCache.stats.failed = 0;
  }

  /**
   * 给 Resource.fetchImage 装上共享缓存（**全局**，对所有影像 provider 生效）。
   *
   * 【为什么钩在 Resource.fetchImage 而不是 UrlTemplateImageryProvider.requestImage】
   *   · 影像图层只是 Cesium 的一个 provider；本地影像、北京正射、底图蓝马赛克
   *     走的都是同一个 Resource.fetchImage 出口 —— 钩在这里能一次覆盖全部。
   *   · 自带三层 s2cloudless（js/terrain.js 建 provider）和本地影像
   *     （本文件 createProvider）**互不相识**，只有在这里才能跨层共享。
   *
   * 【只对影像类型生效】
   *   地形瓦片（RequestType.TERRAIN）走的是另一条路（fetchArrayBuffer），
   *   但 DEM 细源是**自绘**的 PNG，不是 Cesium 影像 —— 不受影响。
   *   保险起见仍然只拦 type === IMAGERY 的请求。
   */
  function installSharedTileCache() {
    if (!C || !C.Resource || !C.Resource.prototype || !C.Resource.prototype.fetchImage) return false;
    if (C.Resource.prototype.fetchImage.__sharedTileCache) return true;
    // 【调试开关】?nosharecache=1 时不装共享缓存（用于 A/B 对照测量）
    try {
      if (new URLSearchParams(window.location.search).get('nosharecache') === '1') return false;
    } catch (e) { /* 老浏览器没有 URLSearchParams，忽略 */ }
    const orig = C.Resource.prototype.fetchImage;

    /**
     * 造一个「专属」的 Request 对象来发这次共享下载。
     *
     * 【为什么不能直接用消费者自己的 request】
     *   Resource.fetchImage 会把 `this.request` 交给 Cesium 的 RequestScheduler，
     *   而 RequestScheduler 是**按 request 对象**记账的（active / cancelled 状态）。
     *   如果共享下载沿用第一个消费者的 request：
     *   · 那个消费者被取消 → request.cancelled = true
     *     → RequestScheduler.update() 看到 cancelled 就把它 cancel 掉
     *     → **另外两个消费者一起遭殃**（它们共享同一个 Promise）。
     *   本项目实测没触发（Cesium 1.146 的 ImageryLayer 不主动 cancel），
     *   但这是个隐患：只要将来某个 provider 取消请求，共享缓存就会连坐。
     *
     * 【专属 Request 的参数：throttleByServer = false】
     *   Cesium 的 ImageryLayer 建的是 `new Request({throttle:false, throttleByServer:true, type:IMAGERY})`。
     *   throttleByServer=true 时，RequestScheduler 按「同源最多 18 个」记账，
     *   满了就**同步拒绝**（request() 返回 undefined）。
     *
     *   【实测出来的坑】
     *     RequestScheduler 的「active」计数在**请求发出**时就 +1，
     *     要等响应回来才 -1 —— 它数的是「已发出的 XHR」，不是「浏览器正在传的连接」。
     *     而本项目的静态服务器是 HTTP/1.1，浏览器对同源只开 **6 条**连接，
     *     剩下 12 个 XHR 只能**排在浏览器队列里**（还没开始传输）。
     *     于是：Cesium 以为已经打满 18 个并发位子 → 之后所有新请求全被拒绝
     *     → 我们把「拒绝」包成 Promise → Cesium 判定取图失败 → 瓦片 FAILED
     *       （实测高画质档 63 张 FAILED、declined 计数 1518）。
     *     这是一个纯粹的**记账口径错配**：限流按「已发出」算，
     *     实际带宽按「已传输」算。
     *
     *   所以共享下载改成 throttleByServer=false（**不**参与 Cesium 的同源限流），
     *   并发由**我们自己的队列**封顶（IMG_CONCURRENCY = 8，见 withImgSlot）：
     *     · 我们的计数是「真正在传输中的」，口径和带宽一致；
     *     · 8 > 浏览器实际的 6 条连接，所以浏览器队列不会无限堆积；
     *     · Cesium 拿到的永远是「一定会 resolve 成图」的 Promise → 不再有 FAILED。
     *
     * 【专属 Request 也不带消费者状态】
     *   priority / priorityFunction 可以继承（不影响正确性），
     *   但 cancelled / state 不继承 —— 那是共享下载自己的账。
     *
     * 【为什么要给它一个「自己的」serverKey】
     *   RequestScheduler 记账用的是 `requestsByServer[serverKey]`，
     *   而 `Fpe()`（真正发起请求的地方）会 `++requestsByServer[serverKey]`，
     *   成功/失败时再减回来 —— **不管 throttleByServer 是不是 false 都记**。
     *   如果我们的共享下载还用原站点的 serverKey（127.0.0.1:8141），
     *   那 8 个在途的影像请求就会**占掉 Cesium 自己的同源额度**，
     *   导致 Cesium 的地形/其它请求被 `serverHasOpenSlots` 拒绝（UNLOADED 重试）。
     *   `Request.serverKey` 是可以在构造后直接改的（`Ur.request` 里
     *   `d(e.serverKey) || (e.serverKey = Ur.getServerKey(e.url))` ——
     *   已经填了就沿用），所以我们给它一个独立桶，互不干扰。
     */
    function ownRequest(src) {
      try {
        if (!C.Request) return src;
        const r = new C.Request({
          type: C.RequestType.IMAGERY,
          throttle: false,
          throttleByServer: false,
        });
        r.serverKey = 'le-shared-imagery';
        if (src && src.url) r.url = src.url;
        if (src && src.priority != null) r.priority = src.priority;
        return r;
      } catch (err) {
        return src;
      }
    }

    function patched(opts) {
      opts = opts || {};
      const self = this;
      // 只有「非 data/blob URI、无自定义请求头、非压缩纹理」的普通图片才走共享缓存。
      // 自定义 header 会改变响应内容（鉴权等），不能共享。
      if (self.isDataUri || self.isBlobUri || self.hasHeaders) return orig.call(self, opts);
      const type = self.request && self.request.type;
      if (type != null && C.RequestType && type !== C.RequestType.IMAGERY) return orig.call(self, opts);
      const url = self.url;
      if (!url) return orig.call(self, opts);
      const key = cacheKeyOf(url, opts);
      return sharedTile(key, function () {
        // This callback runs after acquiring a download slot, including retries.
        // A formerly online layer may already have been removed while queued.
        if (window.LEOnlineStatus?.getMode() === 'offline' && /^(https?:)?\/\//i.test(url)) {
          const host=new URL(url,location.href).hostname;
          if (host!==location.hostname && host!=='localhost' && host!=='127.0.0.1' && host!=='[::1]')
            throw new DOMException('外部影像队列已切换到离线','AbortError');
        }
        // 用专属 Request 发这次共享下载（见 ownRequest 的注释）
        const req = ownRequest(self.request);
        if (req === self.request) return orig.call(self, opts);
        const clone = self.clone();
        clone.request = req;
        return orig.call(clone, opts);
      });
    }
    patched.__sharedTileCache = true;
    C.Resource.prototype.fetchImage = patched;
    return true;
  }

  const state = {
    le: null,
    ready: false,
    datasets: [],
    loaded: new Map(), // id -> { ds, entry, layer, provider }
    section: null,
    listNode: null,
    countNode: null,
    noteNode: null,
    manifestOk: false,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function toast(msg, kind, ms) {
    if (state.le && state.le.toast) state.le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg) {
    if (state.le && state.le.status) state.le.status(msg);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function transparentCanvas() {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return c;
  }

  let blank = null;
  function blankTile() {
    if (!blank) blank = transparentCanvas();
    return blank;
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('瓦片图片解码失败'));
      };
      img.src = url;
    });
  }

  /**
   * 本地影像的 {ext} 模板：同一数据集里 jpg / png 混用。
   *
   * **为什么前端不再自己探测扩展名**：
   * 本地正射影像里 png 与 jpg 是**在同一层级内混排**的（z15 层 1331 个 png +
   * 19118 个 jpg），所以「按数据集记住一个扩展名」的做法必然对一半瓦片失效。
   * 而按 jpg→png 顺序逐瓦片试错，又会让每张 png 瓦片都先吃一次 404
   * （控制台一片红）。
   *
   * 现在把这件事交给**服务端**（serve.ps1 的 Resolve-AlternateImageExtension）：
   * 请求 .jpg 时若磁盘上只有 .png（或反之），服务端直接返回实际存在的那一个，
   * 并按真实字节头给 Content-Type。前端一次请求即可命中，控制台干净。
   */
  function tileUrl(ds, level, x, y, ext) {
    const tpl = String(ds.url || '');
    let u = tpl
      .replace(/\{z\}/g, String(level))
      .replace(/\{x\}/g, String(x))
      .replace(/\{y\}/g, String(y))
      .replace(/\{-y\}/g, String(y));
    if (/{ext}/.test(tpl)) u = u.replace(/\{ext\}/g, ext || 'jpg');
    return u;
  }

  async function fetchImage(url, signal) {
    try {
      const res = await fetch(url, { cache: 'default', signal:signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob || !blob.size) return null;
      return await loadImage(blob);
    } catch (err) {
      return null;
    }
  }

  /**
   * 取一张瓦片。
   *
   * 首选 `.jpg`；**失败才**试 `.png`。
   *
   * 为什么不一开始就并发探测两种扩展名：那会让**纯 png 数据集**的每张瓦片都
   * 先吃一次 404，浏览器控制台一片红（看起来像软件坏了）。
   * 服务端（serve.ps1 的 Resolve-AlternateImageExtension）已经会在磁盘上
   * 只有另一种扩展名时直接返回它，所以走 serve.ps1 时**第一个请求就命中**，
   * 不会产生任何 404；这里的次选分支只是给「不经 serve.ps1 的静态托管」兜底。
   */
  async function fetchTile(ds, level, x, y, signal) {
    if (ds.tileSpans) {
      const spans=ds.tileSpans[level+'/'+x];
      if (!spans || !spans.some(pair=>y>=pair[0] && y<=pair[1])) return null;
    }
    const tpl = String(ds.url || '');
    if (!/{ext}/.test(tpl)) return fetchImage(tileUrl(ds, level, x, y),signal);
    const img = await fetchImage(tileUrl(ds, level, x, y, 'jpg'),signal);
    if (img || signal?.aborted) return img;
    return fetchImage(tileUrl(ds, level, x, y, 'png'),signal);
  }

  function createProvider(ds) {
    const geographic = /geographic|4326/i.test(String(ds.scheme || ''));
    const tilingScheme = geographic ? new C.GeographicTilingScheme() : new C.WebMercatorTilingScheme();
    let rectangle;
    if (Array.isArray(ds.bounds) && ds.bounds.length === 4) {
      const b = ds.bounds.map(Number);
      if (b.every(function (n) { return isFinite(n); })) {
        rectangle = C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]);
      }
    }
    const minLevel = isFinite(Number(ds.minzoom)) ? Number(ds.minzoom) : 0;
    const maxLevel = isFinite(Number(ds.maxzoom)) ? Number(ds.maxzoom) : 22;
    const tpl = String(ds.url || '');
    const seedUrl = tpl.replace(/\{ext\}/g, 'jpg');
    // 用 Cesium 自带 UrlTemplateImageryProvider 负责层级选择/几何误差/瓦片坐标，
    // 仅替换 requestImage 以支持 .jpg / .png 混合瓦片（PNG 用于 no-data 边界）。
    const provider = new C.UrlTemplateImageryProvider({
      url: seedUrl,
      tilingScheme: tilingScheme,
      rectangle: rectangle,
      minimumLevel: minLevel,
      maximumLevel: maxLevel,
      credit: ds.attribution || '本地影像（仅本机）',
    });
    try {
      Object.defineProperty(provider, 'hasAlphaChannel', { value: true, configurable: true });
    } catch (err) { /* ignore */ }
    const lifetime = new AbortController();
    provider.stopLoading = ()=>lifetime.abort();
    provider.requestImage = function (x, y, level) {
      if (lifetime.signal.aborted) return Promise.resolve(blankTile());
      if (tpl.indexOf('{z}') < 0) return Promise.resolve(blankTile());
      return fetchTile(ds, level, x, y, lifetime.signal)
        .then(function (img) {
          if (img) return img;
          // 该瓦片在这份数据里确实不存在（两种扩展名都没有）。
          // 返回**透明**瓦片而不是报错：图层正常出图，控制台也不会刷 404。
          // Cesium 拿到 undefined 会把整层拖成红色错误态，这里必须显式给一张图。
          return blankTile();
        })
        .catch(function () { return blankTile(); });
    };
    return provider;
  }

  function dsById(id) {
    for (let i = 0; i < state.datasets.length; i++) {
      if (state.datasets[i].id === id) return state.datasets[i];
    }
    return null;
  }

  async function load(id, opts) {
    opts = opts || {};
    const ds = dsById(id);
    if (!ds) throw new Error('未知的本地影像：' + id);
    if (!state.le || !state.le.viewer) throw new Error('应用尚未就绪');
    if (state.loaded.has(id)) {
      const rec = state.loaded.get(id);
      if (rec.layer) rec.layer.show = true;
      return rec;
    }
    const provider = createProvider(ds);
    const viewer = state.le.viewer;
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = ds.opacity != null ? clamp(Number(ds.opacity), 0, 1) : 1;
    layer.show = true;
    const entry = state.le.registerLayer({
      id: 'local-imagery-' + (ds.id || 'dataset'),
      name: '本地影像 · ' + (ds.name || ds.id || '未命名'),
      type: 'imagery',
      localImagery: true,
      imageryLayer: layer,
      remove: function () {
        try {
          viewer.imageryLayers.remove(layer, true);
        } catch (err) { /* ignore */ }
        state.loaded.delete(id);
        refreshCard(id);
        refreshCount();
      },
      zoomTo: function () {
        if (provider.rectangle) state.le.flyTo({ rectangle: provider.rectangle });
      },
    });
    // 登记到图层栈：本地影像属于用户内容，排在自带卫星影像之上。
    if (window.LELayerOrder) window.LELayerOrder.addUser(entry);
    state.loaded.set(id, { ds: ds, entry: entry, layer: layer, provider: provider });
    refreshCard(id);
    refreshCount();
    if (opts.fit !== false && provider.rectangle) {
      state.le.flyTo({ rectangle: provider.rectangle });
    }
    if (opts.silent !== true) {
      toast('已加载本地影像：' + (ds.name || ds.id), 'ok', 3000);
    }
    status(
      '本地影像：' +
        (ds.name || ds.id) +
        ' · z' + provider.minimumLevel + '–' + provider.maximumLevel +
        (provider.rectangle ? ' · ' + (ds.bounds || []).join(', ') : '')
    );
    return state.loaded.get(id);
  }

  function unload(id, opts) {
    const rec = state.loaded.get(id);
    if (!rec) return false;
    if (rec.provider?.stopLoading) rec.provider.stopLoading();
    if (rec.entry && state.le && typeof state.le.removeLayer === 'function') {
      state.le.removeLayer(rec.entry.id);
    } else if (rec.layer && state.le && state.le.viewer) {
      state.le.viewer.imageryLayers.remove(rec.layer, true);
      state.loaded.delete(id);
    }
    refreshCard(id);
    refreshCount();
    if (!opts || opts.silent !== true) toast('已移除本地影像：' + (rec.ds.name || id), 'ok', 2400);
    return true;
  }

  function toggle(id) {
    if (state.loaded.has(id)) return unload(id);
    return load(id, { fit: false }).catch(function (err) {
      console.error('[LELocalImagery] 加载失败', err);
      toast('本地影像加载失败：' + (err && err.message ? err.message : err), 'error', 5000);
    });
  }

  /**
   * 把所有已加载的本地影像提到卫星影像之上。
   *
   * 现在交给图层栈统一处理（LELayerOrder），不再直接 raiseToTop，
   * 否则会盖掉用户在图层面板里的手工排序。
   */
  function raiseAll() {
    if (!state.le || !state.le.viewer) return;
    if (window.LELayerOrder) {
      for (const rec of state.loaded.values()) {
        if (rec.entry) window.LELayerOrder.addUser(rec.entry);
      }
      window.LELayerOrder.apply();
      return;
    }
    for (const rec of state.loaded.values()) {
      if (rec.layer) {
        try {
          state.le.viewer.imageryLayers.raiseToTop(rec.layer);
        } catch (err) { /* ignore */ }
      }
    }
  }

  function refreshCount() {
    if (!state.countNode) return;
    const total = state.datasets.length;
    const on = state.loaded.size;
    state.countNode.textContent = total ? (on ? on + '/' + total : String(total)) : '0';
  }

  function cardFor(id) {
    if (!state.listNode) return null;
    return state.listNode.querySelector('[data-local-imagery="' + id + '"]');
  }

  function refreshCard(id) {
    const card = cardFor(id);
    if (!card) return;
    const rec = state.loaded.get(id);
    card.classList.toggle('loaded', !!rec);
    const statusNode = card.querySelector('.local-imagery-status');
    if (statusNode) statusNode.textContent = rec ? '已加载' : '未加载';
    const btn = card.querySelector('.local-imagery-toggle');
    if (btn) btn.textContent = rec ? '移除' : '加载';
    const zoom = card.querySelector('.local-imagery-zoom');
    if (zoom) zoom.disabled = !rec;
  }

  function renderDataset(ds) {
    const card = document.createElement('div');
    card.className = 'local-imagery-card';
    card.setAttribute('data-local-imagery', ds.id || '');

    const head = document.createElement('div');
    head.className = 'local-imagery-head';
    const title = document.createElement('span');
    title.className = 'local-imagery-title';
    title.textContent = ds.name || ds.id || '本地影像';
    const statusNode = document.createElement('span');
    statusNode.className = 'local-imagery-status';
    statusNode.textContent = '未加载';
    head.appendChild(title);
    head.appendChild(statusNode);

    const meta = document.createElement('div');
    meta.className = 'local-imagery-meta';
    const parts = [];
    if (ds.minzoom != null && ds.maxzoom != null) parts.push('z' + ds.minzoom + '–' + ds.maxzoom);
    if (ds.note) parts.push(String(ds.note));
    meta.textContent = parts.join(' · ');

    const actions = document.createElement('div');
    actions.className = 'local-imagery-actions';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'local-imagery-toggle';
    toggleBtn.textContent = '加载';
    toggleBtn.addEventListener('click', function () { toggle(ds.id); });
    const zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'local-imagery-zoom subtle';
    zoomBtn.textContent = '定位';
    zoomBtn.disabled = true;
    zoomBtn.addEventListener('click', function () {
      const rec = state.loaded.get(ds.id);
      if (rec && rec.provider.rectangle) state.le.flyTo({ rectangle: rec.provider.rectangle });
    });
    actions.appendChild(toggleBtn);
    actions.appendChild(zoomBtn);

    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
  }

  function render() {
    if (!state.section) return;
    const has = state.datasets.length > 0;
    state.section.dataset.available = has ? '1' : '0';
    state.section.hidden = !has;
    if (!has) {
      refreshCount();
      if (window.LEsidebarNav && window.LEsidebarNav.refresh) window.LEsidebarNav.refresh();
      return;
    }
    if (state.listNode) {
      state.listNode.innerHTML = '';
      state.datasets.forEach(function (ds) {
        if (!ds || !ds.id) return;
        state.listNode.appendChild(renderDataset(ds));
      });
    }
    state.datasets.forEach(function (ds) {
      if (ds && ds.id) refreshCard(ds.id);
    });
    refreshCount();
    if (window.LEsidebarNav && window.LEsidebarNav.refresh) window.LEsidebarNav.refresh();
  }

  async function loadManifest() {
    let manifest = null;
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
      if (res.ok) {
        manifest = await res.json();
      }
    } catch (err) {
      console.info('[LELocalImagery] 未发现本地影像清单（可选）', err && err.message);
    }
    if (!manifest || !Array.isArray(manifest.datasets)) {
      state.datasets = [];
      state.manifestOk = false;
      render();
      return;
    }
    state.manifestOk = true;
    state.datasets = manifest.datasets.filter(function (ds) {
      return ds && ds.id && ds.url;
    });
    render();
    const auto = manifest.autoLoad !== false;
    if (!auto) return;
    for (const ds of state.datasets) {
      if (ds.autoLoad === false) continue;
      try {
        await load(ds.id, { fit: false, silent: true });
      } catch (err) {
        console.warn('[LELocalImagery] 自动加载失败：' + ds.id, err);
      }
    }
    if (state.loaded.size) {
      status('本地影像已自动加载：' + state.loaded.size + ' 个数据集（data/local/）');
    }
  }

  function init(le) {
    if (state.ready) return;
    state.le = le || window.LE;
    if (!state.le || !state.le.viewer) return;
    state.ready = true;
    // 【尽早装共享缓存】必须早于任何影像 provider 的第一次 requestImage，
    // 否则第一帧里重叠的瓦片已经被各层分别下载过一遍了。
    try {
      installSharedTileCache();
    } catch (err) {
      console.warn('[LELocalImagery] 共享瓦片缓存安装失败（不影响使用）', err);
    }
    state.section = byId('local-imagery-section');
    state.listNode = byId('local-imagery-list');
    state.countNode = byId('local-imagery-count');
    state.noteNode = byId('local-imagery-note');
    loadManifest();
  }

  /**
   * 重新读一次影像清单。
   *
   * 数据仓库入库后必须调它 —— 清单是启动时读的，
   * 运行期新写入的数据集不会自己出现（init() 已 ready 就直接返回了）。
   * 已经加载过的图层不受影响。
   */
  async function reload() {
    await loadManifest();
    return state.datasets.slice();
  }

  /* ------------------------------ 影像瓦片预取 ------------------------------
   *
   * 【用途】
   *   镜头移动前预热目标区域的影像瓦片：把瓦片**下载 + 解码**好放进共享缓存，
   *   等 Cesium 真正要那张瓦片时，共享缓存直接命中 → 那一帧立刻有图，
   *   不会先闪一片空白再慢慢补上。
   *
   * 【为什么放在这里而不是改 flyTo 调用点】
   *   flyTo 的调用点散落在地形/飞行/图层多个模块里，改它们容易和别人打架；
   *   而预取本质上只是「提前把 URL 塞进共享缓存」，做成一个独立的
   *   window.LEImagery.prefetch(rect, level) 能力，谁需要谁调用，互不干扰。
   *
   * 【为什么直接用 URL 模板而不是 provider】
   *   自带三层 s2cloudless（js/terrain.js）与本地影像（本文件）各有各的 provider，
   *   而它们请求的 URL 有重叠。预取时按**所有已加载影像 provider 的模板**算 URL，
   *   取并集，这样预热一次就同时喂饱多层 —— 共享缓存按 URL 归组，天然合并。
   */

  /** WebMercator：经纬度 → 该层级的瓦片行列范围。 */
  function tileRangeForRect(rect, level) {
    const n = Math.pow(2, level);
    const lon2x = function (lon) { return ((lon + 180) / 360) * n; };
    const lat2y = function (lat) {
      const s = Math.sin(Math.max(Math.min(lat, 85.05112878), -85.05112878) * Math.PI / 180);
      return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    };
    const x0 = Math.max(0, Math.floor(lon2x(rect.west)));
    const x1 = Math.min(n - 1, Math.floor(lon2x(rect.east)));
    const y0 = Math.max(0, Math.floor(lat2y(rect.north)));
    const y1 = Math.min(n - 1, Math.floor(lat2y(rect.south)));
    if (x1 < x0 || y1 < y0) return null;
    return { x0: x0, x1: x1, y0: y0, y1: y1 };
  }

  /**
   * 把一个 provider 的 URL 模板展开成某层级的具体 URL。
   *
   * 【为什么要自己拼而不是调 provider.requestImage】
   *   requestImage 会走 Cesium 的状态机（建 Imagery 实例、占纹理槽位…），
   *   预取阶段我们只想要「字节 + 解码结果」，不想在 Cesium 里插一堆用不到的瓦片。
   *   所以这里只做**模板替换**，再直接走 Resource.fetchImage（会自动进共享缓存）。
   */
  function expandTemplate(provider, level, x, y) {
    const tpl = provider && provider._resource && provider._resource.url;
    if (!tpl) return null;
    const tags = provider._tags;
    const values = {};
    // 复刻 Cesium 的 Fmt()：先按 provider 自己的标签函数取值，再替换占位符。
    const found = String(tpl).match(/{[^}]+}/g);
    if (found && tags) {
      for (const raw of found) {
        const name = raw.substring(1, raw.length - 1);
        if (typeof tags[name] === 'function') {
          try { values[name] = tags[name](provider, x, y, level); } catch (err) { /* ignore */ }
        }
      }
    }
    let url = String(tpl);
    for (const k of Object.keys(values)) {
      if (values[k] == null) continue;
      url = url.split('{' + k + '}').join(String(values[k]));
    }
    if (/[{]/.test(url)) return null;   // 还有没替换掉的占位符 → 拼不出来
    return url;
  }

  /**
   * 判断某个瓦片行列是否落在 provider 的覆盖范围内。
   *
   * 【为什么必须判】
   *   三层 s2cloudless 各有各的 rectangle（主 z≤7 / 宽域 z≤11 / 超清 z≤14），
   *   同一个 (x,y,level) 在主层是有效瓦片、在超清层可能**根本没有这个文件** → 404。
   *   实测：不做这个判断时，一次预热会产生 26 个 404（纯浪费往返）。
   *
   * @param {object} provider 影像 provider
   * @param {number} x 瓦片列
   * @param {number} y 瓦片行
   * @param {number} level 层级
   * @param {{x0,x1,y0,y1}} range 该层级的行列范围
   */
  function tileInProviderRect(provider, x, y, level, range) {
    // 层级上限：provider 声明的最大层级之外没有文件
    const maxLevel = provider.maximumLevel;
    if (typeof maxLevel === 'number' && isFinite(maxLevel) && level > maxLevel) return false;

    // 覆盖矩形：provider.rectangle 是 Cesium 的 Rectangle（弧度）
    const rect = provider.rectangle;
    if (!rect || typeof rect.getIntersection !== 'function') return true;
    try {
      const tileRect = provider.tilingScheme.tileXYToRectangle(x, y, level);
      if (!tileRect) return true;
      const inter = rect.getIntersection(tileRect);
      // 没有交集 → 完全不重叠 → 这个瓦片在覆盖范围外
      if (!inter) return false;
      // 交集面积比瓦片面积小很多 → 只是擦边，意义不大
      // （实测：擦到边的瓦片基本就是 404）
      const tileArea = tileRect.width * tileRect.height;
      if (tileArea > 0 && inter.width * inter.height < tileArea * 0.75) return false;
      return true;
    } catch (err) {
      return true;
    }
  }

  /**
   * 预取一个矩形区域的影像瓦片。
   *
   * @param {{west:number,south:number,east:number,north:number}} rect 经纬度矩形
   * @param {number} level 瓦片层级
   * @param {object} opts  { limit: 最多预取多少张, providers: 指定 provider 列表 }
   * @returns {Promise<{requested:number,ok:number,failed:number}>}
   */
  async function prefetch(rect, level, opts) {
    opts = opts || {};
    const le = state.le || window.LE;
    if (!le || !le.viewer || !rect || !isFinite(level)) return { requested: 0, ok: 0, failed: 0 };
    const lim = opts.limit != null ? opts.limit : 96;

    // 收集要预热的 provider：默认用所有已加载影像图层的 provider。
    const providers = opts.providers || (function () {
      const out = [];
      try {
        const layers = le.viewer.imageryLayers;
        for (let i = 0; i < layers.length; i++) {
          const l = layers.get(i);
          if (!l || !l.show) continue;
          const p = l.imageryProvider;
          if (p && p._resource && p._tags) out.push(p);
        }
      } catch (err) { /* ignore */ }
      return out;
    })();
    if (!providers.length) return { requested: 0, ok: 0, failed: 0 };

    const range = tileRangeForRect(rect, level);
    if (!range) return { requested: 0, ok: 0, failed: 0 };

    // 先按 provider 展开 URL，再按 URL 去重 —— 同一张瓦片被多层要时只预取一次。
    //
    // 【为什么要补前导斜杠】
    //   provider._resource.url 是**相对路径**（如 data/public/imagery/...）。
    //   Cesium 自己请求时交给 <img src> / XHR 解析，相对当前页面没问题；
    //   但 Resource.createIfNeeded 之后我们自己发请求时，
    //   浏览器会把它当成相对于**当前页面目录**的 URL ——
    //   页面在 /index.html 时，"data/..." 会被解析成 "/data/..."（少一级）→ 404。
    //   所以统一补成绝对路径 "/data/..."，和 Cesium 实际请求的 URL 一致。
    //
    // 【为什么要按 provider 分组 + 轮转取】
    //   limit 是「最多预取多少张」。如果直接对一个全局 URL 集合 slice，
    //   而集合是按 provider 顺序排的（蓝马赛克 → s2cloudless…），
    //   limit 一到就全被第一个 provider 占光，
    //   真正想预热的 s2cloudless 一张都轮不到
    //   （实测：requested=6, ok=0, failed=6，全是蓝马赛克且全是 404）。
    //   所以按 provider 分组，轮流取额度。
    const byProvider = [];
    const seen = new Set();
    for (const p of providers) {
      const group = [];
      for (let x = range.x0; x <= range.x1; x++) {
        for (let y = range.y0; y <= range.y1; y++) {
          // 【先判覆盖范围】provider 没覆盖到的瓦片根本不存在文件（404）
          if (!tileInProviderRect(p, x, y, level, range)) continue;
          let u = expandTemplate(p, level, x, y);
          if (!u) continue;
          if (u.charAt(0) !== '/' && !/^[a-z]+:\/\//i.test(u)) u = '/' + u;
          if (seen.has(u)) continue;
          seen.add(u);
          group.push(u);
        }
      }
      if (group.length) byProvider.push(group);
    }
    // 轮转取：第 1 轮每组取 1 张，第 2 轮每组再取 1 张…直到额度用完或取完
    const list = [];
    const maxLen = byProvider.reduce((a, g) => Math.max(a, g.length), 0);
    for (let i = 0; list.length < lim && i < maxLen; i++) {
      for (const g of byProvider) {
        if (list.length >= lim) break;
        if (i < g.length) list.push(g[i]);
      }
    }
    let ok = 0, failed = 0;
    // 限并发，别把服务端和浏览器一起压垮。
    // Background warming must leave slots for visible imagery. Explicit target
    // prefetch (e.g. import-and-fly) keeps its original scheduling contract.
    const CONC = opts.background ? 1 : 6;
    let idx = 0;
    async function worker() {
      while (idx < list.length) {
        if (opts.obsolete && opts.obsolete()) break;
        const u = list[idx++];
        try {
          // 【必须显式指定 RequestType.IMAGERY】
          //   Resource 的 Request 默认 type 是 OTHER（RequestType.OTHER=3），
          //   而共享缓存补丁只拦 IMAGERY —— 用默认 type 的话
          //   预取会**绕过**共享缓存，暖不了热（预取就白做了）。
          //
          // 【为什么用 new C.Resource 而不是 C.Resource.createIfNeeded】
          //   createIfNeeded(obj) 对「非字符串」入参**原样返回该对象**
          //   （Cesium 源码：typeof e !== "string" ? e : new Dt({url:e})），
          //   传对象进去拿到的不是 Resource，调用 fetchImage 直接抛
          //   "fetchImage is not a function"。所以这里必须 new。
          const res = await new C.Resource({
            url: u,
            request: new C.Request({ type: C.RequestType.IMAGERY }),
          }).fetchImage({
            preferImageBitmap: true,
            flipY: true,
          });
          if (res) ok++;
        } catch (err) {
          failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));
    return { requested: idx, ok: ok, failed: failed, urls: list.slice(0, idx) };
  }

  window.LEImagery = {
    /** 跨图层共享瓦片缓存的统计（探针 / 诊断）。 */
    tileCacheStats: tileCacheStats,
    /** 清空共享瓦片缓存。 */
    clearTileCache: clearTileCache,
    /** 预取矩形区域的影像瓦片（下载+解码进共享缓存）。 */
    prefetch: prefetch,
    /** 共享缓存是否已装上。 */
    isSharedCacheInstalled: function () {
      return !!(C && C.Resource && C.Resource.prototype.fetchImage && C.Resource.prototype.fetchImage.__sharedTileCache);
    },
  };

  window.LELocalImagery = {
    init: init,
    reload: reload,
    load: load,
    unload: unload,
    toggle: toggle,
    raiseAll: raiseAll,
    // 供时间轴模块复用：同一套 provider 构造逻辑（.jpg/.png 混合瓦片 + 透明 no-data 瓦片）。
    makeProvider: createProvider,
    // 取原始数据集对象（含 url / scheme / minzoom 等）—— 时间轴建 provider 要用。
    getDataset: dsById,
    getState: function () {
      return {
        manifest: state.manifestOk,
        datasets: state.datasets.map(function (ds) {
          return { id: ds.id, name: ds.name, loaded: state.loaded.has(ds.id), bounds: ds.bounds || null };
        }),
      };
    },
    list: function () { return this.getState().datasets; },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) { init((ev && ev.detail) || window.LE); }, { once: true });
})();

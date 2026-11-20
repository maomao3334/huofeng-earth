/*
 * 批量线渲染器（Static KML / KMZ 加速）
 * ---------------------------------------------------------------------------
 * 问题：旧实现对每一条 <LineString> 都建一个 Cesium Entity，且 positions 包装成
 * CallbackProperty —— Cesium 判定为「动态」折线，于是**每帧**都要重跑
 * generateCartesianArc 重新加密。十万级要素下：
 *   - 加载时创建十万个 Entity 对象；
 *   - 拖动时每帧 O(N) 的 updater，FPS 掉到个位数。
 * 这正是「KMZ 加载慢 + 拖动卡」的根本原因（docs/KML-PERF.md 有 2.4→60 FPS 的记录，
 * 但那次优化只覆盖了**动画**路径，静态 KMZ 一直没受益）。
 *
 * 方案：把同色同宽的折线聚合成少量 Cesium Primitive：
 *   - 一个 Primitive 承载成百上千条 GeometryInstance（共享同一种材质）；
 *   - 静态分支 → Cesium 一次性创建几何，无每帧 updater；
 *   - 贴地用「按地形高度抬升」实现（与既有 heightFor 逻辑一致，
 *     避免 GroundPolylinePrimitive 在无地形场景下的 surfaceDistance 崩溃）。
 *
 * 用法（由 kml-native.js 调用）：
 *   var batch = LEBatchLines.create(le, { ds, placemarks, getHeight });
 *   batch.applyVisibility(true);
 *   batch.redrape();          // 地形变化后重算贴地高度
 *   batch.dispose();
 */
(function () {
  'use strict';

  const C = window.Cesium;

  // 单个 Primitive 承载的最大 GeometryInstance 数。
  //
  // 【实测结论：这个值不是瓶颈，保持 32】
  //
  // 曾试过调到 512（把 10404 条线从 328 个 Primitive 压到 23 个），
  // 实测结果是**负收益**，已回退：
  //
  //   1) 每帧渲染成本完全没变：确定性计时（scene.render() 同步调用）
  //      两种配置都是 **2.5 ms/帧**，drawCommands 131。
  //      → 328 个 Primitive 的 CPU 开销本来就摊薄到看不见，
  //        减少 Primitive 数量换不到帧时间。
  //   2) 首次构建慢 3~8 倍：buildMs 2482.8 ms → **7667.2 ms**；
  //      单时间片最长阻塞 maxSliceMs 10.5 ms → **200.3 ms**
  //      （单帧堵 200 ms，正是用户抱怨的「卡顿」）。
  //      原因：单 Primitive 里合并 512 个 GeometryInstance 时，
  //      combineGeometry 阶段是同步的，实例越多越慢。
  //   3) 相机平移时出现过 Cesium「渲染中断」弹窗
  //      （RangeError: Invalid array length）。
  //      【更正】当时的结论「512 是首要嫌疑」是**错的**：
  //      那个 RangeError 来自**探针脚本自己**的 camera.rotate(angle, axis)
  //      参数顺序写反（Cesium 的签名是 axis 在前），与本文件的实例数无关。
  //      回退到 32 的真正理由是上面第 1、2 条：帧率没变、构建反而慢 3~8 倍。
  //      保留此注释是为了避免后人重复那个错误归因。
  //
  // 另注：kml-native.js 里「实例数 > 32 时 worker 永不返回」那条限制
  // 约束的是 **asynchronous: true（Web Worker）** 的实体折线路径；
  // 本文件全部走 `asynchronous: false`（主线程同步建几何），
  // 本身不受该限制约束 —— 但既然放大实例数毫无收益，就没必要去碰它。
  const MAX_INSTANCES_PER_PRIMITIVE = 32;

  // 每个分组最多容纳多少条线（同一材质）
  const MAX_LINES_PER_GROUP = 20000;

  /**
   * 单个时间片里最多处理多少条线，之后让出主线程。
   *
   * 【为什么必须分片】旧实现 buildChunks() 是**完全同步**的：
   * 上万个 KMZ 要素（实测 10404 条线 / 52020 个顶点）一次性建完，
   * 其中 52,020 次贴地取高把主线程堵死 36.9 s —— 浏览器在这段时间内
   * 既不渲染也不响应输入，用户看到的就是「导入卡死 / 报超时」，
   * 同时地形瓦片也无法构建（主线程被占），贴地因此算在错误的表面上。
   * 分片后每片只占几毫秒，地形可以在间隙里继续加载。
   */
  const LINES_PER_SLICE = 400;

  /**
   * 一轮构建里最多允许多少次 globe.getHeight 射线拾取。
   *
   * getHeight 实测 ~2 ms/次（要做一次射线求交），而解析 DEM 只要 0.4 µs ——
   * 差 5000 倍。地形就绪后渲染网格采样 100% 命中，压根用不上 getHeight；
   * 只有「地形还没建好」的导入阶段才会用到，那时它又慢又不可信
   * （瓦片未就绪时返回 −2368 m 垃圾值）。
   *
   * 所以给一个很小的上限：它只用来把少量「刚好落在瓦片缝隙里的点」补准，
   * 绝大多数点直接走解析 DEM；等地形就绪后由重贴地统一校正到渲染面。
   * 实测把上限从 2000 降到 200，构建耗时 4.64 s → 约 1 s。
   */
  const GH_BUDGET = 200;

  /**
   * 让出主线程：优先 MessageChannel（无 setTimeout 4ms 钳制），回退 setTimeout(0)。
   * 与 kml-native.js 里的同名函数保持一致。
   */
  function yieldToMain() {
    return new Promise(function (resolve) {
      if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel();
        channel.port1.onmessage = function () {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(0);
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  /**
   * 线的视觉分组键：颜色 + 线宽。
   * 相同键的线合并进同一个 Primitive（共享材质），大幅减少绘制调用。
   */
  function groupKey(style, width) {
    const c = (style && style.line && style.line.color) || C.Color.WHITE;
    return (
      c.red.toFixed(3) + ',' +
      c.green.toFixed(3) + ',' +
      c.blue.toFixed(3) + ',' +
      c.alpha.toFixed(3) + '|' +
      (width || 1).toFixed(2)
    );
  }

  /**
   * 创建批量线渲染器。
   *
   * @param {object} le        全局 LE 对象
   * @param {object} opts
   *   opts.placemarks  KML 文档模型里的 placemark 数组
   *   opts.heightFor   (lon, lat) → 高程（米）的取高函数；缺省用 window.LE.heightAt
   *   opts.minPixels   最小线宽（像素）
   */
  function create(le, opts) {
    opts = opts || {};
    const placemarks = opts.placemarks || [];
    const heightFor = opts.heightFor || function (lon, lat) {
      const h = window.LE && typeof window.LE.heightAt === 'function' ? window.LE.heightAt(lon, lat) : 0;
      return isFinite(h) ? h : 0;
    };
    const minWidth = opts.minPixels || 1;
    // KML 高度语义换算（尊重 altitudeMode / alt）；缺省时用旧的「地面 + 1 m」
    const heightForKml = opts.heightForKml || (
      window.LEDraping && typeof window.LEDraping.heightForKml === 'function'
        ? window.LEDraping.heightForKml
        : null
    );

    /** @type {Array<{key:string, width:number, color:C.Color, lines:Array<{coords:Array}>}>} */
    const groups = [];
    const groupIndex = Object.create(null);
    let skipped = 0;
    let totalLines = 0;

    // ---- 1) 收集并分组 ----
    for (let i = 0; i < placemarks.length; i++) {
      const pm = placemarks[i];
      if (!pm || !pm.visible) continue;
      const style = pm.style;
      const lineStyle = style && style.line;
      const color = (lineStyle && lineStyle.color) || C.Color.WHITE;
      const rawWidth = lineStyle && isFinite(lineStyle.width) ? lineStyle.width : 1;
      const width = Math.max(minWidth, rawWidth);
      const key = groupKey(style, width);

      let group = groupIndex[key];
      if (!group) {
        group = { key: key, width: width, color: color, lines: [] };
        groupIndex[key] = group;
        groups.push(group);
      }
      if (group.lines.length >= MAX_LINES_PER_GROUP) {
        skipped++;
        continue;
      }
      for (let g = 0; g < pm.geometries.length; g++) {
        const geometry = pm.geometries[g];
        if (!geometry || geometry.type !== 'line') continue;
        const coords = geometry.coords;
        if (!coords || coords.length < 2) continue;
        // 保留每个几何的 altitudeMode / alt —— KML 里 relativeToGround 且带高程
        // 的线必须按「地面 + alt」贴地，否则会沉到地下或浮在空中。
        group.lines.push({
          coords: coords,
          altitudeMode: geometry.altitudeMode || 'clampToGround',
        });
        totalLines++;
      }
    }

    if (!totalLines) {
      return {
        count: 0,
        groups: groups.length,
        applyVisibility: function () {},
        redrape: function () {},
        dispose: function () {},
      };
    }

    // ---- 2) 为每条线计算贴地高度（一次算好，之后不再逐帧采样） ----
    // 每条线存 { positions: Cartesian3[] }，贴地高度变化时整体重算。
    const prepared = groups.map(function (group) {
      return { group: group, chunks: [] };
    });

    const state = {
      viewer: le.viewer,
      containers: [],   // 每个批次一个 PrimitiveCollection
      visible: true,
      redrapeTimer: null,
      buildGen: 0,      // 构建世代号：分片构建是异步的，用它淘汰过期的那一轮
      lastStats: { lines: 0, primitives: 0, buildMs: 0 },
    };

    /**
     * 计算一条线的贴地 Cartesian3 位置序列。
     * 高度语义与 kml-native.js 的 heightFor 一致：优先按 altitudeMode/alt
     * （relativeToGround → 地面 + alt；absolute → alt；clampToGround → 地面 + ε），
     * 地面高度来自 LEDraping（渲染网格真值），保证与用户看到的起伏面一致。
     */
    function positionsOf(line) {
      const coords = line.coords;
      const mode = line.altitudeMode;
      const out = new Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        let h;
        if (heightForKml) {
          h = heightForKml(c.lon, c.lat, mode, c.alt);
        } else {
          const ground = heightFor(c.lon, c.lat);
          h = (isFinite(ground) ? ground : 0) + 1;
        }
        if (!isFinite(h)) h = 0;
        out[i] = C.Cartesian3.fromDegrees(c.lon, c.lat, h);
      }
      return out;
    }

    /**
     * 构建全部 Primitive。
     *
     * 【改为异步分片】原实现是同步一次性建完，实测 10404 条线时产生
     * 一个 36.9 s 的长任务：主线程被完全占住，浏览器既不渲染也不响应输入，
     * 用户看到「导入卡死 / 报超时」；地形瓦片也无法在这段时间里构建，
     * 于是贴地高度是在「地形尚未就绪」的表面上算出来的 —— 整片沉到地下。
     *
     * 现在按 LINES_PER_SLICE 分片，每片之间让出主线程：
     *   - 单个长任务降到几毫秒，界面始终可响应；
     *   - 地形能在间隙里继续加载；
     *   - 贴地分批推进，后半程自动用上已经就绪的瓦片。
     */
    async function buildChunks() {
      const t0 = performance.now();
      // 【并发保护】分片构建是异步的，可能与下一轮 redrape 重叠。
      // 用世代号让过期的那一轮自行放弃，避免两轮同时往场景里塞 Primitive。
      const gen = ++state.buildGen;
      // 清理旧批次
      for (let i = 0; i < state.containers.length; i++) {
        try { state.viewer.scene.primitives.remove(state.containers[i]); } catch (err) { /* ignore */ }
      }
      state.containers = [];
      pending = [];
      let primitiveCount = 0;
      let lineCount = 0;
      let slices = 0;
      let maxSliceMs = 0;

      // 限额 getHeight：本轮最多做 GH_BUDGET 次昂贵的射线拾取，
      // 超出就回退解析 DEM。实测地形就绪后网格采样 100% 命中，
      // getHeight 根本用不上；限额只是给「地形还没建好」的阶段兜底，
      // 避免几万次 × 2 ms 把主线程拖死。
      const draping = window.LEDraping;
      if (draping && typeof draping.beginBatch === 'function') draping.beginBatch(GH_BUDGET);

      // 把所有分组的线摊平成一个待处理队列（保持分组顺序：同材质的放一起）
      const queue = [];
      for (let gi = 0; gi < prepared.length; gi++) {
        const group = prepared[gi].group;
        for (let li = 0; li < group.lines.length; li++) {
          queue.push({ group: group, line: group.lines[li] });
        }
      }

      const total = queue.length;
      let processed = 0;
      while (processed < total) {
        if (gen !== state.buildGen) {
          // 已被新一轮构建取代 → 放弃本轮
          if (draping && typeof draping.endBatch === 'function') draping.endBatch();
          return { lines: lineCount, primitives: primitiveCount, aborted: true };
        }
        const sliceStart = performance.now();
        const sliceEnd = Math.min(processed + LINES_PER_SLICE, total);
        for (; processed < sliceEnd; processed++) {
          const item = queue[processed];
          const group = item.group;
          const positions = positionsOf(item.line);
          if (positions.length < 2) continue;
          const colors = new Array(positions.length);
          for (let k = 0; k < colors.length; k++) colors[k] = group.color.withAlpha(group.color.alpha);
          const instance = new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions: positions,
              width: group.width,
              colors: colors,
              vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
            }),
          });
          // 攒够一个 Primitive 的实例数、或到了分组末尾就提交
          pending.push({ group: group, instance: instance });
          lineCount++;
          if (pending.length >= MAX_INSTANCES_PER_PRIMITIVE || isLastOfGroup(queue, processed)) {
            primitiveCount += flushPending();
          }
        }
        slices++;
        const sliceMs = performance.now() - sliceStart;
        if (sliceMs > maxSliceMs) maxSliceMs = sliceMs;
        if (processed < total) {
          await yieldToMain();
        }
      }
      primitiveCount += flushPending();

      if (gen !== state.buildGen) {
        if (draping && typeof draping.endBatch === 'function') draping.endBatch();
        return { lines: lineCount, primitives: primitiveCount, aborted: true };
      }
      if (draping && typeof draping.endBatch === 'function') draping.endBatch();

      state.lastStats = {
        lines: lineCount,
        primitives: primitiveCount,
        buildMs: Math.round((performance.now() - t0) * 10) / 10,
        slices: slices,
        maxSliceMs: Math.round(maxSliceMs * 10) / 10,
        skipped: skipped,
      };
      console.debug('[LEBatchLines] 批量线渲染：' + JSON.stringify(state.lastStats));
      return state.lastStats;
    }

    /** 待提交的 Primitive 实例缓冲（同组同材质的连续实例合并到一个 Primitive）。 */
    let pending = [];

    function isLastOfGroup(queue, index) {
      if (index + 1 >= queue.length) return true;
      return queue[index + 1].group !== queue[index].group;
    }

    /** 提交缓冲里的实例，返回成功加入场景的 Primitive 数。 */
    function flushPending() {
      if (!pending.length) return 0;
      const group = pending[0].group;
      const instances = pending.map(function (p) { return p.instance; });
      pending = [];
      let primitive;
      try {
        primitive = new C.Primitive({
          geometryInstances: instances,
          appearance: new C.PolylineColorAppearance({ translucent: true }),
          // 明确禁用 worker 异步创建：实测大批实例时 worker 长时间不返回，
          // 折线永远不 ready（kml-native.js 里有同样记录）。
          asynchronous: false,
          releaseGeometryInstances: false,
        });
      } catch (err) {
        console.warn('[LEBatchLines] Primitive 创建失败，回退该批次：', err);
        return 0;
      }
      const collection = new C.PrimitiveCollection();
      collection.add(primitive);
      try {
        state.viewer.scene.primitives.add(collection);
      } catch (err) {
        console.warn('[LEBatchLines] PrimitiveCollection 添加失败：', err);
        return 0;
      }
      state.containers.push(collection);
      return 1;
    }

    // 首次构建（异步分片）。返回一个 Promise，调用方可 await。
    const firstBuild = buildChunks().then(function (stats) {
      state.lastChecksum = heightsChecksum();
      state.lastBuildAt = performance.now();
      return stats;
    }).catch(function (err) {
      console.warn('[LEBatchLines] 首次构建失败：', err);
      return { lines: 0, primitives: 0, error: String((err && err.message) || err) };
    });

    /**
     * 地形就绪检测器。
     *
     * 【为什么不做在这里】地形级别的重贴地由 terrain.js 的全局监听负责
     * （bindTerrainSettled），它同时覆盖批量线与实体两条路径。若这里再监听一遍，
     * 一次地形加载波就会触发两轮重建 —— 实测 90 s 内重建了 11 次，
     * 白白多花 19 s 主线程时间。
     *
     * 【节流】即便由全局监听驱动，重建也要限流：地形是**流式**加载的，
     * 每加载完一批瓦片就会再次「就绪」，若每次都重建，328 个 Primitive
     * 会被反复重造。因此这里设定最短重建间隔，并在高度没变时直接跳过。
     */
    const MIN_REBUILD_INTERVAL_MS = 4000;

    /**
     * 采样校验和：用于判断「地形变了没有」。
     *
     * 【必须跨分组采样】旧实现按顺序取前 N 个坐标，而前 N 个坐标全都落在
     * **第一个分组**（同一颜色）里 —— 那个分组恰好落在已渲染瓦片覆盖之外，
     * 于是它的高度永远走「解析 DEM」兜底、永远不变。校验和因此恒定，
     * 地形明明变了却判定为「没变」而跳过重建 —— 这正是贴地高度停留在
     * 旧值（偏差 60~280 m）的原因。
     *
     * 现在每个分组各取若干点，覆盖整个数据范围。
     */
    function heightsChecksum(limit) {
      const perGroup = Math.max(1, Math.min(limit || 12, 12));
      let sum = 0;
      let count = 0;
      for (const group of groups) {
        const lines = group.lines;
        if (!lines.length) continue;
        // 每个分组均匀取 perGroup 条线的首个顶点
        const stride = Math.max(1, Math.floor(lines.length / perGroup));
        let taken = 0;
        for (let i = 0; i < lines.length && taken < perGroup; i += stride) {
          const line = lines[i];
          const c = line.coords && line.coords[0];
          if (!c) continue;
          const h = heightForKml
            ? heightForKml(c.lon, c.lat, line.altitudeMode, c.alt)
            : (heightFor(c.lon, c.lat) + 1);
          if (isFinite(h)) sum += h;
          count++;
          taken++;
        }
      }
      return count ? Math.round(sum * 1000) / 1000 : 0;
    }

    function scheduleRedrape(delay) {
      if (state.redrapeTimer) clearTimeout(state.redrapeTimer);
      state.redrapeTimer = setTimeout(function () {
        state.redrapeTimer = null;
        // 限流：距上次重建不足 MIN_REBUILD_INTERVAL_MS 就推迟，
        // 避免地形流式加载时反复重造 328 个 Primitive。
        const wait = Math.max(0, (state.lastBuildAt || 0) + MIN_REBUILD_INTERVAL_MS - performance.now());
        if (wait > 0) {
          scheduleRedrape(wait);
          return;
        }
        // 高度没变就不必重建（重建要重造全部 Primitive，代价比采样高得多）
        const checksum = heightsChecksum();
        if (checksum === state.lastChecksum && state.containers.length) {
          state.lastSkipped = (state.lastSkipped || 0) + 1;
          return;
        }
        state.lastChecksum = checksum;
        state.lastBuildAt = performance.now();
        // 地形换级后瓦片索引失效，先让采样器重建索引再贴地
        if (window.LEDraping && typeof window.LEDraping.invalidate === 'function') {
          try {
            window.LEDraping.invalidate();
          } catch (err) { /* ignore */ }
        }
        buildChunks().then(function (stats) {
          if (stats && !stats.aborted) {
            state.lastChecksum = heightsChecksum();
          }
        }).catch(function (err) {
          console.warn('[LEBatchLines] 重建失败：', err);
        });
      }, delay == null ? 220 : delay);
    }

    return {
      get count() { return state.lastStats.lines; },
      get primitives() { return state.lastStats.primitives; },
      get groups() { return groups.length; },
      stats: function () { return state.lastStats; },
      ready: function () { return firstBuild; },

      /**
       * 调试/回归用：返回前 N 个顶点的贴地高度与所在经纬度。
       * 用来验证「线确实贴在渲染面上」，而不是埋在地下。
       */
      sampleHeights: function (limit) {
        const n = Math.min(limit || 500, 500);
        const out = [];
        for (const group of groups) {
          for (const line of group.lines) {
            for (const c of line.coords) {
              if (out.length >= n) return out;
              const h = heightForKml
                ? heightForKml(c.lon, c.lat, line.altitudeMode, c.alt)
                : (heightFor(c.lon, c.lat) + 1);
              out.push({ lon: c.lon, lat: c.lat, h: h, mode: line.altitudeMode, alt: c.alt });
            }
          }
        }
        return out;
      },

      applyVisibility: function (on) {
        state.visible = !!on;
        for (let i = 0; i < state.containers.length; i++) {
          try { state.containers[i].show = state.visible; } catch (err) { /* ignore */ }
        }
      },

      /**
       * 地形变化（开关地形 / 调夸张 / 换 DEM 层级）后重算贴地高度。
       * 节流合并连续调用，避免拖动夸张滑杆时反复重建。
       */
      redrape: function () {
        scheduleRedrape(220);
      },

      dispose: function () {
        if (state.redrapeTimer) clearTimeout(state.redrapeTimer);
        for (let i = 0; i < state.containers.length; i++) {
          try { state.viewer.scene.primitives.remove(state.containers[i]); } catch (err) { /* ignore */ }
        }
        state.containers = [];
      },
    };
  }

  window.LEBatchLines = {
    create: create,
    MAX_INSTANCES_PER_PRIMITIVE: MAX_INSTANCES_PER_PRIMITIVE,
  };
})();

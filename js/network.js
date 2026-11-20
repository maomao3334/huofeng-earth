/*
 * 网络分析内核（纯计算，不依赖 Cesium / DOM）
 * ---------------------------------------------------------------------------
 * P3-4.16「网络分析（最短路 / 服务区）」的内核部分。
 *
 * 【对标 QGIS 的什么】
 *   QGIS 的「网络分析」库（QgsNetworkAnalysis）里最常用的两条：
 *     · 最短路径     —— QgsGraphAnalyzer / QgsGraphBuilder（把线要素做成图再跑 Dijkstra）
 *     · 服务区 / 等时圈 —— 从起点按"通行成本"泛洪，圈出可达范围
 *   以及 GRASS v.net 的 shortest_path / net.streach。
 *
 * 【为什么自己写】
 *   用户的硬约束是纯离线、浏览器内跑、不依赖外部进程
 *   （QGIS 的 networkanalysis 库是 C++ 的，不能引入）。
 *   图算法本身就是纯数学，自己写反而更轻：一个上千节点的图最短路是毫秒级。
 *
 * 【网络是怎么建出来的】
 *   1. 线要素（绘制要素 / 导入的矢量图层）拆成线段；
 *   2. 线段两两求交（用空间网格筛候选对，避免 O(n²) 全比）；
 *   3. 交点处打断（split），成为图节点；
 *   4. 端点 / 交点去重（按坐标量化到 1e-9 度）成为节点；
 *   5. 相邻节点之间的段成为边，边权 = 大地线长度（米）。
 *
 *   单行道：要素属性里 oneway / 单向 / Oneway = true / yes / 1 的，边只允许 a→b。
 *
 * 【起终点不一定要落在节点上 —— 办法是"把边劈开"】
 *   用户在地图上点一下的位置往往落在某条边中间。
 *   做法：把那条边在点所在的位置劈成两条，劈出来的点成为一个**真节点**，
 *   起点节点距离 = 0，终点节点就是路径终点。
 *   这样单行道也能正确处理（劈开后 start→next 一段仍是同向的）。
 *   每次计算都在**图的副本**上劈，原图不被污染。
 *
 * 【服务区怎么算】
 *   1. Dijkstra 得到每个节点的通行成本 dist[]；
 *   2. 沿每条边按格距采样，算出每个采样点的"网络成本"；
 *   3. 把采样点成本作为种子，灌进一个 8 邻域的网格 Dijkstra
 *      （chamfer / 快速行进），格点之间的权重是真实大地线距离；
 *   4. 格点成本 = min(到某个网络点的网络成本 + 直线距离)，
 *      这正是服务区的定义式；
 *   5. 成本 <= 阈值的格点即可达，二值掩膜抽环得到服务区多边形。
 *
 * 【对外 API（window.LENetwork = module.exports）】
 *   几何：haversineM / segIntersect / pointOnSegDist
 *   建图：buildGraph / cloneGraph / splitEdgeAt / snapToNetwork / graphSummary
 *   寻路：dijkstra / shortestPath
 *   服务区：serviceArea / edgeCostAt / traceRings
 *   导出：pathToGeoJSON / serviceAreaToGeoJSON
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LENetwork = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 常量
   * ================================================================ */

  const R_EARTH = 6378137;          // 米
  const DEG = Math.PI / 180;
  const M_PER_DEG = 111319.4908;   // 赤道上 1 度 ≈ 111.3 km

  const NODE_KEY_PRECISION = 1e-9; // 节点坐标量化（度）
  const SPLIT_T_EPS = 1e-7;        // 打断参数去重容差
  const DEFAULT_GRID = 200;        // 服务区网格目标格数（长边）
  const MAX_CELLS = 900000;        // 服务区网格上限（格）
  const CELLS_PER_RADIUS = 12;     // 阈值半径内至少多少格

  /* ================================================================
   * 基础几何
   * ================================================================ */

  /** 两点大地线距离（米）。 */
  function haversineM(lon1, lat1, lon2, lat2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R_EARTH * c;
  }

  /**
   * 点 a 到线段 b→c 的最短距离（米）与人行道上的投影点。
   */
  function pointOnSegDist(a, b, c) {
    const lat0 = b.lat * DEG;
    const kx = M_PER_DEG * Math.cos(lat0);
    const ky = M_PER_DEG;
    const x0 = b.lon * kx, y0 = b.lat * ky;
    const x1 = c.lon * kx, y1 = c.lat * ky;
    const ax = a.lon * kx, ay = a.lat * ky;
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) {
      t = ((ax - x0) * dx + (ay - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const px = x0 + t * dx, py = y0 + t * dy;
    const d = Math.sqrt((ax - px) * (ax - px) + (ay - py) * (ay - py));
    return {
      distM: d,
      t: t,
      lon: b.lon + (c.lon - b.lon) * t,
      lat: b.lat + (c.lat - b.lat) * t,
      segLenM: Math.sqrt(len2),
    };
  }

  /**
   * 线段求交（真交点）。平行或共线返回 null。
   * @returns {null | {lon, lat, t, u}}
   */
  function segIntersect(a, b, c, d) {
    const rx = b.lon - a.lon, ry = b.lat - a.lat;
    const sx = d.lon - c.lon, sy = d.lat - c.lat;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-18) return null;   // 平行或共线
    const qpx = c.lon - a.lon, qpy = c.lat - a.lat;
    const t = (qpx * sy - qpy * sx) / den;
    const u = (qpx * ry - qpy * rx) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    const lon = a.lon + rx * t;
    const lat = a.lat + ry * t;
    if (!isFinite(lon) || !isFinite(lat)) return null;
    return { lon: lon, lat: lat, t: t, u: u };
  }

  /** 节点坐标量化键。 */
  function nodeKey(lon, lat) {
    return lon.toFixed(9) + '|' + lat.toFixed(9);
  }

  /* ================================================================
   * 单行道
   * ================================================================ */

  function isOneway(props) {
    if (!props) return false;
    const keys = ['oneway', 'OneWay', 'Oneway', 'ONEWAY', '单向', '单行'];
    for (const k of keys) {
      const v = props[k];
      if (v === true || v === 1) return true;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'yes' || s === 'true' || s === '1' || s === '是' || s === '单向') return true;
      }
    }
    return false;
  }

  /** 判断一个要素是否参与网络（线 / 面）。 */
  function isNetworkFeature(f) {
    return !!f && (f.type === 'line' || f.type === 'polygon') &&
      Array.isArray(f.points) && f.points.length >= 2;
  }

  /* ================================================================
   * 建图
   * ================================================================ */

  /**
   * 把线要素建成图。
   * @param {Array} features [{id,name,type:'line'|'polygon',points:[{lon,lat}],props}]
   */
  function buildGraph(features) {
    const segs = [];
    (features || []).forEach(function (f) {
      if (!isNetworkFeature(f)) return;
      const pts = f.points;
      const n = pts.length;
      const closed = f.type === 'polygon';
      const count = closed ? n : n - 1;
      const oneway = isOneway(f.props);
      for (let i = 0; i < count; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (!a || !b) continue;
        if (a.lon === b.lon && a.lat === b.lat) continue;
        segs.push({
          a: { lon: a.lon, lat: a.lat },
          b: { lon: b.lon, lat: b.lat },
          feat: f,
          oneway: oneway,
        });
      }
    });

    /* --- ① 求交：空间网格分桶，只比同桶的线段 --- */
    const splits = segs.map(function () { return []; });
    if (segs.length > 1) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      segs.forEach(function (s) {
        minLon = Math.min(minLon, s.a.lon, s.b.lon);
        maxLon = Math.max(maxLon, s.a.lon, s.b.lon);
        minLat = Math.min(minLat, s.a.lat, s.b.lat);
        maxLat = Math.max(maxLat, s.a.lat, s.b.lat);
      });
      const cell = Math.max((maxLon - minLon) / 64, (maxLat - minLat) / 64, 1e-7);
      const buckets = new Map();
      segs.forEach(function (s, idx) {
        const x0 = Math.floor(Math.min(s.a.lon, s.b.lon) / cell);
        const x1 = Math.floor(Math.max(s.a.lon, s.b.lon) / cell);
        const y0 = Math.floor(Math.min(s.a.lat, s.b.lat) / cell);
        const y1 = Math.floor(Math.max(s.a.lat, s.b.lat) / cell);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const k = cx + ',' + cy;
            let arr = buckets.get(k);
            if (!arr) { arr = []; buckets.set(k, arr); }
            arr.push(idx);
          }
        }
      });
      const done = new Set();
      buckets.forEach(function (arr) {
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const i1 = arr[i], i2 = arr[j];
            const pk = i1 < i2 ? i1 + ':' + i2 : i2 + ':' + i1;
            if (done.has(pk)) continue;
            done.add(pk);
            const s1 = segs[i1], s2 = segs[i2];
            const hit = segIntersect(s1.a, s1.b, s2.a, s2.b);
            if (!hit) continue;
            splits[i1].push({ t: hit.t, lon: hit.lon, lat: hit.lat });
            splits[i2].push({ t: hit.u, lon: hit.lon, lat: hit.lat });
          }
        }
      });
    }

    /* --- ② 打断 + 建节点/边 --- */
    const nodes = [];
    const nodeIndex = new Map();
    function addNode(lon, lat) {
      const k = nodeKey(lon, lat);
      let idx = nodeIndex.get(k);
      if (idx === undefined) {
        idx = nodes.length;
        nodes.push({ id: idx, lon: lon, lat: lat });
        nodeIndex.set(k, idx);
      }
      return idx;
    }

    const edges = [];
    segs.forEach(function (s, idx) {
      const list = splits[idx].slice().sort(function (p, q) { return p.t - q.t; });
      const uniq = [];
      list.forEach(function (p) {
        const last = uniq[uniq.length - 1];
        if (last && Math.abs(p.t - last.t) < SPLIT_T_EPS) return;
        uniq.push(p);
      });
      const chain = [{ t: 0, lon: s.a.lon, lat: s.a.lat }]
        .concat(uniq)
        .concat([{ t: 1, lon: s.b.lon, lat: s.b.lat }]);
      for (let k = 0; k + 1 < chain.length; k++) {
        const p0 = chain[k], p1 = chain[k + 1];
        const len = haversineM(p0.lon, p0.lat, p1.lon, p1.lat);
        if (!(len > 0)) continue;
        const a = addNode(p0.lon, p0.lat);
        const b = addNode(p1.lon, p1.lat);
        if (a === b) continue;
        edges.push({
          id: edges.length,
          a: a,
          b: b,
          len: len,
          oneway: s.oneway,
          featId: s.feat.id,
          featName: s.feat.name,
          pts: [
            { lon: p0.lon, lat: p0.lat },
            { lon: p1.lon, lat: p1.lat },
          ],
        });
      }
    });

    const graph = {
      nodes: nodes,
      edges: edges,
      features: (features || []).filter(isNetworkFeature),
      bbox: bboxOfNodes(nodes),
    };
    graph.adj = buildAdj(graph);
    return graph;
  }

  function bboxOfNodes(nodes) {
    if (!nodes.length) return null;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    nodes.forEach(function (n) {
      west = Math.min(west, n.lon); east = Math.max(east, n.lon);
      south = Math.min(south, n.lat); north = Math.max(north, n.lat);
    });
    return { west: west, south: south, east: east, north: north };
  }

  /** 邻接表。单向边只加 a→b。 */
  function buildAdj(graph) {
    const adj = graph.nodes.map(function () { return []; });
    graph.edges.forEach(function (e) {
      adj[e.a].push({ to: e.b, edge: e.id, len: e.len });
      if (!e.oneway) adj[e.b].push({ to: e.a, edge: e.id, len: e.len });
    });
    return adj;
  }

  /** 复制一份图（计算时在副本上劈边，不污染原图）。 */
  function cloneGraph(graph) {
    const g = {
      nodes: graph.nodes.map(function (n) { return { id: n.id, lon: n.lon, lat: n.lat }; }),
      edges: graph.edges.map(function (e) {
        return {
          id: e.id, a: e.a, b: e.b, len: e.len, oneway: e.oneway,
          featId: e.featId, featName: e.featName,
          pts: e.pts.map(function (p) { return { lon: p.lon, lat: p.lat }; }),
        };
      }),
      features: graph.features,
      bbox: graph.bbox,
    };
    g.adj = buildAdj(g);
    return g;
  }

  /** 图概况。 */
  function graphSummary(graph) {
    if (!graph) return { nodes: 0, edges: 0, lengthM: 0, features: 0 };
    let len = 0;
    graph.edges.forEach(function (e) { len += e.len; });
    return {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      lengthM: len,
      features: graph.features.length,
    };
  }

  /* ================================================================
   * 边上的点
   * ================================================================ */

  /** 边按里程取点（里程从节点 a 起算）。 */
  function edgePointAt(e, s) {
    const pts = e.pts;
    if (pts.length === 1) return { lon: pts[0].lon, lat: pts[0].lat };
    if (pts.length === 2) {
      const t = e.len > 0 ? Math.max(0, Math.min(1, s / e.len)) : 0;
      return {
        lon: pts[0].lon + (pts[1].lon - pts[0].lon) * t,
        lat: pts[0].lat + (pts[1].lat - pts[0].lat) * t,
      };
    }
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      const segLen = haversineM(p.lon, p.lat, q.lon, q.lat);
      if (acc + segLen >= s || i + 2 === pts.length) {
        const t = segLen > 0 ? Math.max(0, Math.min(1, (s - acc) / segLen)) : 0;
        return {
          lon: p.lon + (q.lon - p.lon) * t,
          lat: p.lat + (q.lat - p.lat) * t,
        };
      }
      acc += segLen;
    }
    const last = pts[pts.length - 1];
    return { lon: last.lon, lat: last.lat };
  }

  /**
   * 把边在里程 s 处劈成两段，劈点成为一个新节点。
   * @returns {Number} 新节点索引
   */
  function splitEdgeAt(graph, edgeId, s) {
    const e = graph.edges[edgeId];
    if (!e) return -1;
    if (s <= 1e-6) return e.a;
    if (s >= e.len - 1e-6) return e.b;

    const p = edgePointAt(e, s);
    // 找已有节点（量化后可能已经存在）
    let nodeIdx = -1;
    for (let i = 0; i < graph.nodes.length; i++) {
      if (Math.abs(graph.nodes[i].lon - p.lon) < 1e-9 &&
          Math.abs(graph.nodes[i].lat - p.lat) < 1e-9) { nodeIdx = i; break; }
    }
    if (nodeIdx < 0) {
      nodeIdx = graph.nodes.length;
      graph.nodes.push({ id: nodeIdx, lon: p.lon, lat: p.lat });
    }

    const tail = e.pts[e.pts.length - 1];
    const headLen = s;
    const tailLen = e.len - s;
    // 原边改成 a → 新节点
    e.pts = [e.pts[0], { lon: p.lon, lat: p.lat }];
    e.len = headLen;
    // 新增边 新节点 → b
    graph.edges.push({
      id: graph.edges.length,
      a: nodeIdx,
      b: e.b,
      len: tailLen,
      oneway: e.oneway,
      featId: e.featId,
      featName: e.featName,
      pts: [{ lon: p.lon, lat: p.lat }, { lon: tail.lon, lat: tail.lat }],
    });
    graph.adj = buildAdj(graph);
    return nodeIdx;
  }

  /* ================================================================
   * 贴边
   * ================================================================ */

  /**
   * 把一个点贴到网络最近的边上。
   * @returns {null | {lon,lat,edgeId,s,distM,lenM}}
   */
  function snapToNetwork(graph, lon, lat, opts) {
    if (!graph || !graph.edges.length) return null;
    const o = opts || {};
    const maxDist = o.maxDistM != null ? o.maxDistM : Infinity;
    let best = null;
    for (const e of graph.edges) {
      let acc = 0;
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const p = e.pts[i], q = e.pts[i + 1];
        const r = pointOnSegDist({ lon: lon, lat: lat }, p, q);
        const s = acc + r.t * r.segLenM;
        if (!best || r.distM < best.distM) {
          best = { lon: r.lon, lat: r.lat, edgeId: e.id, s: s, distM: r.distM, lenM: e.len };
        }
        acc += r.segLenM;
      }
    }
    if (!best) return null;
    if (best.distM > maxDist) return null;
    return best;
  }

  /* ================================================================
   * Dijkstra
   * ================================================================ */

  /** 极简二叉堆（按 pri 排序）。 */
  function Heap() {
    this.a = [];
  }
  Heap.prototype.push = function (item, pri) {
    const a = this.a;
    a.push({ item: item, pri: pri });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].pri <= a[i].pri) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };
  Heap.prototype.pop = function () {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].pri < a[m].pri) m = l;
        if (r < a.length && a[r].pri < a[m].pri) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top.item;
  };
  Heap.prototype.size = function () { return this.a.length; };

  /**
   * 多源 Dijkstra。
   * @param {Object} graph
   * @param {Array} sources [{node, offset}]
   */
  function dijkstra(graph, sources) {
    const n = graph.nodes.length;
    const dist = new Float64Array(n);
    for (let i = 0; i < n; i++) dist[i] = Infinity;
    const prev = new Int32Array(n);
    const prevEdge = new Int32Array(n);
    for (let i = 0; i < n; i++) { prev[i] = -1; prevEdge[i] = -1; }
    const done = new Uint8Array(n);
    const heap = new Heap();
    (sources || []).forEach(function (s) {
      if (s.node == null || s.node < 0 || s.node >= n) return;
      const off = s.offset || 0;
      if (off < dist[s.node]) {
        dist[s.node] = off;
        prev[s.node] = -1;
        heap.push(s.node, off);
      }
    });
    while (heap.size()) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      const adj = graph.adj[u];
      for (let k = 0; k < adj.length; k++) {
        const link = adj[k];
        const nd = dist[u] + link.len;
        if (nd < dist[link.to] - 1e-9) {
          dist[link.to] = nd;
          prev[link.to] = u;
          prevEdge[link.to] = link.edge;
          heap.push(link.to, nd);
        }
      }
    }
    return { dist: dist, prev: prev, prevEdge: prevEdge };
  }

  /* ================================================================
   * 最短路
   * ================================================================ */

  /**
   * 起点 → 终点的最短路（沿路网）。
   * @param {Object} graph
   * @param {Object} start {lon,lat}
   * @param {Object} end   {lon,lat}
   * @param {Object} opts  {maxSnapM}
   */
  function shortestPath(graph, start, end, opts) {
    const o = opts || {};
    if (!graph || !graph.edges.length) {
      return { ok: false, error: '网络是空的：没有可用的线要素。' };
    }
    if (!start || !end) return { ok: false, error: '需要起点和终点。' };

    const g = cloneGraph(graph);

    // 起点：贴边 → 劈边 → 得到起点节点
    const s = snapToNetwork(g, start.lon, start.lat, { maxDistM: o.maxSnapM });
    if (!s) return { ok: false, error: '起点离网络太远，无法贴到任何线要素上。' };
    const sNode = splitEdgeAt(g, s.edgeId, s.s);
    if (sNode < 0) return { ok: false, error: '起点无法接入路网。' };

    // 终点：贴边 → 劈边 → 得到终点节点
    const t = snapToNetwork(g, end.lon, end.lat, { maxDistM: o.maxSnapM });
    if (!t) return { ok: false, error: '终点离网络太远，无法贴到任何线要素上。' };
    const tNode = splitEdgeAt(g, t.edgeId, t.s);
    if (tNode < 0) return { ok: false, error: '终点无法接入路网。' };

    const D = dijkstra(g, [{ node: sNode, offset: 0 }]);
    if (!isFinite(D.dist[tNode])) {
      return { ok: false, error: '起点与终点不连通（网络被断开或全是单向）。' };
    }

    // 回溯：得到经过的边序列
    const chain = [];
    let cur = tNode;
    let guard = 0;
    while (cur !== -1 && guard++ < g.nodes.length + 5) {
      const e = D.prevEdge[cur];
      chain.push({ edge: e, from: D.prev[cur], to: cur });
      cur = D.prev[cur];
    }
    chain.reverse();

    // 拼坐标
    const coords = [];
    const push = function (p) {
      if (!p) return;
      const last = coords[coords.length - 1];
      if (last && Math.abs(last.lon - p.lon) < 1e-12 && Math.abs(last.lat - p.lat) < 1e-12) return;
      coords.push({ lon: p.lon, lat: p.lat });
    };
    const sPt = g.nodes[sNode];
    push({ lon: sPt.lon, lat: sPt.lat });
    chain.forEach(function (step) {
      if (step.edge == null || step.edge < 0) return;
      const e = g.edges[step.edge];
      if (!e) return;
      const forward = e.a === step.from;
      const pts = forward ? e.pts : e.pts.slice().reverse();
      pts.forEach(function (p) { push({ lon: p.lon, lat: p.lat }); });
    });
    const tPt = g.nodes[tNode];
    push({ lon: tPt.lon, lat: tPt.lat });

    const distanceM = D.dist[tNode];
    return {
      ok: true,
      coords: coords,
      distanceM: distanceM,
      distanceKm: distanceM / 1000,
      start: { lon: s.lon, lat: s.lat, snapM: s.distM, edgeId: s.edgeId },
      end: { lon: t.lon, lat: t.lat, snapM: t.distM, edgeId: t.edgeId },
      nodeChain: chain.map(function (c) { return c.to; }),
      steps: chain.length,
      graph: g,
    };
  }

  /* ================================================================
   * 服务区
   * ================================================================ */

  /** 边上按里程取的成本（无向取小，单向只走 a→b）。 */
  function edgeCostAt(dist, e, s) {
    if (e.oneway) {
      const da = dist[e.a];
      return isFinite(da) ? da + s : Infinity;
    }
    const da = dist[e.a], db = dist[e.b];
    let best = Infinity;
    if (isFinite(da)) best = Math.min(best, da + s);
    if (isFinite(db)) best = Math.min(best, db + (e.len - s));
    return best;
  }

  /**
   * 服务区（等距可达范围）。
   * @param {Object} graph
   * @param {Object} start {lon,lat}
   * @param {Number} limitM 阈值（米）
   * @param {Object} opts {maxSnapM, grid}
   */
  function serviceArea(graph, start, limitM, opts) {
    const o = opts || {};
    if (!graph || !graph.edges.length) {
      return { ok: false, error: '网络是空的：没有可用的线要素。' };
    }
    const g = cloneGraph(graph);
    const s = snapToNetwork(g, start.lon, start.lat, { maxDistM: o.maxSnapM });
    if (!s) return { ok: false, error: '起点离网络太远，无法贴到任何线要素上。' };
    const sNode = splitEdgeAt(g, s.edgeId, s.s);
    if (sNode < 0) return { ok: false, error: '起点无法接入路网。' };

    const D = dijkstra(g, [{ node: sNode, offset: 0 }]);

    /* --- 网格范围：起点周围 2×阈值 --- *
     * 推导：任一可达点 p 满足 dist_网络(起点→q) + |q−p| ≤ 阈值，
     * 而 dist_网络 ≥ |起点−q|，所以 |起点−q| ≤ 阈值，
     * 进而 |起点−p| ≤ 阈值 + |q−p| ≤ 2×阈值。
     * 所以可达范围一定落在起点周围 2×阈值的窗口里。
     * （早期版本用整个路网包围盒，网络一大格子就粗得离谱。） */
    const bb = g.bbox;
    const latMid = start.lat;
    const mPerDegLon = M_PER_DEG * Math.max(0.05, Math.cos(latMid * DEG));
    const mPerDegLat = M_PER_DEG;
    const halfLon = (2 * limitM) / mPerDegLon;
    const halfLat = (2 * limitM) / mPerDegLat;
    const west = start.lon - halfLon, east = start.lon + halfLon;
    const south = start.lat - halfLat, north = start.lat + halfLat;
    const spanX = Math.max(east - west, 1e-9);
    const spanY = Math.max(north - south, 1e-9);

    /* --- 选格距：阈值半径内至少 CELLS_PER_RADIUS 格 --- */
    let cellLon = Math.max(spanX / (CELLS_PER_RADIUS * 4), limitM / (CELLS_PER_RADIUS * mPerDegLon));
    let cellLat = Math.max(spanY / (CELLS_PER_RADIUS * 4), limitM / (CELLS_PER_RADIUS * mPerDegLat));
    let w = Math.max(8, Math.ceil(spanX / cellLon) + 1);
    let h = Math.max(8, Math.ceil(spanY / cellLat) + 1);
    if (w * h > MAX_CELLS) {
      const k = Math.sqrt((w * h) / MAX_CELLS);
      w = Math.max(8, Math.ceil(w / k) + 1);
      h = Math.max(8, Math.ceil(h / k) + 1);
    }
    cellLon = spanX / w;
    cellLat = spanY / h;

    const cellCount = w * h;
    const cost = new Float64Array(cellCount);
    for (let i = 0; i < cellCount; i++) cost[i] = Infinity;

    const cellCenter = function (i, j) {
      return { lon: west + (i + 0.5) * cellLon, lat: north - (j + 0.5) * cellLat };
    };
    const cellIndex = function (lon, lat) {
      const i = Math.floor((lon - west) / cellLon);
      const j = Math.floor((north - lat) / cellLat);
      if (i < 0 || j < 0 || i >= w || j >= h) return -1;
      return j * w + i;
    };

    /* --- ① 沿边采样，把网络成本灌成种子 --- *
     * 只处理落在窗口内的边段 —— 窗口外的边贡献不了可达区。 */
    const stepM = Math.max(Math.min(cellLon * mPerDegLon, cellLat * mPerDegLat), 1);
    g.edges.forEach(function (e) {
      let acc = 0;
      for (let q = 0; q + 1 < e.pts.length; q++) {
        const p = e.pts[q], q2 = e.pts[q + 1];
        const segLen = haversineM(p.lon, p.lat, q2.lon, q2.lat);
        const nSub = Math.max(1, Math.ceil(segLen / stepM));
        for (let k = 0; k <= nSub; k++) {
          const t = k / nSub;
          const lon = p.lon + (q2.lon - p.lon) * t;
          const lat = p.lat + (q2.lat - p.lat) * t;
          if (lon < west || lon > east || lat < south || lat > north) continue;
          const at = acc + t * segLen;
          const c = edgeCostAt(D.dist, e, at);
          if (!isFinite(c)) continue;
          const idx = cellIndex(lon, lat);
          if (idx < 0) continue;
          if (c < cost[idx]) cost[idx] = c;
        }
        acc += segLen;
      }
    });

    /* --- ② 网格 Dijkstra（8 邻域，权重 = 真实大地线距离） --- *
     * 步长按行预计算，避免每个格子都算一次 haversine。          */
    const stepH = new Float64Array(h);   // 横向步长（按行）
    const stepD = new Float64Array(h);   // 对角步长（按行）
    let stepV = 0;
    for (let j = 0; j < h; j++) {
      const c0 = cellCenter(0, j);
      const c1 = cellCenter(1, j);
      const c2 = cellCenter(1, j + 1 < h ? j + 1 : j);
      stepH[j] = haversineM(c0.lon, c0.lat, c1.lon, c1.lat);
      stepD[j] = haversineM(c0.lon, c0.lat, c2.lon, c2.lat);
      if (j === 0) stepV = haversineM(c0.lon, c0.lat, c0.lon, c2.lat);
    }

    const heap = new Heap();
    for (let i = 0; i < cellCount; i++) {
      if (isFinite(cost[i])) heap.push(i, cost[i]);
    }
    const done = new Uint8Array(cellCount);
    const NB = [
      [-1, 0, 'h'], [1, 0, 'h'], [0, -1, 'v'], [0, 1, 'v'],
      [-1, -1, 'd'], [1, -1, 'd'], [-1, 1, 'd'], [1, 1, 'd'],
    ];
    while (heap.size()) {
      const cur = heap.pop();
      if (done[cur]) continue;
      done[cur] = 1;
      const ci = cur % w;
      const cj = Math.floor(cur / w);
      for (let k = 0; k < NB.length; k++) {
        const ni = ci + NB[k][0], nj = cj + NB[k][1];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nIdx = nj * w + ni;
        if (done[nIdx]) continue;
        let step;
        if (NB[k][2] === 'h') step = stepH[cj];
        else if (NB[k][2] === 'v') step = stepV;
        else step = stepD[cj];
        const nd = cost[cur] + step;
        if (nd < cost[nIdx] - 1e-6) {
          cost[nIdx] = nd;
          heap.push(nIdx, nd);
        }
      }
    }

    /* --- ③ 二值掩膜 --- */
    const mask = new Uint8Array(cellCount);
    let reached = 0;
    for (let i = 0; i < cellCount; i++) {
      if (cost[i] <= limitM) { mask[i] = 1; reached++; }
    }

    const rings = traceRings(mask, w, h, {
      west: west, south: south, east: east, north: north,
    });

    const cellAreaM2 = (cellLon * mPerDegLon) * (cellLat * mPerDegLat);
    const areaM2 = reached * cellAreaM2;

    return {
      ok: true,
      mask: { w: w, h: h, data: mask, west: west, south: south, east: east, north: north },
      cost: cost,
      rings: rings,
      reachedCells: reached,
      totalCells: cellCount,
      areaM2: areaM2,
      areaKm2: areaM2 / 1e6,
      limitM: limitM,
      start: { lon: s.lon, lat: s.lat, snapM: s.distM },
      graph: g,
    };
  }

  /**
   * 从二值掩膜抽边界环。
   * 做法：每个可达格子的 4 条边，凡是与不可达（或越界）相邻，就收集为有向边段；
   *       再按端点串成闭环。
   * @returns {Array} 环数组，每个环是 [{lon,lat}] 数组
   */
  function traceRings(mask, w, h, bounds) {
    const at = function (i, j) {
      if (i < 0 || j < 0 || i >= w || j >= h) return 0;
      return mask[j * w + i];
    };
    const segs = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!at(i, j)) continue;
        if (!at(i, j - 1)) segs.push([i, j, i + 1, j]);          // 下边 →
        if (!at(i + 1, j)) segs.push([i + 1, j, i + 1, j + 1]);  // 右边 ↑
        if (!at(i, j + 1)) segs.push([i + 1, j + 1, i, j + 1]);  // 上边 ←
        if (!at(i - 1, j)) segs.push([i, j + 1, i, j]);          // 左边 ↓
      }
    }
    const map = new Map();
    const skey = function (x, y) { return x + ',' + y; };
    segs.forEach(function (s) {
      const k = skey(s[0], s[1]);
      let arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push(s);
    });
    const used = new Set();
    const rings = [];
    segs.forEach(function (s0) {
      const id0 = skey(s0[0], s0[1]) + '>' + skey(s0[2], s0[3]);
      if (used.has(id0)) return;
      used.add(id0);
      const ring = [[s0[0], s0[1]]];
      let cur = s0;
      let guard = 0;
      while (guard++ < segs.length + 10) {
        ring.push([cur[2], cur[3]]);
        if (cur[2] === s0[0] && cur[3] === s0[1]) break;
        const arr = map.get(skey(cur[2], cur[3]));
        if (!arr) break;
        let nxt = null;
        for (const cand of arr) {
          const cid = skey(cand[0], cand[1]) + '>' + skey(cand[2], cand[3]);
          if (used.has(cid)) continue;
          nxt = cand; used.add(cid); break;
        }
        if (!nxt) break;
        cur = nxt;
      }
      if (ring.length >= 4) rings.push(ring);
    });
    const b = bounds || { west: 0, south: 0, east: 1, north: 1 };
    const cellLon = (b.east - b.west) / w;
    const cellLat = (b.north - b.south) / h;
    return rings.map(function (ring) {
      return ring.map(function (p) {
        return { lon: b.west + p[0] * cellLon, lat: b.south + p[1] * cellLat };
      });
    });
  }

  /* ================================================================
   * 导出
   * ================================================================ */

  /** 路径 → GeoJSON LineString。 */
  function pathToGeoJSON(result, name) {
    if (!result || !result.ok) return null;
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          name: name || '最短路径',
          distanceM: Math.round(result.distanceM),
          distanceKm: Number((result.distanceM / 1000).toFixed(3)),
        },
        geometry: {
          type: 'LineString',
          coordinates: result.coords.map(function (p) {
            return [Number(p.lon.toFixed(8)), Number(p.lat.toFixed(8))];
          }),
        },
      }],
    };
  }

  /** 服务区 → GeoJSON MultiPolygon。 */
  function serviceAreaToGeoJSON(result, name) {
    if (!result || !result.ok) return null;
    const polys = result.rings.map(function (r) {
      const coords = r.map(function (p) {
        return [Number(p.lon.toFixed(8)), Number(p.lat.toFixed(8))];
      });
      if (coords.length >= 3) coords.push(coords[0]);
      return [coords];
    }).filter(function (p) { return p[0].length >= 4; });
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          name: name || '服务区',
          limitM: Math.round(result.limitM),
          areaKm2: Number(result.areaKm2.toFixed(3)),
        },
        geometry: { type: 'MultiPolygon', coordinates: polys },
      }],
    };
  }

  return {
    // 常量
    R_EARTH: R_EARTH,
    M_PER_DEG: M_PER_DEG,
    // 几何
    haversineM: haversineM,
    pointOnSegDist: pointOnSegDist,
    segIntersect: segIntersect,
    nodeKey: nodeKey,
    isOneway: isOneway,
    isNetworkFeature: isNetworkFeature,
    // 建图
    buildGraph: buildGraph,
    buildAdj: buildAdj,
    cloneGraph: cloneGraph,
    graphSummary: graphSummary,
    snapToNetwork: snapToNetwork,
    edgePointAt: edgePointAt,
    splitEdgeAt: splitEdgeAt,
    // 寻路
    dijkstra: dijkstra,
    shortestPath: shortestPath,
    // 服务区
    serviceArea: serviceArea,
    edgeCostAt: edgeCostAt,
    traceRings: traceRings,
    // 导出
    pathToGeoJSON: pathToGeoJSON,
    serviceAreaToGeoJSON: serviceAreaToGeoJSON,
  };
});

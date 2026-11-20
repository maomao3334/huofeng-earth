/*
 * 拓扑检查与修复内核（纯计算，不依赖 Cesium / DOM）
 * ---------------------------------------------------------------------------
 * P3-4.13「拓扑检查与修复」的内核部分。
 *
 * 【对标 QGIS 的什么】
 *   QGIS 的「拓扑检查器」（Topology Checker）里那几条规则，本模块重新实现：
 *     · 无效几何      —— 自相交、环未闭合、重复点、点数不足
 *     · 重叠          —— 面与面重叠
 *     · 缝隙          —— 相邻面之间没有公共边，留了缝
 *     · 交点未打断    —— 两条线相交但那里没有节点
 *     · 包含          —— 点不在任何面里
 *   以及 QGIS 的「修复几何」（Fix Geometry）里最常用的那条：
 *     · 修复自相交    —— 把"蝴蝶结"多边形拆成两个合法面
 *
 * 【为什么自己写】
 *   用户的硬约束是纯离线、浏览器内跑、不依赖外部进程（QGIS / GEOS 都不引入）。
 *
 * 【哪些是精确的、哪些是采样的 —— 必须说清楚】
 *   精确（几何求交/求距，逐条算）：
 *     · 自相交（线段求交）
 *     · 重复点、环未闭合、点数不足
 *     · 面与面是否重叠（环相交判定）
 *     · 缝隙宽度（线段间最短距离）
 *     · 线交点位置（线段求交）
 *     · 点是否在面内（射线法）
 *   采样（网格近似，误差 ~ 网格分辨率）：
 *     · 重叠面积、缝隙面积
 *   原因：多边形布尔运算（裁剪）要一整套鲁棒算法，
 *   自己写容易在退化情形上出错；用均匀网格采样算面积，
 *   对"有没有重叠"这个结论没有影响，对"重叠了多少"给个带误差的量级。
 *
 * 【要素模型（与 js/spatial-index.js 一致）】
 *   { id, name, type: 'point'|'line'|'polygon', points: [{lon, lat}] }
 *
 * 【对外 API（window.LETopology = module.exports）】
 *   基础几何：segIntersect / segDistance / pointInRing / ringAreaM2 / ringIsCCW
 *   检测：selfIntersections / findDuplicatePoints / findOverlaps / findGaps
 *         findUnsnappedCrossings / findOutsidePoints / checkFeature / checkDataset
 *   修复：removeDuplicatePoints / closeRing / fixSelfIntersection / repairFeature
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LETopology = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 常量
   * ================================================================ */

  const R_EARTH = 6378137;          // 米
  const DEG = Math.PI / 180;

  const DEFAULT_DUP_TOL_M = 0.001;  // 重复点容差：1 毫米
  const DEFAULT_GAP_TOL_M = 0.5;    // 缝隙容差：0.5 米
  const DEFAULT_SNAP_TOL_M = 0.5;   // 打断容差：0.5 米
  const GRID = 256;                 // 采样网格边长（像素）

  /* ================================================================
   * 基础几何
   * ================================================================ */

  /** 叉积符号。 */
  function orient(a, b, c) {
    const v = (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
    if (v > 1e-14) return 1;
    if (v < -1e-14) return -1;
    return 0;
  }

  function onSegment(a, b, p) {
    return p.lon >= Math.min(a.lon, b.lon) - 1e-12 &&
           p.lon <= Math.max(a.lon, b.lon) + 1e-12 &&
           p.lat >= Math.min(a.lat, b.lat) - 1e-12 &&
           p.lat <= Math.max(a.lat, b.lat) + 1e-12;
  }

  /**
   * 两线段求交点（严格穿过时返回交点；共线重叠返回 null）。
   * @returns {{x:number, y:number, t:number, u:number}|null}
   */
  function segIntersect(a, b, c, d) {
    const d1 = orient(c, d, a);
    const d2 = orient(c, d, b);
    const d3 = orient(a, b, c);
    const d4 = orient(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      const den = (b.lon - a.lon) * (d.lat - c.lat) - (b.lat - a.lat) * (d.lon - c.lon);
      if (Math.abs(den) < 1e-18) return null;
      const t = ((c.lon - a.lon) * (d.lat - c.lat) - (c.lat - a.lat) * (d.lon - c.lon)) / den;
      const u = ((c.lon - a.lon) * (b.lat - a.lat) - (c.lat - a.lat) * (b.lon - a.lon)) / den;
      return {
        x: a.lon + t * (b.lon - a.lon),
        y: a.lat + t * (b.lat - a.lat),
        t: t, u: u,
      };
    }
    return null;
  }

  /** 点到线段的最近点。 */
  function closestOnSegment(p, a, b) {
    const kx = Math.cos(((a.lat + b.lat) / 2) * DEG) * DEG * R_EARTH;
    const ky = DEG * R_EARTH;
    const px = (p.lon - a.lon) * kx, py = (p.lat - a.lat) * ky;
    const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky;
    const len2 = bx * bx + by * by;
    let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = t * bx, cy = t * by;
    return {
      dist: Math.hypot(px - cx, py - cy),
      point: { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t },
      t: t,
    };
  }

  /**
   * 两线段之间的最短距离（米）。
   * 相交时返回 0，并给出交点。
   */
  function segDistance(a, b, c, d) {
    const hit = segIntersect(a, b, c, d);
    if (hit) {
      return { dist: 0, point: { lon: hit.x, lat: hit.y }, point2: { lon: hit.x, lat: hit.y } };
    }
    const r1 = closestOnSegment(a, c, d);
    const r2 = closestOnSegment(b, c, d);
    const r3 = closestOnSegment(c, a, b);
    const r4 = closestOnSegment(d, a, b);
    const best = [r1, r2, r3, r4].sort(function (x, y) { return x.dist - y.dist; })[0];
    return { dist: best.dist, point: best.point };
  }

  /** 点是否在环内（射线法）。 */
  function pointInRing(pt, ring) {
    if (!pt || !ring || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lon, yi = ring[i].lat;
      const xj = ring[j].lon, yj = ring[j].lat;
      const intersect = (yi > pt.lat) !== (yj > pt.lat) &&
        pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi + 1e-15) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * 环的面积（平方米，绝对值；用局部等距投影）。
   *
   * 注意 1：投影原点必须用**包围盒中心**，不能用"顶点平均"——
   *   闭合环会把首点算两次，原点偏移 → cos(lat) 缩放因子变了 →
   *   同一个面在"闭合前/闭合后"算出两个面积。包围盒中心与是否闭合无关。
   *
   * 注意 2：跨 180° 的环要先解缠，否则经度跨度 360° 会把
   *   cos(lat) 缩放算废，���积完全不对。
   */
  function ringAreaM2(ring) {
    if (!ring || ring.length < 3) return 0;
    const r = crossesAntimeridian(ring) ? unwrapLongitudes(ring) : ring;
    const bb = bboxOf(r);
    const clon = (bb.minLon + bb.maxLon) / 2;
    const clat = (bb.minLat + bb.maxLat) / 2;
    const kx = Math.cos(clat * DEG) * DEG * R_EARTH;
    const ky = DEG * R_EARTH;
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const x1 = (p.lon - clon) * kx, y1 = (p.lat - clat) * ky;
      const x2 = (q.lon - clon) * kx, y2 = (q.lat - clat) * ky;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  /** 环是否有向面积为正（逆时针）。 */
  function ringIsCCW(ring) {
    if (!ring || ring.length < 3) return false;
    const r = crossesAntimeridian(ring) ? unwrapLongitudes(ring) : ring;
    const bb = bboxOf(r);
    const clon = (bb.minLon + bb.maxLon) / 2;
    const clat = (bb.minLat + bb.maxLat) / 2;
    const kx = Math.cos(clat * DEG) * DEG * R_EARTH;
    const ky = DEG * R_EARTH;
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      a += (p.lon - clon) * kx * ((q.lat - clat) * ky) -
           (q.lon - clon) * kx * ((p.lat - clat) * ky);
    }
    return a > 0;
  }

  /** 大圆距离（米）。 */
  function haversineM(lon1, lat1, lon2, lat2) {
    const p1 = lat1 * DEG, p2 = lat2 * DEG;
    const dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 两点距离（米）。 */
  function pointDistanceM(a, b) {
    return haversineM(a.lon, a.lat, b.lon, b.lat);
  }

  /** 包围盒。 */
  function bboxOf(points) {
    if (!points || !points.length) return null;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const p of points) {
      if (p.lon < minLon) minLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat > maxLat) maxLat = p.lat;
    }
    return { minLon: minLon, minLat: minLat, maxLon: maxLon, maxLat: maxLat };
  }

  /**
   * 经度"解缠"：把跨越 180° 日期变更线的环展开成连续的一段。
   *
   * 【为什么必须做】
   *   Antarctica 的顶点是 180, 180, -180, -180, -179.9, ... ,
   *   直接取 min/max 得到 [-180, 180]，跨度 360° —— 整个地球都被装进
   *   它的包围盒，于是它跟**任何**要素都"bbox 相交"，
   *   制造出成百上千条假重叠。
   *   解缠后（相邻点差不超过 180°，超过就加/减 360°）得到 180…540，
   *   跨度才是真实的 360°（它确实绕地球一圈），而与其他要素比较时
   *   仍能按需平移到相邻副本。
   *
   * @param {Array} points
   * @returns {Array} 解缠后的点（lon 可能超出 [-180,180]）
   */
  function unwrapLongitudes(points) {
    if (!points || points.length < 2) return points ? points.slice() : [];
    const out = [];
    let prev = points[0].lon;
    for (let i = 0; i < points.length; i++) {
      let v = points[i].lon;
      while (v - prev > 180) v -= 360;
      while (prev - v > 180) v += 360;
      out.push({ lon: v, lat: points[i].lat, height: points[i].height });
      prev = v;
    }
    return out;
  }

  /**
   * 判断一个环是否跨越了 180° 日期变更线。
   * 判据：原始经度的跨度 > 180°。
   */
  function crossesAntimeridian(points) {
    if (!points || points.length < 2) return false;
    let min = Infinity, max = -Infinity;
    for (const p of points) {
      if (p.lon < min) min = p.lon;
      if (p.lon > max) max = p.lon;
    }
    return (max - min) > 180;
  }

  /**
   * 把两个环的经度"对齐"到同一个坐标系。
   *
   * 两个环可能各自用不同的经度副本表示同一个位置：
   *   Antarctica 用 180…540（解缠后），Russia 用 27.3…180，
   *   而 Russia 的楚科奇半岛另一侧用 -180…-169.9。
   * 直接比经度数值会漏判或误判。
   * → 把其中一个整体平移 ±360°，取"离另一个最近"的那个副本。
   *
   * @param {Array} ringA
   * @param {Array} ringB
   * @returns {Array} 平移后的 ringB
   */
  function alignRingLon(ringA, ringB) {
    if (!ringA || !ringB || !ringA.length || !ringB.length) return ringB;
    const bbA = bboxOf(ringA);
    const bbB = bboxOf(ringB);
    if (!bbA || !bbB) return ringB;
    const cA = (bbA.minLon + bbA.maxLon) / 2;
    const cB = (bbB.minLon + bbB.maxLon) / 2;
    const shift = Math.round((cA - cB) / 360) * 360;
    if (!shift) return ringB;
    return ringB.map(function (p) {
      return { lon: p.lon + shift, lat: p.lat, height: p.height };
    });
  }

  function bboxOverlap(a, b) {
    if (!a || !b) return false;
    return !(a.maxLon < b.minLon || b.maxLon < a.minLon ||
             a.maxLat < b.minLat || b.maxLat < a.minLat);
  }

  /* ================================================================
   * 采样求面积（多边形布尔没有自写，采样给量级）
   * ================================================================ */

  /**
   * 在 bbox 内按 GRID×GRID 均匀采样，数落在多边形里的点。
   *
   * 【minHits 的含义 —— 这个参数决定了对不对】
   *   minHits = 1：数"落在**任意一个**环里"的点（并集面积）
   *   minHits = 2：数"落在**至少两个**环里"的点（交集面积）
   * 重叠面积必须用 minHits = 2。之前用 1，导致"重叠面积"实际上算的是
   * 两个环的**并集**面积 —— Russia × China 报出 385 万 km² 的荒谬结果，
   * 因为 Russia 和 China 的**包围盒交集**面积就这么大。
   *
   * 【为什么用扫描线而不是逐点 pointInRing】
   *   逐点 ray casting 要对每个采样点遍历整个环的所有边，
   *   256×256 = 65536 个采样点 × 数百个顶点 = 上千万次运算，实测 11.9 秒。
   *   扫描线（横线求交）把每个顶点只算它覆盖的那几行，
   *   而且每一行的交点表排好序后用二分判断"左边交点个数是奇数"，
   *   结果与 pointInRing **完全等价**（同一条半开区间规则），
   *   实测快 2 个数量级。
   *
   * @param {Array<Array>} polygons 环数组
   * @param {Object} bbox {minLon,minLat,maxLon,maxLat}
   * @param {Object} opts { minHits:number, grid:number }
   * @returns {{count:number, areaM2:number, hits:Array}}
   */
  function sampleInside(polygons, bbox, opts) {
    const o = opts || {};
    const out = { count: 0, areaM2: 0, hits: [] };
    if (!bbox) return out;
    const lonSpan = bbox.maxLon - bbox.minLon;
    const latSpan = bbox.maxLat - bbox.minLat;
    if (!(lonSpan > 0) || !(latSpan > 0)) return out;
    const minHits = o.minHits == null ? 1 : o.minHits;
    const grid = o.grid == null ? GRID : o.grid;
    const clon = (bbox.minLon + bbox.maxLon) / 2;
    const clat = (bbox.minLat + bbox.maxLat) / 2;
    const kx = Math.cos(clat * DEG) * DEG * R_EARTH;
    const ky = DEG * R_EARTH;
    const cellW = (lonSpan * kx) / grid;
    const cellH = (latSpan * ky) / grid;
    const cellArea = cellW * cellH;

    // 每个多边形 → 按采样行分桶的线段表
    const tables = polygons.map(function (ring) {
      const rows = [];
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const lo = Math.min(p.lat, q.lat);
        const hi = Math.max(p.lat, q.lat);
        if (!(hi > lo)) continue;      // 水平段不参与射线法
        // 命中行条件：lo <= lat_r < hi，lat_r = minLat + latSpan*(r+0.5)/grid
        let r0 = Math.ceil(((lo - bbox.minLat) / latSpan) * grid - 0.5);
        let r1 = Math.ceil(((hi - bbox.minLat) / latSpan) * grid - 0.5) - 1;
        if (r0 < 0) r0 = 0;
        if (r1 > grid - 1) r1 = grid - 1;
        for (let r = r0; r <= r1; r++) {
          if (!rows[r]) rows[r] = [];
          rows[r].push(p, q);
        }
      }
      return rows;
    });

    let count = 0;
    for (let r = 0; r < grid; r++) {
      const lat = bbox.minLat + latSpan * ((r + 0.5) / grid);
      // 每个多边形在这一行的交点 x（升序）
      const xsList = [];
      for (let k = 0; k < polygons.length; k++) {
        const segs = tables[k][r];
        const xs = [];
        if (segs) {
          for (let s = 0; s < segs.length; s += 2) {
            const p = segs[s], q = segs[s + 1];
            const lo = p.lat <= q.lat ? p : q;
            const hi = p.lat <= q.lat ? q : p;
            if (!(lat >= lo.lat && lat < hi.lat)) continue;
            const t = (lat - lo.lat) / (hi.lat - lo.lat);
            xs.push(lo.lon + (hi.lon - lo.lon) * t);
          }
        }
        xs.sort(function (a, b) { return a - b; });
        xsList.push(xs);
      }
      for (let i = 0; i < grid; i++) {
        const lon = bbox.minLon + lonSpan * ((i + 0.5) / grid);
        let hits = 0;
        for (let k = 0; k < xsList.length; k++) {
          const xs = xsList[k];
          // 交点 x > lon 的个数为奇数 → 点在环内
          let lo = 0, hi = xs.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (xs[mid] > lon) hi = mid; else lo = mid + 1;
          }
          if (((xs.length - lo) & 1) === 1) hits++;
        }
        if (hits >= minHits) {
          count++;
          out.hits.push(hits);
        }
      }
    }
    out.count = count;
    out.areaM2 = count * cellArea;
    return out;
  }

  /* ================================================================
   * 检测：自相交
   * ================================================================ */

  /**
   * 环的自相交点列表。
   * 相邻段共享端点不算自交；首尾闭合点不算。
   * @returns {Array<{i:number, j:number, x:number, y:number}>}
   */
  function selfIntersections(ring) {
    const out = [];
    if (!ring || ring.length < 4) return out;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a1 = ring[i];
      const a2 = ring[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        // 相邻段（含首尾）跳过
        if (j === i) continue;
        if (j === i + 1) continue;
        if (i === 0 && j === n - 1) continue;
        const b1 = ring[j];
        const b2 = ring[(j + 1) % n];
        const hit = segIntersect(a1, a2, b1, b2);
        if (hit) out.push({ i: i, j: j, x: hit.x, y: hit.y });
      }
    }
    return out;
  }

  /* ================================================================
   * 检测：重复点
   * ================================================================ */

  /**
   * 找重复点（距离小于容差）。
   *
   * 【环的首尾同点不算重复】——这是闭合环的定义，不是几何缺陷。
   * 之前漏了这个判断，导致每一个正常的闭合面都被报"有 1 处重复点"：
   * 实测 288 个 Natural Earth 国界要素全部误报。
   *
   * @param {Array} points
   * @param {number} tolM 容差（米）
   * @param {Object} opts { closedRing:boolean } 默认 true（按环处理）
   * @returns {Array<{i:number, j:number, distM:number}>}
   */
  function findDuplicatePoints(points, tolM, opts) {
    const o = opts || {};
    const tol = tolM == null ? DEFAULT_DUP_TOL_M : tolM;
    const closedRing = o.closedRing !== false;
    const out = [];
    if (!points || points.length < 2) return out;
    const last = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        // 环的首尾同点不算重复
        if (closedRing && i === 0 && j === last) continue;
        const d = pointDistanceM(points[i], points[j]);
        if (d <= tol) out.push({ i: i, j: j, distM: d });
      }
    }
    return out;
  }

  /** 去掉重复点（保留每个位置的第一个）。 */
  function removeDuplicatePoints(points, tolM) {
    const tol = tolM == null ? DEFAULT_DUP_TOL_M : tolM;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      let dup = false;
      for (let k = 0; k < out.length; k++) {
        if (pointDistanceM(points[i], out[k]) <= tol) { dup = true; break; }
      }
      if (!dup) out.push({ lon: points[i].lon, lat: points[i].lat });
    }
    return out;
  }

  /** 环是否闭合（首尾坐标相同）。 */
  function isRingClosed(ring) {
    if (!ring || ring.length < 2) return false;
    const a = ring[0], b = ring[ring.length - 1];
    return a.lon === b.lon && a.lat === b.lat;
  }

  /** 把环补成闭合的（首点追加到末尾）。 */
  function closeRing(ring) {
    if (!ring || !ring.length) return [];
    if (isRingClosed(ring)) return ring.slice();
    return ring.concat([{ lon: ring[0].lon, lat: ring[0].lat }]);
  }

  /* ================================================================
   * 检测：面重叠
   * ================================================================ */

  /**
   * 找重叠的面。
   *
   * 【重叠面积怎么算的 —— 这里踩过两个坑】
   *
   * 坑 1：采样框用了"两个包围盒的交集"。
   *   对 Russia（bbox 27°E–180°）和 China（73°E–135°）来说，
   *   包围盒交集是一个大矩形，面积约 385 万 km²，
   *   但两个国家实际**根本不重叠**（中间隔着 Kazakhstan / Mongolia）。
   *   → 必须先把采样框**收窄到真实重叠区**。
   *
   * 坑 2：采样统计的是"落在任意一个环里"的点（并集）。
   *   同一个框里 Russia 的面积 + China 的面积全都算进去了。
   *   → 统计"落在**至少两个**环里"的点（交集），minHits = 2。
   *
   * 收窄办法：用两环的**实际相交部分**估计重叠区 ——
   *   A 的顶点在 B 里的部分 + B 的顶点在 A 里的部分 + 边界交点，
   *   合成一个"候选重叠区"的包围盒。真正重叠的面必有顶点或交点
   *   落在对方内部/边界上，所以这个框一定罩得住真正的重叠区。
   *
   * @param {Array} features 要素数组（type==='polygon'）
   * @param {Object} opts { minAreaM2: 小于此面积视为忽略, grid: 采样网格边长 }
   * @returns {Array<{a:string, b:string, aIndex:number, bIndex:number, areaM2:number, at:{lon,lat}}>}
   */
  function findOverlaps(features, opts) {
    const o = opts || {};
    const minArea = o.minAreaM2 == null ? 1 : o.minAreaM2;
    const polys = [];
    features.forEach(function (f, i) {
      if (f.type !== 'polygon' || !f.points || f.points.length < 3) return;
      // 跨 180° 的环先解缠，否则包围盒会横跨整个地球
      const ring = crossesAntimeridian(f.points) ? unwrapLongitudes(f.points) : f.points;
      polys.push({ f: f, i: i, ring: ring, bbox: bboxOf(ring) });
    });
    const out = [];
    for (let a = 0; a < polys.length; a++) {
      for (let b = a + 1; b < polys.length; b++) {
        const A = polys[a], B = polys[b];
        // 先把两个环对齐到同一个经度坐标系
        const ringB = alignRingLon(A.ring, B.ring);
        const bboxB = bboxOf(ringB);
        if (!bboxOverlap(A.bbox, bboxB)) continue;
        if (!ringsOverlap(A.ring, ringB)) continue;

        // ---- 采样框 = 两个环的包围盒交集 ----
        // 注意：这里**必须**用 minHits = 2 采样（交集），
        // 用 minHits = 1（并集）算出来的是两个环加起来多大，不是重叠多大。
        const rb = {
          minLon: Math.max(A.bbox.minLon, bboxB.minLon),
          minLat: Math.max(A.bbox.minLat, bboxB.minLat),
          maxLon: Math.min(A.bbox.maxLon, bboxB.maxLon),
          maxLat: Math.min(A.bbox.maxLat, bboxB.maxLat),
        };
        if (!(rb.maxLon - rb.minLon > 0) || !(rb.maxLat - rb.minLat > 0)) {
          // 包围盒交集退化（只挨着，不重叠）→ 不构成面重叠
          continue;
        }

        // 采样求**交集**面积
        const s = sampleInside([A.ring, ringB], rb, { minHits: 2, grid: o.grid });
        if (s.areaM2 < minArea) continue;

        // 重叠位置：取落在对方里的顶点，或边界交点
        let at = null;
        for (const p of A.ring) {
          if (pointInRing(p, ringB)) { at = p; break; }
        }
        if (!at) {
          for (const p of ringB) {
            if (pointInRing(p, A.ring)) { at = p; break; }
          }
        }
        if (!at) {
          outer:
          for (let i = 0; i < A.ring.length; i++) {
            const a1 = A.ring[i], a2 = A.ring[(i + 1) % A.ring.length];
            for (let j = 0; j < ringB.length; j++) {
              const b1 = ringB[j], b2 = ringB[(j + 1) % ringB.length];
              const h = segIntersect(a1, a2, b1, b2);
              if (h) { at = { lon: h.x, lat: h.y }; break outer; }
            }
          }
        }
        out.push({
          a: A.f.id, b: B.f.id,
          aIndex: A.i, bIndex: B.i,
          aName: A.f.name, bName: B.f.name,
          areaM2: s.areaM2,
          at: at || { lon: (rb.minLon + rb.maxLon) / 2, lat: (rb.minLat + rb.maxLat) / 2 },
        });
      }
    }
    return out;
  }

  /** 两个环是否有重叠（边界交叉或一方包含另一方）。 */
  function ringsOverlap(a, b) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    for (let i = 0; i < a.length; i++) {
      const a1 = a[i], a2 = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) {
        const b1 = b[j], b2 = b[(j + 1) % b.length];
        if (segIntersect(a1, a2, b1, b2)) return true;
      }
    }
    for (const p of a) if (pointInRing(p, b)) return true;
    for (const p of b) if (pointInRing(p, a)) return true;
    return false;
  }

  /* ================================================================
   * 检测：缝隙
   * ================================================================ */

  /**
   * 找面与面之间的缝隙（两边界最近距离 > 0 且 <= 容差）。
   * 注意：这只在"这些面本该相邻"（覆盖率/宗地）的前提下才有意义。
   * @returns {Array<{a:string,b:string,widthM:number,at:{lon,lat}}>}
   */
  function findGaps(features, opts) {
    const o = opts || {};
    const tol = o.tolM == null ? DEFAULT_GAP_TOL_M : o.tolM;
    const polys = [];
    features.forEach(function (f, i) {
      if (f.type !== 'polygon' || !f.points || f.points.length < 3) return;
      const ring = crossesAntimeridian(f.points) ? unwrapLongitudes(f.points) : f.points;
      polys.push({ f: f, i: i, ring: ring, bbox: bboxOf(ring) });
    });
    const out = [];
    for (let a = 0; a < polys.length; a++) {
      for (let b = a + 1; b < polys.length; b++) {
        const A = polys[a], B = polys[b];
        const ringB = alignRingLon(A.ring, B.ring);
        const bboxB = bboxOf(ringB);
        // 缝隙候选必须靠得近：bbox 间距不超过容差
        const gapLon = Math.max(0, Math.max(A.bbox.minLon - bboxB.maxLon,
          bboxB.minLon - A.bbox.maxLon));
        const gapLat = Math.max(0, Math.max(A.bbox.minLat - bboxB.maxLat,
          bboxB.minLat - A.bbox.maxLat));
        const bboxGap = Math.hypot(gapLon * Math.cos(((A.bbox.minLat + bboxB.minLat) / 2) * DEG),
          gapLat) * DEG * R_EARTH;
        if (bboxGap > tol) continue;
        // 精确最近距离
        let best = null;
        for (let i = 0; i < A.ring.length; i++) {
          const a1 = A.ring[i], a2 = A.ring[(i + 1) % A.ring.length];
          for (let j = 0; j < ringB.length; j++) {
            const b1 = ringB[j], b2 = ringB[(j + 1) % ringB.length];
            const r = segDistance(a1, a2, b1, b2);
            if (!best || r.dist < best.dist) best = r;
          }
        }
        if (!best || best.dist <= 0 || best.dist > tol) continue;
        out.push({
          a: A.f.id, b: B.f.id,
          aIndex: A.i, bIndex: B.i,
          aName: A.f.name, bName: B.f.name,
          widthM: best.dist,
          at: best.point,
        });
      }
    }
    return out;
  }

  /* ================================================================
   * 检测：线交点未打断
   * ================================================================ */

  /**
   * 找两条线相交、但交点处没有节点（也就是没有顶点正好落在交点上）。
   * @returns {Array<{a:string,b:string,x:number,y:number}>}
   */
  function findUnsnappedCrossings(features, opts) {
    const o = opts || {};
    const tol = o.tolM == null ? DEFAULT_SNAP_TOL_M : o.tolM;
    const lines = [];
    features.forEach(function (f, i) {
      if (f.type !== 'line' || !f.points || f.points.length < 2) return;
      lines.push({ f: f, i: i, pts: f.points });
    });
    const out = [];
    for (let a = 0; a < lines.length; a++) {
      for (let b = a + 1; b < lines.length; b++) {
        const A = lines[a], B = lines[b];
        for (let i = 1; i < A.pts.length; i++) {
          for (let j = 1; j < B.pts.length; j++) {
            const hit = segIntersect(A.pts[i - 1], A.pts[i], B.pts[j - 1], B.pts[j]);
            if (!hit) continue;
            const p = { lon: hit.x, lat: hit.y };
            // 交点处是否有节点（任一端点正好是这个点）
            const snapped =
              pointDistanceM(A.pts[i - 1], p) <= tol ||
              pointDistanceM(A.pts[i], p) <= tol ||
              pointDistanceM(B.pts[j - 1], p) <= tol ||
              pointDistanceM(B.pts[j], p) <= tol;
            if (snapped) continue;
            out.push({
              a: A.f.id, b: B.f.id,
              aIndex: A.i, bIndex: B.i,
              aName: A.f.name, bName: B.f.name,
              x: hit.x, y: hit.y,
            });
          }
        }
      }
    }
    return out;
  }

  /* ================================================================
   * 检测：点不在面里
   * ================================================================ */

  /**
   * 找"不在任何面里"的点。
   * @returns {Array<{point:string, lon:number, lat:number}>}
   */
  function findOutsidePoints(features, polys) {
    const rings = (polys || []).filter(function (p) {
      return p.type === 'polygon' && p.points && p.points.length >= 3;
    }).map(function (p) { return p.points; });
    const out = [];
    features.forEach(function (f) {
      if (f.type !== 'point' || !f.points || !f.points.length) return;
      const p = f.points[0];
      let inside = false;
      for (const ring of rings) {
        if (pointInRing(p, ring)) { inside = true; break; }
      }
      if (!inside) out.push({ point: f.id, name: f.name, lon: p.lon, lat: p.lat });
    });
    return out;
  }

  /* ================================================================
   * 检查：单要素
   * ================================================================ */

  const RULE_LABELS = {
    selfIntersection: '自相交',
    duplicatePoint: '重复点',
    unclosedRing: '环未闭合',
    tooFewPoints: '点数不足',
    overlapping: '重叠',
    gap: '缝隙',
    unsnappedCrossing: '交点未打断',
    outside: '不在面内',
  };

  /**
   * 检查单个要素的几何有效性。
   *
   * 【rules 必须真的生效】——之前 checkDataset 里直接调 checkFeature(f, o)，
   * 而 checkFeature 压根不看 o.rules，于是"只勾选自相交"也会把所有规则
   * 的问题全报一遍。实测 288 个要素的数据集，每勾一条规则就回 290 条，
   * 跟勾没勾完全无关。现在按 rules 过滤。
   *
   * @param {Object} feature
   * @param {Object} opts { rules, duplicateToleranceM, requireClosedRing }
   * @returns {Array<Object>} 问题列表
   */
  function checkFeature(feature, opts) {
    const o = opts || {};
    const dupTol = o.duplicateToleranceM == null ? DEFAULT_DUP_TOL_M : o.duplicateToleranceM;
    // 没给 rules 就是"全查"；给了就按给的来
    const rules = o.rules || null;
    const want = function (rule) {
      return !rules || rules.indexOf(rule) >= 0;
    };
    const issues = [];
    if (!feature || !feature.points || !feature.points.length) {
      if (want('tooFewPoints')) {
        issues.push({ rule: 'tooFewPoints', severity: 'error',
          message: '要素没有坐标', featureId: feature && feature.id });
      }
      return issues;
    }
    const pts = feature.points;
    const type = feature.type || 'point';

    if (type === 'point') {
      if (pts.length > 1 && want('duplicatePoint')) {
        issues.push({ rule: 'duplicatePoint', severity: 'warning',
          message: '点要素有 ' + pts.length + ' 个坐标', featureId: feature.id });
      }
      return issues;
    }

    if (pts.length < 2) {
      if (want('tooFewPoints')) {
        issues.push({ rule: 'tooFewPoints', severity: 'error',
          message: '要素只有 ' + pts.length + ' 个点', featureId: feature.id });
      }
      return issues;
    }

    if (want('duplicatePoint')) {
      const dups = findDuplicatePoints(pts, dupTol);
      if (dups.length) {
        issues.push({
          rule: 'duplicatePoint', severity: 'warning',
          message: '有 ' + dups.length + ' 处重复点',
          featureId: feature.id,
          detail: dups.slice(0, 10),
          at: pts[dups[0].i],
        });
      }
    }

    if (type === 'polygon') {
      if (pts.length < 3) {
        if (want('tooFewPoints')) {
          issues.push({ rule: 'tooFewPoints', severity: 'error',
            message: '面只有 ' + pts.length + ' 个点，无法成面', featureId: feature.id });
        }
      } else {
        if (want('unclosedRing') && !isRingClosed(pts) && o.requireClosedRing) {
          issues.push({ rule: 'unclosedRing', severity: 'warning',
            message: '环首尾不重合', featureId: feature.id });
        }
        if (want('selfIntersection')) {
          const xs = selfIntersections(pts);
          if (xs.length) {
            issues.push({
              rule: 'selfIntersection', severity: 'error',
              message: '有 ' + xs.length + ' 处自相交',
              featureId: feature.id,
              detail: xs.slice(0, 10),
              at: { lon: xs[0].x, lat: xs[0].y },
            });
          }
        }
      }
    }
    return issues;
  }

  /**
   * 检查整个数据集（多个要素之间的规则也要查）。
   * @param {Array} features
   * @param {Object} opts { rules: ['selfIntersection','overlap','gap','crossing','outside'],
   *                         duplicateToleranceM, gapToleranceM, snapToleranceM }
   */
  function checkDataset(features, opts) {
    const o = opts || {};
    const rules = o.rules || ['selfIntersection', 'duplicatePoint', 'unclosedRing',
      'tooFewPoints', 'overlapping', 'gap', 'unsnappedCrossing', 'outside'];
    const issues = [];

    features.forEach(function (f) {
      // 关键：把 rules 传进去，否则"只勾一条规则"也会把全部规则的问题报出来
      const fi = checkFeature(f, Object.assign({}, o, { rules: rules }));
      fi.forEach(function (x) { issues.push(x); });
    });

    const polys = features.filter(function (f) {
      return f.type === 'polygon' && f.points && f.points.length >= 3;
    });

    if (rules.indexOf('overlapping') >= 0 && polys.length > 1) {
      findOverlaps(polys, o).forEach(function (ov) {
        issues.push({
          rule: 'overlapping', severity: 'error',
          message: '与「' + (ov.bName || ov.b) + '」重叠约 ' +
            (ov.areaM2 / 1e4).toFixed(1) + ' 公顷',
          featureId: ov.a, otherId: ov.b,
          at: ov.at, areaM2: ov.areaM2,
        });
      });
    }

    if (rules.indexOf('gap') >= 0 && polys.length > 1) {
      findGaps(polys, o).forEach(function (g) {
        issues.push({
          rule: 'gap', severity: 'warning',
          message: '与「' + (g.bName || g.b) + '」之间有 ' +
            (g.widthM * 100).toFixed(1) + ' 厘米的缝',
          featureId: g.a, otherId: g.b,
          at: g.at, widthM: g.widthM,
        });
      });
    }

    if (rules.indexOf('unsnappedCrossing') >= 0) {
      const lines = features.filter(function (f) {
        return f.type === 'line' && f.points && f.points.length >= 2;
      });
      findUnsnappedCrossings(lines, o).forEach(function (c) {
        issues.push({
          rule: 'unsnappedCrossing', severity: 'warning',
          message: '与「' + (c.bName || c.b) + '」相交但交点处没有节点',
          featureId: c.a, otherId: c.b,
          at: { lon: c.x, lat: c.y },
        });
      });
    }

    if (rules.indexOf('outside') >= 0 && polys.length) {
      findOutsidePoints(features, polys).forEach(function (p) {
        issues.push({
          rule: 'outside', severity: 'info',
          message: '不在任何面内',
          featureId: p.point, at: { lon: p.lon, lat: p.lat },
        });
      });
    }

    return issues;
  }

  /* ================================================================
   * 修复
   * ================================================================ */

  /**
   * 在自交点处把环拆成两个环。
   * @param {Array} ring
   * @param {number} i 段 i（ring[i] → ring[i+1]）
   * @param {number} j 段 j
   * @param {Object} pt 交点
   */
  function splitRingAt(ring, i, j, pt) {
    const n = ring.length;
    const cross = { lon: pt.x, lat: pt.y };
    // A: cross → r[j+1..n-1] → r[0..i] → cross
    const A = [cross];
    for (let k = j + 1; k < n; k++) A.push(ring[k]);
    for (let k = 0; k <= i; k++) A.push(ring[k]);
    A.push(cross);
    // B: cross → r[i+1..j] → cross
    const B = [cross];
    for (let k = i + 1; k <= j; k++) B.push(ring[k]);
    B.push(cross);
    return [A, B];
  }

  /**
   * 修复自相交：把环拆成若干个不自相交的合法面。
   * @returns {{rings:Array, splits:number}}
   */
  function fixSelfIntersection(ring) {
    if (!ring || ring.length < 4) return { rings: ring ? [ring.slice()] : [], splits: 0 };
    const work = [ring.slice()];
    const out = [];
    let guard = 0;
    let splits = 0;
    while (work.length && guard++ < 200) {
      const r = work.pop();
      const xs = selfIntersections(r);
      if (!xs.length) {
        if (r.length >= 4) out.push(r);
        continue;
      }
      const x = xs[0];
      const parts = splitRingAt(r, x.i, x.j, x);
      if (!parts[0] || !parts[1]) { out.push(r); continue; }
      splits++;
      work.push(parts[0]);
      work.push(parts[1]);
    }
    return { rings: out, splits: splits };
  }

  /**
   * 修复一个要素。
   * @param {Object} feature
   * @param {Object} opts { duplicateToleranceM, minRingAreaM2, ensureCCW, fixSelfIntersection }
   * @returns {{feature:Object, applied:Array<String>, issues:Array}}
   */
  function repairFeature(feature, opts) {
    const o = opts || {};
    const dupTol = o.duplicateToleranceM == null ? DEFAULT_DUP_TOL_M : o.duplicateToleranceM;
    const applied = [];
    const issues = checkFeature(feature, o);
    if (!feature || !feature.points || !feature.points.length) {
      return { feature: feature, applied: applied, issues: issues };
    }
    let pts = feature.points.map(function (p) {
      return { lon: p.lon, lat: p.lat };
    });
    const type = feature.type || 'point';
    let extraRings = null;

    // ① 重复点
    const dedup = removeDuplicatePoints(pts, dupTol);
    if (dedup.length !== pts.length) {
      applied.push('去除重复点 ' + (pts.length - dedup.length) + ' 个');
      pts = dedup;
    }

    if (type === 'polygon' && pts.length >= 3) {
      // ② 环闭合
      if (o.closeRing !== false && !isRingClosed(pts)) {
        pts = closeRing(pts);
        applied.push('闭合环');
      }
      // ③ 自相交
      if (o.fixSelfIntersection !== false) {
        const fixed = fixSelfIntersection(pts);
        if (fixed.splits > 0) {
          // 丢掉面积过小的碎环
          const minArea = o.minRingAreaM2 == null ? 1 : o.minRingAreaM2;
          const kept = fixed.rings.filter(function (r) {
            return ringAreaM2(r) >= minArea;
          });
          if (kept.length) {
            applied.push('拆开自相交 ' + fixed.splits + ' 处');
            pts = kept[0];
            // 多于一个环时，主几何取第一个；其余在 extraRings 里返回
            if (kept.length > 1) {
              extraRings = kept.slice(1);
            }
          }
        }
      }
      // ④ 绕向
      if (o.ensureCCW && !ringIsCCW(pts)) {
        pts = pts.slice().reverse();
        applied.push('统一绕向为逆时针');
      }
    }

    const out = Object.assign({}, feature, { points: pts });
    if (extraRings) out.extraRings = extraRings;
    return { feature: out, applied: applied, issues: issues };
  }

  /** 修复整个数据集。 */
  function repairDataset(features, opts) {
    const results = [];
    const extras = [];
    features.forEach(function (f) {
      const r = repairFeature(f, opts);
      results.push(r.feature);
      if (r.feature.extraRings) {
        r.feature.extraRings.forEach(function (ring) {
          extras.push(Object.assign({}, f, {
            id: f.id + '-part' + (extras.length + 1),
            name: (f.name || f.id) + ' · 拆分 ' + (extras.length + 1),
            points: ring,
          }));
        });
        delete r.feature.extraRings;
      }
    });
    return { features: results.concat(extras), count: results.length + extras.length };
  }

  return {
    R_EARTH: R_EARTH,
    DEFAULT_DUP_TOL_M: DEFAULT_DUP_TOL_M,
    DEFAULT_GAP_TOL_M: DEFAULT_GAP_TOL_M,
    DEFAULT_SNAP_TOL_M: DEFAULT_SNAP_TOL_M,
    RULE_LABELS: RULE_LABELS,
    segIntersect: segIntersect,
    segDistance: segDistance,
    closestOnSegment: closestOnSegment,
    pointInRing: pointInRing,
    ringAreaM2: ringAreaM2,
    ringIsCCW: ringIsCCW,
    haversineM: haversineM,
    pointDistanceM: pointDistanceM,
    bboxOf: bboxOf,
    bboxOverlap: bboxOverlap,
    unwrapLongitudes: unwrapLongitudes,
    crossesAntimeridian: crossesAntimeridian,
    alignRingLon: alignRingLon,
    sampleInside: sampleInside,
    selfIntersections: selfIntersections,
    findDuplicatePoints: findDuplicatePoints,
    removeDuplicatePoints: removeDuplicatePoints,
    isRingClosed: isRingClosed,
    closeRing: closeRing,
    ringsOverlap: ringsOverlap,
    findOverlaps: findOverlaps,
    findGaps: findGaps,
    findUnsnappedCrossings: findUnsnappedCrossings,
    findOutsidePoints: findOutsidePoints,
    checkFeature: checkFeature,
    checkDataset: checkDataset,
    splitRingAt: splitRingAt,
    fixSelfIntersection: fixSelfIntersection,
    repairFeature: repairFeature,
    repairDataset: repairDataset,
  };
});

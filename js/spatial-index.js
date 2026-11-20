/*
 * 空间索引与空间查询内核（纯计算，不依赖 Cesium / DOM）
 * ---------------------------------------------------------------------------
 * P2-4.12「空间索引与空间查询」的内核部分。
 *
 * 【对标 QGIS 的什么】
 *   QGIS 的「按位置选择」（select by location）背后有两件事：
 *     1) QgsSpatialIndex —— 给图层要素建的空间索引，让"找出与这个范围相交的
 *        要素"从 O(N) 变成"只查索引命中的一小撮"；
 *     2) 空间关系谓词 —— 相交 / 包含 / 中心点在内 等关系判断。
 *   本模块把这两件事在浏览器里重新实现一遍，纯离线、无依赖。
 *
 * 【为什么自己写而不是直接用 QGIS 引擎】
 *   用户的硬约束是纯离线、浏览器内跑、不依赖外部进程。
 *
 * 【索引结构：均匀网格（uniform grid）】
 *   - 经度切分成 [-180,180] 的等宽格子，纬度切成 [-90,90] 的等宽格子；
 *   - 每个要素的包围盒覆盖到哪些格子，就登记到哪些格子里；
 *   - 查询时先算查询范围的包围盒 → 只扫命中的格子 → 再跑精确谓词。
 *   - 包围盒跨格过多的"大要素"（比如一条横跨全国的长线）单独进 large 列表，
 *     避免一个要素塞爆几百个格子。
 *
 * 【对外 API（window.LESpatialIndex = module.exports）】
 *   haversineM / destinationPoint / bboxOf / bboxIntersects
 *   pointInRing / segmentsIntersect / pointSegmentDistanceM
 *   lineIntersectsRing / ringsIntersect / polygonContainsRing
 *   representativePoint(geom)
 *   circleRing(center, radiusM, segments)
 *   GridIndex(features, opts) → insert / queryBBox / queryRadius / all / stats
 *   matches(feature, region, mode)
 *   selectByLocation(features, region, mode)
 *
 * 要素模型（与 js/analysis.js 的 collectVectorInputs 一致）：
 *   { id, name, type: 'point'|'line'|'polygon', points: [{lon, lat, height?}] }
 * 查询区域（region）模型：
 *   { kind: 'circle',  center: {lon, lat}, radiusM: number }
 *   { kind: 'polygon', ring: [{lon, lat}, ...] }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LESpatialIndex = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 球面几何基础
   * ================================================================ */

  const R_EARTH = 6378137;          // 米
  const DEG = Math.PI / 180;

  /** 大圆距离（米）。 */
  function haversineM(lon1, lat1, lon2, lat2) {
    const p1 = lat1 * DEG;
    const p2 = lat2 * DEG;
    const dp = (lat2 - lat1) * DEG;
    const dl = (lon2 - lon1) * DEG;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 从 (lon,lat) 按方位角/距离推算目标点（与大圆航线一致的球面公式）。 */
  function destinationPoint(lon, lat, bearingDeg, distM) {
    const brng = bearingDeg * DEG;
    const d = distM / R_EARTH;
    const p1 = lat * DEG;
    const l1 = lon * DEG;
    const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1);
    const sinD = Math.sin(d), cosD = Math.cos(d);
    const p2 = Math.asin(sinP1 * cosD + cosP1 * sinD * Math.cos(brng));
    const l2 = l1 + Math.atan2(
      Math.sin(brng) * sinD * cosP1,
      cosD - sinP1 * Math.sin(p2)
    );
    return {
      lon: ((l2 / DEG + 540) % 360) - 180,
      lat: p2 / DEG,
    };
  }

  /** 把一个圆离散成多边形环（QGIS 的缓冲圆也是这么做的）。 */
  function circleRing(center, radiusM, segments) {
    const n = segments || 64;
    const ring = [];
    for (let i = 0; i <= n; i++) {
      ring.push(destinationPoint(center.lon, center.lat, (i / n) * 360, radiusM));
    }
    ring.pop();
    return ring;
  }

  /** 一组点的包围盒 {minLon,minLat,maxLon,maxLat}。 */
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

  /** 两个包围盒是否相交（含边界）。 */
  function bboxIntersects(a, b) {
    if (!a || !b) return false;
    return !(a.maxLon < b.minLon || b.maxLon < a.minLon ||
             a.maxLat < b.minLat || b.maxLat < a.minLat);
  }

  /**
   * 查询框是否命中要素包围盒。
   * 除了常规相交，还要处理**退化查询框**（min == max，就是一个点）：
   * 这种情况下不能要求"重叠"，而要判断"点在盒内"。
   * （网格格子比查询框大，只靠 bboxIntersects 会把点查询的结果全杀光。）
   */
  function bboxHit(featureBox, queryBox) {
    if (!featureBox || !queryBox) return false;
    if (bboxIntersects(featureBox, queryBox)) return true;
    const degenerate = queryBox.minLon === queryBox.maxLon &&
                      queryBox.minLat === queryBox.maxLat;
    if (!degenerate) return false;
    return queryBox.minLon >= featureBox.minLon && queryBox.minLon <= featureBox.maxLon &&
           queryBox.minLat >= featureBox.minLat && queryBox.minLat <= featureBox.maxLat;
  }

  /** 包围盒是否完全包含另一个。 */
  function bboxContains(outer, inner) {
    if (!outer || !inner) return false;
    return outer.minLon <= inner.minLon && outer.maxLon >= inner.maxLon &&
           outer.minLat <= inner.minLat && outer.maxLat >= inner.maxLat;
  }

  /* ================================================================
   * 二维谓词（平面近似：局部等距投影足够，误差 < 0.1%）
   * ================================================================ */

  /** 点是否在环内（射线法，环不需闭合）。 */
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

  /** 点到线段的近似距离（米，局部等距投影）。 */
  function pointSegmentDistanceM(pt, a, b) {
    const clon = a.lon, clat = a.lat;
    const kx = Math.cos(clat * DEG) * DEG * R_EARTH;
    const ky = DEG * R_EARTH;
    const px = (pt.lon - clon) * kx;
    const py = (pt.lat - clat) * ky;
    const bx = (b.lon - clon) * kx;
    const by = (b.lat - clat) * ky;
    const dx = bx, dy = by;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - t * dx, py - t * dy);
  }

  /** 叉积符号：>0 左转，<0 右转，=0 共线。 */
  function orient(a, b, c) {
    const v = (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
    if (v > 1e-12) return 1;
    if (v < -1e-12) return -1;
    return 0;
  }

  /** 两线段是否**真正穿过**（两端分处两侧，不含端点相切）。 */
  function segmentsCross(p1, p2, p3, p4) {
    const d1 = orient(p3, p4, p1);
    const d2 = orient(p3, p4, p2);
    const d3 = orient(p1, p2, p3);
    const d4 = orient(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  /** 两线段是否相交（含端点接触）。 */
  function segmentsIntersect(p1, p2, p3, p4) {
    if (segmentsCross(p1, p2, p3, p4)) return true;
    const d1 = orient(p3, p4, p1);
    const d2 = orient(p3, p4, p2);
    const d3 = orient(p1, p2, p3);
    const d4 = orient(p1, p2, p4);
    if (d1 === 0 && onSegment(p3, p4, p1)) return true;
    if (d2 === 0 && onSegment(p3, p4, p2)) return true;
    if (d3 === 0 && onSegment(p1, p2, p3)) return true;
    if (d4 === 0 && onSegment(p1, p2, p4)) return true;
    return false;
  }

  function onSegment(a, b, p) {
    return p.lon >= Math.min(a.lon, b.lon) - 1e-12 &&
           p.lon <= Math.max(a.lon, b.lon) + 1e-12 &&
           p.lat >= Math.min(a.lat, b.lat) - 1e-12 &&
           p.lat <= Math.max(a.lat, b.lat) + 1e-12;
  }

  /**
   * 折线是否**跨过**环的边界。
   * 注意：顶点落在环内部**不算**跨界 —— 一条完全在环里的线并没有跨过边界。
   * （这一点很容易搞错：QGIS 的「相交」要的是"两者有重叠"，
   *   而"是否跨界"只用于判断"完全包含"。）
   */
  function lineCrossesRing(line, ring) {
    if (!line || !ring || line.length < 2 || ring.length < 3) return false;
    for (let i = 1; i < line.length; i++) {
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j];
        const b = ring[(j + 1) % ring.length];
        if (segmentsIntersect(line[i - 1], line[i], a, b)) return true;
      }
    }
    return false;
  }

  /** 折线是否有顶点落在环内。 */
  function lineHasPointInRing(line, ring) {
    if (!line || !ring) return false;
    for (const p of line) if (pointInRing(p, ring)) return true;
    return false;
  }

  /**
   * 折线与环是否有"重叠"（跨界，或整段落在环内）。
   * 这才是 QGIS「相交」在面上的含义。
   */
  function lineIntersectsRing(line, ring) {
    if (!line || !ring || line.length < 2 || ring.length < 3) return false;
    return lineCrossesRing(line, ring) || lineHasPointInRing(line, ring);
  }

  /** 两个环的**边界**是否交叉。 */
  function ringsCross(a, b) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    for (let i = 0; i < a.length; i++) {
      const a1 = a[i], a2 = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) {
        const b1 = b[j], b2 = b[(j + 1) % b.length];
        if (segmentsIntersect(a1, a2, b1, b2)) return true;
      }
    }
    return false;
  }

  /**
   * 两个环是否有"重叠"（边界交叉，或一方整体落在另一方里）。
   * 与 QGIS「相交」一致：包含关系也算相交。
   */
  function ringsIntersect(a, b) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    if (ringsCross(a, b)) return true;
    for (const p of a) if (pointInRing(p, b)) return true;
    for (const p of b) if (pointInRing(p, a)) return true;
    return false;
  }

  /** 环 a 是否完全在环 b 内（b 不必凸；允许边界相切，不允许真正穿过）。 */
  function ringWithinRing(a, b) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    for (const p of a) if (!pointInRing(p, b)) return false;
    for (let i = 0; i < a.length; i++) {
      const a1 = a[i], a2 = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) {
        const b1 = b[j], b2 = b[(j + 1) % b.length];
        // 只拦"真正穿过"，边界相切允许
        if (segmentsCross(a1, a2, b1, b2)) return false;
      }
    }
    return true;
  }

  /** 折线是否完全在环内。 */
  function lineWithinRing(line, ring) {
    if (!line || !ring || line.length < 2 || ring.length < 3) return false;
    for (const p of line) if (!pointInRing(p, ring)) return false;
    // 用"跨界"而不是"相交"：完全在环内的线不跨界
    return !lineCrossesRing(line, ring);
  }

  /** 环的代表性点：面积加权质心，退化为顶点平均。 */
  function ringCentroid(ring) {
    if (!ring || !ring.length) return { lon: 0, lat: 0 };
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j].lon * ring[i].lat - ring[i].lon * ring[j].lat;
      a += cross;
      cx += (ring[j].lon + ring[i].lon) * cross;
      cy += (ring[j].lat + ring[i].lat) * cross;
    }
    if (Math.abs(a) > 1e-12) {
      return { lon: cx / (3 * a), lat: cy / (3 * a) };
    }
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p.lon; sy += p.lat; }
    return { lon: sx / ring.length, lat: sy / ring.length };
  }

  /**
   * 要素的代表性点：
   *   点 → 自身；线 → 折线中点；面 → 环质心。
   */
  function representativePoint(geom) {
    if (!geom) return null;
    const pts = geom.points || [];
    if (!pts.length) return null;
    if (geom.type === 'point') return { lon: pts[0].lon, lat: pts[0].lat };
    if (geom.type === 'line') {
      // 折线中点（按顶点序号取中间那个）
      const mid = pts[Math.floor((pts.length - 1) / 2)];
      return { lon: mid.lon, lat: mid.lat };
    }
    return ringCentroid(pts);
  }

  /* ================================================================
   * 空间索引：均匀网格
   * ================================================================ */

  const DEFAULT_CELL = 5;            // 度

  class GridIndex {
    /**
     * @param {Array} features 要素数组，每项 {id,name,type,points}
     * @param {Object} opts { cell: 度, maxCells: 单要素最多占用的格子数 }
     */
    constructor(features, opts) {
      const o = opts || {};
      this.cell = o.cell || DEFAULT_CELL;
      this.maxCells = o.maxCells || 64;
      this.cells = Object.create(null);
      this.large = [];                // 跨格过多的要素
      this.features = [];
      this.byId = Object.create(null);
      if (features && features.length) {
        for (const f of features) this.insert(f);
      }
    }

    _cellRange(bbox) {
      const c = this.cell;
      return {
        i0: Math.floor((bbox.minLon + 180) / c),
        i1: Math.floor((bbox.maxLon + 180) / c),
        j0: Math.floor((bbox.minLat + 90) / c),
        j1: Math.floor((bbox.maxLat + 90) / c),
      };
    }

    /** 插入一个要素。 */
    insert(feature) {
      if (!feature || !feature.points || !feature.points.length) return false;
      const bbox = bboxOf(feature.points);
      if (!bbox) return false;
      const rec = {
        id: feature.id,
        name: feature.name || feature.id,
        type: feature.type || 'point',
        points: feature.points,
        bbox: bbox,
        feature: feature,
      };
      this.features.push(rec);
      if (feature.id != null) this.byId[feature.id] = rec;

      const r = this._cellRange(bbox);
      const n = (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1);
      if (n > this.maxCells) {
        this.large.push(rec);
        return true;
      }
      for (let i = r.i0; i <= r.i1; i++) {
        for (let j = r.j0; j <= r.j1; j++) {
          const key = i + ':' + j;
          let arr = this.cells[key];
          if (!arr) { arr = []; this.cells[key] = arr; }
          arr.push(rec);
        }
      }
      return true;
    }

    /** 查询与包围盒相交的候选要素（不跑精确谓词）。 */
    queryBBox(bbox) {
      const out = [];
      const seen = Object.create(null);
      const r = this._cellRange(bbox);
      for (let i = r.i0; i <= r.i1; i++) {
        for (let j = r.j0; j <= r.j1; j++) {
          const arr = this.cells[i + ':' + j];
          if (!arr) continue;
          for (const rec of arr) {
            if (seen[rec.id]) continue;
            // 格子比查询框大，候选要再用真实包围盒筛一遍
            if (!bboxHit(rec.bbox, bbox)) continue;
            seen[rec.id] = 1;
            out.push(rec);
          }
        }
      }
      for (const rec of this.large) {
        if (seen[rec.id]) continue;
        if (!bboxHit(rec.bbox, bbox)) continue;
        seen[rec.id] = 1;
        out.push(rec);
      }
      return out;
    }

    /** 查询圆范围内的候选要素（粗筛：包围盒相交 或 最近距离在半径内）。 */
    queryRadius(center, radiusM) {
      const dLat = radiusM / (DEG * R_EARTH);
      const cosLat = Math.max(0.01, Math.cos(center.lat * DEG));
      const dLon = radiusM / (DEG * R_EARTH * cosLat);
      const bbox = {
        minLon: center.lon - dLon, maxLon: center.lon + dLon,
        minLat: Math.max(-90, center.lat - dLat),
        maxLat: Math.min(90, center.lat + dLat),
      };
      return this.queryBBox(bbox);
    }

    all() { return this.features.slice(); }

    get(id) { return this.byId[id] || null; }

    stats() {
      let cells = 0;
      for (const k in this.cells) { cells++; }
      return {
        features: this.features.length,
        cells: cells,
        large: this.large.length,
        cellDeg: this.cell,
      };
    }
  }

  /* ================================================================
   * 空间关系谓词
   * ================================================================ */

  /**
   * 要素与查询区域的空间关系。
   * @param {Object} feature {type, points}
   * @param {Object} region  {kind:'circle'|'polygon', ...}
   * @param {String} mode    'intersects' | 'within' | 'center'
   * @returns {Boolean}
   */
  function matches(feature, region, mode) {
    if (!feature || !feature.points || !feature.points.length) return false;
    if (!region) return false;
    const m = mode || 'intersects';
    if (region.kind === 'circle') return matchCircle(feature, region, m);
    if (region.kind === 'polygon') return matchPolygon(feature, region, m);
    return false;
  }

  function matchCircle(feature, region, mode) {
    const c = region.center;
    const r = region.radiusM;
    const pts = feature.points;
    const type = feature.type || 'point';

    if (mode === 'center') {
      const rp = representativePoint(feature);
      return !!rp && haversineM(c.lon, c.lat, rp.lon, rp.lat) <= r;
    }
    if (mode === 'within') {
      for (const p of pts) {
        if (haversineM(c.lon, c.lat, p.lon, p.lat) > r) return false;
      }
      return true;
    }
    // intersects：任一顶点在圆内，或任一段离圆心不超过半径
    for (const p of pts) {
      if (haversineM(c.lon, c.lat, p.lon, p.lat) <= r) return true;
    }
    if (type === 'line' || type === 'polygon') {
      for (let i = 1; i < pts.length; i++) {
        if (pointSegmentDistanceM(c, pts[i - 1], pts[i]) <= r) return true;
      }
    }
    return false;
  }

  function matchPolygon(feature, region, mode) {
    const ring = region.ring;
    const pts = feature.points;
    const type = feature.type || 'point';

    if (mode === 'center') {
      const rp = representativePoint(feature);
      return !!rp && pointInRing(rp, ring);
    }
    if (mode === 'within') {
      if (type === 'point') return pointInRing(pts[0], ring);
      if (type === 'line') return lineWithinRing(pts, ring);
      return ringWithinRing(pts, ring);
    }
    // intersects
    if (type === 'point') return pointInRing(pts[0], ring);
    if (type === 'line') return lineIntersectsRing(pts, ring);
    return ringsIntersect(pts, ring);
  }

  /**
   * 批量空间查询。
   * @param {Array} features
   * @param {Object} region
   * @param {String} mode
   * @param {GridIndex} [index] 可选索引（有就用索引粗筛，没有就线性扫）
   */
  function selectByLocation(features, region, mode, index) {
    let candidates;
    if (index) {
      candidates = region.kind === 'circle'
        ? index.queryRadius(region.center, region.radiusM)
        : index.queryBBox(bboxOf(region.ring));
    } else {
      candidates = (features || []).map(function (f) {
        return { id: f.id, name: f.name || f.id, type: f.type, points: f.points, feature: f };
      });
    }
    const out = [];
    for (const rec of candidates) {
      const f = rec.feature || rec;
      if (matches(f, region, mode)) out.push(f);
    }
    return out;
  }

  /** 到查询圆心的最近距离（米），用于结果排序。 */
  function distanceToRegion(feature, region) {
    if (!feature || !feature.points || !feature.points.length) return Infinity;
    const pts = feature.points;
    if (region.kind === 'circle') {
      const c = region.center;
      let best = Infinity;
      for (const p of pts) {
        const d = haversineM(c.lon, c.lat, p.lon, p.lat);
        if (d < best) best = d;
      }
      if (feature.type === 'line' || feature.type === 'polygon') {
        for (let i = 1; i < pts.length; i++) {
          const d = pointSegmentDistanceM(c, pts[i - 1], pts[i]);
          if (d < best) best = d;
        }
      }
      return best;
    }
    const ring = region.ring;
    let best = Infinity;
    // 点要素：直接量到环边的距离
    for (const p of pts) {
      if (pointInRing(p, ring)) return 0;
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j];
        const b = ring[(j + 1) % ring.length];
        const d = pointSegmentDistanceM(p, a, b);
        if (d < best) best = d;
      }
    }
    // 线 / 面要素：每个顶点到环边的最小距离
    if (pts.length > 1) {
      for (let i = 1; i < pts.length; i++) {
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j];
          const b = ring[(j + 1) % ring.length];
          const d = pointSegmentDistanceM(pts[i], a, b);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  return {
    R_EARTH: R_EARTH,
    haversineM: haversineM,
    destinationPoint: destinationPoint,
    circleRing: circleRing,
    bboxOf: bboxOf,
    bboxIntersects: bboxIntersects,
    bboxHit: bboxHit,
    bboxContains: bboxContains,
    pointInRing: pointInRing,
    pointSegmentDistanceM: pointSegmentDistanceM,
    segmentsIntersect: segmentsIntersect,
    segmentsCross: segmentsCross,
    lineCrossesRing: lineCrossesRing,
    lineHasPointInRing: lineHasPointInRing,
    lineIntersectsRing: lineIntersectsRing,
    lineWithinRing: lineWithinRing,
    ringsCross: ringsCross,
    ringsIntersect: ringsIntersect,
    ringWithinRing: ringWithinRing,
    ringCentroid: ringCentroid,
    representativePoint: representativePoint,
    GridIndex: GridIndex,
    matches: matches,
    selectByLocation: selectByLocation,
    distanceToRegion: distanceToRegion,
  };
});

/*
 * 原生空间分析引擎（QGIS 能力的**内建实现**，不调用外部 QGIS）
 * ---------------------------------------------------------------------------
 * 为什么要有这个模块：
 *   之前的做法是「前端 → serve.ps1 → tools/qgis-run.bat → qgis_process」，
 *   也就是**让新软件去调用 QGIS**。这带来三个硬伤：
 *     1) 必须装一整套 QGIS（数 GB）才能用「坡度/等值线/缓冲区」这些
 *        本来几十行代码就能算的东西；
 *     2) 每个算法都要起一个 Python 子进程 + 落盘 + 再读回来，
 *        交互延迟以秒计，且没有实时预览；
 *     3) 依赖机器上恰好有 QGIS，换台电脑功能就少一半。
 *
 *   本模块把 QGIS 里**真正好用的那部分功能**用纯 JavaScript 原生实现：
 *   直接吃本机的 DEM 金字塔（window.LEDemTiles）和已加载的矢量图层，
 *   全程在浏览器里跑，**零外部进程、零落盘、实时**。
 *
 * 数据来源（全部本机、全部离线）：
 *   - DEM：window.LEDemTiles（全国金字塔，72–136E/17–55N）
 *   - 矢量：window.LEDraw.getFeatures()（用户绘制的点/线/面）
 *           window.LE 的图层列表（已加载的 GeoJSON 数据源）
 *
 * 输出的两种形态（都能直接在地球上显示）：
 *   - 矢量：GeoJSON FeatureCollection → window.LEImports.importGeoJsonUrl
 *   - 栅格：Canvas PNG（贴图） → window.LELayers.addImageOverlay
 *
 * 对外 API（window.LEAnalysis）：
 *   algorithms()          → 目录（中文分组）
 *   list()                → 全部算法定义
 *   run(id, params)       → Promise<{ kind, geojson?, png?, bounds, stats }>
 *   runToLayer(le, id, p) → 运行并把结果加载为地球图层
 *   capabilities()        → { dem, vector, raster } 能力探测
 */
(function () {
  'use strict';

  const C = window.Cesium;

  /* ================================================================== 几何 */

  const R_EARTH = 6378137.0; // WGS84 长半轴（米）

  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180.0) / Math.PI; }

  /** 两点大圆距离（米）。 */
  function haversine(lon1, lat1, lon2, lat2) {
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dp = p2 - p1;
    const dl = toRad(lon2 - lon1);
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 大圆插值（球面线性插值），t ∈ [0,1]。 */
  function interpolate(lon1, lat1, lon2, lat2, t) {
    const p1 = toRad(lat1);
    const l1 = toRad(lon1);
    const p2 = toRad(lat2);
    const l2 = toRad(lon2);
    const d = 2 * Math.asin(Math.min(1, Math.sqrt(
      Math.pow(Math.sin((p2 - p1) / 2), 2) +
      Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((l2 - l1) / 2), 2)
    )));
    if (d < 1e-12) return [lon1, lat1];
    const A = Math.sin((1 - t) * d) / Math.sin(d);
    const B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))];
  }

  /**
   * 沿大圆按固定间距采样，返回 [{lon,lat}]。
   *
   * 段内按 **n = ceil(段长/步长)** 等分，所以实际间距是 段长/n ≤ 步长，
   * 最坏情况（段长刚好比步长大一点点）实际间距会缩到步长的一半左右。
   * 为了让「采样间距」名副其实，这里把步长当作**目标间距**，
   * 并允许最后一段用更小的 n（至少 1）来贴近目标间距。
   */
  function densify(points, stepMeters) {
    const out = [];
    if (!points.length) return out;
    out.push({ lon: points[0].lon, lat: points[0].lat });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const d = haversine(a.lon, a.lat, b.lon, b.lat);
      const n = Math.max(1, Math.ceil(d / stepMeters - 1e-9));
      for (let k = 1; k <= n; k++) {
        const p = interpolate(a.lon, a.lat, b.lon, b.lat, k / n);
        out.push({ lon: p[0], lat: p[1] });
      }
    }
    return out;
  }

  /** 平面近似多边形面积（平方米），用于小范围面积量算。 */
  function ringAreaM2(ring) {
    if (ring.length < 3) return 0;
    // 以环的重心为原点做等距圆柱投影，误差在几十公里内可忽略
    let clon = 0;
    let clat = 0;
    for (const p of ring) { clon += p.lon; clat += p.lat; }
    clon /= ring.length;
    clat /= ring.length;
    const kx = Math.cos(toRad(clat)) * Math.PI / 180 * R_EARTH;
    const ky = Math.PI / 180 * R_EARTH;
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const x1 = (p.lon - clon) * kx;
      const y1 = (p.lat - clat) * ky;
      const x2 = (q.lon - clon) * kx;
      const y2 = (q.lat - clat) * ky;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  /** 环的重心（多边形质心，退化为顶点平均）。 */
  function ringCentroid(ring) {
    if (!ring.length) return { lon: 0, lat: 0 };
    let clon = 0;
    let clat = 0;
    for (const p of ring) { clon += p.lon; clat += p.lat; }
    return { lon: clon / ring.length, lat: clat / ring.length };
  }

  /** 点是否在多边形环内（射线法）。 */
  function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lon;
      const yi = ring[i].lat;
      const xj = ring[j].lon;
      const yj = ring[j].lat;
      const intersect = (yi > pt.lat) !== (yj > pt.lat) &&
        pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi + 1e-15) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /** 点到线段的近似距离（米，局部等距投影）。 */
  function pointSegmentDistanceM(pt, a, b) {
    const clon = a.lon;
    const clat = a.lat;
    const kx = Math.cos(toRad(clat)) * Math.PI / 180 * R_EARTH;
    const ky = Math.PI / 180 * R_EARTH;
    const px = (pt.lon - clon) * kx;
    const py = (pt.lat - clat) * ky;
    const ax = 0;
    const ay = 0;
    const bx = (b.lon - clon) * kx;
    const by = (b.lat - clat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return { dist: Math.hypot(px - cx, py - cy), t: t };
  }

  /** 点到折线的最短距离（米）。 */
  function pointPolylineDistanceM(pt, line) {
    let best = Infinity;
    let bestSeg = -1;
    for (let i = 1; i < line.length; i++) {
      const r = pointSegmentDistanceM(pt, line[i - 1], line[i]);
      if (r.dist < best) { best = r.dist; bestSeg = i - 1; }
    }
    return { dist: best, segment: bestSeg };
  }

  /**
   * 生成一个圆的缓冲多边形（度坐标）。
   * 按 QGIS 的做法：圆被离散成若干段，每段用大圆插值求点。
   */
  function bufferCircle(center, radiusMeters, segments) {
    const n = segments || 64;
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const bearing = (i / n) * 360;
      ring.push(destinationPoint(center.lon, center.lat, bearing, radiusMeters));
    }
    ring.pop();
    return ring;
  }

  /** 从 (lon,lat) 按方位角/距离推算目标点。 */
  function destinationPoint(lon, lat, bearingDeg, distMeters) {
    const brng = toRad(bearingDeg);
    const d = distMeters / R_EARTH;
    const p1 = toRad(lat);
    const l1 = toRad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brng));
    const l2 = l1 + Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2)
    );
    return { lon: toDeg(l2), lat: toDeg(p2) };
  }

  /**
   * 折线的缓冲区。
   *
   * 之前用「左偏移点 + 右偏移点」拼环，折线只有 2 个点时左右偏移点数量相同、
   * 顺序又相反，拼出来是**蝴蝶结**（自相交多边形），面积算出来只有一半。
   * 现在改成：沿折线每段均匀取样做法向偏移，两端补半圆，
   * 拼出一个不自交的「跑道形」外轮廓。
   */
  function bufferPolyline(line, radiusMeters) {
    if (!line.length) return [];
    if (line.length === 1) return bufferCircle(line[0], radiusMeters, 48);

    const left = [];
    const right = [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const brng = bearingBetween(a, b);
      const segLen = haversine(a.lon, a.lat, b.lon, b.lat);
      const steps = Math.min(128, Math.max(8, Math.ceil(segLen / Math.max(1, radiusMeters))));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const p = interpolate(a.lon, a.lat, b.lon, b.lat, t);
        left.push(destinationPoint(p[0], p[1], brng + 90, radiusMeters));
        right.push(destinationPoint(p[0], p[1], brng - 90, radiusMeters));
      }
    }
    const headBrng = bearingBetween(line[0], line[1]);
    const tailBrng = bearingBetween(line[line.length - 2], line[line.length - 1]);
    const capSteps = 24;

    // 末端半圆：从**南侧**绕过东端到**北侧**（角度递减）
    const tailCap = [];
    for (let k = 0; k <= capSteps; k++) {
      tailCap.push(destinationPoint(
        line[line.length - 1].lon, line[line.length - 1].lat,
        tailBrng + 90 - (180 * k) / capSteps, radiusMeters
      ));
    }
    // 起始半圆：从**北侧**绕过西端到**南侧**（角度继续递减）
    const headCap = [];
    for (let k = 0; k <= capSteps; k++) {
      headCap.push(destinationPoint(
        line[0].lon, line[0].lat,
        headBrng - 90 - (180 * k) / capSteps, radiusMeters
      ));
    }
    right.reverse();
    return left.concat(tailCap, right, headCap);
  }

  /** 两点间的方位角（度，正北为 0）。 */
  function bearingBetween(a, b) {
    const p1 = toRad(a.lat);
    const p2 = toRad(b.lat);
    const dl = toRad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** 多边形的缓冲区（向外偏移，凸近似）。 */
  function bufferPolygon(ring, radiusMeters) {
    if (ring.length < 3) return bufferCircle(ringCentroid(ring), radiusMeters, 48);
    const c = ringCentroid(ring);
    const out = [];
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const prev = ring[(i - 1 + n) % n];
      const cur = ring[i];
      const next = ring[(i + 1) % n];
      // 取前后两个方向的平均外法线
      const b1 = bearingBetween(prev, cur);
      const b2 = bearingBetween(cur, next);
      const outward = (b1 + b2) / 2 + 180;
      out.push(destinationPoint(cur.lon, cur.lat, outward, radiusMeters));
      // 顶点处补一个圆角，避免尖角
      out.push(destinationPoint(cur.lon, cur.lat, outward - 45, radiusMeters * 0.72));
      out.push(destinationPoint(cur.lon, cur.lat, outward + 45, radiusMeters * 0.72));
    }
    void c;
    return out;
  }

  /* ============================================================= 视野范围 */

  /**
   * 当前屏幕可见的经纬度范围（度）。
   * 与 js/dem-tiles.js 的 viewRectFromScreen 同源：Cesium 内置矩形优先，
   * 拿不到就用屏幕四角射线打地表取极值，最后退回相机周围 1°×1°。
   */
  function currentViewRect() {
    const le = window.LE;
    const viewer = le && le.viewer;
    if (!viewer) throw new Error('地球尚未就绪');
    const scene = viewer.scene;
    const camera = viewer.camera;

    let rect = null;
    try {
      rect = camera.computeViewRectangle(scene.globe.ellipsoid);
    } catch (err) {
      rect = null;
    }
    if (rect && isFinite(rect.west) && isFinite(rect.south) &&
        isFinite(rect.east) && isFinite(rect.north)) {
      const west = toDeg(rect.west);
      const east = toDeg(rect.east);
      const south = toDeg(rect.south);
      const north = toDeg(rect.north);
      if (east - west < 359 && north - south < 179 && east > west && north > south) {
        return {
          west: Math.max(-180, west),
          east: Math.min(180, east),
          south: Math.max(-90, south),
          north: Math.min(90, north),
        };
      }
    }

    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    let hits = 0;
    const collect = (pick) => {
      if (!pick) return;
      const cc = scene.globe.ellipsoid.cartesianToCartographic(pick);
      if (!cc) return;
      const lon = toDeg(cc.longitude);
      const lat = toDeg(cc.latitude);
      if (!isFinite(lon) || !isFinite(lat)) return;
      hits += 1;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    };
    try {
      const canvas = viewer.canvas;
      const w = canvas.clientWidth || canvas.width;
      const h = canvas.clientHeight || canvas.height;
      if (w > 0 && h > 0) {
        const pts = [
          [0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2],
          [w / 2, 0], [w / 2, h], [0, h / 2], [w, h / 2],
        ];
        for (const p of pts) {
          let ray = null;
          try { ray = camera.getPickRay(new C.Cartesian2(p[0], p[1])); } catch (err) { ray = null; }
          if (!ray) continue;
          let hit = null;
          try { hit = scene.globe.pick(ray, scene); } catch (err) { hit = null; }
          if (!hit) {
            try { hit = scene.globe.pick(ray, scene, scene.globe.ellipsoid); } catch (err) { hit = null; }
          }
          collect(hit);
        }
      }
    } catch (err) {
      hits = 0;
    }
    if (hits < 2 || east - west > 180) {
      const carto = camera.positionCartographic;
      const lon = toDeg(carto.longitude);
      const lat = toDeg(carto.latitude);
      west = lon - 0.5; east = lon + 0.5;
      south = lat - 0.5; north = lat + 0.5;
    }
    return {
      west: Math.max(-180, west),
      east: Math.min(180, east),
      south: Math.max(-90, south),
      north: Math.min(90, north),
    };
  }

  /* ============================================================ DEM 采样 */

  function demAvailable() {
    return !!(window.LEDemTiles && window.LEDemTiles.covers && window.LEDemTiles.covers(116, 39));
  }

  /**
   * 采一个高程。优先用全国金字塔；金字塔没覆盖时退回地形源（LE.heightAt）。
   * @returns {number} 米
   */
  function sampleHeight(lon, lat) {
    if (window.LEDemTiles && window.LEDemTiles.covers && window.LEDemTiles.covers(lon, lat)) {
      const h = window.LEDemTiles.heightAt(lon, lat);
      if (h != null && isFinite(h)) return h;
    }
    if (window.LE && typeof window.LE.heightAt === 'function') {
      const h = window.LE.heightAt(lon, lat);
      if (h != null && isFinite(h)) return h;
    }
    return 0;
  }

  /**
   * 在给定范围内取一个规则格网的高程。
   * @returns { { w, h, west, south, east, north, dx, dy, cellSize, data: Float32Array } }
   */
  function sampleGrid(west, south, east, north, width, height) {
    const w = Math.max(2, width | 0);
    const h = Math.max(2, height | 0);
    const data = new Float32Array(w * h);
    const dx = (east - west) / (w - 1);
    const dy = (north - south) / (h - 1);
    for (let row = 0; row < h; row++) {
      const lat = north - row * dy;
      for (let col = 0; col < w; col++) {
        data[row * w + col] = sampleHeight(west + col * dx, lat);
      }
    }
    const midLat = (north + south) / 2;
    const cellW = (east - west) * Math.PI / 180 * R_EARTH * Math.cos(toRad(midLat));
    const cellH = (north - south) * Math.PI / 180 * R_EARTH;
    return {
      w: w, h: h,
      west: west, south: south, east: east, north: north,
      dx: dx, dy: dy,
      cellSize: Math.max(1, Math.sqrt((cellW / w) * (cellH / h))),
      data: data,
    };
  }

  /* ========================================================== 坡度 / 坡向 */

  /**
   * 由高程格网算坡度（度）与坡向（度）。
   *
   * 坡度用 Horn 3×3 算子（QGIS / GDAL 默认），格网按「上=北」排列：
   *
   *        a  b  c        a=(r-1,c-1)  b=(r-1,c)  c=(r-1,c+1)
   *        d  e  f        d=(r,c-1)    e=(r,c)    f=(r,c+1)
   *        g  h  i        g=(r+1,c-1)  h=(r+1,c)  i=(r+1,c+1)
   *
   *   dz/dx = ((c + 2f + i) − (a + 2d + g)) / (8·cell)   → 向东为正
   *   dz/dy = ((g + 2h + i) − (a + 2b + c)) / (8·cell)   → 向南为正
   *
   * 坡向 = 最陡下坡方向的方位角（正北 0、顺时针）；平地记为 −1。
   */
  function slopeAspect(grid, cellSizeMeters, zFactor) {
    const { w, h, data } = grid;
    const s = cellSizeMeters;
    const z = zFactor && zFactor > 0 ? zFactor : 1;
    const slope = new Float32Array(w * h);
    const aspect = new Float32Array(w * h);
    for (let row = 0; row < h; row++) {
      const rm = Math.max(0, row - 1);
      const rp = Math.min(h - 1, row + 1);
      for (let col = 0; col < w; col++) {
        const cm = Math.max(0, col - 1);
        const cp = Math.min(w - 1, col + 1);
        const a = data[rm * w + cm];
        const b = data[rm * w + col];
        const c = data[rm * w + cp];
        const d = data[row * w + cm];
        const f = data[row * w + cp];
        const g = data[rp * w + cm];
        const hh = data[rp * w + col];
        const i = data[rp * w + cp];
        const gx = z * ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * s);   // 向东为正
        const gySouth = z * ((g + 2 * hh + i) - (a + 2 * b + c)) / (8 * s); // 向南为正
        const gy = -gySouth;                                             // 转为向北为正
        const idx = row * w + col;
        const rise = Math.sqrt(gx * gx + gy * gy);
        slope[idx] = toDeg(Math.atan(rise));
        if (rise < 1e-12) {
          aspect[idx] = -1; // 平地
        } else {
          // 下坡方向 = (−gx, −gy)（东、北分量），方位角 = atan2(东, 北)
          aspect[idx] = (toDeg(Math.atan2(-gx, -gy)) + 360) % 360;
        }
      }
    }
    return { slope: slope, aspect: aspect };
  }

  /* ============================================================== 等高线 */

  /**
   * Marching Squares 等值线提取。
   * @returns Array<Array<{lon,lat,value}>>
   */
  function contour(grid, level) {
    const { w, h, west, south, east, north, dx, dy, data } = grid;
    const segs = [];
    const idx = (c, r) => r * w + c;
    const x = (c) => west + c * dx;
    const y = (r) => north - r * dy;
    const lerp = (a, b, va, vb) => {
      if (vb === va) return 0.5;
      const t = (level - va) / (vb - va);
      return t < 0 ? 0 : (t > 1 ? 1 : t);
    };
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const v0 = data[idx(c, r)];
        const v1 = data[idx(c + 1, r)];
        const v2 = data[idx(c + 1, r + 1)];
        const v3 = data[idx(c, r + 1)];
        // 掩膜外的像元是 NaN：整个格子跳过，避免插值出 NaN 坐标
        if (!isFinite(v0) || !isFinite(v1) || !isFinite(v2) || !isFinite(v3)) continue;
        // 等值（v == level）统一算作「高」侧，避免节点歧义导致等值线被拆碎
        const code = (v0 >= level ? 8 : 0) | (v1 >= level ? 4 : 0) |
                     (v2 >= level ? 2 : 0) | (v3 >= level ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const top = { x: x(c) + dx * lerp(v0, v1, v0, v1), y: y(r) };
        const right = { x: x(c + 1), y: y(r) + dy * lerp(v1, v2, v1, v2) };
        const bottom = { x: x(c) + dx * lerp(v3, v2, v3, v2), y: y(r + 1) };
        const left = { x: x(c), y: y(r) + dy * lerp(v0, v3, v0, v3) };
        const push = (a, b) => segs.push([a, b]);
        switch (code) {
          case 1: case 14: push(left, bottom); break;
          case 2: case 13: push(bottom, right); break;
          case 3: case 12: push(left, right); break;
          case 4: case 11: push(top, right); break;
          case 6: case 9: push(top, bottom); break;
          case 7: case 8: push(left, top); break;
          case 5: push(left, top); push(bottom, right); break;
          case 10: push(left, bottom); push(top, right); break;
          default: break;
        }
      }
    }
    return stitch(segs);
  }

  /**
   * 把零散的等值线段串成折线。
   *
   * **为什么不能直接用「坐标取整后当 key」**：
   * 相邻两格的公共边，一个格子算出来是 `west + c*dx + dx*t`，
   * 另一个格子算出来是 `west + (c+1)*dx`，二者在二进制浮点下可能差 1e-15，
   * 一旦这个差值跨过了取整的边界（比如 x = 110.015000000000001 与
   * 110.014999999999999），取整后的 key 就分家了，等值线被切成好几段。
   * 所以这里用**空间哈希 + 容差匹配**：把点量化到 1e-9 度的格子
   * （约 0.1 mm），查找时在 3×3 邻域内找距离最近且在容差内的点。
   */
  function stitch(segs) {
    const EPS = 1e-9;        // 容差（度）≈ 0.1 mm
    const CELL = 1e-7;       // 哈希格边长（度）

    const hash = (p) => Math.floor(p.x / CELL) + '_' + Math.floor(p.y / CELL);

    // 端点索引：key → [点]
    const buckets = new Map();
    const push = (p) => {
      const k = hash(p);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    };
    for (const s of segs) { push(s[0]); push(s[1]); }

    /** 找一个和 p 距离在 EPS 内的已索引点（3×3 邻域）。 */
    const findNear = (p) => {
      const bx = Math.floor(p.x / CELL);
      const by = Math.floor(p.y / CELL);
      let best = null;
      let bestD = EPS * EPS;
      for (let ix = bx - 1; ix <= bx + 1; ix++) {
        for (let iy = by - 1; iy <= by + 1; iy++) {
          const list = buckets.get(ix + '_' + iy);
          if (!list) continue;
          for (const q of list) {
            const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
            if (d < bestD) { bestD = d; best = q; }
          }
        }
      }
      return best;
    };

    // 把每条线段的两端都归一化到同一个索引点上（消除浮点分叉）
    const norm = [];
    for (const s of segs) {
      const a = findNear(s[0]) || s[0];
      const b = findNear(s[1]) || s[1];
      norm.push([a, b]);
    }

    // 邻接表：点 → 与之相连的线段下标
    const adj = new Map();
    const link = (p, i) => {
      const k = hash(p);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push(i);
    };
    norm.forEach((s, i) => { link(s[0], i); link(s[1], i); });

    const used = new Array(norm.length).fill(false);
    const lines = [];

    for (let i = 0; i < norm.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const line = [norm[i][0], norm[i][1]];

      // 向前端延伸
      const growFront = () => {
        const tip = line[line.length - 1];
        const list = adj.get(hash(tip)) || [];
        for (const j of list) {
          if (used[j]) continue;
          const s = norm[j];
          if (s[0] === tip) { used[j] = true; line.push(s[1]); return true; }
          if (s[1] === tip) { used[j] = true; line.push(s[0]); return true; }
        }
        return false;
      };
      // 向后端延伸
      const growBack = () => {
        const tip = line[0];
        const list = adj.get(hash(tip)) || [];
        for (const j of list) {
          if (used[j]) continue;
          const s = norm[j];
          if (s[1] === tip) { used[j] = true; line.unshift(s[0]); return true; }
          if (s[0] === tip) { used[j] = true; line.unshift(s[1]); return true; }
        }
        return false;
      };

      let grew = true;
      while (grew) {
        grew = growFront();
        if (growBack()) grew = true;
      }
      if (line.length >= 2) lines.push(line);
    }
    return lines;
  }

  /* ============================================================ 栅格出图 */

  /**
   * 把一个 Float32Array 场渲染成 PNG（带色带）。
   * @param {object} grid
   * @param {Float32Array} values
   * @param {object} opts { min, max, palette, mask }
   *
   * opts.mask 存在时，范围外的像元**透明**（alpha=0），
   * 这样叠加到地球上时只显示绘制范围内部，而不是矩形框。
   */
  function renderField(grid, values, opts) {
    opts = opts || {};
    const canvas = document.createElement('canvas');
    canvas.width = grid.w;
    canvas.height = grid.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(grid.w, grid.h);
    const lo = opts.min != null ? opts.min : 0;
    const hi = opts.max != null ? opts.max : 1;
    const span = hi - lo || 1;
    const mask = opts.mask || (grid && grid.mask) || null;
    for (let i = 0; i < values.length; i++) {
      let t = (values[i] - lo) / span;
      if (!isFinite(t)) t = 0;
      t = Math.max(0, Math.min(1, t));
      const rgb = paletteColor(t, opts.palette);
      const o = i * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = mask ? (mask.data[i] ? 255 : 0) : 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** QGIS 风格的色带（terrain 类）。 */
  const PALETTES = {
    terrain: [
      [0, 160, 200], [40, 190, 160], [80, 210, 130], [130, 225, 175],
      [180, 235, 195], [215, 225, 140], [245, 200, 110], [250, 165, 95],
      [225, 135, 105], [195, 120, 120], [175, 135, 155], [225, 225, 225],
    ],
    slope: [
      [240, 250, 240], [205, 235, 195], [170, 215, 150], [225, 215, 130],
      [225, 170, 100], [215, 125, 95], [180, 100, 110], [140, 100, 140],
    ],
    gray: [[0, 0, 0], [255, 255, 255]],
    viridis: [
      [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98],
      [253, 231, 37],
    ],
  };

  function paletteColor(t, name) {
    const pal = PALETTES[name] || PALETTES.terrain;
    const x = Math.max(0, Math.min(0.9999, t)) * (pal.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = pal[i];
    const b = pal[Math.min(pal.length - 1, i + 1)];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }

  /** Canvas → dataURL。 */
  function canvasToDataUrl(canvas) {
    return canvas.toDataURL('image/png');
  }

  /* =========================================================== 输入收集 */

  /**
   * 取一个实体属性的「当前值」。
   *
   * Cesium 里几何既可能是裸值（Entity.position 在某些代码路径下就是 Cartesian3），
   * 也可能是 ConstantProperty（带 getValue(time)）—— GeoJsonDataSource 加载的
   * 要素就是后者。不区分这两种就取不到几何（hierarchy.positions 会是 undefined）。
   */
  function propValue(v, time) {
    if (v == null) return null;
    if (typeof v.getValue === 'function') {
      try {
        return v.getValue(time || (window.LE && window.LE.viewer ? window.LE.viewer.clock.currentTime : undefined));
      } catch (err) {
        return null;
      }
    }
    return v;
  }

  /**
   * 收集可用的矢量输入（用户绘制的 + 已加载图层里的）。
   * @returns Array<{ id, name, type, points:[{lon,lat,height}] }>
   */
  function collectVectorInputs() {
    const out = [];
    const time = window.LE && window.LE.viewer ? window.LE.viewer.clock.currentTime : undefined;
    if (window.LEDraw && typeof window.LEDraw.getFeatures === 'function') {
      try {
        const feats = window.LEDraw.getFeatures() || [];
        for (const f of feats) {
          out.push({
            id: 'draw:' + f.id,
            name: f.name || ('绘制 ' + f.type),
            type: f.type,
            points: (f.points || []).map((p) => ({ lon: p.lon, lat: p.lat, height: p.height })),
          });
        }
      } catch (err) { /* ignore */ }
    }
    if (window.LE && typeof window.LE.listLayers === 'function') {
      try {
        const layers = window.LE.listLayers() || [];
        for (const l of layers) {
          if (l.type !== 'vector' || !l.datasource) continue;
          const entities = l.datasource.entities;
          if (!entities || !entities.values) continue;
          for (const ent of entities.values) {
            const pts = [];
            let type = 'point';
            const position = propValue(ent.position, time);
            const polyline = propValue(ent.polyline, time);
            const polygon = propValue(ent.polygon, time);
            if (position) {
              const cc = C.Cartographic.fromCartesian(position);
              if (cc) pts.push({ lon: toDeg(cc.longitude), lat: toDeg(cc.latitude), height: cc.height });
            } else if (polyline) {
              type = 'line';
              const positions = propValue(polyline.positions, time);
              if (!Array.isArray(positions)) continue;
              for (const p of positions) {
                const cc = C.Cartographic.fromCartesian(p);
                if (cc) pts.push({ lon: toDeg(cc.longitude), lat: toDeg(cc.latitude), height: cc.height });
              }
            } else if (polygon) {
              type = 'polygon';
              // Cesium 的多边形几何放在 polygon.hierarchy.positions，
              // 不是 polygon.positions（后者不存在）。
              const hierarchy = propValue(polygon.hierarchy, time);
              const positions = (hierarchy && hierarchy.positions) || polygon.positions || [];
              for (const p of positions) {
                const cc = C.Cartographic.fromCartesian(p);
                if (cc) pts.push({ lon: toDeg(cc.longitude), lat: toDeg(cc.latitude), height: cc.height });
              }
            }
            if (!pts.length) continue;
            out.push({
              id: 'layer:' + (l.id || l.name || 'layer') + ':' + (ent.id || ent.name || ''),
              name: (l.name || '图层') + ' · ' + (ent.name || '要素'),
              type: type,
              points: pts,
            });
          }
        }
      } catch (err) { /* ignore */ }
    }
    return out;
  }

  /** 解析输入引用：id 优先，其次名字。 */
  function resolveVector(ref) {
    const all = collectVectorInputs();
    if (ref == null || ref === '') return all.length === 1 ? all[0] : null;
    let hit = all.find((v) => v.id === ref);
    if (!hit) hit = all.find((v) => v.name === ref);
    if (!hit) hit = all.find((v) => String(v.name).indexOf(String(ref)) >= 0);
    return hit || null;
  }

  /**
   * 矢量输入缺失时的提示：区分「一个矢量都没有」和「有但没选」。
   */
  function noVectorMessage() {
    const n = collectVectorInputs().length;
    if (!n) return '没有可用的矢量输入（请先绘制一个要素或加载矢量图层）';
    return '没有选择矢量输入（当前有 ' + n + ' 个可用要素，请在下拉框里选一个）';
  }

  /* ============================================================ 算法目录 */

  /* ============================================================ 分析范围 */

  /**
   * SCOPE 选项：视野 / 全部 / 绘制范围。
   * 声明在 ALGORITHMS 之前 —— 算法的参数表里直接引用这个常量。
   */
  const SCOPE_OPTIONS = ['视野', '全部', '绘制范围'];

  const ALGORITHMS = [
    {
      id: 'native:slope',
      name: '坡度',
      group: '地形分析',
      description: '按 DEM 计算地表坡度（度）。使用 Horn 3×3 算子，与 QGIS 结果一致。',
      params: [
        { name: 'Z_FACTOR', type: 'number', default: 1, description: 'Z 因子（垂直放大）' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 512, description: '输出格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runSlope,
    },
    {
      id: 'native:aspect',
      name: '坡向',
      group: '地形分析',
      description: '按 DEM 计算坡向（度，正北 0、顺时针）。',
      params: [
        { name: 'Z_FACTOR', type: 'number', default: 1, description: 'Z 因子' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 512, description: '输出格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runAspect,
    },
    {
      id: 'native:hillshade',
      name: '山体阴影',
      group: '地形分析',
      description: '按 DEM 生成山体阴影（贴合地形的明暗图层）。',
      params: [
        { name: 'Z_FACTOR', type: 'number', default: 1, description: 'Z 因子' },
        { name: 'AZIMUTH', type: 'number', default: 315, description: '太阳方位角（度）' },
        { name: 'ALTITUDE', type: 'number', default: 45, description: '太阳高度角（度）' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 512, description: '输出格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runHillshade,
    },
    {
      id: 'native:contour',
      name: '等值线',
      group: '地形分析',
      description: '从 DEM 提取等高线（Marching Squares）。',
      params: [
        { name: 'INTERVAL', type: 'number', default: 100, description: '等高距（米）' },
        { name: 'BASE', type: 'number', default: 0, description: '起始高程（米）' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 512, description: '采样格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runContour,
    },
    {
      id: 'native:demstats',
      name: '高程统计',
      group: '地形分析',
      description: '统计范围内的高程分布：最小/最大/均值/标准差，并给出分级直方图。',
      params: [
        { name: 'OUTPUT_SIZE', type: 'number', default: 256, description: '采样格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runDemStats,
    },
    {
      id: 'native:rastercalc',
      name: '栅格计算器',
      group: '栅格运算',
      description:
        '波段运算：按表达式对高程/坡度/坡向/山体阴影逐像元计算。' +
        '变量：dem（高程米）、slope（坡度度）、aspect（坡向度）、shade（阴影 0-255）、lon、lat。' +
        '函数：abs sqrt log log10 exp pow min max floor ceil round sin cos tan atan mod clamp ifelse。',
      params: [
        { name: 'EXPRESSION', type: 'text', default: 'dem + slope * 2', description: '计算表达式' },
        { name: 'PALETTE', type: 'enum', options: ['terrain', 'slope', 'gray', 'viridis'], default: 'viridis', description: '色带' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 512, description: '输出格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runRasterCalc,
    },
    {
      id: 'native:classify',
      name: '分级渲染',
      group: '栅格运算',
      description:
        '把一个波段按分级方式切成若干级并用色带出图，右侧给出每一级的区间与像元数。' +
        '分级方式：自然断点 / 等距 / 分位数 / 几何级数。',
      params: [
        { name: 'SOURCE', type: 'enum', options: ['dem', 'slope', 'aspect', 'shade'], default: 'dem', description: '输入波段' },
        { name: 'METHOD', type: 'enum', options: ['自然断点', '等距', '分位数', '几何级数'], default: '自然断点', description: '分级方式' },
        { name: 'CLASSES', type: 'number', default: 5, description: '级数' },
        { name: 'PALETTE', type: 'enum', options: ['terrain', 'slope', 'gray', 'viridis'], default: 'terrain', description: '色带' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 512, description: '输出格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runClassify,
    },
    {
      id: 'native:rasterhist',
      name: '直方图统计',
      group: '栅格运算',
      description: '统计指定波段的分布：最小/最大/平均/中位数/标准差，并画出直方图。',
      params: [
        { name: 'SOURCE', type: 'enum', options: ['dem', 'slope', 'aspect', 'shade'], default: 'dem', description: '输入波段' },
        { name: 'BINS', type: 'number', default: 20, description: '直方图箱数' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 256, description: '采样格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runRasterHist,
    },
    {
      id: 'native:vectorstyle',
      name: '矢量规则样式',
      group: '矢量分析',
      description:
        '对矢量图层做字段驱动着色：按字段分级（自然断点/等距/分位数/几何级数）或枚举分档，' +
        '可让点大小、线宽随级别递增。规则用条件表达式描述，双引号是字段名、单引号是字符串。',
      params: [
        { name: 'LAYER', type: 'vector', description: '目标矢量图层' },
        { name: 'FIELD', type: 'text', default: '', description: '字段名（留空则列出候选）' },
        { name: 'METHOD', type: 'enum', options: ['自然断点', '等距', '分位数', '几何级数'], default: '自然断点', description: '分级方式' },
        { name: 'CLASSES', type: 'number', default: 5, description: '级数' },
        { name: 'SIZE_SCALE', type: 'boolean', default: true, description: '大小随级别递增' },
      ],
      run: runVectorStyle,
    },
    {
      id: 'native:buffer',
      name: '缓冲区',
      group: '矢量分析',
      description: '给矢量要素生成指定半径的缓冲区多边形。',
      params: [
        { name: 'INPUT', type: 'vector', description: '输入矢量（绘制要素或已加载图层）' },
        { name: 'DISTANCE', type: 'number', default: 1000, description: '缓冲半径（米）' },
        { name: 'SEGMENTS', type: 'number', default: 64, description: '圆弧离散段数' },
        { name: 'DISSOLVE', type: 'boolean', default: true, description: '合并为一个多边形' },
      ],
      run: runBuffer,
    },
    {
      id: 'native:centroid',
      name: '质心',
      group: '矢量分析',
      description: '计算矢量要素的质心点。',
      params: [{ name: 'INPUT', type: 'vector', description: '输入矢量' }],
      run: runCentroid,
    },
    {
      id: 'native:convexhull',
      name: '凸包',
      group: '矢量分析',
      description: '计算矢量要素集合的凸包多边形。',
      params: [{ name: 'INPUT', type: 'vector', description: '输入矢量' }],
      run: runConvexHull,
    },
    {
      id: 'native:lenarea',
      name: '长度与面积',
      group: '矢量分析',
      description: '计算矢量要素的长度（米）与面积（平方米）。',
      params: [{ name: 'INPUT', type: 'vector', description: '输入矢量' }],
      run: runLengthArea,
    },
    {
      id: 'native:profile',
      name: '沿线路剖面',
      group: '矢量分析',
      description: '沿一条折线采样高程，输出剖面折线（可直接用「高程剖面」查看）。',
      params: [
        { name: 'INPUT', type: 'vector', description: '输入折线' },
        { name: 'STEP', type: 'number', default: 100, description: '采样间距（米）' },
      ],
      run: runProfile,
    },
    {
      id: 'native:interpolate',
      name: 'TIN 插值',
      group: '插值',
      description: '对散点做 IDW 反距离加权插值，生成高程面。',
      params: [
        { name: 'INPUT', type: 'vector', description: '输入散点' },
        { name: 'POWER', type: 'number', default: 2, description: '幂次（0=线性，2=IDW）' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 256, description: '输出格网边长（像素）' },
        { name: 'RADIUS', type: 'number', default: 0, description: '搜索半径（米，0=不限）' },
      ],
      run: runInterpolate,
    },
    {
      id: 'native:supervisedclassify',
      name: '监督分类',
      group: '栅格分类',
      description:
        '用训练样本点做监督分类：最小距离（像元归到最近类别中心）或最大似然' +
        '（各类别波段独立同分布，按对数似然判定）。' +
        '样本点在「栅格分类」面板里点地图采集，本算法直接复用它们。' +
        '结果附带混淆矩阵与总体精度。',
      params: [
        { name: 'METHOD', type: 'enum', options: ['最小距离', '最大似然'], default: '最小距离', description: '分类方法' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 256, description: '格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runSupervisedClassify,
    },
    {
      id: 'native:kmeansclassify',
      name: '非监督分类（K-Means）',
      group: '栅格分类',
      description:
        '不需要样本点：把格网内全部像元按波段值聚成 K 类（K-Means）。' +
        '适合先看看这堆波段能自然分几类，再决定监督分类怎么标。',
      params: [
        { name: 'CLASSES', type: 'number', default: 5, description: '聚类数 K' },
        { name: 'OUTPUT_SIZE', type: 'number', default: 256, description: '格网边长（像素）' },
        { name: 'SCOPE', type: 'enum', options: SCOPE_OPTIONS, default: '视野', description: '分析范围（绘制范围 = 用已绘制的面作为掩膜）' },
      ],
      run: runKmeansClassify,
    },
    {
      id: 'native:shortestpath',
      name: '最短路径（路网）',
      group: '网络分析',
      description:
        '把线要素打断成路网，在起点与终点之间算最短路径。' +
        '起终点填经纬度（如 116.36, 39.90），也可以先用「网络分析」面板在地图上点选。' +
        '单行道按 oneway / 单向 属性识别。',
      params: [
        { name: 'SOURCE', type: 'text', default: '__all__', description: '路网数据源（全部 / 绘制 / 图层 ID）' },
        { name: 'START', type: 'text', default: '', description: '起点经度,纬度' },
        { name: 'END', type: 'text', default: '', description: '终点经度,纬度' },
      ],
      run: runShortestPath,
    },
    {
      id: 'native:servicearea',
      name: '服务区（等距可达范围）',
      group: '网络分析',
      description:
        '以起点为中心，算沿路网可达、且直线离路不超过给定半径的范围，' +
        '结果是一个可挂在地球上的多边形。',
      params: [
        { name: 'SOURCE', type: 'text', default: '__all__', description: '路网数据源（全部 / 绘制 / 图层 ID）' },
        { name: 'START', type: 'text', default: '', description: '起点经度,纬度' },
        { name: 'RADIUS_KM', type: 'number', default: 2, description: '可达半径（km）' },
      ],
      run: runServiceArea,
    },
  ];


  /* =========================================================== 算法实现 */

  /**
   * 解析分析范围（矩形）。
   *
   * SCOPE='绘制范围' 时，用**用户画的面**作为范围：多边形的最小外接矩形
   * 作为采样框，真正的边界由 mask 生效（见 buildGrid / gridMask）。
   * 多于一个面时取它们的并集外接矩形（掩膜取「任一命中」）。
   *
   * params.MASK_POLY_ID 非空时，只用**那一个**面（批量流程用：
   * 每个面单独跑一次，掩膜只认自己那个）。
   */
  function resolveScope(params) {
    const scope = params.SCOPE || '视野';
    if (scope === '全部') {
      const st = window.LEDemTiles ? window.LEDemTiles.stats() : null;
      if (st && st.bbox) {
        const b = st.bbox;
        return { west: b[0], south: b[1], east: b[2], north: b[3] };
      }
    }
    if (scope === '绘制范围') {
      const poly = maskPolygonsFor(params);
      if (!poly.length) {
        throw new Error('「绘制范围」需要先在地图上画一个面（多边形），请在「绘制」面板里绘制。');
      }
      const box = polygonsBBox(poly);
      if (box) return box;
    }
    return currentViewRect();
  }

  /**
   * 本次分析用哪些多边形做掩膜。
   *
   * - params.MASK_POLY_ID 指定了某个面 → 只用它（批量流程逐面跑）
   * - 否则 → 全部绘制面（并集）
   */
  function maskPolygonsFor(params) {
    const all = drawnMaskPolygons();
    const id = params && params.MASK_POLY_ID;
    if (id == null || id === '') return all;
    const want = String(id);
    return all.filter(function (p) { return String(p.id) === want; });
  }

  /**
   * 取出用户绘制的多边形（作为分析范围的掩膜）。
   * 只取 type==='polygon' 且可见的面要素；点的 points 为 [{lon,lat}]。
   */
  function drawnMaskPolygons() {
    const out = [];
    if (!window.LEDraw || typeof window.LEDraw.getFeatures !== 'function') return out;
    let feats = [];
    try {
      feats = window.LEDraw.getFeatures() || [];
    } catch (err) {
      return out;
    }
    for (const f of feats) {
      if (!f || f.type !== 'polygon') continue;
      const pts = (f.points || []).filter(function (p) {
        return p && isFinite(p.lon) && isFinite(p.lat);
      });
      if (pts.length < 3) continue;
      out.push({ id: f.id, name: f.name || '绘制面', points: pts });
    }
    return out;
  }

  /** 一组多边形的最小外接矩形。 */
  function polygonsBBox(polys) {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    let any = false;
    for (const poly of polys) {
      for (const p of poly.points) {
        any = true;
        if (p.lon < west) west = p.lon;
        if (p.lon > east) east = p.lon;
        if (p.lat < south) south = p.lat;
        if (p.lat > north) north = p.lat;
      }
    }
    if (!any) return null;
    return { west: west, south: south, east: east, north: north };
  }

  /**
   * 生成格网掩膜：Uint8Array，长度 w*h，1 表示在范围内。
   * 没有绘制范围时返回 null（表示全部有效）。
   */
  function gridMask(grid, polys) {
    if (!polys || !polys.length) return null;
    const mask = new Uint8Array(grid.w * grid.h);
    let any = 0;
    for (let row = 0; row < grid.h; row++) {
      const lat = grid.north - row * grid.dy;
      for (let col = 0; col < grid.w; col++) {
        const lon = grid.west + col * grid.dx;
        let hit = 0;
        for (const poly of polys) {
          if (pointInRing({ lon: lon, lat: lat }, poly.points)) { hit = 1; break; }
        }
        mask[row * grid.w + col] = hit;
        any += hit;
      }
    }
    return { data: mask, count: any };
  }

  /**
   * 复制一份格网，把掩膜外的波段值置为 NaN。
   * 分类内核（bandStats / classifyGrid / kmeans）本来就跳过 NaN 像元，
   * 所以置 NaN 就等于「这些像元不参与、也不输出」。
   */
  function maskGridBands(grid, mask) {
    if (!mask) return grid;
    const out = {
      w: grid.w, h: grid.h,
      west: grid.west, south: grid.south, east: grid.east, north: grid.north,
      pixelMode: grid.pixelMode,
      mask: mask,
      bands: grid.bands.map(function (b) {
        const d = new Float32Array(b.data.length);
        for (let i = 0; i < d.length; i++) {
          d[i] = mask.data[i] ? b.data[i] : NaN;
        }
        return { name: b.name, data: d };
      }),
    };
    return out;
  }

  /**
   * 给「栅格分类」内核用的格网生成掩膜。
   *
   * 与 gridMask 的区别：分类内核的格网来自 LERasterClassifyShell.buildGrid，
   * 像素位置约定有两种：
   *   'center' —— 像元中心落在格网内（原始栅格重采样路径）
   *   'corner' —— 角点落在格网内（DEM 采样路径）
   * 而 gridMask 假设的是「角点」约定（analysis.js 的 sampleGrid 用的就是角点）。
   */
  function gridMaskForPixels(grid, polys) {
    if (!polys || !polys.length) return null;
    const w = grid.w, h = grid.h;
    const mask = new Uint8Array(w * h);
    const center = grid.pixelMode === 'center';
    const dx = (grid.east - grid.west) / (center ? w : Math.max(1, w - 1));
    const dy = (grid.north - grid.south) / (center ? h : Math.max(1, h - 1));
    let any = 0;
    for (let row = 0; row < h; row++) {
      const lat = grid.north - (center ? (row + 0.5) * dy : row * dy);
      for (let col = 0; col < w; col++) {
        const lon = grid.west + (center ? (col + 0.5) * dx : col * dx);
        let hit = 0;
        for (const poly of polys) {
          if (pointInRing({ lon: lon, lat: lat }, poly.points)) { hit = 1; break; }
        }
        mask[row * w + col] = hit;
        any += hit;
      }
    }
    return { data: mask, count: any };
  }

  /**
   * 把掩膜外的像元从统计里剔掉（像元值置为 NaN 由调用方处理）。
   * 这里只返回「有效像元下标数组」，供统计类算法使用。
   */
  function maskValidIndices(grid, mask) {
    const out = [];
    for (let i = 0; i < grid.w * grid.h; i++) {
      if (!mask || mask.data[i]) out.push(i);
    }
    return out;
  }

  /**
   * 取「绘制范围内」的像元值（压成一个新数组）。
   * 统计/分级/直方图都用它，这样分布只反映绘制范围内部。
   */
  function maskedValues(grid, values) {
    if (!grid.mask) return values;
    const idxs = maskValidIndices(grid, grid.mask);
    const out = new Float32Array(idxs.length);
    for (let k = 0; k < idxs.length; k++) out[k] = values[idxs[k]];
    return out;
  }

  /**
   * 采样一个格网。先 await DEM 瓦片到位，避免采到空洞。
   * 若 SCOPE='绘制范围'，同时生成掩膜并挂在 grid.mask 上。
   */
  async function buildGrid(params, scope) {
    const size = Math.max(32, Math.min(2048, Number(params.OUTPUT_SIZE) || 512));
    if (window.LEDemTiles && typeof window.LEDemTiles.ensureRect === 'function') {
      try {
        await window.LEDemTiles.ensureRect(scope.west, scope.south, scope.east, scope.north);
      } catch (err) { /* ignore */ }
    }
    const grid = sampleGrid(scope.west, scope.south, scope.east, scope.north, size, size);
    grid.zFactor = Number(params.Z_FACTOR) || 1;
    // 绘制范围掩膜（SCOPE='绘制范围' 时才生成）
    if ((params.SCOPE || '') === '绘制范围') {
      const polys = maskPolygonsFor(params);
      const mask = gridMask(grid, polys);
      grid.mask = mask;
      grid.maskPolys = polys;
    } else {
      grid.mask = null;
      grid.maskPolys = null;
    }
    return grid;
  }

  async function runSlope(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const r = slopeAspect(grid, grid.cellSize, grid.zFactor);
    const max = Math.max(1, maxOf(r.slope));
    const canvas = renderField(grid, r.slope, { min: 0, max: max, palette: 'slope' });
    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: { 最大坡度: Math.round(max * 10) / 10 + '°' },
    };
  }

  async function runAspect(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const r = slopeAspect(grid, grid.cellSize, grid.zFactor);
    // 坡向：平地（-1）单独剔除，色带循环 0–360
    const vals = new Float32Array(r.aspect.length);
    for (let i = 0; i < vals.length; i++) vals[i] = r.aspect[i] < 0 ? 0 : r.aspect[i];
    const canvas = renderField(grid, vals, { min: 0, max: 360, palette: 'viridis' });
    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: { 说明: '正北 = 0°，顺时针；平地记为 0°' },
    };
  }

  async function runHillshade(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const az = (Number(params.AZIMUTH) || 315) * Math.PI / 180;
    const alt = (Number(params.ALTITUDE) || 45) * Math.PI / 180;
    const z = grid.zFactor;
    const { w, h } = grid;
    const s = grid.cellSize;
    const out = new Float32Array(w * h);
    // 太阳单位向量（东、北、上）
    const sx = Math.sin(az) * Math.cos(alt);
    const sy = Math.cos(az) * Math.cos(alt);
    const sz = Math.sin(alt);
    for (let row = 0; row < h; row++) {
      const rm = Math.max(0, row - 1);
      const rp = Math.min(h - 1, row + 1);
      for (let col = 0; col < w; col++) {
        const cm = Math.max(0, col - 1);
        const cp = Math.min(w - 1, col + 1);
        const a = grid.data[rm * w + cm];
        const b = grid.data[rm * w + col];
        const c = grid.data[rm * w + cp];
        const d = grid.data[row * w + cm];
        const f = grid.data[row * w + cp];
        const g = grid.data[rp * w + cm];
        const hh = grid.data[rp * w + col];
        const i = grid.data[rp * w + cp];
        const gx = z * ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * s);
        const gy = z * -(((g + 2 * hh + i) - (a + 2 * b + c)) / (8 * s));
        // 地面法向量（东、北、上）= (−gx, −gy, 1) 归一化，与太阳向量点积
        const norm = Math.sqrt(gx * gx + gy * gy + 1);
        const dot = (-gx * sx - gy * sy + sz) / norm;
        out[row * w + col] = Math.max(0, Math.min(1, dot)) * 255;
      }
    }
    const canvas = renderField(grid, out, { min: 0, max: 255, palette: 'gray' });
    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: { 方位角: Number(params.AZIMUTH) || 315, 高度角: Number(params.ALTITUDE) || 45 },
    };
  }

  async function runContour(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const interval = Math.max(1, Number(params.INTERVAL) || 100);
    const base = Number(params.BASE) || 0;
    // 绘制范围：范围外的像元置为 NaN，等值线自然不会跑到范围外
    if (grid.mask) {
      const d = grid.data;
      for (let i = 0; i < d.length; i++) {
        if (!grid.mask.data[i]) d[i] = NaN;
      }
    }
    const min = minOf(grid.data);
    const max = maxOf(grid.data);
    if (grid.mask && !grid.mask.count) {
      throw new Error('绘制范围内没有有效像元（请检查绘制的面是否落在 DEM 覆盖区内）。');
    }
    const features = [];
    let count = 0;
    const start = Math.ceil((min - base) / interval) * interval + base;
    for (let lv = start; lv <= max; lv += interval) {
      const lines = contour(grid, lv);
      for (const line of lines) {
        if (line.length < 2) continue;
        features.push({
          type: 'Feature',
          properties: { 高程: Math.round(lv * 100) / 100, 要素: ++count },
          geometry: { type: 'LineString', coordinates: line.map((p) => [p.x, p.y]) },
        });
      }
    }
    return {
      kind: 'vector',
      geojson: { type: 'FeatureCollection', features: features },
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        等高线数: features.length,
        等高距: interval + ' m',
        高程范围: Math.round(min) + '–' + Math.round(max) + ' m',
        范围: grid.mask ? '绘制范围' : '全范围',
      },
    };
  }

  async function runDemStats(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const d = grid.data;
    // 绘制范围掩膜：只统计范围内的像元
    const valid = grid.mask ? maskValidIndices(grid, grid.mask) : null;
    const idxs = valid || null;
    const n = idxs ? idxs.length : d.length;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = d[idxs ? idxs[k] : k];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!n) throw new Error('绘制范围内没有有效像元。');
    const mean = sum / n;
    let varSum = 0;
    for (let k = 0; k < n; k++) {
      const v = d[idxs ? idxs[k] : k];
      varSum += (v - mean) * (v - mean);
    }
    const std = Math.sqrt(varSum / n);
    // 10 级直方图
    const bins = new Array(10).fill(0);
    const span = (max - min) || 1;
    for (let k = 0; k < n; k++) {
      const v = d[idxs ? idxs[k] : k];
      let b = Math.floor(((v - min) / span) * 10);
      if (b < 0) b = 0;
      if (b > 9) b = 9;
      bins[b]++;
    }
    return {
      kind: 'table',
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        最小高程: Math.round(min),
        最大高程: Math.round(max),
        平均高程: Math.round(mean),
        标准差: Math.round(std * 10) / 10,
        样本数: n,
        范围: grid.mask ? '绘制范围' : '全范围',
      },
      table: {
        columns: ['高程区间', '像元数', '占比'],
        rows: bins.map((c, i) => [
          Math.round(min + (span * i) / 10) + '–' + Math.round(min + (span * (i + 1)) / 10) + ' m',
          c,
          Math.round((c / n) * 1000) / 10 + '%',
        ]),
      },
    };
  }

  /**
   * 山体阴影场（0–255）。抽出来给栅格计算器当波段用，
   * 免得把 runHillshade 里的逻辑再抄一遍。
   */
  function hillshadeField(grid, azimuthDeg, altitudeDeg) {
    const az = (Number(azimuthDeg) || 315) * Math.PI / 180;
    const alt = (Number(altitudeDeg) || 45) * Math.PI / 180;
    const z = grid.zFactor;
    const { w, h } = grid;
    const s = grid.cellSize;
    const out = new Float32Array(w * h);
    const sx = Math.sin(az) * Math.cos(alt);
    const sy = Math.cos(az) * Math.cos(alt);
    const sz = Math.sin(alt);
    for (let row = 0; row < h; row++) {
      const rm = Math.max(0, row - 1);
      const rp = Math.min(h - 1, row + 1);
      for (let col = 0; col < w; col++) {
        const cm = Math.max(0, col - 1);
        const cp = Math.min(w - 1, col + 1);
        const a = grid.data[rm * w + cm];
        const b = grid.data[rm * w + col];
        const c = grid.data[rm * w + cp];
        const d = grid.data[row * w + cm];
        const f = grid.data[row * w + cp];
        const g = grid.data[rp * w + cm];
        const hh = grid.data[rp * w + col];
        const i = grid.data[rp * w + cp];
        const gx = z * ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * s);
        const gy = z * -(((g + 2 * hh + i) - (a + 2 * b + c)) / (8 * s));
        const norm = Math.sqrt(gx * gx + gy * gy + 1);
        const dot = (-gx * sx - gy * sy + sz) / norm;
        out[row * w + col] = Math.max(0, Math.min(1, dot)) * 255;
      }
    }
    return out;
  }

  /* ============================================================ 栅格运算 */

  /**
   * 把「高程/坡度/坡向/山体阴影/经度/纬度」组装成表达式引擎可用的波段环境。
   *
   * 变量名（与 QGIS 栅格计算器习惯一致，英文小写）：
   *   dem     高程（米）
   *   slope   坡度（度）
   *   aspect  坡向（度，平地为 -1）
   *   shade   山体阴影（0–255）
   *   lon     经度（度）
   *   lat     纬度（度）
   */
  function buildBands(grid, params) {
    const env = { dem: grid.data };
    const r = slopeAspect(grid, grid.cellSize, grid.zFactor);
    env.slope = r.slope;
    env.aspect = r.aspect;
    env.shade = hillshadeField(grid, Number(params.AZIMUTH) || 315, Number(params.ALTITUDE) || 45);
    const lon = new Float32Array(grid.w * grid.h);
    const lat = new Float32Array(grid.w * grid.h);
    for (let row = 0; row < grid.h; row++) {
      const la = grid.north - row * grid.dy;
      for (let col = 0; col < grid.w; col++) {
        const i = row * grid.w + col;
        lon[i] = grid.west + col * grid.dx;
        lat[i] = la;
      }
    }
    env.lon = lon;
    env.lat = lat;
    return env;
  }

  /** 按名字取一个波段（分级/直方图用）。 */
  function bandByName(bands, name) {
    const key = String(name || 'dem').toLowerCase();
    const v = bands[key];
    return v || bands.dem;
  }

  /**
   * 分级渲染出图：每一类一个纯色，按色带取色。
   * mask 存在时范围外像元透明。
   */
  function renderClasses(grid, classes, table, paletteName, mask) {
    const canvas = document.createElement('canvas');
    canvas.width = grid.w;
    canvas.height = grid.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(grid.w, grid.h);
    const k = table.length;
    const colors = [];
    for (let i = 0; i < k; i++) {
      // 每类取色带上对应位置的颜色（避开最暗/最亮端点）
      const t = k <= 1 ? 0.5 : i / (k - 1);
      colors.push(paletteColor(t, paletteName));
    }
    const m = mask || (grid && grid.mask) || null;
    for (let i = 0; i < classes.length; i++) {
      const c = classes[i];
      const rgb = c >= 0 && c < k ? colors[c] : [40, 40, 40];
      const o = i * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = m ? (m.data[i] ? 255 : 0) : 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /**
   * 栅格计算器：按表达式对波段做逐像元运算。
   */
  async function runRasterCalc(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const expr = String(params.EXPRESSION || '').trim();
    if (!expr) throw new Error('请填写计算表达式');
    const bands = buildBands(grid, params);
    const R = window.LERasterOps;
    if (!R) throw new Error('栅格运算内核未加载（js/raster-ops.js）');
    let values;
    try {
      values = R.evaluate(expr, bands);
    } catch (err) {
      throw new Error('表达式错误：' + (err && err.message ? err.message : err));
    }
    if (typeof values === 'number') {
      // 纯标量表达式 → 铺满整个范围
      const flat = new Float32Array(grid.data.length);
      flat.fill(values);
      values = flat;
    }
    const st = R.stats(maskedValues(grid, values));
    const canvas = renderField(grid, values, {
      min: st.min, max: st.max, palette: params.PALETTE || 'viridis',
    });
    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        表达式: expr,
        最小值: round2(st.min),
        最大值: round2(st.max),
        平均值: round2(st.mean),
      },
    };
  }

  /**
   * 分级渲染（分级/分类）：自然断点 / 等距 / 分位数 / 几何级数。
   */
  async function runClassify(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const R = window.LERasterOps;
    if (!R) throw new Error('栅格运算内核未加载（js/raster-ops.js）');
    const bands = buildBands(grid, params);
    const source = String(params.SOURCE || 'dem');
    const values = bandByName(bands, source);
    const method = params.METHOD || '自然断点';
    const k = Math.max(2, Math.min(20, Number(params.CLASSES) || 5));
    // 绘制范围：断点与分级统计只在范围内像元上计算
    const statValues = maskedValues(grid, values);
    const brks = R.breaks(statValues, method, k);
    const cls = R.classify(values, brks);
    // 分级统计也按范围统计（像元数按范围外的置 0）
    const clsTable = cls.table.map(function (t) {
      if (!grid.mask) return t;
      return { index: t.index, min: t.min, max: t.max, label: t.label, count: t.count };
    });
    if (grid.mask) {
      // 重新按范围统计每级像元数
      const counts = new Array(clsTable.length).fill(0);
      for (let i = 0; i < values.length; i++) {
        if (!grid.mask.data[i]) continue;
        const c = cls.classes[i];
        if (c >= 0 && c < counts.length) counts[c]++;
      }
      for (let c = 0; c < clsTable.length; c++) clsTable[c].count = counts[c];
    }
    const totalCount = grid.mask
      ? (grid.mask.count || 0)
      : values.length;
    const canvas = renderClasses(grid, cls.classes, clsTable, params.PALETTE || 'terrain', grid.mask);
    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        波段: source,
        分级方式: method,
        级数: k,
        断点: brks.map(round2).join(' / '),
      },
      table: {
        columns: ['级', '区间', '像元数', '占比'],
        rows: clsTable.map(function (t) {
          return [
            t.index + 1,
            t.label,
            t.count,
            Math.round((t.count / (totalCount || 1)) * 1000) / 10 + '%',
          ];
        }),
      },
      breaks: brks,
    };
  }

  /**
   * 监督分类：复用「栅格分类」面板采集的训练样本点。
   */
  async function runSupervisedClassify(params) {
    const RC = window.LERasterClassify;
    const SH = window.LERasterClassifyShell;
    if (!RC) throw new Error('栅格分类内核未加载（js/raster-classify.js）');
    if (!SH) throw new Error('栅格分类装载层未加载（js/raster-classify-shell.js）');

    const samples = SH.samples();
    if (!samples.length) {
      throw new Error('还没有训练样本点。请先打开「栅格分类」面板，' +
        '点「开始拾取样本」后在地图上单击采样。');
    }
    const classes = SH.classes();
    const used = classes.filter(function (c) {
      return samples.some(function (s) { return s.classId === c.id; });
    });
    if (used.length < 2) throw new Error('至少要有 2 个类别各带样本点才能分类。');

    const scope = resolveScope(params);
    const size = Math.max(32, Math.min(1024, Number(params.OUTPUT_SIZE) || 256));
    const grid = await SH.buildGrid({
      size: size,
      west: scope.west, south: scope.south, east: scope.east, north: scope.north,
    });
    // 绘制范围掩膜：只限制**分类输出**，不限制训练。
    // 训练样本是用户有意采的点，不该因为落在绘制范围外就作废；
    // 但分类结果只画在绘制范围内（范围外像元置 NaN，分类内核自动跳过）。
    const mask = (params.SCOPE || '') === '绘制范围'
      ? gridMaskForPixels(grid, maskPolygonsFor(params))
      : null;
    const outGrid = mask ? maskGridBands(grid, mask) : grid;
    const method = params.METHOD === '最大似然' ? '最大似然' : '最小距离';
    const model = RC.train(grid, samples, used, { method: method });
    const cls = RC.classifyGrid(model, outGrid);
    const conf = RC.evaluate(model, grid, samples);

    const canvas = document.createElement('canvas');
    canvas.width = grid.w;
    canvas.height = grid.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(grid.w, grid.h);
    used.forEach(function (c, ci) {
      const hex = String(c.color || '#888888').replace('#', '');
      c._rgb = [
        parseInt(hex.slice(0, 2), 16) || 128,
        parseInt(hex.slice(2, 4), 16) || 128,
        parseInt(hex.slice(4, 6), 16) || 128,
      ];
      void ci;
    });
    for (let i = 0; i < cls.classes.length; i++) {
      const cid = cls.classes[i];
      const c = used.find(function (x) { return x.id === cid; });
      const rgb = c && c._rgb ? c._rgb : [40, 40, 40];
      const o = i * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      // 掩膜外（无类别）透明
      img.data[o + 3] = mask ? (mask.data[i] ? 255 : 0) : 255;
    }
    ctx.putImageData(img, 0, 0);

    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        方法: method,
        波段数: grid.bands.length,
        样本点: samples.length,
        类别数: used.length,
        总体精度: (conf.accuracy * 100).toFixed(1) + '%',
        范围: mask ? '绘制范围' : '全范围',
      },
      table: {
        columns: ['类别', '像元数', '占比', '生产者精度', '用户精度', 'F1'],
        rows: used.map(function (c) {
          const row = cls.table.find(function (t) { return t.classId === c.id; });
          const pc = conf.perClass[conf.ids.indexOf(c.id)];
          const count = row ? row.count : 0;
          const base = mask ? (mask.count || 1) : (grid.w * grid.h);
          return [
            c.name,
            count,
            ((count / base) * 100).toFixed(1) + '%',
            pc ? (pc.recall * 100).toFixed(1) + '%' : '—',
            pc ? (pc.precision * 100).toFixed(1) + '%' : '—',
            pc ? pc.f1.toFixed(3) : '—',
          ];
        }),
      },
      confusion: conf,
    };
  }

  /**
   * 非监督分类（K-Means）。
   */
  async function runKmeansClassify(params) {
    const RC = window.LERasterClassify;
    const SH = window.LERasterClassifyShell;
    if (!RC) throw new Error('栅格分类内核未加载（js/raster-classify.js）');
    if (!SH) throw new Error('栅格分类装载层未加载（js/raster-classify-shell.js）');

    const scope = resolveScope(params);
    const size = Math.max(32, Math.min(1024, Number(params.OUTPUT_SIZE) || 256));
    const k = Math.max(2, Math.min(12, Number(params.CLASSES) || 5));
    const grid = await SH.buildGrid({
      size: size,
      west: scope.west, south: scope.south, east: scope.east, north: scope.north,
    });
    // 绘制范围掩膜：范围外的波段值置 NaN，K-Means 只聚类有效像元
    const mask = (params.SCOPE || '') === '绘制范围'
      ? gridMaskForPixels(grid, maskPolygonsFor(params))
      : null;
    const outGrid = mask ? maskGridBands(grid, mask) : grid;
    const res = RC.kmeans(outGrid, k, {});
    const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
      '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080'];

    const canvas = document.createElement('canvas');
    canvas.width = grid.w;
    canvas.height = grid.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(grid.w, grid.h);
    const rgbs = palette.map(function (h) {
      const s = h.replace('#', '');
      return [
        parseInt(s.slice(0, 2), 16),
        parseInt(s.slice(2, 4), 16),
        parseInt(s.slice(4, 6), 16),
      ];
    });
    for (let i = 0; i < res.classes.length; i++) {
      const c = res.classes[i];
      const rgb = c >= 0 && c < rgbs.length ? rgbs[c] : [40, 40, 40];
      const o = i * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      // 掩膜外（无聚类）透明
      img.data[o + 3] = mask ? (mask.data[i] ? 255 : 0) : 255;
    }
    ctx.putImageData(img, 0, 0);

    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        方法: 'K-Means（非监督）',
        类别数: k,
        有效像元: res.valid || 0,
        范围: mask ? '绘制范围' : '全范围',
      },
      table: {
        columns: ['聚类', '像元数', '占比'],
        rows: res.table.map(function (t) {
          const base = mask ? (mask.count || 1) : (grid.w * grid.h);
          return [
            '聚类 ' + (t.classId + 1),
            t.count,
            ((t.count / base) * 100).toFixed(1) + '%',
          ];
        }),
      },
    };
  }

  /**
   * 最短路径（路网）。
   * 输入 SOURCE=数据源 ID，START/END="lon,lat"。
   */
  async function runShortestPath(params) {
    const NW = window.LENetwork;
    const SH = window.LENetworkShell;
    if (!NW) throw new Error('网络分析内核未加载（js/network.js）');
    if (!SH) throw new Error('网络分析装载层未加载（js/network-shell.js）');

    const src = String(params.SOURCE || '__all__');
    const start = parseLonLat(params.START);
    const end = parseLonLat(params.END);
    if (!start) throw new Error('起点格式应为「经度,纬度」，例如 116.36, 39.90');
    if (!end) throw new Error('终点格式应为「经度,纬度」，例如 116.40, 39.92');

    const built = SH.buildGraph({ sourceId: src });
    if (!built.ok) throw new Error(built.error || '路网构建失败');

    const r = SH.shortestPath({ sourceId: src, start: start, end: end });
    if (!r.ok) throw new Error(r.error || '最短路计算失败');

    const gj = NW.pathToGeoJSON(r, '最短路径');
    return {
      kind: 'vector',
      geojson: gj,
      stats: {
        路网节点: built.summary.nodes,
        路网边数: built.summary.edges,
        路径长度: r.distanceKm.toFixed(3) + ' km',
        经过节点: r.steps,
        起点贴边偏差: r.start.snapM.toFixed(1) + ' m',
        终点贴边偏差: r.end.snapM.toFixed(1) + ' m',
      },
      table: {
        columns: ['项', '值'],
        rows: [
          ['路径长度（km）', r.distanceKm.toFixed(3)],
          ['经过节点数', r.steps],
          ['起点', r.start.lon.toFixed(6) + ', ' + r.start.lat.toFixed(6)],
          ['终点', r.end.lon.toFixed(6) + ', ' + r.end.lat.toFixed(6)],
        ],
      },
    };
  }

  /**
   * 服务区（等距可达范围）。
   */
  async function runServiceArea(params) {
    const NW = window.LENetwork;
    const SH = window.LENetworkShell;
    if (!NW) throw new Error('网络分析内核未加载（js/network.js）');
    if (!SH) throw new Error('网络分析装载层未加载（js/network-shell.js）');

    const src = String(params.SOURCE || '__all__');
    const start = parseLonLat(params.START);
    if (!start) throw new Error('起点格式应为「经度,纬度」，例如 116.36, 39.90');
    const radiusKm = Math.max(0.05, Number(params.RADIUS_KM) || 2);

    const built = SH.buildGraph({ sourceId: src });
    if (!built.ok) throw new Error(built.error || '路网构建失败');

    const r = SH.serviceArea({
      sourceId: src, start: start, limitM: radiusKm * 1000,
    });
    if (!r.ok) throw new Error(r.error || '服务区计算失败');

    const gj = NW.serviceAreaToGeoJSON(r, '服务区');
    return {
      kind: 'vector',
      geojson: gj,
      stats: {
        路网节点: built.summary.nodes,
        可达半径: radiusKm.toFixed(2) + ' km',
        覆盖面积: r.areaKm2.toFixed(3) + ' km²',
        边界环: r.rings.length,
        网格格数: r.reachedCells,
      },
      table: {
        columns: ['项', '值'],
        rows: [
          ['可达半径（km）', radiusKm.toFixed(2)],
          ['覆盖面积（km²）', r.areaKm2.toFixed(3)],
          ['边界环数', r.rings.length],
          ['起点', r.start.lon.toFixed(6) + ', ' + r.start.lat.toFixed(6)],
        ],
      },
    };
  }

  /** 解析 "lon,lat" 文本。 */
  function parseLonLat(text) {
    if (text == null) return null;
    const s = String(text).trim();
    if (!s) return null;
    const parts = s.split(/[,，\s]+/);
    if (parts.length < 2) return null;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!isFinite(lon) || !isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return { lon: lon, lat: lat };
  }

  /**
   * 直方图与统计：给出分布直方图 + 描述统计。
   */
  async function runRasterHist(params) {
    const scope = resolveScope(params);
    const grid = await buildGrid(params, scope);
    const R = window.LERasterOps;
    if (!R) throw new Error('栅格运算内核未加载（js/raster-ops.js）');
    const bands = buildBands(grid, params);
    const source = String(params.SOURCE || 'dem');
    const values = bandByName(bands, source);
    const bins = Math.max(2, Math.min(100, Number(params.BINS) || 20));
    // 绘制范围：直方图只统计范围内像元
    const h = R.histogram(maskedValues(grid, values), bins);
    const st = h.stats;
    return {
      kind: 'table',
      bounds: [scope.west, scope.south, scope.east, scope.north],
      stats: {
        波段: source,
        最小值: round2(st.min),
        最大值: round2(st.max),
        平均值: round2(st.mean),
        中位数: round2(st.median),
        标准差: round2(st.std),
        样本数: st.count,
      },
      table: {
        columns: ['区间', '像元数', '占比', '直方图'],
        rows: h.bins.map(function (b) {
          const pct = (b.count / st.count) * 100;
          const n = Math.round((b.count / h.maxCount) * 20);
          return [
            R.formatRange(b.min, b.max),
            b.count,
            Math.round(pct * 10) / 10 + '%',
            new Array(Math.max(1, n)).join('█'),
          ];
        }),
      },
      histogram: h,
    };
  }

  /**
   * 矢量规则样式：对指定矢量图层做字段驱动着色。
   *
   * LAYER 参数是图层 id（工具箱的 vector 下拉给出的是要素，这里改成图层更实用）。
   */
  async function runVectorStyle(params) {
    const S = window.LELayerStyle;
    if (!S) throw new Error('图层样式模块未加载（js/layer-style.js）');
    const le = window.LE;
    const layers = (le && typeof le.listLayers === 'function') ? le.listLayers() : [];
    const vec = layers.filter((l) => l.type === 'vector' && l.datasource);

    const wanted = String(params.LAYER || '').trim();
    let entry = null;
    if (wanted) {
      entry = vec.find((l) => l.id === wanted || l.name === wanted);
    }
    if (!entry) {
      if (vec.length === 1) {
        entry = vec[0];
      } else if (vec.length === 0) {
        throw new Error('当前没有矢量图层，请先导入矢量数据');
      } else {
        const names = vec.map((l) => l.name || l.id).join('、');
        throw new Error('请指定图层（当前矢量图层：' + names + '）');
      }
    }

    const fields = S.fieldsOf(entry);
    if (!fields.length) throw new Error('图层「' + (entry.name || '') + '」没有属性字段');

    const field = String(params.FIELD || '').trim() || fields[0];
    if (fields.indexOf(field) < 0) {
      throw new Error('字段「' + field + '」不存在（可用：' + fields.join('、') + '）');
    }

    const k = Math.max(2, Math.min(20, Number(params.CLASSES) || 5));
    const method = String(params.METHOD || '自然断点');
    const rule = S.gradeByField(entry, field, {
      method: method,
      classes: k,
      sizeScale: params.SIZE_SCALE !== false,
    });
    if (!rule) throw new Error('分级失败：字段「' + field + '」没有可用取值');

    const rows = (rule.classes || []).map(function (c) {
      return [c.label != null ? c.label : (c.min + ' ~ ' + c.max), c.count != null ? c.count : '', c.color];
    });
    return {
      kind: 'table',
      stats: {
        图层: entry.name || entry.id,
        字段: field,
        分级方式: rule.mode === 'categorical' ? '枚举分档' : method,
        级数: (rule.classes || []).length,
        要素数: countEntitiesOf(entry),
      },
      table: {
        columns: ['分级', '要素数', '颜色'],
        rows: rows,
      },
    };
  }

  function countEntitiesOf(entry) {
    try {
      const ents = entry.datasource && entry.datasource.entities;
      return ents && ents.values ? ents.values.length : 0;
    } catch (err) {
      return 0;
    }
  }

  function round2(v) {
    return Math.round(Number(v) * 100) / 100;
  }

  async function runBuffer(params) {
    const vec = resolveVector(params.INPUT);
    if (!vec) throw new Error(noVectorMessage());
    const radius = Number(params.DISTANCE) || 1000;
    const segs = Math.max(8, Math.min(512, Number(params.SEGMENTS) || 64));
    let ring;
    if (vec.type === 'point') ring = bufferCircle(vec.points[0], radius, segs);
    else if (vec.type === 'line') ring = bufferPolyline(vec.points, radius);
    else ring = bufferPolygon(vec.points, radius);
    const features = [polygonFeature(ring, { 缓冲距离: radius, 来源: vec.name })];
    return {
      kind: 'vector',
      geojson: { type: 'FeatureCollection', features: features },
      bounds: boundsOfFeatures(features),
      stats: { 半径: radius + ' m', 要素数: features.length },
    };
  }

  async function runCentroid(params) {
    const vec = resolveVector(params.INPUT);
    if (!vec) throw new Error(noVectorMessage());
    const c = vec.type === 'polygon' ? ringCentroid(vec.points) : averagePoint(vec.points);
    const features = [{
      type: 'Feature',
      properties: { 类型: vec.type, 来源: vec.name },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    }];
    return {
      kind: 'vector',
      geojson: { type: 'FeatureCollection', features: features },
      bounds: boundsOfFeatures(features),
      stats: { 质心: c.lon.toFixed(6) + ', ' + c.lat.toFixed(6) },
    };
  }

  async function runConvexHull(params) {
    const vec = resolveVector(params.INPUT);
    if (!vec) throw new Error(noVectorMessage());
    const pts = vec.points.map((p) => ({ x: p.lon, y: p.lat }));
    const hull = convexHull(pts);
    const features = hull.length >= 3
      ? [polygonFeature(hull.map((p) => ({ lon: p.x, lat: p.y })), { 来源: vec.name })]
      : [];
    return {
      kind: 'vector',
      geojson: { type: 'FeatureCollection', features: features },
      bounds: boundsOfFeatures(features),
      stats: { 顶点数: hull.length },
    };
  }

  async function runLengthArea(params) {
    const vec = resolveVector(params.INPUT);
    if (!vec) throw new Error(noVectorMessage());
    let length = 0;
    for (let i = 1; i < vec.points.length; i++) {
      length += haversine(vec.points[i - 1].lon, vec.points[i - 1].lat, vec.points[i].lon, vec.points[i].lat);
    }
    const area = vec.type === 'polygon' ? ringAreaM2(vec.points) : 0;
    return {
      kind: 'table',
      bounds: boundsOfPoints(vec.points),
      stats: {
        类型: vec.type,
        顶点数: vec.points.length,
        长度: length >= 1000 ? (length / 1000).toFixed(3) + ' km' : length.toFixed(2) + ' m',
        面积: area >= 1e6 ? (area / 1e6).toFixed(4) + ' km²' : area.toFixed(2) + ' m²',
      },
    };
  }

  async function runProfile(params) {
    const vec = resolveVector(params.INPUT);
    if (!vec) throw new Error(noVectorMessage());
    if (vec.points.length < 2) throw new Error('至少需要两个点才能做剖面');
    const step = Math.max(10, Number(params.STEP) || 100);
    const samples = densify(vec.points, step);
    const coords = [];
    let min = Infinity;
    let max = -Infinity;
    let gain = 0;
    for (let i = 0; i < samples.length; i++) {
      const h = sampleHeight(samples[i].lon, samples[i].lat);
      if (h < min) min = h;
      if (h > max) max = h;
      if (i > 0 && h > samples[i - 1].h) gain += h - samples[i - 1].h;
      samples[i].h = h;
      coords.push([samples[i].lon, samples[i].lat, Math.round(h * 100) / 100]);
    }
    const features = [{
      type: 'Feature',
      properties: {
        最低: Math.round(min),
        最高: Math.round(max),
        累计爬升: Math.round(gain),
        采样点: samples.length,
      },
      geometry: { type: 'LineString', coordinates: coords },
    }];
    return {
      kind: 'vector',
      geojson: { type: 'FeatureCollection', features: features },
      bounds: boundsOfFeatures(features),
      stats: {
        最低高程: Math.round(min) + ' m',
        最高高程: Math.round(max) + ' m',
        累计爬升: Math.round(gain) + ' m',
        采样点: samples.length,
      },
      // 同时给一份明细表，面板里可以直接看逐点高程（行数封顶，避免面板撑爆）
      table: {
        columns: ['序号', '经度', '纬度', '高程 (m)'],
        rows: coords.slice(0, 500).map(function (c, i) {
          return [i + 1, c[0].toFixed(6), c[1].toFixed(6), c[2]];
        }),
      },
    };
  }

  async function runInterpolate(params) {
    const vec = resolveVector(params.INPUT);
    if (!vec) throw new Error(noVectorMessage());
    if (vec.points.length < 3) throw new Error('TIN 插值至少需要 3 个点');
    const power = Number(params.POWER);
    const p = isFinite(power) ? power : 2;
    const radius = Number(params.RADIUS) || 0;
    const size = Math.max(32, Math.min(1024, Number(params.OUTPUT_SIZE) || 256));
    const b = boundsOfPoints(vec.points);
    const pad = Math.max(0.001, (b.east - b.west) * 0.05);
    const west = b.west - pad;
    const east = b.east + pad;
    const south = b.south - pad;
    const north = b.north + pad;
    const vals = new Float32Array(size * size);
    const dx = (east - west) / (size - 1);
    const dy = (north - south) / (size - 1);
    // 点的取值：优先用要素自带高程，否则现采 DEM
    const src = vec.points.map((pt) => ({
      lon: pt.lon,
      lat: pt.lat,
      h: pt.height != null && isFinite(pt.height) ? pt.height : sampleHeight(pt.lon, pt.lat),
    }));
    for (let row = 0; row < size; row++) {
      const lat = north - row * dy;
      for (let col = 0; col < size; col++) {
        const lon = west + col * dx;
        let num = 0;
        let den = 0;
        for (const pt of src) {
          const d = haversine(lon, lat, pt.lon, pt.lat);
          if (radius > 0 && d > radius) continue;
          const wgt = d < 1e-6 ? 1e9 : 1 / Math.pow(d, p);
          num += wgt * pt.h;
          den += wgt;
        }
        vals[row * size + col] = den > 0 ? num / den : 0;
      }
    }
    const grid = {
      w: size, h: size, west: west, south: south, east: east, north: north,
      dx: dx, dy: dy, cellSize: 1, data: vals,
    };
    const canvas = renderField(grid, vals, { min: minOf(vals), max: maxOf(vals), palette: 'terrain' });
    return {
      kind: 'raster',
      png: canvasToDataUrl(canvas),
      bounds: [west, south, east, north],
      stats: { 采样点: src.length, 幂次: p, 搜索半径: radius || '不限' },
    };
  }

  /* ================================================================ 工具 */

  function maxOf(arr) {
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return isFinite(m) ? m : 0;
  }

  function minOf(arr) {
    let m = Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return isFinite(m) ? m : 0;
  }

  function averagePoint(points) {
    let lon = 0;
    let lat = 0;
    for (const p of points) { lon += p.lon; lat += p.lat; }
    return { lon: lon / points.length, lat: lat / points.length };
  }

  function polygonFeature(ring, props) {
    const coords = ring.map((p) => [p.lon, p.lat]);
    if (coords.length && (coords[0][0] !== coords[coords.length - 1][0] ||
      coords[0][1] !== coords[coords.length - 1][1])) {
      coords.push([coords[0][0], coords[0][1]]);
    }
    return {
      type: 'Feature',
      properties: props || {},
      geometry: { type: 'Polygon', coordinates: [coords] },
    };
  }

  function boundsOfFeatures(features) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const walk = (coords, depth) => {
      if (depth === 0) {
        if (!Array.isArray(coords)) return;
        const [lon, lat] = coords;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        return;
      }
      for (const c of coords) walk(c, depth - 1);
    };
    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Point') walk(g.coordinates, 0);
      else if (g.type === 'LineString') walk(g.coordinates, 1);
      else if (g.type === 'Polygon') walk(g.coordinates, 2);
    }
    if (!isFinite(west)) return [0, 0, 0, 0];
    return [west, south, east, north];
  }

  function boundsOfPoints(points) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const p of points) {
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
    }
    return [west, south, east, north];
  }

  /** Andrew monotone chain 凸包。 */
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /* ============================================================== 对外 API */

  function algorithms() {
    return ALGORITHMS.map((a) => ({
      id: a.id,
      name: a.name,
      group: a.group,
      description: a.description,
      parameters: a.params,
      native: true,
    }));
  }

  function groups() {
    const map = new Map();
    for (const a of ALGORITHMS) {
      if (!map.has(a.group)) map.set(a.group, []);
      map.get(a.group).push(a);
    }
    const out = [];
    map.forEach((items, group) => out.push({ group: group, count: items.length, items: items }));
    out.sort((x, y) => y.count - x.count);
    return out;
  }

  async function run(id, params) {
    const algo = ALGORITHMS.find((a) => a.id === id);
    if (!algo) throw new Error('未知的原生算法：' + id);
    const p = Object.assign({}, params || {});
    for (const def of algo.params) {
      if (p[def.name] == null && def.default != null) p[def.name] = def.default;
    }
    return await algo.run(p);
  }

  /**
   * 批量运行：**每个绘制面跑一次**，每个面用自己的掩膜。
   *
   * 这是「栅格运算」的批量流程 —— 用户画了 5 个面，就得到 5 张图，
   * 每张只显示自己那个面的范围，而不是把所有面并成一张。
   *
   * 与「绘制范围」单次运行的差别：
   *   - 单次：所有面取并集外接矩形当采样框，掩膜是「任一命中」
   *   - 批量：逐面跑，采样框是那个面的外接矩形，掩膜只认那个面
   *
   * @param {string} id 算法 ID
   * @param {object} params 算法参数（SCOPE 会被强制设为 '绘制范围'）
   * @param {object} opts { onProgress(done, total, name), keepGoing }
   *   keepGoing 默认 true：单个面失败不中断整批，失败记进 results[].error
   * @returns {Promise<{total, ok, failed, results}>}
   */
  async function runBatch(id, params, opts) {
    opts = opts || {};
    const algo = ALGORITHMS.find((a) => a.id === id);
    if (!algo) throw new Error('未知的原生算法：' + id);

    // 只有带 SCOPE 的算法能按面跑（掩膜是栅格概念）
    const hasScope = (algo.params || []).some(function (p) { return p.name === 'SCOPE'; });
    if (!hasScope) {
      throw new Error('「' + algo.name + '」没有分析范围参数，无法按绘制面批量运行。');
    }

    const polys = drawnMaskPolygons();
    if (!polys.length) {
      throw new Error('批量运行需要先在地图上画至少一个面（多边形），请在「绘制」面板里绘制。');
    }

    const keepGoing = opts.keepGoing !== false;
    const results = [];
    let okCount = 0, failCount = 0;

    for (let i = 0; i < polys.length; i++) {
      const poly = polys[i];
      const p = Object.assign({}, params || {});
      p.SCOPE = '绘制范围';
      p.MASK_POLY_ID = poly.id;
      if (opts.onProgress) {
        try { opts.onProgress(i, polys.length, poly.name); } catch (err) { /* ignore */ }
      }
      try {
        const res = await run(id, p);
        results.push({ id: poly.id, name: poly.name, ok: true, result: res });
        okCount++;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        results.push({ id: poly.id, name: poly.name, ok: false, error: msg });
        failCount++;
        if (!keepGoing) throw err;
      }
    }

    return { total: polys.length, ok: okCount, failed: failCount, results: results };
  }

  /**
   * 批量运行并把每个面的结果都挂成图层。
   *
   * 复用 runBatch 已经算好的结果（不重跑一遍算法）——
   * DEM 采样 + 掩膜 + 出图对每个面都是实打实的开销，跑两遍太浪费。
   */
  async function runBatchToLayer(le, id, params, opts) {
    opts = opts || {};
    const algo = ALGORITHMS.find((a) => a.id === id);
    const baseName = opts.name || ((algo ? algo.name : id) + ' 结果');
    const batch = await runBatch(id, params, {
      onProgress: opts.onProgress,
      keepGoing: opts.keepGoing,
    });
    const entries = [];
    for (const r of batch.results) {
      if (!r.ok) continue;
      const one = await mountResultToLayer(le, r.result, baseName + ' · ' + r.name, opts);
      entries.push({ id: r.id, name: r.name, entry: one && one.entry });
    }
    return { batch: batch, entries: entries };
  }

  /**
   * 运行并把结果加载为地球图层。
   */
  async function runToLayer(le, id, params, opts) {
    opts = opts || {};
    const algo = ALGORITHMS.find((a) => a.id === id);
    const res = await run(id, params);
    const name = opts.name || ((algo ? algo.name : id) + ' 结果');
    return await mountResultToLayer(le, res, name, opts);
  }

  /**
   * 把**已经算好**的结果挂成地球图层（runToLayer / runBatchToLayer 共用）。
   */
  async function mountResultToLayer(le, res, name, opts) {
    opts = opts || {};

    if (res.kind === 'vector' && res.geojson) {
      const blob = new Blob([JSON.stringify(res.geojson)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      try {
        if (window.LEImports && typeof window.LEImports.importGeoJsonUrl === 'function') {
          const entry = await window.LEImports.importGeoJsonUrl(le, url, name);
          return { result: res, entry: entry };
        }
        throw new Error('GeoJSON 导入通道不可用');
      } finally {
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      }
    }
    if (res.kind === 'raster' && res.png) {
      if (window.LELayers && typeof window.LELayers.addImageOverlay === 'function') {
        const entry = window.LELayers.addImageOverlay(le, {
          url: res.png,
          rectangle: res.bounds,
          name: name,
          credit: '原生分析引擎',
          opacity: opts.opacity != null ? opts.opacity : 0.85,
        });
        return { result: res, entry: entry };
      }
      throw new Error('影像图层通道不可用');
    }
    if (res.kind === 'table') {
      return { result: res, entry: null };
    }
    throw new Error('无法识别的结果类型：' + res.kind);
  }

  function capabilities() {
    const st = window.LEDemTiles ? window.LEDemTiles.stats() : null;
    return {
      dem: !!window.LEDemTiles,
      demReady: !!(st && st.ready),
      demEnabled: !!(st && st.enabled),
      demCoverage: st ? st.bbox : null,
      vector: collectVectorInputs().length,
      raster: true,
      externalProcess: false, // 关键：原生实现，不起任何外部进程
    };
  }

  window.LEAnalysis = {
    algorithms: algorithms,
    groups: groups,
    list: algorithms,
    run: run,
    runToLayer: runToLayer,
    runBatch: runBatch,
    runBatchToLayer: runBatchToLayer,
    capabilities: capabilities,
    currentViewRect: currentViewRect,
    collectVectorInputs: collectVectorInputs,
    /** 「绘制范围」相关：供 UI 与测试使用 */
    scopeOptions: SCOPE_OPTIONS,
    drawnMaskPolygons: drawnMaskPolygons,
    maskPolygonsFor: maskPolygonsFor,
    resolveScope: resolveScope,
    // 供其它模块复用
    helpers: {
      haversine: haversine,
      densify: densify,
      sampleHeight: sampleHeight,
      sampleGrid: sampleGrid,
      slopeAspect: slopeAspect,
      contour: contour,
      bufferCircle: bufferCircle,
      bufferPolyline: bufferPolyline,
      bufferPolygon: bufferPolygon,
      ringAreaM2: ringAreaM2,
      pointInRing: pointInRing,
      gridMask: gridMask,
      gridMaskForPixels: gridMaskForPixels,
      maskGridBands: maskGridBands,
      maskedValues: maskedValues,
      maskValidIndices: maskValidIndices,
      polygonsBBox: polygonsBBox,
      pointPolylineDistanceM: pointPolylineDistanceM,
      convexHull: convexHull,
      destinationPoint: destinationPoint,
      bearingBetween: bearingBetween,
    },
  };
})();

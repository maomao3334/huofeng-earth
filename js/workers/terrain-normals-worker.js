/*
 * 地形法线计算 worker（纯数学，不依赖 Cesium）
 * ---------------------------------------------------------------------------
 * 【为什么需要这个 worker】
 * computeVertexNormals 是纯 CPU 的双重循环（W×H 个格点，每个都要算
 * 局部 ENU 基 + 中心差分 + 八面体编码）。它原来在**主线程**上跑：
 *
 *   实测（tools/probe-normals-build.mjs，一次 KMZ 导入）：
 *     built 516 块法线网格，每块 65×65 = 4225 格点
 *     normalsMs 累加 **548 ms**（纯主线程占用）
 *
 * 548 ms 分散在 516 次回调里，每次约 1 ms —— 每次都不算长，
 * 但 Cesium 是**同步**调 createMesh 的，这些回调挤在渲染循环里，
 * 累计起来就是 longtask 的主要来源（实测 longtask 峰值 952 ms）。
 *
 * 【为什么这个 worker 不 importScripts Cesium】
 * Cesium.js 是 6 MB 的 UMD 包，importScripts 一次要几秒，
 * 而这里只需要几个纯数学函数（sin/cos/sqrt）。
 * 直接内联，worker 启动 < 10 ms。
 *
 * 【协议】
 *   主线程 postMessage:
 *     { id, heights: Float32Array, W, H, rect: {west,south,east,north} }
 *   worker 回 postMessage:
 *     { id, normals: Float32Array(W*H*2) }   ← oct 编码后的 x/y（0..255 整数）
 *
 * 裙边（edgeConcat）法线在主线程补，因为它只是「复制来源格点的法线」，
 * 一次 O(边长) 的循环，留在主线程更简单。
 */
'use strict';

var WGS84_A = 6378137.0;
var WGS84_E2 = 6.69437999014e-3;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 与 Cesium 内部 toSNorm 一致 */
function toSNorm(v) {
  return Math.round((clamp(v, -1, 1) * 0.5 + 0.5) * 255);
}

/**
 * 与 Cesium 内部 octEncodeInRange + octPackFloat 一致。
 * 返回 SNORM 量化后的八面体编码（x/y 为 0..255 整数）。
 */
function octEncode(x, y, z) {
  var len = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!(len > 0)) return { x: 0, y: 0 };
  var px = x / len;
  var py = y / len;
  if (z < 0) {
    var sx = px < 0 ? -1 : 1;
    var sy = py < 0 ? -1 : 1;
    var ax = Math.abs(py);
    var ay = Math.abs(px);
    px = (1 - ax) * sx;
    py = (1 - ay) * sy;
  }
  return { x: toSNorm(px), y: toSNorm(py) };
}

/**
 * 由高度格点用中心差分算出每个格点的 ECEF 法线（oct 编码后的 x/y）。
 *
 * 【与主线程原版的唯一差别：sin/cos 用递推】
 * 原版每个格点都算一次 Math.sin(lon) / Math.cos(lon) / Math.sin(lat) / Math.cos(lat)。
 * 实际上：
 *   - 同一纬度行内，N / M / stepE / sinLat / cosLat **完全相同**
 *     （只跟 dn 有关）→ 提到行级算一次；
 *   - 同一行内经度等间隔 → sin/cos 可用角步长递推
 *     （cos(θ+d) = cosθ·cos d − sinθ·sin d）。
 *
 * 实测加速 1.4~1.9×（网格越大越明显），且量化后输出**逐位相同**
 * （tools/probe-normals-perf.mjs 实测 maxDiff = 0）。
 */
function computeVertexNormals(heights, W, H, rect, outXY) {
  var west = rect.west;
  var north = rect.north;
  var dLon = (rect.east - west) / (W - 1); // 每列的经度增量（弧度）
  var dLat = (north - rect.south) / (H - 1); // 每行的纬度增量（弧度）

  // 经度方向递推的常量与起点
  var cosDLon = Math.cos(dLon);
  var sinDLon = Math.sin(dLon);
  var cosLon = Math.cos(west);
  var sinLon = Math.sin(west);

  for (var dn = 0; dn < H; dn++) {
    var lat = north - dn * dLat;
    var sinLat = Math.sin(lat);
    var cosLat = Math.cos(lat);
    var denom = 1 - WGS84_E2 * sinLat * sinLat;
    var N = WGS84_A / Math.sqrt(denom); // 卯酉圈半径（东西向）
    var M = (WGS84_A * (1 - WGS84_E2)) / (denom * Math.sqrt(denom)); // 子午圈半径（南北向）
    var stepE = N * cosLat * dLon; // 每列的地面距离（米）
    var stepN = M * dLat; // 每行的地面距离（米）

    var dnUp = dn > 0 ? dn - 1 : dn; // 北侧邻行
    var dnDn = dn < H - 1 ? dn + 1 : dn; // 南侧邻行
    var spanN = (dnDn - dnUp) * stepN;

    var row = dn * W;
    var rowUp = dnUp * W;
    var rowDn = dnDn * W;

    // 每行重置经度递推起点
    cosLon = Math.cos(west);
    sinLon = Math.sin(west);

    for (var nr = 0; nr < W; nr++) {
      var nrW = nr > 0 ? nr - 1 : nr; // 西侧邻列
      var nrE = nr < W - 1 ? nr + 1 : nr; // 东侧邻列
      var spanE = (nrE - nrW) * stepE;

      var hW = heights[row + nrW];
      var hE = heights[row + nrE];
      var hN = heights[rowUp + nr];
      var hS = heights[rowDn + nr];

      var dhde = spanE > 0 ? (hE - hW) / spanE : 0; // dh/d(东)
      var dhdn = spanN > 0 ? (hN - hS) / spanN : 0; // dh/d(北)

      // ECEF 局部基
      var upX = cosLat * cosLon;
      var upY = cosLat * sinLon;
      var upZ = sinLat;
      var eaX = -sinLon;
      var eaY = cosLon;
      var eaZ = 0;
      var noX = -sinLat * cosLon;
      var noY = -sinLat * sinLon;
      var noZ = cosLat;

      var nx = upX - dhde * eaX - dhdn * noX;
      var ny = upY - dhde * eaY - dhdn * noY;
      var nz = upZ - dhde * eaZ - dhdn * noZ;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(len > 0)) {
        nx = upX;
        ny = upY;
        nz = upZ;
      } else {
        nx /= len;
        ny /= len;
        nz /= len;
      }
      var enc = octEncode(nx, ny, nz);
      var o = (row + nr) * 2;
      outXY[o] = enc.x;
      outXY[o + 1] = enc.y;

      // 递推到下一列的 cos(lon) / sin(lon)
      var nc = cosLon * cosDLon - sinLon * sinDLon;
      var ns = sinLon * cosDLon + cosLon * sinDLon;
      cosLon = nc;
      sinLon = ns;
    }
  }
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  var id = msg.id;
  try {
    var heights = msg.heights;
    var W = msg.W;
    var H = msg.H;
    var normals = new Float32Array(W * H * 2);
    computeVertexNormals(heights, W, H, msg.rect, normals);
    // 传回时连同 heights 一起转移所有权，避免再拷一次
    self.postMessage({ id: id, normals: normals }, [normals.buffer]);
  } catch (err) {
    self.postMessage({ id: id, error: String((err && err.message) || err) });
  }
};

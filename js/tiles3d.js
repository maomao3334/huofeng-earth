/*
 * 3D Tiles 内核（纯计算，不依赖 Cesium，可在 Node 里单测）
 * ---------------------------------------------------------------------------
 * P2-4.8「三维倾斜摄影 / 3D Tiles 切片流」的内核部分。
 *
 * 【它解决什么】
 *   倾斜摄影数据（.b3dm / .glb / .pnts / .cmpt / .i3s）在本机是**一整个目录树**：
 *     根目录里放一个 tileset.json，它按层级引用下级瓦片文件。
 *   Cesium 能渲染它，但 Cesium 只认「URL」——浏览器又拿不到本机绝对路径。
 *   所以本内核负责三件事：
 *     1) **读懂 tileset.json**：解析版本、瓦片树、几何误差、内容类型；
 *     2) **算出范围与统计**：包围盒（经纬度）、瓦片数、层级分布，供 UI 显示；
 *     3) **识别不支持的旧格式**：.osgb / .3DML / .slpk 明确告知用户
 *        「本软件不支持这种格式」，而不是让它在 Cesium 里报一堆看不懂的错。
 *
 * 【为什么要有内核】
 *   瓦片树的解析、包围盒换算、路径拼接全是纯计算，做成内核就能在 Node 里
 *   单测（毫秒级、结果确定），浏览器那边只负责「把 JSON 喂进来、拿结果用」。
 *
 * 【纯离线】
 *   本文件不读 DOM、不联网、不写文件。
 *
 * 对外 API（window.LETiles3D）：
 *   parseTileset(text)          → tileset 对象（带校验）
 *   walk(root)                  → 瓦片树扁平表
 *   summarize(tileset)          → 统计摘要
 *   bboxOf(tileset)             → { west, south, east, north }（经纬度）
 *   centerOf(bbox)              → { lon, lat }
 *   resolveUri(uri, base)       → 相对路径拼接（处理 ./ 与 ../）
 *   contentTypeOf(uri)          → 该内容文件的 MIME
 *   catalog(names)              → 在一个目录树里找可加载的数据集
 *   legacyFormats(names)        → 列出本软件不支持的旧格式
 *   levelCounts(tileset)        → 每层瓦片数
 */
(function (root) {
  'use strict';

  /** 3D Tiles 内容文件的扩展名 → MIME（与服务端 serve.ps1 的表一致）。 */
  const CONTENT_MIME = {
    b3dm: 'application/octet-stream',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    pnts: 'application/octet-stream',
    cmpt: 'application/octet-stream',
    i3s: 'application/octet-stream',
    cts: 'application/octet-stream',
    vctr: 'application/octet-stream',
    geojson: 'application/geo+json',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    ktx2: 'image/ktx2',
    bin: 'application/octet-stream',
    terrain: 'application/octet-stream',
  };

  /** Cesium 原生不支持、但用户目录里常见的旧式倾斜摄影格式。 */
  const LEGACY_EXT = {
    osgb: 'OSGB（ContextScene 旧式倾斜摄影）',
    '3dml': '3DML（旧式 CityGML 倾斜摄影）',
    dae: 'COLLADA（需先转 glTF / 3D Tiles）',
    dwg: 'DWG（需先转 glTF / 3D Tiles）',
  };

  const WGS84_A = 6378137.0;
  const WGS84_E2 = 6.69437999014e-3;

  /* ============================================================ 基础工具 */

  function extOf(name) {
    return (/\.([^.]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || '';
  }

  function baseName(name) {
    return String(name || '').split(/[\\/]/).pop();
  }

  /** 目录树里的相对路径 → 正斜杠形式（去掉开头的 ./ 与 /）。 */
  function normalizeRel(rel) {
    let s = String(rel || '').replace(/\\/g, '/');
    while (s.indexOf('./') === 0) s = s.slice(2);
    s = s.replace(/^\/+/, '');
    return s;
  }

  /**
   * 拼接相对地址：base 为目录（以 / 结尾或为空），uri 可能是 ./x、../x。
   * 与 Cesium 的 URI 解析规则一致（tileset.json 里的 uri 相对其自身目录）。
   */
  function resolveUri(uri, base) {
    let u = String(uri == null ? '' : uri).replace(/\\/g, '/');
    if (!u) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;   // 已经是绝对地址
    if (u.charAt(0) === '/') return u.slice(1);      // 站内绝对路径
    const parts = normalizeRel(base).split('/').filter(Boolean);
    parts.pop();                                    // 去掉 base 自身的文件名
    for (const seg of u.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join('/');
  }

  /** 内容文件的 MIME。 */
  function contentTypeOf(uri) {
    const ext = extOf(uri);
    return CONTENT_MIME[ext] || 'application/octet-stream';
  }

  /* ======================================================== tileset 解析 */

  /**
   * 解析并校验 tileset.json。
   * @param {string|object} text JSON 文本或已解析对象
   */
  function parseTileset(text) {
    let j = text;
    if (typeof j === 'string') {
      try {
        j = JSON.parse(j);
      } catch (err) {
        throw new Error('tileset.json 解析失败：' + (err && err.message ? err.message : err));
      }
    }
    if (!j || typeof j !== 'object') throw new Error('tileset.json 内容为空');
    if (!j.asset) throw new Error('tileset.json 缺少 asset 属性');
    if (!j.root) throw new Error('tileset.json 缺少 root 瓦片');
    const version = String(j.asset.version || '');
    if (version && version !== '1.0' && version !== '1.1' && version !== '0.0') {
      throw new Error('不支持的 3D Tiles 版本：' + version + '（支持 1.0 / 1.1）');
    }
    return j;
  }

  /**
   * 把瓦片树摊平成一维表。
   * @returns {Array<{path:string[], depth:number, geometricError:number,
   *                   refine:string, contentUri:string, contentType:string}>}
   */
  function walk(root) {
    const out = [];
    const stack = [];
    if (!root) return out;
    stack.push({ tile: root, path: [], depth: 0 });
    while (stack.length) {
      const cur = stack.pop();
      const tile = cur.tile || {};
      const p = cur.path.concat([tile.content ? 1 : 0]);
      // 1.1 允许一个瓦片有多个内容（contents 数组）
      const contents = [];
      if (Array.isArray(tile.contents)) {
        for (const c of tile.contents) {
          if (c && (c.uri || c.url)) contents.push(c.uri || c.url);
        }
      }
      if (tile.content && (tile.content.uri || tile.content.url)) {
        contents.push(tile.content.uri || tile.content.url);
      }
      for (const uri of contents) {
        out.push({
          path: p,
          depth: cur.depth,
          geometricError: typeof tile.geometricError === 'number' ? tile.geometricError : 0,
          refine: String(tile.refine || (cur.depth === 0 ? 'REPLACE' : '')),
          contentUri: String(uri),
          contentType: contentTypeOf(uri),
        });
      }
      const kids = Array.isArray(tile.children) ? tile.children : [];
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ tile: kids[i], path: p, depth: cur.depth + 1 });
      }
    }
    return out;
  }

  /** 每层（深度）的瓦片数，用于 UI 显示层级分布。 */
  function levelCounts(tileset) {
    const rows = walk(tileset && tileset.root);
    const map = new Map();
    for (const r of rows) map.set(r.depth, (map.get(r.depth) || 0) + 1);
    return Array.from(map.keys()).sort((a, b) => a - b).map((d) => ({
      depth: d,
      count: map.get(d),
    }));
  }

  /* ======================================================== 包围盒计算 */

  /** ECEF（地心地固）→ 经纬度（度）。 */
  function ecefToLonLat(x, y, z) {
    // 退化情形：点在地轴上（p = 0）
    const p = Math.sqrt(x * x + y * y);
    if (p < 1e-6) {
      const b = WGS84_A * Math.sqrt(1 - WGS84_E2);
      if (Math.abs(z) < 1e-6) return { lon: 0, lat: 0, height: -b };
      const lat = z >= 0 ? 90 : -90;
      return { lon: 0, lat: lat, height: Math.abs(z) - b };
    }
    const lon = Math.atan2(y, x);
    // 初值：等距圆柱近似
    let lat = Math.atan2(z, p * (1 - WGS84_E2));
    let h = 0;
    for (let i = 0; i < 8; i++) {
      const sinLat = Math.sin(lat);
      const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
      h = p / Math.cos(lat) - N;
      const next = Math.atan2(z, p * (1 - (WGS84_E2 * N) / (N + h)));
      // 迭代不收敛时（分母趋零）就地停下，保留上一轮结果
      if (!isFinite(next)) break;
      if (Math.abs(next - lat) < 1e-12) { lat = next; break; }
      lat = next;
    }
    if (!isFinite(lat)) lat = Math.atan2(z, p);
    if (!isFinite(h)) h = 0;
    return { lon: (lon * 180) / Math.PI, lat: (lat * 180) / Math.PI, height: h };
  }

  /** 区域包围体（region）→ 经纬度范围。region = [西, 南, 东, 北, 最低高, 最高高]（弧度）。 */
  function regionToBBox(region) {
    if (!Array.isArray(region) || region.length < 4) return null;
    return {
      west: (region[0] * 180) / Math.PI,
      south: (region[1] * 180) / Math.PI,
      east: (region[2] * 180) / Math.PI,
      north: (region[3] * 180) / Math.PI,
    };
  }

  /** 盒包围体（box）→ 近似经纬度范围（用中心点 ± 半径换算）。 */
  function boxToBBox(box) {
    if (!Array.isArray(box) || box.length < 12) return null;
    const c = ecefToLonLat(box[0], box[1], box[2]);
    // 半轴的模，用来估算水平半径
    const ax = Math.hypot(box[3], box[4], box[5]);
    const ay = Math.hypot(box[6], box[7], box[8]);
    const az = Math.hypot(box[9], box[10], box[11]);
    const radius = ax + ay + az;
    const dLat = (radius / 111320) * 1.2;
    const cosLat = Math.max(0.01, Math.cos((c.lat * Math.PI) / 180));
    const dLon = (radius / (111320 * cosLat)) * 1.2;
    return {
      west: c.lon - dLon,
      south: c.lat - dLat,
      east: c.lon + dLon,
      north: c.lat + dLat,
    };
  }

  function unionBBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      west: Math.min(a.west, b.west),
      south: Math.min(a.south, b.south),
      east: Math.max(a.east, b.east),
      north: Math.max(a.north, b.north),
    };
  }

  /**
   * 整棵瓦片树的范围（经纬度）。
   * @returns {{west,south,east,north}|null}
   */
  function bboxOf(tileset) {
    const root = tileset && tileset.root;
    if (!root) return null;
    let box = null;
    const stack = [root];
    while (stack.length) {
      const tile = stack.pop();
      const bv = tile && tile.boundingVolume;
      if (bv) {
        if (Array.isArray(bv.region)) box = unionBBox(box, regionToBBox(bv.region));
        else if (Array.isArray(bv.box)) box = unionBBox(box, boxToBBox(bv.box));
      }
      const kids = Array.isArray(tile && tile.children) ? tile.children : [];
      for (const k of kids) stack.push(k);
    }
    return box;
  }

  /** 范围中心。 */
  function centerOf(bbox) {
    if (!bbox) return null;
    return {
      lon: (bbox.west + bbox.east) / 2,
      lat: (bbox.south + bbox.north) / 2,
    };
  }

  /* ============================================================ 统计摘要 */

  /**
   * 统计摘要（给 UI 显示）。
   * @returns {{version, generator, tileCount, contentCount, maxDepth,
   *            contentTypes:object, geometricError:number, bbox:object,
   *            levels:Array, center:object}}
   */
  function summarize(tileset) {
    const rows = walk(tileset && tileset.root);
    const contentTypes = {};
    let maxDepth = 0;
    for (const r of rows) {
      contentTypes[r.contentType] = (contentTypes[r.contentType] || 0) + 1;
      if (r.depth > maxDepth) maxDepth = r.depth;
    }
    const bbox = bboxOf(tileset);
    return {
      version: String((tileset && tileset.asset && tileset.asset.version) || ''),
      generator: String((tileset && tileset.asset && tileset.asset.generator) || ''),
      tileCount: rows.length,
      contentCount: rows.length,
      maxDepth: maxDepth,
      contentTypes: contentTypes,
      geometricError: tileset && tileset.root && typeof tileset.root.geometricError === 'number'
        ? tileset.root.geometricError : 0,
      bbox: bbox,
      center: centerOf(bbox),
      levels: levelCounts(tileset),
    };
  }

  /* ====================================================== 目录树识别 */

  /**
   * 在一个目录树的文件名列表里找可加载的数据集。
   * @param {string[]} names 相对路径列表
   * @returns {Array<{kind, path, label}>}
   */
  function catalog(names) {
    const out = [];
    for (const raw of names || []) {
      const rel = normalizeRel(raw);
      if (!rel) continue;
      const base = baseName(rel);
      const ext = extOf(base);
      const lower = base.toLowerCase();
      if (ext === 'json' && /(^|[._-])tileset([._-]|$)/i.test(lower)) {
        out.push({ kind: '3dtiles', path: rel, label: '3D Tiles 数据集' });
      } else if (ext === 'json' && /(^|[._-])tilesetjson/i.test(lower)) {
        out.push({ kind: '3dtiles', path: rel, label: '3D Tiles 数据集' });
      } else if (ext === 'slpk') {
        out.push({ kind: 'i3s', path: rel, label: 'ESRI I3S 数据包（需另存为 I3S 服务）' });
      }
    }
    // 去重（同一目录里可能有多个 tileset.json）
    // 排序规则：**根目录的 tileset.json 优先**（那才是数据集入口），
    // 其余按路径字典序，保证结果稳定可复现。
    const seen = new Set();
    const uniq = [];
    for (const it of out.sort((a, b) => {
      const aRoot = a.path.indexOf('/') < 0 ? 0 : 1;
      const bRoot = b.path.indexOf('/') < 0 ? 0 : 1;
      if (aRoot !== bRoot) return aRoot - bRoot;
      return a.path.localeCompare(b.path);
    })) {
      const key = it.kind + '|' + it.path;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(it);
    }
    return uniq;
  }

  /**
   * 列出本软件**不支持**的旧格式（用于给用户明确提示，而不是让 Cesium 报错）。
   * @returns {Array<{ext, label, count, sample}>}
   */
  function legacyFormats(names) {
    const counts = new Map();
    const samples = new Map();
    for (const raw of names || []) {
      const ext = extOf(baseName(raw));
      if (!LEGACY_EXT[ext]) continue;
      counts.set(ext, (counts.get(ext) || 0) + 1);
      if (!samples.has(ext)) samples.set(ext, normalizeRel(raw));
    }
    return Array.from(counts.keys()).sort().map((ext) => ({
      ext: ext,
      label: LEGACY_EXT[ext],
      count: counts.get(ext),
      sample: samples.get(ext),
    }));
  }

  /* ============================================================== 对外 API */

  const api = {
    parseTileset: parseTileset,
    walk: walk,
    summarize: summarize,
    bboxOf: bboxOf,
    centerOf: centerOf,
    levelCounts: levelCounts,
    resolveUri: resolveUri,
    contentTypeOf: contentTypeOf,
    catalog: catalog,
    legacyFormats: legacyFormats,
    normalizeRel: normalizeRel,
    ecefToLonLat: ecefToLonLat,
    CONTENT_MIME: CONTENT_MIME,
    LEGACY_EXT: LEGACY_EXT,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LETiles3D = api;
})(typeof window !== 'undefined' ? window : globalThis);

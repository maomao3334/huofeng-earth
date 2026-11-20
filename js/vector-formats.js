/*
 * 矢量格式解析器（js/vector-formats.js）
 *
 * 把「各种格式的文件」统一解成同一个结构：
 *
 *   {
 *     features: [ { type:'point'|'line'|'polygon', coords, properties:{} } ],
 *     crs:      'EPSG:4548' | WKT 字符串 | null,   // 原始坐标系定义
 *     fields:   [ {name, type} ],
 *     warnings: [ '…' ],
 *   }
 *
 * 坐标一律保持「文件里的原样」（可能是投影坐标）；
 * 重投影交给 js/projections.js 在装载阶段统一做。
 *
 * 支持：
 *   - Shapefile (.shp + .dbf + .shx + .prj)
 *   - DBF 单独读（属性表）
 *   - GeoJSON / JSON
 *   - CSV / TXT（分隔符 + 可选 WKT 几何列 / lon-lat 列）
 *   - GML 2.x / 3.x
 *   - GPX 1.1
 *   - DXF（ASCII）
 *   - WKT 文本（单几何）
 *   - KML / KMZ（复用 js/kml-native.js，见 importers.js）
 *
 * 导出：window.LEFormats = {
 *   detect(fileName, bytes),        // → 'shapefile' | 'geojson' | ...
 *   parse(fileName, bytes, opts),   // → 上面的统一结构
 * }
 */
(function () {
  'use strict';

  /* ================================================================== *
   * 文本解码
   * ================================================================== */

  /** 把字节流解成字符串：优先 UTF-8，若出现替换字符则回退 GBK。 */
  function decodeText(bytes) {
    if (typeof TextDecoder === 'undefined') return String(bytes);
    try {
      const u8 = new Uint8Array(bytes);
      const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8);
      // U+FFFD 说明不是合法 UTF-8 → 试 GBK
      if (utf8.indexOf('�') >= 0) {
        try {
          const gbk = new TextDecoder('gbk', { fatal: false }).decode(u8);
          if (gbk.indexOf('�') < 0) return gbk;
        } catch (_) { /* 浏览器可能不支持 gbk */ }
      }
      return utf8;
    } catch (_) {
      return String(bytes);
    }
  }

  /** 把任意输入（Uint8Array / ArrayBuffer / Blob / File）变成 Uint8Array；Blob 是异步的。 */
  async function toBytes(input) {
    if (input == null) return null;
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      return new Uint8Array(await input.arrayBuffer());
    }
    return null;
  }

  function bytesOf(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Blob !== 'undefined' && input instanceof Blob) return null; // 需要 async
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  /* ================================================================== *
   * 格式探测
   * ================================================================== */

  const EXT_KIND = {
    shp: 'shapefile', dbf: 'dbf', shx: 'shpindex', prj: 'prj', cpg: 'cpg',
    gpkg: 'gpkg',
    geojson: 'geojson', json: 'geojson',
    csv: 'csv', tsv: 'csv', txt: 'csv',
    gml: 'gml', xml: 'gml',
    gpx: 'gpx',
    dxf: 'dxf',
    wkt: 'wkt', wkt2: 'wkt',
    kml: 'kml', kmz: 'kmz',
    asc: 'ascii-grid', hdr: 'ascii-grid',
    fgb: 'flatgeobuf',
    // 三维模型（P1-4.4）：由 js/models3d.js 处理
    glb: 'model3d', gltf: 'model3d', obj: 'model3d', stl: 'model3d',
  };

  /**
   * 探测文件格式。
   * @param {string} name 文件名
   * @param {Uint8Array} bytes 文件内容（可选，用于魔数判断）
   */
  function detect(name, bytes) {
    const lower = String(name || '').toLowerCase();
    const ext = (/\.([^.]+)$/.exec(lower) || [])[1] || '';

    // 魔数优先：SQLite 容器
    if (bytes && bytes.length >= 16) {
      const head = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 16)));
      if (head.slice(0, 15) === 'SQLite format 3') return 'gpkg';
      if (head.slice(0, 4) === 'PK') return 'zip';
      if (head.slice(0, 2) === 'PK') return 'zip';
      // FlatGeobuf 魔数
      const fb = new Uint8Array(bytes.slice(0, 8));
      const magic = String.fromCharCode(fb[0], fb[1], fb[2], fb[3]);
      if (magic === 'fgb' || magic === 'fgb\x03') return 'flatgeobuf';
      // Shapefile 魔数（.shp 大端 9994）
      if (bytes.length >= 4) {
        const code = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        if (code === 9994) return 'shapefile';
        // DBF 头：日期头 0x03 0x59 0x6D 0x30 ...
        if (bytes[0] === 0x03 && bytes[1] >= 0x30 && bytes[1] <= 0x3f) return 'dbf';
      }
    }

    if (EXT_KIND[ext]) return EXT_KIND[ext];

    // 扩展名不认识时，看内容
    if (bytes) {
      const head = decodeText(bytes.slice(0, 400)).trim();
      if (/^\s*\{/.test(head) && /"(type|features)"/.test(head)) return 'geojson';
      if (/^\s*</.test(head)) {
        if (/<gpx/i.test(head)) return 'gpx';
        if (/<kml/i.test(head)) return 'kml';
        if (/<[a-z]*:?FeatureCollection/i.test(head) || /<[a-z]*:?gml/i.test(head)) return 'gml';
      }
    }
    return 'unknown';
  }

  /* ================================================================== *
   * Shapefile
   * ================================================================== */

  const SHP_NULL = 0, SHP_POINT = 1, SHP_POLYLINE = 3, SHP_POLYGON = 5,
    SHP_MULTIPOINT = 8, SHP_POINTZ = 11, SHP_POLYLINEZ = 13, SHP_POLYGONZ = 15,
    SHP_MULTIPOINTZ = 18, SHP_POINTM = 21, SHP_POLYLINEM = 23, SHP_POLYGONM = 25,
    SHP_MULTIPOINTM = 28;

  /**
   * 解析 .shp（几何）。
   * @returns {Array} [{type, coords}] coords 为 GeoJSON 风格的坐标数组
   */
  function parseShp(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 100) throw new Error('SHP 文件太短');
    const fileCode = dv.getInt32(0);
    if (fileCode !== 9994) throw new Error('不是有效的 Shapefile（文件码 ' + fileCode + '）');
    const version = dv.getInt32(28, true);
    const shapeType = dv.getInt32(32, true);
    // bbox: 64..96
    const bbox = [
      dv.getFloat64(36, true), dv.getFloat64(44, true),
      dv.getFloat64(52, true), dv.getFloat64(60, true),
    ];

    const out = [];
    let offset = 100;
    const len = bytes.length;

    while (offset + 8 <= len) {
      const recNo = dv.getInt32(offset);
      // 注意：记录号是大端，但**内容长度也是大端**（ESRI Shapefile 规范如此）。
      // 读成小端会得到 167772160 这种天文数字，直接把循环冲出边界。
      const contentLen = dv.getInt32(offset + 4, false) * 2;
      const contentStart = offset + 8;
      if (contentLen < 4 || contentStart + contentLen > len) break;
      const st = dv.getInt32(contentStart, true);
      offset = contentStart + contentLen;

      if (st === SHP_NULL) continue;

      if (st === SHP_POINT || st === SHP_POINTZ || st === SHP_POINTM) {
        const x = dv.getFloat64(contentStart + 4, true);
        const y = dv.getFloat64(contentStart + 12, true);
        out.push({ type: 'point', coords: [x, y], recNo });
        continue;
      }
      if (st === SHP_MULTIPOINT || st === SHP_MULTIPOINTZ || st === SHP_MULTIPOINTM) {
        const n = dv.getInt32(contentStart + 36, true);
        const pts = [];
        for (let i = 0; i < n; i++) {
          const o = contentStart + 40 + i * 16;
          if (o + 16 > bytes.length) break;
          pts.push([dv.getFloat64(o, true), dv.getFloat64(o + 8, true)]);
        }
        out.push({ type: 'multipoint', coords: pts, recNo });
        continue;
      }
      if (
        st === SHP_POLYLINE || st === SHP_POLYLINEZ || st === SHP_POLYLINEM ||
        st === SHP_POLYGON || st === SHP_POLYGONZ || st === SHP_POLYGONM
      ) {
        const numParts = dv.getInt32(contentStart + 36, true);
        const numPoints = dv.getInt32(contentStart + 40, true);
        const partsOff = contentStart + 44;
        const pointsOff = partsOff + numParts * 4;
        const parts = [];
        for (let i = 0; i < numParts; i++) parts.push(dv.getInt32(partsOff + i * 4, true));
        const pts = [];
        for (let i = 0; i < numPoints; i++) {
          const o = pointsOff + i * 16;
          if (o + 16 > bytes.length) break;
          pts.push([dv.getFloat64(o, true), dv.getFloat64(o + 8, true)]);
        }
        const rings = [];
        for (let i = 0; i < parts.length; i++) {
          const s = parts[i];
          const e = i + 1 < parts.length ? parts[i + 1] : pts.length;
          const seg = pts.slice(s, e);
          if (seg.length) rings.push(seg);
        }
        const isPoly = st === SHP_POLYGON || st === SHP_POLYGONZ || st === SHP_POLYGONM;
        out.push({
          type: isPoly ? 'polygon' : 'line',
          rings: rings,
          coords: isPoly ? (rings[0] || []) : (rings[0] || []),
          recNo,
        });
        continue;
      }
      // MultiPatch 等忽略
    }
    return { features: out, bbox: bbox, shapeType: shapeType, version: version };
  }

  /* ================================================================== *
   * DBF（属性表）
   * ================================================================== */

  /**
   * 解析 .dbf → { fields:[{name,type,length,dec}], rows:[{}] }
   * @param {Uint8Array} bytes
   * @param {string} [encoding] 编码名（来自 .cpg），不给就猜
   */
  function parseDbf(bytes, encoding) {
    if (bytes.length < 32) throw new Error('DBF 文件太短');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numRecords = dv.getInt32(4, true);
    const headerLength = dv.getInt16(8, true);
    const recordLength = dv.getInt16(10, true);

    const fields = [];
    let pos = 32;
    while (pos < headerLength - 1) {
      const nameRaw = [];
      for (let i = 0; i < 11; i++) nameRaw.push(bytes[pos + i]);
      const name = decodeText(new Uint8Array(nameRaw)).replace(/\0.*$/, '').trim();
      const type = String.fromCharCode(bytes[pos + 11]);
      const length = bytes[pos + 16];
      const dec = bytes[pos + 17];
      if (!name && type === 0x0d) break;
      fields.push({ name: name, type: type, length: length, dec: dec });
      pos += 32;
    }

    const rows = [];
    const enc = encoding ? normalizeDbfEncoding(encoding) : guessDbfEncoding(bytes, headerLength);
    let rec = headerLength;
    for (let r = 0; r < numRecords; r++) {
      if (rec + recordLength > bytes.length) break;
      const deleted = bytes[rec] === 0x2a;
      let p = rec + 1;
      const obj = {};
      for (const f of fields) {
        const raw = bytes.slice(p, p + f.length);
        p += f.length;
        obj[f.name] = decodeDbfValue(raw, f, enc);
      }
      if (!deleted) rows.push(obj);
      rec += recordLength;
    }
    return { fields: fields, rows: rows };
  }

  /** DBF 编码猜测：有无高位字节决定是 GBK 还是单字节。 */
  function guessDbfEncoding(bytes, headerLength) {
    const limit = Math.min(bytes.length, headerLength + 2000);
    let hasHigh = false;
    for (let i = headerLength; i < limit; i++) {
      if (bytes[i] > 127) { hasHigh = true; break; }
    }
    return hasHigh ? 'gbk' : 'latin1';
  }

  /**
   * 把 .cpg 里写的编码名归一化成 TextDecoder 认识的标签。
   * 只支持本程序用得到的几种：UTF-8 / GBK / GB2312 / Latin-1。
   */
  function normalizeDbfEncoding(name) {
    const s = String(name || '').trim().toLowerCase().replace(/["']/g, '');
    if (!s) return null;
    if (/utf-?8/.test(s)) return 'utf-8';
    if (/gb2312|gbk|gb18030/.test(s)) return 'gbk';
    if (/latin-?1|iso-?8859-?1|cp1252/.test(s)) return 'latin1';
    return null;
  }

  function decodeDbfValue(raw, field, enc) {
    let s;
    try {
      if (enc === 'gbk' && typeof TextDecoder !== 'undefined') {
        s = new TextDecoder('gbk', { fatal: false }).decode(raw);
      } else if (enc === 'utf-8' && typeof TextDecoder !== 'undefined') {
        s = new TextDecoder('utf-8', { fatal: false }).decode(raw);
      } else {
        s = new TextDecoder('latin1').decode(raw);
      }
    } catch (_) {
      s = '';
    }
    s = s.replace(/\0/g, '').trim();
    const t = field.type;
    if (t === 'N' || t === 'F') {
      if (s === '') return null;
      const n = parseFloat(s);
      return isNaN(n) ? s : n;
    }
    if (t === 'L') {
      if (/^[YyTt]$/.test(s)) return true;
      if (/^[NnFf]$/.test(s)) return false;
      return null;
    }
    if (t === 'D') {
      // YYYYMMDD
      if (/^\d{8}$/.test(s)) {
        return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
      }
      return s;
    }
    return s;
  }

  /* ================================================================== *
   * GeoJSON
   * ================================================================== */

  function parseGeoJson(text) {
    const obj = JSON.parse(text);
    const features = [];
    const warnings = [];

    const pushGeom = (geom, props) => {
      if (!geom) return;
      switch (geom.type) {
        case 'Point':
          features.push({ type: 'point', coords: geom.coordinates, properties: props || {} });
          break;
        case 'MultiPoint':
          features.push({ type: 'multipoint', coords: geom.coordinates, properties: props || {} });
          break;
        case 'LineString':
          features.push({ type: 'line', coords: geom.coordinates, properties: props || {} });
          break;
        case 'MultiLineString':
          features.push({ type: 'multiline', coords: geom.coordinates, properties: props || {} });
          break;
        case 'Polygon':
          features.push({ type: 'polygon', rings: geom.coordinates, properties: props || {} });
          break;
        case 'MultiPolygon':
          features.push({ type: 'multipolygon', rings: geom.coordinates, properties: props || {} });
          break;
        case 'GeometryCollection':
          for (const g of geom.geometries || []) pushGeom(g, props || {});
          break;
        default:
          if (geom.type) warnings.push('未知的几何类型：' + geom.type);
      }
    };

    if (obj.type === 'FeatureCollection') {
      for (const f of obj.features || []) pushGeom(f.geometry, f.properties || {});
    } else if (obj.type === 'Feature') {
      pushGeom(obj.geometry, obj.properties || {});
    } else {
      // 裸的几何
      pushGeom(obj, {});
    }

    // GeoJSON 里可能带 crs（非标准但 QGIS 会写）
    let crs = null;
    if (obj.crs) {
      const name = obj.crs.properties && obj.crs.properties.name;
      if (name) crs = String(name);
    }
    return { features: features, crs: crs, warnings: warnings };
  }

  /* ================================================================== *
   * CSV / TSV
   * ================================================================== */

  /** 解析带引号的 CSV 行。 */
  function parseCsvRows(text, delim) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === delim) { row.push(field); field = ''; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      if (ch === '\r') continue;
      field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  }

  const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x', '经度'];
  const LAT_NAMES = ['lat', 'latitude', 'y', '纬度'];
  const WKT_NAMES = ['wkt', 'geometry', 'geom', 'shape', '几何'];

  function parseCsv(text) {
    const warnings = [];
    // 猜分隔符
    const firstLine = (text.split(/\r?\n/)[0] || '');
    let delim = ',';
    if ((firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length) delim = '\t';
    else if ((firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length) delim = ';';

    const rows = parseCsvRows(text, delim);
    if (!rows.length) throw new Error('CSV 为空');
    const header = rows[0].map((h) => h.trim());
    const lower = header.map((h) => h.toLowerCase());

    let lonIdx = -1, latIdx = -1, wktIdx = -1;
    lower.forEach((h, i) => {
      if (lonIdx < 0 && LON_NAMES.indexOf(h) >= 0) lonIdx = i;
      if (latIdx < 0 && LAT_NAMES.indexOf(h) >= 0) latIdx = i;
      if (wktIdx < 0 && WKT_NAMES.indexOf(h) >= 0) wktIdx = i;
    });

    const features = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const props = {};
      header.forEach((h, i) => {
        if (i === lonIdx || i === latIdx || i === wktIdx) return;
        props[h] = row[i] === undefined ? null : row[i];
      });
      if (wktIdx >= 0) {
        const g = parseWktText(row[wktIdx]);
        if (g) {
          g.properties = props;
          features.push(g);
          continue;
        }
        warnings.push('第 ' + (r + 1) + ' 行的 WKT 无法解析');
        continue;
      }
      if (lonIdx >= 0 && latIdx >= 0) {
        const lon = parseFloat(row[lonIdx]);
        const lat = parseFloat(row[latIdx]);
        if (isFinite(lon) && isFinite(lat)) {
          features.push({ type: 'point', coords: [lon, lat], properties: props });
        } else {
          warnings.push('第 ' + (r + 1) + ' 行的经纬度不是数字');
        }
      }
    }

    if (!features.length && !lonIdx && !latIdx && !wktIdx) {
      throw new Error('CSV 里找不到经纬度列（lon/lat）或 WKT 列');
    }
    return { features: features, crs: null, warnings: warnings };
  }

  /* ================================================================== *
   * WKT
   * ================================================================== */

  /** 解析单个 WKT 几何 → {type, coords|rings} */
  function parseWktText(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const typeMatch = /^\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON)\s*\(/i.exec(s);
    if (!typeMatch) return null;
    const type = typeMatch[1].toUpperCase();
    const open = s.indexOf('(');
    const close = s.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const body = s.slice(open + 1, close);

    const parseNumList = (str) => {
      const out = [];
      const re = /(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;
      let m;
      while ((m = re.exec(str)) !== null) {
        out.push([parseFloat(m[1]), parseFloat(m[2])]);
      }
      return out;
    };
    const parseGroups = (str) => {
      const groups = [];
      let depth = 0;
      let start = -1;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '(') {
          if (depth === 0) start = i + 1;
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth === 0 && start >= 0) {
            groups.push(str.slice(start, i));
            start = -1;
          }
        }
      }
      return groups;
    };

    if (type === 'POINT') {
      const pts = parseNumList(body);
      if (!pts.length) return null;
      return { type: 'point', coords: pts[0] };
    }
    if (type === 'MULTIPOINT') {
      const groups = parseGroups(body);
      let pts;
      if (groups.length) pts = groups.map(parseNumList).filter((a) => a.length).map((a) => a[0]);
      else pts = parseNumList(body);
      return { type: 'multipoint', coords: pts };
    }
    if (type === 'LINESTRING') {
      const pts = parseNumList(body);
      if (pts.length < 2) return null;
      return { type: 'line', coords: pts };
    }
    if (type === 'MULTILINESTRING') {
      const lines = parseGroups(body).map(parseNumList).filter((a) => a.length >= 2);
      if (!lines.length) return null;
      return { type: 'multiline', coords: lines };
    }
    if (type === 'POLYGON') {
      const rings = parseGroups(body).map(parseNumList).filter((a) => a.length >= 3);
      if (!rings.length) return null;
      return { type: 'polygon', rings: rings };
    }
    if (type === 'MULTIPOLYGON') {
      const polys = parseGroups(body).map((g) => parseGroups(g).map(parseNumList).filter((a) => a.length >= 3)).filter((a) => a.length);
      if (!polys.length) return null;
      return { type: 'multipolygon', rings: polys };
    }
    return null;
  }

  /* ================================================================== *
   * GML
   * ================================================================== */

  /** 这些要素的坐标是不是明显不是经纬度（超出经纬度范围）？ */
  function coordinatesOutOfRange(features) {
    for (const f of features || []) {
      const pts = [];
      if (f.type === 'point' && f.coords) pts.push(f.coords);
      else if (f.coords && f.coords.length && Array.isArray(f.coords[0])) pts.push(...f.coords);
      if (f.rings) for (const ring of f.rings) pts.push(...ring);
      for (const p of pts) {
        if (!p || p.length < 2) continue;
        if (!isFinite(p[0]) || !isFinite(p[1])) continue;
        if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return true;
      }
    }
    return false;
  }

  /**
   * 把 srsName 归一成能识别的形式。
   *   "urn:ogc:def:crs:EPSG::4548" → "EPSG:4548"
   *   "http://www.opengis.net/def/crs/EPSG/0/4548" → "EPSG:4548"
   *   "EPSG:4548" → "EPSG:4548"
   */
  function normalizeSrsName(s) {
    const raw = String(s || '').trim();
    if (!raw) return null;
    let m = /^(?:urn:ogc:def:crs:)?epsg:[:/]?(\d+)$/i.exec(raw);
    if (m) return 'EPSG:' + m[1];
    m = /opengis\.net\/def\/crs\/epsg\/[^/]*\/(\d+)/i.exec(raw);
    if (m) return 'EPSG:' + m[1];
    m = /epsg[:/](\d+)/i.exec(raw);
    if (m) return 'EPSG:' + m[1];
    // http://www.opengis.net/gml/srs/epsg.xml#4548
    m = /epsg\.xml#(\d+)/i.exec(raw);
    if (m) return 'EPSG:' + m[1];
    return raw;
  }

  function parseGml(text) {
    const warnings = [];
    const features = [];
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('GML 不是合法的 XML');
    }

    // GML 2 的坐标对：<gml:pos>lon lat</gml:pos> 或 <coordinates>x,y x,y</coordinates>
    // GML 3 的 srsName 属性带坐标系
    const srsMatch = /srsName\s*=\s*"([^"]+)"/i.exec(text);
    const crs = srsMatch ? normalizeSrsName(srsMatch[1]) : null;

    const posList = (el) => {
      const pts = [];
      for (const pos of el.getElementsByTagName('*')) {
        const ln = pos.localName.toLowerCase();
        if (ln === 'pos' || ln === 'poslist' || ln === 'coordinates') {
          const raw = (pos.textContent || '').trim();
          if (!raw) continue;
          const sep = ln === 'poslist' ? /\s+/ : (raw.indexOf(',') >= 0 ? /[\s,]+/ : /\s+/);
          const toks = raw.split(sep).filter(Boolean).map(parseFloat);
          for (let i = 0; i + 1 < toks.length; i += 2) {
            if (isFinite(toks[i]) && isFinite(toks[i + 1])) pts.push([toks[i], toks[i + 1]]);
          }
          if (pts.length) break;
        }
      }
      return pts;
    };

    const collect = (el) => {
      const ln = el.localName.toLowerCase();
      if (ln === 'polygon' || ln === 'surface' || ln === 'polygonsurface') {
        const outer = el.getElementsByTagName('*');
        let rings = [];
        for (const child of outer) {
          const cl = child.localName.toLowerCase();
          if (cl === 'exterior' || cl === 'outerboundaryis' || cl === 'outerboundary') {
            const pts = posList(child);
            if (pts.length >= 3) rings.push(pts);
          }
        }
        if (!rings.length) {
          const pts = posList(el);
          if (pts.length >= 3) rings.push(pts);
        }
        if (rings.length) return { type: 'polygon', rings: rings };
        return null;
      }
      if (ln === 'linestring' || ln === 'curve' || ln === 'linearring') {
        const pts = posList(el);
        if (pts.length >= 2) return { type: 'line', coords: pts };
        return null;
      }
      if (ln === 'point') {
        const pts = posList(el);
        if (pts.length) return { type: 'point', coords: pts[0] };
        return null;
      }
      if (ln === 'multipoint' || ln === 'multilinestring' || ln === 'multipolygon') {
        const sub = [];
        for (const child of el.children) {
          const g = collect(child);
          if (g) sub.push(g);
        }
        if (!sub.length) return null;
        if (ln === 'multipoint') return { type: 'multipoint', coords: sub.map((g) => g.coords) };
        if (ln === 'multilinestring') return { type: 'multiline', coords: sub.map((g) => g.coords) };
        return { type: 'multipolygon', rings: sub.map((g) => g.rings) };
      }
      // 容器元素（featureMember > sf:City > gml:Point）：往下找一层几何
      for (const child of el.children) {
        const g = collect(child);
        if (g) return g;
      }
      return null;
    };

    // 找每个 featureMember
    const members = [];
    for (const el of doc.getElementsByTagName('*')) {
      const ln = el.localName.toLowerCase();
      if (ln === 'featuremember' || ln === 'featuremembers' || ln === 'member') members.push(el);
    }

    if (members.length) {
      for (const m of members) {
        let geom = null;
        for (const child of m.children) {
          geom = collect(child) || geom;
        }
        if (!geom) {
          // 单层结构
          geom = collect(m);
        }
        if (!geom) continue;
        // 属性：feature 下非几何的子元素
        const props = {};
        for (const child of m.children) {
          const cl = child.localName.toLowerCase();
          if (cl === 'geometry' || cl === 'shape' || cl === 'boundedby') continue;
          const g = collect(child);
          if (!g) props[child.localName] = (child.textContent || '').trim();
        }
        geom.properties = props;
        features.push(geom);
      }
    } else {
      const g = collect(doc.documentElement);
      if (g) {
        g.properties = {};
        features.push(g);
      }
    }

    if (!features.length) warnings.push('GML 里没有找到可用的几何');

    // GML 3.2 遵循 EPSG 权威轴顺序。中国的带状坐标 EPSG:4548 是
    // **northing, easting（北在前）**，而 Shapefile / GPKG 里的几何是
    // x=东、y=北。这里统一成 x=东、y=北，省得后面重投影时颠倒。
    if (crs) {
      const code = /EPSG:(\d+)/i.exec(crs);
      const ax = code && window.LEProj ? window.LEProj.axisOrderOf(crs) : null;
      if (ax === 'ne') {
        for (const f of features) swapXY(f);
        warnings.push('GML 坐标按 EPSG 权威轴序（北在前）读取，已交换为东/北');
      }
    }
    return { features: features, crs: crs, warnings: warnings };
  }

  /** 把一个要素的所有坐标的 x/y 交换。 */
  function swapXY(f) {
    if (!f) return;
    if (f.coords && f.coords.length && Array.isArray(f.coords[0])) {
      for (const p of f.coords) { const t = p[0]; p[0] = p[1]; p[1] = t; }
    } else if (f.coords && f.coords.length >= 2) {
      const t = f.coords[0]; f.coords[0] = f.coords[1]; f.coords[1] = t;
    }
    if (f.rings) {
      for (const ring of f.rings) {
        for (const p of ring) { const t = p[0]; p[0] = p[1]; p[1] = t; }
      }
    }
  }

  /* ================================================================== *
   * GPX
   * ================================================================== */

  function parseGpx(text) {
    const warnings = [];
    const features = [];
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('GPX 不是合法的 XML');
    }
    const attrsOf = (el) => {
      const props = {};
      for (const a of el.attributes) props[a.name] = a.value;
      return props;
    };
    const textOf = (el, tag) => {
      const c = el.getElementsByTagName(tag);
      return c.length ? (c[0].textContent || '').trim() : '';
    };

    for (const el of doc.getElementsByTagName('*')) {
      const ln = el.localName.toLowerCase();
      if (ln === 'trkseg') {
        const pts = [];
        for (const p of el.children) {
          if (p.localName.toLowerCase() !== 'trkpt') continue;
          pts.push([parseFloat(p.getAttribute('lon')), parseFloat(p.getAttribute('lat'))]);
        }
        if (pts.length >= 2) {
          features.push({ type: 'line', coords: pts, properties: {} });
        }
      } else if (ln === 'rte') {
        const pts = [];
        for (const p of el.children) {
          if (p.localName.toLowerCase() !== 'rtept') continue;
          pts.push([parseFloat(p.getAttribute('lon')), parseFloat(p.getAttribute('lat'))]);
        }
        if (pts.length >= 2) {
          features.push({ type: 'line', coords: pts, properties: {} });
        }
      } else if (ln === 'wpt') {
        const lon = parseFloat(el.getAttribute('lon'));
        const lat = parseFloat(el.getAttribute('lat'));
        if (isFinite(lon) && isFinite(lat)) {
          const props = attrsOf(el);
          const name = textOf(el, 'name');
          if (name) props.name = name;
          const desc = textOf(el, 'desc');
          if (desc) props.desc = desc;
          const ele = textOf(el, 'ele');
          if (ele) props.ele = parseFloat(ele) || ele;
          features.push({ type: 'point', coords: [lon, lat], properties: props });
        }
      }
    }
    if (!features.length) warnings.push('GPX 里没有找到航点/轨迹/路线');

    // GPX 规范里坐标一律是 WGS84 经纬度，但国内很多 GIS 软件导出的 GPX
    // 其实是投影坐标（米）。这里检查一下，越界就如实告知，
    // 而不是默默把 447922 当成经度画到几内亚湾。
    let maxAbsLon = 0;
    let maxAbsLat = 0;
    for (const f of features) {
      const pts = f.type === 'point' ? [f.coords] : (f.coords || []);
      for (const p of pts) {
        if (!p) continue;
        if (Math.abs(p[0]) > maxAbsLon) maxAbsLon = Math.abs(p[0]);
        if (Math.abs(p[1]) > maxAbsLat) maxAbsLat = Math.abs(p[1]);
      }
    }
    if (maxAbsLon > 180 || maxAbsLat > 90) {
      warnings.push(
        'GPX 里的坐标超出经纬度范围（最大 ' +
        maxAbsLon.toFixed(0) + ', ' + maxAbsLat.toFixed(0) +
        '），文件里存的可能是投影坐标（如 CGCS2000 高斯-克吕格）。' +
        '如有配套 .prj 文件请一起导入，否则位置会有偏差'
      );
    }
    return { features: features, crs: 'EPSG:4326', warnings: warnings };
  }

  /* ================================================================== *
   * DXF（ASCII）
   * ================================================================== */

  function parseDxf(text) {
    const warnings = [];
    const features = [];
    const lines = text.split(/\r?\n/);
    // DXF 是「组码 / 值」成对
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      const value = lines[i + 1];
      if (isFinite(code)) pairs.push([code, value]);
    }

    let cur = null;
    let layer = '';
    // LWPOLYLINE / POLYLINE 的顶点会挂在实体上，VERTEX 是子实体
    let polyOwner = null;

    const flush = () => {
      if (cur && cur.type) {
        cur.properties = Object.assign({ layer: layer }, cur.properties || {});
        features.push(cur);
      }
      cur = null;
      polyOwner = null;
    };

    const MAKERS = {
      POINT: () => ({ type: 'point', coords: null, properties: {} }),
      LINE: () => ({ type: 'line', coords: [], properties: {} }),
      LWPOLYLINE: () => ({ type: 'line', coords: [], properties: {} }),
      POLYLINE: () => ({ type: 'line', coords: [], properties: {} }),
      VERTEX: () => ({ type: 'point', coords: null, properties: {} }),
      CIRCLE: () => ({ type: 'circle', coords: null, properties: {} }),
      ARC: () => ({ type: 'arc', coords: null, properties: {} }),
      TEXT: () => ({ type: 'text', coords: null, properties: {} }),
      MTEXT: () => ({ type: 'text', coords: null, properties: {} }),
      SOLID: () => ({ type: 'polygon', rings: [], properties: {} }),
      HATCH: () => ({ type: 'polygon', rings: [], properties: {} }),
    };
    const newEntity = (kind) => MAKERS[kind];

    for (let i = 0; i < pairs.length; i++) {
      const code = pairs[i][0];
      const value = pairs[i][1];

      if (code === 0) {
        const ent = String(value).trim().toUpperCase();
        if (ent === 'SECTION') {
          const nxt = pairs[i + 1] && pairs[i + 1][0] === 2 ? String(pairs[i + 1][1]).trim().toUpperCase() : '';
          if (nxt === 'ENTITIES') { i++; continue; }
          i++;
          continue;
        }
        if (ent === 'ENDSEC') { flush(); continue; }
        if (ent === 'EOF') { flush(); break; }
        if (ent === 'SEQEND') { polyOwner = null; continue; }

        const maker = newEntity(ent);
        if (!maker) continue;
        // VERTEX 属于当前的 POLYLINE
        if (ent === 'VERTEX' && polyOwner) {
          cur = maker();
          cur.isVertex = true;
        } else {
          flush();
          cur = maker();
          if (ent === 'POLYLINE' || ent === 'LWPOLYLINE') polyOwner = cur;
        }
        continue;
      }

      if (!cur) continue;

      switch (code) {
        case 8: layer = String(value).trim(); break;
        case 10: {
          const x = parseFloat(value);
          if (cur.type === 'point') cur.coords = [x, cur.coords ? cur.coords[1] : 0];
          else if (cur.type === 'circle' || cur.type === 'arc') { cur.cx = x; }
          else if (cur.type === 'text') { cur.tx = x; }
          else if (cur.type === 'line') { cur.x1 = x; cur.coords = [[x, null]]; }
          else if (cur.type === 'polygon') { cur.coords = cur.coords || []; cur.coords.push([x, null]); }
          break;
        }
        case 20: {
          const y = parseFloat(value);
          if (cur.type === 'point') cur.coords = [cur.coords ? cur.coords[0] : 0, y];
          else if (cur.type === 'circle' || cur.type === 'arc') { cur.cy = y; }
          else if (cur.type === 'text') { cur.ty = y; }
          else if (cur.type === 'line') {
            if (!cur.coords || !cur.coords.length) cur.coords = [[cur.x1 || 0, null]];
            cur.coords[cur.coords.length - 1][1] = y;
            // LINE 的起点 y 在组码 20；终点 y 在 21
            if (cur.coords.length === 1 && cur.x2 == null) cur.y1 = y;
          } else if (cur.type === 'polygon') {
            if (cur.coords && cur.coords.length) cur.coords[cur.coords.length - 1][1] = y;
          }
          break;
        }
        // LINE 的第二个端点在 11/21，不在 10/20
        case 11: cur.x2 = parseFloat(value); break;
        case 21: cur.y2 = parseFloat(value); break;
        case 30: case 31: case 32: case 33: break;   // Z 值：忽略
        case 40: cur.r = parseFloat(value); break;
        case 50: cur.startAngle = parseFloat(value); break;
        case 51: cur.endAngle = parseFloat(value); break;
        case 1: cur.properties.text = String(value).trim(); break;
        case 70: cur.flag = parseInt(value, 10); break;
        default: break;
      }

      // VERTEX 收尾：并入所属多段线
      if (cur && cur.isVertex && cur.coords && isFinite(cur.coords[0]) && isFinite(cur.coords[1])) {
        if (polyOwner) polyOwner.coords.push([cur.coords[0], cur.coords[1]]);
        cur = null;
      }
    }
    flush();

    // LINE：10/20 + 11/21 两个端点
    for (const f of features) {
      if (f.type === 'line') {
        if (!f.coords.length && isFinite(f.x1) && isFinite(f.y1) && isFinite(f.x2) && isFinite(f.y2)) {
          f.coords = [[f.x1, f.y1], [f.x2, f.y2]];
        } else if (f.coords.length === 1 && isFinite(f.x2) && isFinite(f.y2)) {
          // 起点在 10/20，终点在 11/21
          f.coords.push([f.x2, f.y2]);
        }
      }
    }
    // 修正多段线的点对
    for (const f of features) {
      if (f.type === 'line' && Array.isArray(f.coords)) {
        f.coords = f.coords.filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
        if (f.coords.length < 2) f.type = 'point';
      }
    }
    // 圆 / 圆弧 → 折线
    for (const f of features) {
      if ((f.type === 'circle' || f.type === 'arc') && isFinite(f.cx) && isFinite(f.cy) && isFinite(f.r)) {
        const ring = [];
        const n = 64;
        let a0 = f.type === 'arc' ? ((f.startAngle || 0) * Math.PI) / 180 : 0;
        let a1 = f.type === 'arc' ? ((f.endAngle == null ? 360 : f.endAngle) * Math.PI) / 180 : Math.PI * 2;
        if (a1 <= a0) a1 += Math.PI * 2;
        for (let k = 0; k <= n; k++) {
          const a = a0 + ((a1 - a0) * k) / n;
          ring.push([f.cx + f.r * Math.cos(a), f.cy + f.r * Math.sin(a)]);
        }
        f.type = f.type === 'circle' ? 'polygon' : 'line';
        if (f.type === 'polygon') f.rings = [ring];
        else f.coords = ring;
        delete f.cx; delete f.cy; delete f.r;
      }
    }
    // 文本 → 点
    for (const f of features) {
      if (f.type === 'text') {
        if (isFinite(f.tx) && isFinite(f.ty)) {
          f.type = 'point';
          f.coords = [f.tx, f.ty];
        } else f.type = 'skip';
      }
    }
    const kept = features.filter((f) => f.type !== 'skip');
    if (!kept.length) warnings.push('DXF 里没有找到可用的实体');
    return { features: kept, crs: null, warnings: warnings };
  }

  /* ================================================================== *
   * ASCII Grid（.asc / .txt）
   * ================================================================== */

  function parseAsciiGrid(text) {
    const lines = text.split(/\r?\n/);
    const head = {};
    let i = 0;
    // 头部是「键 值」对；遇到第一个不是「非数字键」的行就是数据开始
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) break;
      const key = parts[0].toUpperCase();
      const val = parseFloat(parts[1]);
      if (!isFinite(val)) break;
      // 数据行：首段是数字（且不是已知头键）→ 说明数据开始了
      if (/^-?\d/.test(key) && !/^(NCOLS|NROWS|XLL|YLL|CELLSIZE|NODATA)/.test(key)) break;
      head[key] = val;
    }
    const ncols = head.NCOLS;
    const nrows = head.NROWS;
    if (!isFinite(ncols) || !isFinite(nrows)) {
      throw new Error('ASCII Grid 缺少 ncols / nrows 头');
    }
    const values = [];
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const toks = line.split(/\s+/);
      for (const t of toks) {
        const v = parseFloat(t);
        if (isFinite(v)) values.push(v);
      }
    }
    return {
      header: head,
      ncols: ncols,
      nrows: nrows,
      values: values,
      xllcorner: head.XLLCORNER,
      yllcorner: head.YLLCORNER,
      cellsize: head.CELLSIZE,
      nodata: head.NODATA,
    };
  }

  /* ================================================================== *
   * GPKG（需要 sql.js）
   * ================================================================== */

  async function loadSqlJs() {
    if (window.initSqlJs) {
      return window.initSqlJs({
        locateFile: (file) => 'vendor/sqljs/' + file,
      });
    }
    throw new Error('SQLite 引擎未加载（vendor/sqljs/sql-wasm.js）');
  }

  /**
   * 解析 GPKG：读 gpkg_contents → gpkg_spatial_ref_sys → 每要素表的 gpkg_geometry_columns。
   */
  async function parseGpkg(bytes) {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(new Uint8Array(bytes));
    const features = [];
    const warnings = [];
    let crs = null;

    const q = (sql, params) => {
      const stmt = db.prepare(sql);
      if (params) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    };

    try {
      // 每个要素表
      const tables = q(
        "SELECT table_name, data_type, srs_id FROM gpkg_contents WHERE data_type='features'"
      );
      if (!tables.length) {
        warnings.push('GPKG 里没有要素表');
        return { features: features, crs: crs, warnings: warnings, tables: [] };
      }

      const gpkgContent = q(
        'SELECT table_name, column_name, geometry_type_name, srs_id, z, m ' +
        'FROM gpkg_geometry_columns'
      );
      const srsRows = q('SELECT srs_id, organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys');
      const srsById = {};
      for (const s of srsRows) srsById[s.srs_id] = s;

      for (const t of tables) {
        const meta = gpkgContent.find((g) => g.table_name === t.table_name) || {};
        const geomCol = meta.column_name || 'geom';
        const geomType = meta.geometry_type_name || 'GEOMETRY';
        const srsId = meta.srs_id != null ? meta.srs_id : t.srs_id;

        const srs = srsById[srsId];
        if (srs) {
          if (srs.definition && srs.definition.indexOf('undefined') < 0) {
            crs = srs.definition;
          } else if (srs.organization === 'EPSG') {
            crs = 'EPSG:' + srs.organization_coordsys_id;
          }
        }

        // 注意：GPKG 里只有 TEXT / MULTITEXT 这类才是 WKT 文本编码。
        // 早先这里把 MULTILINESTRING / MULTIPOLYGON 也算成文本，
        // 导致二进制 WKB 的多部件面被当成 WKT 去解析（多部件只剩一个）。
        const gt = String(geomType).toUpperCase();
        const isText = gt === 'TEXT' || gt === 'MULTITEXT';
        const rows = q(
          'SELECT rowid AS _rid, * FROM "' + t.table_name.replace(/"/g, '""') + '"'
        );
        for (const row of rows) {
          const blob = row[geomCol];
          if (!blob) continue;
          const props = {};
          for (const k of Object.keys(row)) {
            if (k === geomCol || k === '_rid') continue;
            props[k] = row[k];
          }
          let geom;
          try {
            const bytes2 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
            geom = decodeGpkgGeometry(bytes2, isText);
          } catch (err) {
            warnings.push('要素 ' + row._rid + ' 几何解析失败：' + err.message);
            continue;
          }
          if (!geom) continue;
          geom.properties = props;
          features.push(geom);
        }
      }
    } finally {
      db.close();
    }

    return { features: features, crs: crs, warnings: warnings };
  }

  /** 解 GPKG 的 GP 几何二进制头。 */
  function decodeGpkgGeometry(bytes, isText) {
    if (!bytes || bytes.length < 8) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(bytes[0], bytes[1]);
    if (magic !== 'GP') return null;
    const version = bytes[2];
    const flags = bytes[3];
    // GPKG 二进制头：magic(2) + version(1) + flags(1) + srs_id(4) = 8 字节，
    // 之后是可选的 envelope，然后才是 WKB。
    // 注意 srs_id 已经在头里，**不能再往前跳 4 字节**（跳了就跳过 WKB 的头）。
    const envelopeIndicator = (flags >> 1) & 0x07;
    const envLen = [0, 32, 48, 48, 64, 0, 0, 0][envelopeIndicator] || 0;
    let off = 8 + envLen;

    if (isText) {
      // WKT 几何
      const wkt = new TextDecoder('utf-8').decode(bytes.slice(off));
      return parseWktText(wkt);
    }

    const readGeom = () => {
      const bo = dv.getUint8(off);
      off += 1;
      const le = bo === 1;           // WKB：1 = 小端
      const type = dv.getUint32(off, le);
      off += 4;
      const base = type % 1000;
      const hasZ = ((type / 1000) | 0) & 1;
      const hasM = ((type / 1000) | 0) & 2;

      const readPoints = (n) => {
        const pts = [];
        for (let i = 0; i < n; i++) {
          if (off + 16 > bytes.length) break;
          const x = dv.getFloat64(off, le); off += 8;
          const y = dv.getFloat64(off, le); off += 8;
          let z = 0;
          if (hasZ) { if (off + 8 > bytes.length) break; z = dv.getFloat64(off, le); off += 8; }
          if (hasM) off += 8;
          pts.push(z !== 0 ? [x, y, z] : [x, y]);
        }
        return pts;
      };

      if (base === 1) {
        const p = readPoints(1);
        return p.length ? { type: 'point', coords: p[0] } : null;
      }
      if (base === 2) {
        if (off + 4 > bytes.length) return null;
        const n = dv.getUint32(off, le); off += 4;
        const pts = readPoints(n);
        return pts.length >= 2 ? { type: 'line', coords: pts } : null;
      }
      if (base === 3) {
        if (off + 4 > bytes.length) return null;
        const nr = dv.getUint32(off, le); off += 4;
        const rings = [];
        for (let r = 0; r < nr; r++) {
          if (off + 4 > bytes.length) break;
          const n = dv.getUint32(off, le); off += 4;
          const ring = readPoints(n);
          if (ring.length >= 3) rings.push(ring);
        }
        return rings.length ? { type: 'polygon', rings: rings } : null;
      }
      if (base === 4) {
        if (off + 4 > bytes.length) return null;
        const n = dv.getUint32(off, le); off += 4;
        const pts = [];
        for (let i = 0; i < n; i++) {
          // MultiPoint 的每个成员也是完整的 Point WKB（5 字节头）
          const sub = readGeom();
          if (sub && sub.type === 'point') pts.push(sub.coords);
        }
        return pts.length ? { type: 'multipoint', coords: pts } : null;
      }
      if (base === 5) {
        if (off + 4 > bytes.length) return null;
        const n = dv.getUint32(off, le); off += 4;
        const lines = [];
        for (let i = 0; i < n; i++) {
          // MultiLineString 的每个成员都是**完整的 WKB**（自带 5 字节头），
          // 不是裸的坐标数组 —— 少了这个头，后面全错位。
          const sub = readGeom();
          if (sub && sub.type === 'line') lines.push(sub.coords);
        }
        return lines.length ? { type: 'multiline', coords: lines } : null;
      }
      if (base === 6) {
        if (off + 4 > bytes.length) return null;
        const n = dv.getUint32(off, le); off += 4;
        const polys = [];
        for (let i = 0; i < n; i++) {
          // 同上：每个成员都是完整的 Polygon WKB
          const sub = readGeom();
          if (sub && sub.type === 'polygon') polys.push(sub.rings);
        }
        return polys.length ? { type: 'multipolygon', rings: polys } : null;
      }
      if (base === 7) {
        if (off + 4 > bytes.length) return null;
        const n = dv.getUint32(off, le); off += 4;
        const geoms = [];
        for (let i = 0; i < n; i++) {
          const sub = readGeom();
          if (sub) geoms.push(sub);
        }
        return geoms.length ? { type: 'geometrycollection', geoms: geoms } : null;
      }
      return null;
    };

    return readGeom();
  }

  /* ================================================================== *
   * 统一入口
   * ================================================================== */

  /**
   * 解析一个文件。
   * @param {string} name 文件名
   * @param {Uint8Array|ArrayBuffer|Blob} input 内容
   * @param {object} opts { dbf: Uint8Array, prj: string, kind: string }
   * @returns {Promise<object>} 统一结构
   */
  async function parse(name, input, opts) {
    opts = opts || {};
    let bytes = bytesOf(input);
    if (!bytes && typeof Blob !== 'undefined' && input instanceof Blob) {
      bytes = new Uint8Array(await input.arrayBuffer());
    }
    if (!bytes) throw new Error('无法读取文件内容');

    let kind = opts.kind || detect(name, bytes);

    // Shapefile 需要配套的 .dbf / .prj
    if (kind === 'shapefile') {
      const shp = parseShp(bytes);
      let dbf = { fields: [], rows: [] };
      if (opts.dbf) {
        try {
          // .dbf 可能是 File/Blob（异步）或已经是字节
          const dbfBytes = await toBytes(opts.dbf);
          if (!dbfBytes) throw new Error('无法读取 .dbf 内容');
          dbf = parseDbf(dbfBytes, opts.cpg);
        } catch (err) {
          return fail(['属性表读取失败：' + err.message], kind);
        }
      }
      const crs = opts.prj ? String(opts.prj).trim() : null;
      const features = [];
      for (let i = 0; i < shp.features.length; i++) {
        const g = shp.features[i];
        const props = dbf.rows[i] || {};
        if (g.type === 'polygon') features.push({ type: 'polygon', rings: g.rings, properties: props });
        else if (g.type === 'line') features.push({ type: 'line', coords: g.coords, properties: props });
        else if (g.type === 'point') features.push({ type: 'point', coords: g.coords, properties: props });
        else if (g.type === 'multipoint') features.push({ type: 'multipoint', coords: g.coords, properties: props });
      }
      const warnings = [];
      if (!opts.dbf) warnings.push('没有找到配套的 .dbf，属性为空');
      if (!opts.prj) warnings.push('没有找到配套的 .prj，按经纬度处理');
      return {
        features: features,
        crs: crs,
        fields: dbf.fields,
        warnings: warnings,
        kind: kind,
        bbox: shp.bbox,
        shapeType: shp.shapeType,
      };
    }

    if (kind === 'dbf') {
      const dbf = parseDbf(bytes);
      return { features: [], crs: null, fields: dbf.fields, rows: dbf.rows, warnings: [], kind: kind };
    }

    if (kind === 'prj') {
      return { features: [], crs: decodeText(bytes).trim(), fields: [], warnings: [], kind: kind };
    }

    if (kind === 'gpkg') {
      const r = await parseGpkg(bytes);
      r.kind = kind;
      r.fields = fieldsOf(r.features);
      return r;
    }

    if (kind === 'geojson') {
      const r = parseGeoJson(decodeText(bytes));
      r.kind = kind;
      r.fields = fieldsOf(r.features);
      return r;
    }

    if (kind === 'flatgeobuf') {
      if (!window.LEFlatGeobuf || typeof window.LEFlatGeobuf.parse !== 'function') {
        throw new Error('FlatGeobuf 解析器未加载（js/flatgeobuf.js）');
      }
      const r = window.LEFlatGeobuf.parse(bytes);
      r.kind = kind;
      if (!r.fields || !r.fields.length) r.fields = fieldsOf(r.features);
      return r;
    }

    if (kind === 'csv') {
      const r = parseCsv(decodeText(bytes));
      r.kind = kind;
      r.fields = fieldsOf(r.features);
      return r;
    }

    if (kind === 'gml') {
      const r = parseGml(decodeText(bytes));
      r.kind = kind;
      r.fields = fieldsOf(r.features);
      return r;
    }

    if (kind === 'gpx') {
      const r = parseGpx(decodeText(bytes));
      r.kind = kind;
      r.fields = fieldsOf(r.features);
      // GPX 规范里坐标是 WGS84，但国内软件导出的常是投影坐标。
      // 有配套 .prj 且坐标明显超出经纬度范围时，以 .prj 为准。
      if (opts.prj && coordinatesOutOfRange(r.features)) {
        r.crs = String(opts.prj).trim();
        r.warnings = (r.warnings || []).concat(
          ['GPX 坐标超出经纬度范围，已按配套的 .prj 文件重投影']
        );
      }
      return r;
    }

    if (kind === 'dxf') {
      const r = parseDxf(decodeText(bytes));
      r.kind = kind;
      r.fields = fieldsOf(r.features);
      // DXF 本身不带坐标系，旁边的 .prj 说了算
      if (opts.prj) {
        r.crs = String(opts.prj).trim();
        r.warnings = (r.warnings || []).concat(['坐标系取自配套的 .prj 文件']);
      }
      return r;
    }

    if (kind === 'wkt') {
      const g = parseWktText(decodeText(bytes));
      if (!g) throw new Error('WKT 格式无法识别');
      g.properties = {};
      return { features: [g], crs: null, fields: [], warnings: [], kind: kind };
    }

    if (kind === 'ascii-grid') {
      const g = parseAsciiGrid(decodeText(bytes));
      return { features: [], grid: g, crs: null, fields: [], warnings: [], kind: kind };
    }

    throw new Error('不支持的文件格式：' + kind);
  }

  function fail(warnings, kind) {
    return { features: [], crs: null, fields: [], warnings: warnings, kind: kind };
  }

  /** 从要素里收集字段名（保持出现顺序）。 */
  function fieldsOf(features) {
    const seen = [];
    const set = {};
    for (const f of features) {
      const p = f.properties || {};
      for (const k of Object.keys(p)) {
        if (!set[k]) { set[k] = 1; seen.push(k); }
      }
    }
    return seen.map((name) => ({ name: name, type: 'string' }));
  }

  window.LEFormats = {
    detect: detect,
    parse: parse,
    // 单独导出便于测试
    parseShp: parseShp,
    parseDbf: parseDbf,
    parseGeoJson: parseGeoJson,
    parseCsv: parseCsv,
    parseWktText: parseWktText,
    parseGml: parseGml,
    parseGpx: parseGpx,
    parseDxf: parseDxf,
    parseAsciiGrid: parseAsciiGrid,
    decodeGpkgGeometry: decodeGpkgGeometry,
    decodeText: decodeText,
    fieldsOf: fieldsOf,
  };
})();

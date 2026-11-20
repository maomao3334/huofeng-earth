/*
 * FlatGeobuf 解析器（js/flatgeobuf.js）
 *
 * FlatGeobuf 是 OGC 正在标准化的「高性能矢量格式」：比 GeoJSON 小一个数量级，
 * 且带 R-tree 空间索引，可以只读窗口内的要素。QGIS 3.34+ / GDAL 3.7+ 都能写。
 *
 * 文件结构（FlatBuffers 二进制）：
 *
 *   [0..7]    魔数 "fgb\x03fgb\x01"（第 8 字节是补丁版本，可忽略）
 *   [8..11]   Header 长度（uint32）
 *   [12..]    Header（FlatBuffer）
 *             ├ name / title / description
 *             ├ geometryType / hasZ / hasM
 *             ├ columns[]（属性字段定义：名字 + 类型）
 *             ├ featuresCount
 *             ├ indexNodeSize（>0 表示后面带 R-tree 索引）
 *             └ crs（org / code / name / wkt / codeString）
 *   [..]      可选的 R-tree 索引（packed R-tree）
 *   [..]      要素区：每个要素一个 size-prefixed FlatBuffer
 *             ├ geometry（ends / xy / z / m / type / parts）
 *             ├ properties（列式二进制：uint16 列序号 + 值）
 *             └ columns（该要素自带的列定义）
 *
 * 本模块自带极简 FlatBuffers 读取器，不额外引入依赖。
 *
 * 导出：window.LEFlatGeobuf = { parse(bytes) }
 */
(function () {
  'use strict';

  const FGB_MAGIC = [0x66, 0x67, 0x62];   // "fgb"

  // FlatGeobuf GeometryType
  const G_UNKNOWN = 0, G_POINT = 1, G_LINESTRING = 2, G_POLYGON = 3,
    G_MULTIPOINT = 4, G_MULTILINESTRING = 5, G_MULTIPOLYGON = 6, G_GEOMETRYCOLLECTION = 7;

  // FlatGeobuf ColumnType
  const C_BYTE = 0, C_UBYTE = 1, C_BOOL = 2, C_SHORT = 3, C_USHORT = 4,
    C_INT = 5, C_UINT = 6, C_LONG = 7, C_ULONG = 8, C_FLOAT = 9, C_DOUBLE = 10,
    C_STRING = 11, C_JSON = 12, C_DATETIME = 13, C_BINARY = 14;

  const NODE_ITEM_BYTES = 40;   // minX,minY,maxX,maxY (4×float64) + offset (uint64)

  /* ------------------------------------------------------------------ *
   * 极简 FlatBuffers 读取器
   *
   * 只实现本模块需要的部分。
   * 布局规则：
   *   - 根对象前 4 字节是 int32 偏移量（相对自身位置）
   *   - 对象的 vtable 在 objPos - int32(objPos)
   *   - vtable 前 2 字节是 vtable 长度，第 4 字节是表长度
   *   - 字段偏移 = vtable[4 + fieldIndex*2]（相对对象起点）
   *   - vector：指向处 int32 长度，其后是元素
   *   - vector of tables：每个元素是相对自身的 uoffset
   * ------------------------------------------------------------------ */

  function FbReader(bytes, base) {
    this.bytes = bytes;
    this.base = base || 0;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  FbReader.prototype.u8 = function (p) { return this.dv.getUint8(this.base + p); };
  FbReader.prototype.i8 = function (p) { return this.dv.getInt8(this.base + p); };
  FbReader.prototype.u16 = function (p) { return this.dv.getUint16(this.base + p, true); };
  FbReader.prototype.i16 = function (p) { return this.dv.getInt16(this.base + p, true); };
  FbReader.prototype.u32 = function (p) { return this.dv.getUint32(this.base + p, true); };
  FbReader.prototype.i32 = function (p) { return this.dv.getInt32(this.base + p, true); };
  FbReader.prototype.u64 = function (p) {
    const lo = this.dv.getUint32(this.base + p, true);
    const hi = this.dv.getUint32(this.base + p + 4, true);
    return hi * 4294967296 + lo;
  };
  FbReader.prototype.f64 = function (p) { return this.dv.getFloat64(this.base + p, true); };
  FbReader.prototype.f32 = function (p) { return this.dv.getFloat32(this.base + p, true); };

  /** 读一个对象内的字段偏移；0 表示字段缺省。 */
  FbReader.prototype.fieldOffset = function (objPos, fieldIndex) {
    const vtable = objPos - this.i32(objPos);
    const vtableLen = this.u16(vtable);
    const slot = 4 + fieldIndex * 2;
    if (slot >= vtableLen) return 0;
    const off = this.u16(vtable + slot);
    return off ? objPos + off : 0;
  };

  /** 读字符串字段（fieldIndex 是 flatbuffers schema 里的字段序号）。 */
  FbReader.prototype.str = function (objPos, fieldIndex) {
    const p = this.fieldOffset(objPos, fieldIndex);
    if (!p) return null;
    const start = p + this.i32(p);
    const len = this.i32(start);
    const bytes = this.bytes.subarray(this.base + start + 4, this.base + start + 4 + len);
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch (_) {
      return String.fromCharCode.apply(null, Array.from(bytes));
    }
  };

  /** 读 vector 字段，返回 {start, length}（元素起始下标与元素个数，均相对 base）。 */
  FbReader.prototype.vector = function (objPos, fieldIndex, elemSize) {
    const p = this.fieldOffset(objPos, fieldIndex);
    if (!p) return null;
    const vpos = p + this.i32(p);
    const len = this.i32(vpos);
    return { start: vpos + 4, length: len, elemSize: elemSize };
  };

  /** 读 vector 里第 i 个对象的下标（vector of tables）。 */
  FbReader.prototype.vectorTable = function (objPos, fieldIndex, index) {
    const v = this.vector(objPos, fieldIndex, 4);
    if (!v || index >= v.length) return 0;
    const slot = v.start + index * 4;
    return slot + this.i32(slot);
  };

  /* ------------------------------------------------------------------ *
   * Header
   * ------------------------------------------------------------------ */

  // Header schema 字段序号（flatgeobuf/header.fbs）
  const H_NAME = 0, H_ENVELOPE = 1, H_GEOMETRY_TYPE = 2, H_HAS_Z = 3, H_HAS_M = 4,
    H_HAS_T = 5, H_HAS_TM = 6, H_COLUMNS = 7, H_FEATURES_COUNT = 8,
    H_INDEX_NODE_SIZE = 9, H_CRS = 10, H_TITLE = 11, H_DESCRIPTION = 12, H_METADATA = 13;

  // Column schema 字段序号
  const COL_NAME = 0, COL_TYPE = 1, COL_TITLE = 2, COL_DESCRIPTION = 3,
    COL_WIDTH = 4, COL_PRECISION = 5, COL_SCALE = 6, COL_NULLABLE = 7,
    COL_UNIQUE = 8, COL_PRIMARY_KEY = 9, COL_METADATA = 10;

  // Crs schema 字段序号
  const CRS_ORG = 0, CRS_CODE = 1, CRS_NAME = 2, CRS_DESCRIPTION = 3,
    CRS_WKT = 4, CRS_CODE_STRING = 5;

  // Feature schema 字段序号
  const F_GEOMETRY = 0, F_PROPERTIES = 1, F_COLUMNS = 2;

  // Geometry schema 字段序号
  const G_ENDS = 0, G_XY = 1, G_Z = 2, G_M = 3, G_T = 4, G_TM = 5,
    G_TYPE = 6, G_PARTS = 7;

  function readColumns(reader, objPos, fieldIndex) {
    const out = [];
    const v = reader.vector(objPos, fieldIndex, 4);
    if (!v) return out;
    for (let i = 0; i < v.length; i++) {
      const colPos = reader.vectorTable(objPos, fieldIndex, i);
      if (!colPos) continue;
      const typeOff = reader.fieldOffset(colPos, COL_TYPE);
      out.push({
        name: reader.str(colPos, COL_NAME) || ('field_' + i),
        type: typeOff ? reader.u8(typeOff) : C_STRING,
        title: reader.str(colPos, COL_TITLE) || null,
        description: reader.str(colPos, COL_DESCRIPTION) || null,
      });
    }
    return out;
  }

  function readCrs(reader, headerPos) {
    const p = reader.fieldOffset(headerPos, H_CRS);
    if (!p) return null;
    const crsPos = p + reader.i32(p);
    const codeOff = reader.fieldOffset(crsPos, CRS_CODE);
    const code = codeOff ? reader.i32(codeOff) : 0;
    const org = reader.str(crsPos, CRS_ORG);
    const name = reader.str(crsPos, CRS_NAME);
    const wkt = reader.str(crsPos, CRS_WKT);
    const codeString = reader.str(crsPos, CRS_CODE_STRING);

    // 优先用 WKT；没有 WKT 就用 org+code 拼 EPSG。
    if (wkt) return wkt;
    if (org && code) {
      if (/^epsg$/i.test(org)) return 'EPSG:' + code;
      return org + ':' + code;
    }
    if (codeString) return codeString;
    if (name) return name;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 几何
   * ------------------------------------------------------------------ */

  /**
   * 读一个 Geometry 表 → 统一结构的几何。
   *
   * 注意：FlatGeobuf 里几何类型默认写在 **Header** 上（每要素类型一致时），
   * 只有「混合类型集合」才在 Geometry 表里写 type。所以这里要用 headerType 兜底。
   *
   * @param {FbReader} reader
   * @param {number} geoPos  Geometry 表的绝对下标（相对 reader.base）
   * @param {number} headerType Header 里的几何类型
   * @returns {object|null} { type, coords, rings }
   */
  function readGeometry(reader, geoPos, headerType) {
    const typeOff = reader.fieldOffset(geoPos, G_TYPE);
    let type = typeOff ? reader.u8(typeOff) : G_UNKNOWN;
    if (type === G_UNKNOWN && headerType) type = headerType;

    const xyV = reader.vector(geoPos, G_XY, 8);
    const xy = [];
    if (xyV) {
      // xy 是「扁平的 double 数组」，每 2 个是一对 (x, y)。
      // 注意 vector 的 length 是 double 的个数，不是点数。
      const n = Math.floor(xyV.length / 2);
      for (let i = 0; i < n; i++) {
        xy.push([reader.f64(xyV.start + i * 16), reader.f64(xyV.start + i * 16 + 8)]);
      }
    }

    // ends：每个 part 的顶点累计数
    const endsV = reader.vector(geoPos, G_ENDS, 4);
    const ends = [];
    if (endsV) {
      for (let i = 0; i < endsV.length; i++) ends.push(reader.u32(endsV.start + i * 4));
    }

    // parts：MultiPolygon 之类的子几何
    const partsV = reader.vector(geoPos, G_PARTS, 4);
    const parts = [];
    if (partsV) {
      for (let i = 0; i < partsV.length; i++) {
        const p = reader.vectorTable(geoPos, G_PARTS, i);
        if (p) parts.push(readGeometry(reader, p, G_UNKNOWN));
      }
    }

    switch (type) {
      case G_POINT:
        return xy.length ? { type: 'point', coords: xy[0] } : null;

      case G_MULTIPOINT:
        return xy.length ? { type: 'multipoint', coords: xy } : null;

      case G_LINESTRING:
        return xy.length >= 2 ? { type: 'line', coords: xy } : null;

      case G_MULTILINESTRING: {
        const lines = splitByEnds(xy, ends).filter((l) => l.length >= 2);
        if (!lines.length) return null;
        return lines.length === 1
          ? { type: 'line', coords: lines[0] }
          : { type: 'multiline', coords: lines };
      }

      case G_POLYGON: {
        const rings = splitByEnds(xy, ends).filter((r) => r.length >= 3);
        return rings.length ? { type: 'polygon', rings: rings } : null;
      }

      case G_MULTIPOLYGON: {
        const polys = [];
        for (const part of parts) {
          if (!part) continue;
          if (part.type === 'polygon') polys.push(part.rings);
          else if (part.type === 'multipolygon') polys.push.apply(polys, part.rings);
        }
        if (!polys.length) return null;
        return polys.length === 1
          ? { type: 'polygon', rings: polys[0] }
          : { type: 'multipolygon', rings: polys };
      }

      case G_GEOMETRYCOLLECTION: {
        const out = [];
        for (const part of parts) {
          if (!part) continue;
          if (part.type === 'point') out.push({ type: 'point', coords: part.coords });
          else if (part.type === 'multipoint') out.push({ type: 'multipoint', coords: part.coords });
          else if (part.type === 'line') out.push({ type: 'line', coords: part.coords });
          else if (part.type === 'multiline') out.push({ type: 'multiline', coords: part.coords });
          else if (part.type === 'polygon') out.push({ type: 'polygon', rings: part.rings });
          else if (part.type === 'multipolygon') out.push({ type: 'multipolygon', rings: part.rings });
        }
        if (!out.length) return null;
        const first = out[0].type;
        // 集合里类型不一致时只保留第一个（多数情况是同类）
        return out.every((g) => g.type === first) ? out[0] : out[0];
      }

      default:
        return null;
    }
  }

  /** 按 ends 里的累计顶点数切分 xy。 */
  function splitByEnds(xy, ends) {
    if (!ends || !ends.length) return xy.length ? [xy] : [];
    const out = [];
    let s = 0;
    for (const e of ends) {
      const n = Math.min(e, xy.length);
      if (n > s) out.push(xy.slice(s, n));
      s = n;
    }
    if (s < xy.length) out.push(xy.slice(s));
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 属性
   * ------------------------------------------------------------------ */

  /**
   * 解析要素的列式属性区。
   * 格式：每条记录 = uint16 列序号 + 按列类型的值。
   */
  function readProperties(reader, featPos, columns) {
    const props = {};
    if (!columns.length) return props;
    const v = reader.vector(featPos, F_PROPERTIES, 1);
    if (!v || v.length <= 0) return props;

    const dec = new TextDecoder('utf-8');
    let off = v.start;
    const end = v.start + v.length;

    while (off + 2 <= end) {
      const idx = reader.u16(off);
      off += 2;
      const col = columns[idx];
      if (!col) return props;              // 列定义缺失，无法继续（避免死循环）
      let value;
      switch (col.type) {
        case C_BYTE:
          if (off + 1 > end) return props;
          value = reader.i8(off); off += 1; break;
        case C_UBYTE:
          if (off + 1 > end) return props;
          value = reader.u8(off); off += 1; break;
        case C_BOOL:
          if (off + 1 > end) return props;
          value = reader.u8(off) !== 0; off += 1; break;
        case C_SHORT:
          if (off + 2 > end) return props;
          value = reader.i16(off); off += 2; break;
        case C_USHORT:
          if (off + 2 > end) return props;
          value = reader.u16(off); off += 2; break;
        case C_INT:
          if (off + 4 > end) return props;
          value = reader.i32(off); off += 4; break;
        case C_UINT:
          if (off + 4 > end) return props;
          value = reader.u32(off); off += 4; break;
        case C_LONG: {
          if (off + 8 > end) return props;
          const lo = reader.u32(off), hi = reader.u32(off + 4);
          const big = BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo));
          off += 8;
          value = (big >= -9007199254740991n && big <= 9007199254740991n)
            ? Number(big) : String(big);
          break;
        }
        case C_ULONG: {
          if (off + 8 > end) return props;
          const lo = reader.u32(off), hi = reader.u32(off + 4);
          const big = BigInt.asUintN(64, (BigInt(hi) << 32n) | BigInt(lo));
          off += 8;
          value = (big <= 9007199254740991n) ? Number(big) : String(big);
          break;
        }
        case C_FLOAT:
          if (off + 4 > end) return props;
          value = reader.f32(off); off += 4; break;
        case C_DOUBLE:
          if (off + 8 > end) return props;
          value = reader.f64(off); off += 8; break;
        case C_STRING:
        case C_JSON:
        case C_DATETIME: {
          if (off + 4 > end) return props;
          const len = reader.u32(off); off += 4;
          if (off + len > end) return props;
          const s = dec.decode(reader.bytesOf(off, len));
          off += len;
          if (col.type === C_JSON) {
            try { value = JSON.parse(s); } catch (_) { value = s; }
          } else {
            value = s;
          }
          break;
        }
        case C_BINARY: {
          if (off + 4 > end) return props;
          const len = reader.u32(off); off += 4;
          if (off + len > end) return props;
          off += len;
          value = null;                    // 二进制不适合塞进属性表
          break;
        }
        default:
          return props;
      }
      props[col.name] = value;
    }
    return props;
  }

  /** 从 reader 的字节区切一段出来（相对 base）。 */
  FbReader.prototype.bytesOf = function (start, len) {
    return this.bytes.subarray(this.base + start, this.base + start + len);
  };

  /* ------------------------------------------------------------------ *
   * R-tree 索引（packed R-tree）
   * ------------------------------------------------------------------ */

  /**
   * 计算 packed R-tree 的节点总数。
   * 与 flatgeobuf 官方实现一致：自底向上，每 nodeSize 个节点归并成一个父节点。
   */
  function treeNodeCount(numItems, nodeSize) {
    if (!numItems || numItems < 1) return 0;
    nodeSize = Math.min(Math.max(nodeSize | 0, 2), 65535);
    let n = numItems;
    let numNodes = n;
    do {
      n = Math.ceil(n / nodeSize);
      numNodes += n;
    } while (n !== 1);
    return numNodes;
  }

  /**
   * 读 R-tree 索引，得到每个要素在要素区里的字节偏移。
   *
   * packed R-tree 的节点布局（对齐 flatgeobuf 官方实现）：
   *   - 共 numNodes 个节点，**叶层（第 0 层）的 numItems 个节点排在
   *     索引数组的末尾**（levelBounds[0].Start = numNodes - numItems），
   *     父节点依次排在前面
   *   - 每个 NodeItem = minX,minY,maxX,maxY (float64 ×4) + offset (uint64)
   *   - 叶节点的 offset 是该要素在要素区里的字节偏移
   *
   * @returns {Array} [{offset}] offset 相对要素区起点
   */
  function readIndex(bytes, indexOffset, numItems, nodeSize) {
    const out = [];
    if (!numItems || !nodeSize) return out;
    const numNodes = treeNodeCount(numItems, nodeSize);
    const treeBytes = numNodes * NODE_ITEM_BYTES;
    if (indexOffset + treeBytes > bytes.length) return out;

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const leafStart = numNodes - numItems;   // 叶层起点（父节点在前，叶层在后）
    for (let i = 0; i < numItems; i++) {
      const p = indexOffset + (leafStart + i) * NODE_ITEM_BYTES + 32;   // offset 字段
      out.push({ offset: Number(dv.getBigUint64(p, true)) });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 主解析
   * ------------------------------------------------------------------ */

  /**
   * 解析 FlatGeobuf。
   * @param {Uint8Array} bytes
   * @returns {{features, crs, fields, warnings, bbox, name}}
   */
  function parse(bytes) {
    const warnings = [];
    if (!bytes || bytes.length < 16) throw new Error('FlatGeobuf 文件太短');
    for (let i = 0; i < 3; i++) {
      if (bytes[i] !== FGB_MAGIC[i]) throw new Error('不是有效的 FlatGeobuf 文件');
    }

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // ---- Header（size-prefixed）----
    const headerSize = dv.getUint32(8, true);
    const headerStart = 12;
    if (headerSize <= 0 || headerStart + headerSize > bytes.length) {
      throw new Error('FlatGeobuf 头部长度越界');
    }
    const reader = new FbReader(bytes, headerStart);
    const headerPos = reader.i32(0);      // 根对象相对 headerStart 的偏移

    const name = reader.str(headerPos, H_NAME) || null;
    const title = reader.str(headerPos, H_TITLE) || null;

    const geomTypeOff = reader.fieldOffset(headerPos, H_GEOMETRY_TYPE);
    const geometryType = geomTypeOff ? reader.u8(geomTypeOff) : G_UNKNOWN;

    const countOff = reader.fieldOffset(headerPos, H_FEATURES_COUNT);
    const featuresCount = countOff ? Number(reader.u64(countOff)) : 0;

    const nodeSizeOff = reader.fieldOffset(headerPos, H_INDEX_NODE_SIZE);
    // flatbuffers schema: index_node_size: ushort = 16 —— **缺省是 16，不是 0**。
    // 只有显式写了 0 才表示「没有索引」。
    const indexNodeSize = nodeSizeOff ? reader.u16(nodeSizeOff) : 16;

    const columns = readColumns(reader, headerPos, H_COLUMNS);
    const crs = readCrs(reader, headerPos);

    // envelope（可选，minX/minY/maxX/maxY）
    const envV = reader.vector(headerPos, H_ENVELOPE, 8);
    let bbox = null;
    if (envV && envV.length >= 4) {
      bbox = [
        reader.f64(envV.start), reader.f64(envV.start + 8),
        reader.f64(envV.start + 16), reader.f64(envV.start + 24),
      ];
    }

    // ---- 要素区起点 ----
    let offset = headerStart + headerSize;

    // ---- R-tree 索引 ----
    let indexItems = null;
    if (indexNodeSize > 0 && featuresCount > 0) {
      const numNodes = treeNodeCount(featuresCount, indexNodeSize);
      indexItems = readIndex(bytes, offset, featuresCount, indexNodeSize);
      if (indexItems.length) offset += numNodes * NODE_ITEM_BYTES;
    }
    const featuresStart = offset;

    // ---- 读要素 ----
    const features = [];
    const fields = [];
    const seenField = {};

    const readOne = (absPos) => {
      if (absPos + 4 > bytes.length) return null;
      const featSize = dv.getUint32(absPos, true);
      const featStart = absPos + 4;
      if (featSize <= 0 || featStart + featSize > bytes.length) return null;

      const fr = new FbReader(bytes, featStart);
      const featPos = fr.i32(0);

      // 几何
      const geoOff = fr.fieldOffset(featPos, F_GEOMETRY);
      let geom = null;
      if (geoOff) {
        const geoPos = geoOff + fr.i32(geoOff);
        try {
          geom = readGeometry(fr, geoPos, geometryType);
        } catch (err) {
          warnings.push('有要素的几何解析失败：' + err.message);
        }
      }

      // 属性：优先用要素自带的列定义，否则用头的列定义
      const featCols = readColumns(fr, featPos, F_COLUMNS);
      const useCols = featCols.length ? featCols : columns;

      let props = {};
      try {
        props = readProperties(fr, featPos, useCols);
      } catch (err) {
        warnings.push('有要素的属性解析失败：' + err.message);
      }

      for (const c of useCols) {
        if (!seenField[c.name]) {
          seenField[c.name] = true;
          fields.push({ name: c.name, type: 'string' });
        }
      }

      if (!geom) return null;
      geom.properties = props;
      return geom;
    };

    if (indexItems && indexItems.length) {
      for (let i = 0; i < indexItems.length; i++) {
        const g = readOne(featuresStart + indexItems[i].offset);
        if (g) features.push(g);
      }
    } else {
      // 没有索引：顺序扫描要素区
      let p = featuresStart;
      while (p + 4 <= bytes.length) {
        const size = dv.getUint32(p, true);
        if (size <= 0 || p + 4 + size > bytes.length) break;
        const g = readOne(p);
        if (g) features.push(g);
        p += 4 + size;
      }
    }

    if (!features.length) {
      warnings.push('没有解析出任何要素');
    }

    return {
      features: features,
      crs: crs,
      fields: fields,
      warnings: warnings,
      bbox: bbox,
      name: name || title,
      geometryType: geometryType,
      featuresCount: featuresCount,
    };
  }

  window.LEFlatGeobuf = {
    parse: parse,
    treeNodeCount: treeNodeCount,
    // 便于单元测试内部结构
    _internal: { readGeometry: readGeometry, readColumns: readColumns, FbReader: FbReader },
  };
})();

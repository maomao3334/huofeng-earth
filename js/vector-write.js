/*
 * 矢量写出内核（纯计算，不依赖 Cesium / DOM）
 * ---------------------------------------------------------------------------
 * P3-4.14「Shapefile / GPKG 写出」的内核部分。
 *
 * 【对标 QGIS 的什么】
 *   QGIS 的「另存为」支持 GDAL 的全套矢量格式。本模块挑了最常用、
 *   且**能在浏览器里纯离线完成**的几种，重新实现一遍：
 *     · Shapefile  —— .shp（几何）+ .shx（索引）+ .dbf（属性）+ .prj（坐标系）
 *     · GPKG       —— GeoPackage（SQLite 容器 + GP 二进制几何）
 *     · GeoJSON    —— 单文件、纯文本、任何软件都能读
 *     · CSV        —— 属性表（带 WKT 几何列）
 *     · KML        —— Google Earth / Google Earth Pro 互通
 *
 * 【为什么自己写】
 *   用户的硬约束是纯离线、浏览器内跑、不依赖外部进程（不调 QGIS / GDAL）。
 *   Shapefile 与 GPKG 都是**公开的二进制格式**，按规范手写即可。
 *
 * 【本模块不做投影变换】
 *   投影变换依赖 proj4（js/projections.js），内核保持纯计算，
 *   由外壳（vector-write-shell.js）在调用前把要素坐标换算好。
 *   内核只负责「给定坐标，写出文件」。
 *
 * 【要素模型（与 js/vector-formats.js 的解析结果一致）】
 *   { type, coords, rings, properties }
 *     type: 'point' | 'multipoint' | 'line' | 'multiline' | 'polygon' | 'multipolygon'
 *     coords: [[x, y, z?], ...]          —— 点/线
 *     rings:  [[[x, y, z?], ...], ...]   —— 面的环（第一个是外环，其余是洞）
 *     multipolygon 的 rings: [ [ring, ring], [ring] ]  —— 每个子面一组环
 *
 * 【对外 API（window.LEVectorWrite = module.exports）】
 *   几何归一：normalizeFeatures / detectGeometry / detectShapeType
 *   GeoJSON ：buildGeoJson
 *   CSV     ：buildCsv
 *   KML     ：buildKml
 *   Shapefile：buildShapefile → { shp, shx, dbf, prj, cpg, files }
 *   GPKG    ：buildGpkg（需要 sql.js）→ Uint8Array
 *   ZIP     ：zipStore（打包 .shp/.shx/.dbf/.prj 成一个 .zip）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LEVectorWrite = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 常量
   * ================================================================ */

  const SHP_NULL = 0;
  const SHP_POINT = 1;
  const SHP_POLYLINE = 3;
  const SHP_POLYGON = 5;
  const SHP_MULTIPOINT = 8;

  const WKB_POINT = 1;
  const WKB_LINESTRING = 2;
  const WKB_POLYGON = 3;
  const WKB_MULTIPOINT = 4;
  const WKB_MULTILINESTRING = 5;
  const WKB_MULTIPOLYGON = 6;

  const GPKG_APPLICATION_ID = 0x47504B47;   // 'GPKG'
  const GPKG_USER_VERSION = 10200;           // 1.2.0

  const WGS84_WKT =
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",' +
    '6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",' +
    '0.0174532925199433]]';

  /**
   * 给常用投影坐标系生成 ESRI 风格的 WKT（写进 .prj / GPKG 的 srs 定义）。
   * 只覆盖本项目实际提供的几个选项，写错的风险比"没有"更大。
   * @param {number|string} epsg
   * @returns {string} WKT；不认识的返回 null
   */
  function wktForEpsg(epsg) {
    const code = parseInt(String(epsg), 10);
    if (!isFinite(code)) return null;
    if (code === 4326) return WGS84_WKT;
    if (code === 4490) {
      return 'GEOGCS["GCS_China_Geodetic_Coordinate_System_2000",' +
        'DATUM["D_China_2000",SPHEROID["CGCS2000",6378137.0,298.257222101]],' +
        'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    }
    if (code === 3857) {
      return 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",' +
        'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",' +
        '6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],' +
        'UNIT["Degree",0.0174532925199433]],' +
        'PROJECTION["Mercator_Auxiliary_Sphere"],' +
        'PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],' +
        'PARAMETER["Central_Meridian",0.0],PARAMETER["Scale_Factor",1.0],' +
        'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
    }
    // CGCS2000 3 度带（EPSG 4534–4554 是"中央经线"系列）：
    // 4534 = 带 25 → 中央经线 75°E；中央经线 = 带号 × 3。
    // 4547 = 带 38 → 114°E；4548 = 带 39 → 117°E。
    if (code >= 4534 && code <= 4554) {
      const cm = (code - 4509) * 3;
      return 'PROJCS["CGCS2000_3_Degree_GK_CM_' + cm + 'E",' +
        'GEOGCS["GCS_China_Geodetic_Coordinate_System_2000",' +
        'DATUM["D_China_2000",SPHEROID["CGCS2000",6378137.0,298.257222101]],' +
        'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
        'PROJECTION["Gauss_Kruger"],PARAMETER["False_Easting",500000.0],' +
        'PARAMETER["False_Northing",0.0],' +
        'PARAMETER["Central_Meridian",' + cm + '.0],' +
        'PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",0.0],' +
        'UNIT["Meter",1.0],AUTHORITY["EPSG",' + code + ']]';
    }
    return null;
  }

  /* ================================================================
   * 工具
   * ================================================================ */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 字节序：DBF 用 0x03（dBASE III，无 memo）。 */
  const DBF_VERSION = 0x03;

  /* ================================================================
   * ① 几何归一
   * ================================================================ */

  /**
   * 把要素整理成统一形状，丢掉空几何。
   * @param {Array} features
   * @returns {Array} 归一后的要素
   */
  function normalizeFeatures(features) {
    const out = [];
    (features || []).forEach(function (f) {
      if (!f) return;
      const n = normalizeFeature(f);
      if (n) out.push(n);
    });
    return out;
  }

  function normalizeFeature(f) {
    const t = String(f.type || '').toLowerCase();
    const props = f.properties || {};

    // 注意：坐标的"层级"不能靠 type 字段判断 —— type 说的是几何类别，
    // 而 coords 里到底是一串点还是一串线，取决于数据本身。
    // 判据：第二层是数字 → 一维（单个点 / 单条线）；第二层是数组 → 二维。
    const isPointLike = function (c) {
      return Array.isArray(c) && c.length >= 2 && isNum(c[0]) && isNum(c[1]);
    };
    const isListLike = function (c) {
      return Array.isArray(c) && c.length >= 1 && Array.isArray(c[0]);
    };

    if (t === 'point' || t === 'multipoint') {
      let pts;
      if (isPointLike(f.coords)) pts = [f.coords];
      else if (isListLike(f.coords)) pts = f.coords;
      else pts = [];
      const clean = pts.filter(isPointLike);
      if (!clean.length) return null;
      return { type: t, coords: clean, properties: props };
    }

    if (t === 'line' || t === 'multiline') {
      let lines;
      if (isListLike(f.coords) && isPointLike(f.coords[0])) lines = [f.coords];
      else if (isListLike(f.coords)) lines = f.coords;
      else lines = [];
      const clean = lines
        .map(function (line) { return (line || []).filter(isPointLike); })
        .filter(function (line) { return line.length >= 2; });
      if (!clean.length) return null;
      return { type: t, coords: clean, properties: props };
    }

    if (t === 'polygon' || t === 'multipolygon') {
      // rings 的两种嵌套（差一层）：
      //   单面：rings = [ring, ring(洞)]      ring = [[x,y],...]
      //   多面：rings = [[ring, ring(洞)], ...]
      // 判据：r[0][0][0] 是数字 → r[0] 是"一组环"（多面）；
      //       r[0][0][0] 是数组 → r[0] 本身是环（单面）。
      const r = f.rings;
      const clean = [];
      if (Array.isArray(r) && r.length) {
        const d3 = r[0] && r[0].length ? r[0][0] : null;
        const isMulti = Array.isArray(d3) && Array.isArray(d3[0]);
        // 每个"多边形" = 一组环
        const polys = isMulti ? r : [r];
        for (const rings of polys) {
          if (!Array.isArray(rings) || !rings.length) continue;
          const rr = rings
            .map(function (ring) { return (ring || []).filter(isPointLike); })
            .filter(function (ring) { return ring.length >= 3; });
          if (rr.length) clean.push(rr);
        }
      }
      if (!clean.length) return null;
      // 归一后的形状与 js/vector-formats.js 的解析结果保持一致：
      //   polygon     → rings = [ring, ...]        （一个面，一组环）
      //   multipolygon → rings = [[ring, ...], ...]（多个面，每面一组环）
      return {
        type: t,
        rings: t === 'polygon' ? clean[0] : clean,
        properties: props,
      };
    }
    return null;
  }

  /**
   * 面的「每个子面 → 一组环」视图。
   *
   * 归一后（与 js/vector-formats.js 的解析结果一致）：
   *   polygon      → rings = [ring, ...]          一个面，一组环
   *   multipolygon → rings = [[ring, ...], ...]   多个面，每面一组环
   * 这个函数把两种形状统一成「数组的数组」，省得到处判断类型。
   */
  function polysOf(f) {
    if (!f || !f.rings) return [];
    return f.type === 'polygon' ? [f.rings] : f.rings;
  }

  /**
   * 一组要素的几何类型。
   *
   * 混合类型的处理规则（与 QGIS/OGR 的做法一致）：
   *   · 点 + 点组      → multipoint
   *   · 线 + 线组      → multiline
   *   · 面 + 多部件面  → multipolygon
   *   · 点 + 线        → **非法**（点线没法合成一种几何），返回 'mixed'
   *   · 点 + 面        → **非法**，返回 'mixed'
   * 写成 Shapefile 时，'mixed' 会被拆成多个文件（点一个、线一个、面一个）。
   */
  function detectGeometry(features) {
    const list = normalizeFeatures(features);
    if (!list.length) return 'point';
    const kinds = {};
    list.forEach(function (f) { kinds[f.type] = 1; });
    const keys = Object.keys(kinds);
    if (keys.length === 1) return keys[0];

    const has = function (t) { return !!kinds[t]; };
    const hasPoint = has('point') || has('multipoint');
    const hasLine = has('line') || has('multiline');
    const hasPoly = has('polygon') || has('multipolygon');
    // 点线面混装没法合成一种几何 —— 点不能变成线，线也不能变成点。
    if (hasPoint && (hasLine || hasPoly)) return 'mixed';
    if (hasPoly) return 'multipolygon';
    if (hasLine) return 'multiline';
    return 'multipoint';
  }

  /**
   * 把混装的要素按几何类别分组 —— Shapefile 一个文件只能装一种几何。
   * @returns {Array<{kind, features}>} kind 为 'point'|'line'|'polygon'
   */
  function groupByGeometryClass(features) {
    const list = normalizeFeatures(features);
    const groups = { point: [], line: [], polygon: [] };
    list.forEach(function (f) {
      const t = f.type;
      if (t === 'point' || t === 'multipoint') groups.point.push(f);
      else if (t === 'line' || t === 'multiline') groups.line.push(f);
      else groups.polygon.push(f);
    });
    const out = [];
    ['point', 'line', 'polygon'].forEach(function (k) {
      if (groups[k].length) out.push({ kind: k, features: groups[k] });
    });
    return out;
  }

  /**
   * Shapefile 的 shapeType。Shapefile 是"单几何类型"的，
   * 多部件要靠 parts 表达；点之外的类型不能混装。
   */
  function detectShapeType(features) {
    const g = detectGeometry(features);
    if (g === 'point') return SHP_POINT;
    if (g === 'multipoint') return SHP_MULTIPOINT;
    if (g === 'line' || g === 'multiline') return SHP_POLYLINE;
    if (g === 'mixed') {
      // 混装：按**占多数**的那一类定，多余的类别会在写出时被跳过并报告
      const groups = groupByGeometryClass(features);
      let best = null;
      groups.forEach(function (g2) {
        if (!best || g2.features.length > best.features.length) best = g2;
      });
      const kind = best ? best.kind : 'point';
      if (kind === 'point') return SHP_POINT;
      if (kind === 'line') return SHP_POLYLINE;
      return SHP_POLYGON;
    }
    return SHP_POLYGON;
  }

  /** 一组要素里是否有点、线、面三类混合（Shapefile 不允许）。 */
  function hasMixedTypes(features) {
    const list = normalizeFeatures(features);
    const group = function (t) {
      if (t === 'point' || t === 'multipoint') return 'point';
      if (t === 'line' || t === 'multiline') return 'line';
      return 'polygon';
    };
    const g = {};
    list.forEach(function (f) { g[group(f.type)] = 1; });
    return Object.keys(g).length > 1;
  }

  /* ================================================================
   * ② 属性表 → 字段定义
   * ================================================================ */

  const DBF_MAX_NAME = 10;   // DBF 字段名最长 10 字符
  const DBF_MAX_WIDTH = 254; // 单字段最长 254

  /**
   * 推断属性字段的类型与宽度。
   * 规则与 QGIS/DBF 常规一致：
   *   全是数字 → N（数值，带小数位）
   *   全是 true/false → L（逻辑）
   *   全是 YYYYMMDD → D（日期）
   *   其它 → C（文本）
   */
  function inferFields(features) {
    const rows = [];
    const order = [];
    const seen = {};
    (features || []).forEach(function (f) {
      const p = (f && f.properties) || {};
      rows.push(p);
      for (const k of Object.keys(p)) {
        if (!seen[k]) { seen[k] = 1; order.push(k); }
      }
    });

    return order.map(function (name) {
      const raw = rows.map(function (p) { return p[name]; });
      const nonNull = raw.filter(function (v) { return v !== null && v !== undefined && v !== ''; });
      const allNum = nonNull.length > 0 && nonNull.every(function (v) {
        return typeof v === 'number' && isFinite(v);
      });
      const allBool = nonNull.length > 0 && nonNull.every(function (v) {
        return v === true || v === false;
      });
      const allDate = nonNull.length > 0 && nonNull.every(function (v) {
        return typeof v === 'string' && /^\d{8}$/.test(v);
      });

      if (allNum) {
        let dec = 0;
        let maxInt = 0;
        nonNull.forEach(function (v) {
          const s = String(v);
          const dot = s.indexOf('.');
          const d = dot >= 0 ? (s.length - dot - 1) : 0;
          if (d > dec) dec = d;
          const intLen = dot >= 0 ? dot : s.length;
          if (intLen > maxInt) maxInt = intLen;
        });
        const width = Math.min(DBF_MAX_WIDTH, Math.max(1, maxInt + (dec ? dec + 1 : 0)));
        return { name: name, type: 'N', length: width, dec: dec };
      }
      if (allBool) {
        return { name: name, type: 'L', length: 1, dec: 0 };
      }
      if (allDate) {
        return { name: name, type: 'D', length: 8, dec: 0 };
      }
      // 文本：宽度取最长值（**按编码后的字节数**，不是字符数 —— UTF-8 下
      // 一个汉字 3 字节，DBF 的字段宽度是字节数），上限 254
      let maxLen = 1;
      const enc = new TextEncoder();
      nonNull.forEach(function (v) {
        const n = enc.encode(String(v)).length;
        if (n > maxLen) maxLen = n;
      });
      return { name: name, type: 'C', length: Math.min(DBF_MAX_WIDTH, maxLen), dec: 0 };
    });
  }

  /**
   * DBF 字段名要唯一且 ≤10 字符，这里做去重与截断。
   */
  function sanitizeFieldNames(fields) {
    const used = {};
    return fields.map(function (f) {
      let name = String(f.name || 'FIELD').replace(/[\0]/g, '').trim();
      if (!name) name = 'FIELD';
      if (name.length > DBF_MAX_NAME) name = name.slice(0, DBF_MAX_NAME);
      let base = name;
      let i = 2;
      while (used[name]) {
        const suffix = '_' + i;
        name = base.slice(0, Math.max(1, DBF_MAX_NAME - suffix.length)) + suffix;
        i++;
      }
      used[name] = 1;
      return Object.assign({}, f, { name: name });
    });
  }

  /* ================================================================
   * ③ GeoJSON
   * ================================================================ */

  function geomToGeoJson(f) {
    const t = f.type;
    if (t === 'point') {
      return { type: 'Point', coordinates: f.coords[0] };
    }
    if (t === 'multipoint') {
      return { type: 'MultiPoint', coordinates: f.coords };
    }
    if (t === 'line') {
      return { type: 'LineString', coordinates: f.coords[0] };
    }
    if (t === 'multiline') {
      return { type: 'MultiLineString', coordinates: f.coords };
    }
    if (t === 'polygon') {
      return { type: 'Polygon', coordinates: f.rings };
    }
    if (t === 'multipolygon') {
      return { type: 'MultiPolygon', coordinates: f.rings };
    }
    return null;
  }

  /**
   * 构造 GeoJSON FeatureCollection。
   * @param {Array} features
   * @param {Object} opts { crs（默认不写 crs，规范默认 WGS84）, pretty }
   */
  function buildGeoJson(features, opts) {
    const o = opts || {};
    const list = normalizeFeatures(features);
    const out = [];
    list.forEach(function (f) {
      const geometry = geomToGeoJson(f);
      if (!geometry) return;
      out.push({
        type: 'Feature',
        properties: f.properties || {},
        geometry: geometry,
      });
    });
    const fc = { type: 'FeatureCollection', features: out };
    if (o.crs) {
      // 非标准但 QGIS 会写；仅在需要时给出
      fc.crs = { type: 'name', properties: { name: o.crs } };
    }
    return fc;
  }

  /* ================================================================
   * ④ CSV（属性表 + WKT 几何列）
   * ================================================================ */

  function escCsv(v) {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * 坐标 → WKT 文本。
   *
   * 注意：这里的入参先过一遍 normalizeFeature —— 因为「线」的 coords
   * 有两种形状：解析器给出的是**扁平的** [[x,y], [x,y], ...]，
   * 而内核内部统一成**套一层的** [[[x,y], ...]]。
   * 不归一的话，扁平形状会被当成"套一层"，取到的是第一个点而不是整条线。
   */
  function toWkt(f) {
    const n = normalizeFeature(f);
    if (!n) return '';
    const t = n.type;
    const pt = function (c) {
      return (isNum(c[0]) ? c[0] : 0) + ' ' + (isNum(c[1]) ? c[1] : 0);
    };
    if (t === 'point') return 'POINT (' + pt(n.coords[0]) + ')';
    if (t === 'multipoint') {
      return 'MULTIPOINT (' + n.coords.map(function (c) {
        return '(' + pt(c) + ')';
      }).join(', ') + ')';
    }
    if (t === 'line') {
      return 'LINESTRING (' + n.coords[0].map(pt).join(', ') + ')';
    }
    if (t === 'multiline') {
      return 'MULTILINESTRING (' + n.coords.map(function (line) {
        return '(' + line.map(pt).join(', ') + ')';
      }).join(', ') + ')';
    }
    if (t === 'polygon') {
      return 'POLYGON (' + n.rings.map(function (ring) {
        return '(' + ring.map(pt).join(', ') + ')';
      }).join(', ') + ')';
    }
    if (t === 'multipolygon') {
      return 'MULTIPOLYGON (' + polysOf(n).map(function (poly) {
        return '(' + poly.map(function (ring) {
          return '(' + ring.map(pt).join(', ') + ')';
        }).join(', ') + ')';
      }).join(', ') + ')';
    }
    return '';
  }

  /**
   * 构造 CSV：首行属性字段名 + 一列 WKT 几何。
   */
  function buildCsv(features, opts) {
    const o = opts || {};
    const list = normalizeFeatures(features);
    const fields = sanitizeFieldNames(inferFields(list));
    const header = ['geometry'].concat(fields.map(function (f) { return f.name; }));
    const lines = [header.map(escCsv).join(',')];
    list.forEach(function (f) {
      const row = [toWkt(f)];
      fields.forEach(function (fd) {
        const v = (f.properties || {})[fd.name];
        row.push(v === null || v === undefined ? '' : String(v));
      });
      lines.push(row.map(escCsv).join(','));
    });
    // BOM：让 Excel 正确识别 UTF-8
    return (o.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
  }

  /* ================================================================
   * ⑤ KML
   * ================================================================ */

  function escXml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function kmlCoords(points) {
    return (points || []).map(function (c) {
      const x = isNum(c[0]) ? c[0] : 0;
      const y = isNum(c[1]) ? c[1] : 0;
      const z = isNum(c[2]) ? c[2] : 0;
      return x + ',' + y + ',' + z;
    }).join(' ');
  }

  function kmlPlacemark(f, name) {
    const props = f.properties || {};
    const nm = name || props.name || props.NAME || props.title || '';
    let geom = '';
    const t = f.type;
    if (t === 'point' || t === 'multipoint') {
      const pts = t === 'point' ? [f.coords[0]] : f.coords;
      geom = pts.map(function (c) {
        return '<Point><coordinates>' + kmlCoords([c]) + '</coordinates></Point>';
      }).join('');
    } else if (t === 'line' || t === 'multiline') {
      const lines = t === 'line' ? [f.coords[0]] : f.coords;
      geom = lines.map(function (line) {
        return '<LineString><tessellate>1</tessellate><coordinates>' +
          kmlCoords(line) + '</coordinates></LineString>';
      }).join('');
    } else if (t === 'polygon' || t === 'multipolygon') {
      const polys = polysOf(f);
      geom = polys.map(function (poly) {
        const outer = '<outerBoundaryIs><LinearRing><coordinates>' +
          kmlCoords(poly[0]) + '</coordinates></LinearRing></outerBoundaryIs>';
        const holes = poly.slice(1).map(function (ring) {
          return '<innerBoundaryIs><LinearRing><coordinates>' +
            kmlCoords(ring) + '</coordinates></LinearRing></innerBoundaryIs>';
        }).join('');
        return '<Polygon><tessellate>1</tessellate>' + outer + holes + '</Polygon>';
      }).join('');
    }
    // 属性表塞进 ExtendedData
    const data = Object.keys(props)
      .filter(function (k) { return props[k] !== null && props[k] !== undefined; })
      .map(function (k) {
        return '<Data name="' + escXml(k) + '"><value>' + escXml(props[k]) + '</value></Data>';
      }).join('');
    const ext = data ? '<ExtendedData>' + data + '</ExtendedData>' : '';
    return '<Placemark><name>' + escXml(nm) + '</name>' + geom + ext + '</Placemark>';
  }

  /**
   * 构造 KML 文档。
   * @param {Array} features
   * @param {Object} opts { name, description }
   */
  function buildKml(features, opts) {
    const o = opts || {};
    const list = normalizeFeatures(features);
    const name = o.name || '本地地球导出';
    const desc = o.description || '由「本地地球 Local Earth」离线导出';
    const body = list.map(function (f) { return kmlPlacemark(f); }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
      '<Document>\n' +
      '<name>' + escXml(name) + '</name>\n' +
      '<description>' + escXml(desc) + '</description>\n' +
      body + '\n' +
      '</Document>\n</kml>\n';
  }

  /* ================================================================
   * ⑥ Shapefile
   * ================================================================ */

  /**
   * 把一组要素拆成 Shapefile 需要的「记录」。
   * 每条记录：{ type, shapeType, points:[[x,y]...], parts:[起点偏移...], bbox }
   *
   * Shapefile 一个文件只能装一种几何类型，因此点/线/面混装的要素会被跳过。
   * 跳过的要素在返回值 skipped 里列出，不静默丢弃。
   */
  function toShpRecords(features, shapeType) {
    const list = normalizeFeatures(features);
    const records = [];
    const skipped = [];

    list.forEach(function (f) {
      if (shapeType === SHP_POINT) {
        if (f.type !== 'point') {
          skipped.push({ type: f.type, reason: 'Shapefile 一个文件只能装一种几何类型' });
          return;
        }
        const c = f.coords[0];
        records.push({
          type: SHP_POINT,
          points: [[c[0], c[1]]],
          parts: [0],
        });
        return;
      }
      if (shapeType === SHP_MULTIPOINT) {
        if (f.type !== 'point' && f.type !== 'multipoint') {
          skipped.push({ type: f.type, reason: 'Shapefile 一个文件只能装一种几何类型' });
          return;
        }
        const pts = f.type === 'point' ? [f.coords[0]] : f.coords;
        records.push({ type: SHP_MULTIPOINT, points: pts.map(function (c) { return [c[0], c[1]]; }), parts: [0] });
        return;
      }
      if (shapeType === SHP_POLYLINE) {
        if (f.type !== 'line' && f.type !== 'multiline') {
          skipped.push({ type: f.type, reason: 'Shapefile 一个文件只能装一种几何类型' });
          return;
        }
        const lines = f.type === 'line' ? [f.coords[0]] : f.coords;
        const points = [];
        const parts = [];
        lines.forEach(function (line) {
          if (line.length < 2) return;
          parts.push(points.length);
          line.forEach(function (c) { points.push([c[0], c[1]]); });
        });
        if (!points.length) return;
        records.push({ type: SHP_POLYLINE, points: points, parts: parts });
        return;
      }
      // 多边形：每个子面 → 外环 + 洞（Shapefile 用顺时针表示洞）
      if (f.type !== 'polygon' && f.type !== 'multipolygon') {
        skipped.push({ type: f.type, reason: 'Shapefile 一个文件只能装一种几何类型' });
        return;
      }
      const polys = polysOf(f);
      const points = [];
      const parts = [];
      polys.forEach(function (poly) {
        poly.forEach(function (ring, ri) {
          const rr = closeRingForShp(ring, ri > 0);
          if (rr.length < 3) return;
          parts.push(points.length);
          rr.forEach(function (c) { points.push([c[0], c[1]]); });
        });
      });
      if (!points.length) return;
      records.push({ type: SHP_POLYGON, points: points, parts: parts });
    });

    records.forEach(function (r) { r.bbox = bboxOfPoints(r.points); });
    return { records: records, skipped: skipped };
  }

  /**
   * Shapefile 的多边形环约定（ESRI Shapefile Technical Description）：
   *   **外环顺时针（面积符号为负）、洞逆时针（面积为正）**。
   * 同时首尾要闭合（第一个点 == 最后一个点）。
   * 实测确认：本仓库的样例 data/samples/import-test/shp_4548_poly/poly.shp
   * （GDAL/QGIS 写出）外环有向面积为负，即顺时针；其源 poly.geojson
   * 的外环是逆时针 —— 说明写出时确实翻了向。
   * @param {Array} ring 原始环
   * @param {boolean} isHole 是否是洞
   */
  function closeRingForShp(ring, isHole) {
    const pts = ring.map(function (c) { return [c[0], c[1]]; });
    if (pts.length < 3) return pts;
    // 按 ESRI 约定翻向：外环 → 负面积（顺时针）；洞 → 正面积（逆时针）
    const area = ringSignedArea(pts);
    const wantPositive = !!isHole;
    if ((area > 0) !== wantPositive && area !== 0) pts.reverse();
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]);
    return pts;
  }

  /** 环的绕向（面积符号）。正 = 逆时针。 */
  function ringSignedArea(ring) {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return s / 2;
  }

  function bboxOfPoints(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    if (!isFinite(minX)) return [0, 0, 0, 0];
    return [minX, minY, maxX, maxY];
  }

  /** 写 .shp 记录内容（不含记录头）。 */
  function shpRecordContent(rec) {
    if (rec.type === SHP_POINT) {
      const b = new Uint8Array(20);
      const dv = new DataView(b.buffer);
      dv.setInt32(0, rec.type, true);
      dv.setFloat64(4, rec.points[0][0], true);
      dv.setFloat64(12, rec.points[0][1], true);
      return b;
    }
    if (rec.type === SHP_MULTIPOINT) {
      const b = new Uint8Array(40 + rec.points.length * 16);
      const dv = new DataView(b.buffer);
      dv.setInt32(0, rec.type, true);
      dv.setFloat64(4, rec.bbox[0], true);
      dv.setFloat64(12, rec.bbox[1], true);
      dv.setFloat64(20, rec.bbox[2], true);
      dv.setFloat64(28, rec.bbox[3], true);
      dv.setInt32(36, rec.points.length, true);
      rec.points.forEach(function (p, i) {
        dv.setFloat64(40 + i * 16, p[0], true);
        dv.setFloat64(48 + i * 16, p[1], true);
      });
      return b;
    }
    // PolyLine / Polygon
    const numParts = rec.parts.length;
    const numPoints = rec.points.length;
    const b = new Uint8Array(44 + numParts * 4 + numPoints * 16);
    const dv = new DataView(b.buffer);
    dv.setInt32(0, rec.type, true);
    dv.setFloat64(4, rec.bbox[0], true);
    dv.setFloat64(12, rec.bbox[1], true);
    dv.setFloat64(20, rec.bbox[2], true);
    dv.setFloat64(28, rec.bbox[3], true);
    dv.setInt32(36, numParts, true);
    dv.setInt32(40, numPoints, true);
    const partsOff = 44;
    rec.parts.forEach(function (p, i) { dv.setInt32(partsOff + i * 4, p, true); });
    const pointsOff = partsOff + numParts * 4;
    rec.points.forEach(function (p, i) {
      dv.setFloat64(pointsOff + i * 16, p[0], true);
      dv.setFloat64(pointsOff + i * 16 + 8, p[1], true);
    });
    return b;
  }

  /** 写 .shp / .shx。 */
  function buildShpBytes(records, shapeType, bbox) {
    // .shp
    const shpParts = [];
    const shxParts = [];
    const shpHeader = new Uint8Array(100);
    const shxHeader = new Uint8Array(100);
    const sv = new DataView(shpHeader.buffer);
    const xv = new DataView(shxHeader.buffer);
    let shpOffset = 100;
    let shxOffset = 50;

    const shpEntries = [];
    const shxEntries = [];
    records.forEach(function (rec, i) {
      const content = shpRecordContent(rec);
      const contentLenWords = content.length / 2;
      const recHeader = new Uint8Array(8);
      const rv = new DataView(recHeader.buffer);
      rv.setInt32(0, i + 1, false);           // 记录号：大端
      rv.setInt32(4, contentLenWords, false);  // 内容长度（16 位字）：也是大端
      shpEntries.push({ header: recHeader, content: content });

      const idx = new Uint8Array(8);
      const iv = new DataView(idx.buffer);
      iv.setInt32(0, shpOffset / 2, false);    // 记录在 .shp 中的偏移（16 位字）
      iv.setInt32(4, contentLenWords, false);
      shxEntries.push(idx);

      shpOffset += 8 + content.length;
      shxOffset += 8;
    });

    const shpBodyLen = shpOffset - 100;
    const shxBodyLen = shxOffset - 100;

    // .shp 头
    sv.setInt32(0, 9994, false);                 // 文件码：大端
    sv.setInt32(24, 1000, false);                // 文件长度（16 位字）：100 头 + 内容
    sv.setInt32(28, 1000, true);                 // 版本：小端
    sv.setInt32(32, shapeType, true);            // shapeType
    sv.setFloat64(36, bbox[0], true);
    sv.setFloat64(44, bbox[1], true);
    sv.setFloat64(52, bbox[2], true);
    sv.setFloat64(60, bbox[3], true);
    sv.setFloat64(68, 0, true);                  // Zmin
    sv.setFloat64(76, 0, true);                  // Zmax
    sv.setFloat64(84, 0, true);                  // Mmin
    sv.setFloat64(92, 0, true);                  // Mmax

    // .shx 头
    xv.setInt32(0, 9994, false);
    xv.setInt32(24, (100 + shxBodyLen) / 2, false);
    xv.setInt32(28, 1000, true);
    xv.setInt32(32, shapeType, true);
    xv.setFloat64(36, bbox[0], true);
    xv.setFloat64(44, bbox[1], true);
    xv.setFloat64(52, bbox[2], true);
    xv.setFloat64(60, bbox[3], true);
    xv.setFloat64(68, 0, true);
    xv.setFloat64(76, 0, true);
    xv.setFloat64(84, 0, true);
    xv.setFloat64(92, 0, true);

    let total = 100;
    shpEntries.forEach(function (e) { total += e.header.length + e.content.length; });
    const shp = new Uint8Array(total);
    shp.set(shpHeader, 0);
    let p = 100;
    shpEntries.forEach(function (e) {
      shp.set(e.header, p); p += e.header.length;
      shp.set(e.content, p); p += e.content.length;
    });

    let xtotal = 100 + shxEntries.length * 8;
    const shx = new Uint8Array(xtotal);
    shx.set(shxHeader, 0);
    p = 100;
    shxEntries.forEach(function (e) { shx.set(e, p); p += 8; });

    return { shp: shp, shx: shx };
  }

  /* --- DBF --- */

  /**
   * 写 .dbf。属性值按 UTF-8 编码（配套 .cpg 声明 UTF-8）。
   */
  function buildDbfBytes(features, fields) {
    const list = normalizeFeatures(features);
    const flds = sanitizeFieldNames(fields && fields.length ? fields : inferFields(list));
    const enc = new TextEncoder();

    // 记录长度 = 1（删除标记）+ 各字段宽度
    let recordLength = 1;
    flds.forEach(function (f) { recordLength += f.length; });
    const headerLength = 32 + flds.length * 32 + 1;

    const body = [];
    list.forEach(function (f) {
      const row = new Uint8Array(recordLength);
      row[0] = 0x20;   // 未删除
      let p = 1;
      const props = f.properties || {};
      flds.forEach(function (fd) {
        const raw = props[fd.name];
        const cell = dbfCell(fd, raw, enc);
        row.set(cell, p);
        p += fd.length;
      });
      body.push(row);
    });

    const total = headerLength + body.reduce(function (a, b) { return a + b.length; }, 0) + 1;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out[0] = DBF_VERSION;
    out[1] = 120;                                  // 最近一次更新的年（1992-2020 用 0..119 偏移）
    out[2] = 7;                                    // 月
    out[3] = 13;                                   // 日
    dv.setUint32(4, list.length, true);            // 记录数
    dv.setUint16(8, headerLength, true);
    dv.setUint16(10, recordLength, true);
    dv.setUint16(12, 0, true);                     // 保留
    // 事务标志未置位（不写 .dbt）

    let p = 32;
    flds.forEach(function (f) {
      const nameBytes = enc.encode(f.name.slice(0, DBF_MAX_NAME));
      for (let i = 0; i < 11; i++) {
        out[p + i] = i < nameBytes.length ? nameBytes[i] : 0;
      }
      out[p + 11] = f.type.charCodeAt(0);
      out[p + 12] = 0;                             // 字段地址
      out[p + 13] = 0;                             // 字段长度（高位）
      out[p + 14] = 0;                             // 小数位（高位）
      out[p + 15] = 0;
      out[p + 16] = f.length;
      out[p + 17] = f.dec;
      // p+18..p+31 保留
      p += 32;
    });
    out[p] = 0x0d;                                 // 字段描述结束符
    p++;

    body.forEach(function (row) {
      out.set(row, p);
      p += row.length;
    });
    out[p] = 0x1a;                                 // 文件结束符
    return out;
  }

  /** 单个 DBF 字段的值（定长字节）。 */
  function dbfCell(field, raw, enc) {
    const cell = new Uint8Array(field.length);
    if (raw === null || raw === undefined) {
      cell.fill(0x20);       // 空 = 空格
      return cell;
    }
    if (field.type === 'N') {
      let s;
      if (typeof raw === 'number') {
        s = field.dec > 0 ? raw.toFixed(field.dec) : String(Math.round(raw));
      } else {
        const n = parseFloat(raw);
        s = isFinite(n) ? (field.dec > 0 ? n.toFixed(field.dec) : String(Math.round(n))) : '';
      }
      const bytes = enc.encode(s);
      const take = Math.min(bytes.length, field.length);
      // 右对齐（数值字段）
      for (let i = 0; i < take; i++) cell[field.length - take + i] = bytes[i];
      for (let i = 0; i < field.length - take; i++) cell[i] = 0x20;
      return cell;
    }
    if (field.type === 'L') {
      const v = raw === true || raw === 'T' || raw === 't' || raw === 'Y' || raw === 'y' || raw === 1;
      cell[0] = v ? 0x54 /* 'T' */ : 0x46 /* 'F' */;
      for (let i = 1; i < field.length; i++) cell[i] = 0x20;
      return cell;
    }
    if (field.type === 'D') {
      const s = String(raw).replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
      const bytes = enc.encode(s);
      for (let i = 0; i < field.length; i++) cell[i] = i < bytes.length ? bytes[i] : 0x20;
      return cell;
    }
    // C：文本，左对齐，尾部空格
    // 注意：截断必须**按字节**且不能切在多字节字符中间 ——
    // DBF 的字段宽度是字节数，宽度算的是 UTF-8 编码后的长度。
    let s = String(raw);
    let b2 = enc.encode(s);
    if (b2.length > field.length) {
      // 逐个码点回退，直到编码后不超长
      let cut = s.length;
      while (cut > 0) {
        const cp = s.codePointAt(cut - 1);
        const step = cp > 0xffff ? 2 : 1;
        cut -= step;
        b2 = enc.encode(s.slice(0, cut));
        if (b2.length <= field.length) break;
      }
      s = s.slice(0, cut);
      b2 = enc.encode(s);
    }
    const take2 = Math.min(b2.length, field.length);
    for (let i = 0; i < take2; i++) cell[i] = b2[i];
    for (let i = take2; i < field.length; i++) cell[i] = 0x20;
    return cell;
  }

  /**
   * 构造完整的 Shapefile 部件集合。
   * @param {Array} features
   * @param {Object} opts { baseName, crsWkt（.prj 内容）, fields }
   * @returns {{ files: [{name, data}], shp, shx, dbf, prj, cpg, shapeType, count, bbox }}
   */
  function buildShapefile(features, opts) {
    const o = opts || {};
    const list = normalizeFeatures(features);
    if (!list.length) throw new Error('没有要素可写出');

    const shapeType = detectShapeType(list);
    const rec = toShpRecords(list, shapeType);
    const records = rec.records;
    if (!records.length) throw new Error('没有可写出的几何（要素类型与文件类型不匹配）');

    // 全局 bbox
    let bbox = [Infinity, Infinity, -Infinity, -Infinity];
    records.forEach(function (r) {
      bbox[0] = Math.min(bbox[0], r.bbox[0]);
      bbox[1] = Math.min(bbox[1], r.bbox[1]);
      bbox[2] = Math.max(bbox[2], r.bbox[2]);
      bbox[3] = Math.max(bbox[3], r.bbox[3]);
    });
    if (!isFinite(bbox[0])) bbox = [0, 0, 0, 0];

    const bytes = buildShpBytes(records, shapeType, bbox);
    const fields = o.fields && o.fields.length ? o.fields : inferFields(list);
    const dbf = buildDbfBytes(list, fields);
    const prj = o.crsWkt ? String(o.crsWkt) : WGS84_WKT;
    const base = o.baseName || 'export';

    const enc = new TextEncoder();
    const files = [
      { name: base + '.shp', data: bytes.shp },
      { name: base + '.shx', data: bytes.shx },
      { name: base + '.dbf', data: dbf },
      { name: base + '.prj', data: enc.encode(prj) },
      { name: base + '.cpg', data: enc.encode('UTF-8') },
    ];

    return {
      files: files,
      shp: bytes.shp,
      shx: bytes.shx,
      dbf: dbf,
      prj: prj,
      cpg: 'UTF-8',
      shapeType: shapeType,
      count: records.length,
      skipped: rec.skipped,
      bbox: bbox,
    };
  }

  /* ================================================================
   * ⑦ GPKG
   * ================================================================ */

  /** 坐标 → GP 二进制几何（WKB 部分）。 */
  function wkbGeometry(f) {
    const t = f.type;
    const writePoint = function (c) {
      const b = new Uint8Array(16);
      const dv = new DataView(b.buffer);
      dv.setFloat64(0, c[0], true);
      dv.setFloat64(8, c[1], true);
      return b;
    };
    const writePoints = function (pts) {
      const b = new Uint8Array(4 + pts.length * 16);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, pts.length, true);
      pts.forEach(function (c, i) {
        dv.setFloat64(4 + i * 16, c[0], true);
        dv.setFloat64(12 + i * 16, c[1], true);
      });
      return b;
    };
    const writeLine = function (pts) {
      const head = new Uint8Array(5);
      const hv = new DataView(head.buffer);
      hv.setUint8(0, 1);                    // 小端
      hv.setUint32(1, WKB_LINESTRING, true);
      return concat([head, writePoints(pts)]);
    };
    const writePoly = function (rings) {
      const head = new Uint8Array(9);
      const hv = new DataView(head.buffer);
      hv.setUint8(0, 1);
      hv.setUint32(1, WKB_POLYGON, true);
      hv.setUint32(5, rings.length, true);
      const parts = [head];
      rings.forEach(function (ring) { parts.push(writePoints(ring)); });
      return concat(parts);
    };

    if (t === 'point') {
      const head = new Uint8Array(5);
      const hv = new DataView(head.buffer);
      hv.setUint8(0, 1);
      hv.setUint32(1, WKB_POINT, true);
      return concat([head, writePoint(f.coords[0])]);
    }
    if (t === 'multipoint') {
      const head = new Uint8Array(5);
      const hv = new DataView(head.buffer);
      hv.setUint8(0, 1);
      hv.setUint32(1, WKB_MULTIPOINT, true);
      const n = new Uint8Array(4);
      new DataView(n.buffer).setUint32(0, f.coords.length, true);
      const parts = [head, n];
      // 每个成员都是**完整的 Point WKB**（自带 5 字节头），不是裸的 16 字节坐标。
      f.coords.forEach(function (c) {
        const ph = new Uint8Array(5);
        const phv = new DataView(ph.buffer);
        phv.setUint8(0, 1);
        phv.setUint32(1, WKB_POINT, true);
        parts.push(concat([ph, writePoint(c)]));
      });
      return concat(parts);
    }
    if (t === 'line') {
      return writeLine(f.coords[0]);
    }
    if (t === 'multiline') {
      const head = new Uint8Array(5);
      const hv = new DataView(head.buffer);
      hv.setUint8(0, 1);
      hv.setUint32(1, WKB_MULTILINESTRING, true);
      const n = new Uint8Array(4);
      new DataView(n.buffer).setUint32(0, f.coords.length, true);
      const parts = [head, n];
      f.coords.forEach(function (line) { parts.push(writeLine(line)); });
      return concat(parts);
    }
    if (t === 'polygon') {
      return writePoly(f.rings);
    }
    if (t === 'multipolygon') {
      const head = new Uint8Array(5);
      const hv = new DataView(head.buffer);
      hv.setUint8(0, 1);
      hv.setUint32(1, WKB_MULTIPOLYGON, true);
      const n = new Uint8Array(4);
      const polys = polysOf(f);
      new DataView(n.buffer).setUint32(0, polys.length, true);
      const parts = [head, n];
      polys.forEach(function (poly) { parts.push(writePoly(poly)); });
      return concat(parts);
    }
    return null;
  }

  /** GP 头 + WKB。 */
  function gpkgBlob(f, srsId) {
    const wkb = wkbGeometry(f);
    if (!wkb) return null;
    const head = new Uint8Array(8);
    const hv = new DataView(head.buffer);
    head[0] = 0x47;  // 'G'
    head[1] = 0x50;  // 'P'
    head[2] = 0;     // version
    // flags: bit0 = byteOrder(1=小端), bit1..3 = envelope indicator(0=无)
    head[3] = 0x01;
    hv.setInt32(4, srsId, true);
    return concat([head, wkb]);
  }

  function concat(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let p = 0;
    for (const a of arrays) { out.set(a, p); p += a.length; }
    return out;
  }

  /** GPKG 的几何类型名（写进 gpkg_geometry_columns）。 */
  function gpkgGeomTypeName(f) {
    const map = {
      point: 'POINT',
      multipoint: 'MULTIPOINT',
      line: 'LINESTRING',
      multiline: 'MULTILINESTRING',
      polygon: 'POLYGON',
      multipolygon: 'MULTIPOLYGON',
    };
    return map[f.type] || 'GEOMETRY';
  }

  /**
   * 构造 GPKG 字节流。
   * @param {Array} features
   * @param {Object} opts { tableName, srsId, srsWkt, fields }
   * @param {Object} SQL sql.js 的 SQL 对象（initSqlJs 的返回值）
   */
  function buildGpkg(features, SQL, opts) {
    const o = opts || {};
    const list = normalizeFeatures(features);
    if (!list.length) throw new Error('没有要素可写出');
    if (!SQL || typeof SQL.Database !== 'function') {
      throw new Error('SQLite 引擎未加载（vendor/sqljs/sql-wasm.js）');
    }
    const db = new SQL.Database();
    const table = sanitizeTableName(o.tableName || 'features');
    const srsId = o.srsId == null ? 4326 : o.srsId;
    const srsWkt = o.srsWkt || WGS84_WKT;
    const geomType = o.geometryTypeName || gpkgGeomTypeName(list[0]);

    try {
      db.run('PRAGMA application_id = ' + GPKG_APPLICATION_ID);
      db.run('PRAGMA user_version = ' + GPKG_USER_VERSION);

      /* --- 必需表 --- */
      db.run(
        'CREATE TABLE gpkg_spatial_ref_sys (' +
        'srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, ' +
        'organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, ' +
        'definition TEXT NOT NULL, description TEXT)'
      );
      db.run(
        'CREATE TABLE gpkg_contents (' +
        'table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, ' +
        'identifier TEXT UNIQUE, description TEXT DEFAULT "", ' +
        // 注意：SQLite **不允许**非常量 DEFAULT（strftime(...) 会被拒），
        // 所以 last_change 在插入时显式写当前时间（GDAL 是用触发器做的）。
        'last_change DATETIME NOT NULL, ' +
        'min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, ' +
        'CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))'
      );
      db.run(
        'CREATE TABLE gpkg_geometry_columns (' +
        'table_name TEXT NOT NULL, column_name TEXT NOT NULL, ' +
        'geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, ' +
        'z TINYINT NOT NULL, m TINYINT NOT NULL, ' +
        'CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), ' +
        'CONSTRAINT uk_gc_table_name UNIQUE (table_name), ' +
        'CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), ' +
        'CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))'
      );
      db.run('CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT, definition TEXT, scope TEXT)');

      // SRS
      db.run(
        'INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition) VALUES (?,?,?,?,?)',
        ['WGS 84 geodetic', 4326, 'EPSG', 4326, srsWkt]
      );
      db.run(
        'INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition) VALUES (?,?,?,?,?)',
        ['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined']
      );
      db.run(
        'INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition) VALUES (?,?,?,?,?)',
        ['Undefined geographic SRS', 0, 'NONE', 0, 'undefined']
      );
      if (srsId !== 4326) {
        db.run(
          'INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition) VALUES (?,?,?,?,?)',
          ['SRS ' + srsId, srsId, 'EPSG', srsId, srsWkt]
        );
      }

      /* --- 要素表 --- */
      const fields = sanitizeFieldNames(o.fields && o.fields.length ? o.fields : inferFields(list));
      const cols = ['fid INTEGER PRIMARY KEY AUTOINCREMENT', 'geom BLOB'];
      fields.forEach(function (f) {
        cols.push('"' + f.name.replace(/"/g, '""') + '" ' + (f.type === 'N' ? 'REAL' : 'TEXT'));
      });
      db.run('CREATE TABLE "' + table + '" (' + cols.join(', ') + ')');

      const bbox = [Infinity, Infinity, -Infinity, -Infinity];
      const insertCols = ['geom'].concat(fields.map(function (f) { return f.name; }));
      const stmt = db.prepare(
        'INSERT INTO "' + table + '" (' + insertCols.map(function (c) { return '"' + c.replace(/"/g, '""') + '"'; }).join(', ') +
        ') VALUES (' + insertCols.map(function () { return '?'; }).join(', ') + ')'
      );
      list.forEach(function (f) {
        const blob = gpkgBlob(f, srsId);
        if (!blob) return;
        const vals = [blob];
        fields.forEach(function (fd) {
          let v = (f.properties || {})[fd.name];
          if (v === null || v === undefined) v = fd.type === 'N' ? null : '';
          else if (fd.type === 'N') {
            const n = typeof v === 'number' ? v : parseFloat(v);
            v = isFinite(n) ? n : null;
          } else if (typeof v === 'boolean') {
            v = v ? 'T' : 'F';
          } else {
            v = String(v);
          }
          vals.push(v);
        });
        stmt.run(vals);
        // 更新 bbox
        eachCoord(f, function (c) {
          if (c[0] < bbox[0]) bbox[0] = c[0];
          if (c[1] < bbox[1]) bbox[1] = c[1];
          if (c[0] > bbox[2]) bbox[2] = c[0];
          if (c[1] > bbox[3]) bbox[3] = c[1];
        });
      });
      stmt.free();
      if (!isFinite(bbox[0])) bbox = [0, 0, 0, 0];

      db.run(
        'INSERT INTO gpkg_contents (table_name, data_type, identifier, description, last_change, min_x, min_y, max_x, max_y, srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [table, 'features', table, '', new Date().toISOString(),
          bbox[0], bbox[1], bbox[2], bbox[3], srsId]
      );
      db.run(
        'INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?,?,?,?,?,?)',
        [table, 'geom', geomType, srsId, 0, 0]
      );

      const bytes = db.export();
      return {
        data: bytes,
        tableName: table,
        srsId: srsId,
        count: list.length,
        bbox: bbox,
        fields: fields,
      };
    } finally {
      db.close();
    }
  }

  function eachCoord(f, fn) {
    const t = f.type;
    if (t === 'point' || t === 'multipoint') {
      f.coords.forEach(fn);
    } else if (t === 'line' || t === 'multiline') {
      f.coords.forEach(function (line) { line.forEach(fn); });
    } else if (t === 'polygon' || t === 'multipolygon') {
      polysOf(f).forEach(function (poly) { poly.forEach(function (ring) { ring.forEach(fn); }); });
    }
  }

  function sanitizeTableName(name) {
    let s = String(name || 'features').replace(/[^\w一-龥]/g, '_');
    if (!s || /^\d/.test(s)) s = 't_' + s;
    return s.slice(0, 60);
  }

  /* ================================================================
   * ⑧ ZIP（把 Shapefile 的 5 个文件打成一个 .zip）
   * ================================================================ */

  let CRC_TABLE = null;

  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** ZIP（store，不压缩）——与 js/exporter.js 的实现一致。 */
  function zipStore(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
    const dosDate =
      (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : enc.encode(String(entry.data));
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint32(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);

      parts.push(local, data);
      central.push(cen);
      offset += local.length + data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
  }

  /* ================================================================
   * 导出
   * ================================================================ */

  return {
    // 几何
    normalizeFeatures: normalizeFeatures,
    normalizeFeature: normalizeFeature,
    polysOf: polysOf,
    detectGeometry: detectGeometry,
    detectShapeType: detectShapeType,
    hasMixedTypes: hasMixedTypes,
    groupByGeometryClass: groupByGeometryClass,
    inferFields: inferFields,
    sanitizeFieldNames: sanitizeFieldNames,
    toWkt: toWkt,
    // GeoJSON / CSV / KML
    buildGeoJson: buildGeoJson,
    buildCsv: buildCsv,
    buildKml: buildKml,
    // Shapefile
    buildShapefile: buildShapefile,
    buildDbfBytes: buildDbfBytes,
    // GPKG
    buildGpkg: buildGpkg,
    gpkgBlob: gpkgBlob,
    wkbGeometry: wkbGeometry,
    // ZIP
    zipStore: zipStore,
    crc32: crc32,
    // 常量
    WGS84_WKT: WGS84_WKT,
    wktForEpsg: wktForEpsg,
    GPKG_APPLICATION_ID: GPKG_APPLICATION_ID,
  };
});

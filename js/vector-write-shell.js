/*
 * 矢量格式写出 · 装载层（P3-4.14）
 * ---------------------------------------------------------------------------
 * 把「写出器」接进地球：
 *
 *   1. 收集要素：绘制要素（LEDraw）+ 导入的矢量图层（LE.listLayers）
 *   2. 可选重投影：把经纬度投到目标坐标系（LEProj.fromWgs84）
 *   3. 写出：Shapefile（ZIP）/ GPKG / GeoJSON / CSV / KML
 *   4. 落盘：浏览器直接下载，全程离线，不经过任何服务器
 *
 * 关键约束：Shapefile 一个文件只能装一种几何类型。
 * 混装时按「占多数」的那一类定 shapeType，少数派会被跳过并在结果里报告，
 * 不静默丢弃。
 *
 * 对外 API：window.LEVectorWriteShell
 *   sources() / collectFeatures(opts) / export(opts) / getState()
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const VW = window.LEVectorWrite;

  const state = {
    le: null,
    features: [],
    lastResult: null,
    listeners: [],
    listenersBound: false,
  };

  function getLE() { return state.le || window.LE; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3600);
  }
  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  function emit(kind, payload) {
    state.listeners.forEach(function (fn) {
      try { fn(kind, payload); } catch (err) { console.error(err); }
    });
  }

  function init(le) {
    state.le = le || window.LE;
    if (state.listenersBound) return;
    state.listenersBound = true;
  }
  function on(fn) {
    if (typeof fn === 'function') state.listeners.push(fn);
    return fn;
  }
  function off(fn) {
    const i = state.listeners.indexOf(fn);
    if (i >= 0) state.listeners.splice(i, 1);
  }

  /* ------------------------------------------------------------------ *
   * ① 数据源
   * ------------------------------------------------------------------ */

  function vectorLayers() {
    const le = getLE();
    if (!le || typeof le.listLayers !== 'function') return [];
    return (le.listLayers() || []).filter(function (l) { return l.type === 'vector'; });
  }

  /** 可写出的数据源清单。 */
  function sources() {
    const out = [{ id: '__all__', name: '全部要素', kind: 'all' }];
    if (window.LEDraw && typeof window.LEDraw.list === 'function') {
      window.LEDraw.list().forEach(function (f) {
        out.push({ id: 'draw:' + f.id, name: '绘制 · ' + f.name, kind: 'draw', featureId: f.id });
      });
    }
    vectorLayers().forEach(function (l) {
      out.push({ id: 'layer:' + l.id, name: '图层 · ' + l.name, kind: 'layer', layerId: l.id });
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * ② 收集要素（统一成内核的 feature 模型）
   * ------------------------------------------------------------------ */

  /** Cesium 实体 → { type, coords|rings, properties }。 */
  function entityToFeature(ent) {
    const now = C.JulianDate.now();
    const unwrap = function (v) {
      if (v == null) return null;
      if (typeof v.getValue === 'function') {
        try { return v.getValue(now); } catch (_) { return null; }
      }
      return v;
    };
    const toLonLat = function (p) {
      if (!p) return null;
      const cc = C.Cartographic.fromCartesian(p);
      if (!cc) return null;
      return [C.Math.toDegrees(cc.longitude), C.Math.toDegrees(cc.latitude)];
    };

    const props = {};
    if (ent && ent.properties) {
      try {
        const bag = ent.properties.getValue(now);
        if (bag) {
          for (const k of Object.keys(bag)) {
            let v = bag[k];
            if (v && typeof v.getValue === 'function') v = v.getValue(now);
            props[k] = v;
          }
        }
      } catch (_) { /* ignore */ }
    }

    const pos = unwrap(ent.position);
    if (pos) {
      const ll = toLonLat(pos);
      if (ll) return { type: 'point', coords: [ll], properties: props };
    }
    const polyline = unwrap(ent.polyline);
    const linePositions = polyline && unwrap(polyline.positions);
    if (Array.isArray(linePositions)) {
      const pts = linePositions.map(toLonLat).filter(Boolean);
      if (pts.length >= 2) return { type: 'line', coords: [pts], properties: props };
    }
    const polygon = unwrap(ent.polygon);
    if (polygon) {
      const hier = unwrap(polygon.hierarchy);
      const arr = (hier && hier.positions) || polygon.positions || [];
      const pts = arr.map(toLonLat).filter(Boolean);
      if (pts.length >= 3) {
        // 内环（洞）：Cesium 的 PolygonHierarchy 用 holes 表达
        const holes = [];
        if (hier && hier.holes) {
          hier.holes.forEach(function (h) {
            const hp = (h.positions || []).map(toLonLat).filter(Boolean);
            if (hp.length >= 3) holes.push(hp);
          });
        }
        const rings = [pts].concat(holes);
        return { type: 'polygon', rings: rings, properties: props };
      }
    }
    return null;
  }

  /** 绘制要素 → 内核 feature。 */
  function drawToFeature(f) {
    const pts = (f.points || []).map(function (p) { return [p.lon, p.lat]; });
    const props = { name: f.name, type: f.type };
    if (f.type === 'point') {
      if (!pts.length) return null;
      return { type: 'point', coords: [pts[0]], properties: props };
    }
    if (f.type === 'line') {
      if (pts.length < 2) return null;
      return { type: 'line', coords: [pts], properties: props };
    }
    if (f.type === 'polygon') {
      if (pts.length < 3) return null;
      return { type: 'polygon', rings: [pts], properties: props };
    }
    return null;
  }

  /**
   * 收集可写出的要素。
   * @param {Object} opts { sourceId }
   * @returns {Array} 内核 feature 数组
   */
  function collectFeatures(opts) {
    const o = opts || {};
    const sourceId = o.sourceId || '__all__';
    const out = [];

    if ((sourceId === '__all__' || sourceId.indexOf('draw:') === 0) &&
        window.LEDraw && typeof window.LEDraw.getFeatures === 'function') {
      const wantId = sourceId.indexOf('draw:') === 0 ? sourceId.slice(5) : null;
      window.LEDraw.getFeatures().forEach(function (f) {
        if (wantId && f.id !== wantId) return;
        const ff = drawToFeature(f);
        if (ff) out.push(ff);
      });
    }

    if (sourceId === '__all__' || sourceId.indexOf('layer:') === 0) {
      const wantLayerId = sourceId.indexOf('layer:') === 0 ? sourceId.slice(6) : null;
      vectorLayers().forEach(function (l) {
        if (wantLayerId && l.id !== wantLayerId) return;
        const ds = l.datasource;
        if (!ds || !ds.entities || !ds.entities.values) return;
        for (const ent of ds.entities.values) {
          const ff = entityToFeature(ent);
          if (ff) {
            if (!ff.properties || !Object.keys(ff.properties).length) {
              ff.properties = { name: ent.name || '' };
            }
            out.push(ff);
          }
        }
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * ③ 重投影
   * ------------------------------------------------------------------ */

  /**
   * 把 WGS84 经纬度投到目标坐标系。
   * @param {Array} features 内核 feature 数组
   * @param {string} crsDef EPSG 码或 proj4/WKT 串
   * @returns {{ features: Array, ok: boolean, failed: number, error: string }}
   */
  function reproject(features, crsDef) {
    const crs = window.LEProj ? window.LEProj.parse(String(crsDef)) : null;
    if (!crs || !crs.ok) {
      return { features: features, ok: false, failed: 0, error: '坐标系无法识别：' + (crsDef || '(空)') };
    }
    if (crs.geographic) {
      // 目标也是经纬度系，直接按 4326 处理
      return { features: features, ok: true, failed: 0, error: '', crs: crs, is4326: true };
    }
    let failed = 0;
    const mapPoint = function (c) {
      const r = window.LEProj.fromWgs84(crs, c[0], c[1]);
      if (!r) { failed++; return null; }
      return r;
    };
    const out = features.map(function (f) {
      const g = Object.assign({}, f);
      if (f.type === 'point' || f.type === 'multipoint') {
        g.coords = f.coords.map(function (c) { return mapPoint(c); }).filter(Boolean);
        if (!g.coords.length) return null;
      } else if (f.type === 'line' || f.type === 'multiline') {
        g.coords = f.coords.map(function (line) {
          return line.map(function (c) { return mapPoint(c); }).filter(Boolean);
        }).filter(function (line) { return line.length >= 2; });
        if (!g.coords.length) return null;
      } else if (f.type === 'polygon' || f.type === 'multipolygon') {
        const polys = VW.polysOf(f);
        const newPolys = [];
        polys.forEach(function (poly) {
          const rings = poly.map(function (ring) {
            return ring.map(function (c) { return mapPoint(c); }).filter(Boolean);
          }).filter(function (ring) { return ring.length >= 3; });
          if (rings.length) newPolys.push(rings);
        });
        if (!newPolys.length) return null;
        g.rings = f.type === 'polygon' ? newPolys[0] : newPolys;
      }
      return g;
    }).filter(Boolean);
    return { features: out, ok: true, failed: failed, error: '', crs: crs };
  }

  /* ------------------------------------------------------------------ *
   * ④ 写出
   * ------------------------------------------------------------------ */

  const FORMATS = [
    { id: 'shapefile', label: 'Shapefile（.zip）', ext: 'zip', needsZip: true },
    { id: 'gpkg', label: 'GeoPackage（.gpkg）', ext: 'gpkg', needsZip: false },
    { id: 'geojson', label: 'GeoJSON（.geojson）', ext: 'geojson', needsZip: false },
    { id: 'csv', label: 'CSV（属性表 + WKT）', ext: 'csv', needsZip: false },
    { id: 'kml', label: 'KML（.kml）', ext: 'kml', needsZip: false },
  ];

  /** 可选的目标坐标系。 */
  const CRS_OPTIONS = [
    { value: '', label: 'WGS84 经纬度（EPSG:4326）' },
    { value: 'EPSG:3857', label: 'Web 墨卡托（EPSG:3857）' },
    { value: 'EPSG:4490', label: 'CGCS2000 地理（EPSG:4490）' },
    { value: 'EPSG:4548', label: 'CGCS2000 3° 带 40 带（EPSG:4548）' },
    { value: 'EPSG:4547', label: 'CGCS2000 3° 带 39 带（EPSG:4547）' },
  ];

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  /**
   * 取 sql.js 的 SQL 对象（懒加载）。
   * vendor/sqljs/sql-wasm.js 只是把 initSqlJs 挂到 window 上，
   * 真正可用的 SQL 对象要 await initSqlJs() 才有。
   */
  let sqlPromise = null;
  function loadSqlJs() {
    if (sqlPromise) return sqlPromise;
    sqlPromise = new Promise(function (resolve, reject) {
      if (!window.initSqlJs) {
        reject(new Error('SQLite 引擎未加载（vendor/sqljs/sql-wasm.js）'));
        return;
      }
      window.initSqlJs({
        locateFile: function (file) { return 'vendor/sqljs/' + file; },
      }).then(resolve, reject);
    });
    sqlPromise.catch(function () { sqlPromise = null; });
    return sqlPromise;
  }

  function downloadBytes(name, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return blob.size;
  }

  function downloadText(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return blob.size;
  }

  /**
   * 执行写出并下载。
   * @param {Object} opts { sourceId, format, crs, baseName, tableName, download }
   * @returns {Promise<Object>} { ok, format, count, bytes, fileName, skipped, warnings }
   */
  async function exportVector(opts) {
    const o = opts || {};
    const format = o.format || 'geojson';
    const doDownload = o.download !== false;
    const warnings = [];

    let features = collectFeatures({ sourceId: o.sourceId });
    if (!features.length) {
      return { ok: false, error: '没有可写出的要素', format: format, count: 0 };
    }

    // --- 重投影 ---
    let crsInfo = null;
    if (o.crs) {
      const rp = reproject(features, o.crs);
      if (!rp.ok) {
        return { ok: false, error: rp.error, format: format, count: 0 };
      }
      features = rp.features;
      crsInfo = rp.crs;
      if (rp.failed) warnings.push(rp.failed + ' 个坐标投影失败，已丢弃');
      if (rp.is4326) warnings.push('目标坐标系是地理坐标系，坐标未变化');
    }

    // 目标坐标系的 WKT（写 .prj 与 GPKG 的 srs 定义）
    const epsg = crsInfo && crsInfo.code ? crsInfo.code : (o.crs ? parseInt(String(o.crs).replace(/^epsg:/i, ''), 10) : 4326);
    const crsWkt = VW.wktForEpsg(epsg) || VW.WGS84_WKT;

    const base = (o.baseName || 'local-earth-export').replace(/[\\/:*?"<>|]/g, '_');
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();

    try {
      if (format === 'shapefile') {
        const shp = VW.buildShapefile(features, {
          baseName: base,
          crsWkt: crsWkt,
        });
        const zip = VW.zipStore(shp.files);
        const fileName = base + '.zip';
        const bytes = doDownload ? downloadBytes(fileName, zip, 'application/zip') : zip.length;
        if (shp.skipped && shp.skipped.length) {
          warnings.push(shp.skipped.length + ' 个要素因几何类型不匹配被跳过（Shapefile 一个文件只能装一种几何类型）');
        }
        const r = {
          ok: true, format: format, count: shp.count, bytes: bytes, fileName: fileName,
          skipped: shp.skipped || [], warnings: warnings,
          bbox: shp.bbox, shapeType: shp.shapeType,
          ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0,
        };
        state.lastResult = r;
        emit('export', r);
        return r;
      }

      if (format === 'gpkg') {
        const SQL = await loadSqlJs();
        if (!SQL || typeof SQL.Database !== 'function') {
          return { ok: false, error: 'SQLite 引擎未加载（vendor/sqljs/sql-wasm.js）', format: format, count: 0 };
        }
        const g = VW.buildGpkg(features, SQL, {
          tableName: o.tableName || 'features',
          srsId: epsg || 4326,
          srsWkt: crsWkt,
        });
        const fileName = base + '.gpkg';
        const bytes = doDownload ? downloadBytes(fileName, g.data, 'application/geopackage+sqlite3') : g.data.length;
        const r = {
          ok: true, format: format, count: g.count, bytes: bytes, fileName: fileName,
          skipped: [], warnings: warnings, bbox: g.bbox, tableName: g.tableName,
          ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0,
        };
        state.lastResult = r;
        emit('export', r);
        return r;
      }

      if (format === 'geojson') {
        const fc = VW.buildGeoJson(features, { crs: o.crs || null });
        const text = JSON.stringify(fc, null, 2);
        const fileName = base + '.geojson';
        const bytes = doDownload
          ? downloadText(fileName, text, 'application/geo+json;charset=utf-8') : text.length;
        const r = {
          ok: true, format: format, count: fc.features.length, bytes: bytes, fileName: fileName,
          skipped: [], warnings: warnings,
          ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0,
        };
        state.lastResult = r;
        emit('export', r);
        return r;
      }

      if (format === 'csv') {
        const text = VW.buildCsv(features, { bom: true });
        const fileName = base + '.csv';
        const bytes = doDownload ? downloadText(fileName, text, 'text/csv;charset=utf-8') : text.length;
        const r = {
          ok: true, format: format, count: features.length, bytes: bytes, fileName: fileName,
          skipped: [], warnings: warnings,
          ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0,
        };
        state.lastResult = r;
        emit('export', r);
        return r;
      }

      if (format === 'kml') {
        const text = VW.buildKml(features, { name: base });
        const fileName = base + '.kml';
        const bytes = doDownload ? downloadText(fileName, text, 'application/vnd.google-earth.kml+xml') : text.length;
        const r = {
          ok: true, format: format, count: features.length, bytes: bytes, fileName: fileName,
          skipped: [], warnings: warnings,
          ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0,
        };
        state.lastResult = r;
        emit('export', r);
        return r;
      }

      return { ok: false, error: '未知格式：' + format, format: format, count: 0 };
    } catch (err) {
      console.error('[LEVectorWriteShell] 写出失败', err);
      return { ok: false, error: (err && err.message) || String(err), format: format, count: 0 };
    }
  }

  /** 预检：只统计，不写文件。 */
  function preview(opts) {
    const o = opts || {};
    const features = collectFeatures({ sourceId: o.sourceId });
    const geom = VW.detectGeometry(features);
    const fields = VW.sanitizeFieldNames(VW.inferFields(features));
    return {
      count: features.length,
      geometry: geom,
      mixed: VW.hasMixedTypes(features),
      shapeType: features.length ? VW.detectShapeType(features) : null,
      fields: fields,
      groups: VW.groupByGeometryClass(features).map(function (g) {
        return { kind: g.kind, count: g.features.length };
      }),
    };
  }

  function getState() {
    return {
      featureCount: state.features.length,
      sourceCount: sources().length,
      lastResult: state.lastResult,
    };
  }

  window.LEVectorWriteShell = {
    init: init,
    on: on,
    off: off,
    sources: sources,
    vectorLayers: vectorLayers,
    collectFeatures: collectFeatures,
    reproject: reproject,
    exportVector: exportVector,
    preview: preview,
    getState: getState,
    FORMATS: FORMATS,
    CRS_OPTIONS: CRS_OPTIONS,
  };
})();

/*
 * 空间索引与空间查询 · 装载层（P2-4.12）
 * ---------------------------------------------------------------------------
 * 把"在圆内 / 多边形内选要素"这件事在地球上跑起来：
 *
 *   1. 收集要素：绘制要素（LEDraw）+ 导入的矢量图层（LE.listLayers）
 *   2. 建索引：交给纯内核 js/spatial-index.js 的均匀网格
 *   3. 查询：圆 / 多边形 × 相交 / 包含 / 中心点在内
 *   4. 高亮：命中的要素在地球上标黄
 *   5. 导出：结果为 GeoJSON / CSV
 *
 * 对外 API：window.LESpatialShell
 *   collectFeatures(opts)   取要素（opts.layer = 只取某图层；opts.source）
 *   buildIndex(opts)        建索引并缓存
 *   query(opts)             执行空间查询
 *   highlight(features)     高亮
 *   clearHighlight()        取消高亮
 *   exportResults(fmt)      导出
 *   getState()
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const SI = window.LESpatialIndex;

  const state = {
    le: null,
    features: [],
    index: null,
    results: [],
    lastRegion: null,
    lastMode: 'intersects',
    highlightEntities: [],
    listeners: [],
    listenersBound: false,
    queryCount: 0,
    lastMs: 0,
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
   * ① 收集要素
   * ------------------------------------------------------------------ */

  /** 列出可查询的矢量图层。 */
  function vectorLayers() {
    const le = getLE();
    if (!le || typeof le.listLayers !== 'function') return [];
    return (le.listLayers() || []).filter(function (l) { return l.type === 'vector'; });
  }

  /** 可查询的数据源清单（供界面下拉框用）。 */
  function sources() {
    const out = [{ id: '__all__', name: '全部要素', kind: 'all' }];
    if (window.LEDraw && typeof window.LEDraw.list === 'function') {
      const list = window.LEDraw.list();
      list.forEach(function (f) {
        out.push({ id: 'draw:' + f.id, name: '绘制 · ' + f.name, kind: 'draw', featureId: f.id });
      });
    }
    vectorLayers().forEach(function (l) {
      out.push({ id: 'layer:' + l.id, name: '图层 · ' + l.name, kind: 'layer', layerId: l.id });
    });
    return out;
  }

  /** 实体 → 经纬点数组。 */
  function entityPoints(ent) {
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
      return {
        lon: C.Math.toDegrees(cc.longitude),
        lat: C.Math.toDegrees(cc.latitude),
        height: cc.height,
      };
    };

    const pos = unwrap(ent.position);
    if (pos) {
      const ll = toLonLat(pos);
      return ll ? { type: 'point', points: [ll] } : null;
    }
    const polyline = unwrap(ent.polyline);
    const linePositions = polyline && unwrap(polyline.positions);
    if (Array.isArray(linePositions)) {
      const pts = linePositions.map(toLonLat).filter(Boolean);
      if (pts.length) return { type: 'line', points: pts };
    }
    const polygon = unwrap(ent.polygon);
    if (polygon) {
      const hier = unwrap(polygon.hierarchy);
      const arr = (hier && hier.positions) || polygon.positions || [];
      const pts = arr.map(toLonLat).filter(Boolean);
      if (pts.length) return { type: 'polygon', points: pts };
    }
    return null;
  }

  /** 实体 → 属性字典。 */
  function entityProps(ent) {
    const props = {};
    if (!ent || !ent.properties) return props;
    const now = C.JulianDate.now();
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
    return props;
  }

  /**
   * 收集可查询的要素。
   * @param {Object} opts
   *   opts.sourceId —— '全部要素' / 'draw:<id>' / 'layer:<id>'
   * @returns {Array} 归一化要素
   */
  function collectFeatures(opts) {
    const o = opts || {};
    const sourceId = o.sourceId || '__all__';
    const out = [];

    // 绘制要素
    if ((sourceId === '__all__' || sourceId.indexOf('draw:') === 0) &&
        window.LEDraw && typeof window.LEDraw.getFeatures === 'function') {
      const all = window.LEDraw.getFeatures();
      const wantId = sourceId.indexOf('draw:') === 0 ? sourceId.slice(5) : null;
      all.forEach(function (f) {
        if (wantId && f.id !== wantId) return;
        out.push({
          id: 'draw:' + f.id,
          name: f.name,
          type: f.type,
          points: f.points.map(function (p) {
            return { lon: p.lon, lat: p.lat, height: p.height || 0 };
          }),
          props: { name: f.name, type: f.type },
          source: 'draw',
          sourceName: '绘制',
          entity: null,
        });
      });
    }

    // 矢量图层要素
    if (sourceId === '__all__' || sourceId.indexOf('layer:') === 0) {
      const wantLayerId = sourceId.indexOf('layer:') === 0 ? sourceId.slice(6) : null;
      vectorLayers().forEach(function (l) {
        if (wantLayerId && l.id !== wantLayerId) return;
        const ds = l.datasource;
        if (!ds || !ds.entities || !ds.entities.values) return;
        let n = 0;
        for (const ent of ds.entities.values) {
          const g = entityPoints(ent);
          if (!g) continue;
          n++;
          out.push({
            id: 'layer:' + (l.id || l.name || 'layer') + ':' + (ent.id || ('e' + n)),
            name: (ent.name || '') || (l.name + ' · 要素' + n),
            type: g.type,
            points: g.points,
            props: entityProps(ent),
            source: 'layer',
            sourceName: l.name || '图层',
            layerId: l.id,
            entity: ent,
          });
        }
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * ② 建索引
   * ------------------------------------------------------------------ */

  /**
   * 收集 + 建索引。
   * @param {Object} opts { sourceId, cell }
   */
  function buildIndex(opts) {
    const o = opts || {};
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const features = collectFeatures(o);
    const index = new SI.GridIndex(features, { cell: o.cell || 5 });
    state.features = features;
    state.index = index;
    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
    state.buildMs = t1 - t0;
    return { features: features, index: index, ms: state.buildMs };
  }

  /* ------------------------------------------------------------------ *
   * ③ 查询
   * ------------------------------------------------------------------ */

  /**
   * 执行空间查询。
   * @param {Object} opts
   *   opts.region   { kind:'circle', center:{lon,lat}, radiusM } | { kind:'polygon', ring:[{lon,lat}] }
   *   opts.mode     'intersects' | 'within' | 'center'
   *   opts.sourceId 数据源
   *   opts.useIndex 是否用索引（默认 true）
   *   opts.rebuild  是否重建索引
   */
  function query(opts) {
    const o = opts || {};
    if (!o.region) return { ok: false, error: '没有查询范围', results: [] };

    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    let index = null;
    if (o.rebuild !== false) {
      buildIndex({ sourceId: o.sourceId });
      index = state.index;
    } else if (o.useIndex !== false) {
      if (!state.index || state.indexSourceId !== (o.sourceId || '__all__')) {
        buildIndex({ sourceId: o.sourceId });
      }
      index = state.index;
    }

    const results = SI.selectByLocation(state.features, o.region, o.mode || 'intersects', index);
    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();

    state.results = results;
    state.lastRegion = o.region;
    state.lastMode = o.mode || 'intersects';
    state.lastMs = t1 - t0;
    state.queryCount++;
    state.indexSourceId = o.sourceId || '__all__';

    emit('query', { results: results, ms: state.lastMs });
    return {
      ok: true,
      results: results,
      count: results.length,
      total: state.features.length,
      ms: state.lastMs,
      buildMs: state.buildMs,
    };
  }

  /* ------------------------------------------------------------------ *
   * ④ 高亮
   * ------------------------------------------------------------------ */

  /** 清除高亮。 */
  function clearHighlight() {
    const le = getLE();
    if (le && le.viewer) {
      for (const e of state.highlightEntities) {
        try { le.viewer.entities.remove(e); } catch (err) { /* ignore */ }
      }
    }
    state.highlightEntities = [];
  }

  /**
   * 高亮命中的要素。
   * @param {Array} features
   */
  function highlight(features) {
    const le = getLE();
    if (!le || !le.viewer) return 0;
    clearHighlight();
    const color = C.Color.fromCssColorString('#ffd93b');
    const list = features || [];
    for (const f of list) {
      if (!f.points || !f.points.length) continue;
      const positions = f.points.map(function (p) {
        return C.Cartesian3.fromDegrees(p.lon, p.lat, 0);
      });
      try {
        if (f.type === 'point') {
          state.highlightEntities.push(le.viewer.entities.add({
            position: positions[0],
            point: {
              pixelSize: 12,
              color: color.withAlpha(0.95),
              outlineColor: C.Color.BLACK.withAlpha(0.9),
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
            },
            label: {
              text: f.name || '命中',
              font: '12px "Microsoft YaHei", sans-serif',
              fillColor: C.Color.WHITE,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new C.Cartesian2(0, -18),
              verticalOrigin: C.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              showBackground: true,
              backgroundColor: C.Color.fromCssColorString('rgba(0,0,0,0.6)'),
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
            },
          }));
        } else if (f.type === 'line') {
          state.highlightEntities.push(le.viewer.entities.add({
            polyline: {
              positions: positions,
              width: 5,
              material: color.withAlpha(0.95),
              clampToGround: true,
              depthFailMaterial: color.withAlpha(0.4),
            },
          }));
        } else {
          const ring = positions.slice();
          ring.push(ring[0]);
          state.highlightEntities.push(le.viewer.entities.add({
            polyline: {
              positions: ring,
              width: 4,
              material: color.withAlpha(0.95),
              clampToGround: true,
              depthFailMaterial: color.withAlpha(0.4),
            },
          }));
          state.highlightEntities.push(le.viewer.entities.add({
            polygon: {
              hierarchy: new C.PolygonHierarchy(positions),
              material: color.withAlpha(0.18),
              perPositionHeight: false,
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
            },
          }));
        }
      } catch (err) {
        /* ignore */
      }
    }
    return state.highlightEntities.length;
  }

  /* ------------------------------------------------------------------ *
   * ⑤ 导出
   * ------------------------------------------------------------------ */

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function resultsToGeoJson(features) {
    const list = features || [];
    const feats = list.map(function (f) {
      let geometry;
      if (f.type === 'point') {
        geometry = { type: 'Point', coordinates: [f.points[0].lon, f.points[0].lat] };
      } else if (f.type === 'line') {
        geometry = {
          type: 'LineString',
          coordinates: f.points.map(function (p) { return [p.lon, p.lat]; }),
        };
      } else {
        const ring = f.points.map(function (p) { return [p.lon, p.lat]; });
        if (ring.length && ring[0][0] !== ring[ring.length - 1][0]) ring.push(ring[0].slice());
        geometry = { type: 'Polygon', coordinates: [ring] };
      }
      const props = Object.assign({}, f.props || {}, {
        _name: f.name, _type: f.type, _source: f.sourceName || f.source,
      });
      return { type: 'Feature', properties: props, geometry: geometry };
    });
    return { type: 'FeatureCollection', features: feats };
  }

  /** 导出查询结果。fmt = 'geojson' | 'csv' */
  function exportResults(fmt, features) {
    const list = features || state.results;
    if (!list.length) {
      toast('没有可导出的结果', 'error');
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (fmt === 'geojson') {
      const gj = resultsToGeoJson(list);
      download('spatial-query-' + stamp + '.geojson', JSON.stringify(gj, null, 2),
        'application/geo+json');
    } else {
      const fields = [];
      const seen = {};
      list.forEach(function (f) {
        for (const k of Object.keys(f.props || {})) {
          if (!seen[k]) { seen[k] = 1; fields.push(k); }
        }
      });
      const esc = function (v) {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      let out = fields.join(',') + '\n';
      list.forEach(function (f) {
        out += fields.map(function (k) { return esc((f.props || {})[k]); }).join(',') + '\n';
      });
      download('spatial-query-' + stamp + '.csv', '﻿' + out, 'text/csv;charset=utf-8');
    }
    toast('已导出 ' + list.length + ' 个命中要素', 'ok', 2600);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 查询区域构造
   * ------------------------------------------------------------------ */

  /** 圆区域。 */
  function circleRegion(lon, lat, radiusKm) {
    return {
      kind: 'circle',
      center: { lon: Number(lon), lat: Number(lat) },
      radiusM: Number(radiusKm) * 1000,
    };
  }

  /**
   * 多边形区域。
   * 优先用绘制要素；没有就用经纬度串 "lon,lat;lon,lat"。
   */
  function polygonRegion(input) {
    if (!input) return null;
    if (typeof input === 'object' && input.points) {
      return { kind: 'polygon', ring: input.points.map(function (p) {
        return { lon: p.lon, lat: p.lat };
      }) };
    }
    if (typeof input === 'string') {
      const ring = [];
      for (const piece of input.split(';')) {
        const t = piece.trim();
        if (!t) continue;
        const parts = t.split(',');
        if (parts.length < 2) continue;
        const lon = Number(parts[0]);
        const lat = Number(parts[1]);
        if (!isFinite(lon) || !isFinite(lat)) continue;
        ring.push({ lon: lon, lat: lat });
      }
      if (ring.length < 3) return null;
      return { kind: 'polygon', ring: ring };
    }
    return null;
  }

  /** 当前状态。 */
  function getState() {
    return {
      featureCount: state.features.length,
      resultCount: state.results.length,
      total: state.features.length,
      queryCount: state.queryCount,
      lastMs: state.lastMs,
      buildMs: state.buildMs,
      hasIndex: !!state.index,
      indexStats: state.index ? state.index.stats() : null,
      lastRegion: state.lastRegion,
      lastMode: state.lastMode,
      highlightCount: state.highlightEntities.length,
    };
  }

  function init2(le) { init(le); }

  window.LESpatialShell = {
    init: init2,
    on: on,
    off: off,
    sources: sources,
    vectorLayers: vectorLayers,
    collectFeatures: collectFeatures,
    buildIndex: buildIndex,
    query: query,
    highlight: highlight,
    clearHighlight: clearHighlight,
    exportResults: exportResults,
    resultsToGeoJson: resultsToGeoJson,
    circleRegion: circleRegion,
    polygonRegion: polygonRegion,
    getState: getState,
    entityPoints: entityPoints,
    entityProps: entityProps,
  };
})();

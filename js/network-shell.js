/*
 * 网络分析 · 装载层（P3-4.16）
 * ---------------------------------------------------------------------------
 * 把「网络分析」在地球上跑起来：
 *
 *   1. 收集网络要素（绘制要素 + 导入的矢量图层里的线/面）
 *   2. 建图（打断交叉点、算边权、判断单行道）
 *   3. 最短路：地图上点起点与终点 → 算路径 → 画到地球上
 *   4. 服务区：点起点 + 给阈值 → 算可达范围 → 画成多边形
 *   5. 结果可另存为图层 / 导出 GeoJSON
 *
 * 对外 API：window.LENetworkShell
 *   sources() / collectFeatures(opts) / buildGraph(opts)
 *   shortestPath(opts) / serviceArea(opts)
 *   drawPath(result) / clearResults() / exportResult(result, kind)
 *   getState()
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const NW = window.LENetwork;

  const state = {
    le: null,
    graph: null,
    features: [],
    results: [],          // 画出来的东西（entity / datasource）
    listeners: [],
    listenersBound: false,
    lastPath: null,
    lastArea: null,
    buildMs: 0,
    buildCount: 0,
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
   * ① 收集网络要素
   * ------------------------------------------------------------------ */

  function vectorLayers() {
    const le = getLE();
    if (!le || typeof le.listLayers !== 'function') return [];
    return (le.listLayers() || []).filter(function (l) { return l.type === 'vector'; });
  }

  /** 可选的网络数据源清单。 */
  function sources() {
    const out = [
      { id: '__all__', name: '全部线要素', kind: 'all' },
      { id: '__draw__', name: '全部绘制线要素', kind: 'draw-all' },
    ];
    if (window.LEDraw && typeof window.LEDraw.list === 'function') {
      window.LEDraw.list().forEach(function (f) {
        if (f.type !== 'line' && f.type !== 'polygon') return;
        out.push({
          id: 'draw:' + f.id,
          name: '绘制 · ' + f.name,
          kind: 'draw',
          featureId: f.id,
          type: f.type,
        });
      });
    }
    vectorLayers().forEach(function (l) {
      out.push({
        id: 'layer:' + l.id,
        name: '图层 · ' + l.name,
        kind: 'layer',
        layerId: l.id,
      });
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
      return { lon: C.Math.toDegrees(cc.longitude), lat: C.Math.toDegrees(cc.latitude) };
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
      if (pts.length >= 2) return { type: 'line', points: pts };
    }
    const polygon = unwrap(ent.polygon);
    if (polygon) {
      const hier = unwrap(polygon.hierarchy);
      const arr = (hier && hier.positions) || polygon.positions || [];
      const pts = arr.map(toLonLat).filter(Boolean);
      if (pts.length >= 2) return { type: 'polygon', points: pts };
    }
    return null;
  }

  /** 实体 → 属性（用于识别 oneway 等字段）。 */
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
   * 收集可参与网络的要素。
   * @param {Object} opts { sourceId }
   */
  function collectFeatures(opts) {
    const o = opts || {};
    const sourceId = o.sourceId || '__all__';
    const out = [];

    if ((sourceId === '__all__' || sourceId === '__draw__' || sourceId.indexOf('draw:') === 0) &&
        window.LEDraw && typeof window.LEDraw.getFeatures === 'function') {
      const wantId = sourceId.indexOf('draw:') === 0 ? sourceId.slice(5) : null;
      window.LEDraw.getFeatures().forEach(function (f) {
        if (wantId && f.id !== wantId) return;
        if (!NW.isNetworkFeature(f)) return;
        out.push({
          id: 'draw:' + f.id,
          name: f.name,
          type: f.type,
          points: f.points.map(function (p) { return { lon: p.lon, lat: p.lat }; }),
          props: { name: f.name, type: f.type },
          source: 'draw',
          sourceName: '绘制',
        });
      });
    }

    if (sourceId === '__all__' || sourceId.indexOf('layer:') === 0) {      const wantLayerId = sourceId.indexOf('layer:') === 0 ? sourceId.slice(6) : null;
      vectorLayers().forEach(function (l) {
        if (wantLayerId && l.id !== wantLayerId) return;
        const ds = l.datasource;
        if (!ds || !ds.entities || !ds.entities.values) return;
        let n = 0;
        for (const ent of ds.entities.values) {
          const g = entityPoints(ent);
          if (!g || g.type === 'point') continue;
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
          });
        }
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * ② 建图
   * ------------------------------------------------------------------ */

  /**
   * 建网络图（带缓存：同一份要素不重复建）。
   * @param {Object} opts { sourceId, force }
   */
  function buildGraph(opts) {
    const o = opts || {};
    const features = collectFeatures(o);
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const graph = NW.buildGraph(features);
    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
    state.features = features;
    state.graph = graph;
    state.buildMs = t1 - t0;
    state.buildCount++;
    const sum = NW.graphSummary(graph);
    emit('graph', { graph: graph, summary: sum });
    return {
      ok: graph.edges.length > 0,
      graph: graph,
      summary: sum,
      features: features.length,
      ms: state.buildMs,
      error: graph.edges.length ? null : '没有可用的线要素：所选数据源里没有线或面。',
    };
  }

  /* ------------------------------------------------------------------ *
   * ③ 最短路
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} opts { sourceId, start:{lon,lat}, end:{lon,lat}, maxSnapM }
   */
  function shortestPath(opts) {
    const o = opts || {};
    if (!state.graph || !state.graph.edges.length) {
      const r = buildGraph(o);
      if (!r.ok) return { ok: false, error: r.error };
    }
    if (!o.start || !o.end) return { ok: false, error: '需要起点和终点。' };
    const res = NW.shortestPath(state.graph, o.start, o.end, { maxSnapM: o.maxSnapM });
    if (res.ok) state.lastPath = res;
    emit('path', res);
    return res;
  }

  /* ------------------------------------------------------------------ *
   * ④ 服务区
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} opts { sourceId, start:{lon,lat}, limitM, maxSnapM }
   */
  function serviceArea(opts) {
    const o = opts || {};
    if (!state.graph || !state.graph.edges.length) {
      const r = buildGraph(o);
      if (!r.ok) return { ok: false, error: r.error };
    }
    if (!o.start) return { ok: false, error: '需要起点。' };
    const limitM = o.limitM || 1000;
    const res = NW.serviceArea(state.graph, o.start, limitM, { maxSnapM: o.maxSnapM });
    if (res.ok) state.lastArea = res;
    emit('area', res);
    return res;
  }

  /* ------------------------------------------------------------------ *
   * ⑤ 画到地球上
   * ------------------------------------------------------------------ */

  /** 清除上一次的结果。 */
  function clearResults() {
    const le = getLE();
    if (le && le.viewer) {
      for (const r of state.results) {
        try {
          if (r.entity) le.viewer.entities.remove(r.entity);
          if (r.dataSource) le.viewer.dataSources.remove(r.dataSource, true);
        } catch (err) { /* ignore */ }
      }
    }
    state.results = [];
  }

  /**
   * 把最短路径画到地球上（高亮折线 + 起终点标记）。
   */
  function drawPath(result) {
    const le = getLE();
    if (!le || !le.viewer || !result || !result.ok) return null;
    clearResults();
    const coords = result.coords;
    if (!coords || coords.length < 2) return null;
    const positions = coords.map(function (p) {
      return C.Cartesian3.fromDegrees(p.lon, p.lat, 0);
    });
    const pathEnt = le.viewer.entities.add({
      name: '最短路径',
      polyline: {
        positions: positions,
        width: 5,
        material: C.Color.fromCssColorString('#ffd93b').withAlpha(1),
        clampToGround: true,
        depthFailMaterial: C.Color.fromCssColorString('#ffd93b').withAlpha(0.35),
      },
      properties: {
        distanceKm: Number((result.distanceKm).toFixed(3)),
      },
    });
    state.results.push({ entity: pathEnt, kind: 'path' });

    const marks = [
      { p: coords[0], color: '#3cb44b', text: '起' },
      { p: coords[coords.length - 1], color: '#e6194b', text: '终' },
    ];
    marks.forEach(function (m) {
      const ent = le.viewer.entities.add({
        name: m.text,
        position: C.Cartesian3.fromDegrees(m.p.lon, m.p.lat, 0),
        point: {
          pixelSize: 13,
          color: C.Color.fromCssColorString(m.color).withAlpha(0.95),
          outlineColor: C.Color.BLACK.withAlpha(0.9),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: m.text,
          font: '13px "Microsoft YaHei", sans-serif',
          fillColor: C.Color.WHITE,
          outlineColor: C.Color.BLACK,
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -20),
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString('rgba(0,0,0,0.7)'),
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
        },
      });
      state.results.push({ entity: ent, kind: 'mark' });
    });
    return { path: pathEnt, marks: state.results.length - 1 };
  }

  /**
   * 把服务区画到地球上（多边形）。
   */
  function drawServiceArea(result) {
    const le = getLE();
    if (!le || !le.viewer || !result || !result.ok) return null;
    clearResults();
    const rings = result.rings || [];
    if (!rings.length) return null;
    const ds = new C.CustomDataSource('服务区');
    let n = 0;
    rings.forEach(function (ring) {
      if (ring.length < 3) return;
      const positions = ring.map(function (p) {
        return C.Cartesian3.fromDegrees(p.lon, p.lat, 0);
      });
      try {
        ds.entities.add({
          name: '服务区',
          polygon: {
            hierarchy: new C.PolygonHierarchy(positions),
            material: C.Color.fromCssColorString('#3ea6ff').withAlpha(0.28),
            perPositionHeight: false,
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
            outline: true,
            outlineColor: C.Color.fromCssColorString('#3ea6ff').withAlpha(0.95),
            outlineWidth: 2,
          },
          properties: {
            limitM: Math.round(result.limitM),
            areaKm2: Number(result.areaKm2.toFixed(3)),
          },
        });
        n++;
      } catch (err) { /* ignore */ }
    });
    if (!n) return null;
    le.viewer.dataSources.add(ds);
    state.results.push({ dataSource: ds, kind: 'area', count: n });
    return { dataSource: ds, count: n };
  }

  /* ------------------------------------------------------------------ *
   * ⑥ 导出 / 存图层
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

  /** 导出最短路径为 GeoJSON。 */
  function exportPath(result) {
    const r = result || state.lastPath;
    if (!r || !r.ok) {
      toast('没有可导出的路径', 'error');
      return false;
    }
    const gj = NW.pathToGeoJSON(r, '最短路径');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download('network-shortest-path-' + stamp + '.geojson',
      JSON.stringify(gj, null, 2), 'application/geo+json;charset=utf-8');
    toast('已导出路径（' + r.distanceKm.toFixed(2) + ' km）', 'ok', 2600);
    return true;
  }

  /** 导出服务区为 GeoJSON。 */
  function exportArea(result) {
    const r = result || state.lastArea;
    if (!r || !r.ok) {
      toast('没有可导出的服务区', 'error');
      return false;
    }
    const gj = NW.serviceAreaToGeoJSON(r, '服务区');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download('network-service-area-' + stamp + '.geojson',
      JSON.stringify(gj, null, 2), 'application/geo+json;charset=utf-8');
    toast('已导出服务区（' + r.areaKm2.toFixed(2) + ' km²）', 'ok', 2600);
    return true;
  }

  /** 把服务区另存为矢量图层。 */
  function saveAreaAsLayer(result) {
    const le = getLE();
    const r = result || state.lastArea;
    if (!le || !le.viewer || !r || !r.ok) return null;
    const ds = new C.CustomDataSource('服务区图层');
    let n = 0;
    (r.rings || []).forEach(function (ring) {
      if (ring.length < 3) return;
      const positions = ring.map(function (p) {
        return C.Cartesian3.fromDegrees(p.lon, p.lat, 0);
      });
      try {
        ds.entities.add({
          name: '服务区',
          polygon: {
            hierarchy: new C.PolygonHierarchy(positions),
            material: C.Color.fromCssColorString('#3ea6ff').withAlpha(0.25),
            perPositionHeight: false,
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
            outline: true,
            outlineColor: C.Color.fromCssColorString('#3ea6ff'),
          },
          properties: { limitM: Math.round(r.limitM), areaKm2: Number(r.areaKm2.toFixed(3)) },
        });
        n++;
      } catch (err) { /* ignore */ }
    });
    if (!n) return null;
    le.viewer.dataSources.add(ds);
    const entry = le.registerLayer({
      name: '服务区',
      type: 'vector',
      datasource: ds,
      featureCount: n,
      remove: function () { le.viewer.dataSources.remove(ds, true); },
      zoomTo: function () { le.viewer.flyTo(ds, { duration: 1.4 }).catch(function () {}); },
    });
    return { entry: entry, count: n };
  }

  /** 当前状态。 */
  function getState() {
    const sum = state.graph ? NW.graphSummary(state.graph) : null;
    return {
      hasGraph: !!state.graph,
      summary: sum,
      featureCount: state.features.length,
      buildMs: state.buildMs,
      buildCount: state.buildCount,
      resultCount: state.results.length,
      lastPathKm: state.lastPath ? Number(state.lastPath.distanceKm.toFixed(3)) : null,
      lastAreaKm2: state.lastArea ? Number(state.lastArea.areaKm2.toFixed(3)) : null,
    };
  }

  window.LENetworkShell = {
    init: init,
    on: on,
    off: off,
    sources: sources,
    vectorLayers: vectorLayers,
    collectFeatures: collectFeatures,
    entityPoints: entityPoints,
    entityProps: entityProps,
    buildGraph: buildGraph,
    shortestPath: shortestPath,
    serviceArea: serviceArea,
    drawPath: drawPath,
    drawServiceArea: drawServiceArea,
    clearResults: clearResults,
    exportPath: exportPath,
    exportArea: exportArea,
    saveAreaAsLayer: saveAreaAsLayer,
    getState: getState,
  };
})();

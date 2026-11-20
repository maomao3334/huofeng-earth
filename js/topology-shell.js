/*
 * 拓扑检查与修复 · 装载层（P3-4.13）
 * ---------------------------------------------------------------------------
 * 把「拓扑检查器」在地球上跑起来：
 *
 *   1. 收集要素：绘制要素（LEDraw）+ 导入的矢量图层（LE.listLayers）
 *   2. 检查：自相交 / 重复点 / 环未闭合 / 重叠 / 缝隙 / 交点未打断 / 点不在面内
 *   3. 展示：问题列表（点一下飞到问题位置）+ 在地球上打标记
 *   4. 修复：去重复点、闭合环、拆自相交、统一绕向
 *   5. 修复结果可以**另存为新图层**，不破坏原始数据
 *
 * 对外 API：window.LETopologyShell
 *   sources() / collectFeatures(opts) / check(opts) / repair(opts)
 *   markIssues(issues) / clearMarks() / exportIssues() / getState()
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const TP = window.LETopology;

  const state = {
    le: null,
    features: [],
    issues: [],
    marks: [],
    listeners: [],
    listenersBound: false,
    lastCheckMs: 0,
    lastRepair: null,
    checkCount: 0,
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

  function vectorLayers() {
    const le = getLE();
    if (!le || typeof le.listLayers !== 'function') return [];
    return (le.listLayers() || []).filter(function (l) { return l.type === 'vector'; });
  }

  /** 可检查的数据源清单。 */
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

  /** 实体 → 属性。 */
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
   * 收集可检查的要素。
   * @param {Object} opts { sourceId }
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
   * ② 检查
   * ------------------------------------------------------------------ */

  /**
   * 执行拓扑检查。
   * @param {Object} opts { sourceId, rules, duplicateToleranceM, gapToleranceM, snapToleranceM }
   */
  function check(opts) {
    const o = opts || {};
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const features = collectFeatures(o);
    const issues = TP.checkDataset(features, {
      rules: o.rules,
      duplicateToleranceM: o.duplicateToleranceM,
      gapToleranceM: o.gapToleranceM,
      snapToleranceM: o.snapToleranceM,
      requireClosedRing: o.requireClosedRing,
    });
    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
    state.features = features;
    state.issues = issues;
    state.lastCheckMs = t1 - t0;
    state.checkCount++;
    emit('check', { issues: issues, ms: state.lastCheckMs });
    return {
      ok: true,
      issues: issues,
      count: issues.length,
      total: features.length,
      ms: state.lastCheckMs,
      byRule: summarize(issues),
    };
  }

  function summarize(issues) {
    const out = {};
    issues.forEach(function (i) {
      out[i.rule] = (out[i.rule] || 0) + 1;
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * ③ 在地球上打标记
   * ------------------------------------------------------------------ */

  /** 清除标记。 */
  function clearMarks() {
    const le = getLE();
    if (le && le.viewer) {
      for (const e of state.marks) {
        try { le.viewer.entities.remove(e); } catch (err) { /* ignore */ }
      }
    }
    state.marks = [];
  }

  const SEVERITY_COLOR = {
    error: '#ff5f56',
    warning: '#ffb020',
    info: '#3ea6ff',
  };

  /**
   * 在问题上打标记（红色=错误，橙色=警告，蓝色=提示）。
   */
  function markIssues(issues) {
    const le = getLE();
    if (!le || !le.viewer) return 0;
    clearMarks();
    const list = issues || state.issues;
    for (const iss of list) {
      if (!iss.at) continue;
      const color = C.Color.fromCssColorString(SEVERITY_COLOR[iss.severity] || '#ffb020');
      try {
        state.marks.push(le.viewer.entities.add({
          position: C.Cartesian3.fromDegrees(iss.at.lon, iss.at.lat, 0),
          point: {
            pixelSize: 11,
            color: color.withAlpha(0.95),
            outlineColor: C.Color.BLACK.withAlpha(0.9),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
          },
          label: {
            text: iss.message || TP.RULE_LABELS[iss.rule] || '问题',
            font: '12px "Microsoft YaHei", sans-serif',
            fillColor: C.Color.WHITE,
            outlineColor: C.Color.BLACK,
            outlineWidth: 2,
            style: C.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new C.Cartesian2(0, -18),
            verticalOrigin: C.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            backgroundColor: C.Color.fromCssColorString('rgba(0,0,0,0.65)'),
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
          },
        }));
      } catch (err) { /* ignore */ }
    }
    return state.marks.length;
  }

  /* ------------------------------------------------------------------ *
   * ④ 修复
   * ------------------------------------------------------------------ */

  /**
   * 修复要素（只改几何，不动属性）。
   * @param {Object} opts { sourceId, duplicateToleranceM, ensureCCW, fixSelfIntersection }
   */
  function repair(opts) {
    const o = opts || {};
    const features = collectFeatures(o);
    const applied = [];
    const fixed = [];
    features.forEach(function (f) {
      const r = TP.repairFeature(f, o);
      if (r.applied.length) {
        applied.push({ id: f.id, name: f.name, applied: r.applied, feature: r.feature });
        fixed.push(r.feature);
      }
      if (r.feature.extraRings) {
        r.feature.extraRings.forEach(function (ring) {
          applied.push({
            id: f.id + '-part', name: (f.name || f.id) + ' · 拆分',
            applied: ['自相交拆出的第二个面'],
            feature: Object.assign({}, f, { id: f.id + '-part', points: ring }),
          });
        });
      }
    });
    state.lastRepair = applied;
    emit('repair', { applied: applied });
    return {
      ok: true,
      applied: applied,
      count: applied.length,
      total: features.length,
    };
  }

  /**
   * 把修复后的要素另存为一个新图层（不破坏原始图层）。
   */
  function saveRepairedAsLayer(opts) {
    const o = opts || {};
    const le = getLE();
    if (!le || !le.viewer) return null;
    const features = collectFeatures(o);
    const ds = new C.CustomDataSource(o.name || '拓扑修复结果');
    let n = 0;
    features.forEach(function (f) {
      const r = TP.repairFeature(f, o);
      const emitOne = function (ff) {
        const pts = ff.points.map(function (p) {
          return C.Cartesian3.fromDegrees(p.lon, p.lat, 0);
        });
        const props = Object.assign({}, ff.props || {}, { _name: ff.name });
        try {
          if (ff.type === 'point') {
            ds.entities.add({
              name: ff.name,
              position: pts[0],
              point: {
                pixelSize: 8, color: C.Color.fromCssColorString('#7ee0c0'),
                outlineColor: C.Color.BLACK.withAlpha(0.8), outlineWidth: 1.5,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                heightReference: C.HeightReference.CLAMP_TO_GROUND,
              },
              properties: props,
            });
          } else if (ff.type === 'line') {
            ds.entities.add({
              name: ff.name,
              polyline: {
                positions: pts, width: 3,
                material: C.Color.fromCssColorString('#7ee0c0').withAlpha(1),
                clampToGround: true,
              },
              properties: props,
            });
          } else {
            ds.entities.add({
              name: ff.name,
              polygon: {
                hierarchy: new C.PolygonHierarchy(pts),
                material: C.Color.fromCssColorString('#7ee0c0').withAlpha(0.3),
                perPositionHeight: false,
                heightReference: C.HeightReference.CLAMP_TO_GROUND,
              },
              properties: props,
            });
          }
          n++;
        } catch (err) { /* ignore */ }
      };
      emitOne(r.feature);
      if (r.feature.extraRings) {
        r.feature.extraRings.forEach(function (ring) {
          emitOne(Object.assign({}, f, {
            id: f.id + '-part',
            name: (f.name || f.id) + ' · 拆分',
            points: ring,
          }));
        });
      }
    });
    le.viewer.dataSources.add(ds);
    const entry = le.registerLayer({
      name: o.name || '拓扑修复结果',
      type: 'vector',
      datasource: ds,
      featureCount: n,
      remove: function () { le.viewer.dataSources.remove(ds, true); },
      zoomTo: function () { le.viewer.flyTo(ds, { duration: 1.4 }).catch(function () {}); },
    });
    return { entry: entry, count: n };
  }

  /* ------------------------------------------------------------------ *
   * ⑤ 导出问题清单
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

  /** 导出问题清单为 CSV。 */
  function exportIssues(issues) {
    const list = issues || state.issues;
    if (!list.length) {
      toast('没有问题可导出', 'error');
      return false;
    }
    const esc = function (v) {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let out = '规则,级别,说明,要素,对方要素,经度,纬度\n';
    list.forEach(function (i) {
      out += [
        TP.RULE_LABELS[i.rule] || i.rule,
        i.severity,
        i.message,
        i.featureId,
        i.otherId || '',
        i.at ? i.at.lon.toFixed(8) : '',
        i.at ? i.at.lat.toFixed(8) : '',
      ].map(esc).join(',') + '\n';
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download('topology-issues-' + stamp + '.csv', '﻿' + out, 'text/csv;charset=utf-8');
    toast('已导出 ' + list.length + ' 条问题', 'ok', 2600);
    return true;
  }

  /** 当前状态。 */
  function getState() {
    return {
      featureCount: state.features.length,
      issueCount: state.issues.length,
      byRule: summarize(state.issues),
      lastCheckMs: state.lastCheckMs,
      checkCount: state.checkCount,
      markCount: state.marks.length,
      lastRepairCount: state.lastRepair ? state.lastRepair.length : 0,
    };
  }

  window.LETopologyShell = {
    init: init,
    on: on,
    off: off,
    sources: sources,
    vectorLayers: vectorLayers,
    collectFeatures: collectFeatures,
    check: check,
    repair: repair,
    saveRepairedAsLayer: saveRepairedAsLayer,
    markIssues: markIssues,
    clearMarks: clearMarks,
    exportIssues: exportIssues,
    summarize: summarize,
    getState: getState,
    entityPoints: entityPoints,
    entityProps: entityProps,
  };
})();

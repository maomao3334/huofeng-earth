/*
 * 属性表（js/attribute-table.js）
 *
 * 导入的数据要「能用」，光有图形不够 —— 还得能查属性、能按属性筛选、
 * 能看到每个要素的坐标。QGIS 里这个功能叫「属性表」。
 *
 * 本模块提供：
 *   - 打开/关闭属性表面板
 *   - 列出图层 → 选图层 → 显示字段与要素
 *   - 文本筛选（对所有字段做子串匹配）
 *   - 导出选中要素为 GeoJSON / CSV
 *   - 双击一行 → 相机飞到该要素
 *
 * 导出：window.LEAttrTable = { open, close, toggle, isOpen, showForLayer }
 */
(function () {
  'use strict';

  const C = window.Cesium;

  let panel = null;
  let currentLayer = null;
  let currentRows = [];
  let filterText = '';
  let sortKey = null;
  let sortDesc = false;

  /* ------------------------------------------------------------------ *
   * 面板构建
   * ------------------------------------------------------------------ */

  function buildPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'attr-table-panel';
    panel.className = 'attr-panel hidden';
    panel.innerHTML =
      '<div class="attr-head">' +
      '  <span class="attr-title">属性表</span>' +
      '  <select id="attr-layer-select" class="attr-select" title="选择图层"></select>' +
      '  <input id="attr-filter" class="attr-input" type="search" placeholder="筛选属性…" />' +
      '  <button id="attr-export-csv" class="btn tiny" title="导出为 CSV">CSV</button>' +
      '  <button id="attr-export-geojson" class="btn tiny" title="导出为 GeoJSON">GeoJSON</button>' +
      '  <button id="attr-close" class="btn tiny" title="关闭">✕</button>' +
      '</div>' +
      '<div id="attr-meta" class="attr-meta"></div>' +
      '<div id="attr-body" class="attr-body"></div>';
    document.body.appendChild(panel);

    panel.querySelector('#attr-close').addEventListener('click', () => close());
    panel.querySelector('#attr-layer-select').addEventListener('change', (ev) => {
      const id = ev.target.value;
      const l = findLayer(id);
      if (l) showForLayer(l);
    });
    panel.querySelector('#attr-filter').addEventListener('input', (ev) => {
      filterText = String(ev.target.value || '').trim().toLowerCase();
      renderBody();
    });
    panel.querySelector('#attr-export-csv').addEventListener('click', () => exportCsv());
    panel.querySelector('#attr-export-geojson').addEventListener('click', () => exportGeoJson());
    return panel;
  }

  function findLayer(id) {
    if (!window.LE || typeof window.LE.listLayers !== 'function') return null;
    const layers = window.LE.listLayers() || [];
    return layers.find((l) => l.id === id) || null;
  }

  function vectorLayers() {
    if (!window.LE || typeof window.LE.listLayers !== 'function') return [];
    return (window.LE.listLayers() || []).filter((l) => l.type === 'vector');
  }

  /* ------------------------------------------------------------------ *
   * 取要素与属性
   * ------------------------------------------------------------------ */

  /**
   * 从图层数据源里读出「要素 → 属性 + 坐标」。
   * 兼容两类数据源：
   *   - CustomDataSource（本管线建的，属性在 entity.properties）
   *   - GeoJsonDataSource / KmlDataSource（属性在 entity.properties）
   */
  function readRows(layer) {
    const ds = layer && layer.datasource;
    if (!ds || !ds.entities || !ds.entities.values) return [];
    const now = C.JulianDate.now();
    const rows = [];

    for (const ent of ds.entities.values) {
      const props = {};
      if (ent.properties) {
        // Cesium Entity 的 properties 是 PropertyBag，取 getValue
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
      const geom = readGeometry(ent, now);
      rows.push({
        entity: ent,
        props: props,
        geom: geom,
        name: ent.name || props.name || props.NAME || props.title || '',
      });
    }
    return rows;
  }

  function readGeometry(ent, now) {
    const unwrap = (v) => {
      if (v == null) return null;
      if (typeof v.getValue === 'function') {
        try { return v.getValue(now); } catch (_) { return null; }
      }
      return v;
    };
    const toLonLat = (p) => {
      if (!p) return null;
      const cc = C.Cartographic.fromCartesian(p);
      if (!cc) return null;
      return [
        C.Math.toDegrees(cc.longitude),
        C.Math.toDegrees(cc.latitude),
        cc.height,
      ];
    };

    const pos = unwrap(ent.position);
    if (pos) {
      const ll = toLonLat(pos);
      return ll ? { type: 'Point', coordinates: ll } : null;
    }
    const polyline = unwrap(ent.polyline);
    const linePositions = polyline && unwrap(polyline.positions);
    if (Array.isArray(linePositions)) {
      const pts = linePositions.map(toLonLat).filter(Boolean);
      if (pts.length) return { type: 'LineString', coordinates: pts };
    }
    const polygon = unwrap(ent.polygon);
    if (polygon) {
      const hier = unwrap(polygon.hierarchy);
      if (hier && hier.positions) {
        const pts = hier.positions.map(toLonLat).filter(Boolean);
        if (pts.length) return { type: 'Polygon', coordinates: [pts] };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function fieldNames(rows) {
    const seen = {};
    const out = [];
    for (const r of rows) {
      for (const k of Object.keys(r.props)) {
        if (!seen[k]) { seen[k] = 1; out.push(k); }
      }
    }
    return out;
  }

  function renderMeta(layer, rows, fields) {
    const meta = panel.querySelector('#attr-meta');
    if (!meta) return;
    const parts = [];
    parts.push(rows.length + ' 个要素');
    if (fields.length) parts.push(fields.length + ' 个字段：' + fields.join('、'));
    if (layer.crs) parts.push('坐标系：' + layer.crs);
    if (layer.reprojected) parts.push('已重投影到 WGS84');
    meta.textContent = parts.join(' · ');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderBody() {
    const body = panel.querySelector('#attr-body');
    if (!body) return;
    if (!currentLayer) {
      body.innerHTML = '<div class="attr-empty">没有可显示的矢量图层</div>';
      return;
    }
    const fields = fieldNames(currentRows);
    let rows = currentRows;

    // 筛选
    if (filterText) {
      rows = rows.filter((r) => {
        for (const k of Object.keys(r.props)) {
          const v = r.props[k];
          if (v == null) continue;
          if (String(v).toLowerCase().indexOf(filterText) >= 0) return true;
        }
        return String(r.name || '').toLowerCase().indexOf(filterText) >= 0;
      });
    }

    // 排序
    if (sortKey) {
      rows = rows.slice().sort((a, b) => {
        const va = a.props[sortKey];
        const vb = b.props[sortKey];
        const na = va == null ? '' : va;
        const nb = vb == null ? '' : vb;
        let c;
        if (typeof na === 'number' && typeof nb === 'number') c = na - nb;
        else c = String(na).localeCompare(String(nb), 'zh-CN');
        return sortDesc ? -c : c;
      });
    }

    const MAX_ROWS = 2000;
    const shown = rows.slice(0, MAX_ROWS);

    if (!shown.length) {
      body.innerHTML = '<div class="attr-empty">' +
        (filterText ? '没有匹配「' + escapeHtml(filterText) + '」的记录' : '没有记录') +
        '</div>';
      return;
    }

    let html = '<table class="attr-table"><thead><tr><th class="attr-idx">#</th>';
    for (const f of fields) {
      const arrow = sortKey === f ? (sortDesc ? ' ▾' : ' ▴') : '';
      html += '<th data-sort="' + escapeHtml(f) + '">' + escapeHtml(f) + arrow + '</th>';
    }
    html += '<th class="attr-lon">经度</th><th class="attr-lat">纬度</th></tr></thead><tbody>';

    shown.forEach((r, i) => {
      html += '<tr data-i="' + i + '">';
      html += '<td class="attr-idx">' + (i + 1) + '</td>';
      for (const f of fields) {
        const v = r.props[f];
        html += '<td title="' + escapeHtml(v) + '">' + escapeHtml(v) + '</td>';
      }
      if (r.geom && r.geom.type === 'Point') {
        html += '<td class="attr-lon">' + r.geom.coordinates[0].toFixed(6) + '</td>';
        html += '<td class="attr-lat">' + r.geom.coordinates[1].toFixed(6) + '</td>';
      } else {
        html += '<td class="attr-lon">—</td><td class="attr-lat">—</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';

    if (rows.length > MAX_ROWS) {
      html += '<div class="attr-note">共 ' + rows.length + ' 条，已显示前 ' + MAX_ROWS +
        ' 条（用筛选缩小范围）</div>';
    }
    body.innerHTML = html;

    // 排序
    body.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortKey === key) sortDesc = !sortDesc;
        else { sortKey = key; sortDesc = false; }
        renderBody();
      });
    });

    // 双击飞行
    body.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('dblclick', () => {
        const r = shown[parseInt(tr.dataset.i, 10)];
        if (r && r.entity) flyToEntity(r.entity);
      });
    });
  }

  function flyToEntity(entity) {
    if (!window.LE || !window.LE.viewer) return;
    window.LE.viewer.flyTo(entity, { duration: 1.4 }).catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function filteredRows() {
    if (!filterText) return currentRows;
    return currentRows.filter((r) => {
      for (const k of Object.keys(r.props)) {
        const v = r.props[k];
        if (v == null) continue;
        if (String(v).toLowerCase().indexOf(filterText) >= 0) return true;
      }
      return String(r.name || '').toLowerCase().indexOf(filterText) >= 0;
    });
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    if (!currentLayer || !currentRows.length) return;
    const rows = filteredRows();
    const fields = fieldNames(rows);
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let out = fields.join(',') + '\n';
    for (const r of rows) {
      out += fields.map((f) => esc(r.props[f])).join(',') + '\n';
    }
    download(currentLayer.name + '.csv', '﻿' + out, 'text/csv;charset=utf-8');
    if (window.LE) window.LE.toast('已导出 ' + rows.length + ' 条属性为 CSV', 'ok', 2600);
  }

  function exportGeoJson() {
    if (!currentLayer || !currentRows.length) return;
    const rows = filteredRows();
    const features = [];
    for (const r of rows) {
      if (!r.geom) continue;
      features.push({
        type: 'Feature',
        properties: r.props,
        geometry: { type: r.geom.type, coordinates: r.geom.coordinates },
      });
    }
    const fc = { type: 'FeatureCollection', features: features };
    download(currentLayer.name + '.geojson', JSON.stringify(fc, null, 2), 'application/geo+json');
    if (window.LE) window.LE.toast('已导出 ' + features.length + ' 个要素为 GeoJSON', 'ok', 2600);
  }

  /* ------------------------------------------------------------------ *
   * 公共 API
   * ------------------------------------------------------------------ */

  function refreshLayerOptions() {
    const sel = panel.querySelector('#attr-layer-select');
    if (!sel) return;
    const layers = vectorLayers();
    sel.innerHTML = layers
      .map((l) => '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '</option>')
      .join('');
    if (currentLayer) {
      const hit = layers.find((l) => l.id === currentLayer.id);
      if (hit) sel.value = hit.id;
    }
  }

  function showForLayer(layer) {
    buildPanel();
    currentLayer = layer;
    sortKey = null;
    sortDesc = false;
    filterText = '';
    const fi = panel.querySelector('#attr-filter');
    if (fi) fi.value = '';
    refreshLayerOptions();
    const sel = panel.querySelector('#attr-layer-select');
    if (sel && layer) sel.value = layer.id;
    currentRows = readRows(layer);
    renderMeta(layer, currentRows, fieldNames(currentRows));
    renderBody();
    panel.classList.remove('hidden');
  }

  function open(layer) {
    buildPanel();
    const layers = vectorLayers();
    let target = layer || currentLayer;
    if (!target || !vectorLayers().some((l) => l.id === target.id)) {
      target = layers[0] || null;
    }
    if (!target) {
      panel.classList.remove('hidden');
      refreshLayerOptions();
      currentLayer = null;
      currentRows = [];
      renderBody();
      return;
    }
    showForLayer(target);
  }

  function close() {
    if (panel) panel.classList.add('hidden');
  }

  function toggle(layer) {
    buildPanel();
    if (panel.classList.contains('hidden')) open(layer);
    else close();
  }

  function isOpen() {
    return !!panel && !panel.classList.contains('hidden');
  }

  window.LEAttrTable = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    showForLayer: showForLayer,
    readRows: readRows,
    fieldNames: fieldNames,
  };
})();

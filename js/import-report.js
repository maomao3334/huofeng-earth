/*
 * 导入自检面板（js/import-report.js）
 *
 * 「导入之后无法使用」最难受的地方是：文件拖进去了，没报错，但东西不知道跑哪去了。
 * 这个面板把每次导入的**结果、坐标系的来龙去脉、失败原因和补救办法**摊开给用户看。
 *
 * 提供：
 *   - 每次导入后弹出的「导入自检」面板（成功/失败/提示三类）
 *   - 失败时给出**可操作的建议**（例如「缺少 .prj → 请一并拖入 .prj 文件」）
 *   - 成功时给出坐标范围自检（是否落在合理经纬度范围内）
 *   - 一键复制自检报告（方便发给同事排查）
 *
 * 导出：window.LEImportReport = { show, close, toggle, isOpen, record, last }
 */
(function () {
  'use strict';

  const FORMAT_LABELS = {
    shapefile: 'Shapefile',
    gpkg: 'GeoPackage',
    geojson: 'GeoJSON',
    csv: 'CSV',
    gml: 'GML',
    gpx: 'GPX',
    dxf: 'DXF',
    wkt: 'WKT',
    kml: 'KML',
    kmz: 'KMZ',
    flatgeobuf: 'FlatGeobuf',
    'ascii-grid': 'ASCII Grid',
    raster: 'GeoTIFF',
    model3d: '三维模型',
    unknown: '未知',
  };

  let panel = null;
  let lastReport = null;

  /* ------------------------------------------------------------------ *
   * 面板构建
   * ------------------------------------------------------------------ */

  function buildPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'import-report-panel';
    panel.className = 'imp-panel hidden';
    panel.innerHTML =
      '<div class="imp-head">' +
      '  <span class="imp-title">导入自检</span>' +
      '  <span id="imp-summary" class="imp-summary"></span>' +
      '  <button id="imp-copy" class="btn tiny" title="复制报告">复制</button>' +
      '  <button id="imp-close" class="btn tiny" title="关闭">✕</button>' +
      '</div>' +
      '<div id="imp-body" class="imp-body"></div>';
    document.body.appendChild(panel);

    panel.querySelector('#imp-close').addEventListener('click', () => close());
    panel.querySelector('#imp-copy').addEventListener('click', () => copyReport());
    return panel;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------------ *
   * 建议（把技术错误翻译成人话）
   * ------------------------------------------------------------------ */

  /**
   * 根据失败原因给出可操作的建议。
   * @param {string} name 数据集名
   * @param {string} reason 失败原因
   * @param {object} group 分组信息（知道缺了哪些配套文件）
   * @returns {string}
   */
  function advise(name, reason, group) {
    const r = String(reason || '');
    const ext = (/\.([^.]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || '';

    if (/不支持的文件格式/.test(r)) {
      if (ext === 'fgb') return '这是 FlatGeobuf 文件，请确认文件完整（首 3 字节应为 fgb）。';
      return '这个格式还没接入。可以先用 QGIS 打开并「另存为」GeoJSON 或 Shapefile 再导入。';
    }
    if (/缺少 \.shp/.test(r)) {
      return 'Shapefile 必须同时有 .shp（几何）。请把同名目录里的 .shp / .dbf / .prj 一起选中。';
    }
    if (/没有找到配套的 \.dbf/.test(r) || /属性表读取失败/.test(r)) {
      return '缺 .dbf，属性会是空的。把同名 .dbf 一起拖进来即可。';
    }
    if (/没有找到配套的 \.prj/.test(r)) {
      return '缺 .prj，坐标系未知，数据会按经纬度摆放而错位。把同名 .prj 一起拖进来。';
    }
    if (/坐标系无法识别/.test(r)) {
      return '认不出这个坐标系。可以另存为带 WKT 的 GeoJSON，或手动补一个同名 .prj。';
    }
    if (/坐标看起来是投影坐标/.test(r)) {
      return '坐标明显是投影坐标但文件没带坐标系。请补一个同名 .prj（QGIS 导出图层即可生成）。';
    }
    if (/没有坐标系信息.*投影坐标/.test(r)) {
      return '这批坐标是投影坐标（米）而不是经纬度。请把同名的 .prj 文件一起拖进来，程序才能知道它落在地球的哪个位置。';
    }
    if (/FlatGeobuf/.test(r)) {
      return 'FlatGeobuf 解析失败。文件可能被截断，或者不是标准 FlatGeobuf（GDAL 3.7+ / QGIS 3.34+ 导出的）。';
    }
    if (/没有解析出任何要素/.test(r)) {
      return '文件能打开但没有要素。可能是空图层，或格式不被支持。';
    }
    if (/无法读取文件内容/.test(r)) {
      return '文件读不出来，可能是文件损坏或被占用。';
    }
    if (/GeoTIFF 缺少地理范围信息/.test(r)) {
      if (group && group.sidecars && !group.sidecars.has('rpb')) {
        return '这个 GeoTIFF 没有地理定位信息（没有仿射变换）。' +
          '国产卫星 L1A 影像的定位在同名 .rpb 文件里，请把 .rpb 和 .tiff 一起拖进来。';
      }
      return '这个 GeoTIFF 没有地理定位信息。请先用 QGIS 打开并「另存为」EPSG:4326 的 GeoTIFF 再导入。';
    }
    if (/不是经纬度坐标/.test(r)) {
      return '这是投影坐标系的栅格。请先用 QGIS 或 gdalwarp 重投影成 EPSG:4326 再导入。';
    }
    if (/文件太短|越界|不是有效/.test(r)) {
      return '文件结构不完整或已损坏。';
    }
    return '请在「诊断」面板里看详细日志，或用 QGIS 另存为 GeoJSON 后再导入。';
  }

  /**
   * 坐标范围自检：要素是不是落在合理的经纬度范围内。
   * @returns {{ok: boolean, text: string}}
   */
  function checkRange(features) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let n = 0;
    const visit = (c) => {
      if (!c || c.length < 2) return;
      const x = c[0], y = c[1];
      if (!isFinite(x) || !isFinite(y)) return;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      n++;
    };
    for (const f of features || []) {
      if (f.type === 'polygon' || f.type === 'multipolygon') {
        for (const rings of (f.rings || [])) for (const ring of rings) for (const c of ring) visit(c);
      } else if (f.type === 'multipoint' || f.type === 'multiline') {
        for (const line of (f.coords || [])) {
          if (Array.isArray(line) && line.length && typeof line[0] === 'number') visit(line);
          else for (const c of line) visit(c);
        }
      } else if (f.type === 'line') {
        for (const c of (f.coords || [])) visit(c);
      } else {
        visit(f.coords);
      }
    }
    if (!n) return { ok: true, text: '无坐标' };
    const out = maxX > 180 || minX < -180 || maxY > 90 || minY < -90;
    const fmt = (v) => v.toFixed(4).replace(/\.?0+$/, '');
    const text = '经度 ' + fmt(minX) + ' ~ ' + fmt(maxX) +
      ' · 纬度 ' + fmt(minY) + ' ~ ' + fmt(maxY);
    return { ok: !out, text: out ? '超出经纬度范围（' + text + '）' : text };
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render(report) {
    buildPanel();
    const body = panel.querySelector('#imp-body');
    const summary = panel.querySelector('#imp-summary');
    if (!body || !summary) return;

    const okCount = report.ok.length;
    const failCount = report.failed.length;
    const warnCount = report.warnings.length;

    const bits = [];
    bits.push(okCount + ' 个成功');
    if (failCount) bits.push(failCount + ' 个失败');
    if (warnCount) bits.push(warnCount + ' 条提示');
    summary.textContent = bits.join(' · ');
    summary.className = 'imp-summary' +
      (failCount ? ' has-error' : (warnCount ? ' has-warn' : ' has-ok'));

    let html = '';

    if (report.rows && report.rows.length) {
      html += '<table class="imp-table"><thead><tr>' +
        '<th>数据集</th><th>格式</th><th>要素</th><th>坐标系</th><th>坐标范围</th>' +
        '</tr></thead><tbody>';
      for (const row of report.rows) {
        const range = row.range || {};
        html += '<tr>' +
          '<td class="imp-name" title="' + escapeHtml(row.name) + '">' + escapeHtml(row.name) + '</td>' +
          '<td>' + escapeHtml(row.format) + '</td>' +
          '<td>' + row.count + '</td>' +
          '<td class="imp-crs" title="' + escapeHtml(row.crsWkt || row.crs || '') + '">' +
          escapeHtml(row.crs || '未识别') +
          (row.reprojected ? ' <span class="imp-tag">已重投影</span>' : '') + '</td>' +
          '<td class="' + (range.ok === false ? 'imp-bad' : 'imp-dim') + '">' +
          escapeHtml(range.text || '—') + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
    }

    if (report.failed.length) {
      html += '<div class="imp-sec">失败与补救</div>';
      for (const f of report.failed) {
        const reason = typeof f === 'string' ? f : f.reason;
        const nm = typeof f === 'string' ? f.split('：')[0] : f.name;
        const why = typeof f === 'string' ? f.split('：').slice(1).join('：') : reason;
        const how = (typeof f === 'object' && f.advice) ||
          advise(nm, why, f.group) ||
          advise(nm, why);
        html += '<div class="imp-fail">' +
          '<div class="imp-fail-name">' + escapeHtml(nm) + '</div>' +
          '<div class="imp-fail-why">' + escapeHtml(why) + '</div>' +
          '<div class="imp-fail-how">→ ' + escapeHtml(how) + '</div>' +
          '</div>';
      }
    }

    if (report.warnings.length) {
      html += '<div class="imp-sec">提示</div>';
      for (const w of report.warnings) {
        html += '<div class="imp-warn">' + escapeHtml(w) + '</div>';
      }
    }

    if (!html) html = '<div class="imp-empty">没有可显示的结果</div>';
    body.innerHTML = html;
  }

  /* ------------------------------------------------------------------ *
   * 公共 API
   * ------------------------------------------------------------------ */

  /**
   * 记录并展示一次导入的结果。
   * @param {object} result { ok: [], failed: [], warnings: [] }
   * @param {object} extra  { rows: [{name, format, count, crs, crsWkt, reprojected, range}] }
   */
  function record(result, extra) {
    const rows = (extra && extra.rows) || [];
    const report = {
      ok: (result && result.ok) || [],
      failed: (result && result.failed) || [],
      warnings: (result && result.warnings) || [],
      rows: rows,
      at: new Date().toISOString(),
    };
    lastReport = report;
    render(report);
    panel.classList.remove('hidden');
    return report;
  }

  function show() {
    buildPanel();
    panel.classList.remove('hidden');
  }

  function close() {
    if (panel) panel.classList.add('hidden');
  }

  function toggle() {
    buildPanel();
    if (panel.classList.contains('hidden')) show();
    else close();
  }

  function isOpen() {
    return !!panel && !panel.classList.contains('hidden');
  }

  function toText() {
    const r = lastReport;
    if (!r) return '（还没有导入记录）';
    const lines = [];
    lines.push('导入自检报告 · ' + r.at);
    lines.push('');
    lines.push('成功 ' + r.ok.length + ' 个 / 失败 ' + r.failed.length + ' 个 / 提示 ' + r.warnings.length + ' 条');
    if (r.rows.length) {
      lines.push('');
      lines.push('【成功的图层】');
      for (const row of r.rows) {
        lines.push('- ' + row.name + ' | ' + row.format + ' | ' + row.count + ' 个要素 | 坐标系：' +
          (row.crs || '未识别') + (row.reprojected ? '（已重投影到 WGS84）' : '') +
          ' | 坐标范围：' + ((row.range && row.range.text) || '—'));
      }
    }
    if (r.failed.length) {
      lines.push('');
      lines.push('【失败】');
      for (const f of r.failed) {
        lines.push('- ' + f.name + '：' + f.reason);
        lines.push('  建议：' + f.advice);
      }
    }
    if (r.warnings.length) {
      lines.push('');
      lines.push('【提示】');
      for (const w of r.warnings) lines.push('- ' + w);
    }
    return lines.join('\n');
  }

  function copyReport() {
    const text = toText();
    const done = () => {
      if (window.LE) window.LE.toast('导入自检报告已复制到剪贴板', 'ok', 2400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (_) {
      if (window.LE) window.LE.toast('复制失败，请手动截图', 'error', 2400);
    }
  }

  window.LEImportReport = {
    show: show,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    record: record,
    last: () => lastReport,
    toText: toText,
    advise: advise,
    checkRange: checkRange,
    formatLabel: (k) => FORMAT_LABELS[k] || k || '未知',
  };
})();

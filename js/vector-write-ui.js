/*
 * 矢量格式写出 · 界面（P3-4.14）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - ① 选择数据源（绘制要素 / 矢量图层）
 *   - ② 选择格式（Shapefile / GPKG / GeoJSON / CSV / KML）
 *   - ③ 选择目标坐标系（可选重投影）
 *   - ④ 预览（要素数、几何类型、字段表）
 *   - ⑤ 写出并下载
 *
 * 对外 API：window.LEVectorWriteUI
 *   init(le) / open() / close() / toggle() / render() / doExport()
 */
(function () {
  'use strict';

  const state = {
    le: null,
    panel: null,
    body: null,
    bound: false,
    form: {
      sourceId: '__all__',
      format: 'shapefile',
      crs: '',
      baseName: 'local-earth-export',
      tableName: 'features',
    },
    preview: null,
    lastResult: null,
  };

  function byId(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function getLE() { return state.le || window.LE; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3600);
  }
  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  /* ------------------------------------------------------------------ *
   * 面板骨架
   * ------------------------------------------------------------------ */

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('div', 'le-panel model-panel vw-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '矢量格式写出');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '矢量格式写出'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'vw-panel-body';
    panel.appendChild(body);

    document.body.appendChild(panel);
    state.panel = panel;
    state.body = body;
    return panel;
  }

  function button(text, cls, onClick, title) {
    const b = el('button', cls || 'model-btn', text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function section(title) {
    const s = el('div', 'model-section');
    s.appendChild(el('div', 'model-section-title', title));
    return s;
  }

  function select(options, current, onChange, cls) {
    const s = el('select', cls || 'model-select');
    options.forEach(function (o) {
      const opt = el('option', null, o.label);
      opt.value = String(o.value);
      if (String(o.value) === String(current)) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function textField(label, value, onChange, placeholder) {
    const wrap = el('div', 'model-field');
    wrap.appendChild(el('div', 'model-field-label', label));
    const row = el('div', 'model-field-row');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'model-input';
    inp.value = String(value == null ? '' : value);
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('change', function () { onChange(inp.value); });
    row.appendChild(inp);
    wrap.appendChild(row);
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  const GEOM_LABEL = {
    point: '点', multipoint: '多点',
    line: '线', multiline: '多线',
    polygon: '面', multipolygon: '多部件面',
    mixed: '混合（点/线/面）',
  };

  const FORMAT_NOTE = {
    shapefile: 'Shapefile 打包成 .zip（.shp/.shx/.dbf/.prj/.cpg）。一个文件只能装一种几何类型，' +
      '混装时按占多数的一类定，少数派会跳过并提示。',
    gpkg: 'GeoPackage 是 SQLite 数据库，QGIS / ArcGIS / Google Earth 之外的 GIS 都能直接读，' +
      '能装多种几何类型。',
    geojson: 'GeoJSON 是纯文本单文件，任何软件都能读，默认 WGS84。',
    csv: 'CSV 是属性表 + 一列 WKT 几何，Excel 能直接打开（带 BOM，中文不乱码）。',
    kml: 'KML 与 Google Earth / Google Earth Pro 互通。',
  };

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';
    const shell = window.LEVectorWriteShell;

    /* --- ① 数据源 --- */
    const s1 = section('① 选择数据源');
    const srcs = shell.sources();
    s1.appendChild(el('div', 'model-field-label', '写出哪些要素'));
    s1.appendChild(select(
      srcs.map(function (s) { return { value: s.id, label: s.name }; }),
      state.form.sourceId,
      function (val) {
        state.form.sourceId = val;
        state.preview = null;
        render();
      }
    ));
    s1.appendChild(el('p', 'model-note',
      '数据源共 ' + srcs.length + ' 项（绘制要素 + ' + shell.vectorLayers().length +
      ' 个矢量图层）。写出在浏览器内完成，纯离线，不经过服务器。'));
    body.appendChild(s1);

    /* --- ② 格式 --- */
    const s2 = section('② 选择格式');
    s2.appendChild(select(
      shell.FORMATS.map(function (f) { return { value: f.id, label: f.label }; }),
      state.form.format,
      function (val) {
        state.form.format = val;
        render();
      }
    ));
    s2.appendChild(el('p', 'model-note', FORMAT_NOTE[state.form.format] || ''));
    body.appendChild(s2);

    /* --- ③ 坐标系 --- */
    const s3 = section('③ 目标坐标系');
    s3.appendChild(select(
      shell.CRS_OPTIONS.map(function (c) { return { value: c.value, label: c.label }; }),
      state.form.crs,
      function (val) {
        state.form.crs = val;
        state.preview = null;
        render();
      }
    ));
    s3.appendChild(el('p', 'model-note',
      state.form.crs
        ? '会先用 proj4 把坐标投影到目标坐标系，再写文件；.prj / GPKG 里同时写入对应的坐标系定义。'
        : '默认 WGS84 经纬度（EPSG:4326），坐标不转换。'));
    body.appendChild(s3);

    /* --- ④ 文件名 --- */
    const s4 = section('④ 文件名');
    s4.appendChild(textField('输出文件名（不含扩展名）', state.form.baseName, function (v) {
      state.form.baseName = v;
    }, 'local-earth-export'));
    if (state.form.format === 'gpkg') {
      s4.appendChild(textField('GPKG 要素表名', state.form.tableName, function (v) {
        state.form.tableName = v;
      }, 'features'));
    }
    body.appendChild(s4);

    /* --- ⑤ 预览 --- */
    const s5 = section('⑤ 预览');
    const row5 = el('div', 'model-btn-row');
    row5.appendChild(button('🔍 预览', 'model-btn', function () {
      runPreview();
    }, '统计要素数、几何类型与属性字段'));
    s5.appendChild(row5);

    if (state.preview) {
      const p = state.preview;
      const info = el('div', 'vw-preview');
      info.appendChild(el('div', 'vw-preview-row',
        '要素数：' + p.count));
      info.appendChild(el('div', 'vw-preview-row',
        '几何类型：' + (GEOM_LABEL[p.geometry] || p.geometry)));
      if (p.mixed) {
        info.appendChild(el('div', 'vw-preview-row vw-warn',
          '混合几何：Shapefile 只能装一种类型，会按占多数的一类写，少数派被跳过。'));
      }
      p.groups.forEach(function (g) {
        info.appendChild(el('div', 'vw-preview-row',
          (GEOM_LABEL[g.kind] || g.kind) + '：' + g.count + ' 个'));
      });
      if (p.fields.length) {
        const ft = el('div', 'vw-fields');
        p.fields.forEach(function (f) {
          const item = el('div', 'vw-field');
          item.appendChild(el('span', 'vw-field-name', f.name));
          item.appendChild(el('span', 'vw-field-type', f.type));
          if (f.type === 'C') item.appendChild(el('span', 'vw-field-len', String(f.length)));
          ft.appendChild(item);
        });
        info.appendChild(el('div', 'vw-preview-row', '属性字段（' + p.fields.length + '）：'));
        info.appendChild(ft);
      }
      s5.appendChild(info);
    } else {
      s5.appendChild(el('p', 'model-note', '点「预览」看看要写出什么。'));
    }
    body.appendChild(s5);

    /* --- ⑥ 写出 --- */
    const s6 = section('⑥ 写出');
    const row6 = el('div', 'model-btn-row');
    row6.appendChild(button('💾 写出并下载', 'model-btn primary', function () {
      doExport();
    }, '在浏览器内生成文件并保存到本地'));
    s6.appendChild(row6);

    if (state.lastResult) {
      const r = state.lastResult;
      const line = el('div', 'vw-result');
      line.appendChild(el('div', 'vw-preview-row',
        '已写出：' + r.fileName));
      line.appendChild(el('div', 'vw-preview-row',
        '要素 ' + r.count + ' 个 · ' + formatBytes(r.bytes) + ' · 耗时 ' +
        (r.ms == null ? '—' : r.ms.toFixed(1) + ' ms')));
      (r.warnings || []).forEach(function (w) {
        line.appendChild(el('div', 'vw-preview-row vw-warn', w));
      });
      s6.appendChild(line);
    }
    body.appendChild(s6);

    /* --- ⑦ 说明 --- */
    const s7 = section('⑦ 说明');
    s7.appendChild(el('p', 'model-note',
      'Shapefile 的环绕向按 ESRI 约定：外环顺时针、洞逆时针。' +
      '属性表用 UTF-8 编码并附 .cpg 文件，中文不会乱码。' +
      'GPKG 用 SQLite 容器，几何是 GP 标准二进制。'));
    body.appendChild(s7);
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ------------------------------------------------------------------ *
   * 执行
   * ------------------------------------------------------------------ */

  function runPreview() {
    const shell = window.LEVectorWriteShell;
    status('正在统计…');
    try {
      state.preview = shell.preview({ sourceId: state.form.sourceId });
      status('');
      render();
      toast('预览完成：' + state.preview.count + ' 个要素', 'ok', 2400);
    } catch (err) {
      status('');
      toast('预览失败：' + (err && err.message ? err.message : err), 'error', 4000);
    }
  }

  async function doExport() {
    const shell = window.LEVectorWriteShell;
    status('正在写出…');
    let r;
    try {
      r = await shell.exportVector({
        sourceId: state.form.sourceId,
        format: state.form.format,
        crs: state.form.crs,
        baseName: state.form.baseName,
        tableName: state.form.tableName,
        download: true,
      });
    } catch (err) {
      status('');
      toast('写出失败：' + (err && err.message ? err.message : err), 'error', 5000);
      return;
    }
    status('');
    if (!r.ok) {
      toast('写出失败：' + r.error, 'error', 5000);
      return;
    }
    state.lastResult = r;
    render();
    const warn = r.warnings && r.warnings.length ? '（' + r.warnings[0] + '）' : '';
    toast('已写出 ' + r.fileName + '：' + r.count + ' 个要素' + warn,
      r.warnings && r.warnings.length ? 'warn' : 'ok', 4200);
  }

  /* ------------------------------------------------------------------ *
   * 打开 / 关闭
   * ------------------------------------------------------------------ */

  function open() {
    ensurePanel();
    state.panel.classList.remove('hidden');
    render();
  }
  function close() {
    if (state.panel) state.panel.classList.add('hidden');
  }
  function toggle() {
    if (state.panel && !state.panel.classList.contains('hidden')) close();
    else open();
  }

  function init(le) {
    state.le = le || window.LE;
    if (state.bound) return;
    state.bound = true;

    const btn = byId('btn-vector-write');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }

    window.LEVectorWriteShell.on(function (kind) {
      if (kind === 'export' && state.panel &&
          !state.panel.classList.contains('hidden')) {
        render();
      }
    });
  }

  window.LEVectorWriteUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
    runPreview: runPreview,
    doExport: doExport,
    getState: function () {
      return {
        sourceId: state.form.sourceId,
        format: state.form.format,
        crs: state.form.crs,
        preview: state.preview,
        lastResult: state.lastResult,
      };
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

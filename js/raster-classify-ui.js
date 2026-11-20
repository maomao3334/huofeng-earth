/*
 * 栅格分类 · 界面（P3-4.15）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - ① 选择数据源（本地 GeoTIFF / 数据仓库 / DEM 高程）
 *   - ② 类别管理（增删改类别、选当前类别）
 *   - ③ 采样（开/关采样、样本点列表、清空）
 *   - ④ 方法与参数（最小距离 / 最大似然，格网边长）
 *   - ⑤ 运行（分类 → 挂到地球 + 精度表）
 *   - ⑥ 非监督分类（K-Means）
 *
 * 采样交互：开启「拾取样本」后，在地图上单击即采一个点，
 * 归到当前选定类别；采样点以彩色小圆点画在地球上。
 *
 * 对外 API：window.LERasterClassifyUI
 *   init(le) / open() / close() / toggle() / render() / run() / runKmeans()
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const state = {
    le: null,
    panel: null,
    body: null,
    bound: false,
    form: {
      sourceId: 'dem',
      method: '最小距离',
      size: 256,
      k: 5,
      picking: false,
    },
    sampleEntities: [],
    lastResult: null,
    handler: null,
  };

  function byId(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function getLE() { return state.le || window.LE; }
  function shell() { return window.LERasterClassifyShell; }

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
    const panel = el('div', 'le-panel model-panel rc-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '栅格分类');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '栅格分类'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'rc-panel-body';
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

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';
    const sh = shell();
    if (!sh) {
      body.appendChild(el('p', 'model-note', '分类内核未加载。'));
      return;
    }

    /* --- ① 数据源 --- */
    const s1 = section('① 选择数据源');
    const srcs = sh.sources();
    const options = [{ value: 'dem', label: 'DEM 高程（内置全国金字塔）' }]
      .concat(srcs.map(function (s) { return { value: s.id, label: '仓库 · ' + s.name }; }));
    s1.appendChild(select(options, state.form.sourceId, function (val) {
      state.form.sourceId = val;
      state.lastResult = null;
      render();
    }));
    const pickRow = el('div', 'model-btn-row');
    pickRow.appendChild(button('📂 选择本地栅格文件', 'model-btn', function () {
      pickLocalFile();
    }, 'GeoTIFF / ASC / PGM 等，在浏览器里解码'));
    s1.appendChild(pickRow);
    const info = sh.getState();
    s1.appendChild(el('p', 'model-note',
      '本地文件在浏览器内解码，不经过服务器。栅格分类要的是**真实波段值**，' +
      '所以用原始多波段重采样（不是贴图用的 8bit 拉伸）。'));
    body.appendChild(s1);

    /* --- ② 类别 --- */
    const s2 = section('② 类别');
    const clsList = sh.classes();
    const listWrap = el('div', 'rc-classes');
    clsList.forEach(function (c) {
      const row = el('div', 'rc-class' + (c.id === info.activeClassId ? ' is-active' : ''));
      const sw = el('span', 'rc-swatch');
      sw.style.background = c.color;
      row.appendChild(sw);
      const nm = el('span', 'rc-class-name', c.name);
      nm.title = '点击设为当前类别';
      nm.addEventListener('click', function () {
        sh.setActiveClass(c.id);
        render();
      });
      row.appendChild(nm);
      const cnt = sh.samples().filter(function (s) { return s.classId === c.id; }).length;
      row.appendChild(el('span', 'rc-class-count', cnt + ' 点'));
      const del = el('button', 'rc-class-del', '×');
      del.type = 'button';
      del.title = '删除该类别';
      del.addEventListener('click', function () {
        sh.removeClass(c.id);
        render();
      });
      row.appendChild(del);
      listWrap.appendChild(row);
    });
    s2.appendChild(listWrap);
    const addRow = el('div', 'model-btn-row');
    addRow.appendChild(button('＋ 新增类别', 'model-btn subtle', function () {
      const c = sh.addClass();
      render();
      toast('已新增类别：' + c.name, 'ok', 2000);
    }));
    s2.appendChild(addRow);
    s2.appendChild(el('p', 'model-note',
      '当前类别：' + (clsList.find(function (c) { return c.id === info.activeClassId; }) || { name: '—' }).name +
      '。点击类别名可切换。'));
    body.appendChild(s2);

    /* --- ③ 采样 --- */
    const s3 = section('③ 训练样本');
    const pickBtnRow = el('div', 'model-btn-row');
    pickBtnRow.appendChild(button(
      state.form.picking ? '⏹ 停止拾取样本' : '📍 开始拾取样本',
      'model-btn' + (state.form.picking ? ' primary' : ''),
      function () { togglePicking(); },
      '在地图上单击即采一个样本点'));
    s3.appendChild(pickBtnRow);
    const samples = sh.samples();
    if (samples.length) {
      const sw = el('div', 'rc-samples');
      samples.slice(0, 60).forEach(function (s) {
        const item = el('div', 'rc-sample');
        const dot = el('span', 'rc-swatch');
        dot.style.background = sh.classColor(s.classId);
        item.appendChild(dot);
        item.appendChild(el('span', 'rc-sample-pos',
          s.lon.toFixed(4) + ', ' + s.lat.toFixed(4)));
        const del = el('button', 'rc-class-del', '×');
        del.type = 'button';
        del.addEventListener('click', function () {
          sh.removeSample(s.id);
          render();
        });
        item.appendChild(del);
        sw.appendChild(item);
      });
      s3.appendChild(sw);
      if (samples.length > 60) {
        s3.appendChild(el('div', 'model-note', '（只显示前 60 个，共 ' + samples.length + ' 个）'));
      }
      const clr = el('div', 'model-btn-row');
      clr.appendChild(button('🗑 清空样本', 'model-btn subtle', function () {
        sh.clearSamples();
        render();
      }));
      s3.appendChild(clr);
    } else {
      s3.appendChild(el('p', 'model-note',
        '还没有样本。点「开始拾取样本」后在地图上单击，' +
        '每类至少点几个（分类要用到各类别的中心与方差）。'));
    }
    body.appendChild(s3);

    /* --- ④ 方法 --- */
    const s4 = section('④ 分类方法');
    s4.appendChild(select(
      sh.METHODS.map(function (m) { return { value: m, label: m }; }),
      state.form.method,
      function (val) { state.form.method = val; }
    ));
    s4.appendChild(textField('格网边长（像素）', state.form.size, function (v) {
      const n = parseInt(v, 10);
      state.form.size = isFinite(n) ? Math.max(32, Math.min(1024, n)) : 256;
    }, '256'));
    s4.appendChild(el('p', 'model-note',
      '最小距离：像元归到「标准化后欧氏距离最近」的类别，稳、快。' +
      '最大似然：假设各类别波段独立同分布，用对数似然判定，对类内方差更敏感。'));
    body.appendChild(s4);

    /* --- ⑤ 运行 --- */
    const s5 = section('⑤ 监督分类');
    const row5 = el('div', 'model-btn-row');
    row5.appendChild(button('▶ 运行分类', 'model-btn primary', function () {
      run();
    }, '训练 → 分类 → 挂到地球上'));
    s5.appendChild(row5);

    if (state.lastResult) {
      const r = state.lastResult;
      const line = el('div', 'rc-result');
      Object.keys(r.stats || {}).forEach(function (k) {
        line.appendChild(el('div', 'rc-result-row', k + '：' + r.stats[k]));
      });
      s5.appendChild(line);
      if (r.table) {
        const tbl = el('table', 'rc-table');
        const thead = el('thead');
        const trh = el('tr');
        r.table.columns.forEach(function (c) { trh.appendChild(el('th', null, c)); });
        thead.appendChild(trh);
        tbl.appendChild(thead);
        const tb = el('tbody');
        r.table.rows.forEach(function (row) {
          const tr = el('tr');
          row.forEach(function (cell) { tr.appendChild(el('td', null, String(cell))); });
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        s5.appendChild(tbl);
      }
      if (r.confusion && r.confusion.matrix && r.confusion.matrix.length) {
        s5.appendChild(el('div', 'model-field-label', '混淆矩阵（行=真实，列=预测）'));
        const cm = el('table', 'rc-table rc-confusion');
        const thead = el('thead');
        const trh = el('tr');
        trh.appendChild(el('th', null, ''));
        r.confusion.ids.forEach(function (id) {
          const c = sh.classes().find(function (x) { return x.id === id; });
          trh.appendChild(el('th', null, c ? c.name : String(id)));
        });
        thead.appendChild(trh);
        cm.appendChild(thead);
        const tb = el('tbody');
        r.confusion.ids.forEach(function (id, i) {
          const tr = el('tr');
          const c = sh.classes().find(function (x) { return x.id === id; });
          tr.appendChild(el('th', null, c ? c.name : String(id)));
          r.confusion.matrix[i].forEach(function (v) {
            tr.appendChild(el('td', null, String(v)));
          });
          tb.appendChild(tr);
        });
        cm.appendChild(tb);
        s5.appendChild(cm);
      }
    }
    body.appendChild(s5);

    /* --- ⑥ 非监督 --- */
    const s6 = section('⑥ 非监督分类（K-Means）');
    s6.appendChild(textField('聚类数 K', state.form.k, function (v) {
      const n = parseInt(v, 10);
      state.form.k = isFinite(n) ? Math.max(2, Math.min(12, n)) : 5;
    }, '5'));
    const row6 = el('div', 'model-btn-row');
    row6.appendChild(button('▶ 运行 K-Means', 'model-btn', function () {
      runKmeans();
    }, '不需要样本点，直接把像元聚成 K 类'));
    s6.appendChild(row6);
    s6.appendChild(el('p', 'model-note',
      '没有样本点时，用 K-Means 先看看这堆波段能自然分几类，再决定监督分类怎么标。'));
    body.appendChild(s6);
  }

  /* ------------------------------------------------------------------ *
   * 本地文件
   * ------------------------------------------------------------------ */

  async function pickLocalFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tif,.tiff,.gtiff,.asc,.hdr,.pgm,.ppm,.pnm,.bin,.img';
    input.addEventListener('change', async function () {
      const file = input.files && input.files[0];
      if (!file) return;
      status('正在解码 ' + file.name + '…');
      const r = await shell().useLocalFile(file);
      status('');
      if (!r.ok) {
        toast('解码失败：' + r.error, 'error', 5000);
        return;
      }
      state.form.sourceId = 'file:' + file.name;
      toast('已载入 ' + file.name + '（' + (r.info.bands || 1) + ' 个波段）', 'ok', 3200);
      render();
    });
    input.click();
  }

  /* ------------------------------------------------------------------ *
   * 地图采样
   * ------------------------------------------------------------------ */

  function togglePicking() {
    state.form.picking = !state.form.picking;
    if (state.form.picking) {
      bindPicking();
      toast('拾取样本已开启：在地图上单击即采一个点', 'ok', 3000);
    } else {
      unbindPicking();
      toast('已停止拾取样本', 'ok', 2000);
    }
    render();
  }

  function bindPicking() {
    const le = getLE();
    const viewer = le && le.viewer;
    if (!viewer) return;
    unbindPicking();
    const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(function (movement) {
      if (!state.form.picking) return;
      const hit = pickAt(viewer, movement.position);
      if (!hit) return;
      const sh = shell();
      const s = sh.addSample(hit.lon, hit.lat);
      drawSample(s);
      render();
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    state.handler = handler;
  }

  function unbindPicking() {
    if (state.handler) {
      try { state.handler.destroy(); } catch (err) { /* ignore */ }
      state.handler = null;
    }
  }

  function pickAt(viewer, screenPos) {
    try {
      const scene = viewer.scene;
      const ray = viewer.camera.getPickRay(screenPos);
      let cartesian = ray ? scene.globe.pick(ray, scene) : null;
      if (!cartesian) cartesian = viewer.camera.pickEllipsoid(screenPos, scene.globe.ellipsoid);
      if (!cartesian) return null;
      const carto = C.Cartographic.fromCartesian(cartesian);
      if (!carto) return null;
      return {
        lon: C.Math.toDegrees(carto.longitude),
        lat: C.Math.toDegrees(carto.latitude),
      };
    } catch (err) {
      return null;
    }
  }

  /** 把样本点画到地球上。 */
  function drawSample(s) {
    const le = getLE();
    if (!le || !le.viewer) return;
    const ds = getSampleDataSource(le);
    const color = C.Color.fromCssColorString(shell().classColor(s.classId) || '#ffffff');
    ds.entities.add({
      id: 'rc-sample-' + s.id,
      position: C.Cartesian3.fromDegrees(s.lon, s.lat),
      point: {
        pixelSize: 11,
        color: color.withAlpha(0.95),
        outlineColor: C.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1.5,
        heightReference: C.HeightReference.NONE,
      },
      properties: { rcSampleId: s.id, rcClassId: s.classId },
    });
  }

  function getSampleDataSource(le) {
    if (!state.sampleDs) {
      state.sampleDs = new C.CustomDataSource('分类样本点');
      le.viewer.dataSources.add(state.sampleDs);
    }
    return state.sampleDs;
  }

  function clearSampleEntities() {
    const le = getLE();
    if (state.sampleDs && le && le.viewer) {
      le.viewer.dataSources.remove(state.sampleDs, true);
    }
    state.sampleDs = null;
    state.sampleEntities = [];
  }

  /* ------------------------------------------------------------------ *
   * 执行
   * ------------------------------------------------------------------ */

  async function ensureGrid() {
    const sh = shell();
    if (state.form.sourceId !== 'dem') {
      const cur = sh.getState().activeSourceId;
      if (cur !== state.form.sourceId) {
        const r = await sh.loadSource(state.form.sourceId);
        if (!r.ok) throw new Error(r.error);
      }
    }
    return sh.buildGrid({ size: state.form.size });
  }

  async function run() {
    const sh = shell();
    status('正在分类…');
    try {
      if (state.form.sourceId !== 'dem') {
        const cur = sh.getState().activeSourceId;
        if (cur !== state.form.sourceId) {
          const r = await sh.loadSource(state.form.sourceId);
          if (!r.ok) throw new Error(r.error);
        }
      }
      await sh.buildGrid({ size: state.form.size });
      const res = await sh.classify({ method: state.form.method, size: state.form.size });
      status('');
      if (!res.ok) {
        toast('分类失败：' + res.error, 'error', 4500);
        return;
      }
      state.lastResult = res;
      await sh.addResultLayer(res, '分类结果 · ' + state.form.method);
      render();
      toast('分类完成：总体精度 ' + res.stats['总体精度'], 'ok', 4000);
    } catch (err) {
      status('');
      toast('分类失败：' + (err && err.message ? err.message : err), 'error', 5000);
    }
  }

  async function runKmeans() {
    const sh = shell();
    status('正在聚类…');
    try {
      if (state.form.sourceId !== 'dem') {
        const cur = sh.getState().activeSourceId;
        if (cur !== state.form.sourceId) {
          const r = await sh.loadSource(state.form.sourceId);
          if (!r.ok) throw new Error(r.error);
        }
      }
      await sh.buildGrid({ size: state.form.size });
      const res = await sh.kmeans({ k: state.form.k, size: state.form.size });
      status('');
      if (!res.ok) {
        toast('聚类失败：' + res.error, 'error', 4500);
        return;
      }
      state.lastResult = res;
      await sh.addResultLayer(res, 'K-Means 聚类');
      render();
      toast('K-Means 完成：' + state.form.k + ' 类', 'ok', 3500);
    } catch (err) {
      status('');
      toast('聚类失败：' + (err && err.message ? err.message : err), 'error', 5000);
    }
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
    if (state.form.picking) {
      state.form.picking = false;
      unbindPicking();
    }
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

    const btn = byId('btn-raster-classify');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }

    const sh = shell();
    if (sh && typeof sh.on === 'function') {
      sh.on(function (kind) {
        if (kind === 'samples' && state.panel &&
            !state.panel.classList.contains('hidden')) {
          // 样本变化由各调用点自行 render，这里只做保险
        }
      });
    }
  }

  window.LERasterClassifyUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
    run: run,
    runKmeans: runKmeans,
    togglePicking: togglePicking,
    clearSampleEntities: clearSampleEntities,
    getState: function () {
      return {
        sourceId: state.form.sourceId,
        method: state.form.method,
        picking: state.form.picking,
        lastResult: state.lastResult,
      };
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

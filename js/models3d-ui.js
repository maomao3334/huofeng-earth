/*
 * 三维模型与建筑体块 · 界面（P1-4.4）
 * ---------------------------------------------------------------------------
 * 一个浮层面板（沿用 js/layer-style.js 的 le-panel 样式）：
 *   - 模型导入：选文件 → 贴地 / 落点 / 缩放 → 加入地球
 *   - 已加载模型列表：定位、删除
 *   - 建筑体块：选矢量图层 + 高度字段 + 高度模式 → 生成体块
 *
 * 对外 API：window.LEModelsUI
 *   init(le) / open() / close() / toggle()
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const state = {
    le: null,
    panel: null,
    body: null,
    title: null,
    bound: false,
    vectorLayers: [],
    fields: [],
  };

  function byId(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function getLE() {
    return state.le || window.LE;
  }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3200);
  }

  /* ------------------------------------------------------------------ *
   * 面板
   * ------------------------------------------------------------------ */

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('div', 'le-panel model-panel m3-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '三维模型与建筑体块');

    const head = el('div', 'le-panel-head');
    const h4 = el('h4', null, '三维模型与建筑体块');
    h4.id = 'model-panel-title';
    head.appendChild(h4);
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'model-panel-body';
    panel.appendChild(body);

    document.body.appendChild(panel);
    state.panel = panel;
    state.body = body;
    state.title = h4;
    return panel;
  }

  /* --------------------------- 通用控件 --------------------------- */

  function row(label, control) {
    const r = el('div', 'model-row');
    r.appendChild(el('label', 'model-label', label));
    r.appendChild(control);
    return r;
  }

  function numInput(value, step, min, max) {
    const i = document.createElement('input');
    i.type = 'number';
    i.className = 'model-num';
    i.value = String(value);
    if (step != null) i.step = String(step);
    if (min != null) i.min = String(min);
    if (max != null) i.max = String(max);
    return i;
  }

  function textInput(value) {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'model-text';
    i.value = String(value == null ? '' : value);
    return i;
  }

  function selectOf(options, value) {
    const s = document.createElement('select');
    s.className = 'model-select';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.label;
      s.appendChild(opt);
    }
    s.value = String(value);
    return s;
  }

  function checkOf(label, checked, onChange) {
    const wrap = el('label', 'model-check');
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!checked;
    i.addEventListener('change', function () { onChange(i.checked); });
    wrap.appendChild(i);
    wrap.appendChild(document.createTextNode(' ' + label));
    return wrap;
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

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';

    /* --- 模型导入 --- */
    const s1 = section('① 导入三维模型');
    s1.appendChild(el('p', 'model-note',
      '支持 glTF / GLB / OBJ / STL / 3D Tiles。OBJ 与 STL 会在浏览器里转成 glTF，' +
      '全程离线，不依赖任何外部工具。'));

    const btnRow = el('div', 'model-btn-row');
    btnRow.appendChild(button('选择模型文件…', 'model-btn primary', function () {
      doPick();
    }, '弹出系统文件框选择三维模型文件'));
    s1.appendChild(btnRow);

    const lonIn = numInput(0, 0.0001, -180, 180);
    const latIn = numInput(0, 0.0001, -90, 90);
    const hIn = numInput(0, 1, -1000, 100000);
    const sizeIn = numInput(0, 1, 0, 1000000);
    const headIn = numInput(0, 1, -360, 360);
    const fitSel = selectOf([
      { value: 'view', label: '放在当前视图中心' },
      { value: 'manual', label: '手动指定经纬度' },
    ], 'view');

    s1.appendChild(row('落点', fitSel));
    s1.appendChild(row('经度', lonIn));
    s1.appendChild(row('纬度', latIn));
    s1.appendChild(row('附加高程 (m)', hIn));
    s1.appendChild(row('目标边长 (m)', sizeIn));
    s1.appendChild(row('方位角 (°)', headIn));

    const clampChk = checkOf('贴地（clampToGround）', true, function () {});
    s1.appendChild(clampChk);
    s1.appendChild(el('p', 'model-note',
      '目标边长填 0 表示按模型原始尺寸显示；贴地开启时模型会吸附到地形表面。'));

    body.appendChild(s1);

    /* --- 已加载模型 --- */
    const s2 = section('② 已加载模型');
    const list = el('div', 'model-list');
    const models = window.LEModels ? window.LEModels.listModels() : [];
    if (!models.length) {
      list.appendChild(el('p', 'model-note', '还没有加载任何模型。'));
    } else {
      models.forEach(function (m) {
        const item = el('div', 'model-item');
        const nm = el('span', 'model-item-name', m.name || '三维模型');
        nm.title = (m.modelUri || '') + '（点击定位）';
        nm.addEventListener('click', function () {
          if (m.zoomTo) m.zoomTo();
        });
        item.appendChild(nm);
        item.appendChild(el('span', 'model-item-tag',
          m.modelKind === 'tileset' ? '3D Tiles' : 'glTF'));
        item.appendChild(button('⌖', 'model-btn tiny', function () {
          if (m.zoomTo) m.zoomTo();
        }, '定位到该模型'));
        item.appendChild(button('✕', 'model-btn tiny danger', function () {
          const le = getLE();
          if (le && le.removeLayer) le.removeLayer(m.id);
          render();
        }, '删除该模型'));
        list.appendChild(item);
      });
    }
    s2.appendChild(list);
    body.appendChild(s2);

    /* --- 建筑体块 --- */
    const s3 = section('③ 建筑体块（矢量面拉伸）');
    s3.appendChild(el('p', 'model-note',
      '把带高度的房屋轮廓面拉伸成三维体块。顶面高度可按「绝对高程」「相对地面」或「层数×层高」计算。'));

    state.vectorLayers = (getLE() && getLE().listLayers
      ? getLE().listLayers() : []).filter(function (e) {
        return e.type === 'vector' && e.datasource && e.datasource.entities.values.length;
      });

    if (!state.vectorLayers.length) {
      s3.appendChild(el('p', 'model-note',
        '当前没有可用的矢量图层。请先导入带多边形的矢量数据（Shapefile / GeoJSON / KML 等）。'));
    } else {
      const layerSel = selectOf(state.vectorLayers.map(function (e) {
        return { value: e.id, label: e.name || e.id };
      }), state.vectorLayers[0].id);

      const fieldSel = selectOf([{ value: '', label: '（不指定，按最小高度拉起）' }], '');
      const modeSel = selectOf([
        { value: 'absolute', label: '绝对高程' },
        { value: 'relative', label: '相对地面' },
        { value: 'floors', label: '层数 × 层高' },
      ], 'absolute');
      const floorIn = numInput(3, 0.1, 0.1, 100);
      const minIn = numInput(3, 0.5, 0.1, 10000);
      const colorIn = document.createElement('input');
      colorIn.type = 'color';
      colorIn.className = 'model-color';
      colorIn.value = '#c9d3de';

      s3.appendChild(row('矢量图层', layerSel));
      s3.appendChild(row('高度字段', fieldSel));
      s3.appendChild(row('高度模式', modeSel));
      s3.appendChild(row('层高 (m)', floorIn));
      s3.appendChild(row('最小高度 (m)', minIn));
      s3.appendChild(row('颜色', colorIn));

      // 高度字段随图层变化
      function refreshFields() {
        const entry = state.vectorLayers.filter(function (e) { return e.id === layerSel.value; })[0];
        const fields = entry ? fieldListOf(entry) : [];
        fieldSel.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '（不指定，按最小高度拉起）';
        fieldSel.appendChild(none);
        fields.forEach(function (f) {
          const o = document.createElement('option');
          o.value = f;
          o.textContent = f;
          fieldSel.appendChild(o);
        });
      }
      layerSel.addEventListener('change', refreshFields);
      refreshFields();

      const doBtn = button('生成建筑体块', 'model-btn primary', function () {
        const entry = state.vectorLayers.filter(function (e) { return e.id === layerSel.value; })[0];
        if (!entry) { toast('没有可用的矢量图层', 'error'); return; }
        try {
          const out = window.LEModels.extrudeFromVector({
            layerEntry: entry,
            heightField: fieldSel.value,
            mode: modeSel.value,
            floorHeight: Number(floorIn.value),
            minHeight: Number(minIn.value),
            color: colorIn.value,
          });
          toast('已生成 ' + out.featureCount + ' 个建筑体块', 'ok', 3200);
          if (out.zoomTo) out.zoomTo();
          render();
        } catch (err) {
          toast('生成失败：' + (err && err.message ? err.message : err), 'error', 6000);
        }
      }, '按所选矢量图层与高度字段生成三维体块');
      const br = el('div', 'model-btn-row');
      br.appendChild(doBtn);
      s3.appendChild(br);
    }
    body.appendChild(s3);
  }

  /** 取矢量图层的字段名列表。 */
  function fieldListOf(entry) {
    const out = [];
    try {
      if (entry.fields && entry.fields.length) {
        for (const f of entry.fields) {
          const name = typeof f === 'string' ? f : (f && (f.name || f.field)) ;
          if (name) out.push(name);
        }
      }
      if (!out.length && entry.datasource) {
        const e0 = entry.datasource.entities.values[0];
        const p = e0 && e0.properties;
        if (p) {
          const props = typeof p.getValue === 'function' ? p.getValue(C.JulianDate.now()) : p;
          const bag = props && typeof props.getValue === 'function'
            ? props.getValue(C.JulianDate.now()) : props;
          if (bag) Object.keys(bag).forEach(function (k) { out.push(k); });
        }
      }
    } catch (err) { /* ignore */ }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 导入
   * ------------------------------------------------------------------ */

  async function doPick() {
    if (!window.LEModels) { toast('三维模型模块未就绪', 'error'); return; }
    const le = getLE();
    const center = window.LEModels.viewCenter();
    toast('正在打开文件选择框…', 'ok', 1600);
    const res = await window.LEModels.pickAndImport();
    if (res && res.ok && res.ok.length) render();
  }

  /* ------------------------------------------------------------------ *
   * 开关
   * ------------------------------------------------------------------ */

  function open() {
    const panel = ensurePanel();
    panel.classList.remove('hidden');
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

    const btn = byId('btn-models3d');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }
  }

  window.LEModelsUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
    fieldListOf: fieldListOf,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

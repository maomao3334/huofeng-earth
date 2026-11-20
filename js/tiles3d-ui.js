/*
 * 3D Tiles 倾斜摄影 · 界面（P2-4.8）
 * ---------------------------------------------------------------------------
 * 一个浮层面板（沿用 js/models3d-ui.js 的 model-panel 样式）：
 *   - 添加倾斜摄影目录：选本机目录 → 挂载 → 加载 tileset.json
 *   - 已加载数据集列表：定位、显隐、删除
 *   - 数据集详情：版本 / 瓦片数 / 层级 / 范围
 *
 * 对外 API：window.LETiles3DUI
 *   init(le) / open() / close() / toggle()
 */
(function () {
  'use strict';

  const state = {
    le: null,
    panel: null,
    body: null,
    bound: false,
    busy: false,
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

  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  /* ------------------------------------------------------------------ *
   * 面板
   * ------------------------------------------------------------------ */

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('div', 'le-panel model-panel tiles3d-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '三维倾斜摄影');

    const head = el('div', 'le-panel-head');
    const h4 = el('h4', null, '三维倾斜摄影（3D Tiles）');
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
    body.id = 'tiles3d-panel-body';
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

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';

    /* --- 添加目录 --- */
    const s1 = section('① 添加倾斜摄影目录');
    s1.appendChild(el('p', 'model-note',
      '选择本机存放倾斜摄影的目录（该目录里应直接含有 tileset.json）。' +
      '软件会把它挂载成只读地址交给 Cesium 分块流式加载 —— 不复制、不改写、不联网。'));

    const btnRow = el('div', 'model-btn-row');
    btnRow.appendChild(button('选择目录…', 'model-btn primary', function () {
      doAdd();
    }, '选择含 tileset.json 的本机目录'));
    btnRow.appendChild(button('刷新列表', 'model-btn', function () {
      render();
    }, '刷新已加载列表'));
    s1.appendChild(btnRow);
    body.appendChild(s1);

    /* --- 已加载 --- */
    const s2 = section('② 已加载倾斜摄影');
    const list = el('div', 'model-list');
    const entries = window.LETiles3DShell ? window.LETiles3DShell.entries : [];
    if (!entries.length) {
      list.appendChild(el('p', 'model-note', '还没有加载任何倾斜摄影数据集。'));
    } else {
      entries.forEach(function (entry) {
        const item = el('div', 'model-item');
        const nm = el('span', 'model-item-name', entry.name || '倾斜摄影');
        nm.title = entry.tilesetUrl || '';
        nm.addEventListener('click', function () {
          if (entry.zoomTo) entry.zoomTo();
        });
        item.appendChild(nm);
        item.appendChild(el('span', 'model-item-tag', '3D Tiles'));

        const vis = button(entry.visible ? '👁' : '–', 'model-btn tiny', function () {
          const on = !entry.visible;
          if (entry.setVisible) entry.setVisible(on);
          render();
        }, entry.visible ? '隐藏' : '显示');
        item.appendChild(vis);

        item.appendChild(button('⌖', 'model-btn tiny', function () {
          if (entry.zoomTo) entry.zoomTo();
        }, '定位到该数据集'));

        item.appendChild(button('✕', 'model-btn tiny danger', function () {
          const le = getLE();
          if (le && le.removeLayer) le.removeLayer(entry.id);
          const arr = window.LETiles3DShell.entries;
          const i = arr.indexOf(entry);
          if (i >= 0) arr.splice(i, 1);
          render();
        }, '删除该数据集'));

        list.appendChild(item);

        // 详情
        const sum = entry.tilesetSummary;
        if (sum) {
          const meta = el('div', 'vault-meta');
          const parts = [];
          if (sum.version) parts.push('v' + sum.version);
          parts.push(sum.tileCount + ' 个瓦片');
          if (sum.maxDepth) parts.push(sum.maxDepth + ' 层');
          if (sum.bbox) {
            parts.push('经度 ' + fmt(sum.bbox.west) + '~' + fmt(sum.bbox.east));
            parts.push('纬度 ' + fmt(sum.bbox.south) + '~' + fmt(sum.bbox.north));
          }
          meta.textContent = parts.join(' · ');
          list.appendChild(meta);
        }
      });
    }
    s2.appendChild(list);
    body.appendChild(s2);

    /* --- 说明 --- */
    const s3 = section('③ 格式支持');
    s3.appendChild(el('p', 'model-note',
      '支持：3D Tiles 1.0 / 1.1（tileset.json + .b3dm / .glb / .pnts / .cmpt）。' +
      '不支持：.osgb（ContextScene）、.3DML、.slpk（ESRI I3S 数据包）、.dae、.dwg —— ' +
      '这些格式请先用专业工具转成 3D Tiles 再导入。'));
    body.appendChild(s3);
  }

  function fmt(v) {
    const n = Number(v);
    if (!isFinite(n)) return '?';
    return n.toFixed(3);
  }

  /* ------------------------------------------------------------------ *
   * 导入
   * ------------------------------------------------------------------ */

  async function doAdd() {
    if (state.busy) return;
    const shell = window.LETiles3DShell;
    if (!shell) { toast('3D Tiles 模块未就绪', 'error'); return; }
    state.busy = true;
    try {
      const dir = await shell.pickFolder('选择倾斜摄影数据目录（含 tileset.json）');
      if (!dir) { state.busy = false; return; }
      status('正在挂载倾斜摄影目录…');
      toast('正在读取倾斜摄影数据集…', 'ok', 2600);
      const res = await shell.mountAndLoad(dir);
      const s = res.summary;
      status('倾斜摄影已加载：' + (s.tileCount || 0) + ' 个瓦片');
      toast('已加载倾斜摄影：' + (s.tileCount || 0) + ' 个瓦片', 'ok', 3600);
      if (res.entry && res.entry.zoomTo) res.entry.zoomTo();
      render();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      toast('倾斜摄影加载失败：' + msg, 'error', 7000);
      status('倾斜摄影加载失败');
    } finally {
      state.busy = false;
    }
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
    const btn = byId('btn-tiles3d');
    if (btn) btn.addEventListener('click', function () { toggle(); });
  }

  window.LETiles3DUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

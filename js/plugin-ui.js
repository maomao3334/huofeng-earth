/*
 * 插件式扩展机制 · 界面（P3-4.17）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式），四个分区：
 *   ① 已装插件：列出插件、版本、来源，可卸载 / 导出
 *   ② 安装插件：从本地 JSON 文件导入，或直接粘贴 JSON
 *   ③ 新建插件：内置模板，可复制去改，改完粘贴回来安装
 *   ④ 说明：讲清插件能拿到什么、拿不到什么（沙箱边界）
 *
 * 插件跑起来的结果**不进这个面板**，而是像原生算法一样：
 *   在「工具箱」面板里选中插件 → 填参数 → 运行 → 结果挂到地球上。
 *
 * 对外 API：window.LEPluginUI
 *   init(le) / open() / close() / toggle() / render()
 *   installFromFile() / installFromText(text) / exportAll()
 */
(function () {
  'use strict';

  const state = {
    le: null,
    panel: null,
    body: null,
    bound: false,
    filter: '',
  };

  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function getLE() { return state.le || window.LE; }
  function shell() { return window.LEPluginShell; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3600);
  }
  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  /* ------------------------------------------------------------------ 面板骨架 */

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('div', 'le-panel model-panel pg-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '插件管理');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '插件管理'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'pg-panel-body';
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

  function textarea(rows, placeholder, value) {
    const t = document.createElement('textarea');
    t.className = 'model-textarea';
    t.rows = rows;
    t.placeholder = placeholder || '';
    if (value != null) t.value = value;
    return t;
  }

  /* ------------------------------------------------------------------ 各分区 */

  function renderInstalled(sec) {
    const sh = shell();
    const list = sh ? sh.list() : [];
    sec.appendChild(el('div', 'model-note',
      list.length
        ? '已装 ' + list.length + ' 个插件。插件算法在「工具箱」里与原生算法并列，可直接运行。'
        : '还没有安装插件。可以从 JSON 文件导入，或用下面的模板新建一个。'));

    for (const p of list) {
      const card = el('div', 'pg-card');
      const head = el('div', 'pg-card-head');
      head.appendChild(el('span', 'pg-card-name', p.name));
      head.appendChild(el('span', 'pg-card-ver', 'v' + p.version));
      card.appendChild(head);
      card.appendChild(el('div', 'pg-card-desc', p.description || '（无说明）'));
      card.appendChild(el('div', 'pg-card-meta',
        '分组：' + (p.group || '插件') + ' · 参数 ' + (p.parameters || []).length + ' 个' +
        (p.builtin ? ' · 内置' : '')));

      const row = el('div', 'pg-card-actions');
      if (!p.builtin) {
        row.appendChild(button('卸载', 'model-btn subtle', function () {
          try {
            sh.uninstall(p.id);
            toast('已卸载：' + p.name, 'ok');
            render();
          } catch (err) {
            toast('卸载失败：' + (err.message || err), 'error', 4200);
          }
        }));
      }
      row.appendChild(button('导出 JSON', 'model-btn subtle', function () {
        try {
          const txt = sh.exportOne(p.id);
          sh.download(p.id + '.json', txt);
          toast('已导出：' + p.name, 'ok');
        } catch (err) {
          toast('导出失败：' + (err.message || err), 'error', 4200);
        }
      }));
      card.appendChild(row);
      sec.appendChild(card);
    }

    if (list.length > 1) {
      sec.appendChild(button('导出全部插件', 'model-btn', function () {
        try {
          sh.download('le-plugins.json', sh.exportAll());
          toast('已导出 ' + list.length + ' 个插件', 'ok');
        } catch (err) {
          toast('导出失败：' + (err.message || err), 'error', 4200);
        }
      }));
    }
  }

  function renderInstall(sec) {
    sec.appendChild(el('div', 'model-note',
      '插件是一个 JSON 清单：id / name / description / parameters / source。' +
      'source 是一段 JavaScript，导出 run(params, ctx) 函数。'));

    const row = el('div', 'model-btn-row');
    row.appendChild(button('从 JSON 文件导入…', 'model-btn primary', function () {
      const input = byId('plugin-file-input');
      if (!input) return;
      input.value = '';
      input.click();
    }));
    sec.appendChild(row);

    sec.appendChild(el('div', 'model-field-label', '或直接粘贴 JSON'));
    const ta = textarea(8, '{\n  "id": "my.plugin",\n  "name": "我的插件",\n  ...\n}');
    ta.id = 'pg-json-input';
    sec.appendChild(ta);

    const row2 = el('div', 'model-btn-row');
    row2.appendChild(button('安装这段 JSON', 'model-btn primary', function () {
      const t = byId('pg-json-input');
      if (!t || !t.value.trim()) {
        toast('请先粘贴插件 JSON', 'error', 2600);
        return;
      }
      try {
        const sh = shell();
        const p = sh.install(t.value);
        t.value = '';
        toast('已安装：' + p.name + '（去工具箱运行）', 'ok', 4000);
        status('插件已安装：' + p.name);
        render();
      } catch (err) {
        toast('安装失败：' + (err.message || err), 'error', 5200);
      }
    }));
    sec.appendChild(row2);
  }

  function renderNew(sec) {
    sec.appendChild(el('div', 'model-note',
      '复制下面的模板，改成自己的算法，再粘到上面「安装这段 JSON」里。' +
      '插件跑在浏览器沙箱里，能读 DEM、能读矢量，但碰不到网络和文件系统。'));

    const sh = shell();
    const sample = sh ? sh.sample() : null;
    if (!sample) {
      sec.appendChild(el('div', 'model-note', '（插件内核未加载）'));
      return;
    }
    const ta = textarea(14, '', JSON.stringify(sample, null, 2));
    ta.id = 'pg-template';
    ta.readOnly = true;
    sec.appendChild(ta);

    const row = el('div', 'model-btn-row');
    row.appendChild(button('复制模板', 'model-btn', function () {
      const t = byId('pg-template');
      if (!t) return;
      t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(t.value).then(
          function () { toast('模板已复制到剪贴板', 'ok'); },
          function () { toast('复制失败，请手动选中复制', 'error'); }
        );
        return;
      }
      toast(ok ? '模板已复制到剪贴板' : '复制失败，请手动选中复制', ok ? 'ok' : 'error');
    }));
    row.appendChild(button('填到上面的输入框', 'model-btn subtle', function () {
      const t = byId('pg-template');
      const dst = byId('pg-json-input');
      if (!t || !dst) return;
      dst.value = t.value;
      toast('模板已填入，修改后再安装', 'ok', 3000);
    }));
    sec.appendChild(row);
  }

  function renderHelp(sec) {
    sec.appendChild(el('div', 'model-note',
      '沙箱边界：插件拿不到 window / document / fetch / localStorage，' +
      '不能起任何外部进程。'));
    sec.appendChild(el('div', 'model-note',
      '插件能用的能力（通过 ctx 参数）：ctx.dem.heightAt(lon,lat) 读本机全国 DEM；' +
      'ctx.vector.inputs() 列出内存里的矢量要素；' +
      'ctx.analysis.helpers 复用地形与几何工具函数；ctx.view.rect() 当前视野范围。'));
    sec.appendChild(el('div', 'model-note',
      '返回值契约（与原生算法一致）：kind 为 vector（给 geojson）、' +
      'raster（给 png 的 data URL 与 bounds）、table（给 columns 与 rows）三种之一。'));
    sec.appendChild(el('div', 'model-note',
      '装好的插件保存在本机浏览器里，下次启动还在；也可以导出 JSON 拿到别的电脑上装。'));
  }

  /* ------------------------------------------------------------------ 渲染 */

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';

    const s1 = section('① 已装插件');
    renderInstalled(s1);
    body.appendChild(s1);

    const s2 = section('② 安装插件');
    renderInstall(s2);
    body.appendChild(s2);

    const s3 = section('③ 新建插件');
    renderNew(s3);
    body.appendChild(s3);

    const s4 = section('④ 说明');
    renderHelp(s4);
    body.appendChild(s4);
  }

  /* ------------------------------------------------------------------ 开关 */

  function open() {
    const panel = ensurePanel();
    panel.classList.remove('hidden');
    render();
    if (!state.bound) {
      state.bound = true;
      const input = byId('plugin-file-input');
      if (input) {
        input.addEventListener('change', function () {
          const f = input.files && input.files[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = function () {
            try {
              const sh = shell();
              const p = sh.install(String(reader.result || ''));
              toast('已安装：' + p.name + '（去工具箱运行）', 'ok', 4000);
              render();
            } catch (err) {
              toast('安装失败：' + (err.message || err), 'error', 5200);
            }
          };
          reader.onerror = function () { toast('读取文件失败', 'error'); };
          reader.readAsText(f, 'utf-8');
        });
      }
    }
    return panel;
  }

  function close() {
    if (state.panel) state.panel.classList.add('hidden');
  }

  function toggle() {
    if (state.panel && !state.panel.classList.contains('hidden')) close();
    else open();
  }

  function init(le) {
    state.le = le;
    ensurePanel();
    render();
  }

  window.LEPluginUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
  };
})();

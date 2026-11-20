/*
 * Tour / 电影运镜 · 界面（P2-4.10）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - 录制：把当前相机位置记成关键帧
 *   - 关键帧列表：改时长、删除、跳转
 *   - 播放 / 暂停 / 拖动时间
 *   - 导入 / 导出航线文件（JSON）
 *   - 导出单文件 HTML 播放器（零依赖，可离线播放）
 *
 * 对外 API：window.LETourUI
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

  function getLE() { return state.le || window.LE; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3200);
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
    const panel = el('div', 'le-panel model-panel tour-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Tour 电影运镜');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, 'Tour · 电影运镜'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'tour-panel-body';
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
    const shell = window.LETourShell;
    const st = shell ? shell.getState() : null;

    /* --- ① 录制 --- */
    const s1 = section('① 录制航线');
    s1.appendChild(el('p', 'model-note',
      '把当前相机位置记成关键帧，然后依次飞到你想要的各个位置再点「记录当前视角」。' +
      '每站默认 4 秒飞抵，可在下面的关键帧列表里改。'));

    const btnRow = el('div', 'model-btn-row');
    btnRow.appendChild(button('📍 记录当前视角', 'model-btn primary', function () {
      doRecord();
    }, '把当前相机位置录成关键帧'));
    btnRow.appendChild(button('新建航线', 'model-btn', function () {
      shell.newTour('我的航线');
      render();
      toast('已新建航线', 'ok');
    }, '清空现有航线，从头开始'));
    s1.appendChild(btnRow);
    body.appendChild(s1);

    if (!st || !st.count) {
      const s2 = section('② 关键帧');
      s2.appendChild(el('p', 'model-note', '还没有关键帧。先点上面的「记录当前视角」。'));
      body.appendChild(s2);
      return;
    }

    /* --- ② 关键帧 --- */
    const s2 = section('② 关键帧（' + st.count + ' 站 · 总时长 ' + st.duration.toFixed(1) + ' 秒）');
    const list = el('div', 'model-list tour-list');
    st.keyframes.forEach(function (k, i) {
      const row = el('div', 'model-item');
      const nm = el('span', 'model-item-name', (i + 1) + '. ' + k.name);
      nm.title = k.lon.toFixed(5) + ', ' + k.lat.toFixed(5) + ' · ' + Math.round(k.height) + ' m';
      nm.addEventListener('click', function () {
        shell.seek(cumulativeTime(st.keyframes, i));
        render();
      });
      row.appendChild(nm);

      // 每段时长（秒）
      const dur = el('input', 'model-num tour-dur');
      dur.type = 'number';
      dur.min = '0.5';
      dur.step = '0.5';
      dur.value = String(k.duration || 0);
      dur.title = '飞到这一站用几秒';
      dur.addEventListener('change', function () {
        shell.setDuration(i, Number(dur.value));
        render();
      });
      row.appendChild(dur);

      row.appendChild(button('✕', 'model-btn tiny danger', function () {
        shell.removeKeyframe(i);
        render();
      }, '删除这一站'));
      list.appendChild(row);
    });
    s2.appendChild(list);
    body.appendChild(s2);

    /* --- ③ 播放 --- */
    const s3 = section('③ 播放');
    const ctrl = el('div', 'model-btn-row');
    ctrl.appendChild(button(st.playing ? '⏸' : '▶', 'model-btn primary', function () {
      if (st.playing) shell.pause();
      else shell.play();
      render();
    }, st.playing ? '暂停' : '播放'));
    ctrl.appendChild(button('⏹', 'model-btn', function () {
      shell.stop();
      render();
    }, '停止并回到起点'));
    s3.appendChild(ctrl);
    body.appendChild(s3);

    /* --- ④ 导入 / 导出 --- */
    const s4 = section('④ 保存与分享');
    const row4 = el('div', 'model-btn-row');
    row4.appendChild(button('导出航线文件…', 'model-btn', function () {
      doSaveJson();
    }, '导出 .tour.json 航线文件'));
    row4.appendChild(button('导入航线文件…', 'model-btn', function () {
      doLoadJson();
    }, '载入 .tour.json 航线文件'));
    row4.appendChild(button('导出 HTML 播放器…', 'model-btn', function () {
      doExportHtml();
    }, '导出零依赖的单文件 HTML，可离线播放'));
    s4.appendChild(row4);
    s4.appendChild(el('p', 'model-note',
      '航线文件是可读的 JSON，直接用记事本就能改。' +
      'HTML 播放器把轨迹烘成采样点内嵌进文件，不引用任何外部资源，' +
      '拷到任何一台电脑、任何浏览器都能离线播放。'));
    body.appendChild(s4);
  }

  /** 第 i 站对应的累计时间。 */
  function cumulativeTime(frames, i) {
    let t = 0;
    for (let k = 0; k < i; k++) t += frames[k].duration || 0;
    return t;
  }

  /* ------------------------------------------------------------------ *
   * 动作
   * ------------------------------------------------------------------ */

  function doRecord() {
    const shell = window.LETourShell;
    if (!shell) { toast('Tour 模块未就绪', 'error'); return; }
    const k = shell.addKeyframe({ duration: 4 });
    if (!k) return;
    toast('已记录第 ' + shell.getState().count + ' 站', 'ok', 2000);
    render();
  }

  function doSaveJson() {
    const shell = window.LETourShell;
    const text = shell.save();
    if (!text) { toast('没有可保存的航线', 'error'); return; }
    downloadBlob(text, (shell.getState().name || '航线') + '.tour.json', 'application/json');
    toast('航线文件已导出', 'ok');
  }

  function doLoadJson() {
    const shell = window.LETourShell;
    if (!shell) return;
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', function () {
      const f = input.files && input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        const r = shell.load(String(reader.result));
        if (r) render();
      };
      reader.readAsText(f);
    });
    input.click();
  }

  function doExportHtml() {
    const shell = window.LETourShell;
    try {
      const r = shell.exportHtml({});
      downloadBlob(r.html, (shell.getState().name || '航线') + '.html', 'text/html;charset=utf-8');
      toast('HTML 播放器已导出（' + Math.round(r.bytes / 1024) + ' KB · ' +
        r.samples + ' 个采样点）', 'ok', 4500);
    } catch (err) {
      toast('导出失败：' + (err && err.message ? err.message : String(err)), 'error', 5000);
    }
  }

  function downloadBlob(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
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
    const btn = byId('btn-tour');
    if (btn) btn.addEventListener('click', function () { toggle(); });
    const shell = window.LETourShell;
    if (shell && typeof shell.on === 'function') {
      shell.on(function (kind) {
        if (kind === 'tour' || kind === 'play') {
          if (state.panel && !state.panel.classList.contains('hidden')) render();
        }
      });
    }
  }

  window.LETourUI = {
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

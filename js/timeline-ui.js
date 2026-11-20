/*
 * 时间轴 / 历史影像 · 界面（P2-4.9）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - 扫描本机带日期的影像 → 生成时间轴
 *   - 刻度尺 + 拖动滑块跳到任意时刻
 *   - 播放 / 暂停 / 上一期 / 下一期
 *   - 帧列表（按年分组）
 *
 * 对外 API：window.LETimelineUI
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
    timeline: null,
    scrub: null,      // <input type=range>
    label: null,      // 当前时刻标签
    listNode: null,
    framesBox: null,
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
    const panel = el('div', 'le-panel model-panel timeline-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '时间轴 / 历史影像');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '时间轴 / 历史影像'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'timeline-panel-body';
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
    updateCount();

    /* --- ① 扫描 --- */
    const s1 = section('① 载入历史影像');
    s1.appendChild(el('p', 'model-note',
      '扫描本机「本地影像」与「数据仓库」里带拍摄日期的影像，生成可拖动的时间轴。' +
      '时间从数据集名或目录名里的日期识别（国产卫星目录名一般带 YYYYMMDD）。' +
      '全程本地，不联网、不上传。'));

    const btnRow = el('div', 'model-btn-row');
    btnRow.appendChild(button('扫描并生成时间轴', 'model-btn primary', function () {
      doScan();
    }, '扫描本机带日期的影像数据集'));
    btnRow.appendChild(button('刷新清单', 'model-btn', function () {
      doScan(true);
    }, '重新读取本地影像与数据仓库清单'));
    s1.appendChild(btnRow);
    body.appendChild(s1);

    /* --- ② 时间轴 --- */
    const s2 = section('② 时间轴');
    const st = window.LETimelineShell ? window.LETimelineShell.getState() : null;

    if (!st || !st.count) {
      s2.appendChild(el('p', 'model-note',
        '还没有生成时间轴。先点上面的「扫描并生成时间轴」。'));
      body.appendChild(s2);
      return;
    }

    // 当前时刻标签
    const labelBox = el('div', 'timeline-current');
    state.label = el('div', 'timeline-current-time',
      st.current ? st.current.text : '—');
    state.label.title = st.current ? String(st.current.time) : '';
    labelBox.appendChild(state.label);
    labelBox.appendChild(el('div', 'timeline-current-sub',
      '第 ' + (st.index + 1) + ' / ' + st.count + ' 期'));
    s2.appendChild(labelBox);

    // 滑块
    const scrubWrap = el('div', 'timeline-scrub-wrap');
    state.scrub = el('input', 'timeline-scrub');
    state.scrub.type = 'range';
    state.scrub.min = '0';
    state.scrub.max = String(st.count - 1);
    state.scrub.step = '1';
    state.scrub.value = String(st.index);
    state.scrub.setAttribute('aria-label', '时间轴');
    state.scrub.addEventListener('input', function () {
      const i = Number(state.scrub.value);
      window.LETimelineShell.setIndex(i);
      updateCurrent();
    });
    scrubWrap.appendChild(state.scrub);
    s2.appendChild(scrubWrap);

    // 刻度
    const ticks = el('div', 'timeline-ticks');
    const frames = st.frames;
    const n = frames.length;
    const stepN = Math.max(1, Math.ceil(n / 8));
    frames.forEach(function (f, i) {
      if (i % stepN !== 0 && i !== n - 1) return;
      const t = el('span', 'timeline-tick', T_short(f.time));
      t.title = f.name + ' · ' + T_full(f.time);
      ticks.appendChild(t);
    });
    s2.appendChild(ticks);

    // 控制按钮
    const ctrl = el('div', 'model-btn-row');
    ctrl.appendChild(button('⏮', 'model-btn tiny', function () {
      window.LETimelineShell.step(-1); updateCurrent();
    }, '上一期'));
    ctrl.appendChild(button(st.playing ? '⏸' : '▶', 'model-btn', function () {
      if (st.playing) window.LETimelineShell.pause();
      else window.LETimelineShell.play();
      render();
    }, st.playing ? '暂停' : '播放'));
    ctrl.appendChild(button('⏭', 'model-btn tiny', function () {
      window.LETimelineShell.step(1); updateCurrent();
    }, '下一期'));
    ctrl.appendChild(button('清除', 'model-btn tiny danger', function () {
      window.LETimelineShell.dispose();
      render();
      toast('已清除历史影像图层', 'ok');
    }, '移除所有历史影像图层'));
    s2.appendChild(ctrl);

    // 播放速度
    const speedRow = el('div', 'model-row');
    speedRow.appendChild(el('label', 'model-label', '播放间隔'));
    const speed = el('input', 'model-num');
    speed.type = 'number';
    speed.min = '200';
    speed.step = '100';
    speed.value = String(st.intervalMs);
    speed.addEventListener('change', function () {
      window.LETimelineShell.setIntervalMs(Number(speed.value));
      toast('播放间隔：' + Number(speed.value) + ' 毫秒', 'ok');
    });
    speedRow.appendChild(speed);
    s2.appendChild(speedRow);

    body.appendChild(s2);

    /* --- ③ 帧列表 --- */
    const s3 = section('③ 期次列表');
    state.listNode = el('div', 'model-list timeline-list');
    const groups = {};
    frames.forEach(function (f, i) {
      const key = f.time.getFullYear() + '-' +
        String(f.time.getMonth() + 1).padStart(2, '0');
      (groups[key] = groups[key] || []).push({ f: f, i: i });
    });
    Object.keys(groups).forEach(function (key) {
      const g = groups[key];
      const gTitle = el('div', 'timeline-group-title', key + '（' + g.length + ' 期）');
      state.listNode.appendChild(gTitle);
      g.forEach(function (item) {
        const row = el('div', 'model-item');
        const nm = el('span', 'model-item-name', item.f.name);
        nm.title = T_full(item.f.time);
        nm.addEventListener('click', function () {
          window.LETimelineShell.setIndex(item.i);
          updateCurrent();
          render();
        });
        row.appendChild(nm);
        row.appendChild(el('span', 'model-item-tag', T_short(item.f.time)));
        row.appendChild(button('⌖', 'model-btn tiny', function () {
          const r = window.LETimelineShell.getState().frames[item.i];
          flyToFrame(r);
        }, '定位到该期影像范围'));
        state.listNode.appendChild(row);
      });
    });
    s3.appendChild(state.listNode);
    body.appendChild(s3);

    /* --- ④ 说明 --- */
    const s4 = section('④ 说明');
    s4.appendChild(el('p', 'model-note',
      '时间轴同时驱动 Cesium 的时钟（太阳位置 / 阴影），' +
      '所以拖动滑块会连同光照一起变化 —— 这跟 Google Earth Pro 的历史影像回放一致。' +
      '两个相邻期次之间的时间点，若没有任何一期在容差内，会显示「该时段无影像」，' +
      '不会拿别的时相顶替。'));
    body.appendChild(s4);
  }

  function updateCount() {
    const c = byId('timeline-count');
    if (!c) return;
    const st = window.LETimelineShell ? window.LETimelineShell.getState() : null;
    c.textContent = st ? String(st.count) : '0';
  }

  function updateCurrent() {
    const st = window.LETimelineShell ? window.LETimelineShell.getState() : null;
    if (!st || !state.label) return;
    state.label.textContent = st.current ? st.current.text : '—';
    if (state.scrub) state.scrub.value = String(st.index);
    const c = byId('timeline-count');
    if (c) c.textContent = String(st.count);
  }

  function flyToFrame(frame) {
    if (!frame || !frame.bounds) {
      toast('该期没有范围信息，无法定位', 'error');
      return;
    }
    const le = getLE();
    if (!le || !le.flyTo) return;
    const b = frame.bounds.map(Number);
    le.flyTo({ rectangle: window.Cesium.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]) });
  }

  function T_short(d) {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  function T_full(d) {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') +
      '-' + String(dt.getDate()).padStart(2, '0');
  }

  /* ------------------------------------------------------------------ *
   * 扫描
   * ------------------------------------------------------------------ */

  async function doScan(refreshOnly) {
    if (state.busy) return;
    const shell = window.LETimelineShell;
    if (!shell) { toast('时间轴模块未就绪', 'error'); return; }
    state.busy = true;
    try {
      // 清单是启动时读的，运行期新入库的数据不会自己出现
      const li = window.LELocalImagery;
      if (li && typeof li.reload === 'function') {
        try { await li.reload(); } catch (err) { /* ignore */ }
      }
      const vault = window.LEVault;
      if (vault && typeof vault.refresh === 'function') {
        try { await vault.refresh(); } catch (err) { /* ignore */ }
      }
      status('正在扫描历史影像…');
      const frames = await shell.scan();
      if (!frames.length) {
        toast('没有找到带日期的历史影像数据集', 'error', 5000);
        status('未找到历史影像');
        render();
        return;
      }
      const tl = await shell.build(frames);
      state.timeline = tl;
      toast('已生成时间轴：' + tl.count + ' 期（' +
        (tl.spanDays ? tl.spanDays + ' 天' : '—') + '跨度）', 'ok', 4000);
      status('历史影像时间轴：' + tl.count + ' 期');
      render();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      toast('扫描失败：' + msg, 'error', 6000);
      status('历史影像扫描失败');
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
    const btn = byId('btn-timeline');
    if (btn) btn.addEventListener('click', function () { toggle(); });
    // 期数会随「扫描 → 建轴 → 清除」变化，所以订阅外壳事件实时刷新侧栏计数，
    // 而不是等面板重绘时顺带更新（面板没打开时也要刷新）。
    const shell = window.LETimelineShell;
    if (shell && typeof shell.on === 'function') {
      shell.on(function (kind) {
        updateCount();
        if (kind === 'time') updateCurrent();
      });
    }
  }

  window.LETimelineUI = {
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

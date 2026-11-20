/*
 * 拓扑检查与修复 · 界面（P3-4.13）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - ① 选择数据源
 *   - ② 选择要检查的规则
 *   - ③ 检查 → 问题清单（点一下飞到问题位置）
 *   - ④ 修复 → 修复记录 → 另存为新图层
 *
 * 对外 API：window.LETopologyUI
 *   init(le) / open() / close() / toggle() / render()
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
      rules: {
        selfIntersection: true,
        duplicatePoint: true,
        unclosedRing: true,
        tooFewPoints: true,
        overlapping: true,
        gap: true,
        unsnappedCrossing: true,
        outside: false,
      },
      duplicateToleranceM: 0.001,
      gapToleranceM: 0.5,
      snapToleranceM: 0.5,
    },
    issues: [],
    repairLog: [],
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
    const panel = el('div', 'le-panel model-panel tp-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '拓扑检查与修复');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '拓扑检查与修复'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'tp-panel-body';
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

  function numberField(label, value, onChange, step, unit) {
    const wrap = el('div', 'model-field');
    wrap.appendChild(el('div', 'model-field-label', label));
    const row = el('div', 'model-field-row');
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'model-input';
    inp.step = String(step == null ? 1 : step);
    inp.value = String(value);
    inp.addEventListener('change', function () { onChange(Number(inp.value)); });
    row.appendChild(inp);
    if (unit) row.appendChild(el('span', 'model-unit', unit));
    wrap.appendChild(row);
    return wrap;
  }

  function checkField(label, checked, onChange) {
    const wrap = el('label', 'model-check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', function () { onChange(cb.checked); });
    wrap.appendChild(cb);
    wrap.appendChild(el('span', null, label));
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * 规则表
   * ------------------------------------------------------------------ */

  const RULE_INFO = [
    { key: 'selfIntersection', label: '自相交', hint: '面的边界自己跟自己交叉' },
    { key: 'duplicatePoint', label: '重复点', hint: '连续两个坐标几乎一样' },
    { key: 'unclosedRing', label: '环未闭合', hint: '面的首尾坐标不重合' },
    { key: 'tooFewPoints', label: '点数不足', hint: '点太少，构不成几何' },
    { key: 'overlapping', label: '面重叠', hint: '两个面压在一起' },
    { key: 'gap', label: '缝隙', hint: '本该相邻的面之间留了缝' },
    { key: 'unsnappedCrossing', label: '交点未打断', hint: '两条线交叉处没有节点' },
    { key: 'outside', label: '点不在面内', hint: '点落在所有面之外' },
  ];

  const SEVERITY_LABEL = { error: '错误', warning: '警告', info: '提示' };

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';
    const shell = window.LETopologyShell;

    /* --- ① 数据源 --- */
    const s1 = section('① 选择数据源');
    const srcs = shell.sources();
    s1.appendChild(el('div', 'model-field-label', '检查哪些要素'));
    s1.appendChild(select(
      srcs.map(function (s) { return { value: s.id, label: s.name }; }),
      state.form.sourceId,
      function (val) {
        state.form.sourceId = val;
        state.issues = [];
        state.repairLog = [];
        render();
      }
    ));
    s1.appendChild(el('p', 'model-note',
      '数据源共 ' + srcs.length + ' 项（绘制要素 + ' + shell.vectorLayers().length +
      ' 个矢量图层）。检查在浏览器内完成，纯离线。'));
    body.appendChild(s1);

    /* --- ② 规则 --- */
    const s2 = section('② 检查规则');
    const grid = el('div', 'tp-rule-grid');
    RULE_INFO.forEach(function (r) {
      const item = el('label', 'tp-rule-item');
      item.title = r.hint;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.form.rules[r.key];
      cb.addEventListener('change', function () {
        state.form.rules[r.key] = cb.checked;
      });
      item.appendChild(cb);
      item.appendChild(el('span', 'tp-rule-label', r.label));
      grid.appendChild(item);
    });
    s2.appendChild(grid);

    s2.appendChild(el('div', 'model-field-label', '容差'));
    s2.appendChild(numberField('重复点判定阈值', state.form.duplicateToleranceM, function (v) {
      state.form.duplicateToleranceM = v;
    }, 0.001, 'm'));
    s2.appendChild(numberField('缝隙判定阈值', state.form.gapToleranceM, function (v) {
      state.form.gapToleranceM = v;
    }, 0.1, 'm'));
    s2.appendChild(numberField('交点打断阈值', state.form.snapToleranceM, function (v) {
      state.form.snapToleranceM = v;
    }, 0.1, 'm'));
    body.appendChild(s2);

    /* --- ③ 检查 --- */
    const s3 = section('③ 执行检查');
    const row3 = el('div', 'model-btn-row');
    row3.appendChild(button('🔍 开始检查', 'model-btn primary', function () {
      runCheck();
    }, '检查所选数据的拓扑问题'));
    row3.appendChild(button('清除标记', 'model-btn', function () {
      shell.clearMarks();
      render();
    }));
    s3.appendChild(row3);
    body.appendChild(s3);

    /* --- ④ 问题清单 --- */
    const s4 = section('④ 问题清单');
    if (!state.issues.length) {
      s4.appendChild(el('p', 'model-note',
        state.form.sourceId === '__all__'
          ? '还没有检查。选好数据源与规则后点「开始检查」。'
          : '还没有检查。'));
    } else {
      const st = shell.getState();
      const errs = state.issues.filter(function (i) { return i.severity === 'error'; }).length;
      const warns = state.issues.filter(function (i) { return i.severity === 'warning'; }).length;
      s4.appendChild(el('p', 'model-note',
        '共 ' + state.issues.length + ' 条：错误 ' + errs + '、警告 ' + warns +
        '；检查 ' + st.featureCount + ' 个要素，耗时 ' +
        (st.lastCheckMs || 0).toFixed(1) + ' ms。'));

      const list = el('div', 'tp-issue-list');
      state.issues.slice(0, 300).forEach(function (iss) {
        const item = el('div', 'tp-issue tp-sev-' + iss.severity);
        item.appendChild(el('span', 'tp-issue-rule',
          (window.LETopology.RULE_LABELS[iss.rule] || iss.rule)));
        item.appendChild(el('span', 'tp-issue-msg', iss.message || ''));
        item.appendChild(el('span', 'tp-issue-sev', SEVERITY_LABEL[iss.severity] || ''));
        if (iss.at) {
          item.classList.add('tp-clickable');
          item.addEventListener('click', function () {
            const le = getLE();
            if (!le || !le.viewer) return;
            le.viewer.camera.flyTo({
              destination: window.Cesium.Cartesian3.fromDegrees(iss.at.lon, iss.at.lat, 30000),
              duration: 1.2,
            });
          });
        }
        list.appendChild(item);
      });
      s4.appendChild(list);
      if (state.issues.length > 300) {
        s4.appendChild(el('p', 'model-note',
          '共 ' + state.issues.length + ' 条，列表只显示前 300 条。'));
      }

      const row4 = el('div', 'model-btn-row');
      row4.appendChild(button('在地球上标记', 'model-btn primary', function () {
        const n = shell.markIssues(state.issues);
        toast('已标记 ' + n + ' 处问题', 'ok');
        render();
      }));
      row4.appendChild(button('导出问题清单', 'model-btn', function () {
        shell.exportIssues(state.issues);
      }));
      s4.appendChild(row4);
    }
    body.appendChild(s4);

    /* --- ⑤ 修复 --- */
    const s5 = section('⑤ 修复');
    const row5 = el('div', 'model-btn-row');
    row5.appendChild(button('🛠 修复几何', 'model-btn primary', function () {
      runRepair();
    }, '去重复点 / 闭合环 / 拆自相交 / 统一绕向'));
    row5.appendChild(button('另存为新图层', 'model-btn', function () {
      const r = shell.saveRepairedAsLayer({
        sourceId: state.form.sourceId,
        duplicateToleranceM: state.form.duplicateToleranceM,
      });
      if (r) toast('已另存为图层（' + r.count + ' 个要素）', 'ok', 3200);
      render();
    }));
    s5.appendChild(row5);
    s5.appendChild(el('p', 'model-note',
      '修复会：去掉重复点、闭合环、把自相交的面拆成合法面、统一绕向为逆时针。' +
      '原图层不动，修复结果可另存为新图层。'));

    if (state.repairLog.length) {
      const rl = el('div', 'tp-repair-list');
      state.repairLog.forEach(function (r) {
        const item = el('div', 'tp-repair-item');
        item.appendChild(el('span', 'tp-repair-name', r.name || r.id));
        item.appendChild(el('span', 'tp-repair-what', r.applied.join('；')));
        rl.appendChild(item);
      });
      s5.appendChild(el('div', 'model-field-label', '修复记录'));
      s5.appendChild(rl);
    }
    body.appendChild(s5);

    /* --- ⑥ 说明 --- */
    const s6 = section('⑥ 说明');
    s6.appendChild(el('p', 'model-note',
      '自相交、重叠、缝隙、交点位置都是**精确几何计算**；' +
      '重叠面积与缝隙面积用网格采样给量级（约 0.1% 误差）。' +
      '全程离线，不联网。'));
    body.appendChild(s6);
  }

  /* ------------------------------------------------------------------ *
   * 执行
   * ------------------------------------------------------------------ */

  function activeRules() {
    return Object.keys(state.form.rules).filter(function (k) {
      return state.form.rules[k];
    });
  }

  function runCheck() {
    const shell = window.LETopologyShell;
    status('正在检查拓扑…');
    const r = shell.check({
      sourceId: state.form.sourceId,
      rules: activeRules(),
      duplicateToleranceM: state.form.duplicateToleranceM,
      gapToleranceM: state.form.gapToleranceM,
      snapToleranceM: state.form.snapToleranceM,
      requireClosedRing: true,
    });
    status('');
    state.issues = r.issues;
    shell.markIssues(r.issues);
    render();
    toast('检查完成：' + r.count + ' 条问题（' + r.ms.toFixed(1) + ' ms）',
      r.count ? 'warn' : 'ok', 3600);
  }

  function runRepair() {
    const shell = window.LETopologyShell;
    status('正在修复几何…');
    const r = shell.repair({
      sourceId: state.form.sourceId,
      duplicateToleranceM: state.form.duplicateToleranceM,
      ensureCCW: true,
      fixSelfIntersection: true,
    });
    status('');
    state.repairLog = r.applied;
    render();
    toast(r.count ? '已修复 ' + r.count + ' 个要素' : '没有需要修复的要素',
      r.count ? 'ok' : 'ok', 3600);
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

    const btn = byId('btn-topology');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }

    window.LETopologyShell.on(function (kind) {
      if (kind === 'check' && state.panel &&
          !state.panel.classList.contains('hidden')) {
        render();
      }
    });
  }

  window.LETopologyUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
    runCheck: runCheck,
    runRepair: runRepair,
    getState: function () {
      return {
        issueCount: state.issues.length,
        repairCount: state.repairLog.length,
        sourceId: state.form.sourceId,
        rules: state.form.rules,
      };
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

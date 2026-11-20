/*
 * NetCDF 气象栅格叠加 · 界面（P2-4.11）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - ① 打开 .nc 文件（浏览器内直接解析，不经后端）
 *   - ② 要素选择：变量 / 时刻 / 高度层
 *   - ③ 显示：色带 / 拉伸方式 / 透明度
 *   - ④ 叠加：栅格叠加 + 风向箭头
 *
 * 对外 API：window.LENetCDFUI
 *   init(le) / open() / close() / toggle() / render()
 */
(function () {
  'use strict';

  const state = {
    le: null,
    panel: null,
    body: null,
    bound: false,
    fileInput: null,
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
    const panel = el('div', 'le-panel model-panel nc-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'NetCDF 气象栅格叠加');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, 'NetCDF · 气象栅格叠加'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'nc-panel-body';
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
    s.addEventListener('change', function () {
      onChange(s.value);
    });
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';
    const shell = window.LENetCDFShell;
    const st = shell ? shell.getState() : null;

    /* --- ① 打开文件 --- */
    const s1 = section('① 打开 NetCDF 文件');
    s1.appendChild(el('p', 'model-note',
      '支持经典格式（.nc，CDF-1 / CDF-2）。文件在浏览器里直接解析，' +
      '不上传、不联网，纯离线可用。'));

    const row1 = el('div', 'model-btn-row');
    row1.appendChild(button('📂 打开 .nc 文件…', 'model-btn primary', function () {
      pickFile();
    }, '选择本机的 .nc 文件'));
    row1.appendChild(button('载入测试样本', 'model-btn', function () {
      loadFixture();
    }, '载入 tools 生成的示例数据'));
    s1.appendChild(row1);

    if (st && st.loaded) {
      const info = el('p', 'model-note',
        '已载入：' + st.fileName + '　变量 ' + st.desc.vars.length +
        ' 个' + (st.desc.times.length ? '　时刻 ' + st.desc.times.length + ' 个' : '') +
        (st.desc.levels.length ? '　层次 ' + st.desc.levels.length + ' 层' : ''));
      s1.appendChild(info);
    }
    body.appendChild(s1);

    if (!st || !st.loaded) {
      const s2 = section('② 要素');
      s2.appendChild(el('p', 'model-note', '先打开一个 .nc 文件。'));
      body.appendChild(s2);
      return;
    }

    const desc = st.desc;

    /* --- ② 要素 --- */
    const s2 = section('② 选择要素');
    const vars = desc.vars.filter(function (v) { return !v.isCoord; });
    if (vars.length) {
      const lab = el('div', 'model-field-label', '气象要素');
      s2.appendChild(lab);
      s2.appendChild(select(
        vars.map(function (v) {
          return {
            value: v.name,
            label: v.label + '（' + v.name + '）' +
              (v.units ? ' · ' + v.units : '') +
              (v.ok ? '' : ' ⚠ 读取失败'),
          };
        }),
        st.variable ? st.variable.name : '',
        function (val) {
          shell.setVariable(val);
          render();
          shell.apply();
        }));
    }

    if (desc.times.length > 1) {
      const lab = el('div', 'model-field-label', '时刻');
      s2.appendChild(lab);
      s2.appendChild(select(
        desc.times.map(function (t, i) {
          return { value: i, label: t };
        }),
        st.timeIndex,
        function (val) {
          shell.setTimeIndex(Number(val));
          shell.apply();
        }));
    }

    if (desc.levels.length > 1) {
      const lab = el('div', 'model-field-label', '高度层 / 气压层');
      s2.appendChild(lab);
      s2.appendChild(select(
        desc.levels.map(function (l, i) {
          return { value: i, label: l.label };
        }),
        st.levelIndex,
        function (val) {
          shell.setLevelIndex(Number(val));
          shell.apply();
        }));
    }
    body.appendChild(s2);

    /* --- ③ 显示 --- */
    const s3 = section('③ 显示方式');
    const R = window.LENetCDFRender;

    const labRamp = el('div', 'model-field-label', '色带');
    s3.appendChild(labRamp);
    const rampNames = Object.keys(R.RAMPS);
    s3.appendChild(select(
      rampNames.map(function (n) {
        return { value: n, label: R.rampLabel(n) };
      }),
      st.ramp,
      function (val) {
        shell.setRamp(val);
        shell.apply();
      }));

    const labStretch = el('div', 'model-field-label', '数值拉伸');
    s3.appendChild(labStretch);
    s3.appendChild(select([
      { value: 'auto', label: '自动（分量对称，其余分位）' },
      { value: 'minmax', label: '最小–最大（全范围）' },
      { value: 'percentile', label: '2%–98% 分位（抗离群）' },
      { value: 'symmetric', label: '关于 0 对称（正负分量）' },
      { value: 'stddev', label: '均值 ± 2σ' },
    ], st.stretch, function (val) {
      shell.setStretch(val);
      shell.apply();
    }));

    // 图例
    const legend = buildLegend();
    if (legend) s3.appendChild(legend);
    body.appendChild(s3);

    /* --- ④ 叠加 --- */
    const s4 = section('④ 叠加到地球');
    const row4 = el('div', 'model-btn-row');
    row4.appendChild(button('🗺 应用叠加', 'model-btn primary', function () {
      if (shell.apply()) toast('已叠加到地球上', 'ok');
    }, '把当前要素渲染成栅格贴到地球'));
    row4.appendChild(button(st.visible ? '隐藏' : '显示', 'model-btn', function () {
      if (st.visible) shell.hide(); else shell.show();
      render();
    }, '显示 / 隐藏叠加层'));
    row4.appendChild(button('➤ 风向箭头', 'model-btn', function () {
      shell.showWindArrows({});
      render();
    }, '在场上叠加风向矢量箭头'));
    row4.appendChild(button('✕ 移除叠加', 'model-btn danger', function () {
      shell.removeLayer();
      render();
    }, '移除地球上的叠加图层'));
    s4.appendChild(row4);
    body.appendChild(s4);

    /* --- ⑤ 说明 --- */
    const s5 = section('⑤ 说明');
    s5.appendChild(el('p', 'model-note',
      '变量按 CF 约定自动识别（standard_name / units / 坐标轴）。' +
      '风场可以叠加风向箭头；栅格用色带渲染，' +
      '拉伸区间有三种可选，2%–98% 分位最不容易被离群点带偏。'));
    body.appendChild(s5);
  }

  /** 数值图例。 */
  function buildLegend() {
    const shell = window.LENetCDFShell;
    const st = shell.getState();
    const rendered = shell.renderCanvas ? null : null;
    // 复用当前拉伸区间
    const slice = shell.currentSlice();
    if (!slice) return null;
    const R = window.LENetCDFRender;
    const mode = st.stretch === 'auto'
      ? (st.variable && R.isSigned(st.variable.kind) ? 'symmetric' : 'percentile')
      : st.stretch;
    const rg = R.stretchRange(slice.data, mode, 0.02);

    const wrap = el('div', 'nc-legend');
    wrap.appendChild(el('div', 'model-field-label',
      '图例：' + rg.min.toFixed(2) + ' ~ ' + rg.max.toFixed(2) +
      (st.variable && st.variable.units ? ' ' + st.variable.units : '')));

    const bar = el('canvas', 'nc-legend-bar');
    bar.width = 240;
    bar.height = 14;
    const ctx = bar.getContext('2d');
    const img = ctx.createImageData(bar.width, bar.height);
    for (let x = 0; x < bar.width; x++) {
      const t = x / (bar.width - 1);
      const c = R.sampleRamp(st.ramp, t);
      for (let y = 0; y < bar.height; y++) {
        const o = (y * bar.width + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    wrap.appendChild(bar);
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * 文件选择
   * ------------------------------------------------------------------ */

  function pickFile() {
    const input = state.fileInput || (state.fileInput = makeFileInput());
    input.value = '';
    input.click();
  }

  function makeFileInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nc,.cdf,application/x-netcdf';
    input.style.display = 'none';
    input.addEventListener('change', async function () {
      const f = input.files && input.files[0];
      if (!f) return;
      const okLoad = await window.LENetCDFShell.openFile(f);
      if (okLoad) {
        render();
        window.LENetCDFShell.apply();
        toast('已载入 ' + f.name, 'ok');
      } else {
        render();
      }
    });
    document.body.appendChild(input);
    return input;
  }

  /** 载入测试样本（需要服务器开着，且样本已生成到 tmp/nc）。 */
  async function loadFixture() {
    try {
      const res = await fetch('tmp/nc/meteorology.nc');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const okLoad = window.LENetCDFShell.loadArrayBuffer(buf, 'meteorology.nc');
      if (okLoad) {
        render();
        window.LENetCDFShell.apply();
        toast('已载入测试样本', 'ok');
      } else {
        render();
      }
    } catch (err) {
      toast('取不到测试样本：' + err.message +
        '（先跑 python tools/make_nc_fixture.py tmp/nc）', 'error', 6000);
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

    const btn = byId('btn-netcdf');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }

    // 面板内容随外壳事件刷新
    window.LENetCDFShell.on(function (kind) {
      if (kind === 'nc' && state.panel && !state.panel.classList.contains('hidden')) {
        render();
      }
    });
  }

  window.LENetCDFUI = {
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

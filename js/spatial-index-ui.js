/*
 * 空间索引与空间查询 · 界面（P2-4.12）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - ① 数据源：全部 / 绘制要素 / 矢量图层
 *   - ② 查询范围：圆（经纬度 + 半径）/ 多边形（用绘制的面，或手输经纬度）
 *   - ③ 空间关系：相交 / 包含在内 / 中心点在内
 *   - ④ 结果：命中列表 + 高亮 + 导出
 *
 * 对外 API：window.LESpatialUI
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
      rangeKind: 'circle',
      lon: 116.4,
      lat: 39.9,
      radiusKm: 50,
      polyText: '',
      drawPolyId: '',
      mode: 'intersects',
    },
    results: [],
    lastQuery: null,
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
    const panel = el('div', 'le-panel model-panel sp-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '空间索引与空间查询');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '空间索引 · 按位置选择'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'sp-panel-body';
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
    const lab = el('div', 'model-field-label', label);
    wrap.appendChild(lab);
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

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';
    const shell = window.LESpatialShell;

    /* --- ① 数据源 --- */
    const s1 = section('① 选择数据源');
    const srcs = shell.sources();
    s1.appendChild(el('div', 'model-field-label', '要查询哪些要素'));
    s1.appendChild(select(
      srcs.map(function (s) { return { value: s.id, label: s.name }; }),
      state.form.sourceId,
      function (val) {
        state.form.sourceId = val;
        state.results = [];
        render();
      }
    ));
    const srcCount = shell.vectorLayers().length;
    s1.appendChild(el('p', 'model-note',
      '数据源共 ' + srcs.length + ' 项（绘制要素 + ' + srcCount +
      ' 个矢量图层）。索引在浏览器内建立，不依赖任何外部程序。'));
    body.appendChild(s1);

    /* --- ② 查询范围 --- */
    const s2 = section('② 查询范围');
    s2.appendChild(el('div', 'model-field-label', '范围类型'));
    s2.appendChild(select([
      { value: 'circle', label: '圆（按圆心 + 半径）' },
      { value: 'polygon', label: '多边形（用绘制好的面 / 手输坐标）' },
    ], state.form.rangeKind, function (val) {
      state.form.rangeKind = val;
      render();
    }));

    if (state.form.rangeKind === 'circle') {
      s2.appendChild(numberField('圆心经度', state.form.lon, function (v) {
        state.form.lon = v;
      }, 0.001, '°'));
      s2.appendChild(numberField('圆心纬度', state.form.lat, function (v) {
        state.form.lat = v;
      }, 0.001, '°'));
      s2.appendChild(numberField('半径', state.form.radiusKm, function (v) {
        state.form.radiusKm = v;
      }, 1, 'km'));
      const rowFly = el('div', 'model-btn-row');
      rowFly.appendChild(button('飞到圆心', 'model-btn', function () {
        const le = getLE();
        if (le && le.flyTo) {
          le.flyTo({ lon: state.form.lon, lat: state.form.lat });
        }
      }, '把相机飞到圆心'));
      s2.appendChild(rowFly);
    } else {
      // 用绘制的面
      const polys = [];
      if (window.LEDraw && typeof window.LEDraw.list === 'function') {
        window.LEDraw.list().forEach(function (f) {
          if (f.type === 'polygon') polys.push({ id: f.id, name: f.name });
        });
      }
      s2.appendChild(el('div', 'model-field-label', '用绘制好的面'));
      if (polys.length) {
        s2.appendChild(select(
          [{ value: '', label: '（不使用）' }].concat(polys.map(function (p) {
            return { value: p.id, label: p.name };
          })),
          state.form.drawPolyId,
          function (val) {
            state.form.drawPolyId = val;
            state.form.polyText = '';
            render();
          }
        ));
      } else {
        s2.appendChild(el('p', 'model-note',
          '还没有绘制多边形。可以点「绘制与标注 → 面」画一个，或者在下面直接输入坐标。'));
      }

      s2.appendChild(el('div', 'model-field-label', '坐标串（lon,lat;lon,lat;…）'));
      const ta = document.createElement('textarea');
      ta.className = 'model-input';
      ta.rows = 3;
      ta.placeholder = '116.3,39.8;117.0,39.8;117.0,40.2;116.3,40.2';
      ta.value = state.form.polyText;
      ta.addEventListener('input', function () {
        state.form.polyText = ta.value;
      });
      s2.appendChild(ta);
    }
    body.appendChild(s2);

    /* --- ③ 空间关系 --- */
    const s3 = section('③ 空间关系');
    s3.appendChild(el('div', 'model-field-label', '判定方式'));
    s3.appendChild(select([
      { value: 'intersects', label: '相交（碰到就算，与 QGIS「相交」一致）' },
      { value: 'within', label: '完全在范围内（与 QGIS「包含」一致）' },
      { value: 'center', label: '中心点在范围内' },
    ], state.form.mode, function (val) {
      state.form.mode = val;
    }));
    s3.appendChild(el('p', 'model-note',
      '相交：要素任何部分进入范围即命中；完全在范围内：要素整体被范围包住。'));
    body.appendChild(s3);

    /* --- ④ 查询 --- */
    const s4 = section('④ 执行查询');
    const row4 = el('div', 'model-btn-row');
    row4.appendChild(button('🔍 查询', 'model-btn primary', function () {
      runQuery();
    }, '按位置选择要素'));
    row4.appendChild(button('清除高亮', 'model-btn', function () {
      shell.clearHighlight();
      render();
    }));
    s4.appendChild(row4);
    body.appendChild(s4);

    /* --- ⑤ 结果 --- */
    const s5 = section('⑤ 查询结果');
    if (!state.results.length) {
      s5.appendChild(el('p', 'model-note',
        state.lastQuery
          ? '上次查询命中 0 个要素。'
          : '还没有查询结果。选好数据源与范围后点「查询」。'));
    } else {
      const st = shell.getState();
      s5.appendChild(el('p', 'model-note',
        '命中 ' + state.results.length + ' 个 / 共 ' + st.total +
        ' 个要素，耗时 ' + (st.lastMs || 0).toFixed(1) + ' ms。'));

      const list = el('div', 'sp-result-list');
      state.results.slice(0, 200).forEach(function (f) {
        const item = el('div', 'sp-result-item');
        item.appendChild(el('span', 'sp-result-type', typeLabel(f.type)));
        item.appendChild(el('span', 'sp-result-name', f.name || f.id));
        item.addEventListener('click', function () {
          const le = getLE();
          if (!le || !le.viewer) return;
          if (f.entity) {
            le.viewer.flyTo(f.entity, { duration: 1.2 }).catch(function () {});
          } else {
            const rp = window.LESpatialIndex.representativePoint(f);
            if (rp) le.flyTo({ lon: rp.lon, lat: rp.lat });
          }
        });
        list.appendChild(item);
      });
      s5.appendChild(list);
      if (state.results.length > 200) {
        s5.appendChild(el('p', 'model-note',
          '共 ' + state.results.length + ' 条，列表只显示前 200 条。'));
      }

      const row5 = el('div', 'model-btn-row');
      row5.appendChild(button('高亮命中要素', 'model-btn primary', function () {
        const n = shell.highlight(state.results);
        toast('已高亮 ' + n + ' 个要素', 'ok');
        render();
      }));
      row5.appendChild(button('导出 GeoJSON', 'model-btn', function () {
        shell.exportResults('geojson');
      }));
      row5.appendChild(button('导出 CSV', 'model-btn', function () {
        shell.exportResults('csv');
      }));
      s5.appendChild(row5);
    }
    body.appendChild(s5);

    /* --- ⑥ 说明 --- */
    const s6 = section('⑥ 说明');
    s6.appendChild(el('p', 'model-note',
      '内部用均匀网格空间索引做粗筛，再跑精确几何谓词，' +
      '因此要素再多也不会逐个遍历全表。全程离线，不联网。'));
    body.appendChild(s6);
  }

  function typeLabel(t) {
    if (t === 'point') return '点';
    if (t === 'line') return '线';
    if (t === 'polygon') return '面';
    return t || '';
  }

  /* ------------------------------------------------------------------ *
   * 执行查询
   * ------------------------------------------------------------------ */

  function currentRegion() {
    const shell = window.LESpatialShell;
    const f = state.form;
    if (f.rangeKind === 'circle') {
      if (!isFinite(f.lon) || !isFinite(f.lat)) return null;
      if (!(f.radiusKm > 0)) return null;
      return shell.circleRegion(f.lon, f.lat, f.radiusKm);
    }
    // 多边形：优先用绘制的面
    if (f.drawPolyId && window.LEDraw && typeof window.LEDraw.getFeatures === 'function') {
      const feat = window.LEDraw.getFeatures().find(function (x) {
        return x.id === f.drawPolyId;
      });
      if (feat) return shell.polygonRegion(feat);
    }
    if (f.polyText) {
      const r = shell.polygonRegion(f.polyText);
      if (r) return r;
    }
    return null;
  }

  function runQuery() {
    const shell = window.LESpatialShell;
    const region = currentRegion();
    if (!region) {
      toast('查询范围不合法：检查经纬度、半径或多边形坐标', 'error', 5000);
      return;
    }
    status('正在按位置查询…');
    const r = shell.query({
      region: region,
      mode: state.form.mode,
      sourceId: state.form.sourceId,
      rebuild: true,
    });
    status('');
    state.results = r.results || [];
    state.lastQuery = true;
    shell.highlight(state.results);
    render();
    toast('命中 ' + state.results.length + ' 个要素（' +
      (r.ms || 0).toFixed(1) + ' ms）', 'ok', 3000);
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

    const btn = byId('btn-spatial');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }

    window.LESpatialShell.on(function (kind) {
      if (kind === 'query' && state.panel &&
          !state.panel.classList.contains('hidden')) {
        render();
      }
    });
  }

  window.LESpatialUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
    runQuery: runQuery,
    getState: function () {
      return {
        resultCount: state.results.length,
        sourceId: state.form.sourceId,
        mode: state.form.mode,
        rangeKind: state.form.rangeKind,
      };
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

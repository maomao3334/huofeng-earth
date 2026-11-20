/*
 * 网络分析 · 界面（P3-4.16）
 * ---------------------------------------------------------------------------
 * 浮层面板（沿用 model-panel 样式）：
 *   - ① 选择网络数据源
 *   - ② 最短路：地图上点起点 / 终点 → 算路径 → 画到地球上
 *   - ③ 服务区：地图上点起点 + 阈值 → 算可达范围 → 画成多边形
 *
 * 对外 API：window.LENetworkUI
 *   init(le) / open() / close() / toggle() / render()
 *   setStart(lon,lat) / setEnd(lon,lat) / runPath() / runArea()
 */
(function () {
  'use strict';

  const state = {
    le: null,
    panel: null,
    body: null,
    bound: false,
    handler: null,
    picking: null,        // 'start' | 'end' | null
    form: {
      sourceId: '__all__',
      limitKm: 2,
      maxSnapM: 0,
    },
    start: null,          // {lon, lat}
    end: null,            // {lon, lat}
    pathResult: null,
    areaResult: null,
    marks: [],
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

  function shell() { return window.LENetworkShell; }

  /* ------------------------------------------------------------------ *
   * 面板骨架
   * ------------------------------------------------------------------ */

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('div', 'le-panel model-panel nw-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '网络分析');

    const head = el('div', 'le-panel-head');
    head.appendChild(el('h4', null, '网络分析'));
    const actions = el('div', 'le-panel-actions');
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'model-panel-body');
    body.id = 'nw-panel-body';
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

  /* ------------------------------------------------------------------ *
   * 地图拾取
   * ------------------------------------------------------------------ */

  function pickAt(viewer, screenPos) {
    const C = window.Cesium;
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

  function bindPicking() {
    if (state.handler) return;
    const le = getLE();
    if (!le || !le.viewer) return;
    const C = window.Cesium;
    const handler = new C.ScreenSpaceEventHandler(le.viewer.scene.canvas);
    handler.setInputAction(function (movement) {
      if (!state.picking) return;
      const hit = pickAt(le.viewer, movement.position);
      if (!hit) return;
      if (state.picking === 'start') {
        state.start = hit;
        toast('已设置起点', 'ok', 1600);
      } else if (state.picking === 'end') {
        state.end = hit;
        toast('已设置终点', 'ok', 1600);
      }
      state.picking = null;
      drawMarks();
      render();
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    state.handler = handler;
  }

  function clearMarks() {
    const le = getLE();
    if (le && le.viewer) {
      for (const e of state.marks) {
        try { le.viewer.entities.remove(e); } catch (err) { /* ignore */ }
      }
    }
    state.marks = [];
  }

  function drawMarks() {
    const le = getLE();
    if (!le || !le.viewer) return;
    clearMarks();
    const C = window.Cesium;
    const add = function (p, color, text) {
      if (!p) return;
      try {
        state.marks.push(le.viewer.entities.add({
          name: text,
          position: C.Cartesian3.fromDegrees(p.lon, p.lat, 0),
          point: {
            pixelSize: 12,
            color: C.Color.fromCssColorString(color).withAlpha(0.95),
            outlineColor: C.Color.BLACK.withAlpha(0.9),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
          },
          label: {
            text: text,
            font: '12px "Microsoft YaHei", sans-serif',
            fillColor: C.Color.WHITE,
            outlineColor: C.Color.BLACK,
            outlineWidth: 3,
            style: C.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new C.Cartesian2(0, -18),
            verticalOrigin: C.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            backgroundColor: C.Color.fromCssColorString('rgba(0,0,0,0.7)'),
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
          },
        }));
      } catch (err) { /* ignore */ }
    };
    add(state.start, '#3cb44b', '起点');
    add(state.end, '#e6194b', '终点');
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function fmtLonLat(p) {
    if (!p) return '未设置';
    return p.lon.toFixed(6) + '°E, ' + p.lat.toFixed(6) + '°N';
  }

  function render() {
    const body = state.body;
    if (!body) return;
    body.innerHTML = '';
    const sh = shell();
    if (!sh) return;

    /* --- ① 数据源 --- */
    const s1 = section('① 网络数据源');
    const srcs = sh.sources();
    s1.appendChild(el('div', 'model-field-label', '用哪些线要素组网'));
    s1.appendChild(select(
      srcs.map(function (s) { return { value: s.id, label: s.name }; }),
      state.form.sourceId,
      function (val) {
        state.form.sourceId = val;
        state.pathResult = null;
        state.areaResult = null;
        sh.clearResults();
        render();
      }
    ));
    const rowBuild = el('div', 'model-btn-row');
    rowBuild.appendChild(button('构建路网', 'model-btn primary', function () {
      status('正在构建路网…');
      const r = sh.buildGraph({ sourceId: state.form.sourceId });
      status('');
      if (!r.ok) {
        toast(r.error || '建网失败', 'error', 3600);
      } else {
        toast('路网已构建：' + r.summary.nodes + ' 个节点 / ' +
          r.summary.edges + ' 条边（' + r.ms.toFixed(1) + ' ms）', 'ok', 3600);
      }
      render();
    }, '把所选线要素打断成图'));
    rowBuild.appendChild(button('清除结果', 'model-btn', function () {
      sh.clearResults();
      state.pathResult = null;
      state.areaResult = null;
      render();
    }));
    s1.appendChild(rowBuild);

    const st = sh.getState();
    if (st.hasGraph) {
      s1.appendChild(el('p', 'model-note',
        '当前路网：' + st.summary.nodes + ' 节点、' + st.summary.edges + ' 边，总长 ' +
        (st.summary.lengthM / 1000).toFixed(2) + ' km，建图耗时 ' +
        st.buildMs.toFixed(1) + ' ms。'));
    } else {
      s1.appendChild(el('p', 'model-note',
        '还没有构建路网。点「构建路网」把所选线要素打断成图（交叉点会打断，单行道按属性识别）。'));
    }
    body.appendChild(s1);

    /* --- ② 最短路 --- */
    const s2 = section('② 最短路');
    const rowPts = el('div', 'model-btn-row');
    rowPts.appendChild(button(
      state.picking === 'start' ? '● 点击地图设起点…' : '设起点',
      state.picking === 'start' ? 'model-btn primary' : 'model-btn',
      function () {
        state.picking = state.picking === 'start' ? null : 'start';
        bindPicking();
        render();
      },
      '在地图上单击设置起点'));
    rowPts.appendChild(button(
      state.picking === 'end' ? '● 点击地图设终点…' : '设终点',
      state.picking === 'end' ? 'model-btn primary' : 'model-btn',
      function () {
        state.picking = state.picking === 'end' ? null : 'end';
        bindPicking();
        render();
      },
      '在地图上单击设置终点'));
    s2.appendChild(rowPts);
    s2.appendChild(el('div', 'nw-pt-row',
      el('span', 'nw-pt-label', '起点'), el('span', 'nw-pt-val', fmtLonLat(state.start))));
    s2.appendChild(el('div', 'nw-pt-row',
      el('span', 'nw-pt-label', '终点'), el('span', 'nw-pt-val', fmtLonLat(state.end))));

    const rowRun = el('div', 'model-btn-row');
    rowRun.appendChild(button('算最短路', 'model-btn primary', function () {
      runPath();
    }, '沿路网算起终点间的最短路径'));
    rowRun.appendChild(button('导出 GeoJSON', 'model-btn', function () {
      sh.exportPath(state.pathResult);
    }));
    s2.appendChild(rowRun);

    if (state.pathResult && state.pathResult.ok) {
      const r = state.pathResult;
      s2.appendChild(el('p', 'model-note',
        '路径长度 ' + r.distanceKm.toFixed(3) + ' km，经过 ' + r.steps +
        ' 个节点。起点贴边偏差 ' + r.start.snapM.toFixed(1) + ' m，终点 ' +
        r.end.snapM.toFixed(1) + ' m。'));
    } else if (state.pathResult && state.pathResult.error) {
      s2.appendChild(el('p', 'nw-error', state.pathResult.error));
    }
    body.appendChild(s2);

    /* --- ③ 服务区 --- */
    const s3 = section('③ 服务区（等距可达范围）');
    s3.appendChild(numberField('可达半径', state.form.limitKm, function (v) {
      state.form.limitKm = v;
    }, 0.5, 'km'));
    const rowArea = el('div', 'model-btn-row');
    rowArea.appendChild(button('算服务区', 'model-btn primary', function () {
      runArea();
    }, '以起点为中心算阈值内的可达范围'));
    rowArea.appendChild(button('导出 GeoJSON', 'model-btn', function () {
      sh.exportArea(state.areaResult);
    }));
    s3.appendChild(rowArea);
    s3.appendChild(el('div', 'model-btn-row',
      button('另存为图层', 'model-btn', function () {
        const r = sh.saveAreaAsLayer(state.areaResult);
        if (r) toast('已另存为图层（' + r.count + ' 个面）', 'ok', 3000);
      })));

    if (state.areaResult && state.areaResult.ok) {
      const r = state.areaResult;
      s3.appendChild(el('p', 'model-note',
        '半径 ' + (r.limitM / 1000).toFixed(2) + ' km，覆盖 ' +
        r.reachedCells + ' 个网格（约 ' + r.areaKm2.toFixed(2) + ' km²），' +
        '边界环 ' + r.rings.length + ' 个。'));
    } else if (state.areaResult && state.areaResult.error) {
      s3.appendChild(el('p', 'nw-error', state.areaResult.error));
    }
    body.appendChild(s3);

    /* --- ④ 说明 --- */
    const s4 = section('④ 说明');
    s4.appendChild(el('p', 'model-note',
      '路网由线/面要素自动打断交叉点而成，边权是大地线长度（米）。' +
      '要素属性里有 oneway / 单向 / Oneway = yes 的当作单行道。' +
      '服务区按"沿路网可达 + 直线离路不超过阈值"计算，纯离线，不联网。'));
    body.appendChild(s4);
  }

  /* ------------------------------------------------------------------ *
   * 执行
   * ------------------------------------------------------------------ */

  function runPath() {
    const sh = shell();
    if (!state.start || !state.end) {
      toast('请先在地图上设置起点和终点', 'error', 3200);
      return;
    }
    status('正在算最短路…');
    const r = sh.shortestPath({
      sourceId: state.form.sourceId,
      start: state.start,
      end: state.end,
      maxSnapM: state.form.maxSnapM || undefined,
    });
    status('');
    state.pathResult = r;
    if (!r.ok) {
      toast(r.error || '最短路计算失败', 'error', 4000);
    } else {
      sh.drawPath(r);
      toast('最短路 ' + r.distanceKm.toFixed(3) + ' km', 'ok', 3200);
    }
    render();
  }

  function runArea() {
    const sh = shell();
    if (!state.start) {
      toast('请先在地图上设置起点', 'error', 3200);
      return;
    }
    const limitM = Math.max(1, state.form.limitKm) * 1000;
    status('正在算服务区…');
    const r = sh.serviceArea({
      sourceId: state.form.sourceId,
      start: state.start,
      limitM: limitM,
      maxSnapM: state.form.maxSnapM || undefined,
    });
    status('');
    state.areaResult = r;
    if (!r.ok) {
      toast(r.error || '服务区计算失败', 'error', 4000);
    } else {
      sh.drawServiceArea(r);
      toast('服务区约 ' + r.areaKm2.toFixed(2) + ' km²', 'ok', 3200);
    }
    render();
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
    state.picking = null;
    render();
  }
  function toggle() {
    if (state.panel && !state.panel.classList.contains('hidden')) close();
    else open();
  }

  function init(le) {
    state.le = le || window.LE;
    if (state.bound) return;
    state.bound = true;

    const btn = byId('btn-network');
    if (btn) {
      btn.addEventListener('click', function () { toggle(); });
    }
  }

  window.LENetworkUI = {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    render: render,
    setStart: function (lon, lat) { state.start = { lon: lon, lat: lat }; drawMarks(); render(); },
    setEnd: function (lon, lat) { state.end = { lon: lon, lat: lat }; drawMarks(); render(); },
    runPath: runPath,
    runArea: runArea,
    getState: function () {
      return {
        start: state.start,
        end: state.end,
        picking: state.picking,
        sourceId: state.form.sourceId,
        hasPath: !!(state.pathResult && state.pathResult.ok),
        hasArea: !!(state.areaResult && state.areaResult.ok),
      };
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

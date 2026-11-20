/*
 * 分析工具箱（Processing 面板）
 * ---------------------------------------------------------------------------
 * 本工具箱把 QGIS 里好用的功能**内建**进本软件，而不是去调用 QGIS。
 * 引擎在 js/analysis.js：坡度、坡向、山体阴影、等值线、高程统计、
 * 缓冲区、质心、凸包、长度与面积、沿线剖面、TIN 插值 —— 共 11 个算法，
 * 全部在浏览器里跑：
 *
 *   · **不需要安装 QGIS**，不依赖任何外部进程（无 qgis_process、无 Python、
 *     无子进程、不落盘）
 *   · 数据源就是软件自己的东西：本地全国 DEM 金字塔 + 内存里的矢量要素
 *   · **纯离线**，毫秒级返回
 *
 * 界面：左侧按 group 列出算法（可搜索），右侧按参数定义自动生成表单，
 * 运行后把产出直接挂到地球上（栅格→影像层，矢量→矢量层，统计→表格）。
 *
 * 对外 API（window.LEQgisToolbox）：
 *   open() / close() / toggle() / isOpen() / init(le)
 */
(function () {
  'use strict';

  const state = {
    le: null,
    open: false,
    algorithms: [],
    groups: [],
    selected: null,
    filter: '',
    built: false,
  };

  /**
   * group 标题的中文兜底。原生引擎的 group 本身已经是中文，
   * 这里只处理将来可能新增的英文分组。
   */
  const GROUP_CN = {
    'Raster terrain analysis': '栅格地形分析',
    'Raster analysis': '栅格分析',
    'Vector analysis': '矢量分析',
    'Vector geometry': '矢量几何',
    'Interpolation': '插值',
  };

  /**
   * 算法的中文别名 / 搜索关键词。
   * 原生引擎的算法名本身已是中文，这里额外补上英文关键词，
   * 让用户输入 slope / contour / buffer 也能搜到。
   */
  const ALIAS_CN = {
    'native:slope': '坡度',
    'native:aspect': '坡向',
    'native:hillshade': '山体阴影',
    'native:contour': '等值线',
    'native:demstats': '高程统计',
    'native:rastercalc': '栅格计算器',
    'native:classify': '分级渲染',
    'native:rasterhist': '直方图统计',
    'native:vectorstyle': '矢量规则样式',
    'native:buffer': '缓冲区',
    'native:centroid': '质心',
    'native:convexhull': '凸包',
    'native:lenarea': '长度与面积',
    'native:profile': '沿线路剖面',
    'native:interpolate': 'TIN 插值',
    'native:supervisedclassify': '监督分类',
    'native:kmeansclassify': '非监督分类',
    'native:shortestpath': '最短路径',
    'native:servicearea': '服务区',
  };

  const NO_FILE_TYPES = ['rasterDestination', 'vectorDestination', 'fileDestination'];

  /** 算法显示名：优先中文别名；别名与原名相同时不重复。 */
  function displayName(a) {
    const cn = ALIAS_CN[a.id];
    if (cn && cn !== a.name) return cn + ' · ' + (a.name || a.id);
    return a.name || a.id;
  }

  /* ------------------------------------------------------------------ DOM */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensurePanel() {
    if (state.built) return state.panel;
    const panel = el('div', 'qgis-toolbox hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '分析工具箱');

    // 顶栏
    const head = el('div', 'qgis-head');
    const titleWrap = el('div', 'qgis-title-wrap');
    titleWrap.appendChild(el('h3', null, '分析工具箱'));
    const sub = el('div', 'qgis-sub', '正在加载算法…');
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);
    const headBtns = el('div', 'qgis-head-btns');
    const btnReload = el('button', 'qgis-btn subtle', '刷新');
    btnReload.type = 'button';
    btnReload.title = '重新读取算法清单';
    btnReload.addEventListener('click', function () { loadAlgorithms(true); });
    headBtns.appendChild(btnReload);
    const btnClose = el('button', 'qgis-btn icon', '×');
    btnClose.type = 'button';
    btnClose.title = '关闭';
    btnClose.addEventListener('click', close);
    headBtns.appendChild(btnClose);
    head.appendChild(headBtns);

    // 主体：左列表 + 右表单
    const body = el('div', 'qgis-body');
    const left = el('div', 'qgis-left');

    const search = el('input', 'qgis-search');
    search.type = 'search';
    search.placeholder = '搜索算法：坡度 / 等值线 / 缓冲区 / slope…';
    search.addEventListener('input', function () {
      state.filter = search.value.trim();
      renderList();
    });
    left.appendChild(search);
    const list = el('div', 'qgis-list');
    left.appendChild(list);
    body.appendChild(left);

    const right = el('div', 'qgis-right');
    const empty = el('div', 'qgis-empty', '从左侧选择一个算法');
    right.appendChild(empty);
    body.appendChild(right);

    panel.appendChild(head);
    panel.appendChild(body);

    const status = el('div', 'qgis-status');
    panel.appendChild(status);

    document.body.appendChild(panel);
    state.panel = panel;
    state.listEl = list;
    state.rightEl = right;
    state.subEl = sub;
    state.statusEl = status;
    state.built = true;
    return panel;
  }

  /* ------------------------------------------------------------------ 算法清单 */

  /**
   * 读取算法清单。
   * 原生算法来自 LEAnalysis；插件算法由 LEPluginShell 合并进来
   * （插件机制 P3-4.17）。工具箱这边对插件是「透明」的 ——
   * 一份清单、一种运行方式。
   */
  async function loadAlgorithms(force) {
    ensurePanel();
    state.subEl.textContent = '正在加载原生引擎…';
    try {
      if (!window.LEAnalysis) throw new Error('原生分析引擎未加载');
      let list = window.LEAnalysis.algorithms();
      if (window.LEPluginShell && typeof window.LEPluginShell.mergeAlgorithms === 'function') {
        list = window.LEPluginShell.mergeAlgorithms();
      }
      state.algorithms = list || [];
      buildGroups();
      renderList();
      const caps = window.LEAnalysis.capabilities();
      const demState = caps.demReady ? '全国 DEM 就绪' :
        (caps.demEnabled ? '全国 DEM 加载中…' : '全国 DEM 未启用（可在图层里开启）');
      const pluginCount = state.algorithms.filter(function (a) { return a.plugin; }).length;
      state.subEl.textContent =
        '原生引擎 · ' + state.algorithms.length + ' 个算法' +
        (pluginCount ? '（含 ' + pluginCount + ' 个插件）' : '') +
        ' · 纯离线 · ' + demState;
    } catch (err) {
      state.subEl.textContent = '原生引擎加载失败';
      state.listEl.innerHTML = '';
      state.listEl.appendChild(el('div', 'qgis-empty', String(err.message || err)));
    }
    void force;
  }

  function buildGroups() {
    const map = new Map();
    for (let i = 0; i < state.algorithms.length; i++) {
      const a = state.algorithms[i];
      if (!map.has(a.group)) map.set(a.group, []);
      map.get(a.group).push(a);
    }
    state.groups = [];
    map.forEach(function (items, group) {
      state.groups.push({ group: group, items: items });
    });
    state.groups.sort(function (x, y) { return y.items.length - x.items.length; });
  }

  /* ------------------------------------------------------------------ 左侧列表 */

  function renderList() {
    const list = state.listEl;
    list.innerHTML = '';
    const q = state.filter.toLowerCase();
    let shown = 0;

    for (let i = 0; i < state.groups.length; i++) {
      const g = state.groups[i];
      const items = q
        ? g.items.filter(function (a) {
            return (
              a.id.toLowerCase().indexOf(q) >= 0 ||
              String(a.name || '').toLowerCase().indexOf(q) >= 0 ||
              String(a.group).toLowerCase().indexOf(q) >= 0 ||
              (GROUP_CN[a.group] || '').toLowerCase().indexOf(q) >= 0 ||
              (ALIAS_CN[a.id] || '').toLowerCase().indexOf(q) >= 0 ||
              (a.description && a.description.toLowerCase().indexOf(q) >= 0)
            );
          })
        : g.items;
      if (!items.length) continue;

      const head = el('button', 'qgis-group-head');
      head.type = 'button';
      const cn = GROUP_CN[g.group] || g.group;
      head.appendChild(el('span', 'qgis-group-cn', cn));
      head.appendChild(el('span', 'qgis-group-en', g.group));
      head.appendChild(el('span', 'qgis-group-n', String(items.length)));
      head.addEventListener('click', function () {
        const listEl = head.nextElementSibling;
        if (listEl) listEl.hidden = !listEl.hidden;
        head.classList.toggle('collapsed', listEl && listEl.hidden);
      });

      const holder = el('div', 'qgis-group-items');
      for (let j = 0; j < items.length; j++) {
        const a = items[j];
        const item = el('button', 'qgis-item');
        item.type = 'button';
        item.setAttribute('data-algo', a.id);
        item.appendChild(el('span', 'qgis-item-name', displayName(a)));
        item.appendChild(el('span', 'qgis-item-id', a.id));
        // 注意：必须在此处捕获 algId，for 循环里的 var 是函数作用域，
        // 直接引用 a 会让所有条目都指向最后一个算法。
        const algId = a.id;
        item.addEventListener('click', function () { selectAlgorithm(algId); });
        holder.appendChild(item);
        shown++;
      }
      list.appendChild(head);
      list.appendChild(holder);
    }

    if (!shown) {
      list.appendChild(el('div', 'qgis-empty', '没有匹配的算法'));
    }
  }

  /* ------------------------------------------------------------------ 右侧表单 */

  function selectAlgorithm(id) {
    const algo = state.algorithms.find(function (a) { return a.id === id; });
    if (!algo) return;
    state.selected = algo;
    const right = state.rightEl;
    right.innerHTML = '';

    const prev = document.querySelectorAll('.qgis-item.is-active');
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove('is-active');

    const head = el('div', 'qgis-algo-head');
    head.appendChild(el('h4', null, displayName(algo)));
    head.appendChild(el('code', null, algo.id));
    const grp = el('div', 'qgis-algo-group', (GROUP_CN[algo.group] || algo.group) + ' · ' + algo.group);
    head.appendChild(grp);
    if (algo.description) {
      head.appendChild(el('p', 'qgis-algo-desc', algo.description));
    }
    right.appendChild(head);

    const form = el('div', 'qgis-form');
    const params = (algo.parameters || []).filter(function (p) {
      return p.name !== 'CREATION_OPTIONS' && p.name !== 'OPTIONS' && p.name !== 'EXTRA';
    });

    if (!params.length) {
      form.appendChild(el('div', 'qgis-empty', '该算法没有参数'));
    }

    for (let i = 0; i < params.length; i++) {
      form.appendChild(buildField(params[i]));
    }
    right.appendChild(form);

    const actions = el('div', 'qgis-actions');
    const btnRun = el('button', 'qgis-btn primary', '运行算法');
    btnRun.type = 'button';
    btnRun.addEventListener('click', runSelected);
    actions.appendChild(btnRun);

    // 批量：按每个绘制面各跑一次（只有带 SCOPE 的算法能批量）
    const hasScope = params.some(function (p) { return p.name === 'SCOPE'; });
    if (hasScope) {
      const btnBatch = el('button', 'qgis-btn', '按绘制面批量运行');
      btnBatch.type = 'button';
      btnBatch.title = '每个绘制面单独跑一次，每个面用自己的掩膜（结果分别挂成图层）';
      btnBatch.addEventListener('click', runBatchSelected);
      actions.appendChild(btnBatch);
    }

    const btnClear = el('button', 'qgis-btn subtle', '清空');
    btnClear.type = 'button';
    btnClear.addEventListener('click', function () {
      const f = right.querySelector('.qgis-form');
      if (f) f.innerHTML = '';
      state.statusEl.textContent = '';
      state.statusEl.className = 'qgis-status';
    });
    actions.appendChild(btnClear);
    right.appendChild(actions);

    // 自动聚焦第一个矢量输入
    const firstVec = params.find(function (p) { return p.type === 'vector'; });
    if (firstVec) {
      const node = right.querySelector('[data-field="' + firstVec.name + '"]');
      if (node) node.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * 构造一个参数字段。
   *
   * 矢量参数是**下拉选择**（从绘制要素 / 已加载图层里挑），
   * 而不是「挑一个磁盘文件」—— 输入本来就在内存里。
   */
  function buildField(param) {
    const wrap = el('div', 'qgis-field');
    wrap.setAttribute('data-field', param.name);
    const label = el('label', 'qgis-label');
    label.appendChild(el('span', null, param.description || param.name));
    label.appendChild(el('code', null, param.name));
    if (param.optional) label.appendChild(el('em', 'qgis-opt', '可选'));
    wrap.appendChild(label);

    const input = el('input', 'qgis-input');
    input.type = 'text';
    input.dataset.param = param.name;
    input.dataset.type = param.type;
    if (param.default != null) input.value = String(param.default);

    if (param.type === 'boolean') {
      input.type = 'checkbox';
      input.checked = param.default === true || param.default === 'true';
      wrap.appendChild(input);
    } else if (param.type === 'enum' && param.options && param.options.length) {
      const sel = el('select', 'qgis-input');
      sel.dataset.param = param.name;
      sel.dataset.type = param.type;
      param.options.forEach(function (opt) {
        const o = el('option', null, opt);
        o.value = String(opt);
        sel.appendChild(o);
      });
      if (param.default != null) sel.value = String(param.default);
      wrap.appendChild(sel);
      // 「绘制范围」：实时显示当前可用的绘制面，并提供一键绘制入口
      if (param.options.indexOf('绘制范围') >= 0) {
        const scopeHint = el('div', 'qgis-hint');
        let pollTimer = null;
        const refresh = function () {
          scopeHint.innerHTML = '';
          const polys = window.LEAnalysis ? window.LEAnalysis.drawnMaskPolygons() : [];
          if (!polys.length) {
            scopeHint.appendChild(document.createTextNode('还没有绘制面。选「绘制范围」后需先画一个多边形。'));
          } else {
            scopeHint.appendChild(document.createTextNode(
              '可用绘制面（' + polys.length + '）：' +
              polys.map(function (p) { return p.name; }).join('、')));
          }
          const btn = el('button', 'qgis-btn subtle', '去绘制一个面');
          btn.type = 'button';
          btn.addEventListener('click', function () {
            if (window.LEDraw && typeof window.LEDraw.start === 'function') {
              window.LEDraw.start('polygon');
            }
            // 绘制过程中轮询，直到用户画完（LEDraw 不在绘制状态）
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(function () {
              refresh();
              const drawing = window.LEDraw && window.LEDraw.isActive && window.LEDraw.isActive();
              if (!drawing && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            }, 700);
          });
          scopeHint.appendChild(btn);
        };
        refresh();
        sel.addEventListener('change', refresh);
        wrap.appendChild(scopeHint);
      }
    } else if (param.type === 'number') {
      input.type = 'number';
      input.step = 'any';
      input.placeholder = param.optional ? '留空使用默认值' : '';
      wrap.appendChild(input);
    } else if (param.type === 'vector') {
      // 矢量输入来自内存 → 下拉选择
      const sel = el('select', 'qgis-input');
      sel.dataset.param = param.name;
      sel.dataset.type = param.type;
      const inputs = window.LEAnalysis ? window.LEAnalysis.collectVectorInputs() : [];
      const auto = el('option', null, inputs.length === 1
        ? '（自动使用唯一要素）'
        : '（请选择输入要素）');
      auto.value = '';
      sel.appendChild(auto);
      for (const v of inputs) {
        const o = el('option', null, v.name + '（' + typeCN(v.type) + '）');
        o.value = v.id;
        sel.appendChild(o);
      }
      wrap.appendChild(sel);
      if (!inputs.length) {
        wrap.appendChild(el('div', 'qgis-hint',
          '还没有矢量输入。请先在「绘制」里画一个点/线/面，或导入一个矢量文件。'));
      }
    } else if (NO_FILE_TYPES.indexOf(param.type) >= 0) {
      input.placeholder = '自动生成';
      input.readOnly = true;
      wrap.appendChild(input);
    } else {
      wrap.appendChild(input);
    }

    if (param.description && param.type !== 'vector') {
      const hint = el('div', 'qgis-hint', param.description);
      wrap.appendChild(hint);
    }
    return wrap;
  }

  function typeCN(t) {
    return t === 'point' ? '点' : (t === 'line' ? '线' : '面');
  }

  /* ------------------------------------------------------------------ 参数收集 */

  function collectInputs() {
    const right = state.rightEl;
    const form = right.querySelector('.qgis-form');
    const inputs = {};
    if (!form) return inputs;
    const nodes = form.querySelectorAll('[data-param]');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const name = n.dataset.param;
      const type = n.dataset.type;
      if (type === 'boolean') {
        // 布尔参数**必须始终上报**（勾选 = true，不勾选 = false）。
        inputs[name] = !!n.checked;
        continue;
      }
      const v = String(n.value || '').trim();
      if (!v) continue;
      if (type === 'number') {
        const num = Number(v);
        if (isFinite(num)) inputs[name] = num;
        continue;
      }
      inputs[name] = v;
    }
    return inputs;
  }

  /* ------------------------------------------------------------------ 运行 */

  async function runSelected() {
    if (!state.selected) return;
    const algo = state.selected;
    const inputs = collectInputs();
    const startedAt = Date.now();
    setStatus('正在执行…', 'busy');

    // 校验必填参数（矢量参数允许留空：只有一个要素时自动选）
    const required = (algo.parameters || []).filter(function (p) {
      return !p.optional && NO_FILE_TYPES.indexOf(p.type) < 0 && p.name !== 'OUTPUT';
    });
    for (let i = 0; i < required.length; i++) {
      const p = required[i];
      if (inputs[p.name] == null || inputs[p.name] === '') {
        if (p.type === 'vector') continue;
        setStatus('缺少必填参数：' + (p.description || p.name), 'error');
        const node = state.rightEl.querySelector('[data-field="' + p.name + '"]');
        if (node) node.scrollIntoView({ block: 'center' });
        return;
      }
    }

    try {
      // 插件算法走插件外壳（沙箱执行）；原生算法走原生引擎
      const isPlugin = !!algo.plugin;
      const res = isPlugin
        ? await window.LEPluginShell.run(algo.id, inputs)
        : await window.LEAnalysis.run(algo.id, inputs);
      const ms = Date.now() - startedAt;
      const layerName = displayName(algo) + ' 结果';

      if (res.kind === 'table') {
        showTable(res, ms);
        return;
      }
      if (res.kind === 'error') throw new Error(res.error || '插件执行失败');

      if (isPlugin) {
        await window.LEPluginShell.runToLayer(algo.id, inputs, { name: layerName });
      } else {
        await window.LEAnalysis.runToLayer(state.le, algo.id, inputs, { name: layerName });
      }
      const stats = formatStats(res.stats);
      setStatus(
        '完成 · ' + ms + ' ms（' + (isPlugin ? '插件沙箱，无外部进程' : '原生引擎，无外部进程') +
        '）：' + layerName + ' 已加入图层。' +
        (stats ? ' ' + stats : ''),
        'ok'
      );
      // 带明细表的结果（如沿线剖面）额外在右侧列出来
      if (res.table) showTable(res, ms, true);
    } catch (err) {
      setStatus('执行失败：' + (err && err.message ? err.message : err), 'error');
    }
  }

  /**
   * 批量运行：每个绘制面单独跑一次，每个面用自己的掩膜。
   *
   * 与单次「绘制范围」的区别：单次把所有面并成一张图，
   * 批量则是「一图一面」，结果分别挂成图层。
   */
  async function runBatchSelected() {
    if (!state.selected) return;
    const algo = state.selected;
    const inputs = collectInputs();
    const startedAt = Date.now();

    const polys = window.LEAnalysis ? window.LEAnalysis.drawnMaskPolygons() : [];
    if (!polys.length) {
      setStatus('批量运行需要先在地图上画至少一个面（多边形）。', 'error');
      return;
    }

    setStatus('正在按 ' + polys.length + ' 个绘制面批量运行…', 'busy');
    try {
      const isPlugin = !!algo.plugin;
      if (isPlugin) {
        setStatus('插件算法暂不支持按面批量运行。', 'error');
        return;
      }
      const out = await window.LEAnalysis.runBatchToLayer(
        state.le, algo.id, inputs,
        {
          name: displayName(algo) + ' 结果',
          onProgress: function (done, total, name) {
            setStatus('正在按 ' + total + ' 个绘制面批量运行…（' + (done + 1) + '/' + total + ' ' + name + '）', 'busy');
          },
        }
      );
      const ms = Date.now() - startedAt;
      const b = out.batch;
      if (b.failed) {
        setStatus(
          '完成 · ' + ms + ' ms：成功 ' + b.ok + ' 个面，失败 ' + b.failed + ' 个面。' +
          '（失败：' + b.results.filter(function (r) { return !r.ok; })
            .map(function (r) { return r.name + '——' + r.error; }).join('；') + '）',
          'error'
        );
      } else {
        setStatus(
          '完成 · ' + ms + ' ms（原生引擎，无外部进程）：' + b.ok + ' 个面各生成一张图，已加入图层。',
          'ok'
        );
      }
    } catch (err) {
      setStatus('批量运行失败：' + (err && err.message ? err.message : err), 'error');
    }
  }

  function formatStats(stats) {
    if (!stats) return '';
    const parts = [];
    for (const k in stats) {
      if (!Object.prototype.hasOwnProperty.call(stats, k)) continue;
      parts.push(k + ' ' + stats[k]);
    }
    return parts.join(' · ');
  }

  /** 表格类结果（高程统计、长度面积）直接显示在右侧。 */
  function showTable(res, ms, keepStatus) {
    const right = state.rightEl;
    const box = el('div', 'qgis-table-box');
    box.appendChild(el('h5', null, '统计结果'));
    const stats = res.stats || {};
    const dl = el('div', 'qgis-table-stats');
    for (const k in stats) {
      if (!Object.prototype.hasOwnProperty.call(stats, k)) continue;
      const row = el('div', 'qgis-stat-row');
      row.appendChild(el('span', 'qgis-stat-k', k));
      row.appendChild(el('span', 'qgis-stat-v', String(stats[k])));
      dl.appendChild(row);
    }
    box.appendChild(dl);
    if (res.table) {
      const table = el('table', 'qgis-table');
      const thead = el('thead');
      const trh = el('tr');
      res.table.columns.forEach(function (c) { trh.appendChild(el('th', null, c)); });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = el('tbody');
      res.table.rows.forEach(function (r) {
        const tr = el('tr');
        r.forEach(function (c) { tr.appendChild(el('td', null, String(c))); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      box.appendChild(table);
    }
    right.appendChild(box);
    // keepStatus：这是**附加**表格（结果本身已经是一个图层），
    // 不能把「已加入图层」的状态文案覆盖掉。
    if (!keepStatus) setStatus('完成 · ' + ms + ' ms（原生引擎，无外部进程）。', 'ok');
  }

  function setStatus(text, kind) {
    const s = state.statusEl;
    if (!s) return;
    s.textContent = text;
    s.className = 'qgis-status' + (kind ? ' ' + kind : '');
    if (text) s.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ 开关 */

  function open() {
    const panel = ensurePanel();
    panel.classList.remove('hidden');
    state.open = true;
    if (!state.algorithms.length) loadAlgorithms(false);
  }

  function close() {
    if (state.panel) state.panel.classList.add('hidden');
    state.open = false;
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  window.LEQgisToolbox = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return state.open; },
    init: function (le) { state.le = le; },
    // 插件装卸后由 LEPluginShell 调用，重新拉一遍清单
    reloadAlgorithms: function () { return loadAlgorithms(true); },
  };
})();

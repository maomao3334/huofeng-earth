/*
 * 数据仓库 · 界面（js/vault-ui.js）
 * ---------------------------------------------------------------------------
 * 侧栏「数据」分类下的一个面板，提供：
 *   - 导入：选文件 → 探测 → 入库（影像切瓦片 / DEM 建金字塔 / 矢量直接上图）
 *   - 存量：列出仓库里已有的数据集，可加载成图层、可定位、可删除
 *   - 进度：入库过程的长任务提示（大文件要切很多瓦片）
 *
 * 界面完全用中文，风格与现有侧栏一致（details/summary + .sec-body）。
 */
(function () {
  'use strict';

  const state = {
    le: null,
    ready: false,
    section: null,
    listNode: null,
    countNode: null,
    progressNode: null,
    logNode: null,
    datasets: [],
    selected: new Set(),   // 勾选的数据集 id
    batchNode: null,
    selectAllNode: null,
    selectedNode: null,
    tplNode: null,
  };

  function byId(id) { return document.getElementById(id); }

  function toast(msg, kind, ms) {
    if (state.le && state.le.toast) state.le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg) {
    if (state.le && state.le.status) state.le.status(msg);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function renderDataset(ds) {
    const card = el('div', 'vault-card');
    card.setAttribute('data-vault', ds.id || '');

    const head = el('div', 'vault-head');
    const title = el('span', 'vault-title', ds.name || ds.id || '未命名');
    const badge = el('span', 'vault-badge ' + (ds.kind || 'imagery'),
      ds.kind === 'dem' ? 'DEM' : (ds.kind === 'vector' ? '矢量' : '影像'));
    head.appendChild(title);
    head.appendChild(badge);

    // 勾选框：放在标题前面，方便批量管理
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'vault-pick';
    check.checked = state.selected.has(ds.id);
    check.title = '选中此数据集（用于批量改名 / 批量删除）';
    check.addEventListener('change', function () {
      if (check.checked) state.selected.add(ds.id);
      else state.selected.delete(ds.id);
      card.classList.toggle('picked', check.checked);
      updateBatchBar();
    });
    head.insertBefore(check, title);
    if (check.checked) card.classList.add('picked');

    const meta = el('div', 'vault-meta');
    const parts = [];
    if (ds.source && ds.source.format) parts.push('.' + ds.source.format);
    if (ds.source && ds.source.width) parts.push(ds.source.width + '×' + ds.source.height);
    if (ds.geo) {
      parts.push('经度 ' + fmt(ds.geo.west) + '~' + fmt(ds.geo.east));
      parts.push('纬度 ' + fmt(ds.geo.south) + '~' + fmt(ds.geo.north));
    }
    if (ds.tiles) parts.push(ds.tiles.count + ' 张瓦片 z' + ds.tiles.minZoom + '–' + ds.tiles.maxZoom);
    if (ds.dem) parts.push(ds.dem.levels + ' 级金字塔');
    if (ds.geo && ds.geo.source) parts.push(ds.geo.source);
    meta.textContent = parts.join(' · ');

    const actions = el('div', 'vault-actions');
    const loadBtn = el('button', 'vault-load', ds.kind === 'vector' ? '已在图层中' : '加载图层');
    loadBtn.type = 'button';
    loadBtn.disabled = ds.kind === 'vector';
    loadBtn.addEventListener('click', function () { loadDataset(ds.id); });
    actions.appendChild(loadBtn);

    const zoomBtn = el('button', 'vault-zoom subtle', '定位');
    zoomBtn.type = 'button';
    zoomBtn.addEventListener('click', function () { zoomDataset(ds); });
    actions.appendChild(zoomBtn);

    const delBtn = el('button', 'vault-del subtle', '删除');
    delBtn.type = 'button';
    delBtn.addEventListener('click', function () { removeDataset(ds.id); });
    actions.appendChild(delBtn);

    const renameBtn = el('button', 'vault-del subtle', '改名');
    renameBtn.type = 'button';
    renameBtn.title = '只改显示名，不动 id 与磁盘目录';
    renameBtn.addEventListener('click', function () { renameDataset(ds.id); });
    actions.appendChild(renameBtn);

    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
  }

  function fmt(v) {
    const n = Number(v);
    if (!isFinite(n)) return '--';
    return n.toFixed(4);
  }

  function render() {
    if (!state.section) return;
    const has = state.datasets.length > 0;
    state.section.dataset.available = has ? '1' : '0';
    // 面板本身始终可见（要能导入），但清单为空时隐藏清单区
    if (state.listNode) {
      state.listNode.innerHTML = '';
      state.datasets.forEach(function (ds) {
        if (!ds || !ds.id) return;
        state.listNode.appendChild(renderDataset(ds));
      });
      state.listNode.hidden = !has;
    }
    if (state.countNode) state.countNode.textContent = String(state.datasets.length);
    updateBatchBar();
    if (window.LEsidebarNav && window.LEsidebarNav.refresh) window.LEsidebarNav.refresh();
  }

  /** 批量工具条：只在有数据集时显示，并同步「已选 N 项」。 */
  function updateBatchBar() {
    const n = state.selected.size;
    if (state.batchNode) state.batchNode.hidden = state.datasets.length === 0;
    if (state.selectedNode) state.selectedNode.textContent = '已选 ' + n + ' 项';
    if (state.selectAllNode) {
      const total = state.datasets.length;
      const all = total > 0 && n === total;
      state.selectAllNode.checked = all;
      state.selectAllNode.indeterminate = n > 0 && n < total;
    }
  }

  function selectedIds() {
    return Array.from(state.selected);
  }

  /** 全选 / 取消全选。 */
  function toggleSelectAll(on) {
    state.selected.clear();
    if (on) {
      state.datasets.forEach(function (ds) { if (ds && ds.id) state.selected.add(ds.id); });
    }
    render();
  }

  /** 批量改名：按模板重命名所选项。 */
  async function batchRename() {
    const ids = selectedIds();
    if (!ids.length) { toast('请先勾选要改名的数据集', 'error', 2600); return; }
    const tpl = state.tplNode ? state.tplNode.value : '';
    if (!tpl.trim()) { toast('请先填写命名模板', 'error', 3000); return; }
    try {
      const res = await window.LEVault.renameMany(ids, tpl);
      await refresh();
      toast('批量改名完成：成功 ' + res.renamed + ' 个' +
        (res.failed.length ? '，失败 ' + res.failed.length + ' 个' : ''),
        res.failed.length ? 'error' : 'ok', 3600);
    } catch (err) {
      toast('批量改名失败：' + (err && err.message ? err.message : err), 'error', 4200);
    }
  }

  /** 批量删除：一次确认，逐条删盘上文件。 */
  async function batchDelete() {
    const ids = selectedIds();
    if (!ids.length) { toast('请先勾选要删除的数据集', 'error', 2600); return; }
    const names = ids.map(function (id) {
      const ds = state.datasets.find(function (d) { return d.id === id; });
      return ds ? ds.name : id;
    });
    if (!window.confirm('确定删除选中的 ' + ids.length + ' 个数据集？\n\n' +
      names.join('\n') + '\n\n磁盘上的瓦片文件会一并删除，不可恢复。')) return;
    try {
      const res = await window.LEVault.removeMany(ids);
      state.selected.clear();
      await refresh();
      toast('批量删除完成：删除 ' + res.removed + ' 个' +
        (res.failed.length ? '，失败 ' + res.failed.length + ' 个' : ''),
        res.failed.length ? 'error' : 'ok', 3600);
    } catch (err) {
      toast('批量删除失败：' + (err && err.message ? err.message : err), 'error', 4200);
    }
  }

  /** 导出入库清单 CSV（浏览器直接下载，不经过服务端）。 */
  function exportManifest() {
    if (!window.LEVault) return;
    try {
      const csv = window.LEVault.exportManifestCsv();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = window.LEVault.manifestFileName();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('已导出清单：' + a.download, 'ok', 3200);
    } catch (err) {
      toast('导出失败：' + (err && err.message ? err.message : err), 'error', 3600);
    }
  }

  /** 单个改名：弹输入框。 */
  function renameDataset(id) {
    const ds = state.datasets.find(function (d) { return d.id === id; });
    if (!ds) return;
    const next = window.prompt('新的显示名称（只改名字，不改 id 与磁盘目录）：', ds.name || ds.id);
    if (next == null) return;                    // 取消
    if (!next.trim()) { toast('名称不能为空', 'error', 2400); return; }
    window.LEVault.rename(id, next.trim())
      .then(function () { return refresh(); })
      .then(function () { toast('已改名：' + next.trim(), 'ok', 2400); })
      .catch(function (err) {
        toast('改名失败：' + (err && err.message ? err.message : err), 'error', 3600);
      });
  }

  /* ------------------------------------------------------------------ *
   * 动作
   * ------------------------------------------------------------------ */

  async function refresh() {
    if (!window.LEVault) return;
    state.datasets = await window.LEVault.refresh();
    render();
  }

  /**
   * 导入流程：选文件 → 探测 → 询问类型 → 入库。
   * 探测结果先展示给用户看（格式、尺寸、是否有地理参考），
   * 因为「没有地理参考」是最常见的失败原因，需要明确告诉用户补什么文件。
   */
  async function importFiles() {
    if (!window.LEVault) { toast('数据仓库模块未就绪', 'error'); return; }
    const progress = state.progressNode;
    if (progress) { progress.hidden = false; progress.textContent = '正在读取文件…'; }
    try {
      const files = await window.LEVault.pickFiles({
        filter: '所有文件 (*.*)|*.*',
        description: '选择要入库的数据文件（影像 / DEM / 矢量，可多选）',
      });
      if (!files.length) { if (progress) progress.hidden = true; return; }

      // 探测每一个主文件
      const groups = window.LEVault.groupFiles(files);
      const probes = [];
      for (const g of groups) {
        const sidecars = [];
        g.sidecars.forEach((f, ext) => sidecars.push('.' + ext));
        let info = null;
        try {
          info = await window.LEVaultRaster.probe(g.primary);
        } catch (err) {
          info = { kind: 'unknown', note: '探测失败：' + (err && err.message) };
        }
        probes.push({ group: g, info: info, sidecars: sidecars });
      }

      // 有没有缺地理参考的 —— 缺了就明确提示要补哪些文件
      const missingGeo = probes.filter((p) =>
        p.info && !p.info.georeferenced &&
        !p.group.sidecars.has('prj') && !p.group.sidecars.has('rpb')
      );
      if (missingGeo.length && missingGeo.length === probes.length) {
        if (progress) progress.hidden = true;
        const names = missingGeo.map((p) => p.group.name).join('、');
        toast('「' + names + '」缺少地理参考。请一并选择配套的 .prj（投影定义）或 .rpb（卫星 RPC）文件。',
          'error', 7000);
        return;
      }

      // 入库
      let ok = 0, fail = 0;
      for (const p of probes) {
        if (progress) {
          progress.textContent = '正在入库：' + p.group.name + '（' +
            (p.info.kind || '未知') + '，' +
            (p.info.width ? p.info.width + '×' + p.info.height : '尺寸未知') + '）…';
        }
        try {
          const res = await window.LEVault.ingest([p.group.primary].concat(
            Array.from(p.group.sidecars.values())
          ), { kind: 'auto' });
          const r = res && res[0];
          if (r && !r.error) ok++; else fail++;
        } catch (err) {
          fail++;
          console.error('[LEVaultUI] 入库失败', err);
          toast('「' + p.group.name + '」入库失败：' + (err && err.message ? err.message : err),
            'error', 6000);
        }
      }
      if (progress) progress.hidden = true;
      await refresh();
      toast('入库完成：成功 ' + ok + ' 个' + (fail ? '，失败 ' + fail + ' 个' : ''),
        fail ? 'error' : 'ok', 4200);
      status('数据仓库：成功 ' + ok + ' 个，失败 ' + fail + ' 个');
    } catch (err) {
      if (progress) progress.hidden = true;
      console.error('[LEVaultUI] 导入异常', err);
      toast('导入失败：' + (err && err.message ? err.message : err), 'error', 5200);
    }
  }

  async function loadDataset(id) {
    try {
      await window.LEVault.loadAsLayer(id);
      toast('已加载：' + id, 'ok', 2600);
    } catch (err) {
      toast('加载失败：' + (err && err.message ? err.message : err), 'error', 4600);
    }
  }

  function zoomDataset(ds) {
    if (!ds.geo || !state.le || !state.le.flyTo) return;
    const C = window.Cesium;
    state.le.flyTo({
      rectangle: C.Rectangle.fromDegrees(
        ds.geo.west, ds.geo.south, ds.geo.east, ds.geo.north
      ),
    });
  }

  async function removeDataset(id) {
    if (!window.confirm('确定删除数据集「' + id + '」？\n磁盘上的瓦片文件会一并删除。')) return;
    try {
      await window.LEVault.remove(id);
      await refresh();
      toast('已删除：' + id, 'ok', 2400);
    } catch (err) {
      toast('删除失败：' + (err && err.message ? err.message : err), 'error', 4200);
    }
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function bind() {
    if (state.bound) return;
    state.bound = true;
    const btn = byId('btn-vault-import');
    if (btn) btn.addEventListener('click', importFiles);
    const refreshBtn = byId('btn-vault-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        refresh();
        toast('已刷新数据仓库', 'ok', 1800);
      });
    }
    const all = byId('vault-select-all');
    if (all) all.addEventListener('change', function () { toggleSelectAll(all.checked); });
    const rn = byId('btn-vault-batch-rename');
    if (rn) rn.addEventListener('click', batchRename);
    const del = byId('btn-vault-batch-delete');
    if (del) del.addEventListener('click', batchDelete);
    const exp = byId('btn-vault-export');
    if (exp) exp.addEventListener('click', exportManifest);
  }

  function init(le) {
    state.le = le || window.LE;
    if (!state.le || !state.le.viewer) return;
    state.ready = true;
    state.section = byId('vault-section');
    state.listNode = byId('vault-list');
    state.countNode = byId('vault-count');
    state.progressNode = byId('vault-progress');
    state.batchNode = byId('vault-batch');
    state.selectAllNode = byId('vault-select-all');
    state.selectedNode = byId('vault-selected');
    state.tplNode = byId('vault-rename-tpl');
    bind();
    refresh();
  }

  window.LEVaultUI = {
    init: init,
    refresh: refresh,
    importFiles: importFiles,
    loadDataset: loadDataset,
    removeDataset: removeDataset,
    renameDataset: renameDataset,
    batchRename: batchRename,
    batchDelete: batchDelete,
    exportManifest: exportManifest,
    selectedIds: selectedIds,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

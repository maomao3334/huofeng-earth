/*
 * 3D Tiles 倾斜摄影 · 浏览器外壳（P2-4.8）
 * ---------------------------------------------------------------------------
 * 内核（js/tiles3d.js）负责纯计算；这里负责：
 *   1) 让用户选一个本机目录（服务端弹框 → 浏览器拿不到本机路径）；
 *   2) 把该目录「挂载」到本地服务器的 /tiles3d/<id>/ 前缀下；
 *   3) 用 Cesium3DTileset 加载挂载后的 tileset.json，贴到地球上；
 *   4) 挂成图层：可显隐、可定位、可删除、可随工程保存。
 *
 * 【为什么需要「挂载」这一层】
 *   Cesium 只认 URL；浏览器又拿不到本机绝对路径。
 *   所以让本机目录能被 Cesium 读到，必须经由本地服务器开一个只读前缀。
 *   挂载表在服务端内存里，服务一关就没了 —— 不往 data/ 里写任何东西，
 *   用户的倾斜摄影数据不会混进软件的数据仓库。
 *
 * 【纯离线】
 *   全程只与 127.0.0.1 上的本地服务器通信，不访问任何外网。
 *
 * 对外 API（window.LETiles3DShell）：
 *   init(le)
 *   mountAndLoad(dirPath, opts)  挂载目录并加载其中的 3D Tiles
 *   loadTileset(url, opts)       直接加载一个已挂载的 tileset.json 地址
 *   listMounts()                 列出服务端当前的挂载
 *   unmount(id)
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const state = {
    le: null,
    entries: [],      // 已加载的 tileset 图层
    mounted: {},      // id → { id, path, url, files }
    bound: false,
  };

  function getLE() {
    return state.le || window.LE;
  }

  function viewerOf() {
    const le = getLE();
    return le && le.viewer ? le.viewer : null;
  }

  function kernel() {
    return window.LETiles3D || null;
  }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  function say(line) {
    console.info('[LETiles3D] ' + line);
  }

  /* ------------------------------------------------------------------ *
   * 服务端交互
   * ------------------------------------------------------------------ */

  async function api(path, body, method) {
    const opts = {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    let json = null;
    try { json = await res.json(); } catch (err) { json = null; }
    if (!res.ok || !json || json.ok === false) {
      throw new Error((json && json.error) ? json.error : ('HTTP ' + res.status));
    }
    return json;
  }

  /** 弹系统文件夹选择框（服务端代劳：浏览器拿不到本机路径）。 */
  async function pickFolder(description) {
    const res = await api('/api/vault/pick-dir', {
      description: description || '选择倾斜摄影数据目录（含 tileset.json 的那一层）',
    });
    return res.path || null;
  }

  /** 挂载目录 → { id, path, url, files }。 */
  async function mount(dirPath) {
    const res = await api('/api/tiles3d/mount', { path: dirPath });
    state.mounted[res.id] = res;
    return res;
  }

  async function listMounts() {
    try {
      const res = await api('/api/tiles3d/list');
      return res.items || [];
    } catch (err) {
      return [];
    }
  }

  async function unmount(id) {
    try {
      await api('/api/tiles3d/unmount', { id: id });
    } catch (err) { /* ignore */ }
    delete state.mounted[id];
  }

  /* ------------------------------------------------------------------ *
   * 加载
   * ------------------------------------------------------------------ */

  /**
   * 在目录树里找出可加载的 tileset.json。
   * 优先根目录，其次按路径排序取第一个（并把选择权交给用户）。
   */
  function findTilesets(files) {
    const K = kernel();
    if (!K) return [];
    return K.catalog(files || []);
  }

  /**
   * 挂载目录并加载 3D Tiles。
   * @param {string} dirPath 本机目录
   * @param {object} opts { name, tilesetPath（指定用哪个 tileset.json）, show }
   */
  async function mountAndLoad(dirPath, opts) {
    opts = opts || {};
    const K = kernel();
    if (!K) throw new Error('3D Tiles 内核未加载');

    const m = await mount(dirPath);
    const sets = findTilesets(m.files);
    if (!sets.length) {
      const legacy = K.legacyFormats(m.files);
      let msg = '该目录里没有找到 tileset.json（3D Tiles 数据集入口文件）';
      if (legacy.length) {
        msg += '。检测到旧式格式：' +
          legacy.map((l) => l.label + ' ×' + l.count).join('、') +
          ' —— 本软件不支持这些格式，请先用专业工具转成 3D Tiles（b3dm/glb）后再导入';
      }
      throw new Error(msg);
    }
    // 优先根目录的 tileset.json
    let chosen = sets.find((s) => s.path.indexOf('/') < 0) || sets[0];
    if (opts.tilesetPath) {
      const hit = sets.find((s) => s.path === opts.tilesetPath);
      if (hit) chosen = hit;
    }
    const url = m.url + chosen.path;
    return await loadTileset(url, Object.assign({
      name: opts.name || (m.path.split(/[\\/]/).pop() || '倾斜摄影'),
      mountId: m.id,
      tilesetPath: chosen.path,
    }, opts));
  }

  /**
   * 加载一个已挂载的 tileset.json。
   * @param {string} url /tiles3d/<id>/<path>
   */
  async function loadTileset(url, opts) {
    opts = opts || {};
    const K = kernel();
    const le = getLE();
    const viewer = viewerOf();
    if (!K) throw new Error('3D Tiles 内核未加载');
    if (!viewer) throw new Error('地球尚未就绪');

    // 1) 先自己把 tileset.json 读一遍（拿到范围/统计，UI 要显示）
    let summary = null;
    let tilesetObj = null;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      tilesetObj = K.parseTileset(await res.text());
      summary = K.summarize(tilesetObj);
    } catch (err) {
      throw new Error('读取 tileset.json 失败：' + (err && err.message ? err.message : err));
    }

    // 2) 交给 Cesium 渲染
    //    注意：必须 add 进 scene.primitives，否则瓦片不会真的被加载与渲染。
    const tileset = await C.Cesium3DTileset.fromUrl(url);
    viewer.scene.primitives.add(tileset);

    // 3) 挂成图层
    const name = opts.name || '倾斜摄影';
    const bbox = summary.bbox;
    const entry = le.registerLayer({
      name: name,
      type: 'tiles3d',
      tileset: tileset,
      tilesetUrl: url,
      tilesetSummary: summary,
      mountId: opts.mountId || null,
      tilesetPath: opts.tilesetPath || null,
      remove: function () {
        try {
          const viewer2 = viewerOf();
          if (viewer2 && this.tileset) viewer2.scene.primitives.remove(this.tileset);
        } catch (err) {
          console.error('[LETiles3D] 删除倾斜摄影失败', err);
        }
      },
      zoomTo: function () {
        const viewer2 = viewerOf();
        if (!viewer2) return;
        const b = (this.tilesetSummary && this.tilesetSummary.bbox) || null;
        if (b) {
          viewer2.camera.flyTo({
            destination: C.Rectangle.fromDegrees(b.west, b.south, b.east, b.north),
            duration: 1.6,
          });
          return;
        }
        const c = this.tileset && this.tileset.boundingSphere
          ? this.tileset.boundingSphere : null;
        if (c) viewer2.camera.flyToBoundingSphere(c, { duration: 1.6 });
      },
    });

    entry.setVisible = function (on) {
      entry.visible = !!on;
      if (entry.tileset) entry.tileset.show = entry.visible;
      if (le && typeof le.refreshLayers === 'function') le.refreshLayers();
    };

    state.entries.push(entry);
    if (window.LELayerOrder && typeof window.LELayerOrder.addUser === 'function') {
      window.LELayerOrder.addUser(entry);
    }
    say('已加载倾斜摄影：' + name + '（' + summary.tileCount + ' 个瓦片）');
    return { entry: entry, summary: summary };
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init(le) {
    state.le = le || window.LE;
    if (!state.le || !state.le.viewer) return;
    // 启动时把服务端现有的挂载读回来（服务未重启时仍然可用）
    listMounts().then((items) => {
      for (const it of items) state.mounted[it.id] = it;
    }).catch(() => {});
  }

  window.LETiles3DShell = {
    init: init,
    mountAndLoad: mountAndLoad,
    loadTileset: loadTileset,
    mount: mount,
    unmount: unmount,
    listMounts: listMounts,
    pickFolder: pickFolder,
    findTilesets: findTilesets,
    entries: state.entries,
    mounted: state.mounted,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

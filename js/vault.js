/*
 * 数据仓库（js/vault.js）
 * ---------------------------------------------------------------------------
 * 这是「往软件里填数据」的统一入口：**格式不限、纯离线**。
 *
 * 【它做什么】
 *   把用户挑来的任意文件（影像 / DEM / 矢量 / 底图瓦片），
 *   经过「探测 → 解码 → 定位 → 重投影 → 重采样 → 切片 → 落盘」，
 *   变成软件能直接吃的东西：
 *
 *     影像 → data/local/imagery/<id>/{z}/{x}/{y}.jpg  + imagery.json 清单条目
 *     DEM  → data/local/dem/<id>/l{n}/{tx}/{ty}.bin   + dem/<id>/index.json
 *     矢量 → 直接成为内存图层（走已有的 import-pipeline）
 *
 * 【关键约束：纯离线、零外部依赖】
 *   解码全部在浏览器里完成（geotiff.js + proj4 + LERpc + canvas），
 *   服务端只提供两个能力：
 *     - /api/vault/pick-files  弹系统文件选择框（浏览器拿不到本机路径）
 *     - /api/vault/write       把编码好的字节写到磁盘
 *   整个过程不启动任何外部进程，不需要 GDAL / QGIS / Python。
 *
 * 【为什么清单要写两份】
 *   - data/local/imagery.json：现有「本地影像」模块读的清单（XYZ 瓦片）
 *   - data/local/vault.json：仓库自己的总账（所有数据集，含 DEM / 矢量 / 元数据）
 *
 * 对外 API（window.LEVault）：
 *   init(le)
 *   pickFiles(opts)        弹框选文件 → 返回 File 列表（浏览器侧 File 对象）
 *   ingest(files, opts)    主入口：探测 → 入库
 *   list()                 仓库清单
 *   remove(id)             删除某个数据集
 *   loadAsLayer(id)        把已入库的数据集加载成图层
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const VAULT_DIR = 'data/local';
  const IMAGERY_MANIFEST = 'data/local/imagery.json';
  const VAULT_MANIFEST = 'data/local/vault.json';

  const state = {
    le: null,
    ready: false,
    datasets: [],
    busy: false,
    log: [],
  };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function byId(id) { return document.getElementById(id); }

  function toast(msg, kind, ms) {
    if (state.le && state.le.toast) state.le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg) {
    if (state.le && state.le.status) state.le.status(msg);
  }

  function say(line) {
    state.log.push({ t: Date.now(), line });
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    console.info('[LEVault] ' + line);
  }

  function extOf(name) {
    return (/\.([^.]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || '';
  }

  function baseOf(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  /** 造一个安全的 id：只保留字母数字与下划线连字符。 */
  function safeId(name) {
    const s = baseOf(name)
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return s || 'dataset';
  }

  function bytesToBase64(bytes) {
    // 分块转换，避免 apply 参数过多
    const CH = 0x8000;
    let out = '';
    for (let i = 0; i < bytes.length; i += CH) {
      const chunk = bytes.subarray(i, Math.min(i + CH, bytes.length));
      out += String.fromCharCode.apply(null, chunk);
    }
    return btoa(out);
  }

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
      const msg = (json && json.error) ? json.error : ('HTTP ' + res.status);
      const e = new Error(msg);
      e.payload = json;
      throw e;
    }
    return json;
  }

  /* ------------------------------------------------------------------ *
   * 清单读写
   * ------------------------------------------------------------------ */

  async function readJson(url) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  /**
   * 写清单。
   * 优先走 /api/vault/write（服务端落盘）；服务端不可用时退回浏览器下载（不可取，
   * 因为要写到 data/ 目录），所以这里**必须**有服务端。
   */
  async function writeJson(path, obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
    return await api('/api/vault/write', {
      path: path.replace(/^data\/local\//, ''),
      data: bytesToBase64(bytes),
    });
  }

  /** 往 data/local/imagery.json 追加/更新一个数据集条目。 */
  async function upsertImageryManifest(ds) {
    let manifest = await readJson(IMAGERY_MANIFEST);
    if (!manifest || typeof manifest !== 'object') {
      manifest = { version: 1, autoLoad: true, datasets: [] };
    }
    if (!Array.isArray(manifest.datasets)) manifest.datasets = [];
    const idx = manifest.datasets.findIndex((d) => d.id === ds.id);
    if (idx >= 0) manifest.datasets[idx] = ds;
    else manifest.datasets.push(ds);
    manifest.version = (manifest.version || 1) + 1;
    await writeJson(IMAGERY_MANIFEST, manifest);
    return manifest;
  }

  async function upsertVaultManifest(ds) {
    let manifest = await readJson(VAULT_MANIFEST);
    if (!manifest || typeof manifest !== 'object') {
      manifest = { version: 1, datasets: [] };
    }
    if (!Array.isArray(manifest.datasets)) manifest.datasets = [];
    const idx = manifest.datasets.findIndex((d) => d.id === ds.id);
    if (idx >= 0) manifest.datasets[idx] = ds;
    else manifest.datasets.push(ds);
    manifest.version = (manifest.version || 1) + 1;
    await writeJson(VAULT_MANIFEST, manifest);
    state.datasets = manifest.datasets;
    return manifest;
  }

  /* ------------------------------------------------------------------ *
   * 文件选取
   * ------------------------------------------------------------------ */

  /**
   * 弹系统文件选择框。
   * 浏览器拿不到本机绝对路径，所以走服务端弹框；服务端返回路径后，
   * 浏览器再用 fetch 逐个取回字节。
   */
  async function pickFiles(opts) {
    opts = opts || {};
    const res = await api('/api/vault/pick-files', {
      filter: opts.filter || '所有文件 (*.*)|*.*',
      description: opts.description || '选择数据文件（可多选）',
    });
    if (!res.paths || !res.paths.length) return [];
    const out = [];
    for (const p of res.paths) {
      try {
        const r = await fetch('/api/vault/read?path=' + encodeURIComponent(p));
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const name = p.split(/[\\/]/).pop();
        out.push(new File([buf], name, { type: 'application/octet-stream' }));
      } catch (err) {
        say('读取失败：' + p + '（' + (err && err.message) + '）');
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 配套文件归组
   * ------------------------------------------------------------------ */

  // 配套文件：不单独成图层，交给同基名的主文件。
  // rpb = 国产卫星 L1A 的 RPC 定位旁挂（高分二号等），与 .tiff 同名配对；
  // prj = 投影定义；aux = PAM 统计；cpg = 编码。
  const SIDECAR_EXT = new Set(['prj', 'rpb', 'aux', 'cpg', 'qix']);
  // Shapefile 的一组：始终收集，但只有在没有别的主文件时 .dbf 才自己当主文件。
  const SHP_SIDECAR_EXT = new Set(['dbf', 'shx']);
  // 这些扩展名**既**可能是配套文件、**也**可能是独立的主文件
  // （ASCII Grid 的 .hdr、ENVI/GML 的 .xml、GDAL 的 .vrt）。
  const AMBIGUOUS_EXT = new Set(['hdr', 'xml', 'vrt']);
  const VECTOR_EXT = new Set([
    'shp', 'gpkg', 'geojson', 'json', 'csv', 'gml', 'gpx', 'dxf', 'wkt', 'kml', 'kmz', 'fgb',
  ]);

  /**
   * 把文件列表分组：主文件 + 配套文件（.prj / .rpb / .hdr 等）。
   * 配套文件按「同基名」匹配 —— 高分二号是 `X-MSS2.tiff` + `X-MSS2.rpb`，
   * 而 ASCII Grid 是 `X.asc` + `X.hdr`。
   *
   * 三个坑：
   *  1. **顺序无关**。用户可能先选 .tiff 再选 .rpb，也可能反过来。
   *     所以配套文件不能写成「只在还没定主文件时才收」——
   *     那会让后到的 .rpb 被当成第二个主文件而丢掉（实际踩到过的 bug：
   *     结果是高分二号影像入库时提示「没有地理参考信息」）。
   *  2. **同名不同扩展名各自成组**：x.geojson 与 x.csv 是两份数据，
   *     但共用同一份 x.prj。
   *  3. **只有配套没有主文件**：x.hdr / x.xml / x.vrt 单独给出来时，
   *     它们自己就是主文件，不能被丢掉。
   */
  function groupFiles(files) {
    const buckets = new Map();
    const order = [];
    for (const file of files || []) {
      const name = file.name || '';
      const key = baseOf(name);
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key).push({ file: file, ext: extOf(name), name: name });
    }

    const groups = [];
    for (const key of order) {
      const items = buckets.get(key);

      const sidecars = new Map();
      const hardSidecars = [];   // 一定是配套
      const ambiguous = [];      // 可能是配套，也可能是主文件
      const shpSidecars = [];

      for (const it of items) {
        if (SIDECAR_EXT.has(it.ext)) {
          sidecars.set(it.ext, it.file);
          hardSidecars.push(it);
        } else if (SHP_SIDECAR_EXT.has(it.ext)) {
          shpSidecars.push(it);
        } else if (AMBIGUOUS_EXT.has(it.ext)) {
          ambiguous.push(it);
        }
      }

      // 硬主文件 = 除歧义项以外的一切
      const hardPrimaries = items.filter(
        (it) => !SIDECAR_EXT.has(it.ext) && !SHP_SIDECAR_EXT.has(it.ext) &&
                !AMBIGUOUS_EXT.has(it.ext)
      );

      // 歧义扩展名的去留：同组有硬主文件 → 当配套；否则自己就是主文件
      const primaries = hardPrimaries.slice();
      if (!hardPrimaries.length) {
        primaries.push.apply(primaries, ambiguous);
      } else {
        for (const it of ambiguous) sidecars.set(it.ext, it.file);
      }

      // Shapefile 一组：.dbf / .shx 归入同组；没有别的主文件时 .dbf 自己当主文件
      if (shpSidecars.length) {
        for (const it of shpSidecars) sidecars.set(it.ext, it.file);
        if (!primaries.length) {
          const dbf = shpSidecars.find((it) => it.ext === 'dbf');
          if (dbf) primaries.push(dbf);
        }
      }

      if (!primaries.length) continue;   // 只有 .prj 之类的孤儿，跳过

      // 第一个主文件沿用基名做组名，其余按扩展名区分
      primaries.forEach((it, i) => {
        groups.push({
          key: i === 0 ? key : key + '#' + it.ext,
          name: i === 0 ? key : key + '.' + it.ext,
          primary: it.file,
          ext: it.ext,
          sidecars: sidecars,
        });
      });
    }
    return groups;
  }

  /* ------------------------------------------------------------------ *
   * 入库：主流程
   * ------------------------------------------------------------------ */

  /**
   * 入库一组文件。
   * @param {File[]} files
   * @param {object} opts { id, name, kind: 'imagery'|'dem'|'auto', minZoom, maxZoom, format }
   * @returns {Promise<object>} 数据集描述
   */
  async function ingest(files, opts) {
    opts = opts || {};
    if (state.busy) throw new Error('正在处理其它数据，请稍候');
    state.busy = true;
    try {
      const groups = groupFiles(files);
      if (!groups.length) throw new Error('没有可处理的文件');

      const results = [];
      for (const g of groups) {
        try {
          const r = await ingestGroup(g, opts);
          if (r) results.push(r);
        } catch (err) {
          say('「' + g.name + '」入库失败：' + (err && err.message ? err.message : err));
          results.push({ id: null, name: g.name, ok: false, error: String(err && err.message || err) });
        }
      }
      if (!results.length) throw new Error('没有成功入库的数据');
      // 清单变了 → 通知侧栏重绘（否则从 API 调 ingest 时侧栏不会更新）
      if (window.LEVaultUI && typeof window.LEVaultUI.refresh === 'function') {
        try { await window.LEVaultUI.refresh(); } catch (_) { /* 界面刷新失败不影响入库 */ }
      }
      return results;
    } finally {
      state.busy = false;
    }
  }

  async function ingestGroup(g, opts) {
    const ext = g.ext;
    const isVector = VECTOR_EXT.has(ext) && ext !== 'json';
    if (isVector) return await ingestVector(g, opts);

    const name = opts.name || g.name;
    const id = opts.id || safeId(g.name);
    const kind = opts.kind && opts.kind !== 'auto'
      ? opts.kind
      : guessKind(g);

    say('处理：' + g.name + '（' + ext + '）');

    const prjFile = g.sidecars.get('prj');
    const rpbFile = g.sidecars.get('rpb');
    const prjText = prjFile ? await readText(prjFile) : null;
    const rpcText = rpbFile ? await readText(rpbFile) : null;

    const src = await window.LEVaultRaster.decodeRaster(g.primary, {
      prjText, rpcText,
      manual: opts.manual || null,
      maxSide: opts.maxSide || 4096,
      bands: opts.bands || null,
    });

    if (!src.geo) {
      throw new Error(
        '没有地理参考信息：' + g.name + '。请一并提供 .prj（投影定义）或 .rpb（卫星 RPC），' +
        '或用「裸二进制」模式手动指定范围。'
      );
    }
    say('已解码：' + src.width + '×' + src.height + '，' + src.bands.length +
        ' 波段，定位：' + src.geo.source);

    if (kind === 'dem') return await buildDemDataset(src, g, id, name, opts);
    return await buildImageryDataset(src, g, id, name, opts);
  }

  /** 根据内容猜类型：单波段 + 有高程数值 → DEM；否则影像。 */
  function guessKind(g) {
    const ext = g.ext;
    if (ext === 'hgt') return 'dem';
    if (ext === 'asc') return 'dem';
    return 'imagery';
  }

  /* --- 影像入库：切 XYZ 瓦片 --- */
  async function buildImageryDataset(src, g, id, name, opts) {
    const geo = src.geo;
    const ext = g.ext;
    const west = geo.west, east = geo.east;
    const south = geo.south, north = geo.north;

    // 按分辨率挑合适的最大层级（避免生成海量瓦片）
    const minZoom = opts.minZoom != null ? opts.minZoom : 8;
    const maxZoom = opts.maxZoom != null ? opts.maxZoom : autoMaxZoom(src, geo);

    const pathPrefix = 'imagery/' + id;
    const files = [];
    const tileSpans = {};
    let count = 0;
    const t0 = Date.now();

    for await (const tile of window.LEVaultRaster.buildImageryTiles(src, {
      minZoom, maxZoom, tileSize: 256,
      format: opts.format || 'jpg',
      quality: opts.quality || 0.9,
      pathPrefix,
    })) {
      files.push({ path: tile.path, data: bytesToBase64(tile.bytes) });
      const key=tile.z+'/'+tile.x, spans=tileSpans[key] || (tileSpans[key]=[]);
      const last=spans[spans.length-1];
      if(last && last[1]+1===tile.y) last[1]=tile.y; else spans.push([tile.y,tile.y]);
      count++;
      if (files.length >= 24) {
        await api('/api/vault/write', { files });
        files.length = 0;
      }
    }
    if (files.length) await api('/api/vault/write', { files });

    say('已写出 ' + count + ' 张瓦片（z' + minZoom + '–' + maxZoom + '）');

    const ds = {
      id: id,
      name: name,
      note: (opts.note || '') + '（本地导入 · ' + (geo.source || '') + '）',
      type: 'xyz',
      scheme: 'webmercator',
      // 路径要和磁盘上实际写出来的一致：vault-raster 写的是
      // imagery/<id>/{z}/{x}/{y}.jpg —— 中间**没有** tiles 这一段。
      // 早先这里多写了个 "tiles/"，图层挂得上但一张瓦片也取不到（整层透明）。
      url: 'data/local/' + pathPrefix + '/{z}/{x}/{y}.' + (opts.format==='png'?'png':'jpg'),
      tileSpans,
      minzoom: minZoom,
      maxzoom: maxZoom,
      bounds: [west, south, east, north],
      attribution: opts.attribution || ('本地导入：' + name),
      opacity: 1.0,
      autoLoad: false,
    };
    await upsertImageryManifest(ds);

    const record = {
      id: id,
      name: name,
      kind: 'imagery',
      createdAt: new Date().toISOString(),
      source: {
        file: g.primary.name,
        size: g.primary.size,
        format: ext,
        width: src.sourceWidth,
        height: src.sourceHeight,
        bands: src.bands.length,
        samplesPerPixel: src.samplesPerPixel,
      },
      geo: { west, south, east, north, mode: geo.mode, source: geo.source },
      tiles: { count, minZoom, maxZoom, dir: pathPrefix },
      layer: { type: 'imagery', manifest: 'imagery.json', entryId: id },
      ok: true,
    };
    await upsertVaultManifest(record);
    return record;
  }

  /** 依据地面分辨率估算合适的最大瓦片层级。 */
  function autoMaxZoom(src, geo) {
    const midLat = (geo.north + geo.south) / 2;
    const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
    const mPerDegLat = 110574;
    // 源像元的地面尺寸
    const srcM = Math.max(
      (Math.abs(geo.east - geo.west) / Math.max(src.width, 1)) * mPerDegLon,
      (Math.abs(geo.north - geo.south) / Math.max(src.height, 1)) * mPerDegLat
    );
    // Web Mercator 在该纬度的每像素米数：156543.03 * cos(lat) / 2^z
    const mPerPx = (z) => (156543.03392 * Math.cos((midLat * Math.PI) / 180)) / (2 ** z);
    let best = 17;
    for (let z = 10; z <= 20; z++) {
      if (mPerPx(z) <= srcM * 2) { best = z; break; }
    }
    return Math.max(10, Math.min(19, best));
  }

  /* --- DEM 入库：生成 int16 金字塔 --- */
  async function buildDemDataset(src, g, id, name, opts) {
    const geo = src.geo;
    const west = geo.west, east = geo.east;
    const south = geo.south, north = geo.north;

    // 层级设计：以源分辨率为最细层，逐级 ×2 变粗
    const spanLon = Math.abs(east - west);
    const spanLat = Math.abs(north - south);
    const levels = [];
    // 最细层：让网格宽度接近源像素数（不放大）
    let baseW = Math.max(64, Math.min(4096, Math.round(src.width)));
    let baseH = Math.max(64, Math.min(4096, Math.round(src.height)));
    // 保持经纬度比例
    const ratio = spanLat / (spanLon || 1);
    baseH = Math.max(64, Math.min(4096, Math.round(baseW * ratio)));
    levels.push({ level: 0, width: baseW, height: baseH });
    // 粗化层（每级一半）
    let lv = 0;
    let w = baseW, h = baseH;
    while ((w > 128 || h > 128) && lv < 4) {
      w = Math.max(64, Math.round(w / 2));
      h = Math.max(64, Math.round(h / 2));
      lv++;
      levels.push({ level: lv, width: w, height: h });
    }

    const files = [];
    let count = 0;
    for await (const part of window.LEVaultRaster.buildDemPyramid(src, {
      levels, tileSize: 256,
      name: name,
      source: (opts.note || '') + '（本地导入）',
      license: opts.license || '',
    })) {
      files.push({ path: 'dem/' + id + '/' + part.path.replace(/^dem\//, ''), data: bytesToBase64(part.bytes) });
      count++;
      if (files.length >= 24) {
        await api('/api/vault/write', { files });
        files.length = 0;
      }
    }
    if (files.length) await api('/api/vault/write', { files });

    say('已写出 ' + count + ' 个 DEM 瓦片文件');

    const record = {
      id: id,
      name: name,
      kind: 'dem',
      createdAt: new Date().toISOString(),
      source: {
        file: g.primary.name,
        size: g.primary.size,
        format: extOf(g.primary.name),
        width: src.sourceWidth,
        height: src.sourceHeight,
      },
      geo: { west, south, east, north, mode: geo.mode, source: geo.source },
      dem: { dir: 'dem/' + id, levels: levels.length, files: count },
      ok: true,
    };
    await upsertVaultManifest(record);
    return record;
  }

  /* --- 矢量入库：直接成为图层 --- */
  async function ingestVector(g, opts) {
    if (!window.LEImportPipeline) throw new Error('导入管线未就绪');
    // 把配套文件一起交给管线
    const files = [g.primary];
    g.sidecars.forEach((f) => files.push(f));
    const res = await window.LEImportPipeline.importFiles(files, state.le);
    say('矢量入库：' + (res.ok ? res.ok.length + ' 个图层' : '失败'));
    const record = {
      id: safeId(g.name),
      name: opts.name || g.name,
      kind: 'vector',
      createdAt: new Date().toISOString(),
      source: { file: g.primary.name, size: g.primary.size, format: g.ext },
      layers: res.ok ? res.ok.map((o) => o.name) : [],
      inMemory: true,
      ok: true,
    };
    await upsertVaultManifest(record);
    return record;
  }

  async function readText(file) {
    try {
      return await file.text();
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 清单与加载
   * ------------------------------------------------------------------ */

  async function refresh() {
    const manifest = await readJson(VAULT_MANIFEST);
    state.datasets = (manifest && Array.isArray(manifest.datasets)) ? manifest.datasets : [];
    return state.datasets;
  }

  function list() {
    return state.datasets.slice();
  }

  /** list() 的内部别名（导清单时避免与局部变量 list 撞名）。 */
  function list_all() {
    return state.datasets.slice();
  }

  /**
   * 把已入库的数据集加载成图层。
   * 影像走「本地影像」模块（XYZ 瓦片）；DEM 需要另行挂载（见 mountDem）。
   */
  async function loadAsLayer(id) {
    const ds = state.datasets.find((d) => d.id === id);
    if (!ds) throw new Error('未找到数据集：' + id);
    if (ds.kind === 'imagery') {
      if (!window.LELocalImagery) throw new Error('本地影像模块未就绪');
      // 清单是启动时读的，运行期新写入的必须重新读一次
      // （init() 已 ready 就直接返回，调它没用）
      if (typeof window.LELocalImagery.reload === 'function') {
        await window.LELocalImagery.reload();
      } else {
        await window.LELocalImagery.init(state.le);
      }
      const rec = await window.LELocalImagery.load(id, { fit: true });
      return rec;
    }
    if (ds.kind === 'vector') {
      toast('矢量数据集在导入时已直接生成图层', 'ok', 2600);
      return null;
    }
    if (ds.kind === 'dem') {
      return await mountDem(ds);
    }
    throw new Error('未知的数据集类型：' + ds.kind);
  }

  /**
   * 把入库的 DEM 挂到地形里。
   *
   * 做法：写一份「地形源清单」，terrain.js 启动时按优先级加载，
   * 高于示例区、低于全国分块 DEM（全国分块是视口级加载的，最精细）。
   */
  async function mountDem(ds) {
    const src = {
      id: ds.id,
      name: ds.name,
      bbox: [ds.geo.west, ds.geo.south, ds.geo.east, ds.geo.north],
      west: ds.geo.west, south: ds.geo.south,
      east: ds.geo.east, north: ds.geo.north,
    };
    // 写进 terrain.js 读的地形源清单
    const listUrl = 'data/local/dem/sources.json';
    const list = (await readJson(listUrl)) || { sources: [] };
    if (!Array.isArray(list.sources)) list.sources = [];
    const item = {
      id: ds.id,
      name: ds.name,
      bbox: src.bbox,
      west: src.west, south: src.south, east: src.east, north: src.north,
      index: 'data/local/' + ds.dem.dir + '/index.json',
      base: 'data/local/' + ds.dem.dir + '/',
    };
    const idx = list.sources.findIndex((s) => s.id === ds.id);
    if (idx >= 0) list.sources[idx] = item;
    else list.sources.push(item);
    list.version = (list.version || 1) + 1;
    await writeJson('dem/sources.json', list);
    toast('DEM 已挂载：' + ds.name + '（重启或刷新地形后生效）', 'ok', 4200);
    return item;
  }

  /** 删磁盘上的数据目录（影像瓦片 / DEM 金字塔）。 */
  async function deleteDisk(id, ds) {
    if (ds && ds.kind==='imagery' && window.LELocalImagery) window.LELocalImagery.unload(id,{silent:true});
    if (ds.kind === 'imagery') {
      try { await api('/api/vault/delete', { path: 'imagery/' + id }); } catch (err) { /* ignore */ }
    } else if (ds.kind === 'dem') {
      try { await api('/api/vault/delete', { path: 'dem/' + id }); } catch (err) { /* ignore */ }
    }
  }

  async function remove(id) {
    const ds = state.datasets.find((d) => d.id === id);
    if (!ds) return false;
    // 先从清单里摘掉
    const manifest = (await readJson(VAULT_MANIFEST)) || { version: 1, datasets: [] };
    manifest.datasets = (manifest.datasets || []).filter((d) => d.id !== id);
    await writeJson(VAULT_MANIFEST, manifest);

    // 影像清单同步摘掉
    if (ds.kind === 'imagery') {
      const im = (await readJson(IMAGERY_MANIFEST)) || { version: 1, datasets: [] };
      im.datasets = (im.datasets || []).filter((d) => d.id !== id);
      await writeJson(IMAGERY_MANIFEST, im);
    }
    await deleteDisk(id, ds);
    await refresh();
    say('已删除数据集：' + id);
    return true;
  }

  /**
   * 批量删除（P0-4.3）。
   * 两份清单只写一次 —— 逐条 remove 会反复读写 vault.json / imagery.json。
   * @param {string[]} ids
   * @returns {Promise<{removed:number, failed:Array}>}
   */
  async function removeMany(ids) {
    const list = (ids || []).filter((id) => !!id);
    if (!list.length) return { removed: 0, failed: [] };
    const set = new Set(list);
    const manifest = (await readJson(VAULT_MANIFEST)) || { version: 1, datasets: [] };
    const victims = (manifest.datasets || []).filter((d) => set.has(d.id));
    manifest.datasets = (manifest.datasets || []).filter((d) => !set.has(d.id));
    manifest.version = (manifest.version || 1) + 1;
    await writeJson(VAULT_MANIFEST, manifest);

    // 影像清单里的对应条目也要摘掉
    const im = (await readJson(IMAGERY_MANIFEST)) || { version: 1, datasets: [] };
    const imBefore = (im.datasets || []).length;
    im.datasets = (im.datasets || []).filter((d) => !set.has(d.id));
    if (im.datasets.length !== imBefore) {
      im.version = (im.version || 1) + 1;
      await writeJson(IMAGERY_MANIFEST, im);
    }

    const failed = [];
    for (const ds of victims) {
      try { await deleteDisk(ds.id, ds); } catch (err) { failed.push(ds.id); }
    }
    await refresh();
    say('批量删除 ' + victims.length + ' 个数据集' + (failed.length ? '（失败 ' + failed.length + '）' : ''));
    return { removed: victims.length, failed: failed };
  }

  /**
   * 改名（P0-4.3）。
   * 只改显示名，不动 id、不动磁盘上的目录 —— id 是瓦片路径的依据，
   * 改了会让已有的图层引用全部失效。
   */
  async function rename(id, newName) {
    const name = String(newName == null ? '' : newName).trim();
    if (!name) throw new Error('新名称不能为空');
    const manifest = (await readJson(VAULT_MANIFEST)) || { version: 1, datasets: [] };
    const ds = (manifest.datasets || []).find((d) => d.id === id);
    if (!ds) throw new Error('未找到数据集：' + id);
    ds.name = name;
    manifest.version = (manifest.version || 1) + 1;
    await writeJson(VAULT_MANIFEST, manifest);

    // 影像清单里也有同一个条目，名字要一起改，否则图层名还是旧的
    if (ds.kind === 'imagery') {
      const im = (await readJson(IMAGERY_MANIFEST)) || { version: 1, datasets: [] };
      const e = (im.datasets || []).find((d) => d.id === id);
      if (e) {
        e.name = name;
        if (typeof e.attribution === 'string' && e.attribution.indexOf('本地导入：') === 0) {
          e.attribution = '本地导入：' + name;
        }
        im.version = (im.version || 1) + 1;
        await writeJson(IMAGERY_MANIFEST, im);
      }
    }
    await refresh();
    say('已重命名：' + id + ' → ' + name);
    return ds;
  }

  /**
   * 批量改名（P0-4.3）。
   * template 支持占位符：{n} 序号（从 1 起）、{name} 原名、{id} 原 id。
   * 例：「{name}_正射」→ 逐个加后缀；「图层{n}」→ 重新编号。
   */
  async function renameMany(ids, template) {
    const list = (ids || []).filter((id) => !!id);
    if (!list.length) return { renamed: 0, failed: [] };
    const tpl = String(template == null ? '' : template);
    if (!tpl.trim()) throw new Error('命名模板不能为空');
    const failed = [];
    let renamed = 0;
    for (let i = 0; i < list.length; i++) {
      const ds = state.datasets.find((d) => d.id === list[i]);
      if (!ds) { failed.push(list[i]); continue; }
      const next = tpl
        .replace(/\{n\}/g, String(i + 1))
        .replace(/\{name\}/g, ds.name || ds.id)
        .replace(/\{id\}/g, ds.id);
      try {
        await rename(ds.id, next);
        renamed++;
      } catch (err) {
        failed.push(ds.id);
      }
    }
    return { renamed: renamed, failed: failed };
  }

  /** CSV 单元格转义：含逗号/引号/换行时用引号包起来。 */
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * 导出入库清单为 CSV（P0-4.3，供归档 / 交接）。
   * 带 UTF-8 BOM，Excel 打开中文不乱码。
   */
  function exportManifestCsv() {
    const rows = [];
    rows.push(['序号', 'ID', '名称', '类型', '来源文件', '格式', '宽', '高', '大小(字节)',
      '西经', '南纬', '东经', '北纬', '定位方式', '瓦片数', '最小层级', '最大层级',
      '金字塔级数', '入库时间', '状态'].join(','));
    const list = list_all();
    list.forEach(function (ds, i) {
      const g = ds.geo || {};
      const s = ds.source || {};
      const t = ds.tiles || {};
      rows.push([
        i + 1, ds.id, ds.name, ds.kind, s.file, s.format, s.width, s.height, s.size,
        g.west, g.south, g.east, g.north, g.source,
        t.count, t.minZoom, t.maxZoom,
        ds.dem ? ds.dem.levels : '',
        ds.createdAt, ds.ok === false ? '失败' : '正常',
      ].map(csvCell).join(','));
    });
    return '\uFEFF' + rows.join('\r\n');
  }

  /** 生成清单文件名（带时间戳，便于归档区分批次）。 */
  function manifestFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return '数据仓库清单_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.csv';
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init(le) {
    if (state.ready) return;
    state.le = le || window.LE;
    if (!state.le || !state.le.viewer) return;
    state.ready = true;
    refresh();
  }

  window.LEVault = {
    init,
    pickFiles,
    ingest,
    groupFiles,
    list,
    refresh,
    loadAsLayer,
    remove,
    removeMany,
    rename,
    renameMany,
    exportManifestCsv,
    manifestFileName,
    mountDem,
    safeId,
    guessKind,
    state,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

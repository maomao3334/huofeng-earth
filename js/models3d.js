/*
 * 三维模型与建筑体块（P1-4.4）
 * ---------------------------------------------------------------------------
 * 两件事：
 *
 *  1. **三维模型导入**：本地 glTF / GLB / OBJ / STL / 3D Tiles，
 *     贴地渲染到地球上。Cesium 原生只认 glTF/GLB 与 3D Tiles，
 *     所以 OBJ / STL 走「浏览器里转成 glTF → 交给 Cesium」的路子，
 *     仍然**纯离线**，不依赖任何外部工具链（不调 QGIS、不调 GDAL）。
 *
 *  2. **建筑体块**：把矢量面（房屋轮廓）按高度字段拉伸成三维体块，
 *     底面贴地、顶面按「绝对高程 / 相对地面高度 / 层数×层高」三种方式计算。
 *     这是 QGIS 的 2.5D extrusion 与 Google Earth 建筑体量效果的合并实现。
 *
 * 纯离线约束：所有解析都在浏览器里做；服务端只在「选文件」与「写盘」时参与。
 *
 * 对外 API（window.LEModels）：
 *   init(le)
 *   isModelExt(ext)
 *   importFiles(files, le)      导入模型文件
 *   pickAndImport(opts)         弹系统文件框 → 导入
 *   addModel(opts)              直接加一个模型
 *   extrudeBuildings(opts)      按面要素生成建筑体块
 *   extrudeFromVector(opts)     按矢量图层生成建筑体块
 *   listModels()                已加载的模型列表
 *   gltfBounds(buf)             读 glTF/GLB 的包围盒
 *   tilesetMeta(text)           读 tileset.json 的中心与半径
 */
(function () {
  'use strict';

  const C = window.Cesium;

  /** Cesium 原生能直接渲染的模型扩展名。 */
  const MODEL_EXT = new Set(['gltf', 'glb']);
  /** 需要在浏览器里转成 glTF 的模型扩展名。 */
  const CONVERTIBLE_EXT = new Set(['obj', 'stl']);
  /** 3D Tiles 数据集（tileset.json）。 */
  const TILESET_EXT = new Set(['json']);

  const state = {
    le: null,
    models: [],
  };

  function getLE() {
    return state.le || window.LE;
  }

  function viewerOf() {
    const le = getLE();
    return le && le.viewer ? le.viewer : null;
  }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg, kind) {
    const le = getLE();
    if (le && le.status) le.status(msg, kind);
  }

  function extOf(name) {
    return (/\.([^.]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || '';
  }

  function baseOf(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  function isModelExt(ext) {
    const e = String(ext || '').toLowerCase();
    return MODEL_EXT.has(e) || CONVERTIBLE_EXT.has(e);
  }

  /* ================================================================== *
   * 一、几何解析：OBJ / STL
   * ================================================================== */

  /**
   * 解析 OBJ（只取 v / vn / f，忽略材质与纹理 —— 建筑/地形模型不需要贴图也能看）。
   * 顶点按「三角形扇」展开，法线与顶点一一对应。
   * @returns {{positions:number[], normals:number[], indices:number[]}}
   */
  function parseObj(text) {
    const v = [];        // 顶点
    const vn = [];       // 法线
    const P = [];        // 展开后的顶点
    const N = [];        // 展开后的法线
    const I = [];        // 索引
    const lines = String(text).split(/\r?\n/);

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.charAt(0) === '#') continue;
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const key = line.slice(0, sp);
      const rest = line.slice(sp + 1).trim();
      if (key === 'v') {
        const p = rest.split(/\s+/);
        v.push(+p[0] || 0, +p[1] || 0, +p[2] || 0);
      } else if (key === 'vn') {
        const p = rest.split(/\s+/);
        vn.push(+p[0] || 0, +p[1] || 0, +p[2] || 0);
      } else if (key === 'f') {
        const parts = rest.split(/\s+/);
        const face = [];
        for (const p of parts) {
          const bits = p.split('/');
          const vi = parseInt(bits[0], 10);
          if (!isFinite(vi)) continue;
          const ni = bits.length > 1 && bits[1] ? parseInt(bits[1], 10) : 0;
          face.push({ v: vi, n: ni });
        }
        if (face.length < 3) continue;
        // 扇形展开：第 0 个点与其余点组成三角形
        for (let i = 1; i < face.length - 1; i++) {
          const tri = [face[0], face[i], face[i + 1]];
          for (const f of tri) {
            const vi = f.v > 0 ? f.v - 1 : v.length / 3 + f.v;
            const ni = f.n > 0 ? f.n - 1 : (vn.length / 3 + f.n);
            P.push(v[vi * 3] || 0, v[vi * 3 + 1] || 0, v[vi * 3 + 2] || 0);
            if (ni >= 0 && ni < vn.length / 3) {
              N.push(vn[ni * 3] || 0, vn[ni * 3 + 1] || 0, vn[ni * 3 + 2] || 0);
            } else {
              N.push(0, 1, 0);
            }
            I.push(I.length);
          }
        }
      }
    }
    if (!P.length) throw new Error('OBJ 里没有可用的面');
    return { positions: P, normals: N, indices: I };
  }

  /**
   * 解析 STL（二进制与 ASCII 都支持）。
   * @returns {{positions:number[], normals:number[], indices:number[]}}
   */
  function parseStl(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // ASCII STL 以 "solid" 开头；二进制也可能以 solid 开头，用长度自检区分。
    const head = new TextDecoder('utf-8').decode(bytes.slice(0, 64)).trim().toLowerCase();
    let ascii = false;
    if (head.indexOf('solid') === 0) {
      const expected = 84 + view.getUint32(80, true) * 50;
      ascii = expected !== bytes.length;
    }

    if (ascii) {
      const text = new TextDecoder('utf-8').decode(bytes);
      const P = []; const N = []; const I = [];
      const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
      let m;
      while ((m = re.exec(text))) {
        P.push(+m[1] || 0, +m[2] || 0, +m[3] || 0);
        N.push(0, 1, 0);
        I.push(I.length);
      }
      if (!P.length) throw new Error('STL 里没有顶点');
      return { positions: P, normals: N, indices: I };
    }

    if (bytes.length < 84) throw new Error('STL 文件长度不足');
    const triCount = view.getUint32(80, true);
    const P = new Array(triCount * 9);
    const N = new Array(triCount * 9);
    const I = new Array(triCount * 3);
    let o = 84;
    for (let i = 0; i < triCount; i++) {
      const nx = view.getFloat32(o, true); o += 4;
      const ny = view.getFloat32(o, true); o += 4;
      const nz = view.getFloat32(o, true); o += 4;
      for (let k = 0; k < 3; k++) {
        const x = view.getFloat32(o, true); o += 4;
        const y = view.getFloat32(o, true); o += 4;
        const z = view.getFloat32(o, true); o += 4;
        const b = (i * 3 + k) * 3;
        P[b] = x; P[b + 1] = y; P[b + 2] = z;
        N[b] = nx; N[b + 1] = ny; N[b + 2] = nz;
        I[i * 3 + k] = i * 3 + k;
      }
    }
    if (!triCount) throw new Error('STL 里没有三角形');
    return { positions: P, normals: N, indices: I };
  }

  /* ================================================================== *
   * 二、极简 glTF 2.0 写入器（OBJ/STL → glTF 用）
   * ================================================================== */

  function pad4(n) { const r = n % 4; return r ? 4 - r : 0; }

  /**
   * 写出一个单网格 glb（POSITION + NORMAL + indices）。
   * @param {number[]} positions
   * @param {number[]} normals
   * @param {number[]} indices
   * @param {object} opts { name, color }
   * @returns {Blob}
   */
  function writeGlb(positions, normals, indices, opts) {
    opts = opts || {};
    const nVerts = (positions.length / 3) | 0;
    const nIdx = indices.length;
    if (!nVerts) throw new Error('几何为空');

    const posArr = new Float32Array(positions);
    const nrmArr = new Float32Array(normals.length === positions.length
      ? normals : new Array(positions.length).fill(0));
    const use32 = nVerts > 65535;
    const idxArr = use32 ? new Uint32Array(indices) : new Uint16Array(indices);

    const posBuf = new Uint8Array(posArr.buffer);
    const nrmBuf = new Uint8Array(nrmArr.buffer);
    const idxBuf = new Uint8Array(idxArr.buffer);

    const bin = new Uint8Array(posBuf.length + nrmBuf.length + idxBuf.length);
    bin.set(posBuf, 0);
    bin.set(nrmBuf, posBuf.length);
    bin.set(idxBuf, posBuf.length + nrmBuf.length);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nVerts; i++) {
      for (let k = 0; k < 3; k++) {
        const val = posArr[i * 3 + k];
        if (val < min[k]) min[k] = val;
        if (val > max[k]) max[k] = val;
      }
    }
    if (!isFinite(min[0])) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }

    const gltf = {
      asset: { version: '2.0', generator: 'Local Earth 模型转换器' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: opts.name || 'mesh' }],
      meshes: [{
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: 0,
          mode: 4,
        }],
      }],
      materials: [{
        name: '默认材质',
        pbrMetallicRoughness: {
          baseColorFactor: opts.color || [0.72, 0.74, 0.78, 1],
          metallicFactor: 0.05,
          roughnessFactor: 0.85,
        },
        doubleSided: true,
      }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: nVerts, type: 'VEC3', min: min, max: max },
        { bufferView: 1, componentType: 5126, count: nVerts, type: 'VEC3' },
        { bufferView: 2, componentType: use32 ? 5125 : 5123, count: nIdx, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
        { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
        { buffer: 0, byteOffset: posBuf.length + nrmBuf.length, byteLength: idxBuf.length, target: 34963 },
      ],
      buffers: [{ byteLength: bin.length }],
    };

    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonPad = pad4(jsonBytes.length);
    const binPad = pad4(bin.length);
    const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let o = 0;
    dv.setUint32(o, 0x46546c67, true); o += 4;   // 'glTF'
    dv.setUint32(o, 2, true); o += 4;            // version 2
    dv.setUint32(o, total, true); o += 4;        // total length

    dv.setUint32(o, jsonBytes.length + jsonPad, true); o += 4;
    dv.setUint32(o, 0x4e4f534a, true); o += 4;   // 'JSON'
    out.set(jsonBytes, o); o += jsonBytes.length;
    for (let i = 0; i < jsonPad; i++) out[o++] = 0x20;

    dv.setUint32(o, bin.length + binPad, true); o += 4;
    dv.setUint32(o, 0x004e4942, true); o += 4;   // 'BIN\0'
    out.set(bin, o);

    return new Blob([out], { type: 'model/gltf-binary' });
  }

  /* ================================================================== *
   * 三、glTF / 3D Tiles 元信息读取
   * ================================================================== */

  /** 从 glb 或 gltf 文本里读出 POSITION 的包围盒 {min:[x,y,z], max:[...]}。 */
  function gltfBounds(input) {
    let json = null;
    try {
      if (typeof input === 'string') {
        json = JSON.parse(input);
      } else {
        const buf = input instanceof ArrayBuffer ? input : input.buffer;
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x46546c67) return null;
        const jsonLen = dv.getUint32(12, true);
        const jsonType = dv.getUint32(16, true);
        if (jsonType !== 0x4e4f534a) return null;
        const bytes = new Uint8Array(buf, 20, jsonLen);
        json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      }
    } catch (err) {
      return null;
    }
    if (!json || !json.accessors) return null;

    let min = null; let max = null;
    for (const m of json.meshes || []) {
      for (const p of m.primitives || []) {
        const acc = json.accessors[p.attributes && p.attributes.POSITION];
        if (!acc || !acc.min || !acc.max) continue;
        if (!min) { min = acc.min.slice(); max = acc.max.slice(); }
        else {
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], acc.min[k]);
            max[k] = Math.max(max[k], acc.max[k]);
          }
        }
      }
    }
    return min ? { min: min, max: max } : null;
  }

  /** 读 tileset.json 的中心点（经纬度）与包围球半径（米）。 */
  function tilesetMeta(text) {
    let j = null;
    try { j = JSON.parse(text); } catch (err) { return null; }
    const bs = j && j.root && j.root.boundingSphere;
    if (!bs || !bs.center) return null;
    const cart = C.Cartographic.fromCartesian(new C.Cartesian3(bs.center[0], bs.center[1], bs.center[2]));
    return {
      lon: C.Math.toDegrees(cart.longitude),
      lat: C.Math.toDegrees(cart.latitude),
      radius: bs.radius || 0,
    };
  }

  /* ================================================================== *
   * 四、模型加载
   * ================================================================== */

  /** 取当前相机中心经纬度（模型默认落点）。 */
  function viewCenter() {
    const viewer = viewerOf();
    if (!viewer) return { lon: 0, lat: 0, height: 0 };
    const c = C.Cartographic.fromCartesian(viewer.camera.position);
    return {
      lon: C.Math.toDegrees(c.longitude),
      lat: C.Math.toDegrees(c.latitude),
      height: c.height,
    };
  }

  /**
   * 取地面高程（米）。
   *
   * 经验结论（Cesium 1.146，本工程实测）：
   *  - `scene.globe.getHeight()` 只在**瓦片已加载**时可信；未加载区域会返回
   *    离谱的负数（实测 (88,43) 处返回 -9861 m）。
   *  - `LE.heightAt()` 走我们自己的 DEM 缓存，加载后与地形一致，但生成体块
   *    的那一刻可能读到**陈旧**值（实测 207 m vs 实际渲染 170 m）。
   *  - 本工程 Cesium 构建里 `sampleHeightMostDetailed` 抛异常、
   *    `terrainProvider.sampleTerrainMostDetailed` 不存在，没有可靠的异步采样器。
   *
   * 因此：优先取 globe.getHeight（与**渲染出来的**地形一致），但要排除垃圾值：
   * 绝对高程范围异常，或与 DEM 缓存相差过大（说明该处瓦片未加载）时，
   * 退回 DEM 缓存值。
   */
  function groundHeightAt(lon, lat) {
    const viewer = viewerOf();
    let globeH = null;
    try {
      if (viewer && viewer.scene && viewer.scene.globe) {
        const g = viewer.scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat));
        if (typeof g === 'number' && isFinite(g) && g > -500 && g < 9000) globeH = g;
      }
    } catch (err) { /* ignore */ }

    const le = getLE();
    let leH = null;
    try {
      if (le && typeof le.heightAt === 'function') {
        const h = Number(le.heightAt(lon, lat));
        if (isFinite(h) && h > -500 && h < 9000) leH = h;
      }
    } catch (err) { /* ignore */ }

    if (globeH != null && leH != null) {
      // 两者接近 → globe 值可信（与渲染地形一致）
      if (Math.abs(globeH - leH) <= 150) return globeH;
      // 差很多 → globe 侧很可能是未加载瓦片的垃圾值，用 DEM 缓存
      return leH;
    }
    if (globeH != null) return globeH;
    if (leH != null) return leH;
    return 0;
  }

  /**
   * 加一个模型图层。
   * @param {object} opts
   *   name             显示名
   *   uri              Cesium 能用的地址（blob: 的 glb / gltf，或 tileset.json）
   *   lon lat          落点；不给就用当前视图中心
   *   height           落点高程（米）
   *   heading pitch roll  姿态（度）
   *   scale            缩放；不给则按 fitSize 自动算
   *   fitSize          目标最大边长（米），与 scale 二选一
   *   sizeHint         已知的模型包围盒尺寸（米），用于自动缩放
   *   clampToGround    是否贴地（默认 true）
   *   color            整体着色（十六进制）
   *   minimumPixelSize 最小屏幕像素尺寸
   *   tileset          true 表示 uri 是 3D Tiles 数据集
   */
  function addModel(opts) {
    opts = opts || {};
    const le = getLE();
    const viewer = viewerOf();
    if (!viewer) throw new Error('三维视图未就绪');
    if (!opts.uri) throw new Error('模型地址为空');

    const center = viewCenter();
    const lon = opts.lon != null ? Number(opts.lon) : center.lon;
    const lat = opts.lat != null ? Number(opts.lat) : center.lat;
    const heading = (Number(opts.heading) || 0) * Math.PI / 180;
    const pitch = (Number(opts.pitch) || 0) * Math.PI / 180;
    const roll = (Number(opts.roll) || 0) * Math.PI / 180;
    const clamp = opts.clampToGround !== false;

    // Cesium 1.146 的 headingPitchRollQuaternion 收 HeadingPitchRoll 对象
    const hpr = new C.HeadingPitchRoll(heading, pitch, roll);
    let position = C.Cartesian3.fromDegrees(lon, lat, Number(opts.height) || 0);
    let orientation = C.Transforms.headingPitchRollQuaternion(position, hpr);
    let ground = 0;
    if (clamp) {
      ground = groundHeightAt(lon, lat);
      position = C.Cartesian3.fromDegrees(lon, lat, ground);
      orientation = C.Transforms.headingPitchRollQuaternion(position, hpr);
    }

    // 缩放：给了 scale 用 scale；否则按「目标最大边长 / 模型实际尺寸」自动算
    let scale = opts.scale != null ? Number(opts.scale) : 1;
    if (opts.scale == null && opts.fitSize && opts.sizeHint > 0) {
      scale = Number(opts.fitSize) / opts.sizeHint;
    }

    const isTileset = !!opts.tileset || /tileset\.json/i.test(String(opts.uri));

    const entry = le.registerLayer({
      name: opts.name || '三维模型',
      type: 'model3d',
      modelUri: opts.uri,
      lon: lon,
      lat: lat,
      height: Number(opts.height) || 0,
      groundHeight: ground,
      scale: scale,
      sizeHint: Number(opts.sizeHint) || 0,
      clampToGround: clamp,
      modelKind: isTileset ? 'tileset' : 'gltf',
      entity: null,
      tileset: null,
      remove: function () {
        try {
          if (this.entity && viewer.entities.remove(this.entity)) return;
          if (this.tileset) viewer.scene.primitives.remove(this.tileset);
        } catch (err) {
          console.error('[LEModels] 删除模型失败', err);
        }
      },
      zoomTo: function () {
        const p = C.Cartesian3.fromDegrees(lon, lat, groundHeightAt(lon, lat) + 200);
        viewer.camera.flyToBoundingSphere(new C.BoundingSphere(p, 300), { duration: 1.4 });
      },
    });

    if (isTileset) {
      const tileset = viewer.scene.primitives.add(new C.Cesium3DTileset({ url: opts.uri }));
      entry.tileset = tileset;
      if (opts.height) {
        tileset.modelMatrix = C.Matrix4.fromTranslation(
          C.Cartesian3.fromDegrees(lon, lat, Number(opts.height))
        );
      }
    } else {
      const graphics = new C.ModelGraphics({
        uri: opts.uri,
        scale: scale,
        minimumPixelSize: opts.minimumPixelSize != null ? Number(opts.minimumPixelSize) : 0,
        heightReference: clamp ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE,
        color: opts.color
          ? C.Color.fromCssColorString(opts.color).withAlpha(opts.colorAlpha != null ? opts.colorAlpha : 1)
          : undefined,
        colorBlendMode: C.ColorBlendMode.REPLACE,
        colorBlendAmount: opts.colorBlendAmount != null ? opts.colorBlendAmount : 1,
        shadows: C.ShadowMode.ENABLED,
        distanceDisplayCondition: opts.maxDistance
          ? new C.DistanceDisplayCondition(0, Number(opts.maxDistance))
          : undefined,
      });
      const entity = viewer.entities.add({
        name: opts.name || '三维模型',
        position: position,
        orientation: orientation,
        model: graphics,
      });
      entry.entity = entity;
    }

    state.models.push(entry);
    return entry;
  }

  /**
   * 导入模型文件（File 列表）。
   * glTF/GLB 直接给 Cesium；OBJ/STL 在浏览器里转 glTF；
   * 3D Tiles（tileset.json）走 Cesium3DTileset。
   * @returns {Promise<{ok:string[], failed:string[]}>}
   */
  async function importFiles(files, le) {
    le = le || getLE();
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return { ok: [], failed: [] };

    const ok = [];
    const failed = [];

    for (const file of list) {
      const ext = extOf(file.name);
      try {
        if (ext === 'glb' || ext === 'gltf') {
          const buf = await file.arrayBuffer();
          const bounds = gltfBounds(ext === 'glb' ? buf : new TextDecoder('utf-8').decode(buf));
          const uri = URL.createObjectURL(file);
          const sizeHint = bounds ? boundsSize(bounds) : 0;
          addModel({
            name: baseOf(file.name),
            uri: uri,
            sizeHint: sizeHint,
            clampToGround: true,
          });
          ok.push(file.name + '（glTF 模型，尺寸约 ' +
            (sizeHint ? Math.round(sizeHint) + ' 米' : '未知') + '）');
        } else if (ext === 'obj' || ext === 'stl') {
          const geo = ext === 'obj'
            ? parseObj(await file.text())
            : parseStl(await file.arrayBuffer());
          const glb = writeGlb(geo.positions, geo.normals, geo.indices, { name: baseOf(file.name) });
          const uri = URL.createObjectURL(glb);
          const sizeHint = boundsSize({ min: minOf(geo.positions), max: maxOf(geo.positions) });
          addModel({
            name: baseOf(file.name),
            uri: uri,
            sizeHint: sizeHint,
            clampToGround: true,
          });
          ok.push(file.name + '（已在浏览器里转成 glTF，' + geo.positions.length / 3 + ' 个顶点）');
        } else if (ext === 'json' && /tileset/i.test(file.name)) {
          const text = await file.text();
          const meta = tilesetMeta(text);
          const uri = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          addModel({
            name: baseOf(file.name),
            uri: uri,
            tileset: true,
            lon: meta ? meta.lon : undefined,
            lat: meta ? meta.lat : undefined,
            clampToGround: false,
          });
          ok.push(file.name + '（3D Tiles 数据集）');
        } else {
          throw new Error('不支持的模型格式：' + (ext ? '.' + ext : '未知'));
        }
      } catch (err) {
        failed.push(file.name + '：' + (err && err.message ? err.message : err));
      }
    }

    if (ok.length) {
      toast('已加载 ' + ok.length + ' 个模型：' + ok.join('；'), 'ok', 5200);
      status('已加载 ' + ok.length + ' 个三维模型');
    }
    if (failed.length) {
      toast('模型加载失败：' + failed.join('；'), 'error', 7000);
    }
    return { ok: ok, failed: failed };
  }

  /** 弹系统文件框选模型文件并导入。 */
  async function pickAndImport(opts) {
    opts = opts || {};
    if (!window.LEVault || typeof window.LEVault.pickFiles !== 'function') {
      toast('文件选择模块未就绪', 'error');
      return { ok: [], failed: [] };
    }
    const files = await window.LEVault.pickFiles({
      filter: opts.filter || '三维模型 (*.glb;*.gltf;*.obj;*.stl;*.json)|*.glb;*.gltf;*.obj;*.stl;*.json|所有文件 (*.*)|*.*',
      description: opts.description || '选择三维模型文件（glTF / GLB / OBJ / STL / 3D Tiles）',
    });
    if (!files || !files.length) return { ok: [], failed: [] };
    return importFiles(files, getLE());
  }

  function minOf(arr) {
    const m = [Infinity, Infinity, Infinity];
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) if (arr[i + k] < m[k]) m[k] = arr[i + k];
    }
    return m;
  }

  function maxOf(arr) {
    const m = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) if (arr[i + k] > m[k]) m[k] = arr[i + k];
    }
    return m;
  }

  function boundsSize(bounds) {
    if (!bounds) return 0;
    return Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    );
  }

  /* ================================================================== *
   * 五、建筑体块（矢量面拉伸）
   * ================================================================== */

  /** 高度模式。 */
  const HEIGHT_MODE = {
    absolute: '绝对高程（字段值即顶面海拔）',
    relative: '相对地面（字段值即建筑高度）',
    floors: '按层数（字段值 × 层高）',
  };

  /**
   * 把一组面要素拉伸成建筑体块。
   *
   * @param {object} opts
   *   name        图层名
   *   features    [{ lon, lat, height, rings, properties }]，rings[0] 为外环
   *   color       建筑颜色（默认 #c9d3de）
   *   alpha       不透明度
   *   minHeight   最小建筑高度（米）
   *   mode        高度模式：absolute / relative / floors
   *   floorHeight 层高（米），mode=floors 时生效
   *   extrude     是否拉伸（false = 只画地面轮廓）
   */
  function extrudeBuildings(opts) {
    opts = opts || {};
    const le = getLE();
    const viewer = viewerOf();
    if (!viewer) throw new Error('三维视图未就绪');
    const features = opts.features || [];
    if (!features.length) throw new Error('没有可拉伸的面要素');

    const color = C.Color.fromCssColorString(opts.color || '#c9d3de')
      .withAlpha(opts.alpha != null ? opts.alpha : 0.92);
    const minHeight = Number(opts.minHeight) || 0.5;
    const mode = opts.mode || 'absolute';
    const floorHeight = Number(opts.floorHeight) || 3;
    const extrude = opts.extrude !== false;

    const ds = new C.CustomDataSource(opts.name || '建筑体块');
    let count = 0;
    let clampedCount = 0;
    let minTop = Infinity;
    let maxTop = -Infinity;

    // 底面相对地面的微小抬高，避免与地形 z-fighting
    const FOOT = 0.02;

    for (const f of features) {
      const rings = f.rings && f.rings.length ? f.rings : (f.coords ? [f.coords] : null);
      if (!rings || !rings.length) continue;
      const outer = rings[0];
      if (!outer || outer.length < 3) continue;

      // 顶面**相对地面**的高度（米）。用 Cesium 原生的 RELATIVE_TO_GROUND，
      // 让 Cesium 自己把体块贴到渲染出来的地形上 —— 避免我们采样的地形
      // 与实际渲染地形不一致导致的「悬空 / 埋入」（实测偏差可达 37 m）。
      let offset;
      let clamped = false;
      const raw = f.height;
      if (raw != null && isFinite(raw)) {
        if (mode === 'relative') {
          offset = raw;
        } else if (mode === 'floors') {
          offset = raw * floorHeight;
        } else {
          // absolute：字段值是绝对海拔 → 换算成相对地面的高度
          const ground = groundHeightAt(outer[0][0], outer[0][1]);
          offset = raw - ground;
        }
        // 顶面不得低于地面（数据高程可能低于本机地形）
        if (offset < minHeight) { offset = minHeight; clamped = true; }
      } else {
        offset = minHeight;
      }
      if (offset > maxTop) maxTop = offset;
      if (offset < minTop) minTop = offset;
      if (clamped) clampedCount++;

      const positions = outer.map((c) =>
        C.Cartesian3.fromDegrees(c[0], c[1], 0)
      );
      const hierarchy = new C.PolygonHierarchy(positions);
      for (let r = 1; r < rings.length; r++) {
        if (!rings[r] || rings[r].length < 3) continue;
        hierarchy.holes.push(new C.PolygonHierarchy(
          rings[r].map((c) => C.Cartesian3.fromDegrees(c[0], c[1], 0))
        ));
      }

      ds.entities.add({
        name: f.name || (opts.name || '建筑'),
        polygon: {
          hierarchy: hierarchy,
          material: color,
          outline: true,
          outlineColor: color.withAlpha(Math.min(1, color.alpha + 0.08)),
          outlineWidth: 1,
          // 高度一律用「相对地面」，由 Cesium 负责贴地
          height: extrude ? FOOT : 0,
          extrudedHeight: extrude ? offset : undefined,
          heightReference: extrude
            ? C.HeightReference.RELATIVE_TO_GROUND
            : C.HeightReference.CLAMP_TO_GROUND,
          extrudedHeightReference: extrude
            ? C.HeightReference.RELATIVE_TO_GROUND
            : undefined,
          perPositionHeight: false,
          shadows: C.ShadowMode.ENABLED,
          // 分类（classificationType）会把多边形「贴」在地形上，那样就**不能拉伸**。
          // 所以：拉伸时用普通多边形；只画地面轮廓（extrude=false）时才用分类。
          classificationType: extrude ? undefined : C.ClassificationType.TERRAIN,
        },
        properties: f.properties || {},
      });
      count++;
    }

    if (!count) throw new Error('没有可用的多边形要素');
    viewer.dataSources.add(ds);

    const entry = le.registerLayer({
      name: opts.name || '建筑体块',
      type: 'vector3d',
      datasource: ds,
      featureCount: count,
      clampedCount: clampedCount,
      fields: opts.fields || [],
      heightRange: isFinite(minTop) ? { min: minTop, max: maxTop } : null,
      remove: function () {
        try { viewer.dataSources.remove(ds, true); } catch (err) { /* ignore */ }
      },
      zoomTo: function () {
        if (window.LEImports && typeof window.LEImports.fitDataSource === 'function') {
          if (window.LEImports.fitDataSource(le, ds)) return;
        }
        viewer.flyTo(ds, { duration: 1.4 }).catch(() => {});
      },
    });
    return entry;
  }

  /**
   * 从已加载的矢量图层生成建筑体块。
   * @param {object} opts
   *   layerEntry   矢量图层条目（le.listLayers() 中 type==='vector'）
   *   heightField  高度字段名（留空则按最小高度拉起）
   *   mode         高度模式 absolute / relative / floors
   *   floorHeight  层高（米）
   *   baseField    底面高程字段（可选）
   */
  function extrudeFromVector(opts) {
    opts = opts || {};
    const le = getLE();
    const entry = opts.layerEntry;
    if (!entry || !entry.datasource) throw new Error('没有可用的矢量图层');
    const entities = entry.datasource.entities.values;
    if (!entities.length) throw new Error('该图层没有要素');

    const hField = opts.heightField || '';
    const bField = opts.baseField || '';
    const floorHeight = Number(opts.floorHeight) || 3;
    const mode = opts.mode || 'absolute';

    const features = [];
    for (const e of entities) {
      const poly = e.polygon;
      if (!poly || !poly.hierarchy) continue;
      const outer = poly.hierarchy.positions.map(toLonLat);
      if (outer.length < 3) continue;
      const rings = [outer];
      for (const h of poly.hierarchy.holes || []) {
        const hr = h.positions.map(toLonLat);
        if (hr.length >= 3) rings.push(hr);
      }

      const props = readProps(e);
      let height = null;
      if (hField && props) {
        const v = Number(props[hField]);
        if (isFinite(v)) height = v;
      }
      let base = null;
      if (bField && props) {
        const v = Number(props[bField]);
        if (isFinite(v)) base = v;
      }
      features.push({
        lon: outer[0][0], lat: outer[0][1],
        height: height,
        base: base,
        rings: rings,
        name: e.name || undefined,
        properties: props,
      });
    }

    if (!features.length) throw new Error('该图层里没有多边形要素');

    return extrudeBuildings({
      name: opts.name || ((entry.name || '矢量') + '·建筑体块'),
      features: features,
      color: opts.color,
      alpha: opts.alpha,
      minHeight: opts.minHeight,
      mode: mode,
      floorHeight: floorHeight,
      extrude: opts.extrude,
    });
  }

  function readProps(entity) {
    try {
      let p = entity.properties;
      if (p && typeof p.getValue === 'function') p = p.getValue(C.JulianDate.now());
      if (p && typeof p.getValue === 'function') p = p.getValue(C.JulianDate.now());
      return p || null;
    } catch (err) {
      return null;
    }
  }

  function toLonLat(pos) {
    const c = C.Cartographic.fromCartesian(pos);
    return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)];
  }

  function listModels() {
    return state.models.slice();
  }

  function init(le) {
    state.le = le || window.LE;
  }

  window.LEModels = {
    init: init,
    addModel: addModel,
    importFiles: importFiles,
    pickAndImport: pickAndImport,
    extrudeBuildings: extrudeBuildings,
    extrudeFromVector: extrudeFromVector,
    listModels: listModels,
    isModelExt: isModelExt,
    parseObj: parseObj,
    parseStl: parseStl,
    writeGlb: writeGlb,
    gltfBounds: gltfBounds,
    tilesetMeta: tilesetMeta,
    boundsSize: boundsSize,
    viewCenter: viewCenter,
    groundHeightAt: groundHeightAt,
    HEIGHT_MODE: HEIGHT_MODE,
    MODEL_EXT: MODEL_EXT,
    CONVERTIBLE_EXT: CONVERTIBLE_EXT,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

/*
 * 图层能力（Lead 版基础实现，layers-dev 在此扩展）
 * 对外 API：window.LELayers
 *   init(le)
 *   addXyzTemplate(le, { name, template, minimumLevel, maximumLevel })
 *   addGeoTiff(le, { file, url, name })
 *   addTerrainFolder(le, { name, url })   // 可选，Cesium quantized-mesh 目录
 */
(function () {
  'use strict';

  const C = window.Cesium;

  function normalizeTemplate(template) {
    return String(template || '').trim().replace(/\\/g, '/');
  }

  function addXyzTemplate(le, opts) {
    const template = normalizeTemplate(opts.template);
    if (!template) throw new Error('瓦片地址模板为空');
    if (!/\{z\}/.test(template) || !/\{x\}/.test(template) || !/\{y\}/.test(template)) {
      throw new Error('模板必须包含 {z}/{x}/{y}');
    }
    const provider = new C.UrlTemplateImageryProvider({
      url: template,
      minimumLevel: opts.minimumLevel != null ? opts.minimumLevel : 0,
      maximumLevel: opts.maximumLevel != null ? opts.maximumLevel : 20,
      credit: opts.credit || opts.name || '本地瓦片',
    });
    const imageryLayer = le.viewer.imageryLayers.addImageryProvider(provider);
    const entry = le.registerLayer({
      name: opts.name || '本地瓦片图层',
      type: 'imagery',
      imageryLayer,
      remove: () => le.viewer.imageryLayers.remove(imageryLayer, true),
      zoomTo: undefined,
    });
    if (window.LELayerOrder) window.LELayerOrder.addUser(entry);
    return entry;
  }

  /**
   * GeoTIFF 以单幅贴图方式叠加。
   * 重要：这里的 bbox 必须是**经纬度**。投影坐标（如中国 Albers，单位米）
   * 的 GeoTIFF 不能直接用 Rectangle.fromDegrees 贴图 —— 服务端会先重投影成
   * EPSG:4326（见 tools/gdal_warp_4326.py），前端只处理 4326 的结果。
   *
   * 国产卫星 L1A（高分二号等）的 GeoTIFF **没有仿射变换**，定位信息在
   * 同名的 `.rpb` 旁挂文件里（RPC）。这类文件走 addRpcRaster() 分支。
   */
  async function addGeoTiff(le, opts) {
    const GeoTIFF = window.GeoTIFF;
    if (!GeoTIFF) throw new Error('GeoTIFF 解析器未加载');
    if (!window.GeoTIFFReady) {
      await new Promise((resolve) => {
        if (window.GeoTIFFReady) return resolve();
        window.addEventListener('geotiff-ready', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    }
    const tiff = opts.file
      ? await GeoTIFF.fromBlob(opts.file)
      : await GeoTIFF.fromUrl(opts.url, { allowFullFile: true });
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();

    let bbox = null;
    try {
      bbox = image.getBoundingBox();
    } catch (err) {
      // RPC-only 的 TIFF 没有仿射变换，getBoundingBox() 会抛异常
      bbox = null;
    }

    if (!bbox || bbox.length < 4 || !isFinite(bbox[0]) || !isFinite(bbox[1]) ||
        !isFinite(bbox[2]) || !isFinite(bbox[3])) {
      // 没有地理范围 → 尝试按 RPC（旁挂 .rpb）处理
      if (opts.rpc) return addRpcRaster(le, opts, { tiff: tiff, image: image });
      throw new Error(
        'GeoTIFF 缺少地理范围信息（该文件没有仿射变换，需要配套的 .rpb 定位文件）'
      );
    }
    // 经纬度合理性检查：投影坐标（米）会让边界远超 ±180 / ±90
    if (
      Math.abs(bbox[0]) > 180.5 || Math.abs(bbox[2]) > 180.5 ||
      Math.abs(bbox[1]) > 90.5 || Math.abs(bbox[3]) > 90.5
    ) {
      throw new Error('GeoTIFF 不是经纬度坐标（可能是投影坐标系），无法直接贴到地球上');
    }
    return addPlainRaster(le, opts, { image: image, bbox: bbox, width: width, height: height });
  }

  /* ------------------------------------------------------------------ *
   * 普通 GeoTIFF（自带仿射变换，bbox 已是经纬度）
   * ------------------------------------------------------------------ */
  async function addPlainRaster(le, opts, ctx) {
    const { image, bbox, width, height } = ctx;
    const rasters = await image.readRasters();
    const samples = rasters.length;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext('2d');
    const imgData = ctx2d.createImageData(width, height);

    function stretch(arr) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!isFinite(min)) return { min: 0, max: 1 };
      return { min, max: max === min ? min + 1 : max };
    }
    const r = rasters[0];
    const g = samples > 1 ? rasters[1] : rasters[0];
    const b = samples > 2 ? rasters[2] : rasters[0];
    const alpha = samples > 3 ? rasters[3] : null;
    const sr = stretch(r);
    const sg = stretch(g);
    const sb = stretch(b);
    const sa = alpha ? stretch(alpha) : null;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const vr = r[i];
      const vg = g[i];
      const vb = b[i];
      // NoData（NaN 或 -9999 之类）像素做成全透明，避免整片出现假值
      if (!isFinite(vr) || !isFinite(vg) || !isFinite(vb)) {
        imgData.data[o] = 0;
        imgData.data[o + 1] = 0;
        imgData.data[o + 2] = 0;
        imgData.data[o + 3] = 0;
        continue;
      }
      imgData.data[o] = Math.round(((vr - sr.min) / (sr.max - sr.min)) * 255);
      imgData.data[o + 1] = Math.round(((vg - sg.min) / (sg.max - sg.min)) * 255);
      imgData.data[o + 2] = Math.round(((vb - sb.min) / (sb.max - sb.min)) * 255);
      imgData.data[o + 3] = alpha
        ? Math.round(((alpha[i] - sa.min) / (sa.max - sa.min)) * 255)
        : 255;
    }
    ctx2d.putImageData(imgData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const rectangle = C.Rectangle.fromDegrees(bbox[0], bbox[1], bbox[2], bbox[3]);
    const provider = new C.SingleTileImageryProvider({
      url: dataUrl,
      rectangle,
      tileWidth: width,
      tileHeight: height,
      credit: opts.name || '本地 GeoTIFF',
    });
    const imageryLayer = le.viewer.imageryLayers.addImageryProvider(provider);
    const entry = le.registerLayer({
      name: opts.name || (opts.file ? opts.file.name : 'GeoTIFF 图层'),
      type: 'imagery',
      imageryLayer,
      remove: () => le.viewer.imageryLayers.remove(imageryLayer, true),
      zoomTo: () => le.flyTo({ rectangle }),
      flyTo: () => le.flyTo({ rectangle }),
    });
    if (window.LELayerOrder) window.LELayerOrder.addUser(entry);
    return entry;
  }

  /* ------------------------------------------------------------------ *
   * RPC 影像（国产卫星 L1A：.tiff + .rpb）
   * ------------------------------------------------------------------ */

  /**
   * 多光谱产品的真彩色波段顺序。
   *
   * 高分二号 PMS：波段 1=蓝 2=绿 3=红 4=近红外 → 真彩色取 3,2,1，
   * 即 geotiff.js readRasters 的 0 基索引 [2,1,0]。
   *
   * 但这是**四波段国产卫星**的约定，不能套用到所有带 .rpb 的文件上：
   *   - ≥4 波段：按 GF2 PMS 的 3,2,1 取色（国产多光谱默认）
   *   - 3 波段  ：已经是 RGB 顺序，原样取 0,1,2
   *   - 1 波段  ：全色（PAN），走灰度
   * 调用方可以用 opts.bands 显式覆盖。
   */
  function rgbSamples(samplesPerPixel, override) {
    if (Array.isArray(override) && override.length) return override.slice();
    if (samplesPerPixel >= 4) return MSS_RGB_SAMPLES.slice();
    if (samplesPerPixel === 3) return [0, 1, 2];
    return null;   // 单波段 → 灰度
  }

  const MSS_RGB_SAMPLES = [2, 1, 0];

  /**
   * 按 RPC 把原始栅格重采样到一张经纬度对齐的画布，再以「贴地影像」叠加。
   *
   * 步骤：
   *   1. 用 RPC 解算影像覆盖的经纬度四至；
   *   2. 在这个范围内划出一张规则的经纬网格（画布）；
   *   3. 每个网格点用 RPC **正向**投影到原影像像素位置（一次求值，无需迭代），
   *      再双线性采样；
   *   4. 结果作为 SingleTileImageryProvider 贴到地球上。
   *
   * 之所以必须重采样到经纬网格：原始像素网格是倾斜的（卫星侧视），
   * 直接贴原图会错位。
   *
   * @param {object} le
   * @param {object} opts { file, name, rpc, resample }
   * @param {object} ctx { tiff, image }
   */
  async function addRpcRaster(le, opts, ctx) {
    const RPC = window.LERpc;
    if (!RPC) throw new Error('RPC 解析器未加载');
    const rpc = opts.rpc;
    const image = ctx.image;
    const srcW = image.getWidth();
    const srcH = image.getHeight();

    // --- 覆盖范围 ---
    const fp = RPC.footprint(rpc, srcW, srcH);
    if (!fp) throw new Error('RPC 无法解算影像的经纬度范围');
    const lonSpan = fp.east - fp.west;
    const latSpan = fp.north - fp.south;
    if (!(lonSpan > 0) || !(latSpan > 0)) {
      throw new Error('RPC 解算出的影像范围无效');
    }

    // --- 目标画布尺寸 ---
    const rOpt = opts.resample || {};
    const maxSize = rOpt.maxSize || 2048;
    const midLat = (fp.north + fp.south) / 2;
    const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
    const mPerDegLat = 110574;
    const srcMetersPerPx = estimateMetersPerPixel(rpc, srcW, srcH, mPerDegLon, mPerDegLat);

    let outW = Math.round((lonSpan * mPerDegLon) / srcMetersPerPx);
    let outH = Math.round((latSpan * mPerDegLat) / srcMetersPerPx);
    outW = Math.max(16, Math.min(maxSize, outW || 256));
    outH = Math.max(16, Math.min(maxSize, outH || 256));

    // --- 读原始数据（降采样，避免把 400 MB / 1.6 GB 全部读进内存）---
    const samplesPerPixel = image.getSamplesPerPixel ? image.getSamplesPerPixel() : 1;
    const readOpts = { interleave: false };
    const wantSamples = rgbSamples(samplesPerPixel, opts.bands);
    if (wantSamples) {
      // 只读真彩色需要的波段（4 波段时跳过近红外）
      readOpts.samples = wantSamples.slice(0, Math.min(wantSamples.length, samplesPerPixel));
    }
    const scaleFactor = Math.min(1, Math.max(outW / srcW, outH / srcH));
    let readW = srcW;
    let readH = srcH;
    if (scaleFactor < 1) {
      readW = Math.max(1, Math.round(srcW * scaleFactor));
      readH = Math.max(1, Math.round(srcH * scaleFactor));
      readOpts.width = readW;
      readOpts.height = readH;
      readOpts.resampleMethod = 'bilinear';
    }

    let rasters;
    try {
      rasters = await image.readRasters(readOpts);
    } catch (err) {
      rasters = await image.readRasters();   // 退回全量读
      readW = srcW;
      readH = srcH;
    }
    if (!rasters || !rasters.length) throw new Error('影像数据读取为空');
    const bufW = readW;
    const bufH = rasters[0].length / (bufW || 1);
    const useRGB = rasters.length >= 3;

    // --- 各波段线性拉伸（2%~98% 分位，避免个别极值压扁整体）---
    const stretches = rasters.map((arr) => stretchBand(arr));

    // --- 生成画布 ---
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx2d = canvas.getContext('2d');
    const imgData = ctx2d.createImageData(outW, outH);

    // 源影像尺寸 → 缓冲区尺寸的换算系数
    const pxScaleX = srcW / bufW;
    const pxScaleY = srcH / (bufH || 1);

    let failed = 0;
    for (let j = 0; j < outH; j++) {
      const lat = fp.north - ((j + 0.5) / outH) * latSpan;
      for (let i = 0; i < outW; i++) {
        const lon = fp.west + ((i + 0.5) / outW) * lonSpan;
        const o = (j * outW + i) * 4;
        // 正向投影：地面 → 原影像像素（一次求值，无需迭代）
        const p = RPC.forward(rpc, lon, lat, 0);
        if (!p) {
          failed++;
          imgData.data[o + 3] = 0;
          continue;
        }
        // p.x/p.y 是「像素角点」坐标，转成缓冲区像素索引
        const srcX = p.x / pxScaleX - 0.5;
        const srcY = p.y / pxScaleY - 0.5;
        if (srcX < -1 || srcY < -1 || srcX > bufW || srcY > bufH) {
          failed++;
          imgData.data[o + 3] = 0;
          continue;
        }
        const c = sampleBilinear(rasters, srcX, srcY, bufW, bufH, stretches, useRGB);
        imgData.data[o] = c[0];
        imgData.data[o + 1] = c[1];
        imgData.data[o + 2] = c[2];
        imgData.data[o + 3] = c[3];
      }
    }
    ctx2d.putImageData(imgData, 0, 0);

    const dataUrl = canvas.toDataURL('image/png');
    const rectangle = C.Rectangle.fromDegrees(fp.west, fp.south, fp.east, fp.north);
    const provider = new C.SingleTileImageryProvider({
      url: dataUrl,
      rectangle,
      tileWidth: outW,
      tileHeight: outH,
      credit: opts.credit || ((opts.name || 'RPC 卫星影像') + ' · RPC 定位'),
    });
    const imageryLayer = le.viewer.imageryLayers.addImageryProvider(provider);

    const entry = le.registerLayer({
      name: opts.name || (opts.file ? opts.file.name : 'RPC 影像'),
      type: 'imagery',
      imageryLayer,
      remove: () => le.viewer.imageryLayers.remove(imageryLayer, true),
      zoomTo: () => le.flyTo({ rectangle }),
      flyTo: () => le.flyTo({ rectangle }),
      rpcInfo: {
        footprint: fp,
        sourceWidth: srcW,
        sourceHeight: srcH,
        outputWidth: outW,
        outputHeight: outH,
        resampled: scaleFactor < 1,
        failedSamples: failed,
        bands: rasters.length,
      },
    });
    if (window.LELayerOrder) window.LELayerOrder.addUser(entry);
    return entry;
  }

  /** 估算原影像的地面分辨率（米/像素）。 */
  function estimateMetersPerPixel(rpc, srcW, srcH, mPerDegLon, mPerDegLat) {
    // RPC 的归一化尺度大致覆盖「半个影像」的范围：
    //   sampScale ↔ (半个影像宽) 对应的经度度数
    //   lineScale ↔ (半个影像高) 对应的纬度度数
    const lonDeg = (rpc.longScale * 2) / srcW;
    const latDeg = (rpc.latScale * 2) / srcH;
    const mx = lonDeg * mPerDegLon;
    const my = latDeg * mPerDegLat;
    const m = (mx + my) / 2;
    return isFinite(m) && m > 0 ? m : 3;
  }

  /** 求一个波段的线性拉伸范围（2%~98% 分位）。 */
  function stretchBand(arr) {
    if (!arr || !arr.length) return { min: 0, max: 1 };
    const n = arr.length;
    const step = Math.max(1, Math.floor(n / 20000));
    const vals = [];
    for (let i = 0; i < n; i += step) {
      const v = arr[i];
      if (isFinite(v)) vals.push(v);
    }
    if (!vals.length) return { min: 0, max: 1 };
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)];
    const hi = vals[Math.floor(vals.length * 0.98)];
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (!isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFinite(mn)) return { min: 0, max: 1 };
      return { min: mn, max: mx === mn ? mn + 1 : mx };
    }
    return { min: lo, max: hi };
  }

  /** 双线性采样；返回 [r,g,b,a]。 */
  function sampleBilinear(rasters, x, y, w, h, stretches, useRGB) {
    if (!isFinite(x) || !isFinite(y)) return [0, 0, 0, 0];
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const cl = (v, a, b) => (v < a ? a : (v > b ? b : v));
    const nBands = useRGB ? 3 : 1;
    const out = [0, 0, 0];
    for (let b = 0; b < nBands; b++) {
      const arr = rasters[b];
      const st = stretches[b] || { min: 0, max: 1 };
      let acc = 0;
      for (let dy = 0; dy <= 1; dy++) {
        const yy = cl(y0 + dy, 0, h - 1);
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx <= 1; dx++) {
          const xx = cl(x0 + dx, 0, w - 1);
          const wx = dx ? fx : 1 - fx;
          const v = arr[yy * w + xx];
          if (!isFinite(v)) continue;
          acc += wx * wy * ((v - st.min) / (st.max - st.min));
        }
      }
      out[b] = Math.round(cl(acc, 0, 1) * 255);
    }
    if (!useRGB) return [out[0], out[0], out[0], 255];
    return [out[0], out[1], out[2], 255];
  }

  /**
   * sRGB 分量 → 线性分量（与着色器 czm_srgbToLinear 的 pow(v, 2.2) 一致）。
   */
  function srgbToLinear(v255) {
    return Math.pow(Math.max(0, Math.min(255, v255)) / 255, 2.2);
  }

  /**
   * 把「sRGB 空间里的最大通道差」换算成着色器实际比较的线性空间阈值。
   *
   * 着色器比较的是线性色与 colorToAlpha 制服值（同样是线性）的最大通道差：
   *     vec3 colorDiff = abs(color.rgb - colorToAlpha.rgb);
   *     colorDiff.r = czm_maximumComponent(colorDiff);
   *     alpha = colorDiff.r < colorToAlpha.a ? 0.0 : alpha;
   * 而 colorToAlpha.a 就是 colorToAlphaThreshold，取值域 [0,1]。
   *
   * 直接把 sRGB 的差值（比如 6/255=0.024）填进去是**错的**：
   * 线性色本来就集中在低值区，阈值稍大一点就把整层全部擦掉
   * （实测阈值 6 → 阴影层被完全抹平，连陆地起伏都没了）。
   * 这里按每个通道线性化前后的差值取最大值，得到一个保守的线性阈值。
   */
  function linearThresholdFromSrgbDelta(key255, delta) {
    let m = 0;
    for (let i = 0; i < 3; i++) {
      const c = key255[i];
      const up = srgbToLinear(c + delta) - srgbToLinear(c);
      const dn = srgbToLinear(c) - srgbToLinear(c - delta);
      if (up > m) m = up;
      if (dn > m) m = dn;
    }
    return m;
  }

  /**
   * 把 '#rrggbb' / [r,g,b] 转成 Cesium 颜色。
   *
   * 【linearize 参数为什么存在】
   *   Cesium 的影像着色器在比对色键前会先把采样值做一次 sRGB→线性化：
   *       value = czm_srgbToLinear(value);      // pow(v, 2.2)
   *       vec3 colorDiff = abs(color.rgb - colorToAlpha.rgb);
   *   而 colorToAlpha 制服值是**直接**从图层属性取的，未经线性化。
   *   两边若不在同一个色彩空间里，色键永远匹配不上（暗色尤其明显）。
   *   linearize=true 时对 rgb 各分量施加 pow(x, 2.2)，与着色器对齐。
   */
  function toCesiumColor(value, linearize) {
    if (!value) return null;
    let r = 0, g = 0, b = 0;
    if (Array.isArray(value) && value.length >= 3) {
      r = value[0]; g = value[1]; b = value[2];
    } else if (typeof value === 'string') {
      const c = C.Color.fromCssColorString(value);
      if (!c) return null;
      r = c.red * 255; g = c.green * 255; b = c.blue * 255;
    } else {
      return null;
    }
    let cr = r / 255, cg = g / 255, cb = b / 255;
    if (linearize) {
      cr = Math.pow(cr, 2.2);
      cg = Math.pow(cg, 2.2);
      cb = Math.pow(cb, 2.2);
    }
    return { color: new C.Color(cr, cg, cb, 1), rgb255: [r, g, b] };
  }

  /**
   * 给 SingleTileImageryProvider 装上「并发去重 + 冲突重试」的 requestImage。
   * 详见 addImageOverlay 里那段注释：Cesium 的 SingleTileImageryProvider
   * 在同一张图被并发请求时会让第二次请求抛错，并把 _hasError 置真，
   * 之后该影像层永远不会有内容。
   */
  function guardSingleTileProvider(provider) {
    if (!provider || provider.__guarded) return provider;
    provider.__guarded = true;
    const orig = provider.requestImage.bind(provider);
    let inflight = null;
    provider.requestImage = function () {
      const self = this;
      // 已经有一次请求在进行 → 复用它，不要再发第二次
      if (inflight) return inflight;
      const args = arguments;
      const run = function () {
        return orig.apply(self, args).catch(function (err) {
          const msg = String((err && err.message) || err || '');
          // 并发冲突：Cesium 内部的 Resource 正在被 fetch。等一下再来一次。
          if (/already being fetched/i.test(msg)) {
            return new Promise(function (res) { setTimeout(res, 60); })
              .then(function () { return orig.apply(self, args); });
          }
          throw err;
        });
      };
      inflight = run().then(
        function (v) { inflight = null; return v; },
        function (e) { inflight = null; throw e; }
      );
      return inflight;
    };
    return provider;
  }

  /** 单幅本地图片叠加（如 DEM 阴影图、扫描图），给出经纬度边界。 */
  function addImageOverlay(le, opts) {
    const r = opts.rectangle;
    if (!r || r.length !== 4) throw new Error('需要 rectangle: [west, south, east, north]');
    const rectangle = C.Rectangle.fromDegrees(r[0], r[1], r[2], r[3]);
    const provider = new C.SingleTileImageryProvider({
      url: opts.url,
      rectangle,
      credit: opts.credit || opts.name || '本地影像',
    });
    // 【为什么必须做「并发去重 + 失败重试」
    //   SingleTileImageryProvider.requestImage() 内部走 Resource.fetchImage()，
    //   同一个 Resource 被并发 fetch 时，第二次会直接抛
    //       "Failed to load image <url>: The Resource is already being fetched."
    //   而 requestImage 一旦抛错，Cesium 会把 provider._hasError 置为 true，
    //   此后 requestImage 直接返回 undefined，**这一层就永久没有影像了**。
    //
    //   触发场景（本项目实测）：地形 Provider 重建（setQuality 改网格 / 改夸张系数）
    //   与「同一帧内新增影像叠加层」撞在一起时，Cesium 会为同一张图发起两次
    //   requestImage（一次来自 _onLayerAdded 建的骨架，一次来自瓦片加载流程），
    //   于是这一层永远停在 loading 状态、屏幕上一个像素都不贡献。
    //   症状：图层在图层面板里正常显示、alpha 也对，但画面上完全看不到它。
    //
    //   修法：自己包一层 requestImage，把并发调用合并成同一次 fetch，
    //         并且在「already being fetched」这类并发冲突上重试一次，
    //         保证 provider 最终一定能拿到图像、_hasError 不会被置上。
    guardSingleTileProvider(provider);
    const imageryLayer = le.viewer.imageryLayers.addImageryProvider(provider);
    if (opts.opacity != null) imageryLayer.alpha = Math.max(0, Math.min(1, opts.opacity));
    // 【色键透明】把指定颜色抠成全透明，PNG 本身没有 alpha 时用来「只保留地形起伏、
    // 让底图透出来」。Cesium 的着色器比较的是像素色与 colorToAlpha 的最大通道差，
    // 差值 < colorToAlphaThreshold 才判为同色并抠掉；threshold 必须 > 0 才生效。
    //
    // opts.colorToAlpha 给的是 sRGB 的 0-255 分量，这里做线性化再写入制服值，
    // 与着色器的 czm_srgbToLinear 对齐（详见 toCesiumColor 的注释）。
    // opts.colorToAlphaThreshold 同样是 **sRGB 空间**的通道差，写入前会换算成线性阈值。
    if (opts.colorToAlpha != null) {
      const c = toCesiumColor(opts.colorToAlpha, true);
      if (c) {
        imageryLayer.colorToAlpha = c.color;
        const delta = opts.colorToAlphaThreshold != null ? opts.colorToAlphaThreshold : 0;
        imageryLayer.colorToAlphaThreshold = linearThresholdFromSrgbDelta(c.rgb255, delta);
      }
    }
    const entry = le.registerLayer({
      name: opts.name || '图片图层',
      type: 'imagery',
      visible: opts.visible !== false,
      imageryLayer,
      remove: () => le.viewer.imageryLayers.remove(imageryLayer, true),
      zoomTo: () => le.flyTo({ rectangle }),
      flyTo: () => le.flyTo({ rectangle }),
    });
    // 登记到图层栈：orderKind 决定它排在系统层（阴影/卫星影像）之上还是之下。
    // 默认 'user'（用户内容压在系统层之上）；地形阴影传 'hillshade'；底图传 'base'。
    if (window.LELayerOrder) {
      if (opts.orderKind === 'hillshade' || opts.orderKind === 'satellite' || opts.orderKind === 'base') {
        window.LELayerOrder.addSystem(entry, opts.orderKind);
      } else {
        window.LELayerOrder.addUser(entry);
      }
    }
    return entry;
  }

  window.InitGeoTiff = function () { window.GeoTIFFReady = true; };
  window.addEventListener('geotiff-ready', window.InitGeoTiff, { once: true });

  window.LELayers = {
    init(le) {
      this.le = le;
    },
    addXyzTemplate,
    addImageOverlay,
    addGeoTiff,
    // 导出给 js/terrain.js 做「差量同步」时的规格比对
    toCesiumColor,
    linearThresholdFromSrgbDelta,
  };
})();

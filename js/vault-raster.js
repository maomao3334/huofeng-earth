/*
 * 数据仓库 · 栅格解码引擎（js/vault-raster.js）
 * ---------------------------------------------------------------------------
 * 目标：**不挑格式**地把任意栅格/影像/DEM 变成「地球上能显示的东西」，
 *       而且**纯离线、零外部进程**（不需要 GDAL / QGIS / Python）。
 *
 * 【设计要点】
 * 1. **解码全在浏览器里**：复用已内置的 geotiff.js（TIFF/GeoTIFF/COG），
 *    加上自带的 ASC / IMG / HGT / 裸二进制 / PGM-PPM 等解析器。
 *    定位有三种来源，按优先级取：
 *      a) GeoTIFF 仿射变换 / GeoTIFF 键（ModelPixelScale + ModelTiepoint）
 *      b) 旁挂 .prj / .aux.xml（投影坐标系定义）
 *      c) 旁挂 .rpb（国产卫星 RPC，见 js/rpc.js）
 *    投影坐标用 proj4（js/projections.js）逆投到 WGS84。
 *
 * 2. **重投影 + 重采样统一到一张经纬度画布**：
 *    对每个画布像元反算到源影像坐标（仿射变换用解析求逆，RPC 用 js/rpc.js 的
 *    forward），双线性采样。这样一幅投影坐标的栅格也能正确贴到球面上。
 *
 * 3. **产物分两类**：
 *    · 影像 → XYZ 瓦片目录（data/local/<id>/tiles/{z}/{x}/{y}.jpg）
 *    · DEM  → int16 金字塔瓦片（data/local/<id>/dem/l{n}/{x}/{y}.bin + index.json）
 *      DEM 目录结构与 js/dem-tiles.js 完全一致，因此可以直接被地形模块读取。
 *
 * 对外 API（window.LEVaultRaster）：
 *   probe(file, opts)        探测：格式、尺寸、波段、是否有地理参考
 *   decodeRaster(file, opts)  解码成 { bands, width, height, geo }
 *   resampleToCanvas(src, ...) 重采样到经纬度画布
 *   buildImageryTiles(...)    切成 XYZ 瓦片
 *   buildDemPyramid(...)      生成 int16 DEM 金字塔
 */
(function () {
  'use strict';

  const C = window.Cesium;

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function isFiniteNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 把 ArrayBuffer 视作按需读取的字节源（大文件不必整体读进内存）。 */
  function makeSource(file) {
    return {
      name: file.name || '',
      size: file.size || 0,
      async slice(start, len) {
        const blob = file.slice(start, start + len);
        return await blob.arrayBuffer();
      },
      async head(len) {
        return new Uint8Array(await this.slice(0, len));
      },
      async text() {
        return new TextDecoder('utf-8', { fatal: false }).decode(
          new Uint8Array(await this.slice(0, this.size))
        );
      },
    };
  }

  /** base64 → Uint8Array（分块避免 apply 的参数上限）。 */
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 格式探测
   * ------------------------------------------------------------------ */

  const RASTER_EXT = {
    tif: 'geotiff', tiff: 'geotiff', gtiff: 'geotiff',
    asc: 'ascii-grid', txt: 'ascii-grid',
    hgt: 'hgt',
    img: 'generic-binary',
    bil: 'bil', raw: 'bil', bin: 'bil',
    pgm: 'pgm', ppm: 'ppm', pnm: 'pgm',
    jp2: 'jpeg2000', j2k: 'jpeg2000',
    vrt: 'vrt',
  };

  /**
   * 探测栅格文件的类型与关键信息。
   * @param {File} file
   * @returns {Promise<object>} { kind, name, size, ... }
   */
  async function probe(file, opts) {
    opts = opts || {};
    const ext = (/\.([^.]+)$/.exec(String(file.name || '').toLowerCase()) || [])[1] || '';
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const src = makeSource(file);

    // --- GeoTIFF 魔数 ---
    const le = head[0] === 0x49 && head[1] === 0x49;
    const be = head[0] === 0x4D && head[1] === 0x4D;
    if ((le || be) && head[2] === 0x2A && head[3] === 0x00) {
      const info = await probeGeotiff(file);
      if (info) return info;
    }
    // BigTIFF
    if ((le || be) && head[2] === 0x2B && head[3] === 0x00) {
      return {
        kind: 'geotiff', bigtiff: true, name: file.name, size: file.size,
        georeferenced: false, note: 'BigTIFF 格式',
      };
    }

    // --- HGT（SRTM）---
    if (ext === 'hgt') {
      const side = Math.round(Math.sqrt(file.size));
      return {
        kind: 'hgt', name: file.name, size: file.size,
        width: side, height: side,
        georeferenced: true,
        geo: { west: -180 + 360 * (Number(opts.hgtCol) || 0), south: 60 - 360 * (Number(opts.hgtRow) || 0),
               east: -180 + 360 * ((Number(opts.hgtCol) || 0) + 1),
               north: 60 - 360 * ((Number(opts.hgtRow) || 0) + 1),
               source: 'hgt（按文件名行列号定位）' },
        note: 'SRTM HGT，需要知道它在 1°×1° 网格里的行列号',
      };
    }

    // --- ASCII Grid ---
    if (ext === 'asc' || ext === 'txt') {
      const headText = (await src.head(1024));
      const txt = new TextDecoder().decode(headText);
      if (/^\s*NCOLS/i.test(txt)) {
        const nc = parseInt((txt.match(/NCOLS\s+(\d+)/i) || [])[1], 10);
        const nr = parseInt((txt.match(/NROWS\s+(\d+)/i) || [])[1], 10);
        const xs = (txt.match(/xllcorner\s+([-\d.eE+]+)/i) || [])[1];
        const ys = (txt.match(/yllcorner\s+([-\d.eE+]+)/i) || [])[1];
        const cs = (txt.match(/cellsize\s+([-\d.eE+]+)/i) || [])[1];
        const geo = (nc && nr && xs != null && ys != null && cs != null)
          ? { west: +xs, south: +ys, east: +xs + nc * +cs, north: +ys + nr * +cs,
              resX: +cs, resY: +cs, source: 'ASCII Grid 头' }
          : null;
        return {
          kind: 'ascii-grid', name: file.name, size: file.size,
          width: nc, height: nr, georeferenced: !!geo, geo,
          note: geo ? '' : '缺少 xllcorner/yllcorner/cellsize，无法定位',
        };
      }
    }

    // --- PGM / PPM（Netpbm）---
    if (ext === 'pgm' || ext === 'ppm' || ext === 'pnm') {
      const p = await probeNetpbm(src);
      if (p) return Object.assign({ name: file.name, size: file.size }, p);
    }

    // --- 裸二进制（BIL/RAW）：没有自描述信息 ---
    if (ext === 'bil' || ext === 'raw' || ext === 'bin' || ext === 'img') {
      return {
        kind: 'generic-binary', name: file.name, size: file.size,
        georeferenced: false,
        note: '裸二进制：需要手动指定尺寸、范围与波段才能入库',
        needsManual: ['width', 'height', 'west', 'south', 'east', 'north', 'bands'],
      };
    }

    return {
      kind: 'unknown', name: file.name, size: file.size,
      georeferenced: false, note: '未识别的栅格格式',
    };
  }

  /* ------------------------------------------------------------------ *
   * GeoTIFF 探测
   * ------------------------------------------------------------------ */

  async function probeGeotiff(file) {
    try {
      const GeoTIFF = window.GeoTIFF;
      if (!GeoTIFF) return null;
      const tiff = await GeoTIFF.fromBlob(file);
      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();
      const spp = image.getSamplesPerPixel ? image.getSamplesPerPixel() : 1;

      let bbox = null;
      let hasAffine = false;
      try {
        bbox = image.getBoundingBox();
        hasAffine = true;
      } catch (err) {
        bbox = null;
      }

      // 投影坐标（米）会让 bbox 远超 ±180/±90 → 说明它是投影坐标系
      let geographic = false;
      if (bbox && bbox.length === 4) {
        geographic = Math.abs(bbox[0]) <= 180.5 && Math.abs(bbox[2]) <= 180.5 &&
                     Math.abs(bbox[1]) <= 90.5 && Math.abs(bbox[3]) <= 90.5;
      }

      let geo = null;
      if (hasAffine && bbox) {
        geo = {
          west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3],
          geographic: geographic,
          source: 'GeoTIFF 仿射变换',
        };
      }
      return {
        kind: 'geotiff', name: file.name, size: file.size,
        width, height, bands: spp,
        georeferenced: !!geo,
        geo,
        hasAffine,
        sampleDepth: image.getSampleDepth ? image.getSampleDepth() : null,
        photometric: image.fileDirectory
          ? image.fileDirectory.getValue('PhotometricInterpretation') : null,
        note: hasAffine
          ? (geographic ? '' : '投影坐标系，需要重投影到经纬度')
          : '没有仿射变换（可能是国产卫星 L1A，需配套 .rpb）',
      };
    } catch (err) {
      return {
        kind: 'geotiff', name: file.name, size: file.size,
        georeferenced: false, note: 'GeoTIFF 解析失败：' + (err && err.message),
      };
    }
  }

  /* ------------------------------------------------------------------ *
   * Netpbm（PGM/PPM）
   * ------------------------------------------------------------------ */

  async function probeNetpbm(src) {
    const buf = new Uint8Array(await src.slice(0, 4096));
    const text = new TextDecoder('latin1').decode(buf);
    if (text.slice(0, 2) !== 'P2' && text.slice(0, 2) !== 'P5' &&
        text.slice(0, 2) !== 'P3' && text.slice(0, 2) !== 'P6') return null;
    const magic = text.slice(0, 2);
    let p = 2;
    const nums = [];
    // 跳过注释（# 开头）并读三个数：宽、高、最大值
    while (nums.length < 3 && p < text.length) {
      const ch = text[p];
      if (ch === '#') {
        while (p < text.length && text[p] !== '\n') p++;
        continue;
      }
      if (/\s/.test(ch)) { p++; continue; }
      let s = '';
      while (p < text.length && !/\s/.test(text[p])) { s += text[p]; p++; }
      const v = parseInt(s, 10);
      if (!isFinite(v)) break;
      nums.push(v);
    }
    if (nums.length < 3) return null;
    return {
      kind: magic === 'P2' || magic === 'P5' ? 'pgm' : 'ppm',
      width: nums[0], height: nums[1], maxValue: nums[2],
      georeferenced: false,
      note: 'Netpbm：需要 .aux.xml 或 .prj 提供地理参考',
    };
  }

  /* ------------------------------------------------------------------ *
   * 地理参考解析
   * ------------------------------------------------------------------ */

  /**
   * 从各种可能的来源拼出「源像素 → WGS84 经纬度」的能力。
   *
   * 返回的 geo 对象：
   *   { mode: 'affine'|'rpc'|'none',
   *     west/south/east/north,          // WGS84 经纬度范围
   *     toLonLat(px, py) → [lon,lat]|null
   *     source: 说明文字 }
   */

  /**
   * 从 GeoTIFF 建立仿射（像素 → 投影坐标 → 经纬度）。
   */
  function affineFromGeotiff(image, prjText) {
    let origin, res;
    try {
      origin = image.getOrigin();
      res = image.getResolution();
    } catch (err) {
      return null;
    }
    if (!origin || !res) return null;

    const w = image.getWidth();
    const h = image.getHeight();
    const px = res[0], py = res[1];

    // 投影坐标 → 经纬度的转换器
    let toLonLat;
    if (prjText && window.LEProj) {
      const crs = window.LEProj.parse(prjText);
      if (crs && crs.ok && !crs.geographic) {
        toLonLat = (x, y) => window.LEProj.toWgs84(crs, x, y);
      } else if (crs && crs.ok && crs.geographic) {
        toLonLat = (x, y) => [x, y];
      }
    }
    // 没有 .prj 时，GeoTIFF 自带的地理键也能判断（GeoKeyDirectory）
    if (!toLonLat) {
      const keys = image.getGeoKeys ? image.getGeoKeys() : null;
      const epsg = keys && keys.ProjectedCSTypeGeoKey;
      const geog = keys && keys.GeographicTypeGeoKey;
      const code = (epsg && epsg !== 32767) ? epsg : (geog && geog !== 32767) ? geog : null;
      if (code && window.LEProj) {
        const crs = window.LEProj.parse('EPSG:' + code);
        if (crs && crs.ok) {
          toLonLat = crs.geographic
            ? (x, y) => [x, y]
            : (x, y) => window.LEProj.toWgs84(crs, x, y);
        }
      }
    }
    // 仍然没有转换器：若仿射原点看起来就是经纬度，直接用
    if (!toLonLat) {
      toLonLat = (x, y) => [x, y];
    }

    const ox = origin[0], oy = origin[1];
    const mapPx = (sx, sy) => [ox + sx * px, oy + sy * py];

    // 记住坐标系与「投影坐标 → 源像素」的线性关系，
    // 让重采样阶段能用 proj4 的**精确逆变换**（见 buildExactInverse）。
    let parsedCrs = null;
    if (prjText && window.LEProj) {
      const c = window.LEProj.parse(prjText);
      if (c && c.ok && !c.geographic) parsedCrs = c;
    }
    if (!parsedCrs && window.LEProj && image.getGeoKeys) {
      try {
        const keys = image.getGeoKeys();
        const code = keys && keys.ProjectedCSTypeGeoKey;
        if (code && code !== 32767) {
          const c = window.LEProj.parse('EPSG:' + code);
          if (c && c.ok && !c.geographic) parsedCrs = c;
        }
      } catch (err) { /* ignore */ }
    }

    // 求经纬度四至：采样四角 + 边中点
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      pts.push([(w * i) / 8, 0], [(w * i) / 8, h], [0, (h * i) / 8], [w, (h * i) / 8]);
    }
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    let ok = 0;
    for (const [sx, sy] of pts) {
      const [mx, my] = mapPx(sx, sy);
      const ll = toLonLat(mx, my);
      if (!ll || !isFiniteNum(ll[0]) || !isFiniteNum(ll[1])) continue;
      ok++;
      west = Math.min(west, ll[0]); east = Math.max(east, ll[0]);
      south = Math.min(south, ll[1]); north = Math.max(north, ll[1]);
    }
    if (!ok) return null;

    return {
      mode: 'affine',
      west, south, east, north,
      crs: parsedCrs,
      origin: { x: ox, y: oy, px: 0, py: 0, sx: px, sy: py },
      toLonLat: (sx, sy) => {
        const [mx, my] = mapPx(sx, sy);
        return toLonLat(mx, my);
      },
      toPixel: null,
      source: prjText ? 'GeoTIFF 仿射变换 + .prj' : 'GeoTIFF 仿射变换',
    };
  }

  /**
   * 从 .rpb 建立 RPC 地理参考。
   */
  function rpcFromSidecar(rpcText, width, height) {
    const rpc = window.LERpc ? window.LERpc.parse(rpcText) : null;
    if (!rpc) return null;
    const fp = window.LERpc.footprint(rpc, width, height);
    if (!fp) return null;
    return {
      mode: 'rpc',
      west: fp.west, south: fp.south, east: fp.east, north: fp.north,
      toLonLat: (sx, sy) => {
        const p = window.LERpc.forward(rpc, sx, sy, 0);
        return p ? [p.x, p.y] : null;
      },
      // RPC 是「地面 → 像素」，要拿到「像素 → 地面」需反向查表；
      // 这里用**地面角点反解**建立像素↔地面的近似线性关系，
      // 精确到像素级的定位交给重采样阶段的正向投影（见 resampleToCanvas）。
      rpc,
      source: 'RPC（.rpb 旁挂）',
    };
  }

  /* ------------------------------------------------------------------ *
   * 解码：读出波段数组
   * ------------------------------------------------------------------ */

  /**
   * 把文件解码成 { bands: [TypedArray...], width, height, geo, samplesPerPixel }。
   *
   * @param {File} file
   * @param {object} opts { rpcText, prjText, manual }
   */
  async function decodeRaster(file, opts) {
    opts = opts || {};
    const info = await probe(file, opts);
    if (!info) throw new Error('无法探测文件');

    if (info.kind === 'geotiff') {
      const GeoTIFF = window.GeoTIFF;
      const tiff = await GeoTIFF.fromBlob(file);
      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();
      const spp = image.getSamplesPerPixel ? image.getSamplesPerPixel() : 1;

      let geo = null;
      if (info.hasAffine) {
        geo = affineFromGeotiff(image, opts.prjText);
      }
      if (!geo && opts.rpcText) {
        geo = rpcFromSidecar(opts.rpcText, width, height);
      }

      // 读波段：按需降采样，避免大文件占满内存
      const maxSide = opts.maxSide || 4096;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const readW = Math.max(1, Math.round(width * scale));
      const readH = Math.max(1, Math.round(height * scale));

      const want = opts.bands && opts.bands.length
        ? opts.bands.slice(0, spp)
        : (spp >= 4 ? [2, 1, 0] : (spp === 3 ? [0, 1, 2] : [0]));

      const rasters = await image.readRasters({
        interleave: false,
        samples: want,
        width: readW,
        height: readH,
        resampleMethod: opts.resampleMethod || 'bilinear',
      });

      return {
        kind: 'geotiff',
        bands: rasters,
        width: readW, height: readH,
        sourceWidth: width, sourceHeight: height,
        // **像素空间换算**：geo 里的 toLonLat / RPC.forward 工作在**原始分辨率**
        // 的像素坐标上，而 rasters 是降采样后的。两者相差一个缩放系数，
        // 不换算就会拿大坐标去索引小数组 —— 结果是几乎全透明。
        pxScaleX: readW / width,
        pxScaleY: readH / height,
        samplesPerPixel: spp,
        usedSamples: want,
        geo,
        probe: info,
      };
    }

    if (info.kind === 'ascii-grid') {
      return decodeAsciiGrid(file, info, opts);
    }

    if (info.kind === 'hgt') {
      return decodeHgt(file, info, opts);
    }

    if (info.kind === 'pgm' || info.kind === 'ppm') {
      return decodeNetpbm(file, info, opts);
    }

    if (info.kind === 'generic-binary') {
      return decodeGenericBinary(file, info, opts);
    }

    throw new Error('暂不支持的栅格格式：' + info.kind);
  }

  /* --- ASCII Grid --- */
  async function decodeAsciiGrid(file, info, opts) {
    const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    const lines = text.split(/\r?\n/);
    let nc = 0, nr = 0, xs = 0, ys = 0, cs = 1, nodata = null;
    let dataStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
      if (m && /^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1])) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'ncols') nc = parseInt(val, 10);
        else if (key === 'nrows') nr = parseInt(val, 10);
        else if (key === 'xllcorner') xs = parseFloat(val);
        else if (key === 'xllcenter') xs = parseFloat(val) - 0;
        else if (key === 'yllcorner') ys = parseFloat(val);
        else if (key === 'yllcenter') ys = parseFloat(val);
        else if (key === 'cellsize') cs = parseFloat(val);
        else if (key === 'nodata_value') nodata = parseFloat(val);
        dataStart = i + 1;
        continue;
      }
      break;
    }
    if (!nc || !nr) throw new Error('ASCII Grid 缺少 ncols/nrows');
    const values = new Float32Array(nc * nr);
    let k = 0;
    for (let i = dataStart; i < lines.length && k < values.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      for (let j = 0; j < parts.length && k < values.length; j++) {
        const v = parseFloat(parts[j]);
        values[k++] = isFinite(v) ? v : (nodata != null ? nodata : 0);
      }
    }
    // geo.west/south/east/north 必须是**经纬度**（其余重采样代码都这么假定），
    // 而 ASCII Grid 头里的 xllcorner/yllcorner 是投影坐标（米）。
    // 这里用 toLonLat 把四个角投到 WGS84，再取四至。
    const corners = [
      [xs, ys],
      [xs + nc * cs, ys],
      [xs, ys + nr * cs],
      [xs + nc * cs, ys + nr * cs],
    ].map(function (p) { return projectPoint(p[0], p[1], opts); })
      .filter(function (ll) { return ll && isFiniteNum(ll[0]) && isFiniteNum(ll[1]); });
    let west = xs, south = ys, east = xs + nc * cs, north = ys + nr * cs;
    if (corners.length) {
      west = Infinity; south = Infinity; east = -Infinity; north = -Infinity;
      corners.forEach(function (ll) {
        west = Math.min(west, ll[0]); east = Math.max(east, ll[0]);
        south = Math.min(south, ll[1]); north = Math.max(north, ll[1]);
      });
    }
    const crs = (opts && opts.prjText && window.LEProj)
      ? window.LEProj.parse(opts.prjText) : null;
    const useCrs = crs && crs.ok && !crs.geographic ? crs : null;
    const geo = {
      mode: 'affine',
      west: west, south: south, east: east, north: north,
      // 精确反解用：CRS 定义 + 「投影坐标 → 源像素」的线性关系
      crs: useCrs,
      origin: { x: xs, y: ys, px: 0, py: nr, sx: cs, sy: -cs },
      toLonLat: (sx, sy) => {
        // ASCII Grid 的 y 从下往上，sy=0 是最下面一行
        const gx = xs + sx * cs;
        const gy = ys + (nr - sy) * cs;
        return projectPoint(gx, gy, opts);
      },
      source: 'ASCII Grid 头',
    };
    return {
      kind: 'ascii-grid', bands: [values], width: nc, height: nr,
      sourceWidth: nc, sourceHeight: nr, samplesPerPixel: 1,
      usedSamples: [0], geo, probe: info, nodata,
    };
  }

  /* --- HGT（SRTM）--- */
  async function decodeHgt(file, info, opts) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const side = Math.floor(Math.sqrt(buf.length / 2));
    const data = new Int16Array(side * side);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < side * side; i++) {
      let h = dv.getInt16(i * 2, true);
      if (h === -32768) h = 0; // nodata
      data[i] = h;
    }
    const g = info.geo;
    const geo = {
      mode: 'affine',
      west: g.west, south: g.south, east: g.east, north: g.north,
      toLonLat: (sx, sy) => {
        // HGT 行序是北→南
        const lon = g.west + (sx / (side - 1)) * (g.east - g.west);
        const lat = g.north - (sy / (side - 1)) * (g.north - g.south);
        return [lon, lat];
      },
      source: 'SRTM HGT',
    };
    return {
      kind: 'hgt', bands: [data], width: side, height: side,
      sourceWidth: side, sourceHeight: side, samplesPerPixel: 1,
      usedSamples: [0], geo, probe: info,
    };
  }

  /* --- Netpbm --- */
  async function decodeNetpbm(file, info, opts) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const magic = String.fromCharCode(buf[0], buf[1]);
    let p = 2;
    const nums = [];
    while (nums.length < 3 && p < buf.length) {
      const ch = String.fromCharCode(buf[p]);
      if (ch === '#') { while (p < buf.length && buf[p] !== 10) p++; continue; }
      if (/\s/.test(ch)) { p++; continue; }
      let s = '';
      while (p < buf.length && !/\s/.test(String.fromCharCode(buf[p]))) {
        s += String.fromCharCode(buf[p]); p++;
      }
      const v = parseInt(s, 10);
      if (!isFinite(v)) break;
      nums.push(v);
    }
    const w = nums[0], h = nums[1], maxv = nums[2];
    p++; // 跳过单个分隔空白
    const isBinary = magic === 'P5' || magic === 'P6';
    const chan = magic === 'P6' ? 3 : 1;
    let bands;
    if (isBinary) {
      const bytes = maxv > 255 ? 2 : 1;
      bands = [];
      for (let c = 0; c < chan; c++) {
        const arr = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const idx = p + (i * chan + c) * bytes;
          arr[i] = bytes === 1 ? buf[idx] : buf[idx] * 256 + buf[idx + 1];
        }
        bands.push(arr);
      }
    } else {
      const text = new TextDecoder().decode(buf.slice(p));
      const vals = text.trim().split(/\s+/).map(Number);
      bands = [];
      for (let c = 0; c < chan; c++) {
        const arr = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) arr[i] = vals[i * chan + c] || 0;
        bands.push(arr);
      }
    }
    const geo = opts.geoOverride ? {
      mode: 'affine',
      west: opts.geoOverride.west, south: opts.geoOverride.south,
      east: opts.geoOverride.east, north: opts.geoOverride.north,
      toLonLat: (sx, sy) => [
        opts.geoOverride.west + (sx / (w - 1)) * (opts.geoOverride.east - opts.geoOverride.west),
        opts.geoOverride.north - (sy / (h - 1)) * (opts.geoOverride.north - opts.geoOverride.south),
      ],
      source: '手动指定范围',
    } : null;
    return {
      kind: info.kind, bands, width: w, height: h,
      sourceWidth: w, sourceHeight: h, samplesPerPixel: chan,
      usedSamples: chan === 3 ? [0, 1, 2] : [0], geo, probe: info,
    };
  }

  /* --- 裸二进制 --- */
  async function decodeGenericBinary(file, info, opts) {
    const m = opts.manual || {};
    const w = Number(m.width), h = Number(m.height);
    if (!w || !h) throw new Error('裸二进制必须指定 width / height');
    const bands = Number(m.bands) || 1;
    const bytesPerSample = Number(m.bytesPerSample) || 2;
    const buf = new Uint8Array(await file.arrayBuffer());
    const out = [];
    for (let c = 0; c < bands; c++) {
      const arr = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const idx = (i * bands + c) * bytesPerSample;
        let v = 0;
        if (bytesPerSample === 1) v = buf[idx];
        else if (bytesPerSample === 2) {
          v = new DataView(buf.buffer, buf.byteOffset).getInt16(idx, true);
        } else if (bytesPerSample === 4) {
          v = new DataView(buf.buffer, buf.byteOffset).getFloat32(idx, true);
        }
        arr[i] = v;
      }
      out.push(arr);
    }
    const geo = m.west != null && m.north != null ? {
      mode: 'affine',
      west: +m.west, south: +m.south, east: +m.east, north: +m.north,
      toLonLat: (sx, sy) => [
        +m.west + (sx / (w - 1)) * (+m.east - +m.west),
        +m.north - (sy / (h - 1)) * (+m.north - +m.south),
      ],
      source: '手动指定范围',
    } : null;
    return {
      kind: 'generic-binary', bands: out, width: w, height: h,
      sourceWidth: w, sourceHeight: h, samplesPerPixel: bands,
      usedSamples: out.map((_, i) => i), geo, probe: info,
    };
  }

  /** 用 .prj 定义把投影坐标转成经纬度；没有定义就当作已经是经纬度。 */
  function projectPoint(x, y, opts) {
    if (opts && opts.prjText && window.LEProj) {
      const crs = window.LEProj.parse(opts.prjText);
      if (crs && crs.ok) {
        if (crs.geographic) return [x, y];
        const ll = window.LEProj.toWgs84(crs, x, y);
        if (ll) return ll;
      }
    }
    return [x, y];
  }

  /**
   * 建立「经纬度 → 源像素」的反向查表（**精确**）。
   *
   * 投影坐标系下「经纬度 → 投影坐标」有精确逆变换（proj4），
   * 不需要像 buildAffineInverse 那样用查找表 + 牛顿迭代近似 ——
   * 近似在投影畸变大时会有几个像元的偏差（实测高斯-克吕格能差 2~3 像元）。
   *
   * @param {object} geo { toLonLat, crs? }
   * @param {object} src
   * @returns {function|null} (lon, lat) → [px, py] | null
   */
  function buildExactInverse(geo, src) {
    const crs = geo.crs;
    if (!crs || !window.LEProj || !window.LEProj.fromWgs84) return null;
    // 仿射变换：投影坐标 → 源像素（**原始分辨率**，与 buildAffineInverse 一致；
    // 调用方会再乘 pxScale 换算到 bands 的像素空间）
    const org = geo.origin;   // { x, y, px, py, sx, sy }
    if (!org) return null;
    return function (lon, lat) {
      const p = window.LEProj.fromWgs84(crs, lon, lat);
      if (!p) return null;
      // 投影坐标 → 源像素（线性）
      const px = org.px + (p[0] - org.x) / org.sx;
      const py = org.py + (p[1] - org.y) / org.sy;
      return [px, py];
    };
  }

  /* ------------------------------------------------------------------ *
   * 重采样：源栅格 → 经纬度画布
   * ------------------------------------------------------------------ */

  /**
   * 把源栅格重采样到一张「经纬度矩形」的画布上。
   *
   * 画布每个像元中心 → WGS84 经纬度 → 源像素坐标 → 双线性采样。
   * 对仿射变换，源像素坐标用**解析逆变换**求出；
   * 对 RPC，用**正向投影**（地面 → 像素）——这是 RPC 的天然方向，
   * 与 GDAL `gdalwarp -rpc` 的做法一致。
   *
   * @param {object} src decodeRaster() 的结果
   * @param {object} opts { width, height, west, south, east, north }
   * @returns {{rgba: Uint8ClampedArray, width, height, stats}}
   */
  async function resampleToCanvas(src, opts) {
    const outW = opts.width;
    const outH = opts.height;
    const west = opts.west, south = opts.south, east = opts.east, north = opts.north;
    const geo = src.geo;
    if (!geo) throw new Error('源数据没有地理参考，无法重采样');

    const srcW = src.width, srcH = src.height;
    const useRGB = src.bands.length >= 3;
    // 像素空间换算系数（geo 工作在原始分辨率，bands 是降采样后的）
    const kx = src.pxScaleX != null ? src.pxScaleX : 1;
    const ky = src.pxScaleY != null ? src.pxScaleY : 1;

    // 预先把「源像素 → 经纬度」的反向关系建好（仿射用解析逆）
    let invLonLat = null;
    if (geo.mode === 'affine') {
      invLonLat = buildExactInverse(geo, src) || buildAffineInverse(geo, src);
    }

    // 拉伸参数（按 2%–98% 分位）
    const stretches = src.bands.map(stretchBand);

    const rgba = new Uint8ClampedArray(outW * outH * 4);
    let filled = 0;
    let failed = 0;

    for (let j = 0; j < outH; j++) {
      const lat = north - ((j + 0.5) / outH) * (north - south);
      for (let i = 0; i < outW; i++) {
        const lon = west + ((i + 0.5) / outW) * (east - west);
        const o = (j * outW + i) * 4;

        let sx = -1, sy = -1;
        if (geo.mode === 'rpc') {
          // RPC：地面 → 像素（正向）。返回的是**原始分辨率**坐标，
          // 要换算到降采样后的像素空间。
          const p = window.LERpc.forward(geo.rpc, lon, lat, 0);
          if (p) { sx = p.x * kx; sy = p.y * ky; }
        } else if (invLonLat) {
          const r = invLonLat(lon, lat);
          if (r) { sx = r[0] * kx; sy = r[1] * ky; }
        }
        if (!(sx >= -1 && sy >= -1 && sx <= srcW && sy <= srcH)) { failed++; continue; }

        const c = sampleBilinear(src.bands, sx, sy, srcW, srcH, stretches, useRGB);
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
        filled++;
      }
    }

    return {
      rgba, width: outW, height: outH,
      stats: { filled, failed, total: outW * outH,
               coverage: outW * outH ? filled / (outW * outH) : 0 },
    };
  }

  /**
   * 多波段重采样：**保留原始数值**（不做 8bit 拉伸）。
   *
   * 栅格分类（监督/非监督）需要的是真实波段值（反射率、高程、DN 值），
   * 而 resampleToCanvas 出来的是显示用的 RGBA，两者不能混用。
   *
   * @param {object} src decodeRaster() 的结果
   * @param {object} opts { width, height, west, south, east, north, bands }
   *   bands: 要保留的源波段索引（默认全部）
   * @returns {{bands: Float32Array[], width, height, stats}}
   */
  function resampleBands(src, opts) {
    const outW = Math.max(1, Math.round(opts.width));
    const outH = Math.max(1, Math.round(opts.height));
    const west = opts.west, south = opts.south, east = opts.east, north = opts.north;
    const geo = src.geo;
    if (!geo) throw new Error('源数据没有地理参考，无法重采样');

    const srcW = src.width, srcH = src.height;
    const kx = src.pxScaleX != null ? src.pxScaleX : 1;
    const ky = src.pxScaleY != null ? src.pxScaleY : 1;

    let invLonLat = null;
    if (geo.mode === 'affine') {
      invLonLat = buildExactInverse(geo, src) || buildAffineInverse(geo, src);
    }

    const keep = (opts.bands && opts.bands.length)
      ? opts.bands.slice(0, src.bands.length)
      : src.bands.map(function (_, i) { return i; });
    const outBands = keep.map(function () { return new Float32Array(outW * outH); });
    outBands.forEach(function (a) { a.fill(NaN); });

    let filled = 0, failed = 0;
    for (let j = 0; j < outH; j++) {
      const lat = north - ((j + 0.5) / outH) * (north - south);
      for (let i = 0; i < outW; i++) {
        const lon = west + ((i + 0.5) / outW) * (east - west);
        let sx = -1, sy = -1;
        if (geo.mode === 'rpc') {
          const p = window.LERpc.forward(geo.rpc, lon, lat, 0);
          if (p) { sx = p.x * kx; sy = p.y * ky; }
        } else if (invLonLat) {
          const r = invLonLat(lon, lat);
          if (r) { sx = r[0] * kx; sy = r[1] * ky; }
        }
        if (!(sx >= -1 && sy >= -1 && sx <= srcW && sy <= srcH)) { failed++; continue; }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const cx = function (v) { return v < 0 ? 0 : (v > srcW - 1 ? srcW - 1 : v); };
        const cy = function (v) { return v < 0 ? 0 : (v > srcH - 1 ? srcH - 1 : v); };
        const o = j * outW + i;
        for (let b = 0; b < keep.length; b++) {
          const arr = src.bands[keep[b]];
          if (!arr) continue;
          let acc = 0, wsum = 0;
          for (let dy = 0; dy <= 1; dy++) {
            const yy = cy(y0 + dy);
            const wy = dy ? fy : 1 - fy;
            for (let dx = 0; dx <= 1; dx++) {
              const xx = cx(x0 + dx);
              const wx = dx ? fx : 1 - fx;
              const v = arr[yy * srcW + xx];
              if (!isFiniteNum(v)) continue;
              acc += wx * wy * v;
              wsum += wx * wy;
            }
          }
          if (wsum > 0.0001) outBands[b][o] = acc / wsum;
        }
        filled++;
      }
    }

    return {
      bands: outBands,
      width: outW, height: outH,
      stats: { filled, failed, total: outW * outH,
               coverage: outW * outH ? filled / (outW * outH) : 0 },
    };
  }

  /**
   * 为仿射变换建立「经纬度 → 源像素」的反向查表。
   *
   * 做法：源影像的经纬度范围一般是个**四边形**（投影坐标下是梯形），
   * 直接解析求逆需要解非线性方程（投影 → 经纬度不可闭式反演）。
   * 这里用**网格查找表 + 双线性插值**：
   *   - 在源像素空间的包围盒上取 N×N 采样点，算出每个点的经纬度；
   *   - 查询时先双线性插值出像素坐标，再反查经纬度做一次修正（牛顿一步）。
   * 对绝大多数用例（投影畸变小）精度足够，且完全离线。
   */
  function buildAffineInverse(geo, src) {
    // 查找表建立在**原始分辨率**的像素空间上 ——
    // geo.toLonLat 接收的正是原始像素坐标（仿射变换的分辨率来自 TIFF 头）。
    const srcW = src.sourceWidth || src.width;
    const srcH = src.sourceHeight || src.height;
    const N = 64; // 查找表分辨率
    const lut = new Float64Array((N + 1) * (N + 1) * 2);
    for (let jj = 0; jj <= N; jj++) {
      for (let ii = 0; ii <= N; ii++) {
        const sx = (ii / N) * srcW;
        const sy = (jj / N) * srcH;
        const ll = geo.toLonLat(sx, sy);
        const k = (jj * (N + 1) + ii) * 2;
        lut[k] = ll ? ll[0] : NaN;
        lut[k + 1] = ll ? ll[1] : NaN;
      }
    }
    const geoRef = geo;
    return function (lon, lat) {
      // 找到 LUT 单元：先按经纬度线性定位到源像素包围盒（近似）
      // 用二分式的粗定位：扫描 LUT 找最近的经纬度格点代价太高，
      // 改用「LUT 参数空间 → 经纬度」的经验线性映射：
      //   地理范围是四边形，用仿射近似它的外接矩形即可做初始猜测。
      const west = geoRef.west, east = geoRef.east;
      const south = geoRef.south, north = geoRef.north;
      // 初始猜测：按经纬度在包围盒内的相对位置
      let u = (lon - west) / ((east - west) || 1);
      let v = (north - lat) / ((north - south) || 1);
      // 迭代修正：把猜测的源像素点投回经纬度，用误差反推参数修正量
      for (let it = 0; it < 4; it++) {
        const gx = clamp(u, 0, 1) * N;
        const gy = clamp(v, 0, 1) * N;
        const i0 = Math.min(N - 1, Math.floor(gx));
        const j0 = Math.min(N - 1, Math.floor(gy));
        const fx = gx - i0, fy = gy - j0;
        const p = sampleLut(lut, N, i0, j0, fx, fy);
        if (!p) return null;
        const eLon = p[0] - lon;
        const eLat = p[1] - lat;
        if (Math.abs(eLon) < 1e-9 && Math.abs(eLat) < 1e-9) break;
        // 用局部梯度做牛顿修正（数值差分）
        const eps = 1e-4;
        const pu = sampleLut(lut, N, Math.min(N - 1, i0 + 1), j0, 0, fy);
        const pv = sampleLut(lut, N, i0, Math.min(N - 1, j0 + 1), fx, 0);
        if (!pu || !pv) break;
        const duLon = pu[0] - p[0], dvLat = pv[1] - p[1];
        if (!isFiniteNum(duLon) || !isFiniteNum(dvLat)) break;
        if (Math.abs(duLon) > 1e-12) u -= eLon / duLon * (1 / N);
        if (Math.abs(dvLat) > 1e-12) v -= eLat / dvLat * (1 / N);
      }
      const sx = clamp(u, 0, 1) * srcW;
      const sy = clamp(v, 0, 1) * srcH;
      if (!isFiniteNum(sx) || !isFiniteNum(sy)) return null;
      return [sx, sy];
    };
  }

  function sampleLut(lut, N, i0, j0, fx, fy) {
    const W = N + 1;
    const k00 = (j0 * W + i0) * 2;
    const k10 = (j0 * W + Math.min(N, i0 + 1)) * 2;
    const k01 = (Math.min(N, j0 + 1) * W + i0) * 2;
    const k11 = (Math.min(N, j0 + 1) * W + Math.min(N, i0 + 1)) * 2;
    const lon = lut[k00] * (1 - fx) * (1 - fy) + lut[k10] * fx * (1 - fy) +
                lut[k01] * (1 - fx) * fy + lut[k11] * fx * fy;
    const lat = lut[k00 + 1] * (1 - fx) * (1 - fy) + lut[k10 + 1] * fx * (1 - fy) +
                lut[k01 + 1] * (1 - fx) * fy + lut[k11 + 1] * fx * fy;
    if (!isFiniteNum(lon) || !isFiniteNum(lat)) return null;
    return [lon, lat];
  }

  /** 2%–98% 分位拉伸。 */
  function stretchBand(arr) {
    if (!arr || !arr.length) return { min: 0, max: 1 };
    const n = arr.length;
    const step = Math.max(1, Math.floor(n / 20000));
    const vals = [];
    for (let i = 0; i < n; i += step) {
      const v = arr[i];
      if (isFiniteNum(v)) vals.push(v);
    }
    if (!vals.length) return { min: 0, max: 1 };
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)];
    const hi = vals[Math.floor(vals.length * 0.98)];
    if (!isFiniteNum(lo) || !isFiniteNum(hi) || hi <= lo) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (!isFiniteNum(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFiniteNum(mn)) return { min: 0, max: 1 };
      return { min: mn, max: mx === mn ? mn + 1 : mx };
    }
    return { min: lo, max: hi };
  }

  /** 双线性采样；越界返回 alpha=0。 */
  function sampleBilinear(bands, x, y, w, h, stretches, useRGB) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const cx = (v) => (v < 0 ? 0 : (v > w - 1 ? w - 1 : v));
    const cy = (v) => (v < 0 ? 0 : (v > h - 1 ? h - 1 : v));
    const nBands = useRGB ? 3 : 1;
    const out = [0, 0, 0];
    for (let b = 0; b < nBands; b++) {
      const arr = bands[b];
      const st = stretches[b] || { min: 0, max: 1 };
      let acc = 0;
      for (let dy = 0; dy <= 1; dy++) {
        const yy = cy(y0 + dy);
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx <= 1; dx++) {
          const xx = cx(x0 + dx);
          const wx = dx ? fx : 1 - fx;
          const v = arr[yy * w + xx];
          if (!isFiniteNum(v)) continue;
          acc += wx * wy * ((v - st.min) / (st.max - st.min));
        }
      }
      out[b] = Math.round(clamp(acc, 0, 1) * 255);
    }
    if (!useRGB) return [out[0], out[0], out[0], 255];
    return [out[0], out[1], out[2], 255];
  }

  /* ------------------------------------------------------------------ *
   * 瓦片切割
   * ------------------------------------------------------------------ */

  /** Web Mercator 的瓦片号。 */
  function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    return [clamp(x, 0, n - 1), clamp(y, 0, n - 1)];
  }

  function tileBounds(x, y, z) {
    const n = 2 ** z;
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
    return { west, south, east, north };
  }

  /**
   * 把源栅格切成 XYZ 瓦片。
   *
   * 做法：对每个瓦片级别，找出与影像范围相交的瓦片，
   * 每个瓦片单独重采样成 256×256 的画布 → PNG/JPEG。
   *
   * @param {object} src decodeRaster() 的结果
   * @param {object} opts { minZoom, maxZoom, tileSize, format, quality }
   * @returns {AsyncGenerator} 逐块产出 { path, bytes, z, x, y }
   */
  async function* buildImageryTiles(src, opts) {
    const tileSize = opts.tileSize || 256;
    const minZoom = opts.minZoom != null ? opts.minZoom : 8;
    const maxZoom = opts.maxZoom != null ? opts.maxZoom : 17;
    const geo = src.geo;
    if (!geo) throw new Error('源数据没有地理参考，无法切瓦片');

    // 影像的经纬度范围与瓦片范围求交
    const iw = geo.west, ie = geo.east, is = geo.south, ino = geo.north;

    for (let z = minZoom; z <= maxZoom; z++) {
      // 该级别的瓦片网格里，与影像范围相交的瓦片
      const [x0, y0] = lonLatToTile(clamp(iw, -179.999, 179.999), clamp(ino, -85, 85), z);
      const [x1, y1] = lonLatToTile(clamp(ie, -179.999, 179.999), clamp(is, -85, 85), z);
      const n = 2 ** z;
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const b = tileBounds(x, y, z);
          // 与影像范围求交（Web Mercator 纬度上限 85.0511）
          const west = Math.max(b.west, iw);
          const east = Math.min(b.east, ie);
          const south = Math.max(b.south, is);
          const north = Math.min(b.north, ino);
          if (east <= west || north <= south) continue;

          const res = await resampleToCanvas(src, {
            width: tileSize, height: tileSize,
            west, south, east, north,
          });
          // 完全没有数据的瓦片跳过（省磁盘）
          if (res.stats.coverage < 0.001) continue;

          const blob = await canvasToBlob(rgbaToCanvas(res.rgba, res.width, res.height), opts);
          if (!blob) continue;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          yield {
            path: opts.pathPrefix + '/' + z + '/' + x + '/' + y + '.' + (opts.format === 'png' ? 'png' : 'jpg'),
            bytes,
            z, x, y,
          };
        }
      }
    }
  }

  function rgbaToCanvas(rgba, w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  function canvasToBlob(canvas, opts) {
    const format = opts && opts.format === 'png' ? 'image/png' : 'image/jpeg';
    const quality = opts && opts.quality ? opts.quality : 0.9;
    return new Promise((resolve) => {
      if (format === 'image/png') {
        canvas.toBlob((b) => resolve(b), format);
      } else {
        canvas.toBlob((b) => resolve(b), format, quality);
      }
    });
  }

  /**
   * 生成 DEM int16 金字塔（与 js/dem-tiles.js 的格式完全一致）。
   *
   * 结构：
   *   <root>/dem/index.json
   *   <root>/dem/l{n}/{tx}/{ty}.bin      256×256 int16-le，行序北→南
   *
   * @param {object} src decodeRaster() 的结果（单波段高程）
   * @param {object} opts { levels: [{level,width,height}], root, meta }
   */
  async function* buildDemPyramid(src, opts) {
    const geo = src.geo;
    if (!geo) throw new Error('源数据没有地理参考，无法生成 DEM');
    const band = src.bands[0];
    const srcW = src.width, srcH = src.height;
    const levels = opts.levels;
    const tileSize = opts.tileSize || 256;

    // 源影像的经纬度范围就是 DEM 的范围
    const west = geo.west, east = geo.east;
    const south = geo.south, north = geo.north;

    // 找出源数据里的高程范围（用于 int16 缩放与元数据）
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (!isFiniteNum(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFiniteNum(mn)) { mn = 0; mx = 1; }

    const index = {
      name: opts.name || '本地 DEM 金字塔',
      source: opts.source || '本地导入',
      license: opts.license || '',
      bbox: [west, south, east, north],
      west, south, east, north,
      rowOrder: 'north-to-south',
      dtype: 'int16-le',
      tileSize,
      scale: 1, offset: 0,
      minHeight: Math.round(mn),
      maxHeight: Math.round(mx),
      levels: [],
    };

    for (const lv of levels) {
      const W = lv.width, H = lv.height;
      // 每层的经纬度网格
      const resDeg = (east - west) / (W - 1);
      const grid = new Float32Array(W * H);
      // 每一行 → 源像素行（双线性）
      const rowMap = new Float32Array(H);
      for (let j = 0; j < H; j++) {
        const lat = north - j * resDeg;
        rowMap[j] = lat;
      }
      // 逐点用同一套重采样逻辑（源像素 → 值）
      const stretches = [{ min: mn, max: mx === mn ? mn + 1 : mx }];
      const useRGB = false;
      for (let j = 0; j < H; j++) {
        const lat = rowMap[j];
        for (let i = 0; i < W; i++) {
          const lon = west + i * resDeg;
          const sp = sourcePixelFor(src, lon, lat);
          let v = 0;
          if (sp) {
            v = sampleBilinear([band], sp[0], sp[1], srcW, srcH, stretches, useRGB)[0];
          }
          grid[j * W + i] = v;
        }
      }
      // 量化到 int16
      const q = new Int16Array(W * H);
      for (let i = 0; i < q.length; i++) {
        q[i] = Math.max(-32768, Math.min(32767, Math.round(grid[i])));
      }
      // 切块写出
      const cols = Math.ceil(W / tileSize);
      const rows = Math.ceil(H / tileSize);
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const block = new Int16Array(tileSize * tileSize);
          const bh = Math.min(tileSize, H - ty * tileSize);
          const bw = Math.min(tileSize, W - tx * tileSize);
          for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) {
              block[y * tileSize + x] = q[(ty * tileSize + y) * W + (tx * tileSize + x)];
            }
          }
          // 边缘瓦片用边缘复制补齐（与 tools/make_china_dem.py 一致）
          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              const sx = Math.min(x, bw - 1);
              const sy = Math.min(y, bh - 1);
              block[y * tileSize + x] = q[(ty * tileSize + sy) * W + (tx * tileSize + sx)];
            }
          }
          yield { path: 'dem/l' + lv.level + '/' + tx + '/' + ty + '.bin',
                  bytes: int16ToBytes(block), z: null, x: tx, y: ty };
        }
      }
      index.levels.push({
        level: lv.level, width: W, height: H, cols, rows,
        tileSize, minHeight: Math.round(mn), maxHeight: Math.round(mx),
        resDeg, west, east, north, south,
        hillshade: null,
      });
    }
    yield { path: 'dem/index.json', bytes: textToBytes(JSON.stringify(index, null, 2)), z: null, x: null, y: null, index };
  }

  /** 找出某经纬度对应的源像素坐标（已换算到 bands 的像素空间）。 */
  function sourcePixelFor(src, lon, lat) {
    const geo = src.geo;
    if (!geo) return null;
    const kx = src.pxScaleX != null ? src.pxScaleX : 1;
    const ky = src.pxScaleY != null ? src.pxScaleY : 1;
    if (geo.mode === 'rpc') {
      const p = window.LERpc.forward(geo.rpc, lon, lat, 0);
      return p ? [p.x * kx, p.y * ky] : null;
    }
    if (geo.mode === 'affine') {
      if (!geo._inv) geo._inv = buildAffineInverse(geo, src);
      const r = geo._inv(lon, lat);
      return r ? [r[0] * kx, r[1] * ky] : null;
    }
    return null;
  }

  function int16ToBytes(arr) {
    const out = new Uint8Array(arr.length * 2);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < arr.length; i++) dv.setInt16(i * 2, arr[i], true);
    return out;
  }

  function textToBytes(text) {
    return new TextEncoder().encode(text);
  }

  window.LEVaultRaster = {
    probe,
    decodeRaster,
    resampleToCanvas,
    resampleBands,
    buildImageryTiles,
    buildDemPyramid,
    stretchBand,
    sampleBilinear,
    tileBounds,
    lonLatToTile,
    base64ToBytes,
    makeSource,
  };
})();

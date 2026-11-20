/*
 * 统一导入管线（js/import-pipeline.js）
 *
 * 把「一堆文件」变成「地球上的图层」，覆盖 QGIS 能打开的常见格式：
 *
 *   矢量  Shapefile(.shp+.dbf+.shx+.prj) / GPKG / GeoJSON / JSON /
 *         CSV(经纬度列或 WKT 列) / GML / GPX / DXF / WKT / KML / KMZ
 *   栅格  GeoTIFF(.tif/.tiff/.gtiff) / ASCII Grid(.asc) / 带 .prj 的栅格
 *
 * 三个关键点（决定「导入后能不能用」）：
 *
 *   1. **配套文件归组**：Shapefile 是 .shp + .dbf + .shx + .prj 四个文件，
 *      只拖 .shp 进来是没用的。管线按「同目录同基名」自动把配套文件配对。
 *
 *   2. **重投影**：国产数据绝大多数是投影坐标（CGCS2000 高斯-克吕格 / UTM …）。
 *      原实现把投影坐标当经纬度，图形会飞到几内亚湾 —— 表现就是「导入了但没法用」。
 *      这里统一用 js/projections.js 逆投影到 WGS84。
 *
 *   3. **属性保留**：几何进 Cesium 实体的同时，属性存到 entity.properties，
 *      属性表（js/attribute-table.js）可以直接查。
 *
 * 导出：window.LEImportPipeline = {
 *   importFiles(files, le),      // 主入口
 *   groupFiles(files),           // 分组（shapefile 配套文件归组）
 *   buildLayer(le, group),       // 单组 → 图层
 * }
 */
(function () {
  'use strict';

  const C = window.Cesium;

  /* ------------------------------------------------------------------ *
   * 文件分组
   * ------------------------------------------------------------------ */

  const VECTOR_KINDS = new Set([
    'shapefile', 'gpkg', 'geojson', 'csv', 'gml', 'gpx', 'dxf', 'wkt', 'kml', 'kmz',
    'flatgeobuf',
  ]);
  const RASTER_KINDS = new Set(['raster', 'ascii-grid']);
  // 配套文件：不单独成图层，交给主文件
  // rpb = 国产卫星 L1A 的 RPC 定位旁挂文件（高分二号等），与 .tiff 同名配对
  const SIDECAR_EXT = new Set(['dbf', 'shx', 'prj', 'cpg', 'qix', 'sbn', 'sbx', 'fix', 'aux', 'rpb']);

  function baseNameOf(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  /**
   * 把文件列表分组。
   * @returns {Array} [{ kind, primary, sidecars:Map, name }]
   */
  function groupFiles(files) {
    const list = Array.from(files || []);
    const groups = [];
    const byKey = new Map();
    // 每个「目录+文件名」共用一份配套文件表。
    // pts.dxf / pts.gpx / pts.gml 用的是同一个 pts.prj，
    // 所以配套文件必须共享，不能各组一份。
    const sidecarsByKey = new Map();

    for (const file of list) {
      const name = file.name || '';
      const ext = (/\.([^.]+)$/.exec(name.toLowerCase()) || [])[1] || '';
      const kind = window.LEFormats.detect(name, null);
      const key = name.includes('/') || name.includes('\\')
        ? name.replace(/[\\/][^\\/]*$/, '') + '/' + baseNameOf(name)
        : baseNameOf(name);

      if (SIDECAR_EXT.has(ext)) {
        // 配套文件：挂到同名的那一组
        let g = byKey.get(key);
        if (!g) {
          g = { key: key, primary: null, sidecars: sidecarsByKey.get(key) || new Map(), name: baseNameOf(name) };
          byKey.set(key, g);
          sidecarsByKey.set(key, g.sidecars);
          groups.push(g);
        }
        g.sidecars.set(ext, file);
        continue;
      }

      let g = byKey.get(key);
      if (!g) {
        const sc = sidecarsByKey.get(key) || new Map();
        sidecarsByKey.set(key, sc);
        g = { key: key, primary: null, sidecars: sc, name: baseNameOf(name) };
        byKey.set(key, g);
        groups.push(g);
      }
      if (!g.primary) {
        g.primary = file;
        g.kind = kind;
        g.name = baseNameOf(name);
      } else {
        // 同名不同扩展名：各自成组（如 x.geojson 与 x.csv），
        // 但共用同一份配套文件（.prj / .dbf）。
        const key2 = key + '#' + ext;
        const g2 = {
          key: key2, primary: file, sidecars: g.sidecars,
          kind: kind, name: baseNameOf(name),
        };
        byKey.set(key2, g2);
        groups.push(g2);
      }
    }

    // 只有配套文件没有主文件 → 标为不完整
    for (const g of groups) {
      g.complete = !!g.primary;
      if (!g.primary && g.sidecars.has('shp')) {
        // .shp 缺失但有 .shx/.dbf —— 无几何，不可导入
        g.incompleteReason = '缺少 .shp 几何文件';
      }
    }
    return groups;
  }

  /* ------------------------------------------------------------------ *
   * 重投影
   * ------------------------------------------------------------------ */

  /**
   * 把解析出来的要素坐标从「文件里的坐标系」转到 WGS84。
   * @returns {{ features, crsInfo, reprojected }}
   */
  function reproject(parsed) {
    const warnings = [];
    const crsText = parsed.crs;
    const info = { source: null, geographic: true, applied: false };

    if (!crsText) {
      // 没有坐标系信息：按经纬度处理，但检查数值是否像经纬度
      const sample = firstCoord(parsed.features);
      if (sample && (Math.abs(sample[0]) > 180 || Math.abs(sample[1]) > 90)) {
        warnings.push(
          '文件里没有坐标系信息，但坐标看起来是投影坐标（' +
          sample[0].toFixed(0) + ', ' + sample[1].toFixed(0) +
          '），已按经纬度处理，位置可能不正确'
        );
      }
      return { features: parsed.features, crsInfo: info, reprojected: false, warnings: warnings };
    }

    const crs = window.LEProj.parse(crsText);
    if (!crs.ok) {
      warnings.push('坐标系无法识别：' + crs.error + '（按经纬度处理）');
      return { features: parsed.features, crsInfo: info, reprojected: false, warnings: warnings };
    }

    // source = 可读的短名（QGIS 里显示的那种）
    // wkt    = 文件里原始的坐标系定义（图层属性里要看）
    info.source = crs.name || crsText;
    info.wkt = crsText;
    info.epsg = crs.epsg || crs.code || null;
    info.geographic = !!crs.geographic;
    if (crs.name) info.display = crs.name;

    if (crs.geographic) {
      return { features: parsed.features, crsInfo: info, reprojected: false, warnings: warnings };
    }

    // 投影坐标 → WGS84
    let ok = 0;
    let bad = 0;
    for (const f of parsed.features) {
      if (f.type === 'point' && f.coords) {
        const r = window.LEProj.toWgs84(crs, f.coords[0], f.coords[1]);
        if (r) { f.coords = r; ok++; } else bad++;
      } else if (f.type === 'line' && f.coords) {
        const r = window.LEProj.transformMany(crs, f.coords);
        f.coords = r.filter(Boolean);
        ok++;
      } else if (f.type === 'polygon' && f.rings) {
        f.rings = f.rings.map((ring) => window.LEProj.transformMany(crs, ring).filter(Boolean));
        ok++;
      } else if (f.type === 'multipoint' && f.coords) {
        const r = window.LEProj.transformMany(crs, f.coords);
        f.coords = r.filter(Boolean);
        ok++;
      } else if (f.type === 'multiline' && f.coords) {
        f.coords = f.coords.map((line) => window.LEProj.transformMany(crs, line).filter(Boolean));
        ok++;
      } else if (f.type === 'multipolygon' && f.rings) {
        f.rings = f.rings.map((poly) => poly.map((ring) => window.LEProj.transformMany(crs, ring).filter(Boolean)));
        ok++;
      }
    }
    info.applied = true;
    if (bad) warnings.push(bad + ' 个点无法重投影（坐标超出该投影的有效范围）');
    return { features: parsed.features, crsInfo: info, reprojected: true, warnings: warnings };
  }

  function firstCoord(features) {
    for (const f of features) {
      if (f.type === 'point' && f.coords && f.coords.length >= 2) return f.coords;
      if (f.type === 'line' && f.coords && f.coords.length) return f.coords[0];
      if (f.type === 'polygon' && f.rings && f.rings.length) return f.rings[0][0];
    }
    return null;
  }

  /** 这些要素的坐标是不是明显不是经纬度（超出经纬度范围）？ */
  function looksProjected(features) {
    const c = firstCoord(features);
    if (!c) return false;
    return Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90;
  }

  /* ------------------------------------------------------------------ *
   * 建 Cesium 图层
   * ------------------------------------------------------------------ */

  const CARTO = C.Cartographic.fromCartesian;

  function toCartesian(lon, lat, height) {
    return C.Cartesian3.fromDegrees(lon, lat, height || 0);
  }

  /**
   * 把统一结构的要素转成 Cesium 实体。
   * 属性放在 entity.properties（Cesium Entity 的自定义属性字段）。
   */
  function featuresToEntities(le, features, opts) {
    opts = opts || {};
    const clamp = opts.clampToGround !== false;
    const entities = [];
    const now = C.JulianDate.now();

    const elev = (lon, lat) => {
      if (!clamp) return 0;
      try {
        if (le && typeof le.heightAt === 'function') {
          return (le.heightAt(lon, lat) || 0) + 2;
        }
      } catch (err) { /* ignore */ }
      return 0;
    };

    for (const f of features) {
      const props = Object.assign({}, f.properties || {});
      const id = opts.idPrefix ? opts.idPrefix + '-' + entities.length : undefined;

      if (f.type === 'point') {
        if (!f.coords || f.coords.length < 2) continue;
        const lon = f.coords[0];
        const lat = f.coords[1];
        entities.push({
          id: id,
          position: toCartesian(lon, lat, elev(lon, lat)),
          point: {
            pixelSize: 9,
            color: C.Color.fromCssColorString(opts.pointColor || '#ffd166').withAlpha(0.95),
            outlineColor: C.Color.fromCssColorString('#20262e').withAlpha(0.9),
            outlineWidth: 1.5,
          },
          properties: props,
          name: props.name || props.NAME || props.title || undefined,
        });
      } else if (f.type === 'multipoint') {
        for (const c of f.coords || []) {
          if (!c || c.length < 2) continue;
          entities.push({
            position: toCartesian(c[0], c[1], elev(c[0], c[1])),
            point: {
              pixelSize: 8,
              color: C.Color.fromCssColorString(opts.pointColor || '#ffd166').withAlpha(0.95),
              outlineColor: C.Color.fromCssColorString('#20262e').withAlpha(0.9),
              outlineWidth: 1.2,
            },
            properties: Object.assign({}, props),
          });
        }
      } else if (f.type === 'line' || f.type === 'multiline') {
        const lines = f.type === 'line' ? [f.coords] : f.coords;
        for (const line of lines || []) {
          if (!line || line.length < 2) continue;
          entities.push({
            polyline: {
              positions: line.map((c) => toCartesian(c[0], c[1], elev(c[0], c[1]))),
              width: opts.lineWidth || 2.4,
              material: C.Color.fromCssColorString(opts.lineColor || '#6fd6b4').withAlpha(0.95),
              clampToGround: clamp,
              arcType: C.ArcType.GEODESIC,
            },
            properties: Object.assign({}, props),
            name: props.name || props.NAME || undefined,
          });
        }
      } else if (f.type === 'polygon' || f.type === 'multipolygon') {
        const polys = f.type === 'polygon' ? [f.rings] : f.rings;
        for (const rings of polys || []) {
          if (!rings || !rings.length) continue;
          const positions = rings[0].map((c) => toCartesian(c[0], c[1], elev(c[0], c[1])));
          const hierarchy = new C.PolygonHierarchy(positions);
          for (let r = 1; r < rings.length; r++) {
            hierarchy.holes.push(
              new C.PolygonHierarchy(rings[r].map((c) => toCartesian(c[0], c[1], elev(c[0], c[1]))))
            );
          }
          entities.push({
            polygon: {
              hierarchy: hierarchy,
              material: C.Color.fromCssColorString(opts.fillColor || '#4c9be8').withAlpha(0.32),
              outline: true,
              outlineColor: C.Color.fromCssColorString(opts.lineColor || '#6fd6b4').withAlpha(0.95),
              outlineWidth: 1.6,
              arcType: C.ArcType.GEODESIC,
              height: 0,
              perPositionHeight: false,
            },
            properties: Object.assign({}, props),
            name: props.name || props.NAME || undefined,
          });
        }
      }
    }
    return entities;
  }

  /**
   * 把实体加进一个新的 CustomDataSource 并注册成图层。
   */
  async function addEntitiesAsLayer(le, entities, meta) {
    const ds = new C.CustomDataSource(meta.name || '导入图层');
    for (const e of entities) {
      try {
        ds.entities.add(e);
      } catch (err) {
        console.warn('[LEImportPipeline] 实体添加失败：', err);
      }
    }
    await le.viewer.dataSources.add(ds);

    const entry = le.registerLayer({
      name: meta.name,
      type: 'vector',
      datasource: ds,
      featureCount: entities.length,
      fields: meta.fields || [],
      crs: meta.crsInfo ? meta.crsInfo.source : null,
      crsWkt: meta.crsInfo ? (meta.crsInfo.wkt || null) : null,
      crsEpsg: meta.crsInfo ? (meta.crsInfo.epsg || null) : null,
      reprojected: meta.crsInfo ? meta.crsInfo.applied : false,
      attributes: meta.attributes || [],
      remove: () => le.viewer.dataSources.remove(ds, true),
      zoomTo: () => {
        if (!window.LEImports.fitDataSource(le, ds)) {
          le.viewer.flyTo(ds, { duration: 1.4 }).catch(() => {});
        }
      },
      flyTo: () => {
        if (!window.LEImports.fitDataSource(le, ds)) {
          le.viewer.flyTo(ds, { duration: 1.4 }).catch(() => {});
        }
      },
    });
    return entry;
  }

  /* ------------------------------------------------------------------ *
   * 单组 → 图层
   * ------------------------------------------------------------------ */

  /**
   * 建一个图层。
   * @param {object} le
   * @param {object} group groupFiles() 的一组
   * @returns {Promise<object>} { ok, name, count, kind, warnings, crsInfo }
   */
  async function buildLayer(le, group) {
    if (!group.primary) {
      throw new Error(group.incompleteReason || '缺少主文件');
    }
    const file = group.primary;
    const name = group.name || file.name;

    // --- KML / KMZ：走原生渲染器（性能最好，支持样式） ---
    const ext = (/\.([^.]+)$/.exec(file.name.toLowerCase()) || [])[1] || '';
    if (ext === 'kml' || ext === 'kmz') {
      return buildKmlLayer(le, file, name);
    }

    // --- 三维模型（glTF / GLB / OBJ / STL / 3D Tiles）---
    if (window.LEModels && typeof window.LEModels.isModelExt === 'function'
      && window.LEModels.isModelExt(ext)) {
      return buildModelLayer(le, file, name);
    }
    if (ext === 'json' && /tileset/i.test(file.name)) {
      return buildModelLayer(le, file, name);
    }

    // --- 栅格 ---
    if (ext === 'tif' || ext === 'tiff' || ext === 'gtiff') {
      const rpc = await readRpcSidecar(group);
      const r = await window.LELayers.addGeoTiff(le, {
        file: file,
        name: name,
        rpc: rpc,
      });
      // 栅格也做一次坐标范围自检，方便在自检面板里看出位置对不对。
      // RPC 影像的覆盖范围由 addRpcRaster 解算出来，直接拿来用。
      const range = rasterRange(r);
      return {
        ok: true, name: name, count: 1, kind: 'raster', warnings: [],
        entry: r, range: range,
        crsInfo: rpc
          ? { source: 'RPC（旁挂 .rpb）', wkt: null, epsg: null, applied: false }
          : null,
      };
    }
    if (ext === 'asc' || ext === 'hdr') {
      return buildAsciiGridLayer(le, file, name, group);
    }

    // --- 矢量 ---
    const sidecars = group.sidecars;
    const prjText = sidecars.has('prj') ? await readTextFile(sidecars.get('prj')) : null;
    // .cpg 里写的是属性表的字符编码（UTF-8 / GBK…）。没有它时，
    // 解析器只能靠"有没有高位字节"猜，中文 UTF-8 的 DBF 会被误判成 GBK。
    const cpgText = sidecars.has('cpg') ? await readTextFile(sidecars.get('cpg')) : null;
    const parsed = await window.LEFormats.parse(file.name, file, {
      dbf: sidecars.get('dbf') || null,
      prj: prjText,
      cpg: cpgText,
      kind: group.kind,
    });

    if (!parsed.features.length) {
      const why = (parsed.warnings && parsed.warnings.length) ? parsed.warnings.join('；') : '没有解析出任何要素';
      throw new Error(why);
    }

    // GPX / DXF 这类格式本身不带坐标系，但旁边的 .prj 可能有。
    // 解析器默认按经纬度处理，若坐标明显超出经纬度范围而 .prj 又存在，
    // 就以 .prj 为准（国内很多 GIS 软件导出的 GPX 其实是投影坐标）。
    if (prjText && parsed.crs === 'EPSG:4326' && looksProjected(parsed.features)) {
      parsed.crs = prjText;
      parsed.warnings = (parsed.warnings || []).concat(
        ['GPX/DXF 的坐标看起来是投影坐标，已按配套的 .prj 文件重投影']
      );
    }

    // 文件里没有任何坐标系信息，而坐标又明显是投影坐标（米）——
    // 这种数据导进来是「看不见用不了」的：图形会飞到几内亚湾。
    // 与其默默画错，不如直接报错并告诉用户补什么文件。
    if (!parsed.crs && looksProjected(parsed.features)) {
      throw new Error(
        '文件里没有坐标系信息，但坐标是投影坐标（米），无法确定位置。' +
        '请把同名的 .prj 文件（QGIS 导出图层即可生成）一起拖进来。'
      );
    }

    const rp = reproject(parsed);
    const warnings = (parsed.warnings || []).concat(rp.warnings || []);

    const entities = featuresToEntities(le, rp.features, {
      idPrefix: name.replace(/[^\w一-龥-]/g, '_'),
    });

    if (!entities.length) throw new Error('解析出要素但无法生成图形');

    const fields = parsed.fields && parsed.fields.length
      ? parsed.fields
      : window.LEFormats.fieldsOf(rp.features);

    const entry = await addEntitiesAsLayer(le, entities, {
      name: name,
      fields: fields,
      crsInfo: rp.crsInfo,
      attributes: rp.features.map((f) => f.properties || {}),
    });

    // 坐标范围自检：看要素是不是落在合理的经纬度范围内
    let range = null;
    if (window.LEImportReport && typeof window.LEImportReport.checkRange === 'function') {
      range = window.LEImportReport.checkRange(rp.features);
      if (!range.ok) {
        warnings.push(
          '要素坐标超出经纬度范围（' + range.text + '），可能没有按 .prj 重投影成功'
        );
      }
    }

    return {
      ok: true,
      name: name,
      count: entities.length,
      kind: 'vector',
      warnings: warnings,
      crsInfo: rp.crsInfo,
      range: range,
      entry: entry,
    };
  }

  /**
   * 三维模型 → 模型图层。
   * OBJ / STL 在浏览器里转成 glTF，再交给 Cesium 渲染；全程离线。
   */
  async function buildModelLayer(le, file, name) {
    if (!window.LEModels) throw new Error('三维模型模块未就绪');
    const res = await window.LEModels.importFiles([file], le);
    if (res.failed && res.failed.length) throw new Error(res.failed[0]);
    const entry = window.LEModels.listModels().slice(-1)[0];
    return {
      ok: true,
      name: name,
      count: 1,
      kind: 'model3d',
      warnings: [],
      crsInfo: null,
      entry: entry,
    };
  }

  /** KML/KMZ：优先原生渲染器。 */
  async function buildKmlLayer(le, file, name) {
    if (window.LEKml && typeof window.LEKml.load === 'function') {
      try {
        const native = await window.LEKml.load(file, le);
        if (native && native.layer) {
          return {
            ok: true, name: name, count: native.count, kind: 'vector',
            warnings: native.warnings || [], native: true, entry: native.layer,
          };
        }
      } catch (err) {
        console.warn('[LEImportPipeline] 原生 KML 渲染失败，回退 Cesium：', err);
      }
    }
    // 回退：Cesium KmlDataSource
    const objectUrl = URL.createObjectURL(file);
    let ds;
    try {
      ds = await C.KmlDataSource.load(objectUrl, {
        clampToGround: true,
        camera: le.viewer.scene.camera,
        canvas: le.viewer.scene.canvas,
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    ds.name = name;
    await le.viewer.dataSources.add(ds);
    const entry = le.registerLayer({
      name: name,
      type: 'vector',
      datasource: ds,
      remove: () => le.viewer.dataSources.remove(ds, true),
      zoomTo: () => le.viewer.flyTo(ds, { duration: 1.4 }).catch(() => {}),
    });
    return {
      ok: true, name: name, count: ds.entities.values.length,
      kind: 'vector', warnings: ['使用了兼容模式渲染（性能较低）'], entry: entry,
    };
  }

  /** ASCII Grid → 栅格影像层。 */
  async function buildAsciiGridLayer(le, file, name, group) {
    const text = await readTextFile(file);
    const grid = window.LEFormats.parseAsciiGrid(text);
    if (!grid || !grid.values.length) throw new Error('ASCII Grid 没有像元值');

    const ncols = grid.ncols;
    const nrows = grid.nrows;
    const cell = grid.cellsize;
    const x0 = grid.xllcorner;
    const y0 = grid.yllcorner;
    if (!(cell > 0) || !(x0 != null) || !(y0 != null)) {
      throw new Error('ASCII Grid 缺少 cellsize / xllcorner / yllcorner');
    }

    // 画到 canvas
    const canvas = document.createElement('canvas');
    canvas.width = ncols;
    canvas.height = nrows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(ncols, nrows);

    const nodata = grid.nodata != null ? grid.nodata : -9999;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const v of grid.values) {
      if (v === nodata) continue;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    const span = vmax - vmin || 1;
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const v = grid.values[r * ncols + c];
        const o = (r * ncols + c) * 4;
        if (v === nodata || v == null) {
          img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 0;
          continue;
        }
        const t = Math.max(0, Math.min(1, (v - vmin) / span));
        // 简单色带（青→黄）
        img.data[o] = Math.round(40 + t * 215);
        img.data[o + 1] = Math.round(210 - t * 60);
        img.data[o + 2] = Math.round(180 - t * 100);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const url = canvas.toDataURL('image/png');
    let west = x0;
    let south = y0;
    let east = x0 + ncols * cell;
    let north = y0 + nrows * cell;

    // ASCII Grid 的坐标是**投影坐标**（米），不是经纬度。
    // 国产 DEM 基本都是 CGCS2000 高斯-克吕格 / UTM，
    // 不转的话整幅图会落到几内亚湾附近 —— 跟矢量一个毛病。
    // 坐标系从同名 .prj 文件读，或从 .asc 旁边的 .prj 读。
    const prjText = await readPrjSidecar(group);
    const warnings = [];
    let crsInfo = null;
    if (prjText) {
      const crs = window.LEProj.parse(prjText);
      if (crs.ok && !crs.geographic) {
        const sw = window.LEProj.toWgs84(crs, west, south);
        const se = window.LEProj.toWgs84(crs, east, south);
        const nw = window.LEProj.toWgs84(crs, west, north);
        if (sw && se && nw) {
          west = Math.min(sw[0], se[0], nw[0]);
          east = Math.max(sw[0], se[0], nw[0]);
          south = Math.min(sw[1], se[1], nw[1]);
          north = Math.max(sw[1], se[1], nw[1]);
          crsInfo = { source: crs.name, wkt: prjText, epsg: crs.code || null, applied: true };
        }
      } else if (crs.ok) {
        crsInfo = { source: crs.name, wkt: prjText, epsg: crs.code || null, applied: false };
      } else {
        warnings.push('ASCII Grid 的坐标系无法识别：' + crs.error);
      }
    } else {
      warnings.push('没有找到配套的 .prj 文件，已按经纬度放置（位置可能不正确）');
    }

    const entry = await window.LELayers.addImageOverlay(le, {
      url: url,
      rectangle: [west, south, east, north],
      name: name,
      opacity: 0.85,
    });
    if (entry) {
      entry.crs = crsInfo ? crsInfo.source : null;
      entry.crsWkt = crsInfo ? crsInfo.wkt : null;
      entry.crsEpsg = crsInfo ? crsInfo.epsg : null;
      entry.reprojected = crsInfo ? crsInfo.applied : false;
    }

    return {
      ok: true, name: name, count: ncols * nrows, kind: 'raster',
      warnings: warnings, entry: entry, crsInfo: crsInfo,
      // 栅格也做一次坐标范围自检，方便在自检面板里看出位置对不对
      range: { ok: true, text: '经度 ' + fmtDeg(west) + ' ~ ' + fmtDeg(east) +
        ' · 纬度 ' + fmtDeg(south) + ' ~ ' + fmtDeg(north) },
      stats: { min: vmin, max: vmax },
    };
  }

  /** 去掉小数末尾多余的 0。 */
  function fmtDeg(v) {
    if (v == null || !isFinite(v)) return '?';
    return Number(v.toFixed(4)).toString();
  }

  /**
   * 从栅格图层条目里取出经纬度范围，用于自检面板。
   *
   * 普通 GeoTIFF 的 bbox 在 addPlainRaster 里用掉了，这里改从图层上
   * 已经建好的 imageryProvider.rectangle 反查 —— 那是最终真正贴到地球上的范围。
   */
  function rasterRange(entry) {
    if (!entry) return null;
    const provider = entry.imageryLayer && entry.imageryLayer.imageryProvider;
    const rr = provider && provider.rectangle;
    if (!rr) return null;
    const west = rr.west * 180 / Math.PI;
    const south = rr.south * 180 / Math.PI;
    const east = rr.east * 180 / Math.PI;
    const north = rr.north * 180 / Math.PI;
    if (![west, south, east, north].every((v) => isFinite(v))) return null;
    const ok = Math.abs(west) <= 180.5 && Math.abs(east) <= 180.5 &&
      Math.abs(south) <= 90.5 && Math.abs(north) <= 90.5;
    return {
      ok: ok,
      text: '经度 ' + fmtDeg(west) + ' ~ ' + fmtDeg(east) +
        ' · 纬度 ' + fmtDeg(south) + ' ~ ' + fmtDeg(north),
    };
  }

  /** 找同名 .prj（ASCII Grid 的坐标系靠它）。 */
  async function readPrjSidecar(group) {
    if (!group || !group.sidecars) return null;
    const f = group.sidecars.get('prj');
    if (!f) return null;
    try {
      return await readTextFile(f);
    } catch (e) {
      return null;
    }
  }

  /** 读文件为文本。 */
  async function readTextFile(file) {
    if (typeof file.text === 'function') return file.text();
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('文件读取失败'));
        r.readAsText(file, 'utf-8');
      });
    }
    return String(file);
  }

  /**
   * 读取 RPC 定位旁挂文件（.rpb）并解析。
   * 高分二号等国产卫星的 L1A 影像没有仿射变换，位置全靠这个文件。
   * @returns {Promise<object|null>}
   */
  async function readRpcSidecar(group) {
    if (!group || !group.sidecars) return null;
    const f = group.sidecars.get('rpb');
    if (!f) return null;
    if (!window.LERpc) return null;
    try {
      const text = await readTextFile(f);
      return window.LERpc.parse(text);
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 主入口
   * ------------------------------------------------------------------ */

  /**
   * 导入一批文件。
   * @returns {Promise<{ ok: Array, failed: Array, warnings: Array }>}
   */
  async function importFiles(files, le) {
    le = le || window.LE;
    const groups = groupFiles(files);
    const ok = [];
    const failed = [];
    const warnings = [];
    const rows = [];

    // 失败项统一带上「补救办法」，自检面板直接显示，不用用户猜。
    const pushFail = (name, reason, group) => {
      const adv = (window.LEImportReport && typeof window.LEImportReport.advise === 'function')
        ? window.LEImportReport.advise(name, reason, group)
        : null;
      failed.push({ name: name, reason: reason, advice: adv });
    };

    for (const g of groups) {
      if (!g.primary) {
        // 只有配套文件：单独列出（.prj / .dbf 之类）
        let reason;
        if (g.sidecars.has('prj') && g.sidecars.size === 1) {
          reason = '只有 .prj 坐标系文件，没有数据';
        } else {
          reason = g.incompleteReason || '缺少主文件';
        }
        pushFail(g.name, reason, g);
        continue;
      }
      try {
        const r = await buildLayer(le, g);
        let msg = g.name + '（' + r.count + (r.kind === 'raster' ? ' 个像元' : ' 个要素');
        if (r.crsInfo && r.crsInfo.applied) msg += ' · 已从「' + r.crsInfo.source + '」重投影';
        else if (r.crsInfo && r.crsInfo.source) msg += ' · ' + r.crsInfo.source;
        if (r.native) msg += ' · 原生渲染';
        msg += '）';
        ok.push(msg);
        if (r.warnings && r.warnings.length) {
          warnings.push(g.name + '：' + r.warnings.join('；'));
        }
        rows.push({
          name: g.name,
          format: (window.LEImportReport && window.LEImportReport.formatLabel(g.kind)) || g.kind,
          count: r.count,
          crs: r.crsInfo ? (r.crsInfo.source || null) : null,
          crsWkt: r.crsInfo ? (r.crsInfo.wkt || null) : null,
          epsg: r.crsInfo ? (r.crsInfo.epsg || null) : null,
          reprojected: r.crsInfo ? !!r.crsInfo.applied : false,
          range: r.range || null,
        });
      } catch (err) {
        // 用 warn 而不是 error：导入失败是**用户数据的问题**，不是程序错误，
        // 已经在提示条和「导入自检」面板里说明了，不该刷红色报错。
        console.warn('[LEImportPipeline] ' + g.name + ' 导入失败：', err && err.message ? err.message : err);
        pushFail(g.name, err && err.message ? err.message : String(err), g);
      }
    }

    if (ok.length) {
      le.toast('已加载 ' + ok.length + ' 个数据集：' + ok.join('；'), 'ok', 5200);
      le.status('已加载 ' + ok.length + ' 个图层');
    }
    if (failed.length) {
      const names = failed.map((f) => f.name).join('、');
      le.toast('加载失败 ' + failed.length + ' 个：' + names + '（详见导入自检）', 'error', 8000);
      le.status('有 ' + failed.length + ' 个文件加载失败', 'error');
    }
    if (warnings.length) {
      console.warn('[LEImportPipeline] 提示：', warnings);
    }
    if (window.LETools && typeof window.LETools.rebuildSearchIndex === 'function') {
      window.LETools.rebuildSearchIndex();
    }

    // 导入自检面板：把成功、失败、提示摊开给用户看
    if (window.LEImportReport && typeof window.LEImportReport.record === 'function') {
      window.LEImportReport.record(
        { ok: ok, failed: failed, warnings: warnings },
        { rows: rows }
      );
    }

    return {
      ok: ok,
      failed: failed.map((f) => f.name + '：' + f.reason),
      warnings: warnings,
      rows: rows,
    };
  }

  window.LEImportPipeline = {
    importFiles: importFiles,
    groupFiles: groupFiles,
    buildLayer: buildLayer,
    reproject: reproject,
    featuresToEntities: featuresToEntities,
    baseNameOf: baseNameOf,
  };
})();

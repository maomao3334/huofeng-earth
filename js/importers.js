/*
 * 本地数据导入（Lead 版基础实现，importers-dev 在此扩展）
 *
 * 支持格式与解析细节见 js/import-pipeline.js 与 js/vector-formats.js：
 *   矢量  Shapefile / GPKG / GeoJSON / JSON / CSV / GML / GPX / DXF / WKT / KML / KMZ
 *   栅格  GeoTIFF / ASCII Grid
 *
 * 导入走 window.LEImportPipeline（统一管线：配套文件归组 → 解析 → 重投影 → 建图层）。
 * 本文件保留：
 *   - URL 导入（?demo= / 公共数据）
 *   - GeoJSON URL 导入（分析引擎的矢量产出走这条）
 *   - 拖拽 / 文件选择框 / 文件夹 的入口
 *   - Cesium 数据源的 RHUMB→GEODESIC 修复
 *
 * 要求：只读本地文件，不发起网络请求。
 */
(function () {
  'use strict';

  const C = window.Cesium;

  function extOf(name) {
    const m = /\.([^.]+)$/.exec(String(name || '').toLowerCase());
    return m ? m[1] : '';
  }

  /**
   * 文件类型判定（对外暴露的兼容接口）。
   * 现在由 js/vector-formats.js 的探测逻辑接管，能识别 magic number。
   */
  function fileKind(file) {
    const ext = extOf(file && file.name);
    if (ext === 'kml' || ext === 'kmz') return 'vector';
    if (ext === 'tif' || ext === 'tiff' || ext === 'gtiff') return 'raster';
    if (!window.LEFormats) return 'unknown';
    const kind = window.LEFormats.detect(file && file.name, null);
    if (kind === 'shapefile' || kind === 'gpkg' || kind === 'geojson' || kind === 'csv' ||
      kind === 'gml' || kind === 'gpx' || kind === 'dxf' || kind === 'wkt') {
      return 'vector';
    }
    if (kind === 'ascii-grid') return 'raster';
    if (kind === 'dbf' || kind === 'prj') return 'sidecar';
    return 'unknown';
  }


  /** 贴地时的最小抬升（米），防 z-fighting。 */
  const DRAPE_LIFT = 2;

  /**
   * 地面高度采样器。
   *
   * mode='mesh'：优先读**已渲染的地形网格**（LEDraping.groundHeightAt），
   *   与用户看到的起伏面完全一致；网格未就绪时由 LEDraping 内部回退到解析 DEM。
   * mode='analytic'：直接读解析 DEM（LE.heightAt），最快（0.6 µs/次），
   *   用于顶点数很大的层（10m 国界 54 万顶点）做重贴地。
   *
   * 地形关闭时一律返回 0（画在海平面），与椭球地形一致。
   */
  function terrainEnabled() {
    try {
      if (window.LETerrain && typeof window.LETerrain.isEnabled === 'function') {
        return !!window.LETerrain.isEnabled();
      }
    } catch (err) {
      /* ignore */
    }
    return false;
  }

  function analyticGroundHeight(lon, lat) {
    if (!terrainEnabled()) return 0;
    try {
      if (window.LE && typeof window.LE.heightAt === 'function') {
        const h = window.LE.heightAt(lon, lat);
        return isFinite(h) ? h : 0;
      }
    } catch (err) {
      /* ignore */
    }
    return 0;
  }

  function makeGroundSampler(mode) {
    if (mode === 'analytic') return analyticGroundHeight;
    const draping = window.LEDraping;
    if (draping && typeof draping.groundHeightAt === 'function') {
      return function (lon, lat) {
        try {
          const h = draping.groundHeightAt(lon, lat);
          if (isFinite(h)) return h;
        } catch (err) {
          /* ignore */
        }
        return analyticGroundHeight(lon, lat);
      };
    }
    return analyticGroundHeight;
  }

  /** 按地面高度把经纬度点抬高，得到贴地的 3D 折线坐标（不依赖 GroundPolyline，避免不渲染）。 */
  function drapePositions(positions) {
    return drapePositionsWith(makeGroundSampler('mesh'), positions);
  }

  function drapePositionsWith(sampler, positions) {
    const out = [];
    if (!positions) return out;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const c = C.Cartographic.fromCartesian(p);
      if (!c || !isFinite(c.longitude) || !isFinite(c.latitude)) continue;
      let h = 0;
      try {
        h = sampler(C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)) || 0;
      } catch (err) {
        h = 0;
      }
      out.push(C.Cartesian3.fromRadians(c.longitude, c.latitude, h + DRAPE_LIFT));
    }
    return out;
  }

  /**
   * 已贴地图元的登记表。
   *
   * 为什么要登记：地形是**流式加载**的 —— 启动时只有少数瓦片就绪，
   * 此时贴地算出来的高度会偏低（甚至为 0）。等瓦片加载完必须重算，
   * 否则线会沉在地形里。登记表让「重贴地」可以精确找到要改的实体，
   * 而不是重新加载整个 GeoJSON。
   *
   * 每条记录带一个 redrape 策略：
   *   'settle'  —— 地形瓦片就绪后重算（用渲染网格采样，最贴合用户看到的面）
   *   'rebuild' —— 地形 Provider 重建（夸张系数变化）后重算（用解析 DEM 采样）
   * 顶点数巨大的层（10m 国界 54 万顶点）不适合每次瓦片就绪都重算，
   * 所以它只登记 'rebuild'；顶点数小的层（110m 国界几千顶点）用 'settle'。
   */
  const drapedRegistry = [];

  /** 数据源是否已被销毁（Cesium remove 时会置 _destroyed）。 */
  function dsAlive(ds) {
    if (!ds) return false;
    if (ds._destroyed) return false;
    try {
      return !!ds.entities;
    } catch (err) {
      return false;
    }
  }

  /**
   * 把数据源里所有多边形的轮廓转成**贴地折线**。
   *
   * 【为什么 polygon 必须转成 polyline】
   *   Cesium 的 polygon 实体在 clampToGround:false 时画在高度 0（海平面）。
   *   在西藏边境（地面 3819 m）上，这个高度差在相机高 6000 m / 俯角 −30°
   *   时对应约 **196 px** 的屏幕视差 —— 线在正确的经纬度上，却落在山谷里。
   *   把顶点抬高到地形高度后，两者对齐到 0.01 px。
   *
   * @param {Cesium.DataSource} dataSource
   * @param {object} opts {color, width, sampler:'analytic'|'mesh', redrape:'settle'|'rebuild'}
   * @returns {number} 新建的折线实体数
   */
  function drapeDataSourceToTerrain(dataSource, opts) {
    opts = opts || {};
    if (!dataSource || !dataSource.entities) return 0;
    const now = C.JulianDate.now();
    const sampler = makeGroundSampler(opts.sampler || 'analytic');
    const stroke =
      opts.color || C.Color.fromCssColorString('#7fb2e5').withAlpha(0.9);
    const width = opts.width != null ? opts.width : 1.4;
    const ents = dataSource.entities.values;
    let created = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e || !e.polygon) continue;
      if (e.__leDrapped) continue; // 已经转过，避免重复
      let hierarchy = null;
      try {
        hierarchy = e.polygon.hierarchy && e.polygon.hierarchy.getValue
          ? e.polygon.hierarchy.getValue(now)
          : e.polygon.hierarchy;
      } catch (err) {
        hierarchy = null;
      }
      if (!hierarchy || !hierarchy.positions) continue;
      const rings = [hierarchy.positions];
      if (hierarchy.holes) {
        for (let h = 0; h < hierarchy.holes.length; h++) {
          if (hierarchy.holes[h] && hierarchy.holes[h].positions) {
            rings.push(hierarchy.holes[h].positions);
          }
        }
      }
      const entries = [];
      for (let r = 0; r < rings.length; r++) {
        const ring = rings[r];
        if (!ring || ring.length < 2) continue;
        const pts = drapePositionsWith(sampler, ring);
        if (pts.length < 2) continue;
        const line = dataSource.entities.add({
          polyline: {
            positions: pts,
            width: width,
            material: stroke,
            clampToGround: false,
            arcType: C.ArcType.NONE,
          },
        });
        entries.push({ line: line, ring: ring });
        created++;
      }
      if (!entries.length) continue;
      // 原多边形隐藏：它画在海平面，留着就会看到两条位置不同的线
      e.show = false;
      e.__leDrapped = true;
      drapedRegistry.push({
        ds: dataSource,
        owner: e,
        entries: entries,
        sampler: opts.sampler || 'analytic',
        redrape: opts.redrape || 'rebuild',
        probes: buildProbes(entries),
      });
    }
    return created;
  }

  /**
   * 从已贴地的折线里挑几个**探针顶点**（记录当时烘进去的高度）。
   *
   * 用途：地形数据是**异步流式加载**的 —— 贴地时 DEM 还没到，高度全是 0；
   * 几秒后 DEM 到位，正确高度才出现。逐顶点比对（54 万顶点）太贵，
   * 所以只拿 8 个探针做「有没有变」的判断，变了才整体重算。
   */
  function buildProbes(entries) {
    const probes = [];
    const MAX = 8;
    for (let i = 0; i < entries.length && probes.length < MAX; i++) {
      const ring = entries[i].ring;
      if (!ring || !ring.length) continue;
      const step = Math.max(1, Math.floor(ring.length / MAX));
      for (let j = 0; j < ring.length && probes.length < MAX; j += step) {
        const c = C.Cartographic.fromCartesian(ring[j]);
        if (!c) continue;
        const lon = C.Math.toDegrees(c.longitude);
        const lat = C.Math.toDegrees(c.latitude);
        // 烘进去的高度 = 采样高度 + DRAPE_LIFT；反推采样高度
        const baked = drapePositionsWith(
          makeGroundSampler('analytic'),
          [ring[j]]
        )[0];
        const h = baked ? C.Cartographic.fromCartesian(baked).height : 0;
        probes.push({ lon: lon, lat: lat, h: h - DRAPE_LIFT });
      }
    }
    return probes;
  }

  /**
   * 轻量巡检：检查探针高度是否与当前地形不一致，变了就重算对应记录。
   *
   * 用法：地形数据流式加载期间每隔 1~2 s 调一次。
   * @returns {number} 被重算的记录数
   */
  function tickDrapedDataSources(threshold) {
    const eps = threshold != null ? threshold : 1; // 米
    const sampler = makeGroundSampler('analytic');
    let changed = 0;
    for (let i = drapedRegistry.length - 1; i >= 0; i--) {
      const rec = drapedRegistry[i];
      if (!dsAlive(rec.ds)) {
        drapedRegistry.splice(i, 1);
        continue;
      }
      if (!rec.probes || !rec.probes.length) continue;
      let dirty = false;
      for (let j = 0; j < rec.probes.length; j++) {
        const pr = rec.probes[j];
        const cur = sampler(pr.lon, pr.lat);
        if (Math.abs(cur - pr.h) > eps) { dirty = true; break; }
      }
      if (!dirty) continue;
      for (let j = 0; j < rec.entries.length; j++) {
        const entry = rec.entries[j];
        try {
          const pts = drapePositionsWith(sampler, entry.ring);
          if (pts.length < 2) continue;
          entry.line.polyline.positions = pts;
          entry.line.polyline.clampToGround = false;
          entry.line.polyline.arcType = C.ArcType.NONE;
        } catch (err) {
          /* ignore */
        }
      }
      rec.probes = buildProbes(rec.entries);
      changed++;
    }
    return changed;
  }

  /**
   * 重算登记表中符合条件的贴地图元高度。
   * @param {string} policy  'settle'（瓦片就绪）或 'rebuild'（Provider 重建）
   * @param {string} [samplerMode] 强制采样方式；缺省用各记录登记时的方式
   * @returns {number} 重算的折线数
   */
  function redrapeDrapedDataSources(policy, samplerMode) {
    let n = 0;
    for (let i = drapedRegistry.length - 1; i >= 0; i--) {
      const rec = drapedRegistry[i];
      if (!dsAlive(rec.ds)) {
        drapedRegistry.splice(i, 1);
        continue;
      }
      if (policy && rec.redrape !== policy) continue;
      const sampler = makeGroundSampler(samplerMode || rec.sampler);
      for (let j = 0; j < rec.entries.length; j++) {
        const entry = rec.entries[j];
        try {
          const pts = drapePositionsWith(sampler, entry.ring);
          if (pts.length < 2) continue;
          entry.line.polyline.positions = pts;
          entry.line.polyline.clampToGround = false;
          entry.line.polyline.arcType = C.ArcType.NONE;
          n++;
        } catch (err) {
          /* ignore */
        }
      }
    }
    return n;
  }

  /** 公共矢量后处理：国界只留描边、湖泊淡蓝填充（GeoJsonDataSource 的 fill 选项不一定生效）。 */
  function stylePublicVectorDataSource(dataSource, lower) {
    if (!dataSource || !dataSource.entities) return;
    const now = C.JulianDate.now();
    const ents = dataSource.entities.values;
    const isAdmin = /admin_0/.test(lower);
    const isLakes = /lakes/.test(lower);
    if (isAdmin) {
      // 国界：多边形画在海平面 → 转成贴地折线（并登记，便于地形变化后重贴地）。
      // 用 analytic 采样而不是渲染网格：导入时地形瓦片大多还没加载完，
      // 网格采样会得到 0 或偏低的高度，把线画到山体下面。
      // redrape:'rebuild' —— 54 万顶点，不能每次瓦片就绪都重算。
      drapeDataSourceToTerrain(dataSource, {
        color: C.Color.fromCssColorString('#86b7e8').withAlpha(0.95),
        width: 1.6,
        sampler: 'analytic',
        redrape: 'rebuild',
      });
    }
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.polygon) {
        try {
          if (isLakes) {
            e.polygon.material = C.Color.fromCssColorString('#2f6f9f').withAlpha(0.35);
            e.polygon.outline = true;
            e.polygon.outlineColor = C.Color.fromCssColorString('#5fa8d8').withAlpha(0.9);
            e.polygon.outlineWidth = 1.0;
          }
        } catch (err) {
          /* ignore */
        }
      }
      if (!isAdmin && !isLakes && e.polyline) {
        try {
          const raw = e.polyline.positions && e.polyline.positions.getValue ? e.polyline.positions.getValue(now) : e.polyline.positions;
          const draped = drapePositions(raw);
          if (draped.length >= 2) {
            e.polyline.positions = draped;
            e.polyline.clampToGround = false;
            e.polyline.arcType = C.ArcType.NONE;
          }
        } catch (err) {
          /* ignore */
        }
      }
    }
    // 城市点：拉远时隐藏，避免几千个黄点铺满整屏（近景 ≤1200 km 才显示）
    if (/populated_places/.test(lower)) {
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        try {
          if (e.billboard) {
            e.billboard.distanceDisplayCondition = new C.DistanceDisplayCondition(0, 1200000);
          }
          if (e.label) {
            e.label.distanceDisplayCondition = new C.DistanceDisplayCondition(0, 1200000);
          }
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  function dataSourceOptions(le) {
    return {
      clampToGround: false,
      camera: le.viewer.scene.camera,
      canvas: le.viewer.scene.canvas,
    };
  }

  /**
   * 修复 Cesium GeoJsonDataSource 默认把折线建成 RHUMB（ArcType=2）导致的崩溃：
   * Natural Earth 河流等数据的极区/跨日期变更线段会让 subdivideRhumbLine 计算出
   * 非法数组长度，抛出 "RangeError: Invalid array length" 并停止整个渲染循环。
   * 这里统一改为 GEODESIC，并清理非法/重复坐标。
   */
  function sanitizePolylineDataSource(dataSource) {
    if (!dataSource || !dataSource.entities) return;
    const now = C.JulianDate.now();
    const ents = dataSource.entities.values;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      // 面（国界/湖泊）同样会被 GeoJsonDataSource 默认成 RHUMB（=2）；
      // Cesium 的 PolygonGeometry 会按边做 subdivideRhumbLine，大面会算出非法长度。
      if (e.polygon) {
        try {
          e.polygon.arcType = C.ArcType.GEODESIC;
        } catch (err) {
          /* ignore */
        }
      }
      if (!e.polyline) continue;
      try {
        e.polyline.arcType = C.ArcType.GEODESIC;
      } catch (err) {
        /* ignore */
      }
      try {
        const raw =
          e.polyline.positions && e.polyline.positions.getValue
            ? e.polyline.positions.getValue(now)
            : e.polyline.positions;
        if (!Array.isArray(raw) || raw.length < 2) continue;
        const cleaned = [];
        for (let j = 0; j < raw.length; j++) {
          const p = raw[j];
          if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) continue;
          if (cleaned.length) {
            const prev = cleaned[cleaned.length - 1];
            const dx = p.x - prev.x;
            const dy = p.y - prev.y;
            const dz = p.z - prev.z;
            if (dx * dx + dy * dy + dz * dz < 1e-6) continue;
          }
          cleaned.push(p);
        }
        if (cleaned.length >= 2) e.polyline.positions = cleaned;
      } catch (err) {
        /* ignore */
      }
    }
  }

  /** 从数据源的实体几何估算经纬度范围（不依赖 viewer.flyTo 对数据源的启发式）。 */
  function dataSourceBounds(dataSource) {
    const now = C.JulianDate.now();
    const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity, has: false };
    const addPosition = (position) => {
      if (!position || !(position instanceof C.Cartesian3)) return;
      const carto = C.Cartographic.fromCartesian(position);
      if (!carto) return;
      const lon = C.Math.toDegrees(carto.longitude);
      const lat = C.Math.toDegrees(carto.latitude);
      bounds.west = Math.min(bounds.west, lon);
      bounds.east = Math.max(bounds.east, lon);
      bounds.south = Math.min(bounds.south, lat);
      bounds.north = Math.max(bounds.north, lat);
      bounds.has = true;
    };
    const addPositions = (value) => {
      if (!value) return;
      const positions = Array.isArray(value) ? value : value.getValue ? value.getValue(now) : null;
      if (!positions) return;
      for (const p of positions) addPosition(p);
    };

    const entities = dataSource && dataSource.entities ? dataSource.entities.values : [];
    for (const entity of entities) {
      try {
        if (entity.position) addPositions([entity.position.getValue(now)]);
        if (entity.polyline && entity.polyline.positions) addPositions(entity.polyline.positions);
        if (entity.polygon && entity.polygon.hierarchy) {
          const hierarchy = entity.polygon.hierarchy.getValue(now);
          if (hierarchy && hierarchy.positions) addPositions(hierarchy.positions);
        }
        if (entity.rectangle && entity.rectangle.coordinates) {
          const rect = entity.rectangle.coordinates.getValue(now);
          if (rect) {
            addPosition(C.Cartesian3.fromRadians(rect.west, rect.south));
            addPosition(C.Cartesian3.fromRadians(rect.east, rect.north));
          }
        }
      } catch (_) {
        /* 单个实体几何不可用时继续 */
      }
    }
    return bounds.has ? bounds : null;
  }

  /**
   * 把相机飞到数据范围（带边距）；返回是否成功定位。
   *
   * 【为什么走飞前闸门 LEFlyGate】
   *   导入矢量文件后立刻 flyTo，会重现用户报的
   *   「那个地方没有渲染好就直接跳转」：
   *   刚导入完，主线程还在建几何，DEM/影像都还没就绪，
   *   相机已经飞过去 —— 落点只能看到底色和空洞。
   *   这里先让 LEFlyGate 把目标矩形准备好（并等主线程静默），再飞。
   *   闸门失败/超时也会照飞（闸门不抛错），所以这里不会卡住导入。
   */
  function fitDataSource(le, dataSource, duration) {
    const b = dataSourceBounds(dataSource);
    if (!b) return false;
    const padLon = Math.max((b.east - b.west) * 0.1, 0.0008);
    const padLat = Math.max((b.north - b.south) * 0.1, 0.0008);
    const west = Math.max(-179.999, b.west - padLon);
    const east = Math.min(179.999, b.east + padLon);
    const south = Math.max(-89.999, b.south - padLat);
    const north = Math.min(89.999, b.north + padLat);
    const rect = { west: west, south: south, east: east, north: north };
    const doFly = function () {
      le.viewer.camera.flyTo({
        destination: C.Rectangle.fromDegrees(west, south, east, north),
        duration: duration || 1.4,
      });
    };
    if (window.LEFlyGate && window.LEFlyGate.navigate) {
      window.LEFlyGate.navigate(rect,doFly,true).catch(err=>console.warn('[LEImports] 定位失败',err));
      return true;
    }
    if (window.LEFlyGate && typeof window.LEFlyGate.prepare === 'function') {
      try {
        window.LEFlyGate.prepare(rect, { timeoutMs: 6000 }).then(doFly).catch(doFly);
        return true;
      } catch (err) { /* 闸门不可用 → 直接飞 */ }
    }
    doFly();
    return true;
  }

  function countEntities(dataSource) {
    if (!dataSource || !dataSource.entities || !dataSource.entities.values) return 0;
    return dataSource.entities.values.length;
  }

  function boundsTextOf(b) {
    if (!b || !b.has) return ' · 无位置范围';
    return (
      ' · 范围 ' +
      b.west.toFixed(3) + ',' + b.south.toFixed(3) +
      ' → ' + b.east.toFixed(3) + ',' + b.north.toFixed(3)
    );
  }

  /**
   * 优先用自研 KML/KMZ 渲染器（js/kml-native.js）。
   * 返回 null 表示原生路径不可用或失败，调用方回退 Cesium.KmlDataSource。
   */
  async function tryNativeKml(input, le) {
    if (!window.LEKml || typeof window.LEKml.load !== 'function') return null;
    try {
      const result = await window.LEKml.load(input, le);
      if (!result || !result.layer) throw new Error('原生渲染器返回空图层');
      return result;
    } catch (err) {
      console.warn('[LEImports] 原生 KML/KMZ 渲染失败，回退 Cesium KmlDataSource：', err);
      if (le && typeof le.toast === 'function') {
        le.toast(
          '原生 KML 渲染失败，已切换兼容模式：' + (err && err.message ? err.message : err),
          'error',
          5200
        );
      }
      return null;
    }
  }

  async function importVector(file, le) {
    const ext = extOf(file.name);
    const isKml = ext === 'kml' || ext === 'kmz';

    // .kml/.kmz 先走原生渲染（CustomDataSource），失败再回退 Cesium KmlDataSource
    if (isKml) {
      const native = await tryNativeKml(file, le);
      if (native) {
        return {
          entry: native.layer,
          count: native.count,
          warnings: native.warnings || [],
          native: true,
        };
      }
    }

    let dataSource;
    let objectUrl = null;
    try {
      // Cesium 的 DataSource.load 接受 URL/Resource，不直接接受浏览器 File 对象。
      // 用 blob URL 把本地 File 交给 Cesium，加载完成后再释放。
      objectUrl = URL.createObjectURL(file);
      if (isKml) {
        dataSource = await C.KmlDataSource.load(objectUrl, dataSourceOptions(le));
      } else {
        dataSource = await C.GeoJsonDataSource.load(objectUrl, {
          clampToGround: false,
          markerSize: 24,
          strokeWidth: 2,
        });
      }
      sanitizePolylineDataSource(dataSource);
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
    dataSource.name = file.name;
    await le.viewer.dataSources.add(dataSource);
    const entry = le.registerLayer({
      name: file.name,
      type: 'vector',
      datasource: dataSource,
      remove: () => le.viewer.dataSources.remove(dataSource, true),
      zoomTo: () => {
        if (!fitDataSource(le, dataSource)) {
          le.viewer.flyTo(dataSource, { duration: 1.4 }).catch(() => {});
        }
      },
      flyTo: () => {
        if (!fitDataSource(le, dataSource)) {
          le.viewer.flyTo(dataSource, { duration: 1.4 }).catch(() => {});
        }
      },
    });
    if (!fitDataSource(le, dataSource)) {
      try {
        await le.viewer.flyTo(dataSource, { duration: 1.2 });
      } catch (_) {
        /* 空数据源时忽略 */
      }
    }
    if (window.LETools && typeof window.LETools.rebuildSearchIndex === 'function') {
      window.LETools.rebuildSearchIndex();
    }
    return { entry, count: countEntities(dataSource), warnings: [], native: false };
  }

  async function importRaster(file, le) {
    if (!window.LELayers || !window.LELayers.addGeoTiff) {
      throw new Error('GeoTIFF 支持未初始化');
    }
    return window.LELayers.addGeoTiff(le, { file, name: file.name });
  }

  async function importFiles(files, le) {
    le = le || window.LE;
    const list = Array.from(files || []);
    if (!list.length) return;
    if (typeof le.setStatus === 'function') le.setStatus('正在加载 ' + list.length + ' 个文件…');
    // 统一管线：配套文件归组 → 解析 → 重投影 → 建图层
    if (window.LEImportPipeline && typeof window.LEImportPipeline.importFiles === 'function') {
      return window.LEImportPipeline.importFiles(list, le);
    }
    // 管线不可用时的兜底（老路径）
    const ok = [];
    const failed = [];
    for (const file of list) {
      try {
        const kind = fileKind(file);
        if (kind === 'vector') {
          const result = await importVector(file, le);
          ok.push(
            file.name +
              '（' + result.count + ' 个地物' + (result.native ? '，原生渲染' : '') + '）'
          );
          if (result.warnings && result.warnings.length) {
            console.warn('[LEImports] ' + file.name + ' 解析提示：', result.warnings);
          }
        } else if (kind === 'raster') {
          await importRaster(file, le);
          ok.push(file.name);
        } else {
          failed.push(file.name + '（不支持的类型）');
        }
      } catch (err) {
        console.error(err);
        failed.push(file.name + '：' + (err && err.message ? err.message : err));
      }
    }
    // 非阻塞：进度只走状态栏（加载浮层由 main.js 在首屏后关闭）
    if (ok.length) {
      le.toast('已加载：' + ok.join('；'), 'ok', 4200);
      le.status('已加载 ' + ok.length + ' 个图层');
    }
    if (failed.length) {
      le.toast('加载失败：' + failed.join('；'), 'error', 7000);
      le.status('有 ' + failed.length + ' 个文件加载失败', 'error');
    }
  }

  function setupDropZone(le) {
    const overlay = document.getElementById('drop-overlay');
    let depth = 0;
    const hasFiles = (ev) =>
      ev.dataTransfer &&
      Array.from(ev.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth++;
      if (depth === 1) overlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.classList.add('hidden');
    });
    window.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      overlay.classList.add('hidden');
      const files = ev.dataTransfer.files;
      if (files && files.length) importFiles(files, le);
    });
  }

  /** 通过本地相对 URL 加载矢量数据（用于 ?demo= 演示参数）。 */
  async function importUrl(url, le) {
    le = le || window.LE;
    const lower = String(url).toLowerCase();
    if (typeof le.setStatus === 'function') le.setStatus('正在加载 ' + url + ' …');
    try {
      // .kml/.kmz 优先走原生渲染器，失败再回退 Cesium KmlDataSource
      if (/\.kml$|\.kmz$/.test(lower)) {
        const native = await tryNativeKml(url, le);
        if (native) {
          const name = native.layer.name;
          const warnings = native.warnings || [];
          le.toast('已加载：' + name + '（' + native.count + ' 个地物 · 原生渲染）', 'ok', 4200);
          le.status(
            '已加载 ' + name + ' · ' + native.count + ' 个地物' +
            boundsTextOf(native.bounds) +
            ' · 原生 KML 渲染' +
            (warnings.length ? ' · ' + warnings.length + ' 条提示' : '')
          );
          return native.dataSource;
        }
      }

      let dataSource;
      if (/\.kml$|\.kmz$/.test(lower)) {
        dataSource = await C.KmlDataSource.load(url, dataSourceOptions(le));
        sanitizePolylineDataSource(dataSource);
      } else if (/\.geojson$|\.json$/.test(lower)) {
        // 公共 Natural Earth 矢量：默认贴地渲染（clampToGround），国界只描边、湖泊淡蓝填充，
        // 避免高度 0 的面被 3D 地形遮成蓝色块；?drape=0 可关闭。
        const isPublicVector = /data\/public\/vectors\//.test(url) || /ne_10m_(admin_0|rivers|lakes|populated_places)/.test(lower);
        const drape = isPublicVector && new URLSearchParams(location.search).get('drape') !== '0';
        const geoOptions = { clampToGround: drape, markerSize: 24, strokeWidth: 2 };
        if (isPublicVector) {
          if (/admin_0/.test(lower)) {
            geoOptions.stroke = C.Color.fromCssColorString('#86b7e8').withAlpha(0.9);
            geoOptions.strokeWidth = 1.2;
            geoOptions.fill = false;
          } else if (/rivers/.test(lower)) {
            geoOptions.stroke = C.Color.fromCssColorString('#4f9fd8').withAlpha(0.95);
            geoOptions.strokeWidth = 1.3;
          } else if (/lakes/.test(lower)) {
            geoOptions.fill = C.Color.fromCssColorString('#2f6f9f').withAlpha(0.35);
            geoOptions.stroke = C.Color.fromCssColorString('#5fa8d8').withAlpha(0.9);
            geoOptions.strokeWidth = 1.0;
          } else if (/populated_places/.test(lower)) {
            geoOptions.markerColor = C.Color.fromCssColorString('#ffd166').withAlpha(0.9);
            geoOptions.markerSize = 6;
          }
        }
        dataSource = await C.GeoJsonDataSource.load(url, geoOptions);
        sanitizePolylineDataSource(dataSource);
        if (isPublicVector) stylePublicVectorDataSource(dataSource, lower);
      } else {
        throw new Error('不支持的 URL 类型（仅 .kml/.kmz/.geojson/.json）');
      }
      dataSource.name = String(url).split('/').pop();
      await le.viewer.dataSources.add(dataSource);
      le.registerLayer({
        name: dataSource.name,
        type: 'vector',
        datasource: dataSource,
        remove: () => le.viewer.dataSources.remove(dataSource, true),
        zoomTo: () => {
          if (!fitDataSource(le, dataSource)) {
            le.viewer.flyTo(dataSource, { duration: 1.2 }).catch(() => {});
          }
        },
      });
      // 不再在导入后自动把相机飞到数据范围（加载公共图层会跳回全球视角）；
      // 需要定位时用图层列表的“定位”按钮（zoomTo）或 ?fit=1。
      if (new URLSearchParams(location.search).get('fit') === '1') {
        if (!fitDataSource(le, dataSource)) {
          await le.viewer.flyTo(dataSource, { duration: 1.2 }).catch(() => {});
        }
      }
      if (window.LETools && typeof window.LETools.rebuildSearchIndex === 'function') {
        window.LETools.rebuildSearchIndex();
      }
      le.toast('已加载：' + dataSource.name + '（' + countEntities(dataSource) + ' 个地物）', 'ok');
      const b = dataSourceBounds(dataSource);
      le.status('已加载 ' + dataSource.name + ' · ' + countEntities(dataSource) + ' 个地物' + boundsTextOf(b));
      return dataSource;
    } finally {
      // 非阻塞：进度只走状态栏（加载浮层由 main.js 在首屏后关闭）
    }
  }

  /**
   * 载入本地服务器上的 GeoJSON（QGIS Processing 的矢量产出走这条通道）。
   * 与 importUrl 的区别：不跳转相机、不套用公共图层配色。
   */
  async function importGeoJsonUrl(le, url, name) {
    const dataSource = await C.GeoJsonDataSource.load(url, {
      clampToGround: true,
      markerSize: 20,
      strokeWidth: 2,
    });
    sanitizePolylineDataSource(dataSource);
    dataSource.name = name || String(url).split('/').pop();
    await le.viewer.dataSources.add(dataSource);
    const entry = le.registerLayer({
      name: dataSource.name,
      type: 'vector',
      datasource: dataSource,
      remove: () => le.viewer.dataSources.remove(dataSource, true),
      zoomTo: () => {
        if (!fitDataSource(le, dataSource)) {
          le.viewer.flyTo(dataSource, { duration: 1.2 }).catch(() => {});
        }
      },
      flyTo: () => {
        if (!fitDataSource(le, dataSource)) {
          le.viewer.flyTo(dataSource, { duration: 1.2 }).catch(() => {});
        }
      },
    });
    if (window.LETools && typeof window.LETools.rebuildSearchIndex === 'function') {
      window.LETools.rebuildSearchIndex();
    }
    return entry;
  }

  window.LEImports = {
    init(le) {
      this.le = le;
      setupDropZone(le);
    },
    importFiles(files, le) {
      return importFiles(files, le);
    },
    importUrl,
    importGeoJsonUrl,
    fitDataSource,
    dataSourceBounds,
    fileKind,
    /**
     * 把相机飞到数据范围（带边距）；返回是否成功定位。
     *
     * 【飞前闸门】与 kml-native.js 的 flyToBounds 一样：飞行前先用
     * window.LEFlyGate.prepare() 把目标矩形的 DEM/影像准备好，
     * 避免落点瞬间露底色（黑色多边形洞）。
     * 闸门不可用或失败时**直接飞**（保持旧行为，不卡住用户）。
     *
     * 【注】fitDataSource 现在也走闸门了，所以这个别名直接委托过去，
     *   避免两份一模一样的矩形计算逻辑各自漂移。
     */
    fitDataSourceGated(le, dataSource, duration) {
      return fitDataSource(le, dataSource, duration);
    },
    // 供 main.js 等外部加载的 GeoJSON/KML 数据源做 RHUMB→GEODESIC 修复，避免渲染崩溃
    sanitizeDataSource(dataSource) {
      sanitizePolylineDataSource(dataSource);
    },
    /**
     * 把一个**多边形**数据源的国界轮廓转成贴地折线（消除海平面视差偏移）。
     *
     * 【为什么需要】
     *   Cesium 的 polygon 实体在 clampToGround:false 时画在**高度 0**（海平面）。
     *   在西藏边境（地面 3819 m）上，这个高度差对应的屏幕视差约 **196 px**
     *   （相机高 6000 m / 俯角 −30°），用户看到的就是「国界线偏了」——
     *   线明明在正确的经纬度上，却落在山谷里、跑到山体下面。
     *   10m 层（ne_10m_admin_0）已经用这个办法转成贴地折线；110m 的
     *   「国界（Natural Earth）」层没有转换，于是两层同时显示、位置不一致。
     *
     * 【为什么不在导入时直接转】
     *   110m 层在 js/main.js 的 boot() 里于 **LETerrain.init() 之前**创建，
     *   那时还没有地形数据源，贴地高度全是 0。必须等地形就绪后再转。
     *
     * @param {Cesium.DataSource} dataSource 目标数据源
     * @param {object} opts {color, width, sampler:'mesh'|'analytic'}
     * @returns {number} 新建的折线数量
     */
    drapeDataSourceToTerrain(dataSource, opts) {
      return drapeDataSourceToTerrain(dataSource, opts);
    },
    /** 地形瓦片就绪 / 夸张系数变化后重算已登记的贴地图元。 */
    redrapeDrapedDataSources(policy, samplerMode) {
      return redrapeDrapedDataSources(policy, samplerMode);
    },
    /** 轻量巡检：探针高度与当前地形不一致时重算（用于 DEM 异步加载期）。 */
    tickDrapedDataSources(threshold) {
      return tickDrapedDataSources(threshold);
    },
    // 原生 KML/KMZ 渲染器可用时返回 true（js/kml-native.js 已加载）
    hasNativeKml() {
      return !!(window.LEKml && typeof window.LEKml.load === 'function');
    },
    // 直接调用原生加载器（调试/外部调用），失败返回 null
    loadNativeKml(input, le) {
      return tryNativeKml(input, le);
    },
  };
})();

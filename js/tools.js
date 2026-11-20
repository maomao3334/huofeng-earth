/*
 * 搜索与测量（Lead 版基础实现，tools-dev 在此扩展）
 * 对外 API：window.LETools
 *   init(le)
 *   startMeasure('distance' | 'area' | 'angle' | 'elevation')
 *   clearMeasure()
 *   search(query)
 *   gotoItem(item)
 *
 * 量算算法全部在 js/measure.js（window.LEMeasure）里，纯计算、可在 Node 里单测。
 * 这里只负责「取点 → 渲染 → 出结果面板」。
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const M = window.LEMeasure;

  const state = {
    le: null,
    mode: null,
    lastMode: null,
    heightRevision: 0,
    heightLoad: 'idle',
    positions: [],
    lastScreenClick: null,
    entities: [],
    clickHandler: null,
    panel: null,
    searchItems: [],
    activeIndex: -1,
    searchTimer: null,
    searchIndexedAt: 0,
    searchTruncated: false,
  };

  /* ------------------------------- 搜索 ------------------------------- */

  // 搜索索引的实体扫描上限：超大 KML（十万级 Entity）全量扫描会阻塞主线程
  // 数百毫秒到数秒，而搜索框只展示前 60 条 —— 没有必要扫完所有实体。
  const SEARCH_INDEX_MAX_ENTITIES = 20000;

  function buildSearchIndex(le) {
    const items = [];
    const seen = new Set();
    const push = (name, lon, lat, height, kind, entity) => {
      const key = name + '|' + lon.toFixed(3) + '|' + lat.toFixed(3);
      if (!name || seen.has(key)) return;
      seen.add(key);
      items.push({ name, lon, lat, height: height || 50000, kind: kind || '地标', entity });
    };

    const places = le.state.samples.places;
    if (places && places.entities) {
      for (const entity of places.entities.values) {
        if (!entity.position || !entity.name) continue;
        const carto = C.Cartographic.fromCartesian(entity.position.getValue(C.JulianDate.now()));
        if (!carto) continue;
        push(
          entity.name,
          C.Math.toDegrees(carto.longitude),
          C.Math.toDegrees(carto.latitude),
          Math.max(1000, carto.height || 0),
          '城市/地名',
          entity
        );
      }
    }

    le.dataSources = le.viewer.dataSources;
    let scanned = 0;
    let truncated = false;
    for (let i = 0; i < le.viewer.dataSources.length; i++) {
      const ds = le.viewer.dataSources.get(i);
      if (!ds || ds === places) continue;
      const entities = ds.entities && ds.entities.values ? ds.entities.values : [];
      for (const entity of entities) {
        if (scanned >= SEARCH_INDEX_MAX_ENTITIES) {
          truncated = true;
          break;
        }
        scanned++;
        if (!entity.position || !entity.name) continue;
        const carto = C.Cartographic.fromCartesian(entity.position.getValue(C.JulianDate.now()));
        if (!carto) continue;
        push(
          entity.name,
          C.Math.toDegrees(carto.longitude),
          C.Math.toDegrees(carto.latitude),
          Math.max(2000, carto.height || 0),
          ds.name || '已加载图层',
          entity
        );
      }
      if (truncated) break;
    }
    state.searchItems = items;
    state.searchTruncated = truncated;
    return items;
  }

  function rank(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // 索引重建有频率保护：导入新图层后立即可搜到，
    // 但连续输入时不重复扫描（十万级实体会把主线程拖死）。
    const now = Date.now();
    if (!state.searchIndexedAt || now - state.searchIndexedAt > 4000) {
      if (state.le) buildSearchIndex(state.le);
      state.searchIndexedAt = now;
    }
    const starts = [];
    const includes = [];
    for (const item of state.searchItems) {
      const n = item.name.toLowerCase();
      if (n.startsWith(q)) starts.push(item);
      else if (n.includes(q)) includes.push(item);
      if (starts.length + includes.length > 60) break;
    }
    return starts.concat(includes).slice(0, 12);
  }

  function renderResults(results, query) {
    const box = document.getElementById('search-results');
    if (!box) return;
    state.activeIndex = results.length ? 0 : -1;
    if (!results.length) {
      box.innerHTML = '<div class="empty">没有找到“' + escapeHtml(query) + '”</div>';
      box.classList.remove('hidden');
      return;
    }
    box.innerHTML = results
      .map(
        (item, i) =>
          '<div class="item' +
          (i === 0 ? ' active' : '') +
          '" data-idx="' + i + '"><span class="name">' +
          escapeHtml(item.name) +
          '</span><span class="kind">' +
          escapeHtml(item.kind) +
          '</span></div>'
      )
      .join('');
    box.classList.remove('hidden');
    Array.from(box.querySelectorAll('.item')).forEach((el) => {
      el.addEventListener('click', () => {
        gotoItem(results[Number(el.dataset.idx)]);
      });
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function hideResults() {
    const box = document.getElementById('search-results');
    if (box) box.classList.add('hidden');
    state.activeIndex = -1;
  }

  function gotoItem(item) {
    if (!item) return;
    hideResults();
    state.le.flyTo({
      longitude: item.lon,
      latitude: item.lat,
      height: item.height,
    });
    state.le.status('已飞到：' + item.name);
  }

  /** 新图层加载后刷新搜索索引（importers 在加载完成后调用）。 */
  function refreshIndex() {
    if (state.le) buildSearchIndex(state.le);
  }

  function bindSearch(le) {
    const input = document.getElementById('search-input');
    if (!input) return;
    buildSearchIndex(le);

    input.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        const q = input.value;
        if (!q.trim()) {
          hideResults();
          return;
        }
        renderResults(rank(q), q);
      }, 160);
    });

    input.addEventListener('focus', () => {
      if (input.value.trim()) {
        buildSearchIndex(le);
        renderResults(rank(input.value), input.value);
      }
    });

    input.addEventListener('keydown', (ev) => {
      const box = document.getElementById('search-results');
      const items = box ? Array.from(box.querySelectorAll('.item')) : [];
      if (ev.key === 'Escape') {
        hideResults();
        input.blur();
        return;
      }
      if (!items.length) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const dir = ev.key === 'ArrowDown' ? 1 : -1;
        state.activeIndex = (state.activeIndex + dir + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('active', i === state.activeIndex));
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const q = input.value;
        const results = rank(q);
        if (results.length) gotoItem(results[Math.max(0, state.activeIndex)]);
      }
    });

    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.searchbox')) hideResults();
    });
  }

  /* ------------------------------- 测量 ------------------------------- */

  const MODES = {
    distance: { title: '测距', minPoints: 2, primary: 'distance' },
    area: { title: '测面积', minPoints: 3, primary: 'area' },
    angle: { title: '测角度', minPoints: 3, primary: 'angle' },
    elevation: { title: '测高差', minPoints: 2, primary: 'elevation' },
  };

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = document.createElement('div');
    panel.id = 'measure-panel';
    panel.className = 'hidden';
    panel.innerHTML =
      '<h4><span id="measure-title">测量</span><button class="btn icon" id="measure-close" title="关闭">×</button></h4>' +
      '<div class="value" id="measure-value">--</div>' +
      '<div class="detail" id="measure-detail"></div>' +
      '<div class="metrics" id="measure-metrics"></div>' +
      '<div class="segments" id="measure-segments"></div>' +
      '<div class="actions">' +
      '<button class="btn" id="measure-finish">完成</button>' +
      '<button class="btn" id="measure-clear">清除</button>' +
      '</div>';
    const host = document.getElementById('viewer');
    host.appendChild(panel);
    panel.querySelector('#measure-close').addEventListener('click', clearMeasure);
    panel.querySelector('#measure-finish').addEventListener('click', () => finishMeasure());
    panel.querySelector('#measure-clear').addEventListener('click', clearMeasure);
    state.panel = panel;
    return panel;
  }

  function setPanel(title, value, detail) {
    const panel = ensurePanel();
    panel.classList.remove('hidden');
    panel.querySelector('#measure-title').textContent = title;
    panel.querySelector('#measure-value').textContent = value || '--';
    panel.querySelector('#measure-detail').textContent = detail || '';
  }

  function setMetrics(rows) {
    const panel = ensurePanel();
    const box = panel.querySelector('#measure-metrics');
    if (!rows || !rows.length) {
      box.innerHTML = '';
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = rows
      .map(
        (r) =>
          '<div class="metric"><span class="k">' +
          escapeHtml(r[0]) +
          '</span><span class="v">' +
          escapeHtml(String(r[1])) +
          '</span></div>'
      )
      .join('');
  }

  function setSegments(rows) {
    const panel = ensurePanel();
    const box = panel.querySelector('#measure-segments');
    if (!rows || !rows.length) {
      box.innerHTML = '';
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML =
      '<div class="seg-head">分段</div>' +
      rows
        .map(
          (r) =>
            '<div class="seg-row"><span class="i">' +
            escapeHtml(String(r[0])) +
            '</span><span class="d">' +
            escapeHtml(String(r[1])) +
            '</span><span class="a">' +
            escapeHtml(String(r[2])) +
            '</span></div>'
        )
        .join('');
  }

  function formatDistance(meters) {
    return M ? M.formatDistance(meters) : '--';
  }

  function formatArea(squareMeters) {
    return M ? M.formatArea(squareMeters) : '--';
  }

  /** 取一个点的经纬度（度）。 */
  function lonLatOf(position) {
    const carto = C.Cartographic.fromCartesian(position);
    if (!carto) return null;
    return [C.Math.toDegrees(carto.longitude), C.Math.toDegrees(carto.latitude)];
  }

  /** 当前所有量算点的经纬度序列。 */
  function currentPoints() {
    const out = [];
    for (const p of state.positions) {
      const ll = lonLatOf(p);
      if (ll) out.push(ll);
    }
    return out;
  }

  function heightAt(lon, lat) {
    return window.LETerrain?.measurementHeightAt(lon, lat) ?? null;
  }

  function loadMissingHeights(points) {
    if (state.heightLoad !== 'idle' || !window.LETerrain?.loadMeasurementHeights) return;
    const revision = state.heightRevision;
    state.heightLoad = 'loading';
    window.LETerrain.loadMeasurementHeights(points)
      .catch(error => console.warn('[测距] 读取高程失败', error))
      .finally(() => {
        if (state.heightRevision !== revision) return;
        state.heightLoad = 'finished';
        computeResult();
      });
  }

  function distanceMetrics(points, elevation) {
    const start = points.length ? heightAt(...points[0]) : null;
    const end = points.length >= 2 ? heightAt(...points[points.length - 1]) : null;
    const profile = elevation?.ok ? elevation : null;
    if (points.length && (!Number.isFinite(start) || (elevation && !profile))) {
      const missing = elevation?.points.filter(s => !Number.isFinite(s.height)).map(s => [s.lon, s.lat]);
      loadMissingHeights(missing?.length ? missing : points);
    }
    const unavailable = state.heightLoad === 'loading' ? '正在读取高程…' : '暂无高程数据';
    function value(height, hasPoint, prompt) {
      if (!hasPoint) return prompt;
      return Number.isFinite(height) ? M.formatElevation(height) : unavailable;
    }
    const hasStart = points.length > 0, hasEnd = points.length > 1;
    const waiting = hasStart ? '待选终点' : '待选起点';
    return [
      ['起点高程', value(start, hasStart, waiting)],
      ['终点高程', value(end, hasEnd, waiting)],
      ['净高差', value(Number.isFinite(start) && Number.isFinite(end) ? end - start : null, hasEnd, waiting)],
      ['累计爬升', value(profile?.climb, hasEnd, waiting)],
      ['累计下降', value(profile?.descent, hasEnd, waiting)],
      ['最高点', value(profile?.max, hasEnd, waiting)],
      ['最低点', value(profile?.min, hasEnd, waiting)],
      ['平均坡度', hasEnd ? (profile ? profile.slope.toFixed(2) + ' %' : unavailable) : waiting],
    ];
  }

  function isDoubleClickRepeat(screenPos) {
    if (!screenPos) return false;
    const now=performance.now(), prev=state.lastScreenClick;
    const repeated=!!(prev && now-prev.at<=500 &&
      Math.hypot(screenPos.x-prev.x,screenPos.y-prev.y)<=8);
    state.lastScreenClick={x:screenPos.x,y:screenPos.y,at:now};
    return repeated;
  }

  function terrainLinePositions(positions, stepMeters) {
    const drape=window.LEDraping;
    if (!drape || typeof drape.drapePolyline!=='function' || !positions || positions.length<2) return positions;
    const points=positions.map(function(position){
      const c=C.Cartographic.fromCartesian(position);
      return c ? {lon:C.Math.toDegrees(c.longitude),lat:C.Math.toDegrees(c.latitude),height:c.height} : null;
    }).filter(Boolean);
    const dense=drape.drapePolyline(points,{force:true,offset:1.5,stepMeters:stepMeters||20});
    return dense && dense.length>=2 ? dense : positions;
  }

  /**
   * 造一个投影正算函数，用于「投影面积」。
   * 按中心点自动选 UTM 带，用 proj4（vendor/proj4）换算。
   */
  function makeProjector(points) {
    if (!M || !window.LEProj || !window.proj4) return null;
    if (!points.length) return null;
    let cx = 0, cy = 0;
    for (const p of points) {
      cx += p[0];
      cy += p[1];
    }
    cx /= points.length;
    cy /= points.length;
    const pick = M.pickProjection(cx, cy);
    const defs = window.LEProj.EPSG_DEFS || {};
    const def = defs[pick.epsg];
    if (!def) return null;
    try {
      const conv = window.proj4('EPSG:4326', def);
      if (!conv || typeof conv.forward !== 'function') return null;
      return {
        epsg: pick.epsg,
        label: pick.label,
        fn: (lon, lat) => {
          const out = conv.forward([lon, lat]);
          if (!out || !isFinite(out[0]) || !isFinite(out[1])) return null;
          return out;
        },
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * 计算并渲染当前量算结果。
   * @returns {object} summarize 的结果
   */
  function computeResult() {
    const pts = currentPoints();
    const projector = pts.length >= 3 ? makeProjector(pts) : null;
    const sum = M.summarize(pts, {
      heightAt: heightAt,
      project: projector ? projector.fn : null,
    });
    sum.projector = projector;

    const mode = state.mode || state.lastMode;
    if (!mode) return sum;
    const rows = [];
    let primary = '--';

    if (mode === 'distance') {
      primary = pts.length >= 2 ? formatDistance(sum.distance) : '等待选点';
      rows.push(...distanceMetrics(pts, sum.elevation));
      if (pts.length >= 2) rows.push(['段数', String(sum.segments.length)]);
      if (pts.length >= 3) {
        rows.push(['球面面积', formatArea(sum.areaSpherical)]);
        if (sum.areaProjected != null) rows.push(['投影面积', formatArea(sum.areaProjected)]);
        rows.push(['周长', formatDistance(sum.perimeter)]);
      }
    } else if (mode === 'area' && pts.length >= 3) {
      primary = formatArea(sum.areaSpherical);
      rows.push(['球面面积', formatArea(sum.areaSpherical)]);
      if (sum.areaProjected != null) rows.push(['投影面积', formatArea(sum.areaProjected)]);
      rows.push(['周长', formatDistance(sum.perimeter)]);
      if (sum.elevation && sum.elevation.ok) {
        rows.push(['高差', M.formatElevation(sum.elevation.net)]);
        rows.push(['累计爬升', M.formatElevation(sum.elevation.climb)]);
        rows.push(['累计下降', M.formatElevation(sum.elevation.descent)]);
        rows.push(['最高点', M.formatElevation(sum.elevation.max)]);
        rows.push(['最低点', M.formatElevation(sum.elevation.min)]);
        rows.push(['平均坡度', sum.elevation.slope.toFixed(2) + ' %']);
      }
    } else if (mode === 'angle' && pts.length >= 3) {
      primary = sum.angles.length ? M.formatAngle(sum.angles[0].angle) : '--';
      rows.push(['顶点数', String(sum.angles.length + 2)]);
      rows.push(['夹角数', String(sum.angles.length)]);
      rows.push(['总长度', formatDistance(sum.distance)]);
    } else if (mode === 'elevation' && pts.length >= 2) {
      const e = sum.elevation;
      if (e && e.ok) {
        primary = M.formatElevation(e.net);
        rows.push(['净高差', M.formatElevation(e.net)]);
        rows.push(['累计爬升', M.formatElevation(e.climb)]);
        rows.push(['累计下降', M.formatElevation(e.descent)]);
        rows.push(['最高点', M.formatElevation(e.max)]);
        rows.push(['最低点', M.formatElevation(e.min)]);
        rows.push(['水平距离', formatDistance(e.horizontal)]);
        rows.push(['平均坡度', e.slope.toFixed(2) + ' %']);
      } else {
        rows.push(...distanceMetrics(pts, e));
        primary = rows.find(row => row[0] === '净高差')[1];
      }
    }

    // 分段明细
    const segs = [];
    if (mode === 'distance' && sum.segments.length) {
      for (const s of sum.segments) {
        segs.push([s.index, formatDistance(s.distance), M.formatBearing(s.azimuth)]);
      }
    } else if (mode === 'area' && sum.segments.length) {
      for (const s of sum.segments) {
        segs.push([s.index, formatDistance(s.distance), M.formatBearing(s.azimuth)]);
      }
    } else if (mode === 'angle' && sum.angles.length) {
      for (const a of sum.angles) {
        segs.push([a.index, '夹角 ' + M.formatAngle(a.angle), M.formatBearing(a.azimuthOut)]);
      }
    } else if (mode === 'elevation' && sum.elevation && sum.elevation.ok) {
      // 高差模式只列**用户点击的顶点**（采样点太密，列出来没法看）
      for (let i = 0; i < pts.length; i++) {
        segs.push([i + 1, '点 ' + (i + 1), M.formatElevation(heightAt(pts[i][0], pts[i][1]))]);
      }
      // 再补最高 / 最低点
      const e = sum.elevation;
      const hi = e.points.reduce((a, b) => (b.height > a.height ? b : a), e.points[0]);
      const lo = e.points.reduce((a, b) => (b.height < a.height ? b : a), e.points[0]);
      segs.push(['最高', '里程 ' + formatDistance(hi.s), M.formatElevation(hi.height)]);
      segs.push(['最低', '里程 ' + formatDistance(lo.s), M.formatElevation(lo.height)]);
    }

    setMetrics(rows);
    setSegments(segs);

    const detailBits = [];
    detailBits.push(pts.length + ' 个点');
    if (projector) detailBits.push('投影 ' + projector.label);
    if (!state.mode) detailBits.push('测量已完成');
    else if (!pts.length) detailBits.push('点击地面选择起点');
    else if (pts.length === 1) detailBits.push('再点一处地面计算距离和高差');
    else detailBits.push('双击或点“完成”结束');
    setPanel(MODES[mode] ? MODES[mode].title : '测量', primary, detailBits.join(' · '));
    state.panel.querySelector('#measure-finish').disabled = !state.mode || pts.length < MODES[mode].minPoints;

    return sum;
  }

  function surfaceDistanceMeters(a, b) {
    const ga = C.Cartographic.fromCartesian(a);
    const gb = C.Cartographic.fromCartesian(b);
    const geo = new C.EllipsoidGeodesic(ga, gb, C.Ellipsoid.WGS84);
    return geo.surfaceDistance;
  }

  function polygonAreaMeters2(positions) {
    // 球面多边形面积（近似，WGS84 平均半径）
    const R = 6371008.8;
    let sum = 0;
    for (let i = 0; i < positions.length; i++) {
      const a = C.Cartographic.fromCartesian(positions[i]);
      const b = C.Cartographic.fromCartesian(positions[(i + 1) % positions.length]);
      sum +=
        (C.Math.toDegrees(b.longitude) - C.Math.toDegrees(a.longitude)) *
        (2 + Math.sin(a.latitude) + Math.sin(b.latitude));
    }
    return Math.abs((sum * R * R) / 2);
  }

  function totalDistance(positions) {
    let total = 0;
    for (let i = 1; i < positions.length; i++) {
      total += surfaceDistanceMeters(positions[i - 1], positions[i]);
    }
    return total;
  }

  function redraw() {
    const le = state.le;
    for (const entity of state.entities) le.viewer.entities.remove(entity);
    state.entities = [];
    if (!state.positions.length) {
      if (state.mode) computeResult();
      else state.panel && state.panel.classList.add('hidden');
      return;
    }

    for (const pos of state.positions) {
      state.entities.push(
        le.viewer.entities.add({
          position: pos,
          point: { pixelSize: 7, color: C.Color.fromCssColorString('#7ee0c0'), outlineColor: C.Color.BLACK, outlineWidth: 1 },
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        })
      );
    }

    const mode = state.mode;
    const isArea = mode === 'area';
    if (isArea && state.positions.length >= 2) {
      state.entities.push(
        le.viewer.entities.add({
          polygon: {
            hierarchy: new C.PolygonHierarchy(state.positions),
            material: C.Color.fromCssColorString('#3ea6ff').withAlpha(0.22),
            outline: true,
            outlineColor: C.Color.fromCssColorString('#3ea6ff').withAlpha(0.9),
            perPositionHeight: false,
          },
        })
      );
    } else if (state.positions.length >= 2) {
      state.entities.push(
        le.viewer.entities.add({
          polyline: {
            positions: terrainLinePositions(state.positions),
            width: 3,
            arcType: C.ArcType.NONE,
            clampToGround: false,
            material: C.Color.fromCssColorString('#7ee0c0'),
          },
        })
      );
    }

    if (mode === 'angle' && state.positions.length >= 3) {
      // 在每个中间顶点画一小段角度弧线提示
      const pts = currentPoints();
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const azIn = M.azimuth1(a[0], a[1], b[0], b[1]);
        const azOut = M.azimuth1(b[0], b[1], c[0], c[1]);
        const r = 60;
        const arc = [];
        const steps = 12;
        const dLon = Math.cos(b[1] * Math.PI / 180) * (r / 111319.4908);
        const dLat = r / 110574.3886;
        for (let k = 0; k <= steps; k++) {
          const az = azIn + ((azOut - azIn) * k) / steps;
          const rr = az * Math.PI / 180;
          arc.push(
            C.Cartesian3.fromDegrees(
              b[0] + dLon * Math.sin(rr),
              b[1] + dLat * Math.cos(rr),
              0
            )
          );
        }
        state.entities.push(
          le.viewer.entities.add({
            polyline: {
              positions: terrainLinePositions(arc, 5),
              width: 2,
              arcType: C.ArcType.NONE,
              clampToGround: false,
              material: C.Color.fromCssColorString('#ffd93b').withAlpha(0.95),
            },
          })
        );
      }
    }

    computeResult();
  }

  function addPoint(position) {
    state.heightRevision++;
    state.heightLoad = 'idle';
    state.positions.push(position);
    redraw();
    const le = state.le;
    const title = MODES[state.mode] ? MODES[state.mode].title : '测量';
    le.status(title + '：已选 ' + state.positions.length + ' 个点');
  }

  function finishMeasure() {
    if (!state.mode || state.positions.length < MODES[state.mode].minPoints) return;
    const mode = state.mode;
    if (window.LEMarkers && typeof window.LEMarkers.suppressDoubleClick === 'function') {
      window.LEMarkers.suppressDoubleClick(650);
    }
    if (state.clickHandler) {
      state.clickHandler.destroy();
      state.clickHandler = null;
    }
    state.lastMode = mode;
    state.mode = null;
    state.lastScreenClick = null;
    if (state.le && state.le.state) state.le.state.measureActive = false;
    computeResult();
    state.le.status((MODES[mode] ? MODES[mode].title : '测量') + '完成');
    cycleButtons(false);
  }

  function startMeasure(mode) {
    const le = state.le;
    if (!MODES[mode]) return;
    clearMeasure(true);
    state.mode = mode;
    state.lastMode = mode;
    state.lastScreenClick = null;
    le.state.measureActive = true;
    cycleButtons(true, mode);
    const spec = MODES[mode];
    le.status(spec.title + '：在地球上点击' + (mode === 'area' || mode === 'angle' ? '第一个点' : '起点'));
    ensurePanel();
    setPanel(spec.title, '--', '点击地球添加点；双击或点“完成”结束');
    setMetrics([]);
    setSegments([]);
    redraw();
    if (window.LEMarkers && typeof window.LEMarkers.suppressDoubleClick === 'function') {
      window.LEMarkers.suppressDoubleClick(350);
    }
    const handler = new C.ScreenSpaceEventHandler(le.viewer.scene.canvas);
    handler.setInputAction((movement) => {
      if (!state.mode) return;
      const ray = le.viewer.camera.getPickRay(movement.position);
      const pos = (ray && le.viewer.scene.globe.pick(ray, le.viewer.scene)) ||
        le.viewer.camera.pickEllipsoid(movement.position, le.viewer.scene.globe.ellipsoid);
      if (pos && !isDoubleClickRepeat(movement.position)) addPoint(pos);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => {
      if (state.mode) finishMeasure();
    }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    state.clickHandler && state.clickHandler.destroy();
    state.clickHandler = handler;
  }

  function cycleButtons(active, mode) {
    const ids = ['btn-measure-distance', 'btn-measure-area', 'btn-measure-angle', 'btn-measure-elevation'];
    const keys = ['distance', 'area', 'angle', 'elevation'];
    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('tool-active', !!active && mode === keys[i]);
    });
  }

  function clearMeasure(silent) {
    const le = state.le;
    if (!le) return;
    if (state.clickHandler) {
      state.clickHandler.destroy();
      state.clickHandler = null;
    }
    for (const entity of state.entities) le.viewer.entities.remove(entity);
    state.entities = [];
    state.positions = [];
    state.heightRevision++;
    state.heightLoad = 'idle';
    state.mode = null;
    state.lastMode = null;
    state.lastScreenClick = null;
    le.state.measureActive = false;
    cycleButtons(false);
    if (state.panel) {
      state.panel.classList.add('hidden');
      setMetrics([]);
      setSegments([]);
    }
    if (!silent) le.status('测量已清除');
  }

  window.LETools = {
    init(le) {
      state.le = le;
      bindSearch(le);
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && state.mode) clearMeasure();
      });
    },
    startMeasure,
    isActive: () => !!state.mode,
    getMode: () => state.mode,
    clearMeasure,
    finishMeasure,
    /** 当前量算结果（供外部/测试读取）。 */
    result() {
      return computeResult();
    },
    /** 当前量算点（经纬度）。 */
    points() {
      return currentPoints();
    },
    /**
     * 测试钩子：直接注入一个量算点（绕开屏幕拾取）。
     * 仅供 tools/test-measure-ui.js 使用，不参与正常交互路径。
     */
    _addPointForTest(position) {
      addPoint(position);
    },
    modes() {
      return Object.keys(MODES);
    },
    search(query) {
      return rank(String(query || ''));
    },
    gotoItem,
    rebuildSearchIndex() {
      return state.le ? buildSearchIndex(state.le) : [];
    },
  };
})();

/*
 * 火场风场计算（手动背景风模式）· 前端逻辑
 * ---------------------------------------------------------------
 * 用途：无需观测数据，按 DEM 地形 + 手动背景风，调用本地 Wind3D 引擎
 *       计算火场低空风场，算完后自动把结果交给 js/windninja.js 渲染。
 *
 * 接口（全部为相对路径，端口由本地服务决定，不写死）
 *   GET  api/wind3d/status                 → { ok, cli, cliFound, jobs }
 *   POST api/wind3d/pick-dem               → { ok, path } | { ok:false, cancelled:true }
 *   POST api/wind3d/run   (JSON 参数)      → { ok, jobId, job }
 *   GET  api/wind3d/jobs/{jobId}           → { id, status, log, scenes, exitCode, ... }
 *   POST api/wind3d/jobs/{jobId}/cancel    → { ok, status }
 *
 * 约定：原生 JS、无依赖、IIFE；不弹 alert / confirm；状态显示在
 *       #w3d-state 胶囊与 #w3d-log 日志里。
 */
(function () {
  'use strict';

  var LS_PREFIX = 'maomaoearth.wind3d.';   // 最近 DEM 路径 / 模拟时间
  var POLL_MS = 1500;                      // 轮询间隔
  var MAX_POLLS = 2400;                    // 约 1 小时，防止无限轮询

  var els = {};
  var st = {
    ready: false,
    jobId: null,
    timer: 0,
    running: false,
    polls: 0,
    failStreak: 0,
    lastStatus: '',
  };

  var MODE_NOTES = {
    stations: '常规风场：读取观测目录中的 WindMaster / DAT / UAV / 通用站点 CSV，生成多高度平均风场。',
    turbulence: '湍流 RANS：手动背景风无需观测；逐站剖面需要 WindMaster + UAV 资料。',
    assimilation: '逐站观测同化：先建立 RANS 背景，再用固定站平均风做最优插值；固定站 CSV 可选。',
    'native-assimilation': '原生 RANS 耦合同化：固定站 CSV 必需，至少一条含 k/epsilon 或混合长度；输出 NetCDF/KMZ。'
  };
  var MODE_LABELS = {
    stations: '常规风场',
    turbulence: '湍流 RANS',
    assimilation: '逐站观测同化',
    'native-assimilation': '原生 RANS 耦合同化'
  };

  var MODE_HELP = {
    stations: '1. 选择含 WindMaster / DAT / UAV / 通用站点 CSV 的观测目录。\n2. DEM 可放在观测目录，也可单独选择。\n3. 选择时间、输出高度、分辨率。\n4. 开始计算，结果自动加载。',
    turbulence: '手动背景：选择 DEM，填写背景风速/风向/高度，无需观测。\n逐站剖面：选择含 WindMaster + UAV 的观测目录和 DEM；UAV 高度定义必须与资料一致。\nRANS 可能耗时数分钟。',
    assimilation: '1. 选择含 WindMaster 背景和 UAV 独立验证的观测目录。\n2. 选择 DEM。\n3. 可选固定站 CSV；不提供时只用已读入的 WindMaster。\n4. 结果先写入 NetCDF/KMZ，再自动转换为地图 ASCII。',
    'native-assimilation': '1. 选择含 WindMaster 背景和 UAV 验证的观测目录。\n2. 选择 DEM。\n3. 固定站 CSV 必须提供，至少一条含 k/epsilon 或混合长度。\n4. 使用 Windows 原生 OpenFOAM 运行库，输出 NetCDF/KMZ 后自动回载。'
  };

  /* ------------------------------ 小工具 ------------------------------ */

  function byId(id) { return document.getElementById(id); }

  function lsGet(key) {
    try { return window.localStorage.getItem(LS_PREFIX + key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try {
      if (value == null || value === '') window.localStorage.removeItem(LS_PREFIX + key);
      else window.localStorage.setItem(LS_PREFIX + key, String(value));
    } catch (e) { /* 隐私模式或配额受限：忽略 */ }
  }

  function toNum(v) {
    if (v == null) return NaN;
    var s = String(v).trim();
    if (!s) return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function numVal(id, fallback) {
    var el = byId(id);
    var n = toNum(el && el.value);
    return isFinite(n) ? n : fallback;
  }

  /** 统一的 toast：优先用主程序 LE.toast，退化为写日志 */
  function toast(msg, kind) {
    var LE = window.LE;
    if (LE && typeof LE.toast === 'function') {
      try { LE.toast(msg, kind || '', 4200); return; } catch (e) { /* 继续退化 */ }
    }
    appendLog((kind === 'error' ? '✕ ' : kind === 'ok' ? '✓ ' : '· ') + msg);
  }

  /** 状态胶囊：#w3d-state（is-idle / is-run / is-ok / is-err） */
  function setPill(kind, text) {
    var el = els.state;
    if (!el) return;
    el.classList.remove('is-idle', 'is-run', 'is-ok', 'is-err');
    el.classList.add('is-' + (kind || 'idle'));
    el.textContent = text || '待机';
  }

  /* ------------------------------ 日志 ------------------------------ */

  function appendLog(line) {
    var el = els.log;
    if (!el) return;
    var text = String(line == null ? '' : line);
    var cur = el.textContent || '';
    el.textContent = cur && cur !== '就绪：等待计算任务。' ? cur + '\n' + text : text;
    el.scrollTop = el.scrollHeight;
  }

  /** 服务端返回整段日志：内容变化才替换，避免每 1.5s 抖动 */
  function setServerLog(text) {
    var el = els.log;
    if (!el) return;
    var body = String(text == null ? '' : text).replace(/\s+$/, '');
    if (!body) return;
    if (el.textContent === body) return;
    el.textContent = body;
    el.scrollTop = el.scrollHeight;
  }

  function clearLog() {
    if (els.log) els.log.textContent = '就绪：等待计算任务。';
    setPill(st.running ? 'run' : 'idle', st.running ? '计算中' : '待机');
  }

  /* ------------------------------ HTTP ------------------------------ */

  function requestJson(url, options) {
    var opt = options || {};
    var init = { method: opt.method || 'GET', cache: 'no-store' };
    if (opt.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opt.body);
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        if (!res.ok) {
          var msg = (data && (data.error || data.message)) || ('本地服务返回 HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        if (!data) throw new Error('本地服务返回了空响应');
        return data;
      });
    });
  }

  function getJson(url) { return requestJson(url, { method: 'GET' }); }
  function postJson(url, body) { return requestJson(url, { method: 'POST', body: body || {} }); }

  /* ------------------------------ 按钮状态 ------------------------------ */

  function setBusy(busy) {
    st.running = !!busy;
    if (els.run) els.run.disabled = !!busy;
    if (els.view) els.view.disabled = !!busy;
    if (els.pick) els.pick.disabled = !!busy;
    if (els.pickInput) els.pickInput.disabled = !!busy;
    if (els.pickCsv) els.pickCsv.disabled = !!busy;
    if (els.cancel) els.cancel.disabled = !busy;
  }

  /* ------------------------------ 视图范围 ------------------------------ */

  function fillFromView() {
    var LE = window.LE;
    if (!LE || !LE.viewer || !LE.Cesium) {
      toast('地球尚未就绪，无法读取当前视图', 'error');
      return;
    }
    var C = LE.Cesium;
    var viewer = LE.viewer;
    var rect = null;
    try {
      rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    } catch (e) {
      rect = null;
    }

    var south, west, north, east;
    if (rect && isFinite(rect.west) && isFinite(rect.south) && isFinite(rect.east) && isFinite(rect.north)) {
      south = C.Math.toDegrees(rect.south);
      west = C.Math.toDegrees(rect.west);
      north = C.Math.toDegrees(rect.north);
      east = C.Math.toDegrees(rect.east);
    }

    // 视图过大 / 覆盖极点 / 跨日界线时 computeViewRectangle 不可用：退回相机位置 ±0.02°
    if (!isFinite(south) || !isFinite(west) || !isFinite(north) || !isFinite(east) ||
        !(south < north) || !(west < east)) {
      var carto = viewer.camera.positionCartographic;
      var lon = C.Math.toDegrees(carto.longitude);
      var lat = C.Math.toDegrees(carto.latitude);
      south = lat - 0.02; north = lat + 0.02;
      west = lon - 0.02; east = lon + 0.02;
    }

    // 夹到合法经纬度范围
    south = Math.max(-90, Math.min(90, south));
    north = Math.max(-90, Math.min(90, north));
    west = Math.max(-180, Math.min(180, west));
    east = Math.max(-180, Math.min(180, east));

    setVal(els.south, south.toFixed(4));
    setVal(els.west, west.toFixed(4));
    setVal(els.north, north.toFixed(4));
    setVal(els.east, east.toFixed(4));

    appendLog('· 已取当前视图范围：' +
      south.toFixed(4) + ' / ' + west.toFixed(4) + ' / ' +
      north.toFixed(4) + ' / ' + east.toFixed(4) + '（南/西/北/东）');
  }

  function setVal(el, v) { if (el) el.value = v; }

  /* ------------------------------ 参数校验 ------------------------------ */

  function modeLabel(mode) {
    return MODE_LABELS[mode] || mode || 'Wind3D';
  }
  function currentMode() {
    return (els.mode && els.mode.value) || 'turbulence';
  }
  function currentTurbSource() {
    return (els.turbSource && els.turbSource.value) || 'manual';
  }
  function isManualTurbulence() {
    return currentMode() === 'turbulence' && currentTurbSource() === 'manual';
  }
  function applyMode() {
    var mode = currentMode();
    var manual = isManualTurbulence();
    if (els.inputRow) els.inputRow.hidden = manual;
    if (els.stationRow) els.stationRow.hidden = !(mode === 'assimilation' || mode === 'native-assimilation');
    if (els.turbRow) els.turbRow.hidden = mode !== 'turbulence';
    if (els.bgFields) els.bgFields.hidden = !manual;
    if (els.uavRow) els.uavRow.hidden = (mode === 'stations' || manual);
    if (els.modeNote) els.modeNote.textContent = MODE_NOTES[mode] || '';
    if (els.helpText) els.helpText.textContent = MODE_HELP[mode] || '';
    if (els.stationRow) {
      var label = els.stationRow.querySelector('.fld-l');
      if (label) label.textContent = mode === 'native-assimilation' ? '固定站 CSV（必需）' : '固定站 CSV（可选）';
    }
  }

  function readParams() {
    var mode = currentMode();
    var turbSource = currentTurbSource();
    var manual = isManualTurbulence();
    var demPath = (els.dem && els.dem.value || '').trim();
    var inputDir = (els.inputDir && els.inputDir.value || '').trim();
    var stationCsv = (els.stationCsv && els.stationCsv.value || '').trim();
    var uavHeight = (els.uavHeight && els.uavHeight.value || 'gps_altitude_minus_dem');

    if (!manual && !inputDir) {
      return { ok: false, message: '请选择包含观测数据的目录（WindMaster / DAT / UAV / 站点 CSV）' };
    }
    if (mode !== 'stations' && !demPath) {
      return { ok: false, message: '请先选择 DEM（GeoTIFF）文件' };
    }
    if (mode === 'native-assimilation' && !stationCsv) {
      return { ok: false, message: '原生 RANS 耦合同化必须提供固定站 CSV' };
    }

    var south = toNum(els.south && els.south.value);
    var west = toNum(els.west && els.west.value);
    var north = toNum(els.north && els.north.value);
    var east = toNum(els.east && els.east.value);
    if (!isFinite(south) || !isFinite(west) || !isFinite(north) || !isFinite(east)) {
      return { ok: false, message: '计算范围必须是有效数字（可点「取当前视图范围」自动填充）' };
    }
    if (!(south < north)) return { ok: false, message: '南界必须小于北界' };
    if (!(west < east)) return { ok: false, message: '西界必须小于东界' };
    if (south < -90 || north > 90 || west < -180 || east > 180) {
      return { ok: false, message: '经纬度超出范围（纬度 ±90，经度 ±180）' };
    }

    var startLocal = (els.startTime && els.startTime.value || '').trim();
    var endLocal = (els.endTime && els.endTime.value || '').trim();
    if (!startLocal) return { ok: false, message: '请选择模拟开始时间' };
    if (!endLocal) endLocal = startLocal;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startLocal) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(endLocal)) {
      return { ok: false, message: '模拟时间格式无效，请用日期时间选择器' };
    }
    var tz = (els.timezone && els.timezone.value) || '+08:00';
    var startTime = /(Z|[+-]\d{2}:\d{2})$/.test(startLocal) ? startLocal : startLocal + tz;
    var endTime = /(Z|[+-]\d{2}:\d{2})$/.test(endLocal) ? endLocal : endLocal + tz;
    if (isNaN(Date.parse(startTime))) return { ok: false, message: '开始时间格式无效：' + startTime };
    if (isNaN(Date.parse(endTime))) return { ok: false, message: '结束时间格式无效：' + endTime };
    if (Date.parse(endTime) < Date.parse(startTime)) {
      return { ok: false, message: '结束时间必须不早于开始时间' };
    }

    var speed = 0, direction = 0, bgHeight = 0;
    if (manual) {
      speed = toNum(els.speed && els.speed.value);
      if (!isFinite(speed) || speed <= 0) return { ok: false, message: '背景风速必须大于 0' };
      direction = toNum(els.direction && els.direction.value);
      if (!isFinite(direction) || direction < 0 || direction >= 360) {
        return { ok: false, message: '背景风向必须在 0–359 度之间' };
      }
      bgHeight = toNum(els.bgHeight && els.bgHeight.value);
      if (!isFinite(bgHeight) || bgHeight <= 0) return { ok: false, message: '背景高度必须大于 0' };
    }

    var heightText = (els.heights && els.heights.value || '').trim();
    var heights = [];
    var tokens = heightText.split(/[,\s]+/);
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (!tk) continue;
      var h = Number(tk);
      if (!isFinite(h) || h <= 0 || Math.floor(h) !== h) {
        return { ok: false, message: '输出高度必须是正整数：' + tk };
      }
      if (heights.indexOf(h) < 0) heights.push(h);
    }
    if (!heights.length) return { ok: false, message: '至少需要一个输出高度（例如 50）' };

    var resolution = toNum(els.resolution && els.resolution.value);
    if (!isFinite(resolution) || resolution <= 0 || Math.floor(resolution) !== resolution) {
      return { ok: false, message: '网格分辨率必须是正整数（米）' };
    }

    var referenceHeight = numVal('w3d-reference-height', 50);
    var roughness = numVal('w3d-roughness', 0.1);
    var displacementHeight = numVal('w3d-displacement', 0);
    var canopyHeight = numVal('w3d-canopy', 0);
    var buffer = numVal('w3d-buffer', 10);
    var maxCases = numVal('w3d-max-cases', 1);
    var windmasterHeight = (byId('w3d-windmaster-height') || {}).value || 'agl';
    var windmasterAgl = numVal('w3d-windmaster-agl', 0);
    var uavDirection = (byId('w3d-uav-direction') || {}).value || 'from_true_north';
    var assimHScale = numVal('w3d-assim-hscale', 1000);
    var assimBgSigma = numVal('w3d-assim-bgsigma', 2);
    var assimObsSigma = numVal('w3d-assim-obssigma', 0.5);
    var assimVScale = numVal('w3d-assim-vscale', 30);
    var nativeHRadius = numVal('w3d-native-hradius', 300);
    var nativeVRadius = numVal('w3d-native-vradius', 50);
    var nativeIterations = numVal('w3d-native-iterations', 1000);
    var nativeTolerance = numVal('w3d-native-tolerance', 0.00001);
    var kmzEl = byId('w3d-kmz');
    var kmz = !kmzEl || !!kmzEl.checked;

    return {
      ok: true,
      body: {
        mode: mode,
        turbSource: turbSource,
        demPath: demPath,
        inputDir: inputDir,
        stationCsv: stationCsv,
        uavHeightReference: uavHeight,
        south: south,
        west: west,
        north: north,
        east: east,
        startTime: startTime,
        endTime: endTime,
        heights: heights.join(' '),
        resolution: resolution,
        speed: speed,
        direction: direction,
        backgroundHeight: bgHeight,
        referenceHeight: referenceHeight,
        roughness: roughness,
        displacementHeight: displacementHeight,
        canopyHeight: canopyHeight,
        buffer: buffer,
        maxCases: maxCases,
        windmasterHeightReference: windmasterHeight,
        windmasterPlatformAgl: windmasterAgl,
        uavDirectionReference: uavDirection,
        assimHorizontalScale: assimHScale,
        assimBackgroundSigma: assimBgSigma,
        assimObservationSigma: assimObsSigma,
        assimVerticalScale: assimVScale,
        nativeHorizontalRadius: nativeHRadius,
        nativeVerticalRadius: nativeVRadius,
        nativeMaxIterations: nativeIterations,
        nativeTolerance: nativeTolerance,
        kmz: kmz
      }
    };
  }

  /* ------------------------------ 任务流程 ------------------------------ */

  function run() {
    if (st.running) return;
    var check = readParams();
    if (!check.ok) {
      setPill('err', '参数有误');
      appendLog('✕ ' + check.message);
      toast(check.message, 'error');
      return;
    }
    var body = check.body;
    if (isManualTurbulence() && body.startTime !== body.endTime) {
      appendLog('· 手动背景风只支持单时刻，本次按开始时间计算；多时刻扫描请用研究模式或逐站剖面。');
    }
    lsSet('mode', body.mode);
    lsSet('turbSource', body.turbSource);
    lsSet('dem', body.demPath);
    lsSet('inputDir', body.inputDir);
    lsSet('stationCsv', body.stationCsv);
    lsSet('uavHeight', body.uavHeightReference);
    lsSet('startTime', body.startTime);
    lsSet('endTime', body.endTime);

    setBusy(true);
    setPill('run', '提交中');
    appendLog('▸ 提交 ' + modeLabel(body.mode) + '：' + body.heights + ' m · ' + body.resolution + ' m 网格');

    postJson('api/wind3d/run', body).then(function (res) {
      if (!res || res.ok === false || !res.jobId) {
        throw new Error((res && res.error) || '本地服务未返回任务编号');
      }
      st.jobId = res.jobId;
      st.polls = 0;
      st.failStreak = 0;
      setPill('run', '计算中');
      appendLog('▸ 任务 ' + res.jobId + ' 已启动');
      schedulePoll();
    }).catch(function (err) {
      setBusy(false);
      setPill('err', '提交失败');
      appendLog('✕ 提交失败：' + (err && err.message ? err.message : err));
      toast('提交失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  function schedulePoll() {
    stopPoll();
    st.timer = window.setTimeout(poll, POLL_MS);
  }

  function stopPoll() {
    if (st.timer) { window.clearTimeout(st.timer); st.timer = 0; }
  }

  function poll() {
    st.timer = 0;
    if (!st.jobId) return;
    st.polls++;
    if (st.polls > MAX_POLLS) {
      setBusy(false);
      setPill('err', '超时');
      appendLog('✕ 轮询超过上限，已停止跟踪任务（任务可能仍在后台运行）');
      return;
    }
    getJson('api/wind3d/jobs/' + encodeURIComponent(st.jobId)).then(function (job) {
      st.failStreak = 0;
      applyJob(job);
    }).catch(function (err) {
      st.failStreak++;
      appendLog('✕ 查询任务状态失败：' + (err && err.message ? err.message : err));
      if (err && err.status === 404) {
        setBusy(false);
        setPill('err', '任务丢失');
        appendLog('✕ 任务不存在或本地服务已重启，请重新提交');
        return;
      }
      if (st.failStreak < 3) { schedulePoll(); return; }
      setBusy(false);
      setPill('err', '连接中断');
    });
  }

  function applyJob(job) {
    if (!job || typeof job !== 'object') throw new Error('任务状态无效');
    if (job.log) setServerLog(job.log);

    var status = String(job.status || '');
    st.lastStatus = status;

    if (status === 'running') {
      setBusy(true);
      setPill('run', '计算中');
      schedulePoll();
      return;
    }

    setBusy(false);

    if (status === 'completed') {
      setPill('ok', '完成');
      onCompleted(job);
      return;
    }
    if (status === 'cancelled') {
      setPill('idle', '已取消');
      appendLog('· 任务已取消');
      return;
    }
    if (status === 'failed') {
      setPill('err', '失败');
      var code = job.exitCode;
      appendLog('✕ 计算失败' + (code == null ? '' : '（退出码 ' + code + '）') + '，详见上方日志');
      toast('火场风场计算失败', 'error');
      return;
    }

    // 未知状态：继续跟踪（服务端可能仍在收尾）
    setBusy(true);
    schedulePoll();
  }

  function onCompleted(job) {
    var scenes = Array.isArray(job.scenes) ? job.scenes : [];
    var urls = [];
    for (var i = 0; i < scenes.length; i++) {
      var vel = scenes[i] && scenes[i].vel;
      if (vel) urls.push(vel);
    }
    appendLog('✓ 计算完成：' + scenes.length + ' 个风场场景');
    if (!urls.length) {
      appendLog('! 计算完成但未找到风场 ASCII 结果');
      toast('计算完成但未找到风场 ASCII 结果', 'error');
      return;
    }

    var W = window.LEWindninja;
    if (!W || typeof W.loadUrls !== 'function') {
      appendLog('✕ 未加载风场渲染模块（LEWindninja），无法显示结果');
      toast('未加载风场渲染模块', 'error');
      return;
    }

    appendLog('▸ 载入风场结果…');
    Promise.resolve()
      .then(function () { return W.loadUrls(urls); })
      .then(function () {
        appendLog('✓ 已载入 ' + urls.length + ' 个高度层，可在「Wind3D / 工程 / 导出」中切换场景');
        toast('风场已载入', 'ok');
      })
      .catch(function (err) {
        appendLog('✕ 载入风场失败：' + (err && err.message ? err.message : err));
        toast('载入风场失败：' + (err && err.message ? err.message : err), 'error');
      });
  }

  function cancel() {
    if (!st.jobId || !st.running) return;
    if (els.cancel) els.cancel.disabled = true;
    appendLog('▸ 请求取消任务…');
    postJson('api/wind3d/jobs/' + encodeURIComponent(st.jobId) + '/cancel', {}).then(function (res) {
      stopPoll();
      setBusy(false);
      setPill('idle', '已取消');
      appendLog('· 已请求取消（服务状态：' + ((res && res.status) || 'cancelled') + '）');
    }).catch(function (err) {
      appendLog('✕ 取消失败：' + (err && err.message ? err.message : err));
      if (els.cancel) els.cancel.disabled = false;
      toast('取消失败', 'error');
    });
  }

  function pickDem() {
    if (els.pick) els.pick.disabled = true;
    appendLog('▸ 打开 DEM 文件选择…');
    postJson('api/wind3d/pick-dem', {}).then(function (res) {
      if (res && res.cancelled) { appendLog('· 已取消选择'); return; }
      if (!res || res.ok === false || !res.path) {
        throw new Error((res && res.error) || '未选择文件');
      }
      if (els.dem) els.dem.value = res.path;
      lsSet('dem', res.path);
      appendLog('✓ DEM：' + res.path);
      toast('已选择 DEM', 'ok');
    }).catch(function (err) {
      appendLog('✕ 选择 DEM 失败：' + (err && err.message ? err.message : err));
      toast('选择 DEM 失败：' + (err && err.message ? err.message : err), 'error');
    }).then(function () {
      if (els.pick) els.pick.disabled = st.running;
    });
  }

  function pickInput() {
    if (els.pickInput) els.pickInput.disabled = true;
    appendLog('▸ 打开观测数据目录选择…');
    postJson('api/wind3d/pick-input-dir', {}).then(function (res) {
      if (res && res.cancelled) { appendLog('· 已取消选择'); return; }
      if (!res || res.ok === false || !res.path) throw new Error((res && res.error) || '未选择目录');
      if (els.inputDir) els.inputDir.value = res.path;
      lsSet('inputDir', res.path);
      appendLog('✓ 观测目录：' + res.path);
      toast('已选择观测目录', 'ok');
    }).catch(function (err) {
      appendLog('✕ 选择观测目录失败：' + (err && err.message ? err.message : err));
      toast('选择观测目录失败', 'error');
    }).then(function () {
      if (els.pickInput) els.pickInput.disabled = st.running;
    });
  }

  function pickCsv() {
    if (els.pickCsv) els.pickCsv.disabled = true;
    appendLog('▸ 打开固定站 CSV 选择…');
    postJson('api/wind3d/pick-file', { filter: 'CSV (*.csv)|*.csv|All files (*.*)|*.*' }).then(function (res) {
      if (res && res.cancelled) { appendLog('· 已取消选择'); return; }
      if (!res || res.ok === false || !res.path) throw new Error((res && res.error) || '未选择文件');
      if (els.stationCsv) els.stationCsv.value = res.path;
      lsSet('stationCsv', res.path);
      appendLog('✓ 固定站 CSV：' + res.path);
      toast('已选择固定站 CSV', 'ok');
    }).catch(function (err) {
      appendLog('✕ 选择 CSV 失败：' + (err && err.message ? err.message : err));
      toast('选择 CSV 失败', 'error');
    }).then(function () {
      if (els.pickCsv) els.pickCsv.disabled = st.running;
    });
  }

  /* ------------------------------ 初始化 ------------------------------ */

  function defaultTime(offsetMinutes) {
    var d = new Date(Date.now() + (offsetMinutes || 0) * 60000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function setNow() {
    if (els.startTime) els.startTime.value = defaultTime(0);
    if (els.endTime) els.endTime.value = defaultTime(60);
  }

  function setEndEqualStart() {
    if (els.startTime && els.endTime) els.endTime.value = els.startTime.value || defaultTime(0);
  }

  function cache() {
    els.state = byId('w3d-state');
    els.view = byId('w3d-view');
    els.run = byId('w3d-run');
    els.south = byId('w3d-south');
    els.west = byId('w3d-west');
    els.north = byId('w3d-north');
    els.east = byId('w3d-east');
    els.dem = byId('w3d-dem');
    els.pick = byId('w3d-pick');
    els.mode = byId('w3d-mode');
    els.modeNote = byId('w3d-mode-note');
    els.inputRow = byId('w3d-input-row');
    els.inputDir = byId('w3d-input-dir');
    els.stationRow = byId('w3d-station-row');
    els.stationCsv = byId('w3d-station-csv');
    els.turbRow = byId('w3d-turb-row');
    els.turbSource = byId('w3d-turb-source');
    els.bgFields = byId('w3d-bg-fields');
    els.uavRow = byId('w3d-uav-row');
    els.uavHeight = byId('w3d-uav-height');
    els.pickInput = byId('w3d-pick-input');
    els.pickCsv = byId('w3d-pick-csv');
    els.speed = byId('w3d-speed');
    els.direction = byId('w3d-direction');
    els.bgHeight = byId('w3d-bgheight');
    els.startTime = byId('w3d-start-time');
    els.endTime = byId('w3d-end-time');
    els.timezone = byId('w3d-timezone');
    els.timeNow = byId('w3d-time-now');
    els.timeClear = byId('w3d-time-clear');
    els.focusClose = byId('w3d-focus-close');
    els.helpText = byId('w3d-help-text');
    els.heights = byId('w3d-heights');
    els.resolution = byId('w3d-resolution');
    els.cancel = byId('w3d-cancel');
    els.clear = byId('w3d-clear-log');
    els.log = byId('w3d-log');
    return !!(els.view && els.run && els.log);
  }

  function bind() {
    if (els.view) els.view.addEventListener('click', fillFromView);
    if (els.run) els.run.addEventListener('click', run);
    if (els.pick) els.pick.addEventListener('click', pickDem);
    if (els.pickInput) els.pickInput.addEventListener('click', pickInput);
    if (els.pickCsv) els.pickCsv.addEventListener('click', pickCsv);
    if (els.mode) els.mode.addEventListener('change', function () { applyMode(); lsSet('mode', els.mode.value); });
    if (els.turbSource) els.turbSource.addEventListener('change', function () { applyMode(); lsSet('turbSource', els.turbSource.value); });
    if (els.cancel) els.cancel.addEventListener('click', cancel);
    if (els.clear) els.clear.addEventListener('click', clearLog);

    // 记住最近一次 DEM 与模拟时间
    if (els.dem) {
      els.dem.addEventListener('change', function () { lsSet('dem', (els.dem.value || '').trim()); });
    }
    if (els.startTime) {
      els.startTime.addEventListener('change', function () {
        lsSet('startTime', (els.startTime.value || '').trim());
        if (els.endTime && !els.endTime.value) els.endTime.value = els.startTime.value;
      });
    }
    if (els.endTime) {
      els.endTime.addEventListener('change', function () { lsSet('endTime', (els.endTime.value || '').trim()); });
    }
    if (els.timezone) {
      els.timezone.addEventListener('change', function () { lsSet('timezone', els.timezone.value); });
    }
    if (els.timeNow) {
      els.timeNow.addEventListener('click', setNow);
    }
    if (els.timeClear) {
      els.timeClear.addEventListener('click', setEndEqualStart);
    }
    if (els.focusClose) {
      els.focusClose.addEventListener('click', function () {
        if (window.LEsidebarNav) window.LEsidebarNav.activate('task');
      });
    }
    if (els.inputDir) {
      els.inputDir.addEventListener('change', function () { lsSet('inputDir', (els.inputDir.value || '').trim()); });
    }
    if (els.stationCsv) {
      els.stationCsv.addEventListener('change', function () { lsSet('stationCsv', (els.stationCsv.value || '').trim()); });
    }
    if (els.uavHeight) {
      els.uavHeight.addEventListener('change', function () { lsSet('uavHeight', els.uavHeight.value); });
    }

    // 回车即开始计算（输入框内），便于值守时快速重算
    var inputs = [els.south, els.west, els.north, els.east, els.speed,
      els.direction, els.bgHeight, els.startTime, els.endTime, els.heights, els.resolution];
    inputs.forEach(function (el) {
      if (!el) return;
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !st.running) { ev.preventDefault(); run(); }
      });
    });
  }

  function restore() {
    var mode = lsGet('mode');
    if (mode && els.mode) els.mode.value = mode;
    var turb = lsGet('turbSource');
    if (turb && els.turbSource) els.turbSource.value = turb;
    var dem = lsGet('dem');
    if (dem && els.dem) els.dem.value = dem;
    var inputDir = lsGet('inputDir');
    if (inputDir && els.inputDir) els.inputDir.value = inputDir;
    var stationCsv = lsGet('stationCsv');
    if (stationCsv && els.stationCsv) els.stationCsv.value = stationCsv;
    var uav = lsGet('uavHeight');
    if (uav && els.uavHeight) els.uavHeight.value = uav;
    var savedStart = lsGet('startTime') || lsGet('time');
    var savedEnd = lsGet('endTime');
    var savedTz = lsGet('timezone');
    if (els.startTime) {
      if (savedStart) {
        var sm = savedStart.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        if (sm) els.startTime.value = sm[1];
      }
      if (!els.startTime.value) els.startTime.value = defaultTime(0);
    }
    if (els.endTime) {
      if (savedEnd) {
        var em = savedEnd.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        if (em) els.endTime.value = em[1];
      }
      if (!els.endTime.value) els.endTime.value = els.startTime ? els.startTime.value : defaultTime(0);
    }
    if (els.timezone) {
      if (savedTz) els.timezone.value = savedTz;
      else if (savedStart) {
        var off = savedStart.match(/(Z|[+-]\d{2}:\d{2})$/);
        if (off) els.timezone.value = off[1];
      }
    }
    if (els.heights && !els.heights.value) els.heights.value = '50';
    if (els.resolution && !els.resolution.value) els.resolution.value = '200';
    if (els.speed && !els.speed.value) els.speed.value = '8';
    if (els.direction && !els.direction.value) els.direction.value = '270';
    if (els.bgHeight && !els.bgHeight.value) els.bgHeight.value = '50';
  }

  function refreshStatus() {
    getJson('api/wind3d/status').then(function (res) {
      if (!res || res.cliFound !== true) {
        setPill('err', '引擎缺失');
        appendLog('! 未检测到 Wind3D-cli.exe：请确认引擎可执行文件已就位后重新打开页面。');
        return;
      }
      setPill('idle', '就绪');
      appendLog('· 已检测到 Wind3D 引擎' + (res.cli ? '：' + res.cli : ''));
      if (res.version) {
        appendLog('· Wind3D 版本 ' + res.version +
          (res.compatible === false ? '（低于 ' + (res.minVersion || '1.1.9') + '，建议升级）' : ''));
      } else {
        appendLog('· Wind3D 版本未知（缺少 portable_app.json）');
      }
      var jobs = Array.isArray(res.jobs) ? res.jobs : [];
      if (jobs.length) {
        var last = jobs[0];
        appendLog('· 最近任务 ' + (last.id || '--') + '：' + (last.status || '未知'));
      }
    }).catch(function (err) {
      setPill('err', '服务未连接');
      appendLog('✕ 无法连接本地服务：' + (err && err.message ? err.message : err));
      appendLog('  请通过 MaoMaoEarth 启动器 / serve.ps1 打开页面后再试。');
    });
  }

  function init() {
    if (st.ready) return;
    if (!cache()) return;              // 页面结构不匹配时静默退出
    st.ready = true;
    bind();
    restore();
    applyMode();
    setBusy(false);
    setPill('idle', '待机');
    refreshStatus();
  }

  function boot() {
    // LE 可能尚未就绪：等主程序广播 local-earth-ready
    if (window.LE && window.LE.state && window.LE.state.ready) init();
    document.addEventListener('local-earth-ready', function () { init(); }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.LEWind3dCompute = {
    init: init,
    fillFromView: fillFromView,
    focus: function () { if (window.LEsidebarNav) window.LEsidebarNav.activate('compute'); },
    blur: function () { if (window.LEsidebarNav) window.LEsidebarNav.activate('task'); }
  };
})();

/*
 * Tour / 电影运镜 · 装载层（P2-4.10）
 * ---------------------------------------------------------------------------
 * 负责把「一串关键帧」变成能在地球上飞的一段动画：
 *
 *   1. 录制：把当前相机位置追加成关键帧
 *   2. 播放：按时间推进相机（用 Cesium 的 camera.setView 逐帧跟随）
 *   3. 导出：把整条航线烘成采样点，生成**零依赖的单文件 HTML 播放器**
 *
 * 对外 API：window.LETourShell
 *   newTour() / addKeyframe(opts) / removeKeyframe(i) / clear()
 *   load(fileText) / save() / list()
 *   play() / pause() / stop() / seek(t) / getState()
 *   exportHtml(opts) / downloadHtml(opts)
 */
(function () {
  'use strict';

  const C = window.Cesium;
  const T = window.LETour;

  const state = {
    le: null,
    tour: null,          // {version,name,fov,keyframes:[...]}
    playing: false,
    timer: null,
    t: 0,                // 当前播放时间（秒）
    raf: null,
    startedAt: 0,
    startT: 0,
    listeners: [],
    listenersBound: false,
  };

  function byId(id) { return document.getElementById(id); }
  function getLE() { return state.le || window.LE; }

  function toast(msg, kind, ms) {
    const le = getLE();
    if (le && le.toast) le.toast(msg, kind || 'ok', ms || 3200);
  }

  function status(msg) {
    const le = getLE();
    if (le && le.status) le.status(msg);
  }

  function emit(kind, payload) {
    state.listeners.forEach(function (fn) {
      try { fn(kind, payload); } catch (err) { console.error(err); }
    });
  }

  /* ------------------------------------------------------------------ *
   * 录制
   * ------------------------------------------------------------------ */

  function currentCamera() {
    const le = getLE();
    if (!le || !le.viewer) return null;
    const c = le.viewer.camera;
    const pos = c.positionCartographic;
    if (!pos) return null;
    return {
      lon: C.Math.toDegrees(pos.longitude),
      lat: C.Math.toDegrees(pos.latitude),
      height: Math.max(1, pos.height),
      heading: C.Math.toDegrees(c.heading),
      pitch: C.Math.toDegrees(c.pitch),
      roll: C.Math.toDegrees(c.roll),
    };
  }

  function newTour(name) {
    state.tour = { version: T.VERSION, name: name || '未命名航线', keyframes: [] };
    emit('tour', { tour: state.tour });
    return state.tour;
  }

  function ensureTour() {
    if (!state.tour) newTour();
    return state.tour;
  }

  /**
   * 把当前相机位置录成关键帧。
   *
   * 【duration 的约定（重要，别改乱）】
   *   frames[i].duration = 「从第 i 帧飞到第 i+1 帧要几秒」。
   *   所以**最后一帧**的 duration 是「待定值」——
   *   它等于将来从最后一帧飞到下一站要用的秒数。
   *   录新的一站时：
   *     · 刚形成的这一段（倒数第二帧 → 新帧）用 opts.duration；
   *     · 新帧自己的 duration 设为「下一段」的待定值（默认 4 秒）。
   *   总时长 tourDuration() 只累加到倒数第二帧，所以待定值不影响总长。
   *
   * @param {object} opts {name, duration} duration = 刚录的这一段用几秒
   */
  function addKeyframe(opts) {
    opts = opts || {};
    const cam = currentCamera();
    if (!cam) { toast('无法读取当前相机位置', 'error'); return null; }
    const tour = ensureTour();
    const seg = opts.duration != null ? Number(opts.duration) : 4;
    const raw = T.buildKeyframes(tour, cam, { name: opts.name, duration: seg });
    const norm = T.normalizeTour(raw);
    if (!norm.ok) { toast('录制失败：' + norm.error, 'error'); return null; }
    const frames = norm.tour.keyframes;
    // 刚形成的这一段用 seg
    if (frames.length >= 2) frames[frames.length - 2].duration = seg;
    // 新帧自己的 duration = 下一段的待定值
    frames[frames.length - 1].duration = 4;
    state.tour = norm.tour;
    emit('tour', { tour: state.tour });
    return frames[frames.length - 1];
  }

  function removeKeyframe(i) {
    if (!state.tour) return false;
    const frames = state.tour.keyframes;
    if (i < 0 || i >= frames.length) return false;
    frames.splice(i, 1);
    // 删掉之后，新的一组末尾需要一个新的「待定值」
    // （下一段从最后一帧飞到将来新录的一站，用几秒）。
    if (frames.length) frames[frames.length - 1].duration = 4;
    emit('tour', { tour: state.tour });
    return true;
  }

  /**
   * 改某一站「飞到它要几秒」。
   * 关键帧的 duration 语义是「**到下一站**的秒数」，
   * 所以改第 i 站的时长 = 改 i→i+1 这一段。
   *
   * 最后一站没有「下一段」，但它的 duration 是**待定值** ——
   * 将来从它飞到新录的一站要用几秒。所以这里允许改最后一站，
   * 它不会计入当前总时长（tourDuration 只累加到倒数第二帧）。
   */
  function setDuration(i, seconds) {
    if (!state.tour) return false;
    const frames = state.tour.keyframes;
    if (i < 0 || i >= frames.length) return false;
    const n = Number(seconds);
    if (!isFinite(n) || n <= 0) return false;
    frames[i].duration = n;
    emit('tour', { tour: state.tour });
    return true;
  }

  function clear() {
    stop();
    state.tour = null;
    emit('tour', { tour: null });
  }

  /* ------------------------------------------------------------------ *
   * 载入 / 保存
   * ------------------------------------------------------------------ */

  function load(text) {
    const r = T.parseTour(text);
    if (!r.ok) {
      toast('航线文件读取失败：' + r.error, 'error', 5000);
      return null;
    }
    state.tour = r.tour;
    if (r.tour.skipped && r.tour.skipped.length) {
      toast('已跳过 ' + r.tour.skipped.length + ' 个无效关键帧', 'error', 4500);
    }
    emit('tour', { tour: state.tour });
    toast('已载入航线：' + state.tour.name + '（' + state.tour.keyframes.length + ' 站）', 'ok', 3600);
    return state.tour;
  }

  function save() {
    if (!state.tour) return null;
    return T.serializeTour(state.tour);
  }

  /* ------------------------------------------------------------------ *
   * 播放
   * ------------------------------------------------------------------ */

  /**
   * 逐帧驱动相机。
   *
   * 【为什么不用 camera.flyTo 串起来】
   *   flyTo 是「飞过去」，每一段都要等上一段结束，而且不能中途改变节奏。
   *   电影运镜要的是**一条连续曲线**，用 setView 跟着样条走才对。
   */
  function tick() {
    const le = getLE();
    if (!state.playing || !state.tour) return;
    const frames = state.tour.keyframes;
    const total = T.tourDuration(frames);
    const now = performance.now();
    const t = state.startT + (now - state.startedAt) / 1000;

    if (t >= total) {
      applyCamera(T.cameraAt(frames, total));
      stop();
      emit('time', { t: total, done: true });
      emit('play', { playing: false });
      return;
    }
    applyCamera(T.cameraAt(frames, t));
    state.t = t;
    emit('time', { t: t, done: false });
    state.raf = requestAnimationFrame(tick);
  }

  function applyCamera(c) {
    if (!c) return;
    const le = getLE();
    if (!le || !le.viewer) return;
    le.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(c.lon, c.lat, c.height),
      orientation: {
        heading: C.Math.toRadians(c.heading),
        pitch: C.Math.toRadians(c.pitch),
        roll: C.Math.toRadians(c.roll || 0),
      },
    });
  }

  function play() {
    if (state.playing) return;
    if (!state.tour || state.tour.keyframes.length < 2) {
      toast('航线至少需要 2 个关键帧', 'error');
      return;
    }
    const total = T.tourDuration(state.tour.keyframes);
    if (total <= 0) {
      toast('航线总时长为 0，请设置每段的秒数', 'error');
      return;
    }
    state.playing = true;
    state.startedAt = performance.now();
    state.startT = 0;
    state.raf = requestAnimationFrame(tick);
    emit('play', { playing: true });
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    emit('play', { playing: false });
  }

  function stop() {
    pause();
    state.t = 0;
    emit('time', { t: 0, done: false });
  }

  /** 跳到某个时间点。 */
  function seek(t) {
    if (!state.tour) return null;
    const total = T.tourDuration(state.tour.keyframes);
    const tt = Math.max(0, Math.min(total, Number(t) || 0));
    state.t = tt;
    if (state.playing) {
      state.startedAt = performance.now();
      state.startT = tt;
    }
    applyCamera(T.cameraAt(state.tour.keyframes, tt));
    emit('time', { t: tt, done: false });
    return tt;
  }

  /* ------------------------------------------------------------------ *
   * 导出 HTML 播放器
   * ------------------------------------------------------------------ */

  /**
   * 生成零依赖的单文件 HTML 播放器。
   *
   * 【为什么自己写播放器而不是嵌 Cesium】
   *   1) 离线要求：导出的文件不能引用 CDN；
   *   2) 体积：整个 Cesium 压缩后好几 MB，导出一个几十 KB 的小文件更实用；
   *   3) 足够：Tour 只需要「相机沿轨迹运动」，用 WebGL 画个地球球就够了，
   *      不需要地形、影像瓦片那些重家伙。
   *
   * 轨迹点已经在服务端（浏览器内）烘成密集采样点，直接内嵌进 HTML。
   */
  function exportHtml(opts) {
    opts = opts || {};
    if (!state.tour || state.tour.keyframes.length < 2) {
      throw new Error('航线至少需要 2 个关键帧才能导出');
    }
    const frames = state.tour.keyframes;
    const total = T.tourDuration(frames);
    const samples = T.sampleTour(frames, opts.step || 0.05);
    const title = opts.title || state.tour.name || '我的航线';
    const list = [];
    samples.forEach(function (s) {
      list.push([round(s.t, 3), round(s.lon, 6), round(s.lat, 6),
                 round(s.height, 1), round(s.heading, 2), round(s.pitch, 2)]);
    });
    const payload = JSON.stringify(list);
    const html = buildPlayerHtml(title, payload, total, frames.map(function (f) {
      return { name: f.name, lon: f.lon, lat: f.lat, height: f.height, heading: f.heading, pitch: f.pitch };
    }));
    return { html: html, bytes: html.length, samples: samples.length, duration: total };
  }

  function round(n, d) {
    const v = Number(n);
    if (!isFinite(v)) return 0;
    const p = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * p) / p;
  }

  function buildPlayerHtml(title, payload, total, stops) {
    const stopsJson = JSON.stringify(stops || []);
    // 注意：下面整段脚本是**字符串模板**，不要用 ${} 插值 JS 代码 ——
    // 播放器的 JS 是要原样落进导出文件的。
    return [
'<!DOCTYPE html>',
'<html lang="zh-CN"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>' + escapeHtml(title) + '</title>',
'<style>',
'  html,body{margin:0;height:100%;background:#05080b;color:#cfd8e3;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;overflow:hidden}',
'  canvas{display:block;width:100%;height:100%}',
'  #hud{position:fixed;left:0;right:0;top:0;padding:10px 14px;background:linear-gradient(#05080bee,#05080b00);',
'       display:flex;gap:14px;align-items:center;pointer-events:none;flex-wrap:wrap}',
'  #title{font-weight:600;color:#fff;font-size:15px}',
'  #info{color:#8fa3b8;font-variant-numeric:tabular-nums}',
'  #ctl{position:fixed;left:0;right:0;bottom:0;padding:10px 14px;background:linear-gradient(#05080b00,#05080bcc);',
'       display:flex;gap:10px;align-items:center}',
'  button{background:#16212c;color:#cfd8e3;border:1px solid #2a3948;border-radius:4px;padding:4px 12px;cursor:pointer;font:inherit}',
'  button:hover{background:#1e2a34;color:#fff}',
'  #bar{flex:1;accent-color:#e8892f}',
'  #clock{color:#8fa3b8;font-variant-numeric:tabular-nums;min-width:96px;text-align:right}',
'  #hint{position:fixed;right:14px;top:46px;color:#6f8296;font-size:11px;text-align:right}',
'</style></head><body>',
'<canvas id="cv"></canvas>',
'<div id="hud"><span id="title">' + escapeHtml(title) + '</span><span id="info"></span></div>',
'<div id="hint">拖动 = 旋转视角 · 滚轮 = 缩放 · 空格 = 播放/暂停</div>',
'<div id="ctl">',
'  <button id="play">▶ 播放</button>',
'  <input id="bar" type="range" min="0" max="1000" value="0">',
'  <span id="clock">0.0 / ' + round(total, 1) + ' s</span>',
'</div>',
'<script>',
'(function(){',
'  "use strict";',
'  var P = ' + payload + ';          // [t, lon, lat, height, heading, pitch]',
'  var STOPS = ' + stopsJson + ';',
'  var TOTAL = ' + round(total, 3) + ';',
'  var cv = document.getElementById("cv"), ctx = cv.getContext("2d");',
'  var bar = document.getElementById("bar"), clock = document.getElementById("clock"),',
'      info = document.getElementById("info"), playBtn = document.getElementById("play");',
'  var playing = false, t = 0, last = 0;',
'  var yaw = 0, pitch = -0.6, dist = 3.0, dragging = false, lx = 0, ly = 0;',
'  var R = 6371000;',
'',
'  function resize(){ cv.width = cv.width; }',
'  function fit(){ cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }',
'  addEventListener("resize", fit); fit();',
'',
'  function sample(tt){',
'    if (!P.length) return [0,0,0,0,0,-1];',
'    if (tt <= P[0][0]) return P[0].slice(1);',
'    if (tt >= P[P.length-1][0]) return P[P.length-1].slice(1);',
'    var lo = 0, hi = P.length-1;',
'    while (hi - lo > 1){ var mid = (lo+hi)>>1; if (P[mid][0] <= tt) lo = mid; else hi = mid; }',
'    var a = P[lo], b = P[hi];',
'    var span = b[0]-a[0];',
'    var u = span > 0 ? (tt-a[0])/span : 0;',
'    // 【索引必须对齐】',
'    //   P 的每项是 [t, lon, lat, height, heading, pitch]，共 6 个；',
'    //   slice(1) 之后是 [lon, lat, height, heading, pitch]，共 5 个。',
'    //   所以 heading 是 s[3]、pitch 是 s[4] —— 早先写成 s[4]/s[5] 时',
'    //   s[5] 是 undefined，NaN 一路传到 createRadialGradient，',
'    //   直接把整个 draw() 打死，播放器一片黑。',
'    return [ a[1]+(b[1]-a[1])*u, a[2]+(b[2]-a[2])*u, a[3]+(b[3]-a[3])*u,',
'             a[4]+(b[4]-a[4])*u, a[5]+(b[5]-a[5])*u ];',
'  }',
'',
'  // 方位角差（度，带符号，落在 -180..180）',
'  function angDiff(a,b){ var d = (a-b+540)%360-180; return d; }',
'',
'  // 【视线朝向跟着航迹走，而不是死用关键帧里的 heading】',
'  //   关键帧的 heading 是用户自己填的，可能和航线实际前进方向差得很远',
'  //   （比如先往西南飞、再掉头回东北）。死用 heading 的话，',
'  //   轨迹和站点会被甩到画面外，播放器看着像空转。',
'  //   做法：看向「前方 2.5 秒处」的那个采样点，永远把航迹放在画面里。',
'  function bearingTo(lon1,lat1,lon2,lat2){',
'    var p1 = lat1*Math.PI/180, p2 = lat2*Math.PI/180, dl = (lon2-lon1)*Math.PI/180;',
'    var y = Math.sin(dl)*Math.cos(p2);',
'    var x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);',
'    return (Math.atan2(y,x)*180/Math.PI+360)%360;',
'  }',
'  function viewHeading(lon, lat, tt){',
'    var ahead = sample(tt + 2.5);',
'    if (!ahead) return 0;',
'    var dLon = ahead[0]-lon, dLat = ahead[1]-lat;',
'    // 就在原地（航线首尾重合）就没方向可言，随便朝北',
'    if (Math.abs(dLon) < 1e-7 && Math.abs(dLat) < 1e-7) return 0;',
'    return bearingTo(lon, lat, ahead[0], ahead[1]);',
'  }',
'',
'  function draw(){',
'    var s = sample(t);',
'    var lon = s[0], lat = s[1], h = Math.max(200, s[2]);',
'    // 相机位置：球面之上抬高 h 米（跟真实飞行一致），',
'    // 否则脚下那一站正好落在相机平面上，会被 z<=1 的剔除条件丢掉。',
'    var phi = lat*Math.PI/180, lam = lon*Math.PI/180;',
'    var upx = Math.cos(phi)*Math.cos(lam), upy = Math.cos(phi)*Math.sin(lam), upz = Math.sin(phi);',
'    var cx = (R+h)*upx, cy = (R+h)*upy, cz = (R+h)*upz;',
'    // 视线方向（heading/pitch）',
'    var hd = viewHeading(lon, lat, t)*Math.PI/180;',
'    var ptDeg = s[4]; if (ptDeg > -5) ptDeg = -15; if (ptDeg < -70) ptDeg = -70;',
'    var pt = ptDeg*Math.PI/180;',
'    var fwd = [Math.cos(pt)*Math.sin(hd), Math.cos(pt)*Math.cos(hd), Math.sin(pt)];',
'    // 东/北/上 三个基向量',
'    var east = [-Math.sin(lam), Math.cos(lam), 0];',
'    var north = [-Math.sin(phi)*Math.cos(lam), -Math.sin(phi)*Math.sin(lam), Math.cos(phi)];',
'    var up = [Math.cos(phi)*Math.cos(lam), Math.cos(phi)*Math.sin(lam), Math.sin(phi)];',
'    function basis(){',
'      // 把视线向量投影到该点的东/北/上坐标系',
'      var e = fwd[0]*east[0]+fwd[1]*east[1]+fwd[2]*east[2];',
'      var n = fwd[0]*north[0]+fwd[1]*north[1]+fwd[2]*north[2];',
'      var u = fwd[0]*up[0]+fwd[1]*up[1]+fwd[2]*up[2];',
'      return [e,n,u];',
'    }',
'    var b = basis();',
'    // 视线方向（世界系）',
'    var dir = [ east[0]*b[0]+north[0]*b[1]+up[0]*b[2],',
'                east[1]*b[0]+north[1]*b[1]+up[1]*b[2],',
'                east[2]*b[0]+north[2]*b[1]+up[2]*b[2] ];',
'    var dl = Math.hypot(dir[0],dir[1],dir[2]) || 1;',
'    dir = [dir[0]/dl, dir[1]/dl, dir[2]/dl];',
'    // 侧向 = dir × up',
'    var side = [ dir[1]*up[2]-dir[2]*up[1], dir[2]*up[0]-dir[0]*up[2], dir[0]*up[1]-dir[1]*up[0] ];',
'    var sl = Math.hypot(side[0],side[1],side[2]) || 1;',
'    side = [side[0]/sl, side[1]/sl, side[2]/sl];',
'    var realUp = [ side[1]*dir[2]-side[2]*dir[1], side[2]*dir[0]-side[0]*dir[2], side[0]*dir[1]-side[1]*dir[0] ];',
'    var W = cv.width, H = cv.height, F = Math.min(W,H) * 0.5;',
'    function proj(p){',
'      var d = p[0]-cx, e = p[1]-cy, f = p[2]-cz;',
'      var z = d*dir[0]+e*dir[1]+f*dir[2];',
'      if (z <= 1) return null;',
'      var x = d*side[0]+e*side[1]+f*side[2];',
'      var y = d*realUp[0]+e*realUp[1]+f*realUp[2];',
'      return [ W/2 + x/z*F, H/2 - y/z*F, z ];',
'    }',
'    ctx.fillStyle = "#05080b"; ctx.fillRect(0,0,W,H);',
'    // 地球（外圈高光 + 网格）',
'    var c0 = proj([0,0,0]);',
'    if (c0){',
'      var rad = F * R / Math.max(1,c0[2]);',
'      var g = ctx.createRadialGradient(c0[0]-rad*0.3, c0[1]-rad*0.3, rad*0.1, c0[0], c0[1], rad);',
'      g.addColorStop(0, "#1d3550"); g.addColorStop(1, "#0b1622");',
'      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c0[0], c0[1], rad, 0, 7); ctx.fill();',
'      ctx.strokeStyle = "rgba(120,160,200,.18)"; ctx.lineWidth = 1 * devicePixelRatio;',
'      ctx.beginPath(); ctx.arc(c0[0], c0[1], rad, 0, 7); ctx.stroke();',
'      // 经纬网',
'      ctx.strokeStyle = "rgba(120,160,200,.10)";',
'      for (var k=-60;k<=60;k+=30){',
'        var pa=[], pb=[];',
'        for (var q=0;q<=36;q++){',
'          var la = k*Math.PI/180, lo2 = q*Math.PI*2/36;',
'          pa.push(proj([R*Math.cos(la)*Math.cos(lo2), R*Math.cos(la)*Math.sin(lo2), R*Math.sin(la)]));',
'        }',
'        ctx.beginPath();',
'        for (var i2=0;i2<pa.length;i2++){ if(!pa[i2]) continue;',
'          if(i2===0) ctx.moveTo(pa[i2][0],pa[i2][1]); else ctx.lineTo(pa[i2][0],pa[i2][1]); }',
'        ctx.stroke();',
'      }',
'      // 轨迹',
'      ctx.strokeStyle = "#e8892f"; ctx.lineWidth = 2 * devicePixelRatio;',
'      ctx.beginPath();',
'      var started = false;',
'      for (var j=0;j<P.length;j++){',
'        var pp = sample(P[j][0]);',
'        var la2 = pp[1]*Math.PI/180, lo3 = pp[0]*Math.PI/180;',
'        var pt2 = proj([R*Math.cos(la2)*Math.cos(lo3), R*Math.cos(la2)*Math.sin(lo3), R*Math.sin(la2)]);',
'        if(!pt2) continue;',
'        if(!started){ ctx.moveTo(pt2[0],pt2[1]); started=true; } else ctx.lineTo(pt2[0],pt2[1]);',
'      }',
'      ctx.stroke();',
'      // 站点',
'      for (var m=0;m<STOPS.length;m++){',
'        var sp = STOPS[m];',
'        var la3 = sp.lat*Math.PI/180, lo4 = sp.lon*Math.PI/180;',
'        var ps = proj([R*Math.cos(la3)*Math.cos(lo4), R*Math.cos(la3)*Math.sin(lo4), R*Math.sin(la3)]);',
'        if(!ps) continue;',
'        ctx.fillStyle = "#6fd6b4"; ctx.beginPath();',
'        ctx.arc(ps[0], ps[1], 3.5*devicePixelRatio, 0, 7); ctx.fill();',
'      }',
'      // 当前点',
'      var pc = proj([cx,cy,cz]);',
'      if(pc){ ctx.fillStyle = "#ffb454"; ctx.beginPath();',
'        ctx.arc(pc[0], pc[1], 5*devicePixelRatio, 0, 7); ctx.fill(); }',
'    }',
'    info.textContent = lon.toFixed(4)+", "+lat.toFixed(4)+"  "+Math.round(h)+" m";',
'    clock.textContent = t.toFixed(1)+" / "+TOTAL.toFixed(1)+" s";',
'    bar.value = String(TOTAL>0 ? Math.round(t/TOTAL*1000) : 0);',
'    requestAnimationFrame(draw);',
'  }',
'',
'  function loop(ts){',
'    if(!playing) return;',
'    if(!last) last = ts;',
'    var dt = (ts-last)/1000; last = ts;',
'    t += dt;',
'    if(t >= TOTAL){ t = TOTAL; playing=false; playBtn.textContent="▶ 播放"; }',
'    requestAnimationFrame(loop);',
'  }',
'  playBtn.addEventListener("click", function(){',
'    if(playing){ playing=false; playBtn.textContent="▶ 播放"; return; }',
'    if(t >= TOTAL) t = 0;',
'    playing = true; playBtn.textContent="⏸ 暂停"; last = 0; requestAnimationFrame(loop);',
'  });',
'  bar.addEventListener("input", function(){',
'    t = TOTAL * (Number(bar.value)/1000); playing=false; playBtn.textContent="▶ 播放";',
'  });',
'  cv.addEventListener("pointerdown", function(e){ dragging=true; lx=e.clientX; ly=e.clientY; });',
'  addEventListener("pointerup", function(){ dragging=false; });',
'  addEventListener("pointermove", function(e){',
'    if(!dragging) return;',
'    yaw -= (e.clientX-lx)*0.004; pitch -= (e.clientY-ly)*0.004;',
'    pitch = Math.max(-1.5, Math.min(1.5, pitch));',
'    lx=e.clientX; ly=e.clientY;',
'  });',
'  cv.addEventListener("wheel", function(e){ dist *= (1 + e.deltaY*0.001);',
'    dist = Math.max(1.05, Math.min(20, dist)); e.preventDefault(); }, {passive:false});',
'  addEventListener("keydown", function(e){',
'    if(e.code === "Space"){ e.preventDefault(); playBtn.click(); }',
'  });',
'  draw();',
'})();',
'</script></body></html>',
    ].join('\n');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  function getState() {
    const tour = state.tour;
    const total = tour ? T.tourDuration(tour.keyframes) : 0;
    return {
      hasTour: !!tour,
      name: tour ? tour.name : null,
      count: tour ? tour.keyframes.length : 0,
      duration: total,
      playing: state.playing,
      t: state.t,
      fov: tour && tour.fov != null ? tour.fov : null,
      keyframes: tour ? tour.keyframes.map(function (k) {
        return { name: k.name, lon: k.lon, lat: k.lat, height: k.height,
                 heading: k.heading, pitch: k.pitch, roll: k.roll || 0,
                 duration: k.duration };
      }) : [],
    };
  }

  function init(le) {
    state.le = le || window.LE;
    if (state.listenersBound) return;
    state.listenersBound = true;
    // 【不要在这里再订阅自己的 on】
    //   state.listeners 就是 emit 的分发目标；在 init 里再 shell.on(...) 注册一个
    //   转发函数，等于让 emit('tour') 调用自己 → 无限递归 → 爆栈。
    //   事件本来就由本模块的 emit 发出，界面直接订阅即可。
  }

  window.LETourShell = {
    init: init,
    newTour: newTour,
    addKeyframe: addKeyframe,
    removeKeyframe: removeKeyframe,
    setDuration: setDuration,
    clear: clear,
    load: load,
    save: save,
    play: play,
    pause: pause,
    stop: stop,
    seek: seek,
    exportHtml: exportHtml,
    currentCamera: currentCamera,
    getState: getState,
    on: function (fn) { state.listeners.push(fn); return fn; },
    off: function (fn) {
      const i = state.listeners.indexOf(fn);
      if (i >= 0) state.listeners.splice(i, 1);
    },
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

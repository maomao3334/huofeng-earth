/*
 * 在线 / 离线工作模式（P3-4.17 配套 UI 优化）
 * ---------------------------------------------------------------------------
 * 用户的诉求：**离线使用和联网使用可以自己选择**。
 *
 * 所以「左上角那个徽章」不只是个指示灯，而是一个**开关**：
 *   - 「离线」= 纯本机模式：底图、全国 DEM、地名、影像瓦片、分析引擎
 *     全部走本地磁盘，**一个字节都不出网**。这是本软件的默认状态。
 *   - 「在线」= 允许联网补充：底图可用在线瓦片、卫星影像可以拉到
 *     本机 EOX Sentinel-2 cloudless 的更高层级、地名可查在线服务、
 *     大 DEM / 影像可以按需下载入本地仓库。
 *
 * 三种状态：
 *   auto（自动）—— 按实际连通性自动切：能连上就联网，连不上就离线；
 *   offline（离线）—— 强制离线，用户选了就绝不联网；
 *   online（在线）—— 强制在线，用户选了就允许联网（探测失败也只是
 *     提示「网络不通」，不会偷偷降级）。
 *
 * 模式用 localStorage 记住（键 `le.netmode`），下次启动沿用。
 * 切换时会派发事件，让依赖它的模块（影像层、地名检索等）跟着变。
 *
 * 「在线」模式怎么真的用到网络：
 *   · 卫星影像层改用在线 WMTS 瓦片源（EOX Sentinel-2 cloudless，
 *     CC BY 4.0），覆盖面是全球、层级到 z14+，比本地那三级缓存大得多；
 *   · 底图可切到在线高分辨率影像；
 *   · 两种方式都受本软件 CSP 约束，需要把对应域名加进 img-src / connect-src。
 *
 * 对外 API（window.LEOnlineStatus）：
 *   init() / refresh() / isOnline() / isKnown() / onChange(fn)
 *   getMode() / setMode(m) / modes()
 *   canUseNetwork()      当前是否允许联网
 *   setProbeUrl(url)
 */
(function () {
  'use strict';

  const PROBE_TIMEOUT = 3500;
  const STORAGE_KEY = 'le.netmode';
  const MODES = [
    { id: 'auto', name: '自动', desc: '按实际连通性自动切换' },
    { id: 'offline', name: '离线', desc: '强制只用本机数据，绝不联网' },
    { id: 'online', name: '在线', desc: '允许联网补充影像与底图' },
  ];

  const state = {
    el: null,
    mode: 'auto',
    online: false,       // 实际探测到的连通性
    known: false,
    listeners: [],
    probing: false,
    timer: null,
    bound: false,
    probeUrls: [],
  };

  function byId(id) { return document.getElementById(id); }

  function readMode() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'offline' || v === 'online' || v === 'auto') return v;
    } catch (e) { /* ignore */ }
    return 'offline';
  }

  function writeMode(m) {
    try { localStorage.setItem(STORAGE_KEY, m); } catch (e) { /* ignore */ }
  }

  // 模块一加载就把模式读出来（脚本在 </body> 前，DOM 已就绪），
  // 这样即使外部还没调 init()，getMode() / 徽章文案也是对的。
  state.mode = readMode();

  /** 徽章显示的文案：强制模式优先显示用户的选择，自动模式显示实际状态。 */
  function badgeText() {
    if (state.mode === 'offline') return '离线';
    if (state.mode === 'online') return '在线';
    return state.known ? (state.online ? '在线' : '离线') : '检测中';
  }

  function badgeClass() {
    if (state.mode === 'offline') return 'is-offline';
    if (state.mode === 'online') return 'is-online';
    if (!state.known) return 'is-checking';
    return state.online ? 'is-online' : 'is-offline';
  }

  function badgeTitle() {
    if (state.mode === 'offline') {
      return '工作模式：离线（强制）。全部数据走本机，不会发起任何网络请求。点击可切换。';
    }
    if (state.mode === 'online') {
      return '工作模式：在线（强制）。允许使用在线影像与底图；本地数据仍然优先。点击可切换。';
    }
    return state.online
      ? '工作模式：自动。当前设备可访问互联网。点击可改为「强制离线」或「强制在线」。'
      : '工作模式：自动。当前设备无法访问互联网。点击可改为「强制在线」或「强制离线」。';
  }

  function renderBadge() {
    const el = state.el;
    if (!el) return;
    el.textContent = badgeText();
    el.className = 'offline-badge ' + badgeClass();
    el.title = badgeTitle();
    el.setAttribute('data-mode', state.mode);
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', '网络工作模式：' + badgeText());
  }

  function notify() {
    renderBadge();
    for (const fn of state.listeners) {
      try { fn(state.online, state.mode); } catch (err) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ 探测 */

  function headOk(url) {
    if (!url) return Promise.resolve(false);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, PROBE_TIMEOUT);
    return fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) { return !!(r && (r.ok || r.type === 'opaque' || r.status === 204)); })
      .catch(function () { return false; })
      .then(function (ok) { clearTimeout(timer); return ok; });
  }

  function headOkAny(urls) {
    if (!urls || !urls.length) return Promise.resolve(false);
    return urls.reduce(function (chain, u) {
      return chain.then(function (done) {
        return done ? true : headOk(u);
      });
    }, Promise.resolve(false));
  }

  /**
   * 连通性探测。
   * 优先问本机服务器（/api/net/probe，由 serve.ps1 代为对外 HEAD）——
   * 因为浏览器的 CSP 会挡住页面直连外网，本机服务器不受这个限制。
   * 探不到就退回 navigator.onLine。
   */
  function probe() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.resolve(false);
    }
    const api = '/api/net/probe?t=' + Date.now();
    return fetch(api, { method: 'GET', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        if (j && typeof j.online === 'boolean') return j.online;
        // 本机没有这个接口（老版本 serve.ps1）：退回同源探测
        const selfUrl = location.origin + '/index.html?_ping=' + Date.now();
        return headOk(selfUrl).then(function (selfOk) {
          if (!selfOk) return false;
          return headOkAny(state.probeUrls);
        });
      });
  }

  function refresh() {
    if (state.probing) return Promise.resolve(state.online);
    state.probing = true;
    return probe().then(function (online) {
      state.probing = false;
      const changed = !state.known || state.online !== online;
      state.online = !!online;
      state.known = true;
      if (changed) notify();
      else renderBadge();
      return state.online;
    });
  }

  /* ------------------------------------------------------------------ 模式 */

  function getMode() { return state.mode; }

  function setMode(m) {
    if (m !== 'auto' && m !== 'offline' && m !== 'online') {
      throw new Error('未知的工作模式：' + m);
    }
    const changed = state.mode !== m;
    state.mode = m;
    writeMode(m);
    if (changed) {
      notify();
      // 切到「在线」时立刻探一次，让用户马上看到真实连通性
      if (m === 'online') refresh();
    } else {
      renderBadge();
    }
    return state.mode;
  }

  /** 当前是否允许发起网络请求。 */
  function canUseNetwork() {
    if (state.mode === 'offline') return false;
    if (state.mode === 'online') return true;
    return state.known ? state.online : false;
  }

  /** 徽章点击 → 在三种模式里循环（离线 → 在线 → 自动）。 */
  function cycleMode() {
    const order = ['offline', 'online', 'auto'];
    const i = order.indexOf(state.mode);
    const next = order[(i + 1) % order.length];
    setMode(next);
    const le = window.LE;
    if (le && le.toast) {
      const def = MODES.find((x) => x.id === next);
      le.toast('工作模式：' + def.name + ' · ' + def.desc, 'ok', 3200);
    }
    return next;
  }

  function init() {
    state.el = byId('net-badge');
    state.mode = readMode();
    if (!state.el) return;
    renderBadge();
    // 防重复绑定（main.js 的 initModules 与页面早期调用都可能触发）
    if (state.bound) return;
    state.bound = true;
    state.el.addEventListener('click', cycleMode);    state.el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleMode(); }
    });
    window.addEventListener('online', function () { refresh(); });
    window.addEventListener('offline', function () {
      state.online = false; state.known = true; notify();
    });
    // 「离线」模式下完全不探测（保证一个请求都不发）
    if (state.mode !== 'offline') refresh();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (state.mode === 'offline') return;
      if (typeof document !== 'undefined' && document.hidden) return;
      refresh();
    }, 60000);
  }
  window.LEOnlineStatus = {
    init: init,
    refresh: refresh,
    isOnline: function () { return state.online; },
    isKnown: function () { return state.known; },
    onChange: function (fn) { if (typeof fn === 'function') state.listeners.push(fn); },
    getMode: getMode,
    setMode: setMode,
    cycleMode: cycleMode,
    modes: function () { return MODES.slice(); },
    canUseNetwork: canUseNetwork,
    setProbeUrl: function (url) { state.probeUrls = url ? [url] : []; },
    probeUrl: function () { return state.probeUrls[0] || ''; },
  };
})();

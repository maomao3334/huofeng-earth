/*
 * 左侧分类导航（rail + 快捷工具栏）
 * - 把原本需要滚动的长侧栏拆成 任务 / 数据 / 计算 / 工具 / 图层 / 设置 六个大类
 * - 顶部实用工具栏直接复用现有按钮，不改变原功能
 */
(function () {
  'use strict';

  var CATS = {
    task: { title: '任务', hint: '常用操作与成果' },
    data: { title: '数据', hint: '离线底图与本地影像' },
    compute: { title: '计算', hint: 'Wind3D 火场风场' },
    tools: { title: '工具', hint: '绘制、标点与测量' },
    layers: { title: '图层', hint: '可见性与排序' },
    settings: { title: '设置', hint: '诊断与系统' },
  };

  var active = 'task';
  var rail = [];
  var sections = [];

  function byId(id) { return document.getElementById(id); }

  function isAvailable(section) {
    if (!section) return false;
    if (section.id === 'local-imagery-section') {
      return section.getAttribute('data-available') === '1';
    }
    return true;
  }

  function updateTitle(cat) {
    var meta = CATS[cat] || CATS.task;
    var title = byId('side-panel-title');
    var hint = byId('side-panel-hint');
    if (title) title.textContent = meta.title;
    if (hint) hint.textContent = meta.hint;
  }

  function activate(cat, focusId) {
    if (!CATS[cat]) cat = 'task';
    active = cat;
    for (var i = 0; i < rail.length; i++) {
      var on = rail[i].getAttribute('data-cat') === cat;
      rail[i].classList.toggle('is-active', on);
      rail[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var visible = [];
    for (var j = 0; j < sections.length; j++) {
      var sec = sections[j];
      var show = sec.getAttribute('data-cat') === cat && isAvailable(sec);
      sec.hidden = !show;
      if (show) visible.push(sec);
    }
    var groups = document.querySelectorAll('.side-group');
    for (var g = 0; g < groups.length; g++) {
      groups[g].hidden = !groups[g].querySelector('.side-section[data-cat]:not([hidden])');
    }
    // 每个大类只默认展开第一块，减少滚动；用户仍可手动展开其它块
    for (var k = 0; k < visible.length; k++) {
      if (visible[k].tagName === 'DETAILS') visible[k].open = k === 0;
    }
    updateTitle(cat);
    var focus = cat === 'compute';
    document.body.classList.toggle('compute-focus', focus);
    if (focus) {
      window.setTimeout(function () {
        if (window.LEWind3dCompute && typeof window.LEWind3dCompute.fillFromView === 'function') {
          window.LEWind3dCompute.fillFromView();
        }
        if (window.LE && window.LE.viewer && window.LE.viewer.resize) window.LE.viewer.resize();
      }, 280);
    } else {
      window.setTimeout(function () {
        if (window.LE && window.LE.viewer && window.LE.viewer.resize) window.LE.viewer.resize();
      }, 280);
    }
    var scroll = byId('side-scroll');
    if (scroll) scroll.scrollTop = 0;
    if (focusId) {
      var target = byId(focusId);
      if (target) {
        if (target.tagName === 'DETAILS') target.open = true;
        if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
        var field = target.querySelector('input, button, select');
        if (field && field.focus) field.focus({ preventScroll: true });
      }
    }
  }

  function click(id) {
    var el = byId(id);
    if (el && !el.disabled) el.click();
  }

  function quick(action) {
    if (action === 'open') { click('btn-open'); return; }
    if (action === 'goto') { click('btn-goto'); return; }
    if (action === 'measure') { click('btn-measure-distance'); return; }
    if (action === 'draw') { activate('tools', 'draw-section'); window.setTimeout(function () { click('btn-draw-line'); }, 30); return; }
    if (action === 'wind') {
      activate('compute', 'wind3d-compute-section');
      window.setTimeout(function () {
        var dem = byId('w3d-dem');
        if (dem && dem.focus) dem.focus({ preventScroll: true });
      }, 60);
      return;
    }
    if (action === 'layers') { activate('layers', 'layers-section'); return; }
  }

  function init() {
    rail = Array.prototype.slice.call(document.querySelectorAll('#side-rail .rail-btn'));
    sections = Array.prototype.slice.call(document.querySelectorAll('.side-section[data-cat]'));
    for (var i = 0; i < rail.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { activate(btn.getAttribute('data-cat')); });
      })(rail[i]);
    }
    var quickBtns = document.querySelectorAll('#side-quickbar .quick-btn');
    for (var q = 0; q < quickBtns.length; q++) {
      (function (btn) {
        btn.addEventListener('click', function () { quick(btn.getAttribute('data-quick')); });
      })(quickBtns[q]);
    }
    activate(active);
  }

  window.LEsidebarNav = {
    activate: activate,
    refresh: function () { activate(active); },
    getActive: function () { return active; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

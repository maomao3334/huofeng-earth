/*
 * 界面字体大小：只改 UI 文字，不改地图渲染。
 * 值通过 html[data-ui-font] 控制 CSS 变量 --ui-font-scale。
 */
(function () {
  'use strict';

  var KEY = 'maomaoearth.uiFont';
  var SCALES = { small: 0.9, normal: 1, large: 1.12, xlarge: 1.24 };

  function apply(value) {
    if (!SCALES[value]) value = 'normal';
    document.documentElement.setAttribute('data-ui-font', value);
    var select = document.getElementById('ui-font-size');
    if (select) select.value = value;
    try { localStorage.setItem(KEY, value); } catch (e) { /* 忽略隐私模式 */ }
  }

  function init() {
    var saved = 'normal';
    try { saved = localStorage.getItem(KEY) || 'normal'; } catch (e) { /* 忽略 */ }
    apply(saved);
    var select = document.getElementById('ui-font-size');
    if (select) {
      select.addEventListener('change', function () { apply(select.value); });
    }
  }

  window.LEUiFont = {
    apply: apply,
    get: function () { return document.documentElement.getAttribute('data-ui-font') || 'normal'; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

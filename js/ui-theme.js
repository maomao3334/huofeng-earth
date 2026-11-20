/*
 * 界面主题：暗色（指挥）/ 亮色（消防红蓝）。
 * 通过 html[data-theme] 切换 CSS 变量，地图渲染不受影响。
 */
(function () {
  'use strict';

  var KEY = 'maomaoearth.uiTheme';

  function apply(value) {
    if (value !== 'light') value = 'dark';
    document.documentElement.setAttribute('data-theme', value);
    var select = document.getElementById('ui-theme');
    if (select) select.value = value;
    try { localStorage.setItem(KEY, value); } catch (e) { /* 隐私模式忽略 */ }
  }

  function init() {
    var saved = 'dark';
    try { saved = localStorage.getItem(KEY) || 'dark'; } catch (e) { /* 忽略 */ }
    apply(saved);
    var select = document.getElementById('ui-theme');
    if (select) {
      select.addEventListener('change', function () { apply(select.value); });
    }
  }

  window.LEUiTheme = {
    apply: apply,
    get: function () { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

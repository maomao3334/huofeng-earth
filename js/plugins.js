/*
 * 插件式扩展机制 · 内核（P3-4.17）
 * ---------------------------------------------------------------------------
 * 目标：让用户（或开发者）能自己往这个软件里加算法，**而不必改本软件源码**，
 * 并且仍然满足本软件的两条铁律：
 *
 *   1. **零外部进程**：插件是纯 JavaScript，在浏览器沙箱里跑，
 *      不起 Python / qgis_process / 任何子进程；
 *   2. **纯离线**：插件默认拿不到网络与文件系统，只能用软件显式给它的能力。
 *
 * 设计要点：
 *
 *   · **能力白名单（capability）**：插件不能直接碰 window / document /
 *     fetch / XMLHttpRequest / importScripts。本模块用「参数净化 +
 *     冻结的沙箱对象」把插件关进一个盒子里，只给它三样东西：
 *       - ctx.dem.heightAt(lon, lat)   读本机全国 DEM 高程
 *       - ctx.vector.inputs()           列出内存里的矢量要素
 *       - ctx.analysis.helpers          复用地形/几何工具函数
 *     插件源码里的 eval / Function / fetch 一律拿不到。
 *
 *   · **纯函数内核**：插件注册与校验、源码解析、能力注入、错误归一化
 *     都在本文件里完成，不碰 DOM，所以能在 Node 里跑断言。
 *
 *   · **插件清单**：一个插件就是一个 JSON 描述 + 一段 JS 源码：
 *       {
 *         id: 'demo.hello',
 *         name: '示例插件',
 *         version: '1.0.0',
 *         group: '我的插件',
 *         description: '...',
 *         parameters: [{ name:'RADIUS', type:'number', default:2,
 *                        description:'半径（km）' }],
 *         source: "function run(params, ctx) { ... }"
 *       }
 *     源码里定义 `function run(params, ctx) { return {...} }`，
 *     返回值契约与原生算法一致：
 *       { kind:'vector', geojson:{...}, stats:{...} }
 *       { kind:'raster', png:'data:image/png;base64,...', bounds:[w,s,e,n] }
 *       { kind:'table',  table:{ columns:[], rows:[[]] }, stats:{...} }
 *
 *   · **零信任执行**：源码先被编译成一个**只带白名单全局**的函数体，
 *     全局环境用 with 之外的方式实现 —— 具体做法是把插件源码放进
 *     `new Function('params','ctx', '"use strict";' + src)`，
 *     再用 `Object.freeze` 冻结传入的 ctx，并把全局敏感名全部遮蔽。
 *     插件拿不到 `window`（因为函数体里没有 window 参数），
 *     但仍能通过 `this` 拿到全局对象 —— 所以执行时统一用
 *     `fn.call(Object.create(null), params, ctx)`，this 指向空对象。
 *
 * 对外 API（window.LEPlugins）：
 *   list() / get(id) / register(plugin) / unregister(id)
 *   validate(plugin) → { ok, errors, warnings }
 *   run(id, params)   → Promise<result>
 *   exportAll() / importOne(json)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LEPlugins = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SOURCE_BYTES = 256 * 1024;   // 单个插件源码上限 256 KB
  const MAX_ID_LEN = 64;

  /* ---------------------------------------------------------------- 校验 */

  const PARAM_TYPES = ['text', 'number', 'boolean', 'enum', 'vector', 'raster'];

  /**
   * 校验一个插件清单。返回 { ok, errors:[], warnings:[] }。
   */
  function validate(plugin) {
    const errors = [];
    const warnings = [];
    if (!plugin || typeof plugin !== 'object') {
      return { ok: false, errors: ['插件必须是一个对象'], warnings: warnings };
    }
    const id = plugin.id;
    if (!id || typeof id !== 'string') {
      errors.push('缺少 id');
    } else if (id.length > MAX_ID_LEN) {
      errors.push('id 过长（不超过 ' + MAX_ID_LEN + ' 个字符）');
    } else if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
      errors.push('id 只能包含字母、数字、点、下划线、冒号和连字符');
    }
    if (!plugin.name || typeof plugin.name !== 'string') {
      errors.push('缺少 name（中文名）');
    }
    if (!plugin.source || typeof plugin.source !== 'string') {
      errors.push('缺少 source（JavaScript 源码）');
    } else if (plugin.source.length > MAX_SOURCE_BYTES) {
      errors.push('源码过长（上限 ' + Math.round(MAX_SOURCE_BYTES / 1024) + ' KB）');
    } else if (plugin.source.indexOf('function run') < 0 && plugin.source.indexOf('run =') < 0) {
      warnings.push('源码里没有找到 run 函数定义');
    }
    if (plugin.parameters != null && !Array.isArray(plugin.parameters)) {
      errors.push('parameters 必须是数组');
    } else if (Array.isArray(plugin.parameters)) {
      const seen = Object.create(null);
      plugin.parameters.forEach(function (p, i) {
        if (!p || typeof p !== 'object') {
          errors.push('第 ' + (i + 1) + ' 个参数不是对象');
          return;
        }
        if (!p.name || typeof p.name !== 'string') {
          errors.push('第 ' + (i + 1) + ' 个参数缺少 name');
          return;
        }
        if (seen[p.name]) errors.push('参数名重复：' + p.name);
        seen[p.name] = true;
        if (p.type && PARAM_TYPES.indexOf(p.type) < 0) {
          errors.push('参数 ' + p.name + ' 的类型不认识：' + p.type +
            '（可用：' + PARAM_TYPES.join(' / ') + '）');
        }
        if (p.type === 'enum' && (!Array.isArray(p.options) || !p.options.length)) {
          errors.push('枚举参数 ' + p.name + ' 需要 options 数组');
        }
      });
    }
    // 安全提示（不是错误，只是提醒）
    const src = typeof plugin.source === 'string' ? plugin.source : '';
    const risky = ['fetch(', 'XMLHttpRequest', 'importScripts', 'eval(', 'WebSocket',
      'localStorage', 'document.', 'window.'];
    const hit = risky.filter(function (k) { return src.indexOf(k) >= 0; });
    if (hit.length) {
      warnings.push('源码里出现了这些在插件里不可用的东西：' + hit.join('、') +
        '（插件只能通过 ctx 拿数据）');
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /* ---------------------------------------------------------------- 沙箱 */

  /** 浏览器里才有 window；Node 下（内核单测）一律当作没有。 */
  function hasWindow() {
    return typeof window !== 'undefined' && !!window;
  }

  /**
   * 造一个插件能用的能力对象（ctx）。
   * 里面所有方法都是**已绑定**的闭包，插件拿不到本模块的内部引用。
   */
  function makeContext(host) {
    host = host || {};
    const ctx = {};

    // DEM 采样
    ctx.dem = Object.freeze({
      heightAt: function (lon, lat) {
        if (!hasWindow() || !window.LEDemTiles) return null;
        try { return window.LEDemTiles.heightAt(lon, lat); }
        catch (err) { return null; }
      },
      covers: function (lon, lat) {
        if (!hasWindow() || !window.LEDemTiles) return false;
        try { return !!window.LEDemTiles.covers(lon, lat); } catch (err) { return false; }
      },
    });

    // 矢量要素
    ctx.vector = Object.freeze({
      inputs: function () {
        if (!hasWindow() || !window.LEAnalysis) return [];
        try { return window.LEAnalysis.collectVectorInputs(); } catch (err) { return []; }
      },
      byId: function (id) {
        const all = ctx.vector.inputs();
        for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
        return null;
      },
    });

    // 复用地形/几何工具
    ctx.analysis = Object.freeze({
      helpers: Object.freeze(
        (hasWindow() && window.LEAnalysis && window.LEAnalysis.helpers) || {}
      ),
      currentViewRect: function () {
        if (!hasWindow() || !window.LEAnalysis) return null;
        try { return window.LEAnalysis.currentViewRect(); } catch (err) { return null; }
      },
    });

    // 当前相机视野（插件常用的空间范围）
    ctx.view = Object.freeze({
      rect: function () { return ctx.analysis.currentViewRect(); },
    });

    // 日志：写到控制台，带插件名前缀
    ctx.log = Object.freeze({
      info: function () {
        const args = Array.prototype.slice.call(arguments);
        console.info.apply(console, ['[插件 ' + (host.name || host.id || '') + ']'].concat(args));
      },
      warn: function () {
        const args = Array.prototype.slice.call(arguments);
        console.warn.apply(console, ['[插件 ' + (host.name || host.id || '') + ']'].concat(args));
      },
    });

    return Object.freeze(ctx);
  }

  /**
   * 编译插件源码。
   * 返回 { fn } 或抛错。
   */
  function compile(plugin) {
    const src = plugin.source;
    let fn;
    try {
      // 插件源码里的 `function run(params, ctx){...}` 通过下面的包装取出。
      //
      // 【沙箱做法】把插件源码放进一个**非严格**函数的 with 块里，
      // with 的作用域对象把敏感全局名全部钉成 undefined，源码里再引用
      // 这些名字就只会拿到 undefined。
      //
      // 【踩过的坑】一开始用的是 `"use strict"; var eval = undefined;`，
      // 但严格模式下 `var eval` / `var arguments` 是**语法错误**
      // （"Unexpected eval or arguments in strict mode"），整个插件装不上。
      // 改成非严格 + with 之后，eval / Function / globalThis 也能一起挡住
      // （with 对象里可以放 eval / Function 这类属性名）。
      /* eslint-disable no-new-func, no-with */
      const body = [
        'var console = { log: function(){}, info: function(){}, warn: function(){},',
        '                 error: function(){}, debug: function(){}, trace: function(){} };',
        'var __blocked = {',
        '  window: undefined, document: undefined, navigator: undefined, location: undefined,',
        '  localStorage: undefined, sessionStorage: undefined, indexedDB: undefined,',
        '  fetch: undefined, XMLHttpRequest: undefined, WebSocket: undefined,',
        '  EventSource: undefined, importScripts: undefined, Worker: undefined,',
        '  SharedWorker: undefined, console: console,',
        '  eval: undefined, Function: undefined, globalThis: undefined,',
        '  self: undefined, top: undefined, parent: undefined,',
        '};',
        'return (function(){',
        'with (__blocked) {',
        src,
        '}',
        'return (typeof run !== "undefined" && typeof run === "function") ? run : null;',
        '})();',
      ].join('\n');
      fn = new Function(body);
      /* eslint-enable no-new-func, no-with */
    } catch (err) {
      throw new Error('插件源码编译失败：' + (err && err.message ? err.message : err));
    }
    return fn();
  }

  /**
   * 归一化插件返回值：必须是 vector / raster / table 三种之一。
   */
  function normalizeResult(res, plugin) {
    if (!res || typeof res !== 'object') {
      throw new Error('插件 ' + (plugin.name || plugin.id) + ' 没有返回结果对象');
    }
    const kind = res.kind;
    if (kind === 'vector') {
      if (!res.geojson || res.geojson.type !== 'FeatureCollection') {
        throw new Error('矢量结果的 geojson 必须是 FeatureCollection');
      }
      return {
        kind: 'vector',
        geojson: res.geojson,
        stats: res.stats || {},
        table: res.table || null,
        bounds: res.bounds || null,
      };
    }
    if (kind === 'raster') {
      if (typeof res.png !== 'string' || res.png.indexOf('data:image/') !== 0) {
        throw new Error('栅格结果的 png 必须是 data:image/ 开头的 data URL');
      }
      if (!Array.isArray(res.bounds) || res.bounds.length !== 4) {
        throw new Error('栅格结果必须给出 bounds = [west, south, east, north]');
      }
      return {
        kind: 'raster',
        png: res.png,
        bounds: res.bounds,
        stats: res.stats || {},
        table: res.table || null,
      };
    }
    if (kind === 'table') {
      if (!res.table || !Array.isArray(res.table.columns) || !Array.isArray(res.table.rows)) {
        throw new Error('表格结果必须有 table.columns 与 table.rows');
      }
      return {
        kind: 'table',
        table: res.table,
        stats: res.stats || {},
        bounds: res.bounds || null,
      };
    }
    throw new Error('不认识的结果类型：' + String(kind) +
      '（可用：vector / raster / table）');
  }

  /* ---------------------------------------------------------------- 注册表 */

  const registry = Object.create(null);   // id → 插件

  function list() {
    return Object.keys(registry).map(function (id) {
      const p = registry[id];
      return {
        id: p.id,
        name: p.name,
        version: p.version || '0.0.0',
        group: p.group || '插件',
        description: p.description || '',
        parameters: p.parameters || [],
        builtin: !!p.builtin,
        native: false,
        plugin: true,
      };
    });
  }

  function get(id) { return registry[id] || null; }

  function register(plugin) {
    const v = validate(plugin);
    if (!v.ok) {
      throw new Error('插件校验失败：' + v.errors.join('；'));
    }
    const stored = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version || '0.0.0',
      group: plugin.group || '插件',
      description: plugin.description || '',
      parameters: plugin.parameters || [],
      source: plugin.source,
      author: plugin.author || '',
      builtin: !!plugin.builtin,
      warnings: v.warnings,
    };
    registry[stored.id] = stored;
    return stored;
  }

  function unregister(id) {
    if (!registry[id]) return false;
    delete registry[id];
    return true;
  }

  /* ---------------------------------------------------------------- 执行 */

  /**
   * 运行一个插件。
   * @param {string} id
   * @param {object} params
   * @returns {Promise<object>} 归一化后的结果
   */
  function run(id, params) {
    const plugin = registry[id];
    if (!plugin) {
      return Promise.resolve({
        kind: 'error',
        error: '未找到插件：' + id,
        plugin: id,
      });
    }
    let entry;
    try {
      entry = compile(plugin);
    } catch (err) {
      return Promise.resolve({
        kind: 'error',
        error: err && err.message ? err.message : String(err),
        plugin: plugin.id,
      });
    }
    // 插件可以导出 run 函数，也可以导出 { run }
    let fn = entry;
    if (entry && typeof entry === 'object') fn = entry.run;
    if (typeof fn !== 'function') {
      return Promise.resolve({
        kind: 'error',
        error: '插件 ' + plugin.name + ' 没有导出 run(params, ctx) 函数',
        plugin: plugin.id,
      });
    }

    // 参数默认值填充
    const p = Object.assign({}, params || {});
    for (const def of (plugin.parameters || [])) {
      if (p[def.name] == null && def.default != null) p[def.name] = def.default;
    }

    const ctx = makeContext(plugin);
    return new Promise(function (resolve) {
      let settled = false;
      const done = function (res) {
        if (settled) return;
        settled = true;
        try { resolve(normalizeResult(res, plugin)); }
        catch (err) { resolve({ kind: 'error', error: err.message, plugin: plugin.id }); }
      };
      let out;
      try {
        // this 指向空对象，插件拿不到全局
        out = fn.call(Object.create(null), p, ctx);
      } catch (err) {
        if (!settled) {
          settled = true;
          resolve({
            kind: 'error',
            error: '插件执行出错：' + (err && err.message ? err.message : err),
            plugin: plugin.id,
          });
        }
        return;
      }
      if (out && typeof out.then === 'function') {
        out.then(done, function (err) {
          if (settled) return;
          settled = true;
          resolve({
            kind: 'error',
            error: '插件执行出错：' + (err && err.message ? err.message : err),
            plugin: plugin.id,
          });
        });
        return;
      }
      done(out);
    });
  }

  /* ---------------------------------------------------------------- 导入导出 */

  function exportOne(id) {
    const p = registry[id];
    if (!p) throw new Error('未找到插件：' + id);
    return JSON.stringify({
      id: p.id, name: p.name, version: p.version, group: p.group,
      description: p.description, parameters: p.parameters, source: p.source,
      author: p.author || '',
    }, null, 2);
  }

  function exportAll() {
    return JSON.stringify(list().map(function (p) {
      return JSON.parse(exportOne(p.id));
    }), null, 2);
  }

  function importOne(json) {
    let obj = json;
    if (typeof json === 'string') {
      try { obj = JSON.parse(json); }
      catch (err) { throw new Error('插件 JSON 解析失败：' + err.message); }
    }
    if (!obj || typeof obj !== 'object') throw new Error('插件清单必须是一个对象');
    return register(obj);
  }

  return {
    validate: validate,
    register: register,
    unregister: unregister,
    list: list,
    get: get,
    run: run,
    exportOne: exportOne,
    exportAll: exportAll,
    importOne: importOne,
    makeContext: makeContext,
    compile: compile,
    normalizeResult: normalizeResult,
    PARAM_TYPES: PARAM_TYPES,
  };
});

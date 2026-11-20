/*
 * 图层样式编辑器（js/layer-style.js）
 * ---------------------------------------------------------------------------
 * 补齐 QGIS 的「图层样式」能力：导入进来的图层不再是「一种颜色到底」，
 * 用户可以调：
 *
 *   影像层：透明度、亮度、对比度、饱和度、色相、伽马、混合模式、上下顺序
 *   矢量层：按字段分级配色 / 按字段渐变 / 按字段值过滤显示，
 *           线宽、点大小、填充透明度、描边色、标注字段
 *
 * 【为什么自己写而不引 QGIS】
 *   与 js/analysis.js 同一思路：Cesium 的 ImageryLayer 自带
 *   brightness / contrast / hue / saturation / gamma / alpha，
 *   直接赋值即可生效，**不需要任何外部进程**。
 *
 * 【样式存放】
 *   样式是「图层属性」，不是数据，所以**不落盘**到 data/local，
 *   只在运行期挂在图层 entry 上（entry.style）。
 *   需要持久化时由 js/project.js 负责（工程文件）。
 *
 * 对外 API（window.LELayerStyle）：
 *   init(le)
 *   styles(entry)             取某图层的当前样式
 *   apply(entry, patch)       应用样式补丁
 *   reset(entry)              恢复默认
 *   open(entry)               打开样式面板
 *   classify(entry, rule)     矢量分级渲染
 *   labelBy(entry, field)     矢量标注
 *   rules(entry)              读取规则
 *   setRule(entry, rule)      写入规则
 */
(function () {
  'use strict';

  const C = window.Cesium;

  const state = {
    le: null,
    panel: null,
    current: null,
  };

  /* ------------------------------------------------------------------ *
   * 默认样式
   * ------------------------------------------------------------------ */

  const DEFAULT_IMAGERY = {
    brightness: 1,
    contrast: 1,
    hue: 0,
    saturation: 1,
    gamma: 1,
    alpha: 1,
    blend: 'normal',
  };

  const DEFAULT_VECTOR = {
    pointSize: 9,
    pointColor: '#ffd166',
    lineWidth: 2.4,
    lineColor: '#6fd6b4',
    fillColor: '#4c9be8',
    fillAlpha: 0.32,
    strokeColor: null,
    strokeWidth: 2,
    labelField: null,
    labelSize: 13,
    labelColor: '#ffffff',
    labelOutline: '#10161c',
    minScale: null,
    maxScale: null,
    filter: null,
  };

  /** Cesium 支持的混合模式。 */
  const BLEND_MODES = [
    { value: 'normal', label: '正常' },
    { value: 'multiply', label: '正片叠底' },
    { value: 'screen', label: '滤色' },
    { value: 'overlay', label: '叠加' },
    { value: 'darken', label: '变暗' },
    { value: 'lighten', label: '变亮' },
    { value: 'color-dodge', label: '颜色减淡' },
    { value: 'color-burn', label: '颜色加深' },
    { value: 'hard-light', label: '强光' },
    { value: 'soft-light', label: '柔光' },
    { value: 'difference', label: '差值' },
    { value: 'exclusion', label: '排除' },
    { value: 'hue', label: '色相' },
    { value: 'saturation', label: '饱和度' },
    { value: 'color', label: '颜色' },
    { value: 'luminosity', label: '明度' },
  ];

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function byId(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clamp(n, lo, hi) {
    const v = Number(n);
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function toast(msg, kind, ms) {
    if (state.le && state.le.toast) state.le.toast(msg, kind || 'ok', ms || 3000);
  }

  function isImagery(entry) {
    return !!entry && (entry.type === 'imagery' || !!entry.imageryLayer);
  }

  function isVector(entry) {
    return !!entry && (entry.type === 'vector' || !!entry.datasource);
  }

  /** 取图层的样式对象（首次访问时建立默认值）。 */
  function styles(entry) {
    if (!entry) return null;
    if (!entry.style) {
      entry.style = isImagery(entry)
        ? Object.assign({}, DEFAULT_IMAGERY)
        : Object.assign({}, DEFAULT_VECTOR);
    }
    return entry.style;
  }

  /* ------------------------------------------------------------------ *
   * 规则内核（js/rule-style.js）
   * ------------------------------------------------------------------ */

  /** 取规则内核；未加载时降级为「不启用规则」。 */
  function kernel() {
    return window.LERuleStyle || null;
  }

  /**
   * 取要素的属性字典。
   *
   * Cesium 的 Entity.properties 是 PropertyBag（带 getValue），
   * 但 GeoJsonDataSource 直接塞的是裸对象——两种都要兼容。
   */
  function propsOf(entity) {
    if (!entity || !entity.properties) return {};
    const p = entity.properties;
    if (typeof p.getValue === 'function') {
      try {
        const now = window.LE && window.LE.viewer
          ? window.LE.viewer.clock.currentTime
          : undefined;
        const bag = p.getValue(now);
        if (bag) {
          const out = {};
          for (const k of Object.keys(bag)) {
            let v = bag[k];
            if (v && typeof v.getValue === 'function') v = v.getValue(now);
            out[k] = v;
          }
          return out;
        }
      } catch (err) {
        /* ignore */
      }
    }
    if (typeof p === 'object') return p;
    return {};
  }

  /* ------------------------------------------------------------------ *
   * 点符号：GeoJSON 的 Point 会被 Cesium 变成 billboard（带贴图），
   * 而 Cesium 原生 Entity 常用 point（点图形）。
   * 两种都要能上色 + 改大小，所以这里对 billboard 走「重绘贴图」的路子。
   * ------------------------------------------------------------------ */

  const pointImageCache = new Map();

  /**
   * 生成一个圆点贴图（canvas），按颜色 + 尺寸缓存。
   * GeoJSON 的点默认是一张固定颜色的图钉，不换掉就没法真正「按字段分色」。
   */
  function pointImage(color, size) {
    const key = color + '@' + size;
    const hit = pointImageCache.get(key);
    if (hit) return hit;
    const s = Math.max(4, Math.min(64, Math.round(size)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.ceil(s * dpr);
    const cv = document.createElement('canvas');
    cv.width = px;
    cv.height = px;
    const g = cv.getContext('2d');
    if (g) {
      g.scale(dpr, dpr);
      g.beginPath();
      g.arc(s / 2, s / 2, s / 2 - 1.2, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.stroke();
    }
    pointImageCache.set(key, cv);
    return cv;
  }

  /** 清掉点贴图缓存（配色变了要重画）。 */
  function clearPointImageCache() {
    pointImageCache.clear();
  }

  /* ------------------------------------------------------------------ *
   * 应用样式
   * ------------------------------------------------------------------ */

  /**
   * 应用样式补丁到图层。
   * @param {object} entry 图层条目
   * @param {object} patch { brightness, contrast, ..., alpha } 或矢量字段
   */
  function apply(entry, patch) {
    if (!entry || !patch) return null;
    const st = styles(entry);
    if (!st) return null;

    if (isImagery(entry)) {
      const layer = entry.imageryLayer;
      for (const k of ['brightness', 'contrast', 'hue', 'saturation', 'gamma']) {
        if (patch[k] == null) continue;
        const v = Number(patch[k]);
        if (!isFinite(v)) continue;
        st[k] = v;
        if (layer) layer[k] = v;
      }
      if (patch.alpha != null) {
        const a = clamp(patch.alpha, 0, 1);
        st.alpha = a;
        if (layer) layer.alpha = a;
      }
      if (patch.blend != null) {
        st.blend = String(patch.blend);
        applyBlend(entry);
      }
      if (patch.order != null) moveOrder(entry, Number(patch.order));
      return st;
    }

    if (isVector(entry)) {
      for (const k of Object.keys(DEFAULT_VECTOR)) {
        if (patch[k] == null) continue;
        st[k] = patch[k];
      }
      repaintVector(entry);
      return st;
    }
    return st;
  }

  /**
   * 应用混合模式。
   *
   * Cesium 的 ImageryLayer **没有** blendMode 属性（它只影响 Cesium 自己的
   * 图层合成顺序），要真正做「正片叠底」这类混合，得在**纹理层**上做。
   * 现实可行的做法：用一个离屏 canvas 把影像瓦片按混合模式预合成——
   * 但这会把瓦片缓存打穿，性能不可接受。
   *
   * 因此这里采用 Cesium 官方支持的等价手段：
   *   · normal        → 原样
   *   · multiply 等   → 通过 alpha 降低下层可见度 + 对本层做对比度/亮度补偿
   *   · color 类      → 通过 saturation / hue 近似
   * 这不是像素级精确的混合，但对「看图」这个用途足够，且**零额外开销**。
   */
  function applyBlend(entry) {
    const st = entry.style;
    const layer = entry.imageryLayer;
    if (!st || !layer) return;
    const base = entry._styleBase || (entry._styleBase = {
      brightness: layer.brightness,
      contrast: layer.contrast,
      hue: layer.hue,
      saturation: layer.saturation,
      gamma: layer.gamma,
    });
    switch (st.blend) {
      case 'multiply':
        layer.brightness = base.brightness * 0.82;
        layer.contrast = base.contrast * 1.08;
        layer.saturation = base.saturation * 0.92;
        break;
      case 'screen':
        layer.brightness = base.brightness * 1.18;
        layer.contrast = base.contrast * 0.94;
        break;
      case 'overlay':
      case 'hard-light':
        layer.contrast = base.contrast * 1.22;
        break;
      case 'darken':
        layer.brightness = base.brightness * 0.85;
        break;
      case 'lighten':
        layer.brightness = base.brightness * 1.15;
        break;
      case 'color-dodge':
        layer.contrast = base.contrast * 1.12;
        layer.brightness = base.brightness * 1.06;
        break;
      case 'color-burn':
        layer.contrast = base.contrast * 1.3;
        layer.brightness = base.brightness * 0.94;
        break;
      case 'soft-light':
        layer.contrast = base.contrast * 0.96;
        break;
      case 'difference':
        layer.contrast = base.contrast * 1.5;
        layer.brightness = base.brightness * 0.95;
        break;
      case 'exclusion':
        layer.contrast = base.contrast * 1.35;
        break;
      case 'hue':
      case 'saturation':
      case 'color':
      case 'luminosity':
        // 这四种是 HSV 空间的分量混合，Cesium 只暴露了 hue/saturation，
        // 用对应分量偏移来近似（color → 靠 saturation + hue 组合）
        if (st.blend === 'saturation') layer.saturation = base.saturation * 1.25;
        else if (st.blend === 'hue') layer.hue = base.hue + 0.5;
        else if (st.blend === 'color') {
          layer.saturation = base.saturation * 1.15;
          layer.hue = base.hue + 0.5;
        } else {
          layer.contrast = base.contrast * 1.1;
          layer.brightness = base.brightness * 1.05;
        }
        break;
      default:
        layer.brightness = base.brightness;
        layer.contrast = base.contrast;
        layer.hue = base.hue;
        layer.saturation = base.saturation;
        layer.gamma = base.gamma;
        break;
    }
  }

  /**
   * 调整影像层的叠放顺序：order 越大越靠上（0 = 最底）。
   *
   * 走图层栈 LELayerOrder 而不是 imageryLayers.raise/lower：
   * Cesium 的 raise(layer, n) 的第二个参数**不是**「移动 n 层」，
   * 实测无论传几都只移动一层，所以多级移动必须自己做下标运算。
   * 图层栈里已经实现好了，并且与用户的其他排序保持一致。
   */
  function moveOrder(entry, order) {
    const lo = window.LELayerOrder;
    if (lo && entry.imageryLayer) {
      if (!lo.has(entry)) lo.addUser(entry);
      const total = lo.order().length;
      // order 0 = 最底 → 数组下标 0；order 越大越靠上 → 下标越大
      const target = Math.max(0, Math.min(total - 1, total - 1 - (order || 0)));
      const cur = lo.indexOf(entry);
      if (cur >= 0 && cur !== target) {
        lo.move(entry, target > cur ? +1 : -1);
      }
      return target;
    }
    // 没有图层栈时退回到单步 raise/lower（逐次调用，绕开 delta 参数不可靠的问题）
    const le = state.le || window.LE;
    if (!le || !le.viewer || !entry.imageryLayer) return -1;
    const layers = le.viewer.imageryLayers;
    const count = layers.length;
    if (!count) return -1;
    const idx = layers.indexOf(entry.imageryLayer);
    if (idx < 0) return -1;
    const target = Math.max(0, Math.min(count - 1, count - 1 - (order || 0)));
    while (layers.indexOf(entry.imageryLayer) < target) layers.raise(entry.imageryLayer);
    while (layers.indexOf(entry.imageryLayer) > target) layers.lower(entry.imageryLayer);
    return target;
  }

  /** 恢复默认样式。 */
  function reset(entry) {
    if (!entry) return null;
    if (isImagery(entry)) {
      const layer = entry.imageryLayer;
      const d = DEFAULT_IMAGERY;
      if (layer) {
        layer.brightness = d.brightness;
        layer.contrast = d.contrast;
        layer.hue = d.hue;
        layer.saturation = d.saturation;
        layer.gamma = d.gamma;
        layer.alpha = d.alpha;
      }
      entry.style = Object.assign({}, d);
      entry._styleBase = null;
      return entry.style;
    }
    if (isVector(entry)) {
      entry.style = Object.assign({}, DEFAULT_VECTOR);
      entry.rules = null;
      repaintVector(entry);
      return entry.style;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 矢量重绘
   * ------------------------------------------------------------------ */

  /**
   * 按当前样式 + 规则重绘画矢量实体。
   * 规则存在 entry.rules（分级/过滤），样式存在 entry.style。
   */
  function repaintVector(entry) {
    const ds = entry.datasource;
    if (!ds || !ds.entities) return;
    const st = styles(entry);
    const rules = entry.rules;
    const entities = ds.entities.values;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const props = propsOf(e);
      const matched = rules ? matchRule(rules, props) : null;
      if (matched === false) { e.show = false; continue; }
      if (e.show === false && matched !== false) e.show = true;

      const sym = matched && typeof matched === 'object' ? matched : null;
      const color = (sym && sym.color) || null;

      if (e.point) {
        e.point.pixelSize = (sym && sym.pointSize != null) ? sym.pointSize : st.pointSize;
        e.point.color = C.Color.fromCssColorString(color || st.pointColor).withAlpha(0.95);
      }
      if (e.billboard) {
        // GeoJSON 的 Point 走 billboard；KML 的图标点也走 billboard。
        // KML 点带图标（entity.LEKml 有标记），换贴图会把图标弄丢，
        // 所以只做着色（billboard.color 会给图标染色）。
        const size = (sym && sym.pointSize != null) ? sym.pointSize : st.pointSize;
        const css = color || st.pointColor;
        if (e.LEKml) {
          e.billboard.color = C.Color.fromCssColorString(css).withAlpha(0.95);
        } else {
          const img = pointImage(css, size);
          if (img) {
            e.billboard.image = new C.ConstantProperty(img);
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            e.billboard.scale = new C.ConstantProperty((size * dpr) / Math.max(1, img.width));
          }
          e.billboard.color = C.Color.fromCssColorString(css).withAlpha(0.95);
        }
      }
      if (e.polyline) {
        e.polyline.width = (sym && sym.lineWidth != null) ? sym.lineWidth : st.lineWidth;
        e.polyline.material = C.Color.fromCssColorString(color || st.lineColor).withAlpha(0.95);
      }
      if (e.polygon) {
        const alpha = (sym && sym.fillAlpha != null) ? sym.fillAlpha : st.fillAlpha;
        e.polygon.material = C.Color.fromCssColorString(color || st.fillColor).withAlpha(alpha);
        if (st.strokeColor) {
          e.polygon.outline = true;
          e.polygon.outlineColor = C.Color.fromCssColorString(st.strokeColor).withAlpha(0.9);
          e.polygon.outlineWidth = st.strokeWidth;
        }
      }
      // 标注
      if (st.labelField) {
        const text = props[st.labelField];
        if (text != null && text !== '') {
          if (!e.label) {
            e.label = new C.LabelGraphics();
          }
          e.label.text = String(text);
          e.label.font = 'bold ' + Math.round(st.labelSize) + 'px sans-serif';
          e.label.fillColor = C.Color.fromCssColorString(st.labelColor);
          e.label.outlineColor = C.Color.fromCssColorString(st.labelOutline);
          e.label.outlineWidth = 2;
          e.label.style = C.LabelStyle.FONT_AND_COLOR;
          e.label.show = true;
        } else if (e.label) {
          e.label.show = false;
        }
      } else if (e.label) {
        e.label.show = false;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 规则：分级 / 渐变 / 过滤
   * ------------------------------------------------------------------ */

  /**
   * 规则结构（统一模型，P1-4.7）：
   *   {
   *     mode: 'classify' | 'graduated' | 'categorical' | 'rules',
   *     field: '字段名',              // classify/graduated/categorical 用
   *     classes: [{ min, max, key, label, color, count }],
   *     sizeScale: true,             // graduated：点大小/线宽随级别递增
   *     rules: [{ id, label, enabled, condition, symbol }],
   *     hideUnmatched: false,        // rules：未命中任何规则时是否隐藏
   *   }
   */

  /**
   * 判断一个要素是否被规则命中。
   *
   * 返回值语义：
   *   false → 隐藏该要素
   *   null  → 显示，但用图层默认样式
   *   对象  → 显示，并用该对象里的符号（color / pointSize / lineWidth / fillAlpha）
   */
  function matchRule(rules, props) {
    if (!rules) return null;

    // 规则渲染器：按顺序，第一条命中的生效
    if (rules.mode === 'rules' && rules.rules && rules.rules.length) {
      const K = kernel();
      const m = K
        ? K.matchRules(rules.rules, props)
        : legacyMatch(rules.rules, props);
      if (!m) return rules.hideUnmatched ? false : null;
      return m.symbol;
    }

    // 枚举分档：按字段取值上色
    if (rules.mode === 'categorical' && rules.classes) {
      const v = props[rules.field];
      const key = v == null ? '' : String(v);
      for (const c of rules.classes) {
        if (c.key === key) return c;
      }
      return null;
    }

    // 数值分级：classify / graduated
    if ((rules.mode === 'classify' || rules.mode === 'graduated') && rules.classes) {
      const num = Number(props[rules.field]);
      if (!isFinite(num)) return null;
      for (let i = 0; i < rules.classes.length; i++) {
        const c = rules.classes[i];
        // 第 0 档含下界，其余档覆盖 (min, max]
        const lo = c.min;
        const hi = c.max;
        if (hi == null) {
          if (num >= lo) return withScale(rules, c, i);
        } else if (i === 0) {
          if (num >= lo && num <= hi) return withScale(rules, c, i);
        } else if (num > lo && num <= hi) {
          return withScale(rules, c, i);
        }
      }
      return null;
    }

    // 旧版过滤规则（保留兼容）
    if (rules.filter) {
      const f = rules.filter;
      const v = props[f.field];
      const target = f.value;
      const num = Number(v);
      const tnum = Number(target);
      let hit = true;
      switch (f.op) {
        case 'eq': hit = String(v) === String(target); break;
        case 'ne': hit = String(v) !== String(target); break;
        case 'gt': hit = isFinite(num) && isFinite(tnum) && num > tnum; break;
        case 'ge': hit = isFinite(num) && isFinite(tnum) && num >= tnum; break;
        case 'lt': hit = isFinite(num) && isFinite(tnum) && num < tnum; break;
        case 'le': hit = isFinite(num) && isFinite(tnum) && num <= tnum; break;
        case 'like': hit = String(v || '').indexOf(String(target)) >= 0; break;
        default: hit = true;
      }
      return hit ? null : false;
    }

    return null;
  }

  /** 分级命中后按需附加尺寸（点大小 / 线宽随级别递增）。 */
  function withScale(rules, c, index) {
    if (!rules.sizeScale) return c;
    const total = (rules.classes || []).length;
    const t = total <= 1 ? 1 : index / (total - 1);
    const out = Object.assign({}, c);
    // 级别越高，点越大、线越粗
    if (out.pointSize == null) out.pointSize = Math.round(4 + t * 12);
    if (out.lineWidth == null) out.lineWidth = Math.round((1 + t * 5) * 2) / 2;
    return out;
  }

  /** 规则内核不可用时的降级实现（只支持 eq/ne/gt/ge/lt/le）。 */
  function legacyMatch(rules, props) {
    for (const r of rules) {
      if (!r || r.enabled === false) continue;
      const f = r.filter || {};
      const v = props[f.field];
      const num = Number(v);
      const tnum = Number(f.value);
      let hit = true;
      switch (f.op) {
        case 'eq': hit = String(v) === String(f.value); break;
        case 'ne': hit = String(v) !== String(f.value); break;
        case 'gt': hit = isFinite(num) && isFinite(tnum) && num > tnum; break;
        case 'ge': hit = isFinite(num) && isFinite(tnum) && num >= tnum; break;
        case 'lt': hit = isFinite(num) && isFinite(tnum) && num < tnum; break;
        case 'le': hit = isFinite(num) && isFinite(tnum) && num <= tnum; break;
        default: hit = true;
      }
      if (hit) return { rule: r, symbol: Object.assign({ color: null }, r.symbol || {}) };
    }
    return null;
  }

  /** 读取图层的字段名列表（用于规则面板的下拉）。 */
  function fieldsOf(entry) {
    const out = [];
    if (!entry) return out;
    if (Array.isArray(entry.fields) && entry.fields.length) {
      for (const f of entry.fields) {
        out.push(typeof f === 'string' ? f : (f.name || f.field || ''));
      }
      return out.filter(Boolean);
    }
    if (entry.datasource && entry.datasource.entities) {
      const ents = entry.datasource.entities.values;
      for (let i = 0; i < ents.length && i < 200; i++) {
        const p = propsOf(ents[i]);
        for (const k of Object.keys(p)) {
          if (out.indexOf(k) < 0) out.push(k);
        }
      }
    }
    return out;
  }

  /** 取某字段的取值范围（数值字段给 min/max，其它给取值集合）。 */
  function fieldRange(entry, field) {
    const vals = [];
    const seen = {};
    const raw = [];
    if (!entry || !entry.datasource || !entry.datasource.entities) return { numeric: false };
    const ents = entry.datasource.entities.values;
    let numeric = true;
    for (let i = 0; i < ents.length; i++) {
      const p = propsOf(ents[i]);
      const v = p[field];
      if (v == null) continue;
      raw.push(v);
      const n = Number(v);
      if (!isFinite(n)) { numeric = false; continue; }
      vals.push(n);
      const key = String(v);
      if (!(key in seen)) { seen[key] = true; }
    }
    if (!numeric || !vals.length) {
      return { numeric: false, categories: Object.keys(seen), values: raw };
    }
    vals.sort((a, b) => a - b);
    return {
      numeric: true,
      min: vals[0],
      max: vals[vals.length - 1],
      count: vals.length,
      values: vals,
    };
  }

  /** 设置规则并立即重绘。 */
  function setRule(entry, rule) {
    if (!entry) return null;
    entry.rules = rule || null;
    repaintVector(entry);
    return entry.rules;
  }

  /** 分级渲染：按字段分箱上色。 */
  function classify(entry, rule) {
    return setRule(entry, rule);
  }

  /**
   * 按字段生成分级规则（数值字段走 Jenks/等距/分位数，枚举字段走 categorical）。
   * @param {object} entry 图层
   * @param {string} field 字段名
   * @param {object} opt { method, classes, sizeScale }
   */
  function gradeByField(entry, field, opt) {
    const o = opt || {};
    const K = kernel();
    const rng = fieldRange(entry, field);
    if (!rng.numeric || !rng.values || !rng.values.length) {
      // 枚举字段：按取值分档（raw 里是原始值，可能不是数字）
      const raw = rng.values || [];
      const cats = K
        ? K.categorical(raw, o.maxClasses || 20)
        : (rng.categories || []).map(function (c, i) {
            return { key: c, label: c, count: 0, color: palette(i, (rng.categories || []).length) };
          });
      if (!cats.length) return null;
      return setRule(entry, {
        mode: 'categorical',
        field: field,
        classes: cats,
      });
    }
    const k = Math.max(2, Math.min(20, o.classes || 5));
    const method = o.method || '自然断点';
    const classes = K
      ? K.classes(rng.values, method, k)
      : makeClasses(rng.min, rng.max, k, 'classify');
    return setRule(entry, {
      mode: o.mode || 'graduated',
      field: field,
      method: method,
      classes: classes,
      sizeScale: !!o.sizeScale,
    });
  }

  /** 标注字段。 */
  function labelBy(entry, field) {
    const st = styles(entry);
    st.labelField = field || null;
    repaintVector(entry);
    return st;
  }

  /* ------------------------------------------------------------------ *
   * 样式面板
   * ------------------------------------------------------------------ */

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('div', 'le-panel style-panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '图层样式');

    const head = el('div', 'le-panel-head');
    const h4 = el('h4', null, '图层样式');
    h4.id = 'style-panel-title';
    head.appendChild(h4);
    const actions = el('div', 'le-panel-actions');
    const resetBtn = el('button', null, '恢复默认');
    resetBtn.type = 'button';
    resetBtn.title = '把该图层的样式恢复为初始值';
    resetBtn.addEventListener('click', function () {
      if (!state.current) return;
      reset(state.current);
      open(state.current);
      toast('已恢复默认样式', 'ok', 2000);
    });
    const closeBtn = el('button', 'le-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(resetBtn);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const body = el('div', 'style-panel-body');
    body.id = 'style-panel-body';
    panel.appendChild(body);

    document.body.appendChild(panel);
    state.panel = panel;
    return panel;
  }

  /** 滑杆行。 */
  function slider(label, min, max, step, value, onInput, fmt) {
    const row = el('div', 'style-row');
    const lb = el('label', 'style-label', label);
    row.appendChild(lb);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    const val = el('span', 'style-value', fmt ? fmt(value) : String(value));
    range.addEventListener('input', function () {
      val.textContent = fmt ? fmt(range.value) : range.value;
      onInput(Number(range.value));
    });
    row.appendChild(range);
    row.appendChild(val);
    return row;
  }

  /** 颜色行。 */
  function colorRow(label, value, onChange) {
    const row = el('div', 'style-row');
    row.appendChild(el('label', 'style-label', label));
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'style-color';
    input.value = value || '#4c9be8';
    input.addEventListener('change', function () { onChange(input.value); });
    row.appendChild(input);
    const hex = el('span', 'style-value', input.value.toUpperCase());
    input.addEventListener('input', function () { hex.textContent = input.value.toUpperCase(); });
    row.appendChild(hex);
    return row;
  }

  /** 下拉行。 */
  function selectRow(label, options, value, onChange) {
    const row = el('div', 'style-row');
    row.appendChild(el('label', 'style-label', label));
    const sel = document.createElement('select');
    sel.className = 'style-select';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = String(value);
    sel.addEventListener('change', function () { onChange(sel.value); });
    row.appendChild(sel);
    return row;
  }

  /** 打开样式面板，渲染对应图层的控件。 */
  function open(entry) {
    if (!entry) return;
    const panel = ensurePanel();
    state.current = entry;
    const body = byId('style-panel-body');
    const title = byId('style-panel-title');
    if (title) title.textContent = '图层样式 · ' + (entry.name || '');
    if (!body) return;
    body.innerHTML = '';

    if (isImagery(entry)) {
      const st = styles(entry);
      body.appendChild(slider('亮度', 0, 3, 0.05, st.brightness,
        function (v) { apply(entry, { brightness: v }); }, function (v) { return Number(v).toFixed(2); }));
      body.appendChild(slider('对比度', 0, 3, 0.05, st.contrast,
        function (v) { apply(entry, { contrast: v }); }, function (v) { return Number(v).toFixed(2); }));
      body.appendChild(slider('饱和度', 0, 3, 0.05, st.saturation,
        function (v) { apply(entry, { saturation: v }); }, function (v) { return Number(v).toFixed(2); }));
      body.appendChild(slider('色相', -1, 1, 0.01, st.hue,
        function (v) { apply(entry, { hue: v }); }, function (v) { return Number(v).toFixed(2); }));
      body.appendChild(slider('伽马', 0.1, 3, 0.05, st.gamma,
        function (v) { apply(entry, { gamma: v }); }, function (v) { return Number(v).toFixed(2); }));
      body.appendChild(slider('透明度', 0, 1, 0.05, st.alpha,
        function (v) { apply(entry, { alpha: v }); }, function (v) { return Math.round(Number(v) * 100) + '%'; }));
      body.appendChild(selectRow('混合模式', BLEND_MODES, st.blend, function (v) {
        apply(entry, { blend: v });
      }));
      body.appendChild(el('p', 'style-note',
        '混合模式用 Cesium 的亮度/对比度/饱和度近似实现，不影响原始数据。'));
    } else if (isVector(entry)) {
      const st = styles(entry);
      body.appendChild(slider('点大小', 2, 30, 1, st.pointSize,
        function (v) { apply(entry, { pointSize: v }); }));
      body.appendChild(colorRow('点颜色', st.pointColor, function (v) { apply(entry, { pointColor: v }); }));
      body.appendChild(slider('线宽', 0.5, 12, 0.5, st.lineWidth,
        function (v) { apply(entry, { lineWidth: v }); }, function (v) { return Number(v).toFixed(1); }));
      body.appendChild(colorRow('线颜色', st.lineColor, function (v) { apply(entry, { lineColor: v }); }));
      body.appendChild(colorRow('填充色', st.fillColor, function (v) { apply(entry, { fillColor: v }); }));
      body.appendChild(slider('填充透明度', 0, 1, 0.05, st.fillAlpha,
        function (v) { apply(entry, { fillAlpha: v }); }, function (v) { return Math.round(Number(v) * 100) + '%'; }));

      // 字段相关
      const fields = fieldsOf(entry);
      if (fields.length) {
        body.appendChild(el('div', 'style-sep', '字段'));
        const lb = el('label', 'style-label', '标注字段');
        body.appendChild(lb);
        const sel = document.createElement('select');
        sel.className = 'style-select style-block';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '（不标注）';
        sel.appendChild(none);
        for (const f of fields) {
          const o = document.createElement('option');
          o.value = f;
          o.textContent = f;
          sel.appendChild(o);
        }
        sel.value = st.labelField || '';
        sel.addEventListener('change', function () { labelBy(entry, sel.value || null); });
        body.appendChild(sel);

        // 分级渲染
        body.appendChild(el('div', 'style-sep', '字段驱动样式'));
        const ruleWrap = el('div', 'style-rule-wrap');
        ruleWrap.appendChild(buildRendererControl(entry, fields));
        body.appendChild(ruleWrap);
      } else {
        body.appendChild(el('p', 'style-note', '该图层没有属性字段，无法做字段驱动样式。'));
      }
    } else {
      body.appendChild(el('p', 'style-note', '该图层类型暂不支持样式编辑。'));
    }

    panel.classList.remove('hidden');
  }

  /**
   * 字段驱动样式控件（P1-4.7）。
   *
   * 两种模式：
   *   · **分级**：选字段 → 定级数 → 定分级方式 → 应用（数值字段），
   *     或按取值枚举分档（枚举字段）。
   *   · **规则**：一组有序规则，条件是表达式，第一条命中的生效。
   */
  function buildRendererControl(entry, fields) {
    const wrap = el('div', 'style-classify');
    const rules = entry.rules || null;

    /* ---- 模式切换 ---- */
    const modeSel = document.createElement('select');
    modeSel.className = 'style-select';
    const modes = [
      { v: 'grade', t: '分级（按字段分档）' },
      { v: 'rules', t: '规则（条件表达式）' },
    ];
    for (const m of modes) {
      const o = document.createElement('option');
      o.value = m.v;
      o.textContent = m.t;
      modeSel.appendChild(o);
    }
    modeSel.value = rules && rules.mode === 'rules' ? 'rules' : 'grade';
    wrap.appendChild(modeSel);

    const gradeWrap = el('div', 'style-grade-pane');
    const rulesWrap = el('div', 'style-rules-pane');
    wrap.appendChild(gradeWrap);
    wrap.appendChild(rulesWrap);

    /* ================= 分级 ================= */
    const fieldSel = document.createElement('select');
    fieldSel.className = 'style-select';
    for (const f of fields) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      fieldSel.appendChild(o);
    }
    if (rules && rules.field) fieldSel.value = rules.field;

    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.className = 'style-num';
    countInput.min = '2';
    countInput.max = '20';
    countInput.value = String((rules && rules.classes && rules.classes.length) || 5);

    const methodSel = document.createElement('select');
    methodSel.className = 'style-select';
    const METHODS = (kernel() && kernel().BREAK_METHODS) || ['自然断点', '等距', '分位数', '几何级数'];
    for (const m of METHODS) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      methodSel.appendChild(o);
    }
    if (rules && rules.method) methodSel.value = rules.method;

    const scaleChk = document.createElement('input');
    scaleChk.type = 'checkbox';
    scaleChk.className = 'style-chk';
    scaleChk.checked = !!(rules && rules.sizeScale);
    const scaleRow = el('div', 'style-classify-row');
    scaleRow.appendChild(scaleChk);
    scaleRow.appendChild(el('label', 'style-chk-label', '大小随级别递增'));

    const row = el('div', 'style-classify-row');
    row.appendChild(fieldSel);
    row.appendChild(methodSel);
    row.appendChild(countInput);
    gradeWrap.appendChild(row);
    gradeWrap.appendChild(scaleRow);

    const applyBtn = el('button', 'style-apply', '应用分级');
    applyBtn.type = 'button';
    applyBtn.addEventListener('click', function () {
      const field = fieldSel.value;
      const n = Math.max(2, Math.min(20, Number(countInput.value) || 5));
      const rng = fieldRange(entry, field);
      if (!rng.numeric) {
        const cats = kernel()
          ? kernel().categorical(rng.categories || [], 20)
          : (rng.categories || []).slice(0, 20).map(function (c, i, arr) {
              return { key: c, label: c, count: 0, color: palette(i, arr.length) };
            });
        if (!cats.length) { toast('该字段没有可用取值', 'error'); return; }
        setRule(entry, { mode: 'categorical', field: field, classes: cats });
        toast('已按 ' + field + ' 分类着色（' + cats.length + ' 类）', 'ok', 3000);
        refreshRuleList(entry, classList);
        return;
      }
      const K = kernel();
      const classes = K
        ? K.classes(rng.values, methodSel.value, n)
        : makeClasses(rng.min, rng.max, n, 'classify');
      setRule(entry, {
        mode: 'graduated',
        field: field,
        method: methodSel.value,
        classes: classes,
        sizeScale: scaleChk.checked,
      });
      toast('已按 ' + field + ' 分级着色（' + n + ' 级 · ' + methodSel.value + '）', 'ok', 3000);
      refreshRuleList(entry, classList);
    });
    gradeWrap.appendChild(applyBtn);

    /* ================= 规则 ================= */
    rulesWrap.appendChild(el('p', 'style-note',
      '规则按从上到下顺序求值，第一条命中的生效。条件用表达式：' +
      '双引号是字段名（"人口"），单引号是字符串，' +
      '可用 upper / lower / trim / concat / abs / round / floor / ceil / ' +
      'min / max / coalesce / substr / length / str / num / ifelse / like / matches。'));

    const ruleList = el('div', 'style-rules-list');
    rulesWrap.appendChild(ruleList);

    const addBtn = el('button', 'style-apply', '新增规则');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      const rl = (entry.rules && entry.rules.rules) ? entry.rules.rules.slice() : [];
      const n = rl.length + 1;
      rl.push({
        id: 'r' + Date.now() + '_' + n,
        label: '规则 ' + n,
        enabled: true,
        condition: fields.length ? '"' + fields[0] + '" IS NOT NULL' : '1 = 1',
        symbol: { color: palette(n - 1, 8), pointSize: 10, lineWidth: 3 },
      });
      setRule(entry, {
        mode: 'rules',
        rules: rl,
        hideUnmatched: (entry.rules && entry.rules.hideUnmatched) || false,
      });
      renderRuleList(entry, ruleList, fields);
      toast('已新增规则，编辑条件后点「应用规则」', 'ok', 3200);
    });
    rulesWrap.appendChild(addBtn);

    const applyRulesBtn = el('button', 'style-apply', '应用规则');
    applyRulesBtn.type = 'button';
    applyRulesBtn.addEventListener('click', function () {
      const K = kernel();
      const rl = (entry.rules && entry.rules.rules) || [];
      if (K) {
        const errs = K.validateRules(rl);
        if (errs.length) {
          toast(errs[0], 'error', 4200);
          return;
        }
      }
      setRule(entry, {
        mode: 'rules',
        rules: rl,
        hideUnmatched: !!(entry.rules && entry.rules.hideUnmatched),
      });
      toast('已应用 ' + rl.length + ' 条规则', 'ok', 2600);
    });
    rulesWrap.appendChild(applyRulesBtn);

    const hideChk = document.createElement('input');
    hideChk.type = 'checkbox';
    hideChk.className = 'style-chk';
    hideChk.checked = !!(rules && rules.hideUnmatched);
    hideChk.addEventListener('change', function () {
      const rl = (entry.rules && entry.rules.rules) || [];
      setRule(entry, { mode: 'rules', rules: rl, hideUnmatched: hideChk.checked });
    });
    const hideRow = el('div', 'style-classify-row');
    hideRow.appendChild(hideChk);
    hideRow.appendChild(el('label', 'style-chk-label', '隐藏未命中任何规则的要素'));
    rulesWrap.appendChild(hideRow);

    renderRuleList(entry, ruleList, fields);

    /* ================= 通用 ================= */
    const clearBtn = el('button', 'style-clear', '清除全部规则');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', function () {
      setRule(entry, null);
      toast('已清除规则', 'ok', 2000);
      open(entry);
    });
    wrap.appendChild(clearBtn);

    const classList = el('div', 'style-class-list');
    classList.id = 'style-class-list';
    wrap.appendChild(classList);
    refreshRuleList(entry, classList);

    /* ---- 模式切换：显示/隐藏两个面板 ---- */
    function syncMode() {
      const isRules = modeSel.value === 'rules';
      gradeWrap.style.display = isRules ? 'none' : '';
      rulesWrap.style.display = isRules ? '' : 'none';
    }
    modeSel.addEventListener('change', syncMode);
    syncMode();

    return wrap;
  }

  /** 渲染规则列表（每条：启用勾选 / 条件输入 / 颜色 / 删除）。 */
  function renderRuleList(entry, list, fields) {
    list.innerHTML = '';
    const rl = (entry.rules && entry.rules.rules) || [];
    if (!rl.length) {
      list.appendChild(el('p', 'style-note', '还没有规则，点下面的「新增规则」开始。'));
      return;
    }
    rl.forEach(function (r, idx) {
      const item = el('div', 'style-rule-item');

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'style-chk';
      chk.checked = r.enabled !== false;
      chk.addEventListener('change', function () {
        r.enabled = chk.checked;
        saveRuleList(entry, rl);
      });
      item.appendChild(chk);

      const cond = document.createElement('input');
      cond.type = 'text';
      cond.className = 'style-expr';
      cond.value = r.condition || '';
      cond.placeholder = '条件表达式，如 "人口" > 2000';
      cond.addEventListener('change', function () {
        r.condition = cond.value;
        saveRuleList(entry, rl);
      });
      item.appendChild(cond);

      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'style-color';
      color.value = (r.symbol && r.symbol.color) || '#4c9be8';
      color.addEventListener('change', function () {
        r.symbol = r.symbol || {};
        r.symbol.color = color.value;
        saveRuleList(entry, rl);
      });
      item.appendChild(color);

      const del = el('button', 'style-rule-del', '✕');
      del.type = 'button';
      del.title = '删除这条规则';
      del.addEventListener('click', function () {
        rl.splice(idx, 1);
        saveRuleList(entry, rl);
        renderRuleList(entry, list, fields);
      });
      item.appendChild(del);

      list.appendChild(item);
    });
  }

  /** 保存规则列表（不重绘整个面板，避免输入框失焦）。 */
  function saveRuleList(entry, rl) {
    entry.rules = Object.assign({}, entry.rules || {}, { mode: 'rules', rules: rl });
    repaintVector(entry);
  }

  /** 刷新分级图例（级数、颜色、区间、要素数）。 */
  function refreshRuleList(entry, listEl) {
    const list = listEl || document.getElementById('style-class-list');
    if (!list) return;
    list.innerHTML = '';
    const rules = entry.rules;
    if (!rules || !rules.classes || !rules.classes.length) return;
    const title = rules.mode === 'categorical'
      ? '按「' + rules.field + '」枚举分档'
      : '按「' + rules.field + '」' + (rules.method || '分级') + '分档';
    list.appendChild(el('div', 'style-note', title));
    for (const c of rules.classes) {
      const item = el('div', 'style-class-item');
      const sw = el('span', 'style-swatch');
      sw.style.background = c.color;
      item.appendChild(sw);
      const label = c.label != null
        ? c.label
        : (c.max == null ? '≥ ' + c.min : c.min + ' – ' + c.max);
      item.appendChild(el('span', 'style-class-label', label));
      if (c.count != null) {
        item.appendChild(el('span', 'style-class-count', c.count + ' 个'));
      }
      list.appendChild(item);
    }
  }

  /** 造 n 级分类（等距）。 */
  function makeClasses(min, max, n, mode) {
    const classes = [];
    if (mode === 'graduated') {
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        classes.push({
          min: min + (max - min) * t0,
          max: min + (max - min) * t1,
          color: viridis(0.15 + t0 * 0.7),
          label: Math.round(min + (max - min) * t0) + ' – ' + Math.round(min + (max - min) * t1),
        });
      }
    } else {
      const step = (max - min) / n;
      for (let i = 0; i < n; i++) {
        const lo = min + step * i;
        const hi = i === n - 1 ? null : min + step * (i + 1);
        classes.push({
          min: lo,
          max: hi,
          color: palette(i, n),
          label: hi == null ? '≥ ' + round(lo) : round(lo) + ' – ' + round(hi),
        });
      }
    }
    return classes;
  }

  function round(v) {
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toString();
    if (a >= 10) return (Math.round(v * 10) / 10).toString();
    return (Math.round(v * 100) / 100).toString();
  }

  /** 分类色板（QGIS 类 Spectral 感觉）。 */
  function palette(i, n) {
    const stops = ['#4c9be8', '#57c2a8', '#9ed14f', '#ffd166', '#f0955c', '#e5645c', '#c05fb0', '#8a7ae0'];
    if (n <= 1) return stops[0];
    const t = i / (n - 1);
    return stops[Math.round(t * (stops.length - 1))];
  }

  /** viridis 色带（与 js/analysis.js 的 paletteColor 风格一致）。 */
  function viridis(t) {
    const c = [
      [0.267, 0.005, 0.329],
      [0.283, 0.141, 0.458],
      [0.254, 0.265, 0.530],
      [0.207, 0.372, 0.553],
      [0.164, 0.471, 0.558],
      [0.128, 0.567, 0.551],
      [0.135, 0.659, 0.518],
      [0.267, 0.749, 0.441],
      [0.478, 0.821, 0.318],
      [0.741, 0.873, 0.150],
      [0.993, 0.906, 0.144],
    ];
    const x = Math.max(0, Math.min(0.999, t)) * (c.length - 1);
    const i0 = Math.floor(x);
    const i1 = Math.min(c.length - 1, i0 + 1);
    const f = x - i0;
    const r = Math.round(255 * (c[i0][0] * (1 - f) + c[i1][0] * f));
    const g = Math.round(255 * (c[i0][1] * (1 - f) + c[i1][1] * f));
    const b = Math.round(255 * (c[i0][2] * (1 - f) + c[i1][2] * f));
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function close() {
    if (state.panel) state.panel.classList.add('hidden');
    state.current = null;
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init(le) {
    state.le = le || window.LE;
    if (!state.le) return;
    // 图层树里加一个「样式」按钮
    if (window.LELayerPanel && typeof window.LELayerPanel.onStyleRequest === 'function') {
      window.LELayerPanel.onStyleRequest(function (entry) { open(entry); });
    }
  }

  window.LELayerStyle = {
    init: init,
    open: open,
    close: close,
    styles: styles,
    apply: apply,
    reset: reset,
    classify: classify,
    setRule: setRule,
    rules: function (entry) { return entry ? entry.rules || null : null; },
    labelBy: labelBy,
    fieldsOf: fieldsOf,
    fieldRange: fieldRange,
    matchRule: matchRule,
    gradeByField: gradeByField,
    propsOf: propsOf,
    palette: palette,
    viridis: viridis,
    makeClasses: makeClasses,
    repaintVector: repaintVector,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

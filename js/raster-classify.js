/*
 * 栅格分类内核（纯计算，不依赖 DOM / Cesium，可直接在 Node 里单测）
 * ---------------------------------------------------------------------------
 * P3-4.15「栅格分类与监督分类」的内核部分。
 *
 * 覆盖三件事：
 *
 *   1) **监督分类**（有样本点的分类）
 *      · 最小距离（Minimum Distance）：像元到各类别样本中心的欧氏距离，取最近
 *      · 最大似然（Maximum Likelihood）：假设各类别各波段独立同分布（高斯），
 *        用对数似然判定；方差用样本估计，单样本类别退回全局方差
 *      · 分类前对每个波段做**标准化**（z-score），否则量级大的波段会主导距离
 *
 *   2) **非监督分类**（K-Means）
 *      对格网内全部像元聚类成 K 类，用于「先看看这堆数据能分几类」。
 *
 *   3) **精度评价**
 *      用训练样本回代算混淆矩阵与总体精度（Overall Accuracy）、
 *      各类生产者/用户精度（Precision / Recall / F1）。
 *
 * 所有函数都是纯函数：不读 DOM、不读 window，可以直接
 * `require('../js/raster-classify.js')` 做单元测试。
 *
 * 数据模型（与本项目其它内核一致）：
 *   grid = {
 *     w, h,                       // 格网宽高（像元数）
 *     west, south, east, north,  // 经纬度范围
 *     bands: [ { name, data: Float32Array } ]   // 每个波段一份像元值
 *   }
 *   sample = { lon, lat, classId }              // 训练样本点
 *   class  = { id, name, color }                // 类别定义
 *
 * 对外 API（window.LERasterClassify）：
 *   makeGrid(w, h, bounds, bandNames)
 *   sampleAt(grid, lon, lat)          → number[] | null
 *   train(grid, samples, classes, opts) → model
 *   classifyPoint(model, values)      → { classId, scores, method }
 *   classifyGrid(model, grid)         → { classes: Int32Array, table }
 *   confusion(model, samples)         → { matrix, accuracy, perClass }
 *   kmeans(grid, k, opts)             → { classes, table, centroids }
 *   METHODS
 */
(function (root) {
  'use strict';

  /** 监督分类方法。 */
  const METHODS = ['最小距离', '最大似然'];

  /* ================================================================ 工具 */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  /**
   * 建一个空格网。
   * @param {number} w 像元宽
   * @param {number} h 像元高
   * @param {number[]} bounds [west, south, east, north]
   * @param {string[]} bandNames 波段名
   */
  function makeGrid(w, h, bounds, bandNames) {
    const names = bandNames && bandNames.length ? bandNames : ['band1'];
    const bands = names.map(function (n) {
      return { name: String(n), data: new Float32Array(w * h) };
    });
    bands.forEach(function (b) { b.data.fill(NaN); });
    return {
      w: w, h: h,
      west: bounds[0], south: bounds[1], east: bounds[2], north: bounds[3],
      bands: bands,
    };
  }

  /** 从格网读一组波段值；越界或含 NaN 返回 null。 */
  function sampleAt(grid, lon, lat) {
    if (!grid || !grid.bands || !grid.bands.length) return null;
    const { w, h, west, south, east, north } = grid;
    if (!(east > west) || !(north > south)) return null;
    const fx = (lon - west) / (east - west);
    const fy = (north - lat) / (north - south);
    if (!(fx >= 0 && fx <= 1) || !(fy >= 0 && fy <= 1)) return null;
    const col = Math.min(w - 1, Math.max(0, Math.round(fx * (w - 1))));
    const row = Math.min(h - 1, Math.max(0, Math.round(fy * (h - 1))));
    const i = row * w + col;
    const out = [];
    for (let b = 0; b < grid.bands.length; b++) {
      const v = grid.bands[b].data[i];
      if (!isNum(v)) return null;
      out.push(v);
    }
    return out;
  }

  /* ========================================================== 波段标准化 */

  /**
   * 计算各波段的均值与标准差（只用有限值）。
   * @returns {Array<{name, mean, std, min, max, count}>}
   */
  function bandStats(grid) {
    const out = [];
    (grid.bands || []).forEach(function (band) {
      const d = band.data;
      let n = 0, sum = 0, mn = Infinity, mx = -Infinity;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (!isNum(v)) continue;
        n++; sum += v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const mean = n ? sum / n : 0;
      let ss = 0;
      if (n > 1) {
        for (let i = 0; i < d.length; i++) {
          const v = d[i];
          if (!isNum(v)) continue;
          ss += (v - mean) * (v - mean);
        }
      }
      const std = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
      out.push({
        name: band.name, mean: mean, std: std,
        min: n ? mn : 0, max: n ? mx : 0, count: n,
      });
    });
    return out;
  }

  /** 标准化（z-score）；std 为 0 的波段用 1，避免除零。 */
  function standardize(values, stats) {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const s = stats[i];
      const sd = s && s.std > 1e-12 ? s.std : 1;
      out[i] = (values[i] - (s ? s.mean : 0)) / sd;
    }
    return out;
  }

  /* ============================================================== 训练 */

  /**
   * 用样本点训练分类器。
   *
   * @param {object} grid 格网（提供波段顺序与统计量）
   * @param {Array} samples [{lon, lat, classId}]
   * @param {Array} classes [{id, name, color}]
   * @param {object} opts { method: '最小距离'|'最大似然' }
   * @returns {object} model
   */
  function train(grid, samples, classes, opts) {
    opts = opts || {};
    const method = METHODS.indexOf(opts.method) >= 0 ? opts.method : METHODS[0];
    const stats = bandStats(grid);
    const nBands = grid.bands.length;

    const classIds = (classes || []).map(function (c) { return c.id; });
    const vectors = [];
    for (let i = 0; i < (samples || []).length; i++) {
      const s = samples[i];
      const v = sampleAt(grid, s.lon, s.lat);
      if (!v) continue;
      vectors.push({ classId: s.classId, raw: v, z: standardize(v, stats) });
    }

    // 各类别的样本向量
    const byClass = new Map();
    classIds.forEach(function (id) { byClass.set(id, []); });
    vectors.forEach(function (v) {
      if (!byClass.has(v.classId)) byClass.set(v.classId, []);
      byClass.get(v.classId).push(v);
    });

    // 全局方差（单样本类别退回它）
    const globalVar = [];
    for (let b = 0; b < nBands; b++) {
      let s = 0;
      for (let i = 0; i < vectors.length; i++) s += vectors[i].z[i] * vectors[i].z[i];
      globalVar.push(vectors.length > 1 ? s / (vectors.length - 1) : 1);
      if (!(globalVar[b] > 1e-12)) globalVar[b] = 1;
    }

    // 全局均值（给没有样本的类别兜底）
    const globalMean = new Array(nBands).fill(0);
    if (vectors.length) {
      for (let i = 0; i < nBands; i++) {
        let s = 0;
        for (let j = 0; j < vectors.length; j++) s += vectors[j].z[j];
        globalMean[i] = s / vectors.length;
      }
    }

    const models = [];
    classIds.forEach(function (id) {
      const list = byClass.get(id) || [];
      const n = list.length;
      const mean = new Array(nBands).fill(0);
      const variance = globalVar.slice();
      if (n > 0) {
        for (let b = 0; b < nBands; b++) {
          let s = 0;
          for (let i = 0; i < n; i++) s += list[i].z[b];
          mean[b] = s / n;
        }
        if (n > 1) {
          for (let b = 0; b < nBands; b++) {
            let s = 0;
            for (let i = 0; i < n; i++) {
              const d = list[i].z[b] - mean[b];
              s += d * d;
            }
            let v = s / (n - 1);
            // 方差下限：防止某个波段在类内完全一致时似然爆掉
            if (!(v > 1e-9)) v = Math.max(1e-6, globalVar[b] * 0.01);
            variance[b] = v;
          }
        }
      } else {
        for (let b = 0; b < nBands; b++) mean[b] = globalMean[b];
      }
      models.push({
        classId: id,
        count: n,
        mean: mean,
        variance: variance,
        // 先验：默认按样本数（等权时可用 opts.priors 覆盖）
        prior: n > 0 ? n / Math.max(1, vectors.length) : 1 / Math.max(1, classIds.length),
      });
    });

    return {
      method: method,
      nBands: nBands,
      bandNames: grid.bands.map(function (b) { return b.name; }),
      stats: stats,
      classes: models,
      sampleCount: vectors.length,
      usedCount: vectors.length,
      skippedCount: (samples || []).length - vectors.length,
      priors: opts.priors || null,
    };
  }

  /**
   * 判定一个像元向量属于哪一类。
   *
   * @param {object} model
   * @param {number[]} values 原始波段值
   * @returns {object} { classId, scores, method }
   */
  function classifyPoint(model, values) {
    if (!model || !values || values.length !== model.nBands) return null;
    const z = standardize(values, model.stats);
    const scores = model.classes.map(function (cm) {
      if (model.method === '最大似然') {
        let ll = Math.log(Math.max(1e-12, cm.prior));
        for (let b = 0; b < model.nBands; b++) {
          const d = z[b] - cm.mean[b];
          const v = cm.variance[b];
          ll += -0.5 * (d * d / v + Math.log(v));
        }
        return ll;
      }
      let s = 0;
      for (let b = 0; b < model.nBands; b++) {
        const d = z[b] - cm.mean[b];
        s += d * d;
      }
      return -s;   // 距离越小越好，取负号统一成「越大越好」
    });
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[best]) best = i;
    }
    return {
      classId: model.classes[best] ? model.classes[best].classId : -1,
      scores: scores,
      method: model.method,
    };
  }

  /**
   * 对整个格网分类。
   * @returns {object} { classes: Int32Array(-1 表示无数据), table: [{classId, count}] }
   */
  function classifyGrid(model, grid) {
    const w = grid.w, h = grid.h;
    const n = w * h;
    const out = new Int32Array(n);
    out.fill(-1);
    const counts = new Map();
    model.classes.forEach(function (cm) { counts.set(cm.classId, 0); });

    const nb = model.nBands;
    const vals = new Array(nb);
    for (let i = 0; i < n; i++) {
      let bad = false;
      for (let b = 0; b < nb; b++) {
        const v = grid.bands[b].data[i];
        if (!isNum(v)) { bad = true; break; }
        vals[b] = v;
      }
      if (bad) continue;
      const r = classifyPoint(model, vals);
      if (!r) continue;
      out[i] = r.classId;
      counts.set(r.classId, (counts.get(r.classId) || 0) + 1);
    }

    const table = [];
    counts.forEach(function (count, classId) {
      table.push({ classId: classId, count: count });
    });
    table.sort(function (a, b) { return a.classId - b.classId; });
    return { classes: out, table: table, total: n };
  }

  /* ============================================================ 精度评价 */

  /**
   * 训练并立即算混淆矩阵的便捷入口。
   * @returns {object} { model, confusion }
   */
  function trainAndEvaluate(grid, samples, classes, opts) {
    const model = train(grid, samples, classes, opts);
    const conf = evaluate(model, grid, samples);
    return { model: model, confusion: conf };
  }

  /** 用格网与样本算混淆矩阵（不改 model 本身）。 */
  function evaluate(model, grid, samples) {
    const ids = model.classes.map(function (c) { return c.classId; });
    const idx = new Map();
    ids.forEach(function (id, i) { idx.set(id, i); });
    const k = ids.length;
    const matrix = [];
    for (let i = 0; i < k; i++) matrix.push(new Array(k).fill(0));

    let total = 0, correct = 0;
    (samples || []).forEach(function (s) {
      const v = sampleAt(grid, s.lon, s.lat);
      if (!v) return;
      const r = classifyPoint(model, v);
      if (!r) return;
      total++;
      const gi = idx.has(s.classId) ? idx.get(s.classId) : -1;
      const pi = idx.has(r.classId) ? idx.get(r.classId) : -1;
      if (gi >= 0 && pi >= 0) matrix[gi][pi]++;
      if (gi === pi) correct++;
    });

    const perClass = ids.map(function (id, i) {
      let support = 0;
      for (let j = 0; j < k; j++) support += matrix[i][j];
      let predicted = 0;
      for (let j = 0; j < k; j++) predicted += matrix[j][i];
      const tp = matrix[i][i];
      const precision = predicted > 0 ? tp / predicted : 0;
      const recall = support > 0 ? tp / support : 0;
      const f1 = (precision + recall) > 0
        ? (2 * precision * recall) / (precision + recall) : 0;
      return {
        classId: id, support: support, predicted: predicted,
        precision: precision, recall: recall, f1: f1,
      };
    });

    return {
      matrix: matrix,
      ids: ids,
      total: total,
      accuracy: total > 0 ? correct / total : 0,
      perClass: perClass,
    };
  }

  /* ============================================================ K-Means */

  /**
   * 非监督分类（K-Means）。
   *
   * @param {object} grid
   * @param {number} k 类别数
   * @param {object} opts { maxIter, seed }
   * @returns {object} { classes: Int32Array, table, centroids, k }
   */
  function kmeans(grid, k, opts) {
    opts = opts || {};
    const nBands = grid.bands.length;
    k = clampInt(k, 2, 12);
    const stats = bandStats(grid);
    const n = grid.w * grid.h;

    // 收集有效像元（标准化）
    const pts = [];
    const idxs = [];
    for (let i = 0; i < n; i++) {
      const vals = new Array(nBands);
      let bad = false;
      for (let b = 0; b < nBands; b++) {
        const v = grid.bands[b].data[i];
        if (!isNum(v)) { bad = true; break; }
        vals[b] = v;
      }
      if (bad) continue;
      pts.push(standardize(vals, stats));
      idxs.push(i);
    }
    if (!pts.length) {
      return {
        classes: new Int32Array(n).fill(-1), table: [], centroids: [],
        k: k, valid: 0,
      };
    }

    // 初始中心：沿第一维分位取点（确定性，无随机）
    const first = pts.map(function (p) { return p[0]; }).slice().sort(function (a, b) { return a - b; });
    const centroids = [];
    for (let c = 0; c < k; c++) {
      const q = Math.min(first.length - 1, Math.round((c + 0.5) * (first.length - 1) / k));
      const seed = pts[q];
      const centroid = new Array(nBands);
      for (let b = 0; b < nBands; b++) centroid[b] = seed[b];
      centroids.push(centroid);
    }

    const assign = new Int32Array(pts.length);
    const maxIter = clampInt(opts.maxIter, 1, 100);
    for (let iter = 0; iter < maxIter; iter++) {
      let moved = 0;
      for (let i = 0; i < pts.length; i++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          let s = 0;
          for (let b = 0; b < nBands; b++) {
            const d = pts[i][b] - centroids[c][b];
            s += d * d;
          }
          if (s < bestD) { bestD = s; best = c; }
        }
        if (assign[i] !== best) { assign[i] = best; moved++; }
      }
      // 更新中心
      const sums = [];
      const cnts = new Array(k).fill(0);
      for (let c = 0; c < k; c++) sums.push(new Array(nBands).fill(0));
      for (let i = 0; i < pts.length; i++) {
        const c = assign[i];
        cnts[c]++;
        for (let b = 0; b < nBands; b++) sums[c][b] += pts[i][b];
      }
      for (let c = 0; c < k; c++) {
        if (!cnts[c]) continue;
        for (let b = 0; b < nBands; b++) centroids[c][b] = sums[c][b] / cnts[c];
      }
      if (!moved) break;
    }

    const classes = new Int32Array(n).fill(-1);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < pts.length; i++) {
      classes[idxs[i]] = assign[i];
      counts[assign[i]]++;
    }
    const table = [];
    for (let c = 0; c < k; c++) {
      table.push({ classId: c, count: counts[c] });
    }
    return { classes: classes, table: table, centroids: centroids, k: k, valid: pts.length };
  }

  /* ============================================================== 对外 API */

  const api = {
    METHODS: METHODS,
    makeGrid: makeGrid,
    sampleAt: sampleAt,
    bandStats: bandStats,
    standardize: standardize,
    train: train,
    trainAndEvaluate: trainAndEvaluate,
    classifyPoint: classifyPoint,
    classifyGrid: classifyGrid,
    evaluate: evaluate,
    kmeans: kmeans,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LERasterClassify = api;
})(typeof window !== 'undefined' ? window : globalThis);

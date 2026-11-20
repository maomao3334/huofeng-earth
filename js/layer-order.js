/*
 * 图层栈管理器（js/layer-order.js）
 * ---------------------------------------------------------------------------
 * 【为什么需要】
 *   修三个实际存在的 bug：
 *     1. 自己导入的图层没法置顶 —— terrain.js 的 raiseActiveImagery()
 *        用 imageryLayers.raiseToTop() 把卫星影像提到最顶层，压过了用户图层；
 *     2. 自带的影像关不掉 —— syncImagery() 每次缩放都执行 setVisible(true)，
 *        把用户手动隐藏的影像复活；用户删掉该层后，下次 syncImagery()
 *        按名字找不到还会**重新创建**一个；
 *     3. 置顶后一缩放又下沉 —— 同 1，缩放触发 syncDetailHillshade() → syncImagery()
 *        → raiseToTop()，用户的图层顺序被改回去。
 *
 *   根因是**图层顺序没有单一数据源**：Cesium 的实际栈序被多处代码各自用
 *   raiseToTop 改写，用户的手工排序无处记录，于是被系统逻辑覆盖。
 *
 * 【做法】
 *   本模块持有唯一的「期望栈序」（order 数组，自底向上）。
 *   任何改动（图层增删、用户上移下移、系统挂载阴影）都只改这个数组，
 *   再由 apply() 一次性把 Cesium 的实际栈序对齐过去。
 *
 *   插入规则（决定了「系统层」与「用户层」的相对位置）：
 *     · base      永远最底（蓝马赛克底图，必须压在所有覆盖层之下）
 *     · hillshade 插到第一个 satellite 层之前（阴影在影像之下）
 *     · satellite 插到第一个 user 层之前（自带影像在用户导入层之下）
 *     · user     追加到最顶（用户导入/加载的层永远压在系统层上面）
 *
 *   【插入位置按类别排名计算，而不是「碰巧遇到的第一同类层」】
 *   早期实现是「插到第一个同类层之前，找不到同类层就追加到末尾」，于是：
 *     · base 层因为没有任何 user 层而被推到**最顶**，盖住全部影像；
 *     · 同一个类别的多个层（3 个 s2cloudless）之间的先后顺序取决于
 *       谁先注册，多次启动观察到 order() 前后不一致。
 *   现在改成按固定排名 base < hillshade < satellite < user 计算插入点，
 *   无论注册顺序如何，最终栈序都相同。
 *
 *   用户在图层面板里手工上移/下移时，order 按用户操作整体重写，
 *   此后系统再怎么挂载阴影都不会把它挪回去。
 *
 * 对外 API（window.LELayerOrder）：
 *   init(le)
 *   addUser(entry)      用户来源的影像层（导入 / 仓库加载 / XYZ 目录）
 *   addSystem(entry, kind)  kind: 'base' | 'hillshade' | 'satellite'
 *   remove(entry)       图层被删除时同步移出
 *   move(entry, delta)    用户上移(+1)/下移(-1)（数组自底向上，+1 = 更靠上）
 *   moveToTop(entry)    用户置顶
 *   apply()             把期望栈序写回 Cesium
 *   order()             当前期望栈序（调试/测试用）
 */
(function () {
  'use strict';

  const state = {
    le: null,
    order: [],   // entries，自底向上
  };

  /**
   * 类别排名：数字越小越靠底。
   * 用它计算插入点，保证「无论注册顺序如何，最终栈序都一样」。
   *
   * 【baked = 2.5 的位置】
   *   预烘焙影像层（卫星 × 晕渲，js/gep-mode.js）必须**压过**超清层（satellite=2），
   *   因为它只覆盖一小块区域，区域外的像素要靠超清层兜底。
   *   插入规则是「插到第一个排名比自己高的层之前」，所以排名 2.5 的 baked 层：
   *     · 在 ultra 之后注册 → 排到 ultra 上面（ultra 插入时先撞到 baked）；
   *     · 在 ultra 之前注册 → ultra 注册时插到 baked 之前（= baked 在 ultra 上面）。
   *   两种注册顺序结果一致。
   */
  const KIND_RANK = {
    base: 0,
    hillshade: 1,
    satellite: 2,
    baked: 2.5,
    user: 3,
  };

  function rankOf(entry) {
    const r = KIND_RANK[entry && entry.orderKind];
    return r === undefined ? KIND_RANK.user : r;
  }

  function byId(id) { return document.getElementById(id); }

  function getLE() {
    return state.le || window.LE;
  }

  function isImageryEntry(entry) {
    return !!(entry && entry.imageryLayer);
  }

  function indexOfEntry(entry) {
    for (let i = 0; i < state.order.length; i++) {
      if (state.order[i] === entry) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * 增删
   * ------------------------------------------------------------------ */

  /**
   * 登记一个用户来源的影像层（导入的数据仓库图层、XYZ 目录、本地影像…）。
   * 用户层永远排在系统层之上。
   */
  function addUser(entry) {
    if (!isImageryEntry(entry)) return null;
    if (indexOfEntry(entry) >= 0) return entry;
    entry.orderKind = 'user';
    state.order.push(entry);
    apply();
    return entry;
  }

  /**
   * 登记一个系统托管的影像层。
   * @param {object} entry
   * @param {string} kind 'base' | 'hillshade' | 'satellite'
   */
  function addSystem(entry, kind) {
    if (!isImageryEntry(entry)) return null;
    if (indexOfEntry(entry) >= 0) {
      entry.orderKind = kind;
      apply();
      return entry;
    }
    entry.orderKind = kind;
    // 按类别排名插入：找到第一个排名比自己低的层，插到它前面；没有就追加到末尾。
    // 这样 base 永远在最底、hillshade 在 satellite 之下、satellite 在 user 之下，
    // 与注册顺序无关。
    const myRank = rankOf(entry);
    let at = -1;
    for (let i = 0; i < state.order.length; i++) {
      if (rankOf(state.order[i]) > myRank) { at = i; break; }
    }
    if (at < 0) state.order.push(entry);
    else state.order.splice(at, 0, entry);
    apply();
    return entry;
  }

  /** 图层被删除时同步移出期望栈序。 */
  function remove(entry) {
    const idx = indexOfEntry(entry);
    if (idx < 0) return false;
    state.order.splice(idx, 1);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 用户排序
   * ------------------------------------------------------------------ */

  /**
   * 用户在图层面板里上移/下移一层。
   *
   * 注意方向约定：order 数组是**自底向上**的，数组下标越大越靠上。
   * 所以 delta = +1 表示「上移」（更靠上），delta = -1 表示「下移」。
   *
   * @param {object} entry
   * @param {number} delta +1 上移，-1 下移
   */
  function move(entry, delta) {
    const idx = indexOfEntry(entry);
    if (idx < 0) return false;
    const target = idx + (delta > 0 ? 1 : -1);
    if (target < 0 || target >= state.order.length) return false;
    state.order.splice(idx, 1);
    state.order.splice(target, 0, entry);
    apply();
    return true;
  }

  /** 用户置顶。 */
  function moveToTop(entry) {
    const idx = indexOfEntry(entry);
    if (idx < 0) return false;
    state.order.splice(idx, 1);
    state.order.push(entry);
    apply();
    return true;
  }

  /** 用户置底（在所有层之下，但仍高于底图本身）。 */
  function moveToBottom(entry) {
    const idx = indexOfEntry(entry);
    if (idx < 0) return false;
    state.order.splice(idx, 1);
    state.order.unshift(entry);
    apply();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 写回 Cesium
   * ------------------------------------------------------------------ */

  /**
   * 把期望栈序写回 Cesium 的 ImageryLayerCollection。
   *
   * 手法：按期望顺序（自底向上）依次 raiseToTop —— 每一次 raiseToTop
   * 都把该层挪到最顶，所以**最后**处理的层留在最顶，
   * 整体结果恰好等于期望顺序（自底向上）。
   *
   * 例：期望 [A,B,C]，初始 [X,A,B,C]
   *   raiseToTop(A) → [X,B,C,A]
   *   raiseToTop(B) → [X,C,A,B]
   *   raiseToTop(C) → [X,A,B,C]   ✓ 与期望一致
   */
  function apply() {
    const le = getLE();
    if (!le || !le.viewer || !le.viewer.imageryLayers) return false;
    const layers = le.viewer.imageryLayers;

    // 清掉已经被删掉的层
    state.order = state.order.filter(function (e) {
      if (!isImageryEntry(e)) return false;
      try {
        return layers.contains(e.imageryLayer);
      } catch (err) {
        return false;
      }
    });

    for (let i = 0; i < state.order.length; i++) {
      const entry = state.order[i];
      try {
        if (!layers.contains(entry.imageryLayer)) continue;
        layers.raiseToTop(entry.imageryLayer);
      } catch (err) {
        console.debug('[LELayerOrder] 调整层级失败：', err);
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 查询
   * ------------------------------------------------------------------ */

  /** 当前期望栈序（自底向上的层名）。 */
  function order() {
    return state.order.map(function (e) { return e.name || ''; });
  }

  /** 某个图层在期望栈序里的位置（0 = 最底）。 */
  function indexOf(entry) {
    return indexOfEntry(entry);
  }

  /** 某个图层是否在期望栈序里。 */
  function has(entry) {
    return indexOfEntry(entry) >= 0;
  }

  /**
   * 兜底：把当前 Cesium 实际栈序里、但尚未登记的影像层补登记进来。
   * 这样即使某条路径绕过了 addUser/addSystem，顺序也不会丢。
   *
   * 补登记时按名称猜类别，并插入到**正确的位置**（而不是简单追加到末尾），
   * 否则会把阴影层追加到用户层之上。
   */
  function adoptOrphans() {
    const le = getLE();
    if (!le || !le.viewer || !le.viewer.imageryLayers) return;
    const layers = le.viewer.imageryLayers;
    const entries = le.listLayers ? le.listLayers() : [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers.get(i);
      if (!layer) continue;
      let found = null;
      for (let j = 0; j < entries.length; j++) {
        if (entries[j].imageryLayer === layer) { found = entries[j]; break; }
      }
      if (!found) continue;
      if (indexOfEntry(found) >= 0) continue;
      const name = String(found.name || '');
      if (/蓝马赛克|blue.?marble|底图/i.test(name)) {
        addSystem(found, 'base');
      } else if (/阴影|hillshade|shade/i.test(name)) {
        addSystem(found, 'hillshade');
      } else if (/烘焙|baked/i.test(name)) {
        // 预烘焙影像层（卫星 × 晕渲 乘法合成）：压在卫星影像之上
        addSystem(found, 'baked');
      } else if (/卫星影像|Sentinel/i.test(name)) {
        addSystem(found, 'satellite');
      } else {
        addUser(found);
      }
    }
  }

  function init(le) {
    state.le = le || window.LE;
    if (!state.le) return;
  }

  window.LELayerOrder = {
    init: init,
    addUser: addUser,
    addSystem: addSystem,
    remove: remove,
    move: move,
    moveToTop: moveToTop,
    moveToBottom: moveToBottom,
    apply: apply,
    order: order,
    indexOf: indexOf,
    has: has,
    adoptOrphans: adoptOrphans,
  };

  if (window.LE && window.LE.viewer) init(window.LE);
  else document.addEventListener('local-earth-ready', function (ev) {
    init((ev && ev.detail) || window.LE);
  }, { once: true });
})();

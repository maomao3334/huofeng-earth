/*
 * NetCDF 经典格式读取内核（纯计算，不依赖 Cesium / DOM）
 * ---------------------------------------------------------------------------
 * P2-4.11「NetCDF / 气象栅格叠加」的内核部分。
 *
 * 【为什么要自己写，而不用 Python 转换】
 *   1) 纯离线的硬约束 —— 浏览���直接读文件，不需要起后端转换进程；
 *   2) 气象数据是交互式的（换变量、换高度层、换色带要立刻重画），
 *      走 Python 来回转换每换一次就要几十秒，没法用；
 *   3) 已有的 tools/netcdf_to_windninja_ascii.py 是给风场计算用的，
 *      只认 U_wind/V_wind 布局，跟通用气象栅格（温度/气压/湿度/降水）不是一回事。
 *
 * 【支持范围】
 *   · NetCDF classic (CDF-1) 与 64-bit offset (CDF-2)
 *   · 类型：byte / char / short / int / float / double
 *     （CDF-5 的 64 位整数类型不解析 —— 气象数据里几乎不用）
 *   · 无维度标量变量、记录变量（unlimited dim）、字符串属性
 *   · CF 约定：standard_name / units / axis / coordinates / positive
 *   · HDF5 封装的 NetCDF-4（.nc4 / .h5）**不解析** —— 会明确报错，
 *     而不是给出一堆垃圾数据。
 *
 * 【对外 API（window.LENetCDF = module.exports）】
 *   parse(buffer)            → {ok, error, dataset}
 *   isNetCDF(buffer)         → boolean
 *   readVariable(ds, name)   → {ok, data, dims, shape, type, attrs}
 *   describe(ds)             → 变量清单（按「是不是气象要素」分类）
 *   decodeTime(ds, varName)  → 时间轴（CF time units 解码）
 *   cfLevel(ds, varName)     → 垂直层次轴
 *   subset(ds, name, ...)    → 取某一层/某一时刻
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LENetCDF = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 常量
   * ================================================================ */

  const NC_BYTE = 1, NC_CHAR = 2, NC_SHORT = 3, NC_INT = 4,
        NC_FLOAT = 5, NC_DOUBLE = 6;

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
  const TYPE_NAME = { 1: 'byte', 2: 'char', 3: 'short', 4: 'int', 5: 'float', 6: 'double' };

  const NC_DIMENSION = 0x0a, NC_VARIABLE = 0x0b, NC_ATTRIBUTE = 0x0c;

  /* ================================================================
   * 二进制游标（大端 —— NetCDF 规定所有标量都是网络字节序）
   * ================================================================ */

  class Cursor {
    constructor(buf, pos, littleEndian) {
      this.buf = buf;
      this.view = new DataView(buf);
      this.pos = pos || 0;
      // NetCDF classic 永远是 big-endian；CDF-5 才可能 little-endian。
      this.le = !!littleEndian;
    }
    get eof() { return this.pos >= this.buf.byteLength; }

    /**
     * 越界检查。
     *
     * 【为什么必须有】
     *   文件被截断 / 损坏时按格式读下去会读到缓冲区之外，
     *   DataView.getUint32 直接抛 RangeError —— 一个坏文件能把整个应用搞崩。
     *   这里抛带说明的 Error，由 parse() 统一转成 {ok:false, error}。
     */
    need(n) {
      if (this.pos + n > this.buf.byteLength) {
        throw new Error('NetCDF 文件已截断（读到 ' + this.pos +
          ' 字节处还需要 ' + n + ' 字节，但文件只有 ' +
          this.buf.byteLength + ' 字节）');
      }
    }
    u8() { this.need(1); return this.view.getUint8(this.pos++); }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; }
    i32() { this.need(4); const v = this.view.getInt32(this.pos, this.le); this.pos += 4; return v; }
    f32() { this.need(4); const v = this.view.getFloat32(this.pos, this.le); this.pos += 4; return v; }
    f64() { this.need(8); const v = this.view.getFloat64(this.pos, this.le); this.pos += 8; return v; }
    /** NC_STRING（仅 CDF-5）—— 经典格式没有，这里返回 4 字节长度。 */
    str4() {
      const n = this.u32();
      this.need(n);
      const bytes = new Uint8Array(this.buf, this.pos, n);
      this.skip(n);
      this.skip(pad4(n));
      return decodeText(bytes);
    }
    skip(n) { this.pos += n; }
  }

  function pad4(n) { return (4 - (n % 4)) % 4; }

  /**
   * 字节序列 → 字符串。
   *
   * NetCDF 的 NC_CHAR 是**字节流**，CF 约定里属性文本按 UTF-8 编码。
   * 早先逐字节 String.fromCharCode 得到的是「每个字节一个字符」的乱码
   * （'测试' 变成 'æµè¯'）—— 必须按 UTF-8 解。
   * 解不出来（真·Latin-1）时退回逐字节。
   */
  function decodeText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  /* ================================================================
   * 头部解析
   * ================================================================ */

  /**
   * 解析 NetCDF 文件。
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {{ok:boolean, error?:string, dataset?:object}}
   */
  function parse(buffer) {
    let buf;
    if (buffer instanceof ArrayBuffer) buf = buffer;
    else if (buffer && buffer.buffer instanceof ArrayBuffer) {
      buf = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else {
      return { ok: false, error: '不是二进制数据' };
    }
    if (buf.byteLength < 8) return { ok: false, error: '文件太小，不是 NetCDF' };

    // 【必须先开一个 Uint8Array 视图】
    //   ArrayBuffer 本身**不能按索引取值** —— buf[0] 永远是 undefined，
    //   于是 String.fromCharCode(undefined,...) 得到 '���'，
    //   任何文件都被判成「不是 NetCDF」。这是本功能第一个真实 bug。
    const u8 = new Uint8Array(buf);
    const head = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (head === 'CDF') {
      // classic / 64-bit offset
      try {
        return parseClassic(buf);
      } catch (err) {
        return { ok: false, error: 'NetCDF 文件解析失败：' +
          String(err && err.message ? err.message : err) };
      }
    }
    if (u8[0] === 0x89 && u8[1] === 0x48 && u8[2] === 0x44 && u8[3] === 0x46) {
      return { ok: false, error: '这是 HDF5 文件，不是 NetCDF 经典格式（CDF-1 / CDF-2）' };
    }
    if (u8[0] === 0x89 && u8[1] === 0x48) {
      return { ok: false, error: '这是 HDF5 封装的 NetCDF-4 格式，本内核只支持经典格式（CDF-1 / CDF-2）' };
    }
    return { ok: false, error: '不是 NetCDF 文件（缺少 CDF 魔数）' };
  }

  function parseClassic(buf) {
    const c = new Cursor(buf, 3);
    const version = c.u8();
    if (version !== 1 && version !== 2) {
      return { ok: false, error: '不支持的 NetCDF 版本：' + version };
    }
    const is64 = version === 2;
    // numrecs 在 CDF-1 与 CDF-2 里**都是 4 字节**；变的是变量 begin 偏移（8 字节）。
    const numrecs = c.u32();

    const dims = readDimList(c);
    const gattrs = readAttrList(c);
    const vars = readVarList(c, is64);

    if (!dims.ok) return { ok: false, error: dims.error };
    if (!gattrs.ok) return { ok: false, error: gattrs.error };
    if (!vars.ok) return { ok: false, error: vars.error };

    // 把维度长度从 UNLIMITED(0) 换成实际记录数。
    // 【只有原本就是 0 的维度才是 unlimited】
    //   早先无条件写 d.unlimited = true，结果**每个**维度都成了 unlimited，
    //   于是所有以第 0 维开头的变量都被当成记录变量去读，读出来的全是 0。
    dims.list.forEach(function (d) {
      if (d.size === 0) { d.size = numrecs; d.unlimited = true; }
      else { d.unlimited = false; }
    });

    const dataset = {
      version: version,
      numrecs: numrecs,
      dims: dims.list,
      attrs: gattrs.map,
      vars: vars.list.map(function (v) {
        return {
          name: v.name,
          type: v.type,
          typeName: TYPE_NAME[v.type] || ('type' + v.type),
          size: TYPE_SIZE[v.type] || 0,
          dimIds: v.dimIds,
          dims: v.dimIds.map(function (i) { return dims.list[i] ? dims.list[i].name : '?'; }),
          shape: v.dimIds.map(function (i) { return dims.list[i] ? dims.list[i].size : 0; }),
          attrs: v.attrs,
          begin: v.begin,
          vsize: v.vsize,
          // 记录变量 = 第一个维度是 unlimited
          isRecord: v.dimIds.length > 0 && dims.list[v.dimIds[0]] &&
                dims.list[v.dimIds[0]].unlimited,
        };
      }),
    };

    // 【记录变量在文件里是「按记录交织」存放的】
    //   不是每个记录变量各占一块连续区域，而是：
    //     记录 0：varA 的第 0 条 | varB 的第 0 条 | ...
    //     记录 1：varA 的第 1 条 | varB 的第 1 条 | ...
    //   早先按「begin + r * vsize」算偏移，读出来全是 0。
    //   正确算法：从第一个记录变量的 begin 开始，按「记录序 → 变量声明序」累加。
    const recVars = dataset.vars.filter(function (v) { return v.isRecord; });
    if (recVars.length) {
      let off = Math.min.apply(null, recVars.map(function (v) { return v.begin; }));
      for (let r = 0; r < numrecs; r++) {
        recVars.forEach(function (v) {
          if (!v.recordBegin) v.recordBegin = [];
          v.recordBegin[r] = off;
          off += v.vsize;
        });
      }
    }

    // 读数据
    const ds = dataset;
    ds.vars.forEach(function (v) {
      try {
        v.data = readVarData(buf, v, ds);
      } catch (err) {
        v.data = null;
        v.readError = String(err && err.message ? err.message : err);
      }
    });

    return { ok: true, dataset: ds };
  }

  function readU64(c, buf) {
    // 经典 NetCDF 里 64 位记录数极少用，取低 32 位足够；
    // 超过 2^32 的数据集在浏览器里也读不动。
    const lo = c.view.getUint32(c.pos, false);
    const hi = c.view.getUint32(c.pos + 4, false);
    c.pos += 8;
    return hi > 0 ? lo : lo;   // 高位非 0 时取低位（并由后面的尺寸校验兜住）
  }

  /**
   * 读一个列表（dim_list / gatt_list / var_list）。
   *
   * 【关键：ABSENT 是 8 个零字节，不是 4 个】
   *   NetCDF classic 规范里，列表的「空」表示是
   *     ZERO(tag) + ZERO(nelems)  —— **两**个 4 字节。
   *   早先只跳过 tag 的 4 个字节，后面所有内容都**错位 4 字节**：
   *   无量纲的 .nc 文件（dim_list 为空）会被读成「变量列表标记异常」。
   */
  function readDimList(c) {
    const tag = c.u32();
    if (tag === 0) { c.skip(4); return { ok: true, list: [] }; }
    if (tag !== NC_DIMENSION) return { ok: false, error: '维度列表标记异常：0x' + tag.toString(16) };
    const n = c.u32();
    const list = [];
    for (let i = 0; i < n; i++) {
      const name = c.str4();
      const size = c.u32();
      list.push({ name: name, size: size, unlimited: false });
    }
    return { ok: true, list: list };
  }

  function readAttrList(c) {
    const tag = c.u32();
    if (tag === 0) { c.skip(4); return { ok: true, map: {} }; }
    if (tag !== NC_ATTRIBUTE) return { ok: false, error: '属性列表标记异常：0x' + tag.toString(16) };
    const n = c.u32();
    const map = {};
    for (let i = 0; i < n; i++) {
      const a = readAttr(c);
      map[a.name] = a.value;
    }
    return { ok: true, map: map };
  }

  function readAttr(c) {
    const name = c.str4();
    const type = c.u32();
    const nelems = c.u32();
    const value = readValues(c, type, nelems);
    return { name: name, type: type, value: value };
  }

  function readVarList(c, is64) {
    const tag = c.u32();
    if (tag === 0) { c.skip(4); return { ok: true, list: [] }; }
    if (tag !== NC_VARIABLE) return { ok: false, error: '变量列表标记异常：0x' + tag.toString(16) };
    const n = c.u32();
    const list = [];
    for (let i = 0; i < n; i++) {
      const name = c.str4();
      const ndims = c.u32();
      const dimIds = [];
      for (let d = 0; d < ndims; d++) dimIds.push(c.u32());
      const vattrs = readAttrList(c);
      const type = c.u32();
      const vsize = c.u32();
      const begin = is64 ? readU64Offset(c) : c.u32();
      list.push({
        name: name, dimIds: dimIds, attrs: vattrs.map || {},
        type: type, vsize: vsize, begin: begin,
      });
    }
    return { ok: true, list: list };
  }

  function readU64Offset(c) {
    const lo = c.view.getUint32(c.pos, false);
    const hi = c.view.getUint32(c.pos + 4, false);
    c.pos += 8;
    return lo + (hi * 4294967296);
  }

  /** 读 nelems 个 type 类型的值（属性/变量数据通用）。 */
  function readValues(c, type, nelems) {
    if (type === NC_CHAR) {
      c.need(nelems);
      const bytes = new Uint8Array(c.buf, c.pos, nelems);
      c.skip(nelems);
      c.skip(pad4(nelems));
      return decodeText(bytes);
    }
    const out = new Float64Array(nelems);
    c.need(nelems * (TYPE_SIZE[type] || 1));
    for (let i = 0; i < nelems; i++) {
      switch (type) {
        case NC_BYTE: out[i] = c.view.getInt8(c.pos); c.pos += 1; break;
        case NC_SHORT: out[i] = c.view.getInt16(c.pos, c.le); c.pos += 2; break;
        case NC_INT: out[i] = c.view.getInt32(c.pos, c.le); c.pos += 4; break;
        case NC_FLOAT: out[i] = c.view.getFloat32(c.pos, c.le); c.pos += 4; break;
        case NC_DOUBLE: out[i] = c.view.getFloat64(c.pos, c.le); c.pos += 8; break;
        default: out[i] = NaN;
      }
    }
    c.skip(pad4(nelems * (TYPE_SIZE[type] || 1)));
    return out;
  }

  /* ================================================================
   * 数据读取
   * ================================================================ */

  /**
   * 读一个变量的全部数据。
   *
   * 存储布局（NetCDF classic）：
   *   · 非记录变量：一整块连续数据，行主序
   *   · 记录变量：按记录切片交错存放，每片是「除记录维以外的所有维」的乘积
   */
  function readVarData(buf, v, ds) {
    const shape = v.shape;
    const total = shape.reduce(function (a, b) { return a * b; }, 1);
    const view = new DataView(buf);
    const le = false;   // 经典格式固定大端

    const out = new Float64Array(total);
    const esz = v.size;

    function readBlock(offset, count, dimIndex, base) {
      // dimIndex：当前展开到第几维（记录变量从第 1 维开始）
      let p = offset;
      let idx = base;
      let stride = 1;
      for (let d = shape.length - 1; d >= dimIndex; d--) stride *= shape[d];
      const chunk = stride;
      for (let i = 0; i < count / chunk; i++) {
        for (let j = 0; j < chunk; j++) {
          out[idx++] = readScalar(view, p + j * esz, v.type, le);
        }
        p += chunk * esz;
      }
    }

    if (!v.isRecord) {
      if (shape.length === 0) {
        out[0] = readScalar(view, v.begin, v.type, le);
        return out;
      }
      readBlock(v.begin, total, 0, 0);
      return out;
    }

    // 记录变量：每条记录一块，偏移由 header 计算（见 parseClassic）
    const recDims = shape.slice(1);
    const perRec = recDims.reduce(function (a, b) { return a * b; }, 1) || 1;
    const offs = v.recordBegin || [];
    for (let r = 0; r < ds.numrecs; r++) {
      const off = offs[r];
      if (off == null) break;
      if (off + perRec * esz > buf.byteLength) break;
      readBlock(off, perRec, 1, r * perRec);
    }
    return out;
  }

  function readScalar(view, off, type, le) {
    const need = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }[type] || 1;
    if (off < 0 || off + need > view.byteLength) return NaN;
    switch (type) {
      case NC_BYTE: return view.getInt8(off);
      case NC_CHAR: return view.getUint8(off);
      case NC_SHORT: return view.getInt16(off, le);
      case NC_INT: return view.getInt32(off, le);
      case NC_FLOAT: return view.getFloat32(off, le);
      case NC_DOUBLE: return view.getFloat64(off, le);
      default: return NaN;
    }
  }

  /* ================================================================
   * CF / 语义
   * ================================================================ */

  /** 判断是不是 NetCDF（不抛异常）。 */
  function isNetCDF(buffer) {
    try {
      const buf = buffer instanceof ArrayBuffer ? buffer
        : (buffer && buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : null);
      if (!buf || buf.byteLength < 4) return false;
      const u8 = new Uint8Array(buf);
      return String.fromCharCode(u8[0], u8[1], u8[2]) === 'CDF';
    } catch (e) { return false; }
  }

  const KIND_PATTERNS = [
    { kind: 'wind-u', re: /(x_wind|wind_x|eastward_wind|u_wind|u_component_of_wind|.*^u$)/i, label: '风速 U 分量（东西向）' },
    { kind: 'wind-v', re: /(y_wind|wind_y|northward_wind|v_wind|v_component_of_wind|.*^v$)/i, label: '风速 V 分量（南北向）' },
    { kind: 'wind-speed', re: /(wind_speed|speed_of_wind|.*^windspeed$)/i, label: '风速' },
    { kind: 'wind-dir', re: /(wind_direction|.*^winddir$)/i, label: '风向' },
    { kind: 'temperature', re: /(air_temperature|potential_temperature|temperature|.*^t$|.*^temp$)/i, label: '气温' },
    { kind: 'pressure', re: /(air_pressure|pressure|.*^p$)/i, label: '气压' },
    { kind: 'humidity', re: /(relative_humidity|humidity|.*^rh$)/i, label: '相对湿度' },
    { kind: 'precipitation', re: /(precipitation|rainfall|.*^pr$)/i, label: '降水' },
    { kind: 'geopotential', re: /(geopotential_height|.*^zg$)/i, label: '位势高度' },
    { kind: 'cloud', re: /(cloud_area_fraction|cloud_fraction|.*^cc$)/i, label: '云量' },
    { kind: 'visibility', re: /(visibility|.*^vis$)/i, label: '能见度' },
    { kind: 'radiation', re: /(surface_downwelling_shortwave_flux|radiation|.*^rad$)/i, label: '辐射' },
  ];

  /** 判断一个变量是不是「时间坐标」。 */
  function isTimeVar(v) {
    const a = v.attrs || {};
    const u = String(a.units || '').toLowerCase();
    const sn = String(a.standard_name || '').toLowerCase();
    if (sn === 'time') return true;
    if (a.axis && String(a.axis).toLowerCase() === 't') return true;
    if (/^(seconds?|minutes?|hours?|days?) since /.test(u)) return true;
    if (/^days? since /.test(u)) return true;
    return false;
  }

  /** 判断一个变量是不是「高度 / 层次」坐标。 */
  function isLevelVar(v) {
    const a = v.attrs || {};
    const u = String(a.units || '').toLowerCase();
    const sn = String(a.standard_name || '').toLowerCase();
    if (sn === 'air_pressure' && a.positive === 'down') return true;
    if (a.axis && String(a.axis).toLowerCase() === 'z') return true;
    if (/^(m|metres?|meters?|hpa|mbar|pa)$/.test(u)) return true;
    if (/^(km)$/.test(u)) return true;
    return false;
  }

  /** 判断是不是经纬度坐标。 */
  function isLonVar(v) {
    const a = v.attrs || {};
    // 'degree_east' / 'degrees_east' / 'degree_east longitude' 都要认
    if (a.units && /degrees?[_ ](east|longitude)/i.test(String(a.units))) return true;
    if (a.standard_name === 'longitude') return true;
    return /^(lon|lons|longitude|x)$/i.test(v.name);
  }

  function isLatVar(v) {
    const a = v.attrs || {};
    if (a.units && /degrees?[_ ](north|latitude)/i.test(String(a.units))) return true;
    if (a.standard_name === 'latitude') return true;
    return /^(lat|lats|latitude|y)$/i.test(v.name);
  }

  /** 给变量分类。 */
  function classify(v) {
    const a = v.attrs || {};
    const sn = String(a.standard_name || '');
    const units = String(a.units || '');
    for (const p of KIND_PATTERNS) {
      if (sn && p.re.test(sn)) return { kind: p.kind, label: p.label };
    }
    for (const p of KIND_PATTERNS) {
      if (units && p.re.test(units)) return { kind: p.kind, label: p.label };
    }
    for (const p of KIND_PATTERNS) {
      if (p.re.test(v.name)) return { kind: p.kind, label: p.label };
    }
    return { kind: 'other', label: v.name };
  }

  /**
   * 变量清单 —— 界面直接照这个渲染。
   * @returns {{dims, vars, times, levels}}
   */
  function describe(ds) {
    if (!ds) return { dims: [], vars: [], times: [], levels: [] };
    const timeVar = ds.vars.find(isTimeVar);
    const levelVar = ds.vars.find(isLevelVar);
    const lonVar = ds.vars.find(isLonVar);
    const latVar = ds.vars.find(isLatVar);

    const vars = ds.vars.map(function (v) {
      const cls = classify(v);
      const spatial = v.dimIds.length >= 2;
      return {
        name: v.name,
        kind: cls.kind,
        label: cls.label,
        units: v.attrs && v.attrs.units ? String(v.attrs.units) : '',
        dims: v.dims,
        shape: v.shape,
        isCoord: v === timeVar || v === levelVar || v === lonVar || v === latVar,
        isTime: v === timeVar,
        isLevel: v === levelVar,
        isLon: v === lonVar,
        isLat: v === latVar,
        spatial: spatial,
        ok: !!v.data && v.data.length > 0,
        readError: v.readError || null,
      };
    });

    return {
      dims: ds.dims.map(function (d) { return { name: d.name, size: d.size }; }),
      attrs: ds.attrs,
      vars: vars,
      timeVar: timeVar ? timeVar.name : null,
      levelVar: levelVar ? levelVar.name : null,
      lonVar: lonVar ? lonVar.name : null,
      latVar: latVar ? latVar.name : null,
      times: timeVar ? decodeTime(ds) : [],
      levels: levelVar ? decodeLevel(ds) : [],
    };
  }

  /* ================================================================
   * 时间轴（CF time units）
   * ================================================================ */

  const UNIT_SECONDS = {
    second: 1, seconds: 1, sec: 1, secs: 1, s: 1,
    minute: 60, minutes: 60, min: 60, mins: 60,
    hour: 3600, hours: 3600, hr: 3600, hrs: 3600, h: 3600,
    day: 86400, days: 86400, d: 86400,
  };

  /**
   * 解码时间坐标 → ISO 字符串数组。
   * 支持 "hours since 2020-01-01 00:00:00" 这类 CF 单位。
   */
  function decodeTime(ds) {
    const v = ds.vars.find(isTimeVar);
    if (!v || !v.data) return [];
    const units = String((v.attrs && v.attrs.units) || '').trim();
    const m = units.match(/^([a-zA-Z]+)\s+since\s+(.+)$/);
    if (!m) return [];
    const unitName = m[1].toLowerCase();
    const mult = UNIT_SECONDS[unitName];
    if (!mult) return [];
    const base = parseTimeBase(m[2]);
    if (!base) return [];

    const out = [];
    for (let i = 0; i < v.data.length; i++) {
      const val = v.data[i];
      if (!isFinite(val)) { out.push(null); continue; }
      out.push(new Date(base.getTime() + val * mult * 1000).toISOString());
    }
    return out;
  }

  /** 解析 "2020-01-01 00:00:00" / "2020-01-01T00:00:00Z" / "2020-01-01"。 */
  function parseTimeBase(s) {
    const t = String(s).trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
    if (!m) return null;
    const y = +m[1], mo = +m[2] - 1, da = +m[3];
    const hh = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, ss = m[6] ? +m[6] : 0;
    const d = new Date(Date.UTC(y, mo, da, hh, mi, ss));
    if (isNaN(d.getTime())) return null;
    // 回查分量（2 月 31 日会被 JS 进位）
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== da) return null;
    return d;
  }

  /* ================================================================
   * 垂直层次
   * ================================================================ */

  function decodeLevel(ds) {
    const v = ds.vars.find(isLevelVar);
    if (!v || !v.data) return [];
    const units = String((v.attrs && v.attrs.units) || '').trim();
    const positive = String((v.attrs && v.attrs.positive) || '').toLowerCase();
    const out = [];
    for (let i = 0; i < v.data.length; i++) {
      const val = v.data[i];
      out.push({
        index: i,
        value: val,
        units: units,
        positive: positive || 'up',
        label: formatLevel(val, units),
      });
    }
    return out;
  }

  function formatLevel(v, units) {
    if (!isFinite(v)) return '—';
    const u = String(units || '').toLowerCase();
    if (u === 'pa') return (v / 100).toFixed(1) + ' hPa';
    if (u === 'hpa' || u === 'mbar') return v.toFixed(1) + ' hPa';
    if (u === 'km') return v.toFixed(2) + ' km';
    if (u === 'm') return v.toFixed(0) + ' m';
    return String(v) + (units ? ' ' + units : '');
  }

  /* ================================================================
   * 取子集
   * ================================================================ */

  /**
   * 取变量的一个二维切片（经度 × 纬度）。
   *
   * @param ds      数据集
   * @param name    变量名
   * @param opts    {timeIndex, levelIndex} —— 省略时取 0
   * @returns {{ok, data, width, height, lons, lats, min, max}}
   */
  function slice2d(ds, name, opts) {
    opts = opts || {};
    const v = ds.vars.find(function (x) { return x.name === name; });
    if (!v) return { ok: false, error: '没有这个变量：' + name };
    if (!v.data) return { ok: false, error: '变量数据读取失败：' + (v.readError || '未知') };

    const dims = v.dims;
    // 找出经纬度的位置
    let lonIdx = -1, latIdx = -1;
    dims.forEach(function (d, i) {
      const dv = ds.vars.find(function (x) { return x.name === d; });
      if (dv && isLonVar(dv)) lonIdx = i;
      if (dv && isLatVar(dv)) latIdx = i;
    });
    if (lonIdx < 0 || latIdx < 0) {
      return { ok: false, error: '变量「' + name + '」没有经纬度维度（维度是 ' + dims.join('×') + '）' };
    }

    const shape = v.shape;
    const lonLen = shape[lonIdx];
    const latLen = shape[latIdx];
    const otherDims = [];
    dims.forEach(function (d, i) { if (i !== lonIdx && i !== latIdx) otherDims.push(i); });

    // 其它维度取第几个
    const picks = [];
    otherDims.forEach(function (i) {
      const dv = ds.vars.find(function (x) { return x.name === dims[i]; });
      let pick = 0;
      if (dv && isTimeVar(dv)) pick = opts.timeIndex || 0;
      else if (dv && isLevelVar(dv)) pick = opts.levelIndex || 0;
      picks.push({ dim: i, pick: pick });
    });

    // 行主序下标
    const strides = new Array(shape.length);
    let s = 1;
    for (let d = shape.length - 1; d >= 0; d--) { strides[d] = s; s *= shape[d]; }

    const data = new Float64Array(lonLen * latLen);
    for (let y = 0; y < latLen; y++) {
      for (let x = 0; x < lonLen; x++) {
        let idx = x * strides[lonIdx] + y * strides[latIdx];
        picks.forEach(function (p) { idx += p.pick * strides[p.dim]; });
        data[y * lonLen + x] = v.data[idx];
      }
    }

    // 经纬度轴
    const lonVar = ds.vars.find(isLonVar);
    const latVar = ds.vars.find(isLatVar);
    // 坐标轴长度未必等于场的经纬边长（比如坐标是 1° 间隔、场是裁剪过的）
    const lons = lonVar && lonVar.data
      ? Array.from(lonVar.data.slice(0, Math.min(lonLen, lonVar.data.length))) : null;
    const lats = latVar && latVar.data
      ? Array.from(latVar.data.slice(0, Math.min(latLen, latVar.data.length))) : null;

    return {
      ok: true,
      data: data,
      width: lonLen,
      height: latLen,
      lons: lons,
      lats: lats,
      min: minOf(data),
      max: maxOf(data),
      name: name,
    };
  }

  function minOf(a) {
    let m = Infinity;
    for (let i = 0; i < a.length; i++) if (isFinite(a[i]) && a[i] < m) m = a[i];
    return m === Infinity ? null : m;
  }

  function maxOf(a) {
    let m = -Infinity;
    for (let i = 0; i < a.length; i++) if (isFinite(a[i]) && a[i] > m) m = a[i];
    return m === -Infinity ? null : m;
  }

  /* ================================================================
   * 风场合成（U/V → 速度/风向）
   * ================================================================ */

  /**
   * 从 U/V 分量算出风速与风向。
   * @returns {{ok, speed:Float64Array, dir:Float64Array}}
   */
  function windFromUV(u, v) {
    const n = Math.min(u.length, v.length);
    const speed = new Float64Array(n);
    const dir = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = u[i], b = v[i];
      if (!isFinite(a) || !isFinite(b)) { speed[i] = NaN; dir[i] = NaN; continue; }
      speed[i] = Math.sqrt(a * a + b * b);
      // 【气象风向 = 风的「来向」】
      //   北 = 0°，东 = 90°，南 = 180°，西 = 270°。
      //   向东吹的风（u>0, v=0）来自西方 → 270°；
      //   向北吹的风（v>0, u=0）来自南方 → 180°。
      let d = (270 - Math.atan2(b, a) * 180 / Math.PI) % 360;
      if (d < 0) d += 360;
      dir[i] = d;
    }
    return { ok: true, speed: speed, dir: dir };
  }

  return {
    NC_BYTE: NC_BYTE, NC_CHAR: NC_CHAR, NC_SHORT: NC_SHORT,
    NC_INT: NC_INT, NC_FLOAT: NC_FLOAT, NC_DOUBLE: NC_DOUBLE,
    parse: parse,
    isNetCDF: isNetCDF,
    describe: describe,
    classify: classify,
    readVariable: readVariable,
    slice2d: slice2d,
    decodeTime: decodeTime,
    decodeLevel: decodeLevel,
    isTimeVar: isTimeVar,
    isLevelVar: isLevelVar,
    isLonVar: isLonVar,
    isLatVar: isLatVar,
    windFromUV: windFromUV,
    parseTimeBase: parseTimeBase,
  };

  /** 取一个变量的数据（带元信息）。 */
  function readVariable(ds, name) {
    if (!ds) return { ok: false, error: '没有数据集' };
    const v = ds.vars.find(function (x) { return x.name === name; });
    if (!v) return { ok: false, error: '没有这个变量：' + name };
    if (!v.data) return { ok: false, error: '变量数据读取失败：' + (v.readError || '未知') };
    return {
      ok: true, name: v.name, data: v.data, dims: v.dims, shape: v.shape,
      type: v.type, typeName: v.typeName, attrs: v.attrs,
    };
  }
});

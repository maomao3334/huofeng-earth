#!/usr/bin/env node
/**
 * Brotli 缓存预热 —— 给 serve.ps1 在启动时后台调用。
 *
 * 【为什么需要】
 *   Brotli 压缩是在**请求路径**上按需做的（.NET 没有 BrotliStream，
 *   得调 node 子进程）。冷缓存时第一个请求要等压缩完成：
 *     N25E102-terrain.bin  25.93 MB → 12.09 MB，实测冷启动 3.23 s，
 *     第二次起 0.03 s。
 *   3 s 卡在首屏加载上很难受 —— 但压缩结果落在 .brcache/，
 *   源文件不变就只需要压一次。
 *
 * 【做法】
 *   服务器起来后**后台**跑这个脚本，把所有够大的可压缩文件压好。
 *   首屏请求时缓存已经在了，请求路径上不再有压缩开销。
 *
 * 【无害】
 *   - 只写 .brcache/，不动源文件
 *   - 已经有缓存的文件直接跳过（按源文件 大小+修改时间 判键）
 *   - 失败不抛错：预热失败就退回「首次请求现压」，功能不受影响
 *
 * 用法：node tools/brotli-warm.mjs <root> [quality] [--quiet]
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const pos = args.filter((a) => !a.startsWith('--'));
const root = pos[0];
const quality = Number(pos[1]) || 6;

if (!root) {
  console.error('用法: node tools/brotli-warm.mjs <root> [quality] [--quiet]');
  process.exit(2);
}

/** 与 serve.ps1 的 CompressibleExt 保持一致。 */
const COMPRESSIBLE = new Set([
  '.bin',
  '.js', '.mjs', '.css', '.json', '.geojson', '.kml', '.xml', '.txt',
  '.md', '.csv', '.map', '.prj', '.asc', '.svg', '.html', '.htm',
]);

/** 小于这个大小不值得压（压缩开销占优，且收益小）。 */
const MIN_SIZE = 4096;

const cacheDir = path.join(root, '.brcache');

/**
 * 缓存键必须与 serve.ps1 的 Get-BrotliBytes 完全一致，
 * 否则预热出来的文件服务器不认。
 *   stamp = 长度(hex) + '-' + **LastWriteTimeUtc.Ticks**(hex) + '-q' + quality
 *   key  = MD5(源路径全文)
 *
 * 【坑】Ticks 是 .NET 的 100 纳秒计数，不是 JS 的毫秒！
 *   JS Date.now() 是毫秒；.NET DateTime.Ticks 是「自 0001-01-01 起的 100 纳秒数」。
 *   必须换算：ticks = (unixMs + 62135596800000) * 10000
 *   （62135596800000 ms = .NET epoch 0001-01-01 到 1970 的偏移）
 *   写错这个数 → 预热出来的文件服务器永远判为「未命中」→ 白压。
 */
function cachePathFor(src) {
  const fi = fs.statSync(src, { bigint: true });
  // 【坑】必须用 mtimeNs（纳秒）而不是 mtimeMs（毫秒）：
  //   .NET 的 Ticks 是 100 纳秒精度，毫秒换算会丢掉尾数，
  //   键对不上 → 服务器永远判为「未命中」。
  //   实测 mtimeMs 换算得 8df2df020b91060，真实值是 8df2df020b900bd。
  const ticks = fi.mtimeNs / 100n + 621355968000000000n;
  const stamp = fi.size.toString(16) + '-' + ticks.toString(16) + '-q' + quality;
  // 【坑】MD5 必须对**绝对路径**求 —— serve.ps1 里 $full 是
  //   [System.IO.Path]::GetFullPath(...) 的结果。
  //   拿相对路径算 MD5 → 键对不上 → 服务器永远判为「未命中」。
  const abs = path.resolve(src);
  const key = crypto.createHash('md5').update(abs, 'utf8').digest('hex');
  return path.join(cacheDir, key + '-' + stamp + '.br');
}

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;           // 跳过 .gzcache/.brcache/.git
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p, depth + 1);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

function compress(src, dst) {
  const buf = fs.readFileSync(src);
  const out = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  if (out.length >= buf.length) return false;      // 没收益就不写
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, dst);
  return true;
}

let files = 0;
let skipped = 0;
let failed = 0;
let bytes = 0;

try {
  fs.mkdirSync(cacheDir, { recursive: true });
  // 只预热「会被服务的大文件」：data/ 与 vendor/ 下的可压缩类型。
  const roots = ['data', 'vendor', 'js', 'index.html'].map((r) => path.join(root, r));
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const candidates = r.endsWith('.html') ? [r] : [...walk(r)];
    for (const src of candidates) {
      let fi;
      try {
        fi = fs.statSync(src);
      } catch {
        continue;
      }
      if (fi.size < MIN_SIZE) continue;
      const ext = path.extname(src).toLowerCase();
      if (!COMPRESSIBLE.has(ext)) continue;
      const dst = cachePathFor(src);
      try {
        if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
          skipped++;
          continue;
        }
      } catch {
        /* ignore */
      }
      try {
        if (compress(src, dst)) {
          files++;
          bytes += fi.size;
          if (!quiet) console.error(`[br-warm] ${path.relative(root, src)} (${(fi.size / 1048576).toFixed(1)} MB)`);
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
      }
    }
  }
} catch (err) {
  if (!quiet) console.error('[br-warm] 失败: %s', err && err.message ? err.message : err);
  process.exit(1);
}

if (!quiet) {
  console.error(`[br-warm] 完成：新压 ${files} 张（${(bytes / 1048576).toFixed(1)} MB 源），已有 ${skipped} 张，失败 ${failed} 张`);
}
process.exit(0);

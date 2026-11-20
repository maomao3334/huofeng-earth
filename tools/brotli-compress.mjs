#!/usr/bin/env node
/**
 * Brotli 压缩器 —— 给 serve.ps1 调用。
 *
 * 【为什么需要它】
 *   Windows PowerShell 5.1 跑在 .NET Framework 上，**没有 BrotliStream**
 *   （实测：[System.IO.Compression.BrotliStream] 找不到类型；
 *     System.IO.Compression 4.0.0.0 里也没有这个类型）。
 *   但 Node 22 自带 zlib 的 brotliCompressSync —— 而且这台机器上 node 本来
 *   就在 PATH 上（项目外的工具链用得上）。
 *
 * 【为什么不直接用 gzip】
 *   Brotli 在同样的内容上比 gzip 小 ~23 %，且**对前端完全透明**
 *   （浏览器收到 Content-Encoding: br 会自己解，JS 拿到的仍是原始字节）。
 *   唯一的前提是浏览器在请求头里声明 br —— 实测 Chrome 在
 *   **纯 http://（非 TLS）** 下也会声明 `gzip, deflate, br, zstd`。
 *
 * 【设计】
 *   - 输入输出都是**路径**，二进制数据不经过 stdout
 *     （走 stdout 会被 PowerShell 的管道拆成 Object[]，见 Get-GzipBytes 的坑）。
 *   - 压缩**质量**可调：q6 是性价比拐点（实测 N25 11.53 MB / 3.0 s，
 *     q11 只多省 1.4 MB 却要 60 s）。
 *   - 压缩结果落盘到 .brcache/ —— 压缩成本只在源文件变化时付一次，
 *     之后每个请求都是直接读缓存文件，**不在请求路径上**。
 *
 * 用法：node tools/brotli-compress.mjs <src> <dst> [quality]
 *   成功 → exit 0，dst 写好了
 *   失败 → exit 1，stderr 打印原因（调用方回退到 gzip）
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const [, , src, dst, qRaw] = process.argv;
if (!src || !dst) {
  console.error('用法: node tools/brotli-compress.mjs <src> <dst> [quality]');
  process.exit(2);
}
const quality = Number(qRaw) || 6;

try {
  const buf = fs.readFileSync(src);
  const out = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      // 给原始大小做提示，压缩器能据此分配窗口 → 体积略小
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  // 压完反而更大（本来就是随机数据，比如已压缩的 PNG）→ 报错，让调用方回退
  if (out.length >= buf.length) {
    console.error('brotli 无收益: %d -> %d', buf.length, out.length);
    process.exit(3);
  }
  // 先写临时文件再改名：多个 worker 可能同时压同一个文件，
  // 直接写目标文件会读到写了一半的内容。
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, dst);
  process.exit(0);
} catch (err) {
  console.error('brotli 失败: %s', err && err.message ? err.message : err);
  process.exit(1);
}

#requires -Version 5.1
<#
  本地地球 Local Earth — 本地静态服务器（仅监听 127.0.0.1，不访问外网）
  用法：双击 start.cmd，或 powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8123
#>
[CmdletBinding()]
param(
  [int]$Port = 8123,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = [System.IO.Path]::GetFullPath($Root)
$script:Wind3dJobs = @{}
$script:Wind3dJobRoot = Join-Path $Root 'data\wind3d\jobs'
# 并发处理用的工作线程句柄（见下方「并发处理」段）
$script:WorkerJobs = @()

$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.geojson' = 'application/geo+json; charset=utf-8'
  '.kml'  = 'application/vnd.google-earth.kml+xml'
  '.kmz'  = 'application/vnd.google-earth.kmz'
  '.xml'  = 'application/xml; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/markdown; charset=utf-8'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.png'  = 'image/png'
  '.gif'  = 'image/gif'
  '.webp' = 'image/webp'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.wasm' = 'application/wasm'
  '.glb'  = 'model/gltf-binary'
  '.gltf' = 'model/gltf+json'
  '.bin'  = 'application/octet-stream'
  '.woff' = 'font/woff'
  '.woff2' = 'font/woff2'
  '.ttf'  = 'font/ttf'
  '.map'  = 'application/json; charset=utf-8'
  '.terrain' = 'application/octet-stream'
  '.asc'  = 'text/plain; charset=utf-8'
  '.prj'  = 'text/plain; charset=utf-8'
  '.nc'   = 'application/x-netcdf'
  '.tif'  = 'image/tiff'
  '.tiff' = 'image/tiff'
  '.csv'  = 'text/csv; charset=utf-8'
  # 3D Tiles / 倾斜摄影内容文件（P2-4.8）
  '.b3dm'  = 'application/octet-stream'
  '.pnts'  = 'application/octet-stream'
  '.cmpt'  = 'application/octet-stream'
  '.i3s'   = 'application/octet-stream'
  '.cts'   = 'application/octet-stream'
  '.vctr'  = 'application/octet-stream'
  '.subtree' = 'application/octet-stream'
  '.ktx2'  = 'image/ktx2'
}

function Find-FreePort([int]$start) {
  for ($p = $start; $p -lt ($start + 40); $p++) {
    $listener = $null
    try {
      $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
      $listener.Start()
      $listener.Stop()
      return $p
    } catch {
      if ($listener) { try { $listener.Stop() } catch {} }
    }
  }
  return $null
}

function Open-Browser([int]$port) {
  $url = "http://127.0.0.1:$port/"
  $edge = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

  $browser = if ($edge) { $edge } elseif ($chrome) { $chrome } else { $null }
  if ($browser) {
    # 用应用窗口模式，界面更接近桌面 GIS
    Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--window-size=1440,900')
  } else {
    Start-Process $url
  }
}

function Get-BlankTilePng {
  # 1×1 全透明 PNG（filter 0 + RGBA(0,0,0,0)，已解码校验过 alpha=0）。
  # 用于「这份数据里确实没有这块瓦片」的情况：
  # 返回 200 + 透明图，浏览器控制台不再刷 404，图层也正常出图（该处透出底图）。
  # 这与 EOX 对无数据区域的处理完全一致（EOX 同样是透明 PNG）。
  if ($script:BlankTilePng) { return $script:BlankTilePng }
  $b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  $script:BlankTilePng = [Convert]::FromBase64String($b64)
  return $script:BlankTilePng
}

function Resolve-AlternateImageExtension([string]$path) {
  # 同一份影像数据里常常**混用** .jpg 与 .png（EOX 的无数据瓦片就是
  # 116 字节的 1×1 透明 PNG，但 URL 后缀仍是 .jpg；本地正射影像也 png/jpg 混排）。
  # 前端为了兼容这种混排，会对同一张瓦片探测两种扩展名 —— 于是必然有一半探测
  # 落在「不存在的那一个」上，浏览器控制台就会刷一片 404。
  #
  # 解决办法放在服务端：请求的扩展名文件不存在时，自动改用同名的另一种扩展名。
  # 前端一次请求即可命中，控制台干净，且对 png/jpg 混排的数据同样正确。
  $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($ext -ne '.jpg' -and $ext -ne '.jpeg' -and $ext -ne '.png') { return $null }
  $base = $path.Substring(0, $path.Length - $ext.Length)
  foreach ($alt in @('.jpg', '.jpeg', '.png')) {
    if ($alt -eq $ext) { continue }
    $cand = $base + $alt
    if (Test-Path -LiteralPath $cand -PathType Leaf) { return $cand }
  }
  return $null
}

function Resolve-ImageContentType([string]$path, [string]$fallback) {
  # 按**文件真实字节头**判定类型，而不是按扩展名。
  # 为什么：EOX 的无数据瓦片是 1×1 透明 **PNG**，但 URL 后缀是 .jpg；
  # 若按扩展名回 'image/jpeg'，浏览器会拒绝解码（严格模式下控制台报错、
  # 图层整片空白）。按字节头判定后回 'image/png'，解码正常。
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $buf = New-Object byte[] 8
      $n = $fs.Read($buf, 0, 8)
    } finally { $fs.Close() }
    if ($n -ge 8 -and $buf[0] -eq 0x89 -and $buf[1] -eq 0x50 -and $buf[2] -eq 0x4E -and $buf[3] -eq 0x47) {
      return 'image/png'
    }
    if ($n -ge 3 -and $buf[0] -eq 0xFF -and $buf[1] -eq 0xD8 -and $buf[2] -eq 0xFF) {
      return 'image/jpeg'
    }
  } catch { }
  return $fallback
}

function Get-CacheControlForPath([string]$relPath) {
  # 【为什么要分层】
  #   原来对**所有**文件都发 'no-cache, no-store, must-revalidate'，
  #   理由是「改了代码别跑旧的」。但这把 47 GB 的 z12 细源瓦片树
  #   （SRTM 1″ 重建产物，构建完就不再改）也一起覆盖了 ——
  #   每次打开软件都要重新下载几百 MB 白白跑一趟磁盘，
  #   这就是用户说的「加载太慢」。
  #
  #   现在按内容分层：
  #     * 不可变数据树 → 长期缓存 + immutable（浏览器直接读盘，不再回源）
  #     * 代码/配置    → no-cache（每次回源校验，改完刷新即生效，
  #                      但命中 304 时不传 body）
  # 归一化成以 '/' 开头的相对路径。
  # 注意：不能直接用传入的绝对路径判定 —— Windows 路径是
  # '\data\public\...'（反斜杠），而判定模式用的是 '/'，会**匹配不上**，
  # 导致不可变数据树退化成 no-cache（缓存全废）。
    # 用正则把 Windows 路径里的反斜杠换成正斜杠。
  # 注意：-replace 的模式里反斜杠是**正则转义符**，
  #   所以要用 '\\'（正则里的字面反斜杠）而不是 '\'。
  #   用 [regex]::Escape 最稳妥，不会被转义规则坑。
  $p = if ($relPath) { '/' + ($relPath -replace [regex]::Escape('\'), '/').TrimStart('/') } else { '/' }
  $lower = $p.ToLowerInvariant()

  # 不可变数据树
  # 注意：命中即返回，不做后续判断 —— 瓦片请求绝大多数落在第一个分支上。
  $immutable = $false
  if ($lower -like '*/data/public/dem/_terrarium_cache/*') { $immutable = $true }
  if ($lower -like '*/data/public/dem/overlays/*') { $immutable = $true }
  if ($lower -like '*/data/public/dem/cn/l*/*') { $immutable = $true }
  if ($lower -like '*/data/public/imagery/s2cloudless/*') { $immutable = $true }
  if ($lower -like '*/data/public/imagery/s2cloudless-baked*/*') { $immutable = $true }
  if ($lower -like '*/data/public/tiles/blue-marble/*') { $immutable = $true }
  # 全国/东亚/全球的整块高程 bin（几十 MB 一份）——构建产物，不重建就不变
  if ($lower -like '*/data/public/dem/*.bin') { $immutable = $true }
  if ($lower -like '*/data/public/dem/*.hgt.gz') { $immutable = $true }

  if ($immutable) {
    # 但 json/txt 这类可能被覆盖写的文件不长期缓存
    if ($lower -match '\.(json|xml|txt|csv|geojson)$') { return 'no-cache' }
    return 'public, max-age=31536000, immutable'
  }
  return 'no-cache'
}

# ---------------------------------------------------------------- 压缩 --
#
# 【为什么要做】
#   冷启动要下 118 MB，其中 102 MB 是 int16 高程 .bin / .npy。
#   这类数据**相邻像素高度极相似**，gzip 后能压到 1/2 左右
#   （实测：东亚 27.18 MB → 11.38 MB，全球 11.67 → 2.96，
#     示例区 24.73 → 14.80；三个合计 63.59 → 29.14 MB，2.18x）。
#
# 【为什么服务端压而不是前端解】
#   浏览器**原生**支持 Content-Encoding: gzip —— fetch/XHR/图片/字体
#   全都会自动解压，JS 拿到的仍然是原始字节。
#   前端 terrain.js 的 loadSource() 直接 new Int16Array(buf)，
#   完全不用改 —— 浏览器已经替我们解好了。
#
# 【什么时候压】
#   只压「已经压缩过」或「已经随机化」的格式不划算（png/jpg/gz/npy?）：
#   - png/jpg：再压是浪费 CPU 且几乎无收益
#   - .gz / .hgt.gz：压了也压不动
#   所以只压 .bin（高程 int16 原始数据）—— 这正是大头。
#
# 【成本】
#   gzip level 1 对 27 MB 的文件耗时 0.57 s（level 6 是 1.06 s）。
#   为了不每次请求都压一遍，把压缩结果**缓存到磁盘**：
#     <data文件>.gzcache
#   首次请求付一次压缩成本，之后所有请求直接读缓存文件。
#   缓存文件以「源文件大小 + 修改时间」命名，内容变化自动失效。
#
# 【不影响】
#   - Range 请求不走压缩（geotiff.js 需要按字节范围读原始数据）
#   - Accept-Encoding 不含 gzip 时直接发原文件
#   - Content-Length 始终是**压缩后**的长度（HTTP 语义要求）

# 允许压缩的扩展名
# 注意：这两个值要通过 SharedState 传给工作线程 —— runspace 里
# 只有**函数体**是被注入的，脚本级变量不会跟着过去（见 WorkerFnText 注释）。
#
# 【为什么后来加了 .js/.css/.json 等文本类型】
#   §6.9 只压 .bin（int16 高程）。但冷启动里最大的单项其实是
#   vendor/cesium/Cesium.js —— 5.80 MB 原始，gzip 后 1.98 MB（2.92x）。
#   加上一批 vendor 文本资源，实测省 4.45 MB（见 docs §6.12）。
#   文本压缩比高（2.4x–4.1x），且 Cesium.js 是单线程解析的瓶颈，
#   下载变少 = 解析更早开始 = 首屏更快。
#
# 【不放哪些】
#   - .png/.jpg/.webp 已经是压缩格式，再压是浪费（实测 1.00x）
#   - .wasm/.b3dm/.glb 等二进制：压缩比低，且可能走 Range
#   - .gz 结尾的（本来就有 Content-Encoding）
$script:CompressibleExt = @(
  '.bin',
  '.js', '.mjs', '.css', '.json', '.geojson', '.kml', '.xml', '.txt',
  '.md', '.csv', '.map', '.prj', '.asc', '.svg', '.html', '.htm'
)

# gzip 压缩级别。Optimal = level 6（.NET 的 Optimal 实际映射到 zlib level 6）。
# 见 Get-GzipBytes 里的说明：压缩成本由磁盘缓存摊销，不在请求路径上。
$script:GzipLevel = [System.IO.Compression.CompressionLevel]::Optimal

# ---------------------------------------------------------------------------
# Brotli（Content-Encoding: br）
#
# 【为什么要有】gzip 在同一份内容上比 Brotli 大 ~23 %。实测（tools/probe-brotli-quality.mjs）：
#   N25E102-terrain.bin    gzip6 14.75 MB  →  br q6 11.53 MB
#   eastasia-terrain.bin   gzip6 11.45 MB  →  br q6 10.24 MB
#   world-terrain.bin      gzip6  2.95 MB  →  br q6  2.65 MB
#   vendor/cesium/Cesium.js gzip6  1.70 MB →  br q6  1.50 MB
# 而且**对前端完全透明**：浏览器收到 Content-Encoding: br 会自己解，
# JS 拿到的仍是原始字节（new Int16Array(buf) 不用改）。
#
# 【浏览器真的会要吗】会。实测（tools/probe-accept-encoding.mjs）：
#   Chrome 在**纯 http://（非 TLS）**下也声明 `Accept-Encoding: gzip, deflate, br, zstd`，
#   并且能正确解码 br 响应。brotli 只在 HTTPS 下「必须」可用的说法只针对
#   代理/中间设备的兼容性，对本地直连的浏览器不是限制。
#
# 【为什么借道 node】Windows PowerShell 5.1 跑在 .NET Framework 上，
#   **没有 BrotliStream**（System.IO.Compression 4.0.0.0 里没有这个类型）。
#   Node 22 自带 zlib.brotliCompressSync，本机 node 就在 PATH 上。
#
# 【为什么不直接换掉 gzip】gzip 是兜底：任何浏览器/工具不支持 br 时走 gzip。
#   两条路并存，按 Accept-Encoding 里 br 的优先级选。
#
# 压缩质量：q6 是性价比拐点（q11 只多省 1.4 MB 却要 60 s，
#   而 .brcache 是落盘缓存 → 压缩只在源文件变化时付一次）。
$script:BrotliQuality = 6
$script:BrotliTool = Join-Path $Root 'tools/brotli-compress.mjs'

function Test-CompressiblePath([string]$full) {
  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
  $list = $null
  if ($script:SharedState) { $list = $script:SharedState['CompressibleExt'] }
  if (-not $list) { $list = $script:CompressibleExt }
  return $list -contains $ext
}

function Get-GzipCacheDir {
  $dir = $null
  if ($script:SharedState) { $dir = $script:SharedState['GzCacheDir'] }
  if (-not $dir) { $dir = (Join-Path $Root '.gzcache') }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    try { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop) } catch { }
  }
  return $dir
}

function Test-ClientAcceptsGzip($req) {
  try {
    $ae = $req.Headers['Accept-Encoding']
    if (-not $ae) { return $false }
    # 'gzip' / 'gzip, deflate, br' 都算；q=0 表示明确不要
    foreach ($part in ($ae -split ',')) {
      $p = $part.Trim()
      if (-not $p) { continue }
      $name = ($p -split ';')[0].Trim().ToLowerInvariant()
      if ($name -eq 'gzip') {
        # 检查 q=0
        if ($p -match 'q\s*=\s*0(\s*;|\s*$)') { return $false }
        return $true
      }
    }
  } catch { }
  return $false
}

# 客户端是否接受 brotli（Content-Encoding: br）。
# 判定规则与 gzip 一样：出现 'br' 且 q != 0 就算接受。
# 【注意】'br' 必须**整词**匹配 —— 否则 'brotli'、'xbr' 之类会被误判。
function Test-ClientAcceptsBrotli($req) {
  try {
    $ae = $req.Headers['Accept-Encoding']
    if (-not $ae) { return $false }
    foreach ($part in ($ae -split ',')) {
      $p = $part.Trim()
      if (-not $p) { continue }
      $name = ($p -split ';')[0].Trim().ToLowerInvariant()
      if ($name -eq 'br') {
        if ($p -match 'q\s*=\s*0(\s*;|\s*$)') { return $false }
        return $true
      }
    }
  } catch { }
  return $false
}

# br 缓存目录（与 .gzcache 平行）。
function Get-BrotliCacheDir {
  $dir = $null
  if ($script:SharedState) { $dir = $script:SharedState['BrCacheDir'] }
  if (-not $dir) { $dir = (Join-Path $Root '.brcache') }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    try { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop) } catch { }
  }
  return $dir
}

# 返回 brotli 压缩后的字节数组；失败返回 $null（调用方回退到 gzip）。
# 【设计要点】
#   - 走 node 子进程（.NET Framework 没有 BrotliStream）。
#     压缩完的二进制**不经过 stdout**（走管道会被 PowerShell 拆成 Object[]），
#     而是让 node 直接写到缓存文件，PowerShell 再读文件。
#   - 缓存键 = 源路径 MD5 + 大小 + 修改时间 + 质量。
#     内容变了自动失效；改了质量也不会命中旧缓存。
#   - 「压完反而更大」时删掉临时文件并返回 $null（调用方回退 gzip）。
function Get-BrotliBytes([string]$full) {
  try {
    $fi = New-Object System.IO.FileInfo($full)
    if (-not $fi.Exists) { return $null }
    # 只有够大才值得压：几百字节的小文件压了反而变大
    if ($fi.Length -lt 4096) { return $null }

    $tool = $script:BrotliTool
    if ($script:SharedState) {
      if ($script:SharedState['BrotliTool']) { $tool = $script:SharedState['BrotliTool'] }
      if ($script:SharedState['BrotliQuality']) { $script:BrotliQuality = $script:SharedState['BrotliQuality'] }
    }
    if (-not $tool -or -not (Test-Path -LiteralPath $tool)) { return $null }

    $stamp = $fi.Length.ToString('x') + '-' + $fi.LastWriteTimeUtc.Ticks.ToString('x') + '-q' + $script:BrotliQuality
    $key = [System.BitConverter]::ToString(
      [System.Security.Cryptography.MD5]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($full))).Replace('-', '').ToLowerInvariant()
    $cachePath = Join-Path (Get-BrotliCacheDir) ($key + '-' + $stamp + '.br')
    if ([System.IO.File]::Exists($cachePath)) {
      try {
        $fi2 = New-Object System.IO.FileInfo($cachePath)
        if ($fi2.Exists -and $fi2.Length -gt 0) {
          $bytes = [System.IO.File]::ReadAllBytes($cachePath)
          return ,$bytes
        }
      } catch { }
    }

    # 调 node 压缩。node 内部先写 <cache>.<pid>.tmp 再 rename，
    # 所以多个 worker 同时压同一个文件也不会读到写了一半的内容。
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) { return $null }
    $tmpOut = $cachePath + '.tmp-' + $PID
    & $node.Source $tool $full $tmpOut $script:BrotliQuality 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      try { if (Test-Path -LiteralPath $tmpOut) { Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue } } catch { }
      return $null
    }
    if (-not (Test-Path -LiteralPath $tmpOut)) { return $null }
    $out = [System.IO.File]::ReadAllBytes($tmpOut)
    try { Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue } catch { }
    if (-not $out -or $out.Length -ge $fi.Length) { return $null }
    try { [System.IO.File]::WriteAllBytes($cachePath, $out) } catch { }
    return ,$out
  } catch { }
  return $null
}

# 返回压缩后字节数组；失败时返回 $null（调用方回退到原始文件）
function Get-GzipBytes([string]$full) {
  try {
    $fi = New-Object System.IO.FileInfo($full)
    if (-not $fi.Exists) { return $null }
    # 只有够大才值得压：几百字节的小文件压了反而变大
    if ($fi.Length -lt 4096) { return $null }

    # 磁盘缓存：放在 .gzcache/ 下，文件名由「源路径 + 大小 + 修改时间 + 压缩级别」决定。
    # 不放在源文件旁边 —— data/ 是被服务的目录，缓存文件不该出现在那儿。
    $stamp = $fi.Length.ToString('x') + '-' + $fi.LastWriteTimeUtc.Ticks.ToString('x') + '-' + $script:GzipLevel
    $key = [System.BitConverter]::ToString(
      [System.Security.Cryptography.MD5]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($full))).Replace('-', '').ToLowerInvariant()
    $cachePath = Join-Path (Get-GzipCacheDir) ($key + '-' + $stamp + '.gz')
    if ([System.IO.File]::Exists($cachePath)) {
      try {
        $fi2 = New-Object System.IO.FileInfo($cachePath)
        if ($fi2.Exists -and $fi2.Length -gt 0) {
          # 【坑】必须用逗号运算符 `,$bytes` 返回！
          #   PowerShell 会把 byte[] 在输出管道里**拆成一个个字节**，
          #   函数返回的就不是 byte[] 而是 Object[]（每个元素都是装箱的 Byte）。
          #   长度看着对（$x.Length 仍是对的），但：
          #     * 分配 1600 万个装箱对象 → 慢 + 内存暴涨
          #     * Write(Object[], ...) / Copy 时要逐个拆箱 → 慢到离谱
          #   实测：不加逗号时发 3.2 MB 要 890 ms，加了之后是毫秒级。
          $bytes = [System.IO.File]::ReadAllBytes($cachePath)
          return ,$bytes
        }
      } catch { }
    }

    # 压缩级别：Optimal(=level 6)。
    # 【为什么从 Fastest(level 1) 改过来】
    #   .gzcache 是**磁盘缓存** —— 压缩成本只在源文件变化时付一次，
    #   之后所有请求都是直接读缓存文件。请求路径上根本不压。
    #   所以这里唯一该考虑的是「压缩后体积」，而不是压缩耗时。
    #   实测（level 1 → level 6）：
    #     vendor/cesium/Cesium.js  1.985 MB → 1.696 MB
    #     N25E102-terrain.bin      15.46 MB → 14.80 MB
    #     eastasia-terrain.bin     11.50 MB → 11.38 MB
    #     world-terrain.bin         3.03 MB →  2.96 MB
    #   合计约省 1.0 MB，代价是一次性的 CPU（不在请求路径上）。
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $ms = New-Object System.IO.MemoryStream
    try {
      $gz = New-Object System.IO.Compression.GZipStream($ms, $script:GzipLevel, $true)
      try { $gz.Write($bytes, 0, $bytes.Length) } finally { $gz.Dispose() }
      $out = $ms.ToArray()
    } finally { $ms.Dispose() }

    # 压完反而更大（本来就是随机数据）→ 不缓存也不返回
    if ($out.Length -ge $bytes.Length) { return $null }

    try { [System.IO.File]::WriteAllBytes($cachePath, $out) } catch { }
    return ,$out
  } catch {
    return $null
  }
}

function Send-Response($ctx, [int]$status, [string]$contentType, [byte[]]$body) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $contentType
  $res.Headers['Cache-Control'] = 'no-store'
  $res.Headers['X-Content-Type-Options'] = 'nosniff'
  if ($null -eq $body) { $body = [byte[]]@() }
  $res.ContentLength64 = $body.Length
  if ($ctx.Request.HttpMethod -ne 'HEAD' -and $body.Length -gt 0) {
    $res.OutputStream.Write($body, 0, $body.Length)
  }
  $res.OutputStream.Close()
}

<#
  带 HTTP Range 支持的静态文件响应（206 Partial Content）。
  为什么要这个：浏览器端的 geotiff.js 会用 Range 请求分块读 GeoTIFF/COG；
  如果服务端不认 Range（直接回 200 + 整个文件），geotiff.js 会把整份文件
  当成「一个分片」来解析，于是报 "Invalid field type: 0"。
  大文件（几十 MB 的栅格）也必须靠 Range 才能边下边用。
#>
function Get-FileETag([string]$full, [int64]$total, [int64]$mtimeTicks) {
  # 用「大小 + 最后修改时间」做 ETag。
  # 对「代码/配置」这类可能变的文件，这是最省事的强校验器：
  # 浏览器带 If-None-Match 回来时，内容没变就回 304（不传 body），
  # 变了就回 200 + 新 ETag。实测 js 8.8 MB 的重复下载因此降到 0。
  # 不可变数据树不参与 —— 它们已经用 immutable 走磁盘缓存了。
  return '"' + $total.ToString('x') + '-' + $mtimeTicks.ToString('x') + '"'
}

function Send-FileResponse($ctx, [string]$full, [string]$contentType) {
  $req = $ctx.Request
  $res = $ctx.Response
  # 用 [System.IO.FileInfo]::new() 而不是 Get-Item：
  #   Get-Item          1.76 ms/次（走 PowerShell provider 管道）
  #   [FileInfo]::new() 0.23 ms/次（直接 .NET）
  #   实测 100 次：176 ms → 23 ms。瓦片加载一批就是几百张，省下几百毫秒。
  $fi = New-Object System.IO.FileInfo($full)
  $total = [int64]$fi.Length

  $res.ContentType = $contentType
  $res.Headers['Accept-Ranges'] = 'bytes'
  # 缓存策略按路径分层（见 Get-CacheControlForPath）：
  # 不可变数据树长期缓存，代码/配置每次校验。
  $cacheControl = Get-CacheControlForPath $full
  $res.Headers['Cache-Control'] = $cacheControl
  $res.Headers['X-Content-Type-Options'] = 'nosniff'

  # --- 条件请求（304）---
  # 只对「每次校验」的文件做：不可变的那批已经走磁盘缓存了，
  # 再加 ETag 反而多一次回源。
  if ($cacheControl -eq 'no-cache') {
    $etag = Get-FileETag $full $total $fi.LastWriteTimeUtc.Ticks
    $res.Headers['ETag'] = $etag
    $inm = $null
    try { $inm = $req.Headers['If-None-Match'] } catch { $inm = $null }
    if ($inm) {
      $tags = @($inm -split ',' | ForEach-Object { $_.Trim() })
      if ($tags -contains $etag -or $tags -contains '*') {
        $res.StatusCode = 304
        $res.ContentLength64 = 0
        $res.OutputStream.Close()
        return 0
      }
    }
  }

  # 解析 Range: bytes=start-end
  $rangeHeader = $null
  try { $rangeHeader = $req.Headers['Range'] } catch { $rangeHeader = $null }
  if (-not $rangeHeader) {
    # --- 透明 brotli（首选）/ gzip（兜底）---
    # 浏览器收到 Content-Encoding: gzip / br 都会自动解压，JS 拿到的仍是原始字节，
    # 所以前端完全不用改（terrain.js 的 new Int16Array(buf) 照常工作）。
    # Range 请求不走这条路径 —— geotiff.js 要按字节范围读原始数据。
    #
    # 【优先级】客户端同时声明 br 和 gzip 时用 br —— 同样的内容 br 小 ~23 %。
    # 不支持 br 的客户端自动落到 gzip 分支。
    #
    # 【坑】这里必须给每个函数调用加括号：
    #   `if (Test-CompressiblePath $full -and (Test-ClientAcceptsGzip $req))`
    # 会被解析成**命令调用** Test-CompressiblePath，参数是
    #   $full / '-and' / <第二个表达式的结果>
    # ——'-and' 只是第三个参数，条件判断根本没发生，
    # 于是不管客户端收不收 gzip 都返回压缩数据。
    if ((Test-CompressiblePath $full) -and (Test-ClientAcceptsBrotli $req)) {
      $br = Get-BrotliBytes $full
      if ($br) { $br = [byte[]]$br }
      if ($br -and $br.Length -gt 0) {
        $res.Headers['Content-Encoding'] = 'br'
        # 加 Vary，共享缓存才不会把 br 版喂给不支持压缩的客户端
        $res.Headers['Vary'] = 'Accept-Encoding'
        $res.StatusCode = 200
        $res.ContentLength64 = $br.Length
        if ($req.HttpMethod -ne 'HEAD') {
          # 【坑】必须分块写，不能一次 Write 整个数组。
          #   HttpListener 的 OutputStream 一次写大块时会内部缓冲，
          #   在「客户端还没开始读」的阶段就把整块压在 socket 缓冲区上，
          #   写线程一直等 —— 表现为服务端 CPU 不忙、但请求迟迟不返回。
          $buf = New-Object byte[] 1048576
          $remaining = $br.Length
          $off = 0
          while ($remaining -gt 0) {
            $n = [Math]::Min($buf.Length, $remaining)
            [Array]::Copy($br, $off, $buf, 0, $n)
            $res.OutputStream.Write($buf, 0, $n)
            $off += $n
            $remaining -= $n
          }
        }
        $res.OutputStream.Close()
        return $br.Length
      }
    }
    if ((Test-CompressiblePath $full) -and (Test-ClientAcceptsGzip $req)) {
      $gz = Get-GzipBytes $full
      if ($gz) { $gz = [byte[]]$gz }
      if ($gz -and $gz.Length -gt 0) {
        $res.Headers['Content-Encoding'] = 'gzip'
        # 加 Vary，共享缓存才不会把 gzip 版喂给不支持压缩的客户端
        $res.Headers['Vary'] = 'Accept-Encoding'
        $res.StatusCode = 200
        $res.ContentLength64 = $gz.Length
        if ($req.HttpMethod -ne 'HEAD') {
          # 【坑】必须分块写，不能一次 Write 整个数组。
          #   一次 Write 16 MB：实测请求耗时 7 600 ms。
          #   按 1 MB 分块写：同样的字节量，耗时与原始路径（25.9 MB / 37 ms）
          #   同一量级。
          #   原因：HttpListener 的 OutputStream 一次写大块时会内部缓冲，
          #   在「客户端还没开始读」的阶段就把整块压在 socket 缓冲区上，
          #   写线程一直等 —— 表现为服务端 CPU 不忙、但请求迟迟不返回。
          $buf = New-Object byte[] 1048576
          $remaining = $gz.Length
          $off = 0
          while ($remaining -gt 0) {
            $n = [Math]::Min($buf.Length, $remaining)
            [Array]::Copy($gz, $off, $buf, 0, $n)
            $res.OutputStream.Write($buf, 0, $n)
            $off += $n
            $remaining -= $n
          }
        }
        $res.OutputStream.Close()
        return $gz.Length
      }
    }
    $res.StatusCode = 200
    $res.ContentLength64 = $total
    if ($req.HttpMethod -ne 'HEAD' -and $total -gt 0) {
      $fs = [System.IO.File]::OpenRead($full)
      try {
        $buf = New-Object byte[] 1048576
        $remaining = $total
        while ($remaining -gt 0) {
          $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $remaining))
          if ($n -le 0) { break }
          $res.OutputStream.Write($buf, 0, $n)
          $remaining -= $n
        }
      } finally { $fs.Close() }
    }
    $res.OutputStream.Close()
    return $total
  }

  # 只支持单区间 "bytes=start-end"
  $m = [regex]::Match([string]$rangeHeader, 'bytes\s*=\s*(\d*)\s*-\s*(\d*)')
  if (-not $m.Success) {
    $res.StatusCode = 416
    $res.Headers['Content-Range'] = "bytes */$total"
    $res.ContentLength64 = 0
    $res.OutputStream.Close()
    return 0
  }
  $startText = $m.Groups[1].Value
  $endText = $m.Groups[2].Value
  $start = 0L
  $end = $total - 1
  if ($startText -eq '' -and $endText -eq '') {
    $res.StatusCode = 416
    $res.Headers['Content-Range'] = "bytes */$total"
    $res.ContentLength64 = 0
    $res.OutputStream.Close()
    return 0
  }
  if ($startText -eq '') {
    # bytes=-N：最后 N 字节
    $n = [int64]$endText
    if ($n -le 0) { $n = 1 }
    if ($n -gt $total) { $n = $total }
    $start = $total - $n
    $end = $total - 1
  } else {
    $start = [int64]$startText
    if ($endText -ne '') {
      $end = [int64]$endText
      if ($end -ge $total) { $end = $total - 1 }
    }
  }
  if ($start -ge $total -or $start -lt 0 -or $end -lt $start) {
    $res.StatusCode = 416
    $res.Headers['Content-Range'] = "bytes */$total"
    $res.ContentLength64 = 0
    $res.OutputStream.Close()
    return 0
  }
  $length = $end - $start + 1
  $res.StatusCode = 206
  $res.Headers['Content-Range'] = "bytes $start-$end/$total"
  $res.ContentLength64 = $length
  if ($req.HttpMethod -ne 'HEAD' -and $length -gt 0) {
    $fs = [System.IO.File]::OpenRead($full)
    try {
      $null = $fs.Seek($start, [System.IO.SeekOrigin]::Begin)
      $buf = New-Object byte[] 1048576
      $remaining = $length
      while ($remaining -gt 0) {
        $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $remaining))
        if ($n -le 0) { break }
        $res.OutputStream.Write($buf, 0, $n)
        $remaining -= $n
      }
    } finally { $fs.Close() }
  }
  $res.OutputStream.Close()
  return $length
}

function Write-JsonResponse($ctx, $value, [int]$status = 200) {  $json = $value | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = 'application/json; charset=utf-8'
  $res.Headers['Cache-Control'] = 'no-store'
  $res.Headers['X-Content-Type-Options'] = 'nosniff'
  $res.Headers['Access-Control-Allow-Origin'] = '*'
  $res.Headers['Access-Control-Allow-Headers'] = '*'
  $res.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
  if ($status -eq 204) {
    $res.ContentLength64 = 0
    $res.OutputStream.Close()
    return
  }
  $res.ContentLength64 = $bytes.Length
  if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  $res.OutputStream.Close()
}

function Read-JsonBody($ctx) {
  $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
  try { $text = $reader.ReadToEnd() } finally { $reader.Close() }
  if (-not $text -or -not $text.Trim()) { return @{} }
  return ($text | ConvertFrom-Json)
}

function Test-Wind3dFinite([double]$value) {
  return -not ([double]::IsNaN($value) -or [double]::IsInfinity($value))
}

function Quote-Wind3dArg([string]$value) {
  if ($null -eq $value) { return '""' }
  if ($value -match '[\s"]') { return '"' + ($value -replace '"', '\"') + '"' }
  return $value
}

function Get-Wind3dCliPath {
  $candidates = @()
  if ($env:WIND3D_CLI) { $candidates += ($env:WIND3D_CLI -replace '^"|"$', '') }
  $latestSource = Join-Path (Split-Path -Parent $Root) 'wind3d-ninja\wind3d-latest.cmd'
  if (Test-Path -LiteralPath $latestSource -PathType Leaf) { $candidates += $latestSource }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Wind3D\Wind3D-cli.exe') }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Wind3D\Wind3D-cli.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Wind3D\Wind3D-cli.exe') }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($path)
    }
  }
  return $null
}

function Get-Wind3dVersion([string]$cli) {
  if (-not $cli) { return $null }
  if ($env:WIND3D_VERSION) { return [string]$env:WIND3D_VERSION }
  $appRoot = Split-Path -Parent $cli
  $manifest = Join-Path $appRoot 'portable_app.json'
  if (Test-Path -LiteralPath $manifest -PathType Leaf) {
    try {
      $json = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($json.version) { return [string]$json.version }
    } catch { }
  }
  $pyproject = Join-Path $appRoot 'pyproject.toml'
  if (Test-Path -LiteralPath $pyproject -PathType Leaf) {
    try {
      $match = Select-String -LiteralPath $pyproject -Pattern '^\s*version\s*=\s*"([^"]+)"' -Encoding UTF8 | Select-Object -First 1
      if ($match) { return [string]$match.Matches[0].Groups[1].Value }
    } catch { }
  }
  return $null
}

function Get-Wind3dJobState($job) {
  return @{
    id = $job.id
    status = $job.status
    pid = $job.pid
    startedAt = $job.startedAt
    finishedAt = $job.finishedAt
    exitCode = $job.exitCode
    jobDir = $job.jobDir
    outputDir = $job.outputDir
    command = $job.command
    params = $job.params
    scenes = @($job.scenes)
  }
}

function Write-Wind3dJobState($job) {
  try {
    $state = Get-Wind3dJobState $job
    $json = $state | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText((Join-Path $job.jobDir 'job.json'), $json, (New-Object Text.UTF8Encoding($false)))
  } catch {
    Write-Host ("[Wind3D] 写入任务状态失败：" + $_.Exception.Message) -ForegroundColor DarkYellow
  }
}

function Get-Wind3dScenes($job) {
  $scenes = @()
  $base = Join-Path $job.outputDir 'windninja'
  if (-not (Test-Path -LiteralPath $base -PathType Container)) { return @() }
  $files = @(Get-ChildItem -LiteralPath $base -Recurse -File -Filter '*_vel.asc' -ErrorAction SilentlyContinue | Sort-Object FullName)
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
    $parts = $rel -split '/'
    $ts = @($parts | Where-Object { $_ -match '^\d{8}T\d{6}Z?$' }) | Select-Object -First 1
    $height = @($parts | Where-Object { $_ -match '^h\d+m$' }) | Select-Object -First 1
    $resolution = @($parts | Where-Object { $_ -match '^r\d+m$' }) | Select-Object -First 1
    $labelParts = @()
    if ($ts) { $labelParts += $ts }
    if ($height) { $labelParts += $height }
    if ($resolution) { $labelParts += $resolution }
    $label = if ($labelParts.Count) { $labelParts -join ' / ' } else { $file.BaseName }
    $scenes += @{
      vel = $rel
      ang = ($rel -replace '_vel\.asc$', '_ang.asc')
      prj = ($rel -replace '\.asc$', '.prj')
      label = $label
      timestamp = $ts
      height = $height
      resolution = $resolution
    }
  }
  return $scenes
}

function Update-Wind3dJob($job) {
  if (-not $job -or $job.status -ne 'running') { return }
  try {
    $done = $false
    $code = $null
    if ($job.exitCodePath -and (Test-Path -LiteralPath $job.exitCodePath -PathType Leaf)) {
      $text = (Get-Content -LiteralPath $job.exitCodePath -Raw -Encoding UTF8).Trim()
      $parsed = 0
      if ([int]::TryParse($text, [ref]$parsed)) {
        $code = $parsed
        $done = $true
      }
    }
    if (-not $done -and $job.process -and $job.process.HasExited) {
      try { $job.process.WaitForExit() } catch { }
      try { $code = $job.process.ExitCode } catch { }
      if ($null -ne $code) { $done = $true }
    }
    if ($done) {
      $job.exitCode = $code
      if ($null -eq $job.exitCode) { $job.exitCode = -1 }
      $job.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
      if ($job.exitCode -eq 0) {
        $job.status = 'completed'
        $job.scenes = @(Get-Wind3dScenes $job)
        if ($job.scenes.Count -eq 0) {
          Convert-Wind3dNetcdf $job
          $job.scenes = @(Get-Wind3dScenes $job)
        }
      } else {
        $job.status = 'failed'
      }
      Write-Wind3dJobState $job
    }
  } catch {
    Write-Host ("[Wind3D] 更新任务状态失败：" + $_.Exception.Message) -ForegroundColor DarkYellow
  }
}

function Get-Wind3dLog($job, [int]$lines = 120) {
  if ($lines -lt 1) { $lines = 120 }
  $parts = @()
  foreach ($path in @($job.stderr, $job.stdout)) {
    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
      try {
        $tail = @(Get-Content -LiteralPath $path -Tail $lines -Encoding UTF8 -ErrorAction Stop)
        if ($tail.Count) { $parts += $tail }
      } catch { }
    }
  }
  return ($parts -join "`n")
}

function Stop-Wind3dJob($job) {
  if ($job.process -and -not $job.process.HasExited) {
    try { & taskkill.exe /PID $job.pid /T /F 2>$null | Out-Null } catch { }
    try { if (-not $job.process.HasExited) { $job.process.Kill() } } catch { }
  }
  $job.status = 'cancelled'
  $job.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-Wind3dJobState $job
}

function Get-Wind3dPythonPath {
  if ($env:WIND3D_PYTHON -and (Test-Path -LiteralPath $env:WIND3D_PYTHON -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($env:WIND3D_PYTHON)
  }
  $candidates = @('C:\Program Files\Python311\python.exe')
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  $command = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

function Get-Wind3dNativeRuntime {
  $candidates = @()
  if ($env:WIND3D_NATIVE_RUNTIME) { $candidates += $env:WIND3D_NATIVE_RUNTIME }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Wind3D\runtime\openfoam8') }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath (Join-Path $path 'native_runtime.json') -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($path)
    }
  }
  return $null
}

function Copy-Wind3dInputTree([string]$source, [string]$destination) {
  if (-not $source -or -not (Test-Path -LiteralPath $source -PathType Container)) { return }
  $sourceRoot = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $files = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -ErrorAction Stop
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $target = Join-Path $destination $relative
    $parent = Split-Path -Parent $target
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if (Test-Path -LiteralPath $target) { continue }
    try {
      New-Item -ItemType HardLink -Path $target -Target $file.FullName -ErrorAction Stop | Out-Null
    } catch {
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
  }
}

function Add-Wind3dFile([string]$source, [string]$destination) {
  if (-not $source -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { return $null }
  $parent = Split-Path -Parent $destination
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
  try {
    New-Item -ItemType HardLink -Path $destination -Target $source -ErrorAction Stop | Out-Null
  } catch {
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
  return $destination
}

function Convert-Wind3dNetcdf($job) {
  $ncDir = Join-Path $job.outputDir 'nc'
  if (-not (Test-Path -LiteralPath $ncDir -PathType Container)) { return }
  $python = Get-Wind3dPythonPath
  $script = Join-Path $Root 'tools\netcdf_to_windninja_ascii.py'
  if (-not $python -or -not (Test-Path -LiteralPath $script -PathType Leaf)) {
    [IO.File]::AppendAllText($job.stdout, "`n[netcdf->ascii] 缺少 Python 或转换脚本`n", (New-Object Text.UTF8Encoding($false)))
    return
  }
  $display = Join-Path $job.outputDir 'windninja'
  $args = @($script, '--nc-dir', $ncDir, '--output-dir', $display, '--resolution', [string]$job.params.resolution)
  try {
    $output = & $python @args 2>&1 | Out-String
    [IO.File]::AppendAllText($job.stdout, "`n[netcdf->ascii]`n" + $output, (New-Object Text.UTF8Encoding($false)))
  } catch {
    [IO.File]::AppendAllText($job.stdout, "`n[netcdf->ascii] 失败：" + $_.Exception.Message + "`n", (New-Object Text.UTF8Encoding($false)))
  }
}

function Get-Wind3dDouble($value, [double]$fallback) {
  if ($null -eq $value) { return $fallback }
  $text = [string]$value
  if ([string]::IsNullOrWhiteSpace($text)) { return $fallback }
  $parsed = 0.0
  if ([double]::TryParse($text, [ref]$parsed)) { return $parsed }
  return $fallback
}

function Get-Wind3dInt($value, [int]$fallback) {
  if ($null -eq $value) { return $fallback }
  $text = [string]$value
  if ([string]::IsNullOrWhiteSpace($text)) { return $fallback }
  $parsed = 0
  if ([int]::TryParse($text, [ref]$parsed)) { return $parsed }
  return $fallback
}

function Start-Wind3dJob($body) {
  $cli = Get-Wind3dCliPath
  if (-not $cli) {
    throw '未找到 Wind3D-cli.exe。请先安装 Wind3D，或设置环境变量 WIND3D_CLI 指向 Wind3D-cli.exe。'
  }
  if (-not $body) { throw '请求内容为空' }

  $mode = ([string]$body.mode).Trim()
  if (-not $mode) { $mode = 'turbulence' }
  if (@('stations', 'turbulence', 'assimilation', 'native-assimilation') -notcontains $mode) {
    throw '未知的 Wind3D 模式：' + $mode
  }
  $turbSource = ([string]$body.turbSource).Trim()
  if (-not $turbSource) { $turbSource = 'manual' }
  $manualTurbulence = ($mode -eq 'turbulence' -and $turbSource -eq 'manual')

  $inputSource = ([string]$body.inputDir).Trim().Trim('"')
  if (-not $manualTurbulence -and (-not $inputSource -or -not (Test-Path -LiteralPath $inputSource -PathType Container))) {
    throw '请选择包含观测数据的目录（WindMaster / DAT / UAV / 通用站点 CSV）'
  }

  $demPath = ([string]$body.demPath).Trim().Trim('"')
  if ($demPath -and -not (Test-Path -LiteralPath $demPath -PathType Leaf)) { throw 'DEM 文件不存在：' + $demPath }
  if ($demPath) {
    $demExt = [IO.Path]::GetExtension($demPath).ToLowerInvariant()
    if ($demExt -ne '.tif' -and $demExt -ne '.tiff') { throw 'DEM 必须是 GeoTIFF（.tif / .tiff）' }
  }
  if ($manualTurbulence -and -not $demPath) { throw '手动背景风模式需要 DEM' }

  $stationSource = ([string]$body.stationCsv).Trim().Trim('"')
  # The independent station constraints are CLI options only for the two
  # assimilation commands. Switching modes can leave the previous UI value set.
  if ($mode -ne 'assimilation' -and $mode -ne 'native-assimilation') { $stationSource = '' }
  if ($stationSource -and -not (Test-Path -LiteralPath $stationSource -PathType Leaf)) {
    throw '站点 CSV 不存在：' + $stationSource
  }
  if ($mode -eq 'native-assimilation' -and -not $stationSource) {
    throw '原生 RANS 耦合同化必须提供站点 CSV（含 k/epsilon 或混合长度）'
  }

  $uavHeight = ([string]$body.uavHeightReference).Trim()
  if (-not $uavHeight) { $uavHeight = 'gps_altitude_minus_dem' }
  if (@('unknown', 'gps_altitude_minus_dem', 'relative_to_launch', 'relative_agl', 'gps_plus_relative_minus_dem') -notcontains $uavHeight) {
    throw '未知的 UAV 高度定义：' + $uavHeight
  }

  $nativeRuntime = $null
  if ($mode -eq 'native-assimilation') {
    $nativeRuntime = ([string]$body.nativeRuntime).Trim().Trim('"')
    if (-not $nativeRuntime) { $nativeRuntime = Get-Wind3dNativeRuntime }
    if (-not $nativeRuntime -or -not (Test-Path -LiteralPath (Join-Path $nativeRuntime 'native_runtime.json') -PathType Leaf)) {
      throw '找不到 Windows 原生 OpenFOAM 运行库（native_runtime.json）'
    }
  }

  $south = [double]$body.south
  $west = [double]$body.west
  $north = [double]$body.north
  $east = [double]$body.east
  if (-not (Test-Wind3dFinite $south) -or -not (Test-Wind3dFinite $west) -or
      -not (Test-Wind3dFinite $north) -or -not (Test-Wind3dFinite $east)) {
    throw '计算范围必须是有效数字'
  }
  if ($south -ge $north) { throw '南界必须小于北界' }
  if ($west -ge $east) { throw '西界必须小于东界' }
  if ($south -lt -90 -or $north -gt 90 -or $west -lt -180 -or $east -gt 180) { throw '经纬度超出范围' }

  $startTime = ([string]$body.startTime).Trim()
  $endTime = ([string]$body.endTime).Trim()
  if (-not $startTime) { $startTime = ([string]$body.time).Trim() }
  if (-not $endTime) { $endTime = $startTime }
  if (-not $startTime) { throw '缺少模拟开始时间' }
  if ($startTime -notmatch '(Z|[+-]\d{2}:\d{2})$') { throw '开始时间必须带时区（例如 2024-04-03T08:06:00Z）' }
  if ($endTime -notmatch '(Z|[+-]\d{2}:\d{2})$') { throw '结束时间必须带时区（例如 2024-04-03T09:06:00Z）' }
  try { [void][DateTimeOffset]::Parse($startTime, [Globalization.CultureInfo]::InvariantCulture) } catch { throw '开始时间格式无效：' + $startTime }
  try { [void][DateTimeOffset]::Parse($endTime, [Globalization.CultureInfo]::InvariantCulture) } catch { throw '结束时间格式无效：' + $endTime }
  if ([DateTimeOffset]::Parse($endTime, [Globalization.CultureInfo]::InvariantCulture) -lt [DateTimeOffset]::Parse($startTime, [Globalization.CultureInfo]::InvariantCulture)) {
    throw '结束时间必须不早于开始时间'
  }

  $speed = 0.0
  $direction = 0.0
  $bgHeight = 0.0
  if ($manualTurbulence) {
    $speed = [double]$body.speed
    $direction = [double]$body.direction
    $bgHeight = [double]$body.backgroundHeight
    if (-not (Test-Wind3dFinite $speed) -or $speed -le 0) { throw '背景风速必须大于 0' }
    if (-not (Test-Wind3dFinite $direction) -or $direction -lt 0 -or $direction -ge 360) { throw '背景风向必须在 [0,360) 度' }
    if (-not (Test-Wind3dFinite $bgHeight) -or $bgHeight -le 0) { throw '背景高度必须大于 0' }
  }

  $heightValues = @()
  $heightText = if ($body.heights -is [array]) { $body.heights -join ' ' } else { [string]$body.heights }
  foreach ($token in ($heightText -split '[,\s]+')) {
    if (-not $token) { continue }
    $parsed = 0
    if (-not [int]::TryParse($token, [ref]$parsed) -or $parsed -le 0) { throw '输出高度必须是正整数：' + $token }
    if ($heightValues -notcontains $parsed) { $heightValues += $parsed }
  }
  if (-not $heightValues.Count) { throw '至少需要一个输出高度' }
  $resolution = [int]$body.resolution
  if ($resolution -le 0) { throw '网格分辨率必须是正整数' }

  $referenceHeight = Get-Wind3dDouble $body.referenceHeight 50
  $roughness = Get-Wind3dDouble $body.roughness 0.1
  $displacementHeight = Get-Wind3dDouble $body.displacementHeight 0
  $canopyHeight = Get-Wind3dDouble $body.canopyHeight 0
  $buffer = Get-Wind3dDouble $body.buffer 10
  $maxCases = Get-Wind3dInt $body.maxCases 1
  $windmasterHeight = [string]$body.windmasterHeightReference
  if (-not $windmasterHeight) { $windmasterHeight = 'agl' }
  $windmasterAgl = Get-Wind3dDouble $body.windmasterPlatformAgl 0
  $uavDirection = [string]$body.uavDirectionReference
  if (-not $uavDirection) { $uavDirection = 'from_true_north' }
  $assimHScale = Get-Wind3dDouble $body.assimHorizontalScale 1000
  $assimBgSigma = Get-Wind3dDouble $body.assimBackgroundSigma 2
  $assimObsSigma = Get-Wind3dDouble $body.assimObservationSigma 0.5
  $assimVScale = Get-Wind3dDouble $body.assimVerticalScale 30
  $nativeHRadius = Get-Wind3dDouble $body.nativeHorizontalRadius 300
  $nativeVRadius = Get-Wind3dDouble $body.nativeVerticalRadius 50
  $nativeIterations = Get-Wind3dInt $body.nativeMaxIterations 1000
  $nativeTolerance = Get-Wind3dDouble $body.nativeTolerance 0.00001
  $kmz = ($body.kmz -ne $false)

  $jobId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-Random -Minimum 1000 -Maximum 9999)
  $jobDir = Join-Path $script:Wind3dJobRoot $jobId
  $inputDir = Join-Path $jobDir 'input'
  $outputDir = Join-Path $jobDir 'output'
  New-Item -ItemType Directory -Force -Path $inputDir, $outputDir | Out-Null

  if (-not $manualTurbulence) {
    Copy-Wind3dInputTree $inputSource $inputDir
  }
  $demInJob = $null
  if ($demPath) { $demInJob = Add-Wind3dFile $demPath (Join-Path $inputDir 'dem.tif') }
  if (-not $demInJob) {
    $candidate = Get-ChildItem -LiteralPath $inputDir -Filter '*.tif' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $demInJob = $candidate.FullName }
  }
  if (-not $demInJob) { throw '未找到 DEM（GeoTIFF）。常规风场请把 DEM 放进观测目录，或单独选择 DEM。' }

  $stationInJob = $null
  if ($stationSource) { $stationInJob = Add-Wind3dFile $stationSource (Join-Path $jobDir 'station.csv') }

  $inv = [Globalization.CultureInfo]::InvariantCulture
  $args = @('--json')
  switch ($mode) {
    'stations' { $args += @('run', (Quote-Wind3dArg $inputDir), '--mode', 'stations') }
    'turbulence' {
      if ($manualTurbulence) { $args += @('run', (Quote-Wind3dArg $inputDir), '--mode', 'turbulence') }
      else { $args += @('turbulence', (Quote-Wind3dArg $inputDir)) }
    }
    'assimilation' { $args += @('assimilation', (Quote-Wind3dArg $inputDir)) }
    'native-assimilation' { $args += @('native-assimilation', (Quote-Wind3dArg $inputDir)) }
  }
  foreach ($h in $heightValues) { $args += @('--height', [string]$h) }
  $args += @('--resolution', [string]$resolution)
  $args += @('--buffer', $buffer.ToString('0.###', $inv))
  $args += @('--bounds', $south.ToString('0.######', $inv), $north.ToString('0.######', $inv),
    $west.ToString('0.######', $inv), $east.ToString('0.######', $inv))

  if ($manualTurbulence) {
    $args += @('--background-speed-ms', $speed.ToString('0.###', $inv),
      '--background-direction-deg', $direction.ToString('0.###', $inv),
      '--background-height-m', $bgHeight.ToString('0.###', $inv),
      '--simulation-time', $startTime)
  } else {
    $args += @('--time-range', $startTime, $endTime)
    if ($mode -ne 'stations' -and $demInJob) { $args += @('--dem', (Quote-Wind3dArg $demInJob)) }
    if ($mode -ne 'stations') { $args += @('--uav-height-reference', $uavHeight) }
    if ($stationInJob) { $args += @('--station-observations', (Quote-Wind3dArg $stationInJob)) }
    if ($mode -eq 'native-assimilation') { $args += @('--native-runtime', (Quote-Wind3dArg $nativeRuntime)) }
  }
  if (-not $manualTurbulence -and $mode -ne 'stations') {
    $args += @('--max-cases', [string]$maxCases,
      '--reference-height', $referenceHeight.ToString('0.###', $inv),
      '--roughness', $roughness.ToString('0.###', $inv),
      '--displacement-height', $displacementHeight.ToString('0.###', $inv),
      '--canopy-height', $canopyHeight.ToString('0.###', $inv),
      '--windmaster-height-reference', $windmasterHeight,
      '--uav-direction-reference', $uavDirection)
    if ($windmasterHeight -eq 'platform_vertical_offset') {
      $args += @('--windmaster-platform-agl', $windmasterAgl.ToString('0.###', $inv))
    }
    if ($mode -eq 'assimilation') {
      $args += @('--horizontal-length-scale', $assimHScale.ToString('0.###', $inv),
        '--background-wind-sigma', $assimBgSigma.ToString('0.###', $inv),
        '--observation-wind-sigma', $assimObsSigma.ToString('0.###', $inv),
        '--vertical-length-scale', $assimVScale.ToString('0.###', $inv))
    }
    if ($mode -eq 'native-assimilation') {
      $args += @('--horizontal-radius-m', $nativeHRadius.ToString('0.###', $inv),
        '--vertical-radius-m', $nativeVRadius.ToString('0.###', $inv),
        '--max-iterations', [string]$nativeIterations,
        '--residual-tolerance', $nativeTolerance.ToString('0.######', $inv))
    }
  }
  $args += @('--output', (Quote-Wind3dArg $outputDir))
  if ($kmz) { $args += '--kmz' } else { $args += '--no-kmz' }
  $argString = $args -join ' '

  $stdout = Join-Path $jobDir 'stdout.log'
  $stderr = Join-Path $jobDir 'stderr.log'
  $exitCodePath = Join-Path $jobDir 'exitcode.txt'
  $runCmd = Join-Path $jobDir 'run.cmd'
  $cmdText = "@echo off`r`ncd /d `"%~dp0`"`r`n`"$cli`" $argString > `"$stdout`" 2> `"$stderr`"`r`necho %ERRORLEVEL%> `"$exitCodePath`"`r`n"
  [IO.File]::WriteAllText($runCmd, $cmdText, [Text.Encoding]::Default)

  $job = @{
    id = $jobId
    status = 'running'
    pid = 0
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    finishedAt = $null
    exitCode = $null
    jobDir = $jobDir
    inputDir = $inputDir
    outputDir = $outputDir
    stdout = $stdout
    stderr = $stderr
    exitCodePath = $exitCodePath
    runCmd = $runCmd
    command = $cli + ' ' + $argString
    params = @{
      mode = $mode
      turbSource = $turbSource
      demPath = $demPath
      inputDir = $inputSource
      stationCsv = $stationSource
      uavHeightReference = $uavHeight
      nativeRuntime = $nativeRuntime
      south = $south
      west = $west
      north = $north
      east = $east
      time = $time
      heights = $heightValues
      resolution = $resolution
      speed = $speed
      direction = $direction
      backgroundHeight = $bgHeight
    }
    scenes = @()
    process = $null
  }
  try {
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', (Quote-Wind3dArg $runCmd) -WorkingDirectory $jobDir -WindowStyle Hidden -PassThru
    $job.process = $process
    $job.pid = $process.Id
  } catch {
    $job.status = 'failed'
    $job.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $job.exitCode = -1
    Write-Wind3dJobState $job
    throw '启动 Wind3D 失败：' + $_.Exception.Message
  }
  # 并发写保护：字典写入不是原子操作，工作线程同时启动任务会丢条目。
  $lock = $script:SharedState['Wind3dLock']
  if ($lock) { [Threading.Monitor]::Enter($lock) }
  try { $script:Wind3dJobs[$jobId] = $job } finally { if ($lock) { [Threading.Monitor]::Exit($lock) } }
  Write-Wind3dJobState $job
  return $job
}

function Find-Wind3dJob([string]$id) {
  if ($script:Wind3dJobs.ContainsKey($id)) { return $script:Wind3dJobs[$id] }
  return $null
}

function Handle-Wind3dApi($ctx, [string]$apiPath) {
  $method = $ctx.Request.HttpMethod
  if ($method -eq 'OPTIONS') {
    Write-JsonResponse $ctx @{ ok = $true } 204
    return
  }
  if ($apiPath -eq '/api/wind3d/status' -and $method -eq 'GET') {
    $cli = Get-Wind3dCliPath
    $version = Get-Wind3dVersion $cli
    $compatible = $false
    if ($version) {
      try { $compatible = ([version]$version -ge [version]'1.1.9') } catch { }
    }
    $jobs = @($script:Wind3dJobs.Values | Sort-Object { $_.startedAt } -Descending | Select-Object -First 20 | ForEach-Object { Get-Wind3dJobState $_ })
    Write-JsonResponse $ctx @{
      ok = $true
      cli = $cli
      cliFound = [bool]$cli
      version = $version
      minVersion = '1.1.9'
      compatible = $compatible
      windninja = '3.12.2'
      jobs = $jobs
    }
    return
  }
  if ($apiPath -eq '/api/wind3d/run' -and $method -eq 'POST') {
    try {
      $body = Read-JsonBody $ctx
      $job = Start-Wind3dJob $body
      Write-JsonResponse $ctx @{ ok = $true; jobId = $job.id; job = (Get-Wind3dJobState $job) }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 400
    }
    return
  }
  if ($apiPath -eq '/api/wind3d/jobs' -and $method -eq 'GET') {
    $jobs = @($script:Wind3dJobs.Values | Sort-Object { $_.startedAt } -Descending | Select-Object -First 20 | ForEach-Object { Get-Wind3dJobState $_ })
    Write-JsonResponse $ctx @{ ok = $true; jobs = $jobs }
    return
  }
  if ($apiPath -eq '/api/wind3d/pick-dem' -and $method -eq 'POST') {
    $helper = Join-Path $Root 'tools\pick-dem.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
      Write-JsonResponse $ctx @{ ok = $false; error = '缺少 tools\pick-dem.ps1' } 500
      return
    }
    try {
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      if (-not (Test-Path $ps)) { $ps = 'powershell.exe' }
      $output = @(& $ps -NoProfile -STA -ExecutionPolicy Bypass -File $helper 2>$null)
      $picked = $null
      foreach ($line in $output) {
        $candidate = ([string]$line).Trim()
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $picked = $candidate }
      }
      if ($picked) { Write-JsonResponse $ctx @{ ok = $true; path = $picked } }
      else { Write-JsonResponse $ctx @{ ok = $false; cancelled = $true } }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }
  if ($apiPath -eq '/api/wind3d/pick-input-dir' -and $method -eq 'POST') {
    $helper = Join-Path $Root 'tools\pick-folder.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
      Write-JsonResponse $ctx @{ ok = $false; error = '缺少 tools\pick-folder.ps1' } 500
      return
    }
    try {
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      if (-not (Test-Path $ps)) { $ps = 'powershell.exe' }
      $output = @(& $ps -NoProfile -STA -ExecutionPolicy Bypass -File $helper 2>$null)
      $picked = $null
      foreach ($line in $output) {
        $candidate = ([string]$line).Trim()
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { $picked = $candidate }
      }
      if ($picked) { Write-JsonResponse $ctx @{ ok = $true; path = $picked } }
      else { Write-JsonResponse $ctx @{ ok = $false; cancelled = $true } }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }
  if ($apiPath -eq '/api/wind3d/pick-file' -and $method -eq 'POST') {
    $helper = Join-Path $Root 'tools\pick-file.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
      Write-JsonResponse $ctx @{ ok = $false; error = '缺少 tools\pick-file.ps1' } 500
      return
    }
    try {
      $body = Read-JsonBody $ctx
      $filter = [string]$body.filter
      if (-not $filter) { $filter = 'CSV (*.csv)|*.csv|All files (*.*)|*.*' }
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      if (-not (Test-Path $ps)) { $ps = 'powershell.exe' }
      $output = @(& $ps -NoProfile -STA -ExecutionPolicy Bypass -File $helper -Filter $filter 2>$null)
      $picked = $null
      foreach ($line in $output) {
        $candidate = ([string]$line).Trim()
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $picked = $candidate }
      }
      if ($picked) { Write-JsonResponse $ctx @{ ok = $true; path = $picked } }
      else { Write-JsonResponse $ctx @{ ok = $false; cancelled = $true } }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }
  $match = [regex]::Match($apiPath, '^/api/wind3d/jobs/([A-Za-z0-9_-]+)(/log|/cancel)?$')
  if ($match.Success) {
    $id = $match.Groups[1].Value
    $action = $match.Groups[2].Value
    $job = Find-Wind3dJob $id
    if (-not $job) {
      Write-JsonResponse $ctx @{ ok = $false; error = '任务不存在或服务已重启' } 404
      return
    }
    Update-Wind3dJob $job
    if ($action -eq '/log' -and $method -eq 'GET') {
      $lines = 160
      $query = $ctx.Request.QueryString['lines']
      if ($query) { [void][int]::TryParse($query, [ref]$lines) }
      Write-JsonResponse $ctx @{ ok = $true; jobId = $id; status = $job.status; log = (Get-Wind3dLog $job $lines) }
      return
    }
    if ($action -eq '/cancel' -and $method -eq 'POST') {
      Stop-Wind3dJob $job
      Write-JsonResponse $ctx @{ ok = $true; jobId = $id; status = $job.status }
      return
    }
    if (-not $action -and $method -eq 'GET') {
      $state = Get-Wind3dJobState $job
      $state.log = Get-Wind3dLog $job 60
      Write-JsonResponse $ctx $state
      return
    }
    Write-JsonResponse $ctx @{ ok = $false; error = '不支持的请求' } 405
    return
  }
  Write-JsonResponse $ctx @{ ok = $false; error = '未知的 Wind3D API' } 404
}

# ==========================================================================
# 数据仓库 API（/api/vault/*）
# --------------------------------------------------------------------------
# 设计原则：**解码全在浏览器里，服务端只落盘**。
#   - 浏览器已经带了 geotiff.js（读 TIFF/GeoTIFF/COG）、proj4（重投影）、
#     LERpc（国产卫星 RPC 定位）、canvas（写 PNG/JPEG）。
#   - 服务端因此**不需要**任何第三方运行时（无 GDAL、无 Python、无 GDAL/CLI 依赖），
#     保持了「纯离线、零外部依赖」的产品定位。
#   - 浏览器负责：格式探测 → 解码 → 重投影/重采样 → 切瓦片 → 编码；
#     服务端负责：把编码好的字节写到 data/ 下的正确位置，并维护清单 JSON。
#
# 安全：所有路径都被限制在 $Root 之内（vault 根 = data/local 与 data/public/dem）。
# ==========================================================================

$script:VaultRoot = Join-Path $Root 'data\local'

function Get-VaultSafePath([string]$rel) {
  # 把相对路径解析到 data/local 之下，拒绝任何越界（..\ 或绝对路径）。
  if (-not $rel) { return $null }
  $base = [System.IO.Path]::GetFullPath($script:VaultRoot)
  $full = [System.IO.Path]::GetFullPath((Join-Path $base $rel))
  if (-not $full.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $full
}

function Read-BinaryBody($ctx) {
  $ms = New-Object System.IO.MemoryStream
  try {
    $ctx.Request.InputStream.CopyTo($ms)
    return $ms.ToArray()
  } finally {
    $ms.Dispose()
  }
}

function Handle-VaultApi($ctx, [string]$apiPath) {
  $method = $ctx.Request.HttpMethod
  if ($method -eq 'OPTIONS') {
    Write-JsonResponse $ctx @{ ok = $true } 204
    return
  }

  # --- 选择本地文件（多选）---
  if ($apiPath -eq '/api/vault/pick-files' -and $method -eq 'POST') {
    $helper = Join-Path $Root 'tools\pick-files.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
      Write-JsonResponse $ctx @{ ok = $false; error = '缺少 tools\pick-files.ps1' } 500
      return
    }
    try {
      $body = Read-JsonBody $ctx
      $filter = [string]$body.filter
      if (-not $filter) { $filter = '所有文件 (*.*)|*.*' }
      $desc = [string]$body.description
      if (-not $desc) { $desc = '选择数据文件（可多选）' }
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      if (-not (Test-Path $ps)) { $ps = 'powershell.exe' }
      $output = @(& $ps -NoProfile -STA -ExecutionPolicy Bypass -File $helper -Filter $filter -Description $desc 2>$null)
      $picked = @()
      foreach ($line in $output) {
        $candidate = ([string]$line).Trim()
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $picked += $candidate }
      }
      if ($picked.Count -gt 0) { Write-JsonResponse $ctx @{ ok = $true; paths = $picked } }
      else { Write-JsonResponse $ctx @{ ok = $false; cancelled = $true } }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 选择本地文件夹（递归扫描用）---
  if ($apiPath -eq '/api/vault/pick-dir' -and $method -eq 'POST') {
    $helper = Join-Path $Root 'tools\pick-folder.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
      Write-JsonResponse $ctx @{ ok = $false; error = '缺少 tools\pick-folder.ps1' } 500
      return
    }
    try {
      $body = Read-JsonBody $ctx
      $desc = [string]$body.description
      if (-not $desc) { $desc = '选择数据目录' }
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      if (-not (Test-Path $ps)) { $ps = 'powershell.exe' }
      $output = @(& $ps -NoProfile -STA -ExecutionPolicy Bypass -File $helper -Description $desc 2>$null)
      $picked = $null
      foreach ($line in $output) {
        $candidate = ([string]$line).Trim()
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { $picked = $candidate }
      }
      if ($picked) { Write-JsonResponse $ctx @{ ok = $true; path = $picked } }
      else { Write-JsonResponse $ctx @{ ok = $false; cancelled = $true } }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 读文件（浏览器拿到系统路径后回读字节）---
  # query: ?path=<绝对路径>
  # 浏览器本身拿不到本机路径，所以「选文件」必须经服务端；
  # 选中之后由服务端把字节回传给浏览器解码。
  if ($apiPath -eq '/api/vault/read' -and $method -eq 'GET') {
    try {
      $path = $ctx.Request.QueryString['path']
      if (-not $path) {
        Write-JsonResponse $ctx @{ ok = $false; error = '缺少 path' } 400
        return
      }
      $full = [System.IO.Path]::GetFullPath($path)
      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Write-JsonResponse $ctx @{ ok = $false; error = '文件不存在：' + $path } 404
        return
      }
      $fi = Get-Item -LiteralPath $full
      $res = $ctx.Response
      $res.StatusCode = 200
      $res.ContentType = 'application/octet-stream'
      $res.Headers['Cache-Control'] = 'no-store'
      $res.Headers['Access-Control-Allow-Origin'] = '*'
      $res.Headers['Content-Length'] = $fi.Length
      if ($ctx.Request.HttpMethod -ne 'HEAD') {
        $fs = [System.IO.File]::OpenRead($full)
        try {
          $buf = New-Object byte[] 1048576
          $remaining = $fi.Length
          while ($remaining -gt 0) {
            $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $remaining))
            if ($n -le 0) { break }
            $res.OutputStream.Write($buf, 0, $n)
            $remaining -= $n
          }
        } finally { $fs.Close() }
      }
      $res.OutputStream.Close()
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 写文件（浏览器解码后回传成品字节）---
  # body: { path: 'imagery/<id>/tiles/3/1/2.jpg', data: '<base64>' }
  # 或  : { files: [ {path, data}, ... ] }   批量（一次请求写多个瓦片）
  if ($apiPath -eq '/api/vault/write' -and $method -eq 'POST') {
    try {
      $body = Read-JsonBody $ctx
      $written = @()
      $failed = @()

      $items = @()
      if ($body.files) { $items = @($body.files) }
      elseif ($body.path) { $items = @(@{ path = [string]$body.path; data = [string]$body.data }) }

      foreach ($item in $items) {
        $rel = [string]$item.path
        $full = Get-VaultSafePath $rel
        if (-not $full) {
          $failed += @{ path = $rel; error = '非法路径' }
          continue
        }
        $b64 = [string]$item.data
        if (-not $b64) {
          $failed += @{ path = $rel; error = '缺少 data' }
          continue
        }
        try {
          $bytes = [Convert]::FromBase64String($b64)
          $dir = [System.IO.Path]::GetDirectoryName($full)
          if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            $null = New-Item -ItemType Directory -Path $dir -Force
          }
          # 先写临时文件再原子替换，避免中途失败留下半个瓦片
          $tmp = $full + '.part'
          [System.IO.File]::WriteAllBytes($tmp, $bytes)
          if (Test-Path -LiteralPath $full -PathType Leaf) {
            [System.IO.File]::Delete($full)
          }
          [System.IO.File]::Move($tmp, $full)
          $written += @{ path = $rel; bytes = $bytes.Length }
        } catch {
          $failed += @{ path = $rel; error = $_.Exception.Message }
        }
      }

      if ($written.Count -eq 0 -and $failed.Count -gt 0) {
        Write-JsonResponse $ctx @{ ok = $false; error = $failed[0].error; failed = $failed } 400
        return
      }
      Write-JsonResponse $ctx @{ ok = $true; written = $written.Count; failed = $failed }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 删除（带目录保护）---
  if ($apiPath -eq '/api/vault/delete' -and $method -eq 'POST') {
    try {
      $body = Read-JsonBody $ctx
      $rel = [string]$body.path
      $full = Get-VaultSafePath $rel
      if (-not $full) {
        Write-JsonResponse $ctx @{ ok = $false; error = '非法路径：' + $rel } 400
        return
      }
      $deleted = $false
      if (Test-Path -LiteralPath $full -PathType Container) {
        Remove-Item -LiteralPath $full -Recurse -Force
        $deleted = $true
      } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
        Remove-Item -LiteralPath $full -Force
        $deleted = $true
      }
      Write-JsonResponse $ctx @{ ok = $true; deleted = $deleted; path = $rel }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 列举 data/local 下的内容（给「数据仓库」面板显示存量）---
  if ($apiPath -eq '/api/vault/list' -and $method -eq 'GET') {
    try {
      $items = @()
      if (Test-Path -LiteralPath $script:VaultRoot -PathType Container) {
        foreach ($d in Get-ChildItem -LiteralPath $script:VaultRoot -Directory -ErrorAction SilentlyContinue) {
          $size = 0L
          $count = 0
          try {
            foreach ($f in Get-ChildItem -LiteralPath $d.FullName -Recurse -File -ErrorAction SilentlyContinue) {
              $size += $f.Length
              $count += 1
            }
          } catch { }
          $items += @{
            id = $d.Name
            files = $count
            bytes = $size
            modified = $d.LastWriteTimeUtc.ToString('o')
          }
        }
      }
      Write-JsonResponse $ctx @{ ok = $true; items = $items }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  Write-JsonResponse $ctx @{ ok = $false; error = '未知的仓库 API' } 404
}

# ==========================================================================
# 3D Tiles 倾斜摄影挂载（/api/tiles3d/*  +  /tiles3d/<id>/...）
# --------------------------------------------------------------------------
# 【为什么需要「挂载」】
#   倾斜摄影数据在本机是一整个目录树（根目录 + 若干层瓦片子目录）。
#   浏览器拿不到本机绝对路径，而 Cesium 只认 URL —— 所以要让 Cesium 读到
#   本机目录树，必须由本地服务器把该目录「挂」到一个可访问的 URL 前缀下。
#
# 【设计：挂载表是纯内存的】
#   挂载表（id → 绝对路径）只存在内存里，服务一关就没了。
#   好处：不往 data/ 里写任何东西，不污染数据仓库，也不会把用户数据
#   混进 Git 忽略目录。软件重启后需要重新挂载一次（这与 Google Earth Pro
#   「添加文件夹」的行为一致）。
#
# 【安全】
#   - 挂载目录可以选任意本机目录（这是用户主动选的），但**读取时**必须
#     解析到挂载根之下，拒绝 ..\ 与绝对路径穿越。
#   - 只读：这个接口不提供任何写操作。
# ==========================================================================

$script:Tiles3dMounts = @{}

function Get-Tiles3dSafePath([string]$mountId, [string]$rel) {
  if (-not $script:Tiles3dMounts.ContainsKey($mountId)) { return $null }
  $base = [System.IO.Path]::GetFullPath($script:Tiles3dMounts[$mountId])
  if (-not $rel) { return $base }
  # **必须先做 URL 解码**：浏览器/客户端可能把 ../ 编码成 %2e%2e%2f。
  # 不解码的话下面 Split-Path 的路径检查会被绕过（实测能读出挂载目录之外的文件）。
  $decoded = [System.Uri]::UnescapeDataString($rel)
  $decoded = $decoded.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  # 解码后再判一次：含 .. 的一律拒绝（不靠规范化兜底，直接挡掉）
  if ($decoded -match '(^|[\\/])\.\.([\\/]|$)') { return $null }
  $full = [System.IO.Path]::GetFullPath((Join-Path $base $decoded))
  if ($full -eq $base) { return $full }
  if (-not $full.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $full
}

# --- 联网状态探测（GET /api/net/probe） ---
# 自动模式在公开源码构建中维持离线，不向第三方连通性端点发送请求。
# 用户显式切换在线后，由浏览器请求地图瓦片；此接口不代表网络可达性。
function Handle-NetApi($ctx, [string]$apiPath) {
  $method = $ctx.Request.HttpMethod
  if ($method -eq 'OPTIONS') {
    Write-JsonResponse $ctx @{ ok = $true } 204
    return
  }
  if ($apiPath -eq '/api/net/probe' -and ($method -eq 'GET' -or $method -eq 'HEAD')) {
    Write-JsonResponse $ctx @{ ok = $true; online = $false; latencyMs = $null; error = 'Public source build is local-only'; checkedAt = [DateTime]::UtcNow.ToString('o') }
    return
  }
  Write-JsonResponse $ctx @{ ok = $false; error = '未知的网络接口：' + $apiPath } 404
}

function Handle-Tiles3dApi($ctx, [string]$apiPath) {
  $method = $ctx.Request.HttpMethod
  if ($method -eq 'OPTIONS') {
    Write-JsonResponse $ctx @{ ok = $true } 204
    return
  }

  # --- 挂载一个目录 ---
  if ($apiPath -eq '/api/tiles3d/mount' -and $method -eq 'POST') {
    try {
      $body = Read-JsonBody $ctx
      $dir = [string]$body.path
      if (-not $dir) { Write-JsonResponse $ctx @{ ok = $false; error = '缺少 path' } 400; return }
      $full = [System.IO.Path]::GetFullPath($dir)
      if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        Write-JsonResponse $ctx @{ ok = $false; error = '目录不存在：' + $dir } 404
        return
      }
      # id 由路径派生：同一目录重复挂载得到同一个 id，不会堆一堆
      $slug = [System.IO.Path]::GetFileName($full.TrimEnd('\', '/'))
      if (-not $slug) { $slug = 'tiles' }
      $slug = ($slug -replace '[^A-Za-z0-9_\-]', '-')
      $id = $slug
      $n = 1
      $lock = $script:SharedState['Tiles3dLock']
      if ($lock) { [Threading.Monitor]::Enter($lock) }
      try {
        while ($script:Tiles3dMounts.ContainsKey($id) -and $script:Tiles3dMounts[$id] -ne $full) {
          $n++
          $id = $slug + '-' + $n
        }
        $script:Tiles3dMounts[$id] = $full
      } finally { if ($lock) { [Threading.Monitor]::Exit($lock) } }

      # 扫描目录树，列出可加载的数据集与文件清单
      $files = @()
      try {
        foreach ($f in Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue) {
          $rel = $f.FullName.Substring($full.Length).TrimStart('\', '/').Replace('\', '/')
          $files += $rel
        }
      } catch { }
      Write-JsonResponse $ctx @{ ok = $true; id = $id; path = $full; url = ('/tiles3d/' + $id + '/'); files = $files }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 列出已挂载的目录 ---
  if ($apiPath -eq '/api/tiles3d/list' -and $method -eq 'GET') {
    try {
      $items = @()
      $lock = $script:SharedState['Tiles3dLock']
      if ($lock) { [Threading.Monitor]::Enter($lock) }
      try {
        foreach ($k in $script:Tiles3dMounts.Keys) {
          $items += @{ id = $k; path = $script:Tiles3dMounts[$k]; url = ('/tiles3d/' + $k + '/') }
        }
      } finally { if ($lock) { [Threading.Monitor]::Exit($lock) } }
      Write-JsonResponse $ctx @{ ok = $true; items = $items }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 卸载 ---
  if ($apiPath -eq '/api/tiles3d/unmount' -and $method -eq 'POST') {
    try {
      $body = Read-JsonBody $ctx
      $id = [string]$body.id
      $lock = $script:SharedState['Tiles3dLock']
      if ($lock) { [Threading.Monitor]::Enter($lock) }
      try {
        $existed = $script:Tiles3dMounts.ContainsKey($id)
        if ($existed) { $script:Tiles3dMounts.Remove($id) }
      } finally { if ($lock) { [Threading.Monitor]::Exit($lock) } }
      Write-JsonResponse $ctx @{ ok = $true; removed = $existed; id = $id }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  # --- 扫描一个目录（不挂载，只看里面有什么）---
  if ($apiPath -eq '/api/tiles3d/scan' -and $method -eq 'POST') {
    try {
      $body = Read-JsonBody $ctx
      $dir = [string]$body.path
      $full = [System.IO.Path]::GetFullPath($dir)
      if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        Write-JsonResponse $ctx @{ ok = $false; error = '目录不存在：' + $dir } 404
        return
      }
      $files = @()
      $bytes = 0L
      try {
        foreach ($f in Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue) {
          $rel = $f.FullName.Substring($full.Length).TrimStart('\', '/').Replace('\', '/')
          $files += $rel
          $bytes += $f.Length
        }
      } catch { }
      Write-JsonResponse $ctx @{ ok = $true; path = $full; files = $files; bytes = $bytes }
    } catch {
      Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500
    }
    return
  }

  Write-JsonResponse $ctx @{ ok = $false; error = '未知的 3D Tiles API' } 404
}

$port = Find-FreePort $Port
if (-not $port) {
  Write-Host "错误：找不到可用端口（$Port 起 40 个端口都被占用）。" -ForegroundColor Red
  exit 1
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$port/"
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "无法启动本地服务器：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "提示：某些环境需要管理员权限绑定端口；可尝试其它端口，例如 -Port 9000。"
  exit 1
}

Write-Host ""
Write-Host "  本地地球 Local Earth" -ForegroundColor Cyan
Write-Host "  地址：$prefix" -ForegroundColor Green
Write-Host "  数据目录：$Root" -ForegroundColor DarkGray
Write-Host "  完全离线：仅监听 127.0.0.1，不向互联网发起请求。" -ForegroundColor DarkGray
Write-Host "  关闭：在此窗口按 Ctrl+C" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------------
# Brotli 缓存预热（后台）
#
# 【为什么要有】Brotli 压缩是**按需**做的（.NET 没有 BrotliStream，
#   得调 node 子进程）。冷缓存时第一个请求要等压缩完成：
#   N25E102-terrain.bin 25.93 MB → 12.09 MB，实测冷启动 3.23 s，
#   第二次起 0.03 s。这 3 s 卡在首屏上很难受。
#
# 【做法】服务器起来后**后台**跑 tools/brotli-warm.mjs，
#   把所有够大的可压缩文件压进 .brcache/。首屏请求时缓存已经在了。
#
# 【为什么放后台】预热要几十秒（N25 单个文件就 3 s），
#   同步做会把「打开软件」拖成「打开软件后干等」。放后台，
#   服务器立刻可用，缓存慢慢填。
#
# 【无害】预热失败不影响功能 —— 退化成「首次请求现压」。
$warmTool = Join-Path $Root 'tools/brotli-warm.mjs'
if (Test-Path -LiteralPath $warmTool) {
  try {
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue)
    if ($nodeExe) {
      # Start-Process -WindowStyle Hidden：不要弹黑框。
      # 压缩在 node 里是同步的，这里只是不阻塞 PowerShell 主线程。
      Start-Process -FilePath $nodeExe.Source `
        -ArgumentList @($warmTool, $Root, $script:BrotliQuality, '--quiet') `
        -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
      Write-Host "  （后台预热 Brotli 缓存…）" -ForegroundColor DarkGray
    }
  } catch { }
}

if (-not $NoBrowser) { Open-Browser $port }

# ---------------------------------------------------------------------------
# 并发处理
#
# 【为什么要并发】
#   原来这里是**单线程**的：$listener.GetContext() 一次只接一个请求，
#   处理完再接下一个。浏览器启动时会同时发几十上百个瓦片请求，
#   于是它们被排成一队一个个处理。
#   实测：同一批 128 张 z12 瓦片，
#     serve.ps1（单线程）              → 7830 ms
#     tools/serve_local.py（多线程）   →  166 ms
#   差 47 倍。单个请求 5.4 ms × 128 = 690 ms 排队开销，
#   加上单请求本身的耗时，瓦片层迟迟铺不满 —— 这就是「加载太慢」的一半原因。
#
# 【怎么改】
#   用 PowerShell 5.1 自带的 RunspacePool（不需要额外模块）：
#   主线程只负责 accept，具体处理丢进池子里的工作线程。
#   池子大小默认 16 —— 超过这个数请求就在池外排队，
#   但每个请求很快，排队时间可以忽略。
#
# 【工作线程怎么拿到主脚本的函数】
#   RunspacePool 的工作线程是**独立的 runspace**，默认看不见主脚本里
#   定义的函数（实测：主脚本的 Test-MainFunc 在工作线程里报
#   「无法将 Test-MainFunc 识别为 cmdlet」）。
#   所以要把用到的函数**注入**进去：把主脚本里定义的函数收集成
#   ScriptBlock 文本，作为参数传给工作线程，在工作线程里
#   Invoke-Expression 重新定义成真正的函数。
#
# 【工作线程里日志怎么输出】
#   Write-Host 在独立 runspace 里**不写到主控制台**（实测：完全看不到）。
#   所以日志改用 [Console]::WriteLine 直写进程 stdout。
#
# 【线程安全】
#   - $Root / $Mime 是脚本级只读变量 —— 主线程灌进 $Shared，
#     工作线程启动时写进自己的 $script: 作用域。
#   - $script:Wind3dJobs / $script:VaultRoot / $script:Tiles3dMounts
#     是**可变**状态。工作线程里 $script:xxx 指向各自的脚本作用域，
#     不会自动共享 —— 所以这几个改成**显式共享对象**（放进 $Shared），
#     写操作再加锁保护。
# ---------------------------------------------------------------------------

$WorkerCount = 16
if ($env:LOCAL_EARTH_WORKERS) {
  $n = 0
  if ([int]::TryParse($env:LOCAL_EARTH_WORKERS, [ref]$n) -and $n -ge 1 -and $n -le 64) {
    $WorkerCount = $n
  }
}

# --- 共享状态（主线程创建，工作线程读写）---
$SharedState = [hashtable]::Synchronized(@{})
$script:SharedState = $SharedState
$SharedState['Wind3dJobs'] = $script:Wind3dJobs
$SharedState['Wind3dJobRoot'] = $script:Wind3dJobRoot
$SharedState['VaultRoot'] = $script:VaultRoot
$SharedState['Tiles3dMounts'] = $script:Tiles3dMounts
$SharedState['Root'] = $Root
$identityHash = [Security.Cryptography.SHA256]::Create()
try {
  $identityRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/').ToUpperInvariant()
  $SharedState['AppIdentity'] = [BitConverter]::ToString($identityHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($identityRoot)))
} finally { $identityHash.Dispose() }
$SharedState['Mime'] = $Mime
# 锁：Wind3dJobs / Tiles3dMounts 的并发写保护
$SharedState['Wind3dLock'] = New-Object System.Object
$SharedState['Tiles3dLock'] = New-Object System.Object
# 工作线程等待请求用的信号量：
# ConcurrentQueue 只有 TryDequeue（空队列返回 $false），没有阻塞等待。
# 用信号量 + 队列配合：Enqueue 时 Release（唤醒一个等待者），
# TryDequeue 失败时 WaitOne（挂起，不空转）。
# 早先用 20 ms 轮询：每个请求平均多等 ~10 ms，而且 16 个线程都在轮询 → 反而变慢。
#
# 【队列选型】BlockingCollection，而不是 ConcurrentQueue + 信号量。
#   - ConcurrentQueue<T> 没有阻塞等待的 Get()（只有 TryDequeue，空队列返回 $false）。
#     配 SemaphoreSlim 会**丢唤醒**：SemaphoreSlim 连 Release 都没有，WaitOne 也不存在。
#   - 配 System.Threading.Semaphore 虽能 WaitOne，但「信号量计数」和「队列实际长度」
#     会脱节（多个线程竞争时一个 Release 只唤醒一个），多请求要等下一轮才被处理。
#   - BlockingCollection<T> 自带**有界阻塞队列**：TryTake(out item, 超时) 语义干净，
#     不会有上面的两种失配。
$SharedState['Queue'] = New-Object 'System.Collections.Concurrent.BlockingCollection[System.Net.HttpListenerContext]'
$script:Quiet = ($env:LOCAL_EARTH_QUIET -eq '1')
$SharedState['Quiet'] = $script:Quiet
# 压缩相关（工作线程需要：runspace 只注入函数体，脚本级变量不会跟过去）
$SharedState['CompressibleExt'] = $script:CompressibleExt
$SharedState['GzCacheDir'] = (Join-Path $Root '.gzcache')
# Brotli 相关（工作线程需要：runspace 只注入函数体，脚本级变量不会跟过去）
$SharedState['BrCacheDir'] = (Join-Path $Root '.brcache')
$SharedState['BrotliTool'] = $script:BrotliTool
$SharedState['BrotliQuality'] = $script:BrotliQuality
$SharedState['GzipLevel'] = $script:GzipLevel

function Write-ServerLog([string]$message, [string]$color = 'Gray') {
  # 每个请求都写一行日志，在高并发下会成为**串行瓶颈**（控制台写入是独占的）。
  # 用 LOCAL_EARTH_QUIET=1 关闭；只保留错误。
  # 注意：$script:Quiet 在工作线程里指向的是**工作线程自己的脚本作用域**，
  # 必须在 Initialize-SharedStateForWorker 里赋值 —— 那里已经做了。
  if ($script:Quiet -and $color -ne 'Red') { return }
  # 工作线程里的 Write-Host 不输出到主控制台（独立 runspace 没有主 host），
  # 所以日志统一走 [Console] 直写进程 stdout。
  try { [Console]::ForegroundColor = [System.ConsoleColor]::$color } catch { }
  try { [Console]::WriteLine($message) } catch { }
  try { [Console]::ResetColor() } catch { }
}

function Initialize-SharedStateForWorker {
  # 把只读的脚本级变量灌进工作线程的脚本作用域。
  # 工作线程的 $PSScriptRoot 为空，所以 $Root 必须显式传。
  param($Shared)
  $script:Root = $Shared['Root']
  $script:Mime = $Shared['Mime']
  $script:Wind3dJobs = $Shared['Wind3dJobs']
  $script:Wind3dJobRoot = $Shared['Wind3dJobRoot']
  $script:VaultRoot = $Shared['VaultRoot']
  $script:Tiles3dMounts = $Shared['Tiles3dMounts']
  $script:Quiet = $Shared['Quiet']
  # 压缩相关（Get-GzipBytes / Test-CompressiblePath 依赖）
  $script:CompressibleExt = $Shared['CompressibleExt']
  $script:GzipLevel = $Shared['GzipLevel']
  $script:BrotliTool = $Shared['BrotliTool']
  $script:BrotliQuality = $Shared['BrotliQuality']
  $script:SharedState = $Shared
}

# --- 把原来 while 循环里的处理体抽成函数 ---
function Invoke-RequestHandler($ctx) {
  $req = $ctx.Request
  try {
    $apiPath = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($apiPath -eq '/api/app/identity') {
      Send-Response $ctx 200 'text/plain' ([Text.Encoding]::UTF8.GetBytes([string]$script:SharedState['AppIdentity']))
      return
    }
    if ($apiPath -like '/api/wind3d/*') {
      try { Handle-Wind3dApi $ctx $apiPath }
      catch {
        try { Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500 } catch { }
      }
      return
    }
    if ($apiPath -like '/api/vault/*') {
      try { Handle-VaultApi $ctx $apiPath }
      catch {
        try { Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500 } catch { }
      }
      return
    }
    if ($apiPath -like '/api/net/*') {
      try { Handle-NetApi $ctx $apiPath }
      catch {
        try { Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500 } catch { }
      }
      return
    }
    if ($apiPath -like '/api/tiles3d/*') {
      try { Handle-Tiles3dApi $ctx $apiPath }
      catch {
        try { Write-JsonResponse $ctx @{ ok = $false; error = $_.Exception.Message } 500 } catch { }
      }
      return
    }
    # --- 已挂载的 3D Tiles 目录树：/tiles3d/<id>/<相对路径> ---
    # 只读；路径必须落在挂载根之下。
    if ($apiPath -like '/tiles3d/*') {
      $sub = $apiPath.Substring('/tiles3d/'.Length)
      $slash = $sub.IndexOf('/')
      if ($slash -lt 0) {
        Send-Response $ctx 404 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('404 Not Found'))
        return
      }
      $mountId = $sub.Substring(0, $slash)
      $relPart = $sub.Substring($slash + 1)
      $tFull = Get-Tiles3dSafePath $mountId $relPart
      if (-not $tFull -or -not (Test-Path -LiteralPath $tFull -PathType Leaf)) {
        Send-Response $ctx 404 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('404 Not Found: ' + $relPart))
        Write-ServerLog ("404 " + $req.HttpMethod + " " + $req.Url.AbsolutePath) 'DarkYellow'
        return
      }
      $tExt = [System.IO.Path]::GetExtension($tFull).ToLowerInvariant()
      $tCtype = $Mime[$tExt]
      if (-not $tCtype) { $tCtype = 'application/octet-stream' }
      $sentT = Send-FileResponse $ctx $tFull $tCtype
      Write-ServerLog ("200 " + $req.HttpMethod + " " + $req.Url.AbsolutePath + " (" + $sentT + " B)") 'DarkGray'
      return
    }
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
    $rel = $rel.Replace('/', '\').TrimStart('\')
    $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))

    if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Response $ctx 403 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('403 Forbidden'))
      return
    }
    if ((Test-Path $full) -and (Get-Item $full).PSIsContainer) {
      $full = Join-Path $full 'index.html'
    }
    if (-not (Test-Path $full -PathType Leaf)) {
      # **可选清单**（数据仓库 / 本地 DEM 源清单）不存在时返回空默认值，
      # 而不是 404 —— 否则浏览器控制台会刷一片红，看起来像软件坏了。
      # 这些文件是「有则用、无则跳过」的，不是错误。
      $optionalManifest = @(
        'data\local\vault.json',
        'data\local\dem\sources.json'
      )
      $relNorm = $rel.Replace('/', '\')
      if ($optionalManifest -contains $relNorm) {
        Send-Response $ctx 200 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('{"version":1,"datasets":[],"sources":[]}'))
        return
      }
      # 瓦片扩展名兜底：同一份数据 png/jpg 混排时自动改用存在的那个扩展名，
      # 避免前端「双扩展名探测」在控制台留下一半 404。
      $alt = Resolve-AlternateImageExtension $full
      if ($alt) { $full = $alt }
      else {
        # 影像瓦片路径（{z}/{x}/{y}.jpg|png）确实缺这张 → 回一张 1×1 透明 PNG。
        # 理由：瓦片缺失是**数据边界**，不是程序错误。回 404 会让浏览器控制台
        # 刷一片红（看起来像软件坏了），而 EOX 对同样的无数据区域也是回
        # 116 字节透明 PNG。透明瓦片让该处透出底图，画面正常、控制台干净，
        # 同时服务端日志照旧留痕（缺失是数据问题，需要被看见）。
        $ext0 = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $isTilePath = ($ext0 -eq '.jpg' -or $ext0 -eq '.jpeg' -or $ext0 -eq '.png') -and
                       ($rel -match 'tiles?\\')
        if ($isTilePath) {
          Send-Response $ctx 200 'image/png' (Get-BlankTilePng)
          Write-ServerLog ("缺瓦片 " + $req.HttpMethod + " " + $req.Url.AbsolutePath + " → 透明瓦片") 'DarkYellow'
          return
        }
        Send-Response $ctx 404 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel"))
        Write-ServerLog ("404 " + $req.HttpMethod + " " + $req.Url.AbsolutePath) 'DarkYellow'
        return
      }
    }

    $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
    $ctype = $Mime[$ext]
    if (-not $ctype) { $ctype = 'application/octet-stream' }
    if ($ctype -eq 'image/jpeg' -or $ctype -eq 'image/png') {
      $ctype = Resolve-ImageContentType $full $ctype
    }
    $sent = Send-FileResponse $ctx $full $ctype
    Write-ServerLog ("200 " + $req.HttpMethod + " " + $req.Url.AbsolutePath + " (" + $sent + " B)") 'DarkGray'
  } catch {
    try {
      Send-Response $ctx 500 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('500 Internal Server Error'))
    } catch {}
    $errMsg = "500 " + $req.HttpMethod + " " + $req.Url.AbsolutePath + " : " + $_.Exception.Message
    Write-ServerLog $errMsg 'Red'
    # 追加到错误日志：控制台容易被清掉，排查 500 需要留痕
    try {
      Add-Content -LiteralPath (Join-Path $Root 'serve-errors.log') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $errMsg + ' @ ' + $_.ScriptStackTrace) -Encoding UTF8
    } catch { }
  }
}

# --- 需要注入工作线程的函数 ---
# 处理请求时用到的**全部**辅助函数。少了任何一个，对应的请求路径就会 500。
# 收集方式：把主脚本里定义的函数全部收集起来（多几个无害），
# 少一个的风险是「运行时才报找不到命令」，很难查。
# 注意：ScriptBlock 跨 runspace 传递会丢失绑定上下文，
# 所以这里存的是**函数体文本**（字符串），工作线程里用 Invoke-Expression 重建。
$WorkerFnText = @{}
foreach ($c in (Get-Command -CommandType Function -ErrorAction SilentlyContinue)) {
  if (-not $c.ScriptBlock) { continue }
  # 只收本文件定义的（排除 PowerShell 内置/模块导入的 900 多个）
  if ($c.ScriptBlock.File -ne $PSCommandPath) { continue }
  $WorkerFnText[$c.Name] = $c.ScriptBlock.ToString()
}

# --- 工作线程脚本 ---
# AddScript 的内容是在**工作线程的 runspace**里执行的，
# 所以它自己看不到主脚本的函数 —— 要靠 $Fns 注入。
$WorkerScript = {
  param($Fns, $Shared)

  # 注入主脚本的函数
  foreach ($k in $Fns.Keys) {
    $body = $Fns[$k]
    if ($body) {
      try { Invoke-Expression ("function " + $k + " {`n" + $body + "`n}") }
      catch { [Console]::WriteLine('注入失败 ' + $k + ': ' + $_.Exception.Message) }
    }
  }

  # 只读变量：根目录与 MIME 表 + 共享的可变状态
  Initialize-SharedStateForWorker -Shared $Shared

  while ($true) {
    # 注意：ConcurrentQueue<T> 没有 Get()（会抛异常），只有 TryDequeue()。
    # 而且 TryDequeue 在**队列为空**时返回 $false —— 不是阻塞等待。
    # 所以这里必须自己轮询 + 休眠，不能「空了就 break」：
    # 空了就 break 会让工作线程立刻退出，主线程 enqueue 的请求没人接（全部挂起）。
    # TryTake 带超时：空队列时挂起等待（不空转），
    # 超时返回 $false → 再等一轮，避免漏掉唤醒。
    $item = $null
    $got = $false
    while (-not $got) {
      $got = $Shared['Queue'].TryTake([ref]$item, 500)
    }
    if ($null -eq $item) { break }   # $null 是收工信号
    try { Invoke-RequestHandler $item }
    catch {
      [Console]::WriteLine('请求处理异常 ' + $_.Exception.Message)
      try { Add-Content -LiteralPath (Join-Path $Shared['Root'] 'serve-errors.log') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' WORKER ' + $_.Exception.Message + ' @ ' + $_.ScriptStackTrace) -Encoding UTF8 } catch { }
    }
  }
}

$pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, $WorkerCount)
$pool.Open()
$queue = $SharedState['Queue']

$script:WorkerJobs = @()
for ($i = 0; $i -lt $WorkerCount; $i++) {
  $ps = [PowerShell]::Create()
  $ps.RunspacePool = $pool
  [void]$ps.AddScript($WorkerScript).AddArgument($WorkerFnText).AddArgument($SharedState)
  [void]$ps.BeginInvoke()
  $script:WorkerJobs += $ps
}

Write-Host "  并发工作线程：$WorkerCount 个" -ForegroundColor DarkGray

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try { $queue.Add($ctx) } catch { }
  }
} finally {
  # 让工作线程收工（塞 null 作为结束标记）
  for ($i = 0; $i -lt $script:WorkerJobs.Count; $i++) {
    try { [void]$queue.Add($null) } catch { }
  }
  foreach ($ps in $script:WorkerJobs) {
    try { $ps.Stop() } catch { }
    try { $ps.Dispose() } catch { }
  }
  try { $pool.Close(); $pool.Dispose() } catch { }
  try { $listener.Stop(); $listener.Close() } catch {}
  Write-Host ""
  Write-Host "本地服务器已停止。" -ForegroundColor DarkGray
}

# Build both desktop launchers using the Windows .NET Framework compiler.
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = $root }
$framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
if (-not (Test-Path (Join-Path $framework 'csc.exe'))) {
  $framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319'
}
$csc = Join-Path $framework 'csc.exe'
if (-not (Test-Path $csc)) { throw 'Windows .NET Framework compiler is required' }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
foreach ($name in 'HuofengEarth','MaoMaoEarth') {
  $dest = Join-Path $OutputDirectory ($name + '.exe')
  $src = Join-Path $root ('packaging/' + $name + 'Launcher.cs')
  & $csc /nologo /target:exe /platform:anycpu "/out:$dest" "/r:$framework/System.Management.dll" $src
  if ($LASTEXITCODE -ne 0) { throw "Compiler failed for $name" }
}

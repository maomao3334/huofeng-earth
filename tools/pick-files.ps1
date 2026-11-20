<#
  多选文件对话框（给「数据仓库」用）
  用法：powershell -NoProfile -STA -ExecutionPolicy Bypass -File pick-files.ps1 -Filter "..."
  输出：每行一个绝对路径（UTF-8）
#>
param(
  [string]$Filter = '所有文件 (*.*)|*.*',
  [string]$Description = '选择数据文件（可多选）'
)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = $Filter
$dialog.Title = $Description
$dialog.Multiselect = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($f in $dialog.FileNames) {
    [Console]::Out.WriteLine($f)
  }
}

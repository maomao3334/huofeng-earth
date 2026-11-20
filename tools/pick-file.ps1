param(
  [string]$Filter = 'CSV (*.csv)|*.csv|All files (*.*)|*.*',
  [string]$Description = '选择文件'
)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = $Filter
$dialog.Title = $Description
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}

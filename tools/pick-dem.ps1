param(
  [string]$Filter = 'GeoTIFF (*.tif;*.tiff)|*.tif;*.tiff|All files (*.*)|*.*'
)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = $Filter
$dialog.Title = '选择 DEM 文件（GeoTIFF）'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}

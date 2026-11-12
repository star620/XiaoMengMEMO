param([string]$Out)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$sig = @"
using System;
using System.Runtime.InteropServices;
public class SCR {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
}
"@
Add-Type -TypeDefinition $sig
[void][SCR]::SetProcessDPIAware()
$w = [SCR]::GetSystemMetrics(78)
$h = [SCR]::GetSystemMetrics(79)
if ($w -le 0 -or $h -le 0) { $w = 1920; $h = 1080 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("SAVED " + $Out + " " + (Get-Item $Out).Length + " bytes " + $w + "x" + $h)
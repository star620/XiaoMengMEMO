<#
  启动构建好的小梦备忘录 并截图，用于开发自检。
  用法:  pwsh -File tools/preview.ps1 [-Exe src-tauri\target\debug\xiaomeng-memo.exe] [-WaitMs 4000] [-Out docs\shots\preview.png] [-Kill]
  说明: 不能直接从自动化会话启动 Tauri 窗口(WebView2 os error 5)，所以这里走 Shell.Application.ShellExecute（相当于资源管理器里双击）。
#>
param(
  [string]$Exe = "src-tauri\target\debug\xiaomeng-memo.exe",
  [int]$WaitMs = 4500,
  [string]$Out = "docs\shots\preview.png",
  [switch]$Kill
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $root $Exe
if (-not (Test-Path $exePath)) { throw "找不到 exe: $exePath" }
$outPath = Join-Path $root $Out
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null

$name = [System.IO.Path]::GetFileNameWithoutExtension($exePath)
Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force

$shell = New-Object -ComObject Shell.Application
$shell.ShellExecute($exePath, "", (Split-Path $exePath), "open", 1)
Start-Sleep -Milliseconds $WaitMs

$proc = Get-Process $name -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw "进程没有起来（可能被 SmartScreen 拦了，需要手动点一下 仍要运行）" }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinRect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
  Start-Sleep -Milliseconds 1500
  $proc.Refresh()
  $hwnd = $proc.MainWindowHandle
}
if ($hwnd -ne [IntPtr]::Zero) {
  [WinRect]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 400
  $r = New-Object WinRect+RECT
  [WinRect]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = [Math]::Max(1, $r.Right - $r.Left); $h = [Math]::Max(1, $r.Bottom - $r.Top)
  "窗口位置: $($r.Left),$($r.Top) 尺寸: $w x $h"
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
} else {
  "拿不到窗口句柄，改截全屏"
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
}
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"截图: $outPath"
if ($Kill) { Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force; "已关闭 $name" }

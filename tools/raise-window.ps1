param([int]$Hwnd, [string]$After = "topmost")
$src = @"
using System;
using System.Runtime.InteropServices;
public class RW {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
Add-Type -TypeDefinition $src
$h = [IntPtr]$Hwnd
[void][RW]::ShowWindow($h, 5)
if ($After -eq "normal") { $flag = [IntPtr](-2) } else { $flag = [IntPtr](-1) }
$ok = [RW]::SetWindowPos($h, $flag, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040)
[void][RW]::SetForegroundWindow($h)
Write-Host ("RAISE hwnd=" + $Hwnd + " mode=" + $After + " ok=" + $ok)

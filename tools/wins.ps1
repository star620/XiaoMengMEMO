param([int]$ProcId)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WW {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  public struct RECT { public int L, T, R, B; }
}
'@
$list = New-Object System.Collections.ArrayList
$cb = [WW+EnumProc]{ param($h,$p)
  $wpid=0; [void][WW]::GetWindowThreadProcessId($h,[ref]$wpid)
  if ($wpid -eq $ProcId) { $r = New-Object WW+RECT; [void][WW]::GetWindowRect($h,[ref]$r); [void]$list.Add([pscustomobject]@{H=$h;Vis=[WW]::IsWindowVisible($h);Min=[WW]::IsIconic($h);Ex=([WW]::GetWindowLongW($h,-20));X=$r.L;Y=$r.T;W=($r.R-$r.L);Ht=($r.B-$r.T)}) }
  return $true }
[void][WW]::EnumWindows($cb,[IntPtr]::Zero)
$i=0
foreach ($w in $list) { Write-Output ("{0}: vis={1} min={2} ex=0x{3:X} rect={4},{5} {6}x{7} hwnd={8}" -f $i,$w.Vis,$w.Min,$w.Ex,$w.X,$w.Y,$w.W,$w.Ht,$w.H); $i++ }

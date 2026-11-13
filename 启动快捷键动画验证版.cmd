@echo off
chcp 65001 >nul
setlocal
set "XM_VERIFY_EXE=%~dp0小梦备忘录-快捷键动画验证版.exe"
if not exist "%XM_VERIFY_EXE%" (
  echo 找不到验证版程序，请把此脚本与验证版 exe 放在同一个文件夹。
  pause
  exit /b 1
)
powershell -NoLogo -NoProfile -WindowStyle Hidden -Command "$ErrorActionPreference='Stop'; $exe=$env:XM_VERIFY_EXE; $psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName=$exe; $psi.WorkingDirectory=(Split-Path -LiteralPath $exe); $psi.UseShellExecute=$false; $process=[System.Diagnostics.Process]::Start($psi); Add-Content -LiteralPath (Join-Path $psi.WorkingDirectory 'verification-launch.log') -Encoding UTF8 -Value ((Get-Date -Format o)+' started pid='+$process.Id)"
if errorlevel 1 (
  echo 启动没有完成，请保留同目录的 verification-launch.log 与 xiaomeng-boot.log。
  pause
  exit /b 1
)
exit /b 0

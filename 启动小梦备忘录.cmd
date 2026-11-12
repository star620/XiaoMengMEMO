@echo off
setlocal
set "DIR=%~dp0"
set "XM_EXE=%DIR%src-tauri\target\release\xiaomeng-memo.exe"
echo [%DATE% %TIME%] launcher start >> "%DIR%launch-record.txt"
if not exist "%XM_EXE%" ( echo [XiaoMeng Memo] exe not found & pause & exit /b 1 )
powershell -NoProfile -WindowStyle Hidden -Command "$e=$env:XM_EXE; $psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName=$e; $psi.WorkingDirectory=(Split-Path $e); $psi.UseShellExecute=$false; $p=[System.Diagnostics.Process]::Start($psi); Add-Content -Path (Join-Path (Split-Path $e) 'launch-record.txt') -Value ('started pid ' + $p.Id)"
exit /b 0
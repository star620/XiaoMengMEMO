@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0src-tauri\target\release"
set "EXE=%DIR%xiaomeng-memo.exe"
if not exist "%EXE%" (
  echo [x] 找不到程序：%EXE%
  pause
  exit /b 1
)
del "%DIR%\xiaomeng-boot.log" >nul 2>nul
powershell -NoProfile -WindowStyle Hidden -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=([char]34+'%EXE%'+[char]34)} | Out-Null"
echo 正在启动小梦备忘录，请等待 8 秒……
timeout /t 8 /nobreak >nul
echo.
echo ================ 启动日志 ================
if exist "%DIR%\xiaomeng-boot.log" (
  type "%DIR%\xiaomeng-boot.log"
) else (
  echo 没有产生日志：程序很可能被 Windows SmartScreen 或安全软件拦住了，根本没跑起来。
)
echo ==========================================
echo.
echo （把这个窗口截图给小梦看就行，这个诊断窗口用完可以直接关掉）
pause

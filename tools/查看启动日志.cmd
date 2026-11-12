@echo off
chcp 65001 >nul
set "DIR=%~dp0"
setlocal enabledelayedexpansion
set "LOG=%DIR%src-tauri\target\release\xiaomeng-boot.log"
if not exist "%LOG%" set "LOG=%USERPROFILE%\Desktop\xiaomeng-boot.log"
echo.
echo ===== XiaoMeng Memo startup log =====
if exist "%LOG%" (
  echo file: %LOG%
  echo --------------------------------------
  type "%LOG%"
) else (
  echo No startup log found. That usually means the app never got to run
  echo ^(blocked by SmartScreen / antivirus^), or it started fine and you
  echo already closed it.
)
echo --------------------------------------
echo If the app still does not show up, screenshot this window and send it.
pause
@echo off
title Hudhud Helper - Install
if not exist "%~dp0install.ps1" (
  echo Hudhud: extract the zip first. Right-click it, choose "Extract All",
  echo then open the new folder and run install.bat from there.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause

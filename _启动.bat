@echo off
REM ============================================================
REM  YongShang SiJi - One-click launcher (Windows)
REM  Double-click me. Browser opens automatically when server is up.
REM  Close the python console window to stop the server.
REM ============================================================
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] python not found. Install Python 3.8+ and check "Add Python to PATH".
  echo         Download: https://www.python.org/downloads/
  pause
  exit /b 1
)

echo.
echo [YongShang SiJi] starting local server on http://localhost:8000/
echo                 A python console window will open - close it to stop server.
echo.

REM -- Kill any old server still holding port 8000 --------------------------
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Host '[cleanup] killed old server' }" 2>nul

REM -- Start python server in its own console window -----------------------
start "YongShang-SiJi-Server" python _server.py

REM -- Wait for server to respond, then open browser -----------------------
setlocal enabledelayedexpansion
set TRY=0
set MAX=25
:wait
set /a TRY+=1
if !TRY! gtr %MAX% (
  echo [TIMEOUT] server did not start after !MAX! seconds.
  pause
  exit /b 1
)
echo   waiting... attempt !TRY!/%MAX%
powershell -NoProfile -Command "try { Invoke-WebRequest http://localhost:8000/ -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 goto wait
endlocal

echo [OK] server is up - opening browser.
start "" http://localhost:8000/

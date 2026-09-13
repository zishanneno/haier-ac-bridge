@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or 24 from https://nodejs.org, then reopen this launcher.
  pause
  exit /b 1
)
node scripts\launch.mjs
set "bridge_exit=%errorlevel%"
if not "%bridge_exit%"=="0" if not "%bridge_exit%"=="130" (
  echo Could not start the bridge. See the message above and README.md.
  pause
)
exit /b %bridge_exit%

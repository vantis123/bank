@echo off
REM Windows one-click launcher for Bank. Double-click this file in File Explorer
REM to set up + start Bank. Runs in cmd.exe so PowerShell's execution policy
REM never gets in the way.

cd /d "%~dp0"

echo.
echo   ======================================
echo      Bank by Arvantis -- Launcher
echo   ======================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js not found.
  echo.
  echo   Install it first:
  echo     https://nodejs.org/en/download
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   First-time setup -- installing dependencies (this takes ^~3 min)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check the error above and try again.
    pause
    exit /b 1
  )
  echo.
  echo   Setup complete.
  echo.
)

echo   Starting Bank -- your browser will open to http://localhost:7878
echo   (Leave this window open while you use Bank.)
echo.

call npm start
pause

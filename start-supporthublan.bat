@echo off
REM ==========================================================================
REM SupportHubLAN Launcher
REM ==========================================================================
REM Starts the backend server and opens the browser.
REM Place this .bat in the SupportHubLAN folder, or run from anywhere —
REM it will locate the server relative to its own location.
REM ==========================================================================

setlocal
title SupportHubLAN

REM Locate the server folder relative to this script
set SCRIPT_DIR=%~dp0
if exist "%SCRIPT_DIR%supporthublan-server\server.js" (
    cd /d "%SCRIPT_DIR%supporthublan-server"
) else if exist "%SCRIPT_DIR%server.js" (
    cd /d "%SCRIPT_DIR%"
) else (
    echo [ERROR] Could not find SupportHubLAN server.
    echo Expected either:
    echo   %SCRIPT_DIR%supporthublan-server\server.js
    echo   or %SCRIPT_DIR%server.js
    pause
    exit /b 1
)

REM Check Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo Install from https://nodejs.org/
    pause
    exit /b 1
)

REM Check that node_modules exists
if not exist node_modules (
    echo [INFO] Dependencies not installed. Running npm install...
    call npm install
    if %errorLevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

REM Check that .env exists; if not, create from template
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [INFO] Created .env from template. Edit if needed.
    )
)

echo.
echo ============================================
echo   Starting SupportHubLAN...
echo   Press Ctrl+C to stop the server.
echo ============================================
echo.

REM Start the server (it will auto-open the browser on Windows)
node server.js

REM If the server exits, pause so the user can see the error
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Server exited with code %errorLevel%
    pause
)

endlocal

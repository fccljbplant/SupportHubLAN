@echo off
REM ==========================================================================
REM SupportHubLAN Windows Installer
REM ==========================================================================
REM This script:
REM   1. Checks for Node.js 18+ (installs via winget if missing)
REM   2. Checks for git (installs via winget if missing)
REM   3. Clones SupportHubLAN to C:\SupportHubLAN
REM   4. Runs npm install in the backend
REM   5. Creates a desktop shortcut that runs `npm start`
REM   6. Opens the browser
REM
REM Right-click → "Run as administrator" for best results.
REM ==========================================================================

setlocal EnableDelayedExpansion
title SupportHubLAN Installer

echo.
echo ============================================
echo   SupportHubLAN Installer
echo ============================================
echo.

REM --- Check admin ---
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [WARNING] Not running as administrator.
    echo [WARNING] Some features may not install correctly.
    echo [WARNING] Right-click this .bat file and choose "Run as administrator".
    echo.
    choice /C YN /M "Continue anyway"
    if errorlevel 2 exit /b 1
)

REM --- Check Node.js ---
echo [1/6] Checking Node.js...
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo   Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorLevel% neq 0 (
        echo [ERROR] Failed to install Node.js.
        echo Please install manually from https://nodejs.org/
        pause
        exit /b 1
    )
    REM Refresh PATH
    call :refreshenv
) else (
    for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
    echo   Node.js found: !NODE_VER!
)

REM --- Check git ---
echo [2/6] Checking git...
where git >nul 2>&1
if %errorLevel% neq 0 (
    echo   git not found. Installing via winget...
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    call :refreshenv
) else (
    echo   git found.
)

REM --- Clone repo ---
echo [3/6] Cloning SupportHubLAN to C:\SupportHubLAN...
if exist C:\SupportHubLAN (
    echo   C:\SupportHubLAN already exists. Updating...
    cd /d C:\SupportHubLAN
    git pull
) else (
    git clone https://github.com/fccljbplant/SupportHubLAN.git C:\SupportHubLAN
    if %errorLevel% neq 0 (
        echo [ERROR] Failed to clone.
        pause
        exit /b 1
    )
)

cd /d C:\SupportHubLAN\supporthublan-server

REM --- npm install ---
echo [4/6] Installing backend dependencies...
call npm install
if %errorLevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

REM --- Create .env if missing ---
if not exist .env (
    echo [5/6] Creating .env from template...
    copy .env.example .env >nul
)

REM --- Create desktop shortcut ---
echo [6/6] Creating desktop shortcut...
set SHORTCUT_PATH=%USERPROFILE%\Desktop\SupportHubLAN.lnk
set TARGET=%CD%
set START_CMD=npm start

powershell -NoProfile -Command "$s = (New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'cmd.exe'; $s.Arguments = '/k cd /d %TARGET% && %START_CMD%'; $s.WorkingDirectory = '%TARGET%'; $s.IconLocation = 'shell32.dll,13'; $s.Description = 'SupportHubLAN Backend Server'; $s.Save()"

echo.
echo ============================================
echo   Installation complete!
echo ============================================
echo.
echo To start SupportHubLAN:
echo   Option A: Double-click the "SupportHubLAN" shortcut on your desktop
echo   Option B: Open Command Prompt, run:
echo             cd C:\SupportHubLAN\supporthublan-server
echo             npm start
echo.
echo Then open http://localhost:8080 in your browser.
echo.
echo Next steps:
echo   1. Download PsTools from https://learn.microsoft.com/sysinternals/downloads/pstools
echo   2. Extract to C:\PSTools\
echo   3. (Optional) Install PSWindowsUpdate module:
echo      powershell -Command "Install-Module PSWindowsUpdate -Force -AllowClobber"
echo   4. (Optional) Install RSAT ActiveDirectory:
echo      powershell -Command "Add-WindowsCapability -Online -Name 'Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0'"
echo.
pause
exit /b 0

:refreshenv
REM Refresh environment variables from registry (so node/git are on PATH)
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USR_PATH=%%b"
set "PATH=%SYS_PATH%;%USR_PATH%"
goto :eof

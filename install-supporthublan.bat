@echo off
REM ==========================================================================
REM SupportHubLAN All-In-One Installer
REM ==========================================================================
REM This installer requires NOTHING pre-installed on the target Windows PC.
REM It downloads everything automatically using only built-in Windows tools
REM (PowerShell + curl, both included in Windows 10/11):
REM
REM   1. Portable Node.js (no admin required, no system install)
REM   2. The SupportHubLAN code from GitHub
REM   3. PsTools suite from Microsoft Sysinternals
REM   4. npm dependencies (express, cors, body-parser, ws, better-sqlite3)
REM
REM Then it creates:
REM   - A desktop shortcut "SupportHubLAN" that starts the server
REM   - A Start Menu entry
REM   - An uninstaller (uninstall-supporthublan.bat)
REM
REM USAGE:
REM   1. Save this file as "install-supporthublan.bat"
REM   2. Double-click it (no admin needed)
REM   3. Wait ~5 minutes for downloads + npm install
REM   4. Browser opens automatically to http://localhost:8080
REM
REM To run from Command Prompt:
REM   install-supporthublan.bat
REM ==========================================================================

setlocal EnableDelayedExpansion
title SupportHubLAN Installer

echo.
echo ============================================
echo   SupportHubLAN All-In-One Installer
echo ============================================
echo.
echo This will install SupportHubLAN to:
echo   %USERPROFILE%\SupportHubLAN
echo.
echo It will download:
echo   - Portable Node.js v20 LTS (~30 MB)
echo   - SupportHubLAN code from GitHub (~2 MB)
echo   - PsTools from Microsoft (~5 MB)
echo   - npm dependencies (~50 MB)
echo.
echo Total download: ~87 MB
echo Estimated time: 3-5 minutes
echo.
echo No administrator privileges required.
echo.
pause

set "INSTALL_DIR=%USERPROFILE%\SupportHubLAN"
set "NODE_DIR=%INSTALL_DIR%\node"
set "SERVER_DIR=%INSTALL_DIR\supporthublan-server"
set "PSTOOLS_DIR=%INSTALL_DIR%\PSTools"

echo.
echo [1/7] Creating install directory...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 (
    echo [ERROR] Failed to create %INSTALL_DIR%
    pause
    exit /b 1
)

REM ---- Step 2: Download portable Node.js ----
echo.
echo [2/7] Downloading portable Node.js v20 LTS...
if exist "%NODE_DIR%\node.exe" (
    echo   Node.js already exists, skipping download.
) else (
    if not exist "%NODE_DIR%" mkdir "%NODE_DIR%"
    set "NODE_URL=https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip"
    set "NODE_ZIP=%TEMP%\node-portable.zip"
    echo   Downloading from !NODE_URL!...
    powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '!NODE_URL!' -OutFile '!NODE_ZIP!' -UseBasicParsing } catch { Write-Host 'ERROR: ' $_.Exception.Message; exit 1 }"
    if errorlevel 1 (
        echo [ERROR] Failed to download Node.js
        echo         Check your internet connection and try again.
        pause
        exit /b 1
    )
    echo   Extracting...
    powershell -NoProfile -Command "Expand-Archive -Path '!NODE_ZIP!' -DestinationPath '%TEMP%\node-extract' -Force"
    if errorlevel 1 (
        echo [ERROR] Failed to extract Node.js
        pause
        exit /b 1
    )
    REM Move the contents of node-v20.18.0-win-x64\ to NODE_DIR
    move /Y "%TEMP%\node-extract\node-v20.18.0-win-x64\*" "%NODE_DIR%\" >nul 2>&1
    rd /s /q "%TEMP%\node-extract" 2>nul
    del "!NODE_ZIP!" 2>nul
    if not exist "%NODE_DIR%\node.exe" (
        echo [ERROR] node.exe not found after extraction
        pause
        exit /b 1
    )
    echo   Node.js installed: %NODE_DIR%\node.exe
)

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

echo.
echo [3/7] Downloading SupportHubLAN code from GitHub...
if exist "%SERVER_DIR%\server.js" (
    echo   Code already exists, updating...
    cd /d "%INSTALL_DIR%"
    git pull 2>nul || (
        echo   git not available, re-downloading ZIP...
        powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/fccljbplant/SupportHubLAN/archive/refs/heads/main.zip' -OutFile '%TEMP%\shl.zip' -UseBasicParsing; Expand-Archive -Path '%TEMP%\shl.zip' -DestinationPath '%TEMP%\shl-extract' -Force; Copy-Item -Path '%TEMP%\shl-extract\SupportHubLAN-main\*' -Destination '%INSTALL_DIR%' -Recurse -Force"
        del "%TEMP%\shl.zip" 2>nul
        rd /s /q "%TEMP%\shl-extract" 2>nul
    )
) else (
    cd /d "%INSTALL_DIR%"
    echo   Downloading ZIP from GitHub...
    powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/fccljbplant/SupportHubLAN/archive/refs/heads/main.zip' -OutFile '%TEMP%\shl.zip' -UseBasicParsing } catch { Write-Host 'ERROR: ' $_.Exception.Message; exit 1 }"
    if errorlevel 1 (
        echo [ERROR] Failed to download SupportHubLAN code
        pause
        exit /b 1
    )
    echo   Extracting...
    powershell -NoProfile -Command "Expand-Archive -Path '%TEMP%\shl.zip' -DestinationPath '%TEMP%\shl-extract' -Force"
    xcopy /E /I /Y "%TEMP%\shl-extract\SupportHubLAN-main\*" "%INSTALL_DIR%\" >nul
    rd /s /q "%TEMP%\shl-extract" 2>nul
    del "%TEMP%\shl.zip" 2>nul
)

if not exist "%SERVER_DIR%\server.js" (
    echo [ERROR] server.js not found after download
    echo         Expected: %SERVER_DIR%\server.js
    pause
    exit /b 1
)
echo   Code installed: %SERVER_DIR%\server.js

REM ---- Step 4: Download PsTools ----
echo.
echo [4/7] Downloading PsTools from Microsoft Sysinternals...
if exist "%PSTOOLS_DIR%\psexec.exe" (
    echo   PsTools already exists, skipping.
) else (
    if not exist "%PSTOOLS_DIR%" mkdir "%PSTOOLS_DIR%"
    set "PSTOOLS_URL=https://download.sysinternals.com/files/PSTools.zip"
    set "PSTOOLS_ZIP=%TEMP%\PSTools.zip"
    echo   Downloading from !PSTOOLS_URL!...
    powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '!PSTOOLS_URL!' -OutFile '!PSTOOLS_ZIP!' -UseBasicParsing } catch { Write-Host 'WARNING: ' $_.Exception.Message }"
    if exist "!PSTOOLS_ZIP!" (
        echo   Extracting...
        powershell -NoProfile -Command "Expand-Archive -Path '!PSTOOLS_ZIP!' -DestinationPath '%PSTOOLS_DIR%' -Force"
        del "!PSTOOLS_ZIP!" 2>nul
        if exist "%PSTOOLS_DIR%\psexec.exe" (
            echo   PsTools installed: %PSTOOLS_DIR%\psexec.exe
        ) else (
            echo   WARNING: psexec.exe not found after extraction
            echo   You can download PsTools manually later from:
            echo   https://learn.microsoft.com/sysinternals/downloads/pstools
        )
    ) else (
        echo   WARNING: Could not download PsTools
        echo   You can download it manually later from:
        echo   https://learn.microsoft.com/sysinternals/downloads/pstools
        echo   Extract to: %PSTOOLS_DIR%
    )
)

REM ---- Step 5: Create .env ----
echo.
echo [5/7] Creating configuration file...
if not exist "%SERVER_DIR%\.env" (
    if exist "%SERVER_DIR%\.env.example" (
        copy "%SERVER_DIR%\.env.example" "%SERVER_DIR%\.env" >nul
    ) else (
        REM Create a minimal .env
        (
            echo PORT=8080
            echo PSTOOLS_PATH=%PSTOOLS_DIR%\
            echo BIND_ADDRESS=127.0.0.1
            echo AUTO_OPEN_BROWSER=true
            echo DB_PASSPHRASE=supporthublan-%RANDOM%%RANDOM%
        ) > "%SERVER_DIR%\.env"
    )
    echo   .env created at %SERVER_DIR%\.env
) else (
    echo   .env already exists, keeping current settings.
)

REM ---- Step 6: npm install ----
echo.
echo [6/7] Installing npm dependencies...
cd /d "%SERVER_DIR%"
if not exist "%NODE_DIR%\npm.cmd" (
    echo [ERROR] npm not found at %NODE_DIR%\npm.cmd
    echo         Node.js installation may have failed.
    pause
    exit /b 1
)

echo   Running npm install (this may take 2-3 minutes)...
call "%NODE_DIR%\npm.cmd" install --no-optional 2>&1 | findstr /V "npm warn"
if errorlevel 1 (
    echo.
    echo   WARNING: npm install reported errors.
    echo   The app will still run using the JSON file fallback for data storage.
    echo   To enable SQLite + encrypted credentials, fix the errors above and re-run:
    echo     cd "%SERVER_DIR%"
    echo     "%NODE_DIR%\npm.cmd" install better-sqlite3
    echo.
    echo   Continuing with installation...
) else (
    echo   Dependencies installed successfully.
)

REM ---- Step 7: Create launcher + shortcuts ----
echo.
echo [7/7] Creating launcher and desktop shortcut...

REM Create the launcher .bat
set "LAUNCHER=%INSTALL_DIR%\start-supporthublan.bat"
(
    echo @echo off
    echo title SupportHubLAN Server
    echo echo.
    echo echo ============================================
    echo echo   SupportHubLAN Server
    echo echo ============================================
    echo echo.
    echo echo Starting server... Browser will open automatically.
    echo echo Press Ctrl+C to stop.
    echo echo.
    echo set "PATH=%NODE_DIR%;%%PATH%%"
    echo set "PSTOOLS_PATH=%PSTOOLS_DIR%\"
    echo cd /d "%SERVER_DIR%"
    echo node server.js
    echo pause
) > "%LAUNCHER%"

REM Create desktop shortcut using PowerShell
set "SHORTCUT_PATH=%USERPROFILE%\Desktop\SupportHubLAN.lnk"
powershell -NoProfile -Command "$s = (New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = '%LAUNCHER%'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.IconLocation = '%NODE_DIR%\node.exe,0'; $s.Description = 'Start SupportHubLAN Server'; $s.Save()"
if exist "%SHORTCUT_PATH%" (
    echo   Desktop shortcut created: %SHORTCUT_PATH%
) else (
    echo   WARNING: Could not create desktop shortcut.
    echo   You can start SupportHubLAN by running: %LAUNCHER%
)

REM Create Start Menu shortcut
set "STARTMENU_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\SupportHubLAN"
if not exist "%STARTMENU_DIR%" mkdir "%STARTMENU_DIR%"
powershell -NoProfile -Command "$s = (New-Object -COM WScript.Shell).CreateShortcut('%STARTMENU_DIR%\SupportHubLAN.lnk'); $s.TargetPath = '%LAUNCHER%'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.IconLocation = '%NODE_DIR%\node.exe,0'; $s.Description = 'Start SupportHubLAN Server'; $s.Save()"

REM Create uninstaller
set "UNINSTALLER=%INSTALL_DIR%\uninstall-supporthublan.bat"
(
    echo @echo off
    echo title Uninstall SupportHubLAN
    echo echo.
    echo echo This will remove SupportHubLAN from your computer.
    echo echo Data files (inventory, credentials, audit log) will be kept in:
    echo echo   %SERVER_DIR%\data\
    echo echo.
    echo set /p CONFIRM=Type YES to confirm: 
    echo if /i not "%%CONFIRM%%"=="YES" exit /b 0
    echo echo.
    echo echo Removing shortcuts...
    echo del "%SHORTCUT_PATH%" 2>nul
    echo rd /s /q "%STARTMENU_DIR%" 2>nul
    echo echo Removing application files...
    echo rd /s /q "%NODE_DIR%" 2>nul
    echo rd /s /q "%PSTOOLS_DIR%" 2>nul
    echo rd /s /q "%INSTALL_DIR%\vendor" 2>nul
    echo del "%INSTALL_DIR%\supporthublan.html" 2>nul
    echo del "%INSTALL_DIR%\start-supporthublan.bat" 2>nul
    echo del "%INSTALL_DIR%\install-supporthublan.bat" 2>nul
    echo echo.
    echo echo Uninstall complete. Data files preserved at:
    echo echo   %SERVER_DIR%\data\
    echo echo.
    echo echo To fully remove everything including data, delete:
    echo echo   %INSTALL_DIR%
    echo pause
) > "%UNINSTALLER%"

echo.
echo ============================================
echo   Installation Complete!
echo ============================================
echo.
echo SupportHubLAN is installed at:
echo   %INSTALL_DIR%
echo.
echo To start SupportHubLAN:
echo   Option A: Double-click the "SupportHubLAN" shortcut on your desktop
echo   Option B: Run %LAUNCHER%
echo.
echo The server will start on http://localhost:8080
echo and your browser will open automatically.
echo.
echo To uninstall: Run %UNINSTALLER%
echo.
echo First run checklist:
echo   1. Download PsTools if it failed (check %PSTOOLS_DIR%)
echo      https://learn.microsoft.com/sysinternals/downloads/pstools
echo   2. Ensure you have admin rights on target Windows PCs
echo   3. Open Settings → Active Directory to configure AD import
echo   4. Open Settings → PsTools to verify PsTools path
echo.
echo Starting SupportHubLAN now...
echo.

REM Start the server immediately
cd /d "%SERVER_DIR%"
"%NODE_DIR%\node.exe" server.js

pause

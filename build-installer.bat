@echo off
REM ==========================================================================
REM SupportHubLAN Standalone Installer Builder
REM ==========================================================================
REM This script runs on Windows and produces:
REM   SupportHubLAN-Setup.exe
REM
REM The .exe is a self-extracting installer that bundles:
REM   - Portable Node.js v20 LTS
REM   - SupportHubLAN application code
REM   - PsTools suite (if available)
REM   - All npm dependencies (pre-installed)
REM
REM When the user runs SupportHubLAN-Setup.exe:
REM   1. It extracts to a temp folder
REM   2. Runs setup.vbs (silent, no console window)
REM   3. setup.vbs copies everything to %USERPROFILE%\SupportHubLAN
REM   4. Creates desktop + Start Menu shortcuts
REM   5. Starts the server and opens the browser
REM
REM PREREQUISITES for building (NOT for the end user):
REM   - Run this on a Windows machine with internet access
REM   - The script downloads everything else automatically
REM
REM USAGE:
REM   1. Clone the repo or download this file
REM   2. Double-click build-installer.bat
REM   3. Wait ~10 minutes for downloads + npm install
REM   4. Get SupportHubLAN-Setup.exe in the current folder
REM   5. Distribute the .exe to your users
REM ==========================================================================

setlocal EnableDelayedExpansion
title SupportHubLAN Installer Builder

echo.
echo ============================================
echo   SupportHubLAN Installer Builder
echo ============================================
echo.
echo This will build: SupportHubLAN-Setup.exe
echo.
echo The .exe is a standalone installer that requires NOTHING
%% pre-installed on the target machine. It bundles:
echo   - Portable Node.js v20 LTS (~30 MB)
echo   - SupportHubLAN code (~2 MB)
echo   - PsTools (~5 MB)
echo   - npm dependencies (~50 MB)
echo.
echo Build time: ~10 minutes
echo Output: SupportHubLAN-Setup.exe (~90 MB)
echo.
pause

set "BUILD_DIR=%TEMP%\shl-build"
set "NODE_DIR=%BUILD_DIR%\node"
set "APP_DIR=%BUILD_DIR%\app"
set "PSTOOLS_DIR=%BUILD_DIR%\PSTools"

echo.
echo [1/8] Cleaning build directory...
rd /s /q "%BUILD_DIR%" 2>nul
mkdir "%BUILD_DIR%"
mkdir "%APP_DIR%"

REM ---- Step 2: Download portable Node.js ----
echo.
echo [2/8] Downloading portable Node.js v20 LTS...
mkdir "%NODE_DIR%"
set "NODE_URL=https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip"
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '!NODE_URL!' -OutFile '%TEMP%\node.zip' -UseBasicParsing"
powershell -NoProfile -Command "Expand-Archive -Path '%TEMP%\node.zip' -DestinationPath '%TEMP%\node-extract' -Force"
move /Y "%TEMP%\node-extract\node-v20.18.0-win-x64\*" "%NODE_DIR%\" >nul 2>&1
rd /s /q "%TEMP%\node-extract" 2>nul
del "%TEMP%\node.zip" 2>nul
if not exist "%NODE_DIR%\node.exe" (
    echo [ERROR] Failed to download Node.js
    pause
    exit /b 1
)
echo   OK: %NODE_DIR%\node.exe

REM ---- Step 3: Download SupportHubLAN code ----
echo.
echo [3/8] Downloading SupportHubLAN code...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/fccljbplant/SupportHubLAN/archive/refs/heads/main.zip' -OutFile '%TEMP%\shl.zip' -UseBasicParsing"
powershell -NoProfile -Command "Expand-Archive -Path '%TEMP%\shl.zip' -DestinationPath '%TEMP%\shl-extract' -Force"
xcopy /E /I /Y "%TEMP%\shl-extract\SupportHubLAN-main\*" "%APP_DIR%\" >nul
rd /s /q "%TEMP%\shl-extract" 2>nul
del "%TEMP%\shl.zip" 2>nul
if not exist "%APP_DIR%\supporthublan-server\server.js" (
    echo [ERROR] Failed to download SupportHubLAN code
    pause
    exit /b 1
)
echo   OK: %APP_DIR%\supporthublan-server\server.js

REM ---- Step 4: Download PsTools ----
echo.
echo [4/8] Downloading PsTools...
mkdir "%PSTOOLS_DIR%"
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/PSTools.zip' -OutFile '%TEMP%\pstools.zip' -UseBasicParsing; Expand-Archive -Path '%TEMP%\pstools.zip' -DestinationPath '%PSTOOLS_DIR%' -Force } catch { Write-Host 'WARNING: PsTools download failed' }"
del "%TEMP%\pstools.zip" 2>nul
if exist "%PSTOOLS_DIR%\psexec.exe" (
    echo   OK: %PSTOOLS_DIR%\psexec.exe
) else (
    echo   WARNING: PsTools not downloaded — installer will still work
    echo   Users can download PsTools separately later.
)

REM ---- Step 5: npm install ----
echo.
echo [5/8] Installing npm dependencies (this takes 2-3 minutes)...
cd /d "%APP_DIR%\supporthublan-server"
set "PATH=%NODE_DIR%;%PATH%"
call npm install --production 2>&1 | findstr /V "npm warn"
if errorlevel 1 (
    echo   WARNING: npm install had errors, continuing anyway...
) else (
    echo   OK: dependencies installed
)

REM ---- Step 6: Create setup.vbs (runs inside the .exe) ----
echo.
echo [6/8] Creating setup script...
(
    echo ' SupportHubLAN Setup Script — runs silently after extraction
    echo Option Explicit
    echo Dim fso, shell, WshShell, installDir, nodeDir, serverDir, pstoolsDir
    echo Dim desktopShortcut, startMenuDir, sourceDir
    echo.
    echo Set fso = CreateObject("Scripting.FileSystemObject")
    echo Set shell = CreateObject("WScript.Shell")
    echo Set WshShell = shell
    echo.
    echo ' Source = temp extraction folder (where setup.vbs lives)
    echo sourceDir = fso.GetParentFolderName(WScript.ScriptFullName)
    echo.
    echo ' Destination = user's home folder
    echo installDir = shell.ExpandEnvironmentStrings("%USERPROFILE%") ^& "\SupportHubLAN"
    echo nodeDir = installDir ^& "\node"
    echo serverDir = installDir ^& "\supporthublan-server"
    echo pstoolsDir = installDir ^& "\PSTools"
    echo.
    echo ' Create install directory
    echo If Not fso.FolderExists(installDir) Then fso.CreateFolder(installDir)
    echo.
    echo ' Copy Node.js
    echo WScript.StdOut.Write "Copying Node.js..."
    echo If fso.FolderExists(sourceDir ^& "\node") Then
    echo     If fso.FolderExists(nodeDir) Then fso.DeleteFolder(nodeDir), True
    echo     fso.CopyFolder sourceDir ^& "\node", nodeDir, True
    echo End If
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo ' Copy app code
    echo WScript.StdOut.Write "Copying application..."
    echo If fso.FolderExists(sourceDir ^& "\app") Then
    echo     fso.CopyFolder sourceDir ^& "\app", installDir ^& "\app_tmp", True
    echo     ' Move contents of app_tmp to installDir
    echo     Dim folder, file
    echo     For Each folder In fso.GetFolder(installDir ^& "\app_tmp").SubFolders
    echo         If fso.FolderExists(installDir ^& "\" ^& folder.Name) Then fso.DeleteFolder installDir ^& "\" ^& folder.Name, True
    echo         fso.MoveFolder folder.Path, installDir ^& "\" ^& folder.Name
    echo     Next
    echo     For Each file In fso.GetFolder(installDir ^& "\app_tmp").Files
    echo         fso.MoveFile file.Path, installDir ^& "\" ^& file.Name
    echo     Next
    echo     fso.DeleteFolder installDir ^& "\app_tmp", True
    echo End If
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo ' Copy PsTools
    echo WScript.StdOut.Write "Copying PsTools..."
    echo If fso.FolderExists(sourceDir ^& "\PSTools") Then
    echo     If fso.FolderExists(pstoolsDir) Then fso.DeleteFolder(pstoolsDir), True
    echo     fso.CopyFolder sourceDir ^& "\PSTools", pstoolsDir, True
    echo End If
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo ' Create .env
    echo WScript.StdOut.Write "Creating config..."
    echo Dim envFile, envContent
    echo envFile = serverDir ^& "\.env"
    echo If Not fso.FileExists(envFile) Then
    echo     envContent = "PORT=8080" ^& vbCrLf ^& "PSTOOLS_PATH=" ^& pstoolsDir ^& "\" ^& vbCrLf ^& "BIND_ADDRESS=127.0.0.1" ^& vbCrLf ^& "AUTO_OPEN_BROWSER=true" ^& vbCrLf ^& "DB_PASSPHRASE=shl-" ^& Int(Rnd * 99999999) ^& "-" ^& Int(Rnd * 99999999)
    echo     fso.CreateTextFile(envFile, True).Write envContent
    echo End If
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo ' Create launcher batch file
    echo WScript.StdOut.Write "Creating launcher..."
    echo Dim launcherPath, launcherContent
    echo launcherPath = installDir ^& "\start-supporthublan.bat"
    echo launcherContent = "@echo off" ^& vbCrLf ^& "title SupportHubLAN" ^& vbCrLf ^& "set ""PATH=" ^& nodeDir ^& ";%PATH%""" ^& vbCrLf ^& "set ""PSTOOLS_PATH=" ^& pstoolsDir ^& "\""" ^& vbCrLf ^& "cd /d """ ^& serverDir ^& """" ^& vbCrLf ^& "node server.js" ^& vbCrLf ^& "pause"
    echo fso.CreateTextFile(launcherPath, True).Write launcherContent
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo ' Create desktop shortcut
    echo WScript.StdOut.Write "Creating shortcuts..."
    echo desktopShortcut = shell.ExpandEnvironmentStrings("%USERPROFILE%") ^& "\Desktop\SupportHubLAN.lnk"
    echo Dim sc
    echo Set sc = shell.CreateShortcut(desktopShortcut)
    echo sc.TargetPath = launcherPath
    echo sc.WorkingDirectory = installDir
    echo sc.IconLocation = nodeDir ^& "\node.exe,0"
    echo sc.Description = "Start SupportHubLAN Server"
    echo sc.Save
    echo.
    echo ' Create Start Menu shortcut
    echo startMenuDir = shell.ExpandEnvironmentStrings("%APPDATA%") ^& "\Microsoft\Windows\Start Menu\Programs\SupportHubLAN"
    echo If Not fso.FolderExists(startMenuDir) Then fso.CreateFolder(startMenuDir)
    echo Set sc = shell.CreateShortcut(startMenuDir ^& "\SupportHubLAN.lnk")
    echo sc.TargetPath = launcherPath
    echo sc.WorkingDirectory = installDir
    echo sc.IconLocation = nodeDir ^& "\node.exe,0"
    echo sc.Description = "Start SupportHubLAN Server"
    echo sc.Save
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo ' Create uninstaller
    echo WScript.StdOut.Write "Creating uninstaller..."
    echo Dim uninstallerPath, uninstallerContent
    echo uninstallerPath = installDir ^& "\uninstall.bat"
    echo uninstallerContent = "@echo off" ^& vbCrLf ^& "echo Removing SupportHubLAN..." ^& vbCrLf ^& "del """ ^& desktopShortcut ^& """ 2>nul" ^& vbCrLf ^& "rd /s /q """ ^& startMenuDir ^& """ 2>nul" ^& vbCrLf ^& "rd /s /q """ ^& installDir ^& """ 2>nul" ^& vbCrLf ^& "echo Done." ^& vbCrLf ^& "pause"
    echo fso.CreateTextFile(uninstallerPath, True).Write uninstallerContent
    echo.
    echo Set sc = shell.CreateShortcut(startMenuDir ^& "\Uninstall SupportHubLAN.lnk")
    echo sc.TargetPath = uninstallerPath
    echo sc.WorkingDirectory = installDir
    echo sc.Description = "Uninstall SupportHubLAN"
    echo sc.Save
    echo WScript.StdOut.WriteLine "OK"
    echo.
    echo WScript.StdOut.WriteLine ""
    echo WScript.StdOut.WriteLine "Installation complete!"
    echo WScript.StdOut.WriteLine "Installed to: " ^& installDir
    echo WScript.StdOut.WriteLine ""
    echo WScript.StdOut.WriteLine "Starting SupportHubLAN..."
    echo.
    echo ' Start the server
    echo shell.Run """" ^& launcherPath ^& """", 1, False
) > "%BUILD_DIR%\setup.vbs"
echo   OK: setup.vbs created

REM ---- Step 7: Create IExpress SED config ----
echo.
echo [7/8] Creating IExpress configuration...
(
    echo [Version]
    echo Class=IEXPRESS
    echo SEDVersion=3
    echo [Options]
    echo PackagePurpose=InstallApp
    echo ShowInstallProgramWindow=1
    echo HideExtractAnimation=0
    echo UseLongFileName=1
    echo InsideCompressed=0
    echo CAB_FixedSize=0
    echo CAB_ResvCodeSigning=0
    echo RebootMode=N
    echo InstallPrompt=%NoInstallPrompt%
    echo DisplayLicense=%DisplayLicense%
    echo FinishMessage=%FinishMessage%
    echo TargetName=%BUILD_DIR%\SupportHubLAN-Setup.exe
    echo FriendlyName=SupportHubLAN Installer
    echo AppLaunched=cscript //nologo setup.vbs
    echo PostInstallCmd=<None>
    echo AdminQuietInstCmd=%AdminQuietInstCmd%
    echo UserQuietInstCmd=%UserQuietInstCmd%
    echo SourceFiles=%BUILD_DIR%
    echo [Strings]
    echo DisplayLicense=
    echo FinishMessage=
    echo TargetName=%BUILD_DIR%\SupportHubLAN-Setup.exe
    echo FriendlyName=SupportHubLAN Installer
    echo AppLaunched=cscript //nologo setup.vbs
    echo PostInstallCmd=<None>
    echo AdminQuietInstCmd=
    echo UserQuietInstCmd=
    echo NoInstallPrompt=
    echo.
    echo FILE0="setup.vbs"
    echo FILE1="node"
    echo FILE2="app"
    echo FILE3="PSTools"
    echo [SourceFiles]
    echo SourceFiles0=%BUILD_DIR%
    echo [SourceFiles0]
    echo %%FILE0%%=
    echo %%FILE1%%=
    echo %%FILE2%%=
    echo %%FILE3%%=
) > "%BUILD_DIR%\installer.SED"
echo   OK: installer.SED created

REM ---- Step 8: Build the .exe using IExpress ----
echo.
echo [8/8] Building SupportHubLAN-Setup.exe with IExpress...
echo   (This takes 1-2 minutes to compress)
iexpress /N /Q "%BUILD_DIR%\installer.SED"
if errorlevel 1 (
    echo.
    echo [ERROR] IExpress failed. Trying alternative method...
    echo   Make sure iexpress.exe is available (built into Windows).
    echo.
    echo   Alternatively, you can distribute the contents of:
    echo   %BUILD_DIR%
    echo   as a ZIP file.
    pause
    exit /b 1
)

if exist "%BUILD_DIR%\SupportHubLAN-Setup.exe" (
    echo.
    echo ============================================
    echo   Build Complete!
    echo ============================================
    echo.
    echo   Output: %BUILD_DIR%\SupportHubLAN-Setup.exe
    echo.
    echo   Copy this .exe to any Windows PC and double-click
    echo   to install SupportHubLAN with zero dependencies.
    echo.
    echo   Also copied to current directory.
    copy /Y "%BUILD_DIR%\SupportHubLAN-Setup.exe" "%CD%\SupportHubLAN-Setup.exe" >nul
    echo.
    echo   Location: %CD%\SupportHubLAN-Setup.exe
    echo.
    echo   Opening build folder...
    explorer "%BUILD_DIR%"
) else (
    echo [ERROR] SupportHubLAN-Setup.exe not found
)
pause

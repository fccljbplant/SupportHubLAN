@echo off
set TARGET=%1
set USER=%2
set PASS=%3
echo.
echo ========================================
echo  HARDWARE ASSET REPORT - %TARGET%
echo ========================================
echo.
echo [SYSTEM]
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v SystemManufacturer
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v SystemProductName
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v SystemSerialNumber
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v SystemFamily
echo.
echo [MOTHERBOARD]
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BaseBoardManufacturer
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BaseBoardProduct
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BaseBoardSerialNumber
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BaseBoardVersion
echo.
echo [BIOS]
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BIOSVendor
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BIOSVersion
reg query \\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\BIOS /v BIOSReleaseDate
echo.
echo [PROCESSOR]
reg query "\\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0" /v ProcessorNameString
reg query "\\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0" /v VendorIdentifier
reg query "\\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0" /v Identifier
reg query "\\%TARGET%\HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0" /v ~MHz
echo.
echo [OS]
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v ProductName
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v CurrentBuild
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v UBR
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v InstallDate
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v RegisteredOwner
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v RegisteredOrganization
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v InstallationType
echo.
echo [GPU]
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Video" /s /v DriverDesc
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Video" /s /v DriverVersion
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Video" /s /v HardwareInformation.MemorySize
echo.
echo [NETWORK ADAPTERS]
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}" /s /v DriverDesc
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces" /s /v IPAddress
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces" /s /v SubnetMask
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces" /s /v DefaultGateway
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Class\{4D36E972-E325-11CE-BFC1-08002BE10318}" /s /v NetworkAddress
echo.
echo [PHYSICAL MEMORY INFO]
reg query "\\%TARGET%\HKLM\HARDWARE\RESOURCEMAP\System Resources\Physical Memory" /v .Translated
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management" /v TotalPhysicalMemory
echo.
echo [STORAGE - Drive Letters and Filesystem]
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Services\disk\Enum"
reg query "\\%TARGET%\HKLM\SYSTEM\MountedDevices"
echo.
echo [COMPUTER NAME AND DOMAIN]
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName" /v ComputerName
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v Domain
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v Hostname
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\History" /v MachineDomain
echo.
echo [UPTIME - Last Boot]
reg query "\\%TARGET%\HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power" /v HiberbootEnabled
reg query "\\%TARGET%\HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v LastUsedUsername
echo.
echo ========================================
echo  NOTE: RAM serials and Disk serials
echo  cannot be read from registry.
echo  They require WMI - no workaround.
echo ========================================

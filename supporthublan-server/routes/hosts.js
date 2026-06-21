const { Router } = require('express');
const { sanitizeHost, runPowerShell, buildCredentialBlock, pstoolsExe } = require('../pstools');
const fs = require('fs');

module.exports = function(db) {
  const router = Router();

  // HOST INFO
  router.post('/:hostname/info', async (req, res) => {
    const { hostname } = req.params;
    const { credential } = req.body;
    const safeHost = sanitizeHost(hostname);
    const credBlock = credential ? buildCredentialBlock(credential) : '';
    const script = `
      ${credBlock}
      try {
        $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
        ${credential ? '$params.Credential = $cred' : ''}
        $os = Get-CimInstance Win32_OperatingSystem @params
        $cs = Get-CimInstance Win32_ComputerSystem @params
        $cpu = Get-CimInstance Win32_Processor @params | Select-Object -First 1
        $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" @params
        $uptime = ((Get-Date) - $os.LastBootUpTime)
        $result = @{ hostname = $os.CSName; osName = $os.Caption; osVersion = $os.Version; osBuild = $os.BuildNumber; cpuModel = $cpu.Name; ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1); diskUsedGb = [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1); diskFreeGb = [math]::Round($disk.FreeSpace / 1GB, 1); uptime = "$([math]::Floor($uptime.TotalDays))d $([math]::Floor($uptime.Hours))h"; lastBootTime = $os.LastBootUpTime; onlineStatus = 'online' }
        $result | ConvertTo-Json -Compress
      } catch { @{ hostname = '${safeHost}'; onlineStatus = 'offline'; error = $_.Exception.Message } | ConvertTo-Json -Compress }
    `;
    const result = await runPowerShell(script, 30000);
    try { res.json({ success: true, data: JSON.parse(result.stdout), stdout: result.stdout }); }
    catch { res.json({ success: false, error: 'Parse failed', stderr: result.stderr }); }
  });

  // PING
  router.post('/:hostname/ping', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const script = `try { $ping = Test-Connection -ComputerName '${safeHost}' -Count 1 -Quiet -ErrorAction SilentlyContinue; @{ hostname = '${safeHost}'; online = $ping; status = if ($ping) { 'up' } else { 'down' } } | ConvertTo-Json -Compress } catch { @{ hostname = '${safeHost}'; online = $false; status = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress }`;
    const result = await runPowerShell(script, 10000);
    try { res.json({ success: true, data: JSON.parse(result.stdout) }); }
    catch { res.json({ success: false, error: result.stderr || 'Ping failed' }); }
  });

  // STATUS CHECK (batch ping)
  router.post('/status-check', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { $online = Test-Connection -ComputerName $h -Count 1 -Quiet -ErrorAction SilentlyContinue; $results += @{ hostname = $h; online = $online; status = if ($online) { 'online' } else { 'offline' } } }; $results | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script, Math.max(30000, hostList.length * 3000));
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });

  // HARDWARE INFO (full inventory via PsExec + CIM)
  router.post('/:hostname/hardware', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue'
      $hw = @{}
      $os = Get-CimInstance Win32_OperatingSystem
      $hw.os = @{ name = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture; installDate = $os.InstallDate; lastBoot = $os.LastBootUpTime; serial = $os.SerialNumber }
      $cs = Get-CimInstance Win32_ComputerSystem
      $hw.system = @{ manufacturer = $cs.Manufacturer; model = $cs.Model; serial = (Get-CimInstance Win32_BIOS).SerialNumber; biosVersion = (Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion; biosDate = (Get-CimInstance Win32_BIOS).ReleaseDate; totalRamMB = [math]::Round($cs.TotalPhysicalMemory / 1MB); domain = $cs.Domain }
      $hw.processors = @(Get-CimInstance Win32_Processor | ForEach-Object { @{ name = $_.Name; manufacturer = $_.Manufacturer; cores = $_.NumberOfCores; logicalCores = $_.NumberOfLogicalProcessors; maxSpeedMHz = $_.MaxClockSpeed; currentSpeedMHz = $_.CurrentClockSpeed; socket = $_.SocketDesignation } })
      $hw.memory = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ capacity = [math]::Round($_.Capacity / 1GB, 1); manufacturer = $_.Manufacturer; partNumber = $_.PartNumber; speed = $_.Speed; bankLabel = $_.BankLabel; deviceLocator = $_.DeviceLocator; serialNumber = $_.SerialNumber } })
      $hw.disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { @{ model = $_.Model; sizeGB = [math]::Round($_.Size / 1GB, 1); interface = $_.InterfaceType; firmware = $_.FirmwareRevision; serialNumber = $_.SerialNumber; partitions = $_.Partitions; index = $_.Index } })
      $hw.logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1); fileSystem = $_.FileSystem; volumeName = $_.VolumeName } })
      $hw.cdDvd = @(Get-CimInstance Win32_CDROMDrive | ForEach-Object { @{ name = $_.Name; drive = $_.Drive; mediaLoaded = $_.MediaLoaded; manufacturer = $_.Manufacturer } })
      $hw.network = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true' | ForEach-Object { @{ description = $_.Description; ipAddress = ($_.IPAddress -join ', '); macAddress = $_.MACAddress; dhcpEnabled = $_.DHCPEnabled; defaultGateway = ($_.DefaultIPGateway -join ', '); dnsServers = ($_.DNSServerSearchOrder -join ', ') } })
      $hw.loggedInUser = (Get-CimInstance Win32_ComputerSystem).UserName
      $hw.managedBy = $null
      if ($cs.PartOfDomain) { try { $computer = Get-ADComputer $cs.Name -Properties ManagedBy -ErrorAction SilentlyContinue; if ($computer.ManagedBy) { $manager = Get-ADObject $computer.ManagedBy -Properties cn -ErrorAction SilentlyContinue; $hw.managedBy = $manager.cn } } catch {} }
      $hw.gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; manufacturer = $_.AdapterCompatibility; ramMB = [math]::Round($_.AdapterRAM / 1MB); driverVersion = $_.DriverVersion; driverDate = $_.DriverDate } })
      $hw.hostname = $cs.Name
      $hw.scannedAt = (Get-Date).ToString('o')
      $hw | ConvertTo-Json -Depth 4 -Compress
    `;
    const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');
    const script = `& "${pstoolsExe('psexec.exe')}" \\\\${safeHost} -accepteula -s -h powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedScript} 2>&1 | Out-String`;
    const result = await runPowerShell(script, 60000);
    if (result.success && result.stdout) {
      try {
        const hwInfo = JSON.parse(result.stdout);
        const key = 'hardware:' + safeHost;
        const previous = db.settings.get(key, null);
        let changes = [];
        if (previous) {
          const prev = JSON.parse(previous);
          ['system.manufacturer', 'system.model', 'system.serial'].forEach(field => {
            const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
            if (get(prev, field) && get(hwInfo, field) && get(prev, field) !== get(hwInfo, field)) changes.push({ field, oldValue: get(prev, field), newValue: get(hwInfo, field) });
          });
          if (prev.processors?.length !== hwInfo.processors?.length) changes.push({ field: 'processorCount', oldValue: prev.processors?.length, newValue: hwInfo.processors?.length });
          if (prev.memory?.length !== hwInfo.memory?.length) changes.push({ field: 'memoryStickCount', oldValue: prev.memory?.length, newValue: hwInfo.memory?.length });
        }
        db.settings.set(key, JSON.stringify(hwInfo));
        res.json({ success: true, data: hwInfo, changes, isFirstScan: !previous });
      } catch { res.json({ success: false, error: 'Parse failed', stdout: result.stdout?.substring(0, 500) }); }
    } else { res.json({ success: false, error: result.stderr || 'PsExec failed' }); }
  });

  // EVENT LOG
  router.post('/:hostname/eventlog', async (req, res) => {
    const { hostname } = req.params;
    const { logName = 'System', maxEvents = 50, severity, credential } = req.body;
    const safeHost = sanitizeHost(hostname);
    const safeLog = String(logName).replace(/[^a-zA-Z0-9 ]/g, '');
    const safeMax = Math.min(parseInt(maxEvents, 10) || 50, 500);
    let levelFilter = '';
    if (severity === 'Error') levelFilter = '-Level 2';
    else if (severity === 'Warning') levelFilter = '-Level 3';
    else if (severity === 'Information') levelFilter = '-Level 4';
    const psCmd = `Get-WinEvent -FilterHashtable @{ LogName = '${safeLog}'; StartTime = (Get-Date).AddDays(-7) } ${levelFilter} -MaxEvents ${safeMax} -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message | ConvertTo-Json -Depth 3 -Compress`;
    const encoded = `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('${psCmd.replace(/'/g, "''")}'))`;
    const script = `try { $encoded = ${encoded}; $result = & "${pstoolsExe('psexec.exe')}" \\\\${safeHost} -accepteula -s -h powershell -NoProfile -EncodedCommand $encoded 2>&1 | Out-String; if (-not $result) { @{ events = @() } | ConvertTo-Json -Compress } else { $result } } catch { @{ error = $_.Exception.Message; events = @() } | ConvertTo-Json -Compress }`;
    const result = await runPowerShell(script, 30000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });

  // RESOLVE HOSTNAME (DNS)
  router.post('/resolve-hostname', (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, error: 'ip required' });
    require('dns').reverse(ip, (err, hostnames) => {
      if (err || !hostnames || hostnames.length === 0) return res.json({ success: false, hostname: null, error: err ? err.message : 'no ptr' });
      res.json({ success: true, hostname: hostnames[0] });
    });
  });

  // RESOLVE NETBIOS
  router.post('/resolve-netbios', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, error: 'ip required' });
    const safeIp = sanitizeHost(ip);
    const script = `try { $raw = nbtstat -A '${safeIp}' 2>&1; foreach ($line in ($raw -split "\\r?\\n")) { if ($line -match '^\\s*(\\S+)\\s+<00>\\s+UNIQUE') { Write-Output $matches[1]; exit 0 } }; $hostname = & "${pstoolsExe('psexec.exe')}" \\\\${safeIp} -accepteula -s hostname 2>&1 | Out-String; if ($hostname -match '^([A-Za-z0-9_-]+)') { Write-Output $matches[1] } else { Write-Output '' } } catch { Write-Output '' }`;
    const result = await runPowerShell(script, 15000);
    const name = (result.stdout || '').trim();
    res.json(name ? { success: true, hostname: name.toUpperCase() } : { success: false, hostname: null });
  });

  return router;
};

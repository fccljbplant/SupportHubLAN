const { Router } = require('express');
const {
  sanitizeHost, runPowerShell, runPsToolDirect, runRemoteCmdDirect,
  buildCredentialBlock, pstoolsExe, extractJsonFromOutput,
} = require('../pstools');
const fs = require('fs');

module.exports = function(db) {
  const router = Router();

  // ===========================================================================
  // HOST INFO — basic info (OS, CPU model, RAM, disk usage). Still uses
  // PowerShell+CIM because Get-CimInstance works reliably on all Windows.
  // ===========================================================================
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

  // ===========================================================================
  // PING — uses PowerShell Test-Connection (still required; ping.exe via
  // spawn could be used, but Test-Connection returns structured data).
  // ===========================================================================
  router.post('/:hostname/ping', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    // Use direct ping.exe for speed — no PowerShell needed
    const r = await runPsToolDirect('ping.exe', ['-n', '1', '-w', '2000', safeHost], 8000);
    // ping.exe is not a PsTools exe; -accepteula wasn't added. Just check output.
    const out = r.stdout || '';
    const isUp = /\bReply from\b/i.test(out) && !/Destination host unreachable/i.test(out);
    res.json({
      success: true,
      data: { hostname: safeHost, online: isUp, status: isUp ? 'up' : 'down', raw: out.substring(0, 500) },
    });
  });

  // ===========================================================================
  // STATUS CHECK (batch ping) — fires pings in parallel via Promise.all
  // using runPsToolDirect('ping.exe'). Much faster than the old PowerShell
  // loop, and can't crash the server (all pings are isolated).
  // ===========================================================================
  router.post('/status-check', async (req, res) => {
    const { hostnames } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.json({ success: true, data: [] });
    }
    const hostList = hostnames.map(sanitizeHost).filter(Boolean);
    // Limit concurrency to 32 simultaneous pings to avoid spawning too many processes
    const CONCURRENCY = 32;
    const results = [];
    for (let i = 0; i < hostList.length; i += CONCURRENCY) {
      const batch = hostList.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (h) => {
        const r = await runPsToolDirect('ping.exe', ['-n', '1', '-w', '1500', h], 5000);
        const out = r.stdout || '';
        const online = /\bReply from\b/i.test(out) && !/Destination host unreachable/i.test(out);
        return { hostname: h, online, status: online ? 'online' : 'offline' };
      }));
      results.push(...batchResults);
    }
    res.json({ success: true, data: JSON.stringify(results) });
  });

  // ===========================================================================
  // HARDWARE INFO — Full hardware audit using MULTIPLE PsTools commands.
  //
  // PsTools commands used (study PsTools docs):
  //   1. PsExec \\HOST -s wmic computersystem  → system make/model/serial/RAM
  //   2. PsExec \\HOST -s wmic baseboard       → motherboard make/model/serial
  //   3. PsExec \\HOST -s wmic bios            → BIOS manufacturer/version/date
  //   4. PsExec \\HOST -s wmic cpu             → processor make/model/cores/threads
  //   5. PsExec \\HOST -s wmic memorychip      → RAM sticks (capacity/speed/part#)
  //   6. PsExec \\HOST -s wmic diskdrive       → physical disks (model/size/serial)
  //   7. PsExec \\HOST -s wmic logicaldisk     → volumes (drive/size/free/fs)
  //   8. PsExec \\HOST -s wmic path win32_videocontroller → GPU
  //   9. PsExec \\HOST -s wmic os              → OS name/build/install date/serial
  //  10. PsExec \\HOST -s ipconfig /all        → network adapters (IP/MAC/DHCP/DNS)
  //  11. PsLoggedOn \\HOST                     → currently logged-on user
  //
  // All 11 commands run in PARALLEL via Promise.all. No PowerShell needed.
  // Output parsed in JavaScript from wmic's /format:list output.
  // ===========================================================================
  router.post('/:hostname/hardware', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    try {
      // Launch all 11 PsTools commands in parallel
      const [
        csRes, bbRes, biosRes, cpuRes, memRes,
        diskRes, ldRes, gpuRes, osRes,
        ipconfigRes, loggedOnRes,
      ] = await Promise.all([
        runRemoteCmdDirect(safeHost, ['wmic', 'computersystem', 'get', 'Manufacturer,Model,SerialNumber,SystemType,TotalPhysicalMemory,Domain,NumberOfProcessors,NumberOfLogicalProcessors', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'baseboard', 'get', 'Manufacturer,Product,Version,SerialNumber', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'bios', 'get', 'Manufacturer,Name,SMBIOSBIOSVersion,ReleaseDate,SerialNumber', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'cpu', 'get', 'Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,CurrentClockSpeed,SocketDesignation', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'memorychip', 'get', 'Capacity,Manufacturer,PartNumber,Speed,DeviceLocator,SerialNumber', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'diskdrive', 'get', 'Model,Size,InterfaceType,SerialNumber,Partitions,Index,MediaType', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'logicaldisk', 'where', 'DriveType=3', 'get', 'DeviceID,Size,FreeSpace,FileSystem,VolumeName', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'path', 'win32_videocontroller', 'get', 'Name,AdapterCompatibility,AdapterRAM,DriverVersion,DriverDate', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['wmic', 'os', 'get', 'Caption,Version,BuildNumber,InstallDate,LastBootUpTime,SerialNumber,OSArchitecture,RegisteredOrganization,RegisteredUser', '/format:list'], 20000),
        runRemoteCmdDirect(safeHost, ['ipconfig', '/all'], 20000),
        runPsToolDirect('psloggedon.exe', ['\\\\' + safeHost], 15000),
      ]);

      // Check if ALL failed (host is likely offline)
      const allFailed = [csRes, bbRes, biosRes, cpuRes, osRes].every(r => !r.success && !r.stdout);
      if (allFailed) {
        return res.json({
          success: false,
          error: csRes.stderr || 'All PsExec commands failed — host may be offline or PsTools not installed',
        });
      }

      // Parse each wmic output
      const cs = parseWmicList(csRes.stdout);
      const bb = parseWmicList(bbRes.stdout);
      const bios = parseWmicList(biosRes.stdout);
      const cpus = parseWmicListMulti(cpuRes.stdout);
      const mems = parseWmicListMulti(memRes.stdout);
      const disks = parseWmicListMulti(diskRes.stdout);
      const lds = parseWmicListMulti(ldRes.stdout);
      const gpus = parseWmicListMulti(gpuRes.stdout);
      const osInfo = parseWmicList(osRes.stdout);

      // Build the structured hardware object
      const totalRamBytes = parseInt(cs.TotalPhysicalMemory || '0', 10);
      const totalRamMB = Math.round(totalRamBytes / (1024 * 1024));

      // Processor — take the FIRST one only (user request: "just show one processor")
      const cpu = cpus.length > 0 ? {
        name: cpus[0].Name || 'Unknown',
        manufacturer: cpus[0].Manufacturer || 'Unknown',
        cores: parseInt(cpus[0].NumberOfCores || '0', 10),
        logicalCores: parseInt(cpus[0].NumberOfLogicalProcessors || '0', 10),
        threads: parseInt(cpus[0].NumberOfLogicalProcessors || '0', 10), // threads = logical processors
        maxSpeedMHz: parseInt(cpus[0].MaxClockSpeed || '0', 10),
        currentSpeedMHz: parseInt(cpus[0].CurrentClockSpeed || '0', 10),
        socket: cpus[0].SocketDesignation || '',
      } : null;

      // Memory sticks
      const memory = mems.filter(m => m.Capacity).map(m => ({
        capacityGB: Math.round(parseInt(m.Capacity, 10) / (1024 * 1024 * 1024) * 10) / 10,
        manufacturer: m.Manufacturer || '',
        partNumber: m.PartNumber || '',
        speed: parseInt(m.Speed || '0', 10),
        deviceLocator: m.DeviceLocator || '',
        serialNumber: m.SerialNumber || '',
      }));

      // Physical disks
      const physicalDisks = disks.filter(d => d.Model).map((d, i) => ({
        model: d.Model || '',
        sizeGB: Math.round(parseInt(d.Size || '0', 10) / (1024 * 1024 * 1024) * 10) / 10,
        interface: d.InterfaceType || d.MediaType || '',
        serialNumber: d.SerialNumber || '',
        partitions: parseInt(d.Partitions || '0', 10),
        index: parseInt(d.Index || i.toString(), 10),
      }));

      // Logical volumes
      const logicalDisks = lds.filter(d => d.DeviceID).map(d => ({
        drive: d.DeviceID,
        sizeGB: Math.round(parseInt(d.Size || '0', 10) / (1024 * 1024 * 1024) * 10) / 10,
        freeGB: Math.round(parseInt(d.FreeSpace || '0', 10) / (1024 * 1024 * 1024) * 10) / 10,
        fileSystem: d.FileSystem || '',
        volumeName: d.VolumeName || '',
      }));

      // GPU(s)
      const gpu = gpus.filter(g => g.Name).map(g => ({
        name: g.Name || '',
        manufacturer: g.AdapterCompatibility || '',
        ramMB: Math.round(parseInt(g.AdapterRAM || '0', 10) / (1024 * 1024)),
        driverVersion: g.DriverVersion || '',
        driverDate: g.DriverDate || '',
      }));

      // Network adapters (from ipconfig /all)
      const network = parseIpConfigOutput(ipconfigRes.stdout);

      // Logged-in user
      const loggedInUser = parsePsLoggedOnOutput(loggedOnRes.stdout);

      // Build the final hardware object
      const hw = {
        hostname: safeHost,
        scannedAt: new Date().toISOString(),

        system: {
          manufacturer: cs.Manufacturer || '',
          model: cs.Model || '',
          serial: cs.SerialNumber || '',
          systemType: cs.SystemType || '',
          domain: cs.Domain || '',
          totalRamMB,
          numberOfProcessors: parseInt(cs.NumberOfProcessors || '0', 10),
          numberOfLogicalProcessors: parseInt(cs.NumberOfLogicalProcessors || '0', 10),
        },

        motherboard: {
          manufacturer: bb.Manufacturer || '',
          product: bb.Product || '',
          version: bb.Version || '',
          serial: bb.SerialNumber || '',
        },

        bios: {
          manufacturer: bios.Manufacturer || '',
          name: bios.Name || '',
          version: bios.SMBIOSBIOSVersion || '',
          serial: bios.SerialNumber || '',
          releaseDate: bios.ReleaseDate || '',
        },

        processor: cpu, // single processor (first one)

        memory,
        disks: physicalDisks,
        logicalDisks,
        network,
        gpu,

        os: {
          name: osInfo.Caption || '',
          version: osInfo.Version || '',
          build: osInfo.BuildNumber || '',
          architecture: osInfo.OSArchitecture || '',
          installDate: parseWmiDate(osInfo.InstallDate),
          lastBoot: parseWmiDate(osInfo.LastBootUpTime),
          serial: osInfo.SerialNumber || '',
          registeredOrg: osInfo.RegisteredOrganization || '',
          registeredUser: osInfo.RegisteredUser || '',
        },

        loggedInUser,

        _source: 'wmic+ipconfig+psloggedon',
      };

      // ========================================================================
      // MERGE LOGIC — don't lose old data if new scan returns empty fields.
      //
      // For each section (system, motherboard, bios, processor, memory, disks,
      // logicalDisks, network, gpu, os), if the NEW scan returned data for
      // that section, use the new data. If the new scan returned EMPTY for
      // that section, KEEP the old saved data. This way a partial scan
      // (e.g. wmic failed but ipconfig worked) doesn't wipe out previously
      // good data.
      // ========================================================================
      const key = 'hardware:' + safeHost;
      let prevHw = null;
      let isFirstScan = true;
      try {
        const previous = db.settings.get(key, null);
        if (previous) {
          isFirstScan = false;
          try { prevHw = JSON.parse(previous); } catch { prevHw = null; }
        }
      } catch (e) { /* ignore load failures */ }

      // Check which sections the new scan actually returned data for
      const newHas = {
        system:        !!(hw.system?.manufacturer || hw.system?.model || hw.system?.serial),
        motherboard:   !!(hw.motherboard?.manufacturer || hw.motherboard?.product),
        bios:          !!(hw.bios?.manufacturer || hw.bios?.version),
        processor:     !!(hw.processor?.name),
        memory:        !!(hw.memory && hw.memory.length > 0),
        disks:         !!(hw.disks && hw.disks.length > 0),
        logicalDisks:  !!(hw.logicalDisks && hw.logicalDisks.length > 0),
        network:       !!(hw.network && hw.network.length > 0),
        gpu:           !!(hw.gpu && hw.gpu.length > 0),
        os:            !!(hw.os?.name),
      };

      // If we have previous data, merge: use new data where available, keep
      // old data for sections that came back empty.
      let finalHw = hw;
      if (prevHw) {
        finalHw = { ...prevHw };

        // Always update scan timestamp
        finalHw.scannedAt = hw.scannedAt;

        // Merge each section
        if (newHas.system)       finalHw.system       = { ...(prevHw.system || {}), ...hw.system };
        if (newHas.motherboard)  finalHw.motherboard  = { ...(prevHw.motherboard || {}), ...hw.motherboard };
        if (newHas.bios)         finalHw.bios         = { ...(prevHw.bios || {}), ...hw.bios };
        if (newHas.processor)    finalHw.processor    = hw.processor;
        if (newHas.memory)       finalHw.memory       = hw.memory;
        if (newHas.disks)        finalHw.disks        = hw.disks;
        if (newHas.logicalDisks) finalHw.logicalDisks = hw.logicalDisks;
        if (newHas.network)      finalHw.network      = hw.network;
        if (newHas.gpu)          finalHw.gpu          = hw.gpu;
        if (newHas.os)           finalHw.os           = { ...(prevHw.os || {}), ...hw.os };

        // Always update loggedInUser (it's real-time data, not hardware)
        if (hw.loggedInUser) finalHw.loggedInUser = hw.loggedInUser;

        // Keep the hostname from whichever has it
        finalHw.hostname = finalHw.hostname || hw.hostname || safeHost;
      } else {
        // No previous data — use whatever the new scan returned
        finalHw = hw;
      }

      // Hardware change detection (compare finalHw with prevHw)
      let changes = [];
      if (prevHw) {
        try {
          const getField = (o, p) => p.split('.').reduce((a, k) => (a && a[k] !== undefined) ? a[k] : null, o);
          const compareField = (field) => {
            const oldV = getField(prevHw, field);
            const newV = getField(finalHw, field);
            if (oldV && newV && String(oldV) !== String(newV)) {
              changes.push({ field, oldValue: oldV, newValue: newV });
            }
          };
          ['system.manufacturer', 'system.model', 'system.serial',
           'motherboard.serial', 'bios.serial',
           'processor.name', 'processor.cores', 'processor.threads',
           'system.totalRamMB'].forEach(compareField);
          const prevDiskCount = (prevHw.disks || []).length;
          const newDiskCount = (finalHw.disks || []).length;
          if (prevDiskCount !== newDiskCount && newDiskCount > 0) {
            changes.push({ field: 'diskCount', oldValue: prevDiskCount, newValue: newDiskCount });
          }
        } catch (e) { /* ignore comparison failures */ }
      }

      // Save the MERGED data (never save empty data over good data)
      try { db.settings.set(key, JSON.stringify(finalHw)); } catch (e) { /* ignore save failures */ }

      // Collect any raw outputs for debugging
      const rawOutputs = {
        computersystem: csRes.stdout ? csRes.stdout.substring(0, 1000) : '',
        baseboard: bbRes.stdout ? bbRes.stdout.substring(0, 1000) : '',
        bios: biosRes.stdout ? biosRes.stdout.substring(0, 1000) : '',
        cpu: cpuRes.stdout ? cpuRes.stdout.substring(0, 1000) : '',
        csStderr: csRes.stderr ? csRes.stderr.substring(0, 500) : '',
      };

      // Determine if this was a partial scan (most sections empty)
      const newSectionCount = Object.values(newHas).filter(Boolean).length;
      const partialScan = newSectionCount < 3; // less than 3 sections returned data

      res.json({
        success: true,
        data: finalHw,    // return the MERGED data, not the raw new scan
        changes,
        isFirstScan,
        partialScan,
        newSections: newHas,
        rawOutputs,
      });
    } catch (e) {
      res.json({ success: false, error: e.message || 'Hardware scan failed' });
    }
  });

  // ===========================================================================
  // GET HARDWARE (saved) — retrieve previously-saved hardware data WITHOUT
  // running a new scan. Used by the frontend when opening the Hardware tab
  // so the user sees the last known data immediately (instead of a blank
  // page while the scan runs).
  // ===========================================================================
  router.get('/:hostname/hardware', (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const key = 'hardware:' + safeHost;
    try {
      const saved = db.settings.get(key, null);
      if (saved) {
        const hw = JSON.parse(saved);
        res.json({ success: true, data: hw, scannedAt: hw.scannedAt });
      } else {
        res.json({ success: false, error: 'No saved hardware data. Run a scan first.' });
      }
    } catch (e) {
      res.json({ success: false, error: 'Failed to load saved hardware data: ' + e.message });
    }
  });

  // ===========================================================================
  // INSTALLED APPS — Uses PsExec + reg query (NO PowerShell) to list all
  // installed software from the Windows registry Uninstall keys.
  //
  // Queries both 64-bit and 32-bit Uninstall keys:
  //   - HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall (64-bit apps)
  //   - HKLM\SOFTWARE\WOW6432Node\...\Uninstall (32-bit apps on 64-bit OS)
  //   - HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall (user apps)
  //
  // Parses the reg output to extract DisplayName, DisplayVersion, Publisher,
  // InstallDate for each entry that has a DisplayName.
  // ===========================================================================
  router.post('/:hostname/apps', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    try {
      const [reg64Res, reg32Res, regUserRes] = await Promise.all([
        runRemoteCmdDirect(safeHost, ['reg', 'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000),
        runRemoteCmdDirect(safeHost, ['reg', 'query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000),
        runRemoteCmdDirect(safeHost, ['reg', 'query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000),
      ]);

      const apps64 = parseRegUninstall(reg64Res.stdout);
      const apps32 = parseRegUninstall(reg32Res.stdout);
      const appsUser = parseRegUninstall(regUserRes.stdout);

      // Merge, dedupe, sort
      const allApps = [...apps64, ...apps32, ...appsUser];
      const seen = new Set();
      const deduped = allApps.filter(a => {
        const key = (a.name + '|' + (a.version || '')).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      res.json({
        success: true,
        data: JSON.stringify(deduped),
        apps: deduped,
        count: deduped.length,
        sources: {
          '64bit': apps64.length,
          '32bit': apps32.length,
          'user': appsUser.length,
        },
      });
    } catch (e) {
      res.json({ success: false, error: e.message || 'Failed to list apps' });
    }
  });

  // ===========================================================================
  // EVENT LOG — uses PsExec + remote PowerShell Get-WinEvent.
  // The remote PowerShell writes marker-wrapped JSON to stdout, which we
  // extract with extractJsonFromOutput(). This fixes the previous bug where
  // the PsExec banner noise caused JSON.parse to fail on the frontend.
  // ===========================================================================
  router.post('/:hostname/eventlog', async (req, res) => {
    const { hostname } = req.params;
    const { logName = 'System', maxEvents = 50, severity, credential } = req.body;
    const safeHost = sanitizeHost(hostname);
    const safeLog = String(logName).replace(/[^a-zA-Z0-9 ]/g, '');
    const safeMax = Math.min(Math.max(parseInt(maxEvents, 10) || 50, 1), 500);

    // Build the remote PowerShell command. We wrap the JSON output in
    // <<<JSON>>>...<<<END>>> markers so we can reliably extract it from
    // the PsExec banner noise.
    let levelFilter = '';
    if (severity === 'Error') levelFilter = ' -Level 2';
    else if (severity === 'Warning') levelFilter = ' -Level 3';
    else if (severity === 'Information') levelFilter = ' -Level 4';

    const remotePs =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$events = Get-WinEvent -FilterHashtable @{ LogName='${safeLog}'; StartTime=(Get-Date).AddDays(-7) }${levelFilter} -MaxEvents ${safeMax} -ErrorAction SilentlyContinue | ` +
      `Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, @{N='Message';E={$_.Message -replace '\\r?\\n',' '}}; ` +
      `if (-not $events) { Write-Output '<<<JSON>>>[]<<<END>>>' } ` +
      `else { $j = $events | ConvertTo-Json -Depth 3 -Compress; ` +
      `if ($j -is [string]) { Write-Output ('<<<JSON>>>' + $j + '<<<END>>>') } ` +
      `else { Write-Output ('<<<JSON>>>[' + $j + ']<<<END>>>') } }`;

    const encodedCmd = Buffer.from(remotePs, 'utf16le').toString('base64');

    // Run psexec \\HOST -s powershell -EncodedCommand <base64>
    const r = await runPsToolDirect('psexec.exe',
      ['\\\\' + safeHost, '-s', '-h', 'powershell.exe',
       '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCmd],
      45000);

    if (!r.success && !r.stdout) {
      return res.json({
        success: false,
        error: r.stderr || 'PsExec failed (host may be offline)',
        events: [],
      });
    }

    const parsed = extractJsonFromOutput(r.stdout);
    if (parsed === null) {
      return res.json({
        success: false,
        error: 'Could not parse event log output',
        raw: (r.stdout || '').substring(0, 500),
        events: [],
      });
    }
    const eventsArr = Array.isArray(parsed) ? parsed : [parsed];
    res.json({
      success: true,
      data: JSON.stringify(eventsArr),
      events: eventsArr,
      count: eventsArr.length,
    });
  });

  // ===========================================================================
  // RESOLVE HOSTNAME (DNS reverse lookup)
  // ===========================================================================
  router.post('/resolve-hostname', (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, error: 'ip required' });
    require('dns').reverse(ip, (err, hostnames) => {
      if (err || !hostnames || hostnames.length === 0) return res.json({ success: false, hostname: null, error: err ? err.message : 'no ptr' });
      res.json({ success: true, hostname: hostnames[0] });
    });
  });

  // ===========================================================================
  // RESOLVE NETBIOS — uses nbtstat (via PowerShell wrapper, fast)
  // ===========================================================================
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

// =============================================================================
// PARSERS — plain text → structured JS objects
// =============================================================================

// ---------------------------------------------------------------------------
// parseWmicList — parse wmic /format:list output into a single record object.
// wmic /format:list output looks like:
//   Manufacturer=Dell Inc.
//   Model=OptiPlex 7070
//   SerialNumber=ABC123
//
// Returns the FIRST record as a flat { key: value } object.
// ---------------------------------------------------------------------------
function parseWmicList(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const obj = {};
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (value !== '' && !(key in obj)) obj[key] = value;
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// parseWmicListMulti — parse wmic /format:list output into an ARRAY of records.
// Used for wmic queries that return multiple rows (e.g. multiple CPUs, memory
// sticks, disk drives). Records are separated by blank lines.
// ---------------------------------------------------------------------------
function parseWmicListMulti(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const records = [];
  let current = {};
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (Object.keys(current).length > 0) {
        records.push(current);
        current = {};
      }
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (value !== '') current[key] = value;
    }
  }
  if (Object.keys(current).length > 0) records.push(current);
  return records;
}

// ---------------------------------------------------------------------------
// parseWmiDate — convert a WMI datetime string to a readable ISO string.
// WMI dates look like: 20230115123045.000000+000
// (YYYYMMDDHHMMSS.ffffff+timezone)
// ---------------------------------------------------------------------------
function parseWmiDate(wmiDate) {
  if (!wmiDate || typeof wmiDate !== 'string') return '';
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(wmiDate);
  if (!m) return wmiDate;
  try {
    const dt = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]), parseInt(m[6])));
    return dt.toISOString().replace('T', ' ').substring(0, 19);
  } catch {
    return wmiDate;
  }
}

// ---------------------------------------------------------------------------
// parseRegUninstall — parse `reg query ... /s` output into an array of
// installed apps with { name, version, publisher, installDate }.
//
// reg query /s output looks like:
//
//   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{GUID}
//       DisplayName    REG_SZ    Microsoft Visual C++ 2015-2019 Redistributable
//       DisplayVersion    REG_SZ    14.29.30133.0
//       Publisher    REG_SZ    Microsoft Corporation
//       InstallDate    REG_SZ    20230115
//       ...
//
// Only entries with a DisplayName are included.
// ---------------------------------------------------------------------------
function parseRegUninstall(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const apps = [];
  const lines = out.split('\n');
  let current = {};
  let hasName = false;

  for (const line of lines) {
    // A new registry key starts with HKEY_
    if (/^HKEY_/.test(line.trim())) {
      if (hasName && current.name) {
        apps.push(current);
      }
      current = {};
      hasName = false;
      continue;
    }
    // Property line: "    DisplayName    REG_SZ    Value"
    const m = /^\s+(\S+)\s+REG_\S+\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1];
      const value = (m[2] || '').trim();
      if (key === 'DisplayName' && value) {
        current.name = value;
        hasName = true;
      } else if (key === 'DisplayVersion') {
        current.version = value;
      } else if (key === 'Publisher') {
        current.publisher = value;
      } else if (key === 'InstallDate') {
        current.installDate = value;
      }
    }
  }
  // Last entry
  if (hasName && current.name) {
    apps.push(current);
  }
  return apps;
}

// Parse `psinfo -d \\HOST` output.
// Returns: { hostname, os:{name,version,build,installDate,lastBoot}, system:{manufacturer,model,totalRamMB,domain}, processors:[{name,cores,logicalCores,maxSpeedMHz}], memory:[], disks:[], logicalDisks:[], cdDvd:[], network:[], gpu:[{name}], loggedInUser, scannedAt }
function parsePsInfoOutput(raw, fallbackHost) {
  const out = raw || '';
  const lines = out.split(/\r?\n/);
  const kv = {}; // key:value map

  for (const line of lines) {
    const m = /^\s*([A-Za-z][A-Za-z ]+?)\s*:\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim();
      if (val !== '') kv[key] = val;
    }
  }

  // Find the "System information for \\\\HOST:" line
  let hostname = fallbackHost;
  const hostLine = lines.find(l => /System information for/i.test(l));
  if (hostLine) {
    const m = /System information for\s+\\+([^\s:]+)/i.exec(hostLine);
    if (m) hostname = m[1];
  }

  // Disk volumes block — starts after a header like "Volume Type Format ..."
  const disks = [];
  const logicalDisks = [];
  let inVolumeBlock = false;
  for (const line of lines) {
    if (/^\s*Volume\s+Type\s+Format/i.test(line)) { inVolumeBlock = true; continue; }
    if (inVolumeBlock) {
      if (/^\s*$/.test(line)) { inVolumeBlock = false; continue; }
      // Match:  "C:     Fixed         NTFS       OS                  475 GB     200 GB"
      const m = /^\s*([A-Z]:)\s+(\S+)\s+(\S+)\s*(.*?)\s+(\d+)\s*(GB|MB)\s+(\d+)\s*(GB|MB)\s*$/i.exec(line);
      if (m) {
        const drive = m[1];
        const type = m[2];
        const fmt = m[3];
        const label = (m[4] || '').trim();
        const sizeNum = parseInt(m[5], 10);
        const sizeUnit = m[6].toUpperCase();
        const freeNum = parseInt(m[7], 10);
        const freeUnit = m[8].toUpperCase();
        const sizeGB = sizeUnit === 'TB' ? sizeNum * 1024 : sizeNum;
        const freeGB = freeUnit === 'TB' ? freeNum * 1024 : freeNum;
        if (/fixed|internal|removable/i.test(type)) {
          disks.push({ model: label || (type + ' drive'), sizeGB, interface: type, firmware: '', serialNumber: '', partitions: 0, index: disks.length });
        }
        logicalDisks.push({ drive, sizeGB, freeGB, fileSystem: fmt, volumeName: label });
      } else {
        // blank or end of block
        if (/^\s*$/.test(line)) inVolumeBlock = false;
      }
    }
  }

  // Build structured hardware object
  const processors = [];
  const procCount = parseInt(kv['processors'] || '1', 10) || 1;
  const procName = kv['processor type'] || 'Unknown CPU';
  const procSpeed = kv['processor speed'] || '';
  const speedMatch = /([\d.]+)\s*GHz/i.exec(procSpeed);
  const maxSpeedMHz = speedMatch ? Math.round(parseFloat(speedMatch[1]) * 1000) : null;
  // PsInfo doesn't break out cores vs logical — we set both to procCount as a best-effort.
  for (let i = 0; i < procCount; i++) {
    processors.push({
      name: procName,
      manufacturer: /Intel/i.test(procName) ? 'Intel' : /AMD|Advanced Micro/i.test(procName) ? 'AMD' : 'Unknown',
      cores: procCount,
      logicalCores: procCount,
      maxSpeedMHz,
      currentSpeedMHz: maxSpeedMHz,
      socket: '',
    });
  }

  const ramMatch = /(\d+)\s*(MB|GB|TB)/i.exec(kv['physical memory'] || '');
  let totalRamMB = 0;
  if (ramMatch) {
    const n = parseInt(ramMatch[1], 10);
    const u = ramMatch[2].toUpperCase();
    totalRamMB = u === 'GB' ? n * 1024 : u === 'TB' ? n * 1024 * 1024 : n;
  }

  // GPU — PsInfo shows "Video driver:" but only one. Could be comma-separated.
  const gpu = [];
  if (kv['video driver']) {
    kv['video driver'].split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(name => {
      gpu.push({ name, manufacturer: '', ramMB: 0, driverVersion: '', driverDate: '' });
    });
  }

  return {
    hostname,
    os: {
      name: kv['kernel version'] || kv['product type'] || 'Windows',
      version: '',
      build: kv['kernel build number'] || kv['os build'] || '',
      architecture: '',
      installDate: kv['install date'] || '',
      lastBoot: '',
      serial: '',
    },
    system: {
      manufacturer: '', // PsInfo doesn't expose this
      model: '',        // PsInfo doesn't expose this
      serial: '',
      biosVersion: '',
      biosDate: '',
      totalRamMB,
      domain: '',
    },
    processors,
    memory: [], // PsInfo doesn't enumerate individual sticks
    disks,
    logicalDisks,
    cdDvd: [],  // PsInfo doesn't enumerate CD/DVD
    network: [], // filled by parseIpConfigOutput later
    gpu,
    loggedInUser: null, // filled by parsePsLoggedOnOutput later
    managedBy: null,
    scannedAt: new Date().toISOString(),
    _source: 'psinfo',
  };
}

// Parse `ipconfig /all` output (run remotely via psexec).
function parseIpConfigOutput(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const adapters = [];
  // Strip the PsExec banner (everything before the first "adapter" line)
  const lines = out.split('\n');

  // Find sections — each starts with a line like "Ethernet adapter Ethernet0:" or "Wireless LAN adapter Wi-Fi:"
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const adapterMatch = /^(.+?)\s+adapter\s+(.+?):\s*$/.exec(line);
    if (adapterMatch) {
      if (current) adapters.push(current);
      current = {
        description: (adapterMatch[2] || '').trim(),
        adapterType: (adapterMatch[1] || '').trim(),
        ipAddress: '',
        macAddress: '',
        dhcpEnabled: false,
        defaultGateway: '',
        dnsServers: '',
      };
      continue;
    }
    if (!current) continue;
    const descM = /Description\.+\s*:\s*(.*)$/i.exec(line);
    if (descM) { current.description = current.description === current.adapterType ? descM[1].trim() : current.description + ' - ' + descM[1].trim(); continue; }
    const macM = /Physical Address\.+\s*:\s*([0-9A-Fa-f\-:]+)/i.exec(line);
    if (macM) { current.macAddress = macM[1].toUpperCase(); continue; }
    const ipM = /IPv4 Address\.+\s*:\s*([0-9.]+)/i.exec(line);
    if (ipM) { current.ipAddress = ipM[1]; continue; }
    const gwM = /Default Gateway\.+\s*:\s*([0-9.]+)/i.exec(line);
    if (gwM) { current.defaultGateway = gwM[1]; continue; }
    const dhcpM = /DHCP Enabled\.+\s*:\s*(Yes|No)/i.exec(line);
    if (dhcpM) { current.dhcpEnabled = /yes/i.test(dhcpM[1]); continue; }
    const dnsM = /DNS Servers\.+\s*:\s*(.*)$/i.exec(line);
    if (dnsM) { current.dnsServers = dnsM[1].trim(); continue; }
  }
  if (current) adapters.push(current);

  // Filter to only adapters with an IP address
  return adapters.filter(a => a.ipAddress);
}

// Parse `psloggedon \\HOST` output — returns the first interactive user.
function parsePsLoggedOnOutput(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const lines = out.split('\n');
  for (const line of lines) {
    // Look for lines like:  "DOMAIN\user" or "user@domain"
    const m = /([A-Za-z0-9._-]+\\[A-Za-z0-9._-]+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)/.exec(line);
    if (m) {
      // Skip the account running psexec itself (usually the local SYSTEM or the caller)
      const user = m[1];
      if (/^-?\s*$/.test(user)) continue;
      // psloggedon shows both locally-logged-on and remotely-connected users.
      // The first match is usually the interactive logon.
      return user;
    }
  }
  return null;
}

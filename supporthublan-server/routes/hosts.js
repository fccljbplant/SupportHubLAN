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
  // HARDWARE INFO — PsInfo-based, NO PowerShell.
  //
  // Runs three PsTools invocations in parallel:
  //   1. psinfo.exe -d \\\\HOST          → system info + disk volumes
  //   2. psexec.exe \\\\HOST -s ipconfig /all → network adapters
  //   3. psloggedon.exe \\\\HOST         → currently logged-on user
  //
  // All output is plain text — parsed in JavaScript. No PowerShell required.
  // ===========================================================================
  router.post('/:hostname/hardware', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    try {
      const [psinfoRes, ipconfigRes, loggedOnRes] = await Promise.all([
        runPsToolDirect('psinfo.exe', ['-d', '\\\\' + safeHost], 30000),
        runRemoteCmdDirect(safeHost, ['ipconfig', '/all'], 25000),
        runPsToolDirect('psloggedon.exe', ['\\\\' + safeHost], 15000),
      ]);

      if (!psinfoRes.success && !psinfoRes.stdout) {
        return res.json({
          success: false,
          error: psinfoRes.stderr || 'PsInfo failed (host may be offline or PsTools not installed)',
          stderr: psinfoRes.stderr,
        });
      }

      const hw = parsePsInfoOutput(psinfoRes.stdout, safeHost);

      if (ipconfigRes.success || ipconfigRes.stdout) {
        hw.network = parseIpConfigOutput(ipconfigRes.stdout);
      }
      if (!hw.network) hw.network = [];

      if (loggedOnRes.success || loggedOnRes.stdout) {
        hw.loggedInUser = parsePsLoggedOnOutput(loggedOnRes.stdout);
      }

      hw.scannedAt = new Date().toISOString();
      hw.hostname = hw.hostname || safeHost;

      // Hardware change detection (compares with previous snapshot in db.settings)
      const key = 'hardware:' + safeHost;
      let changes = [];
      let isFirstScan = true;
      try {
        const previous = db.settings.get(key, null);
        if (previous) {
          isFirstScan = false;
          let prev;
          try { prev = JSON.parse(previous); } catch { prev = null; }
          if (prev) {
            const getField = (o, p) => p.split('.').reduce((a, k) => (a && a[k] !== undefined) ? a[k] : null, o);
            const compareField = (field) => {
              const oldV = getField(prev, field);
              const newV = getField(hw, field);
              if (oldV && newV && String(oldV) !== String(newV)) {
                changes.push({ field, oldValue: oldV, newValue: newV });
              }
            };
            ['system.manufacturer', 'system.model', 'system.serial',
             'processors.0.name', 'processors.0.cores', 'processors.0.logicalCores',
             'system.totalRamMB', 'system.biosVersion'].forEach(compareField);
            const prevDiskCount = (prev.disks || []).length;
            const newDiskCount = (hw.disks || []).length;
            if (prevDiskCount !== newDiskCount) {
              changes.push({ field: 'diskCount', oldValue: prevDiskCount, newValue: newDiskCount });
            }
          }
        }
      } catch (e) { /* ignore comparison failures */ }

      try { db.settings.set(key, JSON.stringify(hw)); } catch (e) { /* ignore save failures */ }

      res.json({
        success: true,
        data: hw,
        changes,
        isFirstScan,
        rawPsInfo: psinfoRes.stdout ? psinfoRes.stdout.substring(0, 2000) : '',
      });
    } catch (e) {
      res.json({ success: false, error: e.message || 'Hardware scan failed' });
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

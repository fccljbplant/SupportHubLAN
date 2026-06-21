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
  // HARDWARE INFO — Pure PsTools approach using psinfo + psloggedon.
  //
  // PsTools commands used:
  //   1. psinfo.exe -d -h -s -c \\HOST  → system info + disk volumes + hotfixes + software (CSV format)
  //   2. psloggedon.exe \\HOST          → currently logged-on user
  //
  // psinfo flags:
  //   -d  Display disk volume details (drive, format, size, free)
  //   -h  List installed Windows hotfixes
  //   -s  List installed software applications
  //   -c  Output in CSV format (MUCH easier to parse than column-aligned text)
  //
  // CSV format handles commas in values via quoting, so we don't have to guess
  // field boundaries. No wmic, no PowerShell — just native PsTools.
  // ===========================================================================
  router.post('/:hostname/hardware', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    try {
      const [psinfoRes, loggedOnRes] = await Promise.all([
        runPsToolDirect('psinfo.exe', ['-d', '-h', '-s', '-c', '\\\\' + safeHost], 30000),
        runPsToolDirect('psloggedon.exe', ['\\\\' + safeHost], 15000),
      ]);

      if (!psinfoRes.success && !psinfoRes.stdout) {
        return res.json({
          success: false,
          error: psinfoRes.stderr || 'PsInfo failed — host may be offline or PsTools not installed',
          rawOutputs: { psinfoStderr: psinfoRes.stderr || '' },
        });
      }

      // Parse psinfo output into structured hardware object
      const hw = parsePsInfoOutput(psinfoRes.stdout, safeHost);

      // Parse logged-in user
      if (loggedOnRes.success || loggedOnRes.stdout) {
        hw.loggedInUser = parsePsLoggedOnOutput(loggedOnRes.stdout);
      }

      // ========================================================================
      // MERGE LOGIC — don't lose old data if new scan returns empty fields.
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
      } catch (e) {}

      // Check which sections the new scan returned data for
      const newHas = {
        system:       !!(hw.system?.manufacturer || hw.system?.model),
        motherboard:  !!(hw.motherboard?.manufacturer),
        bios:         !!(hw.bios?.manufacturer),
        processor:    !!(hw.processor?.name),
        memory:       !!(hw.memory && hw.memory.length > 0),
        disks:        !!(hw.disks && hw.disks.length > 0),
        logicalDisks: !!(hw.logicalDisks && hw.logicalDisks.length > 0),
        network:      !!(hw.network && hw.network.length > 0),
        gpu:          !!(hw.gpu && hw.gpu.length > 0),
        os:           !!(hw.os?.name),
      };

      let finalHw = hw;
      if (prevHw) {
        finalHw = { ...prevHw };
        finalHw.scannedAt = hw.scannedAt;
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
        if (hw.loggedInUser) finalHw.loggedInUser = hw.loggedInUser;
        // Always update hotfixes and software (psinfo provides these)
        if (hw.hotfixes)  finalHw.hotfixes  = hw.hotfixes;
        if (hw.software)  finalHw.software  = hw.software;
        finalHw.hostname = finalHw.hostname || hw.hostname || safeHost;
      } else {
        finalHw = hw;
      }

      // Hardware change detection
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
           'processor.name', 'system.totalRamMB'].forEach(compareField);
          const prevDiskCount = (prevHw.logicalDisks || []).length;
          const newDiskCount = (finalHw.logicalDisks || []).length;
          if (prevDiskCount !== newDiskCount && newDiskCount > 0) {
            changes.push({ field: 'diskCount', oldValue: prevDiskCount, newValue: newDiskCount });
          }
        } catch (e) {}
      }

      try { db.settings.set(key, JSON.stringify(finalHw)); } catch (e) {}

      const rawOutputs = {
        psinfo: psinfoRes.stdout ? psinfoRes.stdout.substring(0, 2000) : '',
        psinfoStderr: psinfoRes.stderr ? psinfoRes.stderr.substring(0, 500) : '',
      };

      res.json({
        success: true,
        data: finalHw,
        changes,
        isFirstScan,
        partialScan: Object.values(newHas).filter(Boolean).length < 3,
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

// ---------------------------------------------------------------------------
// parsePsInfoOutput — parse `psinfo -d -h -s -c \\HOST` CSV output into a
// structured hardware object.
//
// With the -c flag, PsInfo outputs CSV format. Fields containing commas
// (like "Windows 10 Enterprise, Multipoint Free") are quoted.
//
// CSV output structure (sections separated by blank lines):
//
//   PsInfo v1.79 - Local and remote system information viewer
//   Copyright (C) 2001-2023 Mark Russinovich
//   Sysinternals - www.sysinternals.com
//
//   Field,Value
//   "System information for","\\DESKTOP-TFF7VU4"
//   "Uptime","0 days 5 hours 9 minutes 31 seconds"
//   "Kernel version","Windows 10 Enterprise, Multipoint Free"
//   "Product type","Professional"
//   ...
//   "Processors","8"
//   "Processor speed","2.1 GHz"
//   "Processor type","Intel(R) Core(TM) i7-8650U CPU @"
//   "Physical memory","3940 MB"
//   "Video driver","Intel(R) UHD Graphics 620"
//
//   Volume,Type,Format,Label,Size,Free,Free%
//   "C:","Fixed","NTFS","Windows","199.79 GB","68.52 GB","34.3%"
//   "D:","Fixed","NTFS","","276.93 GB","196.72 GB","71.0%"
//
//   Hotfix
//   KB5031356
//
//   Application
//   Adobe Refresh Manager 1.8.0
//   CADReader v3.7.4.21
// ---------------------------------------------------------------------------

// Helper: parse a single CSV line, handling quoted fields with commas.
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result.map(s => s.trim());
}

function parsePsInfoOutput(raw, fallbackHost) {
  const out = (raw || '').replace(/\r/g, '');
  const lines = out.split('\n');

  const kv = {};        // key-value pairs from the "Field,Value" section
  const logicalDisks = []; // volume entries
  const hotfixes = [];     // KB numbers
  const software = [];     // application names

  // State machine: track which CSV section we're in
  let section = 'header'; // 'header' | 'kv' | 'volumes' | 'hotfixes' | 'software'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and PsInfo banner
    if (!trimmed) { continue; }
    if (/^PsInfo v/i.test(trimmed)) { continue; }
    if (/^Copyright/i.test(trimmed)) { continue; }
    if (/^Sysinternals/i.test(trimmed)) { continue; }

    // Detect section transitions
    // Key-value section: header row "Field,Value"
    if (/^Field\s*,\s*Value/i.test(line)) { section = 'kv'; continue; }
    // Volume section: header row "Volume,Type,Format,..."
    if (/^Volume\s*,\s*Type\s*,\s*Format/i.test(line)) { section = 'volumes'; continue; }
    // Hotfix section: header "Hotfix" or "Installed,HotFix"
    if (/^Hotfix\s*$/i.test(trimmed) || /^Installed\s*,?\s*HotFix/i.test(line)) { section = 'hotfixes'; continue; }
    // Software section: header "Application" or "Applications:"
    if (/^Application/i.test(trimmed) && !/,/.test(line)) { section = 'software'; continue; }

    // Parse line based on current section
    if (section === 'kv') {
      const fields = parseCsvLine(line);
      if (fields.length >= 2 && fields[0]) {
        const key = fields[0].toLowerCase();
        const val = fields[1] || '';
        if (val && !(key in kv)) kv[key] = val;
      }
    } else if (section === 'volumes') {
      const fields = parseCsvLine(line);
      // Expected: Volume, Type, Format, Label, Size, Free, Free%
      if (fields.length >= 6 && /^[A-Z]:/i.test(fields[0])) {
        const sizeMatch = /([\d.]+)\s*(GB|MB|TB)/i.exec(fields[4] || '');
        const freeMatch = /([\d.]+)\s*(GB|MB|TB)/i.exec(fields[5] || '');
        let sizeGB = 0, freeGB = 0;
        if (sizeMatch) {
          const n = parseFloat(sizeMatch[1]);
          const u = sizeMatch[2].toUpperCase();
          sizeGB = u === 'TB' ? n * 1024 : n;
        }
        if (freeMatch) {
          const n = parseFloat(freeMatch[1]);
          const u = freeMatch[2].toUpperCase();
          freeGB = u === 'TB' ? n * 1024 : n;
        }
        logicalDisks.push({
          drive: fields[0],
          sizeGB: Math.round(sizeGB * 100) / 100,
          freeGB: Math.round(freeGB * 100) / 100,
          fileSystem: fields[2] || '',
          volumeName: fields[3] || '',
        });
      }
    } else if (section === 'hotfixes') {
      // Each line is a KB number (or "n/a,Description" for some entries)
      const kbMatches = trimmed.match(/KB\d+/gi);
      if (kbMatches) {
        kbMatches.forEach(kb => hotfixes.push(kb.toUpperCase()));
      }
    } else if (section === 'software') {
      // Each line is an application name (possibly CSV with extra fields)
      const fields = parseCsvLine(line);
      const name = fields[0] || trimmed;
      if (name) software.push({ name });
    }
  }

  // Extract hostname from "System information for" value
  let hostname = fallbackHost;
  const sysInfo = kv['system information for'] || '';
  const hostMatch = /\\+([^\s,]+)/.exec(sysInfo);
  if (hostMatch) hostname = hostMatch[1];

  // Parse processor speed (e.g. "2.1 GHz")
  const procSpeed = kv['processor speed'] || '';
  const speedMatch = /([\d.]+)\s*GHz/i.exec(procSpeed);
  const maxSpeedMHz = speedMatch ? Math.round(parseFloat(speedMatch[1]) * 1000) : 0;

  // Parse total RAM (e.g. "3940 MB")
  const ramMatch = /(\d+)\s*(MB|GB|TB)/i.exec(kv['physical memory'] || '');
  let totalRamMB = 0;
  if (ramMatch) {
    const n = parseInt(ramMatch[1], 10);
    const u = ramMatch[2].toUpperCase();
    totalRamMB = u === 'GB' ? n * 1024 : u === 'TB' ? n * 1024 * 1024 : n;
  }

  // "Processors" = thread count (logical processors)
  const processorCount = parseInt(kv['processors'] || '0', 10);

  // Determine CPU manufacturer from processor type name
  const procName = kv['processor type'] || '';
  let cpuManufacturer = '';
  if (/Intel/i.test(procName)) cpuManufacturer = 'Intel';
  else if (/AMD|Advanced Micro/i.test(procName)) cpuManufacturer = 'AMD';

  // Build GPU array from video driver field
  const gpu = [];
  if (kv['video driver']) {
    kv['video driver'].split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(name => {
      gpu.push({ name, manufacturer: '', ramMB: 0, driverVersion: '', driverDate: '' });
    });
  }

  return {
    hostname,
    scannedAt: new Date().toISOString(),

    system: {
      manufacturer: kv['system manufacturer'] || '',
      model: kv['system model'] || '',
      serial: '',
      systemType: kv['system type'] || '',
      domain: '',
      totalRamMB,
    },

    motherboard: {},
    bios: {},

    processor: procName ? {
      name: procName,
      manufacturer: cpuManufacturer,
      cores: 0,
      threads: processorCount,
      maxSpeedMHz,
      currentSpeedMHz: maxSpeedMHz,
      socket: '',
      socketCount: 1,
    } : null,

    memory: [],
    disks: [],
    logicalDisks,
    network: [],
    gpu,

    os: {
      name: kv['kernel version'] || '',
      version: kv['product version'] || '',
      build: kv['kernel build number'] || '',
      architecture: '',
      installDate: kv['installation date'] || '',
      lastBoot: '',
      serial: '',
      registeredOrg: kv['registered organization'] || '',
      registeredUser: kv['registered owner'] || '',
    },

    hotfixes,
    software,
    loggedInUser: null,
    _source: 'psinfo-csv+psloggedon',
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

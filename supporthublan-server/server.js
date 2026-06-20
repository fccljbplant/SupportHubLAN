/* ==========================================================================
   SupportHubLAN Backend Server v1.4.7
   ==========================================================================
   This server runs on a Windows machine with admin privileges and performs
   REAL Windows administration tasks on remote hosts via:
   - PsTools suite (PsExec/PsInfo/PsList/PsKill/PsService/PsLoggedOn/PsFile/PsGetSid/PsSuspend/PsShutdown)
   - Active Directory queries (Get-ADComputer, ms-Mcs-AdmPwd for LAPS)
   - Windows Update operations (PSWindowsUpdate module)
   - Real ping sweeps (Test-Connection runspace pool)
   - Wake-on-LAN (UDP magic packet broadcast)
   - VNC/RDP viewer launch (child_process.spawn)
   - Job Queue execution with WebSocket live progress

   ARCHITECTURE
   ------------
   This server serves BOTH the API (/api/*) AND the static frontend (/
   returns ../supporthublan.html). Single port = single firewall rule.
   The frontend auto-detects it's being served by the backend and switches
   from DEMO mode to LIVE mode automatically.

   PREREQUISITES
   -------------
   1. Windows 10/11 or Server 2019+ (PsTools is Windows-only)
   2. Node.js 18 LTS or newer — https://nodejs.org/
   3. PowerShell 5.1+ (built into Windows)
   4. PsTools suite extracted to C:\PSTools\ — https://learn.microsoft.com/sysinternals/downloads/pstools
   5. PSWindowsUpdate module (optional, for Windows Updates):
        Install-Module PSWindowsUpdate -Force -AllowClobber
   6. ActiveDirectory module (optional, for AD import + LAPS):
        Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0
   7. Network access to target hosts: TCP 445 (SMB), TCP 135 (RPC), UDP 137-138 (NetBIOS)
   8. Local admin rights on target hosts (or domain admin)

   STARTUP
   -------
   npm install
   npm start
   → Server runs on http://localhost:8080 (or PORT from .env)
   → Browser auto-opens to the frontend

   CONFIGURATION (.env)
   --------------------
   PORT=8080                          # Backend listen port
   PSTOOLS_PATH=C:\\PSTools\\          # Path to PsTools folder
   ADMIN_USER=admin                   # Optional Basic Auth username
   ADMIN_PASS=changeme                # Optional Basic Auth password (leave blank to disable)
   ALLOWED_ORIGINS=*                  # CORS origins (use specific origins in production)
   AUTO_OPEN_BROWSER=true             # Auto-open browser on startup
   BIND_ADDRESS=0.0.0.0               # Bind address (use 127.0.0.1 to restrict to localhost)
   ========================================================================== */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

// ---- SQLite + AES-256 encrypted credential storage ----
const db = require('./db');

// ---- Load .env (manual parser — no dotenv dependency needed) ----
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || '8080', 10);
const PSTOOLS_PATH = process.env.PSTOOLS_PATH || 'C:\\PSTools\\';
const BIND_ADDRESS = process.env.BIND_ADDRESS || '0.0.0.0';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const AUTO_OPEN = (process.env.AUTO_OPEN_BROWSER || 'true').toLowerCase() === 'true';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

// ---- Middleware ----
app.use(cors({ origin: ALLOWED_ORIGINS === '*' ? true : ALLOWED_ORIGINS.split(',') }));
app.use(bodyParser.json({ limit: '50mb' }));

// ---- Optional Basic Auth (only enabled if ADMIN_USER + ADMIN_PASS set) ----
if (ADMIN_USER && ADMIN_PASS) {
  app.use((req, res, next) => {
    // Skip auth for WebSocket upgrade requests and static frontend assets from same origin
    if (req.path === '/ws' || req.path === '/' || req.path.startsWith('/vendor/') || req.path.endsWith('.html')) {
      return next();
    }
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="SupportHubLAN"');
      return res.status(401).send('Authentication required');
    }
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="SupportHubLAN"');
    return res.status(401).send('Invalid credentials');
  });
}

// ---- Static frontend: serve ../supporthublan.html and /vendor/* ----
const FRONTEND_PATH = path.join(__dirname, '..', 'supporthublan.html');
const VENDOR_PATH = path.join(__dirname, '..', 'vendor');

app.use('/vendor', express.static(VENDOR_PATH, { maxAge: '1d' }));

app.get('/', (req, res) => {
  if (fs.existsSync(FRONTEND_PATH)) {
    res.sendFile(FRONTEND_PATH);
  } else {
    res.status(404).send('Frontend file not found. Expected: ' + FRONTEND_PATH);
  }
});

app.get('/supporthublan.html', (req, res) => {
  if (fs.existsSync(FRONTEND_PATH)) res.sendFile(FRONTEND_PATH);
  else res.status(404).send('Not found');
});

// ---- Credential Store (in-memory; for production use Windows Credential Manager) ----
let credentialStore = {};

// ---- Helper: Execute PowerShell command and return result ----
function runPowerShell(script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { timeout: timeoutMs, windowsHide: true });

    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => stdout += d.toString());
    ps.stderr.on('data', (d) => stderr += d.toString());
    ps.on('close', (code) => {
      resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
    });
    ps.on('error', (err) => {
      resolve({ success: false, stdout: '', stderr: err.message, exitCode: -1 });
    });
  });
}

// ---- Helper: Build credential block for PowerShell ----
function buildCredentialBlock(credential) {
  if (!credential || !credential.username) return '';
  return `
    $secPassword = ConvertTo-SecureString '${(credential.password || '').replace(/'/g, "''")}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${credential.username.replace(/'/g, "''")}', $secPassword)
  `;
}

// ---- Helper: Standard response wrapper ----
function sendResult(res, result) {
  res.json({ success: result.success, data: result.data, error: result.error, stdout: result.stdout, stderr: result.stderr });
}

// ---- Helper: Validate hostname/IP (prevent injection) ----
function sanitizeHost(h) {
  return String(h).replace(/[^a-zA-Z0-9._\-:]/g, '');
}

// ==========================================================================
// HEALTH CHECK — Used by frontend to detect LIVE vs DEMO mode
// ==========================================================================
app.get('/api/health', (req, res) => {
  const pstoolsInstalled = fs.existsSync(path.join(PSTOOLS_PATH, 'psexec.exe'));
  const psWindowsUpdateAvailable = true; // Checked at runtime
  res.json({
    success: true,
    data: {
      server: 'SupportHubLAN Backend',
      version: '1.4.7',
      platform: os.platform(),
      hostname: os.hostname(),
      port: PORT,
      uptime: process.uptime(),
      pstoolsPath: PSTOOLS_PATH,
      pstoolsInstalled,
      endpoints: [
        'GET  /api/health',
        'POST /api/credentials',
        'POST /api/hosts/discover-ad',
        'POST /api/hosts/:hostname/info',
        'POST /api/hosts/:hostname/ping',
        'POST /api/scan',
        'POST /api/updates/scan',
        'POST /api/updates/download',
        'POST /api/updates/install',
        'POST /api/updates/history',
        'POST /api/scripts/execute',
        'POST /api/services/:hostname/list',
        'POST /api/services/:hostname/action',
        'POST /api/processes/:hostname/list',
        'POST /api/processes/:hostname/kill',
        'POST /api/power/action',
        'POST /api/power/wol',
        'POST /api/laps/retrieve',
        'POST /api/laps/rotate',
        'POST /api/deploy/package',
        'POST /api/queues/execute',
        'POST /api/pstools/execute',
        'POST /api/pstools/psinfo',
        'POST /api/pstools/pslist',
        'POST /api/pstools/pskill',
        'POST /api/pstools/psservice',
        'POST /api/pstools/psloggedon',
        'POST /api/pstools/psshutdown',
        'POST /api/pstools/psfile',
        'POST /api/pstools/psgetsid',
        'POST /api/pstools/pssuspend',
        'POST /api/remote/connect',
        'WS   /ws'
      ]
    }
  });
});

// ==========================================================================
// INVENTORIES — Multi-inventory management (SQLite-backed)
// Each inventory = one tab in the UI
// ==========================================================================
app.get('/api/inventories', (req, res) => {
  res.json({ success: true, data: db.inventories.list() });
});

app.post('/api/inventories', (req, res) => {
  const { name, description, color } = req.body;
  if (!name) return res.json({ success: false, error: 'name required' });
  const r = db.inventories.create(name, description, color);
  if (r.success) db.audit.add({ action: 'inventory.create', category: 'Inventory', result: 'success', parameters: { name, description } });
  res.json(r);
});

app.put('/api/inventories/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description, color } = req.body;
  const r = db.inventories.rename(id, name, description || '');
  if (color && db.db) db.db.prepare('UPDATE inventories SET color = ? WHERE id = ?').run(color, id);
  else if (color && db.USE_JSON_FALLBACK) {
    const inv = db.inventories.get(id);
    if (inv) { inv.color = color; }
  }
  res.json(r);
});

app.post('/api/inventories/:id/activate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.inventories.setActive(id);
  db.audit.add({ action: 'inventory.activate', category: 'Inventory', result: 'success', parameters: { id } });
  res.json({ success: true });
});

app.delete('/api/inventories/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Prevent deleting the last inventory
  if (db.inventories.list().length <= 1) {
    return res.json({ success: false, error: 'Cannot delete the last inventory' });
  }
  const r = db.inventories.delete(id);
  if (r.success) db.audit.add({ action: 'inventory.delete', category: 'Inventory', result: 'success', parameters: { id } });
  res.json(r);
});

// ==========================================================================
// HOSTS — CRUD against SQLite (per inventory)
// ==========================================================================
app.get('/api/inventories/:id/hosts', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json({ success: true, data: db.hosts.list(id) });
});

app.post('/api/inventories/:id/hosts', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { host } = req.body;
  if (!host || !host.hostname) return res.json({ success: false, error: 'host.hostname required' });
  const r = db.hosts.upsert(id, host);
  if (r.success) db.audit.add({ action: 'hosts.upsert', category: 'Inventory', targetType: 'Host', result: 'success', parameters: { hostname: host.hostname, inventoryId: id } });
  res.json(r);
});

app.post('/api/inventories/:id/hosts/bulk', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { hosts: hostList } = req.body;
  if (!Array.isArray(hostList)) return res.json({ success: false, error: 'hosts array required' });
  const r = db.hosts.bulkUpsert(id, hostList);
  db.audit.add({ action: 'hosts.bulk-import', category: 'Inventory', targetType: 'Host', result: 'success', parameters: { count: hostList.length, inventoryId: id, ...r } });
  res.json(r);
});

app.put('/api/hosts/:hostId', (req, res) => {
  const hostId = parseInt(req.params.hostId, 10);
  const r = db.hosts.update(hostId, req.body);
  res.json(r);
});

app.delete('/api/hosts/:hostId', (req, res) => {
  const hostId = parseInt(req.params.hostId, 10);
  db.hosts.delete(hostId);
  db.audit.add({ action: 'hosts.delete', category: 'Inventory', targetType: 'Host', result: 'success', parameters: { hostId } });
  res.json({ success: true });
});

app.delete('/api/inventories/:id/hosts', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.hosts.deleteAll(id);
  db.audit.add({ action: 'hosts.clear-all', category: 'Inventory', result: 'success', parameters: { inventoryId: id } });
  res.json({ success: true });
});

// ==========================================================================
// CREDENTIALS — Encrypted at rest (AES-256-GCM via db.js)
// ==========================================================================
app.get('/api/credentials', (req, res) => {
  const { inventoryId } = req.query;
  res.json({ success: true, data: db.credentials.list(inventoryId ? parseInt(inventoryId, 10) : null) });
});

app.post('/api/credentials', (req, res) => {
  const { inventoryId, name, username, password, domain, type } = req.body;
  if (!name || !username || !password) return res.json({ success: false, error: 'name, username, password required' });
  const r = db.credentials.create(inventoryId || null, name, username, password, domain, type);
  if (r.success) db.audit.add({ action: 'credentials.create', category: 'Security', result: 'success', parameters: { name, username, domain } });
  res.json(r);
});

app.get('/api/credentials/:id', (req, res) => {
  // Returns the decrypted password — only the API can read this, not the browser
  const id = parseInt(req.params.id, 10);
  const cred = db.credentials.get(id);
  if (!cred) return res.json({ success: false, error: 'not found' });
  res.json({ success: true, data: cred });
});

app.delete('/api/credentials/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.credentials.delete(id);
  db.audit.add({ action: 'credentials.delete', category: 'Security', result: 'success', parameters: { id } });
  res.json({ success: true });
});

// ==========================================================================
// AUDIT LOG — Persistent in SQLite
// ==========================================================================
app.get('/api/audit', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json({ success: true, data: db.audit.list(limit, offset) });
});

app.get('/api/audit/search', (req, res) => {
  const q = req.query.q || '';
  res.json({ success: true, data: db.audit.search(q) });
});

app.post('/api/audit/clear', (req, res) => {
  const { olderThanDays } = req.body;
  db.audit.clear(olderThanDays || null);
  res.json({ success: true });
});

app.post('/api/audit', (req, res) => {
  // Allow frontend to write audit entries (e.g. for UI-only actions)
  db.audit.add(req.body);
  res.json({ success: true });
});

// ==========================================================================
// SETTINGS — Persistent key/value store
// ==========================================================================
app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: db.settings.getAll() });
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.json({ success: false, error: 'key required' });
  db.settings.set(key, value);
  res.json({ success: true });
});

// ==========================================================================
// JOBS — Persistent job history
// ==========================================================================
app.get('/api/jobs', (req, res) => {
  res.json({ success: true, data: db.jobs.list(100) });
});

// ==========================================================================
// CREDENTIALS (legacy in-memory store — kept for backward compat)
// ==========================================================================
app.post('/api/credentials/legacy', (req, res) => {
  const { name, username, password, domain } = req.body;
  credentialStore[name] = { username, password, domain };
  res.json({ success: true, data: { name, username } });
});

// ==========================================================================
// ACTIVE DIRECTORY IMPORT — Discover computers from AD OU
// ==========================================================================
app.post('/api/hosts/discover-ad', async (req, res) => {
  const { ouPath, searchScope, filter, nameAttr } = req.body;
  const script = `
    Import-Module ActiveDirectory -ErrorAction SilentlyContinue
    $searchBase = '${(ouPath || 'OU=Computers,DC=corp,DC=local').replace(/'/g, "''")}'
    $scope = '${(searchScope || 'subtree').replace(/'/g, "''")}'
    $filter = '${(filter || 'objectCategory=computer').replace(/'/g, "''")}'
    $nameAttr = '${(nameAttr || 'cn').replace(/'/g, "''")}'
    try {
      $computers = Get-ADComputer -Filter $filter -SearchBase $searchBase -SearchScope $scope -Properties Name, DNSHostName, IPAddress, OperatingSystem
      $results = $computers | Select-Object @{N='name';E={$_.$nameAttr}}, @{N='fqdn';E={$_.DNSHostName}}, @{N='ip';E={$_.IPAddress}}, @{N='os';E={$_.OperatingSystem}} | ConvertTo-Json -Compress
      $results
    } catch {
      @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, hosts: result.stdout, error: result.stderr });
});

// ==========================================================================
// HOST OPERATIONS — Real system queries to remote hosts
// ==========================================================================
app.post('/api/hosts/:hostname/info', async (req, res) => {
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

      $result = @{
        hostname = $os.CSName
        osName = $os.Caption
        osVersion = $os.Version
        osBuild = $os.BuildNumber
        cpuModel = $cpu.Name
        ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
        diskUsedGb = [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1)
        diskFreeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
        uptime = "$([math]::Floor($uptime.TotalDays))d $([math]::Floor($uptime.Hours))h"
        lastBootTime = $os.LastBootUpTime
        onlineStatus = 'online'
      }
      $result | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${safeHost}'; onlineStatus = 'offline'; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;

  const result = await runPowerShell(script, 30000);
  try {
    const data = JSON.parse(result.stdout);
    sendResult(res, { success: true, data, stdout: result.stdout });
  } catch (e) {
    sendResult(res, { success: false, error: 'Failed to parse system query output', stderr: result.stderr || result.stdout });
  }
});

app.post('/api/hosts/:hostname/ping', async (req, res) => {
  const { hostname } = req.params;
  const safeHost = sanitizeHost(hostname);
  const script = `
    try {
      $ping = Test-Connection -ComputerName '${safeHost}' -Count 1 -Quiet -ErrorAction SilentlyContinue
      @{ hostname = '${safeHost}'; online = $ping; status = if ($ping) { 'up' } else { 'down' } } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${safeHost}'; online = $false; status = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 10000);
  try {
    const data = JSON.parse(result.stdout);
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: result.stderr || 'Ping failed' });
  }
});

app.post('/api/hosts/:hostname/refresh', async (req, res) => {
  req.url = `/api/hosts/${req.params.hostname}/info`;
  app.handle(req, res);
});

// ==========================================================================
// NETWORK SCANNER — Real parallel ping sweep (replaces Math.random fallback)
// ==========================================================================
app.post('/api/scan', async (req, res) => {
  const { ips } = req.body;
  if (!Array.isArray(ips) || ips.length === 0) {
    return res.json({ success: false, error: 'ips array required' });
  }
  const safeIps = ips.map(sanitizeHost).filter(Boolean).slice(0, 1024); // Cap at 1024 per scan
  const jobScanId = 'scan-' + Date.now();

  // Respond immediately with job ID, then run async + broadcast progress
  res.json({ success: true, data: { jobId: jobScanId, total: safeIps.length } });

  // Run ping sweep using runspace pool for parallelism
  const ipsBlock = safeIps.map(ip => `'${ip}'`).join(',');
  const script = `
    $ips = @(${ipsBlock})
    $pool = [RunspaceFactory]::CreateRunspacePool(1, [Math]::Min(50, $ips.Count))
    $pool.Open()
    $scriptBlock = {
      param($ip)
      $ping = Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue
      return @{ ip = $ip; online = $ping }
    }
    $jobs = $ips | ForEach-Object {
      $ps = [PowerShell]::Create().AddScript($scriptBlock).AddArgument($_)
      $ps.RunspacePool = $pool
      @{ handle = $ps; async = $ps.BeginInvoke() }
    }
    $results = @()
    foreach ($j in $jobs) {
      $results += $j.handle.EndInvoke($j.async)
    }
    $pool.Close()
    $pool.Dispose()
    $results | ConvertTo-Json -Compress
  `;
  const result = await runPowerShell(script, 120000);
  let online = 0, offline = 0;
  try {
    const parsed = JSON.parse(result.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    arr.forEach(r => { if (r.online) online++; else offline++; });
    broadcastUpdate({
      type: 'scan-complete',
      jobId: jobScanId,
      results: arr,
      summary: { total: safeIps.length, online, offline }
    });
  } catch (e) {
    broadcastUpdate({ type: 'scan-error', jobId: jobScanId, error: result.stderr || 'Parse failed' });
  }
});

// ==========================================================================
// WINDOWS UPDATES — Real scan/download/install via PSWindowsUpdate module
// ==========================================================================
app.post('/api/updates/scan', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const credParam = credential ? '-Credential $cred' : '';
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $updates = Get-WindowsUpdate -ComputerName $h ${credParam} -ErrorAction Stop
        $results += @{
          hostname = $h
          status = 'scanned'
          updateCount = $updates.Count
          critical = ($updates | Where-Object { $_.MsrcSeverity -eq 'Critical' }).Count
          security = ($updates | Where-Object { $_.MsrcSeverity -eq 'Important' }).Count
          updates = $updates | Select-Object KB, Title, Size, MsrcSeverity, Category | ConvertTo-Json
        }
      } catch {
        $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 5 -Compress
  `;
  const result = await runPowerShell(script, 120000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/updates/download', async (req, res) => {
  const { hostnames, credential, kbFilter } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const credParam = credential ? '-Credential $cred' : '';
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        ${kbFilter ? `$updates = Get-WindowsUpdate -ComputerName $h ${credParam} -KBArticleID '${sanitizeHost(kbFilter)}' -Download -ErrorAction Stop` : `Get-WindowsUpdate -ComputerName $h ${credParam} -Download -AcceptAll -ErrorAction Stop`}
        $results += @{ hostname = $h; status = 'downloaded' }
      } catch {
        $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;
  const result = await runPowerShell(script, 300000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/updates/install', async (req, res) => {
  const { hostnames, credential, kbFilter, classification, rebootBehavior } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const credParam = credential ? '-Credential $cred' : '';
  const rebootParam = rebootBehavior === 'always' || rebootBehavior === 'if-required' ? '-AutoReboot' : '';
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $params = @{ ComputerName = $h; Install = $true; AcceptAll = $true ${rebootParam ? '; ' + rebootParam : ''} }
        ${credential ? '$params.Credential = $cred' : ''}
        ${kbFilter ? "$params.KBArticleID = '${sanitizeHost(kbFilter)}'" : ''}
        ${classification ? "$params.Category = '${sanitizeHost(classification)}'" : ''}
        Install-WindowsUpdate @params -ErrorAction Stop
        $results += @{ hostname = $h; status = 'installed'; rebootRequired = $false }
      } catch {
        $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;
  const result = await runPowerShell(script, 600000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/updates/history', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $history = Get-WUHistory -ComputerName $h ${credential ? '-Credential $cred' : ''} -ErrorAction Stop
        $results += @{ hostname = $h; updates = $history | Select-Object KB, Title, Date, Result | ConvertTo-Json }
      } catch {
        $results += @{ hostname = $h; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 4 -Compress
  `;
  const result = await runPowerShell(script, 60000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// SCRIPTS & COMMANDS — Real remote execution
// ==========================================================================
app.post('/api/scripts/execute', async (req, res) => {
  const { hostnames, script: userScript, credential, language, timeout } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const timeoutSec = timeout || 60;
  const psScript = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $params = @{ ComputerName = $h; ScriptBlock = { ${userScript} }; ErrorAction = 'Stop' }
        ${credential ? '$params.Credential = $cred' : ''}
        $output = Invoke-Command @params
        $results += @{ hostname = $h; success = $true; output = ($output | Out-String) }
      } catch {
        $results += @{ hostname = $h; success = $false; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 4 -Compress
  `;
  const result = await runPowerShell(psScript, timeoutSec * 1000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// SERVICES & PROCESSES
// ==========================================================================
app.post('/api/services/:hostname/list', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      Get-CimInstance Win32_Service @params | Select-Object Name, DisplayName, State, StartMode, StartName | ConvertTo-Json -Compress
    } catch {
      @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/services/:hostname/action', async (req, res) => {
  const { hostname } = req.params;
  const { serviceName, action, credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeService = sanitizeHost(serviceName);
  const credBlock = credential ? buildCredentialBlock(credential) : '';
  const credParam = credential ? '-Credential $cred' : '';
  const script = `
    ${credBlock}
    try {
      switch ('${action}') {
        'start'   { Start-Service   -ComputerName '${safeHost}' -Name '${safeService}' ${credParam}; $newState = 'Running' }
        'stop'    { Stop-Service    -ComputerName '${safeHost}' -Name '${safeService}' -Force ${credParam}; $newState = 'Stopped' }
        'restart' { Restart-Service -ComputerName '${safeHost}' -Name '${safeService}' -Force ${credParam}; $newState = 'Running' }
        default   { throw "Unknown action: ${action}" }
      }
      @{ hostname = '${safeHost}'; service = '${safeService}'; state = $newState; success = $true } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${safeHost}'; service = '${safeService}'; success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/processes/:hostname/list', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      Get-CimInstance Win32_Process @params | Select-Object ProcessId, Name, @{N='MemMB';E={[math]::Round($_.WorkingSetSize/1MB,1)}}, @{N='CPU';E={$_.UserModeTime/1e7}} | ConvertTo-Json -Compress
    } catch {
      @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/processes/:hostname/kill', async (req, res) => {
  const { hostname } = req.params;
  const { pid, name, credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safePid = parseInt(pid, 10);
  if (!safePid) return res.json({ success: false, error: 'Invalid PID' });
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      Invoke-Command -ComputerName '${safeHost}' ${credential ? '-Credential $cred' : ''} -ScriptBlock { Stop-Process -Id ${safePid} -Force } -ErrorAction Stop
      @{ hostname = '${safeHost}'; pid = ${safePid}; killed = $true } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${safeHost}'; pid = ${safePid}; killed = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// POWER MANAGEMENT — Restart / Stop / Wake-on-LAN
// ==========================================================================
app.post('/api/power/action', async (req, res) => {
  const { hostname, action, credential, message, timeout } = req.body;
  const safeHost = sanitizeHost(hostname);
  const credBlock = credential ? buildCredentialBlock(credential) : '';
  const credParam = credential ? '-Credential $cred' : '';
  const msgParam = message ? `-Force` : `-Force`;
  const script = `
    ${credBlock}
    try {
      switch ('${action}') {
        'reboot'   { Restart-Computer -ComputerName '${safeHost}' ${credParam} ${msgParam} ${message ? `-Comment "${message.replace(/"/g, '`"')}"` : ''} -ErrorAction Stop }
        'shutdown' { Stop-Computer -ComputerName '${safeHost}' ${credParam} -Force -ErrorAction Stop }
        'startup'  { throw 'Cannot power on via PowerShell — use Wake-on-LAN /api/power/wol endpoint' }
        default    { throw "Unknown action: ${action}" }
      }
      @{ hostname = '${safeHost}'; action = '${action}'; success = $true } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${safeHost}'; action = '${action}'; success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 20000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/power/wol', async (req, res) => {
  const { mac } = req.body;
  if (!mac || !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    return res.json({ success: false, error: 'Invalid MAC address. Format: AA:BB:CC:DD:EE:FF' });
  }
  // Build magic packet: 6 bytes of 0xFF + 16 repetitions of MAC
  const macParts = mac.split(/[:-]/).map(h => parseInt(h, 16));
  const magic = Buffer.alloc(102);
  magic.fill(0xFF, 0, 6);
  for (let i = 6; i < 102; i += 6) {
    for (let j = 0; j < 6; j++) magic[i + j] = macParts[j];
  }
  // Broadcast on UDP port 9 (discard) — most NICs respond to this
  const sock = require('dgram').createSocket('udp4');
  sock.bind(() => {
    sock.setBroadcast(true);
    sock.send(magic, 9, '255.255.255.255', (err) => {
      sock.close();
      res.json({ success: !err, data: { mac, sent: !err }, error: err ? err.message : null });
    });
  });
});

// ==========================================================================
// LAPS — Retrieve / Rotate Local Admin Passwords (NEW — was missing)
// ==========================================================================
app.post('/api/laps/retrieve', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module ActiveDirectory -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $computer = Get-ADComputer -Identity $h -Properties ms-Mcs-AdmPwd, ms-Mcs-AdmPwdExpirationTime, DNSHostName -ErrorAction Stop
        $results += @{
          hostname = $h
          password = $computer.'ms-Mcs-AdmPwd'
          expirationTime = if ($computer.'ms-Mcs-AdmPwdExpirationTime') { [DateTime]::FromFileTimeUtc([long]$computer.'ms-Mcs-AdmPwdExpirationTime') } else { $null }
          success = $true
        }
      } catch {
        $results += @{ hostname = $h; success = $false; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 4 -Compress
  `;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/laps/rotate', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  // Reset-AdmPwdPassword comes from the LAPS PowerShell module (or AdmPwd.PS legacy)
  // For modern Windows LAPS (Server 2022+/Win 11+), use Reset-LapsPassword
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module ActiveDirectory -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        # Try modern LAPS first (Windows 11 22H2+, Server 2022+)
        try {
          Invoke-Command -ComputerName $h ${credential ? '-Credential $cred' : ''} -ScriptBlock { Reset-LapsPassword } -ErrorAction Stop
          $results += @{ hostname = $h; rotated = $true; method = 'modern' }
        } catch {
          # Fall back to legacy LAPS — set the expiration time to now
          Set-ADComputer -Identity $h -Replace @{'ms-Mcs-AdmPwdExpirationTime' = '0'} -ErrorAction Stop
          $results += @{ hostname = $h; rotated = $true; method = 'legacy' }
        }
      } catch {
        $results += @{ hostname = $h; rotated = $false; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 4 -Compress
  `;
  const result = await runPowerShell(script, 60000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// SOFTWARE DEPLOYMENT
// ==========================================================================
app.post('/api/deploy/package', async (req, res) => {
  const { hostnames, packagePath, arguments: args, credential, rebootBehavior } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const safePath = (packagePath || '').replace(/"/g, '`"').replace(/'/g, "''");
  const safeArgs = (args || '').replace(/"/g, '`"').replace(/'/g, "''");
  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        # Copy package to remote host
        $remotePath = "\\\\$h\\C$\\Temp\\$(Split-Path '${safePath}' -Leaf)"
        Copy-Item '${safePath}' $remotePath -Force -ErrorAction Stop
        # Execute remotely
        $cmd = "& \\"C:\\Temp\\$(Split-Path '${safePath}' -Leaf)\\" ${safeArgs}"
        $output = Invoke-Command -ComputerName $h ${credential ? '-Credential $cred' : ''} -ScriptBlock { param($c) Invoke-Expression $c } -ArgumentList $cmd -ErrorAction Stop
        $results += @{ hostname = $h; success = $true; output = ($output | Out-String) }
        ${rebootBehavior === 'always' ? `Restart-Computer -ComputerName $h ${credential ? '-Credential $cred' : ''} -Force` : ''}
      } catch {
        $results += @{ hostname = $h; success = $false; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 4 -Compress
  `;
  const result = await runPowerShell(script, 300000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// JOB QUEUE EXECUTION — Real sequential step execution + WebSocket progress
// ==========================================================================
app.post('/api/queues/execute', async (req, res) => {
  const { steps, hostnames, credential, errorHandling, queueName } = req.body;
  const jobId = 'job-' + Date.now();
  const credBlock = credential ? buildCredentialBlock(credential) : '';
  const credParam = credential ? '-Credential $cred' : '';

  // Respond immediately with job ID
  res.json({ success: true, data: { jobId, status: 'running', stepCount: steps.length, hostCount: hostnames.length, queueName: queueName || 'Untitled Queue' } });

  // Execute async + broadcast progress
  (async () => {
    let totalSteps = steps.length * hostnames.length;
    let completed = 0;
    broadcastUpdate({ type: 'queue-start', jobId, queueName: queueName || 'Untitled Queue', total: totalSteps, completed: 0 });

    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      for (let hi = 0; hi < hostnames.length; hi++) {
        const hostname = sanitizeHost(hostnames[hi]);
        let stepResult = { success: false, output: '', error: '' };
        const progressMsg = { type: 'queue-progress', jobId, step: step.type, stepIndex: si, totalSteps: steps.length, hostname, hostIndex: hi, totalHosts: hostnames.length, completed, total: totalSteps, status: 'running' };
        broadcastUpdate(progressMsg);

        try {
          let script = '';
          switch (step.type) {
            case 'check-updates':
              script = `Import-Module PSWindowsUpdate; Get-WindowsUpdate -ComputerName '${hostname}' ${credParam} | ConvertTo-Json -Compress`;
              break;
            case 'download-updates':
              script = `Import-Module PSWindowsUpdate; Get-WindowsUpdate -ComputerName '${hostname}' ${credParam} -Download -AcceptAll | ConvertTo-Json -Compress`;
              break;
            case 'install-all':
            case 'install-updates':
              script = `Import-Module PSWindowsUpdate; Install-WindowsUpdate -ComputerName '${hostname}' ${credParam} -AcceptAll -AutoReboot | ConvertTo-Json -Compress`;
              break;
            case 'reboot':
              script = `Restart-Computer -ComputerName '${hostname}' ${credParam} -Force; @{ hostname='${hostname}'; rebooted=$true } | ConvertTo-Json -Compress`;
              break;
            case 'shutdown':
              script = `Stop-Computer -ComputerName '${hostname}' ${credParam} -Force; @{ hostname='${hostname}'; stopped=$true } | ConvertTo-Json -Compress`;
              break;
            case 'wait-for-online':
              script = `for ($i=0; $i -lt 60; $i++) { if (Test-Connection -ComputerName '${hostname}' -Count 1 -Quiet) { break }; Start-Sleep -Seconds 5 }; @{ hostname='${hostname}'; online=$true } | ConvertTo-Json -Compress`;
              break;
            case 'run-command':
              if (step.config?.code) {
                script = `Invoke-Command -ComputerName '${hostname}' ${credParam} -ScriptBlock { ${step.config.code} } | Out-String`;
              }
              break;
            case 'start-service':
              if (step.config?.serviceName) {
                script = `Start-Service -ComputerName '${hostname}' -Name '${sanitizeHost(step.config.serviceName)}' ${credParam}; @{ hostname='${hostname}'; service='${sanitizeHost(step.config.serviceName)}'; state='Running' } | ConvertTo-Json -Compress`;
              }
              break;
            case 'stop-service':
              if (step.config?.serviceName) {
                script = `Stop-Service -ComputerName '${hostname}' -Name '${sanitizeHost(step.config.serviceName)}' -Force ${credParam}; @{ hostname='${hostname}'; service='${sanitizeHost(step.config.serviceName)}'; state='Stopped' } | ConvertTo-Json -Compress`;
              }
              break;
            case 'restart-service':
              if (step.config?.serviceName) {
                script = `Restart-Service -ComputerName '${hostname}' -Name '${sanitizeHost(step.config.serviceName)}' -Force ${credParam}; @{ hostname='${hostname}'; service='${sanitizeHost(step.config.serviceName)}'; state='Running' } | ConvertTo-Json -Compress`;
              }
              break;
            case 'psexec-run':
              if (step.config?.command) {
                script = `& '${PSTOOLS_PATH}psexec.exe' \\\\${hostname} -accepteula ${step.config.command}`;
              }
              break;
            case 'wait-minutes':
              await new Promise(r => setTimeout(r, (step.config?.minutes || 1) * 60000));
              stepResult = { success: true, output: `Waited ${step.config?.minutes || 1} minute(s)` };
              break;
            default:
              stepResult = { success: false, error: `Unknown step type: ${step.type}` };
          }
          if (script) {
            const r = await runPowerShell(script, 300000);
            stepResult = { success: r.success, output: r.stdout, error: r.stderr };
          }
        } catch (e) {
          stepResult = { success: false, error: e.message };
        }

        completed++;
        broadcastUpdate({
          type: 'queue-step-complete',
          jobId, step: step.type, stepIndex: si, hostname, hostIndex: hi,
          completed, total: totalSteps,
          success: stepResult.success,
          output: stepResult.output?.slice(0, 5000),
          error: stepResult.error,
          status: stepResult.success ? 'success' : 'failed'
        });

        if (!stepResult.success && errorHandling === 'stop') {
          broadcastUpdate({ type: 'queue-aborted', jobId, reason: 'Step failed and errorHandling=stop', step, hostname, completed, total: totalSteps });
          return;
        }
      }
    }
    broadcastUpdate({ type: 'queue-complete', jobId, completed, total: totalSteps, status: 'completed' });
  })();
});

// ==========================================================================
// PSTOOLS — Execute PsTools commands on remote hosts (configurable path)
// ==========================================================================
function pstoolsExe(name) {
  return path.join(PSTOOLS_PATH, name);
}

app.post('/api/pstools/execute', async (req, res) => {
  const { tool, hostname, args, credential } = req.body;
  const toolMap = {
    psexec: 'psexec.exe', psinfo: 'psinfo.exe', pslist: 'pslist.exe',
    pskill: 'pskill.exe', psservice: 'psservice.exe', psloggedon: 'psloggedon.exe',
    psshutdown: 'psshutdown.exe', psfile: 'psfile.exe', psgetsid: 'psgetsid.exe',
    pssuspend: 'pssuspend.exe'
  };
  const exe = toolMap[tool] || 'psexec.exe';
  const safeHost = sanitizeHost(hostname);
  const target = `\\\\${safeHost}`;
  const fullCmd = `"${pstoolsExe(exe)}" ${target} -accepteula ${args || ''}`;
  const result = await runPowerShell(fullCmd, 60000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psinfo', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const cmd = `"${pstoolsExe('psinfo.exe')}" \\\\${safeHost} -accepteula`;
  const result = await runPowerShell(cmd, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/pslist', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const cmd = `"${pstoolsExe('pslist.exe')}" \\\\${safeHost} -accepteula`;
  const result = await runPowerShell(cmd, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/pskill', async (req, res) => {
  const { hostname, target } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeTarget = sanitizeHost(target);
  const cmd = `"${pstoolsExe('pskill.exe')}" \\\\${safeHost} ${safeTarget} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psservice', async (req, res) => {
  const { hostname, action, serviceName } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeService = serviceName ? sanitizeHost(serviceName) : '';
  const actionCmd = action && serviceName ? `${action} "${safeService}"` : 'query';
  const cmd = `"${pstoolsExe('psservice.exe')}" \\\\${safeHost} ${actionCmd} -accepteula`;
  const result = await runPowerShell(cmd, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psloggedon', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const cmd = `"${pstoolsExe('psloggedon.exe')}" \\\\${safeHost} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psshutdown', async (req, res) => {
  const { hostname, action, timeout, message } = req.body;
  const safeHost = sanitizeHost(hostname);
  const actionFlag = action === 'shutdown' ? '-s' : action === 'abort' ? '-a' : '-r';
  const safeMsg = message ? message.replace(/"/g, '`"') : '';
  const cmd = `"${pstoolsExe('psshutdown.exe')}" \\\\${safeHost} ${actionFlag} -t ${timeout || 5} -c -accepteula ${message ? `-m "${safeMsg}"` : ''}`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psfile', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const cmd = `"${pstoolsExe('psfile.exe')}" \\\\${safeHost} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psgetsid', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const cmd = `"${pstoolsExe('psgetsid.exe')}" \\\\${safeHost} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/pssuspend', async (req, res) => {
  const { hostname, target, action } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeTarget = sanitizeHost(target);
  const actionFlag = action === 'resume' ? '-r' : '';
  const cmd = `"${pstoolsExe('pssuspend.exe')}" ${actionFlag} \\\\${safeHost} ${safeTarget} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// PC EVENT LOG — Retrieve Windows Event Logs from a remote host
// ==========================================================================
app.post('/api/hosts/:hostname/eventlog', async (req, res) => {
  const { hostname } = req.params;
  const { logName = 'System', maxEvents = 50, severity, credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeLog = String(logName).replace(/[^a-zA-Z0-9]/g, '');
  const safeMax = Math.min(parseInt(maxEvents, 10) || 50, 500);
  const credBlock = credential ? buildCredentialBlock(credential) : '';

  // Severity filter: All, Error, Warning, Information
  let levelFilter = '';
  if (severity === 'Error') levelFilter = '-Level 2';
  else if (severity === 'Warning') levelFilter = '-Level 3';
  else if (severity === 'Information') levelFilter = '-Level 4';

  const script = `
    ${credBlock}
    try {
      $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      $events = Get-WinEvent -FilterHashtable @{ LogName = '${safeLog}'; StartTime = (Get-Date).AddDays(-7) } ${levelFilter} -MaxEvents ${safeMax} @params -ErrorAction SilentlyContinue
      if (-not $events) { $events = @() }
      $results = $events | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message | ConvertTo-Json -Depth 3 -Compress
      $results
    } catch {
      @{ error = $_.Exception.Message; events = @() } | ConvertTo-Json -Compress
    }
  `;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// REMOTE DESKTOP — Launch VNC/RDP viewer on the backend machine
// ==========================================================================
app.post('/api/remote/connect', async (req, res) => {
  const { hostname, ip, protocol, port } = req.body;
  const safeIp = sanitizeHost(ip || hostname);
  try {
    let proc, vncPath;
    if (protocol === 'VNC') {
      // Try common VNC viewer paths
      const candidates = [
        'C:\\Program Files\\RealVNC\\VNC Viewer\\vncviewer.exe',
        'C:\\Program Files\\TightVNC\\tvnviewer.exe',
        'C:\\Program Files\\TigerVNC\\vncviewer.exe',
        'C:\\Program Files\\uvnc bvba\\UltraVNC\\vncviewer.exe',
        'C:\\Program Files (x86)\\RealVNC\\VNC Viewer\\vncviewer.exe'
      ];
      vncPath = candidates.find(p => fs.existsSync(p));
      if (!vncPath) {
        return res.json({ success: false, error: 'No VNC viewer found. Install RealVNC/TightVNC/TigerVNC/UltraVNC or set the path in Settings.' });
      }
      proc = spawn(vncPath, [`${safeIp}::${port || 5900}`], { detached: true, stdio: 'ignore' });
    } else {
      // RDP — mstsc is built into Windows
      proc = spawn('mstsc.exe', [`/v:${safeIp}:${port || 3389}`], { detached: true, stdio: 'ignore' });
    }
    proc.unref();
    proc.on('error', (err) => {
      // Logged after response sent — would need broadcastUpdate to surface
      console.error('Viewer launch failed:', err.message);
    });
    res.json({ success: true, data: { protocol, hostname: safeIp, port, viewerPath: vncPath || 'mstsc.exe' } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ==========================================================================
// WEBSOCKET — Real-time job progress updates
// ==========================================================================
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe' && data.jobId) {
        ws._subscribedJobs = ws._subscribedJobs || new Set();
        ws._subscribedJobs.add(data.jobId);
      }
      // ---- Terminal command execution (VSCode-style bottom panel) ----
      // User types a PsTools command in the bottom terminal; it arrives here.
      // We spawn the process and stream stdout/stderr back via the same WS.
      if (data.type === 'terminal-run') {
        const { command, host, sessionId } = data;
        if (!command) {
          ws.send(JSON.stringify({ type: 'terminal-error', sessionId, error: 'No command provided' }));
          return;
        }
        // Parse the command: "psexec \\pc-01 cmd" → run psexec.exe with args
        // Also support shorthand: "psinfo pc-01" → expand to "psinfo.exe \\pc-01 -accepteula"
        const trimmed = String(command).trim();
        let exe, args;
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const toolMap = {
          psexec: 'psexec.exe', psinfo: 'psinfo.exe', pslist: 'pslist.exe',
          pskill: 'pskill.exe', psservice: 'psservice.exe', psloggedon: 'psloggedon.exe',
          psshutdown: 'psshutdown.exe', psfile: 'psfile.exe', psgetsid: 'psgetsid.exe',
          pssuspend: 'pssuspend.exe'
        };
        if (toolMap[cmd]) {
          exe = path.join(PSTOOLS_PATH, toolMap[cmd]);
          // Add -accepteula if not already in args
          args = parts.slice(1);
          if (!args.includes('-accepteula')) args.push('-accepteula');
        } else if (cmd === 'ping' || cmd === 'ping.exe') {
          exe = 'ping.exe';
          args = parts.slice(1);
        } else if (cmd === 'powershell' || cmd === 'ps') {
          exe = 'powershell.exe';
          args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', parts.slice(1).join(' ')];
        } else {
          // Generic — try to run as-is
          exe = parts[0];
          args = parts.slice(1);
        }

        ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: `\x1b[36m$ ${trimmed}\x1b[0m\r\n`, stream: 'command' }));
        const proc = spawn(exe, args, { windowsHide: false, shell: false });
        ws._terminalProcs = ws._terminalProcs || new Map();
        ws._terminalProcs.set(sessionId, proc);

        proc.stdout.on('data', (d) => {
          ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: d.toString(), stream: 'stdout' }));
        });
        proc.stderr.on('data', (d) => {
          ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: d.toString(), stream: 'stderr' }));
        });
        proc.on('close', (code) => {
          ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: `\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`, stream: 'exit' }));
          ws.send(JSON.stringify({ type: 'terminal-complete', sessionId, exitCode: code }));
          if (ws._terminalProcs) ws._terminalProcs.delete(sessionId);
          db.audit.add({ action: 'terminal.run', category: 'Terminal', result: code === 0 ? 'success' : 'failed', parameters: { command: trimmed }, output: `exit=${code}` });
        });
        proc.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'terminal-error', sessionId, error: err.message }));
          if (ws._terminalProcs) ws._terminalProcs.delete(sessionId);
        });
      }

      // Kill a running terminal session
      if (data.type === 'terminal-kill' && ws._terminalProcs) {
        const proc = ws._terminalProcs.get(data.sessionId);
        if (proc) {
          try { proc.kill('SIGTERM'); } catch {}
          ws._terminalProcs.delete(data.sessionId);
        }
      }
    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });
  ws.on('close', () => {
    // Kill any running terminal processes when client disconnects
    if (ws._terminalProcs) {
      ws._terminalProcs.forEach(p => { try { p.kill(); } catch {} });
      ws._terminalProcs.clear();
    }
    clients.delete(ws);
  });
  ws.send(JSON.stringify({ type: 'connected', message: 'SupportHubLAN WebSocket connected', serverTime: new Date().toISOString() }));
});

function broadcastUpdate(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === 1) {
      // Send all updates — frontend can filter by jobId if needed
      ws.send(msg);
    }
  });
}

// ==========================================================================
// START SERVER
// ==========================================================================
server.listen(PORT, BIND_ADDRESS, () => {
  const displayIp = BIND_ADDRESS === '0.0.0.0' ? 'localhost' : BIND_ADDRESS;
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  SupportHubLAN Backend Server v1.4.7                             ║
║  Listening on http://${displayIp}:${PORT}                            ║
║                                                                  ║
║  ✓ Serving frontend at /                                         ║
║  ✓ API endpoints at /api/*                                       ║
║  ✓ WebSocket at /ws (job progress)                               ║
║                                                                  ║
║  Configuration:                                                  ║
║  • PSTOOLS_PATH = ${PSTOOLS_PATH.padEnd(42)}    ║
║  • Auth         = ${ADMIN_USER ? 'ENABLED (user: ' + ADMIN_USER + ')'.padEnd(42) : 'DISABLED'.padEnd(42)}    ║
║  • Bind address = ${BIND_ADDRESS.padEnd(42)}    ║
║                                                                  ║
║  This server performs REAL Windows administration:                ║
║  • PsTools (PsExec/PsInfo/PsList/PsKill/PsService/PsLoggedOn)    ║
║  • Windows Updates (PSWindowsUpdate)                             ║
║  • Active Directory (Get-ADComputer + LAPS ms-Mcs-AdmPwd)        ║
║  • VNC/RDP launch (vncviewer.exe / mstsc.exe)                    ║
║  • Software deployment (Copy-Item + Invoke-Command)              ║
║  • Power management (Restart/Stop-Computer + WoL UDP)            ║
║  • Network scanner (parallel Test-Connection runspace pool)      ║
║  • Job Queue execution with live WebSocket progress              ║
║                                                                  ║
║  PREREQUISITES:                                                  ║
║  1. Windows with Node.js 18+                                     ║
║  2. PsTools extracted to ${PSTOOLS_PATH}              ║
║  3. Admin rights on target hosts                                 ║
║  4. Network: TCP 445 (SMB), TCP 135 (RPC) to targets             ║
║                                                                  ║
║  Open in browser: http://${displayIp}:${PORT}                        ║
╚══════════════════════════════════════════════════════════════════╝
  `);

  // Auto-open browser (Windows only)
  if (AUTO_OPEN && process.platform === 'win32') {
    exec(`start http://localhost:${PORT}`, (err) => {
      if (err) console.log('  (Could not auto-open browser. Open http://localhost:' + PORT + ' manually.)');
    });
  } else if (AUTO_OPEN) {
    console.log('  (Auto-open is Windows-only. Open http://localhost:' + PORT + ' in your browser.)');
  }
});

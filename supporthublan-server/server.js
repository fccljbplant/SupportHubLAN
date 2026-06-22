/* ==========================================================================
   SupportHubLAN Backend Server v2.0.0
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

// ---- Lib modules (wmic, powershell, winrm, pstools, logger, audit) ----
const wmic = require('./lib/wmic');
const powershell = require('./lib/powershell');
const winrm = require('./lib/winrm');
const pstools = require('./lib/pstools');
const { logCommand, analyzeError, getRecentLogs } = require('./lib/logger');
const audit = require('./lib/audit');

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

// Shared PsTools mapping (used by /api/pstools/execute and WebSocket terminal)
const PSTOOLS_TOOLMAP = {
  psexec: 'psexec.exe', psinfo: 'psinfo.exe', pslist: 'pslist.exe',
  pskill: 'pskill.exe', psservice: 'psservice.exe', psloggedon: 'psloggedon.exe',
  psshutdown: 'psshutdown.exe', psfile: 'psfile.exe', psgetsid: 'psgetsid.exe',
  pssuspend: 'pssuspend.exe'
};

// ---- Helper: Standard response wrapper ----
function sendResult(res, result) {
  res.json({ success: result.success, data: result.data, error: result.error, stdout: result.stdout, stderr: result.stderr });
}

// ---- Helper: Validate hostname/IP (prevent injection) ----
function sanitizeHost(h) {
  return String(h).replace(/[^a-zA-Z0-9._\-:]/g, '');
}

// ---- Helper: Fast parallel ping using ping.exe (NO PowerShell) ----
// Spawns up to `concurrency` ping.exe processes simultaneously.
// Returns array of { ip, online, hostname? }
// Much faster than PowerShell Test-Connection runspace pool — ping.exe
// starts in ~50ms vs PowerShell's ~3-5s startup.
// ==========================================================================
// HEALTH CHECK — Used by frontend to detect LIVE vs DEMO mode
// ==========================================================================
// Shows WHY each command succeeded or failed, which service is required
// on the remote PC, and how to fix common errors.
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const logs = getRecentLogs(limit);
  res.json({ success: true, data: logs, count: logs.length });
});

// ==========================================================================
// WINRM TEST — Test if WinRM is available on a remote host
// ==========================================================================
app.post('/api/winrm/test', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await winrm.testWinRM(safeHost);
  res.json({ success: result.available, data: result });
});

// ==========================================================================
// WINRM ENABLE — Try to enable WinRM on a remote host via PsExec
// ==========================================================================
app.post('/api/winrm/enable', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await winrm.enableWinRM(safeHost, PSTOOLS_PATH);
  res.json({ success: result.success, data: result });
});

// Check if PSWindowsUpdate module is available (checked at startup, cached)
let _psWindowsUpdateAvailable = null;
async function checkPSWindowsUpdate() {
  if (_psWindowsUpdateAvailable !== null) return _psWindowsUpdateAvailable;
  try {
    const result = await runPowerShell('Get-Module -ListAvailable PSWindowsUpdate | Select-Object -First 1 | Measure-Object | Select-Object -ExpandProperty Count', 10000);
    _psWindowsUpdateAvailable = result.success && parseInt(result.stdout.trim(), 10) > 0;
  } catch { _psWindowsUpdateAvailable = false; }
  return _psWindowsUpdateAvailable;
}

app.get('/api/health', (req, res) => {
  const pstoolsInstalled = fs.existsSync(path.join(PSTOOLS_PATH, 'psexec.exe'));
  const psWindowsUpdateAvailable = _psWindowsUpdateAvailable;
  res.json({
    success: true,
    data: {
      server: 'SupportHubLAN Backend',
      version: '2.0.0',
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
  if (color) db.inventories.setColor(id, color);
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
// ==========================================================================
// AUDIT LOG — Unified, queryable log of ALL actions on ALL hosts
// ==========================================================================
// Supports filtering by: host, actionType, user, success, date range, search
// Used by:
//   - Host drawer Audit Trail tab (filter by host)
//   - Central Audit Log screen (all filters)
//   - Script execution logs (filter by actionType=script.run)
//   - Windows Update logs (filter by actionType=update.*)
// ==========================================================================

// GET /api/audit — list with filters
// Query params: host, actionType, user, success (true/false),
//               startDate, endDate, search, limit, offset
app.get('/api/audit', (req, res) => {
  const filters = {
    host: req.query.host,
    actionType: req.query.actionType,
    user: req.query.user,
    success: req.query.success === 'true' ? true : (req.query.success === 'false' ? false : undefined),
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    search: req.query.search,
    limit: parseInt(req.query.limit || '200', 10),
    offset: parseInt(req.query.offset || '0', 10),
  };
  const result = audit.query(db, filters);
  res.json(result);
});

// GET /api/audit/host/:hostname — get all logs for a specific host
app.get('/api/audit/host/:hostname', (req, res) => {
  const result = audit.getByHost(db, req.params.hostname, parseInt(req.query.limit || '100', 10));
  res.json(result);
});

// GET /api/audit/search — text search across all log fields
app.get('/api/audit/search', (req, res) => {
  const q = req.query.q || '';
  const result = audit.query(db, { search: q, limit: parseInt(req.query.limit || '200', 10) });
  res.json(result);
});

// POST /api/audit — add a new audit entry (used by frontend for UI-only actions)
app.post('/api/audit', (req, res) => {
  // Capture who initiated the request and from where
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  audit.add(db, {
    ...req.body,
    initiatedBy: req.body.initiatedBy || req.body.user || 'admin',
    initiatedFrom,
  });
  res.json({ success: true });
});

// POST /api/audit/clear — clear old logs
app.post('/api/audit/clear', (req, res) => {
  const { olderThanDays } = req.body;
  if (olderThanDays && olderThanDays > 0) {
    // Clear only logs older than N days — use audit.cleanup which filters by date
    const result = audit.cleanup(db);
    res.json({ success: true, removed: result.removed || 0, message: 'Cleared logs older than ' + olderThanDays + ' days' });
  } else {
    db.audit.clear();
    res.json({ success: true, message: 'Cleared all audit logs' });
  }
});

// POST /api/audit/cleanup — remove logs older than retention period
app.post('/api/audit/cleanup', (req, res) => {
  const result = audit.cleanup(db);
  res.json({ success: true, ...result });
});

// ==========================================================================
// SETTINGS — Log retention configuration
// ==========================================================================
app.get('/api/settings', (req, res) => {
  const allSettings = db.settings.getAll();
  // Include log retention with default
  allSettings.logRetentionDays = allSettings.logRetentionDays || '7';
  res.json({ success: true, data: allSettings });
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.json({ success: false, error: 'key required' });
  db.settings.set(key, value);
  res.json({ success: true });
});

// GET /api/settings/log-retention — get log retention days
app.get('/api/settings/log-retention', (req, res) => {
  const days = audit.getRetentionDays(db);
  res.json({ success: true, days });
});

// POST /api/settings/log-retention — set log retention days (default: 7, min: 1, max: 365)
app.post('/api/settings/log-retention', (req, res) => {
  const { days } = req.body;
  const result = audit.setRetentionDays(db, days);
  res.json(result);
});

// ==========================================================================
// GLOBAL DOMAIN CREDENTIALS — stored in db.settings, used by ALL remote
// commands (hardware scan, ping, services, scripts, updates, power, etc.)
// Password is encrypted with db.encryptField (AES-256-GCM, same as credentials)
// ==========================================================================

// Helper: get global domain credentials (decrypted)
function getGlobalCredentials() {
  try {
    const username = db.settings.get('globalCredUsername', '') || '';
    const encryptedPassword = db.settings.get('globalCredPassword', '') || '';
    const domain = db.settings.get('globalCredDomain', '') || '';
    const password = encryptedPassword ? db.decryptField(encryptedPassword) : '';
    if (username && password) {
      return { username, password, domain, fullUsername: domain ? domain + '\\' + username : username };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// GET /api/settings/domain-credentials — retrieve (password masked)
app.get('/api/settings/domain-credentials', (req, res) => {
  const creds = getGlobalCredentials();
  if (creds) {
    res.json({ success: true, data: { username: creds.username, domain: creds.domain, hasPassword: true } });
  } else {
    res.json({ success: true, data: { username: '', domain: '', hasPassword: false } });
  }
});

// POST /api/settings/domain-credentials — save global domain credentials
app.post('/api/settings/domain-credentials', (req, res) => {
  const { username, password, domain } = req.body;
  if (!username || !password) {
    return res.json({ success: false, error: 'Username and password are required' });
  }
  try {
    db.settings.set('globalCredUsername', username);
    db.settings.set('globalCredPassword', db.encryptField(password));
    db.settings.set('globalCredDomain', domain || '');
    res.json({ success: true, message: 'Domain credentials saved' });
  } catch (e) {
    res.json({ success: false, error: 'Failed to save credentials: ' + e.message });
  }
});

// POST /api/settings/domain-credentials/test — test credentials by running a simple command
app.post('/api/settings/domain-credentials/test', async (req, res) => {
  const creds = getGlobalCredentials();
  if (!creds) {
    return res.json({ success: false, error: 'No domain credentials configured' });
  }
  // Test by running a simple whoami with the credentials (no WinRM needed)
  const script = `
    $secPass = ConvertTo-SecureString '${creds.password.replace(/'/g, "''")}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${creds.fullUsername.replace(/'/g, "''")}', $secPass)
    try {
      $tempScript = [System.IO.Path]::GetTempFileName() + '.ps1'
      'whoami' | Out-File $tempScript -Encoding UTF8
      $output = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $tempScript -Credential $cred -Wait -PassThru -NoNewWindow -RedirectStandardOutput ($tempScript + '.out') -ErrorAction Stop
      $result = Get-Content ($tempScript + '.out') -Raw
      Remove-Item $tempScript, ($tempScript + '.out') -Force -ErrorAction SilentlyContinue
      if ($result -and $result.Trim()) {
        Write-Output ('<<<JSON>>>{"success":true,"identity":"' + $result.Trim() + '"}<<<END>>>')
      } else {
        Write-Output ('<<<JSON>>>{"success":false,"error":"No output from test command (exit code: ' + $output.ExitCode + ')"}<<<END>>>')
      }
    } catch {
      Write-Output ('<<<JSON>>>{"success":false,"error":"' + ($_.Exception.Message -replace '"',''') + '"}<<<END>>>')
    }
  `;
  const result = await runPowerShell(script, 15000);
  const markerMatch = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(result.stdout || '');
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1].trim());
      res.json(parsed);
    } catch {
      res.json({ success: false, error: 'Could not parse test result' });
    }
  } else {
    res.json({ success: false, error: result.stderr || 'Credential test failed' });
  }
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
// Detect domain from local computer — reads domain name + default OU path
// Uses .NET (no ADWS/RSAT needed)
app.post('/api/hosts/detect-domain', async (req, res) => {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $cs = Get-CimInstance Win32_ComputerSystem
    $domain = $cs.Domain
    $partOfDomain = $cs.PartOfDomain
    $ouPath = ''
    if ($partOfDomain) {
      try {
        # Use .NET to get the computer's DN (no ADWS needed)
        $entry = [System.DirectoryServices.DirectoryEntry]::new('LDAP://<LDAP://RootDSE>')
        $defaultNC = $entry.Properties['defaultNamingContext'][0]
        $ouPath = 'OU=Computers,' + $defaultNC
        $entry.Dispose()
      } catch {
        # Fallback: build from domain name
        $dcParts = $domain -split '\\.' | ForEach-Object { 'DC=' + $_ }
        $ouPath = 'OU=Computers,' + ($dcParts -join ',')
      }
    }
    @{ domain = $domain; partOfDomain = $partOfDomain; ouPath = $ouPath; computerName = $env:COMPUTERNAME } | ConvertTo-Json -Compress
  `;
  const result = await runPowerShell(script, 15000);
  try {
    const data = JSON.parse(result.stdout);
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: 'Could not detect domain: ' + (result.stderr || e.message) });
  }
});

// AD Computer Discovery — uses domain credentials to query Get-ADComputer
app.post('/api/hosts/discover-ad', async (req, res) => {
  const { ouPath, searchScope, filter, nameAttr, username, password, domain } = req.body;
  const safeUser = (username || '').replace(/'/g, "''");
  const safePass = (password || '').replace(/'/g, "''");
  const safeDomain = (domain || '').replace(/'/g, "''");
  const hasCreds = username && password;

  // Use .NET DirectorySearcher (LDAP) — does NOT require ADWS or RSAT AD module
  const script = `
    $WarningPreference = 'SilentlyContinue'
    $VerbosePreference = 'SilentlyContinue'
    $ErrorActionPreference = 'Stop'
    $searchBaseDN = '${(ouPath || 'OU=Computers,DC=corp,DC=local').replace(/'/g, "''")}'
    $nameAttr = '${(nameAttr || 'cn').replace(/'/g, "''")}'
    ${hasCreds ? `
    $secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${safeDomain}\\${safeUser}', $secPass)
    ` : ''}
    try {
      # Build LDAP path
      $ldapPath = 'LDAP://${searchBaseDN}'
      ${hasCreds ? `
      $entry = New-Object System.DirectoryServices.DirectoryEntry($ldapPath, '${safeDomain}\\${safeUser}', '${safePass}')
      ` : `
      $entry = New-Object System.DirectoryServices.DirectoryEntry($ldapPath)
      `}
      $searcher = New-Object System.DirectoryServices.DirectorySearcher($entry)
      $searcher.Filter = '(&(objectCategory=computer))'
      $searcher.PageSize = 1000
      $searcher.PropertiesToLoad.Add('cn') | Out-Null
      $searcher.PropertiesToLoad.Add('name') | Out-Null
      $searcher.PropertiesToLoad.Add('dNSHostName') | Out-Null
      $searcher.PropertiesToLoad.Add('operatingSystem') | Out-Null
      $searcher.PropertiesToLoad.Add('lastLogonTimestamp') | Out-Null

      $results = @()
      $searchResult = $searcher.FindAll()
      foreach ($sr in $searchResult) {
        $name = ''
        if ($sr.Properties[$nameAttr]) { $name = $sr.Properties[$nameAttr][0] }
        elseif ($sr.Properties['cn']) { $name = $sr.Properties['cn'][0] }
        elseif ($sr.Properties['name']) { $name = $sr.Properties['name'][0] }

        $fqdn = ''
        if ($sr.Properties['dnshostname']) { $fqdn = $sr.Properties['dnshostname'][0] }

        $os = ''
        if ($sr.Properties['operatingsystem']) { $os = $sr.Properties['operatingsystem'][0] }

        $results += @{ name = $name; fqdn = $fqdn; ip = ''; os = $os }
      }
      $searchResult.Dispose()
      $searcher.Dispose()
      $entry.Dispose()

      if ($results.Count -eq 0) {
        Write-Output '<<<JSON>>>[]<<<END>>>'
      } else {
        $json = $results | ConvertTo-Json -Compress
        if ($json -is [string]) {
          Write-Output ('<<<JSON>>>' + $json + '<<<END>>>')
        } else {
          Write-Output ('<<<JSON>>>[' + $json + ']<<<END>>>')
        }
      }
    } catch {
      Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
    }
  `;
  const result = await runPowerShell(script, 30000);
  // Extract JSON from markers (ignores any warnings/noise before/after)
  const markerMatch = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(result.stdout || '');
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1].trim());
      if (parsed.error) {
        res.json({ success: false, error: parsed.error });
      } else {
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        res.json({ success: true, hosts: arr });
      }
    } catch (e) {
      res.json({ success: false, error: 'JSON parse error after AD query' });
    }
  } else {
    // No markers found — check for module-not-found error
    const errStr = result.stderr || result.stdout || '';
    const isModuleNotFound = /module.*not.*found|ActiveDirectory.*not.*loaded/i.test(errStr);
    if (isModuleNotFound) {
      res.json({
        success: false,
        error: 'ActiveDirectory PowerShell module is NOT installed on this server. To install it, run one of these commands as Administrator:\n\n' +
               'Windows 10/11:\n' +
               '  Add-WindowsCapability -Online -Name "Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0"\n\n' +
               'Windows Server:\n' +
               '  Install-WindowsFeature RSAT-AD-PowerShell\n\n' +
               'After installation, restart this server.'
      });
    } else {
      res.json({ success: false, error: errStr.substring(0, 500) || 'AD query failed — ensure credentials are correct and the server is joined to a domain' });
    }
  }
});

// ==========================================================================
// HOST OPERATIONS — Real system queries to remote hosts
// ==========================================================================
app.post('/api/hosts/:hostname/info', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  // Use request credential, or fall back to global domain credentials
  const cred = credential || getGlobalCredentials();
  const credBlock = cred ? buildCredentialBlock(cred) : '';
  const credParam = cred ? '$params.Credential = $cred' : '';

  const script = `
    ${credBlock}
    try {
      $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
      ${credParam}

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
// NETWORK SCANNER — Fast parallel ping sweep using ping.exe (NO PowerShell)
// Spawns up to 64 concurrent ping.exe processes for maximum speed.
// A /24 subnet (254 IPs) completes in ~5 seconds vs 60+ seconds with
// the old PowerShell runspace pool approach.
// ==========================================================================
app.post('/api/scan', async (req, res) => {
  const { ips } = req.body;
  if (!Array.isArray(ips) || ips.length === 0) {
    return res.json({ success: false, error: 'ips array required' });
  }
  const safeIps = ips.map(sanitizeHost).filter(Boolean).slice(0, 1024); // Cap at 1024 per scan
  const jobScanId = 'scan-' + Date.now();
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();

  // Respond immediately with job ID, then run async + broadcast progress
  res.json({ success: true, data: { jobId: jobScanId, total: safeIps.length } });

  // Run fast parallel ping sweep (64 concurrent pings, 3s timeout each)
  const results = await pstools.pingParallel(safeIps, 64, 3000);

  // Try to resolve hostnames for alive IPs via DNS reverse lookup
  const dns = require('dns');
  const enrichedResults = await Promise.all(results.map(r => {
    return new Promise((resolve) => {
      if (!r.online) { resolve(r); return; }
      dns.reverse(r.ip, (err, hostnames) => {
        resolve({ ...r, hostname: (!err && hostnames && hostnames[0]) ? hostnames[0] : '' });
      });
    });
  }));

  const online = enrichedResults.filter(r => r.online).length;
  const offline = enrichedResults.length - online;
  broadcastUpdate({
    type: 'scan-complete',
    jobId: jobScanId,
    results: enrichedResults,
    summary: { total: safeIps.length, online, offline }
  });

  // Audit log — IP range scan
  audit.add(db, {
    actionType: 'network.scan',
    targetHost: safeIps.length + ' IPs',
    tool: 'ping.exe (parallel)',
    command: `Ping sweep: ${safeIps.length} IPs`,
    success: true,
    durationMs: Date.now() - startTime,
    outputSummary: `${online} online, ${offline} offline of ${safeIps.length} total`,
    initiatedBy: 'admin',
    initiatedFrom,
    parameters: { ipCount: safeIps.length, online, offline },
  });
});

// ==========================================================================
// BATCH STATUS CHECK — Ping multiple hostnames in parallel to determine
// online/offline status. Used by the Refresh button to update all hosts.
// ==========================================================================
app.post('/api/hosts/status-check', async (req, res) => {
  const { hostnames } = req.body;
  if (!Array.isArray(hostnames) || hostnames.length === 0) {
    return res.json({ success: true, data: JSON.stringify([]) });
  }
  const hostList = hostnames.map(sanitizeHost).filter(Boolean).slice(0, 500);
  const results = await pstools.pingParallel(hostList, 64, 2000);
  const formatted = results.map(r => ({
    hostname: r.ip, // r.ip is actually the hostname here
    online: r.online,
    status: r.online ? 'online' : 'offline',
  }));
  res.json({ success: true, data: JSON.stringify(formatted), results: formatted });
});

// ==========================================================================
// WINDOWS UPDATES — Real scan/download/install via PSWindowsUpdate module
// ==========================================================================
app.post('/api/updates/scan', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const cred = credential || getGlobalCredentials();
  const credParam = cred ? '-Credential $cred' : '';
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();
  const script = `
    ${cred ? buildCredentialBlock(cred) : ''}
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
  // Audit log — Windows Update scan
  hostnames.forEach(h => {
    audit.add(db, {
      actionType: 'update.scan',
      targetHost: sanitizeHost(h),
      tool: 'powershell+PSWindowsUpdate',
      command: `Get-WindowsUpdate on ${h}`,
      success: result.success,
      durationMs: Date.now() - startTime,
      outputSummary: result.stdout ? result.stdout.substring(0, 500) : (result.stderr || '').substring(0, 500),
      errorReason: result.success ? null : result.stderr,
      initiatedBy: 'admin',
      initiatedFrom,
    });
  });
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/updates/download', async (req, res) => {
  const { hostnames, credential, kbFilter } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const credParam = credential ? '-Credential $cred' : '';
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();
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
  // Audit log — Windows Update download
  hostnames.forEach(h => {
    audit.add(db, {
      actionType: 'update.download',
      targetHost: sanitizeHost(h),
      tool: 'powershell+PSWindowsUpdate',
      command: `Download updates on ${h}${kbFilter ? ' (KB: ' + kbFilter + ')' : ''}`,
      success: result.success,
      durationMs: Date.now() - startTime,
      outputSummary: result.stdout ? result.stdout.substring(0, 500) : '',
      errorReason: result.success ? null : result.stderr,
      initiatedBy: 'admin',
      initiatedFrom,
    });
  });
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/updates/install', async (req, res) => {
  const { hostnames, credential, kbFilter, classification, rebootBehavior } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const credParam = credential ? '-Credential $cred' : '';
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();
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
  // Audit log — Windows Update install (patch installation)
  hostnames.forEach(h => {
    audit.add(db, {
      actionType: 'update.install',
      targetHost: sanitizeHost(h),
      tool: 'powershell+PSWindowsUpdate',
      command: `Install updates on ${h}${kbFilter ? ' (KB: ' + kbFilter + ')' : ''}${classification ? ' (' + classification + ')' : ''}${rebootBehavior ? ' reboot:' + rebootBehavior : ''}`,
      success: result.success,
      durationMs: Date.now() - startTime,
      outputSummary: result.stdout ? result.stdout.substring(0, 500) : '',
      errorReason: result.success ? null : result.stderr,
      initiatedBy: 'admin',
      initiatedFrom,
      parameters: { kbFilter, classification, rebootBehavior },
    });
  });
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/updates/history', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.map(sanitizeHost).join("','");
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();
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
  // Audit log — Update history retrieval
  hostnames.forEach(h => {
    audit.add(db, {
      actionType: 'update.history',
      targetHost: sanitizeHost(h),
      tool: 'powershell+PSWindowsUpdate',
      command: `Get-WUHistory on ${h}`,
      success: result.success,
      durationMs: Date.now() - startTime,
      outputSummary: result.stdout ? result.stdout.substring(0, 500) : '',
      errorReason: result.success ? null : result.stderr,
      initiatedBy: 'admin',
      initiatedFrom,
    });
  });
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// SCRIPTS & COMMANDS — Real remote execution
// ==========================================================================
app.post('/api/scripts/execute', async (req, res) => {
  const { hostnames, script: userScript, credential, language, timeout } = req.body;
  const timeoutSec = timeout || 60;
  const results = [];
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const scriptStartTime = Date.now();

  for (const rawHost of hostnames) {
    const safeHost = sanitizeHost(rawHost);
    const hostStartTime = Date.now();
    let result = null;

    // METHOD 1: Try WinRM first (Invoke-Command) — fastest, no PsExec overhead
    const winrmResult = await powershell.runRemoteViaWinRM(safeHost, userScript, timeoutSec * 1000);
    if (winrmResult.success) {
      result = { hostname: safeHost, success: true, output: winrmResult.stdout, method: 'winrm', duration: Date.now() - hostStartTime };
      results.push(result);
      // Audit log — per-PC script execution
      audit.add(db, {
        actionType: 'script.run',
        targetHost: safeHost,
        tool: 'winrm+powershell',
        command: userScript.substring(0, 500),
        success: true,
        durationMs: result.duration,
        outputSummary: (winrmResult.stdout || '').substring(0, 500),
        initiatedBy: 'admin',
        initiatedFrom,
        parameters: { language, method: 'winrm', scriptLength: userScript.length },
      });
      continue;
    }

    // METHOD 2: Fall back to PsExec + PowerShell (no WinRM needed, uses SMB)
    const psexecResult = await powershell.runRemoteViaPsExec(safeHost, userScript, PSTOOLS_PATH, timeoutSec * 1000);
    if (psexecResult.success) {
      result = { hostname: safeHost, success: true, output: psexecResult.stdout, method: 'psexec', duration: Date.now() - hostStartTime };
      results.push(result);
      // Audit log — per-PC script execution
      audit.add(db, {
        actionType: 'script.run',
        targetHost: safeHost,
        tool: 'psexec+powershell',
        command: userScript.substring(0, 500),
        success: true,
        durationMs: result.duration,
        outputSummary: (psexecResult.stdout || '').substring(0, 500),
        initiatedBy: 'admin',
        initiatedFrom,
        parameters: { language, method: 'psexec', scriptLength: userScript.length },
      });
      continue;
    }

    // Both methods failed — return combined error with reasons
    result = {
      hostname: safeHost,
      success: false,
      error: `WinRM: ${winrmResult.reason || winrmResult.error} | PsExec: ${psexecResult.reason || psexecResult.error}`,
      winrmError: winrmResult,
      psexecError: psexecResult,
      duration: Date.now() - hostStartTime,
    };
    results.push(result);
    // Audit log — per-PC script failure (with WHY it failed)
    audit.add(db, {
      actionType: 'script.run',
      targetHost: safeHost,
      tool: 'winrm+psexec',
      command: userScript.substring(0, 500),
      success: false,
      durationMs: result.duration,
      errorReason: `WinRM: ${winrmResult.reason || winrmResult.error} | PsExec: ${psexecResult.reason || psexecResult.error}`,
      requiredService: winrmResult.service || psexecResult.service || 'WinRM or Admin$ share',
      fixSuggestion: winrmResult.fix || psexecResult.fix || 'Enable WinRM on target OR ensure PsTools/Admin$ share is accessible',
      initiatedBy: 'admin',
      initiatedFrom,
      parameters: { language, scriptLength: userScript.length },
    });
  }

  res.json({
    success: results.every(r => r.success),
    results,
    data: JSON.stringify(results),
    errors: results.filter(r => !r.success),
  });
});

// ==========================================================================
// SERVICES & PROCESSES
// ==========================================================================
app.post('/api/services/:hostname/list', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;
  const safeHost = sanitizeHost(hostname);
  const cred = credential || getGlobalCredentials();
  const script = `
    ${cred ? buildCredentialBlock(cred) : ''}
    try {
      $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
      ${cred ? '$params.Credential = $cred' : ''}
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
  const cred = credential || getGlobalCredentials();
  const credBlock = cred ? buildCredentialBlock(cred) : '';
  const credParam = cred ? '-Credential $cred' : '';
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
  const cred = credential || getGlobalCredentials();
  const script = `
    ${cred ? buildCredentialBlock(cred) : ''}
    try {
      $params = @{ ComputerName = '${safeHost}'; ErrorAction = 'Stop' }
      ${cred ? '$params.Credential = $cred' : ''}
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
  const cred = credential || getGlobalCredentials();
  const credBlock = cred ? buildCredentialBlock(cred) : '';
  const credParam = cred ? '-Credential $cred' : '';
  const msgParam = message ? `-Force` : `-Force`;
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();
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
  // Audit log — power action
  audit.add(db, {
    actionType: 'power.' + action,
    targetHost: safeHost,
    tool: 'powershell',
    command: `${action} on ${safeHost}${message ? ' (message: ' + message + ')' : ''}`,
    success: result.success,
    durationMs: Date.now() - startTime,
    outputSummary: result.stdout ? result.stdout.substring(0, 500) : '',
    errorReason: result.success ? null : result.stderr,
    initiatedBy: 'admin',
    initiatedFrom,
    parameters: { action, message },
  });
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
  const toolMap = PSTOOLS_TOOLMAP;
  const exe = toolMap[tool] || 'psexec.exe';
  const safeHost = sanitizeHost(hostname);
  const target = `\\\\${safeHost}`;
  const fullCmd = `"${pstoolsExe(exe)}" ${target} -accepteula ${args || ''}`;
  const result = await runPowerShell(fullCmd, 60000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// INSTALLED APPS — Uses PsExec + reg query (NO PowerShell) to list all
// installed software from the Windows registry Uninstall keys.
// ==========================================================================
app.post('/api/hosts/:hostname/apps', async (req, res) => {
  const safeHost = sanitizeHost(req.params.hostname);
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();

  try {
    // Query 3 registry locations in parallel via PsExec
    const [reg64Res, reg32Res, regUserRes] = await Promise.all([
      pstools.runPsExec(safeHost, 'reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000),
      pstools.runPsExec(safeHost, 'reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000),
      pstools.runPsExec(safeHost, 'reg.exe', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000),
    ]);

    // Parse each registry output
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

    // Audit log
    audit.add(db, {
      actionType: 'apps.list',
      targetHost: safeHost,
      tool: 'psexec+reg',
      command: `reg query Uninstall keys on ${safeHost}`,
      success: true,
      durationMs: Date.now() - startTime,
      outputSummary: `Found ${deduped.length} apps (${apps64.length} 64-bit, ${apps32.length} 32-bit, ${appsUser.length} user)`,
      initiatedBy: 'admin',
      initiatedFrom,
    });

    res.json({
      success: true,
      apps: deduped,
      count: deduped.length,
      sources: { '64bit': apps64.length, '32bit': apps32.length, 'user': appsUser.length },
    });
  } catch (e) {
    audit.add(db, {
      actionType: 'apps.list',
      targetHost: safeHost,
      tool: 'psexec+reg',
      command: `reg query Uninstall keys on ${safeHost}`,
      success: false,
      durationMs: Date.now() - startTime,
      errorReason: e.message,
      initiatedBy: 'admin',
      initiatedFrom,
    });
    res.json({ success: false, error: e.message, apps: [] });
  }
});

// Helper: parse reg query /s output into app objects
function parseRegUninstall(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const apps = [];
  const lines = out.split('\n');
  let current = {};
  let hasName = false;

  for (const line of lines) {
    if (/^HKEY_/.test(line.trim())) {
      if (hasName && current.name) apps.push(current);
      current = {};
      hasName = false;
      continue;
    }
    const m = /^\s+(\S+)\s+REG_\S+\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1];
      const value = (m[2] || '').trim();
      if (key === 'DisplayName' && value) { current.name = value; hasName = true; }
      else if (key === 'DisplayVersion') { current.version = value; }
      else if (key === 'Publisher') { current.publisher = value; }
      else if (key === 'InstallDate') { current.installDate = value; }
    }
  }
  if (hasName && current.name) apps.push(current);
  return apps;
}

// ==========================================================================
// HARDWARE AUDIT — Multi-method scan with PRIORITY ORDER:
//   1st: PsTools  (psinfo + psloggedon)  — PRIMARY, works without WinRM
//   2nd: PowerShell (via PsExec)          — extra data (motherboard, BIOS, RAM details)
//   3rd: WinRM    (Invoke-Command)        — extra data if WinRM is available
//   4th: wmic     (via PsExec)            — fallback for any remaining gaps
//
// PsTools provides (PRIMARY — don't change this working code):
//   - System: manufacturer, model, type, total RAM, domain
//   - OS: name, version, build, install date, registered user/org
//   - Processor: name, speed, count
//   - GPU: video driver name
//   - Disk volumes: drive letters, size, free, filesystem, label
//   - Hotfixes: KB numbers
//   - Software: application names
//   - Logged-in user
//
// PowerShell fills these GAPS (2nd priority):
//   - Motherboard: manufacturer, product, version, serial
//   - BIOS: manufacturer, version, serial, release date
//   - CPU: cores, threads, socket
//   - RAM sticks: capacity, speed, manufacturer, part number (per-stick)
//   - Physical disks: model, size, interface, serial number
//   - GPU: VRAM, driver version
//
// WinRM fills these GAPS (3rd priority, if WinRM available):
//   - Network adapters: IP, MAC, DHCP, gateway, DNS
//
// wmic fills these GAPS (4th priority, last resort):
//   - Any data the above methods couldn't retrieve
//
// All commands are logged with error reasons (which service failed, how to fix)
// ==========================================================================
app.post('/api/hosts/:hostname/hardware', async (req, res) => {
  const safeHost = sanitizeHost(req.params.hostname);
  const results = {
    hostname: safeHost,
    scannedAt: new Date().toISOString(),
    system: {}, motherboard: {}, bios: {}, processor: null,
    memory: [], disks: [], logicalDisks: [], network: [], gpu: [],
    os: {}, hotfixes: [], software: [], loggedInUser: null,
    methods: {},  // Track which method provided each section
    errors: [],   // Collect error reasons for failed commands
  };

  // Log the audit entry — who initiated, from where, when
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const scanStartTime = Date.now();

  try {
    // ========================================================================
    // PRIORITY 1: PsTools (PsInfo + PsLoggedOn) — PRIMARY, don't break this
    // ========================================================================
    const [psinfoRes, loggedOnRes] = await Promise.all([
      pstools.runPsInfo(safeHost, ['-d', '-h', '-s', '-c']),
      pstools.runPsLoggedOn(safeHost),
    ]);

    // Parse PsInfo output (it's a single comma-delimited line with -c flag)
    if (psinfoRes.success && psinfoRes.stdout) {
      results.methods.psinfo = 'success';
      const tokens = psinfoRes.stdout.split(/[\n,]/).map(t => t.trim()).filter(Boolean);

      // Known product types — used to detect if kernel version spanned 2 tokens
      const knownProductTypes = ['Professional', 'Server', 'Enterprise', 'Education', 'Home', 'Workstation', 'Standard', 'Datacenter', 'Essentials'];

      let i = 0;
      const sys = {};
      sys.hostname = tokens[i++] || '';
      sys.uptime = tokens[i++] || '';

      // Kernel version may span 2 tokens if it contains a comma
      let kernelVersion = tokens[i++] || '';
      if (i < tokens.length) {
        const nextToken = tokens[i] || '';
        const isProductType = knownProductTypes.some(pt => nextToken.toLowerCase() === pt.toLowerCase());
        if (!isProductType && nextToken !== '') kernelVersion += ', ' + tokens[i++];
      }
      sys.kernelVersion = kernelVersion;

      sys.productType = tokens[i++] || '';
      sys.productVersion = tokens[i++] || '';
      sys.servicePack = tokens[i++] || '';
      sys.kernelBuild = tokens[i++] || '';
      sys.registeredOrg = tokens[i++] || '';
      sys.registeredOwner = tokens[i++] || '';
      sys.ieVersion = tokens[i++] || '';
      sys.systemRoot = tokens[i++] || '';
      sys.processors = tokens[i++] || '';
      sys.processorSpeed = tokens[i++] || '';
      sys.processorType = tokens[i++] || '';
      sys.physicalMemory = tokens[i++] || '';
      sys.videoDriver = tokens[i++] || '';

      // Parse system info from PsInfo
      const ramMatch = /(\d+)\s*(MB|GB|TB)/i.exec(sys.physicalMemory || '');
      let totalRamMB = 0;
      if (ramMatch) {
        const n = parseInt(ramMatch[1], 10);
        const u = ramMatch[2].toUpperCase();
        totalRamMB = u === 'GB' ? n * 1024 : u === 'TB' ? n * 1024 * 1024 : n;
      }

      const speedMatch = /([\d.]+)\s*GHz/i.exec(sys.processorSpeed || '');
      const maxSpeedMHz = speedMatch ? Math.round(parseFloat(speedMatch[1]) * 1000) : 0;

      let cpuManufacturer = '';
      if (/Intel/i.test(sys.processorType)) cpuManufacturer = 'Intel';
      else if (/AMD|Advanced Micro/i.test(sys.processorType)) cpuManufacturer = 'AMD';

      results.system = {
        manufacturer: '',  // PsInfo doesn't provide this
        model: '',         // PsInfo doesn't provide this
        serial: '',        // PsInfo doesn't provide this
        systemType: '',
        domain: '',
        totalRamMB,
      };

      results.processor = sys.processorType ? {
        name: sys.processorType,
        manufacturer: cpuManufacturer,
        cores: 0,   // PsInfo doesn't provide core count — filled by PowerShell/wmic below
        threads: parseInt(sys.processors || '0', 10),
        maxSpeedMHz,
        currentSpeedMHz: maxSpeedMHz,
        socket: '',
        socketCount: 1,
      } : null;

      results.os = {
        name: sys.kernelVersion || '',
        version: sys.productVersion || '',
        build: sys.kernelBuild || '',
        architecture: '',
        installDate: '',
        lastBoot: '',
        serial: '',
        registeredOrg: sys.registeredOrg || '',
        registeredUser: sys.registeredOwner || '',
      };

      // Parse disk volumes from PsInfo tokens
      const logicalDisks = [];
      while (i < tokens.length && /^[A-Z]:$/i.test(tokens[i])) {
        const drive = tokens[i++];
        const type = tokens[i++] || '';
        const format = tokens[i++] || '';
        const label = tokens[i++] || '';
        const size = tokens[i++] || '';
        const free = tokens[i++] || '';
        i++; // skip free%
        const sizeMatch = /([\d.]+)\s*(GB|MB|TB)/i.exec(size);
        const freeMatch = /([\d.]+)\s*(GB|MB|TB)/i.exec(free);
        let sizeGB = 0, freeGB = 0;
        if (sizeMatch) { const n = parseFloat(sizeMatch[1]); const u = sizeMatch[2].toUpperCase(); sizeGB = u === 'TB' ? n * 1024 : n; }
        if (freeMatch) { const n = parseFloat(freeMatch[1]); const u = freeMatch[2].toUpperCase(); freeGB = u === 'TB' ? n * 1024 : n; }
        logicalDisks.push({ drive, sizeGB: Math.round(sizeGB * 100) / 100, freeGB: Math.round(freeGB * 100) / 100, fileSystem: format, volumeName: label });
      }
      results.logicalDisks = logicalDisks;

      // Parse GPU from PsInfo
      if (sys.videoDriver) {
        results.gpu = sys.videoDriver.split(/[,;]/).map(s => s.trim()).filter(Boolean).map(name => ({
          name, manufacturer: '', ramMB: 0, driverVersion: '', driverDate: '',
        }));
      }

      // Parse hotfixes and software from remaining tokens
      let foundSoftware = false;
      for (; i < tokens.length; i++) {
        const token = tokens[i].trim();
        if (!token) continue;
        const kbMatch = token.match(/KB\d+/i);
        if (kbMatch && !foundSoftware) {
          results.hotfixes.push(kbMatch[0].toUpperCase());
        } else if (!foundSoftware && /^n\/a/i.test(token)) {
          continue;
        } else {
          foundSoftware = true;
          if (!results.hotfixes.includes(token)) {
            results.software.push({ name: token });
          }
        }
      }
    } else if (psinfoRes.reason) {
      results.methods.psinfo = 'failed';
      results.errors.push({ priority: 1, method: 'PsInfo', ...psinfoRes });
    }

    // Parse logged-on user from PsLoggedOn
    if (loggedOnRes.success && loggedOnRes.stdout) {
      results.methods.psloggedon = 'success';
      const userMatch = loggedOnRes.stdout.match(/([A-Za-z0-9._-]+\\[A-Za-z0-9._-]+)/);
      if (userMatch) results.loggedInUser = userMatch[1];
    } else if (loggedOnRes.reason) {
      results.methods.psloggedon = 'failed';
      results.errors.push({ priority: 1, method: 'PsLoggedOn', ...loggedOnRes });
    }

    // ========================================================================
    // PRIORITY 2: PowerShell (via PsExec) — fills gaps PsInfo couldn't provide
    // ========================================================================
    // PsInfo doesn't provide: motherboard, BIOS details, CPU cores, RAM sticks,
    // physical disk details. Use PowerShell Get-CimInstance to get these.
    // ========================================================================
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue'
      $result = @{}
      $result.motherboard = Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product,Version,SerialNumber | ConvertTo-Json -Compress
      $result.bios = Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,ReleaseDate,SerialNumber | ConvertTo-Json -Compress
      $result.cpu = Get-CimInstance Win32_Processor | Select-Object Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,SocketDesignation | ConvertTo-Json -Compress
      $result.memory = Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Manufacturer,PartNumber,Speed,DeviceLocator | ConvertTo-Json -Compress
      $result.disks = Get-CimInstance Win32_DiskDrive | Select-Object Model,Size,InterfaceType,SerialNumber,Partitions | ConvertTo-Json -Compress
      $result.system = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,SerialNumber,SystemType,Domain | ConvertTo-Json -Compress
      $result.gpu = Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM,DriverVersion | ConvertTo-Json -Compress
      $result.os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,OSArchitecture,InstallDate,LastBootUpTime,SerialNumber | ConvertTo-Json -Compress
      $result | ConvertTo-Json -Depth 3 -Compress
    `;
    const psResult = await powershell.runRemoteViaPsExec(safeHost, psScript, PSTOOLS_PATH, 45000);

    if (psResult.success && psResult.stdout) {
      results.methods.powershell = 'success';
      try {
        // Extract JSON from the output (may have PsExec banner noise)
        let jsonStr = psResult.stdout;
        const jsonStart = jsonStr.indexOf('{');
        const jsonEnd = jsonStr.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
          const psData = JSON.parse(jsonStr);

          // Fill motherboard (PsInfo doesn't provide this)
          if (psData.motherboard) {
            const mb = typeof psData.motherboard === 'string' ? JSON.parse(psData.motherboard) : psData.motherboard;
            results.motherboard = {
              manufacturer: mb.Manufacturer || '',
              product: mb.Product || '',
              version: mb.Version || '',
              serial: mb.SerialNumber || '',
            };
          }

          // Fill BIOS (PsInfo doesn't provide this)
          if (psData.bios) {
            const bios = typeof psData.bios === 'string' ? JSON.parse(psData.bios) : psData.bios;
            results.bios = {
              manufacturer: bios.Manufacturer || '',
              version: bios.SMBIOSBIOSVersion || '',
              serial: bios.SerialNumber || '',
              releaseDate: bios.ReleaseDate || '',
            };
          }

          // Fill CPU cores/threads (PsInfo only provides name + speed)
          if (psData.cpu) {
            const cpus = Array.isArray(psData.cpu) ? psData.cpu : (typeof psData.cpu === 'string' ? JSON.parse(psData.cpu) : [psData.cpu]);
            const cpuArr = Array.isArray(cpus) ? cpus : [cpus];
            if (cpuArr.length > 0 && results.processor) {
              results.processor.cores = cpuArr.reduce((s, c) => s + (c.NumberOfCores || 0), 0);
              results.processor.threads = cpuArr.reduce((s, c) => s + (c.NumberOfLogicalProcessors || 0), 0);
              results.processor.socket = cpuArr[0].SocketDesignation || '';
              results.processor.socketCount = cpuArr.length;
            }
          }

          // Fill RAM sticks (PsInfo only provides total)
          if (psData.memory) {
            const mems = Array.isArray(psData.memory) ? psData.memory : (typeof psData.memory === 'string' ? JSON.parse(psData.memory) : [psData.memory]);
            const memArr = Array.isArray(mems) ? mems : [mems];
            results.memory = memArr.filter(m => m.Capacity).map(m => ({
              capacityGB: Math.round(parseInt(m.Capacity) / (1024 * 1024 * 1024) * 10) / 10,
              manufacturer: m.Manufacturer || '',
              partNumber: m.PartNumber || '',
              speed: parseInt(m.Speed || '0', 10),
              deviceLocator: m.DeviceLocator || '',
            }));
          }

          // Fill physical disks (PsInfo only provides volumes, not physical disks)
          if (psData.disks) {
            const disks = Array.isArray(psData.disks) ? psData.disks : (typeof psData.disks === 'string' ? JSON.parse(psData.disks) : [psData.disks]);
            const diskArr = Array.isArray(disks) ? disks : [disks];
            results.disks = diskArr.filter(d => d.Model).map(d => ({
              model: d.Model || '',
              sizeGB: Math.round(parseInt(d.Size || '0', 10) / (1024 * 1024 * 1024) * 10) / 10,
              interface: d.InterfaceType || '',
              serialNumber: d.SerialNumber || '',
              partitions: parseInt(d.Partitions || '0', 10),
            }));
          }

          // Fill system manufacturer/model (PsInfo doesn't provide this)
          if (psData.system) {
            const sys = typeof psData.system === 'string' ? JSON.parse(psData.system) : psData.system;
            if (sys.Manufacturer) results.system.manufacturer = sys.Manufacturer;
            if (sys.Model) results.system.model = sys.Model;
            if (sys.SerialNumber) results.system.serial = sys.SerialNumber;
            if (sys.SystemType) results.system.systemType = sys.SystemType;
            if (sys.Domain) results.system.domain = sys.Domain;
          }

          // Fill GPU details (PsInfo only provides name)
          if (psData.gpu) {
            const gpus = Array.isArray(psData.gpu) ? psData.gpu : (typeof psData.gpu === 'string' ? JSON.parse(psData.gpu) : [psData.gpu]);
            const gpuArr = Array.isArray(gpus) ? gpus : [gpus];
            if (gpuArr.length > 0 && results.gpu.length > 0) {
              results.gpu = gpuArr.filter(g => g.Name).map(g => ({
                name: g.Name || '',
                manufacturer: g.AdapterCompatibility || '',
                ramMB: Math.round(parseInt(g.AdapterRAM || '0', 10) / (1024 * 1024)),
                driverVersion: g.DriverVersion || '',
                driverDate: '',
              }));
            }
          }

          // Fill OS details (PsInfo provides name/version/build, PowerShell adds architecture)
          if (psData.os) {
            const osInfo = typeof psData.os === 'string' ? JSON.parse(psData.os) : psData.os;
            if (osInfo.OSArchitecture) results.os.architecture = osInfo.OSArchitecture;
            if (osInfo.InstallDate) results.os.installDate = osInfo.InstallDate;
            if (osInfo.LastBootUpTime) results.os.lastBoot = osInfo.LastBootUpTime;
            if (osInfo.SerialNumber) results.os.serial = osInfo.SerialNumber;
          }
        }
      } catch (e) {
        results.errors.push({ priority: 2, method: 'PowerShell', reason: 'JSON parse failed: ' + e.message });
      }
    } else if (psResult.reason) {
      results.methods.powershell = 'failed';
      results.errors.push({ priority: 2, method: 'PowerShell', ...psResult });
    }

    // ========================================================================
    // PRIORITY 3: WinRM — fills network adapters gap (if WinRM available)
    // ========================================================================
    // PsInfo and PowerShell-via-PsExec don't provide network adapter details.
    // WinRM (Invoke-Command) can get this if WinRM is configured on the target.
    // ========================================================================
    const winrmScript = `
      Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=true" |
        Select-Object Description,IPAddress,MACAddress,DHCPEnabled,DefaultIPGateway,DNSServerSearchOrder |
        ConvertTo-Json -Depth 2 -Compress
    `;
    const winrmResult = await winrm.runRemote(safeHost, winrmScript, 15000);

    if (winrmResult.success && winrmResult.stdout) {
      results.methods.winrm = 'success';
      try {
        let jsonStr = winrmResult.stdout;
        const marker = jsonStr.indexOf('<<<JSON>>>');
        if (marker >= 0) {
          jsonStr = jsonStr.substring(marker + 9);
          const endMarker = jsonStr.indexOf('<<<END>>>');
          if (endMarker >= 0) jsonStr = jsonStr.substring(0, endMarker);
        }
        const netData = JSON.parse(jsonStr);
        const netArr = Array.isArray(netData) ? netData : [netData];
        results.network = netArr.filter(n => n.IPAddress).map(n => ({
          description: n.Description || '',
          ipAddress: Array.isArray(n.IPAddress) ? n.IPAddress.join(', ') : n.IPAddress,
          macAddress: n.MACAddress || '',
          dhcpEnabled: n.DHCPEnabled || false,
          defaultGateway: Array.isArray(n.DefaultIPGateway) ? n.DefaultIPGateway.join(', ') : n.DefaultIPGateway,
          dnsServers: Array.isArray(n.DNSServerSearchOrder) ? n.DNSServerSearchOrder.join(', ') : n.DNSServerSearchOrder,
        }));
      } catch (e) {
        results.errors.push({ priority: 3, method: 'WinRM', reason: 'JSON parse failed: ' + e.message });
      }
    } else if (winrmResult.reason) {
      results.methods.winrm = 'failed';
      results.errors.push({ priority: 3, method: 'WinRM', ...winrmResult });
    }

    // ========================================================================
    // PRIORITY 4: wmic — last-resort fallback for any remaining gaps
    // ========================================================================
    // If network adapters are still empty (WinRM failed), try wmic via PsExec.
    // Also fills any other gaps the previous methods couldn't provide.
    // ========================================================================
    if (results.network.length === 0) {
      const wmicNetResult = await wmic.runRemoteViaPsExec(safeHost, 'nicconfig', 'Description,IPAddress,MACAddress,DHCPEnabled,DefaultIPGateway,DNSServerSearchOrder', PSTOOLS_PATH, 20000);
      if (wmicNetResult.success && wmicNetResult.records.length > 0) {
        results.methods.wmic = 'success';
        results.network = wmicNetResult.records.filter(n => n.IPAddress).map(n => ({
          description: n.Description || '',
          ipAddress: n.IPAddress ? n.IPAddress.replace(/[{}]/g, '') : '',
          macAddress: n.MACAddress || '',
          dhcpEnabled: n.DHCPEnabled === 'TRUE',
          defaultGateway: n.DefaultIPGateway ? n.DefaultIPGateway.replace(/[{}]/g, '') : '',
          dnsServers: n.DNSServerSearchOrder ? n.DNSServerSearchOrder.replace(/[{}]/g, '') : '',
        }));
      } else if (wmicNetResult.reason) {
        results.methods.wmic = 'failed';
        results.errors.push({ priority: 4, method: 'wmic (nicconfig)', ...wmicNetResult });
      }
    }

    // ========================================================================
    // SAVE — merge with previous data to avoid losing fields on partial scans
    // ========================================================================
    const key = 'hardware:' + safeHost;
    try {
      const prev = db.settings.get(key, null);
      let prevHw = null;
      if (prev) { try { prevHw = JSON.parse(prev); } catch {} }
      let finalResult = results;
      if (prevHw) {
        finalResult = { ...prevHw, ...results };
        // For each section, keep new data if non-empty, otherwise preserve old
        finalResult.system = Object.keys(results.system).length > 0 && (results.system.manufacturer || results.system.totalRamMB) ? { ...prevHw.system, ...results.system } : prevHw.system;
        finalResult.motherboard = Object.keys(results.motherboard).length > 0 ? { ...prevHw.motherboard, ...results.motherboard } : prevHw.motherboard;
        finalResult.bios = Object.keys(results.bios).length > 0 ? { ...prevHw.bios, ...results.bios } : prevHw.bios;
        finalResult.processor = results.processor || prevHw.processor;
        finalResult.memory = results.memory.length > 0 ? results.memory : prevHw.memory || [];
        finalResult.disks = results.disks.length > 0 ? results.disks : prevHw.disks || [];
        finalResult.logicalDisks = results.logicalDisks.length > 0 ? results.logicalDisks : prevHw.logicalDisks || [];
        finalResult.network = results.network.length > 0 ? results.network : prevHw.network || [];
        finalResult.gpu = results.gpu.length > 0 ? results.gpu : prevHw.gpu || [];
        finalResult.os = Object.keys(results.os).length > 0 ? { ...prevHw.os, ...results.os } : prevHw.os;
        finalResult.hotfixes = results.hotfixes.length > 0 ? results.hotfixes : prevHw.hotfixes || [];
        finalResult.software = results.software.length > 0 ? results.software : prevHw.software || [];
      }
      db.settings.set(key, JSON.stringify(finalResult));
    } catch {}

    // ========================================================================
    // AUDIT LOG — record this hardware scan
    // ========================================================================
    const scanDuration = Date.now() - scanStartTime;
    const methodSummary = Object.entries(results.methods).map(([k, v]) => `${k}:${v}`).join(', ');
    audit.add(db, {
      actionType: 'hardware.scan',
      targetHost: safeHost,
      tool: 'multi (psinfo+powershell+winrm+wmic)',
      command: `Hardware scan on ${safeHost}`,
      success: true,
      durationMs: scanDuration,
      outputSummary: `Methods: ${methodSummary}. Found: ${results.logicalDisks.length} volumes, ${results.disks.length} disks, ${results.memory.length} RAM sticks, ${results.gpu.length} GPU(s)`,
      initiatedBy: 'admin',
      initiatedFrom,
      parameters: {
        methods: results.methods,
        errorCount: results.errors.length,
        errors: results.errors,
      },
    });

    res.json({
      success: true,
      data: results,
      methods: results.methods,
      errorCount: results.errors.length,
      errors: results.errors,
    });

  } catch (e) {
    // Log the failure
    audit.add(db, {
      actionType: 'hardware.scan',
      targetHost: safeHost,
      tool: 'multi',
      command: `Hardware scan on ${safeHost}`,
      success: false,
      durationMs: Date.now() - scanStartTime,
      errorReason: e.message,
      initiatedBy: 'admin',
      initiatedFrom,
    });
    res.json({ success: false, error: e.message, data: results });
  }
});

// GET endpoint to retrieve saved hardware data (no scan)
app.get('/api/hosts/:hostname/hardware', (req, res) => {
  const safeHost = sanitizeHost(req.params.hostname);
  const key = 'hardware:' + safeHost;
  try {
    const saved = db.settings.get(key, null);
    if (saved) {
      res.json({ success: true, data: JSON.parse(saved) });
    } else {
      res.json({ success: false, error: 'No saved hardware data. Run a scan first.' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
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
        const toolMap = PSTOOLS_TOOLMAP;
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
          audit.add(db, { actionType: 'terminal.run', targetHost: hostname || 'local', tool: 'terminal', command: trimmed, success: code === 0, outputSummary: `exit=${code}`, initiatedBy: 'admin', initiatedFrom: ws._socket?.remoteAddress || 'unknown' });
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
║  SupportHubLAN Backend Server v2.0.0                             ║
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

  // Check PSWindowsUpdate availability AFTER server is listening (non-blocking)
  checkPSWindowsUpdate().then(available => {
    console.log(`[startup] PSWindowsUpdate module: ${available ? 'available' : 'NOT installed (Windows Update features will not work on this server)'}`);
  }).catch(() => {
    console.log('[startup] PSWindowsUpdate check failed (non-critical)');
  });
});

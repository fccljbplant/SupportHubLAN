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

// ---- Lib modules (wmic, powershell, pstools, logger, audit) ----
const wmic = require('./lib/wmic');
const powershell = require('./lib/powershell');
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
const DEFAULT_DOMAIN = process.env.DEFAULT_DOMAIN || '';

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
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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

// ---- Helper: Run a PowerShell script on a remote host via PsExec and parse JSON result ----
async function runRemotePowerShellJson(hostname, script, timeoutMs = 45000, credentialOverride) {
  const cred = credentialOverride || getGlobalCredentials();
  const result = await powershell.runRemoteViaPsExec(hostname, script, PSTOOLS_PATH, timeoutMs, cred);
  if (!result.success) return result;
  const markerMatch = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(result.stdout || '');
  if (markerMatch) {
    try { return { ...result, json: JSON.parse(markerMatch[1]) }; }
    catch (e) { return { ...result, jsonError: e.message, raw: result.stdout }; }
  }
  return { ...result, jsonError: 'No JSON markers found in output', raw: result.stdout };
}

// ---- Helper: PsExec credential args for direct pstools use ----
function getPsExecCredArgs() {
  const cred = getGlobalCredentials();
  if (!cred) return [];
  const fullUser = cred.domain ? `${cred.domain}\\${cred.username}` : cred.username;
  return ['-u', fullUser, '-p', cred.password];
}

// Shared PsTools mapping (used by /api/pstools/execute)
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
// Tries primary AD credentials first, then fallback local admin credentials
function getGlobalCredentials() {
  try {
    const globalDomain = db.settings.get('globalDomainSuffix', '') || DEFAULT_DOMAIN;
    // Try primary AD/domain credentials
    const username = db.settings.get('globalCredUsername', '') || '';
    const encryptedPassword = db.settings.get('globalCredPassword', '') || '';
    const domain = db.settings.get('globalCredDomain', '') || globalDomain;
    const password = encryptedPassword ? db.decryptField(encryptedPassword) : '';
    if (username && password) {
      return { username, password, domain, fullUsername: domain ? domain + '\\' + username : username, source: 'domain' };
    }
    // Fall back to local admin credentials
    const fbUsername = db.settings.get('fallbackCredUsername', '') || '';
    const fbEncrypted = db.settings.get('fallbackCredPassword', '') || '';
    const fbDomain = db.settings.get('fallbackCredDomain', '') || globalDomain;
    const fbPassword = fbEncrypted ? db.decryptField(fbEncrypted) : '';
    if (fbUsername && fbPassword) {
      return { username: fbUsername, password: fbPassword, domain: fbDomain, fullUsername: fbDomain ? fbDomain + '\\' + fbUsername : fbUsername, source: 'fallback' };
    }
    // No credentials configured, but domain suffix may be set — return domain-only object
    if (globalDomain) {
      return { username: '', password: '', domain: globalDomain, fullUsername: '', source: 'suffix-only' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Domain suffix endpoint — set default domain for FQDN resolution (pc-01 → pc-01.plant.fccl.com)
app.get('/api/settings/domain-suffix', (req, res) => {
  const stored = db.settings.get('globalDomainSuffix', '');
  const suffix = stored || DEFAULT_DOMAIN;
  res.json({ success: true, data: { domain: suffix, source: stored ? 'settings' : 'env' } });
});

app.post('/api/settings/domain-suffix', (req, res) => {
  const { domain } = req.body;
  db.settings.set('globalDomainSuffix', (domain || '').trim());
  res.json({ success: true, message: 'Domain suffix saved' });
});

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

// POST /api/settings/domain-credentials/test — test credentials
// Accepts optional username/password/domain in body. If provided, tests those.
// Otherwise, tests the saved global credentials.
app.post('/api/settings/domain-credentials/test', async (req, res) => {
  const { username: formUsername, password: formPassword, domain: formDomain } = req.body;
  let creds;

  if (formUsername && formPassword) {
    // Test the credentials provided in the form
    creds = {
      username: formUsername,
      password: formPassword,
      domain: formDomain || '',
      fullUsername: (formDomain ? formDomain + '\\' : '') + formUsername
    };
  } else {
    creds = getGlobalCredentials();
  }

  if (!creds) {
    return res.json({ success: false, error: 'No domain credentials configured' });
  }

  // Test using .NET DirectoryContext + Domain.GetDomain (no ADWS/RSAT needed)
  const safeUser = creds.fullUsername.replace(/'/g, "''");
  const safePass = creds.password.replace(/'/g, "''");
  const safeDomain = (creds.domain || '').replace(/'/g, "''");
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      $ctx = New-Object System.DirectoryServices.ActiveDirectory.DirectoryContext('Domain', '${safeDomain}', '${safeUser}', '${safePass}')
      $domainObj = [System.DirectoryServices.ActiveDirectory.Domain]::GetDomain($ctx)
      $dc = $domainObj.FindDomainController().Name
      $nc = $domainObj.GetDirectoryEntry().Properties['defaultNamingContext'][0]
      $domainObj.Dispose()
      Write-Output ("OK:${safeUser} verified — DC: " + $dc + ", NC: " + $nc)
    } catch {
      Write-Output ("FAIL:" + $_.Exception.Message)
    }
  `;
  const result = await runPowerShell(script, 15000);
  const output = (result.stdout || '').trim();
  if (output.startsWith('OK:')) {
    res.json({ success: true, identity: creds.fullUsername, message: output.substring(3) });
  } else if (output.startsWith('FAIL:')) {
    res.json({ success: false, error: output.substring(5) });
  } else {
    res.json({ success: false, error: output || result.stderr || 'Credential test failed' });
  }
});

// GET /api/settings/fallback-credentials — retrieve fallback local credentials
app.get('/api/settings/fallback-credentials', (req, res) => {
  const fbUsername = db.settings.get('fallbackCredUsername', '') || '';
  const fbEncrypted = db.settings.get('fallbackCredPassword', '') || '';
  const fbDomain = db.settings.get('fallbackCredDomain', '') || '';
  const hasFb = !!(fbUsername && fbEncrypted);
  res.json({ success: true, data: { username: fbUsername, domain: fbDomain, hasPassword: hasFb } });
});

// POST /api/settings/fallback-credentials — save fallback local admin credentials
app.post('/api/settings/fallback-credentials', (req, res) => {
  const { username, password, domain } = req.body;
  if (!username || !password) {
    return res.json({ success: false, error: 'Username and password are required' });
  }
  try {
    db.settings.set('fallbackCredUsername', username);
    db.settings.set('fallbackCredPassword', db.encryptField(password));
    db.settings.set('fallbackCredDomain', domain || '');
    res.json({ success: true, message: 'Fallback credentials saved' });
  } catch (e) {
    res.json({ success: false, error: 'Failed to save fallback credentials: ' + e.message });
  }
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
  // Prefer the domain from configured global credentials, since that is the
  // domain we will actually query with AD discovery.
  const creds = getGlobalCredentials();
  if (creds && creds.domain) {
    const domain = creds.domain;
    const dcParts = domain.split('.').map(p => 'DC=' + p).join(',');
    const ouPath = 'OU=Computers,' + dcParts;
    return res.json({ success: true, data: { domain, partOfDomain: true, ouPath, source: 'credentials' } });
  }

  // Fallback: detect from the local computer
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $cs = Get-CimInstance Win32_ComputerSystem
    $domain = $cs.Domain
    $partOfDomain = $cs.PartOfDomain
    $ouPath = ''
    if ($partOfDomain) {
      try {
        $entry = [System.DirectoryServices.DirectoryEntry]::new('LDAP://RootDSE')
        $defaultNC = $entry.Properties['defaultNamingContext'][0]
        $ouPath = 'OU=Computers,' + $defaultNC
        $entry.Dispose()
      } catch {
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

// AD Computer Discovery — uses GLOBAL domain credentials from Settings
// No per-form credentials needed. Domain is auto-detected from global settings.
// Uses .NET DirectorySearcher with Domain.GetDomain for robust DC discovery.
app.post('/api/hosts/discover-ad', async (req, res) => {
  const { ouPath, searchScope, filter, nameAttr, includeIP } = req.body;
  const creds = getGlobalCredentials();
  if (!creds) {
    return res.json({ success: false, error: 'No domain credentials configured. Go to Settings → General → Default Domain Credentials to set them up.' });
  }

  const fullUser = creds.fullUsername;
  const safePass = creds.password.replace(/'/g, "''");
  const safeDomain = creds.domain.replace(/'/g, "''");
  const rawOuPath = (ouPath || '').replace(/'/g, "''").trim();
  // Strip optional LDAP:// prefix if the user pasted one
  const safeOuPath = rawOuPath.replace(/^LDAP:\/\//i, '');
  const safeNameAttr = (nameAttr || 'cn').replace(/'/g, "''");
  const safeFilter = filter ? `(${filter})` : '(objectCategory=computer)';
  const scopeStr = searchScope === 'onelevel' ? 'OneLevel' : searchScope === 'base' ? 'Base' : 'Subtree';
  const resolveIP = includeIP === true ? '$true' : '$false';

  const script = `
    $WarningPreference = 'SilentlyContinue'
    $VerbosePreference = 'SilentlyContinue'
    $ErrorActionPreference = 'Stop'
    try {
      # Use DirectoryContext to get domain controller robustly
      $ctx = New-Object System.DirectoryServices.ActiveDirectory.DirectoryContext('Domain', '${safeDomain}', '${fullUser}', '${safePass}')
      $domainObj = [System.DirectoryServices.ActiveDirectory.Domain]::GetDomain($ctx)
      $defaultNC = $domainObj.GetDirectoryEntry().Properties['defaultNamingContext'][0]
      $dc = $domainObj.FindDomainController().Name
      $domainObj.Dispose()

      # Build a list of candidate search bases. If the user supplied an OU, try it first,
      # then fall back to the root domain naming context. Many AD forests use CN=Computers
      # rather than OU=Computers, so defaulting to the root context is safer.
      $candidates = @()
      if ('${safeOuPath}') {
        $candidates += 'LDAP://' + '${safeOuPath}'
      }
      $candidates += 'LDAP://' + $defaultNC
      # Some legacy / simple domains have a CN=Computers container at the root
      $candidates += 'LDAP://CN=Computers,' + $defaultNC

      $searchError = $null
      $results = @()
      foreach ($searchBaseDN in $candidates) {
        try {
          # Bind to the resolved DC explicitly to avoid stale DC referrals
          $targetPath = 'LDAP://' + $dc + '/' + ($searchBaseDN -replace '^LDAP://','')
          $entry = New-Object System.DirectoryServices.DirectoryEntry($targetPath, '${fullUser}', '${safePass}')
          $searcher = New-Object System.DirectoryServices.DirectorySearcher($entry)
          $searcher.Filter = '${safeFilter}'
          $searcher.PageSize = 1000
          $searcher.SearchScope = [System.DirectoryServices.SearchScope]::${scopeStr}
          $searcher.PropertiesToLoad.Add('cn') | Out-Null
          $searcher.PropertiesToLoad.Add('name') | Out-Null
          $searcher.PropertiesToLoad.Add('dNSHostName') | Out-Null
          $searcher.PropertiesToLoad.Add('operatingSystem') | Out-Null
          $searcher.PropertiesToLoad.Add('lastLogonTimestamp') | Out-Null

          $searchResult = $searcher.FindAll()
          foreach ($sr in $searchResult) {
            $name = ''
            if ($sr.Properties['${safeNameAttr}']) { $name = $sr.Properties['${safeNameAttr}'][0] }
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

          # If we found results, stop trying other candidates
          if ($results.Count -gt 0) { break }
        } catch {
          $searchError = $_.Exception.Message
          try { $searcher.Dispose() } catch {}
          try { $entry.Dispose() } catch {}
        }
      }

      # Optionally resolve IP addresses via DNS (from the server)
      if (${resolveIP}) {
        foreach ($r in $results) {
          try {
            $resolved = $null
            $targetName = if ($r.fqdn) { $r.fqdn } else { $r.name }
            if ($targetName) {
              $addrs = [System.Net.Dns]::GetHostAddresses($targetName)
              $resolved = $addrs | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
              if ($resolved) { $r.ip = $resolved.IPAddressToString }
            }
          } catch { $r.ip = '' }
        }
      }

      if ($results.Count -eq 0) {
        Write-Output ('<<<JSON>>>[]<<<END>>>')
      } else {
        $json = $results | ConvertTo-Json -Compress
        Write-Output ('<<<JSON>>>' + $json + '<<<END>>>')
      }
    } catch {
      Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
    }
  `;
  const result = await runPowerShell(script, 30000);
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
    const errStr = result.stderr || result.stdout || '';
    res.json({ success: false, error: errStr.substring(0, 500) || 'AD query failed — ensure credentials are correct and the server is joined to a domain' });
  }
});

// ==========================================================================
// HOST OPERATIONS — Real system queries to remote hosts
// ==========================================================================
app.post('/api/hosts/:hostname/info', async (req, res) => {
  const { hostname } = req.params;
  const safeHost = sanitizeHost(hostname);

  const script = `
    $ErrorActionPreference = 'Stop'
    $result = $null
    try {
      $os = Get-CimInstance Win32_OperatingSystem
      $cs = Get-CimInstance Win32_ComputerSystem
      $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
      $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
      $uptime = ((Get-Date) - $os.LastBootUpTime)
      $result = @{
        hostname = $env:COMPUTERNAME
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
    } catch {
      $result = @{ hostname = '${safeHost}'; onlineStatus = 'offline'; error = $_.Exception.Message }
    }
    Write-Output ('<<<JSON>>>' + ($result | ConvertTo-Json -Compress) + '<<<END>>>')
  `;
  const result = await runRemotePowerShellJson(safeHost, script, 30000);
  if (result.json) {
    sendResult(res, { success: true, data: result.json, stdout: result.stdout });
  } else {
    sendResult(res, { success: false, error: result.jsonError || result.stderr || 'Remote query failed' });
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

  // Fallback: for alive IPs still without hostname, use Windows full resolver
  // (includes NetBIOS / LLMNR / DNS / hosts file — not just PTR)
  const unresolved = enrichedResults.filter(r => r.online && !r.hostname);
  if (unresolved.length > 0) {
    try {
      const ipList = unresolved.map(r => "'" + r.ip + "'").join(',');
      const psScript = `
        $ErrorActionPreference = 'SilentlyContinue'
        $ips = @(${ipList})
        $results = @()
        foreach ($ip in $ips) {
          try {
            $hostEntry = [System.Net.Dns]::GetHostEntry($ip)
            $name = if ($hostEntry.HostName) { $hostEntry.HostName } else { '' }
            $results += @{ ip = $ip; hostname = $name }
          } catch { $results += @{ ip = $ip; hostname = '' } }
        }
        Write-Output ('<<<JSON>>>' + ($results | ConvertTo-Json -Compress) + '<<<END>>>')
      `;
      const psResult = await runPowerShell(psScript, 30000);
      const markerMatch = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(psResult.stdout || '');
      if (markerMatch) {
        try {
          const resolved = JSON.parse(markerMatch[1]);
          if (Array.isArray(resolved)) {
            const lookup = {};
            resolved.forEach(item => { if (item.hostname) lookup[item.ip] = item.hostname; });
            for (const r of enrichedResults) {
              if (lookup[r.ip]) r.hostname = lookup[r.ip];
            }
          }
        } catch {}
      }
    } catch {}
  }

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
  const hostList = [...new Set(hostnames.map(sanitizeHost).filter(Boolean))].slice(0, 500);
  const results = await pstools.pingParallel(hostList, 10, 4000);
  const formatted = results.map(r => ({
    hostname: r.ip, // r.ip is actually the hostname here
    online: r.online,
    status: r.online ? 'online' : 'offline',
  }));
  res.json({ success: true, data: JSON.stringify(formatted), results: formatted });
});

// ==========================================================================
// BATCH HOST INFO — Pull live data (OS, build, disk, logged-in user) for
// multiple hosts via PsExec + PowerShell. Used by the Frontend Refresh button.
// ==========================================================================
app.post('/api/hosts/batch-info', async (req, res) => {
  const { hostnames } = req.body;
  if (!Array.isArray(hostnames) || hostnames.length === 0) {
    return res.json({ success: true, data: [] });
  }
  const hostList = hostnames.map(sanitizeHost).filter(Boolean).slice(0, 100);
  const cred = getGlobalCredentials();

  // Run in parallel chunks of 8 to avoid overwhelming the network
  const CHUNK = 8;
  const results = [];
  for (let i = 0; i < hostList.length; i += CHUNK) {
    const chunk = hostList.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(chunk.map(async (hostname) => {
      // Single PowerShell script that gets everything we need
      const script = `
        $ErrorActionPreference = 'SilentlyContinue'
        try {
          $os = Get-CimInstance Win32_OperatingSystem
          $cs = Get-CimInstance Win32_ComputerSystem
          $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
          $user = (Get-CimInstance Win32_ComputerSystem).UserName
          $result = @{
            hostname = $env:COMPUTERNAME
            osName = $os.Caption
            osVersion = $os.Version
            osBuild = $os.BuildNumber
            diskUsedGb = if ($disk) { [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1) } else { 0 }
            loggedOnUser = if ($user) { $user } else { '' }
          }
          Write-Output ('<<<JSON>>>' + ($result | ConvertTo-Json -Compress) + '<<<END>>>')
        } catch {
          Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
        }
      `;
      const result = await powershell.runRemoteViaPsExec(hostname, script, PSTOOLS_PATH, 30000, cred);
      const markerMatch = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(result.stdout || '');
      if (markerMatch) {
        try { return JSON.parse(markerMatch[1]); }
        catch (e) { return { hostname, error: 'JSON parse: ' + e.message }; }
      }
      return { hostname, error: 'No data', offline: !result.success };
    }));
    results.push(...chunkResults);
  }

  res.json({ success: true, data: results });
});

// ==========================================================================
// WINDOWS UPDATES — Real scan/download/install via PSWindowsUpdate on target
// NOTE: PSWindowsUpdate module must be installed on TARGET PCs (or at least
// the server if we fall back). The commands run via PsExec + PowerShell on
// each target, so NO WinRM is required.
// ==========================================================================
app.post('/api/updates/scan', async (req, res) => {
  const { hostnames } = req.body;
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();
  const results = [];

  for (const rawHost of hostnames) {
    const safeHost = sanitizeHost(rawHost);
    const script = `
      $ErrorActionPreference = 'Stop'
      Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
      try {
        $updates = Get-WindowsUpdate -ErrorAction Stop
        $upt = $updates | Select-Object KB, Title, Size, MsrcSeverity, Category
        $json = $upt | ConvertTo-Json -Compress -Depth 3
        $critical = ($updates | Where-Object { \$_.MsrcSeverity -eq 'Critical' }).Count
        $security = ($updates | Where-Object { \$_.MsrcSeverity -eq 'Important' }).Count
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","status":"scanned","updateCount":' + ($updates.Count) + ',"critical":' + $critical + ',"security":' + $security + ',"updates":' + $json + '}<<<END>>>')
      } catch {
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","status":"failed","error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
      }
    `;
    const r = await runRemotePowerShellJson(safeHost, script, 120000);
    results.push(r.json || { hostname: safeHost, status: 'failed', error: r.stderr || r.jsonError || 'Unknown error' });
    audit.add(db, { actionType: 'update.scan', targetHost: safeHost, tool: 'psexec+powershell+PSWindowsUpdate', command: `Get-WindowsUpdate on ${safeHost}`, success: r.success, durationMs: Date.now() - startTime, outputSummary: r.json?.status || '', errorReason: r.json?.error || r.stderr, initiatedBy: 'admin', initiatedFrom });
  }
  res.json({ success: results.every(r => r.status !== 'failed'), data: JSON.stringify(results), error: results.find(r => r.error)?.error });
});

app.post('/api/updates/download', async (req, res) => {
  const { hostnames, kbFilter } = req.body;
  const results = [];
  for (const rawHost of hostnames) {
    const safeHost = sanitizeHost(rawHost);
    const script = `
      $ErrorActionPreference = 'Stop'
      Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
      try {
        ${kbFilter ? `$updates = Get-WindowsUpdate -KBArticleID '${sanitizeHost(kbFilter)}' -Download -ErrorAction Stop` : 'Get-WindowsUpdate -Download -AcceptAll -ErrorAction Stop'}
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","status":"downloaded"}<<<END>>>')
      } catch {
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","status":"failed","error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
      }
    `;
    const r = await runRemotePowerShellJson(safeHost, script, 300000);
    results.push(r.json || { hostname: safeHost, status: 'failed', error: r.stderr });
    audit.add(db, { actionType: 'update.download', targetHost: safeHost, tool: 'psexec+powershell+PSWindowsUpdate', command: `Download updates on ${safeHost}`, success: r.success, durationMs: 0, outputSummary: r.json?.status || '', errorReason: r.json?.error || r.stderr, initiatedBy: 'admin', initiatedFrom: req.ip });
  }
  res.json({ success: results.every(r => r.status !== 'failed'), data: JSON.stringify(results), error: results.find(r => r.error)?.error });
});

app.post('/api/updates/install', async (req, res) => {
  const { hostnames, kbFilter, classification, rebootBehavior } = req.body;
  const results = [];
  for (const rawHost of hostnames) {
    const safeHost = sanitizeHost(rawHost);
    const rebootParam = rebootBehavior === 'always' || rebootBehavior === 'if-required' ? '-AutoReboot' : '';
    const kbParam = kbFilter ? `-KBArticleID '${sanitizeHost(kbFilter)}'` : '';
    const catParam = classification ? `-Category '${sanitizeHost(classification)}'` : '';
    const script = `
      $ErrorActionPreference = 'Stop'
      Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
      try {
        Install-WindowsUpdate ${kbParam} ${catParam} -Install -AcceptAll ${rebootParam} -ErrorAction Stop
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","status":"installed","rebootRequired":false}<<<END>>>')
      } catch {
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","status":"failed","error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
      }
    `;
    const r = await runRemotePowerShellJson(safeHost, script, 600000);
    results.push(r.json || { hostname: safeHost, status: 'failed', error: r.stderr });
    audit.add(db, { actionType: 'update.install', targetHost: safeHost, tool: 'psexec+powershell+PSWindowsUpdate', command: `Install updates on ${safeHost}`, success: r.success, durationMs: 0, outputSummary: r.json?.status || '', errorReason: r.json?.error || r.stderr, initiatedBy: 'admin', initiatedFrom: req.ip });
  }
  res.json({ success: results.every(r => r.status !== 'failed'), data: JSON.stringify(results), error: results.find(r => r.error)?.error });
});

app.post('/api/updates/history', async (req, res) => {
  const { hostnames } = req.body;
  const results = [];
  for (const rawHost of hostnames) {
    const safeHost = sanitizeHost(rawHost);
    const script = `
      $ErrorActionPreference = 'Stop'
      Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
      try {
        $history = Get-WUHistory -ErrorAction Stop | Select-Object KB, Title, Date, Result
        $json = $history | ConvertTo-Json -Compress -Depth 3
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","updates":' + $json + '}<<<END>>>')
      } catch {
        Write-Output ('<<<JSON>>>{"hostname":"' + $env:COMPUTERNAME + '","error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
      }
    `;
    const r = await runRemotePowerShellJson(safeHost, script, 60000);
    results.push(r.json || { hostname: safeHost, error: r.stderr });
    audit.add(db, { actionType: 'update.history', targetHost: safeHost, tool: 'psexec+powershell+PSWindowsUpdate', command: `Get-WUHistory on ${safeHost}`, success: r.success, durationMs: 0, outputSummary: r.json?.updates ? 'OK' : '', errorReason: r.json?.error || r.stderr, initiatedBy: 'admin', initiatedFrom: req.ip });
  }
  res.json({ success: results.every(r => !r.error), data: JSON.stringify(results), error: results.find(r => r.error)?.error });
});

// ==========================================================================
// SCRIPTS & COMMANDS — Real remote execution
// ==========================================================================
app.post('/api/scripts/execute', async (req, res) => {
  const { hostnames, script: userScript, language, timeout } = req.body;
  const timeoutSec = timeout || 60;
  const results = [];
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const scriptStartTime = Date.now();

  for (const rawHost of hostnames) {
    const safeHost = sanitizeHost(rawHost);
    const hostStartTime = Date.now();

    // Use PsExec + PowerShell with global credentials (NO WinRM)
    const psexecResult = await powershell.runRemoteViaPsExec(safeHost, userScript, PSTOOLS_PATH, timeoutSec * 1000, getGlobalCredentials());
    if (psexecResult.success) {
      results.push({ hostname: safeHost, success: true, output: psexecResult.stdout, method: 'psexec', duration: Date.now() - hostStartTime });
      audit.add(db, {
        actionType: 'script.run',
        targetHost: safeHost,
        tool: 'psexec+powershell',
        command: userScript.substring(0, 500),
        success: true,
        durationMs: Date.now() - hostStartTime,
        outputSummary: (psexecResult.stdout || '').substring(0, 500),
        initiatedBy: 'admin',
        initiatedFrom,
        parameters: { language, method: 'psexec', scriptLength: userScript.length },
      });
    } else {
      results.push({
        hostname: safeHost, success: false,
        error: `PsExec failed: ${psexecResult.error || psexecResult.reason || psexecResult.stderr}`,
        psexecError: psexecResult,
        duration: Date.now() - hostStartTime,
      });
      audit.add(db, {
        actionType: 'script.run',
        targetHost: safeHost,
        tool: 'psexec+powershell',
        command: userScript.substring(0, 500),
        success: false,
        durationMs: Date.now() - hostStartTime,
        errorReason: psexecResult.error || psexecResult.reason || psexecResult.stderr,
        requiredService: psexecResult.service || 'Admin$ share',
        fixSuggestion: psexecResult.fix || 'Ensure PsTools path is correct and Admin$ share is accessible',
        initiatedBy: 'admin',
        initiatedFrom,
        parameters: { language, scriptLength: userScript.length },
      });
    }
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
  const safeHost = sanitizeHost(hostname);
  const cred = getGlobalCredentials();

  // 1st: Try PowerShell via PsExec (full detail: Name, DisplayName, Status, StartType)
  const psScript = `
    $ErrorActionPreference = 'Stop'
    $result = $null
    try {
      $svcs = Get-Service | Select-Object Name, DisplayName, Status, StartType
      $result = @($svcs) | ForEach-Object { @{ Name = $_.Name; DisplayName = $_.DisplayName; State = $_.Status.ToString(); StartMode = $_.StartType.ToString(); StartName = '' } }
    } catch {
      $result = @{ error = $_.Exception.Message }
    }
    if ($result -is [array]) { Write-Output ('<<<JSON>>>' + ($result | ConvertTo-Json -Compress -Depth 3) + '<<<END>>>') }
    else { Write-Output ('<<<JSON>>>' + ($result | ConvertTo-Json -Compress) + '<<<END>>>') }
  `;
  const psResult = await runRemotePowerShellJson(safeHost, psScript, 30000);
  if (psResult.success && psResult.json && Array.isArray(psResult.json)) {
    return res.json({ success: true, data: JSON.stringify(psResult.json), error: null, method: 'psexec+powershell' });
  }

  // 2nd: Fall back to psservice.exe over RPC (works without Admin$)
  const fqHost = safeHost.includes('.') ? safeHost : (cred?.domain ? safeHost + '.' + cred.domain : safeHost);
  const svcResult = await pstools.runGeneric('psservice', fqHost, ['query'], 30000, cred);
  if (svcResult.success && svcResult.stdout) {
    const services = parsePsServiceQuery(svcResult.stdout);
    if (services.length > 0) {
      return res.json({ success: true, data: JSON.stringify(services), error: null, method: 'psservice' });
    }
  }

  res.json({ success: false, data: '[]', error: svcResult.reason || psResult.stderr || 'Failed to list services', method: 'none' });
});

// Parse psservice query output: SERVICE_NAME + DISPLAY_NAME + STATE blocks
function parsePsServiceQuery(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const services = [];
  const blocks = out.split(/SERVICE_NAME:\s*/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const nameMatch = block.match(/^(\S+)/);
    const dispMatch = block.match(/DISPLAY_NAME:\s*(.+)/);
    const stateMatch = block.match(/STATE\s*:\s*\d+\s+(\w+)/);
    if (nameMatch) {
      services.push({
        Name: nameMatch[1],
        DisplayName: dispMatch ? dispMatch[1].trim() : nameMatch[1],
        State: stateMatch ? stateMatch[1] : 'Unknown',
        StartMode: '',
        StartName: '',
      });
    }
  }
  return services;
}

app.post('/api/services/:hostname/action', async (req, res) => {
  const { hostname } = req.params;
  const { serviceName, action } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeService = sanitizeHost(serviceName);
  const cred = getGlobalCredentials();
  const fqHost = safeHost.includes('.') ? safeHost : (cred?.domain ? safeHost + '.' + cred.domain : safeHost);

  // 1st: Try psservice.exe over RPC (works without Admin$)
  const actionCmd = action === 'start' ? 'start' : action === 'stop' ? 'stop' : action === 'restart' ? 'restart' : null;
  if (actionCmd) {
    const svcResult = await pstools.runGeneric('psservice', fqHost, [actionCmd, safeService], 20000, cred);
    if (svcResult.success) {
      return res.json({ success: true, data: svcResult.stdout, method: 'psservice' });
    }
  }

  // 2nd: Fall back to PowerShell via PsExec
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      switch ('${action}') {
        'start'   { Start-Service   -Name '${safeService}' }
        'stop'    { Stop-Service    -Name '${safeService}' -Force }
        'restart' { Restart-Service -Name '${safeService}' -Force }
        default   { throw "Unknown action: ${action}" }
      }
      Write-Output '<<<JSON>>>{"success":true,"state":"${action === 'stop' ? 'Stopped' : 'Running'}"}<<<END>>>'
    } catch {
      Write-Output ('<<<JSON>>>{"success":false,"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
    }
  `;
  const result = await runRemotePowerShellJson(safeHost, script, 30000);
  res.json({ success: result.json?.success ?? false, data: result.stdout, error: result.json?.error || result.stderr, method: 'psexec+powershell' });
});

app.post('/api/processes/:hostname/list', async (req, res) => {
  const { hostname } = req.params;
  const safeHost = sanitizeHost(hostname);
  const cred = getGlobalCredentials();
  const fqHost = safeHost.includes('.') ? safeHost : (cred?.domain ? safeHost + '.' + cred.domain : safeHost);

  // 1st: pslist.exe over RPC (PsTool, no Admin$ needed)
  const psListRes = await pstools.runGeneric('pslist', fqHost, [], 30000, cred);
  if (psListRes.success && psListRes.stdout) {
    const procs = parsePsList(psListRes.stdout);
    if (procs.length > 0) {
      return res.json({ success: true, data: JSON.stringify(procs), method: 'pslist' });
    }
  }

  // 2nd: Fall back to PowerShell via PsExec
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      $ps = Get-Process | Select-Object Id, Name, WorkingSet, TotalProcessorTime, StartTime
      $result = @($ps) | ForEach-Object {
        @{ ProcessId = $_.Id; Name = $_.Name; MemMB = [math]::Round($_.WorkingSet / 1MB, 1); CPU = $_.TotalProcessorTime.TotalSeconds; CreationDate = if ($_.StartTime) { $_.StartTime.ToString('o') } else { $null } }
      }
      Write-Output ('<<<JSON>>>' + ($result | ConvertTo-Json -Compress -Depth 3) + '<<<END>>>')
    } catch {
      Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
    }
  `;
  const result = await runRemotePowerShellJson(safeHost, script, 30000);
  if (result.success && result.json) {
    return res.json({ success: true, data: JSON.stringify(result.json), method: 'psexec+powershell' });
  }
  res.json({ success: false, data: '[]', error: result.stderr || psListRes.stderr || 'Failed to list processes', method: 'none' });
});

// Parse pslist.exe output into structured process objects
function parsePsList(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const lines = out.split('\n');
  const procs = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^pslist v/i.test(trimmed) || /^Copyright/i.test(trimmed) || /^Sysinternals/i.test(trimmed)) continue;
    if (/process information for/i.test(trimmed)) continue;
    if (/^Name\s+Pid\s+Pri/i.test(trimmed)) { inTable = true; continue; }
    if (!inTable) continue;
    // Parse: Name Pid Pri Thd Hnd Priv CPU_Time Elapsed_Time
    const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+([\d:.]+)/);
    if (m) {
      const memKB = parseInt(m[6], 10) || 0;
      const cpuParts = (m[7] || '0:0:0').split(':');
      const cpuSec = (parseInt(cpuParts[0]) * 3600) + (parseInt(cpuParts[1]) * 60) + parseFloat(cpuParts[2] || 0);
      procs.push({
        ProcessId: parseInt(m[2], 10),
        Name: m[1],
        MemMB: Math.round(memKB / 1024 * 10) / 10,
        CPU: Math.round(cpuSec * 10) / 10,
        CreationDate: null,
      });
    }
  }
  return procs;
}

app.post('/api/processes/:hostname/kill', async (req, res) => {
  const { hostname } = req.params;
  const { pid, name } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safePid = parseInt(pid, 10);
  const cred = getGlobalCredentials();
  const fqHost = safeHost.includes('.') ? safeHost : (cred?.domain ? safeHost + '.' + cred.domain : safeHost);

  if (!safePid && !name) return res.json({ success: false, error: 'PID or process name required' });

  // 1st: pskill.exe over RPC (PsTool, no Admin$ needed)
  const killTarget = safePid ? String(safePid) : String(sanitizeHost(name));
  const psKillRes = await pstools.runGeneric('pskill', fqHost, [killTarget], 15000, cred);
  if (psKillRes.success) {
    return res.json({ success: true, data: psKillRes.stdout, method: 'pskill' });
  }

  // 2nd: Fall back to PowerShell via PsExec
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      Stop-Process -Id ${safePid} -Force
      Write-Output ('<<<JSON>>>{"hostname":"${safeHost}","pid":${safePid},"killed":true}<<<END>>>')
    } catch {
      Write-Output ('<<<JSON>>>{"hostname":"${safeHost}","pid":${safePid},"killed":false,"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
    }
  `;
  const result = await runRemotePowerShellJson(safeHost, script, 15000);
  res.json({ success: result.json?.killed ?? false, data: result.stdout, error: result.json?.error || result.stderr, method: 'psexec+powershell' });
});

// ==========================================================================
// POWER MANAGEMENT — Restart / Stop / Wake-on-LAN
// ==========================================================================
app.post('/api/power/action', async (req, res) => {
  const { hostname, action } = req.body;
  const safeHost = sanitizeHost(hostname);
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  const startTime = Date.now();

  let exeArgs = [];
  const cred = getGlobalCredentials();
  const fqHost = safeHost.includes('.') ? safeHost : (cred?.domain ? safeHost + '.' + cred.domain : safeHost);
  const userArgs = cred ? pstools.credentialArgs(cred, fqHost) : [];

  if (action === 'reboot') {
    exeArgs = ['\\\\' + fqHost, ...userArgs, '-r', '-t', '5', '-f', '-accepteula'];
  } else if (action === 'shutdown') {
    exeArgs = ['\\\\' + fqHost, ...userArgs, '-s', '-t', '5', '-f', '-accepteula'];
  } else if (action === 'startup') {
    return res.json({ success: false, error: 'Cannot power on via psshutdown — use Wake-on-LAN /api/power/wol endpoint' });
  } else {
    return res.json({ success: false, error: 'Unknown action: ' + action });
  }

  const result = await new Promise((resolve) => {
    const proc = spawn(pstoolsExe('psshutdown.exe'), exeArgs, { windowsHide: true, timeout: 20000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => resolve({ success: code === 0, stdout, stderr }));
    proc.on('error', err => resolve({ success: false, stdout: '', stderr: err.message }));
    setTimeout(() => { try { proc.kill(); } catch {} }, 22000);
  });
  // Audit log — power action
  audit.add(db, {
    actionType: 'power.' + action,
    targetHost: fqHost,
    tool: 'psshutdown',
    command: `psshutdown ${action} on ${fqHost}`,
    success: result.success,
    durationMs: Date.now() - startTime,
    outputSummary: result.stdout ? result.stdout.substring(0, 500) : '',
    errorReason: result.success ? null : result.stderr,
    initiatedBy: 'admin',
    initiatedFrom,
    parameters: { action },
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
  const cred = credential || getGlobalCredentials();
  const hostList = hostnames.map(sanitizeHost);

  // Run Reset-LapsPassword on each host locally via PsExec + PowerShell
  const results = [];
  for (const h of hostList) {
    const script = `try { Reset-LapsPassword -ErrorAction Stop; Write-Output '{"rotated":true,"method":"modern"}' } catch { try { Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\LAPS" -ErrorAction SilentlyContinue; Write-Output '{"rotated":false,"error":"LAPS not supported on this host"}' } catch { Write-Output '{"rotated":false,"error":"' + ($_.Exception.Message -replace '"','') + '"}' } }`;
    const r = await runRemotePowerShellJson(h, script, 60000);
    results.push({ hostname: h, ...(r.json || { rotated: false, error: r.jsonError || r.stderr }) });
  }

  res.json({ success: true, data: results });
});

// ==========================================================================
// SOFTWARE DEPLOYMENT
// ==========================================================================
app.post('/api/deploy/package', async (req, res) => {
  const { hostnames, packagePath, arguments: args, credential, rebootBehavior } = req.body;
  const cred = credential || getGlobalCredentials();
  const hostList = hostnames.map(sanitizeHost);
  const packageFile = (packagePath || '').split(/[\\/]/).pop();
  const safeArgs = (args || '').replace(/"/g, '\\"');
  const safePackagePath = (packagePath || '').replace(/'/g, "''");

  const results = [];
  for (const h of hostList) {
    try {
      // Copy package to remote host via SMB admin share (server→target UNC)
      const copyScript = `Copy-Item '${safePackagePath}' "\\\\${h}\\C$\\Temp\\${packageFile}" -Force -ErrorAction Stop`;
      const copyResult = await runPowerShell(copyScript, 60000);
      if (!copyResult.success) {
        results.push({ hostname: h, success: false, error: copyResult.stderr || 'Failed to copy package' });
        continue;
      }

      // Execute remotely via PsExec
      const execCmd = `"C:\\Temp\\${packageFile}" ${safeArgs}`;
      const execR = await pstools.runPsExec(h, 'cmd.exe', ['/c', execCmd], 120000, cred);
      const output = { hostname: h, success: execR.success, output: execR.stdout };
      results.push(output);

      // Reboot if configured
      if (rebootBehavior === 'always' && execR.success) {
        const rebootR = await pstools.runGeneric('psshutdown', h, ['-r', '-t', '10', '-f'], 15000, cred);
        output.rebooted = rebootR.success;
      }
    } catch (e) {
      results.push({ hostname: h, success: false, error: e.message });
    }
  }

  res.json({ success: true, data: results });
});

// Alias: /api/deployments/run → /api/deploy/package (frontend compatibility)
app.post('/api/deployments/run', async (req, res) => { req.url = '/api/deploy/package'; app.handle(req, res); });
// ==========================================================================
app.post('/api/queues/execute', async (req, res) => {
  const { steps, hostnames, credential, errorHandling, queueName } = req.body;
  const jobId = 'job-' + Date.now();

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
              script = `try { Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; $u = Get-WindowsUpdate -ErrorAction Stop; Write-Output ('<<<JSON>>>' + ($u | Select-Object KB,Title | ConvertTo-Json -Compress) + '<<<END>>>') } catch { Write-Output ('<<<JSON>>>[]<<<END>>>') }`;
              const cu = await runRemotePowerShellJson(hostname, script, 120000);
              stepResult = { success: cu.success, output: JSON.stringify(cu.json || []), error: cu.jsonError || cu.stderr };
              break;
            case 'download-updates':
              script = `try { Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; Get-WindowsUpdate -Download -AcceptAll -ErrorAction Stop; Write-Output '<<<JSON>>>{"status":"downloaded"}<<<END>>>' } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
              const du = await runRemotePowerShellJson(hostname, script, 300000);
              stepResult = { success: du.success, output: du.json?.status || '', error: du.json?.error || du.stderr };
              break;
            case 'install-all':
            case 'install-updates':
              script = `try { Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; Install-WindowsUpdate -Install -AcceptAll -AutoReboot -ErrorAction Stop; Write-Output '<<<JSON>>>{"status":"installed"}<<<END>>>' } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
              const iu = await runRemotePowerShellJson(hostname, script, 600000);
              stepResult = { success: iu.success, output: iu.json?.status || '', error: iu.json?.error || iu.stderr };
              break;
            case 'reboot':
              const rebootResult = await pstools.runGeneric('psshutdown', hostname, ['-r', '-t', '5', '-f'], 20000, getGlobalCredentials());
              stepResult = { success: rebootResult.success, output: rebootResult.stdout, error: rebootResult.stderr };
              break;
            case 'shutdown':
              const shutdownResult = await pstools.runGeneric('psshutdown', hostname, ['-s', '-t', '5', '-f'], 20000, getGlobalCredentials());
              stepResult = { success: shutdownResult.success, output: shutdownResult.stdout, error: shutdownResult.stderr };
              break;
            case 'wait-for-online':
              script = `for ($i=0; $i -lt 60; $i++) { if (Test-Connection -ComputerName '${hostname}' -Count 1 -Quiet) { Write-Output '<<<JSON>>>{"online":true}<<<END>>>'; exit 0 }; Start-Sleep -Seconds 5 }; Write-Output '<<<JSON>>>{"online":false,"error":"Timed out after 5 min"}<<<END>>>'`;
              const wo = await runRemotePowerShellJson(hostname, script, 310000);
              stepResult = { success: wo.json?.online || false, output: JSON.stringify(wo.json || {}), error: wo.json?.error || wo.stderr };
              break;
            case 'run-command':
              if (step.config?.code) {
                const cmdResult = await powershell.runRemoteViaPsExec(hostname, step.config.code, PSTOOLS_PATH, 300000, getGlobalCredentials());
                stepResult = { success: cmdResult.success, output: cmdResult.stdout, error: cmdResult.stderr };
              }
              break;
            case 'start-service':
              if (step.config?.serviceName) {
                script = `try { Start-Service -Name '${sanitizeHost(step.config.serviceName)}' -ErrorAction Stop; Write-Output '<<<JSON>>>{"state":"Running"}<<<END>>>' } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
                const svcR = await runRemotePowerShellJson(hostname, script, 30000);
                stepResult = { success: svcR.success, output: JSON.stringify(svcR.json || {}), error: svcR.json?.error || svcR.stderr };
              }
              break;
            case 'stop-service':
              if (step.config?.serviceName) {
                script = `try { Stop-Service -Name '${sanitizeHost(step.config.serviceName)}' -Force -ErrorAction Stop; Write-Output '<<<JSON>>>{"state":"Stopped"}<<<END>>>' } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
                const svcR = await runRemotePowerShellJson(hostname, script, 30000);
                stepResult = { success: svcR.success, output: JSON.stringify(svcR.json || {}), error: svcR.json?.error || svcR.stderr };
              }
              break;
            case 'restart-service':
              if (step.config?.serviceName) {
                script = `try { Restart-Service -Name '${sanitizeHost(step.config.serviceName)}' -Force -ErrorAction Stop; Write-Output '<<<JSON>>>{"state":"Running"}<<<END>>>' } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
                const svcR = await runRemotePowerShellJson(hostname, script, 30000);
                stepResult = { success: svcR.success, output: JSON.stringify(svcR.json || {}), error: svcR.json?.error || svcR.stderr };
              }
              break;
            case 'psexec-run':
              if (step.config?.command) {
                const psexecResult = await pstools.runPsExec(hostname, 'cmd.exe', ['/c', step.config.command], 60000, getGlobalCredentials());
                stepResult = { success: psexecResult.success, output: psexecResult.stdout, error: psexecResult.stderr };
              }
              break;
            case 'wait-minutes':
              await new Promise(r => setTimeout(r, (step.config?.minutes || 1) * 60000));
              stepResult = { success: true, output: `Waited ${step.config?.minutes || 1} minute(s)` };
              break;
            default:
              stepResult = { success: false, error: `Unknown step type: ${step.type}` };
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
        } catch (e) {
          stepResult = { success: false, error: e.message };
          completed++;
          broadcastUpdate({ type: 'queue-step-complete', jobId, step: step.type, stepIndex: si, hostname, hostIndex: hi, completed, total: totalSteps, success: false, output: '', error: e.message, status: 'failed' });
          if (errorHandling === 'stop') {
            broadcastUpdate({ type: 'queue-aborted', jobId, reason: 'Step threw exception and errorHandling=stop', step, hostname, completed, total: totalSteps });
            return;
          }
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
  const safeHost = sanitizeHost(hostname);
  const cred = credential || getGlobalCredentials();
  const extraArgs = (args || '').split(/\s+/).filter(Boolean);
  const result = await pstools.runGeneric(tool, safeHost, extraArgs, 60000, cred);
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
  const fqHost = safeHost.includes('.') ? safeHost : (getGlobalCredentials()?.domain ? safeHost + '.' + getGlobalCredentials().domain : safeHost);

  try {
    // 1st: Try PsExec + reg query (full detail from registry)
    const [reg64Res, reg32Res, regUserRes] = await Promise.all([
      pstools.runPsExec(fqHost, 'reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000, getGlobalCredentials()),
      pstools.runPsExec(fqHost, 'reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000, getGlobalCredentials()),
      pstools.runPsExec(fqHost, 'reg.exe', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], 30000, getGlobalCredentials()),
    ]);

    if (reg64Res.success || reg32Res.success || regUserRes.success) {
      const apps64 = parseRegUninstall(reg64Res.stdout);
      const apps32 = parseRegUninstall(reg32Res.stdout);
      const appsUser = parseRegUninstall(regUserRes.stdout);
      const allApps = [...apps64, ...apps32, ...appsUser];
      const seen = new Set();
      const deduped = allApps.filter(a => {
        const key = (a.name + '|' + (a.version || '')).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      audit.add(db, { actionType: 'apps.list', targetHost: safeHost, tool: 'psexec+reg', command: `reg query Uninstall keys on ${safeHost}`, success: true, durationMs: Date.now() - startTime, outputSummary: `Found ${deduped.length} apps`, initiatedBy: 'admin', initiatedFrom });
      return res.json({ success: true, apps: deduped, count: deduped.length, method: 'psexec+reg', sources: { '64bit': apps64.length, '32bit': apps32.length, 'user': appsUser.length } });
    }

    // 2nd: Fall back to psinfo -s (installed software via remote registry/WMI)
    const psInfoRes = await pstools.runPsInfo(fqHost, ['-s', '-c'], 30000, getGlobalCredentials());
    if (psInfoRes.success && psInfoRes.stdout) {
      const tokens = psInfoRes.stdout.split(/[\n,]/).map(t => t.trim());
      let foundSoftware = false;
      const apps = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        if (!foundSoftware && /^n\/a/i.test(token)) { foundSoftware = true; continue; }
        if (!foundSoftware && token.match(/KB\d+/i)) continue;
        if (!foundSoftware && tokens[i - 1] && tokens[i - 1].match(/KB\d+/i) && i > 0) {
          foundSoftware = true;
        }
        if (foundSoftware && !token.match(/KB\d+/i)) apps.push({ name: token });
      }
      const deduped = apps.filter((a, idx) => apps.findIndex(x => x.name === a.name) === idx).sort((a, b) => a.name.localeCompare(b.name));
      audit.add(db, { actionType: 'apps.list', targetHost: safeHost, tool: 'psinfo', command: `psinfo -s on ${safeHost}`, success: true, durationMs: Date.now() - startTime, outputSummary: `Found ${deduped.length} apps`, initiatedBy: 'admin', initiatedFrom });
      return res.json({ success: true, apps: deduped, count: deduped.length, method: 'psinfo' });
    }

    // 3rd: Fall back to wmic DCOM — query Win32_Product
    const wmiRes = await wmic.runRemote(fqHost, 'product', 'name,version,vendor', 30000, getGlobalCredentials());
    if (wmiRes.success && wmiRes.records && wmiRes.records.length > 0) {
      const apps = wmiRes.records.map(r => ({
        name: (r.Name || r.name || '').trim(),
        version: (r.Version || r.version || '').trim(),
        publisher: (r.Vendor || r.vendor || '').trim(),
      })).filter(a => a.name).sort((a, b) => a.name.localeCompare(b.name));
      audit.add(db, { actionType: 'apps.list', targetHost: safeHost, tool: 'wmic', command: `wmic product get name,version on ${safeHost}`, success: true, durationMs: Date.now() - startTime, outputSummary: `Found ${apps.length} apps`, initiatedBy: 'admin', initiatedFrom });
      return res.json({ success: true, apps, count: apps.length, method: 'wmic' });
    }

    res.json({ success: false, apps: [], error: 'All methods failed — PsExec blocked, psinfo unavailable, WMI inaccessible', method: 'none' });
  } catch (e) {
    audit.add(db, { actionType: 'apps.list', targetHost: safeHost, tool: 'multi', command: `List apps on ${safeHost}`, success: false, durationMs: Date.now() - startTime, errorReason: e.message, initiatedBy: 'admin', initiatedFrom });
    res.json({ success: false, apps: [], error: e.message });
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
//   1st: PsTools  (psinfo + psloggedon)        — PRIMARY, works without WinRM
//   2nd: PowerShell (via PsExec)                — extra data (motherboard, BIOS, RAM)
//   2b: systeminfo.exe over RPC                 — bypasses UAC/Admin$ (NO SMB needed)
//   2c: wmic /node:HOST over DCOM/RPC           — fills gaps: RAM sticks, disks, GPU
//   3rd: WinRM    (Invoke-Command)              — extra data if WinRM is available
//   4th: wmic     (via PsExec)                  — fallback for any remaining gaps
//
// PsTools provides (PRIMARY):
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
//   - RAM sticks: capacity, speed, manufacturer, part number
//   - Physical disks: model, size, interface, serial number
//   - GPU: VRAM, driver version
//
// systeminfo.exe fills these GAPS (2b priority, RPC-based — no Admin$):
//   - System: manufacturer, model, type, domain, RAM
//   - OS: name, version, install date, registered user/org
//   - BIOS: version, release date, manufacturer
//   - Processor: name, speed
//   - Hotfixes: KB numbers
//   - Network: IP, DHCP gateway
//
// wmic DCOM fills these GAPS (2c priority, DCOM/RPC — no Admin$):
//   - Motherboard: manufacturer, product, version, serial
//   - Individual RAM sticks: capacity, speed, manufacturer, part number
//   - Physical disks: model, size, interface, serial number
//   - Logical volumes: drive letters, size, free, filesystem
//   - GPU: name, adapter, VRAM, driver version
//   - Network: MAC addresses, full adapter details
//
// All commands are logged with error reasons (which service failed, how to fix)
// ==========================================================================
app.post('/api/hosts/:hostname/hardware', async (req, res) => {
  const safeHost = sanitizeHost(req.params.hostname);
  const hwCred = getGlobalCredentials();
  // Append domain suffix for short hostnames (PsExec needs FQDN)
  const fqHost = safeHost.includes('.') ? safeHost : (hwCred?.domain ? safeHost + '.' + hwCred.domain : safeHost);
    const results = {
      hostname: safeHost,
      scannedAt: new Date().toISOString(),
      hwVersion: 3, // bump on schema changes to invalidate old saved data
      system: {}, motherboard: {}, bios: {}, processor: null,
    memory: [], disks: [], logicalDisks: [], network: [], gpu: [],
    os: {}, hotfixes: [], software: [], loggedInUser: null, userProfilePath: null,
    osDisplayVersion: null, osUBR: null, opticalDrives: [], soundDevices: [],
    physicalNetworks: [], formattedSummary: null,
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
      pstools.runPsInfo(fqHost, ['-d', '-h', '-s', '-c'], 30000, hwCred),
      pstools.runPsLoggedOn(fqHost, 15000, hwCred),
    ]);

    // LOG debug output
    if (psinfoRes.success) {
      const dbg = '' + psinfoRes.stdout;
      results.rawOutputs = results.rawOutputs || {};
      results.rawOutputs.psInfo = dbg.length > 3000 ? dbg.substring(0, 3000) + '...' : dbg;
    }

    // Parse PsInfo output (it's a single comma-delimited line with -c flag)
    if (psinfoRes.success && psinfoRes.stdout) {
      results.methods.psinfo = 'success';
      const tokens = psinfoRes.stdout.split(/[\n,]/).map(t => t.trim());

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
      results.rawOutputs = results.rawOutputs || {};
      results.rawOutputs.psLoggedOn = loggedOnRes.stdout.substring(0, 2000);
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
    // physical disk details, network adapters. Use PowerShell locally via PsExec.
    // ========================================================================
    const psScript = `
Write-Output "PSTART=1"
$u=$env:USERNAME
Write-Output "USER=$u"
$up=$env:USERPROFILE;$up=$up -replace '\|','-';if($up){Write-Output "UP=$up"}
$reg=(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion");if($reg){Write-Output "REG=$($reg.DisplayVersion)|$($reg.CurrentBuild)|$($reg.UBR)"}
$cs=(Get-CimInstance Win32_ComputerSystem);if($cs){Write-Output "SYS=$($cs.Manufacturer)|$($cs.Model)|$($cs.SystemType)|$($cs.Domain)|$($cs.TotalPhysicalMemory)"}
$os=(Get-CimInstance Win32_OperatingSystem);if($os){Write-Output "OS=$($os.Caption)|$($os.OSArchitecture)|$($os.Version)|$($os.SerialNumber)"}
$mb=(Get-CimInstance Win32_BaseBoard);if($mb){Write-Output "MB=$($mb.Manufacturer)|$($mb.Product)|$($mb.Version)|$($mb.SerialNumber)"}
$bios=(Get-CimInstance Win32_BIOS);if($bios){Write-Output "BIOS=$($bios.Manufacturer)|$($bios.SMBIOSBIOSVersion)|$($bios.ReleaseDate)|$($bios.SerialNumber)"}
$cpu=(Get-CimInstance Win32_Processor);if($cpu){Write-Output "CPU=$($cpu.Name.Trim())|$($cpu.Manufacturer)|$($cpu.NumberOfCores)|$($cpu.NumberOfLogicalProcessors)|$($cpu.MaxClockSpeed)"}
$mem=@(Get-CimInstance Win32_PhysicalMemory);foreach($m in $mem){Write-Output "MEM=$([math]::Round($m.Capacity/1GB,1))|$($m.Manufacturer)|$($m.PartNumber)|$($m.Speed)|$($m.DeviceLocator)"}
$dsk=@(Get-CimInstance Win32_DiskDrive);foreach($d in $dsk){$sn=$d.SerialNumber;$sn="$sn".Trim();Write-Output "DISK=$($d.Index)|$($d.Model)|$([math]::Round($d.Size/1GB,0))|$($d.InterfaceType)|$sn"}
$gpu=@(Get-CimInstance Win32_VideoController);foreach($g in $gpu){Write-Output "GPU=$($g.Name)|$($g.AdapterCompatibility)|$([math]::Round($g.AdapterRAM/1MB,0))|$($g.DriverVersion)"}
$net=@(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True");foreach($n in $net){$ips=($n.IPAddress-join',');$gw=($n.DefaultIPGateway-join',');Write-Output "NET=$($n.Description)|$ips|$($n.MACAddress)|$gw|$($n.DHCPEnabled)"}
$vol=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3");foreach($v in $vol){Write-Output "VOL=$($v.DeviceID)|$($v.FileSystem)|$($v.VolumeName)|$([math]::Round($v.Size/1GB,1))|$([math]::Round($v.FreeSpace/1GB,1))"}
$dvd=@(Get-CimInstance Win32_CDROMDrive);if($dvd.Count -gt 0){foreach($d in $dvd){Write-Output "DVD=$($d.Drive)|$($d.Name)"}}else{Write-Output "DVD=None"}
$audio=@(Get-CimInstance Win32_SoundDevice);foreach($a in $audio){$an=""+$a.Name;$an=$an -replace '\|','-';Write-Output "AUD=$an"}
$pnet=@(Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True");foreach($p in $pnet){$pn=""+$p.Name;$pn=$pn -replace '\|','-';$pm=""+$p.MACAddress;$pm=$pm -replace '\|','-';Write-Output "PHYNET=$pn|$pm"}
Write-Output "PEND=1"
Write-Output "===SUMMARY_START==="
[PSCustomObject]@{
    "Logged-In User"        = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    "User Profile Path"     = $env:USERPROFILE
    "Windows Edition"       = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { $_.Caption })
    "Windows Version/Build" = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" | ForEach-Object { "Version: $($_.DisplayVersion) (OS Build: $($_.CurrentBuild).$($_.UBR))" })
    "OS Architecture"       = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { $_.OSArchitecture })
    "Corporate System Info" = (Get-CimInstance Win32_ComputerSystem | ForEach-Object { "$($_.Manufacturer) - Model: $($_.Model)" })
    "Motherboard Info"      = (Get-CimInstance Win32_BaseBoard | ForEach-Object { "Make: $($_.Manufacturer) | Board: $($_.Product)" })
    "BIOS & Firmware"       = (Get-CimInstance Win32_BIOS | ForEach-Object { "Vendor: $($_.Manufacturer) | Version: $($_.SMBIOSBIOSVersion) | Main S/N: $($_.SerialNumber)" })
    "Processor (CPU)"       = ((Get-CimInstance Win32_Processor | ForEach-Object { "$($_.Name.Trim()) ($($_.NumberOfCores) Cores / $($_.NumberOfLogicalProcessors) Threads)" }) -join ' | ')
    "Installed RAM Sticks"  = ((Get-CimInstance Win32_PhysicalMemory | ForEach-Object { "$($_.DeviceLocator): $([math]::round($_.Capacity/1GB))GB $($_.Speed)MHz ($($_.Manufacturer.Trim()))" }) -join ' | ')
    "Storage Drives (All)"  = ((Get-CimInstance Win32_DiskDrive | ForEach-Object { "Drive $($_.Index): $($_.Model) ($([math]::round($_.Size/1GB))GB)" }) -join ' | ')
    "Optical/DVD Drives"    = (if ($dvd = Get-CimInstance Win32_CDROMDrive) { ($dvd | ForEach-Object { "Drive $($_.Drive): $($_.Name)" }) -join ' | ' } else { "None Detected" })
    "Video/Graphics Cards"  = ((Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) (Driver v$($_.DriverVersion))" }) -join ' | ')
    "Network Interfaces"    = ((Get-CimInstance Win32_NetworkAdapter | Where-Object { $_.PhysicalAdapter } | ForEach-Object { "$($_.Name) [MAC: $($_.MACAddress)]" }) -join ' | ')
    "Sound/Audio Hardware"  = ((Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name }) -join ' | ')
} | Format-List | Out-String
    `.trim();

    const psResult = await powershell.runRemoteViaPsExec(fqHost, psScript, PSTOOLS_PATH, 45000, hwCred);

    if (psResult.success && psResult.stdout) {
      results.methods.powershell = 'success';
      const dbgPs = '' + psResult.stdout;
      results.rawOutputs = results.rawOutputs || {};
      results.rawOutputs.powershell = dbgPs.length > 3000 ? dbgPs.substring(0, 3000) + '...' : dbgPs;
      try {
        // Parse KEY=VALUE|VALUE|... lines
        const kv = {};
        for (const raw of psResult.stdout.split('\n')) {
          const line = raw.trim();
          if (!line || !line.includes('=')) continue;
          const eqIdx = line.indexOf('=');
          const key = line.substring(0, eqIdx).trim();
          const val = line.substring(eqIdx + 1).trim();
          if (!kv[key]) { kv[key] = val; }
          else if (Array.isArray(kv[key])) { kv[key].push(val); }
          else { kv[key] = [kv[key], val]; }
        }
        const getArr = (k) => { if (!kv[k]) return []; const v = kv[k]; return Array.isArray(v) ? v : [v]; };
        const pipe1 = (k) => { const a = getArr(k); return a.length > 0 ? a[0].split('|').map(s => s.trim()) : []; };

        // USER
        if (kv.USER) results.loggedInUser = kv.USER;

        // OS: Caption|Arch|Version|Serial
        const osp = pipe1('OS');
        if (osp[0]) results.os.name = osp[0];
        if (osp[1]) results.os.architecture = osp[1];
        if (osp[2]) results.os.build = osp[2];
        if (osp[3]) results.os.serial = osp[3];

        // SYS: MFR|MODEL|TYPE|DOMAIN|RAM
        const sys = pipe1('SYS');
        if (sys[0]) results.system.manufacturer = sys[0];
        if (sys[1]) results.system.model = sys[1];
        if (sys[2]) results.system.systemType = sys[2];
        if (sys[3]) results.system.domain = sys[3];
        if (sys[4]) { const b = parseInt(sys[4], 10); if (b > 0) results.system.totalRamMB = Math.round(b / (1024 * 1024)); }

        // MB: MFR|PROD|VER|SN
        const mbp = pipe1('MB');
        if (mbp[0] || mbp[1]) results.motherboard = { manufacturer: mbp[0] || '', product: mbp[1] || '', version: mbp[2] || '', serial: mbp[3] || '' };

        // BIOS: MFR|VER|DATE|SN
        const b = pipe1('BIOS');
        if (b[0] || b[1]) results.bios = { manufacturer: b[0] || '', version: b[1] || '', releaseDate: b[2] || '', serial: b[3] || '' };

        // CPU: NAME|MFR|CORES|THREADS|SPEED
        const cp = pipe1('CPU');
        if (cp[0]) {
          if (!results.processor) results.processor = {};
          results.processor.name = cp[0]; results.processor.manufacturer = cp[1] || '';
          results.processor.cores = parseInt(cp[2]) || 0; results.processor.threads = parseInt(cp[3]) || 0;
          results.processor.maxSpeedMHz = parseInt(cp[4]) || 0; results.processor.currentSpeedMHz = results.processor.maxSpeedMHz;
          results.processor.socketCount = 1; results.processor.socket = '';
        }

        // MEM: capGB|MFR|PN|speed|locator (multiple)
        results.memory = getArr('MEM').map(m => { const p = m.split('|').map(s => s.trim()); return { capacityGB: parseFloat(p[0]) || 0, manufacturer: p[1] || '', partNumber: p[2] || '', speed: parseInt(p[3]) || 0, deviceLocator: p[4] || '' }; });

        // DISK: index|model|sizeGB|iface|SN (multiple)
        results.disks = getArr('DISK').map(d => { const p = d.split('|').map(s => s.trim()); return { index: parseInt(p[0]) || 0, model: p[1] || '', sizeGB: parseFloat(p[2]) || 0, interfaceType: p[3] || '', serialNumber: p[4] || '', partitions: 0 }; });

        // GPU: name|compat|ramMB|driver (multiple)
        results.gpu = getArr('GPU').map(g => { const p = g.split('|').map(s => s.trim()); return { name: p[0] || '', manufacturer: p[1] || '', ramMB: parseInt(p[2]) || 0, driverVersion: p[3] || '', driverDate: '' }; });

        // NET: desc|ip|mac|gw|dhcp (multiple)
        results.network = getArr('NET').map(n => { const p = n.split('|').map(s => s.trim()); return { description: p[0] || '', ipAddress: p[1] || '', macAddress: p[2] || '', defaultGateway: p[3] || '', dhcpEnabled: (p[4] || '') === 'True', dnsServers: '' }; });

        // VOL: drive|FS|name|sizeGB|freeGB (multiple)
        results.logicalDisks = getArr('VOL').map(v => { const p = v.split('|').map(s => s.trim()); return { drive: p[0] || '', fileSystem: p[1] || '', volumeName: p[2] || '', sizeGB: parseFloat(p[3]) || 0, freeGB: parseFloat(p[4]) || 0 }; });

        // UP: user profile path
        const upPath = pipe1('UP');
        if (upPath[0]) results.userProfilePath = upPath[0];

        // REG: DisplayVersion|CurrentBuild|UBR
        const reg = pipe1('REG');
        if (reg[0]) results.osDisplayVersion = reg[0];
        if (reg[1]) results.os.build = reg[1]; // CurrentBuild overrides PsInfo build
        if (reg[2]) results.osUBR = reg[2];

        // DVD: drive|name (multiple, or "None")
        results.opticalDrives = getArr('DVD').filter(d => d !== 'None').map(d => { const p = d.split('|').map(s => s.trim()); return { drive: p[0] || '', name: p[1] || '' }; });

        // AUD: audio device names (multiple)
        results.soundDevices = getArr('AUD').filter(Boolean);

        // PHYNET: name|mac (multiple, physical adapters only)
        results.physicalNetworks = getArr('PHYNET').map(p => { const parts = p.split('|').map(s => s.trim()); return { name: parts[0] || '', macAddress: parts[1] || '' }; });

        // ── Force PowerShell data to take precedence over PsInfo ──
        // If PowerShell returned any system data, prefer it over PsInfo's guesses
        // RAM: use sum of individual sticks first (installed capacity, most accurate),
        // fall back to TotalPhysicalMemory from Win32_ComputerSystem (already in sys[4])
        if (results.methods.powershell === 'success') {
          const stickTotalGB = results.memory.reduce((s, m) => s + (m.capacityGB || 0), 0);
          if (stickTotalGB > 0) results.system.totalRamMB = stickTotalGB * 1024;
        }

        // ── Parse Format-List summary from user's PowerShell command ──
        // After PEND=1, the script outputs ===SUMMARY_START=== followed by
        // the Format-List output with "Label : Value" pairs
        const summaryMarker = '===SUMMARY_START===';
        const summaryIdx = psResult.stdout.indexOf(summaryMarker);
        if (summaryIdx !== -1) {
          const summaryBlock = psResult.stdout.substring(summaryIdx + summaryMarker.length).trim();
          const summaryLines = summaryBlock.split('\n').filter(Boolean);
          const formattedSummary = {};
          for (const rawLine of summaryLines) {
            const sepIdx = rawLine.indexOf(' : ');
            if (sepIdx !== -1) {
              const key = rawLine.substring(0, sepIdx).trim();
              const val = rawLine.substring(sepIdx + 3).trim();
              if (key && val) formattedSummary[key] = val;
            }
          }
          if (Object.keys(formattedSummary).length > 0) {
            results.formattedSummary = formattedSummary;
          }
        }
      } catch (e) {
        results.errors.push({ priority: 2, method: 'PowerShell', reason: 'Parse error: ' + e.message });
      }
    } else if (psResult.reason) {
      results.methods.powershell = 'failed';
      results.errors.push({ priority: 2, method: 'PowerShell', ...psResult });
    } else {
      results.methods.powershell = 'failed';
      results.errors.push({ priority: 2, method: 'PowerShell', reason: 'No output from PowerShell script' });
    }

    // ========================================================================
    // PRIORITY 2b: systeminfo.exe over RPC — bypasses UAC Admin$ restrictions
    // Runs when PsExec-based methods fail due to UAC/Admin$ block.
    // systeminfo.exe /S HOST uses RPC (port 135) — same protocol as PsLoggedOn.
    // Does NOT require Admin$ share, PsExec, or WinRM.
    // ========================================================================
    if (results.methods.powershell !== 'success' && results.methods.psinfo !== 'success') {
      const siResult = await pstools.runSystemInfo(fqHost, 45000, hwCred);
      if (siResult.success && siResult.parsed) {
        results.methods.systeminfo = 'success';
        results.rawOutputs = results.rawOutputs || {};
        results.rawOutputs.systeminfo = siResult.stdout.substring(0, 3000);
        const si = siResult.parsed;

        // — System —
        if (si['System Manufacturer'] && !results.system.manufacturer) results.system.manufacturer = si['System Manufacturer'];
        if (si['System Model'] && !results.system.model) results.system.model = si['System Model'];
        if (si['System Type'] && !results.system.systemType) results.system.systemType = si['System Type'];
        if (si['Domain'] && !results.system.domain) results.system.domain = si['Domain'];
        if (si['Total Physical Memory']) {
          const memMatch = /([\d,]+)\s*MB/i.exec(si['Total Physical Memory']);
          if (memMatch) {
            const ramMB = parseInt(memMatch[1].replace(/,/g, ''), 10);
            if (ramMB > 0 && !results.system.totalRamMB) results.system.totalRamMB = ramMB;
          }
        }

        // — OS —
        if (si['OS Name'] && !results.os.name) results.os.name = si['OS Name'];
        if (si['OS Version'] && !results.os.version) results.os.version = si['OS Version'];
        if (si['Registered Owner'] && !results.os.registeredUser) results.os.registeredUser = si['Registered Owner'];
        if (si['Registered Organization'] && !results.os.registeredOrg) results.os.registeredOrg = si['Registered Organization'];
        if (si['Original Install Date']) results.os.installDate = results.os.installDate || si['Original Install Date'];
        if (si['System Boot Time']) results.os.lastBoot = results.os.lastBoot || si['System Boot Time'];

        // — BIOS —
        if (si['BIOS Version']) {
          if (!results.bios.version || !results.bios.manufacturer) {
            const biosStr = si['BIOS Version'];
            const biosComma = biosStr.indexOf(',');
            if (biosComma > 0) {
              const biosInfo = biosStr.substring(0, biosComma).trim();
              const biosDate = biosStr.substring(biosComma + 1).trim();
              results.bios = results.bios || {};
              if (!results.bios.version) results.bios.version = biosInfo;
              if (!results.bios.releaseDate) results.bios.releaseDate = biosDate;
              const spaceIdx = biosInfo.lastIndexOf(' ');
              if (spaceIdx > 0 && !results.bios.manufacturer) {
                const mfr = biosInfo.substring(0, spaceIdx).trim();
                if (!/^\d/.test(mfr)) results.bios.manufacturer = mfr;
              }
            }
          }
        }

        // — Processor —
        if (si['Processor(s)'] && (!results.processor || !results.processor.name)) {
          const procStr = si['Processor(s)'];
          // Try "[01]: <name>" format first, fall back to using the whole string
          let procMatch = procStr.match(/\[01\]:\s*(.+)/);
          if (!procMatch) procMatch = procStr.match(/\[01\]:\s+([^\]]+)/);
          const procName = procMatch ? procMatch[1].trim() : procStr.replace(/\n/g, ' ').replace(/^\d+\s+Processor.*Installed\.\s*/i, '').trim();
          if (procName) {
            const mhzMatch = /~(\d+)\s*Mhz/i.exec(procName) || /(\d+)\s*Mhz/i.exec(procName);
            const mfr = /GenuineIntel/i.test(procName) ? 'Intel' : /AuthenticAMD/i.test(procName) ? 'AMD' : '';
            results.processor = { ...(results.processor || {}),
              name: procName, manufacturer: mfr || (results.processor && results.processor.manufacturer || ''),
              maxSpeedMHz: mhzMatch ? parseInt(mhzMatch[1]) : (results.processor && results.processor.maxSpeedMHz || 0),
              currentSpeedMHz: mhzMatch ? parseInt(mhzMatch[1]) : (results.processor && results.processor.currentSpeedMHz || 0),
              cores: (results.processor && results.processor.cores) || 0,
              threads: (results.processor && results.processor.threads) || 0,
              socket: '', socketCount: 1,
            };
          }
        }

        // — Hotfixes —
        if (si['Hotfix(s)']) {
          const hfStr = si['Hotfix(s)'];
          const kbMatches = hfStr.match(/KB\d{5,}/gi);
          if (kbMatches && results.hotfixes.length === 0) {
            results.hotfixes = kbMatches.map(kb => kb.toUpperCase());
          }
        }

        // — Network Cards —
        if (si['Network Card(s)'] && results.network.length === 0) {
          const netStr = si['Network Card(s)'];
          const lines = netStr.split('\n');
          let currentNic = null;
          const nics = [];
          for (const rawLine of lines) {
            const t = rawLine.trim();
            if (!t || /^\d+\s+NIC\(s\)\s+Installed/i.test(t)) continue;
            // NIC header: "[01]: AdapterName" (not an IP address or short token)
            const nicHdr = t.match(/^\[(\d{2})\]:\s+(.+)/);
            if (nicHdr && nicHdr[2].length > 10 && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(nicHdr[2]) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(nicHdr[2])) {
              if (currentNic) nics.push(currentNic);
              currentNic = { desc: nicHdr[2], ip: '', dhcp: false, gateway: '' };
              continue;
            }
            if (!currentNic) continue;
            // IP address sub-item (inside a NIC block): "  [01]: 10.0.1.50"
            const ipM = t.match(/^\[01\]:\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
            if (ipM) { currentNic.ip = currentNic.ip || ipM[1]; continue; }
            const dhM = t.match(/DHCP Enabled:\s*(Yes|No)/i);
            if (dhM) { currentNic.dhcp = dhM[1] === 'Yes'; continue; }
            const gwM = t.match(/DHCP Server:\s*(\S+)/i);
            if (gwM) { currentNic.gateway = gwM[1]; continue; }
          }
          if (currentNic) nics.push(currentNic);
          results.network = nics.map(n => ({
            description: n.desc,
            ipAddress: n.ip,
            macAddress: '',
            defaultGateway: n.gateway,
            dhcpEnabled: n.dhcp,
            dnsServers: '',
          }));
        }
      } else if (siResult.reason) {
        results.methods.systeminfo = 'failed';
        results.errors.push({ priority: 3, method: 'systeminfo', ...siResult });
      }
    }

    // ========================================================================
    // PRIORITY 2c: wmic /node:HOST over DCOM/RPC — fills gaps systeminfo can't
    // Queries WMI classes for: motherboard, individual RAM sticks, physical
    // disks, volumes, GPU details. Uses DCOM (port 135) — same RPC protocol
    // as PsLoggedOn and systeminfo. Does NOT require Admin$ or PsExec.
    // ========================================================================
    const needWmic = results.methods.powershell !== 'success'
      && (results.memory.length === 0 || results.disks.length === 0
          || results.logicalDisks.length === 0 || !results.motherboard?.product
          || results.gpu.length === 0);
    if (needWmic) {
      const wmicClasses = [
        { wmiClass: 'computersystem', fields: 'Manufacturer,Model,SystemType,Domain,TotalPhysicalMemory,SerialNumber' },
        { wmiClass: 'baseboard', fields: 'Manufacturer,Product,Version,SerialNumber' },
        { wmiClass: 'cpu', fields: 'Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed' },
        { wmiClass: 'memorychip', fields: 'Capacity,Manufacturer,PartNumber,Speed,DeviceLocator' },
        { wmiClass: 'diskdrive', fields: 'Index,Model,Size,InterfaceType,SerialNumber' },
        { wmiClass: 'logicaldisk where DriveType=3', fields: 'DeviceID,FileSystem,VolumeName,Size,FreeSpace' },
        { wmiClass: 'path win32_videocontroller', fields: 'Name,AdapterCompatibility,AdapterRAM,DriverVersion' },
        { wmiClass: 'nicconfig where IPEnabled=True', fields: 'Description,IPAddress,MACAddress,DefaultIPGateway,DHCPEnabled' },
      ];
      const wmicPromises = wmicClasses.map(c =>
        wmic.runRemote(fqHost, c.wmiClass, c.fields, 20000, hwCred)
          .then(r => ({ ...c, ...r }))
      );
      const wmicResults = await Promise.all(wmicPromises);
      let wmicAnySuccess = false;
      for (const wr of wmicResults) {
        if (wr.success && wr.records && wr.records.length > 0) {
          wmicAnySuccess = true;
          const rec = wr.records[0];

          if (wr.wmiClass === 'computersystem') {
            if (rec.Manufacturer && !results.system.manufacturer) results.system.manufacturer = rec.Manufacturer;
            if (rec.Model && !results.system.model) results.system.model = rec.Model;
            if (rec.SystemType && !results.system.systemType) results.system.systemType = rec.SystemType;
            if (rec.Domain && !results.system.domain) results.system.domain = rec.Domain;
            if (rec.TotalPhysicalMemory) {
              const b = parseInt(rec.TotalPhysicalMemory, 10);
              if (b > 0 && !results.system.totalRamMB) results.system.totalRamMB = Math.round(b / (1024 * 1024));
            }
            if (rec.SerialNumber && !results.system.serial) results.system.serial = rec.SerialNumber;
          }

          if (wr.wmiClass === 'baseboard') {
            if (!results.motherboard?.product) {
              results.motherboard = {
                manufacturer: rec.Manufacturer || '',
                product: rec.Product || '',
                version: rec.Version || '',
                serial: rec.SerialNumber || '',
              };
            }
          }

          if (wr.wmiClass === 'cpu') {
            if (rec.Name && !results.processor?.name) {
              const mhz = rec.MaxClockSpeed ? parseInt(rec.MaxClockSpeed, 10) : 0;
              results.processor = {
                name: String(rec.Name).trim(),
                manufacturer: rec.Manufacturer || '',
                cores: parseInt(rec.NumberOfCores) || 0,
                threads: parseInt(rec.NumberOfLogicalProcessors) || 0,
                maxSpeedMHz: mhz,
                currentSpeedMHz: mhz,
                socket: '',
                socketCount: 1,
              };
            }
          }

          if (wr.wmiClass === 'memorychip') {
            if (results.memory.length === 0) {
              results.memory = wr.records.map(r => ({
                capacityGB: r.Capacity ? Math.round(parseInt(r.Capacity, 10) / (1024 * 1024 * 1024) * 10) / 10 : 0,
                manufacturer: (r.Manufacturer || '').trim(),
                partNumber: (r.PartNumber || '').trim(),
                speed: parseInt(r.Speed) || 0,
                deviceLocator: (r.DeviceLocator || '').trim(),
              }));
            }
          }

          if (wr.wmiClass === 'diskdrive') {
            if (results.disks.length === 0) {
              results.disks = wr.records.map(r => ({
                index: parseInt(r.Index) || 0,
                model: (r.Model || '').trim(),
                sizeGB: r.Size ? Math.round(parseInt(r.Size, 10) / (1024 * 1024 * 1024)) : 0,
                interfaceType: (r.InterfaceType || '').trim(),
                serialNumber: (r.SerialNumber || '').trim(),
                partitions: 0,
              }));
            }
          }

          if (wr.wmiClass === 'logicaldisk where DriveType=3') {
            if (results.logicalDisks.length === 0) {
              results.logicalDisks = wr.records.map(r => {
                const sizeB = parseInt(r.Size, 10) || 0;
                const freeB = parseInt(r.FreeSpace, 10) || 0;
                return {
                  drive: (r.DeviceID || '').trim(),
                  fileSystem: (r.FileSystem || '').trim(),
                  volumeName: (r.VolumeName || '').trim(),
                  sizeGB: Math.round(sizeB / (1024 * 1024 * 1024) * 10) / 10,
                  freeGB: Math.round(freeB / (1024 * 1024 * 1024) * 10) / 10,
                };
              });
            }
          }

          if (wr.wmiClass === 'path win32_videocontroller') {
            if (results.gpu.length === 0) {
              results.gpu = wr.records.map(r => ({
                name: (r.Name || '').trim(),
                manufacturer: (r.AdapterCompatibility || '').trim(),
                ramMB: parseInt(r.AdapterRAM) ? Math.round(parseInt(r.AdapterRAM, 10) / (1024 * 1024)) : 0,
                driverVersion: (r.DriverVersion || '').trim(),
                driverDate: '',
              }));
            }
          }

          if (wr.wmiClass === 'nicconfig where IPEnabled=True') {
            if (results.network.length === 0) {
              results.network = wr.records.map(r => ({
                description: (r.Description || '').trim(),
                ipAddress: (r.IPAddress || '').trim().replace(/[{}"]/g, ''),
                macAddress: (r.MACAddress || '').trim(),
                defaultGateway: (r.DefaultIPGateway || '').trim().replace(/[{}"]/g, ''),
                dhcpEnabled: String(r.DHCPEnabled || '').toLowerCase() === 'true',
                dnsServers: '',
              }));
            }
          }
        }
      }
      if (wmicAnySuccess) {
        results.methods.wmic_dcom = 'success';
        // Compute RAM total from individual sticks if wmic provided them
        const stickTotalGB = results.memory.reduce((s, m) => s + (m.capacityGB || 0), 0);
        if (stickTotalGB > 0 && !results.system.totalRamMB) results.system.totalRamMB = stickTotalGB * 1024;
      } else {
        results.methods.wmic_dcom = 'failed';
        const firstWmicFail = wmicResults.find(wr => wr.reason);
        if (firstWmicFail) results.errors.push({ priority: 3, method: 'wmic DCOM', ...firstWmicFail });
      }
    }

    // ========================================================================
    // GUARD: if no method returned any data, return a clear failure with diagnostics
    // ========================================================================
    const hasAnyData = results.system?.manufacturer || results.system?.model || results.system?.totalRamMB ||
                       results.motherboard?.manufacturer || results.motherboard?.product ||
                       results.bios?.manufacturer || results.bios?.version ||
                       results.processor?.name ||
                       results.memory.length > 0 || results.disks.length > 0 || results.logicalDisks.length > 0 ||
                       results.network.length > 0 || results.gpu.length > 0 ||
                       results.os?.name ||
                       results.hotfixes.length > 0 || results.software.length > 0 ||
                       results.loggedInUser;

    if (!hasAnyData) {
      const firstError = results.errors[0];
      audit.add(db, {
        actionType: 'hardware.scan',
        targetHost: safeHost,
        tool: 'multi',
        command: `Hardware scan on ${safeHost}`,
        success: false,
        durationMs: Date.now() - scanStartTime,
        errorReason: 'No data collected from any method',
        initiatedBy: 'admin',
        initiatedFrom,
        parameters: {
          methods: results.methods,
          errorCount: results.errors.length,
          errors: results.errors,
        },
      });
      return res.json({
        success: false,
        error: 'No data could be collected from the target. ' + (firstError?.reason || firstError?.error || 'Target may be offline or unreachable.'),
        data: results,
        methods: results.methods,
        rawOutputs: results.rawOutputs || {},
        errorCount: results.errors.length,
        errors: results.errors,
      });
    }

    // ========================================================================
    // SAVE — merge with previous data to avoid losing fields on partial scans
    // ========================================================================
    const key = 'hardware:' + safeHost;
    let prevHw = null;
    let finalResult = results;
    let changes = [];
    try {
      const prev = db.settings.get(key, null);
      if (prev) { try { prevHw = JSON.parse(prev); } catch {} }
      if (prevHw && prevHw.hwVersion >= 2) {
        finalResult = { ...prevHw, ...results };
        // For each section, keep new data if non-empty, otherwise preserve old
        if (Object.keys(results.system).length > 0 && (results.system.manufacturer || results.system.totalRamMB)) {
          finalResult.system = { ...prevHw.system, ...results.system };
        } else { finalResult.system = prevHw.system; }
        if (Object.keys(results.motherboard).length > 0) {
          finalResult.motherboard = { ...prevHw.motherboard, ...results.motherboard };
        } else { finalResult.motherboard = prevHw.motherboard; }
        if (Object.keys(results.bios).length > 0) {
          finalResult.bios = { ...prevHw.bios, ...results.bios };
        } else { finalResult.bios = prevHw.bios; }
        finalResult.processor = results.processor || prevHw.processor;
        finalResult.memory = results.memory.length > 0 ? results.memory : prevHw.memory || [];
        finalResult.disks = results.disks.length > 0 ? results.disks : prevHw.disks || [];
        finalResult.logicalDisks = results.logicalDisks.length > 0 ? results.logicalDisks : prevHw.logicalDisks || [];
        finalResult.network = results.network.length > 0 ? results.network : prevHw.network || [];
        finalResult.gpu = results.gpu.length > 0 ? results.gpu : prevHw.gpu || [];
        finalResult.os = Object.keys(results.os).length > 0 ? { ...prevHw.os, ...results.os } : prevHw.os;
        finalResult.hotfixes = results.hotfixes.length > 0 ? results.hotfixes : prevHw.hotfixes || [];
        finalResult.software = results.software.length > 0 ? results.software : prevHw.software || [];
        finalResult.userProfilePath = results.userProfilePath || prevHw.userProfilePath || null;
        finalResult.osDisplayVersion = results.osDisplayVersion || prevHw.osDisplayVersion || null;
        finalResult.osUBR = results.osUBR || prevHw.osUBR || null;
        finalResult.opticalDrives = results.opticalDrives.length > 0 ? results.opticalDrives : prevHw.opticalDrives || [];
        finalResult.soundDevices = results.soundDevices.length > 0 ? results.soundDevices : prevHw.soundDevices || [];
        finalResult.physicalNetworks = results.physicalNetworks.length > 0 ? results.physicalNetworks : prevHw.physicalNetworks || [];
        finalResult.formattedSummary = results.formattedSummary || prevHw.formattedSummary || null;
      }
      finalResult.methods = results.methods;
      finalResult.errors = results.errors;
      finalResult.rawOutputs = results.rawOutputs;
      db.settings.set(key, JSON.stringify(finalResult));
    } catch {}

    // ========================================================================
    // UPDATE HOST RECORD — persist extracted fields to the hosts DB table
    // ========================================================================
    try {
      const hostFields = {};
      if (finalResult.os?.name) hostFields.os = finalResult.os.name;
      if (finalResult.os?.version) hostFields.os_version = finalResult.os.version;
      if (finalResult.os?.build) hostFields.build = String(finalResult.os.build);
      if (finalResult.processor?.name) hostFields.cpu = finalResult.processor.name;
      if (finalResult.system?.totalRamMB) hostFields.ram = finalResult.system.totalRamMB;
      if (finalResult.network?.[0]?.ipAddress) hostFields.ip_address = finalResult.network[0].ipAddress;
      if (finalResult.network?.[0]?.macAddress) hostFields.mac_address = finalResult.network[0].macAddress;
      if (finalResult.system?.manufacturer) hostFields.manufacturer = finalResult.system.manufacturer;
      if (finalResult.system?.model) hostFields.model = finalResult.system.model;
      if (finalResult.system?.serial) hostFields.serial = finalResult.system.serial;
      if (finalResult.loggedInUser) hostFields.logged_on_user = finalResult.loggedInUser;
      // Detect changes vs previous scan
      if (prevHw && prevHw.hwVersion >= 2) {
        const toTrack = [
          { field: 'OS', old: prevHw.os?.name, new: finalResult.os?.name },
          { field: 'OS Build', old: prevHw.os?.build, new: finalResult.os?.build },
          { field: 'CPU', old: prevHw.processor?.name, new: finalResult.processor?.name },
          { field: 'RAM (MB)', old: prevHw.system?.totalRamMB, new: finalResult.system?.totalRamMB },
          { field: 'IP Address', old: prevHw.network?.[0]?.ipAddress, new: finalResult.network?.[0]?.ipAddress },
          { field: 'MAC Address', old: prevHw.network?.[0]?.macAddress, new: finalResult.network?.[0]?.macAddress },
          { field: 'Manufacturer', old: prevHw.system?.manufacturer, new: finalResult.system?.manufacturer },
          { field: 'Model', old: prevHw.system?.model, new: finalResult.system?.model },
          { field: 'Serial', old: prevHw.system?.serial, new: finalResult.system?.serial },
        ];
        changes = toTrack.filter(t => String(t.old || '') !== String(t.new || '')).map(t => ({
          field: t.field,
          oldValue: String(t.old || ''),
          newValue: String(t.new || ''),
        }));
      }
      if (Object.keys(hostFields).length > 0) {
        const hostId = db.hosts.getIdByHostname(safeHost);
        if (hostId) {
          hostFields.online_status = 'online';
          hostFields.last_seen = new Date().toISOString();
          db.hosts.update(hostId, hostFields);
        }
      }
    } catch (e) { /* non-critical */ }

    // ========================================================================
    // AUDIT LOG — record this hardware scan
    // ========================================================================
    const scanDuration = Date.now() - scanStartTime;
    const methodSummary = Object.entries(results.methods).map(([k, v]) => `${k}:${v}`).join(', ');
    audit.add(db, {
      actionType: 'hardware.scan',
      targetHost: safeHost,
      tool: 'pstools (psinfo + powershell)',
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
        changes: changes.length > 0 ? changes : undefined,
      },
    });

    res.json({
      success: true,
      data: finalResult,
      methods: results.methods,
      rawOutputs: results.rawOutputs || {},
      errorCount: results.errors.length,
      errors: results.errors,
      changes,
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

// ==========================================================================
// PSTOOLS SPECIFIC ENDPOINTS — Each wrapped with global credential support
// for a professional PsTools-first experience.
// ==========================================================================
app.post('/api/pstools/psinfo', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await pstools.runPsInfo(safeHost, ['-d', '-h', '-s', '-c'], 30000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/pslist', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await pstools.runGeneric('pslist', safeHost, [], 30000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/pskill', async (req, res) => {
  const { hostname, target } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeTarget = sanitizeHost(target);
  const result = await pstools.runGeneric('pskill', safeHost, [safeTarget], 15000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psservice', async (req, res) => {
  const { hostname, action, serviceName } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeService = serviceName ? sanitizeHost(serviceName) : '';
  const actionCmd = action && serviceName ? `${action} "${safeService}"` : 'query';
  const extraArgs = actionCmd.split(/\s+/);
  const result = await pstools.runGeneric('psservice', safeHost, extraArgs, 30000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psloggedon', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await pstools.runPsLoggedOn(safeHost, 15000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psshutdown', async (req, res) => {
  const { hostname, action, timeout, message } = req.body;
  const safeHost = sanitizeHost(hostname);
  const actionFlag = action === 'shutdown' ? '-s' : action === 'abort' ? '-a' : '-r';
  const extraArgs = [actionFlag, '-t', String(timeout || 5), '-f'];
  if (message) extraArgs.push('-m', message.replace(/"/g, ''));
  const result = await pstools.runGeneric('psshutdown', safeHost, extraArgs, 15000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psfile', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await pstools.runGeneric('psfile', safeHost, [], 15000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/psgetsid', async (req, res) => {
  const { hostname } = req.body;
  const safeHost = sanitizeHost(hostname);
  const result = await pstools.runGeneric('psgetsid', safeHost, [], 15000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

app.post('/api/pstools/pssuspend', async (req, res) => {
  const { hostname, target, action } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeTarget = sanitizeHost(target);
  const extraArgs = action === 'resume' ? ['-r', safeTarget] : [safeTarget];
  const result = await pstools.runGeneric('pssuspend', safeHost, extraArgs, 15000, getGlobalCredentials());
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// PC EVENT LOG — Retrieve Windows Event Logs from a remote host
// ==========================================================================
app.post('/api/hosts/:hostname/eventlog', async (req, res) => {
  const { hostname } = req.params;
  const { logName = 'System', maxEvents = 50, severity } = req.body;
  const safeHost = sanitizeHost(hostname);
  const safeLog = String(logName).replace(/[^a-zA-Z0-9]/g, '');
  const safeMax = Math.min(parseInt(maxEvents, 10) || 50, 500);
  let levelFilter = '';
  if (severity === 'Error') levelFilter = '-Level 2';
  else if (severity === 'Warning') levelFilter = '-Level 3';
  else if (severity === 'Information') levelFilter = '-Level 4';

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    try {
      $events = Get-WinEvent -FilterHashtable @{ LogName = '${safeLog}'; StartTime = (Get-Date).AddDays(-7) } ${levelFilter} -MaxEvents ${safeMax} -ErrorAction SilentlyContinue
      if (-not $events) { $events = @() }
      $results = $events | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message
      Write-Output ('<<<JSON>>>' + ($results | ConvertTo-Json -Depth 3 -Compress) + '<<<END>>>')
    } catch {
      Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '","events":[]}<<<END>>>')
    }
  `;
  const result = await runRemotePowerShellJson(safeHost, script, 30000);
  res.json({ success: result.success, data: JSON.stringify(result.json?.error ? [] : result.json), error: result.json?.error || result.stderr });
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
// DNS RESOLVE — Resolve hostname to IP or IP to hostname
// Uses Node.js DNS first, then falls back to Windows full resolver
// (includes NetBIOS / LLMNR / DNS / hosts file — not just PTR)
// ==========================================================================
app.post('/api/dns/resolve', async (req, res) => {
  const { hostname, ip } = req.body;
  const dns = require('dns');
  dns.setServers([]); // use system defaults

  if (hostname) {
    try {
      const addresses = await new Promise((resolve, reject) => {
        dns.resolve4(hostname, (err, addrs) => {
          if (err) return reject(err);
          resolve(addrs);
        });
      });
      res.json({ success: true, data: { hostname, ips: addresses, ip: addresses[0] || '' } });
    } catch (e) {
      // Windows fallback for forward lookup
      try {
        const ps = await runPowerShell(`
          $ErrorActionPreference = 'SilentlyContinue'
          try { $h = [System.Net.Dns]::GetHostEntry('${hostname}'); Write-Output $h.AddressList[0].IPAddressToString } catch {}
        `, 5000);
        if (ps.stdout && ps.stdout.trim()) {
          res.json({ success: true, data: { hostname, ips: [ps.stdout.trim()], ip: ps.stdout.trim() } });
        } else {
          res.json({ success: false, error: 'DNS resolve failed for ' + hostname + ': ' + e.message });
        }
      } catch {
        res.json({ success: false, error: 'DNS resolve failed for ' + hostname + ': ' + e.message });
      }
    }
  } else if (ip) {
    try {
      const hostnames = await new Promise((resolve, reject) => {
        dns.reverse(ip, (err, names) => {
          if (err) return reject(err);
          resolve(names);
        });
      });
      res.json({ success: true, data: { ip, hostnames, hostname: hostnames[0] || '' } });
    } catch (e) {
      // Windows fallback for reverse lookup (includes NetBIOS/LLMNR)
      try {
        const ps = await runPowerShell(`
          $ErrorActionPreference = 'SilentlyContinue'
          try { $h = [System.Net.Dns]::GetHostEntry('${ip}'); Write-Output $h.HostName } catch {}
        `, 5000);
        if (ps.stdout && ps.stdout.trim()) {
          res.json({ success: true, data: { ip, hostnames: [ps.stdout.trim()], hostname: ps.stdout.trim() } });
        } else {
          res.json({ success: false, error: 'Reverse DNS failed for ' + ip + ': ' + e.message });
        }
      } catch {
        res.json({ success: false, error: 'Reverse DNS failed for ' + ip + ': ' + e.message });
      }
    }
  } else {
    res.json({ success: false, error: 'Provide hostname or ip' });
  }
});

// Bulk DNS resolve — resolve a list of hostnames and/or IPs in parallel
// Uses Node.js DNS first, then falls back to Windows full resolver for failures
app.post('/api/dns/bulk-resolve', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.json({ success: false, error: 'items array required' });
  const dns = require('dns');
  const results = await Promise.all(items.map(item => new Promise(resolveItem => {
    if (item.hostname && !item.ip) {
      dns.resolve4(item.hostname, (err, addrs) => {
        if (err) resolveItem({ ...item, ip: '', resolveError: err.code || 'FAILED' });
        else resolveItem({ ...item, ip: addrs[0] || '', ips: addrs });
      });
    } else if (item.ip && !item.hostname) {
      dns.reverse(item.ip, (err, names) => {
        if (err) resolveItem({ ...item, hostname: '', resolveError: err.code || 'FAILED' });
        else resolveItem({ ...item, hostname: names[0] || '' });
      });
    } else {
      resolveItem(item);
    }
  })));

  // Windows fallback for reverse lookups that failed (no PTR records)
  const failedReverse = results.filter(r => r.ip && !r.hostname && r.resolveError);
  if (failedReverse.length > 0) {
    try {
      const ipList = failedReverse.map(r => "'" + r.ip + "'").join(',');
      const psScript = `
        $ErrorActionPreference = 'SilentlyContinue'
        $ips = @(${ipList})
        $out = @()
        foreach ($ip in $ips) {
          try {
            $h = [System.Net.Dns]::GetHostEntry($ip)
            $out += @{ ip = $ip; hostname = if ($h.HostName) { $h.HostName } else { '' } }
          } catch { $out += @{ ip = $ip; hostname = '' } }
        }
        Write-Output ('<<<JSON>>>' + ($out | ConvertTo-Json -Compress) + '<<<END>>>')
      `;
      const psResult = await runPowerShell(psScript, 30000);
      const markerMatch = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(psResult.stdout || '');
      if (markerMatch) {
        try {
          const resolved = JSON.parse(markerMatch[1]);
          if (Array.isArray(resolved)) {
            const lookup = {};
            resolved.forEach(item => { if (item.hostname) lookup[item.ip] = item.hostname; });
            results.forEach(r => {
              if (lookup[r.ip] && !r.hostname) { r.hostname = lookup[r.ip]; delete r.resolveError; }
            });
          }
        } catch {}
      }
    } catch {}
  }

  res.json({ success: true, data: results });
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

    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });
  ws.on('close', () => {
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
// Prevent crash from unhandled rejections/exceptions
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

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
║  • Windows Updates (PSWindowsUpdate via PsExec on targets)      ║
║  • Active Directory (.NET DirectorySearcher + LAPS)            ║
║  • VNC/RDP launch (vncviewer.exe / mstsc.exe)                    ║
║  • Software deployment (SMB copy + PsExec execution)             ║
║  • Power management (PsShutdown + WoL UDP)                         ║
║  • Network scanner (parallel ping.exe)                           ║
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

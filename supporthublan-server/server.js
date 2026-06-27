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
const PSTOOLS_PATH = process.env.PSTOOLS_PATH || path.join(__dirname, 'PSTools') + path.sep;
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
// JOB ENDPOINTS
app.get('/api/jobs', (req, res) => {
  const jobs = [];
  try { if (db.jobs && db.jobs.list) { const list = db.jobs.list(100); res.json({ success: true, data: list }); return; } } catch (_) {}
  res.json({ success: true, data: jobs });
});
app.get('/api/jobs/:jobId', (req, res) => {
  try { if (db.jobs && db.jobs.get) { const j = db.jobs.get(req.params.jobId); if (j) return res.json({ success: true, data: j }); } } catch (_) {}
  res.json({ success: false, error: 'Job not found' });
});

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
    const credDomain = db.settings.get('globalCredDomain', '') || '';
    const suffixDomain = db.settings.get('globalDomainSuffix', '') || DEFAULT_DOMAIN;
    const globalDomain = credDomain || suffixDomain;
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

// Job registry for cancel/pause/resume
const jobRegistry = new Map();

app.post('/api/jobs/:jobId/cancel', (req, res) => {
  const job = jobRegistry.get(req.params.jobId);
  if (job) {
    job.cancelled = true;
    broadcastUpdate({ type: 'job-cancelled', jobId: req.params.jobId });
    try { if (db.jobs && db.jobs.upsert) { const j = db.jobs.get(req.params.jobId); if (j) { db.jobs.upsert({ id: req.params.jobId, status: 'cancelled' }); } } } catch (_) {}
    res.json({ success: true, status: 'cancelled' });
  } else {
    // Even if not found in registry, persist cancelled status
    try { if (db.jobs && db.jobs.upsert) { db.jobs.upsert({ id: req.params.jobId, status: 'cancelled' }); } } catch (_) {}
    broadcastUpdate({ type: 'job-cancelled', jobId: req.params.jobId });
    res.json({ success: true, status: 'cancelled', note: 'Job not in active registry, status persisted' });
  }
});

app.post('/api/jobs/:jobId/pause', (req, res) => {
  const job = jobRegistry.get(req.params.jobId);
  if (job) {
    job.paused = true;
    broadcastUpdate({ type: 'job-paused', jobId: req.params.jobId });
    try { if (db.jobs && db.jobs.upsert) { db.jobs.upsert({ id: req.params.jobId, status: 'paused' }); } } catch (_) {}
    res.json({ success: true, status: 'paused' });
  } else {
    res.json({ success: false, error: 'Job not found or already completed' });
  }
});

app.post('/api/jobs/:jobId/resume', (req, res) => {
  const job = jobRegistry.get(req.params.jobId);
  if (job) {
    job.paused = false;
    broadcastUpdate({ type: 'job-resumed', jobId: req.params.jobId });
    try { if (db.jobs && db.jobs.upsert) { db.jobs.upsert({ id: req.params.jobId, status: 'running' }); } } catch (_) {}
    res.json({ success: true, status: 'running' });
  } else {
    res.json({ success: false, error: 'Job not found or already completed' });
  }
});

// DELETE job
app.delete('/api/jobs/:jobId', (req, res) => {
  try { if (db.jobs && db.jobs.get) { const j = db.jobs.get(req.params.jobId); if (j) { db.jobs.delete(req.params.jobId); return res.json({ success: true }); } } } catch (_) {}
  res.json({ success: false, error: 'Job not found' });
});

// RERUN-FAILED — re-run a completed/cancelled job only for hosts that failed
app.post('/api/jobs/:jobId/rerun-failed', async (req, res) => {
  try {
    const j = db.jobs ? db.jobs.get(req.params.jobId) : null;
    if (!j) return res.json({ success: false, error: 'Job not found' });
    const failedHosts = [];
    const allHostnames = j.hostnames || [];
    const prevProgress = j.perHostProgress || {};
    for (const h of allHostnames) {
      const p = prevProgress[h];
      if (!p || p.status === 'failed' || p.status === 'unreachable') failedHosts.push(h);
    }
    if (failedHosts.length === 0) return res.json({ success: true, data: { note: 'No failed hosts to rerun' } });
    const steps = req.body.steps || j.steps || [];
    const queueName = req.body.queueName || (j.name ? j.name + ' (rerun)' : 'Rerun');
    // Delegate to /api/queues/execute — reuse the endpoint internally
    req.body.steps = steps;
    req.body.hostnames = failedHosts;
    req.body.queueName = queueName;
    req.body.errorHandling = 'continue';
    // Forward body and let /api/queues/execute handle the rest
    // Cannot directly call the handler, so respond with the info and let frontend resubmit
    return res.json({ success: true, data: { failedHosts, steps, queueName, note: 'Frontend should call executeQueue with these params' } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ==========================================================================
app.post('/api/queues/execute', async (req, res) => {
  const { steps, hostnames, credential, errorHandling, queueName } = req.body;
  const jobId = 'job-' + Date.now();

  // Register for pause/cancel control
  const jobCtx = { cancelled: false, paused: false, completed: false };
  jobRegistry.set(jobId, jobCtx);
  setTimeout(() => jobRegistry.delete(jobId), 3600000); // auto-clean after 1 hour

  // Helper: classify error as unreachable vs failed
  const classifyError = (msg) => {
    const m = (msg || '').toLowerCase();
    const patterns = ['network path not found','rpc server is unavailable','access is denied','could not resolve','host unreachable','no such host','connection refused','timed out','error 53','error 5','error 1722','unknown host','network name cannot be found','the handle is invalid','couldn\'t access','cannot connect'];
    return patterns.some(p => m.includes(p)) ? 'unreachable' : 'failed';
  };

  // Get fallback credential (local admin) for auto-retry on access denied
  let fallbackCred = null;
  try {
    const fbUser = db.settings.get('fallbackCredUsername', '') || '';
    const fbEnc = db.settings.get('fallbackCredPassword', '') || '';
    const fbPass = fbEnc ? db.decryptField(fbEnc) : '';
    if (fbUser && fbPass) fallbackCred = { username: fbUser, password: fbPass, domain: db.settings.get('fallbackCredDomain', '') || '' };
  } catch (_) {}

  // Respond immediately with job ID
  res.json({ success: true, data: { jobId, status: 'running', stepCount: steps.length, hostCount: hostnames.length, queueName: queueName || 'Untitled Queue' } });

  // Execute async + broadcast progress
  (async () => {
    const perHostProgress = {};
    const jobLogs = [];
    hostnames.forEach(h => { perHostProgress[h] = { step: '', status: 'pending' }; });
    let totalSteps = steps.length * hostnames.length;
    let completed = 0;
    // Save job to DB immediately with 'running' status
    try { if (db.jobs && db.jobs.upsert) { db.jobs.upsert({ id: jobId, name: queueName || 'Untitled Queue', status: 'running', progress: 0, step: 'Starting…', started_at: new Date().toISOString(), completed_at: null, hostnames, steps, perHostProgress, totalSteps, logs: [] }); } } catch (_) {}
    broadcastUpdate({ type: 'queue-start', jobId, queueName: queueName || 'Untitled Queue', total: totalSteps, completed: 0 });

    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      for (let hi = 0; hi < hostnames.length; hi++) {
        // Handle pause
        while (jobCtx.paused) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (jobCtx.cancelled) {
          jobCtx.completed = true;
          try { if (db.jobs && db.jobs.upsert) { db.jobs.upsert({ id: jobId, name: queueName || 'Untitled Queue', status: 'cancelled', progress: completed, step: 'Cancelled', completed_at: new Date().toISOString(), hostnames, steps, perHostProgress, logs: jobLogs, totalSteps }); } } catch (_) {}
          jobRegistry.delete(jobId);
          broadcastUpdate({ type: 'queue-aborted', jobId, reason: 'Cancelled by user' });
          return;
        }
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
              } else { stepResult = { success: false, error: 'No command code configured' }; }
              break;
            case 'start-service': case 'stop-service': case 'restart-service': case 'check-service':
              if (step.config?.serviceName) {
                const action = step.type === 'stop-service' ? 'Stop' : step.type === 'restart-service' ? 'Restart' : step.type === 'check-service' ? 'Get' : 'Start';
                script = step.type === 'check-service'
                  ? `try { $s = Get-Service -Name '${sanitizeHost(step.config.serviceName)}' -ErrorAction Stop; Write-Output ('<<<JSON>>>{"name":"' + $s.Name + '","status":"' + $s.Status + '"}<<<END>>>') } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`
                  : `try { ${action}-Service -Name '${sanitizeHost(step.config.serviceName)}' ${step.type === 'stop-service' || step.type === 'restart-service' ? '-Force ' : ''}-ErrorAction Stop; Write-Output '<<<JSON>>>{"state":"${action === 'Stop' ? 'Stopped' : 'Running'}"}<<<END>>>' } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
                const svcResult = await runRemotePowerShellJson(hostname, script, 30000);
                stepResult = { success: step.type === 'check-service' ? (svcResult.success && !!svcResult.json?.status) : svcResult.success, output: JSON.stringify(svcResult.json || {}), error: svcResult.json?.error || svcResult.stderr };
              } else { stepResult = { success: false, error: 'No service name configured — edit step to specify one' }; }
              break;
            case 'psexec-run':
              if (step.config?.command) {
                const psexecResult = await pstools.runPsExec(hostname, 'cmd.exe', ['/c', step.config.command], 60000, getGlobalCredentials());
                stepResult = { success: psexecResult.success, output: psexecResult.stdout, error: psexecResult.stderr };
              } else { stepResult = { success: false, error: 'No CMD command configured' }; }
              break;
            case 'wait-minutes':
              await new Promise(r => setTimeout(r, (step.config?.minutes || 1) * 60000));
              stepResult = { success: true, output: `Waited ${step.config?.minutes || 1} minute(s)` };
              break;
            // Host operations — same logic as Host Details tabs
            case 'hardware-scan':
              try {
                const hwCred3 = getGlobalCredentials();
                const fqHost3 = hostname.includes('.') ? hostname : (hwCred3?.domain ? hostname + '.' + hwCred3.domain : hostname);
                const { results: hwResults3, ok: hwOk3 } = await scanHardware(hostname, fqHost3, hwCred3);
                stepResult = { success: hwOk3, output: JSON.stringify(hwResults3, null, 2), error: hwOk3 ? null : ('No hardware data: ' + (hwResults3.errors?.[0]?.reason || 'unknown')) };
              } catch (e) {
                stepResult = { success: false, output: '', error: 'scanHardware threw: ' + e.message };
              }
              break;
            case 'apps-list':
              const appCred = getGlobalCredentials();
              const [appPsInfo, appWmic] = await Promise.all([ pstools.runPsInfo(hostname, ['-d','-s'], 30000, appCred), wmic.runRemoteViaPsExec(hostname, 'product', 'Name,Version,Vendor', PSTOOLS_PATH, 60000, appCred) ]);
              stepResult = { success: appPsInfo.success || appWmic.success, output: appWmic.records ? JSON.stringify(appWmic.records) : appPsInfo.stdout, error: appWmic.error || appPsInfo.stderr };
              break;
            case 'services-list':
              script = `try { $svcs = Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress; Write-Output ('<<<JSON>>>' + $svcs + '<<<END>>>') } catch { Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>') }`;
              const svcList = await runRemotePowerShellJson(hostname, script, 60000);
              stepResult = { success: svcList.success && !svcList.json?.error, output: JSON.stringify(svcList.json || {}), error: svcList.json?.error || svcList.stderr };
              break;
            // PsTools direct
            case 'psinof': case 'psinfo':
              const pi = await pstools.runPsInfo(hostname, ['-d','-h','-s','-c'], 30000, getGlobalCredentials());
              stepResult = { success: pi.success, output: pi.stdout, error: pi.stderr };
              break;
            case 'pslist':
              const pl = await pstools.runGeneric('pslist', hostname, ['-t'], 30000, getGlobalCredentials());
              stepResult = { success: pl.success, output: pl.stdout, error: pl.stderr };
              break;
            case 'psloggedon':
              const plo = await pstools.runPsLoggedOn(hostname, 15000, getGlobalCredentials());
              stepResult = { success: plo.success, output: plo.stdout, error: plo.stderr };
              break;
            default:
              stepResult = { success: false, error: `Unknown step type: ${step.type}` };
          }

          completed++;
          perHostProgress[hostname] = { step: step.type, status: stepResult.success ? 'success' : (stepResult.error && /access denied/i.test(stepResult.error) ? 'failed' : classifyError(stepResult.error)), command: step.label || step.type, error: stepResult.error?.slice(0, 200) || null, output: stepResult.output?.slice(0, 500) || null };
          jobLogs.push({ time: new Date().toISOString(), type: 'step', hostname, step: step.type, command: step.label || step.type, success: stepResult.success, error: stepResult.error?.slice(0, 200), output: stepResult.output?.slice(0, 200), hostStatus: perHostProgress[hostname].status });
          // Always continue — log errors and move to next PC, only cancel stops
          broadcastUpdate({
            type: 'queue-step-complete',
            jobId, step: step.type, stepIndex: si, hostname, hostIndex: hi,
            completed, total: totalSteps,
            success: stepResult.success,
            output: stepResult.output?.slice(0, 1000),
            error: stepResult.error,
            status: stepResult.success ? 'success' : (stepResult.error && /access denied/i.test(stepResult.error) ? 'failed' : classifyError(stepResult.error))
          });
        } catch (e) {
          stepResult = { success: false, error: e.message };
          completed++;
          perHostProgress[hostname] = { step: step.type, status: 'failed', command: step.label || step.type, error: e.message?.slice(0, 200) || null, output: null };
          jobLogs.push({ time: new Date().toISOString(), type: 'step', hostname, step: step.type, command: step.label || step.type, success: false, error: e.message?.slice(0, 200), hostStatus: 'failed' });
          broadcastUpdate({ type: 'queue-step-complete', jobId, step: step.type, stepIndex: si, hostname, hostIndex: hi, completed, total: totalSteps, success: false, output: '', error: e.message, status: 'failed' });
        }
      }
    }
    // Persist to DB FIRST, then broadcast, then remove from registry
    try { if (db.jobs && db.jobs.upsert) { db.jobs.upsert({ id: jobId, name: queueName || 'Untitled Queue', status: 'completed', progress: completed, step: completed >= totalSteps ? 'Done' : 'Partial', started_at: new Date().toISOString(), completed_at: new Date().toISOString(), hostnames, steps, perHostProgress, logs: jobLogs, totalSteps }); } } catch (_) {}
    jobCtx.completed = true;
    jobRegistry.delete(jobId);
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

// ==========================================================================
// Shared hardware scan — used by both POST endpoint and queue step
// ==========================================================================
async function scanHardware(safeHost, fqHost, hwCred) {
  const results = {
    hostname: safeHost,
    scannedAt: new Date().toISOString(),
    hwVersion: 4,
    system: {}, motherboard: {}, bios: {}, processor: null,
    memory: [], disks: [], logicalDisks: [], network: [], gpu: [],
    os: {}, hotfixes: [], software: [], loggedInUser: null, userProfilePath: null,
    osDisplayVersion: null, osUBR: null, opticalDrives: [], soundDevices: [],
    physicalNetworks: [], formattedSummary: null,
    methods: {},
    errors: [],
  };

  // PRIORITY 1: WinAudit — standalone EXE, works on ALL Windows versions
  // Copies to target via PsExec -c, runs locally, produces CSV we read back
  const winAuditPath = path.join(__dirname, 'Tools', 'WinAudit_3_4_6.exe');
  if (fs.existsSync(winAuditPath)) {
    try {
      const waRemoteCsv = `C:\\Windows\\Temp\\shl_audit_${safeHost}.csv`;
      const waExe = path.join(PSTOOLS_PATH, 'psexec.exe');
      const credArgs = require('./lib/utils').credentialArgs || ((c, h) => c ? ['-u', (c.domain ? c.domain + '\\' : '') + c.username, '-p', c.password] : []);

      // Step 1: Run WinAudit on target
      const waRunArgs = ['-accepteula', '\\\\' + fqHost,
        ...credArgs(hwCred, fqHost),
        '-s', '-h', '-c', winAuditPath,
        '/r=a', `/o:${waRemoteCsv}`, '/f=CSV'];

      const waRunResult = await new Promise((resolve) => {
        const proc = require('child_process').spawn(waExe, waRunArgs, { windowsHide: true, timeout: 120000 });
        let out = ''; proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => out += d.toString());
        proc.on('close', code => resolve({ success: code === 0, stdout: out }));
        proc.on('error', err => resolve({ success: false, stdout: err.message }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 125000);
      });

      if (waRunResult.success) {
        results.methods.winaudit = 'success';

        // Step 2: Read CSV back via PsExec
        const waReadResult = await pstools.runPsExec(fqHost, 'cmd.exe', ['/c', `type ${waRemoteCsv}`], 30000, hwCred);

        if (waReadResult.success && waReadResult.stdout) {
          const csvLines = waReadResult.stdout.split('\n').filter(l => l.trim());
          if (csvLines.length >= 2) {
            const headers = csvLines[0].split(',').map(h => h.trim().toLowerCase());
            const data = csvLines[1].split(',').map(d => d.trim());

            const get = (name) => {
              const idx = headers.indexOf(name.toLowerCase());
              return idx >= 0 ? data[idx] || null : null;
            };

            const osName = get('os name') || get('os');
            if (osName) { results.os.name = osName; results.os.version = get('os version') || ''; results.os.build = get('os build') || ''; }
            const manufacturer = get('manufacturer') || get('system manufacturer');
            if (manufacturer) { results.system.manufacturer = manufacturer; results.system.model = get('model') || get('system model') || ''; }
            const serial = get('serial number') || get('system serial number');
            if (serial) results.system.serial = serial;
            const uuid = get('uuid');
            if (uuid) results.uuid = uuid;
            const chassis = get('chassis') || get('chassis type');
            if (chassis) { results.chassisType = chassis; results.chassisTypeName = chassis; }
            const biosVendor = get('bios vendor') || get('bios manufacturer');
            if (biosVendor) results.bios = { vendor: biosVendor, version: get('bios version') || '' };
            const cpuName = get('processor') || get('cpu');
            if (cpuName) results.processor = { name: cpuName, cores: parseInt(get('cores')) || 0, threads: parseInt(get('threads')) || 0, socket: get('socket') || '' };
            const totalRam = get('total physical memory') || get('total ram') || get('ram');
            if (totalRam) { const mb = parseInt(totalRam) || Math.round(parseFloat(totalRam) * 1024); if (mb > 0) results.system.totalRamMB = mb; }
            const loggedIn = get('logged on user') || get('current user');
            if (loggedIn) results.loggedInUser = loggedIn;
            const ipAddr = get('ip address') || get('ip');
            if (ipAddr && results.network.length === 0) results.network = [{ description: 'WinAudit', ipAddress: ipAddr, macAddress: '', defaultGateway: '', dhcpEnabled: false }];

            results.rawOutputs = results.rawOutputs || {};
            results.rawOutputs.winaudit = waReadResult.stdout.substring(0, 5000);
          }
        }

        // Step 3: Cleanup temp file
        pstools.runPsExec(fqHost, 'cmd.exe', ['/c', `del ${waRemoteCsv}`], 10000, hwCred).catch(() => {});
      } else {
        results.methods.winaudit = 'failed';
        results.errors.push({ priority: 1, method: 'WinAudit', reason: waRunResult.stdout?.substring(0, 200) || 'Unknown error' });
      }
    } catch (e) {
      results.methods.winaudit = 'failed';
      results.errors.push({ priority: 1, method: 'WinAudit', reason: e.message });
    }
  }

  // PRIORITY 2: PsExec + PowerShell (remote OS, GPU, disks, network)
  // Three scripts to fit PsExec's ~700-byte stdout pipe buffer.
  // Script A: critical (OS, system, UUID, chassis, BIOS, CPU)
  // Script B: hardware (motherboard, memory, disks, GPU)
  // Script C: peripherals (net, volumes, DVD, audio, phy nets)

  const _kv = {};
  function _parsePs(stdout) {
    if (!stdout) return;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line || !line.includes('=')) continue;
      const eqIdx = line.indexOf('=');
      const key = line.substring(0, eqIdx).trim();
      const val = line.substring(eqIdx + 1).trim();
      if (!_kv[key]) { _kv[key] = val; }
      else if (Array.isArray(_kv[key])) { _kv[key].push(val); }
      else { _kv[key] = [_kv[key], val]; }
    }
  }
  function _gA(k) { if (!_kv[k]) return []; const v = _kv[k]; return Array.isArray(v) ? v : [v]; }
  function _p1(k) { const a = _gA(k); return a.length > 0 ? a[0].split('|').map(s => s.trim()) : []; }

  const psA = `$o=@()
$cs=Get-CimInstance Win32_ComputerSystem;if($cs){$o+=('SYS='+$cs.Manufacturer+'|'+$cs.Model)}
$os=Get-CimInstance Win32_OperatingSystem;if($os){$dtStr='';$dt=$os.InstallDate;if($dt){try{$dtStr=$dt.ToShortDateString()}catch{$dtStr=''+$dt}};$o+=('OS='+$os.Caption+'|'+$os.OSArchitecture+'|'+$os.Version+'|'+$os.SerialNumber+'|'+$os.BuildNumber+'|'+$dtStr+'|'+$os.RegisteredUser+'|'+$os.RegisteredOrganization)}
$csp=Get-CimInstance Win32_ComputerSystemProduct;if($csp){$o+=('CSP='+$csp.UUID)}
$enc=Get-CimInstance Win32_SystemEnclosure;if($enc){$o+=('ENC='+$enc.ChassisTypes[0])}
$reg=try{Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"}catch{$null};if($reg){$o+=('REG='+$reg.DisplayVersion+'|'+$reg.CurrentBuild+'|'+$reg.UBR)}
$bios=Get-CimInstance Win32_BIOS;if($bios){$o+=('BIOS='+$bios.Manufacturer+'|'+$bios.SMBIOSBIOSVersion+'|'+$bios.ReleaseDate)}
$cpu=Get-CimInstance Win32_Processor;if($cpu){$o+=('CPU='+$cpu.Name.Trim()+'|'+$cpu.Manufacturer+'|'+$cpu.NumberOfCores+'|'+$cpu.NumberOfLogicalProcessors)}
Write-Output ($o -join "\`n")`;

  const psB = `$o=@()
$u=$env:USERNAME;$o+=('USER='+$u)
$up=$env:USERPROFILE;$up=$up -replace '\\|','-';if($up){$o+=('UP='+$up)}
$mb=Get-CimInstance Win32_BaseBoard;if($mb){$o+=('MB='+$mb.Manufacturer+'|'+$mb.Product+'|'+$mb.Version+'|'+$mb.SerialNumber)}
$mem=@(Get-CimInstance Win32_PhysicalMemory);foreach($m in $mem){$o+=('MEM='+[math]::Round($m.Capacity/1GB,1)+'|'+$m.Manufacturer+'|'+$m.PartNumber+'|'+$m.Speed+'|'+$m.DeviceLocator)}
$dsk=@(Get-CimInstance Win32_DiskDrive);foreach($d in $dsk){$sn=$d.SerialNumber;$sn="$sn".Trim();$o+=('DISK='+$d.Index+'|'+$d.Model+'|'+[math]::Round($d.Size/1GB,0)+'|'+$d.InterfaceType+'|'+$sn)}
$gpu=@(Get-CimInstance Win32_VideoController);foreach($g in $gpu){$o+=('GPU='+$g.Name+'|'+$g.AdapterCompatibility+'|'+[math]::Round($g.AdapterRAM/1MB,0)+'|'+$g.DriverVersion)}
Write-Output ($o -join "\`n")`;

  const psC = `$o=@()
$net=@(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True");foreach($n in $net){$ips=($n.IPAddress-join',');$gw=($n.DefaultIPGateway-join',');$o+=('NET='+$n.Description+'|'+$ips+'|'+$n.MACAddress+'|'+$gw+'|'+$n.DHCPEnabled)}
$vol=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3");foreach($v in $vol){$o+=('VOL='+$v.DeviceID+'|'+$v.FileSystem+'|'+$v.VolumeName+'|'+[math]::Round($v.Size/1GB,1)+'|'+[math]::Round($v.FreeSpace/1GB,1))}
$dvd=@(Get-CimInstance Win32_CDROMDrive);if($dvd.Count -gt 0){foreach($d in $dvd){$o+=('DVD='+$d.Drive+'|'+$d.Name)}}else{$o+=('DVD=None')}
$audio=@(Get-CimInstance Win32_SoundDevice);foreach($a in $audio){$an=""+$a.Name;$an=$an -replace '\\|','-';$o+=('AUD='+$an)}
$pnet=@(Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True");foreach($p in $pnet){$pn=""+$p.Name;$pn=$pn -replace '\\|','-';$pm=""+$p.MACAddress;$pm=$pm -replace '\\|','-';$o+=('PHYNET='+$pn+'|'+$pm)}
Write-Output ($o -join "\`n")`;

  const [psRA, psRB, psRC] = await Promise.all([
    powershell.runRemoteViaPsExec(fqHost, psA, PSTOOLS_PATH, 45000, hwCred),
    powershell.runRemoteViaPsExec(fqHost, psB, PSTOOLS_PATH, 45000, hwCred),
    powershell.runRemoteViaPsExec(fqHost, psC, PSTOOLS_PATH, 45000, hwCred),
  ]);

  if (psRA.success || psRB.success || psRC.success) {
    results.methods.powershell = 'success';
    results.rawOutputs = results.rawOutputs || {};
    results.rawOutputs.powershell = ('' + (psRA.stdout || '') + '\n---B---\n' + (psRB.stdout || '') + '\n---C---\n' + (psRC.stdout || '')).substring(0, 3000);
    try {
      _parsePs(psRA.stdout);
      _parsePs(psRB.stdout);
      _parsePs(psRC.stdout);

      if (_kv.USER) results.loggedInUser = _kv.USER;
      const osp = _p1('OS');
      if (osp[0]) results.os.name = osp[0];
      if (osp[1]) results.os.architecture = osp[1];
      if (osp[2]) results.os.version = osp[2];
      if (osp[3]) results.os.serial = osp[3];
      if (osp[4]) results.os.build = osp[4];
      if (osp[5]) results.os.installDate = osp[5];
      if (osp[6]) results.os.registeredUser = osp[6];
      if (osp[7] !== undefined) results.os.registeredOrg = osp[7];
      const sys = _p1('SYS');
      if (sys[0]) results.system.manufacturer = sys[0];
      if (sys[1]) results.system.model = sys[1];
      if (sys[2]) results.system.domain = sys[2];
      if (sys[3]) results.system.systemType = sys[3];
      if (_kv.CSP) results.uuid = _kv.CSP;
      const enc = _p1('ENC');
      if (enc[0]) {
        const chassisTypes = ['Other','Unknown','Desktop','Low Profile Desktop','Pizza Box','Mini Tower','Tower','Portable','Laptop','Notebook','Hand Held','Docking Station','All-in-One','Sub Notebook','Space-saving','Lunch Box','Main System Chassis','Expandable Chassis','Rack Mount Chassis','Sealed-case PC','Multi-system','Compact PCI','Advanced TCA','Blade','Blade Enclosure','Tablet','Convertible','Detachable','IoT Gateway','Embedded PC','Mini PC','Stick PC'];
        const ctNum = parseInt(enc[0]);
        results.chassisType = enc[0];
        results.chassisTypeName = (ctNum > 0 && ctNum <= chassisTypes.length) ? chassisTypes[ctNum - 1] : enc[0];
      }
      const mbp = _p1('MB');
      if (mbp[0] || mbp[1]) { results.motherboard = { manufacturer: mbp[0] || '', product: mbp[1] || '', version: mbp[2] || '', serial: mbp[3] || '' }; }
      const b = _p1('BIOS');
      if (b[0] || b[1]) { results.bios = { vendor: b[0] || '', manufacturer: b[0] || '', version: b[1] || '', releaseDate: b[2] || '', serial: '' }; }
      const cp = _p1('CPU');
      if (cp[0]) { results.processor = { name: cp[0], manufacturer: cp[1] || '', cores: parseInt(cp[2]) || 0, threads: parseInt(cp[3]) || 0, maxSpeedMHz: 0, currentSpeedMHz: 0, socket: '', socketCount: 1, serial: '' }; }
      const pwMem = _gA('MEM').map(m => { const p = m.split('|').map(s => s.trim()); return { capacityGB: parseFloat(p[0]) || 0, manufacturer: p[1] || '', partNumber: p[2] || '', speed: parseInt(p[3]) || 0, deviceLocator: p[4] || '' }; });
      if (pwMem.length > 0) results.memory = pwMem;
      const pwDisks = _gA('DISK').map(d => { const p = d.split('|').map(s => s.trim()); return { index: parseInt(p[0]) || 0, model: p[1] || '', sizeGB: parseFloat(p[2]) || 0, interfaceType: p[3] || '', serialNumber: p[4] || '', partitions: 0 }; });
      if (pwDisks.length > 0) results.disks = pwDisks;
      const pwGpu = _gA('GPU').map(g => { const p = g.split('|').map(s => s.trim()); return { name: p[0] || '', manufacturer: p[1] || '', ramMB: parseInt(p[2]) || 0, driverVersion: p[3] || '', driverDate: '' }; });
      if (pwGpu.length > 0) results.gpu = pwGpu;
      const pwNet = _gA('NET').map(n => { const p = n.split('|').map(s => s.trim()); return { description: p[0] || '', ipAddress: p[1] || '', macAddress: p[2] || '', defaultGateway: p[3] || '', dhcpEnabled: (p[4] || '') === 'True', dnsServers: '' }; });
      if (pwNet.length > 0) results.network = pwNet;
      const pwVol = _gA('VOL').map(v => { const p = v.split('|').map(s => s.trim()); return { drive: p[0] || '', fileSystem: p[1] || '', volumeName: p[2] || '', sizeGB: parseFloat(p[3]) || 0, freeGB: parseFloat(p[4]) || 0 }; });
      if (pwVol.length > 0) results.logicalDisks = pwVol;
      const upPath = _p1('UP');
      if (upPath[0]) results.userProfilePath = upPath[0];
      const reg = _p1('REG');
      if (reg[0]) results.osDisplayVersion = reg[0];
      if (reg[1] && !results.os.build) results.os.build = reg[1];
      if (reg[2]) results.osUBR = reg[2];
      const pwDvd = _gA('DVD').filter(d => d !== 'None').map(d => { const p = d.split('|').map(s => s.trim()); return { drive: p[0] || '', name: p[1] || '' }; });
      if (pwDvd.length > 0) results.opticalDrives = pwDvd;
      const pwAudio = _gA('AUD').filter(Boolean);
      if (pwAudio.length > 0) results.soundDevices = pwAudio;
      const pwPhy = _gA('PHYNET').map(p => { const parts = p.split('|').map(s => s.trim()); return { name: parts[0] || '', macAddress: parts[1] || '' }; });
      if (pwPhy.length > 0) results.physicalNetworks = pwPhy;
      if (results.memory.length > 0) { const stickTotalGB = results.memory.reduce((s, m) => s + (m.capacityGB || 0), 0); if (stickTotalGB > 0) results.system.totalRamMB = stickTotalGB * 1024; }
    } catch (e) {
      results.errors.push({ priority: 2, method: 'PowerShell', reason: 'Parse error: ' + e.message });
    }
  } else {
    results.methods.powershell = 'failed';
    const allReasons = [psRA, psRB, psRC].filter(r => r.reason).map(r => r.reason).join('; ');
    results.errors.push({ priority: 2, method: 'PowerShell', reason: allReasons || 'No output from PowerShell script' });
  }

  // dmidecode — ONLY for the local machine (SMBIOS is the server's, not the target's)
  const localHost = require('os').hostname().toLowerCase();
  const scanTarget = (safeHost || fqHost).split('.')[0].toLowerCase();
  if (scanTarget === localHost || scanTarget === 'localhost' || scanTarget === '127.0.0.1') {
    const dmiPath = path.join(__dirname, 'Tools', 'dmidecode.exe');
    try {
      if (fs.existsSync(dmiPath)) {
        const dmi = require('child_process').spawnSync(dmiPath, ['-t','system','-t','baseboard','-t','processor','-t','memory','-t','chassis'], { timeout: 10000, windowsHide: true });
        if (dmi.stdout && dmi.stdout.toString('utf8').trim()) {
          const dmiData = require('./lib/dmidecode').parseDmidecode(dmi.stdout.toString('utf8'));
          results.methods.dmidecode = 'success';
          results.rawOutputs = results.rawOutputs || {};
          results.rawOutputs.dmidecode = dmi.stdout.toString('utf8').substring(0, 3000);
          if (!results.system.manufacturer && dmiData.system) { results.system.manufacturer = dmiData.system.manufacturer || ''; results.system.model = dmiData.system.product || ''; results.system.serial = dmiData.system.serial || ''; }
          if (!results.motherboard?.manufacturer && dmiData.motherboard) results.motherboard = dmiData.motherboard;
          if (!results.bios?.vendor && dmiData.bios) results.bios = dmiData.bios;
          if (!results.uuid && dmiData.system?.uuid) results.uuid = dmiData.system.uuid;
          if (!results.chassisType && dmiData.chassis?.type) {
            const ct = dmiData.chassis.type;
            const chassisTypes = ['Other','Unknown','Desktop','Low Profile Desktop','Pizza Box','Mini Tower','Tower','Portable','Laptop','Notebook','Hand Held','Docking Station','All-in-One','Sub Notebook','Space-saving','Lunch Box','Main System Chassis','Expandable Chassis','Rack Mount Chassis','Sealed-case PC','Multi-system','Compact PCI','Advanced TCA','Blade','Blade Enclosure','Tablet','Convertible','Detachable','IoT Gateway','Embedded PC','Mini PC','Stick PC'];
            const ctNum = parseInt(ct);
            results.chassisType = ct;
            results.chassisTypeName = (ctNum > 0 && ctNum <= chassisTypes.length) ? chassisTypes[ctNum - 1] : ct;
          }
          if (!results.formFactor && dmiData.motherboard?.type) results.formFactor = dmiData.motherboard.type;
          if (!results.processor && dmiData.processor) results.processor = { name: dmiData.processor.model || '', manufacturer: dmiData.processor.manufacturer || '', cores: parseInt(dmiData.processor.cores) || 0, threads: parseInt(dmiData.processor.threads) || 0, maxSpeedMHz: parseInt(dmiData.processor.maxSpeed) || 0, currentSpeedMHz: parseInt(dmiData.processor.currentSpeed) || 0, socket: dmiData.processor.socket || '', socketCount: 1, serial: dmiData.processor.id || '' };
          if (results.memory.length === 0 && dmiData.memory_slots && dmiData.memory_slots.length > 0) {
            results.memory = dmiData.memory_slots.map(m => ({ deviceLocator: m.locator || '', capacityGB: m.size ? (m.size.includes('GB') ? parseFloat(m.size) : (parseFloat(m.size) || 0) / 1024) : 0, manufacturer: m.manufacturer || '', partNumber: m.part || '', speed: parseInt(m.speed) || 0 }));
            const stickTotalGB = results.memory.reduce((s, m) => s + (m.capacityGB || 0), 0);
            if (stickTotalGB > 0) results.system.totalRamMB = Math.round(stickTotalGB * 1024);
          }
        }
      }
    } catch (e) {
      results.errors.push({ priority: 0, method: 'dmidecode', reason: e.message });
    }
  }

  // FALLBACK: wmic (runs on remote via PsExec, no CIM/WinRM needed)
  // Only runs for fields that are still empty after dmidecode + PowerShell
  const wmicMissing = [];
  if (!results.os?.name) wmicMissing.push('OS');
  if (!results.system?.manufacturer && !results.system?.model) wmicMissing.push('CS');
  if (!results.bios?.vendor) wmicMissing.push('BIOS');
  if (!results.motherboard?.manufacturer) wmicMissing.push('BASEBOARD');
  if (!results.processor?.name) wmicMissing.push('CPU');

  const wmicQueries = {
    OS: { args: ['OS', 'get', 'Caption,Version,BuildNumber,SerialNumber,InstallDate,RegisteredUser,Organization', '/format:csv'], parser: (lines) => {
      for (const l of lines) { if (l.includes(',')) { const p = l.split(','); if (p.length >= 2) { results.os.name = results.os.name || p[1]?.trim(); results.os.version = results.os.version || p[2]?.trim(); results.os.build = results.os.build || p[3]?.trim(); results.os.serial = results.os.serial || p[4]?.trim(); if (p[5]) results.os.installDate = p[5].trim(); if (p[6]) results.os.registeredUser = p[6].trim(); if (p[7]) results.os.registeredOrg = p[7].trim(); } } } return results.os.name ? true : false; } },
    CS: { args: ['COMPUTERSYSTEM', 'get', 'Manufacturer,Model,SystemType', '/format:csv'], parser: (lines) => {
      for (const l of lines) { if (l.includes(',')) { const p = l.split(','); if (p.length >= 2) { results.system.manufacturer = results.system.manufacturer || p[1]?.trim(); results.system.model = results.system.model || p[2]?.trim(); results.system.systemType = results.system.systemType || p[3]?.trim(); } } } return results.system.manufacturer ? true : false; } },
    BIOS: { args: ['BIOS', 'get', 'Manufacturer,SMBIOSBIOSVersion,ReleaseDate,SerialNumber', '/format:csv'], parser: (lines) => {
      for (const l of lines) { if (l.includes(',')) { const p = l.split(','); if (p.length >= 2) { results.bios.vendor = results.bios.vendor || p[1]?.trim(); results.bios.manufacturer = results.bios.manufacturer || p[1]?.trim(); results.bios.version = results.bios.version || p[2]?.trim(); results.bios.releaseDate = results.bios.releaseDate || p[3]?.trim(); results.bios.serial = results.bios.serial || p[4]?.trim(); } } } return results.bios.vendor ? true : false; } },
    BASEBOARD: { args: ['BASEBOARD', 'get', 'Manufacturer,Product,Version,SerialNumber', '/format:csv'], parser: (lines) => {
      for (const l of lines) { if (l.includes(',')) { const p = l.split(','); if (p.length >= 2) { results.motherboard.manufacturer = results.motherboard.manufacturer || p[1]?.trim(); results.motherboard.product = results.motherboard.product || p[2]?.trim(); results.motherboard.version = results.motherboard.version || p[3]?.trim(); results.motherboard.serial = results.motherboard.serial || p[4]?.trim(); } } } return results.motherboard.manufacturer ? true : false; } },
    CPU: { args: ['CPU', 'get', 'Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed', '/format:csv'], parser: (lines) => {
      for (const l of lines) { if (l.includes(',')) { const p = l.split(','); if (p.length >= 2) { if (!results.processor?.name) results.processor = { name: p[1]?.trim() || '', manufacturer: p[2]?.trim() || '', cores: parseInt(p[3]) || 0, threads: parseInt(p[4]) || 0, maxSpeedMHz: parseInt(p[5]) || 0, currentSpeedMHz: parseInt(p[5]) || 0, socket: '', socketCount: 1, serial: '' }; } } } return results.processor?.name ? true : false; } },
  };

  for (const key of wmicMissing) {
    const q = wmicQueries[key];
    if (!q) continue;
    try {
      const res = await pstools.runPsExec(fqHost, 'wmic.exe', q.args, 20000, hwCred);
      if (res.success && res.stdout) {
        const lines = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
        const ok = q.parser(lines);
        if (ok) {
          if (!results.methods.wmic) results.methods.wmic = [];
          if (Array.isArray(results.methods.wmic)) results.methods.wmic.push(key);
        }
      }
    } catch (e) {
      results.errors.push({ priority: 2, method: `wmic(${key})`, reason: e.message });
    }
  }

  // PRIORITY 3: psloggedon
  if (!results.loggedInUser) {
    const loggedOnRes = await pstools.runPsLoggedOn(fqHost, 15000, hwCred);
    if (loggedOnRes.success && loggedOnRes.stdout) {
      results.methods.psloggedon = 'success';
      const userMatch = loggedOnRes.stdout.match(/([A-Za-z0-9._-]+\\[A-Za-z0-9._-]+)/);
      if (userMatch) results.loggedInUser = userMatch[1];
    } else if (loggedOnRes.reason) {
      results.methods.psloggedon = 'failed';
      results.errors.push({ priority: 3, method: 'PsLoggedOn', ...loggedOnRes });
    }
  }

  const hasAnyData = results.system?.manufacturer || results.system?.model || results.system?.totalRamMB ||
    results.motherboard?.manufacturer || results.motherboard?.product ||
    results.bios?.manufacturer || results.bios?.version ||
    results.processor?.name ||
    results.memory.length > 0 || results.disks.length > 0 || results.logicalDisks.length > 0 ||
    results.network.length > 0 || results.gpu.length > 0 ||
    results.os?.name ||
    results.hotfixes.length > 0 || results.software.length > 0 ||
    results.loggedInUser;

  return { results, ok: hasAnyData };
}

// ==========================================================================
// HARDWARE AUDIT — Multi-method scan with PRIORITY ORDER:
//   1st: dmidecode (local SMBIOS)                     — PRIMARY, <1s, no network
//   2nd: PowerShell (via PsExec)                      — remote OS, GPU, disks, network
//   3rd: psloggedon (via PsLoggedOn)                  — logged-in user
//
// All commands are logged with error reasons (which service failed, how to fix)
// ==========================================================================
app.post('/api/hosts/:hostname/hardware', async (req, res) => {
  const safeHost = sanitizeHost(req.params.hostname);
  const hwCred = getGlobalCredentials();
  const fqHost = safeHost.includes('.') ? safeHost : (hwCred?.domain ? safeHost + '.' + hwCred.domain : safeHost);
  const scanStartTime = Date.now();
  const initiatedFrom = req.ip || req.connection.remoteAddress || 'unknown';
  let results = null;

  try {
    const r = await scanHardware(safeHost, fqHost, hwCred);
    results = r.results;
    const ok = r.ok;

    if (!ok) {
      const firstError = results.errors[0];
      await audit.add(db, {
        actionType: 'hardware.scan', targetHost: safeHost, tool: 'multi',
        command: `Hardware scan on ${safeHost}`, success: false,
        durationMs: Date.now() - scanStartTime,
        errorReason: 'No data collected from any method',
        initiatedBy: 'admin', initiatedFrom,
        parameters: { methods: results.methods, errorCount: results.errors.length, errors: results.errors },
      });
      return res.json({
        success: false,
        error: 'No data collected. ' + (firstError?.reason || firstError?.error || 'Target may be offline.'),
        data: results, methods: results.methods,
        rawOutputs: results.rawOutputs || {},
        errorCount: results.errors.length, errors: results.errors,
      });
    }

    // SAVE — merge with previous data to avoid losing fields on partial scans
    const key = 'hardware:' + safeHost;
    let prevHw = null;
    let finalResult = results;
    let changes = [];
    try {
      const prev = db.settings.get(key, null);
      if (prev) { try { prevHw = JSON.parse(prev); } catch {} }
      if (prevHw && prevHw.hwVersion >= 2) {
        finalResult = { ...prevHw, ...results };
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
        finalResult.uuid = results.uuid || prevHw.uuid || null;
        finalResult.chassisType = results.chassisType || prevHw.chassisType || null;
        finalResult.chassisTypeName = results.chassisTypeName || prevHw.chassisTypeName || null;
        finalResult.formFactor = results.formFactor || prevHw.formFactor || null;
      }
      finalResult.methods = results.methods;
      finalResult.errors = results.errors;
      finalResult.rawOutputs = results.rawOutputs;
      db.settings.set(key, JSON.stringify(finalResult));
    } catch {}

    // UPDATE HOST RECORD
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
        changes = toTrack.filter(t => String(t.old || '') !== String(t.new || ''));
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

    // AUDIT LOG
    const scanDuration = Date.now() - scanStartTime;
    const methodSummary = Object.entries(results.methods).map(([k, v]) => `${k}:${v}`).join(', ');
    await audit.add(db, {
      actionType: 'hardware.scan', targetHost: safeHost, tool: 'dmidecode + powershell (psexec)',
      command: `Hardware scan on ${safeHost}`, success: true,
      durationMs: scanDuration,
      outputSummary: `Methods: ${methodSummary}. Found: ${results.logicalDisks.length} volumes, ${results.disks.length} disks, ${results.memory.length} RAM sticks, ${results.gpu.length} GPU(s)`,
      initiatedBy: 'admin', initiatedFrom,
      parameters: { methods: results.methods, errorCount: results.errors.length, errors: results.errors, changes: changes.length > 0 ? changes : undefined },
    });

    res.json({
      success: true, data: finalResult, methods: results.methods,
      rawOutputs: results.rawOutputs || {},
      errorCount: results.errors.length, errors: results.errors, changes,
    });

  } catch (e) {
    await audit.add(db, {
      actionType: 'hardware.scan', targetHost: safeHost, tool: 'multi',
      command: `Hardware scan on ${safeHost}`, success: false,
      durationMs: Date.now() - scanStartTime, errorReason: e.message,
      initiatedBy: 'admin', initiatedFrom,
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
        path.join(__dirname, 'Tools', 'vncviewer.exe'),
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

/* SupportHubLAN Backend Server v4.0.1 — Modular architecture */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const http = require('http');
const os = require('os');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(function(line) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  });
}

const db = require('./db');
const { setupAuth, requireAuth } = require('./auth');

const PORT = parseInt(process.env.PORT || '8080', 10);
const BIND_ADDRESS = process.env.BIND_ADDRESS || '0.0.0.0';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const AUTO_OPEN = (process.env.AUTO_OPEN_BROWSER || 'true').toLowerCase() === 'true';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS === '*' ? true : ALLOWED_ORIGINS.split(',') }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(function(req, res, next) { requireAuth(ADMIN_USER, ADMIN_PASS)(req, res, next); });

// Static frontend
const FRONTEND_PATH = path.join(__dirname, '..', 'supporthublan.html');
const VENDOR_PATH = path.join(__dirname, '..', 'vendor');
app.use('/vendor', express.static(VENDOR_PATH, { maxAge: '1d' }));
app.get('/', function(req, res) { if (fs.existsSync(FRONTEND_PATH)) { res.sendFile(FRONTEND_PATH); } else { res.status(404).send('Frontend not found'); } });
app.get('/supporthublan.html', function(req, res) { if (fs.existsSync(FRONTEND_PATH)) { res.sendFile(FRONTEND_PATH); } else { res.status(404).send('Not found'); } });

// Health check
app.get('/api/health', function(req, res) {
  const pstoolsInstalled = fs.existsSync(path.join(process.env.PSTOOLS_PATH || 'C:\\PSTools\\', 'psexec.exe'));
  res.json({ success: true, data: { server: 'SupportHubLAN Backend', version: "4.0.4", platform: os.platform(), hostname: os.hostname(), port: PORT, uptime: process.uptime(), pstoolsPath: process.env.PSTOOLS_PATH || 'C:\\PSTools\\', pstoolsInstalled: pstoolsInstalled } });
});

// Auth routes
setupAuth(app, db, ADMIN_USER, ADMIN_PASS);

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcastUpdate(data) {
  const msg = JSON.stringify(data);
  clients.forEach(function(ws) { if (ws.readyState === 1) ws.send(msg); });
}

wss.on('connection', function(ws) {
  clients.add(ws);
  ws.on('message', function(msg) {
    try {
      var data = JSON.parse(msg);
      if (data.type === 'terminal-run') {
        var command = data.command;
        var sessionId = data.sessionId;
        var parts = String(command).trim().split(/\s+/);
        var cmd = parts[0].toLowerCase();
        var PSTOOLS_PATH = process.env.PSTOOLS_PATH || 'C:\\PSTools\\';
        var toolMap = { psexec:'psexec.exe', psinfo:'psinfo.exe', pslist:'pslist.exe', pskill:'pskill.exe', psservice:'psservice.exe', psloggedon:'psloggedon.exe', psshutdown:'psshutdown.exe', psfile:'psfile.exe', psgetsid:'psgetsid.exe', pssuspend:'pssuspend.exe' };
        var exe, args;
        if (toolMap[cmd]) { exe = path.join(PSTOOLS_PATH, toolMap[cmd]); args = parts.slice(1); if (args.indexOf('-accepteula') === -1) args.push('-accepteula'); }
        else if (cmd === 'ping' || cmd === 'ping.exe') { exe = 'ping.exe'; args = parts.slice(1); }
        else if (cmd === 'powershell' || cmd === 'ps') { exe = 'powershell.exe'; args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',parts.slice(1).join(' ')]; }
        else { exe = parts[0]; args = parts.slice(1); }
        ws.send(JSON.stringify({ type: 'terminal-output', sessionId: sessionId, line: '$ ' + command + '\r\n', stream: 'command' }));
        var proc = require('child_process').spawn(exe, args, { windowsHide: false, shell: false });
        ws._terminalProcs = ws._terminalProcs || new Map();
        ws._terminalProcs.set(sessionId, proc);
        proc.stdout.on('data', function(d) { ws.send(JSON.stringify({ type: 'terminal-output', sessionId: sessionId, line: d.toString(), stream: 'stdout' })); });
        proc.stderr.on('data', function(d) { ws.send(JSON.stringify({ type: 'terminal-output', sessionId: sessionId, line: d.toString(), stream: 'stderr' })); });
        proc.on('close', function(code) {
          ws.send(JSON.stringify({ type: 'terminal-output', sessionId: sessionId, line: '\r\n[Process exited with code ' + code + ']\r\n', stream: 'exit' }));
          ws.send(JSON.stringify({ type: 'terminal-complete', sessionId: sessionId, exitCode: code }));
          if (ws._terminalProcs) ws._terminalProcs.delete(sessionId);
          db.audit.add({ action: 'terminal.run', category: 'Terminal', result: code === 0 ? 'success' : 'failed', parameters: { command: command } });
        });
        proc.on('error', function(err) { ws.send(JSON.stringify({ type: 'terminal-error', sessionId: sessionId, error: err.message })); });
      }
      if (data.type === 'terminal-kill' && ws._terminalProcs) {
        var p = ws._terminalProcs.get(data.sessionId);
        if (p) { try { p.kill('SIGTERM'); } catch(e) {} ws._terminalProcs.delete(data.sessionId); }
      }
    } catch(e) {}
  });
  ws.on('close', function() {
    if (ws._terminalProcs) { ws._terminalProcs.forEach(function(p) { try { p.kill(); } catch(e) {} }); ws._terminalProcs.clear(); }
    clients.delete(ws);
  });
  ws.send(JSON.stringify({ type: 'connected', message: 'SupportHubLAN WebSocket connected', serverTime: new Date().toISOString() }));
});

// API routes
app.use('/api/hosts', require('./routes/hosts')(db));
app.use('/api/inventories', require('./routes/inventories')(db));
app.use('/api/pstools', require('./routes/pstools')(db));
app.use('/api/services', require('./routes/services')(db));
app.use('/api/processes', require('./routes/processes')(db));
app.use('/api/power', require('./routes/power')(db));
app.use('/api/scripts', require('./routes/scripts')(db));
app.use('/api/deploy', require('./routes/deploy')(db));
app.use('/api/updates', require('./routes/updates')(db));
app.use('/api/hardware', require('./routes/hardware')(db));
app.use('/api/queues', require('./routes/queues')(db, broadcastUpdate));
app.use('/api', require('./routes/scan')(db, broadcastUpdate));
app.use('/api/laps', require('./routes/laps')(db));
app.use('/api/remote', require('./routes/remote')(db));
app.use('/api/credentials', require('./routes/credentials')(db));
app.use('/api/audit', require('./routes/audit')(db));
app.use('/api/settings', require('./routes/settings')(db));
app.use('/api', require('./routes/queues-history')(db));

// AD import
app.post('/api/hosts/discover-ad', async function(req, res) {
  var ouPath = req.body.ouPath;
  var searchScope = req.body.searchScope;
  var filter = req.body.filter;
  var nameAttr = req.body.nameAttr;
  var runPowerShell = require('./pstools').runPowerShell;
  var script = "Import-Module ActiveDirectory -ErrorAction SilentlyContinue; " +
    "$searchBase = '" + (ouPath || 'OU=Computers,DC=corp,DC=local').replace(/'/g, "''") + "'; " +
    "$scope = '" + (searchScope || 'subtree').replace(/'/g, "''") + "'; " +
    "$filter = '" + (filter || 'objectCategory=computer').replace(/'/g, "''") + "'; " +
    "$nameAttr = '" + (nameAttr || 'cn').replace(/'/g, "''") + "'; " +
    "try { $computers = Get-ADComputer -Filter $filter -SearchBase $searchBase -SearchScope $scope -Properties Name, DNSHostName, IPAddress, OperatingSystem; " +
    "$results = $computers | Select-Object @{N='name';E={$_.$nameAttr}}, @{N='fqdn';E={$_.DNSHostName}}, @{N='ip';E={$_.IPAddress}}, @{N='os';E={$_.OperatingSystem}} | ConvertTo-Json -Compress; $results } " +
    "catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }";
  var result = await runPowerShell(script, 30000);
  res.json({ success: result.success, hosts: result.stdout, error: result.stderr });
});

// Crash prevention — catch unhandled errors
process.on('uncaughtException', function(err) {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', function(reason, promise) {
  console.error('[UNHANDLED REJECTION]', reason);
});


// Express error handler — catches async route errors
app.use(function(err, req, res, next) {
  console.error('[ROUTE ERROR]', err.message);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start
server.listen(PORT, BIND_ADDRESS, function() {
  var displayIp = BIND_ADDRESS === '0.0.0.0' ? 'localhost' : BIND_ADDRESS;
  console.log('\nSupportHubLAN Backend v4.0.4 — http://' + displayIp + ':' + PORT + '\n');
  if (AUTO_OPEN && process.platform === 'win32') {
    require('child_process').exec('start http://localhost:' + PORT);
  }
});

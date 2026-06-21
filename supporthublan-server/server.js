/* SupportHubLAN Backend Server v4.0.0 — Modular architecture */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const http = require('http');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
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
app.use((req, res, next) => requireAuth(ADMIN_USER, ADMIN_PASS)(req, res, next));

// Static frontend
const FRONTEND_PATH = path.join(__dirname, '..', 'supporthublan.html');
const VENDOR_PATH = path.join(__dirname, '..', 'vendor');
app.use('/vendor', express.static(VENDOR_PATH, { maxAge: '1d' }));
app.use('/app', express.static(path.join(__dirname, '..', 'app'), { maxAge: '0' }));
app.get('/', (req, res) => fs.existsSync(FRONTEND_PATH) ? res.sendFile(FRONTEND_PATH) : res.status(404).send('Frontend not found'));
app.get('/supporthublan.html', (req, res) => fs.existsSync(FRONTEND_PATH) ? res.sendFile(FRONTEND_PATH) : res.status(404).send('Not found'));

// Health check
app.get('/api/health', (req, res) => {
  const pstoolsInstalled = fs.existsSync(path.join(process.env.PSTOOLS_PATH || 'C:\\PSTools\\', 'psexec.exe'));
  res.json({ success: true, data: { server: 'SupportHubLAN Backend', version: '4.0.0', platform: require('os').platform(), hostname: require('os').hostname(), port: PORT, uptime: process.uptime(), pstoolsPath: process.env.PSTOOLS_PATH || 'C:\\PSTools\\', pstoolsInstalled } });
});

// Auth routes
setupAuth(app, db, ADMIN_USER, ADMIN_PASS);

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();
function broadcastUpdate(data) { const msg = JSON.stringify(data); clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); }); }

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'terminal-run') {
        const { command, sessionId } = data;
        const { spawn } = require('child_process');
        const PSTOOLS_PATH = process.env.PSTOOLS_PATH || 'C:\\PSTools\\';
        const toolMap = { psexec:'psexec.exe', psinfo:'psinfo.exe', pslist:'pslist.exe', pskill:'pskill.exe', psservice:'psservice.exe', psloggedon:'psloggedon.exe', psshutdown:'psshutdown.exe', psfile:'psfile.exe', psgetsid:'psgetsid.exe', pssuspend:'pssuspend.exe' };
        const parts = String(command).trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        let exe, args;
        if (toolMap[cmd]) { exe = path.join(PSTOOLS_PATH, toolMap[cmd]); args = parts.slice(1); if (!args.includes('-accepteula')) args.push('-accepteula'); }
        else if (cmd === 'ping' || cmd === 'ping.exe') { exe = 'ping.exe'; args = parts.slice(1); }
        else if (cmd === 'powershell' || cmd === 'ps') { exe = 'powershell.exe'; args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',parts.slice(1).join(' ')]; }
        else { exe = parts[0]; args = parts.slice(1); }
        ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: `\x1b[36m$ ${command}\x1b[0m\r\n`, stream: 'command' }));
        const proc = spawn(exe, args, { windowsHide: false, shell: false });
        ws._terminalProcs = ws._terminalProcs || new Map();
        ws._terminalProcs.set(sessionId, proc);
        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: d.toString(), stream: 'stdout' })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: d.toString(), stream: 'stderr' })));
        proc.on('close', code => { ws.send(JSON.stringify({ type: 'terminal-output', sessionId, line: `\r\n[Process exited with code ${code}]\r\n`, stream: 'exit' })); ws.send(JSON.stringify({ type: 'terminal-complete', sessionId, exitCode: code })); if (ws._terminalProcs) ws._terminalProcs.delete(sessionId); db.audit.add({ action: 'terminal.run', category: 'Terminal', result: code === 0 ? 'success' : 'failed', parameters: { command } }); });
        proc.on('error', err => { ws.send(JSON.stringify({ type: 'terminal-error', sessionId, error: err.message })); });
      }
      if (data.type === 'terminal-kill' && ws._terminalProcs) { const p = ws._terminalProcs.get(data.sessionId); if (p) { try { p.kill('SIGTERM'); } catch {} ws._terminalProcs.delete(data.sessionId); } }
    } catch {}
  });
  ws.on('close', () => { if (ws._terminalProcs) { ws._terminalProcs.forEach(p => { try { p.kill(); } catch {} }); ws._terminalProcs.clear(); } clients.delete(ws); });
  ws.send(JSON.stringify({ type: 'connected', message: 'SupportHubLAN WebSocket connected', serverTime: new Date().toISOString() }));
});

// API routes — each module is a separate file
app.use('/api/hosts', require('./routes/hosts')(db));
app.use('/api/inventories', require('./routes/inventories')(db));
app.use('/api/pstools', require('./routes/pstools')(db));
app.use('/api/services', require('./routes/services')(db));
app.use('/api/processes', require('./routes/processes')(db));
app.use('/api/power', require('./routes/power')(db));
app.use('/api/scripts', require('./routes/scripts')(db));
app.use('/api/deploy', require('./routes/deploy')(db));
app.use('/api/updates', require('./routes/updates')(db));
app.use('/api/queues', require('./routes/queues')(db, broadcastUpdate));
app.use('/api', require('./routes/scan')(db, broadcastUpdate));
app.use('/api/laps', require('./routes/laps')(db));
app.use('/api/remote', require('./routes/remote')(db));
app.use('/api/credentials', require('./routes/credentials')(db));
app.use('/api/audit', require('./routes/audit')(db));
app.use('/api/settings', require('./routes/settings')(db));
app.use('/api', require('./routes/queues-history')(db));

// AD import (kept inline — uses PowerShell directly)
app.post('/api/hosts/discover-ad', async (req, res) => {
  const { ouPath, searchScope, filter, nameAttr } = req.body;
  const { runPowerShell } = require('./pstools');
  const script = `Import-Module ActiveDirectory -ErrorAction SilentlyContinue; $searchBase = '${(ouPath || 'OU=Computers,DC=corp,DC=local').replace(/'/g, "''")}'; $scope = '${(searchScope || 'subtree').replace(/'/g, "''")}'; $filter = '${(filter || 'objectCategory=computer').replace(/'/g, "''")}'; $nameAttr = '${(nameAttr || 'cn').replace(/'/g, "''")}'; try { $computers = Get-ADComputer -Filter $filter -SearchBase $searchBase -SearchScope $scope -Properties Name, DNSHostName, IPAddress, OperatingSystem; $results = $computers | Select-Object @{N='name';E={$_.$nameAttr}}, @{N='fqdn';E={$_.DNSHostName}}, @{N='ip';E={$_.IPAddress}}, @{N='os';E={$_.OperatingSystem}} | ConvertTo-Json -Compress; $results } catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }`;
  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, hosts: result.stdout, error: result.stderr });
});

// Start
server.listen(PORT, BIND_ADDRESS, () => {
  const displayIp = BIND_ADDRESS === '0.0.0.0' ? 'localhost' : BIND_ADDRESS;
  console.log(`\nSupportHubLAN Backend v4.0.0 — http://${displayIp}:${PORT}\n`);
  if (AUTO_OPEN && process.platform === 'win32') {
    require('child_process').exec(`start http://localhost:${PORT}`);
  }
});

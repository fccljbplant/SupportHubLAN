/* ==========================================================================
   SupportHubLAN Backend Server
   ==========================================================================
   This server runs on a Windows machine with admin privileges and performs
   REAL Windows administration tasks on remote hosts via:
   - Backend Remote Execution
   - System Queries
   - Windows Update Operations
   - System.Net.NetworkInformation.Ping (for host monitoring)
   - System.Net.Sockets (for Wake-on-LAN magic packets)

   PREREQUISITES:
   1. Run on Windows with Node.js 14+ installed
   2. PowerShell 5.1 or later (built into Windows 10/11/Server 2016+)
   3. Network access to target hosts
   4. PSWindowsUpdate module installed: Install-Module PSWindowsUpdate -Force
   5. Admin credentials for target hosts (domain admin or local admin)

   STARTUP:
   npm install
   npm start
   Server runs on http://localhost:3137
   ========================================================================== */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3137;

// ---- Middleware ----
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// ---- Credential Store (in-memory; in production, use encrypted storage) ----
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
  const parts = credential.username.split('\\');
  const domain = parts.length > 1 ? parts[0] : '';
  const user = parts.length > 1 ? parts[1] : credential.username;
  return `
    $secPassword = ConvertTo-SecureString '${credential.password || ''}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${credential.username}', $secPassword)
  `;
}

// ---- Helper: Standard response wrapper ----
function sendResult(res, result) {
  res.json({ success: result.success, data: result.data, error: result.error, stdout: result.stdout, stderr: result.stderr });
}

// ==========================================================================
// HEALTH CHECK
// ==========================================================================
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      server: 'SupportHubLAN Backend',
      version: '1.0.0',
      platform: os.platform(),
      hostname: os.hostname(),
      powershell: true,
      uptime: process.uptime()
    }
  });
});

// ==========================================================================
// CREDENTIALS — Store/retrieve credentials for remote operations
// ==========================================================================
app.post('/api/credentials', (req, res) => {
  const { name, username, password, domain } = req.body;
  credentialStore[name] = { username, password, domain };
  res.json({ success: true, data: { name, username } });
});

app.get('/api/credentials', (req, res) => {
  const list = Object.keys(credentialStore).map(k => ({ name: k, username: credentialStore[k].username }));
  res.json({ success: true, data: list });
});

// ==========================================================================
// HOST OPERATIONS — Real system queries to remote hosts
// ==========================================================================

// Get detailed system info from a remote host via the backend
app.post('/api/hosts/:hostname/info', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;

  const credBlock = credential ? `
    $cred = New-Object System.Management.Automation.PSCredential('${credential.username}', (ConvertTo-SecureString '${credential.password}' -AsPlainText -Force))
  ` : '';

  const script = `
    ${credBlock}
    try {
      $params = @{ ComputerName = '${hostname}'; ErrorAction = 'Stop' }
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
      @{ hostname = '${hostname}'; onlineStatus = 'offline'; error = $_.Exception.Message } | ConvertTo-Json -Compress
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

// Ping a host to check if it's online
app.post('/api/hosts/:hostname/ping', async (req, res) => {
  const { hostname } = req.params;
  const script = `
    try {
      $ping = Test-Connection -ComputerName '${hostname}' -Count 1 -Quiet -ErrorAction SilentlyContinue
      @{ hostname = '${hostname}'; online = $ping; status = if ($ping) { 'up' } else { 'down' } } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${hostname}'; online = $false; status = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress
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

// Refresh system info for a host (re-query system info)
app.post('/api/hosts/:hostname/refresh', async (req, res) => {
  req.url = `/api/hosts/${req.params.hostname}/info`;
  app.handle(req, res);
});

// ==========================================================================
// WINDOWS UPDATES — Real scan/download/install via PSWindowsUpdate module
// ==========================================================================

// Scan for available updates on remote host(s)
app.post('/api/updates/scan', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.join("','");
  const credParam = credential ? `-Credential $cred` : '';

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

// Download updates on remote host(s)
app.post('/api/updates/download', async (req, res) => {
  const { hostnames, credential, kbFilter } = req.body;
  const hostList = hostnames.join("','");
  const credParam = credential ? `-Credential $cred` : '';

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        ${kbFilter ? `$updates = Get-WindowsUpdate -ComputerName $h ${credParam} -KBArticleID '${kbFilter}' -Download -ErrorAction Stop` : `Get-WindowsUpdate -ComputerName $h ${credParam} -Download -AcceptAll -ErrorAction Stop`}
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

// Install updates on remote host(s)
app.post('/api/updates/install', async (req, res) => {
  const { hostnames, credential, kbFilter, classification, rebootBehavior } = req.body;
  const hostList = hostnames.join("','");
  const credParam = credential ? `-Credential $cred` : '';
  const rebootParam = rebootBehavior === 'always' ? '-AutoReboot' : rebootBehavior === 'if-required' ? '-AutoReboot' : '';

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $params = @{ ComputerName = $h; Install = $true; AcceptAll = $true ${rebootParam ? '; ' + rebootParam : ''} }
        ${credential ? '$params.Credential = $cred' : ''}
        ${kbFilter ? "$params.KBArticleID = '${kbFilter}'" : ''}
        ${classification ? "$params.Category = '${classification}'" : ''}
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

// Get update history from remote host
app.post('/api/updates/history', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.join("','");

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $history = Get-WUHistory -ComputerName $h ${credential ? '-Credential $cred' : ''} -ErrorAction Stop
        $results += @{
          hostname = $h
          updates = $history | Select-Object KB, Title, Date, Result | ConvertTo-Json
        }
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
// SCRIPTS & COMMANDS — Real remote execution via PowerShell Remoting
// ==========================================================================

// Execute a command/script on remote host(s)
app.post('/api/scripts/execute', async (req, res) => {
  const { hostnames, script: userScript, credential, language, timeout } = req.body;
  const hostList = hostnames.join("','");
  const timeoutSec = timeout || 60;

  const psScript = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $params = @{ ComputerName = $h; ScriptBlock = { ${userScript} }; ErrorAction = 'Stop' }
        ${credential ? '$params.Credential = $cred' : ''}
        $output = Invoke-Command @params
        $results += @{
          hostname = $h
          status = 'complete'
          exitCode = 0
          output = ($output | Out-String)
        }
      } catch {
        $results += @{ hostname = $h; status = 'failed'; exitCode = 1; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Depth 3 -Compress
  `;

  const result = await runPowerShell(psScript, (timeoutSec * 1000) + 5000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// SOFTWARE DEPLOYMENT — Copy files and execute installers remotely
// ==========================================================================

// Copy file/folder to remote host(s) and optionally execute
app.post('/api/deployments/run', async (req, res) => {
  const { hostnames, packagePath, arguments: args, credential, rebootBehavior } = req.body;
  const hostList = hostnames.join("','");
  const destPath = req.body.destinationPath || 'C:\\temp\\';

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        # Copy the file to the remote host
        $dest = "\\\\$h\\C$\\temp\\"
        if (!(Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force }
        Copy-Item '${packagePath}' $dest -Force -Recurse

        # Execute the installer silently
        $fileName = Split-Path '${packagePath}' -Leaf
        $remotePath = "C:\\temp\\$fileName"
        $invokeParams = @{ ComputerName = $h; ErrorAction = 'Stop' }
        ${credential ? '$invokeParams.Credential = $cred' : ''}

        $processScript = [ScriptBlock]::Create("Start-Process '$remotePath' -ArgumentList '${args || ''}' -Wait -NoNewWindow -PassThru")
        $proc = Invoke-Command @invokeParams -ScriptBlock $processScript

        $results += @{ hostname = $h; status = 'complete'; exitCode = $proc.ExitCode }

        ${rebootBehavior === 'always' ? `
        # Reboot if configured
        Restart-Computer -ComputerName $h ${credential ? '-Credential $cred' : ''} -Force
        ` : ''}
      } catch {
        $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;

  const result = await runPowerShell(script, 300000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Copy files/folders to remote host(s) — standalone
app.post('/api/deployments/copy', async (req, res) => {
  const { hostnames, sourcePath, destinationPath, credential } = req.body;
  const hostList = hostnames.join("','");

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $dest = "\\\\$h\\${destinationPath.replace(':', '$')}"
        Copy-Item '${sourcePath}' $dest -Force -Recurse
        $results += @{ hostname = $h; status = 'complete' }
      } catch {
        $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;

  const result = await runPowerShell(script, 120000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// SERVICES & PROCESSES — Real system queries
// ==========================================================================

// Get services on remote host
app.post('/api/services/:hostname/list', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      $params = @{ ComputerName = '${hostname}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      $services = Get-CimInstance Win32_Service @params | Select-Object Name, DisplayName, State, StartMode, ProcessId, StartName
      $services | ConvertTo-Json -Depth 2 -Compress
    } catch {
      @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;

  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Start/Stop/Restart a service on remote host
app.post('/api/services/:hostname/action', async (req, res) => {
  const { hostname } = req.params;
  const { serviceName, action, credential } = req.body;

  const actionMap = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' };
  const cmd = actionMap[action] || 'Restart-Service';

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      $params = @{ ComputerName = '${hostname}'; Name = '${serviceName}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      ${cmd} @params -Force
      @{ hostname = '${hostname}'; service = '${serviceName}'; action = '${action}'; status = 'success' } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${hostname}'; service = '${serviceName}'; action = '${action}'; status = 'failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;

  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Get processes on remote host
app.post('/api/processes/:hostname/list', async (req, res) => {
  const { hostname } = req.params;
  const { credential } = req.body;

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      $params = @{ ComputerName = '${hostname}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      $procs = Get-CimInstance Win32_Process @params | Select-Object ProcessId, Name, @{N='CPU';E={$_.UserModeTime / 10000000}}, @{N='Memory';E={[math]::Round($_.WorkingSetSize / 1MB, 1)}}
      $procs | ConvertTo-Json -Depth 2 -Compress
    } catch {
      @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;

  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Kill a process on remote host
app.post('/api/processes/:hostname/kill', async (req, res) => {
  const { hostname } = req.params;
  const { pid: procId, name, credential } = req.body;

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    try {
      $params = @{ ComputerName = '${hostname}'; ErrorAction = 'Stop' }
      ${credential ? '$params.Credential = $cred' : ''}
      ${procId ? `Invoke-Command @params -ScriptBlock { Stop-Process -Id ${procId} -Force }` : `Invoke-Command @params -ScriptBlock { Get-Process -Name '${name}' | Stop-Process -Force }`}
      @{ hostname = '${hostname}'; ${procId ? `pid = ${procId}` : `name = '${name}'`}; status = 'killed' } | ConvertTo-Json -Compress
    } catch {
      @{ hostname = '${hostname}'; status = 'failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  `;

  const result = await runPowerShell(script, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// POWER MANAGEMENT — Real reboot/shutdown/Wake-on-LAN
// ==========================================================================

// Reboot or shutdown remote host(s)
app.post('/api/power/action', async (req, res) => {
  const { hostnames, action, credential, force } = req.body;
  const hostList = hostnames.join("','");
  const forceParam = force ? '-Force' : '';

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $params = @{ ComputerName = $h; ErrorAction = 'Stop' ${forceParam ? '; ' + forceParam : ''} }
        ${credential ? '$params.Credential = $cred' : ''}
        ${action === 'reboot' ? 'Restart-Computer @params' : action === 'shutdown' ? 'Stop-Computer @params' : ''}
        $results += @{ hostname = $h; status = 'success'; action = '${action}' }
      } catch {
        $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;

  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Wake on LAN — send magic packet
app.post('/api/power/wol', async (req, res) => {
  const { macAddresses } = req.body;

  const script = `
    $results = @()
    foreach ($mac in @('${macAddresses.join("','")}')) {
      try {
        $macBytes = $mac -split '[-:]' | ForEach-Object { [Convert]::ToByte($_, 16) }
        $packet = [byte[]](,0xFF * 6) + ($macBytes * 16)
        $udp = New-Object System.Net.Sockets.UdpClient
        $udp.Connect([System.Net.IPAddress]::Broadcast, 9)
        $udp.Send($packet, $packet.Length) | Out-Null
        $udp.Close()
        $results += @{ mac = $mac; status = 'sent' }
      } catch {
        $results += @{ mac = $mac; status = 'failed'; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;

  const result = await runPowerShell(script, 10000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Check if reboot is pending on remote host(s)
app.post('/api/power/check-pending', async (req, res) => {
  const { hostnames, credential } = req.body;
  const hostList = hostnames.join("','");

  const script = `
    ${credential ? buildCredentialBlock(credential) : ''}
    $results = @()
    foreach ($h in @('${hostList}')) {
      try {
        $params = @{ ComputerName = $h; ErrorAction = 'Stop' }
        ${credential ? '$params.Credential = $cred' : ''}
        $pending = $false
        $keys = @(
          'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
          'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
        )
        $result = Invoke-Command @params -ScriptBlock {
          param($keys)
          foreach ($k in $keys) { if (Test-Path $k) { return $true } }
          return $false
        } -ArgumentList $keys
        $results += @{ hostname = $h; pendingReboot = $result }
      } catch {
        $results += @{ hostname = $h; pendingReboot = $false; error = $_.Exception.Message }
      }
    }
    $results | ConvertTo-Json -Compress
  `;

  const result = await runPowerShell(script, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// ==========================================================================
// JOB QUEUE EXECUTION — Real sequential step execution
// ==========================================================================

// Execute a job queue on target hosts
app.post('/api/queues/execute', async (req, res) => {
  const { steps, hostnames, credential, errorHandling } = req.body;

  // For long-running jobs, start async and return a job ID
  const jobId = 'job-' + Date.now();

  // Execute steps sequentially (async — don't block the HTTP response)
  (async () => {
    for (const step of steps) {
      for (const hostname of hostnames) {
        try {
          switch (step.type) {
            case 'check-updates':
              await runPowerShell(`Import-Module PSWindowsUpdate; Get-WindowsUpdate -ComputerName '${hostname}' ${credential ? '-Credential $cred' : ''}`);
              break;
            case 'download-updates':
              await runPowerShell(`Import-Module PSWindowsUpdate; Get-WindowsUpdate -ComputerName '${hostname}' ${credential ? '-Credential $cred' : ''} -Download -AcceptAll`);
              break;
            case 'install-all':
              await runPowerShell(`Import-Module PSWindowsUpdate; Install-WindowsUpdate -ComputerName '${hostname}' ${credential ? '-Credential $cred' : ''} -AcceptAll -AutoReboot`);
              break;
            case 'reboot':
              await runPowerShell(`Restart-Computer -ComputerName '${hostname}' ${credential ? '-Credential $cred' : ''} -Force`);
              break;
            case 'shutdown':
              await runPowerShell(`Stop-Computer -ComputerName '${hostname}' ${credential ? '-Credential $cred' : ''} -Force`);
              break;
            case 'wait-for-online':
              let online = false;
              for (let i = 0; i < 60; i++) {
                const r = await runPowerShell(`Test-Connection -ComputerName '${hostname}' -Count 1 -Quiet`, 5000);
                if (r.stdout.trim() === 'True') { online = true; break; }
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
              break;
            case 'run-command':
              if (step.config?.code) {
                await runPowerShell(`Invoke-Command -ComputerName '${hostname}' ${credential ? '-Credential $cred' : ''} -ScriptBlock { ${step.config.code} }`);
              }
              break;
            case 'start-service':
              if (step.config?.serviceName) {
                await runPowerShell(`Start-Service -ComputerName '${hostname}' -Name '${step.config.serviceName}' ${credential ? '-Credential $cred' : ''}`);
              }
              break;
            case 'stop-service':
              if (step.config?.serviceName) {
                await runPowerShell(`Stop-Service -ComputerName '${hostname}' -Name '${step.config.serviceName}' ${credential ? '-Credential $cred' : ''} -Force`);
              }
              break;
            case 'restart-service':
              if (step.config?.serviceName) {
                await runPowerShell(`Restart-Service -ComputerName '${hostname}' -Name '${step.config.serviceName}' ${credential ? '-Credential $cred' : ''} -Force`);
              }
              break;
            case 'wait-minutes':
              if (step.config?.minutes) {
                await new Promise(resolve => setTimeout(resolve, step.config.minutes * 60000));
              }
              break;
            // Add more step types as needed
          }
        } catch (e) {
          if (errorHandling === 'stop') break;
        }
      }
    }
    // Job complete — in production, update job status via WebSocket
  })();

  res.json({ success: true, data: { jobId, status: 'running', stepCount: steps.length, hostCount: hostnames.length } });
});

// ==========================================================================
// PSTOOLS — Execute PsTools commands on remote hosts
// ==========================================================================
app.post('/api/pstools/execute', async (req, res) => {
  const { tool, hostname, args, credential } = req.body;
  const pstoolsPath = 'C:\\PSTools\\'; // Configurable
  const toolMap = {
    psexec: 'psexec.exe', psinfo: 'psinfo.exe', pslist: 'pslist.exe',
    pskill: 'pskill.exe', psservice: 'psservice.exe', psloggedon: 'psloggedon.exe',
    psshutdown: 'psshutdown.exe', psfile: 'psfile.exe', psgetsid: 'psgetsid.exe',
    pssuspend: 'pssuspend.exe'
  };
  const exe = toolMap[tool] || 'psexec.exe';
  const target = credential ? `\\\\${hostname}` : `\\\\${hostname}`;
  const fullCmd = `"${pstoolsPath}${exe}" ${target} -accepteula ${args || ''}`;

  const result = await runPowerShell(fullCmd, 60000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Get system info via PsInfo
app.post('/api/pstools/psinfo', async (req, res) => {
  const { hostname, credential } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const cmd = `"${pstoolsPath}psinfo.exe" \\${hostname} -accepteula`;
  const result = await runPowerShell(cmd, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// List processes via PsList
app.post('/api/pstools/pslist', async (req, res) => {
  const { hostname } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const cmd = `"${pstoolsPath}pslist.exe" \\${hostname} -accepteula`;
  const result = await runPowerShell(cmd, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Kill process via PsKill
app.post('/api/pstools/pskill', async (req, res) => {
  const { hostname, target } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const cmd = `"${pstoolsPath}pskill.exe" \\${hostname} ${target} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Query services via PsService
app.post('/api/pstools/psservice', async (req, res) => {
  const { hostname, action, serviceName } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const actionCmd = action && serviceName ? `${action} "${serviceName}"` : 'query';
  const cmd = `"${pstoolsPath}psservice.exe" \\${hostname} ${actionCmd} -accepteula`;
  const result = await runPowerShell(cmd, 30000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Show logged-on users via PsLoggedOn
app.post('/api/pstools/psloggedon', async (req, res) => {
  const { hostname } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const cmd = `"${pstoolsPath}psloggedon.exe" \\${hostname} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Reboot/shutdown via PsShutdown
app.post('/api/pstools/psshutdown', async (req, res) => {
  const { hostname, action, timeout, message } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const actionFlag = action === 'shutdown' ? '-s' : action === 'abort' ? '-a' : '-r';
  const cmd = `"${pstoolsPath}psshutdown.exe" \\${hostname} ${actionFlag} -t ${timeout || 5} -c -accepteula ${message ? `-m "${message}"` : ''}`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Show open files via PsFile
app.post('/api/pstools/psfile', async (req, res) => {
  const { hostname } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const cmd = `"${pstoolsPath}psfile.exe" \\${hostname} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Get SID via PsGetSid
app.post('/api/pstools/psgetsid', async (req, res) => {
  const { hostname } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const cmd = `"${pstoolsPath}psgetsid.exe" \\${hostname} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Suspend/resume process via PsSuspend
app.post('/api/pstools/pssuspend', async (req, res) => {
  const { hostname, target, action } = req.body;
  const pstoolsPath = 'C:\\PSTools\\';
  const actionFlag = action === 'resume' ? '-r' : '';
  const cmd = `"${pstoolsPath}pssuspend.exe" ${actionFlag} \\${hostname} ${target} -accepteula`;
  const result = await runPowerShell(cmd, 15000);
  res.json({ success: result.success, data: result.stdout, error: result.stderr });
});

// Launch VNC/RDP to remote host
app.post('/api/remote/connect', async (req, res) => {
  const { hostname, ip, protocol, port } = req.body;
  if (protocol === 'VNC') {
    const vncPath = 'C:\\Program Files\\RealVNC\\VNC Viewer\\vncviewer.exe';
    spawn(vncPath, [`${ip}::${port || 5900}`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('mstsc.exe', [`/v:${ip}:${port || 3389}`], { detached: true, stdio: 'ignore' }).unref();
  }
  res.json({ success: true, data: { protocol, hostname, ip, port } });
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
      // Handle WebSocket messages (subscribe to job updates, etc.)
    } catch (e) {}
  });
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', message: 'SupportHubLAN WebSocket connected' }));
});

function broadcastUpdate(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// ==========================================================================
// START SERVER
// ==========================================================================
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SupportHubLAN Backend Server v1.0.0                         ║
║  Running on http://localhost:${PORT}                           ║
║                                                              ║
║  This server performs REAL Windows administration tasks:     ║
║  • Windows Updates (scan/download/install via PSWindowsUpdate)║
║  • PsTools suite (PsExec/PsInfo/PsList/PsKill/PsService)    ║
║  • VNC/RDP launch (vncviewer.exe / mstsc.exe)               ║
║  • Software deployment (MSI/EXE/PS1 via Invoke-Command)      ║
║  • Power management (Restart-Computer/Stop-Computer/WoL)     ║
║  • Services & Processes (Get-CimInstance/Invoke-Command)     ║
║  • Host monitoring (Test-Connection/Ping)                    ║
║  • Job Queue execution (sequential step engine)              ║
║                                                              ║
║  PREREQUISITES:                                              ║
║  1. Windows with Node.js 14+                                 ║
║  2. PowerShell 5.1+ (built into Windows)                     ║
║  3. PSWindowsUpdate module: Install-Module PSWindowsUpdate   ║
║  4. WinRM enabled on targets: winrm quickconfig              ║
║  5. Admin credentials for remote hosts                       ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

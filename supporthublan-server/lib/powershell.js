/* ==========================================================================
   SupportHubLAN PowerShell Module
   ==========================================================================
   Provides PowerShell execution for both local and remote targets.

   POWERSHELL REMOTING DOCUMENTATION (studied before implementation):
   ------------------------------------
   Reference: https://learn.microsoft.com/en-us/powershell/scripting/learn/remoting/running-remote-commands

   Two methods for running PowerShell on a remote host:

   METHOD 1: PsExec + powershell.exe (NO WinRM required)
   -----------------------------------------------------
     psexec -accepteula \\HOST -s powershell.exe -EncodedCommand <base64>
     - Uses SMB (port 445) + PSEXESVC service
     - PowerShell runs locally on the target machine
     - Does NOT require WinRM
     - Requires: PsTools, Admin$ share accessible, admin credentials

   METHOD 2: Invoke-Command (WinRM required)
   ------------------------------------------
     Invoke-Command -ComputerName HOST -ScriptBlock { ... }
     - Uses WinRM (port 5985 HTTP or 5986 HTTPS)
     - Requires: WinRM service running on target, Enable-PSRemoting run
     - Faster than PsExec (no service install overhead)

   ENCODING:
   - Remote PowerShell scripts are base64-encoded (UTF-16LE) to avoid
     quoting/escaping issues with complex scripts
   - Command: powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>

   COMMON GOTCHAS:
   - $ErrorActionPreference should be set to 'Stop' to catch errors
   - Output should be wrapped in JSON markers for reliable parsing:
       Write-Output '<<<JSON>>>' + ($result | ConvertTo-Json) + '<<<END>>>'
   - ConvertTo-Json returns a single object for 1 item, array for 2+ items
   ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');
const { logCommand, analyzeError } = require('./logger');

// ==========================================================================
// runLocal — execute a PowerShell script on the local machine
// ==========================================================================
// Usage: runLocal('Get-CimInstance Win32_OperatingSystem | ConvertTo-Json')
// Returns: { success, stdout, stderr, error, reason }
// ==========================================================================
function runLocal(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('powershell', err.message, -1);
      logCommand({ tool: 'powershell', target: 'local', command: script.substring(0, 200), success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      const reason = success ? null : analyzeError('powershell', stderr, code);
      logCommand({ tool: 'powershell', target: 'local', command: script.substring(0, 200), success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: stdout.trim(), stderr: stderr.trim(), ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runRemoteViaPsExec — execute PowerShell on a remote host via PsExec
// ==========================================================================
// This does NOT require WinRM. PsExec runs powershell.exe locally on the
// target machine via SMB + PSEXESVC.
//
// The script is base64-encoded (UTF-16LE) to avoid quoting issues.
// Output is wrapped in <<<JSON>>>...<<<END>>> markers for reliable parsing.
// ==========================================================================
function runRemoteViaPsExec(hostname, script, pstoolsPath, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = path.join(pstoolsPath, 'psexec.exe');
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const args = ['-accepteula', '\\\\' + safeHost, '-s', '-h',
      'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('psexec', err.message, -1);
      logCommand({ tool: 'psexec+powershell', target: safeHost, command: script.substring(0, 200), success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const cleanStdout = stripPsExecBanner(stdout);
      const success = code === 0 && cleanStdout.trim().length > 0;
      const reason = success ? null : analyzeError('psexec', stderr, code);
      logCommand({ tool: 'psexec+powershell', target: safeHost, command: script.substring(0, 200), success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: cleanStdout, stderr: stderr.trim(), ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runRemoteViaWinRM — execute PowerShell on a remote host via WinRM
// ==========================================================================
// This uses Invoke-Command which requires WinRM on the target.
// Faster than PsExec (no service install) but requires WinRM setup.
//
// Enable WinRM on target:
//   Enable-PSRemoting -Force
//   # or
//   winrm quickconfig
// ==========================================================================
function runRemoteViaWinRM(hostname, script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');

    // Wrap the user's script in Invoke-Command with error handling
    const wrappedScript = `
      $ErrorActionPreference = 'Stop'
      try {
        $result = Invoke-Command -ComputerName '${safeHost}' -ScriptBlock {
          $ErrorActionPreference = 'Stop'
          ${script}
        } -ErrorAction Stop
        $json = $result | ConvertTo-Json -Depth 4 -Compress
        if (-not $json) { Write-Output '<<<JSON>>>[]<<<END>>>' }
        elseif ($json -is [string]) { Write-Output ('<<<JSON>>>' + $json + '<<<END>>>') }
        else { Write-Output ('<<<JSON>>>[' + $json + ']<<<END>>>') }
      } catch {
        Write-Output ('<<<JSON>>>{"error":"' + ($_.Exception.Message -replace '"','') + '"}<<<END>>>')
      }
    `;

    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', wrappedScript
    ], { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('winrm', err.message, -1);
      logCommand({ tool: 'winrm+powershell', target: safeHost, command: script.substring(0, 200), success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      const reason = success ? null : analyzeError('winrm', stderr, code);
      logCommand({ tool: 'winrm+powershell', target: safeHost, command: script.substring(0, 200), success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: stdout.trim(), stderr: stderr.trim(), ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// stripPsExecBanner — remove PsExec's copyright/connection banner from stdout
// ==========================================================================
function stripPsExecBanner(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const lines = out.split('\n');
  let foundData = false;
  const result = [];

  for (const line of lines) {
    if (/^PsExec v/i.test(line)) continue;
    if (/^Copyright/i.test(line)) continue;
    if (/^Sysinternals/i.test(line)) continue;
    if (/^Connecting to/i.test(line)) continue;
    if (/^Starting PSEXESVC/i.test(line)) continue;
    if (/^Process exited/i.test(line)) continue;
    if (/^\s*$/.test(line) && !foundData) continue;

    if (line.includes('=') || line.includes('{') || line.includes('[') || foundData || line.includes('<<<JSON>>>')) {
      foundData = true;
      result.push(line);
    }
  }
  return result.join('\n');
}

module.exports = { runLocal, runRemoteViaPsExec, runRemoteViaWinRM, stripPsExecBanner };

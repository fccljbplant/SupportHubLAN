/* ==========================================================================
   SupportHubLAN PowerShell Module
   ==========================================================================
   Provides PowerShell execution for both local and remote targets.

   POWERSHELL REMOTING DOCUMENTATION
   ------------------------------------
   Remote PowerShell execution is done via PsExec (SMB on port 445).
   This does NOT require WinRM.

   ENCODING:
   - Remote scripts are base64-encoded (UTF-16LE) to avoid quoting issues.
   - Command: powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>

   CREDENTIALS:
   - All remote execution functions now accept an optional `credential`
     object { username, password, domain } which is forwarded to PsExec
     via -u DOMAIN\\user -p password. Credentials are MASKED in logs.
   - If credential is omitted, the current process token is used.
   ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');
const { logCommand, analyzeError } = require('./logger');
const { toFqdn, credentialArgs, maskPassword, stripPsExecBanner } = require('./utils');

// ==========================================================================
// runLocal — execute a PowerShell script on the local machine
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
// If `shouldWrapMarkers` is true (default), the script is automatically
// wrapped in JSON markers (<<<JSON>>>...<<<END>>>) for reliable parsing.
//
// CREDENTIALS:
//   credential = { username, password, domain } | null
//   Domain can be "" for local accounts. Full username is DOMAIN\USER.
// ==========================================================================
function runRemoteViaPsExec(hostname, script, pstoolsPath, timeoutMs = 45000, credential) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = toFqdn(hostname, credential).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = path.join(pstoolsPath, 'psexec.exe');
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const args = ['-accepteula', '\\\\' + safeHost,
      ...credentialArgs(credential, safeHost),
      '-s', '-h',
      'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('psexec', err.message, -1);
      const cmd = maskPassword(`psexec +powershell on ${safeHost} (script: ${script.substring(0, 100)})`);
      logCommand({ tool: 'psexec+powershell', target: safeHost, command: cmd, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const cleanStdout = stripPsExecBanner(stdout);
      const success = code === 0;
      const reason = success ? null : analyzeError('psexec', stderr, code);
      const cmd = maskPassword(`psexec +powershell on ${safeHost} (script: ${script.substring(0, 100)})`);
      logCommand({ tool: 'psexec+powershell', target: safeHost, command: cmd, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: cleanStdout, stderr: stderr.trim(), ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runRemoteViaWinRM — execute PowerShell on a remote host via WinRM
// ==========================================================================
// This uses Invoke-Command which requires WinRM on the target.
// Available as fallback, but the primary method is PsExec (above).
// ==========================================================================
function runRemoteViaWinRM(hostname, script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');

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

module.exports = { runLocal, runRemoteViaPsExec, runRemoteViaWinRM };

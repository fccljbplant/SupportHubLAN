/* ==========================================================================
   SupportHubLAN WinRM Module
   ==========================================================================
   Provides WinRM (Windows Remote Management) connectivity testing and
   remote command execution.

   WINRM DOCUMENTATION (studied before implementation):
   ------------------------------------
   Reference: https://learn.microsoft.com/en-us/windows/win32/winrm/portal

   WinRM is the Microsoft implementation of the WS-Management Protocol
   — a standard SOAP-based protocol that allows hardware and operating
   systems to communicate remotely.

   PREREQUISITES on the target PC:
   1. WinRM service must be running:
        net start WinRM
   2. WinRM must be configured for remote management:
        winrm quickconfig        (or: Enable-PSRemoting -Force)
   3. Windows Firewall must allow WinRM:
        Port 5985 (HTTP) — default
        Port 5986 (HTTPS) — requires certificate
   4. The caller must be in the local Administrators group on the target

   HOW TO ENABLE WINRM ON A REMOTE PC (via PsExec, since WinRM is not yet running):
     psexec \\HOST -s winrm quickconfig -quiet
     psexec \\HOST -s powershell -Command "Enable-PSRemoting -Force"

   ADVANTAGES over PsExec:
   - No service installation (PSEXESVC) needed
   - Faster (no SMB service install overhead)
   - Standard protocol (works with Linux/Ansible too)
   - Better error reporting

   DISADVANTAGES:
   - Requires WinRM setup on each target (not enabled by default on desktop OS)
   - Requires port 5985/5986 open in firewall
   ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');
const { logCommand, analyzeError } = require('./logger');

// ==========================================================================
// testWinRM — test if WinRM is available on a remote host
// ==========================================================================
// Runs a simple "Test-WSMan" against the target. If it succeeds, WinRM
// is running and accessible.
// Returns: { available, error, reason }
// ==========================================================================
function testWinRM(hostname, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const script = `Test-WSMan -ComputerName '${safeHost}' -ErrorAction SilentlyContinue; if ($?) { 'WINRM_OK' } else { 'WINRM_FAIL' }`;

    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const available = stdout.includes('WINRM_OK');
      const reason = available ? null : analyzeError('winrm', stderr, code);
      logCommand({ tool: 'winrm-test', target: safeHost, command: 'Test-WSMan', success: available, error: available ? null : stderr, ...(reason || {}), duration });
      resolve({ available, error: available ? null : stderr, ...(reason || {}) });
    });

    proc.on('error', (err) => {
      const reason = analyzeError('winrm', err.message, -1);
      logCommand({ tool: 'winrm-test', target: safeHost, command: 'Test-WSMan', success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ available: false, error: err.message, ...reason });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// enableWinRM — try to enable WinRM on a remote host via PsExec
// ==========================================================================
// If WinRM is not running on the target, this function uses PsExec to
// run "winrm quickconfig" and "Enable-PSRemoting" on the target.
// After enabling, it tests again to confirm.
//
// Requires: PsTools installed, Admin$ share accessible on target.
// ==========================================================================
function enableWinRM(hostname, pstoolsPath, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = path.join(pstoolsPath, 'psexec.exe');

    // Run winrm quickconfig + Enable-PSRemoting on the target
    const script = `winrm quickconfig -quiet 2>&1; Enable-PSRemoting -Force -ErrorAction SilentlyContinue 2>&1; Write-Output 'DONE'`;
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const args = ['-accepteula', '\\\\' + safeHost, '-s', '-h',
      'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0 && stdout.includes('DONE');
      const reason = success ? null : analyzeError('psexec', stderr, code);
      logCommand({ tool: 'winrm-enable', target: safeHost, command: 'winrm quickconfig + Enable-PSRemoting', success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout, stderr, ...(reason || {}) });
    });

    proc.on('error', (err) => {
      const reason = analyzeError('psexec', err.message, -1);
      logCommand({ tool: 'winrm-enable', target: safeHost, command: 'winrm quickconfig + Enable-PSRemoting', success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, error: err.message, ...reason });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runRemote — execute a PowerShell command on a remote host via WinRM
// ==========================================================================
// Uses Invoke-Command -ComputerName which requires WinRM on the target.
// Falls back to telling the caller to enable WinRM if it's not available.
// ==========================================================================
function runRemote(hostname, script, timeoutMs = 30000) {
  return new Promise(async (resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');

    // First test if WinRM is available
    const test = await testWinRM(safeHost, 8000);
    if (!test.available) {
      resolve({
        success: false,
        stdout: '',
        stderr: test.error || 'WinRM not available',
        reason: test.reason || 'WinRM is not running on the target PC',
        service: 'Windows Remote Management (WinRM)',
        fix: 'On the target PC, run as admin: Enable-PSRemoting -Force  OR  winrm quickconfig. Or use PsExec method instead.',
      });
      return;
    }

    // WinRM is available — run the command via Invoke-Command
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

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      const reason = success ? null : analyzeError('winrm', stderr, code);
      logCommand({ tool: 'winrm', target: safeHost, command: script.substring(0, 200), success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: stdout.trim(), stderr: stderr.trim(), ...(reason || {}) });
    });

    proc.on('error', (err) => {
      const reason = analyzeError('winrm', err.message, -1);
      logCommand({ tool: 'winrm', target: safeHost, command: script.substring(0, 200), success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

module.exports = { testWinRM, enableWinRM, runRemote };

/* ==========================================================================
   SupportHubLAN PsTools Module
   ==========================================================================
   Provides execution of Sysinternals PsTools commands (PsInfo, PsLoggedOn,
   PsExec, PsList, PsKill, PsService, PsShutdown) with optional explicit
   domain credentials.

   Every command that targets a remote PC now uses the global domain
   credentials configured in Settings → General → Default Domain Credentials.
   If no credentials are provided, the current process token is used (legacy
   behaviour — only works when the server is running as a privileged domain
   account on the same LAN).

   PSTOOLS DOCUMENTATION
   ------------------------------------
   Reference: https://docs.microsoft.com/en-us/sysinternals/downloads/pstools

   PsExec:
     psexec -accepteula \\HOST [-u user] [-p password] [-s] [-h] command [args]
     -accepteula  MUST be placed BEFORE \\HOST

   PsInfo, PsList, PsKill, PsService, PsLoggedOn, PsShutdown:
     tool \\HOST [-u user] [-p password] [-accepteula] [tool-specific args]
   ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');
const { logCommand, analyzeError } = require('./logger');
const { toFqdn, credentialArgs, maskPassword, stripPsExecBanner } = require('./utils');

const PSTOOLS_PATH = process.env.PSTOOLS_PATH || path.join(__dirname, '..', 'PSTools') + path.sep;

function pstoolsExe(name) {
  return path.join(PSTOOLS_PATH, name);
}

// ==========================================================================
// runPsInfo — run psinfo.exe against a remote host with optional credentials
// ==========================================================================
function runPsInfo(hostname, flags = ['-d', '-h', '-s', '-c'], timeoutMs = 30000, credential) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = toFqdn(hostname, credential).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe('psinfo.exe');
    const args = [...flags, '-accepteula', '\\\\' + safeHost, ...credentialArgs(credential, safeHost)];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('pstools', err.message, -1);
      const cmd = maskPassword(`psinfo ${flags.join(' ')} \\${safeHost} -u *** -p ***`);
      logCommand({ tool: 'psinfo', target: safeHost, command: cmd, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const cleanStdout = stripPsExecBanner(stdout);
      const success = code === 0 && cleanStdout.length > 0;
      const reason = success ? null : analyzeError('pstools', stderr, code);
      const cmd = maskPassword(`psinfo ${flags.join(' ')} \\${safeHost} -u *** -p ***`);
      logCommand({ tool: 'psinfo', target: safeHost, command: cmd, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: cleanStdout, stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runPsLoggedOn — run psloggedon.exe against a remote host
// ==========================================================================
function runPsLoggedOn(hostname, timeoutMs = 15000, credential) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = toFqdn(hostname, credential).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe('psloggedon.exe');
    const args = ['-l', '-x', '\\\\' + safeHost];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('pstools', err.message, -1);
      const cmd = maskPassword(`psloggedon \\${safeHost} -u *** -p ***`);
      logCommand({ tool: 'psloggedon', target: safeHost, command: cmd, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      const reason = success ? null : analyzeError('pstools', stderr, code);
      const cmd = maskPassword(`psloggedon \\${safeHost} -u *** -p ***`);
      logCommand({ tool: 'psloggedon', target: safeHost, command: cmd, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout, stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runPsExec — run a command on a remote host via PsExec with explicit creds
// ==========================================================================
function runPsExec(hostname, command, args = [], timeoutMs = 30000, credential) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = toFqdn(hostname, credential).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe('psexec.exe');
    // CRITICAL: -accepteula goes BEFORE \\HOST; -u/-p go after \\HOST but
    // before the command so they are treated as PsExec options.
    const fullArgs = ['-accepteula', '\\\\' + safeHost, ...credentialArgs(credential, safeHost), '-s', '-h', command, ...args];

    const proc = spawn(exe, fullArgs, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('psexec', err.message, -1);
      const cmd = maskPassword(`psexec \\${safeHost} -u *** -p *** -s -h ${command} ${args.join(' ')}`);
      logCommand({ tool: 'psexec', target: safeHost, command: cmd, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const cleanStdout = stripPsExecBanner(stdout);
      const success = code === 0;
      const reason = success ? null : analyzeError('psexec', stderr, code);
      const cmd = maskPassword(`psexec \\${safeHost} -u *** -p *** -s -h ${command} ${args.join(' ')}`);
      logCommand({ tool: 'psexec', target: safeHost, command: cmd, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: cleanStdout, stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runGeneric — run any PsTool (pslist, pskill, psservice, psshutdown, ...)
// ==========================================================================
function runGeneric(toolName, hostname, extraArgs = [], timeoutMs = 30000, credential) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = toFqdn(hostname, credential).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe(toolName + '.exe');
    const args = ['-accepteula', '\\\\' + safeHost, ...credentialArgs(credential, safeHost), ...extraArgs];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('pstools', err.message, -1);
      const cmd = maskPassword(`${toolName} \\${safeHost} -u *** -p *** ${extraArgs.join(' ')}`);
      logCommand({ tool: toolName, target: safeHost, command: cmd, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      const reason = success ? null : analyzeError('pstools', stderr, code);
      const cmd = maskPassword(`${toolName} \\${safeHost} -u *** -p *** ${extraArgs.join(' ')}`);
      logCommand({ tool: toolName, target: safeHost, command: cmd, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: stdout.trim(), stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// pingParallel — fast parallel ping sweep using ping.exe (NO PowerShell)
// ==========================================================================
function pingParallel(ips, concurrency = 64, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const results = new Array(ips.length);
    let completed = 0;
    let nextIndex = 0;

    function launchNext() {
      if (nextIndex >= ips.length) return;
      const idx = nextIndex++;
      const ip = ips[idx];

      const proc = spawn('ping.exe', ['-n', '2', '-w', String(timeoutMs), ip], { windowsHide: true });
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('error', () => {
        results[idx] = { ip, online: false };
        completed++;
        if (completed === ips.length) resolve(results);
        else launchNext();
      });
      proc.on('close', () => {
        const online = /\bReply from\b/i.test(stdout) && !/Destination host unreachable/i.test(stdout);
        results[idx] = { ip, online };
        completed++;
        if (completed === ips.length) resolve(results);
        else launchNext();
      });
      setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
    }

    if (ips.length === 0) { resolve([]); return; }
    const initialBatch = Math.min(concurrency, ips.length);
    for (let i = 0; i < initialBatch; i++) launchNext();
  });
}

// ==========================================================================
// runSystemInfo — query a remote host via systeminfo.exe (RPC, NO Admin$/SMB)
// ==========================================================================
// systeminfo.exe /S HOST uses RPC (port 135 + dynamic ports) — the same
// protocol PsLoggedOn uses. It does NOT require Admin$, PsExec, or WinRM.
// This is the fallback for hosts where UAC blocks the Admin$ share.
//
// Reference: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/systeminfo
// ==========================================================================
function runSystemInfo(hostname, timeoutMs = 45000, credential) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = toFqdn(hostname, credential).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const args = ['/S', safeHost];

    if (credential && credential.username && credential.password) {
      const fullUser = credential.domain ? `${credential.domain}\\${credential.username}` : credential.username;
      args.push('/U', fullUser, '/P', credential.password);
    }

    const proc = spawn('systeminfo.exe', args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const cmd = maskPassword(`systeminfo /S ${safeHost} /U *** /P ***`);
      logCommand({ tool: 'systeminfo', target: safeHost, command: cmd, success: false, error: err.message, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, reason: err.message });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0 && stdout.length > 100;
      const cmd = maskPassword(`systeminfo /S ${safeHost} /U *** /P ***`);
      if (success) {
        const parsed = parseSystemInfo(stdout);
        logCommand({ tool: 'systeminfo', target: safeHost, command: cmd, success: true, duration });
        resolve({ success: true, stdout, stderr: '', parsed });
      } else {
        const reason = analyzeError('pstools', stderr, code);
        logCommand({ tool: 'systeminfo', target: safeHost, command: cmd, success: false, error: stderr, ...(reason || {}), duration });
        resolve({ success: false, stdout, stderr, parsed: null, ...(reason || {}) });
      }
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// parseSystemInfo — parse systeminfo.exe default output into key-value pairs
// ==========================================================================
function parseSystemInfo(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const lines = out.split('\n');
  const result = {};
  let currentKey = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { currentKey = null; continue; }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && colonIdx < 50) {
      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();
      result[key] = value;
      currentKey = key;
    } else if (currentKey && colonIdx === -1) {
      result[currentKey] += '\n' + trimmed;
    }
  }

  return result;
}

module.exports = {
  runPsInfo, runPsLoggedOn, runPsExec, runGeneric, pingParallel,
  runSystemInfo, parseSystemInfo,
  pstoolsExe, PSTOOLS_PATH,
  credentialArgs, // re-exported from utils for backward compat (used by server.js)
};

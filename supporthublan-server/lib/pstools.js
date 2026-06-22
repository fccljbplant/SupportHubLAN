/* ==========================================================================
   SupportHubLAN PsTools Module
   ==========================================================================
   Provides execution of Sysinternals PsTools commands (PsInfo, PsLoggedOn,
   PsExec) and fast parallel ping sweep.

   PSTOOLS DOCUMENTATION (studied before implementation):
   ------------------------------------
   Reference: https://docs.microsoft.com/en-us/sysinternals/downloads/pstools

   PsInfo:
     psinfo [-h] [-s] [-d] [-c] [\\HOST]
       -h  Show installed hotfixes
       -s  Show installed software
       -d  Show disk volume information
       -c  Output in CSV format
       -t  CSV delimiter (use with -c)

   PsLoggedOn:
     psloggedon [-l] [-x] [\\HOST]
       -l  Show only local logons (not network)
       -x  Don't show logon time

   PsExec:
     psexec [\\HOST] [-s] [-h] [-u user] [-p pass] command [args]
       -accepteula  MUST be placed BEFORE \\HOST (it's a PsExec option)
       -s           Run as SYSTEM account
       -h           Run with elevated privileges
       -u -p        Alternate credentials

   CRITICAL: -accepteula placement:
     CORRECT: psexec -accepteula \\HOST -s command args
     WRONG:   psexec \\HOST -s command args -accepteula
     (In the wrong version, -accepteula is passed to the remote command
      as an argument, causing it to fail silently.)
   ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');
const { logCommand, analyzeError } = require('./logger');

const PSTOOLS_PATH = process.env.PSTOOLS_PATH || 'C:\\PSTools\\';

function pstoolsExe(name) {
  return path.join(PSTOOLS_PATH, name);
}

// ==========================================================================
// runPsInfo — run psinfo.exe against a remote host
// ==========================================================================
// Usage: runPsInfo('HOST', ['-d', '-h', '-s', '-c'])
// Returns: { success, stdout, stderr, error, reason }
// ==========================================================================
function runPsInfo(hostname, flags = ['-d', '-h', '-s', '-c'], timeoutMs = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe('psinfo.exe');
    const args = [...flags, '\\\\' + safeHost];
    // PsInfo needs -accepteula appended (it's a psinfo option, not a psexec option)
    if (!args.includes('-accepteula')) args.push('-accepteula');

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('pstools', err.message, -1);
      logCommand({ tool: 'psinfo', target: safeHost, command: `psinfo ${flags.join(' ')} \\${safeHost}`, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0 && stdout.length > 0;
      const reason = success ? null : analyzeError('pstools', stderr, code);
      logCommand({ tool: 'psinfo', target: safeHost, command: `psinfo ${flags.join(' ')} \\${safeHost}`, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout, stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runPsLoggedOn — run psloggedon.exe against a remote host
// ==========================================================================
function runPsLoggedOn(hostname, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe('psloggedon.exe');
    const args = ['\\\\' + safeHost, '-accepteula'];

    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('pstools', err.message, -1);
      logCommand({ tool: 'psloggedon', target: safeHost, command: `psloggedon \\${safeHost}`, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      const reason = success ? null : analyzeError('pstools', stderr, code);
      logCommand({ tool: 'psloggedon', target: safeHost, command: `psloggedon \\${safeHost}`, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout, stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runPsExec — run a command on a remote host via PsExec
// ==========================================================================
// Usage: runPsExec('HOST', 'ipconfig', ['/all'])
// The resulting command: psexec -accepteula \\HOST -s ipconfig /all
// ==========================================================================
function runPsExec(hostname, command, args = [], timeoutMs = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const exe = pstoolsExe('psexec.exe');
    // CRITICAL: -accepteula goes BEFORE \\HOST (it's a psexec option)
    const fullArgs = ['-accepteula', '\\\\' + safeHost, '-s', command, ...args];

    const proc = spawn(exe, fullArgs, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('psexec', err.message, -1);
      logCommand({ tool: 'psexec', target: safeHost, command: `psexec \\${safeHost} -s ${command} ${args.join(' ')}`, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, stdout: '', stderr: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const cleanStdout = stripPsExecBanner(stdout);
      const success = code === 0 && cleanStdout.trim().length > 0;
      const reason = success ? null : analyzeError('psexec', stderr, code);
      logCommand({ tool: 'psexec', target: safeHost, command: `psexec \\${safeHost} -s ${command} ${args.join(' ')}`, success, error: success ? null : stderr, ...(reason || {}), duration });
      resolve({ success, stdout: cleanStdout, stderr, ...(reason || {}) });
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// pingParallel — fast parallel ping sweep using ping.exe
// ==========================================================================
// Spawns up to `concurrency` ping.exe processes simultaneously.
// Much faster than PowerShell Test-Connection — ping.exe starts in ~50ms
// vs PowerShell's ~3-5s startup.
// ==========================================================================
function pingParallel(ips, concurrency = 64, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const results = new Array(ips.length);
    let completed = 0;
    let nextIndex = 0;

    function launchNext() {
      if (nextIndex >= ips.length) return;
      const idx = nextIndex++;
      const ip = ips[idx];

      const proc = spawn('ping.exe', ['-n', '1', '-w', String(timeoutMs), ip], { windowsHide: true });
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
// stripPsExecBanner — remove PsExec banner from stdout
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
    foundData = true;
    result.push(line);
  }
  return result.join('\n');
}

module.exports = {
  runPsInfo, runPsLoggedOn, runPsExec, pingParallel,
  pstoolsExe, PSTOOLS_PATH, stripPsExecBanner,
};

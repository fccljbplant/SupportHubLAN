/* PsTools execution helpers — all PsExec/PsInfo/etc calls go through here */
const path = require('path');
const { spawn } = require('child_process');

const PSTOOLS_PATH = process.env.PSTOOLS_PATH || 'C:\\PSTools\\';

function sanitizeHost(h) {
  return String(h).replace(/[^a-zA-Z0-9._\-:]/g, '');
}

function runPowerShell(script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { timeout: timeoutMs, windowsHide: true });
    let stdout = '', stderr = '';
    ps.stdout.on('data', (d) => stdout += d.toString());
    ps.stderr.on('data', (d) => stderr += d.toString());
    ps.on('close', (code) => resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code }));
    ps.on('error', (err) => resolve({ success: false, stdout: '', stderr: err.message, exitCode: -1 }));
  });
}

// ---------------------------------------------------------------------------
// runPsToolDirect — run a PsTools executable directly via child_process.spawn,
// NO PowerShell wrapper. This is faster, simpler, and avoids the PowerShell
// startup overhead and quoting headaches. Used for hardware scans, event
// logs, and other endpoints where the user explicitly said "skip powershell".
//
// `exeName` is just the filename (e.g. 'psinfo.exe', 'psexec.exe').
// `args` is an array of string arguments (we do NOT shell-escape; spawn
// passes them through verbatim).
// `timeoutMs` kills the process after N ms.
// ---------------------------------------------------------------------------
function runPsToolDirect(exeName, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const exe = pstoolsExe(exeName);
    const finalArgs = Array.isArray(args) ? args.slice() : [];
    // Auto-add -accepteula for PsTools exes (avoids the EULA dialog hang)
    if (/\.(exe)$/i.test(exeName) && !finalArgs.includes('-accepteula')) {
      finalArgs.push('-accepteula');
    }
    let proc;
    try {
      proc = spawn(exe, finalArgs, { windowsHide: true, timeout: timeoutMs });
    } catch (e) {
      return resolve({ success: false, stdout: '', stderr: 'spawn failed: ' + e.message, exitCode: -1 });
    }
    let stdout = '', stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, stdout, stderr: stderr + '\n' + err.message, exitCode: -1 });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !killed,
        stdout: stdout,
        stderr: stderr,
        exitCode: code,
        timedOut: killed,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// runRemoteCmdDirect — run a command on a remote host via PsExec, without
// PowerShell. Example: runRemoteCmdDirect('HOST', ['ipconfig', '/all']).
// Returns the raw stdout from the remote command (still contains the PsExec
// banner, which the caller should strip).
// ---------------------------------------------------------------------------
function runRemoteCmdDirect(hostname, remoteCmdArgs, timeoutMs = 30000) {
  const safeHost = sanitizeHost(hostname);
  const args = ['\\\\' + safeHost, '-s'].concat(remoteCmdArgs);
  return runPsToolDirect('psexec.exe', args, timeoutMs);
}

function buildCredentialBlock(credential) {
  if (!credential || !credential.username) return '';
  return `
    $secPassword = ConvertTo-SecureString '${(credential.password || '').replace(/'/g, "''")}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${credential.username.replace(/'/g, "''")}', $secPassword)
  `;
}

function pstoolsExe(name) {
  return path.join(PSTOOLS_PATH, name);
}

// ---------------------------------------------------------------------------
// extractJsonFromOutput — strip the PsExec banner and pull the JSON payload.
// PsExec output looks like:
//   PsExec v2.43 - Execute processes remotely
//   Copyright (C) 2001-2023 Mark Russinovich
//   Sysinternals - www.sysinternals.com
//
//   <actual JSON here>
//
// We try several strategies in order:
//   1) Marker-wrapped: <<<JSON>>>...<<<END>>>  (preferred — set by callers)
//   2) First `{` or `[` to last matching `}` or `]`
//   3) Whole output trimmed
// ---------------------------------------------------------------------------
function extractJsonFromOutput(raw) {
  if (!raw) return null;
  // 1) Marker-wrapped
  const m = /<<<JSON>>>([\s\S]*?)<<<END>>>/.exec(raw);
  if (m) {
    try { return JSON.parse(m[1].trim()); } catch {}
  }
  // 2) First { or [ to last matching } or ]
  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  let start = -1, openChar, closeChar;
  if (firstBrace === -1 && firstBracket === -1) return null;
  if (firstBrace === -1) { start = firstBracket; openChar = '['; closeChar = ']'; }
  else if (firstBracket === -1) { start = firstBrace; openChar = '{'; closeChar = '}'; }
  else if (firstBrace < firstBracket) { start = firstBrace; openChar = '{'; closeChar = '}'; }
  else { start = firstBracket; openChar = '['; closeChar = ']'; }
  const end = raw.lastIndexOf(closeChar);
  if (end > start) {
    const slice = raw.substring(start, end + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return null;
}

module.exports = {
  sanitizeHost, runPowerShell, runPsToolDirect, runRemoteCmdDirect,
  buildCredentialBlock, pstoolsExe, PSTOOLS_PATH, extractJsonFromOutput,
};

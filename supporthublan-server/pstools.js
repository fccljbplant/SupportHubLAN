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

module.exports = { sanitizeHost, runPowerShell, buildCredentialBlock, pstoolsExe, PSTOOLS_PATH };

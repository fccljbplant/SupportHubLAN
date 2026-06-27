/* ==========================================================================
   SupportHubLAN Logger + Error Analyzer
   ==========================================================================
   Every command executed on a remote host is logged with enough context
   to diagnose WHY it failed. The error analyzer maps known error patterns
   to actionable messages (e.g. "WinRM service not running on target",
   "Admin$ share not accessible", "Firewall blocking port 445").

   Usage:
     const { logCommand, analyzeError } = require('./lib/logger');
     const reason = analyzeError('psexec', stderr, exitCode);
     logCommand({ tool: 'psexec', target: 'HOST', command: 'wmic ...',
                  success: false, error: reason, duration: 5000 });
   ========================================================================== */

const fs = require('fs');
const path = require('path');

// Log file path — commands.log in the server's data directory
const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'commands.log');

// Ensure data directory exists
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// In-memory log buffer (also written to file)
const _logBuffer = [];
const MAX_BUFFER = 500;

// ==========================================================================
// analyzeError — map known error patterns to actionable human-readable reasons
// ==========================================================================
// Each tool has specific failure modes. This function inspects the stderr
// output and exit code, then returns a { reason, service, fix } object
// explaining what went wrong and how to fix it.
//
// Common error patterns are documented below based on Microsoft docs:
//   https://docs.microsoft.com/en-us/sysinternals/downloads/psexec
//   https://docs.microsoft.com/en-us/windows/win32/wmisdk/wmi-start-page
//   https://docs.microsoft.com/en-us/powershell/scripting/learn/remoting/running-remote-commands
// ==========================================================================

function analyzeError(tool, stderr, exitCode) {
  const err = String(stderr || '').toLowerCase();
  const code = exitCode;

  // ---- PsExec errors ----
  if (tool === 'psexec' || tool === 'pstools') {
    if (/access is denied/.test(err))
      return { reason: 'Access denied — admin credentials required on the remote PC', service: 'Admin$ share (SMB)', fix: 'Ensure the user account is a member of the local Administrators group on the target PC, or provide credentials with -u DOMAIN\\user -p password' };
    if (/the network path was not found|network path.*not.*found/.test(err))
      return { reason: 'Network path not found — host is offline or firewall is blocking SMB (port 445)', service: 'File and Printer Sharing (SMB-In)', fix: 'Verify the host is online and that File and Printer Sharing is enabled in Windows Firewall on the target PC' };
    if (/couldn't install psexesvc|could not install psexesvc|psexesvc/.test(err))
      return { reason: 'Could not install PSEXESVC service — Admin$ share not accessible or UAC is blocking', service: 'Server service + Admin$ share', fix: 'Ensure the Server service is running on the target, Admin$ share is accessible, and UAC Remote Restriction is not blocking. Run the server as Administrator.' };
    if (/error deriving session key|session key/.test(err))
      return { reason: 'Authentication error — could not derive session key', service: 'SMB authentication', fix: 'Check that the username/password are correct and the account has remote administration rights' };
    if (/the handle is invalid/.test(err))
      return { reason: 'Handle invalid — PsExec could not connect to the remote service manager', service: 'Remote Service Manager (RPC)', fix: 'Ensure Remote Procedure Call (RPC) service is running on the target PC and that the admin$ share is accessible' };
    if (/connecting to/.test(err) && /system/.test(err))
      return { reason: 'Could not connect to the remote system — host may be offline or refusing connections', service: 'SMB (port 445)', fix: 'Verify the host is online, not blocked by firewall, and that the Server service is running' };
  }

  // ---- wmic errors ----
  if (tool === 'wmic') {
    if (/rpc server is unavailable|rpc.*unavailable/.test(err))
      return { reason: 'RPC server unavailable — Remote Procedure Call service not running on target PC', service: 'Remote Procedure Call (RPC)', fix: 'Start the RPC service on the target PC: net start RpcSs. Also check that Windows Management Instrumentation (WMI) service is running.' };
    if (/access is denied/.test(err))
      return { reason: 'Access denied — WMI permissions required on the remote PC', service: 'Windows Management Instrumentation (WMI)', fix: 'Ensure the user account has WMI permissions on the target. Add to Distributed COM Users group or grant WMI namespace permissions.' };
    if (/invalid class/.test(err))
      return { reason: 'Invalid WMI class — the class name is wrong or not available on this Windows version', service: 'WMI', fix: 'Check the WMI class name. Some classes are not available on older Windows versions.' };
    if (/node not found|not found.*namespace/.test(err))
      return { reason: 'WMI node not found — hostname could not be resolved or WMI namespace is unavailable', service: 'WMI + DNS', fix: 'Verify the hostname resolves via DNS or NetBIOS. Ensure WMI service is running on the target.' };
    if (/not a valid wmi/.test(err))
      return { reason: 'Invalid WMI query — syntax error in the WQL or field names', service: 'WMI', fix: 'Check the wmic command syntax: wmic /node:HOST <class> get <field1,field2> /format:list' };
  }

  // ---- PowerShell / WinRM errors ----
  if (tool === 'powershell' || tool === 'winrm') {
    if (/winrm cannot complete the operation|cannot process the request/.test(err))
      return { reason: 'WinRM not configured on the remote PC — Windows Remote Management service is not running or not enabled', service: 'Windows Remote Management (WinRM)', fix: 'On the target PC, run as admin: Enable-PSRemoting -Force  OR  winrm quickconfig' };
    if (/the connection to the specified remote host was refused|connection refused/.test(err))
      return { reason: 'WinRM connection refused — WinRM service is stopped or port 5985 is blocked by firewall', service: 'WinRM (port 5985)', fix: 'Start WinRM service on target: net start WinRM. Open port 5985 in Windows Firewall.' };
    if (/access is denied/.test(err))
      return { reason: 'Access denied — account is not in the local Administrators group on the remote PC', service: 'WinRM + Local Admin', fix: 'Add the user account to the Administrators group on the target PC, or configure WinRM to allow non-admin users (not recommended).' };
    if (/the winrm client received an http status code of 403|403/.test(err))
      return { reason: 'WinRM returned 403 Forbidden — the WinRM listener is configured but access is denied', service: 'WinRM', fix: 'Check WinRM permissions: winrm get winrm/config' };
    if (/the ssl connection could not be established/.test(err))
      return { reason: 'WinRM SSL error — HTTPS WinRM endpoint (port 5986) certificate issue', service: 'WinRM over HTTPS (5986)', fix: 'Use HTTP (5985) instead, or fix the SSL certificate on the WinRM HTTPS listener' };
  }

  // ---- ping errors ----
  if (tool === 'ping') {
    if (/destination host unreachable/.test(err))
      return { reason: 'Destination host unreachable — ARP resolution failed (host is offline or on a different subnet)', service: 'Network/ARP', fix: 'Verify the IP address is correct and the host is powered on and connected to the network' };
    if (/request timed out|timed out/.test(err))
      return { reason: 'Request timed out — host is online but not responding to ICMP (firewall blocking ping)', service: 'ICMP (ping)', fix: 'Enable "File and Printer Sharing (Echo Request - ICMPv4-In)" in Windows Firewall on the target PC' };
    if (/transmit failed/.test(err))
      return { reason: 'Ping transmit failed — local network interface issue', service: 'Local NIC', fix: 'Check the local network adapter is enabled and has a valid IP' };
    if (/could not find host/.test(err))
      return { reason: 'Could not find host — DNS resolution failed', service: 'DNS', fix: 'Verify the hostname is correct and DNS can resolve it. Try using the IP address instead.' };
  }

  // ---- Generic errors ----
  if (/access is denied/.test(err))
    return { reason: 'Access denied — insufficient permissions on the remote PC', service: 'Authentication', fix: 'Run the server as Administrator or provide admin credentials' };
  if (/the system cannot find the file specified|no such file/.test(err))
    return { reason: 'Executable not found — the tool is not installed or not in PATH', service: 'Tool installation', fix: 'Verify the tool is installed. For PsTools, check PSTOOLS_PATH in .env (default: C:\\PSTools\\)' };
  if (/timeout|timed out/.test(err))
    return { reason: 'Command timed out — the remote host took too long to respond', service: 'Network/WMI', fix: 'The host may be busy or the network is slow. Try again or increase the timeout.' };
  if (/command not found|is not recognized/.test(err))
    return { reason: 'Command not recognized — the executable is not in PATH', service: 'PATH', fix: 'Ensure the tool (wmic.exe, powershell.exe, etc.) is available on the target system' };
  if (code === -1 && !stderr)
    return { reason: 'Process failed to start — the executable could not be spawned', service: 'OS', fix: 'Verify the executable path is correct and the file exists' };

  // Unknown error — return raw stderr for debugging
  return {
    reason: stderr ? stderr.substring(0, 300) : `Process exited with code ${code}`,
    service: 'Unknown',
    fix: 'Check the error message above for clues',
  };
}

// ==========================================================================
// logCommand — append a command execution record to the log
// ==========================================================================
function logCommand(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    tool: entry.tool || 'unknown',
    target: entry.target || 'local',
    command: (entry.command || '').substring(0, 500),
    success: !!entry.success,
    duration: entry.duration || 0,
    error: entry.error || null,
    reason: entry.reason || null,
    service: entry.service || null,
    fix: entry.fix || null,
  };

  // Add to in-memory buffer
  _logBuffer.push(record);
  if (_logBuffer.length > MAX_BUFFER) _logBuffer.shift();

  // Append to log file (async, non-blocking)
  try {
    const line = JSON.stringify(record) + '\n';
    fs.appendFile(LOG_FILE, line, () => {});
  } catch {}

  // Also log to console for real-time debugging
  const status = record.success ? 'OK' : 'FAIL';
  const reason = record.reason ? ` — ${record.reason}` : '';
  console.log(`[${record.timestamp}] [${status}] ${record.tool} → ${record.target}${reason}`);

  return record;
}

// ==========================================================================
// getRecentLogs — return the last N log entries (for the API endpoint)
// ==========================================================================
function getRecentLogs(limit = 100) {
  return _logBuffer.slice(-limit).reverse();
}

module.exports = { logCommand, analyzeError, getRecentLogs, LOG_FILE };

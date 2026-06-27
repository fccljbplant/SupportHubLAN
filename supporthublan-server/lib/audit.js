/* ==========================================================================
   SupportHubLAN Unified Audit + Logger Module
   ==========================================================================
   Provides a single, queryable log of EVERY action taken on every host,
   PLUS command-level error analysis and log file writing.

   MERGED from lib/logger.js (v3.0.0) — now one module for both.
   The old lib/logger.js is kept as a thin re-export for backward compat.

   AUDIT FUNCTIONS:
   - add()          — create audit entry (persists to DB)
   - query()        — filter and paginate audit log
   - getByHost()    — all entries for a host
   - getRecentLogs()— last N entries (in‑memory)

   COMMAND LOGGING (merged from logger.js):
   - logCommand()   — log execution + write to commands.log file
   - analyzeError() — diagnose failures from stderr/exit code
   - getCommandLogsForHost() — filter command log file by hostname

   RETENTION POLICY:
   - Logs older than `logRetentionDays` (default: 7) are automatically deleted
   - Configurable via Settings → General → Log Retention
   - Cleanup runs on each add() call (lazy GC)
   ========================================================================== */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ==========================================================================
// COMMAND LOG FILE (from logger.js)
// ==========================================================================
const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'commands.log');
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// In-memory command log buffer
const _logBuffer = [];
const MAX_BUFFER = 500;

// ==========================================================================
// add — create a new audit log entry
// ==========================================================================
// Usage:
//   audit.add({
//     actionType: 'hardware.scan',
//     targetHost: 'PC-01',
//     tool: 'psinfo',
//     command: 'psinfo -d -h -s -c \\PC-01',
//     success: true,
//     durationMs: 5234,
//     outputSummary: 'Found 2 disks, 8GB RAM, Intel i7',
//     initiatedBy: 'admin',
//     initiatedFrom: '192.168.1.5',
//   });
// ==========================================================================
function add(db, entry) {
  try {
    // Get retention setting (default 7 days)
    const retentionDays = parseInt(db.settings.get('logRetentionDays', '7'), 10) || 7;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs).toISOString();

    const s = db._store || db.audit._store; // access internal store
    // Use the db.audit.add if available, otherwise push directly
    const auditEntry = {
      id: Date.now() + '-' + Math.floor(Math.random() * 100000),
      timestamp: new Date().toISOString(),
      action_type: entry.actionType || entry.action || 'unknown',
      category: entry.category || entry.actionType?.split('.')[0] || null,
      target_host: entry.targetHost || entry.hostname || null,
      target_ids: entry.targetIds ? JSON.stringify(entry.targetIds) : null,
      initiated_by: entry.initiatedBy || 'admin',
      initiated_from: entry.initiatedFrom || os.hostname(),
      tool: entry.tool || null,
      command: (entry.command || '').substring(0, 1000),
      success: entry.success !== false,
      duration_ms: entry.durationMs || entry.duration || 0,
      result: entry.success !== false ? 'success' : 'failed',
      error_reason: entry.errorReason || entry.reason || null,
      required_service: entry.requiredService || entry.service || null,
      fix_suggestion: entry.fixSuggestion || entry.fix || null,
      output_summary: (entry.outputSummary || entry.output || '').substring(0, 500),
      parameters: entry.parameters ? JSON.stringify(entry.parameters) : null,
      user: entry.initiatedBy || entry.user || 'admin',
    };

    // Add to the existing audit_log array in db
    if (db.audit && typeof db.audit.add === 'function') {
      // Use the existing db.audit.add but with our enhanced fields
      db.audit.add({
        action: auditEntry.action_type,
        category: auditEntry.category,
        targetType: 'Host',
        targetIds: entry.targetIds || (entry.targetHost ? [entry.targetHost] : []),
        parameters: {
          target_host: auditEntry.target_host,
          tool: auditEntry.tool,
          command: auditEntry.command,
          duration_ms: auditEntry.duration_ms,
          error_reason: auditEntry.error_reason,
          required_service: auditEntry.required_service,
          fix_suggestion: auditEntry.fix_suggestion,
          output_summary: auditEntry.output_summary,
          initiated_by: auditEntry.initiated_by,
          initiated_from: auditEntry.initiated_from,
        },
        result: auditEntry.result,
        output: auditEntry.output_summary,
        user: auditEntry.initiated_by,
      });
    }

    // Lazy GC: remove entries older than retention period
    _cleanupOldEntries(db, cutoff);

    return { success: true, id: auditEntry.id };
  } catch (e) {
    console.error('[audit] Failed to add entry:', e.message);
    return { success: false, error: e.message };
  }
}

// ==========================================================================
// query — retrieve logs with filters
// ==========================================================================
// Usage:
//   audit.query(db, { host: 'PC-01', actionType: 'hardware', limit: 100 })
//   audit.query(db, { startDate: '2026-06-01', endDate: '2026-06-21', limit: 500 })
//   audit.query(db, { user: 'admin', success: false, limit: 50 })
// ==========================================================================
function query(db, filters = {}) {
  try {
    const limit = Math.min(filters.limit || 200, 2000);
    const offset = filters.offset || 0;

    // Get all audit entries from the db
    let entries = [];
    if (db.audit && typeof db.audit.list === 'function') {
      // Get more than needed for filtering
      entries = db.audit.list(5000, 0);
    }

    // Apply filters
    let filtered = entries.filter(e => {
      // Host filter — check both target_host field (new) and parameters (old format)
      if (filters.host) {
        const host = (e.parameters && typeof e.parameters === 'string' ? JSON.parse(e.parameters) : e.parameters || {});
        const entryHost = host.target_host || host.hostname || '';
        if (!entryHost.toLowerCase().includes(filters.host.toLowerCase())) return false;
      }

      // Action type filter (prefix match: 'hardware' matches 'hardware.scan')
      if (filters.actionType) {
        if (!(e.action || '').toLowerCase().startsWith(filters.actionType.toLowerCase())) return false;
      }

      // User filter
      if (filters.user) {
        if ((e.user || '').toLowerCase() !== filters.user.toLowerCase()) return false;
      }

      // Success filter
      if (filters.success !== undefined) {
        if ((e.result === 'success') !== filters.success) return false;
      }

      // Date range filters
      if (filters.startDate) {
        if (new Date(e.timestamp) < new Date(filters.startDate)) return false;
      }
      if (filters.endDate) {
        if (new Date(e.timestamp) > new Date(filters.endDate)) return false;
      }

      // Search query (searches action, output, parameters)
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const haystack = [
          e.action || '',
          e.output || '',
          e.parameters || '',
          e.user || '',
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply offset and limit
    const result = filtered.slice(offset, offset + limit);

    return {
      success: true,
      data: result,
      total: filtered.length,
      limit,
      offset,
    };
  } catch (e) {
    return { success: false, error: e.message, data: [] };
  }
}

// ==========================================================================
// getByHost — get all logs for a specific host
// ==========================================================================
function getByHost(db, hostname, limit = 100) {
  return query(db, { host: hostname, limit });
}

// ==========================================================================
// cleanup — remove entries older than the retention period
// ==========================================================================
function cleanup(db) {
  const retentionDays = parseInt(db.settings.get('logRetentionDays', '7'), 10) || 7;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return _cleanupOldEntries(db, cutoff);
}

// Internal: remove old entries
function _cleanupOldEntries(db, cutoffDate) {
  try {
    // Access the internal store directly
    const store = db._store || (db.audit && db.audit._store);
    if (!store || !store.audit_log) return { removed: 0 };

    const before = store.audit_log.length;
    store.audit_log = store.audit_log.filter(e => new Date(e.timestamp) > new Date(cutoffDate));
    const removed = before - store.audit_log.length;
    if (removed > 0) {
      // Save if we have access to the save function
      if (db._save) db._save();
      else if (db.save) db.save();
    }
    return { removed };
  } catch (e) {
    return { removed: 0, error: e.message };
  }
}

// ==========================================================================
// getRetentionDays — get the current log retention setting
// ==========================================================================
function getRetentionDays(db) {
  return parseInt(db.settings.get('logRetentionDays', '7'), 10) || 7;
}

// ==========================================================================
// setRetentionDays — set the log retention setting
// ==========================================================================
function setRetentionDays(db, days) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 7));
  db.settings.set('logRetentionDays', String(d));
  return { success: true, days: d };
}

// ==========================================================================
// analyzeError — map known error patterns to actionable human-readable reasons
// ==========================================================================
// (Moved from lib/logger.js)
// Each tool has specific failure modes. This function inspects the stderr
// output and exit code, then returns a { reason, service, fix } object.
// ==========================================================================

function analyzeError(tool, stderr, exitCode) {
  const err = String(stderr || '').toLowerCase();
  const code = exitCode;

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

  return {
    reason: stderr ? stderr.substring(0, 300) : `Process exited with code ${code}`,
    service: 'Unknown',
    fix: 'Check the error message above for clues',
  };
}

// ==========================================================================
// logCommand — append a command execution record (merged from logger.js)
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

  _logBuffer.push(record);
  if (_logBuffer.length > MAX_BUFFER) _logBuffer.shift();

  try {
    const line = JSON.stringify(record) + '\n';
    fs.appendFile(LOG_FILE, line, () => {});
  } catch {}

  const status = record.success ? 'OK' : 'FAIL';
  const reason = record.reason ? ' — ' + record.reason : '';
  console.log('[' + record.timestamp + '] [' + status + '] ' + record.tool + ' \u2192 ' + record.target + reason);

  return record;
}

// ==========================================================================
// getRecentLogs — return the last N command log entries
// ==========================================================================
function getRecentLogs(limit = 100) {
  return _logBuffer.slice(-limit).reverse();
}

// ==========================================================================
// getCommandLogsForHost — filter command logs by target hostname
// ==========================================================================
function getCommandLogsForHost(hostname, limit = 100) {
  const host = (hostname || '').toLowerCase();
  if (!host) return [];
  const matches = _logBuffer.filter(e => (e.target || '').toLowerCase().includes(host));
  return matches.slice(-limit).reverse();
}

module.exports = { add, query, getByHost, cleanup, getRetentionDays, setRetentionDays, analyzeError, logCommand, getRecentLogs, getCommandLogsForHost, LOG_FILE };

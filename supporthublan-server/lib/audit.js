/* ==========================================================================
   SupportHubLAN Unified Audit Log Module
   ==========================================================================
   Provides a single, queryable log of EVERY action taken on every host:
   - Hardware scans
   - Script executions
   - Windows Update scans/installs/downloads
   - Service start/stop/restart
   - Power actions (reboot/shutdown/WoL)
   - Software deployments
   - Ping/status checks
   - IP range scans

   Each log entry captures:
   - timestamp       — when the action happened
   - action_type     — category (hardware.scan, script.run, update.install, etc.)
   - target_host     — which PC the action targeted
   - initiated_by    — which user triggered it (from audit context)
   - initiated_from  — source IP/hostname (where the request came from)
   - tool            — which tool was used (psexec, wmic, powershell, winrm, psinfo, ping)
   - command         — the actual command/script that ran
   - success         — bool
   - duration_ms     — how long it took
   - error_reason    — why it failed (if it did)
   - required_service— which Windows service was required (for failure context)
   - fix_suggestion  — how to fix the failure
   - output_summary  — brief result summary (first 500 chars)

   RETENTION POLICY:
   - Logs older than `logRetentionDays` (default: 7) are automatically deleted
   - Configurable via Settings → General → Log Retention
   - Cleanup runs on each add() call (lazy GC)
   ========================================================================== */

const os = require('os');

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

module.exports = { add, query, getByHost, cleanup, getRetentionDays, setRetentionDays };

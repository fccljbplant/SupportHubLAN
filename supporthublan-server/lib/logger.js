/* ==========================================================================
   SupportHubLAN Logger + Error Analyzer — thin re-export
   ==========================================================================
   All logic moved to lib/audit.js (v3.0.0 unified module).
   This file stays for backward compatibility.
   ========================================================================== */

const audit = require('./audit');

module.exports = {
  logCommand: audit.logCommand,
  analyzeError: audit.analyzeError,
  getRecentLogs: audit.getRecentLogs,
  LOG_FILE: audit.LOG_FILE,
};

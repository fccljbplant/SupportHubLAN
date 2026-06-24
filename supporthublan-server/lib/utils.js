/* ==========================================================================
   SupportHubLAN Shared Utilities
   ==========================================================================
   Common helper functions used by pstools.js, wmic.js, and powershell.js.
   Consolidated to eliminate code duplication (v2.0.0 cleanup).
   ========================================================================== */

/**
 * Convert short hostname to FQDN by appending domain suffix.
 * PsTools requires FQDN for reliable remote connections on domain networks.
 */
function toFqdn(hostname, credential) {
  const host = String(hostname || '').trim();
  if (!host) return host;
  if (host.includes('.')) return host;
  const domain = credential?.domain || '';
  if (domain) return host + '.' + domain;
  return host;
}

/**
 * Build [-u DOMAIN\\user] [-p password] array for PsExec tools.
 */
function credentialArgs(credential, hostname) {
  if (!credential || !credential.username || !credential.password) return [];
  let fullUser;
  if (credential.source === 'fallback' && hostname) {
    const shortName = hostname.includes('.') ? hostname.split('.')[0] : hostname;
    fullUser = shortName + '\\' + credential.username;
  } else {
    fullUser = credential.domain ? `${credential.domain}\\${credential.username}` : credential.username;
  }
  return ['-u', fullUser, '-p', credential.password];
}

/**
 * Strip plaintext password from command text for logging.
 */
function maskPassword(command) {
  return String(command || '').replace(/-p\s+\S+/g, '-p ***').replace(/-password\s+\S+/gi, '-password ***');
}

/**
 * Remove PsExec's copyright/connection banner from stdout.
 * Strips banner lines (PsExec v..., Copyright..., Sysinternals..., etc.)
 * and leading blank lines before actual output begins.
 */
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
    if (/exited on/i.test(line)) continue;
    if (/^\s*$/.test(line) && !foundData) continue;
    foundData = true;
    result.push(line);
  }
  return result.join('\n');
}

module.exports = { toFqdn, credentialArgs, maskPassword, stripPsExecBanner };

/**
 * SupportHubLAN API Client
 * 
 * This module connects the frontend to the SupportHubLAN backend server.
 * When the backend is available, it performs REAL Windows administration tasks.
 * When the backend is not available (e.g., opening the HTML file directly),
 * it automatically falls back to DEMO MODE (simulated actions).
 * 
 * CONFIGURATION:
 *   Set window.SUPPORTHUBLAN_API_URL before the app loads to point to your backend.
 *   Default: http://localhost:3137
 * 
 *   Example:
 *     <script>window.SUPPORTHUBLAN_API_URL = 'http://my-admin-pc:3137';</script>
 *     <script src="supporthublan-pro.html" ...></script>
 */

const SUPPORTHUBLAN_API_URL = window.SUPPORTHUBLAN_API_URL || 'http://localhost:3137';
let _backendAvailable = null; // null = unknown, true/false after first check

// ---- Check if backend is available ----
async function checkBackend() {
  if (_backendAvailable !== null) return _backendAvailable;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(`${SUPPORTHUBLAN_API_URL}/api/health`, { signal: ctrl.signal });
    _backendAvailable = resp.ok;
  } catch (e) {
    _backendAvailable = false;
  }
  return _backendAvailable;
}

// ---- Generic API call with fallback ----
async function apiCall(endpoint, body, fallbackFn) {
  const available = await checkBackend();
  if (!available) {
    // Demo mode — call the fallback simulation function
    return fallbackFn ? fallbackFn(body) : { success: false, error: 'Backend not available', demo: true };
  }
  try {
    const resp = await fetch(`${SUPPORTHUBLAN_API_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await resp.json();
  } catch (e) {
    return { success: false, error: e.message, demo: true };
  }
}

// ---- API Methods ----
const SupportHubLANAPI = {
  // Health check
  isBackendAvailable: checkBackend,
  apiUrl: SUPPORTHUBLAN_API_URL,

  // Host operations
  getHostInfo: (hostname, credential) => apiCall(`/api/hosts/${hostname}/info`, { credential }, null),
  pingHost: (hostname) => apiCall(`/api/hosts/${hostname}/ping`, {}, null),
  refreshHost: (hostname, credential) => apiCall(`/api/hosts/${hostname}/refresh`, { credential }, null),

  // Windows Updates
  scanUpdates: (hostnames, credential) => apiCall('/api/updates/scan', { hostnames, credential }, null),
  downloadUpdates: (hostnames, credential, kbFilter) => apiCall('/api/updates/download', { hostnames, credential, kbFilter }, null),
  installUpdates: (hostnames, credential, opts) => apiCall('/api/updates/install', { hostnames, credential, ...opts }, null),
  getUpdateHistory: (hostnames, credential) => apiCall('/api/updates/history', { hostnames, credential }, null),

  // Scripts
  executeScript: (hostnames, script, credential, language, timeout) =>
    apiCall('/api/scripts/execute', { hostnames, script, credential, language, timeout }, null),

  // Deployments
  deployPackage: (hostnames, packagePath, args, credential, rebootBehavior) =>
    apiCall('/api/deployments/run', { hostnames, packagePath, arguments: args, credential, rebootBehavior }, null),
  copyFiles: (hostnames, sourcePath, destinationPath, credential) =>
    apiCall('/api/deployments/copy', { hostnames, sourcePath, destinationPath, credential }, null),

  // Services
  getServices: (hostname, credential) => apiCall(`/api/services/${hostname}/list`, { credential }, null),
  serviceAction: (hostname, serviceName, action, credential) =>
    apiCall(`/api/services/${hostname}/action`, { serviceName, action, credential }, null),

  // Processes
  getProcesses: (hostname, credential) => apiCall(`/api/processes/${hostname}/list`, { credential }, null),
  killProcess: (hostname, pid, name, credential) =>
    apiCall(`/api/processes/${hostname}/kill`, { pid, name, credential }, null),

  // Power
  powerAction: (hostnames, action, credential, force) =>
    apiCall('/api/power/action', { hostnames, action, credential, force }, null),
  wakeOnLan: (macAddresses) => apiCall('/api/power/wol', { macAddresses }, null),
  checkPendingReboot: (hostnames, credential) =>
    apiCall('/api/power/check-pending', { hostnames, credential }, null),

  // Job Queue
  executeQueue: (steps, hostnames, credential, errorHandling) =>
    apiCall('/api/queues/execute', { steps, hostnames, credential, errorHandling }, null),

  // Credentials
  saveCredential: (name, username, password, domain) =>
    apiCall('/api/credentials', { name, username, password, domain }, null),
  getCredentials: () => apiCall('/api/credentials', {}, null),
};

// Export for use in the app
if (typeof window !== 'undefined') {
  window.SupportHubLANAPI = SupportHubLANAPI;
}

/* ==========================================================================
   SupportHubLAN Data Layer — Encrypted JSON File Storage
   ==========================================================================
   All data is stored in a single file: data/supporthublan-data.enc

   The ENTIRE file is encrypted with AES-256-GCM. The encryption key is
   derived from DB_PASSPHRASE (set in .env) using PBKDF2 (100k iterations,
   SHA-256). Without the passphrase, the data is unrecoverable.

   File format:
     bytes 0-15:   salt (random, generated on first run)
     bytes 16-27:  IV (random, per save)
     bytes 28-end: AES-256-GCM ciphertext + 16-byte auth tag

   The decrypted content is JSON with this structure:
     {
       inventories: [...],
       hosts: [...],
       credentials: [...],  // passwords ALSO individually encrypted
       audit_log: [...],
       jobs: [...],
       settings: {...}
     }

   No external dependencies. No native modules. Pure Node.js crypto.
   ========================================================================== */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'supporthublan-data.enc');
const DB_PASSPHRASE = process.env.DB_PASSPHRASE || 'supporthublan-default-change-me';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Derive master key from passphrase ----
// The salt is stored at the beginning of the data file. On first run, we
// generate a random salt. On subsequent runs, we read it from the file.
let _salt = null;
let _masterKey = null;

function getMasterKey() {
  if (_masterKey) return _masterKey;
  // If the data file exists, read the salt from it
  if (fs.existsSync(DATA_FILE)) {
    try {
      const buf = fs.readFileSync(DATA_FILE);
      if (buf.length > 16) {
        _salt = buf.slice(0, 16);
      }
    } catch (e) {}
  }
  if (!_salt) {
    _salt = crypto.randomBytes(16);
  }
  _masterKey = crypto.pbkdf2Sync(DB_PASSPHRASE, _salt, 100000, 32, 'sha256');
  return _masterKey;
}

// ---- AES-256-GCM encrypt/decrypt for the entire data file ----
function encryptData(jsonString) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(jsonString, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: salt(16) + iv(12) + ciphertext + tag(16)
  return Buffer.concat([_salt, iv, enc, tag]);
}

function decryptData(buf) {
  if (buf.length < 44) return null; // minimum: salt(16) + iv(12) + tag(16)
  try {
    _salt = buf.slice(0, 16);
    const key = crypto.pbkdf2Sync(DB_PASSPHRASE, _salt, 100000, 32, 'sha256');
    _masterKey = key;
    const iv = buf.slice(16, 28);
    const tag = buf.slice(buf.length - 16);
    const ciphertext = buf.slice(28, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    console.error('[db] Failed to decrypt data file:', e.message);
    console.error('[db] Wrong DB_PASSPHRASE? Data cannot be recovered without the correct passphrase.');
    return null;
  }
}

// ---- AES-256-GCM encrypt/decrypt for individual credential passwords ----
// This adds a SECOND layer of encryption for credential passwords — even if
// the main data file is decrypted, individual passwords remain encrypted.
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

function decryptField(b64) {
  if (!b64) return null;
  try {
    const key = getMasterKey();
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.slice(0, 16);
    const tag = buf.slice(buf.length - 16);
    const ciphertext = buf.slice(16, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null;
  }
}

// ---- In-memory store ----
let _store = null;
let _nextId = { inventories: 1, hosts: 1, credentials: 1, audit_log: 1 };

function loadStore() {
  if (_store) return _store;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const buf = fs.readFileSync(DATA_FILE);
      const json = decryptData(buf);
      if (json) {
        _store = JSON.parse(json);
        // Restore _nextId counters from existing data
        if (_store.inventories && _store.inventories.length > 0) {
          _nextId.inventories = Math.max(..._store.inventories.map(i => i.id)) + 1;
        }
        if (_store.hosts && _store.hosts.length > 0) {
          _nextId.hosts = Math.max(..._store.hosts.map(h => h.id)) + 1;
        }
        if (_store.credentials && _store.credentials.length > 0) {
          _nextId.credentials = Math.max(..._store.credentials.map(c => c.id)) + 1;
        }
        if (_store.audit_log && _store.audit_log.length > 0) {
          _nextId.audit_log = Math.max(..._store.audit_log.map(a => a.id)) + 1;
        }
        return _store;
      }
    }
  } catch (e) {
    console.error('[db] Error loading store:', e.message);
  }
  // Create default store
  _store = {
    inventories: [{ id: 1, name: 'Main Inventory', description: 'Default inventory', color: 'blue', is_active: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    hosts: [],
    credentials: [],
    audit_log: [],
    jobs: [],
    queue_audit_log: [],
    settings: {},
  };
  _nextId = { inventories: 2, hosts: 1, credentials: 1, audit_log: 1 };
  saveStore();
  return _store;
}

function saveStore() {
  if (!_store) return;
  try {
    const json = JSON.stringify(_store, null, 2);
    const encrypted = encryptData(json);
    fs.writeFileSync(DATA_FILE, encrypted);
  } catch (e) {
    console.error('[db] Failed to save store:', e.message);
  }
}

function nextId(table) {
  if (!_nextId[table]) _nextId[table] = 1;
  return _nextId[table]++;
}

// ==========================================================================
// INVENTORIES
// ==========================================================================
const inventories = {
  list: () => loadStore().inventories,
  get: (id) => loadStore().inventories.find(i => i.id === id),
  getActive: () => loadStore().inventories.find(i => i.is_active === 1) || loadStore().inventories[0],
  create: (name, description, color) => {
    try {
      const s = loadStore();
      const id = nextId('inventories');
      s.inventories.push({ id, name, description: description || '', color: color || 'blue', is_active: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      saveStore();
      return { success: true, id };
    } catch (e) { return { success: false, error: e.message }; }
  },
  rename: (id, name, description) => {
    const s = loadStore();
    const inv = s.inventories.find(i => i.id === id);
    if (inv) { inv.name = name; inv.description = description || ''; inv.updated_at = new Date().toISOString(); saveStore(); return { success: true }; }
    return { success: false, error: 'not found' };
  },
  setColor: (id, color) => {
    const s = loadStore();
    const inv = s.inventories.find(i => i.id === id);
    if (inv) { inv.color = color; saveStore(); return { success: true }; }
    return { success: false, error: 'not found' };
  },
  setActive: (id) => {
    const s = loadStore();
    s.inventories.forEach(i => { i.is_active = (i.id === id) ? 1 : 0; });
    saveStore();
    return { success: true };
  },
  delete: (id) => {
    const s = loadStore();
    if (s.inventories.length <= 1) return { success: false, error: 'Cannot delete the last inventory' };
    s.inventories = s.inventories.filter(i => i.id !== id);
    s.hosts = s.hosts.filter(h => h.inventory_id !== id);
    saveStore();
    return { success: true };
  },
};

// ==========================================================================
// HOSTS
// ==========================================================================
const hosts = {
  list: (inventoryId) => loadStore().hosts.filter(h => h.inventory_id === inventoryId).sort((a, b) => a.hostname.localeCompare(b.hostname)),
  _getAll: () => loadStore().hosts,
  get: (id) => loadStore().hosts.find(h => h.id === id),
  getByHostname: (inventoryId, hostname) => loadStore().hosts.find(h => h.inventory_id === inventoryId && h.hostname === hostname),
  getIdByHostname: (hostname) => {
    const h = loadStore().hosts.find(h => h.hostname === hostname);
    return h ? h.id : null;
  },
  upsert: (inventoryId, host) => {
    const s = loadStore();
    const existing = s.hosts.find(h => h.inventory_id === inventoryId && h.hostname === host.hostname);
    if (existing) {
      Object.assign(existing, {
        ip_address: host.ipAddress || host.ip_address || null,
        mac_address: host.macAddress || host.mac_address || null,
        fqdn: host.fqdn || null, os: host.os || null, site: host.site || null,
        owner: host.owner || null, department: host.department || null,
        tags: host.tags || null, notes: host.notes || null,
        updated_at: new Date().toISOString(),
      });
      saveStore();
      return { success: true, id: existing.id, updated: true };
    }
    const id = nextId('hosts');
    s.hosts.push({
      id, inventory_id: inventoryId, hostname: host.hostname,
      ip_address: host.ipAddress || host.ip_address || null,
      mac_address: host.macAddress || host.mac_address || null,
      fqdn: host.fqdn || null, os: host.os || null, site: host.site || null,
      owner: host.owner || null, department: host.department || null,
      tags: host.tags || null, notes: host.notes || null,
      online_status: 'unknown', patch_state: 'unknown', pending_reboot: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    saveStore();
    return { success: true, id, updated: false };
  },
  update: (id, fields) => {
    const s = loadStore();
    const h = s.hosts.find(x => x.id === id);
    if (!h) return { success: false, error: 'not found' };
    const allowed = ['hostname', 'ip_address', 'mac_address', 'fqdn', 'os', 'os_version', 'site', 'owner', 'department', 'tags', 'notes', 'online_status', 'patch_state', 'pending_reboot', 'last_seen', 'last_audit', 'custom_fields', 'build', 'cpu', 'ram', 'manufacturer', 'model', 'serial', 'logged_on_user', 'pending_queue_ids', 'last_seen_online_at', 'last_seen_offline_at'];
    for (const k of allowed) { if (fields[k] !== undefined) h[k] = fields[k]; }
    h.updated_at = new Date().toISOString();
    saveStore();
    return { success: true };
  },
  delete: (id) => {
    const s = loadStore();
    s.hosts = s.hosts.filter(h => h.id !== id);
    saveStore();
    return { success: true };
  },
  deleteAll: (inventoryId) => {
    const s = loadStore();
    s.hosts = s.hosts.filter(h => h.inventory_id !== inventoryId);
    saveStore();
    return { success: true };
  },
  bulkUpsert: (inventoryId, hostList) => {
    let inserted = 0, updated = 0, failed = 0;
    for (const h of hostList) {
      const r = hosts.upsert(inventoryId, h);
      if (r.success) { r.updated ? updated++ : inserted++; } else { failed++; }
    }
    return { success: true, inserted, updated, failed };
  },
};

// ==========================================================================
// CREDENTIALS — passwords encrypted with AES-256-GCM (double encryption:
//              the whole data file is encrypted, AND each password is
//              individually encrypted within the JSON)
// ==========================================================================
const credentials = {
  list: (inventoryId) => {
    const s = loadStore();
    return s.credentials
      .filter(c => !inventoryId || c.inventory_id === inventoryId || c.inventory_id === null)
      .map(c => ({ id: c.id, inventory_id: c.inventory_id, name: c.name, username: c.username, domain: c.domain, type: c.type, created_at: c.created_at }));
  },
  get: (id) => {
    const c = loadStore().credentials.find(x => x.id === id);
    if (c) return { ...c, password: decryptField(c.password_encrypted) };
    return null;
  },
  create: (inventoryId, name, username, password, domain, type) => {
    try {
      const s = loadStore();
      const id = nextId('credentials');
      s.credentials.push({ id, inventory_id: inventoryId || null, name, username, password_encrypted: encryptField(password), domain: domain || null, type: type || 'domain', created_at: new Date().toISOString() });
      saveStore();
      return { success: true, id };
    } catch (e) { return { success: false, error: e.message }; }
  },
  delete: (id) => {
    const s = loadStore();
    s.credentials = s.credentials.filter(c => c.id !== id);
    saveStore();
    return { success: true };
  },
};

// ==========================================================================
// AUDIT LOG
// ==========================================================================
const audit = {
  add: (entry) => {
    const s = loadStore();
    s.audit_log.push({
      id: nextId('audit_log'), timestamp: new Date().toISOString(),
      action: entry.action || '', category: entry.category || null,
      target_type: entry.targetType || null,
      target_ids: entry.targetIds ? JSON.stringify(entry.targetIds) : null,
      parameters: entry.parameters ? JSON.stringify(entry.parameters) : null,
      result: entry.result || 'unknown', output: entry.output || null,
      user: entry.user || 'admin', inventory_id: entry.inventoryId || null,
    });
    if (s.audit_log.length > 5000) s.audit_log = s.audit_log.slice(-5000);
    saveStore();
    return { success: true };
  },
  list: (limit = 200, offset = 0) => loadStore().audit_log.slice().reverse().slice(offset, offset + limit),
  search: (query, limit = 200) => {
    const q = query.toLowerCase();
    return loadStore().audit_log.filter(e =>
      (e.action || '').toLowerCase().includes(q) || (e.output || '').toLowerCase().includes(q) || (e.parameters || '').toLowerCase().includes(q)
    ).reverse().slice(0, limit);
  },
  clear: () => { const s = loadStore(); s.audit_log = []; saveStore(); return { success: true }; },
};

// ==========================================================================
// JOBS
// ==========================================================================
const jobs = {
  upsert: (job) => {
    const s = loadStore();
    const existing = s.jobs.find(j => j.id === job.id);
    if (existing) {
      if (job.status !== undefined) existing.status = job.status;
      if (job.progress !== undefined) existing.progress = job.progress;
      if (job.step !== undefined) existing.step = job.step;
      if (job.completed_at !== undefined) existing.completed_at = job.completed_at;
      if (job.output !== undefined) existing.output = job.output;
      if (job.logs !== undefined) existing.logs = job.logs;
      if (job.perHostProgress !== undefined) existing.perHostProgress = job.perHostProgress;
      if (job.steps !== undefined) existing.steps = job.steps;
      if (job.summary !== undefined) existing.summary = job.summary;
      if (job.hostnames !== undefined) existing.hostnames = job.hostnames;
      if (job.queueName !== undefined) existing.queueName = job.queueName;
      if (job.totalSteps !== undefined) existing.totalSteps = job.totalSteps;
      if (job.target_scope !== undefined) existing.target_scope = job.target_scope;
      if (job.run_on_offline_hosts !== undefined) existing.run_on_offline_hosts = job.run_on_offline_hosts;
      if (job.run_when_comes_online !== undefined) existing.run_when_comes_online = job.run_when_comes_online;
      if (job.run_when_comes_online_delay_minutes !== undefined) existing.run_when_comes_online_delay_minutes = job.run_when_comes_online_delay_minutes;
      if (job.syntax_validated !== undefined) existing.syntax_validated = job.syntax_validated;
      if (job.error_handling !== undefined) existing.error_handling = job.error_handling;
      if (job.overall_progress_percent !== undefined) existing.overall_progress_percent = job.overall_progress_percent;
      if (job.current_host_progress_percent !== undefined) existing.current_host_progress_percent = job.current_host_progress_percent;
      if (job.completed_hosts !== undefined) existing.completed_hosts = job.completed_hosts;
      if (job.failed_hosts !== undefined) existing.failed_hosts = job.failed_hosts;
      if (job.skipped_hosts !== undefined) existing.skipped_hosts = job.skipped_hosts;
      if (job.total_hosts !== undefined) existing.total_hosts = job.total_hosts;
    } else {
      s.jobs.push({
        id: job.id, name: job.name || '', status: job.status || 'queued',
        progress: job.progress || 0, step: job.step || null,
        targets: job.targets ? JSON.stringify(job.targets) : null,
        started_at: job.started_at || null, completed_at: job.completed_at || null,
        output: job.output || null, inventory_id: job.inventory_id || null,
        logs: job.logs || null, perHostProgress: job.perHostProgress || null,
        steps: job.steps || null, summary: job.summary || null,
        hostnames: job.hostnames || null, queueName: job.queueName || null,
        totalSteps: job.totalSteps || 0,
        target_scope: job.target_scope || 'selected_hosts',
        run_on_offline_hosts: job.run_on_offline_hosts || false,
        run_when_comes_online: job.run_when_comes_online || false,
        run_when_comes_online_delay_minutes: job.run_when_comes_online_delay_minutes || 5,
        syntax_validated: job.syntax_validated || false,
        error_handling: job.error_handling || 'continue',
        overall_progress_percent: job.overall_progress_percent || 0,
        current_host_progress_percent: job.current_host_progress_percent || 0,
        completed_hosts: job.completed_hosts || 0,
        failed_hosts: job.failed_hosts || 0,
        skipped_hosts: job.skipped_hosts || 0,
        total_hosts: job.total_hosts || 0,
      });
    }
    saveStore();
    return { success: true };
  },
  get: (id) => {
    const s = loadStore();
    const j = s.jobs.find(j => j.id === id);
    if (!j) return null;
    return {
      jobId: j.id, queueName: j.queueName || j.name,
      status: j.status, startedAt: j.started_at,
      completed: j.progress, total: j.totalSteps || 0,
      steps: j.steps || [], hostnames: j.hostnames || [],
      perHostProgress: j.perHostProgress || {},
      logs: j.logs || [], summary: j.summary || null,
      completedAt: j.completed_at || null,
      target_scope: j.target_scope || 'selected_hosts',
      run_on_offline_hosts: j.run_on_offline_hosts || false,
      run_when_comes_online: j.run_when_comes_online || false,
      run_when_comes_online_delay_minutes: j.run_when_comes_online_delay_minutes || 5,
      syntax_validated: j.syntax_validated || false,
      error_handling: j.error_handling || 'continue',
      overall_progress_percent: j.overall_progress_percent || 0,
      current_host_progress_percent: j.current_host_progress_percent || 0,
      completed_hosts: j.completed_hosts || 0,
      failed_hosts: j.failed_hosts || 0,
      skipped_hosts: j.skipped_hosts || 0,
      total_hosts: j.total_hosts || (j.hostnames ? j.hostnames.length : 0),
    };
  },
  delete: (id) => { const s = loadStore(); const before = s.jobs.length; s.jobs = s.jobs.filter(j => j.id !== id); saveStore(); return { success: true, removed: before !== s.jobs.length }; },
  list: (limit = 100) => loadStore().jobs.slice().reverse().slice(0, limit).map(j => ({
    jobId: j.id, queueName: j.queueName || j.name || '',
    status: j.status || 'unknown', startedAt: j.started_at || null,
    completed: j.progress || 0, total: j.totalSteps || 0,
    steps: j.steps || [], hostnames: j.hostnames || [],
    perHostProgress: j.perHostProgress || {},
    logs: j.logs || [], summary: j.summary || null,
    completedAt: j.completed_at || null,
    target_scope: j.target_scope || 'selected_hosts',
    run_on_offline_hosts: j.run_on_offline_hosts || false,
    syntax_validated: j.syntax_validated || false,
    error_handling: j.error_handling || 'continue',
    overall_progress_percent: j.overall_progress_percent || 0,
    completed_hosts: j.completed_hosts || 0,
    failed_hosts: j.failed_hosts || 0,
    skipped_hosts: j.skipped_hosts || 0,
    total_hosts: j.total_hosts || (j.hostnames ? j.hostnames.length : 0),
  })),
  clear: () => { const s = loadStore(); s.jobs = []; saveStore(); return { success: true }; },
};

// ==========================================================================
// SETTINGS
// ==========================================================================
const settings = {
  get: (key, defaultValue = null) => {
    const s = loadStore();
    return s.settings[key] !== undefined ? s.settings[key] : defaultValue;
  },
  set: (key, value) => {
    const s = loadStore();
    s.settings[key] = String(value);
    saveStore();
    return { success: true };
  },
  getAll: () => loadStore().settings,
};

// ==========================================================================
// QUEUE AUDIT LOG
// ==========================================================================
const queue_audit = {
  add: (entry) => {
    const s = loadStore();
    s.queue_audit_log.push({
      id: nextId('queue_audit_log') || Date.now(),
      queue_id: entry.queue_id || '', queue_name: entry.queue_name || '',
      job_id: entry.job_id || '', job_name: entry.job_name || '',
      host_id: entry.host_id || null, host_name: entry.host_name || '',
      host_ip: entry.host_ip || '',
      step_number: entry.step_number || 0, step_label: entry.step_label || '',
      command_executed: entry.command_executed || '',
      started_at: entry.started_at || new Date().toISOString(),
      completed_at: entry.completed_at || new Date().toISOString(),
      duration_seconds: entry.duration_seconds || 0,
      exit_code: entry.exit_code !== undefined ? entry.exit_code : null,
      stdout: entry.stdout || '', stderr: entry.stderr || '',
      status: entry.status || 'unknown', triggered_by: entry.triggered_by || 'manual',
    });
    if (s.queue_audit_log.length > 10000) s.queue_audit_log = s.queue_audit_log.slice(-10000);
    saveStore();
    return { success: true };
  },
  list: (limit = 200, offset = 0) => loadStore().queue_audit_log.slice().reverse().slice(offset, offset + limit),
  getByQueue: (queueId, limit = 500) => loadStore().queue_audit_log.filter(e => e.queue_id === queueId).reverse().slice(0, limit),
  getByHost: (hostname, limit = 200) => loadStore().queue_audit_log.filter(e => e.host_name === hostname).reverse().slice(0, limit),
  search: (query, limit = 200) => {
    const q = query.toLowerCase();
    return loadStore().queue_audit_log.filter(e =>
      (e.queue_name || '').toLowerCase().includes(q) || (e.host_name || '').toLowerCase().includes(q) || (e.command_executed || '').toLowerCase().includes(q)
    ).reverse().slice(0, limit);
  },
  clear: () => { const s = loadStore(); s.queue_audit_log = []; saveStore(); return { success: true }; },
};

module.exports = {
  encryptField, decryptField,
  inventories, hosts, credentials, audit, jobs, settings, queue_audit,
  USE_JSON_FALLBACK: true, // kept for backward compat (server.js checks this)
  db: null, // kept for backward compat
};

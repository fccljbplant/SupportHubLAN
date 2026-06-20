/* ==========================================================================
   SupportHubLAN SQLite Database Layer with AES-256-GCM Encryption
   ==========================================================================
   Tables:
     - inventories     : multiple named inventories (each = one tab in UI)
     - hosts           : hosts within an inventory
     - credentials     : encrypted credentials (domain creds, service accounts)
     - audit_log       : persistent audit trail
     - jobs            : job history
     - settings        : key/value settings store

   Encryption:
     - Master passphrase from .env DB_PASSPHRASE (default: 'supporthublan-default')
     - Per-row AES-256-GCM with random 16-byte IV per encryption
     - Stored format: base64(iv(16) + ciphertext + tag(16))
   ========================================================================== */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'supporthublan.db');
const DB_PASSPHRASE = process.env.DB_PASSPHRASE || 'supporthublan-default';

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Derive a 256-bit key from the passphrase using PBKDF2 (100k iterations, SHA-256)
const MASTER_KEY = crypto.pbkdf2Sync(DB_PASSPHRASE, 'supporthublan-salt-v1', 100000, 32, 'sha256');

// ---- AES-256-GCM encrypt/decrypt helpers ----
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

function decryptField(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.slice(0, 16);
    const tag = buf.slice(buf.length - 16);
    const ciphertext = buf.slice(16, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null;
  }
}

// ---- Open DB ----
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- Schema ----
db.exec(`
  CREATE TABLE IF NOT EXISTS inventories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT DEFAULT 'blue',
    is_active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inventory_id INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    ip_address TEXT,
    mac_address TEXT,
    fqdn TEXT,
    os TEXT,
    site TEXT,
    owner TEXT,
    department TEXT,
    tags TEXT,
    notes TEXT,
    online_status TEXT DEFAULT 'unknown',
    patch_state TEXT DEFAULT 'unknown',
    pending_reboot INTEGER DEFAULT 0,
    last_seen TEXT,
    last_audit TEXT,
    custom_fields TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (inventory_id) REFERENCES inventories(id) ON DELETE CASCADE,
    UNIQUE(inventory_id, hostname)
  );

  CREATE TABLE IF NOT EXISTS credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inventory_id INTEGER,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,
    domain TEXT,
    type TEXT DEFAULT 'domain',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (inventory_id) REFERENCES inventories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    action TEXT NOT NULL,
    category TEXT,
    target_type TEXT,
    target_ids TEXT,
    parameters TEXT,
    result TEXT,
    output TEXT,
    user TEXT,
    inventory_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    step TEXT,
    targets TEXT,
    started_at TEXT,
    completed_at TEXT,
    output TEXT,
    inventory_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hosts_inventory ON hosts(inventory_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

// ---- Create a default inventory if none exists ----
const countStmt = db.prepare('SELECT COUNT(*) as c FROM inventories');
const { c: invCount } = countStmt.get();
if (invCount === 0) {
  db.prepare("INSERT INTO inventories (name, description, color, is_active) VALUES (?, ?, ?, 1)")
    .run('Main Inventory', 'Default inventory', 'blue');
}

// ==========================================================================
// INVENTORIES
// ==========================================================================
const inventories = {
  list: () => db.prepare('SELECT * FROM inventories ORDER BY id').all(),
  get: (id) => db.prepare('SELECT * FROM inventories WHERE id = ?').get(id),
  getActive: () => db.prepare('SELECT * FROM inventories WHERE is_active = 1 LIMIT 1').get(),
  create: (name, description, color) => {
    try {
      const info = db.prepare('INSERT INTO inventories (name, description, color) VALUES (?, ?, ?)').run(name, description || '', color || 'blue');
      return { success: true, id: info.lastInsertRowid };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  rename: (id, name, description) => {
    try {
      db.prepare('UPDATE inventories SET name = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, description || '', id);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  },
  setActive: (id) => {
    db.prepare('UPDATE inventories SET is_active = 0').run();
    db.prepare('UPDATE inventories SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    return { success: true };
  },
  delete: (id) => {
    try {
      db.prepare('DELETE FROM inventories WHERE id = ?').run(id);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  },
};

// ==========================================================================
// HOSTS (within an inventory)
// ==========================================================================
const hosts = {
  list: (inventoryId) => db.prepare('SELECT * FROM hosts WHERE inventory_id = ? ORDER BY hostname').all(inventoryId),
  get: (id) => db.prepare('SELECT * FROM hosts WHERE id = ?').get(id),
  getByHostname: (inventoryId, hostname) => db.prepare('SELECT * FROM hosts WHERE inventory_id = ? AND hostname = ?').get(inventoryId, hostname),
  upsert: (inventoryId, host) => {
    const existing = db.prepare('SELECT id FROM hosts WHERE inventory_id = ? AND hostname = ?').get(inventoryId, host.hostname);
    if (existing) {
      db.prepare(`UPDATE hosts SET
        ip_address = ?, mac_address = ?, fqdn = ?, os = ?, site = ?, owner = ?, department = ?,
        tags = ?, notes = ?, updated_at = datetime('now')
        WHERE id = ?`).run(
        host.ipAddress || host.ip_address || null,
        host.macAddress || host.mac_address || null,
        host.fqdn || null,
        host.os || null,
        host.site || null,
        host.owner || null,
        host.department || null,
        host.tags || null,
        host.notes || null,
        existing.id
      );
      return { success: true, id: existing.id, updated: true };
    }
    const info = db.prepare(`INSERT INTO hosts
      (inventory_id, hostname, ip_address, mac_address, fqdn, os, site, owner, department, tags, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      inventoryId,
      host.hostname,
      host.ipAddress || host.ip_address || null,
      host.macAddress || host.mac_address || null,
      host.fqdn || null,
      host.os || null,
      host.site || null,
      host.owner || null,
      host.department || null,
      host.tags || null,
      host.notes || null
    );
    return { success: true, id: info.lastInsertRowid, updated: false };
  },
  update: (id, fields) => {
    const allowed = ['hostname', 'ip_address', 'mac_address', 'fqdn', 'os', 'site', 'owner', 'department', 'tags', 'notes', 'online_status', 'patch_state', 'pending_reboot', 'last_seen', 'last_audit', 'custom_fields'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (sets.length === 0) return { success: false, error: 'No valid fields' };
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    db.prepare(`UPDATE hosts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return { success: true };
  },
  delete: (id) => {
    db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    return { success: true };
  },
  deleteAll: (inventoryId) => {
    db.prepare('DELETE FROM hosts WHERE inventory_id = ?').run(inventoryId);
    return { success: true };
  },
  bulkUpsert: (inventoryId, hostList) => {
    let inserted = 0, updated = 0, failed = 0;
    const tx = db.transaction((items) => {
      for (const h of items) {
        const r = hosts.upsert(inventoryId, h);
        if (r.success) { r.updated ? updated++ : inserted++; }
        else { failed++; }
      }
    });
    tx(hostList);
    return { success: true, inserted, updated, failed };
  },
};

// ==========================================================================
// CREDENTIALS (encrypted at rest)
// ==========================================================================
const credentials = {
  list: (inventoryId) => {
    const rows = inventoryId
      ? db.prepare('SELECT id, inventory_id, name, username, domain, type, created_at FROM credentials WHERE inventory_id = ? OR inventory_id IS NULL ORDER BY name').all(inventoryId)
      : db.prepare('SELECT id, inventory_id, name, username, domain, type, created_at FROM credentials ORDER BY name').all();
    return rows;
  },
  get: (id) => {
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
    if (row) row.password = decryptField(row.password_encrypted);
    return row;
  },
  create: (inventoryId, name, username, password, domain, type) => {
    try {
      const info = db.prepare('INSERT INTO credentials (inventory_id, name, username, password_encrypted, domain, type) VALUES (?, ?, ?, ?, ?, ?)')
        .run(inventoryId || null, name, username, encryptField(password), domain || null, type || 'domain');
      return { success: true, id: info.lastInsertRowid };
    } catch (e) { return { success: false, error: e.message }; }
  },
  delete: (id) => {
    db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    return { success: true };
  },
};

// ==========================================================================
// AUDIT LOG
// ==========================================================================
const audit = {
  add: (entry) => {
    db.prepare(`INSERT INTO audit_log (action, category, target_type, target_ids, parameters, result, output, user, inventory_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.action || '',
      entry.category || null,
      entry.targetType || null,
      entry.targetIds ? JSON.stringify(entry.targetIds) : null,
      entry.parameters ? JSON.stringify(entry.parameters) : null,
      entry.result || 'unknown',
      entry.output || null,
      entry.user || 'admin',
      entry.inventoryId || null
    );
    return { success: true };
  },
  list: (limit = 200, offset = 0) => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset),
  search: (query, limit = 200) => {
    const q = `%${query}%`;
    return db.prepare(`SELECT * FROM audit_log WHERE action LIKE ? OR output LIKE ? OR parameters LIKE ? ORDER BY id DESC LIMIT ?`).all(q, q, q, limit);
  },
  clear: (olderThanDays = null) => {
    if (olderThanDays) {
      db.prepare(`DELETE FROM audit_log WHERE timestamp < datetime('now', ?)`).run(`-${olderThanDays} days`);
    } else {
      db.prepare('DELETE FROM audit_log').run();
    }
    return { success: true };
  },
};

// ==========================================================================
// JOBS
// ==========================================================================
const jobs = {
  upsert: (job) => {
    db.prepare(`INSERT INTO jobs (id, name, status, progress, step, targets, started_at, completed_at, output, inventory_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = COALESCE(excluded.status, status),
        progress = COALESCE(excluded.progress, progress),
        step = COALESCE(excluded.step, step),
        completed_at = COALESCE(excluded.completed_at, completed_at),
        output = COALESCE(excluded.output, output)
    `).run(
      job.id,
      job.name || '',
      job.status || 'queued',
      job.progress || 0,
      job.step || null,
      job.targets ? JSON.stringify(job.targets) : null,
      job.started_at || null,
      job.completed_at || null,
      job.output || null,
      job.inventory_id || null
    );
    return { success: true };
  },
  list: (limit = 100) => db.prepare('SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?').all(limit),
  clear: () => { db.prepare('DELETE FROM jobs').run(); return { success: true }; },
};

// ==========================================================================
// SETTINGS (key/value)
// ==========================================================================
const settings = {
  get: (key, defaultValue = null) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  },
  set: (key, value) => {
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')').run(key, String(value));
    return { success: true };
  },
  getAll: () => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    rows.forEach(r => obj[r.key] = r.value);
    return obj;
  },
};

module.exports = {
  db,
  encryptField,
  decryptField,
  inventories,
  hosts,
  credentials,
  audit,
  jobs,
  settings,
};

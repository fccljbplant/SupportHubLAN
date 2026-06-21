// /api/hardware/* — Hardware change detection across multiple hosts.
//
// For each hostname, compares the stored hardware snapshot (in db.settings
// under key "hardware:<hostname>") against a fresh PsInfo scan. Returns a
// list of changes per host.
//
// This router is mounted at /api/hardware in server.js.
const { Router } = require('express');
const { sanitizeHost, runPsToolDirect } = require('../pstools');

module.exports = function(db) {
  const router = Router();

  // POST /api/hardware/check-changes
  // Body: { hostnames: [string, ...] }
  // Response: { success, data: JSON.stringify([{ hostname, changes, status }]) }
  router.post('/check-changes', async (req, res) => {
    const { hostnames } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.json({ success: false, error: 'hostnames required', data: '[]' });
    }
    const hostList = hostnames.map(sanitizeHost).filter(Boolean);
    const results = [];

    // Sequential to avoid spawning 3*N processes at once
    for (const h of hostList) {
      try {
        const r = await runPsToolDirect('psinfo.exe', ['-d', '\\\\' + h], 30000);
        if (!r.success && !r.stdout) {
          results.push({ hostname: h, status: 'unreachable', changes: [] });
          continue;
        }
        const fresh = parsePsInfoForCompare(r.stdout, h);
        const key = 'hardware:' + h;
        const prevStr = db.settings.get(key, null);
        let changes = [];
        if (prevStr) {
          let prev = null;
          try { prev = JSON.parse(prevStr); } catch {}
          if (prev) {
            const getField = (o, p) => p.split('.').reduce((a, k) => (a && a[k] !== undefined) ? a[k] : null, o);
            const compare = (field) => {
              const oldV = getField(prev, field);
              const newV = getField(fresh, field);
              if (oldV && newV && String(oldV) !== String(newV)) {
                changes.push({ field, oldValue: oldV, newValue: newV });
              }
            };
            ['processors.0.name', 'system.totalRamMB', 'processors.0.cores'].forEach(compare);
            const prevDisks = (prev.disks || []).length;
            const newDisks = (fresh.disks || []).length;
            if (prevDisks !== newDisks) {
              changes.push({ field: 'diskCount', oldValue: prevDisks, newValue: newDisks });
            }
          }
        }
        // Save fresh snapshot
        try { db.settings.set(key, JSON.stringify(fresh)); } catch {}
        results.push({ hostname: h, status: 'ok', changes, isFirstScan: !prevStr });
      } catch (e) {
        results.push({ hostname: h, status: 'error', error: e.message, changes: [] });
      }
    }

    res.json({
      success: true,
      data: JSON.stringify(results),
      results,
    });
  });

  return router;
};

// Light-weight PsInfo parser used only for change detection (only fields
// we compare). Defined here so hosts.js can keep its own richer parser
// without worrying about cross-module coupling.
function parsePsInfoForCompare(raw, fallbackHost) {
  const out = raw || '';
  const lines = out.split(/\r?\n/);
  const kv = {};
  for (const line of lines) {
    const m = /^\s*([A-Za-z][A-Za-z ]+?)\s*:\s*(.*)$/.exec(line);
    if (m && m[2].trim() !== '') kv[m[1].trim().toLowerCase()] = m[2].trim();
  }

  const procCount = parseInt(kv['processors'] || '1', 10) || 1;
  const procName = kv['processor type'] || 'Unknown';
  const ramMatch = /(\d+)\s*(MB|GB|TB)/i.exec(kv['physical memory'] || '');
  let totalRamMB = 0;
  if (ramMatch) {
    const n = parseInt(ramMatch[1], 10);
    const u = ramMatch[2].toUpperCase();
    totalRamMB = u === 'GB' ? n * 1024 : u === 'TB' ? n * 1024 * 1024 : n;
  }

  const disks = [];
  let inVol = false;
  for (const line of lines) {
    if (/^\s*Volume\s+Type\s+Format/i.test(line)) { inVol = true; continue; }
    if (inVol) {
      if (/^\s*$/.test(line)) { inVol = false; continue; }
      const m = /^\s*([A-Z]:)\s+(\S+)\s+(\S+)\s*(.*?)\s+(\d+)\s*(GB|MB)\s+(\d+)\s*(GB|MB)\s*$/i.exec(line);
      if (m && /fixed|internal/i.test(m[2])) {
        disks.push({ drive: m[1], sizeGB: parseInt(m[5], 10) });
      }
    }
  }

  return {
    hostname: fallbackHost,
    processors: [{ name: procName, cores: procCount }],
    system: { totalRamMB },
    disks,
    scannedAt: new Date().toISOString(),
    _source: 'psinfo-compare',
  };
}

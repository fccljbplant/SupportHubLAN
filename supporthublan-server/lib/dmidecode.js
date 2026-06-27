/* ==========================================================================
   SupportHubLAN — DMI Parser + Remote Registry OS Info
   ==========================================================================
   Parses dmidecode output into structured JSON (system, board, BIOS, CPU,
   RAM, chassis, battery, cache, slots, ports).
   Queries remote Windows registry for OS details (name, version, build).

   Usage:
     const { parseDmidecode } = require('./lib/dmidecode');
     const { getOsFromRegistry } = require('./lib/dmidecode');

     const dmi = parseDmidecode(stdout);           // parse dmidecode output
     const os  = await getOsFromRegistry(hostname); // reg query remote
   ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');

// ==========================================================================
// parseDmidecode — parse dmidecode stdout into structured asset object
// ==========================================================================
function parseDmidecode(raw) {
  const blocks = [];
  let current = null;

  for (const line of (raw || '').split('\n')) {
    if (line.startsWith('Handle ')) {
      if (current) blocks.push(current);
      const m = line.match(/Handle (0x[0-9A-Fa-f]+), DMI type (\d+)/);
      current = { handle: m ? m[1] : '', dmi_type: m ? parseInt(m[2]) : -1, title: '', fields: {} };
    } else if (current) {
      const s = line;
      if (!s.trim()) continue;
      if (s.startsWith('\t') && !s.startsWith('\t\t')) {
        const trimmed = s.trim();
        if (trimmed.includes(':')) {
          const idx = trimmed.indexOf(':');
          current.fields[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim();
        } else if (!current.title) {
          current.title = trimmed;
        }
      }
    }
  }
  if (current) blocks.push(current);

  const asset = {
    bios: {}, system: {}, motherboard: {}, chassis: {}, processor: {},
    memory_slots: [], battery: {}, cache: [], ports: [], slots: [],
  };

  for (const b of blocks) {
    const f = b.fields;
    switch (b.dmi_type) {
      case 0: // BIOS
        asset.bios = { vendor: f['Vendor'] || '', version: f['Version'] || '', releaseDate: f['Release Date'] || '', revision: f['BIOS Revision'] || '', firmware: f['Firmware Revision'] || '' };
        break;
      case 1: // System
        asset.system = { manufacturer: f['Manufacturer'] || '', product: f['Product Name'] || '', version: f['Version'] || '', serial: f['Serial Number'] || '', uuid: f['UUID'] || '', sku: f['SKU Number'] || '', family: f['Family'] || '' };
        break;
      case 2: // Motherboard
        asset.motherboard = { manufacturer: f['Manufacturer'] || '', product: f['Product Name'] || '', version: f['Version'] || '', serial: f['Serial Number'] || '', type: f['Type'] || '' };
        break;
      case 3: // Chassis
        asset.chassis = { manufacturer: f['Manufacturer'] || '', type: f['Type'] || '', serial: f['Serial Number'] || '' };
        break;
      case 4: // Processor
        asset.processor = { socket: f['Socket Designation'] || '', manufacturer: f['Manufacturer'] || '', model: f['Version'] || '', maxSpeed: f['Max Speed'] || '', currentSpeed: f['Current Speed'] || '', cores: f['Core Count'] || '', threads: f['Thread Count'] || '', voltage: f['Voltage'] || '', status: f['Status'] || '', externalClock: f['External Clock'] || '', family: f['Family'] || '', id: f['ID'] || '' };
        break;
      case 7: // Cache
        asset.cache.push({ socket: f['Socket Designation'] || '', size: f['Installed Size'] || '', speed: f['Speed'] || '', type: f['System Type'] || '' });
        break;
      case 8: // Ports
        asset.ports.push({ internal: f['Internal Reference Designator'] || '', external: f['External Reference Designator'] || '', type: f['Port Type'] || '' });
        break;
      case 9: // Slots
        asset.slots.push({ designation: f['Designation'] || '', type: f['Type'] || '', usage: f['Current Usage'] || '', length: f['Length'] || '' });
        break;
      case 17: // Memory
        let sizeStr = f['Size'] || '';
        if (sizeStr.includes('MB')) { const n = parseInt(sizeStr) || 0; sizeStr = n >= 1024 ? (Math.round(n / 1024 * 10) / 10) + ' GB' : sizeStr; }
        asset.memory_slots.push({ locator: f['Locator'] || '', bank: f['Bank Locator'] || '', size: sizeStr, formFactor: f['Form Factor'] || '', type: f['Type Detail'] || '', speed: f['Speed'] || '', manufacturer: f['Manufacturer'] || '', serial: f['Serial Number'] || '', part: f['Part Number'] || '' });
        break;
      case 22: // Battery
        asset.battery = { manufacturer: f['Manufacturer'] || '', name: f['Name'] || '', capacity: f['Design Capacity'] || '', voltage: f['Design Voltage'] || '', serial: f['SBDS Serial Number'] || '', date: f['SBDS Manufacture Date'] || '', chemistry: f['SBDS Chemistry'] || '' };
        break;
    }
  }

  // Build formatted summary
  const lines = [];
  if (asset.system.product) lines.push(asset.system.product);
  if (asset.system.manufacturer) lines.push(asset.system.manufacturer);
  if (asset.processor.model) lines.push(asset.processor.model);
  if (asset.memory_slots.length) {
    const total = asset.memory_slots.reduce((s, m) => { const n = parseFloat(m.size) || 0; return s + (m.size.includes('GB') ? n : n / 1024); }, 0);
    lines.push(Math.round(total) + ' GB RAM');
  }
  asset.summary = lines.join(' — ') || 'Unknown system';
  return asset;
}

// ==========================================================================
// getOsFromRegistry — query remote Windows registry for OS details via reg.exe
// ==========================================================================
function getOsFromRegistry(hostname) {
  return new Promise((resolve) => {
    const os = {};
    const keys = [
      { field: 'name', key: 'ProductName' },
      { field: 'version', key: 'DisplayVersion' },
      { field: 'build', key: 'CurrentBuild' },
      { field: 'ubr', key: 'UBR' },
      { field: 'installDate', key: 'InstallDate' },
      { field: 'registeredOwner', key: 'RegisteredOwner' },
      { field: 'registeredOrg', key: 'RegisteredOrganization' },
    ];
    let pending = keys.length;
    let hasData = false;

    keys.forEach(({ field, key }) => {
      const proc = spawn('reg.exe', ['query', `\\\\${hostname}\\HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion`, '/v', key], { windowsHide: true, timeout: 8000 });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', () => {
        const match = out.match(/REG_\w+\s+(.+)/);
        if (match) { os[field] = match[1].trim(); hasData = true; }
        pending--;
        if (pending === 0) resolve(hasData ? os : null);
      });
      proc.on('error', () => { pending--; if (pending === 0) resolve(hasData ? os : null); });
      setTimeout(() => { try { proc.kill(); } catch {} }, 10000);
    });
  });
}

// ==========================================================================
// getDmiOsInfo — convenience: run dmidecode + reg query and return combined
// ==========================================================================
async function getDmiOsInfo(hostname, dmidecodePath) {
  const dmiPath = dmidecodePath || path.join(__dirname, '..', 'Tools', 'dmidecode.exe');
  let dmi = null, os = null;

  // dmidecode (local, <1s)
  try {
    const dmiProc = require('child_process').spawnSync(dmiPath, ['-t', 'system', '-t', 'baseboard', '-t', 'processor', '-t', 'memory', '-t', 'chassis'], { timeout: 10000, windowsHide: true });
    if (dmiProc.stdout) dmi = parseDmidecode(dmiProc.stdout.toString('utf8'));
  } catch (_) {}

  // Remote registry (3-5s)
  try { os = await getOsFromRegistry(hostname); } catch (_) {}

  return { dmi, os, hostname, scannedAt: new Date().toISOString() };
}

module.exports = { parseDmidecode, getOsFromRegistry, getDmiOsInfo };

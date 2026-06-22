/* ==========================================================================
   SupportHubLAN WMIC Module
   ==========================================================================
   Provides WMI data retrieval using wmic.exe — the command-line WMI query
   tool built into Windows.

   WMIC DOCUMENTATION (studied before implementation):
   ------------------------------------
   Reference: https://learn.microsoft.com/en-us/windows/win32/wmisdk/wmic

   Key wmic.exe command-line switches:
     /node:HOST          — query a remote computer (uses DCOM/RPC, NOT WinRM)
     /user:DOMAIN\user   — alternate credentials for remote query
     /password:pass      — password for alternate credentials
     /format:list        — output as Key=Value pairs (one per line)
     /format:csv         — output as CSV
     /format:htable       — output as HTML table

   Common WMI classes used for hardware audit:
     computersystem      — Manufacturer, Model, SerialNumber, TotalPhysicalMemory
     baseboard           — Motherboard: Manufacturer, Product, Version, SerialNumber
     bios                — BIOS: Manufacturer, SMBIOSBIOSVersion, ReleaseDate, SerialNumber
     cpu                 — Processor: Name, NumberOfCores, NumberOfLogicalProcessors
     memorychip          — RAM sticks: Capacity, Speed, Manufacturer, PartNumber
     diskdrive           — Physical disks: Model, Size, InterfaceType, SerialNumber
     logicaldisk         — Volumes: DeviceID, Size, FreeSpace, FileSystem
     path win32_videocontroller — GPU: Name, AdapterRAM, DriverVersion
     os                  — Operating System: Caption, Version, BuildNumber, InstallDate
     nicconfig           — Network: IPAddress, MACAddress, DHCPEnabled

   REMOTE QUERY METHODS:
     1. wmic /node:HOST ... (uses DCOM/RPC on port 135 + dynamic ports)
        - Requires: WMI service running on target, RPC endpoint mapper
        - Does NOT require WinRM or PsTools
     2. psexec \\HOST -s wmic ... (uses SMB on port 445 + PSEXESVC)
        - Requires: PsTools installed, Admin$ share accessible
        - Does NOT require WMI remote access or WinRM

   NOTE: wmic.exe is deprecated in Windows 10 21H1+ and Windows 11, but
   is still available in all current Windows versions. The PowerShell
   replacement is: Get-CimInstance -ClassName Win32_ComputerSystem
   ========================================================================== */

const { spawn } = require('child_process');
const { logCommand, analyzeError } = require('./logger');

// ==========================================================================
// runLocal — execute wmic.exe locally on the server machine
// ==========================================================================
// Usage: runLocal('computersystem', 'Manufacturer,Model,SerialNumber')
// Returns: { success, records: [{...}], raw, error, reason }
// ==========================================================================
function runLocal(wmiClass, fields, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const args = [wmiClass, 'get', fields, '/format:list'];
    const proc = spawn('wmic.exe', args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('wmic', err.message, -1);
      logCommand({ tool: 'wmic', target: 'local', command: `wmic ${wmiClass} get ${fields}`, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, records: [], raw: '', error: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        const records = parseListOutput(stdout);
        logCommand({ tool: 'wmic', target: 'local', command: `wmic ${wmiClass} get ${fields}`, success: true, duration });
        resolve({ success: true, records, raw: stdout, error: '', reason: null });
      } else {
        const reason = analyzeError('wmic', stderr, code);
        logCommand({ tool: 'wmic', target: 'local', command: `wmic ${wmiClass} get ${fields}`, success: false, error: stderr, ...reason, duration });
        resolve({ success: false, records: [], raw: stdout, error: stderr, ...reason });
      }
    });

    // Hard timeout
    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runRemote — execute wmic.exe against a remote host using /node:HOST
// ==========================================================================
// This uses DCOM/RPC (port 135 + dynamic ports) to query WMI remotely.
// Does NOT require PsTools, WinRM, or SMB.
// Requires: WMI service running on target, Windows Firewall WMI exception.
// ==========================================================================
function runRemote(hostname, wmiClass, fields, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const args = ['/node:' + safeHost, wmiClass, 'get', fields, '/format:list'];
    const proc = spawn('wmic.exe', args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('wmic', err.message, -1);
      logCommand({ tool: 'wmic', target: safeHost, command: `wmic /node:${safeHost} ${wmiClass} get ${fields}`, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, records: [], raw: '', error: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        const records = parseListOutput(stdout);
        logCommand({ tool: 'wmic', target: safeHost, command: `wmic /node:${safeHost} ${wmiClass} get ${fields}`, success: true, duration });
        resolve({ success: true, records, raw: stdout, error: '', reason: null });
      } else {
        const reason = analyzeError('wmic', stderr, code);
        logCommand({ tool: 'wmic', target: safeHost, command: `wmic /node:${safeHost} ${wmiClass} get ${fields}`, success: false, error: stderr, ...reason, duration });
        resolve({ success: false, records: [], raw: stdout, error: stderr, ...reason });
      }
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// runRemoteViaPsExec — execute wmic.exe on a remote host via PsExec
// ==========================================================================
// This uses PsExec (SMB on port 445 + PSEXESVC) to run wmic.exe AS IF
// it were running locally on the target machine.
// Requires: PsTools installed, Admin$ share accessible on target.
// Does NOT require WMI remote/DCOM access — wmic runs locally on the target.
//
// The resulting command: psexec -accepteula \\HOST -s wmic <class> get <fields> /format:list
// ==========================================================================
function runRemoteViaPsExec(hostname, wmiClass, fields, pstoolsPath, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const safeHost = String(hostname).replace(/[^a-zA-Z0-9._\-:]/g, '');
    const path = require('path');
    const exe = path.join(pstoolsPath, 'psexec.exe');
    const args = ['-accepteula', '\\\\' + safeHost, '-s', 'wmic.exe', wmiClass, 'get', fields, '/format:list'];
    const proc = spawn(exe, args, { windowsHide: true, timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const reason = analyzeError('psexec', err.message, -1);
      logCommand({ tool: 'psexec+wmic', target: safeHost, command: `psexec \\${safeHost} -s wmic ${wmiClass} get ${fields}`, success: false, error: err.message, ...reason, duration: Date.now() - startTime });
      resolve({ success: false, records: [], raw: '', error: err.message, ...reason });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      // Strip PsExec banner from stdout (first few lines before the actual data)
      const cleanStdout = stripPsExecBanner(stdout);
      if (code === 0 && cleanStdout.trim()) {
        const records = parseListOutput(cleanStdout);
        logCommand({ tool: 'psexec+wmic', target: safeHost, command: `psexec \\${safeHost} -s wmic ${wmiClass} get ${fields}`, success: true, duration });
        resolve({ success: true, records, raw: cleanStdout, error: '', reason: null });
      } else {
        const reason = analyzeError('psexec', stderr, code);
        logCommand({ tool: 'psexec+wmic', target: safeHost, command: `psexec \\${safeHost} -s wmic ${wmiClass} get ${fields}`, success: false, error: stderr, ...reason, duration });
        resolve({ success: false, records: [], raw: cleanStdout, error: stderr, ...reason });
      }
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs + 2000);
  });
}

// ==========================================================================
// parseListOutput — parse wmic /format:list output into JS objects
// ==========================================================================
// wmic /format:list output looks like:
//   Manufacturer=Dell Inc.
//   Model=OptiPlex 7070
//   SerialNumber=ABC123
//
// Multiple records are separated by blank lines.
// ==========================================================================
function parseListOutput(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const records = [];
  let current = {};

  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (Object.keys(current).length > 0) {
        records.push(current);
        current = {};
      }
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (value !== '') current[key] = value;
    }
  }
  if (Object.keys(current).length > 0) records.push(current);
  return records;
}

// ==========================================================================
// stripPsExecBanner — remove PsExec's copyright/connection banner from stdout
// ==========================================================================
// PsExec outputs a banner like:
//   PsExec v2.43 - Execute processes remotely
//   Copyright (C) 2001-2023 Mark Russinovich
//   Sysinternals - www.sysinternals.com
//
//   Connecting to HOST...
//   Starting PSEXESVC service on HOST...
//
// We strip everything before the first line that looks like wmic output
// (a line containing '=').
// ==========================================================================
function stripPsExecBanner(raw) {
  const out = (raw || '').replace(/\r/g, '');
  const lines = out.split('\n');
  let foundData = false;
  const result = [];

  for (const line of lines) {
    // Skip banner lines
    if (/^PsExec v/i.test(line)) continue;
    if (/^Copyright/i.test(line)) continue;
    if (/^Sysinternals/i.test(line)) continue;
    if (/^Connecting to/i.test(line)) continue;
    if (/^Starting PSEXESVC/i.test(line)) continue;
    if (/^Process exited/i.test(line)) continue;
    if (/^\s*$/.test(line) && !foundData) continue;

    // Once we find a line with '=' or any real data, keep everything
    if (line.includes('=') || foundData) {
      foundData = true;
      result.push(line);
    }
  }
  return result.join('\n');
}

module.exports = { runLocal, runRemote, runRemoteViaPsExec, parseListOutput };

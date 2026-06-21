const { Router } = require('express');
const { sanitizeHost, runPsToolDirect, extractJsonFromOutput } = require('../pstools');

module.exports = function(db) {
  const router = Router();

  // ===========================================================================
  // Common helper: run a remote PowerShell command via PsExec, return parsed
  // JSON or null. Wraps the remote output in <<<JSON>>>...<<<END>>> markers
  // so we can reliably strip the PsExec banner.
  // ===========================================================================
  async function runRemotePowerShellJson(hostname, remotePsScript, timeoutMs = 120000) {
    const safeHost = sanitizeHost(hostname);
    const wrapped =
      `$ErrorActionPreference='Stop';` +
      `try { ` + remotePsScript + ` } ` +
      `catch { Write-Output ('<<<JSON>>>' + (@{ error=$_.Exception.Message } | ConvertTo-Json -Compress) + '<<<END>>>') }`;

    const encodedCmd = Buffer.from(wrapped, 'utf16le').toString('base64');
    const r = await runPsToolDirect('psexec.exe',
      ['\\\\' + safeHost, '-s', '-h', 'powershell.exe',
       '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCmd],
      timeoutMs);

    if (!r.success && !r.stdout) {
      return { ok: false, error: r.stderr || 'PsExec failed (host may be offline)', raw: '' };
    }
    const parsed = extractJsonFromOutput(r.stdout);
    if (parsed === null) {
      return {
        ok: false,
        error: 'Could not parse remote PowerShell output (PSWindowsUpdate module may not be installed on the target host)',
        raw: (r.stdout || '').substring(0, 800),
      };
    }
    return { ok: true, data: parsed, raw: r.stdout };
  }

  // ===========================================================================
  // SCAN — scan one or more hosts for available Windows Updates.
  // Requires PSWindowsUpdate module on each target host.
  // ===========================================================================
  router.post('/scan', async (req, res) => {
    const { hostnames } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.json({ success: false, error: 'hostnames required' });
    }
    const hostList = hostnames.map(sanitizeHost).filter(Boolean);
    const results = [];

    // Run sequentially to avoid hammering WU servers; could be parallelized later.
    for (const h of hostList) {
      const remotePs =
        `Import-Module PSWindowsUpdate -ErrorAction Stop; ` +
        `$u = Get-WindowsUpdate -ComputerName $env:COMPUTERNAME -ErrorAction Stop; ` +
        `if (-not $u) { Write-Output '<<<JSON>>>[]<<<END>>>' } ` +
        `else { $j = $u | Select-Object KB, Title, Size, MsrcSeverity, Category | ConvertTo-Json -Depth 3 -Compress; ` +
        `if ($j -is [string]) { Write-Output ('<<<JSON>>>' + $j + '<<<END>>>') } ` +
        `else { Write-Output ('<<<JSON>>>[' + $j + ']<<<END>>>') } }`;
      const r = await runRemotePowerShellJson(h, remotePs, 180000);
      if (r.ok) {
        const updates = Array.isArray(r.data) ? r.data : [r.data];
        results.push({
          hostname: h,
          status: 'scanned',
          updates,
          count: updates.length,
        });
      } else {
        results.push({
          hostname: h,
          status: 'failed',
          error: r.error,
          raw: r.raw,
          updates: [],
          count: 0,
        });
      }
    }

    res.json({
      success: true,
      data: JSON.stringify(results),
      results,
    });
  });

  // ===========================================================================
  // DOWNLOAD — download (but do not install) all available updates.
  // ===========================================================================
  router.post('/download', async (req, res) => {
    const { hostnames } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.json({ success: false, error: 'hostnames required' });
    }
    const hostList = hostnames.map(sanitizeHost).filter(Boolean);
    const results = [];

    for (const h of hostList) {
      const remotePs =
        `Import-Module PSWindowsUpdate -ErrorAction Stop; ` +
        `Get-WindowsUpdate -ComputerName $env:COMPUTERNAME -Download -AcceptAll -ErrorAction Stop | Out-Null; ` +
        `Write-Output ('<<<JSON>>>' + (@{ status='downloaded'; host=$env:COMPUTERNAME } | ConvertTo-Json -Compress) + '<<<END>>>')`;
      const r = await runRemotePowerShellJson(h, remotePs, 600000);
      results.push({
        hostname: h,
        status: r.ok ? 'downloaded' : 'failed',
        error: r.ok ? null : r.error,
        raw: r.raw,
      });
    }

    res.json({
      success: true,
      data: JSON.stringify(results),
      results,
    });
  });

  // ===========================================================================
  // INSTALL — install all available updates on the target hosts.
  // rebootBehavior: 'never' | 'if-required' | 'always'
  // ===========================================================================
  router.post('/install', async (req, res) => {
    const { hostnames, rebootBehavior = 'if-required' } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.json({ success: false, error: 'hostnames required' });
    }
    const hostList = hostnames.map(sanitizeHost).filter(Boolean);
    const autoReboot = (rebootBehavior === 'always' || rebootBehavior === 'if-required') ? '-AutoReboot' : '';
    const results = [];

    for (const h of hostList) {
      const remotePs =
        `Import-Module PSWindowsUpdate -ErrorAction Stop; ` +
        `$r = Install-WindowsUpdate -ComputerName $env:COMPUTERNAME -AcceptAll ${autoReboot} -ErrorAction Stop | ` +
        `Select-Object KB, Title, Size, MsrcSeverity, Result, RebootRequired | ConvertTo-Json -Depth 3 -Compress; ` +
        `if (-not $r) { Write-Output '<<<JSON>>>[]<<<END>>>' } ` +
        `else { if ($r -is [string]) { Write-Output ('<<<JSON>>>' + $r + '<<<END>>>') } else { Write-Output ('<<<JSON>>>[' + $r + ']<<<END>>>') } }`;
      const r = await runRemotePowerShellJson(h, remotePs, 900000);
      if (r.ok) {
        const installed = Array.isArray(r.data) ? r.data : [r.data];
        results.push({
          hostname: h,
          status: 'installed',
          installed,
          count: installed.length,
        });
      } else {
        results.push({
          hostname: h,
          status: 'failed',
          error: r.error,
          raw: r.raw,
        });
      }
    }

    res.json({
      success: true,
      data: JSON.stringify(results),
      results,
    });
  });

  // ===========================================================================
  // HISTORY — recent update installation history.
  // ===========================================================================
  router.post('/history', async (req, res) => {
    const { hostnames } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.json({ success: false, error: 'hostnames required' });
    }
    const hostList = hostnames.map(sanitizeHost).filter(Boolean);
    const results = [];

    for (const h of hostList) {
      const remotePs =
        `Import-Module PSWindowsUpdate -ErrorAction Stop; ` +
        `$h = Get-WUHistory -ComputerName $env:COMPUTERNAME -ErrorAction Stop | ` +
        `Select-Object KB, Title, Date, Result | ConvertTo-Json -Depth 3 -Compress; ` +
        `if (-not $h) { Write-Output '<<<JSON>>>[]<<<END>>>' } ` +
        `else { if ($h -is [string]) { Write-Output ('<<<JSON>>>' + $h + '<<<END>>>') } else { Write-Output ('<<<JSON>>>[' + $h + ']<<<END>>>') } }`;
      const r = await runRemotePowerShellJson(h, remotePs, 60000);
      if (r.ok) {
        const history = Array.isArray(r.data) ? r.data : [r.data];
        results.push({ hostname: h, status: 'ok', history });
      } else {
        results.push({ hostname: h, status: 'failed', error: r.error, raw: r.raw, history: [] });
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

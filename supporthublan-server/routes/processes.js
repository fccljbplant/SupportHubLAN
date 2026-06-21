const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/:hostname/list', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const script = `try { $raw = & "${pstoolsExe('pslist.exe')}" \\\\${safeHost} -accepteula 2>&1 | Out-String; $procs = @(); $lines = $raw -split "\\r?\\n"; $inData = $false; foreach ($line in $lines) { if ($line -match '^Name\\s+Pid\\s+') { $inData = $true; continue }; if ($inData -and $line -match '^(\\S+)\\s+(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\d+)\\s+([\\d:]+)\\s+') { $procs += @{ ProcessId = [int]$matches[2]; Name = $matches[1]; MemMB = if ($matches[3]) { [math]::Round([int]$matches[3] / 1024, 1) } else { 0 } } } }; $procs | ConvertTo-Json -Compress } catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }`;
    const result = await runPowerShell(script, 30000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/:hostname/kill', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const safePid = parseInt(req.body.pid, 10);
    if (!safePid) return res.json({ success: false, error: 'Invalid PID' });
    const cmd = `& "${pstoolsExe('pskill.exe')}" \\\\${safeHost} ${safePid} -accepteula 2>&1 | Out-String`;
    const result = await runPowerShell(cmd, 15000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

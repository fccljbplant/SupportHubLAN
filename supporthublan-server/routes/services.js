const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/:hostname/list', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const script = `try { $raw = & "${pstoolsExe('psservice.exe')}" \\\\${safeHost} query -accepteula 2>&1 | Out-String; $services = @(); $current = @{}; foreach ($line in ($raw -split "\\r?\\n")) { if ($line -match '^SERVICE_NAME:\\s+(.+)$') { if ($current.Name) { $services += $current }; $current = @{ Name = $matches[1] } } elseif ($line -match '^DISPLAY_NAME:\\s+(.+)$') { $current.DisplayName = $matches[1] } elseif ($line -match '^\\s+STATE\\s+:\\s+\\d+\\s+(.+)$') { $current.State = $matches[1].Trim() } }; if ($current.Name) { $services += $current }; $services | ConvertTo-Json -Compress } catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }`;
    const result = await runPowerShell(script, 30000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/:hostname/action', async (req, res) => {
    const safeHost = sanitizeHost(req.params.hostname);
    const { serviceName, action } = req.body;
    const cmd = `& "${pstoolsExe('psservice.exe')}" \\\\${safeHost} ${action} "${sanitizeHost(serviceName)}" -accepteula 2>&1 | Out-String`;
    const result = await runPowerShell(cmd, 30000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

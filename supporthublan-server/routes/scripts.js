const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/execute', async (req, res) => {
    const { hostnames, script: userScript, timeout } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const timeoutSec = timeout || 60;
    const psScript = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("${userScript.replace(/"/g, '`"').replace(/'/g, "''")}")); $output = & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -EncodedCommand $encoded 2>&1 | Out-String; $results += @{ hostname = $h; success = $true; output = ($output | Out-String) } } catch { $results += @{ hostname = $h; success = $false; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 4 -Compress`;
    const result = await runPowerShell(psScript, timeoutSec * 1000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

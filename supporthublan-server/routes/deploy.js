const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/package', async (req, res) => {
    const { hostnames, packagePath, arguments: args, rebootBehavior } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const safePath = String(packagePath || '').replace(/"/g, '`"').replace(/'/g, "''");
    const safeArgs = String(args || '').replace(/"/g, '`"').replace(/'/g, "''");
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $remotePath = "\\\\$h\\C$\\Temp\\$(Split-Path '${safePath}' -Leaf)"; Copy-Item '${safePath}' $remotePath -Force -ErrorAction Stop; $cmd = "& \\"C:\\Temp\\$(Split-Path '${safePath}' -Leaf)\\" ${safeArgs}"; $output = & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -Command $cmd -ErrorAction Stop; $results += @{ hostname = $h; success = $true; output = ($output | Out-String) }; ${rebootBehavior === 'always' ? `Restart-Computer -ComputerName $h -Force` : ''} } catch { $results += @{ hostname = $h; success = $false; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 4 -Compress`;
    const result = await runPowerShell(script, 300000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/copy', async (req, res) => {
    const { hostnames, sourcePath, destinationPath } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const safeSrc = String(sourcePath || '').replace(/"/g, '`"').replace(/'/g, "''");
    const safeDst = String(destinationPath || '').replace(/"/g, '`"').replace(/'/g, "''");
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $remotePath = "\\\\$h\\${safeDst.replace(/:/g, '$')}"; Copy-Item '${safeSrc}' $remotePath -Recurse -Force -ErrorAction Stop; $results += @{ hostname = $h; success = $true } } catch { $results += @{ hostname = $h; success = $false; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 3 -Compress`;
    const result = await runPowerShell(script, 120000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

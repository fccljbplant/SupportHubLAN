const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/scan', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; Get-WindowsUpdate -ComputerName $h -ErrorAction Stop | Select-Object KB, Title, Size, MsrcSeverity, Category | ConvertTo-Json -Compress")); $output = & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -EncodedCommand $encoded 2>&1 | Out-String; $results += @{ hostname = $h; status = 'scanned'; output = $output } } catch { $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 5 -Compress`;
    const result = await runPowerShell(script, 120000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/install', async (req, res) => {
    const { hostnames, rebootBehavior } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const rebootParam = rebootBehavior === 'always' || rebootBehavior === 'if-required' ? '-AutoReboot' : '';
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; Install-WindowsUpdate -ComputerName $h -AcceptAll ${rebootParam} -ErrorAction Stop | ConvertTo-Json -Compress")); $output = & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -EncodedCommand $encoded 2>&1 | Out-String; $results += @{ hostname = $h; status = 'installed'; output = $output } } catch { $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script, 600000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/download', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; Get-WindowsUpdate -ComputerName $h -Download -AcceptAll -ErrorAction Stop | Out-Null")); & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -EncodedCommand $encoded 2>&1 | Out-String; $results += @{ hostname = $h; status = 'downloaded' } } catch { $results += @{ hostname = $h; status = 'failed'; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script, 300000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/history', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Import-Module PSWindowsUpdate -ErrorAction SilentlyContinue; Get-WUHistory -ComputerName $h -ErrorAction Stop | Select-Object KB, Title, Date, Result | ConvertTo-Json")); $output = & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -EncodedCommand $encoded 2>&1 | Out-String; $results += @{ hostname = $h; updates = $output } } catch { $results += @{ hostname = $h; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 4 -Compress`;
    const result = await runPowerShell(script, 60000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

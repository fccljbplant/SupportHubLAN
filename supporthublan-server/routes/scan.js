const { Router } = require('express');
const { sanitizeHost, runPowerShell } = require('../pstools');
module.exports = function(db, broadcastUpdate) {
  const router = Router();
  router.post('/', async (req, res) => {
    const { ips } = req.body;
    if (!Array.isArray(ips) || ips.length === 0) return res.json({ success: false, error: 'ips array required' });
    const safeIps = ips.map(sanitizeHost).filter(Boolean).slice(0, 1024);
    const jobScanId = 'scan-' + Date.now();
    res.json({ success: true, data: { jobId: jobScanId, total: safeIps.length } });
    const ipsBlock = safeIps.map(ip => `'${ip}'`).join(',');
    const script = `$pool = [RunspaceFactory]::CreateRunspacePool(1, [Math]::Min(50, @(${ipsBlock}).Count)); $pool.Open(); $sb = { param($ip); $ping = Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue; return @{ ip = $ip; online = $ping } }; $jobs = @(${ipsBlock}) | ForEach-Object { $ps = [PowerShell]::Create().AddScript($sb).AddArgument($_); $ps.RunspacePool = $pool; @{ handle = $ps; async = $ps.BeginInvoke() } }; $results = @(); foreach ($j in $jobs) { $results += $j.handle.EndInvoke($j.async) }; $pool.Close(); $pool.Dispose(); $results | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script, 120000);
    let online = 0, offline = 0;
    try { const parsed = JSON.parse(result.stdout); const arr = Array.isArray(parsed) ? parsed : [parsed]; arr.forEach(r => { if (r.online) online++; else offline++; }); broadcastUpdate({ type: 'scan-complete', jobId: jobScanId, results: arr, summary: { total: safeIps.length, online, offline } }); }
    catch { broadcastUpdate({ type: 'scan-error', jobId: jobScanId, error: result.stderr }); }
  });
  return router;
};

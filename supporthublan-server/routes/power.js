const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/action', async (req, res) => {
    const { hostname, action, message } = req.body;
    const safeHost = sanitizeHost(hostname);
    const delay = req.body.timeout || 10;
    const msgParam = message ? `-m "${message.replace(/"/g, '`"')}"` : '';
    const actionFlag = action === 'shutdown' ? '-s' : '-r';
    const script = `try { & "${pstoolsExe('psshutdown.exe')}" \\\\${safeHost} ${actionFlag} -t ${delay} -c -accepteula ${msgParam} 2>&1 | Out-String | Write-Host; @{ hostname = '${safeHost}'; action = '${action}'; success = $true } | ConvertTo-Json -Compress } catch { @{ hostname = '${safeHost}'; action = '${action}'; success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }`;
    const result = await runPowerShell(script, 30000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/wol', (req, res) => {
    const { mac } = req.body;
    if (!mac || !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) return res.json({ success: false, error: 'Invalid MAC' });
    const macParts = mac.split(/[:-]/).map(h => parseInt(h, 16));
    const magic = Buffer.alloc(102);
    magic.fill(0xFF, 0, 6);
    for (let i = 6; i < 102; i += 6) for (let j = 0; j < 6; j++) magic[i + j] = macParts[j];
    const sock = require('dgram').createSocket('udp4');
    sock.bind(() => { sock.setBroadcast(true); sock.send(magic, 9, '255.255.255.255', (err) => { sock.close(); res.json({ success: !err, data: { mac, sent: !err } }); }); });
  });
  router.post('/check-pending', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `$results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $output = & "${pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -Command "if ((Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')) { 'PENDING' } else { 'NONE' }" 2>&1 | Out-String; $pending = $output -match 'PENDING'; $results += @{ hostname = $h; pendingReboot = $pending; status = if ($pending) { 'pending' } else { 'none' } } } catch { $results += @{ hostname = $h; pendingReboot = $false; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script, 60000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

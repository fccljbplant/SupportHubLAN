const { Router } = require('express');
const { sanitizeHost, runPowerShell } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  router.post('/retrieve', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `Import-Module ActiveDirectory -ErrorAction SilentlyContinue; $results = @(); foreach ($h in @('${hostList.join("','")}')) { try { $computer = Get-ADComputer -Identity $h -Properties ms-Mcs-AdmPwd, ms-Mcs-AdmPwdExpirationTime, DNSHostName -ErrorAction Stop; $results += @{ hostname = $h; password = $computer.'ms-Mcs-AdmPwd'; expirationTime = if ($computer.'ms-Mcs-AdmPwdExpirationTime') { [DateTime]::FromFileTimeUtc([long]$computer.'ms-Mcs-AdmPwdExpirationTime') } else { $null }; success = $true } } catch { $results += @{ hostname = $h; success = $false; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 4 -Compress`;
    const result = await runPowerShell(script, 30000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  router.post('/rotate', async (req, res) => {
    const { hostnames } = req.body;
    const hostList = hostnames.map(sanitizeHost);
    const script = `Import-Module ActiveDirectory -ErrorAction SilentlyContinue; $results = @(); foreach ($h in @('${hostList.join("','")}')) { try { try { & "${require('../pstools').pstoolsExe('psexec.exe')}" \\\\$h -accepteula -s -h powershell -NoProfile -Command "Reset-LapsPassword" -ErrorAction Stop } catch { Set-ADComputer -Identity $h -Replace @{'ms-Mcs-AdmPwdExpirationTime' = '0'} -ErrorAction Stop }; $results += @{ hostname = $h; rotated = $true; method = 'success' } } catch { $results += @{ hostname = $h; rotated = $false; error = $_.Exception.Message } } }; $results | ConvertTo-Json -Depth 4 -Compress`;
    const result = await runPowerShell(script, 60000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  return router;
};

const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db, broadcastUpdate) {
  const router = Router();
  router.post('/execute', async (req, res) => {
    const { steps, hostnames, errorHandling, queueName } = req.body;
    const jobId = 'job-' + Date.now();
    res.json({ success: true, data: { jobId, status: 'running', stepCount: steps.length, hostCount: hostnames.length, queueName: queueName || 'Queue' } });
    (async () => {
      const totalSteps = steps.length * hostnames.length;
      let completed = 0;
      broadcastUpdate({ type: 'queue-start', jobId, queueName: queueName || 'Queue', total: totalSteps, completed: 0 });
      for (let si = 0; si < steps.length; si++) {
        for (let hi = 0; hi < hostnames.length; hi++) {
          const hostname = sanitizeHost(hostnames[hi]);
          broadcastUpdate({ type: 'queue-progress', jobId, step: steps[si].type, stepIndex: si, totalSteps: steps.length, hostname, hostIndex: hi, totalHosts: hostnames.length, completed, total: totalSteps, status: 'running' });
          try {
            let script = '';
            const step = steps[si];
            if (step.type === 'reboot') script = `& "${pstoolsExe('psshutdown.exe')}" \\\\${hostname} -r -t 5 -c -accepteula 2>&1 | Out-String`;
            else if (step.type === 'shutdown') script = `& "${pstoolsExe('psshutdown.exe')}" \\\\${hostname} -s -t 5 -c -accepteula 2>&1 | Out-String`;
            else if (step.type === 'run-command' && step.config?.code) { const encoded = Buffer.from(step.config.code, 'utf16le').toString('base64'); script = `& "${pstoolsExe('psexec.exe')}" \\\\${hostname} -accepteula -s -h powershell -NoProfile -EncodedCommand ${encoded} 2>&1 | Out-String`; }
            else if (step.type === 'psexec-run' && step.config?.command) script = `& "${pstoolsExe('psexec.exe')}" \\\\${hostname} -accepteula ${step.config.command} 2>&1 | Out-String`;
            else if (step.type === 'start-service' && step.config?.serviceName) script = `& "${pstoolsExe('psservice.exe')}" \\\\${hostname} start "${sanitizeHost(step.config.serviceName)}" -accepteula 2>&1 | Out-String`;
            else if (step.type === 'stop-service' && step.config?.serviceName) script = `& "${pstoolsExe('psservice.exe')}" \\\\${hostname} stop "${sanitizeHost(step.config.serviceName)}" -accepteula 2>&1 | Out-String`;
            else if (step.type === 'restart-service' && step.config?.serviceName) script = `& "${pstoolsExe('psservice.exe')}" \\\\${hostname} stop "${sanitizeHost(step.config.serviceName)}" -accepteula 2>&1 | Out-String; Start-Sleep -Seconds 2; & "${pstoolsExe('psservice.exe')}" \\\\${hostname} start "${sanitizeHost(step.config.serviceName)}" -accepteula 2>&1 | Out-String`;
            else if (step.type === 'wait-minutes') await new Promise(r => setTimeout(r, (step.config?.minutes || 1) * 60000));
            if (script) { const r = await runPowerShell(script, 300000); broadcastUpdate({ type: 'queue-step-complete', jobId, step: step.type, stepIndex: si, hostname, completed: ++completed, total: totalSteps, success: r.success, output: r.stdout?.slice(0, 5000), status: r.success ? 'success' : 'failed' }); if (!r.success && errorHandling === 'stop') { broadcastUpdate({ type: 'queue-aborted', jobId, completed, total: totalSteps }); return; } }
            else { completed++; }
          } catch (e) { completed++; if (errorHandling === 'stop') { broadcastUpdate({ type: 'queue-aborted', jobId, completed, total: totalSteps }); return; } }
        }
      }
      broadcastUpdate({ type: 'queue-complete', jobId, completed, total: totalSteps, status: 'completed' });
    })();
  });
  return router;
};

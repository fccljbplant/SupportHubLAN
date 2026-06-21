const { Router } = require('express');
const { sanitizeHost, runPowerShell, pstoolsExe } = require('../pstools');
module.exports = function(db) {
  const router = Router();
  const toolMap = { psexec:'psexec.exe', psinfo:'psinfo.exe', pslist:'pslist.exe', pskill:'pskill.exe', psservice:'psservice.exe', psloggedon:'psloggedon.exe', psshutdown:'psshutdown.exe', psfile:'psfile.exe', psgetsid:'psgetsid.exe', pssuspend:'pssuspend.exe' };
  
  router.post('/execute', async (req, res) => {
    const { tool, hostname, args } = req.body;
    const exe = toolMap[tool] || 'psexec.exe';
    const safeHost = sanitizeHost(hostname);
    const cmd = `& "${pstoolsExe(exe)}" \\\\${safeHost} -accepteula ${args || ''} 2>&1 | Out-String`;
    const result = await runPowerShell(cmd, 60000);
    res.json({ success: result.success, data: result.stdout, error: result.stderr });
  });
  
  ['psinfo','pslist','pskill','psservice','psloggedon','psshutdown','psfile','psgetsid','pssuspend'].forEach(tool => {
    router.post('/' + tool, async (req, res) => {
      const { hostname } = req.body;
      const safeHost = sanitizeHost(hostname);
      let args = '';
      if (tool === 'pskill') args = `${sanitizeHost(req.body.target)}`;
      else if (tool === 'psservice') { const { action, serviceName } = req.body; args = `${action || 'query'} "${sanitizeHost(serviceName)}"`; }
      else if (tool === 'psshutdown') { const { action } = req.body; args = action === 'shutdown' ? '-s' : action === 'abort' ? '-a' : '-r'; args += ` -t ${req.body.timeout || 5} -c`; if (req.body.message) args += ` -m "${req.body.message.replace(/"/g, '`"')}"`; }
      else if (tool === 'pssuspend') { const { target, action } = req.body; args = `${action === 'resume' ? '-r' : ''} ${sanitizeHost(target)}`; }
      const cmd = `& "${pstoolsExe(toolMap[tool])}" \\\\${safeHost} ${args} -accepteula 2>&1 | Out-String`;
      const result = await runPowerShell(cmd, 30000);
      res.json({ success: result.success, data: result.stdout, error: result.stderr });
    });
  });
  
  return router;
};

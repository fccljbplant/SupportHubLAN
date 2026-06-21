const { Router } = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
module.exports = function(db) {
  const router = Router();
  router.post('/connect', async (req, res) => {
    const { hostname, ip, protocol, port } = req.body;
    const safeIp = (ip || hostname || '').replace(/[^a-zA-Z0-9._\-:]/g, '');
    try {
      let vncPath;
      if (protocol === 'VNC') {
        const candidates = ['C:\\Program Files\\RealVNC\\VNC Viewer\\vncviewer.exe','C:\\Program Files\\TightVNC\\tvnviewer.exe','C:\\Program Files\\TigerVNC\\vncviewer.exe','C:\\Program Files\\uvnc bvba\\UltraVNC\\vncviewer.exe','C:\\Program Files (x86)\\RealVNC\\VNC Viewer\\vncviewer.exe'];
        vncPath = candidates.find(p => fs.existsSync(p));
        if (!vncPath) return res.json({ success: false, error: 'No VNC viewer found.' });
        spawn(vncPath, [`${safeIp}::${port || 5900}`], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('mstsc.exe', [`/v:${safeIp}:${port || 3389}`], { detached: true, stdio: 'ignore' }).unref();
      }
      res.json({ success: true, data: { protocol, hostname: safeIp, port, viewerPath: vncPath || 'mstsc.exe' } });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });
  return router;
};

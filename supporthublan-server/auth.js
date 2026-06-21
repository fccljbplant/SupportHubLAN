/* Authentication — simple token-based single-user auth */
const crypto = require('crypto');
const SESSION_TOKENS = new Set();

function setupAuth(app, db, ADMIN_USER, ADMIN_PASS) {
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!ADMIN_USER || !ADMIN_PASS) {
      const token = 'no-auth-' + Date.now();
      SESSION_TOKENS.add(token);
      return res.json({ success: true, token, user: { username: 'admin', role: 'Admin' } });
    }
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const token = crypto.randomBytes(32).toString('hex');
      SESSION_TOKENS.add(token);
      db.audit.add({ action: 'auth.login', category: 'Security', result: 'success', parameters: { username } });
      return res.json({ success: true, token, user: { username, role: 'Admin' } });
    }
    db.audit.add({ action: 'auth.login', category: 'Security', result: 'failed', parameters: { username } });
    res.json({ success: false, error: 'Invalid username or password' });
  });

  app.post('/api/auth/check', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!ADMIN_USER || !ADMIN_PASS) {
      return res.json({ success: true, authenticated: true, user: { username: 'admin', role: 'Admin' } });
    }
    if (token && SESSION_TOKENS.has(token)) {
      return res.json({ success: true, authenticated: true, user: { username: ADMIN_USER, role: 'Admin' } });
    }
    res.json({ success: true, authenticated: false });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) SESSION_TOKENS.delete(token);
    res.json({ success: true });
  });
}

function requireAuth(ADMIN_USER, ADMIN_PASS) {
  return function(req, res, next) {
    if (!ADMIN_USER || !ADMIN_PASS) return next();
    if (req.path === '/api/health' || req.path === '/api/auth/login' || req.path === '/api/auth/check' ||
        req.path === '/' || req.path.startsWith('/vendor/') || req.path.endsWith('.html') || req.path === '/ws') {
      return next();
    }
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token && SESSION_TOKENS.has(token)) return next();
    res.status(401).json({ success: false, error: 'Not authenticated' });
  };
}

module.exports = { setupAuth, requireAuth };

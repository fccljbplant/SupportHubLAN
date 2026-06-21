const { Router } = require('express');
module.exports = function(db) {
  const router = Router();
  router.get('/', (req, res) => res.json({ success: true, data: db.settings.getAll() }));
  router.post('/', (req, res) => { if (!req.body.key) return res.json({ success: false, error: 'key required' }); db.settings.set(req.body.key, req.body.value); res.json({ success: true }); });
  return router;
};

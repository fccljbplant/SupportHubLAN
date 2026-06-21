const { Router } = require('express');
module.exports = function(db) {
  const router = Router();
  router.get('/', (req, res) => { const limit = Math.min(parseInt(req.query.limit || '200'), 1000); const offset = parseInt(req.query.offset || '0'); res.json({ success: true, data: db.audit.list(limit, offset) }); });
  router.get('/search', (req, res) => res.json({ success: true, data: db.audit.search(req.query.q || '') }));
  router.post('/clear', (req, res) => { db.audit.clear(req.body.olderThanDays || null); res.json({ success: true }); });
  router.post('/', (req, res) => { db.audit.add(req.body); res.json({ success: true }); });
  return router;
};

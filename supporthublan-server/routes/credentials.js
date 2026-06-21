const { Router } = require('express');
module.exports = function(db) {
  const router = Router();
  router.get('/', (req, res) => { const { inventoryId } = req.query; res.json({ success: true, data: db.credentials.list(inventoryId ? parseInt(inventoryId) : null) }); });
  router.post('/', (req, res) => { const { inventoryId, name, username, password, domain, type } = req.body; if (!name || !username || !password) return res.json({ success: false, error: 'name, username, password required' }); res.json(db.credentials.create(inventoryId || null, name, username, password, domain, type)); });
  router.get('/:id', (req, res) => { const cred = db.credentials.get(parseInt(req.params.id)); if (!cred) return res.json({ success: false, error: 'not found' }); res.json({ success: true, data: cred }); });
  router.delete('/:id', (req, res) => { db.credentials.delete(parseInt(req.params.id)); res.json({ success: true }); });
  return router;
};

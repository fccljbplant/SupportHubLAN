const { Router } = require('express');
module.exports = function(db) {
  const router = Router();
  router.get('/', (req, res) => res.json({ success: true, data: db.inventories.list() }));
  router.post('/', (req, res) => { const { name, description, color } = req.body; if (!name) return res.json({ success: false, error: 'name required' }); const r = db.inventories.create(name, description, color); if (r.success) db.audit.add({ action: 'inventory.create', category: 'Inventory', result: 'success', parameters: { name } }); res.json(r); });
  router.put('/:id', (req, res) => { const id = parseInt(req.params.id, 10); const { name, description, color } = req.body; const r = db.inventories.rename(id, name, description || ''); if (color) db.inventories.setColor(id, color); res.json(r); });
  router.post('/:id/activate', (req, res) => { db.inventories.setActive(parseInt(req.params.id, 10)); res.json({ success: true }); });
  router.delete('/:id', (req, res) => { if (db.inventories.list().length <= 1) return res.json({ success: false, error: 'Cannot delete last inventory' }); res.json(db.inventories.delete(parseInt(req.params.id, 10))); });
  router.get('/:id/hosts', (req, res) => res.json({ success: true, data: db.hosts.list(parseInt(req.params.id, 10)) }));
  router.post('/:id/hosts', (req, res) => { const r = db.hosts.upsert(parseInt(req.params.id, 10), req.body.host); res.json(r); });
  router.post('/:id/hosts/bulk', (req, res) => { const r = db.hosts.bulkUpsert(parseInt(req.params.id, 10), req.body.hosts); res.json(r); });
  router.delete('/:id/hosts', (req, res) => { db.hosts.deleteAll(parseInt(req.params.id, 10)); res.json({ success: true }); });
  return router;
};

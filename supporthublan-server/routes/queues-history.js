const { Router } = require('express');
module.exports = function(db) {
  const router = Router();
  router.get('/jobs', (req, res) => res.json({ success: true, data: db.jobs.list(100) }));
  return router;
};

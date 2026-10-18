// routes/configRoutes.js  (mounted at /api/config)
// Tenant configuration: custom fields and table column preferences.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');
const tenantDbMiddleware = require('../middleware/tenantDb');
const c = require('../controllers/configController');

const base = [authMiddleware, subscriptionGuard, tenantDbMiddleware];

router.get('/fields/:entity',  ...base, c.getFields);
router.post('/fields/:entity', ...base, c.saveFields);

router.get('/table-preferences/:tableKey',    ...base, c.getTablePreference);
router.post('/table-preferences/:tableKey',   ...base, c.saveTablePreference);
router.delete('/table-preferences/:tableKey', ...base, c.resetTablePreference);

module.exports = router;

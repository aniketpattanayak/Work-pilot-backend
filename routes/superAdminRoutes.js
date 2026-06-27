const express = require('express');
const router  = express.Router();
const { authMiddleware, superAdminOnly } = require('../middleware/auth');
const c = require('../controllers/superAdminController');

// All routes: authMiddleware decodes token → superAdminOnly checks isSuperAdmin flag
router.get ('/dashboard',                    authMiddleware, superAdminOnly, c.getDashboardStats);
router.get ('/tenants',                      authMiddleware, superAdminOnly, c.getAllTenants);
router.get ('/tenants/:tenantId',            authMiddleware, superAdminOnly, c.getTenantDetail);
router.get ('/feed',                         authMiddleware, superAdminOnly, c.getGlobalFeed);

// Tenant controls
router.post('/tenants/:tenantId/pause',      authMiddleware, superAdminOnly, c.pauseTenant);
router.post('/tenants/:tenantId/resume',     authMiddleware, superAdminOnly, c.resumeTenant);
router.put ('/tenants/:tenantId/limits',     authMiddleware, superAdminOnly, c.updateLimits);
router.put ('/tenants/:tenantId/features',   authMiddleware, superAdminOnly, c.updateFeatures);
router.put ('/tenants/:tenantId/billing',    authMiddleware, superAdminOnly, c.updateBilling);
router.put ('/tenants/:tenantId/note',       authMiddleware, superAdminOnly, c.updateNote);
router.post('/tenants/:tenantId/reset-password', authMiddleware, superAdminOnly, c.resetAdminPassword);

// Activity log per tenant
router.get ('/tenants/:tenantId/logs',       authMiddleware, superAdminOnly, c.getActivityLog);
router.post('/process-schedules',             authMiddleware, superAdminOnly, c.processScheduledPauses);

module.exports = router;
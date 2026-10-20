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

router.put('/tenants/:tenantId/custom-db', authMiddleware, superAdminOnly, c.setCustomDb);
router.put('/tenants/:tenantId/custom-whatsapp', authMiddleware, superAdminOnly, c.setCustomWhatsapp);

// Phase 4: AI assistant per-company kill switch + monthly usage limit.
router.put('/tenants/:tenantId/ai-assistant', authMiddleware, superAdminOnly, c.setAiAssistant);
// Voice AI module (beta) - Superadmin only
router.get('/tenants/:tenantId/voice',                       authMiddleware, superAdminOnly, c.getVoiceSettings);
router.put('/tenants/:tenantId/voice',                       authMiddleware, superAdminOnly, c.setVoiceModule);
router.get('/tenants/:tenantId/switch-access', authMiddleware, superAdminOnly, require('../controllers/settingsController').getSwitchAccess);
router.put('/tenants/:tenantId/switch-access', authMiddleware, superAdminOnly, require('../controllers/settingsController').setSwitchAccess);
router.put('/tenants/:tenantId/voice/users/:employeeId',     authMiddleware, superAdminOnly, c.setVoiceUser);

module.exports = router;
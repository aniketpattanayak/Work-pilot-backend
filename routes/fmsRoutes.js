// server/routes/fmsRoutes.js
// Old FMS — kept for backward compatibility.
// New FMS engine is at /api/fms2/ via newFmsRoutes.js

const express = require('express');
const router  = express.Router();
const fmsController = require('../controllers/fmsController');
const { authMiddleware, sameTenantOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');

// Template management
router.post  ('/create-template',        authMiddleware, subscriptionGuard, fmsController.createFmsTemplate);
router.get   ('/templates/:tenantId',    authMiddleware, subscriptionGuard, sameTenantOnly, fmsController.getTenantTemplates);
router.delete('/template/:templateId',   authMiddleware, subscriptionGuard, fmsController.deleteFmsTemplate);

// Live flow execution
router.post('/start-flow',               authMiddleware, subscriptionGuard, fmsController.initializeFlow);
router.put ('/execute-step/:instanceId', authMiddleware, subscriptionGuard, fmsController.executeStep);
router.get ('/instances/:tenantId',      authMiddleware, subscriptionGuard, sameTenantOnly, fmsController.getTenantInstances);

// Sheet sync
router.get('/sync/:templateId',          authMiddleware, subscriptionGuard, fmsController.syncFmsOrders);

// History — specific route MUST come before generic
// FIX (Phase 1 security pass): these two had no authMiddleware/subscriptionGuard at all -
// unlike every sibling route in this file - so anyone, logged in or not, from any
// company, could read another tenant's flow/instance history just by knowing or
// guessing an id. Tenant ownership is now also checked inside the controller, since
// FmsHistory rows don't carry their own tenantId.
router.get('/history/flow/:templateId',  authMiddleware, subscriptionGuard, fmsController.getFlowHistory);
router.get('/history/:instanceId',       authMiddleware, subscriptionGuard, fmsController.getInstanceHistory);

// Missions
router.get('/my-missions/:email',        authMiddleware, subscriptionGuard, fmsController.getMyMissions);

module.exports = router;
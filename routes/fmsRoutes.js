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
router.get('/history/flow/:templateId',  fmsController.getFlowHistory);
router.get('/history/:instanceId',       fmsController.getInstanceHistory);

// Missions
router.get('/my-missions/:email',        authMiddleware, subscriptionGuard, fmsController.getMyMissions);

module.exports = router;
const express = require('express');
const router  = express.Router();
const c       = require('../controllers/newFmsController');
const { authMiddleware, sameTenantOnly, superAdminOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');

// ─── TEMPLATE MANAGEMENT (admin only) ────────────────────────────────────────
router.post  ('/templates',                  authMiddleware, subscriptionGuard, c.createTemplate);
router.get   ('/templates/:tenantId',        authMiddleware, subscriptionGuard, sameTenantOnly, c.getTemplates);
router.get   ('/templates/detail/:templateId', authMiddleware, subscriptionGuard, c.getTemplateById);
router.put   ('/templates/:templateId',      authMiddleware, subscriptionGuard, c.updateTemplate);
router.delete('/templates/:templateId',      authMiddleware, subscriptionGuard, c.deleteTemplate);

// ─── SHEET INTEGRATION ───────────────────────────────────────────────────────
// Read sheet column headers so admin can map them in the builder
router.get('/sheet-columns/:templateId', authMiddleware, subscriptionGuard, c.getSheetColumns);

// Push sync — called by Apps Script (no auth, templateId is the shared secret)
router.post('/push-sync', c.pushSync);

// Manual sync — admin triggers a full sheet read
router.post('/manual-sync/:templateId', authMiddleware, subscriptionGuard, c.manualSync);

// ─── STEP COMPLETION (employee) ───────────────────────────────────────────────
router.post('/complete-step/:instanceId', authMiddleware, subscriptionGuard, c.completeStep);

// ─── MONITOR (admin) ─────────────────────────────────────────────────────────
router.get('/instances/:tenantId',        authMiddleware, subscriptionGuard, sameTenantOnly, c.getInstances);
router.get('/monitor-stats/:tenantId',    authMiddleware, subscriptionGuard, sameTenantOnly, c.getMonitorStats);
router.get('/instance/:instanceId',       authMiddleware, subscriptionGuard, c.getInstanceDetail);
router.delete('/instance/:instanceId',    authMiddleware, subscriptionGuard, c.cancelInstance);

// ─── EMPLOYEE TASK VIEW ───────────────────────────────────────────────────────
router.get('/completed-tasks/:employeeId', authMiddleware, subscriptionGuard, c.getCompletedTasksForCoordinator);
router.get('/my-tasks/:employeeId',            authMiddleware, subscriptionGuard, c.getMyTasks);
router.post('/repair-assignees/:tenantId',  authMiddleware, c.repairAssignees);
router.post('/fix-assignees/:tenantId',     authMiddleware, c.fixInstanceAssignee);
router.post('/instance/:instanceId/reassign', authMiddleware, c.reassignInstance);
router.get('/my-tasks-full/:employeeId',       authMiddleware, subscriptionGuard, c.getMyTasksWithNodes);

module.exports = router;

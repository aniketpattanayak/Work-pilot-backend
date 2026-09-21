const express = require('express');
const router  = express.Router();
const c       = require('../controllers/newFmsController');
const tenantDbMiddleware = require('../middleware/tenantDb');
const { authMiddleware, sameTenantOnly, tenantDbMiddleware, superAdminOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');

// ─── TEMPLATE MANAGEMENT (admin only) ────────────────────────────────────────
router.post  ('/templates',                  authMiddleware, subscriptionGuard, tenantDbMiddleware, c.createTemplate);
router.get   ('/templates/:tenantId',        authMiddleware, subscriptionGuard, tenantDbMiddleware, sameTenantOnly, c.getTemplates);
router.get   ('/templates/detail/:templateId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getTemplateById);
router.put   ('/templates/:templateId',      authMiddleware, subscriptionGuard, tenantDbMiddleware, c.updateTemplate);
router.delete('/templates/:templateId',      authMiddleware, subscriptionGuard, tenantDbMiddleware, c.deleteTemplate);

// ─── SHEET INTEGRATION ───────────────────────────────────────────────────────
// Read sheet column headers so admin can map them in the builder
router.get('/sheet-columns/:templateId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getSheetColumns);

// Push sync — called by Apps Script (no auth, templateId is the shared secret)
router.post('/push-sync', c.pushSync);

// Manual sync — admin triggers a full sheet read
router.post('/manual-sync/:templateId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.manualSync);

// ─── STEP COMPLETION (employee) ───────────────────────────────────────────────
router.post('/complete-step/:instanceId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.completeStep);

// ─── MONITOR (admin) ─────────────────────────────────────────────────────────
router.get('/instances/:tenantId',        authMiddleware, subscriptionGuard, tenantDbMiddleware, sameTenantOnly, c.getInstances);
router.get('/monitor-stats/:tenantId',    authMiddleware, subscriptionGuard, tenantDbMiddleware, sameTenantOnly, c.getMonitorStats);
router.get('/instance/:instanceId',       authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getInstanceDetail);
router.delete('/instance/:instanceId',    authMiddleware, subscriptionGuard, tenantDbMiddleware, c.cancelInstance);

// ─── EMPLOYEE TASK VIEW ───────────────────────────────────────────────────────
router.get('/completed-tasks/:employeeId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getCompletedTasksForCoordinator);
router.get('/coordinator-tasks/:coordinatorId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getFmsTasksForCoordinator);
router.get('/coordinator-completed/:coordinatorId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getCompletedFmsForCoordinator);
router.get('/my-tasks/:employeeId',            authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getMyTasks);
router.post('/repair-assignees/:tenantId',  authMiddleware, c.repairAssignees);
router.post('/fix-assignees/:tenantId',     authMiddleware, c.fixInstanceAssignee);
router.post('/instance/:instanceId/reassign', authMiddleware, c.reassignInstance);
router.get('/my-tasks-full/:employeeId',       authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getMyTasksWithNodes);

module.exports = router;
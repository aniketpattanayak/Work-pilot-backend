// server/routes/tenantRoutes.js
// FIX S-2: authMiddleware applied to all protected routes.
// FIX S-6: sameTenantOnly applied to tenant-scoped routes.

const express = require('express');
const router = express.Router();
const Tenant = require('../models/Tenant');
const _upload = require('../utils/s3Uploader');
const useUpload = (method) => Array.isArray(method) ? method : [method];
const taskController = require('../controllers/taskController');
const {
  createTenant,
  loginEmployee,
  addEmployee,
  updateSettings,
  getCompanyOverview,
  assignToCoordinator,
  getEmployeeList,
  deleteEmployee,
  superAdminLogin,
  getAllCompanies,
  deleteCompany,
  updateEmployeeMapping,
  updateEmployee,
  updateBranding,
  verifyTenant,
  getProfile,
} = require('../controllers/tenantController');
const { authMiddleware, superAdminOnly, sameTenantOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');

// ─── PUBLIC ───────────────────────────────────────────────────────────────────
router.post('/master-login', superAdminLogin);
router.post('/login-employee', loginEmployee);
router.get('/verify/:subdomain', verifyTenant);

// ─── SUPERADMIN ONLY ──────────────────────────────────────────────────────────
router.post('/create-company', authMiddleware, superAdminOnly, ...useUpload(_upload.single('logo')), createTenant);
router.get('/all-companies', authMiddleware, superAdminOnly, getAllCompanies);
router.delete('/company/:id', authMiddleware, superAdminOnly, deleteCompany);

// ─── AUTHENTICATED ────────────────────────────────────────────────────────────
router.get('/auth/me', authMiddleware, subscriptionGuard, getProfile);

// Branding & settings
router.put('/update-branding', authMiddleware, subscriptionGuard, ...useUpload(_upload.single('logo')), updateBranding);
router.put('/update-settings', authMiddleware, subscriptionGuard, updateSettings);
router.get('/settings/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    res.status(200).json(tenant);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching settings', error: err.message });
  }
});

// Task delegation
router.get('/authorized-staff/:id', authMiddleware, subscriptionGuard, taskController.getAuthorizedStaff);
router.post('/create', authMiddleware, subscriptionGuard, ...useUpload(_upload.array('taskFiles', 5)), taskController.createTask);
router.get('/assigner/:assignerId', authMiddleware, subscriptionGuard, taskController.getAssignerTasks);
router.get('/doer/:doerId', authMiddleware, subscriptionGuard, taskController.getDoerTasks);
router.put('/respond', authMiddleware, subscriptionGuard, ...useUpload(_upload.single('evidence')), taskController.respondToTask);
router.delete('/:taskId', authMiddleware, subscriptionGuard, taskController.deleteTask);
router.put('/handle-revision', authMiddleware, subscriptionGuard, taskController.handleRevision);
router.get('/coordinator/:coordinatorId', authMiddleware, subscriptionGuard, taskController.getCoordinatorTasks);

// Checklists
router.post('/create-checklist', authMiddleware, subscriptionGuard, taskController.createChecklistTask);
router.post('/checklist-done', authMiddleware, subscriptionGuard, ...useUpload(_upload.single('evidence')), taskController.completeChecklistTask);
router.get('/checklist-all/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, taskController.getAllChecklists);
router.put('/checklist-update/:id', authMiddleware, subscriptionGuard, taskController.updateChecklistTask);
router.get('/checklist/:doerId', authMiddleware, subscriptionGuard, taskController.getChecklistTasks);
router.delete('/checklist/:id', authMiddleware, subscriptionGuard, taskController.deleteChecklistTask);

// Employee management
router.get('/employees/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, getEmployeeList);
router.post('/add-employee',      authMiddleware, subscriptionGuard, addEmployee);
router.put('/employees/:id', authMiddleware, subscriptionGuard, updateEmployee);
router.delete('/employees/:id', authMiddleware, subscriptionGuard, deleteEmployee);
router.put('/update-mapping', authMiddleware, subscriptionGuard, updateEmployeeMapping);
router.put('/assign-coordinator', authMiddleware, subscriptionGuard, assignToCoordinator);
router.get('/company-overview/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, getCompanyOverview);
router.get('/mapping-overview/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, taskController.getMappingOverview);
router.get('/score/:employeeId', authMiddleware, subscriptionGuard, taskController.getEmployeeScore);
router.post('/coordinator-force-done', authMiddleware, subscriptionGuard, taskController.coordinatorForceDone);

router.get('/global-performance/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, taskController.getGlobalPerformance);

// Direct WhatsApp template send — no task lookup needed
router.post('/send-whatsapp-reminder', authMiddleware, subscriptionGuard, async (req, res) => {
  try {
    const { templateName, toPhone, variables } = req.body;
    if (!toPhone || !templateName) {
      return res.status(400).json({ message: 'toPhone and templateName required' });
    }
    const sendWhatsApp = require('../utils/whatsappNotify');
    await sendWhatsApp(toPhone, { templateName, variables: variables || [] });
    res.json({ message: 'WhatsApp reminder sent' });
  } catch (err) {
    console.error('[WhatsApp] send-whatsapp-reminder error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

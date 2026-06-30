// server/routes/taskRoutes.js
// FIX S-2: authMiddleware now applied to every protected route.
// FIX S-6: sameTenantOnly applied to tenant-scoped routes.
// Public routes (login, verify) are explicitly left unprotected.

const express = require('express');
const router = express.Router();
const {
  createTenant,
  loginEmployee,
  addEmployee,
  bulkAddEmployees,
  bulkAddTasks,
  bulkAddChecklists,
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
  getProfile,
  pauseSubscription,
  resumeSubscription,
} = require('../controllers/tenantController');
const Tenant = require('../models/Tenant');
const _upload = require('../utils/s3Uploader');

// Helper: handles both single middleware and [middleware, middleware] array
const useUpload = (method) => {
  if (Array.isArray(method)) return method;
  return [method];
};
const taskController = require('../controllers/taskController');
const { authMiddleware, superAdminOnly, sameTenantOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');


// ─── PUBLIC ROUTES (no auth required) ────────────────────────────────────────

// Company lookup by subdomain — used on the login page before a token exists
router.get('/verify/:subdomain', async (req, res) => {
  try {
    const tenant = await Tenant.findOne({ subdomain: req.params.subdomain.toLowerCase() });
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    res.json({
      companyName:    tenant.companyName,
      id:             tenant._id,
      whatsappActive: tenant.whatsappConfig ? tenant.whatsappConfig.isActive : false,
      // Include subscription status so frontend can redirect paused companies on load
      subscription:   tenant.subscription || { status: 'active' },
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Employee login
router.post('/login-employee', loginEmployee);

// ─── SUPERADMIN ROUTES (require valid token + isSuperAdmin) ──────────────────

router.post('/master-login', superAdminLogin);
router.post('/create-company', authMiddleware, superAdminOnly, ...useUpload(_upload.single('logo')), createTenant);
router.get('/all-companies', authMiddleware, superAdminOnly, getAllCompanies);
router.delete('/company/:id', authMiddleware, superAdminOnly, deleteCompany);
router.put('/company/:id/pause',  authMiddleware, pauseSubscription);
router.put('/company/:id/resume', authMiddleware, resumeSubscription);

// ─── AUTHENTICATED ROUTES ────────────────────────────────────────────────────

// Profile
router.get('/auth/me', authMiddleware, subscriptionGuard, getProfile);

// Employee management
router.get('/employees/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, getEmployeeList);
// DoerChecklist calls /api/employees without tenantId — reads from JWT
router.get('/employees', authMiddleware, subscriptionGuard, async (req, res) => {
  try {
    const Employee = require('../models/Employee');
    const employees = await Employee.find({ tenantId: req.user.tenantId }).select('name email role department');
    res.json({ employees });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch employees', error: err.message });
  }
});
router.post('/add-employee',   authMiddleware, subscriptionGuard, addEmployee);
router.post('/bulk-employees', authMiddleware, subscriptionGuard, bulkAddEmployees);
router.post('/bulk-tasks',     authMiddleware, subscriptionGuard, bulkAddTasks);
router.post('/bulk-checklist', authMiddleware, subscriptionGuard, bulkAddChecklists);
router.put('/employees/:id', authMiddleware, subscriptionGuard, updateEmployee);
router.delete('/employees/:id', authMiddleware, subscriptionGuard, deleteEmployee);
router.get('/authorized-staff/:id', authMiddleware, subscriptionGuard, taskController.getAuthorizedStaff);

// Mapping, branding & settings
router.put('/update-mapping', authMiddleware, subscriptionGuard, updateEmployeeMapping);
router.put('/update-settings', authMiddleware, subscriptionGuard, updateSettings);
router.put('/update-branding', authMiddleware, subscriptionGuard, ...useUpload(_upload.single('logo')), updateBranding);
router.put('/assign-coordinator', authMiddleware, subscriptionGuard, assignToCoordinator);

// Settings fetch
router.get('/settings/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    res.status(200).json(tenant);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching settings', error: err.message });
  }
});

// Tasks
router.post('/create-task', authMiddleware, subscriptionGuard,
  ...useUpload(_upload.fields([
    { name: 'files',     maxCount: 10 },
    { name: 'taskFiles', maxCount: 10 },
  ])),
  // Normalize: merge taskFiles into files so controller always reads req.files.files
  (req, res, next) => {
    if (req.files) {
      const all = [
        ...(req.files['files']     || []),
        ...(req.files['taskFiles'] || []),
      ];
      req.files = all; // flatten to array like upload.array() does
    }
    next();
  },
  taskController.createTask
);
router.delete('/:taskId', authMiddleware, subscriptionGuard, taskController.deleteTask);
router.post('/handle-revision', authMiddleware, subscriptionGuard, taskController.handleRevision);
router.post('/coordinator-force-done', authMiddleware, subscriptionGuard, taskController.coordinatorForceDone);
router.put('/coordinator-force-done', authMiddleware, subscriptionGuard, taskController.coordinatorForceDone);
router.put('/respond', authMiddleware, subscriptionGuard, ...useUpload(_upload.single('evidence')), taskController.respondToTask);
router.post('/send-reminder', authMiddleware, subscriptionGuard, taskController.sendWhatsAppReminder);

// Checklists
router.post('/create-checklist', authMiddleware, subscriptionGuard, taskController.createChecklistTask);
router.get('/checklist-all/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, taskController.getAllChecklists);
router.get('/checklist/:doerId', authMiddleware, subscriptionGuard, taskController.getChecklistTasks);
router.put('/checklist/:id', authMiddleware, subscriptionGuard, taskController.updateChecklistTask);
router.delete('/checklist/:id', authMiddleware, subscriptionGuard, taskController.deleteChecklistTask);
router.post('/checklist-done', authMiddleware, subscriptionGuard, ...useUpload(_upload.single('evidence')), taskController.completeChecklistTask);

// Task views
router.get('/doer/:doerId', authMiddleware, subscriptionGuard, taskController.getDoerTasks);
router.get('/assigner/:assignerId', authMiddleware, subscriptionGuard, taskController.getAssignerTasks);
router.get('/coordinator/:coordinatorId', authMiddleware, subscriptionGuard, taskController.getCoordinatorTasks);
router.get('/coordinator-tasks/:coordinatorId', authMiddleware, subscriptionGuard, taskController.getCoordinatorTasks);

// Analytics & scoreboards
router.get('/employee-score/:employeeId', authMiddleware, subscriptionGuard, taskController.getEmployeeScore);
router.get('/global-performance/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, taskController.getGlobalPerformance);
router.get('/company-overview/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, getCompanyOverview);
router.get('/employee-deep-dive/:employeeId', authMiddleware, subscriptionGuard, taskController.getEmployeeDeepDive);
router.put('/update-weekly-target', authMiddleware, subscriptionGuard, taskController.updateEmployeeTarget);
router.get('/review-analytics/:tenantId', authMiddleware, subscriptionGuard, sameTenantOnly, taskController.getReviewAnalytics);

module.exports = router;

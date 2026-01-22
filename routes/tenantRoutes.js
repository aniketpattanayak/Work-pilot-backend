// server/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();
const Tenant = require('../models/Tenant');
const ChecklistTask = require('../models/ChecklistTask');
const upload = require('../utils/s3Uploader'); // Ensure this utility path is correct
const taskController = require('../controllers/taskController');
const tenantController = require('../controllers/tenantController');

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
} = require('../controllers/tenantController');

// ==========================================
// 1. AUTH & SUPERADMIN (FACTORY MANAGEMENT)
// ==========================================
router.post('/master-login', superAdminLogin);
router.post('/create-company', upload.single('logo'), createTenant);
router.get('/all-companies', getAllCompanies);
router.delete('/company/:id', deleteCompany);
router.get('/verify/:subdomain', verifyTenant);

// ==========================================
// 2. BRANDING & FACTORY SETTINGS
// ==========================================
/**
 * BRANDING UPDATE: Supports updating Company Name and Logo.
 * Matches: PUT /api/superadmin/update-branding
 */
router.put('/update-branding', upload.single('logo'), updateBranding);

// Updated Settings PUT route
router.put('/update-settings', updateSettings);

// Fetch settings logic (Fixes 404 for fetching tenant details)
router.get('/settings/:tenantId', async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });
        res.status(200).json(tenant);
    } catch (err) {
        res.status(500).json({ message: "Error fetching settings", error: err.message });
    }
});

// ==========================================
// 3. DELEGATION TASKS (YOUR MISSING ROUTES)
// ==========================================
/**
 * All these routes were throwing 404s because the prefix 
 * in index.js needed to be mapped correctly.
 */
router.get('/authorized-staff/:id', taskController.getAuthorizedStaff);
router.post('/create', upload.array('taskFiles', 5), taskController.createTask);
router.get('/assigner/:assignerId', taskController.getAssignerTasks);
router.get('/doer/:doerId', taskController.getDoerTasks);
router.put('/respond', upload.single('evidence'), taskController.respondToTask);
router.delete('/:taskId', taskController.deleteTask);
router.put('/handle-revision', taskController.handleRevision);
router.get('/coordinator/:coordinatorId', taskController.getCoordinatorTasks);

// ==========================================
// 4. ROUTINE CHECKLISTS
// ==========================================
router.post('/create-checklist', taskController.createChecklistTask);
router.post('/checklist-done', upload.single('evidence'), taskController.completeChecklistTask);
router.get('/checklist-all/:tenantId', taskController.getAllChecklists);
router.put('/checklist-update/:id', taskController.updateChecklistTask);

// ⚠️ CRITICAL FIX: Use the controller function instead of inline query
// This now generates multiple instance cards for missed dates
router.get('/checklist/:doerId', taskController.getChecklistTasks);

// ==========================================
// 5. EMPLOYEE & MAPPING ADMINISTRATION
// ==========================================
router.get('/employees/:tenantId', getEmployeeList);
router.post('/add-employee', addEmployee);
router.put('/employees/:id', updateEmployee);
router.delete('/employees/:id', deleteEmployee);
router.put('/update-mapping', updateEmployeeMapping);
router.put('/assign-coordinator', assignToCoordinator);
router.get('/company-overview/:tenantId', getCompanyOverview);
router.get('/mapping-overview/:tenantId', taskController.getMappingOverview);
router.get('/score/:employeeId', taskController.getEmployeeScore);
router.post('/coordinator-force-done', taskController.coordinatorForceDone);
router.post('/send-whatsapp-reminder', taskController.sendWhatsAppReminder);
router.get('/global-performance/:tenantId', taskController.getGlobalPerformance);

// ==========================================
// 6. LOGIN & VERIFICATION
// ==========================================
router.post('/login-employee', loginEmployee);

module.exports = router;
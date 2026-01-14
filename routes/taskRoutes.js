// server/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();
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
    updateBranding, // Import the new controller function
} = require('../controllers/tenantController');
const Tenant = require('../models/Tenant');
const upload = require('../utils/s3Uploader'); // Use your existing S3 uploader

// --- AUTH & SUPERADMIN ROUTES ---
router.post('/master-login', superAdminLogin);
router.post('/create-company', upload.single('logo'), createTenant); // Added upload here too for initial registration
router.get('/all-companies', getAllCompanies);
router.delete('/company/:id', deleteCompany);

// --- EMPLOYEE MANAGEMENT ROUTES ---
router.get('/employees/:tenantId', getEmployeeList);
router.post('/add-employee', addEmployee);
router.put('/employees/:id', updateEmployee);
router.delete('/employees/:id', deleteEmployee);

// --- MAPPING, BRANDING & SETTINGS ---
router.put('/update-mapping', updateEmployeeMapping);
router.put('/update-settings', updateSettings);

/**
 * BRANDING UPDATE: Supports updating Company Name and Logo.
 * Middleware: upload.single('logo') matches the key used in Settings.jsx FormData.
 */
router.put('/update-branding', upload.single('logo'), updateBranding);

router.put('/assign-coordinator', assignToCoordinator);
router.get('/company-overview/:tenantId', getCompanyOverview);

// Fetch settings logic
router.get('/settings/:tenantId', async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });
        res.status(200).json(tenant);
    } catch (err) {
        res.status(500).json({ message: "Error fetching settings", error: err.message });
    }
});

// --- LOGIN & VERIFICATION ---
router.post('/login-employee', loginEmployee);
router.get('/verify/:subdomain', async (req, res) => {
    try {
      const tenant = await Tenant.findOne({ subdomain: req.params.subdomain.toLowerCase() });
      if (!tenant) return res.status(404).json({ message: "Tenant not found" });
      res.json({ 
        companyName: tenant.companyName, 
        id: tenant._id,
        whatsappActive: tenant.whatsappConfig ? tenant.whatsappConfig.isActive : false 
      });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
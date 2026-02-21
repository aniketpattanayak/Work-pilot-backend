const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const Tenant = require('../models/Tenant');
const mongoose = require('mongoose');

/**
 * LRBC REPORTING & ANALYTICS ROUTES v1.2
 * Purpose: Handles factory-specific automated settings, manual exports, and test runs.
 */

// 1. Get current report settings for the specific factory tab
router.get('/settings/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Validate ID format to prevent casting errors
    if (!mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).json({ message: "Invalid Factory ID format" });
    }

    const tenant = await Tenant.findById(tenantId)
      .select('reportEmail weeklyReportDay monthlyReportDate companyName');
    
    if (!tenant) {
      return res.status(404).json({ message: "Factory settings not found" });
    }

    res.status(200).json(tenant);
  } catch (error) {
    console.error("❌ LRBC Settings Fetch Error:", error.message);
    res.status(500).json({ message: "Failed to load factory settings" });
  }
});

// 2. Save new report settings from the Admin tab
router.post('/settings', async (req, res) => {
  try {
    const { tenantId, reportEmail, weeklyReportDay, monthlyReportDate } = req.body;

    if (!tenantId) {
      return res.status(400).json({ message: "Missing Factory ID" });
    }

    const updatedTenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { 
        $set: {
          reportEmail, 
          weeklyReportDay, 
          monthlyReportDate 
        }
      },
      { new: true, runValidators: true }
    );

    if (!updatedTenant) {
      return res.status(404).json({ message: "Factory record not found" });
    }

    console.log(`✅ [LRBC Sync] Report settings updated for: ${updatedTenant.companyName}`);
    res.status(200).json({ message: "Report preferences saved successfully", updatedTenant });
  } catch (error) {
    console.error("❌ LRBC Settings Save Error:", error.message);
    res.status(500).json({ message: "Failed to update factory settings" });
  }
});

// 3. Manual Download (Who-Did-What detailed spreadsheet/CSV)
// This triggers the specific controller logic for immediate CSV file generation.
router.get('/download/:tenantId', reportController.manualDownload);

/**
 * 4. SEND TEST EMAIL ROUTE
 * Purpose: Allows the admin to click a button and receive the CSV report immediately.
 */
router.post('/send-test', async (req, res) => {
  try {
    const { tenantId } = req.body;
    
    // Find the tenant to get the stored email address
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || !tenant.reportEmail) {
      return res.status(400).json({ message: "No admin email saved for this factory." });
    }

    // Generate a 7-day report content
    const content = await reportController.generateDetailedReport(tenantId, 7);
    
    // Use the email service utility
    const { sendReportEmail } = require('../utils/emailService');
    const success = await sendReportEmail(
      tenant.reportEmail, 
      `TEST: WorkPilot Spreadsheet - ${tenant.companyName}`, 
      content
    );

    if (success) {
      res.status(200).json({ message: `Test spreadsheet sent to ${tenant.reportEmail}` });
    } else {
      res.status(500).json({ message: "Email delivery failed. Check server logs." });
    }
  } catch (err) {
    res.status(500).json({ message: "Test trigger failed", error: err.message });
  }
});

module.exports = router;
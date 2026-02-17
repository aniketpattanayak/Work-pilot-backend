const express = require('express');
const router = express.Router();
const fmsController = require('../controllers/fmsController');

// ==========================================
// 1. BLUEPRINT & TEMPLATE MANAGEMENT
// ==========================================

/**
 * Saves the master SOP and time offsets for a new factory flow.
 */
router.post('/create-template', fmsController.createFmsTemplate); 

/**
 * Retrieves all blueprints/SOPs defined for a specific factory.
 */
router.get('/templates/:tenantId', fmsController.getTenantTemplates); 

router.delete('/template/:templateId', fmsController.deleteFmsTemplate);
// ==========================================
// 2. LIVE FLOW EXECUTION (TIME-BASED)
// ==========================================

/**
 * START FLOW: Initializes a specific order (e.g., Order #101) 
 * and starts the clock for Phase 1.
 */
router.post('/start-flow', fmsController.initializeFlow);

/**
 * EXECUTE STEP: Marks a worker's phase as finished, calculates delay, 
 * and automatically plans the deadline for the next person in line.
 */
router.put('/execute-step/:instanceId', fmsController.executeStep);

/**
 * GET INSTANCES: Fetches all live orders and their current status.
 * Required for the 'Live Production Tracker' table in FmsDashboard.jsx.
 */
router.get('/instances/:tenantId', fmsController.getTenantInstances);


// ==========================================
// 3. GOOGLE SHEETS SYNC (THE TRIGGER)
// ==========================================

/**
 * Scans the connected Google Sheet for NEW rows to auto-initialize flows.
 */
router.get('/sync/:templateId', fmsController.syncFmsOrders);

module.exports = router;
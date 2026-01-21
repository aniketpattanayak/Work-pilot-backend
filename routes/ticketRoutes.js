const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');

/**
 * 1. FIXED INFRASTRUCTURE LINK
 * We are now pointing directly to your central S3 utility.
 * This ensures consistency across Tasks, Checklists, and Support Tickets.
 */
const upload = require('../utils/s3Uploader');

/**
 * SUPPORT TICKETING SYSTEM ROUTES
 */

// 1. Raise a New Ticket (Handles multi-media: up to 5 images/videos)
router.post('/create', upload.array('initialMedia', 5), ticketController.createTicket);

// 2. Admin: Get All Global Tickets
router.get('/all', ticketController.getAllTickets);

// 3. User: Get Personal Tickets
router.get('/user/:reporterId', ticketController.getUserTickets);

// 4. Super Admin: Resolve Ticket with Proof (Up to 3 images)
router.put('/resolve', upload.array('resolutionMedia', 3), ticketController.resolveTicket);

module.exports = router;
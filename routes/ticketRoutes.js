// server/routes/ticketRoutes.js
// FIX S-2: All ticket routes now require authentication.

const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const upload = require('../utils/s3Uploader');
const { authMiddleware, superAdminOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');
const tenantDbMiddleware = require('../middleware/tenantDb');

// 1. Raise a new ticket (any authenticated user)
router.post('/create',
  authMiddleware,
  tenantDbMiddleware,
  upload.array('initialMedia', 5),
  ticketController.createTicket
);

// 2. Admin: Get all global tickets (SuperAdmin or Admin role only)
router.get('/all', authMiddleware, superAdminOnly, ticketController.getAllTickets);

// 3. User: Get personal tickets (own tickets only)
router.get('/user/:reporterId', authMiddleware, subscriptionGuard, ticketController.getUserTickets);

// 4. Resolve ticket with proof (SuperAdmin only)
router.put('/resolve',
  authMiddleware,
  superAdminOnly,
  upload.array('resolutionMedia', 3),
  ticketController.resolveTicket
);

// 5. Reporter: edit / delete own ticket
router.put('/:ticketId', authMiddleware, subscriptionGuard, ticketController.updateTicket);
router.delete('/:ticketId', authMiddleware, subscriptionGuard, ticketController.deleteTicket);

module.exports = router;
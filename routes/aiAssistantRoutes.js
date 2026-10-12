const express = require('express');
const router = express.Router();
const { authMiddleware, tenantDbMiddleware } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');
const c = require('../controllers/aiAssistantController');

router.post('/chat', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.chat);

module.exports = router;

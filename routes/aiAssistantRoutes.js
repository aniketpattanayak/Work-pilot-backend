const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const tenantDbMiddleware = require('../middleware/tenantDb');
const subscriptionGuard = require('../middleware/subscriptionGuard');
const c = require('../controllers/aiAssistantController');

router.post('/chat', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.chat);

module.exports = router;

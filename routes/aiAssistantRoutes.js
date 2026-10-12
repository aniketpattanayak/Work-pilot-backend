const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const tenantDbMiddleware = require('../middleware/tenantDb');
const subscriptionGuard = require('../middleware/subscriptionGuard');
const c = require('../controllers/aiAssistantController');

router.post('/chat', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.chat);

// Part 2 (AI-layer-v2): conversation sessions - list/open/delete/new. Each
// handler scopes its DB query to (tenantId, req.user.id) itself, so a user
// can only ever see their own sessions regardless of role.
router.get('/sessions', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.listSessions);
router.post('/sessions', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.createSession);
router.get('/sessions/:sessionId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.getSession);
router.delete('/sessions/:sessionId', authMiddleware, subscriptionGuard, tenantDbMiddleware, c.deleteSession);

module.exports = router;

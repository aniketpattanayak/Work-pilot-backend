const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const c = require('../controllers/voiceController');

// Provider webhook: authenticated by the shared secret (VOICE_WEBHOOK_SECRET), not by a user token.
router.post('/webhook', c.webhook);

// Admin tools: logged-in admin of a company that the Superadmin has switched the module on for.
router.post('/outbound/checkin', authMiddleware, c.requireVoiceTenant, c.triggerCheckin);
router.get('/logs', authMiddleware, c.requireVoiceTenant, c.listLogs);

module.exports = router;

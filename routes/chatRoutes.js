const express  = require('express');
const multer   = require('multer');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const tenantDbMiddleware = require('../middleware/tenantDb');
const c = require('../controllers/chatController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Conversations
router.get ('/conversations',              authMiddleware, tenantDbMiddleware, c.getConversations);
router.post('/dm',                         authMiddleware, tenantDbMiddleware, c.getOrCreateDM);
router.post('/task-thread',                authMiddleware, tenantDbMiddleware, c.getOrCreateTaskThread);
router.post('/announcement',               authMiddleware, tenantDbMiddleware, c.createAnnouncement);
router.get ('/unread-count',               authMiddleware, tenantDbMiddleware, c.getUnreadCount);
router.get ('/employees',                  authMiddleware, tenantDbMiddleware, c.getEmployees);

// Messages
router.get ('/:conversationId/messages',   authMiddleware, tenantDbMiddleware, c.getMessages);
router.post('/:conversationId/messages',   authMiddleware, tenantDbMiddleware, c.sendMessage);
router.post('/:conversationId/read',       authMiddleware, tenantDbMiddleware, c.markRead);

// File upload
router.post('/upload',                     authMiddleware, upload.single('file'), c.uploadFile);

module.exports = router;

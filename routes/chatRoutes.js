const express  = require('express');
const multer   = require('multer');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const c = require('../controllers/chatController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Conversations
router.get ('/conversations',              authMiddleware, c.getConversations);
router.post('/dm',                         authMiddleware, c.getOrCreateDM);
router.post('/task-thread',                authMiddleware, c.getOrCreateTaskThread);
router.post('/announcement',               authMiddleware, c.createAnnouncement);
router.get ('/unread-count',               authMiddleware, c.getUnreadCount);
router.get ('/employees',                  authMiddleware, c.getEmployees);

// Messages
router.get ('/:conversationId/messages',   authMiddleware, c.getMessages);
router.post('/:conversationId/messages',   authMiddleware, c.sendMessage);
router.post('/:conversationId/read',       authMiddleware, c.markRead);

// File upload
router.post('/upload',                     authMiddleware, upload.single('file'), c.uploadFile);

module.exports = router;

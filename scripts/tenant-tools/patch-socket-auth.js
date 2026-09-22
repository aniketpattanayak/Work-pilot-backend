const path = require('path');
const safePatch = require('./safe-patch');
const SERVER_ROOT = path.join(__dirname, '..', '..');

safePatch(
  path.join(SERVER_ROOT, 'utils/socketHandler.js'),
  `const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');`,
  `const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');`
);

safePatch(
  path.join(SERVER_ROOT, 'utils/socketHandler.js'),
  `    // ── JOIN CONVERSATION ROOM ──────────────────────────────────
    socket.on('join_conversation', (conversationId) => {
      socket.join(\`conv_\${conversationId}\`);
      console.log(\`[Socket] \${name} joined conv_\${conversationId}\`);
    });`,
  `    // ── JOIN CONVERSATION ROOM ──────────────────────────────────
    // SECURITY: verify this socket's user is actually a participant of the
    // conversation (or it's a tenant-wide announcement) in THEIR tenant's
    // database, before letting them listen to its events.
    socket.on('join_conversation', async (conversationId) => {
      try {
        const Tenant = require('../models/Tenant');
        const ConversationSchema = require('../models/Conversation').schema;
        const { getTenantConnection } = require('./tenantDb');

        const tenantDoc = await Tenant.findById(tenantId).select('superAdmin.customMongoUri').lean();
        const customUri = tenantDoc?.superAdmin?.customMongoUri;
        const conn = customUri
          ? await getTenantConnection(tenantId.toString(), customUri)
          : mongoose.connection;
        const ConversationModel = conn.models.Conversation || conn.model('Conversation', ConversationSchema);

        const allowed = await ConversationModel.findOne({
          _id: conversationId,
          tenantId,
          \$or: [{ participants: employeeId }, { type: 'announcement' }],
        }).select('_id').lean();

        if (!allowed) {
          socket.emit('conversation_error', { conversationId, message: 'You do not have access to this conversation.' });
          return;
        }

        socket.join(\`conv_\${conversationId}\`);
        console.log(\`[Socket] \${name} joined conv_\${conversationId}\`);
      } catch (e) {
        console.error('[Socket] join_conversation error:', e.message);
      }
    });`
);

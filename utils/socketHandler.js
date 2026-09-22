/**
 * socketHandler.js
 * Sets up Socket.io for real-time chat.
 * Call initSocket(httpServer) from index.js
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

let io;

function initSocket(httpServer, allowedOriginsSet, subdomainRe) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOriginsSet?.has?.(origin) || subdomainRe?.test?.(origin)) return cb(null, true);
        cb(new Error('CORS not allowed'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // ── Auth middleware — verify JWT on every socket connection ──
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('No token'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded; // { id, tenantId, name, role }
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const { id: employeeId, tenantId } = socket.user;

    // Fetch name from DB since JWT may not include it
    let name = socket.user.name || '';
    if (!name) {
      try {
        const Employee = require('../models/Employee');
        const emp = await Employee.findById(employeeId).select('name').lean();
        name = emp?.name || 'Unknown';
      } catch(e) {}
    }
    socket.user.name = name;
    console.log(`[Socket] Connected: ${name} (${employeeId})`);

    // Join tenant room — for broadcasts
    socket.join(`tenant_${tenantId}`);

    // Join employee's personal room — for direct notifications
    socket.join(`employee_${employeeId}`);

    // ── JOIN CONVERSATION ROOM ──────────────────────────────────
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
          $or: [{ participants: employeeId }, { type: 'announcement' }],
        }).select('_id').lean();

        if (!allowed) {
          socket.emit('conversation_error', { conversationId, message: 'You do not have access to this conversation.' });
          return;
        }

        socket.join(`conv_${conversationId}`);
        console.log(`[Socket] ${name} joined conv_${conversationId}`);
      } catch (e) {
        console.error('[Socket] join_conversation error:', e.message);
      }
    });

    // ── LEAVE CONVERSATION ROOM ─────────────────────────────────
    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conv_${conversationId}`);
    });

    // ── TYPING INDICATOR ────────────────────────────────────────
    socket.on('typing_start', ({ conversationId }) => {
      socket.to(`conv_${conversationId}`).emit('user_typing', {
        conversationId,
        employeeId,
        name,
      });
    });

    socket.on('typing_stop', ({ conversationId }) => {
      socket.to(`conv_${conversationId}`).emit('user_stopped_typing', {
        conversationId,
        employeeId,
      });
    });

    // ── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${name}`);
    });
  });

  console.log('🔌 [Socket.io] Real-time chat engine active');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocket, getIO };
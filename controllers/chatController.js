const Conversation = require('../models/Conversation');
const Message      = require('../models/Message');
const Employee     = require('../models/Employee');

// ─── PER-TENANT DB MODEL RESOLUTION ───────────────────────────────────────────
// Same req.db pattern already used in taskController.js / newFmsController.js.
// Dedicated-DB tenants: reads/writes go to THEIR database.
// Shared-DB tenants: req.db is null, falls back to the original models —
// i.e. no behavior change for any client without a dedicated DB.
function getChatModels(req) {
  return {
    Conversation: req.db ? req.db.model('Conversation') : Conversation,
    Message:      req.db ? req.db.model('Message')      : Message,
    Employee:     req.db ? req.db.model('Employee')      : Employee,
  };
}

// ─── AUTHORIZATION HELPER ──────────────────────────────────────────────────
// Loads a conversation only if it belongs to this tenant AND the requesting
// employee is a participant (or it's a tenant-wide announcement). Returns
// null if not found or not allowed — callers respond 403 accordingly.
async function loadAuthorizedConversation(ConversationModel, conversationId, tenantId, employeeId) {
  return ConversationModel.findOne({
    _id: conversationId,
    tenantId,
    $or: [
      { participants: employeeId },
      { type: 'announcement' },
    ],
  });
}

// ─── GET CONVERSATIONS ────────────────────────────────────────────────────────
exports.getConversations = async (req, res) => {
  try {
    const { Conversation, Employee } = getChatModels(req);
    const employeeId = req.user.id;
    const tenantId   = req.user.tenantId;

    const conversations = await Conversation.find({
      tenantId,
      isActive: true,
      $or: [
        { participants: employeeId },
        { type: 'announcement' },
      ],
    })
    .sort({ 'lastMessage.sentAt': -1, updatedAt: -1 })
    .lean();

    const empIds = [...new Set(conversations.flatMap(c => c.participants || []).map(p => p.toString()))];
    const empDocs = await Employee.find({ _id: { $in: empIds } }).select('name role').lean();
    const empMap = {};
    empDocs.forEach(e => { empMap[e._id.toString()] = e; });

    const result = conversations.map(c => {
      const unreadCount = c.unreadCounts?.[employeeId.toString()] || 0;
      let displayName = c.title || '';
      let otherEmployee = null;
      if (c.type === 'dm') {
        const otherId = (c.participants || []).find(p => p.toString() !== employeeId.toString());
        otherEmployee = otherId ? empMap[otherId.toString()] : null;
        displayName = otherEmployee?.name || 'Direct Message';
      } else if (c.type === 'task') {
        displayName = c.taskTitle || 'Task Thread';
      } else if (c.type === 'announcement') {
        displayName = c.title || 'Announcement';
      }
      return { ...c, displayName, otherEmployee, unreadCount };
    });

    res.json(result);
  } catch (err) {
    console.error('[Chat] getConversations error:', err.message);
    res.status(500).json({ message: 'Failed to fetch conversations' });
  }
};

// ─── GET OR CREATE DM ─────────────────────────────────────────────────────────
exports.getOrCreateDM = async (req, res) => {
  try {
    const { Conversation, Employee } = getChatModels(req);
    const employeeId      = req.user.id;
    const tenantId        = req.user.tenantId;
    const { otherEmployeeId } = req.body;

    if (!otherEmployeeId) return res.status(400).json({ message: 'otherEmployeeId required' });

    let conversation = await Conversation.findOne({
      tenantId,
      type: 'dm',
      participants: { $all: [employeeId, otherEmployeeId], $size: 2 },
    }).lean();

    if (!conversation) {
      // Tightened: previously looked up by ID alone with no tenant check.
      const other = await Employee.findOne({ _id: otherEmployeeId, tenantId }).select('name').lean();
      if (!other) return res.status(404).json({ message: 'That employee was not found in your company.' });

      conversation = await Conversation.create({
        tenantId,
        type: 'dm',
        participants: [employeeId, otherEmployeeId],
      });
      conversation = conversation.toObject();
    }

    res.json(conversation);
  } catch (err) {
    console.error('[Chat] getOrCreateDM error:', err.message);
    res.status(500).json({ message: 'Failed to get or create DM' });
  }
};

// ─── GET OR CREATE TASK THREAD ────────────────────────────────────────────────
exports.getOrCreateTaskThread = async (req, res) => {
  try {
    const { Conversation } = getChatModels(req);
    const tenantId = req.user.tenantId;
    const { taskId, taskType, taskTitle, participants } = req.body;

    let conversation = await Conversation.findOne({ tenantId, taskId }).lean();

    if (!conversation) {
      conversation = await Conversation.create({
        tenantId,
        type: 'task',
        taskId,
        taskType: taskType || 'delegation',
        taskTitle: taskTitle || 'Task',
        participants: participants || [],
      });
      conversation = conversation.toObject();
    }

    res.json(conversation);
  } catch (err) {
    console.error('[Chat] getOrCreateTaskThread error:', err.message);
    res.status(500).json({ message: 'Failed to get or create task thread' });
  }
};

// ─── CREATE ANNOUNCEMENT ──────────────────────────────────────────────────────
exports.createAnnouncement = async (req, res) => {
  try {
    const { Conversation, Message } = getChatModels(req);
    const tenantId = req.user.tenantId;
    const { title, text } = req.body;

    if (!title || !text) return res.status(400).json({ message: 'title and text required' });

    const conversation = await Conversation.create({
      tenantId,
      type: 'announcement',
      title,
      participants: [],
    });

    const message = await Message.create({
      conversationId: conversation._id,
      tenantId,
      senderId:   req.user.id,
      senderName: req.user.name || 'Admin',
      senderRole: req.user.role || 'Admin',
      text,
    });

    await Conversation.findByIdAndUpdate(conversation._id, {
      lastMessage: {
        text,
        senderId:   req.user.id,
        senderName: req.user.name || 'Admin',
        sentAt:     message.createdAt,
      },
    });

    res.json({ conversation, message });
  } catch (err) {
    console.error('[Chat] createAnnouncement error:', err.message);
    res.status(500).json({ message: 'Failed to create announcement' });
  }
};

// ─── GET MESSAGES ─────────────────────────────────────────────────────────────
exports.getMessages = async (req, res) => {
  try {
    const { Conversation, Message } = getChatModels(req);
    const { conversationId } = req.params;
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip  = (page - 1) * limit;

    const conversation = await loadAuthorizedConversation(Conversation, conversationId, tenantId, employeeId);
    if (!conversation) return res.status(403).json({ message: 'You do not have access to this conversation.' });

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(messages.reverse());
  } catch (err) {
    console.error('[Chat] getMessages error:', err.message);
    res.status(500).json({ message: 'Failed to fetch messages' });
  }
};

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const { Conversation, Message, Employee } = getChatModels(req);
    const { conversationId } = req.params;
    const { text, fileUrl, fileName, fileType, mentions } = req.body;
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;

    if (!text && !fileUrl) return res.status(400).json({ message: 'text or file required' });

    const conversation = await loadAuthorizedConversation(Conversation, conversationId, tenantId, employeeId);
    if (!conversation) return res.status(403).json({ message: 'You do not have access to this conversation.' });

    let senderName = req.user.name || '';
    let senderRole = req.user.role || (req.user.roles?.[0] || '');
    if (!senderName) {
      const emp = await Employee.findById(employeeId).select('name role roles').lean();
      senderName = emp?.name || 'Unknown';
      senderRole = senderRole || emp?.role || emp?.roles?.[0] || '';
    }

    const message = await Message.create({
      conversationId,
      tenantId,
      senderId:   employeeId,
      senderName,
      senderRole,
      text:     text || '',
      fileUrl:  fileUrl || '',
      fileName: fileName || '',
      fileType: fileType || '',
      mentions: mentions || [],
      readBy:   [employeeId],
    });

    const updateObj = {
      'lastMessage.text':       text || (fileUrl ? `📎 ${fileName || 'File'}` : ''),
      'lastMessage.senderId':   employeeId,
      'lastMessage.senderName': senderName,
      'lastMessage.sentAt':     message.createdAt,
      'lastMessage.hasFile':    !!fileUrl,
    };

    const participants = conversation.participants.map(p => p.toString());
    const others = participants.filter(p => p !== employeeId.toString());

    if (conversation.type === 'announcement') {
      // no per-person unread tracking for announcements
    } else {
      for (const otherId of others) {
        updateObj[`unreadCounts.${otherId}`] = (conversation.unreadCounts?.get?.(otherId) || 0) + 1;
      }
    }

    await Conversation.findByIdAndUpdate(conversationId, { $set: updateObj });

    const io = req.app.get('io');
    if (io) {
      io.to(`conv_${conversationId}`).emit('new_message', message);
      io.to(`tenant_${tenantId}`).emit('conversation_updated', {
        conversationId,
        lastMessage: updateObj,
      });
    }

    res.json(message);
  } catch (err) {
    console.error('[Chat] sendMessage error:', err.message);
    res.status(500).json({ message: 'Failed to send message' });
  }
};

// ─── MARK READ ────────────────────────────────────────────────────────────────
exports.markRead = async (req, res) => {
  try {
    const { Conversation, Message } = getChatModels(req);
    const { conversationId } = req.params;
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;

    const conversation = await loadAuthorizedConversation(Conversation, conversationId, tenantId, employeeId);
    if (!conversation) return res.status(403).json({ message: 'You do not have access to this conversation.' });

    await Message.updateMany(
      { conversationId, readBy: { $ne: employeeId } },
      { $addToSet: { readBy: employeeId } }
    );

    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { [`unreadCounts.${employeeId}`]: 0 },
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`conv_${conversationId}`).emit('messages_read', {
        conversationId,
        employeeId,
      });
    }

    res.json({ message: 'Marked as read' });
  } catch (err) {
    console.error('[Chat] markRead error:', err.message);
    res.status(500).json({ message: 'Failed to mark as read' });
  }
};

// ─── GET UNREAD COUNT ─────────────────────────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  try {
    const { Conversation } = getChatModels(req);
    const employeeId = req.user.id.toString();
    const tenantId   = req.user.tenantId;

    const conversations = await Conversation.find({
      tenantId,
      isActive: true,
      $or: [{ participants: req.user.id }, { type: 'announcement' }],
    }).select('unreadCounts').lean();

    const total = conversations.reduce((sum, c) => {
      return sum + (c.unreadCounts?.[employeeId] || 0);
    }, 0);

    res.json({ unreadCount: total });
  } catch (err) {
    res.status(500).json({ unreadCount: 0 });
  }
};

// ─── GET ALL EMPLOYEES FOR DM PICKER ─────────────────────────────────────────
exports.getEmployees = async (req, res) => {
  try {
    const { Employee } = getChatModels(req);
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;

    const employees = await Employee.find({
      tenantId,
      _id: { $ne: employeeId },
      isActive: { $ne: false },
    }).select('name role').lean();

    res.json(employees);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
};

// ─── UPLOAD FILE ─────────────────────────────────────────────────────────────
exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const s3Uploader = require('../utils/s3Uploader');
    const result = await s3Uploader.uploadFile(req.file);

    res.json({
      fileUrl:  result.url || result.Location,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
    });
  } catch (err) {
    console.error('[Chat] uploadFile error:', err.message);
    res.status(500).json({ message: 'File upload failed' });
  }
};

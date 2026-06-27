const Conversation = require('../models/Conversation');
const Message      = require('../models/Message');
const Employee     = require('../models/Employee');

// ─── GET CONVERSATIONS ────────────────────────────────────────────────────────
/**
 * GET /api/chat/conversations
 * Returns all conversations for the logged-in employee
 * Sorted by lastMessage.sentAt desc
 */
exports.getConversations = async (req, res) => {
  try {
    const employeeId = req.user.id;
    const tenantId   = req.user.tenantId;

    // DMs and task threads where this employee is a participant
    // Announcements are visible to everyone in the tenant
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

    // Populate participant names for DM conversations
    const empIds = [...new Set(conversations.flatMap(c => c.participants || []).map(p => p.toString()))];
    const empDocs = await Employee.find({ _id: { $in: empIds } }).select('name role').lean();
    const empMap = {};
    empDocs.forEach(e => { empMap[e._id.toString()] = e; });

    const result = conversations.map(c => {
      const unreadCount = c.unreadCounts?.[employeeId.toString()] || 0;
      // For DM — find the OTHER participant's name
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
/**
 * POST /api/chat/dm
 * Body: { otherEmployeeId }
 * Returns existing DM conversation or creates a new one
 */
exports.getOrCreateDM = async (req, res) => {
  try {
    const employeeId      = req.user.id;
    const tenantId        = req.user.tenantId;
    const { otherEmployeeId } = req.body;

    if (!otherEmployeeId) return res.status(400).json({ message: 'otherEmployeeId required' });

    // Find existing DM between these two
    let conversation = await Conversation.findOne({
      tenantId,
      type: 'dm',
      participants: { $all: [employeeId, otherEmployeeId], $size: 2 },
    }).lean();

    if (!conversation) {
      // Create new DM
      const other = await Employee.findById(otherEmployeeId).select('name').lean();
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
/**
 * POST /api/chat/task-thread
 * Body: { taskId, taskType, taskTitle, participants[] }
 */
exports.getOrCreateTaskThread = async (req, res) => {
  try {
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
/**
 * POST /api/chat/announcement
 * Admin only — Body: { title, text }
 */
exports.createAnnouncement = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { title, text } = req.body;

    if (!title || !text) return res.status(400).json({ message: 'title and text required' });

    // Create conversation
    const conversation = await Conversation.create({
      tenantId,
      type: 'announcement',
      title,
      participants: [],
    });

    // Create the announcement message
    const message = await Message.create({
      conversationId: conversation._id,
      tenantId,
      senderId:   req.user.id,
      senderName: req.user.name || 'Admin',
      senderRole: req.user.role || 'Admin',
      text,
    });

    // Update lastMessage on conversation
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
/**
 * GET /api/chat/:conversationId/messages?page=1&limit=50
 */
exports.getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip  = (page - 1) * limit;

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Return in ascending order (oldest first for display)
    res.json(messages.reverse());
  } catch (err) {
    console.error('[Chat] getMessages error:', err.message);
    res.status(500).json({ message: 'Failed to fetch messages' });
  }
};

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
/**
 * POST /api/chat/:conversationId/messages
 * Body: { text, fileUrl, fileName, fileType, mentions[] }
 */
exports.sendMessage = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { text, fileUrl, fileName, fileType, mentions } = req.body;
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;

    if (!text && !fileUrl) return res.status(400).json({ message: 'text or file required' });

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    // Fetch employee name from DB since JWT may not include it
    let senderName = req.user.name || '';
    let senderRole = req.user.role || (req.user.roles?.[0] || '');
    if (!senderName) {
      const emp = await Employee.findById(employeeId).select('name role roles').lean();
      senderName = emp?.name || 'Unknown';
      senderRole = senderRole || emp?.role || emp?.roles?.[0] || '';
    }

    // Create message
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
      readBy:   [employeeId], // sender has read their own message
    });

    // Update conversation lastMessage + increment unread for other participants
    const updateObj = {
      'lastMessage.text':       text || (fileUrl ? `📎 ${fileName || 'File'}` : ''),
      'lastMessage.senderId':   employeeId,
      'lastMessage.senderName': senderName,
      'lastMessage.sentAt':     message.createdAt,
      'lastMessage.hasFile':    !!fileUrl,
    };

    // Increment unread count for all participants except sender
    const participants = conversation.participants.map(p => p.toString());
    const others = participants.filter(p => p !== employeeId.toString());

    // Also include everyone for announcements
    if (conversation.type === 'announcement') {
      // Don't track unread for announcements per-person (could be thousands)
    } else {
      for (const otherId of others) {
        updateObj[`unreadCounts.${otherId}`] = (conversation.unreadCounts?.get?.(otherId) || 0) + 1;
      }
    }

    await Conversation.findByIdAndUpdate(conversationId, { $set: updateObj });

    // Emit via socket (handled in socketHandler.js)
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
/**
 * POST /api/chat/:conversationId/read
 * Marks all messages as read for current employee
 */
exports.markRead = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const employeeId = req.user.id;

    // Add employeeId to readBy on all unread messages
    await Message.updateMany(
      { conversationId, readBy: { $ne: employeeId } },
      { $addToSet: { readBy: employeeId } }
    );

    // Reset unread count for this employee
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { [`unreadCounts.${employeeId}`]: 0 },
    });

    // Emit read receipt
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
/**
 * GET /api/chat/unread-count
 * Total unread messages for current employee across all conversations
 */
exports.getUnreadCount = async (req, res) => {
  try {
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
/**
 * GET /api/chat/employees
 * List of employees in the tenant for starting a DM
 */
exports.getEmployees = async (req, res) => {
  try {
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;

    const employees = await Employee.find({
      tenantId,
      _id: { $ne: employeeId }, // exclude self
      isActive: { $ne: false },
    }).select('name role').lean();

    res.json(employees);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
};

// ─── UPLOAD FILE ─────────────────────────────────────────────────────────────
/**
 * POST /api/chat/upload
 * Uploads a file and returns the URL
 */
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
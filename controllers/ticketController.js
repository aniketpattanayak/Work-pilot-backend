const SupportTicket = require('../models/Ticket');
const Employee = require('../models/Employee');
const { notifyTenant } = require('../utils/notify');
const mongoose = require('mongoose');

const isOwnerOrSuper = (req, ownerId) =>
  !!req.user && (req.user.isSuperAdmin || String(req.user.id) === String(ownerId));
const TICKET_FIELDS = ['title', 'description', 'category', 'priority'];


// A. Raise a New Ticket
exports.createTicket = async (req, res) => {
  try {
    const { title, description, category, priority } = req.body;
    const reporterId = req.user?.id || req.body.reporterId;
    const tenantId = req.user?.tenantId || req.body.tenantId;
    if (!title || !String(title).trim() || !description || !String(description).trim()) {
      return res.status(400).json({ message: "Subject and description are required." });
    }
    
    // 1. Fetch Reporter details to auto-capture Role and Name
    // company's own database when it has one
    const EmployeeModel = (req.db && req.db.model('Employee')) || Employee;
    const reporter = await EmployeeModel.findById(reporterId);
    if (!reporter) return res.status(404).json({ message: "User not found" });

    // 2. Process Initial Media (Images/Videos)
    let mediaFiles = [];
    if (req.files && req.files.length > 0) {
      mediaFiles = req.files.map(file => ({
        fileName: file.originalname,
        fileUrl: file.location || file.path,
        fileType: file.mimetype.startsWith('video') ? 'video' : 'image'
      }));
    }

    const newTicket = new SupportTicket({
      tenantId,
      reporterId,
      reporterName: reporter.name,
      reporterEmail: reporter.email,
      reporterRole: Array.isArray(reporter.roles) ? reporter.roles.join(', ') : (reporter.role || 'User'),
      title: String(title).trim(),
      description: String(description).trim(),
      category,
      priority,
      initialMedia: mediaFiles,
      history: [{ action: 'Ticket Raised', remarks: 'New support request initiated.' }]
    });

    await newTicket.save();
    res.status(201).json({ message: "Ticket Raised Successfully", ticket: newTicket });
  } catch (error) {
    res.status(500).json({ message: "Failed to raise ticket", error: error.message });
  }
};

// B. NEW: Get Personal Tickets (For the logged-in User)
exports.getUserTickets = async (req, res) => {
  try {
    const { reporterId } = req.params;
    if (!isOwnerOrSuper(req, reporterId)) return res.status(403).json({ message: "You can only view your own tickets." });
    
    // Fetch tickets specifically for this user, sorted by newest first
    const tickets = await SupportTicket.find({ reporterId })
      .sort({ createdAt: -1 });
      
    res.status(200).json(tickets || []);
  } catch (error) {
    console.error("User Ticket Fetch Error:", error.message);
    res.status(500).json({ message: "Error loading your tickets", error: error.message });
  }
};

// B2. Edit my own ticket (only while it is still Open)
exports.updateTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(ticketId)) return res.status(400).json({ message: "Invalid ticket id." });
    const ticket = await SupportTicket.findById(ticketId);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    if (!isOwnerOrSuper(req, ticket.reporterId)) return res.status(403).json({ message: "You can only edit your own tickets." });
    if (ticket.status !== 'Open') return res.status(409).json({ message: "This ticket is already being handled (" + ticket.status + "), so it can no longer be edited." });

    const body = req.body || {};
    const next = {};
    for (const k of TICKET_FIELDS) if (body[k] !== undefined) next[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    if (next.title !== undefined && !next.title) return res.status(400).json({ message: "Subject cannot be empty." });
    if (next.description !== undefined && !next.description) return res.status(400).json({ message: "Description cannot be empty." });
    if (next.priority !== undefined && !['Low', 'Medium', 'High', 'Urgent'].includes(next.priority)) return res.status(400).json({ message: "Invalid priority." });
    Object.assign(ticket, next);
    ticket.history.push({ action: 'Ticket Edited', performedBy: ticket.reporterName, timestamp: new Date(), remarks: 'Reporter updated the ticket details.' });
    await ticket.save();
    res.status(200).json({ message: "Ticket updated", ticket });
  } catch (error) {
    res.status(500).json({ message: "Failed to update ticket", error: error.message });
  }
};

// B3. Delete my own ticket (not while support is working on it)
exports.deleteTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(ticketId)) return res.status(400).json({ message: "Invalid ticket id." });
    const ticket = await SupportTicket.findById(ticketId);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    if (!isOwnerOrSuper(req, ticket.reporterId)) return res.status(403).json({ message: "You can only delete your own tickets." });
    if (ticket.status === 'In-Progress') return res.status(409).json({ message: "Support is working on this ticket right now, so it cannot be deleted." });
    await SupportTicket.deleteOne({ _id: ticket._id });
    res.status(200).json({ message: "Ticket deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete ticket", error: error.message });
  }
};

// C. Get All Tickets (For Super Admin Global Oversight)
exports.getAllTickets = async (req, res) => {
  try {
    const tickets = await SupportTicket.find().sort({ createdAt: -1 });
    res.status(200).json(tickets || []);
  } catch (error) {
    res.status(500).json({ message: "Fetch failed", error: error.message });
  }
};

// D. Resolve Ticket (Admin Action with Proof)
exports.resolveTicket = async (req, res) => {
  try {
    const { ticketId, adminRemarks } = req.body;
    const ticket = await SupportTicket.findById(ticketId).populate('reporterId');
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    // Process Resolution Proof (Images)
    let proofFiles = [];
    if (req.files && req.files.length > 0) {
      proofFiles = req.files.map(file => ({
        fileName: file.originalname,
        fileUrl: file.location || file.path
      }));
    }

    ticket.status = 'Resolved';
    ticket.adminRemarks = adminRemarks;
    ticket.resolutionMedia = proofFiles;
    ticket.resolvedAt = new Date();
    ticket.history.push({ 
      action: 'Resolved', 
      performedBy: 'Super Admin',
      timestamp: new Date(),
      remarks: adminRemarks 
    });

    await ticket.save();

    // Notify User of Resolution via WhatsApp
    if (ticket.reporterId?.whatsappNumber) {
        const msg = `✅ *Ticket Resolved*\n\nHi ${ticket.reporterName}, your issue "${ticket.title}" has been fixed.\n\n*Solution:* ${adminRemarks}`;
        await notifyTenant(ticket.tenantId, ticket.reporterId.whatsappNumber, msg);
    }

    res.status(200).json({ message: "Ticket marked as Resolved", ticket });
  } catch (error) {
    res.status(500).json({ message: "Resolution failed", error: error.message });
  }
};
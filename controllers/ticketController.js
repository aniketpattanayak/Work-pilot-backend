const SupportTicket = require('../models/Ticket');
const Employee = require('../models/Employee');
const sendWhatsAppMessage = require('../utils/whatsappNotify');

// A. Raise a New Ticket
exports.createTicket = async (req, res) => {
  try {
    const { title, description, category, priority, reporterId, tenantId } = req.body;
    
    // 1. Fetch Reporter details to auto-capture Role and Name
    const reporter = await Employee.findById(reporterId);
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
      title,
      description,
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
    
    // Fetch tickets specifically for this user, sorted by newest first
    const tickets = await SupportTicket.find({ reporterId })
      .sort({ createdAt: -1 });
      
    res.status(200).json(tickets || []);
  } catch (error) {
    console.error("User Ticket Fetch Error:", error.message);
    res.status(500).json({ message: "Error loading your tickets", error: error.message });
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
        await sendWhatsAppMessage(ticket.reporterId.whatsappNumber, msg);
    }

    res.status(200).json({ message: "Ticket marked as Resolved", ticket });
  } catch (error) {
    res.status(500).json({ message: "Resolution failed", error: error.message });
  }
};
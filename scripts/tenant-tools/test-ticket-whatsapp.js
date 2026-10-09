require('dotenv').config();
const mongoose = require('mongoose');

const ARV_TENANT_ID   = '6ab234b5dfaa60ec91448715';
const ARV_ADMIN_EMPID = '6ab234b5dfaa60ec91448717'; // "ARV Companies Admin" — exists in shared DB

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const Ticket = require('../../models/Ticket');

    const ticket = await Ticket.create({
      tenantId: ARV_TENANT_ID,
      reporterId: ARV_ADMIN_EMPID,
      reporterName: 'ARV Companies Admin',
      reporterEmail: 'mis2@arvcompanies.com',
      reporterRole: 'Admin',
      title: '[TEST] WhatsApp routing verification',
      description: 'Created by test-ticket-whatsapp.js — safe to delete after checking the logs.',
      category: 'Other',
      priority: 'Low',
      history: [{ action: 'Ticket Raised', remarks: 'Automated routing test.' }],
    });
    console.log(`✅ Created test ticket: ${ticket._id}\n`);

    const ticketController = require('../../controllers/ticketController');
    const fakeReq = {
      body: { ticketId: ticket._id.toString(), adminRemarks: 'Resolved by automated routing test.' },
      files: [],
    };
    const fakeRes = {
      status: (code) => ({
        json: (payload) => console.log(`\n[resolveTicket responded] HTTP ${code}:`, payload?.message || payload),
      }),
    };

    console.log('Calling the real, deployed resolveTicket() now — watch for [Maytapi] or [DoubleTick] below:\n');
    await ticketController.resolveTicket(fakeReq, fakeRes);

    console.log(`\nTo clean this test ticket up afterward:\n  node scripts/tenant-tools/delete-test-ticket.js ${ticket._id}`);
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
})();

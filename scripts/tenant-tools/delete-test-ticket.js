require('dotenv').config();
const mongoose = require('mongoose');
const ticketId = process.argv[2];
if (!ticketId) { console.error('Usage: node delete-test-ticket.js <ticketId>'); process.exit(1); }
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Ticket = require('../../models/Ticket');
  const result = await Ticket.deleteOne({ _id: ticketId, title: '[TEST] WhatsApp routing verification' });
  console.log(result.deletedCount ? '✅ Test ticket deleted.' : '⚠️ Nothing deleted — check the ID.');
  await mongoose.disconnect();
})();

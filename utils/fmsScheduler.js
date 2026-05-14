const cron = require('node-cron');
const FmsTemplate = require('../models/FmsTemplate');
const fmsController = require('../controllers/fmsController');

const runFmsSync = () => {
  console.log("⏳ Running FMS Auto Sync...");

  cron.schedule('* * * * *', async () => {
    try {
      const templates = await FmsTemplate.find({ isActive: true });

      for (const template of templates) {
        await fmsController.syncFmsOrders(
          { params: { templateId: template._id } },
          {
            status: () => ({ json: () => {} })
          }
        );
      }

      console.log("✅ FMS Sync Completed");
    } catch (err) {
      console.error("❌ FMS Sync Failed:", err.message);
    }
  });
};

module.exports = runFmsSync;
const cron = require('node-cron');
const { triggerAutomatedReports } = require('../controllers/reportController');

/**
 * LRBC CRON ENGINE v1.1
 * Purpose: Acts as the system alarm clock to trigger factory-specific reports.
 * Schedule: Runs every day at 08:00 AM.
 */
const initReportScheduler = () => {
  console.log("⏰ [LRBC Sync] Report Scheduler has been initialized.");

  /**
   * CRON SYNTAX: 'minute hour day-of-month month day-of-week'
   * '0 8 * * *' = Exactly 08:00 AM every day.
   */
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log("⏰ [LRBC Scheduler] Commencing daily report scan...");
      
      // Triggers the multi-tenant logic in the controller
      await triggerAutomatedReports();
      
      console.log("⏰ [LRBC Scheduler] Daily report scan completed successfully.");
    } catch (error) {
      console.error("❌ [LRBC Scheduler] Critical error during report scan:", error.message);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Set this to your local timezone for accuracy
  });
};

module.exports = initReportScheduler;
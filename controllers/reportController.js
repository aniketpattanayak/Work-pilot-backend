const DelegationTask = require('../models/DelegationTask');
const ChecklistTask = require('../models/ChecklistTask');
const Employee = require('../models/Employee');
const Tenant = require('../models/Tenant');
const moment = require('moment');
const sendReportEmail = require('../utils/emailService');

/**
 * 1. DETAILED REPORT GENERATOR
 * Purpose: Creates a detailed text report for a specific factory.
 * Format: clean office -(Done by) Ramesh, 20 feb, done, given by admin...
 */
exports.generateDetailedReport = async (tenantId, days = 7) => {
  const startDate = moment().subtract(days, 'days').startOf('day').toDate();
  const reportLines = [];

  // 1. Fetch only this factory's data using tenantId
  const [delegations, checklists, tenant] = await Promise.all([
    DelegationTask.find({ tenantId, createdAt: { $gte: startDate } }).populate('assignerId doerId'),
    ChecklistTask.find({ tenantId }).populate('doerId'),
    Tenant.findById(tenantId)
  ]);

  reportLines.push(`--- ${tenant?.companyName || 'WORKPILOT'} DETAILED REPORT (LAST ${days} DAYS) ---`);
  reportLines.push(`Generated on: ${moment().format('DD MMM YYYY, hh:mm A')}\n`);

  // 2. Process Delegation Tasks
  delegations.forEach(task => {
    const doneRecord = task.history.find(h => h.action === 'Completed' || h.action === 'Verified');
    const status = doneRecord ? 'done' : 'not done';
    const time = doneRecord ? moment(doneRecord.timestamp).format('hh:mm A') : 'N/A';
    const date = moment(task.deadline).format('DD MMM');
    
    reportLines.push(`${task.title} -(Done by) ${task.doerId?.name || 'Staff'}, ${date}, ${status}, given by ${task.assignerId?.name || 'Admin'}, delegation task, Time: ${time}`);
  });

  // 3. Process Checklist Tasks (Day-by-Day logic)
  for (let i = 0; i < days; i++) {
    const currentDay = moment().subtract(i, 'days').startOf('day');
    const dateLabel = currentDay.format('DD MMM');

    checklists.forEach(task => {
      const wasDone = task.history.find(h => 
        moment(h.instanceDate || h.timestamp).isSame(currentDay, 'day') && 
        (h.action === 'Completed' || h.action === 'Administrative Completion')
      );

      const status = wasDone ? 'done' : 'not done';
      const time = wasDone ? moment(wasDone.timestamp).format('hh:mm A') : 'N/A';
      
      reportLines.push(`${task.taskName} -(Done by) ${task.doerId?.name || 'Staff'}, ${dateLabel}, ${status}, given by admin, checklist task, Time: ${time}`);
    });
  }

  return reportLines.join('\n');
};

/**
 * 2. MULTI-TENANT AUTOMATION ENGINE
 * Purpose: Loops through every factory and sends reports to their respective admins.
 */
exports.triggerAutomatedReports = async () => {
  try {
    // Find all factories that have a report email configured
    const tenants = await Tenant.find({ reportEmail: { $exists: true, $ne: "" } });
    const today = moment().format('dddd'); // e.g., "Saturday"
    const dateOfMonth = moment().format('D'); // e.g., "1"

    for (const tenant of tenants) {
      // A. Check Weekly Schedule for this specific factory
      if (tenant.weeklyReportDay === today) {
        const content = await this.generateDetailedReport(tenant._id, 7);
        await sendReportEmail(
            tenant.reportEmail, 
            `Weekly Work Report: ${tenant.companyName}`, 
            content
        );
        console.log(`✉️ Weekly Report sent to ${tenant.companyName} Admin: ${tenant.reportEmail}`);
      }
      
      // B. Check Monthly Schedule for this specific factory
      if (String(tenant.monthlyReportDate) === dateOfMonth) {
        const content = await this.generateDetailedReport(tenant._id, 30);
        await sendReportEmail(
            tenant.reportEmail, 
            `Monthly Work Report: ${tenant.companyName}`, 
            content
        );
        console.log(`✉️ Monthly Report sent to ${tenant.companyName} Admin: ${tenant.reportEmail}`);
      }
    }
  } catch (err) {
    console.error("❌ LRBC Report Engine Error:", err.message);
  }
};

/**
 * 3. MANUAL DOWNLOAD ENDPOINT
 * Purpose: Allows a factory admin to download their report immediately.
 */
/**
 * 3. MANUAL DOWNLOAD ENDPOINT (EXCEL/CSV FORMAT)
 * Purpose: Allows a factory admin to download their report as a Spreadsheet.
 */
exports.manualDownload = async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { range } = req.query; 
        const days = range === 'monthly' ? 30 : 7;

        // 1. Fetch Data
        const startDate = moment().subtract(days, 'days').startOf('day').toDate();
        const [delegations, checklists] = await Promise.all([
            DelegationTask.find({ tenantId, createdAt: { $gte: startDate } }).populate('assignerId doerId'),
            ChecklistTask.find({ tenantId }).populate('doerId')
        ]);

        // 2. Create CSV Header
        let csvContent = "Task Name,Done By,Date,Status,Assigned By,Category,Time Finished\n";

        // 3. Add Delegation Tasks
        delegations.forEach(task => {
            const doneRecord = task.history.find(h => h.action === 'Completed' || h.action === 'Verified');
            const status = doneRecord ? 'Done' : 'Not Done';
            const time = doneRecord ? moment(doneRecord.timestamp).format('hh:mm A') : 'N/A';
            const date = moment(task.deadline).format('DD MMM YYYY');
            
            // Format: Task, Doer, Date, Status, Assigner, Category, Time
            csvContent += `"${task.title}","${task.doerId?.name || 'Staff'}","${date}","${status}","${task.assignerId?.name || 'Admin'}","Delegation","${time}"\n`;
        });

        // 4. Add Checklist Tasks (Day-by-Day)
        for (let i = 0; i < days; i++) {
            const currentDay = moment().subtract(i, 'days').startOf('day');
            const dateLabel = currentDay.format('DD MMM YYYY');

            checklists.forEach(task => {
                const wasDone = task.history.find(h => 
                    moment(h.instanceDate || h.timestamp).isSame(currentDay, 'day') && 
                    (h.action === 'Completed' || h.action === 'Administrative Completion')
                );

                const status = wasDone ? 'Done' : 'Not Done';
                const time = wasDone ? moment(wasDone.timestamp).format('hh:mm A') : 'N/A';
                
                csvContent += `"${task.taskName}","${task.doerId?.name || 'Staff'}","${dateLabel}","${status}","Admin","Checklist","${time}"\n`;
            });
        }

        // 5. Send as CSV Download
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=WorkPilot_Report_${range}.csv`);
        res.status(200).send(csvContent);

    } catch (error) {
        console.error("CSV Export Error:", error.message);
        res.status(500).json({ message: "Failed to generate spreadsheet", error: error.message });
    }
};
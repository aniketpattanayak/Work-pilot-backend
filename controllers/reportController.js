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

const ExcelJS = require('exceljs');

exports.manualDownload = async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { range } = req.query;
        const days = range === 'monthly' ? 30 : 7;

        const startDate = moment().subtract(days, 'days').startOf('day').toDate();

        const [delegations, checklists] = await Promise.all([
            DelegationTask.find({ tenantId, createdAt: { $gte: startDate } }).populate('assignerId doerId'),
            ChecklistTask.find({ tenantId }).populate('doerId')
        ]);

        const workbook = new ExcelJS.Workbook();

        // =========================
        // SHEET 1 → DELEGATIONS
        // =========================
        const delegationSheet = workbook.addWorksheet('Delegations');

        delegationSheet.columns = [
            { header: 'Task', key: 'task' },
            { header: 'Assigned To', key: 'doneBy' },
            { header: 'Deadline', key: 'date' },
            { header: 'Status', key: 'status' },
            { header: 'Assigned By', key: 'assignedBy' },
        ];

        delegations.forEach(task => {
            const doneRecord = task.history.find(h => 
                h.action === 'Completed' || h.action === 'Verified'
            );

            delegationSheet.addRow({
                task: task.title,
                doneBy: task.doerId?.name || 'Staff',
                date: moment(task.deadline).format('DD MMM YYYY'),
                status: doneRecord ? 'Done' : 'Not Done',
                assignedBy: task.assignerId?.name || 'Admin',
            });
        });
        const checklistSheet = workbook.addWorksheet('Checklist');

        checklistSheet.columns = [
            { header: 'Task', key: 'task' },
            { header: 'Assigned To', key: 'doneBy' },
            { header: 'Date', key: 'date' },
            {  header: 'Frequency' ,key:'frequency'},
            { header: 'Status', key: 'status' },
            { header: 'Assigned By', key: 'assignedBy' },
        ];



         checklists.forEach(task => {

    const freq = (task.frequency || '').toLowerCase();
    const config = task.frequencyConfig || {};

    const taskStart = moment.max(
        moment(task.createdAt).startOf('day'),
        moment().subtract(days - 1, 'days').startOf('day')
    );

    let total = 0;
    let doneCount = 0;

    for (let i = 0; i < days; i++) {

        const currentDay = moment().subtract(i, 'days').startOf('day');

        if (currentDay.isBefore(taskStart)) continue;

        let isScheduled = false;

        // ✅ DAILY
        if (freq === 'daily') {
            isScheduled = true;
        }

        // ✅ WEEKLY
        else if (freq === 'weekly') {
            const daysOfWeek = config.daysOfWeek || [];
            if (daysOfWeek.includes(currentDay.day())) {
                isScheduled = true;
            }
        }

        // ✅ MONTHLY
        else if (freq === 'monthly') {
            const daysOfMonth = config.daysOfMonth || [];
            if (daysOfMonth.includes(currentDay.date())) {
                isScheduled = true;
            }
        }

        // ✅ INTERVAL (every X days)
        else if (config.intervalDays > 0) {
            const diff = currentDay.diff(moment(task.createdAt), 'days');
            if (diff % config.intervalDays === 0) {
                isScheduled = true;
            }
        }

        // ❗ ONLY count if scheduled
        if (!isScheduled) continue;

        total++;

        const wasDone = task.history.find(h =>
            moment(h.instanceDate || h.timestamp).isSame(currentDay, 'day') &&
            (h.action === 'Completed' || h.action === 'Administrative Completion')
        );

        if (wasDone) doneCount++;
    }

    checklistSheet.addRow({
        task: task.taskName,
        doneBy: task.doerId?.name || 'Staff',
        date: `${taskStart.format('DD MMM')} → ${moment().format('DD MMM YYYY')}`,
        frequency : task.frequency,
        status: `${doneCount}/${total} Done`,
        assignedBy: 'Admin'
    });
});
        
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        res.setHeader(
            'Content-Disposition',
            `attachment; filename=WorkPilot_Report_${range}.xlsx`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Excel Export Error:", error.message);
        res.status(500).json({ message: "Failed to generate spreadsheet" });
    }
};



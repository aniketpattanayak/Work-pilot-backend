const fs = require('fs');
const path = require('path');

function patch(filePath, oldText, newText, label) {
  const full = path.resolve(filePath);
  const content = fs.readFileSync(full, 'utf8');
  const count = content.split(oldText).length - 1;
  if (count !== 1) {
    console.error(`❌ [${label}] Expected exactly 1 match, found ${count}. Aborting — no changes written.`);
    process.exit(1);
  }
  fs.writeFileSync(full, content.replace(oldText, newText), 'utf8');
  console.log(`✅ [${label}] Patched.`);
}

const file = path.join(__dirname, '../../controllers/tenantController.js');

const oldBlock = `    const VALID_FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval'];

    const results = { success: 0, failed: [] };

    for (const cl of checklists) {
      try {
        const taskName     = cl['Checklist Title'] || cl.title || cl.taskName;
        const assignedName = cl['Assigned To'] || cl.assignedTo;
        const assignee     = findEmp(assignedName);
        const frequency    = (cl['Frequency'] || cl.frequency || '').trim();
        const startDateRaw = cl['Start Date'] || cl['Deadline'] || cl.startDate;

        if (!taskName) throw new Error('Checklist Title is required');
        if (!assignee) throw new Error(\`No employee found matching "\${assignedName}"\`);
        if (!VALID_FREQUENCIES.includes(frequency)) {
          throw new Error(\`Frequency must be one of: \${VALID_FREQUENCIES.join(', ')} (got "\${frequency}")\`);
        }

        // NOTE: bulk upload has no column for which weekday / month-date to
        // run on — Weekly defaults to Monday, Monthly defaults to the 1st.
        // Adjust via Manage Checklist > Edit > Frequency Tuning afterwards
        // if a different day is needed.
        const baseAnchorDate = startDateRaw ? new Date(startDateRaw) : new Date();
        const nextDueDate = calculateNextDate(
          frequency,
          {},
          tenant.holidays || [],
          baseAnchorDate,
          true,
          tenant.weekends || [0]
        );

        await ChecklistTask.create({
          tenantId,
          taskName,
          description: cl['Description'] || cl.description || '',
          doerId: assignee._id,
          frequency,
          frequencyConfig: {},
          startDate: baseAnchorDate,
          nextDueDate,
          status: 'Active',
          history: [{
            action: 'Checklist Created',
            remarks: \`Bulk-uploaded. First mission anchored for \${nextDueDate.toLocaleDateString('en-IN')}\`,
            timestamp: new Date(),
          }],
        });
        results.success++;`;

const newBlock = `    const VALID_FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval'];

    const WEEKDAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const parseDaysOfWeek = (raw) => (raw || '').split(',')
      .map(s => s.trim().toLowerCase().slice(0, 3))
      .filter(Boolean)
      .map(s => WEEKDAY_MAP[s])
      .filter(n => n !== undefined);
    const parseDaysOfMonth = (raw) => (raw || '').split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 31);

    const results = { success: 0, failed: [] };

    for (const cl of checklists) {
      try {
        const taskName     = cl['Checklist Title'] || cl.title || cl.taskName;
        const assignedName = cl['Assigned To'] || cl.assignedTo;
        const assignee     = findEmp(assignedName);
        const frequency    = (cl['Frequency'] || cl.frequency || '').trim();
        const startDateRaw = cl['Start Date'] || cl['Deadline'] || cl.startDate;

        if (!taskName) throw new Error('Checklist Title is required');
        if (!assignee) throw new Error(\`No employee found matching "\${assignedName}"\`);
        if (!VALID_FREQUENCIES.includes(frequency)) {
          throw new Error(\`Frequency must be one of: \${VALID_FREQUENCIES.join(', ')} (got "\${frequency}")\`);
        }

        // Weekly/Monthly need to know WHICH day(s) — pulled from the extra
        // "Days of Week (if Weekly)" / "Days of Month (if Monthly)" columns,
        // the same day-selection the manual Create Checklist Task form offers.
        const frequencyConfig = { daysOfWeek: [], daysOfMonth: [] };
        if (frequency === 'Weekly') {
          const raw = cl['Days of Week (if Weekly)'] || cl.daysOfWeek || '';
          frequencyConfig.daysOfWeek = parseDaysOfWeek(raw);
          if (frequencyConfig.daysOfWeek.length === 0) {
            throw new Error('Weekly frequency requires "Days of Week (if Weekly)", e.g. "Mon,Wed,Fri"');
          }
          const weekends = tenant.weekends || [0];
          const conflictDays = frequencyConfig.daysOfWeek.filter(d => weekends.includes(d));
          if (conflictDays.length > 0) {
            throw new Error(\`Selected day(s) fall on an employee off day: \${conflictDays.join(',')}\`);
          }
        }
        if (frequency === 'Monthly') {
          const raw = cl['Days of Month (if Monthly)'] || cl.daysOfMonth || '';
          frequencyConfig.daysOfMonth = parseDaysOfMonth(raw);
          if (frequencyConfig.daysOfMonth.length === 0) {
            throw new Error('Monthly frequency requires "Days of Month (if Monthly)", e.g. "1,15"');
          }
        }

        const baseAnchorDate = startDateRaw ? new Date(startDateRaw) : new Date();
        const nextDueDate = calculateNextDate(
          frequency,
          frequencyConfig,
          tenant.holidays || [],
          baseAnchorDate,
          true,
          tenant.weekends || [0]
        );

        await ChecklistTask.create({
          tenantId,
          taskName,
          description: cl['Description'] || cl.description || '',
          doerId: assignee._id,
          frequency,
          frequencyConfig,
          startDate: baseAnchorDate,
          nextDueDate,
          status: 'Active',
          history: [{
            action: 'Checklist Created',
            remarks: \`Bulk-uploaded. First mission anchored for \${nextDueDate.toLocaleDateString('en-IN')}\`,
            timestamp: new Date(),
          }],
        });
        results.success++;`;

patch(file, oldBlock, newBlock, 'bulkAddChecklists day-selection support');

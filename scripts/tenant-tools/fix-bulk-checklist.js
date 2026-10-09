const fs = require('fs');
const path = require('path');

function patch(filePath, oldText, newText, label) {
  const full = path.resolve(filePath);
  const content = fs.readFileSync(full, 'utf8');
  const count = content.split(oldText).length - 1;
  if (count !== 1) {
    console.error(`❌ [${label}] Expected exactly 1 match in ${filePath}, found ${count}. Aborting — no changes written.`);
    process.exit(1);
  }
  fs.writeFileSync(full, content.replace(oldText, newText), 'utf8');
  console.log(`✅ [${label}] Patched.`);
}

const backendFile = path.join(__dirname, '../../controllers/tenantController.js');

patch(
  backendFile,
  `const { notifyTenant } = require('../utils/notify');`,
  `const { notifyTenant } = require('../utils/notify');\nconst { calculateNextDate } = require('../utils/scheduler');`,
  'import calculateNextDate'
);

const oldBulk = `exports.bulkAddChecklists = async (req, res) => {
  try {
    const { Tenant, Employee, DelegationTask, ChecklistTask } = getModels(req);
    const { tenantId, checklists } = req.body;
    if (!tenantId || !Array.isArray(checklists) || checklists.length === 0) {
      return res.status(400).json({ message: 'tenantId and checklists array required' });
    }

    const employees = await Employee.find({ tenantId }).lean();
    const findEmp = (name) => employees.find(e =>
      e.name.toLowerCase().trim() === (name || '').toLowerCase().trim()
    );




    const results = { success: 0, failed: [] };

    for (const cl of checklists) {
      try {
        const assignee = findEmp(cl['Assigned To'] || cl.assignedTo);
        const itemsRaw = cl['Items (semicolon separated)'] || cl.items || '';
        const items    = itemsRaw.split(';').map(s => s.trim()).filter(Boolean).map(label => ({ label, done: false }));

        await ChecklistTask.create({
          tenantId,
          title:       cl['Checklist Title'] || cl.title,
          description: cl['Description']     || cl.description || '',
          assigneeId:  assignee?._id,
          assigneeName:assignee?.name || cl['Assigned To'],
          deadline:    cl['Deadline'] ? new Date(cl['Deadline']) : null,
          items,
          status: 'pending',
        });
        results.success++;
      } catch (err) {
        results.failed.push({ title: cl['Checklist Title'], reason: err.message });
      }
    }

    res.json({ message: \`\${results.success} checklists created, \${results.failed.length} failed\`, results });
  } catch (err) {
    res.status(500).json({ message: 'Bulk checklist upload failed', error: err.message });
  }
};`;

const newBulk = `exports.bulkAddChecklists = async (req, res) => {
  try {
    const { Tenant, Employee, DelegationTask, ChecklistTask } = getModels(req);
    const { tenantId, checklists } = req.body;
    if (!tenantId || !Array.isArray(checklists) || checklists.length === 0) {
      return res.status(400).json({ message: 'tenantId and checklists array required' });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

    const employees = await Employee.find({ tenantId }).lean();
    const findEmp = (name) => employees.find(e =>
      e.name.toLowerCase().trim() === (name || '').toLowerCase().trim()
    );

    const VALID_FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval'];

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
        results.success++;
      } catch (err) {
        results.failed.push({ title: cl['Checklist Title'] || cl.title, reason: err.message });
      }
    }

    res.json({ message: \`\${results.success} checklists created, \${results.failed.length} failed\`, results });
  } catch (err) {
    res.status(500).json({ message: 'Bulk checklist upload failed', error: err.message });
  }
};`;

patch(backendFile, oldBulk, newBulk, 'bulkAddChecklists rewrite');

const fs = require('fs');
const BASE = __dirname;

// ── 1. controllers/newFmsController.js ──────────────────────────────
const ctrlPath = BASE + '/controllers/newFmsController.js';
let ctrl = fs.readFileSync(ctrlPath, 'utf8');

const oldUpdateTemplate = `exports.updateTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const activeCount = await FlowInstance.countDocuments({ templateId, status: 'active' });
    if (activeCount > 0) {
      return res.status(409).json({
        message: \`Cannot edit: \${activeCount} active instance(s) are using this flow. Cancel them first.\`
      });
    }

    const updated = await FlowTemplate.findByIdAndUpdate(templateId, req.body, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Template not found' });

    res.json({ message: 'Template updated', template: updated });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update template', error: err.message });
  }
};`;

const newUpdateTemplate = `exports.updateTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const newNodeIds = new Set((req.body.nodes || []).map(n => n.id));

    const activeInstances = await FlowInstance.find(
      { templateId, status: 'active' },
      { orderIdentifier: 1, 'activeStep.nodeId': 1, 'activeStep.nodeName': 1 }
    );

    const orphaned = activeInstances.filter(
      inst => inst.activeStep?.nodeId && !newNodeIds.has(inst.activeStep.nodeId)
    );

    const updated = await FlowTemplate.findByIdAndUpdate(templateId, req.body, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Template not found' });

    res.json({
      message: activeInstances.length > 0
        ? \`Template updated — now live for \${activeInstances.length} active instance(s).\`
        : 'Template updated',
      template: updated,
      activeInstanceCount: activeInstances.length,
      orphanedInstances: orphaned.map(o => ({
        instanceId: o._id,
        orderIdentifier: o.orderIdentifier,
        currentStep: o.activeStep?.nodeName,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update template', error: err.message });
  }
};`;

if (ctrl.includes(oldUpdateTemplate)) {
  ctrl = ctrl.replace(oldUpdateTemplate, newUpdateTemplate);
  fs.writeFileSync(ctrlPath, ctrl);
  console.log('✓ newFmsController.js patched');
} else {
  console.log('✗ newFmsController.js: exact block not found — needs manual check');
}

// ── 2. utils/flowEngine.js ───────────────────────────────────────────
const enginePath = BASE + '/utils/flowEngine.js';
let engine = fs.readFileSync(enginePath, 'utf8');

const oldGuard = `  const completedNode = template.nodes.find(n => n.id === active.nodeId);
  if (!completedNode) throw new Error(\`Node "\${active.nodeId}" not found in template\`);`;

const newGuard = `  const completedNode = template.nodes.find(n => n.id === active.nodeId);
  if (!completedNode) {
    const err = new Error(
      \`This order's current step ("\${active.nodeName}") was removed in a recent flow edit. \` +
      \`Ask an admin to reassign or cancel this instance.\`
    );
    err.code = 'NODE_ORPHANED';
    throw err;
  }`;

if (engine.includes(oldGuard)) {
  engine = engine.replace(oldGuard, newGuard);
  fs.writeFileSync(enginePath, engine);
  console.log('✓ flowEngine.js patched');
} else {
  console.log('✗ flowEngine.js: exact block not found — needs manual check');
}

console.log('Done.');

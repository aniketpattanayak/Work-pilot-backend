// server/controllers/orderFormController.js

const OrderForm       = require('../models/OrderForm');
const OrderSubmission = require('../models/OrderSubmission');
const FlowTemplate    = require('../models/FlowTemplate');
const FlowInstance    = require('../models/FlowInstance');
const { startInstance } = require('../utils/flowEngine');

// ─── AUTO ID GENERATOR ────────────────────────────────────────────────────────

function generateOrderId(form) {
  const cfg   = form.orderIdConfig;
  const year  = new Date().getFullYear().toString();
  const sep   = cfg.separator || '-';

  let counter;
  if (cfg.resetYearly) {
    const yearCounters = form.yearCounters || {};
    counter = (yearCounters[year] || 0) + 1;
    form.yearCounters = { ...yearCounters, [year]: counter };
  } else {
    counter = (form.lastOrderNumber || 0) + 1;
    form.lastOrderNumber = counter;
  }

  const numStr = String(counter).padStart(cfg.digits || 4, '0');
  const parts  = [cfg.prefix || 'ORD'];
  if (cfg.includeYear !== false) parts.push(year);
  parts.push(numStr);

  return parts.join(sep);
}

function generateLineItemId(orderId, index, form) {
  const cfg = form.lineItemConfig;
  const sep = cfg.separator || '-';
  const num = String(index + 1).padStart(cfg.digits || 3, '0');
  return `${orderId}${sep}${cfg.prefix || 'ITEM'}${num}`;
}

// ─── FORM MANAGEMENT ──────────────────────────────────────────────────────────

/**
 * POST /api/fms2/forms
 * Admin creates or updates a form for a flow template.
 */
exports.upsertForm = async (req, res) => {
  try {
    const { templateId, name, orderFields, itemFields, orderIdConfig, lineItemConfig, allowedRoles } = req.body;
    const tenantId = req.user?.tenantId || req.body.tenantId;

    // If this is just a link update (_updateLink), name is not required
    if (!name && !req.body._updateLink) {
      return res.status(400).json({ message: 'Form name is required' });
    }

    // Verify template belongs to this tenant (only if templateId is provided)
    if (templateId) {
      const template = await FlowTemplate.findOne({ _id: templateId, tenantId });
      if (!template) return res.status(404).json({ message: 'Flow template not found' });
    }

    // Strip out any fields with empty labels before saving
    const cleanFields = arr => (arr || []).filter(f => f && f.label && f.label.trim() !== '');
    const cleanOrderFields = cleanFields(orderFields);
    const cleanItemFields  = cleanFields(itemFields);

    const formId = req.body.formId;
    let form = formId
      ? await OrderForm.findById(formId)
      : (templateId ? await OrderForm.findOne({ templateId }) : null);

    if (form) {
      // Update existing — if _updateLink just update templateId, else update all fields
      if (!req.body._updateLink) {
        form.name          = name;
        form.orderFields   = cleanOrderFields.length ? cleanOrderFields : form.orderFields;
        form.itemFields    = cleanItemFields.length  ? cleanItemFields  : form.itemFields;
        form.orderIdConfig = orderIdConfig || form.orderIdConfig;
        form.lineItemConfig= lineItemConfig|| form.lineItemConfig;
        form.allowedRoles  = allowedRoles  || form.allowedRoles;
      }
      if (templateId) form.templateId = templateId;
      await form.save();
    } else {
      // Create new
      form = await OrderForm.create({
        tenantId, templateId, name: name || 'New Form',
        orderFields:    cleanOrderFields,
        itemFields:     cleanItemFields,
        orderIdConfig:  orderIdConfig  || {},
        lineItemConfig: lineItemConfig || {},
        allowedRoles:   allowedRoles   || ['Admin', 'Assigner', 'Coordinator', 'OrderEntry'],
      });
    }

    // Update FlowTemplate dataSource to 'form'
    if (templateId) {
      await FlowTemplate.findByIdAndUpdate(templateId, { dataSource: 'form' });
    }

    res.status(200).json({ message: 'Form saved', form });
  } catch (err) {
    console.error('[OrderForm] upsertForm error:', err.message);
    res.status(500).json({ message: 'Failed to save form', error: err.message });
  }
};

/**
 * GET /api/fms2/forms/template/:templateId
 * Get the form for a specific flow template.
 */
exports.getFormByTemplate = async (req, res) => {
  try {
    const form = await OrderForm.findOne({ templateId: req.params.templateId, isActive: true });
    if (!form) return res.status(404).json({ message: 'No form found for this template' });
    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch form', error: err.message });
  }
};

/**
 * GET /api/fms2/forms/:tenantId
 * Get all forms for a tenant.
 */
exports.getForms = async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || req.params.tenantId;
    const forms = await OrderForm.find({ tenantId, isActive: true })
      .populate('templateId', 'name')
      .sort({ createdAt: -1 });
    res.json(forms);
  } catch (err) {
    console.error('[OrderForm] getForms error:', err.message);
    res.status(500).json({ message: 'Failed to fetch forms', error: err.message });
  }
};

/**
 * DELETE /api/fms2/forms/:formId
 * Soft delete a form and revert template to sheet mode.
 */
exports.deleteForm = async (req, res) => {
  try {
    const form = await OrderForm.findById(req.params.formId);
    if (!form) return res.status(404).json({ message: 'Form not found' });

    form.isActive = false;
    await form.save();

    await FlowTemplate.findByIdAndUpdate(form.templateId, { dataSource: 'sheet' });

    res.json({ message: 'Form deleted, template reverted to sheet mode' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete form', error: err.message });
  }
};

// ─── ORDER SUBMISSION ─────────────────────────────────────────────────────────

/**
 * POST /api/fms2/forms/submit
 * Employee submits an order via the form.
 * Generates auto-IDs and creates a FlowInstance for each line item.
 */
exports.submitOrder = async (req, res) => {
  try {
    const { formId, orderFieldValues, lineItems } = req.body;
    const employeeId   = req.user?.id;
    const employeeName = req.user?.name || 'Unknown';

    if (!formId) return res.status(400).json({ message: 'formId is required' });
    if (!lineItems || !lineItems.length) return res.status(400).json({ message: 'At least one line item is required' });

    // Load form + template
    const form = await OrderForm.findById(formId);
    if (!form) return res.status(404).json({ message: 'Form not found' });

    const template = await FlowTemplate.findById(form.templateId);
    if (!template) return res.status(404).json({ message: 'Flow template not found' });

    // Generate Order ID
    const orderId = generateOrderId(form);

    // Build line items with auto-generated IDs
    const lineItemDocs = lineItems.map((item, i) => ({
      lineItemId:  generateLineItemId(orderId, i, form),
      fieldValues: item.fieldValues || {},
      status:      'active',
    }));

    // Save submission
    const submission = await OrderSubmission.create({
      tenantId:        form.tenantId,
      formId:          form._id,
      templateId:      form.templateId,
      orderId,
      orderFields:     orderFieldValues || {},
      lineItems:       lineItemDocs,
      submittedBy:     employeeId,
      submittedByName: employeeName,
    });

    // Save the updated counters
    form.markModified('yearCounters');
    await form.save();

    // Create a FlowInstance for each line item
    const createdInstances = [];
    for (const item of lineItemDocs) {
      // Merge order-level fields + item-level fields into rawSheetData
      const rawData = {
        ...orderFieldValues,
        ...item.fieldValues,
        'Order ID':    orderId,
        'Line Item ID': item.lineItemId,
      };

      const instance = await FlowInstance.create({
        tenantId:        form.tenantId,
        templateId:      form.templateId,
        templateName:    template.name,
        orderIdentifier: item.lineItemId,
        rawSheetData:    rawData,
        status:          'active',
      });

      // Update submission with instance reference
      const idx = lineItemDocs.findIndex(l => l.lineItemId === item.lineItemId);
      submission.lineItems[idx].instanceId = instance._id;

      // Start the flow
      await startInstance(instance, template);
      createdInstances.push({ lineItemId: item.lineItemId, instanceId: instance._id });
    }

    await submission.save();

    console.log(`[OrderForm] Order ${orderId} submitted with ${lineItemDocs.length} line items`);

    res.status(201).json({
      message:     'Order submitted successfully',
      orderId,
      lineItems:   createdInstances,
      submissionId: submission._id,
    });
  } catch (err) {
    console.error('[OrderForm] submitOrder error:', err.message);
    res.status(500).json({ message: 'Failed to submit order', error: err.message });
  }
};

// ─── SUBMISSIONS LIST ────────────────────────────────────────────────────────

/**
 * GET /api/fms2/submissions/:tenantId
 * List all submissions for a tenant (admin view).
 */
exports.getSubmissions = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { formId, page = 1, limit = 50 } = req.query;

    const filter = { tenantId };
    if (formId) filter.formId = formId;

    const [submissions, total] = await Promise.all([
      OrderSubmission.find(filter)
        .sort({ submittedAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      OrderSubmission.countDocuments(filter),
    ]);

    res.json({ submissions, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch submissions', error: err.message });
  }
};

/**
 * GET /api/fms2/submissions/detail/:submissionId
 * Full detail of one submission with all line item statuses.
 */
exports.getSubmissionDetail = async (req, res) => {
  try {
    const submission = await OrderSubmission.findById(req.params.submissionId).lean();
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    // Enrich with live instance statuses
    const instanceIds = submission.lineItems.map(i => i.instanceId).filter(Boolean);
    const instances   = await FlowInstance.find({ _id: { $in: instanceIds } })
      .select('orderIdentifier status activeStep nodeHistory')
      .lean();

    const instanceMap = Object.fromEntries(instances.map(i => [i._id.toString(), i]));

    const enriched = submission.lineItems.map(item => ({
      ...item,
      instance: item.instanceId ? instanceMap[item.instanceId.toString()] : null,
    }));

    res.json({ ...submission, lineItems: enriched });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch submission detail', error: err.message });
  }
};
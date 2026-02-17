// server/controllers/fmsController.js
const FmsTemplate = require('../models/FmsTemplate');
const FmsInstance = require('../models/FmsInstance'); 
const Employee = require('../models/Employee');
const axios = require('axios');
const moment = require('moment');

/**
 * PHASE 1: CREATE NEW FLOW BLUEPRINT
 * Saves the mapping of Google Sheet columns to factory tasks.
 */
exports.createFmsTemplate = async (req, res) => {
  try {
    const template = new FmsTemplate(req.body);
    await template.save();
    res.status(201).json({ message: "FMS Blueprint Synchronized", template });
  } catch (error) {
    res.status(500).json({ message: "Blueprint Creation Failed", error: error.message });
  }
};

/**
 * PHASE 1: FETCH ALL TENANT FLOWS
 */
exports.getTenantTemplates = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const templates = await FmsTemplate.find({ tenantId });
    res.status(200).json(templates);
  } catch (error) {
    res.status(500).json({ message: "Fetch Failed", error: error.message });
  }
};

/**
 * NEW: FETCH LIVE INSTANCES
 * Required for the FmsDashboard 'Live Production Tracker' table.
 */
exports.getTenantInstances = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const instances = await FmsInstance.find({ tenantId }).sort({ createdAt: -1 });
    res.status(200).json(instances);
  } catch (error) {
    res.status(500).json({ message: "Instance Fetch Failed", error: error.message });
  }
};

/**
 * NEW: INITIALIZE FLOW (TRIGGER)
 * This starts the clock for an order. Can be triggered manually or via Sheet.
 */
exports.initializeFlow = async (req, res) => {
  try {
    const { templateId, orderIdentifier, tenantId } = req.body;
    const template = await FmsTemplate.findById(templateId);
    if (!template) return res.status(404).json({ message: "Blueprint not found" });

    // 1. Duplicate Check: Ensure we don't start the same order twice
    const existing = await FmsInstance.findOne({ orderIdentifier, tenantId });
    if (existing) return res.status(200).json({ message: "Order already active", instance: existing });

    // 2. Calculate deadline for Step 1 based on its offset (e.g., +2 hours from now)
    const firstNode = template.nodes.find(n => n.stepIndex === 0) || template.nodes[0];
    const deadline = moment().add(firstNode.offsetValue, firstNode.offsetUnit).toDate();

    const newInstance = new FmsInstance({
      tenantId,
      templateId,
      orderIdentifier,
      steps: template.nodes.map((node) => ({
        nodeName: node.nodeName,
        stepIndex: node.stepIndex,
        // Only the first step gets a deadline initially
        plannedDeadline: node.stepIndex === 0 ? deadline : null, 
        status: 'Pending'
      })),
      currentStepIndex: 0
    });

    await newInstance.save();
    res.status(201).json({ message: "Flow Clock Started", instance: newInstance });
  } catch (error) {
    res.status(500).json({ message: "Initialization Failed", error: error.message });
  }
};

/**
 * NEW: EXECUTE/COMPLETE STEP
 * Marks current step as done, calculates delay, and plans the NEXT step's deadline.
 */
exports.executeStep = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { remarks } = req.body;
    
    const instance = await FmsInstance.findById(instanceId).populate('templateId');
    if (!instance) return res.status(404).json({ message: "Live instance not found" });

    const currentIndex = instance.currentStepIndex;
    const now = new Date();
    const currentStep = instance.steps.find(s => s.stepIndex === currentIndex);

    if (!currentStep) throw new Error("Current step node not found in instance");

    // 1. Mark Current Step as Completed
    currentStep.actualCompletedAt = now;
    currentStep.status = 'Completed';

    // 2. Calculate Delay (if 'now' is past the planned deadline)
    if (currentStep.plannedDeadline && now > currentStep.plannedDeadline) {
      currentStep.delayInMinutes = moment(now).diff(moment(currentStep.plannedDeadline), 'minutes');
    }

    // 3. Chain Logic: Plan the NEXT Step
    const nextIndex = currentIndex + 1;
    const nextNodeTemplate = instance.templateId.nodes.find(n => n.stepIndex === nextIndex);

    if (nextNodeTemplate) {
      // The NEXT deadline is: Completion Time of previous step + Next Step's Offset
      const nextDeadline = moment(now)
        .add(nextNodeTemplate.offsetValue, nextNodeTemplate.offsetUnit)
        .toDate();
      
      const nextStep = instance.steps.find(s => s.stepIndex === nextIndex);
      if (nextStep) {
        nextStep.plannedDeadline = nextDeadline;
        instance.currentStepIndex = nextIndex;
      }
    } else {
      // No more steps found in blueprint
      instance.isFullyCompleted = true;
    }

    await instance.save();
    res.status(200).json({ message: "Step Authorized, Next Step Planned", instance });
  } catch (error) {
    res.status(500).json({ message: "Execution Failed", error: error.message });
  }
};


exports.deleteFmsTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    await FmsTemplate.findByIdAndDelete(templateId);
    
    // Optional: Also delete live instances associated with this template
    await FmsInstance.deleteMany({ templateId });

    res.status(200).json({ message: "Blueprint and associated telemetry purged." });
  } catch (error) {
    res.status(500).json({ message: "Deletion Failed", error: error.message });
  }
};


/**
 * PHASE 3: THE FLOW RUNNER (SCANNER) - UPDATED
 * Scans the Google Sheet for NEW orders and initializes the time-based flow.
 */
exports.syncFmsOrders = async (req, res) => {
    try {
      const { templateId } = req.params;
      const template = await FmsTemplate.findById(templateId);
      if (!template) return res.status(404).json({ message: "Template not found" });
  
      const sheetResponse = await axios.get(template.scriptUrl, {
        params: { operation: 'readSheet', sheetId: template.googleSheetId, tabName: template.tabName }
      });
  
      const rows = sheetResponse.data;
      if (!rows || rows.length === 0) return res.status(200).json({ message: "No rows found in sheet" });
  
      const dispatchLog = [];
      const actualHeaders = Object.keys(rows[0]);
      
      // ID Matching Logic
      const idKey = actualHeaders.find(h => 
        h.toLowerCase() === (template.uniqueIdentifierColumn || '').toLowerCase() || 
        h.toLowerCase() === 'order id' ||
        h.toLowerCase() === 'timestamp'
      ) || actualHeaders[0];
  
      let newOrdersCount = 0;

      for (const row of rows) {
        const orderId = row[idKey]?.toString();
        if (!orderId) continue;

        // 1. Check if Order is already being tracked in FmsInstance
        const existing = await FmsInstance.findOne({ orderIdentifier: orderId, tenantId: template.tenantId });
        if (existing) continue;

        // 2. Initialize Flow Clock for new Orders found in sheet
        const firstNode = template.nodes.find(n => n.stepIndex === 0) || template.nodes[0];
        const deadline = moment().add(firstNode.offsetValue, firstNode.offsetUnit).toDate();

        const newInstance = new FmsInstance({
          tenantId: template.tenantId,
          templateId: template._id,
          orderIdentifier: orderId,
          steps: template.nodes.map((node) => ({
            nodeName: node.nodeName,
            stepIndex: node.stepIndex,
            plannedDeadline: node.stepIndex === 0 ? deadline : null, 
            status: 'Pending'
          })),
          currentStepIndex: 0
        });

        await newInstance.save();
        newOrdersCount++;
        dispatchLog.push({ orderId, status: "Initialized" });
      }
  
      res.status(200).json({ message: "Sync Success", count: newOrdersCount, log: dispatchLog });
    } catch (error) {
      console.error("FMS Sync Crash:", error.message);
      res.status(500).json({ message: "Internal Sync Error", detail: error.message });
    }
  };

/**
 * PHASE 2: DYNAMIC WRITE-BACK ENGINE - PRESERVED
 */
exports.updateSheetStatus = async (templateId, rowId, columnHeader, statusValue) => {
  try {
    const template = await FmsTemplate.findById(templateId);
    if (!template) throw new Error("Template not found for write-back");

    await axios.post(template.scriptUrl, {
      operation: 'updateCell',
      sheetId: template.googleSheetId,
      idValue: rowId,
      header: columnHeader,
      value: statusValue
    });
  } catch (err) {
    console.error("Sheet Write-Back Failed:", err.message);
  }
};
// controllers/settingsController.js
// Company switches and WhatsApp message wording (mounted under /api/config).
const Tenant = require('../models/Tenant');
const { SWITCHES, BY_KEY: SW, effective, valuesOf, hiddenOf, rawHiddenOf } = require('../utils/settingsRegistry');
const { TEMPLATES, BY_KEY: TPL } = require('../utils/notificationRegistry');
const { reasonsOf, DEFAULT_REASONS } = require('../utils/dateChanges');

const isAdmin = (u) => !!u && (u.isSuperAdmin || (Array.isArray(u.roles) && u.roles.includes('Admin')));
// A company that connected its OWN WhatsApp account (its own key) may use its own approved templates;
// companies on the platform's shared account may only switch messages on/off.
const ownApiOf = (t) => !!(t && ((t.superAdmin && t.superAdmin.customWhatsappKey) || (t.whatsappConfig && t.whatsappConfig.apiKey)));
const tenantIdOf = (req) => (req.user && req.user.tenantId) ? String(req.user.tenantId) : null;

// The daily task reminder exists only for companies the platform owner switched it on for
const dailyAlertAllowed = (t) => !!(t && t.superAdmin && t.superAdmin.features && t.superAdmin.features.dailyTaskAlert === true);

// PUT /api/config/settings/daily-alert   body: { enabled, time: 'HH:MM' }
exports.saveDailyAlert = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change this.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const t = await Tenant.findById(id).select('superAdmin.features.dailyTaskAlert companySettings.dailyAlert').lean();
    if (!dailyAlertAllowed(t)) return res.status(403).json({ message: 'The daily task reminder is not switched on for your company. Please ask the platform owner.' });
    const b = req.body || {}, cur = (t.companySettings && t.companySettings.dailyAlert) || {};
    const next = { ...cur };
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') return res.status(400).json({ message: 'Choose on or off.' }); next.enabled = b.enabled; }
    if (b.time !== undefined) {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(b.time))) return res.status(400).json({ message: 'The time must look like 08:30 (24-hour clock).' });
      const [h, m] = String(b.time).split(':'); next.time = `${String(h).padStart(2, '0')}:${m}`;
      // A new time today: allow it to go out today if that time is still to come
      if (next.time !== cur.time) delete next.lastSentOn;
    }
    await Tenant.updateOne({ _id: id }, { $set: { 'companySettings.dailyAlert': next } });
    res.json({ message: 'Saved.', dailyAlert: { available: true, enabled: next.enabled === true, time: next.time || '08:30' } });
  } catch (e) { res.status(500).json({ message: 'Could not save.', error: e.message }); }
};

// POST /api/config/settings/daily-alert/test : send the reminder to the admin's own WhatsApp number now
exports.testDailyAlert = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can do this.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const tenant = await Tenant.findById(id).select('companyName subdomain holidays weekends superAdmin.features.dailyTaskAlert').lean();
    if (!dailyAlertAllowed(tenant)) return res.status(403).json({ message: 'The daily task reminder is not switched on for your company.' });
    const Employee = require('../models/Employee');
    const me = await Employee.findOne({ _id: req.user.id, tenantId: id }).select('name whatsappNumber workOnSunday').lean();
    if (!me || !me.whatsappNumber) return res.status(400).json({ message: 'Your profile has no WhatsApp number.' });
    const A = require('../utils/dailyTaskAlert');
    const lists = await A.collectFor(tenant, me);
    const { notifyTenant } = require('../utils/notify');
    await notifyTenant(id, me.whatsappNumber, { templateName: A.TEMPLATE, variables: A.variablesFor(tenant, me, lists) });
    res.json({ message: 'Sent to your WhatsApp number.', counts: { overdue: lists.overdue.length, today: lists.today.length, tomorrow: lists.tomorrow.length } });
  } catch (e) { res.status(500).json({ message: 'Could not send the test.', error: e.message }); }
};

// GET /api/config/settings/effective  (any signed-in user): the on/off value of every switch
exports.getEffective = async (req, res) => {
  try {
    const id = tenantIdOf(req);
    const tenant = id ? await Tenant.findById(id).select('companySettings.switches superAdmin.features.menuControl').lean() : null;
    res.json({ switches: effective(tenant) });
  } catch (e) { res.status(500).json({ message: 'Could not load settings.', error: e.message }); }
};

// GET /api/config/settings  (Admin): switches the admin may see + WhatsApp messages
exports.getSettings = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can open these settings.' });
    const id = tenantIdOf(req);
    if (!id) return res.json({ switches: [], templates: [] });
    const tenant = await Tenant.findById(id).select('companySettings superAdmin.hiddenSwitches superAdmin.features.menuControl superAdmin.features.dailyTaskAlert superAdmin.customWhatsappKey whatsappConfig').lean();
    const eff = effective(tenant), hidden = hiddenOf(tenant);
    const alertOn = dailyAlertAllowed(tenant);
    const da = (tenant && tenant.companySettings && tenant.companySettings.dailyAlert) || {};
    const saved = (tenant && tenant.companySettings && tenant.companySettings.whatsappTemplates) || {};
    let provider = 'doubletick';
    try { const raw = tenant?.superAdmin?.customWhatsappKey || tenant?.whatsappConfig?.apiKey; if (raw) provider = JSON.parse(raw).provider || 'doubletick'; } catch { /* a plain key = DoubleTick */ }
    res.json({
      provider,
      ownApi: ownApiOf(tenant),
      dateReasons: reasonsOf(tenant),
      dateReasonsAreDefault: !(tenant && tenant.companySettings && Array.isArray(tenant.companySettings.dateChangeReasons) && tenant.companySettings.dateChangeReasons.length),
      switches: SWITCHES.filter((s) => !hidden.includes(s.key)).map((s) => ({ key: s.key, group: s.group, label: s.label, help: s.help, default: s.default, value: eff[s.key] })),
      templates: TEMPLATES.filter((t) => t.key !== 'daily_task_alert' || alertOn).map((t) => ({ ...t, saved: saved[t.key] || null })),
      dailyAlert: { available: alertOn, enabled: alertOn && da.enabled === true, time: da.time || '08:30' },
    });
  } catch (e) { res.status(500).json({ message: 'Could not load settings.', error: e.message }); }
};

// PUT /api/config/settings/switches   body: { 'delegation_doerRevise': false, ... }
exports.saveSwitches = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change these settings.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const tenant = await Tenant.findById(id).select('companySettings superAdmin.hiddenSwitches superAdmin.features.menuControl').lean();
    if (!tenant) return res.status(404).json({ message: 'Company not found.' });
    const hidden = hiddenOf(tenant), next = { ...valuesOf(tenant) };
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!SW[k]) return res.status(400).json({ message: `Unknown setting: ${k}` });
      if (typeof v !== 'boolean') return res.status(400).json({ message: `"${SW[k].label}" must be on or off.` });
      if (hidden.includes(k) && !req.user.isSuperAdmin) return res.status(403).json({ message: `"${SW[k].label}" is controlled by the platform owner.` });
      next[k] = v;
    }
    await Tenant.updateOne({ _id: id }, { $set: { 'companySettings.switches': next } });
    const t2 = await Tenant.findById(id).select('companySettings.switches superAdmin.features.menuControl').lean();
    res.json({ message: 'Saved.', switches: effective(t2) });
  } catch (e) { res.status(500).json({ message: 'Could not save settings.', error: e.message }); }
};

// PUT /api/config/settings/whatsapp-templates/:key  body: { enabled, body, providerTemplate, senderPhoneId }
exports.saveTemplate = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change WhatsApp messages.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const def = TPL[req.params.key];
    if (!def) return res.status(404).json({ message: 'Unknown WhatsApp message.' });
    const b = req.body || {};
    const out = {};
    const tenantNow = await Tenant.findById(id).select('superAdmin.customWhatsappKey whatsappConfig.apiKey').lean();
    if (!ownApiOf(tenantNow) && !req.user.isSuperAdmin) {
      const touches = ['body', 'providerTemplate', 'senderPhoneId', 'variableOrder', 'language'].some((k) => b[k] !== undefined && String(b[k] || '').trim() !== '');
      if (touches) return res.status(403).json({ message: 'Your company uses the shared WhatsApp account of the platform, so only the on/off switch can be changed. To use your own templates, connect your own WhatsApp account first.' });
    }
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') return res.status(400).json({ message: '"enabled" must be on or off.' }); out.enabled = b.enabled; }
    if (b.body !== undefined) {
      const body = String(b.body || '').trim();
      if (body.length > 1500) return res.status(400).json({ message: 'The message is too long (1500 characters at most).' });
      const bad = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])).find((n) => n < 1 || n > def.variables.length);
      if (bad) return res.status(400).json({ message: `{{${bad}}} does not exist. This message has ${def.variables.length} variables: ${def.variables.map((v, i) => `{{${i + 1}}} ${v}`).join(', ')}.` });
      out.body = body;
    }
    if (b.providerTemplate !== undefined) {
      const n = String(b.providerTemplate || '').trim();
      if (n && !/^[A-Za-z0-9_]{1,80}$/.test(n)) return res.status(400).json({ message: 'The approved template name can only have letters, numbers and underscores.' });
      out.providerTemplate = n;
    }
    if (b.language !== undefined) {
      const n = String(b.language || '').trim();
      if (n && !/^[A-Za-z]{2,3}(_[A-Za-z]{2})?$/.test(n)) return res.status(400).json({ message: 'The template language must look like en, hi or en_US.' });
      out.language = n;
    }
    if (b.variableOrder !== undefined) {
      const n = String(b.variableOrder || '').replace(/\s+/g, '');
      if (n) {
        const nums = n.split(',').map(Number);
        if (nums.some((x) => !Number.isInteger(x) || x < 1 || x > def.variables.length)) return res.status(400).json({ message: `The order can only use numbers 1 to ${def.variables.length}, separated by commas, for example 2,1,3.` });
        if (nums.length > 20) return res.status(400).json({ message: 'The order is too long.' });
      }
      out.variableOrder = n;
    }
    if (b.senderPhoneId !== undefined) {
      const n = String(b.senderPhoneId || '').trim();
      if (n && !/^[0-9]{1,20}$/.test(n)) return res.status(400).json({ message: 'The sender number ID can only have digits.' });
      out.senderPhoneId = n;
    }
    const tenant = await Tenant.findById(id).select('companySettings.whatsappTemplates').lean();
    const all = { ...((tenant && tenant.companySettings && tenant.companySettings.whatsappTemplates) || {}) };
    const merged = { ...(all[def.key] || {}), ...out };
    for (const k of Object.keys(merged)) if (merged[k] === '' || merged[k] === undefined) delete merged[k];
    if (Object.keys(merged).length) all[def.key] = merged; else delete all[def.key];
    await Tenant.updateOne({ _id: id }, { $set: { 'companySettings.whatsappTemplates': all } });
    res.json({ message: 'Saved.', saved: all[def.key] || null });
  } catch (e) { res.status(500).json({ message: 'Could not save the message.', error: e.message }); }
};

// DELETE /api/config/settings/whatsapp-templates/:key : back to the standard message
exports.resetTemplate = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change WhatsApp messages.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    if (!TPL[req.params.key]) return res.status(404).json({ message: 'Unknown WhatsApp message.' });
    await Tenant.updateOne({ _id: id }, { $unset: { [`companySettings.whatsappTemplates.${req.params.key}`]: '' } });
    res.json({ message: 'Back to the standard message.' });
  } catch (e) { res.status(500).json({ message: 'Could not reset the message.', error: e.message }); }
};

// ── Platform owner: which switches a company admin may see ─────────────────────
exports.getSwitchAccess = async (req, res) => {
  try {
    const t = await Tenant.findById(req.params.tenantId).select('superAdmin.hiddenSwitches superAdmin.features.menuControl companySettings.switches').lean();
    if (!t) return res.status(404).json({ message: 'Tenant not found' });
    const hidden = rawHiddenOf(t), eff = effective(t);
    res.json({ switches: SWITCHES.map((s) => ({ key: s.key, group: s.group, label: s.label, value: eff[s.key], visibleToAdmin: !hidden.includes(s.key) })) });
  } catch (e) { res.status(500).json({ message: 'Failed to load', error: e.message }); }
};
exports.setSwitchAccess = async (req, res) => {
  try {
    const { hidden } = req.body || {};
    if (!Array.isArray(hidden) || hidden.some((k) => !SW[k])) return res.status(400).json({ message: '"hidden" must be a list of known setting keys.' });
    const r = await Tenant.updateOne({ _id: req.params.tenantId }, { $set: { 'superAdmin.hiddenSwitches': [...new Set(hidden)] } });
    if (!r.matchedCount && !r.n) return res.status(404).json({ message: 'Tenant not found' });
    res.json({ message: 'Saved.', hidden: [...new Set(hidden)] });
  } catch (e) { res.status(500).json({ message: 'Failed to save', error: e.message }); }
};

// PUT /api/config/settings/date-reasons  body: { reasons: ['Waiting for client', ...] }  (empty = back to the standard list)
exports.saveDateReasons = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change this list.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const raw = Array.isArray(req.body && req.body.reasons) ? req.body.reasons : null;
    if (!raw) return res.status(400).json({ message: 'Send the list as "reasons".' });
    const list = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
    if (list.length > 20) return res.status(400).json({ message: 'At most 20 reasons.' });
    if (list.some((x) => x.length > 60)) return res.status(400).json({ message: 'Each reason can have 60 characters at most.' });
    if (list.length && !list.includes('Other')) list.push('Other');
    await Tenant.updateOne({ _id: id }, { $set: { 'companySettings.dateChangeReasons': list } });
    res.json({ message: 'Saved.', reasons: list.length ? list : DEFAULT_REASONS });
  } catch (e) { res.status(500).json({ message: 'Could not save the reasons.', error: e.message }); }
};

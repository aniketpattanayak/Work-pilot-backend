// controllers/settingsController.js
// Company switches and WhatsApp message wording (mounted under /api/config).
const Tenant = require('../models/Tenant');
const { SWITCHES, BY_KEY: SW, effective, valuesOf, hiddenOf } = require('../utils/settingsRegistry');
const { TEMPLATES, BY_KEY: TPL } = require('../utils/notificationRegistry');

const isAdmin = (u) => !!u && (u.isSuperAdmin || (Array.isArray(u.roles) && u.roles.includes('Admin')));
const tenantIdOf = (req) => (req.user && req.user.tenantId) ? String(req.user.tenantId) : null;

// GET /api/config/settings/effective  (any signed-in user): the on/off value of every switch
exports.getEffective = async (req, res) => {
  try {
    const id = tenantIdOf(req);
    const tenant = id ? await Tenant.findById(id).select('companySettings.switches').lean() : null;
    res.json({ switches: effective(tenant) });
  } catch (e) { res.status(500).json({ message: 'Could not load settings.', error: e.message }); }
};

// GET /api/config/settings  (Admin): switches the admin may see + WhatsApp messages
exports.getSettings = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can open these settings.' });
    const id = tenantIdOf(req);
    if (!id) return res.json({ switches: [], templates: [] });
    const tenant = await Tenant.findById(id).select('companySettings superAdmin.hiddenSwitches superAdmin.customWhatsappKey whatsappConfig').lean();
    const eff = effective(tenant), hidden = hiddenOf(tenant);
    const saved = (tenant && tenant.companySettings && tenant.companySettings.whatsappTemplates) || {};
    let provider = 'doubletick';
    try { const raw = tenant?.superAdmin?.customWhatsappKey || tenant?.whatsappConfig?.apiKey; if (raw) provider = JSON.parse(raw).provider || 'doubletick'; } catch { /* a plain key = DoubleTick */ }
    res.json({
      provider,
      switches: SWITCHES.filter((s) => !hidden.includes(s.key)).map((s) => ({ key: s.key, group: s.group, label: s.label, help: s.help, default: s.default, value: eff[s.key] })),
      templates: TEMPLATES.map((t) => ({ ...t, saved: saved[t.key] || null })),
    });
  } catch (e) { res.status(500).json({ message: 'Could not load settings.', error: e.message }); }
};

// PUT /api/config/settings/switches   body: { 'delegation_doerRevise': false, ... }
exports.saveSwitches = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change these settings.' });
    const id = tenantIdOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const tenant = await Tenant.findById(id).select('companySettings superAdmin.hiddenSwitches').lean();
    if (!tenant) return res.status(404).json({ message: 'Company not found.' });
    const hidden = hiddenOf(tenant), next = { ...valuesOf(tenant) };
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!SW[k]) return res.status(400).json({ message: `Unknown setting: ${k}` });
      if (typeof v !== 'boolean') return res.status(400).json({ message: `"${SW[k].label}" must be on or off.` });
      if (hidden.includes(k) && !req.user.isSuperAdmin) return res.status(403).json({ message: `"${SW[k].label}" is controlled by the platform owner.` });
      next[k] = v;
    }
    await Tenant.updateOne({ _id: id }, { $set: { 'companySettings.switches': next } });
    const t2 = await Tenant.findById(id).select('companySettings.switches').lean();
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
    const t = await Tenant.findById(req.params.tenantId).select('superAdmin.hiddenSwitches companySettings.switches').lean();
    if (!t) return res.status(404).json({ message: 'Tenant not found' });
    const hidden = hiddenOf(t), eff = effective(t);
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

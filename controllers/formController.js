// controllers/formController.js  (mounted under /api/config)
// Form designer: the layout of every form (rename, hide, required, order), lists that dropdowns
// can be linked to, and uploads for "file" fields.
const path = require('path');
const fs = require('fs');
const Tenant = require('../models/Tenant');
const { FORMS, resolveOrder, effectiveFields } = require('../utils/formRegistry');
const { configModel } = require('../utils/customFields');

const isAdmin = (u) => !!u && (u.isSuperAdmin || (Array.isArray(u.roles) && u.roles.includes('Admin')));
const tenantOf = (req) => (req.user && req.user.tenantId) ? String(req.user.tenantId) : null;
const clean = (s, n) => String(s === undefined || s === null ? '' : s).trim().slice(0, n);

async function tenantDoc(req, sel) {
  const id = tenantOf(req);
  return id ? Tenant.findById(id).select(sel).lean() : null;
}

// GET /api/config/forms  (Admin): the list of forms for the designer
exports.listForms = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can open the form designer.' });
    res.json({ forms: Object.entries(FORMS).map(([key, f]) => ({ key, label: f.label, entity: f.entity })) });
  } catch (e) { res.status(500).json({ message: 'Could not load the forms.', error: e.message }); }
};

// GET /api/config/forms/:form  (any signed-in user): what the form should look like for this company
// ?all=1 (admin only) also lists switched-off custom fields, for the designer.
exports.getForm = async (req, res) => {
  try {
    const key = String(req.params.form || '');
    const form = FORMS[key];
    if (!form) return res.status(404).json({ message: 'Unknown form.' });
    const tid = tenantOf(req);
    const t = await tenantDoc(req, 'companySettings.formLayouts');
    const layout = (t && t.companySettings && t.companySettings.formLayouts && t.companySettings.formLayouts[key]) || {};
    const showAll = req.query.all === '1' && isAdmin(req.user);
    const q = { tenantId: tid, entity: form.entity };
    if (!showAll) q.isActive = true;
    const custom = tid ? await configModel(req, 'CustomFieldDefinition').find(q).sort({ order: 1, createdAt: 1 }).lean() : [];
    const activeCustom = custom.filter((d) => d.isActive !== false);
    res.json({
      form: key, label: form.label, entity: form.entity,
      builtin: effectiveFields(key, layout),
      custom,
      order: resolveOrder(key, showAll ? custom : activeCustom, layout.order),
    });
  } catch (e) { res.status(500).json({ message: 'Could not load the form.', error: e.message }); }
};

// PUT /api/config/forms/:form  (Admin)   body: { fields: { key: { label, required, hidden } }, order: [keys] }
exports.saveForm = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change forms.' });
    const key = String(req.params.form || '');
    const form = FORMS[key];
    if (!form) return res.status(404).json({ message: 'Unknown form.' });
    const id = tenantOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const body = req.body || {};
    const out = { fields: {}, order: [] };
    const incoming = (body.fields && typeof body.fields === 'object') ? body.fields : {};
    for (const f of form.fields) {
      if (f.slot) continue;
      const s = incoming[f.key]; if (!s || typeof s !== 'object') continue;
      const keep = {};
      if (typeof s.label === 'string' && s.label.trim() && s.label.trim() !== f.label) keep.label = s.label.trim().slice(0, 60);
      if (s.hidden === true) {
        if (!f.canHide) return res.status(400).json({ message: `"${f.label}" is needed by the system and cannot be hidden.` });
        keep.hidden = true;
      }
      if (typeof s.required === 'boolean' && s.required !== f.required) {
        if (!f.canRequire) return res.status(400).json({ message: `"${f.label}" is always required.` });
        keep.required = s.required;
      }
      if (Object.keys(keep).length) out.fields[f.key] = keep;
    }
    const customDefs = await configModel(req, 'CustomFieldDefinition').find({ tenantId: id, entity: form.entity }).select('fieldName').lean();
    const valid = new Set([...form.fields.filter((f) => !f.slot).map((f) => f.key), ...customDefs.map((d) => `cf:${d.fieldName}`)]);
    if (Array.isArray(body.order)) out.order = body.order.filter((k, i, a) => valid.has(k) && a.indexOf(k) === i);
    await Tenant.updateOne({ _id: id }, { $set: { [`companySettings.formLayouts.${key}`]: out } });
    res.json({ message: 'Saved.', form: key });
  } catch (e) { res.status(500).json({ message: 'Could not save the form.', error: e.message }); }
};

// DELETE /api/config/forms/:form  (Admin): back to the standard layout (custom fields are kept)
exports.resetForm = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change forms.' });
    const key = String(req.params.form || '');
    if (!FORMS[key]) return res.status(404).json({ message: 'Unknown form.' });
    const id = tenantOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    await Tenant.updateOne({ _id: id }, { $unset: { [`companySettings.formLayouts.${key}`]: '' } });
    res.json({ message: 'Back to the standard form.' });
  } catch (e) { res.status(500).json({ message: 'Could not reset the form.', error: e.message }); }
};

// ── Lists a dropdown can be linked to ───────────────────────────────────────────
// GET /api/config/master-lists
exports.getMasterLists = async (req, res) => {
  try {
    const t = await tenantDoc(req, 'companySettings.masterLists');
    res.json({ lists: (t && t.companySettings && t.companySettings.masterLists) || [] });
  } catch (e) { res.status(500).json({ message: 'Could not load the lists.', error: e.message }); }
};

// PUT /api/config/master-lists  (Admin)  body: { lists: [{ key?, label, items: [text] }] }
exports.saveMasterLists = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an admin can change lists.' });
    const id = tenantOf(req); if (!id) return res.status(400).json({ message: 'No company selected.' });
    const lists = Array.isArray(req.body && req.body.lists) ? req.body.lists : null;
    if (!lists) return res.status(400).json({ message: 'Send the lists.' });
    if (lists.length > 30) return res.status(400).json({ message: 'At most 30 lists.' });
    const seen = new Set(); const out = [];
    for (const l of lists) {
      const label = clean(l && l.label, 60);
      if (!label) return res.status(400).json({ message: 'Every list needs a name.' });
      let key = clean(l.key, 40) || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      if (!/^[a-z0-9_]{1,40}$/.test(key)) return res.status(400).json({ message: `"${label}": please use a simpler name.` });
      if (seen.has(key)) return res.status(400).json({ message: `"${label}" is listed twice.` });
      seen.add(key);
      const items = [...new Set((Array.isArray(l.items) ? l.items : String(l.items || '').split('\n')).map((x) => clean(x, 100)).filter(Boolean))].slice(0, 1000);
      out.push({ key, label, items });
    }
    await Tenant.updateOne({ _id: id }, { $set: { 'companySettings.masterLists': out } });
    res.json({ message: 'Saved.', lists: out });
  } catch (e) { res.status(500).json({ message: 'Could not save the lists.', error: e.message }); }
};

// GET /api/config/lookup/:source  (any signed-in user): the choices of a linked dropdown
exports.getLookup = async (req, res) => {
  try {
    const source = String(req.params.source || '');
    const tid = tenantOf(req);
    if (!tid) return res.json({ options: [] });
    let names = [];
    if (source === 'employees') {
      const Employee = require('../utils/customFields').configModel(req, 'Employee');
      const rows = await Employee.find({ tenantId: tid }).select('name').sort({ name: 1 }).limit(2000).lean();
      names = rows.map((r) => r.name).filter(Boolean);
    } else if (source === 'sectors' || source === 'locations') {
      const t = await tenantDoc(req, 'sectors locations');
      names = (t && t[source]) || [];
    } else if (source === 'roles') {
      names = ['Admin', 'Assigner', 'Doer', 'Coordinator', 'Viewer'];
    } else if (/^master:[a-z0-9_]{1,40}$/.test(source)) {
      const t = await tenantDoc(req, 'companySettings.masterLists');
      const list = ((t && t.companySettings && t.companySettings.masterLists) || []).find((m) => m.key === source.slice(7));
      names = (list && list.items) || [];
    } else return res.status(404).json({ message: 'Unknown list.' });
    res.json({ options: names.map((n) => ({ value: n, label: n })) });
  } catch (e) { res.status(500).json({ message: 'Could not load the choices.', error: e.message }); }
};

// ── File fields ─────────────────────────────────────────────────────────────────
const KIND_EXT = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp'],
  video: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.3gp'],
  pdf: ['.pdf'],
  document: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.txt', '.odt', '.ods'],
  audio: ['.mp3', '.wav', '.m4a', '.ogg', '.aac'],
};
// POST /api/config/field-upload   multipart: entity, fieldName, file   -> { file: { name, url, type } }
// The company-wide size limit is applied by the uploader; the field's own type / size rules here.
exports.uploadFieldFile = async (req, res) => {
  const f = req.file;
  const drop = () => { try { if (f && f.path) fs.unlinkSync(f.path); } catch (e) { /* best effort */ } };
  try {
    if (!f) return res.status(400).json({ message: 'Choose a file.' });
    const entity = clean(req.body && req.body.entity, 20), fieldName = clean(req.body && req.body.fieldName, 40);
    const tid = tenantOf(req);
    const def = tid ? await configModel(req, 'CustomFieldDefinition').findOne({ tenantId: tid, entity, fieldName, fieldType: 'file', isActive: true }).lean() : null;
    if (!def) { drop(); return res.status(404).json({ message: 'This file field does not exist.' }); }
    const cfg = def.config || {};
    const ext = path.extname(f.originalname || '').toLowerCase();
    const accept = Array.isArray(cfg.accept) && cfg.accept.length ? cfg.accept : ['any'];
    if (!accept.includes('any') && !accept.some((k) => (KIND_EXT[k] || []).includes(ext))) {
      drop(); return res.status(400).json({ message: `"${def.fieldLabel}" accepts only: ${accept.join(', ')}.` });
    }
    const maxMb = Number(cfg.maxMb) || 10;
    if (f.size && f.size > maxMb * 1024 * 1024) { drop(); return res.status(400).json({ message: `"${def.fieldLabel}": the file is larger than ${maxMb} MB.` }); }
    res.json({ file: { name: String(f.originalname || 'file').slice(0, 150), url: f.location || f.path || '', type: ext.replace('.', '') } });
  } catch (e) { drop(); res.status(500).json({ message: 'Could not upload the file.', error: e.message }); }
};

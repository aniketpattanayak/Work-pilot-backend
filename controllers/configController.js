// controllers/configController.js
// Company settings that change how screens look: custom fields and saved table columns.
const mongoose = require('mongoose');
const { ENTITY_MODEL, FIELD_NAME_RE, configModel } = require('../utils/customFields');

const TABLE_KEY_RE = /^[a-z0-9_]{1,50}$/;
const MAX_FIELDS_PER_ENTITY = 30;
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'];

const isAdmin = (u) => !!u && (u.isSuperAdmin || (Array.isArray(u.roles) && u.roles.includes('Admin')));
const tenantOf = (req) => (req.user && req.user.tenantId) ? String(req.user.tenantId) : null;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);

function entityOrFail(req, res) {
  const entity = String(req.params.entity || '').toLowerCase();
  if (!ENTITY_MODEL[entity]) { res.status(400).json({ message: 'Unknown entity. Use employee, delegation or task.' }); return null; }
  return entity;
}

// ── GET /api/config/fields/:entity ─────────────────────────────────────────────
exports.getFields = async (req, res) => {
  try {
    const entity = entityOrFail(req, res); if (!entity) return;
    const tenantId = tenantOf(req);
    if (!tenantId) return res.json({ entity, fields: [] }); // e.g. platform super admin: no company
    const q = { tenantId, entity };
    // Switched-off fields are only listed for admins who ask for them (the setup screen).
    if (!(req.query.includeInactive === '1' && isAdmin(req.user))) q.isActive = true;
    const fields = await configModel(req, 'CustomFieldDefinition').find(q).sort({ order: 1, createdAt: 1 }).lean();
    res.json({ entity, fields });
  } catch (err) {
    res.status(500).json({ message: 'Could not load custom fields.', error: err.message });
  }
};

// ── POST /api/config/fields/:entity  (Admin) ───────────────────────────────────
// Body: { fields: [ {fieldName?, fieldLabel, fieldType, options, isRequired, isActive, order} ] }
// or a single field object. Existing fields (matched by fieldName) are updated, new ones are added.
exports.saveFields = async (req, res) => {
  try {
    const entity = entityOrFail(req, res); if (!entity) return;
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an Admin can change custom fields.' });
    const tenantId = tenantOf(req);
    if (!tenantId) return res.status(400).json({ message: 'No company on this account.' });

    const body = req.body || {};
    const list = Array.isArray(body.fields) ? body.fields : (body.fieldLabel || body.fieldName ? [body] : []);
    if (!list.length) return res.status(400).json({ message: 'Send at least one field.' });

    const Def = configModel(req, 'CustomFieldDefinition');
    const existing = await Def.find({ tenantId, entity }).lean();
    const byName = new Map(existing.map((d) => [d.fieldName, d]));
    const errors = [];
    const ops = [];
    let newCount = 0;
    const seen = new Set();

    list.forEach((f, i) => {
      const where = `Field ${i + 1}`;
      const label = String(f.fieldLabel || '').trim().slice(0, 80);
      const name = String(f.fieldName || slug(label)).trim();
      if (!label) return errors.push(`${where}: a label is required.`);
      if (!FIELD_NAME_RE.test(name)) return errors.push(`${where}: key must be lowercase letters, numbers or _ and start with a letter.`);
      if (seen.has(name)) return errors.push(`${where}: "${name}" is listed twice.`);
      seen.add(name);
      const prev = byName.get(name);
      const type = f.fieldType || (prev && prev.fieldType) || 'text';
      if (!FIELD_TYPES.includes(type)) return errors.push(`${where}: unknown type "${type}".`);
      if (prev && prev.fieldType !== type) return errors.push(`${where}: the type of "${name}" cannot change once created. Add a new field instead.`);
      let options = Array.isArray(f.options) ? f.options : (prev ? prev.options : []);
      options = [...new Set(options.map((o) => String(o).trim().slice(0, 100)).filter(Boolean))].slice(0, 50);
      if (type === 'select' && options.length === 0) return errors.push(`${where}: a dropdown needs at least one option.`);
      if (type !== 'select') options = [];
      const set = {
        fieldLabel: label, fieldType: type, options,
        isRequired: f.isRequired !== undefined ? !!f.isRequired : !!(prev && prev.isRequired),
        isActive:   f.isActive   !== undefined ? !!f.isActive   : (prev ? prev.isActive : true),
        order: Number.isFinite(Number(f.order)) ? Number(f.order) : (prev ? prev.order : existing.length + newCount),
      };
      if (!prev) newCount += 1;
      ops.push({ updateOne: { filter: { tenantId, entity, fieldName: name }, update: { $set: set, $setOnInsert: { tenantId, entity, fieldName: name } }, upsert: true } });
    });

    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    if (existing.length + newCount > MAX_FIELDS_PER_ENTITY) {
      return res.status(400).json({ message: `A company can have at most ${MAX_FIELDS_PER_ENTITY} custom fields per screen.` });
    }
    await Def.bulkWrite(ops);
    const fields = await Def.find({ tenantId, entity }).sort({ order: 1, createdAt: 1 }).lean();
    res.json({ message: 'Custom fields saved.', entity, fields });
  } catch (err) {
    res.status(500).json({ message: 'Could not save custom fields.', error: err.message });
  }
};

// ── GET /api/config/table-preferences/:tableKey ────────────────────────────────
// Own saved layout first, then the company default, otherwise an empty layout
// (the screen then shows its normal built-in columns).
exports.getTablePreference = async (req, res) => {
  try {
    const tableKey = String(req.params.tableKey || '');
    if (!TABLE_KEY_RE.test(tableKey)) return res.status(400).json({ message: 'Invalid table key.' });
    const tenantId = tenantOf(req);
    const empty = { tableKey, columns: [], scope: 'default', isDefault: true };
    if (!tenantId) return res.json(empty);
    const Pref = configModel(req, 'TablePreference');
    const own = mongoose.Types.ObjectId.isValid(String(req.user.id || ''))
      ? await Pref.findOne({ tenantId, userId: req.user.id, tableKey }).lean() : null;
    if (own) return res.json({ tableKey, columns: own.columns || [], scope: 'user', isDefault: false });
    const company = await Pref.findOne({ tenantId, userId: null, tableKey }).lean();
    if (company) return res.json({ tableKey, columns: company.columns || [], scope: 'company', isDefault: false });
    res.json(empty);
  } catch (err) {
    res.status(500).json({ message: 'Could not load table preferences.', error: err.message });
  }
};

// ── POST /api/config/table-preferences/:tableKey ───────────────────────────────
// Body: { columns: [{key,label,isVisible,order,width}], scope?: 'user' | 'company' }
exports.saveTablePreference = async (req, res) => {
  try {
    const tableKey = String(req.params.tableKey || '');
    if (!TABLE_KEY_RE.test(tableKey)) return res.status(400).json({ message: 'Invalid table key.' });
    const tenantId = tenantOf(req);
    if (!tenantId) return res.status(400).json({ message: 'No company on this account.' });
    const { columns, scope } = req.body || {};
    if (!Array.isArray(columns) || columns.length > 100) return res.status(400).json({ message: 'columns must be a list of up to 100 items.' });

    const seen = new Set();
    const clean = [];
    columns.forEach((c, i) => {
      const key = c && typeof c.key === 'string' ? c.key.trim().slice(0, 80) : '';
      if (!key || seen.has(key)) return;
      seen.add(key);
      const col = { key, isVisible: c.isVisible !== false, order: Number.isFinite(Number(c.order)) ? Number(c.order) : i };
      if (typeof c.label === 'string') col.label = c.label.slice(0, 80);
      const w = Number(c.width);
      if (Number.isFinite(w) && w >= 40 && w <= 800) col.width = w;
      clean.push(col);
    });

    let userId = mongoose.Types.ObjectId.isValid(String(req.user.id || '')) ? req.user.id : null;
    if (scope === 'company') {
      if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only an Admin can set the company default.' });
      userId = null;
    } else if (!userId) {
      return res.status(400).json({ message: 'Cannot save a personal layout for this account.' });
    }
    const pref = await configModel(req, 'TablePreference').findOneAndUpdate(
      { tenantId, userId, tableKey },
      { $set: { columns: clean }, $setOnInsert: { tenantId, userId, tableKey } },
      { upsert: true, new: true }
    ).lean();
    res.json({ message: 'Saved.', tableKey, columns: pref.columns, scope: userId ? 'user' : 'company', isDefault: false });
  } catch (err) {
    res.status(500).json({ message: 'Could not save table preferences.', error: err.message });
  }
};

// ── DELETE /api/config/table-preferences/:tableKey  ("Reset to default") ───────
exports.resetTablePreference = async (req, res) => {
  try {
    const tableKey = String(req.params.tableKey || '');
    if (!TABLE_KEY_RE.test(tableKey)) return res.status(400).json({ message: 'Invalid table key.' });
    const tenantId = tenantOf(req);
    if (!tenantId) return res.json({ message: 'Nothing to reset.' });
    const company = req.query.scope === 'company';
    if (company && !isAdmin(req.user)) return res.status(403).json({ message: 'Only an Admin can reset the company default.' });
    await configModel(req, 'TablePreference').deleteOne({ tenantId, userId: company ? null : req.user.id, tableKey });
    res.json({ message: 'Reset to default.', tableKey });
  } catch (err) {
    res.status(500).json({ message: 'Could not reset table preferences.', error: err.message });
  }
};

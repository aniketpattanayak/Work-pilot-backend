// utils/customFields.js
// Helpers for tenant-defined custom fields. Everything here is defensive: a company with no
// custom fields (or a record saved before they existed) behaves exactly as before.
const mongoose = require('mongoose');

const ENTITY_MODEL = { employee: 'Employee', delegation: 'DelegationTask', task: 'ChecklistTask', subtask: 'DelegationTask', ticket: 'Ticket', leave: 'LeaveRequest', personal: 'PersonalTask' };
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TEXT = 500;

function safeModel(db, name, fallback) {
  if (!db) return fallback;
  try { return db.model(name); } catch (e) { return fallback; }
}

// The model of `name` on this request's tenant database (or the shared one).
function configModel(req, name) {
  return safeModel(req && req.db, name, require(`../models/${name}`));
}

// Active definitions for the caller's company. Never throws: on any problem returns [].
async function loadActiveDefs(req, entity, tenantId) {
  try {
    const tid = tenantId || (req.user && req.user.tenantId);
    if (!tid || !mongoose.Types.ObjectId.isValid(String(tid))) return [];
    return await configModel(req, 'CustomFieldDefinition')
      .find({ tenantId: tid, entity, isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
  } catch (e) {
    console.error('[CustomFields] could not load definitions:', e.message);
    return [];
  }
}

// Accept an object, or a JSON string (multipart forms send strings). Anything else -> {}.
function parseInput(raw) {
  if (raw === undefined || raw === null) return null; // "not sent"
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return {}; } }
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// Turns one raw value into the stored value for its field type.
function coerce(def, raw) {
  if (isEmpty(raw)) return { value: null };
  switch (def.fieldType) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? { value: n } : { error: `"${def.fieldLabel}" must be a number.` };
    }
    case 'date': {
      const s = String(raw).trim().slice(0, 10);
      const d = new Date(s + 'T00:00:00.000Z');
      return (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s)
        ? { value: s } : { error: `"${def.fieldLabel}" must be a valid date.` };
    }
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return { value: true };
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return { value: false };
      return { error: `"${def.fieldLabel}" must be yes or no.` };
    }
    case 'select': {
      const s = String(raw);
      return (def.options || []).includes(s) ? { value: s } : { error: `"${def.fieldLabel}": pick one of the listed options.` };
    }
    case 'textarea':
      return { value: String(raw).trim().slice(0, 2000) };
    case 'multiselect': {
      const arr = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim()).filter(Boolean);
      const bad = arr.find((x) => !(def.options || []).includes(x));
      if (bad) return { error: `"${def.fieldLabel}": "${bad.slice(0, 40)}" is not one of the listed options.` };
      return { value: [...new Set(arr)].slice(0, 50) };
    }
    case 'lookup': {
      // The choices come from live data (employees, sectors, ...). Accept text; the screen only offers real choices.
      const multi = !!(def.config && def.config.multiple);
      if (multi) { const arr = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim().slice(0, 200)).filter(Boolean); return { value: [...new Set(arr)].slice(0, 50) }; }
      return { value: String(Array.isArray(raw) ? raw[0] : raw).trim().slice(0, 200) };
    }
    case 'file': {
      const arr = Array.isArray(raw) ? raw : [raw];
      const max = Math.max(1, Math.min(10, Number(def.config && def.config.maxFiles) || (def.config && def.config.multiple ? 5 : 1)));
      const files = [];
      for (const f of arr) {
        const url = f && typeof f === 'object' ? String(f.url || '') : String(f || '');
        if (!url) continue;
        if (!(/^https?:\/\//i.test(url) || url.startsWith('/uploads/'))) return { error: `"${def.fieldLabel}": a file link is not valid.` };
        files.push({ name: String((f && f.name) || url.split('/').pop() || 'file').slice(0, 150), url: url.slice(0, 1000), type: String((f && f.type) || '').slice(0, 60) });
      }
      if (files.length > max) return { error: `"${def.fieldLabel}": at most ${max} file(s).` };
      return { value: files };
    }
    case 'formula': {
      // Worked out by the screen from the other fields; stored so lists and reports can show it.
      if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { value: null };
      return { value: String(raw).slice(0, 500) };
    }
    default:
      return { value: String(raw).trim().slice(0, MAX_TEXT) };
  }
}

/**
 * Validates what the browser sent against the company's active definitions.
 *  - Unknown or switched-off fields are ignored (never stored).
 *  - create:  every required field must have a value.
 *  - update:  only fields that were sent are checked, so older records stay editable.
 * Returns { values: {name: value|null}, errors: [] }. `values` only has keys that were sent
 * (null = clear it). `sent` is false when the request carried no customFields at all.
 */
function cleanCustomFields(defs, rawInput, { mode } = { mode: 'update' }) {
  const input = parseInput(rawInput);
  const sent = input !== null;
  const src = input || {};
  const values = {};
  const errors = [];
  for (const def of defs || []) {
    const has = Object.prototype.hasOwnProperty.call(src, def.fieldName);
    if (!has && mode !== 'create') continue;
    const { value, error } = coerce(def, has ? src[def.fieldName] : null);
    if (error) { errors.push(error); continue; }
    const emptyList = Array.isArray(value) && value.length === 0;
    if (def.isRequired && def.fieldType !== 'formula' && (value === null || value === undefined || emptyList)) { errors.push(`"${def.fieldLabel}" is required.`); continue; }
    if (has || value !== null) values[def.fieldName] = value;
  }
  return { values, errors, sent };
}

// One call for a controller: validate what the form sent for this entity.
async function validateForEntity(req, entity, rawInput, mode, tenantId) {
  const defs = await loadActiveDefs(req, entity, tenantId);
  return cleanCustomFields(defs, rawInput, { mode });
}

module.exports = { validateForEntity, ENTITY_MODEL, FIELD_NAME_RE, configModel, loadActiveDefs, cleanCustomFields, coerce, parseInput };

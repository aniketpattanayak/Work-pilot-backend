// utils/customFields.js
// Helpers for tenant-defined custom fields. Everything here is defensive: a company with no
// custom fields (or a record saved before they existed) behaves exactly as before.
const mongoose = require('mongoose');

const ENTITY_MODEL = { employee: 'Employee', delegation: 'DelegationTask', task: 'ChecklistTask' };
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
    if (def.isRequired && (value === null || value === undefined)) { errors.push(`"${def.fieldLabel}" is required.`); continue; }
    if (has || value !== null) values[def.fieldName] = value;
  }
  return { values, errors, sent };
}

module.exports = { ENTITY_MODEL, FIELD_NAME_RE, configModel, loadActiveDefs, cleanCustomFields, coerce, parseInput };

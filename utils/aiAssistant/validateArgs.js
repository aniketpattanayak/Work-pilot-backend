// A small, deliberately limited JSON-schema-subset validator for AI assistant
// tool arguments. Every tool call - whether it executes immediately (a
// read-only lookup) or gets staged for confirmation (a write) - must pass this
// before anything happens with it. Previously nothing validated the model's
// input at all: a model (or a successful prompt injection) could send a
// non-string title, an oversized string, an unknown extra field, or simply
// omit a required field, and it would be sent straight into a real HTTP call.
//
// Only the shapes actually used by utils/aiAssistant/tools.js are supported -
// this is not a general JSON-schema implementation.
function validateToolArgs(schema, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!schema || schema.type !== 'object') return null;

  const props = schema.properties || {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(a)) {
      if (!(key in props)) return `unexpected argument "${key}"`;
    }
  }

  for (const key of schema.required || []) {
    const v = a[key];
    if (v === undefined || v === null || v === '') return `missing required argument "${key}"`;
  }

  for (const [key, propSchema] of Object.entries(props)) {
    const v = a[key];
    if (v === undefined) continue;
    if (propSchema.type === 'string') {
      if (typeof v !== 'string') return `"${key}" must be a string`;
      if (propSchema.minLength !== undefined && v.length < propSchema.minLength) return `"${key}" is too short`;
      if (propSchema.maxLength !== undefined && v.length > propSchema.maxLength) return `"${key}" is too long (max ${propSchema.maxLength} characters)`;
      if (propSchema.enum && !propSchema.enum.includes(v)) return `"${key}" must be one of: ${propSchema.enum.join(', ')}`;
    } else if (propSchema.type === 'number') {
      if (typeof v !== 'number' || Number.isNaN(v)) return `"${key}" must be a number`;
    } else if (propSchema.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${key}" must be true or false`;
    }
  }
  return null; // valid
}

module.exports = { validateToolArgs };

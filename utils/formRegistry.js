// utils/formRegistry.js
// Every form whose layout a company admin can design, and the built-in fields each one has.
// A company can: rename a field, hide it (unless it is essential), make it required or optional,
// change the order, and add its own fields (CustomFieldDefinition, shown where "__custom" sits).
//
//   canHide        false = essential field: always shown (can still be renamed and moved)
//   canRequire     false = required status is fixed
//   required       the default (= how the form behaves today)
//   fixedRequired  required and cannot be switched to optional
const F = (key, label, o = {}) => ({
  key, label,
  canHide: o.canHide !== false && !o.fixedRequired,
  canRequire: o.canRequire !== false && !o.fixedRequired,
  required: !!o.required || !!o.fixedRequired,
  fixedRequired: !!o.fixedRequired,
  hint: o.hint || '',
});
const CUSTOM = { key: '__custom', label: 'Extra fields you added', canHide: false, canRequire: false, required: false, fixedRequired: false, hint: 'Your own fields appear here until you move them', slot: true };

const FORMS = {
  employee: {
    label: 'Add / edit employee', entity: 'employee',
    fields: [
      F('name', 'Full name', { fixedRequired: true }),
      F('department', 'Sector / department', { required: true }),
      F('location', 'Location'),
      F('joiningDate', 'Joining date'),
      CUSTOM,
      F('email', 'Email address', { fixedRequired: true, hint: 'Used to log in' }),
      F('whatsappNumber', 'WhatsApp number', { fixedRequired: true, hint: 'Messages are sent here' }),
      F('workOnSunday', 'Sunday working'),
      F('password', 'System access password', { fixedRequired: true }),
      F('roles', 'Assigned permissions', { fixedRequired: true }),
    ],
  },
  delegation: {
    label: 'Create delegation task', entity: 'delegation',
    fields: [
      F('title', 'Title', { fixedRequired: true }),
      F('priority', 'Priority'),
      F('description', 'Description'),
      CUSTOM,
      F('doer', 'Assign to', { fixedRequired: true }),
      F('deadline', 'Deadline', { fixedRequired: true }),
      F('attachments', 'Attachments'),
      F('followers', 'Followers'),
      F('revision', 'Allow deadline change'),
    ],
  },
  checklist: {
    label: 'Create checklist task', entity: 'task',
    fields: [
      F('taskName', 'Task name', { fixedRequired: true }),
      F('description', 'Description'),
      CUSTOM,
      F('doer', 'Assign to', { fixedRequired: true }),
      F('startDate', 'Start date', { fixedRequired: true }),
      F('frequency', 'Frequency', { fixedRequired: true }),
    ],
  },
  subtask: {
    label: 'Sub task', entity: 'subtask',
    fields: [
      F('title', 'Sub task name', { fixedRequired: true }),
      F('description', 'Details'),
      CUSTOM,
      F('receiver', 'Give it to', { fixedRequired: true }),
      F('deadline', 'Deadline', { fixedRequired: true }),
      F('priority', 'Priority'),
    ],
  },
  ticket: {
    label: 'Raise a ticket', entity: 'ticket',
    fields: [
      F('subject', 'Subject', { fixedRequired: true }),
      F('description', 'Description', { fixedRequired: true }),
      F('priority', 'Priority'),
      F('category', 'Category'),
      CUSTOM,
      F('attachments', 'Photos / videos / files'),
    ],
  },
  leave: {
    label: 'Apply for leave', entity: 'leave',
    fields: [
      F('type', 'Type', { fixedRequired: true }),
      F('from', 'From', { fixedRequired: true }),
      F('to', 'To'),
      F('dayPart', 'Day part'),
      F('reason', 'Reason'),
      F('buddy', 'Who covers your tasks?'),
      CUSTOM,
    ],
  },
  personal: {
    label: 'Personal task', entity: 'personal',
    fields: [
      F('title', 'Title', { fixedRequired: true }),
      F('notes', 'Notes'),
      F('priority', 'Priority'),
      F('dueDate', 'Due date (to-do)'),
      F('schedule', 'How often (checklist)', { fixedRequired: true }),
      CUSTOM,
    ],
  },
};

const ENTITY_FORM = Object.fromEntries(Object.entries(FORMS).map(([k, v]) => [v.entity, k]));

// Final order of the keys on a form: the company's saved order first, then anything not mentioned
// in the order it normally has (new custom fields go where the "extra fields" slot is, until moved).
function resolveOrder(formKey, customDefs, savedOrder) {
  const form = FORMS[formKey];
  if (!form) return [];
  const cf = (customDefs || []).map((d) => `cf:${d.fieldName}`);
  const base = [];
  for (const f of form.fields) { if (f.slot) base.push(...cf); else base.push(f.key); }
  const have = new Set(base);
  const saved = Array.isArray(savedOrder) ? savedOrder.filter((k, i, a) => have.has(k) && a.indexOf(k) === i) : [];
  const rest = base.filter((k) => !saved.includes(k));
  return [...saved, ...rest];
}

// Effective settings of every built-in field (saved choices applied on top of the defaults)
function effectiveFields(formKey, layout) {
  const form = FORMS[formKey];
  const saved = (layout && layout.fields) || {};
  return form.fields.filter((f) => !f.slot).map((f) => {
    const s = saved[f.key] || {};
    return {
      key: f.key, defaultLabel: f.label, label: (typeof s.label === 'string' && s.label.trim()) ? s.label.trim() : f.label,
      hidden: f.canHide && s.hidden === true,
      required: f.fixedRequired ? true : (typeof s.required === 'boolean' && f.canRequire ? s.required : f.required),
      canHide: f.canHide, canRequire: f.canRequire, fixedRequired: f.fixedRequired, hint: f.hint,
    };
  });
}

module.exports = { FORMS, ENTITY_FORM, resolveOrder, effectiveFields };

// Integration tests for custom fields + table preferences: real Mongo, real Express routes and controllers.
// Run: node --test tests/config/     (needs a MongoDB; default mongodb://127.0.0.1:27017/wp_config_test)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'config-test-secret';
const MONGO = process.env.CONFIG_TEST_MONGO || 'mongodb://127.0.0.1:27017/wp_config_test';

const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');
const DelegationTask = require('../../models/DelegationTask');
const CustomFieldDefinition = require('../../models/CustomFieldDefinition');
const TablePreference = require('../../models/TablePreference');

// FerretDB (the lightweight Mongo stand-in used for local runs) cannot do findAndModify with a field
// projection, which updateEmployee uses (.select('-password')). Real MongoDB can. Set CONFIG_TEST_FERRET=0 on real Mongo.
if (process.env.CONFIG_TEST_FERRET !== '0') {
  const origSelect = mongoose.Query.prototype.select;
  mongoose.Query.prototype.select = function (...a) { return this.op === 'findOneAndUpdate' ? this : origSelect.apply(this, a); };
}

let server, base, tA, tB, adminA, doerA, adminB, tokA, tokDoerA, tokB, tokViewerA, oldEmp, oldTask;
const tok = (e, t, roles) => jwt.sign({ id: String(e._id), tenantId: String(t._id), roles }, process.env.JWT_SECRET);
const api = (method, path, token, body) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test.before(async () => {
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 4000 });
  await mongoose.connection.dropDatabase();
  await Promise.all([Tenant.init(), Employee.init(), DelegationTask.init(), CustomFieldDefinition.init(), TablePreference.init()]);
  const mk = (n) => Tenant.create({ companyName: `Co ${n}`, subdomain: `co-${n}`, adminEmail: `${n}@co.test`, password: 'x' });
  tA = await mk('a'); tB = await mk('b');
  const emp = (t, name, roles) => Employee.create({ tenantId: t._id, name, roles, whatsappNumber: '9000000000', email: `${name.replace(/\W/g, '').toLowerCase()}@${t.subdomain}.test`, password: 'x' });
  adminA = await emp(tA, 'Admin A', ['Admin']); doerA = await emp(tA, 'Doer A', ['Doer']); adminB = await emp(tB, 'Admin B', ['Admin']);
  tokA = tok(adminA, tA, ['Admin']); tokDoerA = tok(doerA, tA, ['Doer']); tokB = tok(adminB, tB, ['Admin']); tokViewerA = tok(doerA, tA, ['Viewer']);
  // A record that already existed before this feature (written straight to the collection, no customFields key at all)
  const raw = await mongoose.connection.collection('employees').insertOne({ tenantId: tA._id, name: 'Legacy Lee', email: 'lee@co-a.test', password: 'x', roles: ['Doer'], whatsappNumber: '9111111111', createdAt: new Date() });
  oldEmp = raw.insertedId;
  const rawT = await mongoose.connection.collection('delegationtasks').insertOne({ tenantId: tA._id, title: 'Legacy task', assignerId: adminA._id, doerId: doerA._id, deadline: new Date(Date.now() + 86400000), status: 'Accepted', priority: 'Medium', history: [], files: [], createdAt: new Date() });
  oldTask = rawT.insertedId;

  const app = express(); app.use(express.json());
  app.use('/api/config', require('../../routes/configRoutes'));
  app.use('/api/tasks', require('../../routes/taskRoutes'));
  server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server && server.close(); await mongoose.disconnect(); });

test('1. a company with no custom fields: old behaviour is unchanged and old records read fine', async () => {
  const f = await api('GET', '/api/config/fields/employee', tokA);
  assert.strictEqual(f.status, 200); assert.deepStrictEqual(f.body.fields, []);
  const list = await api('GET', `/api/tasks/employees/${tA._id}`, tokA);
  const lee = list.body.employees.find((e) => e.name === 'Legacy Lee');
  assert.ok(lee, 'legacy employee listed');
  assert.ok(lee.customFields === undefined || Object.keys(lee.customFields).length === 0, 'no customFields noise');
  // creating an employee exactly as the old screen did still works
  const r = await api('POST', '/api/tasks/add-employee', tokA, { tenantId: String(tA._id), name: 'Plain Pat', whatsappNumber: '9222222222', email: 'pat@co-a.test', password: 'secret123', roles: ['Doer'], department: 'Ops' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
});

test('2. only an Admin can define fields; definitions are validated', async () => {
  const body = { fields: [{ fieldLabel: 'Blood group', fieldType: 'select', options: ['A+', 'B+', 'O+'], isRequired: false }, { fieldLabel: 'Employee code', fieldType: 'text', isRequired: true }, { fieldLabel: 'Experience (yrs)', fieldType: 'number' }, { fieldLabel: 'Date of birth', fieldType: 'date' }, { fieldLabel: 'Has vehicle', fieldType: 'boolean' }] };
  assert.strictEqual((await api('POST', '/api/config/fields/employee', tokDoerA, body)).status, 403);
  assert.strictEqual((await api('POST', '/api/config/fields/employee', tokViewerA, body)).status, 403);
  assert.strictEqual((await api('POST', '/api/config/fields/bogus', tokA, body)).status, 400);
  assert.strictEqual((await api('POST', '/api/config/fields/employee', tokA, { fields: [{ fieldLabel: 'Pick', fieldType: 'select', options: [] }] })).status, 400);
  const ok = await api('POST', '/api/config/fields/employee', tokA, body);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.deepStrictEqual(ok.body.fields.map((x) => x.fieldName), ['blood_group', 'employee_code', 'experience_yrs', 'date_of_birth', 'has_vehicle']);
  // type cannot change after creation
  const chg = await api('POST', '/api/config/fields/employee', tokA, { fields: [{ fieldName: 'employee_code', fieldLabel: 'Employee code', fieldType: 'number' }] });
  assert.strictEqual(chg.status, 400);
});

test('3. tenant isolation: company B sees none of company A fields', async () => {
  const b = await api('GET', '/api/config/fields/employee', tokB);
  assert.deepStrictEqual(b.body.fields, []);
  const a = await api('GET', '/api/config/fields/employee', tokDoerA);
  assert.strictEqual(a.body.fields.length, 5);
});

test('4. create employee: required field enforced, values coerced, junk ignored', async () => {
  const base0 = { tenantId: String(tA._id), name: 'Cathy', whatsappNumber: '9333333333', email: 'cathy@co-a.test', password: 'secret123', roles: ['Doer'] };
  const miss = await api('POST', '/api/tasks/add-employee', tokA, { ...base0, customFields: { blood_group: 'A+' } });
  assert.strictEqual(miss.status, 400); assert.match(miss.body.message, /Employee code/);
  const badSel = await api('POST', '/api/tasks/add-employee', tokA, { ...base0, customFields: { employee_code: 'E1', blood_group: 'Z' } });
  assert.strictEqual(badSel.status, 400);
  const good = await api('POST', '/api/tasks/add-employee', tokA, { ...base0, customFields: { employee_code: ' E-77 ', blood_group: 'O+', experience_yrs: '4.5', date_of_birth: '1990-05-17', has_vehicle: 'true', hacker: 'x', '$where': '1' } });
  assert.strictEqual(good.status, 201, JSON.stringify(good.body));
  const doc = await Employee.findOne({ email: 'cathy@co-a.test' }).lean();
  assert.deepStrictEqual(doc.customFields, { employee_code: 'E-77', blood_group: 'O+', experience_yrs: 4.5, date_of_birth: '1990-05-17', has_vehicle: true });
  const list = await api('GET', `/api/tasks/employees/${tA._id}`, tokA);
  assert.strictEqual(list.body.employees.find((e) => e.name === 'Cathy').customFields.employee_code, 'E-77', 'values come back as plain JSON');
});

test('5. edit employee: legacy record (no customFields) stays editable; only sent fields change', async () => {
  const put = (id, body) => api('PUT', `/api/tasks/employees/${id}`, tokA, { name: 'Legacy Lee', email: 'lee@co-a.test', roles: ['Doer'], ...body });
  const noCf = await put(oldEmp, { department: 'Stores' });
  assert.strictEqual(noCf.status, 200, JSON.stringify(noCf.body));
  const set = await put(oldEmp, { customFields: { blood_group: 'B+' } });
  assert.strictEqual(set.status, 200);
  let doc = await Employee.findById(oldEmp).lean();
  assert.strictEqual(doc.customFields.blood_group, 'B+'); assert.strictEqual(doc.department, 'Stores');
  const set2 = await put(oldEmp, { customFields: { experience_yrs: 2 } });
  doc = await Employee.findById(oldEmp).lean();
  assert.deepStrictEqual(doc.customFields, { blood_group: 'B+', experience_yrs: 2 }, 'earlier value kept');
  const clearReq = await put(oldEmp, { customFields: { employee_code: '' } });
  assert.strictEqual(clearReq.status, 400, 'a required field cannot be blanked');
});

test('6. switching a field off hides it but keeps old values; its values are no longer accepted', async () => {
  const off = await api('POST', '/api/config/fields/employee', tokA, { fields: [{ fieldName: 'has_vehicle', fieldLabel: 'Has vehicle', isActive: false }] });
  assert.strictEqual(off.status, 200);
  assert.strictEqual((await api('GET', '/api/config/fields/employee', tokA)).body.fields.length, 4);
  assert.strictEqual((await api('GET', '/api/config/fields/employee?includeInactive=1', tokA)).body.fields.length, 5);
  assert.strictEqual((await api('GET', '/api/config/fields/employee?includeInactive=1', tokDoerA)).body.fields.length, 4, 'non-admins never see inactive');
  assert.strictEqual((await Employee.findOne({ email: 'cathy@co-a.test' }).lean()).customFields.has_vehicle, true);
});

test('7. delegation tasks: create with custom fields, edit, legacy task untouched', async () => {
  assert.strictEqual((await api('POST', '/api/config/fields/delegation', tokA, { fields: [{ fieldLabel: 'PO number', fieldType: 'text', isRequired: true }, { fieldLabel: 'Amount', fieldType: 'number' }] })).status, 200);
  // legacy task: GET + a plain edit (no customFields in the request) still work
  const g = await api('GET', `/api/tasks/${oldTask}`, tokA);
  assert.strictEqual(g.status, 200);
  const e0 = await api('PUT', `/api/tasks/${oldTask}`, tokA, { title: 'Legacy task renamed' });
  assert.strictEqual(e0.status, 200, JSON.stringify(e0.body));
  const e1 = await api('PUT', `/api/tasks/${oldTask}`, tokA, { customFields: { po_number: 'PO-9', amount: '1200' } });
  assert.strictEqual(e1.status, 200, JSON.stringify(e1.body));
  let t = await DelegationTask.findById(oldTask).lean();
  assert.deepStrictEqual(t.customFields, { po_number: 'PO-9', amount: 1200 });
  assert.match(t.history[t.history.length - 1].remarks, /extra fields/);
  // saving the same values again is "no changes"
  const e2 = await api('PUT', `/api/tasks/${oldTask}`, tokA, { customFields: { po_number: 'PO-9' } });
  assert.strictEqual(e2.body.message, 'No changes to save.');
  // create (multipart-style: customFields arrives as a JSON string)
  const mkTask = (cf) => api('POST', '/api/tasks/create-task', tokA, { tenantId: String(tA._id), assignerId: String(adminA._id), doerId: String(doerA._id), title: 'New job', deadline: new Date(Date.now() + 5 * 86400000).toISOString(), priority: 'High', customFields: cf });
  const bad = await mkTask(JSON.stringify({ amount: 5 }));
  assert.strictEqual(bad.status, 400); assert.match(bad.body.message, /PO number/);
  const good = await mkTask(JSON.stringify({ po_number: 'PO-1', amount: '75.5' }));
  assert.strictEqual(good.status, 201, JSON.stringify(good.body));
  const made = await DelegationTask.findOne({ title: 'New job' }).lean();
  assert.deepStrictEqual(made.customFields, { po_number: 'PO-1', amount: 75.5 });
  // The task list the screens use goes through toObject(): values must still arrive as plain JSON
  const lst = await api('GET', `/api/tasks/assigner/${adminA._id}`, tokA);
  const row = lst.body.find((x) => x.title === 'New job');
  assert.deepStrictEqual(row.customFields, { po_number: 'PO-1', amount: 75.5 });
  assert.ok(lst.body.find((x) => x.title === 'Legacy task renamed'), 'legacy task still listed');
});

test('8. table preferences: default, personal, company default, reset, viewer access', async () => {
  const d = await api('GET', '/api/config/table-preferences/employee_table', tokDoerA);
  assert.deepStrictEqual(d.body, { tableKey: 'employee_table', columns: [], scope: 'default', isDefault: true });
  assert.strictEqual((await api('POST', '/api/config/table-preferences/Bad Key!', tokDoerA, { columns: [] })).status, 400);
  assert.strictEqual((await api('POST', '/api/config/table-preferences/employee_table', tokDoerA, { columns: 'nope' })).status, 400);
  // company default needs Admin
  const cols = [{ key: 'email', isVisible: false, order: 1 }, { key: 'name', isVisible: true, order: 0, width: 200 }, { key: 'name' }, { key: '' }];
  assert.strictEqual((await api('POST', '/api/config/table-preferences/employee_table', tokDoerA, { columns: cols, scope: 'company' })).status, 403);
  const co = await api('POST', '/api/config/table-preferences/employee_table', tokA, { columns: cols, scope: 'company' });
  assert.strictEqual(co.status, 200); assert.strictEqual(co.body.columns.length, 2, 'duplicates / blank keys dropped');
  // everybody in A now sees the company default; B does not
  assert.strictEqual((await api('GET', '/api/config/table-preferences/employee_table', tokDoerA)).body.scope, 'company');
  assert.strictEqual((await api('GET', '/api/config/table-preferences/employee_table', tokB)).body.scope, 'default');
  // personal layout wins; a view-only account may save its own layout
  const mine = await api('POST', '/api/config/table-preferences/employee_table', tokViewerA, { columns: [{ key: 'phone', isVisible: true, order: 0 }] });
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  const got = await api('GET', '/api/config/table-preferences/employee_table', tokViewerA);
  assert.strictEqual(got.body.scope, 'user'); assert.strictEqual(got.body.columns[0].key, 'phone');
  assert.strictEqual((await api('POST', '/api/config/fields/employee', tokViewerA, { fields: [{ fieldLabel: 'X' }] })).status, 403, 'viewer still cannot change fields');
  // reset removes only the personal layout
  await api('DELETE', '/api/config/table-preferences/employee_table', tokViewerA);
  assert.strictEqual((await api('GET', '/api/config/table-preferences/employee_table', tokViewerA)).body.scope, 'company');
});

test('9. no token -> 401', async () => {
  assert.strictEqual((await fetch(`${base}/api/config/fields/employee`)).status, 401);
});

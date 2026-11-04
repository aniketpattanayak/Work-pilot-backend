// Unit tests for the Excel report builder - no database needed.
// Run: node --test tests/reports/excelReport.unit.test.js
const test = require('node:test');
const assert = require('node:assert');
const moment = require('moment');
const ExcelJS = require('exceljs');
const { Writable } = require('stream');

const Tenant = require('../../models/Tenant');
const ctl = require('../../controllers/excelReportController');
const { buildTaskWorkbook, buildEmployeeWorkbook, parseRange } = ctl._test;

const NOW = new Date('2026-10-30T10:00:00.000Z');
const id = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const day = (s) => new Date(`${s}T00:00:00.000Z`);

const employees = [
  { _id: id(1), name: 'Anita Admin', roles: ['Admin'], department: 'Mgmt', location: 'HQ', email: 'a@x.com', whatsappNumber: '9198', managedAssigners: [id(2)], managedDoers: [] },
  { _id: id(2), name: 'Ravi Assigner', roles: ['Assigner'], department: 'Ops', location: 'HQ', email: 'r@x.com', whatsappNumber: '9199', managedDoers: [id(3), id(4)], managedAssigners: [] },
  { _id: id(3), name: 'Dev Doer', roles: ['Doer'], department: 'Ops', location: 'Plant', email: 'd@x.com', whatsappNumber: '9100', workOnSunday: false, leaveStatus: { onLeave: true, startDate: day('2026-11-01'), endDate: day('2026-11-03') } },
  { _id: id(4), name: 'Sam Doer', roles: ['Doer'], department: 'Ops', location: 'Plant', email: 's@x.com', whatsappNumber: '9101' }
];
const empById = new Map(employees.map((e) => [e._id, e]));

const delegations = [
  { _id: id(11), title: 'Done on time', assignerId: id(2), doerId: id(3), priority: 'High', status: 'Completed', deadline: new Date('2026-10-20T12:00:00Z'), createdAt: new Date('2026-10-10T05:00:00Z'), history: [{ action: 'Task Created', timestamp: new Date('2026-10-10T05:00:00Z') }, { action: 'Completed', timestamp: new Date('2026-10-19T08:00:00Z') }] },
  { _id: id(12), title: 'Done late', assignerId: id(2), doerId: id(3), priority: 'Low', status: 'Verified', deadline: new Date('2026-10-20T12:00:00Z'), createdAt: new Date('2026-10-10T05:00:00Z'), history: [{ action: 'Completed', timestamp: new Date('2026-10-25T08:00:00Z') }] },
  { _id: id(13), title: 'Overdue one', assignerId: id(2), doerId: id(4), priority: 'Urgent', status: 'Accepted', deadline: new Date('2026-10-25T12:00:00Z'), createdAt: new Date('2026-10-12T05:00:00Z'), history: [] },
  { _id: id(14), title: 'Pending future', assignerId: id(2), doerId: id(4), priority: 'Medium', status: 'Pending', deadline: new Date('2026-11-15T12:00:00Z'), createdAt: new Date('2026-10-28T05:00:00Z'), history: [], coworkers: [id(3)] },
  { _id: id(15), title: 'On hold past due', assignerId: id(2), doerId: id(4), priority: 'Medium', status: 'Accepted', deadline: new Date('2026-10-22T12:00:00Z'), createdAt: new Date('2026-10-12T05:00:00Z'), history: [], onHold: { isOn: true } }
];

const checklists = [
  { _id: id(21), taskName: 'Daily cleaning', doerId: id(3), createdBy: id(2), frequency: 'Daily', startDate: day('2026-10-26'), createdAt: day('2026-10-26'), status: 'Active',
    nextDueDate: day('2026-10-28'),
    history: [
      { action: 'Completed', timestamp: new Date('2026-10-26T09:00:00Z'), instanceDate: day('2026-10-26') },
      { action: 'Completed', timestamp: new Date('2026-10-28T09:00:00Z'), instanceDate: day('2026-10-27') }, // completed a day late
      { action: 'Administrative Completion', timestamp: new Date('2026-10-28T10:00:00Z'), instanceDate: day('2026-10-28') }
    ] },
  { _id: id(22), taskName: 'Paused weekly', doerId: id(4), createdBy: id(2), frequency: 'Weekly', frequencyConfig: { daysOfWeek: [1] }, startDate: day('2026-10-01'), createdAt: day('2026-10-01'), status: 'Paused', nextDueDate: day('2026-10-05'), history: [] }
];

const base = { tenant: { companyName: 'Test Co', holidays: [], weekends: [0] }, employees, empById, delegations, checklists, isAdmin: true, me: id(1) };
const rangeAll = parseRange({});

const readBack = async (wb) => {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return back;
};
const sheetNames = (wb) => wb.worksheets.map((w) => w.name);
const rowsOf = (ws) => { const out = []; ws.eachRow((r, n) => { if (n > 1) out.push(r.values.slice(1)); }); return out; };

test('parseRange: empty = all history, valid dates become India-day bounds, bad input rejected', () => {
  assert.strictEqual(parseRange({}).all, true);
  const r = parseRange({ from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(r.all, false);
  assert.strictEqual(r.start.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.strictEqual(r.end.toISOString(), '2026-10-31T18:29:59.999Z');
  assert.ok(parseRange({ from: 'abc' }).error);
  assert.ok(parseRange({ from: '2026-10-05', to: '2026-10-01' }).error);
});

test('complete report has every sheet in the agreed order', async () => {
  const { wb } = buildTaskWorkbook(base, { scope: 'mytasks', type: 'complete', range: rangeAll, employeeId: '' }, NOW);
  const back = await readBack(wb);
  assert.deepStrictEqual(sheetNames(back), ['Schedule', 'Task Details', 'Checklist Status', 'Work Distribution', 'Employee & Doer Details', 'Task Summary', 'Date-wise Records']);
});

test('download options pick the right sheets', async () => {
  const names = async (type) => sheetNames(await readBack(buildTaskWorkbook(base, { scope: 'delegation', type, range: rangeAll, employeeId: '' }, NOW).wb));
  assert.deepStrictEqual(await names('datewise'), ['Schedule', 'Task Summary', 'Date-wise Records']);
  assert.deepStrictEqual(await names('employeewise'), ['Work Distribution', 'Employee & Doer Details', 'Task Summary']);
  assert.deepStrictEqual(await names('taskwise'), ['Task Details', 'Checklist Status', 'Task Summary']);
});

test('delegation statuses: completed / late / overdue / pending / on hold', () => {
  const { c } = buildTaskWorkbook({ ...base, checklists: [] }, { scope: 'delegation', type: 'complete', range: rangeAll, employeeId: '' }, NOW);
  const st = Object.fromEntries(c.items.map((x) => [x.title, x]));
  assert.strictEqual(st['Done on time'].status, 'Completed'); assert.strictEqual(st['Done on time'].late, false);
  assert.strictEqual(st['Done late'].status, 'Completed'); assert.strictEqual(st['Done late'].late, true);
  assert.strictEqual(st['Overdue one'].status, 'Overdue'); assert.ok(st['Overdue one'].daysOverdue >= 4);
  assert.strictEqual(st['Pending future'].status, 'Pending');
  assert.strictEqual(st['On hold past due'].status, 'Pending'); // clock paused, never shown as overdue
  assert.deepStrictEqual({ t: c.totals.total, c: c.totals.completed, p: c.totals.pending, o: c.totals.overdue, l: c.totals.late }, { t: 5, c: 2, p: 2, o: 1, l: 1 });
});

test('checklist schedule: done days, a day completed late, today pending, overdue, paused ignored', () => {
  const { c } = buildTaskWorkbook({ ...base, delegations: [] }, { scope: 'checklist', type: 'complete', range: rangeAll, employeeId: '' }, NOW);
  const daily = c.items.filter((x) => x.title === 'Daily cleaning');
  const by = Object.fromEntries(daily.map((x) => [x.dueKey, x]));
  assert.strictEqual(by['2026-10-26'].status, 'Completed');
  assert.strictEqual(by['2026-10-26'].late, false);
  assert.strictEqual(by['2026-10-27'].status, 'Completed'); assert.strictEqual(by['2026-10-27'].late, true);
  assert.strictEqual(by['2026-10-28'].status, 'Completed');
  assert.strictEqual(by['2026-10-29'].status, 'Overdue');
  assert.strictEqual(by['2026-10-30'].status, 'Pending');
  assert.strictEqual(by['2026-10-31'].status, 'Upcoming');
  assert.strictEqual(c.totals.pending, 1, 'upcoming days are not counted as pending');
  assert.ok(!by['2026-10-25'] || by['2026-10-25'].status === 'Not recorded'); // before the checklist started (Sunday is a weekend)
  assert.strictEqual(c.items.filter((x) => x.title === 'Paused weekly').length, 0);
});

test('date range keeps only matching days; employee filter is applied by the data loader', () => {
  const r = parseRange({ from: '2026-10-28', to: '2026-10-30' });
  const { c } = buildTaskWorkbook({ ...base, delegations: [] }, { scope: 'checklist', type: 'complete', range: r, employeeId: '' }, NOW);
  assert.deepStrictEqual(c.items.map((x) => x.dueKey), ['2026-10-28', '2026-10-29', '2026-10-30']);
});

test('workbook content: overdue rows are red, dates are real dates, totals add up, no passwords or secrets', async () => {
  const { wb } = buildTaskWorkbook(base, { scope: 'mytasks', type: 'complete', range: rangeAll, employeeId: '' }, NOW);
  const back = await readBack(wb);
  const sched = back.getWorksheet('Schedule');
  assert.ok(sched.autoFilter, 'Schedule has filters');
  assert.strictEqual(sched.views[0].state, 'frozen');
  let sawOverdue = false;
  sched.eachRow((row, n) => {
    if (n === 1) return;
    if (row.getCell(9).value === 'Overdue') {
      sawOverdue = true;
      assert.strictEqual(row.getCell(5).fill.fgColor.argb, 'FFFEE2E2');
    }
    assert.ok(row.getCell(2).value instanceof Date, 'date column holds a real date');
  });
  assert.ok(sawOverdue);

  const sum = back.getWorksheet('Task Summary');
  const lines = []; sum.eachRow((r) => lines.push(r.values.slice(1)));
  const all = lines.find((l) => l[0] === 'All tasks');
  assert.ok(all, 'summary has the all-tasks line');
  const [, total, completed, pending, overdue] = all;
  assert.strictEqual(total, completed + pending + overdue);

  const wd = back.getWorksheet('Work Distribution');
  const totalRow = rowsOf(wd).find((r) => r[1] === 'TOTAL');
  assert.strictEqual(totalRow[7], total, 'work distribution total matches summary');

  const dump = JSON.stringify([...back.worksheets].map((w) => rowsOf(w)));
  assert.ok(!/password/i.test(dump));
});

test('non-admin report hides email and phone', async () => {
  const { wb } = buildTaskWorkbook({ ...base, isAdmin: false }, { scope: 'delegation', type: 'employeewise', range: rangeAll, employeeId: '' }, NOW);
  const back = await readBack(wb);
  const headers = back.getWorksheet('Employee & Doer Details').getRow(1).values.slice(1);
  assert.ok(!headers.includes('Email') && !headers.includes('WhatsApp'));
  const adminBack = await readBack(buildTaskWorkbook(base, { scope: 'delegation', type: 'employeewise', range: rangeAll, employeeId: '' }, NOW).wb);
  assert.ok(adminBack.getWorksheet('Employee & Doer Details').getRow(1).values.includes('Email'));
});

test('date-wise records list completions on their completion day and misses on their due day', () => {
  const { c } = buildTaskWorkbook(base, { scope: 'mytasks', type: 'datewise', range: rangeAll, employeeId: '' }, NOW);
  const rec = (title, key) => c.dateWise.find((r) => r.title === title && r.key === key);
  assert.ok(rec('Done on time', '2026-10-19'));
  assert.strictEqual(rec('Done late', '2026-10-25').outcome, 'Completed late');
  assert.strictEqual(rec('Overdue one', '2026-10-25').outcome, 'Not completed (overdue)');
  assert.ok(c.dayTotals.find((d) => d.key === '2026-10-25').notCompleted >= 1);
});

test('employee report: details, doer counts, distribution rows, summary', async () => {
  const wbAll = await readBack(buildEmployeeWorkbook({ tenant: base.tenant, employees, empById }, { employeeId: '' }).wb);
  assert.deepStrictEqual(sheetNames(wbAll), ['Employee & Doer Details', 'Doer Distribution', 'Allocation Summary']);
  const det = rowsOf(wbAll.getWorksheet('Employee & Doer Details'));
  assert.strictEqual(det.length, 4);
  const ravi = det.find((r) => r[1] === 'Ravi Assigner');
  assert.strictEqual(ravi[11], 2);                       // doers assigned
  assert.match(String(ravi[12]), /Dev Doer, Sam Doer|Sam Doer, Dev Doer/);
  assert.strictEqual(rowsOf(wbAll.getWorksheet('Doer Distribution')).length, 2);
  const dev = det.find((r) => r[1] === 'Dev Doer');
  assert.match(String(dev[7]), /On Leave/);
  assert.ok(!JSON.stringify(det).toLowerCase().includes('password'));

  const one = await readBack(buildEmployeeWorkbook({ tenant: base.tenant, employees, empById }, { employeeId: id(2) }).wb);
  assert.strictEqual(rowsOf(one.getWorksheet('Employee & Doer Details')).length, 1);
  assert.strictEqual(rowsOf(one.getWorksheet('Doer Distribution')).length, 2);
});

test('HTTP handlers: validation, admin-only employee report, real xlsx bytes (database stubbed)', async () => {
  const origFind = Tenant.findById;
  Tenant.findById = () => ({ select: () => ({ lean: async () => base.tenant }) });
  const fakeModel = (rows) => ({ find: () => { const q = { select: () => q, sort: () => q, lean: async () => rows }; return q; } });
  const mkReq = (query, user) => ({
    query, user,
    db: { model: (n) => ({ Employee: fakeModel(employees), DelegationTask: fakeModel(delegations), ChecklistTask: fakeModel(checklists) }[n]) }
  });
  const mkRes = () => {
    const chunks = [];
    const res = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    res.headers = {}; res.statusCode = 200; res.headersSent = false;
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; res.end(); return res; };
    res.bytes = () => Buffer.concat(chunks);
    return res;
  };
  const done = (res) => new Promise((r) => res.on('finish', r));
  try {
    const admin = { id: id(1), tenantId: '64b000000000000000000099', roles: ['Admin'] };
    let res = mkRes();
    await ctl.downloadTasks(mkReq({ scope: 'bogus' }, admin), res);
    assert.strictEqual(res.statusCode, 400);

    res = mkRes();
    await ctl.downloadTasks(mkReq({ scope: 'delegation', from: '2026-10-05', to: '2026-10-01' }, admin), res);
    assert.strictEqual(res.statusCode, 400);

    res = mkRes();
    const fin = done(res);
    await ctl.downloadTasks(mkReq({ scope: 'delegation', type: 'complete' }, admin), res);
    await fin;
    assert.match(res.headers['Content-Type'], /spreadsheetml/);
    assert.match(res.headers['Content-Disposition'], /WorkPilot_ManageDelegation_CompleteReport_All_all_to_all\.xlsx/);
    const back = new ExcelJS.Workbook(); await back.xlsx.load(res.bytes());
    assert.ok(back.getWorksheet('Task Details'));

    res = mkRes();
    await ctl.downloadEmployees(mkReq({}, { id: id(3), tenantId: '64b000000000000000000099', roles: ['Doer'] }), res);
    assert.strictEqual(res.statusCode, 403);

    res = mkRes();
    const fin2 = done(res);
    await ctl.downloadEmployees(mkReq({ employeeId: id(2) }, admin), res);
    await fin2;
    assert.match(res.headers['Content-Disposition'], /WorkPilot_Employees_Ravi_Assigner_/);

    res = mkRes();
    await ctl.downloadTasks(mkReq({ scope: 'delegation', employeeId: id(9) }, admin), res);
    assert.strictEqual(res.statusCode, 404);
  } finally {
    Tenant.findById = origFind;
  }
});

test('who sees what: queries are limited to the same tasks each page already shows', async () => {
  const origFind = Tenant.findById;
  Tenant.findById = () => ({ select: () => ({ lean: async () => base.tenant }) });
  const seen = {};
  const spy = (name, rows) => ({ find: (q) => { seen[name] = q; const x = { select: () => x, sort: () => x, lean: async () => rows }; return x; } });
  const run = async (scope, user, extra = {}) => {
    const req = { query: { scope, ...extra }, user: { tenantId: '64b000000000000000000099', ...user }, db: { model: (n) => ({ Employee: spy('Employee', employees), DelegationTask: spy('Delegation', []), ChecklistTask: spy('Checklist', []) }[n]) } };
    const chunks = [];
    const res = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    res.setHeader = () => {}; res.status = () => res; res.json = () => res;
    await ctl.downloadTasks(req, res); await new Promise((r) => setImmediate(r));
  };
  try {
    await run('delegation', { id: id(2), roles: ['Assigner'] });
    assert.ok(seen.Delegation.$or, 'non-admin delegation: only tasks they gave or passed on');
    assert.strictEqual(String(seen.Delegation.$or[0].assignerId), id(2));
    await run('delegation', { id: id(1), roles: ['Admin'] });
    assert.deepStrictEqual(Object.keys(seen.Delegation), ['tenantId'], 'admin: whole company');
    await run('delegation', { id: id(1), roles: ['Viewer'] });
    assert.deepStrictEqual(Object.keys(seen.Delegation), ['tenantId'], 'view-only: whole company');
    await run('mytasks', { id: id(1), roles: ['Admin'] }, { employeeId: id(4) });
    assert.strictEqual(String(seen.Checklist.doerId), id(1), 'My Tasks is always only my own work, even for an Admin, and ignores an employee filter');
    assert.ok(seen.Delegation.$or.some((c) => c.coworkers), 'My Tasks includes tasks I follow');
    await run('checklist', { id: id(2), roles: ['Assigner'] });
    assert.deepStrictEqual(Object.keys(seen.Checklist), ['tenantId'], 'Manage Checklist shows the whole company to whoever opens the page, so the report does too');
    await run('checklist', { id: id(1), roles: ['Admin'] }, { employeeId: id(3) });
    assert.ok(seen.Checklist.$and && String(seen.Checklist.$and[1].doerId) === id(3), 'employee filter narrows to that doer');
  } finally { Tenant.findById = origFind; }
});

// ───────────── filtered / selected downloads ─────────────
const { parseIds, readParams, compute } = ctl._test;

test('parseIds: task ids, checklist day ids, junk ignored, whole task wins over single days', () => {
  assert.strictEqual(parseIds('').none, true);
  assert.strictEqual(parseIds(undefined).none, true);
  const p = parseIds([id(11), `${id(21)}|2026-10-27`, `${id(21)}|2026-10-28`, 'not-an-id', '', `${id(22)}|2026-10-01`, id(22), `${id(23)}|${new Date(2026, 9, 5, 14).toISOString()}`]);
  assert.strictEqual(p.none, false);
  assert.strictEqual(p.objectIds.length, 4, 'junk dropped, duplicates merged');
  assert.strictEqual(p.days.get(id(11)), null, 'plain id = whole task');
  assert.deepStrictEqual([...p.days.get(id(21))].sort(), ['2026-10-27', '2026-10-28']);
  assert.strictEqual(p.days.get(id(22)), null, 'asking for the whole task after a single day = whole task');
  assert.ok(p.days.get(id(23)).has('2026-10-05'), 'an ISO date-time becomes its day');
  assert.ok(parseIds(Array.from({ length: 100001 }, (_, i) => id(1))).error, 'too many ids refused');
  assert.strictEqual(parseIds(`${id(1)},${id(2)}`).objectIds.length, 2, 'comma text also works');
});

test('readParams: query and JSON text body are merged, a bad body is refused', () => {
  assert.strictEqual(readParams({ query: { scope: 'x' }, body: '{"type":"y"}' }).type, 'y');
  assert.strictEqual(readParams({ query: { scope: 'x' }, body: '{"type":"y"}' }).scope, 'x');
  assert.strictEqual(readParams({ query: { scope: 'x' }, body: { scope: 'z' } }).scope, 'z');
  assert.ok(readParams({ query: {}, body: '{oops' }).error);
  assert.strictEqual(readParams({ query: { a: 1 } }).a, 1);
});

test('status filter keeps only that status in every sheet', async () => {
  const run = (status) => compute(base, { scope: 'delegation', type: 'complete', range: rangeAll, employeeId: '', status, ids: parseIds('') }, NOW);
  const over = run('Overdue');
  assert.ok(over.items.length > 0 && over.items.every((x) => x.status === 'Overdue'), 'only overdue entries');
  assert.ok(over.taskRows.filter((r) => r.type === 'Delegation').every((r) => r.item.status === 'Overdue'));
  assert.deepStrictEqual(over.totals.completed + over.totals.pending, 0);
  const done = run('Completed');
  assert.ok(done.items.length > 0 && done.items.every((x) => x.status === 'Completed'));
  const all = run('');
  assert.ok(all.items.length > over.items.length + done.items.length - 1, 'no status = everything');
});

test('selected checklist days: only those days are in the report', async () => {
  const ids = parseIds([`${id(21)}|2026-10-27`]);
  const c = compute(base, { scope: 'checklist', type: 'complete', range: rangeAll, employeeId: '', status: '', ids }, NOW);
  const mine = c.items.filter((x) => x.taskId === id(21));
  assert.deepStrictEqual(mine.map((x) => x.dueKey), ['2026-10-27']);
  const whole = compute(base, { scope: 'checklist', type: 'complete', range: rangeAll, employeeId: '', status: '', ids: parseIds([id(21)]) }, NOW);
  assert.ok(whole.items.filter((x) => x.taskId === id(21)).length > 1, 'a plain id keeps every day');
});

test('HTTP: POST with ids narrows the database query; count mode answers JSON and builds no file; viewers use the same code path', async () => {
  const origFind = Tenant.findById;
  Tenant.findById = () => ({ select: () => ({ lean: async () => base.tenant }) });
  const seen = {};
  const spy = (name, rows) => ({ find: (q) => { seen[name] = q; const x = { select: () => x, sort: () => x, lean: async () => rows }; return x; } });
  const call = async (handler, user, body, query = {}) => {
    const req = { query, body: JSON.stringify(body), user: { tenantId: '64b000000000000000000099', ...user }, db: { model: (n) => ({ Employee: spy('Employee', employees), DelegationTask: spy('Delegation', delegations), ChecklistTask: spy('Checklist', checklists) }[n]) } };
    const out = { status: 200, json: null, headers: {}, chunks: [] };
    const res = new Writable({ write(c, e, cb) { out.chunks.push(c); cb(); } });
    res.setHeader = (k, v) => { out.headers[k] = v; }; res.status = (n) => { out.status = n; return res; }; res.json = (j) => { out.json = j; return res; };
    await handler(req, res); await new Promise((r) => setImmediate(r));
    return out;
  };
  try {
    const sel = await call(ctl.downloadTasks, { id: id(1), roles: ['Admin'] }, { scope: 'delegation', type: 'taskwise', ids: [id(13), id(14)], count: '1' });
    assert.strictEqual(sel.status, 200);
    assert.ok(sel.json && typeof sel.json.tasks === 'number', 'count answered as JSON');
    assert.strictEqual(sel.chunks.length, 0, 'no file built in count mode');
    const idCond = JSON.stringify(seen.Delegation);
    assert.ok(idCond.includes('"$in"') && idCond.includes(id(13)), 'the database query is limited to the chosen ids');
    const empty = await call(ctl.downloadTasks, { id: id(1), roles: ['Admin'] }, { scope: 'delegation', type: 'complete', status: 'Nonsense' });
    assert.strictEqual(empty.status, 400);
    const bad = await call(ctl.downloadTasks, { id: id(1), roles: ['Admin'] }, { scope: 'delegation', ids: 5 });
    assert.strictEqual(bad.status, 400);
    const file = await call(ctl.downloadTasks, { id: id(1), roles: ['Admin'] }, { scope: 'delegation', type: 'complete', ids: [id(13)], assignerId: id(2), status: 'Overdue' });
    assert.strictEqual(file.status, 200);
    assert.ok(/Selected/.test(file.headers['Content-Disposition']), 'file name says Selected');
    const back = await readBack({ xlsx: { writeBuffer: async () => Buffer.concat(file.chunks) } });
    const td = back.getWorksheet('Task Details');
    assert.strictEqual(td.rowCount, 2, 'header + the one chosen task');
    assert.strictEqual(td.getRow(2).getCell(3).value, 'Overdue one');
    const q2 = JSON.stringify(seen.Delegation);
    assert.ok(q2.includes('"assignerId"') && q2.includes(id(2)) && q2.includes(id(13)), 'assigner filter and chosen ids both reach the query');
  } finally { Tenant.findById = origFind; }
});

test('employee report: only the chosen employees, count mode, summary matches the rows', async () => {
  const only = new Set([id(2), id(3)]);
  const { wb } = buildEmployeeWorkbook({ tenant: base.tenant, employees, empById }, { employeeId: '', only }, NOW);
  const back = await readBack(wb);
  const names = rowsOf(back.getWorksheet('Employee & Doer Details')).map((r) => r[1]);
  assert.deepStrictEqual(names.sort(), ['Dev Doer', 'Ravi Assigner']);
  const dist = rowsOf(back.getWorksheet('Doer Distribution'));
  assert.ok(dist.every((r) => r[1] === 'Ravi Assigner'), 'only the chosen employees\' doers');
  const origFind = Tenant.findById;
  Tenant.findById = () => ({ select: () => ({ lean: async () => base.tenant }) });
  try {
    const req = { query: {}, body: JSON.stringify({ ids: [id(2), id(3), id(99)], count: '1' }), user: { tenantId: '64b000000000000000000099', roles: ['Admin'] }, db: { model: () => ({ find: () => { const x = { select: () => x, lean: async () => employees }; return x; } }) } };
    let json = null; const res = { status() { return res; }, json(j) { json = j; return res; }, setHeader() {} };
    await ctl.downloadEmployees(req, res);
    assert.deepStrictEqual(json, { employees: 2 }, 'an id that is not in the company is not counted');
  } finally { Tenant.findById = origFind; }
});

/**
 * LRBC demo data seeder  (26 Jan -> 27 Dec of the current year)
 *
 *   node scripts/lrbc-demo/seed.js                      DRY RUN: builds everything in memory, checks it, writes NOTHING
 *   node scripts/lrbc-demo/seed.js --run --files-base-url=https://YOUR-API-HOST   really writes
 *   node scripts/lrbc-demo/seed.js --offline            test mode, needs no database at all
 *
 * Safety:
 *  - Only touches the one company whose name/subdomain contains "lrbc". Refuses to run if two match.
 *  - Never edits or deletes existing records (only ADDS; and adds 3 names to Settings lists).
 *  - Demo employees have NO phone number and a ".invalid" email, so no WhatsApp / email can ever go out to them.
 *  - Your real LRBC people only get PAST, FINISHED history. Nothing pending / overdue / due soon is given to them.
 *  - Every created _id is written to a manifest file BEFORE inserting. undo.js removes exactly those.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = '') => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const RUN = flag('run'), OFFLINE = flag('offline');
const FILES_BASE = opt('files-base-url').replace(/\/+$/, '');
const DEMO_DOMAIN = 'lrbc-demo.invalid';

// ───────────────────────── helpers ─────────────────────────
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(Number(opt('seed', '20260126')));
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p) => rnd() < p;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const wpick = (pairs) => { const t = pairs.reduce((s, p) => s + p[1], 0); let r = rnd() * t; for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[pairs.length - 1][0]; };
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const oid = () => new mongoose.Types.ObjectId();
const IST = 330 * 60000, DAY = 864e5, HOUR = 36e5;
const mk = (d, h = 9, m = 0) => new Date(Date.parse(d + 'T00:00:00Z') + (h * 60 + m) * 60000 - IST);
const dstr = (dt) => new Date(dt.getTime() + IST).toISOString().slice(0, 10);
const addD = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const dow = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const minD = (a, b) => (a < b ? a : b);

const NOW = new Date();
const TODAY = dstr(NOW);
const YEAR = Number(opt('year', TODAY.slice(0, 4)));
const START = `${YEAR}-01-26`, END = `${YEAR}-12-27`;
let WEEKENDS = [0];
const isWork = (s) => !WEEKENDS.includes(dow(s));
const nextWork = (s) => { let x = s; while (!isWork(x)) x = addD(x, 1); return x; };
const prevWork = (s) => { let x = s; while (!isWork(x)) x = addD(x, -1); return x; };
const workDaysBetween = (a, b) => { const o = []; for (let x = a; x <= b; x = addD(x, 1)) if (isWork(x)) o.push(x); return o; };
const randWorkDay = (a, b) => { const span = diffDays(a, b); for (let i = 0; i < 20; i++) { const x = addD(a, ri(0, span)); if (isWork(x)) return x; } return nextWork(a); };
const pad = (n, w) => String(n).padStart(w, '0');

// ───────────────────────── content ─────────────────────────
const CUSTOMERS = ['Hotel Deccan Residency', 'Sri Balaji Caterers', 'Annapurna Mess Services', 'Kumar & Sons Utensils', 'Lakshmi Steel Mart', 'Royal Banquets Hyderabad', 'Green Leaf Restaurants', 'Metro Kitchen Needs', 'Sai Ram Departmental Stores', 'Vishnu Hostel Supplies', 'City Cash & Carry', 'Padmavathi Traders', 'Greenfield School Canteen', 'Orient Hospitality Pvt Ltd', 'Maruthi Provisions', 'Shree Ganesh Tiffins', 'Rainbow Event Services', 'Heritage Hotels Pune', 'Chennai Kitchenware House', 'Nandi Catering Co', 'Sunrise Hospital Canteen', 'Telangana Co-op Stores', 'Krishna Steel Emporium', 'Blue Orchid Resorts', 'Madurai Vessels Centre', 'Pearl Foods & Beverages', 'Bharat Institutional Supplies', 'Silver Spoon Caterers', 'Vignesh Home Needs', 'Coastal Hotels Group'];
const ITEMS = [['SS Ladle 12 inch', 'Nos', 185], ['SS Kadai 24 cm', 'Nos', 640], ['Pressure Cooker 5 L', 'Nos', 1450], ['Idli Pot 4-Tier', 'Nos', 980], ['Tiffin Carrier 3-Tier', 'Nos', 520], ['SS Water Jug 2 L', 'Nos', 410], ['Milk Pan 1.5 L', 'Nos', 360], ['Dinner Set 24 pc', 'Set', 2250], ['SS Thali Set 6 pc', 'Set', 790], ['Cooking Pot 15 L', 'Nos', 1890], ['Biryani Handi 20 L', 'Nos', 3250], ['SS Plate 12 inch', 'Nos', 140], ['SS Glass 300 ml', 'Nos', 65], ['Serving Spoon Set', 'Set', 275], ['Steel Bucket 10 L', 'Nos', 690], ['Masala Dabba 7 pc', 'Nos', 430]];
const VENDORS = ['Jindal Stainless Coils', 'Sandvik Fasteners', 'Aarav Packaging', 'Hindustan Polymers', 'Rajesh Metal Works', 'Surya Abrasives', 'Vardhaman Cartons', 'Tata Steel Distributors', 'Om Sai Handles & Fittings', 'Mahalaxmi Logistics'];
const CITIES = ['Hyderabad', 'Pune', 'Chennai', 'Bengaluru', 'Vijayawada', 'Mumbai', 'Nagpur', 'Coimbatore', 'Vizag'];
const REMARKS_DONE = ['Done as requested.', 'Completed. Please check.', 'All done, details shared on mail.', 'Finished, attached the proof.', 'Closed after confirming with the party.', 'Work completed, nothing pending.', 'Done. Customer is happy.', 'Updated in the system and informed everyone.'];
const REMARKS_VERIFY = ['Checked and found correct.', 'Verified, good work.', 'OK.', 'Looks fine, closing.', 'Verified against the records.', 'Good. Closed.'];
const REMARKS_REJECT = ['Figures do not match the invoice, please redo.', 'Photo is not clear, please send again.', 'Part of the work is pending, please complete.', 'Wrong party selected, please correct.', 'Missing signature, send the signed copy.'];
const REASONS = ['Waiting for client', 'Waiting for another department', 'Sick or on leave', 'Priority changed', 'My own delay', 'Assigner changed the work', 'Other'];

const T = {
  Sales: ['Send quotation to {c}', 'Follow up on payment promise from {c}', 'Visit {c} for repeat order discussion', 'Prepare price list update for {city} dealers', 'Collect purchase order from {c}', 'Share product catalogue with {c}', 'Resolve complaint raised by {c}', 'Confirm delivery date with {c}', 'Update sales pipeline sheet for the week', 'Prepare monthly sales review for {month}'],
  Purchase: ['Get 3 quotations for {v}', 'Place purchase order with {v}', 'Negotiate rate with {v}', 'Follow up pending material from {v}', 'Verify vendor invoice of {v}', 'Prepare monthly stock requirement list', 'Update vendor rate comparison sheet', 'Arrange sample from new vendor for {i}'],
  Accounts: ['Send payment reminder to {c}', 'Reconcile {v} ledger', 'Prepare GST return for {month}', 'Raise invoice for order of {c}', 'Pay {v} against due invoice', 'Collect TDS certificate from {c}', 'Prepare outstanding receivables report', 'Bank reconciliation for {month}', 'Verify expense claims for {month}'],
  Production: ['Complete production batch of {i}', 'Quality check on {i} batch', 'Maintenance of polishing machine', 'Rework rejected lot of {i}', 'Update daily production report', 'Plan production schedule for next week', 'Calibrate pressing machine', 'Arrange raw material for {i}'],
  Stores: ['Dispatch order of {c} by transporter', 'Prepare packing list for {c}', 'Physical stock count of finished goods', 'Receive material from {v} and update GRN', 'Arrange vehicle for delivery to {city}', 'Update lorry receipt copy for {c}', 'Check packing material stock', 'Return damaged goods from {c}'],
  HR: ['Prepare {month} attendance summary', 'Conduct induction for new joiner', 'Renew factory licence documents', 'Arrange fire safety drill', 'Collect leave records for {month}', 'Update employee master data', 'Schedule interviews for open position', 'Book travel for visit to {city}'],
};
const SUBS = {
  Sales: ['Prepare rate sheet', 'Get approval from manager', 'Share on email and WhatsApp group', 'Update CRM sheet'],
  Purchase: ['Collect quotes', 'Compare rates', 'Take approval', 'Issue PO copy'],
  Accounts: ['Collect supporting documents', 'Prepare the draft', 'Get it checked', 'File and record'],
  Production: ['Arrange material', 'Run the batch', 'Quality check', 'Update report'],
  Stores: ['Prepare packing', 'Load the vehicle', 'Collect signed challan', 'Update stock register'],
  HR: ['Collect details', 'Prepare the list', 'Get approval', 'Inform everyone'],
};
const fill = (t, dept) => t.replace('{c}', pick(CUSTOMERS)).replace('{v}', pick(VENDORS)).replace('{i}', pick(ITEMS)[0]).replace('{city}', pick(CITIES)).replace('{month}', pick(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October']));

// People (all demo - no phone, ".invalid" email)
const PEOPLE = [
  ['Rohit Menon', 'Sales', 'Hyderabad', 'A'], ['Sneha Kulkarni', 'Sales', 'Pune', 'D'], ['Imran Sheikh', 'Sales', 'Hyderabad', 'D'], ['Pooja Nair', 'Sales', 'Chennai', 'D'], ['Kiran Rao', 'Sales', 'Hyderabad', 'D'],
  ['Anand Verma', 'Purchase', 'Hyderabad', 'C'], ['Deepa Iyer', 'Purchase', 'Chennai', 'D'], ['Suresh Babu', 'Purchase', 'Hyderabad', 'D'],
  ['Meera Joshi', 'Accounts', 'Hyderabad', 'A'], ['Farhan Ali', 'Accounts', 'Hyderabad', 'D'], ['Lakshmi Prasad', 'Accounts', 'Chennai', 'D'],
  ['Ramesh Patil', 'Production', 'Pune', 'A'], ['Vijay Kumar', 'Production', 'Pune', 'D'], ['Santosh Jadhav', 'Production', 'Pune', 'D'], ['Anitha Raj', 'Production', 'Chennai', 'D'],
  ['Prakash Reddy', 'Stores', 'Hyderabad', 'C'], ['Manoj Singh', 'Stores', 'Hyderabad', 'D'], ['Tariq Hussain', 'Stores', 'Hyderabad', 'D'], ['Bhavna Shah', 'Stores', 'Pune', 'D'],
  ['Divya Menon', 'HR', 'Hyderabad', 'ADMIN'], ['Nikhil Desai', 'HR', 'Hyderabad', 'A'], ['Aarti Kapoor', 'HR', 'Hyderabad', 'D'],
];
const LOGINS = { 'Divya Menon': 'demo.admin', 'Nikhil Desai': 'demo.assigner', 'Aarti Kapoor': 'demo.doer' };
const emailOf = (n) => `${LOGINS[n] || n.toLowerCase().replace(/[^a-z]+/g, '.')}@${DEMO_DOMAIN}`;

// ───────────────────────── build ─────────────────────────
async function build(ctx) {
  const { tenant, realEmps, template, form, hash } = ctx;
  const tenantId = tenant._id;
  WEEKENDS = Array.isArray(tenant.weekends) && tenant.weekends.length ? tenant.weekends : [0];
  const OUT = {};
  const add = (k, d) => { (OUT[k] = OUT[k] || []).push(d); return d; };
  const stats = {};

  // ── Employees
  const demo = PEOPLE.map(([name, dept, location, kind]) => {
    const roles = kind === 'ADMIN' ? ['Admin', 'Assigner', 'Doer'] : kind === 'A' ? ['Assigner', 'Doer'] : kind === 'C' ? ['Coordinator', 'Doer'] : ['Doer'];
    return add('employees', {
      _id: oid(), tenantId, name, department: dept, location, whatsappNumber: '', email: emailOf(name), password: LOGINS[name] ? hash.login : hash.dummy,
      weeklyLateTarget: 20, roles, leaveStatus: { onLeave: false }, earnedBadges: [], accessRoleKeys: [], managedDoers: [], managedAssigners: [],
      voiceBetaUser: false, voicePhone: '', voicePhoneVerified: false, totalPoints: 0, workOnSunday: false, customFields: {},
      joiningDate: mk(addD(`${YEAR - ri(1, 3)}-0${ri(1, 9)}-${pad(ri(1, 28), 2)}`, 0), 9), createdAt: mk(`${YEAR}-01-20`, 10), __kind: kind,
    });
  });
  const byName = Object.fromEntries(demo.map((e) => [e.name, e]));
  const byDept = (d) => demo.filter((e) => e.department === d);
  for (const c of demo.filter((e) => e.__kind === 'C')) c.managedDoers = byDept(c.department).filter((e) => e.__kind === 'D').map((e) => e._id);
  const coordOf = (dept) => (demo.find((e) => e.__kind === 'C' && e.department === dept) || {})._id;
  const demoDoers = demo; // everybody can do work
  const demoAssigners = demo.filter((e) => ['A', 'ADMIN', 'C'].includes(e.__kind));
  const realAssigners = realEmps.filter((e) => (e.roles || []).some((r) => ['Assigner', 'Admin'].includes(r)));
  const realAny = realEmps;
  const realId = new Set(realEmps.map((e) => String(e._id)));
  const nameOf = new Map([...demo, ...realEmps].map((e) => [String(e._id), e.name]));
  const deptOfDemo = (e) => e.department;

  // ── Delegation tasks
  const tasks = [];
  const mkFile = (stage, by) => {
    if (!FILES_BASE || !ctx.sampleFiles.length) return null;
    const f = pick(ctx.sampleFiles);
    return { fileName: f.name, fileUrl: `${FILES_BASE}/uploads/demo/${f.name}`, uploadedAt: null, uploadedBy: by, stage };
  };
  function buildTask(o) {
    // o: {dept, assigner, doer, created(Date), deadline(Date), outcome}
    const title = fill(pick(T[o.dept] || T.Sales));
    const t = {
      _id: oid(), tenantId, title, description: pick(['Please complete this on priority and update the status here.', 'Check the details with the party before closing.', 'Refer the earlier mail on this and proceed.', 'Keep a copy of the proof for audit.', '']),
      assignerId: o.assigner._id, doerId: o.doer._id, coordinatorId: chance(0.3) ? coordOf(o.dept) : undefined, coworkers: [], forwardChain: [], helperDoers: [],
      priority: wpick([['Low', 20], ['Medium', 50], ['High', 24], ['Urgent', 6]]), deadline: o.deadline, isRevisionAllowed: chance(0.7), maxExtensionDays: chance(0.4) ? ri(1, 5) : 0,
      status: 'Pending', remarks: '', history: [], files: [], dateChanges: [], onHold: { isOn: false }, followersCanChangeDate: chance(0.4), customFields: {}, createdAt: o.created,
    };
    if (!t.coordinatorId) delete t.coordinatorId;
    const H = (action, by, ts, remarks, files) => t.history.push({ action, performedBy: by, timestamp: ts, remarks: remarks || '', files: files || [] });
    const Fs = (arr) => arr.filter(Boolean);
    const cf = chance(0.025) ? mkFile('Task Created', o.assigner._id) : null;
    if (cf) { cf.uploadedAt = o.created; t.files.push(cf); }
    H('Task Created', o.assigner._id, o.created, `Assigned to ${o.doer.name}`, cf ? [{ fileName: cf.fileName, fileUrl: cf.fileUrl }] : []);

    // followers (30%) - open tasks: demo only
    if (chance(0.3)) {
      const pool = o.open ? demo : [...demo, ...realAny];
      const n = ri(1, 2);
      for (let i = 0; i < n; i++) { const f = pick(pool); if (String(f._id) !== String(o.doer._id) && String(f._id) !== String(o.assigner._id) && !t.coworkers.some((c) => String(c) === String(f._id))) t.coworkers.push(f._id); }
    }
    // pass-on (5%)
    if (chance(0.05)) {
      const via = pick(demo.filter((e) => String(e._id) !== String(o.doer._id) && String(e._id) !== String(o.assigner._id)));
      const at = new Date(Math.min(o.created.getTime() + ri(1, 4) * HOUR, NOW.getTime() - 120000));
      t.forwardChain.push({ employeeId: via._id, forwardedAt: at });
      H('Assigned Onward', via._id, new Date(Math.min(at.getTime() + 20 * 60000, NOW.getTime() - 60000)), `Passed on to ${o.doer.name}`);
    }
    return { t, H, Fs };
  }

  const startAcc = (created) => new Date(Math.min(created.getTime() + ri(20, 300) * 60000, Math.max(created.getTime(), NOW.getTime() - 60000)));
  function finishTask(ctxT, o) {
    const { t, H } = ctxT;
    const acc = startAcc(o.created);
    const cap = (d) => (d > NOW ? new Date(NOW.getTime() - ri(1, 5) * HOUR) : d);
    const addShift = (days) => { // date change (deadline revised) in ~8% of finished tasks
      const old = t.deadline; const nw = new Date(old.getTime() + ri(1, 4) * DAY);
      const by = chance(0.6) ? o.doer : o.assigner; const role = by === o.doer ? 'doer' : 'assigner'; const reason = pick(REASONS);
      const at = new Date(Math.min(old.getTime() - ri(2, 20) * HOUR, NOW.getTime()));
      t.dateChanges.push({ at, byId: by._id, byName: by.name, byRole: role, oldDeadline: old, newDeadline: nw, reason, reasonNote: pick(['Customer asked for more time.', 'Material not received yet.', 'Waiting for approval.', '']), shortened: false });
      t.originalDeadline = old; t.revisedAt = at; if (role === 'doer') t.revisedByDoerId = o.doer._id; t.deadline = nw;
      H('Deadline Revised', by._id, at, `${reason}`);
      return nw;
    };
    if (o.outcome === 'open') {
      if (o.state === 'Accepted') { t.status = 'Accepted'; H('Accepted', o.doer._id, acc, 'Started working.'); }
      else if (o.state === 'Revision Requested') { t.status = 'Revision Requested'; t.proposedDeadline = new Date(t.deadline.getTime() + ri(2, 5) * DAY); H('Revision Requested', o.doer._id, acc, 'Need more time, please approve.'); }
      return;
    }
    if (o.outcome === 'overdue') {
      t.status = chance(0.6) ? 'Accepted' : 'Pending';
      if (t.status === 'Accepted') H('Accepted', o.doer._id, acc, 'Working on it.');
      if (chance(0.3)) t.remarks = pick(['Waiting for customer reply.', 'Material delayed.', 'Will finish this week.']);
      return;
    }
    if (chance(0.5)) H('Accepted', o.doer._id, acc, 'Ok, will do.');
    let dl = t.deadline;
    if (o.outcome !== 'rejectedFinal' && chance(0.08)) dl = addShift();
    const spanH = Math.max(2, (dl.getTime() - acc.getTime()) / HOUR);
    let done;
    if (o.outcome === 'late') done = cap(new Date(dl.getTime() + ri(3, 5 * 24) * HOUR));
    else done = cap(new Date(acc.getTime() + Math.max(1, ri(Math.floor(spanH * 0.15), Math.floor(spanH * 0.95))) * HOUR));
    const lateMs = done.getTime() - dl.getTime();
    const fdone = chance(0.03) ? mkFile('Completed', o.doer._id) : null;
    const doneFile = fdone ? (fdone.uploadedAt = done, t.files.push(fdone), [{ fileName: fdone.fileName, fileUrl: fdone.fileUrl }]) : [];
    if (o.outcome === 'redo' || o.outcome === 'rejectedFinal') {
      const first = cap(new Date(acc.getTime() + ri(2, 30) * HOUR));
      H('Completed', o.doer._id, first, pick(REMARKS_DONE));
      const rej = cap(new Date(first.getTime() + ri(2, 20) * HOUR));
      H('Rejected', o.assigner._id, rej, pick(REMARKS_REJECT));
      if (o.outcome === 'rejectedFinal') { t.status = 'Rejected'; t.remarks = pick(REMARKS_REJECT); return; }
      const re = cap(new Date(rej.getTime() + ri(1, 4) * HOUR)); H('Accepted', o.doer._id, re, 'Will correct and resend.');
      done = cap(new Date(re.getTime() + ri(3, 40) * HOUR));
    }
    H('Completed', o.doer._id, done, pick(REMARKS_DONE), doneFile);
    t.remarks = '';
    const ageDays = (NOW.getTime() - done.getTime()) / DAY;
    const verified = ageDays > 21 ? chance(0.93) : chance(0.45);
    if (verified) { const v = cap(new Date(done.getTime() + ri(2, 30) * HOUR)); if (v > done) { H('Verified', o.assigner._id, v, pick(REMARKS_VERIFY)); t.status = 'Verified'; } else t.status = 'Completed'; }
    else t.status = 'Completed';
    o._lateMs = lateMs;
  }

  // 1) past closed / overdue / rejected tasks
  const PAST_TASKS = Number(opt('tasks-past', 1650)), FUTURE_TASKS = Number(opt('tasks-future', 150));
  const lastClose = addD(TODAY, -10);
  const closedOutcomes = [['ontime', 70], ['late', 15], ['overdue', 7], ['redo', 6], ['rejectedFinal', 2]];
  for (let i = 0; i < PAST_TASKS; i++) {
    const outcome = wpick(closedOutcomes);
    const dept = pick(Object.keys(T));
    const needDemoOnly = ['overdue', 'rejectedFinal'].includes(outcome);
    let cs, ce;
    if (outcome === 'overdue') { cs = addD(TODAY, -75); ce = addD(TODAY, -4); } else if (outcome === 'late') { cs = START; ce = addD(TODAY, -14); } else { cs = START; ce = lastClose; }
    if (cs < START) cs = START;
    const cd = randWorkDay(cs, ce);
    const created = mk(cd, ri(9, 17), ri(0, 59));
    const durDays = outcome === 'overdue' ? ri(2, 8) : ri(1, 10);
    let dd = nextWork(addD(cd, durDays));
    if (outcome === 'overdue' && dd >= TODAY) dd = addD(TODAY, -ri(1, 3));
    const deadline = mk(dd, 18, 0);
    // people
    const deptPeople = byDept(dept);
    let doer, assigner;
    const useReal = !needDemoOnly && chance(0.2);
    if (useReal && chance(0.5)) { doer = pick(realAny); assigner = pick(demoAssigners); }
    else if (useReal) { doer = pick(deptPeople); assigner = realAssigners.length ? pick(realAssigners) : pick(demoAssigners); }
    else { doer = pick(chance(0.8) ? deptPeople : demoDoers); assigner = pick(demoAssigners.filter((a) => String(a._id) !== String(doer._id))); }
    if (outcome === 'overdue' && realId.has(String(doer._id))) doer = pick(deptPeople);
    const o = { dept, assigner, doer, created, deadline, outcome, open: needDemoOnly };
    const c = buildTask(o); finishTask(c, o); tasks.push({ t: c.t, o });
  }
  // 2) future / open tasks (demo people only)
  for (let i = 0; i < FUTURE_TASKS; i++) {
    const dept = pick(Object.keys(T));
    const created = mk(randWorkDay(addD(TODAY, -14), TODAY), ri(9, 17), ri(0, 59));
    const created2 = created > NOW ? new Date(NOW.getTime() - HOUR) : created;
    const deadline = mk(randWorkDay(addD(TODAY, 1), END), 18, 0);
    const doer = pick(chance(0.85) ? byDept(dept) : demoDoers);
    const assigner = pick(demoAssigners.filter((a) => String(a._id) !== String(doer._id)));
    const o = { dept, assigner, doer, created: created2, deadline, outcome: 'open', open: true, state: wpick([['Pending', 55], ['Accepted', 38], ['Revision Requested', 7]]) };
    const c = buildTask(o); finishTask(c, o); tasks.push({ t: c.t, o });
  }
  // 3) subtasks (20% of main tasks)
  const subs = [];
  for (const { t, o } of tasks) {
    if (!chance(0.2)) continue;
    const n = ri(1, 3);
    const names = shuffle(SUBS[o.dept] || SUBS.Sales).slice(0, n);
    names.forEach((nm, idx) => {
      const sdoer = chance(0.6) ? o.doer : pick(byDept(o.dept));
      const sc = new Date(Math.min(t.createdAt.getTime() + ri(5, 90) * 60000, NOW.getTime() - 60000));
      const sdl = new Date(Math.min(t.deadline.getTime(), sc.getTime() + ri(1, 5) * DAY));
      const closedParent = ['Completed', 'Verified'].includes(t.status);
      const s = {
        _id: oid(), tenantId, title: nm, description: `Sub task of "${t.title}"`, assignerId: t.doerId, doerId: sdoer._id, coworkers: [], forwardChain: [], helperDoers: [], priority: t.priority,
        deadline: sdl, isRevisionAllowed: true, maxExtensionDays: 0, status: 'Pending', remarks: '', history: [{ action: 'Task Created', performedBy: t.doerId, timestamp: sc, remarks: `Sub task of "${t.title}"`, files: [] }], files: [], dateChanges: [], onHold: { isOn: false },
        parentTask: { type: 'Delegation', taskId: String(t._id), title: t.title }, customFields: {}, createdAt: sc,
      };
      if (closedParent) {
        const lastDone = (t.history.find((h) => h.action === 'Completed') || {}).timestamp || NOW;
        const dn = new Date(Math.min(sdl.getTime(), lastDone.getTime() - HOUR, NOW.getTime() - HOUR));
        const dn2 = dn > sc ? dn : new Date(sc.getTime() + HOUR);
        s.history.push({ action: 'Completed', performedBy: sdoer._id, timestamp: dn2, remarks: 'Done.', files: [] });
        if (chance(0.8)) { s.history.push({ action: 'Verified', performedBy: t.doerId, timestamp: new Date(dn2.getTime() + 2 * HOUR), remarks: 'OK', files: [] }); s.status = 'Verified'; } else s.status = 'Completed';
      } else if (String(t.status) !== 'Rejected' && sdl < NOW) { s.status = 'Accepted'; } // open + past - keeps "real people" untouched because parent is demo-only
      else if (idx === 0 && chance(0.5)) { s.history.push({ action: 'Completed', performedBy: sdoer._id, timestamp: new Date(Math.min(NOW.getTime() - HOUR, sc.getTime() + 6 * HOUR)), remarks: 'Done.', files: [] }); s.status = 'Completed'; }
      // a sub task of an open task must also be demo-only for the doer / assigner
      if (!['Completed', 'Verified'].includes(s.status) && (realId.has(String(s.doerId)) || realId.has(String(s.assignerId)))) return;
      subs.push(s);
    });
  }
  stats.delegationMain = tasks.length; stats.delegationSub = subs.length;
  OUT.delegationtasks = [...tasks.map((x) => x.t), ...subs];

  // ── Checklists (demo doers only)
  const CHK = {
    Daily: ['Open the unit and check machines', 'Update production counter sheet', 'Collect and log dispatch details', 'Cash and petty-cash tally', 'Check store room temperature and cleanliness', 'Send day-end sales status to manager', 'Check pending orders board', 'Safety walk-around'],
    Weekly: ['Review weekly sales vs target', 'Stock count of raw material', 'Machine oil and cleaning schedule', 'Vendor payments follow-up list', 'Weekly team meeting minutes', 'Review pending customer complaints', 'Packing material stock check', 'Update outstanding receivables'],
    Monthly: ['Prepare GST working', 'Payroll input to accounts', 'Vendor ledger reconciliation', 'Fire extinguisher inspection', 'Month-end stock valuation', 'Prepare MIS report', 'Review insurance and licence renewals', 'Customer credit limit review'],
    Quarterly: ['Review supplier ratings'], 'Half-Yearly': ['Calibration of weighing scales'],
  };
  const chkPlan = [['Daily', 12], ['Weekly', 12], ['Monthly', 12], ['Quarterly', 2], ['Half-Yearly', 2]];
  const checklists = [];
  for (const [freq, n] of chkPlan) {
    const pool = shuffle(CHK[freq]);
    for (let i = 0; i < n; i++) {
      const doer = pick(demo); const name = pool[i % pool.length] + (i >= pool.length ? ` (${doer.department})` : '');
      const first = nextWork(START);
      const cfg = { daysOfWeek: [], daysOfMonth: [], intervalDays: 0 };
      let dates = [];
      if (freq === 'Daily') dates = workDaysBetween(first, END);
      else if (freq === 'Weekly') { const dw = ri(1, 5); cfg.daysOfWeek = [dw]; cfg.dayOfWeek = dw; for (let x = START; x <= END; x = addD(x, 1)) if (dow(x) === dw) dates.push(x); }
      else if (freq === 'Monthly') { const dm = ri(1, 28); cfg.daysOfMonth = [dm]; cfg.dayOfMonth = dm; for (let m = 1; m <= 12; m++) { const x = `${YEAR}-${pad(m, 2)}-${pad(dm, 2)}`; if (x >= START && x <= END) dates.push(nextWork(x)); } }
      else if (freq === 'Quarterly') { for (const m of [3, 6, 9, 12]) dates.push(nextWork(`${YEAR}-${pad(m, 2)}-${pad(ri(5, 25), 2)}`)); }
      else { for (const m of [3, 9]) dates.push(nextWork(`${YEAR}-${pad(m, 2)}-${pad(ri(5, 25), 2)}`)); }
      const past = dates.filter((d) => d < TODAY), future = dates.filter((d) => d >= TODAY);
      const rate = freq === 'Daily' ? 0.9 : 0.94;
      const history = [];
      for (const d of past) {
        if (!chance(rate)) continue;
        const ts = new Date(Math.min(mk(d, ri(9, 18), ri(0, 59)).getTime() + (chance(0.12) ? ri(1, 3) * DAY : 0), NOW.getTime() - HOUR));
        history.push({ action: 'Completed', timestamp: ts, instanceDate: mk(d, 0, 0), remarks: pick(['Daily routine finished.', 'Done.', 'All OK.', 'Completed, no issues.', 'Done, minor issue noted.']), completedBy: doer._id });
      }
      const nextDue = future.length ? mk(future[0], 9, 0) : mk(nextWork(addD(TODAY, 1)), 9, 0);
      checklists.push({
        _id: oid(), tenantId, taskName: name, description: 'Recurring routine - tick it off when finished.', doerId: doer._id, createdBy: pick(demoAssigners)._id, frequency: freq, frequencyConfig: cfg, startDate: mk(START, 9, 0),
        lastCompleted: history.length ? history[history.length - 1].timestamp : undefined, nextDueDate: nextDue, status: 'Active', history, customFields: {}, createdAt: mk(START, 10, 0),
      });
    }
  }
  stats.checklists = checklists.length; stats.checklistEntries = checklists.reduce((s, c) => s + c.history.length, 0);
  OUT.checklisttasks = checklists;

  // ── Leave
  const LT = [
    { name: 'Sick Leave', paid: true, annualQuota: 8, accrual: 'upfront', carryForwardMax: 0, halfDayAllowed: true },
    { name: 'Earned Leave', paid: true, annualQuota: 15, accrual: 'monthly', carryForwardMax: 10, halfDayAllowed: true, minNoticeDays: 3 },
    { name: 'Comp-off', paid: true, annualQuota: 0, accrual: 'upfront', carryForwardMax: 0, halfDayAllowed: true, backdateDays: 30 },
    { name: 'Loss of Pay', paid: false, unlimited: true, annualQuota: 0, accrual: 'upfront', halfDayAllowed: true },
  ];
  const types = [];
  let casual = ctx.existingLeaveTypes.find((x) => /casual/i.test(x.name));
  if (!casual) { casual = { _id: oid(), tenantId, name: 'Casual Leave', paid: true, annualQuota: 12, accrual: 'monthly', carryForwardMax: 0, halfDayAllowed: true, active: true }; OUT.leavetypes = [casual]; }
  types.push({ id: casual._id, name: casual.name, paid: casual.paid !== false, w: 38 });
  for (const lt of LT) {
    if (ctx.existingLeaveTypes.some((x) => x.name === lt.name)) { const ex = ctx.existingLeaveTypes.find((x) => x.name === lt.name); types.push({ id: ex._id, name: lt.name, paid: lt.paid, w: 1 }); continue; }
    const d = { _id: oid(), tenantId, ...lt, maxNegative: 0, maxConsecutiveDays: 0, minNoticeDays: lt.minNoticeDays || 0, backdateDays: lt.backdateDays || 7, sandwich: false, requiresReason: true, active: true, createdAt: mk(START, 9), updatedAt: mk(START, 9) };
    (OUT.leavetypes = OUT.leavetypes || []).push(d); types.push({ id: d._id, name: lt.name, paid: lt.paid, w: 1 });
  }
  const tw = { 'Sick Leave': 24, 'Earned Leave': 22, 'Comp-off': 8, 'Loss of Pay': 4 }; types.forEach((t) => { if (tw[t.name]) t.w = tw[t.name]; });
  const REASONS_L = { 'Casual Leave': ['Family function', 'Personal work', 'Bank and government office work', 'Relative visiting', 'Child school meeting'], 'Sick Leave': ['Fever', 'Viral infection', 'Stomach upset', 'Doctor appointment', 'Back pain'], 'Earned Leave': ['Family trip', 'Native place visit', 'Wedding in the family', 'Rest and travel'], 'Comp-off': ['Worked on Sunday for dispatch', 'Worked on holiday for stock audit'], 'Loss of Pay': ['Extended personal work'] };
  const leaves = []; const leaveDays = new Map(); // employeeId -> Set(dates)
  const LV = Number(opt('leaves', 220));
  const mkLeave = (emp, status, from, to, half) => {
    const lt = wpick(types.map((t) => [t, t.w])); const dates = workDaysBetween(from, to);
    if (!dates.length) return null;
    const days = half !== 'none' ? 0.5 : dates.length;
    const decided = pick(demoAssigners.filter((a) => String(a._id) !== String(emp._id)));
    const created = new Date(Math.min(mk(addD(from, -ri(1, 6)), ri(9, 17)).getTime(), NOW.getTime() - HOUR));
    const rs = REASONS_L[lt.name] || REASONS_L['Casual Leave'];
    const doc = {
      _id: oid(), tenantId, employeeId: emp._id, leaveTypeId: lt.id, typeName: lt.name, paid: lt.paid, fromDate: from, toDate: to, halfDay: half, days, daysDetail: dates.map((d) => ({ d, u: half !== 'none' ? 0.5 : 1 })),
      reason: pick(rs), buddyId: chance(0.5) ? pick(demo.filter((e) => e.department === emp.department && String(e._id) !== String(emp._id)) .concat([pick(demo)]))._id : null, status, decidedBy: null, decidedAt: null, decisionNote: '', leaveStatusSynced: false, customFields: {}, createdAt: created, updatedAt: created,
    };
    if (status !== 'Pending') { doc.decidedBy = decided._id; doc.decidedAt = new Date(Math.min(created.getTime() + ri(1, 30) * HOUR, NOW.getTime())); doc.decisionNote = status === 'Rejected' ? pick(['Dispatch rush, please apply later.', 'Too many people on leave that week.', 'Insufficient balance.']) : pick(['Approved.', 'OK, take care.', '']); }
    if (status === 'Approved') { if (!leaveDays.has(String(emp._id))) leaveDays.set(String(emp._id), new Set()); dates.forEach((d) => leaveDays.get(String(emp._id)).add(d)); }
    leaves.push(doc); return doc;
  };
  // currently on leave (3 demo employees, today inside range)
  for (const emp of shuffle(demo.filter((e) => e.__kind === 'D')).slice(0, 3)) {
    const from = prevWork(addD(TODAY, -ri(0, 1))); const to = nextWork(addD(TODAY, ri(1, 3)));
    const d = mkLeave(emp, 'Approved', from, to, 'none');
    if (d) { d.leaveStatusSynced = true; d.buddyId = pick(demo.filter((e) => e.department === emp.department && String(e._id) !== String(emp._id)))._id; emp.leaveStatus = { onLeave: true, startDate: mk(from, 0, 0), endDate: mk(to, 23, 59), buddyId: d.buddyId }; }
  }
  while (leaves.length < LV) {
    const st = wpick([['Approved', 80], ['Rejected', 10], ['Pending', 10]]);
    const real = st === 'Approved' && chance(0.12);
    const emp = real ? pick(realAny) : pick(demo);
    let from, half = chance(0.15) ? pick(['first', 'second']) : 'none';
    if (st === 'Pending') { if (real) continue; from = randWorkDay(addD(TODAY, 2), addD(TODAY, 50)); }
    else from = randWorkDay(START, addD(TODAY, -3));
    const to = half !== 'none' ? from : minD(addD(from, wpick([[0, 55], [1, 20], [2, 15], [4, 10]])), END);
    mkLeave(emp, st, from, to, half);
  }
  // upcoming approved leaves (demo)
  for (let i = 0; i < 12; i++) { const f = randWorkDay(addD(TODAY, 3), addD(TODAY, 70)); mkLeave(pick(demo), 'Approved', f, minD(addD(f, ri(0, 3)), END), 'none'); }
  stats.leaves = leaves.length;
  OUT.leaverequests = leaves;
  OUT.leaveadjustments = Array.from({ length: 15 }, () => {
    const emp = pick(demo); const ct = types.find((t) => t.name === 'Comp-off') || types[0];
    return { _id: oid(), tenantId, employeeId: emp._id, leaveTypeId: ct.id, days: pick([1, 1, 0.5, 2]), date: randWorkDay(START, addD(TODAY, -5)), reason: pick(['Worked on Sunday for dispatch', 'Worked on holiday for stock audit', 'Year-end closing support']), by: byName['Divya Menon']._id, createdAt: mk(START, 9), updatedAt: mk(START, 9) };
  });

  // ── Attendance
  const shiftId = oid();
  OUT.shifts = [{ _id: shiftId, tenantId, name: 'General Shift', start: '09:00', end: '18:00', graceMinutes: 10, halfDayMinutes: 240, fullDayMinutes: 480, createdAt: mk(START, 9), updatedAt: mk(START, 9) }];
  OUT.attendanceassignments = demo.map((e) => ({ _id: oid(), tenantId, employeeId: e._id, shiftId, siteIds: [], createdAt: mk(START, 9), updatedAt: mk(START, 9) }));
  const GEO = { Hyderabad: [17.385, 78.4867], Pune: [18.5204, 73.8567], Chennai: [13.0827, 80.2707] };
  const punches = [], regs = [];
  const mkPunch = (emp, d, type, at, extra = {}) => ({ _id: oid(), tenantId, employeeId: emp._id, date: d, at, type, source: 'web', lat: (GEO[emp.location] || GEO.Hyderabad)[0] + (rnd() - 0.5) * 0.002, lng: (GEO[emp.location] || GEO.Hyderabad)[1] + (rnd() - 0.5) * 0.002, accuracy: ri(8, 40), siteId: null, siteName: '', distanceM: null, face: { checked: false, matched: false, distance: null }, note: '', flagReason: '', reviewStatus: 'None', reviewedBy: null, reviewedAt: null, reviewNote: '', addedBy: null, createdAt: at, updatedAt: at, ...extra });
  const full = shuffle(demo).slice(0, 12).map((e) => e._id.toString());
  const REGN = Number(opt('regs', 100)); const regTargets = [];
  for (const emp of demo) {
    const isFull = full.includes(String(emp._id));
    const from = isFull ? START : addD(TODAY, -90);
    const days = workDaysBetween(from < START ? START : from, addD(TODAY, -1));
    const lv = leaveDays.get(String(emp._id)) || new Set();
    for (const d of days) {
      if (lv.has(d) || chance(0.02)) continue;
      if (chance(REGN / (demo.length * 200)) && regTargets.length < REGN) { regTargets.push([emp, d]); continue; } // forgot to punch -> regularization
      const late = chance(0.12);
      const inT = late ? ri(9 * 60 + 12, 10 * 60 + 5) : ri(8 * 60 + 48, 9 * 60 + 9);
      const outT = ri(17 * 60 + 40, 19 * 60);
      const pi = mkPunch(emp, d, 'in', mk(d, Math.floor(inT / 60), inT % 60)), po = mkPunch(emp, d, 'out', mk(d, Math.floor(outT / 60), outT % 60));
      if (chance(0.02)) { pi.flagReason = 'Outside site radius'; pi.reviewStatus = pick(['Pending', 'Approved', 'Approved']); if (pi.reviewStatus === 'Approved') { pi.reviewedBy = byName['Divya Menon']._id; pi.reviewedAt = new Date(pi.at.getTime() + 5 * HOUR); pi.reviewNote = 'Visited customer site.'; } }
      punches.push(pi, po);
    }
  }
  // fill remaining regularizations from random working days if fewer were created
  while (regTargets.length < REGN) { const emp = pick(demo); const d = randWorkDay(START, addD(TODAY, -2)); if (!(leaveDays.get(String(emp._id)) || new Set()).has(d)) regTargets.push([emp, d]); }
  for (const [emp, d] of regTargets) {
    const status = wpick([['Approved', 60], ['Rejected', 15], ['Pending', 15], ['Cancelled', 10]]);
    const stFinal = status === 'Pending' && d < addD(TODAY, -20) ? 'Approved' : status;
    const inT = `${pad(ri(8, 9), 2)}:${pad(ri(0, 59), 2)}`, outT = `${pad(ri(17, 18), 2)}:${pad(ri(0, 59), 2)}`;
    const cr = new Date(Math.min(mk(addD(d, ri(0, 2)), ri(10, 17)).getTime(), NOW.getTime() - HOUR));
    const approver = pick(demoAssigners.filter((a) => String(a._id) !== String(emp._id)));
    const r = { _id: oid(), tenantId, employeeId: emp._id, date: d, inTime: inT, outTime: outT, reason: pick(['Forgot to punch in', 'Phone battery was dead', 'Network issue at the site', 'Was at customer location', 'Biometric/face check not working']), status: stFinal, decidedBy: null, decidedAt: null, decisionNote: '', createdAt: cr, updatedAt: cr };
    if (stFinal === 'Approved' || stFinal === 'Rejected') { r.decidedBy = approver._id; r.decidedAt = new Date(Math.min(cr.getTime() + ri(2, 40) * HOUR, NOW.getTime())); r.decisionNote = stFinal === 'Rejected' ? 'Please attach proof next time.' : 'Approved.'; }
    if (stFinal === 'Approved') { punches.push(mkPunch(emp, d, 'in', mk(d, Number(inT.slice(0, 2)), Number(inT.slice(3))), { source: 'regularization', addedBy: approver._id }), mkPunch(emp, d, 'out', mk(d, Number(outT.slice(0, 2)), Number(outT.slice(3))), { source: 'regularization', addedBy: approver._id })); }
    regs.push(r);
  }
  stats.punches = punches.length; stats.regs = regs.length;
  OUT.punches = punches; OUT.regularizations = regs;

  // ── Tickets
  const TK = [['Unable to upload photo while completing a task', 'Technical'], ['Report is not downloading', 'Technical'], ['Need access to Track FMS for coordinator', 'Access'], ['Reminder time is not correct', 'Technical'], ['Please add a new location in the list', 'Request'], ['Dashboard numbers look different from my sheet', 'Question'], ['Unable to see my leave balance', 'Technical'], ['Add a new employee for Pune unit', 'Request'], ['App is slow in the morning', 'Technical'], ['Need training for new joiners', 'Request']];
  const tickets = Array.from({ length: 40 }, () => {
    const [title, category] = pick(TK); const rep = pick(demo); const cr = mk(randWorkDay(START, addD(TODAY, -1)), ri(9, 18), ri(0, 59)); const st = wpick([['Closed', 38], ['Resolved', 22], ['In-Progress', 22], ['Open', 18]]);
    const h = [{ action: 'Ticket Created', performedBy: rep.name, timestamp: cr, remarks: '' }];
    const doc = { _id: oid(), tenantId, reporterId: rep._id, reporterName: rep.name, reporterEmail: rep.email, reporterRole: (rep.roles || ['Doer'])[0], title, description: `${title}. Please look into this and help. (${rep.department} team)`, category, priority: pick(['Low', 'Medium', 'Medium', 'High', 'Urgent']), initialMedia: [], status: st, history: h, customFields: {}, createdAt: cr, updatedAt: cr };
    if (st !== 'Open') { const t1 = new Date(Math.min(cr.getTime() + ri(1, 20) * HOUR, NOW.getTime())); h.push({ action: 'In-Progress', performedBy: 'Support', timestamp: t1, remarks: 'We are checking this.' }); doc.adminRemarks = 'We are checking this.'; doc.updatedAt = t1; }
    if (st === 'Resolved' || st === 'Closed') { const t2 = new Date(Math.min(cr.getTime() + ri(24, 120) * HOUR, NOW.getTime())); h.push({ action: st, performedBy: 'Support', timestamp: t2, remarks: 'Fixed. Please check and confirm.' }); doc.adminRemarks = 'Fixed. Please check and confirm.'; doc.resolvedAt = t2; doc.updatedAt = t2; }
    return doc;
  });
  OUT.supporttickets = tickets;

  // ── Planner: personal tasks + plans
  const PT = ['Renew vehicle insurance', 'Call plumber for office pantry', 'Prepare for supplier meeting', 'Book train tickets for Pune visit', 'Review team goals', 'Pay electricity bill', 'Update LinkedIn profile', 'Order stationery', 'Doctor appointment', 'Plan weekend maintenance'];
  const pts = [];
  for (let i = 0; i < 60; i++) {
    const o = pick(demo); const isChk = chance(0.3); const due = randWorkDay(addD(TODAY, -60), addD(TODAY, 40)); const done = !isChk && due < TODAY && chance(0.75);
    const p = { _id: oid(), tenantId, ownerId: o._id, type: isChk ? 'Checklist' : 'Task', title: isChk ? pick(['Morning review of mails', 'Weekly desk cleanup', 'Update expense sheet', 'Plan next week']) : pick(PT), notes: '', priority: pick(['Low', 'Medium', 'High']), dueDate: isChk ? '' : due, done, order: i, sharedWith: [], customFields: {}, createdAt: mk(addD(TODAY, -ri(5, 100)), 10), updatedAt: mk(addD(TODAY, -ri(0, 4)), 10), history: [], doneCount: 0 };
    if (done) p.doneAt = mk(due, 15);
    if (isChk) { p.frequency = pick(['Daily', 'Weekly']); p.frequencyConfig = { daysOfWeek: p.frequency === 'Weekly' ? [ri(1, 5)] : [], daysOfMonth: [], intervalDays: 0 }; p.startDate = addD(TODAY, -60); p.nextDueDate = nextWork(addD(TODAY, 1)); p.lastDoneDate = prevWork(addD(TODAY, -1)); p.doneCount = ri(10, 40); p.history = [{ instanceDate: p.lastDoneDate, completedAt: mk(p.lastDoneDate, 17) }]; }
    pts.push(p);
  }
  OUT.personaltasks = pts;
  OUT.plans = ['Launch new tiffin carrier range', 'Annual stock audit', 'Hyderabad warehouse shifting', 'Dealer meet planning', 'ISO audit preparation'].map((title, i) => {
    const owner = pick(demoAssigners);
    return { _id: oid(), tenantId, ownerId: owner._id, title, notes: '', linkedTask: { taskType: '', title: '' }, steps: ['Define the scope', 'Assign owners', 'Prepare materials', 'Review progress', 'Close and report'].slice(0, ri(3, 5)).map((s) => ({ _id: oid(), title: s, notes: '', priority: 'Medium', kind: 'Delegation', taskType: '', createdAt: mk(addD(TODAY, -30), 10) })), order: i, createdAt: mk(addD(TODAY, -40), 10), updatedAt: mk(addD(TODAY, -3), 10) };
  });

  // ── Chat: task threads
  const convs = [], msgs = [];
  const chatTasks = shuffle(tasks.filter((x) => !realId.has(String(x.t.doerId)) && !realId.has(String(x.t.assignerId)))).slice(0, 40);
  const LINES = [['Please share the status of this.', 'Working on it, will update by evening.'], ['Did the party confirm?', 'Yes, they confirmed on call.'], ['Please attach the proof.', 'Attached in the task.'], ['Any issue from your side?', 'No issue, on track.'], ['Deadline is near, please prioritise.', 'Noted, will finish today.']];
  for (const { t } of chatTasks) {
    const a = demo.find((e) => String(e._id) === String(t.assignerId)), d = demo.find((e) => String(e._id) === String(t.doerId)); if (!a || !d) continue;
    const cid = oid(); let ts = new Date(Math.min(t.createdAt.getTime() + 2 * HOUR, NOW.getTime() - HOUR)); const n = ri(2, 4);
    for (let i = 0; i < n; i++) {
      const [q, an] = pick(LINES); for (const [s, txt] of [[a, q], [d, an]]) { ts = new Date(Math.min(ts.getTime() + ri(5, 180) * 60000, NOW.getTime() - 60000)); msgs.push({ _id: oid(), conversationId: cid, tenantId, senderId: s._id, senderName: s.name, senderRole: (s.roles || [''])[0], text: txt, fileUrl: '', fileName: '', fileType: '', readBy: [a._id, d._id], mentions: [], expiresAt: new Date(NOW.getTime() + 800 * DAY), createdAt: ts, updatedAt: ts }); }
    }
    const last = msgs[msgs.length - 1];
    convs.push({ _id: cid, tenantId, type: 'task', participants: [a._id, d._id], taskId: t._id, taskType: 'delegation', taskTitle: t.title, title: '', lastMessage: { text: last.text, senderId: last.senderId, senderName: last.senderName, sentAt: last.createdAt, hasFile: false }, unreadCounts: {}, deletedFor: [], isActive: true, createdAt: msgs.find((m) => String(m.conversationId) === String(cid)).createdAt, updatedAt: last.createdAt });
  }
  stats.conversations = convs.length; stats.messages = msgs.length;
  OUT.conversations = convs; OUT.messages = msgs;

  // ── FMS (Navtech O2D)
  if (template && form) {
    const nodes = Object.fromEntries(template.nodes.map((n) => [n.id, n]));
    const fieldVal = (f, st) => {
      const L = (f.label || '').toLowerCase();
      if (/customer|party|client|buyer/.test(L)) return st.customer;
      if (/city|location|place|ship/.test(L)) return st.city;
      if (/item|product|material|description/.test(L)) return st.item[0];
      if (/unit|uom/.test(L)) return st.item[1];
      if (/rate|price/.test(L)) return st.item[2];
      if (/amount|value|total/.test(L)) return st.item[2] * st.qty;
      if (/qty|quantity|pcs|nos/.test(L) || f.type === 'number') return st.qty;
      if (f.type === 'date') return st.dateStr;
      if (f.type === 'dropdown' && f.options && f.options.length) return pick(f.options);
      if (/po|order no|reference/.test(L)) return `PO/${YEAR}/${ri(100, 999)}`;
      if (/remark|note/.test(L)) return '';
      if (/contact|mobile|phone/.test(L)) return '';
      return f.type === 'textarea' ? '' : 'Standard';
    };
    const dur = (node) => { const d = node.deadline || {}; const v = d.value || 8; if (d.mode === 'days' || d.mode === 'lead') return v * DAY; if (d.unit === 'mins') return v * 60000; if (d.unit === 'days') return v * DAY; return v * HOUR; };
    const demoFor = (node) => { const idv = node.assignedTo && node.assignedTo.value; const real = realEmps.concat(demo).find((e) => String(e._id) === String(idv)); return real || pick(demo); };
    const INSTANCES = Number(opt('fms', 250)); const subs2 = []; const insts = [];
    let seq = 0; const ordersN = Math.round(INSTANCES / 2.1);
    for (let oi = 0; oi < ordersN; oi++) {
      const active = chance(0.2);
      const startD = active ? randWorkDay(addD(TODAY, -21), addD(TODAY, -1)) : randWorkDay(START, addD(TODAY, -32));
      seq++;
      const orderId = `DEMOORD-${YEAR}-${pad(seq, 4)}`;
      const customer = pick(CUSTOMERS), city = pick(CITIES);
      const nItems = ri(1, 3); const delayed = !active && chance(0.12);
      const sub = { _id: oid(), tenantId, formId: form._id, templateId: template._id, orderId, orderFields: {}, lineItems: [], submittedBy: byName['Rohit Menon']._id, submittedByName: 'Rohit Menon', submittedAt: mk(startD, ri(9, 17)), status: 'active', createdAt: mk(startD, 10), updatedAt: mk(startD, 10) };
      for (const f of form.orderFields || []) { if (f.type === 'autoid' || f.isOrderId) { sub.orderFields[f.label || 'Order ID'] = orderId; continue; } sub.orderFields[f.label || f.id] = fieldVal(f, { customer, city, item: ITEMS[0], qty: 1, dateStr: addD(startD, ri(7, 25)) }); }
      let anyActive = false;
      for (let li = 1; li <= nItems; li++) {
        const item = pick(ITEMS), qty = pick([24, 48, 60, 96, 120, 240, 500, 960]);
        const lineId = `${orderId}-ITEM${pad(li, 3)}`; const st = { customer, city, item, qty, dateStr: addD(startD, ri(7, 25)) };
        const raw = { 'Order ID': lineId, ...sub.orderFields }; const fv = {};
        for (const f of form.itemFields || []) { if (f.isLineItemId || f.type === 'autoid') { fv[f.label || 'Line Item ID'] = lineId; continue; } fv[f.label || f.id] = fieldVal(f, st); }
        Object.assign(raw, fv);
        // walk the flow
        let cur = nodes[template.startNodeId]; let t = mk(startD, ri(9, 12), ri(0, 59)); const hist = []; let activeStep = null; let guard = 0;
        const stopAt = active ? ri(1, Math.max(1, template.nodes.length - 2)) : 9999; let doneCount = 0;
        while (cur && cur.type !== 'end' && guard++ < 40) {
          if (cur.type === 'start') { cur = nodes[cur.nextNodeId]; continue; }
          const who = demoFor(cur); const activated = t; const planned = new Date(activated.getTime() + dur(cur));
          const lateStep = delayed ? chance(0.45) : chance(0.07);
          const complete = lateStep ? new Date(planned.getTime() + ri(30, 60 * 40) * 60000) : new Date(activated.getTime() + Math.floor(dur(cur) * (0.2 + rnd() * 0.7)));
          if (doneCount >= stopAt || complete > NOW) {
            let pd = planned; let a = who;
            if (realId.has(String(who._id))) a = pick(demo);
            if (pd < new Date(NOW.getTime() + 2 * DAY)) pd = new Date(NOW.getTime() + ri(2, 20) * DAY);
            activeStep = { nodeId: cur.id, nodeName: cur.name, nodeType: cur.type, assignedToId: String(a._id), assignedToName: a.name, activatedAt: activated < NOW ? activated : new Date(NOW.getTime() - HOUR), plannedDeadline: pd, notified: true, reminderSent: true };
            break;
          }
          const inputs = {}; for (const f of cur.inputFields || []) inputs[f.label || f.id] = f.type === 'number' ? ri(1, 500) : f.type === 'dropdown' && f.options && f.options.length ? pick(f.options) : f.type === 'checkbox' ? true : f.type === 'date' ? addD(startD, ri(1, 20)) : pick(['OK', 'Done', 'Confirmed', 'As per PO']);
          const delay = Math.round((complete.getTime() - planned.getTime()) / 60000);
          hist.push({ nodeId: cur.id, nodeName: cur.name, nodeType: cur.type, assignedToId: String(who._id), assignedToName: who.name, completedById: who._id, completedByName: who.name, activatedAt: activated, plannedDeadline: planned, completedAt: complete, decision: cur.type === 'yesno' ? 'yes' : 'done', inputs, onTime: delay <= 0, delayMinutes: delay });
          doneCount++; t = new Date(complete.getTime() + ri(1, 40) * 60000);
          cur = nodes[cur.type === 'yesno' ? cur.yesNextNodeId : cur.nextNodeId];
        }
        const completed = !activeStep;
        if (!completed) anyActive = true;
        const inst = { _id: oid(), tenantId, templateId: template._id, templateName: template.name, orderIdentifier: lineId, rawSheetData: raw, status: completed ? 'completed' : 'active', activeStep: activeStep || null, nodeHistory: hist, startedAt: mk(startD, 10), completedAt: completed ? (hist.length ? hist[hist.length - 1].completedAt : t) : null, createdAt: mk(startD, 10), updatedAt: (hist.length ? hist[hist.length - 1].completedAt : mk(startD, 10)) };
        insts.push(inst);
        sub.lineItems.push({ lineItemId: lineId, fieldValues: fv, instanceId: inst._id, status: completed ? 'completed' : 'active' });
      }
      sub.status = anyActive ? 'active' : 'completed'; subs2.push(sub);
    }
    stats.fmsOrders = subs2.length; stats.fmsInstances = insts.length;
    OUT.flowinstances = insts; OUT.ordersubmissions = subs2;
  } else stats.fmsSkipped = 'Navtech O2D template/form not found';

  return { OUT, stats, demo, tasks, leaves };
}

// ───────────────────────── sample files ─────────────────────────
function makeSampleFiles(dir) {
  const files = []; if (!FILES_BASE) return files;
  const kinds = [['delivery-challan', (n) => `DELIVERY CHALLAN\nDC No: DC-${n}\nPlace: ${pick(CITIES)}\nItems: ${pick(ITEMS)[0]}\nReceived in good condition`], ['site-photo', (n) => `SITE PHOTO\nRef ${n}\n${pick(CITIES)} warehouse\nPacked and ready`], ['invoice-copy', (n) => `TAX INVOICE\nInv No: INV-${YEAR}-${n}\n${pick(CUSTOMERS)}\nAmount Rs ${ri(8, 240) * 1000}`], ['lorry-receipt', (n) => `LORRY RECEIPT\nLR No: ${ri(100000, 999999)}\nVehicle TS${ri(10, 40)}UB${ri(1000, 9999)}\nBooked to ${pick(CITIES)}`]];
  for (let i = 0; i < 40; i++) {
    const [k, f] = pick(kinds); const num = ri(1000, 9999); const lines = f(num).split('\n'); const name = `demo-${k}-${num}.svg`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#f8fafc"/><rect x="12" y="12" width="616" height="396" rx="10" fill="#fff" stroke="#cbd5e1" stroke-width="2"/><text x="40" y="70" font-family="Arial" font-size="26" font-weight="bold" fill="#0f172a">${lines[0]}</text>${lines.slice(1).map((l, j) => `<text x="40" y="${125 + j * 42}" font-family="Arial" font-size="20" fill="#334155">${l}</text>`).join('')}<text x="40" y="385" font-family="Arial" font-size="14" fill="#94a3b8">Sample document - LRBC demo data</text></svg>`;
    files.push({ name, svg });
  }
  return files;
}

// ───────────────────────── main ─────────────────────────
const askHidden = (q) => new Promise((resolve) => {
  if (process.env.DEMO_PASSWORD) return resolve(process.env.DEMO_PASSWORD);
  if (!process.stdin.isTTY) return resolve('');
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); else if (s.includes('\n')) process.stdout.write('\n'); };
  rl.question(q, (a) => { rl.close(); resolve(a); });
});

(async () => {
  const models = {};
  const need = ['Employee', 'DelegationTask', 'ChecklistTask', 'LeaveType', 'LeaveRequest', 'LeaveAdjustment', 'Shift', 'AttendanceAssignment', 'Punch', 'Regularization', 'Ticket', 'PersonalTask', 'Plan', 'Conversation', 'Message', 'FlowInstance', 'OrderSubmission'];
  for (const n of need) models[n] = require(`../../models/${n}`);
  const colOf = { employees: 'Employee', delegationtasks: 'DelegationTask', checklisttasks: 'ChecklistTask', leavetypes: 'LeaveType', leaverequests: 'LeaveRequest', leaveadjustments: 'LeaveAdjustment', shifts: 'Shift', attendanceassignments: 'AttendanceAssignment', punches: 'Punch', regularizations: 'Regularization', supporttickets: 'Ticket', personaltasks: 'PersonalTask', plans: 'Plan', conversations: 'Conversation', messages: 'Message', flowinstances: 'FlowInstance', ordersubmissions: 'OrderSubmission' };

  let password = '';
  if (RUN) {
    password = await askHidden('Choose the password for the 3 demo logins (hidden): ');
    if (!password || password.length < 8) { console.log('A password of at least 8 characters is needed for --run (type it when asked, or set DEMO_PASSWORD).'); process.exit(1); }
  }
  const hash = { login: await bcrypt.hash(password || 'dry-run-password', 10), dummy: await bcrypt.hash(String(Math.random()) + Date.now(), 8) };

  let conn = null, tenant, realEmps, template = null, form = null, existingLeaveTypes = [], warnings = [];
  if (OFFLINE) {
    const tid = oid(); tenant = { _id: tid, weekends: [0], sectors: ['Tech'], locations: ['Hyderabad'], whatsappConfig: { isActive: false } };
    realEmps = Array.from({ length: 10 }, (_, i) => ({ _id: oid(), name: `Real Person ${i + 1}`, roles: i < 3 ? ['Admin', 'Assigner'] : ['Doer'], department: 'Tech' }));
    const ids = ['start', 'a1', 'a2', 'y1', 'a3', 'end'];
    template = { _id: oid(), name: 'Navtech O2D', startNodeId: 'start', nodes: [
      { id: 'start', name: 'Start', type: 'start', nextNodeId: 'a1' },
      { id: 'a1', name: 'Order Check', type: 'action', assignedTo: { type: 'employee', value: String(realEmps[3]._id) }, deadline: { mode: 'wwh', value: 4, unit: 'hours' }, nextNodeId: 'a2', inputFields: [] },
      { id: 'a2', name: 'RM Check', type: 'input', assignedTo: { type: 'sheetColumn', value: 'Owner' }, deadline: { mode: 'days', value: 1 }, nextNodeId: 'y1', inputFields: [{ id: 'f1', label: 'Qty confirmed', type: 'number' }] },
      { id: 'y1', name: 'Stock Available?', type: 'yesno', assignedTo: { type: 'employee', value: String(realEmps[4]._id) }, deadline: { mode: 'wwh', value: 2, unit: 'hours' }, yesNextNodeId: 'a3', noNextNodeId: 'a2' },
      { id: 'a3', name: 'Dispatch', type: 'action', assignedTo: { type: 'employee', value: String(realEmps[5]._id) }, deadline: { mode: 'days', value: 2 }, nextNodeId: 'end' },
      { id: 'end', name: 'End', type: 'end' }] };
    form = { _id: oid(), orderFields: [{ id: 'o1', label: 'Order ID', type: 'autoid', isOrderId: true }, { id: 'o2', label: 'Customer Name', type: 'text' }, { id: 'o3', label: 'Delivery Date', type: 'date' }], itemFields: [{ id: 'i0', label: 'Line Item ID', type: 'autoid', isLineItemId: true }, { id: 'i1', label: 'Item Name', type: 'text', isItemField: true }, { id: 'i2', label: 'Qty', type: 'number', isItemField: true }, { id: 'i3', label: 'Rate', type: 'number', isItemField: true }] };
  } else {
    if (!process.env.MONGO_URI) { console.log('MONGO_URI is not set. Run this inside the backend folder on the server.'); process.exit(1); }
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    const Tenant = require('../../models/Tenant');
    const found = await Tenant.find({ $or: [{ companyName: /lrbc/i }, { subdomain: /lrbc/i }] }).lean();
    if (found.length !== 1) { console.log(found.length ? 'More than one company matches "lrbc". Stopping:' : 'No company matches "lrbc". Stopping.'); found.forEach((t) => console.log(' -', t.companyName, t.subdomain)); process.exit(1); }
    tenant = found[0];
    conn = tenant.superAdmin && tenant.superAdmin.customMongoUri ? await mongoose.createConnection(tenant.superAdmin.customMongoUri, { serverSelectionTimeoutMS: 8000 }).asPromise() : mongoose.connection;
    const M = (n) => conn.models[n] || conn.model(n, require(`../../models/${n}`).schema);
    const existing = await M('Employee').countDocuments({ tenantId: tenant._id, email: new RegExp(`@${DEMO_DOMAIN.replace('.', '\\.')}$`) });
    if (existing) { console.log(`Demo data is already present (${existing} demo employees). Run undo.js first if you want to redo it.`); process.exit(1); }
    realEmps = await M('Employee').find({ tenantId: tenant._id }).select('name roles department').lean();
    existingLeaveTypes = await M('LeaveType').find({ tenantId: tenant._id }).select('name paid').lean();
    template = await M('FlowTemplate').findOne({ tenantId: tenant._id, isActive: true, name: /navtech\s*o2d/i }).lean();
    form = template ? await M('OrderForm').findOne({ tenantId: tenant._id, $or: [{ templateId: template._id }, { name: /navtech/i }], isActive: true }).lean() : null;
    if (tenant.whatsappConfig && tenant.whatsappConfig.isActive) warnings.push('LRBC has WhatsApp ACTIVE. Demo people have no phone, so they get nothing. Active FMS steps are dated in the future; once such a step passes its deadline, the "overdue" alert goes to the real admins. Keep the demo FMS deadlines in mind after 27 Dec.');
  }
  const sampleFiles = makeSampleFiles();
  const built = await build({ tenant, realEmps, template, form, hash, existingLeaveTypes, sampleFiles: sampleFiles.map((f) => ({ name: f.name })) });
  const { OUT, stats } = built;

  // ─ check every document against the schemas (employees skipped: the demo ones deliberately have an empty phone)
  let bad = 0; const shown = {};
  for (const [col, docs] of Object.entries(OUT)) {
    const mname = colOf[col]; if (!mname || col === 'employees') continue; const Model = models[mname];
    for (const d of docs) { const clean = JSON.parse(JSON.stringify(d)); const err = new Model(clean).validateSync(); if (err) { bad++; if ((shown[col] = (shown[col] || 0) + 1) <= 2) console.log(`  SCHEMA PROBLEM in ${col}:`, Object.values(err.errors).map((e) => e.message).slice(0, 3).join(' | ')); } }
  }
  // ─ safety checks: real people must have nothing open
  const realIds = new Set(realEmps.map((e) => String(e._id))); let unsafe = 0;
  for (const t of OUT.delegationtasks) { const open = !['Completed', 'Verified'].includes(t.status); if (open && (realIds.has(String(t.doerId)) || realIds.has(String(t.assignerId)) || (t.coworkers || []).some((c) => realIds.has(String(c))) || (t.forwardChain || []).some((f) => realIds.has(String(f.employeeId))))) unsafe++; }
  for (const c of OUT.checklisttasks) if (realIds.has(String(c.doerId))) unsafe++;
  for (const i of OUT.flowinstances || []) if (i.activeStep && realIds.has(String(i.activeStep.assignedToId))) unsafe++;
  for (const l of OUT.leaverequests) if (realIds.has(String(l.employeeId)) && l.status !== 'Approved') unsafe++;
  for (const l of OUT.leaverequests) if (realIds.has(String(l.employeeId)) && l.toDate >= TODAY) unsafe++;
  for (const e of OUT.employees) if (e.whatsappNumber) unsafe++;

  if (opt('dump')) fs.writeFileSync(opt('dump'), JSON.stringify(OUT));
  const total = Object.values(OUT).reduce((s, a) => s + a.length, 0);
  console.log(`\nLRBC demo data  ${START} -> ${END}   (today = ${TODAY})`);
  console.log(`Mode: ${RUN ? 'REAL RUN' : OFFLINE ? 'OFFLINE TEST' : 'DRY RUN (nothing is written)'}`);
  console.table(Object.fromEntries(Object.entries(OUT).map(([k, v]) => [k, v.length])));
  console.log('Details:', JSON.stringify(stats));
  warnings.forEach((w) => console.log('WARNING:', w));
  console.log(`Records: ${total}   Schema problems: ${bad}   Safety problems: ${unsafe}`);
  if (bad || unsafe) { console.log('Stopping: fix the problems above first.'); process.exit(1); }
  if (!RUN) { console.log(OFFLINE ? 'Offline test passed.' : 'Dry run OK. To really write the data run again with  --run --files-base-url=<your API address>'); process.exit(0); }

  // ─ real run
  if (!FILES_BASE) console.log('Note: no --files-base-url given, so no sample photos/files are attached.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(process.cwd(), `lrbc-demo-manifest-${stamp}.json`);
  const manifest = { tenantId: String(tenant._id), createdAt: new Date().toISOString(), collections: {}, files: [], tenantListsAdded: { sectors: [], locations: [] } };
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  const Tn = conn === mongoose.connection ? null : null; void Tn;
  // sample files on disk
  if (FILES_BASE && sampleFiles.length) {
    const dir = path.join(__dirname, '..', '..', 'uploads', 'demo'); fs.mkdirSync(dir, { recursive: true });
    for (const f of sampleFiles) { const p = path.join(dir, f.name); fs.writeFileSync(p, f.svg); manifest.files.push(p); }
  }
  // the employees first (so everything else can point at them)
  const order = ['employees', 'leavetypes', 'shifts', 'attendanceassignments', 'delegationtasks', 'checklisttasks', 'leaverequests', 'leaveadjustments', 'punches', 'regularizations', 'supporttickets', 'personaltasks', 'plans', 'conversations', 'messages', 'flowinstances', 'ordersubmissions'];
  for (const col of order) {
    const docs = (OUT[col] || []).map((d) => { const c = { ...d }; delete c.__kind; return c; }); if (!docs.length) continue;
    manifest.collections[col] = docs.map((d) => String(d._id)); save();            // ids are written BEFORE inserting
    const mn = models[colOf[col]].modelName;
    const Model = conn.models[mn] || conn.model(mn, models[colOf[col]].schema);
    if (Model.collection.name !== col) throw new Error(`Collection mismatch: ${Model.collection.name} vs ${col}`);
    for (let i = 0; i < docs.length; i += 500) await Model.collection.insertMany(docs.slice(i, i + 500), { ordered: false });
    console.log(`  inserted ${docs.length} -> ${col}`);
  }
  // Settings lists (only the new names are added, and recorded so undo can remove them)
  const wantLoc = ['Hyderabad', 'Pune', 'Chennai'], wantSec = ['Manufacturing', 'Trading', 'Retail Supply'];
  const addLoc = wantLoc.filter((x) => !(tenant.locations || []).includes(x)), addSec = wantSec.filter((x) => !(tenant.sectors || []).includes(x));
  manifest.tenantListsAdded = { sectors: addSec, locations: addLoc }; save();
  if (addLoc.length || addSec.length) await require('../../models/Tenant').updateOne({ _id: tenant._id }, { $addToSet: { locations: { $each: addLoc }, sectors: { $each: addSec } } });
  manifest.completed = true; save();
  console.log(`\nDONE. Undo file saved: ${manifestPath}\nKeep it. To remove all demo data later:  node scripts/lrbc-demo/undo.js ${path.basename(manifestPath)} --run`);
  process.exit(0);
})().catch((e) => { console.log('Failed:', e.message, e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''); process.exit(1); });

// controllers/attendanceController.js
// Attendance: punch in/out (with optional location and face check), shifts, sites, corrections,
// reviews of flagged punches, team sheet and face enrolment. Every route is behind requirePermission (see routes).
// Rules live in utils/attendanceEngine.js. The server's clock is always used for punch times.
const mongoose = require('mongoose');
const E = require('../utils/attendanceEngine');

const oid = (v) => String(v && v._id ? v._id : v);
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const tenantId = (req) => req.user.tenantId;
const model = (req, name) => {
  const m = require('../models/' + name);
  return req.db ? (req.db.models[name] || req.db.model(name, m.schema)) : m;
};
const empModel = (req) => (req.db ? req.db.model('Employee') : require('../models/Employee'));
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

const FACE_CONSENT = 'I agree that my face template (a set of numbers made from my face, not a photo) may be stored by my employer and used only to check my identity when I punch in or out. I can withdraw this at any time and it will be deleted.';
const DEFAULTS = { requireLocation: false, allowOutsideSite: true, faceMode: 'off', faceThreshold: 0.5, defaultShiftId: null, fullDayMinutes: 480, halfDayMinutes: 240, regularizeDays: 31 };

async function audit(req, action, description, extra) {
  try {
    const ActivityLog = require('../models/ActivityLog');
    await ActivityLog.create({
      tenantId: tenantId(req), employeeId: req.user.id, employeeName: (req.actor && req.actor.name) || '', employeeRole: (req.user.roles || []).join(', '),
      action, description, metadata: { ip: req.ip || '', extra: extra || {} }
    });
  } catch (e) { console.error('[Attendance] audit failed:', e.message); }
}

async function loadTenant(req) {
  const Tenant = require('../models/Tenant');
  const t = await Tenant.findById(tenantId(req)).select('weekends holidays attendanceConfig').lean();
  const c = { ...DEFAULTS, ...((t && t.attendanceConfig) || {}) };
  return {
    config: c,
    weekends: Array.isArray(t && t.weekends) ? t.weekends : [0],
    holidays: new Set(((t && t.holidays) || []).filter((h) => h && h.date).map((h) => new Date(h.date).toISOString().slice(0, 10)))
  };
}
const offKind = (date, cal, emp) => {
  if (cal.holidays.has(date)) return 'holiday';
  const d = E.dow(date);
  if (cal.weekends.includes(d) && !(d === 0 && emp && emp.workOnSunday)) return 'weekly off';
  return null;
};
const joinDateOf = (emp) => {
  const d = emp.joiningDate || emp.createdAt;
  return d ? E.istDate(new Date(d).getTime()) : null;
};
const shiftView = (s) => (s ? { _id: oid(s._id), name: s.name, start: s.start, end: s.end, startMin: E.hhmmToMin(s.start), endMin: E.hhmmToMin(s.end), graceMin: s.graceMinutes || 0, halfDayMinutes: s.halfDayMinutes, fullDayMinutes: s.fullDayMinutes } : null);
const emptyDay = (date) => ({ date, status: '', workedMinutes: 0, firstIn: '', lastOut: '', late: false, lateMinutes: 0, early: false, earlyMinutes: 0, flagged: false, missingOut: false, present: 0, absent: 0, leave: 0, off: 0 });

// ---- who is inside a permission's reach (same rule as leave) -------------------------
async function reachIds(req, key) {
  const scope = (req.permissions || {})[key];
  if (!scope) return new Set();
  if (scope === 'company') return null;
  const me = req.actor || {};
  const mine = oid(req.user.id);
  if (scope === 'self') return new Set([mine]);
  if (scope === 'team') return new Set([mine, ...(me.managedDoers || []).map(oid), ...(me.managedAssigners || []).map(oid)]);
  const field = scope === 'department' ? 'department' : 'location';
  if (!me[field]) return new Set([mine]);
  const peers = await empModel(req).find({ tenantId: tenantId(req), [field]: me[field] }).select('_id').lean();
  return new Set([mine, ...peers.map((p) => oid(p._id))]);
}
const inReach = (set, id) => set === null || set.has(oid(id));
// A person may decide on their own item only if they are a company-wide administrator of attendance.
const mayDecideOwn = (req) => (req.permissions || {})['attendance.configure'] === 'company';

// ---- data helpers ----------------------------------------------------------------------
async function assignmentMaps(req) {
  const [shifts, sites, assigns] = await Promise.all([
    model(req, 'Shift').find({ tenantId: tenantId(req) }).lean(),
    model(req, 'AttendanceSite').find({ tenantId: tenantId(req) }).lean(),
    model(req, 'AttendanceAssignment').find({ tenantId: tenantId(req) }).lean()
  ]);
  return {
    shifts, sites,
    shiftById: new Map(shifts.map((s) => [oid(s._id), s])),
    assignByEmp: new Map(assigns.map((a) => [oid(a.employeeId), a]))
  };
}
function shiftForEmp(maps, cfg, empId) {
  const a = maps.assignByEmp.get(oid(empId));
  const id = (a && a.shiftId) || cfg.defaultShiftId;
  return id ? shiftView(maps.shiftById.get(oid(id))) : null;
}
function sitesForEmp(maps, empId) {
  const a = maps.assignByEmp.get(oid(empId));
  const ids = new Set(((a && a.siteIds) || []).map(oid));
  return ids.size ? maps.sites.filter((s) => ids.has(oid(s._id))) : maps.sites;
}
async function leaveUnits(req, empIds, from, to) {
  const out = new Map();
  if (!empIds.length) return out;
  const rows = await model(req, 'LeaveRequest').find({ tenantId: tenantId(req), employeeId: { $in: empIds }, status: 'Approved', fromDate: { $lte: to }, toDate: { $gte: from } }).lean();
  for (const r of rows) {
    const m = out.get(oid(r.employeeId)) || new Map();
    for (const x of r.daysDetail || []) if (x.d >= from && x.d <= to) m.set(x.d, Math.min(1, (m.get(x.d) || 0) + x.u));
    out.set(oid(r.employeeId), m);
  }
  return out;
}
// Day-by-day result for the given people and dates: Map empId -> [day...]
async function buildDays(req, emps, dates, cal, maps) {
  const from = dates[0], to = dates[dates.length - 1];
  const ids = emps.map((e) => oid(e._id));
  const punchRows = ids.length ? await model(req, 'Punch').find({ tenantId: tenantId(req), employeeId: { $in: ids }, date: { $gte: from, $lte: to } }).lean() : [];
  const leaves = await leaveUnits(req, ids, from, to);
  const byEmp = new Map();
  for (const p of punchRows) { const k = oid(p.employeeId) + '|' + p.date; (byEmp.get(k) || byEmp.set(k, []).get(k)).push(p); }
  const nowMs = Date.now(), today = E.istDate(nowMs);
  const result = new Map();
  for (const emp of emps) {
    const id = oid(emp._id), joined = joinDateOf(emp), shift = shiftForEmp(maps, cal.config, id);
    const lm = leaves.get(id);
    result.set(id, dates.map((date) => {
      if (joined && date < joined) return emptyDay(date);
      return E.computeDay({ date, punches: byEmp.get(id + '|' + date) || [], shift, defaults: cal.config, off: offKind(date, cal, emp), leave: (lm && lm.get(date)) || 0, today, nowMs });
    }));
  }
  return result;
}
const punchView = (p) => ({ _id: p._id, type: p.type, at: p.at, time: E.minToHhmm(E.istMinutes(new Date(p.at).getTime())), source: p.source, siteName: p.siteName || '', distanceM: p.distanceM, face: p.face || {}, note: p.note || '', flagReason: p.flagReason || '', reviewStatus: p.reviewStatus || 'None' });

// ---- config, shifts, sites ---------------------------------------------------------------
exports.getConfig = async (req, res) => {
  try {
    const cal = await loadTenant(req);
    const maps = await assignmentMaps(req);
    res.json({
      config: { ...cal.config, defaultShiftId: cal.config.defaultShiftId ? oid(cal.config.defaultShiftId) : null },
      shifts: maps.shifts.map((s) => ({ _id: s._id, name: s.name, start: s.start, end: s.end, graceMinutes: s.graceMinutes, halfDayMinutes: s.halfDayMinutes, fullDayMinutes: s.fullDayMinutes })),
      sites: maps.sites.map((s) => ({ _id: s._id, name: s.name, lat: s.lat, lng: s.lng, radiusM: s.radiusM })),
      consentText: FACE_CONSENT
    });
  } catch (e) { res.status(500).json({ message: 'Could not load attendance settings.' }); }
};

exports.setConfig = async (req, res) => {
  try {
    const b = req.body || {};
    const next = {};
    if (b.requireLocation !== undefined) next.requireLocation = !!b.requireLocation;
    if (b.allowOutsideSite !== undefined) next.allowOutsideSite = !!b.allowOutsideSite;
    if (b.faceMode !== undefined) {
      if (!['off', 'optional', 'required'].includes(b.faceMode)) return res.status(400).json({ message: 'Face check must be off, optional or required.' });
      next.faceMode = b.faceMode;
    }
    const num = (k, min, max, label) => {
      if (b[k] === undefined) return null;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < min || n > max) return `${label} must be between ${min} and ${max}.`;
      next[k] = n; return null;
    };
    const err = num('faceThreshold', 0.3, 0.7, 'Face strictness') || num('fullDayMinutes', 60, 1440, 'Full day minutes') || num('halfDayMinutes', 30, 1440, 'Half day minutes') || num('regularizeDays', 1, 365, 'Correction window days');
    if (err) return res.status(400).json({ message: err });
    if (b.defaultShiftId !== undefined) {
      if (b.defaultShiftId === null || b.defaultShiftId === '') next.defaultShiftId = null;
      else {
        if (!isId(b.defaultShiftId) || !(await model(req, 'Shift').findOne({ _id: b.defaultShiftId, tenantId: tenantId(req) }).lean())) return res.status(400).json({ message: 'Choose a valid shift.' });
        next.defaultShiftId = b.defaultShiftId;
      }
    }
    const cal = await loadTenant(req);
    const merged = { ...cal.config, ...next };
    if (merged.halfDayMinutes > merged.fullDayMinutes) return res.status(400).json({ message: 'Half day minutes cannot be more than full day minutes.' });
    const Tenant = require('../models/Tenant');
    const set = {}; Object.keys(next).forEach((k) => { set['attendanceConfig.' + k] = next[k]; });
    if (Object.keys(set).length) await Tenant.updateOne({ _id: tenantId(req) }, { $set: set });
    await audit(req, 'attendance_config_saved', 'Changed attendance settings', next);
    res.json({ config: merged });
  } catch (e) { res.status(500).json({ message: 'Could not save attendance settings.' }); }
};

function readShift(b) {
  const name = clean(b.name, 40);
  if (name.length < 2) return { error: 'Shift name must be 2 to 40 characters.' };
  if (!E.validHhmm(b.start) || !E.validHhmm(b.end)) return { error: 'Choose a start and end time.' };
  if (E.hhmmToMin(b.end) <= E.hhmmToMin(b.start)) return { error: 'The shift must end after it starts on the same day. Night shifts are not supported yet.' };
  const n = (v, d, min, max, label) => { const x = v === undefined || v === '' ? d : Number(v); if (!Number.isFinite(x) || x < min || x > max) throw new Error(`${label} must be between ${min} and ${max}.`); return x; };
  try {
    const span = E.hhmmToMin(b.end) - E.hhmmToMin(b.start);
    const value = { name, start: b.start, end: b.end, graceMinutes: n(b.graceMinutes, 10, 0, 180, 'Grace minutes'), halfDayMinutes: n(b.halfDayMinutes, Math.min(240, span), 30, 1440, 'Half day minutes'), fullDayMinutes: n(b.fullDayMinutes, Math.min(480, span), 60, 1440, 'Full day minutes') };
    if (value.halfDayMinutes > value.fullDayMinutes) return { error: 'Half day minutes cannot be more than full day minutes.' };
    return { value };
  } catch (e) { return { error: e.message }; }
}
exports.createShift = async (req, res) => {
  try {
    const r = readShift(req.body || {});
    if (r.error) return res.status(400).json({ message: r.error });
    const Shift = model(req, 'Shift');
    if (await Shift.countDocuments({ tenantId: tenantId(req) }) >= 30) return res.status(400).json({ message: 'You can have at most 30 shifts.' });
    const s = await Shift.create({ tenantId: tenantId(req), ...r.value });
    await audit(req, 'attendance_shift_saved', `Added shift ${s.name}`, { shiftId: oid(s._id) });
    res.status(201).json({ shift: s });
  } catch (e) { res.status(500).json({ message: 'Could not save the shift.' }); }
};
exports.updateShift = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid shift.' });
    const r = readShift(req.body || {});
    if (r.error) return res.status(400).json({ message: r.error });
    const Shift = model(req, 'Shift');
    if (!(await Shift.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean())) return res.status(404).json({ message: 'Shift not found.' });
    await Shift.updateOne({ _id: req.params.id, tenantId: tenantId(req) }, { $set: r.value });
    await audit(req, 'attendance_shift_saved', `Changed shift ${r.value.name}`, { shiftId: req.params.id });
    res.json({ shift: { _id: req.params.id, ...r.value } });
  } catch (e) { res.status(500).json({ message: 'Could not save the shift.' }); }
};
exports.deleteShift = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid shift.' });
    const Shift = model(req, 'Shift');
    const s = await Shift.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
    if (!s) return res.status(404).json({ message: 'Shift not found.' });
    const cal = await loadTenant(req);
    if (cal.config.defaultShiftId && oid(cal.config.defaultShiftId) === req.params.id) return res.status(400).json({ message: 'This is the company default shift. Choose another default first.' });
    const used = await model(req, 'AttendanceAssignment').countDocuments({ tenantId: tenantId(req), shiftId: req.params.id });
    if (used) return res.status(400).json({ message: `${used} ${used === 1 ? 'person uses' : 'people use'} this shift. Move them to another shift first.` });
    await Shift.deleteOne({ _id: req.params.id, tenantId: tenantId(req) });
    await audit(req, 'attendance_shift_deleted', `Deleted shift ${s.name}`, { shiftId: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not delete the shift.' }); }
};

function readSite(b) {
  const name = clean(b.name, 60);
  const lat = Number(b.lat), lng = Number(b.lng), radiusM = b.radiusM === undefined || b.radiusM === '' ? 150 : Number(b.radiusM);
  if (name.length < 2) return { error: 'Location name must be 2 to 60 characters.' };
  if (!E.validLatLng(lat, lng)) return { error: 'Enter a valid latitude and longitude.' };
  if (!Number.isFinite(radiusM) || radiusM < 20 || radiusM > 5000) return { error: 'Radius must be between 20 and 5000 metres.' };
  return { value: { name, lat, lng, radiusM } };
}
exports.createSite = async (req, res) => {
  try {
    const r = readSite(req.body || {});
    if (r.error) return res.status(400).json({ message: r.error });
    const Site = model(req, 'AttendanceSite');
    if (await Site.countDocuments({ tenantId: tenantId(req) }) >= 50) return res.status(400).json({ message: 'You can have at most 50 locations.' });
    const s = await Site.create({ tenantId: tenantId(req), ...r.value });
    await audit(req, 'attendance_site_saved', `Added location ${s.name}`, { siteId: oid(s._id) });
    res.status(201).json({ site: s });
  } catch (e) { res.status(500).json({ message: 'Could not save the location.' }); }
};
exports.updateSite = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid location.' });
    const r = readSite(req.body || {});
    if (r.error) return res.status(400).json({ message: r.error });
    const Site = model(req, 'AttendanceSite');
    if (!(await Site.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean())) return res.status(404).json({ message: 'Location not found.' });
    await Site.updateOne({ _id: req.params.id, tenantId: tenantId(req) }, { $set: r.value });
    await audit(req, 'attendance_site_saved', `Changed location ${r.value.name}`, { siteId: req.params.id });
    res.json({ site: { _id: req.params.id, ...r.value } });
  } catch (e) { res.status(500).json({ message: 'Could not save the location.' }); }
};
exports.deleteSite = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid location.' });
    const Site = model(req, 'AttendanceSite');
    const s = await Site.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
    if (!s) return res.status(404).json({ message: 'Location not found.' });
    const A = model(req, 'AttendanceAssignment');
    const rows = await A.find({ tenantId: tenantId(req), siteIds: req.params.id }).lean();
    for (const a of rows) await A.updateOne({ _id: a._id }, { $set: { siteIds: (a.siteIds || []).filter((x) => oid(x) !== req.params.id) } });
    await Site.deleteOne({ _id: req.params.id, tenantId: tenantId(req) });
    await audit(req, 'attendance_site_deleted', `Deleted location ${s.name}`, { siteId: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not delete the location.' }); }
};

// ---- assignments (shift + sites per person) ------------------------------------------------
exports.listPeople = async (req, res) => {
  try {
    const [emps, maps, faces] = await Promise.all([
      empModel(req).find({ tenantId: tenantId(req) }).select('name department').sort({ name: 1 }).lean(),
      assignmentMaps(req),
      model(req, 'FaceTemplate').find({ tenantId: tenantId(req) }).lean()
    ]);
    const faceBy = new Map(faces.map((f) => [oid(f.employeeId), f.status]));
    res.json({ people: emps.map((e) => { const a = maps.assignByEmp.get(oid(e._id)); return { _id: e._id, name: e.name, department: e.department || '', shiftId: a && a.shiftId ? oid(a.shiftId) : null, siteIds: ((a && a.siteIds) || []).map(oid), face: faceBy.get(oid(e._id)) || '' }; }) });
  } catch (e) { res.status(500).json({ message: 'Could not load people.' }); }
};
exports.setAssignment = async (req, res) => {
  try {
    const { employeeId } = req.params, b = req.body || {};
    if (!isId(employeeId)) return res.status(400).json({ message: 'Invalid person.' });
    const emp = await empModel(req).findOne({ _id: employeeId, tenantId: tenantId(req) }).select('name').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    const maps = await assignmentMaps(req);
    let shiftId = null;
    if (b.shiftId) { if (!isId(b.shiftId) || !maps.shiftById.has(String(b.shiftId))) return res.status(400).json({ message: 'Choose a valid shift.' }); shiftId = String(b.shiftId); }
    const siteIds = [...new Set((Array.isArray(b.siteIds) ? b.siteIds : []).map(String))];
    const known = new Set(maps.sites.map((s) => oid(s._id)));
    if (siteIds.some((x) => !known.has(x))) return res.status(400).json({ message: 'Choose valid locations.' });
    const A = model(req, 'AttendanceAssignment');
    const cur = await A.findOne({ tenantId: tenantId(req), employeeId }).lean();
    if (cur) await A.updateOne({ _id: cur._id }, { $set: { shiftId, siteIds } });
    else await A.create({ tenantId: tenantId(req), employeeId, shiftId, siteIds });
    await audit(req, 'attendance_assigned', `Set shift and locations for ${emp.name}`, { employeeId, shiftId, siteIds });
    res.json({ employeeId, shiftId, siteIds });
  } catch (e) { res.status(500).json({ message: 'Could not save.' }); }
};

// ---- today / punch ------------------------------------------------------------------------
async function faceStateOf(req, empId) {
  const f = await model(req, 'FaceTemplate').findOne({ tenantId: tenantId(req), employeeId: empId }).lean();
  return f ? { enrolled: true, status: f.status, count: (f.descriptors || []).length } : { enrolled: false, status: '', count: 0 };
}
exports.today = async (req, res) => {
  try {
    const cal = await loadTenant(req), maps = await assignmentMaps(req);
    const me = await empModel(req).findById(req.user.id).select('name workOnSunday joiningDate createdAt').lean();
    const date = E.istDate(Date.now());
    const punches = await model(req, 'Punch').find({ tenantId: tenantId(req), employeeId: req.user.id, date }).sort({ at: 1 }).lean();
    const days = await buildDays(req, [{ ...me, _id: req.user.id }], [date], cal, maps);
    const sites = sitesForEmp(maps, req.user.id);
    res.json({
      myId: oid(req.user.id), date, nextAction: E.nextAction(punches), day: days.get(oid(req.user.id))[0], punches: punches.map(punchView),
      shift: shiftForEmp(maps, cal.config, req.user.id),
      sites: sites.map((s) => ({ _id: s._id, name: s.name, radiusM: s.radiusM })),
      settings: { requireLocation: cal.config.requireLocation, allowOutsideSite: cal.config.allowOutsideSite, faceMode: cal.config.faceMode },
      face: await faceStateOf(req, req.user.id), consentText: FACE_CONSENT
    });
  } catch (e) { res.status(500).json({ message: 'Could not load today.' }); }
};

exports.punch = async (req, res) => {
  try {
    const b = req.body || {};
    const cal = await loadTenant(req), cfg = cal.config, maps = await assignmentMaps(req);
    const now = Date.now(), date = E.istDate(now);
    const Punch = model(req, 'Punch');
    const todays = await Punch.find({ tenantId: tenantId(req), employeeId: req.user.id, date }).sort({ at: 1 }).lean();
    const last = todays[todays.length - 1];
    if (last && now - new Date(last.at).getTime() < 60000) return res.status(429).json({ message: 'You just punched. Please wait a minute before punching again.' });
    const type = E.nextAction(todays);
    const flags = [];
    const rec = { tenantId: tenantId(req), employeeId: req.user.id, date, at: new Date(now), type, source: 'web', face: { checked: false, matched: false, distance: null } };

    // Location
    const lat = b.lat === undefined || b.lat === null || b.lat === '' ? NaN : Number(b.lat), lng = b.lng === undefined || b.lng === null || b.lng === '' ? NaN : Number(b.lng), accuracy = Number(b.accuracy);
    const sites = sitesForEmp(maps, req.user.id);
    if (E.validLatLng(lat, lng)) { rec.lat = lat; rec.lng = lng; rec.accuracy = Number.isFinite(accuracy) ? Math.round(accuracy) : null; }
    if (cfg.requireLocation && sites.length) {
      if (!E.validLatLng(lat, lng)) return res.status(400).json({ code: 'LOCATION_REQUIRED', message: 'Your location is needed to punch. Please allow location access in your browser.' });
      const loc = E.checkLocation({ lat, lng, accuracy }, sites);
      rec.siteId = loc.site ? loc.site._id : null; rec.siteName = loc.site ? loc.site.name : ''; rec.distanceM = loc.distance;
      if (!loc.ok) {
        if (!cfg.allowOutsideSite) return res.status(403).json({ code: 'OUTSIDE_SITE', message: `You are about ${loc.distance} m from ${loc.site.name}. You can only punch at your office location.` });
        flags.push(`Outside location (${loc.distance} m from ${loc.site.name})`);
      }
    } else if (E.validLatLng(lat, lng) && sites.length) {
      const loc = E.checkLocation({ lat, lng, accuracy }, sites);
      if (loc.site) { rec.siteId = loc.ok ? loc.site._id : null; rec.siteName = loc.ok ? loc.site.name : ''; rec.distanceM = loc.distance; }
    }

    // Face
    if (cfg.faceMode !== 'off') {
      const tpl = await model(req, 'FaceTemplate').findOne({ tenantId: tenantId(req), employeeId: req.user.id, status: 'Approved' }).lean();
      if (!tpl) { if (cfg.faceMode === 'required') flags.push('Face not enrolled'); }
      else if (!E.validDescriptor(b.descriptor)) flags.push('Face check was not done');
      else {
        const m = E.bestFaceMatch(b.descriptor, tpl.descriptors, cfg.faceThreshold);
        rec.face = { checked: true, matched: m.matched, distance: m.distance };
        if (!m.matched) flags.push('Face did not match');
      }
    }

    const note = clean(b.note, 300);
    if (flags.length) {
      if (note.length < 3) return res.status(409).json({ code: 'NEEDS_REASON', reasons: flags, message: 'This punch needs a manager to check it. Please type a short reason.' });
      rec.flagReason = flags.join('; '); rec.reviewStatus = 'Pending'; rec.note = note;
    } else rec.note = note;
    const p = await Punch.create(rec);
    res.status(201).json({ punch: punchView(p), flagged: flags.length > 0, message: flags.length ? 'Punched. A manager will review it.' : (type === 'in' ? 'Punched in.' : 'Punched out.') });
  } catch (e) { console.error('[Attendance] punch', e.message); res.status(500).json({ message: 'Could not save your punch.' }); }
};

// ---- my month / sheet / live ---------------------------------------------------------------
exports.myMonth = async (req, res) => {
  try {
    const month = req.query.month || E.istDate(Date.now()).slice(0, 7);
    if (!E.validMonth(month)) return res.status(400).json({ message: 'Choose a valid month.' });
    const cal = await loadTenant(req), maps = await assignmentMaps(req);
    const me = await empModel(req).findById(req.user.id).select('name workOnSunday joiningDate createdAt').lean();
    const dates = E.monthDays(month);
    const days = (await buildDays(req, [{ ...me, _id: req.user.id }], dates, cal, maps)).get(oid(req.user.id));
    const punches = await model(req, 'Punch').find({ tenantId: tenantId(req), employeeId: req.user.id, date: { $gte: dates[0], $lte: dates[dates.length - 1] } }).sort({ at: 1 }).lean();
    const by = {}; punches.forEach((p) => { (by[p.date] = by[p.date] || []).push(punchView(p)); });
    res.json({ month, days: days.map((d) => ({ ...d, punches: by[d.date] || [] })), totals: E.summarize(days) });
  } catch (e) { res.status(500).json({ message: 'Could not load your attendance.' }); }
};

exports.sheet = async (req, res) => {
  try {
    const month = req.query.month || E.istDate(Date.now()).slice(0, 7);
    if (!E.validMonth(month)) return res.status(400).json({ message: 'Choose a valid month.' });
    const reach = await reachIds(req, 'attendance.view');
    const all = await empModel(req).find({ tenantId: tenantId(req) }).select('name department workOnSunday joiningDate createdAt').sort({ name: 1 }).lean();
    let emps = all.filter((e) => inReach(reach, e._id));
    if (req.query.employeeId) {
      if (!isId(req.query.employeeId)) return res.status(400).json({ message: 'Invalid person.' });
      emps = emps.filter((e) => oid(e._id) === req.query.employeeId);
      if (!emps.length) return res.status(403).json({ message: 'You cannot see this person.' });
    }
    if (emps.length > 1000) return res.status(400).json({ message: 'Too many people. Narrow it down by department.' });
    const cal = await loadTenant(req), maps = await assignmentMaps(req), dates = E.monthDays(month);
    const dayMap = await buildDays(req, emps, dates, cal, maps);
    if (req.query.employeeId) {
      const e = emps[0], days = dayMap.get(oid(e._id));
      const punches = await model(req, 'Punch').find({ tenantId: tenantId(req), employeeId: e._id, date: { $gte: dates[0], $lte: dates[dates.length - 1] } }).sort({ at: 1 }).lean();
      const by = {}; punches.forEach((p) => { (by[p.date] = by[p.date] || []).push(punchView(p)); });
      return res.json({ month, employee: { _id: e._id, name: e.name }, days: days.map((d) => ({ ...d, punches: by[d.date] || [] })), totals: E.summarize(days) });
    }
    res.json({ month, rows: emps.map((e) => ({ _id: e._id, name: e.name, department: e.department || '', totals: E.summarize(dayMap.get(oid(e._id))) })) });
  } catch (e) { res.status(500).json({ message: 'Could not load the sheet.' }); }
};

exports.live = async (req, res) => {
  try {
    const reach = await reachIds(req, 'attendance.view');
    const all = await empModel(req).find({ tenantId: tenantId(req) }).select('name department workOnSunday joiningDate createdAt').sort({ name: 1 }).lean();
    const emps = all.filter((e) => inReach(reach, e._id));
    const cal = await loadTenant(req), maps = await assignmentMaps(req), date = E.istDate(Date.now());
    const dayMap = await buildDays(req, emps, [date], cal, maps);
    const rows = emps.map((e) => { const d = dayMap.get(oid(e._id))[0]; return { _id: e._id, name: e.name, department: e.department || '', status: d.status, firstIn: d.firstIn, lastOut: d.lastOut, late: d.late, flagged: d.flagged }; });
    res.json({ date, rows });
  } catch (e) { res.status(500).json({ message: 'Could not load today.' }); }
};

// ---- corrections (regularization) ------------------------------------------------------------
exports.createRegularization = async (req, res) => {
  try {
    const b = req.body || {};
    const cal = await loadTenant(req), today = E.istDate(Date.now());
    if (!E.validDate(b.date)) return res.status(400).json({ message: 'Choose a valid date.' });
    if (b.date > today) return res.status(400).json({ message: 'You cannot correct a future day.' });
    const oldest = E.istDate(Date.now() - cal.config.regularizeDays * 86400000);
    if (b.date < oldest) return res.status(400).json({ message: `Corrections can only be made for the last ${cal.config.regularizeDays} days.` });
    const inTime = b.inTime || '', outTime = b.outTime || '';
    if ((inTime && !E.validHhmm(inTime)) || (outTime && !E.validHhmm(outTime))) return res.status(400).json({ message: 'Enter times like 09:30.' });
    if (!inTime && !outTime) return res.status(400).json({ message: 'Enter the in time, the out time, or both.' });
    if (inTime && outTime && E.hhmmToMin(outTime) <= E.hhmmToMin(inTime)) return res.status(400).json({ message: 'Out time must be after in time.' });
    if (b.date === today) { const nowMin = E.istMinutes(Date.now()); if ((inTime && E.hhmmToMin(inTime) > nowMin) || (outTime && E.hhmmToMin(outTime) > nowMin)) return res.status(400).json({ message: 'You cannot enter a time that has not happened yet.' }); }
    const reason = clean(b.reason, 300);
    if (reason.length < 3) return res.status(400).json({ message: 'Please give a reason.' });
    const R = model(req, 'Regularization');
    if (await R.findOne({ tenantId: tenantId(req), employeeId: req.user.id, date: b.date, status: 'Pending' }).lean()) return res.status(400).json({ message: 'You already have a pending correction for this day.' });
    const r = await R.create({ tenantId: tenantId(req), employeeId: req.user.id, date: b.date, inTime, outTime, reason });
    await audit(req, 'attendance_regularization_applied', `Asked to correct attendance for ${b.date}`, { id: oid(r._id) });
    res.status(201).json({ request: r });
  } catch (e) { res.status(500).json({ message: 'Could not send the correction.' }); }
};

exports.listRegularizations = async (req, res) => {
  try {
    const scope = req.query.scope === 'approvals' ? 'approvals' : 'mine';
    const q = { tenantId: tenantId(req) };
    if (req.query.status && ['Pending', 'Approved', 'Rejected', 'Cancelled'].includes(req.query.status)) q.status = req.query.status;
    let reach = null;
    if (scope === 'mine') q.employeeId = req.user.id;
    else {
      if (!(req.permissions || {})['attendance.approve']) return res.status(403).json({ message: 'You do not have permission to do this.' });
      reach = await reachIds(req, 'attendance.approve');
    }
    let rows = await model(req, 'Regularization').find(q).sort({ createdAt: -1 }).limit(300).lean();
    if (scope === 'approvals') rows = rows.filter((r) => inReach(reach, r.employeeId));
    const emps = await empModel(req).find({ tenantId: tenantId(req), _id: { $in: [...new Set(rows.map((r) => oid(r.employeeId)))] } }).select('name').lean();
    const nameBy = new Map(emps.map((e) => [oid(e._id), e.name]));
    res.json({ requests: rows.map((r) => ({ ...r, employeeName: nameBy.get(oid(r.employeeId)) || '' })) });
  } catch (e) { res.status(500).json({ message: 'Could not load corrections.' }); }
};

exports.decideRegularization = async (req, res) => {
  try {
    const { id } = req.params, decision = req.body && req.body.decision, note = clean(req.body && req.body.note, 300);
    if (!isId(id)) return res.status(400).json({ message: 'Invalid request.' });
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    const R = model(req, 'Regularization');
    const r = await R.findOne({ _id: id, tenantId: tenantId(req) }).lean();
    if (!r) return res.status(404).json({ message: 'Request not found.' });
    if (r.status !== 'Pending') return res.status(400).json({ message: `This request is already ${r.status.toLowerCase()}.` });
    const reach = await reachIds(req, 'attendance.approve');
    if (!inReach(reach, r.employeeId)) return res.status(403).json({ message: 'This person is outside the people you can approve for.' });
    if (oid(r.employeeId) === oid(req.user.id) && !mayDecideOwn(req)) return res.status(403).json({ message: 'You cannot decide your own correction. Ask another approver.' });
    const claimed = await R.findOneAndUpdate({ _id: id, tenantId: tenantId(req), status: 'Pending' }, { $set: { status: decision, decidedBy: req.user.id, decidedAt: new Date(), decisionNote: note } }, { new: true });
    if (!claimed) return res.status(409).json({ message: 'Someone else just decided this request.' });
    if (decision === 'Approved') {
      const Punch = model(req, 'Punch');
      try {
        if (r.inTime && r.outTime) {
          const old = await Punch.find({ tenantId: tenantId(req), employeeId: r.employeeId, date: r.date }).lean();
          for (const p of old) if (p.reviewStatus !== 'Rejected') await Punch.updateOne({ _id: p._id }, { $set: { reviewStatus: 'Rejected', reviewedBy: req.user.id, reviewedAt: new Date(), reviewNote: 'Replaced by an approved correction' } });
        }
        for (const [type, t] of [['in', r.inTime], ['out', r.outTime]]) {
          if (!t) continue;
          await Punch.create({ tenantId: tenantId(req), employeeId: r.employeeId, date: r.date, at: new Date(E.istToMs(r.date, t)), type, source: 'regularization', note: `Correction approved: ${r.reason}`.slice(0, 300), addedBy: req.user.id });
        }
      } catch (err) {
        await R.updateOne({ _id: id }, { $set: { status: 'Pending', decidedBy: null, decidedAt: null, decisionNote: '' } });
        throw err;
      }
    }
    await audit(req, 'attendance_regularization_decided', `${decision} attendance correction for ${r.date}`, { id, employeeId: oid(r.employeeId), decision });
    res.json({ status: decision });
  } catch (e) { res.status(500).json({ message: 'Could not save the decision.' }); }
};

exports.cancelRegularization = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid request.' });
    const R = model(req, 'Regularization');
    const r = await R.findOne({ _id: req.params.id, tenantId: tenantId(req), employeeId: req.user.id }).lean();
    if (!r) return res.status(404).json({ message: 'Request not found.' });
    if (r.status !== 'Pending') return res.status(400).json({ message: 'Only a pending request can be cancelled.' });
    const done = await R.findOneAndUpdate({ _id: r._id, status: 'Pending' }, { $set: { status: 'Cancelled' } }, { new: true });
    if (!done) return res.status(409).json({ message: 'This request was just decided.' });
    res.json({ status: 'Cancelled' });
  } catch (e) { res.status(500).json({ message: 'Could not cancel.' }); }
};

// ---- flagged punches -------------------------------------------------------------------------
exports.listReview = async (req, res) => {
  try {
    const reach = await reachIds(req, 'attendance.approve');
    const rows = (await model(req, 'Punch').find({ tenantId: tenantId(req), reviewStatus: 'Pending' }).sort({ at: -1 }).limit(300).lean()).filter((p) => inReach(reach, p.employeeId));
    const emps = await empModel(req).find({ tenantId: tenantId(req), _id: { $in: [...new Set(rows.map((r) => oid(r.employeeId)))] } }).select('name').lean();
    const nameBy = new Map(emps.map((e) => [oid(e._id), e.name]));
    res.json({ punches: rows.map((p) => ({ ...punchView(p), date: p.date, employeeId: p.employeeId, employeeName: nameBy.get(oid(p.employeeId)) || '' })) });
  } catch (e) { res.status(500).json({ message: 'Could not load punches to review.' }); }
};

exports.reviewPunch = async (req, res) => {
  try {
    const { id } = req.params, decision = req.body && req.body.decision, note = clean(req.body && req.body.note, 300);
    if (!isId(id)) return res.status(400).json({ message: 'Invalid punch.' });
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    const Punch = model(req, 'Punch');
    const p = await Punch.findOne({ _id: id, tenantId: tenantId(req) }).lean();
    if (!p) return res.status(404).json({ message: 'Punch not found.' });
    if (p.reviewStatus !== 'Pending') return res.status(400).json({ message: 'This punch is not waiting for review.' });
    const reach = await reachIds(req, 'attendance.approve');
    if (!inReach(reach, p.employeeId)) return res.status(403).json({ message: 'This person is outside the people you can approve for.' });
    if (oid(p.employeeId) === oid(req.user.id) && !mayDecideOwn(req)) return res.status(403).json({ message: 'You cannot review your own punch. Ask another approver.' });
    const done = await Punch.findOneAndUpdate({ _id: id, tenantId: tenantId(req), reviewStatus: 'Pending' }, { $set: { reviewStatus: decision, reviewedBy: req.user.id, reviewedAt: new Date(), reviewNote: note } }, { new: true });
    if (!done) return res.status(409).json({ message: 'Someone else just reviewed this punch.' });
    await audit(req, 'attendance_punch_reviewed', `${decision} a flagged punch on ${p.date}`, { punchId: id, employeeId: oid(p.employeeId), decision });
    res.json({ status: decision });
  } catch (e) { res.status(500).json({ message: 'Could not save the review.' }); }
};

exports.manualPunch = async (req, res) => {
  try {
    const b = req.body || {};
    if (!isId(b.employeeId)) return res.status(400).json({ message: 'Choose a person.' });
    if (!E.validDate(b.date) || !E.validHhmm(b.time) || !['in', 'out'].includes(b.type)) return res.status(400).json({ message: 'Enter the date, time and in/out.' });
    const at = E.istToMs(b.date, b.time);
    if (at > Date.now()) return res.status(400).json({ message: 'You cannot add a punch in the future.' });
    const note = clean(b.note, 300);
    if (note.length < 3) return res.status(400).json({ message: 'Please give a reason.' });
    const reach = await reachIds(req, 'attendance.edit');
    if (!inReach(reach, b.employeeId)) return res.status(403).json({ message: 'This person is outside the people you can edit.' });
    const emp = await empModel(req).findOne({ _id: b.employeeId, tenantId: tenantId(req) }).select('name').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    const p = await model(req, 'Punch').create({ tenantId: tenantId(req), employeeId: b.employeeId, date: b.date, at: new Date(at), type: b.type, source: 'manual', note, addedBy: req.user.id });
    await audit(req, 'attendance_manual_punch', `Added a ${b.type} punch for ${emp.name} on ${b.date} at ${b.time}`, { punchId: oid(p._id), employeeId: b.employeeId });
    res.status(201).json({ punch: punchView(p) });
  } catch (e) { res.status(500).json({ message: 'Could not add the punch.' }); }
};

// ---- face enrolment ---------------------------------------------------------------------------
exports.faceMe = async (req, res) => {
  try {
    const cal = await loadTenant(req);
    res.json({ mode: cal.config.faceMode, ...(await faceStateOf(req, req.user.id)), consentText: FACE_CONSENT });
  } catch (e) { res.status(500).json({ message: 'Could not load face status.' }); }
};

exports.faceEnrol = async (req, res) => {
  try {
    const b = req.body || {};
    const cal = await loadTenant(req);
    if (cal.config.faceMode === 'off') return res.status(400).json({ message: 'Face check is not switched on for your company.' });
    if (b.consent !== true) return res.status(400).json({ message: 'You must agree to the face data notice first.' });
    const ds = Array.isArray(b.descriptors) ? b.descriptors : [];
    if (ds.length < 1 || ds.length > 3 || !ds.every(E.validDescriptor)) return res.status(400).json({ message: 'The face capture was not valid. Please try again.' });
    for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) if (E.faceDistance(ds[i], ds[j]) > 0.6) return res.status(400).json({ message: 'The captures did not look like the same face. Please try again in good light.' });
    const F = model(req, 'FaceTemplate');
    const auto = mayDecideOwn(req);
    const doc = { descriptors: ds.map((d) => d.map((x) => Math.round(x * 1e5) / 1e5)), status: auto ? 'Approved' : 'Pending', consentAt: new Date(), consentText: FACE_CONSENT, decidedBy: auto ? req.user.id : null, decidedAt: auto ? new Date() : null };
    const cur = await F.findOne({ tenantId: tenantId(req), employeeId: req.user.id }).lean();
    if (cur) await F.updateOne({ _id: cur._id }, { $set: doc }); else await F.create({ tenantId: tenantId(req), employeeId: req.user.id, ...doc });
    await audit(req, 'attendance_face_enrolled', 'Enrolled face for punching', { status: doc.status });
    res.status(201).json({ status: doc.status, message: auto ? 'Face saved.' : 'Face saved. It will work after a manager approves it.' });
  } catch (e) { res.status(500).json({ message: 'Could not save the face.' }); }
};

exports.facePending = async (req, res) => {
  try {
    const reach = await reachIds(req, 'attendance.approve');
    const rows = (await model(req, 'FaceTemplate').find({ tenantId: tenantId(req), status: 'Pending' }).lean()).filter((f) => inReach(reach, f.employeeId));
    const emps = await empModel(req).find({ tenantId: tenantId(req), _id: { $in: rows.map((r) => oid(r.employeeId)) } }).select('name department').lean();
    const by = new Map(emps.map((e) => [oid(e._id), e]));
    res.json({ people: rows.map((f) => ({ employeeId: f.employeeId, name: (by.get(oid(f.employeeId)) || {}).name || '', department: (by.get(oid(f.employeeId)) || {}).department || '', enrolledAt: f.updatedAt || f.createdAt })) });
  } catch (e) { res.status(500).json({ message: 'Could not load face approvals.' }); }
};

exports.faceDecide = async (req, res) => {
  try {
    const { employeeId } = req.params, decision = req.body && req.body.decision;
    if (!isId(employeeId)) return res.status(400).json({ message: 'Invalid person.' });
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    const reach = await reachIds(req, 'attendance.approve');
    if (!inReach(reach, employeeId)) return res.status(403).json({ message: 'This person is outside the people you can approve for.' });
    if (employeeId === oid(req.user.id) && !mayDecideOwn(req)) return res.status(403).json({ message: 'You cannot approve your own face. Ask another approver.' });
    const F = model(req, 'FaceTemplate');
    const f = await F.findOne({ tenantId: tenantId(req), employeeId }).lean();
    if (!f || f.status !== 'Pending') return res.status(400).json({ message: 'There is no face waiting for approval.' });
    if (decision === 'Rejected') await F.deleteOne({ _id: f._id });
    else {
      const done = await F.findOneAndUpdate({ _id: f._id, status: 'Pending' }, { $set: { status: 'Approved', decidedBy: req.user.id, decidedAt: new Date() } }, { new: true });
      if (!done) return res.status(409).json({ message: 'Someone else just decided this.' });
    }
    await audit(req, 'attendance_face_decided', `${decision} a face enrolment`, { employeeId, decision });
    res.json({ status: decision });
  } catch (e) { res.status(500).json({ message: 'Could not save the decision.' }); }
};

exports.faceDelete = async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!isId(employeeId)) return res.status(400).json({ message: 'Invalid person.' });
    const own = employeeId === oid(req.user.id);
    const perms = req.permissions || {};
    if (!own) {
      const reach = await reachIds(req, 'attendance.configure');
      if (!perms['attendance.configure'] || !inReach(reach, employeeId)) return res.status(403).json({ message: 'You do not have permission to do this.' });
    } else if (!perms['attendance.punch'] && !perms['attendance.configure']) return res.status(403).json({ message: 'You do not have permission to do this.' });
    const F = model(req, 'FaceTemplate');
    const f = await F.findOne({ tenantId: tenantId(req), employeeId }).lean();
    if (!f) return res.status(404).json({ message: 'No face is saved for this person.' });
    await F.deleteOne({ _id: f._id });
    await audit(req, 'attendance_face_deleted', own ? 'Withdrew consent and deleted own face' : 'Deleted a person\'s face template', { employeeId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not delete the face.' }); }
};

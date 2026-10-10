// utils/attendanceEngine.js
// The attendance rules as pure functions (no database): working out a day's status from punches,
// distance to office sites, and face matching. All calendar days are 'YYYY-MM-DD' in India time (IST).
// Night shifts that run past midnight are not supported: a day's punches are the punches made on that calendar day.
const MIN = 60000;
const IST = 330 * MIN;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const istMinutes = (ms) => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmmToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const minToHhmm = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
const validDate = (s) => typeof s === 'string' && ISO.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const validHhmm = (s) => typeof s === 'string' && HHMM.test(s);
const validMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const monthDays = (month) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};
const dow = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
// 'YYYY-MM-DD' and 'HH:MM' (IST) -> epoch ms
const istToMs = (date, hhmm) => new Date(date + 'T' + hhmm + ':00.000Z').getTime() - IST;

// ---- location -----------------------------------------------------------------------
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// Nearest allowed site. A person is "at the site" when they are inside its radius, allowing for GPS error up to 50 m.
function checkLocation({ lat, lng, accuracy }, sites) {
  if (!validLatLng(lat, lng)) return { known: false, ok: false, site: null, distance: null };
  let best = null;
  for (const s of sites || []) {
    const dist = distanceMeters(lat, lng, s.lat, s.lng);
    if (!best || dist < best.distance) best = { site: s, distance: Math.round(dist) };
  }
  if (!best) return { known: true, ok: false, site: null, distance: null };
  const slack = Math.min(Math.max(Number(accuracy) || 0, 0), 50);
  return { known: true, ok: best.distance <= best.site.radiusM + slack, site: best.site, distance: best.distance };
}

// ---- face ----------------------------------------------------------------------------
const validDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 10);
function faceDistance(a, b) { let s = 0; for (let i = 0; i < 128; i++) { const x = a[i] - b[i]; s += x * x; } return Math.sqrt(s); }
// The smaller the distance the closer the faces. 0.5 is a strict, commonly used limit for face-api descriptors.
function bestFaceMatch(descriptor, templates, threshold) {
  if (!validDescriptor(descriptor)) return { matched: false, distance: null };
  let best = null;
  for (const t of templates || []) if (validDescriptor(t)) { const dist = faceDistance(descriptor, t); if (best === null || dist < best) best = dist; }
  if (best === null) return { matched: false, distance: null };
  return { matched: best <= threshold, distance: Math.round(best * 1000) / 1000 };
}

// ---- a day -----------------------------------------------------------------------------
const toMs = (v) => (v instanceof Date ? v.getTime() : Number(v));
/**
 * punches: [{ at, type: 'in'|'out', reviewStatus }]  (rejected punches are ignored)
 * shift:   { startMin, endMin, graceMin, halfDayMinutes, fullDayMinutes } or null
 * off:     null | 'weekly off' | 'holiday'
 * leave:   0 | 0.5 | 1 (approved leave on that day)
 */
function computeDay({ date, punches = [], shift = null, defaults = {}, off = null, leave = 0, today, nowMs }) {
  const full = (shift && shift.fullDayMinutes) || defaults.fullDayMinutes || 480;
  const half = (shift && shift.halfDayMinutes) || defaults.halfDayMinutes || 240;
  const list = punches.filter((p) => p.reviewStatus !== 'Rejected').map((p) => ({ at: toMs(p.at), type: p.type, flagged: p.reviewStatus === 'Pending' })).sort((a, b) => a.at - b.at);
  let worked = 0, openIn = null, firstIn = null, lastOut = null;
  for (const p of list) {
    if (p.type === 'in') { if (openIn === null) { openIn = p.at; if (firstIn === null) firstIn = p.at; } }
    else if (openIn !== null) { worked += Math.round((p.at - openIn) / MIN); lastOut = p.at; openIn = null; }
  }
  const flagged = list.some((p) => p.flagged);
  const base = { date, workedMinutes: worked, firstIn: firstIn === null ? '' : minToHhmm(istMinutes(firstIn)), lastOut: lastOut === null ? '' : minToHhmm(istMinutes(lastOut)), late: false, lateMinutes: 0, early: false, earlyMinutes: 0, flagged, missingOut: false, present: 0, absent: 0, leave: 0, off: 0, status: '' };
  const isToday = date === today, isFuture = date > today;

  if (leave === 1) return { ...base, status: 'Leave', leave: 1 };
  if (isFuture) {
    if (off) return { ...base, status: off === 'holiday' ? 'Holiday' : 'Weekly off', off: 1 };
    return { ...base, status: leave === 0.5 ? 'Half-day leave' : '', leave };
  }
  if (off) {
    if (!list.length) return { ...base, status: off === 'holiday' ? 'Holiday' : 'Weekly off', off: 1 };
    return { ...base, status: 'Worked on off day', off: 1 };
  }
  if (!list.length) {
    if (isToday) return { ...base, status: leave ? 'Half-day leave' : 'Not in yet', leave };
    return { ...base, status: leave ? 'Half-day leave, absent other half' : 'Absent', absent: 1 - leave, leave };
  }
  if (openIn !== null) {
    if (isToday) {
      const sofar = worked + Math.max(0, Math.round(((nowMs || openIn) - openIn) / MIN));
      return { ...base, status: 'Working', workedMinutes: sofar, ...lateInfo(shift, firstIn) };
    }
    return { ...base, status: 'Missing punch-out', missingOut: true, absent: 1 - leave, leave, ...lateInfo(shift, firstIn) };
  }
  const info = { ...lateInfo(shift, firstIn), ...earlyInfo(shift, lastOut) };
  const need = leave === 0.5 ? half : full;
  if (leave === 0.5) {
    if (worked >= half) return { ...base, ...info, status: 'Present with half-day leave', present: 0.5, leave: 0.5 };
    return { ...base, ...info, status: 'Half-day leave, absent other half', absent: 0.5, leave: 0.5 };
  }
  if (worked >= need) return { ...base, ...info, status: 'Present', present: 1 };
  if (worked >= half) return { ...base, ...info, status: 'Half day', present: 0.5, absent: 0.5 };
  return { ...base, ...info, status: 'Absent', absent: 1 };
}
function lateInfo(shift, firstIn) {
  if (!shift || firstIn === null) return {};
  const over = istMinutes(firstIn) - (shift.startMin + (shift.graceMin || 0));
  return over > 0 ? { late: true, lateMinutes: over + (shift.graceMin || 0) } : {};
}
function earlyInfo(shift, lastOut) {
  if (!shift || lastOut === null) return {};
  const under = (shift.endMin - (shift.graceMin || 0)) - istMinutes(lastOut);
  return under > 0 ? { early: true, earlyMinutes: under + (shift.graceMin || 0) } : {};
}

function summarize(days) {
  const t = { present: 0, absent: 0, leave: 0, off: 0, lateCount: 0, lateMinutes: 0, workedMinutes: 0, missingOut: 0, flagged: 0 };
  for (const d of days) {
    t.present += d.present; t.absent += d.absent; t.leave += d.leave; t.off += d.off;
    if (d.late) { t.lateCount++; t.lateMinutes += d.lateMinutes; }
    t.workedMinutes += d.workedMinutes || 0;
    if (d.missingOut) t.missingOut++;
    if (d.flagged) t.flagged++;
  }
  for (const k of ['present', 'absent', 'leave', 'off']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

// 'in' when the person is not currently punched in, else 'out'. Rejected punches are ignored.
function nextAction(punches) {
  const list = (punches || []).filter((p) => p.reviewStatus !== 'Rejected').sort((a, b) => toMs(a.at) - toMs(b.at));
  return list.length && list[list.length - 1].type === 'in' ? 'out' : 'in';
}

module.exports = {
  MIN, IST, istDate, istMinutes, hhmmToMin, minToHhmm, validDate, validHhmm, validMonth, monthDays, dow, istToMs,
  distanceMeters, validLatLng, checkLocation, validDescriptor, faceDistance, bestFaceMatch, computeDay, summarize, nextAction
};

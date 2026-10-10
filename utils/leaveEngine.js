// utils/leaveEngine.js
// The leave rules as pure functions (no database): how many days a request uses, which leave year a
// date belongs to, and what a person's balance is. Dates are plain calendar days, 'YYYY-MM-DD'.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

const toMs = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const validDate = (s) => typeof s === 'string' && ISO.test(s) && fromMs(toMs(s)) === s;
const addDays = (s, n) => fromMs(toMs(s) + n * DAY);
const dow = (s) => new Date(toMs(s)).getUTCDay();
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const round2 = (n) => Math.round(n * 100) / 100;

// A day the person does not normally work: weekly off, or a company holiday.
// workOnSunday = this person works Sundays even if Sunday is a company weekly off.
function isOffDay(date, { weekends = [0], holidays = new Set(), workOnSunday = false } = {}) {
  const d = dow(date);
  if (holidays.has(date)) return true;
  if (weekends.includes(d) && !(d === 0 && workOnSunday)) return true;
  return false;
}

/**
 * Days a leave request uses.
 * Without the sandwich rule only working days count. With it, weekly offs and holidays that fall between
 * the first and last working day asked for also count.
 * Returns { error } or { days, detail: [{ d, u }] } where u is 1 or 0.5 per calendar day that counts.
 */
function countLeaveDays({ from, to, halfDay = 'none', sandwich = false, ...cal }) {
  if (!validDate(from) || !validDate(to)) return { error: 'Please choose valid dates.' };
  if (to < from) return { error: 'The "to" date cannot be before the "from" date.' };
  const span = diffDays(from, to) + 1;
  if (span > 366) return { error: 'A leave request can cover at most 366 days.' };
  const working = [];
  for (let i = 0; i < span; i++) { const d = addDays(from, i); if (!isOffDay(d, cal)) working.push(d); }
  if (working.length === 0) return { error: 'These dates are all weekly offs or holidays, so no leave is needed.' };
  if (halfDay !== 'none') {
    if (from !== to) return { error: 'A half day can only be taken on a single day.' };
    return { days: 0.5, detail: [{ d: from, u: 0.5 }] };
  }
  const detail = [];
  if (sandwich) {
    const first = working[0], last = working[working.length - 1];
    for (let d = first; d <= last; d = addDays(d, 1)) detail.push({ d, u: 1 });
  } else working.forEach((d) => detail.push({ d, u: 1 }));
  return { days: detail.length, detail };
}

// Leave year helpers. startMonth 1 = calendar year, 4 = April to March. A year is named by the year it starts in.
const leaveYearOf = (date, startMonth) => { const [y, m] = date.split('-').map(Number); return m >= startMonth ? y : y - 1; };
function yearBounds(year, startMonth) {
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const endMs = Date.UTC(year + 1, startMonth - 1, 1) - DAY;
  return { start, end: fromMs(endMs) };
}
const monthIndex = (date) => { const [y, m] = date.split('-').map(Number); return y * 12 + (m - 1); };

// What has been earned in one leave year, up to and including the month of asOf.
// Joiners earn from the month they joined (a full month counts).
function accruedInYear(type, year, startMonth, asOf, joinDate) {
  const { start, end } = yearBounds(year, startMonth);
  if (type.unlimited) return 0;
  const quota = Number(type.annualQuota) || 0;
  const firstMonth = Math.max(monthIndex(start), joinDate ? monthIndex(joinDate) : -Infinity);
  const lastMonth = Math.min(monthIndex(end), monthIndex(asOf));
  if (lastMonth < firstMonth) return 0;
  const monthsOwned = monthIndex(end) - firstMonth + 1; // months of this year the person is employed
  if (type.accrual === 'upfront') return round2(quota * monthsOwned / 12);
  return round2(quota / 12 * (lastMonth - firstMonth + 1));
}

/**
 * Balance of one leave type for one person, for the leave year that contains asOf.
 *   requests: approved/pending requests of this person for this type, each with daysDetail [{d,u}] and status
 *   adjustments: [{ date, days }]
 * Carry-forward is worked out year by year from the year the person joined.
 */
function computeBalance({ type, startMonth = 1, asOf, joinDate, requests = [], adjustments = [] }) {
  const curYear = leaveYearOf(asOf, startMonth);
  const firstYear = joinDate ? Math.min(leaveYearOf(joinDate, startMonth), curYear) : curYear;
  const inYear = (d, y) => { const b = yearBounds(y, startMonth); return d >= b.start && d <= b.end; };
  let carryIn = 0, out = null;
  for (let y = firstYear; y <= curYear; y++) {
    const b = yearBounds(y, startMonth);
    const accrued = accruedInYear(type, y, startMonth, y === curYear ? asOf : b.end, joinDate);
    const adj = round2(adjustments.reduce((s, a) => s + (inYear(a.date, y) ? a.days : 0), 0));
    let taken = 0, pending = 0;
    for (const r of requests) for (const x of r.daysDetail || []) {
      if (!inYear(x.d, y)) continue;
      if (r.status === 'Approved') taken += x.u; else if (r.status === 'Pending') pending += x.u;
    }
    taken = round2(taken); pending = round2(pending);
    const balance = round2(carryIn + accrued + adj - taken);
    out = { year: y, yearStart: b.start, yearEnd: b.end, carryIn: round2(carryIn), accrued, adjustments: adj, taken, pending, balance, available: round2(balance - pending) };
    const cap = Number(type.carryForwardMax) || 0;
    carryIn = balance > 0 ? Math.min(balance, cap) : balance;
  }
  return out;
}

module.exports = { validDate, addDays, diffDays, dow, isOffDay, countLeaveDays, leaveYearOf, yearBounds, accruedInYear, computeBalance, round2 };

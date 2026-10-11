// utils/payrollEngine.js
// The payroll rules as pure functions (no database). Money is in rupees with 2 decimals.
//
// How a month's pay is worked out:
//   - Every day of the month is paid or unpaid. (A month with no worked day and no paid leave is not paid at all.)
//   - Present days, weekly offs, holidays and PAID leave are paid.
//     Half days are half paid. Absent days, unpaid leave and days before the person joined are not paid.
//   - Pay factor = (days in basis - unpaid days) / days in basis.  Basis is the calendar month, or a fixed 30 days.
//   - Basic and every "prorate" earning are multiplied by the pay factor. Other earnings and all deductions are
//     taken as they are. One-off adjustments (bonus, advance recovery ...) are added after that, unchanged.
//   - Net pay = earnings - deductions, optionally rounded to the whole rupee.
// PF, ESI and professional tax (utils/statutoryEngine.js) are added when the company switches them on.
// Overtime, comp-off, notice pay, arrears and income tax (TDS) are NOT part of this phase.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_MONEY = 100000000; // 10 crore a month is far beyond any real salary: protects against typing errors
const MAX_COMPONENTS = 30;

const money = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY;
const cleanStr = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const slug = (name) => cleanStr(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
const validMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const lastDayOf = (month) => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

const SE = require('./statutoryEngine');
const TDS = require('./tdsEngine');
const DAY_BASIS = ['calendar', '30'];

// ---- salary components (made by the company: HRA, Conveyance, Professional tax ...) -----------------
// { key, name, type: 'earning'|'deduction', calc: 'fixed'|'percentBasic', value, prorate, active }
function sanitizeComponents(list) {
  if (!Array.isArray(list)) return { error: 'Components must be a list.' };
  if (list.length > MAX_COMPONENTS) return { error: `At most ${MAX_COMPONENTS} salary components.` };
  const out = [], keys = new Set(), names = new Set();
  for (const c of list) {
    const name = cleanStr(c && c.name, 40);
    if (name.length < 2) return { error: 'Every salary component needs a name (at least 2 letters).' };
    if (names.has(name.toLowerCase())) return { error: `"${name}" is listed twice.` };
    names.add(name.toLowerCase());
    const type = c.type === 'deduction' ? 'deduction' : c.type === 'earning' ? 'earning' : null;
    if (!type) return { error: `Choose earning or deduction for "${name}".` };
    const calc = c.calc === 'percentBasic' ? 'percentBasic' : 'fixed';
    const value = Number(c.value);
    if (!Number.isFinite(value) || value < 0) return { error: `Enter a valid amount for "${name}".` };
    if (calc === 'percentBasic' && value > 500) return { error: `"${name}" cannot be more than 500% of basic.` };
    if (calc === 'fixed' && value > MAX_MONEY) return { error: `The amount for "${name}" is too large.` };
    let key = cleanStr(c.key, 24) || slug(name);
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(key)) key = slug(name);
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(key)) return { error: `Use letters in the name of "${name}".` };
    if (key === 'basic' || key === 'adjustment') return { error: `"${name}" is a reserved name. Choose another.` };
    if (keys.has(key)) return { error: `"${name}" clashes with another component. Rename one.` };
    keys.add(key);
    out.push({ key, name, type, calc, value: r2(value), prorate: c.prorate === undefined ? type === 'earning' : !!c.prorate, active: c.active !== false, pf: type === 'earning' && !!c.pf });
  }
  return { components: out };
}

// ---- a person's salary structure ---------------------------------------------------------------------
// { effectiveFrom, basic, items: [{ key, amount }], bank, note }
function sanitizeStructure(body, components) {
  const effectiveFrom = body && body.effectiveFrom;
  if (!validDate(effectiveFrom)) return { error: 'Choose the date from which this salary applies.' };
  const basic = Number(body.basic);
  if (!money(basic) || basic <= 0) return { error: 'Enter the monthly basic salary (more than 0).' };
  const comps = new Map((components || []).map((c) => [c.key, c]));
  const seen = new Set(), items = [];
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const key = it && it.key;
    const c = comps.get(key);
    if (!c) return { error: `Unknown salary component: ${cleanStr(key, 30)}` };
    if (seen.has(key)) return { error: `"${c.name}" is added twice.` };
    seen.add(key);
    let amount;
    if (it.amount === undefined || it.amount === null || it.amount === '') amount = c.calc === 'percentBasic' ? r2(basic * c.value / 100) : c.value;
    else amount = Number(it.amount);
    if (!money(amount)) return { error: `Enter a valid amount for "${c.name}".` };
    items.push({ key, amount: r2(amount) });
  }
  const b = body.bank || {};
  const bank = {
    accountName: cleanStr(b.accountName, 80), bankName: cleanStr(b.bankName, 80),
    accountNumber: cleanStr(b.accountNumber, 30).replace(/\s/g, ''), ifsc: cleanStr(b.ifsc, 15).toUpperCase().replace(/\s/g, '')
  };
  if (bank.accountNumber && !/^[0-9A-Za-z-]{6,30}$/.test(bank.accountNumber)) return { error: 'The bank account number looks wrong.' };
  if (bank.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc)) return { error: 'The IFSC code looks wrong (for example HDFC0001234).' };
  // Statutory identity and exemptions (used when PF, ESI or professional tax is switched on for the company)
  const uan = cleanStr(body.uan, 20).replace(/\s/g, ''), esiNumber = cleanStr(body.esiNumber, 20).replace(/\s/g, ''), pan = cleanStr(body.pan, 12).toUpperCase().replace(/\s/g, '');
  if (uan && !/^\d{12}$/.test(uan)) return { error: 'The UAN must be 12 digits.' };
  if (esiNumber && !/^\d{10,17}$/.test(esiNumber)) return { error: 'The ESI number must be 10 to 17 digits.' };
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { error: 'The PAN looks wrong (for example ABCDE1234F).' };
  return { structure: { effectiveFrom, basic: r2(basic), items, bank, note: cleanStr(body.note, 200), uan, esiNumber, pan, pfExempt: !!body.pfExempt, esiExempt: !!body.esiExempt, ptExempt: !!body.ptExempt } };
}

// The structure that applies to a month: the latest one that starts on or before the last day of that month.
function structureForMonth(structures, month) {
  const last = lastDayOf(month);
  let best = null;
  for (const s of structures || []) if (s.effectiveFrom <= last && (!best || s.effectiveFrom > best.effectiveFrom)) best = s;
  return best;
}

// Full monthly amounts of a structure (nothing cut for absence): { earnings, deductions, gross, totalDeductions, net }
function monthlyAmounts(structure, components) {
  const comps = new Map((components || []).map((c) => [c.key, c]));
  const earnings = [{ key: 'basic', name: 'Basic', amount: r2(structure.basic), prorate: true }];
  const deductions = [];
  for (const it of structure.items || []) {
    const c = comps.get(it.key);
    if (!c) continue; // component removed from the company list: ignored
    const row = { key: c.key, name: c.name, amount: r2(it.amount), prorate: !!c.prorate };
    (c.type === 'earning' ? earnings : deductions).push(row);
  }
  const gross = r2(earnings.reduce((s, x) => s + x.amount, 0));
  const totalDeductions = r2(deductions.reduce((s, x) => s + x.amount, 0));
  return { earnings, deductions, gross, totalDeductions, net: r2(gross - totalDeductions) };
}

// ---- days -----------------------------------------------------------------------------------------------
/**
 * days: the attendance engine's day rows for the whole month ({ date, off, present, status, late, missingOut, flagged })
 * paidLeave: Map 'YYYY-MM-DD' -> units (0.5 or 1) of APPROVED PAID leave on that day
 * joined: 'YYYY-MM-DD' or null (days before this are not paid)
 */
function dayCounts({ month, days, paidLeave, joined, dayBasis }) {
  const total = daysInMonth(month);
  let payable = 0, present = 0, paidLeaveDays = 0, off = 0, late = 0, missingOut = 0, flagged = 0;
  for (const d of days) {
    if (joined && d.date < joined) continue;
    if (d.off) { payable += 1; off += 1; continue; }
    const pl = Math.min(1, (paidLeave && paidLeave.get(d.date)) || 0);
    const pr = Math.min(1, d.present || 0);
    payable += Math.min(1, pr + pl);
    present += pr; paidLeaveDays += Math.min(pl, 1 - pr);
    if (d.late) late += 1;
    if (d.missingOut) missingOut += 1;
    if (d.flagged) flagged += 1;
  }
  // Someone who neither worked nor took paid leave in the whole month is not paid for it (weekly offs and holidays included)
  if (present + paidLeaveDays === 0) payable = 0;
  const unpaid = r2(total - payable);
  const basis = dayBasis === '30' ? 30 : total;
  const payableDays = Math.max(0, Math.min(basis, r2(basis - unpaid)));
  return {
    daysInMonth: total, basisDays: basis, payableDays, unpaidDays: unpaid, presentDays: r2(present), paidLeaveDays: r2(paidLeaveDays),
    offDays: off, lateCount: late, missingOutDays: missingOut, flaggedDays: flagged
  };
}

// ---- one person's pay for a month --------------------------------------------------------------------------
/**
 * counts: result of dayCounts, structure + components: see above
 * adjustments: [{ label, type: 'earning'|'deduction', amount, note }]
 * roundNet: round the net pay to the whole rupee
 */
function computeLine({ structure, components, counts, adjustments = [], roundNet = true, statutory = null }) {
  const warnings = [];
  const full = monthlyAmounts(structure, components);
  const factor = counts.basisDays > 0 ? Math.max(0, Math.min(1, counts.payableDays / counts.basisDays)) : 0;
  const earnings = full.earnings.map((e) => ({ key: e.key, name: e.name, full: e.amount, amount: e.prorate ? r2(e.amount * factor) : e.amount }));
  const noPay = counts.payableDays <= 0; // nothing earned this month: nothing is deducted either
  const deductions = full.deductions.map((d) => ({ key: d.key, name: d.name, full: d.amount, amount: noPay ? 0 : d.prorate ? r2(d.amount * factor) : d.amount }));
  // Statutory deductions (PF, ESI, professional tax) on what was earned this month; nothing earned, nothing deducted
  let employer = [], statutoryInfo = null;
  if (statutory && statutory.cfg && SE.anyOn(statutory.cfg)) {
    const st = SE.compute({
      cfg: statutory.cfg, earnings: earnings.map((e) => ({ key: e.key, amount: e.amount })), month: statutory.month,
      pfKeys: new Set((components || []).filter((c) => c.pf).map((c) => c.key)),
      exempt: { pf: structure.pfExempt, esi: structure.esiExempt, pt: structure.ptExempt }, esiCovered: !!statutory.esiCovered
    });
    if (!noPay) { deductions.push(...st.deductions); employer = st.employer; statutoryInfo = st.info; }
    // Income tax on salary: needs the year so far (statutory.tds = { regime, ytd, monthlyGross, decl, hasPan })
    if (!noPay && statutory.cfg.tds.enabled && statutory.tds) {
      const t = statutory.tds;
      const amt = (k) => (st.deductions.find((x) => x.key === k) || { amount: 0 }).amount;
      const bonus = adjustments.filter((a) => a.type !== 'deduction' && money(Number(a.amount))).reduce((s, a) => s + Number(a.amount), 0);
      const earned = r2(earnings.reduce((s, x) => s + x.amount, 0) + bonus);
      const res = TDS.monthlyTds({ month: statutory.month, regime: t.regime, ytd: t.ytd, current: { gross: earned, pf: amt('pf'), pt: amt('pt') }, monthlyGross: Math.max(t.monthlyGross || 0, 0), decl: t.decl });
      if (res.tds > 0) deductions.push({ key: 'tds', name: 'Income tax (TDS)', full: res.tds, amount: res.tds, statutory: true });
      statutoryInfo = { ...(statutoryInfo || {}), tds: res.info };
      if (!t.hasPan && res.tds > 0) warnings.push('No PAN is saved for this person. Tax may have to be deducted at a higher rate.');
      if (t.ytd && t.ytd.count === 0 && TDS.monthsDone(statutory.month) > 0 && (res.info.annualTax > 0 || (t.monthlyGross || 0) * 12 > 600000) && !(t.decl && (t.decl.prevIncome || t.decl.prevTds))) warnings.push('No payroll was found for the earlier months of this financial year. If this person was paid then, enter that income and tax under the tax declaration, or the tax for this month will be too low.');
    }
    if (!noPay && statutory.cfg.pf.enabled && !structure.pfExempt && !structure.uan && st.info.pfContribWages > 0) warnings.push('No UAN is saved for this person (needed for the PF return).');
    if (!noPay && statutory.cfg.esi.enabled && !structure.esiExempt && statutory.esiCovered && !structure.esiNumber) warnings.push('No ESI number is saved for this person (needed for the ESI return).');
    for (const d of full.deductions) if (SE.looksStatutory(d.name)) warnings.push(`"${d.name}" is also a salary deduction, so it may be cut twice. Remove it from the salary if the company now deducts it automatically.`);
  }
  const adj = [];
  for (const a of adjustments) {
    const amount = Number(a.amount);
    if (!money(amount) || amount <= 0) continue;
    adj.push({ label: cleanStr(a.label, 60), type: a.type === 'deduction' ? 'deduction' : 'earning', amount: r2(amount), note: cleanStr(a.note, 200) });
  }
  for (const a of adj) (a.type === 'earning' ? earnings : deductions).push({ key: 'adjustment', name: a.label || (a.type === 'earning' ? 'Addition' : 'Recovery'), full: a.amount, amount: a.amount, adjustment: true });
  const gross = r2(earnings.reduce((s, x) => s + x.amount, 0));
  const totalDeductions = r2(deductions.reduce((s, x) => s + x.amount, 0));
  let net = r2(gross - totalDeductions), rounding = 0;
  if (roundNet && net > 0) { const rounded = Math.round(net); rounding = r2(rounded - net); net = rounded; }
  if (noPay) warnings.push('No paid days this month (no attendance and no paid leave), so nothing is paid.');
  if (net < 0) warnings.push('Net pay is below zero. Reduce the deductions or recoveries.');
  if (counts.missingOutDays) warnings.push(`${counts.missingOutDays} day(s) with a missing punch-out are counted as absent. Correct them in Attendance and recalculate.`);
  if (counts.flaggedDays) warnings.push(`${counts.flaggedDays} day(s) include punches still waiting for review in Attendance.`);
  const employerTotal = r2(employer.reduce((s, x) => s + x.amount, 0));
  return { days: counts, earnings, deductions, employer, employerTotal, statutoryInfo, adjustments: adj, gross, totalDeductions, rounding, net, warnings };
}

// Totals of a run. Lines on hold are left out of what is paid.
function runTotals(lines) {
  const t = { count: 0, held: 0, gross: 0, deductions: 0, net: 0, employer: 0 };
  for (const l of lines) {
    if (l.noStructure) continue;
    if (l.hold) { t.held += 1; continue; }
    t.count += 1; t.gross += l.gross; t.deductions += l.totalDeductions; t.net += l.net; t.employer += l.employerTotal || 0;
  }
  t.gross = r2(t.gross); t.deductions = r2(t.deductions); t.net = r2(t.net); t.employer = r2(t.employer);
  return t;
}

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? '"' + (/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const maskAccount = (n) => (n ? '•'.repeat(Math.max(0, String(n).length - 4)) + String(n).slice(-4) : '');

module.exports = {
  r2, MAX_MONEY, DAY_BASIS, validMonth, validDate, daysInMonth, lastDayOf, cleanStr,
  TDS, sanitizeComponents, sanitizeStructure, structureForMonth, monthlyAmounts, dayCounts, computeLine, runTotals, csv, maskAccount
};

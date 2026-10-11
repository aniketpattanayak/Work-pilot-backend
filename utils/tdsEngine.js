// utils/tdsEngine.js
// Income tax on salary (TDS under section 192) as pure functions (no database).
//
// How a month's TDS is worked out:
//   1. Project the whole financial year (April to March): salary already paid this year + this month + this month's
//      full monthly salary for each month still to come.
//   2. Take the person's regime (old or new) and work out the year's tax: slabs, rebate, surcharge, 4% cess.
//   3. This month's TDS = (year's tax - TDS already deducted this year - TDS the previous employer / earlier months took)
//      divided by the months left (this one included), rounded to the rupee. Never below zero.
// Not covered: salary from two employers combined, perquisites, arrears relief (89), surcharge marginal relief,
// employer NPS (80CCD(2)), and tax on bonus beyond the month it is paid. Have your CA confirm the tables below each year.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_MONEY = 100000000;
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

// Tax tables. `upTo` is the top of each slab (Infinity for the last). Keyed by the year the financial year starts in.
// FY 2026-27 is taken as unchanged from FY 2025-26; check it against the Finance Act.
const TABLES = {
  default: {
    label: 'FY 2025-26 and 2026-27',
    new: {
      standardDeduction: 75000,
      slabs: [[400000, 0], [800000, 5], [1200000, 10], [1600000, 15], [2000000, 20], [2400000, 25], [Infinity, 30]],
      rebateLimit: 1200000, rebateMax: 60000, // no tax up to 12,00,000 of taxable income, with marginal relief just above
      surcharge: [[5000000, 0], [10000000, 10], [20000000, 15], [Infinity, 25]]
    },
    old: {
      standardDeduction: 50000,
      slabs: [[250000, 0], [500000, 5], [1000000, 20], [Infinity, 30]],
      rebateLimit: 500000, rebateMax: 12500,
      surcharge: [[5000000, 0], [10000000, 10], [20000000, 15], [50000000, 25], [Infinity, 37]]
    },
    cess: 4,
    caps: { c80: 150000, nps: 50000, homeLoan: 200000, d80: 100000 }
  }
};
const tableFor = () => TABLES.default;

// Financial year of a payroll month 'YYYY-MM': April to March
function fyOf(month) {
  const [y, m] = month.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { fy: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, startMonth: `${start}-04`, endMonth: `${start + 1}-03`, startYear: start };
}
// Months left in the financial year, this one included (April = 12, March = 1)
const monthsLeft = (month) => { const m = Number(month.split('-')[1]); return m >= 4 ? 12 - (m - 4) : 3 - m + 1; };
const monthsDone = (month) => 12 - monthsLeft(month);

function slabTax(taxable, slabs) {
  let tax = 0, prev = 0;
  for (const [top, pct] of slabs) {
    if (taxable > prev) tax += (Math.min(taxable, top) - prev) * pct / 100;
    prev = top;
    if (taxable <= top) break;
  }
  return tax;
}

/**
 * Tax for the whole year.
 * input: { regime, grossIncome, pf, pt, decl } — pf and pt are the year's employee PF and professional tax
 * decl: { section80C, section80D, nps80CCD1B, homeLoanInterest, hraExemption, otherDeductions }
 */
function annualTax({ regime, grossIncome, pf = 0, pt = 0, decl = {} }) {
  const T = tableFor(); const R = regime === 'old' ? T.old : T.new;
  const d = { section80C: 0, section80D: 0, nps80CCD1B: 0, homeLoanInterest: 0, hraExemption: 0, otherDeductions: 0, ...decl };
  const lines = [{ name: 'Standard deduction', amount: R.standardDeduction }];
  if (regime === 'old') {
    lines.push({ name: 'Professional tax', amount: r2(pt) });
    lines.push({ name: 'House rent allowance exemption', amount: r2(d.hraExemption) });
    lines.push({ name: 'Section 80C (including PF)', amount: r2(Math.min(T.caps.c80, d.section80C + pf)) });
    lines.push({ name: 'Section 80D (health insurance)', amount: r2(Math.min(T.caps.d80, d.section80D)) });
    lines.push({ name: 'NPS 80CCD(1B)', amount: r2(Math.min(T.caps.nps, d.nps80CCD1B)) });
    lines.push({ name: 'Home loan interest', amount: r2(Math.min(T.caps.homeLoan, d.homeLoanInterest)) });
    lines.push({ name: 'Other deductions', amount: r2(d.otherDeductions) });
  }
  const totalDed = r2(lines.reduce((s, x) => s + x.amount, 0));
  const taxable = Math.max(0, Math.floor((grossIncome - totalDed) / 10) * 10); // taxable income is rounded down to ten rupees
  let tax = slabTax(taxable, R.slabs);
  if (taxable <= R.rebateLimit) tax = Math.max(0, tax - R.rebateMax);
  else if (regime !== 'old') tax = Math.min(tax, taxable - R.rebateLimit); // marginal relief just above the rebate limit
  let surchargePct = 0;
  for (const [top, pct] of R.surcharge) { surchargePct = pct; if (taxable <= top) break; }
  const surcharge = tax * surchargePct / 100;
  const cess = (tax + surcharge) * T.cess / 100;
  return { regime, grossIncome: r2(grossIncome), deductions: lines, totalDeductions: totalDed, taxable, tax: r2(tax), surcharge: r2(surcharge), cess: r2(cess), total: Math.round(tax + surcharge + cess) };
}

/**
 * This month's TDS.
 * month: 'YYYY-MM'; regime: 'old' | 'new'
 * ytd: { gross, pf, pt, tds, count } from the earlier payroll runs of this financial year
 * current: { gross, pf, pt } this month (gross includes bonuses); monthlyGross: the full monthly salary on the salary record
 * decl: declaration (may carry prevIncome, prevTds)
 */
function monthlyTds({ month, regime, ytd, current, monthlyGross, decl }) {
  const n = monthsLeft(month);
  const d = decl || {};
  const prevIncome = Number(d.prevIncome) || 0, prevTds = Number(d.prevTds) || 0;
  const future = n - 1;
  const grossIncome = (ytd.gross || 0) + current.gross + future * monthlyGross + prevIncome;
  const pf = (ytd.pf || 0) + current.pf + future * current.pf;
  const pt = (ytd.pt || 0) + current.pt + future * current.pt;
  const year = annualTax({ regime, grossIncome, pf, pt, decl: d });
  const already = (ytd.tds || 0) + prevTds;
  const tds = Math.max(0, Math.round((year.total - already) / n));
  return { tds, info: { fy: fyOf(month).fy, regime, monthsLeft: n, projectedIncome: r2(grossIncome), taxable: year.taxable, annualTax: year.total, alreadyDeducted: r2(already), deductions: year.deductions.filter((x) => x.amount > 0) } };
}

// Checks a person's declaration for one financial year
function sanitizeDeclaration(body) {
  const b = body || {};
  const regime = b.regime === 'old' ? 'old' : b.regime === 'new' ? 'new' : '';
  const out = { regime };
  for (const k of ['section80C', 'section80D', 'nps80CCD1B', 'homeLoanInterest', 'hraExemption', 'otherDeductions', 'prevIncome', 'prevTds']) {
    const raw = b[k] === undefined || b[k] === null || b[k] === '' ? 0 : b[k];
    const v = num(raw, 0, MAX_MONEY);
    if (v === null) return { error: 'Enter amounts as numbers (rupees), not below zero.' };
    out[k] = r2(v);
  }
  return { declaration: out };
}
const validFy = (s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s) && ((Number(s.slice(0, 4)) + 1) % 100) === Number(s.slice(5));

module.exports = { TABLES, tableFor, fyOf, monthsLeft, monthsDone, annualTax, monthlyTds, sanitizeDeclaration, validFy };

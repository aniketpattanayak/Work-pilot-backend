// utils/statutoryEngine.js
// India statutory deductions as pure functions (no database): Provident Fund, ESI and Professional Tax.
// Everything is OFF until a company switches it on, and every rate and limit is editable because the law changes.
//
//   PF   wages = Basic + earnings marked "counts for PF", as earned this month (after absence cuts).
//        Contribution wages = those wages, capped at the ceiling (15,000) unless the company chooses actual wages.
//        Employee = employeePct of contribution wages. Employer = employerPct, of which epsPct (on wages capped at epsCeiling)
//        goes to the pension scheme and the rest to the PF account. Admin and EDLI charges are shown as employer cost.
//        Amounts are rounded to the nearest rupee.
//   ESI  applies when the monthly salary on the salary record is at or below the limit (21,000). Whoever is covered at the
//        start of a contribution period (April-September, October-March) stays covered until it ends.
//        Contribution wages = gross earned this month. Employee and employer shares are rounded UP to the next rupee.
//   PT   a slab table by state, looked up with the gross earned this month. A slab can carry a different amount for February.
//        Half-yearly states (Tamil Nadu, Kerala ...) are not supported: enter their yearly amounts as a monthly slab if needed.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_MONEY = 100000000;
const cleanStr = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

const DEFAULTS = {
  pf: { enabled: false, capWages: true, wageCeiling: 15000, employeePct: 12, employerPct: 12, epsPct: 8.33, epsCeiling: 15000, adminPct: 0.5, edliPct: 0.5 },
  esi: { enabled: false, grossLimit: 21000, employeePct: 0.75, employerPct: 3.25 },
  pt: { enabled: false, state: '', slabs: [] },
  tds: { enabled: false, defaultRegime: 'new' }
};

// Starting slab tables. The company must check them against the current state notification before use.
const PT_PRESETS = {
  'Maharashtra': { note: 'Women are exempt up to 25,000 a month: mark them "No professional tax" on their salary.', slabs: [{ from: 0, amount: 0 }, { from: 7501, amount: 175 }, { from: 10001, amount: 200, febAmount: 300 }] },
  'Karnataka': { note: '', slabs: [{ from: 0, amount: 0 }, { from: 25000, amount: 200, febAmount: 300 }] },
  'West Bengal': { note: '', slabs: [{ from: 0, amount: 0 }, { from: 10001, amount: 110 }, { from: 15001, amount: 130 }, { from: 25001, amount: 150 }, { from: 40001, amount: 200 }] },
  'Telangana': { note: '', slabs: [{ from: 0, amount: 0 }, { from: 15001, amount: 150 }, { from: 20001, amount: 200 }] },
  'Andhra Pradesh': { note: '', slabs: [{ from: 0, amount: 0 }, { from: 15001, amount: 150 }, { from: 20001, amount: 200 }] },
  'Gujarat': { note: '', slabs: [{ from: 0, amount: 0 }, { from: 12001, amount: 200 }] }
};

const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

// Merge saved settings over the defaults
function withDefaults(saved) {
  const s = saved || {};
  return {
    pf: { ...DEFAULTS.pf, ...(s.pf || {}) },
    esi: { ...DEFAULTS.esi, ...(s.esi || {}) },
    pt: { ...DEFAULTS.pt, ...(s.pt || {}), slabs: ((s.pt && s.pt.slabs) || []).map((x) => ({ from: x.from, amount: x.amount, ...(x.febAmount != null ? { febAmount: x.febAmount } : {}) })) },
    tds: { ...DEFAULTS.tds, ...(s.tds || {}) }
  };
}
const anyOn = (cfg) => !!(cfg && ((cfg.pf && cfg.pf.enabled) || (cfg.esi && cfg.esi.enabled) || (cfg.pt && cfg.pt.enabled) || (cfg.tds && cfg.tds.enabled)));

// Checks what the setup screen sends and returns the clean settings
function sanitizeStatutory(body) {
  const b = body || {};
  const out = withDefaults(null);
  const pf = b.pf || {}, esi = b.esi || {}, pt = b.pt || {}, tds = b.tds || {};
  out.tds.enabled = !!tds.enabled; out.tds.defaultRegime = tds.defaultRegime === 'old' ? 'old' : 'new';
  out.pf.enabled = !!pf.enabled; out.pf.capWages = pf.capWages === undefined ? true : !!pf.capWages;
  const pick = (obj, key, label, min, max, into) => { const v = num(obj[key], min, max); if (v === null) return `Enter a valid ${label}.`; into[key] = r2(v); return null; };
  for (const [k, label, max] of [['wageCeiling', 'PF wage ceiling', MAX_MONEY], ['employeePct', 'employee PF percentage', 50], ['employerPct', 'employer PF percentage', 50], ['epsPct', 'pension (EPS) percentage', 50], ['epsCeiling', 'pension wage ceiling', MAX_MONEY], ['adminPct', 'PF admin charge percentage', 10], ['edliPct', 'EDLI percentage', 10]]) {
    const e = pick({ ...DEFAULTS.pf, ...pf }, k, label, 0, max, out.pf); if (e) return { error: e };
  }
  if (out.pf.epsPct > out.pf.employerPct) return { error: 'The pension share cannot be more than the employer PF percentage.' };
  out.esi.enabled = !!esi.enabled;
  for (const [k, label, max] of [['grossLimit', 'ESI salary limit', MAX_MONEY], ['employeePct', 'employee ESI percentage', 20], ['employerPct', 'employer ESI percentage', 20]]) {
    const e = pick({ ...DEFAULTS.esi, ...esi }, k, label, 0, max, out.esi); if (e) return { error: e };
  }
  out.pt.enabled = !!pt.enabled; out.pt.state = cleanStr(pt.state, 40);
  const slabs = Array.isArray(pt.slabs) ? pt.slabs : [];
  if (slabs.length > 12) return { error: 'At most 12 professional tax slabs.' };
  const seen = new Set(); const list = [];
  for (const x of slabs) {
    const from = num(x && x.from, 0, MAX_MONEY), amount = num(x && x.amount, 0, 2500);
    if (from === null || amount === null) return { error: 'Every professional tax slab needs a starting salary and an amount (up to 2,500).' };
    let feb = null;
    if (x.febAmount !== undefined && x.febAmount !== null && x.febAmount !== '') { feb = num(x.febAmount, 0, 2500); if (feb === null) return { error: 'The February amount of a professional tax slab is not valid.' }; }
    if (seen.has(from)) return { error: 'Two professional tax slabs start at the same salary.' };
    seen.add(from);
    list.push({ from: r2(from), amount: r2(amount), ...(feb !== null ? { febAmount: r2(feb) } : {}) });
  }
  list.sort((a, b) => a.from - b.from);
  if (out.pt.enabled && !list.length) return { error: 'Add at least one professional tax slab, or switch professional tax off.' };
  out.pt.slabs = list;
  return { statutory: out };
}

// ESI coverage for a month: judged on the contract gross of the salary record at the start of the contribution period.
function esiPeriodStart(month) {
  const [y, m] = month.split('-').map(Number);
  if (m >= 4 && m <= 9) return `${y}-04`;
  if (m >= 10) return `${y}-10`;
  return `${y - 1}-10`;
}

const nameRows = {
  pf: 'Provident Fund (employee)', esi: 'ESI (employee)', pt: 'Professional Tax'
};

/**
 * cfg: settings (withDefaults), earnings: [{ key, amount }] earned this month (no adjustments), pfKeys: Set of component keys
 * that count for PF (Basic always does), month 'YYYY-MM', exempt: { pf, esi, pt }, esiCovered: boolean
 * Returns { deductions: [...], employer: [...], info }
 */
function compute({ cfg, earnings, pfKeys, month, exempt, esiCovered }) {
  const ex = exempt || {};
  const deductions = [], employer = [];
  const info = { pfWages: 0, pfContribWages: 0, esiWages: 0, epsWages: 0, ptSlab: null };
  const gross = r2(earnings.reduce((s, x) => s + x.amount, 0));
  const row = (arr, key, name, amount) => arr.push({ key, name, full: amount, amount, statutory: true });

  if (cfg.pf.enabled && !ex.pf) {
    const wages = r2(earnings.filter((x) => x.key === 'basic' || (pfKeys && pfKeys.has(x.key))).reduce((s, x) => s + x.amount, 0));
    const contrib = cfg.pf.capWages ? Math.min(wages, cfg.pf.wageCeiling) : wages;
    info.pfWages = wages; info.pfContribWages = r2(contrib);
    if (contrib > 0) {
      const emp = Math.round(r2(contrib * cfg.pf.employeePct / 100));
      const er = Math.round(r2(contrib * cfg.pf.employerPct / 100));
      const epsBase = Math.min(contrib, cfg.pf.epsCeiling); info.epsWages = r2(epsBase);
      const eps = Math.min(er, Math.round(r2(epsBase * cfg.pf.epsPct / 100)));
      if (emp > 0) row(deductions, 'pf', nameRows.pf, emp);
      if (er > 0) {
        row(employer, 'pf_er_epf', 'PF account (employer)', er - eps);
        if (eps > 0) row(employer, 'pf_er_eps', 'Pension EPS (employer)', eps);
      }
      const admin = Math.round(r2(contrib * cfg.pf.adminPct / 100));
      const edli = Math.round(r2(Math.min(contrib, 15000) * cfg.pf.edliPct / 100));
      if (admin > 0) row(employer, 'pf_admin', 'PF admin charge (employer)', admin);
      if (edli > 0) row(employer, 'pf_edli', 'EDLI (employer)', edli);
    }
  }
  if (cfg.esi.enabled && !ex.esi && esiCovered && gross > 0) {
    info.esiWages = gross;
    const emp = Math.ceil(r2(gross * cfg.esi.employeePct / 100));
    const er = Math.ceil(r2(gross * cfg.esi.employerPct / 100));
    if (emp > 0) row(deductions, 'esi', nameRows.esi, emp);
    if (er > 0) row(employer, 'esi_er', 'ESI (employer)', er);
  }
  if (cfg.pt.enabled && !ex.pt && gross > 0) {
    let slab = null;
    for (const s of cfg.pt.slabs) if (s.from <= gross && (!slab || s.from > slab.from)) slab = s;
    if (slab) {
      info.ptSlab = slab.from;
      const isFeb = month.slice(5, 7) === '02';
      const amount = isFeb && slab.febAmount != null ? slab.febAmount : slab.amount;
      if (amount > 0) row(deductions, 'pt', nameRows.pt, r2(amount));
    }
  }
  return { deductions, employer, info };
}

// A manual salary deduction that looks like a statutory one would be cut twice
const looksStatutory = (name) => /provident|\bpf\b|\besi\b|employee state|professional tax|\bp\.?\s?tax\b|\btds\b|income tax/i.test(String(name || ''));

module.exports = { DEFAULTS, PT_PRESETS, withDefaults, anyOn, sanitizeStatutory, esiPeriodStart, compute, looksStatutory };

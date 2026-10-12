// utils/payrollReview.js
// Helps a reviewer (HR head, finance, the company's CA) check a payroll before it is approved, and compare it with another payroll.
// Pure functions (no database).
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sum = (rows, key) => (rows || []).filter((x) => x.key === key).reduce((s, x) => s + (x.amount || 0), 0);
const oid = (v) => String(v && v._id ? v._id : v);
const list = (names, max = 6) => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

// Statutory totals of a run (everyone with a salary, also those on hold)
function statutoryTotals(run) {
  const t = { pfEmployee: 0, pfEmployer: 0, esiEmployee: 0, esiEmployer: 0, professionalTax: 0, tds: 0, employerCost: 0 };
  for (const l of run.lines || []) {
    if (l.noStructure) continue;
    t.pfEmployee += sum(l.deductions, 'pf'); t.esiEmployee += sum(l.deductions, 'esi'); t.professionalTax += sum(l.deductions, 'pt'); t.tds += sum(l.deductions, 'tds');
    t.pfEmployer += sum(l.employer, 'pf_er_epf') + sum(l.employer, 'pf_er_eps'); t.esiEmployer += sum(l.employer, 'esi_er');
    t.employerCost += l.employerTotal || 0;
  }
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  return t;
}

/**
 * Automatic checks on a run. `prev` is the previous month's payroll (or null).
 * Each check: { level: 'error' | 'warn' | 'info', text, people: [names] }
 */
function reviewChecks(run, prev) {
  const checks = [];
  const lines = (run.lines || []).filter((l) => !l.noStructure);
  const add = (level, text, people) => checks.push({ level, text, people: people || [] });

  const broken = lines.filter((l) => Math.abs(r2(l.gross - l.totalDeductions + (l.rounding || 0)) - l.net) > 0.01);
  if (broken.length) add('error', 'The figures do not add up (gross, deductions, rounding and net).', broken.map((l) => l.name));
  const neg = lines.filter((l) => !l.hold && l.net < 0);
  if (neg.length) add('error', 'Net pay is below zero.', neg.map((l) => l.name));
  const totalNet = r2(lines.filter((l) => !l.hold).reduce((s, l) => s + l.net, 0));
  if (run.totals && Math.abs(r2(run.totals.net) - totalNet) > 0.01) add('error', `The payroll total (${run.totals.net}) does not match the sum of the lines (${totalNet}). Recalculate.`);

  const none = (run.lines || []).filter((l) => l.noStructure);
  if (none.length) add('warn', 'No salary is set, so these people are not in the payroll.', none.map((l) => l.name));
  const zero = lines.filter((l) => !l.hold && l.net === 0);
  if (zero.length) add('warn', 'Nothing is paid (no paid days).', zero.map((l) => l.name));
  const warned = lines.filter((l) => !l.hold && (l.warnings || []).length);
  if (warned.length) add('warn', `${warned.length} ${warned.length === 1 ? 'person has' : 'people have'} warnings (missing IDs, attendance to correct ...). Open the payroll to read them.`, warned.map((l) => l.name));
  const held = lines.filter((l) => l.hold);
  if (held.length) add('info', 'Payment on hold.', held.map((l) => `${l.name}${l.holdNote ? ' (' + l.holdNote + ')' : ''}`));
  const adjusted = lines.filter((l) => (l.adjustments || []).length);
  if (adjusted.length) add('info', 'One-off additions or recoveries entered.', adjusted.map((l) => `${l.name}: ${l.adjustments.map((a) => `${a.type === 'deduction' ? '-' : '+'}${a.amount} ${a.label}`).join(', ')}`));

  if (prev) {
    const before = new Map((prev.lines || []).filter((l) => !l.noStructure).map((l) => [oid(l.employeeId), l]));
    const joined = lines.filter((l) => !before.has(oid(l.employeeId)));
    if (joined.length) add('info', `New compared with ${prev.month}.`, joined.map((l) => l.name));
    const now = new Set(lines.map((l) => oid(l.employeeId)));
    const left = [...before.values()].filter((l) => !now.has(oid(l.employeeId)));
    if (left.length) add('warn', `In the ${prev.month} payroll but not in this one.`, left.map((l) => l.name));
    const moved = [];
    for (const l of lines) {
      const b = before.get(oid(l.employeeId));
      if (!b || !(b.gross > 0)) continue;
      const pct = (l.gross - b.gross) / b.gross * 100;
      if (Math.abs(pct) >= 10) moved.push(`${l.name} (${pct > 0 ? '+' : ''}${r2(pct)}%)`);
    }
    if (moved.length) add('warn', `Gross pay changed by 10% or more since ${prev.month}.`, moved);
  } else add('info', 'There is no earlier payroll to compare with.');

  const order = { error: 0, warn: 1, info: 2 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return checks.map((c) => ({ ...c, people: c.people.slice(0, 20), more: Math.max(0, c.people.length - 20), summary: list(c.people) }));
}

// ---- CSV of another payroll (the one in use today) ----------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
const toNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[₹,\s]|rs\.?/gi, '')); return Number.isFinite(n) ? n : null; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const COLUMNS = [
  ['name', /^(employee )?name$|^employee$|^emp name$|^name of employee$/], ['gross', /gross/], ['net', /^net|net pay|take home|net salary|net amount/],
  ['pf', /provident|^pf$|^pf |employee pf|epf/], ['esi', /^esi|employee state/], ['pt', /professional tax|^pt$|^p tax/], ['tds', /^tds|income tax/]
];

// Reads the other payroll's file: finds the header row and the columns (name, gross, net and, if present, PF, ESI, PT, TDS)
function readOtherPayroll(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: 'The file has no rows. Use a CSV with a header row and one row per person.' };
  if (rows.length > 5001) return { error: 'The file has too many rows (the limit is 5,000 people).' };
  let headerAt = -1, cols = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const found = {};
    rows[i].forEach((c, idx) => { const h = norm(c); for (const [key, re] of COLUMNS) if (found[key] === undefined && re.test(h)) { found[key] = idx; break; } });
    if (found.name !== undefined && (found.net !== undefined || found.gross !== undefined)) { headerAt = i; cols = found; break; }
  }
  if (headerAt < 0) return { error: 'Could not find the columns. The first row needs a name column and a Gross or Net column (for example: Employee Name, Gross, Net Pay).' };
  const people = [], skipped = [];
  for (const r of rows.slice(headerAt + 1)) {
    const name = String(r[cols.name] || '').trim();
    if (!name || /^total/i.test(name)) continue;
    const rec = { name };
    for (const k of ['gross', 'net', 'pf', 'esi', 'pt', 'tds']) if (cols[k] !== undefined) { const n = toNum(r[cols[k]]); if (n === null && String(r[cols[k]] || '').trim() !== '') skipped.push(`${name}: "${r[cols[k]]}" is not a number`); rec[k] = n; }
    people.push(rec);
  }
  if (!people.length) return { error: 'No people were found under the header row.' };
  return { people, columns: Object.keys(cols), skipped: skipped.slice(0, 10) };
}

/**
 * Compares a run with the other payroll's people. Matching is by name (case and spacing ignored).
 * tolerance: differences up to this many rupees count as equal
 */
function compareRun(run, other, tolerance = 1) {
  const mine = (run.lines || []).filter((l) => !l.noStructure);
  const byName = new Map(); const dup = new Set();
  for (const l of mine) { const k = norm(l.name); if (byName.has(k)) dup.add(k); byName.set(k, l); }
  const matched = [], onlyOther = [], used = new Set();
  const fields = ['gross', 'net', 'pf', 'esi', 'pt', 'tds'].filter((f) => other.columns.includes(f));
  const mineVal = (l, f) => (f === 'gross' ? l.gross : f === 'net' ? l.net : sum(l.deductions, f));
  for (const p of other.people) {
    const k = norm(p.name); const l = byName.get(k);
    if (!l || dup.has(k)) { onlyOther.push(p.name + (dup.has(k) ? ' (two people share this name in Work-Pilot)' : '')); continue; }
    used.add(k);
    const diffs = [];
    for (const f of fields) {
      if (p[f] === null || p[f] === undefined) continue;
      const mv = r2(mineVal(l, f)); const d = r2(mv - p[f]);
      if (Math.abs(d) > tolerance) diffs.push({ field: f, workPilot: mv, other: p[f], difference: d });
    }
    matched.push({ name: l.name, same: diffs.length === 0, diffs });
  }
  const onlyMine = mine.filter((l) => !used.has(norm(l.name))).map((l) => l.name + (l.hold ? ' (on hold)' : ''));
  const different = matched.filter((m) => !m.same);
  const totals = {};
  for (const f of fields) {
    totals[f] = { workPilot: r2(mine.filter((l) => used.has(norm(l.name))).reduce((s, l) => s + mineVal(l, f), 0)), other: r2(other.people.filter((p) => used.has(norm(p.name))).reduce((s, p) => s + (p[f] || 0), 0)) };
    totals[f].difference = r2(totals[f].workPilot - totals[f].other);
  }
  return { columns: other.columns, tolerance, counts: { matched: matched.length, same: matched.length - different.length, different: different.length, onlyOther: onlyOther.length, onlyWorkPilot: onlyMine.length }, different: different.slice(0, 200), onlyOther: onlyOther.slice(0, 100), onlyWorkPilot: onlyMine.slice(0, 100), totals, skipped: other.skipped };
}

module.exports = { statutoryTotals, reviewChecks, parseCsv, readOtherPayroll, compareRun };

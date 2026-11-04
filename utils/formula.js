// utils/formula.js
// A tiny, SAFE formula language for company-defined "formula" fields (no eval, no code).
// Example:  {quantity} * {rate}     IF({qty} > 10, {qty} * 0.9, {qty})     DAYS({end}, {start})
// {name} = the value of another field of the same form (its key, shown in the designer).
// The very same code is used in the browser (src/utils/formula.js) - keep the two files identical.
'use strict';

const MAX_LEN = 300;
const FUNCS = {
  IF: (c, a, b) => (truthy(c) ? a : b),
  ROUND: (x, n) => { const v = num(x); if (v === null) return null; const k = Math.pow(10, Math.max(0, Math.min(6, Math.floor(num(n) || 0)))); return Math.round(v * k) / k; },
  ABS: (x) => { const v = num(x); return v === null ? null : Math.abs(v); },
  CEIL: (x) => { const v = num(x); return v === null ? null : Math.ceil(v); },
  FLOOR: (x) => { const v = num(x); return v === null ? null : Math.floor(v); },
  MIN: (...a) => { const v = a.map(num).filter((x) => x !== null); return v.length ? Math.min(...v) : null; },
  MAX: (...a) => { const v = a.map(num).filter((x) => x !== null); return v.length ? Math.max(...v) : null; },
  SUM: (...a) => a.map(num).filter((x) => x !== null).reduce((s, x) => s + x, 0),
  AVG: (...a) => { const v = a.map(num).filter((x) => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; },
  CONCAT: (...a) => a.map((x) => (x === null || x === undefined ? '' : String(x))).join(''),
  LEN: (x) => String(x === null || x === undefined ? '' : x).length,
  UPPER: (x) => String(x === null || x === undefined ? '' : x).toUpperCase(),
  LOWER: (x) => String(x === null || x === undefined ? '' : x).toLowerCase(),
  AND: (...a) => a.every(truthy),
  OR: (...a) => a.some(truthy),
  NOT: (x) => !truthy(x),
  ISBLANK: (x) => x === null || x === undefined || x === '',
  TODAY: () => ymd(new Date()),
  DAYS: (a, b) => { const x = day(a), y = day(b); return x === null || y === null ? null : Math.round((x - y) / 86400000); },
  ADDDAYS: (d, n) => { const x = day(d), k = num(n); return x === null || k === null ? null : ymd(new Date(x + k * 86400000)); },
};

function ymd(d) { return d.toISOString().slice(0, 10); }
function day(v) {
  const s = String(v === null || v === undefined ? '' : v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00.000Z');
  return Number.isNaN(t) ? null : t;
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function truthy(v) { return !(v === null || v === undefined || v === '' || v === false || v === 0); }

// ── tokens ──
function tokenize(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') { const j = src.indexOf('}', i); if (j < 0) throw new Error('A { is not closed with }.'); const name = src.slice(i + 1, j).trim(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"{${name}}" is not a valid field key.`); out.push({ t: 'ref', v: name }); i = j + 1; continue; }
    if (c === '"' || c === "'") { const j = src.indexOf(c, i + 1); if (j < 0) throw new Error('A text in quotes is not closed.'); out.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue; }
    if (/[0-9.]/.test(c)) { const m = /^\d*\.?\d+/.exec(src.slice(i)); if (!m) throw new Error('Unexpected "."'); out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); out.push({ t: 'name', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '<>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>=(),&'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}".`);
  }
  return out;
}

// ── parser (recursive descent) → AST ──
function parse(src) {
  const text = String(src || '').trim();
  if (!text) throw new Error('Write the formula.');
  if (text.length > MAX_LEN) throw new Error(`The formula is too long (${MAX_LEN} characters at most).`);
  const toks = tokenize(text); let p = 0; const refs = new Set(); let nodes = 0;
  const peek = () => toks[p]; const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const bump = () => { if (++nodes > 200) throw new Error('The formula is too complex.'); return toks[p++]; };
  function expr() { return cmp(); }
  function cmp() {
    let l = add();
    while (peek() && peek().t === 'op' && ['==', '=', '!=', '<>', '<', '>', '<=', '>='].includes(peek().v)) { const op = bump().v; l = { k: 'bin', op, l, r: add() }; }
    return l;
  }
  function add() { let l = mul(); while (peek() && peek().t === 'op' && ['+', '-', '&'].includes(peek().v)) { const op = bump().v; l = { k: 'bin', op, l, r: mul() }; } return l; }
  function mul() { let l = unary(); while (peek() && peek().t === 'op' && ['*', '/', '%'].includes(peek().v)) { const op = bump().v; l = { k: 'bin', op, l, r: unary() }; } return l; }
  function unary() { if (isOp('-')) { bump(); return { k: 'neg', e: unary() }; } if (isOp('+')) { bump(); return unary(); } return primary(); }
  function primary() {
    const t = peek(); if (!t) throw new Error('The formula ends too early.');
    if (t.t === 'num') { bump(); return { k: 'lit', v: t.v }; }
    if (t.t === 'str') { bump(); return { k: 'lit', v: t.v }; }
    if (t.t === 'ref') { bump(); refs.add(t.v); return { k: 'ref', n: t.v }; }
    if (t.t === 'name') {
      bump();
      if (t.v === 'TRUE') return { k: 'lit', v: true };
      if (t.v === 'FALSE') return { k: 'lit', v: false };
      if (!FUNCS[t.v]) throw new Error(`Unknown function ${t.v}. You can use: ${Object.keys(FUNCS).join(', ')}.`);
      if (!isOp('(')) throw new Error(`${t.v} needs brackets, like ${t.v}(...).`);
      bump(); const args = [];
      if (!isOp(')')) { for (;;) { args.push(expr()); if (isOp(',')) { bump(); continue; } break; } }
      if (!isOp(')')) throw new Error(`A bracket after ${t.v}( is not closed.`);
      bump(); return { k: 'fn', n: t.v, a: args };
    }
    if (isOp('(')) { bump(); const e = expr(); if (!isOp(')')) throw new Error('A bracket is not closed.'); bump(); return e; }
    throw new Error(`Unexpected "${t.v}".`);
  }
  const ast = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}".`);
  return { ast, refs: [...refs] };
}

function evaluate(node, get) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ref': { const v = get(node.n); return v === undefined ? null : v; }
    case 'neg': { const v = num(evaluate(node.e, get)); return v === null ? null : -v; }
    case 'fn': return FUNCS[node.n](...node.a.map((a) => evaluate(a, get)));
    case 'bin': {
      const a = evaluate(node.l, get), b = evaluate(node.r, get);
      const op = node.op;
      if (op === '&') return String(a === null ? '' : a) + String(b === null ? '' : b);
      if (['==', '=', '!=', '<>', '<', '>', '<=', '>='].includes(op)) {
        const na = num(a), nb = num(b);
        const both = na !== null && nb !== null;
        const x = both ? na : String(a === null ? '' : a), y = both ? nb : String(b === null ? '' : b);
        if (op === '==' || op === '=') return x === y;
        if (op === '!=' || op === '<>') return x !== y;
        if (op === '<') return x < y; if (op === '>') return x > y; if (op === '<=') return x <= y; return x >= y;
      }
      if (op === '+' && (typeof a === 'string' && num(a) === null || typeof b === 'string' && num(b) === null)) return String(a === null ? '' : a) + String(b === null ? '' : b);
      const x = num(a) === null ? 0 : num(a), y = num(b) === null ? 0 : num(b);
      if (op === '+') return x + y; if (op === '-') return x - y; if (op === '*') return x * y;
      if (op === '/') return y === 0 ? null : x / y;
      return y === 0 ? null : x % y;
    }
    default: return null;
  }
}

// compute('{a} * {b}', (name) => values[name], { decimals: 2 })  ->  number | string | null
function compute(expression, get, opts = {}) {
  let parsed; try { parsed = parse(expression); } catch (e) { return null; }
  let v; try { v = evaluate(parsed.ast, get); } catch (e) { return null; }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const d = Number.isInteger(opts.decimals) ? Math.max(0, Math.min(6, opts.decimals)) : null;
    return d === null ? Math.round(v * 1e6) / 1e6 : Number(v.toFixed(d));
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v === null || v === undefined ? null : String(v).slice(0, 500);
}

module.exports = { parse, evaluate, compute, FUNCS_LIST: Object.keys(FUNCS) };

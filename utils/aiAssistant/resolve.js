// Part 1 of the AI-layer-v2 spec: smart name/entity matching.
//
// Used by every tool that resolves a person, task, leave type or department
// from a user-typed string. Pure, synchronous, no I/O - callers pass in the
// candidate list (already fetched through the real route, already scoped to
// the user's own tenant/permissions by that route) and get back a ranked
// result plus a decision of what to do next.
//
// No new npm dependency is added: Levenshtein, a Soundex-style phonetic key,
// and the Devanagari transliteration table below are all implemented locally
// so this works offline and needs no server-side install step.

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'shri', 'smt', 'sir', 'madam', 'ji', 'dr', 'shree', 'mx',
]);

// Minimal Devanagari -> Latin transliteration. Covers common name syllables;
// not a full IAST transliterator, but enough to turn "अनिकेत" into "aniket"
// so the same fuzzy matching below applies to it.
const DEVANAGARI_MAP = [
  ['अ', 'a'], ['आ', 'aa'], ['इ', 'i'], ['ई', 'ee'], ['उ', 'u'], ['ऊ', 'oo'],
  ['ए', 'e'], ['ऐ', 'ai'], ['ओ', 'o'], ['औ', 'au'], ['ऋ', 'ri'],
  ['क', 'k'], ['ख', 'kh'], ['ग', 'g'], ['घ', 'gh'], ['ङ', 'ng'],
  ['च', 'ch'], ['छ', 'chh'], ['ज', 'j'], ['झ', 'jh'], ['ञ', 'ny'],
  ['ट', 't'], ['ठ', 'th'], ['ड', 'd'], ['ढ', 'dh'], ['ण', 'n'],
  ['त', 't'], ['थ', 'th'], ['द', 'd'], ['ध', 'dh'], ['न', 'n'],
  ['प', 'p'], ['फ', 'ph'], ['ब', 'b'], ['भ', 'bh'], ['म', 'm'],
  ['य', 'y'], ['र', 'r'], ['ल', 'l'], ['व', 'v'], ['श', 'sh'],
  ['ष', 'sh'], ['स', 's'], ['ह', 'h'],
  ['ा', 'a'], ['ि', 'i'], ['ी', 'ee'], ['ु', 'u'], ['ू', 'oo'],
  ['े', 'e'], ['ै', 'ai'], ['ो', 'o'], ['ौ', 'au'], ['ं', 'n'], ['ः', 'h'],
  ['्', ''], // virama - drop the inherent vowel
];

function isDevanagari(str) {
  return /[ऀ-ॿ]/.test(str);
}

function transliterateDevanagari(str) {
  let out = str;
  for (const [dev, lat] of DEVANAGARI_MAP) {
    out = out.split(dev).join(lat);
  }
  return out;
}

// Indian-name-specific spelling-variant rules: collapse common alternate
// romanisations to one canonical form before comparing, so "Anikeet",
// "Anikat" and "Aniket" all normalise toward the same key.
const SPELLING_RULES = [
  [/aa/g, 'a'],
  [/ee/g, 'i'],
  [/oo/g, 'u'],
  [/w/g, 'v'],
  [/sh/g, 's'],
  [/th/g, 't'],
  [/kh/g, 'k'],
  [/gh/g, 'g'],
  [/ph/g, 'f'],
  [/(.)\1+/g, '$1'], // collapse doubled letters: "sachin" vs "sacchin"
];

function normalise(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (isDevanagari(s)) s = transliterateDevanagari(s);
  s = s.toLowerCase();
  s = s.replace(/[.\-_]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').filter((t) => t && !HONORIFICS.has(t));
  return tokens.join(' ');
}

// A second-pass key used only for fuzzy/phonetic comparison - spelling-rule
// collapsed, no spaces. Keep `normalise()`'s output for token/prefix matching
// (which needs word boundaries) and use this for edit-distance/phonetic.
function phoneticKey(normalised) {
  let s = normalised.replace(/\s+/g, '');
  for (const [pat, rep] of SPELLING_RULES) s = s.replace(pat, rep);
  return s;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - dist / maxLen;
}

/**
 * Score one candidate string against the user's query.
 * Returns a score in [0,1] plus the reason, so callers/tests can see why.
 */
const MIN_PREFIX_LEN = 3; // below this, a "prefix match" is too trivial to trust
                           // (a 1-2 char token like an email-alias fragment
                           // "s" must never let every S-name match "s...").
const MIN_FUZZY_TOKEN_LEN = 2; // tokens shorter than this never fuzzy-match

// Score a single query token against a single candidate token, in [0,1].
function tokenScore(qt, ct) {
  if (!qt || !ct) return 0;
  if (qt === ct) return 1;
  if (qt.length >= MIN_PREFIX_LEN && ct.length >= MIN_PREFIX_LEN &&
      (ct.startsWith(qt) || qt.startsWith(ct))) {
    return 0.9;
  }
  if (qt.length < MIN_FUZZY_TOKEN_LEN || ct.length < MIN_FUZZY_TOKEN_LEN) return 0;
  // Blend raw edit-distance similarity with the phonetic-collapsed version,
  // weighted toward raw: the phonetic collapse (sh->s, th->t, etc.) is meant
  // to catch a genuine phonetic respelling, but weighting it equally can let
  // two genuinely different surnames (e.g. "Varma" vs "Sharma") converge to
  // the same collapsed key and look like as good a match as the real typo
  // ("Varma" vs "Verma") would - raw similarity alone already tells those
  // apart correctly, so it must stay the dominant signal.
  const simPhon = similarity(phoneticKey(qt), phoneticKey(ct));
  const simRaw = similarity(qt, ct);
  return simRaw * 0.75 + simPhon * 0.25;
}

// Per-candidate-field score: align each query token to its best-matching
// candidate token (handles typo'd surname with exact first name, swapped
// word order, a first-name-only query, etc.), then average. A query token
// that matches nothing well in the candidate drags the average down hard,
// which is what correctly tells "Priya Sharma" apart from "Priya Verma"
// instead of a shared first token alone looking "basically as good".
function scoreCandidate(queryNorm, queryPhon, candidateRaw) {
  if (!queryNorm || queryNorm.length < 1) return { score: 0, reason: 'empty-query' };

  const candNorm = normalise(candidateRaw);
  if (!candNorm) return { score: 0, reason: 'empty' };

  if (candNorm === queryNorm) return { score: 1, reason: 'exact' };

  const candTokens = candNorm.split(' ');
  const queryTokens = queryNorm.split(' ');

  const perToken = queryTokens.map((qt) => {
    let best = 0;
    for (const ct of candTokens) {
      const s = tokenScore(qt, ct);
      if (s > best) best = s;
    }
    return best;
  });

  const avg = perToken.reduce((a, b) => a + b, 0) / perToken.length;
  const min = Math.min(...perToken);

  // A whole-string prefix also counts (e.g. a single short query like "Anik"
  // already goes through the token loop above and works fine, but this also
  // catches a query that's a prefix of the WHOLE candidate string run
  // together, which the per-token loop alone would not).
  let whole = 0;
  if (queryNorm.length >= MIN_PREFIX_LEN && candNorm.length >= MIN_PREFIX_LEN &&
      (candNorm.startsWith(queryNorm) || queryNorm.startsWith(candNorm))) {
    whole = 0.95;
  }

  // One query token with nothing good in the candidate (min far below the
  // average) means the overall match is weaker than the average alone
  // suggests - e.g. "priya" hits 1.0 but "sharma" vs "verma" hits ~0.3: the
  // low outlier should dominate, not get smoothed away by averaging.
  const combined = queryTokens.length > 1 ? Math.min(avg, (avg + min) / 2 + 0.15) : avg;

  const score = Math.max(combined, whole);
  const reason = whole > combined ? 'prefix' : (min >= 0.85 ? 'token-match' : (score >= 0.6 ? 'phonetic' : 'weak'));
  return { score, reason };
}

const CLEAR_WINNER_THRESHOLD = 0.75;
const CLEAR_GAP = 0.05; // winner must beat runner-up by at least this much
const CANDIDATE_FLOOR = 0.35; // below this, not worth showing at all
const MAX_SUGGESTIONS = 5;

/**
 * @param {string} query - raw user-typed text
 * @param {Array<object>} candidates - items already scoped to the caller's
 *   own tenant/permissions by the route that fetched them
 * @param {object} opts
 * @param {(c:object)=>string} opts.getPrimary - main field to match (e.g. name)
 * @param {(c:object)=>string[]} [opts.getAliases] - extra fields to also try
 *   (email prefix, employee code, nickname) - only used if present on the item
 * @param {(c:object)=>string} [opts.label] - human label for display/ask text
 * @returns {{ decision: 'single'|'ambiguous'|'none', top: object|null,
 *             candidates: Array<{item, score, reason}>, suggestions: Array }}
 */
function resolveEntity(query, candidates, opts) {
  const getPrimary = opts.getPrimary;
  const getAliases = opts.getAliases || (() => []);
  const label = opts.label || getPrimary;

  const queryNorm = normalise(query);
  const queryPhon = phoneticKey(queryNorm);

  // A query with nothing left after stripping honorifics/whitespace, or a
  // single character, is too thin to safely resolve to one person - treat
  // it the same as "nothing found" rather than risk a false single match.
  if (queryNorm.replace(/\s+/g, '').length < 2) {
    return { decision: 'none', top: null, candidates: [], suggestions: [] };
  }

  const scored = (candidates || []).map((item) => {
    const fields = [getPrimary(item), ...(getAliases(item) || [])].filter(Boolean);
    let best = { score: 0, reason: 'none' };
    for (const f of fields) {
      const r = scoreCandidate(queryNorm, queryPhon, f);
      if (r.score > best.score) best = r;
    }
    return { item, score: best.score, reason: best.reason };
  });

  scored.sort((a, b) => b.score - a.score);
  const viable = scored.filter((s) => s.score >= CANDIDATE_FLOOR);

  if (!viable.length) {
    return {
      decision: 'none',
      top: null,
      candidates: [],
      suggestions: scored.slice(0, 3).map((s) => label(s.item)),
    };
  }

  const winner = viable[0];
  const runnerUp = viable[1];
  const isClear =
    winner.score >= CLEAR_WINNER_THRESHOLD &&
    (!runnerUp || winner.score - runnerUp.score >= CLEAR_GAP);

  if (isClear) {
    return { decision: 'single', top: winner, candidates: viable.slice(0, MAX_SUGGESTIONS), suggestions: [] };
  }

  return {
    decision: 'ambiguous',
    top: null,
    candidates: viable.slice(0, MAX_SUGGESTIONS),
    suggestions: viable.slice(0, MAX_SUGGESTIONS).map((s) => label(s.item)),
  };
}

module.exports = { resolveEntity, normalise, phoneticKey, levenshtein, similarity, scoreCandidate };

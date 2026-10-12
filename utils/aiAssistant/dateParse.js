// Part 3 (AI-layer-v2): resolves an English/Hindi/Hinglish date phrase the user
// typed into a real calendar date (YYYY-MM-DD), in the COMPANY's own time zone
// (IST — the same zone attendance/leave already use via E.istDate elsewhere in
// this codebase), so "kal" said at 11pm IST still means the correct day.
//
// This never guesses silently: callers must show the resolved date back to the
// user on the confirmation card (the brief's explicit instruction), and if the
// phrase can't be resolved this returns { ok:false } so the tool layer can ask
// a clarifying question instead of sending a wrong date to a write route.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HINDI_WEEKDAYS = {
  'ravivar': 0, 'ravivaar': 0, 'raviwar': 0,
  'somvar': 1, 'somwar': 1,
  'mangalvar': 2, 'mangalwar': 2,
  'budhvar': 3, 'budhwar': 3,
  'guruvar': 4, 'guruwar': 4, 'brihaspativar': 4,
  'shukravar': 5, 'shukrawar': 5,
  'shanivar': 6, 'shaniwar': 6,
};

function istNow() {
  // IST = UTC+5:30, no DST.
  const now = Date.now();
  return new Date(now + 5.5 * 60 * 60 * 1000);
}
function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/**
 * Resolves a free-text date phrase to { ok:true, date:'YYYY-MM-DD', resolvedFrom:phrase }
 * or { ok:false, reason }.
 */
function resolveDatePhrase(phraseRaw) {
  const phrase = String(phraseRaw || '').trim().toLowerCase();
  if (!phrase) return { ok: false, reason: 'empty phrase' };

  // Already an ISO date.
  const isoMatch = phrase.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const d = new Date(`${phrase}T00:00:00.000Z`);
    if (isNaN(d.getTime())) return { ok: false, reason: 'invalid ISO date' };
    return { ok: true, date: phrase, resolvedFrom: phraseRaw };
  }

  const today = istNow();
  const todayIso = toIsoDate(today);

  // English / Hindi / Hinglish "today".
  if (/\b(today|aaj)\b/.test(phrase)) return { ok: true, date: todayIso, resolvedFrom: phraseRaw };

  // "tomorrow" / "kal" (kal is ambiguous in Hindi - yesterday OR tomorrow - but
  // in common Hinglish chat usage without other context it means tomorrow; we
  // resolve it that way and ALWAYS echo the resolved date back to the user so
  // a wrong guess is caught immediately rather than silently acted on).
  if (/\b(tomorrow|kal)\b/.test(phrase)) return { ok: true, date: toIsoDate(addDays(today, 1)), resolvedFrom: phraseRaw };

  // "day after tomorrow" / "parso" (also ambiguous two-days-away in Hindi).
  if (/\b(day after tomorrow|parso|parson)\b/.test(phrase)) return { ok: true, date: toIsoDate(addDays(today, 2)), resolvedFrom: phraseRaw };

  if (/\b(yesterday)\b/.test(phrase)) return { ok: true, date: toIsoDate(addDays(today, -1)), resolvedFrom: phraseRaw };

  // "next <weekday>" / "agle <hindi weekday>" / plain "<weekday>" (English or Hindi).
  const nextMatch = phrase.match(/\b(?:next|agl[ae])\s+([a-z]+)\b/);
  const bareWeekdayMatch = phrase.match(/\b([a-z]+)\b/g) || [];
  function weekdayIndex(word) {
    const idx = WEEKDAYS.indexOf(word);
    if (idx >= 0) return idx;
    if (Object.prototype.hasOwnProperty.call(HINDI_WEEKDAYS, word)) return HINDI_WEEKDAYS[word];
    return -1;
  }
  if (nextMatch) {
    const wi = weekdayIndex(nextMatch[1]);
    if (wi >= 0) {
      const todayWi = today.getUTCDay();
      let delta = (wi - todayWi + 7) % 7;
      if (delta === 0) delta = 7; // "next Monday" said on a Monday means the one after today
      return { ok: true, date: toIsoDate(addDays(today, delta)), resolvedFrom: phraseRaw };
    }
  }
  for (const w of bareWeekdayMatch) {
    const wi = weekdayIndex(w);
    if (wi >= 0) {
      const todayWi = today.getUTCDay();
      let delta = (wi - todayWi + 7) % 7; // nearest upcoming occurrence, today included
      return { ok: true, date: toIsoDate(addDays(today, delta)), resolvedFrom: phraseRaw };
    }
  }

  // "15th" / "15 nov" / "15 november" / "nov 15" - a day-of-month, optionally
  // with a month name; assumes the current (IST) month/year if no month given,
  // rolling to next month if that day has already passed this month.
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dayMonth = phrase.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/)
    || phrase.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})\b/);
  if (dayMonth) {
    let day, monIdx;
    if (/^\d/.test(dayMonth[1])) { day = Number(dayMonth[1]); monIdx = monthNames.indexOf(dayMonth[2]); }
    else { monIdx = monthNames.indexOf(dayMonth[1]); day = Number(dayMonth[2]); }
    if (monIdx >= 0 && day >= 1 && day <= 31) {
      let year = today.getUTCFullYear();
      let d = new Date(Date.UTC(year, monIdx, day));
      if (d.getTime() < new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).getTime() && monIdx < today.getUTCMonth()) {
        d = new Date(Date.UTC(year + 1, monIdx, day));
      }
      return { ok: true, date: toIsoDate(d), resolvedFrom: phraseRaw };
    }
  }
  const justDay = phrase.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (justDay) {
    const day = Number(justDay[1]);
    if (day >= 1 && day <= 31) {
      let year = today.getUTCFullYear(), month = today.getUTCMonth();
      let d = new Date(Date.UTC(year, month, day));
      if (d.getUTCDate() !== day) return { ok: false, reason: 'not a valid day in this month' };
      if (toIsoDate(d) < todayIso) d = new Date(Date.UTC(year, month + 1, day));
      return { ok: true, date: toIsoDate(d), resolvedFrom: phraseRaw };
    }
  }

  // "in N days" / "N din baad" / "N din mein"
  const inNDays = phrase.match(/\b(\d{1,3})\s*(?:days?|din)\b/);
  if (inNDays) return { ok: true, date: toIsoDate(addDays(today, Number(inNDays[1]))), resolvedFrom: phraseRaw };

  return { ok: false, reason: `could not resolve "${phraseRaw}" to a real calendar date — ask the user to confirm or give an exact date` };
}

module.exports = { resolveDatePhrase, istNow, toIsoDate };

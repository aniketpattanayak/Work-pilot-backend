// Phone + time helpers for the voice module.
const DEFAULT_CC = process.env.VOICE_DEFAULT_COUNTRY_CODE || '91';

/** '+91 98765-43210' | '098765 43210' | '9876543210' -> '+919876543210'. Returns '' if it can't be a phone number. */
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return '';
  let s = String(raw).trim();
  const hadPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return '';
  if (!hadPlus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = DEFAULT_CC + d.slice(1);
    else if (d.length === 10) d = DEFAULT_CC + d;
  }
  if (d.length < 11 || d.length > 15) return '';
  return '+' + d;
}

const IST_OFFSET_MIN = 330;
const toIst = (date) => new Date(new Date(date).getTime() + IST_OFFSET_MIN * 60000);
const fromIstParts = (y, mo, d, h = 0, mi = 0) => new Date(Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MIN * 60000);

/** "Saturday, 17 October 2026, 9:53 PM IST" - given to the agent so "tomorrow 4pm" can be turned into an exact time. */
function formatIst(date) {
  const d = toIst(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${String(m).padStart(2, '0')} ${ap} IST`;
}

// Calls are only placed between these IST hours (outbound + callbacks).
const CALL_START_HOUR = Number(process.env.VOICE_CALL_START_HOUR || 9);
const CALL_END_HOUR = Number(process.env.VOICE_CALL_END_HOUR || 19);

/** Moves a time that falls outside calling hours to 10:00 IST of the next allowed day (or later the same morning). */
function clampToCallingHours(date) {
  const ist = toIst(date);
  const h = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  if (h >= CALL_START_HOUR && h < CALL_END_HOUR) return new Date(date);
  const y = ist.getUTCFullYear(), mo = ist.getUTCMonth(), d = ist.getUTCDate();
  if (h < CALL_START_HOUR) return fromIstParts(y, mo, d, CALL_START_HOUR + 1, 0);
  return fromIstParts(y, mo, d + 1, CALL_START_HOUR + 1, 0);
}
const withinCallingHours = (date = new Date()) => clampToCallingHours(date).getTime() === new Date(date).getTime();

module.exports = { normalizePhone, formatIst, toIst, clampToCallingHours, withinCallingHours, CALL_START_HOUR, CALL_END_HOUR };

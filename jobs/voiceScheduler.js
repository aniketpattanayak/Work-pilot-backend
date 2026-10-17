// Voice scheduler. Does NOTHING unless VOICE_SCHEDULER_ENABLED=true, so deploying the module
// changes no behaviour until it is deliberately switched on.
//  - every minute: place follow-up callbacks whose time has come
//  - daily (VOICE_CHECKIN_CRON, default 11:00 Mon-Sat IST), only if VOICE_DAILY_CHECKIN_ENABLED=true:
//    check in with beta doers of enabled companies
const cron = require('node-cron');
const { runDueCallbacks, runDailyCheckins } = require('../utils/voice/callService');

function start() {
  if (process.env.VOICE_SCHEDULER_ENABLED !== 'true') return false;
  cron.schedule('* * * * *', async () => {
    try { const r = await runDueCallbacks(); if (r.length) console.log('[Voice] callbacks:', JSON.stringify(r)); }
    catch (e) { console.error('[Voice] callback tick failed:', e.message); }
  }, { timezone: 'Asia/Kolkata' });
  if (process.env.VOICE_DAILY_CHECKIN_ENABLED === 'true') {
    cron.schedule(process.env.VOICE_CHECKIN_CRON || '0 11 * * 1-6', async () => {
      try { const r = await runDailyCheckins(); console.log(`[Voice] daily check-ins: ${r.filter((x) => x.placed).length}/${r.length} placed`); }
      catch (e) { console.error('[Voice] daily check-in failed:', e.message); }
    }, { timezone: 'Asia/Kolkata' });
  }
  console.log('📞 Voice scheduler active.');
  return true;
}
module.exports = { start };

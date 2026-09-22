const sendWhatsAppMessage = require('./whatsappNotify');
const Tenant = require('../models/Tenant');

/**
 * notifyTenant(tenantId, toPhone, data)
 * Resolves the tenant's own WhatsApp credentials (whatever provider they've
 * configured — Maytapi, WATI, or a custom DoubleTick key) and sends through
 * THEM instead of the shared global account. Falls back to the shared
 * account automatically if the tenant hasn't configured their own, or if
 * tenantId is missing/invalid — same fallback sendWhatsAppMessage already had.
 */
async function notifyTenant(tenantId, toPhone, data) {
  let tenantKey = null;
  try {
    if (tenantId) {
      const tenant = await Tenant.findById(tenantId)
        .select('superAdmin.customWhatsappKey whatsappConfig.apiKey')
        .lean();
      tenantKey = tenant?.superAdmin?.customWhatsappKey || tenant?.whatsappConfig?.apiKey || null;
    }
  } catch (e) {
    console.error('[notifyTenant] Failed to resolve tenant WhatsApp key:', e.message);
  }
  return sendWhatsAppMessage(toPhone, data, tenantKey);
}

module.exports = { notifyTenant };

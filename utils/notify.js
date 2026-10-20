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
  let out = data;
  try {
    if (tenantId) {
      const tenant = await Tenant.findById(tenantId)
        .select('superAdmin.customWhatsappKey whatsappConfig.apiKey companySettings.whatsappTemplates')
        .lean();
      tenantKey = tenant?.superAdmin?.customWhatsappKey || tenant?.whatsappConfig?.apiKey || null;
      // Company overrides for this message (nothing saved = send exactly as before)
      const cfg = tenant?.companySettings?.whatsappTemplates?.[data && data.templateName];
      if (cfg) {
        if (cfg.enabled === false) return { skipped: true, reason: 'switched off by the company' };
        out = { ...data, originalTemplateName: data.templateName };
        if (cfg.providerTemplate) out.templateName = String(cfg.providerTemplate);
        if (cfg.body) out.customBody = String(cfg.body);
        if (cfg.senderPhoneId) out.senderPhoneId = String(cfg.senderPhoneId);
      }
    }
  } catch (e) {
    console.error('[notifyTenant] Failed to resolve tenant WhatsApp settings:', e.message);
  }
  return sendWhatsAppMessage(toPhone, out, tenantKey);
}

module.exports = { notifyTenant };

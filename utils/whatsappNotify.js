const axios = require('axios');

const GLOBAL_API_KEY = 'key_2dXrv0XqQHiTLGt0leBhwfC1UtlDPGlMUpWNNbE8WtbVLPCRcLwIoa3jM9Ouw8Fs0Ng3sfNp6ZKs8brNd11i7kFMOJ7usgywndWHLa3ry4zjK9UptpaUrdGRte5t4f8ntXfZiAcY0JoNueh03GHQZXdBHOCODzfEOxxF1aekmA7SLRmEsP8Hhw3UFpdwAe1j8DSamao3ZDv5LOlwxjrkoQCgnulhxUlTcsE7ucElwdkrhGdfVbCV7A76uJpI';

const cleanPhone = (phone) => {
  let p = String(phone).replace(/\D/g, '');
  if (p.length === 10) p = '91' + p;
  return p;
};

const sendViaDoubleTick = async (toPhone, data, apiKey) => {
  const phone = cleanPhone(toPhone);
  const templateName = data.templateName || 'api_otp_';
  const placeholders = Array.isArray(data.variables)
    ? data.variables.map(v => String(v ?? ''))
    : [String(data ?? '')];

  const payload = {
    messages: [{
      to: `+${phone}`,
      templateName,
      language: 'en',
      content: { templateName, language: 'en', templateData: { body: { placeholders } } }
    }]
  };

  try {
    const res = await axios.post('https://public.doubletick.io/whatsapp/message/template', payload,
      { headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' } });
    console.log(`✅ [DoubleTick] "${templateName}" → +${phone}`);
    return res.data;
  } catch {
    const fallback = {
      messages: [{
        to: `+${phone}`, templateName, language: 'en',
        components: [{ type: 'body', parameters: placeholders.map(text => ({ type: 'text', text })) }]
      }]
    };
    const res2 = await axios.post('https://public.doubletick.io/whatsapp/message/template', fallback,
      { headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' } });
    console.log(`✅ [DoubleTick] Fallback → +${phone}`);
    return res2.data;
  }
};

const sendViaMaytapi = async (toPhone, data, config) => {
  const phone = cleanPhone(toPhone);
  const { productId, token, phoneId } = config;
  const variables = Array.isArray(data.variables) ? data.variables : [];
  const message = variables.join('\n') || data.templateName || String(data);

  const res = await axios.post(
    `https://api.maytapi.com/api/${productId}/${phoneId}/sendMessage`,
    { to_number: `+${phone}`, type: 'text', message },
    { headers: { 'x-maytapi-key': token, 'Content-Type': 'application/json' } }
  );
  console.log(`✅ [Maytapi] Message → +${phone}`);
  return res.data;
};

const sendViaWati = async (toPhone, data, config) => {
  const phone = cleanPhone(toPhone);
  const { apiEndpoint, apiKey } = config;
  const templateName = data.templateName || 'api_otp_';
  const parameters = Array.isArray(data.variables)
    ? data.variables.map((v, i) => ({ name: String(i + 1), value: String(v ?? '') }))
    : [];

  const res = await axios.post(
    `${apiEndpoint}/api/v1/sendTemplateMessage?whatsappNumber=${phone}`,
    { template_name: templateName, broadcast_name: templateName, parameters },
    { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
  console.log(`✅ [WATI] "${templateName}" → +${phone}`);
  return res.data;
};

const sendWhatsAppMessage = async (toPhone, data, tenantApiKey = null) => {
  if (!toPhone || toPhone === '+' || toPhone === 'null' || toPhone === 'undefined') {
    console.warn('⚠️ Skipping: No valid phone.');
    return;
  }

  if (tenantApiKey) {
    try {
      const config = JSON.parse(tenantApiKey);
      if (config.provider === 'maytapi') return await sendViaMaytapi(toPhone, data, config);
      if (config.provider === 'wati') return await sendViaWati(toPhone, data, config);
      if (config.provider === 'doubletick') return await sendViaDoubleTick(toPhone, data, config.apiKey);
    } catch {
      // Not JSON — treat as raw DoubleTick key
      return await sendViaDoubleTick(toPhone, data, tenantApiKey);
    }
  }

  return await sendViaDoubleTick(toPhone, data, GLOBAL_API_KEY);
};

module.exports = sendWhatsAppMessage;

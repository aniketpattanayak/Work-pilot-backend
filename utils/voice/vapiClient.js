// Thin client for the telephony / voice-agent provider (Vapi, which drives Twilio numbers).
// Isolated behind setClient() so tests never touch the network.
const axios = require('axios');

const VAPI_BASE = process.env.VAPI_BASE_URL || 'https://api.vapi.ai';

let override = null;
const setClient = (fake) => { override = fake; };

async function createCall({ assistant, customerNumber, metadata }) {
  if (override) return override.createCall({ assistant, customerNumber, metadata });
  const key = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID; // the Twilio number imported into Vapi
  if (!key || !phoneNumberId) {
    const e = new Error('Voice provider is not configured (VAPI_API_KEY / VAPI_PHONE_NUMBER_ID).');
    e.code = 'VOICE_NOT_CONFIGURED';
    throw e;
  }
  const res = await axios.post(`${VAPI_BASE}/call`, {
    phoneNumberId,
    customer: { number: customerNumber },
    assistant,
    metadata,
  }, { headers: { Authorization: `Bearer ${key}` }, timeout: 15000 });
  return { id: res.data?.id, status: res.data?.status };
}

module.exports = { createCall, setClient };

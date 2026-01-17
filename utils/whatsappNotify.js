const axios = require('axios');
const sendWhatsAppMessage = async (toPhone, message) => {
  if (!toPhone) {
    console.error("WhatsApp Error: No recipient node identified.");
    return;
  }

  // Clean the phone number (ensure no + or spaces)
  const cleanedPhone = toPhone.replace(/\D/g, '');

  const url = `https://api.maytapi.com/api/${process.env.MAYTAPI_PRODUCT_ID}/${process.env.MAYTAPI_INSTANCE_ID}/sendMessage`;

  const config = {
    headers: {
      'Content-Type': 'application/json',
      'x-maytapi-key': process.env.MAYTAPI_TOKEN,
    },
  };

  const body = {
    to_number: cleanedPhone,
    type: 'text',
    message: message,
  };

  try {
    const response = await axios.post(url, body, config);
    console.log(`WhatsApp Handshake: Message dispatched to ${cleanedPhone}`);
    return response.data;
  } catch (error) {
    console.error("WhatsApp Protocol Failure:", error.response?.data || error.message);
  }
};

module.exports = sendWhatsAppMessage;
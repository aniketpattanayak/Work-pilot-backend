const axios = require('axios');

/**
 * LRBC MASTER TEMPLATE HANDLER v3.5 (DoubleTick Optimized)
 * Purpose: Dynamically handles all operational templates (Briefings, Tasks, Onboarding).
 * Compatible with mappings {{1}} through {{6}}.
 */
const sendWhatsAppMessage = async (toPhone, data) => {
  // 1. Phone Validation & Formatting
  // Returns early if phone is missing or invalid to prevent API 400 errors.
  if (!toPhone || toPhone === "+" || toPhone === "null" || toPhone === "undefined") {
    console.warn("⚠️ [LRBC Notify] Skipping: No valid destination phone provided.");
    return;
  }

  const apiKey = 'key_2dXrv0XqQHiTLGt0leBhwfC1UtlDPGlMUpWNNbE8WtbVLPCRcLwIoa3jM9Ouw8Fs0Ng3sfNp6ZKs8brNd11i7kFMOJ7usgywndWHLa3ry4zjK9UptpaUrdGRte5t4f8ntXfZiAcY0JoNueh03GHQZXdBHOCODzfEOxxF1aekmA7SLRmEsP8Hhw3UFpdwAe1j8DSamao3ZDv5LOlwxjrkoQCgnulhxUlTcsE7ucElwdkrhGdfVbCV7A76uJpI';
  
  // Clean non-numeric characters and ensure '91' prefix for Indian numbers
  let cleanedPhone = String(toPhone).replace(/\D/g, '');
  if (cleanedPhone.length === 10) cleanedPhone = '91' + cleanedPhone;

  // 2. Dynamic Template & Variable Extraction
  // Extract templateName and variables from the data object passed by controllers.
  const templateName = data.templateName || "api_otp_"; 
  
  // CRITICAL: Ensure all variables are Strings. Numbers or Nulls cause API rejection.
  const placeholders = Array.isArray(data.variables) 
    ? data.variables.map(v => String(v ?? "")) 
    : [String(data ?? "")];

  /**
   * 3. DYNAMIC DOUBLETICK PAYLOAD
   * Matches the DoubleTick 'v1/templates' API structure for body placeholders.
   */
  const payload = {
    messages: [
      {
        to: `+${cleanedPhone}`,
        templateName: templateName, 
        language: "en",
        content: {
          templateName: templateName,
          language: "en",
          templateData: {
            body: {
              placeholders: placeholders // Successfully maps {{1}} to {{6}}
            }
          }
        }
      }
    ]
  };

  try {
    const response = await axios.post(
      'https://public.doubletick.io/whatsapp/message/template', 
      payload, 
      {
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ [LRBC Sync] Template "${templateName}" sent to +${cleanedPhone}`);
    return response.data;
  } catch (error) {
    /**
     * 4. UNIVERSAL FALLBACK (DoubleTick Components Protocol)
     * Secondary structure used if the primary 'content' block is rejected.
     */
    const universalPayload = {
      messages: [
        {
          to: `+${cleanedPhone}`,
          templateName: templateName,
          language: "en",
          components: [
            {
              type: "body",
              parameters: placeholders.map(text => ({ type: "text", text }))
            }
          ]
        }
      ]
    };

    try {
      const finalRetry = await axios.post(
        'https://public.doubletick.io/whatsapp/message/template',
        universalPayload,
        { headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' } }
      );
      console.log(`✅ [LRBC Sync] Success via Fallback: +${cleanedPhone}`);
      return finalRetry.data;
    } catch (retryError) {
      // Final catch block logs the specific error reason (e.g., Template Not Found)
      console.error("❌ LRBC Protocol Critical Failure:", JSON.stringify(retryError.response?.data, null, 2));
    }
  }
};

module.exports = sendWhatsAppMessage;
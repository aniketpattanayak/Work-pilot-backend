// One small module behind which the model provider lives, per the brief:
// "model provider behind one small server module, Anthropic API with tool use
// as default ... key read from server env, never client-visible, graceful
// degradation if AI service down/slow".
//
// FAKE_MODEL injection: when global.__AI_ASSISTANT_FAKE_MODEL__ is set (only ever
// done by test scripts, never by request input), that function is used instead of
// a real Anthropic call. This is the ONLY way a fake model can be used - there is
// no request parameter that selects it, so a real end user can never trigger fake
// responses.
//
// Model string is read from env so it can be bumped without a code change;
// anthropic-ai/sdk's Messages API with `tools` is the documented way to do
// server-side tool use (verified against the current SDK docs during this
// session, not from training-time memory).
const MODEL = process.env.AI_ASSISTANT_MODEL || 'claude-sonnet-4-5';

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { /* optional dep */ }

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * @param {object} opts
 * @param {string} opts.system - system prompt
 * @param {Array}  opts.messages - Anthropic-format message list
 * @param {Array}  opts.tools - Anthropic tool_use-format tool definitions
 * @returns {Promise<{stopReason, content, text, toolUse}>}
 */
async function callModel({ system, messages, tools }) {
  if (global.__AI_ASSISTANT_FAKE_MODEL__) {
    return global.__AI_ASSISTANT_FAKE_MODEL__({ system, messages, tools });
  }

  if (!isConfigured() || !Anthropic) {
    return {
      degraded: true,
      text: "The AI assistant isn't available right now (no model configured on the server). Please use the regular screens for this.",
    };
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20000 });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages,
      tools,
    });
    const toolUseBlock = (resp.content || []).find((b) => b.type === 'tool_use');
    const textBlock = (resp.content || []).find((b) => b.type === 'text');
    return {
      stopReason: resp.stop_reason,
      content: resp.content,
      text: textBlock ? textBlock.text : '',
      toolUse: toolUseBlock ? { name: toolUseBlock.name, input: toolUseBlock.input, id: toolUseBlock.id } : null,
    };
  } catch (err) {
    console.error('[AIAssistant] model call failed:', err.message);
    return {
      degraded: true,
      text: "The AI assistant is having trouble right now. Please try again shortly, or use the regular screens.",
    };
  }
}

module.exports = { callModel, isConfigured, MODEL };

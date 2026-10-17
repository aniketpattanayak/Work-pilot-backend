// Builds the transient voice-agent definition handed to the provider for each call.
// Provider / model / voice are env-configurable so tuning never needs a deploy.
const prompts = require('./prompts');
const { TOOL_SCHEMAS } = require('./voiceTools');
const { formatIst } = require('./phone');

const webhookUrl = () => process.env.VOICE_WEBHOOK_URL || `${(process.env.SERVER_URL || '').replace(/\/$/, '')}/api/voice/webhook`;

function toolDefs(names) {
  return names.map((n) => ({
    type: 'function',
    function: { name: n, description: TOOL_SCHEMAS[n].description, parameters: TOOL_SCHEMAS[n].parameters },
    server: { url: webhookUrl(), secret: process.env.VOICE_WEBHOOK_SECRET },
  }));
}

function baseAssistant({ name, systemPrompt, firstMessage, tools }) {
  const a = {
    name,
    firstMessage,
    model: {
      provider: process.env.VOICE_LLM_PROVIDER || 'openai',
      model: process.env.VOICE_LLM_MODEL || 'gpt-4o',
      temperature: 0.7,
      messages: [{ role: 'system', content: systemPrompt }],
      tools: toolDefs(tools),
    },
    transcriber: { provider: process.env.VOICE_STT_PROVIDER || 'deepgram', model: process.env.VOICE_STT_MODEL || 'nova-2', language: process.env.VOICE_STT_LANGUAGE || 'en-IN' },
    // Human-feel settings: wait a beat before answering, let the person interrupt, soft "mm-hmm" backchannels.
    backchannelingEnabled: true,
    startSpeakingPlan: { waitSeconds: 0.5, smartEndpointingEnabled: true },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2 },
    backgroundDenoisingEnabled: true,
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    endCallFunctionEnabled: true,
    recordingEnabled: true,
    serverMessages: ['status-update', 'tool-calls', 'end-of-call-report'],
    server: { url: webhookUrl(), secret: process.env.VOICE_WEBHOOK_SECRET },
  };
  if (process.env.VOICE_TTS_VOICE_ID) a.voice = { provider: process.env.VOICE_TTS_PROVIDER || '11labs', voiceId: process.env.VOICE_TTS_VOICE_ID };
  return a;
}

function doerCheckinAssistant({ employee, tasks, extraCount, isCallback, previousBlocker }) {
  const nowIst = formatIst(new Date());
  return baseAssistant({
    name: 'WorkPilot check-in',
    systemPrompt: prompts.doerCheckinPrompt({ employee, tasks, nowIst, extraCount, isCallback, previousBlocker }),
    firstMessage: prompts.firstMessageForDoer(employee, tasks[0].title, isCallback),
    tools: ['complete_task', 'log_blocker'],
  });
}

function inboundAssistant({ employee, roles, tools }) {
  return baseAssistant({
    name: 'WorkPilot assistant',
    systemPrompt: prompts.inboundPrompt({ employee, roles, nowIst: formatIst(new Date()) }),
    firstMessage: prompts.firstMessageForInbound(employee),
    tools,
  });
}

module.exports = { doerCheckinAssistant, inboundAssistant, webhookUrl };

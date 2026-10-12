// Executes a single tool call by firing a real HTTP request at this same
// backend, using the end user's OWN JWT. This is the mechanism that makes the
// "cannot exceed normal UI permissions" guarantee true by construction rather
// than by a separate copy of the permission logic that could drift out of sync.
const { getToolByName, FORBIDDEN_ACTIONS } = require('./tools');

const SELF_BASE = process.env.AI_ASSISTANT_SELF_BASE || `http://localhost:${process.env.PORT || 5099}`;

async function executeTool(toolName, args, userToken, currentUser) {
  if (FORBIDDEN_ACTIONS[toolName]) {
    return {
      blocked: true,
      message: `I can't do that by chat or voice — approve/release/money actions always need you to confirm it on-screen. Open: ${FORBIDDEN_ACTIONS[toolName]}`,
    };
  }
  const tool = getToolByName(toolName);
  if (!tool) {
    return { blocked: true, message: `Unknown action "${toolName}" — refusing to call anything not on the fixed tool list.` };
  }

  const path = tool.path(currentUser || {}, args);
  const method = tool.method;
  const headers = { Authorization: `Bearer ${userToken}` };
  const outArgs = { ...(args || {}), ...(tool.autoFields ? tool.autoFields(currentUser || {}) : {}) };
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(outArgs);
  }

  const res = await fetch(SELF_BASE + path, { method, headers, body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

module.exports = { executeTool };

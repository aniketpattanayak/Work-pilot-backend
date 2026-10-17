// Runs one of the EXISTING task controllers (respondToTask, createTask) exactly as the web app
// would - same validation, points engine, history entries and WhatsApp notices - by handing it a
// minimal request/response pair. Voice therefore never re-implements task rules.
async function invokeController(handler, { user, body, db }) {
  const req = { user, body, db: db || null, params: {}, query: {}, headers: {}, files: undefined, file: undefined, app: { get: () => null } };
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      status(c) { status = c; return this; },
      json(payload) { resolve({ status, body: payload }); return this; },
      send(payload) { resolve({ status, body: payload }); return this; },
    };
    Promise.resolve(handler(req, res)).catch((err) => resolve({ status: 500, body: { message: err.message } }));
  });
}
module.exports = { invokeController };

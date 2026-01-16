const https = require("https");
const { URL } = require("url");

function postJson(targetUrl, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);

    const payload = JSON.stringify(body);
    const options = {
      method: "POST",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const r = https.request(options, (resp) => {
      let out = "";
      resp.on("data", (c) => (out += c));
      resp.on("end", () => resolve({ status: resp.statusCode || 200, body: out }));
    });

    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

module.exports = async function (context, req) {
  const logicAppUrl = process.env.LOGICAPP_CALLBACK_URL;

  // ✅ Azure Functions already parsed the body
  const body = req.body;

  if (!body) {
    context.res = { status: 400, body: { error: "Empty body" } };
    return;
  }

  const first = Array.isArray(body) ? body[0] : body;

  // ✅ Event Grid validation handled HERE
  if (first?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
    context.res = {
      status: 200,
      body: { validationResponse: first.data?.validationCode }
    };
    return;
  }

  // Forward normal events to Logic App
  if (!logicAppUrl) {
    context.res = { status: 500, body: { error: "LOGICAPP_CALLBACK_URL not configured" } };
    return;
  }

  try {
    await postJson(logicAppUrl, body);
    context.res = { status: 200, body: { ok: true } };
  } catch (e) {
    context.res = {
      status: 502,
      body: { error: "Forwarding failed", details: String(e) }
    };
  }
};

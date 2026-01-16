const https = require("https");
const { URL } = require("url");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

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

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    context.res = { status: 400, body: { error: "Invalid JSON" } };
    return;
  }

  // Handle Event Grid validation locally (most reliable)
  const first = Array.isArray(body) ? body[0] : body;
  if (first && first.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
    const code = first?.data?.validationCode;
    context.res = { status: 200, body: { validationResponse: code } };
    return;
  }

  // Forward everything else to Logic App (with sig)
  if (!logicAppUrl) {
    context.res = { status: 500, body: { error: "LOGICAPP_CALLBACK_URL not configured" } };
    return;
  }

  try {
    await postJson(logicAppUrl, body);
    context.res = { status: 200, body: { ok: true } };
  } catch (e) {
    context.res = { status: 502, body: { error: "Forwarding failed", details: String(e) } };
  }
};

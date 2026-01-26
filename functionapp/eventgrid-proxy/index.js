const https = require("https");
const { URL } = require("url");

function redactSig(url) {
  if (!url) return url;
  // Remove/obfuscate sig query parameter to avoid leaking secrets in logs
  return url.replace(/([?&]sig=)[^&]+/i, "$1REDACTED");
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

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: data
        });
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async function (context, req) {
  const logicAppUrl = process.env.LOGICAPP_CALLBACK_URL;

  // Always log URL safely (never leak sig)
  if (!logicAppUrl) {
    context.log("LOGICAPP_CALLBACK_URL is NOT set");
  } else {
    context.log(`Calling Logic App URL: ${redactSig(logicAppUrl)}`);
  }

  const body = req.body;

  if (!body) {
    context.log("Request received with empty body");
    context.res = {
      status: 400,
      body: { error: "Empty body" }
    };
    return;
  }

  // Log payload (can be large; keep it as one string for consistent AI traces)
  // If you want to reduce noise later, log only first event id/type.
  context.log(`EventGrid payload: ${JSON.stringify(body)}`);

  const first = Array.isArray(body) ? body[0] : body;

  // Event Grid subscription validation
  if (first?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
    const code = first?.data?.validationCode || "";
    context.log(`Handling SubscriptionValidationEvent. code=${code}`);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { validationResponse: code }
    };
    return;
  }

  if (!logicAppUrl) {
    context.res = {
      status: 500,
      body: { error: "LOGICAPP_CALLBACK_URL not configured" }
    };
    return;
  }

  try {
    const resp = await postJson(logicAppUrl, body);

    // IMPORTANT: single-string log so KQL "message contains" works reliably
    context.log(`Forwarded to Logic App. Status: ${resp.status}`);

    if (resp.body) {
      // Keep as one string too
      context.log(`Logic App response body: ${resp.body}`);
    }

    context.res = {
      status: 200,
      body: {
        ok: true,
        forwardedStatus: resp.status
      }
    };
  } catch (err) {
    // Single-string log for query reliability
    context.log(`Error forwarding to Logic App: ${String(err && err.stack ? err.stack : err)}`);

    context.res = {
      status: 502,
      body: {
        error: "Forwarding failed",
        details: String(err)
      }
    };
  }
};


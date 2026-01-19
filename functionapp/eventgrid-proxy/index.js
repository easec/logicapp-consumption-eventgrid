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
  // 🔑 Logic App callback URL (must include sig)
  const logicAppUrl = process.env.LOGICAPP_CALLBACK_URL;

  if (!logicAppUrl) {
    context.log("LOGICAPP_CALLBACK_URL is NOT set");
  } else {
    // Safe log (do not leak sig)
    context.log(
      "Calling Logic App URL:",
      logicAppUrl.replace(/sig=.*/, "sig=REDACTED")
    );
  }

  // Azure Functions already parses JSON body
  const body = req.body;

  if (!body) {
    context.log("Request received with empty body");
    context.res = {
      status: 400,
      body: { error: "Empty body" }
    };
    return;
  }

  // 🔍 Log incoming Event Grid payload
  context.log("EventGrid payload:", JSON.stringify(body));

  const first = Array.isArray(body) ? body[0] : body;

  // ✅ Handle Event Grid subscription validation
  if (first?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
    context.log("Handling SubscriptionValidationEvent");

    context.res = {
      status: 200,
      body: {
        validationResponse: first.data?.validationCode
      }
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
    // 🔁 Forward to Logic App
    const resp = await postJson(logicAppUrl, body);

    context.log("Forwarded to Logic App. Status:", resp.status);
    if (resp.body) {
      context.log("Logic App response body:", resp.body);
    }

    context.res = {
      status: 200,
      body: {
        ok: true,
        forwardedStatus: resp.status
      }
    };
  } catch (err) {
    context.log("Error forwarding to Logic App:", err);

    context.res = {
      status: 502,
      body: {
        error: "Forwarding failed",
        details: String(err)
      }
    };
  }
};

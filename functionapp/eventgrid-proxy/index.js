const https = require("https");
const { URL } = require("url");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactSig(url) {
  if (!url) return url;
  return url.replace(/([?&]sig=)[^&]+/i, "$1REDACTED");
}

function isRetryableStatus(status) {
  // Retry on transient/server errors + throttling/timeouts
  // (Avoid retrying 4xx like 400/401/403/404 which are usually permanent)
  return (
    status === 408 || // Request Timeout
    status === 429 || // Too Many Requests
    (status >= 500 && status <= 599)
  );
}

function postJsonOnce(targetUrl, body) {
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

/**
 * Retry policy:
 * - Attempts: 4 total (1 + 3 retries)
 * - Backoff: exponential with jitter
 * - Retry on: 408, 429, 5xx, and network errors
 *
 * Tunables via env:
 *   FORWARD_MAX_ATTEMPTS (default 4)
 *   FORWARD_BASE_DELAY_MS (default 500)
 *   FORWARD_MAX_DELAY_MS (default 8000)
 */
async function postJsonWithRetry(context, targetUrl, body) {
  const maxAttempts = parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10);
  const baseDelayMs = parseInt(process.env.FORWARD_BASE_DELAY_MS || "500", 10);
  const maxDelayMs = parseInt(process.env.FORWARD_MAX_DELAY_MS || "8000", 10);

  let last = { status: 0, body: "" };
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await postJsonOnce(targetUrl, body);
      last = resp;

      if (resp.status >= 200 && resp.status < 300) {
        return { ...resp, attempts: attempt };
      }

      // Non-2xx
      if (!isRetryableStatus(resp.status) || attempt === maxAttempts) {
        return { ...resp, attempts: attempt };
      }

      // Exponential backoff with jitter
      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, exp));
      const delay = Math.min(maxDelayMs, exp + jitter);

      context.log(
        `Forward attempt ${attempt} got ${resp.status}. Retrying in ${delay}ms...`
      );
      await sleep(delay);
    } catch (err) {
      lastErr = err;

      if (attempt === maxAttempts) {
        break;
      }

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, exp));
      const delay = Math.min(maxDelayMs, exp + jitter);

      context.log(
        `Forward attempt ${attempt} failed (network). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  // If we get here, we exhausted retries due to network errors
  throw lastErr || new Error(`Forwarding failed after ${maxAttempts} attempts`);
}

module.exports = async function (context, req) {
  const logicAppUrl = process.env.LOGICAPP_CALLBACK_URL;

  if (!logicAppUrl) {
    context.log("LOGICAPP_CALLBACK_URL is NOT set");
  } else {
    context.log(`Calling Logic App URL: ${redactSig(logicAppUrl)}`);
  }

  const body = req.body;

  if (!body) {
    context.log("Request received with empty body");
    context.res = { status: 400, body: { error: "Empty body" } };
    return;
  }

  context.log(`EventGrid payload: ${JSON.stringify(body)}`);

  const first = Array.isArray(body) ? body[0] : body;

  // Event Grid subscription validation handshake
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
    context.res = { status: 500, body: { error: "LOGICAPP_CALLBACK_URL not configured" } };
    return;
  }

  try {
    const resp = await postJsonWithRetry(context, logicAppUrl, body);

    context.log(
      `Forwarded to Logic App. Status: ${resp.status}. Attempts: ${resp.attempts}`
    );

    if (resp.body) {
      // keep short to avoid huge logs
      const trimmed = resp.body.length > 2000 ? resp.body.slice(0, 2000) + "...(truncated)" : resp.body;
      context.log(`Logic App response body: ${trimmed}`);
    }

    // IMPORTANT: return 200 to Event Grid so it doesn't keep retrying on us
    // (we're handling retries ourselves)

    const success = resp.status >= 200 && resp.status < 300;
    
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ok: success,
        forwardedStatus: resp.status,
        attempts: resp.attempts
      }
    };

    
  } catch (err) {
    context.log(`Error forwarding to Logic App after retries: ${String(err && err.stack ? err.stack : err)}`);

    // Still return 200 to Event Grid to avoid duplicate floods if Logic App is down.
    // If you *want* Event Grid to retry delivery instead, change this to status: 502.
    context.res = {
      status: 200,
      body: {
        ok: false,
        forwardedStatus: 0,
        attempts: parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10),
        error: "Forwarding failed after retries",
        details: String(err)
      }
    };
  }
};



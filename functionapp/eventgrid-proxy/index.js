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
  // Avoid retrying most 4xx (usually permanent)
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function trimText(s, max = 2000) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
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
 * - Attempts: default 4 total (1 + 3 retries)
 * - Backoff: exponential + jitter
 * - Retry on: 408, 429, 5xx, and network errors
 *
 * Env:
 *   FORWARD_MAX_ATTEMPTS (default 4)
 *   FORWARD_BASE_DELAY_MS (default 500)
 *   FORWARD_MAX_DELAY_MS (default 8000)
 */
async function postJsonWithRetry(context, targetUrl, body) {
  const maxAttempts = parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10);
  const baseDelayMs = parseInt(process.env.FORWARD_BASE_DELAY_MS || "500", 10);
  const maxDelayMs = parseInt(process.env.FORWARD_MAX_DELAY_MS || "8000", 10);

  let lastResp = { status: 0, body: "" };
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await postJsonOnce(targetUrl, body);
      lastResp = resp;

      const success = resp.status >= 200 && resp.status < 300;
      if (success) {
        return { ...resp, attempts: attempt };
      }

      // Log non-2xx body (trimmed) for troubleshooting
      context.log(
        `Non-2xx from Logic App. Attempt ${attempt}. Status=${resp.status}. Body=${trimText(
          resp.body,
          500
        )}`
      );

      // Stop if not retryable or we're out of attempts
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

      if (attempt === maxAttempts) break;

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, exp));
      const delay = Math.min(maxDelayMs, exp + jitter);

      context.log(
        `Forward attempt ${attempt} failed (network): ${String(
          err && err.message ? err.message : err
        )}. Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  // Exhausted due to network errors
  const maxAttemptsUsed = parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10);
  const e =
    lastErr ||
    new Error(`Forwarding failed after ${maxAttemptsUsed} attempts (network).`);
  // Attach last response for callers if needed
  e.lastResponse = lastResp;
  throw e;
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
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: { error: "Empty body" }
    };
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
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "LOGICAPP_CALLBACK_URL not configured" }
    };
    return;
  }

  try {
    const resp = await postJsonWithRetry(context, logicAppUrl, body);

    const success = resp.status >= 200 && resp.status < 300;

    context.log(
      `Forwarded to Logic App. Status: ${resp.status}. Attempts: ${resp.attempts}`
    );

    if (resp.body) {
      context.log(`Logic App response body: ${trimText(resp.body, 2000)}`);
    }

    // Return 200 to Event Grid (avoid duplicate floods; we do our own retries)
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ok: success,
        forwardedStatus: resp.status,
        attempts: resp.attempts,
        forwardedBody: trimText(resp.body, 500) // useful in pipeline output
      }
    };
  } catch (err) {
    const attempts = parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10);
    const lastResp = err && err.lastResponse ? err.lastResponse : null;

    context.log(
      `Error forwarding to Logic App after retries: ${String(
        err && err.stack ? err.stack : err
      )}`
    );

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ok: false,
        forwardedStatus: lastResp ? lastResp.status : 0,
        attempts,
        error: "Forwarding failed after retries",
        details: String(err && err.message ? err.message : err),
        forwardedBody: lastResp ? trimText(lastResp.body, 500) : ""
      }
    };
  }
};

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
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
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
 * - Attempts: env FORWARD_MAX_ATTEMPTS (default 4)
 * - Backoff: exponential + jitter
 * - Retry on: 408, 429, 5xx, and network errors
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

      if (!isRetryableStatus(resp.status) || attempt === maxAttempts) {
        return { ...resp, attempts: attempt };
      }

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
        `Forward attempt ${attempt} failed (network). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastErr || new Error(`Forwarding failed after ${maxAttempts} attempts`);
}

/**
 * Strategy A:
 * - Prefer NEXT if set (canary)
 * - Otherwise use ACTIVE
 * - Optional: fallback from NEXT → ACTIVE if NEXT fails with retryable errors
 */
function selectCallbackUrls() {
  const next = process.env.LOGICAPP_CALLBACK_URL_NEXT || "";
  const active = process.env.LOGICAPP_CALLBACK_URL_ACTIVE || "";

  // Candidate order: NEXT first (if present), then ACTIVE
  const urls = [];
  if (next && next !== "null") urls.push({ label: "NEXT", url: next });
  if (active && active !== "null") urls.push({ label: "ACTIVE", url: active });

  return urls;
}

module.exports = async function (context, req) {
  // Azure Functions parses JSON body
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

  const candidates = selectCallbackUrls();

  if (candidates.length === 0) {
    context.log("No callback URL configured. Need LOGICAPP_CALLBACK_URL_ACTIVE (and optional _NEXT).");
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "No Logic App callback URL configured" }
    };
    return;
  }

  // Log redacted config
  context.log(
    "Callback candidates:",
    candidates.map((c) => `${c.label}=${redactSig(c.url)}`).join(" | ")
  );

  // Controls whether we ever fallback from NEXT → ACTIVE on non-2xx
  const allowFallback = String(process.env.FORWARD_ALLOW_FALLBACK || "true").toLowerCase() === "true";

  let lastResp = null;
  let chosen = null;
  let errorDetails = "";

  for (let i = 0; i < candidates.length; i++) {
    const { label, url } = candidates[i];
    chosen = label;

    try {
      const resp = await postJsonWithRetry(context, url, body);
      lastResp = resp;

      const success = resp.status >= 200 && resp.status < 300;

      context.log(`Forwarded to Logic App (${label}). Status: ${resp.status}. Attempts: ${resp.attempts}`);

      // Optionally include forwarded body for debugging (guarded)
      const includeBody = String(process.env.RETURN_FORWARDED_BODY || "false").toLowerCase() === "true";
      const forwardedBody = includeBody
        ? (resp.body && resp.body.length > 4000 ? resp.body.slice(0, 4000) + "...(truncated)" : (resp.body || ""))
        : undefined;

      // If success OR if fallback is disabled OR this was ACTIVE already, return result
      if (success || !allowFallback || label === "ACTIVE") {
        context.res = {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            ok: success,
            forwardedStatus: resp.status,
            attempts: resp.attempts,
            usedCallback: label,
            ...(includeBody ? { forwardedBody } : {})
          }
        };
        return;
      }

      // Non-2xx from NEXT: allow fallback to ACTIVE (next candidate)
      context.log(`Non-2xx from ${label}. Will try fallback if available. Status=${resp.status}`);

    } catch (err) {
      errorDetails = String(err && err.stack ? err.stack : err);
      context.log(`Error forwarding to Logic App (${label}): ${errorDetails}`);

      if (!allowFallback || label === "ACTIVE") {
        context.res = {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            ok: false,
            forwardedStatus: 0,
            attempts: parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10),
            usedCallback: label,
            error: "Forwarding failed after retries",
            details: errorDetails
          }
        };
        return;
      }
      // Else try next candidate (ACTIVE)
    }
  }

  // If we get here, NEXT failed and ACTIVE either missing or also failed without returning
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: {
      ok: false,
      forwardedStatus: lastResp ? lastResp.status : 0,
      attempts: lastResp ? lastResp.attempts : parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10),
      usedCallback: chosen || "NONE",
      error: "Forwarding failed (all candidates exhausted)",
      details: errorDetails
    }
  };
};




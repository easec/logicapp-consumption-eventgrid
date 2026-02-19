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
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

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

      if (resp.status >= 200 && resp.status < 300) return { ...resp, attempts: attempt };

      if (!isRetryableStatus(resp.status) || attempt === maxAttempts) {
        return { ...resp, attempts: attempt };
      }

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, exp));
      const delay = Math.min(maxDelayMs, exp + jitter);

      context.log(`Forward attempt ${attempt} got ${resp.status}. Retrying in ${delay}ms...`);
      await sleep(delay);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, exp));
      const delay = Math.min(maxDelayMs, exp + jitter);

      context.log(`Forward attempt ${attempt} failed (network). Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastErr || new Error("Forwarding failed after retries");
}

function selectCallbackUrls() {
  const next = process.env.LOGICAPP_CALLBACK_URL_NEXT || "";
  const active = process.env.LOGICAPP_CALLBACK_URL_ACTIVE || "";

  const urls = [];
  if (next && next !== "null") urls.push({ label: "NEXT", url: next });
  if (active && active !== "null") urls.push({ label: "ACTIVE", url: active });
  return urls;
}

function safeJsonParse(x) {
  try {
    return { ok: true, value: JSON.parse(x) };
  } catch {
    return { ok: false, value: null };
  }
}

module.exports = async function (context, req) {
  // HARD GUARANTEE: never let an exception escape => Event Grid would see 500
  try {
    // Accept both already-parsed JSON and raw strings
    let body = req.body;

    if (!body && typeof req.rawBody === "string" && req.rawBody.trim()) {
      const parsed = safeJsonParse(req.rawBody);
      if (parsed.ok) body = parsed.value;
    }

    if (!body) {
      context.log("Empty/unparseable body from Event Grid");
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { ok: false, error: "Empty/unparseable body" }
      };
      return;
    }

    const first = Array.isArray(body) ? body[0] : body;

    // Validation handshake
    if (first?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      const code = first?.data?.validationCode || "";
      context.log(`SubscriptionValidationEvent received. code=${code}`);
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { validationResponse: code }
      };
      return;
    }

    const candidates = selectCallbackUrls();
    if (candidates.length === 0) {
      context.log("No callback URL configured (need LOGICAPP_CALLBACK_URL_ACTIVE)");
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { ok: false, error: "No Logic App callback URL configured" }
      };
      return;
    }

    const allowFallback =
      String(process.env.FORWARD_ALLOW_FALLBACK || "true").toLowerCase() === "true";
    const includeBody =
      String(process.env.RETURN_FORWARDED_BODY || "false").toLowerCase() === "true";

    context.log(
      "Callback candidates:",
      candidates.map((c) => `${c.label}=${redactSig(c.url)}`).join(" | ")
    );

    let last = null;
    let used = "NONE";
    let details = "";

    for (const c of candidates) {
      used = c.label;
      try {
        const resp = await postJsonWithRetry(context, c.url, body);
        last = resp;

        const success = resp.status >= 200 && resp.status < 300;

        context.log(
          `Forwarded to Logic App (${c.label}). Status=${resp.status} Attempts=${resp.attempts}`
        );

        if (success || !allowFallback || c.label === "ACTIVE") {
          context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
              ok: success,
              forwardedStatus: resp.status,
              attempts: resp.attempts,
              usedCallback: used,
              ...(includeBody
                ? {
                    forwardedBody:
                      resp.body && resp.body.length > 4000
                        ? resp.body.slice(0, 4000) + "...(truncated)"
                        : resp.body || ""
                  }
                : {})
            }
          };
          return;
        }

        // Non-2xx from NEXT -> try ACTIVE
        context.log(`Non-2xx from ${c.label} (status=${resp.status}); trying fallback...`);
      } catch (err) {
        details = String(err && err.stack ? err.stack : err);
        context.log(`Forwarding error (${c.label}): ${details}`);

        if (!allowFallback || c.label === "ACTIVE") {
          // IMPORTANT: still 200 to Event Grid
          context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
              ok: false,
              forwardedStatus: 0,
              attempts: parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10),
              usedCallback: used,
              error: "Forwarding failed after retries",
              details
            }
          };
          return;
        }
        // else try next candidate
      }
    }

    // All candidates exhausted
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ok: false,
        forwardedStatus: last ? last.status : 0,
        attempts: last ? last.attempts : parseInt(process.env.FORWARD_MAX_ATTEMPTS || "4", 10),
        usedCallback: used,
        error: "Forwarding failed (all candidates exhausted)",
        details
      }
    };
  } catch (e) {
    // absolute last-resort safety net
    context.log(`Unhandled exception: ${String(e && e.stack ? e.stack : e)}`);
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ok: false, error: "Unhandled exception (caught)", details: String(e) }
    };
  }
};

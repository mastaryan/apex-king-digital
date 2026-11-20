// GLP operations proxy: the dashboard asks lucypeptide.com's read-only
// /api/apex/* API server-side and renders the answers under the GLP
// site card. The token lives only in Render env (GLP_DASHBOARD_TOKEN,
// the SAME value set on the lucypeptide service) and never reaches
// the browser. If it is unset here, the endpoints answer
// {configured:false} and the UI shows a plain "not connected" message.
// Upstream errors are surfaced in plain words; the token is never
// included in an error or a log line.
//
// Mirrors db/qwb.js exactly; only the site, base URL, token name, and
// copy differ.
const GLP_BASE = (process.env.GLP_BASE_URL || "https://lucypeptide.com").replace(/\/$/, "");
const TIMEOUT_MS = 10000;
const STATUSES = ["unpaid", "pending_verification", "paid", "processing", "shipped", "cancelled"];

function getToken() {
  return process.env.GLP_DASHBOARD_TOKEN || "";
}

async function glpFetch(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GLP_BASE + path, {
      signal: ctrl.signal,
      headers: { Authorization: "Bearer " + getToken(), Accept: "application/json" },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* leave null */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function mountGlp(app, authRequired) {
  async function proxy(req, res, upstreamPath) {
    if (!getToken()) return res.json({ configured: false });
    let upstream;
    try {
      upstream = await glpFetch(upstreamPath);
    } catch (e) {
      const reason = e && e.name === "AbortError" ? "timed out" : "could not be reached";
      return res.status(502).json({ error: "lucypeptide.com " + reason + " — try again in a moment." });
    }
    if (upstream.status === 503) {
      // The GLP side has no token set yet: same "not connected" state.
      return res.json({ configured: false, reason: "glp_not_configured" });
    }
    if (upstream.status === 401) {
      return res.status(502).json({ error: "The dashboard token does not match the GLP site. Both Render services need the same GLP_DASHBOARD_TOKEN value." });
    }
    if (upstream.status === 404) {
      return res.status(404).json({ error: "not found" });
    }
    if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
      return res.status(502).json({ error: "lucypeptide.com answered with an error (HTTP " + upstream.status + ")." });
    }
    res.json(upstream.body);
  }

  app.get("/api/glp/orders", authRequired, (req, res) => {
    const q = STATUSES.includes(req.query.status) ? "?status=" + req.query.status : "";
    proxy(req, res, "/api/apex/orders" + q);
  });

  app.get("/api/glp/orders/:number", authRequired, (req, res) => {
    proxy(req, res, "/api/apex/orders/" + encodeURIComponent(req.params.number));
  });

  app.get("/api/glp/emails", authRequired, (req, res) => {
    const q = req.query.order ? "?order=" + encodeURIComponent(req.query.order) : "";
    proxy(req, res, "/api/apex/emails" + q);
  });
}

module.exports = { mountGlp };

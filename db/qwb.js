// QWB operations proxy: the dashboard asks qwbiotech.com's read-only
// /api/apex/* API server-side and renders the answers under the QWB
// site card. The token lives only in Render env (QWB_DASHBOARD_TOKEN,
// the SAME value set on the qwbiotech-app service) and never reaches
// the browser. If it is unset here, the endpoints answer
// {configured:false} and the UI shows a plain "not connected" message.
// Upstream errors are surfaced in plain words; the token is never
// included in an error or a log line.
const QWB_BASE = (process.env.QWB_BASE_URL || "https://qwbiotech.com").replace(/\/$/, "");
const TIMEOUT_MS = 10000;
const STATUSES = ["unpaid", "pending_verification", "paid", "processing", "shipped", "cancelled"];

function getToken() {
  return process.env.QWB_DASHBOARD_TOKEN || "";
}

async function qwbFetch(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(QWB_BASE + path, {
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

function mountQwb(app, authRequired) {
  async function proxy(req, res, upstreamPath) {
    if (!getToken()) return res.json({ configured: false });
    let upstream;
    try {
      upstream = await qwbFetch(upstreamPath);
    } catch (e) {
      const reason = e && e.name === "AbortError" ? "timed out" : "could not be reached";
      return res.status(502).json({ error: "qwbiotech.com " + reason + " — try again in a moment." });
    }
    if (upstream.status === 503) {
      // The QWB side has no token set yet: same "not connected" state.
      return res.json({ configured: false, reason: "qwb_not_configured" });
    }
    if (upstream.status === 401) {
      return res.status(502).json({ error: "The dashboard token does not match the QWB site. Both Render services need the same QWB_DASHBOARD_TOKEN value." });
    }
    if (upstream.status === 404) {
      return res.status(404).json({ error: "not found" });
    }
    if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
      return res.status(502).json({ error: "qwbiotech.com answered with an error (HTTP " + upstream.status + ")." });
    }
    res.json(upstream.body);
  }

  app.get("/api/qwb/orders", authRequired, (req, res) => {
    const q = STATUSES.includes(req.query.status) ? "?status=" + req.query.status : "";
    proxy(req, res, "/api/apex/orders" + q);
  });

  app.get("/api/qwb/orders/:number", authRequired, (req, res) => {
    proxy(req, res, "/api/apex/orders/" + encodeURIComponent(req.params.number));
  });

  app.get("/api/qwb/emails", authRequired, (req, res) => {
    const q = req.query.order ? "?order=" + encodeURIComponent(req.query.order) : "";
    proxy(req, res, "/api/apex/emails" + q);
  });
}

module.exports = { mountQwb };

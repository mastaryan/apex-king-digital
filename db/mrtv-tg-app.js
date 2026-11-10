// M.R. TV Telegram Mini App backend (2026-11-10).
//
// Customer-facing API for the mini app at watchmrtv.com/tg-app/ (static on
// Netlify). The mini app talks cross-origin to this dashboard backend; all
// routes below are PUBLIC (no admin session) but gated by Telegram initData
// validation and/or a signed session token.
//
// Env:
//   MRTV_TG_BOT_TOKEN (preferred) or TELEGRAM_BOT_TOKEN — the bot whose menu
//     button launches the mini app. initData HMAC validation uses this token.
//     TELEGRAM_BOT_TOKEN already exists on Render (Ryan's DM pings); if that
//     token belongs to a different bot than the M.R. TV one, set
//     MRTV_TG_BOT_TOKEN to the M.R. TV bot's token.
//   MRTV_TG_SESSION_SECRET (optional) — signs customer session tokens;
//     falls back to the bot token.
//   TELEGRAM_CHAT_ID — Ryan's DM (order pings + payment screenshots).
//   SMTP_HOST / SMTP_PORT / TV_SMTP_USER / TV_SMTP_PASS (or SMTP_USER /
//     SMTP_PASS) — link-code emails (same mailer config as mrtv-provision).
//
// Schema (added by apply-mrtv-tg-app-patch.py -> db/schema.sql):
//   mrtv_customers.telegram_chat_id TEXT
//   mrtv_customers.tg_link_code TEXT, tg_link_code_at TIMESTAMPTZ,
//     tg_link_tries INT NOT NULL DEFAULT 0
// Apply with POST /api/admin/schema (admin auth) after deploy.
//
// Pricing lives here AND in the mini app (client shows, server verifies):
//   YEARLY {1:80, 2:100, 3:125, 4:150, 5:175}, MONTHLY {1:10, 2:15, 3:18,
//   4:21, 5:24}, TiviMate +$30 one-time. Prices are ON HOLD per Ryan —
//   change them in BOTH places if he ever moves them.
// Add-on rule (Ryan): TV added within 30 days of start = bundle price
//   (monthly 2nd +$5, 3rd+ +$3; yearly 2nd +$20, 3rd+ +$25). After 30 days
//   = single-TV price ($10/mo or $80/yr) for the rest of the term, then it
//   folds into the bundle tier at renewal.
// Orders from the mini app land as PENDING mrtv_customers rows
// (source='telegram', notes flag "REVIEW BEFORE PROVISIONING") exactly like
// website orders — Ryan reviews, marks paid, provisions with the existing
// one-click flow. Nothing auto-provisions. Panel logins are NEVER returned
// by these endpoints (delivered by text/email only).
"use strict";

const crypto = require("crypto");
const { getPool, pgEnabled } = require("./pg");

const YEARLY = { 1: 8000, 2: 10000, 3: 12500, 4: 15000, 5: 17500 };
const MONTHLY = { 1: 1000, 2: 1500, 3: 1800, 4: 2100, 5: 2400 };
const TIVIMATE_CENTS = 3000;
const CASH_TAG = "$ApexKingDigital";
const ZELLE_HANDLE = "info@helixkinglabs.com";
const TG_APP_ORIGINS = ["https://watchmrtv.com", "https://mrtv-tv.netlify.app"];

/* ---------------- helpers ---------------- */
function cleanStr(s, n) { return String(s || "").trim().slice(0, n || 200); }
function nyToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function addMonthsISO(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function addYearsISO(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000); }
function fmtDate(iso) {
  const p = String(iso || "").split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(p[1]) - 1] || "";
  return mon + " " + Number(p[2]) + ", " + p[0];
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "")); }
function planPriceCents(plan, tvs) {
  const t = plan === "monthly" ? MONTHLY : YEARLY;
  return t[Math.max(1, Math.min(5, Number(tvs) || 1))] || t[1];
}
// Add-on price for ONE extra TV, per Ryan's 30-day rule.
function addTvPriceCents(customer) {
  const start = String(customer.start_date || "").slice(0, 10);
  const within30 = start ? daysBetween(start, nyToday()) <= 30 : true;
  const cur = Number(customer.tv_count) || 1;
  let cents;
  if (customer.plan === "monthly") cents = within30 ? (cur === 1 ? 500 : 300) : 1000;
  else cents = within30 ? (cur === 1 ? 2000 : 2500) : 8000;
  return { cents, within30 };
}
function renewalCents(customer) {
  if (customer.renewal_amount_cents != null) return Number(customer.renewal_amount_cents);
  return planPriceCents(customer.plan, customer.tv_count);
}

/* ---------------- Telegram ---------------- */
function botToken() { return process.env.MRTV_TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || ""; }
function sessionSecret() { return process.env.MRTV_TG_SESSION_SECRET || botToken(); }

// initData validation per Telegram Mini App docs: data_check_string is the
// sorted key=value pairs (minus hash), HMAC-SHA256 with secret =
// HMAC-SHA256(key "WebAppData", message bot token). NOTE: this is NOT the
// Telegram Login Widget's SHA-256(bot token) — that derivation fails every
// Mini App signature (found 2026-11-10: bad_init_data on all attempts).
function validateInitData(initData) {
  const token = botToken();
  if (!token || !initData) return null;
  let params;
  try { params = new URLSearchParams(String(initData)); } catch (e) { return null; }
  const hash = params.get("hash") || "";
  if (!hash) return null;
  params.delete("hash");
  const pairs = [];
  for (const [k, v] of params) pairs.push(k + "=" + v);
  pairs.sort();
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const calc = crypto.createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  if (calc !== hash) return null;
  let tgUser = null;
  try { tgUser = JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
  if (!tgUser || !tgUser.id) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null; // stale initData
  return { id: String(tgUser.id), first_name: tgUser.first_name || "", username: tgUser.username || "" };
}

// Signed customer session token: v1.<customerId>.<expUnix>.<hmacHex>.
// Stateless (no session table) — 30-day expiry, HMAC over id + exp.
function issueSession(customerId) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const payload = String(customerId) + "." + exp;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return "v1." + payload + "." + sig;
}
function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const payload = parts[1] + "." + parts[2];
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  if (sig !== parts[3]) return null;
  if (Number(parts[2]) * 1000 < Date.now()) return null;
  return parts[1]; // customer id (uuid)
}

async function sendTelegramPing(text) {
  const token = botToken();
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return { ok: false, skipped: true };
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text || "").slice(0, 4000) }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 120) }; }
}

// Payment screenshot -> Ryan's Telegram DM as a photo. Best-effort: the
// order succeeds even if this fails (the screenshot is optional).
async function sendTelegramPhoto(base64DataUrl, caption) {
  const token = botToken();
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId || !base64DataUrl) return { ok: false, skipped: true };
  try {
    const m = String(base64DataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return { ok: false, error: "bad data url" };
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 2 * 1024 * 1024) return { ok: false, error: "too large" };
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", String(caption || "").slice(0, 1000));
    form.append("photo", new Blob([buf], { type: m[1] }), "payment.png");
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendPhoto", { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 120) }; }
}

/* ---------------- email (link codes) ---------------- */
function mailer() {
  const user = process.env.TV_SMTP_USER || process.env.SMTP_USER;
  const pass = process.env.TV_SMTP_PASS || process.env.SMTP_PASS;
  if (!process.env.SMTP_HOST || !user || !pass) return null;
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user, pass },
  });
}
function mailFrom() {
  const tvUser = process.env.TV_SMTP_USER;
  return "M.R. TV <" + (tvUser || "hello@apexkingdigital.com") + ">";
}

/* ---------------- customer serialization ---------------- */
function publicCustomer(r) {
  if (!r) return null;
  const end = String(r.end_date || "").slice(0, 10);
  const daysLeft = end ? daysBetween(nyToday(), end) : null;
  return {
    id: r.id, name: r.name, email: r.email, plan: r.plan,
    tv_count: Number(r.tv_count) || 1,
    start_date: String(r.start_date || "").slice(0, 10), end_date: end,
    days_left: daysLeft, renewal_amount_cents: r.renewal_amount_cents,
    order_code: r.order_code, package: r.package, adult_ok: !!r.adult_ok,
    tivimate_bundle: !!r.tivimate_bundle,
    lines_count: Array.isArray(r.lines) ? r.lines.length : 0,
    provisioned_at: r.provisioned_at || null,
  };
}
const CUSTOMER_COLS = "id, name, email, cell, plan, start_date, end_date, notes, renewal_amount_cents, tv_count, package, adult_ok, tivimate_bundle, lines, provisioned_at, needs_manual, created_at, order_code, source, payment_method, referred_by, referred_by_customer_id, referral_months_applied, telegram_chat_id";

/* ---------------- rate limiting (in-memory, per IP+route) ---------------- */
const _rl = new Map();
function limited(ip, key, max, windowMs) {
  const k = (ip || "?") + ":" + key;
  const now = Date.now();
  const e = _rl.get(k);
  if (!e || now > e.resetAt) { _rl.set(k, { count: 1, resetAt: now + windowMs }); return false; }
  e.count += 1;
  return e.count > max;
}
function clientIp(req) {
  return String((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").slice(0, 64);
}

/* ---------------- mount ---------------- */
function mountMrtvTgApp(app) {
  const needPg = (req, res) => {
    if (!pgEnabled()) { res.status(503).json({ error: "unavailable (Postgres not configured)" }); return true; }
    return false;
  };
  const noBotToken = (res) => { res.status(503).json({ error: "telegram bot not configured" }); return true; };

  // CORS for the mini app origin only. The app is static on Netlify and
  // calls this backend cross-origin with a Bearer session token (no cookies).
  app.use("/api/mrtv/tg-app", (req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (TG_APP_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.status(204).end();
    }
    next();
  });

  function readBody(req) {
    // The dashboard runs express.json() globally, so req.body is usually
    // already parsed — only read the stream as a fallback.
    if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 3 * 1024 * 1024) reject(new Error("body too large")); });
      req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  }
  async function authedCustomer(req) {
    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return null;
    const id = verifySession(m[1].trim());
    if (!id) return null;
    const { rows } = await getPool().query(
      "SELECT " + CUSTOMER_COLS + " FROM mrtv_customers WHERE id = $1", [id]);
    return rows[0] || null;
  }

  // ---- POST /api/mrtv/tg-app/auth ----
  app.post("/api/mrtv/tg-app/auth", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      if (!botToken()) return noBotToken(res);
      if (limited(clientIp(req), "tgapp-auth", 30, 15 * 60 * 1000)) return res.status(429).json({ error: "rate" });
      let body; try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: "bad_request" }); }
      const tgUser = validateInitData(body.initData || "");
      if (!tgUser) return res.status(401).json({ error: "bad_init_data" });
      const { rows } = await getPool().query(
        "SELECT " + CUSTOMER_COLS + " FROM mrtv_customers WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
        [tgUser.id]);
      const customer = rows[0] || null;
      if (!customer) return res.json({ linked: false, telegram: tgUser });
      return res.json({ linked: true, telegram: tgUser, customer: publicCustomer(customer), session: { token: issueSession(customer.id) } });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // ---- POST /api/mrtv/tg-app/link ---- (send 6-digit code to account email)
  app.post("/api/mrtv/tg-app/link", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      if (!botToken()) return noBotToken(res);
      if (limited(clientIp(req), "tgapp-link", 5, 60 * 60 * 1000)) return res.status(429).json({ error: "rate" });
      let body; try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: "bad_request" }); }
      const tgUser = validateInitData(body.initData || "");
      if (!tgUser) return res.status(401).json({ error: "bad_init_data" });
      const email = String(body.email || "").toLowerCase().trim();
      if (!validEmail(email)) return res.status(400).json({ error: "email" });
      const { rows } = await getPool().query(
        "SELECT id, email FROM mrtv_customers WHERE LOWER(email) = $1 ORDER BY created_at DESC LIMIT 1", [email]);
      const target = rows[0];
      if (!target) return res.json({ ok: true }); // same answer either way
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await getPool().query(
        "UPDATE mrtv_customers SET tg_link_code = $1, tg_link_code_at = now(), tg_link_tries = 0 WHERE id = $2",
        [code, target.id]);
      const ml = mailer();
      if (ml) {
        try {
          await ml.sendMail({
            from: mailFrom(), replyTo: "tv@watchmrtv.com", to: target.email,
            subject: "Your M.R. TV Telegram link code",
            text: "Your M.R. TV Telegram Mini App link code is " + code + ". It expires in 10 minutes. If you didn't ask for this, ignore this email.",
          });
        } catch (e) { /* code is set; a mail failure surfaces at confirm time as "code not found" only if the row is missing — it isn't. Log server-side only. */ console.error("mrtv tg-app link mail", String(e.message || e).slice(0, 160)); }
      }
      return res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // ---- POST /api/mrtv/tg-app/link/confirm ----
  app.post("/api/mrtv/tg-app/link/confirm", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      if (!botToken()) return noBotToken(res);
      if (limited(clientIp(req), "tgapp-link-confirm", 10, 15 * 60 * 1000)) return res.status(429).json({ error: "rate" });
      let body; try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: "bad_request" }); }
      const tgUser = validateInitData(body.initData || "");
      if (!tgUser) return res.status(401).json({ error: "bad_init_data" });
      const email = String(body.email || "").toLowerCase().trim();
      const code = String(body.code || "").trim();
      if (!validEmail(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "bad_code" });
      const { rows } = await getPool().query(
        "SELECT " + CUSTOMER_COLS + ", tg_link_code, tg_link_code_at, tg_link_tries FROM mrtv_customers WHERE LOWER(email) = $1 ORDER BY created_at DESC LIMIT 1",
        [email]);
      const target = rows[0];
      if (!target || !target.tg_link_code) return res.status(400).json({ error: "bad_code" });
      const tries = (Number(target.tg_link_tries) || 0) + 1;
      if (tries > 5) {
        await getPool().query("UPDATE mrtv_customers SET tg_link_code = NULL, tg_link_tries = $1 WHERE id = $2", [tries, target.id]);
        return res.status(400).json({ error: "too_many_tries" });
      }
      const ageMs = Date.now() - new Date(target.tg_link_code_at || 0).getTime();
      if (ageMs > 10 * 60 * 1000) {
        await getPool().query("UPDATE mrtv_customers SET tg_link_code = NULL WHERE id = $1", [target.id]);
        return res.status(400).json({ error: "code_expired" });
      }
      if (String(target.tg_link_code) !== code) {
        await getPool().query("UPDATE mrtv_customers SET tg_link_tries = $1 WHERE id = $2", [tries, target.id]);
        return res.status(400).json({ error: "bad_code" });
      }
      await getPool().query(
        "UPDATE mrtv_customers SET tg_link_code = NULL, tg_link_code_at = NULL, tg_link_tries = 0, telegram_chat_id = $1 WHERE id = $2",
        [tgUser.id, target.id]);
      const { rows: fresh } = await getPool().query(
        "SELECT " + CUSTOMER_COLS + " FROM mrtv_customers WHERE id = $1", [target.id]);
      return res.json({ linked: true, telegram: tgUser, customer: publicCustomer(fresh[0]), session: { token: issueSession(target.id) } });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // ---- GET /api/mrtv/tg-app/me ----
  app.get("/api/mrtv/tg-app/me", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const customer = await authedCustomer(req);
      if (!customer) return res.status(401).json({ error: "unauthorized" });
      return res.json({ customer: publicCustomer(customer) });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // ---- POST /api/mrtv/tg-app/order ----
  // New-customer order from the mini app. Creates a PENDING customer row
  // (source='telegram') for Ryan to review + provision — same as website
  // orders. Server computes the price; the client's total is ignored.
  // If initData is supplied, the Telegram id is linked to the new row and
  // a session token is returned, so the subscription shows up in the app.
  app.post("/api/mrtv/tg-app/order", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      if (limited(clientIp(req), "tgapp-order", 10, 60 * 60 * 1000)) return res.status(429).json({ error: "rate" });
      let body; try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: "bad_request" }); }
      const o = (body && body.order) || {};
      const tgUser = body.initData ? validateInitData(body.initData) : null;
      // A session token also proves identity (returning customer ordering again).
      let sessionCustomer = null;
      if (body.sessionToken) {
        const id = verifySession(String(body.sessionToken));
        if (id) {
          const { rows } = await getPool().query("SELECT id FROM mrtv_customers WHERE id = $1", [id]);
          sessionCustomer = rows[0] || null;
        }
      }
      const name = cleanStr(o.name, 120) || cleanStr(String(o.email || "").split("@")[0], 120) || "Telegram customer";
      const email = cleanStr(o.email, 120) || null;
      const cell = cleanStr(o.cell || o.phone, 40) || null;
      if (!email || !validEmail(email)) return res.status(400).json({ error: "email" });
      const tvs = Math.max(1, Math.min(5, parseInt(o.connections, 10) || 1));
      const plan = String(o.plan || "monthly").toLowerCase().indexOf("month") >= 0 ? "monthly" : "yearly";
      const tivimate = !!o.tivimate;
      const totalC = planPriceCents(plan, tvs) + (tivimate ? TIVIMATE_CENTS : 0);
      const pkgRaw = String(o.package || "usa").toLowerCase();
      const pkg = pkgRaw === "all" ? "all" : (pkgRaw === "custom" ? "custom" : "usa");
      const adult = !!o.adult;
      const payMethod = cleanStr(o.payment_method, 60) || "Cash App";
      const formCode = cleanStr(o.order_code, 40);
      const codeOk = /^MR-\d{4}$/.test(formCode);
      if (codeOk) {
        const { rows: dup } = await getPool().query("SELECT id FROM mrtv_customers WHERE order_code = $1", [formCode]);
        if (dup.length) return res.json({ ok: true, deduped: true, order_code: formCode });
      }
      const start = nyToday();
      const end = plan === "monthly" ? addMonthsISO(start, 1) : addYearsISO(start, 1);
      const noteParts = ["📱 TELEGRAM MINI APP ORDER — REVIEW BEFORE PROVISIONING"];
      noteParts.push("Payment: " + payMethod);
      noteParts.push("Total due: $" + (totalC / 100).toFixed(2).replace(/\.00$/, ""));
      if (tivimate) noteParts.push("TiviMate bundle: yes (+$30)");
      const devices = Array.isArray(o.devices) ? o.devices.join(", ") : cleanStr(o.devices, 200);
      if (devices) noteParts.push("Devices: " + devices);
      const countries = cleanStr(o.custom_countries, 200);
      if (countries) noteParts.push("Countries: " + countries);
      const ref = cleanStr(o.referred_by, 120);
      let referrerId = null, referrerName = null;
      if (ref) {
        const rcode = ref.toUpperCase().replace(/[^A-Z0-9-]/g, "");
        if (rcode) {
          const { rows: m } = await getPool().query(
            "SELECT id, name FROM mrtv_customers WHERE UPPER(order_code) = $1 LIMIT 1", [rcode]);
          if (m.length) { referrerId = m[0].id; referrerName = m[0].name; }
        }
      }
      if (ref) noteParts.push("Referred by: " + ref + (referrerName ? " (matched: " + referrerName + ")" : ""));
      const deliv = cleanStr(o.delivery, 40);
      if (deliv) noteParts.push("Delivery: " + deliv);
      const custNotes = cleanStr(o.notes, 500);
      if (custNotes) noteParts.push("Customer notes: " + custNotes);
      const notes = noteParts.join("\n");
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_customers (name, email, cell, plan, start_date, end_date, notes, renewal_amount_cents, tv_count, package, adult_ok, tivimate_bundle, source, payment_method, referred_by, referred_by_customer_id, telegram_chat_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'telegram',$13,$14,$15,$16) RETURNING id",
        [name, email, cell, plan, start, end, notes, totalC, tvs, pkg, adult, tivimate, payMethod, ref || null, referrerId, tgUser ? tgUser.id : null]);
      const id = rows[0].id;
      const code = codeOk ? formCode : ("MR-" + String(id).slice(0, 8).toUpperCase());
      await getPool().query("UPDATE mrtv_customers SET order_code = $1 WHERE id = $2", [code, id]);
      await sendTelegramPing("🛒 New Telegram app order: " + name + " — " + tvs + " TV" + (tvs === 1 ? "" : "s") + ", " + plan +
        ", $" + (totalC / 100).toFixed(2).replace(/\.00$/, "") + " via " + payMethod + ", code " + code +
        (tivimate ? " (TiviMate bundle)" : "") + (referrerName ? ". Referred by " + referrerName + " (" + ref + ")" : "") +
        ". Review in the dashboard, then Mark paid & provision.");
      const screenshot = o.screenshot || body.screenshot || null;
      if (screenshot) {
        await sendTelegramPhoto(screenshot, "Payment screenshot — " + code + " (" + name + ", " + tvs + " TV" + (tvs === 1 ? "" : "s") + ", " + plan + ")");
      }
      const out = { ok: true, id, order_code: code, total_cents: totalC };
      if (tgUser || sessionCustomer) out.session = { token: issueSession(id) };
      return res.json(out);
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // ---- POST /api/mrtv/tg-app/add-tv ----
  // One extra TV for the current term. Server computes the price from the
  // 30-day rule; the customer pays with their order code as memo and Ryan
  // provisions + updates tv_count in the dashboard (same as today).
  app.post("/api/mrtv/tg-app/add-tv", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      if (limited(clientIp(req), "tgapp-addtv", 10, 60 * 60 * 1000)) return res.status(429).json({ error: "rate" });
      const customer = await authedCustomer(req);
      if (!customer) return res.status(401).json({ error: "unauthorized" });
      if ((Number(customer.tv_count) || 1) >= 5) return res.status(400).json({ error: "max_tvs" });
      const { cents, within30 } = addTvPriceCents(customer);
      const stamp = nyToday() + " ADD-TV REQUEST (Telegram app): +1 TV, $" + (cents / 100).toFixed(2).replace(/\.00$/, "") +
        " (" + (within30 ? "within 30 days of start — bundle price" : "after 30 days — single-TV price, rest of term") +
        "). Awaiting payment with code " + (customer.order_code || "") + " as memo.";
      await getPool().query(
        "UPDATE mrtv_customers SET notes = CASE WHEN notes = '' THEN $1 ELSE $1 || E'\\n' || notes END WHERE id = $2",
        [stamp, customer.id]);
      await sendTelegramPing("📺 Add-TV request (Telegram app): " + customer.name + " (" + (customer.order_code || customer.email) + ") — +1 TV, $" +
        (cents / 100).toFixed(2).replace(/\.00$/, "") + ", " + customer.plan + " term through " + fmtDate(customer.end_date) +
        " (" + (within30 ? "within 30 days — bundle price" : "after 30 days — single-TV price") + "). Match payment by order code, then provision + update TV count.");
      return res.json({ ok: true, amount_cents: cents, order_code: customer.order_code, within30, plan: customer.plan, tv_count: Number(customer.tv_count) || 1 });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // ---- POST /api/mrtv/tg-app/renew ----
  // Renewal request: returns the amount + order code; the customer pays
  // with the code as memo and Ryan extends the lines with the existing
  // one-tap renew. Same manual flow as monthly renewals today.
  app.post("/api/mrtv/tg-app/renew", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      if (limited(clientIp(req), "tgapp-renew", 10, 60 * 60 * 1000)) return res.status(429).json({ error: "rate" });
      const customer = await authedCustomer(req);
      if (!customer) return res.status(401).json({ error: "unauthorized" });
      const cents = renewalCents(customer);
      const stamp = nyToday() + " RENEWAL REQUEST (Telegram app): $" + (cents / 100).toFixed(2).replace(/\.00$/, "") +
        " for " + (Number(customer.tv_count) || 1) + " TV" + ((Number(customer.tv_count) || 1) === 1 ? "" : "s") + ", " + customer.plan +
        ". Awaiting payment with code " + (customer.order_code || "") + " as memo.";
      await getPool().query(
        "UPDATE mrtv_customers SET notes = CASE WHEN notes = '' THEN $1 ELSE $1 || E'\\n' || notes END WHERE id = $2",
        [stamp, customer.id]);
      await sendTelegramPing("🔁 Renewal request (Telegram app): " + customer.name + " (" + (customer.order_code || customer.email) + ") — $" +
        (cents / 100).toFixed(2).replace(/\.00$/, "") + ", " + (Number(customer.tv_count) || 1) + " TV" + ((Number(customer.tv_count) || 1) === 1 ? "" : "s") +
        ", " + customer.plan + ", current term through " + fmtDate(customer.end_date) + ". Match payment by order code, then renew.");
      return res.json({ ok: true, amount_cents: cents, order_code: customer.order_code, plan: customer.plan, tv_count: Number(customer.tv_count) || 1, end_date: String(customer.end_date || "").slice(0, 10) });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });
}

module.exports = { mountMrtvTgApp, validateInitData, issueSession, verifySession, planPriceCents, addTvPriceCents };

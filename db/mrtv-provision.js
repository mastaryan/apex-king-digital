// M.R. TV one-click provisioning (Ryan 2026-10-29: "Build it!").
//
// Ryan adds a customer, clicks "Mark paid & provision", and the dashboard:
//   1. creates one panel line per TV (sub=12 yearly / sub=1 monthly),
//   2. stores the returned credentials on the customer record,
//   3. fills the login email template and sends it (M.R. TV via hello@,
//      Reply-To tv@ — no tv@ SMTP credential on hand),
//   4. fires the profit-split ledger order on the same click.
//
// SECURITY: the panel API key lives ONLY in the TVPLUS_API_KEY Render env
// var, server-side. It is never logged, never returned to the frontend,
// and only ever sent as a query param to tvpluspanel.ru.
//
// Verified API facts (2026-10-29, via Ryan's browser; this box can't reach
// the panel host, but the Render backend has normal egress):
//   endpoint https://tvpluspanel.ru/api/api.php (tvpluspanel.net is DNS-dead)
//   reseller_info -> {status:"true", username, enabled, credits}
//   bouquet templates: 36929 "USA Only - Adults", 36930 "USA Only - No Adults",
//                       36931 "All Countries - No Adult", 36937 "All Countries - Adults"
//   new:    ?action=new&type=m3u&sub=12&pack=36930&api_key=KEY[&note=...]
//           sub: 1 = monthly, 12 = yearly, 99 = demo (burns 1 demo ticket).
//           The panel API also accepts other terms (3/6-month, 2-year), but
//           the dashboard offers ONLY these three durations (Ryan 2026-10-29).
//   renew:  ?action=renew&type=m3u&username=U&password=P&sub=12&api_key=KEY
// Gaps: new lines likely use the panel's default portal host until proven
// otherwise; demo ticket mechanics unconfirmed (Ryan is asking the parent).
"use strict";

const { getPool, pgEnabled } = require("./pg");

const PANEL_API = "https://tvpluspanel.ru/api/api.php";
const PACK_USA_ADULT = 36929;
const PACK_USA_NO_ADULT = 36930;
const PACK_ALL_NO_ADULT = 36931;
const PACK_ALL_ADULT = 36937;
const LOW_CREDIT_WARN = 20; // warn Ryan below this many panel credits

function panelKey() { return process.env.TVPLUS_API_KEY || ""; }
function lineServer() { return process.env.LINE_SERVER_URL || "http://line.tvdeluxe.us"; }
function cleanStr(s, n) { return String(s || "").trim().slice(0, n || 200); }
function nyToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function addDaysISO(iso, n) {
  const d = new Date(String(iso) + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtLongDate(iso) {
  const p = String(iso || "").split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(p[1]) - 1] || "";
  return mon + " " + Number(p[2]) + ", " + p[0];
}

// Panel GET. Throws NO_KEY when the env var is missing so callers can
// answer "not configured" instead of "panel down".
async function panelCall(params) {
  const key = panelKey();
  if (!key) {
    const e = new Error("TVPLUS_API_KEY is not set in the Render env — add it, then redeploy.");
    e.code = "NO_KEY";
    throw e;
  }
  const qs = new URLSearchParams(Object.assign({}, params, { api_key: key })).toString();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(PANEL_API + "?" + qs, { signal: ctl.signal, headers: { "User-Agent": "ApexDashboard/1.0" } });
    const data = await r.json();
    if (!data || data.status !== "true")
      throw new Error(String((data && data.message) || "panel returned an error").slice(0, 200));
    return data;
  } catch (e) {
    if (e.code === "NO_KEY") throw e;
    throw new Error("panel unreachable: " + String(e.message || e).slice(0, 160));
  } finally { clearTimeout(t); }
}

// Returns { pack } or { flag: 'custom-package' } (select-countries: no
// template, must be provisioned by hand). All four package/adult combos
// have templates now (36937 "All Countries - Adults" added 2026-10-29).
function packFor(pkg, adult) {
  if (pkg === "usa") return { pack: adult ? PACK_USA_ADULT : PACK_USA_NO_ADULT };
  if (pkg === "all") return { pack: adult ? PACK_ALL_ADULT : PACK_ALL_NO_ADULT };
  return { flag: "custom-package" };
}

// The panel's action=new does NOT return username/password as top-level
// fields (the API docs example shows only status/user_id/message/url).
// The credentials ride inside the `url` field's query string:
//   .../get.php?username=U&password=P&type=m3u_plus&output=ts
// Accept top-level fields too, in case the panel version differs.
function credsFromNewResponse(d) {
  if (d && d.username && d.password)
    return { username: String(d.username), password: String(d.password) };
  if (d && d.url) {
    try {
      const u = new URL(String(d.url));
      const un = u.searchParams.get("username"), pw = u.searchParams.get("password");
      if (un && pw) return { username: un, password: pw };
    } catch (e) { /* fall through */ }
  }
  return null;
}

// Login email template — kept in sync with
// ~/workspace/iptv-reseller/login-email-template.txt (embedded here so the
// Render deploy is self-contained).
const LOGIN_TEMPLATE = [
  "SUBJECT: Your M.R. TV logins are ready \uD83D\uDCFA",
  "",
  "Hi [FIRST NAME] \u2014 you\u2019re all set! Here are your M.R. TV logins.",
  "",
  "YOUR PLAN: [e.g. 2 TVs \u2014 $120/year]  \u2022  Good through: [EXPIRY DATE]",
  "",
  "TV 1 \u2014 [e.g. Living Room]",
  "Username: [USERNAME]",
  "Password: [PASSWORD]",
  "",
  "TV 2 \u2014 [e.g. Bedroom]",
  "Username: [USERNAME]",
  "Password: [PASSWORD]",
  "",
  "Server URL (every TV): http://line.tvdeluxe.us",
  "",
  "SETUP (about 5 minutes, step-by-step):",
  "https://mrtv-tv.netlify.app/guide.html",
  "",
  "Quick version: install IPTV Smarters on your TV/device, choose \u201cLogin with Xtream Codes API\u201d (not the M3U playlist option), and type your username, password, and the server URL exactly as shown above. Use one login per TV \u2014 one login plays on one screen at a time.",
  "",
  "--- ONLY IF THEY BOUGHT THE TIVIMATE BUNDLE, ADD THIS BLOCK ---",
  "TIVIMATE BUNDLE:",
  "TiviMate account email: [THEIR EMAIL]",
  "TiviMate password: [PASSWORD YOU SET]",
  "Premium: LIFETIME \u2014 already paid by us, it never renews.",
  "In the setup guide, look for the purple \u201cTiviMate Bundle\u201d box near the top \u2014 it walks you through signing in and adding your TV login. In TiviMate, use Add playlist \u2192 Xtream Codes (not the M3U playlist option). The TiviMate account covers up to 5 devices, and you can change its password anytime in the free TiviMate Companion app.",
  "---",
  "",
  "Stuck anywhere? WhatsApp us at (606) 657-1545 between 9am and 9pm EST and we\u2019ll walk you through it. Just tell us your order code: [MR-####].",
  "",
  "Thanks for joining M.R. TV \u2014 enjoy!",
  "\u2014 Ryan, M.R. TV",
  "",
].join("\n");

// Pure function (unit-testable). o: { firstName, planDesc, expiry, tvLines,
// serverUrl, tivimateEmail|null, orderCode }.
function fillLoginEmail(tpl, o) {
  const m = tpl.match(/^SUBJECT:\s*(.*)$/m);
  const subject = (m ? m[1] : "Your M.R. TV logins are ready").trim();
  let s = tpl.replace(/^SUBJECT:.*$/m, "").replace(/^\n/, "");
  s = s.split("[FIRST NAME]").join(o.firstName);
  s = s.split("[e.g. 2 TVs \u2014 $120/year]").join(o.planDesc);
  s = s.split("[EXPIRY DATE]").join(o.expiry);
  const blocks = o.tvLines.map((l, i) =>
    "TV " + (i + 1) + "\nUsername: " + l.username + "\nPassword: " + l.password).join("\n\n");
  s = s.replace(
    /TV 1 \u2014 \[e\.g\. Living Room\]\nUsername: \[USERNAME\]\nPassword: \[PASSWORD\]\n\nTV 2 \u2014 \[e\.g\. Bedroom\]\nUsername: \[USERNAME\]\nPassword: \[PASSWORD\]/,
    blocks);
  s = s.split("http://line.tvdeluxe.us").join(o.serverUrl);
  const tivRe = /--- ONLY IF THEY BOUGHT THE TIVIMATE BUNDLE, ADD THIS BLOCK ---\n([\s\S]*?)\n---/;
  if (o.tivimateEmail) {
    s = s.replace(tivRe, function (mt, inner) {
      return inner.split("[THEIR EMAIL]").join(o.tivimateEmail)
        .split("[PASSWORD YOU SET]").join("set by Ryan \u2014 he\u2019ll text it to you");
    });
  } else {
    s = s.replace(tivRe, "");
  }
  s = s.split("[MR-####]").join(o.orderCode);
  return { subject: subject, text: s.replace(/\n{3,}/g, "\n\n").trim() + "\n" };
}

function mailer() {
  // tv@ mailbox credential (TV_SMTP_USER/TV_SMTP_PASS) is preferred for the
  // login email; falls back to the shared hello@ SMTP credential.
  const user = process.env.TV_SMTP_USER || process.env.SMTP_USER;
  const pass = process.env.TV_SMTP_PASS || process.env["SMTP_" + "PASS"];
  if (!process.env.SMTP_HOST || !user || !pass) return null;
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: user, pass: pass },
  });
}
// Literal tv@ From once TV_SMTP_USER is set; until then M.R. TV via hello@
// with Reply-To tv@ (the renewal emails already work this way).
function loginFrom() {
  const tvUser = process.env.TV_SMTP_USER;
  return "M.R. TV <" + (tvUser || "hello@apexkingdigital.com") + ">";
}

// Sent-mail log: the proof-of-send record. Every M.R. TV email gets a row
// with the SMTP message id + server response (or the error).
async function logEmail(o) {
  try {
    const info = o.info || {};
    await getPool().query(
      "INSERT INTO mrtv_email_log (kind, customer_id, to_email, subject, message_id, smtp_response, ok, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [o.kind, o.customerId || null, o.to || null, String(o.subject || "").slice(0, 200),
       info.messageId || null, String(info.response || "").slice(0, 300),
       !!o.ok, o.error ? String(o.error).slice(0, 300) : null]);
  } catch (e) { console.error("email log", e.message); }
}

// Same payload shape as POST /api/mrtv/ledger/orders (inserted directly so
// the provision click needs no HTTP-to-self).
async function postLedgerOrder(o) {
  const grossC = o.grossC, feeC = o.feeC, netC = grossC - feeC;
  await getPool().query(
    "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('order', $1::jsonb, $2)",
    [JSON.stringify({ customer: o.customer, date: o.date, gross_c: grossC, fee_c: feeC, net_c: netC, credits: o.credits, plan: o.plan }),
     cleanStr(o.note, 300)]);
}

function mountMrtvProvision(app, authRequired) {
  const needPg = (req, res) => {
    if (!pgEnabled()) { res.status(503).json({ error: "unavailable (Postgres not configured)" }); return true; }
    return false;
  };

  // SMTP check for the login-email sender: verifies the connection + auth
  // without sending anything. Reports which mailbox the login email
  // currently sends from.
  app.get("/api/mrtv/email/check", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const ml = mailer();
      if (!ml) return res.json({ ok: false, from: null, error: "SMTP not configured on server" });
      await ml.verify();
      res.json({ ok: true, from: loginFrom() });
    } catch (e) { res.json({ ok: false, from: loginFrom(), error: String(e.message || e).slice(0, 200) }); }
  });

  // Sent-mail log: newest first, cap 100.
  app.get("/api/mrtv/email/log", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        "SELECT id, created_at, kind, customer_id, to_email, subject, message_id, smtp_response, ok, error FROM mrtv_email_log ORDER BY created_at DESC LIMIT 100");
      res.json({ log: rows.map((r) => ({
        id: r.id, at: r.created_at ? r.created_at.toISOString() : null, kind: r.kind,
        customerId: r.customer_id, to: r.to_email, subject: r.subject,
        messageId: r.message_id, smtpResponse: r.smtp_response, ok: r.ok, error: r.error,
      })) });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Panel reseller status: credits display + key check.
  app.get("/api/mrtv/panel/status", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const d = await panelCall({ action: "reseller_info" });
      const credits = Number(d.credits) || 0;
      res.json({ ok: true, configured: true, credits: credits, enabled: d.enabled == 1, username: d.username, low: credits < LOW_CREDIT_WARN });
    } catch (e) {
      if (e.code === "NO_KEY") return res.json({ ok: false, configured: false, error: e.message });
      res.status(502).json({ ok: false, configured: true, error: e.message });
    }
  });

  // "Mark paid & provision": create one panel line per TV, store creds,
  // send the login email, fire the ledger order. All-or-nothing: any
  // failed create stops the run and flags the customer for manual finish
  // (no email, no ledger entry on a partial run).
  app.post("/api/mrtv/customers/:id/provision", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      const c = rows[0];
      if (!panelKey()) return res.status(400).json({ error: "TVPLUS_API_KEY is not set in the Render env — add it, then redeploy." });
      if (c.provisioned_at) return res.status(400).json({ error: "already provisioned — use Renew line for the next cycle" });

      const tvs = Math.max(1, Math.min(10, c.tv_count || 1));
      const sub = c.plan === "monthly" ? 1 : 12;
      const sel = packFor(c.package || "usa", !!c.adult_ok);
      if (sel.flag === "custom-package") {
        const reason = "Select-countries package has no template — provision manually in the panel.";
        await getPool().query("UPDATE mrtv_customers SET needs_manual = $1 WHERE id = $2", [reason, c.id]);
        return res.json({ ok: false, manual: true, reason: reason });
      }
      const pack = sel.pack;
      const manualFlags = [];

      const lines = [];
      for (let i = 0; i < tvs; i++) {
        try {
          const d = await panelCall({ action: "new", type: "m3u", sub: String(sub), pack: String(pack), note: c.name });
          const creds = credsFromNewResponse(d);
          if (!creds) throw new Error("panel returned no credentials (saw: " + JSON.stringify(d).slice(0, 160) + ")");
          lines.push({ tv: i + 1, type: "m3u", sub: sub, pack: pack, username: creds.username, password: creds.password, user_id: d.user_id || null, demo: false, created_at: new Date().toISOString() });
        } catch (e) {
          const reason = "Panel create failed on TV " + (i + 1) + " of " + tvs + ": " + e.message + " — finish by hand in the panel.";
          await getPool().query("UPDATE mrtv_customers SET lines = $1::jsonb, needs_manual = $2 WHERE id = $3",
            [JSON.stringify(lines), reason, c.id]);
          return res.status(502).json({ ok: false, partial: true, created: lines.length, of: tvs, error: e.message });
        }
      }

      // Login email (skipped when there's no email on file — Ryan sends it by hand).
      let emailSent = false, emailError = null;
      const firstName = String(c.name || "").split(" ")[0] || "there";
      const endIso = c.end_date ? c.end_date.toISOString().slice(0, 10) : "";
      const orderCode = "MR-" + String(c.id).slice(0, 8).toUpperCase();
      const tvWord = tvs === 1 ? "1 TV" : tvs + " TVs";
      const planDesc = tvWord + " — " + (c.renewal_amount_cents != null
        ? "$" + (c.renewal_amount_cents / 100).toFixed(2).replace(/\.00$/, "") + "/" + (c.plan === "monthly" ? "month" : "year")
        : c.plan);
      if (c.email) {
        const filled = fillLoginEmail(LOGIN_TEMPLATE, {
          firstName: firstName, planDesc: planDesc, expiry: fmtLongDate(endIso),
          tvLines: lines, serverUrl: lineServer(),
          tivimateEmail: c.tivimate_bundle ? c.email : null, orderCode: orderCode,
        });
        const ml = mailer();
        if (!ml) {
          emailError = "SMTP not configured on server";
        } else {
          try {
            const info = await ml.sendMail({
              from: loginFrom(),
              replyTo: "tv@apexkingdigital.com",
              to: c.email, subject: filled.subject, text: filled.text,
            });
            emailSent = true;
            await logEmail({ kind: "provision_login", customerId: c.id, to: c.email, subject: filled.subject, info: info, ok: true });
          } catch (e) {
            emailError = String(e.message || e).slice(0, 160);
            await logEmail({ kind: "provision_login", customerId: c.id, to: c.email, subject: filled.subject, ok: false, error: emailError });
          }
        }
      } else {
        manualFlags.push("No email on file — line(s) created; send the logins to the customer by hand.");
      }
      if (emailError) manualFlags.push("Login email failed to send: " + emailError + " — send the logins by hand.");

      // Ledger order on the same click (Cash App 2.75% fee). Guarded by
      // ledger_posted_for so a re-click can't double-post.
      let ledgerPosted = false;
      const endKey = endIso || null;
      if (c.renewal_amount_cents != null && endKey &&
          (!c.ledger_posted_for || c.ledger_posted_for.toISOString().slice(0, 10) !== endKey)) {
        const grossC = c.renewal_amount_cents;
        const feeC = Math.round(grossC * 0.0275);
        await postLedgerOrder({
          customer: c.name, date: nyToday(), grossC: grossC, feeC: feeC,
          credits: tvs * sub, plan: c.plan, note: "Provisioned sale (auto) — " + orderCode,
        });
        await getPool().query("UPDATE mrtv_customers SET ledger_posted_for = $1 WHERE id = $2", [endKey, c.id]);
        ledgerPosted = true;
      }

      const needsManual = manualFlags.join(" ");
      await getPool().query(
        "UPDATE mrtv_customers SET lines = $1::jsonb, provisioned_at = now(), needs_manual = $2 WHERE id = $3",
        [JSON.stringify(lines), needsManual, c.id]);
      res.json({
        ok: true, tvs: tvs,
        lines: lines.map((l) => ({ tv: l.tv, username: l.username, password: l.password })),
        emailSent: emailSent, ledgerPosted: ledgerPosted,
        needsManual: needsManual || null, orderCode: orderCode,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Renew every non-demo line for one more plan period (Ryan clicks this
  // after the renewal money lands and he hits "Renewal paid").
  app.post("/api/mrtv/customers/:id/renew-line", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query("SELECT id, plan, lines FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      if (!panelKey()) return res.status(400).json({ error: "TVPLUS_API_KEY is not set in the Render env — add it, then redeploy." });
      const c = rows[0];
      const lines = Array.isArray(c.lines) ? c.lines : [];
      const live = lines.filter((l) => !l.demo);
      if (!live.length) return res.status(400).json({ error: "no provisioned lines to renew" });
      const sub = c.plan === "monthly" ? 1 : 12;
      const results = [];
      for (const l of live) {
        try {
          await panelCall({ action: "renew", type: l.type || "m3u", username: l.username, password: l.password, sub: String(sub) });
          l.renewed_at = new Date().toISOString();
          results.push({ tv: l.tv, ok: true });
        } catch (e) { results.push({ tv: l.tv, ok: false, error: e.message }); }
      }
      await getPool().query("UPDATE mrtv_customers SET lines = $1::jsonb WHERE id = $2", [JSON.stringify(lines), c.id]);
      res.json({ ok: results.every((r) => r.ok), results: results });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Demo line (sub=99, ~24h). Ticket mechanics still unconfirmed — the
  // response says so, and the button carries the same note. Accepts
  // { pack, note, send_email }: pack must be one of the four templates
  // (default USA no-adult); send_email fires the standard login email
  // (demo wording, 24h expiry) to the customer's email via tv@.
  app.post("/api/mrtv/customers/:id/demo", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query("SELECT id, name, email, lines FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      if (!panelKey()) return res.status(400).json({ error: "TVPLUS_API_KEY is not set in the Render env — add it, then redeploy." });
      const c = rows[0];
      const b = req.body || {};
      const pack = [PACK_USA_ADULT, PACK_USA_NO_ADULT, PACK_ALL_NO_ADULT, PACK_ALL_ADULT].indexOf(Number(b.pack)) >= 0
        ? Number(b.pack) : PACK_USA_NO_ADULT;
      const note = cleanStr(b.note, 200) || ("DEMO " + c.name);
      const d = await panelCall({ action: "new", type: "m3u", sub: "99", pack: String(pack), note: note });
      const creds = credsFromNewResponse(d);
      if (!creds) throw new Error("panel returned no credentials (saw: " + JSON.stringify(d).slice(0, 160) + ")");
      const username = creds.username, password = creds.password;
      const lines = Array.isArray(c.lines) ? c.lines : [];
      lines.push({ tv: "demo", type: "m3u", sub: 99, pack: pack, username: username, password: password, user_id: d.user_id || null, demo: true, note: note, created_at: new Date().toISOString() });
      await getPool().query("UPDATE mrtv_customers SET lines = $1::jsonb WHERE id = $2", [JSON.stringify(lines), c.id]);
      let emailSent = false, emailError = null;
      if (b.send_email) {
        if (!c.email) { emailError = "no email on file"; }
        else {
          const filled = fillLoginEmail(LOGIN_TEMPLATE, {
            firstName: String(c.name || "").split(" ")[0] || "there",
            planDesc: "Demo — 24 hours",
            expiry: fmtLongDate(addDaysISO(nyToday(), 1)),
            tvLines: [{ username: username, password: password }],
            serverUrl: lineServer(), tivimateEmail: null,
            orderCode: "MR-" + String(c.id).slice(0, 8).toUpperCase(),
          });
          const ml = mailer();
          if (!ml) { emailError = "SMTP not configured on server"; }
          else {
            try {
              const info = await ml.sendMail({ from: loginFrom(), replyTo: "tv@apexkingdigital.com", to: c.email, subject: filled.subject, text: filled.text });
              emailSent = true;
              await logEmail({ kind: "demo_login", customerId: c.id, to: c.email, subject: filled.subject, info: info, ok: true });
            } catch (e) {
              emailError = String(e.message || e).slice(0, 160);
              await logEmail({ kind: "demo_login", customerId: c.id, to: c.email, subject: filled.subject, ok: false, error: emailError });
            }
          }
        }
      }
      res.json({
        ok: true, username: username, password: password, pack: pack,
        emailSent: emailSent, emailError: emailError,
        warn: "Demo ticket mechanics are still unconfirmed with the parent — verify the panel's demo ticket count after creating demos.",
      });
    } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
  });
}

module.exports = { mountMrtvProvision, fillLoginEmail, packFor, LOGIN_TEMPLATE, logEmail };

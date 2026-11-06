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
function lineServer() { return process.env.LINE_SERVER_URL || "http://line.watchmrtv.com"; }
function cleanStr(s, n) { return String(s || "").trim().slice(0, n || 200); }
function nyToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function addMonthsISO(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function addYearsISO(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000); }
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

// Telegram ping (Ryan 2026-11-03): renewal requests ping Ryan's phone.
// Env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID on the Render service.
// Skips silently when either is missing; never throws — callers use the
// returned object to decide what to log.
async function sendTelegramPing(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return { ok: false, skipped: true, reason: "not configured" };
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text || "").slice(0, 4000) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false)
      return { ok: false, error: String((j && j.description) || ("HTTP " + r.status)).slice(0, 160) };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; }
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

// Live panel credit balance (reseller_info). Throws NO_KEY / panel errors.
// Used by the profit-split ledger so credits come from the panel, never
// from the ledger replay (Ryan 2026-11-06).
async function getPanelCredits() {
  const d = await panelCall({ action: "reseller_info" });
  return Number(d.credits) || 0;
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
  "Server URL (every TV): http://line.watchmrtv.com",
  "",
  "MR TV APP \u2014 Downloader code: 6317874",
  "Open the Downloader app, enter 6317874, install MR TV, then sign in with the logins above.",
  "",
  "SETUP (about 5 minutes, step-by-step):",
  "https://watchmrtv.com/app/",
  "",
  "Quick version: install our free MR TV app on your TV/device \u2014 get it at watchmrtv.com/app (on Samsung, LG, iPhone or newer Vega-OS Firesticks, use IPTV Smarters instead), choose \u201cLogin with Xtream Codes API\u201d (not the M3U playlist option), and type your username, password, and the server URL exactly as shown above. Use one login per TV \u2014 one login plays on one screen at a time.",
  "",
  "",
  "Stuck anywhere? Ask in our Telegram group (Mon\u2013Fri, 9am\u20139pm EST) and we\u2019ll walk you through it:",
  "[TELEGRAM_URL]",
  "",
  "Heads up: mail from our new address sometimes lands in spam or promotions at first \u2014 if a renewal reminder goes missing, check there.",
  "",
  "Thanks for joining M.R. TV \u2014 enjoy!",
  "\u2014 M.R. TV",
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
  s = s.split("http://line.watchmrtv.com").join(o.serverUrl);
  s = s.split("[MR-####]").join(o.orderCode);
  const tgUrl = "https://t.me/watchmrtv";
  s = s.split("[TELEGRAM_URL]").join(tgUrl);
  return { subject: subject, text: s.replace(/\n{3,}/g, "\n\n").trim() + "\n", html: buildLoginEmailHtml(o) };
}

// Branded HTML version of the login email — dark theme matching watchmrtv.com.
// o: { firstName, planDesc, expiry, tvLines, serverUrl, orderCode }. Returns HTML string.
function buildLoginEmailHtml(o) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const font = "font-family:Arial,Helvetica,sans-serif;";
  const tgUrl = "https://t.me/watchmrtv";
  const tvCards = o.tvLines.map((l, i) =>
    '<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#17191c;border:1px solid #2c3036;border-radius:10px;margin:0 0 12px;">' +
    '<tr><td style="padding:16px 18px;">' +
    '<div style="' + font + 'font-size:13px;font-weight:bold;color:#c9ced6;letter-spacing:1px;margin-bottom:10px;">TV ' + (i + 1) + '</div>' +
    '<div style="' + font + 'font-size:12px;color:#8a919c;margin-bottom:4px;">Username</div>' +
    '<div style="font-family:monospace,monospace;font-size:16px;color:#f3f5f8;background:#0d0e10;border:1px solid #2c3036;border-radius:6px;padding:10px 12px;margin-bottom:12px;word-break:break-all;">' + esc(l.username) + '</div>' +
    '<div style="' + font + 'font-size:12px;color:#8a919c;margin-bottom:4px;">Password</div>' +
    '<div style="font-family:monospace,monospace;font-size:16px;color:#f3f5f8;background:#0d0e10;border:1px solid #2c3036;border-radius:6px;padding:10px 12px;word-break:break-all;">' + esc(l.password) + '</div>' +
    '</td></tr></table>').join("");
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:#0d0e10;">' +
  '<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#0d0e10;"><tr><td align="center" style="padding:36px 16px;">' +
  '<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;">' +
  '<tr><td align="center" style="padding:0 0 28px;"><img src="https://watchmrtv.com/logo.png" width="110" alt="M.R. TV" style="display:block;width:110px;max-width:110px;height:auto;"></td></tr>' +
  '<tr><td style="' + font + 'color:#f3f5f8;font-size:20px;font-weight:bold;padding:0 0 8px;">Hi ' + esc(o.firstName) + ' \u2014 you\u2019re all set!</td></tr>' +
  '<tr><td style="' + font + 'color:#c9ced6;font-size:15px;padding:0 0 20px;">Here are your M.R. TV logins.</td></tr>' +
  '<tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#17191c;border:1px solid #2c3036;border-radius:10px;margin:0 0 20px;"><tr><td style="padding:16px 18px;' + font + 'color:#f3f5f8;font-size:15px;"><strong>Your plan:</strong> ' + esc(o.planDesc) + '<br><span style="color:#8a919c;font-size:13px;">Good through: ' + esc(o.expiry) + '</span></td></tr></table></td></tr>' +
  '<tr><td>' + tvCards + '</td></tr>' +
  '<tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#17191c;border:1px solid #2c3036;border-radius:10px;margin:0 0 20px;"><tr><td style="padding:16px 18px;' + font + '"><div style="font-size:12px;color:#8a919c;margin-bottom:4px;">Server URL (every TV)</div><div style="font-family:monospace,monospace;font-size:15px;color:#f3f5f8;word-break:break-all;">' + esc(o.serverUrl) + '</div></td></tr></table></td></tr>' +
  '<tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#17191c;border:1px solid #2c3036;border-radius:10px;margin:0 0 20px;"><tr><td style="padding:16px 18px;' + font + '"><div style="font-size:12px;color:#8a919c;margin-bottom:4px;">M.R. TV app \u2014 Downloader code</div><div style="font-family:monospace,monospace;font-size:20px;font-weight:bold;color:#f3f5f8;word-break:break-all;">6317874</div><div style="font-size:13px;color:#8a919c;margin-top:8px;">Open the Downloader app, enter this code, install MR TV, then sign in with the logins above.</div></td></tr></table></td></tr>' +
  '<tr><td align="center" style="padding:4px 0 20px;"><a href="https://watchmrtv.com/app/" style="display:inline-block;' + font + 'font-size:16px;font-weight:bold;color:#0d0e10;background:#c9ced6;border-radius:8px;padding:14px 32px;text-decoration:none;">Open Setup Guide</a></td></tr>' +
  '<tr><td style="' + font + 'color:#c9ced6;font-size:14px;line-height:1.6;padding:0 0 16px;"><strong style="color:#f3f5f8;">Quick version:</strong> install our free MR TV app on your TV/device \u2014 get it at <a href="https://watchmrtv.com/app/" style="color:#c9ced6;">watchmrtv.com/app</a> (on Samsung, LG, iPhone or newer Vega-OS Firesticks, use IPTV Smarters instead), choose \u201cLogin with Xtream Codes API\u201d (not the M3U playlist option), and type your username, password, and the server URL exactly as shown above. Use one login per TV \u2014 one login plays on one screen at a time.</td></tr>' +
  '<tr><td align="center" style="padding:0 0 8px;"><a href="' + tgUrl + '" style="display:inline-block;' + font + 'font-size:15px;font-weight:bold;color:#0d0e10;background:#c9ced6;border-radius:8px;padding:13px 30px;text-decoration:none;">Join our Telegram group</a></td></tr>' +
  '<tr><td align="center" style="' + font + 'color:#8a919c;font-size:13px;padding:0 0 16px;">between 9am and 9pm EST \u2014 we\u2019ll walk you through it.</td></tr>' +
  '<tr><td style="' + font + 'color:#8a919c;font-size:13px;line-height:1.6;padding:0 0 20px;border-top:1px solid #2c3036;padding-top:16px;">Heads up: mail from our new address sometimes lands in spam or promotions at first \u2014 if a renewal reminder goes missing, check there.</td></tr>' +
  '<tr><td style="' + font + 'color:#f3f5f8;font-size:15px;padding:0 0 4px;">Thanks for joining M.R. TV \u2014 enjoy!</td></tr>' +
  '<tr><td style="' + font + 'color:#8a919c;font-size:14px;">\u2014 M.R. TV</td></tr>' +
  '</table></td></tr></table></body></html>';
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
  const payload = { customer: o.customer, customer_id: o.customerId || null, date: o.date, gross_c: grossC, fee_c: feeC, net_c: netC, credits: o.credits, plan: o.plan };
  // Ryan 2026-11-04: inventory sales pass reserveCredits so the $2/credit
  // reserve is earned on the credits sold even though credits=0 (panel spend
  // already booked as credit_use).
  if (o.reserveCredits !== undefined && o.reserveCredits !== null) payload.reserve_credits = o.reserveCredits | 0;
  await getPool().query(
    "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('order', $1::jsonb, $2)",
    [JSON.stringify(payload),
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

  // TEST ONLY: send a Telegram ping to the configured chat. Proves the
  // renewal-request ping will reach Ryan before the 2.0 flow goes live.
  app.post("/api/mrtv/telegram/test", authRequired, async (req, res) => {
    const r = await sendTelegramPing("M.R. TV Telegram test — if you got this, renewal pings will reach you here.");
    res.json(r);
  });

  // DIAG ONLY: verify the bot token (getMe) and check whether the configured
  // chat has ever talked to the bot (getUpdates). No secrets are returned.
  app.get("/api/mrtv/telegram/diag", authRequired, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    const chatId = String(process.env.TELEGRAM_CHAT_ID || "");
    if (!token) return res.json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" });
    try {
      const me = await (await fetch("https://api.telegram.org/bot" + token + "/getMe")).json();
      const up = await (await fetch("https://api.telegram.org/bot" + token + "/getUpdates?limit=20")).json();
      const chats = [];
      for (const u of ((up && up.result) || [])) {
        const c = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat) || null;
        if (c && chats.indexOf(c.id) < 0) chats.push(c.id);
      }
      res.json({
        ok: true,
        bot: me && me.result ? { username: me.result.username, id: me.result.id } : null,
        tokenValid: !!(me && me.ok),
        chatConfigured: chatId ? "(set)" : "(missing)",
        chatSeen: chatId ? chats.indexOf(Number(chatId)) >= 0 : false,
        recentChats: chats,
      });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 160) }); }
  });

  // ADMIN: send a message with a JBG-style inline keyboard (URL buttons) to
  // any chat the bot can reach. Used for the Mister TV group nav bubbles.
  // Body: { chat_id, text, thread_id?, buttons: [[{text, url}, ...], ...] }
  app.post("/api/mrtv/telegram/send", authRequired, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token) return res.json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" });
    try {
      const b = req.body || {};
      const chatId = b.chat_id;
      if (chatId === undefined || chatId === null || chatId === "")
        return res.status(400).json({ ok: false, error: "chat_id required" });
      const text = String(b.text || "").slice(0, 4000);
      if (!text) return res.status(400).json({ ok: false, error: "text required" });
      const rows = Array.isArray(b.buttons) ? b.buttons : [];
      const keyboard = rows.slice(0, 8).map(r =>
        (Array.isArray(r) ? r : []).slice(0, 4).map(btn => ({
          text: String((btn && btn.text) || "Link").slice(0, 64),
          url: String((btn && btn.url) || "https://t.me/").slice(0, 512),
        })).filter(x => x.text && /^https?:\/\//.test(x.url))
      ).filter(r => r.length);
      const payload = { chat_id: chatId, text };
      if (keyboard.length) payload.reply_markup = { inline_keyboard: keyboard };
      const tid = Number(b.thread_id);
      if (Number.isFinite(tid) && tid > 0) payload.message_thread_id = tid;
      const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false)
        return res.json({ ok: false, error: String((j && j.description) || ("HTTP " + r.status)).slice(0, 160) });
      const sent = j.result || {};
      res.json({
        ok: true,
        message_id: sent.message_id,
        chat: sent.chat ? { id: sent.chat.id, title: sent.chat.title, type: sent.chat.type } : null,
      });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 160) }); }
  });

  // ADMIN: replace the inline keyboard on a bot-sent message (editMessageReplyMarkup).
  // Body: { chat_id, message_id, buttons: [[{text, url}, ...], ...] }
  app.post("/api/mrtv/telegram/edit-buttons", authRequired, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token) return res.json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" });
    try {
      const b = req.body || {};
      const chatId = b.chat_id, messageId = Number(b.message_id);
      if ((chatId === undefined || chatId === null || chatId === "") || !Number.isFinite(messageId))
        return res.status(400).json({ ok: false, error: "chat_id and message_id required" });
      const rows = Array.isArray(b.buttons) ? b.buttons : [];
      const keyboard = rows.slice(0, 8).map(r =>
        (Array.isArray(r) ? r : []).slice(0, 4).map(btn => ({
          text: String((btn && btn.text) || "Link").slice(0, 64),
          url: String((btn && btn.url) || "https://t.me/").slice(0, 512),
        })).filter(x => x.text && /^https?:\/\//.test(x.url))
      ).filter(r => r.length);
      const r = await fetch("https://api.telegram.org/bot" + token + "/editMessageReplyMarkup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId,
          reply_markup: { inline_keyboard: keyboard } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false)
        return res.json({ ok: false, error: String((j && j.description) || ("HTTP " + r.status)).slice(0, 160) });
      res.json({ ok: true, message_id: messageId });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 160) }); }
  });

  // ADMIN DIAG: panel device_info for a line (package/bouquet inspection).
  // Ryan 2026-11-04: verify what package hand-made lines carry.
  // POST body: { username, password } — admin auth only.
  app.post("/api/mrtv/panel/device-info", authRequired, async (req, res) => {
    try {
      const b = req.body || {};
      const u = cleanStr(b.username, 64), p = cleanStr(b.password, 64);
      if (!u || !p) return res.status(400).json({ ok: false, error: "username and password required" });
      const d = await panelCall({ action: "device_info", type: "m3u", username: u, password: p });
      res.json({ ok: true, device: d });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  // WEBSITE-ORDER WEBHOOK (Ryan 2026-11-04): Netlify fires this when a customer
  // submits the watchmrtv.com order form (mrtv-order). It creates a PENDING
  // customer row for Ryan to review — nothing is provisioned, nothing is
  // emailed to the customer. Ryan checks the details, then one-taps
  // "Mark paid & provision". A private Telegram ping goes to Ryan's DM only
  // (never the group). Auth is a shared secret in the query string (?key=),
  // set as MRTV_ORDER_WEBHOOK_SECRET in the Render env — fail closed when
  // unset. Netlify payload: { form_name, data: { field: value } }.
  app.post("/api/mrtv/webhooks/netlify-order", async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const secret = process.env.MRTV_ORDER_WEBHOOK_SECRET || "";
      if (!secret) return res.status(503).json({ ok: false, error: "webhook not configured" });
      if (String(req.query.key || "") !== secret)
        return res.status(403).json({ ok: false, error: "bad key" });
      const p = req.body || {};
      const formName = String(p.form_name || p.formName || "");
      if (formName && formName !== "mrtv-order")
        return res.json({ ok: true, ignored: true, reason: "not an order form" });
      const d = (p.data && typeof p.data === "object") ? p.data : {};
      const hf = (p.human_fields && typeof p.human_fields === "object") ? p.human_fields : {};
      const pick = (k) => (d[k] !== undefined ? d[k] : hf[k]);
      const str = (v) => {
        if (v === undefined || v === null) return "";
        if (Array.isArray(v)) return v.map(x => String(x)).join(", ");
        return String(v);
      };
      const name = cleanStr(str(pick("name")), 120) || cleanStr(str(pick("email")).split("@")[0], 120) || "Website customer";
      const email = cleanStr(str(pick("email")), 120) || null;
      const cell = cleanStr(str(pick("phone")) || str(pick("cell")), 40) || null;
      const tvs = Math.max(1, Math.min(10, parseInt(str(pick("connections")), 10) || 1));
      const period = String(str(pick("billing_period")) || "Yearly").toLowerCase();
      const plan = period.indexOf("month") >= 0 ? "monthly" : "yearly";
      const toCents = (v) => { const n = parseFloat(String(v || "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : null; };
      const totalC = toCents(pick("total_due"));
      const planC = toCents(pick("plan_price"));
      const amountC = totalC !== null ? totalC : planC;
      const pkgRaw = String(str(pick("channel_package")) || "");
      const pkg = pkgRaw === "All countries" ? "all" : (pkgRaw === "Select countries" ? "custom" : "usa");
      const adultRaw = str(pick("adult_channels"));
      const adult = adultRaw !== "" && adultRaw.toLowerCase() !== "no" && adultRaw.toLowerCase() !== "false";
      const payMethod = cleanStr(str(pick("payment_method")), 60) || "Cash App";
      const formCode = cleanStr(str(pick("order_code")), 40);

      // Dedupe: Netlify retries must not create a second row for one order.
      if (formCode) {
        const { rows: dup } = await getPool().query(
          "SELECT id FROM mrtv_customers WHERE order_code = $1", [formCode]);
        if (dup.length) return res.json({ ok: true, deduped: true, id: dup[0].id });
      }

      const start = nyToday();
      const end = plan === "monthly" ? addMonthsISO(start, 1) : addYearsISO(start, 1);
      const noteParts = ["🌐 WEBSITE ORDER — REVIEW BEFORE PROVISIONING"];
      noteParts.push("Payment: " + payMethod);
      if (amountC !== null) noteParts.push("Total due: $" + (amountC / 100).toFixed(2).replace(/\.00$/, ""));
      const devices = str(pick("devices"));
      if (devices) noteParts.push("Devices: " + devices);
      const countries = str(pick("custom_countries"));
      if (countries) noteParts.push("Countries: " + countries);
      const ref = str(pick("referred_by"));
      if (ref) noteParts.push("Referred by: " + ref);
      const deliv = str(pick("delivery_preference"));
      if (deliv) noteParts.push("Delivery: " + deliv);
      const custNotes = str(pick("notes"));
      if (custNotes) noteParts.push("Customer notes: " + custNotes);
      const notes = noteParts.join("\n");
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_customers (name, email, cell, plan, start_date, end_date, notes, renewal_amount_cents, tv_count, package, adult_ok, source, payment_method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'website',$12) RETURNING id",
        [name, email, cell, plan, start, end, notes, amountC, tvs, pkg, adult, payMethod]);
      const id = rows[0].id;
      const code = formCode || ("MR-" + String(id).slice(0, 8).toUpperCase());
      await getPool().query("UPDATE mrtv_customers SET order_code = $1 WHERE id = $2", [code, id]);

      // Private ping to Ryan's DM only — never the group.
      await sendTelegramPing("🛒 New website order: " + name + " — " + tvs + " TV" + (tvs === 1 ? "" : "s") + ", " + plan +
        (amountC !== null ? ", $" + (amountC / 100).toFixed(2).replace(/\.00$/, "") : "") + " via " + payMethod +
        ", code " + code + ". Review in the dashboard, then Mark paid & provision.");
      res.json({ ok: true, id: id, order_code: code });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });

  // ADMIN: raw panel API probe (undocumented actions). Ryan 2026-11-04:
  // the panel UI Refund button errors — trying the API route for the same op.
  // POST body: { action, params: { k: v } } — admin auth only.
  app.post("/api/mrtv/panel/raw", authRequired, async (req, res) => {
    try {
      const b = req.body || {};
      const action = cleanStr(b.action, 40);
      if (!action) return res.status(400).json({ ok: false, error: "action required" });
      const params = { action };
      for (const [k, v] of Object.entries(b.params || {})) {
        if (/^[a-z_]+$/.test(k)) params[k] = String(v).slice(0, 128);
      }
      const d = await panelCall(params);
      res.json({ ok: true, result: d });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });

  // TEST ONLY: send a filled login email to an arbitrary address via the
  // normal template + mailer. Creates no panel line and no customer record.
  app.post("/api/mrtv/email/test-send", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const to = cleanStr(b.to, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "valid 'to' email required" });
      const tvLines = (Array.isArray(b.tvLines) ? b.tvLines : []).slice(0, 10)
        .map((l) => ({ username: cleanStr(l && l.username, 60) || "test", password: cleanStr(l && l.password, 60) || "test" }));
      if (!tvLines.length) tvLines.push({ username: "test", password: "test" });
      const filled = fillLoginEmail(LOGIN_TEMPLATE, {
        firstName: cleanStr(b.firstName, 40) || "there",
        planDesc: cleanStr(b.planDesc, 80) || "test",
        expiry: cleanStr(b.expiry, 40) || "",
        tvLines: tvLines,
        serverUrl: cleanStr(b.serverUrl, 120) || lineServer(),
        tivimateEmail: null,
        orderCode: cleanStr(b.orderCode, 24) || "MR-TEST",
      });
      const ml = mailer();
      if (!ml) return res.status(500).json({ error: "SMTP not configured on server" });
      const subject = "[TEST] " + filled.subject;
      const info = await ml.sendMail({ from: loginFrom(), replyTo: "tv@watchmrtv.com", to: to, subject: subject, text: filled.text, html: filled.html });
      try { await logEmail({ kind: "test", customer_id: null, to_email: to, subject: subject, message_id: info.messageId || null, smtp_response: String(info.response || "").slice(0, 500), ok: true, error: null }); } catch (e) {}
      res.json({ ok: true, to: to });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
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
          // country=US is undocumented (device_info shows 2-letter codes like
          // "NL"). If the panel rejects it, the provision fails loudly with
          // the panel's message and gets flagged for manual finish.
          const d = await panelCall({ action: "new", type: "m3u", sub: String(sub), pack: String(pack), note: c.name, country: "US" });
          const creds = credsFromNewResponse(d);
          if (!creds) throw new Error("panel returned no credentials (saw: " + JSON.stringify(d).slice(0, 160) + ")");
          lines.push({ tv: i + 1, type: "m3u", sub: sub, pack: pack, username: creds.username, password: creds.password, user_id: d.user_id || null, demo: false, server: lineServer(), created_at: new Date().toISOString() });
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
      const orderCode = c.order_code || ("MR-" + String(c.id).slice(0, 8).toUpperCase());
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
              replyTo: "tv@watchmrtv.com",
              to: c.email, subject: filled.subject, text: filled.text, html: filled.html,
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
        // Ryan 2026-11-04: crypto is direct-to-wallet — no processor fee.
        // Cash App keeps the 2.75% fee. payment_method comes from the website
        // order form (NULL = dashboard-added = Cash App behavior).
        const feeC = String(c.payment_method || "").toLowerCase().indexOf("crypto") >= 0 ? 0 : Math.round(grossC * 0.0275);
        await postLedgerOrder({
          customer: c.name, customerId: c.id, date: nyToday(), grossC: grossC, feeC: feeC,
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

  // Resend the login email (Ryan 2026-11-01): customer lost the original —
  // re-sends username/password for the lines on file. Uses the server the
  // lines were provisioned on: stamped per line since 2026-11-01; older rows
  // fall back to the 2026-10-30 server flip date (pre-flip = tvdeluxe.us).
  // Shared: build + send the branded login email for a customer row that has
  // linked lines. Returns { ok:true, to, serverUrl } or { ok:false, error, code }.
  async function sendLoginEmail(c) {
    const lines = Array.isArray(c.lines) ? c.lines : [];
    if (!lines.length) return { ok: false, code: 400, error: "no lines on file — provision first" };
    if (!c.email) return { ok: false, code: 400, error: "no email on file for this customer" };
    const ml = mailer();
    if (!ml) return { ok: false, code: 400, error: "SMTP not configured on server" };
    let serverUrl = lines[0].server || lineServer();
    if (!lines[0].server && c.provisioned_at && c.provisioned_at.toISOString() < "2026-10-30T14:53:00Z")
      serverUrl = "http://line.tvdeluxe.us";
    const tvs = lines.length;
    const firstName = String(c.name || "").split(" ")[0] || "there";
    const endIso = c.end_date ? c.end_date.toISOString().slice(0, 10) : "";
    const orderCode = c.order_code || ("MR-" + String(c.id).slice(0, 8).toUpperCase());
    const tvWord = tvs === 1 ? "1 TV" : tvs + " TVs";
    const planDesc = tvWord + " — " + (c.renewal_amount_cents != null
      ? "$" + (c.renewal_amount_cents / 100).toFixed(2).replace(/\.00$/, "") + "/" + (c.plan === "monthly" ? "month" : "year")
      : c.plan);
    const filled = fillLoginEmail(LOGIN_TEMPLATE, {
      firstName: firstName, planDesc: planDesc, expiry: fmtLongDate(endIso),
      tvLines: lines, serverUrl: serverUrl,
      tivimateEmail: c.tivimate_bundle ? c.email : null, orderCode: orderCode,
    });
    try {
      const info = await ml.sendMail({
        from: loginFrom(),
        replyTo: "tv@watchmrtv.com",
        to: c.email, subject: filled.subject, text: filled.text, html: filled.html,
      });
      await logEmail({ kind: "provision_login", customerId: c.id, to: c.email, subject: filled.subject, info: info, ok: true });
    } catch (e) {
      const em = String(e.message || e).slice(0, 160);
      await logEmail({ kind: "provision_login", customerId: c.id, to: c.email, subject: filled.subject, ok: false, error: em });
      return { ok: false, code: 502, error: "send failed: " + em };
    }
    return { ok: true, to: c.email, serverUrl: serverUrl };
  }

  app.post("/api/mrtv/customers/:id/resend-logins", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      const r = await sendLoginEmail(rows[0]);
      if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
      res.json({ ok: true, to: r.to, serverUrl: r.serverUrl });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Backfill panel lines for customers provisioned by hand in the panel
  // (Ryan 2026-11-01): links existing lines into the dashboard so the
  // "Mark paid & provision" trap disappears and detail / resend / renew-line
  // work. Body: { lines: [{tv, username, password, sub?, pack?, server?}],
  // provisioned_at?: "YYYY-MM-DD" }. Never creates panel lines.
  app.post("/api/mrtv/customers/:id/backfill-lines", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      if (!Array.isArray(b.lines) || !b.lines.length)
        return res.status(400).json({ error: "lines array required" });
      const lines = [];
      for (const l of b.lines) {
        const username = cleanStr(l.username, 64), password = cleanStr(l.password, 64);
        if (!username || !password) return res.status(400).json({ error: "each line needs username + password" });
        lines.push({
          tv: Math.max(1, parseInt(l.tv, 10) || 1),
          type: "m3u", sub: parseInt(l.sub, 10) || 12, pack: parseInt(l.pack, 10) || 36930,
          username: username, password: password, user_id: null, demo: false,
          server: cleanStr(l.server, 120) || "http://line.tvdeluxe.us",
          created_at: new Date().toISOString(), backfilled: true,
        });
      }
      const provAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.provisioned_at || "")) ? b.provisioned_at : null;
      const { rows } = await getPool().query(
        "UPDATE mrtv_customers SET lines = $1::jsonb, provisioned_at = COALESCE($2::timestamptz, provisioned_at, now()) WHERE id = $3 RETURNING id, name",
        [JSON.stringify(lines), provAt, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      res.json({ ok: true, id: rows[0].id, name: rows[0].name, lines: lines.length });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Edit an unprovisioned customer order (Ryan 2026-11-05): fix the TV count
  // / renewal amount when a website order comes in wrong (e.g. customer
  // picked 2 TVs but meant 5). Only order fields — never lines, plan dates
  // or provisioning state. Blocked once lines exist (use Renewal paid or
  // backfill for changes after provisioning).
  // Body: { tv_count?, renewal_amount_cents?, notes? }
  app.patch("/api/mrtv/customers/:id", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const { rows } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      const c = rows[0];
      // TV count is locked once lines exist (it must match the panel lines),
      // but name / amount / notes are safe to fix anytime — the name drives
      // every future email, so a wrong name (e.g. Mark vs Mike Thomas)
      // has to be correctable after provisioning.
      const hasLines = Array.isArray(c.lines) && c.lines.length;
      const sets = [], vals = [];
      const push = (col, v) => { vals.push(v); sets.push(col + " = $" + vals.length); };
      if (b.tv_count !== undefined) {
        if (hasLines) return res.status(400).json({ error: "TV count can't be edited after lines exist" });
        const n = parseInt(b.tv_count, 10);
        if (!Number.isInteger(n) || n < 1 || n > 10) return res.status(400).json({ error: "tv_count must be 1-10" });
        push("tv_count", n);
      }
      if (b.name !== undefined) {
        const nm = cleanStr(b.name, 120);
        if (!nm) return res.status(400).json({ error: "name required" });
        push("name", nm);
      }
      if (b.renewal_amount_cents !== undefined) {
        const amt = Math.round(Number(b.renewal_amount_cents));
        if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: "renewal_amount_cents must be >= 0" });
        push("renewal_amount_cents", amt);
      }
      if (b.notes !== undefined) push("notes", cleanStr(b.notes, 2000));
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      vals.push(req.params.id);
      await getPool().query("UPDATE mrtv_customers SET " + sets.join(", ") + " WHERE id = $" + vals.length, vals);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Sell from inventory (Ryan 2026-11-04): link EXISTING panel lines to a new
  // customer — no new panel lines created, no new credits spent. One tap:
  // verify each line exists via panel device_info (fail fast) → link →
  // send the login email automatically → post the ledger sale with credits=0
  // (the panel spend was already booked as credit_use) while still earning
  // the $2/credit reserve on the credits sold via reserve_credits.
  // Body: { lines: [{username, password}], gross_cents, fee_cents? }
  app.post("/api/mrtv/customers/:id/provision-inventory", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const { rows } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      const c = rows[0];
      if (Array.isArray(c.lines) && c.lines.length)
        return res.status(400).json({ error: "customer already has lines — use Renewal paid" });
      if (!Array.isArray(b.lines) || !b.lines.length)
        return res.status(400).json({ error: "lines array required" });
      const grossC = Math.round(Number(b.gross_cents) || 0);
      if (!(grossC > 0)) return res.status(400).json({ error: "a paid amount is required" });
      if (!panelKey()) return res.status(400).json({ error: "TVPLUS_API_KEY is not set in the Render env" });

      // 1. Verify each line exists in the panel — abort before touching anything.
      const linked = [];
      let n = 0;
      for (const l of b.lines) {
        const username = cleanStr(l.username, 64), password = cleanStr(l.password, 64);
        if (!username || !password) return res.status(400).json({ error: "each line needs username + password" });
        try {
          await panelCall({ action: "device_info", type: "m3u", username: username, password: password });
        } catch (e) {
          return res.status(502).json({ error: "panel line not found: " + username + " — " + String(e.message || e).slice(0, 100) });
        }
        n++;
        linked.push({
          tv: n, type: "m3u", sub: 12, pack: 36929, username: username, password: password,
          user_id: null, demo: false, server: "http://line.watchmrtv.com",
          created_at: new Date().toISOString(), inventory: true,
        });
      }

      // 2. Link the lines + mark provisioned.
      await getPool().query(
        "UPDATE mrtv_customers SET lines = $1::jsonb, provisioned_at = now(), tv_count = $2 WHERE id = $3",
        [JSON.stringify(linked), linked.length, c.id]);

      // 3. Login email, automatically.
      const { rows: rows2 } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [c.id]);
      const em = await sendLoginEmail(rows2[0]);
      if (!em.ok) return res.status(em.code || 502).json({ error: "lines linked, but email failed: " + em.error });

      // 4. Ledger sale: credits=0 (no new panel spend), reserve on credits sold.
      const feeC = (b.fee_cents === undefined || b.fee_cents === "") ? Math.round(grossC * 0.0275) : Math.round(Number(b.fee_cents) || 0);
      const tvs = linked.length;
      await postLedgerOrder({
        customer: c.name, customerId: c.id, date: nyToday(),
        grossC: grossC, feeC: feeC, credits: 0, reserveCredits: 12 * tvs,
        plan: c.plan || "yearly",
        note: "Inventory sale — existing panel lines, no new credits spent (" + (c.order_code || c.id.slice(0, 8).toUpperCase()) + ")",
      });
      await getPool().query("UPDATE mrtv_customers SET ledger_posted_for = $1 WHERE id = $2", [nyToday(), c.id]);

      res.json({ ok: true, to: em.to, tvs: tvs, serverUrl: em.serverUrl });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // One-tap renewal (Ryan 2026-11-01): "Renewal paid" does everything —
  // 1. renews the panel lines for one more period (spends credits; aborts
  //    before touching anything else if any line fails),
  // 2. rolls the dashboard end_date forward one plan period,
  // 3. posts the ledger order (Cash App 2.75% fee), guarded by
  //    ledger_posted_for so a re-click can't double-post.
  // Body: { gross_cents } — the amount the customer actually paid (Ryan can
  // lower it for win-back discounts).
  app.post("/api/mrtv/customers/:id/renew", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const grossC = Math.round(Number(b.gross_cents) || 0);
      if (!(grossC > 0)) return res.status(400).json({ error: "a paid amount is required" });
      const { rows } = await getPool().query(
        "SELECT id, name, plan, tv_count, end_date, order_code, lines, ledger_posted_for, payment_method FROM mrtv_customers WHERE id = $1",
        [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      const c = rows[0];
      const lines = Array.isArray(c.lines) ? c.lines : [];
      const live = lines.filter((l) => !l.demo);
      if (!live.length) return res.status(400).json({ error: "no provisioned lines to renew — use Mark paid & provision first" });
      if (!panelKey()) return res.status(400).json({ error: "TVPLUS_API_KEY is not set in the Render env" });
      const sub = c.plan === "monthly" ? 1 : 12;

      // 1. Panel renew first — if any line fails, nothing else changes.
      const results = [];
      for (const l of live) {
        try {
          await panelCall({ action: "renew", type: l.type || "m3u", username: l.username, password: l.password, sub: String(sub) });
          l.renewed_at = new Date().toISOString();
          results.push({ tv: l.tv, ok: true });
        } catch (e) { results.push({ tv: l.tv, ok: false, error: String(e.message || e).slice(0, 120) }); }
      }
      const bad = results.filter((r) => !r.ok);
      if (bad.length) return res.status(502).json({ error: "panel renew failed — nothing else was changed: " + bad.map((r) => "TV " + r.tv + ": " + r.error).join("; ") });
      await getPool().query("UPDATE mrtv_customers SET lines = $1::jsonb WHERE id = $2", [JSON.stringify(lines), c.id]);

      // 2. Roll the dashboard date (also revives archived/dormant).
      const endIso = c.end_date ? c.end_date.toISOString().slice(0, 10) : nyToday();
      const next = c.plan === "monthly" ? addMonthsISO(endIso, 1) : addYearsISO(endIso, 1);
      const u = await getPool().query(
        "UPDATE mrtv_customers SET end_date = $1, archived_at = NULL, archive_reason = NULL WHERE id = $2 RETURNING end_date",
        [next, c.id]);
      const newEnd = u.rows[0].end_date.toISOString().slice(0, 10);

      // 3. Ledger order (same shape as the provision flow).
      let ledgerPosted = false;
      const lpIso = c.ledger_posted_for ? c.ledger_posted_for.toISOString().slice(0, 10) : null;
      if (lpIso !== newEnd) {
        // Ryan 2026-11-04: crypto renewals carry no processor fee either.
        const feeC = String(c.payment_method || "").toLowerCase().indexOf("crypto") >= 0 ? 0 : Math.round(grossC * 0.0275);
        const orderCode = c.order_code || ("MR-" + String(c.id).slice(0, 8).toUpperCase());
        await postLedgerOrder({
          customer: c.name, customerId: c.id, date: nyToday(), grossC: grossC, feeC: feeC,
          credits: (c.tv_count || 1) * sub, plan: c.plan,
          note: "Renewal (one-tap) — " + orderCode,
        });
        await getPool().query("UPDATE mrtv_customers SET ledger_posted_for = $1 WHERE id = $2", [newEnd, c.id]);
        ledgerPosted = true;
      }
      res.json({ ok: true, endDate: newEnd, daysLeft: daysBetween(nyToday(), newEnd), ledgerPosted: ledgerPosted, panel: results });
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
      // DISABLED 2026-10-29 (Ryan): demos are off the table — viability in
      // question after the live demo showed no channels. The dashboard
      // button is gone too; remove this guard to re-enable.
      // RE-ENABLE CONVENTION (Ryan 2026-10-29): demo lines' Notes read
      // "demo <name>" (e.g. "demo Mark Walker") — customer-name pattern
      // with a demo prefix.
      return res.status(403).json({ error: "Demo lines are disabled." });
      const { rows } = await getPool().query("SELECT id, name, email, lines FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      if (!panelKey()) return res.status(400).json({ error: "TVPLUS_API_KEY is not set in the Render env — add it, then redeploy." });
      const c = rows[0];
      const b = req.body || {};
      const pack = [PACK_USA_ADULT, PACK_USA_NO_ADULT, PACK_ALL_NO_ADULT, PACK_ALL_ADULT].indexOf(Number(b.pack)) >= 0
        ? Number(b.pack) : PACK_USA_NO_ADULT;
      const note = cleanStr(b.note, 200) || ("demo " + c.name);
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
            orderCode: c.order_code || ("MR-" + String(c.id).slice(0, 8).toUpperCase()),
          });
          const ml = mailer();
          if (!ml) { emailError = "SMTP not configured on server"; }
          else {
            try {
              const info = await ml.sendMail({ from: loginFrom(), replyTo: "tv@watchmrtv.com", to: c.email, subject: filled.subject, text: filled.text, html: filled.html });
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

module.exports = { mountMrtvProvision, fillLoginEmail, packFor, LOGIN_TEMPLATE, logEmail, sendTelegramPing, getPanelCredits };

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

// Referrer DM (Ryan 2026-11-23, option B): a bot can only DM users who
// have started it. Referrers met us through the ORDER bot (@WatchMRTV_bot,
// the mini app), so the DM goes out on MRTV_TG_BOT_TOKEN when set,
// falling back to TELEGRAM_BOT_TOKEN (renewals bot — only reaches users
// who started that bot). Never throws; a failed DM is silent — the
// free-month email still goes out.
async function sendReferrerDm(chatId, text) {
  const tokens = [];
  const tgTok = process.env.MRTV_TG_BOT_TOKEN || "";
  const mainTok = process.env.TELEGRAM_BOT_TOKEN || "";
  if (tgTok) tokens.push(tgTok);
  if (mainTok && mainTok !== tgTok) tokens.push(mainTok);
  for (const token of tokens) {
    try {
      const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: String(chatId), text: String(text || "").slice(0, 4000) }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok !== false) return { ok: true };
    } catch (e) { /* try the next token */ }
  }
  return { ok: false };
}

// Customer DM (Ryan 2026-11-28): "you're ready" on provision + renewal
// reminders for customers who ordered through the mini app. Same
// dual-token path as sendReferrerDm (mini-app bot first, renewals bot as
// fallback), plus optional sendMessage extras (buttons). Reaches only
// customers whose row carries telegram_chat_id. Never throws; a failed
// DM must never break provisioning or renewals.
async function sendCustomerTgDm(chatId, text, extra) {
  const tokens = [];
  const tgTok = process.env.MRTV_TG_BOT_TOKEN || "";
  const mainTok = process.env.TELEGRAM_BOT_TOKEN || "";
  if (tgTok) tokens.push(tgTok);
  if (mainTok && mainTok !== tgTok) tokens.push(mainTok);
  if (!tokens.length || !chatId) return { ok: false, skipped: true, reason: "not configured" };
  let lastErr = "";
  for (const token of tokens) {
    try {
      const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ chat_id: chatId, text: String(text || "").slice(0, 4000) }, extra || {})),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok !== false) return { ok: true };
      lastErr = String((j && j.description) || ("HTTP " + r.status)).slice(0, 160);
    } catch (e) { lastErr = String(e.message || e).slice(0, 160); }
  }
  return { ok: false, error: lastErr };
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
  "MR TV APP \u2014 two Downloader codes, pick the one that fits your device:",
  "MR TV Mobile (older devices, phones and tablets, Android 5.1+) \u2014 Downloader code 6317874.",
  "MR TV 2.0 (newer devices \u2014 Fire Sticks except Vega OS, Google TV, Android TV, Android 7+) \u2014 Downloader code 7537688. Some Android 6 devices work too \u2014 if it won\u2019t install, use Mobile instead.",
  "Open the Downloader app, enter your code, install MR TV, then sign in with the logins above.",
  "On newer Vega-OS Firesticks (4K Select, newer HD/4K) Downloader doesn\u2019t work at all \u2014 install IPTV Smarters Pro from the Amazon Appstore instead.",
  "",
  "YOUR REFERRAL CODE: [MR-####]",
  "Your link: watchmrtv.com/?ref=[MR-####]",
  "Share it with a friend \u2014 when they sign up with your code, you earn a free month.",
  "",
  "SETUP (about 5 minutes, step-by-step):",
  "https://watchmrtv.com/app/",
  "New to the app? How to use it \u2014 favorites, TV guide, recording: https://watchmrtv.com/app/#watch",
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
// serverUrl, orderCode }.
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
  '<tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#17191c;border:1px solid #2c3036;border-radius:10px;margin:0 0 20px;"><tr><td style="padding:16px 18px;' + font + '"><div style="font-size:12px;color:#8a919c;margin-bottom:4px;">M.R. TV app \u2014 Downloader codes (pick the one that fits your device)</div><div style="font-size:13px;color:#c9ced6;margin-bottom:4px;">MR TV Mobile \u2014 older devices, phones and tablets, Android 5.1+</div><div style="font-family:monospace,monospace;font-size:20px;font-weight:bold;color:#f3f5f8;word-break:break-all;margin-bottom:12px;">6317874</div><div style="font-size:13px;color:#c9ced6;margin-bottom:4px;">MR TV 2.0 \u2014 newer devices, Fire Sticks except Vega OS, Google TV, Android TV, Android 7+ (some Android 6 work too)</div><div style="font-family:monospace,monospace;font-size:20px;font-weight:bold;color:#f3f5f8;word-break:break-all;">7537688</div><div style="font-size:13px;color:#8a919c;margin-top:8px;">Open the Downloader app, enter your code, install MR TV, then sign in with the logins above. On newer Vega-OS Firesticks Downloader doesn\u2019t work at all \u2014 install IPTV Smarters Pro from the Amazon Appstore instead.</div></td></tr></table></td></tr>' +
  '<tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#17191c;border:1px solid #2c3036;border-radius:10px;margin:0 0 20px;"><tr><td style="padding:16px 18px;' + font + '"><div style="font-size:12px;color:#8a919c;margin-bottom:4px;">Your referral code</div><div style="font-family:monospace,monospace;font-size:20px;font-weight:bold;color:#f3f5f8;word-break:break-all;">' + esc(o.orderCode) + '</div><div style="font-size:13px;color:#8a919c;margin-top:8px;">Your link: <a href="https://watchmrtv.com/?ref=' + esc(o.orderCode) + '" style="color:#c9ced6;">watchmrtv.com/?ref=' + esc(o.orderCode) + '</a></div><div style="font-size:13px;color:#8a919c;margin-top:8px;">Share it with a friend \u2014 when they sign up with your code, you earn a free month.</div></td></tr></table></td></tr>' +
  '<tr><td align="center" style="padding:4px 0 20px;"><a href="https://watchmrtv.com/app/" style="display:inline-block;' + font + 'font-size:16px;font-weight:bold;color:#0d0e10;background:#c9ced6;border-radius:8px;padding:14px 32px;text-decoration:none;">Open Setup Guide</a></td></tr>' +
  '<tr><td align="center" style="' + font + 'color:#8a919c;font-size:13px;padding:0 0 20px;">New to the app? <a href="https://watchmrtv.com/app/#watch" style="color:#c9ced6;">How to use it \u2014 favorites, TV guide, recording</a></td></tr>' +
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

// Referral free months — auto-apply (Ryan 2026-11-06): each referral banks
// 1 free month. 30 days before a customer's expiry, the daily renewals/run
// applies ALL banked months at once: renews each live panel line in 1-month
// steps (sub=1 is always valid; the API only lists 1,3,6,12, so arbitrary
// counts are done as repeated 1-month renews), extends the dashboard
// end_date by that many months, marks them applied, and emails the customer.
// Panel credits are checked first — if there aren't enough, the customer is
// skipped (months stay banked) and the error is reported. A failed line
// renew aborts that customer with nothing changed. Exported for the daily
// renewals/run in home.js. Returns { applied, skipped, errors }.
async function applyReferralMonths() {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const today = nyToday();
  const out = { applied: [], skipped: [], errors: [] };
  try {
    if (!pgEnabled()) { out.errors.push("no DB"); return out; }
    const { rows } = await getPool().query(
      "SELECT id, name, email, plan, end_date, tv_count, lines, referral_months_applied, order_code " +
      "FROM mrtv_customers WHERE end_date IS NOT NULL AND lines IS NOT NULL");
    const refCount = {};
    const rc = await getPool().query(
      "SELECT referred_by_customer_id, COUNT(*) AS n FROM mrtv_customers WHERE referred_by_customer_id IS NOT NULL GROUP BY referred_by_customer_id");
    for (const r of rc.rows) refCount[r.referred_by_customer_id] = parseInt(r.n, 10);
    if (!panelKey()) { out.errors.push("TVPLUS_API_KEY is not set in the Render env"); return out; }
    const ml = mailer();
    for (const c of rows) {
      const endIso = c.end_date ? c.end_date.toISOString().slice(0, 10) : null;
      if (!endIso) continue;
      const dl = daysBetween(today, endIso);
      if (dl <= 0 || dl > 30) continue; // only inside the 30-day window
      const earned = refCount[c.id] || 0;
      const applied = c.referral_months_applied || 0;
      const unapplied = earned - applied;
      if (unapplied <= 0) continue;
      const lines = Array.isArray(c.lines) ? c.lines : [];
      const live = lines.filter((l) => !l.demo);
      if (!live.length) { out.skipped.push(c.name + ": no provisioned lines"); continue; }
      const need = live.length * unapplied;
      let credits = null;
      try { credits = await getPanelCredits(); } catch (e) { credits = null; }
      if (credits === null || credits === undefined) { out.errors.push(c.name + ": could not read panel credits"); continue; }
      if (credits < need) { out.errors.push(c.name + ": only " + credits + " panel credits, need " + need + " for " + unapplied + " free month" + (unapplied === 1 ? "" : "s")); continue; }
      // Renew each live line in 1-month steps. If any renew fails, abort
      // this customer with nothing changed (months stay banked).
      let ok = true, failMsg = "";
      for (const l of live) {
        for (let i = 0; i < unapplied; i++) {
          try {
            await panelCall({ action: "renew", type: l.type || "m3u", username: l.username, password: l.password, sub: "1" });
          } catch (e) { ok = false; failMsg = String(e.message || e).slice(0, 120); break; }
        }
        if (!ok) break;
        l.renewed_at = new Date().toISOString();
      }
      if (!ok) { out.errors.push(c.name + ": panel renew failed — " + failMsg); continue; }
      const newEnd = addMonthsISO(endIso, unapplied);
      await getPool().query("UPDATE mrtv_customers SET lines = $1::jsonb, end_date = $2, referral_months_applied = $3, archived_at = NULL, archive_reason = NULL WHERE id = $4",
        [JSON.stringify(lines), newEnd, applied + unapplied, c.id]);
      // Ledger: the free months cost panel credits — record as credit_use so
      // the ledger tracks the spend (no money moves; it's a referral reward).
      try {
        await getPool().query(
          "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('credit_use', $1::jsonb, $2)",
          [JSON.stringify({ credits: need }), "Referral free months — " + c.name + " (" + unapplied + " month" + (unapplied === 1 ? "" : "s") + ")"]);
      } catch (e) { console.error("referral ledger", e.message); }
      // Notify the customer.
      const first = String(c.name || "").split(" ")[0] || "there";
      const subject = "Good news — your referrals earned you " + unapplied + " free month" + (unapplied === 1 ? "" : "s") + " \uD83C\uDF89";
      const text =
        "Hi " + first + ",\n\n" +
        "Your referrals earned you " + unapplied + " free month" + (unapplied === 1 ? "" : "s") + " of M.R. TV — no payment needed.\n\n" +
        "Your plan now runs through " + fmtLongDate(newEnd) + ".\n\n" +
        "Keep sharing your referral code (" + (c.order_code || "") + ") and you'll keep earning free months.\n\n" +
        "Thanks,\nM.R. TV";
      const html =
        "<p>Hi " + esc(first) + ",</p>" +
        "<p>Your referrals earned you <strong>" + unapplied + " free month" + (unapplied === 1 ? "" : "s") + "</strong> of M.R. TV — no payment needed.</p>" +
        "<p>Your plan now runs through <strong>" + esc(fmtLongDate(newEnd)) + "</strong>.</p>" +
        "<p>Keep sharing your referral code (<code>" + esc(c.order_code || "") + "</code>) and you'll keep earning free months.</p>" +
        "<p>Thanks,<br>M.R. TV</p>";
      if (c.email && ml) {
        try {
          const info = await ml.sendMail({ from: loginFrom(), replyTo: "tv@watchmrtv.com", to: c.email, subject: subject, text: text, html: html });
          try { await logEmail({ kind: "referral", customerId: c.id, to: c.email, subject: subject, info: info, ok: true }); } catch (le) { console.error("email log", le.message); }
        } catch (e) {
          const em = String(e.message || e).slice(0, 120);
          out.errors.push(c.name + ": email failed — " + em);
          try { await logEmail({ kind: "referral", customerId: c.id, to: c.email, subject: subject, ok: false, error: em }); } catch (le) { console.error("email log", le.message); }
        }
      } else if (!c.email) {
        out.errors.push(c.name + ": no email on file — months applied, no notification sent");
      }
      out.applied.push({ id: c.id, name: c.name, months: unapplied, credits: need, newEnd: newEnd });
    }
  } catch (e) {
    out.errors.push("applyReferralMonths: " + String(e.message || e).slice(0, 200));
  }
  return out;
}

// --- MRTV group moderation (Ryan 2026-11-17) ------------------------------------
// Mister TV group ONLY (MRTV_GROUP_CHAT_ID, -1003857000698, verified in code).
// 1) Join-time ban check, 2) username required to join, 3) no links at all,
// 4) /ban + /unban (admin-only). Nothing here touches the mini-app order
// flow (db/mrtv-tg-app.js), provisioning/renewal emails, the welcome text or
// buttons, or the Netlify order webhook DM pings.
//
// Ban list: a dedicated MRTV Postgres table (mrtv_bans, see db/schema.sql),
// separate from any Helix list. It is deliberately NOT gated on
// USE_POSTGRES: that flag is the Phase-1 dual-write cutover for order data,
// while this list must exist wherever DATABASE_URL exists. The table is
// created on first use (CREATE TABLE IF NOT EXISTS). If Postgres is
// unreachable the join flow must not break (db/pg.js: a PG failure must
// never break a user-facing request), so lookups fail open (the welcome
// proceeds) and the in-process cache below keeps /ban working for the life
// of the process. The cache is a fallback only, never the store of record.
const MRTV_BANS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mrtv_bans (" +
  "id UUID PRIMARY KEY DEFAULT gen_random_uuid(), " +
  "telegram_user_id BIGINT, " +
  "username TEXT, " +
  "first_name TEXT, " +
  "reason TEXT, " +
  "banned_by BIGINT, " +
  "banned_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
  ");" +
  "CREATE UNIQUE INDEX IF NOT EXISTS mrtv_bans_user_id_idx ON mrtv_bans (telegram_user_id);" +
  "CREATE UNIQUE INDEX IF NOT EXISTS mrtv_bans_username_idx ON mrtv_bans (lower(username));";
const _mrtvBanCache = { byId: new Map(), byUsername: new Map() };
let _mrtvBansTableReady = false;

function mrtvRyanUserId() {
  // Ryan's DM chat id (TELEGRAM_CHAT_ID) is his Telegram user id: in a DM,
  // chat.id == the user's id. There is no other Ryan id in the codebase.
  const n = Number(process.env.TELEGRAM_CHAT_ID || "");
  return Number.isFinite(n) && n !== 0 ? n : null;
}
function mrtvIsRyan(user) {
  const ryan = mrtvRyanUserId();
  return !!ryan && !!user && Number(user.id) === ryan;
}
function mrtvLabel(user) {
  if (!user) return "unknown user";
  const name = (user.first_name || "") + (user.last_name ? " " + user.last_name : "");
  const at = user.username ? " (@" + user.username + ")" : "";
  return (name.trim() || "user " + user.id) + at + " [id " + user.id + "]";
}
function mrtvNormUsername(u) {
  return u ? String(u).trim().replace(/^@/, "").toLowerCase() : "";
}

// Minimal Telegram Bot API call, following the sendTelegramPing() pattern
// (global fetch, TELEGRAM_BOT_TOKEN, JSON body, never throws).
async function mrtvTg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) return { ok: false, skipped: true };
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    return j && typeof j.ok === "boolean" ? j : { ok: r.ok, result: j };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
async function mrtvTgSendGroup(text, extra) {
  return mrtvTg("sendMessage", Object.assign({ chat_id: MRTV_GROUP_CHAT_ID, text: text }, extra || {}));
}
async function mrtvTgGetChatMember(userId) {
  const j = await mrtvTg("getChatMember", { chat_id: MRTV_GROUP_CHAT_ID, user_id: userId });
  return j && j.ok && j.result ? j.result : null;
}
async function mrtvIsGroupAdmin(userId) {
  const member = await mrtvTgGetChatMember(userId);
  return !!member && (member.status === "creator" || member.status === "administrator");
}

// --- MRTV ban list store (Postgres mrtv_bans + in-process cache) -------------
async function ensureMrtvBansTable() {
  if (_mrtvBansTableReady) return true;
  let pool;
  try { pool = getPool(); } catch (e) { return false; }
  try {
    await pool.query(MRTV_BANS_TABLE_SQL);
    _mrtvBansTableReady = true;
    return true;
  } catch (e) {
    console.error("[mrtv] bans table ensure failed:", e && e.message ? e.message : e);
    return false;
  }
}
function mrtvBanCachePut(entry) {
  if (!entry) return;
  if (entry.telegram_user_id) _mrtvBanCache.byId.set(Number(entry.telegram_user_id), entry);
  if (entry.username) _mrtvBanCache.byUsername.set(mrtvNormUsername(entry.username), entry);
}
function mrtvBanCacheDrop(userId, username) {
  if (userId) _mrtvBanCache.byId.delete(Number(userId));
  if (username) _mrtvBanCache.byUsername.delete(mrtvNormUsername(username));
}
// Join-time lookup. Matches by Telegram user id OR by username, so a
// username-only /ban (no id resolvable via the Bot API) still bites when
// that user next joins. Never throws; on any Postgres failure returns
// not-banned so a join is never blocked by a DB outage.
async function mrtvBanLookup(user) {
  const userId = user && user.id ? Number(user.id) : null;
  const username = mrtvNormUsername(user && user.username);
  const cached = (userId && _mrtvBanCache.byId.get(userId)) ||
    (username && _mrtvBanCache.byUsername.get(username)) || null;
  if (cached) return { banned: true, reason: cached.reason || null, via: "cache" };
  if (!(await ensureMrtvBansTable())) return { banned: false, reason: null, via: null };
  let pool;
  try { pool = getPool(); } catch (e) { return { banned: false, reason: null, via: null }; }
  try {
    const r = await pool.query(
      "SELECT telegram_user_id, username, reason FROM mrtv_bans " +
      "WHERE telegram_user_id = $1 OR (username IS NOT NULL AND lower(username) = $2) LIMIT 1",
      [userId, username || null]
    );
    if (!r.rows.length) return { banned: false, reason: null, via: null };
    const row = r.rows[0];
    mrtvBanCachePut(row);
    return { banned: true, reason: row.reason || null, via: row.telegram_user_id && Number(row.telegram_user_id) === userId ? "id" : "username" };
  } catch (e) {
    console.error("[mrtv] ban lookup failed:", e && e.message ? e.message : e);
    return { banned: false, reason: null, via: null };
  }
}
async function mrtvBanAdd(target, bannedBy) {
  const entry = {
    telegram_user_id: target.userId || null,
    username: target.username ? mrtvNormUsername(target.username) : null,
    first_name: target.firstName || null,
    reason: target.reason || null,
    banned_by: bannedBy || null,
  };
  mrtvBanCachePut(entry);
  if (!(await ensureMrtvBansTable())) return { ok: true, persisted: false };
  let pool;
  try { pool = getPool(); } catch (e) { return { ok: true, persisted: false }; }
  try {
    if (entry.telegram_user_id) {
      await pool.query(
        "INSERT INTO mrtv_bans (telegram_user_id, username, first_name, reason, banned_by) " +
        "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (telegram_user_id) DO UPDATE SET " +
        "username = COALESCE(EXCLUDED.username, mrtv_bans.username), " +
        "first_name = COALESCE(EXCLUDED.first_name, mrtv_bans.first_name), " +
        "reason = COALESCE(EXCLUDED.reason, mrtv_bans.reason), " +
        "banned_by = COALESCE(EXCLUDED.banned_by, mrtv_bans.banned_by), banned_at = now()",
        [entry.telegram_user_id, entry.username, entry.first_name, entry.reason, entry.banned_by]
      );
    } else if (entry.username) {
      const existing = await pool.query("SELECT id FROM mrtv_bans WHERE lower(username) = $1 LIMIT 1", [entry.username]);
      if (existing.rows.length) {
        await pool.query(
          "UPDATE mrtv_bans SET first_name = COALESCE($2, first_name), reason = COALESCE($3, reason), " +
          "banned_by = COALESCE($4, banned_by), banned_at = now() WHERE lower(username) = $1",
          [entry.username, entry.first_name, entry.reason, entry.banned_by]
        );
      } else {
        await pool.query(
          "INSERT INTO mrtv_bans (username, first_name, reason, banned_by) VALUES ($1, $2, $3, $4)",
          [entry.username, entry.first_name, entry.reason, entry.banned_by]
        );
      }
    } else {
      return { ok: false, persisted: false };
    }
    return { ok: true, persisted: true };
  } catch (e) {
    console.error("[mrtv] ban add failed:", e && e.message ? e.message : e);
    return { ok: true, persisted: false };
  }
}
async function mrtvBanRemove(target) {
  mrtvBanCacheDrop(target.userId, target.username);
  if (!(await ensureMrtvBansTable())) return { ok: true, persisted: false, removed: false };
  let pool;
  try { pool = getPool(); } catch (e) { return { ok: true, persisted: false, removed: false }; }
  try {
    const r = await pool.query(
      "DELETE FROM mrtv_bans WHERE telegram_user_id = $1 OR (username IS NOT NULL AND lower(username) = $2)",
      [target.userId || null, target.username ? mrtvNormUsername(target.username) : null]
    );
    return { ok: true, persisted: true, removed: (r.rowCount || 0) > 0 };
  } catch (e) {
    console.error("[mrtv] ban remove failed:", e && e.message ? e.message : e);
    return { ok: true, persisted: false, removed: false };
  }
}

// Group id, module scope so the helpers above can use it. Verified in the
// webhook below (was -1003857000698, the "Mister TV" group); the duplicate
// declaration that used to live inside mountMrtvProvision is removed.
const MRTV_GROUP_CHAT_ID = -1003857000698;

// --- Link rule + /ban + /unban ------------------------------------------------
// A link is any url/text_link entity, or text matching the usual link
// shapes (http/https, www., t.me, discord.gg, discord.com/invite).
const MRTV_LINK_RE = /(?:https?:\/\/|www\.)[^\s]+|t\.me\/[^\s]+|discord\.gg\/[^\s]+|discord\.com\/invite\/[^\s]+/i;
function mrtvHasLink(msg) {
  if (!msg) return false;
  const text = msg.text || msg.caption || "";
  const entities = msg.entities || msg.caption_entities || [];
  if (entities.some((e) => e && (e.type === "url" || e.type === "text_link"))) return true;
  return MRTV_LINK_RE.test(text);
}
function mrtvCommand(msg) {
  const text = (msg && msg.text) || "";
  if (!text.startsWith("/")) return null;
  const firstWord = text.split(/\s+/)[0] || "";
  const cmd = firstWord.split("@")[0].toLowerCase();
  if (cmd !== "/ban" && cmd !== "/unban") return null;
  const rest = text.slice(firstWord.length).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  return { cmd: cmd, targetArg: parts[0] || "", reason: parts.slice(1).join(" ") || null };
}
// Resolve a /ban or /unban target: reply first, then a text_mention entity
// (user picked from a list), then @username or a numeric user id. The Bot
// API has no lookup-by-username, so an @username target carries no id:
// it is stored by username and enforced when that user next joins.
function mrtvBanTarget(msg, targetArg) {
  const replied = msg && msg.reply_to_message && msg.reply_to_message.from;
  if (replied && replied.id) {
    return { userId: Number(replied.id), username: replied.username || null, firstName: replied.first_name || null, isBot: !!replied.is_bot, via: "reply" };
  }
  const entities = (msg && msg.entities) || [];
  for (const e of entities) {
    if (e && e.type === "text_mention" && e.user && e.user.id) {
      return { userId: Number(e.user.id), username: e.user.username || null, firstName: e.user.first_name || null, isBot: !!e.user.is_bot, via: "mention" };
    }
  }
  if (!targetArg) return null;
  if (/^\d+$/.test(targetArg)) return { userId: Number(targetArg), username: null, firstName: null, isBot: false, via: "id" };
  const name = mrtvNormUsername(targetArg);
  if (/^[a-z0-9_]{5,32}$/.test(name)) return { userId: null, username: name, firstName: null, isBot: false, via: "username" };
  return null;
}
// Ryan's username, resolved once via getChat on his DM id, so /ban
// @<ryans-username> can be refused too (his id alone does not cover it).
let _mrtvRyanUsername = null;
async function mrtvRyanUsername() {
  if (_mrtvRyanUsername !== null) return _mrtvRyanUsername;
  const ryan = mrtvRyanUserId();
  if (!ryan) { _mrtvRyanUsername = false; return false; }
  const j = await mrtvTg("getChat", { chat_id: ryan });
  _mrtvRyanUsername = j && j.ok && j.result && j.result.username ? mrtvNormUsername(j.result.username) : false;
  return _mrtvRyanUsername;
}

// Per-member join checks, in order: ban list, then username. Returns true
// when the member may stay (and be welcomed), false when removed. Ryan is
// never removed; bots are filtered out by the webhook before this runs.
// A moderation error fails open (the member stays) so a bug or outage can
// never block legitimate joins.
async function mrtvModerateJoin(msg, member) {
  try {
    if (mrtvIsRyan(member)) return true;
    const ban = await mrtvBanLookup(member);
    if (ban.banned) {
      await mrtvTg("banChatMember", { chat_id: MRTV_GROUP_CHAT_ID, user_id: member.id });
      await sendTelegramPing("\uD83D\uDEAB MRTV: banned user tried to rejoin and was removed: " + mrtvLabel(member) + (ban.reason ? " \u2014 reason: " + ban.reason : "") + ".");
      return false;
    }
    if (!member.username) {
      await mrtvTg("banChatMember", { chat_id: MRTV_GROUP_CHAT_ID, user_id: member.id });
      await mrtvTg("unbanChatMember", { chat_id: MRTV_GROUP_CHAT_ID, user_id: member.id });
      const notice = "\u26A0\uFE0F @" + (member.first_name || "New member") + " was removed \u2014 a Telegram username is required to join. Set one in Telegram Settings and come back!";
      const extra = {};
      if (msg && msg.message_thread_id) extra.message_thread_id = msg.message_thread_id;
      await mrtvTgSendGroup(notice, extra);
      await sendTelegramPing("\u26A0\uFE0F MRTV: " + mrtvLabel(member) + " was removed on join \u2014 no Telegram username.");
      return false;
    }
    return true;
  } catch (e) {
    console.error("[mrtv] join moderation failed:", e && e.message ? e.message : e);
    return true;
  }
}
// Silent link deletion. Exempt: Ryan, group admins/creator, bots, channel
// posts (sender_chat / no .from) and commands (handled before this runs).
// If the admin lookup fails we delete anyway: Ryan is already exempt
// above, and a failed lookup must not let a link stand.
async function mrtvHandleLinkMessage(msg) {
  const from = (msg && msg.from) || {};
  if (!from.id || from.is_bot) return false;
  if (msg.sender_chat) return false;
  // Commands are exempt from the link rule (any command, not just /ban).
  if ((msg.text || "").startsWith("/")) return false;
  if (mrtvIsRyan(from)) return false;
  if (!mrtvHasLink(msg)) return false;
  if (await mrtvIsGroupAdmin(from.id)) return false;
  const r = await mrtvTg("deleteMessage", { chat_id: MRTV_GROUP_CHAT_ID, message_id: msg.message_id });
  return !!(r && r.ok);
}
// /ban + /unban: admin-only (Ryan or a group admin/creator), in-group.
// Non-admins get no reply at all. /ban adds to the MRTV ban list AND bans
// immediately; /unban removes from the list AND unbans. Ryan and bots are
// never banned. A username-only target (no id resolvable via the Bot API)
// is stored by username and enforced when that user next joins.
async function mrtvHandleCommand(msg, command) {
  const from = (msg && msg.from) || {};
  if (!from.id || from.is_bot) return;
  if (!mrtvIsRyan(from) && !(await mrtvIsGroupAdmin(from.id))) return;
  const target = mrtvBanTarget(msg, command.targetArg);
  const replyExtra = { reply_to_message_id: msg.message_id };
  if (!target || (!target.userId && !target.username)) {
    await mrtvTgSendGroup("Usage: reply to a message with /ban or /unban, or use /ban @username (or /unban @username).", replyExtra);
    return;
  }
  if (target.userId && mrtvIsRyan({ id: target.userId })) {
    await mrtvTgSendGroup("Ryan can't be banned.", replyExtra);
    return;
  }
  if (target.username) {
    const ryanName = await mrtvRyanUsername();
    if (ryanName && target.username === ryanName) {
      await mrtvTgSendGroup("Ryan can't be banned.", replyExtra);
      return;
    }
  }
  if (target.isBot) {
    await mrtvTgSendGroup("Bots can't be banned.", replyExtra);
    return;
  }
  const label = target.username ? "@" + target.username : target.firstName ? target.firstName : "user " + target.userId;
  if (command.cmd === "/ban") {
    const added = await mrtvBanAdd({ userId: target.userId, username: target.username, firstName: target.firstName, reason: command.reason }, from.id);
    let bannedNow = false;
    if (target.userId) {
      const r = await mrtvTg("banChatMember", { chat_id: MRTV_GROUP_CHAT_ID, user_id: target.userId });
      bannedNow = !!(r && r.ok);
    }
    if (bannedNow) {
      await mrtvTgSendGroup("\uD83D\uDEAB " + label + " has been banned from Mister TV." + (command.reason ? " Reason: " + command.reason : "") + (added.persisted ? "" : " (Note: the ban list could not be saved \u2014 re-run /ban if they rejoin.)"), replyExtra);
    } else if (target.username) {
      await mrtvTgSendGroup("\uD83D\uDEAB @" + target.username + " was added to the MRTV ban list and will be banned if they try to join. (Telegram gives no user ID for an @username, so they can't be banned right now \u2014 reply to one of their messages with /ban to ban them immediately.)" + (added.persisted ? "" : " Note: the ban list could not be saved."), replyExtra);
    } else {
      await mrtvTgSendGroup("Couldn't ban " + label + " right now \u2014 Telegram refused the ban.", replyExtra);
    }
    await sendTelegramPing("\uD83D\uDEAB MRTV: " + mrtvLabel(from) + " banned " + label + (target.userId ? " [id " + target.userId + "]" : "") + (command.reason ? " \u2014 " + command.reason : "") + (bannedNow ? "" : " (not banned in Telegram yet \u2014 username only)") + ".");
  } else {
    const removed = await mrtvBanRemove(target);
    if (target.userId) await mrtvTg("unbanChatMember", { chat_id: MRTV_GROUP_CHAT_ID, user_id: target.userId });
    await mrtvTgSendGroup("\u2705 " + label + " has been unbanned from Mister TV" + (removed.removed ? "." : " (they weren't on the MRTV ban list)."), replyExtra);
    await sendTelegramPing("\u2705 MRTV: " + mrtvLabel(from) + " unbanned " + label + (target.userId ? " [id " + target.userId + "]" : "") + ".");
  }
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

  // ADMIN: create The Lounge topic in the Mister TV group (Ryan
  // 2026-11-28: "You create it"). The bot must be a group admin with
  // topic rights. Stores the new topic id as the Lounge (same store the
  // webhook capture uses) so the bot starts watching it immediately.
  // Body: { name? } — defaults to "🍿 The Lounge".
  app.post("/api/mrtv/telegram/create-lounge", authRequired, async (req, res) => {
    try {
      const name = cleanStr((req.body || {}).name, 60) || "🍿 The Lounge";
      const j = await mrtvTg("createForumTopic", { chat_id: MRTV_GROUP_CHAT_ID, name: name });
      if (!j || !j.ok || !j.result || !j.result.message_thread_id)
        return res.status(502).json({ ok: false, error: String((j && j.description) || "createForumTopic failed").slice(0, 200) });
      const tid = Number(j.result.message_thread_id);
      _loungeThreadId = tid;
      if (await mrtvBotStateReady()) {
        try {
          await getPool().query(
            "INSERT INTO mrtv_bot_state (key, value) VALUES ('lounge_thread_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()",
            [String(tid)]);
        } catch (e) { /* the in-process cache still holds it */ }
      }
      res.json({ ok: true, thread_id: tid, name: name });
    } catch (e) { res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
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

  // TELEGRAM WEBHOOK: auto-welcome for new Mister TV group members (Ryan
  // 2026-11-10: the pinned Start Here message should be the automessage
  // when someone joins — Order button on top, that's the store).
  const WELCOME_TEXT = "Welcome to Mister TV 📺\nTap a button to get around:";
  const WELCOME_BUTTONS = [
    [{ text: "🛒 Order Mister TV", url: "https://t.me/WatchMRTV_bot/MR_TV" }],
    [{ text: "🛠 How-To's", url: "https://t.me/watchmrtv/5" },
     { text: "📺 Channel List", url: "https://t.me/watchmrtv/4" }],
    [{ text: "💬 Support Chat", url: "https://t.me/watchmrtv/1" },
     { text: "🍿 The Lounge", url: "https://t.me/watchmrtv/237" }],
    [{ text: "🌐 watchmrtv.com", url: "https://watchmrtv.com" }],
  ];
  // --- The Lounge (Ryan 2026-11-28) -------------------------------------------
  // A general-chat topic in Mister TV so Support stays support. The bot
  // captures the topic id when a topic whose name contains "Lounge" is
  // created or renamed (forum_topic_created / forum_topic_edited service
  // messages), stored in mrtv_bot_state. In that topic only, the bot:
  // 1) answers common questions with pointers (install, price, renewals,
  // trouble), throttled per user + rule; 2) ribs anyone who pastes a
  // suggestion list of 4+ items. Everywhere else in the group the bot
  // stays silent, exactly as before. All state access fails open: no
  // Postgres, no Lounge replies, never an error in the webhook.
  const MRTV_BOT_STATE_SQL =
    "CREATE TABLE IF NOT EXISTS mrtv_bot_state (" +
    "key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());";
  let _mrtvBotStateReady = false;
  let _loungeThreadId = null;
  const _loungeCooldowns = new Map();

  async function mrtvBotStateReady() {
    if (_mrtvBotStateReady) return true;
    try { await getPool().query(MRTV_BOT_STATE_SQL); _mrtvBotStateReady = true; }
    catch (e) { /* fail open */ }
    return _mrtvBotStateReady;
  }
  async function mrtvLoungeThreadId() {
    if (_loungeThreadId) return _loungeThreadId;
    if (!(await mrtvBotStateReady())) return null;
    try {
      const { rows } = await getPool().query("SELECT value FROM mrtv_bot_state WHERE key = 'lounge_thread_id'");
      if (rows.length && Number(rows[0].value)) _loungeThreadId = Number(rows[0].value);
    } catch (e) { /* fail open */ }
    return _loungeThreadId;
  }
  async function mrtvCaptureLoungeTopic(msg) {
    const info = msg.forum_topic_created || msg.forum_topic_edited || null;
    if (!info || !msg.message_thread_id) return;
    if (!/lounge/i.test(String(info.name || ""))) return;
    _loungeThreadId = Number(msg.message_thread_id);
    if (await mrtvBotStateReady()) {
      try {
        await getPool().query(
          "INSERT INTO mrtv_bot_state (key, value) VALUES ('lounge_thread_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()",
          [String(_loungeThreadId)]);
      } catch (e) { /* the in-process cache still holds it */ }
    }
  }
  function mrtvLoungeCooling(key, ms) {
    const now = Date.now();
    const last = _loungeCooldowns.get(key) || 0;
    if (now - last < ms) return true;
    _loungeCooldowns.set(key, now);
    if (_loungeCooldowns.size > 500) _loungeCooldowns.clear();
    return false;
  }
  const MRTV_LOUNGE_FAQ = [
    { key: "pin", re: /(\bpin\b|parental|kids? mode|lock the|lock it)/i,
      text: "🔒 The PIN lives in the app's parental controls, under Settings. Set one there and you can also hide whole categories from the home screen." },
    { key: "install", re: /(install|set ?up|download|firestick|fire tv|onn stick|downloader|how do i get|app code)/i,
      text: "📺 Setup lives here: https://watchmrtv.com/app/ — Downloader code 7537688 for the MR TV app (MR TV Mobile: 6317874). Step by step, takes about 5 minutes." },
    { key: "renew", re: /(renew|expired|expires|extend|extension|ran out)/i,
      text: "Renewals: you'll get an email before your date (5 days out on monthly plans) with a pay link — pay it, reply to the email, and you're extended. You can also see your days left any time in the 📺 My TV app." },
    { key: "trouble", re: /(buffer|freez|frozen|not working|won'?t load|not loading|channels? (are )?down|black screen|keeps stopping)/i,
      text: "Quick checks first: restart the stick/box, then check your internet speed. Still stuck? Post in 💬 Support with your device and what you were watching — that's the fastest route to a fix." },
    { key: "adult", re: /(adult|xxx|18\+)/i,
      text: "Adult channels only exist on accounts that opted in when they ordered. To hide them, use the parental controls in the app's Settings. Want them off your account completely? Post in 💬 Support and we'll switch your package." },
    { key: "channels", re: /(channels?|countries|lineup|channel list|what sports|international)/i,
      text: "📺 Full lineup is in the Channel List: https://t.me/watchmrtv/4 — 20,500+ live channels, 100,000+ movies & shows, all the major sports. Plans come as USA or All Countries." },
    { key: "devices", re: /(roku|samsung|\blg\b|iphone|ipad|apple tv|what devices|which devices|does it work on)/i,
      text: "Firestick, Android TV, Google TV and Onn sticks use our free app. Samsung, LG and iPhone use IPTV Smarters. Roku TVs need a Firestick or Onn stick plugged in. Full steps: https://watchmrtv.com/app" },
    { key: "price", re: /(price|cost|how much|per month|plans?)/i,
      text: "Plans: monthly $10 for 1 TV, $15 for 2 — yearly $80 for 1 TV, $100 for 2 (best deal), +$25 per extra TV. Full details: https://watchmrtv.com/" }
  ];
  const MRTV_LOUNGE_JOKES = [
    "😄 Easy there — what do you think this is, DirecTV? Suggestions noted, all of them.",
    "📋 That is quite the list. What do you think this is, Spectrum? 😄 Noted!",
    "😅 One more suggestion and we legally become a cable company. List received!",
    "👀 The suggestion box just filed for overtime. 😄 Got 'em — thanks!",
  ];
  function mrtvSuggestionCount(text) {
    let n = 0;
    for (const ln of String(text).split(/\n+/)) if (/^\s*([-*•·]|\d{1,2}[.)])\s+\S/.test(ln)) n++;
    n += (String(text).toLowerCase().match(/you should|should add|please add|can you add|could you add|add more|need to add|suggestion/g) || []).length;
    return n;
  }
  async function mrtvHandleLoungeMessage(msg) {
    try {
      const from = (msg && msg.from) || {};
      if (!from.id || from.is_bot || msg.sender_chat) return false;
      const threadId = await mrtvLoungeThreadId();
      if (!threadId || Number(msg.message_thread_id) !== threadId) return false;
      const text = String(msg.text || "");
      if (!text || text.startsWith("/")) return false;
      const reply = (t) => mrtvTg("sendMessage", { chat_id: MRTV_GROUP_CHAT_ID, message_thread_id: threadId, reply_to_message_id: msg.message_id, text: t });
      // Suggestion-list ribbing: 4+ suggestions in one message.
      if (mrtvSuggestionCount(text) >= 4 && !mrtvLoungeCooling("joke:" + from.id, 60 * 60 * 1000)) {
        const r = await reply(MRTV_LOUNGE_JOKES[Math.floor(Math.random() * MRTV_LOUNGE_JOKES.length)]);
        return !!(r && r.ok);
      }
      // FAQ pointers: only for question-shaped messages.
      const questiony = text.indexOf("?") >= 0 || /^(how|what|can|is|do|does|where|when|why)\b/i.test(text.trim());
      if (!questiony) return false;
      for (const rule of MRTV_LOUNGE_FAQ) {
        if (rule.re.test(text)) {
          if (mrtvLoungeCooling("faq:" + rule.key + ":" + from.id, 30 * 60 * 1000)) return false;
          const r = await reply(rule.text);
          return !!(r && r.ok);
        }
      }
      return false;
    } catch (e) { return false; }
  }

  const _tgSeenUpdateIds = new Set();
  // POST /api/mrtv/telegram/webhook - called by Telegram, no admin auth.
  // Mister TV group moderation lives here: join-time ban check + username
  // requirement (before the welcome), /ban + /unban (admin-only), and the
  // silent no-links rule. The bot's own outgoing messages (the welcome,
  // announcements) are sent by the bot, not incoming updates, so the link
  // rule cannot touch them. Channel posts arrive as update.channel_post,
  // not update.message, and are ignored.
  app.post("/api/mrtv/telegram/webhook", async (req, res) => {
    try {
      const secret = process.env.MRTV_TG_WEBHOOK_SECRET || "";
      if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret)
        return res.status(403).json({ ok: false });
      const update = req.body || {};
      const uid = update.update_id;
      if (uid !== undefined && uid !== null) {
        if (_tgSeenUpdateIds.has(uid)) return res.json({ ok: true, deduped: true });
        _tgSeenUpdateIds.add(uid);
        if (_tgSeenUpdateIds.size > 1000) _tgSeenUpdateIds.clear();
      }
      const msg = update.message || update.edited_message || {};
      if (Number(msg.chat && msg.chat.id) !== MRTV_GROUP_CHAT_ID) return res.json({ ok: true });
      // 0) Lounge topic capture: a topic created or renamed to a name
      // containing "Lounge" becomes the general-chat room (see above).
      // Service messages carry no text, so nothing else applies to them.
      if (msg.forum_topic_created || msg.forum_topic_edited) {
        await mrtvCaptureLoungeTopic(msg);
        return res.json({ ok: true });
      }
      const token = process.env.TELEGRAM_BOT_TOKEN || "";
      // 1) New members: ban check, then username check, then the welcome.
      // The welcome goes out once per update, and only if at least one
      // joining human passed both checks.
      const joined = Array.isArray(msg.new_chat_members) ? msg.new_chat_members : [];
      const humans = joined.filter((u) => u && !u.is_bot);
      if (humans.length) {
        let welcomed = 0;
        for (const member of humans) {
          if (await mrtvModerateJoin(msg, member)) welcomed += 1;
        }
        if (token && welcomed > 0) {
          try {
            await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: MRTV_GROUP_CHAT_ID,
                text: WELCOME_TEXT,
                reply_markup: { inline_keyboard: WELCOME_BUTTONS },
              }),
            });
          } catch (e) { /* welcome send failed */ }
        }
        return res.json({ ok: true, welcomed: welcomed });
      }
      // 2) Admin commands: /ban and /unban only. Anything else starting
      // with "/" is ignored (and is exempt from the link rule below).
      const command = mrtvCommand(msg);
      if (command) {
        await mrtvHandleCommand(msg, command);
        return res.json({ ok: true, command: command.cmd });
      }
      // 3) No links at all in the group, deleted silently. Join/leave
      // service messages have no text/caption, so they pass through here
      // untouched.
      let linkDeleted = false;
      if (msg.text || msg.caption) {
        linkDeleted = await mrtvHandleLinkMessage(msg);
      }
      // 4) The Lounge: FAQ pointers + suggestion-list ribbing, in the
      // captured Lounge topic only, and never on a message the link
      // rule just deleted.
      if (!linkDeleted && msg.text) {
        await mrtvHandleLoungeMessage(msg);
      }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: true }); }
  });


  // ADMIN: point the renewals bot's webhook at this service (one-time setup).
  // POST /api/mrtv/telegram/webhook/set — uses TELEGRAM_BOT_TOKEN from env.
  app.post("/api/mrtv/telegram/webhook/set", authRequired, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token) return res.json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" });
    try {
      const url = "https://apex-dashboard-c0fq.onrender.com/api/mrtv/telegram/webhook";
      const secret = process.env.MRTV_TG_WEBHOOK_SECRET || "";
      const body = { url, allowed_updates: ["message"] };
      if (secret) body.secret_token = secret;
      const r = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false)
        return res.json({ ok: false, error: String((j && j.description) || ("HTTP " + r.status)).slice(0, 160) });
      res.json({ ok: true, url });
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
      // Referral link (Ryan 2026-11-23): the ?ref=MR-#### link pre-fills the
      // referred_by field on the site; accept a bare "ref" field too, in case
      // a form variant posts it under that name.
      const ref = cleanStr(str(pick("referred_by")) || str(pick("ref")), 120);
      // Referral match (Ryan 2026-11-06): the referrer's ORDER CODE is their
      // referral code. If the form value matches a customer's order_code
      // (case-insensitive, spaces stripped), link it. A plain name stays
      // unlinked for Ryan to review — the code is the reliable match.
      let referrerId = null, referrerName = null, referrerCode = null, referrerChatId = null, refIsCode = false;
      if (ref) {
        const code = ref.toUpperCase().replace(/[^A-Z0-9-]/g, "");
        refIsCode = code.indexOf("MR-") === 0;
        if (code) {
          const { rows: m } = await getPool().query(
            "SELECT id, name, order_code, telegram_chat_id FROM mrtv_customers WHERE UPPER(order_code) = $1 LIMIT 1", [code]);
          if (m.length) { referrerId = m[0].id; referrerName = m[0].name; referrerCode = m[0].order_code; referrerChatId = m[0].telegram_chat_id; }
        }
      }
      if (ref) noteParts.push("Referred by: " + ref +
        (referrerName ? " (matched: " + referrerName + ")" : (refIsCode ? " (code not found)" : "")));
      const deliv = str(pick("delivery_preference"));
      if (deliv) noteParts.push("Delivery: " + deliv);
      const custNotes = str(pick("notes"));
      if (custNotes) noteParts.push("Customer notes: " + custNotes);
      const notes = noteParts.join("\n");
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_customers (name, email, cell, plan, start_date, end_date, notes, renewal_amount_cents, tv_count, package, adult_ok, source, payment_method, referred_by, referred_by_customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'website',$12,$13,$14) RETURNING id",
        [name, email, cell, plan, start, end, notes, amountC, tvs, pkg, adult, payMethod, ref || null, referrerId]);
      const id = rows[0].id;
      const code = formCode || ("MR-" + String(id).slice(0, 8).toUpperCase());
      await getPool().query("UPDATE mrtv_customers SET order_code = $1 WHERE id = $2", [code, id]);

      // Private ping to Ryan's DM only — never the group.
      await sendTelegramPing("🛒 New website order: " + name + " — " + tvs + " TV" + (tvs === 1 ? "" : "s") + ", " + plan +
        (amountC !== null ? ", $" + (amountC / 100).toFixed(2).replace(/\.00$/, "") : "") + " via " + payMethod +
        ", code " + code + (referrerName ? ". Referred by " + referrerName + " (" + ref + ")" : "") + ". Review in the dashboard, then Mark paid & provision.");
      // Referrer DM (option B): only when the referrer has a linked Telegram,
      // and never to the buyer themself.
      if (referrerId && referrerId !== id && referrerChatId) {
        await sendReferrerDm(referrerChatId, "🎉 Someone signed up with your code " + (referrerCode || ref) + " — 1 free month banked. Thanks for sharing M.R. TV!");
      }
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

  // BROADCAST (Ryan 2026-11-13): send one HTML email to every
  // non-archived customer, one address at a time (no bulk headers, each
  // send logged as kind 'broadcast'). Body: { subject, html, text?,
  // dryRun?, confirm? }. Live sends require confirm=true; dryRun=true
  // returns the recipient list without sending anything. A 1s pause
  // between sends keeps the mailbox provider happy.
  app.post("/api/mrtv/email/broadcast", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const subject = cleanStr(b.subject, 200);
      const html = typeof b.html === "string" ? b.html : "";
      if (!subject) return res.status(400).json({ ok: false, error: "subject required" });
      if (!html || html.length < 50) return res.status(400).json({ ok: false, error: "html body required" });
      if (html.length > 200000) return res.status(400).json({ ok: false, error: "html body too large" });
      const dryRun = !!b.dryRun;
      if (!dryRun && b.confirm !== true) return res.status(400).json({ ok: false, error: "confirm=true required for a live broadcast" });
      const { rows } = await getPool().query(
        "SELECT id, name, email FROM mrtv_customers WHERE archived_at IS NULL AND email IS NOT NULL ORDER BY created_at ASC");
      const seen = new Set();
      const recipients = [];
      const skipped = [];
      for (const r of rows) {
        const email = String(r.email || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped.push({ name: r.name, email: r.email, reason: "invalid email" }); continue; }
        if (seen.has(email)) { skipped.push({ name: r.name, email: email, reason: "duplicate email" }); continue; }
        seen.add(email);
        recipients.push({ id: r.id, name: r.name, email: email });
      }
      if (dryRun) return res.json({ ok: true, dryRun: true, count: recipients.length, recipients: recipients, skipped: skipped });
      const ml = mailer();
      if (!ml) return res.status(500).json({ ok: false, error: "SMTP not configured on server" });
      const text = (typeof b.text === "string" && b.text) ? b.text
        : html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&mdash;/g, "-").replace(/\s+/g, " ").trim();
      const results = [];
      for (const rcpt of recipients) {
        try {
          const info = await ml.sendMail({ from: loginFrom(), replyTo: "tv@watchmrtv.com", to: rcpt.email, subject: subject, text: text, html: html });
          await logEmail({ kind: "broadcast", customerId: rcpt.id, to: rcpt.email, subject: subject, info: info, ok: true });
          results.push({ email: rcpt.email, ok: true });
        } catch (e) {
          await logEmail({ kind: "broadcast", customerId: rcpt.id, to: rcpt.email, subject: subject, ok: false, error: e.message });
          results.push({ email: rcpt.email, ok: false, error: String(e.message || e).slice(0, 200) });
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      const sent = results.filter((r) => r.ok).length;
      res.json({ ok: true, sent: sent, failed: results.length - sent, results: results, skipped: skipped });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });

  // SEND-ONE (Ryan 2026-11-14): send one custom HTML email to a single
  // address, with an optional BCC. Body: { to, bcc?, subject, html, text? }.
  // Logged as kind 'single'. No customer record required.
  app.post("/api/mrtv/email/send-one", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const to = cleanStr(b.to, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, error: "valid 'to' email required" });
      const bcc = cleanStr(b.bcc, 120);
      if (bcc && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bcc)) return res.status(400).json({ ok: false, error: "valid 'bcc' email required" });
      const subject = cleanStr(b.subject, 200);
      const html = typeof b.html === "string" ? b.html : "";
      if (!subject) return res.status(400).json({ ok: false, error: "subject required" });
      if (!html || html.length < 50) return res.status(400).json({ ok: false, error: "html body required" });
      if (html.length > 200000) return res.status(400).json({ ok: false, error: "html body too large" });
      const ml = mailer();
      if (!ml) return res.status(500).json({ ok: false, error: "SMTP not configured on server" });
      const text = (typeof b.text === "string" && b.text) ? b.text
        : html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&mdash;/g, "-").replace(/\s+/g, " ").trim();
      const msg = { from: loginFrom(), replyTo: "tv@watchmrtv.com", to: to, subject: subject, text: text, html: html };
      if (bcc) msg.bcc = bcc;
      const info = await ml.sendMail(msg);
      try { await logEmail({ kind: "single", customerId: null, to: to, subject: subject, info: info, ok: true }); } catch (e) {}
      res.json({ ok: true, to: to, bcc: bcc || null, messageId: info.messageId || null });
    } catch (e) {
      try { await logEmail({ kind: "single", customerId: null, to: cleanStr((req.body || {}).to, 120), subject: cleanStr((req.body || {}).subject, 200), ok: false, error: e.message }); } catch (e2) {}
      res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
    }
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
          orderCode: orderCode,
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
      // Customer Telegram DM (Ryan 2026-11-28): customers who ordered
      // through Telegram hear "you're ready" from the bot too, not just
      // by email. No logins in the DM — those stay in the email.
      // Best-effort: the result never changes the provision outcome.
      let tgDmSent = false;
      if (c.telegram_chat_id) {
        const dm = await sendCustomerTgDm(c.telegram_chat_id,
          "✅ Your M.R. TV is ready, " + firstName + "!\n\n" +
          "Your logins were sent to your email (" + (c.email || "") + ").\n" +
          "Plan: " + planDesc + " — good through " + fmtLongDate(endIso) + ".\n\n" +
          "Setup guide: https://watchmrtv.com/app/",
          { reply_markup: { inline_keyboard: [[{ text: "📺 Open My TV", web_app: { url: "https://watchmrtv.com/tg-app/" } }]] } });
        tgDmSent = !!dm.ok;
        if (!dm.ok && !dm.skipped) console.error("[mrtv] provision DM failed:", dm.error || "unknown");
      }
      res.json({
        ok: true, tvs: tvs,
        lines: lines.map((l) => ({ tv: l.tv, username: l.username, password: l.password })),
        emailSent: emailSent, tgDmSent: tgDmSent, ledgerPosted: ledgerPosted,
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
      orderCode: orderCode,
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
      // A successful resend clears the "send the logins by hand" flag the
      // provision flow sets when the first send fails.
      try { await getPool().query("UPDATE mrtv_customers SET needs_manual = NULL WHERE id = $1", [req.params.id]); } catch (e) {}
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
      // 2026-11-22: backfill keeps tv_count in sync with lines (was left stale, so a split showed the old count).
      const { rows } = await getPool().query(
        "UPDATE mrtv_customers SET lines = $1::jsonb, provisioned_at = COALESCE($2::timestamptz, provisioned_at, now()), tv_count = $4 WHERE id = $3 RETURNING id, name",
        [JSON.stringify(lines), provAt, req.params.id, lines.length]);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      res.json({ ok: true, id: rows[0].id, name: rows[0].name, lines: lines.length });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // NOTE (2026-11-11): the PATCH /api/mrtv/customers/:id handler that lived
  // here is GONE — mountHome registers home.js's handler first, so this
  // copy never ran (its tv_count lock was dead). The live handler is in
  // db/home.js, which now carries the lines-exist guard.

  // Merge two customer records into one (Ryan 2026-11-06 — April Metcalf
  // came in twice: website order + manual record). The survivor (:id)
  // absorbs the other record's lines; the folded record is deleted.
  // Panel lines are untouched — same logins, same expiry; only the
  // dashboard bookkeeping moves, so renewal becomes one tap at the
  // combined amount. Safeguards: both records must exist, share the same
  // email, and neither may be archived; the folded record must have no
  // referrals pointing at it (its order code dies with it). Runs in a
  // transaction — either the whole merge lands or nothing does.
  // Body: { fromId } (+ optional renewal_amount_cents override; default
  // is the sum of both records' renewal amounts).
  app.post("/api/mrtv/customers/:id/merge", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const fromId = String(b.fromId || "");
      if (!fromId || fromId === req.params.id) return res.status(400).json({ error: "fromId must be a different customer id" });
      const { rows: tRows } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [req.params.id]);
      if (!tRows.length) return res.status(404).json({ error: "customer not found" });
      const { rows: fRows } = await getPool().query("SELECT * FROM mrtv_customers WHERE id = $1", [fromId]);
      if (!fRows.length) return res.status(404).json({ error: "record to merge not found" });
      const t = tRows[0], f = fRows[0];
      if (!t.email || String(t.email).toLowerCase() !== String(f.email || "").toLowerCase())
        return res.status(400).json({ error: "records must share the same email" });
      if (t.archived_at || f.archived_at) return res.status(400).json({ error: "can't merge archived records" });
      const tLines = Array.isArray(t.lines) ? t.lines : [];
      const fLines = Array.isArray(f.lines) ? f.lines : [];
      const { rows: refs } = await getPool().query(
        "SELECT id, name FROM mrtv_customers WHERE referred_by_customer_id = $1", [fromId]);
      if (refs.length) return res.status(400).json({ error: "record has referrals pointing at it (" + refs.map(function (r) { return r.name; }).join(", ") + ")" });
      const mergedLines = tLines.concat(fLines).map(function (ln, i) {
        const copy = Object.assign({}, ln);
        copy.tv = i + 1;
        return copy;
      });
      const amount = b.renewal_amount_cents !== undefined
        ? Math.round(Number(b.renewal_amount_cents))
        : (t.renewal_amount_cents || 0) + (f.renewal_amount_cents || 0);
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "renewal_amount_cents must be >= 0" });
      const fmt$ = function (c) { return "$" + (c / 100).toFixed(2).replace(/\.00$/, ""); };
      const mergeNote = "Merged with " + (f.order_code || f.id.slice(0, 8)) + " on " + new Date().toISOString().slice(0, 10) +
        ": +" + fLines.length + " TVs, renewal " + fmt$(t.renewal_amount_cents || 0) + " → " + fmt$(amount) + ".";
      const notes = cleanStr(((t.notes || "") + "\n" + mergeNote).trim(), 2000);
      const applied = (t.referral_months_applied || 0) + (f.referral_months_applied || 0);
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE mrtv_customers SET lines = $1::jsonb, tv_count = $2, renewal_amount_cents = $3, notes = $4, referral_months_applied = $5 WHERE id = $6",
          [JSON.stringify(mergedLines), mergedLines.length, amount, notes, applied, t.id]);
        await client.query("DELETE FROM mrtv_customers WHERE id = $1", [f.id]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true, id: t.id, tvCount: mergedLines.length, renewalAmountCents: amount, folded: f.id });
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
            serverUrl: lineServer(),
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

module.exports = { mountMrtvProvision, fillLoginEmail, packFor, LOGIN_TEMPLATE, logEmail, sendTelegramPing, sendCustomerTgDm, getPanelCredits, applyReferralMonths, mrtvHasLink };

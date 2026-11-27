// QWB Orders bot — Telegram order alerts only (no lottery).
// Runs on the existing apex-dashboard Render service (no new worker).
//
// Env vars (all set on apex-dashboard):
//   QWB_TG_BOT_TOKEN, QWB_WEBHOOK_SECRET, QWB_SITE_BASE_URL
//   QWB_TG_STAFF_CHAT_ID (the one staff alerts group, all warehouses)
//   QWB_CUSTOMER_ALERTS ("on" enables customer DMs; default off = staff only)
"use strict";

const crypto = require("crypto");

const TG_ROUTE = "/api/qwb/telegram/webhook";
const ORDERS_ROUTE = "/api/qwb/orders/webhook";

const TG_COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "link", description: "Link your QWB account" },
  { command: "help", description: "List commands" },
];

function env(name) { return process.env[name] || ""; }
function tgToken() { return env("QWB_TG_BOT_TOKEN"); }
function siteBase() { return env("QWB_SITE_BASE_URL").replace(/\/$/, ""); }
function customerAlertsOn() { return env("QWB_CUSTOMER_ALERTS").toLowerCase() === "on"; }

// One staff group for all warehouses.
function staffChatFor() {
  return env("QWB_TG_STAFF_CHAT_ID");
}

// Country flag beside each order: warehouse field first, then the
// country code in the order number (AU / UK / CN tokens or prefixes).
const FLAGS = { AU: "🇦🇺", UK: "🇬🇧", CN: "🇨🇳" };
function countryKey(value) {
  const v = String(value || "").trim().toUpperCase();
  return { AU: "AU", AUS: "AU", AUSTRALIA: "AU", UK: "UK", GB: "UK", GBR: "UK", CN: "CN", CHN: "CN", CHINA: "CN" }[v] || null;
}
function countryFor(ev) {
  let key = countryKey(ev?.warehouse);
  if (!key && ev?.order_number) {
    const tokens = String(ev.order_number).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    for (const t of tokens) {
      key = countryKey(t) || countryKey(t.replace(/\d.*$/, ""));
      if (key) break;
    }
  }
  return key;
}
function flagFor(ev) {
  const key = countryFor(ev);
  return key ? FLAGS[key] : "";
}

// ---------- storage (Postgres when available, memory fallback) ----------
let pool = null;
try { pool = require("./pg").getPool(); } catch { pool = null; }
const mem = { links: new Map(), events: new Set() };

async function dbInit() {
  if (!pool) { console.warn("qwb bot: no DATABASE_URL, using in-memory store"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS qwb_links (
    customer_id TEXT PRIMARY KEY, tg_user_id TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS qwb_events (
    event_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ DEFAULT now())`);
}

async function linkSave(customerId, userId) {
  if (!pool) { mem.links.set(String(customerId), String(userId)); return; }
  await pool.query(
    `INSERT INTO qwb_links (customer_id, tg_user_id) VALUES ($1,$2)
     ON CONFLICT (customer_id) DO UPDATE SET tg_user_id=$2`, [String(customerId), String(userId)]);
}

async function linkTgFor(customerId) {
  if (!customerId) return null;
  if (!pool) return mem.links.get(String(customerId)) || null;
  const r = await pool.query("SELECT tg_user_id FROM qwb_links WHERE customer_id=$1", [String(customerId)]);
  return r.rows[0]?.tg_user_id || null;
}

async function eventSeen(eventId) { // returns true if duplicate
  if (!pool) {
    if (mem.events.has(eventId)) return true;
    mem.events.add(eventId); return false;
  }
  const r = await pool.query(
    "INSERT INTO qwb_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id", [eventId]);
  return r.rowCount === 0;
}

// ---------- helpers ----------
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function siteCall(path, body) {
  if (!siteBase()) throw new Error("QWB_SITE_BASE_URL is not set");
  const res = await fetch(`${siteBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Qwb-Webhook-Secret": env("QWB_WEBHOOK_SECRET") },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ---------- Telegram ----------
async function tg(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${tgToken()}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`${method} failed: ${data?.description || `HTTP ${res.status}`}`);
  return data.result;
}

async function tgSend(chatId, text, options = {}) {
  return tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...options });
}

async function tgStaff(ev, text) {
  const chatId = staffChatFor(ev);
  if (!chatId) return;
  await tgSend(chatId, text).catch((e) => console.error("qwb staff send:", e.message));
}

function staffText(ev) {
  const lines = {
    "order.placed": "🧾 New order placed",
    "order.proof_uploaded": "📸 Payment proof uploaded — waiting to be checked",
    "order.payment_confirmed": "✅ Payment confirmed / order marked paid",
    "order.shipped": "📦 Order shipped",
    "order.cancelled": "❌ Order cancelled",
    "order.delivery_problem": "⚠️ Delivery problem",
    "coa.uploaded": "🧪 COA uploaded — waiting for review",
    "inventory.low_stock": "📉 Low stock warning",
  };
  const flag = flagFor(ev);
  const out = [lines[ev.event] || `Order event: ${ev.event}`];
  if (ev.order_number) out.push(`Order: ${flag ? flag + " " : ""}${ev.order_number}`);
  else if (flag) out.push(`Warehouse: ${flag} ${ev.warehouse}`);
  else if (ev.warehouse) out.push(`Warehouse: ${ev.warehouse}`);
  if (ev.total != null) out.push(`Total: $${ev.total} ${ev.currency || "USD"}`);
  if (ev.tracking_number) out.push(`Tracking: ${ev.tracking_number}`);
  if (ev.product) out.push(`Product: ${ev.product}`);
  if (ev.stock != null) out.push(`Stock left: ${ev.stock}`);
  if (ev.note) out.push(String(ev.note));
  return out.join("\n");
}

function customerText(ev) {
  const n = ev.order_number ? ` ${ev.order_number}` : "";
  if (ev.event === "order.payment_confirmed") return `✅ Payment confirmed for your order${n}. We'll update you when it ships.`;
  if (ev.event === "order.cancelled") return `❌ Your order${n} was cancelled.`;
  if (ev.event === "order.shipped") return `📦 Your order${n} has shipped.${ev.tracking_number ? `\nTracking: ${ev.tracking_number}` : ""}`;
  return null;
}

async function processOrderEvent(ev) {
  await tgStaff(ev, staffText(ev));
  if (!customerAlertsOn()) return;
  const text = customerText(ev);
  if (!text) return;
  const tgId = await linkTgFor(ev.customer_id);
  if (tgId) await tgSend(tgId, text).catch((e) => console.error("qwb customer DM:", e.message));
}

async function handleLink(userId, code, reply) {
  if (!code) { await reply("Send it like this: /link CODE — get your code from your QWB account page."); return; }
  const { status, data } = await siteCall("/api/bot/link/verify", {
    code, platform: "telegram", platform_user_id: String(userId),
  });
  if (status === 200 && data?.customer_id) {
    await linkSave(String(data.customer_id), String(userId));
    await reply("✅ Linked. You'll get your order updates here on Telegram.");
  } else if (status === 409) {
    await reply("That account is already linked to a different QWB account.");
  } else if (status === 400) {
    await reply("That code is wrong, expired, or already used. Get a fresh code from your account page and try again.");
  } else {
    await reply("Linking hit a problem. Try again in a bit.");
  }
}

async function handleTgMessage(message) {
  if (!message?.chat?.id || !message.text) return;
  const parts = message.text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().split("@")[0];
  const reply = (t) => tgSend(message.chat.id, t, message.message_thread_id ? { message_thread_id: message.message_thread_id } : {});

  if (command === "/start") {
    await reply("📦 QWB Orders\n\nLink your QWB account with /link CODE to get your order updates here.");
    return;
  }
  if (command === "/link") { await handleLink(message.from.id, parts[1], reply); return; }
  if (command === "/help" || command === "/commands") {
    await reply("Commands:\n/start — start the bot\n/link CODE — link your QWB account\n/help — this list");
    return;
  }
}

// When the bot itself is added to a group, post that group's ID in the
// group so Ryan can copy it into the matching QWB_TG_STAFF_CHAT_ID env var.
async function handleMyChatMember(cm) {
  const chat = cm?.chat;
  if (!chat?.id || chat.type === "private") return;
  const status = cm.new_chat_member?.status;
  if (!["member", "administrator", "creator"].includes(status)) return;
  await tgSend(chat.id,
    `👋 QWB Orders bot is in.\nThis group's ID: ${chat.id}\n\nStaff alerts group? Set QWB_TG_STAFF_CHAT_ID=${chat.id} on apex-dashboard.`)
    .catch((e) => console.error("qwb group ID post:", e.message));
}

// ---------- mount ----------
function webhookUrl() {
  const base = process.env.RENDER_EXTERNAL_URL || "https://apex-dashboard-c0fq.onrender.com";
  return `${base.replace(/\/$/, "")}${TG_ROUTE}`;
}

async function initTelegram() {
  if (!tgToken()) { console.log("qwb bot: TG token missing, Telegram side inert"); return; }
  const me = await tg("getMe");
  console.log(`qwb bot: Telegram online as @${me.username}`);
  await tg("setMyCommands", { commands: TG_COMMANDS }).catch(() => {});
  const payload = { url: webhookUrl(), allowed_updates: ["message", "my_chat_member"] };
  const secret = env("QWB_WEBHOOK_SECRET");
  if (/^[A-Za-z0-9_-]{1,256}$/.test(secret)) payload.secret_token = secret;
  await tg("setWebhook", payload);
  console.log(`qwb bot: Telegram webhook set: ${payload.url}`);
}

function mountQWBBot(app) {
  app.post(ORDERS_ROUTE, async (req, res) => {
    if (!timingSafeEqualStr(req.get("X-Qwb-Webhook-Secret"), env("QWB_WEBHOOK_SECRET"))) {
      return res.sendStatus(401);
    }
    const ev = req.body || {};
    if (!ev.event || !ev.event_id) return res.sendStatus(400);
    res.sendStatus(200);
    try {
      if (await eventSeen(ev.event_id)) return;
      await processOrderEvent(ev);
    } catch (e) { console.error("qwb order event:", e.message); }
  });

  app.post(TG_ROUTE, async (req, res) => {
    const secret = env("QWB_WEBHOOK_SECRET");
    if (/^[A-Za-z0-9_-]{1,256}$/.test(secret) &&
        req.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return res.sendStatus(403);
    res.sendStatus(200);
    try {
      const update = req.body || {};
      if (update.message) await handleTgMessage(update.message);
      if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
    } catch (e) { console.error("qwb TG update:", e.message); }
  });

  dbInit()
    .then(() => initTelegram())
    .catch((e) => console.error("qwb bot init:", e.message));
  return true;
}

module.exports = {
  mountQWBBot, timingSafeEqualStr, staffText, customerText, staffChatFor,
  flagFor, countryFor, customerAlertsOn, siteBase, handleMyChatMember, TG_ROUTE, ORDERS_ROUTE,
};

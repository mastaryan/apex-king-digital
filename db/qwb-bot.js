// QWB Lottery bot — QWB lottery + Telegram order alerts (Telegram only).
// Runs on the existing apex-dashboard Render service (no new worker).
// Mirrors the GLP Lottery bot (db/lucy-bot.js), Telegram only.
//
// Env vars (all set on apex-dashboard):
//   QWB_TG_BOT_TOKEN, QWB_WEBHOOK_SECRET, QWB_SITE_BASE_URL
//   QWB_TG_GROUP_ID, QWB_TG_STAFF_CHAT_ID
//   QWB_LYNN_TG_USER_ID (may be unset at first; captured on her /start)
"use strict";

const crypto = require("crypto");

const TG_ROUTE = "/api/qwb/telegram/webhook";
const ORDERS_ROUTE = "/api/qwb/orders/webhook";

const PRIZES = { 1: 10, 2: 10, 3: 15, 4: 15, 5: 20 }; // Beijing Mon..Fri
const TG_COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "link", description: "Link your QWB account" },
  { command: "lottery", description: "Next drawing and prize" },
  { command: "help", description: "List commands" },
];

function env(name) { return process.env[name] || ""; }
function tgToken() { return env("QWB_TG_BOT_TOKEN"); }
function staffChatId() { return env("QWB_TG_STAFF_CHAT_ID"); }
function groupId() { return env("QWB_TG_GROUP_ID"); }
function siteBase() { return env("QWB_SITE_BASE_URL").replace(/\/$/, ""); }

// ---------- storage (Postgres when available, memory fallback) ----------
let pool = null;
try { pool = require("./pg").getPool(); } catch { pool = null; }
const mem = { links: new Map(), events: new Set(), roster: new Map(), draws: new Set() };

async function dbInit() {
  if (!pool) { console.warn("qwb bot: no DATABASE_URL, using in-memory store"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS qwb_links (
    customer_id TEXT PRIMARY KEY, tg_user_id TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS qwb_events (
    event_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS qwb_roster (
    tg_user_id TEXT PRIMARY KEY, username TEXT, first_name TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS qwb_draws (
    draw_key TEXT PRIMARY KEY, winner_ref TEXT, drawn_at TIMESTAMPTZ DEFAULT now())`);
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

async function rosterAdd(user) {
  if (!user?.id || user.is_bot) return;
  const id = String(user.id);
  if (!pool) { mem.roster.set(id, { id, username: user.username || null, first_name: user.first_name || null }); return; }
  await pool.query(
    `INSERT INTO qwb_roster (tg_user_id, username, first_name) VALUES ($1,$2,$3)
     ON CONFLICT (tg_user_id) DO UPDATE SET username=$2, first_name=$3`,
    [id, user.username || null, user.first_name || null]).catch(() => {});
}

async function rosterRemove(userId) {
  if (!pool) { mem.roster.delete(String(userId)); return; }
  await pool.query("DELETE FROM qwb_roster WHERE tg_user_id=$1", [String(userId)]).catch(() => {});
}

async function rosterList() {
  if (!pool) return [...mem.roster.values()];
  const r = await pool.query("SELECT tg_user_id AS id, username, first_name FROM qwb_roster");
  return r.rows;
}

async function drawClaim(key) { // true = first claim, run the draw
  if (!pool) {
    if (mem.draws.has(key)) return false;
    mem.draws.add(key); return true;
  }
  const r = await pool.query(
    "INSERT INTO qwb_draws (draw_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING draw_key", [key]);
  return r.rowCount > 0;
}

// ---------- helpers ----------
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function beijingParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[p.weekday];
  return { weekday: wd, date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

function prizeForWeekday(wd) { return PRIZES[wd] || null; }

function pickWinner(list) {
  if (!list?.length) return null;
  return list[crypto.randomInt(list.length)];
}

function displayName(u) {
  if (!u) return "member";
  if (u.username) return `@${u.username}`;
  return u.first_name || "member";
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

async function mintCode(percent, winnerRef) {
  const { status, data } = await siteCall("/api/bot/lottery/code", {
    discount_percent: percent, platform: "telegram", winner_ref: String(winnerRef),
  });
  if (status !== 200 || !data?.code) throw new Error(`code mint failed: HTTP ${status}`);
  return data.code;
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

async function tgStaff(text) {
  if (!staffChatId()) return;
  await tgSend(staffChatId(), text).catch((e) => console.error("qwb staff send:", e.message));
}

function staffText(ev) {
  const lines = {
    "order.placed": "🧾 New order placed",
    "order.proof_uploaded": "📸 Payment proof uploaded",
    "order.payment_confirmed": "✅ Payment confirmed",
    "order.cancelled": "❌ Order cancelled",
    "order.shipped": "📦 Order shipped",
  };
  const out = [lines[ev.event] || `Order event: ${ev.event}`];
  if (ev.order_number) out.push(`Order: ${ev.order_number}`);
  if (ev.total != null) out.push(`Total: $${ev.total} ${ev.currency || "USD"}`);
  if (ev.tracking_number) out.push(`Tracking: ${ev.tracking_number}`);
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
  await tgStaff(staffText(ev));
  const text = customerText(ev);
  if (!text) return;
  const tgId = await linkTgFor(ev.customer_id);
  if (tgId) await tgSend(tgId, text).catch((e) => console.error("qwb customer DM:", e.message));
}

function nextDrawText() {
  const now = beijingParts();
  const wd = now.weekday;
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let add = 0;
  if (wd >= 1 && wd <= 5 && now.hour < 23) add = 0;
  else if (wd === 5) add = 3;
  else if (wd === 6) add = 2;
  else add = 1;
  const nextWd = ((wd + add - 1) % 7) + 1;
  const prize = prizeForWeekday(nextWd === 0 ? 1 : nextWd) || 10;
  return `🎰 Next drawing: ${add === 0 ? "today" : names[(wd + add) % 7]} 11 PM Beijing time\nPrize: ${prize}% OFF\nOne Telegram winner. Every member is in automatically.`;
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
  if (!message?.chat?.id) return;
  const inMainGroup = String(message.chat.id) === String(groupId());
  const inStaff = String(message.chat.id) === String(staffChatId());
  if (inMainGroup && message.from) await rosterAdd(message.from);
  if (!message.text) return;

  const parts = message.text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().split("@")[0];
  const reply = (t) => tgSend(message.chat.id, t, message.message_thread_id ? { message_thread_id: message.message_thread_id } : {});

  if (command === "/start") {
    await reply("🎰 QWB Lottery\n\nDaily drawings Mon-Fri 11 PM Beijing time. Every member is in automatically.\n\nLink your QWB account with /link CODE to get order updates here.");
    if (message.chat.type === "private" && !env("QWB_LYNN_TG_USER_ID") && message.from) {
      await tgStaff(`Start pressed by ${displayName(message.from)} (ID ${message.from.id}).\nIf this is Lynn, set QWB_LYNN_TG_USER_ID=${message.from.id} on apex-dashboard.`);
    }
    return;
  }
  if (command === "/link") { await handleLink(message.from.id, parts[1], reply); return; }
  if (command === "/lottery") { await reply(nextDrawText()); return; }
  if (command === "/help" || command === "/commands") {
    await reply("Commands:\n/start — start the bot\n/link CODE — link your QWB account\n/lottery — next drawing and prize\n/help — this list");
    return;
  }
  if (command === "/drawtest" && inStaff) { await drawTest(reply); return; }
}

async function handleChatMember(cm) {
  const user = cm?.new_chat_member?.user;
  if (!user || String(cm.chat?.id) !== String(groupId())) return;
  const status = cm.new_chat_member.status;
  if (["member", "administrator", "creator"].includes(status)) await rosterAdd(user);
  if (["left", "kicked"].includes(status)) await rosterRemove(user.id);
}

// When the bot itself is added to a group, post that group's ID in the
// group so Ryan can copy it into QWB_TG_GROUP_ID / QWB_TG_STAFF_CHAT_ID.
async function handleMyChatMember(cm) {
  const chat = cm?.chat;
  if (!chat?.id || chat.type === "private") return;
  const status = cm.new_chat_member?.status;
  if (!["member", "administrator", "creator"].includes(status)) return;
  await tgSend(chat.id,
    `👋 QWB Lottery bot is in.\nThis group's ID: ${chat.id}\n\nStaff room? Set QWB_TG_STAFF_CHAT_ID=${chat.id} on apex-dashboard.\nMain lottery group? Set QWB_TG_GROUP_ID=${chat.id} on apex-dashboard.`)
    .catch((e) => console.error("qwb group ID post:", e.message));
}

// ---------- lottery ----------
async function tgShow(winner, prize) {
  const msg = await tgSend(groupId(), "🎰 Today's QWB Lottery drawing is starting…");
  for (const n of [3, 2, 1]) {
    await new Promise((r) => setTimeout(r, 1500));
    await tg("editMessageText", { chat_id: groupId(), message_id: msg.message_id, text: `🎰 Drawing… ${n}` }).catch(() => {});
  }
  await tg("sendDice", { chat_id: groupId(), emoji: "🎰" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await tg("editMessageText", {
    chat_id: groupId(), message_id: msg.message_id,
    text: `🎉 Congrats ${displayName(winner)}, Lynn will be reaching out to you\nPrize: ${prize}% OFF your next order`,
  });
}

function lynnText(winnerName, prize, code) {
  return `🎉 New lottery winner!\nPlatform: Telegram\nWinner: ${winnerName}\nPrize: ${prize}% OFF\nTheir code: ${code}\n\nPlease message the winner and give them the code. It works one time only and expires in 90 days.`;
}

async function dmLynnTelegram(text) {
  const id = env("QWB_LYNN_TG_USER_ID");
  if (!id) { await tgStaff(`⚠️ Lynn's Telegram ID is not set yet, so her winner DM could not be sent.\n\n${text}`); return; }
  await tgSend(id, text).catch((e) => console.error("qwb Lynn TG DM:", e.message));
}

async function runTelegramDraw(prize, dryRun = false) {
  const roster = await rosterList();
  const winner = pickWinner(roster);
  if (!winner) { await tgStaff("🎰 Telegram draw skipped: roster is empty so far."); return null; }
  if (dryRun) return winner;
  await tgShow(winner, prize);
  const code = await mintCode(prize, winner.id);
  await dmLynnTelegram(lynnText(displayName(winner), prize, code));
  return winner;
}

async function drawTest(reply) {
  const prize = prizeForWeekday(beijingParts().weekday) || 10;
  const tgWinner = await runTelegramDraw(prize, true).catch((e) => { console.error(e); return null; });
  await reply(`🧪 Draw dry-run (no codes minted, nothing posted publicly)\nTelegram pick: ${tgWinner ? displayName(tgWinner) : "none"}\nPrize would be: ${prize}% OFF`);
}

async function runDraws() {
  const now = beijingParts();
  const prize = prizeForWeekday(now.weekday);
  if (!prize) return;
  if (!(await drawClaim(`draw-${now.date}`))) return;
  console.log(`qwb bot: running draw for ${now.date} (${prize}%)`);
  await runTelegramDraw(prize).catch((e) => { console.error("qwb TG draw:", e.message); tgStaff(`⚠️ Telegram draw failed: ${e.message}`); });
}

function startScheduler() {
  setInterval(async () => {
    const now = beijingParts();
    if (now.hour === 23 && now.minute === 0) await runDraws().catch((e) => console.error("qwb scheduler:", e.message));
  }, 30000);
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
  const payload = { url: webhookUrl(), allowed_updates: ["message", "chat_member", "my_chat_member"] };
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
      if (update.chat_member) await handleChatMember(update.chat_member);
      if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
    } catch (e) { console.error("qwb TG update:", e.message); }
  });

  dbInit()
    .then(() => initTelegram())
    .then(() => startScheduler())
    .catch((e) => console.error("qwb bot init:", e.message));
  return true;
}

module.exports = {
  mountQWBBot, beijingParts, prizeForWeekday, pickWinner, timingSafeEqualStr,
  staffText, customerText, nextDrawText, siteBase, handleMyChatMember,
  TG_ROUTE, ORDERS_ROUTE,
};

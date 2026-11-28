// GLP Lottery bot (@GLPLotteryBot) — Lucypeptide lottery + Telegram order alerts.
// Runs on the existing apex-dashboard Render service (no new worker).
// Build request: lucypeptide-bot-program-request (site half already live).
//
// Env vars (all set on apex-dashboard):
//   LUCY_TG_BOT_TOKEN, LUCY_DISCORD_BOT_TOKEN, LUCY_WEBHOOK_SECRET
//   LUCY_TG_GROUP_ID, LUCY_TG_STAFF_CHAT_ID
//   LUCY_DISCORD_GUILD_ID, LUCY_DISCORD_ANNOUNCE_CHANNEL_ID
//   LUCY_LILY_DISCORD_USER_ID, LUCY_LILY_TG_USER_ID (may be unset at first)
//   LUCY_DISCORD_APP_ID (optional; defaults to the known GLP Lottery app)
"use strict";

const crypto = require("crypto");

const SITE_BASE = "https://lucypeptide.com";
const TG_ROUTE = "/api/lucy/telegram/webhook";
const ORDERS_ROUTE = "/api/lucy/orders/webhook";
const DISCORD_APP_ID = process.env.LUCY_DISCORD_APP_ID || "1575739084217917542";

const PRIZES = { 1: 10, 2: 10, 3: 15, 4: 15, 5: 20 }; // Beijing Mon..Fri
// Staff exclusion lists (addendum Nov 27): these IDs are filtered out before every pick.
const STAFF_TG_IDS = ["7213362674", "8921727769", "8782959973", "8871958193", "7494640158", "7712164503"]; // Ryan, Lucy, Lily, Cassie, Porgy, Longbeach283
const STAFF_DISCORD_IDS = ["329342011188445184", "1247263344927178804", "1526261440569151629", "1265948792050548758", "343494949506908160", "1112137554884571218"]; // Ryan, Lucy, Lily, Cassie, Porgy, Longbeach283
const TG_COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "link", description: "Link your Lucypeptide account" },
  { command: "lottery", description: "Next drawing and prize" },
  { command: "help", description: "List commands" },
];

function env(name) { return process.env[name] || ""; }
function tgToken() { return env("LUCY_TG_BOT_TOKEN"); }
function staffChatId() { return env("LUCY_TG_STAFF_CHAT_ID"); }
function groupId() { return env("LUCY_TG_GROUP_ID"); }
function announceThreadId() {
  const n = Number(env("LUCY_TG_ANNOUNCE_THREAD_ID") || 332);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- storage (Postgres when available, memory fallback) ----------
let pool = null;
try { pool = require("./pg").getPool(); } catch { pool = null; }
const mem = { links: new Map(), events: new Set(), roster: new Map(), draws: new Set() };

async function dbInit() {
  if (!pool) { console.warn("lucy bot: no DATABASE_URL, using in-memory store"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS lucy_links (
    customer_id TEXT PRIMARY KEY, tg_user_id TEXT, discord_user_id TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lucy_events (
    event_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lucy_roster (
    tg_user_id TEXT PRIMARY KEY, username TEXT, first_name TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lucy_draws (
    draw_key TEXT PRIMARY KEY, winner_ref TEXT, drawn_at TIMESTAMPTZ DEFAULT now())`);
}

async function linkSave(customerId, platform, userId) {
  if (!pool) {
    const cur = mem.links.get(customerId) || {};
    cur[platform] = userId; mem.links.set(customerId, cur); return;
  }
  const col = platform === "telegram" ? "tg_user_id" : "discord_user_id";
  await pool.query(
    `INSERT INTO lucy_links (customer_id, ${col}) VALUES ($1,$2)
     ON CONFLICT (customer_id) DO UPDATE SET ${col}=$2`, [customerId, userId]);
}

async function linkTgFor(customerId) {
  if (!customerId) return null;
  if (!pool) return mem.links.get(String(customerId))?.telegram || null;
  const r = await pool.query("SELECT tg_user_id FROM lucy_links WHERE customer_id=$1", [String(customerId)]);
  return r.rows[0]?.tg_user_id || null;
}

async function eventSeen(eventId) { // returns true if duplicate
  if (!pool) {
    if (mem.events.has(eventId)) return true;
    mem.events.add(eventId); return false;
  }
  const r = await pool.query(
    "INSERT INTO lucy_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id", [eventId]);
  return r.rowCount === 0;
}

async function rosterAdd(user) {
  if (!user?.id || user.is_bot) return;
  const id = String(user.id);
  if (!pool) { mem.roster.set(id, { id, username: user.username || null, first_name: user.first_name || null }); return; }
  await pool.query(
    `INSERT INTO lucy_roster (tg_user_id, username, first_name) VALUES ($1,$2,$3)
     ON CONFLICT (tg_user_id) DO UPDATE SET username=$2, first_name=$3`,
    [id, user.username || null, user.first_name || null]).catch(() => {});
}

async function rosterRemove(userId) {
  if (!pool) { mem.roster.delete(String(userId)); return; }
  await pool.query("DELETE FROM lucy_roster WHERE tg_user_id=$1", [String(userId)]).catch(() => {});
}

async function rosterList() {
  if (!pool) return [...mem.roster.values()];
  const r = await pool.query("SELECT tg_user_id AS id, username, first_name FROM lucy_roster");
  return r.rows;
}

async function drawClaim(key) { // true = first claim, run the draw
  if (!pool) {
    if (mem.draws.has(key)) return false;
    mem.draws.add(key); return true;
  }
  const r = await pool.query(
    "INSERT INTO lucy_draws (draw_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING draw_key", [key]);
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

function csvSet(v) {
  return new Set(String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function filterTgRoster(roster, adminIds) {
  const excludedNames = csvSet(env("LUCY_TG_EXCLUDED_USERNAMES") || "masta_ryan");
  const excludedIds = new Set([...STAFF_TG_IDS, ...csvSet(env("LUCY_TG_EXCLUDED_USER_IDS"))]);
  return roster.filter((u) => !adminIds.has(String(u.id)) && !excludedIds.has(String(u.id)) && !excludedNames.has(String(u.username || "").toLowerCase()));
}

async function tgEligibleRoster() {
  const admins = await tg("getChatAdministrators", { chat_id: groupId() });
  const adminIds = new Set(admins.map((a) => String(a.user?.id)).filter(Boolean));
  return filterTgRoster(await rosterList(), adminIds);
}

function isDiscordEligible(member, ownerId) {
  const excludedIds = new Set([...STAFF_DISCORD_IDS, ...csvSet(env("LUCY_DISCORD_EXCLUDED_USER_IDS"))]);
  return !member.user.bot
    && String(member.id) !== String(ownerId || "")
    && !excludedIds.has(String(member.id))
    && !member.permissions?.has?.("Administrator");
}

const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "💎", "7️⃣"];
function slotFrame() {
  return [0, 1, 2].map(() => SLOT_SYMBOLS[crypto.randomInt(SLOT_SYMBOLS.length)]).join(" ");
}

function displayName(u) {
  if (!u) return "member";
  if (u.username) return `@${u.username}`;
  return u.first_name || u.displayName || u.tag || "member";
}

async function siteCall(path, body) {
  const res = await fetch(`${SITE_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Lucy-Webhook-Secret": env("LUCY_WEBHOOK_SECRET") },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function mintCode(percent, platform, winnerRef) {
  const { status, data } = await siteCall("/api/bot/lottery/code", {
    discount_percent: percent, platform, winner_ref: String(winnerRef),
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

// "View order" button on staff alerts for order events carrying staff_url.
const ORDER_EVENTS = new Set([
  "order.placed", "order.proof_uploaded", "order.payment_confirmed",
  "order.cancelled", "order.shipped",
]);
function staffOptions(ev) {
  if (!ORDER_EVENTS.has(ev?.event) || !ev?.staff_url) return {};
  try {
    const url = new URL(String(ev.staff_url));
    if (!["http:", "https:"].includes(url.protocol)) return {};
    return { reply_markup: { inline_keyboard: [[{ text: "View order", url: url.toString() }]] } };
  } catch { return {}; }
}

async function tgStaff(text, options = {}) {
  if (!staffChatId()) return;
  await tgSend(staffChatId(), text, options).catch((e) => console.error("lucy staff send:", e.message));
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
  await tgStaff(staffText(ev), staffOptions(ev));
  const text = customerText(ev);
  if (!text) return;
  const tgId = await linkTgFor(ev.customer_id);
  if (tgId) await tgSend(tgId, text).catch((e) => console.error("lucy customer DM:", e.message));
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
  return `🎰 Next drawing: ${add === 0 ? "today" : names[(wd + add) % 7]} 11 PM Beijing time\nPrize: ${prize}% OFF\nOne Telegram winner and one Discord winner. Every member is in automatically.`;
}

async function handleLink(platform, userId, code, reply) {
  if (!code) { await reply("Send it like this: /link CODE — get your code from your Lucypeptide account page."); return; }
  const { status, data } = await siteCall("/api/bot/link/verify", {
    code, platform, platform_user_id: String(userId),
  });
  if (status === 200 && data?.customer_id) {
    await linkSave(String(data.customer_id), platform, String(userId));
    await reply("✅ Linked. You'll get your order updates here on Telegram.");
  } else if (status === 409) {
    await reply("That account is already linked to a different Lucypeptide account.");
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
    await reply("🎰 GLP Lottery\n\nDaily drawings Mon-Fri 11 PM Beijing time. Every member is in automatically.\n\nLink your Lucypeptide account with /link CODE to get order updates here.");
    if (message.chat.type === "private" && !env("LUCY_LILY_TG_USER_ID") && message.from) {
      await tgStaff(`Start pressed by ${displayName(message.from)} (ID ${message.from.id}).\nIf this is Lily, set LUCY_LILY_TG_USER_ID=${message.from.id} on apex-dashboard.`);
    }
    return;
  }
  if (command === "/link") { await handleLink("telegram", message.from.id, parts[1], reply); return; }
  if (command === "/lottery") { await reply(nextDrawText()); return; }
  if (command === "/help" || command === "/commands") {
    await reply("Commands:\n/start — start the bot\n/link CODE — link your Lucypeptide account\n/lottery — next drawing and prize\n/help — this list");
    return;
  }
  if (command === "/drawtest" && inStaff) { await drawTest(reply); return; }
  if (command === "/repostproof" && inStaff) {
    const [, order, total, url] = parts;
    const ev = { event: "order.proof_uploaded", order_number: order, total, staff_url: url };
    if (!order || !total || !staffOptions(ev).reply_markup) { await reply("Use: /repostproof ORDER TOTAL STAFF_URL"); return; }
    await tgStaff(staffText(ev), staffOptions(ev));
    return;
  }
}

async function handleChatMember(cm) {
  const user = cm?.new_chat_member?.user;
  if (!user || String(cm.chat?.id) !== String(groupId())) return;
  const status = cm.new_chat_member.status;
  if (["member", "administrator", "creator"].includes(status)) await rosterAdd(user);
  if (["left", "kicked"].includes(status)) await rosterRemove(user.id);
}

// ---------- lottery ----------
async function tgShow(winner, prize) {
  const threadId = announceThreadId();
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
  const msg = await tgSend(groupId(), "🎰 Today's GLP Lottery drawing is starting…", threadOpts);
  for (const n of [3, 2, 1]) {
    await new Promise((r) => setTimeout(r, 1500));
    await tg("editMessageText", { chat_id: groupId(), message_id: msg.message_id, text: `🎰 Drawing… ${n}` }).catch(() => {});
  }
  await tg("sendDice", { chat_id: groupId(), emoji: "🎰", ...threadOpts }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await tg("editMessageText", {
    chat_id: groupId(), message_id: msg.message_id,
    text: `🎉 Congrats ${displayName(winner)}, Lily will be reaching out to you\nPrize: ${prize}% OFF your next order`,
  });
}

function lilyText(platform, winnerName, prize, code) {
  return `🎉 New lottery winner!\nPlatform: ${platform}\nWinner: ${winnerName}\nPrize: ${prize}% OFF\nTheir code: ${code}\n\nPlease message the winner and give them the code. It works one time only and expires in 90 days.`;
}

async function dmLilyTelegram(text) {
  const id = env("LUCY_LILY_TG_USER_ID");
  if (!id) { await tgStaff(`⚠️ Lily's Telegram ID is not set yet, so her winner DM could not be sent.\n\n${text}`); return; }
  await tgSend(id, text).catch((e) => console.error("lucy Lily TG DM:", e.message));
}

async function runTelegramDraw(prize, dryRun = false) {
  let roster;
  try {
    roster = await tgEligibleRoster();
  } catch (e) {
    await tgStaff(`🎰 Telegram draw skipped: could not verify admins (${e.message}).`);
    return null;
  }
  const winner = pickWinner(roster);
  if (!winner) { await tgStaff("🎰 Telegram draw skipped: no eligible members so far."); return null; }
  if (dryRun) return winner;
  await tgShow(winner, prize);
  const code = await mintCode(prize, "telegram", winner.id);
  await dmLilyTelegram(lilyText("Telegram", displayName(winner), prize, code));
  return winner;
}

// ---------- Discord ----------
let discordClient = null;

async function discordRoster() {
  const guild = await discordClient.guilds.fetch(env("LUCY_DISCORD_GUILD_ID"));
  const members = await guild.members.fetch();
  return [...members.values()].filter((m) => isDiscordEligible(m, guild.ownerId))
    .map((m) => ({ id: m.id, username: m.user.username, displayName: m.displayName, tag: m.user.tag }));
}

async function runDiscordDraw(prize, dryRun = false) {
  if (!discordClient?.isReady()) { await tgStaff("🎰 Discord draw skipped: Discord bot is not connected."); return null; }
  const winner = pickWinner(await discordRoster());
  if (!winner) { await tgStaff("🎰 Discord draw skipped: no eligible members found."); return null; }
  if (dryRun) return winner;
  const channel = await discordClient.channels.fetch(env("LUCY_DISCORD_ANNOUNCE_CHANNEL_ID"));
  const msg = await channel.send("🎰 Today's GLP Lottery drawing is starting…");
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 650));
    await msg.edit(`🎰 ${slotFrame()}`).catch(() => {});
  }
  await msg.edit("🎰 7️⃣ 7️⃣ 7️⃣").catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  await msg.edit(`🎉 Congrats <@${winner.id}>, Lily will be reaching out to you\nPrize: ${prize}% OFF your next order`);
  const code = await mintCode(prize, "discord", winner.id);
  const text = lilyText("Discord", `@${winner.username}`, prize, code);
  const lily = await discordClient.users.fetch(env("LUCY_LILY_DISCORD_USER_ID")).catch(() => null);
  if (lily) await lily.send(text).catch((e) => console.error("lucy Lily Discord DM:", e.message));
  await dmLilyTelegram(text);
  return winner;
}

async function drawTest(reply) {
  const prize = prizeForWeekday(beijingParts().weekday) || 10;
  const tgWinner = await runTelegramDraw(prize, true).catch((e) => { console.error(e); return null; });
  const dcWinner = await runDiscordDraw(prize, true).catch((e) => { console.error(e); return null; });
  await reply(`🧪 Draw dry-run (no codes minted, nothing posted publicly)\nTelegram pick: ${tgWinner ? displayName(tgWinner) : "none"}\nDiscord pick: ${dcWinner ? "@" + dcWinner.username : "none"}\nPrize would be: ${prize}% OFF`);
}

async function runDraws() {
  const now = beijingParts();
  const prize = prizeForWeekday(now.weekday);
  if (!prize) return;
  if (!(await drawClaim(`draw-${now.date}`))) return;
  console.log(`lucy bot: running draw for ${now.date} (${prize}%)`);
  await runTelegramDraw(prize).catch((e) => { console.error("lucy TG draw:", e.message); tgStaff(`⚠️ Telegram draw failed: ${e.message}`); });
  await runDiscordDraw(prize).catch((e) => { console.error("lucy Discord draw:", e.message); tgStaff(`⚠️ Discord draw failed: ${e.message}`); });
}

function startScheduler() {
  setInterval(async () => {
    const now = beijingParts();
    if (now.hour === 23 && now.minute === 0) await runDraws().catch((e) => console.error("lucy scheduler:", e.message));
  }, 30000);
}

async function initDiscord() {
  const token = env("LUCY_DISCORD_BOT_TOKEN");
  if (!token) { console.log("lucy bot: Discord token missing, Discord side inert"); return; }
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages] });

  const commands = [
    new SlashCommandBuilder().setName("link").setDescription("Link your Lucypeptide account")
      .addStringOption((o) => o.setName("code").setDescription("Your link code").setRequired(true)),
    new SlashCommandBuilder().setName("lottery").setDescription("Next drawing and prize"),
  ].map((c) => c.toJSON());
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, env("LUCY_DISCORD_GUILD_ID")), { body: commands })
    .catch((e) => console.error("lucy discord commands:", e.message));

  discordClient.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "lottery") { await interaction.reply(nextDrawText()); return; }
    if (interaction.commandName === "link") {
      await interaction.deferReply({ ephemeral: true });
      await handleLink("discord", interaction.user.id, interaction.options.getString("code"),
        (t) => interaction.editReply(t));
    }
  });
  await discordClient.login(token);
  console.log(`lucy bot: Discord online as ${discordClient.user.tag}`);
}

// ---------- mount ----------
function webhookUrl() {
  const base = process.env.RENDER_EXTERNAL_URL || "https://apex-dashboard-c0fq.onrender.com";
  return `${base.replace(/\/$/, "")}${TG_ROUTE}`;
}

async function initTelegram() {
  if (!tgToken()) { console.log("lucy bot: TG token missing, Telegram side inert"); return; }
  const me = await tg("getMe");
  console.log(`lucy bot: Telegram online as @${me.username}`);
  await tg("setMyCommands", { commands: TG_COMMANDS }).catch(() => {});
  const payload = { url: webhookUrl(), allowed_updates: ["message", "chat_member"] };
  const secret = env("LUCY_WEBHOOK_SECRET");
  if (/^[A-Za-z0-9_-]{1,256}$/.test(secret)) payload.secret_token = secret;
  await tg("setWebhook", payload);
  console.log(`lucy bot: Telegram webhook set: ${payload.url}`);
}

function mountLucyBot(app) {
  app.post(ORDERS_ROUTE, async (req, res) => {
    if (!timingSafeEqualStr(req.get("X-Lucy-Webhook-Secret"), env("LUCY_WEBHOOK_SECRET"))) {
      return res.sendStatus(401);
    }
    const ev = req.body || {};
    if (!ev.event || !ev.event_id) return res.sendStatus(400);
    res.sendStatus(200);
    try {
      if (await eventSeen(ev.event_id)) return;
      await processOrderEvent(ev);
    } catch (e) { console.error("lucy order event:", e.message); }
  });

  app.post(TG_ROUTE, async (req, res) => {
    const secret = env("LUCY_WEBHOOK_SECRET");
    if (/^[A-Za-z0-9_-]{1,256}$/.test(secret) &&
        req.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return res.sendStatus(403);
    res.sendStatus(200);
    try {
      const update = req.body || {};
      if (update.message) await handleTgMessage(update.message);
      if (update.chat_member) await handleChatMember(update.chat_member);
    } catch (e) { console.error("lucy TG update:", e.message); }
  });

  dbInit()
    .then(() => initTelegram())
    .then(() => initDiscord())
    .then(() => startScheduler())
    .catch((e) => console.error("lucy bot init:", e.message));
  return true;
}

module.exports = {
  mountLucyBot, beijingParts, prizeForWeekday, pickWinner, timingSafeEqualStr,
  staffText, staffOptions, customerText, nextDrawText, filterTgRoster, isDiscordEligible, slotFrame, TG_ROUTE, ORDERS_ROUTE,
};

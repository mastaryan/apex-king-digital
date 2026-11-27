// Helix Peptide Research discovery bot (@HelixPeptideResearchBot).
// Runs as a webhook on the existing apex-dashboard Render service, so it
// adds no new Render worker cost.
//
// Env vars on apex-dashboard:
//   HKL_RANKING_BOT_TOKEN       - BotFather token for @HelixPeptideResearchBot
//   HKL_RANKING_WEBHOOK_SECRET  - long random string; Telegram echoes it in
//                                 X-Telegram-Bot-Api-Secret-Token
//   HKL_RANKING_WEBHOOK_URL     - optional full webhook URL override
//
// If HKL_RANKING_BOT_TOKEN is not set, the mount is inert and no webhook is
// registered, so this is safe to deploy before the token is added.

const ROUTE = "/api/hkl/ranking-bot/webhook";

const LINKS = {
  group: "https://t.me/hkl_research",
  coa: "https://helixkinglabs.com/coa-checker.html",
  calculator: "https://helixkinglabs.com/tools/calculator",
  notes: "https://helixkinglabs.substack.com",
  website: "https://helixkinglabs.com",
  vendor: "https://helixkinglabs.com/wholesale",
};

const FOOTER = "Research use only — not for human consumption.";

const COMMANDS = [
  { command: "start", description: "Open the HKL research menu" },
  { command: "join", description: "Join HKL Research" },
  { command: "coa", description: "Open the COA Checker" },
  { command: "calculator", description: "Open the calculator" },
  { command: "notes", description: "Read research notes" },
  { command: "website", description: "Open helixkinglabs.com" },
  { command: "vendor", description: "Open Vendor Direct" },
  { command: "help", description: "Show commands" },
];

let botUsername = null;

function botToken() {
  return process.env.HKL_RANKING_BOT_TOKEN || "";
}

async function tg(method, payload = {}) {
  const token = botToken();
  if (!token) throw new Error("HKL_RANKING_BOT_TOKEN is not set");

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`${method} failed: ${data?.description || `HTTP ${response.status}`}`);
  }
  return data.result;
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🧬 Join HKL Research", url: LINKS.group }],
      [
        { text: "✅ COA Checker", url: LINKS.coa },
        { text: "🧮 Calculator", url: LINKS.calculator },
      ],
      [
        { text: "📚 Research Notes", url: LINKS.notes },
        { text: "🌐 Website", url: LINKS.website },
      ],
      [{ text: "🏭 Vendor Direct", url: LINKS.vendor }],
    ],
  };
}

function singleButton(text, url) {
  return { inline_keyboard: [[{ text, url }]] };
}

async function sendMessage(chatId, text, options = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options,
  });
}

function threadOptions(message) {
  return message?.message_thread_id ? { message_thread_id: message.message_thread_id } : {};
}

function commandName(text) {
  const first = String(text || "").trim().split(/\s+/)[0].toLowerCase();
  const command = first.split("@")[0];
  if (command === "!commands") return "/commands";
  return command;
}

async function sendStart(message) {
  await sendMessage(
    message.chat.id,
    ["Helix Peptide Research 🧬", "Helix King Labs research links in one place.", "", FOOTER].join("\n"),
    { reply_markup: mainKeyboard(), ...threadOptions(message) },
  );
}

async function sendHelp(message) {
  await sendMessage(
    message.chat.id,
    [
      "Commands:",
      "/start — open the HKL research menu",
      "/join — join HKL Research",
      "/coa — open the COA Checker",
      "/calculator — open the calculator",
      "/notes — read research notes",
      "/website — open helixkinglabs.com",
      "/vendor — open Vendor Direct",
      "",
      FOOTER,
    ].join("\n"),
    { reply_markup: mainKeyboard(), ...threadOptions(message) },
  );
}

async function handleMessage(message) {
  if (!message?.chat?.id || !message.text) return;

  const isPrivate = message.chat.type === "private";
  const command = commandName(message.text);
  const options = threadOptions(message);

  switch (command) {
    case "/start":
      await sendStart(message);
      return;
    case "/help":
    case "/commands":
      await sendHelp(message);
      return;
    case "/join":
      await sendMessage(message.chat.id, `Join HKL Research:\n${LINKS.group}\n\n${FOOTER}`, {
        reply_markup: singleButton("🧬 Join HKL Research", LINKS.group),
        ...options,
      });
      return;
    case "/coa":
      await sendMessage(message.chat.id, `COA Checker:\n${LINKS.coa}\n\n${FOOTER}`, {
        reply_markup: singleButton("✅ COA Checker", LINKS.coa),
        ...options,
      });
      return;
    case "/calculator":
      await sendMessage(message.chat.id, `Calculator:\n${LINKS.calculator}\n\n${FOOTER}`, {
        reply_markup: singleButton("🧮 Calculator", LINKS.calculator),
        ...options,
      });
      return;
    case "/notes":
      await sendMessage(message.chat.id, `Research Notes:\n${LINKS.notes}\n\n${FOOTER}`, {
        reply_markup: singleButton("📚 Research Notes", LINKS.notes),
        ...options,
      });
      return;
    case "/website":
      await sendMessage(message.chat.id, `Helix King Labs:\n${LINKS.website}\n\n${FOOTER}`, {
        reply_markup: singleButton("🌐 Website", LINKS.website),
        ...options,
      });
      return;
    case "/vendor":
      await sendMessage(message.chat.id, `Vendor Direct:\n${LINKS.vendor}\n\n${FOOTER}`, {
        reply_markup: singleButton("🏭 Vendor Direct", LINKS.vendor),
        ...options,
      });
      return;
    default:
      if (isPrivate) await sendStart(message);
  }
}

async function handleUpdate(update) {
  if (update?.message) await handleMessage(update.message);
}

function webhookUrl() {
  if (process.env.HKL_RANKING_WEBHOOK_URL) return process.env.HKL_RANKING_WEBHOOK_URL;
  const base = process.env.RENDER_EXTERNAL_URL || "https://apex-dashboard-c0fq.onrender.com";
  return `${base.replace(/\/$/, "")}${ROUTE}`;
}

async function initHklRankingBot() {
  if (!botToken()) {
    console.log("HKL ranking bot not configured (HKL_RANKING_BOT_TOKEN missing)");
    return false;
  }

  const me = await tg("getMe");
  botUsername = me.username;
  console.log(`HKL ranking bot online as @${botUsername} (webhook)`);

  await tg("setMyCommands", { commands: COMMANDS }).catch((err) =>
    console.warn(`HKL ranking bot could not set commands: ${err.message}`),
  );

  const payload = { url: webhookUrl(), allowed_updates: ["message"] };
  if (process.env.HKL_RANKING_WEBHOOK_SECRET) {
    payload.secret_token = process.env.HKL_RANKING_WEBHOOK_SECRET;
  }
  await tg("setWebhook", payload);
  console.log(`HKL ranking bot webhook set: ${payload.url}`);
  return true;
}

function mountHklRankingBot(app) {
  app.post(ROUTE, async (req, res) => {
    const secret = process.env.HKL_RANKING_WEBHOOK_SECRET;
    if (secret && req.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return res.sendStatus(403);
    }
    if (!botToken()) return res.sendStatus(503);

    res.sendStatus(200);
    try {
      if (!botUsername) {
        const me = await tg("getMe");
        botUsername = me.username;
      }
      await handleUpdate(req.body || {});
    } catch (err) {
      console.error("HKL ranking bot update failed:", err.message);
    }
  });

  initHklRankingBot().catch((err) => console.error("HKL ranking bot init:", err.message));
  return true;
}

module.exports = { mountHklRankingBot, initHklRankingBot, handleUpdate, ROUTE, COMMANDS };

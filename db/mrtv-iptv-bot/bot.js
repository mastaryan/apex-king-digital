const TOKEN = process.env.MRTV_IPTV_BOT_TOKEN || process.env.BOT_TOKEN;

if (!TOKEN && require.main === module) {
  console.error('BOT_TOKEN is required. Add it as a Render environment variable; do not paste it in chat.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

const LINKS = {
  group: 'https://t.me/watchmrtv',
  order: 'https://t.me/WatchMRTV_bot',
  howto: 'https://t.me/watchmrtv/5',
  website: 'https://watchmrtv.com',
  setup: 'https://watchmrtv.com/app/',
};

const COMMANDS = [
  { command: 'start', description: 'Open MR TV links' },
  { command: 'setup', description: "Setup guide and How-To's" },
  { command: 'support', description: 'Support room link' },
  { command: 'order', description: 'Order or renew' },
  { command: 'website', description: 'MR TV website' },
  { command: 'commands', description: 'Show command list' },
];

function keyboard(rows) {
  return { inline_keyboard: rows };
}

const MAIN_KEYBOARD = keyboard([
  [{ text: '📺 Join MR TV', url: LINKS.group }],
  [
    { text: '🛠️ Setup Guide', url: LINKS.setup },
    { text: '🔥 Order / Renew', url: LINKS.order },
  ],
  [{ text: '🌐 Website', url: LINKS.website }],
]);

const SETUP_KEYBOARD = keyboard([
  [{ text: '🚀 Setup Guide', url: LINKS.setup }],
  [{ text: "📌 How-To's", url: LINKS.howto }],
  [{ text: '📺 Join MR TV', url: LINKS.group }],
]);

const SUPPORT_KEYBOARD = keyboard([
  [{ text: '💬 Join MR TV', url: LINKS.group }],
  [{ text: '🛠️ Setup Guide', url: LINKS.setup }],
]);

const ORDER_KEYBOARD = keyboard([
  [{ text: '🔥 Order / Renew', url: LINKS.order }],
  [{ text: '🌐 Website', url: LINKS.website }],
]);

const WEBSITE_KEYBOARD = keyboard([
  [{ text: '🌐 Website', url: LINKS.website }],
  [{ text: '🚀 Setup Guide', url: LINKS.setup }],
]);

const TEXT = {
  start: [
    'MR TV IPTV Support 📺',
    'IPTV player help, setup guides, and MR TV links.',
    'Tap a button and get rolling:',
  ].join('\n'),
  setup: [
    'Setup help 🚀',
    "Open the guide, pick your device, then follow the steps. The How-To's pinned post in the MR TV room has the current Downloader codes.",
  ].join('\n'),
  support: [
    'Support is inside the MR TV room. 💬',
    'Join the room and use the Support topic so the answer stays with your setup.',
  ].join('\n'),
  order: 'Orders and renewals run through the MR TV order bot. 🔥',
  website: 'MR TV website and setup guide:',
  commands: [
    'Commands:',
    '/start - Open MR TV links',
    "/setup - Setup guide and How-To's",
    '/support - Support room link',
    '/order - Order or renew',
    '/website - MR TV website',
    '/commands - Show this list',
  ].join('\n'),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tg(method, payload = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`${method} failed: ${data.error_code || res.status} ${data.description || res.statusText}`);
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

async function send(chatId, text, replyMarkup, messageThreadId) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (messageThreadId) payload.message_thread_id = messageThreadId;
  return tg('sendMessage', payload);
}

function parseCommand(text, botUsername) {
  if (!text) return null;
  const first = text.trim().split(/\s+/)[0].toLowerCase();
  if (!first.startsWith('/')) return null;
  const [command, mention] = first.slice(1).split('@');
  if (mention && botUsername && mention !== botUsername.toLowerCase()) return null;
  return command;
}

async function handleMessage(message, botUsername) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id;
  const isPrivate = message.chat.type === 'private';
  const command = parseCommand(message.text || '', botUsername);

  if (!command && !isPrivate) return;

  switch (command) {
    case 'setup':
      return send(chatId, TEXT.setup, SETUP_KEYBOARD, threadId);
    case 'support':
      return send(chatId, TEXT.support, SUPPORT_KEYBOARD, threadId);
    case 'order':
      return send(chatId, TEXT.order, ORDER_KEYBOARD, threadId);
    case 'website':
      return send(chatId, TEXT.website, WEBSITE_KEYBOARD, threadId);
    case 'commands':
    case 'help':
      return send(chatId, TEXT.commands, MAIN_KEYBOARD, threadId);
    case 'join':
      return send(chatId, 'Join the MR TV room here:', SUPPORT_KEYBOARD, threadId);
    case 'start':
    default:
      return send(chatId, TEXT.start, MAIN_KEYBOARD, threadId);
  }
}

async function handleCallback(callback) {
  await tg('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
  if (callback.data === 'menu' && callback.message) {
    await send(callback.message.chat.id, TEXT.start, MAIN_KEYBOARD, callback.message.message_thread_id);
  }
}

async function main() {
  const me = await tg('getMe');
  const botUsername = me.username;
  console.log(`Mister TV IPTV bot online as @${botUsername}`);

  try {
    await tg('setMyCommands', { commands: COMMANDS });
  } catch (err) {
    console.warn(`Could not set commands: ${err.message}`);
  }

  let offset = 0;
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message, botUsername);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } catch (err) {
      if (err.code === 401) {
        console.error('Telegram rejected BOT_TOKEN (401). Check the Render environment variable.');
        process.exit(1);
      }
      console.error(err.message);
      await sleep(3000);
    }
  }
}

async function handleUpdate(update, botUsername) {
  if (update.message) await handleMessage(update.message, botUsername);
  if (update.callback_query) await handleCallback(update.callback_query);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { handleUpdate, handleMessage, handleCallback, tg, COMMANDS };

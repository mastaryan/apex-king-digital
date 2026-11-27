// Webhook mount for the Mister TV IPTV Support bot on the existing
// apex-dashboard Render service (no separate worker, no extra Render cost).
//
// Env vars on apex-dashboard:
//   MRTV_IPTV_BOT_TOKEN        - token from BotFather (Ryan creates the bot)
//   MRTV_IPTV_WEBHOOK_SECRET   - any long random string; Telegram echoes it
//                                back in the X-Telegram-Bot-Api-Secret-Token
//                                header so only Telegram can post updates
//   MRTV_IPTV_WEBHOOK_URL      - full public URL of the route below, e.g.
//                                https://apex-dashboard-c0fq.onrender.com/api/mrtv/iptv-bot/webhook
//                                (same host the existing mrtv webhook uses)
//
// Integration in apex-dashboard (two lines near the existing mrtv webhook):
//   const { registerIptvBotWebhook, initIptvBot } = require('./db/mrtv-iptv-bot/webhook');
//   registerIptvBotWebhook(app);
//   initIptvBot().catch((err) => console.error('iptv bot init:', err.message));
//
// If MRTV_IPTV_BOT_TOKEN is not set, both functions no-op, so this is safe to
// deploy before Ryan creates the bot in BotFather.

const { handleUpdate, tg, COMMANDS } = require('./bot');

const ROUTE = '/api/mrtv/iptv-bot/webhook';
let botUsername = null;

function registerIptvBotWebhook(app) {
  app.post(ROUTE, async (req, res) => {
    const secret = process.env.MRTV_IPTV_WEBHOOK_SECRET;
    if (secret && req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
      return res.sendStatus(403);
    }
    if (!process.env.MRTV_IPTV_BOT_TOKEN && !process.env.BOT_TOKEN) {
      return res.sendStatus(503);
    }
    res.sendStatus(200);
    try {
      if (!botUsername) {
        const me = await tg('getMe');
        botUsername = me.username;
      }
      await handleUpdate(req.body || {}, botUsername);
    } catch (err) {
      console.error('iptv bot update failed:', err.message);
    }
  });
  return true;
}

async function initIptvBot() {
  if (!process.env.MRTV_IPTV_BOT_TOKEN && !process.env.BOT_TOKEN) {
    console.log('Mister TV IPTV bot not configured (MRTV_IPTV_BOT_TOKEN missing)');
    return false;
  }

  const me = await tg('getMe');
  botUsername = me.username;
  console.log(`Mister TV IPTV bot online as @${botUsername} (webhook)`);

  await tg('setMyCommands', { commands: COMMANDS }).catch((err) =>
    console.warn(`Could not set commands: ${err.message}`),
  );

  const base = process.env.RENDER_EXTERNAL_URL || 'https://apex-dashboard-c0fq.onrender.com';
  const url = process.env.MRTV_IPTV_WEBHOOK_URL || `${base.replace(/\/$/, '')}${ROUTE}`;
  const payload = { url, allowed_updates: ['message', 'callback_query'] };
  if (process.env.MRTV_IPTV_WEBHOOK_SECRET) {
    payload.secret_token = process.env.MRTV_IPTV_WEBHOOK_SECRET;
  }
  await tg('setWebhook', payload);
  console.log(`Mister TV IPTV bot webhook set: ${url}`);
  return true;
}

module.exports = { registerIptvBotWebhook, initIptvBot, ROUTE };

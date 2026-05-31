'use strict';

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron   = require('node-cron');
const fs     = require('fs');
const { processMessage, buildSummary } = require('./handler');
const { flushNow } = require('./storage');

// ─── Global error handlers ─────────────────────────────────────────
process.on('unhandledRejection', (r) => console.error('[fatal] unhandledRejection:', r));
process.on('uncaughtException',  (e) => console.error('[fatal] uncaughtException:', e));

// ─── Per-chat session store (IN-MEMORY ONLY) ───────────────────────
// Sessions hold short-lived state: pending confirmations, undo closures,
// recent conversation history. These contain JS functions (closures) that
// cannot be JSON-serialized, and resuming a "did you want to delete X?"
// prompt after a restart would be confusing anyway. So sessions are
// intentionally ephemeral and rebuilt fresh each run.
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      pendingAction: null,   // { fn, prompt, expiresAt? }
      lastAction:    null,   // { undo, description, ts }
      lastView:      null,   // last list shown, for "delete #2" style refs
      history:       []      // recent messages, capped
    });
  }
  return sessions.get(chatId);
}

// ─── WhatsApp client ───────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
    ],
  },
});

// ─── Send wrapper with prefix ──────────────────────────────────────
const BOT_PREFIX = '🤖: ';
const _send = client.sendMessage.bind(client);
client.sendMessage = (chatId, content, options) => {
  if (typeof content === 'string') content = BOT_PREFIX + content;
  return _send(chatId, content, options);
};

// ─── Lifecycle ─────────────────────────────────────────────────────
let isReady = false;
let reconnecting = false;

client.on('qr', (qr) => {
  console.log('\n' + '═'.repeat(52));
  console.log('📱  SCAN QR CODE WITH WHATSAPP');
  console.log('═'.repeat(52) + '\n');
  qrcode.generate(qr, { small: true });
  fs.writeFileSync('./qr-data.txt', qr);
});

client.on('authenticated', () => {
  console.log('✅ Authenticated.');
  if (fs.existsSync('./qr-data.txt')) fs.unlinkSync('./qr-data.txt');
});

client.on('auth_failure', (m) => console.error('❌ Auth failed:', m));

client.on('ready', () => {
  isReady = true;
  console.log('🤖 Family assistant ready.');
});

client.on('disconnected', async (reason) => {
  isReady = false;
  console.warn('⚠️  Disconnected:', reason);
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(async () => {
    try {
      await client.destroy();
      await client.initialize();
    } catch (err) {
      console.error('[reconnect] failed, exiting for pm2 restart:', err);
      process.exit(1);
    } finally {
      reconnecting = false;
    }
  }, 10_000);
});

// ─── Incoming messages ─────────────────────────────────────────────
client.on('message_create', async (msg) => {
  try {
    const chatId = msg.id.remote;
    if (msg.type !== 'chat') return;
    if (chatId !== process.env.GROUP_CHAT_ID) return;
    if (msg.fromMe && msg.body.startsWith(BOT_PREFIX)) return;

    console.log(`[msg] ${chatId} ${msg.author || 'self'}: ${msg.body}`);

    const session = getSession(chatId);
    session.history.push({
      role:   'user',
      author: msg.author || 'self',
      body:   msg.body,
      ts:     Date.now()
    });
    if (session.history.length > 20) session.history.shift();

    await processMessage(client, msg, session);
  } catch (err) {
    console.error('[bot] message error:', err);
  }
});

// ─── Daily summary ─────────────────────────────────────────────────
const cronSchedule = process.env.DAILY_REMINDER_CRON || '0 7 * * *';
const cronTz       = process.env.TZ || 'Asia/Hong_Kong';

cron.schedule(cronSchedule, async () => {
  console.log(`[${new Date().toISOString()}] daily reminder tick`);
  if (!isReady) {
    console.warn('[reminder] client not ready, skipping');
    return;
  }
  try {
    const target = process.env.GROUP_CHAT_ID
                || (process.env.FALLBACK_PHONE_NUMBER
                    ? process.env.FALLBACK_PHONE_NUMBER + '@c.us'
                    : null);
    if (!target) return console.error('[reminder] no target configured');

    const summary = await buildSummary();
    await client.sendMessage(target, summary);
    console.log('[reminder] ✅ sent');
  } catch (err) {
    console.error('[reminder] ❌', err.message);
  }
}, { timezone: cronTz });

// ─── Heartbeat ─────────────────────────────────────────────────────
setInterval(() => {
  console.log(`[heartbeat] ready=${isReady} sessions=${sessions.size}`);
}, 5 * 60 * 1000);

// ─── Graceful shutdown ─────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[${signal}] shutting down...`);
  try { flushNow(); } catch (e) { console.error('[shutdown] flush failed:', e); }
  try { await client.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ─────────────────────────────────────────────────────────
console.log('🚀 Starting Family WhatsApp Bot...');
client.initialize();
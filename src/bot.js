'use strict';

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode               = require('qrcode-terminal');
const cron                 = require('node-cron');
const fs                   = require('fs');
const { processMessage, buildSummary } = require('./handler');

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
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
            '--no-zygote',
            '--single-process',   // Important for low-RAM EC2 instances
            '--disable-gpu',
        ],
    },
});

// ─── Bot Message Prefix ───────────────────────────────────────────────────────
const BOT_PREFIX = '🤖: ';
const _send = client.sendMessage.bind(client);
client.sendMessage = (chatId, content, options) => {
    if (typeof content === 'string') content = BOT_PREFIX + content;
    return _send(chatId, content, options);
};

// ─── QR Code ─────────────────────────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('\n' + '═'.repeat(52));
    console.log('📱  SCAN THIS QR CODE WITH WHATSAPP ON YOUR BOT PHONE');
    console.log('═'.repeat(52) + '\n');
    qrcode.generate(qr, { small: true });

    // Also save raw QR data to file in case the terminal renders it badly
    fs.writeFileSync('./qr-data.txt', qr);
    console.log('\n💡 If the QR above is hard to scan:');
    console.log('   1. Copy the contents of qr-data.txt');
    console.log('   2. Paste into https://www.qr-code-generator.com/');
    console.log('   3. Scan the generated image with WhatsApp\n');
});

client.on('authenticated', () => {
    console.log('✅ Authenticated! Session saved — won\'t need to scan QR again.');
    if (fs.existsSync('./qr-data.txt')) fs.unlinkSync('./qr-data.txt');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Auth failed:', msg);
    console.error('   Delete .wwebjs_auth folder and restart to re-scan QR.');
});

client.on('ready', async () => {
    console.log('\n' + '═'.repeat(52));
    console.log('🤖  FAMILY ASSISTANT IS READY!');
    console.log('═'.repeat(52));

    const schedule = process.env.DAILY_REMINDER_CRON || '0 0 * * *';
    console.log(`⏰ Daily reminder cron: "${schedule}"`);
    console.log(`   (use https://crontab.guru to adjust the time)\n`);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️  Disconnected:', reason, '— reconnecting in 10s...');
    setTimeout(() => client.initialize(), 10_000);
});

// ─── Incoming Messages ────────────────────────────────────────────────────────
client.on('message_create', async (msg) => {
    try {
        const chatId = msg.id.remote;
        if (msg.type !== 'chat') return;
        if (chatId !== process.env.GROUP_CHAT_ID) return;
        if (msg.body.startsWith('🤖: ')) return;
        console.log(`[msg] from: ${chatId} type: ${msg.type} body: ${msg.body}`);
        await processMessage(client, msg);
    } catch (err) {
        console.error('[bot] Unhandled message error:', err);
    }
});

// ─── Daily Morning Summary ────────────────────────────────────────────────────
// Default: 8:00 AM HKT (UTC+8) = 00:00 UTC every day
// Set DAILY_REMINDER_CRON in .env to override, e.g. "0 6 * * *" for 6am UTC
const cronSchedule = process.env.DAILY_REMINDER_CRON || '0 0 * * *';

cron.schedule(cronSchedule, async () => {
    console.log(`[${new Date().toISOString()}] Sending daily reminder...`);
    try {
        const target = process.env.GROUP_CHAT_ID
                    || (process.env.FALLBACK_PHONE_NUMBER
                        ? process.env.FALLBACK_PHONE_NUMBER + '@c.us'
                        : null);

        if (!target) {
            console.error('[reminder] No GROUP_CHAT_ID or FALLBACK_PHONE_NUMBER set — skipping.');
            return;
        }

        const summary = buildSummary();
        await client.sendMessage(target, summary);
        console.log('[reminder] ✅ Sent successfully');
    } catch (err) {
        console.error('[reminder] ❌ Failed:', err.message);
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('🚀 Starting Family WhatsApp Bot...');
client.initialize();
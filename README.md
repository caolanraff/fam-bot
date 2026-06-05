# fam-bot

Family WhatsApp AI assistant using OpenRouter and a local Node bot.

## Prerequisites

- Node.js 18+ and `npm`.
- `pm2` installed globally (optional but recommended):
  `npm install -g pm2`
- OpenRouter account with credit balance and API key.
- WhatsApp group ID and user IDs (see below).

## OpenRouter setup

1. Create account at https://openrouter.ai
2. Buy credits (or use free trial credits).
3. Go to https://openrouter.ai/settings/credits and copy your API key.

## Environment (`.env`)

Create `.env` from `.env.example` or manually with at least:

```env
OPENROUTER_API_KEY=<your_openrouter_api_key>
WHATSAPP_GROUP_ID=<whatsapp_group_id>
WHATSAPP_USER_IDS=<user_id_1>,<user_id_2>,...
OTHER_SETTINGS=...
```

- `WHATSAPP_GROUP_ID`: ID of the group chat the bot listens to.
- `WHATSAPP_USER_IDS`: comma-separated user IDs for auth/mentions.

## Getting WhatsApp group/user IDs

### Group IDs
- For WhatsApp Cloud API: group ID is the `id` from group webhook events.
- For self-hosted WhatsApp APIs: use group query endpoint (or inspect `messages` payload) for `chatId`.
- Locally (whatsapp-web.js): run `node src/scripts/getgroups.js` and use output `"<group name>" => <groupId>`. Set `WHATSAPP_GROUP_ID` in `.env`.

### User IDs
- For WhatsApp Cloud API: user IDs appear as `from` in webhook events.
- For self-hosted WhatsApp APIs: inspect `messages` payload for `user.id`.
- Locally (whatsapp-web.js): run `node src/scripts/getuser.js <phone>` to resolve mobile number to WhatsApp contact ID (e.g. `1234567890@c.us`).

### Scripts
- `node src/scripts/getgroups.js` prints all group IDs.
- `node src/scripts/getuser.js +441234567890` prints the resolved contact ID for the given phone number.

## Install dependencies

```bash
npm install
```

## Run on EC2

1. (Optional) Run `./build/ec2_setup.sh` on new EC2 to install dependencies, configure environment, and set up system settings.
2. From project root:

```bash
npm install
```

3. Start process with PM2:

```bash
npm install -g pm2
pm2 start src/bot.js --name fam-bot
pm2 save
pm2 startup
```

## PM2 commands

- `pm2 start src/bot.js --name fam-bot`
- `pm2 stop fam-bot`
- `pm2 restart fam-bot`
- `pm2 delete fam-bot`
- `pm2 logs fam-bot --lines 100`
- `pm2 list`
- `less /home/ec2-user/.pm2/logs/fam-bot-out.log`

## First run and QR login

On first run, `bot.js` uses `whatsapp-web.js` and will print a QR code in terminal (or open a Chrome instance if configured) that you need to scan from the WhatsApp account you want to use as the bot agent.

- Use one WhatsApp account as the AI agent (a family member/owner account), or provision a dedicated WhatsApp number for bot use.
- After scanning, session gets stored at `./.wwebjs_auth` (or your configured auth folder).

Run:

```bash
npm run start
```

## Quick validation

- Confirm `OPENROUTER_API_KEY` is accessible from process.
- Confirm bot receives WhatsApp webhook payloads and can parse `groupId`, `from` and text.

## Notes

- Keep `.env` private.
- Monitor OpenRouter usage and top up credits to avoid interruptions.
- If using EC2, run `./ec2_setup.sh` once, then use `pm2` to keep it running across restarts.


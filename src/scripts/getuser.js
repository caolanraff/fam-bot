const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

function normalizePhone(input) {
  const value = String(input).trim();
  if (!value) return null;
  if (value.endsWith('@c.us') || value.endsWith('@g.us')) return value;

  // Allow +44, 0044 etc; strip non-digits
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

async function resolveUserId(rawInput) {
  const normalized = normalizePhone(rawInput);
  if (!normalized) return { input: rawInput, error: 'invalid-number' };

  let foundId = null;

  // 1) If whatsapp-web.js method is available, try it first.
  if (typeof client.getNumberId === 'function') {
    try {
      const inputForNumberId = normalized.endsWith('@c.us') ? normalized.replace(/@c\.us$/, '') : normalized;
      const numberId = await client.getNumberId(inputForNumberId);
      if (numberId && numberId._serialized) {
        foundId = numberId._serialized;
      }
    } catch (err) {
      // ignore and fall back
    }
  }

  // 2) Try getContactById for exact normalized ID.
  if (!foundId) {
    try {
      const contact = await client.getContactById(normalized);
      if (contact && contact.id && contact.id._serialized) {
        foundId = contact.id._serialized;
      }
    } catch (err) {
      // ignore and fall back
    }
  }

  // 3) Search cache by number if still not found.
  if (!foundId) {
    try {
      const contacts = await client.getContacts();
      const plain = normalized.replace(/@c\.us$/, '');
      const match = contacts.find(c => {
        if (!c || !c.id) return false;
        if (c.id._serialized === normalized) return true;
        if (String(c.id.user) === plain) return true;
        if (c.number && String(c.number).replace(/[^0-9]/g, '') === plain) return true;
        return false;
      });
      if (match && match.id && match.id._serialized) {
        foundId = match.id._serialized;
      }
    } catch (err) {
      // ignore
    }
  }

  return { input: rawInput, result: foundId || 'NOT_FOUND', normalized };
}

client.on('ready', async () => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node getuser.js <phone_number> [<phone_number> ...]');
    console.log('Example: node getuser.js +441234567890 15551234567');
    await client.destroy();
    process.exit(1);
  }

  for (const raw of args) {
    const { input, result, normalized, error } = await resolveUserId(raw);
    if (error) {
      console.log(`${input} => ERROR (${error})`);
    } else {
      console.log(`${input} => ${result} (normalized: ${normalized})`);
    }
  }

  await client.destroy();
  process.exit(0);
});

client.initialize();

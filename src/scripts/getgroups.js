const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    },
});

client.on('ready', async () => {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    if (groups.length === 0) {
        console.log('No groups found!');
    } else {
        groups.forEach(g => console.log(`"${g.name}" => ${g.id._serialized}`));
    }
    await client.destroy();
    process.exit(0);
});

client.initialize();
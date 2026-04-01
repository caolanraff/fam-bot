'use strict';

require('dotenv').config();
const OpenAI     = require('openai');
const { get, set } = require('./storage');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

// Phone numbers allowed to control the bot (digits only, with country code)
// e.g. "27821234567,27829876543"
const ALLOWED = (process.env.ALLOWED_NUMBERS || '')
    .split(',').map(n => n.replace(/\D/g, '')).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point — called from bot.js for every incoming text message
// ─────────────────────────────────────────────────────────────────────────────
async function processMessage(client, msg) {
    const chatId    = msg.id.remote;
    const isGroup   = chatId.endsWith('@g.us');
    const senderJid = isGroup ? (msg.author || '') : chatId;
    const senderNum = senderJid.replace(/@.*/, '');

    const groupChatId = process.env.GROUP_CHAT_ID;
    if (groupChatId) {
        if (!isGroup || chatId !== groupChatId) return;
    }

    // ── Allowed-numbers filter ──────────────────────────────────────────────
    if (ALLOWED.length > 0 && !ALLOWED.includes(senderNum)) {
        console.log(`[bot] Ignored message from unauthorised number: ${senderNum}`);
        return;
    }

    const userText = msg.body?.trim();
    if (!userText) return;

    // Grab sender display name for personalised AI replies
    let senderName = 'there';
    try {
        const contact = await msg.getContact();
        senderName = contact.pushname || contact.name || senderName;
    } catch {}

    console.log(`[${new Date().toISOString()}] ${senderName}: "${userText}"`);

    let reply;
    try {
        const history = get('history').messages || [];
        const parsed  = await parseIntent(userText, history, senderName);
        const { intent, data, reply: aiReply } = parsed;

        console.log(`[bot] Intent: ${intent}`, JSON.stringify(data));

        if (['add_event', 'remove_event', 'view_calendar'].includes(intent)) {
            reply = handleCalendar(intent, data);
        } else if (['add_todo', 'complete_todo', 'remove_todo', 'clear_completed', 'view_todo'].includes(intent)) {
            reply = handleTodo(intent, data);
        } else if (['add_shopping', 'remove_shopping', 'check_shopping', 'clear_shopping', 'view_shopping'].includes(intent)) {
            reply = handleShopping(intent, data);
        } else if (['add_meal', 'remove_meal', 'view_meals'].includes(intent)) {
            reply = handleMeals(intent, data);
        } else if (intent === 'summary') {
            reply = buildSummary();
        } else if (intent === 'help') {
            reply = HELP_TEXT;
        } else {
            reply = aiReply || `I'm not sure how to help with that 🤔\nSay *help* to see what I can do!`;
        }

        if (!reply) reply = aiReply || 'Done! ✅';

        // Persist conversation history (last 10 exchanges = 20 messages)
        const hist = get('history').messages || [];
        hist.push({ role: 'user',      content: userText });
        hist.push({ role: 'assistant', content: reply    });
        set('history', { messages: hist.slice(-20) });

    } catch (err) {
        console.error('[bot] Error processing message:', err);
        reply = '❌ Something went wrong on my end — please try again!';
    }

    try {
        await msg.reply(reply);
    } catch (err) {
        console.error('[bot] Failed to send reply:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI — Natural Language → Structured Intent
// ─────────────────────────────────────────────────────────────────────────────
async function parseIntent(userMessage, history, senderName) {
    const now = new Date();

    const systemPrompt = `You are a friendly family assistant WhatsApp bot for a couple.
You manage their Calendar, To-Do List, Shopping List, and Meal Plan.
The person messaging right now is: ${senderName}.
Today is ${now.toDateString()} — ${now.toLocaleDateString('en-US', { weekday: 'long' })}.

Respond ONLY with valid JSON in this exact shape (no markdown, no extra text):
{
  "intent": string,
  "data": object,
  "reply": string
}

INTENTS:

Calendar
  add_event     → { title, date (YYYY-MM-DD), time ("HH:MM" 24h, optional), notes (optional) }
  remove_event  → { title } or { index: number }
  view_calendar → {}

To-Do
  add_todo        → { item: string }
  complete_todo   → { index: number } or { item: string }
  remove_todo     → { index: number } or { item: string }
  clear_completed → {}
  view_todo       → {}

Shopping
  add_shopping    → single: { item, quantity (optional) }
                    multiple: { items: [{ item, quantity }] }
  remove_shopping → { index: number } or { item: string }
  check_shopping  → { index: number } or { item: string }
  clear_shopping  → {}
  view_shopping   → {}

Meal Plan
  add_meal    → { day (full name e.g. "Monday"), mealType ("breakfast"|"lunch"|"dinner"), food }
  remove_meal → { day, mealType }
  view_meals  → {}

Other
  summary → {}
  help    → {}
  unknown → {}

RULES:
- Convert relative dates like "tomorrow", "next Friday", "in 3 days" to YYYY-MM-DD.
- If multiple shopping items are listed in one message, use the items array format.
- The "reply" field is a SHORT friendly fallback sentence only — the code sends the real reply.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-10),
        { role: 'user',   content: userMessage },
    ];

    const res = await openai.chat.completions.create({
        model:           process.env.OPENAI_MODEL,
        messages,
        response_format: { type: 'json_object' },
        temperature:     0.2,
    });

    return JSON.parse(res.choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────
function fmtDate(dateStr) {
    // Append midday to avoid timezone-shifted off-by-one days
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────────────────────
function handleCalendar(intent, data) {
    const rec    = get('calendar');
    const events = rec.events || [];

    if (intent === 'add_event') {
        events.push({
            id:    Date.now().toString(),
            title: data.title,
            date:  data.date,
            time:  data.time  || null,
            notes: data.notes || null,
        });
        events.sort((a, b) =>
            new Date(`${a.date}T${a.time || '00:00'}`) -
            new Date(`${b.date}T${b.time || '00:00'}`)
        );
        set('calendar', { events });
        return (
            `📅 *Added to calendar!*\n\n` +
            `*${data.title}*\n` +
            `📅 ${fmtDate(data.date)}` +
            (data.time  ? `\n⏰ ${data.time}`   : '') +
            (data.notes ? `\n📝 ${data.notes}` : '')
        );
    }

    if (intent === 'remove_event') {
        const idx = typeof data.index === 'number'
            ? data.index - 1
            : events.findIndex(e =>
                e.title.toLowerCase().includes((data.title || '').toLowerCase())
              );
        if (idx >= 0 && idx < events.length) {
            const [removed] = events.splice(idx, 1);
            set('calendar', { events });
            return `🗑️ Removed *${removed.title}* from the calendar.`;
        }
        return `❌ Couldn't find that event. Say *show calendar* to see your list.`;
    }

    if (intent === 'view_calendar') {
        const todayStr = new Date().toISOString().split('T')[0];
        const upcoming = events.filter(e => e.date >= todayStr);
        if (!upcoming.length) return `📅 Calendar is clear — no upcoming events!`;
        const list = upcoming.slice(0, 10).map((e, i) =>
            `${i + 1}. *${e.title}*\n` +
            `   📅 ${fmtDate(e.date)}` +
            (e.time  ? ` ⏰ ${e.time}`   : '') +
            (e.notes ? `\n   📝 ${e.notes}` : '')
        ).join('\n\n');
        return `📅 *Upcoming Events:*\n\n${list}`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// To-Do
// ─────────────────────────────────────────────────────────────────────────────
function handleTodo(intent, data) {
    const rec   = get('todo');
    const items = rec.items || [];

    if (intent === 'add_todo') {
        items.push({
            id:      Date.now().toString(),
            text:    data.item,
            done:    false,
            addedAt: new Date().toISOString(),
        });
        set('todo', { items });
        return `✅ Added to to-do list:\n*${data.item}*`;
    }

    if (intent === 'complete_todo') {
        const pending = items.filter(i => !i.done);
        const target  = typeof data.index === 'number'
            ? pending[data.index - 1]
            : pending.find(i =>
                i.text.toLowerCase().includes((data.item || '').toLowerCase())
              );
        if (target) {
            target.done        = true;
            target.completedAt = new Date().toISOString();
            set('todo', { items });
            return `✅ *${target.text}* — marked as done! 🎉`;
        }
        return `❌ Couldn't find that item. Say *show to-do* to see your list.`;
    }

    if (intent === 'remove_todo') {
        const pending = items.filter(i => !i.done);
        const target  = typeof data.index === 'number'
            ? pending[data.index - 1]
            : items.find(i =>
                i.text.toLowerCase().includes((data.item || '').toLowerCase())
              );
        if (target) {
            items.splice(items.indexOf(target), 1);
            set('todo', { items });
            return `🗑️ Removed *${target.text}* from the list.`;
        }
        return `❌ Couldn't find that item.`;
    }

    if (intent === 'clear_completed') {
        const before = items.length;
        const kept   = items.filter(i => !i.done);
        set('todo', { items: kept });
        const removed = before - kept.length;
        return removed > 0
            ? `🧹 Cleared ${removed} completed item${removed !== 1 ? 's' : ''}!`
            : `Nothing to clear — no completed items yet.`;
    }

    if (intent === 'view_todo') {
        const pending = items.filter(i => !i.done);
        const done    = items.filter(i =>  i.done);
        if (!items.length) {
            return `📝 To-do list is empty!\n\nTry: _"Add call the plumber to to-do"_`;
        }
        let msg = `📝 *To-Do List:*\n\n`;
        if (pending.length) {
            msg += pending.map((item, i) => `${i + 1}. ⬜ ${item.text}`).join('\n');
        } else {
            msg += `_All done! Nothing pending_ 🎉`;
        }
        if (done.length) {
            msg += `\n\n*Completed (${done.length}):*\n` +
                   done.slice(-5).map(i => `✅ ${i.text}`).join('\n');
        }
        return msg;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopping
// ─────────────────────────────────────────────────────────────────────────────
function handleShopping(intent, data) {
    const rec   = get('shopping');
    const items = rec.items || [];

    if (intent === 'add_shopping') {
        // Support both single { item, quantity } and multi { items: [...] }
        const toAdd = data.items || [{ item: data.item, quantity: data.quantity }];
        const lines = [];

        for (const entry of toAdd) {
            if (!entry.item) continue;
            const existing = items.find(
                i => i.item.toLowerCase() === entry.item.toLowerCase() && !i.checked
            );
            if (existing) {
                if (entry.quantity) existing.quantity = entry.quantity;
                lines.push(`↩️ Updated: ${entry.item}`);
            } else {
                items.push({
                    id:       `${Date.now()}-${Math.random()}`,
                    item:     entry.item,
                    quantity: entry.quantity || null,
                    checked:  false,
                });
                lines.push(`• ${entry.quantity ? entry.quantity + ' ' : ''}${entry.item}`);
            }
        }

        set('shopping', { items });
        if (lines.length === 1) {
            return `🛒 Added to shopping list:\n*${lines[0].replace('• ', '')}*`;
        }
        return `🛒 *Added to shopping list:*\n${lines.join('\n')}`;
    }

    if (intent === 'check_shopping') {
        const unchecked = items.filter(i => !i.checked);
        const target    = typeof data.index === 'number'
            ? unchecked[data.index - 1]
            : items.find(i =>
                i.item.toLowerCase().includes((data.item || '').toLowerCase())
              );
        if (target) {
            target.checked = !target.checked;
            set('shopping', { items });
            return `${target.checked ? '✅' : '🔲'} *${target.item}* — ${target.checked ? 'got it!' : 'unchecked.'}`;
        }
        return `❌ Couldn't find that item.`;
    }

    if (intent === 'remove_shopping') {
        const idx = typeof data.index === 'number'
            ? items.indexOf(items.filter(i => !i.checked)[data.index - 1])
            : items.findIndex(i =>
                i.item.toLowerCase().includes((data.item || '').toLowerCase())
              );
        if (idx >= 0 && idx < items.length) {
            const [removed] = items.splice(idx, 1);
            set('shopping', { items });
            return `🗑️ Removed *${removed.item}* from the shopping list.`;
        }
        return `❌ Couldn't find that item.`;
    }

    if (intent === 'clear_shopping') {
        set('shopping', { items: [] });
        return `🛒 Shopping list cleared! Fresh start.`;
    }

    if (intent === 'view_shopping') {
        if (!items.length) {
            return `🛒 Shopping list is empty!\n\nTry: _"Add milk and eggs to shopping"_`;
        }
        const unchecked = items.filter(i => !i.checked);
        const checked   = items.filter(i =>  i.checked);
        let msg = `🛒 *Shopping List:*\n\n`;
        if (unchecked.length) {
            msg += unchecked.map((i, n) =>
                `${n + 1}. 🔲 ${i.quantity ? i.quantity + ' ' : ''}${i.item}`
            ).join('\n');
        } else {
            msg += `_All items checked off!_ ✅`;
        }
        if (checked.length) {
            msg += `\n\n*Got:*\n` + checked.map(i => `✅ ${i.item}`).join('\n');
        }
        return msg;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meal Plan
// ─────────────────────────────────────────────────────────────────────────────
function handleMeals(intent, data) {
    const rec  = get('meals');
    const plan = rec.plan || {};
    const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const MEAL_EMOJI = { breakfast: '🌅', lunch: '☀️', dinner: '🌙' };

    if (intent === 'add_meal') {
        const day = DAYS.find(d => d.toLowerCase() === (data.day || '').toLowerCase()) || data.day;
        if (!plan[day]) plan[day] = {};
        plan[day][data.mealType] = data.food;
        set('meals', { plan });
        const emoji = MEAL_EMOJI[data.mealType] || '🍽️';
        const label = data.mealType.charAt(0).toUpperCase() + data.mealType.slice(1);
        return `${emoji} *${label}* on *${day}:*\n${data.food}`;
    }

    if (intent === 'remove_meal') {
        const day = DAYS.find(d => d.toLowerCase() === (data.day || '').toLowerCase()) || data.day;
        if (plan[day]?.[data.mealType]) {
            const removed = plan[day][data.mealType];
            delete plan[day][data.mealType];
            if (!Object.keys(plan[day]).length) delete plan[day];
            set('meals', { plan });
            return `🗑️ Removed ${data.mealType} (${removed}) from ${day}.`;
        }
        return `❌ No ${data.mealType} found for ${data.day}.`;
    }

    if (intent === 'view_meals') {
        if (!Object.keys(plan).length) {
            return `🍽️ Meal plan is empty!\n\nTry: _"Add pasta for Monday dinner"_`;
        }
        let msg = `🍽️ *Meal Plan:*\n\n`;
        for (const day of DAYS) {
            if (plan[day] && Object.keys(plan[day]).length) {
                msg += `*${day}:*\n`;
                for (const meal of ['breakfast', 'lunch', 'dinner']) {
                    if (plan[day][meal]) {
                        const label = meal.charAt(0).toUpperCase() + meal.slice(1);
                        msg += `  ${MEAL_EMOJI[meal]} ${label}: ${plan[day][meal]}\n`;
                    }
                }
                msg += '\n';
            }
        }
        return msg.trim();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily Summary (also called on demand via "show summary")
// ─────────────────────────────────────────────────────────────────────────────
function buildSummary() {
    const now      = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const dayName  = now.toLocaleDateString('en-US', { weekday: 'long' });

    const calRec  = get('calendar');
    const todoRec = get('todo');
    const shopRec = get('shopping');
    const mealRec = get('meals');

    let msg        = `🌅 *Good morning! ${dayName}, ${fmtDate(todayStr)}*\n\n`;
    let hasContent = false;

    // Events happening today
    const todayEvents = (calRec.events || []).filter(e => e.date === todayStr);
    if (todayEvents.length) {
        hasContent = true;
        msg += `📅 *Today's Events:*\n`;
        todayEvents.forEach(e =>
            msg += `  • ${e.title}${e.time ? ` at ${e.time}` : ''}\n`
        );
        msg += '\n';
    }

    // Events in the next 48 hours (not today)
    const soon = (calRec.events || []).filter(e => {
        const diff = (new Date(e.date + 'T12:00:00') - now) / 86400000;
        return diff > 0 && diff <= 2;
    });
    if (soon.length) {
        hasContent = true;
        msg += `📆 *Coming Up Soon:*\n`;
        soon.forEach(e => msg += `  • ${e.title} — ${fmtDate(e.date)}\n`);
        msg += '\n';
    }

    // Pending to-dos
    const pending = (todoRec.items || []).filter(i => !i.done);
    if (pending.length) {
        hasContent = true;
        msg += `📝 *To-Do (${pending.length} pending):*\n`;
        pending.slice(0, 5).forEach(i => msg += `  • ${i.text}\n`);
        if (pending.length > 5) msg += `  _...and ${pending.length - 5} more_\n`;
        msg += '\n';
    }

    // Today's meals
    const todayMeals = mealRec.plan?.[dayName];
    if (todayMeals && Object.keys(todayMeals).length) {
        hasContent = true;
        msg += `🍽️ *Today's Meals:*\n`;
        const MEAL_EMOJI = { breakfast: '🌅', lunch: '☀️', dinner: '🌙' };
        for (const m of ['breakfast', 'lunch', 'dinner']) {
            if (todayMeals[m]) {
                const label = m.charAt(0).toUpperCase() + m.slice(1);
                msg += `  ${MEAL_EMOJI[m]} ${label}: ${todayMeals[m]}\n`;
            }
        }
        msg += '\n';
    }

    // Shopping count
    const shopCount = (shopRec.items || []).filter(i => !i.checked).length;
    if (shopCount > 0) {
        hasContent = true;
        msg += `🛒 *Shopping:* ${shopCount} item${shopCount !== 1 ? 's' : ''} on the list\n\n`;
    }

    msg += hasContent
        ? `Have a great day! 💪`
        : `Everything looks clear today — enjoy your day! 😊`;

    return msg.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Help Text
// ─────────────────────────────────────────────────────────────────────────────
const HELP_TEXT = `🤖 *Family Assistant — Commands:*

📅 *Calendar*
• "Add dentist on Friday at 2pm"
• "Add anniversary on June 15 with dinner reservation note"
• "Show calendar" / "Remove dentist"

📝 *To-Do*
• "Add fix the fence to to-do"
• "Show to-do list"
• "Mark item 2 done" / "Complete fix the fence"
• "Remove item 1" / "Clear completed items"

🛒 *Shopping*
• "Add milk, eggs and sourdough to shopping"
• "Add 2 litres of oat milk to shopping"
• "Show shopping list"
• "Check off item 3" / "Remove eggs"
• "Clear shopping list"

🍽️ *Meal Plan*
• "Add spaghetti bolognese for Monday dinner"
• "Add avocado toast for Saturday breakfast"
• "Show meal plan"
• "Remove Monday lunch"

📊 *Summary*
• "Show summary" / "What's on today?"`;

module.exports = { processMessage, buildSummary };
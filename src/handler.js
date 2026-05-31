'use strict';

require('dotenv').config();
const OpenAI       = require('openai');
const { get, set } = require('./storage');

const openai = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const ALLOWED = (process.env.ALLOWED_NUMBERS || '')
  .split(',').map(n => n.replace(/\D/g, '')).filter(Boolean);

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const MEAL_EMOJI = { breakfast: '🌅', lunch: '☀️', dinner: '🌙' };
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────
// Pending-action helpers
// ─────────────────────────────────────────────────────────────────
function isPendingLive(session) {
  return !!(session.pendingAction
    && (!session.pendingAction.expiresAt
        || session.pendingAction.expiresAt > Date.now()));
}

function setPending(session, action) {
  session.pendingAction = { ...action, expiresAt: Date.now() + PENDING_TTL_MS };
}

// ─────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────
async function processMessage(client, msg, session) {
  const chatId    = msg.id.remote;
  const isGroup   = chatId.endsWith('@g.us');
  const senderJid = isGroup ? (msg.author || '') : chatId;
  const senderNum = senderJid.replace(/@.*/, '');

  if (process.env.GROUP_CHAT_ID && (!isGroup || chatId !== process.env.GROUP_CHAT_ID)) return;
  if (ALLOWED.length && !ALLOWED.includes(senderNum)) {
    console.log(`[bot] ignored unauthorised sender: ${senderNum}`);
    return;
  }

  const userText = msg.body?.trim();
  if (!userText) return;

  let senderName = 'there';
  try {
    const c = await msg.getContact();
    senderName = c.pushname || c.name || senderName;
  } catch {}

  console.log(`[${new Date().toISOString()}] ${senderName}: "${userText}"`);

  let reply;
  try {
    const quick = userText.toLowerCase().trim();

    // Expire stale pending actions silently
    if (session.pendingAction && !isPendingLive(session)) {
      session.pendingAction = null;
    }

    // ── Fast path 1: numeric reply to a disambiguation prompt ──
    if (isPendingLive(session) && session.pendingAction.pickFromList) {
      const m = quick.match(/^#?(\d+)$/);
      if (m) {
        const n  = parseInt(m[1], 10);
        const fn = session.pendingAction.pickFromList;
        session.pendingAction = null;
        reply = await fn(n);
      } else if (/^(no|n|nope|cancel|stop|nvm|never ?mind)\b/.test(quick)) {
        session.pendingAction = null;
        reply = '👍 Cancelled — pick aborted.';
      }
      // else fall through; we'll let the LLM handle it but drop the pending pick
      else {
        session.pendingAction = null;
      }
    }

    // ── Fast path 2: yes / no while a confirmation is pending ──
    if (!reply && isPendingLive(session) && session.pendingAction.fn) {
      if (/^(yes|y|yep|yeah|sure|ok|okay|confirm|do it|go ahead)\b/.test(quick)) {
        reply = await executePendingAction(session);
      } else if (/^(no|n|nope|cancel|stop|nvm|never ?mind)\b/.test(quick)) {
        session.pendingAction = null;
        reply = '👍 Cancelled — nothing changed.';
      } else {
        // unrelated message — drop the pending and continue parsing
        session.pendingAction = null;
      }
    }

    if (!reply && /^(undo|revert|undo that)\b/i.test(quick)) {
      reply = performUndo(session);
    }

    if (!reply) {
      const parsed = await parseIntent(userText, session, senderName);
      const { intent, data, reply: aiReply } = parsed;
      console.log(`[bot] intent=${intent}`, JSON.stringify(data));

      reply = await dispatchIntent(intent, data, session, aiReply);
    }

    if (!reply) reply = "Done! ✅";

    // Persist last few turns inside session for LLM context
    session.history.push({ role: 'assistant', content: reply.replace(/\*/g, '') });
    if (session.history.length > 20) session.history.shift();

  } catch (err) {
    console.error('[bot] processMessage error:', err);
    reply = '❌ Something went wrong on my end — please try again!';
  }

  try {
    await msg.reply(reply);
  } catch (err) {
    console.error('[bot] send failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Intent dispatch
// ─────────────────────────────────────────────────────────────────
async function dispatchIntent(intent, data, session, aiReply) {
  switch (intent) {
    case 'add_event':
    case 'remove_event':
    case 'update_event':
    case 'view_calendar':
      return handleCalendar(intent, data, session);

    case 'add_todo':
    case 'complete_todo':
    case 'remove_todo':
    case 'clear_completed':
    case 'view_todo':
      return handleTodo(intent, data, session);

    case 'add_shopping':
    case 'remove_shopping':
    case 'check_shopping':
    case 'clear_shopping':
    case 'view_shopping':
      return handleShopping(intent, data, session);

    case 'add_meal':
    case 'remove_meal':
    case 'view_meals':
      return handleMeals(intent, data, session);

    case 'summary': return buildSummary();
    case 'help':    return HELP_TEXT;

    case 'confirm':
      return isPendingLive(session) && session.pendingAction.fn
        ? executePendingAction(session)
        : "Nothing to confirm right now 🤔";
    case 'cancel':
      session.pendingAction = null;
      return '👍 Cancelled.';
    case 'undo':
      return performUndo(session);

    default:
      return aiReply || `I'm not sure how to help with that 🤔\nSay *help* to see what I can do!`;
  }
}

// ─────────────────────────────────────────────────────────────────
// LLM intent parser — session-aware, with safe JSON parsing
// ─────────────────────────────────────────────────────────────────
async function parseIntent(userMessage, session, senderName) {
  const now = new Date();

  // Snapshot of current state to ground the LLM
  const events  = (get('calendar').events || []).slice(0, 15);
  const todos   = (get('todo').items     || []).filter(i => !i.done).slice(0, 10);
  const shop    = (get('shopping').items || []).filter(i => !i.checked).slice(0, 15);

  const contextSnapshot = {
    today:    now.toISOString().split('T')[0],
    weekday:  now.toLocaleDateString('en-US', { weekday: 'long' }),
    events:   events.map((e, i) => ({ index: i + 1, title: e.title, date: e.date, time: e.time })),
    todos:    todos.map((t, i)  => ({ index: i + 1, text: t.text })),
    shopping: shop.map((s, i)   => ({ index: i + 1, item: s.item, qty: s.quantity })),
    lastView: session.lastView || null,
  };

  const systemPrompt = `You are a friendly family assistant WhatsApp bot for a couple.
You manage their Calendar, To-Do List, Shopping List, and Meal Plan.
The person messaging right now is: ${senderName}.
Today is ${now.toDateString()} (${contextSnapshot.weekday}).

CURRENT STATE (use this to resolve references like "the staff party", "that one", "item 2"):
${JSON.stringify(contextSnapshot, null, 2)}

Respond ONLY with valid JSON in this exact shape:
{ "intent": string, "data": object, "reply": string }

INTENTS:

Calendar
  add_event     → { title, date (YYYY-MM-DD), time ("HH:MM" 24h, optional), notes (optional) }
  update_event  → { match: string OR index: number,
                    changes: { title?, date?, time?, notes? } }
                  Use this when user says "move", "reschedule", "change", "rename", "push back".
  remove_event  → { match: string OR index: number }
  view_calendar → {}

To-Do
  add_todo        → { item: string }
  complete_todo   → { index: number } OR { item: string }
  remove_todo     → { index: number } OR { item: string }
  clear_completed → {}
  view_todo       → {}

Shopping
  add_shopping    → single: { item, quantity? }
                    multiple: { items: [{ item, quantity? }, ...] }
  remove_shopping → { index: number } OR { item: string }
  check_shopping  → { index: number } OR { item: string }
  clear_shopping  → {}
  view_shopping   → {}

Meal Plan
  add_meal    → { day, mealType ("breakfast"|"lunch"|"dinner"), food }
  remove_meal → { day, mealType }
  view_meals  → {}

Other
  summary, help, confirm, cancel, undo, unknown → { }

RULES:
- Convert relative dates ("tomorrow", "next Friday", "in 3 days") to YYYY-MM-DD.
- For references like "the staff party" or "the dentist", set match to the user's exact phrase — the code will fuzzy-match against the events list above.
- If the user says "move X to Friday at 3", that is update_event, NOT remove + add.
- If multiple shopping items in one message, use the items array.
- "reply" is a short friendly fallback only — actual reply text is generated by code.
- A bare "yes"/"no"/"ok" should be intent confirm or cancel.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.slice(-8).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: typeof h.content === 'string' ? h.content : (h.body || '')
    })),
    { role: 'user', content: userMessage },
  ];

  let raw;
  try {
    const res = await openai.chat.completions.create({
      model:           process.env.OPENAI_MODEL,
      messages,
      response_format: { type: 'json_object' },
      temperature:     0.2,
      max_tokens:      800,
    });
    raw = res.choices[0].message.content;
  } catch (err) {
    console.error('[bot] LLM call failed:', err.message);
    return { intent: 'unknown', data: {}, reply: "I'm having trouble reaching my brain right now — try again in a moment?" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.intent !== 'string') {
      throw new Error('parsed JSON missing intent');
    }
    parsed.data  = parsed.data  || {};
    parsed.reply = parsed.reply || '';
    return parsed;
  } catch (e) {
    console.error('[bot] LLM returned non-JSON:', raw);
    return { intent: 'unknown', data: {}, reply: "Sorry, I got confused — could you rephrase?" };
  }
}

// ─────────────────────────────────────────────────────────────────
// Pending actions, undo, fuzzy matching, validation
// ─────────────────────────────────────────────────────────────────
async function executePendingAction(session) {
  const action = session.pendingAction;
  session.pendingAction = null;
  if (!action || !action.fn) return "Nothing to confirm right now 🤔";
  return action.fn();
}

function performUndo(session) {
  if (!session.lastAction || !session.lastAction.undo) {
    return "Nothing to undo right now.";
  }
  const result = session.lastAction.undo();
  session.lastAction = null;
  return `↩️  ${result}`;
}

// Token-overlap score: handles "staff party" → "Annual Staff Christmas Party"
function fuzzyScore(query, candidate) {
  const q = query.toLowerCase().split(/\W+/).filter(Boolean);
  const c = candidate.toLowerCase();
  if (!q.length) return 0;
  const hits = q.filter(t => c.includes(t)).length;
  return hits / q.length;
}

function bestMatches(query, list, getText, threshold = 0.5) {
  return list
    .map((item, i) => ({ item, i, score: fuzzyScore(query, getText(item)) }))
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

// Validation helpers
function isValidYMD(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00');
  return !isNaN(d) && d.toISOString().startsWith(s);
}
function isValidHM(s) {
  if (s == null || s === '') return true;
  if (typeof s !== 'string') return false;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = +m[1], min = +m[2];
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}
function normalizeHM(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// ─────────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────────
function handleCalendar(intent, data, session) {
  const rec    = get('calendar');
  const events = rec.events || [];

  if (intent === 'add_event') {
    if (!data.title || typeof data.title !== 'string') {
      return `❌ I didn't catch the event title — try again?`;
    }
    if (!isValidYMD(data.date)) {
      return `❌ I couldn't read the date for "${data.title}". When is it? (e.g. "Friday" or "March 12")`;
    }
    if (!isValidHM(data.time)) {
      return `❌ Time should be like 14:30 (24h) — got "${data.time}".`;
    }

    const ev = {
      id:    Date.now().toString(),
      title: data.title,
      date:  data.date,
      time:  normalizeHM(data.time) || null,
      notes: data.notes || null,
    };
    events.push(ev);
    sortEvents(events);
    set('calendar', { events });

    session.lastAction = {
      label: `Added ${ev.title}`,
      undo: () => {
        const cur = get('calendar').events || [];
        set('calendar', { events: cur.filter(e => e.id !== ev.id) });
        return `Removed *${ev.title}* (undo).`;
      }
    };

    return (
      `📅 *Added to calendar*\n\n` +
      `*${ev.title}*\n` +
      `📅 ${fmtDate(ev.date)}` +
      (ev.time  ? `\n⏰ ${ev.time}`   : '') +
      (ev.notes ? `\n📝 ${ev.notes}` : '') +
      `\n\n_Reply *undo* to revert._`
    );
  }

  if (intent === 'update_event') {
    const found = resolveEvent(events, data);
    if (found.error) return found.error;
    if (found.ambiguous) {
      // Stash the user's intended changes so a numeric reply completes the action
      const candidates = found.candidates;
      const pendingChanges = data.changes || {};
      setPending(session, {
        pickFromList: (n) => {
          const ev = candidates[n - 1];
          if (!ev) return `❌ ${n} isn't on the list — try again or say *cancel*.`;
          // Re-fetch fresh events list and find this event by id
          const freshEvents = get('calendar').events || [];
          const idx = freshEvents.findIndex(e => e.id === ev.id);
          if (idx === -1) return `❌ That event seems to be gone now.`;
          return handleCalendar('update_event', { index: idx + 1, changes: pendingChanges }, session);
        }
      });
      return found.ambiguous;
    }

    const ev      = found.event;
    const before  = { ...ev };
    const changes = data.changes || {};

    // Validate any incoming changes
    if (changes.date !== undefined && !isValidYMD(changes.date)) {
      return `❌ "${changes.date}" isn't a valid date.`;
    }
    if (changes.time !== undefined && changes.time !== null && !isValidHM(changes.time)) {
      return `❌ "${changes.time}" isn't a valid time (use HH:MM, 24h).`;
    }

    const fields  = ['title', 'date', 'time', 'notes'];
    let changedAny = false;
    for (const f of fields) {
      if (changes[f] !== undefined) {
        const val = f === 'time' ? normalizeHM(changes[f]) : changes[f];
        if (val !== ev[f]) {
          ev[f] = val;
          changedAny = true;
        }
      }
    }
    if (!changedAny) return `Nothing to change — *${ev.title}* already looks like that.`;

    sortEvents(events);
    set('calendar', { events });

    session.lastAction = {
      label: `Updated ${ev.title}`,
      undo: () => {
        const cur = get('calendar').events || [];
        const target = cur.find(e => e.id === before.id);
        if (target) Object.assign(target, before);
        sortEvents(cur);
        set('calendar', { events: cur });
        return `Reverted *${before.title}* to its previous details.`;
      }
    };

    const diff = fields
      .filter(f => before[f] !== ev[f])
      .map(f => {
        const a = f === 'date' ? fmtDate(before[f] || '') : (before[f] || '—');
        const b = f === 'date' ? fmtDate(ev[f] || '')      : (ev[f]     || '—');
        return `  • ${f}: ${a} → *${b}*`;
      }).join('\n');

    return `✏️ *Updated:* ${ev.title}\n${diff}\n\n_Reply *undo* to revert._`;
  }

  if (intent === 'remove_event') {
    const found = resolveEvent(events, data);
    if (found.error) return found.error;
    if (found.ambiguous) {
      const candidates = found.candidates;
      setPending(session, {
        pickFromList: (n) => {
          const ev = candidates[n - 1];
          if (!ev) return `❌ ${n} isn't on the list — try again or say *cancel*.`;
          const freshEvents = get('calendar').events || [];
          const idx = freshEvents.findIndex(e => e.id === ev.id);
          if (idx === -1) return `❌ That event seems to be gone now.`;
          return handleCalendar('remove_event', { index: idx + 1 }, session);
        }
      });
      return found.ambiguous;
    }

    const ev = found.event;
    const idx = events.indexOf(ev);
    events.splice(idx, 1);
    set('calendar', { events });

    session.lastAction = {
      label: `Removed ${ev.title}`,
      undo: () => {
        const cur = get('calendar').events || [];
        cur.push(ev);
        sortEvents(cur);
        set('calendar', { events: cur });
        return `Restored *${ev.title}*.`;
      }
    };

    return `🗑️ Removed *${ev.title}* (${fmtDate(ev.date)}${ev.time ? ' ' + ev.time : ''}).\n\n_Reply *undo* to restore._`;
  }

  if (intent === 'view_calendar') {
    const todayStr = new Date().toISOString().split('T')[0];
    const upcoming = events.filter(e => e.date >= todayStr);
    session.lastView = { type: 'calendar', items: upcoming.slice(0, 10).map(e => e.title) };

    if (!upcoming.length) return `📅 Calendar is clear — no upcoming events!`;
    const list = upcoming.slice(0, 10).map((e, i) =>
      `${i + 1}. *${e.title}*\n` +
      `   📅 ${fmtDate(e.date)}` +
      (e.time  ? ` ⏰ ${e.time}`     : '') +
      (e.notes ? `\n   📝 ${e.notes}` : '')
    ).join('\n\n');
    return `📅 *Upcoming Events:*\n\n${list}`;
  }
}

function sortEvents(events) {
  events.sort((a, b) =>
    new Date(`${a.date}T${a.time || '00:00'}`) -
    new Date(`${b.date}T${b.time || '00:00'}`)
  );
}

// Resolve { match, index } against events list with fuzzy matching + disambiguation
function resolveEvent(events, data) {
  if (!events.length) return { error: `📅 Calendar is empty.` };

  if (typeof data.index === 'number') {
    const ev = events[data.index - 1];
    return ev ? { event: ev } : { error: `❌ No event at index ${data.index}.` };
  }

  const query = data.match || data.title || '';
  if (!query) return { error: `Which event? Say *show calendar* to see them.` };

  const matches = bestMatches(query, events, e => e.title, 0.5);

  if (!matches.length) {
    return { error: `❌ Couldn't find an event matching "${query}". Say *show calendar* to see your list.` };
  }

  // Single clear winner if top score is meaningfully higher than #2
  if (matches.length === 1 || matches[0].score - (matches[1]?.score || 0) >= 0.25) {
    return { event: matches[0].item };
  }

  const top = matches.slice(0, 5);
  const ambiguous =
    `🤔 I found a few matches for "${query}" — which one?\n\n` +
    top.map((m, i) =>
      `${i + 1}. *${m.item.title}* — ${fmtDate(m.item.date)}${m.item.time ? ' ' + m.item.time : ''}`
    ).join('\n') +
    `\n\nReply with the number, or *cancel*.`;
  return { ambiguous, candidates: top.map(m => m.item) };
}

// ─────────────────────────────────────────────────────────────────
// To-Do
// ─────────────────────────────────────────────────────────────────
function handleTodo(intent, data, session) {
  const rec   = get('todo');
  const items = rec.items || [];

  if (intent === 'add_todo') {
    if (!data.item || typeof data.item !== 'string') {
      return `🤔 I didn't catch what to add. Try: _"add call the plumber to to-do"_`;
    }
    const item = {
      id: Date.now().toString(),
      text: data.item,
      done: false,
      addedAt: new Date().toISOString(),
    };
    items.push(item);
    set('todo', { items });

    session.lastAction = {
      label: `Added to-do ${item.text}`,
      undo: () => {
        const cur = get('todo').items || [];
        set('todo', { items: cur.filter(i => i.id !== item.id) });
        return `Removed *${item.text}* from to-do (undo).`;
      }
    };

    return `✅ Added to to-do list:\n*${data.item}*\n\n_Reply *undo* to revert._`;
  }

  if (intent === 'complete_todo') {
    const pending = items.filter(i => !i.done);
    const target  = typeof data.index === 'number'
      ? pending[data.index - 1]
      : (bestMatches(data.item || '', pending, t => t.text, 0.5)[0]?.item);
    if (!target) return `❌ Couldn't find that item. Say *show to-do* to see your list.`;

    target.done = true;
    target.completedAt = new Date().toISOString();
    set('todo', { items });

    session.lastAction = {
      label: `Completed ${target.text}`,
      undo: () => {
        const cur = get('todo').items || [];
        const t = cur.find(i => i.id === target.id);
        if (t) { t.done = false; delete t.completedAt; }
        set('todo', { items: cur });
        return `Marked *${target.text}* as not done again.`;
      }
    };

    return `✅ *${target.text}* — done! 🎉\n\n_Reply *undo* to unmark._`;
  }

  if (intent === 'remove_todo') {
    const target = typeof data.index === 'number'
      ? items.filter(i => !i.done)[data.index - 1]
      : (bestMatches(data.item || '', items, t => t.text, 0.5)[0]?.item);
    if (!target) return `❌ Couldn't find that item.`;

    const idx = items.indexOf(target);
    items.splice(idx, 1);
    set('todo', { items });

    session.lastAction = {
      label: `Removed to-do ${target.text}`,
      undo: () => {
        const cur = get('todo').items || [];
        cur.splice(Math.min(idx, cur.length), 0, target);
        set('todo', { items: cur });
        return `Restored *${target.text}*.`;
      }
    };

    return `🗑️ Removed *${target.text}* from the list.\n\n_Reply *undo* to restore._`;
  }

  if (intent === 'clear_completed') {
    const done = items.filter(i => i.done);
    if (!done.length) return `Nothing to clear — no completed items yet.`;

    setPending(session, {
      fn: () => {
        const kept = (get('todo').items || []).filter(i => !i.done);
        const removed = done.length;
        set('todo', { items: kept });
        session.lastAction = {
          label: `Cleared ${removed} completed`,
          undo: () => {
            const cur = get('todo').items || [];
            set('todo', { items: cur.concat(done) });
            return `Restored ${removed} completed item${removed !== 1 ? 's' : ''}.`;
          }
        };
        return `🧹 Cleared ${removed} completed item${removed !== 1 ? 's' : ''}.\n\n_Reply *undo* to restore._`;
      }
    });
    return `🧹 This will clear *${done.length}* completed item${done.length !== 1 ? 's' : ''}. Confirm? (*yes* / *no*)`;
  }

  if (intent === 'view_todo') {
    const pending = items.filter(i => !i.done);
    const done    = items.filter(i =>  i.done);
    session.lastView = { type: 'todo', items: pending.map(p => p.text) };

    if (!items.length) return `📝 To-do list is empty!\n\nTry: _"Add call the plumber to to-do"_`;

    let msg = `📝 *To-Do List:*\n\n`;
    msg += pending.length
      ? pending.map((it, i) => `${i + 1}. ⬜ ${it.text}`).join('\n')
      : `_All done! Nothing pending_ 🎉`;
    if (done.length) {
      msg += `\n\n*Completed (${done.length}):*\n` +
             done.slice(-5).map(i => `✅ ${i.text}`).join('\n');
    }
    return msg;
  }
}

// ─────────────────────────────────────────────────────────────────
// Shopping
// ─────────────────────────────────────────────────────────────────
function handleShopping(intent, data, session) {
  const rec   = get('shopping');
  const items = rec.items || [];

  if (intent === 'add_shopping') {
    const toAdd = data.items || [{ item: data.item, quantity: data.quantity }];
    const added = [];

    for (const entry of toAdd) {
      if (!entry || !entry.item) continue;
      const existing = items.find(
        i => i.item.toLowerCase() === entry.item.toLowerCase() && !i.checked
      );
      if (existing) {
        if (entry.quantity) existing.quantity = entry.quantity;
        added.push({ updated: true, ...entry });
      } else {
        const it = {
          id: `${Date.now()}-${Math.random()}`,
          item: entry.item,
          quantity: entry.quantity || null,
          checked: false,
        };
        items.push(it);
        added.push({ updated: false, ref: it, ...entry });
      }
    }

    if (!added.length) {
      return `🤔 I didn't catch what to add. Try: _"add 2L milk and eggs to shopping"_`;
    }

    set('shopping', { items });

    session.lastAction = {
      label: `Added ${added.length} shopping item(s)`,
      undo: () => {
        const cur = get('shopping').items || [];
        const ids = added.filter(a => !a.updated).map(a => a.ref.id);
        set('shopping', { items: cur.filter(i => !ids.includes(i.id)) });
        return `Removed ${ids.length} shopping item${ids.length !== 1 ? 's' : ''} (undo).`;
      }
    };

    const lines = added.map(a =>
      a.updated
        ? `↩️ Updated: ${a.item}`
        : `• ${a.quantity ? a.quantity + ' ' : ''}${a.item}`
    );
    if (lines.length === 1) {
      return `🛒 Added to shopping list:\n*${lines[0].replace(/^[•↩️ ]+/, '')}*\n\n_Reply *undo* to revert._`;
    }
    return `🛒 *Added to shopping list:*\n${lines.join('\n')}\n\n_Reply *undo* to revert._`;
  }

  if (intent === 'check_shopping') {
    const unchecked = items.filter(i => !i.checked);
    const target = typeof data.index === 'number'
      ? unchecked[data.index - 1]
      : (bestMatches(data.item || '', items, x => x.item, 0.5)[0]?.item);
    if (!target) return `❌ Couldn't find that item.`;

    const prev = target.checked;
    target.checked = !target.checked;
    set('shopping', { items });

    session.lastAction = {
      label: `Toggled ${target.item}`,
      undo: () => {
        const cur = get('shopping').items || [];
        const t = cur.find(i => i.id === target.id);
        if (t) t.checked = prev;
        set('shopping', { items: cur });
        return `Reverted *${target.item}*.`;
      }
    };
    return `${target.checked ? '✅' : '🔲'} *${target.item}* — ${target.checked ? 'got it!' : 'unchecked.'}\n\n_Reply *undo* to revert._`;
  }

  if (intent === 'remove_shopping') {
    const unchecked = items.filter(i => !i.checked);
    const target = typeof data.index === 'number'
      ? unchecked[data.index - 1]
      : (bestMatches(data.item || '', items, x => x.item, 0.5)[0]?.item);
    if (!target) return `❌ Couldn't find that item.`;

    const idx = items.indexOf(target);
    items.splice(idx, 1);
    set('shopping', { items });

    session.lastAction = {
      label: `Removed ${target.item}`,
      undo: () => {
        const cur = get('shopping').items || [];
        cur.splice(Math.min(idx, cur.length), 0, target);
        set('shopping', { items: cur });
        return `Restored *${target.item}*.`;
      }
    };
    return `🗑️ Removed *${target.item}* from shopping.\n\n_Reply *undo* to restore._`;
  }

  if (intent === 'clear_shopping') {
    if (!items.length) return `🛒 Shopping list is already empty.`;
    const snapshot = items.slice();
    setPending(session, {
      fn: () => {
        set('shopping', { items: [] });
        session.lastAction = {
          label: `Cleared shopping list`,
          undo: () => {
            set('shopping', { items: snapshot });
            return `Restored ${snapshot.length} shopping item${snapshot.length !== 1 ? 's' : ''}.`;
          }
        };
        return `🛒 Shopping list cleared.\n\n_Reply *undo* to restore ${snapshot.length} item${snapshot.length !== 1 ? 's' : ''}._`;
      }
    });
    return `🛒 This will clear *${items.length}* shopping item${items.length !== 1 ? 's' : ''}. Confirm? (*yes* / *no*)`;
  }

  if (intent === 'view_shopping') {
    session.lastView = { type: 'shopping', items: items.filter(i => !i.checked).map(x => x.item) };
    if (!items.length) return `🛒 Shopping list is empty!\n\nTry: _"Add milk and eggs to shopping"_`;
    const unchecked = items.filter(i => !i.checked);
    const checked   = items.filter(i =>  i.checked);
    let msg = `🛒 *Shopping List:*\n\n`;
    msg += unchecked.length
      ? unchecked.map((i, n) => `${n + 1}. 🔲 ${i.quantity ? i.quantity + ' ' : ''}${i.item}`).join('\n')
      : `_All items checked off!_ ✅`;
    if (checked.length) {
      msg += `\n\n*Got:*\n` + checked.map(i => `✅ ${i.item}`).join('\n');
    }
    return msg;
  }
}

// ─────────────────────────────────────────────────────────────────
// Meal Plan
// ─────────────────────────────────────────────────────────────────
function handleMeals(intent, data, session) {
  // Normalize at the boundary so the LLM's casing doesn't matter
  if (data.mealType) data.mealType = String(data.mealType).toLowerCase().trim();
  if (data.day) {
    const matched = DAYS.find(d => d.toLowerCase() === String(data.day).toLowerCase().trim());
    if (matched) data.day = matched;
  }

  const rec  = get('meals');
  const plan = rec.plan || {};

  if (intent === 'add_meal') {
    if (!DAYS.includes(data.day)) {
      return `❌ Which day? Try: _"add pasta for Monday dinner"_`;
    }
    if (!MEAL_TYPES.includes(data.mealType)) {
      return `❌ Meal type should be breakfast, lunch, or dinner.`;
    }
    if (!data.food || typeof data.food !== 'string') {
      return `🤔 What's the meal? Try: _"add pasta for Monday dinner"_`;
    }

    const day = data.day;
    const prev = plan[day]?.[data.mealType] || null;
    if (!plan[day]) plan[day] = {};
    plan[day][data.mealType] = data.food;
    set('meals', { plan });

    session.lastAction = {
      label: `Set ${day} ${data.mealType}`,
      undo: () => {
        const cur = get('meals').plan || {};
        if (prev === null) {
          if (cur[day]) { delete cur[day][data.mealType]; if (!Object.keys(cur[day]).length) delete cur[day]; }
        } else {
          if (!cur[day]) cur[day] = {};
          cur[day][data.mealType] = prev;
        }
        set('meals', { plan: cur });
        return `Reverted ${day} ${data.mealType}.`;
      }
    };

    const emoji = MEAL_EMOJI[data.mealType] || '🍽️';
    const label = data.mealType.charAt(0).toUpperCase() + data.mealType.slice(1);
    return `${emoji} *${label}* on *${day}:*\n${data.food}\n\n_Reply *undo* to revert._`;
  }

  if (intent === 'remove_meal') {
    if (!DAYS.includes(data.day)) {
      return `❌ Which day? Try: _"remove Monday dinner"_`;
    }
    if (!MEAL_TYPES.includes(data.mealType)) {
      return `❌ Meal type should be breakfast, lunch, or dinner.`;
    }
    const day = data.day;
    if (!plan[day]?.[data.mealType]) return `❌ No ${data.mealType} found for ${day}.`;
    const removed = plan[day][data.mealType];
    delete plan[day][data.mealType];
    if (!Object.keys(plan[day]).length) delete plan[day];
    set('meals', { plan });

    session.lastAction = {
      label: `Removed ${day} ${data.mealType}`,
      undo: () => {
        const cur = get('meals').plan || {};
        if (!cur[day]) cur[day] = {};
        cur[day][data.mealType] = removed;
        set('meals', { plan: cur });
        return `Restored ${day} ${data.mealType}: ${removed}.`;
      }
    };
    return `🗑️ Removed ${data.mealType} (${removed}) from ${day}.\n\n_Reply *undo* to restore._`;
  }

  if (intent === 'view_meals') {
    session.lastView = { type: 'meals' };
    if (!Object.keys(plan).length) return `🍽️ Meal plan is empty!\n\nTry: _"Add pasta for Monday dinner"_`;
    let msg = `🍽️ *Meal Plan:*\n\n`;
    for (const day of DAYS) {
      if (plan[day] && Object.keys(plan[day]).length) {
        msg += `*${day}:*\n`;
        for (const meal of MEAL_TYPES) {
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

// ─────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────
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

  const todayEvents = (calRec.events || []).filter(e => e.date === todayStr);
  if (todayEvents.length) {
    hasContent = true;
    msg += `📅 *Today's Events:*\n`;
    todayEvents.forEach(e => msg += `  • ${e.title}${e.time ? ` at ${e.time}` : ''}\n`);
    msg += '\n';
  }

  const soon = (calRec.events || []).filter(e => {
    const diff = (new Date(e.date + 'T12:00:00') - now) / 86400000;
    return diff > 0 && diff <= 2 && e.date !== todayStr;
  });
  if (soon.length) {
    hasContent = true;
    msg += `📆 *Coming Up Soon:*\n`;
    soon.forEach(e => msg += `  • ${e.title} — ${fmtDate(e.date)}\n`);
    msg += '\n';
  }

  const pending = (todoRec.items || []).filter(i => !i.done);
  if (pending.length) {
    hasContent = true;
    msg += `📝 *To-Do (${pending.length} pending):*\n`;
    pending.slice(0, 5).forEach(i => msg += `  • ${i.text}\n`);
    if (pending.length > 5) msg += `  _...and ${pending.length - 5} more_\n`;
    msg += '\n';
  }

  const todayMeals = mealRec.plan?.[dayName];
  if (todayMeals && Object.keys(todayMeals).length) {
    hasContent = true;
    msg += `🍽️ *Today's Meals:*\n`;
    for (const m of MEAL_TYPES) {
      if (todayMeals[m]) {
        const label = m.charAt(0).toUpperCase() + m.slice(1);
        msg += `  ${MEAL_EMOJI[m]} ${label}: ${todayMeals[m]}\n`;
      }
    }
    msg += '\n';
  }

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

// ─────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────
function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

const HELP_TEXT = `🤖 *Family Assistant — Commands:*

📅 *Calendar*
• "Add dentist on Friday at 2pm"
• "Move the staff party to next Saturday"   ← reschedule
• "Change dentist to 3pm"                   ← edit
• "Show calendar" / "Remove dentist"

📝 *To-Do*
• "Add fix the fence to to-do"
• "Show to-do" / "Mark item 2 done"
• "Remove item 1" / "Clear completed"

🛒 *Shopping*
• "Add milk, eggs and sourdough to shopping"
• "Add 2 litres of oat milk to shopping"
• "Show shopping" / "Check off item 3"
• "Remove eggs" / "Clear shopping"

🍽️ *Meal Plan*
• "Add spaghetti for Monday dinner"
• "Show meal plan" / "Remove Monday lunch"

📊 *Other*
• "Show summary" / "What's on today?"
• *undo* — revert the last change
• *yes* / *no* — confirm or cancel a pending action`;

module.exports = { processMessage, buildSummary };
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const TMP_FILE  = DATA_FILE + '.tmp';

const DEFAULTS = {
    calendar: { events: [] },
    todo:     { items:  [] },
    shopping: { items:  [] },
    meals:    { plan:   {} },
};

let cache       = null;   // in-memory mirror of data.json
let writeQueued = false;  // debounce flag

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function loadFromDisk() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULTS, null, 2));
            return clone(DEFAULTS);
        }
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return { ...clone(DEFAULTS), ...parsed };
    } catch (err) {
        console.error('[storage] read error:', err.message);
        return clone(DEFAULTS);
    }
}

function ensureLoaded() {
    if (cache === null) cache = loadFromDisk();
    return cache;
}

// Atomic write: write to .tmp then rename, so a crash mid-write
// can never leave a half-written data.json
function flush() {
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(cache, null, 2));
        fs.renameSync(TMP_FILE, DATA_FILE);
    } catch (err) {
        console.error('[storage] write error:', err.message);
    } finally {
        writeQueued = false;
    }
}

// Debounce writes within the same tick — multiple set() calls in one
// handler invocation become one disk write.
function scheduleFlush() {
    if (writeQueued) return;
    writeQueued = true;
    setImmediate(flush);
}

function get(key) {
    const data = ensureLoaded();
    return data[key] ?? clone(DEFAULTS[key] ?? {});
}

function set(key, value) {
    const data = ensureLoaded();
    data[key] = value;
    scheduleFlush();
}

// Optional: force a synchronous flush (e.g. on shutdown)
function flushNow() {
    if (writeQueued) flush();
}

module.exports = { get, set, flushNow };
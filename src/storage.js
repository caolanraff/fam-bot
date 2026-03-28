'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULTS = {
    calendar: { events:  [] },
    todo:     { items:   [] },
    shopping: { items:   [] },
    meals:    { plan:    {} },
    history:  { messages:[] },
};

function readAll() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULTS, null, 2));
            return JSON.parse(JSON.stringify(DEFAULTS));
        }
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        // Merge with defaults so new keys are never missing
        return { ...JSON.parse(JSON.stringify(DEFAULTS)), ...parsed };
    } catch (err) {
        console.error('[storage] Read error:', err.message);
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
}

function writeAll(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function get(key) {
    const data = readAll();
    return data[key] ?? JSON.parse(JSON.stringify(DEFAULTS[key] ?? {}));
}

function set(key, value) {
    const data = readAll();
    data[key] = value;
    writeAll(data);
}

module.exports = { get, set };
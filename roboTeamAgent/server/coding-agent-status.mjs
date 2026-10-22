import fs from 'node:fs/promises';
import path from 'node:path';
import { CODING_AGENT_NAMES } from './coding-agents.mjs';

// Whether a robot's home holds a login for each coding agent, and which agent ALA uses for it.
// Detection is passive: it only checks that credential files or rows exist where each CLI keeps
// them, never reads a credential value, and never runs a CLI. A stored login may still be expired
// or revoked; validity needs the CLI itself.
const FILE_LIMIT = 4 * 1024 * 1024;
const SOURCES = Object.freeze({
    codex: ['.codex/auth.json'],
    opencode: ['.local/share/opencode/auth.json', '.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
    pi: ['.pi/agent/auth.json'],
    claude: ['.claude/.credentials.json', '.claude/.claude.json'],
});
const ALA_CONFIG = '.ala/config.json';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const filled = value => (typeof value === 'string' && value.trim() !== '') || (isRecord(value) && Object.keys(value).length > 0);

// A robot controls these paths, so only a bounded regular file is ever opened (a FIFO would block).
async function readJson(file) {
    try {
        const metadata = await fs.lstat(file);
        if (!metadata.isFile() || metadata.size > FILE_LIMIT) return null;
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { return null; }
}

// Codex keeps an API key or ChatGPT tokens, or another login mode's fields, beside bookkeeping.
async function codexLoggedIn(home) {
    const auth = await readJson(path.join(home, '.codex/auth.json'));
    return isRecord(auth) && Object.entries(auth).some(([key, value]) => !['last_refresh', 'auth_mode'].includes(key) && filled(value));
}

// OpenCode keeps provider keys and OAuth logins in auth.json, and Console accounts and connector
// credentials in its database. An unreadable database counts as no login.
async function openCodeDatabaseLoggedIn(file) {
    try {
        const metadata = await fs.lstat(file);
        if (!metadata.isFile()) return false;
        for (const suffix of ['-wal', '-shm', '-journal']) {
            const sibling = await fs.lstat(file + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (sibling && !sibling.isFile()) return false;
        }
        const emit = process.emitWarning;
        process.emitWarning = () => {};
        let DatabaseSync;
        try { ({ DatabaseSync } = await import('node:sqlite')); } finally { process.emitWarning = emit; }
        const database = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
            const any = (table, where) => tables.has(table) && Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get());
            return any('account_state', 'active_account_id IS NOT NULL OR active_org_id IS NOT NULL')
                || any('control_account', 'active = 1') || any('credential', '1 = 1');
        } finally { database.close(); }
    } catch { return false; }
}

async function openCodeLoggedIn(home) {
    const auth = await readJson(path.join(home, '.local/share/opencode/auth.json'));
    if (isRecord(auth) && Object.values(auth).some(entry => isRecord(entry) && typeof entry.type === 'string')) return true;
    return openCodeDatabaseLoggedIn(path.join(home, '.local/share/opencode/opencode.db'));
}

// Pi stores { type: 'api_key', key | env } or { type: 'oauth', access, refresh } per provider.
async function piLoggedIn(home) {
    const auth = await readJson(path.join(home, '.pi/agent/auth.json'));
    return isRecord(auth) && Object.values(auth).some(entry => isRecord(entry)
        && ((entry.type === 'api_key' && (filled(entry.key) || filled(entry.env))) || (entry.type === 'oauth' && filled(entry.access))));
}

// Claude Code keeps a subscription login in .credentials.json and an API key in .claude.json,
// both under CLAUDE_CONFIG_DIR, which the robot shell and containers set to ~/.claude.
async function claudeLoggedIn(home) {
    const credentials = await readJson(path.join(home, '.claude/.credentials.json'));
    if (isRecord(credentials?.claudeAiOauth) && (filled(credentials.claudeAiOauth.accessToken) || filled(credentials.claudeAiOauth.refreshToken))) return true;
    const config = await readJson(path.join(home, '.claude/.claude.json'));
    return isRecord(config) && filled(config.primaryApiKey);
}

const DETECTORS = Object.freeze({ codex: codexLoggedIn, opencode: openCodeLoggedIn, pi: piLoggedIn, claude: claudeLoggedIn });

async function signature(home, files) {
    const parts = await Promise.all(files.map(async file => {
        const metadata = await fs.lstat(path.join(home, file)).catch(() => null);
        return metadata ? `${file}:${metadata.mtimeMs}:${metadata.size}` : `${file}:-`;
    }));
    return parts.join('|');
}

export function createCodingAgentStatus() {
    const cache = new Map();
    async function cached(key, home, files, compute) {
        const stamp = await signature(home, files);
        const entry = cache.get(key);
        if (entry?.stamp === stamp) return entry.value;
        const value = await compute();
        cache.set(key, { stamp, value });
        return value;
    }
    return {
        // { codex, opencode, pi, claude } as booleans; only re-read when one of the agent's files changes.
        async logins(home) {
            const entries = await Promise.all(CODING_AGENT_NAMES.map(async name =>
                [name, await cached(`${home}\0${name}`, home, SOURCES[name], () => DETECTORS[name](home))]));
            return Object.fromEntries(entries);
        },
        // The agent ALA uses for the robot: its configured codingAgent when the robot has it enabled,
        // otherwise the first enabled agent, which is what ALA's configuration defaults to.
        async activeAgent(home, codingAgents) {
            const configured = await cached(`${home}\0ala`, home, [ALA_CONFIG], async () => (await readJson(path.join(home, ALA_CONFIG)))?.codingAgent);
            return codingAgents.includes(configured) ? configured : codingAgents[0];
        },
        forget(home) {
            for (const key of cache.keys()) if (key.startsWith(`${home}\0`)) cache.delete(key);
        },
    };
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECRET_KEYS = new Set(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
const PLAIN_KEYS = new Set([
    'STRIPE_PUBLISHABLE_KEY',
    'STRIPE_PRICE_CREDITS',
    'STRIPE_PRICE_SUBSCRIPTION',
    'USERPERSISTO_CREDITS_PER_UNIT',
    'USERPERSISTO_BILLING_SUCCESS_URL',
    'USERPERSISTO_BILLING_CANCEL_URL',
]);

function settingsFile() {
    return process.env.USERPERSISTO_SETTINGS_FILE || '/data/settings.enc.json';
}

function key() {
    const raw = process.env.USERPERSISTO_SETTINGS_KEY || '';
    if (!raw) throw new Error('USERPERSISTO_SETTINGS_KEY is required.');
    return createHash('sha256').update(raw).digest();
}

function encrypt(text) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function decrypt(blob) {
    const [iv, tag, data] = String(blob).split('.');
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

async function load() {
    try {
        return JSON.parse(await readFile(settingsFile(), 'utf8'));
    } catch {
        return {};
    }
}

async function persist(state) {
    await mkdir(dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(state, null, 2), 'utf8');
}

export function maskSecret(value) {
    const v = String(value || '');
    if (v.length <= 10) return '*'.repeat(v.length);
    return v.slice(0, 6) + '*'.repeat(v.length - 10) + v.slice(-4);
}

export async function saveSettings(patch = {}) {
    const state = await load();
    for (const name of patch.remove || []) {
        delete state[name];
    }
    for (const [name, value] of Object.entries(patch)) {
        if (name === 'remove') continue;
        if (!SECRET_KEYS.has(name) && !PLAIN_KEYS.has(name)) throw new Error(`Unknown setting: ${name}`);
        if (value === '' || value === undefined || value === null) continue;
        state[name] = SECRET_KEYS.has(name) ? { secret: encrypt(value) } : { value: String(value) };
    }
    await persist(state);
}

export async function getSecret(name) {
    const state = await load();
    const entry = state[name];
    if (!entry) return '';
    return entry.secret ? decrypt(entry.secret) : String(entry.value || '');
}

export async function getSettings() {
    const state = await load();
    const view = {};
    for (const name of [...SECRET_KEYS, ...PLAIN_KEYS]) {
        const entry = state[name];
        if (!entry) {
            view[name] = '';
            continue;
        }
        view[name] = entry.secret ? maskSecret(decrypt(entry.secret)) : String(entry.value || '');
    }
    return view;
}

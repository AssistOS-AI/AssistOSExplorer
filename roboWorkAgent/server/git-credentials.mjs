import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { fail, robotId } from './robot-paths.mjs';

export const STORE_SCHEMA = 'robowork-git-credentials-v1';
export const MIRROR_SCHEMA = 'ploinky-git-credentials-v1';
export const GIT_HOST = 'github.com';
export const GIT_USERNAME = 'x-access-token';
const RECORD_LIMIT = 64 * 1024;

// A template Ploinky did not expand, or an empty value, means the deployment does not provide the feature.
function configured(value) {
    return typeof value === 'string' && value.trim() !== '' && !value.includes('{{') ? value.trim() : null;
}

export function storeKey(secret) {
    const value = configured(secret);
    return value ? Buffer.from(hkdfSync('sha256', Buffer.from(value, 'utf8'), Buffer.alloc(0), Buffer.from(STORE_SCHEMA, 'utf8'), 32)) : null;
}

export function mirrorKey(hex) {
    const value = configured(hex);
    return value && /^[0-9a-fA-F]{64}$/u.test(value) ? Buffer.from(value, 'hex') : null;
}

export function encrypt(key, plaintext, aad) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    return { alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

// Any malformed field, wrong key or changed byte yields null; a credential that cannot be read is simply absent.
export function decrypt(key, sealed, aad) {
    try {
        if (!key || sealed?.alg !== 'aes-256-gcm') return null;
        const iv = Buffer.from(sealed.iv, 'base64'), tag = Buffer.from(sealed.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16 || typeof sealed.data !== 'string') return null;
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { return null; }
}

// The record is bound to its robot, so a file copied to another robot's name does not decrypt there.
const recordAad = id => `${STORE_SCHEMA}\0${id}`;

async function writeAtomic(file, content) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

async function privateDirectory(directory, recursive = false) {
    await fs.mkdir(directory, { mode: 0o700, recursive }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory()) throw fail('UNSAFE_STORAGE', 'Credential storage is unsafe', 500);
}

const text = (value, label, { limit = 256, required = false } = {}) => {
    if (value === undefined || value === null) value = '';
    // Control characters would let a value add lines to git configuration or to the credential protocol.
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('INVALID_INPUT', `Invalid ${label}`);
    if (required && !value.trim()) throw fail('INVALID_INPUT', `Invalid ${label}`);
    return value.trim();
};

export function validateToken(token) {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(token)) throw fail('INVALID_INPUT', 'Invalid token');
    return token;
}

export function validateIdentity({ name, email }) {
    return { name: text(name, 'name'), email: text(email, 'email') };
}

export function validateMetadata(input) {
    if (!input.savedBy || typeof input.savedBy !== 'object' || Array.isArray(input.savedBy)) throw fail('INVALID_INPUT', 'Invalid savedBy');
    return { host: GIT_HOST, githubLogin: text(input.githubLogin, 'githubLogin', { limit: 100 }), ...validateIdentity(input),
        savedBy: { id: text(input.savedBy.id, 'savedBy.id', { required: true }), username: text(input.savedBy.username, 'savedBy.username') },
        savedAt: new Date().toISOString() };
}

// Per-robot records under /data/credentials, outside the robot directories that launches bind. An ordinary robot's
// record holds its encrypted token. The workspace default robot's token lives only in the Ploinky-owned file, which
// Ploinky also reads for its own git operations; its record then holds the metadata and `location: 'workspace'`
// instead of a secret, so the token exists in exactly one place. Missing keys disable the matching feature.
export class GitCredentialStore {
    constructor({ dataDir = '/data', env = process.env } = {}) {
        this.directory = path.join(path.resolve(dataDir), 'credentials');
        this.key = storeKey(env.ROBOWORK_CREDENTIALS_KEY);
        const mirrorDir = configured(env.ROBOWORK_GIT_MIRROR_DIR);
        this.mirrorDir = mirrorDir && path.isAbsolute(mirrorDir) ? mirrorDir : null;
        this.mirrorKey = mirrorKey(env.ROBOWORK_GIT_MIRROR_KEY);
    }

    get available() { return Boolean(this.key); }
    get mirrorAvailable() { return Boolean(this.mirrorDir && this.mirrorKey); }
    file(id) { return path.join(this.directory, `${robotId(id)}.json`); }

    async initialize() { await privateDirectory(this.directory, true); }

    async ids() {
        const names = await fs.readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        return names.flatMap(name => {
            const match = name.match(/^([a-z0-9][a-z0-9-]{2,63})\.json$/u);
            return match ? [match[1]] : [];
        });
    }

    // { configured, readable, metadata, secret, location }. The secret never leaves the service; callers strip it.
    async read(id) {
        let raw;
        try {
            const entry = await fs.lstat(this.file(id));
            if (!entry.isFile() || entry.size > RECORD_LIMIT) return { configured: true, readable: false, metadata: null, secret: null, location: 'robot' };
            raw = await fs.readFile(this.file(id), 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return { configured: false, readable: false, metadata: null, secret: null, location: null };
            throw error;
        }
        let record;
        try { record = JSON.parse(raw); } catch { record = null; }
        if (record?.schema !== STORE_SCHEMA || record.robotId !== id) return { configured: true, readable: false, metadata: null, secret: null, location: 'robot' };
        const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : null;
        if (record.location === 'workspace') {
            const secret = await this.readWorkspaceToken();
            return { configured: true, readable: Boolean(secret), metadata, secret, location: 'workspace' };
        }
        let secret = null;
        try {
            const plain = JSON.parse(decrypt(this.key, record.secret, recordAad(id)) ?? 'null');
            if (typeof plain?.token === 'string' && plain.token) secret = { username: plain.username || GIT_USERNAME, token: plain.token };
        } catch { secret = null; }
        return { configured: true, readable: Boolean(secret), metadata, secret, location: 'robot' };
    }

    // An ordinary robot's token goes into its own encrypted record.
    async write(id, metadata, token) {
        if (!this.key) throw fail('GIT_CREDENTIALS_UNAVAILABLE', 'Git credential storage is not configured', 503);
        await this.initialize();
        const record = { schema: STORE_SCHEMA, robotId: robotId(id), metadata,
            secret: encrypt(this.key, JSON.stringify({ username: GIT_USERNAME, token }), recordAad(id)) };
        await writeAtomic(this.file(id), JSON.stringify(record));
    }

    // The workspace default robot's token goes only into the Ploinky-owned file, written before the record that points
    // to it: a failure in between leaves no record of a token that does not exist, and saving again repairs it.
    async writeWorkspace(id, metadata, token) {
        if (!this.mirrorAvailable) throw fail('GIT_CREDENTIALS_UNAVAILABLE', 'The workspace git credential file is not configured', 503);
        await this.writeWorkspaceToken(token);
        await this.initialize();
        await writeAtomic(this.file(id), JSON.stringify({ schema: STORE_SCHEMA, robotId: robotId(id), metadata, location: 'workspace' }));
    }

    async remove(id) {
        const file = this.file(id);
        const existed = await fs.lstat(file).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
        await fs.rm(file, { force: true });
        return existed;
    }

    mirrorFile() { return this.mirrorDir ? path.join(this.mirrorDir, 'credentials.json') : null; }

    // The file format and AAD are Ploinky's contract (A2): Ploinky reads this file for its own git operations.
    async readWorkspaceToken() {
        if (!this.mirrorAvailable) return null;
        let envelope;
        try {
            const entry = await fs.lstat(this.mirrorFile());
            if (!entry.isFile() || entry.size > RECORD_LIMIT) return null;
            envelope = JSON.parse(await fs.readFile(this.mirrorFile(), 'utf8'));
        } catch { return null; }
        if (envelope?.schema !== MIRROR_SCHEMA) return null;
        try {
            const plain = JSON.parse(decrypt(this.mirrorKey, envelope, MIRROR_SCHEMA) ?? 'null');
            if (plain?.host !== GIT_HOST || typeof plain.token !== 'string' || !plain.token) return null;
            return { username: plain.username || GIT_USERNAME, token: plain.token };
        } catch { return null; }
    }

    async writeWorkspaceToken(token) {
        if (!this.mirrorAvailable) return false;
        await privateDirectory(this.mirrorDir, true);
        const plaintext = JSON.stringify({ host: GIT_HOST, username: GIT_USERNAME, token, updatedAt: new Date().toISOString() });
        const { alg, iv, tag, data } = encrypt(this.mirrorKey, plaintext, MIRROR_SCHEMA);
        await writeAtomic(this.mirrorFile(), JSON.stringify({ schema: MIRROR_SCHEMA, alg, iv, tag, data }));
        return true;
    }

    async removeWorkspaceToken() {
        if (!this.mirrorDir) return false;
        const existed = await fs.lstat(this.mirrorFile()).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
        await fs.rm(this.mirrorFile(), { force: true });
        return existed;
    }
}

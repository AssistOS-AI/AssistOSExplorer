import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { installSoulGatewayPlugin } from './soul-gateway-service.mjs';
import { checkedPath, pluginTreeDisposition, retireOpenCodePlugin } from './opencode-plugin-retire.mjs';

export const MIGRATION_ID = 'opencode-v2-1';
const STATE_PATHS = ['.config/opencode', '.local/share/opencode', '.local/state/opencode', '.opencode', '.ala'];
const MANAGED_TREE = '.config/opencode/node_modules';
const DATABASE_DIRECTORY = '.local/share/opencode';
// What a home's step must leave free beyond its own need, so a snapshot never fills the disk to the last byte.
const MARGIN_BYTES = 1024 ** 3;

async function atomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
}

async function exists(file) {
    return fs.lstat(file).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
}

async function inventory(home) {
    const file = path.join(home, '.local/share/opencode/opencode.db');
    if (!await exists(file)) return { sessions: [], messages: [], credentials: {} };
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe OpenCode database');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('OpenCode database is damaged');
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        const table = tables.has('session_v2') ? 'session_v2' : 'session';
        const sessions = tables.has(table) ? db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id) : [];
        const credentials = Object.fromEntries(['account', 'control_account', 'credential'].filter(name => tables.has(name))
            .map(name => [name, db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count]));
        const messageTable = tables.has('session_message') ? 'session_message' : 'message';
        const messages = tables.has(messageTable)
            ? db.prepare(`SELECT id, session_id FROM ${messageTable} ORDER BY id`).all() : [];
        return { sessions, messages, credentials };
    } finally { db.close(); }
}

// Runs only inside the home helper's network namespace. No model request and no background service.
export async function upgradeDatabase(binary, home, env = process.env, expected = {}) {
    const password = randomBytes(32).toString('base64url');
    const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
        cwd: home, env: { ...env, HOME: home, OPENCODE_PASSWORD: password,
            OPENCODE_CONFIG_CONTENT: '{"update":"disable"}' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    const exit = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
    try {
        const url = await new Promise((resolve, reject) => {
            let buffer = '';
            const timer = setTimeout(() => reject(new Error('OpenCode migration startup timed out')), 120000);
            const cleanup = () => clearTimeout(timer);
            child.once('error', error => { cleanup(); reject(error); });
            child.once('close', () => { cleanup(); reject(new Error('OpenCode migration server exited')); });
            for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
                buffer = (buffer + chunk).slice(-8192);
                const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/u);
                if (match) { cleanup(); resolve(match[1]); }
            });
        });
        const response = await fetch(`${url}/api/info`, {
            headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok || !(Number((await response.json()).version?.split('.')[0]) >= 2)) throw new Error('OpenCode >=2 readiness failed');
        // Listening does not mean that the asynchronous legacy-history import has finished.
        const deadline = Date.now() + 120000;
        for (;;) {
            const progress = await fetch(`${url}/api/experimental/migration/v1`, {
                headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
                signal: AbortSignal.timeout(15000),
            });
            if (!progress.ok) throw new Error('OpenCode migration status is unavailable');
            const state = await progress.json();
            if (state.status === 'completed') break;
            if (!['required', 'running'].includes(state.status)) throw new Error('OpenCode native history migration failed');
            if (Date.now() >= deadline) throw new Error('OpenCode history migration timed out');
            await delay(100);
        }
        for (const id of expected.sessions || []) {
            const session = await fetch(`${url}/api/session/${encodeURIComponent(id)}`, {
                headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
                signal: AbortSignal.timeout(15000),
            });
            if (!session.ok || (await session.json()).data?.id !== id) {
                throw new Error('Migrated session is not accessible through the V2 API');
            }
        }
    } finally {
        if (!exited) child.kill('SIGTERM');
        const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000);
        await exit;
        clearTimeout(timer);
    }
    // Manual launches in Desktop/Terminal must not attach to a service from another sandbox.
    await promisify(execFile)(binary, ['service', 'set', 'disabled', 'true'], {
        cwd: home, env: { ...env, HOME: home }, timeout: 30000, maxBuffer: 1024 * 1024,
    });
}

// Bytes below a path, counted without following a link; `skip` names paths that are not counted.
async function treeBytes(file, skip = new Set()) {
    if (skip.has(file)) return 0;
    const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat) return 0;
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    // A state directory can change while it is measured; an entry that vanished counts as nothing.
    const entries = await fs.readdir(file).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    for (const entry of entries) total += await treeBytes(path.join(file, entry), skip);
    return total;
}

// What the upgrade can add on top of the database it reads.
async function databaseBytes(home) {
    if (!await checkedPath(home, DATABASE_DIRECTORY)) return 0;
    let total = 0;
    for (const name of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
        total += await treeBytes(path.join(home, DATABASE_DIRECTORY, name));
    }
    return total;
}

// What the snapshot will copy. A link or a special file anywhere on the way to a state directory throws, as the copy would.
async function snapshotBytes(home, excluded) {
    const skipped = new Set(excluded.map(relative => path.join(home, relative)));
    let total = 0;
    for (const relative of STATE_PATHS) {
        if (await checkedPath(home, relative)) total += await treeBytes(path.join(home, relative), skipped);
    }
    return total;
}

async function freeBytesAt(directory) {
    const stat = await fs.statfs(directory);
    return stat.bavail * stat.bsize;
}

// `backup` is a server-owned, per-robot directory mounted only for this helper. `freeBytes` and `marginBytes` exist for tests.
export async function migrateOpenCodeHome({ home, backup, binary, upgrade = upgradeDatabase, freeBytes = freeBytesAt, marginBytes = MARGIN_BYTES }) {
    const stateFile = path.join(backup, 'state.json');
    let state = await fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return { migration: MIGRATION_ID, phase: 'pending' };
    });
    if (state.migration !== MIGRATION_ID) throw new Error('Unknown migration journal');
    // A finished migration only retires what an earlier run left behind; that never fails the robot.
    if (state.phase === 'complete') {
        const retired = await retireOpenCodePlugin(home);
        const detail = retired.reason ?? retired.error;
        return { phase: 'complete', repeated: true, plugin: retired.status, ...(detail ? { pluginDetail: String(detail).slice(0, 300) } : {}) };
    }
    const snapshot = path.join(backup, 'snapshot');
    try {
        const snapshotted = await exists(path.join(backup, 'snapshot.json'));
        // The tree OpenCode 2 never reads stays out of the backup; OpenCode 1 reinstalls it from the manifest and lock.
        const disposition = snapshotted ? null : await pluginTreeDisposition(home);
        const excluded = disposition?.status === 'managed' && disposition.hasTree ? [MANAGED_TREE] : [];
        // Sized to this home's own work, before anything is written: a state that cannot fit pauses the robot and leaves
        // its journal and home untouched, so a later run starts from the same place.
        const need = (snapshotted ? 0 : await snapshotBytes(home, excluded)) + await databaseBytes(home);
        const required = need + Math.max(marginBytes, need);
        const free = await freeBytes(backup);
        if (free < required) return { phase: 'deferred', reason: 'INSUFFICIENT_SPACE', neededBytes: required, freeBytes: free };
        if (!snapshotted) {
            // An interrupted copy has never been a valid backup; source has not been touched yet.
            await fs.rm(snapshot, { recursive: true, force: true });
            await fs.mkdir(snapshot, { mode: 0o700 });
            const included = [];
            const skipped = new Set(excluded.map(relative => path.join(home, relative)));
            for (const relative of STATE_PATHS) {
                if (!await checkedPath(home, relative)) continue;
                await fs.mkdir(path.dirname(path.join(snapshot, relative)), { recursive: true, mode: 0o700 });
                await fs.cp(path.join(home, relative), path.join(snapshot, relative), {
                    recursive: true, verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE,
                    filter: source => !skipped.has(source),
                });
                included.push(relative);
            }
            // Inspect the backup first, never the unprotected live database.
            const before = await inventory(snapshot);
            await atomic(path.join(backup, 'snapshot.json'), { included, excluded, before, createdAt: new Date().toISOString() });
        }
        state = { ...state, phase: 'migrating' };
        await atomic(stateFile, state);
        const { before } = JSON.parse(await fs.readFile(path.join(backup, 'snapshot.json'), 'utf8'));
        for (const directory of ['.config/opencode/plugins', '.local/share/opencode', '.local/state/opencode']) {
            await fs.mkdir(path.join(home, directory), { recursive: true, mode: 0o700 });
            if (!await checkedPath(home, directory)) throw new Error('OpenCode state is unavailable');
        }
        const retired = await retireOpenCodePlugin(home);
        if (!['retired', 'absent', 'authored'].includes(retired.status)) {
            throw new Error(`OpenCode plugin dependencies require attention: ${retired.status}`);
        }
        await installSoulGatewayPlugin(home);
        await upgrade(binary, home, process.env, before);
        const after = await inventory(home);
        const sessions = new Set(after.sessions);
        if (before.sessions.some(id => !sessions.has(id))) throw new Error('OpenCode migration lost session identities');
        const messages = new Set(after.messages.map(message => `${message.session_id}/${message.id}`));
        if ((before.messages || []).some(message => !messages.has(`${message.session_id}/${message.id}`))) {
            throw new Error('OpenCode migration lost message identities');
        }
        if (Object.entries(before.credentials).some(([name, count]) => (after.credentials[name] || 0) < count)) {
            throw new Error('OpenCode migration lost stored account records');
        }
        const auth = '.local/share/opencode/auth.json';
        if (await exists(path.join(snapshot, auth))) {
            if (!await exists(path.join(home, auth))
                || !(await fs.readFile(path.join(snapshot, auth))).equals(await fs.readFile(path.join(home, auth)))) {
                throw new Error('OpenCode migration changed legacy credentials; manual verification required');
            }
        }
        await atomic(stateFile, { migration: MIGRATION_ID, phase: 'complete', completedAt: new Date().toISOString(),
            sessions: after.sessions.length });
        return { phase: 'complete', sessions: after.sessions.length, plugin: retired.status };
    } catch (error) {
        await atomic(stateFile, { ...state, phase: 'failed', error: error.message, failedAt: new Date().toISOString() });
        throw error;
    }
}

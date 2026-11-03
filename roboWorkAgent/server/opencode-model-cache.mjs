import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { soulGatewayConnection } from './soul-gateway-connection.mjs';
import { openCodeGatewayModels } from './soul-gateway-models.mjs';

// The model list OpenCode reports for a robot, keyed by everything OpenCode and its
// launcher read to produce it. There is no time window: every lookup recomputes the key
// from the current inputs, and only a list stored under that exact key is returned. A
// changed input yields a different key, so the list is recomputed by starting OpenCode.
//
// Inputs, each read on every lookup:
//   the OpenCode executable (resolved path, size, mtime), the ALA launcher code that starts it,
//   the environment it receives, the robot's OpenCode configuration tree (config files and
//   local plugins), its auth.json, the models.dev catalog file OpenCode keeps in its cache,
//   project configuration along the working directory's ancestors, OPENCODE_CONFIG[_DIR],
//   the managed configuration directories, and the Soul Gateway model list read live.
//
// Anything that cannot be read as a bounded input (unreadable, too large) bypasses the cache,
// so the cache can only ever be skipped, never wrong because an input was not visible.
//
// Never staler than OpenCode without the cache. OpenCode starts a refresh of its models.dev file
// at launch and skips it only while the file is fresh (ModelsDev.refresh, read from the 1.18.35
// binary):
//     d = stat(<cache>/models.json); return Date.now() - mtime < minutes(5)   // fresh: no fetch
//     refresh(): if (fresh()) return; fetch models.opencode.ai/api.json and rewrite the file
// A stored list is therefore served only while that same predicate holds, with the window pinned
// per OpenCode version below. Once the file is older, the call is a miss: the real listing runs,
// OpenCode refreshes the file, and its changed content changes the key. A version without a
// pinned window, a custom OPENCODE_MODELS_URL (OpenCode then names the file by a hash of the URL)
// and an absent file all bypass or miss, so the cache is never the reason a list is older.
//
// Remote or account-scoped state bypasses the cache. OpenCode merges a remote configuration for a
// "wellknown" auth entry and for an active Console account or organisation on every launch, and an
// OAuth login can change what a provider lists; none of that is visible as a local file. Only type
// fields are inspected (never values), and anything other than a plain API-key entry bypasses.
//
// Location. The record lives in server-only storage that is never mounted into a robot or GUI
// container (<data>/server-state/model-catalog/<robot>/), not under robots/<id>, which a GUI
// container mounts read-write. Every directory segment is checked with lstat (a real directory
// owned by the server) before it is read, written or removed, and the record is written by an
// exclusive create plus rename, so a link is never followed.
const SCHEMA = 'roboteam-opencode-models-v1';
const CACHE_SEGMENTS = ['server-state', 'model-catalog'];
const CACHE_FILE_NAME = 'model-listing.json';
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const FILE_LIMIT = 8 * 1024 * 1024;
const MODELS_FILE_LIMIT = 64 * 1024 * 1024;
const TREE_FILE_LIMIT = 400;
const TREE_DEPTH_LIMIT = 6;
const ANCESTOR_LIMIT = 64;
const CACHE_FILE_LIMIT = 4 * 1024 * 1024;
// Window in which OpenCode treats its models.json as fresh and does not refetch it, per OpenCode
// version. The test next to this module asserts it against the OpenCode binary.
export const MODELS_FRESH_WINDOW_MS = Object.freeze({ '1.18.35': 5 * 60 * 1000 });
const GATEWAY_PROVIDER = 'soul-gateway';
const GATEWAY_TIMEOUT_MS = 5000;
const MANAGED_CONFIG_DIRECTORIES = ['/etc/opencode', '/Library/Application Support/opencode'];
const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'];

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function hashFile(file, limit = FILE_LIMIT) {
    let handle;
    try {
        // O_NONBLOCK: a FIFO planted by a robot must not block the open; it is reported as special.
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        const metadata = await handle.stat();
        if (metadata.isDirectory()) return 'directory';
        if (!metadata.isFile()) return 'special';
        if (metadata.size > limit) throw new Error(`OpenCode input is too large: ${file}`);
        return sha256(await handle.readFile());
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return 'absent';
        throw error;
    } finally { await handle?.close(); }
}

// Names and contents of a configuration tree; links are recorded, not followed.
async function hashTree(root, { skip = ['node_modules'] } = {}) {
    const entries = [];
    async function walk(directory, depth) {
        let names;
        try { names = (await fs.readdir(directory)).sort(); } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
            throw error;
        }
        for (const name of names) {
            if (skip.includes(name) || name.startsWith('.roboteam-')) continue;
            const file = path.join(directory, name);
            const relative = path.relative(root, file);
            const metadata = await fs.lstat(file);
            if (metadata.isSymbolicLink()) entries.push([relative, 'link', await fs.readlink(file)]);
            else if (metadata.isDirectory()) {
                if (depth >= TREE_DEPTH_LIMIT) throw new Error(`OpenCode input is too deep: ${root}`);
                entries.push([relative, 'directory']);
                await walk(file, depth + 1);
            } else if (metadata.isFile()) entries.push([relative, 'file', await hashFile(file)]);
            if (entries.length > TREE_FILE_LIMIT) throw new Error(`OpenCode input has too many entries: ${root}`);
        }
        return true;
    }
    return await walk(root, 0) ? sha256(JSON.stringify(entries)) : 'absent';
}

// Project configuration OpenCode finds walking up from the working directory.
async function projectConfiguration(cwd) {
    const found = [];
    let directory = path.resolve(cwd);
    for (let depth = 0; depth < ANCESTOR_LIMIT; depth++) {
        const files = await Promise.all(CONFIG_NAMES.map(name => hashFile(path.join(directory, name))));
        const tree = await hashTree(path.join(directory, '.opencode'));
        if (files.some(value => value !== 'absent') || tree !== 'absent') found.push([directory, files, tree]);
        const parent = path.dirname(directory);
        if (parent === directory) return found;
        directory = parent;
    }
    throw new Error('OpenCode working directory is too deep.');
}

async function launcherCode(packageRoot) {
    const directory = path.join(packageRoot, 'src', 'coding-agents');
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.mjs')).sort();
    const files = await Promise.all(names.map(async name => [name, await hashFile(path.join(directory, name))]));
    return [await hashFile(path.join(packageRoot, 'package.json')), files];
}

async function executable(binary) {
    const resolved = await fs.realpath(binary);
    const metadata = await fs.stat(resolved);
    return [resolved, metadata.size, metadata.mtimeMs];
}

// The npm platform package that holds the executable (opencode-linux-arm64/bin/opencode) names its version.
export async function openCodeVersionOf(binary) {
    let directory = path.dirname(await fs.realpath(binary));
    for (let depth = 0; depth < 4; depth++, directory = path.dirname(directory)) {
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
            if (typeof metadata.name === 'string' && metadata.name.startsWith('opencode-') && typeof metadata.version === 'string') return metadata.version;
        } catch (error) {
            if (error.code !== 'ENOENT') return null;
        }
    }
    return null;
}

// OpenCode's own predicate: fresh while Date.now() - mtime is below the window. Absent means stale.
async function modelsFileFresh(file, windowMs, now) {
    const metadata = await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return Boolean(metadata) && now - metadata.mtime.getTime() < windowMs;
}

async function gatewayModels(connect, env, signal) {
    const connection = await connect(env);
    if (!connection) return null;
    const timeout = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
    const catalog = await connection.request('models', undefined, signal ? AbortSignal.any([signal, timeout]) : timeout);
    return openCodeGatewayModels(catalog);
}

// Types of auth.json entries are the only thing read from it here. Only 'api' (a key OpenCode
// sends to a provider whose models come from the models.dev file) keeps the cache usable.
async function authIsLocalOnly(file) {
    let text;
    try {
        // A robot controls this path: only a regular file is ever opened (a FIFO would block the read).
        const metadata = await fs.lstat(file);
        if (!metadata.isFile() || metadata.size > FILE_LIMIT) return false;
        text = await fs.readFile(file, 'utf8');
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return true;
        return false;
    }
    try {
        const entries = JSON.parse(text);
        return Boolean(entries) && typeof entries === 'object' && !Array.isArray(entries)
            && Object.values(entries).every(entry => entry && typeof entry === 'object' && entry.type === 'api');
    } catch { return false; }
}

async function loadSqlite() {
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try { return await import('node:sqlite'); } finally { process.emitWarning = emit; }
}

// An OpenCode Console login keeps its active account and organisation in OpenCode's database; the
// organisation's remote configuration is merged into every launch. A database that exists but
// cannot be inspected counts as account state.
async function consoleAccountActive(file) {
    try {
        // Only a regular file is opened: a FIFO or device at this path must bypass, not block.
        const metadata = await fs.lstat(file);
        if (!metadata.isFile()) return true;
        // SQLite also opens its write-ahead and journal siblings.
        for (const suffix of ['-wal', '-shm', '-journal']) {
            const sibling = await fs.lstat(file + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (sibling && !sibling.isFile()) return true;
        }
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
        return true;
    }
    try {
        const { DatabaseSync } = await loadSqlite();
        const database = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
            if (tables.has('account_state') && database.prepare(
                'SELECT 1 FROM account_state WHERE active_account_id IS NOT NULL OR active_org_id IS NOT NULL LIMIT 1').get()) return true;
            if (tables.has('control_account') && database.prepare('SELECT 1 FROM control_account WHERE active = 1 LIMIT 1').get()) return true;
            // 1.18.x credential table (connector, method, OAuth or key): any row is remote or account scoped.
            if (tables.has('credential') && database.prepare('SELECT 1 FROM credential LIMIT 1').get()) return true;
            return false;
        } finally { database.close(); }
    } catch { return true; }
}

async function remoteScoped(home, env) {
    if (env.OPENCODE_CONSOLE_TOKEN) return true;
    const data = path.join(home, '.local', 'share', 'opencode');
    if (!await authIsLocalOnly(path.join(data, 'auth.json'))) return true;
    const database = env.OPENCODE_DB === ':memory:' ? null
        : env.OPENCODE_DB ? path.resolve(data, env.OPENCODE_DB) : path.join(data, 'opencode.db');
    return database ? consoleAccountActive(database) : false;
}

const validList = models => Array.isArray(models) && models.length > 0 && models.length < 20000
    && models.every(model => typeof model?.id === 'string' && model.id);

export function createOpenCodeModelCache({ root, robotId, connect = soulGatewayConnection, uid = process.getuid?.() } = {}) {
    if (!root || !ROBOT_ID.test(String(robotId))) throw new TypeError('The OpenCode model cache needs a data root and a robot id.');
    const directory = path.join(root, ...CACHE_SEGMENTS, robotId);
    const file = path.join(directory, CACHE_FILE_NAME);
    // Every segment below the data root must be a real directory owned by the server.
    async function checkDirectory({ create = false } = {}) {
        if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
        let current = root;
        for (const segment of [...CACHE_SEGMENTS, robotId]) {
            current = path.join(current, segment);
            let metadata = await fs.lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (!metadata) {
                if (!create) return false;
                await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
                metadata = await fs.lstat(current);
            }
            if (metadata.isSymbolicLink() || !metadata.isDirectory() || (uid !== undefined && metadata.uid !== uid)) {
                throw new Error('Unsafe OpenCode model cache directory.');
            }
        }
        return true;
    }
    async function read(key) {
        let handle;
        try {
            if (!await checkDirectory()) return null;
            handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.size > CACHE_FILE_LIMIT) return null;
            const record = JSON.parse(await handle.readFile('utf8'));
            return record?.schema === SCHEMA && record.key === key && validList(record.models) ? record.models : null;
        } catch { return null; } finally { await handle?.close(); }
    }
    // After a stale-file miss no earlier record may survive: OpenCode refreshes models.json and may
    // rewrite identical content, which would bring the old key (and an older list) back.
    async function invalidate() {
        if (!await checkDirectory()) return;
        await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return {
        // Returns null when the key cannot be derived (the caller lists models as before), else
        // { key, models, gateway } where models is the stored list for exactly this key, or null.
        async probe(config, signal) {
            const record = config.agents?.find(agent => agent.name === 'opencode' && agent.available && agent.binary);
            if (!record) return null;
            const home = config.home;
            const env = { ...process.env, ...config.env };
            const openCode = path.join(home, '.config', 'opencode');
            // OpenCode names the file by a hash of a custom URL; its freshness cannot be judged here.
            if (env.OPENCODE_MODELS_URL) return null;
            if (await remoteScoped(home, env)) return null;
            const windowMs = MODELS_FRESH_WINDOW_MS[await openCodeVersionOf(record.binary)];
            if (!windowMs) return null;
            const modelsFile = path.join(home, '.cache', 'opencode', 'models.json');
            const [binary, launcher, gateway, configuration, dotOpenCode, auth, models, project, custom, managed] = await Promise.all([
                executable(record.binary),
                launcherCode(config.api.packageRoot),
                gatewayModels(connect, process.env, signal),
                hashTree(openCode),
                hashTree(path.join(home, '.opencode')),
                hashFile(path.join(home, '.local', 'share', 'opencode', 'auth.json')),
                hashFile(env.OPENCODE_MODELS_PATH || modelsFile, MODELS_FILE_LIMIT),
                projectConfiguration(config.cwd),
                Promise.all([env.OPENCODE_CONFIG ? hashFile(env.OPENCODE_CONFIG) : null,
                    env.OPENCODE_CONFIG_DIR ? hashTree(env.OPENCODE_CONFIG_DIR) : null]),
                Promise.all(MANAGED_CONFIG_DIRECTORIES.flatMap(managedDirectory =>
                    CONFIG_NAMES.map(name => hashFile(path.join(managedDirectory, name))))),
            ]);
            const key = sha256(JSON.stringify([SCHEMA, binary, launcher, Object.entries(env).sort(), gateway,
                configuration, dotOpenCode, auth, models, project, custom, managed, config.cwd, home]));
            // Judged after the key is built, immediately before use, with OpenCode's own clock reading.
            const fresh = await modelsFileFresh(modelsFile, windowMs, Date.now());
            if (!fresh) {
                await invalidate();
                return { key, models: null, gateway, fresh };
            }
            return { key, models: await read(key), gateway, fresh };
        },
        // Stores a list only when it is complete for the gateway read when the key was
        // derived: every gateway model must appear, so a plugin that failed to load is never remembered.
        async store(probe, models) {
            // A list produced while the models file is stale is not remembered: OpenCode refreshes
            // that file, which changes the key, and the next listing is stored under the new one.
            if (!probe?.key || !probe.fresh || !validList(models)) return false;
            const present = new Set(models.map(model => model.id));
            if (probe.gateway && Object.keys(probe.gateway).some(id => !present.has(`${GATEWAY_PROVIDER}/${id}`))) return false;
            await checkDirectory({ create: true });
            const temporary = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, JSON.stringify({ schema: SCHEMA, key: probe.key, models }), { flag: 'wx', mode: 0o600 });
                await fs.rename(temporary, file);
            } finally { await fs.rm(temporary, { force: true }); }
            return true;
        },
    };
}

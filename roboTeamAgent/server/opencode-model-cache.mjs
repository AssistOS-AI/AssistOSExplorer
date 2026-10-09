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
const SCHEMA = 'roboteam-opencode-models-v1';
const FILE_LIMIT = 8 * 1024 * 1024;
const MODELS_FILE_LIMIT = 64 * 1024 * 1024;
const TREE_FILE_LIMIT = 400;
const TREE_DEPTH_LIMIT = 6;
const ANCESTOR_LIMIT = 64;
const CACHE_FILE_LIMIT = 4 * 1024 * 1024;
const GATEWAY_PROVIDER = 'soul-gateway';
const GATEWAY_TIMEOUT_MS = 5000;
const MANAGED_CONFIG_DIRECTORIES = ['/etc/opencode', '/Library/Application Support/opencode'];
const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'];

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function hashFile(file, limit = FILE_LIMIT) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY);
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

async function gatewayModels(connect, env, signal) {
    const connection = await connect(env);
    if (!connection) return null;
    const timeout = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
    const catalog = await connection.request('models', undefined, signal ? AbortSignal.any([signal, timeout]) : timeout);
    return openCodeGatewayModels(catalog);
}

const validList = models => Array.isArray(models) && models.length > 0 && models.length < 20000
    && models.every(model => typeof model?.id === 'string' && model.id);

export function createOpenCodeModelCache({ directory, connect = soulGatewayConnection } = {}) {
    if (!directory) throw new TypeError('The OpenCode model cache needs a directory.');
    const file = path.join(directory, 'opencode.json');
    async function read(key) {
        let handle;
        try {
            handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.size > CACHE_FILE_LIMIT) return null;
            const record = JSON.parse(await handle.readFile('utf8'));
            return record?.schema === SCHEMA && record.key === key && validList(record.models) ? record.models : null;
        } catch { return null; } finally { await handle?.close(); }
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
            const [binary, launcher, gateway, configuration, dotOpenCode, auth, models, project, custom, managed] = await Promise.all([
                executable(record.binary),
                launcherCode(config.api.packageRoot),
                gatewayModels(connect, process.env, signal),
                hashTree(openCode),
                hashTree(path.join(home, '.opencode')),
                hashFile(path.join(home, '.local', 'share', 'opencode', 'auth.json')),
                hashFile(env.OPENCODE_MODELS_PATH || path.join(home, '.cache', 'opencode', 'models.json'), MODELS_FILE_LIMIT),
                projectConfiguration(config.cwd),
                Promise.all([env.OPENCODE_CONFIG ? hashFile(env.OPENCODE_CONFIG) : null,
                    env.OPENCODE_CONFIG_DIR ? hashTree(env.OPENCODE_CONFIG_DIR) : null]),
                Promise.all(MANAGED_CONFIG_DIRECTORIES.flatMap(managedDirectory =>
                    CONFIG_NAMES.map(name => hashFile(path.join(managedDirectory, name))))),
            ]);
            const key = sha256(JSON.stringify([SCHEMA, binary, launcher, Object.entries(env).sort(), gateway,
                configuration, dotOpenCode, auth, models, project, custom, managed, config.cwd, home]));
            return { key, models: await read(key), gateway };
        },
        // Stores a list only when it is complete for the gateway read when the key was
        // derived: every gateway model must appear, so a plugin that failed to load is never remembered.
        async store(probe, models) {
            if (!probe?.key || !validList(models)) return false;
            const present = new Set(models.map(model => model.id));
            if (probe.gateway && Object.keys(probe.gateway).some(id => !present.has(`${GATEWAY_PROVIDER}/${id}`))) return false;
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const temporary = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, JSON.stringify({ schema: SCHEMA, key: probe.key, models }), { flag: 'wx', mode: 0o600 });
                await fs.rename(temporary, file);
            } finally { await fs.rm(temporary, { force: true }); }
            return true;
        },
    };
}

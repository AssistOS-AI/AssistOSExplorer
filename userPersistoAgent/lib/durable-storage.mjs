import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
export const SNAPSHOT_FILE = '.userpersisto.snapshot.json';
const LOCK_FILE = '.userpersisto.writer.json';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const liveOwnerTokens = new Set();
let faultInjector = null;

// Explicit test injection; configuration and HTTP input cannot enable faults.
export function setDurableStorageFaultInjectorForTests(injector = null) {
    faultInjector = injector;
}

function unavailable(cause) {
    return Object.assign(new Error('Durable storage is unavailable; restart after repairing storage.', { cause }), {
        code: 'persistence_unavailable', statusCode: 503,
    });
}

function locked() {
    return Object.assign(new Error('Persisto already has a live or ambiguous writer lock.'), {
        code: 'persistence_locked', statusCode: 503,
    });
}

function runtimeIdentity(env = process.env) {
    const instanceId = String(env.PLOINKY_AGENT_INSTANCE_ID || '').trim();
    const enableGeneration = String(env.PLOINKY_AGENT_ENABLE_GENERATION || '').trim();
    return instanceId && enableGeneration ? { instanceId, enableGeneration } : null;
}

function writerOwner() {
    return {
        version: 2,
        pid: process.pid,
        hostname: hostname(),
        token: randomUUID(),
        ...runtimeIdentity(),
    };
}

function parseOwner(bytes) {
    const owner = JSON.parse(bytes.toString('utf8'));
    const hasInstance = typeof owner?.instanceId === 'string' && owner.instanceId.trim().length > 0;
    const hasGeneration = typeof owner?.enableGeneration === 'string' && owner.enableGeneration.trim().length > 0;
    if (!owner || (owner.version !== undefined && owner.version !== 2)
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.hostname !== 'string' || !owner.hostname.trim()
        || typeof owner.token !== 'string' || !owner.token.trim()
        || (hasInstance && owner.instanceId !== owner.instanceId.trim())
        || (hasGeneration && owner.enableGeneration !== owner.enableGeneration.trim())
        || hasInstance !== hasGeneration) {
        throw locked();
    }
    return owner;
}

async function captureOwner(lockPath) {
    const stat = await lstat(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw locked();
    const bytes = await readFile(lockPath);
    return { owner: parseOwner(bytes), stat, bytes };
}

function processIsProvenDead(pid) {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return error?.code === 'ESRCH';
    }
}

function isProvenPredecessor(existing, current) {
    if (existing.hostname === current.hostname) {
        if (liveOwnerTokens.has(existing.token)) return false;
        if (existing.pid === current.pid) return true;
        return processIsProvenDead(existing.pid);
    }
    const currentIdentity = current.instanceId && current.enableGeneration
        ? { instanceId: current.instanceId, enableGeneration: current.enableGeneration }
        : null;
    if (!currentIdentity) return false;
    const existingIdentity = existing.instanceId && existing.enableGeneration
        ? { instanceId: existing.instanceId, enableGeneration: existing.enableGeneration }
        : null;
    return !existingIdentity
        || existingIdentity.instanceId !== currentIdentity.instanceId
        || existingIdentity.enableGeneration !== currentIdentity.enableGeneration;
}

async function recoverPredecessorLock(lockPath, current) {
    let captured;
    try {
        captured = await captureOwner(lockPath);
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error.code === 'persistence_locked' ? error : locked();
    }
    if (!isProvenPredecessor(captured.owner, current)) throw locked();
    let latest;
    try {
        latest = await captureOwner(lockPath);
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error.code === 'persistence_locked' ? error : locked();
    }
    if (latest.stat.dev !== captured.stat.dev || latest.stat.ino !== captured.stat.ino
        || latest.stat.size !== captured.stat.size || !latest.bytes.equals(captured.bytes)) {
        throw locked();
    }
    try {
        await unlink(lockPath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw locked();
    }
}

// Persisto remains the model/index engine. Its filesystem primitives are backed by
// one atomic snapshot so a save cannot publish only part of an object/index set.
// The upstream AutoSaver deliberately swallows errors, so it is not used here.
export async function createDurableStorage(folder) {
    const lockPath = join(folder, LOCK_FILE);
    const currentOwner = writerOwner();
    const owner = JSON.stringify(currentOwner);
    liveOwnerTokens.add(currentOwner.token);
    let lock;
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                lock = await open(lockPath, 'wx', 0o600);
                break;
            } catch (cause) {
                if (cause.code !== 'EEXIST' || attempt > 0) throw cause;
                await recoverPredecessorLock(lockPath, currentOwner);
            }
        }
    } catch (cause) {
        liveOwnerTokens.delete(currentOwner.token);
        if (cause.code === 'EEXIST' || cause.code === 'persistence_locked') throw locked();
        throw unavailable(cause);
    }
    const release = () => {
        // Never remove another writer's lock, including after a directory swap.
        try { if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath); } catch { /* Already removed/unavailable. */ }
        liveOwnerTokens.delete(currentOwner.token);
        process.removeListener('exit', release);
    };
    try {
        await lock.writeFile(owner);
        await lock.sync();
    } catch (cause) {
        await lock.close();
        release();
        throw unavailable(cause);
    }
    await lock.close();
    process.once('exit', release);

    let failure = null;
    let closed = false;
    const poison = (cause) => {
        failure ||= unavailable(cause);
        return failure;
    };
    const check = () => {
        if (failure) throw failure;
        if (closed) throw unavailable(new Error('Storage is closed.'));
    };
    try {
        let objects = Object.create(null);
        let hasSnapshot = false;
        try {
            const snapshot = JSON.parse(await readFile(join(folder, SNAPSHOT_FILE), 'utf8'));
            if (snapshot.version !== 1 || typeof snapshot.payload !== 'string' || digest(snapshot.payload) !== snapshot.sha256) {
                throw new Error('Invalid Persisto snapshot checksum or version.');
            }
            objects = Object.assign(Object.create(null), JSON.parse(snapshot.payload));
            if (!objects.system || !Number.isSafeInteger(objects.system.currentIDNumber)) {
                throw new Error('Invalid Persisto snapshot system record.');
            }
            hasSnapshot = true;
        } catch (cause) {
            if (cause.code !== 'ENOENT') throw cause;
            // Upgrade legacy stores without deleting or rewriting their files.
            // Read/JSON failures are fatal, never interpreted as an empty store.
            for (const entry of await readdir(folder, { withFileTypes: true })) {
                if (!entry.name.startsWith('.') && /^[a-zA-Z0-9_.]+$/.test(entry.name)) {
                    if (!entry.isFile()) throw new Error(`Unexpected Persisto entry: ${entry.name}`);
                    objects[entry.name] = JSON.parse(await readFile(join(folder, entry.name), 'utf8'));
                }
            }
            if (Object.keys(objects).length && !objects.system) throw new Error('Legacy Persisto store has no system record.');
        }
        for (const [id, value] of Object.entries(objects)) {
            if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.]*$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error(`Invalid Persisto object: ${id}`);
            }
        }

        const strategy = require('../vendor/Persisto/src/persistence/strategies/SimpleFSStorageStrategy.cjs').getSimpleFSStorageStrategy();
        let changed = !hasSnapshot;
        strategy.loadObjectFromDisk = async (id, allowMissing = false) => {
            check();
            if (Object.hasOwn(objects, id)) return structuredClone(objects[id]);
            if (!allowMissing) throw new Error(`Persisto object not found: ${id}`);
            return undefined;
        };
        strategy.storeObject = async (id, object) => {
            check();
            objects[id] = structuredClone(object);
            changed = true;
        };
        strategy.deleteObject = async (id) => {
            check();
            delete objects[id];
            changed = true;
        };
        strategy.objectExists = async (id) => Boolean(await strategy.loadObject(id, true));
        strategy.listAllObjects = async () => Object.keys(objects);
        strategy.getTimestamp = async () => 0;
        await strategy.init();

        const save = async () => {
            check();
            let temporaryPath;
            try {
                if (await readFile(lockPath, 'utf8') !== owner) throw new Error('Persisto writer lock was replaced.');
                await strategy.saveAll();
                if (!changed) return;
                await faultInjector?.('before-snapshot-write');
                const payload = JSON.stringify(objects);
                temporaryPath = join(folder, `.userpersisto-${randomUUID()}.tmp`);
                const file = await open(temporaryPath, 'wx', 0o600);
                try {
                    await file.writeFile(JSON.stringify({ version: 1, sha256: digest(payload), payload }));
                    await file.sync();
                } finally {
                    await file.close();
                }
                await faultInjector?.('before-snapshot-rename');
                await rename(temporaryPath, join(folder, SNAPSHOT_FILE));
                await faultInjector?.('after-snapshot-rename');
                const directory = await open(folder, 'r');
                try { await directory.sync(); } finally { await directory.close(); }
                changed = false;
            } catch (cause) {
                // Dirty flags may already be cleared by Persisto. Fail closed so
                // a cached retry cannot acknowledge an uncommitted operation.
                throw poison(cause);
            } finally {
                if (temporaryPath) await unlink(temporaryPath).catch(() => {});
            }
        };
        const facade = new Proxy(strategy, {
            get(target, name) {
                if (name === 'forceSave') return save;
                if (name === 'shutDown') return async () => {
                    if (closed) return;
                    try { if (!failure) await save(); } finally { closed = true; release(); }
                };
                if (name === 'deleteObject') return target.deleteObjectWithType.bind(target);
                if (name === 'select') return (type, filters = {}, sortBy = null, start = 0, end = null, descending = false) => target.select(type, filters, sortBy, start, end, descending);
                return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
            },
        });
        return { storage: facade, check, poison, abandon: () => { closed = true; release(); } };
    } catch (cause) {
        release();
        throw unavailable(cause);
    }
}

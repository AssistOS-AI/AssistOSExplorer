import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { ensureSchema } from './schema.mjs';
import { resetSerialForTests } from './serial.mjs';
import { createDurableStorage } from './durable-storage.mjs';
import { withPersistenceScope } from './persistence-scope.mjs';

const require = createRequire(import.meta.url);

let storePromise = null;
let activeDurable = null;
let faultInjector = null;

export function setStoreFaultInjectorForTests(injector = null) {
    faultInjector = injector;
}

export function poisonStore(cause) {
    if (!activeDurable) throw cause;
    return activeDurable.poison(cause);
}

// This is a fail-closed staging boundary, not rollback. Call only after domain
// validation while holding users/domain exclusion. Helpers inside must not save.
export async function commitStagedPersistence(operation) {
    return withPersistenceScope(async () => {
        await getStore();
        try {
            const result = await operation();
            await flush();
            return result;
        } catch (cause) {
            throw poisonStore(cause);
        }
    });
}

function ensurePersistoGlobals() {
    if (!globalThis.$$) {
        globalThis.$$ = {};
    }
    if (typeof globalThis.$$.throwError !== 'function') {
        globalThis.$$.throwError = async (...parts) => {
            const error = parts.find((part) => part instanceof Error);
            if (error) {
                throw error;
            }
            throw new Error(parts.map(String).join(' '));
        };
    }
}

async function initialise() {
    const folder = process.env.PERSISTENCE_FOLDER;
    if (!folder) {
        throw new Error('PERSISTENCE_FOLDER is required; UserPersisto refuses to start without durable Persisto storage.');
    }
    mkdirSync(folder, { recursive: true });
    ensurePersistoGlobals();
    const { initialisePersisto } = require('../vendor/Persisto/src/persistence/Persisto.cjs');
    const durable = await createDurableStorage(folder);
    activeDurable = durable;
    try {
        const persisto = await initialisePersisto(durable.storage, { smartLog: async () => {} });
        await ensureSchema(persisto);
        // A flush must exclude CRUD while Persisto gathers and clears dirty
        // objects. Domain-level serialization remains responsible for workflows.
        let tail = Promise.resolve();
        return new Proxy(persisto, {
            get(target, name) {
                if (typeof target[name] !== 'function') return target[name];
                return (...args) => withPersistenceScope(() => {
                    const operation = tail.then(async () => {
                        if (name !== 'shutDown') durable.check();
                        await faultInjector?.('before', String(name), args);
                        const result = await target[name](...args);
                        await faultInjector?.('after', String(name), args);
                        return result;
                    });
                    tail = operation.catch(() => {});
                    return operation;
                });
            },
        });
    } catch (error) {
        durable.abandon();
        throw error;
    }
}

export function getStore() {
    if (!storePromise) {
        storePromise = initialise();
    }
    return storePromise;
}

export async function flush() {
    const store = await getStore();
    await store.forceSave();
}

export async function resetStoreForTests() {
    try {
        if (storePromise) {
            const store = await storePromise;
            await store.shutDown();
        }
    } finally {
        storePromise = null;
        activeDurable = null;
        faultInjector = null;
        resetSerialForTests();
    }
}

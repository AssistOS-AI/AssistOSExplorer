import { withPersistenceScope } from './persistence-scope.mjs';

const tails = new Map();

export async function serialize(key, operation) {
    const normalizedKey = String(key || 'global');
    const previous = tails.get(normalizedKey) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    tails.set(normalizedKey, current);
    await previous.catch(() => {});
    try {
        return await operation();
    } finally {
        release();
        if (tails.get(normalizedKey) === current) {
            tails.delete(normalizedKey);
        }
    }
}

export function serializePersisted(key, operation) {
    return serialize(key, () => withPersistenceScope(operation));
}

export function resetSerialForTests() {
    tails.clear();
}

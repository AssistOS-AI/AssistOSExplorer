import { AsyncLocalStorage } from 'node:async_hooks';

const ownership = new AsyncLocalStorage();
let tail = Promise.resolve();

// Critical local workflows hold this scope across their CRUD calls and flush.
// Every other store access also enters it, so unrelated saves cannot expose a
// half-created owner or half-applied credit operation. Network work stays out.
export async function withPersistenceScope(operation) {
    if (ownership.getStore()?.active) return operation();
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const owner = { active: true };
    try {
        return await ownership.run(owner, operation);
    } finally {
        owner.active = false;
        release();
    }
}

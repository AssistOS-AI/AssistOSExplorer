export function preparationCancelled() {
    return Object.assign(new Error('Preparation cancelled'), { code: 'PREPARATION_CANCELLED' });
}

// Shared cache work outlives a cancelled consumer; only its owner aborts the work.
export function waitForPreparation(operation, signal) {
    const pending = Promise.resolve(operation);
    if (!signal) return pending;
    if (signal.aborted) {
        void pending.catch(() => {});
        return Promise.reject(preparationCancelled());
    }
    return new Promise((resolve, reject) => {
        const cancelled = () => { cleanup(); reject(preparationCancelled()); };
        const cleanup = () => signal.removeEventListener('abort', cancelled);
        signal.addEventListener('abort', cancelled, { once: true });
        pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

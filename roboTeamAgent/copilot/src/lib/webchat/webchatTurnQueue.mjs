export function appendRecoveringTask(previousTask, task, { onPreviousError = null } = {}) {
    return Promise.resolve(previousTask)
        .catch((error) => {
            try {
                onPreviousError?.(error);
            } catch (_) {
                // Queue recovery must not depend on diagnostics succeeding.
            }
        })
        .then(task);
}

export async function runBoundedCleanup(task, {
    timeoutMs = 5000,
    onError = null,
    onTimeout = null,
} = {}) {
    const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
        ? Math.max(1, Number(timeoutMs))
        : 5000;
    let timeoutHandle = null;
    const cleanupTask = Promise.resolve()
        .then(task)
        .catch((error) => {
            try {
                onError?.(error);
            } catch (_) {
                // Cleanup failures are best-effort diagnostics only.
            }
            return null;
        });
    const timeoutTask = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => {
            try {
                onTimeout?.(normalizedTimeoutMs);
            } catch (_) {
                // Timeout diagnostics must not block the prompt queue.
            }
            resolve(null);
        }, normalizedTimeoutMs);
    });

    try {
        return await Promise.race([cleanupTask, timeoutTask]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

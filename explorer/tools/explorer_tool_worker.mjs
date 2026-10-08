#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleExplorerToolCall } from './explorer_tool.mjs';

const UNCONFIRMED_LOCK_RELEASE_KEY = Symbol.for('assistos.explorer.unconfirmedLockRelease');
export const RECYCLE_REQUEST_ENV = 'EXPLORER_TOOL_WORKER_RECYCLE';

// A document lock whose release could not be confirmed stays on disk owned by this live pid, which would block
// every other worker. Changing process.env during a call is the supported way to make the Ploinky worker
// restore the environment and recycle (exit) after delivering the result, so the lock owner becomes dead and
// the lock is recovered through the existing dead-pid path.
export function requestRecycleIfLockUnconfirmed(env = process.env) {
    if (!globalThis[UNCONFIRMED_LOCK_RELEASE_KEY]) return false;
    globalThis[UNCONFIRMED_LOCK_RELEASE_KEY] = false;
    env[RECYCLE_REQUEST_ENV] = '1';
    return true;
}

export function createExplorerWorkerHandler({ handleCall = handleExplorerToolCall } = {}) {
    return async ({ envelope, toolEnv, stdout, stderr }) => {
        try {
            await handleCall({ envelope, toolEnv, stdout });
            return { exitCode: 0 };
        } catch (error) {
            stderr.write(`${error?.message || String(error)}\n`);
            return { exitCode: 1 };
        } finally {
            requestRecycleIfLockUnconfirmed();
        }
    };
}

export async function serveExplorerToolWorker({
    workerModulePath = process.env.PLOINKY_TOOL_WORKER_MODULE,
} = {}) {
    if (typeof workerModulePath !== 'string' || !path.isAbsolute(workerModulePath)) {
        throw new Error('Explorer worker requires an absolute PLOINKY_TOOL_WORKER_MODULE path.');
    }
    const { serveToolWorker } = await import(pathToFileURL(workerModulePath).href);
    await serveToolWorker(createExplorerWorkerHandler());
}
function isDirectExecution() {
    try {
        return Boolean(process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
    } catch {
        return false;
    }
}

if (isDirectExecution()) {
    serveExplorerToolWorker().catch((error) => {
        process.stderr.write(`${error?.message || String(error)}\n`);
        process.exitCode = 1;
    });
}

#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleExplorerToolCall } from './explorer_tool.mjs';

export async function serveExplorerToolWorker({
    workerModulePath = process.env.PLOINKY_TOOL_WORKER_MODULE,
} = {}) {
    if (typeof workerModulePath !== 'string' || !path.isAbsolute(workerModulePath)) {
        throw new Error('Explorer worker requires an absolute PLOINKY_TOOL_WORKER_MODULE path.');
    }
    const { serveToolWorker } = await import(pathToFileURL(workerModulePath).href);
    await serveToolWorker(async ({ envelope, toolEnv, stdout, stderr }) => {
        try {
            await handleExplorerToolCall({ envelope, toolEnv, stdout });
            return { exitCode: 0 };
        } catch (error) {
            stderr.write(`${error?.message || String(error)}\n`);
            return { exitCode: 1 };
        }
    });
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

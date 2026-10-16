#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_TASK_ENV_NAMES = Object.freeze([
    'FAKE_BWRAP_ARGS_PATH',
    'FAKE_OPENCODE_FAIL',
    'FAKE_OPENCODE_WAIT_MS',
    'FAKE_PI_ASSISTANT_ERROR',
    'FAKE_PI_FAIL',
    'FAKE_PI_WAIT_MS',
    'OPENCODE_ARGS_PATH',
    'OPENCODE_PROJECT_DIR',
    'OPENCODE_TITLE_PATH',
    'PI_ARGS_PATH',
    'PI_CODING_AGENT_DIR',
    'PI_ENV_PATH',
]);

const scriptPath = path.resolve(String(process.argv[2] || ''));
const bwrapPath = path.resolve(String(process.env.TEST_TASK_BWRAP_BIN || ''));
if (!process.argv[2] || !process.env.TEST_TASK_BWRAP_BIN) {
    throw new Error('script path and TEST_TASK_BWRAP_BIN are required');
}

const procInspector = () => Object.freeze({
    ok: true,
    processPid: process.pid,
    procSelfPid: process.pid,
    pidNamespaceVisible: true,
    namespaceDevice: 'test-device',
    namespaceInode: 'test-inode',
    error: null,
});
const mode = String(process.env.TEST_TASK_BWRAP_MODE || 'private');
const spawnSyncImpl = mode === 'fail'
    ? () => ({ status: 1, stderr: 'test capability unavailable' })
    : undefined;

const module = await import(pathToFileURL(scriptPath));
if (typeof module.main !== 'function') throw new Error(`${scriptPath} does not export main()`);
await module.main({
    sandboxDependencies: Object.freeze({
        bwrapPath,
        procInspector,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
        taskEnvironmentNames: TEST_TASK_ENV_NAMES,
    }),
});

// Fake Ploinky lock module for the QA custody fixtures. It works on real
// directories and follows the D4 contract of BOX_STATE_IN_WORKSPACE_PLAN_R2:
// its lock lives in `<workspaceRoot>/.ploinky-box/locks/workspace.lock/` and so
// follows a renamed workspace. Error codes match D4 and Ploinky's own module,
// except PLOINKY_BOX_LOCK_BUSY: the fake fails at once on a held lock, where
// the real module waits up to its `timeoutMs`.
//
// Opt-in real run: with `QA_REAL_LOCK_MODULE=<absolute path of locks.mjs>` the
// same fixtures run against Ploinky's own lock module instead. A recording
// shim keeps the fake's `calls` log and passes a short `timeoutMs` to the real
// manager, so a contended lock fails fast instead of waiting 30 seconds.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const lstat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export const REAL_LOCK_MODULE = process.env.QA_REAL_LOCK_MODULE || null;
export const REAL_LOCK_TIMEOUT_MS = 500;
const realModule = REAL_LOCK_MODULE ? await import(pathToFileURL(REAL_LOCK_MODULE).href) : null;

function recordingShim(real, calls) {
    return {
        calls,
        createMutationLockManager(managerOptions = {}) {
            const manager = real.createMutationLockManager({ timeoutMs: REAL_LOCK_TIMEOUT_MS, retryMs: 10, ...managerOptions });
            return {
                async acquire(instance, options = {}) {
                    calls.push({ op: 'acquire', args: [instance, options] });
                    const lock = await manager.acquire(instance, options);
                    const through = op => (...args) => { calls.push({ op, args }); return lock[op](...args); };
                    return { assertHeld: through('assertHeld'), assertHeldAt: through('assertHeldAt'), release: through('release'),
                        releaseRelocated: through('releaseRelocated'), relinquishDeleted: through('relinquishDeleted') };
                },
            };
        },
    };
}

export function workspaceLockModule({ calls = [] } = {}) {
    if (realModule) return recordingShim(realModule, calls);
    const lockPathOf = root => path.join(root, '.ploinky-box', 'locks', 'workspace.lock');
    return {
        calls,
        createMutationLockManager() {
            return {
                async acquire(instance, options = {}) {
                    calls.push({ op: 'acquire', args: [instance, options] });
                    const { workspaceRoot, requireNewSkeleton = false } = options;
                    if (!workspaceRoot) fail('PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED');
                    const root = lstat(workspaceRoot);
                    if (!root) fail('PLOINKY_BOX_WORKSPACE_ABSENT');
                    if (!root.isDirectory()) fail('PLOINKY_BOX_WORKSPACE_INVALID');
                    const boxState = path.join(workspaceRoot, '.ploinky-box');
                    try { fs.mkdirSync(boxState, { mode: 0o700 }); } catch (error) {
                        if (error.code !== 'EEXIST') throw error;
                        if (requireNewSkeleton) fail('PLOINKY_BOX_HOST_STATE_NOT_NEW');
                    }
                    for (const [name, mode] of [['locks', 0o700], ['quarantine', 0o700], ['empty', 0o555]]) {
                        try { fs.mkdirSync(path.join(boxState, name), { mode }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
                    }
                    const lockPath = lockPathOf(workspaceRoot);
                    try { fs.mkdirSync(lockPath, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('PLOINKY_BOX_LOCK_BUSY'); throw error; }
                    const owner = JSON.stringify({ schema: 'ploinky-lock', version: 2, label: 'workspace', instance, workspaceRoot, pid: process.pid });
                    fs.writeFileSync(path.join(lockPath, 'owner.json'), owner, { mode: 0o600 });
                    const { dev, ino } = fs.lstatSync(lockPath);
                    let released = false;
                    const heldAt = (root, code) => {
                        const file = lockPathOf(root), stat = lstat(file);
                        if (released || !stat || stat.dev !== dev || stat.ino !== ino
                            || fs.readFileSync(path.join(file, 'owner.json'), 'utf8') !== owner) fail(code);
                        return file;
                    };
                    const remove = file => { fs.rmSync(path.join(file, 'owner.json')); fs.rmdirSync(file); released = true; };
                    return {
                        assertHeld(value) {
                            calls.push({ op: 'assertHeld', args: [value] });
                            if (value !== instance) fail('PLOINKY_BOX_LOCK_INSTANCE_MISMATCH');
                            heldAt(workspaceRoot, 'PLOINKY_BOX_LOCK_RELOCATED');
                        },
                        assertHeldAt(root) { calls.push({ op: 'assertHeldAt', args: [root] }); heldAt(root, 'PLOINKY_BOX_LOCK_NOT_AT_PATH'); },
                        release() { calls.push({ op: 'release', args: [] }); remove(heldAt(workspaceRoot, 'PLOINKY_BOX_LOCK_RELOCATED')); },
                        releaseRelocated(root) { calls.push({ op: 'releaseRelocated', args: [root] }); remove(heldAt(root, 'PLOINKY_BOX_LOCK_NOT_AT_PATH')); },
                        relinquishDeleted() {
                            calls.push({ op: 'relinquishDeleted', args: [] });
                            if (released || lstat(workspaceRoot)) fail('PLOINKY_BOX_WORKSPACE_PRESENT');
                            released = true;
                        },
                    };
                },
            };
        },
    };
}

/**
 * Writes `<runtimeRoot>/.runtime/ploinky/ploinky-box/locks.mjs` re-exporting the
 * fake (or, in the opt-in real run, the recording shim), so production adapters
 * import it as they would the deployed runtime's module. Returns the module
 * URL; importing it again yields the same instance and its `calls` log.
 */
export function writeLockModule(runtimeRoot, options = {}) {
    const file = path.join(runtimeRoot, '.runtime/ploinky/ploinky-box/locks.mjs');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `import { workspaceLockModule } from ${JSON.stringify(import.meta.url)};\n`
        + `const module = workspaceLockModule(${JSON.stringify(options)});\n`
        + 'export const { createMutationLockManager, calls } = module;\n');
    return pathToFileURL(file).href;
}

// Fake Ploinky lock modules for the QA custody fixtures. Both work on real
// directories. The legacy module keeps its lock outside the workspace, as
// Ploinky did before host state moved into the workspace; the workspace module
// follows the D4 contract of BOX_STATE_IN_WORKSPACE_PLAN_R2: its lock lives in
// `<workspaceRoot>/.ploinky-host/locks/workspace.lock/` and so follows a
// renamed workspace. Error codes match D4 except PLOINKY_BOX_HOST_STATE_NOT_NEW
// and PLOINKY_BOX_LOCK_BUSY, which only these fakes define.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const lstat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function legacyLockModule({ stateRoot, calls = [] }) {
    return {
        calls,
        createMutationLockManager() {
            return {
                async acquire(...args) {
                    calls.push({ op: 'acquire', args });
                    const [instance] = args;
                    const lockPath = path.join(stateRoot, 'locks', `${instance}.lock`);
                    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
                    try { fs.mkdirSync(lockPath, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('PLOINKY_BOX_LOCK_BUSY'); throw error; }
                    const owner = JSON.stringify({ instance, pid: process.pid });
                    fs.writeFileSync(path.join(lockPath, 'owner.json'), owner, { mode: 0o600 });
                    let released = false;
                    return {
                        assertHeld(value) {
                            calls.push({ op: 'assertHeld', args: [value] });
                            if (released || value !== instance || fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8') !== owner) fail('PLOINKY_BOX_LOCK_LOST');
                        },
                        release() {
                            calls.push({ op: 'release', args: [] });
                            // Like the real module, release re-reads the owner record.
                            if (fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8') !== owner) fail('PLOINKY_BOX_LOCK_LOST');
                            fs.rmSync(lockPath, { recursive: true }); released = true;
                        },
                    };
                },
            };
        },
    };
}

export function workspaceLockModule({ calls = [] } = {}) {
    const lockPathOf = root => path.join(root, '.ploinky-host', 'locks', 'workspace.lock');
    return {
        MUTATION_LOCK_LOCATION: 'workspace',
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
                    const hostState = path.join(workspaceRoot, '.ploinky-host');
                    try { fs.mkdirSync(hostState, { mode: 0o700 }); } catch (error) {
                        if (error.code !== 'EEXIST') throw error;
                        if (requireNewSkeleton) fail('PLOINKY_BOX_HOST_STATE_NOT_NEW');
                    }
                    for (const [name, mode] of [['locks', 0o700], ['quarantine', 0o700], ['empty', 0o555]]) {
                        try { fs.mkdirSync(path.join(hostState, name), { mode }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
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
 * Writes `<runtimeRoot>/.runtime/ploinky/ploinky-box/locks.mjs` re-exporting one
 * fake generation, so production adapters import and detect it as they would the
 * deployed runtime's module. Returns the module URL; importing it again yields
 * the same instance and its `calls` log.
 */
export function writeLockModule(runtimeRoot, generation, options = {}) {
    const file = path.join(runtimeRoot, '.runtime/ploinky/ploinky-box/locks.mjs');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const factory = generation === 'workspace' ? 'workspaceLockModule' : 'legacyLockModule';
    const exports = generation === 'workspace' ? 'MUTATION_LOCK_LOCATION, createMutationLockManager, calls' : 'createMutationLockManager, calls';
    fs.writeFileSync(file, `import { ${factory} } from ${JSON.stringify(import.meta.url)};\n`
        + `const module = ${factory}(${JSON.stringify(options)});\n`
        + `export const { ${exports} } = module;\n`);
    return pathToFileURL(file).href;
}

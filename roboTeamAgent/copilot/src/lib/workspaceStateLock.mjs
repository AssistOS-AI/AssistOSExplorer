import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
    assertSafeAchillesPrivatePath,
    ensureAchillesPrivateDataRoot,
    ensureSafeAchillesPrivateDirectory,
} from './privateDataRoot.mjs';

const mutations = new AsyncLocalStorage();
const MUTATION_WAIT_MS = 5000;

function lockError(code, message) {
    return Object.assign(new Error(message), { code });
}

function processIdentity(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces or closing parentheses; fields after its final ')' start at field 3.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] || '') || !fields[0]) {
        throw new Error('Invalid Linux process identity.');
    }
    return { start: fields[19], state: fields[0] };
}

function ownerIdentity() {
    try {
        return {
            pid: process.pid,
            start: processIdentity(process.pid).start,
            boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
            token: randomUUID(),
        };
    } catch {
        throw lockError('WORKSPACE_STATE_LOCK_AMBIGUOUS', 'Linux process and boot identity are required for workspace locks.');
    }
}

function validOwner(owner) {
    return owner && Number.isSafeInteger(owner.pid) && owner.pid > 0
        && /^\d+$/.test(owner.start) && typeof owner.start === 'string'
        && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(owner.boot)
        && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(owner.token);
}

function ownerState(owner, boot) {
    if (!validOwner(owner)) return 'ambiguous';
    if (owner.boot !== boot) return 'dead';
    try {
        const current = processIdentity(owner.pid);
        return current.start !== owner.start || ['Z', 'X'].includes(current.state) ? 'dead' : 'live';
    } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') return 'ambiguous';
        try {
            process.kill(owner.pid, 0);
            return 'ambiguous';
        } catch (probeError) {
            return probeError?.code === 'ESRCH' ? 'dead' : 'ambiguous';
        }
    }
}

function lockContext(workingDir, filename) {
    const root = fs.realpathSync(ensureAchillesPrivateDataRoot(workingDir));
    ensureSafeAchillesPrivateDirectory(workingDir, 'locks');
    const child = path.join('locks', filename);
    const safePath = (suffix = '') => assertSafeAchillesPrivatePath(workingDir, `${child}${suffix}`, {
        type: 'file', label: 'Workspace state lock',
    });
    return { root, safePath };
}

function snapshot(context, suffix = '') {
    let fd;
    try {
        fd = fs.openSync(context.safePath(suffix), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096) {
            throw lockError('WORKSPACE_STATE_LOCK_AMBIGUOUS', 'Workspace lock is not a valid owner record.');
        }
        let owner;
        try { owner = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { owner = null; }
        return { owner, ino: stat.ino, dev: stat.dev };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function removeOwned(context, expected, suffix = '') {
    const current = snapshot(context, suffix);
    if (!current) return;
    if (current.ino !== expected.ino || current.dev !== expected.dev
        || current.owner?.token !== expected.owner?.token) {
        throw lockError('WORKSPACE_STATE_LOCK_RECOVERY', 'Workspace lock ownership changed; refusing to remove it.');
    }
    fs.unlinkSync(context.safePath(suffix));
}

function createOwner(context, owner, suffix = '') {
    let fd;
    try {
        fd = fs.openSync(context.safePath(suffix), fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
        if (error?.code === 'EEXIST') return null;
        throw error;
    }
    try {
        fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
        const stat = fs.fstatSync(fd);
        return { owner, ino: stat.ino, dev: stat.dev };
    } finally {
        fs.closeSync(fd);
    }
}

function tryAcquire(context, owner) {
    const recovery = snapshot(context, '.recovery');
    if (recovery) {
        if (ownerState(recovery.owner, owner.boot) === 'live') return null;
        throw lockError('WORKSPACE_STATE_LOCK_RECOVERY', 'Workspace lock recovery has an abandoned or ambiguous claim; refusing to remove it.');
    }
    const acquired = createOwner(context, owner);
    if (acquired) {
        if (snapshot(context, '.recovery')) {
            removeOwned(context, acquired);
            return null;
        }
        return acquired;
    }
    const previous = snapshot(context);
    if (!previous) return null;
    const state = ownerState(previous.owner, owner.boot);
    if (state === 'live') return null;
    if (state !== 'dead') {
        throw lockError('WORKSPACE_STATE_LOCK_AMBIGUOUS', 'Workspace lock owner cannot be proven dead; refusing recovery.');
    }
    const claim = createOwner(context, owner, '.recovery');
    if (!claim) return null;
    try {
        const current = snapshot(context);
        if (current && current.owner?.token === previous.owner.token
            && ownerState(current.owner, owner.boot) === 'dead') {
            removeOwned(context, current);
        }
    } finally {
        removeOwned(context, claim, '.recovery');
    }
    return null;
}

async function acquire(context, waitMs) {
    const owner = ownerIdentity();
    const deadline = performance.now() + waitMs;
    let incompleteRecord = false;
    // A dead record can be recovered without sleeping even for an immediate lease.
    for (let attempt = 0; ; attempt += 1) {
        let acquired;
        try {
            acquired = tryAcquire(context, owner);
            incompleteRecord = false;
        } catch (error) {
            // Another process can observe wx creation before its owner write completes.
            // Wait once without removing or joining that ambiguous lock.
            if (waitMs && !incompleteRecord && performance.now() < deadline
                && error?.code === 'WORKSPACE_STATE_LOCK_AMBIGUOUS') {
                incompleteRecord = true;
                await delay(Math.min(20, Math.max(1, deadline - performance.now())));
                continue;
            }
            throw error;
        }
        if (acquired) {
            let released = false;
            return async () => {
                if (released) return;
                removeOwned(context, acquired);
                released = true;
            };
        }
        if (waitMs === 0) {
            if (attempt === 0 && !snapshot(context)) continue;
            throw lockError('WORKSPACE_STATE_BUSY', 'This workspace execution is already running.');
        }
        if (performance.now() >= deadline) {
            throw lockError('WORKSPACE_STATE_BUSY', 'Timed out waiting for a workspace state mutation.');
        }
        await delay(Math.min(20, Math.max(1, deadline - performance.now())));
    }
}

export async function withWorkspaceMutation(workingDir, callback) {
    if (typeof callback !== 'function') throw new TypeError('A workspace mutation callback is required.');
    const context = lockContext(workingDir, 'mutation.lock');
    const inherited = mutations.getStore();
    if (inherited?.get(context.root)?.active) return callback();
    const release = await acquire(context, MUTATION_WAIT_MS);
    const scope = { active: true };
    const owners = new Map(inherited);
    owners.set(context.root, scope);
    try {
        return await mutations.run(owners, callback);
    } finally {
        scope.active = false;
        await release();
    }
}

export async function acquireExecutionLease(workingDir, key) {
    if (typeof key !== 'string' || !key.trim()) throw new TypeError('An execution lease key is required.');
    const filename = `execution-${createHash('sha256').update(key).digest('hex')}.lock`;
    const context = lockContext(workingDir, filename);
    if (mutations.getStore()?.get(context.root)?.active) {
        throw lockError('WORKSPACE_STATE_LOCK_ORDER', 'Acquire execution leases before workspace mutations.');
    }
    return acquire(context, 0);
}

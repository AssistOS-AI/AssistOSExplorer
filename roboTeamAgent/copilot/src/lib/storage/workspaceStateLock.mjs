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
import { errorFields, logDiagnostic, tokenPrefix } from './copilotDiagnostics.mjs';

const mutations = new AsyncLocalStorage();
const MUTATION_WAIT_MS = 5000;
// Leases and mutation locks this process currently holds, by lock path. A holder is
// active from acquisition until its release is attempted.
const held = new Map();
// Records this process created whose removal failed, by lock path, so a later acquisition
// in this process can recover them instead of refusing its own live pid forever.
const orphaned = new Map();

function callerFrame() {
    try {
        const frames = String(new Error().stack).split('\n').slice(2);
        const frame = frames.find((line) => !line.includes('workspaceStateLock.mjs'));
        return frame ? frame.trim().replace(/\(?file:\/\/|\)$/g, '').slice(0, 200) : null;
    } catch { return null; }
}

function describe(context, extra = {}) {
    return { lock: context.filename, kind: context.kind, ...extra };
}

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

function lockContext(workingDir, filename, kind) {
    const root = fs.realpathSync(ensureAchillesPrivateDataRoot(workingDir));
    ensureSafeAchillesPrivateDirectory(workingDir, 'locks');
    const child = path.join('locks', filename);
    const safePath = (suffix = '') => assertSafeAchillesPrivatePath(workingDir, `${child}${suffix}`, {
        type: 'file', label: 'Workspace state lock',
    });
    return { root, safePath, workingDir, filename, kind };
}

function lockKey(context, suffix = '') {
    return path.join(context.root, 'locks', `${context.filename}${suffix}`);
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

// Ownership is the random token written for each acquisition, never inode or device
// identity. Guest-visible inode numbers on virtiofs shares (macOS hosts) are not stable:
// an unchanged lock file can report another st_ino during a turn, and an identity check
// would then refuse to release a lease this process still owns. Inode and device are
// logged for diagnosis only. A missing, unreadable or foreign token still fails closed.
function removeOwned(context, expected, suffix = '') {
    const log = (result, extra = {}) => logDiagnostic(context.workingDir, 'lock.remove', describe(context, {
        suffix, result, expectedIno: expected.ino, expectedDev: expected.dev,
        expectedToken: tokenPrefix(expected.owner?.token), ...extra }));
    let current;
    let identityChanged = false;
    try {
        current = snapshot(context, suffix);
        if (!current) { log('already-absent'); return; }
        if (!validOwner(expected.owner) || !validOwner(current.owner)
            || current.owner.token !== expected.owner.token) {
            log('mismatch', { currentIno: current.ino, currentDev: current.dev,
                currentToken: tokenPrefix(current.owner?.token), currentOwnerPid: current.owner?.pid ?? null });
            throw lockError('WORKSPACE_STATE_LOCK_RECOVERY', 'Workspace lock ownership changed; refusing to remove it.');
        }
        identityChanged = current.ino !== expected.ino || current.dev !== expected.dev;
        fs.unlinkSync(context.safePath(suffix));
    } catch (error) {
        log('error', { currentIno: current?.ino ?? null, currentDev: current?.dev ?? null,
            currentToken: tokenPrefix(current?.owner?.token), ...errorFields(error) });
        throw error;
    }
    log(identityChanged ? 'identity-changed-token-match' : 'removed', identityChanged
        ? { currentIno: current.ino, currentDev: current.dev, currentToken: tokenPrefix(current.owner.token) } : {});
}

// Removes a record this process created. If removal fails, the record is remembered so the
// next acquisition of the same path in this process can recover it.
function removeOwnRecord(context, record, suffix = '', lease = { released: false }) {
    try {
        removeOwned(context, record, suffix);
    } catch (error) {
        orphaned.set(lockKey(context, suffix), { token: record.owner.token, lease });
        throw error;
    }
    if (orphaned.get(lockKey(context, suffix))?.token === record.owner.token) orphaned.delete(lockKey(context, suffix));
}

// Recovers a record this process created and failed to remove. It must carry this process's
// identity and a token whose removal failed here, and no in-process holder may be active
// for that path; a concurrent turn of the same session therefore still gets BUSY.
function recoverOwnOrphan(context, owner, record, suffix = '') {
    const key = lockKey(context, suffix);
    const orphan = orphaned.get(key);
    if (!orphan || held.has(key) || !validOwner(record.owner) || record.owner.token !== orphan.token
        || record.owner.pid !== owner.pid || record.owner.start !== owner.start || record.owner.boot !== owner.boot) {
        return false;
    }
    removeOwned(context, record, suffix);
    orphaned.delete(key);
    orphan.lease.released = true;
    logDiagnostic(context.workingDir, 'lock.recovered-own-orphan', describe(context, {
        suffix, token: tokenPrefix(orphan.token), ino: record.ino, dev: record.dev }));
    return true;
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
    if (recovery && !recoverOwnOrphan(context, owner, recovery, '.recovery')) {
        if (ownerState(recovery.owner, owner.boot) === 'live') return null;
        throw lockError('WORKSPACE_STATE_LOCK_RECOVERY', 'Workspace lock recovery has an abandoned or ambiguous claim; refusing to remove it.');
    }
    let acquired = createOwner(context, owner);
    if (!acquired) {
        const previous = snapshot(context);
        if (!previous) return null;
        if (!recoverOwnOrphan(context, owner, previous)) return recoverDeadOwner(context, owner, previous);
        acquired = createOwner(context, owner);
        if (!acquired) return null;
    }
    if (snapshot(context, '.recovery')) {
        removeOwnRecord(context, acquired);
        return null;
    }
    return acquired;
}

function recoverDeadOwner(context, owner, previous) {
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
        removeOwnRecord(context, claim, '.recovery');
    }
    return null;
}

async function acquire(context, waitMs, label) {
    const log = (event, extra = {}) => logDiagnostic(context.workingDir, event, describe(context, extra));
    let owner;
    try { owner = ownerIdentity(); } catch (error) { log('lock.acquire.error', { stage: 'identity', ...errorFields(error) }); throw error; }
    const token = tokenPrefix(owner.token);
    const deadline = performance.now() + waitMs;
    let incompleteRecord = false;
    log('lock.acquire.begin', { waitMs, token, label });
    // A dead record can be recovered without sleeping even for an immediate lease.
    for (let attempt = 0; ; attempt += 1) {
        let acquired;
        try {
            acquired = tryAcquire(context, owner);
            incompleteRecord = false;
        } catch (error) {
            log('lock.acquire.error', { attempt, token, ...errorFields(error) });
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
            const acquiredAt = new Date().toISOString();
            const key = lockKey(context);
            const lease = { released: false };
            // A new record at this path proves any earlier failed record there is gone.
            orphaned.delete(key);
            held.set(key, { token, label, kind: context.kind, acquiredAt, ino: acquired.ino, dev: acquired.dev });
            log('lock.acquired', { attempt, token, ownerPid: owner.pid, ino: acquired.ino, dev: acquired.dev, label });
            return async () => {
                if (lease.released) { log('lock.release.repeat', { token, label }); return; }
                log('lock.release.begin', { token, label, heldMs: Date.now() - Date.parse(acquiredAt) });
                // The holder ends with its release attempt, whether or not removal succeeds.
                if (held.get(key)?.token === token) held.delete(key);
                try {
                    removeOwnRecord(context, acquired, '', lease);
                } catch (error) {
                    log('lock.release.error', { token, label, expectedIno: acquired.ino, expectedDev: acquired.dev,
                        orphaned: orphaned.get(key)?.lease === lease, ...errorFields(error) });
                    throw error;
                }
                lease.released = true;
                log('lock.release.done', { token, label });
            };
        }
        if (waitMs === 0) {
            if (attempt === 0 && !snapshot(context)) continue;
            reportBusy(context, owner, 'immediate', attempt);
            throw lockError('WORKSPACE_STATE_BUSY', 'This workspace execution is already running.');
        }
        if (performance.now() >= deadline) {
            reportBusy(context, owner, 'timeout', attempt);
            throw lockError('WORKSPACE_STATE_BUSY', 'Timed out waiting for a workspace state mutation.');
        }
        await delay(Math.min(20, Math.max(1, deadline - performance.now())));
    }
}

function reportBusy(context, owner, mode, attempt) {
    try {
        let current = null;
        let readError = null;
        try { current = snapshot(context); } catch (error) { readError = errorFields(error); }
        const mine = held.get(lockKey(context)) || null;
        logDiagnostic(context.workingDir, 'lock.busy', describe(context, {
            mode, attempt, requesterToken: tokenPrefix(owner.token),
            ownerPid: current?.owner?.pid ?? null,
            ownerIsThisProcess: current?.owner?.pid === process.pid,
            ownerToken: tokenPrefix(current?.owner?.token),
            ownerState: current ? ownerState(current.owner, owner.boot) : 'absent',
            ino: current?.ino ?? null, dev: current?.dev ?? null,
            thisProcessHolds: Boolean(mine),
            thisProcessHold: mine && { ...mine, heldMs: Date.now() - Date.parse(mine.acquiredAt),
                tokenMatchesFile: mine.token === tokenPrefix(current?.owner?.token) },
            heldCount: held.size,
            thisProcessOrphan: orphaned.has(lockKey(context)),
            readError,
        }));
    } catch (error) {
        logDiagnostic(context.workingDir, 'lock.busy.error', errorFields(error));
    }
}

export async function withWorkspaceMutation(workingDir, callback) {
    if (typeof callback !== 'function') throw new TypeError('A workspace mutation callback is required.');
    const context = lockContext(workingDir, 'mutation.lock', 'mutation');
    const inherited = mutations.getStore();
    if (inherited?.get(context.root)?.active) return callback();
    const release = await acquire(context, MUTATION_WAIT_MS, callerFrame());
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

export async function acquireExecutionLease(workingDir, key, { label } = {}) {
    if (typeof key !== 'string' || !key.trim()) throw new TypeError('An execution lease key is required.');
    const filename = `execution-${createHash('sha256').update(key).digest('hex')}.lock`;
    const kind = key.startsWith('task-continuation:') ? 'task-continuation' : key.startsWith('session:') ? 'session' : 'execution';
    const context = lockContext(workingDir, filename, kind);
    if (mutations.getStore()?.get(context.root)?.active) {
        throw lockError('WORKSPACE_STATE_LOCK_ORDER', 'Acquire execution leases before workspace mutations.');
    }
    return acquire(context, 0, label || callerFrame());
}

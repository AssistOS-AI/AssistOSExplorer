// The root lease of a mounted filtered view (decision D-S5-6, plan section 16; S5 decisions delta sections 5 and 15).
//
// Moving the grant root, or an ancestor between the workspace root and the grant root, must not leave the file server's
// grant-root descriptor indefinitely usable. The file server's authority does not grow for this: it keeps exactly the
// /dev/fuse connection and the grant-root descriptor. Detection runs in the supervisor, which holds the anchored walk
// chain (grant.verifyBinding in grantResolver.mjs). Enforcement runs in the keeper, the file server's parent. Absence of
// proof refuses: the lease expires unless it is renewed.
//
//   supervisor (createRootLeaseIssuer)            keeper (createRootLeaseKeeper, reference model of the Rust keeper)
//   initial(): mount_view.rootLease {epoch 1}     validUntil = receipt + ttlMs
//   next() every rootLeaseRenewMs:
//     bound    -> renew  {epoch n+1, ttlMs}       validUntil = receipt + ttlMs
//     unproven -> no frame                        the lease runs on toward expiry
//     unbound  -> revoke {epoch n+1, reason}      'revoking': SIGTERM now, SIGKILL after rootRevokeGraceMs
//     supervisor clock past the lease -> revoke {reason: 'lease_expired'}
//   observeKeeperReply(): a keeper reply 'revoking'/'killed', or a refused lease frame, revokes the issuer too
//   revocationDeadline(), settleRevocation():     the supervisor checks through its own view that the file server
//     the server must be gone by revoke time      identity of the mount reply is gone; if not, or if that cannot be
//     + ttl + grace + verify margin                proven, it kills the keeper (parent-death teardown, plan section 5.5)
//                                                  and the view becomes 'quarantined'.
//
// A revocation is sticky: neither side ever renews again. Recovery is a new admission, continuation or terminal open,
// which re-resolves the grant. A retained GUI resource with a revoked or quarantined view is not reusable
// (isRetainedResourceReusable). Instantaneous revocation is not promised (D2_DECISION.notClaimed).
//
// Everything here is pure: no timers and no I/O. Time comes from `now`, which defaults to a monotonic clock, so a wall-clock
// step cannot extend a lease (review nit N5). Obligations of the Rust keeper that this model cannot show: the expiry timer
// does not wait behind frame-channel or PTY I/O; the leases of the views of one keeper are independent; after the
// hand-off the keeper holds no copy of the /dev/fuse descriptor (G1). The renewal loop is not wired to a keeper channel in
// this slice.

import { validateRootLeaseFrame, validateRootLeaseReply } from './mountFrames.mjs';
import { resolveViewLimits } from './viewLimits.mjs';

export const VIEW_STATES = Object.freeze(['live', 'revoked', 'quarantined']);
export const KEEPER_STATES = Object.freeze(['live', 'revoking', 'killed']);

const LEASE_OP = 'view_root_lease';
const GRANT_ID = /^[a-z0-9][a-z0-9-]*$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const DIGITS = /^[0-9]{1,20}$/u;
const MAX_PID = 4_194_304;

const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOf = (object) => Object.keys(object).sort().join(',');
const isLeaseTtl = (value, limits) => Number.isSafeInteger(value) && value >= 1 && value <= limits.rootLeaseTtlMs;

// The file-server identity of a mount reply (mountFrames.mjs validateMountReply): { pid, startTime, pidNamespaceInode }.
function isProcessIdentity(value) {
    return isPlainObject(value) && keysOf(value) === 'pid,pidNamespaceInode,startTime'
        && Number.isSafeInteger(value.pid) && value.pid >= 1 && value.pid <= MAX_PID
        && typeof value.startTime === 'string' && DIGITS.test(value.startTime)
        && typeof value.pidNamespaceInode === 'string' && DIGITS.test(value.pidNamespaceInode);
}

// --- supervisor side ---------------------------------------------------------------------------------------------------

// grantId: the view's grant id. verify(): the binding check, normally `() => grant.verifyBinding()`; any result other than
// a well-formed bound or unbound, and any thrown error, counts as unproven and never as bound.
export function createRootLeaseIssuer({ grantId, verify, limits: limitOverrides = {}, now = monotonicMs }) {
    const limits = resolveViewLimits(limitOverrides);
    if (typeof grantId !== 'string' || !GRANT_ID.test(grantId)) throw new TypeError('The grant id is malformed');
    if (typeof verify !== 'function') throw new TypeError('verify must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const ttlMs = limits.rootLeaseTtlMs;
    let issued = false;
    let busy = false;
    let settling = false;
    let epoch = 0;
    // The supervisor's own view of the lease: the last lease it sent plus its lifetime, measured from sending, which is
    // never later than the keeper's receipt.
    let leaseUntil = null;
    let revoked = null;
    let viewState = 'live';
    let settlement = null;

    async function check() {
        try {
            const result = await verify();
            if (result?.state === 'bound') return { state: 'bound' };
            if (result?.state === 'unbound') {
                return { state: 'unbound', code: typeof result.code === 'string' && ERROR_CODE.test(result.code) ? result.code : 'root_unbound' };
            }
            return { state: 'unproven' };
        } catch {
            return { state: 'unproven' };
        }
    }

    const expired = () => leaseUntil !== null && now() >= leaseUntil;

    function revoke(reason) {
        epoch += 1;
        revoked = Object.freeze({ reason, at: now() });
        viewState = 'revoked';
        return Object.freeze({ frame: Object.freeze({ op: LEASE_OP, grantId, epoch, verdict: 'revoke', reason }), state: 'revoked' });
    }

    // The lease of the mount_view frame. Only a bound result issues one; a failed attempt issues nothing and may be retried.
    async function initial() {
        if (issued || busy) return Object.freeze({ ok: false, code: 'already_issued' });
        busy = true;
        let result;
        try {
            result = await check();
        } finally {
            busy = false;
        }
        if (result.state !== 'bound') return Object.freeze({ ok: false, code: result.state === 'unbound' ? result.code : 'verify_failed' });
        issued = true;
        epoch = 1;
        leaseUntil = now() + ttlMs;
        return Object.freeze({ ok: true, rootLease: Object.freeze({ epoch: 1, ttlMs }) });
    }

    // One renewal tick. Overlapping calls do not verify twice: the second returns state 'busy'. The supervisor's own expiry
    // is evaluated BEFORE the busy check, so a verification that never settles cannot hide it (review r4 F1): the tick that
    // finds the lease lapsed revokes with lease_expired and arms the revocation deadline.
    async function next() {
        if (!issued) throw new Error('No lease was issued: initial() must succeed first');
        if (revoked) return Object.freeze({ frame: null, state: 'revoked' });
        if (expired()) return revoke('lease_expired');
        if (busy) return Object.freeze({ frame: null, state: 'busy' });
        busy = true;
        let result;
        try {
            result = await check();
        } finally {
            busy = false;
        }
        // The late result of a verification that a revocation overtook changes nothing: no second revoke, no epoch, and
        // the deadline stays where the first revocation put it.
        if (revoked) return Object.freeze({ frame: null, state: 'revoked' });
        if (result.state === 'unbound') return revoke(result.code);
        // A verification that outlived the lease must not renew it: the keeper may already have revoked.
        if (expired()) return revoke('lease_expired');
        if (result.state === 'bound') {
            epoch += 1;
            leaseUntil = now() + ttlMs;
            return Object.freeze({ frame: Object.freeze({ op: LEASE_OP, grantId, epoch, verdict: 'renew', ttlMs }), state: 'bound' });
        }
        return Object.freeze({ frame: null, state: 'unproven' });
    }

    // The keeper's reply to a lease frame (review r4 F2). request is the wire frame the reply answers (with its id). A
    // reply that reports the keeper revoking or killed, or that refuses a lease frame, means the keeper's lease is not
    // what the supervisor assumed: the issuer is revoked from then on (reason keeper_revoked for the keeper's own
    // revocation, keeper_refused for any other refusal), sends no further renew, and arms the revocation deadline once.
    // A reply that does not validate changes nothing (the frame channel treats it as a protocol violation).
    function observeKeeperReply(reply, request) {
        if (!isPlainObject(request) || request.op !== LEASE_OP || request.grantId !== grantId
            || !validateRootLeaseReply(reply, request).ok) {
            return Object.freeze({ accepted: false, code: 'bad_reply', viewState });
        }
        let reason = null;
        if (reply.ok === true && reply.value.state !== 'live') reason = 'keeper_revoked';
        if (reply.ok === false) reason = reply.error === 'revoked' ? 'keeper_revoked' : 'keeper_refused';
        if (reason !== null && !revoked) {
            revoked = Object.freeze({ reason, at: now() });
            viewState = 'revoked';
        }
        return Object.freeze({ accepted: true, code: reason ?? 'live', viewState });
    }

    // When the file server must be gone: the revoke (sent, or the supervisor's own observation of expiry) plus a whole
    // lease lifetime, the keeper's grace period and the verification margin. null while the view is not revoked.
    function revocationDeadline() {
        if (!revoked) return null;
        return revoked.at + limits.rootLeaseTtlMs + limits.rootRevokeGraceMs + limits.rootRevokeVerifyMs;
    }

    // After the deadline, confirms the file server's absence through the supervisor's own view (probe), and records the
    // outcome: 'gone' keeps the view 'revoked'; 'alive' or 'unproven' asks for kill_keeper_and_quarantine and makes the view
    // 'quarantined'. Both are final. identity is the fileServer tuple of the mount reply.
    async function settleRevocation({ identity, probe } = {}) {
        if (!revoked) return Object.freeze({ due: false, action: 'none', viewState });
        if (settlement) return settlement;
        const deadline = revocationDeadline();
        if (now() < deadline) return Object.freeze({ due: false, action: 'wait', deadline, viewState });
        if (settling) return Object.freeze({ due: false, action: 'busy', viewState });
        settling = true;
        try {
            const result = await confirmRevocation({ identity, probe });
            if (result.action === 'kill_keeper_and_quarantine') viewState = 'quarantined';
            settlement = Object.freeze({ due: true, state: result.state, action: result.action, viewState });
            return settlement;
        } finally {
            settling = false;
        }
    }

    return Object.freeze({
        initial,
        next,
        revocationDeadline,
        settleRevocation,
        observeKeeperReply,
        viewState: () => viewState,
        revocation: () => revoked,
        epoch: () => epoch
    });
}

// Whether the file server of a revoked view is gone, judged through the supervisor's own view. probe(pid) returns the
// process now at that pid as { pid, startTime, pidNamespaceInode }, or null when there is none (an exited process that
// is not yet reaped holds no descriptors and may be reported as null). Same pid with another start time or PID namespace
// is a different process: gone. Anything that cannot be judged is 'unproven'. Only 'gone' needs no action.
export async function confirmRevocation({ identity, probe } = {}) {
    const decide = (state) => Object.freeze({ state, action: state === 'gone' ? 'none' : 'kill_keeper_and_quarantine' });
    if (!isProcessIdentity(identity) || typeof probe !== 'function') return decide('unproven');
    let seen;
    try {
        seen = await probe(identity.pid);
    } catch {
        return decide('unproven');
    }
    if (seen === null) return decide('gone');
    if (!isProcessIdentity(seen) || seen.pid !== identity.pid) return decide('unproven');
    if (seen.startTime !== identity.startTime || seen.pidNamespaceInode !== identity.pidNamespaceInode) return decide('gone');
    return decide('alive');
}

// The plan section 5.2 reuse rule gains: "and none of its views has been root-revoked". resource: { views: [{ grantId,
// viewState }] } as recorded on the retained resource. A malformed record is never reusable.
export function isRetainedResourceReusable(resource) {
    if (!isPlainObject(resource) || !Array.isArray(resource.views) || resource.views.length === 0) return false;
    return resource.views.every((view) => isPlainObject(view) && view.viewState === 'live');
}

// --- keeper side (reference model) -------------------------------------------------------------------------------------

// initial: the mount_view rootLease { epoch: 1, ttlMs }. apply(frame) takes a decoded view_root_lease frame.
export function createRootLeaseKeeper({ grantId, initial, now = monotonicMs, limits: limitOverrides = {} }) {
    const limits = resolveViewLimits(limitOverrides);
    if (typeof grantId !== 'string' || !GRANT_ID.test(grantId)) throw new TypeError('The grant id is malformed');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!isPlainObject(initial) || keysOf(initial) !== 'epoch,ttlMs' || initial.epoch !== 1 || !isLeaseTtl(initial.ttlMs, limits)) {
        throw new TypeError('The initial lease must be { epoch: 1, ttlMs } with ttlMs within rootLeaseTtlMs');
    }
    let state = 'live';
    let epoch = 1;
    let validUntil = now() + initial.ttlMs;
    let reason = null;
    let signalledAt = null;

    const answer = (accepted, code) => Object.freeze({ accepted, code });
    // Expiry is evaluated before anything else, so a renew that arrives late cannot revive a lapsed lease.
    function refresh() {
        if (state === 'live' && now() >= validUntil) {
            state = 'revoking';
            reason = 'lease_expired';
        }
    }

    function apply(frame) {
        const verdict = validateRootLeaseFrame(frame, limits);
        if (!verdict.ok) return answer(false, verdict.code === 'bad_ttl' ? 'bad_ttl' : 'bad_frame');
        if (frame.grantId !== grantId) return answer(false, 'wrong_grant');
        refresh();
        if (state !== 'live') return answer(false, 'revoked');
        if (frame.verdict === 'revoke') {
            // A revoke only shortens the lease, so it is accepted at any epoch (review nit N4).
            state = 'revoking';
            reason = frame.reason;
            epoch = Math.max(epoch, frame.epoch);
            return answer(true, 'ok');
        }
        if (frame.epoch <= epoch) return answer(false, 'stale_epoch');
        epoch = frame.epoch;
        validUntil = now() + frame.ttlMs;
        return answer(true, 'ok');
    }

    // Actions for the keeper to perform, each emitted once: 'signal_revoke' (SIGTERM: the server treats the root as
    // protected and drains), then 'kill' (SIGKILL) rootRevokeGraceMs after the signal unless the server exited first.
    function poll() {
        refresh();
        if (state === 'revoking') {
            if (signalledAt === null) {
                signalledAt = now();
                return Object.freeze({ state, actions: Object.freeze(['signal_revoke']) });
            }
            if (now() >= signalledAt + limits.rootRevokeGraceMs) {
                state = 'killed';
                return Object.freeze({ state, actions: Object.freeze(['kill']) });
            }
        }
        return Object.freeze({ state, actions: Object.freeze([]) });
    }

    function serverExited() {
        if (state === 'live') reason = 'server_exited';
        state = 'killed';
    }

    return Object.freeze({
        apply,
        poll,
        serverExited,
        inspect: () => Object.freeze({ state, epoch, validUntil, reason })
    });
}

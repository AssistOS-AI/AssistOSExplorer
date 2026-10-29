import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRootLeaseFrame } from '../../server/views/mountFrames.mjs';
import {
    KEEPER_STATES, VIEW_STATES, confirmRevocation, createRootLeaseIssuer, createRootLeaseKeeper, isRetainedResourceReusable
} from '../../server/views/rootLease.mjs';
import { VIEW_LIMIT_DEFAULTS, resolveViewLimits } from '../../server/views/viewLimits.mjs';

const limits = resolveViewLimits();
const TTL = limits.rootLeaseTtlMs;
const GRACE = limits.rootRevokeGraceMs;
const VERIFY = limits.rootRevokeVerifyMs;

// A manual clock: tests move time explicitly.
function clock(start = 0) {
    let t = start;
    return { now: () => t, set: (value) => { t = value; }, advance: (ms) => { t += ms; } };
}

// A scripted verify(): each call takes the next answer (a value, an Error to throw, or a function of the call index).
function scripted(answers) {
    let calls = 0;
    const verify = async () => {
        const answer = answers[Math.min(calls, answers.length - 1)];
        calls += 1;
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer(calls) : answer;
    };
    return { verify, calls: () => calls };
}

const BOUND = Object.freeze({ state: 'bound' });
const UNPROVEN = Object.freeze({ state: 'unproven', code: 'verify_failed', errno: 'EACCES' });
const unbound = (code = 'root_unbound', index = 0) => Object.freeze({ state: 'unbound', code, index });
const wire = (frame, id = 7) => ({ id, ...frame });

async function issued(answers, extra = {}) {
    const time = extra.time ?? clock();
    const script = scripted([BOUND, ...answers]);
    const issuer = createRootLeaseIssuer({ grantId: 'project', verify: script.verify, now: time.now, ...extra.options });
    const first = await issuer.initial();
    assert.equal(first.ok, true);
    return { issuer, time, script, first };
}

const IDENTITY = Object.freeze({ pid: 4242, startTime: '123456789', pidNamespaceInode: '4026532490' });

// --- limits ----------------------------------------------------------------------------------------------------------

test('the lease limits are named, provisional defaults, and the renewal interval must be shorter than the lease', () => {
    assert.equal(VIEW_LIMIT_DEFAULTS.rootLeaseRenewMs, 1000);
    assert.equal(VIEW_LIMIT_DEFAULTS.rootLeaseTtlMs, 3000);
    assert.equal(VIEW_LIMIT_DEFAULTS.rootRevokeGraceMs, 2000);
    assert.equal(VIEW_LIMIT_DEFAULTS.rootRevokeVerifyMs, 2000);
    assert.throws(() => resolveViewLimits({ rootLeaseRenewMs: 3000 }), RangeError);
    assert.throws(() => resolveViewLimits({ rootLeaseTtlMs: 1000 }), RangeError);
    assert.equal(resolveViewLimits({ rootLeaseRenewMs: 2999 }).rootLeaseRenewMs, 2999);
    assert.throws(() => resolveViewLimits({ rootRevokeVerifyMs: 0 }), TypeError);
});

// --- issuer ----------------------------------------------------------------------------------------------------------

test('issuer: the mount lease is issued only on bound, with epoch 1 and the configured lifetime, and only once', async () => {
    for (const [answer, code] of [[unbound('ancestor_unbound'), 'ancestor_unbound'], [UNPROVEN, 'verify_failed'], [new Error('EIO'), 'verify_failed'], [undefined, 'verify_failed']]) {
        const issuer = createRootLeaseIssuer({ grantId: 'project', verify: scripted([answer]).verify, now: () => 0 });
        assert.deepEqual(await issuer.initial(), { ok: false, code });
        await assert.rejects(issuer.next(), /initial\(\) must succeed first/);
    }
    const { issuer, first } = await issued([]);
    assert.deepEqual(first, { ok: true, rootLease: { epoch: 1, ttlMs: TTL } });
    assert.deepEqual(await issuer.initial(), { ok: false, code: 'already_issued' });
    assert.equal(issuer.viewState(), 'live');
    assert.throws(() => createRootLeaseIssuer({ grantId: 'Bad/Id', verify: async () => BOUND }), TypeError);
});

test('issuer: bound renews with strictly increasing epochs, and every frame is a valid lease frame the keeper accepts', async () => {
    const time = clock();
    const { issuer } = await issued([BOUND, BOUND, BOUND], { time });
    const keeper = createRootLeaseKeeper({ grantId: 'project', initial: { epoch: 1, ttlMs: TTL }, now: time.now });
    for (const expectedEpoch of [2, 3, 4]) {
        time.advance(limits.rootLeaseRenewMs);
        const { frame, state } = await issuer.next();
        assert.equal(state, 'bound');
        assert.deepEqual(frame, { op: 'view_root_lease', grantId: 'project', epoch: expectedEpoch, verdict: 'renew', ttlMs: TTL });
        assert.deepEqual(validateRootLeaseFrame(wire(frame, expectedEpoch)), { ok: true });
        assert.deepEqual(keeper.apply(wire(frame, expectedEpoch)), { accepted: true, code: 'ok' });
        assert.deepEqual(keeper.poll(), { state: 'live', actions: [] });
    }
});

test('issuer: unproven is not sticky and withholds renewal; the next bound renews with the next epoch', async () => {
    const { issuer } = await issued([UNPROVEN, BOUND]);
    assert.deepEqual(await issuer.next(), { frame: null, state: 'unproven' });
    const { frame, state } = await issuer.next();
    assert.equal(state, 'bound');
    assert.equal(frame.verdict, 'renew');
    assert.equal(frame.epoch, 2);
});

test('issuer: an unbound result sends one revoke with its code, and never renews again (sticky)', async () => {
    const { issuer, script } = await issued([unbound('ancestor_unbound', 0), BOUND, BOUND]);
    const { frame, state } = await issuer.next();
    assert.equal(state, 'revoked');
    assert.deepEqual(frame, { op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'revoke', reason: 'ancestor_unbound' });
    assert.deepEqual(validateRootLeaseFrame(wire(frame)), { ok: true });
    const callsAfterRevoke = script.calls();
    for (let round = 0; round < 3; round += 1) assert.deepEqual(await issuer.next(), { frame: null, state: 'revoked' });
    assert.equal(script.calls(), callsAfterRevoke, 'no verification runs after the revocation');
    assert.equal(issuer.viewState(), 'revoked');
    assert.equal(issuer.revocation().reason, 'ancestor_unbound');
});

test('issuer: an overlapping call does not verify twice and reports busy', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const verify = async () => { calls += 1; if (calls === 1) return BOUND; await gate; return BOUND; };
    const issuer = createRootLeaseIssuer({ grantId: 'project', verify, now: () => 0 });
    await issuer.initial();
    const first = issuer.next();
    const second = await issuer.next();
    assert.deepEqual(second, { frame: null, state: 'busy' });
    release();
    assert.equal((await first).state, 'bound');
    assert.equal(calls, 2);
});

test('issuer: a thrown error, an EIO or EMFILE answer and a malformed result are unproven, never bound', async () => {
    const eio = Object.assign(new Error('EIO'), { code: 'EIO' });
    const answers = [eio, { state: 'unproven', code: 'verify_failed', errno: 'EMFILE' }, null, 'bound', { state: 'BOUND' }, { ok: true }];
    const { issuer } = await issued(answers);
    for (let index = 0; index < answers.length; index += 1) {
        assert.deepEqual(await issuer.next(), { frame: null, state: 'unproven' }, `answer ${index}`);
    }
});

test('issuer: an unbound result with a malformed code still revokes, under the generic code', async () => {
    const { issuer } = await issued([{ state: 'unbound', code: 'Not A Code' }]);
    const { frame } = await issuer.next();
    assert.equal(frame.reason, 'root_unbound');
});

test('issuer: past its own view of the lease it revokes with lease_expired, also when a slow verification ends bound', async () => {
    const stalled = await issued([UNPROVEN]);
    stalled.time.set(TTL - 1);
    assert.equal((await stalled.issuer.next()).state, 'unproven');
    stalled.time.set(TTL);
    const expired = await stalled.issuer.next();
    assert.deepEqual(expired.frame, { op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'revoke', reason: 'lease_expired' });

    const time = clock();
    const slow = await issued([() => { time.set(TTL + 5); return BOUND; }], { time });
    const late = await slow.issuer.next();
    assert.equal(late.frame.verdict, 'revoke', 'a verification that outlived the lease does not renew it');
    assert.equal(late.frame.reason, 'lease_expired');
});

// --- revocation confirmation (review finding 1) ----------------------------------------------------------------------

test('issuer: the revocation deadline is the revoke time plus lease, grace and verification margin', async () => {
    const time = clock(100);
    const { issuer } = await issued([unbound()], { time });
    assert.equal(issuer.revocationDeadline(), null, 'no deadline while the view is live');
    time.set(500);
    await issuer.next();
    assert.equal(issuer.revocationDeadline(), 500 + TTL + GRACE + VERIFY);
});

test('confirmRevocation: gone, alive and unproven, judged on the full identity tuple', async () => {
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => null }), { state: 'gone', action: 'none' });
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY }) }), { state: 'alive', action: 'kill_keeper_and_quarantine' });
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY, startTime: '999' }) }), { state: 'gone', action: 'none' },
        'a reused pid with another start time is another process');
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY, pidNamespaceInode: '1' }) }), { state: 'gone', action: 'none' });
    const unproven = { state: 'unproven', action: 'kill_keeper_and_quarantine' };
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => { throw new Error('EACCES'); } }), unproven);
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => undefined }), unproven);
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY, pid: 1 }) }), unproven);
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY, probe: async () => ({ pid: 4242 }) }), unproven);
    assert.deepEqual(await confirmRevocation({ identity: { ...IDENTITY, startTime: 5 }, probe: async () => null }), unproven);
    assert.deepEqual(await confirmRevocation({ identity: IDENTITY }), unproven);
    assert.deepEqual(await confirmRevocation(), unproven);
});

test('issuer: a file server still alive past the deadline gives kill_keeper_and_quarantine and a quarantined view; before it, wait', async () => {
    const time = clock();
    const { issuer } = await issued([unbound()], { time });
    let probes = 0;
    const alive = async () => { probes += 1; return { ...IDENTITY }; };
    assert.deepEqual(await issuer.settleRevocation({ identity: IDENTITY, probe: alive }), { due: false, action: 'none', viewState: 'live' });
    await issuer.next();
    const deadline = issuer.revocationDeadline();
    time.set(deadline - 1);
    assert.deepEqual(await issuer.settleRevocation({ identity: IDENTITY, probe: alive }), { due: false, action: 'wait', deadline, viewState: 'revoked' });
    assert.equal(probes, 0, 'nothing is probed before the deadline');
    time.set(deadline);
    const settled = await issuer.settleRevocation({ identity: IDENTITY, probe: alive });
    assert.deepEqual(settled, { due: true, state: 'alive', action: 'kill_keeper_and_quarantine', viewState: 'quarantined' });
    assert.equal(issuer.viewState(), 'quarantined');
    assert.equal(await issuer.settleRevocation({ identity: IDENTITY, probe: async () => null }), settled, 'quarantine is final');
});

test('issuer: a reused pid after the deadline counts as gone and the view stays revoked; a probe error quarantines', async () => {
    const time = clock();
    const reused = await issued([unbound()], { time });
    await reused.issuer.next();
    time.set(reused.issuer.revocationDeadline());
    const gone = await reused.issuer.settleRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY, startTime: '1' }) });
    assert.deepEqual(gone, { due: true, state: 'gone', action: 'none', viewState: 'revoked' });

    const failing = await issued([unbound()], { time: clock() });
    await failing.issuer.next();
    failing.time.set(failing.issuer.revocationDeadline());
    const unproven = await failing.issuer.settleRevocation({ identity: IDENTITY, probe: async () => { throw new Error('EIO'); } });
    assert.deepEqual(unproven, { due: true, state: 'unproven', action: 'kill_keeper_and_quarantine', viewState: 'quarantined' });
});

test('issuer: with verification answering promptly (unproven), expiry by the supervisor clock leads to the same check without any keeper reply', async () => {
    const time = clock();
    const { issuer } = await issued([UNPROVEN], { time });
    time.set(TTL);
    assert.equal((await issuer.next()).frame.reason, 'lease_expired');
    time.set(issuer.revocationDeadline());
    const settled = await issuer.settleRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY }) });
    assert.equal(settled.action, 'kill_keeper_and_quarantine');
});

// --- retained GUI reuse (review finding 2) -----------------------------------------------------------------------------

test('reuse predicate: a retained resource with any revoked or quarantined view is not reusable', async () => {
    assert.deepEqual(VIEW_STATES, ['live', 'revoked', 'quarantined']);
    const live = { grantId: 'project', viewState: 'live' };
    assert.equal(isRetainedResourceReusable({ views: [live, { grantId: 'skills', viewState: 'live' }] }), true);
    assert.equal(isRetainedResourceReusable({ views: [live, { grantId: 'skills', viewState: 'revoked' }] }), false);
    assert.equal(isRetainedResourceReusable({ views: [{ grantId: 'project', viewState: 'quarantined' }] }), false);
    for (const malformed of [null, {}, { views: [] }, { views: 'live' }, { views: [null] }, { views: [{ grantId: 'project' }] }]) {
        assert.equal(isRetainedResourceReusable(malformed), false, JSON.stringify(malformed));
    }
    // The state comes from the issuer of each view: after a lease_expired revocation (binding unchanged), the record says revoked.
    const time = clock();
    const { issuer } = await issued([UNPROVEN], { time });
    assert.equal(isRetainedResourceReusable({ views: [{ grantId: 'project', viewState: issuer.viewState() }] }), true);
    time.set(TTL);
    await issuer.next();
    assert.equal(isRetainedResourceReusable({ views: [{ grantId: 'project', viewState: issuer.viewState() }] }), false);
});

// --- keeper (reference model) ------------------------------------------------------------------------------------------

function keeperAt(time, extra = {}) {
    return createRootLeaseKeeper({ grantId: 'project', initial: { epoch: 1, ttlMs: TTL }, now: time.now, ...extra });
}
const renew = (epoch, ttlMs = TTL, id = epoch) => ({ id, op: 'view_root_lease', grantId: 'project', epoch, verdict: 'renew', ttlMs });
const revokeFrame = (epoch, reason = 'root_unbound') => ({ id: epoch, op: 'view_root_lease', grantId: 'project', epoch, verdict: 'revoke', reason });

test('keeper: without renewal the lease is fail-closed: signal_revoke at expiry, kill after the grace period, each exactly once', () => {
    assert.deepEqual(KEEPER_STATES, ['live', 'revoking', 'killed']);
    const time = clock();
    const keeper = keeperAt(time);
    time.set(TTL - 1);
    assert.deepEqual(keeper.poll(), { state: 'live', actions: [] });
    time.set(TTL);
    assert.deepEqual(keeper.poll(), { state: 'revoking', actions: ['signal_revoke'] });
    assert.equal(keeper.inspect().reason, 'lease_expired');
    assert.deepEqual(keeper.poll(), { state: 'revoking', actions: [] });
    time.set(TTL + GRACE - 1);
    assert.deepEqual(keeper.poll(), { state: 'revoking', actions: [] });
    time.set(TTL + GRACE);
    assert.deepEqual(keeper.poll(), { state: 'killed', actions: ['kill'] });
    for (let round = 0; round < 3; round += 1) assert.deepEqual(keeper.poll(), { state: 'killed', actions: [] });
});

test('keeper: a revoke is sticky; a renew afterwards is refused as revoked', () => {
    const time = clock();
    const keeper = keeperAt(time);
    assert.deepEqual(keeper.apply(revokeFrame(2)), { accepted: true, code: 'ok' });
    assert.deepEqual(keeper.apply(renew(3)), { accepted: false, code: 'revoked' });
    assert.deepEqual(keeper.apply(revokeFrame(4)), { accepted: false, code: 'revoked' });
    assert.deepEqual(keeper.poll().actions, ['signal_revoke']);
});

test('keeper: replay and over-long leases are refused and leave the lease unchanged', () => {
    const time = clock();
    const keeper = keeperAt(time);
    time.set(500);
    assert.deepEqual(keeper.apply(renew(3)), { accepted: true, code: 'ok' });
    time.set(1000);
    assert.deepEqual(keeper.apply(renew(4)), { accepted: true, code: 'ok' });
    assert.equal(keeper.inspect().validUntil, 1000 + TTL);
    time.set(2000);
    assert.deepEqual(keeper.apply(renew(4)), { accepted: false, code: 'stale_epoch' }, 'the same frame twice');
    assert.deepEqual(keeper.apply(renew(3)), { accepted: false, code: 'stale_epoch' }, 'an older epoch');
    assert.deepEqual(keeper.apply(renew(1)), { accepted: false, code: 'bad_frame' }, 'epoch 1 belongs to mount_view and is no lease frame');
    assert.deepEqual(keeper.apply(renew(5, TTL + 1)), { accepted: false, code: 'bad_ttl' });
    assert.deepEqual(keeper.apply(renew(5, 0)), { accepted: false, code: 'bad_ttl' });
    assert.equal(keeper.inspect().validUntil, 1000 + TTL, 'nothing above moved the lease');
    assert.equal(keeper.inspect().epoch, 4);
    assert.deepEqual(keeper.apply(renew(5, TTL)), { accepted: true, code: 'ok' }, 'the maximum lifetime itself is accepted');
    assert.equal(keeper.inspect().validUntil, 2000 + TTL);
});

test('keeper: a renew that arrives after expiry cannot revive the lease', () => {
    const time = clock();
    const keeper = keeperAt(time);
    time.set(TTL);
    assert.deepEqual(keeper.apply(renew(2)), { accepted: false, code: 'revoked' });
    assert.deepEqual(keeper.poll(), { state: 'revoking', actions: ['signal_revoke'] });
});

test('keeper: a frame for another grant and malformed frames are refused without effect', () => {
    const time = clock();
    const keeper = keeperAt(time);
    assert.deepEqual(keeper.apply({ ...renew(2), grantId: 'sibling' }), { accepted: false, code: 'wrong_grant' });
    for (const frame of [
        { ...renew(2), extra: 1 }, { ...revokeFrame(2), reason: 5 }, { ...revokeFrame(2), reason: 'Bad Reason' },
        renew(Number.MAX_SAFE_INTEGER + 1), renew(1.5), { ...renew(2), ttlMs: 2.5 }, { ...renew(2), ttlMs: '3000' },
        { ...renew(2), verdict: 'extend' }, { ...renew(2), op: 'mount_view' }, { ...renew(2), id: 0 },
        { op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'renew', ttlMs: TTL }, { ...renew(2), path: '/ws/proj' },
        { ...revokeFrame(2), ttlMs: TTL }, null, [], 'renew'
    ]) {
        assert.deepEqual(keeper.apply(frame), { accepted: false, code: 'bad_frame' }, JSON.stringify(frame));
    }
    assert.deepEqual(keeper.inspect(), { state: 'live', epoch: 1, validUntil: TTL, reason: null });
});

test('keeper: a server that exits during the drain is not killed; a revoke is accepted at any epoch (it only shortens)', () => {
    const time = clock();
    const keeper = keeperAt(time);
    keeper.apply(renew(5));
    assert.deepEqual(keeper.apply(revokeFrame(3)), { accepted: true, code: 'ok' }, 'review nit N4');
    assert.deepEqual(keeper.poll().actions, ['signal_revoke']);
    keeper.serverExited();
    time.set(GRACE * 10);
    assert.deepEqual(keeper.poll(), { state: 'killed', actions: [] });
});

test('keeper: the initial lease must be epoch 1 within the maximum lifetime', () => {
    const time = clock();
    for (const initial of [{ epoch: 2, ttlMs: TTL }, { epoch: 1, ttlMs: TTL + 1 }, { epoch: 1, ttlMs: 0 }, { epoch: 1 }, { epoch: 1, ttlMs: TTL, extra: 1 }, null]) {
        assert.throws(() => createRootLeaseKeeper({ grantId: 'project', initial, now: time.now }), TypeError, JSON.stringify(initial));
    }
});

test('negative control: a keeper that ignores epochs lets a replayed renew extend the lease past its expiry; the real keeper does not', () => {
    const time = clock();
    // The naive design: any renew restarts the lifetime.
    const naive = (() => {
        let validUntil = time.now() + TTL;
        return { apply: (frame) => { if (frame.verdict === 'renew') validUntil = time.now() + frame.ttlMs; }, live: () => time.now() < validUntil };
    })();
    const keeper = keeperAt(time);
    const captured = renew(2);
    time.set(1000);
    naive.apply(captured);
    keeper.apply(captured);
    // The supervisor stops renewing (unproven); the captured frame is replayed shortly before expiry.
    time.set(1000 + TTL - 100);
    naive.apply(captured);
    assert.equal(keeper.apply(captured).code, 'stale_epoch');
    time.set(1000 + TTL + 100);
    assert.equal(naive.live(), true, 'the naive keeper still serves after the lease should have expired');
    assert.deepEqual(keeper.poll().actions, ['signal_revoke'], 'the real keeper revokes');
});

test('data flow: an unbound verification reaches the keeper as a revoke, which signals and then kills', async () => {
    const time = clock();
    const { issuer, first } = await issued([BOUND, unbound('root_unbound', 1)], { time });
    const keeper = createRootLeaseKeeper({ grantId: 'project', initial: first.rootLease, now: time.now });
    time.advance(limits.rootLeaseRenewMs);
    assert.equal(keeper.apply(wire((await issuer.next()).frame, 1)).accepted, true);
    time.advance(limits.rootLeaseRenewMs);
    const revoked = await issuer.next();
    assert.equal(keeper.apply(wire(revoked.frame, 2)).accepted, true);
    assert.deepEqual(keeper.poll(), { state: 'revoking', actions: ['signal_revoke'] });
    time.advance(GRACE);
    assert.deepEqual(keeper.poll(), { state: 'killed', actions: ['kill'] });
    assert.ok(issuer.revocationDeadline() >= time.now(), 'the supervisor checks only after the keeper had its full grace period');
});

// --- review r4 F1: a verification that never settles must not hide the supervisor's own expiry ----------------------------

test('F1: past the lease, a tick revokes with lease_expired although a verification is still in flight, and its late result changes nothing', async () => {
    const time = clock();
    let settleStalled;
    let calls = 0;
    const verify = () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(BOUND);
        return new Promise((resolve) => { settleStalled = resolve; });
    };
    const issuer = createRootLeaseIssuer({ grantId: 'project', verify, now: time.now });
    assert.equal((await issuer.initial()).ok, true);
    time.set(limits.rootLeaseRenewMs);
    const stalled = issuer.next();
    time.set(TTL - 1);
    assert.deepEqual(await issuer.next(), { frame: null, state: 'busy' }, 'before expiry the overlapping tick is busy');
    assert.equal(issuer.revocationDeadline(), null);
    time.set(TTL);
    const expired = await issuer.next();
    assert.deepEqual(expired, { frame: { op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'revoke', reason: 'lease_expired' }, state: 'revoked' });
    const deadline = issuer.revocationDeadline();
    assert.equal(deadline, TTL + TTL + GRACE + VERIFY);
    assert.equal(issuer.viewState(), 'revoked');
    assert.equal(isRetainedResourceReusable({ views: [{ grantId: 'project', viewState: issuer.viewState() }] }), false);
    assert.deepEqual(await issuer.next(), { frame: null, state: 'revoked' });
    time.set(deadline - 1);
    assert.equal((await issuer.settleRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY }) })).action, 'wait');
    // The stalled verification finally answers, even unbound: no second revoke, no epoch bump, no deadline move.
    time.set(deadline - 1);
    settleStalled(unbound('root_unbound', 0));
    assert.deepEqual(await stalled, { frame: null, state: 'revoked' });
    assert.equal(issuer.epoch(), 2);
    assert.equal(issuer.revocationDeadline(), deadline);
    assert.equal(issuer.revocation().reason, 'lease_expired');
    time.set(deadline);
    const settled = await issuer.settleRevocation({ identity: IDENTITY, probe: async () => ({ ...IDENTITY }) });
    assert.deepEqual(settled, { due: true, state: 'alive', action: 'kill_keeper_and_quarantine', viewState: 'quarantined' });
    assert.equal(calls, 2, 'the overlapping ticks never started a second verification');
});

test('F1: a stalled verification that settles bound after the expiry revoke sends no renew', async () => {
    const time = clock();
    let settleStalled;
    let calls = 0;
    const verify = () => { calls += 1; return calls === 1 ? Promise.resolve(BOUND) : new Promise((resolve) => { settleStalled = resolve; }); };
    const issuer = createRootLeaseIssuer({ grantId: 'project', verify, now: time.now });
    await issuer.initial();
    const stalled = issuer.next();
    time.set(TTL);
    assert.equal((await issuer.next()).frame.reason, 'lease_expired');
    settleStalled(BOUND);
    assert.deepEqual(await stalled, { frame: null, state: 'revoked' });
    assert.equal(issuer.epoch(), 2);
});

// --- review r4 F2: the keeper's lease replies feed back into the issuer ----------------------------------------------------

// The wire reply of the keeper model to one frame: its state when accepted, a refusal otherwise.
function keeperReply(keeper, request) {
    const answer = keeper.apply(request);
    return answer.accepted
        ? { id: request.id, ok: true, value: { state: keeper.inspect().state } }
        : { id: request.id, ok: false, kind: 'refused', error: answer.code };
}

test('F2 (review probe 2): a renew that reaches the keeper after its expiry is refused, the issuer stops renewing and the view is not live', async () => {
    const time = clock();
    const { issuer, first } = await issued([UNPROVEN, UNPROVEN, BOUND, BOUND], { time });
    time.set(20);
    const keeper = createRootLeaseKeeper({ grantId: 'project', initial: first.rootLease, now: time.now });
    time.set(1000);
    assert.equal((await issuer.next()).state, 'unproven');
    time.set(2000);
    assert.equal((await issuer.next()).state, 'unproven');
    time.set(2990);
    const sent = await issuer.next();
    assert.equal(sent.frame.verdict, 'renew');
    assert.equal(sent.frame.epoch, 2);
    time.set(3030);
    const request = wire(sent.frame, 11);
    const reply = keeperReply(keeper, request);
    assert.deepEqual(reply, { id: 11, ok: false, kind: 'refused', error: 'revoked' }, 'the keeper had expired at 3020');
    assert.deepEqual(keeper.poll().actions, ['signal_revoke']);
    assert.deepEqual(issuer.observeKeeperReply(reply, request), { accepted: true, code: 'keeper_revoked', viewState: 'revoked' });
    assert.deepEqual(await issuer.next(), { frame: null, state: 'revoked' }, 'no renew at epoch 3');
    assert.equal(issuer.epoch(), 2);
    assert.notEqual(issuer.viewState(), 'live');
    assert.equal(issuer.revocationDeadline(), 3030 + TTL + GRACE + VERIFY);
    assert.equal(isRetainedResourceReusable({ views: [{ grantId: 'project', viewState: issuer.viewState() }] }), false);
});

test('F2: a revoking or killed keeper state revokes the issuer once; live changes nothing; a malformed or foreign reply is ignored', async () => {
    for (const state of ['revoking', 'killed']) {
        const time = clock();
        const { issuer } = await issued([BOUND], { time });
        const request = wire({ op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'renew', ttlMs: TTL }, 3);
        assert.deepEqual(issuer.observeKeeperReply({ id: 3, ok: true, value: { state: 'live' } }, request), { accepted: true, code: 'live', viewState: 'live' });
        assert.equal(issuer.revocationDeadline(), null);
        for (const [reply, req] of [
            [{ id: 4, ok: true, value: { state } }, request], [{ id: 3, ok: true, value: { state: 'gone' } }, request],
            [{ id: 3, ok: true, value: { state } }, { ...request, grantId: 'sibling' }], [{ id: 3, ok: true, value: { state } }, null]
        ]) {
            assert.equal(issuer.observeKeeperReply(reply, req).code, 'bad_reply', JSON.stringify(reply));
        }
        assert.equal(issuer.viewState(), 'live', 'nothing above changed the state');
        time.set(500);
        assert.equal(issuer.observeKeeperReply({ id: 3, ok: true, value: { state } }, request).viewState, 'revoked');
        assert.equal(issuer.revocation().reason, 'keeper_revoked');
        const deadline = issuer.revocationDeadline();
        assert.equal(deadline, 500 + TTL + GRACE + VERIFY);
        time.set(900);
        issuer.observeKeeperReply({ id: 3, ok: true, value: { state: 'killed' } }, request);
        assert.equal(issuer.revocationDeadline(), deadline, 'the deadline is armed once');
        assert.deepEqual(await issuer.next(), { frame: null, state: 'revoked' });
    }
});

test('F2: any other refusal of a lease frame also stops renewal (keeper_refused), and a later refusal does not move the deadline', async () => {
    const time = clock();
    const { issuer } = await issued([BOUND], { time });
    const request = wire({ op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'renew', ttlMs: TTL }, 3);
    time.set(100);
    assert.equal(issuer.observeKeeperReply({ id: 3, ok: false, kind: 'refused', error: 'stale_epoch' }, request).code, 'keeper_refused');
    assert.equal(issuer.revocationDeadline(), 100 + TTL + GRACE + VERIFY);
    const deadline = issuer.revocationDeadline();
    assert.notEqual(deadline, null);
    time.set(700);
    issuer.observeKeeperReply({ id: 3, ok: false, kind: 'refused', error: 'revoked' }, request);
    assert.equal(issuer.revocationDeadline(), deadline);
    assert.equal(issuer.revocation().reason, 'keeper_refused');
});

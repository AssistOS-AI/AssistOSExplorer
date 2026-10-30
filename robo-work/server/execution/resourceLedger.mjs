// The supervisor-side per-execution resource ledger orchestration over the S1 worker-state library (plan section 5.5).
//
//   publish()       the publication barrier, three phases, for one resource:
//                     Reserve  record it durably (S1 reserveResource) with its deterministic locator, and for a
//                              process-bearing resource the marker (the reservation ID, carried in argv);
//                     Create   the sandbox supervisor creates it GATED: a process waits at its gate pipe for an explicit commit byte;
//                     Commit   record the identity tuple once (S1 commitResource), and only then release the gate or
//                              publish the handle. No workload executes before its commit.
//                   The sandbox supervisor itself is published first, and nothing else is created until its identity is committed
//                   and its gate released (R3-1): its uncommitted children can then be found as its descendants.
//   endExecution()  the end path, steps 1 to 8 of section 5.5, in the fixed order, each step verified through the
//                   supervisor's own view. A resource whose release is not proven within the release deadline is
//                   quarantined. The deadline runs from the start of the step, so a step waits at most one deadline however
//                   many of its resources cannot be proven; that is conservative (a second slow tree may be quarantined that
//                   would have gone moments later) and fails closed. The terminal result is published by S1 when the last blocker is settled, never earlier.
//
// Sandbox supervisor interface (a model in the tests; production: the Node sandbox supervisor that launches the workload under /usr/bin/bwrap):
//   sandbox.create({ kind, resourceId, marker, locator, spec }) -> { identity, gate, handle? }   gate: { commit(), abort() } or null
//                   `spec` says what to create (a workload request, a pty size, view parameters). It goes to the sandbox supervisor
//                   only: it is never given to reserveResource and never persisted. sandbox.alive() -> boolean
//   sandbox.abortUncommitted(resourceIds) -> a REQUEST to abandon creations that were never committed. The answer proves
//                   nothing: an uncommitted process, namespace, mount or pty is settled only once the sandbox supervisor's own process
//                   is verified absent (after step 6), or it is quarantined with a sandbox supervisor that will not go.
//   sandbox.endProcessTrees() | endEndpoint() | releaseEgress() | releaseViews() | removeRuntime() | exit()
// releaseEgress closes the sandbox supervisor's network-namespace descriptor and releaseViews its mount-namespace descriptor, after
// the endpoint (the only other member of the network namespace) has ended, so that steps 4 and 5 can be verified (review
// (3) R3-5). The release deadline, poll interval and fault hooks are constructor parameters; the deadline is PROVISIONAL (G5).

import { PROCESS_BEARING_KINDS, deriveLocator, newLocatorId as randomLocatorId } from './resourceLocators.mjs';
import { QUARANTINED, RELEASED, walkOrder } from './recoveryWalk.mjs';

// The release order of section 5.5. Step 1 (closing admission) is beginAttemptEnd; step 8 is S1's publication.
export const RELEASE_STEPS = Object.freeze([
    { step: 2, kinds: ['process-tree', 'pty'], action: 'endProcessTrees' },
    { step: 3, kinds: ['endpoint'], action: 'endEndpoint' },
    { step: 4, kinds: ['veth', 'nft-table', 'netns'], action: 'releaseEgress' },
    { step: 5, kinds: ['mount'], action: 'releaseViews' },
    { step: 6, kinds: ['runtime-dir', 'cgroup', 'keeper'], action: 'removeRuntime' },
    { step: 7, kinds: ['gui-view', 'gui-container'], action: null }
]);
const RETAINABLE = new Set(['gui-view', 'gui-container']);
// Kinds whose uncommitted reservation can be proven absent only once the sandbox supervisor is proven absent.
const DEFERRED_KINDS = new Set(['endpoint', 'process-tree', 'netns', 'mount', 'pty']);

export class LedgerError extends Error {
    constructor(code, message) { super(message); this.name = 'LedgerError'; this.code = code; }
}

// An injected crash is not an error to clean up after: the process that would clean up is the one that is gone.
const isInjectedCrash = (error) => error?.injectedCrash === true;

export function createExecutionLedger({
    state, context, robotId, executionId, attemptId, referenceId, layout, sandbox, walker, clock,
    faults = {}, newLocatorId = randomLocatorId
}) {
    let sandboxReleased = false;
    let sandboxResourceId = null;
    let closed = false;
    const releaseLog = [];

    const unsettled = () => state.listUnsettledResources().filter((entry) => entry.attemptId === attemptId && entry.executionId === executionId);
    const hook = async (name, info) => { if (typeof faults[name] === 'function') await faults[name](info); };

    // A creation or commit that failed. The sandbox supervisor is asked to abandon it, which is a request and proves nothing. The
    // blocker is settled `released` only if its absence can be proven right now (a locator-named object that is gone, or
    // a process whose marker is gone with the sandbox supervisor absent too). Otherwise it stays unsettled, which keeps the attempt
    // waiting for the end path, where it is proven after the sandbox supervisor has exited or is quarantined with it. The model's
    // truth check sees this release through the same afterRelease hook as every other.
    async function settleAfterFailure(resourceId) {
        try { await sandbox.abortUncommitted?.([resourceId]); } catch { /* a request only */ }
        const blocker = state.listUnsettledResources().find((entry) => entry.resourceId === resourceId);
        if (!blocker) return;
        const outcome = await walker.attempt(blocker);
        if (outcome !== RELEASED) return;
        state.settleResource({ resourceId, generationId: blocker.generationId, outcome });
        await hook('afterRelease', { kind: blocker.kind, resourceId, outcome });
    }

    // The publication barrier for one resource. Resolves to the committed record and its published handle.
    async function publish({ kind, extra, spec = null }) {
        if (closed) throw new LedgerError('execution_ending', 'Admission for this execution has closed');
        if (kind !== 'keeper' && !sandboxReleased) throw new LedgerError('keeper_not_committed', 'The sandbox supervisor must be committed and released before anything else is created');
        if (kind === 'keeper' && sandboxReleased) throw new LedgerError('keeper_exists', 'An execution has one sandbox supervisor');
        const processBearing = PROCESS_BEARING_KINDS.includes(kind);
        // Every dependent records the sandbox supervisor's reservation ID, so that the sandbox supervisor's own record can be found at any later
        // time (also after a crash during recovery) and its presence judged whatever its release state.
        const locator = { ...deriveLocator(kind, newLocatorId(), layout, extra), ...(kind === 'keeper' ? {} : { keeper: sandboxResourceId }) };
        // Reserve.
        const { resourceId, locator: recorded } = state.reserveResource({
            kind, locator, robotId, executionId, attemptId, processBearing
        });
        if (kind === 'keeper') sandboxResourceId = resourceId;
        const info = { kind, resourceId };
        try {
            await hook('afterReserve', info);
            // Create, gated.
            const created = await sandbox.create({ kind, resourceId, marker: processBearing ? recorded.marker : null, locator: recorded, spec });
            await hook('afterCreate', { ...info, identity: created.identity });
            // Commit: the identity is written once, and only then is the gate released.
            try {
                state.commitResource({ resourceId, identity: created.identity });
            } catch (error) {
                await created.gate?.abort();
                throw error;
            }
            await hook('afterCommit', info);
            if (created.gate) {
                const released = await created.gate.commit();
                if (released !== true) throw new LedgerError('gate_release_failed', 'The gate could not be released');
            }
            if (kind === 'keeper') sandboxReleased = true;
            await hook('afterGateRelease', info);
            return { resourceId, kind, locator: recorded, identity: created.identity, handle: created.handle ?? null };
        } catch (error) {
            if (isInjectedCrash(error)) throw error;
            // A failed creation never leaves a half-published resource: close the gate (end-of-file aborts the helper)
            // and prove or quarantine it now.
            await settleAfterFailure(resourceId);
            throw error;
        }
    }

    // `resume: true` continues an end path that was interrupted after step 1 (the attempt is already `stopping`).
    //
    // `retainGui` is the caller's retention decision: GUI resources are transferred to the robot's retained record
    // instead of being released, after take-control or after completion (section 5.5: "a retained GUI container after
    // take-control or completion"). Without it they are released and removed at step 7. Worker-restart recovery never
    // retains: A13 requires that GUI resources actually stop after a restart, which sits in tension with section 5.5's
    // "released when the retained resource is closed or replaced"; this implementation follows A13 for recovery.
    async function endExecution({ classification, outputText = '', data = null, expectedState = 'running', retainGui = false, resume = false }) {
        // Step 1: admission closes and the internal classification is recorded; the reference shows `stopping`.
        closed = true;
        if (!resume) state.beginAttemptEnd(context, { executionId, attemptId, expectedState, outcome: { classification, outputText, data } });
        const sandboxHealthy = typeof sandbox?.alive === 'function' && sandbox.alive();
        // A healthy sandbox is first asked to abandon every creation that was never committed. That is a request: its
        // answer is not believed. An uncommitted process, namespace or mount is proven absent only after the sandbox supervisor's
        // own process has been verified absent, so those blockers are settled after step 6 (or quarantined with a sandbox supervisor
        // that will not go).
        const uncommitted = unsettled().filter((entry) => entry.identity === null).map((entry) => entry.resourceId);
        if (sandboxHealthy && uncommitted.length > 0) {
            try { await sandbox.abortUncommitted(uncommitted); } catch { /* proven or forced below */ }
        }
        const isDeferred = (entry) => entry.identity === null && DEFERRED_KINDS.has(entry.kind);
        const handled = new Set();
        for (const { step, kinds, action } of RELEASE_STEPS) {
            if (action && sandboxHealthy) {
                // The sandbox supervisor's own part of the step. A sandbox supervisor that fails to do it is not trusted; the walk below forces.
                try { await sandbox[action](); } catch { /* verified and forced below */ }
            }
            // Within a step the order is the one named for it, so the sandbox supervisor is last in step 6.
            const since = clock.now();
            const inStep = unsettled().filter((entry) => kinds.includes(entry.kind) && !isDeferred(entry)).sort((x, y) => kinds.indexOf(x.kind) - kinds.indexOf(y.kind));
            for (const blocker of inStep) {
                handled.add(blocker.resourceId);
                await settleBlocker(blocker, step, { retainGui, since });
            }
        }
        // After step 6: the uncommitted process, namespace and mount reservations, now that the sandbox supervisor is verified gone or
        // quarantined, and any kind that no step names. Nothing recorded for the execution is left unsettled.
        for (const blocker of walkOrder(unsettled())) {
            if (!handled.has(blocker.resourceId)) await settleBlocker(blocker, 6, { retainGui, since: clock.now() });
        }
        const view = referenceId ? state.getReference(context, { referenceId }) : null;
        return { releaseLog: [...releaseLog], reference: view };
    }

    async function settleBlocker(blocker, step, { retainGui, since }) {
        // Step 7: a retained GUI resource is transferred to the robot's retained record, not released.
        if (retainGui && RETAINABLE.has(blocker.kind)) {
            state.retainResource({ resourceId: blocker.resourceId });
            releaseLog.push({ step: 7, kind: blocker.kind, resourceId: blocker.resourceId, outcome: 'retained' });
            await hook('afterRelease', { kind: blocker.kind, resourceId: blocker.resourceId, outcome: 'retained' });
            return;
        }
        const outcome = await walker.walk(blocker, { since });
        state.settleResource({ resourceId: blocker.resourceId, generationId: blocker.generationId, outcome });
        releaseLog.push({ step, kind: blocker.kind, resourceId: blocker.resourceId, outcome });
        await hook('afterRelease', { kind: blocker.kind, resourceId: blocker.resourceId, outcome });
    }

    return {
        startKeeper: () => publish({ kind: 'keeper' }),
        publish,
        endExecution,
        unsettled,
        get closed() { return closed; },
        get releaseLog() { return [...releaseLog]; }
    };
}

export { QUARANTINED, RELEASED };

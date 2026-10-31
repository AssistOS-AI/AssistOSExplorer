import { WorkerStateError, createVerifiedServiceContext } from '../stateProtocol.mjs';

// The trusted preparation driver (plan section 6, decision M-6/M-10). S1 records provision, configure and delete
// as intents with a `pending` completion; this driver performs the work and completes them:
//
//   provision/configure  create (or refresh) the robot's HOME, sessions and managed ALA configuration in the worker store,
//                        then completePreparation('succeeded'), which attests readiness through the runtime adapter;
//                        a failure completes 'failed' with effects 'unknown' (something may exist) or 'none'.
//   delete               remove the robot's directory, then completeDelete (it stays `deleting` while a blocker remains).
//   re-attestation       after a restart the generation rollover cleared every attestation: each ready robot is
//                        re-prepared (idempotent) and attested again, otherwise every admission would be refused.
//
// One `tick()` handles all pending work and never throws; `start()` runs it on an interval.
export function createLifecycleDriver({ store, robots, workspaceId, intervalMs = 250, retryMs = 5000, maxRetryMs = 300000, now = Date.now, log = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
    for (const method of ['listPendingCompletions', 'listUnattestedRobots', 'completePreparation', 'completeDelete', 'attestReadiness']) {
        if (!store || typeof store[method] !== 'function') throw new TypeError(`The store lacks ${method}`);
    }
    let timer = null;
    let running = false;
    // A robot whose re-attestation failed (for example a quarantined resource) is retried after retryMs, then after twice that, and so on up to
    // maxRetryMs: a robot that stays nonready (`resource_quarantined`) must not be attested and logged every few seconds for as long as it stays so.
    // The failure is LOGGED once per state change (a different error, or the recovery), not once per attempt.
    const attestedAt = new Map(); // robotId -> { at, delay, error }
    const contextFor = (scope, ownerId) => createVerifiedServiceContext({
        workspaceId, scope, ownerId, robotOwnerId: ownerId, operations: ['adapter_complete', 'attest', 'read']
    });
    const describe = (error) => (error instanceof WorkerStateError ? error.code : (error?.code ?? error?.name ?? 'error'));

    async function handle(entry) {
        const context = contextFor(entry.scope, entry.ownerId);
        if (entry.opType === 'delete') {
            try {
                robots.remove(entry.robotId);
            } catch (error) {
                log('delete_remove_failed', { robotId: entry.robotId, error: describe(error) });
                return;
            }
            try { store.completeDelete(context, { operationId: entry.operationId }); } catch (error) {
                // robot_busy and resource_quarantined leave the robot `deleting`; the next tick retries.
                log('delete_incomplete', { robotId: entry.robotId, error: describe(error) });
            }
            return;
        }
        let prepared = false;
        try {
            robots.prepare(entry.robotId, entry.candidate);
            prepared = true;
        } catch (error) {
            log('prepare_failed', { robotId: entry.robotId, error: describe(error) });
        }
        try {
            if (prepared) store.completePreparation(context, { operationId: entry.operationId, outcome: 'succeeded' });
            else store.completePreparation(context, { operationId: entry.operationId, outcome: 'failed', effects: 'unknown' });
        } catch (error) {
            log('complete_failed', { robotId: entry.robotId, error: describe(error) });
        }
    }

    async function reattest(entry) {
        let previous = attestedAt.get(entry.robotId);
        // The robot row changed since the last attempt (an operator cleared its quarantine): the old backoff no longer describes it.
        if (previous !== undefined && entry.updatedAt !== undefined && entry.updatedAt !== previous.updatedAt) { attestedAt.delete(entry.robotId); previous = undefined; }
        if (previous !== undefined && now() - previous.at < previous.delay) return;
        const at = now();
        try {
            robots.prepare(entry.robotId, entry.configuration);
            store.attestReadiness(contextFor('worker:reattest', entry.ownerId), { robotId: entry.robotId });
            if (previous !== undefined && previous.error !== null) log('attest_recovered', { robotId: entry.robotId, after: previous.error, attempts: previous.attempts });
            attestedAt.set(entry.robotId, { at, delay: retryMs, error: null, attempts: 0, updatedAt: entry.updatedAt });
        } catch (error) {
            const code = describe(error);
            const failing = previous !== undefined && previous.error !== null;
            if (!failing || previous.error !== code) log('attest_failed', { robotId: entry.robotId, error: code, retryInMs: failing ? Math.min(previous.delay * 2, maxRetryMs) : retryMs });
            attestedAt.set(entry.robotId, {
                at, updatedAt: entry.updatedAt, error: code, attempts: (failing ? previous.attempts : 0) + 1,
                delay: failing ? Math.min(Math.max(previous.delay * 2, retryMs), maxRetryMs) : retryMs
            });
        }
    }

    async function tick() {
        if (running) return;
        running = true;
        try {
            for (const entry of store.listPendingCompletions()) await handle(entry);
            for (const entry of store.listUnattestedRobots()) await reattest(entry);
        } catch (error) {
            log('tick_failed', { error: describe(error) });
        } finally {
            running = false;
        }
    }

    return Object.freeze({
        tick,
        start() { if (timer === null) { timer = setTimer(() => { tick(); }, intervalMs); timer.unref?.(); } tick(); },
        stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
    });
}

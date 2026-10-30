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
export function createLifecycleDriver({ store, robots, workspaceId, intervalMs = 250, retryMs = 5000, now = Date.now, log = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
    for (const method of ['listPendingCompletions', 'listUnattestedRobots', 'completePreparation', 'completeDelete', 'attestReadiness']) {
        if (!store || typeof store[method] !== 'function') throw new TypeError(`The store lacks ${method}`);
    }
    let timer = null;
    let running = false;
    // A robot whose re-attestation failed (for example a quarantined resource) is retried after retryMs, not every tick.
    const attestedAt = new Map();

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
        const last = attestedAt.get(entry.robotId);
        if (last !== undefined && now() - last < retryMs) return;
        attestedAt.set(entry.robotId, now());
        try {
            robots.prepare(entry.robotId, entry.configuration);
            store.attestReadiness(contextFor('worker:reattest', entry.ownerId), { robotId: entry.robotId });
        } catch (error) {
            log('attest_failed', { robotId: entry.robotId, error: describe(error) });
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

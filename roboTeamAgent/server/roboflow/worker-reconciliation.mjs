import { phaseOriginId } from '../worker-coordinator/flow-origins.mjs';
import { plainStopMessage } from '../worker-coordinator/stop-reasons.mjs';

// What a worker execution says about one RoboFlow phase attempt after a RoboTeam restart (plan
// section 9: query the worker before changing a phase). The decision is read-only:
//
//   never_admitted  the worker has no record of the phase's origin (lookup 404): nothing ran
//   finished        the worker holds a terminal result; `event` is the runtime terminal event RoboFlow
//                   commits through its normal completion path (so the successor is dispatched once, and
//                   a failure, including `termination_unverified`, dispatches none)
//   running         admitted and not terminal (queued, running or stopping): follow it
//   unknown         the worker could not answer (unsent, unknown outcome, 5xx, refusal): change nothing
//
// The lookup and the read use the flow's background binding, so no user grant is involved.
export async function classifyPhase({ client, flow, instance }) {
    const taskId = instance.runtimeTaskId;
    const originRequestId = phaseOriginId({ flowId: flow.id, instanceId: instance.id, runtimeTaskId: taskId });
    const auth = { bindingId: flow.id };
    let accepted;
    let snapshot;
    try {
        accepted = await client.lookup(originRequestId, auth);
        if (!accepted) return { action: 'never_admitted', originRequestId };
        snapshot = await client.read(accepted.referenceId, auth);
    } catch (error) {
        return { action: 'unknown', originRequestId, code: error?.code || 'worker_coordinator_unavailable' };
    }
    const result = snapshot?.result || {};
    const text = typeof result.outputText === 'string' ? result.outputText : '';
    switch (snapshot?.state) {
    case 'completed':
        return { action: 'finished', originRequestId, referenceId: accepted.referenceId, event: { kind: 'terminal', taskId, state: 'completed', result: text, error: null } };
    case 'failed': {
        const reason = typeof result.reason === 'string' ? result.reason : null;
        return { action: 'finished', originRequestId, referenceId: accepted.referenceId, terminationUnverified: reason === 'termination_unverified',
            event: { kind: 'terminal', taskId, state: 'failed', result: text, error: plainStopMessage(reason, result.data) || `Worker execution failed${reason ? ` (${reason})` : ''}.` } };
    }
    case 'human-input': {
        // The model asked while RoboTeam was down: the question the worker holds is read back from the reference's events, so it is
        // not lost (plan section 9) and the phase can be answered. `humanInput` is null when the events no longer hold it.
        let humanInput;
        try {
            humanInput = await recoverQuestion({ client, referenceId: accepted.referenceId, auth, requestId: result.data?.requestId });
        } catch (error) {
            return { action: 'unknown', originRequestId, code: error?.code || 'worker_coordinator_unavailable' };
        }
        return { action: 'finished', originRequestId, referenceId: accepted.referenceId, endState: 'human-input', humanInput,
            event: { kind: 'terminal', taskId, state: 'paused', result: text, error: humanInput ? null : 'The human-input question could not be recovered from the worker.' } };
    }
    case 'cancelled': case 'interrupted': case 'paused':
        return { action: 'finished', originRequestId, referenceId: accepted.referenceId,
            event: { kind: 'terminal', taskId, state: 'paused', result: text, error: `Task ${snapshot.state} on the worker.` } };
    case 'queued': case 'running': case 'stopping':
        return { action: 'running', originRequestId, referenceId: accepted.referenceId };
    default:
        return { action: 'unknown', originRequestId, code: 'worker_reply_unknown' };
    }
}

// The `human-input-request` event of a reference (the one for `requestId`, else the last), as `{question, options, worker}` for
// RoboFlow's pending-question record, or null when the retained events no longer hold it. Read with the coordinator identity and the
// flow binding, by cursor; a read that fails throws, so the caller asks again later.
const EVENT_PAGES = 20;

export async function recoverQuestion({ client, referenceId, auth, requestId }) {
    let after = 0;
    let found = null;
    for (let page = 0; page < EVENT_PAGES; page += 1) {
        const batch = await client.events(referenceId, { after, limit: 500 }, auth);
        if (batch.gap) { after = batch.snapshotSequence; continue; }
        for (const row of batch.events || []) {
            const kind = row?.kind ?? row?.type;
            const data = row?.data && typeof row.data === 'object' ? row.data : row;
            if (kind !== 'human-input-request' || typeof data.requestId !== 'string') continue;
            if (!requestId || data.requestId === requestId) found = data;
        }
        if (!batch.events?.length || batch.nextAfter === after) break;
        after = batch.nextAfter;
    }
    return found && typeof found.question === 'string' && Array.isArray(found.options)
        ? { question: found.question, options: found.options, worker: { referenceId, requestId: found.requestId } } : null;
}

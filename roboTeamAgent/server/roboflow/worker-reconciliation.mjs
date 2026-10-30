import { phaseOriginId } from '../worker-coordinator/flow-origins.mjs';

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
            event: { kind: 'terminal', taskId, state: 'failed', result: text, error: `Worker execution failed${reason ? ` (${reason})` : ''}.` } };
    }
    case 'cancelled': case 'interrupted': case 'paused': case 'human-input':
        return { action: 'finished', originRequestId, referenceId: accepted.referenceId,
            event: { kind: 'terminal', taskId, state: 'paused', result: text, error: `Task ${snapshot.state} on the worker.` } };
    case 'queued': case 'running': case 'stopping':
        return { action: 'running', originRequestId, referenceId: accepted.referenceId };
    default:
        return { action: 'unknown', originRequestId, code: 'worker_reply_unknown' };
    }
}

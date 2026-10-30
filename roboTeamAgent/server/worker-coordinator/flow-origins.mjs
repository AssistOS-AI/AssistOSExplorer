import crypto from 'node:crypto';
import { isFlowBindingId, isOriginId } from './identities.mjs';

// The deterministic origin request ID of one RoboFlow phase attempt (plan section 9: persist the flow
// and phase identity and a deterministic submission operation before dispatch). RoboFlow persists
// `runtimeTaskId` on the phase visit before it starts the attempt and gives every attempt (including
// a continuation of the same visit) a fresh one, so the ID is stable across a RoboTeam restart,
// differs between attempts, and a re-dispatch after a restart presents the same origin and cannot
// admit a second execution.
export function phaseOriginId({ flowId, instanceId, runtimeTaskId }) {
    for (const [name, value] of [['flowId', flowId], ['instanceId', instanceId], ['runtimeTaskId', runtimeTaskId]]) {
        if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
    }
    const id = crypto.createHash('sha256').update(`roboteam/flow-phase/v1\n${flowId}\n${instanceId}\n${runtimeTaskId}`)
        .digest().subarray(0, 16).toString('base64url');
    if (!isOriginId(id)) throw new Error('derived origin is not canonical');
    return id;
}

// {originRequestId, bindingId} of a phase attempt, or null when the request is not flow work (or its
// flow ID is not a root or derived flow binding).
export function workerBindingFor(request, taskId) {
    const flowId = request?.workflowRunId;
    const instanceId = request?.workflowInstanceId;
    if (typeof flowId !== 'string' || typeof instanceId !== 'string' || !isFlowBindingId(flowId)) return null;
    return { bindingId: flowId, originRequestId: phaseOriginId({ flowId, instanceId, runtimeTaskId: taskId }) };
}

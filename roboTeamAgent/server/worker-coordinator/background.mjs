import { WorkerCoordinatorError, mapHopOutcome } from './errors.mjs';
import { bindOperationId, isBindingId, isFlowBindingId, parseScheduleBindingId } from './identities.mjs';

// The background row of the worker coordinator (design S3c §6.6 as reduced by integrator
// decision ID-2): binding identities and derived binding registration only. Root bindings are
// registered with the owner's grant through `/api/worker/bindings`; a derived binding is
// registered by the coordinator alone, the worker reading the owner from the parent binding.
// Phase admission is flow work and waits for P5.

// `cron_<id>.r<bindingRevision>`. A schedule without a recorded binding revision has no binding:
// there is no legacy reader (R18).
export function scheduleBindingId(schedule) {
    if (!Number.isSafeInteger(schedule?.bindingRevision) || schedule.bindingRevision < 1) {
        throw new WorkerCoordinatorError('binding_revision_unavailable', 409);
    }
    const bindingId = `${schedule.id}.r${schedule.bindingRevision}`;
    if (!parseScheduleBindingId(bindingId)) throw new WorkerCoordinatorError('invalid_request', 400);
    return bindingId;
}

// The binding a flow derives from, or null for a root flow. A child flow derives from its parent
// flow; a cron-fired flow from the schedule binding it was launched under; a run-now flow and an
// ordinary flow are roots. A scheduled flow without launch metadata predates bindings.
export function parentBindingFor(flow) {
    if (flow?.parentFlowId) {
        if (!isFlowBindingId(flow.parentFlowId)) throw new WorkerCoordinatorError('invalid_request', 400);
        return flow.parentFlowId;
    }
    if (!flow?.scheduleId) return null;
    if (flow.scheduledLaunch === 'cron') return scheduleBindingId({ id: flow.scheduleId, bindingRevision: flow.scheduleBindingRevision });
    if (flow.scheduledLaunch === 'manual') return null;
    throw new WorkerCoordinatorError('binding_revision_unavailable', 409);
}

// Coordinator-alone derived registration: no grant, `parentBindingId` in the signed body. The
// child is always a flow binding. Returns the worker receipt or throws WorkerCoordinatorError.
export async function registerDerivedBinding({ hop, bindingId, parentBindingId }) {
    if (!isFlowBindingId(bindingId) || !isBindingId(parentBindingId) || bindingId === parentBindingId) {
        throw new WorkerCoordinatorError('invalid_request', 400);
    }
    if (!hop) throw new WorkerCoordinatorError('worker_coordinator_unavailable', 503);
    const mapped = mapHopOutcome(await hop.call('bindings', { operationId: bindOperationId(bindingId), bindingId, parentBindingId }));
    if (mapped.status !== 200) throw new WorkerCoordinatorError(mapped.body.error, mapped.status);
    return mapped.body;
}

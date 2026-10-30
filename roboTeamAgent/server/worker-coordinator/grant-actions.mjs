import { parseRouterAuthInfo } from '../request-identity.mjs';
import { grantForPrincipal, bindOperationId, isFlowBindingId } from './identities.mjs';
import { WorkerCoordinatorError, mapHopOutcome } from './errors.mjs';

// What RoboTeam does with the Router-minted `providerAdmission` grant of the few API requests that
// declare it in the manifest (decision M-13): robot create and update, flow start and run-now. The
// grant is used inside the request that carried it, and is never stored.

// The verified request's own grant for its principal, or null (internal callers have none).
export function workerGrantFor(req, access) {
    if (access?.internal !== false || typeof access.principal !== 'string') return null;
    return grantForPrincipal(parseRouterAuthInfo(req)?.delegations, access.principal);
}

// Registers a root flow's binding with the starting user's grant (owner binding, plan section 8.2).
// A child or cron-fired flow's binding derives from its parent and is registered by the coordinator
// alone, so it is skipped here. Returns the worker receipt; a refusal throws with `statusCode`.
export async function registerRootFlowBinding({ hop, flow, grant }) {
    if (!isFlowBindingId(flow?.id) || flow.parentFlowId) return null;
    if (!hop) throw Object.assign(new Error('worker_coordinator_unavailable'), { statusCode: 503 });
    if (!grant) throw Object.assign(new Error('owner_evidence_unavailable'), { statusCode: 403 });
    let mapped;
    try {
        mapped = mapHopOutcome(await hop.call('bindings', { operationId: bindOperationId(flow.id), bindingId: flow.id }, { grant }));
    } catch (error) {
        if (error instanceof WorkerCoordinatorError) throw Object.assign(new Error(error.code), { statusCode: error.status });
        throw error;
    }
    if (mapped.status !== 200) throw Object.assign(new Error(mapped.body?.error || 'worker_coordinator_unavailable'), { statusCode: mapped.status });
    return mapped.body;
}

// Provisions or configures the robot on the worker with the request's administrator grant. The
// RoboTeam change has already happened, so a failure does not undo it: it is reported with the code,
// and the robot is ensured again lazily before its first use by an administrator.
export async function ensureRobotWithGrant({ provisioner, robot, grant }) {
    if (!provisioner || !grant) return { ready: false, error: grant ? 'worker_coordinator_unavailable' : 'owner_evidence_unavailable' };
    try {
        await provisioner.ensureReady(robot, { grant });
        return { ready: true };
    } catch (error) {
        return { ready: false, error: typeof error?.code === 'string' ? error.code : 'worker_coordinator_unavailable' };
    }
}

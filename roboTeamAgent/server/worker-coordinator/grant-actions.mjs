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

// Prepares every robot a flow's phases may use on the worker (provision or configure when stale) with the starting request's
// grant, before the first phase is dispatched: a phase runs on the coordinator identity alone and cannot configure a robot.
// Each robot is ensured; any that cannot be prepared stops the flow start with a message naming it.
export async function ensureFlowRobots({ provisioner, robots, grant }) {
    if (!robots?.length) return [];
    if (!provisioner) throw Object.assign(new Error('worker_coordinator_unavailable'), { statusCode: 503 });
    if (!grant) throw Object.assign(new Error('owner_evidence_unavailable'), { statusCode: 403 });
    const prepared = [];
    for (const robot of robots) {
        const outcome = await ensureRobotWithGrant({ provisioner, robot, grant });
        if (!outcome.ready) {
            throw Object.assign(new Error(`Robot "${robot.name}" could not be prepared on the worker (${outcome.error}). Open the robot, check it, and start the flow again.`),
                { statusCode: outcome.error === 'owner_evidence_unavailable' ? 403 : 503 });
        }
        prepared.push(robot.id);
    }
    return prepared;
}

// Robot deletion (decision M-29): the worker is asked first, with the deleting request's own administrator grant, and RoboTeam
// removes its own record only after this returns. A robot with running or unsettled work is refused by the worker; that refusal
// carries the user's message and its status, and RoboTeam keeps its record. Idempotent: a robot the worker no longer has, or
// has already accepted the deletion of, is success.
export async function removeRobotOnWorker({ provisioner, robot, grant }) {
    if (!provisioner) throw Object.assign(new Error('worker_coordinator_unavailable'), { statusCode: 503 });
    if (!grant) throw Object.assign(new Error('owner_evidence_unavailable: delete the robot from its own page so the request carries your grant.'), { statusCode: 403 });
    try {
        return await provisioner.deleteRobot(robot, { grant });
    } catch (error) {
        const detail = typeof error?.message === 'string' && error.message !== error.code ? error.message : (error?.code || 'worker_coordinator_unavailable');
        throw Object.assign(new Error(detail), { statusCode: error?.status || 503, code: error?.code });
    }
}

// What the request that starts a root flow does with its grant before the first phase is dispatched: register the flow's binding,
// then prepare every robot its phases may use. `roboflow.flowRobots(flow)` names them. A child flow (no binding of its own) needs
// neither.
export async function prepareFlowStart({ hop, provisioner, roboflow, flow, grant }) {
    const registered = await registerRootFlowBinding({ hop, flow, grant });
    if (registered === null) return { registered: false, robots: [] };
    return { registered: true, robots: await ensureFlowRobots({ provisioner, robots: await roboflow.flowRobots(flow), grant }) };
}

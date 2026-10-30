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
// grant, before the first phase is dispatched: a phase runs on the coordinator identity alone and cannot configure a robot. Only
// the robots the phases can actually use are passed in. Every robot is tried; if any cannot be prepared, the flow start is refused
// with a message naming EVERY such robot, its code and a short reason, so the user can fix or deselect them.
const REASONS = Object.freeze({
    worker_robot_not_ready: 'it did not become ready in time',
    worker_robot_failed: 'its preparation failed on the worker',
    worker_robot_stale: 'its configuration differs and could not be updated',
    worker_robot_missing: 'the worker no longer has it',
    worker_robot_not_provisioned: 'it is not set up on the worker',
    owner_evidence_unavailable: 'the request carried no grant for it',
    robot_busy: 'it has running or unsettled work',
    revision_conflict: 'it changed while being updated',
    worker_coordinator_unavailable: 'the worker could not be reached',
    worker_unreachable: 'the worker could not be reached',
    worker_reply_unknown: 'the worker did not answer',
    resource_quarantined: 'a resource of it is quarantined',
    recovery_pending: 'the worker is still recovering',
    runtime_unavailable: 'the worker runtime is unavailable',
    forbidden: 'the worker refused the request',
});

export async function ensureFlowRobots({ provisioner, robots, grant }) {
    if (!robots?.length) return [];
    if (!provisioner) throw Object.assign(new Error('worker_coordinator_unavailable'), { statusCode: 503 });
    if (!grant) throw Object.assign(new Error('owner_evidence_unavailable'), { statusCode: 403 });
    const prepared = [];
    const failures = [];
    for (const robot of robots) {
        const outcome = await ensureRobotWithGrant({ provisioner, robot, grant });
        if (outcome.ready) prepared.push(robot.id);
        else failures.push({ robot, code: outcome.error });
    }
    if (failures.length) {
        const list = failures.map(({ robot, code }) => `"${robot.name}" (${code}${REASONS[code] ? `: ${REASONS[code]}` : ''})`).join('; ');
        throw Object.assign(new Error(`${failures.length === 1 ? 'This robot' : `These ${failures.length} robots`} could not be prepared on the worker: ${list}. Open the robot${failures.length === 1 ? '' : 's'}, fix ${failures.length === 1 ? 'it' : 'them'} or deselect ${failures.length === 1 ? 'it' : 'them'}, and start the flow again.`),
            { statusCode: failures.every(({ code }) => code === 'owner_evidence_unavailable') ? 403 : 503, failures: failures.map(({ robot, code }) => ({ robot: robot.name, code })) });
    }
    return prepared;
}

// What the request that starts a root flow does with its grant before the first phase is dispatched: register the binding, then
// prepare the robots its phases may use (`roboflow.flowRobots(flow)`). A child flow (no binding of its own) needs neither.
//   administrator: every such robot is prepared (provisioned or configured when stale); any that cannot be is a refusal naming each.
//   anyone else: nothing that needs an administrator is attempted. Robots are only looked at, and the start is never refused for an
//   administrator-only step; the ones that need one come back in `notice` (informational, not blocking) and their phases fail
//   promptly with "Ask an administrator to open robot "X" to update it." when they get there.
export async function prepareFlowStart({ hop, provisioner, roboflow, flow, grant, admin = true }) {
    const registered = await registerRootFlowBinding({ hop, flow, grant });
    if (registered === null) return { registered: false, robots: [], notice: null };
    const robots = await roboflow.flowRobots(flow);
    if (admin) return { registered: true, robots: await ensureFlowRobots({ provisioner, robots, grant }), notice: null };
    const needs = [];
    for (const robot of robots) {
        let checked;
        try {
            checked = await provisioner.inspect(robot, {});
        } catch {
            checked = { ready: false, code: 'worker_coordinator_unavailable', reason: 'the worker could not be asked about it' };
        }
        if (!checked.ready) needs.push({ robot: robot.name, code: checked.code, reason: checked.reason });
    }
    return { registered: true, robots: robots.map((robot) => robot.id), notice: needs.length ? flowStartNotice(needs) : null };
}

// The informational, non-blocking notice of a non-administrator's flow start.
export function flowStartNotice(robots) {
    const list = robots.map(({ robot, code, reason }) => `"${robot}" (${code}: ${reason})`).join('; ');
    return {
        robots,
        message: `The workflow was started, but ${robots.length === 1 ? 'this robot needs' : 'these robots need'} an administrator before its phases can run: ${list}. Ask an administrator to open ${robots.length === 1 ? 'it' : 'each'} to update it; a phase that reaches ${robots.length === 1 ? 'it' : 'one'} first will fail.`,
    };
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

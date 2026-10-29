import { parseRouterAuthInfo } from '../request-identity.mjs';
import { errorResult, mapHopOutcome, refusal } from './errors.mjs';
import {
    bindOperationId, grantForPrincipal, isFlowBindingId, isInternalId, isOperationId, isOriginId, isReferenceId, parseScheduleBindingId,
} from './identities.mjs';

// RoboTeam's browser API row of the worker coordinator (design S3c §6.3): POST endpoints under
// `/api/worker/*`, reached only through the narrow Router route that mints the
// `providerAdmission` grant. Each request must come from a verified direct user (never an
// internal-token caller) whose request carries a grant naming that same user. RoboTeam
// validates the exact body, builds the worker body itself and relays it over the coordinator
// hop with the grant. It never mints an origin for the page and never starts local work.

export const WORKER_ROUTE = /^\/api\/worker(?:\/|$)/u;
export const isWorkerRoute = (pathname) => WORKER_ROUTE.test(pathname);
export const ADMISSIONS_PATH = '/api/worker/admissions';
const REFERENCE_ROUTE = /^\/api\/worker\/references\/([^/]+)\/(read|events|control)$/u;
const TASK_TYPES = new Set(['simple', 'browser', 'desktop']);
const CONTROL_OP = /^[a-z][a-z-]{0,31}$/u;
const PROMPT_LIMIT = 32768;
const CWD_LIMIT = 4096;

class BadRequest extends Error {
    constructor(code = 'invalid_request') {
        super(code);
        this.code = code;
    }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function exact(value, required, optional = []) {
    if (!isPlainObject(value)) throw new BadRequest();
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BadRequest();
    for (const key of required) if (!Object.hasOwn(value, key)) throw new BadRequest();
    return value;
}

function parseBody(raw) {
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new BadRequest();
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch {
        throw new BadRequest();
    }
}

function validCwd(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > CWD_LIMIT) return false;
    if (value.includes('\0') || value.startsWith('/') || value.includes('\\')) return false;
    return !value.split('/').some((segment) => segment === '..');
}

// The A1 admission body for a task-kind browser request. Session and flow work are refused
// until the worker records the logical kind at admission (design A16).
export function admissionBody(input) {
    const body = exact(input, ['originRequestId', 'robotId', 'configRevision', 'kind', 'task'], ['logicalId']);
    if (body.kind !== 'task' && body.kind !== 'continuation') throw new BadRequest('logical_kind_unavailable');
    if (!isOriginId(body.originRequestId) || !isInternalId(body.robotId)) throw new BadRequest();
    if (!Number.isSafeInteger(body.configRevision) || body.configRevision < 1) throw new BadRequest();
    if (body.kind === 'task' && body.logicalId !== undefined) throw new BadRequest();
    if (body.kind === 'continuation' && !isInternalId(body.logicalId)) throw new BadRequest();
    const task = exact(body.task, ['type', 'prompt'], ['cwd']);
    if (!TASK_TYPES.has(task.type)) throw new BadRequest();
    if (typeof task.prompt !== 'string' || task.prompt.length < 1 || task.prompt.length > PROMPT_LIMIT) throw new BadRequest();
    if (task.cwd !== undefined && !validCwd(task.cwd)) throw new BadRequest();
    const specification = { version: 1, taskType: task.type, prompt: task.prompt, ...(task.cwd !== undefined ? { cwd: task.cwd } : {}) };
    return {
        originRequestId: body.originRequestId, robotId: body.robotId, configRevision: body.configRevision, kind: body.kind,
        specification, ...(body.kind === 'continuation' ? { logical: { logicalId: body.logicalId } } : {}),
    };
}

function controlBody(input) {
    const body = exact(input, ['operationId', 'op'], ['attemptId', 'payload']);
    if (!isOperationId(body.operationId) || typeof body.op !== 'string' || !CONTROL_OP.test(body.op)) throw new BadRequest();
    if (body.attemptId !== undefined && !isInternalId(body.attemptId)) throw new BadRequest();
    return {
        operationId: body.operationId, op: body.op,
        ...(body.attemptId !== undefined ? { attemptId: body.attemptId } : {}),
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
    };
}

function eventsBody(input) {
    const body = exact(input, ['after', 'limit']);
    if (!Number.isSafeInteger(body.after) || body.after < 0) throw new BadRequest();
    if (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 9999) throw new BadRequest();
    return { after: body.after, limit: body.limit };
}

// An admission whose outcome is unknown (the reply was lost after the request reached the
// Router) is recovered by one lookup with the same grant; any other lookup result leaves it
// unknown, with the origin so the page can retry or look it up again.
export async function admitWithRecovery(hop, body, grant) {
    const outcome = await hop.call('admissions', body, { grant });
    if (outcome.outcome !== 'unknown') return mapHopOutcome(outcome);
    let lookup = null;
    try {
        lookup = await hop.call('lookup', { originRequestId: body.originRequestId }, { grant });
    } catch {
        lookup = null;
    }
    if (lookup?.outcome === 'response' && !lookup.refusal && lookup.status === 200) return { status: 200, body: lookup.json };
    return refusal('worker_reply_unknown', { originRequestId: body.originRequestId });
}

// Root binding registration (design S3c-6, review M2/M7). Order: administrator (schedules),
// existence, recorded binding revision, revision match, owner. The revision checks run before
// the owner check so a stale revision is refused as such for every caller.
async function bindingAllowed(bindingId, access, records) {
    const schedule = parseScheduleBindingId(bindingId);
    if (schedule) {
        if (access.canAdmin !== true) return refusal('binding_owner_mismatch');
        const record = records ? await records.getSchedule(schedule.scheduleId) : null;
        if (!record) return refusal('not_found');
        if (!Number.isSafeInteger(record.bindingRevision)) return refusal('binding_revision_unavailable');
        if (record.bindingRevision !== schedule.revision) return refusal('binding_revision_unavailable');
        if (record.ownerPrincipal !== access.principal) return refusal('binding_owner_mismatch');
        return null;
    }
    if (!isFlowBindingId(bindingId)) return refusal('invalid_request');
    const flow = records ? await records.getFlow(bindingId) : null;
    if (!flow) return refusal('not_found');
    // A child flow binds under its parent (derived), never as a root.
    if (flow.parentFlowId) return refusal('invalid_request');
    // A scheduled flow without launch metadata predates bindings: no legacy reader (R18).
    if (flow.scheduleId && flow.scheduledLaunch !== 'manual' && flow.scheduledLaunch !== 'cron') return refusal('binding_revision_unavailable');
    // A cron-fired flow binds under its schedule binding (derived), never as a root.
    if (flow.scheduledLaunch === 'cron') return refusal('invalid_request');
    if (flow.ownerPrincipal !== access.principal) return refusal('binding_owner_mismatch');
    if (flow.scheduledLaunch === 'manual' && access.canAdmin !== true) return refusal('binding_owner_mismatch');
    return null;
}

async function route(pathname, input, { access, grant, hop, records }) {
    if (pathname === ADMISSIONS_PATH) return admitWithRecovery(hop, admissionBody(input), grant);
    if (pathname === '/api/worker/lookup') {
        const body = exact(input, ['originRequestId']);
        if (!isOriginId(body.originRequestId)) throw new BadRequest();
        return mapHopOutcome(await hop.call('lookup', { originRequestId: body.originRequestId }, { grant }));
    }
    if (pathname === '/api/worker/bindings') {
        const body = exact(input, ['bindingId']);
        if (typeof body.bindingId !== 'string') throw new BadRequest();
        const refused = await bindingAllowed(body.bindingId, access, records);
        if (refused) return refused;
        return mapHopOutcome(await hop.call('bindings', { operationId: bindOperationId(body.bindingId), bindingId: body.bindingId }, { grant }));
    }
    const reference = REFERENCE_ROUTE.exec(pathname);
    const [, referenceId, action] = reference;
    if (!isReferenceId(referenceId)) throw new BadRequest();
    const body = action === 'read' ? exact(input, []) && {} : action === 'events' ? eventsBody(input) : controlBody(input);
    return mapHopOutcome(await hop.call(`references/${referenceId}/${action}`, body, { grant }));
}

const knownPath = (pathname) => ['/api/worker/admissions', '/api/worker/lookup', '/api/worker/bindings'].includes(pathname)
    || REFERENCE_ROUTE.test(pathname);

// Writes the response itself and never throws. `access` is the verified request decision,
// `rawBody` the exact bytes the Router signature was checked against, `records` the RoboFlow
// schedule and flow reader ({getSchedule(id), getFlow(id)}) or null.
export async function handleWorkerRoutes({ req, res, pathname, access, rawBody, hop, records, sendJson }) {
    let result;
    try {
        if (!knownPath(pathname)) result = refusal('not_found');
        else if (req.method !== 'POST') result = refusal('invalid_request');
        else if (access?.internal !== false || typeof access.principal !== 'string' || !/^user:.+/u.test(access.principal)) {
            result = refusal('owner_evidence_unavailable');
        } else {
            const grant = grantForPrincipal(parseRouterAuthInfo(req)?.delegations, access.principal);
            if (!grant) result = refusal('owner_evidence_unavailable');
            else if (!hop) result = refusal('worker_coordinator_unavailable');
            else result = await route(pathname, parseBody(rawBody), { access, grant, hop, records });
        }
    } catch (error) {
        result = error instanceof BadRequest ? refusal(error.code) : errorResult(error);
    }
    sendJson(res, result.status, result.body);
}

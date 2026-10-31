import crypto from 'node:crypto';
import { WorkerCoordinatorError, mapHopOutcome } from './errors.mjs';
import { isOperationId, isReferenceId } from './identities.mjs';

// The call layer of RoboTeam's worker coordinator callers that run in the robot-task child and in the
// server process (RoboWork r10 step 7): admission with lost-reply recovery, reference reads, event
// pages and controls, over the coordinator hop. Owner evidence is the caller's `auth`:
//   {grant}      a Router-minted owner grant, valid 30 seconds (coordinator-API row)
//   {bindingId}  no grant; the coordinator alone under a registered flow binding (background row)
// A grant is only forwarded, never stored, logged or returned.

export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'paused', 'human-input', 'cancelled', 'interrupted']);

// A worker or hop failure with a fixed code. `status` is the mapped HTTP status.
export class WorkerError extends Error {
    constructor(code, status = 503, extra = {}) {
        super(code);
        this.name = 'WorkerError';
        this.code = code;
        this.status = status;
        Object.assign(this, extra);
    }
}

function fromMapped(mapped) {
    const { error, message, ...extra } = mapped.body || {};
    const code = typeof error === 'string' ? error : 'worker_reply_unknown';
    const failure = new WorkerError(code, mapped.status, extra);
    // A plain message for the code (errors.mjs PLAIN_MESSAGES) reads `<code>: <message>`, as the other user-facing worker errors do.
    if (typeof message === 'string' && message) failure.message = `${code}: ${message}`;
    return failure;
}

function fromThrown(error) {
    if (error instanceof WorkerError) return error;
    if (error instanceof WorkerCoordinatorError) return new WorkerError(error.code, error.status);
    return new WorkerError('worker_coordinator_unavailable', 503);
}

const authOptions = (auth) => (auth?.grant ? { grant: auth.grant } : {});
const withBinding = (body, auth) => (auth?.bindingId && !auth.grant ? { ...body, bindingId: auth.bindingId } : body);

// The operation ID of a stop of one reference: deterministic, so a child's stop, the service's stop
// and a retry are one operation at the worker.
export function stopOperationId(referenceId) {
    return crypto.createHash('sha256').update(`roboteam/control/v1\nstop\n${referenceId}`).digest('base64url').slice(0, 22);
}

export function newOperationId() {
    return crypto.randomBytes(16).toString('base64url');
}

export function createWorkerClient({ hop } = {}) {
    if (!hop || typeof hop.call !== 'function') throw new TypeError('A worker coordinator hop is required.');

    // The raw hop outcome; a thrown hop error becomes a WorkerError.
    async function raw(operation, body, auth) {
        try {
            return await hop.call(operation, body, authOptions(auth));
        } catch (error) {
            throw fromThrown(error);
        }
    }

    async function call(operation, body, auth) {
        const outcome = await raw(operation, body, auth);
        const mapped = mapHopOutcome(outcome);
        if (mapped.status !== 200) throw fromMapped(mapped);
        return mapped.body;
    }

    function acceptance(json, originRequestId) {
        const id = typeof json?.taskRef === 'string' ? json.taskRef : json?.taskRef?.id;
        if (!isReferenceId(id)) throw new WorkerError('worker_reply_unknown', 503, { originRequestId });
        return { referenceId: id, state: json.state, originRequestId };
    }

    return Object.freeze({
        call,

        // Admits one execution under the caller's evidence. `body` is the complete worker body
        // (it carries `originRequestId`). A reply lost after the request reached the Router is
        // recovered by lookup of the same origin; a 404 there means the worker never admitted it,
        // and the same body (same origin, so the same operation) is sent once more.
        async admit(body, auth) {
            const originRequestId = body.originRequestId;
            const payload = withBinding(body, auth);
            let outcome = await raw('admissions', payload, auth);
            if (outcome.outcome === 'unknown') {
                const lookup = await raw('lookup', withBinding({ originRequestId }, auth), auth);
                if (lookup.outcome === 'response' && !lookup.refusal && lookup.status === 200) return acceptance(lookup.json, originRequestId);
                if (!(lookup.outcome === 'response' && !lookup.refusal && lookup.status === 404)) {
                    throw new WorkerError('worker_reply_unknown', 503, { originRequestId });
                }
                outcome = await raw('admissions', payload, auth);
                if (outcome.outcome === 'unknown') throw new WorkerError('worker_reply_unknown', 503, { originRequestId });
            }
            const mapped = mapHopOutcome(outcome);
            if (mapped.status !== 200) throw fromMapped(mapped);
            return acceptance(mapped.body, originRequestId);
        },

        // The recorded acceptance of an origin, or null when the worker never admitted it (404).
        async lookup(originRequestId, auth) {
            const outcome = await raw('lookup', withBinding({ originRequestId }, auth), auth);
            if (outcome.outcome === 'response' && !outcome.refusal && outcome.status === 404) return null;
            const mapped = mapHopOutcome(outcome);
            if (mapped.status !== 200) throw fromMapped(mapped);
            return acceptance(mapped.body, originRequestId);
        },

        // One event subscription, authorized at open by `auth` alone (the grant of the opening request,
        // or the coordinator identity with the binding). Resolves to an async iterable of event rows
        // after the cursor. The iteration ends when the worker ends the stream and throws
        // `worker_stream_dropped` when it breaks; a worker that answers with a plain page instead of a
        // stream yields that page's rows and ends.
        async subscribe(referenceId, { after }, auth, { signal } = {}) {
            let outcome;
            try {
                outcome = await hop.stream(`references/${referenceId}/events`, withBinding({ after, stream: true }, auth), { grant: auth?.grant, signal });
            } catch (error) {
                throw fromThrown(error);
            }
            if (outcome.outcome === 'stream') return outcome.lines;
            const mapped = mapHopOutcome(outcome);
            if (mapped.status !== 200) throw fromMapped(mapped);
            const page = mapped.body;
            return (async function* plainPage() {
                if (page.gap) yield { gap: true, snapshotSequence: page.snapshotSequence };
                for (const row of page.events || []) yield row;
            }());
        },
        read: (referenceId, auth) => call(`references/${referenceId}/read`, withBinding({}, auth), auth),
        events: (referenceId, { after, limit }, auth) => call(`references/${referenceId}/events`, withBinding({ after, limit }, auth), auth),
        control(referenceId, { operationId = newOperationId(), op, attemptId, payload }, auth) {
            if (!isOperationId(operationId)) throw new WorkerError('invalid_request', 400);
            const body = { operationId, op, ...(attemptId !== undefined ? { attemptId } : {}), ...(payload !== undefined ? { payload } : {}) };
            return call(`references/${referenceId}/control`, withBinding(body, auth), auth);
        },
        getRobot: (robotId, auth) => call('robots/get', { robotId }, auth),
        getOperation: (operationId, auth) => call('operations/get', { operationId }, auth),
        provision: (body, auth) => call('robots/provision', body, auth),
        configure: (body, auth) => call('robots/configure', body, auth),
        deleteRobot: (body, auth) => call('robots/delete', body, auth),
    });
}

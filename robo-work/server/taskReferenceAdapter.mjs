import { exactObject, fail, isOriginId, isPublicReferenceId } from './stateProtocol.mjs';
import {
    CoordinatorAuthError, consumeReplay, contextForTaskReferenceCaller, replayItems, verifyTaskReferenceRequest
} from './coordinatorAuth.mjs';

// Generic task-reference operations forwarded by the Router's `/task-refs` route
// (interface note 2.3) and the projections of S1 state they return.
//
// Authorization: the caller is the verified direct caller of the `__task_ref__` Router
// Request, as the MCP origin row (`mcp` / `user:<id>` | `agent:<principal>`). S1 decides
// visibility from the admission row: the execution owner, a verified direct administrator
// user, and nothing else; an invisible reference is the same `not_found` as an unknown one.
// The reference ID itself is never authority.
//
// Replay: read, events and lookup are read-only and use the verifier's bounded in-memory
// cache. Control is mutating: its token ID is consumed durably by S1 in the control
// transaction, and burned in a separate transaction when the request is refused after
// verification.

// Relayed control vocabulary (design A15). S1 maps `stop`, `message` and `pause` (S6 Part D:
// `pause` is a fence on an observation reference and invalid_request on an execution
// reference, both decided by S1 after visibility); the others are refused after verification
// and before any state access.
export const MAPPED_CONTROL_OPS = Object.freeze(['stop', 'message', 'pause', 'answer']);
export const UNMAPPED_CONTROL_OPS = Object.freeze(['take-control', 'resume']);
const DEFAULT_EVENTS = Object.freeze({ after: 0, limit: 100 });
const LOGICAL_KINDS = Object.freeze(['task', 'session', 'flow']);
export const RECORDED_ADMISSION_STATES = Object.freeze(['queued', 'pending-coordinator']);
const EVENTS_QUERY = /^\?after=(0|[1-9][0-9]{0,15})&limit=([1-9][0-9]{0,3})$/;

function taskRefOf(reference) {
    return { version: reference.version, provider: reference.provider, id: reference.id };
}

// Snapshot projection (interface note 2.1; design §3.3) of S1 `observeReference` facts. The
// key set is exactly {taskRef, originRequestId, kind, state, attempt, logical, sequence,
// result?, linked?, cleanup?}; `attempt.endedReason` and `result` appear only once terminal.
// `kind: 'execution'` for every S1 admission. `logical` is the logical kind recorded at
// admission (S3b-A16; S6 source-only subset, Part A): `task` and `session` carry the
// worker's logical ID, `flow` carries the binding's flow record ID (`flow_...` or `gen_...`)
// of the background row it was admitted under. An unrecorded kind is state_corrupt.
export function projectSnapshot(observed) {
    if (observed.referenceKind === 'observation') return projectObservation(observed);
    const attempt = { attemptId: observed.attemptId, state: observed.state };
    if (observed.endedReason !== null) attempt.endedReason = observed.endedReason;
    const snapshot = {
        taskRef: taskRefOf(observed.reference),
        originRequestId: observed.originRequestId,
        kind: 'execution',
        state: observed.state,
        attempt,
        logical: projectLogical(observed),
        sequence: observed.sequence
    };
    if (observed.result) {
        const result = { status: observed.result.status, outputText: observed.result.outputText };
        if (observed.result.data !== null && observed.result.data !== undefined) result.data = observed.result.data;
        if (observed.result.reason !== undefined) result.reason = observed.result.reason;
        if (observed.result.classification !== undefined) result.classification = observed.result.classification;
        snapshot.result = result;
    }
    if (observed.previousReference) snapshot.linked = { previousTaskRef: taskRefOf(observed.previousReference) };
    if (observed.cleanup !== null) snapshot.cleanup = observed.cleanup;
    return snapshot;
}

// ObservationSnapshot (interface note 2.1): {taskRef, originRequestId, kind: 'observation',
// state, obligation: {obligationKind, state, acceptBy, fenceRevision}, logical: {kind: 'flow',
// id}, sequence, result?}. There is no `attempt`; `logical.id` is null while pending.
function projectObservation(observed) {
    const { obligation } = observed;
    const snapshot = {
        taskRef: taskRefOf(observed.reference),
        originRequestId: observed.originRequestId,
        kind: 'observation',
        state: observed.state,
        obligation: { obligationKind: obligation.obligationKind, state: obligation.state, acceptBy: obligation.acceptBy, fenceRevision: obligation.fenceRevision },
        logical: { kind: 'flow', id: observed.logicalId ?? null },
        sequence: observed.sequence
    };
    if (observed.result) {
        const result = { status: observed.result.status, outputText: observed.result.outputText };
        if (observed.result.data !== null && observed.result.data !== undefined) result.data = observed.result.data;
        if (observed.result.reason !== undefined) result.reason = observed.result.reason;
        snapshot.result = result;
    }
    return snapshot;
}

// The wire `logical` of an execution snapshot from the recorded S1 facts.
function projectLogical(observed) {
    if (!LOGICAL_KINDS.includes(observed.logicalKind)) fail('state_corrupt');
    if (observed.logicalKind === 'flow') {
        if (typeof observed.bindingId !== 'string' || observed.bindingId.length === 0) fail('state_corrupt');
        return { kind: 'flow', id: observed.bindingId };
    }
    return { kind: observed.logicalKind, id: observed.logicalId };
}

// The recorded acceptance (design A13): the same bytes as the admission reply. `state` is the
// admission state S1 recorded in the admission receipt (`queued` for an execution,
// `pending-coordinator` for an obligation), so lookup never reports live state; live state
// comes from read. Any other value is state_corrupt.
export function projectAcceptance(reference, originRequestId, state) {
    if (!RECORDED_ADMISSION_STATES.includes(state)) fail('state_corrupt');
    return { taskRef: taskRefOf(reference), state, originRequestId };
}

// Parses a JSON object body from the exact raw bytes whose hash the token binds.
export function parseJsonBody(body) {
    if (!Buffer.isBuffer(body) || body.length === 0) fail('invalid_request');
    let value;
    try {
        value = JSON.parse(body.toString('utf8'));
    } catch {
        return fail('invalid_request');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
    return value;
}

// The S1 control request of a body `{operationId, op, attemptId?, payload?}` (design A3):
// unmapped ops are `operation_unavailable`, terminal ops (`input`, `resize`) and anything
// else `invalid_request`. Shapes are left to S1's validation.
export function controlRequestFrom(referenceId, body) {
    exactObject(body, ['operationId', 'op'], ['attemptId', 'payload']);
    if (UNMAPPED_CONTROL_OPS.includes(body.op)) throw new CoordinatorAuthError('operation_unavailable', 'operation_unmapped');
    if (!MAPPED_CONTROL_OPS.includes(body.op)) fail('invalid_request');
    const request = { referenceId, operationId: body.operationId, op: body.op };
    if (body.attemptId !== undefined) request.attemptId = body.attemptId;
    if (body.payload !== undefined) request.payload = body.payload;
    return request;
}

// Runs a mutating operation whose verified token IDs S1 consumes in its own transaction.
// Any refusal after verification burns the IDs first, each in its own transaction (an
// already consumed ID is skipped), so a verified token is consumed even when refused.
export function withDurableReplay(store, verifiedTokens, operation) {
    const items = replayItems(verifiedTokens);
    try {
        return operation({ items });
    } catch (error) {
        for (const item of items) {
            try {
                store.consumeTokenIds({ items: [item] });
            } catch {
                // Already consumed, or the store refused; the original refusal is reported.
            }
        }
        throw error;
    }
}

function canonicalBasePath(value) {
    return typeof value === 'string' && /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(value)
        && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

// `query` '' means after=0, limit=100; otherwise exactly `?after=<n>&limit=<m>` with `after`
// a safe integer and `limit` 1-1000 (design A6, mirroring the Router's grammar).
export function parseEventsQuery(query) {
    if (query === '') return { ...DEFAULT_EVENTS };
    const match = EVENTS_QUERY.exec(query);
    if (!match) fail('invalid_request');
    const after = Number(match[1]);
    const limit = Number(match[2]);
    if (!Number.isSafeInteger(after) || limit < 1 || limit > 1000) fail('invalid_request');
    return { after, limit };
}

// `store`: an open S1 worker state (opened with the S1x extension limits). `basePath`: the
// declared `taskReferences.path`. `verifier`: from `createVerifierConfig`.
export function createTaskReferenceAdapter({ store, workspaceId, verifier, basePath }) {
    for (const method of ['observeReference', 'listReferenceEvents', 'controlReference', 'lookupOrigin', 'consumeTokenIds']) {
        if (!store || typeof store[method] !== 'function') fail('invalid_request');
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) fail('invalid_request');
    if (!canonicalBasePath(basePath)) fail('invalid_request');
    const lookupPath = `${basePath}/lookup`;
    const prefix = `${basePath}/`;

    // `<basePath>/<id>` plus an optional fixed suffix; the reference ID grammar is checked.
    function referenceIdFrom(path, suffix) {
        if (!path.startsWith(prefix) || !path.endsWith(suffix)) fail('invalid_request');
        const referenceId = path.slice(prefix.length, path.length - suffix.length);
        if (!isPublicReferenceId(referenceId)) fail('invalid_request');
        return referenceId;
    }

    return Object.freeze({
        // GET <basePath>/<id>. No query, empty body.
        read(request) {
            const facts = verifyTaskReferenceRequest(verifier, request);
            if (facts.method !== 'GET' || facts.query !== '' || request.body.length !== 0) fail('invalid_request');
            const referenceId = referenceIdFrom(facts.path, '');
            consumeReplay(verifier, [facts]);
            return projectSnapshot(store.observeReference(contextForTaskReferenceCaller(workspaceId, facts, 'read'), { referenceId }));
        },

        // GET <basePath>/<id>/events[?after=<n>&limit=<m>]. Empty body. Returns
        // {events, nextAfter} or {gap: true, snapshotSequence}.
        events(request) {
            const facts = verifyTaskReferenceRequest(verifier, request);
            if (facts.method !== 'GET' || request.body.length !== 0) fail('invalid_request');
            const referenceId = referenceIdFrom(facts.path, '/events');
            const window = parseEventsQuery(facts.query);
            consumeReplay(verifier, [facts]);
            const context = contextForTaskReferenceCaller(workspaceId, facts, 'read');
            return store.listReferenceEvents(context, { referenceId, ...window });
        },

        // POST <basePath>/<id>/control with exactly {operationId, op, attemptId?, payload?}.
        control(request) {
            const facts = verifyTaskReferenceRequest(verifier, request);
            return withDurableReplay(store, [facts], (replay) => {
                if (facts.method !== 'POST' || facts.query !== '') fail('invalid_request');
                const referenceId = referenceIdFrom(facts.path, '/control');
                const controlRequest = controlRequestFrom(referenceId, parseJsonBody(request.body));
                const context = contextForTaskReferenceCaller(workspaceId, facts, 'control');
                return store.controlReference(context, controlRequest, replay);
            });
        },

        // POST <basePath>/lookup with exactly {originRequestId}; the Router-signed
        // `originKey` must be the verified caller's key. Returns the recorded acceptance.
        lookup(request) {
            const facts = verifyTaskReferenceRequest(verifier, request, { lookup: true });
            if (facts.method !== 'POST' || facts.path !== lookupPath || facts.query !== '') fail('invalid_request');
            const body = exactObject(parseJsonBody(request.body), ['originRequestId']);
            if (!isOriginId(body.originRequestId)) fail('invalid_request');
            consumeReplay(verifier, [facts]);
            const context = contextForTaskReferenceCaller(workspaceId, facts, 'lookup');
            const view = store.lookupOrigin(context, { originRequestId: body.originRequestId });
            return projectAcceptance(view.reference, body.originRequestId, view.admissionState);
        }
    });
}

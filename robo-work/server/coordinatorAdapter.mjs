import { TERMINAL_STATES, deriveOperationId, exactObject, fail, isInternalId, isOriginId, isPublicReferenceId } from './stateProtocol.mjs';
import {
    CoordinatorAuthError, bindingKind, consumeReplay, contextForBinding, contextForBindingRead, contextForCoordinatorRead,
    contextForLifecycle, contextForObligationCoordinator, contextForOrigin, contextForOriginObligation, contextForOwner, requireAdmissionBindingId,
    requireBindingId, requireReadBindingId, verifyCoordinatorRequest, verifyOriginToken
} from './coordinatorAuth.mjs';
import { controlRequestFrom, parseJsonBody, projectAcceptance, projectSnapshot, withDurableReplay } from './taskReferenceAdapter.mjs';

// Maps verified coordinator-route requests (interface note 2.3 (4)-(8); design A12) to the
// S1/S1x worker-state API. Every call first verifies the coordinator hop Router Request
// against the received method, path, query and raw body; the S1 context is then built
// only from verified claims (and, for the background row, from the registered binding).
//
// Routes (agent-local, every one POST with an exact JSON body and no query):
//   /v1/coordinator/admissions                 admit
//   /v1/coordinator/lookup                     lookup (recorded acceptance)
//   /v1/coordinator/bindings                   bind
//   /v1/coordinator/references/<id>/read       readReference
//   /v1/coordinator/references/<id>/events     referenceEvents
//   /v1/coordinator/references/<id>/control    controlReference
//   /v1/coordinator/robots/provision|configure|delete|list|get
//   /v1/coordinator/robots/terminals/close     closeTerminals (M-54): an administrator grant ends every open robot terminal of one robot
//                                              through the terminal path's normal shutdown end (cause `shutdown`), then retries configure
//   /v1/coordinator/operations/get
//   /v1/coordinator/obligations                          admitObligation (S6 Part D)
//   /v1/coordinator/obligations/list                     listObligations
//   /v1/coordinator/obligations/<id>/accept|reject|outbox
//
// Obligations (interface note 2.3 (9)): admission on the coordinator-API row (owner grant) or
// the MCP row (origin token, `origin.agent` equal to the hop coordinator); evidence of the
// background row (`bindingId`) is forbidden. Accept, reject and outbox need the admitting
// coordinator alone (a user grant is forbidden; another coordinator's obligation is
// not_found); list is the declared coordinator's own reconciliation read.
//
// Row selection (8), by the evidence present, with no fallback between rows:
//   `taskRefOrigin` in the rch-bound body     -> MCP row
//   verified owner claims (usr + delegation)  -> coordinator-API row
//   `bindingId` in the rch-bound body, no usr -> background row (owner from the binding)
// Any other combination is refused.
//
// Admission kinds (S6 source-only subset, Part A): `task` on every row (the background row
// records flow work), `continuation` on the MCP and coordinator-API rows, and `turn`
// ({sessionKey}, session work) on the coordinator-API row only. Row-selection refusals come
// first; then a `turn` on another row is `invalid_request`, and a `continuation` on the
// background row is `operation_unavailable` (answer-driven flow continuation is P5 work),
// both before any admission state is touched. Binding IDs follow the per-call-site grammar
// of coordinatorAuth.mjs: admission flow_/gen_, reads and lookup flow_/cron_/gen_, `/bindings`
// flow_/cron_.
//
// Replay: mutating routes (admissions, bindings, control, robot provision/configure/delete)
// have their verified token IDs consumed durably by S1 in the operation's transaction and
// burned when refused after verification; read-only routes use the verifier's bounded
// in-memory cache. No body carries an owner, scope, namespace or context; admission and
// lookup bodies carry no operation ID (derived from the verified origin), while lifecycle,
// binding and control bodies carry their caller-chosen `operationId`.

export const COORDINATOR_BASE = '/v1/coordinator';
const REFERENCE_PREFIX = `${COORDINATOR_BASE}/references/`;
const ADMIT_REQUIRED = ['originRequestId', 'robotId', 'configRevision', 'kind', 'specification'];
const ADMIT_OPTIONAL = ['logical', 'taskRefOrigin', 'originTool', 'bindingId'];
const OBLIGATION_PREFIX = `${COORDINATOR_BASE}/obligations/`;

function refuse(code, reason) {
    throw new CoordinatorAuthError(code, reason);
}

// `request`: {authInfo, method, path, query, body} as received by the provider: `authInfo`
// is the trusted `x-ploinky-auth-info` value, `query` the received `search` ('' or '?...'),
// `body` the raw bytes. `store` must be opened with the S1x extension limits.
// `terminals` (optional): the worker's terminal path, `{ closeRobot(robotId) -> Promise<{ closed, unverified }> }`. Without it the
// Close terminals route is operation_unavailable.
export function createCoordinatorAdapter({ store, workspaceId, verifier, terminals = null }) {
    for (const method of ['admit', 'lookupOrigin', 'registerBinding', 'readBindingOwner', 'observeReference', 'listReferenceEvents',
        'controlReference', 'consumeTokenIds', 'beginProvision', 'configure', 'beginDelete', 'listRobots', 'getRobot', 'getOperationOutcome',
        'admitObligation', 'acceptObligation', 'rejectObligation', 'listObligations', 'applyOutbox']) {
        if (!store || typeof store[method] !== 'function') fail('invalid_request');
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) fail('invalid_request');

    // Every coordinator route is POST, without a query, at exactly its path.
    function requireRoute(hop, path) {
        if (hop.method !== 'POST' || hop.query !== '' || hop.path !== path) fail('invalid_request');
    }

    function referenceIdFrom(hop, suffix) {
        if (hop.method !== 'POST' || hop.query !== '' || !hop.path.startsWith(REFERENCE_PREFIX) || !hop.path.endsWith(suffix)) fail('invalid_request');
        const referenceId = hop.path.slice(REFERENCE_PREFIX.length, hop.path.length - suffix.length);
        if (!isPublicReferenceId(referenceId)) fail('invalid_request');
        return referenceId;
    }

    // `<base>/obligations/<id><suffix>`. The obligation ID is the observation reference ID
    // (`taskRef.id`) in the exact S1 form: 22 canonical base64url characters (16 bytes).
    function obligationIdFrom(hop, suffix) {
        if (hop.method !== 'POST' || hop.query !== '' || !hop.path.startsWith(OBLIGATION_PREFIX) || !hop.path.endsWith(suffix)) fail('invalid_request');
        const obligationId = hop.path.slice(OBLIGATION_PREFIX.length, hop.path.length - suffix.length);
        if (!isInternalId(obligationId)) fail('invalid_request');
        return obligationId;
    }

    // A mutating obligation route of the coordinator alone: accept, reject, outbox.
    function coordinatorAlone(request, suffix, operation, required, call) {
        const hop = verifyCoordinatorRequest(verifier, request);
        return withDurableReplay(store, [hop], (replay) => {
            const obligationId = obligationIdFrom(hop, suffix);
            const body = exactObject(parseJsonBody(request.body), required);
            return call(contextForObligationCoordinator(workspaceId, hop, operation), obligationId, body, replay);
        });
    }

    // The registered owner of a background binding under this coordinator.
    function bindingOwner(hop, bindingId) {
        return store.readBindingOwner({ coordinator: hop.coordinator, bindingId }).ownerId;
    }

    // Read-only observation context: a grant (owner or administrator rule) or the
    // coordinator alone with the `bindingId` the reference was admitted under (origin row).
    function observerContext(hop, bindingId, operation) {
        if (hop.owner) {
            if (bindingId !== undefined) refuse('forbidden', 'row_ambiguous');
            return contextForOwner(workspaceId, hop, operation);
        }
        if (bindingId === undefined) refuse('forbidden', 'row_missing');
        return contextForBindingRead(workspaceId, hop, requireReadBindingId(bindingId), operation);
    }

    // Robot lifecycle: an administrator grant in the coordinator lifecycle scope.
    function lifecycle(request, path, operation, required, call) {
        const hop = verifyCoordinatorRequest(verifier, request);
        return withDurableReplay(store, [hop], (replay) => {
            requireRoute(hop, path);
            const body = exactObject(parseJsonBody(request.body), required);
            return call(contextForLifecycle(workspaceId, hop, operation), body, replay);
        });
    }

    // Read-only robot and operation reads: the declared coordinator, alone or with a grant.
    function coordinatorRead(request, path, required, call) {
        const hop = verifyCoordinatorRequest(verifier, request);
        requireRoute(hop, path);
        const body = exactObject(parseJsonBody(request.body), required);
        consumeReplay(verifier, [hop]);
        return call(contextForCoordinatorRead(workspaceId, hop), body);
    }

    return Object.freeze({
        admit(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            const verified = [hop];
            let origin = null;
            let body;
            try {
                requireRoute(hop, `${COORDINATOR_BASE}/admissions`);
                body = exactObject(parseJsonBody(request.body), ADMIT_REQUIRED, ADMIT_OPTIONAL);
                if (!isOriginId(body.originRequestId)) fail('invalid_request');
                if (body.taskRefOrigin !== undefined || body.originTool !== undefined) {
                    // MCP row: the Router origin token, verified in addition to the hop token.
                    if (hop.owner || body.bindingId !== undefined) refuse('forbidden', 'row_ambiguous');
                    if (typeof body.taskRefOrigin !== 'string' || typeof body.originTool !== 'string') refuse('unauthorized', 'origin_claims');
                    origin = verifyOriginToken(verifier, body.taskRefOrigin);
                    verified.push(origin);
                }
            } catch (error) {
                // Refused after the hop token verified: burn it (and nothing unverified).
                return withDurableReplay(store, [hop], () => { throw error; });
            }
            return withDurableReplay(store, verified, (replay) => {
                let context;
                let row;
                if (origin) {
                    if (origin.agent !== hop.coordinator) refuse('forbidden', 'origin_agent');
                    if (origin.originRequestId !== body.originRequestId || origin.tool !== body.originTool) refuse('forbidden', 'origin_binding');
                    context = contextForOrigin(workspaceId, origin, 'admit');
                    row = 'mcp';
                } else if (hop.owner) {
                    if (body.bindingId !== undefined) refuse('forbidden', 'row_ambiguous');
                    context = contextForOwner(workspaceId, hop, 'admit');
                    row = 'owner';
                } else if (body.bindingId !== undefined) {
                    const bindingId = requireAdmissionBindingId(body.bindingId);
                    context = contextForBinding(workspaceId, hop, bindingId, bindingOwner(hop, bindingId), 'admit');
                    row = 'background';
                } else {
                    refuse('forbidden', 'row_missing');
                }
                // After row selection, before the store: session work only on the coordinator-API row.
                if (body.kind === 'turn' && row !== 'owner') fail('invalid_request');
                if (body.kind === 'continuation' && row === 'background') refuse('operation_unavailable', 'operation_unmapped');
                const admitted = store.admit(context, {
                    operationId: deriveOperationId(context, body.originRequestId),
                    originRequestId: body.originRequestId,
                    robotId: body.robotId,
                    configRevision: body.configRevision,
                    kind: body.kind,
                    logical: body.logical === undefined ? {} : body.logical,
                    specification: body.specification
                }, replay);
                return projectAcceptance(admitted.reference, body.originRequestId, admitted.admissionState);
            });
        },

        // Coordinator lookup: coordinator-API row (the asking user's grant) or background row
        // (coordinator plus `bindingId`). MCP origins are recovered through `/task-refs`.
        lookup(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            requireRoute(hop, `${COORDINATOR_BASE}/lookup`);
            const body = exactObject(parseJsonBody(request.body), ['originRequestId'], ['bindingId']);
            if (!isOriginId(body.originRequestId)) fail('invalid_request');
            const context = observerContext(hop, body.bindingId, 'lookup');
            consumeReplay(verifier, [hop]);
            const view = store.lookupOrigin(context, { originRequestId: body.originRequestId });
            return projectAcceptance(view.reference, body.originRequestId, view.admissionState);
        },

        // Root binding: needs the owner grant. Derived binding: coordinator alone with
        // `parentBindingId`, owner read from the parent. The kind follows the ID prefix.
        bind(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            return withDurableReplay(store, [hop], (replay) => {
                requireRoute(hop, `${COORDINATOR_BASE}/bindings`);
                const body = exactObject(parseJsonBody(request.body), ['operationId', 'bindingId'], ['parentBindingId']);
                const bindingId = requireBindingId(body.bindingId);
                const registration = { operationId: body.operationId, bindingId, kind: bindingKind(bindingId) };
                if (body.parentBindingId === undefined) {
                    if (!hop.owner) refuse('forbidden', 'owner_evidence');
                    return store.registerBinding(contextForOwner(workspaceId, hop, 'bind'), registration, replay);
                }
                if (hop.owner) refuse('forbidden', 'row_ambiguous');
                const parentBindingId = requireBindingId(body.parentBindingId);
                const context = contextForBinding(workspaceId, hop, parentBindingId, bindingOwner(hop, parentBindingId), 'bind');
                return store.registerBinding(context, { ...registration, parentBindingId }, replay);
            });
        },

        readReference(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            const referenceId = referenceIdFrom(hop, '/read');
            const body = exactObject(parseJsonBody(request.body), [], ['bindingId']);
            const context = observerContext(hop, body.bindingId, 'read');
            consumeReplay(verifier, [hop]);
            return projectSnapshot(store.observeReference(context, { referenceId }));
        },

        // Returns {events, nextAfter} or {gap: true, snapshotSequence}. With `stream: true` (`limit` then optional, default 100) the
        // grant is verified once, here, and the result is `{follow}`: a subscription bound to the authorized context for its lifetime
        // (M-12). The HTTP layer streams it as NDJSON; reopening needs a fresh grant. In a stream the terminal state row also carries
        // the result, so the subscriber needs no extra read: data.result {outputText, data}, data.classification, data.reason?.
        referenceEvents(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            const referenceId = referenceIdFrom(hop, '/events');
            const body = exactObject(parseJsonBody(request.body), ['after'], ['limit', 'bindingId', 'stream']);
            if (body.stream !== undefined && body.stream !== true) fail('invalid_request');
            if (body.stream !== true && body.limit === undefined) fail('invalid_request');
            const context = observerContext(hop, body.bindingId, 'read');
            consumeReplay(verifier, [hop]);
            const limit = body.limit ?? 100;
            const page = (after) => store.listReferenceEvents(context, { referenceId, after, limit });
            if (body.stream !== true) return page(body.after);
            // The first page also checks visibility and `after` now, so a refusal is an ordinary response and not a stream.
            const first = page(body.after);
            const terminalRow = (event) => {
                if (event.type !== 'state' || !TERMINAL_STATES.includes(event.data.state)) return event;
                const { result } = store.observeReference(context, { referenceId });
                if (!result) return event;
                const data = { ...event.data, result: { outputText: result.outputText, data: result.data }, classification: result.classification ?? result.status };
                if (result.reason !== undefined) data.reason = result.reason;
                return { ...event, data };
            };
            const decorate = (value) => (value.events ? { ...value, events: value.events.map(terminalRow) } : value);
            return {
                follow: {
                    first: decorate(first), page: (after) => decorate(page(after)),
                    // The reference reached a terminal state: `sequence` is the last event written for it.
                    finished: () => {
                        const snapshot = store.observeReference(context, { referenceId });
                        return TERMINAL_STATES.includes(snapshot.state) ? snapshot.sequence : null;
                    }
                }
            };
        },

        // User controls (stop, message) need the acting user's grant, fresh for each control (M-12). The background row is the
        // coordinator alone with the `bindingId` the reference was admitted under: it may stop its own flow work, and nothing
        // else (S1 refuses its message, and an interactive reference is not visible to it).
        controlReference(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            return withDurableReplay(store, [hop], (replay) => {
                const referenceId = referenceIdFrom(hop, '/control');
                const { bindingId, ...rest } = parseJsonBody(request.body);
                const controlRequest = controlRequestFrom(referenceId, rest);
                if (hop.owner) {
                    if (bindingId !== undefined) refuse('forbidden', 'row_ambiguous');
                    return store.controlReference(contextForOwner(workspaceId, hop, 'control'), controlRequest, replay);
                }
                if (bindingId === undefined) refuse('forbidden', 'owner_evidence');
                return store.controlReference(contextForBindingRead(workspaceId, hop, requireReadBindingId(bindingId), 'control'), controlRequest, replay);
            });
        },

        // Obligation admission: coordinator-API or MCP row; the background row is forbidden.
        admitObligation(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            const verified = [hop];
            let origin = null;
            let body;
            try {
                requireRoute(hop, `${COORDINATOR_BASE}/obligations`);
                body = exactObject(parseJsonBody(request.body), ['originRequestId', 'obligationKind', 'request'],
                    ['continuationOf', 'taskRefOrigin', 'originTool', 'bindingId']);
                if (!isOriginId(body.originRequestId)) fail('invalid_request');
                if (body.taskRefOrigin !== undefined || body.originTool !== undefined) {
                    if (hop.owner || body.bindingId !== undefined) refuse('forbidden', 'row_ambiguous');
                    if (typeof body.taskRefOrigin !== 'string' || typeof body.originTool !== 'string') refuse('unauthorized', 'origin_claims');
                    origin = verifyOriginToken(verifier, body.taskRefOrigin);
                    verified.push(origin);
                }
            } catch (error) {
                return withDurableReplay(store, [hop], () => { throw error; });
            }
            return withDurableReplay(store, verified, (replay) => {
                let context;
                if (origin) {
                    if (origin.originRequestId !== body.originRequestId || origin.tool !== body.originTool) refuse('forbidden', 'origin_binding');
                    context = contextForOriginObligation(workspaceId, origin, hop, 'obligate');
                } else if (body.bindingId !== undefined) {
                    refuse('forbidden', hop.owner ? 'row_ambiguous' : 'binding');
                } else if (hop.owner) {
                    context = contextForOwner(workspaceId, hop, 'obligate');
                } else {
                    refuse('forbidden', 'row_missing');
                }
                const obligationRequest = {
                    operationId: deriveOperationId(context, body.originRequestId), originRequestId: body.originRequestId,
                    obligationKind: body.obligationKind, request: body.request
                };
                if (body.continuationOf !== undefined) obligationRequest.continuationOf = body.continuationOf;
                const admitted = store.admitObligation(context, obligationRequest, replay);
                return projectAcceptance(admitted.reference, body.originRequestId, admitted.admissionState);
            });
        },

        acceptObligation(request) {
            return coordinatorAlone(request, '/accept', 'decide', ['operationId', 'domainRecordId'], (context, obligationId, body, replay) => {
                const { type, operationId, ...reply } = store.acceptObligation(context, { operationId: body.operationId, obligationId, domainRecordId: body.domainRecordId }, replay);
                void type; void operationId;
                return reply;
            });
        },

        rejectObligation(request) {
            return coordinatorAlone(request, '/reject', 'decide', ['operationId', 'reason'], (context, obligationId, body, replay) => {
                const { type, operationId, ...reply } = store.rejectObligation(context, { operationId: body.operationId, obligationId, reason: body.reason }, replay);
                void type; void operationId;
                return reply;
            });
        },

        applyOutbox(request) {
            return coordinatorAlone(request, '/outbox', 'reconcile', ['revision', 'fenceRevision', 'kind', 'data'], (context, obligationId, body, replay) =>
                store.applyOutbox(context, { obligationId, ...body }, replay));
        },

        // Read-only reconciliation list of the declared coordinator's own obligations.
        listObligations(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            requireRoute(hop, `${COORDINATOR_BASE}/obligations/list`);
            const body = exactObject(parseJsonBody(request.body), ['state', 'unbound', 'after', 'limit']);
            const context = contextForObligationCoordinator(workspaceId, hop, 'reconcile');
            consumeReplay(verifier, [hop]);
            return store.listObligations(context, body);
        },

        provision(request) {
            return lifecycle(request, `${COORDINATOR_BASE}/robots/provision`, 'provision', ['operationId', 'name', 'configuration'],
                (context, body, replay) => store.beginProvision(context, body, replay));
        },

        configure(request) {
            return lifecycle(request, `${COORDINATOR_BASE}/robots/configure`, 'configure', ['operationId', 'robotId', 'expectedRevision', 'configuration'],
                (context, body, replay) => store.configure(context, body, replay));
        },

        delete(request) {
            return lifecycle(request, `${COORDINATOR_BASE}/robots/delete`, 'delete', ['operationId', 'robotId', 'expectedRevision'],
                (context, body, replay) => store.beginDelete(context, body, replay));
        },

        listRobots(request) {
            return coordinatorRead(request, `${COORDINATOR_BASE}/robots/list`, [], (context) => ({ robots: store.listRobots(context) }));
        },

        getRobot(request) {
            return coordinatorRead(request, `${COORDINATOR_BASE}/robots/get`, ['robotId'], (context, body) => store.getRobot(context, body));
        },

        // M-54 Close terminals: the lifecycle administrator rule (verified direct administrator grant). The token ID is consumed durably
        // first, so a replay is refused; the robot must be a workspace robot the store knows (not_found otherwise). Each terminal of the
        // robot ends through the normal end path; the answer counts them (`unverified`: ends whose termination could not be proven,
        // which leave the robot nonready with resource_quarantined). Nothing else is changed.
        async closeTerminals(request) {
            const hop = verifyCoordinatorRequest(verifier, request);
            const body = withDurableReplay(store, [hop], (replay) => {
                store.consumeTokenIds(replay);
                requireRoute(hop, `${COORDINATOR_BASE}/robots/terminals/close`);
                const parsed = exactObject(parseJsonBody(request.body), ['robotId']);
                if (!isInternalId(parsed.robotId)) fail('invalid_request');
                // The administrator rule of every lifecycle call (refuses a missing grant, a non-administrator and a guest).
                contextForLifecycle(workspaceId, hop, 'configure');
                store.getRobot(contextForCoordinatorRead(workspaceId, hop), { robotId: parsed.robotId });
                return parsed;
            });
            if (!terminals || typeof terminals.closeRobot !== 'function') refuse('operation_unavailable', 'operation_unmapped');
            const outcome = await terminals.closeRobot(body.robotId);
            return { robotId: body.robotId, closed: outcome.closed, unverified: outcome.unverified };
        },

        getOperation(request) {
            return coordinatorRead(request, `${COORDINATOR_BASE}/operations/get`, ['operationId'], (context, body) => store.getOperationOutcome(context, body));
        }
    });
}

import {
    ACTIVE_STATES, LOGICAL_KINDS, PROCESS_TREE_KIND, REFERENCE_VERSION, TERMINAL_STATES, WorkerStateError, byteLength, canonicalJson,
    isPublicReferenceId, deriveFlowLogicalId, deriveOperationId, digest, exactObject, fail, hasOriginRow, isOriginId, randomId, requireContext,
    robotOwnerOf,
    validateAdmissionRequest, validateAttemptOutcome, validateConfiguration, validateInternalId, validateLimits, validateName,
    validateOperationId, validateRevision, validateSpecification, isInternalId
} from './stateProtocol.mjs';
import { openStorage } from './stateDatabase.mjs';
import {
    COMMITTED, QUARANTINED, RELEASED, RELEASED_BY_OPERATOR, RESERVED, clearBlocker, commitBlocker, degradedKinds,
    findByLocator, getBlocker, hasRetainedForRobot, publicBlocker, quarantinedForAttempt, quarantinedForRobot, recordClearAudit,
    reserveBlocker, retainBlocker, settleBlocker, unsettledForAttempt, unsettledForRobot, unsettledOfPriorGenerations
} from './stateBlockers.mjs';
import { runtimeUnavailable, validateRuntimeAdapter } from './runtimeUnavailable.mjs';
import {
    BINDING_KINDS, BINDING_MAX_DEPTH, GENERATION_PREFIX, bindingFamily, bindingOf, coordinatorOf, countBindings, getBinding, insertBinding,
    isActiveBinding, isBindingId, isOwnerKey, moveBinding
} from './stateBindings.mjs';
import {
    CONTROL_OPS, EVENTS_MAX_LIMIT, appendOutputEvents, appendStateEvent, countControls, getControl, hasPendingStop, insertControl, insertFenceStop,
    listEvents, listPendingControls, markControlApplied, readCursor, referenceForExecution
} from './stateObservation.mjs';
import {
    CANCELLED_RESULT, COORDINATOR_REASON_PREFIX, EXPIRED_RESULT, FENCE_CHANGED, OBLIGATION_KINDS, OUTBOX_KINDS, PAUSED_RESULT, REJECTED_RESULT,
    countObligations, countOutboxRevisions, decideObligation, getObligation, getOutboxRevision, insertObligation, insertOutboxRevision,
    markRevisionApplied, namedBindingId, observationView, wasAccepted
} from './stateObligations.mjs';
import { consumeKeys, validateReplay } from './stateReplay.mjs';
import { getSession, insertSession } from './stateSessions.mjs';

export { WorkerStateError, createVerifiedContext, createVerifiedCoordinatorContext, createVerifiedServiceContext } from './stateProtocol.mjs';
export { runtimeUnavailable } from './runtimeUnavailable.mjs';

const PROVIDER_REFERENCE_VERSION = REFERENCE_VERSION;
// The recorded admission state of an execution (design A13): lookup returns it, never live state.
const EXECUTION_ADMISSION_STATE = 'queued';
// The recorded admission state of an obligation (S3b A13 pin; S6 Part D).
const OBLIGATION_ADMISSION_STATE = 'pending-coordinator';
const FLOW_ID = /^flow_[0-9a-f]{24}$/;
const GENERATION_ID = /^gen_[0-9a-f]{24}$/;
const REJECT_REASON = /^[a-z][a-z0-9_]{0,63}$/;

// Coordinator-API row: `coordinator:<p>` / `owner:user:<id>`.
function isOwnerRow(context) {
    return coordinatorOf(context.originNamespace) !== null && isOwnerKey(context.originKey);
}

// Background row: `coordinator:<p>` / `binding:<id>`.
function isBindingRow(context) {
    return coordinatorOf(context.originNamespace) !== null && typeof context.originKey === 'string' && context.originKey.startsWith('binding:');
}

function taskRefOfRow(reference) {
    return { version: reference.version, provider: reference.provider, id: reference.id };
}

function nonEmptyString(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail('invalid_request');
    return value;
}

function validateFaults(faults) {
    if (faults === undefined) return {};
    exactObject(faults, [], ['beforeCommit', 'afterCommit', 'afterPragmas']);
    for (const key of Object.keys(faults)) {
        if (typeof faults[key] !== 'function') fail('invalid_request');
    }
    return faults;
}

// Opens the supervisor-private worker-state store. `faults` (beforeCommit/afterCommit
// callbacks taking a transaction label, afterPragmas taking the connection) is an opt-in
// TEST-ONLY surface.
export function openWorkerState(options) {
    exactObject(options, ['dataDir', 'workspaceId', 'provider', 'limits'], ['now', 'create', 'runtime', 'faults']);
    nonEmptyString(options.workspaceId);
    nonEmptyString(options.provider);
    const limits = validateLimits(options.limits);
    const now = options.now === undefined ? Date.now : options.now;
    if (typeof now !== 'function') fail('invalid_request');
    if (options.create !== undefined && typeof options.create !== 'boolean') fail('invalid_request');
    const runtime = options.runtime === undefined ? runtimeUnavailable : options.runtime;
    if (!validateRuntimeAdapter(runtime)) fail('invalid_request');
    const faults = validateFaults(options.faults);
    const timestamp = () => {
        const value = now();
        if (!Number.isSafeInteger(value) || value < 0) fail('state_corrupt');
        return value;
    };
    const { state, generationId } = openStorage({
        dataDir: options.dataDir, workspaceId: options.workspaceId, provider: options.provider,
        create: options.create === true, now: timestamp, faults
    });
    return new WorkerState({ state, generationId, workspaceId: options.workspaceId, provider: options.provider, limits, now: timestamp, runtime });
}

class WorkerState {
    #state;
    #generationId;
    #workspaceId;
    #provider;
    #limits;
    #now;
    #runtime;

    constructor({ state, generationId, workspaceId, provider, limits, now, runtime }) {
        this.#state = state;
        this.#generationId = generationId;
        this.#workspaceId = workspaceId;
        this.#provider = provider;
        this.#limits = limits;
        this.#now = now;
        this.#runtime = runtime;
    }

    // The generation this writer handle is bound to. It never refreshes itself.
    get generationId() { return this.#generationId; }

    close() { this.#state.close(); }

    #fence(db) {
        const row = db.prepare("SELECT id, recovery_pending FROM generation WHERE state = 'active'").get();
        if (!row || row.id !== this.#generationId) fail('stale_generation');
        return row;
    }

    #mutate(label, operation) {
        return this.#state.transaction(label, (db) => operation(db, this.#fence(db)));
    }

    #findReceipt(db, context, operationId, type, requestDigest) {
        const receipt = db.prepare('SELECT * FROM receipt WHERE scope = ? AND operation_id = ?').get(context.scope, operationId);
        if (!receipt) return null;
        if (receipt.op_type !== type || receipt.digest !== requestDigest) fail('operation_conflict');
        return JSON.parse(receipt.response);
    }

    #checkCapacity(db, table, limit) {
        const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
        if (count >= limit) fail('capacity_exceeded');
    }

    #recordReceipt(db, context, { operationId, type, robotId, requestDigest, response }) {
        this.#checkCapacity(db, 'receipt', this.#limits.receipts);
        db.prepare('INSERT INTO receipt (scope, operation_id, op_type, robot_id, digest, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(context.scope, operationId, type, robotId, requestDigest, canonicalJson(response), this.#now());
        return JSON.parse(canonicalJson(response));
    }

    // Robot rows are compared against `robotOwnerId` when the context carries one (S1x
    // workspace robots), otherwise against `ownerId`.
    #ownedRobot(db, context, robotId) {
        const robot = db.prepare('SELECT * FROM robot WHERE id = ?').get(robotId);
        if (!robot || robot.owner_id !== robotOwnerOf(context) || robot.lifecycle === 'deleted') fail('not_found');
        return robot;
    }

    // A configured extension limit, or capacity_exceeded when the store was opened without it.
    #extensionLimit(key) {
        const limit = this.#limits[key];
        if (limit === undefined) fail('capacity_exceeded');
        return limit;
    }

    // Consumes a mutating request's verified token IDs inside its own write transaction,
    // before anything else, so they commit or roll back together with the operation.
    #consume(db, items) {
        if (items !== null) consumeKeys(db, items, this.#now(), this.#limits.tokenReplayEntries);
    }

    // S1x: burns verified token IDs of a refused mutating request in a separate transaction,
    // so a verified token is consumed even when its operation was refused. `replay` has the
    // same shape as the optional `replay` argument of the mutating methods.
    consumeTokenIds(replay) {
        const items = validateReplay(replay);
        if (items === null) fail('invalid_request');
        return this.#mutate('consumeTokenIds', (db) => {
            this.#consume(db, items);
            return { consumed: items.length };
        });
    }

    #hasPreparation(db, robotId) {
        return db.prepare('SELECT 1 AS found FROM preparation WHERE robot_id = ?').get(robotId) !== undefined;
    }

    #hasActiveWork(db, robotId) {
        return db.prepare("SELECT 1 AS found FROM admission WHERE robot_id = ? AND state IN ('queued', 'running', 'stopping') LIMIT 1").get(robotId) !== undefined;
    }

    #openPreparation(db, context, generation, { operationId, robotId, kind, baseRevision, candidate }) {
        const resourceId = randomId();
        const now = this.#now();
        reserveBlocker(db, {
            resourceId, robotId, generationId: generation.id, kind: 'preparation',
            locator: canonicalJson({ preparation: resourceId }), locatorBase: canonicalJson({ preparation: resourceId }), now
        });
        db.prepare(`INSERT INTO preparation (robot_id, scope, operation_id, kind, base_revision, candidate, generation_id, resource_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
            .run(robotId, context.scope, operationId, kind, baseRevision, canonicalJson(candidate), generation.id, resourceId);
        db.prepare("INSERT INTO completion (scope, operation_id, op_type, robot_id, status, reason, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?)")
            .run(context.scope, operationId, kind, robotId, now);
    }

    // Adapter calls fail closed: a throw or a malformed result is runtime_unavailable and never
    // surfaces the adapter's own message.
    #adapter(call) {
        try {
            return call();
        } catch {
            return fail('runtime_unavailable');
        }
    }

    #canPrepare() {
        return this.#adapter(() => this.#runtime.canPrepare()) === true;
    }

    #isReady(db, robot, generation, preparing) {
        return robot.lifecycle === 'ready' && robot.uncertain === 0 && robot.attested_generation === generation.id
            && !preparing && generation.recovery_pending === 0 && quarantinedForRobot(db, robot.id).length === 0;
    }

    // A quarantined worker-scoped resource refuses only operations that require its kind.
    #gateKinds(db, operation) {
        if (this.#runtime.requiredKinds === undefined) return;
        const required = this.#adapter(() => this.#runtime.requiredKinds(operation));
        if (!Array.isArray(required) || !required.every((kind) => typeof kind === 'string')) fail('runtime_unavailable');
        if (required.length === 0) return;
        const degraded = degradedKinds(db);
        if (required.some((kind) => degraded.includes(kind))) fail('resource_quarantined');
    }

    #refuseQuarantinedRobot(db, robotId) {
        if (quarantinedForRobot(db, robotId).length > 0) fail('resource_quarantined');
    }

    // ---- Lifecycle -------------------------------------------------------------

    beginProvision(context, request, replay) {
        requireContext(context, this.#workspaceId, 'provision');
        const items = validateReplay(replay);
        exactObject(request, ['operationId', 'name', 'configuration']);
        const operationId = validateOperationId(request.operationId);
        const name = validateName(request.name);
        const configuration = validateConfiguration(request.configuration, this.#limits);
        const requestDigest = digest({ type: 'provision', ownerId: context.ownerId, name, configuration });
        return this.#mutate('beginProvision', (db, generation) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'provision', requestDigest);
            if (existing) return existing;
            if (!this.#canPrepare()) fail('runtime_unavailable');
            if (generation.recovery_pending) fail('recovery_pending');
            this.#gateKinds(db, 'provision');
            this.#checkCapacity(db, 'robot', this.#limits.robots);
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const robotId = randomId();
            const now = this.#now();
            db.prepare("INSERT INTO robot (id, name, lifecycle, revision, configuration, owner_id, uncertain, attested_generation, created_at, updated_at) VALUES (?, ?, 'provisioning', 0, NULL, ?, 0, NULL, ?, ?)")
                .run(robotId, name, robotOwnerOf(context), now, now);
            this.#openPreparation(db, context, generation, { operationId, robotId, kind: 'provision', baseRevision: 0, candidate: configuration });
            const response = { operationId, type: 'provision', robotId, status: 'accepted' };
            return this.#recordReceipt(db, context, { operationId, type: 'provision', robotId, requestDigest, response });
        });
    }

    configure(context, request, replay) {
        requireContext(context, this.#workspaceId, 'configure');
        const items = validateReplay(replay);
        exactObject(request, ['operationId', 'robotId', 'expectedRevision', 'configuration']);
        const operationId = validateOperationId(request.operationId);
        const robotId = validateInternalId(request.robotId);
        const expectedRevision = validateRevision(request.expectedRevision);
        const configuration = validateConfiguration(request.configuration, this.#limits);
        const requestDigest = digest({ type: 'configure', ownerId: context.ownerId, robotId, expectedRevision, configuration });
        return this.#mutate('configure', (db, generation) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'configure', requestDigest);
            if (existing) return existing;
            if (!this.#canPrepare()) fail('runtime_unavailable');
            const robot = this.#ownedRobot(db, context, robotId);
            if (generation.recovery_pending) fail('recovery_pending');
            this.#refuseQuarantinedRobot(db, robotId);
            this.#gateKinds(db, 'configure');
            if (robot.lifecycle !== 'ready' && robot.lifecycle !== 'failed') fail('robot_busy');
            if (this.#hasPreparation(db, robotId)) fail('robot_busy');
            if (robot.revision !== expectedRevision) fail('revision_conflict');
            const current = robot.configuration === null ? null : JSON.parse(robot.configuration);
            if (current && current.backend !== configuration.backend
                && (this.#hasActiveWork(db, robotId) || hasRetainedForRobot(db, robotId))) {
                fail('robot_busy');
            }
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            this.#openPreparation(db, context, generation, { operationId, robotId, kind: 'configure', baseRevision: robot.revision, candidate: configuration });
            const response = { operationId, type: 'configure', robotId, baseRevision: robot.revision, status: 'accepted' };
            return this.#recordReceipt(db, context, { operationId, type: 'configure', robotId, requestDigest, response });
        });
    }

    beginDelete(context, request, replay) {
        requireContext(context, this.#workspaceId, 'delete');
        const items = validateReplay(replay);
        exactObject(request, ['operationId', 'robotId', 'expectedRevision']);
        const operationId = validateOperationId(request.operationId);
        const robotId = validateInternalId(request.robotId);
        const expectedRevision = validateRevision(request.expectedRevision);
        const requestDigest = digest({ type: 'delete', ownerId: context.ownerId, robotId, expectedRevision });
        return this.#mutate('beginDelete', (db) => {
            this.#consume(db, items);
            // A retry replays the recorded receipt before current lifecycle is consulted.
            const existing = this.#findReceipt(db, context, operationId, 'delete', requestDigest);
            if (existing) return existing;
            const robot = this.#ownedRobot(db, context, robotId);
            if (robot.lifecycle === 'deleting') fail('robot_busy');
            if (robot.revision !== expectedRevision) fail('revision_conflict');
            if (this.#hasActiveWork(db, robotId) || hasRetainedForRobot(db, robotId)) fail('robot_busy');
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const now = this.#now();
            db.prepare("UPDATE robot SET lifecycle = 'deleting', attested_generation = NULL, delete_scope = ?, delete_operation_id = ?, updated_at = ? WHERE id = ?")
                .run(context.scope, operationId, now, robotId);
            db.prepare("UPDATE preparation SET status = 'cancelling' WHERE robot_id = ?").run(robotId);
            db.prepare("INSERT INTO completion (scope, operation_id, op_type, robot_id, status, reason, updated_at) VALUES (?, ?, 'delete', ?, 'pending', NULL, ?)")
                .run(context.scope, operationId, robotId, now);
            const response = { operationId, type: 'delete', robotId, baseRevision: robot.revision, status: 'accepted' };
            return this.#recordReceipt(db, context, { operationId, type: 'delete', robotId, requestDigest, response });
        });
    }

    // Trusted-adapter completion of a provision/configure intent.
    completePreparation(context, request) {
        requireContext(context, this.#workspaceId, 'adapter_complete');
        exactObject(request, ['operationId', 'outcome'], ['effects']);
        const operationId = validateOperationId(request.operationId);
        if (request.outcome !== 'succeeded' && request.outcome !== 'failed') fail('invalid_request');
        if (request.effects !== undefined && (request.outcome !== 'failed' || (request.effects !== 'none' && request.effects !== 'unknown'))) {
            fail('invalid_request');
        }
        const outcome = request.outcome;
        return this.#mutate('completePreparation', (db, generation) => {
            const completion = db.prepare('SELECT * FROM completion WHERE scope = ? AND operation_id = ?').get(context.scope, operationId);
            if (!completion || (completion.op_type !== 'provision' && completion.op_type !== 'configure')) fail('not_found');
            if (completion.status !== 'pending') {
                if (completion.status === 'interrupted') fail('stale_generation');
                if (completion.status === outcome) return this.#completionView(completion);
                fail('operation_conflict');
            }
            const prep = db.prepare('SELECT * FROM preparation WHERE robot_id = ?').get(completion.robot_id);
            if (!prep || prep.operation_id !== operationId || prep.scope !== context.scope) fail('stale_generation');
            if (prep.generation_id !== generation.id) fail('stale_generation');
            const robot = db.prepare('SELECT * FROM robot WHERE id = ?').get(completion.robot_id);
            const now = this.#now();
            const settle = (status, reason) => {
                db.prepare('UPDATE completion SET status = ?, reason = ?, updated_at = ? WHERE scope = ? AND operation_id = ?')
                    .run(status, reason, now, context.scope, operationId);
                db.prepare('DELETE FROM preparation WHERE robot_id = ?').run(robot.id);
                settleBlocker(db, prep.resource_id, RELEASED, now);
                return this.#completionView(db.prepare('SELECT * FROM completion WHERE scope = ? AND operation_id = ?').get(context.scope, operationId));
            };
            if (robot.lifecycle === 'deleting' || robot.lifecycle === 'deleted' || prep.status === 'cancelling') {
                // A delayed completion cannot revive a deleting robot.
                return settle('failed', 'robot_deleting');
            }
            if (robot.revision !== prep.base_revision) fail('revision_conflict');
            const candidate = JSON.parse(prep.candidate);
            if (outcome === 'succeeded') {
                const attested = this.#adapter(() => this.#runtime.attestRobot({
                    generationId: generation.id, robotId: robot.id, operationId, configuration: candidate
                }));
                if (attested !== true) fail('runtime_unavailable');
                db.prepare("UPDATE robot SET lifecycle = 'ready', revision = ?, configuration = ?, uncertain = 0, attested_generation = ?, updated_at = ? WHERE id = ?")
                    .run(prep.base_revision + 1, canonicalJson(candidate), generation.id, now, robot.id);
                return settle('succeeded', null);
            }
            if (prep.kind === 'provision') {
                db.prepare("UPDATE robot SET lifecycle = 'failed', uncertain = ?, attested_generation = NULL, updated_at = ? WHERE id = ?")
                    .run(request.effects === 'none' ? 0 : 1, now, robot.id);
            } else {
                db.prepare('UPDATE robot SET uncertain = ?, attested_generation = NULL, updated_at = ? WHERE id = ?')
                    .run(request.effects === 'none' ? 0 : 1, now, robot.id);
            }
            return settle('failed', 'preparation_failed');
        });
    }

    // Re-attests a robot without a known-uncertain preparation in the current generation.
    attestReadiness(context, request) {
        requireContext(context, this.#workspaceId, 'attest');
        exactObject(request, ['robotId']);
        const robotId = validateInternalId(request.robotId);
        return this.#mutate('attestReadiness', (db, generation) => {
            const robot = this.#ownedRobot(db, context, robotId);
            if (generation.recovery_pending) fail('recovery_pending');
            this.#refuseQuarantinedRobot(db, robotId);
            if (robot.lifecycle !== 'ready' || robot.uncertain === 1 || this.#hasPreparation(db, robotId)) fail('robot_busy');
            const configuration = JSON.parse(robot.configuration);
            if (this.#adapter(() => this.#runtime.attestRobot({ generationId: generation.id, robotId, operationId: null, configuration })) !== true) {
                fail('runtime_unavailable');
            }
            db.prepare('UPDATE robot SET attested_generation = ?, updated_at = ? WHERE id = ?').run(generation.id, this.#now(), robotId);
            return { robotId, ready: true };
        });
    }

    completeDelete(context, request) {
        requireContext(context, this.#workspaceId, 'adapter_complete');
        exactObject(request, ['operationId']);
        const operationId = validateOperationId(request.operationId);
        return this.#mutate('completeDelete', (db) => {
            const completion = db.prepare('SELECT * FROM completion WHERE scope = ? AND operation_id = ?').get(context.scope, operationId);
            if (!completion || completion.op_type !== 'delete') fail('not_found');
            if (completion.status !== 'pending') return this.#completionView(completion);
            const robot = db.prepare('SELECT * FROM robot WHERE id = ?').get(completion.robot_id);
            if (robot.lifecycle !== 'deleting' || robot.delete_operation_id !== operationId) fail('operation_conflict');
            // Every blocker must be settled absent (released or released_by_operator). A
            // quarantined blocker keeps the robot `deleting` until clearQuarantine.
            if (unsettledForRobot(db, robot.id).length > 0) fail('robot_busy');
            if (quarantinedForRobot(db, robot.id).length > 0) fail('resource_quarantined');
            const now = this.#now();
            db.prepare("UPDATE robot SET lifecycle = 'deleted', attested_generation = NULL, updated_at = ? WHERE id = ?").run(now, robot.id);
            db.prepare("UPDATE completion SET status = 'succeeded', reason = NULL, updated_at = ? WHERE scope = ? AND operation_id = ?")
                .run(now, context.scope, operationId);
            return this.#completionView(db.prepare('SELECT * FROM completion WHERE scope = ? AND operation_id = ?').get(context.scope, operationId));
        });
    }

    #completionView(row) {
        return { operationId: row.operation_id, type: row.op_type, robotId: row.robot_id, status: row.status, reason: row.reason };
    }

    // ---- Admission and origins ---------------------------------------------------

    admit(context, request, replay) {
        requireContext(context, this.#workspaceId, 'admit');
        if (!hasOriginRow(context)) fail('forbidden');
        const items = validateReplay(replay);
        validateAdmissionRequest(request, this.#limits);
        const { operationId, originRequestId, robotId, configRevision, kind, logical, specification } = request;
        // A turn is session work for a verified user: coordinator-API row only, refused before
        // any state access on the MCP and background rows.
        if (kind === 'turn' && !isOwnerRow(context)) fail('invalid_request');
        // The origin mapping is the idempotency key: the operation ID must be the derived one.
        if (operationId !== deriveOperationId(context, originRequestId)) fail('operation_conflict');
        const requestDigest = digest({
            type: 'admit', ownerId: context.ownerId, namespace: context.originNamespace, originKey: context.originKey,
            originRequestId, robotId, configRevision, kind, logical, specification
        });
        return this.#mutate('admit', (db, generation) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'admit', requestDigest);
            if (existing) return existing;
            const binding = this.#requireAdmissionBinding(db, context);
            const origin = db.prepare('SELECT 1 AS found FROM origin WHERE namespace = ? AND origin_key = ? AND origin_id = ?')
                .get(context.originNamespace, context.originKey, originRequestId);
            if (origin) fail('operation_conflict');
            if (this.#adapter(() => this.#runtime.admissionReady({ generationId: generation.id, robotId })) !== true) fail('runtime_unavailable');
            const robot = this.#ownedRobot(db, context, robotId);
            if (robot.lifecycle === 'deleting') fail('robot_busy');
            if (generation.recovery_pending) fail('recovery_pending');
            this.#refuseQuarantinedRobot(db, robotId);
            this.#gateKinds(db, 'admit');
            if (this.#hasPreparation(db, robotId) || robot.lifecycle === 'provisioning') fail('robot_busy');
            if (!this.#isReady(db, robot, generation, false)) fail('runtime_unavailable');
            if (robot.revision !== configRevision) fail('revision_conflict');
            const { logicalId, logicalKind, session } = this.#admissionLogical(db, context, binding, { kind, logical, robotId });
            this.#checkCapacity(db, 'admission', this.#limits.admissions);
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const executionId = randomId();
            const attemptId = randomId();
            const referenceId = randomId();
            const now = this.#now();
            // A session row is created only together with the first turn of its conversation.
            if (session === null && logicalKind === 'session') {
                insertSession(db, {
                    scope: context.scope, sessionKey: logical.sessionKey, logicalId, robotId, ownerId: context.ownerId,
                    generationId: generation.id, now
                });
            }
            db.prepare(`INSERT INTO admission (execution_id, attempt_id, logical_id, logical_kind, generation_id, robot_id, config_revision, configuration, kind, specification, scope, owner_id, operation_id, state, result, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`)
                .run(executionId, attemptId, logicalId, logicalKind, generation.id, robotId, configRevision, robot.configuration, kind,
                    canonicalJson(specification), context.scope, context.ownerId, operationId, now, now);
            db.prepare("INSERT INTO reference (id, version, provider, namespace, origin_key, origin_id, kind, logical_id, attempt_id, execution_id, obligation_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 'execution', ?, ?, ?, NULL, ?, ?)")
                .run(referenceId, PROVIDER_REFERENCE_VERSION, this.#provider, context.originNamespace, context.originKey, originRequestId, logicalId, attemptId, executionId, context.scope, now);
            db.prepare('INSERT INTO origin (namespace, origin_key, origin_id, scope, digest, operation_id, reference_id, execution_id, obligation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
                .run(context.originNamespace, context.originKey, originRequestId, context.scope, requestDigest, operationId, referenceId, executionId, now);
            appendStateEvent(db, referenceId, { state: 'queued' }, now);
            const response = {
                operationId, type: 'admit', status: 'admitted', admissionState: EXECUTION_ADMISSION_STATE, robotId, configRevision,
                logicalId, logicalKind, executionId, attemptId,
                reference: { version: PROVIDER_REFERENCE_VERSION, provider: this.#provider, id: referenceId }
            };
            return this.#recordReceipt(db, context, { operationId, type: 'admit', robotId, requestDigest, response });
        });
    }

    // Background row (`coordinator:<p>` / `binding:<id>`): the binding and its root must be
    // active, under the same coordinator, with the context's owner; otherwise not_found. Only
    // flow and generation bindings admit work: a schedule binding only parents derived flows
    // (invalid_request, reason binding_kind). Returns the binding, or null for the other rows.
    #requireAdmissionBinding(db, context) {
        const coordinator = coordinatorOf(context.originNamespace);
        if (coordinator === null || !context.originKey.startsWith('binding:')) return null;
        const bindingId = bindingOf(context.originKey);
        const binding = bindingId === null ? undefined : getBinding(db, coordinator, bindingId);
        if (!binding || !isActiveBinding(db, binding) || binding.owner_id !== context.ownerId) fail('not_found');
        if (binding.kind !== 'flow' && binding.kind !== 'generation') fail('invalid_request', 'binding_kind');
        return binding;
    }

    // The logical identity of an admission (S3b-A16; S6 source-only subset, Part A), recorded
    // with it and immutable:
    //   task on the MCP or coordinator-API row: kind `task`, a new logical ID;
    //   task on the background row: kind `flow`, the logical ID derived from the coordinator
    //     and the binding, so every phase under one binding shares it;
    //   turn (coordinator-API row only): kind `session`, the logical ID of the conversation's
    //     session, created here or joined (another robot is operation_conflict);
    //   continuation: the kind of the logical it continues, which must be in the context's
    //     scope, with its owner and robot (otherwise not_found, so a foreign logical ID is never
    //     disclosed). Only task work continues here: a session continues with `turn`, and flow
    //     continuation is a Part D obligation or P5 answer-driven work (invalid_request). A
    //     task continuation while any attempt of the logical is active is robot_busy.
    #admissionLogical(db, context, binding, { kind, logical, robotId }) {
        if (kind === 'turn') {
            const session = getSession(db, context.scope, logical.sessionKey);
            if (session === undefined) return { logicalId: randomId(), logicalKind: 'session', session: null };
            if (session.robot_id !== robotId || session.owner_id !== context.ownerId) fail('operation_conflict');
            return { logicalId: session.logical_id, logicalKind: 'session', session };
        }
        if (kind === 'continuation') {
            const logicalId = logical.logicalId;
            const previous = db.prepare('SELECT * FROM admission WHERE logical_id = ? ORDER BY created_at DESC, rowid DESC').all(logicalId);
            if (previous.length === 0 || previous[0].scope !== context.scope || previous[0].owner_id !== context.ownerId
                || previous[0].robot_id !== robotId) {
                fail('not_found');
            }
            const logicalKind = previous[0].logical_kind;
            if (logicalKind !== 'task') fail('invalid_request');
            if (previous.some((row) => !TERMINAL_STATES.includes(row.state))) fail('robot_busy');
            return { logicalId, logicalKind, session: null };
        }
        if (binding !== null) {
            return { logicalId: deriveFlowLogicalId(binding.coordinator, binding.binding_id), logicalKind: 'flow', session: null };
        }
        return { logicalId: randomId(), logicalKind: 'task', session: null };
    }

    // ---- Bindings (S1x) ----------------------------------------------------------

    // Root form: a coordinator-API context (`coordinator:<p>` / `owner:user:<id>`), recording
    // `ownerId` from that verified owner. Derived form: a background context
    // (`coordinator:<p>` / `binding:<parent>`) whose `ownerId` is the parent's owner; the
    // child is a flow and inherits that owner. Either form records an S1 receipt.
    registerBinding(context, request, replay) {
        requireContext(context, this.#workspaceId, 'bind');
        if (!hasOriginRow(context)) fail('forbidden');
        const items = validateReplay(replay);
        const coordinator = coordinatorOf(context.originNamespace);
        if (coordinator === null) fail('forbidden');
        exactObject(request, ['operationId', 'bindingId', 'kind'], ['parentBindingId']);
        const operationId = validateOperationId(request.operationId);
        if (!isBindingId(request.bindingId) || !BINDING_KINDS.includes(request.kind)) fail('invalid_request');
        // A generation-ticket ID is created only by an accepted obligation, whatever kind is claimed.
        if (request.bindingId.startsWith(GENERATION_PREFIX)) fail('invalid_request');
        const parentBindingId = request.parentBindingId === undefined ? null : request.parentBindingId;
        if (parentBindingId === null) {
            if (!isOwnerKey(context.originKey)) fail('forbidden');
        } else {
            if (!isBindingId(parentBindingId) || request.kind !== 'flow') fail('invalid_request');
            // The derived form is registered from the parent's own background row.
            if (bindingOf(context.originKey) !== parentBindingId) fail('forbidden');
        }
        const { bindingId, kind } = request;
        const requestDigest = digest({ type: 'bind', bindingId, kind, parentBindingId, ownerId: context.ownerId });
        return this.#mutate('registerBinding', (db, generation) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'bind', requestDigest);
            if (existing) return existing;
            if (getBinding(db, coordinator, bindingId)) fail('operation_conflict');
            let row;
            if (parentBindingId === null) {
                row = { evidence: 'owner-grant', rootBindingId: bindingId, depth: 0 };
            } else {
                const parent = getBinding(db, coordinator, parentBindingId);
                if (!parent || !isActiveBinding(db, parent) || parent.owner_id !== context.ownerId) fail('not_found');
                if (parent.depth >= BINDING_MAX_DEPTH) fail('invalid_request');
                row = { evidence: 'derived', rootBindingId: parent.root_binding_id, depth: parent.depth + 1 };
            }
            if (countBindings(db) >= this.#extensionLimit('bindings')) fail('capacity_exceeded');
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            insertBinding(db, {
                coordinator, bindingId, kind, ownerId: context.ownerId, parentBindingId, scope: context.scope, operationId,
                generationId: generation.id, now: this.#now(), ...row
            });
            const response = { operationId, type: 'bind', bindingId, kind, parentBindingId, status: 'registered' };
            return this.#recordReceipt(db, context, { operationId, type: 'bind', robotId: null, requestDigest, response });
        });
    }

    // Internal read with no context, used only after the coordinator hop token is verified.
    readBindingOwner(request) {
        exactObject(request, ['coordinator', 'bindingId']);
        if (typeof request.coordinator !== 'string' || request.coordinator.length === 0 || !isBindingId(request.bindingId)) fail('invalid_request');
        return this.#state.read((db) => {
            const binding = getBinding(db, request.coordinator, request.bindingId);
            if (!binding) fail('not_found');
            return { ownerId: binding.owner_id };
        });
    }

    // ---- Observation and control (S1x) ---------------------------------------------

    // Visibility, decided from the admission row and the verified context: the execution
    // owner, a verified direct administrator, or the origin row the reference was admitted
    // under when that row is a background binding (`coordinator:<p>` / `binding:<id>`).
    // A background-binding context is coordinator-alone by construction (a grant always
    // arrives on an `owner:user:` row), so it gets the origin-row basis only, whatever
    // `ownerId` or administrator flag it carries. Anything else, like an unknown reference,
    // is not_found.
    //
    // An observation reference (S6 Part D) is decided from its obligation the same way, and a
    // `generation` one is also visible to a coordinator-API user context of the obligation's
    // admitting coordinator (shared generation reads, D-F6 / N-7). Control still needs the
    // owner or an administrator, so such a caller gets forbidden there.
    #visibleReference(db, context, referenceId) {
        const reference = db.prepare('SELECT * FROM reference WHERE id = ?').get(referenceId);
        if (!reference) fail('not_found');
        const bindingRow = coordinatorOf(context.originNamespace) !== null && context.originKey.startsWith('binding:');
        if (reference.kind === 'observation') {
            const obligation = getObligation(db, reference.obligation_id);
            if (!obligation) fail('state_corrupt');
            const owner = !bindingRow && obligation.owner_id === context.ownerId;
            const administrator = !bindingRow && context.administrator === true;
            const originRow = bindingRow && reference.namespace === context.originNamespace && reference.origin_key === context.originKey;
            const shared = obligation.obligation_kind === 'generation' && isOwnerRow(context)
                && coordinatorOf(context.originNamespace) === obligation.coordinator;
            if (!owner && !administrator && !originRow && !shared) fail('not_found');
            return { reference, admission: null, obligation, owner, administrator };
        }
        const admission = db.prepare('SELECT * FROM admission WHERE execution_id = ?').get(reference.execution_id);
        const owner = !bindingRow && admission.owner_id === context.ownerId;
        const administrator = !bindingRow && context.administrator === true;
        const originRow = bindingRow && reference.namespace === context.originNamespace && reference.origin_key === context.originKey;
        if (!owner && !administrator && !originRow) fail('not_found');
        return { reference, admission, owner, administrator, originRow };
    }

    // Observation requires an origin-row context: service contexts are refused.
    #observer(context) {
        requireContext(context, this.#workspaceId, 'read');
        if (!hasOriginRow(context)) fail('forbidden');
    }

    // The recorded logical kind of an execution and, for flow work, the binding ID of the
    // background row it was admitted under (the wire `logical.id` of flow work).
    #recordedLogical(admission, reference) {
        const logicalKind = admission.logical_kind;
        if (!LOGICAL_KINDS.includes(logicalKind)) fail('state_corrupt');
        if (logicalKind !== 'flow') return { logicalKind, bindingId: null };
        const bindingId = bindingOf(reference.origin_key);
        if (bindingId === null) fail('state_corrupt');
        return { logicalKind, bindingId };
    }

    // The complete reference snapshot (interface note 2.1) as S1 facts. `endedReason` is set
    // only once terminal; `previousReference` is the preceding admission of the same logical work.
    // `logicalKind` is the kind recorded at admission; `bindingId` is set for flow work only.
    observeReference(context, request) {
        this.#observer(context);
        exactObject(request, ['referenceId']);
        if (!isPublicReferenceId(request.referenceId)) fail('invalid_request');
        return this.#state.snapshot((db) => {
            const { reference, admission, obligation } = this.#visibleReference(db, context, request.referenceId);
            if (obligation) return this.#observationFacts(db, reference, obligation);
            const view = this.#admissionView(admission, reference);
            const terminal = TERMINAL_STATES.includes(admission.state);
            const previous = db.prepare('SELECT execution_id FROM admission WHERE logical_id = ? AND rowid < (SELECT rowid FROM admission WHERE execution_id = ?) ORDER BY rowid DESC LIMIT 1')
                .get(admission.logical_id, admission.execution_id);
            const previousRow = previous ? referenceForExecution(db, previous.execution_id) : null;
            const cursor = readCursor(db, reference.id);
            const { logicalKind, bindingId } = this.#recordedLogical(admission, reference);
            return {
                referenceKind: 'execution',
                reference: view.reference, originRequestId: reference.origin_id, logicalId: view.logicalId, logicalKind, bindingId,
                attemptId: view.attemptId,
                state: view.state, cleanup: view.cleanup, result: view.result,
                endedReason: terminal ? (view.result.reason ?? admission.end_classification) : null,
                sequence: cursor ? cursor.last_sequence : 0,
                previousReference: previousRow ? { version: previousRow.version, provider: previousRow.provider, id: previousRow.id } : null
            };
        });
    }

    // Observation facts (interface note 2.1 ObservationSnapshot) at the store clock: a pending
    // obligation read at or after `acceptBy` reports expired without committing it.
    #observationFacts(db, reference, obligation) {
        const view = observationView(obligation, this.#now());
        const bindingId = namedBindingId(obligation);
        const binding = bindingId === null ? undefined : getBinding(db, obligation.coordinator, bindingId);
        const cursor = readCursor(db, reference.id);
        return {
            referenceKind: 'observation', reference: taskRefOfRow(reference), originRequestId: reference.origin_id, state: view.state,
            obligation: {
                obligationKind: obligation.obligation_kind, state: view.obligationState, acceptBy: obligation.accept_by,
                fenceRevision: binding ? binding.fence_revision : null
            },
            logicalKind: 'flow', logicalId: obligation.domain_record_id, result: view.result, sequence: cursor ? cursor.last_sequence : 0
        };
    }

    // State events after `after` (0 or more), at most `limit` (1-1000): {events, nextAfter}, or
    // {gap: true, snapshotSequence} when `after` precedes the retained window.
    listReferenceEvents(context, request) {
        this.#observer(context);
        exactObject(request, ['referenceId', 'after', 'limit']);
        if (!isPublicReferenceId(request.referenceId)) fail('invalid_request');
        if (!Number.isSafeInteger(request.after) || request.after < 0) fail('invalid_request');
        if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > EVENTS_MAX_LIMIT) fail('invalid_request');
        return this.#state.snapshot((db) => {
            const { reference } = this.#visibleReference(db, context, request.referenceId);
            return listEvents(db, reference.id, request.after, request.limit);
        });
    }

    // Relayed controls `stop` and `message`; `pause` is invalid_request on an execution reference,
    // decided after visibility. Order: visibility (not_found), operation rule
    // (stop: owner or administrator; message: owner only; else forbidden), recorded-control
    // replay, attempt identity, capacity, effect. A queued stop cancels in this transaction;
    // a running stop or message is recorded `pending` for the execution engine.
    controlReference(context, request, replay) {
        requireContext(context, this.#workspaceId, 'control');
        if (!hasOriginRow(context)) fail('forbidden');
        const items = validateReplay(replay);
        exactObject(request, ['referenceId', 'operationId', 'op'], ['attemptId', 'payload']);
        if (!isPublicReferenceId(request.referenceId)) fail('invalid_request');
        const operationId = validateOperationId(request.operationId);
        if (!CONTROL_OPS.includes(request.op)) fail('invalid_request');
        const attemptId = request.attemptId === undefined ? null : validateInternalId(request.attemptId);
        let payload = null;
        if (request.op === 'message') {
            // The message is written to the orchestration domain as {type: 'message', id?, message, displayText?}.
            exactObject(request.payload, ['message'], ['displayText', 'id']);
            if (typeof request.payload.message !== 'string' || request.payload.message.length === 0) fail('invalid_request');
            for (const key of ['displayText', 'id']) {
                if (request.payload[key] !== undefined && (typeof request.payload[key] !== 'string' || request.payload[key].length === 0)) fail('invalid_request');
            }
            payload = { message: request.payload.message };
            if (request.payload.displayText !== undefined) payload.displayText = request.payload.displayText;
            if (request.payload.id !== undefined) payload.id = request.payload.id;
            // The persisted canonical JSON is bounded by requestBytes before persistence.
            if (byteLength(payload) > this.#limits.requestBytes) fail('invalid_request');
        } else if (request.payload !== undefined) {
            fail('invalid_request');
        }
        const { referenceId, op } = request;
        const requestDigest = digest({ type: 'control', referenceId, op, attemptId, payload });
        return this.#mutate('controlReference', (db) => {
            this.#consume(db, items);
            const { admission, obligation, owner, administrator, originRow } = this.#visibleReference(db, context, referenceId);
            if (obligation) {
                return this.#controlObservation(db, context, obligation, { referenceId, operationId, op, attemptId, payload, requestDigest, owner, administrator });
            }
            // `pause` applies only to an observation reference (Part D); on an execution
            // reference it is invalid_request, decided after visibility.
            if (op === 'pause') fail('invalid_request');
            // M-12: stop is owner-or-administrator, message owner-only. A background row (the coordinator plus the persisted flow
            // binding the reference was admitted under) may also stop its own flow work (cancel, timeout, reconciliation); it is
            // visible only for references admitted under that very binding, so an interactive reference is `not_found` to it.
            if (op === 'stop' ? !(owner || administrator || originRow === true) : !owner) fail('forbidden');
            const recorded = getControl(db, referenceId, context.scope, operationId);
            if (recorded) {
                if (recorded.digest !== requestDigest || recorded.op !== op) fail('operation_conflict');
                return JSON.parse(recorded.response);
            }
            if (attemptId !== null && attemptId !== admission.attempt_id) fail('operation_conflict');
            if (op === 'message' && admission.state !== 'running') fail('operation_conflict');
            if (op === 'stop' && admission.state !== 'queued' && admission.state !== 'running') {
                // Computed, not stored: a stop of a stopping or terminal attempt changes nothing.
                return { operationId, op, outcome: 'not_applicable', delivery: 'applied', state: admission.state };
            }
            if (op === 'stop' && admission.state === 'running' && hasPendingStop(db, referenceId)) {
                // One pending stop per attempt: a further stop returns that outcome without a
                // new record, so repeated stops cannot exhaust the shared controls capacity.
                return { operationId, op, outcome: 'accepted', delivery: 'pending', state: admission.state };
            }
            if (countControls(db) >= this.#extensionLimit('controls')) fail('capacity_exceeded');
            const now = this.#now();
            let delivery = 'pending';
            let state = admission.state;
            if (op === 'stop' && admission.state === 'queued') {
                state = this.#endAttempt(db, admission.execution_id, 'cancelled', { outputText: '', data: null }, now);
                delivery = 'applied';
            }
            const response = { operationId, op, outcome: 'accepted', delivery, state };
            insertControl(db, { referenceId, actorKey: context.scope, operationId, op, payload, digest: requestDigest, response, delivery, now });
            return JSON.parse(canonicalJson(response));
        });
    }

    // A `stopping` reference is non-terminal for every observer: cleanup pending, no result.
    #admissionView(row, referenceRow) {
        const result = row.result === null ? null : JSON.parse(row.result);
        let cleanup = null;
        if (row.state === 'stopping') cleanup = 'pending';
        else if (result) cleanup = result.cleanup;
        return {
            reference: { version: referenceRow.version, provider: referenceRow.provider, id: referenceRow.id },
            logicalId: row.logical_id, executionId: row.execution_id, attemptId: row.attempt_id,
            robotId: row.robot_id, configRevision: row.config_revision, state: row.state, cleanup, result
        };
    }

    // The admission state recorded in the origin's admission receipt (design A13): `queued`
    // for an execution. Never live state.
    #recordedAdmissionState(db, origin) {
        const receipt = db.prepare('SELECT response FROM receipt WHERE scope = ? AND operation_id = ?').get(origin.scope, origin.operation_id);
        const state = receipt ? JSON.parse(receipt.response).admissionState : undefined;
        if (typeof state !== 'string') fail('state_corrupt');
        return state;
    }

    // Exact workspace + verified namespace + verified key (+ scope); foreign and unknown are
    // indistinguishable. `admissionState` is the recorded admission state, never live state.
    lookupOrigin(context, request) {
        requireContext(context, this.#workspaceId, 'lookup');
        if (!hasOriginRow(context)) fail('forbidden');
        exactObject(request, ['originRequestId']);
        if (!isOriginId(request.originRequestId)) fail('invalid_request');
        return this.#state.read((db) => {
            const origin = db.prepare('SELECT * FROM origin WHERE namespace = ? AND origin_key = ? AND origin_id = ?')
                .get(context.originNamespace, context.originKey, request.originRequestId);
            if (!origin || origin.scope !== context.scope) fail('not_found');
            if (origin.obligation_id !== null) {
                const reference = db.prepare('SELECT * FROM reference WHERE id = ?').get(origin.reference_id);
                return {
                    originRequestId: request.originRequestId, operationId: origin.operation_id, admissionState: this.#recordedAdmissionState(db, origin),
                    referenceKind: 'observation', reference: taskRefOfRow(reference)
                };
            }
            const admission = db.prepare('SELECT * FROM admission WHERE execution_id = ?').get(origin.execution_id);
            const reference = db.prepare('SELECT * FROM reference WHERE id = ?').get(origin.reference_id);
            return {
                originRequestId: request.originRequestId, operationId: origin.operation_id,
                admissionState: this.#recordedAdmissionState(db, origin), referenceKind: 'execution', ...this.#admissionView(admission, reference)
            };
        });
    }

    getReference(context, request) {
        requireContext(context, this.#workspaceId, 'read');
        exactObject(request, ['referenceId']);
        if (typeof request.referenceId !== 'string') fail('invalid_request');
        return this.#state.read((db) => {
            const reference = db.prepare('SELECT * FROM reference WHERE id = ?').get(request.referenceId);
            if (!reference || reference.scope !== context.scope || reference.kind !== 'execution') fail('not_found');
            return this.#admissionView(db.prepare('SELECT * FROM admission WHERE execution_id = ?').get(reference.execution_id), reference);
        });
    }

    getRobot(context, request) {
        requireContext(context, this.#workspaceId, 'read');
        exactObject(request, ['robotId']);
        const robotId = validateInternalId(request.robotId);
        return this.#state.read((db) => {
            const robot = db.prepare('SELECT * FROM robot WHERE id = ?').get(robotId);
            if (!robot || robot.owner_id !== robotOwnerOf(context)) fail('not_found');
            return this.#robotView(db, robot);
        });
    }

    #robotView(db, robot) {
        const generation = db.prepare("SELECT id, recovery_pending FROM generation WHERE state = 'active'").get();
        const preparing = this.#hasPreparation(db, robot.id);
        const quarantined = quarantinedForRobot(db, robot.id).length > 0;
        return {
            robotId: robot.id, name: robot.name, lifecycle: robot.lifecycle, revision: robot.revision,
            configuration: robot.configuration === null ? null : JSON.parse(robot.configuration),
            uncertain: robot.uncertain === 1, preparing,
            reason: quarantined && robot.lifecycle !== 'deleted' ? 'resource_quarantined' : null,
            ready: generation.id === this.#generationId && this.#isReady(db, robot, generation, preparing)
        };
    }

    // S1x: every robot recorded under the context's robot owner, deleted tombstones included,
    // in creation order (coordinator reconciliation after a restart).
    listRobots(context) {
        requireContext(context, this.#workspaceId, 'read');
        return this.#state.snapshot((db) => db.prepare('SELECT * FROM robot WHERE owner_id = ? ORDER BY created_at, rowid')
            .all(robotOwnerOf(context)).map((robot) => this.#robotView(db, robot)));
    }

    // Worker-level status: `degraded` derives from quarantined blockers with no owning robot.
    getWorkerStatus() {
        return this.#state.read((db) => {
            const generation = db.prepare("SELECT id, recovery_pending FROM generation WHERE state = 'active'").get();
            const kinds = degradedKinds(db);
            return { generationId: generation.id, recoveryPending: generation.recovery_pending === 1, degraded: kinds.length > 0, degradedKinds: kinds };
        });
    }

    getOperationOutcome(context, request) {
        requireContext(context, this.#workspaceId, 'read');
        exactObject(request, ['operationId']);
        const operationId = validateOperationId(request.operationId);
        return this.#state.read((db) => {
            const row = db.prepare('SELECT * FROM completion WHERE scope = ? AND operation_id = ?').get(context.scope, operationId);
            if (!row) fail('not_found');
            return this.#completionView(row);
        });
    }

    // ---- Coordinator obligations (plan §7.2; S6 Part D) -----------------------------------

    // The admitting coordinator of an obligation admission: the coordinator-API row's own
    // principal, or the verified hop coordinator carried on an MCP-row context. The background
    // row never admits an obligation.
    #obligationCoordinator(context) {
        if (isBindingRow(context)) fail('forbidden');
        const rowCoordinator = coordinatorOf(context.originNamespace);
        if (rowCoordinator !== null) {
            if (!isOwnerKey(context.originKey)) fail('forbidden');
            if (context.coordinator !== null && context.coordinator !== rowCoordinator) fail('forbidden');
            return rowCoordinator;
        }
        if (context.originNamespace === 'mcp' && context.coordinator !== null) return context.coordinator;
        return fail('forbidden');
    }

    #coordinatorContext(context, operation) {
        requireContext(context, this.#workspaceId, operation);
        if (hasOriginRow(context) || typeof context.coordinator !== 'string') fail('forbidden');
        return context.coordinator;
    }

    // An obligation the context's coordinator admitted; another coordinator's is not_found.
    #ownObligation(db, coordinator, obligationId) {
        const obligation = getObligation(db, obligationId);
        if (!obligation || obligation.coordinator !== coordinator) fail('not_found');
        return obligation;
    }

    #obligationReference(db, obligationId) {
        return db.prepare('SELECT * FROM reference WHERE obligation_id = ?').get(obligationId);
    }

    // Moves a decision state and appends the observation state event in the same transaction.
    #decide(db, obligation, change, now) {
        decideObligation(db, obligation.obligation_id, { ...change, now });
        const updated = getObligation(db, obligation.obligation_id);
        appendStateEvent(db, this.#obligationReference(db, obligation.obligation_id).id, { state: observationView(updated, now).state }, now);
        return updated;
    }

    #expire(db, obligation, now) {
        return this.#decide(db, obligation, { state: 'expired', result: EXPIRED_RESULT }, now);
    }

    #bindingRevision(db, obligation) {
        const bindingId = namedBindingId(obligation);
        const binding = bindingId === null ? undefined : getBinding(db, obligation.coordinator, bindingId);
        return binding ?? null;
    }

    // The recorded decision of a decided obligation, as an accept reply: `accepted` once it was
    // accepted (a later fence does not change that), otherwise `refused` with the reason that
    // ended it.
    #acceptReply(db, obligation) {
        const binding = this.#bindingRevision(db, obligation);
        const reply = { obligationId: obligation.obligation_id, state: obligation.state, fenceRevision: binding ? binding.fence_revision : null };
        if (wasAccepted(obligation)) return { ...reply, decision: 'accepted', bindingId: obligation.domain_record_id };
        return { ...reply, decision: 'refused', reason: this.#endReason(obligation) };
    }

    #endReason(obligation) {
        if (obligation.state === 'expired') return 'expired';
        if (obligation.state === 'cancelled') return 'cancelled';
        if (obligation.state === 'rejected') return obligation.reason === FENCE_CHANGED ? FENCE_CHANGED : 'rejected';
        return fail('state_corrupt');
    }

    // Obligation admission (interface note 2.3 (9)): coordinator-API or MCP row, the default
    // runtime refuses with nothing recorded. One transaction records the obligation, its
    // observation reference, origin, first state event and receipt; `acceptBy` is the store
    // clock plus `obligationAcceptMs`. A `flow-continuation` names a paused root flow binding
    // of this coordinator and owner, with no other open continuation, and records its fence
    // revision.
    admitObligation(context, request, replay) {
        requireContext(context, this.#workspaceId, 'obligate');
        if (!hasOriginRow(context)) fail('forbidden');
        const coordinator = this.#obligationCoordinator(context);
        const items = validateReplay(replay);
        exactObject(request, ['operationId', 'originRequestId', 'obligationKind', 'request'], ['continuationOf']);
        const operationId = validateOperationId(request.operationId);
        if (!isOriginId(request.originRequestId)) fail('invalid_request');
        if (!OBLIGATION_KINDS.includes(request.obligationKind)) fail('invalid_request');
        validateSpecification(request.request, this.#limits);
        let continuationOf = null;
        if (request.obligationKind === 'flow-continuation') {
            exactObject(request.continuationOf, ['bindingId']);
            if (typeof request.continuationOf.bindingId !== 'string' || !FLOW_ID.test(request.continuationOf.bindingId)) fail('invalid_request');
            continuationOf = request.continuationOf.bindingId;
        } else if (request.continuationOf !== undefined) {
            fail('invalid_request');
        }
        const { originRequestId, obligationKind } = request;
        if (operationId !== deriveOperationId(context, originRequestId)) fail('operation_conflict');
        const requestDigest = digest({
            type: 'obligate', ownerId: context.ownerId, namespace: context.originNamespace, originKey: context.originKey, coordinator,
            originRequestId, obligationKind, request: request.request, continuationOf
        });
        return this.#mutate('admitObligation', (db, generation) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'obligate', requestDigest);
            if (existing) return existing;
            const origin = db.prepare('SELECT 1 AS found FROM origin WHERE namespace = ? AND origin_key = ? AND origin_id = ?')
                .get(context.originNamespace, context.originKey, originRequestId);
            if (origin) fail('operation_conflict');
            if (this.#adapter(() => this.#runtime.admissionReady({ generationId: generation.id, robotId: null })) !== true) fail('runtime_unavailable');
            if (generation.recovery_pending) fail('recovery_pending');
            let expectedFenceRevision = null;
            if (continuationOf !== null) {
                const binding = getBinding(db, coordinator, continuationOf);
                if (!binding || binding.depth !== 0 || binding.evidence !== 'obligation' || binding.kind !== 'flow' || binding.owner_id !== context.ownerId) {
                    fail('not_found');
                }
                if (binding.state === 'active') fail('operation_conflict', 'binding_not_paused');
                if (binding.state === 'cancelled') fail('operation_conflict', 'binding_cancelled');
                const open = db.prepare(`SELECT 1 AS found FROM obligation WHERE coordinator = ? AND continuation_of = ?
                    AND (state = 'pending' OR (state = 'accepted' AND bound = 0)) LIMIT 1`).get(coordinator, continuationOf);
                if (open) fail('operation_conflict');
                expectedFenceRevision = binding.fence_revision;
            }
            if (countObligations(db) >= this.#extensionLimit('obligations')) fail('capacity_exceeded');
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const now = this.#now();
            const acceptBy = now + this.#extensionLimit('obligationAcceptMs');
            // The obligation is addressed by its observation reference ID: the admission reply
            // (interface note 2.1 `Admission`) carries only `taskRef`, so `obligationId` is
            // `taskRef.id` for the accept, reject and outbox routes.
            const obligationId = randomId();
            const referenceId = obligationId;
            insertObligation(db, {
                obligationId, coordinator, obligationKind, scope: context.scope, ownerId: context.ownerId, operationId,
                request: canonicalJson(request.request), continuationOf, expectedFenceRevision, acceptBy, generationId: generation.id, now
            });
            db.prepare("INSERT INTO reference (id, version, provider, namespace, origin_key, origin_id, kind, logical_id, attempt_id, execution_id, obligation_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 'observation', NULL, NULL, NULL, ?, ?, ?)")
                .run(referenceId, PROVIDER_REFERENCE_VERSION, this.#provider, context.originNamespace, context.originKey, originRequestId, obligationId, context.scope, now);
            db.prepare('INSERT INTO origin (namespace, origin_key, origin_id, scope, digest, operation_id, reference_id, execution_id, obligation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
                .run(context.originNamespace, context.originKey, originRequestId, context.scope, requestDigest, operationId, referenceId, obligationId, now);
            appendStateEvent(db, referenceId, { state: OBLIGATION_ADMISSION_STATE }, now);
            const response = {
                operationId, type: 'obligate', status: 'admitted', admissionState: OBLIGATION_ADMISSION_STATE, obligationId, obligationKind, acceptBy,
                reference: { version: PROVIDER_REFERENCE_VERSION, provider: this.#provider, id: referenceId }
            };
            return this.#recordReceipt(db, context, { operationId, type: 'obligate', robotId: null, requestDigest, response });
        });
    }

    // Accept (interface note 2.3 (9)), one transaction against the store clock. A pending
    // obligation at or after `acceptBy` commits `expired` first. A launch or generation creates
    // its root binding (evidence `obligation`, the obligation's owner), unless the ID already
    // exists as a binding of this coordinator (operation_conflict, nothing changes). A
    // continuation reactivates its binding only while it is still paused at the recorded fence
    // revision; otherwise it commits `rejected` / `fence_changed`. Every 200 reply is recorded
    // under the operation ID, so a retry returns the same bytes.
    acceptObligation(context, request, replay) {
        const coordinator = this.#coordinatorContext(context, 'decide');
        const items = validateReplay(replay);
        exactObject(request, ['operationId', 'obligationId', 'domainRecordId']);
        const operationId = validateOperationId(request.operationId);
        const obligationId = validateInternalId(request.obligationId);
        const { domainRecordId } = request;
        if (typeof domainRecordId !== 'string' || domainRecordId.length === 0 || domainRecordId.length > 200) fail('invalid_request');
        const requestDigest = digest({ type: 'accept', obligationId, domainRecordId });
        return this.#mutate('acceptObligation', (db, generation) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'accept', requestDigest);
            if (existing) return existing;
            let obligation = this.#ownObligation(db, coordinator, obligationId);
            const kind = obligation.obligation_kind;
            const grammatical = kind === 'flow-launch' ? FLOW_ID.test(domainRecordId)
                : kind === 'generation' ? GENERATION_ID.test(domainRecordId) : domainRecordId === obligation.continuation_of;
            if (!grammatical) fail('invalid_request');
            const now = this.#now();
            if (obligation.state === 'pending') {
                if (now >= obligation.accept_by) {
                    obligation = this.#expire(db, obligation, now);
                } else if (kind === 'flow-continuation') {
                    const binding = getBinding(db, coordinator, obligation.continuation_of);
                    if (binding && binding.state === 'paused' && binding.fence_revision === obligation.expected_fence_revision) {
                        moveBinding(db, coordinator, binding.binding_id, 'active');
                        obligation = this.#decide(db, obligation, { state: 'accepted', domainRecordId }, now);
                    } else {
                        obligation = this.#decide(db, obligation, { state: 'rejected', reason: FENCE_CHANGED, result: REJECTED_RESULT }, now);
                    }
                } else {
                    // Never re-create under a new ID (plan §7.2): an existing binding is a conflict.
                    if (getBinding(db, coordinator, domainRecordId)) fail('operation_conflict');
                    if (countBindings(db) >= this.#extensionLimit('bindings')) fail('capacity_exceeded');
                    insertBinding(db, {
                        coordinator, bindingId: domainRecordId, kind: kind === 'generation' ? 'generation' : 'flow', ownerId: obligation.owner_id,
                        evidence: 'obligation', parentBindingId: null, rootBindingId: domainRecordId, depth: 0, scope: obligation.scope, operationId,
                        generationId: generation.id, now
                    });
                    obligation = this.#decide(db, obligation, { state: 'accepted', domainRecordId }, now);
                }
            }
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const response = { operationId, type: 'accept', ...this.#acceptReply(db, obligation) };
            return this.#recordReceipt(db, context, { operationId, type: 'accept', robotId: null, requestDigest, response });
        });
    }

    // Reject: a pending obligation at or after `acceptBy` commits `expired` and is refused
    // `expired`; otherwise it commits `rejected` (the reference publishes failed /
    // coordinator_rejected). A decided obligation returns its recorded rejection, or refused
    // with `accepted`, `expired`, `cancelled` or `fence_changed`.
    rejectObligation(context, request, replay) {
        const coordinator = this.#coordinatorContext(context, 'decide');
        const items = validateReplay(replay);
        exactObject(request, ['operationId', 'obligationId', 'reason']);
        const operationId = validateOperationId(request.operationId);
        const obligationId = validateInternalId(request.obligationId);
        if (typeof request.reason !== 'string' || !REJECT_REASON.test(request.reason)) fail('invalid_request');
        const requestDigest = digest({ type: 'reject', obligationId, reason: request.reason });
        return this.#mutate('rejectObligation', (db) => {
            this.#consume(db, items);
            const existing = this.#findReceipt(db, context, operationId, 'reject', requestDigest);
            if (existing) return existing;
            let obligation = this.#ownObligation(db, coordinator, obligationId);
            const now = this.#now();
            let reply;
            if (obligation.state === 'pending' && now >= obligation.accept_by) {
                obligation = this.#expire(db, obligation, now);
                reply = { decision: 'refused', reason: 'expired' };
            } else if (obligation.state === 'pending') {
                obligation = this.#decide(db, obligation, { state: 'rejected', reason: `${COORDINATOR_REASON_PREFIX}${request.reason}`, result: REJECTED_RESULT }, now);
                reply = { decision: 'rejected' };
            } else if (obligation.state === 'rejected' && obligation.reason !== FENCE_CHANGED) {
                reply = { decision: 'rejected' };
            } else {
                reply = { decision: 'refused', reason: wasAccepted(obligation) ? 'accepted' : this.#endReason(obligation) };
            }
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const response = { operationId, type: 'reject', obligationId, state: obligation.state, ...reply };
            return this.#recordReceipt(db, context, { operationId, type: 'reject', robotId: null, requestDigest, response });
        });
    }

    // Engine-facing expiry sweep at the store clock: commits `expired` for every pending
    // obligation whose `acceptBy` has passed. Reads compute expiry without committing it.
    sweepObligations() {
        return this.#mutate('sweepObligations', (db) => {
            const now = this.#now();
            const due = db.prepare("SELECT rowid AS seq, * FROM obligation WHERE state = 'pending' AND accept_by <= ? ORDER BY rowid").all(now);
            for (const obligation of due) this.#expire(db, obligation, now);
            return { expired: due.length };
        });
    }

    // Reconciliation list: this coordinator's accepted obligations whose outbox revision 1 is not
    // applied, in acceptance order (the strictly increasing `accepted_seq`, never the clock).
    // `after` is '' or the `nextAfter` of an earlier page (the last listed obligation ID); an
    // unknown or malformed cursor is invalid_request.
    listObligations(context, request) {
        const coordinator = this.#coordinatorContext(context, 'reconcile');
        exactObject(request, ['state', 'unbound', 'after', 'limit']);
        if (request.state !== 'accepted' || request.unbound !== true || typeof request.after !== 'string') fail('invalid_request');
        if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000) fail('invalid_request');
        return this.#state.snapshot((db) => {
            let position = 0;
            if (request.after !== '') {
                if (!isInternalId(request.after)) fail('invalid_request');
                const cursor = getObligation(db, request.after);
                if (!cursor || cursor.coordinator !== coordinator || cursor.accepted_seq === null) fail('invalid_request');
                position = cursor.accepted_seq;
            }
            const rows = db.prepare(`SELECT rowid AS seq, * FROM obligation WHERE coordinator = ? AND state = 'accepted' AND bound = 0
                AND accepted_seq > ? ORDER BY accepted_seq LIMIT ?`)
                .all(coordinator, position, request.limit + 1);
            const page = rows.slice(0, request.limit).map((obligation) => {
                const reference = this.#obligationReference(db, obligation.obligation_id);
                const binding = this.#bindingRevision(db, obligation);
                const item = {
                    obligationId: obligation.obligation_id, obligationKind: obligation.obligation_kind, taskRef: taskRefOfRow(reference),
                    originRequestId: reference.origin_id, owner: obligation.owner_id, request: JSON.parse(obligation.request),
                    acceptBy: obligation.accept_by, state: obligation.state, domainRecordId: obligation.domain_record_id,
                    fenceRevision: binding ? binding.fence_revision : null
                };
                if (obligation.continuation_of !== null) item.continuationOf = { bindingId: obligation.continuation_of };
                return item;
            });
            return { obligations: page, nextAfter: rows.length > request.limit ? page[page.length - 1].obligationId : null };
        });
    }

    // Outbox (interface note 2.3 (9)): revision 1 is `bound`, then last + 1, each applied once.
    // The same revision with the same canonical body returns the recorded result; another body
    // or a gap is operation_conflict. A revision reported under a fence revision older than the
    // committed fence, or for a fenced interval, applies nothing and returns `fenced`. A
    // `terminal` revision publishes the reference's terminal result once.
    applyOutbox(context, request, replay) {
        const coordinator = this.#coordinatorContext(context, 'reconcile');
        const items = validateReplay(replay);
        exactObject(request, ['obligationId', 'revision', 'fenceRevision', 'kind', 'data']);
        const obligationId = validateInternalId(request.obligationId);
        const { revision, fenceRevision, kind, data } = request;
        if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(fenceRevision) || fenceRevision < 0) fail('invalid_request');
        if (!OUTBOX_KINDS.includes(kind) || (kind === 'bound') !== (revision === 1)) fail('invalid_request');
        validateSpecification(data, this.#limits);
        let result = null;
        if (kind === 'bound') {
            exactObject(data, [], ['capturedInputsDigest']);
            if (data.capturedInputsDigest !== undefined && (typeof data.capturedInputsDigest !== 'string' || data.capturedInputsDigest.length === 0
                || data.capturedInputsDigest.length > 200)) {
                fail('invalid_request');
            }
        } else if (kind === 'terminal') {
            exactObject(data, ['status', 'outputText'], ['data', 'reason']);
            if (data.status !== 'completed' && data.status !== 'failed') fail('invalid_request');
            if (typeof data.outputText !== 'string') fail('invalid_request');
            if (data.reason !== undefined && (typeof data.reason !== 'string' || !REJECT_REASON.test(data.reason))) fail('invalid_request');
            result = { status: data.status, outputText: data.outputText };
            if (data.data !== undefined) result.data = data.data;
            if (data.reason !== undefined) result.reason = data.reason;
            if (byteLength(result) > this.#limits.resultBytes) fail('invalid_request');
        }
        const requestDigest = digest({ revision, fenceRevision, kind, data });
        return this.#mutate('applyOutbox', (db) => {
            this.#consume(db, items);
            const obligation = this.#ownObligation(db, coordinator, obligationId);
            const recorded = getOutboxRevision(db, obligationId, revision);
            if (recorded) {
                if (recorded.digest !== requestDigest) fail('operation_conflict');
                return JSON.parse(recorded.response);
            }
            if (!wasAccepted(obligation)) fail('operation_conflict');
            const binding = getBinding(db, coordinator, obligation.domain_record_id);
            if (!binding) fail('state_corrupt');
            const fenced = (state) => ({ obligationId, revision, applied: false, fenced: state, fenceRevision: binding.fence_revision });
            // A cancelled binding is reported as `cancelled` whatever fence first ended this
            // interval (for example a pause, then a stop on the paused reference); otherwise the
            // interval's own fence state, so a paused interval whose binding a later continuation
            // reactivated still reports `paused`.
            if (obligation.state === 'paused' || obligation.state === 'cancelled') {
                return fenced(binding.state === 'cancelled' ? 'cancelled' : obligation.state);
            }
            if (fenceRevision < binding.fence_revision && (binding.state === 'paused' || binding.state === 'cancelled')) return fenced(binding.state);
            if (fenceRevision !== binding.fence_revision) fail('operation_conflict');
            if (obligation.result !== null || revision !== obligation.last_revision + 1) fail('operation_conflict');
            if (countOutboxRevisions(db) >= this.#extensionLimit('outboxRevisions')) fail('capacity_exceeded');
            const now = this.#now();
            markRevisionApplied(db, obligationId, { revision, result, now });
            const updated = getObligation(db, obligationId);
            const state = observationView(updated, now).state;
            if (result !== null) appendStateEvent(db, this.#obligationReference(db, obligationId).id, { state }, now);
            const response = { obligationId, revision, applied: true, state, fenceRevision: binding.fence_revision };
            insertOutboxRevision(db, {
                obligationId, revision, kind, fenceRevision, digest: requestDigest, data: canonicalJson(data), response: canonicalJson(response), now
            });
            return JSON.parse(canonicalJson(response));
        });
    }

    // Fence controls on an observation reference (interface note 2.3 (9)): `stop` and `pause`,
    // owner or administrator only. Kind-dependent refusals come after visibility. Fence
    // controls never hit the `controls` capacity; an applied one is recorded so a retry
    // returns the same bytes, a not-applicable one is computed and not recorded.
    #controlObservation(db, context, obligation, { referenceId, operationId, op, attemptId, payload, requestDigest, owner, administrator }) {
        if (op === 'message' || attemptId !== null || payload !== null) fail('invalid_request');
        if (!(owner || administrator)) fail('forbidden');
        const recorded = getControl(db, referenceId, context.scope, operationId);
        if (recorded) {
            if (recorded.digest !== requestDigest || recorded.op !== op) fail('operation_conflict');
            return JSON.parse(recorded.response);
        }
        const now = this.#now();
        let current = obligation;
        let applied = false;
        if (current.state === 'pending') {
            if (op === 'pause') fail('operation_conflict');
            if (now >= current.accept_by) {
                current = this.#expire(db, current, now);
            } else {
                current = this.#decide(db, current, { state: 'cancelled', result: CANCELLED_RESULT }, now);
                applied = true;
            }
        } else if (current.state === 'accepted' && current.result === null) {
            if (op === 'pause' && current.obligation_kind === 'generation') fail('operation_conflict');
            const next = op === 'pause' ? 'paused' : 'cancelled';
            this.#fenceBinding(db, current.coordinator, current.domain_record_id, next, now);
            current = this.#decide(db, current, { state: next, result: next === 'paused' ? PAUSED_RESULT : CANCELLED_RESULT }, now);
            applied = true;
        } else if (current.state === 'paused' && op === 'stop') {
            // Cancels the paused flow while its binding is still paused and no later interval of
            // that binding was accepted; the reference keeps its immutable paused result.
            const binding = getBinding(db, current.coordinator, current.domain_record_id);
            const later = db.prepare(`SELECT 1 AS found FROM obligation WHERE coordinator = ? AND domain_record_id = ? AND rowid > ?
                AND state IN ('accepted', 'paused', 'cancelled') LIMIT 1`).get(current.coordinator, current.domain_record_id, current.seq);
            if (binding && binding.state === 'paused' && !later) {
                this.#fenceBinding(db, current.coordinator, current.domain_record_id, 'cancelled', now);
                applied = true;
            }
        }
        const binding = this.#bindingRevision(db, current);
        const response = {
            operationId, op, outcome: applied ? 'accepted' : 'not_applicable', delivery: 'applied', state: observationView(current, now).state,
            fenceRevision: binding ? binding.fence_revision : null
        };
        if (binding) response.bindingState = binding.state;
        if (!applied) return response;
        insertControl(db, { referenceId, actorKey: context.scope, operationId, op, payload: null, digest: requestDigest, response, delivery: 'applied', now });
        return JSON.parse(canonicalJson(response));
    }

    // One fence of a root binding: its state moves with fence_revision + 1, queued executions
    // admitted under it or any binding derived from it (this coordinator's background rows only)
    // are cancelled, and running ones get one pending fence stop for the execution engine.
    #fenceBinding(db, coordinator, rootBindingId, state, now) {
        const binding = moveBinding(db, coordinator, rootBindingId, state);
        const namespace = `coordinator:${coordinator}`;
        for (const bindingId of bindingFamily(db, coordinator, rootBindingId)) {
            const rows = db.prepare(`SELECT r.id AS referenceId, a.execution_id AS executionId, a.state AS state FROM reference r
                JOIN admission a ON a.execution_id = r.execution_id
                WHERE r.kind = 'execution' AND r.namespace = ? AND r.origin_key = ? AND a.state IN ('queued', 'running') ORDER BY a.rowid`)
                .all(namespace, `binding:${bindingId}`);
            for (const row of rows) {
                if (row.state === 'queued') {
                    this.#endAttempt(db, row.executionId, 'cancelled', { outputText: '', data: null }, now);
                } else if (!hasPendingStop(db, row.referenceId)) {
                    insertFenceStop(db, {
                        referenceId: row.referenceId, operationId: randomId(), digest: digest({ type: 'fence', bindingId: rootBindingId, fenceRevision: binding.fence_revision }),
                        response: { outcome: 'accepted', delivery: 'pending', state: 'running' }, now
                    });
                }
            }
        }
        return binding;
    }

    // ---- Attempts ----------------------------------------------------------------

    // queued -> running only. Ending an attempt goes through beginAttemptEnd. A session turn
    // whose session has an earlier unfinished admission is robot_busy (first in, first out).
    transitionAttempt(request) {
        exactObject(request, ['executionId', 'attemptId', 'expectedState', 'nextState']);
        validateInternalId(request.executionId);
        validateInternalId(request.attemptId);
        if (request.expectedState !== 'queued' || request.nextState !== 'running') fail('invalid_request');
        return this.#mutate('transitionAttempt', (db, generation) => {
            const row = db.prepare('SELECT * FROM admission WHERE execution_id = ? AND attempt_id = ?').get(request.executionId, request.attemptId);
            if (!row) fail('not_found');
            if (row.generation_id !== generation.id) fail('stale_generation');
            if (row.state !== 'queued') fail('operation_conflict');
            // Plan §10.2: the turns of one session start first in, first out. A turn waits while
            // any earlier admission of its session is queued, running or stopping.
            if (row.logical_kind === 'session') {
                const earlier = db.prepare(`SELECT 1 AS found FROM admission WHERE logical_id = ? AND state IN ('queued', 'running', 'stopping')
                    AND rowid < (SELECT rowid FROM admission WHERE execution_id = ?) LIMIT 1`).get(row.logical_id, row.execution_id);
                if (earlier) fail('robot_busy');
            }
            const now = this.#now();
            db.prepare("UPDATE admission SET state = 'running', updated_at = ? WHERE execution_id = ?").run(now, row.execution_id);
            appendStateEvent(db, referenceForExecution(db, row.execution_id).id, { state: 'running' }, now);
            return { executionId: row.execution_id, attemptId: row.attempt_id, state: 'running' };
        });
    }

    // Trusted-adapter reads and writes for the execution engine (RoboWork r10 wiring). None takes a context: like
    // transitionAttempt they are called only by the in-process engine, never from the network.

    // Admissions of the current generation that are still `queued`, oldest first, with what the engine needs to start
    // them. The specification and configuration are returned parsed.
    listQueuedAdmissions({ limit = 16 } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) fail('invalid_request');
        return this.#state.snapshot((db) => db.prepare(`SELECT a.*, r.id AS reference_id FROM admission a JOIN reference r ON r.execution_id = a.execution_id
            WHERE a.state = 'queued' AND a.generation_id = ? ORDER BY a.rowid LIMIT ?`).all(this.#generationId, limit).map((row) => ({
            executionId: row.execution_id, attemptId: row.attempt_id, referenceId: row.reference_id, robotId: row.robot_id,
            configRevision: row.config_revision, configuration: row.configuration === null ? null : JSON.parse(row.configuration),
            kind: row.kind, logicalId: row.logical_id, logicalKind: row.logical_kind, specification: JSON.parse(row.specification),
            generationId: row.generation_id
        })));
    }

    // Admissions that are `running` in the current generation. The engine uses it to find work it owns after a start;
    // a running attempt of an earlier generation was interrupted by the rollover.
    listRunningAdmissions() {
        return this.#state.snapshot((db) => db.prepare(`SELECT a.execution_id, a.attempt_id, r.id AS reference_id FROM admission a JOIN reference r ON r.execution_id = a.execution_id
            WHERE a.state = 'running' AND a.generation_id = ? ORDER BY a.rowid`).all(this.#generationId)
            .map((row) => ({ executionId: row.execution_id, attemptId: row.attempt_id, referenceId: row.reference_id })));
    }

    // Appends relayed output events (types `ala` and `truncated`) of a running or stopping attempt in one transaction,
    // within the bounds of stateObservation.mjs. Returns {stored, dropped}.
    recordReferenceEvents(request) {
        exactObject(request, ['executionId', 'attemptId', 'events']);
        validateInternalId(request.executionId);
        validateInternalId(request.attemptId);
        if (!Array.isArray(request.events) || request.events.length < 1 || request.events.length > 1024) fail('invalid_request');
        for (const event of request.events) exactObject(event, ['type', 'data']);
        return this.#mutate('recordReferenceEvents', (db, generation) => {
            const row = db.prepare('SELECT * FROM admission WHERE execution_id = ? AND attempt_id = ?').get(request.executionId, request.attemptId);
            if (!row) fail('not_found');
            if (row.generation_id !== generation.id) fail('stale_generation');
            if (row.state !== 'running' && row.state !== 'stopping') fail('operation_conflict');
            return appendOutputEvents(db, referenceForExecution(db, row.execution_id).id, request.events, this.#now());
        });
    }

    // Controls recorded `pending` for a running attempt, oldest first: {operationId, actorKey, op, payload}. A `stop` has
    // no payload; a `message` has {message, displayText?, id?}. Delivery is confirmed with ackControl.
    takePendingControls(request) {
        exactObject(request, ['executionId', 'attemptId']);
        validateInternalId(request.executionId);
        validateInternalId(request.attemptId);
        return this.#state.snapshot((db) => {
            const row = db.prepare('SELECT * FROM admission WHERE execution_id = ? AND attempt_id = ?').get(request.executionId, request.attemptId);
            if (!row) fail('not_found');
            if (row.generation_id !== this.#generationId) fail('stale_generation');
            if (row.state !== 'running') return [];
            return listPendingControls(db, referenceForExecution(db, row.execution_id).id)
                .map(({ operationId, actorKey, op, payload }) => ({ operationId, actorKey, op, payload }));
        });
    }

    // Marks one pending control delivered (`applied`). Idempotent: false when it was not pending.
    ackControl(request) {
        exactObject(request, ['executionId', 'attemptId', 'actorKey', 'operationId']);
        validateInternalId(request.executionId);
        validateInternalId(request.attemptId);
        validateOperationId(request.operationId);
        nonEmptyString(request.actorKey);
        return this.#mutate('ackControl', (db, generation) => {
            const row = db.prepare('SELECT * FROM admission WHERE execution_id = ? AND attempt_id = ?').get(request.executionId, request.attemptId);
            if (!row) fail('not_found');
            if (row.generation_id !== generation.id) fail('stale_generation');
            return markControlApplied(db, referenceForExecution(db, row.execution_id).id, request.actorKey, request.operationId) > 0;
        });
    }

    // Lifecycle work for the trusted preparation driver: completions still `pending`, with the scope and robot owner
    // that a completing context must carry, and the candidate configuration of a provision or configure.
    listPendingCompletions() {
        return this.#state.snapshot((db) => db.prepare(`SELECT c.scope, c.operation_id, c.op_type, c.robot_id, r.owner_id, r.lifecycle, p.candidate
            FROM completion c JOIN robot r ON r.id = c.robot_id LEFT JOIN preparation p ON p.robot_id = c.robot_id AND p.operation_id = c.operation_id
            WHERE c.status = 'pending' ORDER BY c.rowid`).all().map((row) => ({
            scope: row.scope, operationId: row.operation_id, opType: row.op_type, robotId: row.robot_id, ownerId: row.owner_id,
            lifecycle: row.lifecycle, candidate: row.candidate === null ? null : JSON.parse(row.candidate)
        })));
    }

    // Ready robots of the current generation that lack a readiness attestation (after a restart): the driver verifies
    // each one and calls attestReadiness. `ownerId` is the robot owner that the attesting context must carry.
    listUnattestedRobots() {
        return this.#state.snapshot((db) => db.prepare(`SELECT id, owner_id, configuration FROM robot WHERE lifecycle = 'ready' AND uncertain = 0
            AND (attested_generation IS NULL OR attested_generation != ?) AND id NOT IN (SELECT robot_id FROM preparation) ORDER BY rowid`)
            .all(this.#generationId).map((row) => ({ robotId: row.id, ownerId: row.owner_id, configuration: JSON.parse(row.configuration) })));
    }

    // Step 1 of ending an attempt: durably records the internal classification and the
    // bounded result payload and moves the attempt to `stopping`. When the attempt has no
    // unsettled blocker, settleAttempt runs in this same transaction.
    beginAttemptEnd(context, request) {
        requireContext(context, this.#workspaceId, 'adapter_complete');
        exactObject(request, ['executionId', 'attemptId', 'expectedState', 'outcome']);
        validateInternalId(request.executionId);
        validateInternalId(request.attemptId);
        if (!ACTIVE_STATES.includes(request.expectedState)) fail('invalid_request');
        const { classification, payload } = validateAttemptOutcome(request.outcome, this.#limits);
        return this.#mutate('beginAttemptEnd', (db, generation) => {
            const row = db.prepare('SELECT * FROM admission WHERE execution_id = ? AND attempt_id = ?').get(request.executionId, request.attemptId);
            if (!row) fail('not_found');
            if (row.generation_id !== generation.id) fail('stale_generation');
            if (row.state !== request.expectedState) fail('operation_conflict');
            const state = this.#endAttempt(db, row.execution_id, classification, payload, this.#now());
            return { executionId: row.execution_id, attemptId: row.attempt_id, state, cleanup: state === 'stopping' ? 'pending' : null };
        });
    }

    // Moves an active attempt to `stopping` with its classification and payload (event
    // appended), then settles it in the same transaction when it has no unsettled blocker.
    // Used by beginAttemptEnd, control `stop` of a queued attempt and generation recovery.
    #endAttempt(db, executionId, classification, payload, now) {
        db.prepare("UPDATE admission SET state = 'stopping', end_classification = ?, end_payload = ?, updated_at = ? WHERE execution_id = ?")
            .run(classification, canonicalJson(payload), now, executionId);
        appendStateEvent(db, referenceForExecution(db, executionId).id, { state: 'stopping', cleanup: 'pending' }, now);
        this.#settleAttempt(db, executionId);
        return db.prepare('SELECT state FROM admission WHERE execution_id = ?').get(executionId).state;
    }

    // Step 2 (internal hook, no public signature). Called only inside a library
    // transaction. It never settles an attempt that is not `stopping`, and a second
    // invocation for a settled attempt publishes nothing.
    #settleAttempt(db, executionId) {
        const row = db.prepare('SELECT * FROM admission WHERE execution_id = ?').get(executionId);
        if (!row || row.state !== 'stopping') return false;
        if (unsettledForAttempt(db, row.attempt_id).length > 0) return false;
        const quarantined = quarantinedForAttempt(db, row.attempt_id);
        const payload = JSON.parse(row.end_payload);
        const result = {
            status: row.end_classification,
            cleanup: quarantined.length > 0 ? 'quarantined' : 'released',
            outputText: payload.outputText,
            data: payload.data
        };
        if (quarantined.some((blocker) => blocker.kind === PROCESS_TREE_KIND)) {
            // Precedence over every classification; the recorded classification is retained.
            result.status = 'failed';
            result.reason = 'termination_unverified';
            result.classification = row.end_classification;
        }
        const now = this.#now();
        db.prepare('UPDATE admission SET state = ?, result = ?, updated_at = ? WHERE execution_id = ?')
            .run(result.status, canonicalJson(result), now, executionId);
        appendStateEvent(db, referenceForExecution(db, executionId).id, { state: result.status, cleanup: result.cleanup }, now);
        return true;
    }

    // ---- Resource blockers --------------------------------------------------------

    reserveResource(request) {
        exactObject(request, ['kind', 'locator'], ['robotId', 'executionId', 'attemptId', 'retained', 'processBearing']);
        if (typeof request.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(request.kind) || request.kind === 'preparation') fail('invalid_request');
        if (request.retained !== undefined && typeof request.retained !== 'boolean') fail('invalid_request');
        if (request.processBearing !== undefined && typeof request.processBearing !== 'boolean') fail('invalid_request');
        for (const key of ['robotId', 'executionId', 'attemptId']) {
            if (request[key] !== undefined) validateInternalId(request[key]);
        }
        if ((request.executionId === undefined) !== (request.attemptId === undefined)) fail('invalid_request');
        exactObject(request.locator, [], Object.keys(request.locator));
        if (Object.hasOwn(request.locator, 'marker')) fail('invalid_request');
        const processBearing = request.processBearing === true;
        // Retention is an end-path decision (retainResource); a process-bearing resource is never retained.
        if (request.retained === true && (request.executionId !== undefined || processBearing || request.kind === PROCESS_TREE_KIND)) fail('invalid_request');
        return this.#mutate('reserveResource', (db, generation) => {
            const resourceId = randomId();
            let robotId = request.robotId ?? null;
            if (request.executionId !== undefined) {
                const attempt = db.prepare('SELECT * FROM admission WHERE execution_id = ? AND attempt_id = ?').get(request.executionId, request.attemptId);
                if (!attempt || (robotId !== null && attempt.robot_id !== robotId)) fail('not_found');
                if (attempt.generation_id !== generation.id) fail('stale_generation');
                // Refused once the attempt is stopping or terminal.
                if (!ACTIVE_STATES.includes(attempt.state)) fail('operation_conflict');
                robotId = attempt.robot_id;
            }
            if (robotId !== null) {
                const robot = db.prepare('SELECT lifecycle FROM robot WHERE id = ?').get(robotId);
                if (!robot || robot.lifecycle === 'deleted') fail('not_found');
                if (robot.lifecycle === 'deleting') fail('robot_busy');
            }
            if (request.retained === true && robotId === null) fail('invalid_request');
            // The locator is recorded once, with the marker of a process-bearing reservation.
            const locator = processBearing ? { ...request.locator, marker: resourceId } : request.locator;
            if (byteLength(locator) > this.#limits.requestBytes) fail('invalid_request');
            // Locators are never reused, including those of quarantined blockers.
            if (findByLocator(db, request.kind, canonicalJson(request.locator))) fail('operation_conflict');
            reserveBlocker(db, {
                resourceId, robotId, executionId: request.executionId ?? null, attemptId: request.attemptId ?? null,
                generationId: generation.id, kind: request.kind, processBearing, locator: canonicalJson(locator), locatorBase: canonicalJson(request.locator),
                retained: request.retained === true, now: this.#now()
            });
            return { resourceId, locator };
        });
    }

    // reserved -> committed, once, writing the identity tuple.
    commitResource(request) {
        exactObject(request, ['resourceId', 'identity']);
        validateInternalId(request.resourceId);
        exactObject(request.identity, [], Object.keys(request.identity));
        if (Object.keys(request.identity).length === 0 || byteLength(request.identity) > this.#limits.requestBytes) fail('invalid_request');
        return this.#mutate('commitResource', (db, generation) => {
            const blocker = getBlocker(db, request.resourceId);
            if (!blocker) fail('not_found');
            if (blocker.generation_id !== generation.id) fail('stale_generation');
            if (blocker.release_state !== RESERVED) fail('operation_conflict');
            commitBlocker(db, blocker.resource_id, canonicalJson(request.identity), this.#now());
            return { resourceId: blocker.resource_id, state: COMMITTED };
        });
    }

    // Records the outcome the trusted runtime caller reached by walking the resource:
    // `released` (absence proven) or `quarantined` (release unproven within the configured
    // deadline, which this library does not measure). Requires current-generation writer
    // authority plus the exact resource ID and its recorded owning generation, so G2 can
    // settle G's resources while G has no authority. The transaction that settles the last
    // unsettled blocker of a `stopping` attempt publishes its result.
    settleResource(request) {
        exactObject(request, ['resourceId', 'generationId', 'outcome']);
        validateInternalId(request.resourceId);
        validateInternalId(request.generationId);
        if (request.outcome !== RELEASED && request.outcome !== QUARANTINED) fail('invalid_request');
        return this.#mutate('settleResource', (db) => {
            const blocker = getBlocker(db, request.resourceId);
            if (!blocker || blocker.generation_id !== request.generationId) fail('not_found');
            if (blocker.release_state === request.outcome) return { resourceId: blocker.resource_id, state: blocker.release_state };
            if (blocker.release_state !== RESERVED && blocker.release_state !== COMMITTED) fail('operation_conflict');
            if (db.prepare('SELECT 1 AS found FROM preparation WHERE resource_id = ?').get(blocker.resource_id)) fail('robot_busy');
            settleBlocker(db, blocker.resource_id, request.outcome, this.#now());
            this.#afterBlockerSettled(db, blocker);
            return { resourceId: blocker.resource_id, state: request.outcome };
        });
    }

    releaseResource(request) {
        exactObject(request, ['resourceId', 'generationId']);
        return this.settleResource({ ...request, outcome: RELEASED });
    }

    quarantineResource(request) {
        exactObject(request, ['resourceId', 'generationId']);
        return this.settleResource({ ...request, outcome: QUARANTINED });
    }

    // Moves an unsettled blocker to the robot's retained-resource record (an end-path decision),
    // so it stops delaying its attempt; a stopping attempt whose last blocker this was settles
    // here. Idempotent for an already retained blocker. Refused for a blocker of another
    // generation, for a process-bearing or process-tree blocker and for a settled attempt.
    retainResource(request) {
        exactObject(request, ['resourceId']);
        validateInternalId(request.resourceId);
        return this.#mutate('retainResource', (db, generation) => {
            const blocker = getBlocker(db, request.resourceId);
            if (!blocker) fail('not_found');
            if (blocker.release_state !== RESERVED && blocker.release_state !== COMMITTED) fail('operation_conflict');
            if (blocker.retained === 1) return { resourceId: blocker.resource_id, retained: true };
            if (blocker.generation_id !== generation.id) fail('stale_generation');
            if (blocker.robot_id === null) fail('invalid_request');
            if (blocker.process_bearing === 1 || blocker.kind === PROCESS_TREE_KIND) fail('invalid_request');
            if (blocker.attempt_id !== null) {
                const attempt = db.prepare('SELECT state FROM admission WHERE attempt_id = ?').get(blocker.attempt_id);
                if (!attempt || TERMINAL_STATES.includes(attempt.state)) fail('operation_conflict');
            }
            retainBlocker(db, blocker.resource_id);
            this.#afterBlockerSettled(db, { ...blocker, retained: 1 });
            return { resourceId: blocker.resource_id, retained: true };
        });
    }

    #afterBlockerSettled(db, blocker) {
        if (blocker.execution_id !== null && blocker.attempt_id !== null) this.#settleAttempt(db, blocker.execution_id);
    }

    getResource(request) {
        exactObject(request, ['resourceId']);
        validateInternalId(request.resourceId);
        return this.#state.read((db) => {
            const blocker = getBlocker(db, request.resourceId);
            if (!blocker) fail('not_found');
            return publicBlocker(blocker);
        });
    }

    listUnsettledResources() {
        return this.#state.read((db) => {
            const active = db.prepare("SELECT id FROM generation WHERE state = 'active'").get();
            return db.prepare("SELECT * FROM resource_blocker WHERE release_state IN ('reserved', 'committed') ORDER BY created_at, resource_id").all()
                .map((row) => ({ ...publicBlocker(row), current: row.generation_id === active.id }));
        });
    }

    // Direct-administrator-only, audited clearing of a quarantine (a plan proposal, not a
    // recorded user decision). Absence comes only from the adapter call below, made outside
    // any transaction; the write is then a compare-and-set on still-quarantined and the
    // current generation. `attestation` is the operator's evidence digest only.
    clearQuarantine(context, request) {
        requireContext(context, this.#workspaceId, 'administer');
        if (context.administrator !== true) fail('forbidden');
        exactObject(request, ['operationId', 'resourceId', 'attestation']);
        const operationId = validateOperationId(request.operationId);
        const resourceId = validateInternalId(request.resourceId);
        if (typeof request.attestation !== 'string' || !/^[0-9a-f]{64}$/.test(request.attestation)) fail('invalid_request');
        const requestDigest = digest({ type: 'clear_quarantine', ownerId: context.ownerId, resourceId, attestation: request.attestation });
        const pre = this.#state.snapshot((db) => {
            const active = db.prepare("SELECT id FROM generation WHERE state = 'active'").get();
            if (!active || active.id !== this.#generationId) fail('stale_generation');
            const replay = this.#findReceipt(db, context, operationId, 'clear_quarantine', requestDigest);
            if (replay) return { replay };
            const blocker = getBlocker(db, resourceId);
            if (!blocker) fail('not_found');
            if (blocker.release_state !== QUARANTINED) fail('operation_conflict');
            return { blocker };
        });
        if (pre.replay) return pre.replay;
        const blocker = pre.blocker;
        const verdict = this.#runtime.verifyAbsence === undefined ? null : this.#adapter(() => this.#runtime.verifyAbsence({
            resourceId, kind: blocker.kind, robotId: blocker.robot_id, generationId: blocker.generation_id,
            processBearing: blocker.process_bearing === 1, committed: blocker.identity !== null,
            marker: blocker.process_bearing === 1 ? resourceId : null,
            locator: JSON.parse(blocker.locator), identity: blocker.identity === null ? null : JSON.parse(blocker.identity)
        }));
        if (verdict === false) fail('resource_present');
        if (verdict !== true) fail('runtime_unavailable');
        return this.#mutate('clearQuarantine', (db) => {
            const replay = this.#findReceipt(db, context, operationId, 'clear_quarantine', requestDigest);
            if (replay) return replay;
            const current = getBlocker(db, resourceId);
            if (!current || current.release_state !== QUARANTINED) fail('operation_conflict');
            this.#checkCapacity(db, 'receipt', this.#limits.receipts);
            const now = this.#now();
            clearBlocker(db, resourceId, now);
            recordClearAudit(db, { resourceId, operationId, actor: context.ownerId, evidenceDigest: request.attestation, now });
            // The owning robot needs a fresh readiness attestation.
            if (current.robot_id !== null) {
                db.prepare("UPDATE robot SET attested_generation = NULL, updated_at = ? WHERE id = ? AND lifecycle != 'deleted'").run(now, current.robot_id);
            }
            const response = { operationId, type: 'clear_quarantine', resourceId, state: RELEASED_BY_OPERATOR };
            return this.#recordReceipt(db, context, { operationId, type: 'clear_quarantine', robotId: current.robot_id, requestDigest, response });
        });
    }

    // ---- Generation fencing and recovery ------------------------------------------

    // Atomically ends the expected generation and allocates a fresh one. Two starts
    // expecting the same generation yield one rollover and one stale_generation. Every
    // unfinished attempt of the prior generation that is not yet `stopping` moves to
    // `stopping` (classification `interrupted`); one without an unsettled blocker settles
    // in this same transaction. An attempt already `stopping` is left unchanged.
    beginGenerationRecovery(expectedGeneration) {
        validateInternalId(expectedGeneration);
        if (expectedGeneration !== this.#generationId) fail('stale_generation');
        const result = this.#mutate('beginGenerationRecovery', (db, generation) => {
            if (generation.id !== expectedGeneration) fail('stale_generation');
            const now = this.#now();
            const next = randomId();
            db.prepare("UPDATE generation SET state = 'ended' WHERE id = ?").run(generation.id);
            db.prepare("INSERT INTO generation (id, state, prior_id, recovery_pending, created_at) VALUES (?, 'active', ?, 1, ?)")
                .run(next, generation.id, now);
            // Pending preparations are interrupted without replay; effective configuration is kept.
            for (const prep of db.prepare('SELECT * FROM preparation').all()) {
                db.prepare("UPDATE completion SET status = 'interrupted', reason = 'generation_rollover', updated_at = ? WHERE scope = ? AND operation_id = ? AND status = 'pending'")
                    .run(now, prep.scope, prep.operation_id);
                db.prepare('DELETE FROM preparation WHERE robot_id = ?').run(prep.robot_id);
                if (prep.kind === 'provision') {
                    db.prepare("UPDATE robot SET lifecycle = 'failed', uncertain = 1, updated_at = ? WHERE id = ? AND lifecycle = 'provisioning'")
                        .run(now, prep.robot_id);
                } else {
                    db.prepare("UPDATE robot SET uncertain = 1, updated_at = ? WHERE id = ? AND lifecycle = 'ready'").run(now, prep.robot_id);
                }
            }
            // All previous readiness attestations are invalidated.
            db.prepare('UPDATE robot SET attested_generation = NULL WHERE attested_generation IS NOT NULL').run();
            for (const attempt of db.prepare("SELECT execution_id FROM admission WHERE generation_id = ? AND state IN ('queued', 'running')").all(generation.id)) {
                this.#endAttempt(db, attempt.execution_id, 'interrupted', { outputText: '', data: null }, now);
            }
            return {
                generationId: next, priorGenerationId: generation.id,
                unsettledBlockers: unsettledOfPriorGenerations(db, next).map(publicBlocker)
            };
        });
        this.#generationId = result.generationId;
        return result;
    }

    // Succeeds when every prior-generation blocker is settled (released, quarantined or
    // released_by_operator) and every attempt of a prior generation is settled.
    completeGenerationRecovery(generation) {
        validateInternalId(generation);
        if (generation !== this.#generationId) fail('stale_generation');
        return this.#mutate('completeGenerationRecovery', (db, current) => {
            if (current.id !== generation) fail('stale_generation');
            if (current.recovery_pending === 0) return { generationId: generation, recovered: true };
            if (unsettledOfPriorGenerations(db, generation).length > 0) fail('recovery_pending');
            const open = db.prepare("SELECT 1 AS found FROM admission WHERE generation_id != ? AND state IN ('queued', 'running', 'stopping') LIMIT 1").get(generation);
            if (open) fail('recovery_pending');
            db.prepare('UPDATE generation SET recovery_pending = 0 WHERE id = ?').run(generation);
            return { generationId: generation, recovered: true };
        });
    }
}

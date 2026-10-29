import {
    deepFreeze, digestOf, failure, isDigest, isId, isOperationId, isPositiveCounter, success, validateSourceOperation,
    validateSourceProtectionRecord, validateWritableReservation
} from './contract.mjs';

// Worker-side writable-source reservation sequencing (T0 base §6, amendments A1.2, A1.3, A1.5, A1.7, A2.2, A2.3, A3, A4).
//
// The controller wraps the existing S1 resource-blocker API (reserveResource, commitResource, settleResource,
// listUnsettledResources, getResource, getWorkerStatus) and an injected remote source-protection interlock. It never
// writes S1 tables directly and registers no route, listener or production caller.
//
// Sequence of a reservation:
//   1. The worker intent is the S1 blocker itself: `reserveResource` of kind SOURCE_RESERVATION_KIND whose locator
//      {operationId, sourceStoreIdentity, request} records the complete canonical reserve body (A6.1: generation,
//      epoch, sorted resources) before the remote call. A retry or a recovery after a restart finds the unsettled
//      blocker through `listUnsettledResources` and resends exactly that body; it never rebuilds it from the current
//      generation or epoch, and another locator is never allocated for the same intent.
//   2. The remote reserve uses the S1 resource ID as `reservationId`.
//   3. Only after the remote reservation is durable is the S1 blocker committed (identity = request digest, store
//      identity, epoch, worker generation). The reservation is returned (exposable) only after both are durable.
//   4. Release: sealed inventory plus fresh, complete absence evidence of the recorded resources, then the remote
//      release, then the S1 settlement.
//   A lost reply at any step keeps the S1 blocker until the same body is reconciled (A6.3, `recoverIntents`).
//
// Store identity (A1.3, A2.2): a blocker reserved under another store identity is outcome-unknown. While one exists
// the worker is not ready, reserves nothing and does not acknowledge the new store; it is settled only through local
// verified absence (`settleOrphanedReservation`). Quarantine keeps the blocker unsettled, so readiness stays withdrawn.
// A missing reservation in a new store is never evidence of release.
//
// Worker generation (A2.3, A3.1, A4): the S1 generation is the worker generation. Before any reserve or acknowledge the
// controller registers or advances the remote current-generation pointer, using as prior the nearest ancestor in its
// complete S1 prior_id chain that equals the registered pointer. A missing or cyclic chain is state_corrupt.

const SOURCE_RESERVATION_KIND = 'source-reservation';
// A7.2: the body-independent retirement of a reserve operation, one S1 blocker per (operationId, sourceStoreIdentity).
// S1 never reuses a (kind, locator) pair whatever the state of the earlier blocker, so once reserved this locator is
// retired permanently, across restarts, generation rolls and interlock compaction.
const OPERATION_MARKER_KIND = 'source-reservation-op';

export const RESERVATION_ERROR_CODES = Object.freeze([
    'invalid_request', 'unauthorized', 'forbidden', 'stale_generation', 'stale_source_epoch', 'source_unavailable',
    'source_unprotected', 'protected_source_overlap', 'source_alias_unproven', 'source_provenance_unaccepted',
    'source_transition_blocked', 'release_unverified', 'resource_quarantined', 'not_found', 'operation_conflict',
    'capacity_exceeded', 'state_corrupt', 'outcome_unknown', 'source_store_changed', 'store_unacknowledged',
    'generation_unregistered', 'reservation_released', 'operation_retired'
]);

// Remote refusals that prove the interlock recorded nothing for a first, freshly reserved request.
const DEFINITIVE_REFUSALS = new Set([
    'invalid_request', 'unauthorized', 'forbidden', 'stale_generation', 'stale_source_epoch', 'source_unavailable',
    'source_unprotected', 'protected_source_overlap', 'source_alias_unproven', 'source_provenance_unaccepted',
    'source_transition_blocked', 'capacity_exceeded'
]);
const REMOTE_CODES = new Set([...RESERVATION_ERROR_CODES]);

class Refusal {
    constructor(code) { this.code = code; }
}

function refuse(code) {
    throw new Refusal(code);
}

function need(condition, code = 'invalid_request') {
    if (!condition) refuse(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function workerErrorCode(error) {
    if (error && error.name === 'WorkerStateError' && typeof error.code === 'string') return error.code;
    return null;
}

// S1 calls: a WorkerStateError keeps its code where it is one of ours; anything else is state_corrupt.
function s1(call) {
    try {
        return call();
    } catch (error) {
        const code = workerErrorCode(error);
        if (code === 'stale_generation' || code === 'not_found' || code === 'operation_conflict' || code === 'capacity_exceeded') refuse(code);
        if (code === 'runtime_unavailable') refuse('outcome_unknown');
        return refuse('state_corrupt');
    }
}

async function remote(call) {
    let result;
    try {
        result = await call();
    } catch {
        return failure('outcome_unknown');
    }
    if (!isPlainObject(result) || typeof result.ok !== 'boolean') return failure('outcome_unknown');
    if (result.ok) return result;
    const code = isPlainObject(result.error) ? result.error.code : undefined;
    return failure(REMOTE_CODES.has(code) ? code : 'outcome_unknown');
}

async function settled(work) {
    try {
        return await work();
    } catch (error) {
        if (error instanceof Refusal) return failure(error.code);
        return failure('state_corrupt');
    }
}

function sameIdentity(left, right) {
    return left.filesystemId === right.filesystemId && left.device === right.device && left.inode === right.inode;
}

function startsWith(chain, prefix) {
    return prefix.length <= chain.length && prefix.every((entry, index) => sameIdentity(entry, chain[index]));
}

// Pure worker-side conflict check of the writable resources of a reservation against the current protected source.
//   resources   the WritableResource entries of the request
//   protection  {record (SourceProtectionRecord), expectedEpoch, protectedRoots: [{sourceKind, chain}], protectedIdentities}
//               `chain` is the anchored identity chain from the workspace root down to the protected root
//   evidence    [{resourceId, chain, aliasCoverage, mountIdentity, hardLinks}] for each resource
//   parent      optional {chain}: a broker child must stay beneath its parent grant
// Identities compare by filesystem, device and inode (a bind alias of the same inode under another mount is the same).
export function checkWritableSourceConflict({ resources, protection, evidence, parent } = {}) {
    try {
        need(isPlainObject(protection), 'source_unavailable');
        const recordResult = validateSourceProtectionRecord(protection.record);
        need(recordResult.ok, 'source_unavailable');
        const record = recordResult.value;
        need(record.protectionStatus === 'protected', 'source_unprotected');
        need(isPositiveCounter(protection.expectedEpoch) && protection.expectedEpoch === record.sourceProtectionEpoch, 'stale_source_epoch');
        need(Array.isArray(resources) && resources.length > 0);
        need(Array.isArray(protection.protectedRoots) && Array.isArray(protection.protectedIdentities), 'source_alias_unproven');
        need(Array.isArray(evidence), 'source_alias_unproven');
        for (const resource of resources) {
            const facts = evidence.find((entry) => isPlainObject(entry) && entry.resourceId === resource.resourceId);
            need(facts !== undefined && Array.isArray(facts.chain) && facts.chain.length > 0, 'source_alias_unproven');
            need(sameIdentity(facts.chain[facts.chain.length - 1], resource.rootIdentity), 'source_alias_unproven');
            for (const root of protection.protectedRoots) {
                // The resource is the protected root, its ancestor or its descendant.
                need(!startsWith(facts.chain, root.chain) && !startsWith(root.chain, facts.chain), 'protected_source_overlap');
            }
            for (const identity of [...protection.protectedIdentities, ...protection.protectedRoots.map((root) => root.chain[root.chain.length - 1])]) {
                need(!facts.chain.some((entry) => sameIdentity(entry, identity)), 'protected_source_overlap');
            }
            need(facts.aliasCoverage === 'complete' && facts.mountIdentity === 'known' && facts.hardLinks === 'none', 'source_alias_unproven');
            if (parent !== undefined) {
                need(isPlainObject(parent) && Array.isArray(parent.chain) && startsWith(facts.chain, parent.chain), 'forbidden');
            }
        }
        return success({ conflict: false, epoch: record.sourceProtectionEpoch });
    } catch (error) {
        return failure(error instanceof Refusal ? error.code : 'invalid_request');
    }
}

const IDENTITY_KEYS = Object.freeze(['workspaceId', 'boxIdentity', 'boxGeneration', 'workerPrincipal', 'workerRuntimeInstanceId', 'workerEnableGeneration']);

export function createWritableReservationController({ workerState, interlock, managementContext, identity, generationChain } = {}) {
    need(workerState && ['reserveResource', 'commitResource', 'settleResource', 'listUnsettledResources', 'getResource', 'getWorkerStatus']
        .every((name) => typeof workerState[name] === 'function'));
    need(interlock && ['describeStore', 'reserveWritableResources', 'releaseWritableReservation', 'acknowledgeSourceStore', 'advanceWorkerGeneration']
        .every((name) => typeof interlock[name] === 'function'));
    need(isPlainObject(identity) && IDENTITY_KEYS.every((key) => typeof identity[key] === 'string') && Object.keys(identity).length === IDENTITY_KEYS.length);
    need(typeof generationChain === 'function');
    const self = Object.freeze({ ...identity });
    // Volatile view of remote state; every decision that matters is re-derived from S1 and the remote answers.
    const status = { store: null, registeredGeneration: null, acknowledged: null, forbidden: false, corrupt: false, conflict: false, observedStores: new Set() };

    function currentGeneration() {
        const workerStatus = s1(() => workerState.getWorkerStatus());
        // A superseded writer handle (another handle rolled the generation) has no authority.
        need(workerStatus.generationId === workerState.generationId, 'stale_generation');
        return workerState.generationId;
    }

    function sourceBlockers() {
        return s1(() => workerState.listUnsettledResources()).filter((blocker) => blocker.kind === SOURCE_RESERVATION_KIND);
    }

    function operationMarkers() {
        return s1(() => workerState.listUnsettledResources()).filter((blocker) => blocker.kind === OPERATION_MARKER_KIND);
    }

    // Settles the operation marker of an intent once the intent exists (it then carries the retirement alone).
    function settleMarkerOf(intentBlocker) {
        const markerId = intentBlocker.locator.markerId;
        const marker = operationMarkers().find((entry) => entry.resourceId === markerId);
        if (marker) s1(() => workerState.settleResource({ resourceId: marker.resourceId, generationId: marker.generationId, outcome: 'released' }));
    }

    function settleMarker(marker) {
        s1(() => workerState.settleResource({ resourceId: marker.resourceId, generationId: marker.generationId, outcome: 'released' }));
    }

    // Retires the operation (A7.2) before anything else is recorded. Called only when no unsettled intent exists for the
    // operation. A8.1: a retired operation refuses `operation_retired` (allocate a new operation ID). That includes a
    // marker left unsettled with no intent (a crash between the marker and the intent write, or a failed intent write):
    // nothing was recorded or exposed under it, so it is settled here and never reused.
    function retireOperation(operationId, storeId) {
        const pending = operationMarkers().filter((entry) => entry.locator.operationId === operationId && entry.locator.sourceStoreIdentity === storeId);
        need(pending.length <= 1, 'state_corrupt');
        if (pending.length === 1) {
            settleMarker(pending[0]);
            refuse('operation_retired');
        }
        try {
            return workerState.reserveResource({ kind: OPERATION_MARKER_KIND, locator: { operationId, sourceStoreIdentity: storeId } }).resourceId;
        } catch (error) {
            if (workerErrorCode(error) === 'operation_conflict') refuse('operation_retired');
            return s1(() => { throw error; });
        }
    }

    function orphanBlockers() {
        const storeId = status.store ? status.store.sourceStoreIdentity : null;
        return sourceBlockers().filter((blocker) => storeId === null || blocker.locator.sourceStoreIdentity !== storeId);
    }

    function readinessCode() {
        if (status.corrupt) return 'state_corrupt';
        if (status.conflict) return 'operation_conflict';
        // A superseded S1 writer is never ready, whatever the remote state says.
        if (s1(() => workerState.getWorkerStatus()).generationId !== workerState.generationId) return 'stale_generation';
        if (status.forbidden) return 'forbidden';
        if (status.store === null || status.store.state === 'unavailable') return 'source_unavailable';
        if (orphanBlockers().length > 0) return 'source_store_changed';
        if (status.registeredGeneration !== workerState.generationId) return 'generation_unregistered';
        if (status.acknowledged !== status.store.sourceStoreIdentity) return 'store_unacknowledged';
        return null;
    }

    // Walks the complete S1 prior_id chain from the current generation to the registered pointer (A3.1, A4).
    function priorFromChain(pointer) {
        const rows = generationChain();
        need(Array.isArray(rows), 'state_corrupt');
        const byId = new Map();
        for (const row of rows) {
            need(isPlainObject(row) && isId(row.id) && (row.priorId === null || isId(row.priorId)) && !byId.has(row.id), 'state_corrupt');
            byId.set(row.id, row.priorId);
        }
        const current = workerState.generationId;
        need(byId.has(current), 'state_corrupt');
        if (pointer === null) return null;
        const seen = new Set();
        let cursor = current;
        while (cursor !== null) {
            need(!seen.has(cursor), 'state_corrupt');
            seen.add(cursor);
            need(byId.has(cursor), 'state_corrupt');
            if (cursor === pointer) return cursor;
            cursor = byId.get(cursor);
        }
        // The pointer is not an ancestor of this worker: another holder of this principal advanced it.
        return refuse('stale_generation');
    }

    async function syncStore() {
        return settled(async () => {
            const result = await remote(() => interlock.describeStore(managementContext));
            if (!result.ok) {
                status.store = null;
                refuse(result.error.code === 'outcome_unknown' ? 'source_unavailable' : result.error.code);
            }
            const value = result.value;
            // An explicit trusted resync is the only way out of a `forbidden` holder refusal (no retry loop).
            status.forbidden = false;
            need(isPlainObject(value) && ['ready', 'awaiting-holder-ack', 'unavailable'].includes(value.state), 'state_corrupt');
            if (value.state === 'unavailable') {
                status.store = { state: 'unavailable', sourceStoreIdentity: null };
                return success({ state: 'unavailable' });
            }
            need(isId(value.sourceStoreIdentity) && typeof value.holderAcknowledged === 'boolean', 'state_corrupt');
            need(value.currentGeneration === null || isId(value.currentGeneration), 'state_corrupt');
            if (status.store && status.store.sourceStoreIdentity && status.store.sourceStoreIdentity !== value.sourceStoreIdentity) {
                status.observedStores.add(status.store.sourceStoreIdentity);
                status.acknowledged = null;
            }
            status.store = { state: value.state, sourceStoreIdentity: value.sourceStoreIdentity, currentGeneration: value.currentGeneration };
            if (value.holderAcknowledged) status.acknowledged = value.sourceStoreIdentity;
            // The remote pointer is authoritative: registered exactly when it names this worker's S1 generation.
            status.registeredGeneration = value.currentGeneration === workerState.generationId ? value.currentGeneration : null;
            return success({ state: value.state, sourceStoreIdentity: value.sourceStoreIdentity });
        });
    }

    async function registerGeneration({ operationId } = {}) {
        return settled(async () => {
            need(isOperationId(operationId));
            need(status.store !== null && status.store.state !== 'unavailable', 'source_unavailable');
            const next = currentGeneration();
            if (status.registeredGeneration === next) return success({ currentGeneration: next });
            let prior;
            try {
                prior = priorFromChain(status.store.currentGeneration ?? null);
            } catch (error) {
                if (error instanceof Refusal && error.code === 'state_corrupt') status.corrupt = true;
                throw error;
            }
            if (prior === next) {
                status.registeredGeneration = next;
                return success({ currentGeneration: next });
            }
            const request = { version: 1, operationId, priorGeneration: prior, nextGeneration: next };
            const result = await remote(() => interlock.advanceWorkerGeneration(managementContext, request));
            if (!result.ok) refuse(result.error.code);
            const checked = validateSourceOperation('advanceResult', result.value);
            need(checked.ok, 'state_corrupt');
            const value = checked.value;
            need(value.operationId === operationId && value.requestDigest === digestOf(request) && value.workerPrincipal === self.workerPrincipal
                && value.priorGeneration === prior && value.currentGeneration === next, 'state_corrupt');
            status.registeredGeneration = next;
            status.store.currentGeneration = next;
            return success(value);
        });
    }

    async function acknowledgeStore({ operationId } = {}) {
        return settled(async () => {
            need(isOperationId(operationId));
            if (status.corrupt) refuse('state_corrupt');
            need(status.store !== null && status.store.state !== 'unavailable', 'source_unavailable');
            // A2.2 precondition: no unsettled intent under any other store identity (quarantined ones stay unsettled).
            need(orphanBlockers().length === 0, 'source_store_changed');
            const generation = currentGeneration();
            need(status.registeredGeneration === generation, 'generation_unregistered');
            const storeId = status.store.sourceStoreIdentity;
            const prior = [...status.observedStores].filter((entry) => entry !== storeId).sort();
            const request = {
                version: 1, operationId, sourceStoreIdentity: storeId, workerGeneration: generation, priorStoreIdentities: prior,
                settlementAttestationDigest: digestOf({ version: 1, sourceStoreIdentity: storeId, workerGeneration: generation, priorStoreIdentities: prior, unsettledElsewhere: 0 })
            };
            const result = await remote(() => interlock.acknowledgeSourceStore(managementContext, request));
            if (!result.ok) {
                // A3.2: not a holder. Non-ready until a later trusted resync; no retry loop.
                if (result.error.code === 'forbidden') status.forbidden = true;
                refuse(result.error.code);
            }
            const checked = validateSourceOperation('acknowledgeResult', result.value);
            need(checked.ok, 'state_corrupt');
            const value = checked.value;
            need(value.operationId === operationId && value.sourceStoreIdentity === storeId && value.workerPrincipal === self.workerPrincipal
                && value.requestDigest === digestOf(request), 'state_corrupt');
            status.acknowledged = storeId;
            return success(value);
        });
    }

    function readiness() {
        try {
            const code = readinessCode();
            return deepFreeze(code === null ? { ready: true, code: null } : { ready: false, code });
        } catch (error) {
            return deepFreeze({ ready: false, code: error instanceof Refusal ? error.code : 'state_corrupt' });
        }
    }

    function checkIntent(intent) {
        need(isPlainObject(intent));
        const keys = ['operationId', 'robotId', 'executionId', 'attemptId', 'consumerKind', 'consumerId', 'expectedEpoch', 'resources'];
        for (const key of Object.keys(intent)) need(keys.includes(key) || key === 'conflict');
        for (const key of keys) need(Object.hasOwn(intent, key));
    }

    function commitIdentity(request, reservation) {
        return {
            requestDigest: digestOf(request), sourceStoreIdentity: reservation.sourceStoreIdentity,
            sourceProtectionEpoch: reservation.sourceProtectionEpoch, workerGeneration: reservation.workerGeneration
        };
    }

    function checkReservationMatches(value, request, storeId) {
        need(value.reservationId === request.reservationId && value.operationId === request.operationId
            && value.requestDigest === digestOf(request) && value.sourceStoreIdentity === storeId, 'state_corrupt');
        if (!Object.hasOwn(value, 'resources')) {
            need(value.workerPrincipal === self.workerPrincipal && value.workerGeneration === request.workerGeneration, 'state_corrupt');
            return;
        }
        for (const key of ['workspaceId', 'boxIdentity', 'boxGeneration', 'workerGeneration', 'robotId', 'executionId', 'attemptId', 'consumerKind', 'consumerId']) {
            need(value[key] === request[key], 'state_corrupt');
        }
        for (const key of ['workerPrincipal', 'workerRuntimeInstanceId', 'workerEnableGeneration']) need(value[key] === self[key], 'state_corrupt');
        need(digestOf(value.resources) === digestOf(request.resources), 'state_corrupt');
        need(value.state === 'released' || value.sourceProtectionEpoch === request.expectedEpoch, 'state_corrupt');
    }

    // A6.1: the exact reserve request recorded in the S1 intent locator before the remote call. The reservation ID is the
    // blocker's own resource ID, generated by S1 together with the locator.
    function recordedRequest(blocker) {
        const locator = blocker.locator;
        need(isPlainObject(locator) && isPlainObject(locator.request) && locator.request.operationId === locator.operationId, 'state_corrupt');
        const request = { ...locator.request, reservationId: blocker.resourceId };
        const checked = validateSourceOperation('reserveRequest', request);
        need(checked.ok, 'state_corrupt');
        need(request.workerGeneration === blocker.generationId, 'state_corrupt');
        return checked.value;
    }

    // A6.3: resend the exact recorded body and act on the answer. `fresh` marks a blocker created in this same call whose
    // reservation ID was never sent before, so any definitive refusal proves nothing was recorded under it.
    // Returns {outcome: 'reserved', exposable, value} | {outcome: 'released', value} | {outcome: 'settled', code} |
    // {outcome: 'kept', code}.
    async function resolveIntent(blocker, fresh) {
        const request = recordedRequest(blocker);
        const storeId = blocker.locator.sourceStoreIdentity;
        const current = blocker.generationId === workerState.generationId;
        const result = await remote(() => interlock.reserveWritableResources(managementContext, request));
        if (!result.ok) {
            const code = result.error.code;
            if (code === 'forbidden') status.forbidden = true;
            // With the A6.2 interlock order these refusals are only given when no record exists for the operation.
            const neverRecorded = (code === 'stale_generation' && !current) || code === 'stale_source_epoch'
                || (fresh && (DEFINITIVE_REFUSALS.has(code) || code === 'operation_conflict'));
            if (neverRecorded) {
                // Never recorded and never exposed: the intent is settled.
                s1(() => workerState.settleResource({ resourceId: blocker.resourceId, generationId: blocker.generationId, outcome: 'released' }));
                return { outcome: 'settled', code };
            }
            // A body mismatch on a recorded intent needs an operator: readiness is withdrawn.
            if (code === 'operation_conflict') status.conflict = true;
            return { outcome: 'kept', code };
        }
        const checked = validateSourceOperation('reserveResult', result.value);
        need(checked.ok, 'state_corrupt');
        const value = checked.value;
        checkReservationMatches(value, request, storeId);
        if (value.state === 'released') {
            // Released by the interlock on verified evidence (a release whose reply was lost).
            s1(() => workerState.settleResource({ resourceId: blocker.resourceId, generationId: blocker.generationId, outcome: 'released' }));
            return { outcome: 'released', value };
        }
        // Both records durable before exposure. A prior-generation blocker cannot be committed (S1 refuses it) and is
        // never exposed: it is released by the A1.2 owner rule with the recorded resources.
        if (current && blocker.state === 'reserved') s1(() => workerState.commitResource({ resourceId: blocker.resourceId, identity: commitIdentity(request, value) }));
        return { outcome: 'reserved', exposable: current, value };
    }

    function sameIntent(recorded, intent) {
        return recorded.robotId === intent.robotId && recorded.executionId === intent.executionId && recorded.attemptId === intent.attemptId
            && recorded.consumerKind === intent.consumerKind && recorded.consumerId === intent.consumerId
            && recorded.expectedEpoch === intent.expectedEpoch && digestOf(recorded.resources) === digestOf(intent.resources);
    }

    // Reserve writable resources. `intent.conflict` (optional) is the worker-side evidence for checkWritableSourceConflict,
    // evaluated before anything is recorded. Succeeds only with an exposable reservation (current generation, both records
    // durable). A tombstone answer for an unsettled intent is `reservation_released`; a retired operation with no unsettled
    // intent is `operation_retired` (A8.1); neither is ever a reservation.
    async function reserve(intent) {
        return settled(async () => {
            checkIntent(intent);
            need(isOperationId(intent.operationId));
            const code = readinessCode();
            if (code !== null) refuse(code);
            const generation = currentGeneration();
            const storeId = status.store.sourceStoreIdentity;
            const body = {
                version: 1, operationId: intent.operationId, workspaceId: self.workspaceId, boxIdentity: self.boxIdentity,
                boxGeneration: self.boxGeneration, workerGeneration: generation, robotId: intent.robotId, executionId: intent.executionId,
                attemptId: intent.attemptId, consumerKind: intent.consumerKind, consumerId: intent.consumerId, expectedEpoch: intent.expectedEpoch,
                resources: intent.resources
            };
            const draftCheck = validateSourceOperation('reserveRequest', { ...body, reservationId: 'AAAAAAAAAAAAAAAAAAAAAA' });
            if (!draftCheck.ok) refuse(draftCheck.error.code);
            if (intent.conflict !== undefined) {
                const conflict = checkWritableSourceConflict({ resources: intent.resources, ...intent.conflict });
                if (!conflict.ok) refuse(conflict.error.code);
            }
            // 1. The intent: the existing unsettled blocker of this operation (its recorded body is resent unchanged), or a
            //    new one whose locator records the complete body before any remote call (A6.1).
            const existing = sourceBlockers().filter((blocker) => blocker.locator.operationId === intent.operationId);
            need(existing.length <= 1, 'state_corrupt');
            let blocker = existing[0];
            let fresh = false;
            if (blocker) {
                need(blocker.locator.sourceStoreIdentity === storeId, 'source_store_changed');
                need(sameIntent(recordedRequest(blocker), intent), 'operation_conflict');
                settleMarkerOf(blocker);
            } else {
                // A7.2 first: the operation is retired before the intent exists, so a settled intent can never be
                // followed by a new body for the same operation. No await separates the three S1 writes below.
                const markerId = retireOperation(intent.operationId, storeId);
                const scope = intent.executionId === null ? { robotId: intent.robotId } : { robotId: intent.robotId, executionId: intent.executionId, attemptId: intent.attemptId };
                let created;
                try {
                    created = workerState.reserveResource({
                        kind: SOURCE_RESERVATION_KIND, locator: { operationId: intent.operationId, sourceStoreIdentity: storeId, markerId, request: body }, ...scope
                    });
                } catch (error) {
                    // No intent was written: the operation is retired (A8.1) and its marker settled at once when S1 still
                    // accepts writes (after a crash, recovery settles it). The body is already schema-valid, so an S1
                    // invalid_request here is the locator size bound (`requestBytes`).
                    try { settleMarker({ resourceId: markerId, generationId: workerState.generationId }); } catch { /* recovery settles it */ }
                    if (workerErrorCode(error) === 'invalid_request') refuse('capacity_exceeded');
                    return s1(() => { throw error; });
                }
                blocker = s1(() => workerState.getResource({ resourceId: created.resourceId }));
                settleMarkerOf(blocker);
                fresh = true;
            }
            // 2. The remote reservation under the same reservation ID, then 3. the S1 commit (resolveIntent).
            const resolved = await resolveIntent(blocker, fresh);
            if (resolved.outcome === 'settled' || resolved.outcome === 'kept') refuse(resolved.code);
            if (resolved.outcome === 'released') refuse('reservation_released');
            need(resolved.exposable, 'stale_generation');
            return success(resolved.value);
        });
    }

    // A6.3 recovery: resends the recorded body of every unsettled same-store intent and reconciles it. Intents of another
    // store identity are listed as orphaned (A1.3) without a remote call. A recorded reservation of a prior generation is
    // returned (not exposable) so that it can be released by the owner rule after verified absence.
    // A8.2: every unsettled operation marker is settled first, locally and without the interlock, even while the store is
    // unavailable: a marker linked to an existing intent has done its job, and an unlinked one (a crash before the intent
    // write) recorded and exposed nothing; the operation stays retired either way. Intents still need the store; while it
    // is unavailable they are reported as kept with `source_unavailable`.
    async function recoverIntents() {
        return settled(async () => {
            if (status.corrupt) refuse('state_corrupt');
            currentGeneration();
            const outcomes = [];
            const intents = sourceBlockers();
            const linked = new Set(intents.map((blocker) => blocker.locator.markerId));
            for (const marker of operationMarkers()) {
                const entry = { resourceId: marker.resourceId, operationId: marker.locator.operationId, generationId: marker.generationId };
                try {
                    settleMarker(marker);
                    if (!linked.has(marker.resourceId)) outcomes.push({ ...entry, outcome: 'retired' });
                } catch (error) {
                    outcomes.push({ ...entry, outcome: 'error', code: error instanceof Refusal ? error.code : 'state_corrupt' });
                }
            }
            const available = status.store !== null && status.store.state !== 'unavailable';
            const storeId = available ? status.store.sourceStoreIdentity : null;
            for (const blocker of intents) {
                const entry = { resourceId: blocker.resourceId, operationId: blocker.locator.operationId, generationId: blocker.generationId };
                if (!available) {
                    outcomes.push({ ...entry, outcome: 'kept', code: 'source_unavailable' });
                    continue;
                }
                // One intent's failure never stops the reconciliation of the others; it is reported and retried later.
                try {
                    if (blocker.locator.sourceStoreIdentity !== storeId) {
                        outcomes.push({ ...entry, outcome: 'orphaned' });
                        continue;
                    }
                    const resolved = await resolveIntent(blocker, false);
                    if (resolved.outcome === 'reserved') outcomes.push({ ...entry, outcome: 'reserved', exposable: resolved.exposable, reservation: resolved.value });
                    else if (resolved.outcome === 'released') outcomes.push({ ...entry, outcome: 'released' });
                    else outcomes.push({ ...entry, outcome: resolved.outcome, code: resolved.code });
                } catch (error) {
                    outcomes.push({ ...entry, outcome: 'error', code: error instanceof Refusal ? error.code : 'state_corrupt' });
                }
            }
            return success(outcomes);
        });
    }

    function checkEvidence(resources, evidence) {
        need(isPlainObject(evidence), 'release_unverified');
        need(Array.isArray(evidence.resources), 'release_unverified');
        if (evidence.resources.some((entry) => isPlainObject(entry) && entry.state === 'quarantined')) refuse('resource_quarantined');
        need(evidence.complete === true && evidence.fresh === true && evidence.sealed === true && evidence.openHandles === 0, 'release_unverified');
        need(isDigest(evidence.digest), 'release_unverified');
        const reported = new Map(evidence.resources.filter(isPlainObject).map((entry) => [entry.resourceId, entry.state]));
        need(reported.size === evidence.resources.length, 'release_unverified');
        for (const resource of resources) need(reported.get(resource.resourceId) === 'absent', 'release_unverified');
        need(reported.size === resources.length, 'release_unverified');
    }

    // Release after sealing and verified absence. `reservation` is the recorded WritableReservation (from reserve or from
    // recoverIntents); it must match the body recorded in the S1 intent.
    async function release({ operationId, reservation, evidence } = {}) {
        return settled(async () => {
            need(isOperationId(operationId));
            const checkedReservation = validateWritableReservation(reservation);
            if (!checkedReservation.ok) refuse(checkedReservation.error.code);
            const record = checkedReservation.value;
            need(record.workerPrincipal === self.workerPrincipal, 'forbidden');
            const blocker = s1(() => workerState.getResource({ resourceId: record.reservationId }));
            need(blocker.kind === SOURCE_RESERVATION_KIND && blocker.locator.operationId === record.operationId, 'operation_conflict');
            // A1.2: the owning generation is the reservation's own; a different one is a conflict.
            need(blocker.generationId === record.workerGeneration, 'operation_conflict');
            need(blocker.locator.sourceStoreIdentity === record.sourceStoreIdentity, 'operation_conflict');
            const recorded = recordedRequest(blocker);
            need(digestOf(recorded) === record.requestDigest && digestOf(recorded.resources) === digestOf(record.resources), 'operation_conflict');
            checkEvidence(recorded.resources, evidence);
            const generation = currentGeneration();
            need(status.registeredGeneration === generation, 'generation_unregistered');
            const request = {
                version: 1, operationId, reservationId: record.reservationId, reservationRequestDigest: record.requestDigest,
                owningWorkerGeneration: record.workerGeneration, resourcesDigest: digestOf(record.resources), releaseEvidenceDigest: evidence.digest
            };
            const result = await remote(() => interlock.releaseWritableReservation(managementContext, request));
            if (!result.ok) refuse(result.error.code);
            const checked = validateSourceOperation('releaseResult', result.value);
            need(checked.ok, 'state_corrupt');
            const value = checked.value;
            need(value.operationId === operationId && value.reservationId === record.reservationId && value.requestDigest === digestOf(request)
                && value.releaseEvidenceDigest === evidence.digest && value.sourceStoreIdentity === record.sourceStoreIdentity, 'state_corrupt');
            s1(() => workerState.settleResource({ resourceId: record.reservationId, generationId: blocker.generationId, outcome: 'released' }));
            return success(value);
        });
    }

    // Local settlement of an intent reserved under another (or no longer available) store identity (A1.3, A6.4): verified
    // absence of exactly the writable resources recorded in its intent body. Quarantine leaves it unsettled and readiness
    // withdrawn; unrelated or partial evidence is release_unverified.
    async function settleOrphanedReservation({ resourceId, evidence } = {}) {
        return settled(async () => {
            need(isId(resourceId));
            const blocker = sourceBlockers().find((entry) => entry.resourceId === resourceId);
            need(blocker !== undefined, 'not_found');
            const storeId = status.store && status.store.state !== 'unavailable' ? status.store.sourceStoreIdentity : null;
            need(storeId === null || blocker.locator.sourceStoreIdentity !== storeId, 'operation_conflict');
            const recorded = recordedRequest(blocker);
            checkEvidence(recorded.resources, evidence);
            currentGeneration();
            s1(() => workerState.settleResource({ resourceId, generationId: blocker.generationId, outcome: 'released' }));
            status.observedStores.add(blocker.locator.sourceStoreIdentity);
            return success({ resourceId, state: 'released' });
        });
    }

    // Unsettled source-reservation intents, for recovery: same-store ones are reconciled by retrying the same operation.
    function listIntents() {
        try {
            const storeId = status.store ? status.store.sourceStoreIdentity : null;
            return success(sourceBlockers().map((blocker) => ({
                resourceId: blocker.resourceId, operationId: blocker.locator.operationId, sourceStoreIdentity: blocker.locator.sourceStoreIdentity,
                state: blocker.state, generationId: blocker.generationId, orphaned: storeId === null || blocker.locator.sourceStoreIdentity !== storeId,
                resources: Array.isArray(blocker.locator.request?.resources) ? blocker.locator.request.resources : null
            })));
        } catch (error) {
            return failure(error instanceof Refusal ? error.code : 'state_corrupt');
        }
    }

    return Object.freeze({ syncStore, registerGeneration, acknowledgeStore, readiness, reserve, recoverIntents, release, settleOrphanedReservation, listIntents });
}

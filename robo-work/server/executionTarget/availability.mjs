import {
    deepFreeze, digestOf, failure, isContainerId, isDigest, isId, isOpaqueIdentity, isOperationId, isPrincipal, isRef, utf8Bytes,
    validateQualificationRecord, validateSourceProtectionRecord, validateTargetBinding
} from './contract.mjs';
import { TARGET_LIMITS_V1 } from './limits.mjs';

// Pure execution-target availability and admission decisions (T0 base §3, refusal precedence replaced by A1.7).
//
// Production has no activated target backend: every nonempty production selection that passes all other checks still
// refuses `backend_not_activated`. Only proof-fixture mode with an installed proof-fixture record can admit (erratum A10,
// P6a), see `proofFixtureActivation`. Nothing here reads files,
// launches anything or trusts cached UI availability; `requireExecutionTarget` repeats every check itself.
//
// Trusted facts (supplied by management, never by the caller):
//   surface      'terminal' | 'browser' | 'desktop' (the Environment surface of the request)
//   mode         'production' | 'proof-fixture'
//   live         {workspaceId, boxIdentity, boxGeneration} of the current Box
//   excluded     {principals, aliases, runtimeInstanceIds}: RoboTeam and the owning worker, by authenticated canonical
//                principal, every known alias or historical spelling, and resolved runtime identity
//   entries      trusted discovery entries, see ENTRY_KEYS
//   sourceState  {record, currentSelectionDigest, currentClosureDigest, aliasCoverage, trustedAcceptances,
//                 previouslyRobotWritable, writableBacking, linkInstallAlias, repositorySourceMode}
//   qualifications {records: {[ref]: QualificationRecord}, trustedAcceptances, executionsUsed: {[ref]: count}}
//   request      {coordinatorPrincipal, operationId, nowMs} (proof-fixture scope checks)
//   current      for a proof-fixture admission: {worker: {principal, runtimeInstanceId, enableGeneration, generation}}, compared
//                with the worker half of the record scope
//   home         {homeIdentity, backendId, workerInventoryDigest, targetInventoryDigest}
//   admittedBinding  null, or the admitted TargetBinding when revalidating at queued dispatch or final release
//   current      with an admitted binding: {worker: {principal, runtimeInstanceId, enableGeneration, generation},
//                limitsDigest, journalStoreIdentity}; sourceState then also carries {repositoryIdentity, revision}

export const AVAILABILITY_ERROR_CODES = Object.freeze([
    'invalid_request', 'invalid_selection', 'environment_not_terminal', 'target_excluded', 'target_missing', 'target_ambiguous',
    'binding_mismatch', 'target_scope_mismatch', 'target_not_eligible', 'target_contract_missing', 'target_contract_invalid',
    'source_unavailable', 'source_unprotected', 'source_alias_unproven', 'source_provenance_unaccepted', 'stale_source_epoch',
    'source_binding_mismatch', 'target_unprepared', 'journal_unavailable', 'qualification_missing', 'qualification_untrusted',
    'qualification_class', 'qualification_scope', 'peer_trust_unaccepted', 'peer_authority_exposed', 'target_attestation_mismatch',
    'home_incompatible', 'capacity_exceeded', 'backend_not_activated'
]);

// The production activation switch. It is not configurable (no environment variable, option or fact): production
// activation is a later reviewed focused delta. The only other admission path is the proof-fixture one below.
const BACKEND_ACTIVATED = false;
const INVENTORY_MAX_TARGETS = 256;
const INVENTORY_MAX_BYTES = 65536;

const ENTRY_KEYS = Object.freeze([
    'ref', 'label', 'principal', 'aliases', 'runtimeInstanceId', 'containerId', 'enableGeneration', 'helperIncarnation',
    'workspaceId', 'boxIdentity', 'boxGeneration', 'enabled', 'running', 'runtime', 'placement', 'declaration', 'prepared',
    'journal', 'attestation', 'activeExecutions'
]);

class Decision {
    constructor(code) { this.code = code; }
}

function refuse(code) {
    throw new Decision(code);
}

function need(condition, code) {
    if (!condition) refuse(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function principalList(value) {
    return Array.isArray(value) && value.every(isPrincipal);
}

function checkEntry(entry) {
    need(isPlainObject(entry) && ENTRY_KEYS.every((key) => Object.hasOwn(entry, key)) && Object.keys(entry).length === ENTRY_KEYS.length, 'invalid_request');
    need(isRef(entry.ref) && isPrincipal(entry.principal) && principalList(entry.aliases), 'invalid_request');
    need(entry.runtimeInstanceId === null || isOpaqueIdentity(entry.runtimeInstanceId), 'invalid_request');
    need(entry.containerId === null || isContainerId(entry.containerId), 'invalid_request');
    need(entry.helperIncarnation === null || isId(entry.helperIncarnation), 'invalid_request');
    need(Number.isSafeInteger(entry.activeExecutions) && entry.activeExecutions >= 0, 'invalid_request');
}

function checkFacts(facts) {
    need(isPlainObject(facts), 'invalid_request');
    need(['terminal', 'browser', 'desktop'].includes(facts.surface), 'invalid_request');
    need(['production', 'proof-fixture'].includes(facts.mode), 'invalid_request');
    need(isPlainObject(facts.live) && ['workspaceId', 'boxIdentity', 'boxGeneration'].every((key) => isOpaqueIdentity(facts.live[key])), 'invalid_request');
    const excluded = facts.excluded;
    need(isPlainObject(excluded) && principalList(excluded.principals) && principalList(excluded.aliases)
        && Array.isArray(excluded.runtimeInstanceIds) && excluded.runtimeInstanceIds.every(isOpaqueIdentity), 'invalid_request');
    // RoboTeam and the owning worker are always excluded; an empty exclusion set is a management error, never "none".
    need(excluded.principals.length >= 2, 'invalid_request');
    need(Array.isArray(facts.entries), 'invalid_request');
    facts.entries.forEach(checkEntry);
}

// Blank or omitted selects the ordinary backend; a nonempty selection is a Ref or its `agent:` principal.
function normalizeSelection(selection) {
    if (selection === undefined || selection === null || selection === '') return null;
    need(typeof selection === 'string', 'invalid_selection');
    const ref = selection.startsWith('agent:') ? selection.slice('agent:'.length) : selection;
    need(isRef(ref), 'invalid_selection');
    return `agent:${ref}`;
}

function excludedPrincipals(facts) {
    return new Set([...facts.excluded.principals, ...facts.excluded.aliases]);
}

function isExcludedEntry(entry, facts) {
    const names = excludedPrincipals(facts);
    if (names.has(entry.principal) || names.has(`agent:${entry.ref}`) || entry.aliases.some((alias) => names.has(alias))) return true;
    return entry.runtimeInstanceId !== null && facts.excluded.runtimeInstanceIds.includes(entry.runtimeInstanceId);
}

function resolve(selectedPrincipal, facts) {
    return facts.entries.filter((entry) => `agent:${entry.ref}` === selectedPrincipal || entry.principal === selectedPrincipal
        || entry.aliases.includes(selectedPrincipal));
}

// Trusted current facts an admitted binding is revalidated against at queued dispatch and final gate release:
//   current {worker: {principal, runtimeInstanceId, enableGeneration, generation}, limitsDigest, journalStoreIdentity}
// together with the live Box, the resolved entry, the source state and the qualification record. Every comparison is
// exact; a mismatch never re-resolves the admitted Environment.
function checkAdmittedBinding(binding, entry, facts) {
    const validated = validateTargetBinding(binding);
    need(validated.ok, 'binding_mismatch');
    const current = facts.current;
    need(isPlainObject(current) && isPlainObject(current.worker), 'binding_mismatch');
    const scope = validated.value.scope;
    const expected = {
        workspaceId: facts.live.workspaceId, boxIdentity: facts.live.boxIdentity, boxGeneration: facts.live.boxGeneration,
        workerPrincipal: current.worker.principal, workerRuntimeInstanceId: current.worker.runtimeInstanceId,
        workerEnableGeneration: current.worker.enableGeneration, workerGeneration: current.worker.generation,
        agentPrincipal: entry.principal, containerId: entry.containerId, runtimeInstanceId: entry.runtimeInstanceId,
        enableGeneration: entry.enableGeneration, helperIncarnation: entry.helperIncarnation
    };
    for (const [key, value] of Object.entries(expected)) need(scope[key] === value, 'binding_mismatch');
    return validated.value;
}

const RECORD_BOUND_DIGESTS = Object.freeze([
    'targetImageDigest', 'helperExecutableDigest', 'contractDigest', 'inventoryDigest', 'profileDigest', 'effectiveSecurityDigest'
]);

// Step 11 for an admitted binding: the qualification record it names and the target identity digests it carries must
// still be the current ones, as must the admitted limits.
function checkBindingQualification(binding, record, facts) {
    need(binding.qualificationRecordDigest === digestOf(record, 1 << 20), 'binding_mismatch');
    for (const key of RECORD_BOUND_DIGESTS) need(binding[key] === record[key], 'binding_mismatch');
    need(binding.limitsDigest === facts.current.limitsDigest, 'binding_mismatch');
}

function checkSource(facts, binding) {
    const state = facts.sourceState;
    need(isPlainObject(state) && state.record !== null && state.record !== undefined, 'source_unavailable');
    const recordResult = validateSourceProtectionRecord(state.record);
    need(recordResult.ok, 'source_unavailable');
    const record = recordResult.value;
    // A record bound to another workspace or an old Box generation never becomes launch authority.
    need(record.workspaceId === facts.live.workspaceId && record.boxIdentity === facts.live.boxIdentity
        && record.boxGeneration === facts.live.boxGeneration, 'source_unavailable');
    need(record.protectionStatus === 'protected', 'source_unprotected');
    need(!(state.repositorySourceMode === 'prod' && (state.writableBacking !== false || state.linkInstallAlias !== false)), 'source_unprotected');
    need(state.writableBacking === false, 'source_unprotected');
    need(state.aliasCoverage === 'complete', 'source_alias_unproven');
    need(Array.isArray(state.trustedAcceptances) && state.trustedAcceptances.includes(record.sourceAcceptanceIdentity)
        && state.previouslyRobotWritable === false, 'source_provenance_unaccepted');
    need(isDigest(state.currentSelectionDigest) && isDigest(state.currentClosureDigest), 'source_binding_mismatch');
    need(state.currentSelectionDigest === record.sourceSelectionDigest && state.currentClosureDigest === record.sourceClosureDigest, 'source_binding_mismatch');
    if (binding) {
        need(binding.source.sourceProtectionEpoch === record.sourceProtectionEpoch, 'stale_source_epoch');
        need(binding.source.sourceSelectionDigest === record.sourceSelectionDigest && binding.source.sourceClosureDigest === record.sourceClosureDigest
            && binding.source.sourceAcceptanceIdentity === record.sourceAcceptanceIdentity, 'source_binding_mismatch');
        // Repository metadata of the admitted source: mode, credential-free identity and revision.
        need(binding.source.repositorySourceMode === state.repositorySourceMode
            && binding.source.sourceRepositoryIdentity === state.repositoryIdentity
            && isPlainObject(state.revision) && binding.source.sourceRevision.algorithm === state.revision.algorithm
            && binding.source.sourceRevision.value === state.revision.value, 'source_binding_mismatch');
    }
}

function checkQualification(entry, facts) {
    const store = facts.qualifications;
    const raw = isPlainObject(store) && isPlainObject(store.records) && Object.hasOwn(store.records, entry.ref) ? store.records[entry.ref] : undefined;
    need(raw !== undefined && raw !== null, 'qualification_missing');
    const result = validateQualificationRecord(raw);
    if (!result.ok) {
        need(!['peer_trust_unaccepted', 'peer_authority_exposed'].includes(result.error.code), result.error.code);
        refuse('qualification_missing');
    }
    const record = result.value;
    // Syntactic validity cannot install a record: acceptance must name a trusted acceptance record.
    need(Array.isArray(store.trustedAcceptances) && store.trustedAcceptances.includes(record.acceptedBy)
        && record.acceptedBy !== entry.principal && !entry.aliases.includes(record.acceptedBy), 'qualification_untrusted');
    need(record.qualificationClass === facts.mode, 'qualification_class');
    const scope = record.scope;
    const expected = {
        workspaceId: facts.live.workspaceId, boxIdentity: facts.live.boxIdentity, boxGeneration: facts.live.boxGeneration,
        agentPrincipal: entry.principal, containerId: entry.containerId, runtimeInstanceId: entry.runtimeInstanceId,
        enableGeneration: entry.enableGeneration, helperIncarnation: entry.helperIncarnation
    };
    for (const [key, value] of Object.entries(expected)) need(scope[key] === value, 'qualification_scope');
    if (record.qualificationClass === 'proof-fixture') {
        // The worker half of the scope is the current worker exactly (a record of an older worker generation never admits).
        const worker = isPlainObject(facts.current) ? facts.current.worker : null;
        need(isPlainObject(worker) && scope.workerPrincipal === worker.principal && scope.workerRuntimeInstanceId === worker.runtimeInstanceId
            && scope.workerEnableGeneration === worker.enableGeneration && scope.workerGeneration === worker.generation, 'qualification_scope');
        const request = facts.request;
        need(isPlainObject(request) && isPrincipal(request.coordinatorPrincipal) && isOperationId(request.operationId)
            && Number.isSafeInteger(request.nowMs), 'qualification_scope');
        const fixture = record.fixture;
        need(request.coordinatorPrincipal === fixture.coordinatorPrincipal, 'qualification_scope');
        need(fixture.operationIds.includes(request.operationId), 'qualification_scope');
        need(request.nowMs >= fixture.notBeforeMs && request.nowMs < fixture.notAfterMs, 'qualification_scope');
        const used = isPlainObject(store.executionsUsed) && Object.hasOwn(store.executionsUsed, entry.ref) ? store.executionsUsed[entry.ref] : 0;
        need(Number.isSafeInteger(used) && used >= 0, 'invalid_request');
        need(used < fixture.maxExecutions, 'capacity_exceeded');
    }
    return record;
}

// Proof-fixture activation (erratum A10). Admits only in proof-fixture mode with a proof-fixture record whose scope
// (checked by `checkQualification`, including its worker half) matches. A production-mode request never reaches this
// path with a fixture record (qualification_class refuses earlier) and a production record never activates here.
function proofFixtureActivation(record, facts) {
    return facts.mode === 'proof-fixture' && record.qualificationClass === 'proof-fixture';
}

function checkAttestation(entry, record, facts, binding) {
    const attestation = entry.attestation;
    need(isPlainObject(attestation), 'target_attestation_mismatch');
    for (const key of ['targetImageDigest', 'helperExecutableDigest', 'contractDigest', 'inventoryDigest', 'profileDigest', 'effectiveSecurityDigest', 'channelSchemaDigest']) {
        need(attestation[key] === record[key], 'target_attestation_mismatch');
    }
    // HOME: the original anchored HOME and both directed transitions must be qualified; nothing is migrated or reset.
    const home = facts.home;
    const compatibility = record.homeCompatibility;
    need(isPlainObject(home) && home.homeIdentity === compatibility.homeIdentity, 'home_incompatible');
    const permitted = (from, to) => compatibility.transitions.some((entry) => entry.backendId === home.backendId
        && entry.fromInventoryDigest === from && entry.toInventoryDigest === to);
    need(permitted(home.workerInventoryDigest, home.targetInventoryDigest), 'home_incompatible');
    need(permitted(home.targetInventoryDigest, home.workerInventoryDigest), 'home_incompatible');
    if (binding) need(binding.homeCompatibilityDigest === digestOf(compatibility), 'home_incompatible');
}

// The full eligibility chain for one resolved selection, in the A1.7 precedence order.
function evaluate(selectedPrincipal, facts) {
    // 2. Excluded literal canonical principal (also a stale saved spelling that no longer resolves).
    need(!excludedPrincipals(facts).has(selectedPrincipal), 'target_excluded');
    // 3. Missing or ambiguous trusted resolution; never a blank fallback.
    const matches = resolve(selectedPrincipal, facts);
    need(matches.length > 0, 'target_missing');
    need(matches.length === 1, 'target_ambiguous');
    const entry = matches[0];
    // 4. Excluded resolved principal, alias or runtime identity.
    need(!isExcludedEntry(entry, facts), 'target_excluded');
    // 5. Wrong workspace or Box; for an admitted binding the exact recorded live scope.
    const binding = facts.admittedBinding ? checkAdmittedBinding(facts.admittedBinding, entry, facts) : null;
    need(entry.workspaceId === facts.live.workspaceId && entry.boxIdentity === facts.live.boxIdentity
        && entry.boxGeneration === facts.live.boxGeneration, 'target_scope_mismatch');
    // 6. Disabled, stopped, non-container or non-global.
    need(entry.enabled === true && entry.running === true && entry.runtime === 'container' && entry.placement === 'global'
        && entry.containerId !== null && entry.runtimeInstanceId !== null && entry.helperIncarnation !== null, 'target_not_eligible');
    // 7. Missing or invalid declaration (agentExec or executionProvider are never a target opt-in).
    need(entry.declaration !== null && entry.declaration !== undefined, 'target_contract_missing');
    need(isPlainObject(entry.declaration) && entry.declaration.valid === true, 'target_contract_invalid');
    // 8. Source protection.
    checkSource(facts, binding);
    // 9. Missing preparation or journal.
    need(entry.prepared === true, 'target_unprepared');
    need(entry.journal === 'available', 'journal_unavailable');
    // The admitted journal store is still the target's: a replaced journal is never reused.
    if (binding) need(binding.journalStoreIdentity === facts.current.journalStoreIdentity, 'binding_mismatch');
    // 10. Qualification class and scope.
    const record = checkQualification(entry, facts);
    // 11. Security, profile, inventory, HOME and channel mismatch.
    checkAttestation(entry, record, facts, binding);
    if (binding) checkBindingQualification(binding, record, facts);
    // 12. Capacity.
    need(entry.activeExecutions < TARGET_LIMITS_V1.executionsPerTarget, 'capacity_exceeded');
    // 13. No activated production backend; only the proof-fixture path above can admit.
    need(BACKEND_ACTIVATED || proofFixtureActivation(record, facts), 'backend_not_activated');
    return { entry, record };
}

function decide(check) {
    try {
        return Object.freeze({ ok: true, value: deepFreeze(check()) });
    } catch (error) {
        return failure(error instanceof Decision ? error.code : 'invalid_request');
    }
}

// Admission-time decision. Blank or omitted selection: {backend: 'ordinary'}. A nonempty selection is terminal-only and
// is satisfied only by a proof-fixture admission, {backend: 'target', ...}; never by the ordinary backend, never in
// production mode.
export function requireExecutionTarget(selection, facts) {
    return decide(() => {
        checkFacts(facts);
        // 1. Malformed selection, including a nonempty selection on a non-terminal surface.
        const selectedPrincipal = normalizeSelection(selection);
        if (selectedPrincipal === null) return { backend: 'ordinary' };
        need(facts.surface === 'terminal', 'environment_not_terminal');
        const { entry, record } = evaluate(selectedPrincipal, facts);
        return {
            backend: 'target', ref: entry.ref, principal: entry.principal, qualificationClass: record.qualificationClass,
            qualificationRecordDigest: digestOf(record, 1 << 20)
        };
    });
}

function safeLabel(entry) {
    const label = entry.label;
    if (typeof label === 'string' && label.isWellFormed() && utf8Bytes(label) >= 1 && utf8Bytes(label) <= 128
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(label)) return label;
    return entry.ref;
}

// Inventory projection for a terminal target picker. Excluded identities (RoboTeam, the owning worker, by principal,
// alias or runtime identity) are omitted; a listed target is unavailable with the first refusal reason, or available with
// reason null only on the proof-fixture path. Overflow of
// 256 targets or 64 KiB refuses the whole inventory (capacity_exceeded); nothing is truncated.
export function projectExecutionTargets({ entries, trustedIdentities, qualificationStore, sourceState, mode } = {}) {
    return decide(() => {
        need(isPlainObject(trustedIdentities), 'invalid_request');
        const facts = {
            surface: 'terminal', mode, live: trustedIdentities.live, excluded: trustedIdentities.excluded, entries,
            sourceState, qualifications: qualificationStore, request: trustedIdentities.request ?? null,
            home: trustedIdentities.home ?? null, admittedBinding: null, current: trustedIdentities.current ?? null
        };
        checkFacts(facts);
        const targets = [];
        for (const entry of facts.entries) {
            if (isExcludedEntry(entry, facts)) continue;
            let reason;
            try {
                evaluate(`agent:${entry.ref}`, facts);
                reason = null;
            } catch (error) {
                if (!(error instanceof Decision)) throw error;
                reason = error.code;
            }
            targets.push({ ref: entry.ref, label: safeLabel(entry), available: reason === null, reason });
        }
        targets.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
        need(targets.length <= INVENTORY_MAX_TARGETS, 'capacity_exceeded');
        const projection = { version: 1, targets };
        need(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= INVENTORY_MAX_BYTES, 'capacity_exceeded');
        return projection;
    });
}

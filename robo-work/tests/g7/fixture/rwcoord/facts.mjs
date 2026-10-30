#!/usr/bin/env node
// rwcoord OPERATOR tool (slice P7, PROOF-FIXTURE): writes the front's base facts files and the proof-fixture
// qualification record from operator-observed live values. LIVE values come from Ploinky/Podman observation (the input
// file); FIXTURE values are labelled, synthetic and derived from fixed labels (Ploinky produces no discovery caller,
// source facts, HOME or effective-security facts for this fixture yet). The record's operation IDs are derived from the
// coordinator principal and the origin request IDs with the same rule the front applies to a verified hop, so only
// those origins can pass the qualification step.
//
//   node facts.mjs --live <live.json> --out <new dir> [--now-ms <n>]
//
// live.json: {workspaceId, boxIdentity, boxGeneration, coordinator, staleWorkerAlias, candidateDigest,
//   worker: {principal, runtimeInstanceId, enableGeneration, generation},
//   target: {ref, instanceId, containerId, enableGeneration, helperIncarnation, running, journalAvailable, journalStoreIdentity,
//            imageDigest, helperExecutableDigest, contractDigest, inventoryDigest, profileDigest, peerDigest},
//   platform: {kernelRelease, runtimeVersion}, originSeeds: [text, ...] (1-8, the admissible origins)}
// Writes: facts-base.json (FIXTURE source state), facts-ploinky-source.json (record from Ploinky's state operation),
// facts-unprepared.json, facts-no-source-unprepared.json, record.json (canonical), plan.json (origins, operation IDs,
// labels). Run it as the worker uid; install record.json with the operator record tool, never from a target or robot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalTargetJson } from '../../../../server/executionTarget/contract.mjs';
import { deriveTargetOperationId } from './admissionFront.mjs';
import { originIdFor } from './coordinator.mjs';

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const fx = (label) => sha(`p7-fixture-supplied:${label}`);
const fid = (label) => crypto.createHash('sha256').update(`p7-fixture-id:${label}`).digest().subarray(0, 16).toString('base64url');
const CELLS = ['workerStore', 'otherRobotHomes', 'qualificationRecords', 'sourceAcceptanceRecords', 'executionReceipts', 'helperJournal', 'mailbox', 'credentials', 'robotProcAndDescriptors', 'workloadChannels'];

export function buildFixture(live, nowMs) {
    const liveScope = { workspaceId: live.workspaceId, boxIdentity: live.boxIdentity, boxGeneration: live.boxGeneration };
    const target = live.target;
    const worker = live.worker;
    if (!Array.isArray(live.originSeeds) || live.originSeeds.length < 1 || live.originSeeds.length > 8) throw new Error('originSeeds must name 1 to 8 origins');
    const origins = Object.fromEntries(live.originSeeds.map((seed) => [seed, originIdFor(seed)]));
    const operationIds = [...new Set(Object.values(origins).map((originRequestId) => deriveTargetOperationId({ coordinator: live.coordinator, originRequestId })))].sort();
    const attestation = {
        targetImageDigest: `sha256:${target.imageDigest}`, helperExecutableDigest: target.helperExecutableDigest, contractDigest: target.contractDigest,
        inventoryDigest: target.inventoryDigest, profileDigest: target.profileDigest, effectiveSecurityDigest: fx('effective-security'), channelSchemaDigest: fx('channel-schema')
    };
    const principal = `agent:${target.ref}`;
    const entry = {
        ref: target.ref, label: target.ref.split('/')[1], principal, aliases: [], runtimeInstanceId: target.instanceId,
        containerId: target.containerId, enableGeneration: target.enableGeneration, helperIncarnation: target.helperIncarnation, ...liveScope,
        enabled: true, running: target.running === true, runtime: 'container', placement: 'global', declaration: { valid: true }, prepared: true,
        journal: target.journalAvailable ? 'available' : 'unavailable', attestation, activeExecutions: 0
    };
    // FIXTURE: an entry that resolves to the owning worker's own runtime instance under another name (a replacement or
    // alias spelling); the front must exclude it by runtime identity although the base facts do not list that identity.
    const [repo] = target.ref.split('/');
    const shadow = { ...entry, ref: `${repo}/rwshadow`, label: 'rwshadow', principal: `agent:${repo}/rwshadow`, runtimeInstanceId: worker.runtimeInstanceId };
    const source = {
        repositorySourceMode: 'prod', sourceRepositoryIdentity: 'https://example.invalid/p7/rwtarget.git', sourceRevision: { algorithm: 'git-sha1', value: 'a'.repeat(40) },
        sourceProtectionEpoch: 1, sourceSelectionDigest: fx('source-selection'), sourceClosureDigest: fx('source-closure'), sourceAcceptanceIdentity: 'p7-source-acceptance'
    };
    const homeCompatibility = {
        version: 1, homeIdentity: 'p7-home-1',
        transitions: [
            { backendId: 'claude', fromInventoryDigest: fx('inv-target'), toInventoryDigest: fx('inv-worker'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: fx('home-ev-1') },
            { backendId: 'claude', fromInventoryDigest: fx('inv-worker'), toInventoryDigest: fx('inv-target'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: fx('home-ev-2') }
        ].sort((left, right) => (left.fromInventoryDigest < right.fromInventoryDigest ? -1 : 1))
    };
    const record = {
        version: 1, qualificationClass: 'proof-fixture',
        scope: {
            ...liveScope, workerPrincipal: worker.principal, workerRuntimeInstanceId: worker.runtimeInstanceId, workerEnableGeneration: worker.enableGeneration,
            workerGeneration: worker.generation, agentPrincipal: principal, containerId: target.containerId, runtimeInstanceId: target.instanceId,
            enableGeneration: target.enableGeneration, helperIncarnation: target.helperIncarnation
        },
        fixture: { coordinatorPrincipal: live.coordinator, fixtureId: fid('fixture'), authorizationDigest: fx('authorization'), operationIds, maxExecutions: 8, notBeforeMs: nowMs - 60000, notAfterMs: nowMs + 6 * 3600000 },
        source,
        targetImageDigest: attestation.targetImageDigest, helperExecutableDigest: attestation.helperExecutableDigest, contractDigest: attestation.contractDigest,
        inventoryDigest: attestation.inventoryDigest, profileDigest: attestation.profileDigest, effectiveSecurityDigest: attestation.effectiveSecurityDigest,
        limitsDigest: fx('limits'), inputSchemaDigest: fx('input-schema'), channelSchemaDigest: attestation.channelSchemaDigest,
        platform: {
            hostPlatform: 'linux-amd64', kernelRelease: live.platform.kernelRelease, kernelBuildDigest: fx('kernel-build'), runtimeName: 'podman', runtimeVersion: live.platform.runtimeVersion,
            runtimeConfigDigest: fx('runtime-config'), uidMappingDigest: fx('uid-map'), gidMappingDigest: fx('gid-map'), boxPolicyDigest: fx('box-policy'),
            targetProcBaselineDigest: fx('target-proc'), workloadProcPolicyDigest: fx('workload-proc')
        },
        peerTrustInventory: [{ classId: 'target-peer', executableClosureDigest: target.peerDigest, trustClass: 'untrusted-peer', existingTrustEvidenceDigest: null, access: Object.fromEntries(CELLS.map((cell) => [cell, 'deny'])) }],
        homeCompatibility,
        // No G7 package exists for P7: labelled placeholders, not A10 evidence.
        evidence: { candidateManifestDigest: live.candidateDigest, g7EvidenceDigest: fx('no-g7-package-p7'), independentVerificationDigest: fx('no-g7-review-p7') },
        acceptedBy: 'p7-operator-acceptance', acceptedAtMs: nowMs
    };
    const sourceState = {
        record: {
            version: 1, ...liveScope, sourceProtectionEpoch: 1, sourceSelectionDigest: source.sourceSelectionDigest, sourceClosureDigest: source.sourceClosureDigest,
            sourceAcceptanceIdentity: source.sourceAcceptanceIdentity, sourceStoreIdentity: fid('source-store'), protectionStatus: 'protected',
            enforcementDigest: fx('enforcement'), aliasCoverageDigest: fx('alias-coverage'), acceptedAtMs: nowMs
        },
        currentSelectionDigest: source.sourceSelectionDigest, currentClosureDigest: source.sourceClosureDigest, aliasCoverage: 'complete',
        trustedAcceptances: [source.sourceAcceptanceIdentity], previouslyRobotWritable: false, writableBacking: false, linkInstallAlias: false,
        repositorySourceMode: 'prod', repositoryIdentity: source.sourceRepositoryIdentity, revision: source.sourceRevision
    };
    const { record: _fixtureRecord, ...supplement } = sourceState;
    const base = {
        live: liveScope,
        // The front adds RoboTeam, the owning worker (principal and runtime identity) and the verified coordinator itself.
        excluded: { principals: [], aliases: [live.staleWorkerAlias], runtimeInstanceIds: [] },
        entries: [entry, shadow], sourceState,
        home: { homeIdentity: 'p7-home-1', backendId: 'claude', workerInventoryDigest: fx('inv-worker'), targetInventoryDigest: fx('inv-target') },
        current: { limitsDigest: record.limitsDigest, journalStoreIdentity: target.journalStoreIdentity }
    };
    const unprepared = { ...base, entries: [{ ...entry, prepared: false }, shadow] };
    const variants = {
        'facts-base.json': base,
        'facts-ploinky-source.json': { ...base, sourceState: { provider: 'ploinky', supplement } },
        'facts-unprepared.json': unprepared,
        // Two faults at once: source protection (step 8) precedes preparation (step 9).
        'facts-no-source-unprepared.json': { ...unprepared, sourceState: { ...sourceState, record: null } }
    };
    const labels = {
        live: ['live', 'entries[0].containerId/runtimeInstanceId/enableGeneration/helperIncarnation/running/journal', 'current.journalStoreIdentity',
            'attestation.targetImageDigest/helperExecutableDigest/contractDigest/inventoryDigest/profileDigest', 'record.scope.worker* (Ploinky worker identity)'],
        fixture: ['sourceState (facts-base)', 'sourceState.supplement (facts-ploinky-source)', 'entries[1] rwshadow', 'excluded.aliases', 'home',
            'attestation.effectiveSecurityDigest/channelSchemaDigest', 'current.limitsDigest', 'record.scope.workerGeneration', 'record.platform digests', 'record.evidence']
    };
    return { variants, record, plan: { coordinator: live.coordinator, origins, operationIds, labels } };
}

function main(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) options[argv[index]] = argv[index + 1];
    if (typeof options['--live'] !== 'string' || typeof options['--out'] !== 'string') throw new Error('usage: facts.mjs --live <live.json> --out <new dir> [--now-ms <n>]');
    const live = JSON.parse(fs.readFileSync(options['--live'], 'utf8'));
    const nowMs = options['--now-ms'] ? Number(options['--now-ms']) : Date.now();
    const { variants, record, plan } = buildFixture(live, nowMs);
    const out = path.resolve(options['--out']);
    fs.mkdirSync(out, { mode: 0o700 });
    for (const [name, value] of Object.entries(variants)) fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 1)}\n`, { flag: 'wx', mode: 0o600 });
    const canonical = canonicalTargetJson(record, { maxBytes: 1 << 20 });
    if (!canonical.ok) throw new Error(`record refused: ${canonical.error.code}`);
    fs.writeFileSync(path.join(out, 'record.json'), canonical.value, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ out, operationIds: plan.operationIds, origins: plan.origins })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`facts: ${String(error.message).slice(0, 300)}\n`);
        process.exitCode = 1;
    }
}

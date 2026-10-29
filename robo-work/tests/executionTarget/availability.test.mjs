// SYNTHETIC availability and admission decisions (availability.mjs). All principals, runtime identities and records are
// synthetic test doubles; generic T1 has no activated target backend.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { projectExecutionTargets, requireExecutionTarget, AVAILABILITY_ERROR_CODES } from '../../server/executionTarget/availability.mjs';
import { targetDigest, validateSourceClosure } from '../../server/executionTarget/contract.mjs';

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`synthetic-digest:${label}`);
const clone = (value) => JSON.parse(JSON.stringify(value));

const ROBOTEAM = 'agent:SyntheticIDE/roboTeamAgent';
const WORKER = 'agent:SyntheticIDE/roboWork';
const ROBOTEAM_OLD_SPELLING = 'agent:SyntheticCLI/roboTeamAgent';
const WORKER_ALIAS = 'agent:SyntheticIDE/robo-work';
const WORKER_RUNTIME = 'worker-runtime-1';
const ROBOTEAM_RUNTIME = 'roboteam-runtime-1';
const TARGET = 'SyntheticRepo/target';

const DENY_ALL = {
    workerStore: 'deny', otherRobotHomes: 'deny', qualificationRecords: 'deny', sourceAcceptanceRecords: 'deny', executionReceipts: 'deny',
    helperJournal: 'deny', mailbox: 'deny', credentials: 'deny', robotProcAndDescriptors: 'deny', workloadChannels: 'deny'
};

function entry(overrides = {}) {
    return {
        ref: TARGET, label: 'Synthetic target', principal: `agent:${TARGET}`, aliases: [], runtimeInstanceId: 'target-instance-1',
        containerId: 'c'.repeat(64), enableGeneration: 'target-enable-1', helperIncarnation: sid('helper-1'), workspaceId: 'ws-synthetic',
        boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', enabled: true, running: true, runtime: 'container', placement: 'global',
        declaration: { valid: true }, prepared: true, journal: 'available',
        attestation: {
            targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractDigest: sdg('contract'),
            inventoryDigest: sdg('inventory'), profileDigest: sdg('profile'), effectiveSecurityDigest: sdg('security'), channelSchemaDigest: sdg('channel-schema')
        },
        activeExecutions: 0, ...overrides
    };
}

function record() {
    return {
        version: 1, workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', sourceProtectionEpoch: 3,
        sourceSelectionDigest: sdg('selection'), sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-synthetic-1',
        sourceStoreIdentity: sid('store-a'), protectionStatus: 'protected', enforcementDigest: sdg('enforcement'), aliasCoverageDigest: sdg('alias'),
        acceptedAtMs: 1700000000000
    };
}

function qualification(qualificationClass = 'production', target = entry()) {
    return {
        version: 1, qualificationClass,
        scope: {
            workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', workerPrincipal: WORKER,
            workerRuntimeInstanceId: WORKER_RUNTIME, workerEnableGeneration: 'worker-enable-1', workerGeneration: sid('worker-gen'),
            agentPrincipal: target.principal, containerId: target.containerId, runtimeInstanceId: target.runtimeInstanceId,
            enableGeneration: target.enableGeneration, helperIncarnation: target.helperIncarnation
        },
        fixture: qualificationClass === 'production' ? null : {
            coordinatorPrincipal: 'agent:SyntheticRepo/coordinator', fixtureId: sid('fixture'), authorizationDigest: sdg('authorization'),
            operationIds: [sid('op-a'), sid('op-b')].sort(), maxExecutions: 2, notBeforeMs: 1000, notAfterMs: 1000 + 3600000
        },
        source: {
            repositorySourceMode: 'prod', sourceRepositoryIdentity: 'https://example.invalid/synthetic/target.git',
            sourceRevision: { algorithm: 'git-sha1', value: 'a'.repeat(40) }, sourceProtectionEpoch: 3, sourceSelectionDigest: sdg('selection'),
            sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-synthetic-1'
        },
        targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractDigest: sdg('contract'), inventoryDigest: sdg('inventory'),
        profileDigest: sdg('profile'), effectiveSecurityDigest: sdg('security'), limitsDigest: sdg('limits'), inputSchemaDigest: sdg('input-schema'),
        channelSchemaDigest: sdg('channel-schema'),
        platform: {
            hostPlatform: 'darwin-linux-arm64', kernelRelease: '6.8.0-synthetic', kernelBuildDigest: sdg('kernel'), runtimeName: 'docker',
            runtimeVersion: '27.0.0-synthetic', runtimeConfigDigest: sdg('runtime'), uidMappingDigest: sdg('uid'), gidMappingDigest: sdg('gid'),
            boxPolicyDigest: sdg('box'), targetProcBaselineDigest: sdg('proc'), workloadProcPolicyDigest: sdg('workload-proc')
        },
        peerTrustInventory: [
            { classId: 'target-service', executableClosureDigest: sdg('target-closure'), trustClass: 'untrusted-peer', existingTrustEvidenceDigest: null, access: { ...DENY_ALL } }
        ],
        homeCompatibility: {
            version: 1, homeIdentity: 'home-synthetic-1',
            transitions: [
                { backendId: 'claude', fromInventoryDigest: sdg('inv-target'), toInventoryDigest: sdg('inv-worker'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-1') },
                { backendId: 'claude', fromInventoryDigest: sdg('inv-worker'), toInventoryDigest: sdg('inv-target'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-2') }
            ].sort((l, r) => (l.fromInventoryDigest < r.fromInventoryDigest ? -1 : 1))
        },
        evidence: { candidateManifestDigest: sdg('candidate'), g7EvidenceDigest: sdg('g7'), independentVerificationDigest: sdg('verification') },
        acceptedBy: 'acceptance-record-synthetic-1', acceptedAtMs: 1700000000000
    };
}

function facts(overrides = {}) {
    return {
        surface: 'terminal', mode: 'production', live: { workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1' },
        excluded: { principals: [ROBOTEAM, WORKER], aliases: [ROBOTEAM_OLD_SPELLING, WORKER_ALIAS], runtimeInstanceIds: [WORKER_RUNTIME, ROBOTEAM_RUNTIME] },
        entries: [entry()],
        sourceState: {
            record: record(), currentSelectionDigest: sdg('selection'), currentClosureDigest: sdg('closure'), aliasCoverage: 'complete',
            trustedAcceptances: ['acceptance-synthetic-1'], previouslyRobotWritable: false, writableBacking: false, linkInstallAlias: false,
            repositorySourceMode: 'prod', repositoryIdentity: 'https://example.invalid/synthetic/target.git', revision: { algorithm: 'git-sha1', value: 'a'.repeat(40) }
        },
        qualifications: { records: { [TARGET]: qualification() }, trustedAcceptances: ['acceptance-record-synthetic-1'], executionsUsed: {} },
        request: { coordinatorPrincipal: 'agent:SyntheticRepo/coordinator', operationId: sid('op-a'), nowMs: 2000 },
        home: { homeIdentity: 'home-synthetic-1', backendId: 'claude', workerInventoryDigest: sdg('inv-worker'), targetInventoryDigest: sdg('inv-target') },
        admittedBinding: null,
        current: {
            worker: { principal: WORKER, runtimeInstanceId: WORKER_RUNTIME, enableGeneration: 'worker-enable-1', generation: sid('worker-gen') },
            limitsDigest: sdg('limits'), journalStoreIdentity: sid('journal')
        },
        ...overrides
    };
}

function admittedBinding() {
    const target = entry();
    return {
        version: 1,
        scope: {
            workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', workerPrincipal: WORKER,
            workerRuntimeInstanceId: WORKER_RUNTIME, workerEnableGeneration: 'worker-enable-1', workerGeneration: sid('worker-gen'),
            agentPrincipal: target.principal, containerId: target.containerId, runtimeInstanceId: target.runtimeInstanceId,
            enableGeneration: target.enableGeneration, helperIncarnation: target.helperIncarnation
        },
        source: clone(qualification().source), targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractVersion: 1,
        contractDigest: sdg('contract'), inventoryDigest: sdg('inventory'), profileDigest: sdg('profile'), limitsDigest: sdg('limits'),
        qualificationRecordDigest: targetDigest(qualification()).value, effectiveSecurityDigest: sdg('security'), journalStoreIdentity: sid('journal'),
        robotId: sid('robot'), executionId: sid('exec'), attemptId: sid('attempt'), configRevision: 1, grantPolicyDigest: sdg('grants'),
        inputManifestDigest: sdg('input'), skillViewManifestDigest: sdg('skills'), nativeConfigProjectionDigest: sdg('native'),
        channelManifestDigest: sdg('channels'), homeCompatibilityDigest: targetDigest(qualification().homeCompatibility).value
    };
}

function expectCode(selection, value, code, label) {
    const before = clone(value);
    const result = requireExecutionTarget(selection, value);
    assert.deepEqual(result, { ok: false, error: { code } }, label);
    assert.ok(AVAILABILITY_ERROR_CODES.includes(code), `${code} enumerated`);
    assert.deepEqual(value, before, `${label}: facts unchanged`);
}

test('blank or omitted selection selects the ordinary backend; a fully eligible target is backend_not_activated in T1', () => {
    for (const selection of [undefined, null, '']) {
        assert.deepEqual(requireExecutionTarget(selection, facts()), { ok: true, value: { backend: 'ordinary' } });
        assert.deepEqual(requireExecutionTarget(selection, facts({ surface: 'browser' })), { ok: true, value: { backend: 'ordinary' } });
    }
    expectCode(TARGET, facts(), 'backend_not_activated', 'eligible by ref');
    expectCode(`agent:${TARGET}`, facts(), 'backend_not_activated', 'eligible by principal');
    expectCode(TARGET, facts({ admittedBinding: admittedBinding() }), 'backend_not_activated', 'admitted binding revalidated');
    const fixtureFacts = facts({ mode: 'proof-fixture', qualifications: { records: { [TARGET]: qualification('proof-fixture') }, trustedAcceptances: ['acceptance-record-synthetic-1'], executionsUsed: { [TARGET]: 1 } } });
    expectCode(TARGET, fixtureFacts, 'backend_not_activated', 'proof-fixture mode');
    assert.ok(Object.isFrozen(AVAILABILITY_ERROR_CODES));
});

test('AVL-01 RoboTeam selected by its canonical principal is target_excluded', () => {
    const roboteam = entry({ ref: 'SyntheticIDE/roboTeamAgent', principal: ROBOTEAM, runtimeInstanceId: ROBOTEAM_RUNTIME });
    expectCode('SyntheticIDE/roboTeamAgent', facts({ entries: [roboteam] }), 'target_excluded', 'ref');
    expectCode(ROBOTEAM, facts({ entries: [roboteam] }), 'target_excluded', 'principal');
    expectCode(WORKER, facts(), 'target_excluded', 'owning worker principal, no entry');
});

test('AVL-02 the owning worker selected through its runtime identity is target_excluded', () => {
    const disguised = entry({ ref: 'Other/agent', principal: 'agent:Other/agent', runtimeInstanceId: WORKER_RUNTIME });
    expectCode('Other/agent', facts({ entries: [disguised] }), 'target_excluded', 'worker runtime identity under another name');
    const roboteamRuntime = entry({ ref: 'Other/agent', principal: 'agent:Other/agent', runtimeInstanceId: ROBOTEAM_RUNTIME });
    expectCode('Other/agent', facts({ entries: [roboteamRuntime] }), 'target_excluded', 'RoboTeam runtime identity');
});

test('AVL-03 an alias or repository alias resolving to an excluded principal is target_excluded', () => {
    const renamed = entry({ ref: 'Renamed/robo', principal: ROBOTEAM, aliases: ['agent:Renamed/robo'], runtimeInstanceId: 'fresh-instance' });
    expectCode('Renamed/robo', facts({ entries: [renamed] }), 'target_excluded', 'repository rename');
    const aliased = entry({ ref: 'Plain/agent', principal: 'agent:Plain/agent', aliases: [WORKER_ALIAS], runtimeInstanceId: 'fresh-instance' });
    expectCode('Plain/agent', facts({ entries: [aliased] }), 'target_excluded', 'entry carries an excluded alias');
    const viaAlias = entry({ ref: 'Plain/agent', principal: WORKER, aliases: ['agent:Nick/name'], runtimeInstanceId: 'fresh-instance' });
    expectCode('Nick/name', facts({ entries: [viaAlias] }), 'target_excluded', 'selection alias resolves to the worker');
});

test('AVL-04 a stale saved excluded spelling or a replacement generation stays target_excluded, even unresolved', () => {
    expectCode(ROBOTEAM_OLD_SPELLING, facts({ entries: [] }), 'target_excluded', 'unresolved stale spelling');
    expectCode('SyntheticCLI/roboTeamAgent', facts(), 'target_excluded', 'stale spelling as a ref');
    const replacement = entry({ ref: 'SyntheticIDE/roboTeamAgent', principal: ROBOTEAM, runtimeInstanceId: 'roboteam-runtime-2', enableGeneration: 'enable-9', containerId: 'd'.repeat(64) });
    expectCode('SyntheticIDE/roboTeamAgent', facts({ entries: [replacement] }), 'target_excluded', 'replacement instance');
});

test('AVL-05 unknown or ambiguous saved selections refuse and never fall back to the ordinary backend', () => {
    expectCode('Unknown/agent', facts(), 'target_missing', 'unknown');
    const twin = entry({ ref: 'Twin/agent', principal: 'agent:Twin/agent', aliases: [`agent:${TARGET}`] });
    expectCode(TARGET, facts({ entries: [entry(), twin] }), 'target_ambiguous', 'alias collision');
    expectCode('a/b/c', facts(), 'invalid_selection', 'malformed');
    expectCode('../x', facts(), 'invalid_selection', 'dot-dot component');
    expectCode(42, facts(), 'invalid_selection', 'non-string');
});

test('AVL-06 a nonempty Environment on Browser or Desktop is environment_not_terminal', () => {
    for (const surface of ['browser', 'desktop']) {
        expectCode(TARGET, facts({ surface }), 'environment_not_terminal', surface);
        expectCode(ROBOTEAM, facts({ surface }), 'environment_not_terminal', `${surface} excluded`);
    }
});

test('refusal precedence follows A1.7 exactly: each fix reveals the next refusal', () => {
    const broken = facts({
        entries: [entry({ workspaceId: 'ws-other', enabled: false, declaration: null, prepared: false, journal: 'missing', activeExecutions: 8, attestation: { ...entry().attestation, profileDigest: sdg('other') } })],
        sourceState: { ...facts().sourceState, record: null },
        qualifications: { records: {}, trustedAcceptances: [], executionsUsed: {} },
        home: { ...facts().home, homeIdentity: 'home-other' }
    });
    const steps = [
        ['target_scope_mismatch', (f) => { f.entries[0].workspaceId = 'ws-synthetic'; }],
        ['target_not_eligible', (f) => { f.entries[0].enabled = true; }],
        ['target_contract_missing', (f) => { f.entries[0].declaration = { valid: true }; }],
        ['source_unavailable', (f) => { f.sourceState.record = record(); }],
        ['target_unprepared', (f) => { f.entries[0].prepared = true; }],
        ['journal_unavailable', (f) => { f.entries[0].journal = 'available'; }],
        ['qualification_missing', (f) => { f.qualifications.records[TARGET] = qualification(); }],
        ['qualification_untrusted', (f) => { f.qualifications.trustedAcceptances = ['acceptance-record-synthetic-1']; }],
        ['target_attestation_mismatch', (f) => { f.entries[0].attestation = entry().attestation; }],
        ['home_incompatible', (f) => { f.home = facts().home; }],
        ['capacity_exceeded', (f) => { f.entries[0].activeExecutions = 7; }],
        ['backend_not_activated', () => {}]
    ];
    const value = clone(broken);
    for (const [code, fix] of steps) {
        expectCode(TARGET, value, code, `precedence ${code}`);
        fix(value);
    }
});

test('ineligible runtime shapes: disabled, stopped, native, non-global, invalid declaration', () => {
    for (const [label, change] of [['disabled', { enabled: false }], ['stopped', { running: false }], ['native', { runtime: 'native' }], ['non-global', { placement: 'local' }], ['no container', { containerId: null }]]) {
        expectCode(TARGET, facts({ entries: [entry(change)] }), 'target_not_eligible', label);
    }
    expectCode(TARGET, facts({ entries: [entry({ declaration: { valid: false } })] }), 'target_contract_invalid', 'invalid declaration is not absence');
});

test('BND-01 and BND-03 an admitted binding is compared exactly and never re-resolved', () => {
    const fields = [
        ['workspace', (b) => { b.scope.workspaceId = 'ws-other'; }],
        ['Box', (b) => { b.scope.boxIdentity = 'box-other'; }],
        ['Box generation', (b) => { b.scope.boxGeneration = 'box-gen-2'; }],
        ['container', (b) => { b.scope.containerId = 'e'.repeat(64); }],
        ['runtime instance', (b) => { b.scope.runtimeInstanceId = 'target-instance-2'; }],
        ['enable generation', (b) => { b.scope.enableGeneration = 'target-enable-2'; }],
        ['helper incarnation', (b) => { b.scope.helperIncarnation = sid('helper-2'); }],
        ['agent principal', (b) => { b.scope.agentPrincipal = 'agent:Other/target'; }]
    ];
    for (const [label, mutate] of fields) {
        const binding = admittedBinding();
        mutate(binding);
        expectCode(TARGET, facts({ admittedBinding: binding }), 'binding_mismatch', `BND-01 ${label}`);
    }
    // BND-03: the same target name now resolves to a replacement container; the admitted binding is not re-resolved.
    const replacement = entry({ containerId: 'f'.repeat(64), runtimeInstanceId: 'target-instance-9' });
    expectCode(TARGET, facts({ entries: [replacement], admittedBinding: admittedBinding() }), 'binding_mismatch', 'BND-03 replacement container');
    expectCode(TARGET, facts({ admittedBinding: { ...admittedBinding(), unexpected: 1 } }), 'binding_mismatch', 'malformed binding');
});

test('BND-02 full binding revalidation at queued dispatch and final release: one mutation per bound field', () => {
    expectCode(TARGET, facts({ admittedBinding: admittedBinding() }), 'backend_not_activated', 'the unchanged admitted binding');
    const bindingMutations = [
        ['scope.workerPrincipal', (b) => { b.scope.workerPrincipal = 'agent:SyntheticIDE/otherWorker'; }, 'binding_mismatch'],
        ['scope.workerRuntimeInstanceId', (b) => { b.scope.workerRuntimeInstanceId = 'worker-runtime-2'; }, 'binding_mismatch'],
        ['scope.workerEnableGeneration', (b) => { b.scope.workerEnableGeneration = 'worker-enable-2'; }, 'binding_mismatch'],
        ['scope.workerGeneration', (b) => { b.scope.workerGeneration = sid('worker-gen-2'); }, 'binding_mismatch'],
        ['qualificationRecordDigest', (b) => { b.qualificationRecordDigest = sdg('reissued-record'); }, 'binding_mismatch'],
        ['effectiveSecurityDigest', (b) => { b.effectiveSecurityDigest = sdg('security-2'); }, 'binding_mismatch'],
        ['targetImageDigest', (b) => { b.targetImageDigest = `sha256:${sdg('image-2')}`; }, 'binding_mismatch'],
        ['helperExecutableDigest', (b) => { b.helperExecutableDigest = sdg('helper-2'); }, 'binding_mismatch'],
        ['contractDigest', (b) => { b.contractDigest = sdg('contract-2'); }, 'binding_mismatch'],
        ['inventoryDigest', (b) => { b.inventoryDigest = sdg('inventory-2'); }, 'binding_mismatch'],
        ['profileDigest', (b) => { b.profileDigest = sdg('profile-2'); }, 'binding_mismatch'],
        ['limitsDigest', (b) => { b.limitsDigest = sdg('limits-2'); }, 'binding_mismatch'],
        ['journalStoreIdentity', (b) => { b.journalStoreIdentity = sid('journal-2'); }, 'binding_mismatch'],
        ['source.repositorySourceMode', (b) => { b.source.repositorySourceMode = 'dev'; }, 'source_binding_mismatch'],
        ['source.sourceRepositoryIdentity', (b) => { b.source.sourceRepositoryIdentity = 'https://example.invalid/synthetic/fork.git'; }, 'source_binding_mismatch'],
        ['source.sourceRevision', (b) => { b.source.sourceRevision = { algorithm: 'git-sha1', value: 'b'.repeat(40) }; }, 'source_binding_mismatch'],
        ['source.sourceRevision.algorithm', (b) => { b.source.sourceRevision = { algorithm: 'git-sha256', value: 'a'.repeat(64) }; }, 'source_binding_mismatch'],
        ['source.sourceProtectionEpoch', (b) => { b.source.sourceProtectionEpoch = 4; }, 'stale_source_epoch'],
        ['source.sourceSelectionDigest', (b) => { b.source.sourceSelectionDigest = sdg('selection-2'); }, 'source_binding_mismatch'],
        ['source.sourceClosureDigest', (b) => { b.source.sourceClosureDigest = sdg('closure-2'); }, 'source_binding_mismatch'],
        ['source.sourceAcceptanceIdentity', (b) => { b.source.sourceAcceptanceIdentity = 'acceptance-synthetic-2'; }, 'source_binding_mismatch'],
        ['homeCompatibilityDigest', (b) => { b.homeCompatibilityDigest = sdg('home-2'); }, 'home_incompatible']
    ];
    for (const [field, mutate, code] of bindingMutations) {
        const binding = admittedBinding();
        mutate(binding);
        expectCode(TARGET, facts({ admittedBinding: binding }), code, `binding ${field}`);
    }
    // The same fields from the trusted side: a reissued record, a re-attested target, a recreated journal or a new worker.
    const reissued = facts({ admittedBinding: admittedBinding() });
    reissued.qualifications.records[TARGET].acceptedAtMs += 1;
    expectCode(TARGET, reissued, 'binding_mismatch', 'qualification record reissued after admission');
    const factMutations = [
        ['current worker generation', (f) => { f.current.worker.generation = sid('worker-gen-9'); }],
        ['current worker principal', (f) => { f.current.worker.principal = 'agent:SyntheticIDE/otherWorker'; }],
        ['current limits', (f) => { f.current.limitsDigest = sdg('limits-9'); }],
        ['current journal store', (f) => { f.current.journalStoreIdentity = sid('journal-9'); }],
        ['current facts missing', (f) => { f.current = null; }]
    ];
    for (const [label, mutate] of factMutations) {
        const value = facts({ admittedBinding: admittedBinding() });
        mutate(value);
        expectCode(TARGET, value, 'binding_mismatch', label);
    }
    const sourceFact = facts({ admittedBinding: admittedBinding() });
    sourceFact.sourceState.revision = { algorithm: 'git-sha1', value: 'c'.repeat(40) };
    expectCode(TARGET, sourceFact, 'source_binding_mismatch', 'current revision moved');
});

function closureWith(change) {
    const rootId = sid('closure-root');
    const regular = { filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: '77', fileType: 'regular' };
    const closure = {
        version: 1,
        roots: [{ rootId, rootIdentity: { filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: '10', fileType: 'directory' }, repositoryIdentity: 'https://example.invalid/synthetic/repo.git', revision: { algorithm: 'git-sha1', value: 'c'.repeat(40) }, sourceKind: 'workspace' }],
        entries: [
            { rootId, path: 'bin/run', fileType: 'regular', mode: '0755', gitState: 'tracked-dirty', contentDigest: sdg('run-v1'), linkTarget: null, resolvedIdentity: regular, dependencyIdentity: null },
            { rootId, path: 'link', fileType: 'symlink', mode: '0777', gitState: 'untracked', contentDigest: null, linkTarget: 'bin/run', resolvedIdentity: regular, dependencyIdentity: sid('dep-1') }
        ],
        dependencies: [
            { id: sid('dep-1'), kind: 'executable-runtime', selectionDigest: sdg('dep-sel'), closureDigest: sdg('dep-closure'), rootIdentity: { filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: '90', fileType: 'directory' }, lockDigest: sdg('lock') },
            { id: sid('dep-2'), kind: 'package-tree', selectionDigest: sdg('dep-sel-2'), closureDigest: sdg('dep-closure-2'), rootIdentity: { filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: '91', fileType: 'directory' }, lockDigest: null }
        ].sort((l, r) => (l.id < r.id ? -1 : 1)),
        secretReferences: []
    };
    change(closure);
    const checked = validateSourceClosure(closure);
    assert.equal(checked.ok, true, JSON.stringify(checked.error));
    return targetDigest(checked.value).value;
}

test('SRC-05 and SRC-06 any change of loadable bytes, mode, link target or dependency identity under the same HEAD is source_binding_mismatch', () => {
    const accepted = closureWith(() => {});
    const changes = [
        ['SRC-05 dirty file bytes', (c) => { c.entries[0].contentDigest = sdg('run-v2'); }],
        ['SRC-05 untracked link added state', (c) => { c.entries[1].gitState = 'tracked-dirty'; }],
        ['SRC-06 executable bit', (c) => { c.entries[0].mode = '0644'; }],
        ['SRC-06 symlink target', (c) => { c.entries[1].linkTarget = './bin/run'; }],
        ['SRC-06 dependency identity', (c) => { c.entries[1].dependencyIdentity = c.dependencies.find((d) => d.kind === 'package-tree').id; }]
    ];
    for (const [label, change] of changes) {
        const current = closureWith(change);
        assert.notEqual(current, accepted, label);
        const value = facts();
        value.sourceState.record.sourceClosureDigest = accepted;
        value.sourceState.currentClosureDigest = current;
        expectCode(TARGET, value, 'source_binding_mismatch', label);
    }
    const same = facts();
    same.sourceState.record.sourceClosureDigest = accepted;
    same.sourceState.currentClosureDigest = closureWith(() => {});
    expectCode(TARGET, same, 'backend_not_activated', 'unchanged closure');
});

test('SRC-01, SRC-04, SRC-07, SRC-08 source protection refusals at admission', () => {
    const stale = admittedBinding();
    stale.source.sourceProtectionEpoch = 2;
    expectCode(TARGET, facts({ admittedBinding: stale }), 'stale_source_epoch', 'SRC-01 stale epoch in the admitted binding');
    const cases = [
        ['SRC-04 alias coverage unknown', (s) => { s.aliasCoverage = 'unknown'; }, 'source_alias_unproven'],
        ['SRC-07 unaccepted provenance with matching hashes', (s) => { s.trustedAcceptances = []; }, 'source_provenance_unaccepted'],
        ['SRC-07 previously robot-writable bytes', (s) => { s.previouslyRobotWritable = true; }, 'source_provenance_unaccepted'],
        ['SRC-08 prod with writable backing', (s) => { s.writableBacking = true; }, 'source_unprotected'],
        ['SRC-08 prod with link-install alias', (s) => { s.linkInstallAlias = true; }, 'source_unprotected'],
        ['status unavailable', (s) => { s.record.protectionStatus = 'unavailable'; }, 'source_unprotected'],
        ['record of an old Box generation', (s) => { s.record.boxGeneration = 'box-gen-0'; }, 'source_unavailable'],
        ['record missing', (s) => { s.record = null; }, 'source_unavailable']
    ];
    for (const [label, mutate, code] of cases) {
        const value = facts();
        mutate(value.sourceState);
        expectCode(TARGET, value, code, label);
    }
});

test('QUA-01..QUA-05 qualification class, scope, trust and fixture limits', () => {
    const fixtureInProduction = facts();
    fixtureInProduction.qualifications.records[TARGET] = qualification('proof-fixture');
    expectCode(TARGET, fixtureInProduction, 'qualification_class', 'QUA-01 proof-fixture record in production, digests matching');
    const wrongScope = facts();
    wrongScope.qualifications.records[TARGET] = qualification('production', entry({ containerId: 'a'.repeat(64) }));
    expectCode(TARGET, wrongScope, 'qualification_scope', 'QUA-02 wrong live scope');
    const wrongGeneration = facts();
    wrongGeneration.qualifications.records[TARGET].scope.boxGeneration = 'box-gen-0';
    expectCode(TARGET, wrongGeneration, 'qualification_scope', 'QUA-02 wrong Box generation');
    const selfDeclared = facts();
    selfDeclared.qualifications.records[TARGET].acceptedBy = 'agent:SyntheticRepo/target';
    selfDeclared.qualifications.trustedAcceptances.push('agent:SyntheticRepo/target');
    expectCode(TARGET, selfDeclared, 'qualification_untrusted', 'QUA-02 self-declared acceptance');
    const untrusted = facts();
    untrusted.qualifications.trustedAcceptances = ['other-acceptance'];
    expectCode(TARGET, untrusted, 'qualification_untrusted', 'QUA-02 acceptance not trusted');
    const fixtureFacts = (change, used = 0) => {
        const value = facts({ mode: 'proof-fixture' });
        value.qualifications.records[TARGET] = qualification('proof-fixture');
        value.qualifications.executionsUsed[TARGET] = used;
        change(value);
        return value;
    };
    expectCode(TARGET, fixtureFacts((v) => { v.request.coordinatorPrincipal = 'agent:Other/coordinator'; }), 'qualification_scope', 'QUA-03 wrong coordinator');
    expectCode(TARGET, fixtureFacts((v) => { v.request.operationId = sid('op-z'); }), 'qualification_scope', 'QUA-03 operation not listed');
    expectCode(TARGET, fixtureFacts((v) => { v.request.nowMs = 1000 + 3600000; }), 'qualification_scope', 'QUA-03 expired at boundary');
    expectCode(TARGET, fixtureFacts((v) => { v.request.nowMs = 999; }), 'qualification_scope', 'QUA-03 not yet valid');
    expectCode(TARGET, fixtureFacts(() => {}, 2), 'capacity_exceeded', 'QUA-03 exhausted count');
    expectCode(TARGET, fixtureFacts(() => {}, 1), 'backend_not_activated', 'fixture count below the maximum');
    const relabel = facts();
    relabel.qualifications.records[TARGET].peerTrustInventory[0].trustClass = 'existing-management';
    expectCode(TARGET, relabel, 'peer_trust_unaccepted', 'QUA-04 relabel without prior evidence');
    for (const cell of Object.keys(DENY_ALL)) {
        const exposed = facts();
        exposed.qualifications.records[TARGET].peerTrustInventory[0].access[cell] = 'existing-management';
        expectCode(TARGET, exposed, 'peer_authority_exposed', `QUA-05 ${cell}`);
    }
});

test('HOM-01 and HOM-02 HOME transitions and identity', () => {
    const oneWay = facts();
    oneWay.qualifications.records[TARGET].homeCompatibility.transitions = oneWay.qualifications.records[TARGET].homeCompatibility.transitions
        .filter((pair) => pair.fromInventoryDigest === sdg('inv-worker'));
    expectCode(TARGET, oneWay, 'home_incompatible', 'HOM-01 target to worker not listed');
    const otherWay = facts();
    otherWay.qualifications.records[TARGET].homeCompatibility.transitions = otherWay.qualifications.records[TARGET].homeCompatibility.transitions
        .filter((pair) => pair.fromInventoryDigest === sdg('inv-target'));
    expectCode(TARGET, otherWay, 'home_incompatible', 'HOM-01 worker to target not listed');
    expectCode(TARGET, facts({ home: { ...facts().home, backendId: 'codex' } }), 'home_incompatible', 'HOM-01 other backend');
    expectCode(TARGET, facts({ home: { ...facts().home, homeIdentity: 'home-copy' } }), 'home_incompatible', 'HOM-02 substituted or copied HOME');
    const altered = admittedBinding();
    altered.homeCompatibilityDigest = sdg('altered');
    expectCode(TARGET, facts({ admittedBinding: altered }), 'home_incompatible', 'HOM-02 altered compatibility digest');
});

test('security, profile and inventory attestation mismatches refuse', () => {
    for (const key of ['targetImageDigest', 'helperExecutableDigest', 'contractDigest', 'inventoryDigest', 'profileDigest', 'effectiveSecurityDigest', 'channelSchemaDigest']) {
        const target = entry();
        target.attestation[key] = key === 'targetImageDigest' ? `sha256:${sdg('x')}` : sdg('x');
        expectCode(TARGET, facts({ entries: [target] }), 'target_attestation_mismatch', key);
    }
});

test('CAP-01 executions per target: 7 active passes capacity, 8 refuses', () => {
    expectCode(TARGET, facts({ entries: [entry({ activeExecutions: 7 })] }), 'backend_not_activated', 'below the ceiling');
    expectCode(TARGET, facts({ entries: [entry({ activeExecutions: 8 })] }), 'capacity_exceeded', 'at the ceiling');
});

test('malformed trusted facts fail closed', () => {
    expectCode(TARGET, facts({ excluded: { principals: [], aliases: [], runtimeInstanceIds: [] } }), 'invalid_request', 'empty exclusion set');
    expectCode(TARGET, facts({ entries: [{ ...entry(), agentExec: true }] }), 'invalid_request', 'unknown entry key (agentExec is not an opt-in)');
    expectCode(TARGET, facts({ mode: 'staging' }), 'invalid_request', 'mode');
    assert.deepEqual(requireExecutionTarget(TARGET, null), { ok: false, error: { code: 'invalid_request' } });
});

function projection(overrides = {}) {
    const base = facts();
    return {
        entries: base.entries, mode: 'production', sourceState: base.sourceState, qualificationStore: base.qualifications,
        trustedIdentities: { live: base.live, excluded: base.excluded, home: base.home, request: base.request }, ...overrides
    };
}

test('T1-07 projection: every target unavailable, excluded identities omitted, fixture records never advertised', () => {
    const roboteam = entry({ ref: 'SyntheticIDE/roboTeamAgent', principal: ROBOTEAM, runtimeInstanceId: ROBOTEAM_RUNTIME });
    const workerByRuntime = entry({ ref: 'Disguised/agent', principal: 'agent:Disguised/agent', runtimeInstanceId: WORKER_RUNTIME });
    const workerByAlias = entry({ ref: 'Alias/agent', principal: 'agent:Alias/agent', aliases: [WORKER_ALIAS], runtimeInstanceId: 'x-1' });
    const stopped = entry({ ref: 'Stopped/agent', principal: 'agent:Stopped/agent', running: false, label: 'bad\u0007label' });
    const input = projection({ entries: [entry(), roboteam, workerByRuntime, workerByAlias, stopped] });
    const before = clone(input);
    const result = projectExecutionTargets(input);
    assert.deepEqual(input, before, 'inputs unchanged');
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
        version: 1,
        targets: [
            { ref: 'Stopped/agent', label: 'Stopped/agent', available: false, reason: 'target_not_eligible' },
            { ref: TARGET, label: 'Synthetic target', available: false, reason: 'backend_not_activated' }
        ]
    });
    const fixtureRecord = projection();
    fixtureRecord.qualificationStore = { ...fixtureRecord.qualificationStore, records: { [TARGET]: qualification('proof-fixture') } };
    assert.deepEqual(projectExecutionTargets(fixtureRecord).value.targets, [{ ref: TARGET, label: 'Synthetic target', available: false, reason: 'qualification_class' }]);
    const fixtureMode = projection({ mode: 'proof-fixture' });
    fixtureMode.qualificationStore = { ...fixtureMode.qualificationStore, records: { [TARGET]: qualification('proof-fixture') } };
    assert.equal(projectExecutionTargets(fixtureMode).value.targets[0].available, false, 'proof-fixture mode is not activated either');
});

test('CAP-01 projection bounds: 256 targets listed, 257 or more than 64 KiB refuse the whole inventory', () => {
    const name = (i, long) => `agent-${String(i).padStart(3, '0')}`.padEnd(long ? 120 : 9, 'x');
    const many = (n, label = 'L', long = false) => Array.from({ length: n }, (_, i) => entry({ ref: `Repo/${name(i, long)}`, principal: `agent:Repo/${name(i, long)}`, label }));
    const at = projectExecutionTargets(projection({ entries: many(256) }));
    assert.equal(at.ok, true);
    assert.equal(at.value.targets.length, 256);
    assert.deepEqual(projectExecutionTargets(projection({ entries: many(257) })), { ok: false, error: { code: 'capacity_exceeded' } });
    assert.deepEqual(projectExecutionTargets(projection({ entries: many(256, 'é'.repeat(64), true) })), { ok: false, error: { code: 'capacity_exceeded' } }, 'over 64 KiB');
});

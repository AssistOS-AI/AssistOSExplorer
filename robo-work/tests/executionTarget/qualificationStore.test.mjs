// SYNTHETIC tests of the worker-owned qualification store and the operator-only fixture installer (P6a, erratum A10).
// All identities and digests are synthetic; the store root is a fresh private temp directory.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { requireExecutionTarget } from '../../server/executionTarget/availability.mjs';
import { canonicalTargetJson, validateQualificationRecord } from '../../server/executionTarget/contract.mjs';
import { QUALIFICATION_STORE_ERROR_CODES, createQualificationStore } from '../../server/executionTarget/qualificationStore.mjs';
import { installFixtureRecord } from '../../tools/install-fixture-record.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, '..', '..', 'tools', 'install-fixture-record.mjs');
const UID = process.getuid();
const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`synthetic-digest:${label}`);

const WORKER = 'agent:SyntheticIDE/roboWork';
const TARGET = 'SyntheticRepo/target';
const COORDINATOR = 'agent:SyntheticRepo/coordinator';
const CONTAINER = 'c'.repeat(64);
const HELPER = sid('helper-1');
const OPS = [sid('op-a'), sid('op-b'), sid('op-c')].sort();
const LIVE = { containerId: CONTAINER, helperIncarnation: HELPER };
const DENY_ALL = {
    workerStore: 'deny', otherRobotHomes: 'deny', qualificationRecords: 'deny', sourceAcceptanceRecords: 'deny', executionReceipts: 'deny',
    helperJournal: 'deny', mailbox: 'deny', credentials: 'deny', robotProcAndDescriptors: 'deny', workloadChannels: 'deny'
};

// A10 bootstrap record: g7EvidenceDigest is the authorized pre-run G7 package digest, independentVerificationDigest its review digest.
function record(qualificationClass = 'proof-fixture', { maxExecutions = 2 } = {}) {
    return {
        version: 1, qualificationClass,
        scope: {
            workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', workerPrincipal: WORKER,
            workerRuntimeInstanceId: 'worker-runtime-1', workerEnableGeneration: 'worker-enable-1', workerGeneration: sid('worker-gen'),
            agentPrincipal: `agent:${TARGET}`, containerId: CONTAINER, runtimeInstanceId: 'target-instance-1', enableGeneration: 'target-enable-1',
            helperIncarnation: HELPER
        },
        fixture: qualificationClass === 'production' ? null : {
            coordinatorPrincipal: COORDINATOR, fixtureId: sid('fixture'), authorizationDigest: sdg('authorization'), operationIds: OPS,
            maxExecutions, notBeforeMs: 1000, notAfterMs: 1000 + 3600000
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
            hostPlatform: 'linux-amd64', kernelRelease: '6.8.0-synthetic', kernelBuildDigest: sdg('kernel'), runtimeName: 'podman',
            runtimeVersion: '5.0.0-synthetic', runtimeConfigDigest: sdg('runtime'), uidMappingDigest: sdg('uid'), gidMappingDigest: sdg('gid'),
            boxPolicyDigest: sdg('box'), targetProcBaselineDigest: sdg('proc'), workloadProcPolicyDigest: sdg('workload-proc')
        },
        peerTrustInventory: [{ classId: 'target-service', executableClosureDigest: sdg('target-closure'), trustClass: 'untrusted-peer', existingTrustEvidenceDigest: null, access: { ...DENY_ALL } }],
        homeCompatibility: {
            version: 1, homeIdentity: 'home-synthetic-1',
            transitions: [
                { backendId: 'claude', fromInventoryDigest: sdg('inv-target'), toInventoryDigest: sdg('inv-worker'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-1') },
                { backendId: 'claude', fromInventoryDigest: sdg('inv-worker'), toInventoryDigest: sdg('inv-target'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-2') }
            ].sort((l, r) => (l.fromInventoryDigest < r.fromInventoryDigest ? -1 : 1))
        },
        evidence: { candidateManifestDigest: sdg('candidate'), g7EvidenceDigest: sdg('g7-package-pre-run'), independentVerificationDigest: sdg('g7-package-review') },
        acceptedBy: 'acceptance-record-synthetic-1', acceptedAtMs: 1700000000000
    };
}

function tempRoot(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qstore-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return base;
}

function openStore(t, options = {}) {
    const base = tempRoot(t);
    const root = path.join(base, 'qualification');
    const opened = createQualificationStore({ fs, root, uid: UID, create: true, ...options });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    return { base, root, store: opened.value };
}

const installOne = (store, overrides = {}) => store.install({ ref: TARGET, record: record(), expectedLive: LIVE, allowedClasses: ['proof-fixture'], ...overrides });
const code = (result) => (result.ok ? 'ok' : result.error.code);
const recordFile = (root) => path.join(root, 'records', `${sha(TARGET)}.json`);

test('the A10 bootstrap record validates unchanged: evidence digests are digest-shaped, the class does the separation', () => {
    assert.equal(validateQualificationRecord(record()).ok, true);
    assert.equal(validateQualificationRecord(record('production')).ok, true);
});

test('install writes a private canonical file; get and facts re-read and re-validate it', (t) => {
    const { root, store } = openStore(t);
    const installed = installOne(store);
    assert.equal(installed.ok, true);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'records')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(recordFile(root)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(root, 'records')).filter((name) => name.startsWith('.tmp-')), [], 'no temp file left');
    const got = store.get(TARGET);
    assert.equal(got.ok, true);
    assert.deepEqual(got.value.record, record());
    assert.equal(got.value.recordDigest, installed.value.recordDigest);
    const facts = store.facts();
    assert.deepEqual(facts.value, { records: { [TARGET]: record() }, trustedAcceptances: ['acceptance-record-synthetic-1'], executionsUsed: { [TARGET]: 0 } });
    assert.equal(code(store.get('Other/agent')), 'not_found');
});

test('install refusals: class, scope binding to the started helper, record validity, existence', (t) => {
    const { store } = openStore(t);
    assert.equal(code(installOne(store, { record: record('production') })), 'class_not_allowed', 'the fixture tool class list excludes production');
    assert.equal(code(installOne(store, { expectedLive: { containerId: 'd'.repeat(64), helperIncarnation: HELPER } })), 'scope_mismatch');
    assert.equal(code(installOne(store, { expectedLive: { containerId: CONTAINER, helperIncarnation: sid('helper-2') } })), 'scope_mismatch', 'a different helper incarnation');
    assert.equal(code(installOne(store, { expectedLive: {} })), 'scope_mismatch');
    assert.equal(code(installOne(store, { expectedLive: null })), 'invalid_request');
    assert.equal(code(installOne(store, { ref: 'Other/agent' })), 'scope_mismatch', 'ref must equal the record agent principal');
    assert.equal(code(installOne(store, { ref: 'not a ref' })), 'invalid_request');
    assert.equal(code(installOne(store, { allowedClasses: [] })), 'invalid_request');
    const bad = record();
    bad.fixture.maxExecutions = 9;
    assert.equal(code(installOne(store, { record: bad })), 'record_invalid', 'over eight executions');
    const longWindow = record();
    longWindow.fixture.notAfterMs = longWindow.fixture.notBeforeMs + 24 * 3600000 + 1;
    assert.equal(code(installOne(store, { record: longWindow })), 'record_invalid', 'over 24 hours');
    assert.equal(code(installOne(store, { record: { ...record(), extra: 1 } })), 'record_invalid');
    assert.equal(store.facts().value.records[TARGET], undefined, 'nothing was installed by a refusal');
    assert.equal(installOne(store).ok, true);
    assert.equal(code(installOne(store)), 'exists', 'no silent overwrite');
    const next = record();
    next.acceptedAtMs += 1;
    assert.equal(installOne(store, { record: next, replace: true }).ok, true);
    assert.equal(store.get(TARGET).value.record.acceptedAtMs, next.acceptedAtMs);
});

test('the store refuses an unsafe root: mode, link, relative path, foreign owner, forbidden roots', (t) => {
    const base = tempRoot(t);
    const open = (root, extra = {}) => createQualificationStore({ fs, root, uid: UID, ...extra });
    assert.equal(code(open('relative/dir')), 'invalid_request');
    assert.equal(code(createQualificationStore({ fs, root: path.join(base, 'x'), uid: 'zero' })), 'invalid_request');
    const open755 = path.join(base, 'open');
    fs.mkdirSync(path.join(open755, 'records'), { recursive: true });
    fs.mkdirSync(path.join(open755, 'counters'));
    fs.chmodSync(open755, 0o755);
    assert.equal(code(open(open755)), 'store_unsafe', 'group/other accessible root');
    const real = path.join(base, 'real');
    assert.equal(createQualificationStore({ fs, root: real, uid: UID, create: true }).ok, true);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    assert.equal(code(open(link)), 'store_unsafe', 'a symlinked root');
    assert.equal(code(createQualificationStore({ fs, root: real, uid: UID + 1 })), 'store_unsafe', 'owned by another uid');
    const home = path.join(base, 'robot-home');
    fs.mkdirSync(home);
    assert.equal(code(open(path.join(home, 'qualification'), { create: true, forbiddenRoots: [home] })), 'store_unsafe', 'inside a robot HOME');
    assert.equal(code(open(real, { forbiddenRoots: [base] })), 'store_unsafe', 'inside a project/target-visible root');
    assert.equal(code(open(real, { forbiddenRoots: [path.join(real, 'records')] })), 'store_unsafe', 'a forbidden root inside the store');
    assert.equal(code(open(real, { forbiddenRoots: [home] })), 'ok', 'an unrelated forbidden root does not block');
    assert.equal(code(open(path.join(base, 'missing'))), 'io_error', 'a missing root is not created without create');
    assert.ok(QUALIFICATION_STORE_ERROR_CODES.includes('store_unsafe'));
});

test('every read re-validates: a tampered, linked, group-readable or foreign-ref file is absent, never trusted', (t) => {
    const { root, store } = openStore(t);
    assert.equal(installOne(store).ok, true);
    const file = recordFile(root);
    const original = fs.readFileSync(file, 'utf8');
    assert.equal(store.get(TARGET).ok, true);
    // 1. digest mismatch after an edit of the record body that stays canonical and valid
    const edited = original.replace('"acceptedAtMs":1700000000000', '"acceptedAtMs":1700000000001');
    assert.notEqual(edited, original);
    fs.writeFileSync(file, edited, { mode: 0o600 });
    assert.equal(code(store.get(TARGET)), 'not_found');
    assert.deepEqual(store.facts().value.records, {});
    // 2. noncanonical text
    fs.writeFileSync(file, `${original} `, { mode: 0o600 });
    assert.equal(code(store.get(TARGET)), 'not_found');
    // 3. a file for another ref copied under this name
    const other = original.replace(`"ref":"${TARGET}"`, '"ref":"Other/agent"');
    fs.writeFileSync(file, other, { mode: 0o600 });
    assert.equal(code(store.get(TARGET)), 'not_found');
    // 4. good content but group-readable
    fs.writeFileSync(file, original, { mode: 0o600 });
    assert.equal(store.get(TARGET).ok, true);
    fs.chmodSync(file, 0o640);
    assert.equal(code(store.get(TARGET)), 'not_found');
    assert.deepEqual(store.facts().value.records, {});
    fs.chmodSync(file, 0o600);
    assert.equal(store.get(TARGET).ok, true, 'restored content is read again (no cached negative either)');
    // 5. a symlink in place of the file
    const aside = path.join(root, 'aside');
    fs.writeFileSync(aside, original, { mode: 0o600 });
    fs.rmSync(file);
    fs.symlinkSync(aside, file);
    assert.equal(code(store.get(TARGET)), 'not_found');
    assert.deepEqual(store.facts().value.records, {});
});

test('a record tampered while the store is open is not served from any cache', (t) => {
    const { root, store } = openStore(t);
    assert.equal(installOne(store).ok, true);
    assert.equal(Object.keys(store.facts().value.records).length, 1);
    fs.rmSync(recordFile(root));
    assert.deepEqual(store.facts().value.records, {});
});

test('proof-fixture executions are counted durably, deduplicated by operationId and capped by the record', (t) => {
    const { root, store } = openStore(t);
    assert.equal(installOne(store).ok, true);
    assert.deepEqual(store.consumeExecution(TARGET, OPS[0]).value, { used: 1, counted: true });
    assert.deepEqual(store.consumeExecution(TARGET, OPS[0]).value, { used: 1, counted: false }, 'the same operationId is not counted twice');
    assert.equal(code(store.consumeExecution(TARGET, sid('op-unlisted'))), 'scope_mismatch');
    assert.deepEqual(store.consumeExecution(TARGET, OPS[1]).value, { used: 2, counted: true });
    assert.equal(code(store.consumeExecution(TARGET, OPS[2])), 'capacity_exceeded', 'maxExecutions is 2');
    assert.equal(store.facts().value.executionsUsed[TARGET], 2);
    assert.equal(fs.statSync(path.join(root, 'counters', `${sha(TARGET)}.json`)).mode & 0o777, 0o600);
    // a fresh store handle (a worker restart) sees the same count
    const reopened = createQualificationStore({ fs, root, uid: UID });
    assert.equal(reopened.value.facts().value.executionsUsed[TARGET], 2);
    // re-installing the identical record does not reset the count; a different record starts its own
    assert.equal(installOne(store, { replace: true }).ok, true);
    assert.equal(store.facts().value.executionsUsed[TARGET], 2);
    const next = record();
    next.acceptedAtMs += 1;
    assert.equal(installOne(store, { record: next, replace: true }).ok, true);
    assert.equal(store.facts().value.executionsUsed[TARGET], 0);
    // an unreadable counter exhausts the fixture, it never reads as zero
    assert.equal(store.consumeExecution(TARGET, OPS[0]).ok, true);
    fs.writeFileSync(path.join(root, 'counters', `${sha(TARGET)}.json`), 'garbage', { mode: 0o600 });
    assert.equal(store.facts().value.executionsUsed[TARGET], 2);
    assert.equal(code(store.consumeExecution(TARGET, OPS[1])), 'capacity_exceeded');
});

test('an unreadable counter (wrong mode, symlink, directory) refuses and is never overwritten', (t) => {
    const { root, store } = openStore(t);
    assert.equal(installOne(store).ok, true);
    assert.equal(store.consumeExecution(TARGET, OPS[0]).ok, true);
    const counter = path.join(root, 'counters', `${sha(TARGET)}.json`);
    const original = fs.readFileSync(counter, 'utf8');
    const exhausted = () => {
        assert.equal(store.facts().value.executionsUsed[TARGET], 2, 'exhausted, not zero or one');
        assert.equal(code(store.consumeExecution(TARGET, OPS[1])), 'capacity_exceeded');
    };
    fs.chmodSync(counter, 0o644);
    exhausted();
    assert.equal(fs.readFileSync(counter, 'utf8'), original, 'wrong-mode counter not overwritten');
    fs.chmodSync(counter, 0o600);
    assert.equal(store.consumeExecution(TARGET, OPS[1]).value.used, 2, 'readable again');
    const aside = path.join(root, 'aside.json');
    const saved = fs.readFileSync(counter, 'utf8');
    fs.writeFileSync(aside, saved, { mode: 0o600 });
    fs.rmSync(counter);
    fs.symlinkSync(aside, counter);
    assert.equal(store.facts().value.executionsUsed[TARGET], 2);
    assert.equal(code(store.consumeExecution(TARGET, OPS[2])), 'capacity_exceeded');
    assert.ok(fs.lstatSync(counter).isSymbolicLink(), 'symlinked counter not replaced');
    assert.equal(fs.readFileSync(aside, 'utf8'), saved);
});

test('store facts drive availability: the installed fixture record admits in proof-fixture mode and refuses in production mode', (t) => {
    const { store } = openStore(t);
    assert.equal(installOne(store).ok, true);
    const entry = {
        ref: TARGET, label: 'Synthetic target', principal: `agent:${TARGET}`, aliases: [], runtimeInstanceId: 'target-instance-1', containerId: CONTAINER,
        enableGeneration: 'target-enable-1', helperIncarnation: HELPER, workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1',
        enabled: true, running: true, runtime: 'container', placement: 'global', declaration: { valid: true }, prepared: true, journal: 'available',
        attestation: {
            targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractDigest: sdg('contract'), inventoryDigest: sdg('inventory'),
            profileDigest: sdg('profile'), effectiveSecurityDigest: sdg('security'), channelSchemaDigest: sdg('channel-schema')
        },
        activeExecutions: 0
    };
    const facts = (mode) => ({
        surface: 'terminal', mode, live: { workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1' },
        excluded: { principals: ['agent:SyntheticIDE/roboTeamAgent', WORKER], aliases: [], runtimeInstanceIds: ['worker-runtime-1'] },
        entries: [entry],
        sourceState: {
            record: {
                version: 1, workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', sourceProtectionEpoch: 3,
                sourceSelectionDigest: sdg('selection'), sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-synthetic-1',
                sourceStoreIdentity: sid('store-a'), protectionStatus: 'protected', enforcementDigest: sdg('enforcement'), aliasCoverageDigest: sdg('alias'),
                acceptedAtMs: 1700000000000
            },
            currentSelectionDigest: sdg('selection'), currentClosureDigest: sdg('closure'), aliasCoverage: 'complete', trustedAcceptances: ['acceptance-synthetic-1'],
            previouslyRobotWritable: false, writableBacking: false, linkInstallAlias: false, repositorySourceMode: 'prod',
            repositoryIdentity: 'https://example.invalid/synthetic/target.git', revision: { algorithm: 'git-sha1', value: 'a'.repeat(40) }
        },
        qualifications: store.facts().value,
        request: { coordinatorPrincipal: COORDINATOR, operationId: OPS[0], nowMs: 2000 },
        home: { homeIdentity: 'home-synthetic-1', backendId: 'claude', workerInventoryDigest: sdg('inv-worker'), targetInventoryDigest: sdg('inv-target') },
        admittedBinding: null,
        current: { worker: { principal: WORKER, runtimeInstanceId: 'worker-runtime-1', enableGeneration: 'worker-enable-1', generation: sid('worker-gen') }, limitsDigest: sdg('limits'), journalStoreIdentity: sid('journal') }
    });
    const admitted = requireExecutionTarget(TARGET, facts('proof-fixture'));
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.value.backend, 'target');
    // QUA-01 with the store-provided record: production refuses even though every digest and scope matches.
    assert.deepEqual(requireExecutionTarget(TARGET, facts('production')), { ok: false, error: { code: 'qualification_class' } });
    // exhausting the count through the store makes the next admission refuse
    store.consumeExecution(TARGET, OPS[0]);
    store.consumeExecution(TARGET, OPS[1]);
    assert.deepEqual(requireExecutionTarget(TARGET, facts('proof-fixture')), { ok: false, error: { code: 'capacity_exceeded' } });
});

test('the operator tool installs only proof-fixture records, bound to the observed helper', (t) => {
    const base = tempRoot(t);
    const storeRoot = path.join(base, 'qualification');
    const text = canonicalTargetJson(record(), { maxBytes: 1 << 20 }).value;
    const productionText = canonicalTargetJson(record('production'), { maxBytes: 1 << 20 }).value;
    const call = (overrides) => installFixtureRecord({ fs, uid: UID, storeRoot, create: true, ref: TARGET, recordText: text, expectedLive: LIVE, ...overrides });
    assert.equal(code(call({ recordText: productionText })), 'class_not_allowed');
    assert.equal(code(call({ recordText: ' ' + text })), 'record_invalid', 'noncanonical text');
    assert.equal(code(call({ recordText: '{}' })), 'record_invalid');
    assert.equal(code(call({ expectedLive: { containerId: 'e'.repeat(64), helperIncarnation: HELPER } })), 'scope_mismatch');
    assert.equal(code(call({ forbiddenRoots: [base] })), 'store_unsafe');
    assert.equal(code(call({})), 'ok');
    assert.equal(code(call({})), 'exists');
});

test('the operator tool command line works without any environment and refuses what the library refuses', (t) => {
    const base = tempRoot(t);
    const storeRoot = path.join(base, 'qualification');
    fs.writeFileSync(path.join(base, 'fixture.json'), canonicalTargetJson(record(), { maxBytes: 1 << 20 }).value);
    fs.writeFileSync(path.join(base, 'production.json'), canonicalTargetJson(record('production'), { maxBytes: 1 << 20 }).value);
    const run = (file, extra = []) => spawnSync(process.execPath, [TOOL, '--store-root', storeRoot, '--record-file', path.join(base, file), '--ref', TARGET,
        '--container-id', CONTAINER, '--helper-incarnation', HELPER, '--create', ...extra], { env: {}, encoding: 'utf8' });
    const refused = run('production.json');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused: class_not_allowed/);
    const installed = run('fixture.json');
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /^installed SyntheticRepo\/target [0-9a-f]{64}\n$/);
    assert.equal(run('fixture.json').status, 1, 'second install without --replace');
    assert.equal(run('fixture.json', ['--replace']).status, 0);
    assert.equal(spawnSync(process.execPath, [TOOL, '--bogus'], { env: {}, encoding: 'utf8' }).status, 2);
    const reopened = createQualificationStore({ fs, root: storeRoot, uid: UID });
    assert.equal(reopened.value.get(TARGET).ok, true);
});

test('no environment-variable or option bypass: the modules read no environment and the activation constant is fixed', () => {
    const moduleDir = path.join(here, '..', '..', 'server', 'executionTarget');
    for (const file of ['availability.mjs', 'qualificationStore.mjs']) {
        const source = fs.readFileSync(path.join(moduleDir, file), 'utf8');
        assert.doesNotMatch(source, /process\.env|process\.argv|\bglobalThis\b/, `${file} reads no environment`);
    }
    assert.doesNotMatch(fs.readFileSync(TOOL, 'utf8'), /process\.env/);
    const availability = fs.readFileSync(path.join(moduleDir, 'availability.mjs'), 'utf8');
    assert.match(availability, /^const BACKEND_ACTIVATED = false;$/m);
    // The proof-fixture path is the only admission besides the constant, and it checks both the mode and the record class.
    assert.match(availability, /return facts\.mode === 'proof-fixture' && record\.qualificationClass === 'proof-fixture';/);
});

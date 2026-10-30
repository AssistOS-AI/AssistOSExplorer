// Slice P6b host-level self-test of the rwworker fixture: the worker host (production executionTarget modules) drives
// the native worker peer against a real `rw-target-helper serve --proof-fixture-session` over an AF_UNIX mailbox.
// Every identity, key and record here is synthetic; the ticket key is the PUBLIC SYNTHETIC proof-fixture key.
// `--router-tickets` (mint route spec 2026-10-30, E1/R3): the same host with an injected `mintTicket` (the production
// helperTicketClient over a test Router that holds the helper's per-incarnation secret) against a helper that verifies
// with that consumed secret (no fixture flag), plus leak scans of everything the worker writes.
//
// Needs the static helper builds: RW_TARGET_HELPER_FIXTURE_BIN (built with `--features proof-fixture`) and optionally
// RW_TARGET_HELPER_BIN (default build, used for the worker peer; defaults to the fixture build). Without them every test
// here is SKIPPED, which is not a pass.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalTargetJson, digestOf } from '../../../server/executionTarget/contract.mjs';
import { createTargetJournalModel } from '../../../server/executionTarget/journalModel.mjs';
import { validateHelperTicketClaims } from '../../../server/executionTarget/transportContract.mjs';
import { installFixtureRecord } from '../tools/install-fixture-record.mjs';
import { loadFixtureTicketKey, mintFixtureTicket, possessionProof, sessionKey } from '../fixture/rwworker/fixtureMinter.mjs';
import { MINT_RETRY, TICKET_TTL_SECONDS, classifyMint, createWorkerHost, knownCode, mintCode } from '../fixture/rwworker/workerHost.mjs';
import { HELPER_TICKET_REQUEST_KEYS, createHelperTicketClient } from '../../../server/helperTicketClient.mjs';
import { renderManifest } from '../fixture/rwtarget/render-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROBO_WORK = path.resolve(here, '..', '..', '..');
const VECTORS = path.join(ROBO_WORK, 'native', 'crates', 'target-helper', 'tests', 'vectors');
const HELPER = process.env.RW_TARGET_HELPER_FIXTURE_BIN;
const PEER = process.env.RW_TARGET_HELPER_BIN || HELPER;
const SKIP = HELPER ? false : 'RW_TARGET_HELPER_FIXTURE_BIN is not set (SKIPPED, not passed)';
const UID = process.getuid();

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const MAIN = path.join(ROBO_WORK, 'tests', 'g7', 'fixture', 'rwworker', 'main.mjs');
const sid = (label) => crypto.createHash('sha256').update(`rwworker-selftest:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`rwworker-selftest-digest:${label}`);
const WORKER = 'agent:SyntheticIDE/roboWork';
const TARGET = 'rwrepo/rwtarget';
const COORDINATOR = 'agent:SyntheticIDE/coordinator';
const COORDINATOR_OPS = [sid('coord-op-1'), sid('coord-op-2')].sort();
const DENY_ALL = Object.fromEntries(['workerStore', 'otherRobotHomes', 'qualificationRecords', 'sourceAcceptanceRecords', 'executionReceipts', 'helperJournal',
    'mailbox', 'credentials', 'robotProcAndDescriptors', 'workloadChannels'].map((cell) => [cell, 'deny']));

function tempBase(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rww-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return base;
}

function journalInit(root) {
    fs.mkdirSync(root, { recursive: true });
    const result = spawnSync(HELPER, ['journal-init', '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).value.journalStoreIdentity;
}

// The single-use per-incarnation ticket-secret file Ploinky provisioning writes (v1, mode 0600). With
// --proof-fixture-session the helper consumes it and verifies with the public fixture key instead.
function writeHelperSecret(directory, incarnation) {
    const file = path.join(directory, `helper-secret-${incarnation}`);
    const bytes = crypto.randomBytes(32);
    fs.writeFileSync(file, `version=1\nhelperIncarnation=${incarnation}\nkid=hti1.${incarnation}\nsecret=${bytes.toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { file, key: Object.freeze({ kid: `hti1.${incarnation}`, secret: bytes }) };
}

// `router: true`: no fixture flag, so the helper verifies with the consumed per-incarnation secret (and runs the keeper
// supervisor, which has no keeper binary on the host); `key` is that secret, held by the test Router.
async function startHelper(t, { root, store, incarnation, mailbox, keeper = true, router = false }) {
    const { file: secretFile, key } = writeHelperSecret(path.dirname(mailbox), incarnation);
    const args = ['serve', '--mailbox', mailbox, '--journal-root', root, '--store-identity', store, '--helper-incarnation', incarnation, '--secret-file', secretFile];
    if (!router) args.push('--proof-fixture-session');
    if (keeper && !router) args.push('--proof-fixture-keeper');
    const child = spawn(HELPER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    readline.createInterface({ input: child.stderr }).on('line', (line) => events.push(JSON.parse(line)));
    const ready = await new Promise((resolve, reject) => {
        readline.createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line)));
        child.once('exit', (code) => reject(new Error(`helper exited ${code}`)));
    });
    const stop = () => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
    t.after(stop);
    assert.equal(ready.value.session, router ? 'helper-ticket-secret' : 'proof-fixture');
    assert.equal(fs.existsSync(secretFile), false, 'the helper consumed its secret file before ready');
    return { child, ready, events, stop, key };
}

function live({ incarnation, containerId, store }) {
    const workspaceId = `workspace:${sha('/synthetic/workspace')}`;
    return {
        live: { workspaceId, boxIdentity: 'ploinky-box-synthetic-1', boxGeneration: 'b'.repeat(64) },
        entry: {
            ref: TARGET, label: 'rwtarget', principal: `agent:${TARGET}`, aliases: [], runtimeInstanceId: 'target-instance-1', containerId,
            enableGeneration: 'target-enable-1', helperIncarnation: incarnation, workspaceId, boxIdentity: 'ploinky-box-synthetic-1', boxGeneration: 'b'.repeat(64),
            enabled: true, running: true, runtime: 'container', placement: 'global', declaration: { valid: true }, prepared: true, journal: 'available',
            attestation: {
                targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractDigest: sdg('contract'), inventoryDigest: sdg('inventory'),
                profileDigest: sdg('profile'), effectiveSecurityDigest: sdg('security'), channelSchemaDigest: sdg('channel-schema')
            },
            activeExecutions: 0
        },
        store
    };
}

const DEFAULT_WORKER = Object.freeze({ principal: WORKER, runtimeInstanceId: 'worker-runtime-1', enableGeneration: 'worker-enable-1', generation: sid('worker-gen') });

function qualificationRecord(scope, worker = DEFAULT_WORKER) {
    return {
        version: 1, qualificationClass: 'proof-fixture',
        scope: {
            workspaceId: scope.live.workspaceId, boxIdentity: scope.live.boxIdentity, boxGeneration: scope.live.boxGeneration, workerPrincipal: worker.principal,
            workerRuntimeInstanceId: worker.runtimeInstanceId, workerEnableGeneration: worker.enableGeneration, workerGeneration: worker.generation,
            agentPrincipal: `agent:${TARGET}`, containerId: scope.entry.containerId, runtimeInstanceId: scope.entry.runtimeInstanceId,
            enableGeneration: scope.entry.enableGeneration, helperIncarnation: scope.entry.helperIncarnation
        },
        fixture: { coordinatorPrincipal: COORDINATOR, fixtureId: sid('fixture'), authorizationDigest: sdg('authorization'), operationIds: COORDINATOR_OPS, maxExecutions: 4, notBeforeMs: Date.now() - 60000, notAfterMs: Date.now() + 3600000 },
        source: {
            repositorySourceMode: 'prod', sourceRepositoryIdentity: 'https://example.invalid/synthetic/rwtarget.git', sourceRevision: { algorithm: 'git-sha1', value: 'a'.repeat(40) },
            sourceProtectionEpoch: 3, sourceSelectionDigest: sdg('selection'), sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-synthetic-1'
        },
        targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractDigest: sdg('contract'), inventoryDigest: sdg('inventory'),
        profileDigest: sdg('profile'), effectiveSecurityDigest: sdg('security'), limitsDigest: sdg('limits'), inputSchemaDigest: sdg('input-schema'), channelSchemaDigest: sdg('channel-schema'),
        platform: {
            hostPlatform: 'linux-amd64', kernelRelease: '6.8.0-synthetic', kernelBuildDigest: sdg('kernel'), runtimeName: 'podman', runtimeVersion: '5.0.0-synthetic',
            runtimeConfigDigest: sdg('runtime'), uidMappingDigest: sdg('uid'), gidMappingDigest: sdg('gid'), boxPolicyDigest: sdg('box'), targetProcBaselineDigest: sdg('proc'), workloadProcPolicyDigest: sdg('workload-proc')
        },
        peerTrustInventory: [{ classId: 'target-service', executableClosureDigest: sdg('target-closure'), trustClass: 'untrusted-peer', existingTrustEvidenceDigest: null, access: { ...DENY_ALL } }],
        homeCompatibility: {
            version: 1, homeIdentity: 'home-synthetic-1',
            transitions: [
                { backendId: 'claude', fromInventoryDigest: sdg('inv-target'), toInventoryDigest: sdg('inv-worker'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-1') },
                { backendId: 'claude', fromInventoryDigest: sdg('inv-worker'), toInventoryDigest: sdg('inv-target'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-2') }
            ].sort((left, right) => (left.fromInventoryDigest < right.fromInventoryDigest ? -1 : 1))
        },
        evidence: { candidateManifestDigest: sdg('candidate'), g7EvidenceDigest: sdg('g7-package-pre-run'), independentVerificationDigest: sdg('g7-package-review') },
        acceptedBy: 'acceptance-record-synthetic-1', acceptedAtMs: Date.now()
    };
}

function facts(scope, worker = DEFAULT_WORKER) {
    return {
        surface: 'terminal', mode: 'proof-fixture', live: scope.live,
        excluded: { principals: ['agent:SyntheticIDE/roboTeamAgent', WORKER], aliases: [], runtimeInstanceIds: [worker.runtimeInstanceId] },
        entries: [scope.entry],
        sourceState: {
            record: {
                version: 1, ...scope.live, sourceProtectionEpoch: 3, sourceSelectionDigest: sdg('selection'), sourceClosureDigest: sdg('closure'),
                sourceAcceptanceIdentity: 'acceptance-synthetic-1', sourceStoreIdentity: sid('source-store'), protectionStatus: 'protected', enforcementDigest: sdg('enforcement'),
                aliasCoverageDigest: sdg('alias'), acceptedAtMs: 1700000000000
            },
            currentSelectionDigest: sdg('selection'), currentClosureDigest: sdg('closure'), aliasCoverage: 'complete', trustedAcceptances: ['acceptance-synthetic-1'],
            previouslyRobotWritable: false, writableBacking: false, linkInstallAlias: false, repositorySourceMode: 'prod',
            repositoryIdentity: 'https://example.invalid/synthetic/rwtarget.git', revision: { algorithm: 'git-sha1', value: 'a'.repeat(40) }
        },
        request: { coordinatorPrincipal: COORDINATOR, operationId: COORDINATOR_OPS[0], nowMs: Date.now() },
        home: { homeIdentity: 'home-synthetic-1', backendId: 'claude', workerInventoryDigest: sdg('inv-worker'), targetInventoryDigest: sdg('inv-target') },
        current: { worker: { ...worker }, limitsDigest: sdg('limits'), journalStoreIdentity: scope.store }
    };
}

const FIXTURE_DIGESTS = Object.fromEntries(['grantPolicyDigest', 'inputManifestDigest', 'skillViewManifestDigest', 'nativeConfigProjectionDigest', 'channelManifestDigest'].map((key) => [key, sdg(key)]));

function resources(seed, count = 2) {
    return Array.from({ length: count }, (_, index) => ({ resourceId: sid(`${seed}-${index}`), kind: index === 0 ? 'keeper' : 'gate', locatorDigest: sdg(`${seed}-locator-${index}`) }));
}

// One fixture world: journal, helper, qualification store with an installed record, worker host.
async function world(t, { keeper = true } = {}) {
    const base = tempBase(t);
    const root = path.join(base, 'jr');
    const store = journalInit(root);
    const incarnation = sid('incarnation-1');
    const mailbox = path.join(base, 'm1.sock');
    const helper = await startHelper(t, { root, store, incarnation, mailbox, keeper });
    const scope = live({ incarnation, containerId: 'c'.repeat(64), store });
    const storeRoot = path.join(base, 'q');
    const recordText = canonicalTargetJson(qualificationRecord(scope), { maxBytes: 1 << 20 }).value;
    const installed = installFixtureRecord({ fs, uid: UID, storeRoot, create: true, ref: TARGET, recordText, expectedLive: { containerId: scope.entry.containerId, helperIncarnation: incarnation } });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    const hostFor = (socket) => createWorkerHost({ stateDir: path.join(base, 'state'), mailbox: socket, peerCommand: PEER, ticketKey: loadFixtureTicketKey(), qualification: { root: storeRoot, uid: UID } });
    const host = hostFor(mailbox);
    const admitted = host.admit({ selection: TARGET, facts: facts(scope), operationId: COORDINATOR_OPS[0], fixtureDigests: FIXTURE_DIGESTS });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    return { base, root, store, incarnation, mailbox, helper, scope, storeRoot, host, hostFor, recordText };
}

function journalRecords(root) {
    const dir = path.join(root, 'journal', 'records');
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

test('session vectors are current and every minted ticket passes the production validator', { skip: false }, (t) => {
    const base = tempBase(t);
    const out = path.join(base, 'session-fixture-v1.json');
    const generated = spawnSync(process.execPath, [path.join(VECTORS, 'gen-session-fixture.mjs'), path.join(VECTORS, 'transport-v1.json'), out], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(VECTORS, 'session-fixture-v1.json'), 'utf8'), 'regenerated vectors are byte-identical');
    const vectors = JSON.parse(fs.readFileSync(out, 'utf8'));
    const transport = JSON.parse(fs.readFileSync(path.join(VECTORS, 'transport-v1.json'), 'utf8'));
    const key = loadFixtureTicketKey();
    assert.equal(key.secret.toString('ascii'), 'PUBLIC SYNTHETIC proof-fixture v');
    const claims = transport.ticket.claimsCanonical;
    assert.equal(sessionKey(key.secret, claims).toString('hex'), vectors.withFixtureKey.sessionKeyHex);
    assert.equal(possessionProof(sessionKey(key.secret, claims), 'worker-to-target', claims, vectors.inputs.helperNonce, vectors.inputs.challengeId, vectors.inputs.helperIncarnation, vectors.inputs.leaseId).toString('hex'), vectors.withFixtureKey.workerProofHex);
    const binding = transport.ticket.claims.binding;
    const nonce = crypto.randomBytes(32).toString('base64url');
    for (const [epoch, previous] of [['1', null], ['3', '1']]) {
        const minted = mintFixtureTicket({ key, binding, reservationId: sid('r'), leaseId: sid('lease'), operationId: sid('o'), requestDigest: sdg('req'), helperNonce: nonce, channelEpoch: epoch, previousChannelEpoch: previous });
        const checked = validateHelperTicketClaims(minted.ticket, {
            secret: key.secret, kid: key.kid, binding, expected: { reservationId: sid('r'), leaseId: sid('lease'), operationId: sid('o'), requestDigest: sdg('req'), helperNonce: nonce },
            channel: { currentEpoch: previous, leaseState: 'active' }, challenge: { id: 'c', issuedMonoMs: 0 }, nowMonoMs: 1, nowMs: Date.now(), replay: new Map()
        });
        assert.equal(checked.ok, true, JSON.stringify(checked));
        assert.equal(minted.claimsCanonical, canonicalTargetJson(minted.claims).value);
    }
});

test('round trip: admit, prepare, commit, lookup through the native worker peer; receipts match the journal oracle', { skip: SKIP }, async (t) => {
    const { host, store, incarnation, helper } = await world(t);
    assert.equal(helper.ready.value.keeperLauncher, 'proof-fixture-no-keeper');
    host.defineOperation('main', { resources: resources('main') });
    const prepared = await host.prepare('main');
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.classification, 'committed-or-reconciled');
    assert.equal(prepared.nodeValidated, true, 'the reply frame passed validateTargetFrame in Node too');
    assert.deepEqual([prepared.receipt.state, prepared.receipt.gateReleased, prepared.receipt.helperIncarnation, prepared.receipt.journalStoreIdentity], ['prepared', false, incarnation, store]);
    const committed = await host.commit('main');
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.deepEqual([committed.receipt.state, committed.receipt.gateReleased], ['running', true]);
    const looked = await host.lookup('main');
    assert.deepEqual([looked.ok, looked.state, looked.reconciled, looked.classification], [true, 'running', 'receipt', 'committed-or-reconciled']);
    // The same requests through the journal oracle give the same states, sequences and gate.
    const state = host.state();
    const op = state.operations.main;
    const model = createTargetJournalModel({ journalStoreIdentity: store, helperIncarnation: incarnation, now: () => 1 });
    const key = { workspaceId: state.binding.scope.workspaceId, workerGeneration: state.binding.scope.workerGeneration, executionId: state.binding.executionId, attemptId: state.binding.attemptId, operationId: op.operationId };
    const request = { key, targetBindingDigest: digestOf(state.binding), reservationId: op.reservationId, requestDigest: op.requestDigest, leaseId: state.leaseId, journalStoreIdentity: store, resources: JSON.parse(op.body).resources };
    const oracle = model.prepare(request);
    assert.equal(oracle.ok, true);
    assert.deepEqual([oracle.value.state, oracle.value.receiptSequence, oracle.value.gateReleased], [prepared.receipt.state, prepared.receipt.receiptSequence, prepared.receipt.gateReleased]);
    assert.deepEqual(oracle.value.resources.map((entry) => [entry.resourceId, entry.state]), prepared.receipt.resources.map((entry) => [entry.resourceId, entry.state]));
    const oracleCommit = model.commit({ key, targetBindingDigest: request.targetBindingDigest, reservationId: op.reservationId, workerCommitDigest: sdg('c'), preparedReceiptSequence: oracle.value.receiptSequence, preparedResourcesDigest: digestOf(oracle.value.resources, 1 << 20) });
    assert.deepEqual([oracleCommit.value.state, oracleCommit.value.receiptSequence, oracleCommit.value.gateReleased], [committed.receipt.state, committed.receipt.receiptSequence, committed.receipt.gateReleased]);
    assert.ok(helper.events.some((event) => event.event === 'session' && event.channelEpoch === '3'), 'three sessions on one lease: epochs 1, 2, 3');
});

test('a dropped prepare reply resolves by same-operation lookup; a conflicting payload refuses', { skip: SKIP }, async (t) => {
    const { host, root } = await world(t);
    host.defineOperation('lost', { resources: resources('lost') });
    const dropped = await host.prepare('lost', { drop: true });
    assert.deepEqual([dropped.ok, dropped.fault, dropped.classification], [true, 'lost-reply', 'outcome-unknown']);
    const looked = await host.lookup('lost');
    assert.deepEqual([looked.state, looked.reconciled, looked.classification], ['prepared', 'receipt', 'committed-or-reconciled']);
    host.defineOperation('conflict', { resources: resources('other-payload'), sameOperationAs: 'lost' });
    const before = journalRecords(root);
    const conflict = await host.prepare('conflict');
    assert.deepEqual([conflict.ok, conflict.stage, conflict.code], [false, 'helper', 'operation_conflict'], JSON.stringify(conflict));
    assert.equal(conflict.classification, 'outcome-unknown', 'a refusal without absence evidence never proves nothing was created');
    assert.deepEqual(journalRecords(root), before, 'the conflicting payload changed no journal record');
    const again = await host.lookup('lost');
    assert.equal(again.receipt.receiptSequence, looked.receipt.receiptSequence);
});

test('replacing the target between admission and commit refuses; the journal record survives unreleased', { skip: SKIP }, async (t) => {
    const w = await world(t);
    w.host.defineOperation('main', { resources: resources('main') });
    assert.equal((await w.host.prepare('main')).ok, true);
    // Replacement: the helper dies and a new incarnation serves the same journal from a new mailbox.
    await w.helper.stop();
    const replacement = sid('incarnation-2');
    const mailbox2 = path.join(w.base, 'm2.sock');
    await startHelper(t, { root: w.root, store: w.store, incarnation: replacement, mailbox: mailbox2 });
    const current = live({ incarnation: replacement, containerId: 'd'.repeat(64), store: w.store });
    // 1. The worker revalidates the admitted binding before commit and refuses without contacting the helper.
    const revalidated = await w.host.commit('main', { facts: facts(current) });
    assert.deepEqual([revalidated.ok, revalidated.stage, revalidated.code], [false, 'revalidate', 'binding_mismatch']);
    // 2. The old mailbox is a stale socket: connect refused (never a journal fact).
    const stale = await w.host.commit('main');
    assert.deepEqual([stale.ok, stale.stage, stale.code], [false, 'connect', 'connect_refused']);
    // 3. Reaching the new helper anyway, the worker peer refuses to present the old binding to another incarnation.
    const host2 = w.hostFor(mailbox2);
    const forced = await host2.commit('main');
    assert.deepEqual([forced.ok, forced.stage, forced.code, forced.challengeIncarnation], [false, 'bootstrap', 'ticket_binding', replacement]);
    // 4. The prepared record is still in the journal, gate unreleased, naming the incarnation that prepared it.
    const records = journalRecords(w.root);
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].body.state, records[0].body.gateReleased, records[0].body.helperIncarnation], ['prepared', false, w.incarnation]);
});

test('keeper supervisor without a keeper binary: prepare refuses keeper_unavailable before any journal write; only lookup absence proves nothing was created', { skip: SKIP }, async (t) => {
    const { host, root, helper } = await world(t, { keeper: false });
    assert.equal(helper.ready.value.keeperLauncher, 'keeper-supervisor');
    host.defineOperation('main', { resources: resources('main') });
    const refused = await host.prepare('main');
    assert.deepEqual([refused.ok, refused.code, refused.classification], [false, 'keeper_unavailable', 'outcome-unknown']);
    assert.deepEqual(journalRecords(root), [], 'no journal record');
    const looked = await host.lookup('main');
    assert.deepEqual([looked.state, looked.reconciled, looked.classification], ['absent-with-proof', 'absent', 'refused-before-create']);
});

test('A11.2: a lost `accepted` costs one epoch number; the next attempt (max(attempt, accepted) + 1) recovers', { skip: SKIP }, async (t) => {
    const { host, helper } = await world(t);
    host.defineOperation('main', { resources: resources('main') });
    assert.equal((await host.prepare('main')).ok, true);
    assert.equal(host.state().leaseEpoch, '1');
    const lost = await host.lookup('main', { loseAccepted: true });
    assert.deepEqual([lost.ok, lost.fault, lost.attemptedEpoch, lost.peer], [true, 'accepted-lost', '2', 'bootstrap-dropped']);
    assert.deepEqual([host.state().leaseAttempt, host.state().leaseEpoch], ['2', '1'], 'the attempt was recorded before the bootstrap');
    const recovered = await host.lookup('main');
    assert.deepEqual([recovered.ok, recovered.state, recovered.classification], [true, 'prepared', 'committed-or-reconciled']);
    assert.deepEqual([host.state().leaseAttempt, host.state().leaseEpoch], ['3', '3']);
    assert.ok(helper.events.some((event) => event.event === 'session' && event.channelEpoch === '3'));
});

test('A11.6 and A11.4: helper codes are reduced to known spellings; the session vectors are part of the contract digest', () => {
    assert.equal(knownCode('operation_conflict'), 'operation_conflict');
    assert.equal(knownCode('keeper_unavailable'), 'keeper_unavailable');
    assert.equal(knownCode('ticket_binding'), 'ticket_binding');
    assert.equal(knownCode('free text from a helper'), 'refused');
    assert.equal(knownCode({ code: 'x' }), 'refused');
    const inventory = { version: 1, platform: 'linux/amd64', baseImage: 'synthetic', files: ['/bin/setpriv', '/usr/bin/bwrap', '/usr/libexec/ploinky-target/launch', '/usr/libexec/ploinky-target/peer', '/usr/libexec/ploinky-target/rw-file-server', '/usr/libexec/ploinky-target/rw-target-helper', '/usr/local/bin/node', '/usr/local/libexec/robo-work/keeper'].map((file) => ({ path: file, sha256: file.endsWith('rw-target-helper') ? sha('helper') : sha(file), mode: '555' })) };
    const render = (sessionVectorsBytes) => renderManifest({
        templateText: fs.readFileSync(path.join(ROBO_WORK, 'tests', 'g7', 'fixture', 'rwtarget', 'manifest.template.json'), 'utf8'), image: `localhost/rwtarget@sha256:${'a'.repeat(64)}`, inventory,
        helperBytes: Buffer.from('helper'), transportVectorsBytes: Buffer.from('t'), commonVectorsBytes: Buffer.from('c'), sessionVectorsBytes, seccompBytes: Buffer.from('s')
    }).values.HELPER_CONTRACT_DIGEST;
    const current = render(fs.readFileSync(path.join(VECTORS, 'session-fixture-v1.json')));
    assert.notEqual(current, render(Buffer.from('another handshake')), 'a handshake change changes the contract digest');
    assert.throws(() => render(undefined), /session vectors/);
});

test('rwtarget inventory: the keeper and Node sit at the keeper policy paths, and every file the embedded policy pins is inventoried', () => {
    const files = ['/bin/busybox', '/bin/setpriv', '/lib/ld-musl-x86_64.so.1', '/usr/bin/bwrap', '/usr/libexec/ploinky-target/launch', '/usr/libexec/ploinky-target/peer',
        '/usr/libexec/ploinky-target/rw-file-server', '/usr/libexec/ploinky-target/rw-target-helper', '/usr/local/bin/node', '/usr/local/libexec/robo-work/keeper',
        '/opt/robo-work/server/execution/providerEndpointMain.mjs'].sort();
    const inventory = { version: 1, platform: 'linux/amd64', baseImage: 'synthetic', files: files.map((file) => ({ path: file, sha256: file.endsWith('rw-target-helper') ? sha('helper') : sha(file), mode: '555' })) };
    const loader = { path: '/lib/ld-musl-x86_64.so.1', sha256: sha('/lib/ld-musl-x86_64.so.1') };
    const exe = (file, extra = {}) => ({ path: file, sha256: sha(file), closure: 'complete', runtime: [loader], ...extra });
    const policy = {
        version: 1, node: exe('/usr/local/bin/node'), bwrap: exe('/usr/bin/bwrap'),
        keeper: { path: '/usr/local/libexec/robo-work/keeper', sha256: 'self', closure: 'complete', runtime: [] },
        inventory: { sleep: exe('/usr/bin/sleep', { source: '/bin/busybox', sha256: sha('/bin/busybox') }) },
        code: { endpoint: [{ path: '/opt/robo-work/server/execution/providerEndpointMain.mjs', sha256: sha('/opt/robo-work/server/execution/providerEndpointMain.mjs') }] },
        endpointHeapMib: 48, endpointNofile: 256
    };
    const render = (keeperPolicy, renderedInventory = inventory) => renderManifest({
        templateText: fs.readFileSync(path.join(ROBO_WORK, 'tests', 'g7', 'fixture', 'rwtarget', 'manifest.template.json'), 'utf8'), image: `localhost/rwtarget@sha256:${'a'.repeat(64)}`,
        inventory: renderedInventory, helperBytes: Buffer.from('helper'), transportVectorsBytes: Buffer.from('t'), commonVectorsBytes: Buffer.from('c'),
        sessionVectorsBytes: Buffer.from('v'), seccompBytes: Buffer.from('s'), keeperPolicy
    });
    assert.match(render(policy).values.INVENTORY_DIGEST, /^[0-9a-f]{64}$/);
    assert.throws(() => render({ ...policy, inventory: { sleep: exe('/usr/bin/sleep', { source: '/bin/busybox', sha256: sha('other') }) } }), /not inventoried/);
    assert.throws(() => render({ ...policy, node: exe('/usr/bin/node') }), /fixed paths/);
    const oldKeeperPath = { ...inventory, files: inventory.files.filter((file) => file.path !== '/usr/local/libexec/robo-work/keeper') };
    assert.throws(() => render(policy, oldKeeperPath), /inventory is invalid or incomplete/);
});

// ---- --router-tickets (mint route spec 2026-10-30: E1, R3) ----

const SELF = Object.freeze({ principal: WORKER, runtimeInstanceId: 'worker-runtime-rt', enableGeneration: 'worker-enable-rt' });

// A test Router: the production client over a transport that answers like Ploinky's private helper-ticket operation,
// signing with the helper's per-incarnation secret (`key`) and deriving the A11.5 session key. `script` entries are
// consumed first: `{status, body}` answers, `{throws: message}` transport failures, `{transform(value)}` answers. Every
// issued ticket and session key is kept here, in memory only, as the needles of the R3 scans.
function testRouter(key) {
    const router = { requests: [], issued: [], script: [] };
    router.transport = async (bytes) => {
        const request = JSON.parse(bytes.toString('utf8'));
        router.requests.push(request);
        const next = router.script.shift();
        if (next?.throws) throw new Error(next.throws);
        if (next?.status) return { status: next.status, body: Buffer.from(JSON.stringify(next.body)) };
        const minted = mintFixtureTicket({
            key: next?.key ?? key, binding: request.binding, reservationId: request.reservationId, leaseId: request.leaseId, operationId: request.operationId,
            requestDigest: request.requestDigest, helperNonce: request.helperNonce, channelEpoch: request.channelEpoch, previousChannelEpoch: request.previousChannelEpoch,
            permissions: request.permissions, lifetimeSeconds: request.ttlSeconds
        });
        const sessionKeyText = minted.sessionKey.toString('base64url');
        router.issued.push({ ticket: minted.ticket, sessionKey: sessionKeyText });
        let value = { ticket: minted.ticket, kid: (next?.key ?? key).kid, jti: minted.claims.jti, iat: minted.claims.iat, exp: minted.claims.exp, sessionKey: sessionKeyText };
        if (next?.transform) value = next.transform(value);
        return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, value })) };
    };
    router.client = createHelperTicketClient({ transport: router.transport });
    return router;
}

function needlesOf(issued) {
    return issued.flatMap(({ ticket, sessionKey }) => [ticket, ticket.split('.')[2], sessionKey, Buffer.from(sessionKey, 'base64url').toString('hex')]);
}

function occurrences(text, needles) {
    return needles.reduce((sum, needle) => sum + text.split(needle).length - 1, 0);
}

// A worker-peer wrapper that records its argv and environment before exec'ing the real peer (R3: what the worker
// hands its child process outside stdin).
function recordingPeer(base) {
    const log = path.join(base, 'peer-exec.log');
    const wrapper = path.join(base, 'peer-wrapper.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\n{ printf 'ARGV'; printf ' %s' "$@"; printf '\\n'; env; } >> '${log}'\nexec '${PEER}' "$@"\n`, { mode: 0o700 });
    return { wrapper, log };
}

const noSleep = (delays) => async (ms) => { delays.push(ms); };

// One router-mode world: a helper verifying with its consumed per-incarnation secret, a test Router holding that
// secret, an advanced worker generation and an admission whose worker half is this worker.
async function routerWorld(t, { advanceResult = null } = {}) {
    const base = tempBase(t);
    const root = path.join(base, 'jr');
    const store = journalInit(root);
    const incarnation = sid('incarnation-rt');
    const mailbox = path.join(base, 'm1.sock');
    const helper = await startHelper(t, { root, store, incarnation, mailbox, router: true });
    const router = testRouter(helper.key);
    const peer = recordingPeer(base);
    const advances = [];
    const sourceProtection = {
        async advanceWorkerGeneration(context, body) {
            advances.push({ context, body });
            return advanceResult ? advanceResult(body) : { ok: true, value: { version: 1, operationId: body.operationId, workerPrincipal: WORKER, priorGeneration: body.priorGeneration, currentGeneration: body.nextGeneration, requestDigest: sdg('advance') } };
        }
    };
    const delays = [];
    const storeRoot = path.join(base, 'q');
    const stateDir = path.join(base, 'state');
    const hostFor = (overrides = {}) => createWorkerHost({
        stateDir, mailbox, peerCommand: peer.wrapper, mintTicket: router.client.mintTicket, self: SELF, sourceProtection, qualification: { root: storeRoot, uid: UID },
        sleep: noSleep(delays), ...overrides
    });
    const host = hostFor();
    return { base, root, store, incarnation, mailbox, helper, router, peer, advances, delays, storeRoot, stateDir, host, hostFor };
}

function admitRouter(w) {
    const worker = { ...SELF, generation: w.host.state().workerGeneration };
    const scope = live({ incarnation: w.incarnation, containerId: 'c'.repeat(64), store: w.store });
    const recordText = canonicalTargetJson(qualificationRecord(scope, worker), { maxBytes: 1 << 20 }).value;
    const installed = installFixtureRecord({ fs, uid: UID, storeRoot: w.storeRoot, create: true, ref: TARGET, recordText, expectedLive: { containerId: scope.entry.containerId, helperIncarnation: w.incarnation } });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    return { scope, worker, admitted: w.host.admit({ selection: TARGET, facts: facts(scope, worker), operationId: COORDINATOR_OPS[0], fixtureDigests: FIXTURE_DIGESTS }) };
}

test('router tickets: advance, admit, then the helper accepts Router tickets verified under its own secret; lookup and frames use the Router session key; R3 scans are clean', { skip: SKIP }, async (t) => {
    const w = await routerWorld(t);
    const results = [];
    // Q3: the worker registers its generation first; admission refuses facts whose worker half is not this worker.
    const advanced = await w.host.advanceGeneration();
    results.push(advanced);
    assert.deepEqual([advanced.ok, advanced.priorGeneration], [true, null], JSON.stringify(advanced));
    assert.equal(w.host.state().workerGeneration, advanced.workerGeneration);
    assert.equal(w.advances.length, 1);
    assert.deepEqual(Object.keys(w.advances[0].body).sort(), ['nextGeneration', 'operationId', 'priorGeneration', 'version']);
    const scope = live({ incarnation: w.incarnation, containerId: 'c'.repeat(64), store: w.store });
    const stale = w.host.admit({ selection: TARGET, facts: facts(scope, { ...SELF, generation: sid('another-generation') }), operationId: COORDINATOR_OPS[0], fixtureDigests: FIXTURE_DIGESTS });
    assert.deepEqual([stale.ok, stale.code], [false, 'worker_identity_mismatch']);
    const { admitted } = admitRouter(w);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    results.push(admitted);
    const leaseId = w.host.state().leaseId;
    assert.equal(Buffer.from(leaseId, 'base64url').length, 16, 'the lease id is a fresh opaque 128-bit id');
    w.host.defineOperation('main', { resources: resources('main') });

    // A real ticket under the per-incarnation secret is accepted: prepare reaches the helper, which refuses only because
    // the host has no keeper binary, before any journal write.
    const prepared = await w.host.prepare('main');
    results.push(prepared);
    assert.deepEqual([prepared.ok, prepared.stage, prepared.code, prepared.nodeValidated], [false, 'helper', 'keeper_unavailable', true], JSON.stringify(prepared));
    assert.deepEqual(journalRecords(w.root), []);
    // lookup over a Router session, with the U7/R3 probe: the reply frame passed validateTargetFrame under the Router key.
    let sunk = null;
    const looked = await w.host.lookup('main', { scan: { sink: (needles) => { sunk = needles; } } });
    results.push(looked);
    assert.deepEqual([looked.ok, looked.state, looked.reconciled, looked.classification, looked.nodeValidated], [true, 'absent-with-proof', 'absent', 'refused-before-create', true], JSON.stringify(looked));
    assert.deepEqual([looked.ticket.source, looked.ticket.mintAttempts, looked.ticket.kid], ['router', 1, `hti1.${w.incarnation}`]);
    assert.deepEqual(looked.scan, { needles: 4, positiveControl: 4, selfArgv: 0, selfEnviron: 0, peerArgv: 0, peerEnviron: 0, stateFiles: looked.scan.stateFiles, stateMatches: 0 });
    assert.ok(looked.scan.stateFiles >= 1);
    assert.deepEqual(sunk, needlesOf(w.router.issued.slice(-1)), 'the sink received exactly the live session\'s needles');
    // A11.2 with the Router: a lost `accepted` costs one epoch; the next request is max(attempt, accepted) + 1.
    const lost = await w.host.lookup('main', { loseAccepted: true });
    results.push(lost);
    assert.deepEqual([lost.fault, lost.attemptedEpoch], ['accepted-lost', '3']);
    const recovered = await w.host.lookup('main');
    results.push(recovered);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.deepEqual(w.router.requests.map((request) => [request.channelEpoch, request.previousChannelEpoch]), [['1', null], ['2', '1'], ['3', '2'], ['4', '2']]);
    assert.deepEqual([w.host.state().leaseAttempt, w.host.state().leaseEpoch], ['4', '4']);
    // Every request is exactly the ten-key minter request, on one lease, with sorted permissions and the 30 s lifetime.
    for (const request of w.router.requests) {
        assert.deepEqual(Object.keys(request).sort(), [...HELPER_TICKET_REQUEST_KEYS].sort());
        assert.deepEqual([request.leaseId, request.ttlSeconds, request.permissions], [leaseId, TICKET_TTL_SECONDS, ['commit', 'lookup', 'prepare']]);
    }
    assert.ok(w.helper.events.some((event) => event.event === 'session' && event.channelEpoch === '4'));

    // R3: no session key or full ticket in the worker's state directory, the peer's argv and environment, or any result.
    const needles = needlesOf(w.router.issued);
    assert.equal(w.router.issued.length, 4);
    const stateText = filesText(w.stateDir);
    const peerText = fs.readFileSync(w.peer.log, 'utf8');
    const resultsText = JSON.stringify(results);
    assert.ok(peerText.split('\n').filter((line) => line.startsWith('ARGV')).length >= 4, 'every session started the wrapped peer');
    assert.deepEqual([occurrences(stateText, needles), occurrences(peerText, needles), occurrences(resultsText, needles)], [0, 0, 0]);
    assert.equal(occurrences(JSON.stringify(process.argv) + JSON.stringify(process.env), needles), 0);
    // Positive control: the same scan finds them in a memory-only buffer that holds them.
    const control = `${stateText}\n${needles.join('\n')}\n${peerText}`;
    assert.equal(needles.filter((needle) => control.includes(needle)).length, needles.length);
});

function filesText(root) {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(fs.readFileSync(full, 'utf8'));
        }
    };
    walk(root);
    return out.join('\n');
}

test('router tickets: transient refusals retry with bounded backoff inside one challenge, then one fresh session; other refusals are terminal and mapped', { skip: SKIP }, async (t) => {
    const w = await routerWorld(t);
    assert.equal((await w.host.advanceGeneration()).ok, true);
    assert.equal(admitRouter(w).admitted.ok, true);
    w.host.defineOperation('main', { resources: resources('main') });
    const refusal = (code) => ({ status: 200, body: { ok: false, error: { code } } });
    // Transient: a definite refusal, a 503 (generation changed) and a 429, then a ticket, all on one helper nonce.
    w.router.script.push(refusal('secret_unavailable'), { throws: 'helper_ticket_http_503' }, { status: 429, body: { error: 'capacity_exceeded' } });
    const retried = await w.host.lookup('main');
    assert.deepEqual([retried.ok, retried.ticket.mintAttempts], [true, 4], JSON.stringify(retried));
    assert.deepEqual(w.delays, MINT_RETRY.delaysMs.slice(0, 3));
    assert.equal(new Set(w.router.requests.map((request) => request.helperNonce)).size, 1, 'the retries reused the one challenge nonce');
    assert.equal(new Set(w.router.requests.map((request) => request.channelEpoch)).size, 1, 'and its recorded epoch (nothing was minted)');
    // Exhausted: every attempt transient -> the challenge budget, then one more session (new nonce, new attempt epoch).
    w.delays.length = 0;
    w.router.requests.length = 0;
    const attemptBefore = BigInt(w.host.state().leaseAttempt);
    w.router.script.push(...Array.from({ length: 8 }, () => refusal('caller_mismatch')));
    const exhausted = await w.host.lookup('main');
    assert.deepEqual([exhausted.ok, exhausted.stage, exhausted.code, exhausted.mintAttempts], [false, 'mint', 'caller_mismatch', 8], JSON.stringify(exhausted));
    assert.deepEqual(w.delays, [...MINT_RETRY.delaysMs, MINT_RETRY.sessionDelayMs, ...MINT_RETRY.delaysMs]);
    assert.equal(new Set(w.router.requests.map((request) => request.helperNonce)).size, 2);
    assert.equal(BigInt(w.host.state().leaseAttempt), attemptBefore + 2n, 'each session recorded its own attempt epoch');
    // The challenge budget bounds the retries even when the delays would allow more.
    w.router.script.length = 0;
    w.router.requests.length = 0;
    let clock = 0;
    const slow = w.hostFor({ monoNow: () => { clock += 1400; return clock; }, retry: { ...MINT_RETRY, sessions: 1 } });
    w.router.script.push(refusal('target_not_eligible'), refusal('target_not_eligible'), refusal('target_not_eligible'));
    const bounded = await slow.lookup('main');
    assert.deepEqual([bounded.ok, bounded.code, bounded.mintAttempts], [false, 'target_not_eligible', 2]);
    w.router.script.length = 0;
    // Terminal: an evidence refusal, an unknown code (A11.6: `refused`), a forbidden caller, a transport failure whose
    // message is never propagated, and a ticket that does not say what was asked (`ticket_binding`).
    for (const [script, code] of [
        [refusal('target_mismatch'), 'target_mismatch'], [refusal('Free text: unexpected'), 'refused'],
        [{ status: 403, body: { error: 'PRIVATE_CALLER_DENIED' } }, 'forbidden'], [{ throws: 'connect ECONNREFUSED 10.0.0.1 secret-ish detail' }, 'mint_unavailable'],
        [{ status: 500, body: { error: 'x' } }, 'mint_unavailable'],
        [{ transform: (value) => ({ ...value, exp: value.exp + 1 }) }, 'ticket_binding']
    ]) {
        w.router.requests.length = 0;
        w.router.script.push(script);
        const refused = await w.host.lookup('main');
        assert.deepEqual([refused.ok, refused.stage, refused.code, refused.mintAttempts], [false, 'mint', code, 1], JSON.stringify(refused));
        assert.equal(JSON.stringify(refused).includes('ECONNREFUSED'), false);
    }
    assert.equal(occurrences(filesText(w.stateDir), needlesOf(w.router.issued)), 0);
});

test('router tickets: a ticket under another secret is refused by the helper; the host takes exactly one ticket source', { skip: SKIP }, async (t) => {
    const w = await routerWorld(t);
    assert.equal((await w.host.advanceGeneration()).ok, true);
    assert.equal(admitRouter(w).admitted.ok, true);
    w.host.defineOperation('main', { resources: resources('main') });
    w.router.script.push({ key: { kid: `hti1.${w.incarnation}`, secret: crypto.randomBytes(32) } });
    const forged = await w.host.lookup('main');
    assert.deepEqual([forged.ok, forged.stage], [false, 'bootstrap'], JSON.stringify(forged));
    assert.notEqual(forged.code, 'refused');
    const good = await w.host.lookup('main');
    assert.equal(good.ok, true, JSON.stringify(good));
    const options = { stateDir: path.join(w.base, 's2'), mailbox: w.mailbox, peerCommand: PEER, qualification: { root: w.storeRoot, uid: UID } };
    assert.throws(() => createWorkerHost(options), /exactly one/);
    assert.throws(() => createWorkerHost({ ...options, ticketKey: loadFixtureTicketKey(), mintTicket: w.router.client.mintTicket }), /exactly one/);
    assert.throws(() => createWorkerHost({ ...options, mintTicket: 'not a function' }), /exactly one/);
});

test('router tickets: advance replays its recorded body after an unknown outcome, refuses a mismatched result and takes a prior generation for a fresh state directory', async (t) => {
    const base = tempBase(t);
    const bodies = [];
    let mode = 'throw';
    const sourceProtection = {
        async advanceWorkerGeneration(_context, body) {
            bodies.push(body);
            if (mode === 'throw') throw new Error('socket hang up');
            if (mode === 'mismatch') return { ok: true, value: { version: 1, operationId: body.operationId, workerPrincipal: WORKER, priorGeneration: body.priorGeneration, currentGeneration: sid('other'), requestDigest: sdg('a') } };
            if (mode === 'refuse') return { ok: false, error: { code: 'stale_generation' } };
            return { ok: true, value: { version: 1, operationId: body.operationId, workerPrincipal: WORKER, priorGeneration: body.priorGeneration, currentGeneration: body.nextGeneration, requestDigest: sdg('a') } };
        }
    };
    const host = createWorkerHost({ stateDir: path.join(base, 'state'), mailbox: path.join(base, 'm.sock'), peerCommand: '/bin/false', mintTicket: async () => ({ ok: false, error: { code: 'refused' } }), self: SELF, sourceProtection, qualification: { root: path.join(base, 'q'), uid: UID } });
    assert.deepEqual([(await host.advanceGeneration()).code], ['outcome_unknown']);
    mode = 'ok';
    const done = await host.advanceGeneration();
    assert.equal(done.ok, true);
    assert.deepEqual(bodies[1], bodies[0], 'the unknown outcome is retried with the same body');
    assert.equal(host.state().workerGeneration, bodies[0].nextGeneration);
    mode = 'mismatch';
    assert.deepEqual([(await host.advanceGeneration()).code], ['advance_result_mismatch']);
    assert.equal(bodies[2].priorGeneration, bodies[0].nextGeneration);
    mode = 'refuse';
    assert.deepEqual([(await host.advanceGeneration()).code], ['stale_generation']);
    assert.equal(host.state().workerGeneration, bodies[0].nextGeneration, 'refusals leave the registered generation');
    assert.notEqual(bodies[3].operationId, bodies[2].operationId, 'a definite outcome is not replayed');
    // A fresh state directory names the registered generation as its prior; a state directory that has one must agree.
    mode = 'ok';
    const fresh = createWorkerHost({ stateDir: path.join(base, 'state2'), mailbox: path.join(base, 'm.sock'), peerCommand: '/bin/false', mintTicket: async () => ({ ok: false, error: { code: 'refused' } }), self: SELF, sourceProtection, qualification: { root: path.join(base, 'q'), uid: UID } });
    const g1 = host.state().workerGeneration;
    const next = await fresh.advanceGeneration({ priorGeneration: g1 });
    assert.deepEqual([next.ok, next.priorGeneration, bodies.at(-1).priorGeneration], [true, g1, g1]);
    assert.deepEqual([(await fresh.advanceGeneration({ priorGeneration: g1 })).code], ['prior_generation_mismatch'], 'its own registered generation wins');
    assert.deepEqual([(await host.advanceGeneration({ priorGeneration: 7 })).code], ['prior_generation_mismatch']);
});

test('router tickets: mint outcome classification and A11.6 spellings', () => {
    const ok = { result: { ok: true, value: { ticket: 'a.b.c', sessionKey: 'k' } } };
    assert.deepEqual(classifyMint(ok), { kind: 'ok' });
    for (const code of ['caller_mismatch', 'target_not_eligible', 'secret_unavailable', 'capacity_exceeded']) {
        assert.deepEqual(classifyMint({ result: { ok: false, error: { code } } }), { kind: 'retry', code });
    }
    assert.deepEqual(classifyMint({ error: new Error('helper_ticket_http_503') }), { kind: 'retry', code: 'router_unavailable' });
    assert.deepEqual(classifyMint({ error: new Error('helper_ticket_http_429') }), { kind: 'retry', code: 'capacity_exceeded' });
    for (const code of ['target_mismatch', 'target_scope_mismatch', 'channel_epoch_conflict', 'ticket_replayed', 'forbidden', 'ticket_binding', 'invalid_request']) {
        assert.deepEqual(classifyMint({ result: { ok: false, error: { code } } }), { kind: 'terminal', code });
    }
    assert.deepEqual(classifyMint({ result: { ok: false, error: { code: 'made up' } } }), { kind: 'terminal', code: 'refused' });
    assert.deepEqual(classifyMint({ error: new Error('helper_ticket_http_500') }), { kind: 'terminal', code: 'mint_unavailable' });
    assert.deepEqual(classifyMint({ error: 'not an error' }), { kind: 'terminal', code: 'mint_unavailable' });
    assert.deepEqual(classifyMint({ result: { ok: true, value: { ticket: 1 } } }), { kind: 'terminal', code: 'refused' });
    assert.equal(mintCode({}), 'refused');
});

test('router tickets: main.mjs guards (advance and --needle-fd need --router-tickets; a missing agent transport and a non-pipe needle fd refuse)', (t) => {
    const base = tempBase(t);
    const common = ['--state', path.join(base, 'st'), '--mailbox', path.join(base, 'm.sock'), '--peer', '/bin/false', '--store-root', path.join(base, 'q')];
    const run = (args, extra = {}) => spawnSync(process.execPath, [MAIN, ...common, ...args], { encoding: 'utf8', ...extra });
    const advance = run(['advance']);
    assert.deepEqual([advance.status, advance.stderr.trim()], [1, 'rwworker: advance needs --router-tickets']);
    const needle = run(['lookup', 'x', '--needle-fd', '3']);
    assert.deepEqual([needle.status, needle.stderr.trim()], [1, 'rwworker: this option needs --router-tickets']);
    const missing = run(['--router-tickets', '--agent-lib', path.join(base, 'no-agent-lib'), 'state']);
    assert.deepEqual([missing.status, missing.stderr.trim()], [1, 'rwworker: agent transport helperTicketTransport.mjs is unavailable']);
    const file = fs.openSync(path.join(base, 'plain-file'), 'w');
    const notPipe = run(['--router-tickets', '--agent-lib', path.join(base, 'no-agent-lib'), 'lookup', 'x', '--needle-fd', '3'], { stdio: ['ignore', 'pipe', 'pipe', file] });
    fs.closeSync(file);
    assert.deepEqual([notPipe.status, notPipe.stderr.trim()], [1, 'rwworker: --needle-fd must name an inherited pipe']);
    assert.equal(fs.readFileSync(path.join(base, 'plain-file'), 'utf8'), '');
    // --needle-fd is refused for any command but lookup, and for fd 0-2 or a non-integer, even when that fd is a pipe.
    const notLookup = run(['--router-tickets', '--agent-lib', path.join(base, 'no-agent-lib'), 'state', '--needle-fd', '3']);
    assert.deepEqual([notLookup.status, notLookup.stderr.trim()], [1, 'rwworker: --needle-fd applies to lookup only']);
    for (const fd of ['1', '2', '0', 'x', '3.5']) {
        const low = run(['--router-tickets', '--agent-lib', path.join(base, 'no-agent-lib'), 'lookup', 'x', '--needle-fd', fd]);
        assert.deepEqual([low.status, low.stderr.trim(), low.stdout], [1, 'rwworker: --needle-fd must name an inherited pipe', ''], fd);
    }
    // With a real FIFO (Node's own stdio pipes are socketpairs): accepted as fd 3 (the run then stops at the missing agent
    // transport), refused as fd 1; nothing is ever written to it.
    const fifo = path.join(base, 'needles.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const fifoFd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const asFd3 = run(['--router-tickets', '--agent-lib', path.join(base, 'no-agent-lib'), 'lookup', 'x', '--needle-fd', '3'], { stdio: ['ignore', 'pipe', 'pipe', fifoFd] });
    assert.deepEqual([asFd3.status, asFd3.stderr.trim()], [1, 'rwworker: agent transport helperTicketTransport.mjs is unavailable']);
    const asFd1 = run(['--router-tickets', '--agent-lib', path.join(base, 'no-agent-lib'), 'lookup', 'x', '--needle-fd', '1'], { stdio: ['ignore', fifoFd, 'pipe'] });
    assert.deepEqual([asFd1.status, asFd1.stderr.trim()], [1, 'rwworker: --needle-fd must name an inherited pipe']);
    // A fresh non-blocking reader (spawning made the shared descriptor blocking); the open writer makes empty mean EAGAIN.
    const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    assert.throws(() => fs.readSync(reader, Buffer.alloc(16)), { code: 'EAGAIN' }, 'nothing was written to the FIFO');
    fs.closeSync(reader);
    fs.closeSync(fifoFd);
});

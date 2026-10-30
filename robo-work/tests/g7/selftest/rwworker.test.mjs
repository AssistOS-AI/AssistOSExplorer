// Slice P6b host-level self-test of the rwworker fixture: the worker host (production executionTarget modules) drives
// the native worker peer against a real `rw-target-helper serve --proof-fixture-session` over an AF_UNIX mailbox.
// Every identity, key and record here is synthetic; the ticket key is the PUBLIC SYNTHETIC proof-fixture key.
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
import { createWorkerHost, knownCode } from '../fixture/rwworker/workerHost.mjs';
import { renderManifest } from '../fixture/rwtarget/render-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROBO_WORK = path.resolve(here, '..', '..', '..');
const VECTORS = path.join(ROBO_WORK, 'native', 'crates', 'target-helper', 'tests', 'vectors');
const HELPER = process.env.RW_TARGET_HELPER_FIXTURE_BIN;
const PEER = process.env.RW_TARGET_HELPER_BIN || HELPER;
const SKIP = HELPER ? false : 'RW_TARGET_HELPER_FIXTURE_BIN is not set (SKIPPED, not passed)';
const UID = process.getuid();

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
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

async function startHelper(t, { root, store, incarnation, mailbox, keeper = true }) {
    const args = ['serve', '--mailbox', mailbox, '--journal-root', root, '--store-identity', store, '--helper-incarnation', incarnation, '--proof-fixture-session'];
    if (keeper) args.push('--proof-fixture-keeper');
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
    return { child, ready, events, stop };
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

function qualificationRecord(scope) {
    return {
        version: 1, qualificationClass: 'proof-fixture',
        scope: {
            workspaceId: scope.live.workspaceId, boxIdentity: scope.live.boxIdentity, boxGeneration: scope.live.boxGeneration, workerPrincipal: WORKER,
            workerRuntimeInstanceId: 'worker-runtime-1', workerEnableGeneration: 'worker-enable-1', workerGeneration: sid('worker-gen'),
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

function facts(scope) {
    return {
        surface: 'terminal', mode: 'proof-fixture', live: scope.live,
        excluded: { principals: ['agent:SyntheticIDE/roboTeamAgent', WORKER], aliases: [], runtimeInstanceIds: ['worker-runtime-1'] },
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
        current: { worker: { principal: WORKER, runtimeInstanceId: 'worker-runtime-1', enableGeneration: 'worker-enable-1', generation: sid('worker-gen') }, limitsDigest: sdg('limits'), journalStoreIdentity: scope.store }
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

test('pre-G1 launcher: prepare refuses keeper_unavailable before any journal write; only lookup absence proves nothing was created', { skip: SKIP }, async (t) => {
    const { host, root, helper } = await world(t, { keeper: false });
    assert.equal(helper.ready.value.keeperLauncher, 'unavailable-until-g1');
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
    const inventory = { version: 1, platform: 'linux/amd64', baseImage: 'synthetic', files: ['/bin/setpriv', '/usr/bin/bwrap', '/usr/libexec/ploinky-target/keeper', '/usr/libexec/ploinky-target/launch', '/usr/libexec/ploinky-target/peer', '/usr/libexec/ploinky-target/rw-file-server', '/usr/libexec/ploinky-target/rw-target-helper'].map((file) => ({ path: file, sha256: file.endsWith('rw-target-helper') ? sha('helper') : sha(file), mode: '555' })) };
    const render = (sessionVectorsBytes) => renderManifest({
        templateText: fs.readFileSync(path.join(ROBO_WORK, 'tests', 'g7', 'fixture', 'rwtarget', 'manifest.template.json'), 'utf8'), image: `localhost/rwtarget@sha256:${'a'.repeat(64)}`, inventory,
        helperBytes: Buffer.from('helper'), transportVectorsBytes: Buffer.from('t'), commonVectorsBytes: Buffer.from('c'), sessionVectorsBytes, seccompBytes: Buffer.from('s')
    }).values.HELPER_CONTRACT_DIGEST;
    const current = render(fs.readFileSync(path.join(VECTORS, 'session-fixture-v1.json')));
    assert.notEqual(current, render(Buffer.from('another handshake')), 'a handshake change changes the contract digest');
    assert.throws(() => render(undefined), /session vectors/);
});

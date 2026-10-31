import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { SCHEMA_VERSION } from '../server/stateDatabase.mjs';
import { ADMISSION_KINDS, STORED_ADMISSION_KINDS, STORED_LOGICAL_KINDS } from '../server/stateProtocol.mjs';
import {
    LIMITS, WORKSPACE, admitRequest, count, expectCode, makeTempDir, newId, newOriginId, openStore, rawDb, readyRobot, storeFile, syntheticContext
} from './helpers/synthetic.mjs';

// Schema 9: the ONE bump shared by T1 (robot terminals: the stored kind `terminal`, B-1 and delta notes 1-3) and T2 (approvals). Only the
// state contract is exercised here; the terminal path itself (admitTerminal, the PTY) is T1's work, so terminal rows are written raw.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 4096, admissions: 2, receipts: 256, bindings: 8, controls: 16, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const owner = (id) => syntheticContext({
    originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: `owner:user:${id}`, ownerId: `user:${id}`, scope: `scope-co-${id}`, robotOwnerId: ROBOTS
});
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function setup(t, limits = LIMITS_X) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { dir, store, robotId };
}

// A terminal admission as T1's worker path will write it: admission kind and logical kind `terminal`, a fresh logical id, and an internal
// reference row of kind `terminal` carrying execution, attempt and logical ids. `withOrigin` adds an origin row naming that reference.
function insertTerminal(dir, store, robotId, { state = 'queued', withOrigin = false, ownerId = 'user:alice', scope = 'scope-co-alice' } = {}) {
    const db = rawDb(dir);
    try {
        const ids = { executionId: newId(), attemptId: newId(), logicalId: newId(), referenceId: newId(), originId: newOriginId() };
        const now = Date.now();
        const robot = db.prepare('SELECT configuration, revision FROM robot WHERE id = ?').get(robotId);
        db.prepare(`INSERT INTO admission (execution_id, attempt_id, logical_id, logical_kind, generation_id, robot_id, config_revision, configuration, kind, specification, scope, owner_id, operation_id, state, result, created_at, updated_at)
            VALUES (?, ?, ?, 'terminal', ?, ?, ?, ?, 'terminal', '{}', ?, ?, ?, ?, NULL, ?, ?)`)
            .run(ids.executionId, ids.attemptId, ids.logicalId, store.generationId, robotId, robot.revision, robot.configuration, scope, ownerId, newId(), state, now, now);
        db.prepare(`INSERT INTO reference (id, version, provider, namespace, origin_key, origin_id, kind, logical_id, attempt_id, execution_id, obligation_id, scope, created_at)
            VALUES (?, 1, 'provider-synthetic', 'coordinator:agent:fixtures/roboteam', 'owner:user:alice', ?, 'terminal', ?, ?, ?, NULL, ?, ?)`)
            .run(ids.referenceId, ids.originId, ids.logicalId, ids.attemptId, ids.executionId, scope, now);
        if (withOrigin) {
            db.prepare('INSERT INTO origin (namespace, origin_key, origin_id, scope, digest, operation_id, reference_id, execution_id, obligation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
                .run('coordinator:agent:fixtures/roboteam', 'owner:user:alice', ids.originId, scope, 'd', newId(), ids.referenceId, ids.executionId, now);
        }
        return ids;
    } finally {
        db.close();
    }
}

test('schema 10: the version constant, the stored kinds and the coordinator request kinds', () => {
    assert.equal(SCHEMA_VERSION, 10);
    assert.deepEqual(ADMISSION_KINDS, ['task', 'continuation', 'turn']);
    assert.deepEqual(STORED_ADMISSION_KINDS, ['task', 'continuation', 'turn', 'terminal', 'utility']);
    assert.deepEqual(STORED_LOGICAL_KINDS, ['task', 'session', 'flow', 'terminal', 'utility']);
});

test('M-51 Q4: a version-8 store refuses to open with a clear reason, is never half-opened and is left byte-identical', (t) => {
    const dir = makeTempDir(t);
    openStore(dir).close();
    // A version-8 store: the schema-8 version number and no `approval` table.
    let db = rawDb(dir);
    db.exec('DROP TRIGGER approval_once');
    db.exec('DROP TRIGGER approval_no_delete');
    db.exec('DROP TABLE approval');
    db.exec("UPDATE metadata SET value = '8' WHERE key = 'schema_version'");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const file = storeFile(dir);
    const before = sha(file);
    for (const create of [false, true]) {
        assert.throws(() => openStore(dir, { create }), (error) => error.code === 'state_corrupt' && error.reason === 'schema_version_mismatch', `create: ${create}`);
    }
    assert.equal(sha(file), before, 'the main file is unchanged');
    db = rawDb(dir, { readOnly: true });
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '8');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'approval'").get().count, 0, 'never upgraded in place');
    db.close();
});

test('M-51 Q4: a version-8 store with uncheckpointed WAL frames is refused through the read-only probe, WAL and main untouched', (t) => {
    const dir = makeTempDir(t);
    openStore(dir).close();
    const file = storeFile(dir);
    const writer = rawDb(dir);
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    writer.exec("UPDATE metadata SET value = '8' WHERE key = 'schema_version'");
    // Keep the WAL: copy the files while the writer still holds them, as a killed writer would leave them.
    const copy = makeTempDir(t);
    fs.mkdirSync(`${copy}/execution-store`, { mode: 0o700 });
    for (const suffix of ['', '-wal']) fs.copyFileSync(`${file}${suffix}`, `${copy}/execution-store/worker-state.sqlite${suffix}`);
    writer.close();
    const copied = storeFile(copy);
    assert.ok(fs.statSync(`${copied}-wal`).size > 0, 'the WAL holds the version change');
    const before = [sha(copied), sha(`${copied}-wal`)];
    assert.throws(() => openStore(copy, { create: false }), (error) => error.code === 'state_corrupt' && error.reason === 'schema_version_mismatch');
    assert.deepEqual([sha(copied), sha(`${copied}-wal`)], before, 'no checkpoint: main and WAL byte-identical');
});

test('delta note 1: a coordinator admit of kind `terminal` is invalid_request and writes nothing', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = owner('alice');
    const tables = ['admission', 'reference', 'origin', 'receipt', 'reference_event', 'session'];
    const before = Object.fromEntries(tables.map((table) => [table, count(dir, table)]));
    for (const logical of [{}, { sessionKey: 'k' }]) {
        expectCode(assert, () => store.admit(alice, admitRequest(robotId, { kind: 'terminal', logical }, alice)), 'invalid_request');
    }
    assert.deepEqual(Object.fromEntries(tables.map((table) => [table, count(dir, table)])), before);
});

test('delta note 2: the reference CHECKs: kind `terminal` carries execution, attempt and logical ids; the admission kind pairs with its logical kind', (t) => {
    const { dir, store, robotId } = setup(t);
    const ids = insertTerminal(dir, store, robotId);
    const db = rawDb(dir);
    t.after(() => db.close());
    const row = db.prepare('SELECT kind, execution_id, attempt_id, logical_id FROM reference WHERE id = ?').get(ids.referenceId);
    assert.deepEqual({ ...row }, { kind: 'terminal', execution_id: ids.executionId, attempt_id: ids.attemptId, logical_id: ids.logicalId });
    const now = Date.now();
    // A terminal reference without its execution, or an observation-shaped one, is refused by the CHECKs.
    assert.throws(() => db.prepare(`INSERT INTO reference (id, version, provider, namespace, origin_key, origin_id, kind, logical_id, attempt_id, execution_id, obligation_id, scope, created_at)
        VALUES (?, 1, 'p', 'n', 'k', ?, 'terminal', NULL, NULL, NULL, NULL, 's', ?)`).run(newId(), newOriginId(), now), /CHECK/u);
    // kind terminal with another logical kind, and logical kind terminal with another kind, are refused.
    const robot = db.prepare('SELECT configuration, revision FROM robot WHERE id = ?').get(robotId);
    for (const [kind, logicalKind] of [['terminal', 'task'], ['task', 'terminal'], ['turn', 'terminal', 'utility']]) {
        assert.throws(() => db.prepare(`INSERT INTO admission (execution_id, attempt_id, logical_id, logical_kind, generation_id, robot_id, config_revision, configuration, kind, specification, scope, owner_id, operation_id, state, result, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 's', 'o', ?, 'queued', NULL, ?, ?)`).run(newId(), newId(), newId(), logicalKind, store.generationId, robotId, robot.revision, robot.configuration, kind, newId(), now, now), /CHECK/u, `${kind}/${logicalKind}`);
    }
});

test('delta note 3: a terminal reference is not_found to every coordinator read and control, and lookupOrigin does not reveal it', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = owner('alice');
    const ids = insertTerminal(dir, store, robotId, { withOrigin: true });
    expectCode(assert, () => store.observeReference(alice, { referenceId: ids.referenceId }), 'not_found');
    expectCode(assert, () => store.listReferenceEvents(alice, { referenceId: ids.referenceId, after: 0, limit: 10 }), 'not_found');
    expectCode(assert, () => store.controlReference(alice, { referenceId: ids.referenceId, operationId: newId(), op: 'stop' }), 'not_found');
    expectCode(assert, () => store.getReference(alice, { referenceId: ids.referenceId }), 'not_found');
    expectCode(assert, () => store.lookupOrigin(alice, { originRequestId: ids.originId }), 'not_found');
    const admin = syntheticContext({ originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: 'owner:user:root', ownerId: 'user:root', scope: 'scope-co-alice', robotOwnerId: ROBOTS, administrator: true });
    expectCode(assert, () => store.observeReference(admin, { referenceId: ids.referenceId }), 'not_found');
    // An ordinary task of the same owner is still visible (the exclusion is by kind only).
    const request = admitRequest(robotId, {}, alice);
    const task = store.admit(alice, request);
    assert.equal(store.observeReference(alice, { referenceId: task.reference.id }).referenceKind, 'execution');
    assert.equal(store.lookupOrigin(alice, { originRequestId: request.originRequestId }).reference.id, task.reference.id);
});

test('B-1: the dispatcher lists never include a terminal admission, queued or running', (t) => {
    const { dir, store, robotId } = setup(t, { ...LIMITS_X, admissions: 8 });
    const alice = owner('alice');
    const queuedTerminal = insertTerminal(dir, store, robotId, { state: 'queued' });
    const runningTerminal = insertTerminal(dir, store, robotId, { state: 'queued' });
    store.transitionAttempt({ executionId: runningTerminal.executionId, attemptId: runningTerminal.attemptId, expectedState: 'queued', nextState: 'running' });
    const task = store.admit(alice, admitRequest(robotId, {}, alice));
    assert.deepEqual(store.listQueuedAdmissions().map((item) => item.executionId), [task.executionId]);
    store.transitionAttempt({ executionId: task.executionId, attemptId: task.attemptId, expectedState: 'queued', nextState: 'running' });
    assert.deepEqual(store.listRunningAdmissions().map((item) => item.executionId), [task.executionId]);
    assert.ok(![queuedTerminal.executionId, runningTerminal.executionId].some((id) => store.listQueuedAdmissions().some((item) => item.executionId === id)));
});

test('B-1: terminal rows do not take an AI admission place (#checkCapacity(admission))', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = owner('alice');
    insertTerminal(dir, store, robotId);
    insertTerminal(dir, store, robotId);
    insertTerminal(dir, store, robotId);
    store.admit(alice, admitRequest(robotId, {}, alice));
    store.admit(alice, admitRequest(robotId, {}, alice));
    expectCode(assert, () => store.admit(alice, admitRequest(robotId, {}, alice)), 'capacity_exceeded');
    assert.equal(count(dir, 'admission'), 5);
});

test('B-1: a terminal attempt ends through the unchanged end path, by beginAttemptEnd and by generation recovery', (t) => {
    const { dir, store, robotId } = setup(t, { ...LIMITS_X, admissions: 8 });
    const adapterContext = syntheticContext({ scope: 'scope-adapter' });
    const ended = insertTerminal(dir, store, robotId);
    store.transitionAttempt({ executionId: ended.executionId, attemptId: ended.attemptId, expectedState: 'queued', nextState: 'running' });
    const result = store.beginAttemptEnd(adapterContext, { executionId: ended.executionId, attemptId: ended.attemptId, expectedState: 'running', outcome: { classification: 'completed' } });
    assert.equal(result.state, 'completed');
    const recovered = insertTerminal(dir, store, robotId);
    store.transitionAttempt({ executionId: recovered.executionId, attemptId: recovered.attemptId, expectedState: 'queued', nextState: 'running' });
    store.beginGenerationRecovery(store.generationId);
    const db = rawDb(dir, { readOnly: true });
    t.after(() => db.close());
    assert.equal(db.prepare('SELECT state FROM admission WHERE execution_id = ?').get(recovered.executionId).state, 'interrupted');
});

test('T5 schema10 refuses a schema9 store without migration or byte changes', (t) => {
    const dir = makeTempDir(t);
    openStore(dir).close();
    const db = rawDb(dir);
    db.exec("UPDATE metadata SET value = '9' WHERE key = 'schema_version'");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const before = sha(storeFile(dir));
    for (const create of [false, true]) assert.throws(() => openStore(dir, { create }), (error) => error.code === 'state_corrupt' && error.reason === 'schema_version_mismatch');
    assert.equal(sha(storeFile(dir)), before);
});

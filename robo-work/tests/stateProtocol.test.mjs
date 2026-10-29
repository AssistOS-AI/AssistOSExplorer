import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStorage, verifyPragmas } from '../server/stateDatabase.mjs';
import { openWorkerState } from '../server/workerState.mjs';
import {
    ERROR_CODES, WorkerStateError, canonicalJson, createVerifiedContext, digest, isOriginId,
    isPublicReferenceId, randomId, requireContext, validateConfiguration, validateLimits, validateName
} from '../server/stateProtocol.mjs';
import { runtimeUnavailable } from '../server/runtimeUnavailable.mjs';
import { runChild } from './helpers/childRunner.mjs';
import { LIMITS, PROVIDER, WORKSPACE, admitRequest, count, expectCode, readyRobot, makeTempDir, openStore, rawDb, storeFile, syntheticContext } from './helpers/synthetic.mjs';

test('node:sqlite is importable and exposes DatabaseSync', () => {
    assert.equal(typeof DatabaseSync, 'function');
    const db = new DatabaseSync(':memory:');
    assert.equal(db.prepare('SELECT 1 AS one').get().one, 1);
    db.close();
});

test('canonical JSON sorts object keys, preserves array order and is stable', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } }), '{"a":{"c":null,"d":[3,1,2]},"b":1}');
    assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
    assert.notEqual(digest({ a: [1, 2] }), digest({ a: [2, 1] }));
    assert.equal(digest({ a: 1 }).length, 64);
});

test('canonical JSON rejects non-JSON values', () => {
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const cyclic = {}; cyclic.self = cyclic;
    for (const bad of [undefined, NaN, Infinity, -0, () => 1, new Date(0), new Map(), 10n, Symbol('x'), sparse, cyclic,
        { a: undefined }, { x: new Set() }, JSON.parse('{"__proto__": 1}')]) {
        expectCode(assert, () => canonicalJson(bad), 'invalid_request');
    }
    let deep = {};
    for (let i = 0; i < 40; i += 1) deep = { n: deep };
    expectCode(assert, () => canonicalJson(deep), 'invalid_request');
});

test('origin IDs are canonical 128-bit base64url values of exactly 22 characters', () => {
    const good = crypto.randomBytes(16).toString('base64url');
    assert.equal(isOriginId(good), true);
    assert.equal(isOriginId('AAAAAAAAAAAAAAAAAAAAAA'), true);
    assert.equal(isOriginId('AAAAAAAAAAAAAAAAAAAAAB'), false, 'non-canonical trailing bits');
    assert.equal(isOriginId(good.slice(1)), false);
    assert.equal(isOriginId(`${good}A`), false);
    assert.equal(isOriginId('AAAAAAAAAAAAAAAAAAAA+A'), false);
    assert.equal(isOriginId(7), false);
});

test('public reference IDs are 22 to 64 base64url characters', () => {
    assert.equal(isPublicReferenceId('a'.repeat(22)), true);
    assert.equal(isPublicReferenceId('a'.repeat(64)), true);
    assert.equal(isPublicReferenceId('a'.repeat(21)), false);
    assert.equal(isPublicReferenceId('a'.repeat(65)), false);
    assert.equal(isPublicReferenceId(`${'a'.repeat(21)}=`), false);
    assert.notEqual(randomId(), randomId());
    assert.equal(isOriginId(randomId()), true);
});

test('names are trimmed, nonempty and at most 80 characters', () => {
    assert.equal(validateName('  robot  '), 'robot');
    assert.equal(validateName('x'.repeat(80)).length, 80);
    for (const bad of ['', '   ', 'x'.repeat(81), 5, null, undefined]) expectCode(assert, () => validateName(bad), 'invalid_request');
});

test('limits are explicit positive safe integers with no unknown keys', () => {
    assert.deepEqual({ ...validateLimits(LIMITS) }, { ...LIMITS });
    const broken = [{}, { ...LIMITS, robots: 0 }, { ...LIMITS, robots: -1 }, { ...LIMITS, robots: 1.5 },
        { ...LIMITS, robots: Number.MAX_SAFE_INTEGER + 2 }, { ...LIMITS, extra: 1 }, { ...LIMITS, robots: '8' }, null, []];
    for (const limits of broken) expectCode(assert, () => validateLimits(limits), 'invalid_request');
    const { resultBytes, ...missing } = LIMITS;
    void resultBytes;
    expectCode(assert, () => validateLimits(missing), 'invalid_request');
});

test('request size boundary: exactly the limit is accepted and one byte more is refused before persistence', () => {
    const limits = { ...LIMITS, requestBytes: 128 };
    const overhead = Buffer.byteLength(canonicalJson({ backend: 'b', settings: { k: '' } }));
    const exact = validateConfiguration({ backend: 'b', settings: { k: 'x'.repeat(128 - overhead) } }, limits);
    assert.equal(Buffer.byteLength(canonicalJson(exact)), 128);
    expectCode(assert, () => validateConfiguration({ backend: 'b', settings: { k: 'x'.repeat(128 - overhead + 1) } }, limits), 'invalid_request');
});

test('configuration validation is exact and rejects authority fields at any depth', () => {
    for (const bad of [{}, { backend: 'Bad Name' }, { backend: 'b', extra: 1 }, { backend: 'b', settings: [] },
        { backend: 'b', settings: { principal: 'x' } }, { backend: 'b', settings: { nested: { Token: 'x' } } },
        { backend: 'b', settings: { list: [{ role: 'admin' }] } }, { backend: 'b', settings: { path: '/etc' } }, 'str', null]) {
        expectCode(assert, () => validateConfiguration(bad, LIMITS), 'invalid_request');
    }
    assert.deepEqual(validateConfiguration({ backend: 'b' }, LIMITS), { backend: 'b', settings: {} });
});

test('verified contexts are an internal brand: forged, serialized, foreign and unauthorized contexts are refused', () => {
    const context = syntheticContext();
    assert.equal(requireContext(context, WORKSPACE, 'admit'), context);
    const serialized = JSON.parse(JSON.stringify(context));
    expectCode(assert, () => requireContext(serialized, WORKSPACE, 'admit'), 'forbidden');
    expectCode(assert, () => requireContext({ ...context }, WORKSPACE, 'admit'), 'forbidden');
    expectCode(assert, () => requireContext(context, 'other-workspace', 'admit'), 'forbidden');
    expectCode(assert, () => requireContext(syntheticContext({ operations: ['read'] }), WORKSPACE, 'admit'), 'forbidden');
    expectCode(assert, () => requireContext(null, WORKSPACE, 'admit'), 'forbidden');
    assert.throws(() => { context.scope = 'other'; }, TypeError);
    for (const bad of [{ originNamespace: 'unknown' }, { scope: '' }, { operations: ['root'] }, { administrator: 'yes' }]) {
        expectCode(assert, () => syntheticContext(bad), 'invalid_request');
    }
    expectCode(assert, () => createVerifiedContext({ workspaceId: 'w', scope: 's', ownerId: 'o', operations: [], originNamespace: 'mcp', originKey: 'user:u', role: 'admin' }), 'invalid_request');
    // the origin key is part of the verified context and is required
    expectCode(assert, () => createVerifiedContext({ workspaceId: 'w', scope: 's', ownerId: 'o', operations: [], originNamespace: 'mcp' }), 'invalid_request');
    assert.equal(createVerifiedContext({ workspaceId: 'w', scope: 's', ownerId: 'o', operations: [], originNamespace: 'coordinator:svc', originKey: 'binding:b1' }).originKey, 'binding:b1');
});

test('public errors use stable bounded codes and expose no paths or SQLite detail', (t) => {
    assert.equal(new Set(ERROR_CODES).size, 13);
    for (const code of ERROR_CODES) {
        const error = new WorkerStateError(code);
        assert.equal(error.code, code);
        assert.ok(error.message.length < 80);
    }
    assert.throws(() => new WorkerStateError('made_up'), TypeError);
    const dir = makeTempDir(t);
    fs.mkdirSync(path.join(dir, 'execution-store'));
    fs.writeFileSync(storeFile(dir), 'not a database '.repeat(100));
    try {
        openStore(dir);
        assert.fail('expected refusal');
    } catch (error) {
        assert.equal(error.code, 'state_corrupt');
        assert.equal(error.message.includes(dir), false);
        assert.equal(/sqlite|database|file/i.test(error.message), false);
    }
});

test('openWorkerState validates its options strictly', (t) => {
    const dir = makeTempDir(t);
    const base = { dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS };
    expectCode(assert, () => openWorkerState({ ...base, dataDir: 'relative/path', create: true }), 'invalid_request');
    expectCode(assert, () => openWorkerState({ ...base, create: 'yes' }), 'invalid_request');
    expectCode(assert, () => openWorkerState({ ...base, unknown: 1 }), 'invalid_request');
    expectCode(assert, () => openWorkerState({ ...base, runtime: {} }), 'invalid_request');
    expectCode(assert, () => openWorkerState({ ...base, limits: { ...LIMITS, robots: 0 } }), 'invalid_request');
    expectCode(assert, () => openWorkerState({ ...base, faults: { beforeCommit: 1 } }), 'invalid_request');
    expectCode(assert, () => openWorkerState({ ...base, workspaceId: '' }), 'invalid_request');
});

test('a missing store is not created without create: true', (t) => {
    const dir = makeTempDir(t);
    expectCode(assert, () => openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS }), 'not_found');
    assert.equal(fs.existsSync(path.join(dir, 'execution-store')), false);
    fs.mkdirSync(path.join(dir, 'execution-store'));
    expectCode(assert, () => openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS }), 'not_found');
    assert.equal(fs.existsSync(storeFile(dir)), false);
    expectCode(assert, () => openWorkerState({ dataDir: path.join(dir, 'missing'), workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, create: true }), 'not_found');
});

test('create: true builds a private store in WAL mode and reopen works without create', (t) => {
    const dir = makeTempDir(t);
    const first = openStore(dir);
    const generation = first.generationId;
    first.close();
    assert.equal(fs.statSync(path.join(dir, 'execution-store')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(storeFile(dir)).mode & 0o777, 0o600);
    const reopened = openStore(dir, { create: false });
    assert.equal(reopened.generationId, generation);
    const probe = rawDb(dir, { readOnly: true });
    assert.equal(probe.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    probe.close();
    reopened.close();
});

test('symbolic links and non-regular state components are refused', (t) => {
    const dir = makeTempDir(t);
    const outside = makeTempDir(t);
    // symlinked execution-store directory
    fs.symlinkSync(outside, path.join(dir, 'execution-store'));
    expectCode(assert, () => openStore(dir), 'state_corrupt');
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(dir, 'execution-store'));
    // execution-store is a regular file
    fs.writeFileSync(path.join(dir, 'execution-store'), 'x');
    expectCode(assert, () => openStore(dir), 'state_corrupt');
    fs.unlinkSync(path.join(dir, 'execution-store'));
    // symlinked database file
    fs.mkdirSync(path.join(dir, 'execution-store'));
    const target = path.join(outside, 'real.sqlite');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, storeFile(dir));
    expectCode(assert, () => openStore(dir), 'state_corrupt');
    assert.equal(fs.statSync(target).size, 0);
    fs.unlinkSync(storeFile(dir));
    // database path is a directory
    fs.mkdirSync(storeFile(dir));
    expectCode(assert, () => openStore(dir), 'state_corrupt');
    fs.rmdirSync(storeFile(dir));
    // symlinked sidecar
    fs.symlinkSync(target, `${storeFile(dir)}-wal`);
    expectCode(assert, () => openStore(dir), 'state_corrupt');
    // symlinked data directory itself
    const link = path.join(outside, 'link');
    fs.symlinkSync(dir, link);
    expectCode(assert, () => openStore(link), 'state_corrupt');
});

test('a corrupted database is refused and never replaced', (t) => {
    const dir = makeTempDir(t);
    fs.mkdirSync(path.join(dir, 'execution-store'));
    const garbage = Buffer.from('this is definitely not a sqlite database file '.repeat(50));
    fs.writeFileSync(storeFile(dir), garbage);
    for (const create of [true, false]) expectCode(assert, () => openStore(dir, { create }), 'state_corrupt');
    assert.deepEqual(fs.readFileSync(storeFile(dir)), garbage);
    // an empty file is not initialized without create
    fs.writeFileSync(storeFile(dir), '');
    expectCode(assert, () => openStore(dir, { create: false }), 'state_corrupt');
    assert.equal(fs.statSync(storeFile(dir)).size, 0);
});

test('metadata, schema version and structure mismatches refuse to open', (t) => {
    const dir = makeTempDir(t);
    openStore(dir).close();
    expectCode(assert, () => openStore(dir, { create: false, workspaceId: 'other-workspace' }), 'state_corrupt');
    expectCode(assert, () => openStore(dir, { create: false, provider: 'other-provider' }), 'state_corrupt');
    const db = rawDb(dir);
    db.exec("UPDATE metadata SET value = '999' WHERE key = 'schema_version'");
    db.close();
    expectCode(assert, () => openStore(dir, { create: false }), 'state_corrupt');
    const fixed = rawDb(dir);
    fixed.exec("UPDATE metadata SET value = '1' WHERE key = 'schema_version'");
    fixed.exec('DROP TABLE resource_blocker');
    fixed.close();
    expectCode(assert, () => openStore(dir, { create: false }), 'state_corrupt');
});

test('the default runtime adapter refuses every capability', () => {
    assert.equal(runtimeUnavailable.canPrepare(), false);
    assert.equal(runtimeUnavailable.attestRobot({}), false);
    assert.equal(runtimeUnavailable.admissionReady({}), false);
});

test('transactions take the write lock at BEGIN: a second writer is refused while only a read has run', (t) => {
    const dir = makeTempDir(t);
    const { state } = openStorage({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, create: true, now: () => 1, faults: {} });
    const other = rawDb(dir, { timeout: 0 });
    let refusal = null;
    try {
        state.transaction('probe', (db) => {
            db.prepare('SELECT 1 AS one').get();
            try {
                other.exec('BEGIN IMMEDIATE');
                other.exec('ROLLBACK');
            } catch (error) {
                refusal = error;
            }
        });
    } finally {
        other.close();
        state.close();
    }
    assert.ok(refusal, 'second BEGIN IMMEDIATE must be refused');
    assert.equal(refusal.errcode, 5);
});

test('pragma read-back runs per connection and refuses to open with state_corrupt and a bounded reason', (t) => {
    const cases = [
        ['pragma_synchronous', (db) => db.exec('PRAGMA synchronous = OFF')],
        ['pragma_foreign_keys', (db) => db.exec('PRAGMA foreign_keys = OFF')],
        ['pragma_journal_mode', (db) => db.exec('PRAGMA journal_mode = DELETE')]
    ];
    for (const [reason, tamper] of cases) {
        const dir = makeTempDir(t);
        try {
            openStore(dir, { faults: { afterPragmas: tamper } });
            assert.fail('expected refusal');
        } catch (error) {
            assert.equal(error.name, 'WorkerStateError');
            assert.equal(error.code, 'state_corrupt');
            assert.equal(error.reason, reason);
            assert.equal(error.message.includes(dir), false);
        }
        // nothing was initialized by the refused open
        const probe = rawDb(dir, { readOnly: true });
        assert.equal(probe.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get().c, 0, reason);
        probe.close();
        // an untampered open of the same directory still works
        openStore(dir).close();
    }
    // BigInt results are normalized before comparison
    const fake = (values) => ({ prepare: (sql) => ({ get: () => ({ value: values[sql.split(' ')[1]] }) }) });
    verifyPragmas(fake({ journal_mode: 'wal', synchronous: 2n, foreign_keys: 1n }));
    assert.throws(() => verifyPragmas(fake({ journal_mode: 'wal', synchronous: 1n, foreign_keys: 1n })), (error) => error.reason === 'pragma_synchronous');
    assert.throws(() => verifyPragmas(fake({ journal_mode: 'delete', synchronous: 2n, foreign_keys: 1n })), (error) => error.reason === 'pragma_journal_mode');
    assert.throws(() => new WorkerStateError('state_corrupt', '/etc/passwd'), TypeError);
    assert.throws(() => new WorkerStateError('state_corrupt', 5), TypeError);
});

// ---- D3: refused opens do not modify the store ---------------------------------------

const CHILD_CONTEXT = {
    workspaceId: WORKSPACE, scope: 'scope-synthetic-a', ownerId: 'owner-synthetic-a',
    operations: ['admit'], originNamespace: 'mcp', originKey: 'user:synthetic-a'
};

function hashOf(file) {
    return fs.existsSync(file) ? `${fs.statSync(file).size}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` : 'absent';
}

// A store whose writer was SIGKILLed right after a commit, so uncheckpointed WAL frames remain.
async function storeWithPendingWal(t) {
    const dir = makeTempDir(t);
    const seeded = openStore(dir);
    const robotId = readyRobot(seeded, syntheticContext());
    for (let i = 0; i < 3; i += 1) seeded.admit(syntheticContext(), admitRequest(robotId));
    seeded.close();
    const killed = await runChild({ dir, method: 'admit', context: CHILD_CONTEXT, request: admitRequest(robotId), fault: { when: 'afterCommit', label: 'admit' } });
    assert.equal(killed.signal, 'SIGKILL');
    const wal = `${storeFile(dir)}-wal`;
    assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'uncheckpointed WAL frames remain');
    return { dir, robotId, wal };
}

test('D3: a refused open of a store with pending WAL frames leaves the main file and the WAL byte-identical', async (t) => {
    const { dir, wal } = await storeWithPendingWal(t);
    const before = { main: hashOf(storeFile(dir)), wal: hashOf(wal) };
    const shmBefore = fs.existsSync(`${storeFile(dir)}-shm`);
    expectCode(assert, () => openStore(dir, { create: false, workspaceId: 'some-other-workspace' }), 'state_corrupt');
    expectCode(assert, () => openStore(dir, { create: false, provider: 'some-other-provider' }), 'state_corrupt');
    expectCode(assert, () => openStore(dir, { create: true, workspaceId: 'some-other-workspace' }), 'state_corrupt');
    // a late refusal (pragma read-back) after the read-write connection is open
    for (const tamper of ['PRAGMA synchronous = OFF', 'PRAGMA foreign_keys = OFF']) {
        expectCode(assert, () => openStore(dir, { create: false, faults: { afterPragmas: (db) => db.exec(tamper) } }), 'state_corrupt');
    }
    // SQLite may rewrite the -shm recovery index on any open; it must not be deleted
    assert.deepEqual({ main: hashOf(storeFile(dir)), wal: hashOf(wal) }, before);
    assert.equal(fs.existsSync(`${storeFile(dir)}-shm`), shmBefore);
    // the pending frames are intact and a normal open still sees every committed admission
    const store = openStore(dir, { create: false });
    assert.equal(count(dir, 'admission'), 4);
    store.close();
});

test('D3: a store with pending WAL frames and a truncated main file is refused and left untouched', async (t) => {
    const { dir, wal } = await storeWithPendingWal(t);
    const size = fs.statSync(storeFile(dir)).size;
    assert.ok(size > 4096 * 8);
    let refused = 0;
    for (let offset = 4096 * Math.floor(size / 4096) - 4096 * 6; offset < size; offset += 4096) {
        const copy = makeTempDir(t);
        fs.mkdirSync(path.join(copy, 'execution-store'));
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(`${storeFile(dir)}${suffix}`)) fs.copyFileSync(`${storeFile(dir)}${suffix}`, `${storeFile(copy)}${suffix}`);
        }
        fs.truncateSync(storeFile(copy), offset);
        const before = { main: hashOf(storeFile(copy)), wal: hashOf(`${storeFile(copy)}-wal`) };
        // is the pair malformed? (measured on a second copy so this probe cannot disturb the first)
        const probe = makeTempDir(t);
        fs.mkdirSync(path.join(probe, 'execution-store'));
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(`${storeFile(copy)}${suffix}`)) fs.copyFileSync(`${storeFile(copy)}${suffix}`, `${storeFile(probe)}${suffix}`);
        }
        let malformed;
        try {
            const raw = rawDb(probe, { readOnly: true });
            malformed = raw.prepare('PRAGMA quick_check').get().quick_check !== 'ok';
            raw.close();
        } catch { malformed = true; }
        try {
            openStore(copy, { create: false }).close();
            assert.equal(malformed, false, `offset ${offset} opened although the pair is malformed`);
        } catch (error) {
            assert.equal(error.code, 'state_corrupt', `offset ${offset}`);
            refused += 1;
            assert.deepEqual({ main: hashOf(storeFile(copy)), wal: hashOf(`${storeFile(copy)}-wal`) }, before, `offset ${offset} modified files`);
        }
    }
    assert.ok(refused >= 1, 'at least one truncation is refused');
    assert.ok(fs.existsSync(wal));
});

test('D3: quick_check at open refuses a malformed checkpointed store without modifying it', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    for (let i = 0; i < 25; i += 1) store.admit(context, admitRequest(robotId, { specification: { prompt: 'p'.repeat(200) + i } }));
    store.close();
    assert.equal(fs.existsSync(`${storeFile(dir)}-wal`), false);
    const file = storeFile(dir);
    const bytes = fs.readFileSync(file);
    // corrupt an interior page of the (valid-header) main file
    const damaged = Buffer.from(bytes);
    for (let i = 4096 * 2; i < 4096 * 2 + 4096; i += 1) damaged[i] = 0xff;
    fs.writeFileSync(file, damaged);
    const before = hashOf(file);
    expectCode(assert, () => openStore(dir, { create: false }), 'state_corrupt');
    assert.equal(hashOf(file), before);
    assert.equal(fs.existsSync(`${file}-wal`), false);
});

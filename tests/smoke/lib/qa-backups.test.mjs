import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { QA_SCOPE } from '../../../.github/scripts/rollback-explorer-qa.mjs';
import * as update from '../../../.github/scripts/update-explorer-qa.mjs';
import {
    BACKUP_INNER_ENTRIES, BACKUP_SIBLING_SUFFIXES, PRIVILEGED_TIMEOUT_MS, createRetentionService, parsePrivilegedOutput,
    retentionProductionAdapters, run, selectRollbackTarget,
} from '../../../.github/scripts/qa-backups.mjs';
import * as privilegedModule from '../../../.github/scripts/qa-backups-privileged.mjs';

const { prunePrivileged } = privilegedModule;
const PRIVILEGED_FILE = new URL('../../../.github/scripts/qa-backups-privileged.mjs', import.meta.url);
const BOX = QA_SCOPE.box;
const CUR = 'c'.repeat(64), OLD = '1'.repeat(64), OLD2 = '2'.repeat(64), OTHER = '3'.repeat(64), FRESH = 'f'.repeat(64);
const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
const asRoot = uid === 0;
const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};
const exists = file => { try { fs.lstatSync(file); return true; } catch { return false; } };
const notReady = () => Object.assign(new Error('QA_UPDATE_RUNTIME_NOT_READY'), { code: 'QA_UPDATE_RUNTIME_NOT_READY' });
// Mirrors the update helper's readiness proof so most tests do not depend on a concurrently edited module.
const fixtureReady = value => { if (value.runtime.active !== true || !value.runtime.agents.every(agent => agent.ready === true)) throw notReady(); };

function fixture(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-backups-')));
    t.after(() => {
        for (const file of walkFiles(base)) { try { fs.chmodSync(file, 0o600); } catch {} }
        fs.rmSync(base, { recursive: true, force: true });
    });
    const scope = { workspace: path.join(base, 'workspace'), backups: path.join(base, 'backups'),
        lock: path.join(base, 'lock'), box: BOX, hash: QA_SCOPE.hash };
    fs.mkdirSync(scope.backups, { mode: 0o700 });
    write(path.join(scope.workspace, '.data/explorer/accounts'), 'live durable data');
    write(path.join(scope.workspace, '.ploinky/.secrets'), 'live encrypted secrets');
    return { base, scope };
}

function walkFiles(top) {
    const files = [];
    const stack = [top];
    while (stack.length) {
        const directory = stack.pop();
        let names = [];
        try { names = fs.readdirSync(directory); } catch { continue; }
        for (const name of names) {
            const file = path.join(directory, name), stat = fs.lstatSync(file);
            if (stat.isDirectory()) stack.push(file); else if (stat.isFile()) files.push(file);
        }
    }
    return files;
}

function snapshotWorkspace(scope) {
    const stat = fs.lstatSync(scope.workspace);
    return { ino: stat.ino, dev: stat.dev, files: walkFiles(scope.workspace).sort()
        .map(file => [path.relative(scope.workspace, file), fs.readFileSync(file, 'utf8')]) };
}

let clock = Date.parse('2026-10-01T00:00:00.000Z');
const nextCreatedAt = () => new Date(clock += 60_000).toISOString();

/** A backup as the workflow leaves it after a complete preserving redeploy. */
function completeBackup(scope, name, { prior = OLD, createdAt = nextCreatedAt() } = {}) {
    const dir = path.join(scope.backups, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    write(path.join(dir, 'helpers/node-runtime-path'), '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64\n');
    write(path.join(dir, 'helpers/rollback-explorer-qa.mjs'), '// frozen helper\n');
    write(path.join(dir, 'prior-containers.txt'), prior ? `podman|${prior}|${BOX}\n` : '');
    write(path.join(dir, 'rollback-authority.json'), { version: 1, createdAt, backup: dir });
    write(path.join(dir, 'workspace/.data/explorer/accounts'), `previous durable data of ${name}`);
    write(path.join(dir, 'preservation.json'), { version: 1, target: scope.workspace, source: path.join(dir, 'workspace'),
        copied: ['.data'], exactCopiesVerified: true, runtimeStateRestored: false });
    write(path.join(dir, 'quiesce.log'), '{"result":"passed"}\n');
    write(path.join(dir, 'quiesce-source.mjs'), '// quiesce\n');
    for (const file of ['lock-ready.json', 'lock-released.json', 'lock-release', 'lock.log']) write(path.join(dir, file), 'lock\n');
    write(path.join(dir, 'policy-restoration.json'), { copied: [], exactCopiesVerified: true, compiledGenerationsRestored: false });
    write(path.join(dir, 'restored-selections.json'), { counts: {}, boxId: FRESH });
    return dir;
}

/** Captured, then aborted before any service stopped. */
function abortedBackup(scope, name, { prior = OLD, createdAt = nextCreatedAt() } = {}) {
    const dir = path.join(scope.backups, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    write(path.join(dir, 'helpers/node-runtime-path'), '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64\n');
    write(path.join(dir, 'helpers/rollback-explorer-qa.mjs'), '// frozen helper\n');
    write(path.join(dir, 'prior-containers.txt'), prior ? `podman|${prior}|${BOX}\n` : '');
    write(path.join(dir, 'rollback-authority.json'), { version: 1, createdAt, backup: dir });
    return dir;
}

/** A fresh install: no predecessor and no prior workspace. */
function freshInstallBackup(scope, name) {
    const dir = abortedBackup(scope, name, { prior: null });
    write(path.join(dir, 'preservation.json'), { version: 1, target: scope.workspace, source: null, copied: [], exactCopiesVerified: true });
    write(path.join(dir, 'quiesce-source.mjs'), '// quiesce\n');
    write(path.join(dir, 'policy-restoration.json'), { copied: [], exactCopiesVerified: true });
    write(path.join(dir, 'restored-selections.json'), { boxId: FRESH });
    return dir;
}

const box = (id, name, running = false, extra = {}) => ({ engine: 'podman', box: { id, name, running,
    contract: `contract-${id.slice(0, 6)}-${name.length}`, mounts: [], ...extra } });

/** Admin adapters; by default the privileged module runs in-process against the real temporary tree. */
function admin(scope, { boxes = [box(CUR, BOX, true)], ready = true, healthError = null, lock = true,
    privileged = null, removeError = null, assertRuntimeReady = fixtureReady, runtimeError = null } = {}) {
    const state = { boxes: structuredClone(boxes), spawns: [], removals: [], inspections: 0, events: [] };
    const adapters = {
        assertHost() { state.events.push('host'); },
        lockHeld() { state.events.push('lock'); return lock; },
        getuid: () => uid,
        boxes() { state.inspections += 1; return structuredClone(state.boxes); },
        async runtime() {
            state.events.push('runtime');
            if (runtimeError) throw runtimeError;
            return { active: ready, generation: 'g', activationId: 'a',
                agents: [{ name: 'explorer', ready: true, id: 'a'.repeat(64), image: `sha256:${'b'.repeat(64)}` }] };
        },
        async health() { state.events.push('health'); if (healthError) throw healthError; },
        assertRuntimeReady,
        privilegedSource: () => 'privileged source text',
        runPrivileged(source, args) {
            state.spawns.push({ source, args });
            if (privileged) return privileged(source, args);
            return inProcess(args);
        },
        removeContainer(engine, id) {
            state.removals.push([engine, 'container', 'rm', id]);
            if (removeError) throw removeError;
            state.boxes = state.boxes.filter(item => !(item.engine === engine && item.box.id === id));
        },
    };
    return { adapters, state };
}

function inProcess(args, hooks = {}) {
    assert.equal(args.length, 7);
    assert.deepEqual([args[0], args[1], args[3], args[5]], ['prune', '--root', '--workspace', '--owner']);
    try {
        const result = prunePrivileged({ root: args[2], workspace: args[4], owner: Number(args[6]), hooks });
        return { status: 0, stdout: JSON.stringify(result) + '\n' };
    } catch (error) {
        return { status: 1, stdout: JSON.stringify({ result: 'failed', code: error.code, removedBeforeFailure: error.removedBeforeFailure || [] }) + '\n' };
    }
}

const prune = (scope, adapters, currentId = CUR) => run(['prune', '--current-id', currentId, '--lock-held'], adapters, scope);
const rollbackTarget = (scope, adapters) => run(['rollback-target', '--lock-held'], adapters, scope);

test('the admin and privileged whitelists are equal and literal in both modules', () => {
    const normalize = lists => JSON.stringify({ completion: lists.completion,
        rollbackMarkers: lists.rollbackMarkers.map(item => item instanceof RegExp ? `regexp:${item}` : item) });
    assert.equal(normalize(BACKUP_INNER_ENTRIES), normalize(privilegedModule.BACKUP_INNER_ENTRIES));
    assert.deepEqual([...BACKUP_SIBLING_SUFFIXES], [...privilegedModule.BACKUP_SIBLING_SUFFIXES]);
    const admin = fs.readFileSync(new URL('../../../.github/scripts/qa-backups.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(admin, /from '\.\/qa-backups-privileged\.mjs'/, 'the admin copy must not be imported from the privileged module');
    assert.equal(BACKUP_INNER_ENTRIES.completion.length, 14);
    assert.equal(BACKUP_INNER_ENTRIES.rollbackMarkers.length, 3);
});

test('the privileged module imports only node: built-ins and no Node 22+ API (Node 20 on QA)', () => {
    const source = fs.readFileSync(PRIVILEGED_FILE, 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]);
    assert(imports.length > 0);
    assert(imports.every(specifier => specifier.startsWith('node:')), imports.join(','));
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/);
    for (const api of [/globSync/, /Object\.groupBy/, /Promise\.withResolvers/, /\.union\(/, /\.isSubsetOf\(/,
        /import\.meta\.dirname/, /import\.meta\.filename/, /getBuiltinModule/, /process\.loadEnvFile/, /\brm\s+-[rf]/, /child_process|execFile|spawnSync/]) {
        assert.doesNotMatch(source, api);
    }
});

test('the privileged module loads from stdin as the sudo rule runs it, and refuses unpinned paths or a non-root user', t => {
    const { scope } = fixture(t);
    const backup = completeBackup(scope, 'redeploy-StdinCh1');
    const source = fs.readFileSync(PRIVILEGED_FILE, 'utf8');
    const unpinned = spawnSync(process.execPath, ['--input-type=module', '-', 'prune', '--root', scope.backups,
        '--workspace', scope.workspace, '--owner', String(uid)], { input: source, encoding: 'utf8', cwd: os.tmpdir() });
    assert.equal(unpinned.status, 1);
    assert.deepEqual(JSON.parse(unpinned.stdout), { result: 'failed', code: 'QA_PRIVILEGED_USAGE_INVALID', removedBeforeFailure: [] });
    assert(exists(backup));
    if (!asRoot) {
        const pinned = spawnSync(process.execPath, ['--input-type=module', '-', 'prune', '--root', '/home/admin/.qa-deployment-backups',
            '--workspace', '/home/admin/explorerQaWorkspace', '--owner', String(uid)], { input: source, encoding: 'utf8', cwd: os.tmpdir() });
        assert.equal(pinned.status, 1);
        assert.equal(JSON.parse(pinned.stdout).code, 'QA_PRIVILEGED_ROOT_REQUIRED');
    }
    for (const argv of [['prune'], ['prune', '--root', '/home/admin/.qa-deployment-backups', '--workspace',
        '/home/admin/explorerQaWorkspace', '--owner', '0'], ['delete', '--root', 'a', '--workspace', 'b', '--owner', '1']]) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-', ...argv], { input: source, encoding: 'utf8', cwd: os.tmpdir() });
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(result.stdout).code, 'QA_PRIVILEGED_USAGE_INVALID');
    }
    // Importing the module (as tests and tools do) never runs the CLI.
    assert.equal(typeof prunePrivileged, 'function');
});

test('AC11: retention deletes only prunable classes and their bound Boxes, and keeps every other class', async t => {
    const { scope } = fixture(t);
    const before = snapshotWorkspace(scope);
    const complete = completeBackup(scope, 'redeploy-Complet1', { prior: OLD });
    for (const suffix of BACKUP_SIBLING_SUFFIXES) {
        if (suffix === 'helpers') fs.mkdirSync(`${complete}-helpers`, { mode: 0o700 });
        else if (suffix !== 'quiesce.log') write(`${complete}-${suffix}`, 'sibling');
    }
    const aborted = abortedBackup(scope, 'redeploy-Aborted1', { prior: OLD2 });
    fs.mkdirSync(`${aborted}-helpers`, { mode: 0o700 });
    write(`${aborted}-helpers/rollback-explorer-qa.mjs`, 'helper');
    write(`${aborted}-lock.log`, 'lock log');
    const fresh = freshInstallBackup(scope, 'redeploy-FreshIn1');
    const empty = path.join(scope.backups, 'redeploy-EmptyMk1');
    fs.mkdirSync(empty, { mode: 0o700 });
    const mismatch = completeBackup(scope, 'redeploy-Mismatc1', { prior: OLD2 });
    const noPolicy = completeBackup(scope, 'redeploy-NoPolic1');
    fs.rmSync(path.join(noPolicy, 'policy-restoration.json'));
    const noSelections = completeBackup(scope, 'redeploy-NoSelec1');
    fs.rmSync(path.join(noSelections, 'restored-selections.json'));
    const unverified = completeBackup(scope, 'redeploy-Unverif1');
    write(path.join(unverified, 'preservation.json'), { version: 1, target: scope.workspace, source: path.join(unverified, 'workspace'), exactCopiesVerified: false });
    const crashed = completeBackup(scope, 'redeploy-Crashed1');
    fs.rmSync(path.join(crashed, 'preservation.json'));
    const stopped = abortedBackup(scope, 'redeploy-Quiesce1');
    write(`${stopped}-quiesce.log`, 'partial quiesce');
    const notes = completeBackup(scope, 'redeploy-NotesTx1');
    write(path.join(notes, 'notes.txt'), 'operator notes');
    write(path.join(scope.backups, 'README.txt'), 'operator file');
    write(path.join(scope.backups, 'redeploy-Orphan01-lock.log'), 'orphan sibling');
    const { adapters, state } = admin(scope, { boxes: [box(CUR, BOX, true),
        box(OLD, `${BOX}-rollback-redeploy-Complet1`, false, { mounts: [{ Type: 'volume', Source: '/var/lib/volumes/anon/_data', Destination: '/anon' }] }),
        box(OTHER, `${BOX}-rollback-redeploy-Mismatc1`)] });
    const result = await prune(scope, adapters);
    assert.equal(result.status, 0, JSON.stringify(result.output));
    const output = result.output;
    assert.equal(output.result, 'pruned');
    assert.deepEqual(output.removedBackups.sort(), ['redeploy-Aborted1', 'redeploy-Complet1', 'redeploy-EmptyMk1', 'redeploy-FreshIn1', 'redeploy-Mismatc1']);
    for (const dir of [complete, aborted, fresh, empty, mismatch]) assert(!exists(dir), dir);
    for (const suffix of BACKUP_SIBLING_SUFFIXES) assert(!exists(`${complete}-${suffix}`), suffix);
    assert(!exists(`${aborted}-helpers`) && !exists(`${aborted}-lock.log`));
    assert.deepEqual(state.removals, [['podman', 'container', 'rm', OLD]], 'exactly one bound Box, no -f and no -v');
    assert.deepEqual(output.removedBoxes, [{ engine: 'podman', id: OLD, name: `${BOX}-rollback-redeploy-Complet1` }]);
    assert.deepEqual(output.orphanedAnonymousVolumes, [{ engine: 'podman', boxId: OLD, source: '/var/lib/volumes/anon/_data', destination: '/anon' }]);
    assert.deepEqual(output.retainedUnproven, [{ engine: 'podman', id: OTHER, name: `${BOX}-rollback-redeploy-Mismatc1` }]);
    assert.deepEqual(output.retained.sort((a, b) => a.name.localeCompare(b.name)), [
        { name: 'redeploy-Crashed1', class: 'incomplete-redeploy' },
        { name: 'redeploy-NoPolic1', class: 'incomplete-redeploy' },
        { name: 'redeploy-NoSelec1', class: 'incomplete-redeploy' },
        { name: 'redeploy-NotesTx1', class: 'unrecognized-entry' },
        { name: 'redeploy-Quiesce1', class: 'stop-attempted-unpreserved' },
        { name: 'redeploy-Unverif1', class: 'incomplete-redeploy' },
    ]);
    for (const dir of [noPolicy, noSelections, unverified, crashed, stopped, notes]) {
        assert(exists(dir), dir);
        if (dir !== stopped) assert.equal(fs.readFileSync(path.join(dir, 'workspace/.data/explorer/accounts'), 'utf8'), `previous durable data of ${path.basename(dir)}`);
    }
    assert(exists(`${stopped}-quiesce.log`), 'a retained backup keeps its siblings');
    assert.deepEqual(output.unrecognized, ['README.txt', 'redeploy-Orphan01-lock.log']);
    assert(exists(path.join(scope.backups, 'README.txt')) && exists(path.join(scope.backups, 'redeploy-Orphan01-lock.log')));
    assert.deepEqual(snapshotWorkspace(scope), before, 'the live workspace inode and contents are unchanged');
    assert.deepEqual(fs.readdirSync(scope.backups).filter(name => name.startsWith('.pruning-')), []);
    assert.deepEqual(state.spawns.map(spawn => spawn.args), [['prune', '--root', scope.backups, '--workspace', scope.workspace, '--owner', String(uid)]]);
    assert.equal(state.spawns[0].source, 'privileged source text');
});

test('AC12: a stopped, unready or unhealthy current Box skips retention with no privileged spawn', async t => {
    const { scope } = fixture(t);
    const complete = completeBackup(scope, 'redeploy-Complet1');
    const cases = [
        { boxes: [box(CUR, BOX, false)], reason: 'QA_RETENTION_CURRENT_NOT_RUNNING' },
        { ready: false, reason: 'QA_UPDATE_RUNTIME_NOT_READY' },
        { runtimeError: Object.assign(new Error('x'), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' }), reason: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' },
        { healthError: Object.assign(new Error('x'), { code: 'QA_UPDATE_LOOPBACK_HEALTH_FAILED' }), reason: 'QA_UPDATE_LOOPBACK_HEALTH_FAILED' },
        { healthError: new Error('raw failure text with /secret/path'), reason: 'QA_RETENTION_HEALTH_UNPROVEN' },
    ];
    for (const { reason, ...options } of cases) {
        const { adapters, state } = admin(scope, options);
        const result = await prune(scope, adapters);
        assert.equal(result.status, 0);
        assert.deepEqual(result.output, { result: 'skipped', reason, removedBackups: [], removedBoxes: [] });
        assert.deepEqual(state.spawns, [], 'the privileged process is never started');
        assert.deepEqual(state.removals, []);
        assert(exists(complete));
    }
});

test('AC12: identity, privileged and Box-removal failures exit 1', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Complet1', { prior: OLD });
    const retainedRunning = [box(CUR, BOX, true), box(OLD2, `${BOX}-rollback-redeploy-Running1`, true)];
    const failures = [
        { currentId: OTHER, code: 'QA_RETENTION_CURRENT_CHANGED', spawned: false },
        { options: { boxes: [box(CUR, BOX, true), box(OTHER, BOX, true)] }, code: 'QA_RETENTION_CURRENT_CHANGED', spawned: false },
        { options: { boxes: retainedRunning }, code: 'QA_EXACT_RUNNING_BOX_REQUIRED', spawned: false },
        { options: { boxes: [box(CUR, BOX, true), box(OLD2, `${BOX}-rollback-redeploy-AbCd1234-x`)] }, code: 'QA_EXACT_RUNNING_BOX_REQUIRED', spawned: false },
        { options: { lock: false }, code: 'QA_RETENTION_HOST_LOCK_REQUIRED', spawned: false },
        { options: { assertRuntimeReady: null }, code: 'QA_RETENTION_READINESS_PROOF_UNAVAILABLE', spawned: false },
        { options: { privileged: () => ({ status: 1, stdout: 'sudo: a password is required\n' }) }, code: 'QA_RETENTION_PRIVILEGED_FAILED', spawned: true },
        { options: { privileged: () => ({ status: null, error: true, stdout: '' }) }, code: 'QA_RETENTION_PRIVILEGED_FAILED', spawned: true },
        { options: { privileged: () => ({ status: 0, stdout: '[sudo] password for admin: ' }) }, code: 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID', spawned: true },
        { options: { privileged: () => ({ status: 0, stdout: '{"result":"pruned","removed":[' }) }, code: 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID', spawned: true },
        { options: { privileged: () => ({ status: 0, stdout: '{"result":"pruned","removed":[],"retained":[],"unrecognized":[],"replayedTombstones":[]}\n{}\n' }) },
            code: 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID', spawned: true },
        { options: { privileged: () => ({ status: 0, stdout: '{"result":"failed","code":"QA_X"}\n' }) }, code: 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID', spawned: true },
    ];
    for (const { options = {}, currentId = CUR, code, spawned } of failures) {
        const { adapters, state } = admin(scope, options);
        const result = await prune(scope, adapters, currentId);
        assert.equal(result.status, 1, code);
        assert.equal(result.output.code, code);
        assert.equal(state.spawns.length > 0, spawned, code);
        assert.deepEqual(state.removals, [], code);
        assert(exists(path.join(scope.backups, 'redeploy-Complet1')), code);
    }
    const { adapters, state } = admin(scope, { boxes: [box(CUR, BOX, true), box(OLD, `${BOX}-rollback-redeploy-Complet1`)],
        removeError: Object.assign(new Error('x'), { code: 'QA_RETENTION_BOX_REMOVAL_FAILED' }) });
    const result = await prune(scope, adapters);
    assert.equal(result.status, 1);
    assert.deepEqual(result.output, { result: 'failed', code: 'QA_RETENTION_BOX_REMOVAL_FAILED', removedBackups: ['redeploy-Complet1'], removedBoxes: [] });
    assert.deepEqual(state.removals, [['podman', 'container', 'rm', OLD]]);
});

test('AC12: a Box that changed between the pre-deletion and the pre-removal inspection is not removed', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Complet1', { prior: OLD });
    const { adapters, state } = admin(scope, { boxes: [box(CUR, BOX, true), box(OLD, `${BOX}-rollback-redeploy-Complet1`)] });
    const inner = adapters.runPrivileged;
    adapters.runPrivileged = (source, args) => {
        const result = inner(source, args);
        state.boxes = state.boxes.map(item => item.box.id === OLD ? { ...item, box: { ...item.box, running: true } } : item);
        return result;
    };
    const result = await prune(scope, adapters);
    assert.equal(result.status, 1);
    assert.equal(result.output.code, 'QA_RETENTION_BOX_CHANGED');
    assert.deepEqual(state.removals, []);
});

test('AC12: the real update-helper readiness proof gates retention', { skip: typeof update.assertRuntimeReady !== 'function'
    && 'pending: update-explorer-qa.mjs does not export assertRuntimeReady yet' }, async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Complet1');
    const ready = admin(scope, { assertRuntimeReady: update.assertRuntimeReady });
    const passed = await prune(scope, ready.adapters);
    assert.equal(passed.status, 0);
    assert.equal(passed.output.result, 'pruned');
    assert.deepEqual(passed.output.removedBackups, ['redeploy-Complet1']);
    const second = completeBackup(scope, 'redeploy-Complet2');
    const unready = admin(scope, { ready: false, assertRuntimeReady: update.assertRuntimeReady });
    const skipped = await prune(scope, unready.adapters);
    assert.deepEqual(skipped.output, { result: 'skipped', reason: 'QA_UPDATE_RUNTIME_NOT_READY', removedBackups: [], removedBoxes: [] });
    assert.deepEqual(unready.state.spawns, []);
    assert(exists(second));
});

test('AC23: admin prune and rollback-target never read root-owned receipts; the privileged side classifies them', { skip: asRoot
    && 'root reads mode 000 files, so this test would pass vacuously' }, async t => {
    assert.notEqual(uid, 0);
    const { scope } = fixture(t);
    const backup = completeBackup(scope, 'redeploy-RootOwn1', { prior: OLD });
    for (const name of ['preservation.json', 'policy-restoration.json']) fs.chmodSync(path.join(backup, name), 0o000);
    assert.throws(() => fs.readFileSync(path.join(backup, 'preservation.json')), { code: 'EACCES' });
    const stub = admin(scope, { privileged: () => ({ status: 0,
        stdout: '{"result":"pruned","removed":[],"retained":[],"unrecognized":[],"replayedTombstones":[]}\n' }) });
    const pruned = await prune(scope, stub.adapters);
    assert.equal(pruned.status, 0, JSON.stringify(pruned.output));
    assert.equal(pruned.output.result, 'pruned');
    const target = await rollbackTarget(scope, admin(scope, { boxes: [box(FRESH, BOX, true), box(OLD, `${BOX}-rollback-redeploy-RootOwn1`)] }).adapters);
    assert.equal(target.status, 0, JSON.stringify(target.output));
    assert.equal(target.output.backup, 'redeploy-RootOwn1');
    // Without root, the receipts cannot be read and the backup is retained, never pruned.
    const unreadable = prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid });
    assert.deepEqual(unreadable.retained, [{ name: 'redeploy-RootOwn1', class: 'incomplete-redeploy' }]);
    assert(exists(backup));
    // Simulated root: the hook restores read permission just before each receipt is read.
    const read = [];
    const classified = prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks: {
        beforeRead(file) { read.push(path.basename(file)); fs.chmodSync(file, 0o600); } } });
    assert.deepEqual(classified.removed, [{ name: 'redeploy-RootOwn1', priorRecord: `podman|${OLD}|${BOX}` }]);
    assert.deepEqual(read.sort(), ['policy-restoration.json', 'preservation.json', 'restored-selections.json']);
    assert(!exists(backup));
});

test('AC24: backups with rollback markers are never pruned and their Boxes stay', async t => {
    const { scope } = fixture(t);
    const recovered = completeBackup(scope, 'redeploy-Recover1', { prior: OLD });
    write(path.join(recovered, 'rollback-result.json'), { result: 'recovered', phase: 'complete', failedId: OTHER });
    write(path.join(recovered, 'failed-workspace/.data/new'), 'data written after the redeploy');
    const journal = completeBackup(scope, 'redeploy-Journal1', { prior: OLD2 });
    write(path.join(journal, 'rollback-result.json.0123456789abcdef'), 'temporary');
    const failedOnly = abortedBackup(scope, 'redeploy-FailedW1', { prior: FRESH });
    write(path.join(failedOnly, 'failed-workspace/.data/new'), 'only copy');
    const { adapters, state } = admin(scope, { boxes: [box(CUR, BOX, true),
        box(OLD, `${BOX}-rollback-redeploy-Recover1`), box(OTHER, `${BOX}-failed-redeploy-Recover1`),
        box(OLD2, `${BOX}-rollback-redeploy-Journal1`), box(FRESH, `${BOX}-rollback-redeploy-FailedW1`)] });
    const result = await prune(scope, adapters);
    assert.equal(result.status, 0);
    assert.deepEqual(result.output.removedBackups, []);
    assert.deepEqual(result.output.retained.map(item => item.class), ['rollback-attempted', 'rollback-attempted', 'rollback-attempted']);
    for (const dir of [recovered, journal, failedOnly]) assert(exists(dir));
    assert.deepEqual(state.removals, []);
    assert.equal(result.output.retainedUnproven.length, 4);
    assert(result.output.retainedUnproven.some(item => item.name === `${BOX}-failed-redeploy-Recover1`));
});

test('probe: name boundaries and malformed --current-id values', async t => {
    const { scope } = fixture(t);
    const lookalikes = ['redeploy-AbCd123', 'redeploy-AbCd12345', 'redeploy-AbCd123€', 'Redeploy-AbCd1234', '.pruning-redeploy-AbCd123'];
    for (const name of lookalikes) completeBackup(scope, name);
    const result = await prune(scope, admin(scope).adapters);
    assert.equal(result.status, 0);
    assert.deepEqual(result.output.removedBackups, []);
    assert.deepEqual(result.output.unrecognized.sort(), [...lookalikes].sort());
    for (const name of lookalikes) assert(exists(path.join(scope.backups, name)), name);
    const untouchable = new Proxy({}, { get() { throw new Error('no adapter may run for a usage error'); } });
    for (const currentId of ['c'.repeat(63), 'C'.repeat(64), 'absent', '', `${CUR}\n`]) {
        const usage = await run(['prune', '--current-id', currentId, '--lock-held'], untouchable, scope);
        assert.deepEqual(usage, { status: 1, output: { result: 'failed', code: 'QA_BACKUPS_USAGE_INVALID' } });
    }
    for (const argv of [['prune', '--current-id', CUR], ['prune-plan', '--current-id', CUR, '--lock-held'],
        ['prune', '--keep', 'redeploy-AbCd1234', '--current-id', CUR, '--lock-held'], ['rollback-target'], []]) {
        assert.equal((await run(argv, untouchable, scope)).output.code, 'QA_BACKUPS_USAGE_INVALID', argv.join(' '));
    }
});

test('probe: an empty or absent backups root prunes nothing and exits 0', async t => {
    const { scope } = fixture(t);
    const empty = await prune(scope, admin(scope).adapters);
    assert.equal(empty.status, 0);
    assert.deepEqual(empty.output, { result: 'pruned', removedBackups: [], removedBoxes: [], retained: [], unrecognized: [],
        replayedTombstones: [], retainedUnproven: [], orphanedAnonymousVolumes: [] });
    fs.rmdirSync(scope.backups);
    const absent = await prune(scope, admin(scope).adapters);
    assert.equal(absent.status, 0);
    assert.deepEqual(absent.output.removedBackups, []);
    assert(!exists(scope.backups), 'the prune never creates the root');
    const none = await rollbackTarget(scope, admin(scope).adapters);
    assert.equal(none.status, 1);
    assert.equal(none.output.code, 'QA_ROLLBACK_TARGET_NONE');
});

test('probe: prune is idempotent and an interrupted tombstone is replayed, leaving its Box unproven', async t => {
    const { scope } = fixture(t);
    const before = snapshotWorkspace(scope);
    completeBackup(scope, 'redeploy-Interr01', { prior: OLD });
    const survivor = completeBackup(scope, 'redeploy-Survivr1', { prior: OLD2 });
    write(`${path.join(scope.backups, 'redeploy-Interr01')}-lock.log`, 'sibling');
    // Killed after the first rename and before any removal.
    assert.throws(() => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks: {
        afterRename() { throw Object.assign(new Error('killed'), { code: 'QA_TEST_KILLED' }); } } }), { code: 'QA_TEST_KILLED' });
    const tombstone = path.join(scope.backups, '.pruning-redeploy-Interr01');
    assert(exists(tombstone) && exists(survivor) && exists(`${path.join(scope.backups, 'redeploy-Interr01')}-lock.log`));
    const boxes = [box(CUR, BOX, true), box(OLD, `${BOX}-rollback-redeploy-Interr01`), box(OLD2, `${BOX}-rollback-redeploy-Survivr1`)];
    const first = admin(scope, { boxes });
    const replayed = await prune(scope, first.adapters);
    assert.equal(replayed.status, 0, JSON.stringify(replayed.output));
    assert.deepEqual(replayed.output.replayedTombstones, ['.pruning-redeploy-Interr01']);
    assert.deepEqual(replayed.output.removedBackups, ['redeploy-Survivr1']);
    assert(!exists(tombstone) && !exists(`${path.join(scope.backups, 'redeploy-Interr01')}-lock.log`));
    assert.deepEqual(first.state.removals, [['podman', 'container', 'rm', OLD2]]);
    assert.deepEqual(replayed.output.retainedUnproven, [{ engine: 'podman', id: OLD, name: `${BOX}-rollback-redeploy-Interr01` }]);
    const second = admin(scope, { boxes: first.state.boxes });
    const again = await prune(scope, second.adapters);
    assert.equal(again.status, 0);
    assert.deepEqual([again.output.removedBackups, again.output.removedBoxes, again.output.replayedTombstones], [[], [], []]);
    assert.deepEqual(second.state.removals, []);
    assert.deepEqual(fs.readdirSync(scope.backups), []);
    assert.deepEqual(snapshotWorkspace(scope), before);
});

test('probe: a tombstone replaced after the rename is never removed', async t => {
    const { base, scope } = fixture(t);
    const backup = completeBackup(scope, 'redeploy-Swapped1');
    const aside = path.join(base, 'moved-original');
    const canary = path.join(scope.backups, '.pruning-redeploy-Swapped1', 'canary');
    assert.throws(() => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks: {
        afterRename(name, tombstone) {
            fs.renameSync(tombstone, aside);
            fs.mkdirSync(tombstone, { mode: 0o700 });
            write(canary, 'not ours');
        } } }), error => error.code === 'QA_PRIVILEGED_TOMBSTONE_CHANGED' && error.removedBeforeFailure.length === 0);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'not ours');
    assert.equal(fs.readFileSync(path.join(aside, 'workspace/.data/explorer/accounts'), 'utf8'), 'previous durable data of redeploy-Swapped1');
    assert(!exists(backup));
});

test('probe: orphan retained Boxes and records naming absent IDs are reported, never removed', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Ghostid1', { prior: OLD2 });
    const { adapters, state } = admin(scope, { boxes: [box(CUR, BOX, true), box(OLD, `${BOX}-rollback-redeploy-ZZZZZZZZ`)] });
    const result = await prune(scope, adapters);
    assert.equal(result.status, 0);
    assert.deepEqual(result.output.removedBackups, ['redeploy-Ghostid1']);
    assert.deepEqual(result.output.removedBoxes, []);
    assert.deepEqual(state.removals, []);
    assert.deepEqual(result.output.retainedUnproven, [{ engine: 'podman', id: OLD, name: `${BOX}-rollback-redeploy-ZZZZZZZZ` }]);
    // The recorded ID alone never binds: the Box must also carry this backup's rollback name.
    completeBackup(scope, 'redeploy-Renamed1', { prior: OLD2 });
    const renamed = admin(scope, { boxes: [box(CUR, BOX, true), box(OLD2, `${BOX}-rollback-redeploy-Another1`),
        box(OLD, `${BOX}-failed-redeploy-Renamed1`)] });
    const unbound = await prune(scope, renamed.adapters);
    assert.equal(unbound.status, 0, JSON.stringify(unbound.output));
    assert.deepEqual(unbound.output.removedBackups, ['redeploy-Renamed1']);
    assert.deepEqual(renamed.state.removals, []);
    assert.deepEqual(unbound.output.retainedUnproven.map(item => item.id).sort(), [OLD, OLD2].sort());
});

test('probe: a prior record for the current Box or another engine never removes a Box', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-SameCur1', { prior: CUR });
    const docker = completeBackup(scope, 'redeploy-Docker01', { prior: OLD });
    write(path.join(docker, 'prior-containers.txt'), `docker|${OLD}|${BOX}\n`);
    const { adapters, state } = admin(scope, { boxes: [box(CUR, BOX, true), box(OLD, `${BOX}-rollback-redeploy-Docker01`)] });
    const result = await prune(scope, adapters);
    assert.equal(result.status, 0);
    assert.deepEqual(result.output.removedBackups.sort(), ['redeploy-Docker01', 'redeploy-SameCur1']);
    assert.deepEqual(state.removals, []);
});

test('probe: invalid leftover tombstones abort before any removal', async t => {
    const variants = {
        symlink: scope => fs.symlinkSync(scope.workspace, path.join(scope.backups, '.pruning-redeploy-AbCd1234')),
        file: scope => write(path.join(scope.backups, '.pruning-redeploy-AbCd1234'), 'file'),
        'other owner': scope => ({ uid: uid + 1 }),
        'other device': scope => ({ dev: 1n }),
        'workspace inode': scope => 'workspace',
    };
    for (const [label, setup] of Object.entries(variants)) {
        const { scope } = fixture(t);
        const complete = completeBackup(scope, 'redeploy-Complet1');
        const tombstone = path.join(scope.backups, '.pruning-redeploy-AbCd1234');
        let override = setup(scope);
        if (!exists(tombstone)) completeBackup(scope, 'redeploy-AbCd1234') && fs.renameSync(path.join(scope.backups, 'redeploy-AbCd1234'), tombstone);
        const workspaceStat = fs.lstatSync(scope.workspace, { bigint: true });
        if (override === 'workspace') override = { dev: workspaceStat.dev, ino: workspaceStat.ino };
        const hooks = { lstat(file, stat) {
            if (file !== tombstone || !override || typeof override !== 'object') return stat;
            const copy = Object.create(Object.getPrototypeOf(stat));
            return Object.assign(copy, stat, Object.fromEntries(Object.entries(override).map(([key, value]) => [key, BigInt(value)])));
        } };
        assert.throws(() => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks }),
            { code: 'QA_PRIVILEGED_TOMBSTONE_INVALID' }, label);
        assert(exists(complete) && exists(tombstone), label);
        assert.deepEqual(snapshotWorkspace(scope).files.length, 2, label);
    }
});

test('probe: a backup that is the live workspace, a link to it, or on another device is refused untouched', async t => {
    const { scope } = fixture(t);
    const before = snapshotWorkspace(scope);
    fs.symlinkSync(scope.workspace, path.join(scope.backups, 'redeploy-LinkToWs'));
    const sameInode = completeBackup(scope, 'redeploy-SameIno1');
    const otherDev = completeBackup(scope, 'redeploy-OtherDv1');
    const fine = completeBackup(scope, 'redeploy-Fine0001');
    const workspaceStat = fs.lstatSync(scope.workspace, { bigint: true });
    const swap = (stat, values) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, values);
    const hooks = { lstat(file, stat) {
        if (file === sameInode) return swap(stat, { dev: workspaceStat.dev, ino: workspaceStat.ino });
        if (file === otherDev) return swap(stat, { dev: stat.dev + 1n });
        return stat;
    } };
    const result = prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks });
    assert.deepEqual(result.unrecognized.sort(), ['redeploy-LinkToWs', 'redeploy-OtherDv1', 'redeploy-SameIno1']);
    assert.deepEqual(result.removed.map(item => item.name), ['redeploy-Fine0001']);
    assert(exists(sameInode) && exists(otherDev) && fs.lstatSync(path.join(scope.backups, 'redeploy-LinkToWs')).isSymbolicLink());
    assert(!exists(fine));
    assert.deepEqual(snapshotWorkspace(scope), before);
});

test('probe: another filesystem anywhere below a prunable backup aborts before any rename or removal', async t => {
    const { scope } = fixture(t);
    const first = completeBackup(scope, 'redeploy-AAAAAAAA');
    const mounted = completeBackup(scope, 'redeploy-BBBBBBBB');
    const nested = path.join(mounted, 'workspace/.data/explorer/accounts');
    const hooks = { lstat(file, stat) {
        return file === nested ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1n }) : stat;
    } };
    assert.throws(() => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks }),
        error => error.code === 'QA_PRIVILEGED_OTHER_FILESYSTEM' && error.removedBeforeFailure.length === 0);
    assert(exists(first) && exists(mounted) && exists(nested));
    assert.deepEqual(fs.readdirSync(scope.backups).sort(), ['redeploy-AAAAAAAA', 'redeploy-BBBBBBBB']);
});

test('probe: wrong-type or foreign entries and siblings retain the backup', async t => {
    const { scope } = fixture(t);
    const linkedReceipt = completeBackup(scope, 'redeploy-LinkRcp1');
    fs.rmSync(path.join(linkedReceipt, 'policy-restoration.json'));
    fs.symlinkSync('/etc/hosts', path.join(linkedReceipt, 'policy-restoration.json'));
    const fileWorkspace = abortedBackup(scope, 'redeploy-FileWsp1');
    write(path.join(fileWorkspace, 'workspace'), 'not a directory');
    const linkedSibling = completeBackup(scope, 'redeploy-LinkSib1');
    fs.symlinkSync(scope.workspace, `${linkedSibling}-helpers`);
    const sourceMoved = abortedBackup(scope, 'redeploy-Moved001');
    write(path.join(sourceMoved, 'preservation.json'), { source: path.join(sourceMoved, 'workspace'), exactCopiesVerified: true });
    const openMode = completeBackup(scope, 'redeploy-OpenMod1');
    fs.chmodSync(openMode, 0o755);
    const malformed = completeBackup(scope, 'redeploy-Malform1');
    write(path.join(malformed, 'preservation.json'), '{not json');
    const result = prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(Object.fromEntries(result.retained.map(item => [item.name, item.class])), {
        'redeploy-FileWsp1': 'unrecognized-entry', 'redeploy-LinkRcp1': 'unrecognized-entry',
        'redeploy-LinkSib1': 'unrecognized-entry', 'redeploy-Malform1': 'incomplete-redeploy', 'redeploy-Moved001': 'incomplete-redeploy',
    });
    assert.deepEqual(result.unrecognized, ['redeploy-OpenMod1']);
    assert(fs.lstatSync(`${linkedSibling}-helpers`).isSymbolicLink());
    assert(exists(path.join(scope.workspace, '.data/explorer/accounts')));
});

test('AC16: the newest backup that changed QA state is the only rollback target', async t => {
    const { scope } = fixture(t);
    const older = completeBackup(scope, 'redeploy-Older001', { prior: OLD });
    const newer = completeBackup(scope, 'redeploy-Newer001', { prior: OLD2 });
    const selected = await rollbackTarget(scope, admin(scope, { boxes: [box(FRESH, BOX, true),
        box(OLD, `${BOX}-rollback-redeploy-Older001`), box(OLD2, `${BOX}-rollback-redeploy-Newer001`)] }).adapters);
    assert.equal(selected.status, 0);
    assert.deepEqual({ ...selected.output, candidates: selected.output.candidates.map(item => [item.name, item.eligible, item.reason]) }, {
        result: 'selected', backup: 'redeploy-Newer001', currentId: FRESH, predecessorId: OLD2,
        candidates: [['redeploy-Newer001', true, null], ['redeploy-Older001', true, null]] });
    // A rollback marker on the newest refuses; an older eligible backup is never used instead.
    write(path.join(newer, 'rollback-result.json'), { result: 'failed', phase: 'copying-durable-state' });
    const refused = await rollbackTarget(scope, admin(scope).adapters);
    assert.equal(refused.status, 1);
    assert.equal(refused.output.result, 'refused');
    assert.equal(refused.output.backup, 'redeploy-Newer001');
    assert.equal(refused.output.reason, 'rollback-already-attempted');
    fs.rmSync(newer, { recursive: true });
    // A fresh-install backup has no predecessor and is refused.
    freshInstallBackup(scope, 'redeploy-FreshIn1');
    const noPredecessor = await rollbackTarget(scope, admin(scope).adapters);
    assert.deepEqual([noPredecessor.status, noPredecessor.output.reason], [1, 'no-predecessor']);
    assert(exists(older));
});

test('AC16 with N1: attempts without stop evidence are skipped, listed, and never block an older target', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Older001', { prior: OLD });
    abortedBackup(scope, 'redeploy-NoStop01', { prior: OLD2 });
    // Its predecessor is stopped but no longer under the exact name, so it is not stop evidence.
    const boxes = [box(FRESH, BOX, true), box(OLD, `${BOX}-rollback-redeploy-Older001`), box(OLD2, `${BOX}-rollback-redeploy-Older002`)];
    const selected = await rollbackTarget(scope, admin(scope, { boxes }).adapters);
    assert.equal(selected.status, 0, JSON.stringify(selected.output));
    assert.equal(selected.output.backup, 'redeploy-Older001');
    assert.deepEqual(selected.output.candidates.find(item => item.name === 'redeploy-NoStop01'),
        { name: 'redeploy-NoStop01', createdAt: selected.output.candidates[0].createdAt, eligible: false, reason: 'no-stop-evidence' });
    fs.rmSync(path.join(scope.backups, 'redeploy-Older001'), { recursive: true });
    const none = await rollbackTarget(scope, admin(scope, { boxes }).adapters);
    assert.equal(none.status, 1);
    assert.equal(none.output.code, 'QA_ROLLBACK_TARGET_NONE');
    assert.equal(none.output.candidates[0].reason, 'no-stop-evidence');
});

test('AC16 with N2: a stopped exact-name predecessor or a quiesce sibling is stop evidence', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Older001', { prior: OLD });
    abortedBackup(scope, 'redeploy-Stopped1', { prior: OLD2 });
    const stoppedExact = await rollbackTarget(scope, admin(scope, { boxes: [box(OLD2, BOX, false)] }).adapters);
    assert.equal(stoppedExact.status, 0, JSON.stringify(stoppedExact.output));
    assert.deepEqual([stoppedExact.output.backup, stoppedExact.output.currentId, stoppedExact.output.predecessorId],
        ['redeploy-Stopped1', 'absent', OLD2]);
    const quiesced = abortedBackup(scope, 'redeploy-Quiesce1', { prior: OTHER });
    write(`${quiesced}-quiesce.log`, 'partial');
    const runningPredecessor = await rollbackTarget(scope, admin(scope, { boxes: [box(OTHER, BOX, true)] }).adapters);
    assert.deepEqual([runningPredecessor.output.backup, runningPredecessor.output.currentId], ['redeploy-Quiesce1', 'absent']);
    const differentCurrent = await rollbackTarget(scope, admin(scope, { boxes: [box(FRESH, BOX, true), box(OTHER, `${BOX}-x`, false)] }).adapters);
    assert.deepEqual([differentCurrent.output.backup, differentCurrent.output.currentId], ['redeploy-Quiesce1', FRESH]);
    const noCurrent = await rollbackTarget(scope, admin(scope, { boxes: [] }).adapters);
    assert.equal(noCurrent.output.currentId, 'absent');
    const ambiguous = await rollbackTarget(scope, admin(scope, { boxes: [box(FRESH, BOX, true), box(CUR, BOX, false)] }).adapters);
    assert.deepEqual(ambiguous, { status: 1, output: { result: 'failed', code: 'QA_BOX_AMBIGUOUS' } });
});

test('AC16: undated backups are excluded from ordering; the selection needs the held lock', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Dated001', { prior: OLD });
    const undated = completeBackup(scope, 'redeploy-Undated1', { prior: OLD2 });
    write(path.join(undated, 'rollback-authority.json'), '{"createdAt":"yesterday"}');
    const malformed = completeBackup(scope, 'redeploy-Malform1', { prior: OTHER });
    write(path.join(malformed, 'rollback-authority.json'), '{broken');
    const selected = await rollbackTarget(scope, admin(scope).adapters);
    assert.equal(selected.output.backup, 'redeploy-Dated001');
    assert.deepEqual(selected.output.candidates.filter(item => item.reason === 'undated').map(item => item.name).sort(),
        ['redeploy-Malform1', 'redeploy-Undated1']);
    const { adapters, state } = admin(scope, { lock: false });
    const locked = await rollbackTarget(scope, adapters);
    assert.deepEqual(locked, { status: 1, output: { result: 'failed', code: 'QA_BACKUPS_HOST_LOCK_REQUIRED' } });
    assert.equal(state.inspections, 0);
});

test('production adapters: sudo runs /usr/bin/node with the module on stdin; Box removal is exactly container rm <id>', async t => {
    const { base, scope } = fixture(t);
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const record = path.join(base, 'record');
    for (const name of ['sudo', 'podman']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name}" "$@" > "${record}.${name}.args"\ncat > "${record}.${name}.stdin"\n`
            + (name === 'sudo' ? `printf '%s\\n' '{"result":"pruned","removed":[],"retained":[],"unrecognized":[],"replayedTombstones":[]}'\n` : ''), { mode: 0o700 });
    }
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
        const adapters = retentionProductionAdapters(scope);
        const source = adapters.privilegedSource();
        assert.equal(source, fs.readFileSync(PRIVILEGED_FILE, 'utf8'));
        const result = adapters.runPrivileged(source, ['prune', '--root', scope.backups, '--workspace', scope.workspace, '--owner', String(uid)]);
        assert.equal(result.status, 0);
        assert.equal(parsePrivilegedOutput(result.stdout).result, 'pruned');
        assert.deepEqual(fs.readFileSync(`${record}.sudo.args`, 'utf8').trim().split('\n'), ['sudo', '-n', '/usr/bin/node',
            '--input-type=module', '-', 'prune', '--root', scope.backups, '--workspace', scope.workspace, '--owner', String(uid)]);
        assert.equal(fs.readFileSync(`${record}.sudo.stdin`, 'utf8'), source);
        adapters.removeContainer('podman', OLD);
        assert.deepEqual(fs.readFileSync(`${record}.podman.args`, 'utf8').trim().split('\n'), ['podman', 'container', 'rm', OLD]);
        assert.throws(() => adapters.removeContainer('podman', 'not-an-id'), { code: 'QA_RETENTION_BOX_REMOVAL_FAILED' });
        assert.throws(() => adapters.removeContainer('sh', OLD), { code: 'QA_RETENTION_BOX_REMOVAL_FAILED' });
        assert.equal(adapters.assertRuntimeReady, update.assertRuntimeReady);
    } finally { process.env.PATH = savedPath; }
    assert(PRIVILEGED_TIMEOUT_MS >= 30 * 60_000, 'the deletion is not bounded by a short command timeout');
});

test('production lock probe: held only while another process holds the host flock', { skip: spawnSync('sh', ['-c', 'command -v flock']).status !== 0
    && 'flock is not installed on this host' }, async t => {
    const { scope } = fixture(t);
    const adapters = retentionProductionAdapters(scope);
    assert.equal(adapters.lockHeld(), false);
    const { spawn } = await import('node:child_process');
    const holder = spawn('flock', [scope.lock, 'sleep', '5'], { stdio: 'ignore' });
    t.after(() => holder.kill());
    for (let attempt = 0; attempt < 50 && !adapters.lockHeld(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(adapters.lockHeld(), true);
});

test('the retention service rejects a malformed current ID before touching any adapter', async () => {
    const service = createRetentionService(new Proxy({}, { get() { throw new Error('touched'); } }), QA_SCOPE);
    await assert.rejects(service.prune({ currentId: 'absent' }), { code: 'QA_RETENTION_USAGE_INVALID' });
    assert.throws(() => selectRollbackTarget({ getuid: () => uid, boxes: () => [box(CUR, BOX, true), box(OLD, BOX, true)] },
        { ...QA_SCOPE, backups: path.join(os.tmpdir(), `absent-${process.pid}-${Date.now()}`) }), { code: 'QA_ROLLBACK_TARGET_NONE' });
});

test('a moved live workspace is stop evidence, so the newest attempt is not skipped in favour of an older backup', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Older001', { prior: OLD });
    // Crashed after moving the live workspace and before writing preservation.json; the predecessor was renamed away.
    const moved = abortedBackup(scope, 'redeploy-MovedWs1', { prior: OLD2 });
    write(path.join(moved, 'workspace/.data/explorer/accounts'), 'only copy of the live data');
    const boxes = [box(OLD, `${BOX}-rollback-redeploy-Older001`), box(OLD2, `${BOX}-rollback-redeploy-Elsewhere`)];
    const selected = await rollbackTarget(scope, admin(scope, { boxes }).adapters);
    assert.equal(selected.status, 0, JSON.stringify(selected.output));
    assert.equal(selected.output.backup, 'redeploy-MovedWs1');
});

test('mount points are parsed from mountinfo with their octal escapes decoded', () => {
    const { parseMountPoints } = privilegedModule;
    assert.deepEqual(parseMountPoints([
        '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
        '90 22 8:1 /home/admin/explorerQaWorkspace /home/admin/.qa-deployment-backups/redeploy-AbCd1234/with\\040space rw - ext4 /dev/sda1 rw',
        '',
    ].join('\n')), ['/', '/home/admin/.qa-deployment-backups/redeploy-AbCd1234/with space']);
});

test('a mount below the backups root refuses the whole prune before anything is removed', t => {
    const { scope } = fixture(t);
    const complete = completeBackup(scope, 'redeploy-Complet1');
    const before = snapshotWorkspace(scope);
    for (const point of [path.join(complete, 'workspace/.data'), path.join(scope.backups, 'redeploy-Complet1-helpers')]) {
        assert.throws(() => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid,
            hooks: { mountPoints: () => ['/', point] } }), error => error.code === 'QA_PRIVILEGED_MOUNT_INSIDE'
            && error.removedBeforeFailure.length === 0);
        assert(exists(path.join(complete, 'workspace/.data/explorer/accounts')));
    }
    assert.deepEqual(snapshotWorkspace(scope), before);
    // The backups root itself may be a mount point of its own.
    const allowed = prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid,
        hooks: { mountPoints: () => ['/', scope.backups] } });
    assert.deepEqual(allowed.removed.map(item => item.name), ['redeploy-Complet1']);
});

test('a mount that appears below a tombstone after classification stops the removal and keeps the tombstone', t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Complet1');
    const tombstone = path.join(scope.backups, '.pruning-redeploy-Complet1');
    let renamed = false;
    assert.throws(() => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, hooks: {
        afterRename() { renamed = true; },
        mountPoints: () => renamed ? ['/', path.join(tombstone, 'workspace/.data')] : ['/'],
    } }), { code: 'QA_PRIVILEGED_MOUNT_INSIDE' });
    assert(exists(path.join(tombstone, 'workspace/.data/explorer/accounts')), 'nothing below the tombstone was removed');
});

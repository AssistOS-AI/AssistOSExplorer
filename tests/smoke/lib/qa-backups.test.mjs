import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
// The resume route is reached through the namespace, so a missing export fails only the tests that use it.
import * as backupsModule from '../../../.github/scripts/qa-backups.mjs';

const { prunePrivileged, resumeProofPrivileged } = privilegedModule;
const { RESUME_REGENERABLE, acceptedBackupPlan, backupHelperCommand, inventoryBackups, isCopiedEntry, parseResumeProof,
    routeDeployment } = backupsModule;
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

// ---------------------------------------------------------------------------
// Deployment route and resume proofs (resume plan, contracts 2 and 3 with I1, N6 and N7).
// ---------------------------------------------------------------------------

const WORKFLOW = new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url);
const HASH_LABEL = 'io.assistos.ploinky-box.path-hash';
// The observed interrupted redeploy (deploy run 39604707578, inspect run 39608950538).
const B = 'redeploy-jQRMF7aJ';
const P = 'd4ada3623b3d9a7aac7b03e56cfd692ae0f2782cf7a727c24e9a5b1f505ed7b1';
const RESUMED = { result: 'routed', route: 'resume', backup: B, predecessorId: P, engine: 'podman' };
const SELECT = { result: 'routed', route: 'select' };

const container = (id, name, running = false, { engine = 'podman', labelled = true } = {}) => ({ engine, id, name, running,
    labels: labelled ? { [HASH_LABEL]: QA_SCOPE.hash, 'io.assistos.ploinky-box.role': 'box' } : {} });
const RETAINED_P = container(P, `${BOX}-rollback-${B}`);
const planned = (predecessorId = P, extra = {}) => ({ status: 0, stdout: JSON.stringify({ result: 'planned', predecessorId,
    currentId: null, image: 'a'.repeat(64), sourceCount: 9, mutations: false, ...extra }) + '\n' });

function gitRepository(directory, origin, { checkout = false } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const git = (...args) => {
        const result = spawnSync('git', ['-c', 'user.name=QA Fixture', '-c', 'user.email=qa-fixture@example.invalid',
            '-c', 'init.defaultBranch=main', '-C', directory, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-q');
    git('remote', 'add', 'origin', origin);
    if (checkout) {
        write(path.join(directory, 'README.md'), 'checked out\n');
        git('add', 'README.md');
        git('commit', '-q', '-m', 'fixture');
    }
}

/**
 * The real preservation block of deploy-explorer-qa.yml, sliced between its
 * markers. Only its three pinned literals are substituted, each exactly once,
 * so a changed block fails here instead of being skipped.
 */
function preservationSource({ target, backups, expectedUid }) {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    const BEGIN = '// BEGIN QA durable workspace preservation', END = '// END QA durable workspace preservation';
    const begin = text.indexOf(BEGIN), end = text.indexOf(END);
    assert(begin > 0 && end > begin && text.indexOf(BEGIN, begin + 1) === -1 && text.indexOf(END, end + 1) === -1,
        'the preservation block markers are present exactly once');
    let source = text.slice(text.lastIndexOf('\n', begin) + 1, text.indexOf('\n', end)).replace(/^ {10}/gm, '');
    const once = (from, to) => {
        assert.equal(source.split(from).length, 2, `the preservation block contains exactly one ${from}`);
        source = source.replace(from, () => to);
    };
    if (target !== QA_SCOPE.workspace) {
        once("assert.equal(target, '/home/admin/explorerQaWorkspace');", `assert.equal(target, ${JSON.stringify(target)});`);
        once("assert.equal(path.dirname(backup), '/home/admin/.qa-deployment-backups');",
            `assert.equal(path.dirname(backup), ${JSON.stringify(backups)});`);
        once('assert.equal(process.getuid(), 0);', `assert.equal(process.getuid(), ${expectedUid});`);
        assert.doesNotMatch(source, /\/home\/admin/, 'no other pinned host path remains in the block');
    }
    return ["import assert from 'node:assert/strict';", "import fs from 'node:fs';", "import path from 'node:path';",
        "import { execFileSync } from 'node:child_process';", source].join('\n');
}

function runPreservation(base, scope, backup) {
    const env = { ...process.env };
    if (process.platform === 'darwin') {
        // BSD cp has no --reflink; the shim drops only that option.
        const shim = path.join(base, 'shim');
        fs.mkdirSync(shim, { recursive: true });
        fs.writeFileSync(path.join(shim, 'cp'), '#!/bin/sh\nfor argument; do shift; [ "$argument" = --reflink=auto ] || set -- "$@" "$argument"; done\n'
            + 'exec /bin/cp "$@"\n', { mode: 0o700 });
        env.PATH = `${shim}${path.delimiter}${env.PATH}`;
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-', scope.workspace, backup], { encoding: 'utf8', env,
        input: preservationSource({ target: scope.workspace, backups: scope.backups, expectedUid: uid }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prior workspace retained; durable files and their encryption identities copied and compared/);
}

/** The previous live workspace as the preserving redeploy found it. */
function previousWorkspace(workspace, { originalEnv = false } = {}) {
    fs.mkdirSync(workspace, { mode: 0o700 });
    write(path.join(workspace, '.data/explorer/accounts'), 'previous durable accounts');
    write(path.join(workspace, '.data/userPersisto/users.json'), '{"users":1}');
    write(path.join(workspace, 'test1.backlog'), 'backlog item');
    write(path.join(workspace, 'testN2/testareREADME.md'), '# readme');
    write(path.join(workspace, 'testN2/.agents/.ploinky-skill-exports.json'), '{}');
    write(path.join(workspace, 'WebMeet/test-room-afca4080/testscripta-doc.md'), 'meeting notes');
    write(path.join(workspace, '.ploinky/data/master-key'), `${'e'.repeat(64)}\n`);
    for (const name of ['.secrets', 'passwords.enc', 'ploinky_subject_identity_ed25519_v1.enc']) {
        write(path.join(workspace, '.ploinky/data', name), `encrypted ${name}`);
    }
    write(path.join(workspace, '.ploinky/data/sso-provider.json'), '{"provider":"local"}');
    // Runtime state that Ploinky regenerates; the preservation block leaves it in the backup only.
    for (const relative of ['data/edge-routing/generation.json', 'data/edge-publication/state.json', 'data/router-security/policy.json',
        'agents.json', 'routing.json', 'enabled_repos.json', 'repo_sources.json', 'repos/AchillesIDE/explorer/manifest.json',
        'running/explorer.pid', 'box/dependencies/package.json', 'box/images/store']) write(path.join(workspace, '.ploinky', relative), '{}');
    write(path.join(workspace, '.ploinky/edge-desired.json'), '{"hosts":{},"cloudflare":{},"media":{}}\n');
    write(path.join(workspace, '.ploinky/profile'), 'default\n');
    gitRepository(path.join(workspace, '.runtime/ploinky'), 'https://github.com/AssistOS-AI/ploinky.git', { checkout: true });
    gitRepository(path.join(workspace, 'AdvancedLanguageAgent'), 'https://github.com/AssistOS-AI/AdvancedLanguageAgent.git', { checkout: true });
    if (originalEnv) write(path.join(workspace, '.env'), 'OPERATOR_SETTING=kept\n');
}

/** B as capture leaves it before preservation: the helpers, the predecessor record and the authority only. */
function capturedBackup(scope, name, { createdAt = nextCreatedAt() } = {}) {
    const backup = path.join(scope.backups, name);
    fs.mkdirSync(backup, { mode: 0o700 });
    write(path.join(backup, 'helpers/node-runtime-path'), '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64\n');
    for (const helper of ['rollback-explorer-qa.mjs', 'quiesce-explorer-qa.mjs', 'hold-workspace-lock.mjs']) {
        write(path.join(backup, 'helpers', helper), `// frozen ${helper}\n`);
    }
    write(path.join(backup, 'prior-containers.txt'), `podman|${P}|${BOX}\n`);
    write(path.join(backup, 'rollback-authority.json'), { version: 1, createdAt, backup });
    return backup;
}

/**
 * The state the failed run left (deploy run 39604707578): the preserving
 * redeploy moved the workspace into B, the real preservation block copied the
 * durable data back, the predecessor stays stopped as `<box>-rollback-B`, the
 * tail wrote the bootstrap `.env` and the `--no-checkout` runtime clone, and
 * the late commit check failed before Box preparation. The failure trap left
 * the stale `<B>-lock-release` beside B.
 */
function observedState(t, { originalEnv = false } = {}) {
    const { base, scope } = fixture(t);
    fs.rmSync(scope.workspace, { recursive: true });
    previousWorkspace(scope.workspace, { originalEnv });
    const older = abortedBackup(scope, 'redeploy-6j7c8WKq', { prior: OLD });
    write(`${older}-quiesce.log`, 'partial quiesce');
    write(path.join(scope.backups, 'userpersisto-rolegrant-20261019T123100Z.json'), 'operator file');
    const backup = capturedBackup(scope, B);
    runPreservation(base, scope, backup);
    write(path.join(backup, 'quiesce.log'), '{"result":"passed"}\n');
    write(path.join(backup, 'quiesce-source.mjs'), '// quiesce\n');
    write(`${backup}-lock-ready.json`, { held: true, pid: 4242, instance: BOX });
    write(`${backup}-lock.log`, '');
    write(`${backup}-lock-released.json`, { released: true, pid: 4242, instance: BOX });
    write(`${backup}-lock-release`, 'release\n');
    if (!originalEnv) write(path.join(scope.workspace, '.env'), `PLOINKY_MASTER_KEY=${'a'.repeat(64)}\n`);
    gitRepository(path.join(scope.workspace, '.runtime/ploinky'), 'https://github.com/AssistOS-AI/ploinky.git');
    const copied = JSON.parse(fs.readFileSync(path.join(backup, 'preservation.json'), 'utf8')).copied;
    return { base, scope, backup, copied };
}

function inProcessResume(args, hooks = {}) {
    assert.equal(args.length, 9);
    assert.deepEqual([args[0], args[1], args[3], args[5], args[7]], ['resume-proof', '--root', '--workspace', '--owner', '--backup']);
    try {
        const result = resumeProofPrivileged({ root: args[2], workspace: args[4], owner: Number(args[6]), backup: args[8], hooks });
        return { status: 0, stdout: JSON.stringify(result) + '\n' };
    } catch (error) {
        return { status: 1, stdout: JSON.stringify({ result: 'failed', code: error.code }) + '\n' };
    }
}

/** Route adapters: Git is real; the container listing, the privileged spawn and B's helper are injected. */
function router(scope, { containers = [RETAINED_P], lock = true, privileged = null, hooks = {}, plan = null } = {}) {
    const state = { calls: [], privileged: [], plans: [], git: [] };
    const production = retentionProductionAdapters(scope);
    const adapters = {
        assertHost() { state.calls.push('host'); },
        lockHeld() { state.calls.push('lock'); return lock; },
        getuid: () => uid,
        containers() { state.calls.push('containers'); return typeof containers === 'function' ? containers() : structuredClone(containers); },
        boxes() { throw new Error('the route never runs the full Box inspection'); },
        privilegedSource: () => 'privileged source text',
        runPrivileged(source, args) {
            assert.equal(source, 'privileged source text');
            state.privileged.push(args);
            return privileged ? privileged(args) : inProcessResume(args, hooks);
        },
        gitSource(directory) { state.git.push(directory); return production.gitSource(directory); },
        backupHelperPlan(backup) { state.plans.push(backup); return plan ? plan(backup) : planned(); },
    };
    return { adapters, state };
}

const route = (scope, adapters) => run(['route', '--lock-held'], adapters, scope);

function treeSnapshot(...tops) {
    const rows = [];
    for (const top of tops) {
        const stack = [top];
        while (stack.length) {
            const current = stack.pop();
            let stat;
            try { stat = fs.lstatSync(current); } catch { continue; }
            const row = [current, stat.mode, stat.ino, stat.size];
            if (stat.isFile()) {
                try { row.push(crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex')); } catch { row.push('unreadable'); }
            }
            if (stat.isSymbolicLink()) row.push(fs.readlinkSync(current));
            rows.push(row);
            if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
        }
    }
    return rows.sort((left, right) => left[0].localeCompare(right[0]));
}

test('inventoryBackups is the shared admin inventory: newest createdAt first, undated last, and no receipt is read', t => {
    const { scope } = fixture(t);
    const older = completeBackup(scope, 'redeploy-Older001');
    const newer = abortedBackup(scope, 'redeploy-Newer001');
    write(path.join(newer, 'workspace/.data/x'), 'moved');
    const undated = completeBackup(scope, 'redeploy-Undated1');
    write(path.join(undated, 'rollback-authority.json'), '{"createdAt":"yesterday"}');
    fs.chmodSync(path.join(older, 'preservation.json'), 0o000);
    const inventory = inventoryBackups({ getuid: () => uid }, scope);
    assert.deepEqual(inventory.map(item => [item.name, item.createdAt !== null, item.workspace, item.restoredSelections, item.marker]), [
        ['redeploy-Newer001', true, 'directory', false, false],
        ['redeploy-Older001', true, 'directory', true, false],
        ['redeploy-Undated1', false, 'directory', true, false],
    ]);
    assert.equal(inventory[1].priorRecord, `podman|${OLD}|${BOX}\n`);
    assert.equal(inventory[1].predecessorId, OLD);
});

test('AC6: an exact-name Box routes to select unless the newest backup is an unfinished redeploy', async t => {
    const present = [container(CUR, BOX, true), container(OLD, `${BOX}-rollback-redeploy-Older001`)];
    const cases = {
        'no backups': () => {},
        'newest complete': scope => { completeBackup(scope, 'redeploy-Older001', { prior: OLD }); },
        'newest fresh install (no workspace)': scope => { completeBackup(scope, 'redeploy-Older001'); freshInstallBackup(scope, 'redeploy-FreshIn1'); },
        'newest with a rollback marker': scope => {
            const dir = completeBackup(scope, 'redeploy-Older001');
            fs.rmSync(path.join(dir, 'restored-selections.json'));
            write(path.join(dir, 'rollback-result.json'), { result: 'recovered', phase: 'complete' });
        },
        'newest aborted before any stop': scope => { completeBackup(scope, 'redeploy-Older001'); abortedBackup(scope, 'redeploy-Aborted1'); },
    };
    for (const [label, setup] of Object.entries(cases)) {
        const { scope } = fixture(t);
        setup(scope);
        const { adapters, state } = router(scope, { containers: present });
        assert.deepEqual(await route(scope, adapters), { status: 0, output: SELECT }, label);
        assert.deepEqual([state.privileged, state.plans, state.git], [[], [], []], `${label}: the select route stays light`);
    }
    const unfinished = {
        'newest unfinished': scope => {
            completeBackup(scope, 'redeploy-Older001');
            const dir = completeBackup(scope, 'redeploy-Unfinsh1');
            fs.rmSync(path.join(dir, 'restored-selections.json'));
            return 'redeploy-Unfinsh1';
        },
        'tied newest, one unfinished': scope => {
            const createdAt = nextCreatedAt();
            completeBackup(scope, 'redeploy-Complet1', { createdAt });
            const dir = completeBackup(scope, 'redeploy-Unfinsh1', { createdAt });
            for (const name of ['policy-restoration.json', 'restored-selections.json']) fs.rmSync(path.join(dir, name));
            return 'redeploy-Unfinsh1';
        },
    };
    for (const [label, setup] of Object.entries(unfinished)) {
        const { scope } = fixture(t);
        const name = setup(scope);
        const { adapters, state } = router(scope, { containers: present });
        assert.deepEqual(await route(scope, adapters), { status: 1, output: { result: 'refused', code: 'QA_REDEPLOY_UNFINISHED',
            backup: name, reason: 'exact-box-present' } }, label);
        assert.deepEqual([state.privileged, state.plans], [[], []], label);
    }
});

test('AC6: without an exact-name Box every backup state other than the proven interrupted redeploy is refused', async t => {
    const refused = reason => ({ status: 1, output: { result: 'refused', code: 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE', ...reason } });
    const cases = [
        ['no backups', () => {}, { reason: 'no-backup' }],
        ['only undated backups', scope => write(path.join(completeBackup(scope, 'redeploy-Undated1'), 'rollback-authority.json'), '{}'),
            { reason: 'no-backup' }],
        ['newest complete', scope => completeBackup(scope, 'redeploy-Complet1'), { backup: 'redeploy-Complet1', reason: 'newest-complete' }],
        ['newest has no workspace', scope => freshInstallBackup(scope, 'redeploy-FreshIn1'), { backup: 'redeploy-FreshIn1', reason: 'newest-no-workspace' }],
        ['newest workspace is a file', scope => write(path.join(abortedBackup(scope, 'redeploy-FileWsp1'), 'workspace'), 'x'),
            { backup: 'redeploy-FileWsp1', reason: 'backup-workspace-invalid' }],
        ['rollback stopped mid-way', scope => {
            const dir = completeBackup(scope, 'redeploy-Halfway1');
            for (const name of ['policy-restoration.json', 'restored-selections.json']) fs.rmSync(path.join(dir, name));
            write(path.join(dir, 'rollback-result.json'), { result: 'failed', phase: 'copying-durable-state' });
        }, { backup: 'redeploy-Halfway1', reason: 'rollback-state' }],
        ['createdAt tie', scope => {
            const createdAt = nextCreatedAt();
            for (const name of ['redeploy-TieAAAA1', 'redeploy-TieBBBB1']) {
                const dir = completeBackup(scope, name, { createdAt });
                for (const file of ['policy-restoration.json', 'restored-selections.json']) fs.rmSync(path.join(dir, file));
            }
        }, { reason: 'created-at-tie' }],
    ];
    for (const [label, setup, reason] of cases) {
        const { scope } = fixture(t);
        setup(scope);
        const { adapters, state } = router(scope);
        assert.deepEqual(await route(scope, adapters), refused(reason), label);
        assert.deepEqual([state.privileged, state.plans], [[], []], label);
    }
});

test('AC6: a running retained Box is refused whether or not the exact Box exists', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Complet1');
    for (const containers of [[container(CUR, BOX, true), container(OLD, `${BOX}-rollback-redeploy-Complet1`, true)],
        [container(OLD, `${BOX}-failed-redeploy-Complet1`, true)]]) {
        const { adapters } = router(scope, { containers });
        assert.deepEqual(await route(scope, adapters), { status: 1, output: { result: 'refused', code: 'QA_RETAINED_BOX_RUNNING' } });
    }
});

test('AC6: route needs the held lock and its exact usage, and an engine probe failure exits 1', async t => {
    const { scope } = fixture(t);
    completeBackup(scope, 'redeploy-Complet1');
    const locked = router(scope, { lock: false });
    assert.deepEqual(await route(scope, locked.adapters), { status: 1, output: { result: 'refused', code: 'QA_BACKUPS_HOST_LOCK_REQUIRED' } });
    assert.deepEqual(locked.state.calls, ['host', 'lock'], 'nothing is listed without the lock');
    const untouchable = new Proxy({}, { get() { throw new Error('no adapter may run for a usage error'); } });
    for (const argv of [['route'], ['route', '--lock-held', 'extra'], ['route', '--lock']]) {
        assert.deepEqual(await run(argv, untouchable, scope), { status: 1, output: { result: 'refused', code: 'QA_BACKUPS_USAGE_INVALID' } });
    }
    const failing = router(scope, { containers: () => { throw Object.assign(new Error('x'), { code: 'QA_ENGINE_PROBE_FAILED' }); } });
    assert.deepEqual(await route(scope, failing.adapters), { status: 1, output: { result: 'refused', code: 'QA_ENGINE_PROBE_FAILED' } });
    for (const malformed of [null, [{ engine: 'podman', id: 'short', name: BOX, running: true, labels: {} }],
        [{ engine: 'podman', id: CUR, name: BOX, running: 'true', labels: {} }]]) {
        const { adapters } = router(scope, { containers: () => malformed });
        assert.deepEqual(await route(scope, adapters), { status: 1, output: { result: 'refused', code: 'QA_ENGINE_PROBE_FAILED' } });
    }
    const raw = router(scope, { containers: () => { throw new Error('raw /secret/path'); } });
    assert.deepEqual(await route(scope, raw.adapters), { status: 1, output: { result: 'refused', code: 'QA_BACKUPS_REJECTED' } });
});

test('AC7 positive: the observed interrupted redeploy resumes; copied comes from the real preservation block', async t => {
    const { scope, backup, copied } = observedState(t);
    // I1: copied holds multi-segment entries; .ploinky/data itself is created, never copied.
    for (const entry of ['.data', 'test1.backlog', 'testN2', 'WebMeet', '.ploinky/data/master-key', '.ploinky/data/.secrets',
        '.ploinky/data/passwords.enc', '.ploinky/data/ploinky_subject_identity_ed25519_v1.enc', '.ploinky/data/sso-provider.json',
        '.ploinky/edge-desired.json', '.ploinky/profile']) assert(copied.includes(entry), entry);
    for (const entry of ['.ploinky', '.ploinky/data', '.ploinky/data/edge-routing', '.ploinky/data/router-security', '.ploinky/agents.json',
        '.ploinky/box', '.runtime', 'AdvancedLanguageAgent', '.env']) assert(!copied.includes(entry), entry);
    assert.deepEqual(fs.readdirSync(scope.workspace).sort(), ['.data', '.env', '.ploinky', '.runtime', 'WebMeet', 'test1.backlog', 'testN2']);
    const before = treeSnapshot(scope.workspace, scope.backups);
    const { adapters, state } = router(scope);
    assert.deepEqual(await route(scope, adapters), { status: 0, output: RESUMED });
    assert.deepEqual(state.privileged, [['resume-proof', '--root', scope.backups, '--workspace', scope.workspace, '--owner', String(uid), '--backup', B]]);
    assert.deepEqual(state.plans, [backup]);
    assert.deepEqual(state.git, [path.join(scope.workspace, '.runtime/ploinky')]);
    assert.deepEqual(treeSnapshot(scope.workspace, scope.backups), before, 'the route and the resume proof change nothing');
    // The CLI line is exactly the contract-2 shape.
    assert.equal(JSON.stringify((await route(scope, router(scope).adapters)).output),
        `{"result":"routed","route":"resume","backup":"${B}","predecessorId":"${P}","engine":"podman"}`);
});

test('AC7 positive: an operator .env preserved from the previous workspace is admitted as copied', async t => {
    const { scope, copied } = observedState(t, { originalEnv: true });
    assert(copied.includes('.env'));
    assert.equal(fs.readFileSync(path.join(scope.workspace, '.env'), 'utf8'), 'OPERATOR_SETTING=kept\n');
    assert.deepEqual(await route(scope, router(scope).adapters), { status: 0, output: RESUMED });
});

test('AC7: one failing fixture per resume proof R2 to R8, each refused with its code and nothing changed', async t => {
    const refusal = (reason, code = 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE') => ({ result: 'refused', code, backup: B, reason });
    const graph = relative => refusal(`unexpected-entry:${relative}`, 'QA_RESUME_GRAPH_STARTED');
    const inWorkspace = (scope, relative) => path.join(scope.workspace, relative);
    const cases = [
        // R2
        ['R2: the workspace is a link', { mutate: ({ base, scope }) => {
            fs.renameSync(scope.workspace, path.join(base, 'moved-workspace'));
            fs.symlinkSync(path.join(base, 'moved-workspace'), scope.workspace);
        } }, refusal('workspace-invalid'), 'none'],
        // R3
        ['R3: a QA-labelled container runs', { containers: [RETAINED_P, container(OTHER, 'ploinky-box-explorerqaworkspace-other', true)] },
            refusal('qa-container-running'), 'none'],
        ['R3: a labelled container that is not a retained Box', { containers: [RETAINED_P, container(OTHER, `${BOX}-manual-copy`)] },
            refusal('unexpected-qa-container'), 'none'],
        // R4
        ['R4: a helper is missing', { mutate: ({ backup }) => fs.rmSync(path.join(backup, 'helpers/rollback-explorer-qa.mjs')) },
            refusal('helpers-invalid'), 'none'],
        ['R4: prior-containers.txt with a trailing space', { mutate: ({ backup }) => write(path.join(backup, 'prior-containers.txt'),
            `podman|${P}|${BOX} \n`) }, refusal('prior-record-mismatch'), 'none'],
        ['R4: prior-containers.txt with an uppercase ID', { mutate: ({ backup }) => write(path.join(backup, 'prior-containers.txt'),
            `podman|${P.toUpperCase()}|${BOX}\n`) }, refusal('prior-record-mismatch'), 'none'],
        ['R4: prior-containers.txt without its newline', { mutate: ({ backup }) => write(path.join(backup, 'prior-containers.txt'),
            `podman|${P}|${BOX}`) }, refusal('prior-record-mismatch'), 'none'],
        ['R4: quiesce-source.mjs is missing', { mutate: ({ backup }) => fs.rmSync(path.join(backup, 'quiesce-source.mjs')) },
            refusal('quiesce-source-missing'), 'none'],
        ['R4: policy-restoration.json is present', { mutate: ({ backup }) => write(path.join(backup, 'policy-restoration.json'),
            { copied: [], exactCopiesVerified: true }) }, refusal('policy-restoration-present'), 'none'],
        // R5
        ['R5: the -rollback-B Box was removed by hand', { containers: [] }, refusal('rollback-box-missing'), 'none'],
        ['R5: the -rollback-B Box runs', { containers: [container(P, `${BOX}-rollback-${B}`, true)] },
            { result: 'refused', code: 'QA_RETAINED_BOX_RUNNING' }, 'none'],
        ['R5: the -rollback-B Box has another ID', { containers: [container(OTHER, `${BOX}-rollback-${B}`)] },
            refusal('rollback-box-mismatch'), 'none'],
        ['R5: the -rollback-B Box is in the other engine', { containers: [container(P, `${BOX}-rollback-${B}`, false, { engine: 'docker' })] },
            refusal('rollback-box-mismatch'), 'none'],
        // R6
        ['R6: preservation.json is not verified', { mutate: ({ backup, scope }) => {
            const file = path.join(backup, 'preservation.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
            write(file, { ...value, exactCopiesVerified: false, target: scope.workspace });
        } }, refusal('preservation-invalid'), 'privileged'],
        ['R6: preservation.json names another target', { mutate: ({ backup, base }) => {
            const file = path.join(backup, 'preservation.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
            write(file, { ...value, target: path.join(base, 'elsewhere') });
        } }, refusal('preservation-invalid'), 'privileged'],
        ['R6: an identity file differs', { mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/data/master-key'), `${'f'.repeat(64)}\n`) },
            refusal('identity-changed'), 'privileged'],
        ['R6: an identity file is missing', { mutate: ({ scope }) => fs.rmSync(inWorkspace(scope, '.ploinky/data/passwords.enc')) },
            refusal('identity-changed'), 'privileged'],
        ['R6 with N7: a copied entry is gone', { mutate: ({ scope }) => fs.rmSync(inWorkspace(scope, 'testN2'), { recursive: true }) },
            refusal('copied-entry-missing'), 'privileged'],
        ['R6 with N7: a copied entry changed type', { mutate: ({ scope }) => {
            fs.rmSync(inWorkspace(scope, 'test1.backlog'));
            fs.mkdirSync(inWorkspace(scope, 'test1.backlog'));
        } }, refusal('copied-entry-missing'), 'privileged'],
        ['R6: the backup workspace is the live directory', { hooks: { lstat(file, stat) {
            if (!file.endsWith(`${B}/workspace`)) return stat;
            const live = fs.lstatSync(file.replace(/\/[^/]+\/[^/]+\/workspace$/, '/workspace'), { bigint: true });
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: live.dev, ino: live.ino });
        } } }, refusal('backup-workspace-invalid'), 'privileged'],
        ['R6: sudo -n fails', { privileged: () => ({ status: 1, stdout: 'sudo: a password is required\n' }) },
            refusal('resume-proof-failed'), 'privileged'],
        ['R6: the privileged process could not start', { privileged: () => ({ status: null, error: true, stdout: '' }) },
            refusal('resume-proof-failed'), 'privileged'],
        ['R6: the privileged line is not the proof', { privileged: () => ({ status: 0, stdout: '{"result":"proved","backup":"redeploy-jQRMF7aJ"}\n' }) },
            refusal('proof-output-invalid'), 'privileged'],
        // R7
        ['R7: the B helper plan prints no JSON', { plan: () => ({ status: 0, stdout: 'not json\n' }) }, refusal('helper-plan-refused'), 'plan'],
        ['R7: the B helper plan fails', { plan: () => ({ status: 1, stdout: '{"result":"failed","code":"QA_PREVIOUS_SOURCES_CHANGED"}\n' }) },
            refusal('helper-plan-refused'), 'plan'],
        ['R7: the B helper plans another predecessor', { plan: () => planned(OLD) }, refusal('helper-plan-refused'), 'plan'],
        ['R7: the B helper sees a current Box', { plan: () => planned(P, { currentId: CUR }) }, refusal('helper-plan-refused'), 'plan'],
        ['R7: the B helper prints two lines', { plan: () => ({ status: 0, stdout: planned().stdout + planned().stdout }) },
            refusal('helper-plan-refused'), 'plan'],
        ['R7: the B Node runtime is not admitted', { plan: () => { throw Object.assign(new Error('x'), { code: 'QA_RESUME_HELPER_RUNTIME_INVALID' }); } },
            refusal('helper-runtime-invalid'), 'plan'],
        // R8
        ['R8: .ploinky/agents.json is present', { mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/agents.json'), '{}') },
            graph('.ploinky/agents.json'), 'privileged'],
        ['R8: .ploinky/repos is present', { mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/repos/AchillesIDE/x'), 'x') },
            graph('.ploinky/repos'), 'privileged'],
        ['R8: .ploinky/box/other is present', { mutate: ({ scope }) => fs.mkdirSync(inWorkspace(scope, '.ploinky/box/other'), { recursive: true }) },
            graph('.ploinky/box/other'), 'privileged'],
        ['R8: edge routing state exists', { mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/data/edge-routing/g.json'), '{}') },
            graph('.ploinky/data/edge-routing'), 'privileged'],
        ['R8: an unknown .ploinky/data entry', { mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/data/new-secret'), 'x') },
            graph('.ploinky/data/new-secret'), 'privileged'],
        ['R8: .runtime holds another entry', { mutate: ({ scope }) => write(inWorkspace(scope, '.runtime/other'), 'x') },
            graph('.runtime/other'), 'privileged'],
        ['R8: an unknown top-level entry', { mutate: ({ scope }) => write(inWorkspace(scope, 'started.flag'), 'x') },
            graph('started.flag'), 'privileged'],
        ['R8 with N6: a .env that is not the bootstrap form', { mutate: ({ scope }) => write(inWorkspace(scope, '.env'), 'PLOINKY_MASTER_KEY=short\n') },
            graph('.env'), 'privileged'],
        ['R8 with N6: a bootstrap-sized .env with a non-hex key', { mutate: ({ scope }) => write(inWorkspace(scope, '.env'),
            `PLOINKY_MASTER_KEY=${'g'.repeat(64)}\n`) }, graph('.env'), 'privileged'],
        ['R8 with N6: the backup had a .env that was not copied', { mutate: ({ backup }) => write(path.join(backup, 'workspace/.env'),
            'OPERATOR_SETTING=kept\n') }, graph('.env'), 'privileged'],
        ['R8: edge state is refused even if a receipt listed it as copied', {
            mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/data/edge-routing/g.json'), '{}'),
            privileged: args => {
                const proof = JSON.parse(inProcessResume(args).stdout);
                return { status: 0, stdout: JSON.stringify({ ...proof, copied: [...proof.copied, '.ploinky/data/edge-routing'] }) + '\n' };
            } }, graph('.ploinky/data/edge-routing'), 'privileged'],
        ['R8: ALA with a foreign origin', { mutate: ({ scope }) => gitRepository(inWorkspace(scope, 'AdvancedLanguageAgent'),
            'https://github.com/someone-else/AdvancedLanguageAgent.git') }, refusal('managed-source-invalid'), 'privileged'],
        ['R8: the runtime clone has a foreign origin', { mutate: ({ scope }) => {
            fs.rmSync(inWorkspace(scope, '.runtime/ploinky'), { recursive: true });
            gitRepository(inWorkspace(scope, '.runtime/ploinky'), 'https://github.com/AssistOS-AI/ploinky-fork.git');
        } }, refusal('managed-source-invalid'), 'privileged'],
        ['R8: the runtime clone is not a repository', { mutate: ({ scope }) => {
            fs.rmSync(inWorkspace(scope, '.runtime/ploinky/.git'), { recursive: true });
            write(inWorkspace(scope, '.runtime/ploinky/.git'), 'gitdir: /elsewhere\n');
        } }, refusal('managed-source-invalid'), 'privileged'],
        ['R8: .ploinky/box is a file', { mutate: ({ scope }) => write(inWorkspace(scope, '.ploinky/box'), 'x') },
            refusal('unexpected-type'), 'privileged'],
    ];
    for (const [label, options, expected, reached] of cases) {
        const context = observedState(t);
        if (options.mutate) options.mutate(context);
        const before = treeSnapshot(context.scope.workspace, context.scope.backups);
        const { adapters, state } = router(context.scope, options);
        assert.deepEqual(await route(context.scope, adapters), { status: 1, output: expected }, label);
        assert.deepEqual(treeSnapshot(context.scope.workspace, context.scope.backups), before, `${label}: nothing changed`);
        assert.equal(state.privileged.length, reached === 'none' ? 0 : 1, `${label}: privileged spawns`);
        assert.equal(state.plans.length, reached === 'plan' ? 1 : 0, `${label}: B's helper runs only after every other proof`);
    }
});

test('AC7 root-only simulation: an admin-unreadable preservation receipt is read only by the privileged side',
    { skip: asRoot && 'root reads mode 000 files, so this test would pass vacuously' }, async t => {
        const { scope, backup } = observedState(t);
        const receipt = path.join(backup, 'preservation.json');
        fs.chmodSync(receipt, 0o000);
        assert.throws(() => fs.readFileSync(receipt), { code: 'EACCES' });
        const unprivileged = router(scope);
        assert.deepEqual(await route(scope, unprivileged.adapters), { status: 1, output: { result: 'refused',
            code: 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE', backup: B, reason: 'preservation-invalid' } }, 'without root the receipt cannot be proven');
        const reads = [];
        const asRootHook = { beforeRead(file) { reads.push(path.relative(backup, file)); if (file === receipt) fs.chmodSync(file, 0o600); } };
        assert.deepEqual(await route(scope, router(scope, { hooks: asRootHook }).adapters), { status: 0, output: RESUMED });
        assert.equal(reads[0], 'preservation.json');
        fs.chmodSync(receipt, 0o600);
        const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        write(receipt, { ...value, exactCopiesVerified: false });
        fs.chmodSync(receipt, 0o000);
        const unverified = router(scope, { hooks: { beforeRead(file) { if (file === receipt) fs.chmodSync(file, 0o600); } } });
        assert.deepEqual(await route(scope, unverified.adapters), { status: 1, output: { result: 'refused',
            code: 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE', backup: B, reason: 'preservation-invalid' } });
        assert.deepEqual(unverified.state.plans, []);
    });

test('probe: a resume whose own tail failed in Box preparation routes to resume again, keeping everything', async t => {
    const { scope, backup } = observedState(t);
    // The resume setup archived the stale receipts, its own tail then moved its new receipts into B.
    const archive = path.join(backup, 'helpers/interrupted-20261021T140000Z');
    fs.mkdirSync(archive, { mode: 0o700 });
    for (const suffix of ['lock-ready.json', 'lock-released.json', 'lock-release', 'lock.log']) {
        fs.renameSync(`${backup}-${suffix}`, path.join(archive, suffix));
        write(path.join(backup, suffix), 'resumed run receipt\n');
    }
    // The tail checked out Ploinky, cloned ALA, rewrote the edge intent and prepared the Box data directories.
    fs.rmSync(path.join(scope.workspace, '.runtime/ploinky'), { recursive: true });
    gitRepository(path.join(scope.workspace, '.runtime/ploinky'), 'https://github.com/AssistOS-AI/ploinky.git', { checkout: true });
    gitRepository(path.join(scope.workspace, 'AdvancedLanguageAgent'), 'https://github.com/AssistOS-AI/AdvancedLanguageAgent', { checkout: true });
    write(path.join(scope.workspace, '.ploinky/edge-desired.json'), '{"hosts":{"explorer-qa.axiologic.dev":{}}}\n');
    for (const name of ['dependencies', 'images']) fs.mkdirSync(path.join(scope.workspace, '.ploinky/box', name), { recursive: true, mode: 0o700 });
    const before = treeSnapshot(scope.workspace, scope.backups);
    const { adapters, state } = router(scope);
    assert.deepEqual(await route(scope, adapters), { status: 0, output: RESUMED });
    assert.deepEqual(state.git.sort(), [path.join(scope.workspace, '.runtime/ploinky'), path.join(scope.workspace, 'AdvancedLanguageAgent')].sort());
    assert.deepEqual(treeSnapshot(scope.workspace, scope.backups), before);
});

test('probe: a newer backup of any kind, or a tie with B, refuses the resume instead of skipping to B', async t => {
    const newer = observedState(t);
    abortedBackup(newer.scope, 'redeploy-NewerAb1');
    assert.deepEqual(await route(newer.scope, router(newer.scope).adapters), { status: 1, output: { result: 'refused',
        code: 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE', backup: 'redeploy-NewerAb1', reason: 'newest-no-workspace' } });
    const tie = observedState(t);
    const { createdAt } = JSON.parse(fs.readFileSync(path.join(tie.backup, 'rollback-authority.json'), 'utf8'));
    capturedBackup(tie.scope, 'redeploy-TwinAAA1', { createdAt });
    write(path.join(tie.scope.backups, 'redeploy-TwinAAA1/workspace/.data/x'), 'second unfinished copy');
    assert.deepEqual(await route(tie.scope, router(tie.scope).adapters), { status: 1, output: { result: 'refused',
        code: 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE', reason: 'created-at-tie' } });
    const present = router(tie.scope, { containers: [container(CUR, BOX, true), RETAINED_P] });
    assert.equal((await route(tie.scope, present.adapters)).output.code, 'QA_REDEPLOY_UNFINISHED');
});

test('AC12: B stays the retained rollback point through a resumed tail and becomes complete-redeploy after both markers', async t => {
    const { scope, backup } = observedState(t);
    const boxes = [box(FRESH, BOX, true), box(P, `${BOX}-rollback-${B}`)];
    const classify = () => prunePrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid,
        hooks: { afterRename() { throw Object.assign(new Error('classified only'), { code: 'QA_TEST_CLASSIFIED' }); } } });
    // The resumed tail created the new Box and restored the policy, but not yet the prior selections.
    write(path.join(backup, 'policy-restoration.json'), { copied: [], exactCopiesVerified: true, compiledGenerationsRestored: false });
    const incomplete = classify();
    assert.deepEqual(incomplete.retained.find(item => item.name === B), { name: B, class: 'incomplete-redeploy' });
    assert.deepEqual(incomplete.removed, []);
    const target = await rollbackTarget(scope, admin(scope, { boxes }).adapters);
    assert.deepEqual([target.status, target.output.backup, target.output.currentId, target.output.predecessorId], [0, B, FRESH, P]);
    const exact = router(scope, { containers: [container(FRESH, BOX, true), RETAINED_P] });
    assert.deepEqual((await route(scope, exact.adapters)).output, { result: 'refused', code: 'QA_REDEPLOY_UNFINISHED', backup: B, reason: 'exact-box-present' });
    // Both markers written: complete, still the rollback target, and the next deploy routes to select.
    write(path.join(backup, 'restored-selections.json'), { counts: {}, boxId: FRESH });
    assert.throws(classify, { code: 'QA_TEST_CLASSIFIED' }, 'a complete-redeploy is prunable, so the classification reaches the rename');
    fs.renameSync(path.join(scope.backups, `.pruning-${B}`), backup);
    const complete = await rollbackTarget(scope, admin(scope, { boxes }).adapters);
    assert.deepEqual([complete.status, complete.output.backup, complete.output.currentId], [0, B, FRESH]);
    assert.deepEqual((await route(scope, exact.adapters)).output, SELECT);
    // Retention removes B only behind the next run's own health gate.
    const unhealthy = await prune(scope, admin(scope, { boxes: [box(FRESH, BOX, false), box(P, `${BOX}-rollback-${B}`)] }).adapters, FRESH);
    assert.equal(unhealthy.output.result, 'skipped');
    assert(exists(backup));
});

test('RESUME_REGENERABLE lists exactly what the Reconcile tail writes before the new Box exists', () => {
    assert.deepEqual([...RESUME_REGENERABLE], ['.env', '.runtime/ploinky', 'AdvancedLanguageAgent', '.ploinky/edge-desired.json',
        '.ploinky/box/dependencies', '.ploinky/box/images']);
    assert(Object.isFrozen(RESUME_REGENERABLE));
    const workflow = fs.readFileSync(WORKFLOW, 'utf8');
    for (const literal of ['RUNTIME_DIR="$WORK_DIR/.runtime/ploinky"', 'ALA_DIR="$WORK_DIR/AdvancedLanguageAgent"',
        'EDGE_DESIRED_FILE="$WORK_DIR/.ploinky/edge-desired.json"', 'node --input-type=module - "$WORK_DIR/.env" <<\'NODE\'',
        'const content = `PLOINKY_MASTER_KEY=${key}\\n`;', 'if (!/^[A-Fa-f0-9]{64}$/.test(key)) {',
        "path.join(target, '.ploinky/box/dependencies')", "path.join(target, '.ploinky/box/images')"]) {
        assert(workflow.includes(literal), literal);
    }
    const source = fs.readFileSync(new URL('../../../.github/scripts/qa-backups.mjs', import.meta.url), 'utf8');
    assert.match(source, /ploinky-box\/workspace-data\.mjs:233-270/, 'the Ploinky source of the Box data directories is cited');
});

test('the admin and privileged copied-entry validators agree, and the resume-proof parse is strict', () => {
    const samples = ['.data', 'testN2', '.ploinky/data/master-key', 'test doc.docx', '', '/abs', '../up', 'a/../b', 'a//b', 'a/', './a',
        'a/./b', 'line\nbreak', 'x'.repeat(4097), 42, null];
    for (const sample of samples) assert.equal(isCopiedEntry(sample), privilegedModule.isCopiedEntry(sample), JSON.stringify(sample));
    assert.deepEqual(samples.filter(isCopiedEntry), ['.data', 'testN2', '.ploinky/data/master-key', 'test doc.docx']);
    const good = JSON.stringify({ result: 'proved', backup: B, copied: ['.data'] });
    assert.deepEqual(parseResumeProof(`${good}\n`, B).copied, ['.data']);
    for (const stdout of [`${good}\n${good}\n`, '[sudo] password', JSON.stringify({ result: 'proved', backup: B, copied: ['.data'], extra: 1 }),
        JSON.stringify({ result: 'proved', backup: 'redeploy-Other001', copied: [] }), JSON.stringify({ result: 'proved', backup: B, copied: ['../x'] }),
        JSON.stringify({ result: 'proved', backup: B, copied: ['.data', '.data'] })]) {
        assert.throws(() => parseResumeProof(stdout, B), { code: 'QA_RESUME_PROOF_OUTPUT_INVALID' }, stdout);
    }
    assert.equal(acceptedBackupPlan(planned(), P), true);
    for (const run of [null, { ...planned(), status: 1 }, { ...planned(), error: true }, planned(P, { mutations: true }), planned(P, { result: 'failed' })]) {
        assert.equal(acceptedBackupPlan(run, P), false);
    }
});

test('R7 command: the backup helper runs with the backup Node admitted as rollback-explorer-qa.yml admits it', t => {
    const { scope } = fixture(t);
    const backup = capturedBackup(scope, B);
    assert.deepEqual(backupHelperCommand(backup, scope), { node: '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64/bin/node',
        args: [path.join(backup, 'helpers/rollback-explorer-qa.mjs'), 'plan', backup, '--current-id', 'absent', '--lock-held'] });
    for (const runtime of ['/usr/bin\n', '/home/admin/.qa-deployment-tools/node-v20.20.0-linux-x64\n',
        '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64\n\n', '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64/../evil\n']) {
        write(path.join(backup, 'helpers/node-runtime-path'), runtime);
        assert.throws(() => backupHelperCommand(backup, scope), { code: 'QA_RESUME_HELPER_RUNTIME_INVALID' }, runtime);
    }
    fs.rmSync(path.join(backup, 'helpers/rollback-explorer-qa.mjs'));
    fs.symlinkSync('/etc/hosts', path.join(backup, 'helpers/rollback-explorer-qa.mjs'));
    assert.throws(() => backupHelperCommand(backup, scope), { code: 'QA_RESUME_HELPER_INVALID' });
    assert.throws(() => backupHelperCommand(path.join(scope.base || os.tmpdir(), B), scope), { code: 'QA_RESUME_HELPER_INVALID' });
    const production = retentionProductionAdapters(scope);
    if (!fs.existsSync('/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64/bin/node')) {
        write(path.join(backup, 'helpers/node-runtime-path'), '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64\n');
        fs.rmSync(path.join(backup, 'helpers/rollback-explorer-qa.mjs'));
        write(path.join(backup, 'helpers/rollback-explorer-qa.mjs'), '// frozen helper\n');
        assert.throws(() => production.backupHelperPlan(backup), { code: 'QA_RESUME_HELPER_RUNTIME_INVALID' });
    }
});

test('production route adapters: the container listing is light, an engine failure throws, and Git reads only the origin', async t => {
    const { base, scope } = fixture(t);
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const record = path.join(base, 'podman.args');
    const rows = JSON.stringify([{ Id: CUR, Name: BOX, State: { Running: true }, Config: { Labels: { [HASH_LABEL]: QA_SCOPE.hash } } },
        { Id: OLD, Name: `/${BOX}-rollback-${B}`, State: { Running: false }, Config: { Labels: null } }]);
    const podman = mode => fs.writeFileSync(path.join(bin, 'podman'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n`
        + (mode === 'fail' ? 'exit 3\n' : `case "$2" in ls) printf '%s\\n%s\\n' ${CUR} ${OLD} ;; inspect) printf '%s' '${rows}' ;; *) exit 9 ;; esac\n`),
    { mode: 0o700 });
    // A Docker that lists no container stands in for any real Docker on the test host.
    const dockerRecord = path.join(base, 'docker.args');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dockerRecord}'\n`, { mode: 0o700 });
    const savedPath = process.env.PATH;
    // Only the stub engines are reachable; any real podman or docker on this host is not.
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    try {
        const adapters = retentionProductionAdapters(scope);
        podman('ok');
        assert.deepEqual(adapters.containers(), [
            { engine: 'podman', id: CUR, name: BOX, running: true, labels: { [HASH_LABEL]: QA_SCOPE.hash } },
            { engine: 'podman', id: OLD, name: `${BOX}-rollback-${B}`, running: false, labels: {} },
        ]);
        assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), ['container ls -aq --no-trunc', `container inspect ${CUR} ${OLD}`],
            'no image inspection and no exec');
        assert.deepEqual(fs.readFileSync(dockerRecord, 'utf8').trim().split('\n'), ['container ls -aq --no-trunc']);
        podman('fail');
        assert.throws(() => adapters.containers(), { code: 'QA_ENGINE_PROBE_FAILED' });
        const repository = path.join(base, 'clone');
        gitRepository(repository, 'https://github.com/AssistOS-AI/ploinky.git');
        assert.deepEqual(adapters.gitSource(repository), { toplevel: repository, origin: 'https://github.com/AssistOS-AI/ploinky.git' });
        fs.mkdirSync(path.join(base, 'plain'));
        assert.equal(adapters.gitSource(path.join(base, 'plain')), null);
    } finally { process.env.PATH = savedPath; }
});

test('the privileged resume-proof loads from stdin, refuses unpinned paths or a non-root user, and never prints removal fields', t => {
    const { scope } = fixture(t);
    const source = fs.readFileSync(PRIVILEGED_FILE, 'utf8');
    const spawn = argv => {
        const result = spawnSync(process.execPath, ['--input-type=module', '-', ...argv], { input: source, encoding: 'utf8', cwd: os.tmpdir() });
        return { status: result.status, output: JSON.parse(result.stdout) };
    };
    const pinned = ['--root', '/home/admin/.qa-deployment-backups', '--workspace', '/home/admin/explorerQaWorkspace', '--owner', String(Math.max(uid, 1))];
    assert.deepEqual(spawn(['resume-proof', '--root', scope.backups, '--workspace', scope.workspace, '--owner', String(Math.max(uid, 1)), '--backup', B]),
        { status: 1, output: { result: 'failed', code: 'QA_PRIVILEGED_USAGE_INVALID' } });
    for (const argv of [['resume-proof', ...pinned], ['resume-proof', ...pinned, '--backup', 'redeploy-short'],
        ['resume-proof', ...pinned, '--backup', B, 'extra'], ['resume-proof', ...pinned.slice(0, 5), '0', '--backup', B]]) {
        assert.deepEqual(spawn(argv), { status: 1, output: { result: 'failed', code: 'QA_PRIVILEGED_USAGE_INVALID' } }, argv.join(' '));
    }
    if (!asRoot) {
        assert.deepEqual(spawn(['resume-proof', ...pinned, '--backup', B]), { status: 1, output: { result: 'failed', code: 'QA_PRIVILEGED_ROOT_REQUIRED' } });
    }
});

test('the privileged resume proof is read-only and checks the backup and live workspace identities', t => {
    const { scope, backup, copied } = observedState(t);
    const before = treeSnapshot(scope.workspace, scope.backups);
    const proof = resumeProofPrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, backup: B });
    assert.deepEqual(proof, { result: 'proved', backup: B, copied });
    assert.deepEqual(treeSnapshot(scope.workspace, scope.backups), before);
    for (const [label, options, code] of [
        ['usage', { backup: 'redeploy-short' }, 'QA_PRIVILEGED_USAGE_INVALID'],
        ['owner', { owner: uid + 1 }, 'QA_PRIVILEGED_ROOT_INVALID'],
        ['absent backup', { backup: 'redeploy-AbsentB1' }, 'QA_RESUME_BACKUP_INVALID'],
    ]) {
        assert.throws(() => resumeProofPrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, backup: B, ...options }), { code }, label);
    }
    fs.chmodSync(backup, 0o755);
    assert.throws(() => resumeProofPrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, backup: B }), { code: 'QA_RESUME_BACKUP_INVALID' });
    fs.chmodSync(backup, 0o700);
    // A live parent replaced by a link is never followed.
    const data = path.join(scope.workspace, '.ploinky/data');
    fs.renameSync(data, path.join(scope.workspace, '.ploinky/data-moved'));
    fs.symlinkSync(path.join(scope.workspace, '.ploinky/data-moved'), data);
    assert.throws(() => resumeProofPrivileged({ root: scope.backups, workspace: scope.workspace, owner: uid, backup: B }), { code: 'QA_RESUME_IDENTITY_CHANGED' });
});

// Opt-in only (QA_BACKUPS_ROOT_FIXTURE=1, as root, on Linux, in a disposable container): it builds
// /home/admin and refuses to run when that directory already exists, so it can never touch a real host.
const ROOT_FIXTURE = process.env.QA_BACKUPS_ROOT_FIXTURE === '1' && asRoot && process.platform === 'linux';
test('root: the real preservation block and the stdin resume-proof under the pinned /home/admin paths', {
    skip: !ROOT_FIXTURE && 'opt-in: QA_BACKUPS_ROOT_FIXTURE=1 as root in a disposable Linux container' }, t => {
    assert(!fs.existsSync('/home/admin'), '/home/admin already exists; refusing to build the root fixture here');
    t.after(() => fs.rmSync('/home/admin', { recursive: true, force: true }));
    const owner = 1000;
    const scope = { ...QA_SCOPE };
    fs.mkdirSync('/home/admin', { mode: 0o755 });
    fs.mkdirSync(scope.backups, { mode: 0o700 });
    previousWorkspace(scope.workspace);
    const backup = capturedBackup(scope, B);
    const chownTree = top => {
        fs.chownSync(top, owner, owner);
        const stack = [top];
        while (stack.length) {
            const current = stack.pop();
            for (const name of fs.readdirSync(current)) {
                const child = path.join(current, name), stat = fs.lstatSync(child);
                fs.lchownSync(child, owner, owner);
                if (stat.isDirectory()) stack.push(child);
            }
        }
    };
    for (const top of ['/home/admin', scope.workspace, scope.backups]) chownTree(top);
    // Unmodified: as root the block's own pinned-path and uid-0 assertions hold.
    const preserved = spawnSync(process.execPath, ['--input-type=module', '-', scope.workspace, backup], { encoding: 'utf8',
        input: preservationSource({ target: scope.workspace }) });
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(fs.lstatSync(path.join(backup, 'preservation.json')).uid, 0, 'the receipt is root-owned');
    write(path.join(backup, 'quiesce-source.mjs'), '// quiesce\n');
    write(path.join(scope.workspace, '.env'), `PLOINKY_MASTER_KEY=${'a'.repeat(64)}\n`);
    gitRepository(path.join(scope.workspace, '.runtime/ploinky'), 'https://github.com/AssistOS-AI/ploinky.git');
    for (const top of [scope.workspace]) chownTree(top);
    fs.chownSync(path.join(backup, 'quiesce-source.mjs'), owner, owner);
    const copied = JSON.parse(fs.readFileSync(path.join(backup, 'preservation.json'), 'utf8')).copied;
    const source = fs.readFileSync(PRIVILEGED_FILE, 'utf8');
    const argv = ['--input-type=module', '-', 'resume-proof', '--root', scope.backups, '--workspace', scope.workspace,
        '--owner', String(owner), '--backup', B];
    const before = treeSnapshot('/home/admin');
    const proved = spawnSync(process.execPath, argv, { input: source, encoding: 'utf8', cwd: '/' });
    assert.equal(proved.status, 0, proved.stdout + proved.stderr);
    assert.deepEqual(JSON.parse(proved.stdout), { result: 'proved', backup: B, copied });
    assert.equal(proved.stdout.split('\n').filter(Boolean).length, 1);
    assert.deepEqual(treeSnapshot('/home/admin'), before, 'the privileged proof writes nothing');
    write(path.join(scope.workspace, '.ploinky/data/master-key'), `${'0'.repeat(64)}\n`);
    const changed = spawnSync(process.execPath, argv, { input: source, encoding: 'utf8', cwd: '/' });
    assert.equal(changed.status, 1);
    assert.equal(changed.stdout, '{"result":"failed","code":"QA_RESUME_IDENTITY_CHANGED"}\n');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { productionAdapters } from '../../../.github/scripts/rollback-explorer-qa.mjs';
import { writeLockModule } from './qa-fake-lock-modules.mjs';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const holderSource = workflow.split('// BEGIN QA archive lock holder\n')[1]
    .split('// END QA archive lock holder')[0].replace(/^ {10}/gm, '');
const { holdArchiveLock } = await import('data:text/javascript;base64,' + Buffer.from(
    holderSource.slice(0, holderSource.indexOf('if (process.argv[1]')),
).toString('base64'));

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-archive-lock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const backup = path.join(root, 'redeploy-Ab123456');
    const lockPath = path.join(root, 'workspace.lock');
    const events = [];
    const adapters = {
        assertHost() { events.push('host'); },
        async acquireWorkspaceLock(runtimeRoot) {
            assert.equal(runtimeRoot, root);
            fs.mkdirSync(lockPath, { mode: 0o700 }); events.push('acquire');
            return { release() { fs.rmdirSync(lockPath); events.push('release'); } };
        },
    };
    const args = { adapters, scope: { box: 'ploinky-box-qa-7a31ab7775eb' }, runtimeRoot: root,
        backup, parentPid: process.ppid, intervalMs: 5 };
    const ready = `${backup}-lock-ready.json`, released = `${backup}-lock-released.json`;
    const requestRelease = () => fs.writeFileSync(`${backup}-lock-release`, 'release\n', { mode: 0o600 });
    const start = () => holdArchiveLock(args).then(() => null, error => error);
    return { root, backup, lockPath, events, adapters, args, ready, released, requestRelease, start };
}

async function until(check) {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await delay(5);
    }
    assert.fail('Expected archive-lock event did not arrive');
}

test('archive lease excludes a contender throughout capture, quiesce, stop and copy, then permits fresh preparation', async t => {
    const f = fixture(t), result = f.start();
    await until(() => fs.existsSync(f.ready));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.ready)), { held: true, pid: process.pid, instance: f.args.scope.box });
    for (const phase of ['capture', 'quiesce', 'outer-stop', 'snapshot', 'copy', 'source-staging']) {
        await delay(6);
        assert.throws(() => fs.mkdirSync(f.lockPath), { code: 'EEXIST' }, phase);
        assert.equal(fs.existsSync(f.released), false, phase);
        f.events.push(phase);
    }
    f.requestRelease(); assert.equal(await result, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.released)), { released: true, pid: process.pid, instance: f.args.scope.box });
    fs.mkdirSync(f.lockPath); fs.rmdirSync(f.lockPath);
    assert.deepEqual(f.events, ['host', 'acquire', 'capture', 'quiesce', 'outer-stop', 'snapshot', 'copy', 'source-staging', 'release']);
});

test('a release request while acquisition waits cannot produce a ready lease or authorize capture', async t => {
    const f = fixture(t);
    let grant;
    const acquire = f.adapters.acquireWorkspaceLock;
    f.adapters.acquireWorkspaceLock = async root => { await new Promise(resolve => { grant = resolve; }); return acquire(root); };
    const result = f.start(); f.requestRelease(); await delay(15);
    assert.equal(fs.existsSync(f.ready), false);
    grant(); assert.match((await result).message, /acquisition was interrupted/);
    assert.deepEqual(f.events, ['host', 'acquire', 'release']);
    assert.equal(fs.existsSync(f.ready), false);
});

test('unsafe release metadata fails the operation and still releases its lease', async t => {
    const f = fixture(t), result = f.start();
    await until(() => fs.existsSync(f.ready));
    const target = path.join(f.root, 'unowned-release'); fs.writeFileSync(target, 'release\n');
    fs.symlinkSync(target, `${f.backup}-lock-release`);
    assert.match((await result).message, /without a deliberate release/);
    assert.equal(fs.existsSync(f.lockPath), false);
    assert.equal(fs.existsSync(f.released), true);
});

test('acquisition failure emits neither readiness nor a successful release receipt', async t => {
    const f = fixture(t);
    f.adapters.acquireWorkspaceLock = async () => { throw new Error('Injected acquisition failure'); };
    assert.match((await f.start()).message, /Injected acquisition failure/);
    assert.equal(fs.existsSync(f.ready), false); assert.equal(fs.existsSync(f.released), false);
});

test('release failure retains the lease and cannot emit a successful release receipt', async t => {
    const f = fixture(t), acquire = f.adapters.acquireWorkspaceLock;
    f.adapters.acquireWorkspaceLock = async root => { await acquire(root); return { release() { throw new Error('Injected release failure'); } }; };
    const result = f.start(); await until(() => fs.existsSync(f.ready)); f.requestRelease();
    assert.match((await result).message, /Injected release failure/);
    assert.equal(fs.existsSync(f.lockPath), true); assert.equal(fs.existsSync(f.released), false);
});

test('an unrelated parent cannot acquire the workspace lease', async t => {
    const f = fixture(t); f.args.parentPid = process.ppid + 1;
    assert.match((await f.start()).message, /attached to the deploying shell/);
    assert.deepEqual(f.events, ['host']);
});

test('workflow revalidates under the lease and releases only after preservation before supervisor preparation', () => {
    const acquired = workflow.indexOf('# END QA outer archive lock acquisition');
    const admission = workflow.indexOf('          assert_qa_preservation_admission\n', acquired);
    const capture = workflow.indexOf('capture "$QA_BACKUP_DIR" --lock-held', acquired);
    const compare = workflow.indexOf('QA_CAPTURED_CONTAINERS" != "$QA_EXPECTED_CONTAINERS', capture);
    const quiesce = workflow.indexOf('Stopping nested QA services', compare);
    const stop = workflow.indexOf('"$engine" container stop --time 30', quiesce);
    const copied = workflow.indexOf('// END QA durable workspace preservation', stop);
    const staged = workflow.indexOf('git -C "$RUNTIME_DIR" checkout -B', copied);
    const released = workflow.indexOf('\n          release_qa_workspace_lock\n', staged);
    const prepare = workflow.indexOf('await createBoxSupervisor().prepareBoxForCommand', released);
    assert.ok(acquired > 0 && acquired < admission && admission < capture && capture < compare
        && compare < quiesce && quiesce < stop && stop < copied && copied < staged
        && staged < released && released < prepare);
    const held = workflow.slice(acquired, released);
    assert.doesNotMatch(held, /"\$(?:PLOINKY|RUNTIME_DIR\/bin\/ploinky)" (?:start|restart|stop|destroy|enable|install)\b/);
    assert.match(workflow, /cleanup_remote_files\(\) \{\n\s+local status=\$\?\n(?:\s+if \[ \"\$status\" -ne 0 \]; then\n\s+print_rollback_reference_on_failure \|\| true\n\s+fi\n)?\s+release_qa_workspace_lock \|\| status=1/);
    assert.match(workflow, /END QA durable workspace preservation\n\s+NODE\n\s+assert_qa_workspace_lock_held/);
    assert.match(workflow, /wait "\$QA_WORKSPACE_LOCK_PID"/);
    assert.match(workflow, /assert\.deepEqual\(receipt, \{ released: true, pid: Number\(process\.argv\[3\]\), instance: process\.argv\[4\] \}\)/);
});

test('cold bootstrap requires no prior Box or authored workspace and pins the shared lock implementation', () => {
    const cold = workflow.slice(workflow.indexOf('# BEGIN QA outer archive lock acquisition'), workflow.indexOf('cat > "$QA_HELPER_DIR/hold-workspace-lock.mjs"'));
    assert.match(cold, /\$\{#QA_CONTAINER_RECORDS\[@\]\}.*-ne 0/);
    assert.match(cold, /fs\.readdirSync\(workspace\)\.length, 0/);
    assert.match(cold, /resolve_default_branch https:\/\/github\.com\/AssistOS-AI\/ploinky\.git/);
    assert.match(cold, /checkout --detach "\$QA_LOCK_COMMIT"/);
    assert.match(cold, /rev-parse HEAD\).*"\$QA_LOCK_COMMIT"/);
    assert.match(cold, /status --porcelain=v1 --untracked-files=all/);
    assert.match(cold, /\$QA_BACKUP_DIR-lock-source\.txt/);
    assert.match(holderSource, /lock = await adapters\.acquireWorkspaceLock\(runtimeRoot, \{ workspaceRoot: scope\.workspace, deferIfAbsent: true \}\)/);
    assert.doesNotMatch(holderSource, /mkdirSync|owner\.json|\.ploinky-box/);
});

test('direct quiesce exec uses QA publication ports for OnlyOffice targeted drain', () => {
    const call = workflow.slice(workflow.indexOf("printf '%s' \"$QA_QUIESCE_SOURCE\" | \"$engine\" container exec"));
    const args = call.slice(0, call.indexOf('> "$QA_BACKUP_DIR-quiesce.log"'));
    assert.match(args, /--workdir "\$WORK_DIR" --env "PLOINKY_WORKSPACE_ROOT=\$WORK_DIR"/);
    assert.doesNotMatch(args, /\/workspace/);
    assert.match(args, /--env PLOINKY_ROUTER_HOST_PORT=8097/);
    assert.match(args, /--env PLOINKY_MEDIA_HOST_PORT=7882/);
    assert.match(args, /"\$container_id" node --input-type=module -/);
});

// Custody fixtures: the holder runs with the production lock adapter, which
// imports a fake lock module of either generation from the runtime root.
function custodyFixture(t, generation, { workspace = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-archive-custody-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = { box: 'ploinky-box-qa-7a31ab7775eb', workspace: path.join(root, 'explorerQaWorkspace') };
    const runtimeRoot = path.join(root, 'runtime');
    const moduleUrl = writeLockModule(runtimeRoot, generation, { stateRoot: path.join(root, 'home/.ploinky-box') });
    const backup = path.join(root, 'backups/redeploy-Ab123456');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(backup, 'rollback-authority.json'), JSON.stringify({ version: 1, createdAt: '2026-10-21T00:00:00.000Z' }), { mode: 0o600 });
    if (workspace) { fs.mkdirSync(scope.workspace); fs.writeFileSync(path.join(scope.workspace, 'durable'), 'kept'); }
    const adapters = { assertHost() {}, acquireWorkspaceLock: productionAdapters(scope).acquireWorkspaceLock };
    const args = { adapters, scope, runtimeRoot, backup, parentPid: process.ppid, intervalMs: 5 };
    const signal = (suffix, content) => fs.writeFileSync(`${backup}-${suffix}`, content, { mode: 0o600 });
    // The workflow's relocation step: the workspace moves into the backup and is recreated.
    const relocate = () => {
        if (fs.existsSync(scope.workspace)) fs.renameSync(scope.workspace, path.join(backup, 'workspace'));
        fs.mkdirSync(scope.workspace, { mode: 0o700 });
    };
    const receipt = suffix => JSON.parse(fs.readFileSync(`${backup}-${suffix}`, 'utf8'));
    const lockAt = rootPath => fs.existsSync(path.join(rootPath, '.ploinky-host/locks/workspace.lock'));
    const calls = async () => (await import(moduleUrl)).calls.map(call => [call.op, ...call.args]);
    // Runs one holder for `body`. Whatever the body asserts, the holder is asked to
    // release before the test ends, so a failure cannot leave its timer running.
    const run = async body => {
        const result = holdArchiveLock(args).then(() => null, error => error);
        try { return await body(result); } finally {
            if (!fs.existsSync(`${backup}-lock-release`)) signal('lock-release', 'release\n');
            await Promise.race([result, delay(2000)]);
        }
    };
    return { root, scope, backup, args, signal, relocate, receipt, lockAt, calls, run };
}

test('E3: the holder relocates the workspace lock, takes the recreated workspace lock on a fresh skeleton, then releases the old one at its new path', async t => {
    const f = custodyFixture(t, 'workspace');
    await f.run(async result => {
        await until(() => fs.existsSync(`${f.backup}-lock-ready.json`));
        assert.deepEqual(f.receipt('lock-ready.json'), { held: true, pid: process.pid, instance: f.scope.box, custody: 'workspace', deferred: false });
        assert.equal(f.lockAt(f.scope.workspace), true);
        f.relocate();
        const relocated = path.join(f.backup, 'workspace');
        assert.equal(f.lockAt(relocated), true, 'the lock moved with the workspace');
        f.signal('lock-relocated', 'relocated\n');
        await until(() => fs.existsSync(`${f.backup}-lock-ready2.json`));
        assert.deepEqual(f.receipt('lock-ready2.json'), { held: true, pid: process.pid, instance: f.scope.box, custody: 'workspace', phase: 'successor' });
        assert.deepEqual([f.lockAt(f.scope.workspace), f.lockAt(relocated)], [true, false]);
        assert.deepEqual(await f.calls(), [
            ['acquire', f.scope.box, { workspaceRoot: f.scope.workspace, requireNewSkeleton: false }],
            ['assertHeldAt', relocated],
            ['acquire', f.scope.box, { workspaceRoot: f.scope.workspace, requireNewSkeleton: true }],
            ['releaseRelocated', relocated],
        ]);
        const authority = JSON.parse(fs.readFileSync(path.join(f.backup, 'rollback-authority.json'), 'utf8'));
        assert.equal(authority.custody.phase, 'previous-lock-released');
        assert.equal(authority.createdAt, '2026-10-21T00:00:00.000Z', 'the recovery authority keeps its fields');
        assert.equal(fs.statSync(path.join(f.backup, 'rollback-authority.json')).mode & 0o777, 0o600);
        f.signal('lock-release', 'release\n');
        assert.equal(await result, null);
        assert.deepEqual(f.receipt('lock-released.json'), { released: true, pid: process.pid, instance: f.scope.box });
        assert.equal(f.lockAt(f.scope.workspace), false);
    });
});

test('E3: a recreated workspace that already has host state is refused, and the relocated lock is still released at its new path', async t => {
    const f = custodyFixture(t, 'workspace');
    await f.run(async result => {
        await until(() => fs.existsSync(`${f.backup}-lock-ready.json`));
        f.relocate();
        fs.mkdirSync(path.join(f.scope.workspace, '.ploinky-host'));
        f.signal('lock-relocated', 'relocated\n');
        assert.equal((await result)?.code, 'PLOINKY_BOX_HOST_STATE_NOT_NEW');
        assert.equal(fs.existsSync(`${f.backup}-lock-ready2.json`), false);
        assert.equal(fs.existsSync(`${f.backup}-lock-released.json`), true);
        assert.equal(f.lockAt(path.join(f.backup, 'workspace')), false);
        assert.equal((await f.calls()).at(-1)[0], 'releaseRelocated');
    });
});

test('E3: a release request after the workspace moved but before the handover releases the lock where it now is', async t => {
    const f = custodyFixture(t, 'workspace');
    await f.run(async result => {
        await until(() => fs.existsSync(`${f.backup}-lock-ready.json`));
        f.relocate();
        f.signal('lock-release', 'release\n');
        assert.equal(await result, null);
        assert.equal(f.lockAt(path.join(f.backup, 'workspace')), false);
        assert.deepEqual((await f.calls()).map(call => call[0]), ['acquire', 'assertHeld', 'releaseRelocated']);
        assert.equal(fs.existsSync(`${f.backup}-lock-ready2.json`), false);
    });
});

test('E4: with no workspace the holder is deferred, creates nothing, and takes the recreated workspace lock on its fresh skeleton', async t => {
    const f = custodyFixture(t, 'workspace', { workspace: false });
    await f.run(async result => {
        await until(() => fs.existsSync(`${f.backup}-lock-ready.json`));
        assert.deepEqual(f.receipt('lock-ready.json'), { held: false, pid: process.pid, instance: f.scope.box, custody: 'workspace', deferred: true });
        await delay(15);
        assert.equal(fs.existsSync(f.scope.workspace), false, 'the second admission still sees an absent workspace');
        assert.deepEqual(await f.calls(), []);
        f.relocate();
        f.signal('lock-relocated', 'relocated\n');
        await until(() => fs.existsSync(`${f.backup}-lock-ready2.json`));
        assert.deepEqual(await f.calls(), [['acquire', f.scope.box, { workspaceRoot: f.scope.workspace, requireNewSkeleton: true }]]);
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.backup, 'rollback-authority.json'), 'utf8')).custody.phase, 'replacement-lock-acquired');
        f.signal('lock-release', 'release\n');
        assert.equal(await result, null);
        assert.equal(f.lockAt(f.scope.workspace), false);
    });
});

test('E2/E3: an earlier-generation module keeps the former holder receipts and ignores a relocation request', async t => {
    const f = custodyFixture(t, 'legacy');
    await f.run(async result => {
        await until(() => fs.existsSync(`${f.backup}-lock-ready.json`));
        assert.deepEqual(f.receipt('lock-ready.json'), { held: true, pid: process.pid, instance: f.scope.box });
        f.signal('lock-relocated', 'relocated\n');
        await delay(20);
        assert.equal(fs.existsSync(`${f.backup}-lock-ready2.json`), false);
        f.signal('lock-release', 'release\n');
        assert.equal(await result, null);
        assert.deepEqual((await f.calls()).map(call => call.slice(0, 2)), [['acquire', f.scope.box], ['release']]);
        assert.equal((await f.calls())[0].length, 2, 'acquire receives the instance alone');
        assert.equal(fs.existsSync(path.join(f.scope.workspace, '.ploinky-host')), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.backup, 'rollback-authority.json'), 'utf8')).custody, undefined);
    });
});

test('an unsafe relocation request stops the holder and releases its lock', async t => {
    const f = custodyFixture(t, 'workspace');
    await f.run(async result => {
        await until(() => fs.existsSync(`${f.backup}-lock-ready.json`));
        f.signal('lock-relocated', 'relocate everything\n');
        assert.match((await result).message, /without a deliberate release/);
        assert.equal(f.lockAt(f.scope.workspace), false);
    });
});

// The workflow's lock receipt check, run on its own.
const receiptCheck = (() => {
    const start = workflow.indexOf('assert_qa_workspace_lock_held() {');
    const body = workflow.slice(workflow.indexOf("<<'NODE'\n", start) + "<<'NODE'\n".length, workflow.indexOf('\n          NODE', start));
    return body.replace(/^ {10}/gm, '');
})();

test('E4: the workflow lock check accepts a deferred holder only while the workspace is absent and requires the successor receipt after handover', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lock-receipt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const backup = path.join(root, 'redeploy-Ab123456'), workspace = path.join(root, 'explorerQaWorkspace');
    const check = (phase, ready, ready2) => {
        fs.writeFileSync(`${backup}-lock-ready.json`, JSON.stringify(ready));
        if (ready2) fs.writeFileSync(`${backup}-lock-ready2.json`, JSON.stringify(ready2)); else fs.rmSync(`${backup}-lock-ready2.json`, { force: true });
        return spawnSync(process.execPath, ['--input-type=module', '-', backup, String(process.pid), 'box', phase, workspace],
            { input: receiptCheck, encoding: 'utf8', timeout: 5000 }).status;
    };
    const base = { pid: process.pid, instance: 'box' };
    assert.equal(check('initial', { held: true, ...base }), 0, 'earlier-generation receipt');
    assert.equal(check('initial', { held: true, ...base, custody: 'workspace', deferred: false }), 0);
    assert.equal(check('initial', { held: false, ...base, custody: 'workspace', deferred: true }), 0, 'deferred, workspace absent');
    fs.mkdirSync(workspace);
    assert.notEqual(check('initial', { held: false, ...base, custody: 'workspace', deferred: true }), 0, 'deferred, workspace present');
    assert.notEqual(check('initial', { held: false, ...base }), 0);
    assert.notEqual(check('successor', { held: true, ...base }), 0, 'the successor phase needs its own receipt');
    assert.equal(check('successor', { held: true, ...base }, { held: true, ...base, custody: 'workspace', phase: 'successor' }), 0);
    assert.notEqual(check('successor', { held: true, ...base }, { held: true, ...base, custody: 'workspace', phase: 'initial' }), 0);
});

test('workflow hands the lock over between relocation and copy and records the custody it learned from the holder', () => {
    const relocationEnd = workflow.indexOf('// END QA durable workspace relocation');
    const handover = workflow.indexOf('\n          hand_over_qa_workspace_lock\n', relocationEnd);
    const copy = workflow.indexOf('// BEGIN QA durable workspace preservation');
    assert.ok(workflow.indexOf('// BEGIN QA durable workspace relocation') < relocationEnd && relocationEnd < handover && handover < copy);
    assert.match(workflow, /sudo -n \/usr\/bin\/node --input-type=module - "\$WORK_DIR" "\$QA_BACKUP_DIR" "\$QA_WORKSPACE_LOCK_CUSTODY" <<'NODE'/);
    assert.match(workflow, /QA_WORKSPACE_LOCK_CUSTODY="\$\(node --input-type=module - "\$QA_BACKUP_DIR-lock-ready\.json"/);
    const handOver = workflow.slice(workflow.indexOf('hand_over_qa_workspace_lock() {'), workflow.indexOf('\n          }\n', workflow.indexOf('hand_over_qa_workspace_lock() {')));
    assert.match(handOver, /\[ "\$QA_WORKSPACE_LOCK_CUSTODY" = workspace \] \|\| return 0/);
    assert.match(handOver, /printf '%s\\n' relocated > "\$QA_BACKUP_DIR-lock-relocated"/);
    assert.match(handOver, /QA_WORKSPACE_LOCK_PHASE=successor\n\s+assert_qa_workspace_lock_held/);
    assert.match(workflow, /for suffix in lock-ready\.json lock-ready2\.json lock-relocated lock-released\.json lock-release lock\.log lock-source\.txt; do/);
});

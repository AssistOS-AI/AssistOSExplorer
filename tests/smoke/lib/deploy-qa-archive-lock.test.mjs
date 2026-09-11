import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
    assert.match(workflow, /cleanup_remote_files\(\) \{\n\s+local status=\$\?\n\s+release_qa_workspace_lock \|\| status=1/);
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
    assert.match(holderSource, /lock = await adapters\.acquireWorkspaceLock\(runtimeRoot\)/);
    assert.doesNotMatch(holderSource, /mkdirSync|owner\.json|\.ploinky-box/);
});

test('direct quiesce exec uses QA publication ports for OnlyOffice targeted drain', () => {
    const call = workflow.slice(workflow.indexOf("printf '%s' \"$QA_QUIESCE_SOURCE\" | \"$engine\" container exec"));
    const args = call.slice(0, call.indexOf('> "$QA_BACKUP_DIR-quiesce.log"'));
    assert.match(args, /--env PLOINKY_WORKSPACE_ROOT=\/workspace/);
    assert.match(args, /--env PLOINKY_ROUTER_HOST_PORT=8097/);
    assert.match(args, /--env PLOINKY_MEDIA_HOST_PORT=7882/);
    assert.match(args, /"\$container_id" node --input-type=module -/);
});

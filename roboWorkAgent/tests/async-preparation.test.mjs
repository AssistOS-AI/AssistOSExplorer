import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const source = process.env.M21_SOURCE_ROOT ? pathToFileURL(path.join(process.env.M21_SOURCE_ROOT, 'roboWorkAgent/server/')) : new URL('../server/', import.meta.url);
const { RunManager } = await import(new URL('run-manager.mjs', source));
const { RobotPaths } = await import(new URL('robot-paths.mjs', source));
const { RuntimeBundle } = await import(new URL('runtime-bundle.mjs', source));
const { GuiManager } = await import(new URL('gui-manager.mjs', source));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function promptly(operation) { return Promise.race([operation, delay(150).then(() => { throw new Error('Operation blocked on preparation'); })]); }

async function runsFixture(t) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-async-'));
    const paths = new RobotPaths({ dataDir: path.join(root, 'data'), workspaceRoot: path.join(root, 'workspace') });
    const cwd = path.join(paths.workspaceRoot, 'project'); await fs.mkdir(cwd, { recursive: true });
    const gate = deferred(); let spawns = 0;
    const manager = new RunManager({ paths, alaEntry: '/unused',
        robots: { require: async id => ({ id, codingAgents: ['opencode'] }) },
        toolCache: { root: path.join(paths.dataDir, 'tool-cache'), prepareCodingAgents: () => gate.promise },
        buildLaunch: async () => ({ command: process.execPath, args: ['-e', "process.stdin.on('data',b=>process.stdout.write(b));"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }),
        spawnImpl: (...args) => { spawns++; return spawn(...args); },
    });
    await manager.initialize();
    t.after(async () => { gate.resolve({}); await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
    return { paths, manager, gate, spawns: () => spawns, input: { runId: 'pending-run', robotId: 'robot-a', cwd, ala: { sessionId: 'session-a' } } };
}

test('run_start returns durable starting before preparation, buffers ordered input and close', async t => {
    const f = await runsFixture(t);
    const answer = await promptly(f.manager.start(f.input));
    assert.equal(answer.state, 'starting'); assert.equal(f.spawns(), 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.paths.run(f.input.runId), 'meta.json'), 'utf8')).state, 'starting');
    for (const text of ['one\n', 'two\n']) await f.manager.input({ runId: f.input.runId, data: Buffer.from(text).toString('base64') });
    await f.manager.input({ runId: f.input.runId, close: true });
    await assert.rejects(f.manager.input({ runId: f.input.runId, data: Buffer.from('late').toString('base64') }), { code: 'RUN_NOT_RUNNING' });
    f.gate.resolve({}); await f.manager.get(f.input.runId).preparing;
    for (let attempt = 0; attempt < 50 && f.manager.get(f.input.runId).meta.state !== 'exited'; attempt++) await delay(10);
    const result = await f.manager.read({ runId: f.input.runId, after: 0 });
    assert.equal(result.state, 'exited'); assert.equal(result.exit.code, 0);
    assert.equal(result.records.filter(record => record.stream === 'stdout').map(record => Buffer.from(record.data, 'base64')).join(''), 'one\ntwo\n');
    assert.ok(result.records.some(record => record.stream === 'stderr' && Buffer.from(record.data, 'base64').includes('preparing')));
});

test('stopping a starting run prevents late spawn and release/reuse cannot inherit old preparation', async t => {
    const f = await runsFixture(t);
    await promptly(f.manager.start(f.input));
    await delay(5);
    await promptly(f.manager.stop({ runId: f.input.runId }));
    assert.equal((await f.manager.read({ runId: f.input.runId })).exit.signal, 'SIGTERM');
    await f.manager.release({ runId: f.input.runId });
    f.gate.resolve({}); await delay(10); assert.equal(f.spawns(), 0);
    const again = await f.manager.start(f.input); assert.equal(again.alreadyRunning, false);
    await f.manager.get(f.input.runId).preparing; assert.equal(f.spawns(), 1);
});

test('a granted folder or cwd swapped for a link during preparation never starts the run', async t => {
    for (const swapped of ['folder', 'cwd']) {
        const f = await runsFixture(t);
        const folder = path.join(f.input.cwd, 'skill'), sibling = path.join(f.paths.workspaceRoot, 'sibling');
        await fs.mkdir(folder); await fs.mkdir(sibling);
        await f.manager.start({ ...f.input, folders: [{ source: folder, alias: 'skill' }] });
        const target = swapped === 'folder' ? folder : f.input.cwd;
        await fs.rename(target, `${target}-moved`); await fs.symlink(sibling, target);
        f.gate.resolve({}); await f.manager.get(f.input.runId).preparing;
        assert.equal(f.spawns(), 0, swapped);
        const result = await f.manager.read({ runId: f.input.runId, after: 0 });
        assert.equal(result.state, 'exited', swapped); assert.notEqual(result.exit.code, 0, swapped);
        assert.ok(result.records.some(record => record.stream === 'stderr' && Buffer.from(record.data, 'base64').includes('preparation ended: FOLDER_REFUSED')), swapped);
    }
});

test('a folder or cwd swapped while an Environment image is prepared never starts the run', async t => {
    for (const swapped of ['folder', 'cwd']) {
        const f = await runsFixture(t);
        const folder = path.join(f.input.cwd, 'skill'), sibling = path.join(f.paths.workspaceRoot, 'sibling');
        await fs.mkdir(folder); await fs.mkdir(sibling);
        const held = deferred(), reached = deferred();
        f.manager.runtimeBundle = { prepare: async () => ({ ala: { path: '/ala' }, bwrap: { bin: '/bwrap' } }) };
        f.manager.environment = { buildLaunch: async () => { reached.resolve(); await held.promise;
            return { command: process.execPath, args: ['-e', ''], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; } };
        await f.manager.start({ ...f.input, environment: { agent: 'a' }, folders: [{ source: folder, alias: 'skill' }] });
        f.gate.resolve({}); await reached.promise;
        const target = swapped === 'folder' ? folder : f.input.cwd;
        await fs.rename(target, `${target}-moved`); await fs.symlink(sibling, target);
        held.resolve(); await f.manager.get(f.input.runId).preparing;
        assert.equal(f.spawns(), 0, swapped);
        const result = await f.manager.read({ runId: f.input.runId, after: 0 });
        assert.ok(result.records.some(record => record.stream === 'stderr' && Buffer.from(record.data, 'base64').includes('preparation ended: FOLDER_REFUSED')), swapped);
    }
});

test('a child refusing its mounts ends the run FOLDER_REFUSED even while queued input cannot be delivered', async t => {
    const f = await runsFixture(t);
    f.manager.buildLaunch = async () => ({ command: process.execPath, args: ['-e', 'process.exit(78);'], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } });
    await f.manager.start(f.input);
    await f.manager.input({ runId: f.input.runId, data: Buffer.alloc(600000).toString('base64') });
    await f.manager.input({ runId: f.input.runId, data: Buffer.alloc(600000).toString('base64') });
    f.gate.resolve({}); await f.manager.get(f.input.runId).preparing;
    for (let attempt = 0; attempt < 300 && f.manager.get(f.input.runId).meta.state !== 'exited'; attempt++) await delay(10);
    const result = await f.manager.read({ runId: f.input.runId, after: 0 });
    assert.equal(result.state, 'exited'); assert.equal(result.exit.signal, 'FOLDER_REFUSED'); assert.equal(result.exit.code, null);
    assert.ok(result.records.some(record => Buffer.from(record.data, 'base64').includes('run refused: FOLDER_REFUSED')));
});

test('a refused preparation logs the plain reason and an internal failure keeps it private', async t => {
    const refused = await runsFixture(t);
    const folder = path.join(refused.input.cwd, 'skill'), sibling = path.join(refused.paths.workspaceRoot, 'sibling');
    await fs.mkdir(folder); await fs.mkdir(sibling);
    await refused.manager.start({ ...refused.input, folders: [{ source: folder, alias: 'skill' }] });
    await fs.rename(folder, `${folder}-moved`); await fs.symlink(sibling, folder);
    refused.gate.resolve({}); await refused.manager.get(refused.input.runId).preparing;
    const text = async f => (await f.manager.read({ runId: f.input.runId, after: 0 })).records.map(record => Buffer.from(record.data, 'base64').toString()).join('');
    assert.match(await text(refused), /preparation ended: FOLDER_REFUSED: A granted folder changed while the run was preparing/u);
    const internal = await runsFixture(t);
    internal.manager.buildLaunch = async () => { throw new Error('private detail'); };
    await internal.manager.start(internal.input);
    internal.gate.resolve({}); await internal.manager.get(internal.input.runId).preparing;
    const log = await text(internal);
    assert.match(log, /preparation ended: START_FAILED/u); assert.doesNotMatch(log, /private detail/u);
});

test('pending input is bounded without starting a child', async t => {
    const f = await runsFixture(t); await promptly(f.manager.start(f.input));
    const data = Buffer.alloc(600000).toString('base64');
    for (let index = 0; index < 5; index++) await f.manager.input({ runId: f.input.runId, data });
    await assert.rejects(f.manager.input({ runId: f.input.runId, data }), { code: 'INPUT_LIMIT' });
    assert.equal(f.spawns(), 0); await f.manager.stop({ runId: f.input.runId });
});

async function bundleFixture(t) {
    const root = await fs.mkdtemp('/tmp/rw-builder-'); const gate = deferred(); const calls = [];
    const toolCache = { root, podmanCommand: 'fixture-podman', _once: (_key, operation) => operation(),
        _prepare: async (_name, operation) => { const plan = await operation(); await plan.install(root); return plan.result(root); },
        execFileImpl: async (_command, args, options) => {
            calls.push({ args, options });
            if (args[0] !== 'run') return { stdout: '' };
            return new Promise((resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
                options.signal?.addEventListener('abort', abort, { once: true });
                gate.promise.then(() => { options.signal?.removeEventListener('abort', abort); resolve({ stdout: '' }); });
            });
        } };
    const bundle = new RuntimeBundle({ toolCache, log: () => {} });
    t.after(async () => { gate.resolve(); await fs.rm(root, { recursive: true, force: true }); });
    return { bundle, gate, calls };
}

test('cancelling one static-builder consumer retains another service consumer', async t => {
    const f = await bundleFixture(t); const cancelled = new AbortController();
    const service = f.bundle.prepareBwrap();
    const run = f.bundle.prepareBwrap({ signal: cancelled.signal });
    await delay(5); cancelled.abort();
    await assert.rejects(promptly(run), { code: 'PREPARATION_CANCELLED' });
    assert.equal(f.calls.filter(call => call.args[0] === 'run').length, 1);
    assert.equal(f.calls[0].options.signal.aborted, false);
    assert.equal(f.calls.some(call => call.args[0] === 'rm'), false);
    f.gate.resolve(); assert.ok((await service).bin.endsWith('/bin/bwrap'));
});

test('last cancelled static-builder consumer aborts and removes its exact owned builder', async t => {
    const f = await bundleFixture(t); const cancelled = new AbortController();
    const run = f.bundle.prepareBwrap({ signal: cancelled.signal });
    await delay(5); cancelled.abort();
    await assert.rejects(promptly(run), { code: 'PREPARATION_CANCELLED' });
    const build = f.calls.find(call => call.args[0] === 'run');
    assert.equal(build.options.signal.aborted, true);
    const name = build.args[build.args.indexOf('--name') + 1];
    assert.match(name, /^robowork-bwrap-[a-f0-9-]+$/u);
    assert.deepEqual(f.calls.find(call => call.args[0] === 'rm').args, ['rm', '-f', '--ignore', name]);
});

test('GUI starts asynchronously, reports preparation state, and stop prevents late launch', async t => {
    const root = await fs.mkdtemp('/tmp/rw-gui-async-'); const gate = deferred(); const calls = [];
    const gui = new GuiManager({ workspaceRoot: root, dataDir: path.join(root, 'data'),
        getRobot: async id => ({ id, name: id }), prepareRobot: async () => {}, homeOps: async () => {},
        proxySettings: { useProxy: async () => false },
        toolCache: { root, prepareMode: () => gate.promise, prepareShellTools: async () => ({ binPath: '/bin', agents: {} }) },
        execFileImpl: async (_command, args) => { calls.push(args); return { stdout: '127.0.0.1:4567' }; }, waitForSession: async () => {} });
    t.after(async () => { gate.resolve({ path: root }); await gui.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
    assert.equal((await promptly(gui.ensure({ robotId: 'robot-a', mode: 'desktop' }))).state, 'starting');
    assert.equal(gui.status('robot-a').state, 'starting');
    await promptly(gui.stop({ robotId: 'robot-a' }));
    gate.resolve({ path: root }); await delay(10);
    assert.equal(gui.status('robot-a').state, 'stopped');
    assert.equal(calls.some(args => ['run', 'create'].includes(args[0])), false);
});

test('selected image pull receives cancellation without caching a download failure', async t => {
    const { EnvironmentManager } = await import(new URL('environment.mjs', source));
    const cancelled = new AbortController(), finished = deferred(); let pullSignal;
    const environment = new EnvironmentManager({
        loadMarketplace: async () => ({ agents: [{ repo: 'repo', name: 'agent', active: true, enableMode: 'global', manifestPath: '/fixture/manifest.json' }] }),
        readManifest: async () => ({ container: 'image:fixture' }), imageExists: async () => false,
        execFileImpl: async (_command, args, options) => {
            if (args[0] !== 'pull') return { stdout: '[]' };
            pullSignal = options.signal;
            return new Promise((resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })), { once: true });
                finished.promise.then(() => resolve({ stdout: '' }));
            });
        },
    });
    t.after(() => finished.resolve());
    const preparing = environment.prepare('repo/agent', { signal: cancelled.signal });
    await delay(5); assert.equal(pullSignal, cancelled.signal); cancelled.abort();
    await assert.rejects(promptly(preparing), { code: 'ABORT_ERR' });
    assert.equal((await environment.list())[0].available, true);
});

test('owned builder cleanup failure is reported rather than accepted as cancellation', async t => {
    const f = await bundleFixture(t), cancelled = new AbortController();
    const execute = f.bundle.toolCache.execFileImpl;
    f.bundle.toolCache.execFileImpl = (...args) => args[1][0] === 'rm'
        ? Promise.reject(new Error('fixture removal refused')) : execute(...args);
    const preparing = f.bundle.prepareBwrap({ signal: cancelled.signal });
    await delay(5); cancelled.abort();
    await assert.rejects(promptly(preparing), { code: 'PREPARATION_CLEANUP_FAILED' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { authorizeCaller } from '../server/caller.mjs';
import { RobotPaths } from '../server/robot-paths.mjs';
import { RunManager } from '../server/run-manager.mjs';
import { RunChannels } from '../server/run-channels.mjs';
import { nativeEnvironment } from '../server/native-environment.mjs';
import { createRoboWorkServer } from '../server/http-server.mjs';

const subject = 'agent:AchillesIDE/roboTeamAgent';
const grant = () => ({ metadata: { invocation: { sub: subject, actor: { id: subject, kind: 'agent' } } } });

test('only the exact controller acting for itself is accepted', () => {
    assert.doesNotThrow(() => authorizeCaller(grant()));
    for (const payload of [{}, { metadata: { invocation: { sub: 'user:a', actor: { kind: 'user', id: 'user:a' } } } },
        { metadata: { invocation: { sub: 'agent:other', actor: { id: 'agent:other', kind: 'agent' } } } },
        { metadata: { invocation: { ...grant().metadata.invocation, usr: { id: 'user:a' } } } },
        { metadata: { invocation: { ...grant().metadata.invocation, delegation: { user: 'a' } } } },
        { metadata: { ...grant().metadata, user: { id: 'a' } } }]) {
        assert.throws(() => authorizeCaller(payload), { code: 'CALLER_REFUSED' });
    }
});

async function fixture(t, { logCap, program = "process.stdin.on('data',b=>process.stdout.write(b));" } = {}) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-'));
    const workspaceRoot = path.join(root, 'workspace');
    const cwd = path.join(workspaceRoot, 'project');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(dataDir);
    const paths = new RobotPaths({ dataDir, workspaceRoot });
    let spawns = 0;
    const manager = new RunManager({ paths, logCap, alaEntry: '/unused',
        robots: { require: async id => ({ id, codingAgents: ['opencode'] }) },
        toolCache: { root: path.join(dataDir, 'tool-cache'), prepareCodingAgents: async () => ({}) },
        buildLaunch: async () => { spawns += 1; return { command: process.execPath, args: ['-e', program], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; },
    });
    await manager.initialize(); t.after(async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
    const input = { runId: 'run-1', robotId: 'aaa', cwd, ala: { sessionId: 'session-1' }, folders: [], ignore: [], channels: [], tag: { kind: 'copilot', ownerPrincipal: 'user:a' } };
    return { root, paths, manager, input, spawns: () => spawns };
}

test('cwd and folder grants reject private storage, ancestors and symlink aliases', async t => {
    const { paths, input } = await fixture(t);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data', '.private'), { recursive: true });
    await fs.mkdir(path.join(paths.workspaceRoot, '.ploinky'), { recursive: true });
    const alias = path.join(input.cwd, 'alias'); await fs.symlink(paths.dataDir, alias);
    for (const value of [paths.dataDir, alias, paths.workspaceRoot, path.join(paths.workspaceRoot, '.data'), path.join(paths.workspaceRoot, '.ploinky')]) {
        await assert.rejects(paths.grant(value, 'cwd'), { code: 'CWD_REFUSED' });
    }
    await assert.rejects(paths.grant(alias), { code: 'FOLDER_REFUSED' });
    assert.equal(await paths.grant(input.cwd, 'cwd'), input.cwd);
});

test('concurrent run_start is idempotent; stdin/output, durable replay and unknown ids', async t => {
    const { manager, input, spawns, paths } = await fixture(t);
    const starts = await Promise.all([manager.start(input), manager.start(input)]);
    assert.equal(spawns(), 1); assert.equal(starts.filter(value => value.alreadyRunning).length, 1);
    await manager.input({ runId: input.runId, data: Buffer.from('hello\n').toString('base64') });
    let result;
    for (let attempt = 0; attempt < 20; attempt++) {
        result = await manager.read({ runId: input.runId, after: 0, waitMs: 100 });
        if (result.records.length) break;
    }
    assert.equal(result.records.map(record => Buffer.from(record.data, 'base64').toString()).join(''), 'hello\n');
    assert.equal(result.next, result.records.at(-1).seq);
    await assert.rejects(manager.read({ runId: 'missing' }), { code: 'UNKNOWN_RUN' });
    await assert.rejects(manager.read({ runId: input.runId, after: -1 }), { code: 'INVALID_INPUT' });
    await assert.rejects(manager.start({ ...input, runId: '../bad' }), { code: 'INVALID_INPUT' });
    await assert.rejects(manager.start({ ...input, runId: 'bad-folder', folders: [null] }), { code: 'INVALID_INPUT' });
    await assert.rejects(manager.input({ runId: input.runId, close: 'yes' }), { code: 'INVALID_INPUT' });
    await manager.input({ runId: input.runId, close: true });
    await manager.close();
    const restored = new RunManager({ paths }); await restored.initialize();
    assert.deepEqual((await restored.read({ runId: input.runId })).records, result.records);
    assert.deepEqual(restored.list()[0].tag, input.tag);
});

test('read accepts interface wait values but never holds more than 100 ms plus scheduler tolerance', async t => {
    const { manager, input } = await fixture(t);
    await manager.start(input);
    const start = performance.now();
    await manager.read({ runId: input.runId, after: 0, waitMs: 5000 });
    assert.ok(performance.now() - start < 1000);
});

test('log cap stops a noisy process and persists the cap outcome', async t => {
    const { manager, input } = await fixture(t, { logCap: 65536, program: "setInterval(()=>process.stdout.write(Buffer.alloc(32768,65)),1);" });
    await manager.start(input);
    for (let attempt = 0; attempt < 50 && manager.get(input.runId).meta.state === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    const run = manager.get(input.runId);
    await run.finishing;
    assert.equal(run.meta.logCapped, true); assert.equal(run.meta.state, 'exited');
    assert.ok((await fs.stat(path.join(run.directory, 'log.ndjson'))).size <= 65536);
});

test('callback capability gates access and relays pending/replied JSON', async t => {
    const { paths } = await fixture(t);
    const channels = new RunChannels({ directory: path.join(paths.dataDir, 'channels'), definitions: [{ name: 'human-input', context: {} }] });
    const [mount] = await channels.prepare(); t.after(() => channels.close());
    const { token } = JSON.parse(await fs.readFile(path.join(mount.source, 'context.json'), 'utf8'));
    const request = capability => new Promise((resolve, reject) => {
        const req = http.request({ socketPath: path.join(mount.source, 'request.sock'), method: 'POST', path: '/require-human-input',
            headers: { 'x-task-capability': capability } }, res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
        req.on('error', reject); req.end(JSON.stringify({ question: 'Continue?' }));
    });
    assert.equal((await request('wrong')).status, 403);
    const response = request(token);
    for (let attempt = 0; attempt < 30 && !channels.list().length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const [callback] = channels.list(); assert.equal(callback.body.question, 'Continue?');
    await channels.reply({ id: callback.id, status: 200, body: { answer: 'yes' } });
    assert.deepEqual(await response, { status: 200, body: { answer: 'yes' } }); assert.equal(channels.list().length, 0);
});

test('native environment excludes service credentials and unrelated variables', () => {
    const env = nativeEnvironment({ PATH: '/bin', PLOINKY_AGENT_SECRET: 'forbidden', ROBOWORK_INTERNAL_TOKEN: 'forbidden', API_KEY: 'forbidden', NODE_OPTIONS: '--bad' }, '/home/aaa');
    assert.equal(env.HOME, '/home/aaa'); assert.equal(env.USER, 'aaa'); assert.equal(env.ALA_SANDBOX_HOME, '/home/aaa');
    assert.ok(!Object.keys(env).some(key => /SECRET|TOKEN|KEY|PLOINKY|NODE_OPTIONS/u.test(key)));
});

test('environment stop checks the exact container label and robot before signalling', async t => {
    const { manager } = await fixture(t);
    const calls = [];
    manager.execFileImpl = async (command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ 'robowork.environment': 'true', 'robowork.robot': 'aaa' }) };
    };
    const run = { meta: { robotId: 'aaa' }, containerName: 'robowork-env-' + 'a'.repeat(24) };
    await manager.stopEnvironment(run, 'SIGTERM');
    assert.equal(calls.at(-1)[0], 'kill');
    calls.length = 0;
    await assert.rejects(manager.stopEnvironment({ ...run, meta: { robotId: 'bbb' } }, 'SIGTERM'), { code: 'ENVIRONMENT_STOP_FAILED' });
    assert.ok(!calls.some(args => args[0] === 'kill'));
});

test('resident HTTP service refuses missing token and returns stable operation errors', async t => {
    const { manager } = await fixture(t);
    const server = createRoboWorkServer({ robots: {}, runs: manager, environment: {}, internalToken: 'private' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}/internal/run_read`;
    const refused = await fetch(url, { method: 'POST', body: '{}' }); assert.equal(refused.status, 403);
    const unknown = await fetch(url, { method: 'POST', headers: { 'x-robowork-internal-token': 'private' }, body: JSON.stringify({ runId: 'unknown' }) });
    assert.equal(unknown.status, 404); assert.equal((await unknown.json()).code, 'UNKNOWN_RUN');
});

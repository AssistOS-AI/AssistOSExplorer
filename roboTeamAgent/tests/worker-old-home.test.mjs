import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { createRoboTeamServer, ROBOT_TERMINALS_UNAVAILABLE_MESSAGE } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { prepareCopilotContext } from '../server/copilot-context.mjs';
import { routedHeaders } from './helpers/router-worker.mjs';

// Decision M-72: with the worker the robot's HOME is the worker's, so every writer of RoboTeam's old home (`robots/<id>/home`) is a
// no-op, and old-home data of earlier deployments is neither read nor deleted. Without the worker nothing changes.
const ADMIN = { id: 'admin-v', roles: ['admin'] };
const tools = { root: '/cache', prepareShellTools: async () => ({ root: '/cache', path: '/cache/s', binPath: '/cache/s/bin', agents: {} }),
    prepareCodingAgents: async () => ({ opencode: { path: '/cache/opencode', binPath: '/cache/opencode/bin', versions: {} } }), peekShellTools: async () => null };
const withAgents = { ...tools, prepareShellTools: async () => ({ root: '/cache', path: '/cache/s', binPath: '/cache/s/bin',
    agents: { opencode: { path: '/cache/opencode', binPath: '/cache/opencode/bin', versions: {} } } }) };
const exists = (target) => fs.stat(target).then(() => true, () => false);

async function setup(t, workerMode) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-m72-')));
    const workspaceRoot = path.join(root, 'workspace');
    const dataDir = path.join(workspaceRoot, '.data', 'roboTeamAgent');
    await fs.mkdir(dataDir, { recursive: true });
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir, writesOldHome: !workerMode });
    await robotStore.initialize();
    const runtimeManager = new RuntimeManager({ workerMode, dataDir, workspaceRoot, toolCache: tools, execFileImpl: async () => ({ stdout: '', stderr: '' }) });
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534, workerMode });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await runtimeManager.stopAll();
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (pathname, body) => {
        const text = JSON.stringify(body ?? {});
        const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', ...routedHeaders(ADMIN, 'POST', pathname, text) }, body: text });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const home = (id) => path.join(dataDir, 'robots', id, 'home');
    return { post, home, robotStore, runtimeManager, dataDir };
}

test('with the worker the startup, warmup and seeding writers leave the old home untouched and log once', async (t) => {
    const f = await setup(t, true);
    const robots = [];
    for (const name of ['alpha', 'beta']) robots.push(await f.robotStore.create({ name, codingAgents: ['opencode'] }));
    // An earlier deployment's home is neither read nor deleted.
    const legacy = f.home(robots[0].id);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'keep.txt'), 'old data');
    const lines = [];
    const log = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
        for (const robot of robots) await f.runtimeManager.prepareOpenCode(robot.id, { seed: false });
        await f.runtimeManager.warmOpenCodePlugins(robots);
        for (const robot of robots) f.runtimeManager.seedOpenCodeInBackground(robot);
        assert.deepEqual(await f.runtimeManager.seedOpenCode(robots[0].id), { status: 'unavailable' });
    } finally { console.log = log; }
    assert.equal(await exists(f.home(robots[1].id)), false, 'no home was created');
    assert.deepEqual(await fs.readdir(legacy), ['keep.txt'], 'the old data is untouched');
    assert.equal(await fs.readFile(path.join(legacy, 'keep.txt'), 'utf8'), 'old data');
    assert.equal(lines.filter((line) => line.includes('decision M-72')).length, 1, 'logged once per process, not per robot');
});

test('with the worker robot create, import and coding-agent updates create and write no old home', async (t) => {
    const f = await setup(t, true);
    const created = await f.post('/api/robots', { name: 'fresh', codingAgents: ['opencode'] });
    assert.equal(created.status, 201);
    const id = created.body.robot.id;
    assert.equal(await exists(f.home(id)), false, 'create made no home');
    assert.equal(await exists(path.join(f.dataDir, 'robots', id, 'metadata.json')), true, 'the robot record is written');
    const imported = await f.post('/api/robots/import-emails', { addresses: ['mailer@example.com'], codingAgents: ['opencode'] });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const importedId = (await f.robotStore.list()).find((robot) => robot.name === 'mailer@example.com').id;
    assert.equal(await exists(f.home(importedId)), false, 'import made no home');
    await f.robotStore.setCodingAgents(id, ['codex']);
    assert.equal(await exists(f.home(id)), false, 'a coding-agent update wrote no home');
    assert.equal((await f.robotStore.get(id)).codingAgents[0], 'codex');
});

test('with the worker the old robot Terminal profile is refused plainly and writes no home', async (t) => {
    const f = await setup(t, true);
    const robot = (await f.post('/api/robots', { name: 'termbot' })).body.robot;
    for (const target of [`/api/terminal-profiles/${robot.id}/prepare`, '/api/terminal-profiles/resolve']) {
        const result = await f.post(target, target.endsWith('resolve') ? { id: robot.id, version: 1 } : {});
        assert.equal(result.status, 409, target);
        assert.equal(result.body.error, 'Robot terminals arrive with the worker update', target);
        assert.equal(result.body.error, ROBOT_TERMINALS_UNAVAILABLE_MESSAGE);
        assert.equal(result.body.code, 'robot_terminals_unavailable_with_worker');
    }
    assert.equal(await exists(f.home(robot.id)), false);
});

test('without the worker the old home is created and written as before and the Terminal profile prepares', async (t) => {
    const f = await setup(t, false);
    const created = await f.post('/api/robots', { name: 'plainbot', codingAgents: ['opencode'] });
    assert.equal(created.status, 201);
    const id = created.body.robot.id;
    assert.equal(await exists(path.join(f.home(id), '.codex')), true, 'create prepared the home');
    assert.equal(await exists(path.join(f.home(id), '.roboteam-env.sh')), true, 'the shell was prepared');
    const prepared = await f.post(`/api/terminal-profiles/${id}/prepare`, {});
    assert.notEqual(prepared.status, 409);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
});

test('a copilot context in worker mode neither requires, creates nor writes the old home, whatever the caller passes', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-m72-copilot-')));
    const workspaceRoot = path.join(root, 'workspace');
    const dataDir = path.join(workspaceRoot, '.data', 'roboTeamAgent');
    await fs.mkdir(dataDir, { recursive: true });
    const saved = { ws: process.env.PLOINKY_WORKSPACE_ROOT, base: process.env.ROBOTEAM_WORKER_COORDINATOR_BASE };
    const env = ['ROBOTEAM_COPILOT_ROBOT_ID', 'ROBOTEAM_COPILOT_ROBOT_NAME', 'ACHILLES_ALA_COMMAND', 'ROBOTEAM_COPILOT_ROOT'];
    const savedEnv = Object.fromEntries(env.map((name) => [name, process.env[name]]));
    t.after(async () => {
        for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', saved.ws], ['ROBOTEAM_WORKER_COORDINATOR_BASE', saved.base], ...Object.entries(savedEnv)]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    process.env.ACHILLES_ALA_COMMAND = process.execPath;
    const store = new RobotStore({ dataDir, writesOldHome: false });
    await store.initialize();
    const robot = await store.create({ name: 'copilotbot', codingAgents: ['opencode'] });
    const home = path.join(dataDir, 'robots', robot.id, 'home');
    const errors = [];
    const logError = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    process.env.ROBOTEAM_WORKER_COORDINATOR_BASE = 'http://127.0.0.1:1/coordinator';
    try {
        // The default prepareHome (true) and the tool preparation both would write the home; neither does in worker mode.
        for (let call = 0; call < 2; call += 1) {
            const context = await prepareCopilotContext('copilotbot', { dataDir, toolCache: withAgents, alaCommand: process.execPath, prepareHome: true });
            assert.equal(context.robot.id, robot.id);
        }
    } finally { console.error = logError; }
    assert.equal(await exists(home), false, 'the copilot context created no home');
    assert.equal(errors.filter((line) => line.includes('decision M-72')).length, 1, 'logged once per process, not per call');

    // Without the worker the same call still prepares the home (an existing home is required and written).
    delete process.env.ROBOTEAM_WORKER_COORDINATOR_BASE;
    const plain = new RobotStore({ dataDir, writesOldHome: true });
    const other = await plain.create({ name: 'plaincopilot', codingAgents: ['opencode'] });
    const otherHome = path.join(dataDir, 'robots', other.id, 'home');
    await fs.rm(path.join(otherHome, '.roboteam-env.sh'), { force: true });
    await prepareCopilotContext('plaincopilot', { dataDir, toolCache: withAgents, alaCommand: process.execPath, prepareTools: false });
    assert.equal(await exists(path.join(otherHome, '.roboteam-env.sh')), true, 'non-worker prepares the shell as before');
});

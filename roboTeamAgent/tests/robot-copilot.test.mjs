import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { prepareCopilotContext } from '../server/copilot-context.mjs';
import { ToolCache } from '../server/tool-cache.mjs';
import { robotCodingAgents } from '../server/coding-agents.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';

test('copilot cache preparation is silent but preparation failures remain visible', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-cache-output-'));
    const keys = ['ROBOTEAM_DATA_DIR', 'ROBOTEAM_COPILOT_ROOT', 'ROBOTEAM_COPILOT_ROBOT_ID',
        'ROBOTEAM_COPILOT_ROBOT_NAME', 'ACHILLES_ALA_HOME', 'ACHILLES_ALA_COMMAND',
        'CODEX_BIN', 'PI_BIN', 'OPENCODE_BIN', 'CLAUDE_BIN', 'PATH', 'PLOINKY_WORKSPACE_ROOT'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(async () => {
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.ROBOTEAM_DATA_DIR = root;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    await new RobotStore({ dataDir: root }).ensureDefaultRobot();
    const output = [];
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => output.push(args));
    let fail = false;
    t.mock.method(ToolCache.prototype, 'prepareShellTools', async function (names) {
        for (const name of ['codex', 'pi', 'opencode']) this.log(`[tool-cache] using ${name} cache generation example`);
        if (fail) throw new Error('cache preparation failed');
        // Copilot preparation prepares every coding agent so any agent can be logged in before it is selected;
        // the robot's configured agents are then chosen from the prepared set.
        assert.equal(names, undefined);
        return { binPath: '/cached/bin', agents: { opencode: { binPath: '/cached/bin' } } };
    });
    await prepareCopilotContext('default', { dataDir: root });
    assert.deepEqual(output, []);
    assert.equal(process.env.OPENCODE_BIN, '/cached/bin/opencode');
    fail = true;
    await assert.rejects(prepareCopilotContext('default', { dataDir: root }), /cache preparation failed/);
    assert.deepEqual(output, []);
});

test('chat history belongs to the project, survives robot deletion and is shared across robot selection', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-chat-scope-'));
    const keys = ['ROBOTEAM_DATA_DIR', 'ROBOTEAM_COPILOT_ROOT', 'ROBOTEAM_COPILOT_ROBOT_ID',
        'ROBOTEAM_COPILOT_ROBOT_NAME', 'ACHILLES_ALA_HOME', 'ACHILLES_ALA_COMMAND', 'PLOINKY_WORKSPACE_ROOT'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(async () => {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.ROBOTEAM_DATA_DIR = path.join(root, 'data');
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    const one = path.join(root, 'one'); const two = path.join(root, 'two');
    await Promise.all([fs.mkdir(one), fs.mkdir(two)]);
    const store = new RobotStore({ dataDir: process.env.ROBOTEAM_DATA_DIR });
    await store.ensureDefaultRobot(); await store.create({ name: 'analyst' });
    await prepareCopilotContext('default', { prepareTools: false, dataDir: store.dataDir });
    const sessions = new ConversationSessionStore({ workingDir: one });
    const first = await sessions.ensureCurrentSession();
    const other = await new ConversationSessionStore({ workingDir: two }).ensureCurrentSession();
    assert.notEqual(first.sessionId, other.sessionId);
    assert.equal(other.cwd, two);
    assert.equal(sessions.listSessions().sessions.length, 1);
    await prepareCopilotContext('analyst', { prepareTools: false, dataDir: store.dataDir });
    const analyst = new ConversationSessionStore({ workingDir: one });
    assert.equal(analyst.listSessions().sessions.length, 1);
    assert.equal((await analyst.resumeSession(first.sessionId)).sessionId, first.sessionId);
    await store.delete((await store.getByName('analyst')).id);
    assert.equal(new ConversationSessionStore({ workingDir: one }).loadSession(first.sessionId).sessionId, first.sessionId);
    await assert.rejects(fs.stat(path.join(store.robotPath((await store.getByName('default')).id), 'copilot')), { code: 'ENOENT' });
});

test('the AI task child prepares nothing in RoboTeam\'s old robot home; the terminal REPL and the catalog tool still do', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-task-home-'));
    const keys = ['ROBOTEAM_COPILOT_ROOT', 'ROBOTEAM_COPILOT_ROBOT_ID', 'ROBOTEAM_COPILOT_ROBOT_NAME', 'ACHILLES_ALA_HOME', 'ACHILLES_ALA_COMMAND', 'PLOINKY_WORKSPACE_ROOT'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(async () => {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    delete process.env.ACHILLES_ALA_HOME;
    const store = new RobotStore({ dataDir: path.join(root, 'data') });
    const robot = await store.create({ name: 'worker' });
    const home = path.join(store.robotPath(robot.id), 'home');
    const listing = async () => (await fs.readdir(home, { recursive: true })).sort();
    // Robot creation prepares the home for the Terminal and workstations; start from an empty one to see what each call adds.
    await fs.rm(home, { recursive: true, force: true });
    await fs.mkdir(home, { mode: 0o700 });
    const before = await listing();
    assert.deepEqual(before, []);
    // Exactly the call server/robot-task.mjs makes.
    const context = await prepareCopilotContext('worker', { dataDir: store.dataDir, prepareTools: false, holdUsage: true, prepareHome: false });
    await context.releaseUsage();
    assert.deepEqual(await listing(), before, 'no shell profile, plugin, agent directory or configuration is created in the old home');
    assert.equal(process.env.ACHILLES_ALA_HOME, undefined, 'no local ALA home is exported');
    assert.equal(context.robot.id, robot.id);
    // The default (terminal REPL, catalog tool) still prepares the robot's own home.
    await prepareCopilotContext('worker', { dataDir: store.dataDir, prepareTools: false });
    const prepared = await listing();
    assert.ok(prepared.length > before.length && prepared.includes('.roboteam-env.sh'), 'the default call prepares the shell home');
    assert.match(await fs.readFile(new URL('../server/robot-task.mjs', import.meta.url), 'utf8'), /prepareCopilotContext\([^)]*prepareHome: false/u, 'the task child makes that call');
});

test('catalog listing reuses a valid prepared shell generation without npm lookups and falls back otherwise', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-prepared-tools-'));
    const keys = ['ROBOTEAM_DATA_DIR', 'ROBOTEAM_COPILOT_ROOT', 'ROBOTEAM_COPILOT_ROBOT_ID',
        'ROBOTEAM_COPILOT_ROBOT_NAME', 'ACHILLES_ALA_HOME', 'ACHILLES_ALA_COMMAND',
        'CODEX_BIN', 'PI_BIN', 'OPENCODE_BIN', 'CLAUDE_BIN', 'PATH', 'PLOINKY_WORKSPACE_ROOT'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(async () => {
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.ROBOTEAM_DATA_DIR = root;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    await new RobotStore({ dataDir: root }).ensureDefaultRobot();
    const cacheRoot = path.join(root, 'tool-cache');
    const generation = path.join(cacheRoot, 'shell-generations', 'g1');
    let piBin;
    await fs.mkdir(path.join(generation, 'bin'), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, 'shell-selections'), { recursive: true });
    for (const name of ['codex', 'opencode', 'pi', 'claude']) {
        const id = name[0].repeat(64).replace(/[^0-9a-f]/g, 'e');
        const bin = path.join(cacheRoot, name, 'generations', id, 'bin');
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const stamp = JSON.stringify({ schema: 'roboteam-tool-cache-v1', name, generation: id, versions: { [name]: '1.0.0' } });
        await fs.writeFile(path.join(cacheRoot, name, 'generations', id, 'stamp.json'), stamp);
        await fs.writeFile(path.join(cacheRoot, name, 'current.json'), stamp);
        await fs.symlink(path.relative(path.join(generation, 'bin'), path.join(bin, name)), path.join(generation, 'bin', name));
        if (name === 'pi') piBin = path.join(bin, name);
    }
    await fs.symlink('../shell-generations/g1', path.join(cacheRoot, 'shell-selections', 'shell'));

    const calls = [];
    const make = () => new ToolCache({ root: cacheRoot, log: () => {}, versionPins: {},
        execFileImpl: async (command, args) => { calls.push([command, ...args]); return { stdout: '"9.9.9"' }; } });
    delete process.env.ROBOTEAM_COPILOT_ROOT;

    await prepareCopilotContext('default', { dataDir: root, usePreparedTools: true, toolCache: make() });
    assert.deepEqual(calls, []);
    const selected = robotCodingAgents(await new RobotStore({ dataDir: root }).getByName('default'));
    assert.ok(selected.length > 0);
    const generationBin = (name) => path.join(cacheRoot, name, 'generations', name[0].repeat(64).replace(/[^0-9a-f]/g, 'e'), 'bin');
    for (const name of selected) assert.equal(process.env[`${name.toUpperCase()}_BIN`], path.join(generationBin(name), name));
    // Only the robot's selected agents are visible; the aggregate selection bin is not on PATH.
    const entries = process.env.PATH.split(path.delimiter);
    assert.ok(!entries.includes(path.join(cacheRoot, 'shell-selections', 'shell', 'bin')));
    for (const name of ['codex', 'opencode', 'pi', 'claude']) {
        assert.equal(entries.includes(generationBin(name)), selected.includes(name), name);
    }

    // A single-agent robot must not see the other agents through the prepared path.
    await new RobotStore({ dataDir: root }).create({ name: 'solo', codingAgents: ['opencode'] });
    for (const name of ['codex', 'opencode', 'pi', 'claude']) delete process.env[`${name.toUpperCase()}_BIN`];
    process.env.PATH = previous.PATH;
    await prepareCopilotContext('solo', { dataDir: root, usePreparedTools: true, toolCache: make() });
    const solo = process.env.PATH.split(path.delimiter);
    for (const name of ['codex', 'opencode', 'pi', 'claude']) assert.equal(solo.includes(generationBin(name)), name === 'opencode', name);
    assert.equal(process.env.CODEX_BIN, undefined);
    assert.ok(!solo.includes(path.join(cacheRoot, 'shell-selections', 'shell', 'bin')));

    // Validation runs on every call: a broken executable invalidates the generation.
    await fs.rm(piBin);
    assert.equal(await make().peekShellTools(), null);
    await assert.rejects(prepareCopilotContext('default', { dataDir: root, usePreparedTools: true, toolCache: make() }));
    assert.ok(calls.some((call) => call.includes('view')), 'npm lookup runs when no valid generation exists');

    // Callers that do not opt in keep the existing preparation path.
    calls.length = 0;
    await fs.writeFile(piBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await prepareCopilotContext('default', { dataDir: root, toolCache: make() });
    assert.ok(calls.some((call) => call.includes('view')));
});

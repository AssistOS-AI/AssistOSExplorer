import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodingAgentStatus } from '../server/coding-agent-status.mjs';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';

async function tempHome(t) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-agent-logins-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    return home;
}

async function write(home, file, content) {
    await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await fs.writeFile(path.join(home, file), typeof content === 'string' ? content : JSON.stringify(content));
}

const UNKNOWN = { codex: 'unknown', opencode: 'unknown', pi: 'unknown', claude: 'unknown' };

// Decision M-56: login detection ran ALA against the robot's old home; until it moves to a worker utility execution (T5) every
// login is 'unknown' and nothing is read from the home for it.
test('every login is unknown, whatever the old home holds, and the home is not read for it', async (t) => {
    const home = await tempHome(t);
    await write(home, '.codex/auth.json', { tokens: { access_token: 'a', refresh_token: 'r' } });
    await write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    const status = createCodingAgentStatus();
    assert.deepEqual(await status.logins(home), UNKNOWN);
    await fs.rm(path.join(home, '.codex'), { recursive: true });
    assert.deepEqual(await status.logins(home), UNKNOWN);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-server';
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    assert.deepEqual(await status.logins(await tempHome(t)), UNKNOWN);
});

test('the module loads no ALA', async () => {
    const source = await fs.readFile(new URL('../server/coding-agent-status.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /alaInstallation|alaEnvironment|detectCodingAgentLogin|codingAgentLoginFiles/u);
});

// Decision M-10: the robot's agent comes from RoboTeam's record, exactly as RobotModels.config reads it; the robot's old home is
// never read. A home that holds an ALA config naming another agent, and a home that does not exist, give the same answer.
test('the agent in use is the first enabled one of the robot record and the old home is never read', async (t) => {
    const home = await tempHome(t);
    await write(home, '.ala/config.json', { codingAgent: 'opencode', models: {}, efforts: {} });
    const status = createCodingAgentStatus();
    const reads = [];
    for (const method of ['lstat', 'readFile', 'stat', 'open', 'readdir']) {
        const original = fs[method];
        t.mock.method(fs, method, async (...args) => { reads.push([method, String(args[0])]); return original.apply(fs, args); });
    }
    assert.equal(await status.activeAgent({ codingAgents: ['codex', 'opencode'] }), 'codex');
    assert.equal(await status.activeAgent({ codingAgents: ['claude'] }), 'claude');
    assert.equal(await status.activeAgent({ codingAgents: [] }), null);
    assert.equal(await status.activeAgent({}), null);
    assert.deepEqual(reads, [], 'no file is read for the agent');
    const { RobotModels } = await import('../server/robot-models.mjs');
    const robot = { id: 'r', codingAgents: ['codex', 'opencode'] };
    const models = new RobotModels({ robotStore: { get: async () => robot }, runtimeManager: {} });
    assert.equal((await models.config(robot)).codingAgent, await status.activeAgent(robot), 'the same answer as the settings');
});

test('the robot listing names the agent in use and keeps logins from non-administrators', async (t) => {
    const root = await tempHome(t);
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    t.after(() => { if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous; });
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const robot = await robotStore.create({ name: 'Scout', codingAgents: ['opencode', 'claude'] });
    await write(path.join(robotStore.robotPath(robot.id), 'home'), '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a' } });
    // The old home names another agent; the listing takes the robot record's.
    await write(path.join(robotStore.robotPath(robot.id), 'home'), '.ala/config.json', { codingAgent: 'claude', models: {}, efforts: {} });
    const runtimeManager = { workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const answer = await (await fetch(`http://127.0.0.1:${server.address().port}/api/robots`, {
        headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent' } })).json();
    const listed = answer.robots.find(entry => entry.id === robot.id);
    assert.equal(answer.canAdmin, false);
    assert.equal(listed.codingAgent, 'opencode');
    assert.equal('codingAgentLogins' in listed, false);
});

test('worker login projection uses the worker robot id and unavailable status stays unknown', async () => {
    const calls = [];
    const status = createCodingAgentStatus({ robotStore: { get: async () => ({ worker: { robotId: 'worker-id' } }) }, workerClient: {
        agentStatus: async (id) => { calls.push(id); return { agents: [{ name: 'codex', loggedIn: true }, { name: 'claude', loggedIn: false }] }; },
    } });
    assert.deepEqual(await status.logins('local-id'), { codex: true, claude: false, opencode: 'unknown', pi: 'unknown' });
    assert.deepEqual(calls, ['worker-id']);
});

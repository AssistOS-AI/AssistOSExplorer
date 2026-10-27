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

const NONE = { codex: false, opencode: false, pi: false, claude: false };

test('an empty home has no coding-agent login', async (t) => {
    assert.deepEqual(await createCodingAgentStatus().logins(await tempHome(t)), NONE);
});

test('each agent counts as logged in through ALA when its own credential store holds something', async (t) => {
    const home = await tempHome(t);
    await write(home, '.codex/auth.json', { OPENAI_API_KEY: null, tokens: { access_token: 'a', refresh_token: 'r' }, last_refresh: 'x' });
    await write(home, '.local/share/opencode/auth.json', { deepseek: { type: 'api', key: 'k' } });
    await write(home, '.pi/agent/auth.json', { anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    await write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    assert.deepEqual(await createCodingAgentStatus().logins(home), { codex: true, opencode: true, pi: true, claude: true });
});

test('a changed file is read again and an unchanged one is served from the cache', async (t) => {
    const home = await tempHome(t);
    const status = createCodingAgentStatus();
    assert.equal((await status.logins(home)).pi, false);
    await write(home, '.pi/agent/auth.json', { openai: { type: 'api_key', key: 'k' } });
    assert.equal((await status.logins(home)).pi, true);
    await fs.rm(path.join(home, '.pi/agent/auth.json'));
    assert.equal((await status.logins(home)).pi, false);
});

test('a credential variable of the server is never a robot login', async (t) => {
    const home = await tempHome(t);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-server';
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    assert.deepEqual(await createCodingAgentStatus().logins(home), NONE);
});

test('without a loadable ALA the logins are reported absent and the failure is logged once', async (t) => {
    const home = await tempHome(t);
    await write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a' } });
    const lines = [];
    let attempts = 0;
    const status = createCodingAgentStatus({ installation: async () => { attempts += 1; throw new Error('ALA is missing'); }, log: line => lines.push(line) });
    assert.deepEqual(await status.logins(home), NONE);
    assert.deepEqual(await status.logins(home), NONE);
    assert.equal(attempts, 2, 'a failed load is retried');
    assert.deepEqual(lines, ['[roboTeam] coding-agent logins are unavailable: ALA is missing']);
    const older = createCodingAgentStatus({ installation: async () => ({ loadConfig() {} }), log: line => lines.push(line) });
    assert.deepEqual(await older.logins(home), NONE);
    assert.match(lines.at(-1), /this ALA has no coding-agent login detection/);
});

test('the agent in use is the configured one when the robot has it enabled', async (t) => {
    const home = await tempHome(t);
    const status = createCodingAgentStatus();
    assert.equal(await status.activeAgent(home, ['codex', 'opencode']), 'codex');
    await write(home, '.ala/config.json', { codingAgent: 'opencode', models: {}, efforts: {} });
    assert.equal(await status.activeAgent(home, ['codex', 'opencode']), 'opencode');
    assert.equal(await status.activeAgent(home, ['claude']), 'claude', 'a disabled configured agent falls back to the first enabled one');
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
    const robot = await robotStore.create({ name: 'Scout', codingAgents: ['opencode'] });
    await write(path.join(robotStore.robotPath(robot.id), 'home'), '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a' } });
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

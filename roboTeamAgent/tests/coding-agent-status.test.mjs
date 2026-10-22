import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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

test('each agent counts as logged in only when its own credential store holds something', async (t) => {
    const home = await tempHome(t);
    await write(home, '.codex/auth.json', { OPENAI_API_KEY: null, tokens: { access_token: 'a', refresh_token: 'r' }, last_refresh: 'x' });
    await write(home, '.local/share/opencode/auth.json', { deepseek: { type: 'api', key: 'k' } });
    await write(home, '.pi/agent/auth.json', { anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    await write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    assert.deepEqual(await createCodingAgentStatus().logins(home), { codex: true, opencode: true, pi: true, claude: true });
});

test('bookkeeping without credentials is not a login', async (t) => {
    const home = await tempHome(t);
    await write(home, '.codex/auth.json', { OPENAI_API_KEY: null, tokens: null, last_refresh: '2026-01-01' });
    await write(home, '.local/share/opencode/auth.json', {});
    await write(home, '.pi/agent/auth.json', { openai: { type: 'api_key' } });
    await write(home, '.claude/.claude.json', { oauthAccount: null, numStartups: 3 });
    await write(home, '.claude/.credentials.json', 'not json');
    assert.deepEqual(await createCodingAgentStatus().logins(home), NONE);
});

test('a Claude API key and an OpenCode Console account count as logins', async (t) => {
    const home = await tempHome(t);
    await write(home, '.claude/.claude.json', { primaryApiKey: 'sk-ant' });
    await fs.mkdir(path.join(home, '.local/share/opencode'), { recursive: true });
    const database = new DatabaseSync(path.join(home, '.local/share/opencode/opencode.db'));
    database.exec('CREATE TABLE account_state (id INTEGER, active_account_id TEXT, active_org_id TEXT); CREATE TABLE credential (id TEXT);');
    database.prepare('INSERT INTO account_state VALUES (1, ?, NULL)').run('acc_1');
    database.close();
    assert.deepEqual(await createCodingAgentStatus().logins(home), { ...NONE, opencode: true, claude: true });
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

test('a FIFO or oversized file at a credential path is never read', async (t) => {
    const home = await tempHome(t);
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(home, '.codex/auth.json')]);
    await write(home, '.pi/agent/auth.json', 'x'.repeat(5 * 1024 * 1024));
    assert.deepEqual(await createCodingAgentStatus().logins(home), NONE);
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

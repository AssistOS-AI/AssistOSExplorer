import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/alaInstallation.mjs';
import { prepareCopilotContext } from '../server/copilot-context.mjs';
import { ToolCache } from '../server/tool-cache.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/conversationSessionStore.mjs';

test('copilot cache preparation is silent but preparation failures remain visible', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-cache-output-'));
    const keys = ['ROBOTEAM_DATA_DIR', 'ROBOTEAM_COPILOT_ROOT', 'ROBOTEAM_COPILOT_ROBOT_ID',
        'ROBOTEAM_COPILOT_ROBOT_NAME', 'ACHILLES_ALA_HOME', 'ACHILLES_ALA_COMMAND',
        'CODEX_BIN', 'PI_BIN', 'OPENCODE_BIN', 'PATH'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(async () => {
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.ROBOTEAM_DATA_DIR = root;
    await new RobotStore({ dataDir: root }).ensureDefaultRobot();
    const output = [];
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => output.push(args));
    let fail = false;
    t.mock.method(ToolCache.prototype, 'prepareCodingAgents', async function () {
        for (const name of ['codex', 'pi', 'opencode']) this.log(`[tool-cache] using ${name} cache generation example`);
        if (fail) throw new Error('cache preparation failed');
        return Object.fromEntries(['codex', 'pi', 'opencode'].map((name) => [name, { binPath: '/cached/bin' }]));
    });
    await prepareCopilotContext('default');
    assert.deepEqual(output, []);
    assert.equal(process.env.CODEX_BIN, '/cached/bin/codex');
    fail = true;
    await assert.rejects(prepareCopilotContext('default'), /cache preparation failed/);
    assert.deepEqual(output, []);
});

test('robot chat state is isolated and opening another cwd does not reuse the wrong conversation', async (t) => {
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
    await prepareCopilotContext('default', { prepareTools: false });
    const sessions = new ConversationSessionStore({ workingDir: one });
    const first = await sessions.ensureCurrentSession();
    const other = await new ConversationSessionStore({ workingDir: two }).ensureCurrentSession();
    assert.notEqual(first.sessionId, other.sessionId);
    assert.equal(other.cwd, two);
    assert.equal(sessions.listSessions().sessions.length, 2);
    await prepareCopilotContext('analyst', { prepareTools: false });
    const analyst = new ConversationSessionStore({ workingDir: one });
    assert.equal(analyst.listSessions().sessions.length, 0);
    await assert.rejects(analyst.resumeSession(first.sessionId), /ENOENT/);
});

test('task runner uses robot home, persists a conversation, and resumes its native session', { timeout: 15000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-copilot-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    const fake = path.join(root, 'ala');
    const real = await resolveAlaInstallation();
    await Promise.all([fs.mkdir(workspace), fs.mkdir(path.join(fake, 'src/coding-agents'), { recursive: true })]);
    await fs.writeFile(path.join(fake, 'package.json'), '{"name":"advanced-language-agent","type":"module"}');
    const entry = path.join(fake, 'ala.mjs');
    await fs.copyFile(new URL('../copilot/tests/fixtures/ala-engine-child.mjs', import.meta.url), entry);
    for (const module of ['repositories.mjs', 'anthropic-skills.mjs', 'coding-agents/service.mjs']) {
        await fs.writeFile(path.join(fake, 'src', module), `export * from ${JSON.stringify(pathToFileURL(path.join(real.packageRoot, 'src', module)).href)};`);
    }
    await fs.writeFile(path.join(fake, 'src/coding-agents/discovery.mjs'),
        `export async function discoverCodingAgents() { return [{ name: 'codex', binary: process.execPath, available: true }]; }`);
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'worker' });
    const sessionId = randomUUID();
    const taskFile = path.join(root, 'task.txt');
    const run = async (prompt, resume = false) => {
        await fs.writeFile(taskFile, prompt);
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [fileURLToPath(new URL('../server/robot-task.mjs', import.meta.url)),
                '--robot', robot.name, '--cwd', workspace, '--session-id', sessionId, '--ca', 'codex',
                '--taskFile', taskFile, ...(resume ? ['--resume-session'] : [])], {
                env: { ...process.env, ROBOTEAM_DATA_DIR: dataDir, ROBOTEAM_ALA_COMMAND: entry,
                    PLOINKY_WORKSPACE_ROOT: workspace }, stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stdout = ''; let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code !== 0) reject(new Error(stderr));
                else resolve({ output: JSON.parse(stdout), stderr });
            });
        });
    };
    const first = await run('First');
    assert.equal(first.output.resumed, false);
    assert.match(first.stderr, /session-ready/);
    const sessionPath = path.join(store.robotPath(robot.id), 'copilot/sessions', `${sessionId}.json`);
    const firstSession = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    assert.equal(firstSession.engine.home, path.join(store.robotPath(robot.id), 'home'));
    assert.equal(firstSession.cwd, workspace);
    const second = await run('Follow up', true);
    assert.equal(second.output.resumed, true);
    assert.equal(second.output.prompt.includes('First'), false);
    const continued = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    assert.equal(continued.messages.filter((message) => message.role === 'user').length, 2);
    assert.deepEqual(continued.skillSelection, firstSession.skillSelection);
    await assert.rejects(fs.stat(path.join(workspace, '.data/achilles-cli')), /ENOENT/);
});

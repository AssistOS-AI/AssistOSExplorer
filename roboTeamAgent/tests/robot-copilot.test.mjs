import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';
import { prepareCopilotContext } from '../server/copilot-context.mjs';
import { ToolCache } from '../server/tool-cache.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';

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
    t.mock.method(ToolCache.prototype, 'prepareShellTools', async function (names) {
        for (const name of ['codex', 'pi', 'opencode']) this.log(`[tool-cache] using ${name} cache generation example`);
        if (fail) throw new Error('cache preparation failed');
        assert.deepEqual(names, ['opencode']);
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
    // The fixture imports RoboTeam modules relatively, so the fake entry loads it in place by URL.
    await fs.writeFile(entry, `import ${JSON.stringify(new URL('../copilot/tests/fixtures/ala-engine-child.mjs', import.meta.url).href)};\n`);
    for (const module of ['config.mjs', 'coding-agents/service.mjs']) {
        await fs.writeFile(path.join(fake, 'src', module), `export * from ${JSON.stringify(pathToFileURL(path.join(real.packageRoot, 'src', module)).href)};`);
    }
    await fs.writeFile(path.join(fake, 'src/coding-agents/discovery.mjs'),
        `export async function discoverCodingAgents() { return [{ name: 'codex', binary: process.execPath, available: true }]; }`);
    // The required human-report skill comes from a local DocumentationSkills repository.
    const docs = path.join(root, 'DocumentationSkills');
    await fs.mkdir(path.join(docs, 'skills/human-report'), { recursive: true });
    await fs.writeFile(path.join(docs, 'skills/human-report/SKILL.md'), '---\nname: human-report\ndescription: Write the final report.\n---\nReport outcomes.\n');
    const docsReal = await fs.realpath(docs);
    const clientFile = path.join(root, 'ploinky/Agent/client/RepositoryClient.mjs');
    await fs.mkdir(path.dirname(clientFile), { recursive: true });
    await fs.writeFile(clientFile, `import fs from 'node:fs/promises';
import path from 'node:path';
export const createRepositoryClient = () => ({
    listRepositories: async () => [{ name: 'DocumentationSkills', source: ${JSON.stringify(docsReal)}, origin: 'local' }],
    install: async ({ repos = [], skillRepos }) => {
        for (const entry of skillRepos) await fs.mkdir(path.join(entry.destination, '.agents/skills'), { recursive: true });
        // Like the real client, publish each skill as a link to its repository source; reruns keep matching links.
        for (const entry of repos) {
            if (entry.repoName !== 'DocumentationSkills') throw new Error('Unknown repository ' + entry.repoName);
            const target = path.join(${JSON.stringify(docsReal)}, entry.sourcePath);
            const current = await fs.readlink(entry.destination).catch(() => null);
            if (current !== target) await fs.symlink(target, entry.destination);
        }
        return { conflicts: [] };
    },
    remove: async () => ({ conflicts: [] }),
});`);
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'worker' });
    const sessionId = randomUUID();
    const run = async (prompt, resume = false) => {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e',
                `import { runRobotTask } from ${JSON.stringify(new URL('../server/robot-task.mjs', import.meta.url).href)}; await runRobotTask(process.argv.slice(2), ${JSON.stringify({ dataDir, alaCommand: entry })});`,
                '--', fileURLToPath(import.meta.url), '--robot', robot.name, '--cwd', workspace, '--session-id', sessionId, '--ca', 'codex',
                ...(resume ? ['--resume-session'] : [])], {
                env: { ...process.env,
                    PLOINKY_WORKSPACE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
            });
            // The task prompt is the first record on the runner's stdin.
            child.stdin.end(`${JSON.stringify({ type: 'prompt', prompt })}\n`);
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
    const sessionPath = path.join(workspace, '.roboteam/sessions', `${sessionId}.json`);
    const firstSession = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    assert.equal(firstSession.engine.home, await fs.realpath(path.join(dataDir, 'robots', robot.id, 'home')));
    assert.equal(firstSession.cwd, workspace);
    const second = await run('Follow up', true);
    assert.equal(second.output.resumed, true);
    assert.equal(second.output.prompt.includes('First'), false);
    const continued = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    // Conversation text lives in ALA's transcript; the store composes it with the session metadata.
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    let conversation;
    try { conversation = new ConversationSessionStore({ workingDir: workspace }).loadSession(sessionId); }
    finally { if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot; }
    assert.equal(conversation.messages.filter((message) => message.role === 'user').length, 2);
    assert.deepEqual(continued.skillSelection, firstSession.skillSelection);
    // The live skill execution (the required human-report skill) is unchanged by the resumed turn.
    assert.deepEqual(firstSession.skillExecution.entries.map((entry) => entry.name), ['human-report']);
    assert.deepEqual(continued.skillExecution.entries, firstSession.skillExecution.entries);
    await assert.rejects(fs.stat(path.join(workspace, '.data/achilles-cli')), /ENOENT/);
});

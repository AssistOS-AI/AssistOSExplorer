import test from 'node:test';
import '../copilot/tests/helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { workspaceCodePath } from '../copilot/src/lib/execution/workspaceCodePath.mjs';
import { createWorkerEngine } from '../copilot/src/lib/execution/workerEngine.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { planAlaExecution } from '../../robo-work/server/runtime/alaPlan.mjs';
import { createExecutionChannels } from '../../robo-work/server/runtime/channels.mjs';
import { reportTaskBlocked } from '../copilot/src/skills/report-task-blocked/scripts/run.mjs';
import { requireHumanInput } from '../copilot/src/skills/require-human-input/scripts/run.mjs';

// The worker-hosted task-failure and human-input channels (decision M-14), seen from RoboTeam: the skill scripts reach the
// worker's channel directories by `--directory`, the prompt's granted paths are the worker plan's, and the manager forwards the
// child's question to RoboFlow.
const toolCache = {
    root: '/cache',
    prepareShellTools: async (names = ['codex']) => ({ root: '/cache', path: '/cache/g', binPath: '/cache/g/bin', agents: Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
    prepareCodingAgents: async (names = ['codex']) => Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin`, versions: {} }])),
};

test('the bundled skill scripts reach the worker\'s channel layout by --directory, and default to the local paths otherwise', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-channels-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const recorded = { failure: null, question: null };
    const channels = await createExecutionChannels({ directory,
        taskFailure: async (value) => { recorded.failure = value; return {}; },
        humanInput: async (value) => { recorded.question = value; return { id: 'x'.repeat(20), requestId: 'x'.repeat(20) }; } });
    t.after(() => channels.close());
    // The worker mounts this directory at /run/robo-work/channels; the scripts are pointed at <channels>/<channel>.
    const failure = await reportTaskBlocked({ message: 'No credentials.' }, { directory: path.join(directory, 'task-failure') });
    assert.equal(failure.ok, true);
    assert.deepEqual(recorded.failure, { message: 'No credentials.' });
    const asked = await requireHumanInput({ question: 'Which?', options: ['a', 'b', 'c'] }, { directory: path.join(directory, 'human-input') });
    assert.equal(asked.ok, true);
    assert.deepEqual(recorded.question, { question: 'Which?', options: ['a', 'b', 'c'] });
    // The command line honours --directory, and without it the local default is untouched (local mode unchanged).
    const { execFile } = await import('node:child_process');
    const run = (script, args) => new Promise((resolve) => execFile(process.execPath, [fileURLToPath(new URL(`../copilot/src/skills/${script}/scripts/run.mjs`, import.meta.url)), ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
    const viaCli = await run('report-task-blocked', ['--directory', path.join(directory, 'task-failure'), '--input', '{"message":"From the command line"}']);
    assert.equal(viaCli.code, 0);
    assert.deepEqual(recorded.failure, { message: 'From the command line' });
    const local = await run('report-task-blocked', ['--input', '{"message":"x"}']);
    assert.match(local.stderr, /not available for this execution/);
});

test('the granted skill path in the prompt is the worker plan\'s own virtual path, with a project and without', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-channel-plan-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const skillsBase = path.join(root, '.ploinky', 'repos', 'AchillesIDE', 'roboTeamAgent', 'copilot', 'src', 'skills');
    const skills = [];
    for (const name of ['report-task-blocked', 'require-human-input']) { await fs.mkdir(path.join(skillsBase, name), { recursive: true }); skills.push({ name, skillDir: path.join(skillsBase, name), enabled: true }); }
    await fs.mkdir(path.join(root, 'proj'), { recursive: true });
    const old = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => { if (old === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = old; });
    for (const project of [null, 'proj']) {
        const workingDir = project ? path.join(root, project) : root;
        const store = new ConversationSessionStore({ workingDir });
        const session = await store.createSession();
        const admitted = [];
        const engine = createWorkerEngine({ workingDir, sessionStore: store,
            client: { async subscribe() { return (async function* done() { yield { seq: 1, kind: 'state', state: 'completed' }; }()); }, async read() { return { state: 'completed', result: { outputText: 'ok' } }; }, async control() { return {}; } },
            skillCatalog: { async refresh() { return { skills, taskRepositories: [] }; } },
            provisioner: { ensureReady: async () => ({ robotId: 'AAAAAAAAAAAAAAAAAAAAAA', configRevision: 1, configuration: { backend: 'codex', settings: {} } }), desiredConfiguration: () => ({}) },
            getRobot: async () => ({ id: 'robo' }), settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' },
            interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
            execution: { robotId: 'robo', workflowExecution: true, humanInput: true }, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
        t.after(() => engine.close());
        const grant = `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.s`;
        await engine.executeTurn({ sessionId: session.sessionId, prompt: 'p',
            owner: { coordinator: { async admitTurn(evidence, request) { admitted.push(request); return { status: 200, body: { taskRef: { id: 'r'.repeat(22) }, state: 'queued', originRequestId: 'x' } }; } }, evidence: { ok: true, principal: 'user:alice', grant } } });
        const spec = admitted[0].specification;
        const plan = planAlaExecution({ specification: spec, workspaceRoot: root });
        assert.equal(plan.cwd, project ? '/projects/g0' : '/home/robot');
        for (const [skill, label] of [['report-task-blocked', 'task-failure'], ['require-human-input', 'human-input']]) {
            const [, virtual] = new RegExp(`Read (/projects/g\\d+)/SKILL\\.md\\.[^\\n]*channels/${label}`).exec(spec.prompt) ?? [];
            assert.ok(virtual, `${label} skill path is in the prompt`);
            const grantEntry = plan.grants.find((entry) => entry.path === virtual);
            assert.equal(grantEntry.hostPath, path.join(skillsBase, skill), `${virtual} is the ${skill} folder in the worker's plan (project: ${project})`);
            assert.equal(grantEntry.access, 'read');
        }
    }
});

test('a bundled skill folder is granted by its managed-repository workspace path, only when both spellings are the same folder', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-code-path-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const code = path.join(root, 'outside-code');
    const projected = path.join(root, '.ploinky', 'repos', 'AchillesIDE', 'roboTeamAgent', 'copilot', 'src', 'skills', 'report-task-blocked');
    await fs.mkdir(path.join(code, 'copilot', 'src', 'skills', 'report-task-blocked'), { recursive: true });
    await fs.mkdir(projected, { recursive: true });
    // `code` is inside this temporary root, so use a workspace root that excludes it.
    const workspace = path.join(root, 'ws');
    await fs.mkdir(path.join(workspace, '.ploinky', 'repos'), { recursive: true });
    await fs.rename(path.join(root, '.ploinky', 'repos', 'AchillesIDE'), path.join(workspace, '.ploinky', 'repos', 'AchillesIDE'));
    const source = path.join(code, 'copilot', 'src', 'skills', 'report-task-blocked');
    const env = { PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent' };
    const expected = path.join(workspace, '.ploinky', 'repos', 'AchillesIDE', 'roboTeamAgent', 'copilot', 'src', 'skills', 'report-task-blocked');
    const same = async () => ({ isDirectory: () => true, dev: 1, ino: 2 });
    assert.equal(await workspaceCodePath(source, { workspaceRoot: workspace, env, codeRoot: code, stat: same }), expected);
    // Two different folders (a real inode mismatch) are never aliased.
    assert.equal(await workspaceCodePath(source, { workspaceRoot: workspace, env, codeRoot: code }), null);
    assert.equal(await workspaceCodePath(source, { workspaceRoot: workspace, env: {}, codeRoot: code, stat: same }), null, 'no agent identity, no projection');
    assert.equal(await workspaceCodePath(path.join(workspace, '.ploinky'), { workspaceRoot: workspace, env, codeRoot: code }), path.join(workspace, '.ploinky'), 'a path already in the workspace is returned as it is');
    assert.equal(await workspaceCodePath(root, { workspaceRoot: workspace, env, codeRoot: code, stat: same }), null, 'neither in the workspace nor in the code root');
});

// ---- the manager: the question from the child goes to RoboFlow; the worker hosts the channel ----
async function workerTask(t, { requestHumanInput }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-hi-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'asker-a1b2c3', name: 'Asker' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const spawned = [];
    const spawnImpl = (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.stdin = new PassThrough();
        spawned.push({ child, args, env: options.env });
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, workerMode: true, toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    manager.requestHumanInput = requestHumanInput;
    t.after(() => manager.stopAll());
    const accepted = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', allowsHumanInput: true });
    while (!spawned.length) await new Promise((resolve) => setTimeout(resolve, 5));
    return { manager, robot, accepted, child: spawned[0], settled: async () => { while (!['completed', 'failed', 'paused'].includes(manager.taskStatus(robot.id, accepted.taskId).state)) await new Promise((resolve) => setTimeout(resolve, 5)); return manager.taskStatus(robot.id, accepted.taskId); } };
}
const event = (value) => `@@ALA_EVENT@@${JSON.stringify(value)}\n`;
const QUESTION = { type: 'human-input-request', requestId: 'q'.repeat(20), question: 'Which?', options: ['a', 'b', 'c'], referenceId: 'r'.repeat(22) };

test('in worker mode the child asks for the worker channel (--human-input), no local channel exists, and its question is forwarded to RoboFlow', async (t) => {
    const asked = [];
    const f = await workerTask(t, { requestHumanInput: async (taskId, input) => { asked.push({ taskId, input }); return { id: 'flow-question' }; } });
    assert.ok(f.child.args.includes('--human-input'));
    assert.equal(f.child.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY, undefined, 'no local channel directory');
    f.child.child.stderr.write(event(QUESTION));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(asked, [{ taskId: f.accepted.taskId, input: { question: 'Which?', options: ['a', 'b', 'c'], worker: { referenceId: 'r'.repeat(22), requestId: 'q'.repeat(20) } } }]);
    f.child.child.emit('close', 0, null);
    assert.equal((await f.settled()).state, 'completed', 'the child ended normally after the question');
});

test('a question RoboFlow refuses fails the task, because the model was told it was delivered', async (t) => {
    const f = await workerTask(t, { requestHumanInput: async () => { throw new Error('Human input is not allowed for this execution'); } });
    f.child.child.stderr.write(event(QUESTION));
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.child.child.emit('close', 0, null);
    const status = await f.settled();
    assert.equal(status.state, 'failed');
    assert.match(status.error, /not allowed/);
});

import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createCliRuntime } from '../src/index.mjs';
import { setRobotContext } from '../src/lib/execution/robotContext.mjs';
import { resolveAlaCommand } from '../../server/ala-command.mjs';

const alaRoot = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
const { openSessionState } = await import(pathToFileURL(path.join(alaRoot, 'src/session-state.mjs')).href);

const ROBOT = 'AAAAAAAAAAAAAAAAAAAAAA';
const REFERENCE = 'r'.repeat(22);
const ORIGIN = 'BBBBBBBBBBBBBBBBBBBBBA';
const BINDING = `flow_${'ab'.repeat(12)}`;
const configuration = { backend: 'codex', settings: { codingAgents: ['codex'] } };

// Exercise the actual runtime -> worker engine -> client path. Only the private Router
// libraries and worker HTTP responses are stand-ins; no native agent or model is started.
async function fixture(t, { nativeStarted = true } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-runtime-resume-')));
    const workingDir = path.join(root, 'project');
    await fs.mkdir(workingDir);
    const admissions = [];
    const launchErrors = [];
    let terminal = 'paused';
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        let reply;
        if (req.url.endsWith('/robots/get')) reply = { robotId: ROBOT, revision: 2, lifecycle: 'ready', ready: true, preparing: false, configuration };
        else if (req.url.endsWith('/admissions')) {
            admissions.push(body);
            try {
                const session = await openSessionState({ id: body.specification.sessionId,
                    sessionsRoot: path.join(root, 'worker-sessions'), resume: body.specification.resume === true });
                try {
                    if (nativeStarted) await session.save({ agent: 'codex', continuation: { threadId: 'native-thread' } });
                } finally { await session.close(); }
            } catch (error) { launchErrors.push(error.message); }
            reply = { taskRef: REFERENCE, state: 'queued' };
        } else if (req.url.endsWith('/events')) reply = { events: body.after ? [] : [
            { seq: 1, kind: 'ala', record: { type: 'coding-agent-selected', agent: 'codex', permissionMode: 'full-access' } },
            { seq: 2, kind: 'state', state: launchErrors.length ? 'failed' : terminal },
        ], nextAfter: 2 };
        else if (req.url.endsWith('/read')) reply = launchErrors.length
            ? { state: 'failed', result: { reason: 'ala_exit_5', outputText: launchErrors.at(-1) } }
            : { state: terminal, result: { classification: terminal, outputText: 'partial output' } };
        else throw new Error(`Unexpected request: ${req.url}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const runtimeRoot = path.join(root, 'Agent');
    await fs.mkdir(path.join(runtimeRoot, 'lib'), { recursive: true });
    await fs.mkdir(path.join(runtimeRoot, 'client'));
    await fs.writeFile(path.join(runtimeRoot, 'lib/agentAssertion.mjs'), 'export const signPrivateRouterAssertion = () => "test-assertion";');
    await fs.writeFile(path.join(runtimeRoot, 'client/generatedRouterDescriptor.mjs'),
        `export const loadVerifiedGeneratedRouterDescriptor = () => ({ payload: { internalRouterUrl: "http://127.0.0.1:${server.address().port}" } });`);
    const env = {
        PLOINKY_WORKSPACE_ROOT: root,
        ROBOTEAM_WORKER_COORDINATOR_BASE: '/base-agent-additional-server/robo-work/7311',
        PLOINKY_AGENT_RUNTIME_ROOT: runtimeRoot,
        PLOINKY_AGENT_PRIVATE_SECRET: 'a'.repeat(64),
        PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent',
        PLOINKY_AGENT_INSTANCE_ID: 'test-instance',
        PLOINKY_AGENT_ENABLE_GENERATION: 'test-generation',
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const robot = { id: 'robo', name: 'test', codingAgents: ['codex'], worker: { robotId: ROBOT } };
    const policy = { mode: 'live', policyVersion: 1 };
    setRobotContext({ robot, store: { dataDir: path.join(root, 'data'), get: async () => robot }, skillsets: {
        workspaceRoot: root,
        policies: { ensure: async () => policy, read: async () => policy },
        inventory: async () => ({ skills: [] }),
        live: { resolve: async () => ({ entries: [], diagnostics: [] }) },
        repositoriesClient: { listRepositories: async () => [] },
    } });
    const runtimes = [];
    t.after(async () => {
        for (const runtime of runtimes) await runtime.close();
        setRobotContext(null);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
        await fs.rm(root, { recursive: true, force: true });
    });
    return { admissions, launchErrors, setTerminal: value => { terminal = value; }, async open(options = {}) {
        const runtime = await createCliRuntime({ workingDir, ...options, execution: {
            permissions: 'full-access', worker: { bindingId: BINDING, originRequestId: ORIGIN },
        } }, { reattachExistingTasks: false });
        runtimes.push(runtime);
        return runtime;
    } };
}

test('explicit resume after failure before native start fails through the existing ALA contract', { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { nativeStarted: false });
    const first = await f.open();
    const sessionId = first.initialSession.sessionId;
    f.setTerminal('failed');
    await assert.rejects(first.engine.executeTurn({ sessionId, prompt: 'Start' }), /Worker execution failed/);
    assert.equal(f.admissions[0].specification.resume, undefined);
    const resumed = await f.open({ sessionId, resumeSession: true });
    f.setTerminal('completed');
    await assert.rejects(resumed.engine.executeTurn({ sessionId, prompt: 'Continue.' }), /ala_exit_5/);
    assert.deepEqual(f.launchErrors, ['ALA session cannot be resumed: it has no native continuation.']);
    assert.equal(f.admissions[1].specification.resume, true);
});

for (const prompt of ['Continue.', 'Please finish the remaining checks.']) {
    test(`a paused workflow task resumes its native session through createCliRuntime: ${prompt}`, { timeout: 10000 }, async (t) => {
        const f = await fixture(t);
        const first = await f.open();
        const sessionId = first.initialSession.sessionId;
        await assert.rejects(first.engine.executeTurn({ sessionId, prompt: 'Start the task' }), { name: 'AbortError' });
        assert.equal(first.sessionStore.loadSession(sessionId).messages.at(-1).status, 'interrupted');
        assert.equal(f.admissions[0].specification.resume, undefined, 'the first turn stays fresh');
        await first.close();
        f.setTerminal('completed');
        const resumed = await f.open({ sessionId, resumeSession: true });
        await resumed.engine.executeTurn({ sessionId, prompt });
        const [initial, continuation] = f.admissions;
        assert.equal(continuation.specification.resume, true, 'explicit task continuation reaches the worker even without a completed assistant');
        assert.equal(continuation.specification.sessionId, initial.specification.sessionId);
        assert.notEqual(continuation.specification.turnId, initial.specification.turnId);
        assert.equal(continuation.bindingId, BINDING);
        assert.equal(continuation.robotId, ROBOT);
        assert.equal(continuation.configRevision, initial.configRevision);
        assert.equal(continuation.specification.codingAgent, undefined, 'the bound native backend is retained');
        const other = await resumed.sessionStore.createSession();
        await resumed.engine.executeTurn({ sessionId: other.sessionId, prompt: 'Start a different conversation' });
        assert.equal(f.admissions[2].specification.resume, undefined, 'switching sessions in a resumed CLI keeps the new session fresh');
        assert.deepEqual(f.launchErrors, []);
    });
}

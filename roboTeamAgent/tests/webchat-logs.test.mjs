import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { registerProject } from '../server/project-storage.mjs';
import { resolveAlaCommand } from '../server/ala-command.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { pathToFileURL } from 'node:url';

const headers = () => ({ 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'actor', roles: ['admin'] } }) });

async function loadAla() {
    const root = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
    const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
    const [state, recorder] = await Promise.all([load('session-state.mjs'), load('transcript-recorder.mjs')]);
    return { ...state, ...recorder };
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-logs-'));
    const workspaceRoot = path.join(root, 'workspace');
    const project = path.join(workspaceRoot, 'project');
    await fs.mkdir(project, { recursive: true });
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const store = new ConversationSessionStore({ workingDir: project });
    const { sessionId } = await store.createSession();
    const dataDir = path.join(root, 'data');
    registerProject({ dataDir, workspaceRoot }, project);
    const ala = await loadAla();
    // Records one ALA turn and its RoboTeam metadata; returns the assistant message id.
    const recordTurn = async ({ messages = [], final = null, status = 'completed' } = {}) => {
        const turnId = randomUUID();
        const turn = await store.beginTurn({ sessionId, turnId, text: 'question' });
        const transcript = path.join(project, '.roboteam', '.ala', 'sessions', `${sessionId}.jsonl`);
        const exists = await fs.access(transcript).then(() => true, () => false);
        const state = await ala.openSessionState({ id: sessionId, sessionsRoot: path.join(project, '.roboteam', '.ala'), resume: exists });
        if (!exists) await state.save({ agent: 'codex', continuation: { threadId: 'thread' } });
        const recorder = ala.createTranscriptRecorder(state, turnId);
        await recorder.user('question');
        for (const message of messages) recorder.observe({ type: 'coding-agent-message', message, outputKind: 'output' });
        if (status !== 'pending') await recorder.finish({ result: final, status: status === 'completed' ? 'completed' : 'failed' });
        await state.close();
        if (status !== 'pending') await store.completeTurn(sessionId, turn.assistantMessageId, final || 'Not final', { status });
        return turn;
    };
    const first = await recordTurn({ messages: ['Reading `src/app.js`\nDone.'] });

    const robotStore = new RobotStore({ dataDir });
    await robotStore.initialize(); await robotStore.ensureDefaultRobot();
    const runtimeManager = { workspaceRoot, status: () => ({ state: 'stopped' }), resolveCwd: async () => project,
        startTask(robot, type, request) { return { taskId: request.runtimeTaskId, state: 'queued' }; }, stopTask() {}, activePort: () => null };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { request: (url, accept = 'text/plain') => fetch(base + url, { headers: { ...headers(), accept } }), sessionId,
        messageId: first.assistantMessageId, userMessageId: first.userMessageId, recordTurn };
}

test('the agent serves the coding-agent output ALA recorded for a turn', async t => {
    const f = await fixture(t);
    const response = await f.request(`/api/webchat/logs/${f.sessionId}/${f.messageId}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Reading `src\/app\.js`/);
    assert.equal((await f.request(`/api/webchat/logs/${f.sessionId}/${randomUUID()}`)).status, 404);
});

test('the agent serves the request-log page with the injected base', async t => {
    const f = await fixture(t);
    const response = await f.request(`/webchat-logs/${f.sessionId}/${f.messageId}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /webchat-logs\.js/);
    assert.match(html, /log-render\.js|phase-log/);
    assert.match(html, /<base href="\/rt\/">/);
});

test('thinking always returns plain text with final-response character offsets in headers', async t => {
    const f = await fixture(t);
    const final = '**Răspuns final ✅**';
    const answered = await f.recordTurn({ messages: ['Reading `src/app.js`\nDone.'], final });
    for (const accept of ['text/plain', 'application/json']) {
        const response = await f.request(`/api/webchat/logs/${f.sessionId}/${answered.assistantMessageId}`, accept);
        assert.match(response.headers.get('content-type'), /^text\/plain/);
        const log = await response.text();
        const offset = Number(response.headers.get('x-log-final-offset'));
        const length = Number(response.headers.get('x-log-final-length'));
        assert.equal(log.slice(offset, offset + length), final);
        assert.equal(log, 'Reading `src/app.js`\nDone.\n\n' + final);
    }
    const existing = await f.recordTurn({ messages: ['Reading `src/app.js`\nDone.'], final: 'Done.' });
    const response = await f.request(`/api/webchat/logs/${f.sessionId}/${existing.assistantMessageId}`);
    assert.equal(await response.text(), 'Reading `src/app.js`\nDone.');
    assert.equal(response.headers.get('x-log-final-length'), '5');
    for (const status of ['pending', 'failed', 'interrupted']) {
        const turn = await f.recordTurn({ messages: ['Working'], status });
        assert.equal((await f.request(`/api/webchat/logs/${f.sessionId}/${turn.assistantMessageId}`)).headers.get('x-log-final-offset'), null);
    }
    assert.equal((await f.request(`/api/webchat/logs/${f.sessionId}/${f.userMessageId}`)).headers.get('x-log-final-offset'), null);
});

test('View thinking reads only text and uses optional validated final-response headers', async () => {
    const { runInNewContext } = await import('node:vm');
    const source = (await fs.readFile(new URL('../public/webchat-logs.js', import.meta.url), 'utf8'))
        .replace(/^import .*\n/, '').replace('void load();', 'load();');
    const session = randomUUID();
    const message = randomUUID();
    for (const fixture of [
        { log: 'The user wants **Markdown** logs.', final: '' },
        { log: '{"a": "log containing JSON"}', final: '' },
        { log: 'Working...\n**Done**', offset: '11', length: '8', final: '**Done**' },
        { log: 'Working...', offset: '-1', length: '30', final: '' },
        { log: 'Working...', offset: '0', length: '1000', final: '' },
    ]) {
        const rendered = [];
        await runInNewContext(source, {
            URL,
            location: { pathname: `/webchat-logs/${session}/${message}` },
            document: { baseURI: 'http://localhost/rt/', querySelector: () => ({ textContent: '' }) },
            fetch: async (_url, options) => {
                assert.equal(options.headers.accept, 'text/plain');
                const headers = { 'content-type': 'text/plain; charset=utf-8' };
                if (fixture.offset !== undefined) headers['x-log-final-offset'] = fixture.offset;
                if (fixture.length !== undefined) headers['x-log-final-length'] = fixture.length;
                return new Response(fixture.log, { headers });
            },
            renderLog: (_container, log, final) => rendered.push({ log, final }),
        });
        assert.deepEqual(rendered, [{ log: fixture.log, final: fixture.final }]);
    }
});

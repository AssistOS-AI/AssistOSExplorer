import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import {
    buildConversationInitialHistory,
    ConversationSessionStore,
} from '../src/lib/storage/conversationSessionStore.mjs';
import {
    createCurrentSessionEnvelope,
    createSelectedSessionEnvelope,
    createSessionListEnvelope,
} from '../src/lib/webchat/webchatSessionState.mjs';
import { getCurrentSessionId } from '../src/lib/config/achillesSettings.mjs';
import { SlashCommandHandler } from '../src/repl/SlashCommandHandler.mjs';
import { resolveAlaCommand } from '../../server/ala-command.mjs';
import { saveTaskExecution } from '../../server/project-storage.mjs';
import { pathToFileURL } from 'node:url';

async function loadAla() {
    const root = path.dirname(path.dirname(fs.realpathSync(resolveAlaCommand())));
    const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
    const [state, recorder] = await Promise.all([load('session-state.mjs'), load('transcript-recorder.mjs')]);
    return { ...state, ...recorder };
}

function workspace(t) {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-conversations-'));
    t.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
    return workingDir;
}

test('AchillesCLI creates and restores workspace conversation sessions', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const created = await store.ensureCurrentSession();
    const turn = await store.beginTurn({
        sessionId: created.sessionId,
        text: 'Inspect the project',
        references: [{ kind: 'workspace-path', path: 'src/index.mjs' }],
    });
    await store.completeTurn(turn.session.sessionId, turn.assistantMessageId, 'The project is ready.');
    await store.insertTask(turn.session.sessionId, turn.assistantMessageId, 'task_1234567890abcdef12345678');

    const restored = await new ConversationSessionStore({ workingDir }).ensureCurrentSession();
    assert.equal(restored.sessionId, created.sessionId);
    assert.equal(getCurrentSessionId(workingDir), created.sessionId);
    assert.equal(restored.messages[0].role, 'user');
    assert.equal(restored.messages[1].text, 'The project is ready.');
    assert.deepEqual(restored.messages[2], { type: 'task', taskId: 'task_1234567890abcdef12345678' });
    assert.equal(fs.existsSync(path.join(workingDir, '.roboteam', 'sessions', created.sessionId, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(workingDir, '.data')), false);
    assert.equal(fs.existsSync(path.join(workingDir, '.copilot_history')), false);

    assert.deepEqual(buildConversationInitialHistory(restored), [
        {
            role: 'user',
            message: 'Inspect the project\n\nReferences: [{"kind":"workspace-path","path":"src/index.mjs"}]',
        },
        { role: 'assistant', message: 'The project is ready.' },
    ]);
});

test('conversation storage rejects a symlinked owned sessions directory', (t) => {
    const workingDir = workspace(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-sessions-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workingDir, '.roboteam'), { recursive: true });
    fs.symlinkSync(outside, path.join(workingDir, '.roboteam', 'sessions'), 'dir');

    assert.throws(
        () => new ConversationSessionStore({ workingDir }),
        /sessions directory must not be a symbolic link/,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('conversation storage revalidates sessions after construction', async (t) => {
    const workingDir = workspace(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-sessions-replaced-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const store = new ConversationSessionStore({ workingDir });
    await store.ensureCurrentSession();
    const sessionsDirectory = path.join(workingDir, '.roboteam', 'sessions');

    fs.rmSync(sessionsDirectory, { recursive: true, force: true });
    fs.symlinkSync(outside, sessionsDirectory, 'dir');

    await assert.rejects(
        () => store.createSession(),
        /sessions directory must not be a symbolic link/,
    );
    assert.deepEqual(fs.readdirSync(outside), []);

    const outsideSessionId = '123e4567-e89b-42d3-a456-426614174000';
    fs.writeFileSync(path.join(outside, `${outsideSessionId}.json`), JSON.stringify({
        sessionId: outsideSessionId,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        messages: [{ role: 'user', text: 'outside-secret' }],
    }));
    assert.throws(
        () => store.loadSession(outsideSessionId),
        /sessions directory must not be a symbolic link/,
    );
});

test('new and resumed sessions update the selected session and list', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const first = await store.createSession();
    const firstTurn = await store.beginTurn({ sessionId: first.sessionId, text: 'First session' });
    await store.completeTurn(first.sessionId, firstTurn.assistantMessageId, 'First answer');
    const second = await store.createSession();
    assert.equal(getCurrentSessionId(workingDir), second.sessionId);

    const list = store.listSessions();
    assert.equal(list.currentSessionId, second.sessionId);
    assert.equal(list.sessions.length, 2);
    assert.equal(list.sessions.find((entry) => entry.sessionId === first.sessionId).preview, 'First session');

    await store.resumeSession(first.sessionId);
    assert.equal(getCurrentSessionId(workingDir), first.sessionId);
    await assert.rejects(() => store.resumeSession('../settings'), /invalid_session_id/);
});

test('session lists exclude workflow tasks using existing task definitions without changing sessions', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const main = await store.createSession();
    const standalone = await store.createSession({ select: false });
    const phase = await store.createSession({ select: false });
    const before = fs.readFileSync(store.sessionPath(phase.sessionId), 'utf8');
    const persist = (session, workflowRunId, state) => saveTaskExecution({ workspaceRoot: os.tmpdir() }, {
        taskId: crypto.randomUUID(), alaSessionId: session.sessionId, robotId: 'default', type: 'simple', state,
        createdAt: new Date().toISOString(), request: { cwd: workingDir, task: 'Execute task', ...(workflowRunId ? { workflowRunId } : {}) },
    });
    persist(standalone, null, 'completed');
    for (const state of ['running', 'paused', 'completed']) {
        persist(phase, 'flow_1234567890abcdef12345678', state);
        const payload = new ConversationSessionStore({ workingDir }).listSessions(main.sessionId);
        assert.deepEqual(new Set(payload.sessions.map(item => item.sessionId)), new Set([main.sessionId, standalone.sessionId]));
        assert.equal(payload.current.sessionId, main.sessionId);
        assert.equal(createSessionListEnvelope(payload).sessions.length, 2);
    }
    assert.equal(store.loadSession(phase.sessionId).sessionId, phase.sessionId);
    assert.equal(fs.readFileSync(store.sessionPath(phase.sessionId), 'utf8'), before);
});

test('session filtering rejects a symlinked task definition', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const directory = path.join(workingDir, '.roboteam', 'tasks', session.sessionId);
    fs.mkdirSync(directory, { recursive: true });
    fs.symlinkSync(store.sessionPath(session.sessionId), path.join(directory, 'task.json'));
    assert.throws(() => store.listSessions(), /must not be a symbolic link/);
});

test('visible command turns persist for rendering but stay outside model history', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const selected = await store.ensureCurrentSession();
    const command = await store.beginCommand({ sessionId: selected.sessionId, text: '/exec launch-opencode hi' });
    await store.insertTask(command.session.sessionId, command.assistantMessageId, 'task_abcdefabcdefabcdefabcdef');
    const completed = await store.completeCommand(
        command.session.sessionId,
        command.assistantMessageId,
        'Task started.',
    );

    assert.deepEqual(completed.messages.map((message) => ({
        role: message.role,
        type: message.type,
        text: message.text,
        taskId: message.taskId,
        context: message.context,
    })), [
        {
            role: 'user',
            type: undefined,
            text: '/exec launch-opencode hi',
            taskId: undefined,
            context: false,
        },
        {
            role: 'assistant',
            type: undefined,
            text: 'Task started.',
            taskId: undefined,
            context: false,
        },
        {
            role: undefined,
            type: 'task',
            text: undefined,
            taskId: 'task_abcdefabcdefabcdefabcdef',
            context: undefined,
        },
    ]);
    assert.deepEqual(buildConversationInitialHistory(completed), []);

    const reloaded = await new ConversationSessionStore({ workingDir }).ensureCurrentSession();
    assert.deepEqual(reloaded.messages, completed.messages);
    assert.equal(reloaded.messages[2].taskId, 'task_abcdefabcdefabcdefabcdef');
    assert.deepEqual(buildConversationInitialHistory(reloaded), []);
});

test('commands without visible output do not persist an empty assistant message', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const selected = await store.ensureCurrentSession();
    const command = await store.beginCommand({ sessionId: selected.sessionId, text: '/tasks' });
    const completed = await store.completeCommand(command.session.sessionId, command.assistantMessageId, '');

    assert.deepEqual(completed.messages.map(({ role, text, context }) => ({ role, text, context })), [
        { role: 'user', text: '/tasks', context: false },
    ]);
    assert.deepEqual(buildConversationInitialHistory(completed), []);
});

test('slash session commands call the AchillesCLI session owner', async () => {
    const calls = [];
    const session = {
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
        createdAt: '2026-07-23T10:00:00.000Z',
        updatedAt: '2026-07-23T10:00:00.000Z',
        messages: [],
    };
    const handler = new SlashCommandHandler({
        executeSkill: async () => null,
        getUserSkills: () => [],
        getSkills: () => [],
        getSessions: () => ({ currentSessionId: session.sessionId, sessions: [] }),
        createSession: async () => { calls.push('new'); return session; },
        resumeSession: async (id) => { calls.push(`resume:${id}`); return session; },
    });

    const sessionCommand = await handler.executeSlashCommand('session', '');
    assert.equal(sessionCommand.showSessionPicker, true);
    assert.equal(sessionCommand.sessionList.currentSessionId, session.sessionId);
    assert.equal(SlashCommandHandler.getCommandCatalog().some((command) => command.name === '/sessions'), false);
    assert.equal((await handler.executeSlashCommand('session', 'new')).sessionChanged.sessionId, session.sessionId);
    assert.equal((await handler.executeSlashCommand('session', `resume ${session.sessionId}`)).sessionChanged.sessionId, session.sessionId);
    assert.deepEqual(calls, ['new', `resume:${session.sessionId}`]);
});

test('WebChat session protocol sends current, list, and selected records', () => {
    const session = {
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
        createdAt: '2026-07-23T10:00:00.000Z',
        updatedAt: '2026-07-23T10:00:00.000Z',
        messages: [],
    };
    assert.equal(createCurrentSessionEnvelope(session).event, 'current');
    assert.equal(createSelectedSessionEnvelope(session).event, 'selected');
    assert.deepEqual(createSessionListEnvelope({
        currentSessionId: session.sessionId,
        sessions: [],
    }).sessions, []);
});

test('connections pin their selection and listing does not initialize workspace state', async (t) => {
    const workingDir = workspace(t);
    const a = new ConversationSessionStore({ workingDir });
    assert.deepEqual(a.listSessions(), { currentSessionId: null, current: null, sessions: [] });
    assert.deepEqual(fs.readdirSync(workingDir), []);
    const first = await a.ensureCurrentSession();
    const b = new ConversationSessionStore({ workingDir });
    assert.equal((await b.ensureCurrentSession()).sessionId, first.sessionId);
    const second = await b.createSession();
    const turn = await a.beginTurn({ sessionId: first.sessionId, text: 'ALPHA' });
    await a.completeTurn(first.sessionId, turn.assistantMessageId, 'ALPHA answer');
    assert.equal((await a.ensureCurrentSession()).sessionId, first.sessionId);
    assert.equal(a.listSessions().currentSessionId, first.sessionId);
    assert.equal(b.listSessions().currentSessionId, second.sessionId);
    assert.equal(getCurrentSessionId(workingDir), second.sessionId);
    assert.deepEqual(b.loadSession(second.sessionId).messages, []);
    assert.equal(b.listSessions(first.sessionId).currentSessionId, first.sessionId);
    await assert.rejects(a.beginTurn({ text: 'missing target' }), /invalid_session_id/);
    await assert.rejects(a.completeTurn(first.sessionId, 1, 'numeric target'), /assistant_message_not_found/);
    assert.equal(a.loadSession(first.sessionId).messages[1].text, 'ALPHA answer');
});

test('conversation text comes from the ALA transcript; RoboTeam keeps only turn metadata', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const turnId = 'turn-from-ala';
    const turn = await store.beginTurn({ sessionId, turnId, text: 'question', attachments: [{ name: 'a.txt' }] });
    assert.equal(store.loadSession(sessionId).messages[0].text, 'question');
    const ala = await loadAla();
    const state = await ala.openSessionState({ id: sessionId, sessionsRoot: path.join(workingDir, '.roboteam', '.ala') });
    const recorder = ala.createTranscriptRecorder(state, turnId);
    await recorder.user('question');
    recorder.observe({ type: 'coding-agent-message', message: 'thinking', outputKind: 'assistant', outputComplete: true });
    await recorder.finish({ result: '<<human-report>>\nanswer from ALA\n<<human-report>>', status: 'completed' });
    await state.close();
    await store.completeTurn(sessionId, turn.assistantMessageId, 'answer from ALA', { thinkingUrl: '/logs/x' });

    const persisted = JSON.parse(fs.readFileSync(store.sessionPath(sessionId), 'utf8'));
    assert.equal(JSON.stringify(persisted).includes('answer from ALA'), false);
    assert.match(store.turnForMessage(sessionId, turn.assistantMessageId).ala.final, /^<<human-report>>\n/);
    assert.equal(JSON.stringify(persisted).includes('question'), false);
    const messages = new ConversationSessionStore({ workingDir }).loadSession(sessionId).messages;
    assert.deepEqual(messages.map(({ role, text, status }) => ({ role, text, status })), [
        { role: 'user', text: 'question', status: undefined },
        { role: 'assistant', text: 'answer from ALA\n\n[View Thinking](/logs/x)', status: 'completed' },
    ]);
    assert.deepEqual(messages[0].attachments, [{ name: 'a.txt' }]);
    assert.equal(store.turnForMessage(sessionId, turn.assistantMessageId).ala.messages[0].text, 'thinking');
});

test('a turn that fails before ALA records it keeps the user message and error in RoboTeam metadata', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const turn = await store.beginTurn({ sessionId, text: 'never reached ALA' });
    await store.completeTurn(sessionId, turn.assistantMessageId, 'ALA setup error', { status: 'failed' });
    const messages = new ConversationSessionStore({ workingDir }).loadSession(sessionId).messages;
    assert.deepEqual(messages.map(({ role, text, status }) => ({ role, text, status })), [
        { role: 'user', text: 'never reached ALA', status: undefined },
        { role: 'assistant', text: 'ALA setup error', status: 'failed' },
    ]);
});

test('native binding pins canonical paths and backend without replay or mismatch writes', async (t) => {
    const workingDir = workspace(t);
    const home = path.join(workingDir, 'native-home');
    fs.mkdirSync(home);
    fs.symlinkSync(home, path.join(workingDir, 'home-alias'));
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const turn = await store.beginTurn({ sessionId, text: 'legacy question' });
    await store.completeTurn(sessionId, turn.assistantMessageId, 'legacy answer');
    assert.equal(buildConversationInitialHistory(store.loadSession(sessionId))[0].message, 'legacy question');
    await store.bindEngine(sessionId, { home: path.join(workingDir, 'home-alias'), cwd: workingDir });
    const bound = await store.bindEngine(sessionId, { home, cwd: workingDir, backend: 'codex' });
    assert.equal(bound.engine.home, home);
    assert.deepEqual(buildConversationInitialHistory(bound), []);
    const sessionFile = store.sessionPath(sessionId);
    const before = fs.readFileSync(sessionFile, 'utf8');
    await assert.rejects(store.bindEngine(sessionId, { home: workingDir, cwd: workingDir, backend: 'codex' }), /home_mismatch/);
    await assert.rejects(store.bindEngine(sessionId, { home, cwd: home, backend: 'codex' }), /cwd_mismatch/);
    await assert.rejects(store.bindEngine(sessionId, { home, cwd: workingDir, backend: 'pi' }), /backend_mismatch/);
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), before);
    const restored = await new ConversationSessionStore({ workingDir }).resumeSession(sessionId);
    assert.deepEqual(restored.engine, bound.engine);
    assert.deepEqual(buildConversationInitialHistory(restored), []);
    const failed = await store.beginTurn({ sessionId, text: 'next question', turnId: 'next-turn' });
    await store.completeTurn(sessionId, failed.assistantMessageId, 'Native continuation missing', { status: 'failed' });
    assert.equal(store.loadSession(sessionId).messages.find((message) => message.id === failed.assistantMessageId).status, 'failed');
});

test('corrupt records are reported and are never replaced or hidden by startup repair', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const sessionFile = store.sessionPath(sessionId);
    for (const corrupt of ['{broken', JSON.stringify({ sessionId, messages: [], engine: { type: 'ala' } })]) {
        fs.writeFileSync(sessionFile, corrupt);
        await assert.rejects(new ConversationSessionStore({ workingDir }).ensureCurrentSession());
        await assert.rejects(store.beginTurn({ sessionId, text: 'do not overwrite' }));
        assert.throws(() => store.listSessions());
        assert.equal(fs.readFileSync(sessionFile, 'utf8'), corrupt);
        assert.equal(getCurrentSessionId(workingDir), sessionId);
    }
});

function runSessionWriter(workingDir, sessionId, assistantMessageId, worker) {
    const source = `
        import { ConversationSessionStore } from ${JSON.stringify(new URL('../src/lib/storage/conversationSessionStore.mjs', import.meta.url).href)};
        const [workingDir, sessionId, assistantMessageId, worker] = process.argv.slice(1);
        const store = new ConversationSessionStore({ workingDir });
        for (let index = 0; index < 8; index += 1) {
            await store.insertTask(sessionId, assistantMessageId, 'task_' + (Number(worker) * 8 + index).toString(16).padStart(24, '0'));
        }
        await store.insertTask(sessionId, assistantMessageId, 'task_ffffffffffffffffffffffff');
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, workingDir, sessionId, assistantMessageId, String(worker)], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Session writer exited ${code}: ${stderr}`)));
    });
}

test('separate processes deduplicate task cards without shifting message targets', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const first = await store.beginTurn({ sessionId, text: 'first question' });
    const second = await store.beginTurn({ sessionId, text: 'second question' });
    await Promise.all([0, 1, 2].map((worker) => runSessionWriter(workingDir, sessionId, first.assistantMessageId, worker)));
    await store.completeTurn(sessionId, second.assistantMessageId, 'second answer');
    const restored = store.loadSession(sessionId);
    const expectedTasks = Array.from({ length: 24 }, (_, index) => `task_${index.toString(16).padStart(24, '0')}`);
    expectedTasks.push('task_ffffffffffffffffffffffff');
    assert.deepEqual(restored.messages.filter((message) => message.type === 'task').map((message) => message.taskId).sort(), expectedTasks.sort());
    assert.equal(restored.messages.find((message) => message.id === second.assistantMessageId).text, 'second answer');
});


test('native continuation stays bound to its robot while project history remains readable', async t => {
    const workingDir = workspace(t);
    const home = path.join(workingDir, 'native-home');
    fs.mkdirSync(home);
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    await store.bindEngine(session.sessionId, { home, cwd: workingDir, backend: 'codex', robotId: 'first-123456' });
    await assert.rejects(store.bindEngine(session.sessionId, { home, cwd: workingDir,
        backend: 'codex', robotId: 'second-123456' }), /robot_mismatch/);
    assert.equal(store.loadSession(session.sessionId).engine.robotId, 'first-123456');
});

test('session storage ignores flat metadata without migrating it', async t => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    await store.updateSession(session.sessionId, record => { record.modelOverride = { backend: 'codex', model: 'test-model', effort: null }; });
    const current = store.sessionPath(session.sessionId);
    const legacy = path.join(workingDir, '.roboteam/sessions', `${session.sessionId}.json`);
    const bytes = fs.readFileSync(current, 'utf8');
    fs.renameSync(current, legacy);
    fs.rmdirSync(path.dirname(current));
    const reopened = new ConversationSessionStore({ workingDir });
    assert.throws(() => reopened.loadSession(session.sessionId), { code: 'ENOENT' });
    assert.equal(fs.readFileSync(legacy, 'utf8'), bytes);
    assert.equal(fs.existsSync(current), false);
    assert.equal(reopened.listSessions().sessions.length, 0);
});

test('session storage rejects a replaced session directory without following its link', async t => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const directory = path.dirname(store.sessionPath(session.sessionId));
    const outside = workspace(t);
    fs.renameSync(directory, path.join(outside, 'saved'));
    fs.symlinkSync(path.join(outside, 'saved'), directory);
    assert.throws(() => store.loadSession(session.sessionId), /must not be a symbolic link/);
    assert.throws(() => store.listSessions(), /must not be a symbolic link/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import {
    buildConversationInitialHistory,
    ConversationSessionStore,
} from '../src/lib/conversationSessionStore.mjs';
import {
    createCurrentSessionEnvelope,
    createSelectedSessionEnvelope,
    createSessionListEnvelope,
} from '../src/lib/webchatSessionState.mjs';
import { getCurrentSessionId } from '../src/lib/achillesSettings.mjs';
import { SlashCommandHandler } from '../src/repl/SlashCommandHandler.mjs';

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
    await store.appendProgress(turn.session.sessionId, turn.assistantMessageId, 'Reading files');
    await store.completeTurn(turn.session.sessionId, turn.assistantMessageId, 'The project is ready.');
    await store.insertTask(turn.session.sessionId, turn.assistantMessageId, 'task_1234567890abcdef12345678');

    const restored = await new ConversationSessionStore({ workingDir }).ensureCurrentSession();
    assert.equal(restored.sessionId, created.sessionId);
    assert.equal(getCurrentSessionId(workingDir), created.sessionId);
    assert.equal(restored.messages[0].role, 'user');
    assert.deepEqual(restored.messages[1].progress, ['Reading files']);
    assert.deepEqual(restored.messages[2], { type: 'task', taskId: 'task_1234567890abcdef12345678' });
    assert.equal(fs.existsSync(path.join(workingDir, '.data', 'achilles-cli', 'sessions', `${created.sessionId}.json`)), true);
    assert.equal(fs.existsSync(path.join(workingDir, '.achilles-cli')), false);
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
    fs.mkdirSync(path.join(workingDir, '.data', 'achilles-cli'), { recursive: true });
    fs.symlinkSync(outside, path.join(workingDir, '.data', 'achilles-cli', 'sessions'), 'dir');

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
    const sessionsDirectory = path.join(workingDir, '.data', 'achilles-cli', 'sessions');

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

test('legacy IDs survive task insertion and command placeholder removal', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const sessionFile = store.sessionPath(sessionId);
    fs.writeFileSync(sessionFile, JSON.stringify({
        sessionId, messages: [
            { role: 'user', text: '/tasks', context: false },
            { role: 'assistant', text: '', context: false },
            { role: 'user', text: 'legacy question' },
            { role: 'assistant', text: 'legacy answer', progress: ['old progress'] },
        ],
    }));
    const legacy = store.loadSession(sessionId);
    const commandId = legacy.messages[1].id;
    const answerId = legacy.messages[3].id;
    assert.equal(new ConversationSessionStore({ workingDir }).loadSession(sessionId).messages[3].id, answerId);
    await store.insertTask(sessionId, commandId, 'task_1234567890abcdef12345678');
    await store.completeCommand(sessionId, commandId, '');
    await store.appendProgress(sessionId, answerId, 'new progress');
    await store.completeTurn(sessionId, answerId, 'updated legacy answer');
    const persisted = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.deepEqual(persisted.messages.filter((message) => message.id).map((message) => message.id), [
        legacy.messages[0].id, legacy.messages[2].id, answerId,
    ]);
    assert.deepEqual(persisted.messages.find((message) => message.id === answerId).progress, ['old progress', 'new progress']);
    assert.equal(persisted.messages.find((message) => message.id === answerId).text, 'updated legacy answer');
    assert.equal(persisted.messages[1].taskId, 'task_1234567890abcdef12345678');
    assert.deepEqual(buildConversationInitialHistory(store.loadSession(sessionId)), [
        { role: 'user', message: 'legacy question' },
        { role: 'assistant', message: 'updated legacy answer' },
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
        import { ConversationSessionStore } from ${JSON.stringify(new URL('../src/lib/conversationSessionStore.mjs', import.meta.url).href)};
        const [workingDir, sessionId, assistantMessageId, worker] = process.argv.slice(1);
        const store = new ConversationSessionStore({ workingDir });
        for (let index = 0; index < 8; index += 1) {
            await store.appendProgress(sessionId, assistantMessageId, worker + ':' + index);
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

test('separate processes merge progress and deduplicate task cards without shifting message targets', async (t) => {
    const workingDir = workspace(t);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    const first = await store.beginTurn({ sessionId, text: 'first question' });
    const second = await store.beginTurn({ sessionId, text: 'second question' });
    await Promise.all([0, 1, 2].map((worker) => runSessionWriter(workingDir, sessionId, first.assistantMessageId, worker)));
    await store.completeTurn(sessionId, second.assistantMessageId, 'second answer');
    const restored = store.loadSession(sessionId);
    const expected = [0, 1, 2].flatMap((worker) => Array.from({ length: 8 }, (_, index) => `${worker}:${index}`));
    assert.deepEqual(restored.messages.find((message) => message.id === first.assistantMessageId).progress.sort(), expected.sort());
    const expectedTasks = Array.from({ length: 24 }, (_, index) => `task_${index.toString(16).padStart(24, '0')}`);
    expectedTasks.push('task_ffffffffffffffffffffffff');
    assert.deepEqual(restored.messages.filter((message) => message.type === 'task').map((message) => message.taskId).sort(), expectedTasks.sort());
    assert.equal(restored.messages.find((message) => message.id === second.assistantMessageId).text, 'second answer');
});

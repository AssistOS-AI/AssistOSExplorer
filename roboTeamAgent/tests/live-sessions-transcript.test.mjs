import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Live Session transcript readers against a real conversation store and a real
// ALA transcript recorder. Workspace state locks need Linux process identity,
// so this file runs on Linux only.
const CONTAINER_SENTINEL = 'CONTAINER-LOG-SENTINEL-7f3c';

test('transcript readers return only the bound ALA turn, by task folder or by registered WebChat session', async (t) => {
    const { randomUUID } = await import('node:crypto');
    const { pathToFileURL } = await import('node:url');
    const { resolveAlaCommand } = await import('../server/ala-command.mjs');
    const { registerProject } = await import('../server/project-storage.mjs');
    const { ConversationSessionStore } = await import('../copilot/src/lib/storage/conversationSessionStore.mjs');
    const { readTaskTurnTranscript, webchatTranscriptReader } = await import('../server/http-server.mjs');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'live-transcript-')));
    const workspaceRoot = path.join(root, 'workspace');
    const project = path.join(workspaceRoot, 'project');
    await fs.mkdir(project, { recursive: true });
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    t.after(async () => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const alaRoot = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand(process.env.ACHILLES_ALA_COMMAND))));
    const load = (name) => import(pathToFileURL(path.join(alaRoot, 'src', name)).href);
    const ala = { ...await load('session-state.mjs'), ...await load('transcript-recorder.mjs') };
    const store = new ConversationSessionStore({ workingDir: project });
    const { sessionId } = await store.createSession();
    const turnId = randomUUID();
    const turn = await store.beginTurn({ sessionId, turnId, text: 'question' });
    const state = await ala.openSessionState({ id: sessionId, sessionsRoot: path.join(project, '.roboteam', '.ala'), resume: false });
    await state.save({ agent: 'codex', continuation: { threadId: 'thread' } });
    const recorder = ala.createTranscriptRecorder(state, turnId);
    await recorder.user('question');
    recorder.observe({ type: 'coding-agent-message', message: 'Working on it.\n', outputKind: 'output' });
    await recorder.finish({ result: 'All done.', status: 'completed' });
    await state.close();
    await store.completeTurn(sessionId, turn.assistantMessageId, 'All done.', { status: 'completed' });
    const expected = readTaskTurnTranscript({ cwd: project, sessionId, assistantMessageId: turn.assistantMessageId });
    assert.match(expected, /Working on it\./u);
    assert.match(expected, /All done\./u);
    assert.doesNotMatch(expected, new RegExp(CONTAINER_SENTINEL, 'u'));
    assert.equal(readTaskTurnTranscript({ cwd: project, sessionId, assistantMessageId: randomUUID() }), null, 'another message id selects nothing');
    assert.equal(readTaskTurnTranscript({ cwd: project, sessionId: randomUUID(), assistantMessageId: turn.assistantMessageId }), null);
    const dataDir = path.join(root, 'data');
    const reader = webchatTranscriptReader({ dataDir }, workspaceRoot);
    assert.equal(reader(sessionId, turn.assistantMessageId), null, 'an unregistered project is not searched');
    registerProject({ dataDir, workspaceRoot }, project);
    assert.equal(reader(sessionId, turn.assistantMessageId), expected);
    assert.equal(reader('not-a-session-id', turn.assistantMessageId), null);
});

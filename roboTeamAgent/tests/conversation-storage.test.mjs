import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { resolveAlaCommand } from '../server/ala-command.mjs';
import { conversationSummaries } from '../server/impact-summaries.mjs';
import { LEGACY_STORAGE_MARKER, removeLegacyStorage } from '../server/legacy-storage-cleanup.mjs';
import { registerProject } from '../server/project-storage.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';

async function loadAla() {
    const root = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
    const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
    const [state, recorder] = await Promise.all([load('session-state.mjs'), load('transcript-recorder.mjs')]);
    return { ...state, ...recorder };
}

async function workspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-storage-'));
    const workspaceRoot = path.join(root, 'workspace');
    const project = path.join(workspaceRoot, 'project');
    await fs.mkdir(project, { recursive: true });
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    t.after(async () => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, workspaceRoot, project, dataDir: path.join(root, 'data') };
}

test('the private directory is .roboteam and is ignored by git', async t => {
    const { project } = await workspace(t);
    await new ConversationSessionStore({ workingDir: project }).createSession();
    assert.equal(await fs.readFile(path.join(project, '.roboteam', '.gitignore'), 'utf8'), '*\n');
    await assert.rejects(fs.stat(path.join(project, '.achilles-cli')), { code: 'ENOENT' });
});

test('human reports are read from the assistant output and final answers ALA recorded', async t => {
    const { workspaceRoot, project, dataDir } = await workspace(t);
    registerProject({ dataDir, workspaceRoot }, project);
    const store = new ConversationSessionStore({ workingDir: project });
    const { sessionId } = await store.createSession();
    const turnId = randomUUID();
    const turn = await store.beginTurn({ sessionId, turnId, text: 'Do it' });
    const ala = await loadAla();
    const state = await ala.openSessionState({ id: sessionId, sessionsRoot: path.join(project, '.roboteam', '.ala') });
    const recorder = ala.createTranscriptRecorder(state, turnId);
    await recorder.user('Do it');
    recorder.observe({ type: 'coding-agent-message', outputKind: 'assistant', outputComplete: true,
        message: 'Working\n<<human-report>>\nStep one done.\n<<human-report>>\n' });
    recorder.observe({ type: 'coding-agent-message', outputKind: 'output', message: '<<human-report>>\nnot a report\n<<human-report>>\n' });
    await recorder.finish({ status: 'completed', result: 'Answer\n<<human-report>>\nAll done.\n<<human-report>>' });
    await state.close();
    const robotStore = { dataDir };
    await store.completeTurn(sessionId, turn.assistantMessageId, 'Answer');
    const result = await conversationSummaries(robotStore, workspaceRoot, sessionId);
    assert.deepEqual(result.summaries.map((entry) => entry.text), ['Step one done.', 'All done.']);
    assert.equal(result.summaries[0].messageId, turn.assistantMessageId);
    assert.equal(result.active, false);
});

test('legacy conversation storage is removed once and never followed through links', async t => {
    const { root, workspaceRoot, project, dataDir } = await workspace(t);
    registerProject({ dataDir, workspaceRoot }, project);
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(outside, 'keep'), { recursive: true });
    await fs.mkdir(path.join(project, '.achilles-cli', 'sessions'), { recursive: true });
    await fs.writeFile(path.join(project, '.achilles-cli', 'sessions', 'old.json'), '{}');
    await fs.symlink(outside, path.join(project, '.ala-pi-sessions'));
    const robotSessions = path.join(dataDir, 'robots', 'default-abc123', 'home', '.ala', 'sessions');
    await fs.mkdir(robotSessions, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'robots', 'default-abc123', 'home', '.ala', 'config.json'), '{}');

    const removed = await removeLegacyStorage({ dataDir, workspaceRoot });
    assert.deepEqual(removed.sort(), [path.join(project, '.achilles-cli'), robotSessions].sort());
    await assert.rejects(fs.stat(path.join(project, '.achilles-cli')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(robotSessions), { code: 'ENOENT' });
    await fs.stat(path.join(dataDir, 'robots', 'default-abc123', 'home', '.ala', 'config.json'));
    await fs.stat(path.join(outside, 'keep'));
    await fs.stat(path.join(dataDir, LEGACY_STORAGE_MARKER));

    await fs.mkdir(path.join(project, '.achilles-cli'));
    assert.deepEqual(await removeLegacyStorage({ dataDir, workspaceRoot }), []);
    await fs.stat(path.join(project, '.achilles-cli'));
});

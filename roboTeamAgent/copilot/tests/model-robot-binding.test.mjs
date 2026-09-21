import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAlaEngine } from '../src/lib/alaEngine.mjs';
import { ConversationSessionStore } from '../src/lib/conversationSessionStore.mjs';
import { loadAutocompleteCatalog } from '../src/mcp/list-slash-commands.mjs';

// Model discovery for WebChat autocomplete builds a short-lived ALA engine. When
// that engine omitted the robot identity, every conversation that had already
// executed a turn carried an engine.robotId and was wrongly rejected as
// belonging to another robot. These tests pin the binding contract.
test('an engine created for the conversation robot passes the robot check', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-robot-bind-'));
    const workingDir = path.join(root, 'workspace');
    await fs.mkdir(workingDir, { recursive: true });
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot;
        await fs.rm(root, { recursive: true, force: true });
    });

    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    await store.bindEngine(session.sessionId, { home: workingDir, cwd: workingDir, backend: 'codex', robotId: 'robot-a' });

    const catalog = { async refresh() { return { skills: [], taskRepositories: [] }; } };
    const installation = { async discoverCodingAgents() { return [{ name: 'codex', binary: process.execPath, available: true }]; } };
    const settings = { readAchillesSettings: () => ({}), getCodingAgentModels: () => ({}), getPermissionMode: () => 'full-access' };

    const matching = createAlaEngine({ workingDir, sessionStore: store, skillCatalog: catalog, installation, settings,
        execution: { robotId: 'robot-a' } });
    t.after(() => matching.close());
    await assert.rejects(matching.getModel({ sessionId: session.sessionId }),
        (error) => !/another robot/i.test(error.message));

    const foreign = createAlaEngine({ workingDir, sessionStore: store, skillCatalog: catalog, installation, settings,
        execution: { robotId: 'robot-b' } });
    t.after(() => foreign.close());
    await assert.rejects(foreign.getModel({ sessionId: session.sessionId }), /another robot/i);
});

test('autocomplete model discovery binds the requested robot id', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-model-binding-'));
    const workingDir = path.join(root, 'workspace');
    await fs.mkdir(workingDir, { recursive: true });
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot;
        await fs.rm(root, { recursive: true, force: true });
    });

    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    await store.bindEngine(session.sessionId, { home: workingDir, cwd: workingDir, backend: 'codex', robotId: 'robot-a' });

    const result = await loadAutocompleteCatalog({
        dir: workingDir,
        sessionId: session.sessionId,
        skillCatalog: { getSkills: () => [] },
        installation: { async discoverCodingAgents() { return []; } },
        robotId: 'robot-a',
        signal: AbortSignal.timeout(20000),
    });
    // With the robot bound, discovery reaches native-continuation validation
    // instead of being rejected up front as a foreign conversation.
    assert.doesNotMatch(String(result.modelError || ''), /another robot/i);
});

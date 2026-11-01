import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAlaEngine } from '../copilot/src/lib/execution/alaEngine.mjs';
import { createWebchatDispatcher } from '../copilot/src/lib/webchat/webchatRuntime.mjs';

test('engine saves run identity before MCP start, executes without a local home and validates the matching remote final', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-engine-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const sessionId = randomUUID(), turnId = randomUUID();
    const userMessageId = randomUUID(), assistantMessageId = randomUUID();
    const session = { sessionId, cwd: root };
    const calls = [];
    let reads = 0;
    const sessionStore = {
        loadSession: () => structuredClone(session),
        beginTurn: async () => ({ userMessageId, assistantMessageId }),
        bindEngine: async (_id, binding) => { session.engine = { ...binding, sessionId }; },
        updateSession: async (_id, update) => { update(session); return session; },
        completeTurn: async (_id, messageId, text) => { assert.equal(messageId, assistantMessageId); session.final = text; return session; },
    };
    const client = { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'robot_config') return { homeTarget: '/home/robot-abc', codingAgent: 'codex', models: {}, efforts: {}, agents: [{ name: 'codex', available: true }] };
        if (tool === 'run_start') {
            assert.equal(session.remoteRun.runId, input.runId);
            assert.equal(session.remoteRun.turnId, turnId);
            assert.equal(input.robotId, 'robot-abc');
            assert.equal(input.ala.mcpServers, 'docs=https://docs.example/mcp');
            assert.deepEqual(input.folders, []);
            assert.equal(JSON.stringify(input.channels).includes('PLOINKY_'), false);
            const directory = path.join(root, '.roboteam/.ala/sessions');
            await fs.mkdir(directory, { recursive: true });
            const records = [{ type: 'session', id: sessionId }, { type: 'user', turnId, text: 'hello' },
                { type: 'continuation', agent: 'codex', continuation: { threadId: randomUUID() } },
                { type: 'final', turnId, text: 'answer' }, { type: 'turn-end', turnId, status: 'completed' }];
            await fs.writeFile(path.join(directory, sessionId + '.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
            return { runId: input.runId, state: 'running' };
        }
        if (tool === 'run_input') return { ok: true };
        if (tool === 'run_read') {
            const events = [{ type: 'coding-agent-selected', agent: 'codex', permissionMode: 'full-access' },
                { type: 'coding-agent-final', agent: 'codex', message: 'answer' }];
            return { state: 'exited', exit: { code: 0 }, callbacks: [], records: reads++ ? [] : [
                { seq: 1, stream: 'stdout', data: Buffer.from('answer').toString('base64') },
                { seq: 2, stream: 'stderr', data: Buffer.from(events.map(event => '@@ALA_EVENT@@' + JSON.stringify(event)).join('\n') + '\n').toString('base64') },
            ] };
        }
        throw new Error('Unexpected tool ' + tool);
    } };
    const engine = createAlaEngine({ workingDir: root, sessionStore, roboWork: client,
        skillCatalog: { refresh: async () => ({ skills: [] }) },
        execution: { robotId: 'robot-abc', mcpServers: 'docs=https://docs.example/mcp' } });
    t.after(() => engine.close());
    const result = await engine.executeTurn({ sessionId, turnId, prompt: 'hello' });
    assert.equal(result.outputText, 'answer');
    assert.equal(session.final, 'answer');
    assert.equal(session.remoteRun, undefined);
    assert.equal(calls.filter(call => call.tool === 'run_start').length, 1);
    assert.equal(calls.filter(call => call.tool === 'run_input' && call.input.data).length, 1);
    assert.equal(calls.some(call => call.tool === 'run_stop'), false);
});

test('reopened WebChat attaches its pending turn once without adding a user prompt or history entry', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-webchat-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const saved = { sessionId: randomUUID(), messages: [], remoteRun: { runId: 'pending-one', turnId: randomUUID() } };
    const calls = [], output = [];
    const completed = { ...saved, remoteRun: undefined };
    const runtime = { workingDir: root, renderMarkdown: false,
        sessionStore: { ensureCurrentSession: async () => saved, loadSession: () => completed },
        engine: { getModel: async () => ({ backend: 'codex', model: null }), executeTurn: async input => {
            calls.push(input);
            await input.onEvent({ type: 'turn-started', session: saved });
            return { outputText: 'real final' };
        } }, historyManager: { add: () => assert.fail('reattachment must not create a history entry') } };
    const dispatcher = createWebchatDispatcher(runtime, { write: text => { output.push(JSON.parse(text)); } });
    dispatcher.reattach(saved);
    dispatcher.reattach(saved);
    await dispatcher.drain();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, '');
    assert.deepEqual(calls[0].attach, saved.remoteRun);
    assert.equal(calls[0].sessionId, saved.sessionId);
    assert.ok(output.some(event => event.__webchatSession && event.session?.sessionId === saved.sessionId));
});

test('engine reattaches from sequence zero using the trusted run and marks replayed progress', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-replay-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const sessionId = randomUUID(), turnId = randomUUID(), assistantMessageId = randomUUID();
    const remoteRun = { runId: randomUUID(), turnId, assistantMessageId, userMessageId: randomUUID() };
    const session = { sessionId, cwd: root, remoteRun, engine: { sessionId, cwd: root, home: '/home/robot-abc', backend: 'codex', robotId: 'robot-abc' } };
    const calls = [], events = [];
    let reads = 0, completions = 0;
    const sessionStore = { loadSession: () => structuredClone(session), bindEngine: async () => {},
        updateSession: async (_id, update) => update(session), beginTurn: () => assert.fail('must reuse the saved turn'),
        completeTurn: async (_id, messageId) => { assert.equal(messageId, assistantMessageId); completions++; return session; } };
    const client = { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'robot_config') return { homeTarget: '/home/robot-abc', codingAgent: 'codex', models: {}, efforts: {}, agents: [{ name: 'codex', available: true }] };
        if (tool === 'run_list') return [{ runId: remoteRun.runId, robotId: 'robot-abc', tag: { sessionId, turnId } }];
        if (tool === 'run_release') return { ok: true };
        if (tool !== 'run_read') assert.fail('reattach must never start or prompt: ' + tool);
        const directory = path.join(root, '.roboteam/.ala/sessions');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, sessionId + '.jsonl'), JSON.stringify({ type: 'session', id: sessionId }) + '\n');
        const nativeEvents = [{ type: 'coding-agent-selected', agent: 'codex', permissionMode: 'full-access' },
            { type: 'coding-agent-message', agent: 'codex', message: 'already delivered' },
            { type: 'coding-agent-final', agent: 'codex', message: 'answer' }];
        return { state: 'exited', exit: { code: 0 }, callbacks: [], records: reads++ ? [] : [
            { seq: 1, stream: 'stdout', data: Buffer.from('answer').toString('base64') },
            { seq: 2, stream: 'stderr', data: Buffer.from(nativeEvents.map(event => '@@ALA_EVENT@@' + JSON.stringify(event)).join('\n') + '\n').toString('base64') },
        ] };
    } };
    const engine = createAlaEngine({ workingDir: root, sessionStore, roboWork: client,
        skillCatalog: { refresh: async () => ({ skills: [] }) }, execution: { robotId: 'robot-abc' } });
    t.after(() => engine.close());
    assert.equal((await engine.executeTurn({ sessionId, prompt: '', attach: remoteRun, onEvent: event => { events.push(event); } })).outputText, 'answer');
    assert.equal(completions, 1);
    assert.equal(calls.find(call => call.tool === 'run_read').input.after, 0);
    assert.equal(events.find(event => event.type === 'coding-agent-message').replayed, true);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAlaEngine } from '../copilot/src/lib/execution/alaEngine.mjs';

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

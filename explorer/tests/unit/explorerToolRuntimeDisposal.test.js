import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { handleExplorerToolCall } from '../../tools/explorer_tool.mjs';
import { createExplorerToolRuntime } from '../../utils/server/tool-runtime.mjs';

async function workspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-runtime-dispose-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'visible.txt'), 'visible');
    return root;
}

function observeIntervals(t) {
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const active = new Set();
    let created = 0;
    let cleared = 0;
    t.mock.method(globalThis, 'setInterval', (...args) => {
        const timer = originalSet(...args);
        active.add(timer);
        created += 1;
        return timer;
    });
    t.mock.method(globalThis, 'clearInterval', (timer) => {
        if (active.delete(timer)) cleared += 1;
        return originalClear(timer);
    });
    t.after(() => { for (const timer of active) originalClear(timer); });
    return { active, created: () => created, cleared: () => cleared };
}

function decode(result) {
    return JSON.parse(result.content[0].text);
}

test('runtime disposal retires its timer once and rejects later calls', async (t) => {
    const root = await workspace(t);
    const timers = observeIntervals(t);
    const runtime = await createExplorerToolRuntime({ env: { ASSISTOS_FS_ROOT: root } });
    t.after(() => runtime.dispose());
    assert.equal(timers.active.size, 1, 'the runtime owns one search cleanup interval');
    assert.match((await runtime.callTool('list_allowed_directories')).content[0].text, /Allowed directories:/);
    runtime.dispose();
    runtime.dispose();
    assert.equal(timers.created(), 1);
    assert.equal(timers.cleared(), 1);
    assert.equal(timers.active.size, 0);
    await assert.rejects(runtime.callTool('list_allowed_directories'), /runtime is disposed/);
    await assert.rejects(runtime.callTool('dispose'), /runtime is disposed/);
});

test('real runtime clears invocation authority after success and failure and across fresh runtimes', async (t) => {
    const root = await workspace(t);
    const env = { ASSISTOS_FS_ROOT: root };
    const admin = { invocation: { actor: { id: 'user:first', roles: ['admin'] } } };
    const member = { invocation: { actor: { id: 'user:second', roles: [] } } };
    const runtime = await createExplorerToolRuntime({ env });
    t.after(() => runtime.dispose());
    assert.equal(decode(await runtime.callTool('get_avatar_settings_agents', {}, admin)).canManageAgents, true);
    assert.equal(decode(await runtime.callTool('get_avatar_settings_agents', {}, member)).canManageAgents, false);
    await assert.rejects(runtime.callTool('missing_tool', {}, admin), /Unknown tool/);
    assert.equal(decode(await runtime.callTool('get_avatar_settings_agents')).canManageAgents, false);
    await assert.rejects(runtime.callTool('dispose'), /Unknown tool: dispose/, 'cleanup must not be callable as an MCP tool');
    runtime.dispose();
    const next = await createExplorerToolRuntime({ env });
    t.after(() => next.dispose());
    assert.notEqual(next, runtime);
    assert.equal(decode(await next.callTool('get_avatar_settings_agents')).canManageAgents, false);
});

test('each fresh runtime replaces the filesystem dependency allowed roots', async (t) => {
    const first = await workspace(t);
    const second = await workspace(t);
    await fs.writeFile(path.join(first, 'visible.txt'), 'first workspace');
    await fs.writeFile(path.join(second, 'visible.txt'), 'second workspace');
    for (const [root, expected] of [[first, 'first workspace'], [second, 'second workspace'], [first, 'first workspace']]) {
        const runtime = await createExplorerToolRuntime({ env: { ASSISTOS_FS_ROOT: root } });
        try {
            assert.equal((await runtime.callTool('read_text_file', { path: 'visible.txt' })).content[0].text, expected);
            const otherRoot = root === first ? second : first;
            await assert.rejects(runtime.callTool('read_text_file', { path: path.relative(root, path.join(otherRoot, 'visible.txt')) }), /Access denied/);
        } finally {
            runtime.dispose();
        }
    }
});

test('E5: 200 handler calls leave no cleanup intervals and dispose exactly once per call', async (t) => {
    const root = await workspace(t);
    const timers = observeIntervals(t);
    const before = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
    let disposals = 0;
    for (let call = 0; call < 200; call += 1) {
        let output = '';
        await handleExplorerToolCall({
            envelope: { tool: 'list_directory_detailed', input: { path: '/' } },
            toolEnv: { ASSISTOS_FS_ROOT: root },
            stdout: new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }),
            createRuntime: async options => {
                const runtime = await createExplorerToolRuntime(options);
                return {
                    callTool: (...args) => runtime.callTool(...args),
                    dispose() { disposals += 1; runtime.dispose(); },
                };
            },
        });
        assert.match(output, /visible\.txt/);
        assert.equal(timers.active.size, 0, `call ${call} left an unref'd interval`);
        assert.equal(disposals, call + 1);
    }
    assert.equal(timers.created(), 200);
    assert.equal(timers.cleared(), 200);
    assert.equal(process.getActiveResourcesInfo().filter(name => name === 'Timeout').length, before);
});

test('runtime construction failure after timer registration clears the owned interval', async (t) => {
    const root = await workspace(t);
    const timers = observeIntervals(t);
    const originalJoin = path.join;
    t.mock.method(path, 'join', (...args) => {
        if (timers.active.size && args[0] === root && args[1] === '.ploinky' && args[2] === 'repos') throw new Error('construction failed');
        return originalJoin(...args);
    });
    await assert.rejects(createExplorerToolRuntime({ env: { ASSISTOS_FS_ROOT: root } }), /construction failed/);
    assert.equal(timers.created(), 1);
    assert.equal(timers.cleared(), 1);
    assert.equal(timers.active.size, 0);
});

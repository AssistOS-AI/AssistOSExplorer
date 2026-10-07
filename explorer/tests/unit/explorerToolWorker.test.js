import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { handleExplorerToolCall } from '../../tools/explorer_tool.mjs';
import { serveExplorerToolWorker } from '../../tools/explorer_tool_worker.mjs';

const cliPath = fileURLToPath(new URL('../../tools/explorer_tool.mjs', import.meta.url));
const workerPath = fileURLToPath(new URL('../../tools/explorer_tool_worker.sh', import.meta.url));

function capture() {
    const chunks = [];
    return {
        stdout: new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
        bytes: () => Buffer.concat(chunks),
    };
}

async function workspace(t, { beforeRemove = async () => {} } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-worker-adapter-'));
    t.after(async () => {
        const failures = [];
        try {
            await beforeRemove();
        } catch (error) {
            failures.push(error);
        }
        try {
            await fs.rm(root, { recursive: true, force: true });
        } catch (error) {
            failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Explorer adapter fixture cleanup failed.');
    });
    await fs.writeFile(path.join(root, 'ordinary.txt'), 'raw text\n');
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    return root;
}

function cli(root, input, toolName = '', entrypoint = cliPath) {
    return spawnSync(process.execPath, [entrypoint], {
        cwd: root,
        env: { ...process.env, ASSISTOS_FS_ROOT: root, TOOL_NAME: toolName },
        input: typeof input === 'string' ? input : JSON.stringify(input),
        timeout: 15_000,
    });
}

test('E1: CLI and handler preserve ordinary, empty and JSON result bytes', async (t) => {
    const root = await workspace(t);
    for (const [envelope, expected] of [
        [{ tool: 'read_text_file', input: { path: 'ordinary.txt' } }, 'raw text\n'],
        [{ tool: 'read_text_file', arguments: { path: 'empty.txt' } }, '__ASSISTOS_EXPLORER_EMPTY_TEXT__'],
        [{ tool: 'list_directory_detailed', input: { path: '/' } }, null],
    ]) {
        const output = capture();
        await handleExplorerToolCall({ envelope, toolEnv: { ASSISTOS_FS_ROOT: root }, stdout: output.stdout });
        const result = cli(root, envelope);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr.toString());
        assert.equal(result.stderr.length, 0);
        assert.deepEqual(result.stdout, output.bytes());
        if (expected !== null) assert.equal(output.bytes().toString(), expected);
        else assert.match(output.bytes().toString(), /ordinary\.txt/);
    }
});

test('CLI preserves error newline, missing and malformed envelopes, and TOOL_NAME fallback', async (t) => {
    const root = await workspace(t);
    for (const input of ['', '{broken', '{}', 'null']) {
        const result = cli(root, input);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.toString(), 'Explorer tool name is missing.\n');
    }
    const unknown = cli(root, { tool: 'missing_tool' });
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout.length, 0);
    assert.equal(unknown.stderr.toString(), 'Unknown tool: missing_tool\n');
    const fallback = cli(root, { arguments: { path: 'ordinary.txt' } }, 'read_text_file');
    assert.equal(fallback.status, 0, fallback.stderr.toString());
    assert.equal(fallback.stdout.toString(), 'raw text\n');
});

test('CLI direct execution also works through a staged source symlink', async (t) => {
    const root = await workspace(t);
    const alias = path.join(root, 'tool-alias.mjs');
    await fs.symlink(cliPath, alias);
    const result = cli(root, { tool: 'read_text_file', input: { path: 'ordinary.txt' } }, '', alias);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'raw text\n');
});

test('importing CLI and worker modules neither reads open stdin nor starts serving', async (t) => {
    const script = `await import(${JSON.stringify(pathToFileURL(cliPath).href)}); await import(${JSON.stringify(new URL('../../tools/explorer_tool_worker.mjs', import.meta.url).href)}); process.stdout.write('imported');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    t.after(() => { clearTimeout(timer); child.kill('SIGKILL'); });
    // Keep stdin open: an import that invokes the CLI waits forever for EOF.
    const [code, signal] = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (...result) => resolve(result));
    });
    clearTimeout(timer);
    assert.equal(signal, null, 'import hung on stdin or started the worker');
    assert.equal(code, 0, Buffer.concat(errors).toString());
    assert.equal(Buffer.concat(chunks).toString(), 'imported');
    assert.equal(Buffer.concat(errors).length, 0);
});

test('E2/E3: each call gets a fresh runtime, current metadata and explicit tool-name precedence', async (t) => {
    const previousName = process.env.TOOL_NAME;
    process.env.TOOL_NAME = 'ambient_wrong';
    t.after(() => {
        if (previousName === undefined) delete process.env.TOOL_NAME;
        else process.env.TOOL_NAME = previousName;
    });
    const calls = [];
    const runtimes = [];
    const output = capture();
    const createRuntime = async options => {
        const runtime = {
            disposed: 0,
            async callTool(name, args, metadata) { calls.push({ name, args, metadata, options }); return { content: [{ type: 'text', text: name }] }; },
            dispose() { this.disposed += 1; },
        };
        runtimes.push(runtime);
        return runtime;
    };
    const metadata = { invocation: { actor: { id: 'user:first', roles: ['admin'] } } };
    await handleExplorerToolCall({ envelope: { tool: 'explicit', input: { value: 1 }, arguments: { value: 2 }, metadata }, toolEnv: { TOOL_NAME: 'configured' }, stdout: output.stdout, createRuntime });
    await handleExplorerToolCall({ envelope: { arguments: { value: 3 } }, toolEnv: { TOOL_NAME: 'configured' }, stdout: output.stdout, createRuntime });
    assert.equal(runtimes.length, 2);
    assert.notEqual(runtimes[0], runtimes[1]);
    assert.deepEqual(runtimes.map(runtime => runtime.disposed), [1, 1]);
    assert.deepEqual(calls.map(call => [call.name, call.args]), [['explicit', { value: 1 }], ['configured', { value: 3 }]]);
    assert.equal(calls[0].metadata, metadata);
    assert.deepEqual(calls[1].metadata, {});
    assert.equal(calls[0].options.env.TOOL_NAME, 'configured');
    await assert.rejects(handleExplorerToolCall({ envelope: {}, stdout: output.stdout, createRuntime }), /Explorer tool name is missing/);
    assert.equal(runtimes.length, 2, 'ambient TOOL_NAME must not create a runtime');
});

test('handler preserves raw text, empty sentinel and multi-block JSON without adding a newline', async () => {
    for (const [result, expected] of [
        [{ content: [{ type: 'text', text: '' }] }, '__ASSISTOS_EXPLORER_EMPTY_TEXT__'],
        [{ content: [{ type: 'text', text: 'hello' }] }, 'hello'],
        [{ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, '{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}'],
        [null, '{}'],
    ]) {
        const output = capture();
        await handleExplorerToolCall({ envelope: { tool: 'fixture' }, stdout: output.stdout, createRuntime: async () => ({ callTool: async () => result, dispose() {} }) });
        assert.equal(output.bytes().toString(), expected);
    }
});

test('disposal runs exactly once after call, serialization and asynchronous output failures', async () => {
    for (const failure of ['call', 'serialization', 'output', 'sync-output']) {
        let disposed = 0;
        const result = { content: [] };
        if (failure === 'serialization') result.circular = result;
        const output = capture();
        if (failure === 'output') output.stdout = new Writable({ write(chunk, encoding, done) { done(new Error('output failed')); } });
        if (failure === 'sync-output') output.stdout.write = () => { throw new Error('output failed'); };
        await assert.rejects(handleExplorerToolCall({
            envelope: { tool: 'fixture' }, stdout: output.stdout,
            createRuntime: async () => ({
                callTool: async () => { if (failure === 'call') throw new Error('call failed'); return result; },
                dispose() { disposed += 1; },
            }),
        }), failure === 'serialization' ? /circular/i : /failed/);
        assert.equal(disposed, 1, failure);
    }
});

test('E4: the adapter is inert and every Explorer tool keeps its spawn contract', async () => {
    const descriptor = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    assert.equal(descriptor.toolWorkers, undefined);
    assert.ok(descriptor.tools.length > 0);
    for (const tool of descriptor.tools) {
        assert.equal(tool.worker, undefined, tool.name);
        assert.equal(tool.command, 'tools/explorer_tool.sh', tool.name);
        assert.equal(tool.env.TOOL_NAME, tool.name);
    }
});

test('worker refuses a missing or relative shared runtime module path', async () => {
    for (const workerModulePath of ['', 'relative.mjs']) {
        await assert.rejects(serveExplorerToolWorker({ workerModulePath }), /absolute PLOINKY_TOOL_WORKER_MODULE/);
    }
});

test('the real Ploinky pool callback preserves CLI bytes across consecutive users and errors', async (t) => {
    let pool;
    const root = await workspace(t, {
        beforeRemove: async () => {
            if (!pool) return;
            const outcome = await pool.shutdown({ timeoutMs: 5000 });
            assert.equal(outcome.clean, true, 'Explorer adapter pool shutdown must be clean.');
        },
    });
    const ploinkyRoot = process.env.PLOINKY_ROOT || fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
    const { ToolWorkerPool } = await import(pathToFileURL(path.join(ploinkyRoot, 'Agent/server/toolWorkerPool.mjs')).href);
    pool = new ToolWorkerPool('explorer-adapter', {
        command: workerPath, cwd: root, size: 1,
        env: { ASSISTOS_FS_ROOT: root, TOOL_NAME: 'ambient_wrong' },
        idleTimeoutMs: 600_000, maxCallsPerWorker: 500, callTimeoutMs: 15_000,
    });
    for (const envelope of [
        { tool: 'read_text_file', input: { path: 'ordinary.txt' } },
        { tool: 'read_text_file', input: { path: 'empty.txt' } },
        { tool: 'list_directory_detailed', input: { path: '/' } },
        { tool: 'get_avatar_settings_agents', metadata: { invocation: { actor: { id: 'user:first', roles: ['admin'] } } } },
        { tool: 'get_avatar_settings_agents', metadata: { invocation: { actor: { id: 'user:second', roles: [] } } } },
        { tool: 'missing_tool' },
        {},
    ]) {
        const expected = cli(root, envelope);
        assert.equal(expected.error, undefined);
        const actual = await pool.call({ toolName: 'ignored_callback_name', toolEnv: {}, payload: envelope });
        assert.equal(actual.code, expected.status);
        assert.equal(actual.stdout, expected.stdout.toString());
        assert.equal(actual.stderr, expected.stderr.toString());
        if (envelope.tool === 'get_avatar_settings_agents') {
            assert.equal(JSON.parse(actual.stdout).canManageAgents, envelope.metadata.invocation.actor.roles.includes('admin'));
        }
    }
    const fallback = await pool.call({ toolName: 'ignored_callback_name', toolEnv: { TOOL_NAME: 'read_text_file' }, payload: { arguments: { path: 'ordinary.txt' } } });
    assert.equal(fallback.code, 0, fallback.stderr);
    assert.equal(fallback.stdout, 'raw text\n');
    assert.equal(pool.stats().spawned, 1, 'all calls must use the same warm worker');
});

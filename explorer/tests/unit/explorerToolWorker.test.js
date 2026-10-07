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
const productionNodeOptions = '--preserve-symlinks --preserve-symlinks-main';

function capture() {
    const chunks = [];
    return {
        stdout: new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
        bytes: () => Buffer.concat(chunks),
    };
}

async function workspace(t, { beforeRemove = async () => {} } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-worker-adapter-')));
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

function cli(root, input, toolName = '', entrypoint = cliPath, nodeOptions = '') {
    return spawnSync(entrypoint.endsWith('.sh') ? '/bin/sh' : process.execPath, [entrypoint], {
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: nodeOptions, ASSISTOS_FS_ROOT: root, TOOL_NAME: toolName },
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

async function stagedSources(root) {
    const source = await fs.realpath(path.dirname(path.dirname(cliPath)));
    const directory = path.join(root, 'directory-stage');
    await fs.symlink(source, directory, 'dir');
    const entries = path.join(root, 'entry-stage');
    await fs.mkdir(path.join(entries, 'tools'), { recursive: true });
    // Match stageSourceTreeWithOverrides with an override below tools/: unaffected
    // top-level directories stay linked, while tools contains per-entry links.
    for (const name of await fs.readdir(source)) {
        if (name === 'tools') continue;
        await fs.symlink(path.join(source, name), path.join(entries, name));
    }
    for (const name of await fs.readdir(path.join(source, 'tools'))) {
        await fs.symlink(path.join(source, 'tools', name), path.join(entries, 'tools', name));
    }
    return { real: source, directory, entries };
}

test('entrypoints preserve exact CLI contracts across real and staged production paths', async (t) => {
    const root = await workspace(t);
    const sources = await stagedSources(root);
    const cases = [
        [{ tool: 'read_text_file', input: { path: 'ordinary.txt' } }, '', 0, 'raw text\n', ''],
        [{ tool: 'read_text_file', input: { path: 'empty.txt' } }, '', 0, '__ASSISTOS_EXPLORER_EMPTY_TEXT__', ''],
        [{ arguments: { path: 'ordinary.txt' } }, 'read_text_file', 0, 'raw text\n', ''],
        [{}, '', 1, '', 'Explorer tool name is missing.\n'],
        [{ tool: 'missing_tool' }, '', 1, '', 'Unknown tool: missing_tool\n'],
    ];
    const envelope = { tool: 'list_directory_detailed', input: { path: '/' } };
    const output = capture();
    await handleExplorerToolCall({ envelope, toolEnv: { ASSISTOS_FS_ROOT: root }, stdout: output.stdout });
    assert.match(output.bytes().toString(), /ordinary\.txt/);
    cases.push([envelope, '', 0, output.bytes().toString(), '']);
    for (const [layout, source] of Object.entries(sources)) {
        for (const nodeOptions of ['', productionNodeOptions]) {
            for (const entry of ['explorer_tool.mjs', 'explorer_tool.sh']) {
                await t.test(`${layout}/${entry} NODE_OPTIONS=${nodeOptions || 'ordinary'}`, () => {
                    for (const [input, name, status, stdout, stderr] of cases) {
                        const result = cli(root, input, name, path.join(source, 'tools', entry), nodeOptions);
                        assert.equal(result.error, undefined);
                        assert.equal(result.signal, null);
                        assert.equal(result.status, status, result.stderr.toString());
                        assert.equal(result.stdout.toString(), stdout);
                        assert.equal(result.stderr.toString(), stderr);
                    }
                });
            }
        }
    }
});

async function importWithOpenStdin(t, entrypoint, env) {
    const script = `await import(${JSON.stringify(pathToFileURL(entrypoint).href)}); if (process.stdin.listenerCount('readable') || process.stdin.listenerCount('data')) { console.error('IMPORT_CONSUMED_STDIN'); process.exit(91); } process.stdout.write('imported');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
}

test('importing real and staged entrypoints leaves stdin open and never starts serving', async (t) => {
    const root = await workspace(t);
    const sources = await stagedSources(root);
    const workerModulePath = path.join(root, 'import-worker-fixture.mjs');
    await fs.writeFile(workerModulePath, "export async function serveToolWorker() { process.stdout.write('WORKER_STARTED'); }\n");
    for (const [layout, source] of Object.entries(sources)) {
        for (const nodeOptions of ['', productionNodeOptions]) {
            for (const entry of ['explorer_tool.mjs', 'explorer_tool_worker.mjs']) {
                await t.test(`${layout}/${entry} NODE_OPTIONS=${nodeOptions || 'ordinary'}`, async (subtest) => {
                    await importWithOpenStdin(subtest, path.join(source, 'tools', entry), {
                        ...process.env, NODE_OPTIONS: nodeOptions, PLOINKY_TOOL_WORKER_MODULE: workerModulePath,
                    });
                });
            }
        }
    }
});

test('worker entrypoint serves a controlled callback through real and staged production paths', async (t) => {
    const root = await workspace(t);
    const sources = await stagedSources(root);
    const workerModulePath = path.join(root, 'callback-worker-fixture.mjs');
    await fs.writeFile(workerModulePath, `export async function serveToolWorker(callback) {
        const result = await callback({ envelope: JSON.parse(process.env.FIXTURE_ENVELOPE), toolEnv: {}, stdout: process.stdout, stderr: process.stderr });
        process.exitCode = result.exitCode;
    }\n`);
    for (const [layout, source] of Object.entries(sources)) {
        for (const nodeOptions of ['', productionNodeOptions]) {
            for (const entry of ['explorer_tool_worker.mjs', 'explorer_tool_worker.sh']) {
                await t.test(`${layout}/${entry} NODE_OPTIONS=${nodeOptions || 'ordinary'}`, () => {
                    for (const [envelope, status, stdout, stderr] of [
                        [{ tool: 'read_text_file', input: { path: 'ordinary.txt' } }, 0, 'raw text\n', ''],
                        [{ tool: 'read_text_file', input: { path: 'empty.txt' } }, 0, '__ASSISTOS_EXPLORER_EMPTY_TEXT__', ''],
                        [{}, 1, '', 'Explorer tool name is missing.\n'],
                        [{ tool: 'missing_tool' }, 1, '', 'Unknown tool: missing_tool\n'],
                    ]) {
                        const entrypoint = path.join(source, 'tools', entry);
                        const result = spawnSync(entry.endsWith('.sh') ? '/bin/sh' : process.execPath, [entrypoint], {
                            cwd: root, timeout: 15_000,
                            env: { ...process.env, NODE_OPTIONS: nodeOptions, TOOL_NAME: '', ASSISTOS_FS_ROOT: root, PLOINKY_TOOL_WORKER_MODULE: workerModulePath, FIXTURE_ENVELOPE: JSON.stringify(envelope) },
                        });
                        assert.equal(result.error, undefined);
                        assert.equal(result.signal, null);
                        assert.equal(result.status, status, result.stderr.toString());
                        assert.equal(result.stdout.toString(), stdout);
                        assert.equal(result.stderr.toString(), stderr);
                    }
                });
            }
        }
    }
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
    const baselineToolNames = [
        'read_file', 'read_text_file', 'read_media_file', 'read_multiple_files',
        'write_file', 'write_binary_file', 'edit_file', 'create_directory',
        'delete_file', 'delete_directory', 'list_directory', 'list_directory_with_sizes',
        'list_directory_detailed', 'directory_tree', 'move_file', 'copy_file',
        'search_files', 'search_text', 'search_text_status', 'search_text_cancel',
        'replace_text', 'get_file_info', 'open_markdown_crdt_document',
        'apply_markdown_crdt_change', 'merge_markdown_crdt_document',
        'save_markdown_crdt_document', 'sync_markdown_crdt_from_file',
        'scripta_crdt_ensure_folder', 'scripta_crdt_workspace_list', 'scripta_crdt_create',
        'scripta_crdt_open', 'scripta_crdt_mutate', 'scripta_crdt_delete',
        'webmeet_media_commit', 'webmeet_media_get', 'scripta_collaboration_open',
        'scripta_collaboration_pull', 'scripta_collaboration_apply',
        'scripta_collaboration_merge_markdown', 'llm_autocomplete', 'collect_ide_plugins',
        'get_plugin_settings', 'set_plugin_enabled', 'read_skills_manifest_state',
        'add_skills_manifest_repo', 'set_skills_manifest_skill_enabled',
        'remove_skills_manifest_repo', 'list_allowed_directories',
        'get_avatar_settings_agents', 'update_avatar_settings_agent',
        'set_avatar_settings_agent_visibility',
    ];
    assert.deepEqual(descriptor.tools.map(tool => tool.name), baselineToolNames);
    for (const tool of descriptor.tools) {
        assert.equal(tool.worker, undefined, tool.name);
        assert.deepEqual({
            command: tool.command,
            cwd: tool.cwd,
            env: tool.env,
            args: tool.args,
            timeoutMs: tool.timeoutMs,
            async: tool.async,
        }, {
            command: tool.name === 'llm_autocomplete' ? 'tools/llm_autocomplete_tool.sh' : 'tools/explorer_tool.sh',
            cwd: 'workspace',
            env: { TOOL_NAME: tool.name },
            args: undefined,
            timeoutMs: undefined,
            async: undefined,
        }, tool.name);
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

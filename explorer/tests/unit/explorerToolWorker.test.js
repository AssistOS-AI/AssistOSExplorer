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

// Tools that stay in spawn mode, with the reason each one is excluded from the warm pool.
const spawnOnlyTools = {
    search_text: 'runs for up to 30 s and would hold a pool lane',
    replace_text: 'runs for up to 45 s and would hold a pool lane',
    update_avatar_settings_agent: 'imports code from AXIFACE_REPO_PATH, outside the code-identity roots',
    llm_autocomplete: 'uses its own command, tools/llm_autocomplete_tool.sh',
    add_skills_manifest_repo: 'calls the Router repository client (install/listRepositories, 30 s timeouts)',
    set_skills_manifest_skill_enabled: 'calls the Router repository client (install/listRepositories, 30 s timeouts)',
    remove_skills_manifest_repo: 'calls the Router repository client (remove/install, 30 s timeouts)',
    read_skills_manifest_state: 'caches repositories through the Router repository client (listRepositories/prepareRepository)',
};

async function readDescriptor() {
    return JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
}

test('E4: exactly the approved tools opt in to the explorer warm pool and the rest keep their spawn contract', async () => {
    const descriptor = await readDescriptor();
    assert.deepEqual(descriptor.toolWorkers, {
        explorer: { command: 'tools/explorer_tool_worker.sh', cwd: 'workspace', size: 3 },
    });
    assert.deepEqual(descriptor.tools.map(tool => tool.name), baselineToolNames);
    for (const tool of descriptor.tools) {
        const excluded = Object.hasOwn(spawnOnlyTools, tool.name);
        assert.equal(tool.worker, excluded ? undefined : 'explorer', tool.name);
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
        // resolveToolWorkerPool requires the tool cwd to equal the pool cwd.
        if (!excluded) assert.equal(tool.cwd, descriptor.toolWorkers.explorer.cwd, tool.name);
    }
});

test('B-T4: the worker set and the documented spawn-only set are pinned exactly', async () => {
    const descriptor = await readDescriptor();
    const workers = descriptor.tools.filter(tool => tool.worker === 'explorer').map(tool => tool.name);
    const spawnOnly = descriptor.tools.filter(tool => tool.worker === undefined).map(tool => tool.name).sort();
    assert.equal(workers.length, 43);
    assert.deepEqual(spawnOnly, Object.keys(spawnOnlyTools).sort());
    assert.deepEqual(spawnOnly, [
        'add_skills_manifest_repo', 'llm_autocomplete', 'read_skills_manifest_state', 'remove_skills_manifest_repo',
        'replace_text', 'search_text', 'set_skills_manifest_skill_enabled', 'update_avatar_settings_agent',
    ]);
    assert.equal(workers.length + spawnOnly.length, 51);
    // The worker script must be tracked executable for the pool to launch it.
    const mode = (await fs.stat(workerPath)).mode & 0o111;
    assert.notEqual(mode, 0, 'tools/explorer_tool_worker.sh must be executable');
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

async function realPool(t, root, options = {}) {
    const ploinkyRoot = process.env.PLOINKY_ROOT || fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
    const { ToolWorkerPool } = await import(pathToFileURL(path.join(ploinkyRoot, 'Agent/server/toolWorkerPool.mjs')).href);
    const logs = [];
    const pool = new ToolWorkerPool('explorer', {
        command: workerPath, cwd: root, size: 3,
        env: { ASSISTOS_FS_ROOT: root },
        idleTimeoutMs: 600_000, maxCallsPerWorker: 500, callTimeoutMs: 15_000,
        log: line => logs.push(line),
        ...options,
    });
    t.after(async () => {
        const outcome = await pool.shutdown({ timeoutMs: 5000 });
        assert.equal(outcome.clean, true, 'Explorer pool shutdown must be clean.');
    });
    return { pool, logs };
}

function spawnCall(root, envelope, entrypoint = path.join(path.dirname(workerPath), 'explorer_tool.sh')) {
    return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', [entrypoint], {
            cwd: root, env: { ...process.env, ASSISTOS_FS_ROOT: root, TOOL_NAME: '' }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const out = [];
        const err = [];
        child.stdout.on('data', chunk => out.push(chunk));
        child.stderr.on('data', chunk => err.push(chunk));
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
        child.stdin.end(JSON.stringify(envelope));
    });
}

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const timed = async operation => { const started = performance.now(); await operation(); return performance.now() - started; };

test('B-T1: invocation tokens and identities never reach another call, the output or the pool log', async (t) => {
    const root = await workspace(t);
    const { pool, logs } = await realPool(t, root, { size: 1 });
    // Mirrors the context AgentServer builds: the verified grant plus the raw token and the request headers.
    const metadataFor = (id, roles, token, caller) => ({
        invocation: { actor: { id, roles }, ...(caller ? { caller: { id: caller } } : {}) },
        invocationToken: token,
        requestInfo: { headers: { 'x-ploinky-invocation': token, authorization: `Bearer ${token}` } },
    });
    const call = (tool, metadata, input) => pool.call({ toolName: 'ignored', toolEnv: {}, payload: { tool, input, metadata } });
    const avatars = metadata => call('get_avatar_settings_agents', metadata, {});
    const secrets = ['TOKEN-ALPHA-7f3a9c', 'TOKEN-BRAVO-51d2e8', 'TOKEN-CHARLIE-0b6e44', 'TOKEN-DELTA-92c1aa'];
    const results = [];
    const first = await avatars(metadataFor('user:alpha', ['admin'], secrets[0]));
    const noMetadata = await avatars(undefined);
    const second = await avatars(metadataFor('user:bravo', [], secrets[1]));
    const third = await avatars(metadataFor('user:charlie', ['admin'], secrets[2]));
    const afterEmpty = await call('get_avatar_settings_agents', {}, {});
    results.push(first, noMetadata, second, third, afterEmpty);
    assert.equal(JSON.parse(first.stdout).canManageAgents, true);
    assert.equal(JSON.parse(noMetadata.stdout).canManageAgents, false, 'a call without metadata must not inherit the previous admin');
    assert.equal(JSON.parse(second.stdout).canManageAgents, false);
    assert.equal(JSON.parse(third.stdout).canManageAgents, true);
    assert.equal(JSON.parse(afterEmpty.stdout).canManageAgents, false, 'empty metadata must not inherit the previous admin');

    // SCRIPTA caller gate: an allowed caller does not leave the permission behind for the next call.
    const scriptaAllowed = await call('scripta_crdt_workspace_list', metadataFor('user:alpha', ['admin'], secrets[3], 'agent:AchillesIDE/webmeetAgent'), { defaultFolder: '/' });
    assert.equal(scriptaAllowed.code, 0, scriptaAllowed.stderr);
    for (const metadata of [undefined, {}, metadataFor('user:alpha', ['admin'], secrets[3], 'agent:AchillesIDE/otherAgent')]) {
        const denied = await call('scripta_crdt_workspace_list', metadata, { defaultFolder: '/' });
        assert.equal(denied.code, 1);
        assert.match(denied.stderr, /SCRIPTA CRDT tools are restricted to webmeetAgent/);
        results.push(denied);
    }
    results.push(scriptaAllowed);
    assert.equal(pool.stats().spawned, 1, 'every call used the same warm worker');
    const everything = results.map(r => r.stdout + r.stderr).join('\n') + logs.join('\n');
    for (const secret of secrets) assert.equal(everything.includes(secret), false, `${secret} must not appear in outputs or pool logs`);
    for (const actor of ['user:alpha', 'user:bravo', 'user:charlie']) assert.equal(everything.includes(actor), false, actor);
});

test('B-T2: a failed call leaves the warm worker able to serve the next call with spawn-identical bytes', async (t) => {
    const root = await workspace(t);
    const { pool } = await realPool(t, root, { size: 1 });
    const sequence = [
        { tool: 'read_text_file', input: { path: 'ordinary.txt' } },
        { tool: 'read_text_file', input: { path: 'does-not-exist.txt' } },
        { tool: 'missing_tool' },
        { tool: 'read_text_file', input: { path: 'ordinary.txt', head: 'not-a-number' } },
        {},
        { tool: 'read_text_file', input: { path: 'ordinary.txt' } },
    ];
    for (const envelope of sequence) {
        const expected = await spawnCall(root, envelope);
        const actual = await pool.call({ toolName: 'ignored', toolEnv: {}, payload: envelope });
        assert.equal(actual.code, expected.code, JSON.stringify(envelope));
        assert.equal(actual.stdout, expected.stdout, JSON.stringify(envelope));
        assert.equal(actual.stderr, expected.stderr, JSON.stringify(envelope));
    }
    assert.equal(pool.stats().spawned, 1, 'failures did not force a new worker');
});

test('B-T3: an external write is visible to the next call on the same worker', async (t) => {
    const root = await workspace(t);
    const { pool } = await realPool(t, root, { size: 1 });
    const read = async () => (await pool.call({ toolName: 'ignored', toolEnv: {}, payload: { tool: 'read_text_file', input: { path: 'ordinary.txt' } } })).stdout;
    const list = async () => (await pool.call({ toolName: 'ignored', toolEnv: {}, payload: { tool: 'list_directory_detailed', input: { path: '/' } } })).stdout;
    assert.equal(await read(), 'raw text\n');
    assert.doesNotMatch(await list(), /external\.txt/);
    await fs.writeFile(path.join(root, 'ordinary.txt'), 'changed outside the worker\n');
    await fs.writeFile(path.join(root, 'external.txt'), 'new\n');
    assert.equal(await read(), 'changed outside the worker\n');
    assert.match(await list(), /external\.txt/);
    await fs.rm(path.join(root, 'external.txt'));
    assert.doesNotMatch(await list(), /external\.txt/);
    assert.equal(pool.stats().spawned, 1);
});

test('AC-B7: warm worker tools/call latency beats spawn mode on the same fixture (N=20)', async (t) => {
    const root = await workspace(t);
    const { pool } = await realPool(t, root, { size: 1 });
    const envelope = { tool: 'list_directory_detailed', input: { path: '/' } };
    const viaPool = () => pool.call({ toolName: 'ignored', toolEnv: {}, payload: envelope });
    const expected = await spawnCall(root, envelope);
    assert.equal((await viaPool()).stdout, expected.stdout, 'the worker is warmed by this parity call');
    const spawnTimes = [];
    const workerTimes = [];
    for (let index = 0; index < 20; index += 1) {
        spawnTimes.push(await timed(() => spawnCall(root, envelope)));
        workerTimes.push(await timed(viaPool));
    }
    const spawnP50 = percentile(spawnTimes, 0.5);
    const workerP50 = percentile(workerTimes, 0.5);
    const line = `AC-B7 N=20 list_directory_detailed: worker p50=${workerP50.toFixed(1)}ms spawn p50=${spawnP50.toFixed(1)}ms`;
    t.diagnostic(line);
    console.log(line);
    assert.ok(workerP50 < spawnP50, line);
    assert.equal(pool.stats().spawned, 1);
});

test('B-T5: a burst with a slow network-bound-style call is no slower than spawn mode and the slow call does not block fast ones', async (t) => {
    const root = await workspace(t);
    const slowMs = 1200;
    const script = path.join(root, 'burst_worker.mjs');
    const explorerTool = pathToFileURL(path.join(path.dirname(workerPath), 'explorer_tool.mjs')).href;
    await fs.writeFile(script, `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleExplorerToolCall } from ${JSON.stringify(explorerTool)};
const { serveToolWorker } = await import(pathToFileURL(process.env.PLOINKY_TOOL_WORKER_MODULE).href);
await serveToolWorker(async ({ envelope, toolEnv, stdout, stderr }) => {
    try {
        if (envelope.tool === 'slow_network_fixture') {
            await new Promise(resolve => setTimeout(resolve, ${slowMs}));
            stdout.write('slow done');
        } else {
            await handleExplorerToolCall({ envelope, toolEnv, stdout });
        }
        return { exitCode: 0 };
    } catch (error) {
        stderr.write(String(error?.message || error) + '\\n');
        return { exitCode: 1 };
    }
});
`);
    const { pool } = await realPool(t, root, { command: process.execPath, args: [script], size: 3 });
    const fast = { tool: 'list_directory_detailed', input: { path: '/' } };
    const viaPool = envelope => pool.call({ toolName: 'ignored', toolEnv: {}, payload: envelope });
    await Promise.all([viaPool(fast), viaPool(fast), viaPool(fast)]); // warm every lane
    const burst = async (run, withSlow) => {
        const started = performance.now();
        const latencies = [];
        const calls = [];
        if (withSlow) calls.push(run({ tool: 'slow_network_fixture' }));
        for (let index = 0; index < 12; index += 1) {
            calls.push(run(fast).then(result => { latencies.push(performance.now() - started); return result; }));
        }
        const results = await Promise.all(calls);
        return { latencies, results };
    };
    const workerBurst = await burst(viaPool, true);
    const spawnBurst = await burst(envelope => spawnCall(root, envelope), false);
    for (const result of workerBurst.results.slice(1)) assert.equal(result.code, 0, result.stderr);
    const workerP90 = percentile(workerBurst.latencies, 0.9);
    const spawnP90 = percentile(spawnBurst.latencies, 0.9);
    const line = `B-T5 burst of 12: worker p90=${workerP90.toFixed(1)}ms (with one ${slowMs}ms slow lane) spawn p90=${spawnP90.toFixed(1)}ms`;
    t.diagnostic(line);
    console.log(line);
    assert.ok(workerP90 <= spawnP90, line);
    assert.ok(Math.max(...workerBurst.latencies) < slowMs, 'fast calls finished while the slow call still held its lane');
});

test('a lock release that cannot be confirmed recycles its worker so another live worker recovers immediately', async (t) => {
    const root = await workspace(t);
    const adapter = pathToFileURL(path.join(path.dirname(workerPath), 'explorer_tool_worker.mjs')).href;
    const script = path.join(root, 'faulty_worker.mjs');
    const faultFile = path.join(root, 'fault-pid.txt');
    // Only the worker whose pid is in fault-pid.txt fails its first lock-file removal (EIO); everything else
    // is the real adapter handler. The fixtures report the worker pid and keep a worker busy.
    await fs.writeFile(script, `
import fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const realRm = fsp.rm.bind(fsp);
let failed = false;
fsp.rm = async (file, options) => {
    if (!failed && String(file).includes('/.locks/')) {
        let target = '';
        try { target = readFileSync(${JSON.stringify(faultFile)}, 'utf8').trim(); } catch {}
        if (target === String(process.pid)) { failed = true; throw Object.assign(new Error('EIO simulated'), { code: 'EIO' }); }
    }
    return realRm(file, options);
};
const { createExplorerWorkerHandler } = await import(${JSON.stringify(adapter)});
const real = createExplorerWorkerHandler();
const { serveToolWorker } = await import(pathToFileURL(process.env.PLOINKY_TOOL_WORKER_MODULE).href);
await serveToolWorker(async (call) => {
    if (call.envelope.tool === 'pid_fixture' || call.envelope.tool === 'hold_fixture') {
        if (call.envelope.tool === 'hold_fixture') await new Promise(resolve => setTimeout(resolve, 900));
        call.stdout.write(String(process.pid));
        return { exitCode: 0 };
    }
    return real(call);
});
`);
    await fs.writeFile(path.join(root, 'doc.md'), '# Doc\n');
    const { pool, logs } = await realPool(t, root, { command: process.execPath, args: [script], size: 2 });
    const callTool = (tool, input) => pool.call({ toolName: 'ignored', toolEnv: {}, payload: { tool, input } });
    // Two concurrent holds cannot share a worker, so both workers are spawned and warm afterwards.
    const warm = await Promise.all([callTool('hold_fixture'), callTool('hold_fixture')]);
    assert.equal(new Set(warm.map(result => result.stdout)).size, 2, 'two distinct warm workers');
    // Worker A is held busy, so the next two calls run on worker B, the one that will leak its lock.
    const holding = callTool('hold_fixture');
    const leaker = await callTool('pid_fixture');
    await fs.writeFile(faultFile, leaker.stdout);
    const opened = await callTool('open_markdown_crdt_document', { path: 'doc.md' });
    assert.equal(opened.code, 0, opened.stderr);
    const holder = await holding;
    assert.notEqual(holder.stdout, leaker.stdout, 'the contender will run on the other worker');
    const started = Date.now();
    const contender = await callTool('sync_markdown_crdt_from_file', { path: 'doc.md' });
    const elapsed = Date.now() - started;
    assert.equal(contender.code, 0, contender.stderr);
    assert.ok(elapsed < 3000, `the contender waited ${elapsed} ms for a lock owned by a live worker\n${logs.join('\n')}`);
    assert.ok(pool.stats().recycled >= 1, 'the worker with the unconfirmed release was recycled');
});

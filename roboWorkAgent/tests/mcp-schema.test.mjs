import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { siblingRoot } from '../../tests/helpers/sibling-roots.mjs';
import { invoke } from '../tools/robowork.mjs';
import { RobotPaths } from '../server/robot-paths.mjs';
import { RunManager } from '../server/run-manager.mjs';
import { createRoboWorkServer } from '../server/http-server.mjs';
import { alaSkillMountArguments } from '../../roboTeamAgent/copilot/src/lib/execution/alaSkillMounts.mjs';

// Load the real compiler bytes with the installed runtime SDK, without changing either checkout.
const ploinkyRoot = siblingRoot('ploinky');
const compilerRoot = await fs.mkdtemp('/tmp/rw-schema-');
after(() => fs.rm(compilerRoot, { recursive: true, force: true }));
await fs.mkdir(path.join(compilerRoot, 'node_modules'));
const sdk = await fs.realpath(process.env.MCP_SDK_ROOT || path.join(ploinkyRoot, 'node_modules', 'mcp-sdk'));
await fs.symlink(sdk, path.join(compilerRoot, 'node_modules', 'mcp-sdk'));
for (const name of ['toolInputSchemaCache.mjs', 'inputSchema.mjs']) {
    const source = await fs.readFile(path.join(ploinkyRoot, 'Agent', 'server', name));
    await fs.writeFile(path.join(compilerRoot, name), source);
    assert.deepEqual(await fs.readFile(path.join(compilerRoot, name)), source);
}
const { getConfiguredToolInputSchema } = await import(pathToFileURL(path.join(compilerRoot, 'toolInputSchemaCache.mjs')).href);
const config = JSON.parse(await fs.readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
const schema = name => getConfiguredToolInputSchema(config, config.tools.find(tool => tool.name === name)).schema;
const subject = 'agent:AchillesIDE/roboTeamAgent';
const metadata = { invocation: { sub: subject, actor: { kind: 'agent', id: subject } } };

async function service(t) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-mcp-'));
    const workspaceRoot = path.join(root, 'workspace');
    const cwd = path.join(workspaceRoot, 'project');
    const dataDir = path.join(root, 'data');
    const skill = path.join(workspaceRoot, 'skills');
    for (const directory of [cwd, dataDir, skill]) await fs.mkdir(directory, { recursive: true });
    const paths = new RobotPaths({ dataDir, workspaceRoot });
    const guiCalls = [], launches = [], payloads = [];
    const gui = { ensureReady: async input => { guiCalls.push(input); return { mcpPort: 34568 }; } };
    const runs = new RunManager({ paths, gui, alaEntry: '/unused',
        robots: { require: async id => ({ id, codingAgents: ['opencode'] }) },
        toolCache: { root: path.join(dataDir, 'tool-cache'), prepareCodingAgents: async () => ({}) },
        buildLaunch: async input => { launches.push(input); return { command: process.execPath,
            args: ['-e', "process.stdin.on('data',b=>process.stdout.write(b));"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; },
    });
    await runs.initialize();
    const server = createRoboWorkServer({ robots: {}, runs, gui, environment: {}, internalToken: 'fixture-capability' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await runs.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    const call = (name, input, authority = metadata) => invoke({ tool: name, input: schema(name).parse(input), metadata: authority }, name, {
        env: { ROBOWORK_INTERNAL_TOKEN: 'fixture-capability', ROBOWORK_SERVICE_PORT: String(server.address().port) },
        fetchImpl: async (url, options) => { payloads.push(JSON.parse(options.body)); return fetch(url, options); },
    });
    const input = { runId: 'schema-run', robotId: 'aaa', cwd, ala: { sessionId: 'session-1', ca: 'opencode', permissions: 'full-access',
        turnId: 'turn-1', model: 'provider/model', effort: 'high', resume: false, workflowExecution: false,
        mcpServers: ['external=https://example.invalid/mcp'] },
    folders: [{ source: skill, alias: 'roboteam-skill-0', expose: true }], ignore: [],
    channels: [{ name: 'ploinky-runtime', context: { version: 3, workingDir: cwd,
        resources: [{ type: 'file', metadata: { labels: ['one'], enabled: true } }], paths: [cwd], origin: { nested: { value: null } } } }],
    gui: { mode: 'browser', cwd, allowReplace: false },
    tag: { kind: 'copilot', producer: { pid: 123, startStamp: '456' }, nested: { values: [null, 1, true, 'text'] } } };
    return { paths, runs, call, input, guiCalls, launches, payloads };
}

test('published compiler preserves run inputs through the real tool entry and resident validation', async t => {
    const { paths, runs, call, input, guiCalls, launches, payloads } = await service(t);
    assert.deepEqual(schema('run_start').parse(input), input);
    assert.equal((await call('run_start', input)).state, 'starting');
    await runs.get(input.runId).preparing;
    assert.deepEqual(payloads[0], input);
    assert.deepEqual(runs.get(input.runId).meta.ala, input.ala);
    assert.deepEqual(runs.get(input.runId).meta.tag, input.tag);
    assert.equal(guiCalls[0].mode, 'browser');
    assert.equal(guiCalls[0].allowReplace, false);
    assert.equal(launches[0].guiPort, 34568);
    assert.ok(launches[0].args.includes('roboteam-skill-0'));
    const context = JSON.parse(await fs.readFile(path.join(paths.run(input.runId), 'channels', 'ploinky-runtime', 'context.json'), 'utf8'));
    assert.deepEqual(context.resources, input.channels[0].context.resources);
    assert.deepEqual(context.origin, input.channels[0].context.origin);
    assert.ok(!Object.hasOwn(context, 'producer'));
    await call('run_input', { runId: input.runId, data: Buffer.from('decoded stdin\n').toString('base64') });
    let output;
    for (let attempt = 0; attempt < 20; attempt++) {
        output = await call('run_read', { runId: input.runId, after: 0, waitMs: 100 });
        if (output.records.some(record => record.stream === 'stdout')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(output.records.filter(record => record.stream === 'stdout').map(record => Buffer.from(record.data, 'base64').toString()).join(''), 'decoded stdin\n');
    const socketPath = path.join(paths.run(input.runId), 'channels', 'ploinky-runtime', 'request.sock');
    for (const body of [{ opaque: { entries: [1, false, null, { value: 'kept' }] } }, ['array', null], null, 'text']) {
        const response = new Promise((resolve, reject) => {
            const req = http.request({ socketPath, path: '/agent-call', method: 'POST', headers: { 'x-task-capability': context.token } }, res => {
                let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text)));
            });
            req.on('error', reject); req.end(JSON.stringify({ agent: 'roboTeamAgent', tool: 'roboflow_list_workflows', payload: {} }));
        });
        let callbacks;
        for (let attempt = 0; attempt < 20; attempt++) {
            callbacks = (await call('run_read', { runId: input.runId, after: output.next, waitMs: 100 })).callbacks;
            if (callbacks.length) break;
        }
        assert.equal(callbacks.length, 1);
        const reply = { runId: input.runId, reply: { id: callbacks[0].id, status: 200, body } };
        assert.deepEqual(schema('run_input').parse(reply), reply);
        await call('run_input', reply);
        assert.deepEqual(await response, body);
    }
});

test('published nested schemas reject wrong types and remove unapproved sandbox options', async t => {
    const { input } = await service(t);
    for (const changed of [
        { ala: { ...input.ala, sessionId: 1 } }, { ala: { ...input.ala, resume: 'yes' } },
        { folders: [{ source: false }] }, { folders: [{ ...input.folders[0], expose: 'yes' }] },
        { channels: [{ name: 'ploinky-runtime', context: [] }] }, { gui: { mode: 1 } },
    ]) assert.equal(schema('run_start').safeParse({ ...input, ...changed }).success, false);
    for (const reply of [{ id: 1, status: 200, body: {} }, { id: 'id', status: '200', body: {} }]) {
        assert.equal(schema('run_input').safeParse({ runId: input.runId, reply }).success, false);
    }
    const parsed = schema('run_start').parse({ ...input, ala: { ...input.ala, env: { BAD: 'value' }, sandboxArgs: ['--share-net'] },
        gui: { ...input.gui, env: { BAD: 'value' } } });
    assert.deepEqual(parsed.ala, input.ala);
    assert.deepEqual(parsed.gui, input.gui);
    for (const tool of config.tools) assert.ok(getConfiguredToolInputSchema(config, tool).schema);
});

test('real parser and tool entry preserve caller, private-folder and callback-context refusals', async t => {
    const { paths, input, call, runs } = await service(t);
    await assert.rejects(call('run_start', input, { invocation: { sub: 'user:a', actor: { kind: 'user', id: 'user:a' } } }), { code: 'CALLER_REFUSED' });
    await assert.rejects(call('run_start', { ...input, folders: [{ source: paths.dataDir, alias: 'private' }] }), { code: 'FOLDER_REFUSED' });
    await assert.rejects(call('run_start', { ...input, channels: [{ name: 'ploinky-runtime', context: { PLOINKY_AGENT_SECRET: 'forbidden' } }] }), { code: 'INVALID_INPUT' });
    assert.equal(runs.list().length, 0);
});

test('actual skill overlays in a public workspace under home survive schema and service while protected targets are refused', async t => {
    const { paths, input, call, runs, launches } = await service(t);
    const workspace = '/home/skutner/work/roboworkMinimalE2E';
    const cwd = path.join(workspace, 'project');
    // Sources stay in the real temporary fixture; only target geometry represents the Linux host.
    const sourceGrant = paths.grant.bind(paths);
    paths.workspaceRoot = workspace;
    paths.privateRoot = path.join(workspace, '.data', '.private');
    paths.grant = (value, kind) => kind === 'cwd' && value === cwd ? Promise.resolve(cwd) : sourceGrant(value, kind);
    const source = input.folders[0].source;
    const skillArgs = alaSkillMountArguments({ cwd, snapshot: { skillsDirectory: source,
        mounts: [0, 1, 2].map(index => ({ source, target: `/workspace/roboteam-skill-${index}` })) } });
    const folders = [];
    for (let index = 0; index < skillArgs.length; index += 5) {
        assert.equal(skillArgs[index], '--folder'); assert.equal(skillArgs[index + 2], 'at'); assert.equal(skillArgs[index + 4], 'expose');
        folders.push({ source: skillArgs[index + 1], at: skillArgs[index + 3], expose: true });
    }
    assert.equal(folders.length, 5);
    assert.deepEqual(folders.slice(-2).map(folder => folder.at), [path.join(cwd, '.agents', 'skills'), path.join(cwd, '.claude', 'skills')]);
    const request = { ...input, cwd, folders, gui: undefined };
    assert.equal((await call('run_start', request)).state, 'starting');
    await runs.get(request.runId).preparing;
    assert.deepEqual(runs.get(input.runId).meta.tag, input.tag);
    for (const folder of folders) assert.ok(launches[0].args.some((value, index) => value === 'at' && launches[0].args[index + 1] === folder.at));
    const forbidden = ['/', '/home', '/home/skutner', '/home/victim', '/home/aaa', workspace,
        path.join(workspace, '.data'), path.join(workspace, '.data', '.private', 'victim'),
        path.join(workspace, '.ploinky'), path.join(workspace, '.env'), path.join(cwd, '.roboteam'),
        `${workspace}-sibling/project/.agents/skills`, '/data', '/data/robots/victim/home', '/proc/self/fd', '/sys/kernel',
        '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/workspace'];
    for (const [index, at] of forbidden.entries()) {
        await assert.rejects(call('run_start', { ...request, runId: `refused-${index}`, folders: [{ source, at, expose: true }] }),
            { code: 'FOLDER_REFUSED' }, at);
    }
    assert.equal(runs.list().length, 1);
});

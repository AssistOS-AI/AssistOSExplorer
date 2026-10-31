import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createExecutionChannels } from '../../../robo-work/server/runtime/channels.mjs';
import { createWorkflowCatalogRequests } from '../../../robo-work/server/runtime/workflowCatalogRequests.mjs';
import { createVerifiedCoordinatorContext, skillsSelectionDigest } from '../../../robo-work/server/stateProtocol.mjs';
import { S6_LIMITS, WORKSPACE, admitRequest, newId, openStore, readyRobot, syntheticContext } from '../../../robo-work/tests/helpers/synthetic.mjs';
import { WorkflowRegistry } from '../../server/roboflow/workflow-registry.mjs';
import { RoboFlowService } from '../../server/roboflow/roboflow-service.mjs';
import { createWorkflowCatalogBridge } from '../../server/worker-coordinator/workflow-catalog.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../src/skills/list-workflows/scripts/run.mjs', import.meta.url));
const COORDINATOR = 'agent:AchillesIDE/roboTeamAgent';

async function fixture(t) {
    // /tmp keeps the Unix socket below the platform path bound, including on macOS.
    const directory = await fs.realpath(await fs.mkdtemp('/tmp/rw-wfc-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'state'));
    const store = openStore(path.join(directory, 'state'), { limits: S6_LIMITS });
    t.after(() => store.close());
    const owner = syntheticContext({ ownerId: 'user:alice', originNamespace: `coordinator:${COORDINATOR}`, originKey: 'owner:user:alice' });
    const robotId = readyRobot(store, owner);
    const skills = [{ name: 'list-workflows', path: '/workspace/skills/list-workflows', required: true }];
    const admitted = store.admit(owner, admitRequest(robotId, { kind: 'turn', logical: { sessionKey: newId() },
        specification: { version: 2, prompt: 'unchanged', displayText: '', sessionId: 'session', turnId: 'turn', permissions: 'full-access',
            workflowCatalog: true, skills, skillsDigest: skillsSelectionDigest(skills) } }, owner));
    const ids = { executionId: admitted.executionId, attemptId: admitted.attemptId };
    store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' });
    const requests = createWorkflowCatalogRequests({ store });
    t.after(() => requests.close());
    const handle = requests.registerAttempt(ids);
    const channelsDir = path.join(directory, 'channels');
    await fs.mkdir(channelsDir);
    const channels = await createExecutionChannels({ directory: channelsDir, workflowCatalog: handle });
    t.after(() => channels.close());
    const socket = path.join(channelsDir, 'workflow-catalog', 'request.sock');
    const coordinator = createVerifiedCoordinatorContext({ workspaceId: WORKSPACE, scope: 'catalog', coordinator: COORDINATOR, operations: ['workflow_catalog'] });
    const hop = { async call(operation, body) {
        const json = operation === 'workflow-catalog/requests' ? requests.listPending(coordinator)
            : requests.reply(coordinator, { referenceId: operation.split('/')[1], ...body });
        return { outcome: 'response', status: 200, json };
    } };
    const registry = new WorkflowRegistry({ directory: path.join(directory, 'flows') });
    await registry.initialize();
    let reads = 0;
    const roboflow = { registry, robotStore: { async list() { return []; } }, async listWorkflows() {
        reads += 1;
        return RoboFlowService.prototype.listWorkflows.call(this);
    } };
    const bridge = createWorkflowCatalogBridge({ roboflow, hop, pollMs: 5 });
    bridge.start();
    t.after(() => bridge.close());
    const preload = path.join(directory, 'preload.mjs');
    // Test-only path remap: production has no destination/environment override. Linux runtime verification uses the actual mount.
    await fs.writeFile(preload, `import fs from 'node:fs'; import http from 'node:http';
const exists = fs.existsSync; fs.existsSync = (value) => value === '/run/robo-work' || exists(value);
const request = http.request; http.request = (options, ...args) => request({ ...options,
socketPath: options.socketPath === '/run/robo-work/channels/workflow-catalog/request.sock' ? ${JSON.stringify(socket)} : options.socketPath }, ...args);
`);
    const script = (args = []) => run(process.execPath, ['--import', preload, SCRIPT, ...args], { cwd: os.tmpdir(), timeout: 5000, env: { PATH: process.env.PATH } });
    return { directory, socket, script, registry, channels, bridge, handle, requests, coordinator, reads: () => reads };
}

function call(socket, { body = '{}', route = '/list-workflows', method = 'POST' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: socket, path: route, method, agent: false, headers: { 'content-length': Buffer.byteLength(body) } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('actual skill subprocess uses a real Unix catalog channel without /Agent and sees actual file edits on each read', async (t) => {
    const f = await fixture(t);
    assert.equal((await f.script()).stdout.trim(), 'No RoboFlow workflow types are defined yet.');
    const definition = { id: 'daily', name: 'Daily 工作', description: 'Unicode é', defaultObjective: 'SECRET OBJECTIVE', entryTaskId: 'one', edges: [],
        tasks: [{ id: 'one', name: 'Review', prompt: 'SECRET PROMPT', executionType: 'terminal', skillsets: [] }] };
    const file = path.join(f.directory, 'flows', 'daily.json');
    await fs.writeFile(file, JSON.stringify(definition));
    const before = await f.script();
    assert.match(before.stdout, /Daily 工作.*Review \(terminal\).*saved default prompt/s);
    assert.doesNotMatch(before.stdout, /SECRET|\/tmp\/|coverage|robot/);
    await fs.writeFile(file, JSON.stringify({ ...definition, name: 'Edited now' }));
    assert.match((await f.script()).stdout, /Edited now/);
    assert.equal(f.reads(), 3);
    await assert.rejects(f.script(['--input', '{}']), (error) => error.code === 1 && error.stderr.trim() === 'invalid_request');
    f.handle.close();
    await assert.rejects(f.script(), (error) => error.code === 1 && error.stderr.trim() === 'execution_ended');
});

test('catalog Unix channel refuses alternate routes/methods, malformed/nonempty input and request byte overflow', async (t) => {
    const f = await fixture(t);
    for (const options of [{ route: '/list-workflows?x=1' }, { route: '/other' }, { method: 'GET' }, { body: '[]' }, { body: 'null' },
        { body: '{bad' }, { body: '{"owner":"alice"}' }, { body: ' '.repeat(1023) + '{}' }]) {
        assert.deepEqual(await call(f.socket, options), { status: 400, body: { ok: false, error: 'invalid_request' } });
    }
    assert.deepEqual(await call(f.socket, { body: ' '.repeat(1022) + '{}' }), { status: 200, body: { ok: true, workflows: [] } });
});

test('catalog client disconnect removes its pending read and channel end rejects another read before socket shutdown', async (t) => {
    const f = await fixture(t);
    await f.bridge.close();
    const waitFor = async (count) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (f.requests.listPending(f.coordinator).requests.length === count) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail(`pending catalog count did not become ${count}`);
    };
    const req = http.request({ socketPath: f.socket, path: '/list-workflows', method: 'POST', agent: false,
        headers: { 'content-length': '2' } });
    req.on('error', () => {});
    req.end('{}');
    await waitFor(1);
    req.destroy();
    await waitFor(0);
    const pending = f.handle.read();
    const ended = assert.rejects(pending, { code: 'execution_ended' });
    await f.channels.close();
    await ended;
    await assert.rejects(fs.stat(f.socket), { code: 'ENOENT' });
});

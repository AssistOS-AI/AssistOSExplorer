import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWorkflowCatalogBridge, projectWorkflowCatalog } from '../server/worker-coordinator/workflow-catalog.mjs';
import { createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';

const id = () => crypto.randomBytes(16).toString('base64url');
const pending = () => ({ referenceId: id(), attemptId: id(), requestId: id() });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('catalog bridge projects only listing fields, refuses byte overflow and reads each pending request separately', async () => {
    const privateWorkflow = { id: 'daily', name: '工作', description: 'é', defaultObjective: 'SECRET OBJECTIVE', source: { path: '/private/path' },
        coverage: { robot: 'private' }, tasks: [{ name: 'Check', executionType: 'browser', prompt: 'SECRET PROMPT', credential: 'SECRET VALUE' }] };
    const projected = projectWorkflowCatalog([privateWorkflow]);
    assert.deepEqual(projected, { ok: true, workflows: [{ id: 'daily', name: '工作', description: 'é', hasDefaultObjective: true, tasks: [{ name: 'Check', executionType: 'browser' }] }] });
    assert.doesNotMatch(JSON.stringify(projected), /SECRET|\/private|coverage|credential|prompt/);
    assert.deepEqual(projectWorkflowCatalog([{ ...privateWorkflow, description: 'é'.repeat(256 * 1024) }]), { ok: false, error: 'catalog_too_large' });
    const rows = [pending(), pending()];
    const calls = [];
    let reads = 0;
    let wake;
    const bridge = createWorkflowCatalogBridge({ roboflow: { async listWorkflows() { reads += 1; return [{ ...privateWorkflow, name: `read-${reads}` }]; } },
        timers: { setTimeout(fn) { wake = fn; return 1; }, clearTimeout() {} },
        hop: { async call(operation, body, options) {
            calls.push({ operation, body, options });
            return { outcome: 'response', status: 200, json: operation === 'workflow-catalog/requests' ? { requests: rows } : { ok: true, settled: true } };
        } } });
    bridge.start();
    await tick();
    assert.equal(reads, 2);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].body.result.workflows[0].name, 'read-1');
    assert.equal(calls[2].body.result.workflows[0].name, 'read-2');
    assert.equal(calls.every((call) => call.options === undefined), true, 'no grant or owner fields');
    assert.equal(typeof wake, 'function');
    await bridge.close();
});

test('catalog bridge suppresses late replies on close and does not overlap polls', async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const read = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const bridge = createWorkflowCatalogBridge({ roboflow: { async listWorkflows() { entered(); return read; } },
        hop: { async call(operation) { calls.push(operation); return { outcome: 'response', status: 200, json: { requests: [pending()] } }; } } });
    bridge.start();
    bridge.start();
    await started;
    const closing = bridge.close();
    release([]);
    await closing;
    assert.deepEqual(calls, ['workflow-catalog/requests']);
});

test('catalog hop signs only exact catalog operations and refuses user grant or arbitrary operations before I/O', async () => {
    const signed = [];
    const sent = [];
    const env = { ROBOTEAM_WORKER_COORDINATOR_BASE: '/base-agent-additional-server/robo-work/7000',
        PLOINKY_AGENT_PRIVATE_SECRET: crypto.randomBytes(32).toString('hex'), PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent',
        PLOINKY_AGENT_INSTANCE_ID: 'instance', PLOINKY_AGENT_ENABLE_GENERATION: 'generation' };
    const hop = createWorkerCoordinatorHop({ env, routerUrl: 'http://127.0.0.1:12345',
        libraries: { assertion: { signPrivateRouterAssertion(input) { signed.push(input); return 'synthetic-assertion'; } } },
        request(url, options, callback) {
            const req = new EventEmitter();
            req.end = (body) => {
                sent.push({ path: url.pathname, options, body });
                const res = new PassThrough();
                res.statusCode = 200;
                res.headers = {};
                callback(res);
                res.end('{"ok":true}');
            };
            req.destroy = () => {};
            return req;
        } });
    for (const operation of ['workflow-catalog/requests', `references/${id()}/workflow-catalog/reply`]) {
        assert.equal((await hop.call(operation, {})).status, 200);
        assert.equal(signed.at(-1).path, sent.at(-1).path);
        assert.equal(signed.at(-1).body.equals(sent.at(-1).body), true);
        assert.equal(sent.at(-1).options.headers['x-ploinky-user-delegation'], undefined);
        await assert.rejects(hop.call(operation, {}, { grant: 'a.b.c' }), { code: 'owner_evidence_unavailable' });
    }
    const before = sent.length;
    for (const operation of ['workflow-catalog/read', 'workflow-catalog/requests?x=1', `references/${id()}/workflow-catalog/control`, 'mcp/tools']) {
        await assert.rejects(hop.call(operation, {}), { code: 'invalid_request' });
    }
    assert.equal(sent.length, before);
});

test('catalog routes remain limited by the existing worker manifest to RoboTeam', async () => {
    const manifest = JSON.parse(await fs.readFile(new URL('../../robo-work/manifest.json', import.meta.url), 'utf8'));
    assert.deepEqual(manifest.executionProvider.coordinatorRoutes, [{ path: '/base-agent-additional-server/robo-work/7000/v1/coordinator/*', callers: ['agent:AchillesIDE/roboTeamAgent'] }]);
});

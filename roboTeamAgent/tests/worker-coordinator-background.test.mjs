import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { parentBindingFor, registerDerivedBinding, scheduleBindingId } from '../server/worker-coordinator/background.mjs';
import { WorkerCoordinatorError } from '../server/worker-coordinator/errors.mjs';
import { bindOperationId } from '../server/worker-coordinator/identities.mjs';
import { decodeJwtPayload, routedHeaders } from './helpers/router-worker.mjs';

// The background row: real RoboFlow schedules, scheduler, flows and subflow records over a
// temporary RoboFlow database, the real createRoboTeamServer for `/api/worker/bindings` with
// Router-signed requests over RoboTeam's real manifest, and a recording coordinator hop.
const definition = { id: 'scheduled', name: 'Scheduled work', description: 'Scheduled work', entryTaskId: 'one',
    tasks: [{ id: 'one', name: 'Work', executionType: 'terminal', prompt: 'Run the objective', skillsets: [] }], edges: [] };
const U = { id: 'admin-u', roles: ['admin'] };
const V = { id: 'admin-v', roles: ['admin'] };
const PLAIN = { id: 'plain-w', roles: ['user'] };

function stubHop(script = {}) {
    const calls = [];
    return {
        calls,
        async call(operation, body, { grant } = {}) {
            calls.push({ operation, body: structuredClone(body), grant });
            const reply = script[operation];
            if (reply instanceof Error) throw reply;
            return reply || { outcome: 'response', status: 200, json: { bindingId: body.bindingId, ownerId: 'recorded' }, refusal: null };
        },
    };
}

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-background-')));
    let now = Date.parse('2026-10-09T07:00:00Z');
    const robot = { id: 'default-id', name: 'default', codingAgents: ['opencode'] }, started = [];
    const runtimeManager = { workspaceRoot: root, resolveCwd: async folder => { if (!folder.startsWith(root)) throw new Error('Folder outside workspace'); return folder; },
        startTask: (robotRecord, type, request) => { started.push(request); return { taskId: request.runtimeTaskId }; }, stopTask() {},
        status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false, logs: async () => '' };
    const service = new RoboFlowService({ databaseFile: path.join(root, 'roboflow.sqlite'), workspaceRoot: root,
        robotStore: { list: async () => [robot], getByName: async () => robot }, runtimeManager,
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robotRecord, input, enqueue) => enqueue(robotRecord) },
        scheduleNow: () => now, schedulePollMs: 2147480000 });
    await service.initialize(); await service.presetReady; await service.createWorkflow(definition); service.scheduler.start();
    const hop = stubHop();
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow: service, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534,
        workerCoordinator: { hop } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await service.close();
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const bind = async (user, bindingId) => {
        const text = JSON.stringify({ bindingId });
        const response = await fetch(`${baseUrl}/api/worker/bindings`, { method: 'POST',
            headers: { 'content-type': 'application/json', ...routedHeaders(user, 'POST', '/api/worker/bindings', text) }, body: text });
        return { status: response.status, body: await response.json() };
    };
    const save = (owner, extra = {}, id) => service.saveSchedule({ workflowTypeId: 'scheduled', folder: root, objective: 'Write the report',
        timing: { kind: 'interval', everyMinutes: 60 }, ...extra }, owner.id, id, { ownerPrincipal: `user:${owner.id}` });
    return { service, root, started, hop, bind, save, advance: (minutes) => { now += minutes * 60000; } };
}

test('save records bindingRevision; run-now bumps only revision; launches record their binding metadata', async (t) => {
    const f = await fixture(t);
    const job = await f.save(U);
    assert.equal(f.service.schedules.getSync(job.id).revision, 1);
    assert.equal(f.service.schedules.getSync(job.id).bindingRevision, 1);
    assert.equal(scheduleBindingId(f.service.schedules.getSync(job.id)), `${job.id}.r1`);
    f.advance(60); await f.service.scheduler.tick();
    const cronFlow = await f.service.store.get(f.service.schedules.getSync(job.id).lastFlowId);
    assert.equal(cronFlow.scheduledLaunch, 'cron');
    assert.equal(cronFlow.scheduleBindingRevision, 1);
    assert.equal(parentBindingFor(cronFlow), `${job.id}.r1`, 'a cron-fired flow derives from the schedule binding');
    await f.service.store.update(cronFlow.id, (flow) => { flow.status = 'completed'; });
    const manual = await f.service.runScheduleNow(job.id, 1, V.id, { ownerPrincipal: `user:${V.id}` });
    const afterRun = f.service.schedules.getSync(job.id);
    assert.equal(afterRun.revision, 2);
    assert.equal(afterRun.bindingRevision, 1, 'run-now never changes the binding revision');
    const manualFlow = await f.service.store.get(manual.flow.id);
    assert.equal(manualFlow.scheduledLaunch, 'manual');
    assert.equal(manualFlow.scheduleBindingRevision, 1);
    assert.equal(manualFlow.ownerPrincipal, `user:${V.id}`);
    assert.equal(parentBindingFor(manualFlow), null, 'a run-now flow is a root');
    await f.service.store.update(manualFlow.id, (flow) => { flow.status = 'completed'; });
    const edited = await f.save(U, { revision: 2, objective: 'Edited' }, job.id);
    assert.equal(f.service.schedules.getSync(edited.id).revision, 3);
    assert.equal(f.service.schedules.getSync(edited.id).bindingRevision, 3, 'a save re-binds');
    f.advance(60); await f.service.scheduler.tick();
    assert.equal(parentBindingFor(await f.service.store.get(f.service.schedules.getSync(job.id).lastFlowId)), `${job.id}.r3`);
    // Ordinary flows are roots; children derive from their parent flow.
    const ordinary = await f.service.startFlow({ workflowTypeId: 'scheduled', objective: 'Ad hoc', folder: f.root, createdBy: U.id, ownerPrincipal: `user:${U.id}` });
    assert.equal(parentBindingFor(ordinary), null);
    assert.equal(Object.hasOwn(ordinary, 'scheduledLaunch'), false);
    const child = f.service.store.createRecord(cronFlow.graph, { folder: cronFlow.folder, createdBy: U.id, ownerPrincipal: cronFlow.ownerPrincipal, parentFlowId: cronFlow.id });
    assert.equal(parentBindingFor(child), cronFlow.id);
    // Legacy records have no binding (no legacy reader).
    assert.throws(() => scheduleBindingId({ id: job.id }), (error) => error.code === 'binding_revision_unavailable');
    assert.throws(() => parentBindingFor({ scheduleId: job.id }), (error) => error.code === 'binding_revision_unavailable');
    assert.throws(() => parentBindingFor({ scheduleId: job.id, scheduledLaunch: 'cron' }), (error) => error.code === 'binding_revision_unavailable');
    assert.equal(f.hop.calls.length, 0, 'no RoboFlow change calls the worker');
});

test('root registration through /api/worker/bindings: owner grant, binding revision, owner and launch checks', async (t) => {
    const f = await fixture(t);
    const job = await f.save(U);
    const rootBind = (bindingId) => ({ operation: 'bindings', body: { operationId: bindOperationId(bindingId), bindingId } });
    // BG1: the schedule owner binds the current schedule revision with their own grant.
    assert.equal((await f.bind(U, `${job.id}.r1`)).status, 200);
    assert.deepEqual({ operation: f.hop.calls[0].operation, body: f.hop.calls[0].body }, rootBind(`${job.id}.r1`));
    assert.equal(decodeJwtPayload(f.hop.calls[0].grant).sub, `user:${U.id}`);
    // Idempotent: the same registration relays the same operation ID.
    assert.equal((await f.bind(U, `${job.id}.r1`)).status, 200);
    assert.deepEqual(f.hop.calls[1].body, f.hop.calls[0].body);
    // BG2: run-now by V; V binds the run-now flow as a root with V's grant.
    const manual = await f.service.runScheduleNow(job.id, 1, V.id, { ownerPrincipal: `user:${V.id}` });
    assert.equal((await f.bind(V, manual.flow.id)).status, 200);
    assert.deepEqual(f.hop.calls[2].body, rootBind(manual.flow.id).body);
    assert.equal(decodeJwtPayload(f.hop.calls[2].grant).sub, `user:${V.id}`);
    const calls = f.hop.calls.length;
    // The schedule's revision is 2 now but its binding revision is still 1. The revision check
    // runs before the owner check: both V and the owner U get 409 for r2.
    assert.deepEqual(await f.bind(V, `${job.id}.r2`), { status: 409, body: { error: 'binding_revision_unavailable' } });
    assert.deepEqual(await f.bind(U, `${job.id}.r2`), { status: 409, body: { error: 'binding_revision_unavailable' } });
    // BG5: V's grant for U's schedule binding.
    assert.deepEqual(await f.bind(V, `${job.id}.r1`), { status: 403, body: { error: 'binding_owner_mismatch' } });
    // A non-administrator never binds a schedule.
    assert.deepEqual(await f.bind(PLAIN, `${job.id}.r1`), { status: 403, body: { error: 'binding_owner_mismatch' } });
    // A run-now flow needs its owner, and an administrator.
    assert.deepEqual(await f.bind(U, manual.flow.id), { status: 403, body: { error: 'binding_owner_mismatch' } });
    await f.service.store.update(manual.flow.id, (flow) => { flow.status = 'completed'; });
    // A cron-fired flow and a child flow are derived, never roots.
    f.advance(60); await f.service.scheduler.tick();
    const cronFlowId = f.service.schedules.getSync(job.id).lastFlowId;
    assert.notEqual(cronFlowId, manual.flow.id);
    assert.deepEqual(await f.bind(U, cronFlowId), { status: 400, body: { error: 'invalid_request' } });
    const cronFlow = await f.service.store.get(cronFlowId);
    const child = f.service.store.createRecord(cronFlow.graph, { folder: cronFlow.folder, createdBy: U.id, ownerPrincipal: `user:${U.id}`, parentFlowId: cronFlowId });
    f.service.store.database.transaction(() => f.service.store.saveSync(child));
    assert.deepEqual(await f.bind(U, child.id), { status: 400, body: { error: 'invalid_request' } });
    // An ordinary flow: its owner binds it; another administrator does not.
    const ordinary = await f.service.startFlow({ workflowTypeId: 'scheduled', objective: 'Ad hoc', folder: f.root, createdBy: PLAIN.id, ownerPrincipal: `user:${PLAIN.id}` });
    assert.deepEqual(await f.bind(V, ordinary.id), { status: 403, body: { error: 'binding_owner_mismatch' } });
    assert.equal((await f.bind(PLAIN, ordinary.id)).status, 200, 'an ordinary flow needs only its owner');
    // Unknown records and malformed IDs never reach the worker.
    assert.deepEqual(await f.bind(U, `cron_${'0'.repeat(24)}.r1`), { status: 404, body: { error: 'not_found' } });
    assert.deepEqual(await f.bind(U, `flow_${'0'.repeat(24)}`), { status: 404, body: { error: 'not_found' } });
    for (const bad of ['flow_x', `gen_${'0'.repeat(24)}`, `${job.id}.r0`, 7]) assert.equal((await f.bind(U, bad)).status, 400, String(bad));
    // Legacy records without binding metadata (R18, review M7).
    const legacySchedule = await f.save(U, { objective: 'Legacy' });
    const stored = f.service.schedules.getSync(legacySchedule.id);
    delete stored.bindingRevision;
    f.service.schedules.database.transaction(() => f.service.schedules.saveSync(stored));
    assert.deepEqual(await f.bind(U, `${legacySchedule.id}.r1`), { status: 409, body: { error: 'binding_revision_unavailable' } });
    const legacyFlow = await f.service.startFlow({ workflowTypeId: 'scheduled', objective: 'Legacy flow', folder: f.root, createdBy: U.id, ownerPrincipal: `user:${U.id}` });
    await f.service.store.update(legacyFlow.id, (flow) => { flow.scheduleId = job.id; });
    assert.deepEqual(await f.bind(U, legacyFlow.id), { status: 409, body: { error: 'binding_revision_unavailable' } });
    assert.equal(f.hop.calls.length, calls + 1, 'only the ordinary flow owner reached the worker; no refusal did');
});

test('derived registration: coordinator alone, parent in the body, no grant; refusals are thrown', async (t) => {
    const f = await fixture(t);
    const job = await f.save(U);
    f.advance(60); await f.service.scheduler.tick();
    const flowX = await f.service.store.get(f.service.schedules.getSync(job.id).lastFlowId);
    const startedBefore = f.started.length;
    // BG3: the cron-fired flow derives from the schedule binding; a child derives from flow_x.
    const receipt = await registerDerivedBinding({ hop: f.hop, bindingId: flowX.id, parentBindingId: parentBindingFor(flowX) });
    assert.deepEqual(receipt, { bindingId: flowX.id, ownerId: 'recorded' });
    const child = f.service.store.createRecord(flowX.graph, { folder: flowX.folder, createdBy: U.id, ownerPrincipal: flowX.ownerPrincipal, parentFlowId: flowX.id });
    await registerDerivedBinding({ hop: f.hop, bindingId: child.id, parentBindingId: parentBindingFor(child) });
    assert.deepEqual(f.hop.calls.map(({ operation, body, grant }) => [operation, body, grant]), [
        ['bindings', { operationId: bindOperationId(flowX.id), bindingId: flowX.id, parentBindingId: `${job.id}.r1` }, undefined],
        ['bindings', { operationId: bindOperationId(child.id), bindingId: child.id, parentBindingId: flowX.id }, undefined],
    ]);
    assert.equal(f.started.length, startedBefore, 'registration starts nothing locally');
    await assert.rejects(registerDerivedBinding({ hop: f.hop, bindingId: `${job.id}.r1`, parentBindingId: flowX.id }), (error) => error.code === 'invalid_request');
    await assert.rejects(registerDerivedBinding({ hop: f.hop, bindingId: flowX.id, parentBindingId: flowX.id }), (error) => error.code === 'invalid_request');
    await assert.rejects(registerDerivedBinding({ hop: null, bindingId: flowX.id, parentBindingId: `${job.id}.r1` }), (error) => error.code === 'worker_coordinator_unavailable');
    assert.equal(f.hop.calls.length, 2);
    const refusals = [
        [{ outcome: 'response', status: 404, json: { error: 'not_found' }, refusal: null }, 'not_found', 404],
        [{ outcome: 'response', status: 403, json: { error: 'forbidden', reason: 'row_missing' }, refusal: null }, 'forbidden', 403],
        [{ outcome: 'unknown', status: 502 }, 'worker_reply_unknown', 503],
        [{ outcome: 'unsent' }, 'worker_unreachable', 503],
        [new WorkerCoordinatorError('worker_coordinator_unavailable', 503), 'worker_coordinator_unavailable', 503],
    ];
    for (const [reply, code, status] of refusals) {
        await assert.rejects(registerDerivedBinding({ hop: stubHop({ bindings: reply }), bindingId: flowX.id, parentBindingId: `${job.id}.r1` }),
            (error) => error instanceof WorkerCoordinatorError && error.code === code && error.status === status, code);
    }
});

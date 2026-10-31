import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifiedCoordinatorContext, skillsSelectionDigest } from '../../server/stateProtocol.mjs';
import { createWorkflowCatalogRequests, validateCatalogResult, CATALOG_MAX_BYTES } from '../../server/runtime/workflowCatalogRequests.mjs';
import { S6_LIMITS, WORKSPACE, admitRequest, makeTempDir, newId, openStore, rawDb, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

const COORDINATOR = 'agent:AchillesIDE/roboTeamAgent';
const context = (coordinator = COORDINATOR) => createVerifiedCoordinatorContext({ workspaceId: WORKSPACE,
    scope: 'catalog-service', coordinator, operations: ['workflow_catalog'] });
const skills = [{ name: 'list-workflows', path: '/ws/list-workflows', required: true }];
const specification = (extra = {}) => ({ version: 2, prompt: 'unchanged prompt', displayText: '', permissions: 'full-access',
    sessionId: newId(), turnId: newId(), workflowCatalog: true, skills, skillsDigest: skillsSelectionDigest(skills), ...extra });
const EMPTY = { ok: true, workflows: [] };

function rig(t) {
    const directory = makeTempDir(t);
    const store = openStore(directory, { limits: { ...S6_LIMITS, admissions: 100 } });
    t.after(() => store.close());
    const owner = syntheticContext({ ownerId: 'user:alice', originNamespace: `coordinator:${COORDINATOR}`, originKey: 'owner:user:alice' });
    const robotId = readyRobot(store, owner);
    let now = 1000;
    const timers = new Map();
    const registry = createWorkflowCatalogRequests({ store, clock: { now: () => now,
        setTimeout(fn) { const id = newId(); timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } } });
    t.after(() => registry.close());
    function admit(extra = {}, ctx = owner, kind = 'turn') {
        const request = admitRequest(robotId, { kind, logical: { sessionKey: newId() }, specification: specification(extra) }, ctx);
        const admitted = store.admit(ctx, request);
        const queued = store.listQueuedAdmissions().at(-1);
        const ids = { executionId: queued.executionId, attemptId: queued.attemptId };
        store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' });
        return { ids, request, admitted, handle: registry.registerAttempt(ids) };
    }
    return { store, directory, owner, robotId, registry, admit, timers, advance(ms) { now += ms; } };
}

test('catalog reads are attempt-bound, fresh requests; duplicate and foreign settlements cannot deliver twice', async (t) => {
    const { registry, admit, timers } = rig(t);
    const first = admit();
    const second = admit();
    const one = first.handle.read(), two = second.handle.read();
    const rows = registry.listPending(context()).requests;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].requestId, rows[1].requestId);
    assert.deepEqual(registry.listPending(context('agent:AchillesIDE/other')).requests, []);
    assert.throws(() => registry.listPending(JSON.parse(JSON.stringify(context()))), { code: 'forbidden' });
    assert.deepEqual(registry.reply(context('agent:AchillesIDE/other'), { ...rows[0], result: EMPTY }), { ok: true, settled: false });
    assert.deepEqual(registry.reply(context(), { ...rows[0], attemptId: rows[1].attemptId, result: EMPTY }), { ok: true, settled: false });
    assert.deepEqual(registry.reply(context(), { ...rows[0], result: EMPTY }), { ok: true, settled: true });
    assert.deepEqual(await one, EMPTY);
    assert.deepEqual(registry.reply(context(), { ...rows[0], result: EMPTY }), { ok: true, settled: false });
    second.handle.close();
    await assert.rejects(two, { code: 'execution_ended' });
    assert.deepEqual(registry.listPending(context()).requests, []);
    assert.equal(timers.size, 0);
});

test('two pending requests per attempt; timeout, end, shutdown, terminal state and generation recovery clean pending reads', async (t) => {
    const { registry, admit, timers, advance, store, owner } = rig(t);
    const first = admit();
    const one = first.handle.read(), two = first.handle.read();
    await assert.rejects(first.handle.read(), { code: 'catalog_busy' });
    const pending = registry.listPending(context()).requests;
    advance(30000);
    assert.deepEqual(registry.reply(context(), { ...pending[0], result: EMPTY }), { ok: true, settled: false });
    await assert.rejects(one, { code: 'catalog_timeout' });
    registry.listPending(context());
    await assert.rejects(two, { code: 'catalog_timeout' });
    assert.equal(timers.size, 0);
    const read = first.handle.read();
    store.beginAttemptEnd(owner, { ...first.ids, expectedState: 'running', outcome: { classification: 'completed', outputText: '' } });
    registry.listPending(context());
    await assert.rejects(read, { code: 'execution_ended' });
    await assert.rejects(first.handle.read(), { code: 'execution_ended' });
    const second = admit();
    const recoveryRead = second.handle.read();
    store.beginGenerationRecovery(store.generationId);
    registry.listPending(context());
    await assert.rejects(recoveryRead, { code: 'execution_ended' });
    assert.equal(timers.size, 0);
    registry.close();
    assert.throws(() => registry.registerAttempt(second.ids), { code: 'execution_ended' });
});

test('catalog admission refuses missing required skill, wrong kind, owner mismatch and unretained capability', (t) => {
    const { store, owner, robotId, registry } = rig(t);
    for (const [ctx, kind, spec] of [
        [owner, 'task', specification()],
        [syntheticContext({ ownerId: 'user:bob', originNamespace: `coordinator:${COORDINATOR}`, originKey: 'owner:user:alice' }), 'turn', specification()],
        [owner, 'turn', specification({ skills: [], skillsDigest: skillsSelectionDigest([]) })],
        [owner, 'turn', specification({ workflowCatalog: 'yes' })],
    ]) assert.throws(() => store.admit(ctx, admitRequest(robotId, { kind, logical: { sessionKey: newId() }, specification: spec }, ctx)), { code: 'invalid_request' });
    store.admit(owner, admitRequest(robotId, { kind: 'turn', logical: { sessionKey: newId() }, specification: specification({ workflowCatalog: false }) }, owner));
    const queued = store.listQueuedAdmissions()[0];
    const ids = { executionId: queued.executionId, attemptId: queued.attemptId };
    store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' });
    assert.throws(() => registry.registerAttempt(ids), { code: 'forbidden' });
    assert.throws(() => registry.registerAttempt({ ...ids, attemptId: newId() }), { code: 'forbidden' });
});

test('persisted owner, origin, coordinator, session, turn and capability are immutable while a read is pending', async (t) => {
    for (const change of ['owner', 'origin', 'coordinator', 'sessionId', 'turnId', 'capability']) {
        const { registry, admit, directory } = rig(t);
        const attempt = admit();
        const read = attempt.handle.read();
        const row = registry.listPending(context()).requests[0];
        const db = rawDb(directory);
        try {
            assert.throws(() => {
                if (change === 'owner') db.prepare('UPDATE admission SET owner_id = ? WHERE execution_id = ?').run('user:bob', attempt.ids.executionId);
                else if (change === 'origin') db.prepare('UPDATE reference SET origin_key = ? WHERE execution_id = ?').run('owner:user:bob', attempt.ids.executionId);
                else if (change === 'coordinator') db.prepare('UPDATE reference SET namespace = ? WHERE execution_id = ?').run('coordinator:agent:AchillesIDE/other', attempt.ids.executionId);
                else {
                    const spec = JSON.parse(db.prepare('SELECT specification FROM admission WHERE execution_id = ?').get(attempt.ids.executionId).specification);
                    if (change === 'capability') spec.workflowCatalog = false;
                    else spec[change] = 'changed';
                    db.prepare('UPDATE admission SET specification = ? WHERE execution_id = ?').run(JSON.stringify(spec), attempt.ids.executionId);
                }
            }, /immutable/u, change);
        } finally { db.close(); }
        assert.deepEqual(registry.reply(context(), { ...row, result: EMPTY }), { ok: true, settled: true }, change);
        assert.deepEqual(await read, EMPTY, change);
    }
});

test('catalog service pages at most sixteen reads and timer/shutdown paths remove every pending entry', async (t) => {
    const { registry, admit, timers } = rig(t);
    const reads = [];
    for (let index = 0; index < 9; index += 1) {
        const attempt = admit();
        reads.push(attempt.handle.read(), attempt.handle.read());
    }
    const settled = Promise.allSettled(reads);
    assert.equal(registry.listPending(context()).requests.length, 16);
    for (const expire of [...timers.values()]) expire();
    assert.equal((await settled).every((result) => result.status === 'rejected' && result.reason.code === 'catalog_timeout'), true);
    assert.equal(timers.size, 0);
    assert.deepEqual(registry.listPending(context()), { requests: [] });
    const shutdown = admit().handle.read();
    const rejected = assert.rejects(shutdown, { code: 'execution_ended' });
    registry.close();
    await rejected;
    assert.equal(timers.size, 0);
});

test('catalog results enforce allowlist, UTF-8 byte boundaries, Unicode and fixed generic errors', () => {
    const value = { ok: true, workflows: [{ id: 'id', name: '工作', description: 'é', hasDefaultObjective: true, kind: 'default', tasks: [{ name: '浏览', executionType: 'browser' }] }] };
    assert.deepEqual(validateCatalogResult(value), value);
    for (const key of ['prompt', 'defaultObjective', 'source', 'coverage', 'password']) {
        assert.throws(() => validateCatalogResult({ ...value, workflows: [{ ...value.workflows[0], [key]: 'private' }] }), { code: 'invalid_request' });
    }
    assert.throws(() => validateCatalogResult({ ok: false, error: 'raw secret' }), { code: 'invalid_request' });
    const boundary = structuredClone(value);
    boundary.workflows[0].description = '';
    boundary.workflows[0].description = 'a'.repeat(CATALOG_MAX_BYTES - Buffer.byteLength(JSON.stringify(boundary)));
    assert.equal(Buffer.byteLength(JSON.stringify(boundary)), CATALOG_MAX_BYTES);
    validateCatalogResult(boundary);
    boundary.workflows[0].description += 'é';
    assert.throws(() => validateCatalogResult(boundary), { code: 'catalog_too_large' });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createVerifiedServiceContext } from '../server/workerState.mjs';
import { validateLimits } from '../server/stateProtocol.mjs';
import {
    LIMITS, WORKSPACE, admitRequest, count, expectCode, makeTempDir, newId, newOriginId, openStore, rawDb, readyRobot, robotConfig,
    syntheticContext
} from './helpers/synthetic.mjs';

// S1x bindings and workspace robots. Every context here is SYNTHETIC (an internal
// precondition built directly, not from verified Router evidence); the adapter-level tests
// with real tokens live in coordinatorAdapter.test.mjs.

const EXTENDED = Object.freeze({ ...LIMITS, bindings: 32, controls: 16, tokenReplayEntries: 16 });
const WORKSPACE_ROBOTS = `workspace:${WORKSPACE}`;

function openExtended(dir, options = {}) {
    return openStore(dir, { limits: EXTENDED, ...options });
}

// Coordinator-API row of `user` under coordinator `svc`, as the root-binding registrar.
function ownerRow(svc, user, extra = {}) {
    return syntheticContext({ originNamespace: `coordinator:${svc}`, originKey: `owner:user:${user}`, ownerId: `user:${user}`, scope: `scope-${svc}-${user}`, ...extra });
}

// Background row of binding `id` under `svc`, with the owner the coordinator read from the binding.
function bindingRow(svc, id, ownerId, extra = {}) {
    return syntheticContext({ originNamespace: `coordinator:${svc}`, originKey: `binding:${id}`, ownerId, scope: `scope-${svc}-binding-${id}`, ...extra });
}

function bindingRows(dir) {
    return count(dir, 'binding');
}

function tableCounts(dir) {
    return Object.fromEntries(['receipt', 'admission', 'origin', 'reference', 'binding'].map((table) => [table, count(dir, table)]));
}

test('extension limits are accepted only as a complete set on top of the base limits', () => {
    assert.deepEqual({ ...validateLimits(EXTENDED) }, { ...EXTENDED });
    expectCode(assert, () => validateLimits({ ...LIMITS, bindings: 4 }), 'invalid_request');
    expectCode(assert, () => validateLimits({ ...LIMITS, bindings: 4, controls: 4 }), 'invalid_request');
    expectCode(assert, () => validateLimits({ ...EXTENDED, bindings: 0 }), 'invalid_request');
    expectCode(assert, () => validateLimits({ ...EXTENDED, extra: 1 }), 'invalid_request');
    const { bindings, ...partial } = EXTENDED;
    void bindings;
    expectCode(assert, () => validateLimits({ ...partial, other: 1 }), 'invalid_request');
});

test('root binding records an immutable owner; retry and reopen return the receipt', (t) => {
    const dir = makeTempDir(t);
    let store = openExtended(dir);
    const context = ownerRow('svc1', 'alice');
    const request = { operationId: newId(), bindingId: 'flow_0123456789abcdef01234567', kind: 'flow' };
    const first = store.registerBinding(context, request);
    assert.deepEqual(first, { operationId: request.operationId, type: 'bind', bindingId: request.bindingId, kind: 'flow', parentBindingId: null, status: 'registered' });
    assert.deepEqual(store.registerBinding(context, { ...request }), first);
    assert.deepEqual(store.readBindingOwner({ coordinator: 'svc1', bindingId: request.bindingId }), { ownerId: 'user:alice' });
    store.close();
    store = openExtended(dir, { create: false });
    assert.deepEqual(store.registerBinding(ownerRow('svc1', 'alice'), { ...request }), first);
    assert.equal(bindingRows(dir), 1);
    store.close();
    const db = rawDb(dir);
    try {
        const row = db.prepare('SELECT * FROM binding').get();
        assert.equal(row.owner_id, 'user:alice');
        assert.equal(row.evidence, 'owner-grant');
        assert.equal(row.depth, 0);
        assert.equal(row.root_binding_id, request.bindingId);
        assert.throws(() => db.prepare("UPDATE binding SET owner_id = 'user:mallory'").run(), /immutable/);
        assert.throws(() => db.prepare("UPDATE binding SET evidence = 'derived'").run());
        assert.throws(() => db.prepare('DELETE FROM binding').run(), /immutable/);
    } finally {
        db.close();
    }
});

test('the same binding under another operation conflicts; a changed request under one operation conflicts', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const request = { operationId: newId(), bindingId: 'flowA', kind: 'flow' };
    store.registerBinding(ownerRow('svc1', 'alice'), request);
    expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'alice'), { ...request, operationId: newId() }), 'operation_conflict');
    expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'bob'), { ...request, operationId: newId() }), 'operation_conflict');
    expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'alice'), { ...request, kind: 'schedule' }), 'operation_conflict');
    // Another coordinator has its own binding namespace.
    store.registerBinding(ownerRow('svc2', 'bob'), { ...request, operationId: newId() });
    assert.equal(bindingRows(dir), 2);
});

test('derived binding inherits the owner; missing, foreign-coordinator or over-deep parents are refused', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'root', kind: 'schedule' });
    store.registerBinding(ownerRow('svc2', 'bob'), { operationId: newId(), bindingId: 'other', kind: 'flow' });
    const child = store.registerBinding(bindingRow('svc1', 'root', 'user:alice'), { operationId: newId(), bindingId: 'child', kind: 'flow', parentBindingId: 'root' });
    assert.equal(child.parentBindingId, 'root');
    assert.deepEqual(store.readBindingOwner({ coordinator: 'svc1', bindingId: 'child' }), { ownerId: 'user:alice' });
    const before = bindingRows(dir);
    // Missing parent, and a parent that exists only under another coordinator.
    expectCode(assert, () => store.registerBinding(bindingRow('svc1', 'nope', 'user:alice'), { operationId: newId(), bindingId: 'c2', kind: 'flow', parentBindingId: 'nope' }), 'not_found');
    expectCode(assert, () => store.registerBinding(bindingRow('svc1', 'other', 'user:bob'), { operationId: newId(), bindingId: 'c3', kind: 'flow', parentBindingId: 'other' }), 'not_found');
    // The coordinator presented another owner than the parent's.
    expectCode(assert, () => store.registerBinding(bindingRow('svc1', 'root', 'user:bob'), { operationId: newId(), bindingId: 'c4', kind: 'flow', parentBindingId: 'root' }), 'not_found');
    // A derived binding is a flow, registered from its parent's own background row.
    expectCode(assert, () => store.registerBinding(bindingRow('svc1', 'root', 'user:alice'), { operationId: newId(), bindingId: 'c5', kind: 'schedule', parentBindingId: 'root' }), 'invalid_request');
    expectCode(assert, () => store.registerBinding(bindingRow('svc1', 'child', 'user:alice'), { operationId: newId(), bindingId: 'c6', kind: 'flow', parentBindingId: 'root' }), 'forbidden');
    expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'c7', kind: 'flow', parentBindingId: 'root' }), 'forbidden');
    assert.equal(bindingRows(dir), before);
    // Depth: root (0) -> d1 ... d16 is allowed; a child of d16 is refused.
    let parent = 'root';
    for (let depth = 1; depth <= 16; depth += 1) {
        const id = `d${depth}`;
        store.registerBinding(bindingRow('svc1', parent, 'user:alice'), { operationId: newId(), bindingId: id, kind: 'flow', parentBindingId: parent });
        parent = id;
    }
    const deep = bindingRows(dir);
    expectCode(assert, () => store.registerBinding(bindingRow('svc1', 'd16', 'user:alice'), { operationId: newId(), bindingId: 'd17', kind: 'flow', parentBindingId: 'd16' }), 'invalid_request');
    assert.equal(bindingRows(dir), deep);
});

test('binding registration refuses MCP and service contexts, bad grammar, absent or exhausted capacity', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir, { limits: { ...EXTENDED, bindings: 1 } });
    t.after(() => store.close());
    const mcp = syntheticContext({ originNamespace: 'mcp', originKey: 'user:alice', ownerId: 'user:alice' });
    expectCode(assert, () => store.registerBinding(mcp, { operationId: newId(), bindingId: 'f1', kind: 'flow' }), 'forbidden');
    const service = createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 's', ownerId: 'coordinator:svc1', robotOwnerId: WORKSPACE_ROBOTS, operations: ['read'] });
    expectCode(assert, () => store.registerBinding(service, { operationId: newId(), bindingId: 'f1', kind: 'flow' }), 'forbidden');
    expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'alice', { operations: ['admit'] }), { operationId: newId(), bindingId: 'f1', kind: 'flow' }), 'forbidden');
    for (const bad of [{ bindingId: '-x', kind: 'flow' }, { bindingId: 'f1', kind: 'other' }, { bindingId: 'x'.repeat(129), kind: 'flow' },
        { bindingId: 'f1', kind: 'flow', owner: 'user:bob' }, { bindingId: 'f1', kind: 'flow', parentBindingId: 'a/b' }]) {
        expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), ...bad }), 'invalid_request');
    }
    store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'f1', kind: 'flow' });
    expectCode(assert, () => store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'f2', kind: 'flow' }), 'capacity_exceeded');
    const base = makeTempDir(t);
    const baseStore = openStore(base);
    t.after(() => baseStore.close());
    expectCode(assert, () => baseStore.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'f1', kind: 'flow' }), 'capacity_exceeded');
    expectCode(assert, () => store.readBindingOwner({ coordinator: 'svc1', bindingId: 'unknown' }), 'not_found');
    expectCode(assert, () => store.readBindingOwner({ coordinator: 'svc2', bindingId: 'f1' }), 'not_found');
});

test('background admission requires an active registered binding of the same coordinator and owner', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const robots = syntheticContext({ robotOwnerId: WORKSPACE_ROBOTS, scope: 'scope-robots' });
    const robotId = readyRobot(store, robots);
    store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'flow1', kind: 'flow' });
    const before = tableCounts(dir);
    const attempt = (context) => store.admit(context, admitRequest(robotId, {}, context));
    // Unregistered binding, the same binding ID under another coordinator, a mismatched owner.
    expectCode(assert, () => attempt(bindingRow('svc1', 'flow2', 'user:alice', { robotOwnerId: WORKSPACE_ROBOTS })), 'not_found');
    expectCode(assert, () => attempt(bindingRow('svc2', 'flow1', 'user:alice', { robotOwnerId: WORKSPACE_ROBOTS })), 'not_found');
    expectCode(assert, () => attempt(bindingRow('svc1', 'flow1', 'user:bob', { robotOwnerId: WORKSPACE_ROBOTS })), 'not_found');
    expectCode(assert, () => attempt(bindingRow('svc1', 'flow1', 'coordinator:svc1', { robotOwnerId: WORKSPACE_ROBOTS })), 'not_found');
    assert.deepEqual(tableCounts(dir), before);
    const admitted = attempt(bindingRow('svc1', 'flow1', 'user:alice', { robotOwnerId: WORKSPACE_ROBOTS }));
    assert.equal(admitted.status, 'admitted');
    const db = rawDb(dir, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT owner_id FROM admission WHERE execution_id = ?').get(admitted.executionId).owner_id, 'user:alice');
    } finally {
        db.close();
    }
});

test('a derived binding admits only while its root binding is active', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: WORKSPACE_ROBOTS, scope: 'scope-robots' }));
    store.registerBinding(ownerRow('svc1', 'alice'), { operationId: newId(), bindingId: 'root', kind: 'schedule' });
    store.registerBinding(bindingRow('svc1', 'root', 'user:alice'), { operationId: newId(), bindingId: 'run1', kind: 'flow', parentBindingId: 'root' });
    const context = bindingRow('svc1', 'run1', 'user:alice', { robotOwnerId: WORKSPACE_ROBOTS });
    assert.equal(store.admit(context, admitRequest(robotId, {}, context)).status, 'admitted');
    store.close();
    // White-box: the root stops being active. Fence states arrive with P2/P5 (the CHECK admits
    // only `active` and quick_check refuses a violating row), so this fixture removes the root
    // row instead, lifting the no-delete trigger for this fixture only.
    const db = rawDb(dir);
    try {
        const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'binding_no_delete'").get().sql;
        db.exec('DROP TRIGGER binding_no_delete');
        db.prepare("DELETE FROM binding WHERE binding_id = 'root'").run();
        db.exec(trigger);
    } finally {
        db.close();
    }
    const reopened = openExtended(dir, { create: false });
    t.after(() => reopened.close());
    const again = bindingRow('svc1', 'run1', 'user:alice', { robotOwnerId: WORKSPACE_ROBOTS });
    expectCode(assert, () => reopened.admit(again, admitRequest(robotId, {}, again)), 'not_found');
});

test('workspace robots: two owners admit to one robot only through robotOwnerId', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const service = createVerifiedServiceContext({
        workspaceId: WORKSPACE, scope: 'scope-lifecycle', ownerId: 'user:admin', robotOwnerId: WORKSPACE_ROBOTS,
        operations: ['provision', 'adapter_complete', 'read', 'attest'], administrator: true
    });
    const operationId = newId();
    const { robotId } = store.beginProvision(service, { operationId, name: 'Workspace robot', configuration: robotConfig() });
    store.completePreparation(service, { operationId, outcome: 'succeeded' });
    assert.equal(store.getRobot(service, { robotId }).ready, true);
    assert.deepEqual(store.attestReadiness(service, { robotId }), { robotId, ready: true });
    const db = rawDb(dir, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT owner_id FROM robot WHERE id = ?').get(robotId).owner_id, WORKSPACE_ROBOTS);
    } finally {
        db.close();
    }
    const userA = syntheticContext({ originKey: 'user:a', ownerId: 'user:a', scope: 'scope-a', robotOwnerId: WORKSPACE_ROBOTS });
    const userB = syntheticContext({ originKey: 'user:b', ownerId: 'user:b', scope: 'scope-b', robotOwnerId: WORKSPACE_ROBOTS });
    assert.equal(store.admit(userA, admitRequest(robotId, {}, userA)).status, 'admitted');
    assert.equal(store.admit(userB, admitRequest(robotId, {}, userB)).status, 'admitted');
    // Without robotOwnerId the r3 behaviour holds: robot rows compare against ownerId.
    const plainA = syntheticContext({ originKey: 'user:a', ownerId: 'user:a', scope: 'scope-a' });
    expectCode(assert, () => store.admit(plainA, admitRequest(robotId, {}, plainA)), 'not_found');
    expectCode(assert, () => store.getRobot(plainA, { robotId }), 'not_found');
    assert.equal(count(dir, 'admission'), 2);
});

test('service contexts: bounded fields and operations; admission, lookup and binding refuse them', (t) => {
    const base = { workspaceId: WORKSPACE, scope: 's', ownerId: 'coordinator:svc', robotOwnerId: WORKSPACE_ROBOTS };
    for (const bad of [{ ...base, operations: ['admit'] }, { ...base, operations: ['bind'] }, { ...base, operations: ['control'] },
        { ...base, operations: ['lookup'] }, { ...base, operations: ['administer'] }, { ...base, robotOwnerId: '', operations: [] },
        { ...base, operations: [], originNamespace: 'mcp' }, { ...base, operations: [], administrator: 'yes' }]) {
        expectCode(assert, () => createVerifiedServiceContext(bad), 'invalid_request');
    }
    const { robotOwnerId, ...missing } = base;
    void robotOwnerId;
    expectCode(assert, () => createVerifiedServiceContext({ ...missing, operations: [] }), 'invalid_request');
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: WORKSPACE_ROBOTS, scope: 'scope-robots' }));
    const reader = createVerifiedServiceContext({ ...base, operations: ['read'] });
    assert.equal(store.getRobot(reader, { robotId }).robotId, robotId);
    // A service context cannot carry `admit` or `lookup` (refused by the operation check); the
    // origin-row check inside admit/lookupOrigin is defense in depth and unreachable from here.
    const smuggled = createVerifiedServiceContext({ ...base, operations: ['provision'] });
    expectCode(assert, () => store.admit(smuggled, admitRequest(robotId)), 'forbidden');
    expectCode(assert, () => store.lookupOrigin(smuggled, { originRequestId: newOriginId() }), 'forbidden');
});

function replayKey() {
    return { key: crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('base64url'), retainUntilMs: Date.now() + 60_000 };
}

function replayedCode(fn) {
    assert.throws(fn, (error) => error.name === 'WorkerStateError' && error.code === 'forbidden' && error.reason === 'token_replayed');
}

test('R5/R6: workspace robot lifecycle under service contexts in the lifecycle scope, with replay rollback and receipt replay', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir, { limits: { ...EXTENDED, robots: 1 } });
    t.after(() => store.close());
    const service = (operations, ownerId = 'user:admin') => createVerifiedServiceContext({
        workspaceId: WORKSPACE, scope: 'scope-lifecycle', ownerId, robotOwnerId: WORKSPACE_ROBOTS, operations, administrator: true
    });
    const runtime = service(['adapter_complete']);
    // Provision: committed, same-token retry refused, fresh-token retry replays the receipt.
    const provision = { operationId: newId(), name: 'Workspace robot', configuration: robotConfig() };
    const provisionKey = replayKey();
    const provisioned = store.beginProvision(service(['provision']), provision, { items: [provisionKey] });
    replayedCode(() => store.beginProvision(service(['provision']), { ...provision }, { items: [provisionKey] }));
    assert.deepEqual(store.beginProvision(service(['provision']), { ...provision }, { items: [replayKey()] }), provisioned);
    // A refused provision (robot capacity) rolls its consumption back.
    const refusedProvision = replayKey();
    expectCode(assert, () => store.beginProvision(service(['provision'], 'user:other'), { operationId: newId(), name: 'Second', configuration: robotConfig() }, { items: [refusedProvision] }), 'capacity_exceeded');
    store.consumeTokenIds({ items: [refusedProvision] });
    store.completePreparation(runtime, { operationId: provision.operationId, outcome: 'succeeded' });
    const robotId = provisioned.robotId;
    // Configure by another administrator of the same workspace robot.
    const refusedConfigure = replayKey();
    expectCode(assert, () => store.configure(service(['configure'], 'user:other'), { operationId: newId(), robotId: newId(), expectedRevision: 1, configuration: robotConfig({ v: 1 }) }, { items: [refusedConfigure] }), 'not_found');
    store.consumeTokenIds({ items: [refusedConfigure] });
    const configure = { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig({ v: 2 }) };
    const configureKey = replayKey();
    const configured = store.configure(service(['configure'], 'user:other'), configure, { items: [configureKey] });
    replayedCode(() => store.configure(service(['configure'], 'user:other'), { ...configure }, { items: [configureKey] }));
    assert.deepEqual(store.configure(service(['configure'], 'user:other'), { ...configure }, { items: [replayKey()] }), configured);
    store.completePreparation(runtime, { operationId: configure.operationId, outcome: 'succeeded' });
    assert.equal(store.getRobot(service(['read']), { robotId }).revision, 2);
    // Delete: a refused delete (stale revision) rolls back; then committed and completed.
    const refusedDelete = replayKey();
    expectCode(assert, () => store.beginDelete(service(['delete']), { operationId: newId(), robotId, expectedRevision: 1 }, { items: [refusedDelete] }), 'revision_conflict');
    store.consumeTokenIds({ items: [refusedDelete] });
    const remove = { operationId: newId(), robotId, expectedRevision: 2 };
    const deleteKey = replayKey();
    const deleting = store.beginDelete(service(['delete']), remove, { items: [deleteKey] });
    replayedCode(() => store.beginDelete(service(['delete']), { ...remove }, { items: [deleteKey] }));
    assert.deepEqual(store.beginDelete(service(['delete']), { ...remove }, { items: [replayKey()] }), deleting);
    assert.equal(store.completeDelete(runtime, { operationId: remove.operationId }).status, 'succeeded');
    assert.equal(store.getRobot(service(['read']), { robotId }).lifecycle, 'deleted');
    assert.equal(store.getOperationOutcome(service(['read']), { operationId: remove.operationId }).status, 'succeeded');
    // The robot rows carry the workspace owner; contexts without robotOwnerId cannot reach them.
    expectCode(assert, () => store.getRobot(syntheticContext({ ownerId: 'user:admin', scope: 'scope-lifecycle' }), { robotId }), 'not_found');
});

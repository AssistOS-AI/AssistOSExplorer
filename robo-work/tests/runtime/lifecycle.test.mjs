import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { recoverWorkerGeneration } from '../../server/runtime/recovery.mjs';
import { createLifecycleDriver } from '../../server/runtime/lifecycleDriver.mjs';
import { runSandboxPreflight } from '../../server/runtime/preflight.mjs';
import { createProductionRuntime } from '../../server/runtime/productionRuntime.mjs';
import { createRobotStore, managedAlaConfig } from '../../server/runtime/robotStore.mjs';
import { LIMITS, WORKSPACE, admitRequest, expectCode, makeTempDir, newId, openStore, robotConfig, syntheticContext } from '../helpers/synthetic.mjs';

// The production runtime adapter, the robot storage (decision M-10) and the preparation driver, over real files and a
// real S1 store (state evidence plus plain filesystem checks; no sandbox is started).

const LIMITS_X = Object.freeze({ ...LIMITS, robots: 8, receipts: 128, bindings: 8, controls: 16, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const lifecycle = () => syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' });
const OK = Object.freeze({ ok: true, missing: [], masks: [], reason: null });
const BROKEN = Object.freeze({ ok: false, missing: ['bwrap'], masks: [], reason: 'missing tools: bwrap' });

function rig(t, preflight = OK, wrap = (robots) => robots) {
    const root = makeTempDir(t);
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const robots = wrap(createRobotStore({ root }));
    const runtime = createProductionRuntime({ preflight, robots });
    const store = openStore(stateDir, { limits: LIMITS_X, runtime });
    t.after(() => store.close());
    const logs = [];
    const driver = createLifecycleDriver({ store, robots, workspaceId: WORKSPACE, log: (event, fields) => logs.push({ event, ...fields }), retryMs: 0 });
    return { root, stateDir, robots, runtime, store, driver, logs };
}

test('the managed ALA configuration keeps only what ALA accepts', () => {
    assert.deepEqual(managedAlaConfig({ backend: 'codex', settings: { models: { codex: 'gpt-x', bogus: 'y', claude: ' ' }, efforts: { codex: 'high', claude: 'low' }, extra: 1 } }),
        { codingAgent: 'codex', models: { codex: 'gpt-x' }, efforts: { codex: 'high' } });
    assert.deepEqual(managedAlaConfig({ backend: 'synthetic', settings: {} }), { models: {}, efforts: {} });
    // M-44: a gateway model is stored exactly as the robot configuration gives it (no canonicalisation), so no existing robot goes stale.
    assert.deepEqual(managedAlaConfig({ backend: 'opencode', settings: { model: 'Soul-Gateway/Model-X' } }).models, { opencode: 'Soul-Gateway/Model-X' });
    assert.deepEqual(managedAlaConfig({ backend: 'opencode', settings: { models: { opencode: 'SOUL-GATEWAY/y' } } }).models, { opencode: 'SOUL-GATEWAY/y' });
    // RoboTeam's one-agent robot: `settings.model` and `settings.effort` apply to its `backend`; a plural map wins; an effort needs a model.
    assert.deepEqual(managedAlaConfig({ backend: 'claude', settings: { codingAgents: ['claude'], model: 'opus', effort: 'high' } }),
        { codingAgent: 'claude', models: { claude: 'opus' }, efforts: { claude: 'high' } });
    assert.deepEqual(managedAlaConfig({ backend: 'claude', settings: { model: 'single', models: { claude: 'plural' } } }).models, { claude: 'plural' });
    assert.deepEqual(managedAlaConfig({ backend: 'codex', settings: { effort: 'high' } }), { codingAgent: 'codex', models: {}, efforts: {} });
    assert.deepEqual(managedAlaConfig({ backend: 'auto', settings: { codingAgents: ['codex', 'claude'], model: 'x' } }), { models: {}, efforts: {} }, 'no single backend, no model');
});

test('provision: the driver creates HOME, sessions and the managed configuration, then S1 attests the robot', async (t) => {
    const { store, driver, robots } = rig(t);
    const operationId = newId();
    const configuration = robotConfig({ models: { codex: 'gpt-x' } }, 'codex');
    const { robotId } = store.beginProvision(lifecycle(), { operationId, name: 'R', configuration });
    assert.equal(store.getRobot(lifecycle(), { robotId }).ready, false);
    await driver.tick();
    const view = store.getRobot(lifecycle(), { robotId });
    assert.equal(view.ready, true);
    assert.equal(view.lifecycle, 'ready');
    const where = robots.paths(robotId);
    for (const directory of [where.home, where.sessions, where.configDir]) assert.equal(fs.lstatSync(directory).isDirectory(), true);
    assert.equal((fs.statSync(where.home).mode & 0o777), 0o700);
    assert.deepEqual(JSON.parse(fs.readFileSync(where.config, 'utf8')), { codingAgent: 'codex', efforts: {}, models: { codex: 'gpt-x' } });
    assert.deepEqual(store.getOperationOutcome(lifecycle(), { operationId }).status, 'succeeded');
    // configure rewrites the configuration and keeps the HOME contents.
    fs.writeFileSync(path.join(where.home, '.credential'), 'kept');
    const next = robotConfig({ models: { codex: 'gpt-y' } }, 'codex');
    const configure = newId();
    store.configure(lifecycle(), { operationId: configure, robotId, expectedRevision: 1, configuration: next });
    await driver.tick();
    assert.equal(store.getRobot(lifecycle(), { robotId }).revision, 2);
    assert.equal(JSON.parse(fs.readFileSync(where.config, 'utf8')).models.codex, 'gpt-y');
    assert.equal(fs.readFileSync(path.join(where.home, '.credential'), 'utf8'), 'kept');
});

test('the adapter attests only an intact robot directory and refuses everything when the sandbox preflight failed', (t) => {
    const ok = rig(t);
    const configuration = robotConfig({}, 'codex');
    const robotId = newId();
    assert.equal(ok.runtime.attestRobot({ robotId, configuration }), false, 'nothing prepared yet');
    ok.robots.prepare(robotId, configuration);
    assert.equal(ok.runtime.attestRobot({ robotId, configuration }), true);
    assert.equal(ok.runtime.attestRobot({ robotId, configuration: robotConfig({ models: { codex: 'other' } }, 'codex') }), false, 'configuration differs from the managed file');
    const where = ok.robots.paths(robotId);
    fs.rmSync(where.home, { recursive: true });
    fs.symlinkSync('/tmp', where.home);
    assert.equal(ok.runtime.attestRobot({ robotId, configuration }), false, 'a symlinked HOME is refused');
    assert.throws(() => ok.robots.paths('../x'), TypeError);
    assert.throws(() => ok.robots.remove('not-an-id'), TypeError);

    const broken = rig(t, BROKEN);
    assert.equal(broken.runtime.canPrepare(), false);
    assert.equal(broken.runtime.admissionReady({ robotId: null }), false);
    expectCode(assert, () => broken.store.beginProvision(lifecycle(), { operationId: newId(), name: 'R', configuration }), 'runtime_unavailable');
});

test('delete removes the robot directory and completes; a failed preparation completes as failed', async (t) => {
    const { store, driver, robots, logs } = rig(t);
    const { robotId } = store.beginProvision(lifecycle(), { operationId: newId(), name: 'R', configuration: robotConfig({}, 'codex') });
    await driver.tick();
    assert.equal(robots.exists(robotId), true);
    const operationId = newId();
    store.beginDelete(lifecycle(), { operationId, robotId, expectedRevision: 1 });
    await driver.tick();
    assert.equal(robots.exists(robotId), false);
    assert.equal(store.getOperationOutcome(lifecycle(), { operationId }).status, 'succeeded');
    assert.equal(store.getRobot(lifecycle(), { robotId }).lifecycle, 'deleted');

    // A storage failure fails the preparation instead of attesting it.
    const failing = rig(t, OK, (robots) => ({ ...robots, prepare: () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); } }));
    const second = failing.store.beginProvision(lifecycle(), { operationId: newId(), name: 'R', configuration: robotConfig() });
    await failing.driver.tick();
    const view = failing.store.getRobot(lifecycle(), { robotId: second.robotId });
    assert.equal(view.ready, false);
    assert.equal(view.lifecycle, 'failed');
    assert.equal(view.uncertain, true);
    assert.ok(failing.logs.some((entry) => entry.event === 'prepare_failed' && entry.error === 'ENOSPC'));
    assert.equal(logs.length, 0);
});

test('after a restart the generation rollover cleared every attestation and the driver restores them; an interrupted provision does not block recovery', async (t) => {
    const first = rig(t);
    const { robotId } = first.store.beginProvision(lifecycle(), { operationId: newId(), name: 'R', configuration: robotConfig({}, 'codex') });
    await first.driver.tick();
    const interrupted = first.store.beginProvision(lifecycle(), { operationId: newId(), name: 'Interrupted', configuration: robotConfig({}, 'codex') });
    first.store.close();

    const store = openStore(first.stateDir, { limits: LIMITS_X, runtime: first.runtime, create: false });
    t.after(() => store.close());
    // The worker's own recovery: the interrupted provision's `preparation` blocker is settled, not quarantined by the walker.
    const walker = { walk: async () => { throw new Error('the walker must not be asked about a preparation'); } };
    const recovered = await recoverWorkerGeneration({ state: store, walker });
    assert.deepEqual(recovered.outcomes.map((entry) => [entry.kind, entry.outcome]), [['preparation', 'released']]);
    assert.equal(store.getRobot(lifecycle(), { robotId }).ready, false, 'not attested in the new generation');
    assert.equal(store.getRobot(lifecycle(), { robotId: interrupted.robotId }).lifecycle, 'failed');
    const driver = createLifecycleDriver({ store, robots: first.robots, workspaceId: WORKSPACE, retryMs: 0 });
    await driver.tick();
    assert.equal(store.getRobot(lifecycle(), { robotId }).ready, true);
    assert.equal(store.listUnattestedRobots().length, 0);
});

test('preflight: missing tools and unreadable masks fail it with a reason', () => {
    const present = runSandboxPreflight({ access: () => {}, readMasks: () => [{ path: '/proc/kcore' }] });
    assert.equal(present.ok, true);
    assert.equal(present.masks.length, 1);
    const missing = runSandboxPreflight({ access: (target) => { if (/nft$|bwrap$/u.test(target)) throw new Error('no'); }, readMasks: () => [] });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missing.sort(), ['bwrap', 'nft']);
    const unreadable = runSandboxPreflight({ access: () => {}, readMasks: () => { throw Object.assign(new Error('x'), { code: 'sandbox_unavailable' }); } });
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.reason, /sandbox_unavailable/u);
});

// ---- M-29: robot deletion ---------------------------------------------------------------------------------------------------

test('M-29 delete: busy while an execution, a pending create or a quarantined blocker exists; then HOME, sessions and config are removed without following links', async (t) => {
    const { store, driver, robots, root } = rig(t);
    const { robotId } = store.beginProvision(lifecycle(), { operationId: newId(), name: 'R', configuration: robotConfig({}, 'codex') });
    expectCode(assert, () => store.beginDelete(lifecycle(), { operationId: newId(), robotId, expectedRevision: 0 }), 'robot_busy');
    await driver.tick();
    const where = robots.paths(robotId);
    // Content of the robot, including a link out of HOME and a read-only file.
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive');
    fs.symlinkSync(outside, path.join(where.home, 'link-out'));
    fs.mkdirSync(path.join(where.home, '.codex'));
    fs.writeFileSync(path.join(where.home, '.codex', 'auth.json'), '{}', { mode: 0o400 });
    fs.writeFileSync(path.join(where.sessions, 'x.jsonl'), '');

    // An execution (queued is enough) holds the robot.
    const alice = syntheticContext({ originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-co-alice', robotOwnerId: ROBOTS });
    const admitted = store.admit(alice, admitRequest(robotId, { specification: { prompt: 'p' } }, alice));
    expectCode(assert, () => store.beginDelete(lifecycle(), { operationId: newId(), robotId, expectedRevision: 1 }), 'robot_busy');
    store.beginAttemptEnd(syntheticContext({ scope: 'scope-adapter' }), { executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', outcome: { classification: 'cancelled' } });
    // A quarantined blocker holds a robot too (the production runtime cannot prove absence, so a quarantine is cleared by an operator only).
    const second = store.beginProvision(lifecycle(), { operationId: newId(), name: 'R2', configuration: robotConfig({}, 'codex') }).robotId;
    await driver.tick();
    const blocker = store.reserveResource({ robotId: second, kind: 'mount', locator: { m: 1 } });
    store.commitResource({ resourceId: blocker.resourceId, identity: { mountId: 1 } });
    store.quarantineResource({ resourceId: blocker.resourceId, generationId: store.generationId });
    expectCode(assert, () => store.beginDelete(lifecycle(), { operationId: newId(), robotId: second, expectedRevision: 1 }), 'robot_busy');

    const operationId = newId();
    const request = { operationId, robotId, expectedRevision: 1 };
    const receipt = store.beginDelete(lifecycle(), request);
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(store.beginDelete(lifecycle(), request), receipt, 'the same operation after a lost reply: the same receipt');
    await driver.tick();
    assert.equal(robots.exists(robotId), false, 'the robot directory is gone');
    assert.equal(fs.existsSync(where.home), false);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'must survive', 'a link in HOME is removed, never followed');
    assert.equal(store.getOperationOutcome(lifecycle(), { operationId }).status, 'succeeded');
    assert.equal(store.getRobot(lifecycle(), { robotId }).lifecycle, 'deleted');
    assert.deepEqual(store.beginDelete(lifecycle(), request), receipt, 'and after completion');

    // Deleting an already-deleted robot is a success under a new operation, completed at once, and the driver finds nothing to do.
    const again = newId();
    assert.equal(store.beginDelete(lifecycle(), { operationId: again, robotId, expectedRevision: 1 }).status, 'accepted');
    assert.equal(store.getOperationOutcome(lifecycle(), { operationId: again }).status, 'succeeded');
    assert.deepEqual(store.listPendingCompletions(), []);
    await driver.tick();
});

test('M-29 robotStore.remove: a link in place of the robot directory is unlinked, and nothing outside robots/<id> is touched', (t) => {
    const root = makeTempDir(t);
    const robots = createRobotStore({ root });
    const id = 'AAAAAAAAAAAAAAAAAAAAAA';
    fs.mkdirSync(robots.robotsRoot, { recursive: true });
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'f'), 'x');
    fs.symlinkSync(outside, robots.paths(id).base);
    robots.remove(id);
    assert.equal(fs.existsSync(robots.paths(id).base), false);
    assert.equal(fs.readFileSync(path.join(outside, 'f'), 'utf8'), 'x');
    robots.remove(id);
    assert.throws(() => robots.remove('../escape'), TypeError);
});

// ---- M-47: a robot that stays nonready backs off and is logged once per state change --------------------------------------------------------------------

function attestStub(failWith) {
    const calls = [];
    const state = { failWith };
    const store = {
        listPendingCompletions: () => [], completePreparation() {}, completeDelete() {},
        listUnattestedRobots: () => [{ robotId: 'R1', ownerId: 'O', configuration: {} }],
        attestReadiness: () => { calls.push(clock.t); if (state.failWith) throw Object.assign(new Error('x'), { code: state.failWith }); }
    };
    const clock = { t: 0 };
    const logs = [];
    const driver = createLifecycleDriver({ store, robots: { prepare() {} }, workspaceId: WORKSPACE, now: () => clock.t, log: (event, fields) => logs.push({ event, ...fields }), retryMs: 5000, maxRetryMs: 40000 });
    return { driver, clock, calls, logs, state };
}

test('M-47: a robot in resource_quarantined is re-attested after 5 s, then 10 s, 20 s, 40 s, 40 s (not every 5 s), and the failure is logged ONCE', async () => {
    const { driver, clock, calls, logs } = attestStub('resource_quarantined');
    for (let seconds = 0; seconds <= 200; seconds += 1) { clock.t = seconds * 1000; await driver.tick(); }
    assert.deepEqual(calls.map((at) => at / 1000), [0, 5, 15, 35, 75, 115, 155, 195], 'delays 5, 10, 20, 40, 40, 40, 40 seconds');
    assert.equal(logs.filter((entry) => entry.event === 'attest_failed').length, 1, 'one log line for the state, not one per attempt');
    assert.equal(logs[0].error, 'resource_quarantined');
    assert.equal(logs[0].retryInMs, 5000);
});

test('M-47: a different failure is a state change and is logged; the recovery is logged once and resets the delay', async () => {
    const { driver, clock, calls, logs, state } = attestStub('resource_quarantined');
    await driver.tick();
    clock.t = 5000; await driver.tick();
    state.failWith = 'robot_busy';
    clock.t = 15000; await driver.tick();
    assert.deepEqual(logs.map((entry) => [entry.event, entry.error ?? entry.after]), [['attest_failed', 'resource_quarantined'], ['attest_failed', 'robot_busy']]);
    state.failWith = null;
    clock.t = 15000 + 20000; await driver.tick();
    assert.deepEqual(logs.at(-1), { event: 'attest_recovered', robotId: 'R1', after: 'robot_busy', attempts: 3 });
    assert.equal(logs.length, 3);
    // a later failure starts again from the base delay
    state.failWith = 'resource_quarantined';
    clock.t = 60000; await driver.tick();
    clock.t = 64000; await driver.tick();
    clock.t = 65000; await driver.tick();
    assert.equal(calls.length, 6, 'attempts at 0, 5, 15, 35, 60 and (base delay again) 65 seconds');
    assert.equal(logs.at(-1).event, 'attest_failed');
});

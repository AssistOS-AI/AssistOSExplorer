import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { recoverWorkerGeneration } from '../../server/runtime/recovery.mjs';
import { createLifecycleDriver } from '../../server/runtime/lifecycleDriver.mjs';
import { runSandboxPreflight } from '../../server/runtime/preflight.mjs';
import { createProductionRuntime } from '../../server/runtime/productionRuntime.mjs';
import { createRobotStore, managedAlaConfig } from '../../server/runtime/robotStore.mjs';
import { LIMITS, WORKSPACE, expectCode, makeTempDir, newId, openStore, robotConfig, syntheticContext } from '../helpers/synthetic.mjs';

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

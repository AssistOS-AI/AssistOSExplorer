import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { createRobotUtilities, modelUtilityPlan } from '../../server/runtime/robotUtilities.mjs';
import { WORKSPACE, S6_LIMITS, makeTempDir, openStore, readyRobot, syntheticContext, rawDb, expectCode } from '../helpers/synthetic.mjs';

function rig(t, { output = '[{"id":"p/m","efforts":["high"]}]', hanging = false, delayOpen = 0, outputBytes = 1024, historyLimit = S6_LIMITS.admissions } = {}) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: { ...S6_LIMITS, admissions: historyLimit } });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: `workspace:${WORKSPACE}`, scope: 'robots' }));
    const robot = { robotId, revision: 1, ready: true };
    const calls = [];
    let resolveExit;
    let now = 0;
    const factory = {
        async open(options) {
            calls.push(['open', options]);
            if (delayOpen) await new Promise((resolve) => setTimeout(resolve, delayOpen));
            const stdout = hanging ? new PassThrough() : Readable.from([output]);
            const stderr = hanging ? new PassThrough() : Readable.from([]);
            return {
                exited: hanging ? new Promise((resolve) => { resolveExit = resolve; }) : Promise.resolve({ exitCode: 0, signal: null }),
                async start() { calls.push(['start']); return { stdin: new PassThrough(), stdout, stderr }; },
                async end(outcome) {
                    calls.push(['end', outcome]);
                    stdout.destroy(); stderr.destroy(); resolveExit?.({ exitCode: 1 });
                    store.beginAttemptEnd(options.context, {
                        outcome: { classification: outcome.classification, outputText: outcome.outputText, data: outcome.data }, expectedState: outcome.expectedState, executionId: options.item.executionId, attemptId: options.item.attemptId,
                    });
                    return { releaseLog: [] };
                },
            };
        },
        openTerminal(options) { calls.push(['status', options]); return this.open(options); },
    };
    const utilities = createRobotUtilities({ store, factory, workspaceId: WORKSPACE, now: () => now, options: { deadlineMs: 10, outputBytes, cacheMs: 20, cacheEntries: 1 } });
    t.after(() => utilities.close());
    return { dir, store, robot, utilities, calls, advance: () => { now += 21; } };
}

test('utility admission is internal and separately capped', async (t) => {
    const { dir, store, robot } = rig(t);
    const item = store.admitUtility({ robotId: robot.robotId, maxPerRobot: 1, maxTotal: 2 });
    expectCode(assert, () => store.admitUtility({ robotId: robot.robotId, maxPerRobot: 1, maxTotal: 2 }), 'capacity_exceeded');
    assert.deepEqual(store.listQueuedAdmissions(), []);
    const db = rawDb(dir, { readOnly: true });
    t.after(() => db.close());
    const reference = db.prepare('SELECT * FROM reference WHERE execution_id = ?').get(item.executionId);
    assert.equal(reference.kind, 'utility');
    expectCode(assert, () => store.observeReference(syntheticContext(), { referenceId: reference.id }), 'not_found');
});

test('model plan uses protocol ALA without project or task channels; projections cache by revision and expire', async (t) => {
    const { robot, utilities, calls, advance } = rig(t);
    assert.deepEqual(modelUtilityPlan('codex').argv, ['agent', 'models', 'codex', '--json', '--home', '/home/robot', '--execution-provider', 'protocol']);
    const result = await utilities.read(robot, 'models', 'codex');
    assert.deepEqual(result, { agent: 'codex', models: [{ id: 'p/m', label: 'p/m', efforts: ['high'] }] });
    result.models[0].efforts.push('bad');
    assert.deepEqual((await utilities.read(robot, 'models', 'codex')).models[0].efforts, ['high']);
    assert.equal(calls.filter(([name]) => name === 'open').length, 1);
    await utilities.read({ ...robot, revision: 2 }, 'models', 'codex');
    advance(); await utilities.read({ ...robot, revision: 2 }, 'models', 'codex');
    assert.equal(calls.filter(([name]) => name === 'open').length, 3);
    assert.equal(calls.filter(([name]) => name === 'end').length, 3);
});

for (const [name, options] of [['deadline', { hanging: true }], ['output limit', { output: 'x'.repeat(2000) }], ['invalid projection', { output: '[{"id":"x","efforts":["bad effort"]}]' }], ['delayed setup', { delayOpen: 20 }]]) {
    test(`${name} refuses, cleans up and leaves no cached success`, async (t) => {
        const { robot, utilities, calls } = rig(t, options);
        await assert.rejects(utilities.read(robot, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
        assert.equal(calls.filter(([step]) => step === 'end').length, 1);
        if (name === 'delayed setup') assert.equal(calls.filter(([step]) => step === 'start').length, 0);
    });
}

test('status runs a fixed workload helper and returns only booleans and version tokens', async (t) => {
    const agents = ['codex', 'opencode', 'pi', 'claude'].map((name) => ({ name, available: true, loggedIn: name === 'codex', version: '1.2.3', secret: 'discard' }));
    const { robot, utilities, calls } = rig(t, { output: JSON.stringify({ agents, secret: 'discard' }) });
    const result = await utilities.read(robot, 'agent-status');
    assert.equal(result.agents[0].loggedIn, true);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(calls.find(([name]) => name === 'status')[1].utility, true);
    await utilities.close();
    await assert.rejects(utilities.read(robot, 'agent-status'), (error) => error.code === 'runtime_unavailable');
});

test('utility history is bounded independently of task slots, and unready robots cannot read a cached projection', async (t) => {
    const { robot, utilities, calls } = rig(t, { historyLimit: 2 });
    await utilities.read(robot, 'models', 'codex');
    await assert.rejects(utilities.read({ ...robot, ready: false }, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
    assert.equal(calls.filter(([name]) => name === 'open').length, 1);
    await utilities.read({ ...robot, revision: 2 }, 'models', 'codex');
    await assert.rejects(utilities.read({ ...robot, revision: 3 }, 'models', 'codex'), (error) => error.code === 'capacity_exceeded');
    assert.equal(calls.filter(([name]) => name === 'open').length, 2);
});

test('worker shutdown ends an active utility before close resolves', async (t) => {
    const { robot, utilities, calls } = rig(t, { hanging: true });
    const reading = utilities.read(robot, 'models', 'codex');
    const refused = assert.rejects(reading, (error) => error.code === 'runtime_unavailable');
    await new Promise((resolve) => setImmediate(resolve));
    await utilities.close();
    await refused;
    assert.equal(calls.filter(([name]) => name === 'end').length, 1);
});

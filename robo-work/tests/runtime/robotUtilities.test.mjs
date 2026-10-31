import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { createExecutionFactory } from '../../server/runtime/executionFactory.mjs';
import { createRobotUtilities, modelUtilityPlan } from '../../server/runtime/robotUtilities.mjs';
import { WORKSPACE, S6_LIMITS, makeTempDir, openStore, readyRobot, syntheticContext, rawDb, expectCode } from '../helpers/synthetic.mjs';

function rig(t, { output = '[{"id":"p/m","efforts":["high"]}]', hanging = false, delayOpen = 0, outputBytes = 1024, historyLimit = S6_LIMITS.admissions, modelUpstream = null, lostReason = null, nativeExitCode = 0, openError = null } = {}) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: { ...S6_LIMITS, admissions: historyLimit } });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: `workspace:${WORKSPACE}`, scope: 'robots' }));
    const robot = { robotId, revision: 1, ready: true };
    const calls = [];
    const logs = [];
    let resolveExit;
    let now = 0;
    const factory = {
        async open(options) {
            calls.push(['open', options]);
            if (openError) throw openError;
            if (delayOpen) await new Promise((resolve) => setTimeout(resolve, delayOpen));
            const stdout = hanging ? new PassThrough() : Readable.from([output]);
            const stderr = hanging ? new PassThrough() : Readable.from([]);
            return {
                exited: hanging ? new Promise((resolve) => { resolveExit = resolve; }) : lostReason ? new Promise((resolve) => setImmediate(() => resolve({ exitCode: nativeExitCode, signal: null }))) : Promise.resolve({ exitCode: nativeExitCode, signal: null }),
                ...(lostReason ? { lost: Promise.resolve(lostReason) } : {}),
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
    const utilities = createRobotUtilities({ store, factory, modelUpstream, log: (event, data) => logs.push({ event, ...data }), workspaceId: WORKSPACE, now: () => now, options: { deadlineMs: 10, outputBytes, cacheMs: 20, cacheEntries: 1 } });
    t.after(() => utilities.close());
    return { dir, store, robot, utilities, calls, logs, advance: () => { now += 21; } };
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

test('M84 OpenCode picker merges all permitted worker gateway models and replaces native gateway entries without inventing efforts', async (t) => {
    const requests = [];
    let permitted = [{ id: 'allowed-a', name: 'Allowed A' }, { id: 'allowed-b' }];
    const modelUpstream = { request: async (request) => { requests.push(request); return { ok: true, json: { data: permitted } }; } };
    const { robot, utilities, advance } = rig(t, { modelUpstream, output: JSON.stringify([
        { id: 'opencode/native', efforts: ['high'] }, { id: 'Soul-Gateway/stale-or-forbidden', efforts: ['max'] },
        { id: 'soul-gateway/allowed-a', efforts: ['invented'] },
    ]) });
    const expected = [
        { id: 'opencode/native', label: 'opencode/native', efforts: ['high'] },
        { id: 'soul-gateway/allowed-a', label: 'Allowed A', efforts: [] },
        { id: 'soul-gateway/allowed-b', label: 'allowed-b', efforts: [] },
    ];
    assert.deepEqual((await utilities.read(robot, 'models', 'opencode')).models, expected);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation, 'models');
    assert.ok(requests[0].signal instanceof AbortSignal);
    assert.equal(requests[0].totalTimeoutMs, 10);
    permitted = [{ id: 'newly-permitted' }];
    assert.deepEqual((await utilities.read(robot, 'models', 'opencode')).models, expected, 'same bounded cache window');
    assert.equal(requests.length, 1);
    advance();
    assert.deepEqual((await utilities.read(robot, 'models', 'opencode')).models.map((entry) => entry.id), ['opencode/native', 'soul-gateway/newly-permitted']);
    assert.equal(requests.length, 2);
});

test('M84 other backends never request or advertise gateway models', async (t) => {
    const modelUpstream = { request: async () => assert.fail('no gateway request for another backend') };
    const { robot, utilities } = rig(t, { modelUpstream, output: '[{"id":"native","efforts":[]},{"id":"soul-gateway/forbidden","efforts":[]}]' });
    for (const agent of ['codex', 'claude', 'pi']) assert.deepEqual((await utilities.read(robot, 'models', agent)).models.map((entry) => entry.id), ['native']);
});

for (const [name, first] of [['refused', { ok: false, status: 403 }], ['malformed', { ok: true, json: { data: [{ id: '\ninvalid' }] } }]]) {
    test(`M84 ${name} gateway catalog refuses the whole listing and is not cached`, async (t) => {
        let count = 0;
        const modelUpstream = { request: async () => ++count === 1 ? first : { ok: true, json: { data: [{ id: 'available' }] } } };
        const { robot, utilities, calls } = rig(t, { modelUpstream });
        await assert.rejects(utilities.read(robot, 'models', 'opencode'), (error) => error.code === 'runtime_unavailable');
        assert.deepEqual((await utilities.read(robot, 'models', 'opencode')).models.map((entry) => entry.id), ['p/m', 'soul-gateway/available']);
        assert.equal(count, 2);
        assert.equal(calls.filter(([name]) => name === 'end').length, 2);
    });
}

test('M84 catalog timeout aborts its upstream request and ends the admitted utility', async (t) => {
    let aborted = false;
    const modelUpstream = { request: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) };
    const { robot, utilities, calls } = rig(t, { modelUpstream });
    await assert.rejects(utilities.read(robot, 'models', 'opencode'), (error) => error.code === 'runtime_unavailable');
    assert.equal(aborted, true);
    assert.equal(calls.filter(([name]) => name === 'end').length, 1);
});

test('M84 gateway projection remains bounded and strips untrusted label controls', async (t) => {
    const catalog = { data: [{ id: 'a', name: 'unsafe\nlabel' }] };
    const { robot, utilities } = rig(t, { modelUpstream: { request: async () => ({ ok: true, json: catalog }) } });
    assert.equal((await utilities.read(robot, 'models', 'opencode')).models[1].label, 'soul-gateway/a');
    const limited = rig(t, { outputBytes: 100, modelUpstream: { request: async () => ({ ok: true, json: { data: [{ id: 'x'.repeat(100) }] } }) } });
    await assert.rejects(limited.utilities.read(limited.robot, 'models', 'opencode'), (error) => error.code === 'runtime_unavailable');
});

test('clean ALA endpoint closure before the bwrap exit and stream drain preserves the successful utility result', async (t) => {
    const { robot, utilities, calls } = rig(t, { lostReason: 'endpoint_ended:endpoint_lost' });
    assert.deepEqual((await utilities.read(robot, 'models', 'codex')).models.map((entry) => entry.id), ['p/m']);
    assert.equal(calls.find(([name]) => name === 'end')[1].classification, 'completed');
});

test('anchor infrastructure loss still fails even when native stdout could form a valid result', async (t) => {
    const { robot, utilities } = rig(t, { lostReason: 'infrastructure_lost:anchor' });
    await assert.rejects(utilities.read(robot, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
});

test('endpoint closure with a nonzero native exit is refused and records only fixed diagnostic fields', async (t) => {
    const { robot, utilities, logs, calls } = rig(t, { lostReason: 'endpoint_ended:endpoint_lost', nativeExitCode: 1 });
    await assert.rejects(utilities.read(robot, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
    assert.equal(logs[0].stage, 'native');
    assert.equal(logs[0].code, 'utility_failed');
    assert.equal(logs[0].exitCode, 1);
    assert.equal(calls.find(([name]) => name === 'end')[1].data.code, 'utility_failed');
});

test('endpoint closure without a successful exit and drain still hits the utility deadline', async (t) => {
    const { robot, utilities, logs } = rig(t, { lostReason: 'endpoint_ended:endpoint_lost', hanging: true });
    await assert.rejects(utilities.read(robot, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
    assert.equal(logs[0].code, 'utility_timeout');
});

test('unexpected setup messages never enter utility logs or durable diagnostics', async (t) => {
    const { robot, utilities, logs, dir } = rig(t, { openError: new Error('private sample that must remain unpublished') });
    await assert.rejects(utilities.read(robot, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
    assert.equal(logs[0].stage, 'open');
    assert.equal(logs[0].code, 'open_failed');
    const db = rawDb(dir, { readOnly: true });
    const result = db.prepare("SELECT result FROM admission WHERE kind='utility'").get().result;
    db.close();
    assert.equal(JSON.stringify(logs).includes('private sample'), false);
    assert.equal(result.includes('private sample'), false);
});

test('endpoint protocol violation remains an immediate refusal despite otherwise valid native output', async (t) => {
    const { robot, utilities } = rig(t, { lostReason: 'endpoint_ended:channel_violation:bad_event' });
    await assert.rejects(utilities.read(robot, 'models', 'codex'), (error) => error.code === 'runtime_unavailable');
});

test('production factory latches anchor loss after ordinary endpoint EOF: immediate refusal, cleanup and no success cache', async (t) => {
    const { store, robot } = rig(t);
    const controls = [];
    const ended = [];
    const closed = [];
    let nextFd = 20;
    const factory = createExecutionFactory({
        store, robots: { root: '/store', paths: () => ({ home: '/store/home', sessions: '/store/sessions', configDir: '/store/config' }) },
        workspaceRoot: '/ws', runtimeDir: '/store/runtime', serverDir: '/code/server', alaRoot: '/ala', launcher: {}, view: {}, walker: {}, clock: {},
        deps: {
            openDirectory: () => nextFd++, closeFd: (fd) => closed.push(fd), readManagedConfig: () => ({}),
            imageBinds: () => ({ roBinds: [], symlinks: [] }), resolveExecutionGrants: async () => [],
            createExecutionSupervisor(options) {
                const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
                const control = { streams, anchorLost: options.onInfrastructureLoss };
                controls.push(control);
                return { controlStreams: streams, endpointSocket: {}, providerSandbox: () => ({}), exit: async () => { control.cleaned = true; } };
            },
            createSupervisorEndpointServer(options) {
                controls.at(-1).endpointEnded = options.onEnd;
                return { end() {} };
            },
            createExecutionLedger(options) {
                const control = controls.at(-1);
                return {
                    startKeeper: async () => {},
                    publish: async ({ kind }) => ({ handle: kind === 'process-tree' ? { wait: () => new Promise((resolve) => { control.exit = resolve; }) } : null }),
                    async endExecution(outcome) {
                        ended.push(outcome);
                        store.beginAttemptEnd(options.context, { executionId: options.executionId, attemptId: options.attemptId, expectedState: outcome.expectedState,
                            outcome: { classification: outcome.classification, outputText: outcome.outputText, data: outcome.data } });
                        return { releaseLog: [] };
                    },
                };
            },
        },
    });
    const executions = [];
    const utilities = createRobotUtilities({ store, factory: { async open(options) {
        const execution = await factory.open(options); executions.push(execution); return execution;
    } }, workspaceId: WORKSPACE, options: { deadlineMs: 1000 } });
    t.after(() => utilities.close());
    const reading = utilities.read(robot, 'models', 'codex');
    const refused = assert.rejects(reading, (error) => error.code === 'runtime_unavailable');
    while (!controls[0]?.exit) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controls[0].endpointEnded('endpoint_lost');
    controls[0].anchorLost('anchor_lost');
    assert.equal(await executions[0].lost, 'endpoint_ended:endpoint_lost', 'existing first-loss semantics are preserved');
    // Refusal must arrive without waiting for either native exit or stream drain.
    let timer;
    try {
        await Promise.race([refused, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fatal loss was not immediate')), 200); })]);
    } finally { clearTimeout(timer); }
    assert.equal(ended[0].classification, 'failed');
    assert.equal(controls[0].cleaned, true);
    assert.equal(closed.length, 3);
    controls[0].streams.stdout.end('[{"id":"native","efforts":[]}]');
    controls[0].streams.stderr.end();
    controls[0].exit({ exitCode: 0, signal: null });
    // A second read must open a new execution, never return the first one's otherwise-valid late result.
    const retry = utilities.read(robot, 'models', 'codex');
    while (!controls[1]?.exit) await new Promise((resolve) => setImmediate(resolve));
    controls[1].streams.stdout.end('[{"id":"native","efforts":[]}]'); controls[1].streams.stderr.end();
    controls[1].exit({ exitCode: 0, signal: null });
    assert.equal((await retry).models[0].id, 'native');
    assert.equal(controls.length, 2);
    assert.deepEqual(ended.map((outcome) => outcome.classification), ['failed', 'completed']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createDispatcher } from '../../server/runtime/dispatcher.mjs';
import { S6_LIMITS, WORKSPACE, admitRequest, makeTempDir, newId, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

const waitFor = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'bounded dispatcher wait'); await new Promise((resolve) => setTimeout(resolve, 5)); }
};
function rig(t, timeouts = {}, { deferredStart = false } = {}) {
    const store = openStore(makeTempDir(t), { limits: S6_LIMITS });
    t.after(() => store.close());
    const robotOwnerId = `workspace:${WORKSPACE}`;
    const owner = syntheticContext({ originNamespace: 'coordinator:fixtures', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'owner', robotOwnerId });
    const bindingId = 'flow_0123456789abcdef01234567';
    store.registerBinding(owner, { operationId: newId(), bindingId, kind: 'flow' });
    const context = syntheticContext({ originNamespace: 'coordinator:fixtures', originKey: `binding:${bindingId}`, ownerId: 'user:alice', scope: 'background', robotOwnerId });
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId }));
    const specification = { version: 2, prompt: 'x', displayText: 'x', permissions: 'full-access', sessionId: 'session-env', turnId: 'turn-env', environment: 'fixtures/env' };
    const admission = store.admit(context, admitRequest(robotId, { specification }, context));
    let opening = null; let aborted = false; let commandExited = false;
    let startupEntered = false; let releaseStartup; let prompts = 0; let ends = 0;
    const dispatcher = createDispatcher({ store, workspaceId: WORKSPACE, workspaceRoot: '/ws',
        factory: { async open({ item, plan, signal, context: adapter }) {
            opening = { item, plan, signal };
            if (deferredStart) {
                const started = new Promise((resolve) => { releaseStartup = resolve; });
                const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
                stdin.on('data', () => { prompts += 1; });
                return {
                    exited: new Promise(() => {}),
                    async start() { startupEntered = true; await started; return { stdin, stdout, stderr }; },
                    async end(outcome) {
                        ends += 1;
                        store.beginAttemptEnd(adapter, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome });
                        for (const stream of [stdin, stdout, stderr]) stream.destroy();
                    },
                };
            }
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    // The real runner resolves only after command close. Dispatch must wait for that cleanup too.
                    setTimeout(() => { commandExited = true; reject(Object.assign(new Error(), { reason: 'environment_unavailable' })); }, 20);
                }, { once: true });
            });
        } }, options: { pollMs: 5, controlPollMs: 5, inactivityTimeoutMs: 1000, maxAttemptMs: 3000, ...timeouts },
    });
    t.after(() => dispatcher.close());
    dispatcher.start();
    return { store, dispatcher, context, admission, get opening() { return opening; }, get aborted() { return aborted; }, get commandExited() { return commandExited; },
        get startupEntered() { return startupEntered; }, releaseStartup: () => releaseStartup?.(), get prompts() { return prompts; }, get ends() { return ends; },
        view: () => store.observeReference(context, { referenceId: admission.reference.id }) };
}

test('stop cancels first-use preparation before any execution exists, preserves flow identity and waits for command exit', async (t) => {
    const h = rig(t);
    await waitFor(() => h.opening);
    assert.equal(h.opening.item.logicalKind, 'flow'); assert.equal(h.opening.plan.environment, 'fixtures/env');
    h.store.controlReference(h.context, { referenceId: h.admission.reference.id, operationId: newId(), op: 'stop' });
    await waitFor(() => h.view().state === 'cancelled');
    assert.equal(h.aborted, true); assert.equal(h.commandExited, true);
    assert.equal(h.view().result.data.reason, 'stopped');
});

test('shutdown aborts a preparation instead of waiting for the pull timeout', async (t) => {
    const h = rig(t); await waitFor(() => h.opening);
    await h.dispatcher.close();
    assert.equal(h.aborted, true); assert.equal(h.commandExited, true);
    assert.equal(h.view().state, 'interrupted'); assert.equal(h.view().result.data.reason, 'worker_shutdown');
});

test('watchdog aborts preparation and retains its deadline reason after the acquisition rejects', async (t) => {
    const h = rig(t, { inactivityTimeoutMs: 35, maxAttemptMs: 3000 });
    await waitFor(() => h.view().state === 'failed');
    assert.equal(h.aborted, true); assert.equal(h.commandExited, true);
    assert.equal(h.view().result.data.reason, 'inactive_timeout');
});

test('stop acknowledged during deferred execution.start ends startup and never delivers a prompt after start resolves', async (t) => {
    const h = rig(t, {}, { deferredStart: true });
    await waitFor(() => h.startupEntered);
    h.store.controlReference(h.context, { referenceId: h.admission.reference.id, operationId: newId(), op: 'stop' });
    await waitFor(() => h.opening.signal.aborted);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const endedDuringStartup = h.ends;
    h.releaseStartup();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const observed = { state: h.view().state, prompts: h.prompts, ends: h.ends, reason: h.view().result?.data?.reason };
    await h.dispatcher.close();
    assert.equal(observed.prompts, 0, 'acknowledged stop cannot be followed by prompt delivery');
    assert.equal(endedDuringStartup, 1, 'startup cancellation invokes the owned execution end without waiting for its success');
    assert.equal(observed.state, 'cancelled'); assert.equal(observed.reason, 'stopped'); assert.equal(observed.ends, 1);
});

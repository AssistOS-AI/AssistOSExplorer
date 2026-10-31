import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createHSessionObserverState, observeHSessionSelection } from './robowork-h-session-observer.mjs';

const scope = { baseURL: 'http://localhost:8080', agent: 'roboTeamAgent', robot: 'h-fixture', directory: '.' };
const oldId = '11111111-1111-4111-8111-111111111111';
const freshId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const request = (overrides = {}) => ({ requestId: 'stream.1', type: 'EventSource', timestamp: 1,
    request: { method: 'GET', url: `${scope.baseURL}/webchat/stream?${new URLSearchParams({ agent: scope.agent, robot: scope.robot, 'workspace-dir': scope.directory, tabId: 'tab-a', pageInstanceId: 'page-a' })}` }, ...overrides });
const message = (state, payload, overrides = {}) => state.message({ requestId: 'stream.1', eventName: 'session-state', timestamp: 2, data: JSON.stringify(payload), ...overrides });
const selected = (id = freshId, extra = {}) => ({ event: 'selected', session: { sessionId: id }, summary: { sessionId: id }, ...extra });
function rig() {
    const state = createHSessionObserverState(scope);
    state.request(request());
    const listMark = state.checkpoint();
    // A root session need not publish an initial skill link for this robot. Its actual connection list still identifies the baseline.
    message(state, { event: 'current', session: { sessionId: oldId }, summary: { sessionId: oldId } });
    message(state, { event: 'list', currentSessionId: oldId, sessions: [] });
    const baseline = state.listAfter(listMark);
    return { state, baseline, newMark: state.checkpoint() };
}

test('targeted connection list then selected event binds a fresh root conversation without an initial UI link', () => {
    const { state, baseline, newMark } = rig();
    assert.equal(baseline.currentSessionId, oldId);
    assert.equal(state.selectedAfter(newMark, baseline), null);
    message(state, selected(freshId, { targetTabId: 'tab-a', targetPageInstanceId: 'page-a' }));
    const fresh = state.selectedAfter(newMark, baseline);
    assert.equal(fresh.sessionId, freshId);
    assert.equal(fresh.previousSessionId, oldId);
    state.assertSelected(fresh);
    message(state, { event: 'updated', session: { sessionId: oldId }, summary: { sessionId: oldId } });
    state.assertSelected(fresh); // A stale update does not select another conversation in the WebChat contract.
});

test('foreign request, event name, tab/page target and agent/robot/workspace streams cannot supply selection evidence', () => {
    const { state, baseline, newMark } = rig();
    message(state, selected(), { requestId: 'other-request' });
    message(state, selected(), { eventName: 'runtime-state' });
    message(state, selected(freshId, { targetTabId: 'another-tab' }));
    message(state, selected(freshId, { targetPageInstanceId: 'another-page' }));
    assert.equal(state.selectedAfter(newMark, baseline), null);
    for (const [key, value] of [['agent', 'another-agent'], ['robot', 'another-robot'], ['workspace-dir', 'another-project']]) {
        const foreign = request(); const url = new URL(foreign.request.url); url.searchParams.set(key, value); foreign.request.url = url.href;
        state.request(foreign);
    }
    const foreignOrigin = request(); foreignOrigin.request.url = foreignOrigin.request.url.replace('localhost', 'foreign.example'); state.request(foreignOrigin);
    message(state, selected()); // Absent targets are valid according to the existing WebChat target filter.
    assert.equal(state.selectedAfter(newMark, baseline).sessionId, freshId);
});

test('missing, ambiguous, redirected, closed and swapped stream bindings fail closed', () => {
    assert.throws(() => createHSessionObserverState(scope).checkpoint());
    for (const overrides of [{ requestId: 'stream.2' }, { redirectResponse: { status: 302 } }]) {
        const { state } = rig(); state.request(request(overrides)); assert.throws(() => state.checkpoint());
    }
    const invalid = request(); const url = new URL(invalid.request.url); url.searchParams.delete('pageInstanceId'); invalid.request.url = url.href;
    const missingPage = createHSessionObserverState(scope); missingPage.request(invalid); assert.throws(() => missingPage.checkpoint());
    const { state, baseline, newMark } = rig();
    assert.throws(() => state.selectedAfter({ ...newMark, requestId: 'swapped-request' }, baseline));
    state.ended({ requestId: 'stream.1' });
    assert.throws(() => state.checkpoint());
});

test('stale, duplicate, invalid, unchanged or swapped selected sessions cannot validate New', () => {
    const stale = rig();
    message(stale.state, selected());
    const afterStale = stale.state.checkpoint();
    // A stale selection also changed the current binding; it cannot be paired with the earlier list baseline.
    assert.throws(() => stale.state.selectedAfter(afterStale, stale.baseline));
    for (const payload of [selected(oldId), selected('not-a-uuid'), selected(freshId, { summary: { sessionId: otherId } })]) {
        const { state, baseline, newMark } = rig(); message(state, payload); assert.throws(() => state.selectedAfter(newMark, baseline));
    }
    const duplicate = rig(); message(duplicate.state, selected()); message(duplicate.state, selected());
    assert.throws(() => duplicate.state.selectedAfter(duplicate.newMark, duplicate.baseline));
    const swapped = rig(); message(swapped.state, selected());
    const binding = swapped.state.selectedAfter(swapped.newMark, swapped.baseline);
    message(swapped.state, { event: 'current', session: { sessionId: otherId }, summary: { sessionId: otherId } });
    assert.throws(() => swapped.state.assertSelected(binding));
    const lists = rig(); message(lists.state, { event: 'list', currentSessionId: oldId });
    assert.throws(() => lists.state.listAfter({ ...lists.newMark, sequence: 0 }));
});

test('observer evidence retains only identities/timing, and malformed own session data remains an actionable failure', () => {
    const { state, baseline, newMark } = rig();
    message(state, selected(freshId, { session: { sessionId: freshId, messages: [{ text: 'PRIVATE_CONTENT_NOT_RETAINED' }] } }));
    state.selectedAfter(newMark, baseline);
    const evidence = JSON.stringify(state.evidence());
    assert.ok(!evidence.includes('PRIVATE_CONTENT_NOT_RETAINED'));
    assert.ok(!evidence.includes('messages'));
    const privatePrefix = 'SYNTHETIC_PRIVATE_EVENT_PREFIX';
    message(state, {}, { data: `${privatePrefix}{invalid-json` });
    for (const inspect of [() => state.checkpoint(), () => state.assertNoFailure()]) assert.throws(inspect, (error) => {
        assert.equal(error.message, 'Invalid H session-state JSON');
        assert.equal(error.code, 'H_SESSION_STATE_INVALID_JSON');
        assert.equal(error.cause, undefined);
        assert.ok(!String(error.stack).includes(privatePrefix));
        return true;
    });
    assert.ok(!JSON.stringify(state.evidence()).includes(privatePrefix));
});

test('fake CDP lifecycle attaches before observation and detaches only its own session, preserving setup failures', async () => {
    const cdp = new EventEmitter(); let detached = 0;
    cdp.send = async (method) => assert.equal(method, 'Network.enable');
    cdp.detach = async () => { detached += 1; };
    const page = { context: () => ({ newCDPSession: async () => cdp }) };
    const observer = await observeHSessionSelection(page, scope);
    cdp.emit('Network.requestWillBeSent', request());
    assert.equal(observer.checkpoint().requestId, 'stream.1');
    await observer.dispose();
    assert.equal(detached, 1);
    assert.equal(cdp.eventNames().length, 0);
    const primary = new Error('Network enable failed');
    cdp.send = async () => { throw primary; };
    await assert.rejects(observeHSessionSelection(page, scope), (error) => error === primary);
    assert.equal(detached, 2);
    assert.equal(cdp.eventNames().length, 0);
    cdp.detach = async () => { throw new Error('detach failed'); };
    await assert.rejects(observeHSessionSelection(page, scope), (error) => error instanceof AggregateError && error.cause === primary);
    assert.equal(cdp.eventNames().length, 0);
});

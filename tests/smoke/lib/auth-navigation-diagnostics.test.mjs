import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { beginAuthNavigationDiagnostics } from './auth-navigation-diagnostics.mjs';
import { attachPageDiagnostics, recordPageNavigationFailure } from './fixtures.mjs';

test('failure snapshots retain request terminals and initiators without credential-bearing protocol payloads', async () => {
    const page = new EventEmitter();
    const session = new EventEmitter();
    session.send = async () => {};
    session.detach = async () => {};
    const unsafeUrl = 'https://url-user:url-password@fixture.invalid/script.js?opaque=unknown-secret#private-fragment';
    const frame = { url: () => unsafeUrl };
    page.context = () => ({ newCDPSession: async () => session });
    page.mainFrame = () => frame;
    page.url = () => unsafeUrl;
    const diagnostics = attachPageDiagnostics(page, {}, 'unit');
    const recorder = await beginAuthNavigationDiagnostics(page, { username: 'short', loginEmail: 'private-login@example.test', password: 'pw' });
    const request = (suffix) => ({
        url: () => `https://fixture.invalid/${suffix}?opaque=unknown-secret`, method: () => 'GET',
        resourceType: () => 'script', isNavigationRequest: () => false,
        frame: () => frame, redirectedFrom: () => null, failure: () => ({ errorText: 'net::ERR_FAILED' }),
    });
    const completed = request('complete.js');
    const failed = request('failed.js');
    const pending = request('pending.js');
    for (const entry of [completed, failed, pending]) page.emit('request', entry);
    page.emit('requestfinished', completed);
    page.emit('requestfailed', failed);
    page.emit('framenavigated', frame);
    page.emit('domcontentloaded');
    session.emit('Network.requestWillBeSent', {
        requestId: '1', frameId: 'frame-1', type: 'Script',
        request: { url: unsafeUrl, method: 'GET', headers: { cookie: 'private-cookie' }, postData: 'private-form-body' },
        initiator: { type: 'script', url: unsafeUrl, lineNumber: 2, stack: {
            callFrames: [{ url: unsafeUrl, functionName: 'private-function-sentinel', lineNumber: 3, columnNumber: 4 }],
        } },
    });
    session.emit('Network.responseReceived', {
        requestId: '1', response: { status: 200, protocol: 'h3', headers: { 'set-cookie': 'private-response-cookie' } },
    });
    session.emit('Network.loadingFailed', { requestId: '1', errorText: 'net::ERR_FAILED' });
    const error = new Error(`navigation to ${unsafeUrl} failed for short pw private-login@example.test private-login%40example.test`);
    const snapshot = recorder.failure(error, 'login-submit-navigation');
    recordPageNavigationFailure(page, snapshot);
    assert.equal(error.navigationDiagnostics, snapshot);
    assert.deepEqual(snapshot.requests.map(({ state }) => state), ['finished', 'failed', 'pending']);
    assert.equal(snapshot.pending.length, 1);
    assert.equal(snapshot.protocolRequests[0].state, 'failed');
    assert.equal(snapshot.protocolRequests[0].protocol, 'h3');
    assert.deepEqual(snapshot.protocolRequests[0].initiator.stack, [{ url: 'https://fixture.invalid/script.js', lineNumber: 3, columnNumber: 4 }]);
    assert.equal(diagnostics.actionableEvents().length, 1, 'navigation metadata does not acknowledge the real failed request');
    const captured = JSON.stringify({ snapshot, message: error.message, stack: error.stack });
    for (const value of ['url-user', 'url-password', 'unknown-secret', 'private-fragment', 'private-cookie', 'private-form-body',
        'private-function-sentinel', 'private-response-cookie', 'short', 'pw', 'private-login@example.test', 'private-login%40example.test']) {
        assert.equal(captured.includes(value), false, value);
    }
    page.emit('requestfinished', pending);
    assert.equal(snapshot.pending[0].state, 'pending', 'snapshot retains failure-time state');
    await recorder.dispose();
    assert.equal(page.listenerCount('request'), 0);
    assert.equal(session.eventNames().length, 0);
    assert.equal(page.listenerCount('requestfailed'), 1, 'the pre-existing diagnostic listener is preserved');
});

test('unavailable CDP is explicit and preserves the Playwright failure evidence', async () => {
    const page = new EventEmitter();
    page.context = () => ({ newCDPSession: async () => { throw new Error('not supported'); } });
    page.url = () => 'about:blank';
    const recorder = await beginAuthNavigationDiagnostics(page, {});
    const snapshot = recorder.failure(new Error('first navigation failure'), 'login-navigation');
    assert.equal(snapshot.protocolAvailable, false);
    assert.equal(snapshot.failure.message, 'first navigation failure');
    assert.deepEqual(snapshot.requests, []);
    await recorder.dispose();
    assert.equal(page.eventNames().length, 0);
});

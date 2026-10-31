import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachPageDiagnostics } from './fixtures.mjs';
import { observeTerminalStream } from './robowork-terminal-stream.mjs';

function fixture() {
    const page = new EventEmitter();
    const frame = {};
    page.mainFrame = () => frame;
    const diagnostics = attachPageDiagnostics(page, {}, 'terminal');
    const observer = observeTerminalStream(page, { id: 'owned', view: 'view', baseURL: 'http://localhost:8080', timeoutMs: 50 });
    const request = {
        url: () => 'http://localhost:8080/webtty/sessions/owned/stream?view=view',
        method: () => 'GET', resourceType: () => 'eventsource', frame: () => frame,
        redirectedFrom: () => null, failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    };
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 200, url: request.url,
        headers: () => ({ 'content-type': 'text/event-stream' }) });
    return { page, diagnostics, observer, request };
}

test('intentional terminal close acknowledges only its exact captured healthy stream abort and retains evidence', async () => {
    const { page, diagnostics, observer, request } = fixture();
    await observer.close(async () => { page.emit('requestfailed', request); });
    assert.deepEqual(diagnostics.actionableEvents(), []);
    assert.equal(diagnostics.events.filter((event) => event.kind === 'requestfailed').length, 1);
});

test('graceful stream finish needs no abort acknowledgement', async () => {
    const { page, diagnostics, observer, request } = fixture();
    await observer.close(async () => { page.emit('requestfinished', request); });
    assert.deepEqual(diagnostics.actionableEvents(), []);
});

test('an abort before intentional close remains a failure while cleanup still executes', async () => {
    const { page, diagnostics, observer, request } = fixture();
    page.emit('requestfailed', request);
    let cleaned = false;
    await assert.rejects(observer.close(async () => { cleaned = true; }), /clean before intentional close/);
    assert.equal(cleaned, true);
    assert.equal(diagnostics.actionableEvents().length, 1);
});

for (const kind of ['wrong method', 'unhealthy response']) {
    test(`terminal close cannot acknowledge ${kind}`, async () => {
        const { page, diagnostics, observer, request } = fixture();
        if (kind === 'wrong method') request.method = () => 'POST';
        else page.emit('response', { request: () => request, status: () => 200, url: request.url,
            headers: () => ({ 'content-type': 'application/json' }) });
        let cleaned = false;
        await assert.rejects(observer.close(async () => { cleaned = true; page.emit('requestfailed', request); }));
        assert.equal(cleaned, true);
        assert.equal(diagnostics.actionableEvents().length, 1);
    });
}

for (const kind of ['foreign', 'duplicate', 'close failure']) {
    test(`terminal close retains ${kind} failures`, async () => {
        const { page, diagnostics, observer, request } = fixture();
        await assert.rejects(observer.close(async () => {
            page.emit('requestfailed', request);
            if (kind === 'foreign') page.emit('requestfailed', { ...request, url: () => 'http://localhost:8080/unrelated' });
            if (kind === 'duplicate') page.emit('requestfailed', request);
            if (kind === 'close failure') throw new Error('close rejected');
        }));
        assert.ok(diagnostics.actionableEvents().length > 0);
    });
}

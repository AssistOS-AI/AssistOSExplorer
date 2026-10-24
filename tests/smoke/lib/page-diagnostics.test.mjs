import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    acknowledgePageNavigationCancellation,
    assertPageDiagnosticsClean,
    attachPageDiagnostics,
    checkpointPageDiagnostics,
    closePageDiagnosticsCheckpoint,
    expectNoUnfilteredBrowserErrors,
    hasPageDiagnostics,
} from './fixtures.mjs';
import {createReleaseGateFailureCollector} from './release-gate-failures.mjs';

test('page cleanliness requires a ledger and rejects any unacknowledged failure without clearing evidence', () => {
    const page = new EventEmitter();
    assert.throws(() => assertPageDiagnosticsClean(page), /no attached diagnostic controller/);
    const first = attachPageDiagnostics(page, {}, 'first');
    const second = attachPageDiagnostics(page, {}, 'second');
    assert.doesNotThrow(() => assertPageDiagnosticsClean(page));
    page.emit('pageerror', new Error('unhandled fixture error'));
    assert.throws(() => assertPageDiagnosticsClean(page), /browser console, page, or network errors/);
    assert.equal(first.actionableEvents().length, 1);
    assert.equal(second.actionableEvents().length, 1);
    assert.throws(() => assertPageDiagnosticsClean(page), /browser console, page, or network errors/);
    assert.equal(first.events.length, 1, 'checking twice must not acknowledge or remove an error');
});

test('strict final browser errors reject a console error ignored by actionable diagnostics', () => {
    const page = new EventEmitter();
    const diagnostics = attachPageDiagnostics(page, {}, 'guest');
    page.emit('console', {
        type: () => 'error',
        text: () => 'source map cleanup error',
        location: () => ({}),
    });
    assert.deepEqual(diagnostics.actionableEvents(), []);
    assert.throws(() => expectNoUnfilteredBrowserErrors(diagnostics, 'guest'), /zero browser errors, including cleanup/);
    assert.equal(diagnostics.events.length, 1);
});

test('final diagnostics retain late close errors and fail the release gate without console filtering', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webmeet-final-diagnostics-'));
    try {
        const page = new EventEmitter();
        const diagnostics = attachPageDiagnostics(page, {
            outputPath: (...parts) => path.join(directory, ...parts),
        }, 'guest');
        const collector = createReleaseGateFailureCollector({env: {}});
        assert.doesNotThrow(() => expectNoUnfilteredBrowserErrors(diagnostics, 'guest'));
        await collector.required('guest context close', async () => {
            await new Promise((resolve) => setImmediate(resolve));
            page.emit('console', {
                type: () => 'error',
                text: () => 'Unknown DataChannel error on lossy',
                location: () => ({}),
            });
            page.emit('pageerror', new Error('late close failure'));
            page.emit('console', {
                type: () => 'error',
                text: () => 'source map cleanup error',
                location: () => ({}),
            });
        });
        await collector.required('guest final diagnostics', () => diagnostics.flush());
        await collector.required('guest zero browser errors', () => expectNoUnfilteredBrowserErrors(diagnostics, 'guest'));
        assert.equal(diagnostics.actionableEvents().length, 2, 'the existing console filter excludes the source map error');
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'diagnostics/guest.browser-events.json'), 'utf8'));
        assert.equal(saved.length, 3, 'all late errors must remain in the final artifact');
        assert.throws(() => collector.throwIfAny({label: 'standalone WebMeet gate'}), /guest zero browser errors/);
        assert.equal(diagnostics.events.length, 3, 'the final assertion must not clear evidence');
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

const GIS = 'https://accounts.google.com/gsi/client';
const gisCancellation = () => Object.freeze({
    signature: Object.freeze({kind: 'requestfailed', type: 'error', url: GIS, method: 'GET', failure: 'net::ERR_ABORTED'}),
    proof: Object.freeze({request: 'Google sign-in script', url: GIS, failure: 'net::ERR_ABORTED', destination: 'http://127.0.0.1/service/'}),
});
const failedRequest = (url, method = 'GET', errorText = 'net::ERR_ABORTED') => ({
    url: () => url, method: () => method, failure: () => ({errorText}),
});

test('fixture wrappers detect attached controllers and close a page checkpoint without clearing strict failures', () => {
    const page = new EventEmitter();
    assert.equal(hasPageDiagnostics(page), false);
    const first = attachPageDiagnostics(page, {}, 'first');
    const second = attachPageDiagnostics(page, {}, 'second');
    assert.equal(hasPageDiagnostics(page), true);
    const checkpoint = checkpointPageDiagnostics(page, 'authentication navigation');
    page.emit('requestfailed', failedRequest(GIS));
    closePageDiagnosticsCheckpoint(page, checkpoint);
    assert.equal(first.actionableEvents().length, 1);
    assert.equal(second.actionableEvents().length, 1);
    assert.throws(() => assertPageDiagnosticsClean(page), /browser console, page, or network errors/);
    assert.throws(() => closePageDiagnosticsCheckpoint(page, checkpoint), /unknown or already consumed/);
    assert.throws(() => closePageDiagnosticsCheckpoint(new EventEmitter(), checkpoint), /does not belong to this page/);
});

test('a proven Google script abort is acknowledged only as the sole checkpoint event and its evidence is retained', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-cancellation-'));
    try {
        const page = new EventEmitter();
        const diagnostics = attachPageDiagnostics(page, {outputPath: (...parts) => path.join(directory, ...parts)}, 'auth');
        const checkpoint = checkpointPageDiagnostics(page, 'authentication navigation');
        page.emit('requestfailed', failedRequest(GIS));
        assert.equal(acknowledgePageNavigationCancellation(page, checkpoint, gisCancellation()), true);
        assert.deepEqual(diagnostics.actionableEvents(), []);
        assert.deepEqual(diagnostics.events.map(({kind}) => kind), ['requestfailed', 'navigationcancellation'], 'the original abort stays in the evidence');
        assert.throws(() => closePageDiagnosticsCheckpoint(page, checkpoint), /unknown or already consumed/, 'acknowledgement consumed the checkpoint');
        assert.throws(() => acknowledgePageNavigationCancellation(page, checkpoint, gisCancellation()), /unknown or already consumed/,
            'a consumed checkpoint cannot be replayed');
        await diagnostics.flush();
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'diagnostics/auth.browser-events.json'), 'utf8'));
        assert.deepEqual(saved.map(({kind}) => kind), ['requestfailed', 'navigationcancellation']);
        assert.equal(saved[1].proof.url, GIS);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('any other checkpoint event or signature refuses the cancellation acknowledgement and leaves everything actionable', async (t) => {
    const extras = {
        'cleanup POST abort': (page) => page.emit('requestfailed', failedRequest('http://127.0.0.1/service/auth/google/cancel', 'POST')),
        'cleanup HTTP 500': (page) => page.emit('response', {status: () => 500, url: () => 'http://127.0.0.1/service/auth/google/cancel', request: () => ({method: () => 'POST'})}),
        'unrelated request': (page) => page.emit('requestfailed', failedRequest('http://127.0.0.1/explorer/app.js')),
        'console error': (page) => page.emit('console', {type: () => 'error', text: () => 'unexpected', location: () => ({})}),
        'page error': (page) => page.emit('pageerror', new Error('unexpected')),
        'duplicate abort': (page) => page.emit('requestfailed', failedRequest(GIS)),
    };
    for (const [name, extra] of Object.entries(extras)) {
        await t.test(name, () => {
            const page = new EventEmitter();
            const diagnostics = attachPageDiagnostics(page, {}, 'auth');
            const checkpoint = checkpointPageDiagnostics(page, 'authentication navigation');
            page.emit('requestfailed', failedRequest(GIS));
            extra(page);
            assert.equal(acknowledgePageNavigationCancellation(page, checkpoint, gisCancellation()), false);
            assert.equal(diagnostics.actionableEvents().length, 2);
            closePageDiagnosticsCheckpoint(page, checkpoint);
            assert.equal(diagnostics.actionableEvents().length, 2);
        });
    }
    const signatures = {
        'query variant': {url: `${GIS}?x=1`},
        'wrong method': {method: 'POST'},
        'non-abort failure': {failure: 'net::ERR_FAILED'},
        'other kind': {kind: 'response'},
    };
    for (const [name, change] of Object.entries(signatures)) {
        await t.test(`signature ${name}`, () => {
            const page = new EventEmitter();
            const diagnostics = attachPageDiagnostics(page, {}, 'auth');
            const checkpoint = checkpointPageDiagnostics(page, 'authentication navigation');
            page.emit('requestfailed', failedRequest(GIS));
            const cancellation = gisCancellation();
            assert.equal(acknowledgePageNavigationCancellation(page, checkpoint, {...cancellation, signature: {...cancellation.signature, ...change}}), false);
            assert.equal(diagnostics.actionableEvents().length, 1);
        });
    }
    await t.test('a different failed request with the exact signature shape is not acknowledged', () => {
        const page = new EventEmitter();
        const diagnostics = attachPageDiagnostics(page, {}, 'auth');
        const checkpoint = checkpointPageDiagnostics(page, 'authentication navigation');
        page.emit('requestfailed', failedRequest(`${GIS}?variant=1`));
        assert.equal(acknowledgePageNavigationCancellation(page, checkpoint, gisCancellation()), false);
        assert.equal(diagnostics.actionableEvents().length, 1);
    });
});

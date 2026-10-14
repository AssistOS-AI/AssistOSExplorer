import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {assertPageDiagnosticsClean, attachPageDiagnostics, expectNoUnfilteredBrowserErrors} from './fixtures.mjs';
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

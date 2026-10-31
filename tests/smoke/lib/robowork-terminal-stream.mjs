import assert from 'node:assert/strict';
import { acknowledgeExactPageDiagnostics, assertPageDiagnosticsClean, checkpointPageDiagnostics, closePageDiagnosticsCheckpoint } from './fixtures.mjs';
import { createRedactor } from './security.mjs';

// Observe from launch: a stream that failed before an intentional close is never a cleanup cancellation.
export function observeTerminalStream(page, { id, view, baseURL, timeoutMs = 10000 }) {
    const expectedURL = new URL(`/webtty/sessions/${id}/stream?view=${view}`, baseURL).href;
    const entries = [];
    const onRequest = (request) => {
        if (request.url() !== expectedURL) return;
        entries.push({ request, response: null, terminal: null, settle: null });
    };
    const onResponse = (response) => {
        const entry = entries.find((value) => value.request === response.request());
        if (entry) entry.response = response;
    };
    const finish = (request, kind) => {
        const entry = entries.find((value) => value.request === request);
        if (!entry) return;
        entry.terminal = { kind, failure: request.failure()?.errorText || '' };
        entry.settle?.(entry.terminal);
    };
    const onFinished = (request) => finish(request, 'finished');
    const onFailed = (request) => finish(request, 'failed');
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    const dispose = () => {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfinished', onFinished);
        page.off('requestfailed', onFailed);
    };
    return {
        dispose,
        async close(action) {
            let checkpoint;
            let timer;
            let consumed = false;
            let actionStarted = false;
            const runAction = () => { actionStarted = true; return action(); };
            try {
                // Even pre-existing failures must not prevent the caller's resource cleanup.
                let precondition;
                try { assertPageDiagnosticsClean(page, 'terminal stream must be clean before intentional close'); }
                catch (error) { precondition = error; }
                const active = entries.filter((entry) => !entry.terminal);
                if (precondition) { await runAction(); throw precondition; }
                assert.ok(active.length <= 1, 'at most one owned terminal stream is active');
                const entry = active[0];
                if (entry) {
                    assert.equal(entry.request.method(), 'GET');
                    assert.equal(entry.request.resourceType(), 'eventsource');
                    assert.equal(entry.request.frame(), page.mainFrame());
                    assert.equal(entry.request.redirectedFrom(), null);
                    assert.equal(entry.response?.status(), 200);
                    assert.match(entry.response.headers()['content-type'], /^text\/event-stream(?:;|$)/iu);
                }
                checkpoint = checkpointPageDiagnostics(page, 'intentional owned terminal close');
                const terminated = entry ? new Promise((resolve, reject) => {
                    entry.settle = resolve;
                    timer = setTimeout(() => reject(new Error('owned terminal stream did not settle after close')), timeoutMs);
                }) : Promise.resolve(null);
                const [, terminal] = await Promise.all([runAction(), terminated]);
                const expected = [];
                if (terminal?.kind === 'failed') {
                    assert.equal(terminal.failure, 'net::ERR_ABORTED');
                    expected.push({ kind: 'requestfailed', type: 'error', url: createRedactor()(expectedURL), method: 'GET', failure: 'net::ERR_ABORTED' });
                }
                acknowledgeExactPageDiagnostics(page, checkpoint, expected);
                consumed = true;
                assertPageDiagnosticsClean(page, 'terminal close must introduce no unrelated browser errors');
            } finally {
                clearTimeout(timer);
                if (checkpoint && !consumed) closePageDiagnosticsCheckpoint(page, checkpoint);
                dispose();
                if (!actionStarted) await runAction();
            }
        },
    };
}

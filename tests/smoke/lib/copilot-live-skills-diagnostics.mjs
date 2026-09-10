import assert from 'node:assert/strict';
import { redactTraceText, findTraceCredentialResidue } from './redacted-trace.mjs';
import { findSecretLeaks } from './security.mjs';

export function liveSkillsDiagnosticText(value) {
    const text = redactTraceText(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    assert.deepEqual(findSecretLeaks(text), [], 'Secrets remained in live-skills diagnostics.');
    assert.deepEqual(findTraceCredentialResidue(text), [], 'Credentials remained in live-skills diagnostics.');
    return text;
}

export function observeLiveSkillsBrowser({ errors, network, now = () => new Date().toISOString() }) {
    const pages = new Map();
    const requests = new WeakMap();
    const completedNoContent = new WeakSet();
    const acknowledgementPaths = new Set(['/dpuAgent/mcp', '/roboTeamAgent/mcp', '/explorer/mcp', '/webchat/input', '/webchat/interaction']);
    let nextRequest = 0;
    function observe(page) {
        if (pages.has(page)) return;
        const pageId = `page-${pages.size + 1}`;
        const requestInfo = request => {
            if (!requests.has(request)) requests.set(request, {
                requestId: `request-${++nextRequest}`, pageId,
                method: request.method(), path: new URL(request.url()).pathname,
            });
            return requests.get(request);
        };
        const record = (kind, data) => JSON.parse(liveSkillsDiagnosticText({ kind, at: now(), pageId, ...data }));
        const onConsole = message => {
            if (message.type() === 'error') errors.push(record('console', { message: message.text() }));
        };
        const onPage = error => errors.push(record('pageerror', { message: error.stack || error.message }));
        const onRequest = request => {
            const info = requestInfo(request);
            // Query strings, bodies and headers are intentionally never collected.
            if (/\/mcp$|^\/webchat\/(input|control|events|interaction)$/.test(info.path)) network.push(record('request', info));
        };
        const onResponse = response => {
            const request = response.request();
            const info = requestInfo(request);
            info.responseStatus = response.status();
            // MCPBrowserClient.sendMessage, WebChat postEnvelope and interaction
            // responses and cancellations leave 204 acknowledgements unread.
            // Chromium can cancel that empty fetch stream after delivering the response. The isolated browser
            // regression proves server completion and this exact event order.
            // Other statuses may have a body whose cancellation is a failure.
            if (info.responseStatus === 204 && info.method === 'POST' && acknowledgementPaths.has(info.path)) {
                try {
                    const headers = response.headers();
                    if (request.resourceType() === 'fetch' && !request.isNavigationRequest()
                        && request.redirectedFrom() === null && !response.fromServiceWorker()
                        && response.url() === request.url()
                        && new URL(request.url()).origin === new URL(page.url()).origin
                        && (headers['content-length'] === undefined || headers['content-length'] === '0')
                        && headers['transfer-encoding'] === undefined) completedNoContent.add(request);
                } catch { /* An incomplete response proof remains an actionable failure. */ }
            }
            if (/\/mcp$|^\/webchat\/(input|control|events|interaction)$/.test(info.path)) network.push(record('response', info));
        };
        const onFailure = request => {
            const info = requestInfo(request), failure = request.failure()?.errorText || 'request failed';
            if (failure === 'net::ERR_ABORTED' && completedNoContent.has(request)) {
                network.push(record('completed-no-content-transport', { ...info, failure }));
                return;
            }
            errors.push(record('requestfailed', { ...info, failure }));
        };
        for (const [event, listener] of Object.entries({ console: onConsole, pageerror: onPage,
            request: onRequest, response: onResponse, requestfailed: onFailure })) page.on(event, listener);
        pages.set(page, () => {
            for (const [event, listener] of Object.entries({ console: onConsole, pageerror: onPage,
                request: onRequest, response: onResponse, requestfailed: onFailure })) page.off(event, listener);
        });
    }
    return { observe, detach() { for (const detach of pages.values()) detach(); } };
}

export async function captureLiveSkillsFailure({ error, evidence, collector, captureRuntime, copilot, testInfo }) {
    evidence.primaryFailure = JSON.parse(liveSkillsDiagnosticText({
        name: error.name || 'Error', message: error.message || String(error), stack: error.stack,
        capturedAt: new Date().toISOString(), phase: evidence.currentPhase,
    }));
    if (captureRuntime) {
        await collector.required('pre-cleanup persisted native diagnostics', async () => {
            evidence.failureRuntime = await captureRuntime();
        });
    }
    if (copilot) {
        await collector.required('pre-cleanup Copilot UI diagnostics', async () => {
            assert.equal(copilot.isClosed(), false, 'Copilot was already closed before failure capture.');
            evidence.failureUI = await copilot.evaluate(() => ({
                path: location.pathname,
                text: document.body.innerText.slice(0, 50_000),
                controls: ['cmd', 'send', 'cancel', 'typingIndicator'].map(id => {
                    const element = document.getElementById(id);
                    return { id, present: Boolean(element), hidden: element?.hidden,
                        ariaHidden: element?.getAttribute('aria-hidden'), disabled: element?.disabled };
                }),
            }));
        });
        await collector.required('pre-cleanup Copilot layout screenshot', async () => {
            assert.equal(copilot.isClosed(), false, 'Copilot was already closed before failure capture.');
            // Text is preserved in the redacted UI record. Pixels retain layout only:
            // a screenshot cannot be checked for arbitrary credential text reliably.
            const body = await copilot.screenshot({ fullPage: true, timeout: 5_000,
                style: '* { color: transparent !important; text-shadow: none !important; background-image: none !important; } input, textarea, [contenteditable], img, svg, canvas, video { visibility: hidden !important; }' });
            await testInfo.attach('copilot-live-skills-failure-layout.png', { body, contentType: 'image/png' });
        });
    }
}

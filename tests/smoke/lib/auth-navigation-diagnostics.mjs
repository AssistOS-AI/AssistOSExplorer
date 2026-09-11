import { collectSecrets, createRedactor } from './security.mjs';
import { redactTraceText } from './redacted-trace.mjs';

// Capture metadata only. In particular, CDP request/response objects must never
// be copied wholesale: they contain authentication headers and form bodies.
export async function beginAuthNavigationDiagnostics(page, account) {
    const redact = createRedactor();
    const privateValues = [account?.username, account?.loginEmail, account?.password, ...collectSecrets().map(({ value }) => value)]
        .filter((value) => typeof value === 'string' && value)
        .flatMap((value) => [value, encodeURIComponent(value)])
        .sort((left, right) => right.length - left.length);
    const hideValues = (value) => {
        let text = String(value || '');
        for (const secret of privateValues) text = text.split(secret).join('[REDACTED:INPUT]');
        return redactTraceText(redact(text));
    };
    const safeUrl = (value) => {
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}[OMITTED]`;
            return hideValues(`${url.origin}${url.pathname}`);
        } catch {
            return '[OMITTED:URL]';
        }
    };
    const safeText = (value) => hideValues(String(value || '')
        .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, safeUrl));
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const requests = [];
    const requestRows = new Map();
    const protocolRequests = [];
    const protocolRows = new Map();
    const lifecycle = [];
    const listeners = [];
    const limit = 2_000;
    let omitted = 0;
    let session;
    let protocolAvailable = false;
    const append = (rows, entry) => {
        if (rows.length >= limit) { omitted += 1; return false; }
        rows.push(entry);
        return true;
    };
    const on = (target, event, listener) => {
        target.on(event, listener);
        listeners.push(() => target.off(event, listener));
    };
    on(page, 'request', (request) => {
        let mainFrame = false;
        try { mainFrame = request.frame() === page.mainFrame(); } catch { /* Service worker request. */ }
        const row = {
            id: requests.length + 1, url: safeUrl(request.url()), method: request.method(),
            resourceType: request.resourceType(), mainFrame,
            navigation: request.isNavigationRequest(), startedMs: elapsed(), state: 'pending',
            redirectedFrom: requestRows.get(request.redirectedFrom())?.id || null,
        };
        if (append(requests, row)) requestRows.set(request, row);
    });
    on(page, 'response', (response) => {
        const row = requestRows.get(response.request());
        if (row) { row.status = response.status(); row.responseMs = elapsed(); }
    });
    for (const [event, state] of [['requestfinished', 'finished'], ['requestfailed', 'failed']]) {
        on(page, event, (request) => {
            const row = requestRows.get(request);
            if (!row) return;
            Object.assign(row, { state, endedMs: elapsed() });
            if (state === 'failed') row.failure = safeText(request.failure()?.errorText);
        });
    }
    on(page, 'framenavigated', (frame) => {
        append(lifecycle, { event: 'framenavigated', mainFrame: frame === page.mainFrame(), url: safeUrl(frame.url()), atMs: elapsed() });
    });
    for (const event of ['domcontentloaded', 'load', 'close', 'crash']) {
        on(page, event, () => append(lifecycle, { event, mainFrame: true, atMs: elapsed() }));
    }
    try {
        session = await page.context().newCDPSession(page);
        on(session, 'Network.requestWillBeSent', (event) => {
            const previous = protocolRows.get(event.requestId);
            if (previous && event.redirectResponse) {
                Object.assign(previous, { state: 'redirected', endedMs: elapsed(), status: event.redirectResponse.status });
            }
            const row = {
                id: event.requestId, url: safeUrl(event.request.url), method: event.request.method,
                resourceType: event.type, frameId: event.frameId, startedMs: elapsed(), state: 'pending',
                initiator: {
                    type: event.initiator?.type,
                    ...(event.initiator?.url ? { url: safeUrl(event.initiator.url) } : {}),
                    ...(Number.isFinite(event.initiator?.lineNumber) ? { lineNumber: event.initiator.lineNumber } : {}),
                    stack: (event.initiator?.stack?.callFrames || []).slice(0, 12).map((frame) => ({
                        url: safeUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber,
                    })),
                },
            };
            if (append(protocolRequests, row)) protocolRows.set(event.requestId, row);
        });
        on(session, 'Network.responseReceived', (event) => {
            const row = protocolRows.get(event.requestId);
            if (row) Object.assign(row, { status: event.response.status, protocol: event.response.protocol, responseMs: elapsed() });
        });
        for (const [event, state] of [['Network.loadingFinished', 'finished'], ['Network.loadingFailed', 'failed']]) {
            on(session, event, (data) => {
                const row = protocolRows.get(data.requestId);
                if (!row) return;
                Object.assign(row, { state, endedMs: elapsed() });
                if (state === 'failed') row.failure = safeText(data.errorText);
            });
        }
        on(session, 'Page.lifecycleEvent', (event) => {
            append(lifecycle, { event: event.name, frameId: event.frameId, atMs: elapsed() });
        });
        await session.send('Network.enable');
        await session.send('Page.enable');
        await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
        protocolAvailable = true;
    } catch {
        // Non-Chromium/closed pages still retain the Playwright request ledger.
    }
    return {
        failure(error, stage) {
            const failure = { name: safeText(error?.name), message: safeText(error?.message || error) };
            const snapshot = JSON.parse(JSON.stringify({
                stage, capturedAt: new Date().toISOString(), elapsedMs: elapsed(), url: safeUrl(page.url()),
                failure, protocolAvailable, omitted, requests, protocolRequests, lifecycle,
                pending: requests.filter(({ state }) => state === 'pending'),
                protocolPending: protocolRequests.filter(({ state }) => state === 'pending'),
            }));
            // Keep the first exception and its original stack, sanitized before
            // reporters can persist either. No second navigation wait occurs.
            if (error instanceof Error) {
                error.message = failure.message;
                if (error.stack) error.stack = safeText(error.stack);
                error.navigationDiagnostics = snapshot;
            }
            return snapshot;
        },
        async dispose() {
            for (const remove of listeners) remove();
            await session?.detach().catch(() => {});
        },
    };
}

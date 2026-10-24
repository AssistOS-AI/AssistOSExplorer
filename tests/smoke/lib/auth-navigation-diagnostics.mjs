import { collectSecrets, createRedactor } from './security.mjs';
import { redactTraceText } from './redacted-trace.mjs';

// The only request whose navigation abort a sign-in may prove expected: the
// Google sign-in script that the UserPersisto wizard loads on its own page.
export const GOOGLE_SIGN_IN_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const ABORTED = 'net::ERR_ABORTED';
const TERMINAL_POLL_MS = 25;

function parsedUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}
// Any variant of the script address (scheme, port, query or fragment).
function googleScriptLike(value) {
  const url = parsedUrl(value);
  return Boolean(url && url.hostname === 'accounts.google.com' && url.pathname === '/gsi/client');
}
function withoutFragment(url) {
  return `${url.origin}${url.pathname}${url.search}`;
}

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
    // Exact addresses and identities, kept in memory only to decide a
    // navigation-cancellation proof. Snapshots never copy them.
    const rawRequests = new Map();
    const rawProtocol = new Map();
    const rawLoads = [];
    let binding = null;
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
        if (rawRequests.size >= limit) { omitted += 1; return; }
        let redirected = true;
        try { redirected = request.redirectedFrom() !== null; } catch { /* Unknown provenance. */ }
        rawRequests.set(request, {
            url: request.url(), method: request.method(), resourceType: request.resourceType(),
            navigation: request.isNavigationRequest(), mainFrame, redirected, state: 'pending', failure: '',
        });
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
            const raw = rawRequests.get(request);
            if (raw) {
                raw.state = state;
                if (state === 'failed') raw.failure = String(request.failure()?.errorText || '');
                try { if (request.redirectedTo()) raw.redirected = true; } catch { raw.redirected = true; }
            }
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
            const raw = rawProtocol.get(event.requestId);
            if (raw && event.redirectResponse) {
                raw.urls.push(event.request.url);
                raw.statuses.push(event.redirectResponse.status);
            } else if (rawProtocol.size >= limit) {
                omitted += 1;
            } else {
                rawProtocol.set(event.requestId, {
                    urls: [event.request.url], statuses: [], method: event.request.method, type: event.type,
                    frameId: event.frameId, loaderId: event.loaderId, startedAt: event.timestamp, redirected: Boolean(event.redirectResponse),
                    state: 'pending', status: undefined, endedAt: undefined, errorText: '',
                });
            }
        });
        on(session, 'Network.responseReceived', (event) => {
            const row = protocolRows.get(event.requestId);
            if (row) Object.assign(row, { status: event.response.status, protocol: event.response.protocol, responseMs: elapsed() });
            const raw = rawProtocol.get(event.requestId);
            if (raw) raw.status = event.response.status;
        });
        for (const [event, state] of [['Network.loadingFinished', 'finished'], ['Network.loadingFailed', 'failed']]) {
            on(session, event, (data) => {
                const row = protocolRows.get(data.requestId);
                if (!row) return;
                Object.assign(row, { state, endedMs: elapsed() });
                if (state === 'failed') row.failure = safeText(data.errorText);
                const raw = rawProtocol.get(data.requestId);
                if (raw && raw.state === 'pending') {
                    Object.assign(raw, { state, endedAt: data.timestamp, errorText: String(data.errorText || '') });
                }
            });
        }
        on(session, 'Page.lifecycleEvent', (event) => {
            append(lifecycle, { event: event.name, frameId: event.frameId, atMs: elapsed() });
            if (event.name !== 'load') return;
            if (rawLoads.length >= limit) omitted += 1;
            else rawLoads.push({ frameId: event.frameId, loaderId: event.loaderId, at: event.timestamp });
        });
        await session.send('Network.enable');
        await session.send('Page.enable');
        await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
        protocolAvailable = true;
    } catch {
        // Non-Chromium/closed pages still retain the Playwright request ledger.
    }
    // The main-frame document request of one loader: its address chain from
    // the first request to the last redirect.
    const documentOf = (frameId, loaderId) => [...rawProtocol.values()]
        .filter((entry) => entry.type === 'Document' && entry.frameId === frameId && entry.loaderId === loaderId);

    async function terminalGoogleScript(deadline) {
        while (true) {
            const protocolEntries = [...rawProtocol.values()].filter((entry) => entry.urls.some(googleScriptLike));
            const playwrightEntries = [...rawRequests.values()].filter((entry) => googleScriptLike(entry.url));
            if (protocolEntries.every((entry) => entry.state !== 'pending')
                && playwrightEntries.every((entry) => entry.state !== 'pending')) {
                return { protocolEntries, playwrightEntries };
            }
            if (Date.now() >= deadline) return null;
            await new Promise((resolve) => setTimeout(resolve, Math.min(TERMINAL_POLL_MS, Math.max(1, deadline - Date.now()))));
        }
    }

    async function proveBoundPasswordNavigation({ expectedOrigin, returnTo, timeoutMs }) {
        const bound = binding;
        if (!protocolAvailable || !bound || bound.origin !== expectedOrigin) return null;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return null;
        let destination = null;
        try { destination = new URL(String(returnTo || '/'), expectedOrigin); } catch { return null; }
        if (destination.origin !== expectedOrigin) return null;
        const settled = await terminalGoogleScript(Date.now() + timeoutMs);
        if (!settled || omitted) return null;
        const { protocolEntries, playwrightEntries } = settled;
        if (protocolEntries.length !== 1 || playwrightEntries.length !== 1) return null;
        const [script] = protocolEntries;
        const [observed] = playwrightEntries;
        if (script.urls.length !== 1 || script.urls[0] !== GOOGLE_SIGN_IN_SCRIPT_URL || script.redirected
            || script.method !== 'GET' || script.type !== 'Script'
            || script.frameId !== bound.frameId || script.loaderId !== bound.loaderId
            || script.state !== 'failed' || script.errorText !== ABORTED || script.status !== undefined) return null;
        if (observed.url !== GOOGLE_SIGN_IN_SCRIPT_URL || observed.method !== 'GET' || observed.resourceType !== 'script'
            || observed.navigation || !observed.mainFrame || observed.redirected
            || observed.state !== 'failed' || observed.failure !== ABORTED) return null;
        // The bound document's password submission succeeded.
        const loginUrl = `${expectedOrigin}${bound.pathname}password/login`;
        const logins = [...rawProtocol.values()].filter((entry) => entry.urls.some((url) => {
            const parsed = parsedUrl(url);
            return parsed && `${parsed.origin}${parsed.pathname}` === loginUrl;
        }));
        if (logins.length !== 1) return null;
        const [login] = logins;
        if (login.urls.length !== 1 || login.urls[0] !== loginUrl || login.method !== 'POST'
            || login.frameId !== bound.frameId || login.loaderId !== bound.loaderId
            || login.state !== 'finished' || login.status !== 200) return null;
        // The only later main-frame document: the callback, then the destination.
        const later = [...rawProtocol.values()].filter((entry) => entry.type === 'Document'
            && entry.frameId === bound.frameId && entry.startedAt > bound.startedAt);
        if (later.length !== 1) return null;
        const [handoff] = later;
        const hops = handoff.urls.map(parsedUrl);
        if (handoff.loaderId === bound.loaderId || hops.length < 2 || hops.some((hop) => !hop || hop.origin !== expectedOrigin)
            || hops[0].pathname !== '/auth/callback' || withoutFragment(hops[1]) !== withoutFragment(destination)
            || handoff.state !== 'finished' || handoff.status !== 200) return null;
        const shown = parsedUrl(page.url());
        if (!shown || withoutFragment(shown) !== withoutFragment(hops.at(-1))) return null;
        const loaded = rawLoads.find((entry) => entry.frameId === bound.frameId && entry.loaderId === handoff.loaderId);
        if (!loaded) return null;
        // The script was pending until the handoff navigation began and was
        // aborted by it, before the destination finished loading.
        if (!(script.startedAt < handoff.startedAt && login.endedAt <= handoff.startedAt
            && handoff.startedAt <= script.endedAt && script.endedAt <= loaded.at)) return null;
        const relative = (time) => Math.round((time - handoff.startedAt) * 1000);
        return Object.freeze({
            signature: Object.freeze({ kind: 'requestfailed', type: 'error', url: GOOGLE_SIGN_IN_SCRIPT_URL, method: 'GET', failure: ABORTED }),
            proof: Object.freeze({
                request: 'Google sign-in script', url: GOOGLE_SIGN_IN_SCRIPT_URL, method: 'GET', resourceType: 'script', failure: ABORTED,
                document: 'bound UserPersisto wizard main frame', passwordStatus: 200,
                callback: '/auth/callback', destination: safeUrl(hops.at(-1).href),
                timingMs: Object.freeze({ scriptStarted: relative(script.startedAt), passwordFinished: relative(login.endedAt),
                    handoffStarted: 0, scriptAborted: relative(script.endedAt), destinationLoaded: relative(loaded.at) }),
            }),
        });
    }

    return {
        // Binds the current main-frame document, which must be at exactly
        // `pathname` on `expectedOrigin` with a recorded document request.
        // Without that identity there is no binding and so no later proof.
        async bindWizardDocument({ expectedOrigin, pathname }) {
            binding = null;
            if (!protocolAvailable) return false;
            try {
                const frame = (await session.send('Page.getFrameTree'))?.frameTree?.frame;
                if (!frame || frame.parentId || typeof frame.id !== 'string' || !frame.id
                    || typeof frame.loaderId !== 'string' || !frame.loaderId) return false;
                const framed = parsedUrl(frame.url);
                const shown = parsedUrl(page.url());
                if (!framed || !shown || framed.href !== shown.href
                    || framed.origin !== expectedOrigin || framed.pathname !== pathname) return false;
                const documents = documentOf(frame.id, frame.loaderId);
                if (documents.length !== 1) return false;
                const final = parsedUrl(documents[0].urls.at(-1));
                if (!final || final.origin !== expectedOrigin || final.pathname !== pathname) return false;
                binding = Object.freeze({ frameId: frame.id, loaderId: frame.loaderId, pathname, origin: expectedOrigin,
                    startedAt: documents[0].startedAt });
                return true;
            } catch {
                return false;
            }
        },
        // Returns null, or one immutable proof that the bound wizard's only
        // request for the Google sign-in script was still pending when that
        // document's successful password handoff navigated to the expected
        // callback and destination, and was aborted by that navigation. Call
        // only after the authenticated principal is verified. It performs no
        // navigation and reads no page content, credential or body.
        async provePasswordNavigation(options) {
            try {
                return await proveBoundPasswordNavigation(options);
            } catch {
                return null;
            }
        },
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

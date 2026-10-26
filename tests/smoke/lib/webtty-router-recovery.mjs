import { isDeepStrictEqual } from 'node:util';

import { diagnosticEventSignature } from './diagnostic-ledger.mjs';

function authenticationCookie(cookies) {
    const selected = (cookies || []).filter((cookie) => ['ploinky_sso', 'ploinky_jwt'].includes(cookie.name));
    if (selected.length !== 1 || typeof selected[0].value !== 'string'
        || !/^[^\x00-\x20;,\x7f]+$/.test(selected[0].value)) {
        throw new Error('Router recovery requires exactly one authenticated SSO or local session cookie.');
    }
    return { name: selected[0].name, value: selected[0].value };
}

function requireSameAdministrator(principal, expectedId) {
    if (!principal || typeof principal.id !== 'string' || !principal.id
        || principal.id !== expectedId || !principal.roles?.includes('admin')) {
        throw new Error('Router recovery must retain the same authenticated administrator.');
    }
}

export function recoveryConsoleText(mode) {
    if (!['sso', 'local'].includes(mode)) throw new Error('Unproven Router authentication mode.');
    return `Failed to load resource: the server responded with a status of ${mode === 'sso' ? '401 (Unauthorized)' : '404 (Not Found)'}`;
}

const VIEW_ID = /^[A-Za-z0-9_-]{32,128}$/;

// A terminal stream is bound to the server-issued view of its create or attach response.
export function expectedRouterRecoveryDiagnostics(baseURL, sessionId, mode, viewId) {
    const text = recoveryConsoleText(mode);
    if (typeof viewId !== 'string' || !VIEW_ID.test(viewId)) throw new Error('Router recovery requires the terminal view identifier.');
    const url = new URL(`/webtty/sessions/${encodeURIComponent(sessionId)}/stream?view=${encodeURIComponent(viewId)}`, baseURL).toString();
    return [
        diagnosticEventSignature({ kind: 'requestfailed', type: 'error', url, method: 'GET', failure: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' }),
        diagnosticEventSignature({ kind: 'console', type: 'error', text: 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING', location: { url } }),
        diagnosticEventSignature({ kind: 'response', type: 'error', status: mode === 'sso' ? 401 : 404, url, method: 'GET' }),
        diagnosticEventSignature({ kind: 'console', type: 'error', text, location: { url } }),
    ];
}

// Session values stay in this closure, never in evidence or assertion operands.
// Node fetch has no browser cookie jar, so an expired-cookie response cannot
// clear or replace the browser's credential during the crash proof.
export function captureRouterRecoveryAuthentication({ baseURL, cookies, principal, timeoutMs = 20_000, fetchImpl = fetch }) {
    const origin = new URL(baseURL);
    if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('Router recovery requires the selected loopback HTTP origin.');
    }
    const prior = authenticationCookie(cookies);
    const expectedId = principal?.id;
    requireSameAdministrator(principal, expectedId);
    const mode = prior.name === 'ploinky_sso' ? 'sso' : 'local';
    let priorAuthenticationProved = false;
    let completed = false;
    async function probe(pathname, cookie, accept = 'application/json') {
        const target = new URL(pathname, origin);
        if (target.origin !== origin.origin) throw new Error('Router recovery probe left the selected origin.');
        let response;
        try {
            response = await fetchImpl(target, {
                method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
                headers: { Accept: accept, Cookie: `${cookie.name}=${cookie.value}`, Connection: 'close' },
            });
        } catch (_) {
            throw new Error('Router recovery authentication probe could not complete.');
        }
        if (response.redirected || response.status >= 300 && response.status < 400
            || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
            throw new Error('Router recovery probe must return JSON without redirects.');
        }
        const payload = await response.json().catch(() => null);
        return { status: response.status, payload };
    }
    // One bounded normal HTTP request to the exact retired stream with the captured prior credential, isolated from the
    // browser cookie jar. It validates this route's own response body; it is not evidence about the bodies of the
    // browser's EventSource attempts, which are never readable.
    async function probeRetired(streamPath) {
        const result = await probe(streamPath, prior, 'text/event-stream');
        const expected = mode === 'sso'
            ? { status: 401, payload: { ok: false, error: 'not_authenticated', login: `/auth/login?${new URLSearchParams({ returnTo: streamPath })}` } }
            : { status: 404, payload: { ok: false, error: 'not_found' } };
        if (result.status !== expected.status || !isDeepStrictEqual(result.payload, expected.payload)) {
            throw new Error('The retired stream route must refuse the prior credential with its exact body.');
        }
        return Object.freeze({ status: result.status, bodyValid: true });
    }
    return Object.freeze({
        mode,
        probeRetiredStream: probeRetired,
        async proveRestartedAuthentication() {
            const result = await probe('/auth/token', prior);
            if (mode === 'sso') {
                if (result.status !== 401 || !isDeepStrictEqual(result.payload, { ok: false, error: 'session_expired' })) {
                    throw new Error('The prior SSO session must expire after Router restart.');
                }
            } else {
                if (result.status !== 200) throw new Error('The local JWT session must survive Router restart.');
                requireSameAdministrator(result.payload?.user, expectedId);
            }
            priorAuthenticationProved = true;
        },
        // Backend cleanup is verified first. Only then is the producer stopped through the client's own pagehide
        // lifecycle, and only after that is the terminal closed and the session renewed.
        async recoverAfterCleanup({ verifyCleanup, stopProducer, closeTerminal, signIn, readCookies, streamPath }) {
            if (!priorAuthenticationProved || completed) throw new Error('Router recovery authentication transition is out of order.');
            if (!/^\/webtty\/sessions\/[A-Za-z0-9_-]+\/stream\?view=[A-Za-z0-9_-]{32,128}$/.test(streamPath)) {
                throw new Error('Router recovery requires the exact prior terminal stream path with its view.');
            }
            if (typeof stopProducer !== 'function') throw new Error('Router recovery requires the lifecycle stop of the recovery producer.');
            await verifyCleanup();
            await probeRetired(streamPath);
            await stopProducer();
            await closeTerminal();
            let current = prior;
            if (mode === 'sso') {
                const authenticated = await signIn();
                requireSameAdministrator(authenticated, expectedId);
                current = authenticationCookie(await readCookies());
                const replaced = current.name === 'ploinky_sso' && current.value !== prior.value;
                if (!replaced) throw new Error('Router recovery requires a newly issued SSO session.');
            }
            const result = await probe(streamPath, current);
            if (result.status !== 404 || !isDeepStrictEqual(result.payload, { ok: false, error: 'not_found' })) {
                throw new Error('The prior terminal stream must remain absent after authenticated recovery.');
            }
            completed = true;
            return Object.freeze({ mode, priorAuthenticationStatus: mode === 'sso' ? 401 : 200,
                renewedSsoSession: mode === 'sso', authenticatedOldStreamStatus: 404 });
        },
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// Independent observation of the recovery terminal.
//
// The retried EventSource requests of an unchanged client cannot be counted from the diagnostic ledger itself, so the
// expected diagnostic set is derived from independently validated request and native records. Exact view URLs, opaque
// session ids and nested returnTo values stay in memory; errors and persisted projections carry aliases, classes,
// statuses, failures and relative timing only.

export class RouterRecoveryProofError extends Error {
    constructor(stage, classification) {
        super(`Router recovery proof failed at ${stage}: ${classification}.`);
        this.name = 'RouterRecoveryProofError';
        this.stage = stage;
        this.classification = classification;
    }
}

const need = (condition, stage, classification) => {
    if (!condition) throw new RouterRecoveryProofError(stage, classification);
};
const INCOMPLETE_CHUNKED = 'net::ERR_INCOMPLETE_CHUNKED_ENCODING';
const ABORTED = 'net::ERR_ABORTED';
const JSON_TYPE = /^application\/json(?:;|$)/i;
// Wall-clock milliseconds; a raw monotonic value or zero can never be mistaken for one.
const isWallTime = (value) => Number.isFinite(value) && value > 1e12;

// Runs in the terminal document before it loads. It delegates construction to the native EventSource unchanged and only
// adds listeners; it intercepts no fetch, timer, close or retry. Other documents are left untouched.
export function installEventSourceObserver() {
    if (globalThis.location?.pathname !== '/webtty/') return;
    const Native = window.EventSource;
    const events = [];
    let next = 0;
    const now = () => performance.timeOrigin + performance.now();
    const Observer = new Proxy(Native, {
        construct(target, args, newTarget) {
            const source = Reflect.construct(target, args, newTarget);
            const id = ++next;
            events.push({ kind: 'construct', id, at: now(), url: source.url, instance: source instanceof Native, constructorPreserved: source.constructor === Native });
            for (const type of ['open', 'error']) {
                source.addEventListener(type, () => events.push({ kind: type, id, at: now(), url: source.url, readyState: source.readyState }));
            }
            return source;
        },
    });
    window.EventSource = Observer;
    window.__routerRecoveryNative = {
        events,
        compatible: Observer.prototype === Native.prototype && Observer.CONNECTING === Native.CONNECTING
            && Observer.OPEN === Native.OPEN && Observer.CLOSED === Native.CLOSED && Observer.name === Native.name
            && Observer.length === Native.length && Object.getPrototypeOf(Observer) === Object.getPrototypeOf(Native),
    };
    window.addEventListener('pagehide', (event) => events.push({ kind: 'pagehide', at: now(), trusted: event.isTrusted }));
}

// Pure validation of the recorded observation. `raw` holds only independently recorded facts (no URLs): the document
// binding, the Playwright and CDP request sets, the native EventSource events and the lifecycle-stop record.
export function validateRouterRecoveryObservation(raw, { baseURL, sessionId, viewId, mode }) {
    const consoleText = recoveryConsoleText(mode);
    const expectedStatus = mode === 'sso' ? 401 : 404;
    if (typeof viewId !== 'string' || !VIEW_ID.test(viewId)) throw new Error('Router recovery requires the terminal view identifier.');
    const streamUrl = new URL(`/webtty/sessions/${encodeURIComponent(sessionId)}/stream?view=${encodeURIComponent(viewId)}`, baseURL).toString();
    const intentUrl = new URL(`/webtty/sessions/${encodeURIComponent(sessionId)}/close-intents`, baseURL).toString();
    const { binding, stop, native } = raw;
    need(binding?.frameId && binding?.loaderId, 'binding', 'identity-missing');
    need(binding.navigations === 0, 'binding', 'document-changed');
    need(stop && isWallTime(stop.before) && isWallTime(stop.after) && stop.before <= stop.after, 'stop', 'timing-missing');
    need(stop.status === 'Disconnected' && stop.killDisabled === true, 'stop', 'not-stopped');
    need(native?.compatible === true && Array.isArray(native.events), 'native', 'incompatible');
    const constructs = native.events.filter((event) => event.kind === 'construct');
    need(constructs.length >= 1 && constructs.every((event) => event.instance === true && event.constructorPreserved === true && event.exactUrl === true), 'native', 'construction');
    need(new Set([...raw.playwright, ...raw.cdp].map((record) => record.id)).size === raw.playwright.length + raw.cdp.length, 'identity', 'duplicate');
    need(raw.orphans === 0, 'identity', 'orphan-terminal');
    const pwStreams = raw.playwright.filter((record) => record.role === 'stream');
    const cdpStreams = raw.cdp.filter((record) => record.role === 'stream');
    need(pwStreams.length === cdpStreams.length, 'join', 'incomplete');
    need(pwStreams.length >= 2, 'join', 'no-retry');
    const checkJoined = (record, cdp, method, resourceType) => {
        need(record.frameMain === true && record.pageOwned === true, 'ownership', 'foreign-frame');
        need(cdp.frame === binding.frameId && cdp.document === binding.loaderId, 'ownership', 'foreign-document');
        need(record.method === method && cdp.method === method, 'join', 'method');
        need(record.resourceType === resourceType && String(cdp.type).toLowerCase() === resourceType, 'join', 'resource-type');
        need(record.redirect === false && cdp.redirect === false, 'join', 'redirect');
        need(isWallTime(cdp.at) && cdp.terminals.length === 1 && isWallTime(cdp.terminals[0].at), 'join', 'timing');
        need(cdp.terminals[0].at >= cdp.at, 'join', 'terminal-before-start');
        need((cdp.responseStatus ?? null) === record.status, 'join', 'status-mismatch');
        need((cdp.terminals[0].failure ?? null) === record.failure, 'join', 'failure-mismatch');
    };
    pwStreams.forEach((record, index) => {
        checkJoined(record, cdpStreams[index], 'GET', 'eventsource');
        if (index > 0) need(cdpStreams[index - 1].terminals[0].at < cdpStreams[index].at, 'join', 'overlapping');
    });
    const [original, ...attempts] = pwStreams;
    need(original.status === 200 && original.failure === INCOMPLETE_CHUNKED && cdpStreams[0].terminals[0].failure === INCOMPLETE_CHUNKED, 'original', 'interruption');
    const nativeErrors = native.events.filter((event) => event.kind === 'error' && event.readyState === 2);
    const signatures = [
        diagnosticEventSignature({ kind: 'requestfailed', type: 'error', url: streamUrl, method: 'GET', failure: INCOMPLETE_CHUNKED }),
        diagnosticEventSignature({ kind: 'console', type: 'error', text: `Failed to load resource: ${INCOMPLETE_CHUNKED}`, location: { url: streamUrl } }),
    ];
    const outcomes = ['original-interrupted'];
    let refusals = 0;
    let refusalAborts = 0;
    let stopCancellations = 0;
    const usedNative = new Set();
    attempts.forEach((record, offset) => {
        const index = offset + 1;
        const cdp = cdpStreams[index];
        need(cdp.at <= stop.before, 'stop', 'retry-after-stop');
        const windowEnd = cdpStreams[index + 1]?.at ?? stop.before;
        if (record.status !== null) {
            need(record.status === expectedStatus, 'refusal', 'wrong-status');
            need(JSON_TYPE.test(record.contentType || ''), 'refusal', 'content-type');
            const matches = nativeErrors.filter((event) => event.at >= cdp.at && event.at <= windowEnd);
            need(matches.length === 1 && !usedNative.has(matches[0].id), 'refusal', 'native-correlation');
            usedNative.add(matches[0].id);
            refusals += 1;
            signatures.push(
                diagnosticEventSignature({ kind: 'response', type: 'error', status: record.status, url: streamUrl, method: 'GET' }),
                diagnosticEventSignature({ kind: 'console', type: 'error', text: consoleText, location: { url: streamUrl } }),
            );
            if (record.failure !== null) {
                need(record.failure === ABORTED, 'refusal', 'wrong-failure');
                refusalAborts += 1;
                signatures.push(diagnosticEventSignature({ kind: 'requestfailed', type: 'error', url: streamUrl, method: 'GET', failure: ABORTED }));
                outcomes.push('refusal-native-closed-abort');
            } else {
                outcomes.push('refusal-native-closed');
            }
            return;
        }
        // A headerless request: only the one owned in-flight stream cancelled by the observed lifecycle stop.
        need(index === pwStreams.length - 1 && stopCancellations === 0, 'stop', 'unexplained-headerless-request');
        need(record.failure === ABORTED && cdp.terminals[0].at >= stop.before, 'stop', 'cancellation-before-stop');
        stopCancellations += 1;
        signatures.push(diagnosticEventSignature({ kind: 'requestfailed', type: 'error', url: streamUrl, method: 'GET', failure: ABORTED }));
        outcomes.push('headerless-stop-cancellation');
    });
    need(refusals >= 1, 'refusal', 'none-observed');
    need(nativeErrors.length === refusals, 'native', 'unexplained-error');
    const intents = raw.playwright.filter((record) => record.role === 'intent');
    const cdpIntents = raw.cdp.filter((record) => record.role === 'intent');
    need(intents.length === 1 && cdpIntents.length === 1, 'intent', 'count');
    const [intent] = intents;
    checkJoined(intent, cdpIntents[0], 'POST', 'fetch');
    need(cdpIntents[0].at >= stop.before && cdpIntents[0].terminals[0].kind === 'finished', 'intent', 'order');
    need(intent.correctBody === true && intent.failure === null && intent.status === expectedStatus && JSON_TYPE.test(intent.contentType || ''), 'intent', 'response');
    need(intent.bodyValid === true, 'intent', 'body');
    signatures.push(
        diagnosticEventSignature({ kind: 'response', type: 'error', status: intent.status, url: intentUrl, method: 'POST' }),
        diagnosticEventSignature({ kind: 'console', type: 'error', text: consoleText, location: { url: intentUrl } }),
    );
    return { signatures, summary: { streamAttempts: pwStreams.length, refusals, refusalAborts, stopCancellations, closeIntents: 1, outcomes } };
}

// The persisted view of an observation: aliases, classes, statuses, failures and times relative to the lifecycle stop.
export function projectRouterRecoveryObservation(raw, { validation = null, failure = null, milestones = {}, cleanup = null } = {}) {
    const stopAt = raw?.stop?.before;
    const relative = (value) => (Number.isFinite(value) && Number.isFinite(stopAt) ? Math.round(value - stopAt) : null);
    const requests = [];
    for (const role of ['stream', 'intent']) {
        const playwright = (raw?.playwright || []).filter((record) => record.role === role);
        const cdp = (raw?.cdp || []).filter((record) => record.role === role);
        playwright.forEach((record, index) => requests.push({
            alias: `${role === 'stream' ? 's' : 'i'}${index + 1}`,
            role,
            method: record.method,
            resourceType: record.resourceType,
            mainFrameOfBoundPage: record.frameMain === true && record.pageOwned === true,
            status: record.status,
            failure: record.failure,
            startMs: relative(cdp[index]?.at),
            terminalMs: relative(cdp[index]?.terminals?.[0]?.at),
            terminal: cdp[index]?.terminals?.[0]?.kind || null,
        }));
    }
    return {
        version: 1,
        mode: raw?.mode ?? null,
        milestones,
        stop: raw?.stop ? { status: raw.stop.status, killDisabled: raw.stop.killDisabled } : null,
        requests,
        nativeErrors: (raw?.native?.events || []).filter((event) => event.kind === 'error').map((event) => ({ id: event.id, readyState: event.readyState, startMs: relative(event.at) })),
        validation: validation ? validation.summary : null,
        failure: failure ? { stage: failure.stage || null, classification: failure.classification || String(failure.name || 'Error') } : null,
        cleanup,
    };
}

// Acknowledges the ledger through its unchanged exact check, but never lets the raw operands (URLs carrying the view,
// session and returnTo values) escape in the error.
export function acknowledgeRouterRecovery(diagnostics, checkpoint, signatures) {
    try {
        return diagnostics.acknowledgeExact(checkpoint, signatures);
    } catch (error) {
        throw new RouterRecoveryProofError('diagnostics', /unexpected diagnostic event multiset/.test(String(error?.message)) ? 'multiset-mismatch' : 'checkpoint');
    }
}

const OWNED_PATH = /^\/webtty\/sessions\/([^/]+)\/(stream|close-intents)$/;

// Arms the independent recorders on the browser context BEFORE the recovery terminal is opened: the transparent
// EventSource observer for terminal documents, a context request recorder and, for every new page, a CDP session that
// supplies request identity, the owning frame and loader, and paired start and terminal timestamps (Playwright timing
// is not available for held requests). `bind` then selects the recovery terminal; `stopAfterCleanup` dispatches the
// client's own pagehide event once independent backend cleanup has been proved.
export async function armRouterRecoveryObservation(context, { baseURL, timeoutMs = 20_000 } = {}) {
    const origin = new URL(baseURL).origin;
    await context.addInitScript(installEventSourceObserver);
    const records = new Map(); // Playwright Request -> record
    const pages = new Map(); // Page -> { cdp, network, orphans, ready, failure }
    const disposers = [];
    const cleanup = { listenersRemoved: 0, cdpDetached: 0, cdpClosedWithPage: 0, cdpDetachFailed: 0 };
    let sequence = 0;
    let bound = null;
    let stopRecord = null;
    let lastRaw = null;
    let disposed = false;
    const on = (emitter, event, handler) => {
        emitter.on(event, handler);
        disposers.push(() => emitter.off(event, handler));
    };
    const owned = (rawUrl) => {
        const url = new URL(rawUrl);
        if (url.origin !== origin) return null;
        const match = OWNED_PATH.exec(url.pathname);
        return match ? { role: match[2] === 'stream' ? 'stream' : 'intent', session: decodeURIComponent(match[1]), view: url.searchParams.get('view') } : null;
    };
    const attachCdp = (page) => {
        const state = { page, cdp: null, network: [], seen: new Set(), orphans: 0, failure: null };
        state.ready = (async () => {
            const cdp = await context.newCDPSession(page);
            state.cdp = cdp;
            const find = (requestId) => state.network.find((entry) => entry.requestId === requestId);
            cdp.on('Network.requestWillBeSent', (event) => {
                state.seen.add(event.requestId);
                const identity = owned(event.request.url);
                if (!identity) return;
                state.network.push({
                    id: `c${++sequence}`, requestId: event.requestId, ...identity, frame: event.frameId, document: event.loaderId,
                    at: event.wallTime * 1000, monotonic: event.timestamp, method: event.request.method, type: event.type,
                    redirect: Boolean(event.redirectResponse), responseStatus: null, terminals: [],
                });
            });
            cdp.on('Network.responseReceived', (event) => { const entry = find(event.requestId); if (entry) entry.responseStatus = event.response.status; });
            for (const [name, kind] of [['Network.loadingFailed', 'failed'], ['Network.loadingFinished', 'finished']]) {
                cdp.on(name, (event) => {
                    const entry = find(event.requestId);
                    // A terminal for a request whose start was never seen means the recorder was armed too late.
                    if (!entry) { if (!state.seen.has(event.requestId)) state.orphans += 1; return; }
                    // The monotonic terminal time is converted through this request's own paired start anchor.
                    entry.terminals.push({ kind, at: entry.at + (event.timestamp - entry.monotonic) * 1000, ...(event.errorText ? { failure: event.errorText } : {}) });
                });
            }
            await cdp.send('Network.enable');
            await cdp.send('Page.enable');
        })().catch((error) => { state.failure = String(error?.name || 'Error'); });
        pages.set(page, state);
    };
    on(context, 'page', attachCdp);
    on(context, 'request', (request) => {
        if (typeof request.serviceWorker === 'function' && request.serviceWorker()) return;
        const identity = owned(request.url());
        if (!identity) return;
        const frame = request.frame();
        records.set(request, {
            id: `p${++sequence}`, ...identity, postData: request.postData(), page: frame.page(), method: request.method(),
            resourceType: request.resourceType(), frameMain: frame === frame.page().mainFrame(), pageOwned: true,
            redirect: Boolean(request.redirectedFrom()), status: null, contentType: null, failure: null, correctBody: null, bodyValid: null, body: null,
        });
    });
    on(context, 'response', (response) => {
        const record = records.get(response.request());
        if (!record) return;
        record.status = response.status();
        record.contentType = response.headers()['content-type'] || null;
        // Only a fetch body is readable; an EventSource refusal body is never claimed.
        // Its completion is tracked separately and never awaited by a snapshot: a body that never finishes keeps the
        // request unsettled until the existing deadline, instead of hanging the observation.
        if (record.role === 'intent') {
            record.body = response.body().then((buffer) => { record.bodyText = buffer.toString(); }, () => { record.bodyText = null; });
        }
    });
    on(context, 'requestfailed', (request) => { const record = records.get(request); if (record) record.failure = request.failure()?.errorText ?? 'unknown'; });

    const exactRecords = () => {
        need(bound, 'bind', 'not-bound');
        return [...records.values()].filter((record) => record.page === bound.page && record.session === bound.sessionId
            && (record.role === 'intent' || record.view === bound.viewId));
    };
    const intentBodyExpected = (mode, sessionId) => {
        const intentPath = `/webtty/sessions/${encodeURIComponent(sessionId)}/close-intents`;
        return mode === 'sso'
            ? { ok: false, error: 'not_authenticated', login: `/auth/login?${new URLSearchParams({ returnTo: intentPath })}` }
            : { ok: false, error: 'not_found' };
    };
    // Every wait of this observation ends at the existing deadline with a classified failure.
    const within = (promise, ms, stage, classification) => {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new RouterRecoveryProofError(stage, classification)), ms); })])
            .finally(() => clearTimeout(timer));
    };
    const dispatchPagehide = (page) => within(page.evaluate(() => {
        const before = performance.timeOrigin + performance.now();
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        const after = performance.timeOrigin + performance.now();
        return { before, after, status: document.getElementById('status')?.textContent ?? null, killDisabled: document.getElementById('kill')?.disabled ?? null };
    }), timeoutMs, 'stop', 'dispatch-deadline');
    // True once every owned request is settled; false when the deadline passes first.
    const waitSettled = async () => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (settled(await snapshot())) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    const snapshot = async () => {
        need(bound, 'bind', 'not-bound');
        const { page, sessionId, viewId, mode } = bound;
        const state = pages.get(page);
        need(state && !state.failure && state.cdp, 'cdp', 'unavailable');
        const own = exactRecords();
        for (const record of own) {
            if (record.role !== 'intent') continue;
            try { record.correctBody = isDeepStrictEqual(JSON.parse(record.postData ?? 'null'), { view: viewId, policy: 'keep' }); } catch { record.correctBody = false; }
            // The body is neither valid nor invalid until it has completely arrived.
            if (record.bodyChecked || record.bodyText === undefined) continue;
            record.bodyChecked = true;
            try { record.bodyValid = isDeepStrictEqual(JSON.parse(record.bodyText), intentBodyExpected(mode, sessionId)); } catch { record.bodyValid = false; }
        }
        const nativeState = page.isClosed() ? null : await within(page.evaluate((expected) => {
            const observation = window.__routerRecoveryNative;
            if (!observation) return null;
            return { compatible: observation.compatible, events: observation.events.map(({ url, ...event }) => ({ ...event, ...(url === undefined ? {} : { exactUrl: url === expected }) })) };
        }, new URL(`/webtty/sessions/${encodeURIComponent(sessionId)}/stream?view=${encodeURIComponent(viewId)}`, origin).toString()), timeoutMs, 'snapshot', 'native-read-deadline');
        const cdp = state.network.filter((entry) => entry.session === sessionId && (entry.role === 'intent' || entry.view === viewId));
        const raw = {
            mode, binding: { ...bound.binding, navigations: bound.navigations },
            playwright: own.map(({ id, role, method, resourceType, frameMain, pageOwned, redirect, status, contentType, failure, correctBody, bodyValid }) => (
                { id, role, method, resourceType, frameMain, pageOwned, redirect, status, contentType, failure, correctBody, bodyValid })),
            cdp, orphans: state.orphans, native: nativeState, stop: stopRecord,
        };
        lastRaw = raw;
        return raw;
    };
    const settled = (raw) => raw.cdp.length > 0 && raw.cdp.every((entry) => entry.terminals.length >= 1)
        && raw.playwright.every((record) => record.role !== 'intent' || record.failure !== null || (record.status !== null && record.bodyValid !== null));

    return {
        // Binds the recovery terminal after it connected: its owned page, main frame and document epoch, the exact
        // session/view and the authentication mode, and requires the original successful stream.
        async bind({ page, sessionId, viewId, mode }) {
            need(!bound, 'bind', 'already-bound');
            need(['sso', 'local'].includes(mode) && typeof sessionId === 'string' && VIEW_ID.test(viewId), 'bind', 'identity-missing');
            const state = pages.get(page);
            need(state, 'bind', 'page-not-armed');
            await state.ready;
            need(state.cdp && !state.failure, 'cdp', 'unavailable');
            const { frameTree } = await state.cdp.send('Page.getFrameTree');
            need(frameTree.frame.url === page.url() && frameTree.frame.id && frameTree.frame.loaderId, 'bind', 'document-unbound');
            bound = { page, sessionId, viewId, mode, binding: { frameId: frameTree.frame.id, loaderId: frameTree.frame.loaderId }, navigations: 0 };
            const onNavigated = (frame) => { if (frame === page.mainFrame()) bound.navigations += 1; };
            on(page, 'framenavigated', onNavigated);
            const originals = exactRecords().filter((record) => record.role === 'stream');
            need(originals.length === 1 && originals[0].status === 200 && originals[0].failure === null, 'bind', 'original-stream');
            const originalCdp = state.network.filter((entry) => entry.role === 'stream' && entry.session === sessionId && entry.view === viewId);
            need(originalCdp.length === 1 && originalCdp[0].frame === bound.binding.frameId && originalCdp[0].document === bound.binding.loaderId, 'bind', 'cdp-missed-original');
        },
        // Dispatches the client's own pagehide in the actual terminal document, after independent backend cleanup, then
        // waits for every owned request to reach a terminal state. It does not navigate or close the page.
        async stopAfterCleanup() {
            need(bound && !stopRecord, 'stop', 'out-of-order');
            stopRecord = await dispatchPagehide(bound.page);
            need(await waitSettled(), 'stop', 'settle-deadline');
            return { before: stopRecord.before, after: stopRecord.after };
        },
        // Failure cleanup for an owned producer that is still running (for example after a cleanup or probe failure that
        // came before the stop): the client's own pagehide, or closing the owned page, ends its retries. It never throws
        // and is never evidence that the independent backend cleanup passed.
        async finalizeFailure() {
            const outcome = { kind: 'failure-cleanup', backendCleanupEvidence: false, bound: Boolean(bound), producerStopped: false, alreadyStopped: Boolean(stopRecord), pageClosed: false, snapshotRequests: 0, failures: [] };
            const note = (stage, error) => outcome.failures.push({ stage, error: String(error?.classification || error?.name || 'Error') });
            if (bound && stopRecord) {
                outcome.producerStopped = true;
            } else if (bound && !bound.page.isClosed()) {
                try {
                    stopRecord = await dispatchPagehide(bound.page);
                    outcome.producerStopped = true;
                    if (!await waitSettled()) note('settle', { classification: 'deadline' });
                } catch (error) {
                    note('stop', error);
                    try { await bound.page.close(); outcome.pageClosed = true; outcome.producerStopped = true; } catch (closeError) { note('close-page', closeError); }
                }
            } else if (bound) {
                outcome.pageClosed = true;
                outcome.producerStopped = true;
            }
            if (bound) {
                try { outcome.snapshotRequests = (await snapshot()).playwright.length; } catch (error) { note('snapshot', error); outcome.snapshotRequests = lastRaw?.playwright.length ?? 0; }
            }
            return outcome;
        },
        // The expected diagnostic signatures, derived only from validated records.
        async validate() {
            const raw = await snapshot();
            const validation = validateRouterRecoveryObservation(raw, { baseURL, sessionId: bound.sessionId, viewId: bound.viewId, mode: bound.mode });
            return validation;
        },
        // The sanitized projection of the latest records; safe on success and failure.
        project({ validation = null, failure = null, milestones = {}, finalization = null } = {}) {
            return { ...projectRouterRecoveryObservation(lastRaw, { validation, failure, milestones, cleanup: { ...cleanup } }), failureFinalization: finalization };
        },
        // Idempotent and non-throwing: failures are counted, not raised, so a teardown cannot mask the primary error.
        async dispose() {
            if (disposed) return { ...cleanup };
            disposed = true;
            for (const remove of disposers.splice(0)) { remove(); cleanup.listenersRemoved += 1; }
            for (const state of pages.values()) {
                if (!state.cdp) continue;
                if (state.page.isClosed()) { cleanup.cdpClosedWithPage += 1; continue; }
                try { await state.cdp.detach(); cleanup.cdpDetached += 1; } catch { cleanup.cdpDetachFailed += 1; }
            }
            return { ...cleanup };
        },
    };
}

// The failure finalization of the outer gate, in its fixed order and with the primary error untouched: it never throws,
// and any failure inside it is recorded by stage and error name only. (1) End the owned producer (the client's own
// pagehide, or closing its page) and take a final snapshot; (2) persist the sanitized projection, labelled as failure
// cleanup and never as evidence that the independent backend cleanup passed; (3) close the open checkpoints without
// acknowledging anything; (4) release the recorders, all before the authorized teardown signs in.
export async function finalizeRouterRecoveryFailure({ observation, persist, closeCheckpoints, report = (message) => console.error(message) }) {
    const sequence = [];
    const failures = [];
    const note = (stage, error) => {
        const name = String(error?.name || 'Error');
        failures.push({ stage, error: name });
        report(`Router recovery failure finalization: ${stage} ${name}`);
    };
    let finalization = null;
    try { finalization = await observation.finalizeFailure(); sequence.push('stop-producer'); } catch (error) { note('stop-producer', error); }
    try { await persist(finalization); sequence.push('persist'); } catch (error) { note('persist', error); }
    try { closeCheckpoints(); sequence.push('close-checkpoints'); } catch (error) { note('close-checkpoints', error); }
    try { await observation.dispose(); sequence.push('dispose'); } catch (error) { note('dispose', error); }
    return { sequence, failures, finalization };
}

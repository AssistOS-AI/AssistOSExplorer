import { expect } from './fixtures.mjs';
import { smokeConfig } from './config.mjs';

// A WebMeet document is left (closed panel or page navigation) only at an idle
// point. Leaving earlier aborts the document's own in-flight requests, which the
// strict browser-error checks rightly count as failures. The idle point is:
//   1. the room loader finished: the document is complete and no element is
//      marked `data-app-loading="true"` (Explorer's own panel-ready rule);
//   2. the dashboard is not joining, leaving or switching rooms;
//   3. no request of that frame or its child frames is in flight, and none
//      started or ended during the last WEBMEET_SETTLE_QUIET_MS, as observed by
//      the page's request lifecycle events.
// The loader's terminal state alone is not enough: the dashboard starts its
// initial data load (the browser mutation proof GET, then MCP calls, then an
// optional resumed room join) right after it renders.

export const WEBMEET_ROOM_LOADER_PATH = '/webmeetAgent/roomLoader.html';
export const WEBMEET_SETTLE_QUIET_MS = 1_000;

const ledgers = new WeakMap();

function requestPath(url) {
    try {
        return new URL(url).pathname;
    } catch {
        return '<invalid url>';
    }
}

function isWithinFrame(candidate, root) {
    for (let frame = candidate; frame; frame = frame.parentFrame?.() || null) {
        if (frame === root) return true;
    }
    return false;
}

// Request bookkeeping without Playwright, so the rules are unit-testable.
// Requests are keyed by identity; `frame` is any object with `parentFrame()`.
export function createFrameRequestLedger({ now = () => Date.now() } = {}) {
    const inFlight = new Map();
    const lastActivity = new Map();
    const touch = (frame) => {
        if (frame) lastActivity.set(frame, now());
    };
    return {
        start(request, frame, { method = '', url = '' } = {}) {
            inFlight.set(request, { frame, method: String(method).toUpperCase(), path: requestPath(url) });
            touch(frame);
        },
        end(request) {
            const entry = inFlight.get(request);
            if (!entry) return;
            inFlight.delete(request);
            touch(entry.frame);
        },
        // In-flight requests of `root` and its child frames, and how long the
        // subtree has had no request start or end (Infinity when it never had one).
        snapshot(root) {
            const pending = [...inFlight.values()]
                .filter((entry) => isWithinFrame(entry.frame, root))
                .map(({ method, path }) => `${method} ${path}`);
            let latest = -Infinity;
            for (const [frame, at] of lastActivity) {
                if (at > latest && isWithinFrame(frame, root)) latest = at;
            }
            return { pending, quietForMs: now() - latest };
        },
    };
}

function requestFrame(request) {
    try {
        return request.frame();
    } catch {
        // Service-worker requests have no frame and never belong to a WebMeet document.
        return null;
    }
}

// Starts recording the page's requests by frame. Call it before the page first
// navigates to WebMeet: requests already in flight when tracking starts are invisible.
export function trackWebMeetRequests(page) {
    if (ledgers.has(page)) return ledgers.get(page);
    const ledger = createFrameRequestLedger();
    page.on('request', (request) => {
        // A redirect continues the same load under a new request.
        const previous = request.redirectedFrom();
        if (previous) ledger.end(previous);
        ledger.start(request, requestFrame(request), { method: request.method(), url: request.url() });
    });
    page.on('requestfinished', (request) => ledger.end(request));
    page.on('requestfailed', (request) => ledger.end(request));
    ledgers.set(page, ledger);
    return ledger;
}

export function isWebMeetRoomLoaderUrl(url) {
    try {
        const target = new URL(url);
        return target.origin === new URL(smokeConfig.baseURL).origin && target.pathname === WEBMEET_ROOM_LOADER_PATH;
    } catch {
        return false;
    }
}

function readWebMeetDocumentState() {
    const presenter = document.querySelector('webmeet-dashboard')?.webSkelPresenter;
    const state = presenter?.state || {};
    return {
        readyState: document.readyState,
        loading: Boolean(document.querySelector('[data-app-loading="true"]')),
        joining: Boolean(String(state.joiningMeetingId || '').trim()),
        leaving: state.leavingMeeting === true,
        switching: state.roomTransition?.active === true,
    };
}

// One description of why the frame is not idle yet, or 'settled'.
export function describeWebMeetSettleState({ url, documentState, network, quietMs = WEBMEET_SETTLE_QUIET_MS }) {
    if (!isWebMeetRoomLoaderUrl(url)) return `waiting for the WebMeet room loader document (at ${requestPath(url)})`;
    if (!documentState) return 'waiting for the WebMeet document to accept evaluation';
    if (documentState.readyState !== 'complete') return `waiting for the WebMeet document to load (${documentState.readyState})`;
    if (documentState.loading) return 'waiting for the WebMeet room loader to finish';
    if (documentState.joining) return 'waiting for the WebMeet room join to finish';
    if (documentState.leaving) return 'waiting for the WebMeet room leave to finish';
    if (documentState.switching) return 'waiting for the WebMeet room transition to finish';
    if (network.pending.length) return `waiting for in-flight WebMeet requests: ${network.pending.join(', ')}`;
    if (network.quietForMs < quietMs) return `waiting for ${quietMs} ms without WebMeet requests`;
    return 'settled';
}

// Waits until `frame` (a WebMeet room loader document of `page`) is idle. The
// wait lasts at least `quietMs`, so its timeout never drops below that.
export async function waitForWebMeetSettled(page, frame, { label = 'WebMeet', quietMs = WEBMEET_SETTLE_QUIET_MS, timeout = smokeConfig.timeouts.navigation } = {}) {
    timeout = Math.max(timeout, quietMs + 5_000);
    const ledger = ledgers.get(page);
    if (!ledger) {
        throw new Error(`${label}: WebMeet request tracking must start before the page opens WebMeet.`);
    }
    await expect.poll(async () => {
        if (frame.isDetached()) return 'the WebMeet frame was detached before it settled';
        const documentState = await frame.evaluate(readWebMeetDocumentState).catch(() => null);
        return describeWebMeetSettleState({ url: frame.url(), documentState, network: ledger.snapshot(frame), quietMs });
    }, {
        message: `${label} must settle (room loader finished, no room transition, no request in flight for ${quietMs} ms) before it is left`,
        timeout,
        intervals: [100, 250],
    }).toBe('settled');
}

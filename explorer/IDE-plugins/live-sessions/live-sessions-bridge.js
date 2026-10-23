import { sendLiveSessionCloseIntent } from './live-sessions-api.js';
import { clearEmbeddedTerminalKey, publishCue } from './live-sessions-state.js';

// The Live Sessions page runs in its own iframe, so it cannot reach the Explorer shell's memory. This module is the
// one-way channel from that page to the shell: the shell's toolbar badge count and the terminal view that the page
// embeds. Only the shell sends the close signal when the whole Explorer tab unloads; the page cannot tell that apart
// from the panel being closed, which only detaches views.
export const CUE_MESSAGE = 'explorer-live-sessions:cue';
export const VIEW_MESSAGE = 'explorer-live-sessions:view';
const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const VIEW_ID = /^[A-Za-z0-9_-]{32}$/;

function hasExactKeys(value, keys) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// The parent window when this page is shown inside another page, else null.
export function hostWindow(win = globalThis.window) {
    return win?.parent && win.parent !== win ? win.parent : null;
}

function post(message, win) {
    const parent = hostWindow(win);
    if (!parent || typeof parent.postMessage !== 'function') return false;
    try {
        parent.postMessage(message, win.location.origin);
        return true;
    } catch (_) {
        return false;
    }
}

export function postCueToHost(count, win = globalThis.window) {
    return post({ type: CUE_MESSAGE, count }, win);
}

// `view` is {sessionId, viewId, policy} for an embedded owner view, or null once it is gone.
export function postViewToHost(view, win = globalThis.window) {
    return post({ type: VIEW_MESSAGE, view }, win);
}

export function parseBridgeMessage(data) {
    if (hasExactKeys(data, ['type', 'count']) && data.type === CUE_MESSAGE
        && Number.isSafeInteger(data.count) && data.count >= 0) {
        return { type: CUE_MESSAGE, count: data.count };
    }
    if (!hasExactKeys(data, ['type', 'view']) || data.type !== VIEW_MESSAGE) return null;
    const view = data.view;
    if (view === null) return { type: VIEW_MESSAGE, view: null };
    if (!hasExactKeys(view, ['sessionId', 'viewId', 'policy'])
        || typeof view.sessionId !== 'string' || !SESSION_ID.test(view.sessionId)
        || typeof view.viewId !== 'string' || !VIEW_ID.test(view.viewId)
        || !['keep', 'stop'].includes(view.policy)) return null;
    return { type: VIEW_MESSAGE, view: { sessionId: view.sessionId, viewId: view.viewId, policy: view.policy } };
}

// The iframe element of the expanded panel opened for this page when `source` is its window, else null. Another frame
// or window on the same origin cannot report a cue or a terminal view, and a panel that was closed has no frame left.
function findPageFrame(win, source, pageUrl) {
    if (!source || !pageUrl) return null;
    for (const frame of win.document?.querySelectorAll?.('iframe') || []) {
        if (frame.contentWindow !== source) continue;
        return frame.closest?.('dialog')?.dataset?.expandedKey === pageUrl ? frame : null;
    }
    return null;
}

const bridges = new WeakMap();

// The shell side. One bridge per Explorer window: it shows the page's cue on the toolbar badge and, when the whole
// Explorer tab closes or reloads while the panel is still open and embeds an owner terminal, sends that view's close
// intent. The bridge itself notices the panel closing, so it does not depend on which code opened the panel.
export function installHostBridge(win = globalThis.window) {
    if (!win || typeof win.addEventListener !== 'function') return null;
    if (bridges.has(win)) return bridges.get(win);
    const watchedDialogs = new WeakSet();
    const bridge = {
        pageUrl: '',
        // {sessionId, viewId, policy, source}: the view the page reported and the window that reported it.
        view: null,
        setPageUrl(url) { if (typeof url === 'string') bridge.pageUrl = url; },
        // The panel was closed: the embedded view is detached and a later Explorer start must not restore it.
        panelClosed() {
            bridge.view = null;
            clearEmbeddedTerminalKey();
        },
    };
    win.addEventListener('message', (event) => {
        if (event?.origin !== win.location?.origin) return;
        const frame = findPageFrame(win, event.source, bridge.pageUrl);
        const message = frame ? parseBridgeMessage(event.data) : null;
        if (!message) return;
        if (message.type === CUE_MESSAGE) {
            publishCue(message.count);
            return;
        }
        bridge.view = message.view && { ...message.view, source: event.source };
        // However the panel was opened, closing its dialog detaches the view.
        const dialog = message.view ? frame.closest('dialog') : null;
        if (dialog && !watchedDialogs.has(dialog) && typeof dialog.addEventListener === 'function') {
            watchedDialogs.add(dialog);
            dialog.addEventListener('close', () => bridge.panelClosed(), { once: true });
        }
    });
    win.addEventListener('pagehide', () => {
        const view = bridge.view;
        // A tab unload leaves the panel's iframe in the document; a closed panel does not, so it never signals.
        if (view && findPageFrame(win, view.source, bridge.pageUrl)) {
            sendLiveSessionCloseIntent(view.sessionId, view.viewId, view.policy);
        }
    });
    bridges.set(win, bridge);
    return bridge;
}

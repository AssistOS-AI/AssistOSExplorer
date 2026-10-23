// Page-lifetime state shared by the Live Sessions toolbar button and its panel. It holds no timer and makes no request.
export const EMBEDDED_TERMINAL_KEY = 'explorer.liveSessions.embeddedTerminal';
const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const VIEW_ID = /^[A-Za-z0-9_-]{32}$/;

// Owned shells that are set to stop on close with no owner view attached (still running, possibly counting down),
// plus every stop that could not be confirmed. These are the rows an administrator returns to.
export function countNeedsAttention(rows = []) {
    return rows.filter((row) => (row.status === 'exited'
        ? row.closure === 'unconfirmed'
        : row.isOwner === true && row.closePolicy === 'stop' && row.ownerViewOpen === false)).length;
}

let cueCount = 0;
const cueListeners = new Set();

export function currentCue() {
    return cueCount;
}

export function publishCue(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count === cueCount) return;
    cueCount = count;
    for (const listener of [...cueListeners]) {
        try { listener(cueCount); } catch (_) {}
    }
}

export function subscribeCue(listener) {
    cueListeners.add(listener);
    listener(cueCount);
    return () => cueListeners.delete(listener);
}

// The panel receives the session to re-attach (and the view it replaces) through this one-shot value, never through
// the modal descriptor.
let pendingRestore = null;

export function queueEmbeddedRestore(restore) {
    pendingRestore = validKey(restore) ? { sessionId: restore.sessionId, viewId: restore.viewId } : null;
}

export function takeEmbeddedRestore() {
    const restore = pendingRestore;
    pendingRestore = null;
    return restore;
}

function validKey(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 2 && Object.hasOwn(value, 'sessionId') && Object.hasOwn(value, 'viewId')
        && typeof value.sessionId === 'string' && SESSION_ID.test(value.sessionId)
        && typeof value.viewId === 'string' && VIEW_ID.test(value.viewId);
}

// Exactly {sessionId, viewId}. Anything else, including the earlier {sessionId} form, is absent and removed.
export function readEmbeddedTerminalKey() {
    let raw;
    try {
        raw = globalThis.sessionStorage?.getItem(EMBEDDED_TERMINAL_KEY);
    } catch (_) {
        return null;
    }
    if (raw === null || raw === undefined) return null;
    try {
        const parsed = JSON.parse(raw);
        if (validKey(parsed)) return { sessionId: parsed.sessionId, viewId: parsed.viewId };
    } catch (_) {}
    clearEmbeddedTerminalKey();
    return null;
}

export function writeEmbeddedTerminalKey(sessionId, viewId) {
    if (!validKey({ sessionId, viewId })) return;
    try {
        globalThis.sessionStorage?.setItem(EMBEDDED_TERMINAL_KEY, JSON.stringify({ sessionId, viewId }));
    } catch (_) {
        // Restoring after an Explorer reload is best-effort.
    }
}

export function clearEmbeddedTerminalKey() {
    try {
        globalThis.sessionStorage?.removeItem(EMBEDDED_TERMINAL_KEY);
    } catch (_) {}
}

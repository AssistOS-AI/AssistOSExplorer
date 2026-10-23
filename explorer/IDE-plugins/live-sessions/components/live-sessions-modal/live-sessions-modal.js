import { isAdminUser } from '../../../../services/auth/adminUser.js';
import {
    buildTerminalLaunchUrl,
    navigateTerminalWindow,
    reserveTerminalWindow,
} from '../../../../web-components/modals/terminal-target-modal/terminal-target-modal.js';
import {
    aggregateLiveSessions, discoverLiveSessionSources, ENDED_STATUSES, killLiveSession,
    mintLiveSessionAttach, navigateLiveSessionWindow, sendLiveSessionCloseIntent, setLiveSessionClosePolicy,
    stopAgentSession,
} from '../../live-sessions-api.js';
import { hostWindow, postCueToHost, postViewToHost } from '../../live-sessions-bridge.js';
import {
    clearEmbeddedTerminalKey, countNeedsAttention, publishCue, readEmbeddedTerminalKey, writeEmbeddedTerminalKey,
} from '../../live-sessions-state.js';

const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const VIEW_MESSAGE = 'ploinky-webtty:view';
const VIEW_MESSAGE_KEYS = ['type', 'sessionId', 'viewId', 'role', 'policy'];
const VIEW_ID = /^[A-Za-z0-9_-]{32}$/;
const CLOSURE_SCOPE_TEXT = {
    global: 'Stop not confirmed; terminal service disabled for safety',
    provider: 'Stop not confirmed; agent terminals disabled for safety',
    target: 'Stop not confirmed; this agent is quarantined for terminals',
};

function textElement(tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
}

function failureMessage(error) {
    if (error?.status === 401) return 'Your authentication session has expired. Reopen Live Sessions after signing in.';
    if (error?.status === 403) return 'Administrator access is required.';
    if (error?.status === 429) return 'Too many terminal viewers. Close a view and try again.';
    if (error?.status === 503) return 'Live Sessions is temporarily unavailable.';
    return 'Live Sessions could not complete the request. Try again.';
}

// What a stopped shell's retained record says about the stop. Only a proven exit is called confirmed.
export function closureText(row) {
    if (row.closure === 'pending') return 'Stopping…';
    if (row.closure === 'proven') return 'Stopped (confirmed)';
    if (row.closure === 'unconfirmed') return CLOSURE_SCOPE_TEXT[row.closureScope] || 'Stop not confirmed';
    return '';
}

// The close-policy state of a live shell, or '' when the server reported nothing noteworthy.
export function closePolicyStatusText(row, now = Date.now()) {
    if (row.status === 'exited') return '';
    if (Number.isSafeInteger(row.pendingStopUntil)) {
        return `Stops in ${Math.max(0, Math.ceil((row.pendingStopUntil - now) / 1000))} s unless reopened`;
    }
    return row.closePolicy === 'stop' && row.ownerViewOpen === false ? 'Set to stop on close, still running' : '';
}

function sameOriginMessage(event, frame) {
    const win = globalThis.window;
    const origin = win?.location?.origin ?? globalThis.location?.origin;
    return Boolean(frame?.contentWindow) && event?.source === frame.contentWindow
        && typeof origin === 'string' && event.origin === origin;
}

export class LiveSessionsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.closed = false;
        this.started = false;
        this.rows = new Map();
        this.sourceErrors = [];
        this.controllers = new Set();
        this.pendingPopups = new Set();
        this.pendingId = '';
        this.confirmId = '';
        this.viewerId = '';
        this.attachSequence = 0;
        this.embedded = null;
        // The terminal that was embedded when the Explorer tab last unloaded, re-attached once by the first read.
        this.restore = readEmbeddedTerminalKey();
        this.shellAvailable = true;
        this.handleClick = this.handleClick.bind(this);
        this.handleViewMessage = this.handleViewMessage.bind(this);
        this.handlePageHide = this.handlePageHide.bind(this);
        invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected || this.closed) return;
        this.statusElement = this.element.querySelector('#liveSessionsStatus');
        this.listElement = this.element.querySelector('#liveSessionsList');
        this.viewerElement = this.element.querySelector('#liveSessionsViewer');
        this.viewerTitle = this.element.querySelector('#liveSessionsViewerTitle');
        this.frameElement = this.element.querySelector('#liveSessionsFrame');
        this.listElement.removeEventListener('click', this.handleClick);
        this.listElement.addEventListener('click', this.handleClick);
        if (!this.started) {
            this.started = true;
            void this.refresh();
        }
    }

    afterUnload() {
        this.closed = true;
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
        for (const controller of this.controllers) controller.abort();
        for (const popup of this.pendingPopups) {
            try { popup.close(); } catch (_) {}
        }
        this.pendingPopups.clear();
        this.listElement?.removeEventListener('click', this.handleClick);
        this.detachViewer();
        // Closing the panel is an explicit detach: a later Explorer start must not restore this view.
        clearEmbeddedTerminalKey();
    }

    async withRequest(callback) {
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await callback({ signal: controller.signal });
        } finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
        }
    }

    canUseSessions() {
        return !this.closed;
    }

    async refresh() {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
        if (this.closed || this.listPending) return;
        this.listPending = true;
        const sources = discoverLiveSessionSources(globalThis.assistOS?.workspace?.appPlugins);
        const admin = isAdminUser(globalThis.assistOS?.user) && !this.unsupported;
        let continuePolling = admin || sources.length > 0;
        try {
            const sourceKey = (source) => source.shell ? 'webtty' : source.liveSessions.base;
            const activeSources = new Set([...(admin ? ['webtty'] : []), ...sources.map(sourceKey)]);
            for (const [key, row] of this.rows) {
                if (!activeSources.has(sourceKey(row.sessionSource))) this.rows.delete(key);
            }
            this.sourceErrors = [];
            await this.withRequest(({ signal }) => aggregateLiveSessions(sources, { admin, signal, onResult: (result) => {
                if (this.closed) return;
                if (result.source.shell && !isAdminUser(globalThis.assistOS?.user)) return;
                if (result.error?.status === 404 && result.source.shell) this.unsupported = true;
                if (result.error) this.sourceErrors.push(result);
                if (result.source.shell && !result.error) {
                    this.shellAvailable = result.available !== false;
                    const cue = countNeedsAttention(result.rows);
                    publishCue(cue);
                    postCueToHost(cue);
                }
                // A temporary read failure does not establish that a running session disappeared.
                // Successful reads and authorization refusals replace only their own source rows.
                if (!result.error || [401, 403].includes(result.error.status)) {
                    for (const [key, row] of this.rows) {
                        if (sourceKey(row.sessionSource) === sourceKey(result.source)) this.rows.delete(key);
                    }
                }
                for (const row of result.rows) {
                    const key = result.source.shell ? row.id : `${result.source.liveSessions.base}:${row.id}`;
                    this.rows.set(key, { ...row, key, sessionSource: result.source });
                }
                this.renderRows();
            } }));
            if (this.closed) return;
            // Ended agent rows stay replayable with their final exit line; only a shell that exited or a vanished row detaches.
            if (this.viewerId && (!this.rows.has(this.viewerId) || this.rows.get(this.viewerId).status === 'exited')) {
                this.detachViewer();
            }
            if (this.streamPresenter && this.rows.has(this.viewerId)) {
                const row = this.rows.get(this.viewerId);
                this.streamPresenter.row = row;
                this.streamPresenter.form.hidden = !row.isOwner || !row.capabilities.message;
            }
            continuePolling = sources.length > 0 || (admin && !this.unsupported);
            this.statusElement.textContent = this.unsupported && sources.length === 0 ? 'Live Sessions needs a newer Ploinky'
                : this.rows.size ? `${this.rows.size} live session${this.rows.size === 1 ? '' : 's'}.` : 'No live sessions.';
            void this.restoreEmbedded();
        } catch (error) {
            if (this.closed) return;
            if (error?.status === 404) {
                this.unsupported = true;
                continuePolling = false;
                this.rows.clear();
                this.listElement.replaceChildren();
                this.statusElement.textContent = 'Live Sessions needs a newer Ploinky';
            } else {
                if (error?.status === 401 || error?.status === 403) {
                    continuePolling = false;
                    this.rows.clear();
                    this.listElement.replaceChildren();
                    this.detachViewer();
                }
                this.statusElement.textContent = failureMessage(error);
            }
        } finally {
            this.listPending = false;
            if (!this.closed && continuePolling) {
                this.pollTimer = setTimeout(() => void this.refresh(), POLL_MS);
            }
        }
    }

    renderRows() {
        const fragment = document.createDocumentFragment();
        for (const { source, error } of this.sourceErrors) {
            fragment.appendChild(textElement('li', `${source.label || source.agent}: ${error.status === 404 && source.shell
                ? 'Live Sessions needs a newer Ploinky' : 'This session source is unavailable.'}`, 'live-sessions-row'));
        }
        if (!this.shellAvailable) {
            const banner = textElement('li', 'Terminals are disabled for safety. Only retained stop results are listed.', 'live-sessions-row live-sessions-banner');
            banner.setAttribute('role', 'alert');
            fragment.appendChild(banner);
        }
        for (const row of this.rows.values()) {
            const item = textElement('li', '', 'live-sessions-row');
            item.dataset.sessionId = row.key || row.id;
            item.appendChild(textElement('h3', row.title));
            item.appendChild(textElement('p', `${row.detail} · ${row.cwdDisplay}`, 'live-sessions-detail'));
            item.appendChild(textElement('p', `${row.status} · ${row.ownerLabel} · ${row.viewerCount} viewer${row.viewerCount === 1 ? '' : 's'} · ${row.status === 'exited' ? 'Input closed' : row.kind === 'shell' && row.isOwner ? 'You can type' : row.kind !== 'shell' && row.isOwner && row.capabilities.message ? 'You can message' : 'Watch only'} · ${row.access === 'ro' ? 'Read-only folder' : 'Read/write folder'}`));
            if (row.kind === 'shell') {
                const policy = [row.profileLabel ? `Profile: ${row.profileLabel}` : '',
                    row.closePolicy ? `When its tab closes: ${row.closePolicy === 'stop' ? 'Stop it' : 'Keep running'}` : ''].filter(Boolean);
                if (policy.length) item.appendChild(textElement('p', policy.join(' · '), 'live-sessions-detail'));
                const policyStatus = closePolicyStatusText(row);
                if (policyStatus) item.appendChild(textElement('p', policyStatus, 'live-sessions-notice'));
            }
            if (row.status === 'exited') {
                item.appendChild(textElement('p', `Ended: ${row.exitReason || 'exited'}`));
                if (row.closure) item.appendChild(textElement('p', closureText(row), `live-sessions-notice live-sessions-closure-${row.closure}`));
                if (row.recordCleanup === 'failed') item.appendChild(textElement('p', 'Record cleanup failed', 'live-sessions-notice'));
            } else {
                const actions = textElement('div', '', 'live-sessions-actions');
                const key = row.key || row.id;
                const confirmation = this.confirmId === key;
                if (confirmation) item.appendChild(textElement('p', row.kind === 'shell' ? 'Kill this terminal and its running processes?'
                    : row.kind === 'workflow-phase' ? 'Pause the whole workflow? It can be resumed from Observability.' : 'Stop this run?'));
                const rowActions = [['attach', row.kind === 'shell' ? 'Attach' : 'Watch']];
                if (row.kind === 'shell' && row.isOwner && row.closePolicy === 'stop') rowActions.push(['keep-running', 'Keep running']);
                if (row.kind === 'shell' || row.viewUrl) rowActions.push(['pop-out', 'Pop out']);
                if (row.transcriptUrl) rowActions.push(['transcript', 'Transcript']);
                if (row.capabilities.stop && !ENDED_STATUSES.includes(row.status)) rowActions.push(['kill', row.kind === 'shell' ? 'Kill' : row.kind === 'workflow-phase' ? 'Pause workflow' : 'Stop']);
                for (const [action, label] of confirmation
                    ? [['confirm-kill', row.kind === 'shell' ? 'Confirm Kill' : row.kind === 'workflow-phase' ? 'Confirm pause' : 'Confirm stop'], ['cancel-kill', 'Cancel']]
                    : rowActions) {
                    const button = textElement('button', label, action === 'attach' ? 'general-button secondary' : 'gray-button');
                    button.type = 'button';
                    button.dataset.sessionAction = action;
                    button.dataset.sessionId = key;
                    button.disabled = Boolean(this.pendingId);
                    actions.appendChild(button);
                }
                item.appendChild(actions);
            }
            fragment.appendChild(item);
        }
        const focused = globalThis.document.activeElement;
        const focusedId = focused?.dataset?.sessionId;
        const focusedAction = focused?.dataset?.sessionAction;
        this.listElement.replaceChildren(fragment);
        if (focusedId && focusedAction) {
            this.listElement.querySelector(`[data-session-id="${focusedId}"][data-session-action="${focusedAction}"]`)?.focus();
        }
    }

    handleClick(event) {
        const button = event.target?.closest?.('[data-session-action]');
        if (!button || !this.listElement.contains(button)) return;
        void this.performAction(button.dataset.sessionId, button.dataset.sessionAction);
    }

    // `supersedes` is the view an Explorer restore recovers; only a plain attach can carry it.
    async performAction(id, action, { supersedes } = {}) {
        if (this.closed || this.pendingId || !this.canUseSessions()) return;
        const row = this.rows.get(id);
        if (!row || row.status === 'exited') return;
        if (row.kind === 'shell' && !isAdminUser(globalThis.assistOS?.user)) return;
        if (action === 'kill' || action === 'cancel-kill') {
            if (!row.capabilities.stop || ENDED_STATUSES.includes(row.status)) return;
            this.confirmId = action === 'kill' ? id : '';
            this.renderRows();
            this.listElement.querySelector(`[data-session-id="${id}"][data-session-action="${action === 'kill' ? 'confirm-kill' : 'kill'}"]`)?.focus();
            return;
        }
        if (!['attach', 'pop-out', 'transcript', 'confirm-kill', 'keep-running'].includes(action) || (action === 'confirm-kill' && this.confirmId !== id)) return;
        if (action === 'keep-running' && (row.kind !== 'shell' || !row.isOwner || row.closePolicy !== 'stop')) return;
        if (action === 'confirm-kill' && (!row.capabilities.stop || ENDED_STATUSES.includes(row.status))) return;
        if (action === 'pop-out' && row.kind !== 'shell' && !row.viewUrl) return;
        if (action === 'transcript' && !row.transcriptUrl) return;
        // Reserve in the click event, before awaiting the fresh token, so popup blocking stays detectable.
        const popup = ['pop-out', 'transcript'].includes(action) ? reserveTerminalWindow() : null;
        if (['pop-out', 'transcript'].includes(action) && !popup) {
            this.statusElement.textContent = 'The browser blocked the terminal tab. Allow popups for this site, then try again.';
            return;
        }
        if (popup) this.pendingPopups.add(popup);
        const sequence = ++this.attachSequence;
        this.pendingId = id;
        this.renderRows();
        try {
            if (action === 'keep-running') {
                const result = await this.withRequest((options) => setLiveSessionClosePolicy(row.id, 'keep', options));
                if (this.closed) return;
                if (this.embedded?.sessionId === row.id) this.embedded.policy = result.closePolicy;
            } else if (action === 'confirm-kill') {
                await this.withRequest((options) => row.kind === 'shell' ? killLiveSession(row.id, options) : stopAgentSession(row.sessionSource, row, options));
                if (this.closed) return;
                this.confirmId = '';
                // An agent view stays so its final stopped exit line arrives; a killed shell has nothing left to show.
                if (this.viewerId === id && row.kind === 'shell') this.detachViewer();
            } else if (row.kind !== 'shell') {
                if (popup) {
                    if (!navigateLiveSessionWindow(popup, action === 'transcript' ? row.transcriptUrl : row.viewUrl, row.sessionSource.agent)) throw new Error('The tab could not be opened.');
                    this.pendingPopups.delete(popup);
                } else {
                    this.detachViewer();
                    const mountSequence = this.attachSequence;
                    this.viewerId = id;
                    this.viewerTitle.textContent = row.title;
                    this.viewerElement.hidden = false;
                    const proxy = globalThis.assistOS.UI.createElement('live-session-stream-view', this.frameElement, {}, {}, true);
                    const node = proxy.element?.deref?.();
                    await node?.presenterReadyPromise;
                    await node?.renderCompletePromise;
                    if (this.closed || mountSequence !== this.attachSequence) return;
                    this.streamPresenter = node?.webSkelPresenter;
                    if (!this.streamPresenter) throw new Error('The stream view could not be opened.');
                    this.streamPresenter.updateSession(row, row.sessionSource);
                }
            } else {
                const claim = action === 'attach' && supersedes ? { supersedes } : {};
                const attach = await this.withRequest((options) => mintLiveSessionAttach(row.id, { ...options, ...claim }));
                if (this.closed || sequence !== this.attachSequence || !this.canUseSessions()) return;
                if (action === 'pop-out') {
                    if (!navigateTerminalWindow(popup, { attach })) throw new Error('Terminal tab could not be opened.');
                    this.pendingPopups.delete(popup);
                } else {
                    this.detachViewer();
                    const frame = document.createElement('iframe');
                    frame.title = `${row.title} (${row.isOwner ? 'owner' : 'watch only'})`;
                    frame.referrerPolicy = 'no-referrer';
                    frame.src = buildTerminalLaunchUrl({ attach });
                    this.frameElement.replaceChildren(frame);
                    this.viewerId = id;
                    this.viewerTitle.textContent = frame.title;
                    this.viewerElement.hidden = false;
                    this.beginEmbedded(frame, row);
                }
            }
        } catch (error) {
            if (!this.closed) this.statusElement.textContent = failureMessage(error);
        } finally {
            if (this.pendingPopups.delete(popup)) {
                try { popup.close(); } catch (_) {}
            }
            this.pendingId = '';
            if (!this.closed) this.renderRows();
        }
        if (!this.closed && ['confirm-kill', 'keep-running'].includes(action)) void this.refresh();
    }

    // Re-attaches the terminal that was embedded when Explorer last unloaded, through the ordinary attach-token flow.
    async restoreEmbedded() {
        const restore = this.restore;
        this.restore = null;
        if (!restore || this.closed) return;
        const id = restore.sessionId;
        const row = this.rows.get(id);
        if (!row || row.kind !== 'shell' || !row.isOwner || row.status === 'exited') {
            clearEmbeddedTerminalKey();
            return;
        }
        await this.performAction(id, 'attach', { supersedes: restore.viewId });
        if (!this.closed && this.viewerId !== id) clearEmbeddedTerminalKey();
    }

    beginEmbedded(frame, row) {
        this.clearEmbedded();
        this.embedded = { sessionId: row.id, frame, viewId: '', policy: '', registered: false };
        // Only the owner's view can stop the terminal on page close; a watcher's view never registers anything.
        if (row.isOwner) globalThis.window?.addEventListener?.('message', this.handleViewMessage);
    }

    // Accepts the embedded WebTTY page's announcement of its server-issued view and close policy.
    handleViewMessage(event) {
        const embedded = this.embedded;
        if (!embedded || this.closed || !sameOriginMessage(event, embedded.frame)) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || Object.keys(data).length !== VIEW_MESSAGE_KEYS.length
            || !VIEW_MESSAGE_KEYS.every((key) => Object.hasOwn(data, key))
            || data.type !== VIEW_MESSAGE || data.role !== 'owner' || data.sessionId !== embedded.sessionId
            || typeof data.viewId !== 'string' || !VIEW_ID.test(data.viewId)
            || !['keep', 'stop'].includes(data.policy)) return;
        embedded.viewId = data.viewId;
        embedded.policy = data.policy;
        if (!embedded.registered) {
            embedded.registered = true;
            // Inside the Explorer panel this page cannot tell the panel being closed from the Explorer tab closing,
            // so the Explorer shell holds the view and sends the signal; a page of its own is the tab that closes.
            if (!hostWindow()) globalThis.window?.addEventListener?.('pagehide', this.handlePageHide);
        }
        // Every announcement replaces the stored view: a policy change or a back/forward re-attach issues a new one.
        writeEmbeddedTerminalKey(embedded.sessionId, embedded.viewId);
        postViewToHost({ sessionId: embedded.sessionId, viewId: embedded.viewId, policy: embedded.policy });
    }

    // Closing or reloading the whole tab of a page that is not embedded is the only trigger. Nothing here clears the storage key, so a reload can restore.
    handlePageHide() {
        const embedded = this.embedded;
        if (embedded?.viewId) sendLiveSessionCloseIntent(embedded.sessionId, embedded.viewId, embedded.policy);
    }

    clearEmbedded() {
        const embedded = this.embedded;
        this.embedded = null;
        globalThis.window?.removeEventListener?.('message', this.handleViewMessage);
        globalThis.window?.removeEventListener?.('pagehide', this.handlePageHide);
        if (embedded) {
            clearEmbeddedTerminalKey();
            postViewToHost(null);
        }
    }

    detachViewer() {
        this.attachSequence += 1;
        this.clearEmbedded();
        this.viewerId = '';
        this.streamPresenter?.afterUnload();
        this.streamPresenter = null;
        this.frameElement?.replaceChildren();
        if (this.viewerElement) this.viewerElement.hidden = true;
    }
}

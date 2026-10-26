import { isAdminUser } from '../../../../services/auth/adminUser.js';
import {
    buildTerminalLaunchUrl,
    navigateTerminalWindow,
    reserveTerminalWindow,
} from '../../../../web-components/modals/terminal-target-modal/terminal-target-modal.js';
import {
    aggregateLiveSessions, discoverLiveSessionSources, ENDED_STATUSES, killLiveSession,
    mintLiveSessionAttach, navigateLiveSessionWindow, sendLiveSessionCloseIntent, setLiveSessionClosePolicy,
    stopAgentSession, submitLiveSessionCloseIntent,
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
// Explorer-managed closes of a view. Native tab close, quit, reload and navigation never come through here.
const CLOSE_REASONS = ['detach', 'switch', 'close', 'replace', 'reload'];
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

// Why a close choice did not complete. A request that timed out or failed may still have reached Ploinky, so a Stop
// that was sent is never reported as not applied, and nothing here claims that the terminal is still running.
function closeChoiceFailure(choice, stage, error) {
    if (error?.status === 401) return failureMessage(error);
    if (choice === 'keep') return 'Keep running could not be confirmed, so this view stays open. Try again, or choose Cancel.';
    if (stage === 'policy') return 'Stop it could not be confirmed, so this view stays open. Try again, or choose Keep running or Cancel.';
    if (error?.status === 409) return 'This view is no longer current, so Stop it was not applied to it. Choose Keep running, or reattach and try again.';
    return 'Stop it may have been accepted: if so, the terminal stops in about 30 seconds unless it is reopened or set to Keep running. This view stays open.';
}

// What the status says when the chosen view went away or changed. `sentPolicy` is the close policy Ploinky already
// accepted for the session before that was noticed, or null when nothing was sent.
export function closeDecisionLostText(sentPolicy, viewShown) {
    if (sentPolicy === 'keep') {
        return viewShown
            ? 'The terminal view changed while your choice was applied. Its close choice was set to Keep running, so the terminal keeps running; close the view again to choose.'
            : 'Its close choice was set to Keep running before the view closed, so the terminal keeps running.';
    }
    if (sentPolicy === 'stop') {
        return viewShown
            ? 'The terminal view changed while your choice was applied. Its close choice was set to Stop it, but no stop was armed for this view, so the terminal keeps running while a view is open. Close the view again to choose, or set Keep running.'
            : 'Its close choice was set to Stop it, but the view closed before a stop was requested for it, so no stop was armed from here.';
    }
    return 'The terminal view changed before your choice was applied. Nothing was sent for it; close it again to choose.';
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
        // The one pending Keep running / Stop it / Cancel decision; every close request shares it.
        this.closeDecision = null;
        this.handleClick = this.handleClick.bind(this);
        this.handleViewMessage = this.handleViewMessage.bind(this);
        this.handlePageHide = this.handlePageHide.bind(this);
        this.handleCloseDialogCancel = this.handleCloseDialogCancel.bind(this);
        this.handleDecisionPageHide = this.handleDecisionPageHide.bind(this);
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
        this.closeDialog = this.element.querySelector('#liveSessionsCloseDialog');
        this.closeText = this.element.querySelector('#liveSessionsCloseText');
        this.closeStatus = this.element.querySelector('#liveSessionsCloseStatus');
        this.closeKeep = this.element.querySelector('#liveSessionsCloseKeep');
        this.closeStop = this.element.querySelector('#liveSessionsCloseStop');
        this.closeCancel = this.element.querySelector('#liveSessionsCloseCancel');
        this.closeDialog?.removeEventListener?.('cancel', this.handleCloseDialogCancel);
        this.closeDialog?.addEventListener?.('cancel', this.handleCloseDialogCancel);
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
        this.closeDialog?.removeEventListener?.('cancel', this.handleCloseDialogCancel);
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
                    row.closePolicy ? `Close choice: ${row.closePolicy === 'stop' ? 'Stop it' : 'Keep running'}` : ''].filter(Boolean);
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
        if (this.closed || this.pendingId || this.closeDecision || !this.canUseSessions()) return;
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
                    // Watching replaces the embedded view, so an owned terminal there gets its close choice first.
                    if (!await this.prepareViewClose('switch') || this.closed) return;
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
                // Attaching replaces the embedded view (pop-out does not): the close choice completes before any mint.
                if (action === 'attach' && (!await this.prepareViewClose('switch') || this.closed || !this.canUseSessions())) return;
                const sequence = ++this.attachSequence;
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

    // The Detach view button. Detaching an owned running terminal asks first; detachViewer() itself stays unconditional.
    async requestDetachViewer() {
        if (this.closed || !this.viewerId) return;
        if (!await this.prepareViewClose('detach') || this.closed) return;
        this.detachViewer();
    }

    // The owner's embedded view of a running WebTTY shell, or null when there is nothing whose lifetime is decided here:
    // watchers, agent streams, exited shells and an empty viewer close without a choice.
    ownedShellView() {
        const embedded = this.embedded;
        const row = embedded && this.viewerId ? this.rows.get(this.viewerId) : null;
        if (!row || row.kind !== 'shell' || !row.isOwner || row.status === 'exited' || row.id !== embedded.sessionId) return null;
        return { embedded, row };
    }

    // Asked before an Explorer-managed close disposes or replaces the current view: Detach view, switching session,
    // closing or replacing the panel, and reloading it. Resolves true when that may proceed, false to keep the identical
    // frame, stream, selection and stored key. A reload asks nothing and changes nothing, because the page re-attaches
    // from the stored key; any open choice is withdrawn without a request. Every other reason asks only for an owned
    // running shell view, and all concurrent requests share the one pending choice.
    prepareViewClose(reason) {
        if (!CLOSE_REASONS.includes(reason)) return Promise.resolve(false);
        if (reason === 'reload') {
            if (this.closeDecision) this.settleCloseDecision(this.closeDecision, false);
            return Promise.resolve(true);
        }
        if (this.closed) return Promise.resolve(true);
        if (this.closeDecision) return this.closeDecision.promise;
        const target = this.ownedShellView();
        if (!target) return Promise.resolve(true);
        const decision = {
            reason,
            sessionId: target.row.id,
            title: target.row.title,
            frame: target.embedded.frame,
            // Empty while the view is still connecting: Stop it then waits for the view's announcement.
            viewId: target.embedded.viewId,
            sequence: this.attachSequence,
            busy: false,
            settled: false,
        };
        decision.promise = new Promise((resolve) => { decision.resolve = resolve; });
        this.closeDecision = decision;
        const dialog = this.closeDialog;
        if (typeof dialog?.showModal !== 'function') {
            // Without the dialog nothing can be chosen, so nothing closes.
            if (this.statusElement) this.statusElement.textContent = 'The close choice could not be shown. Reload Live Sessions and try again.';
            this.settleCloseDecision(decision, false);
            return decision.promise;
        }
        this.renderCloseDialog(decision, '');
        globalThis.window?.addEventListener?.('pagehide', this.handleDecisionPageHide);
        try {
            dialog.showModal();
        } catch (_) {
            if (this.statusElement) this.statusElement.textContent = 'The close choice could not be shown. Reload Live Sessions and try again.';
            this.settleCloseDecision(decision, false);
        }
        return decision.promise;
    }

    // `status` null keeps the current status line.
    renderCloseDialog(decision, status) {
        if (this.closeText) {
            this.closeText.textContent = `"${decision.title}" keeps running unless you choose Stop it. Stop it ends it about 30 seconds after this view closes, unless it is reopened, set to Keep running or open elsewhere by then.`;
        }
        if (status !== null && this.closeStatus) {
            const text = status || (decision.viewId ? '' : 'This view is still connecting. Stop it becomes available once it connects; Keep running and Cancel work now.');
            this.closeStatus.textContent = text;
            this.closeStatus.hidden = !text;
        }
        if (this.closeKeep) this.closeKeep.disabled = decision.busy;
        if (this.closeStop) this.closeStop.disabled = decision.busy || !decision.viewId;
        if (this.closeCancel) this.closeCancel.disabled = decision.busy;
    }

    // Whether the view the choice was opened for is still the selected owned view. Late work never acts on another one.
    closeDecisionCurrent(decision) {
        const target = this.ownedShellView();
        return Boolean(target) && !this.closed && target.embedded.frame === decision.frame
            && target.row.id === decision.sessionId && this.attachSequence === decision.sequence
            && (!decision.viewId || target.embedded.viewId === decision.viewId);
    }

    // The chosen view went away or changed during the choice, and nothing more is sent for it. With no view left there is
    // nothing to protect, so the close may proceed; a different view stays, and the person decides again. The status
    // names a policy request that was already accepted for the session.
    closeDecisionLost(decision, sentPolicy = null) {
        const viewShown = Boolean(this.embedded);
        if (this.statusElement && (viewShown || sentPolicy)) this.statusElement.textContent = closeDecisionLostText(sentPolicy, viewShown);
        this.settleCloseDecision(decision, !viewShown);
    }

    // The dialog buttons: Keep running, Stop it or Cancel.
    async chooseViewClose(_target, choice) {
        const decision = this.closeDecision;
        if (!decision || decision.settled || decision.busy) return;
        if (choice === 'cancel') {
            this.settleCloseDecision(decision, false);
            return;
        }
        if (!['keep', 'stop'].includes(choice) || (choice === 'stop' && !decision.viewId)) return;
        if (!this.closeDecisionCurrent(decision)) {
            this.closeDecisionLost(decision);
            return;
        }
        decision.busy = true;
        this.renderCloseDialog(decision, choice === 'stop' ? 'Stopping…' : 'Keeping it running…');
        let stage = 'policy';
        try {
            // Keep running cancels any stop already pending for this shell. Stop it first sets the policy, which by
            // itself arms nothing while this view is open, and then signals this exact view.
            await this.withRequest((options) => setLiveSessionClosePolicy(decision.sessionId, choice, options));
            if (decision.settled) return;
            if (!this.closeDecisionCurrent(decision)) {
                this.closeDecisionLost(decision, choice);
                return;
            }
            if (choice === 'keep') {
                if (this.statusElement) this.statusElement.textContent = 'The terminal keeps running. Reopen it from Live Sessions.';
                this.settleCloseDecision(decision, true);
                return;
            }
            stage = 'intent';
            const result = await this.withRequest((options) => submitLiveSessionCloseIntent(decision.sessionId, decision.viewId, 'stop', options));
            if (decision.settled) return;
            // Accepted: Ploinky ended this view, so its frame may be disposed. A late answer never disposes another view.
            // Another view is shown when anything identifying the chosen view changed: a new frame, attachment, session
            // or a newer announcement in the same frame.
            const shown = this.embedded;
            const otherView = Boolean(shown) && (shown.frame !== decision.frame || shown.sessionId !== decision.sessionId
                || shown.viewId !== decision.viewId || this.attachSequence !== decision.sequence);
            const seconds = result.pending ? Math.max(0, Math.ceil((result.until - Date.now()) / 1000)) : 0;
            let outcome;
            if (result.pending) {
                outcome = otherView
                    ? `Stop it was accepted for the earlier view. Another view is shown now and stays open; the terminal stops in about ${seconds} s only if no owner view is open then and it is not reopened or set to Keep running.`
                    : `The terminal stops in about ${seconds} s unless it is reopened, set to Keep running or open elsewhere.`;
            } else {
                outcome = result.reason === 'superseded'
                    ? 'This view had already been replaced, so no stop was armed. The terminal is still running.'
                    : 'Its close choice changed to Keep running meanwhile, so no stop was armed. The terminal is still running.';
                if (otherView) outcome += ' Another view is shown now, so it stays open.';
            }
            if (this.statusElement) this.statusElement.textContent = outcome;
            this.settleCloseDecision(decision, !otherView);
        } catch (error) {
            if (decision.settled) return;
            decision.busy = false;
            this.renderCloseDialog(decision, closeChoiceFailure(choice, stage, error));
        }
    }

    settleCloseDecision(decision, approved) {
        if (decision.settled) return;
        decision.settled = true;
        if (this.closeDecision === decision) this.closeDecision = null;
        globalThis.window?.removeEventListener?.('pagehide', this.handleDecisionPageHide);
        try {
            if (this.closeDialog?.open) this.closeDialog.close();
        } catch (_) {}
        decision.resolve(approved === true);
    }

    // Escape in the close dialog is Cancel, except while a choice is being applied.
    handleCloseDialogCancel(event) {
        event?.preventDefault?.();
        const decision = this.closeDecision;
        if (decision && !decision.busy) this.settleCloseDecision(decision, false);
    }

    // Native navigation removes this document: an open choice is withdrawn without any request.
    handleDecisionPageHide() {
        if (this.closeDecision) this.settleCloseDecision(this.closeDecision, false);
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
        // A close choice opened while this view was still connecting can offer Stop it once the view is known.
        const decision = this.closeDecision;
        if (decision && !decision.settled && decision.frame === embedded.frame && !decision.viewId) {
            decision.viewId = data.viewId;
            this.renderCloseDialog(decision, decision.busy ? null : '');
        }
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

    // Closing or reloading the whole tab of a page that is not embedded is the only trigger. A native close always keeps
    // the terminal running: the signal only ends this view, once per view. Nothing here clears the storage key, so a
    // reload can restore.
    handlePageHide() {
        const embedded = this.embedded;
        if (!embedded?.viewId || embedded.keepSentFor === embedded.viewId) return;
        embedded.keepSentFor = embedded.viewId;
        sendLiveSessionCloseIntent(embedded.sessionId, embedded.viewId, 'keep');
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

    // The unconditional disposal: an approved close, an exited or vanished shell, an authorization refusal, Kill and
    // unload. A close choice still open for the view is settled as approved, without any request of its own.
    detachViewer() {
        if (this.closeDecision) this.settleCloseDecision(this.closeDecision, true);
        this.attachSequence += 1;
        this.clearEmbedded();
        this.viewerId = '';
        this.streamPresenter?.afterUnload();
        this.streamPresenter = null;
        this.frameElement?.replaceChildren();
        if (this.viewerElement) this.viewerElement.hidden = true;
    }
}

import { isAdminUser } from '../../../../services/auth/adminUser.js';
import {
    buildTerminalLaunchUrl,
    navigateTerminalWindow,
    reserveTerminalWindow,
} from '../../../../web-components/modals/terminal-target-modal/terminal-target-modal.js';
import {
    aggregateLiveSessions, discoverLiveSessionSources, ENDED_STATUSES, killLiveSession,
    mintLiveSessionAttach, navigateLiveSessionWindow, stopAgentSession,
} from '../../live-sessions-api.js';

const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

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
        this.handleClick = this.handleClick.bind(this);
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
        for (const row of this.rows.values()) {
            const item = textElement('li', '', 'live-sessions-row');
            item.dataset.sessionId = row.key || row.id;
            item.appendChild(textElement('h3', row.title));
            item.appendChild(textElement('p', `${row.detail} · ${row.cwdDisplay}`, 'live-sessions-detail'));
            item.appendChild(textElement('p', `${row.status} · ${row.ownerLabel} · ${row.viewerCount} viewer${row.viewerCount === 1 ? '' : 's'} · ${row.status === 'exited' ? 'Input closed' : row.kind === 'shell' && row.isOwner ? 'You can type' : row.kind !== 'shell' && row.isOwner && row.capabilities.message ? 'You can message' : 'Watch only'} · ${row.access === 'ro' ? 'Read-only folder' : 'Read/write folder'}`));
            if (row.status === 'exited') {
                item.appendChild(textElement('p', `Ended: ${row.exitReason || 'exited'}`));
            } else {
                const actions = textElement('div', '', 'live-sessions-actions');
                const key = row.key || row.id;
                const confirmation = this.confirmId === key;
                if (confirmation) item.appendChild(textElement('p', row.kind === 'shell' ? 'Kill this terminal and its running processes?'
                    : row.kind === 'workflow-phase' ? 'Pause the whole workflow? It can be resumed from Observability.' : 'Stop this run?'));
                const rowActions = [['attach', row.kind === 'shell' ? 'Attach' : 'Watch']];
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

    async performAction(id, action) {
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
        if (!['attach', 'pop-out', 'transcript', 'confirm-kill'].includes(action) || (action === 'confirm-kill' && this.confirmId !== id)) return;
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
            if (action === 'confirm-kill') {
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
                const attach = await this.withRequest((options) => mintLiveSessionAttach(row.id, options));
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
        if (!this.closed && action === 'confirm-kill') void this.refresh();
    }

    detachViewer() {
        this.attachSequence += 1;
        this.viewerId = '';
        this.streamPresenter?.afterUnload();
        this.streamPresenter = null;
        this.frameElement?.replaceChildren();
        if (this.viewerElement) this.viewerElement.hidden = true;
    }
}

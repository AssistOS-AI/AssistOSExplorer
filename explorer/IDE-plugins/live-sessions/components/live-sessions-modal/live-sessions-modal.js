import { isAdminUser } from '../../../../services/auth/adminUser.js';
import {
    buildTerminalLaunchUrl,
    navigateTerminalWindow,
    reserveTerminalWindow,
} from '../../../../web-components/modals/terminal-target-modal/terminal-target-modal.js';
import { killLiveSession, listLiveSessions, mintLiveSessionAttach } from '../../live-sessions-api.js';

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
        if (isAdminUser(globalThis.assistOS?.user)) return true;
        clearTimeout(this.pollTimer);
        this.rows.clear();
        this.listElement?.replaceChildren();
        this.detachViewer();
        this.statusElement.textContent = 'Administrator access is required.';
        return false;
    }

    async refresh() {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
        if (this.closed || this.listPending || this.unsupported || !this.canUseSessions()) return;
        this.listPending = true;
        let continuePolling = true;
        try {
            const rows = await this.withRequest(listLiveSessions);
            if (this.closed || !this.canUseSessions()) return;
            this.rows = new Map(rows.map((row) => [row.id, row]));
            if (this.viewerId && (!this.rows.has(this.viewerId) || this.rows.get(this.viewerId).status === 'exited')) {
                this.detachViewer();
            }
            this.renderRows();
            this.statusElement.textContent = rows.length ? `${rows.length} terminal session${rows.length === 1 ? '' : 's'}.` : 'No live terminal sessions.';
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
            if (!this.closed && continuePolling && !this.unsupported && isAdminUser(globalThis.assistOS?.user)) {
                this.pollTimer = setTimeout(() => void this.refresh(), POLL_MS);
            }
        }
    }

    renderRows() {
        const fragment = document.createDocumentFragment();
        for (const row of this.rows.values()) {
            const item = textElement('li', '', 'live-sessions-row');
            item.dataset.sessionId = row.id;
            item.appendChild(textElement('h3', row.title));
            item.appendChild(textElement('p', `${row.detail} · ${row.cwdDisplay}`, 'live-sessions-detail'));
            item.appendChild(textElement('p', `${row.status} · ${row.ownerLabel} · ${row.viewerCount} viewer${row.viewerCount === 1 ? '' : 's'} · ${row.status === 'exited' ? 'Input closed' : row.isOwner ? 'You can type' : 'Watch only'} · ${row.access === 'ro' ? 'Read-only folder' : 'Read/write folder'}`));
            if (row.status === 'exited') {
                item.appendChild(textElement('p', `Ended: ${row.exitReason || 'exited'}`));
            } else {
                const actions = textElement('div', '', 'live-sessions-actions');
                const confirmation = this.confirmId === row.id;
                if (confirmation) item.appendChild(textElement('p', 'Kill this terminal and its running processes?'));
                for (const [action, label] of confirmation
                    ? [['confirm-kill', 'Confirm Kill'], ['cancel-kill', 'Cancel']]
                    : [['attach', 'Attach'], ['pop-out', 'Pop out'], ['kill', 'Kill']]) {
                    const button = textElement('button', label, action === 'attach' ? 'general-button secondary' : 'gray-button');
                    button.type = 'button';
                    button.dataset.sessionAction = action;
                    button.dataset.sessionId = row.id;
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
        if (action === 'kill' || action === 'cancel-kill') {
            this.confirmId = action === 'kill' ? id : '';
            this.renderRows();
            this.listElement.querySelector(`[data-session-id="${id}"][data-session-action="${action === 'kill' ? 'confirm-kill' : 'kill'}"]`)?.focus();
            return;
        }
        if (!['attach', 'pop-out', 'confirm-kill'].includes(action) || (action === 'confirm-kill' && this.confirmId !== id)) return;
        // Reserve in the click event, before awaiting the fresh token, so popup blocking stays detectable.
        const popup = action === 'pop-out' ? reserveTerminalWindow() : null;
        if (action === 'pop-out' && !popup) {
            this.statusElement.textContent = 'The browser blocked the terminal tab. Allow popups for this site, then try again.';
            return;
        }
        if (popup) this.pendingPopups.add(popup);
        const sequence = ++this.attachSequence;
        this.pendingId = id;
        this.renderRows();
        try {
            if (action === 'confirm-kill') {
                await this.withRequest((options) => killLiveSession(id, options));
                if (this.closed) return;
                this.confirmId = '';
                if (this.viewerId === id) this.detachViewer();
            } else {
                const attach = await this.withRequest((options) => mintLiveSessionAttach(id, options));
                if (this.closed || sequence !== this.attachSequence || !this.canUseSessions()) return;
                if (action === 'pop-out') {
                    if (!navigateTerminalWindow(popup, { attach })) throw new Error('Terminal tab could not be opened.');
                    this.pendingPopups.delete(popup);
                } else {
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
        this.frameElement?.replaceChildren();
        if (this.viewerElement) this.viewerElement.hidden = true;
    }
}

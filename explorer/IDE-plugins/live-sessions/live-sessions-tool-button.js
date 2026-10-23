import { runLiveSessionsStartup } from './live-sessions-startup.js';
import { subscribeCue } from './live-sessions-state.js';

const PANEL = { mode: 'component', component: 'live-sessions-modal', title: 'Live Sessions', fullscreen: true };

function openPanel() {
    const open = globalThis.assistOS?.UI?.openExpandedModal;
    if (typeof open !== 'function') return false;
    // Only component metadata reaches the modal descriptor and resume storage.
    void open({ ...PANEL });
    return true;
}

export class LiveSessionsToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.hostContext = {};
        this.cue = 0;
        invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected) return;
        this.button = this.element.querySelector('#liveSessionsToolButton');
        this.badge = this.element.querySelector('#liveSessionsBadge');
        this.button?.addEventListener('click', this.openSessions);
        if (this.button) this.button.hidden = false;
        this.unsubscribeCue?.();
        this.unsubscribeCue = subscribeCue((count) => this.renderCue(count));
        this.syncButtonMetadata();
        void this.runStartup();
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openSessions);
        this.unsubscribeCue?.();
        this.unsubscribeCue = null;
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
        void this.runStartup();
    }

    renderCue(count) {
        this.cue = count;
        if (this.badge) {
            this.badge.textContent = count > 99 ? '99+' : String(count);
            this.badge.hidden = count === 0;
        }
        this.syncButtonMetadata();
    }

    // The toolbar mounts this presenter on demand, so the start work runs when it first mounts.
    runStartup() {
        return runLiveSessionsStartup({ openPanel });
    }

    syncButtonMetadata() {
        const label = this.hostContext.pluginLabel || 'Live Sessions';
        const tooltip = this.hostContext.pluginTooltip || label;
        const icon = this.hostContext.pluginIcon || this.element.getAttribute('data-plugin-icon') || '';
        const image = this.element.querySelector('.app-plugin-tool-icon-image');
        const text = this.element.querySelector('.app-plugin-tool-label');
        if (text) text.textContent = label;
        if (image && icon) image.src = icon;
        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute('aria-label', this.cue ? `${tooltip}, ${this.cue} to review` : tooltip);
        }
    }

    openSessions = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (openPanel()) this.button?.focus?.();
    };
}

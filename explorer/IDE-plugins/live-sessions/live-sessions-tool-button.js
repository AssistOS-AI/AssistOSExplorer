import { installHostBridge } from './live-sessions-bridge.js';
import { runLiveSessionsStartup } from './live-sessions-startup.js';
import { subscribeCue } from './live-sessions-state.js';

// The shell is the only place that knows the panel was closed: the page in the panel's iframe is simply removed.
function panelClosed() {
    installHostBridge()?.panelClosed();
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
        installHostBridge()?.setPageUrl(context.pluginToolbarModal?.url);
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

    // The toolbar mounts this presenter at Explorer start, so the start work runs when it first mounts. It waits for
    // the host to hand over the panel descriptor, because that is what it opens to restore an embedded terminal.
    runStartup() {
        if (!this.hostContext.pluginToolbarModal) return Promise.resolve(false);
        return runLiveSessionsStartup({ openPanel: () => this.openPanel() });
    }

    // The panel is the Live Sessions page in the shared expanded modal, like the other iframe toolbar tools.
    openPanel() {
        const descriptor = this.hostContext?.pluginToolbarModal;
        const open = globalThis.assistOS?.UI?.openExpandedModal;
        if (!descriptor || typeof open !== 'function') return false;
        installHostBridge()?.setPageUrl(descriptor.url);
        const closed = open({ ...descriptor, title: this.hostContext?.pluginLabel || descriptor.title || 'Live Sessions' });
        void Promise.resolve(closed).then(panelClosed, () => {});
        return true;
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
        if (this.openPanel()) this.button?.focus?.();
    };
}

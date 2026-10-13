import { isAdminUser } from '../../services/auth/adminUser.js';

export class LiveSessionsToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.hostContext = {};
        invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected) return;
        this.button = this.element.querySelector('#liveSessionsToolButton');
        this.button?.addEventListener('click', this.openSessions);
        this.syncButtonMetadata();
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openSessions);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
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
            this.button.setAttribute('aria-label', tooltip);
            this.button.hidden = !isAdminUser(globalThis.assistOS?.user);
        }
    }

    openSessions = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (!isAdminUser(globalThis.assistOS?.user)) return;
        const open = globalThis.assistOS?.UI?.openExpandedModal;
        if (typeof open !== 'function') return;
        // Only component metadata reaches the modal descriptor and resume storage.
        void open({
            mode: 'component',
            component: 'live-sessions-modal',
            title: 'Live Sessions',
            fullscreen: true,
        });
        this.button?.focus?.();
    };
}

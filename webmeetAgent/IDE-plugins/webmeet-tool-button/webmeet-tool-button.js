export class WebMeetToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.button = this.element.querySelector('#webmeetToolButton');
        this.iconImageEl = this.element.querySelector('.webmeet-tool-button-icon-image');
        this.labelEl = this.element.querySelector('.webmeet-tool-button-label');
        this.syncButtonMetadata();
        this.button?.addEventListener('click', this.openDashboard);
        window.addEventListener('focus', this.clearPendingInitialTabLoader);
        document.addEventListener('visibilitychange', this.clearPendingInitialTabLoader);
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openDashboard);
        window.removeEventListener('focus', this.clearPendingInitialTabLoader);
        document.removeEventListener('visibilitychange', this.clearPendingInitialTabLoader);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === 'string' && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute('data-plugin-label') || 'WebMeet';
        const tooltip = typeof this.hostContext?.pluginTooltip === 'string' && this.hostContext.pluginTooltip.trim()
            ? this.hostContext.pluginTooltip.trim()
            : this.element.getAttribute('data-plugin-tooltip') || label;
        const icon = typeof this.hostContext?.pluginIcon === 'string' && this.hostContext.pluginIcon.trim()
            ? this.hostContext.pluginIcon.trim()
            : this.element.getAttribute('data-plugin-icon') || '';
        if (this.labelEl) {
            this.labelEl.textContent = label;
        }
        if (this.iconImageEl && icon) {
            this.iconImageEl.src = icon;
        }
        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute('aria-label', tooltip);
        }
    }

    clearInitialTabLoader() {
        const webSkel = window.webSkel || window.WebSkel?.instance;
        if (typeof webSkel?.clearLoading === 'function') {
            webSkel.clearLoading();
        } else if (webSkel) {
            webSkel.loaderCount = 0;
            webSkel.activeLoaderId = null;
        }
        document.querySelectorAll('.spinner').forEach((loader) => {
            try {
                if (typeof loader.close === 'function') {
                    loader.close();
                }
            } catch (_) {
                // The loader may already be closed by WebSkel.
            }
            loader.remove();
        });
    }

    clearPendingInitialTabLoader = () => {
        if (!this.shouldClearInitialTabLoader) {
            return;
        }
        this.clearInitialTabLoader();
    };

    scheduleInitialTabLoaderCleanup() {
        this.shouldClearInitialTabLoader = true;
        [0, 50, 250, 1000, 2000].forEach((delay) => {
            window.setTimeout(() => this.clearInitialTabLoader(), delay);
        });
    }

    getWebMeetAgentName() {
        return String(
            this.hostContext?.pluginAgent
            || this.hostContext?.agent
            || this.element.getAttribute('data-plugin-agent')
            || 'webmeetAgent'
        ).trim() || 'webmeetAgent';
    }

    buildRoomLoaderUrl() {
        const agentName = this.getWebMeetAgentName();
        return new URL(`/${encodeURIComponent(agentName)}/roomLoader.html`, window.location.origin);
    }

    openDashboard = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const descriptor = this.hostContext?.pluginToolbarModal;
        const openExpandedModal = globalThis.assistOS?.UI?.openExpandedModal;
        if (openExpandedModal && descriptor) {
            void openExpandedModal({
                ...descriptor,
                title: this.hostContext?.pluginLabel || descriptor.title
            });
            return;
        }
        window.open(this.buildRoomLoaderUrl().toString(), '_blank', 'noopener');
        this.scheduleInitialTabLoaderCleanup();
    };
}

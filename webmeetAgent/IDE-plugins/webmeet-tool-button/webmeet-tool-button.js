import {
    readWebMeetResume,
    writeWebMeetResume
} from './components/webmeet-dashboard/services/webmeet-session-store.js';

export class WebMeetToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.pageUnloading = false;
        this.handlePageTeardown = () => { this.pageUnloading = true; };
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
        window.addEventListener('pagehide', this.handlePageTeardown);
        window.addEventListener('beforeunload', this.handlePageTeardown);
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openDashboard);
        window.removeEventListener('focus', this.clearPendingInitialTabLoader);
        document.removeEventListener('visibilitychange', this.clearPendingInitialTabLoader);
        window.removeEventListener('pagehide', this.handlePageTeardown);
        window.removeEventListener('beforeunload', this.handlePageTeardown);
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

    buildRoomLoaderUrl(roomId = '') {
        const agentName = this.getWebMeetAgentName();
        const url = new URL(`/${encodeURIComponent(agentName)}/roomLoader.html`, window.location.origin);
        const id = String(roomId || '').trim();
        if (id) {
            url.searchParams.set('roomId', id);
        }
        return url;
    }

    openDashboard = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return this.openWebMeetPanel({ allowFallback: true });
    };

    async openWebMeetPanel({ allowFallback = true } = {}) {
        const resume = readWebMeetResume();
        const roomId = String(resume?.roomId || '').trim();
        const descriptor = this.hostContext?.pluginToolbarModal;
        const openExpandedModal = globalThis.assistOS?.UI?.openExpandedModal;
        if (openExpandedModal && descriptor) {
            const closed = openExpandedModal({
                ...descriptor,
                ...(roomId ? { url: this.buildRoomLoaderUrl(roomId).toString() } : {}),
                title: this.hostContext?.pluginLabel || descriptor.title
            });
            const opened = closed && typeof closed.then === 'function' ? closed.opened : null;
            if (opened && typeof opened.then === 'function') {
                await opened.catch(() => {});
                await closed.catch(() => {});
                // Reaching here means WebMeet was opened and then closed by the user. A browser
                // refresh tears the dialog down without resolving, so the resume record survives
                // and WebMeet reopens in the same state on the next load.
                if (!this.pageUnloading && globalThis.document?.visibilityState !== 'hidden') {
                    writeWebMeetResume({ open: false });
                }
            }
            return closed;
        }
        if (!allowFallback) return null;
        window.open(this.buildRoomLoaderUrl(roomId).toString(), '_blank', 'noopener');
        this.scheduleInitialTabLoaderCleanup();
        return null;
    }
}

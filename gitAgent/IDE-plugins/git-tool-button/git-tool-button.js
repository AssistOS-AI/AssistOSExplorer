import { attachGitController } from "./git-tool-button-controller.js";

export class GitToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.cleanupCallbacks = [];
        this.domListenerCleanup = new Map();
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected) return;
        this.button = this.element.querySelector('#gitButton');
        this.iconImageEl = this.element.querySelector('.git-tool-button-icon-image');
        this.labelEl = this.element.querySelector('.git-tool-button-label');
        this.controllerHost = this.createControllerHost();
        attachGitController(this.controllerHost);
        this.syncButtonMetadata();
    }

    openGitPanel() {
        this.controllerHost?.openGitPanel?.();
    }

    afterUnload() {
        const callbacks = this.cleanupCallbacks.splice(0);
        for (const callback of callbacks.reverse()) {
            try {
                callback();
            } catch (_) {
                // ignore cleanup errors
            }
        }
        for (const cleanup of this.domListenerCleanup.values()) {
            try {
                cleanup();
            } catch (_) {
                // ignore cleanup errors
            }
        }
        this.domListenerCleanup.clear();
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === 'string' && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute('data-plugin-label') || 'Git';
        const tooltip = typeof this.hostContext?.pluginTooltip === 'string' && this.hostContext.pluginTooltip.trim()
            ? this.hostContext.pluginTooltip.trim()
            : this.element.getAttribute('data-plugin-tooltip') || label;
        const icon = typeof this.hostContext?.pluginIcon === 'string' && this.hostContext.pluginIcon.trim()
            ? this.hostContext.pluginIcon.trim()
            : this.element.getAttribute('data-plugin-icon') || '';
        const hostSlot = typeof this.hostContext?.slot === 'string' && this.hostContext.slot.trim()
            ? this.hostContext.slot.trim()
            : this.element.getAttribute('data-host-slot') || '';
        const hostOrientation = typeof this.hostContext?.orientation === 'string' && this.hostContext.orientation.trim()
            ? this.hostContext.orientation.trim()
            : this.element.getAttribute('data-host-orientation') || '';
        if (this.button) {
            this.button.setAttribute('aria-label', tooltip);
            if (!this.button.dataset.defaultTitle || this.button.dataset.defaultTitle === this.button.title) {
                this.button.dataset.defaultTitle = tooltip;
            }
            this.button.title = tooltip;
        }
        if (hostSlot) {
            this.element.setAttribute('data-host-slot', hostSlot);
        } else {
            this.element.removeAttribute('data-host-slot');
        }
        if (hostOrientation) {
            this.element.setAttribute('data-host-orientation', hostOrientation);
        } else {
            this.element.removeAttribute('data-host-orientation');
        }
        if (this.iconImageEl && icon) {
            this.iconImageEl.src = icon;
        }
        if (this.labelEl) {
            this.labelEl.textContent = label;
        }
    }

    createControllerHost() {
        const getHostFileExp = () => this.element.closest('file-exp')?.webSkelPresenter || null;
        const addCleanup = (callback) => {
            if (typeof callback === 'function') {
                this.cleanupCallbacks.push(callback);
            }
            return callback;
        };
        const setWindowListener = (key, eventName, handler, options) => {
            const existing = this.domListenerCleanup.get(key);
            if (typeof existing === 'function') {
                existing();
            }
            window.addEventListener(eventName, handler, options);
            const cleanup = () => window.removeEventListener(eventName, handler, options);
            this.domListenerCleanup.set(key, cleanup);
            addCleanup(() => {
                if (this.domListenerCleanup.get(key) === cleanup) {
                    cleanup();
                    this.domListenerCleanup.delete(key);
                }
            });
            return cleanup;
        };

        const presenter = this;
        return {
            element: this.element,
            get toolbarModal() {
                return presenter.hostContext?.pluginToolbarModal;
            },
            get state() {
                return getHostFileExp()?.state || {};
            },
            setWindowListener,
            registerCleanup: addCleanup,
            withLoader(fn) {
                const host = getHostFileExp();
                if (typeof host?.withLoader === 'function') {
                    return host.withLoader(fn);
                }
                return typeof fn === 'function' ? fn() : undefined;
            },
            showStatus(message, isError) {
                const host = getHostFileExp();
                if (typeof host?.showStatus === 'function') {
                    return host.showStatus(message, isError);
                }
                return globalThis.assistOS?.showToast?.(message, isError ? 'error' : 'info', 3000);
            },
            async refresh() {
                return getHostFileExp()?.refresh?.();
            },
            bumpWorkspaceVersion() {
                return getHostFileExp()?.bumpWorkspaceVersion?.();
            },
            get tooling() {
                return getHostFileExp()?.tooling || {};
            }
        };
    }
}

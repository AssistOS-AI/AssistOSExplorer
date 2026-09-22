export class HelpToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.button = this.element.querySelector('#helpToolButton');
        this.iconImageEl = this.element.querySelector('.help-tool-button-icon-image');
        this.labelEl = this.element.querySelector('.help-tool-button-label');
        this.button?.addEventListener('click', this.openHelp);
        this.syncButtonMetadata();
        if (this.button) {
            this.button.hidden = false;
        }
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openHelp);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === 'string' && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute('data-plugin-label') || 'Help';
        const tooltip = typeof this.hostContext?.pluginTooltip === 'string' && this.hostContext.pluginTooltip.trim()
            ? this.hostContext.pluginTooltip.trim()
            : this.element.getAttribute('data-plugin-tooltip') || label;
        const icon = typeof this.hostContext?.pluginIcon === 'string' && this.hostContext.pluginIcon.trim()
            ? this.hostContext.pluginIcon.trim()
            : this.element.getAttribute('data-plugin-icon') || '';

        if (this.labelEl) this.labelEl.textContent = label;
        if (this.iconImageEl && icon) this.iconImageEl.src = icon;
        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute('aria-label', tooltip);
        }
    }

    openHelp = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const descriptor = this.hostContext?.pluginToolbarModal;
        const openExpandedModal = globalThis.assistOS?.UI?.openExpandedModal;
        if (!descriptor || typeof openExpandedModal !== 'function') {
            globalThis.assistOS?.showToast?.('Help could not be opened.', 'error', 3000);
            return;
        }
        void openExpandedModal({
            ...descriptor,
            title: this.hostContext?.pluginLabel || descriptor.title
        });
        this.button?.focus?.();
    };
}

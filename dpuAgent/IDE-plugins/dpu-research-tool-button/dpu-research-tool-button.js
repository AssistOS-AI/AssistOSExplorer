export class DpuResearchToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected) return;
        this.button?.removeEventListener('click', this.boundOpen);
        this.button = this.element.querySelector('#dpuResearchToolButton');
        this.icon = this.element.querySelector('.app-plugin-tool-icon-image');
        this.label = this.element.querySelector('.app-plugin-tool-label');
        this.boundOpen = this.openWebchat.bind(this);
        this.button?.addEventListener('click', this.boundOpen);
        this.syncMetadata();
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.boundOpen);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncMetadata();
    }

    syncMetadata() {
        const label = String(this.hostContext?.pluginLabel || this.element.dataset.pluginLabel || 'DPU Research').trim();
        const tooltip = String(this.hostContext?.pluginTooltip || this.element.dataset.pluginTooltip || label).trim();
        const icon = String(this.hostContext?.pluginIcon || this.element.dataset.pluginIcon || '').trim();
        const orientation = String(this.hostContext?.orientation || this.element.dataset.hostOrientation || '').trim();
        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute('aria-label', tooltip);
        }
        if (this.label) this.label.textContent = label;
        if (this.icon && icon) this.icon.src = icon;
        if (orientation) this.element.dataset.hostOrientation = orientation;
        else delete this.element.dataset.hostOrientation;
    }

    openWebchat(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        try {
            return globalThis.assistOS.UI.openPluginPanel('dpuAgent/dpu-research-launcher');
        } catch (error) {
            globalThis.assistOS?.showToast?.(error.message, 'error', 6000);
        }
    }
}

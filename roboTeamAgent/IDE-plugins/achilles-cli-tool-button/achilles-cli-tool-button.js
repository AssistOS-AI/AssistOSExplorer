import { buildCopilotUrl } from './copilot-launch.js';

export class AchillesCliToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.button = this.element.querySelector('#achillesCliToolButton');
        this.iconImageEl = this.element.querySelector('.achilles-cli-tool-button-icon-image');
        this.labelEl = this.element.querySelector('.achilles-cli-tool-button-label');
        this.boundClick = this.handleClick.bind(this);
        this.button?.addEventListener('click', this.boundClick);
        this.syncButtonMetadata();
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.boundClick);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === 'string' && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute('data-plugin-label') || 'Copilot';
        const tooltip = typeof this.hostContext?.pluginTooltip === 'string' && this.hostContext.pluginTooltip.trim()
            ? this.hostContext.pluginTooltip.trim()
            : this.element.getAttribute('data-plugin-tooltip') || label;
        const icon = typeof this.hostContext?.pluginIcon === 'string' && this.hostContext.pluginIcon.trim()
            ? this.hostContext.pluginIcon.trim()
            : this.element.getAttribute('data-plugin-icon') || '';
        const hostOrientation = typeof this.hostContext?.orientation === 'string' && this.hostContext.orientation.trim()
            ? this.hostContext.orientation.trim()
            : this.element.getAttribute('data-host-orientation') || '';

        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute('aria-label', tooltip);
        }
        if (this.labelEl) {
            this.labelEl.textContent = label;
        }
        if (this.iconImageEl && icon) {
            this.iconImageEl.src = icon;
        }
        if (hostOrientation) {
            this.element.setAttribute('data-host-orientation', hostOrientation);
        } else {
            this.element.removeAttribute('data-host-orientation');
        }
    }

    handleClick() {
        window.open(buildCopilotUrl(this.hostContext), '_blank', 'noopener,noreferrer');
    }
}

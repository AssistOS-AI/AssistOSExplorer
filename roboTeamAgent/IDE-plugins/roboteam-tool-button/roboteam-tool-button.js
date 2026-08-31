const ROBOTEAM_DASHBOARD_PATH = '/base-agent-additional-server/roboTeamAgent/7000/';

export class RoboTeamToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.button = this.element.querySelector('#roboteamToolButton');
        this.iconImageEl = this.element.querySelector('.roboteam-tool-button-icon-image');
        this.labelEl = this.element.querySelector('.roboteam-tool-button-label');
        this.syncButtonMetadata();
        this.button?.addEventListener('click', this.openRoboTeam);
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openRoboTeam);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === 'string' && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute('data-plugin-label') || 'RoboTeam';
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

    openRoboTeam = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        window.open(ROBOTEAM_DASHBOARD_PATH, '_blank', 'noopener,noreferrer');
    };
}

export const HELP_TABS = Object.freeze([
    'explorer',
    'git',
    'webmeet',
    'confidential',
    'copilot',
    'admin'
]);

export function normalizeHelpTab(value) {
    const tab = String(value || '').trim().toLowerCase();
    return HELP_TABS.includes(tab) ? tab : 'explorer';
}

export function getHelpTabTemplateUrl(value) {
    const tab = String(value || '').trim().toLowerCase();
    if (!HELP_TABS.includes(tab)) return null;
    return new URL(`./tabs/${tab}.html`, import.meta.url);
}

export class HelpModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.activeTab = 'explorer';
        this.handleClick = this.handleClick.bind(this);
        this.handleKeydown = this.handleKeydown.bind(this);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected) return;
        this.tabList = this.element.querySelector('[role="tablist"]');
        this.tabButtons = Array.from(this.element.querySelectorAll('[data-help-tab]'));
        this.tabPanels = Array.from(this.element.querySelectorAll('[data-help-panel]'));
        this.helpContent = this.element.querySelector('[data-help-content]');

        this.tabList?.addEventListener('click', this.handleClick);
        this.tabList?.addEventListener('keydown', this.handleKeydown);
        this.activateTab(this.activeTab);
        this.initialLoad = this.loadTabTemplates();
    }

    afterUnload() {
        this.tabLoadController?.abort();
        this.tabList?.removeEventListener('click', this.handleClick);
        this.tabList?.removeEventListener('keydown', this.handleKeydown);
    }

    handleClick(event) {
        const button = event.target?.closest?.('[data-help-tab]');
        if (!button || !this.tabList?.contains(button)) return;
        this.activateTab(button.dataset.helpTab, { focus: true });
    }

    handleKeydown(event) {
        const button = event.target?.closest?.('[data-help-tab]');
        if (!button || !this.tabList?.contains(button)) return;

        const currentIndex = this.tabButtons.indexOf(button);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % this.tabButtons.length;
        else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + this.tabButtons.length) % this.tabButtons.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = this.tabButtons.length - 1;
        else return;

        event.preventDefault();
        this.activateTab(this.tabButtons[nextIndex]?.dataset?.helpTab, { focus: true });
    }

    activateTab(value, { focus = false } = {}) {
        const tab = normalizeHelpTab(value);
        this.activeTab = tab;

        for (const button of this.tabButtons || []) {
            const active = button.dataset.helpTab === tab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
            button.tabIndex = active ? 0 : -1;
            if (active && focus) button.focus();
        }

        for (const panel of this.tabPanels || []) {
            const active = panel.dataset.helpPanel === tab;
            panel.classList.toggle('active', active);
            panel.hidden = !active;
        }
    }

    async loadTabTemplates() {
        this.tabLoadController?.abort();
        const controller = new AbortController();
        this.tabLoadController = controller;
        this.helpContent?.setAttribute('aria-busy', 'true');

        const results = await Promise.allSettled((this.tabPanels || []).map(async (panel) => {
            const tab = panel.dataset.helpPanel;
            const templateUrl = getHelpTabTemplateUrl(tab);
            if (!templateUrl) throw new Error(`Unknown Help tab: ${tab}`);

            const response = await fetch(templateUrl, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`Failed to load Help tab ${tab}: ${response.status}`);
            }
            return response.text();
        }));

        if (controller.signal.aborted || this.tabLoadController !== controller) return;

        results.forEach((result, index) => {
            const panel = this.tabPanels[index];
            if (!panel) return;
            if (result.status === 'fulfilled') {
                panel.innerHTML = result.value;
                return;
            }
            panel.innerHTML = '<p class="help-load-error" role="alert">This Help topic could not be loaded.</p>';
        });
        this.helpContent?.setAttribute('aria-busy', 'false');
    }

}

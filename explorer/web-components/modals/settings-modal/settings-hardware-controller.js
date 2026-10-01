import { createHardwareLimitsApi, hardwareAccessDenied } from '../../../services/infrastructure/hardwareLimitsApi.js';

export const hardwareController = {
    async refreshHardwareAccess() {
        if (this.state.hardwareAccessChecked || this.hardwareClosed) return;
        this.state.hardwareAccessChecked = true;
        this.hardwareAbort = new AbortController();
        try {
            this.hardwareSnapshot = await createHardwareLimitsApi().read({ signal: this.hardwareAbort.signal });
            this.state.hardwareAccess = true;
        } catch (error) {
            this.state.hardwareAccess = !hardwareAccessDenied(error);
        }
        if (this.hardwareClosed) return;
        if (this.state.hardwareAccess && this.requestedInitialTab === 'hardware') {
            this.state.activeTab = 'hardware';
            this.requestedInitialTab = '';
        }
        this.updateTabUI();
        if (this.state.activeTab === 'hardware') await this.loadHardwarePanel();
    },

    async loadHardwarePanel() {
        if (!this.state.hardwareAccess || this.hardwareClosed || this.hardwareMounting) return;
        if (this.hardwareSection?.querySelector('hardware-limits-panel')) return;
        this.hardwareMounting = true;
        try {
            const register = globalThis.assistOS?.webSkel?.ensureComponentRegistered || globalThis.window?.UI?.ensureComponentRegistered;
            if (typeof register !== 'function') throw new Error('Hardware limits component is unavailable.');
            await register('hardware-limits-panel');
            if (this.hardwareClosed || !this.state.hardwareAccess) return;
            const panel = document.createElement('hardware-limits-panel');
            panel.setAttribute('data-presenter', 'hardware-limits-panel');
            panel.hardwareLimitsSnapshot = this.hardwareSnapshot;
            this.hardwareSection.replaceChildren(panel);
            this.hardwareSection.addEventListener('hardware-limits-access-denied', () => {
                this.state.hardwareAccess = false;
                this.hardwareSection.replaceChildren();
                this.updateTabUI();
            }, { once: true });
        } catch (error) {
            if (!this.hardwareClosed && this.hardwareSection) this.hardwareSection.textContent = error.message;
        } finally {
            this.hardwareMounting = false;
        }
    },

    afterUnload() {
        this.hardwareClosed = true;
        this.hardwareAbort?.abort();
    },
};

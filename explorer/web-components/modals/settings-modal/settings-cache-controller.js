import { cacheAccessDenied, createCacheApi } from '../../../services/infrastructure/cacheApi.js';

export const cacheController = {
    async refreshCacheAccess() {
        if (this.cacheAbort || this.hardwareClosed) return;
        this.cacheAbort = new AbortController();
        let snapshot;
        try {
            snapshot = await createCacheApi().read({ signal: this.cacheAbort.signal });
        } catch (error) {
            if (this.hardwareClosed) return;
            this.hideCacheTab(cacheAccessDenied(error)
                ? 'Cache settings require administrator access.'
                : 'Cache settings are unavailable. Refresh Settings to try again.');
            return;
        }
        if (this.hardwareClosed) return;
        this.state.cacheAccess = true;
        const open = this.requestedInitialTab === 'cache';
        if (open) {
            this.state.activeTab = 'cache';
            this.requestedInitialTab = '';
        }
        this.updateTabUI();
        if (open) await this.loadCachePanel(snapshot);
    },

    hideCacheTab(message) {
        this.state.cacheAccess = false;
        this.cacheSection?.replaceChildren();
        if (this.requestedInitialTab === 'cache' || this.state.activeTab === 'cache') {
            if (this.state.activeTab === 'cache') this.switchTab(null, 'agents');
            else {
                this.requestedInitialTab = '';
                this.updateTabUI();
            }
            this.cacheAccessStatus.textContent = message;
            this.cacheAccessStatus.hidden = false;
        } else {
            this.updateTabUI();
        }
    },

    async loadCachePanel(snapshot) {
        if (!this.state.cacheAccess || this.hardwareClosed || this.cacheMounting || this.cacheSection.querySelector('cache-panel')) return;
        this.cacheMounting = true;
        try {
            const register = globalThis.assistOS?.webSkel?.ensureComponentRegistered || globalThis.window?.UI?.ensureComponentRegistered;
            await register('cache-panel');
            if (this.hardwareClosed || !this.state.cacheAccess || this.state.activeTab !== 'cache') return;
            const panel = document.createElement('cache-panel');
            panel.setAttribute('data-presenter', 'cache-panel');
            panel.cacheSnapshot = snapshot;
            panel.addEventListener('cache-access-denied', () => this.hideCacheTab('Cache settings require administrator access.'), { once: true });
            this.cacheSection.replaceChildren(panel);
        } catch {
            if (!this.hardwareClosed) this.cacheSection.textContent = 'Cache settings could not be loaded. Reopen the tab to try again.';
        } finally {
            this.cacheMounting = false;
        }
    },
};

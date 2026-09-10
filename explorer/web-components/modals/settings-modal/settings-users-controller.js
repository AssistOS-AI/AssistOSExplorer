export function getCurrentAgentName(win = globalThis.window) {
    try {
        const parts = win.location.pathname.split('/').filter(Boolean);
        return parts[0] || 'explorer';
    } catch (_) {
        return 'explorer';
    }
}

export const usersController = {
    async refreshUsersAccess() {
        if (this.state.usersAccessChecked) return;
        this.state.usersAccessChecked = true;
        const agentName = getCurrentAgentName();
        try {
            const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/users`, {
                credentials: 'include',
                headers: { Accept: 'application/json' }
            });
            this.state.usersAccess = response.ok;
        } catch (_) {
            this.state.usersAccess = false;
        }
        if (this.state.usersAccess && this.requestedInitialTab === 'users') {
            this.state.activeTab = 'users';
            this.requestedInitialTab = '';
        }
        this.updateTabUI();
    },

    async loadAdministrationPanel() {
        if (!this.adminSettingsPanel || !this.state.usersAccess || this.state.activeTab !== "users"
            || this.state.activeAdministrationTab === "applications") return;
        if (this.adminSettingsPanel.presenterReadyPromise) {
            await this.adminSettingsPanel.presenterReadyPromise.catch(() => {});
        }
        const presenter = this.adminSettingsPanel.webSkelPresenter;
        if (presenter?.loadPage) {
            presenter.loadPage().catch((error) => {
                presenter.setStatus?.(error?.message || 'Administration settings could not be loaded.', 'error');
            });
        }
    }
};

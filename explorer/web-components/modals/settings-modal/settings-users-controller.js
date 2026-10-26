import { buildAccountPageUrl, loadAccountDashboardUrl } from './settings-account-service.js';

export async function fetchAccountAccess(fetchImplementation = globalThis.fetch, dashboard = undefined) {
    const base = dashboard ?? await loadAccountDashboardUrl();
    const response = await fetchImplementation(buildAccountPageUrl(base, 'api/profile'), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || !payload.profile?.user) {
        throw new Error('Account access could not be verified.');
    }
    const capabilities = Array.isArray(payload.profile.capabilities) ? payload.profile.capabilities : [];
    return {
        users: capabilities.includes('admin.users.manage'),
        settings: capabilities.includes('admin.agentSettings.manage'),
    };
}

export const usersController = {
    async refreshUsersAccess() {
        if (this.state.usersAccessChecked) return;
        this.state.usersAccessChecked = true;
        try {
            const dashboard = await loadAccountDashboardUrl();
            if (this.hardwareClosed) return;
            this.state.accountDashboardUrl = dashboard;
            this.state.accountServiceError = '';
            const access = await fetchAccountAccess(globalThis.fetch, dashboard);
            if (this.hardwareClosed) return;
            this.state.usersAccess = access.users;
            this.state.accountSettingsAccess = access.settings;
        } catch (_) {
            if (this.hardwareClosed) return;
            if (!this.state.accountDashboardUrl) {
                this.state.accountServiceError = 'The account integration is unavailable. Refresh Settings to try again.';
            }
            this.state.usersAccess = false;
            this.state.accountSettingsAccess = false;
        }
        if ((this.state.usersAccess || this.state.accountSettingsAccess) && this.requestedInitialTab === 'users') {
            this.state.activeTab = 'users';
            this.requestedInitialTab = '';
        }
        this.updateTabUI();
    },
};

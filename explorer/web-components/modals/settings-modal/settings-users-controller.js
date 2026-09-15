export async function fetchAccountAccess(fetchImplementation = globalThis.fetch) {
    const response = await fetchImplementation('/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/api/profile', {
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
            const access = await fetchAccountAccess();
            this.state.usersAccess = access.users;
            this.state.accountSettingsAccess = access.settings;
        } catch (_) {
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

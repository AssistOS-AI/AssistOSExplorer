import { buildAccountPageUrl } from './settings-account-service.js';

export const accountController = {
    updateAccountLinks() {
        const status = this.element.querySelector('[data-account-status]');
        if (status) {
            status.textContent = this.state.accountServiceError || '';
            status.hidden = !this.state.accountServiceError;
        }
        this.element.querySelectorAll('[data-account-capability]').forEach((link) => {
            link.hidden = link.dataset.accountCapability === 'admin.users.manage'
                ? !this.state.usersAccess
                : !this.state.accountSettingsAccess;
        });
        accountController.updateAdministrationFrame.call(this);
        if (this.state.activeTab === 'account' && this.state.accountDashboardUrl) {
            const frame = this.element.querySelector('[data-account-frame]');
            const source = frame?.getAttribute('src');
            if (frame && (!source || source === 'about:blank')) {
                frame.src = buildAccountPageUrl(this.state.accountDashboardUrl, '', { view: 'account' });
            }
        }
    },

    updateAdministrationFrame() {
        const frame = this.usersSection?.querySelector('iframe')
            || this.element.querySelector('[data-administration-frame]');
        if (!frame) return;
        if (!this.state.accountDashboardUrl || (!this.state.usersAccess && !this.state.accountSettingsAccess)) {
            frame.removeAttribute('src');
            return;
        }
        const source = frame.getAttribute('src');
        if (this.state.activeTab === 'users' && (!source || source === 'about:blank')) {
            const page = this.state.usersAccess ? 'users' : 'applications';
            frame.src = buildAccountPageUrl(this.state.accountDashboardUrl, page + '.html', { view: 'administration', showSignOut: '0' });
        }
    },
};

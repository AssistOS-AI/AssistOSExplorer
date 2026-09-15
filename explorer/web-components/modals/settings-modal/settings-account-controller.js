export const accountController = {
    updateAccountLinks() {
        this.element.querySelectorAll('[data-account-capability]').forEach((link) => {
            link.hidden = link.dataset.accountCapability === 'admin.users.manage'
                ? !this.state.usersAccess
                : !this.state.accountSettingsAccess;
        });
    },
};

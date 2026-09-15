import { UserpersistoSettings } from './management.mjs';
import { updateAccountNavigation } from './api.mjs';

export function mountManagement(document, host = window) {
    const root = document.getElementById('management-root');
    const controls = document.getElementById('management-controls');
    const login = document.getElementById('management-login');
    login.href = `/auth/login?${new URLSearchParams({ returnTo: host.location.pathname })}`;
    const panel = new UserpersistoSettings(root, () => {});
    panel.onAccessChanged = (profile) => {
        updateAccountNavigation(document, profile);
        const allowed = panel.isAdministrator();
        controls.hidden = !allowed;
        controls.disabled = !allowed;
        login.hidden = !!profile;
    };
    panel.afterRender();
    const actions = new Set([
        'searchUsers', 'clearUserSearch', 'previousUsersPage', 'nextUsersPage',
        'saveAuthPolicy', 'newApplication', 'saveApplication', 'refreshApplications',
        'clearApplicationSecret', 'previousApplicationsPage', 'nextApplicationsPage',
    ]);
    root.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-local-action]');
        if (!button || !root.contains(button) || button.disabled || controls.disabled) return;
        const action = button.dataset.localAction;
        if (actions.has(action)) void panel[action]();
    });
    host.addEventListener('pagehide', () => panel.afterUnload(), { once: true });
    host.addEventListener('pageshow', (event) => {
        if (event.persisted) host.location.reload();
    });
    return panel;
}

if (typeof document !== 'undefined') mountManagement(document);

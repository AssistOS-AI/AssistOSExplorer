import {
    initializeTheme,
    EXPLORER_THEME_CHANGE_EVENT,
} from '/explorer/shared/ui/theme.js';

export const DASHBOARD_THEME_CHANGE_EVENT = 'sg-theme-change';

function syncDashboardTheme() {
    const isDark = document.documentElement.classList.contains('theme-dark');
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    window.dispatchEvent(new CustomEvent(DASHBOARD_THEME_CHANGE_EVENT));
}

function applyExplorerTheme() {
    initializeTheme();
    syncDashboardTheme();
}

applyExplorerTheme();
window.addEventListener(EXPLORER_THEME_CHANGE_EVENT, syncDashboardTheme);
window.addEventListener('storage', (event) => {
    const key = event?.key;
    if (key === null || key === 'assistosExplorerTheme' || key === 'webchat_theme') {
        applyExplorerTheme();
    }
});

const SETTINGS_TABS = ['account', 'agents', 'plugins', 'keymap', 'editor', 'theme', 'avatar', 'users', 'hardware'];

export function normalizeSettingsTab(tab) {
    return SETTINGS_TABS.includes(tab) ? tab : 'agents';
}

export function buildSettingsUrl(location, tab) {
    const url = new URL(location.href);
    url.searchParams.set('settings', normalizeSettingsTab(tab));
    if (!url.hash.startsWith('#file-exp')) url.hash = '#file-exp/';
    return url.href;
}

export function readSettingsTab(location) {
    const url = new URL(location.href);
    return url.searchParams.has('settings') ? normalizeSettingsTab(url.searchParams.get('settings')) : null;
}

export function updateSettingsLocation(location, history, tab) {
    if (readSettingsTab(location) === null) return;
    const url = new URL(location.href);
    if (tab === null) url.searchParams.delete('settings');
    else url.searchParams.set('settings', normalizeSettingsTab(tab));
    if (url.href !== location.href) history.replaceState(history.state, '', url.href);
}

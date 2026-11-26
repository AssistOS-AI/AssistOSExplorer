const PLUGIN_KEY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z][A-Za-z0-9._-]*$/;

export function normalizePanelPath(path) {
    if (path === undefined || path === null || path === '') return '';
    if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/')
        || /[\x00-\x1f\x7f\\]/.test(path) || path.includes('//')
        || path.split('/').some(segment => segment === '.' || segment === '..')) {
        throw new Error('The panel navigation path is invalid.');
    }
    return path.replace(/\/+$/, '') || '/';
}

export function readPluginPanelRequest(location) {
    const url = new URL(location.href);
    if (!url.searchParams.has('panel')) return null;
    const pluginKey = url.searchParams.get('panel');
    if (url.searchParams.getAll('panel').length !== 1 || !PLUGIN_KEY_PATTERN.test(pluginKey)
        || url.searchParams.getAll('panelPath').length > 1) {
        throw new Error('The plugin panel link is invalid.');
    }
    return { pluginKey, path: normalizePanelPath(url.searchParams.get('panelPath')) };
}

export function buildPluginPanelUrl(location, pluginKey, navigation = {}) {
    if (!PLUGIN_KEY_PATTERN.test(pluginKey || '')) throw new Error('This panel has no valid plugin identity.');
    // Only navigation crosses tabs. Never serialize component props or drafts.
    const url = new URL(location.pathname || new URL(location.href).pathname, location.href);
    url.search = '';
    url.searchParams.set('panel', pluginKey);
    const path = normalizePanelPath(navigation?.path);
    if (path) url.searchParams.set('panelPath', path);
    url.hash = '#file-exp/';
    return url.href;
}

function browserUrl(value, location) {
    if (!value || value === 'about:blank') return '';
    const url = new URL(value, location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
}

export function resolveExpandedPanelUrl({ location, mode, frame, frameUrl, presenter, pluginKey, navigation }) {
    if (mode === 'component') {
        const dedicated = presenter?.getOpenInNewTabUrl?.();
        if (dedicated) return browserUrl(dedicated, location);
        return buildPluginPanelUrl(location, pluginKey, presenter?.getPanelNavigationContext?.() || navigation);
    }
    let current = '';
    try { current = frame?.contentWindow?.location?.href || ''; } catch (_) { /* Cross-origin frame. */ }
    return browserUrl(current, location) || browserUrl(frameUrl, location);
}

export function clearPluginPanelLocation(location, history, pluginKey) {
    if (!pluginKey || !location?.href || typeof history?.replaceState !== 'function') return;
    const url = new URL(location.href);
    if (url.searchParams.get('panel') !== pluginKey) return;
    url.searchParams.delete('panel');
    url.searchParams.delete('panelPath');
    history.replaceState(history.state, '', url.href);
}

import { callExplorerTool, parseToolResult } from '../../../services/infrastructure/explorerApi.js';
import { getCachedRuntimePlugins } from './settings-plugin-model.js';

const parsingOrigin = 'https://explorer.invalid';

function dashboardUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) {
        throw new Error('The account integration must declare a router-relative settings URL.');
    }
    const url = new URL(value, parsingOrigin);
    if (url.origin !== parsingOrigin || !url.pathname.endsWith('/') || url.hash) {
        throw new Error('The account integration must declare a dashboard directory URL.');
    }
    return url;
}

export function resolveAccountDashboardUrl(runtimePlugins) {
    const entries = runtimePlugins?.agentSettings;
    const matches = Array.isArray(entries) ? entries.filter(entry => entry?.key === 'userpersisto-settings') : [];
    if (matches.length !== 1 || matches[0].adminOnly === true) {
        throw new Error('The account integration is missing or ambiguous in the enabled agent settings.');
    }
    const url = dashboardUrl(matches[0].settingsUrl);
    return url.pathname + url.search;
}

export async function loadAccountDashboardUrl() {
    const cached = getCachedRuntimePlugins();
    const plugins = cached || parseToolResult(await callExplorerTool('collect_ide_plugins', {}, { raw: true, withLoader: false }));
    return resolveAccountDashboardUrl(plugins);
}

export function buildAccountPageUrl(base, page = '', parameters = {}) {
    if (!['', 'users.html', 'applications.html', 'api/profile'].includes(page)) {
        throw new Error('Unsupported account page.');
    }
    const url = dashboardUrl(base);
    url.pathname += page;
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    return url.pathname + url.search;
}

import { normalizeLiveSessionSource, normalizeTerminalProfileSource } from './liveSessionSource.mjs';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const WORKSPACE_FILES_PREFIX = '/workspace-files';

function normalizePathSegments(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .split('/')
        .filter((segment) => segment && segment !== '..' && segment !== '.')
        .join('/');
}

function buildWorkspaceFilesUrl(relativePath) {
    const cleaned = normalizePathSegments(relativePath);
    return cleaned ? `${WORKSPACE_FILES_PREFIX}/${cleaned}` : WORKSPACE_FILES_PREFIX;
}

function joinUrlSegments(base, ...segments) {
    const normalizedBase = String(base || '').replace(/\/+$/, '');
    const normalizedSegments = segments
        .map((segment) => normalizePathSegments(segment))
        .filter(Boolean);
    if (!normalizedSegments.length) {
        return normalizedBase;
    }
    return `${normalizedBase}/${normalizedSegments.join('/')}`.replace(/\/+/g, '/');
}

function getParentPath(value) {
    const cleaned = normalizePathSegments(value);
    if (!cleaned) {
        return '';
    }
    const segments = cleaned.split('/');
    segments.pop();
    return segments.join('/');
}

function resolveDependencyOwnerAssetBaseUrl({
    contributionType,
    assetRootPath,
    assetBaseUrl,
    pluginsBaseUrl,
    ownerComponent,
    component
}) {
    if (!isNonEmptyString(ownerComponent)) {
        return contributionType === MENU_PLUGIN_CONTRIBUTION_TYPE ? '' : assetBaseUrl;
    }

    const normalizedOwner = ownerComponent.trim();
    const normalizedComponent = isNonEmptyString(component) ? component.trim() : '';
    if (contributionType !== MENU_PLUGIN_CONTRIBUTION_TYPE && normalizedOwner === normalizedComponent) {
        return assetBaseUrl;
    }

    if (isNonEmptyString(assetRootPath) && isNonEmptyString(pluginsBaseUrl)) {
        return joinUrlSegments(pluginsBaseUrl, normalizedOwner);
    }

    return contributionType === MENU_PLUGIN_CONTRIBUTION_TYPE ? '' : assetBaseUrl;
}

function resolveRepoRelativeDependencyBaseUrl({ assetRootPath, agent, dependencyPath }) {
    if (!isNonEmptyString(assetRootPath) || !isNonEmptyString(agent) || !isNonEmptyString(dependencyPath)) {
        return '';
    }

    const normalizedDependencyPath = normalizePathSegments(dependencyPath);
    const firstSegment = normalizedDependencyPath.split('/')[0] || '';
    if (!firstSegment || firstSegment === 'components' || firstSegment === 'modals' || firstSegment === 'IDE-plugins') {
        return '';
    }

    const normalizedAssetRoot = normalizePathSegments(assetRootPath);
    const marker = `/${agent.trim()}/IDE-plugins/`;
    const markerIndex = `/${normalizedAssetRoot}/`.indexOf(marker);
    if (markerIndex < 0) {
        return '';
    }

    const repoRootPath = normalizePathSegments(normalizedAssetRoot.slice(0, markerIndex));
    return repoRootPath ? buildWorkspaceFilesUrl(`${repoRootPath}/${normalizedDependencyPath}`) : '';
}

export const DOCUMENT_PLUGIN_CATEGORY = 'document';
export const APPLICATION_PLUGIN_CATEGORY = 'application';
export const MENU_PLUGIN_CONTRIBUTION_TYPE = 'menu';
export const DEFAULT_DOCUMENT_PLUGIN_LOCATIONS = ['document', 'chapter', 'paragraph', 'infoText'];

export function getRuntimePluginPolicyKey(entry) {
    const category = isNonEmptyString(entry?.pluginCategory) ? entry.pluginCategory.trim() : '';
    const agent = isNonEmptyString(entry?.agent) ? entry.agent.trim() : '';
    if (!agent) {
        return '';
    }
    if (category === DOCUMENT_PLUGIN_CATEGORY) {
        const component = isNonEmptyString(entry?.component) ? entry.component.trim() : '';
        return component ? `${agent}/${component}` : '';
    }
    const pluginId = isNonEmptyString(entry?.id) ? entry.id.trim() : '';
    return agent && pluginId ? `${agent}/${pluginId}` : '';
}

export function getApplicationPluginPolicyKey(entry) {
    return getRuntimePluginPolicyKey(entry);
}

function normalizeNumericOrder(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

function computeStableHash(value) {
    const input = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function getRuntimePluginOrder(entry) {
    if (!entry || typeof entry !== 'object') {
        return Number.POSITIVE_INFINITY;
    }
    return normalizeNumericOrder(
        entry.locationOrder ?? entry.order ?? entry.sortOrder
    );
}

export function getRuntimePluginStableKey(entry) {
    const policyKey = getRuntimePluginPolicyKey(entry);
    if (policyKey) {
        return policyKey;
    }
    const component = isNonEmptyString(entry?.component) ? entry.component.trim() : '';
    const label = isNonEmptyString(entry?.label) ? entry.label.trim() : '';
    return component || label || '';
}

export function compareRuntimePluginEntries(left, right) {
    const leftOrder = getRuntimePluginOrder(left);
    const rightOrder = getRuntimePluginOrder(right);
    if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
    }

    const leftKey = getRuntimePluginStableKey(left);
    const rightKey = getRuntimePluginStableKey(right);
    const hashDelta = computeStableHash(leftKey) - computeStableHash(rightKey);
    if (hashDelta !== 0) {
        return hashDelta;
    }

    return leftKey.localeCompare(rightKey, undefined, { sensitivity: 'base' });
}

export function sortRuntimePluginEntries(entries) {
    return Array.isArray(entries)
        ? [...entries].sort(compareRuntimePluginEntries)
        : [];
}

function createEmptyRuntimePluginState() {
    return {
        [DOCUMENT_PLUGIN_CATEGORY]: Object.fromEntries(DEFAULT_DOCUMENT_PLUGIN_LOCATIONS.map((loc) => [loc, []])),
        [APPLICATION_PLUGIN_CATEGORY]: {}
    };
}

function ensureRuntimePluginBucket(buckets, category, location) {
    if (!buckets[category] || typeof buckets[category] !== 'object' || Array.isArray(buckets[category])) {
        buckets[category] = {};
    }
    if (!Array.isArray(buckets[category][location])) {
        buckets[category][location] = [];
    }
    return buckets[category][location];
}

export function forEachRuntimePluginEntry(runtimePlugins, visitor) {
    if (!runtimePlugins || typeof runtimePlugins !== 'object' || typeof visitor !== 'function') {
        return;
    }

    for (const category of [DOCUMENT_PLUGIN_CATEGORY, APPLICATION_PLUGIN_CATEGORY]) {
        const buckets = runtimePlugins[category];
        if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) {
            continue;
        }
        for (const [location, entries] of Object.entries(buckets)) {
            if (!Array.isArray(entries)) {
                continue;
            }
            for (const entry of entries) {
                visitor(entry, {
                    category,
                    location
                });
            }
        }
    }
}

export function resolveRuntimeAssetUrl(agent, component, assetPath, fallback = '', {assetBaseUrl, pluginsBaseUrl} = {}) {
    if (!isNonEmptyString(agent) || !isNonEmptyString(component)) {
        return assetPath;
    }
    const effectiveAssetBaseUrl = isNonEmptyString(assetBaseUrl)
        ? assetBaseUrl.trim().replace(/\/+$/, '')
        : `/${agent}/IDE-plugins/${component}`;
    const effectivePluginsBaseUrl = isNonEmptyString(pluginsBaseUrl)
        ? pluginsBaseUrl.trim().replace(/\/+$/, '')
        : `/${agent}/IDE-plugins`;
    if (!isNonEmptyString(assetPath)) {
        return fallback ? joinUrlSegments(effectiveAssetBaseUrl, fallback) : effectiveAssetBaseUrl;
    }
    const trimmed = assetPath.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) {
        return trimmed;
    }
    if (trimmed.startsWith(`${WORKSPACE_FILES_PREFIX}/`)) {
        return trimmed;
    }
    const withoutLeadingSlash = trimmed.replace(/^\/+/, '');
    if (withoutLeadingSlash.startsWith(`${agent}/IDE-plugins/`)) {
        const relativeToPlugins = withoutLeadingSlash.slice(`${agent}/IDE-plugins/`.length);
        return joinUrlSegments(effectivePluginsBaseUrl, relativeToPlugins);
    }
    if (withoutLeadingSlash.startsWith('IDE-plugins/')) {
        const relativeToPlugins = withoutLeadingSlash.slice('IDE-plugins/'.length);
        return joinUrlSegments(effectivePluginsBaseUrl, relativeToPlugins);
    }
    const cleaned = normalizePathSegments(withoutLeadingSlash.replace(/^\.\/+/, ''));
    return joinUrlSegments(effectiveAssetBaseUrl, cleaned);
}

export function computeComponentBaseUrl(agent, component, {
    ownerComponent,
    isDependency,
    customPath,
    assetBaseUrl,
    pluginsBaseUrl,
    ownerAssetBaseUrl
} = {}) {
    if (!isNonEmptyString(agent) || !isNonEmptyString(component)) {
        return '';
    }
    const effectiveAssetBaseUrl = isNonEmptyString(assetBaseUrl)
        ? assetBaseUrl.trim().replace(/\/+$/, '')
        : `/${agent}/IDE-plugins/${component}`;
    const effectivePluginsBaseUrl = isNonEmptyString(pluginsBaseUrl)
        ? pluginsBaseUrl.trim().replace(/\/+$/, '')
        : `/${agent}/IDE-plugins`;
    if (isNonEmptyString(customPath)) {
        const customPathBase = isDependency && isNonEmptyString(ownerAssetBaseUrl)
            ? ownerAssetBaseUrl.trim().replace(/\/+$/, '')
            : effectivePluginsBaseUrl;
        return joinUrlSegments(customPathBase, customPath);
    }
    if (isDependency && isNonEmptyString(ownerComponent) && ownerComponent.trim() !== component.trim()) {
        const child = component.trim();
        if (isNonEmptyString(ownerAssetBaseUrl)) {
            return joinUrlSegments(ownerAssetBaseUrl, 'components', child, child);
        }
        const owner = ownerComponent.trim();
        return `/${agent}/IDE-plugins/${owner}/components/${child}/${child}`;
    }
    return joinUrlSegments(effectiveAssetBaseUrl, component);
}

export function normalizeRuntimePlugins(runtimePlugins) {
    const normalized = createEmptyRuntimePluginState();
    if (!runtimePlugins || typeof runtimePlugins !== 'object') {
        return normalized;
    }

    forEachRuntimePluginEntry(runtimePlugins, (entry, { category, location }) => {
        const bucket = ensureRuntimePluginBucket(normalized, category, location);
        if (!entry || typeof entry !== 'object') {
            return;
        }

        const agent = isNonEmptyString(entry.agent) ? entry.agent.trim() : '';
        if (entry.contributionType === 'live-sessions-source') {
            const liveSessions = normalizeLiveSessionSource(entry.liveSessions, agent);
            if (category !== APPLICATION_PLUGIN_CATEGORY || location !== 'live-sessions:source' || !liveSessions
                || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(entry.id) || !isNonEmptyString(entry.label)) return;
            bucket.push({
                pluginCategory: category, contributionType: 'live-sessions-source', location,
                agent, id: entry.id, label: entry.label || agent, liveSessions, runtime: true,
            });
            return;
        }
        if (entry.contributionType === 'terminal-profile-source') {
            const terminalProfiles = normalizeTerminalProfileSource(entry.terminalProfiles, agent);
            if (category !== APPLICATION_PLUGIN_CATEGORY || location !== 'terminal-profiles:source' || !terminalProfiles
                || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(entry.id) || !isNonEmptyString(entry.label)) return;
            bucket.push({
                pluginCategory: category, contributionType: 'terminal-profile-source', location,
                agent, id: entry.id, label: entry.label || agent, terminalProfiles, runtime: true,
            });
            return;
        }
        // mountOnStart asks the host to mount a toolbar plugin at start instead of on first use; it must be a boolean.
        if (entry.mountOnStart !== undefined && typeof entry.mountOnStart !== 'boolean') return;
        const contributionType = entry?.contributionType === MENU_PLUGIN_CONTRIBUTION_TYPE ? MENU_PLUGIN_CONTRIBUTION_TYPE : 'mount';
        const component = isNonEmptyString(entry.component) ? entry.component.trim() : '';
        if (contributionType !== MENU_PLUGIN_CONTRIBUTION_TYPE && !component) {
            return;
        }

        const assetRootPath = isNonEmptyString(entry.assetRootPath) ? normalizePathSegments(entry.assetRootPath) : '';
        const pluginRootUrl = assetRootPath
            ? buildWorkspaceFilesUrl(assetRootPath)
            : `/${agent}/IDE-plugins/${component}`;
        const assetBaseUrl = pluginRootUrl;
        const pluginsBaseUrl = assetRootPath
            ? buildWorkspaceFilesUrl(getParentPath(assetRootPath))
            : `/${agent}/IDE-plugins`;
        const baseUrl = contributionType !== MENU_PLUGIN_CONTRIBUTION_TYPE
            ? computeComponentBaseUrl(agent, component, {
                assetBaseUrl,
                pluginsBaseUrl
            })
            : '';
        const menuModuleUrl = isNonEmptyString(entry.menuModule)
            ? joinUrlSegments(pluginRootUrl, entry.menuModule)
            : undefined;
        const locationPresentation = contributionType === MENU_PLUGIN_CONTRIBUTION_TYPE
            && entry.presentation
            && typeof entry.presentation === 'object'
            && !Array.isArray(entry.presentation)
            && entry.presentation[location]
            && typeof entry.presentation[location] === 'object'
                ? entry.presentation[location]
                : null;
        const normalizedEntry = {
            ...entry,
            pluginCategory: category,
            contributionType,
            location,
            id: isNonEmptyString(entry.id) ? entry.id.trim() : undefined,
            component: component || undefined,
            label: isNonEmptyString(locationPresentation?.label)
                ? locationPresentation.label.trim()
                : isNonEmptyString(entry.label)
                    ? entry.label.trim()
                : isNonEmptyString(entry.tooltip)
                    ? entry.tooltip.trim()
                    : component || 'Plugin',
            tooltip: isNonEmptyString(locationPresentation?.tooltip)
                ? locationPresentation.tooltip.trim()
                : isNonEmptyString(entry.tooltip) ? entry.tooltip : component || 'Plugin',
            presenter: contributionType !== MENU_PLUGIN_CONTRIBUTION_TYPE && isNonEmptyString(entry.presenter) ? entry.presenter.trim() : undefined,
            type: contributionType !== MENU_PLUGIN_CONTRIBUTION_TYPE && isNonEmptyString(entry.type) ? entry.type : 'embedded',
            autoPin: Boolean(entry.autoPin),
            mountOnStart: entry.mountOnStart === true,
            agent,
            icon: resolveRuntimeAssetUrl(agent, component || 'plugin', entry.icon, 'icon.svg', {
                assetBaseUrl,
                pluginsBaseUrl
            }),
            runtime: true,
            componentBaseUrl: baseUrl || undefined,
            assetBaseUrl,
            pluginRootUrl,
            menuModuleUrl
        };

        if (Array.isArray(entry.dependencies) && entry.dependencies.length > 0) {
            normalizedEntry.dependencies = entry.dependencies.map((dependency) => {
                if (!dependency || typeof dependency !== 'object') {
                    return dependency;
                }
                const dependencyAgent = isNonEmptyString(dependency.agent) ? dependency.agent : agent;
                const dependencyName = isNonEmptyString(dependency.component)
                    ? dependency.component
                    : isNonEmptyString(dependency.name)
                        ? dependency.name
                        : '';
                const dependencyPath = isNonEmptyString(dependency.path) ? dependency.path : dependency.directory;
                const dependencyOwnerComponent = dependency.ownerComponent || component || dependencyName;
                const explicitBaseUrl = isNonEmptyString(dependency.baseUrl)
                    ? dependency.baseUrl.trim()
                    : '';
                const repoRelativeBaseUrl = resolveRepoRelativeDependencyBaseUrl({
                    assetRootPath,
                    agent,
                    dependencyPath
                });
                return {
                    ...dependency,
                    agent: dependencyAgent,
                    component: dependencyName,
                    baseUrl: explicitBaseUrl || repoRelativeBaseUrl || computeComponentBaseUrl(dependencyAgent, dependencyName, {
                        ownerComponent: dependencyOwnerComponent,
                        isDependency: true,
                        customPath: dependencyPath,
                        pluginsBaseUrl,
                        ownerAssetBaseUrl: resolveDependencyOwnerAssetBaseUrl({
                            contributionType,
                            assetRootPath,
                            assetBaseUrl,
                            pluginsBaseUrl,
                            ownerComponent: dependencyOwnerComponent,
                            component
                        })
                    })
                };
            });
        }

        bucket.push(normalizedEntry);
    });

    forEachRuntimePluginEntry(normalized, (_entry, { category, location }) => {
        normalized[category][location] = sortRuntimePluginEntries(normalized[category][location]);
    });

    return normalized;
}

export function mergeRuntimePluginsIntoAssistOS(assistOS, runtimePlugins) {
    if (!assistOS || !assistOS.workspace) {
        return;
    }

    const workspaceDocumentPlugins = assistOS.workspace.plugins || {};
    const workspaceApplicationPlugins = assistOS.workspace.appPlugins || {};
    assistOS.workspace.plugins = workspaceDocumentPlugins;
    assistOS.workspace.appPlugins = workspaceApplicationPlugins;

    forEachRuntimePluginEntry(runtimePlugins, (entry, { category, location }) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }

        const targetRegistry = category === APPLICATION_PLUGIN_CATEGORY
            ? workspaceApplicationPlugins
            : workspaceDocumentPlugins;

        if (!Array.isArray(targetRegistry[location])) {
            targetRegistry[location] = [];
        }

        const bucket = targetRegistry[location];
        const entryKey = getRuntimePluginStableKey(entry);
        const existingIndex = bucket.findIndex((plugin) => plugin && getRuntimePluginStableKey(plugin) === entryKey);
        if (existingIndex !== -1) {
            bucket.splice(existingIndex, 1);
        }

        bucket.push(entry);
    });
}

export function filterRuntimePluginsByPolicy(runtimePlugins, runtimePluginPolicy) {
    const normalizedPolicy = runtimePluginPolicy && typeof runtimePluginPolicy === 'object' && !Array.isArray(runtimePluginPolicy)
        ? runtimePluginPolicy
        : null;

    if (!normalizedPolicy) {
        return runtimePlugins;
    }

    const filtered = createEmptyRuntimePluginState();
    if (Array.isArray(runtimePlugins?.agentSettings)) {
        filtered.agentSettings = runtimePlugins.agentSettings;
    }

    forEachRuntimePluginEntry(runtimePlugins, (entry, { category, location }) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }

        const key = getRuntimePluginPolicyKey(entry);
        if (key && normalizedPolicy[key] === false) {
            return;
        }

        const bucket = ensureRuntimePluginBucket(filtered, category, location);
        bucket.push(entry);
    });

    return filtered;
}

export async function fetchTextOrThrow(url, description) {
    const response = await fetch(url, {cache: 'no-cache'});
    if (!response.ok) {
        const error = new Error(`${description} (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return response.text();
}

export async function fetchOptionalText(url) {
    const response = await fetch(url, {cache: 'no-cache'});
    if (!response.ok) {
        return '';
    }
    return response.text();
}

export function scopeCssToComponent(cssText, componentName) {
    if (!isNonEmptyString(cssText) || !isNonEmptyString(componentName)) {
        return cssText || '';
    }
    const tag = componentName.trim();

    const scopeSelector = (selector) => {
        if (!selector) return '';
        let scoped = selector.trim();
        if (!scoped) return '';
        scoped = scoped.replace(/:host\b/g, tag);
        if (scoped.startsWith(tag) || scoped.startsWith('@')) {
            return scoped;
        }
        return `${tag} ${scoped}`;
    };

    return cssText.replace(/(^|})\s*([^{}@][^{}]*)\{/g, (match, prefix, selectorGroup) => {
        const scopedSelectors = selectorGroup
            .split(',')
            .map(scopeSelector)
            .filter(Boolean)
            .join(', ');
        return `${prefix} ${scopedSelectors} {`;
    });
}

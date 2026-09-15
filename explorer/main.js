import WebSkel from './shared/libs/webskel/webskel.mjs';
import assistosSDK, { initialiseAssistOS } from './services/assistosSDK.js';
import { createComponentRegistry } from './services/runtime/componentRegistry.js';
import { createRuntimePluginLoader } from './services/runtime/runtimePluginLoader.js';
import { installExplorerResourceLoader } from './services/runtime/explorerResourceLoader.js';
import { filterRuntimePluginsByPolicy, forEachRuntimePluginEntry } from './utils/pluginUtils.core.js';
import { initializeTheme } from './shared/ui/theme.js';
import { fetchAuthenticatedUser } from './services/infrastructure/authApi.js';
import { isAdminUser } from './services/auth/adminUser.js';
import {
    completeInitialApplicationRoute,
    mountInitialApplicationRoute,
    resolveInitialHashedRoute
} from './services/runtime/initial-application-route.js';
import { installAuthNavigationGuard } from './services/infrastructure/authNavigationGuard.js';
import {
    clearBootstrapReloadState,
    getRuntimeUnavailableNotice,
    scheduleBootstrapReload
} from './services/runtime/bootstrapRecovery.js';
import { waitForAgentRuntimeAvailability } from './shared/ui/agent-runtime-loader/agent-runtime-loader.js';
import {
    parseAgentRuntimeWaitRoute,
    probeAgentRuntimeMcp,
    probeAgentRuntimeRouteStability,
    probeAgentRuntimeTarget
} from './shared/ui/agent-runtime-loader/agent-runtime-wait-route.js';

const EXPLORER_AGENT_ID = 'explorer';
const RUNTIME_PLUGIN_TOOL = 'collect_ide_plugins';
const ROOM_ID_PATTERN = /^room_[0-9a-fA-F-]{36}$/;
const RUNTIME_PLUGINS_UPDATED_EVENT = 'assistos:runtime-plugins-updated';
const RUNTIME_PLUGIN_MOUNT_GRACE_MS = 2500;

function resolveRuntimeWaitRoute(hashValue) {
    try {
        return parseAgentRuntimeWaitRoute(hashValue, window.location.origin);
    } catch (_) {
        return null;
    }
}

function updateSpinnerStatus(root, { title, message }) {
    const caption = root?.querySelector?.('.spinner-caption');
    if (!caption) return;
    caption.hidden = false;
    const titleElement = caption.querySelector('.spinner-title');
    const messageElement = caption.querySelector('.spinner-subtitle');
    if (titleElement) titleElement.textContent = title;
    if (messageElement) messageElement.textContent = message;
}

async function waitForInitialAgentRuntime(route) {
    const loader = document.querySelector('#before_webskel_loader');
    const spinner = loader?.querySelector?.('.spinner-orbit');
    const retryButton = loader?.querySelector?.('[data-role="runtime-retry"]');

    while (true) {
        if (spinner) spinner.hidden = false;
        if (retryButton) retryButton.hidden = true;
        updateSpinnerStatus(loader, {
            title: `Starting ${route.label}`,
            message: `Waiting for ${route.label} to become available. This page will open automatically.`
        });
        try {
            await waitForAgentRuntimeAvailability({
                agentRef: route.agentRef,
                label: route.label,
                timeoutMs: Number.POSITIVE_INFINITY,
                operation: async () => {
                    await probeAgentRuntimeRouteStability(route.agentRef);
                    await probeAgentRuntimeTarget(route.targetUrl);
                    await probeAgentRuntimeMcp(route.agentRef, assistosSDK);
                    return route.targetUrl;
                }
            });
            window.location.replace(route.targetUrl.toString());
            return;
        } catch (error) {
            if (spinner) spinner.hidden = true;
            updateSpinnerStatus(loader, {
                title: `${route.label} could not start`,
                message: String(error?.message || `${route.label} is unavailable.`)
            });
            if (!retryButton) return;
            retryButton.hidden = false;
            await new Promise((resolve) => retryButton.addEventListener('click', resolve, { once: true }));
        }
    }
}

if (typeof window !== 'undefined') {
    window.ASSISTOS_AGENT_ID = window.ASSISTOS_AGENT_ID || EXPLORER_AGENT_ID;
    installAuthNavigationGuard();
}

const hasRuntimePlugins = (runtimePlugins) => {
    if (!runtimePlugins) {
        return false;
    }
    return Object.values(runtimePlugins).some((buckets) => (
        buckets
        && typeof buckets === 'object'
        && !Array.isArray(buckets)
        && Object.values(buckets).some((entries) => Array.isArray(entries) && entries.length > 0)
    ));
};

const getRuntimeComponentPolicy = (runtimePlugins, componentName) => {
    let policy = null;
    forEachRuntimePluginEntry(runtimePlugins, (plugin) => {
        if (policy || !plugin || typeof plugin !== 'object') return;
        const ownsComponent = plugin.component === componentName
            || (Array.isArray(plugin.dependencies)
                && plugin.dependencies.some((dependency) => (dependency?.component || dependency?.name) === componentName));
        if (ownsComponent) policy = { adminOnly: plugin.adminOnly === true };
    });
    return policy;
};

const normalizePluginSettings = (payload) => {
    const plugins = payload?.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
        return {};
    }
    return plugins;
};

const normalizeRuntimePluginPolicy = (payload) => {
    const raw = payload?.applicationPlugins;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const normalized = {};
    for (const [key, value] of Object.entries(raw)) {
        const trimmedKey = typeof key === 'string' ? key.trim() : '';
        if (!trimmedKey || typeof value !== 'boolean') {
            continue;
        }
        normalized[trimmedKey] = value;
    }
    return normalized;
};

const parseAllowedDirectories = (result) => {
    if (Array.isArray(result?.json)) {
        return result.json.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    if (typeof result?.text !== 'string') {
        return [];
    }
    return result.text
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry && !/^allowed directories:?$/i.test(entry));
};

function getRoomEntryFromUrl() {
    if (typeof window === 'undefined') {
        return null;
    }
    const params = new URLSearchParams(window.location.search || '');
    const roomId = String(params.get('roomId') || '').trim();
    if (!ROOM_ID_PATTERN.test(roomId)) {
        return null;
    }
    return {
        roomId
    };
}

function hasWebMeetRuntimePlugin(runtimePlugins) {
    let found = false;
    forEachRuntimePluginEntry(runtimePlugins, (plugin) => {
        const agent = String(plugin?.agent || '').trim();
        const id = String(plugin?.id || '').trim();
        const component = String(plugin?.component || '').trim();
        if (agent === 'webmeetAgent' && (id === 'webmeet' || component === 'webmeet-tool-button')) {
            found = true;
        }
    });
    return found;
}

async function bootstrapWorkspaceRoot() {
    try {
        const result = await assistosSDK.callTool(EXPLORER_AGENT_ID, 'list_allowed_directories', {});
        const roots = parseAllowedDirectories(result);
        const workspaceRoot = roots.find((entry) => entry.startsWith('/')) || '';
        if (!workspaceRoot || typeof window === 'undefined') {
            return workspaceRoot;
        }
        window.ASSISTOS_FS_ROOT = workspaceRoot;
        window.MCP_FS_ROOT = window.MCP_FS_ROOT || workspaceRoot;
        return workspaceRoot;
    } catch (_) {
        return '';
    }
}

async function loadExplorerManifest() {
    try {
        const response = await fetch('./manifest.json', { cache: 'no-cache' });
        if (!response.ok) {
            return {};
        }
        const parsed = await response.json();
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

async function start() {
    initializeTheme();
    const initialHashedRoute = resolveInitialHashedRoute(window.location.hash);
    const runtimeWaitRoute = initialHashedRoute?.pageName === 'agent-runtime-wait'
        ? resolveRuntimeWaitRoute(window.location.hash)
        : null;
    if (runtimeWaitRoute) {
        updateSpinnerStatus(document.querySelector('#before_webskel_loader'), {
            title: `Starting ${runtimeWaitRoute.label}`,
            message: `Waiting for ${runtimeWaitRoute.label} to become available. This page will open automatically.`
        });
        await waitForInitialAgentRuntime(runtimeWaitRoute);
        return;
    }
    const roomEntry = getRoomEntryFromUrl();
    const workspaceRootPromise = roomEntry ? Promise.resolve('') : bootstrapWorkspaceRoot();
    const webSkel = await WebSkel.initialise('webskel.json');
    installExplorerResourceLoader(webSkel);
    webSkel.appServices = assistosSDK;
    await workspaceRootPromise;

    const componentRegistry = createComponentRegistry(webSkel);
    const runtimePluginLoader = createRuntimePluginLoader({
        agentId: EXPLORER_AGENT_ID,
        runtimePluginTool: RUNTIME_PLUGIN_TOOL,
        assistosSDK,
        componentRegistry
    });
    const assistOS = initialiseAssistOS({
        ui: webSkel
    });
    assistOS.webSkel = webSkel;
    assistOS.appServices = assistosSDK;
    assistOS.runtimePlugins = null;
    assistOS.rawRuntimePlugins = {};
    assistOS.pluginSettings = {};

    const runtimeContext = {
        authenticatedUser: null,
        plugins: null,
        policy: {},
        promise: null
    };

    const loadRuntimeContext = () => {
        if (runtimeContext.promise) {
            return runtimeContext.promise;
        }
        const pending = (async () => {
            const [explorerManifest, pluginPayload, pluginSettingsResult, authenticatedUser] = await Promise.all([
                loadExplorerManifest(),
                runtimePluginLoader.fetchRuntimePlugins(),
                roomEntry
                    ? Promise.resolve({ json: {} })
                    : assistosSDK.callTool(EXPLORER_AGENT_ID, 'get_plugin_settings', {}),
                fetchAuthenticatedUser()
            ]);
            const runtimePluginPolicy = normalizeRuntimePluginPolicy(explorerManifest);
            const runtimePlugins = filterRuntimePluginsByPolicy(pluginPayload.normalized, runtimePluginPolicy);
            const filteredRawRuntimePlugins = filterRuntimePluginsByPolicy(pluginPayload.raw, runtimePluginPolicy);

            runtimeContext.authenticatedUser = authenticatedUser;
            runtimeContext.plugins = runtimePlugins;
            runtimeContext.policy = runtimePluginPolicy;

            if (authenticatedUser) {
                assistOS.user = authenticatedUser;
            }
            assistOS.explorerManifest = explorerManifest;
            assistOS.applicationPluginPolicy = runtimePluginPolicy;
            assistOS.runtimePlugins = runtimePlugins;
            assistOS.rawRuntimePlugins = filteredRawRuntimePlugins || {};
            assistOS.pluginSettings = normalizePluginSettings(pluginSettingsResult?.json);
            if (hasRuntimePlugins(runtimePlugins)) {
                runtimePluginLoader.mergeIntoAssistOS(assistOS, runtimePlugins);
            }
            return runtimeContext;
        })();
        runtimeContext.promise = pending;
        pending.catch(() => {
            if (runtimeContext.promise === pending) {
                runtimeContext.promise = null;
            }
        });
        return pending;
    };

    const installRuntimeComponentGuards = () => {
        const ensureComponentRegistered = async (componentName) => {
            const normalizedName = typeof componentName === 'string' ? componentName.trim() : '';
            if (!normalizedName) {
                return null;
            }
            const hostComponent = webSkel.configs?.components?.find((component) => component.name === normalizedName);
            if (hostComponent) {
                return null;
            }
            const context = await loadRuntimeContext();
            const componentPolicy = getRuntimeComponentPolicy(context.plugins, normalizedName);
            if (componentPolicy?.adminOnly && !isAdminUser(context.authenticatedUser)) {
                const error = new Error('Administrator access is required for this component.');
                error.code = 'ADMIN_REQUIRED';
                throw error;
            }
            return runtimePluginLoader.ensureComponentRegistered(normalizedName, context.plugins);
        };

        webSkel.ensureComponentRegistered = ensureComponentRegistered;

        const preventModalEscape = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
            }
        };

        const findComponentConfig = (componentName) => (
            webSkel.configs?.components?.find((component) => component.name === componentName) || null
        );

        const appendModalComponent = (dialog, componentName, payload = {}, observeProps = false) => {
            const config = findComponentConfig(componentName);
            const hasPresenter = Boolean(config?.presenterClassName);
            if (observeProps) {
                const proxy = webSkel.createElement(
                    componentName,
                    null,
                    payload || {},
                    hasPresenter ? { 'data-presenter': componentName } : {},
                    true
                );
                dialog.appendChild(proxy.element?.deref?.() || proxy);
                return proxy;
            }
            const component = document.createElement(componentName);
            if (hasPresenter) {
                component.setAttribute('data-presenter', componentName);
            }
            for (const [key, value] of Object.entries(payload || {})) {
                component.setAttribute(`data-${key}`, value);
            }
            dialog.appendChild(component);
            return component;
        };

        const waitForModalRender = async (dialog) => {
            const renderedComponents = Array.from(dialog.querySelectorAll('[data-presenter]'))
                .map(async (component) => {
                    if (component.presenterReadyPromise?.then) {
                        await component.presenterReadyPromise;
                    }
                    await Promise.resolve();
                    if (component.renderCompletePromise?.then) {
                        await component.renderCompletePromise;
                    }
                });
            if (renderedComponents.length) {
                await Promise.allSettled(renderedComponents);
            }
        };

        const createHiddenModalDialog = (componentName, payload = {}) => {
            const dialog = document.createElement('dialog');
            dialog.classList.add('modal', `${componentName}-dialog`);
            Object.assign(dialog, {
                component: componentName,
                cssClass: componentName,
                componentProps: payload
            });
            return dialog;
        };

        const openRenderedModal = async (dialog) => {
            document.body.appendChild(dialog);
            await waitForModalRender(dialog);
            dialog.showModal();
            dialog.addEventListener('keydown', preventModalEscape);
        };

        webSkel.showModal = async (componentName, payload = {}, expectResult = false) => {
            await ensureComponentRegistered(componentName);
            const dialog = createHiddenModalDialog(componentName, payload);
            appendModalComponent(dialog, componentName, payload, false);
            const result = expectResult
                ? new Promise((resolve) => {
                    dialog.addEventListener('close', (event) => resolve(event.data), { once: true });
                })
                : dialog;
            await openRenderedModal(dialog);
            return result;
        };

        webSkel.createReactiveModal = async (componentName, payload = {}, expectResult = false) => {
            await ensureComponentRegistered(componentName);
            const dialog = createHiddenModalDialog(componentName, payload);
            const proxy = appendModalComponent(dialog, componentName, payload, true);
            Object.assign(dialog, { _componentProxy: proxy });
            const reactiveDialog = new Proxy(dialog, {
                get(target, property) {
                    return property === 'props' ? proxy : Reflect.get(target, property);
                }
            });
            const result = expectResult
                ? new Promise((resolve) => {
                    dialog.addEventListener('close', (event) => resolve(event.data), { once: true });
                })
                : reactiveDialog;
            await openRenderedModal(dialog);
            return result;
        };

        const originalChangeToDynamicPage = webSkel.changeToDynamicPage;
        if (typeof originalChangeToDynamicPage === 'function') {
            webSkel.changeToDynamicPage = async (componentName, ...args) => {
                await ensureComponentRegistered(componentName);
                return originalChangeToDynamicPage.call(webSkel, componentName, ...args);
            };
        }
    };

    installRuntimeComponentGuards();

    if (typeof window !== 'undefined') {
        window.UI = webSkel;
    }

    webSkel.setLoading(`
        <div class="spinner-container">
            <div class="spinner-shell">
                <div class="spinner-orbit">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>
    `);
    const pageContent = document.querySelector("#page_content");
    webSkel.setDomElementForPages(pageContent);
    const loader = document.querySelector("#before_webskel_loader");

    let pageName;
    let url;
    let suppressNavigationHash = false;
    if (initialHashedRoute) {
        ({ pageName, url, preserveHash: suppressNavigationHash } = initialHashedRoute);
    } else if (ROOM_ID_PATTERN.test(String(new URLSearchParams(window.location.search || '').get('roomId') || '').trim())) {
        pageName = 'webmeet-dashboard';
        url = 'webmeet-dashboard';
    } else {
        pageName = 'file-exp';
        url = 'file-exp';
    }

    const isFileExplorerRoute = !roomEntry && pageName === 'file-exp';
    if (!isFileExplorerRoute) {
        const context = await loadRuntimeContext();
        if (roomEntry && !hasWebMeetRuntimePlugin(context.plugins)) {
            throw new Error('WebMeet runtime plugin is unavailable.');
        }
        const routePolicy = getRuntimeComponentPolicy(context.plugins, pageName);
        if (routePolicy?.adminOnly && !isAdminUser(context.authenticatedUser)) {
            window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
            pageName = 'file-exp';
            url = 'file-exp';
            suppressNavigationHash = false;
        } else {
            await runtimePluginLoader.ensureComponentRegistered(pageName, context.plugins);
        }
    }

    loader?.close?.();
    loader?.remove?.();
    const mountedPresenter = await mountInitialApplicationRoute({
        webSkel,
        pageContent,
        route: {
            pageName: pageName || 'file-exp',
            url: url || 'file-exp',
            preserveHash: suppressNavigationHash
        }
    });
    void completeInitialApplicationRoute({ webSkel, presenter: mountedPresenter });
    clearBootstrapReloadState(window);
    if (isFileExplorerRoute) {
        window.setTimeout(() => {
            waitForAgentRuntimeAvailability({
                label: 'Explorer plugins',
                operation: loadRuntimeContext
            })
                .then(() => {
                    window.dispatchEvent(new CustomEvent(RUNTIME_PLUGINS_UPDATED_EVENT, {
                        detail: { phase: 'discovered' }
                    }));
                    window.setTimeout(() => {
                        window.dispatchEvent(new CustomEvent(RUNTIME_PLUGINS_UPDATED_EVENT, {
                            detail: { phase: 'ready' }
                        }));
                    }, RUNTIME_PLUGIN_MOUNT_GRACE_MS);
                })
                .catch((error) => {
                    console.error('[runtime-plugins] Failed to initialize plugins after Explorer mount:', error);
                });
        }, 0);
    }
}

start().catch(async (error) => {
    console.error('[explorer] Failed to bootstrap application', error);
    const unavailableNotice = getRuntimeUnavailableNotice(error, 'Explorer');
    if (unavailableNotice) {
        updateSpinnerStatus(document.querySelector('#before_webskel_loader'), unavailableNotice);
    }
    if (scheduleBootstrapReload(error, { windowRef: window })) {
        return;
    }
    const beforeLoader = document.querySelector('#before_webskel_loader');
    beforeLoader?.close?.();
    beforeLoader?.remove?.();
    window.webSkel?.clearLoading?.();

    const errorTitle = unavailableNotice?.title || 'Explorer failed to load';
    const message = unavailableNotice?.message || error?.message || 'Explorer failed to load.';
    const technical = error?.stack || String(error);
    if (typeof window.showApplicationError === 'function') {
        await window.showApplicationError(errorTitle, message, technical);
        return;
    }

    const container = document.createElement('main');
    container.className = 'application-error';
    container.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.textContent = unavailableNotice?.title || 'Explorer failed to load';
    const details = document.createElement('p');
    details.textContent = message;
    container.append(title, details);
    document.body.replaceChildren(container);
});

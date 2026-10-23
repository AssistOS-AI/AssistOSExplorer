import { createRuntimePluginLoader } from '../../services/runtime/runtimePluginLoader.js';
import { installExplorerResourceLoader } from '../../services/runtime/explorerResourceLoader.js';
import { installDetachedRenderGuard } from '../../services/runtime/pageChangeGuards.js';
import { installAuthNavigationGuard } from '../../services/infrastructure/authNavigationGuard.js';
import { fetchAuthenticatedUser } from '../../services/infrastructure/authApi.js';
import { filterRuntimePluginsByPolicy } from '../../utils/pluginUtils.core.js';
import { initializeTheme } from '../../shared/ui/theme.js';

// The Live Sessions page: the same list and terminal viewer the panel used to mount inside the Explorer shell,
// served as its own page so the shared expanded modal can show it in an iframe like the RoboTeam and Soul Gateway
// tools, and so that "Open in new tab" gives a working full page. It bootstraps what the panel used to get from the
// shell, with the calls main.js makes: WebSkel, the signed-in user (`assistOS.user`), and the runtime plugin catalog
// (`assistOS.workspace.appPlugins`, which holds the agent-declared session sources).
export const EXPLORER_AGENT_ID = 'explorer';
export const RUNTIME_PLUGIN_TOOL = 'collect_ide_plugins';
export const PANEL_COMPONENT = 'live-sessions-modal';
// Both are dependency entries of the toolbar plugin, and the runtime loader registers a dependency entry on its own
// without its siblings, so the page registers each one the panel creates. The panel creates the stream view when an
// agent run is watched.
export const PAGE_COMPONENTS = Object.freeze([PANEL_COMPONENT, 'live-session-stream-view']);

// The manifest's `applicationPlugins` booleans switch plugins off for a deployment, as in main.js.
export function normalizeRuntimePluginPolicy(manifest) {
    const raw = manifest?.applicationPlugins;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const policy = {};
    for (const [key, value] of Object.entries(raw)) {
        const name = typeof key === 'string' ? key.trim() : '';
        if (name && typeof value === 'boolean') policy[name] = value;
    }
    return policy;
}

async function loadExplorerManifest(fetchImpl) {
    try {
        const response = await fetchImpl('/explorer/manifest.json', { cache: 'no-cache' });
        if (!response.ok) return {};
        const parsed = await response.json();
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function showStatus(statusElement, message) {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.hidden = !message;
}

// The browser-only modules (WebSkel and the SDK, which imports the Router-served MCP client) load on demand, so the
// rest of this module can run under test with injected stand-ins.
async function loadDefaultDependencies() {
    const [{ default: WebSkel }, { default: assistosSDK, initialiseAssistOS }, { createComponentRegistry }] = await Promise.all([
        import('../../shared/libs/webskel/webskel.mjs'),
        import('../../services/assistosSDK.js'),
        import('../../services/runtime/componentRegistry.js'),
    ]);
    return {
        WebSkel,
        assistosSDK,
        initialiseAssistOS,
        createComponentRegistry,
        ...pureDependencies(),
    };
}

const pureDependencies = () => ({
    createRuntimePluginLoader,
    installExplorerResourceLoader,
    installDetachedRenderGuard,
    installAuthNavigationGuard,
    fetchAuthenticatedUser,
    filterRuntimePluginsByPolicy,
    initializeTheme,
    fetchImpl: globalThis.fetch?.bind(globalThis),
});

export async function startLiveSessionsPage({
    root = globalThis.document?.querySelector('#liveSessionsPage'),
    status = globalThis.document?.querySelector('#liveSessionsPageStatus'),
    win = globalThis.window,
    dependencies = null,
} = {}) {
    try {
        if (!root) throw new Error('The Live Sessions page has no mount point.');
        const deps = dependencies || await loadDefaultDependencies();
        deps.initializeTheme();
        // The shell marks its own agent for the SDK and the auth guard; this page is served by the same agent.
        if (win) win.ASSISTOS_AGENT_ID = win.ASSISTOS_AGENT_ID || EXPLORER_AGENT_ID;
        deps.installAuthNavigationGuard();

        const webSkel = await deps.WebSkel.initialise('/explorer/webskel.json');
        deps.installExplorerResourceLoader(webSkel);
        deps.installDetachedRenderGuard(webSkel);
        webSkel.appServices = deps.assistosSDK;

        const componentRegistry = deps.createComponentRegistry(webSkel);
        const runtimePluginLoader = deps.createRuntimePluginLoader({
            agentId: EXPLORER_AGENT_ID,
            runtimePluginTool: RUNTIME_PLUGIN_TOOL,
            assistosSDK: deps.assistosSDK,
            componentRegistry,
        });
        const assistOS = deps.initialiseAssistOS({ ui: webSkel });
        assistOS.webSkel = webSkel;
        assistOS.appServices = deps.assistosSDK;
        assistOS.pluginSettings = {};

        const [manifest, catalog, user] = await Promise.all([
            loadExplorerManifest(deps.fetchImpl),
            runtimePluginLoader.fetchRuntimePlugins(),
            deps.fetchAuthenticatedUser(),
        ]);
        const policy = normalizeRuntimePluginPolicy(manifest);
        const plugins = deps.filterRuntimePluginsByPolicy(catalog.normalized, policy);
        if (user) assistOS.user = user;
        assistOS.explorerManifest = manifest;
        assistOS.applicationPluginPolicy = policy;
        assistOS.runtimePlugins = plugins;
        runtimePluginLoader.mergeIntoAssistOS(assistOS, plugins);

        // The panel and the stream view it creates for agent runs.
        const registered = await Promise.all(PAGE_COMPONENTS.map((name) => runtimePluginLoader.ensureComponentRegistered(name, plugins)));
        if (registered.some((component) => !component)) throw new Error('Live Sessions is not enabled for this workspace.');

        const element = webSkel.createElement(PANEL_COMPONENT, root, {}, { 'data-presenter': PANEL_COMPONENT }, true);
        const node = element.element?.deref?.();
        await node?.presenterReadyPromise;
        await node?.renderCompletePromise;
        await node?.webSkelPresenter?.initialLoad;
        showStatus(status, '');
        return { assistOS, webSkel, element };
    } catch (error) {
        console.error('[live-sessions] The page could not start:', error);
        showStatus(status, 'Live Sessions could not be loaded. Reload to try again.');
        return null;
    }
}

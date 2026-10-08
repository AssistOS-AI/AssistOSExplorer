import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createComponentRegistry } from '../../services/runtime/componentRegistry.js';
import { createRuntimePluginLoader } from '../../services/runtime/runtimePluginLoader.js';

test('runtime plugin discovery retries a transient Router generation change', async () => {
    let attempts = 0;
    const loader = createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: {
            async fetchRuntimePlugins() {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('edge routing generation changed before upstream connection');
                }
                return {application: {}};
            }
        },
        componentRegistry: {
            async loadComponent(meta) { return meta; },
            getCachedComponent() { return undefined; }
        }
    });

    const result = await loader.fetchRuntimePlugins();

    assert.equal(attempts, 2);
    assert.deepEqual(result.raw, {application: {}});
});

test('runtime plugin discovery does not cache a failed request', async () => {
    let attempts = 0;
    const loader = createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: {
            async fetchRuntimePlugins() {
                attempts += 1;
                if (attempts === 1) throw new Error('plugin catalog rejected');
                return {application: {}};
            }
        },
        componentRegistry: {
            async loadComponent(meta) { return meta; },
            getCachedComponent() { return undefined; }
        }
    });

    await assert.rejects(loader.fetchRuntimePlugins(), /plugin catalog rejected/);
    const result = await loader.fetchRuntimePlugins();

    assert.equal(attempts, 2);
    assert.deepEqual(result.raw, {application: {}});
});

test('runtime plugin loader prefers workspace component URLs over legacy agent URLs', async () => {
    const loaded = [];
    const componentRegistry = {
        async loadComponent(meta) {
            loaded.push(meta);
            return meta;
        },
        getCachedComponent() {
            return undefined;
        }
    };
    const loader = createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: {
            async fetchRuntimePlugins() {
                return {};
            }
        },
        componentRegistry
    });

    await loader.ensureComponentRegistered('git-new-repository-modal', {
        application: {
            'file-exp:new-menu': [{
                id: 'git',
                agent: 'gitAgent',
                contributionType: 'menu',
                dependencies: [{
                    component: 'git-new-repository-modal',
                    presenter: 'GitNewRepositoryModal',
                    type: 'modal',
                    ownerComponent: 'git-tool-button',
                    baseUrl: '/gitAgent/IDE-plugins/git-tool-button/components/git-new-repository-modal/git-new-repository-modal'
                }]
            }],
            'file-exp:toolbar': [{
                id: 'git',
                agent: 'gitAgent',
                component: 'git-tool-button',
                presenter: 'GitToolButton',
                componentBaseUrl: '/workspace-files/.ploinky/repos/AchillesIDE/gitAgent/IDE-plugins/git-tool-button/git-tool-button',
                dependencies: [{
                    component: 'git-new-repository-modal',
                    presenter: 'GitNewRepositoryModal',
                    type: 'modal',
                    baseUrl: '/workspace-files/.ploinky/repos/AchillesIDE/gitAgent/IDE-plugins/git-tool-button/components/git-new-repository-modal/git-new-repository-modal'
                }]
            }]
        }
    });

    const modalLoad = loaded.find((meta) => meta.componentName === 'git-new-repository-modal');
    assert.equal(
        modalLoad.baseUrl,
        '/workspace-files/.ploinky/repos/AchillesIDE/gitAgent/IDE-plugins/git-tool-button/components/git-new-repository-modal/git-new-repository-modal'
    );
});

test('runtime plugin loader does not load URL-only global settings plugins as components', async () => {
    const loaded = [];
    const componentRegistry = {
        async loadComponent(meta) {
            loaded.push(meta);
            return meta;
        },
        getCachedComponent() {
            return undefined;
        }
    };
    const loader = createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: {
            async fetchRuntimePlugins() {
                return {};
            }
        },
        componentRegistry
    });

    await loader.loadComponents({
        application: {
            '': [{
                id: 'soul-gateway',
                agent: 'soul-gateway',
                pluginCategory: 'application',
                contributionType: 'mount',
                component: 'soul-gateway-settings',
                type: 'global',
                settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/'
            }],
            'file-exp:toolbar': [{
                id: 'git',
                agent: 'gitAgent',
                pluginCategory: 'application',
                contributionType: 'mount',
                component: 'git-tool-button',
                type: 'embedded'
            }]
        }
    });

    assert.deepEqual(
        loaded.map((meta) => `${meta.agent}/${meta.componentName}`),
        ['gitAgent/git-tool-button']
    );
});

test('runtime plugin loader registers a component together with its cross-agent dependencies', async () => {
    const loaded = [];
    const componentRegistry = {
        async loadComponent(meta) {
            loaded.push(meta);
            return meta;
        },
        getCachedComponent(meta) {
            return loaded.find((entry) => (
                entry.agent === meta.agent
                && entry.componentName === meta.componentName
            ));
        }
    };
    const loader = createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: {
            async fetchRuntimePlugins() {
                return {};
            }
        },
        componentRegistry
    });
    const runtimePlugins = {
        document: {
            paragraph: [{
                agent: 'soplangAgent',
                component: 'scripta-variants',
                presenter: 'ScriptaVariants',
                dependencies: [{
                    agent: 'explorer',
                    component: 'scripta-variants-view',
                    presenter: 'ScriptaVariantsView',
                    baseUrl: '/explorer/shared/ui/scripta-variants-view/scripta-variants-view'
                }]
            }]
        }
    };

    await loader.ensureComponentRegistered('scripta-variants', runtimePlugins);

    assert.deepEqual(
        loaded.map((meta) => `${meta.agent}/${meta.componentName}`).sort(),
        ['explorer/scripta-variants-view', 'soplangAgent/scripta-variants']
    );
});

test('runtime plugin loader propagates transient asset failures to bootstrap recovery', async () => {
    const loader = createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: {
            async fetchRuntimePlugins() {
                return {};
            }
        },
        componentRegistry: {
            async loadComponent() {
                throw new Error('Failed to load plugin template (503)');
            },
            getCachedComponent() {
                return undefined;
            }
        }
    });

    await assert.rejects(
        loader.loadComponents({
            application: {
                'file-exp:toolbar': [{
                    id: 'git',
                    agent: 'gitAgent',
                    component: 'git-tool-button',
                    presenter: 'GitToolButton'
                }]
            }
        }),
        /\(503\)/
    );
});

test('component registry reuses host-registered WebSkel components without fetching runtime assets', async () => {
    const previousCustomElements = globalThis.customElements;
    globalThis.customElements = {
        get(name) {
            return name === 'custom-select' ? class CustomSelectElement {} : undefined;
        }
    };
    try {
        const registry = createComponentRegistry({
            configs: {
                components: [{
                    name: 'custom-select',
                    type: 'components',
                    presenterClassName: 'CustomSelect'
                }]
            }
        });
        const component = await registry.loadComponent({
            agent: 'explorer',
            componentName: 'custom-select',
            presenterName: 'CustomSelect',
            baseUrl: '/invalid-url-that-must-not-be-fetched'
        });

        assert.equal(component.name, 'custom-select');
        assert.equal(component.hostRegistered, true);
    } finally {
        if (previousCustomElements === undefined) delete globalThis.customElements;
        else globalThis.customElements = previousCustomElements;
    }
});

test('component registry identifies the agent for transient component failures', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    try {
        const registry = createComponentRegistry({ configs: { components: [] } });
        await assert.rejects(
            registry.loadComponent({
                agent: 'explorer',
                componentName: 'marketplace-modal',
                presenterName: 'MarketplaceModal',
                baseUrl: '/workspace-files/marketplace-modal'
            }),
            (error) => {
                assert.equal(error.status, 503);
                assert.equal(error.runtimeAgent, 'explorer');
                assert.equal(error.runtimeComponent, 'marketplace-modal');
                return true;
            }
        );
    } finally {
        globalThis.fetch = previousFetch;
    }
});

const explorerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function webmeetLoader(loaded) {
    return createRuntimePluginLoader({
        agentId: 'explorer',
        runtimePluginTool: 'collect_ide_plugins',
        assistosSDK: { async fetchRuntimePlugins() { return {}; } },
        componentRegistry: {
            async loadComponent(meta) { loaded.push(meta); return meta; },
            getCachedComponent(meta) {
                return loaded.find((entry) => entry.agent === meta.agent && entry.componentName === meta.componentName);
            }
        }
    });
}

const webmeetPlugins = {
    application: {
        'file-exp:toolbar': [{
            id: 'webmeet',
            agent: 'webmeetAgent',
            component: 'webmeet-tool-button',
            presenter: 'WebmeetToolButton',
            componentBaseUrl: '/webmeetAgent/IDE-plugins/webmeet-tool-button/webmeet-tool-button',
            toolbarModal: { mode: 'iframe' },
            dependencies: [
                { component: 'webmeet-dashboard', presenter: 'WebmeetDashboard', baseUrl: '/webmeetAgent/IDE-plugins/webmeet-dashboard/webmeet-dashboard' },
                { component: 'webmeet-room', presenter: 'WebmeetRoom', baseUrl: '/webmeetAgent/IDE-plugins/webmeet-room/webmeet-room' }
            ]
        }]
    }
};

test('includeDependencies:false registers only the presenter component', async () => {
    const loaded = [];
    await webmeetLoader(loaded).ensureComponentRegistered('webmeet-tool-button', webmeetPlugins, { includeDependencies: false });
    assert.deepEqual(loaded.map((meta) => meta.componentName), ['webmeet-tool-button']);
});

test('the default and room-entry style calls still register every dependency', async () => {
    for (const args of [[webmeetPlugins], [webmeetPlugins, {}], [webmeetPlugins, { includeDependencies: true }]]) {
        const loaded = [];
        await webmeetLoader(loaded).ensureComponentRegistered('webmeet-tool-button', ...args);
        assert.deepEqual(loaded.map((meta) => meta.componentName).sort(),
            ['webmeet-dashboard', 'webmeet-room', 'webmeet-tool-button']);
    }
    // Mounting the dashboard directly (room entry) is a dependency request and registers independently.
    const loaded = [];
    await webmeetLoader(loaded).ensureComponentRegistered('webmeet-dashboard', webmeetPlugins);
    assert.ok(loaded.some((meta) => meta.componentName === 'webmeet-dashboard'));
});

test('only the toolbar-modal lazy path skips dependencies and room entry stays on the full path', () => {
    const host = fs.readFileSync(path.join(explorerRoot, 'web-components', 'pages', 'file-exp', 'file-exp-application-plugins.js'), 'utf8');
    assert.match(host, /ensureRuntimeComponent\(plugin\.component, plugin\.toolbarModal \? \{ includeDependencies: false \} : undefined\)/);
    assert.equal((host.match(/includeDependencies: false/g) || []).length, 1);
    assert.match(host, /pendingPlugins\.map\(\(\{ plugin \}\) => ensureRuntimeComponent\(plugin\.component\)\)/);
    const main = fs.readFileSync(path.join(explorerRoot, 'main.js'), 'utf8');
    assert.match(main, /runtimePluginLoader\.ensureComponentRegistered\(pageName, context\.plugins\)/);
});

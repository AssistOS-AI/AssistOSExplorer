import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterRuntimePluginsByPolicy,
    computeComponentBaseUrl,
    mergeRuntimePluginsIntoAssistOS,
    normalizeRuntimePlugins,
    resolveRuntimeAssetUrl
} from '../../utils/pluginUtils.core.js';

test('computeComponentBaseUrl builds dependency paths', () => {
    const base = computeComponentBaseUrl('agent', 'child', {
        ownerComponent: 'parent',
        isDependency: true
    });
    assert.equal(base, '/agent/IDE-plugins/parent/components/child/child');
});

test('computeComponentBaseUrl handles overrides via custom path', () => {
    const base = computeComponentBaseUrl('agent', 'child', {
        customPath: 'shared/widgets/widget'
    });
    assert.equal(base, '/agent/IDE-plugins/shared/widgets/widget');
});

test('computeComponentBaseUrl resolves custom dependency paths from owner asset root', () => {
    const base = computeComponentBaseUrl('webmeetAgent', 'webmeet-dashboard', {
        ownerComponent: 'webmeet-tool-button',
        isDependency: true,
        customPath: 'components/webmeet-dashboard/webmeet-dashboard',
        pluginsBaseUrl: '/workspace-files/.ploinky/repos/webmeet/webmeetAgent/IDE-plugins',
        ownerAssetBaseUrl: '/workspace-files/.ploinky/repos/webmeet/webmeetAgent/IDE-plugins/webmeet-tool-button'
    });
    assert.equal(
        base,
        '/workspace-files/.ploinky/repos/webmeet/webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard'
    );
});

test('resolveRuntimeAssetUrl ignores absolute urls', () => {
    const value = resolveRuntimeAssetUrl('agent', 'component', 'https://example.com/icon.svg');
    assert.equal(value, 'https://example.com/icon.svg');
});

test('computeComponentBaseUrl supports workspace asset roots for dependencies', () => {
    const base = computeComponentBaseUrl('fileExplorer', 'add-variable', {
        ownerComponent: 'edit-variables',
        isDependency: true,
        ownerAssetBaseUrl: '/workspace-files/.ploinky/repos/fileExplorer/explorer/IDE-plugins/edit-variables'
    });
    assert.equal(
        base,
        '/workspace-files/.ploinky/repos/fileExplorer/explorer/IDE-plugins/edit-variables/components/add-variable/add-variable'
    );
});

test('resolveRuntimeAssetUrl remaps legacy absolute agent asset paths to workspace files', () => {
    const value = resolveRuntimeAssetUrl(
        'fileExplorer',
        'document-video-preview',
        '/IDE-plugins/assets/icons/preview.svg',
        'icon.svg',
        {
            assetBaseUrl: '/workspace-files/.ploinky/repos/fileExplorer/explorer/IDE-plugins/document-video-preview',
            pluginsBaseUrl: '/workspace-files/.ploinky/repos/fileExplorer/explorer/IDE-plugins'
        }
    );
    assert.equal(
        value,
        '/workspace-files/.ploinky/repos/fileExplorer/explorer/IDE-plugins/assets/icons/preview.svg'
    );
});

test('normalizeRuntimePlugins preserves document and application buckets', () => {
    const normalized = normalizeRuntimePlugins({
        document: {
            document: [{
                pluginCategory: 'document',
                location: 'document',
                agent: 'multimedia',
                component: 'document-video-preview',
                presenter: 'DocumentVideoPreview',
                type: 'embedded'
            }]
        },
        application: {
            'file-exp:toolbar': [{
                pluginCategory: 'application',
                location: 'file-exp:toolbar',
                agent: 'gitAgent',
                component: 'git-explorer-shell',
                presenter: 'GitExplorerShell',
                type: 'embedded'
            }]
        }
    });

    assert.equal(normalized.document.document.length, 1);
    assert.equal(normalized.document.document[0].pluginCategory, 'document');
    assert.equal(normalized.document.document[0].location, 'document');
    assert.equal(normalized.application['file-exp:toolbar'].length, 1);
    assert.equal(normalized.application['file-exp:toolbar'][0].pluginCategory, 'application');
    assert.equal(normalized.application['file-exp:toolbar'][0].location, 'file-exp:toolbar');
});

test('normalizeRuntimePlugins keeps global application plugin entries', () => {
    const normalized = normalizeRuntimePlugins({
        document: {},
        application: {
            'file-exp:global': [{
                id: 'webcli-chat',
                pluginCategory: 'application',
                location: 'file-exp:global',
                agent: 'webCli',
                component: 'webcli-global-chat',
                presenter: 'WebCliGlobalChat',
                type: 'global'
            }]
        }
    });

    assert.equal(normalized.application['file-exp:global'].length, 1);
    assert.equal(normalized.application['file-exp:global'][0].type, 'global');
    assert.equal(normalized.application['file-exp:global'][0].component, 'webcli-global-chat');
});

test('normalizeRuntimePlugins preserves dependencies for menu contributions', () => {
    const normalized = normalizeRuntimePlugins({
        application: {
            'file-exp:new-menu': [{
                pluginCategory: 'application',
                contributionType: 'menu',
                location: 'file-exp:new-menu',
                id: 'git',
                agent: 'gitAgent',
                menuModule: 'menu-contributions.js',
                label: 'Git',
                presentation: {
                    'file-exp:new-menu': {
                        label: 'New repository',
                        tooltip: 'Create a repository'
                    }
                },
                dependencies: [{
                    component: 'git-new-repository-modal',
                    presenter: 'GitNewRepositoryModal',
                    type: 'modal',
                    ownerComponent: 'git-tool-button'
                }]
            }]
        }
    });

    const entry = normalized.application['file-exp:new-menu'][0];
    assert.equal(entry.dependencies.length, 1);
    assert.equal(entry.label, 'New repository');
    assert.equal(entry.tooltip, 'Create a repository');
    assert.equal(entry.dependencies[0].component, 'git-new-repository-modal');
    assert.equal(
        entry.dependencies[0].baseUrl,
        '/gitAgent/IDE-plugins/git-tool-button/components/git-new-repository-modal/git-new-repository-modal'
    );
});

test('normalizeRuntimePlugins resolves menu dependencies through workspace asset roots', () => {
    const normalized = normalizeRuntimePlugins({
        application: {
            'file-exp:new-menu': [{
                pluginCategory: 'application',
                contributionType: 'menu',
                location: 'file-exp:new-menu',
                id: 'git',
                agent: 'gitAgent',
                menuModule: 'menu-contributions.js',
                assetRootPath: '.ploinky/repos/AchillesIDE/gitAgent/IDE-plugins/git-menu-contributions',
                dependencies: [{
                    component: 'git-new-repository-modal',
                    presenter: 'GitNewRepositoryModal',
                    type: 'modal',
                    ownerComponent: 'git-tool-button'
                }]
            }]
        }
    });

    const entry = normalized.application['file-exp:new-menu'][0];
    assert.equal(
        entry.dependencies[0].baseUrl,
        '/workspace-files/.ploinky/repos/AchillesIDE/gitAgent/IDE-plugins/git-tool-button/components/git-new-repository-modal/git-new-repository-modal'
    );
});

test('mergeRuntimePluginsIntoAssistOS separates document and application registries', () => {
    const assistOS = {
        workspace: {
            plugins: {},
            appPlugins: {}
        }
    };

    mergeRuntimePluginsIntoAssistOS(assistOS, {
        document: {
            paragraph: [{
                pluginCategory: 'document',
                location: 'paragraph',
                agent: 'multimedia',
                component: 'audio-plugin'
            }]
        },
        application: {
            'file-exp:toolbar': [{
                pluginCategory: 'application',
                location: 'file-exp:toolbar',
                agent: 'gitAgent',
                component: 'git-explorer-shell'
            }]
        }
    });

    assert.equal(assistOS.workspace.plugins.paragraph.length, 1);
    assert.equal(assistOS.workspace.plugins.paragraph[0].component, 'audio-plugin');
    assert.equal(assistOS.workspace.appPlugins['file-exp:toolbar'].length, 1);
    assert.equal(assistOS.workspace.appPlugins['file-exp:toolbar'][0].component, 'git-explorer-shell');
});

test('filterRuntimePluginsByPolicy removes disabled plugins by stable policy key', () => {
    const runtimePlugins = {
        document: {
            paragraph: [{
                pluginCategory: 'document',
                location: 'paragraph',
                agent: 'multimedia',
                component: 'audio-plugin'
            }]
        },
        application: {
            'file-exp:toolbar': [
                {
                    id: 'git',
                    pluginCategory: 'application',
                    location: 'file-exp:toolbar',
                    agent: 'gitAgent',
                    component: 'git-tool-button'
                },
                {
                    id: 'soplang-builder',
                    pluginCategory: 'application',
                    location: 'file-exp:toolbar',
                    agent: 'soplangAgent',
                    component: 'open-builder-button'
                }
            ]
        }
    };

    const filtered = filterRuntimePluginsByPolicy(runtimePlugins, {
        'gitAgent/git': false,
        'soplangAgent/soplang-builder': true
    });

    assert.equal(filtered.document.paragraph.length, 1);
    assert.equal(filtered.application['file-exp:toolbar'].length, 1);
    assert.equal(filtered.application['file-exp:toolbar'][0].component, 'open-builder-button');
});

test('filterRuntimePluginsByPolicy keeps enabled internal application plugins', () => {
    const runtimePlugins = {
        document: {},
        application: {
            'file-exp:internal': [
                {
                    id: 'dpu-runtime-support',
                    pluginCategory: 'application',
                    location: 'file-exp:internal',
                    agent: 'dpuAgent',
                    component: 'dpu-runtime-support'
                }
            ],
            'file-exp:toolbar': [
                {
                    id: 'git',
                    pluginCategory: 'application',
                    location: 'file-exp:toolbar',
                    agent: 'gitAgent',
                    component: 'git-tool-button'
                }
            ]
        }
    };

    const filtered = filterRuntimePluginsByPolicy(runtimePlugins, {
        'gitAgent/git': false,
        'dpuAgent/dpu-runtime-support': true
    });

    assert.equal(filtered.application['file-exp:internal'].length, 1);
    assert.equal(filtered.application['file-exp:internal'][0].component, 'dpu-runtime-support');
    assert.equal(filtered.application['file-exp:toolbar'], undefined);
});

test('filterRuntimePluginsByPolicy keeps explicitly enabled Soul Gateway settings entry', () => {
    const runtimePlugins = {
        document: {},
        application: {
            '': [
                {
                    id: 'soul-gateway',
                    pluginCategory: 'application',
                    location: '',
                    agent: 'soul-gateway',
                    component: 'soul-gateway-settings',
                    settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/',
                    adminOnly: true
                }
            ]
        }
    };

    const filtered = filterRuntimePluginsByPolicy(runtimePlugins, {
        'soul-gateway/soul-gateway': true
    });

    assert.equal(filtered.application[''].length, 1);
    assert.equal(filtered.application[''][0].component, 'soul-gateway-settings');
    assert.equal(filtered.application[''][0].settingsUrl, '/base-agent-additional-server/soul-gateway/7000/management/');
});

test('filterRuntimePluginsByPolicy removes disabled document plugins by stable policy key', () => {
    const runtimePlugins = {
        document: {
            paragraph: [
                {
                    pluginCategory: 'document',
                    location: 'paragraph',
                    agent: 'multimedia',
                    component: 'audio-plugin'
                },
                {
                    pluginCategory: 'document',
                    location: 'paragraph',
                    agent: 'multimedia',
                    component: 'video-plugin'
                }
            ]
        },
        application: {}
    };

    const filtered = filterRuntimePluginsByPolicy(runtimePlugins, {
        'multimedia/audio-plugin': false,
        'multimedia/video-plugin': true
    });

    assert.equal(filtered.document.paragraph.length, 1);
    assert.equal(filtered.document.paragraph[0].component, 'video-plugin');
});

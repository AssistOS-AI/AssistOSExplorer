import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';

async function writePluginConfig(rootDir, agentName, pluginName, config) {
    const pluginDir = path.join(rootDir, agentName, 'IDE-plugins', pluginName);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function writeAgentManifest(rootDir, agentName, manifest) {
    const agentDir = path.join(rootDir, agentName);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

test('aggregateIdePlugins accepts application plugins with global type and slot', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-'));
    try {
        await writePluginConfig(workspaceRoot, 'webCli', 'webcli-global-chat', {
            pluginCategory: 'application',
            id: 'webcli-chat',
            component: 'webcli-global-chat',
            location: ['file-exp:global'],
            presenter: 'WebCliGlobalChat',
            type: 'global'
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const globalPlugins = aggregated.application['file-exp:global'];

        assert.ok(Array.isArray(globalPlugins));
        assert.equal(globalPlugins.length, 1);
        assert.equal(globalPlugins[0].agent, 'webCli');
        assert.equal(globalPlugins[0].type, 'global');
        assert.equal(globalPlugins[0].component, 'webcli-global-chat');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins rejects global type for document plugins', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-'));
    try {
        await writePluginConfig(workspaceRoot, 'badDocs', 'invalid-global-doc-plugin', {
            pluginCategory: 'document',
            component: 'invalid-global-doc-plugin',
            location: ['document'],
            presenter: 'InvalidGlobalDocPlugin',
            type: 'global'
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const documentPlugins = aggregated.document.document || [];

        assert.equal(documentPlugins.length, 0);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins follows symlinked repos under .ploinky/repos', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-workspace-'));
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-source-'));
    try {
        await writePluginConfig(sourceRoot, 'gitAgent', 'git-tool-button', {
            pluginCategory: 'application',
            id: 'git',
            component: 'git-tool-button',
            location: ['file-exp:toolbar'],
            presenter: 'GitToolButton',
            type: 'embedded'
        });

        const reposRoot = path.join(workspaceRoot, '.ploinky', 'repos');
        await fs.mkdir(reposRoot, { recursive: true });
        await fs.symlink(sourceRoot, path.join(reposRoot, 'AssistOSExplorer'));

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const toolbarPlugins = aggregated.application['file-exp:toolbar'] || [];

        assert.equal(toolbarPlugins.length, 1);
        assert.equal(toolbarPlugins[0].agent, 'gitAgent');
        assert.equal(toolbarPlugins[0].id, 'git');
        assert.equal(toolbarPlugins[0].component, 'git-tool-button');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.rm(sourceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins keeps application plugins with empty location for settings visibility', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-'));
    try {
        await writePluginConfig(workspaceRoot, 'webCli', 'webcli-global-chat', {
            pluginCategory: 'application',
            id: 'webcli-chat',
            component: 'webcli-global-chat',
            location: [],
            presenter: 'WebCliGlobalChat',
            type: 'global'
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const hiddenLocationPlugins = aggregated.application[''];

        assert.ok(Array.isArray(hiddenLocationPlugins));
        assert.equal(hiddenLocationPlugins.length, 1);
        assert.equal(hiddenLocationPlugins[0].agent, 'webCli');
        assert.equal(hiddenLocationPlugins[0].id, 'webcli-chat');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins exposes nested Soul Gateway repo plugin as soul-gateway agent', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-workspace-'));
    try {
        const reposRoot = path.join(workspaceRoot, '.ploinky', 'repos', 'proxies');
        await writePluginConfig(reposRoot, 'soul-gateway', 'soul-gateway-settings', {
            pluginCategory: 'application',
            id: 'soul-gateway',
            component: 'soul-gateway-settings',
            settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/',
            location: [],
            type: 'global',
            adminOnly: true
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const settingsPlugins = aggregated.application[''] || [];

        assert.equal(settingsPlugins.length, 1);
        assert.equal(settingsPlugins[0].agent, 'soul-gateway');
        assert.equal(settingsPlugins[0].id, 'soul-gateway');
        assert.equal(settingsPlugins[0].adminOnly, true);
        assert.equal(settingsPlugins[0].settingsUrl, '/base-agent-additional-server/soul-gateway/7000/management/');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins returns agentSettings from agent manifest', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-'));
    try {
        await writeAgentManifest(workspaceRoot, 'webAssist', {
            ideSettings: [
                {
                    key: 'webassist-chat',
                    label: 'WebAssist Chat',
                    scope: 'workspace',
                    pluginKey: 'webAssist/webassist-chat',
                    settingsComponent: 'webassist-settings',
                    adminOnly: false
                }
            ]
        });
        await writePluginConfig(workspaceRoot, 'webAssist', 'web-assist-chat', {
            pluginCategory: 'application',
            id: 'webassist-chat',
            component: 'web-assist-chat',
            location: [],
            settings: 'webassist-settings',
            type: 'global'
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);

        assert.deepEqual(aggregated.agentSettings, [
            {
                key: 'webassist-chat',
                label: 'WebAssist Chat',
                ownerAgent: 'webAssist',
                scope: 'workspace',
                pluginKey: 'webAssist/webassist-chat',
                settingsComponent: 'webassist-settings',
                adminOnly: false
            }
        ]);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins rejects invalid ideSettings entries', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-'));
    try {
        await writeAgentManifest(workspaceRoot, 'badSettings', {
            ideSettings: [
                {
                    label: 'Missing Key',
                    scope: 'workspace',
                    pluginKey: 'badSettings/missing-key',
                    settingsComponent: 'missing-key'
                },
                {
                    key: 'bad-plugin-key',
                    label: 'Bad Plugin Key',
                    scope: 'workspace',
                    pluginKey: 'badSettings',
                    settingsComponent: 'bad-plugin-key'
                },
                {
                    key: 'bad-url',
                    label: 'Bad URL',
                    scope: 'workspace',
                    pluginKey: 'badSettings/bad-url',
                    settingsUrl: 'https://example.test/settings'
                },
                {
                    key: 'bad-component',
                    label: 'Bad Component',
                    scope: 'workspace',
                    pluginKey: 'badSettings/bad-component',
                    settingsComponent: 'Bad Component'
                }
            ]
        });
        await writePluginConfig(workspaceRoot, 'badSettings', 'bad-settings', {
            pluginCategory: 'application',
            id: 'bad-settings',
            component: 'bad-settings',
            location: [],
            type: 'global'
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);

        assert.deepEqual(aggregated.agentSettings, []);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins returns nested Soul Gateway manifest settings', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-workspace-'));
    try {
        const reposRoot = path.join(workspaceRoot, '.ploinky', 'repos', 'proxies');
        await writeAgentManifest(reposRoot, 'soul-gateway', {
            ideSettings: [
                {
                    key: 'soul-gateway',
                    label: 'Soul Gateway',
                    scope: 'workspace',
                    pluginKey: 'soul-gateway/soul-gateway',
                    settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/',
                    adminOnly: true
                }
            ]
        });
        await writePluginConfig(reposRoot, 'soul-gateway', 'soul-gateway-settings', {
            pluginCategory: 'application',
            id: 'soul-gateway',
            component: 'soul-gateway-settings',
            settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/',
            location: [],
            type: 'global',
            adminOnly: true
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);

        assert.equal(aggregated.agentSettings.length, 1);
        assert.equal(aggregated.agentSettings[0].ownerAgent, 'soul-gateway');
        assert.equal(aggregated.agentSettings[0].pluginKey, 'soul-gateway/soul-gateway');
        assert.equal(aggregated.agentSettings[0].settingsUrl, '/base-agent-additional-server/soul-gateway/7000/management/');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins returns nested neutral manifest settings from a sibling repo', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-workspace-'));
    try {
        const reposRoot = path.join(workspaceRoot, '.ploinky', 'repos', 'analytics');
        await writeAgentManifest(reposRoot, 'analytics-agent', {
            ideSettings: [
                {
                    key: 'analytics-settings',
                    label: 'Analytics',
                    scope: 'workspace',
                    pluginKey: 'analytics-agent/analytics-settings',
                    settingsComponent: 'analytics-settings',
                    adminOnly: true
                }
            ]
        });
        await writePluginConfig(reposRoot, 'analytics-agent', 'analytics-settings', {
            pluginCategory: 'application',
            id: 'analytics',
            component: 'analytics-settings',
            location: [],
            type: 'global',
            adminOnly: true
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const settingsPlugins = aggregated.application[''] || [];

        assert.equal(aggregated.agentSettings.length, 1);
        assert.equal(aggregated.agentSettings[0].ownerAgent, 'analytics-agent');
        assert.equal(aggregated.agentSettings[0].pluginKey, 'analytics-agent/analytics-settings');
        assert.equal(aggregated.agentSettings[0].settingsComponent, 'analytics-settings');
        assert.equal(settingsPlugins.length, 1);
        assert.equal(settingsPlugins[0].agent, 'analytics-agent');
        assert.equal(settingsPlugins[0].id, 'analytics');
        assert.equal(settingsPlugins[0].adminOnly, true);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins rejects absolute plugin settings URLs', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ide-plugins-'));
    try {
        await writePluginConfig(workspaceRoot, 'badSettings', 'bad-settings-link', {
            pluginCategory: 'application',
            id: 'bad-settings',
            component: 'bad-settings-link',
            settingsUrl: 'https://soul.axiologic.dev/management/',
            location: [],
            type: 'global'
        });

        const aggregated = await aggregateIdePlugins(workspaceRoot);
        const settingsPlugins = aggregated.application[''] || [];

        assert.equal(settingsPlugins.length, 0);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregateIdePlugins discovers UserPersisto and EmailAgent settings from repository manifests', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const aggregated = await aggregateIdePlugins(repoRoot);
    const settingsByKey = new Map(aggregated.agentSettings.map((item) => [item.key, item]));

    assert.deepEqual(
        ['userpersisto-settings', 'email-agent-settings'].map((key) => settingsByKey.get(key)),
        [
            {
                key: 'userpersisto-settings',
                label: 'My Account',
                ownerAgent: 'userPersistoAgent',
                scope: 'workspace',
                pluginKey: 'userPersistoAgent/userpersisto-settings',
                settingsUrl: '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/',
                adminOnly: false
            },
            {
                key: 'email-agent-settings',
                label: 'Email Agent',
                ownerAgent: 'emailAgent',
                scope: 'workspace',
                pluginKey: 'emailAgent/email-agent-settings',
                settingsComponent: 'email-agent-settings',
                adminOnly: true
            }
        ]
    );
});

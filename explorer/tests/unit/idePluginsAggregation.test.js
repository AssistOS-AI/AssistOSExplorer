import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { filterRuntimePluginsByPolicy } from '../../utils/pluginUtils.core.js';

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

async function writeApplication(rootDir, agentName, id, { settings = false } = {}) {
    await writeAgentManifest(rootDir, agentName, settings ? {
        ideSettings: [{ key: id, label: id, pluginKey: `${agentName}/${id}`, settingsComponent: 'agent-settings' }],
    } : {});
    await writePluginConfig(rootDir, agentName, id, {
        pluginCategory: 'application', id, component: id, location: settings ? [] : ['file-exp:toolbar'], type: 'global',
    });
}

test('aggregateIdePlugins combines top-level repositories with managed repositories and preserves policy identities', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-mixed-plugin-repos-'));
    try {
        await writeApplication(path.join(workspaceRoot, 'AssistOSExplorer'), 'gitAgent', 'git');
        await writeApplication(path.join(workspaceRoot, 'AssistOSExplorer'), 'userPersistoAgent', 'userpersisto-settings', { settings: true });
        await writeApplication(path.join(workspaceRoot, '.ploinky', 'repos', 'AchillesCLI'), 'roboTeamAgent', 'roboteam');
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id).sort(), ['git', 'roboteam']);
        assert.equal(aggregated.application['file-exp:toolbar'].find(plugin => plugin.id === 'git').assetRootPath,
            'AssistOSExplorer/gitAgent/IDE-plugins/git');
        assert.equal(aggregated.application[''][0].agent, 'userPersistoAgent');
        assert.equal(aggregated.agentSettings[0].pluginKey, 'userPersistoAgent/userpersisto-settings');
        const filtered = filterRuntimePluginsByPolicy(aggregated, { 'gitAgent/git': false, 'roboTeamAgent/roboteam': true });
        assert.deepEqual(filtered.application['file-exp:toolbar'].map(plugin => plugin.id), ['roboteam']);
    } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('a top-level repository replaces its entire managed source, including removed plugins', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-override-'));
    try {
        await writeApplication(path.join(workspaceRoot, 'localRepo'), 'currentAgent', 'current');
        await writeApplication(path.join(workspaceRoot, '.ploinky', 'repos', 'localRepo'), 'removedAgent', 'removed');
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id), ['current']);
    } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('registered managed aliases use the matching local Git source without resurrecting stale plugins', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-alias-'));
    try {
        const local = path.join(workspaceRoot, 'checkout-name');
        const managed = path.join(workspaceRoot, '.ploinky', 'repos', 'registered-name');
        await writeApplication(local, 'currentAgent', 'current');
        await writeApplication(managed, 'staleAgent', 'stale');
        for (const [directory, origin] of [[local, 'git@github.com:Example/Agents.git'], [managed, 'https://github.com/example/agents']]) {
            execFileSync('git', ['init', '-q', directory]);
            execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', origin]);
        }
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id), ['current']);
        assert.equal(aggregated.application['file-exp:toolbar'][0].agent, 'currentAgent');
    } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('a local source with no plugins suppresses its stale managed source and parent fallback', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-empty-local-source-'));
    const workspaceRoot = path.join(parent, 'workspace');
    try {
        await writeAgentManifest(path.join(workspaceRoot, 'localRepo'), 'currentAgent', {});
        await writeApplication(path.join(workspaceRoot, '.ploinky', 'repos', 'localRepo'), 'staleAgent', 'stale');
        await writeApplication(parent, 'unrelatedAgent', 'unrelated');
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.deepEqual(Object.values(aggregated.application).flat(), []);
    } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test('one physical repository exposed under multiple paths contributes plugins and settings once', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-duplicate-'));
    try {
        const local = path.join(workspaceRoot, 'local');
        await writeApplication(local, 'settingsAgent', 'agent-settings', { settings: true });
        await fs.symlink(local, path.join(workspaceRoot, 'local-alias'));
        await fs.mkdir(path.join(workspaceRoot, '.ploinky', 'repos'), { recursive: true });
        await fs.symlink(local, path.join(workspaceRoot, '.ploinky', 'repos', 'managed-alias'));
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.equal(aggregated.application[''].length, 1);
        assert.equal(aggregated.agentSettings.length, 1);
        assert.equal(aggregated.application[''][0].assetRootPath, 'local/settingsAgent/IDE-plugins/agent-settings');
    } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('top-level repository discovery stays bounded and does not follow outside plugin sources', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-bounds-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-outside-'));
    try {
        await writeApplication(path.join(workspaceRoot, 'valid'), 'validAgent', 'valid');
        await writeApplication(path.join(workspaceRoot, 'group', 'nested'), 'nestedAgent', 'nested');
        await writeApplication(path.join(workspaceRoot, '.private'), 'hiddenAgent', 'hidden');
        await writeApplication(path.join(workspaceRoot, 'node_modules', 'package'), 'dependencyAgent', 'dependency');
        await writeApplication(outside, 'externalAgent', 'external');
        await fs.symlink(outside, path.join(workspaceRoot, 'outside-repo'));
        await fs.symlink(path.join(outside, 'externalAgent'), path.join(workspaceRoot, 'valid', 'outside-agent'));
        await writeAgentManifest(path.join(workspaceRoot, 'valid'), 'escapingAgent', {});
        await fs.symlink(path.join(outside, 'externalAgent', 'IDE-plugins'), path.join(workspaceRoot, 'valid', 'escapingAgent', 'IDE-plugins'));
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id), ['valid']);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    }
});

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

test('a zero-byte plugin config.json is skipped silently while non-empty invalid JSON still warns', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-empty-config-'));
    const warnings = [];
    const originalWarn = console.warn;
    try {
        await writeApplication(path.join(workspaceRoot, 'repo'), 'goodAgent', 'good');
        const emptyDir = path.join(workspaceRoot, 'repo', 'goodAgent', 'IDE-plugins', 'empty-plugin');
        const brokenDir = path.join(workspaceRoot, 'repo', 'goodAgent', 'IDE-plugins', 'broken-plugin');
        await fs.mkdir(emptyDir, { recursive: true });
        await fs.mkdir(brokenDir, { recursive: true });
        await fs.writeFile(path.join(emptyDir, 'config.json'), '');
        await fs.writeFile(path.join(brokenDir, 'config.json'), '{ not json');
        console.warn = (...args) => { warnings.push(args.join(' ')); };
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id), ['good']);
        assert.equal(warnings.some(message => message.includes('empty-plugin')), false, warnings.join('\n'));
        assert.equal(warnings.some(message => message.includes('broken-plugin')), true, warnings.join('\n'));
    } finally {
        console.warn = originalWarn;
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('plugin configs read in parallel are merged in directory order', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-config-order-'));
    try {
        const repo = path.join(workspaceRoot, 'repo');
        await writeAgentManifest(repo, 'orderAgent', {});
        const ids = ['alpha', 'bravo', 'charlie', 'delta'];
        for (const id of ids) {
            await writePluginConfig(repo, 'orderAgent', id, {
                pluginCategory: 'application', id, component: 'same-component', location: ['file-exp:toolbar'], type: 'global',
            });
        }
        const sequentialOrder = (await fs.readdir(path.join(repo, 'orderAgent', 'IDE-plugins'))).filter(name => ids.includes(name));
        const aggregated = await aggregateIdePlugins(workspaceRoot);
        // Equal sort keys keep insertion (readdir) order because Array.prototype.sort is stable.
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id), sequentialOrder);
    } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

// A stand-in `git` on PATH that answers `config --get remote.origin.url` after a
// per-directory delay and logs when each lookup starts and finishes.
async function installSlowGit(root, delaysByDirectoryName, origins) {
    const binDir = path.join(root, 'bin');
    const logPath = path.join(root, 'git-calls.log');
    await fs.mkdir(binDir, { recursive: true });
    const cases = Object.entries(delaysByDirectoryName).map(([name, delay]) =>
        `  */${name}) sleep ${delay}; echo ${JSON.stringify(origins[name] || '')} ;;`).join('\n');
    const script = `#!/bin/sh
dir="$2"
echo "start $dir" >> ${JSON.stringify(logPath)}
case "$dir" in
${cases}
  *) ;;
esac
echo "end $dir" >> ${JSON.stringify(logPath)}
`;
    await fs.writeFile(path.join(binDir, 'git'), script, { mode: 0o755 });
    return { binDir, logPath };
}

test('managed repository origin lookups overlap, skip name matches and decide overrides in directory order', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-origin-parallel-'));
    const originalPath = process.env.PATH;
    try {
        const managedRoot = path.join(workspaceRoot, '.ploinky', 'repos');
        // 'localRepo' is matched by name; 'aliasA' by origin; 'slowB' and 'fastC' are unmatched.
        await writeApplication(path.join(workspaceRoot, 'localRepo'), 'localAgent', 'local');
        await writeApplication(path.join(workspaceRoot, 'checkout'), 'checkoutAgent', 'checkout');
        await writeApplication(path.join(managedRoot, 'localRepo'), 'staleByName', 'stale-name');
        await writeApplication(path.join(managedRoot, 'aliasA'), 'staleByOrigin', 'stale-origin');
        await writeApplication(path.join(managedRoot, 'slowB'), 'slowAgent', 'slow');
        await writeApplication(path.join(managedRoot, 'fastC'), 'fastAgent', 'fast');
        for (const directory of [path.join(workspaceRoot, 'checkout'), path.join(managedRoot, 'aliasA'), path.join(managedRoot, 'slowB'), path.join(managedRoot, 'fastC')]) {
            await fs.mkdir(path.join(directory, '.git'), { recursive: true });
        }
        // The earlier directories are the slowest, so lookups finish out of order.
        const { binDir, logPath } = await installSlowGit(workspaceRoot, { checkout: 0.1, aliasA: 0.6, slowB: 0.4, fastC: 0.05 }, {
            checkout: 'https://example.com/org/checkout', aliasA: 'https://example.com/org/checkout', slowB: 'https://example.com/org/slow', fastC: 'https://example.com/org/fast',
        });
        process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
        const aggregated = await aggregateIdePlugins(workspaceRoot);

        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => plugin.id).sort(), ['checkout', 'fast', 'local', 'slow']);

        const events = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => line.split(' '));
        const lookedUp = events.filter(([kind]) => kind === 'start').map(([, dir]) => path.basename(dir));
        assert.equal(lookedUp.includes('localRepo'), false, 'a name match must not trigger an origin lookup');
        let running = 0;
        let maxRunning = 0;
        for (const [kind, dir] of events) {
            if (!['aliasA', 'slowB', 'fastC'].includes(path.basename(dir))) continue;
            running += kind === 'start' ? 1 : -1;
            maxRunning = Math.max(maxRunning, running);
        }
        assert.ok(maxRunning >= 3, `managed origin lookups should overlap, observed max ${maxRunning}`);
    } finally {
        process.env.PATH = originalPath;
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('managed repositories exposing one agent name keep first-wins precedence when origin lookups finish out of order', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-plugin-origin-precedence-'));
    const originalPath = process.env.PATH;
    try {
        const managedRoot = path.join(workspaceRoot, '.ploinky', 'repos');
        const names = ['repoA', 'repoB', 'repoC'];
        for (const name of names) {
            await writeApplication(path.join(managedRoot, name), 'sharedAgent', `plugin-${name.toLowerCase()}`);
            await fs.mkdir(path.join(managedRoot, name, '.git'), { recursive: true });
        }
        await writeApplication(path.join(managedRoot, 'repoC'), 'uniqueAgent', 'unique');
        // The earliest directory (readdir order) has the slowest origin lookup.
        const ordered = (await fs.readdir(managedRoot)).filter((name) => names.includes(name));
        const delays = Object.fromEntries(ordered.map((name, index) => [name, [0.6, 0.05, 0.3][index]]));
        const origins = Object.fromEntries(ordered.map((name) => [name, `https://example.com/org/${name}`]));
        const { binDir, logPath } = await installSlowGit(workspaceRoot, delays, origins);
        process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
        const aggregated = await aggregateIdePlugins(workspaceRoot);

        // The aggregator sorts by component, so the expected list is the sequential result in that order;
        // the winner of the shared agent name must be the earliest directory.
        const firstId = `plugin-${ordered[0].toLowerCase()}`;
        assert.deepEqual(aggregated.application['file-exp:toolbar'].map(plugin => [plugin.id, plugin.agent, plugin.assetRootPath]), [
            [firstId, 'sharedAgent', `.ploinky/repos/${ordered[0]}/sharedAgent/IDE-plugins/${firstId}`],
            ['unique', 'uniqueAgent', '.ploinky/repos/repoC/uniqueAgent/IDE-plugins/unique'],
        ].sort((a, b) => a[0].localeCompare(b[0])));
        const events = (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter((line) => line.startsWith('end ')).map((line) => path.basename(line.slice(4)));
        assert.notEqual(events[0], ordered[0], 'the earliest directory lookup must finish last for this test to be meaningful');
    } finally {
        process.env.PATH = originalPath;
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

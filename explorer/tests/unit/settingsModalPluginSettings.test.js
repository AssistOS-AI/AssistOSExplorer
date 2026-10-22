import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    applyAgentRuntimeStatuses,
    buildAgentSettingsItems,
    normalizeAgentRuntimeStatus,
    openPluginSettingsUrl,
    resolvePluginSettingsUrl,
    resolveSettingsComponentBase
} from '../../web-components/modals/settings-modal/settings-modal.js';
import {
    buildSourcePayload,
    DpuDataSourcesSettings,
    filterSourcesForProvider,
    providerForTabKey
} from '../../../dpuAgent/IDE-plugins/dpu-runtime-support/dpu-data-sources-settings/dpu-data-sources-settings.js';

test('resolveSettingsComponentBase reuses runtime component URL for matching settings component', () => {
    const base = resolveSettingsComponentBase({
        component: 'soul-gateway-settings',
        settingsComponent: 'soul-gateway-settings',
        componentBaseUrl: '/workspace-files/.ploinky/repos/AchillesIDE/soul-gateway/IDE-plugins/soul-gateway-settings/soul-gateway-settings/'
    });

    assert.equal(
        base,
        '/workspace-files/.ploinky/repos/AchillesIDE/soul-gateway/IDE-plugins/soul-gateway-settings/soul-gateway-settings'
    );
});

test('resolveSettingsComponentBase derives the root component URL when runtime base URL is absent', () => {
    const base = resolveSettingsComponentBase({
        component: 'gpt-researcher-settings',
        settingsComponent: 'gpt-researcher-settings',
        assetRootPath: '.ploinky/repos/legacy-agents/GPTResearcher/IDE-plugins/gpt-researcher-settings'
    });

    assert.equal(
        base,
        '/workspace-files/.ploinky/repos/legacy-agents/GPTResearcher/IDE-plugins/gpt-researcher-settings/gpt-researcher-settings'
    );
});

test('resolveSettingsComponentBase derives the root agent URL when runtime asset metadata is absent', () => {
    const base = resolveSettingsComponentBase({
        agent: 'GPTResearcher',
        component: 'gpt-researcher-settings',
        settingsComponent: 'gpt-researcher-settings'
    });

    assert.equal(
        base,
        '/GPTResearcher/IDE-plugins/gpt-researcher-settings/gpt-researcher-settings'
    );
});

test('resolveSettingsComponentBase keeps nested settings component convention for separate settings components', () => {
    const base = resolveSettingsComponentBase({
        component: 'tool-button',
        settingsComponent: 'tool-settings',
        assetRootPath: '.ploinky/repos/example/agent/IDE-plugins/tool-button'
    });

    assert.equal(
        base,
        '/workspace-files/.ploinky/repos/example/agent/IDE-plugins/tool-button/tool-settings/tool-settings'
    );
});

test('DPU Data Sources settings assets match the nested runtime path', () => {
    const base = path.resolve(
        process.cwd(),
        '../dpuAgent/IDE-plugins/dpu-runtime-support/dpu-data-sources-settings/dpu-data-sources-settings'
    );
    for (const extension of ['html', 'css', 'js']) {
        assert.equal(fs.existsSync(`${base}.${extension}`), true, `missing ${base}.${extension}`);
    }
    const presenter = fs.readFileSync(`${base}.js`, 'utf8');
    const template = fs.readFileSync(`${base}.html`, 'utf8');
    const styles = fs.readFileSync(`${base}.css`, 'utf8');
    assert.match(presenter, /constructor\(element, invalidate\)[\s\S]*?this\.invalidate\(\);/);
    assert.match(presenter, /data-local-action="editSource \$\{sourceId\}"/);
    assert.match(presenter, /dpu_secret_list/);
    assert.match(presenter, /webSkelPresenter\?\.setOptions/);
    assert.match(template, /class="settings-tabs"[\s\S]*?role="tablist"/);
    assert.match(template, /data-source-tab="huggingface"[\s\S]*?role="tab"/);
    assert.match(template, /data-source-tab="edc"[\s\S]*?role="tab"/);
    assert.match(template, /data-source-panel="huggingface"[\s\S]*?role="tabpanel"/);
    assert.match(template, /data-source-panel="edc"[\s\S]*?role="tabpanel"/);
    assert.match(template, /<custom-select id="dpuSourceSecretHuggingFace"/);
    assert.match(template, /<custom-select id="dpuSourceSecretEdc"/);
    assert.match(template, /data-source-form="huggingface"/);
    assert.match(template, /data-source-form="edc"/);
    assert.match(template, /data-source-panel="huggingface"[\s\S]*?dpu-sources-section-heading[\s\S]*?data-source-form="huggingface"[\s\S]*?data-source-list="huggingface"/);
    assert.match(template, /data-source-panel="edc"[\s\S]*?dpu-sources-section-heading[\s\S]*?data-source-form="edc"[\s\S]*?data-source-list="edc"/);
    assert.match(template, /name="counterPartyAddress"/);
    assert.match(template, /name="providerId"/);
    assert.doesNotMatch(template, /id="dpuSourceType"|data-name="type"/);
    assert.match(presenter, /assistOS\.UI\.showModal\('confirm-action-modal'/);
    assert.doesNotMatch(presenter, /window\.confirm|window\.prompt|window\.alert/);
    assert.match(template, /class="close"[\s\S]*?\/explorer\/shared\/assets\/icons\/x-mark\.svg/);
    assert.match(template, /data-local-action="toggleFullscreen"/);
    assert.match(template, /\/explorer\/shared\/assets\/icons\/fullscreen\.svg/);
    assert.match(template, /class="settings-card settings-card-static dpu-source-editor"/);
    assert.match(template, /data-local-action="addSource huggingface"/);
    assert.match(template, /data-local-action="addSource edc"/);
    assert.match(template, /data-local-action="refreshSources"/);
    assert.doesNotMatch(template, /<select\b/);
    assert.doesNotMatch(styles, /min-width:\s*(?:[1-9]\d*px|min\()/);
    assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i);
    assert.doesNotMatch(styles, /\.(?:general-button|gray-button|form-input|modal-actions)\s*\{/);
    assert.doesNotMatch(styles, /(?:color|background|border(?:-color|-radius)?|box-shadow):/);
    assert.match(styles, /var\(--(?:space|text|surface|border|radius)-/);
    assert.match(styles, /dpu-data-sources-settings-dialog\s*\{[\s\S]*?height:\s*min\(720px,/);
    assert.match(styles, /dpu-data-sources-settings-dialog\.is-fullscreen/);
    assert.match(presenter, /classList\.toggle\('is-fullscreen'/);
    assert.match(styles, /@media \(max-width: 720px\)/);
});

test('DPU Data Sources separates Hugging Face and EDC records', () => {
    const sources = [
        { id: 'hf-1', type: 'huggingface' },
        { id: 'edc-1', type: 'edc' },
        { id: 'hf-2', type: 'HuggingFace' },
        { id: 'other-1', type: 'other' }
    ];

    assert.deepEqual(
        filterSourcesForProvider(sources, 'huggingface').map((source) => source.id),
        ['hf-1', 'hf-2']
    );
    assert.deepEqual(
        filterSourcesForProvider(sources, 'edc').map((source) => source.id),
        ['edc-1']
    );
});

test('DPU Data Sources tabs support standard keyboard navigation', () => {
    assert.equal(providerForTabKey('huggingface', 'ArrowRight'), 'edc');
    assert.equal(providerForTabKey('edc', 'ArrowRight'), 'huggingface');
    assert.equal(providerForTabKey('huggingface', 'ArrowLeft'), 'edc');
    assert.equal(providerForTabKey('edc', 'Home'), 'huggingface');
    assert.equal(providerForTabKey('huggingface', 'End'), 'edc');
    assert.equal(providerForTabKey('huggingface', 'Enter'), '');
});

test('DPU Data Sources toggles fullscreen on its host dialog', () => {
    const classes = new Set();
    const dialog = {
        classList: {
            contains: (name) => classes.has(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        }
    };
    const aria = new Map();
    const modal = new DpuDataSourcesSettings({ closest: () => dialog }, () => {});
    modal.fullscreenButton = { setAttribute: (name, value) => aria.set(name, value) };

    modal.toggleFullscreen();
    assert.equal(classes.has('is-fullscreen'), true);
    assert.equal(aria.get('aria-pressed'), 'true');

    modal.toggleFullscreen();
    assert.equal(classes.has('is-fullscreen'), false);
    assert.equal(aria.get('aria-pressed'), 'false');
});

test('DPU Data Sources builds provider-specific source payloads', () => {
    assert.deepEqual(buildSourcePayload('huggingface', {
        id: '',
        name: 'HF',
        endpoint: 'https://huggingface.co',
        secretRef: 'hf-token',
        counterPartyAddress: 'https://ignored.example'
    }), {
        name: 'HF',
        endpoint: 'https://huggingface.co',
        secretRef: 'hf-token',
        type: 'huggingface',
        settings: {}
    });

    assert.deepEqual(buildSourcePayload('edc', {
        id: 'edc-1',
        name: 'EDC',
        endpoint: 'https://consumer.example',
        secretRef: 'edc-key',
        counterPartyAddress: 'https://provider.example/protocol',
        providerId: 'provider',
        participantId: ''
    }, {
        settings: { catalogPath: '/custom/catalog', providerId: 'old-provider', participantId: 'old-consumer' }
    }), {
        id: 'edc-1',
        name: 'EDC',
        endpoint: 'https://consumer.example',
        secretRef: 'edc-key',
        type: 'edc',
        settings: {
            catalogPath: '/custom/catalog',
            counterPartyAddress: 'https://provider.example/protocol',
            providerId: 'provider'
        }
    });
});

test('DPU research actions reuse WebSkel modals and shared UI classes', () => {
    const explorerRoot = path.resolve(process.cwd());
    const presenter = fs.readFileSync(path.join(explorerRoot, 'web-components/pages/file-exp/file-exp.js'), 'utf8');
    const provider = fs.readFileSync(path.join(explorerRoot, 'web-components/pages/file-exp/file-exp-dpu-provider.js'), 'utf8');
    const permissions = fs.readFileSync(path.resolve(
        explorerRoot,
        '../dpuAgent/IDE-plugins/dpu-runtime-support/components/dpu-permissions-modal/dpu-permissions-modal.js'
    ), 'utf8');

    assert.doesNotMatch(presenter, /window\.prompt\('Principal to share|window\.confirm\(`Confirm DPU action|window\.alert\(JSON\.stringify/);
    assert.match(presenter, /showModal\('confirm-action-modal'/);
    assert.match(presenter, /showModal\('dpu-permissions-modal',[\s\S]*?kind: 'resource'/);
    assert.doesNotMatch(presenter, /shareDpuResearchResource/);
    assert.doesNotMatch(provider, /data-local-action="shareDpuResearchResource"/);
    assert.match(provider, /data-local-action="showDpuResearchPermissions">Manage access<\/button>/);
    assert.doesNotMatch(provider, /data-local-action="showDpuResearchProvenance"/);
    assert.match(provider, /<details class="settings-card settings-card-static dpu-research-card dpu-research-provenance">/);
    assert.match(provider, /callDpuTool\('dpu_resource_get_provenance'/);
    assert.match(provider, /class="settings-card settings-card-static dpu-research-card"/);
    assert.match(permissions, /dpu_resource_share/);
    assert.match(permissions, /dpu_action_confirm/);
});

test('resolvePluginSettingsUrl accepts only router-relative settings URLs', () => {
    assert.equal(
        resolvePluginSettingsUrl({ settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/' }),
        '/base-agent-additional-server/soul-gateway/7000/management/'
    );
    assert.equal(resolvePluginSettingsUrl({ settingsUrl: 'https://soul.axiologic.dev/management/' }), '');
    assert.equal(resolvePluginSettingsUrl({ settingsUrl: '//soul.axiologic.dev/management/' }), '');
    assert.equal(resolvePluginSettingsUrl({ settingsUrl: 'javascript:alert(1)' }), '');
});

test('openPluginSettingsUrl opens router-relative settings without a modal', () => {
    const calls = [];
    const openedWindow = { opener: {} };
    const opened = openPluginSettingsUrl(
        { settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/' },
        {
            open: (...args) => {
                calls.push(args);
                return openedWindow;
            }
        }
    );

    assert.equal(opened, true);
    assert.deepEqual(calls, [
        ['/base-agent-additional-server/soul-gateway/7000/management/', '_blank', 'noopener,noreferrer']
    ]);
    assert.equal(openedWindow.opener, null);
});

test('buildAgentSettingsItems maps Soul Gateway from runtime plugin key and preserves settings URL', () => {
    const items = buildAgentSettingsItems([
        {
            key: 'soul-gateway',
            label: 'Soul Gateway',
            ownerAgent: 'soul-gateway',
            pluginKey: 'soul-gateway/soul-gateway',
            scope: 'workspace',
            settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/',
            adminOnly: true
        }
    ], [
        {
            key: 'soul-gateway/soul-gateway',
            agent: 'soul-gateway',
            component: 'soul-gateway-settings',
            pluginId: 'soul-gateway',
            settingsComponent: 'soul-gateway-settings',
            settingsUrl: '/base-agent-additional-server/soul-gateway/7000/management/',
            adminOnly: true
        }
    ]);
    const soulGateway = items.find((item) => item.key === 'soul-gateway');

    assert.ok(soulGateway);
    assert.equal(soulGateway.available, true);
    assert.equal(soulGateway.settingsComponent, 'soul-gateway-settings');
    assert.equal(soulGateway.settingsUrl, '/base-agent-additional-server/soul-gateway/7000/management/');
    assert.equal(soulGateway.sourcePlugin.key, 'soul-gateway/soul-gateway');
});

test('buildAgentSettingsItems maps a neutral settings plugin fixture', () => {
    const items = buildAgentSettingsItems([
        {
            key: 'analytics-settings',
            label: 'Analytics',
            ownerAgent: 'analytics',
            pluginKey: 'analytics/analytics-settings',
            scope: 'workspace',
            settingsComponent: 'analytics-settings',
            adminOnly: true
        }
    ], [
        {
            key: 'analytics/analytics-settings',
            agent: 'analytics',
            component: 'analytics-settings',
            pluginId: 'analytics',
            settingsComponent: 'analytics-settings',
            adminOnly: true,
            assetRootPath: '.ploinky/repos/example/analytics/IDE-plugins/analytics-settings'
        }
    ]);
    const analytics = items.find((item) => item.key === 'analytics-settings');

    assert.ok(analytics);
    assert.equal(analytics.available, true);
    assert.equal(analytics.settingsComponent, 'analytics-settings');
    assert.equal(analytics.sourcePlugin.key, 'analytics/analytics-settings');
    assert.equal(analytics.assetRootPath, '.ploinky/repos/example/analytics/IDE-plugins/analytics-settings');
    assert.equal(analytics.runtimeStatus, 'checking');
});

test('applyAgentRuntimeStatuses maps settings owners to unique marketplace agents', () => {
    const items = applyAgentRuntimeStatuses([
        { key: 'search-settings', ownerAgent: 'searchAgent' },
        { key: 'analytics-settings', ownerAgent: 'example/analytics' }
    ], [
        { ref: 'legacy-agents/searchAgent', name: 'searchAgent', running: false, active: true },
        { ref: 'example/analytics', name: 'analytics', running: true, status: 'running' }
    ]);

    assert.deepEqual(items.map(({ agentRef, runtimeAvailable, runtimeStatus }) => ({
        agentRef,
        runtimeAvailable,
        runtimeStatus
    })), [
        { agentRef: 'legacy-agents/searchAgent', runtimeAvailable: true, runtimeStatus: 'stopped' },
        { agentRef: 'example/analytics', runtimeAvailable: true, runtimeStatus: 'running' }
    ]);
});

test('applyAgentRuntimeStatuses does not guess an ambiguous unqualified agent name', () => {
    const [item] = applyAgentRuntimeStatuses([
        { key: 'settings', ownerAgent: 'worker' }
    ], [
        { ref: 'one/worker', name: 'worker', running: true },
        { ref: 'two/worker', name: 'worker', running: false }
    ]);

    assert.equal(item.agentRef, '');
    assert.equal(item.runtimeAvailable, false);
    assert.equal(item.runtimeStatus, 'unavailable');
});

test('normalizeAgentRuntimeStatus prefers the effective running state', () => {
    assert.equal(normalizeAgentRuntimeStatus({ running: true, status: 'starting' }), 'running');
    assert.equal(normalizeAgentRuntimeStatus({ active: false, running: true, status: 'running' }), 'inactive');
    assert.equal(normalizeAgentRuntimeStatus({ running: false, status: 'failed' }), 'failed');
    assert.equal(normalizeAgentRuntimeStatus({ running: false, active: false }), 'inactive');
});

test('buildAgentSettingsItems marks missing source plugin unavailable', () => {
    const items = buildAgentSettingsItems([
        {
            key: 'missing-agent',
            label: 'Missing Agent',
            ownerAgent: 'missingAgent',
            pluginKey: 'missingAgent/missing-settings',
            scope: 'workspace',
            settingsComponent: 'missing-settings',
            adminOnly: false
        }
    ], []);

    assert.equal(items.length, 1);
    assert.equal(items[0].available, false);
    assert.equal(items[0].sourcePlugin, null);
});

test('buildAgentSettingsItems hides admin-only entries for non-admin view models', () => {
    const items = buildAgentSettingsItems([
        {
            key: 'admin-settings',
            label: 'Admin Settings',
            ownerAgent: 'adminAgent',
            pluginKey: 'adminAgent/admin-settings',
            scope: 'workspace',
            settingsComponent: 'admin-settings',
            adminOnly: true
        },
        {
            key: 'user-settings',
            label: 'User Settings',
            ownerAgent: 'userAgent',
            pluginKey: 'userAgent/user-settings',
            scope: 'workspace',
            settingsComponent: 'user-settings',
            adminOnly: false
        }
    ], [], { isAdmin: false });

    assert.deepEqual(items.map((item) => item.key), ['user-settings']);
});

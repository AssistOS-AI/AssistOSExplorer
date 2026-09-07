import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.resolve(
    import.meta.dirname,
    '../../IDE-plugins/marketplace/components/marketplace-modal/marketplace-modal.js'
);

async function loadMarketplaceModal() {
    const source = await fs.readFile(sourcePath, 'utf8');
    const withoutImports = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*/g, '');
    const dependencies = `
        const callExplorerTool = async () => ({});
        const parseToolResult = (value) => value;
        const buildAgentSettingsItems = () => [];
        const ensureSettingsComponentRegistered = async () => {};
        const resolvePluginSettingsUrl = () => '';
        const flattenPluginsByKey = () => [];
        const getCachedRuntimePlugins = () => null;
        const fetchMarketplaceProof = (...args) => globalThis.__marketplaceFetchMarketplaceProof(...args);
        const publishRuntimeStatusEvents = (...args) => globalThis.__marketplacePublishRuntimeStatusEvents?.(...args) || Promise.resolve();
        const isRetryableRuntimeStatusStreamError = (error) => !Number.isFinite(Number(error?.status)) || [502, 503, 504].includes(Number(error.status));
        const RUNTIME_STATUS_UPDATED_EVENT = 'ploinky:runtime-status-updated';
    `;
    const url = `data:text/javascript;base64,${Buffer.from(dependencies + withoutImports).toString('base64')}`;
    return import(url);
}

test('Marketplace status and busy updates do not rebuild reactive child components', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    modal.state = {status: '', statusType: '', busy: false};
    let statusRenders = 0;
    let interactiveSyncs = 0;
    modal.renderStatus = () => { statusRenders += 1; };
    modal.syncInteractiveState = () => { interactiveSyncs += 1; };
    modal.renderState = () => assert.fail('status and busy updates must not rebuild Marketplace content');

    modal.setStatus('Loading marketplace...');
    modal.setBusy(true);

    assert.equal(statusRenders, 1);
    assert.equal(interactiveSyncs, 1);
    assert.equal(modal.state.status, 'Loading marketplace...');
    assert.equal(modal.state.busy, true);
});

test('Marketplace initial load performs one structural render after state settles', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    modal.state = {marketplace: null, status: 'Loading marketplace...', statusType: '', busy: false};
    modal.requestMarketplace = async () => ({permissions: {canManage: false}, repositories: [], agents: []});
    modal.renderStatus = () => {};
    modal.syncInteractiveState = () => {};
    let structuralRenders = 0;
    modal.renderState = () => { structuralRenders += 1; };

    await modal.loadMarketplace();

    assert.equal(structuralRenders, 1);
    assert.equal(modal.state.busy, false);
    assert.deepEqual(modal.state.marketplace.repositories, []);
});

test('Marketplace reads omit admin proof and mutations attach a fresh proof', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalProofFetcher = globalThis.__marketplaceFetchMarketplaceProof;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalProofFetcher === undefined) delete globalThis.__marketplaceFetchMarketplaceProof;
        else globalThis.__marketplaceFetchMarketplaceProof = originalProofFetcher;
    });

    let proofCalls = 0;
    const calls = [];
    globalThis.__marketplaceFetchMarketplaceProof = async () => {
        proofCalls += 1;
        return { origin: 'http://localhost:8082', header: 'x-ploinky-csrf-token', csrfToken: `v1.proof-${proofCalls}` };
    };
    globalThis.fetch = async (path, options) => {
        calls.push({
            path,
            method: options.method || 'GET',
            headers: { ...options.headers },
            body: options.body
        });
        return {
            status: 200,
            ok: true,
            json: async () => ({ ok: true, marketplace: { agents: [] } })
        };
    };

    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    await modal.requestMarketplace();
    await modal.requestMarketplace({ action: 'enable_agent', agentRef: 'proxies/searchAgent' });

    assert.equal(proofCalls, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers['x-ploinky-csrf-token'], undefined);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].headers['x-ploinky-csrf-token'], 'v1.proof-1');
    assert.equal(calls[1].headers['Content-Type'], 'application/json');
    assert.equal(calls[1].body, JSON.stringify({ action: 'enable_agent', agentRef: 'proxies/searchAgent' }));
});

test('Marketplace retries once with a new proof only after csrf_invalid', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalProofFetcher = globalThis.__marketplaceFetchMarketplaceProof;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalProofFetcher === undefined) delete globalThis.__marketplaceFetchMarketplaceProof;
        else globalThis.__marketplaceFetchMarketplaceProof = originalProofFetcher;
    });

    let proofCalls = 0;
    const suppliedProofs = [];
    globalThis.__marketplaceFetchMarketplaceProof = async () => ({
        origin: 'http://localhost:8082',
        header: 'x-ploinky-csrf-token',
        csrfToken: `v1.proof-${++proofCalls}`
    });
    globalThis.fetch = async (_path, options) => {
        suppliedProofs.push(options.headers['x-ploinky-csrf-token']);
        if (suppliedProofs.length === 1) {
            return {
                status: 403,
                ok: false,
                json: async () => ({ ok: false, error: 'csrf_invalid' })
            };
        }
        return {
            status: 200,
            ok: true,
            json: async () => ({ ok: true, marketplace: { agents: [] } })
        };
    };

    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    await modal.requestMarketplace({ action: 'enable_agent', agentRef: 'proxies/searchAgent' });

    assert.equal(proofCalls, 2);
    assert.deepEqual(suppliedProofs, ['v1.proof-1', 'v1.proof-2']);
});

test('Marketplace retries once with a new proof after browser_csrf_invalid on a public host', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalProofFetcher = globalThis.__marketplaceFetchMarketplaceProof;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalProofFetcher === undefined) delete globalThis.__marketplaceFetchMarketplaceProof;
        else globalThis.__marketplaceFetchMarketplaceProof = originalProofFetcher;
    });

    let proofCalls = 0;
    const suppliedProofs = [];
    globalThis.__marketplaceFetchMarketplaceProof = async () => ({
        origin: 'https://explorer.example.test',
        header: 'x-ploinky-browser-csrf-token',
        csrfToken: `v1.proof-${++proofCalls}`
    });
    globalThis.fetch = async (_path, options) => {
        suppliedProofs.push(options.headers['x-ploinky-browser-csrf-token']);
        if (suppliedProofs.length === 1) {
            return {
                status: 403,
                ok: false,
                json: async () => ({ ok: false, error: 'browser_csrf_invalid' })
            };
        }
        return {
            status: 200,
            ok: true,
            json: async () => ({ ok: true, marketplace: { agents: [] } })
        };
    };

    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    await modal.requestMarketplace({ action: 'enable_agent', agentRef: 'proxies/searchAgent' });

    assert.equal(proofCalls, 2);
    assert.deepEqual(suppliedProofs, ['v1.proof-1', 'v1.proof-2']);
});

test('Marketplace does not retry a rejected mutation for non-CSRF failures', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalProofFetcher = globalThis.__marketplaceFetchMarketplaceProof;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalProofFetcher === undefined) delete globalThis.__marketplaceFetchMarketplaceProof;
        else globalThis.__marketplaceFetchMarketplaceProof = originalProofFetcher;
    });

    let proofCalls = 0;
    let mutationCalls = 0;
    globalThis.__marketplaceFetchMarketplaceProof = async () => {
        proofCalls += 1;
        return { origin: 'http://localhost:8082', header: 'x-ploinky-csrf-token', csrfToken: 'v1.proof' };
    };
    globalThis.fetch = async () => {
        mutationCalls += 1;
        return {
            status: 403,
            ok: false,
            json: async () => ({ ok: false, error: 'admin_required', message: 'Administrator access is required.' })
        };
    };

    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    await assert.rejects(
        modal.requestMarketplace({ action: 'enable_agent', agentRef: 'proxies/searchAgent' }),
        /Administrator access is required/
    );

    assert.equal(proofCalls, 1);
    assert.equal(mutationCalls, 1);
});

test('Marketplace enables Configure only while its agent is running', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    const settingsButton = {
        dataset: {agentSettingsKey: 'search-settings', agentOperational: 'false'},
        disabled: false,
        setAttribute(name, value) {
            this[name] = value;
        }
    };
    modal.state = {busy: false, agentSettingsBusyKey: ''};
    modal.repositoriesEl = {querySelectorAll: () => []};
    modal.agentsEl = {
        querySelectorAll(selector) {
            return selector === '[data-agent-settings-key]' ? [settingsButton] : [];
        }
    };
    modal.canManageMarketplace = () => true;

    modal.syncInteractiveState();
    assert.equal(settingsButton.disabled, true);

    settingsButton.dataset.agentOperational = 'true';
    modal.syncInteractiveState();
    assert.equal(settingsButton.disabled, false);
    assert.equal(settingsButton['aria-disabled'], 'false');
});

test('Marketplace stream transitions preserve normalized presentation and real Configure gating without rebuilding rows', async (t) => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({}, () => {});
    modal.state = {
        busy: false,
        marketplace: {
            permissions: {canManage: true},
            agents: [{ref: 'AchillesIDE/webAssist', active: true, status: 'starting', running: false,
                statusDetail: 'Background startup is in progress.'}]
        }
    };
    const attributes = () => ({
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; }
    });
    const status = {...attributes()};
    const settingsButton = {...attributes(), dataset: {agentSettingsKey: 'webassist-settings'}};
    const toggle = {
        dataset: {agentRef: 'AchillesIDE/webAssist', active: 'true'},
        classList: {
            active: true,
            toggle(_name, enabled) {
                this.active = enabled;
            }
        },
        textContent: 'Disable'
    };
    const mode = {
        dataset: {enableModeFor: 'AchillesIDE/webAssist'},
        closest: () => ({querySelector: () => toggle}),
        toggleAttribute(_name, disabled) { this.disabled = disabled; }
    };
    const row = {
        dataset: {marketplaceAgentRef: 'AchillesIDE/webAssist'},
        querySelector(selector) {
            if (selector === '.marketplace-agent-status') return status;
            if (selector === '[data-agent-settings-key]') return settingsButton;
            if (selector === '[data-agent-ref]') return toggle;
            return null;
        }
    };
    modal.agentsEl = {
        querySelectorAll(selector) {
            return {
                '[data-marketplace-agent-ref]': [row],
                '[data-agent-settings-key]': [settingsButton],
                '[data-agent-ref]': [toggle],
                '[data-enable-mode-for]': [mode]
            }[selector] || [];
        }
    };
    modal.renderAgents = () => assert.fail('runtime status updates must not rebuild agent rows');
    t.after(() => clearTimeout(modal.agentStatusRefreshTimer));
    modal.updateAgentRuntimeUi(modal.state.marketplace.agents[0]);
    modal.syncInteractiveState();
    assert.equal(status.textContent, 'Starting up');
    assert.equal(status.title, 'Background startup is in progress.');
    assert.equal(status['aria-label'], 'webAssist status: Starting up');
    assert.equal(settingsButton.disabled, true);
    assert.equal(settingsButton['aria-disabled'], 'true');
    assert.equal(settingsButton.title, 'Configure is available once webAssist is running.');
    assert.equal(mode.disabled, true);

    const sendState = (enabled, runtimeState) => modal.handleRuntimeStatusUpdated({
        detail: {
            runtimes: [{
                repoName: 'AchillesIDE',
                agentName: 'webAssist',
                enabled,
                state: runtimeState
            }]
        }
    });
    sendState(true, {status: 'running', running: true});
    assert.equal(modal.state.marketplace.agents[0].status, 'running');
    assert.equal(status.textContent, 'Running');
    assert.equal(status.className, 'marketplace-agent-status running');
    assert.equal(status['aria-label'], 'webAssist status: Running');
    assert.equal(status.title, undefined);
    assert.equal(settingsButton.dataset.agentOperational, 'true');
    assert.equal(settingsButton.disabled, false);
    assert.equal(settingsButton['aria-disabled'], 'false');
    assert.equal(settingsButton.title, undefined);
    assert.equal(toggle.dataset.active, 'true');
    assert.equal(toggle.classList.active, true);
    assert.equal(toggle.textContent, 'Disable');

    sendState(true, {status: 'stopped', running: false});
    assert.equal(status.textContent, 'Stopped');
    assert.equal(settingsButton.dataset.agentOperational, 'false');
    assert.equal(settingsButton.disabled, true);
    assert.equal(settingsButton['aria-disabled'], 'true');
    assert.equal(mode.disabled, true);

    sendState(true, {status: 'starting', running: false});
    assert.equal(status.textContent, 'Starting up');
    assert.ok(modal.agentStatusRefreshTimer, 'streamed startup schedules snapshot refresh');
    sendState(true, {status: 'running', running: true});
    assert.equal(modal.agentStatusRefreshTimer, null);
    assert.equal(settingsButton.disabled, false);
    modal.state.agentMutationBusyRef = 'AchillesIDE/webAssist';
    modal.state.agentMutationVerb = 'Disabling';
    sendState(false, {status: 'inactive', running: true});
    assert.equal(status.textContent, 'Disabled');
    assert.equal(status.className, 'marketplace-agent-status disabled');
    assert.equal(status['aria-label'], 'webAssist status: Disabled');
    assert.equal(settingsButton.disabled, true, 'disabled agent cannot configure even with contradictory running evidence');
    assert.equal(settingsButton.dataset.agentOperational, 'false');
    assert.equal(toggle.textContent, 'Disabling...');
    assert.equal(toggle.disabled, true);
    modal.state.agentMutationBusyRef = '';
    sendState(false, {status: 'inactive', running: false});
    assert.equal(toggle.textContent, 'Enable');
    assert.equal(mode.disabled, false);
    assert.equal(toggle.disabled, false);

    sendState(true, {status: 'untrusted arbitrary-class', running: false});
    assert.equal(status.textContent, 'Unknown');
    assert.equal(status.className, 'marketplace-agent-status unknown');
    assert.equal(settingsButton.disabled, true);
    modal.handleRuntimeStatusUpdated({detail: {runtimes: []}});
    assert.equal(status.textContent, 'Disabled', 'missing runtime evidence must close Configure');
    assert.equal(settingsButton.disabled, true);
});

test('Marketplace does not reconnect the runtime status stream after a permanent HTTP error', async (t) => {
    const originalWindow = globalThis.window;
    const originalPublisher = globalThis.__marketplacePublishRuntimeStatusEvents;
    const windowTarget = new EventTarget();
    globalThis.window = windowTarget;
    globalThis.__marketplacePublishRuntimeStatusEvents = async () => {
        throw Object.assign(new Error('Runtime status stream failed (404)'), {status: 404});
    };
    t.after(() => {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
        if (originalPublisher === undefined) delete globalThis.__marketplacePublishRuntimeStatusEvents;
        else globalThis.__marketplacePublishRuntimeStatusEvents = originalPublisher;
    });

    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    modal.state = {marketplace: {permissions: {canManage: true}}};
    modal.handleRuntimeStatusUpdated = () => {};
    modal.startAgentStatusStream();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(modal.agentStatusStreamActive, false);
    assert.equal(modal.agentStatusStreamController, null);
    assert.equal(modal.agentStatusReconnectTimer, undefined);
});

test('Marketplace presents a bounded set of distinct lifecycle states', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);

    assert.deepEqual([
        {active: false, status: 'inactive', running: false},
        {active: true, status: 'starting', running: false},
        {active: true, status: 'running', running: true},
        {active: true, status: 'stopped', running: false},
        {active: true, status: 'failed', running: false},
        {active: true, status: 'paused', running: false},
        {active: true, status: 'arbitrary-class-name', running: false}
    ].map(agent => modal.getAgentLifecycleStatus(agent)), [
        'disabled',
        'starting',
        'running',
        'stopped',
        'failed',
        'paused',
        'unknown'
    ]);

    assert.deepEqual(modal.getAgentStatusPresentation({
        active: true,
        status: 'starting',
        running: false,
        statusDetail: 'Background startup is in progress.'
    }), {
        status: 'starting',
        label: 'Starting up',
        detail: 'Background startup is in progress.'
    });
});

test('Marketplace only allows configuration for a verified running agent', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);

    assert.equal(modal.isAgentOperational({active: true, status: 'running', running: true}), true);
    assert.equal(modal.isAgentOperational({active: true, status: 'running'}), false);
    assert.equal(modal.isAgentOperational({active: true, status: 'running', running: false}), false);
    for (const status of ['starting', 'stopped', 'failed', 'paused', 'unknown']) {
        assert.equal(modal.isAgentOperational({active: true, status, running: false}), false, status);
    }
    assert.equal(modal.isAgentOperational({active: false, status: 'disabled', running: false}), false);
});

test('Marketplace ignores settings clicks for agents that are not operational', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({}, () => {});
    modal.openAgentSettings = () => assert.fail('non-operational settings must not open');
    const button = {
        disabled: true,
        dataset: {agentSettingsKey: 'searchAgent', agentOperational: 'false'}
    };

    await modal.handleAgentClick({
        target: {
            closest: selector => selector === '[data-agent-settings-key]' ? button : null
        }
    });
});

test('Marketplace refreshes starting agents until the backend reports a terminal state', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = Object.create(MarketplaceModal.prototype);
    modal.unloaded = false;
    modal.state = {
        marketplace: {
            agents: [{active: true, status: 'starting', running: false}]
        },
        busy: false,
        agentMutationBusyRef: ''
    };
    modal.requestMarketplace = async () => ({
        agents: [{active: true, status: 'running', running: true}]
    });
    let agentRenders = 0;
    let interactiveSyncs = 0;
    modal.renderAgents = () => { agentRenders += 1; };
    modal.syncInteractiveState = () => { interactiveSyncs += 1; };

    await modal.refreshAgentStatuses();

    assert.equal(modal.state.marketplace.agents[0].status, 'running');
    assert.equal(agentRenders, 1);
    assert.equal(interactiveSyncs, 1);
    assert.equal(modal.agentStatusRefreshTimer, undefined);
});

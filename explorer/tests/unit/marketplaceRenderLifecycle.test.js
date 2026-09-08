import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMarketplaceModal} from '../helpers/marketplaceModal.js';

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

test('Marketplace catalog transitions preserve normalized presentation and real Configure gating without rebuilding rows', async (t) => {
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

    const sendState = (active, runtimeState) => modal.applyMarketplaceSnapshot({
        ...modal.state.marketplace,
        agents: [{ref: 'AchillesIDE/webAssist', active, ...runtimeState}],
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
    sendState(true, {status: 'running', running: true});
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
    sendState(true, {status: 'failed', running: false, statusDetail: 'The new startup failed.'});
    assert.equal(status.textContent, 'Failed');
    assert.equal(status.title, 'The new startup failed.');
    assert.equal(settingsButton.disabled, true);
});

test('Marketplace stops polling and reports permanent authorization failure', async (t) => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({}, () => {});
    modal.state.marketplace = {permissions: {canManage: true}, agents: []};
    modal.renderStatus = () => {};
    modal.renderState = () => {};
    modal.requestMarketplace = async () => { throw Object.assign(new Error('Administrator access is required.'), {status: 403}); };
    t.after(() => clearTimeout(modal.agentStatusRefreshTimer));
    await modal.refreshAgentStatuses();
    assert.equal(modal.agentStatusRefreshStopped, true);
    assert.equal(modal.agentStatusRefreshController, null);
    assert.equal(modal.agentStatusRefreshTimer, undefined);
    assert.equal(modal.state.statusType, 'error');
    assert.equal(modal.state.status, 'Administrator access is required.');
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

test('Marketplace keeps polling after an agent reaches Running without rebuilding unchanged inventory', async (t) => {
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
    assert.equal(agentRenders, 0);
    assert.equal(interactiveSyncs, 1);
    assert.ok(modal.agentStatusRefreshTimer);
    t.after(() => clearTimeout(modal.agentStatusRefreshTimer));
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

test('Marketplace polling is serial and resumes after transient failure while preserving mutation errors', async (t) => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({}, () => {});
    modal.state.marketplace = {agents: [], repositories: []};
    modal.state.status = 'Previous mutation failed';
    modal.state.statusType = 'error';
    const request = deferred();
    let requests = 0;
    modal.requestMarketplace = async () => {
        requests += 1;
        await request.promise;
        throw Object.assign(new Error('Unavailable'), {status: 503});
    };
    const first = modal.refreshAgentStatuses();
    await modal.refreshAgentStatuses();
    assert.equal(requests, 1);
    request.resolve();
    await first;
    assert.equal(modal.agentStatusRefreshStopped, undefined);
    assert.equal(modal.state.status, 'Previous mutation failed');
    assert.ok(modal.agentStatusRefreshTimer);
    t.after(() => clearTimeout(modal.agentStatusRefreshTimer));
});

test('Marketplace unload aborts an outstanding read and cannot render or schedule another poll', async () => {
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({querySelector: () => null}, () => {});
    modal.state.marketplace = {agents: [], repositories: []};
    const request = deferred();
    let signal;
    modal.requestMarketplace = async (_action, options) => { signal = options.signal; return request.promise; };
    modal.applyMarketplaceSnapshot = () => assert.fail('unmounted catalog cannot be applied');
    const refresh = modal.refreshAgentStatuses();
    modal.afterUnload();
    assert.equal(signal.aborted, true);
    request.resolve({agents: [], repositories: []});
    await refresh;
    assert.equal(modal.agentStatusRefreshController, null);
    assert.equal(modal.agentStatusRefreshTimer, undefined);
});

test('Marketplace mutation invalidates an older poll even when its response arrives after the mutation', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalProof = globalThis.__marketplaceFetchMarketplaceProof;
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({}, () => {});
    const oldCatalog = {agents: [{ref: 'repo/agent', active: false}], repositories: []};
    const newCatalog = {agents: [{ref: 'repo/agent', active: true}], repositories: []};
    modal.state.marketplace = oldCatalog;
    const request = deferred();
    let readSignal;
    globalThis.__marketplaceFetchMarketplaceProof = async () => ({header: 'x-ploinky-csrf-token', csrfToken: 'test-proof'});
    globalThis.fetch = async (_url, options) => {
        if (options.method === 'POST') return {ok: true, status: 200, json: async () => ({marketplace: newCatalog})};
        readSignal = options.signal;
        await request.promise;
        return {ok: true, status: 200, json: async () => ({marketplace: oldCatalog})};
    };
    modal.applyMarketplaceSnapshot = value => { modal.state.marketplace = value; };
    t.after(() => {
        clearTimeout(modal.agentStatusRefreshTimer);
        globalThis.fetch = originalFetch;
        if (originalProof === undefined) delete globalThis.__marketplaceFetchMarketplaceProof;
        else globalThis.__marketplaceFetchMarketplaceProof = originalProof;
    });
    const refresh = modal.refreshAgentStatuses();
    modal.state.marketplace = await modal.requestMarketplace({action: 'enable_agent', agentRef: 'repo/agent'});
    assert.equal(readSignal.aborted, true);
    request.resolve();
    await refresh;
    assert.equal(modal.state.marketplace, newCatalog);
    assert.ok(modal.agentStatusRefreshTimer);
});

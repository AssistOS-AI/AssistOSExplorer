import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SettingsModal } from '../../web-components/modals/settings-modal/settings-modal.js';
import { readSettingsTab } from '../../shared/ui/settings-navigation.js';

const snapshot = { applications: [], hosts: [] };

function settings(tab) {
    const element = { dataset: {}, querySelector: () => null, querySelectorAll: () => [] };
    const modal = new SettingsModal(element, () => {}, { tab });
    modal.cacheTab = { hidden: true };
    modal.cacheSection = {
        classList: { toggle() {} },
        querySelector() { return this.panel; },
        replaceChildren(panel) { this.panel = panel; },
    };
    modal.cacheAccessStatus = { hidden: true };
    modal.actionsEl = {};
    modal.loadAgentSettingsData = async () => {};
    modal.updateTabUI();
    return modal;
}

function router(t, status) {
    t.mock.method(globalThis, 'fetch', async (url) => {
        assert.equal(url, '/api/marketplace/cache');
        return Response.json(status === 200 ? snapshot : { error: 'admin_required' }, { status });
    });
}

test('Cache is registered, hidden in the template, and addressable through Settings URLs', async () => {
    const root = new URL('../../', import.meta.url);
    const registry = JSON.parse(await readFile(new URL('webskel.json', root), 'utf8'));
    assert.ok(registry.components.some((entry) => entry.name === 'cache-panel' && entry.presenterClassName === 'CachePanel'));
    const template = await readFile(new URL('web-components/modals/settings-modal/settings-modal.html', root), 'utf8');
    assert.match(template, /data-tab="cache" data-cache-tab hidden[^>]*>Cache</);
    assert.equal(readSettingsTab({ href: 'https://example.test/?settings=cache#file-exp/demo' }), 'cache');
});

for (const status of [401, 403]) {
    test(`HTTP ${status} denies direct Cache navigation even with other administration tabs available`, async (t) => {
        router(t, status);
        const modal = settings('cache');
        Object.assign(modal.state, { hardwareAccess: true, usersAccess: true });
        assert.equal(modal.cacheTab.hidden, true);
        await modal.refreshCacheAccess();
        assert.equal(modal.getAllowedTabs().includes('cache'), false);
        assert.equal(modal.state.activeTab, 'agents');
        assert.equal(modal.cacheTab.hidden, true);
        assert.equal(modal.cacheSection.panel, undefined);
        assert.equal(modal.cacheAccessStatus.hidden, false);
        assert.match(modal.cacheAccessStatus.textContent, /administrator access/);
        assert.equal(modal.requestedInitialTab, '');
    });
}

test('a successful protected read opens the Cache deep link and revocation removes the mounted panel', async (t) => {
    router(t, 200);
    const originalDocument = globalThis.document;
    const originalAssistOS = globalThis.assistOS;
    t.after(() => { globalThis.document = originalDocument; globalThis.assistOS = originalAssistOS; });
    globalThis.assistOS = { webSkel: { ensureComponentRegistered: async (name) => assert.equal(name, 'cache-panel') } };
    const modal = settings('cache');
    globalThis.document = { createElement(name) {
        assert.equal(name, 'cache-panel');
        return Object.assign(new EventTarget(), { setAttribute(key, value) {
            assert.equal(key, 'data-presenter');
            assert.equal(value, name);
        } });
    } };
    await modal.refreshCacheAccess();
    assert.equal(modal.cacheTab.hidden, false);
    assert.equal(modal.state.activeTab, 'cache');
    assert.equal(modal.actionsEl.hidden, true);
    assert.deepEqual(modal.cacheSection.panel.cacheSnapshot, snapshot);
    modal.cacheSection.panel.dispatchEvent(new CustomEvent('cache-access-denied'));
    assert.equal(modal.state.activeTab, 'agents');
    assert.equal(modal.cacheTab.hidden, true);
    assert.equal(modal.cacheSection.panel, undefined);
    assert.match(modal.cacheAccessStatus.textContent, /administrator access/);
});

test('an unavailable access probe cannot expose Cache through a local administrator name', async (t) => {
    router(t, 503);
    const original = globalThis.assistOS;
    t.after(() => { globalThis.assistOS = original; });
    globalThis.assistOS = { user: { username: 'admin', roles: ['user'] } };
    const modal = settings('cache');
    await modal.refreshCacheAccess();
    assert.equal(modal.cacheTab.hidden, true);
    assert.equal(modal.state.cacheAccess, false);
    assert.equal(modal.cacheSection.panel, undefined);
    assert.match(modal.cacheAccessStatus.textContent, /unavailable/);
});

test('a read interrupted by closing Settings cannot reveal Cache or mount a late panel', async (t) => {
    let resolve;
    t.mock.method(globalThis, 'fetch', () => new Promise((done) => { resolve = done; }));
    const modal = settings('cache');
    const check = modal.refreshCacheAccess();
    modal.afterUnload();
    assert.equal(modal.cacheAbort.signal.aborted, true);
    resolve(Response.json(snapshot));
    await check;
    assert.equal(modal.cacheTab.hidden, true);
    assert.equal(modal.cacheSection.panel, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { accountController } from '../../web-components/modals/settings-modal/settings-account-controller.js';
import { fetchAccountAccess, usersController } from '../../web-components/modals/settings-modal/settings-users-controller.js';
import { SettingsModal, openPluginSettingsUrl, buildAgentSettingsItems } from '../../web-components/modals/settings-modal/settings-modal.js';
import { UserpersistoSettings } from '../../../userPersistoAgent/IDE-plugins/userpersisto-settings/userpersisto-settings.js';

const dashboard = '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/';
const settingsRoot = new URL('../../web-components/modals/settings-modal/', import.meta.url);
const pluginRoot = new URL('../../../userPersistoAgent/IDE-plugins/userpersisto-settings/', import.meta.url);

function response(capabilities = [], status = 200) {
    return { ok: status === 200, status, json: async () => ({ ok: status === 200, profile: { user: { id: 'test-user' }, capabilities } }) };
}

test('Settings account and administration contain only new-tab links to UserPersisto pages', async () => {
    const html = await fs.readFile(new URL('settings-modal.html', settingsRoot), 'utf8');
    const account = html.match(/<section[^>]*data-section="account"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    const administration = html.match(/<section[^>]*data-section="users"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    assert.ok(account);
    assert.ok(administration);
    for (const section of [account, administration]) {
        assert.doesNotMatch(section, /<(?:input|textarea|select|form|admin-settings-panel|userpersisto-settings)\b|data-account-mount|role="tab"/);
        for (const [, href, attributes] of section.matchAll(/<a[^>]*href="([^"]+)"([^>]*)>/g)) {
            assert.ok(href.startsWith(dashboard));
            assert.match(attributes, /target="_blank"/);
            assert.match(attributes, /rel="noopener noreferrer"/);
        }
    }
    assert.equal([...account.matchAll(/<a\b/g)].length, 3);
    assert.equal([...administration.matchAll(/<a\b/g)].length, 2);
    assert.ok(administration.includes(`${dashboard}users.html`));
    assert.ok(administration.includes(`${dashboard}applications.html`));
    assert.doesNotMatch(administration, /authentication\.html/);
    assert.match(account, /authentication\.html"[^>]*data-account-capability="admin.agentSettings.manage" hidden/);
});

test('link permissions come from the protected profile without loading user rows', async () => {
    const calls = [];
    const access = await fetchAccountAccess(async (url, options) => {
        calls.push({ url, options });
        return response(['admin.agentSettings.manage']);
    });
    assert.deepEqual(access, { users: false, settings: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${dashboard}api/profile`);
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.cache, 'no-store');
    for (const status of [401, 403, 500]) {
        await assert.rejects(fetchAccountAccess(async () => response([], status)), /could not be verified/);
    }
    await assert.rejects(fetchAccountAccess(async () => ({ ok: true, json: async () => ({ ok: true }) })), /could not be verified/);
});

test('ordinary accounts retain account links while management capabilities control their own links', () => {
    const links = ['admin.users.manage', 'admin.agentSettings.manage'].map((capability) => ({ dataset: { accountCapability: capability } }));
    const controller = { state: {}, element: { querySelectorAll: () => links } };
    for (const [usersAccess, accountSettingsAccess, hidden] of [
        [false, false, [true, true]],
        [true, false, [false, true]],
        [false, true, [true, false]],
    ]) {
        Object.assign(controller.state, { usersAccess, accountSettingsAccess });
        accountController.updateAccountLinks.call(controller);
        assert.deepEqual(links.map((link) => link.hidden), hidden);
        assert.equal(SettingsModal.prototype.getAllowedTabs.call(controller).includes('users'), usersAccess || accountSettingsAccess);
        assert.equal(SettingsModal.prototype.getAllowedTabs.call(controller).includes('account'), true);
    }
});

test('requested Administration tab opens after verified access and stays unavailable on failures', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    for (const status of [200, 403]) {
        globalThis.fetch = async () => response(['admin.agentSettings.manage'], status);
        const controller = { state: { activeTab: 'agents' }, requestedInitialTab: 'users', updateTabUI() {} };
        await usersController.refreshUsersAccess.call(controller);
        assert.equal(controller.state.activeTab, status === 200 ? 'users' : 'agents');
        assert.equal(controller.state.accountSettingsAccess, status === 200);
        assert.equal(controller.state.usersAccess, false);
    }
});

test('UserPersisto Configure uses the generic settings URL launcher', async () => {
    const manifest = JSON.parse(await fs.readFile(new URL('../../../userPersistoAgent/manifest.json', import.meta.url), 'utf8'));
    const plugin = JSON.parse(await fs.readFile(new URL('config.json', pluginRoot), 'utf8'));
    const definition = { ...manifest.ideSettings[0], ownerAgent: 'userPersistoAgent' };
    const [item] = buildAgentSettingsItems([definition], [{ ...plugin, key: 'userPersistoAgent/userpersisto-settings', agent: 'userPersistoAgent', settingsComponent: plugin.settings }]);
    assert.equal(item.available, true);
    assert.equal(item.settingsUrl, dashboard);
    const calls = [];
    assert.equal(openPluginSettingsUrl(item, { open: (...args) => { calls.push(args); return null; } }), true);
    assert.deepEqual(calls, [[dashboard, '_blank', 'noopener,noreferrer']]);
    const source = await fs.readFile(new URL('settings-runtime-controller.js', settingsRoot), 'utf8');
    assert.doesNotMatch(source, /key === "userpersisto-settings"/);
});

test('fallback links hide unauthorized pages and ignore permission replies after unload', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const links = ['admin.users.manage', 'admin.agentSettings.manage'].map((capability) => ({ dataset: { capability }, hidden: false }));
    const status = {};
    const presenter = new UserpersistoSettings({ querySelectorAll: () => links, querySelector: () => status }, () => {});
    globalThis.fetch = async () => response(['admin.users.manage']);
    await presenter.afterRender();
    assert.deepEqual(links.map((link) => link.hidden), [false, true]);
    let resolve;
    globalThis.fetch = () => new Promise((done) => { resolve = done; });
    const pending = presenter.afterRender();
    presenter.afterUnload();
    resolve(response(['admin.users.manage', 'admin.agentSettings.manage']));
    await pending;
    assert.deepEqual(links.map((link) => link.hidden), [true, true]);
    const html = await fs.readFile(new URL('userpersisto-settings.html', pluginRoot), 'utf8');
    assert.doesNotMatch(html, /<(?:input|textarea|select|form)\b/);
    assert.equal([...html.matchAll(/target="_blank" rel="noopener noreferrer"/g)].length, 5);
});

test('legacy administration route checks permissions and links to UserPersisto', async () => {
    const html = await fs.readFile(new URL('../../admin/settings.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /admin-settings-panel|WebSkel|<form\b/);
    assert.match(html, /await fetchAccountAccess\(\)/);
    assert.match(html, /data-account-access="users" hidden/);
    assert.match(html, /data-account-access="settings" hidden/);
    assert.ok(html.includes(`${dashboard}applications.html`));
});

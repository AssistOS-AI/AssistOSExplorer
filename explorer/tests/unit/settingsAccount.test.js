import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { accountController } from '../../web-components/modals/settings-modal/settings-account-controller.js';
import { fetchAccountAccess, usersController } from '../../web-components/modals/settings-modal/settings-users-controller.js';
import { SettingsModal, openPluginSettingsUrl, buildAgentSettingsItems } from '../../web-components/modals/settings-modal/settings-modal.js';
import { UserpersistoSettings } from '../../../userPersistoAgent/IDE-plugins/userpersisto-settings/userpersisto-settings.js';
import { buildAccountPageUrl, loadAccountDashboardUrl, resolveAccountDashboardUrl } from '../../web-components/modals/settings-modal/settings-account-service.js';

const dashboard = '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/';
const settingsRoot = new URL('../../web-components/modals/settings-modal/', import.meta.url);
const pluginRoot = new URL('../../../userPersistoAgent/IDE-plugins/userpersisto-settings/', import.meta.url);

function response(capabilities = [], status = 200) {
    return { ok: status === 200, status, json: async () => ({ ok: status === 200, profile: { user: { id: 'test-user' }, capabilities } }) };
}

test('Settings account and administration each embed a single provider page', async () => {
    const html = await fs.readFile(new URL('settings-modal.html', settingsRoot), 'utf8');
    const account = html.match(/<section[^>]*data-section="account"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    const administration = html.match(/<section[^>]*data-section="users"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    assert.ok(account);
    assert.ok(administration);
    for (const section of [account, administration]) {
        assert.equal([...section.matchAll(/<iframe\b/g)].length, 1);
        assert.doesNotMatch(section, /role="tab"|target="_blank"|<iframe[^>]*\ssrc=/);
    }
    assert.match(administration, /data-administration-frame/);
    assert.match(account, /data-account-frame/);
});

test('administration loads only with access, preserves provider navigation and clears revoked access', () => {
    const frame = { getAttribute() { return this.src; }, removeAttribute() { delete this.src; } };
    const controller = { ...accountController, state: { activeTab: 'agents', usersAccess: true, accountDashboardUrl: dashboard },
        element: { querySelector: () => frame } };
    controller.updateAdministrationFrame();
    assert.equal(frame.src, undefined);
    controller.state.activeTab = 'users';
    controller.updateAdministrationFrame();
    assert.equal(frame.src, dashboard + 'users.html?view=administration&showSignOut=0');
    frame.src = '';
    controller.updateAccountLinks = accountController.updateAccountLinks;
    controller.element.querySelectorAll = () => [];
    controller.updateAccountLinks();
    assert.equal(frame.src, dashboard + 'users.html?view=administration&showSignOut=0');
    frame.src = dashboard + 'roles.html';
    controller.updateAdministrationFrame();
    assert.equal(frame.src, dashboard + 'roles.html');
    controller.state.usersAccess = false;
    controller.updateAdministrationFrame();
    assert.equal(frame.src, undefined);
    controller.state.accountSettingsAccess = true;
    controller.updateAdministrationFrame();
    assert.equal(frame.src, dashboard + 'applications.html?view=administration&showSignOut=0');
});

test('link permissions come from the protected profile without loading user rows', async () => {
    const calls = [];
    const access = await fetchAccountAccess(async (url, options) => {
        calls.push({ url, options });
        return response(['admin.agentSettings.manage']);
    }, dashboard);
    assert.deepEqual(access, { users: false, settings: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${dashboard}api/profile`);
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.cache, 'no-store');
    for (const status of [401, 403, 500]) {
        await assert.rejects(fetchAccountAccess(async () => response([], status), dashboard), /could not be verified/);
    }
    await assert.rejects(fetchAccountAccess(async () => ({ ok: true, json: async () => ({ ok: true }) }), dashboard), /could not be verified/);
});

test('ordinary accounts retain account links while management capabilities control their own links', () => {
    const links = ['admin.users.manage', 'admin.agentSettings.manage'].map((capability) => ({ dataset: { accountCapability: capability } }));
    const controller = { state: {}, element: { querySelectorAll: () => links, querySelector: () => null } };
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
    const originalWindow = globalThis.window;
    globalThis.window = { assistOS: { rawRuntimePlugins: { agentSettings: [{ key: 'userpersisto-settings', settingsUrl: dashboard }] } } };
    t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
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
    assert.equal([...html.matchAll(/target="_blank" rel="noopener noreferrer"/g)].length, 6);
    assert.ok(html.includes(`${dashboard}roles.html`));
});

test('standalone administration entry delegates to Settings without duplicating provider addresses or access checks', async () => {
    const html = await fs.readFile(new URL('../../admin/settings.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /admin-settings-panel|WebSkel|<form\b/);
    assert.doesNotMatch(html, /base-agent-additional-server|fetchAccountAccess|api\/profile/);
    const entry = new URL('https://workspace.example/explorer/admin/settings.html');
    const { readSettingsTab } = await import('../../shared/ui/settings-navigation.js');
    for (const tab of ['account', 'users']) {
        const target = new URL(html.match(new RegExp(`href="([^"]*settings=${tab}[^\"]*)"`))[1], entry);
        assert.equal(target.pathname, '/explorer/index.html');
        assert.equal(readSettingsTab(target), tab);
        assert.equal(target.hash, '#file-exp/');
    }
});

test('My Account loads for ordinary members and preserves its navigation', () => {
    const frame = { getAttribute() { return this.src; } };
    const controller = { state: { activeTab: 'agents', accountDashboardUrl: dashboard }, element: {
        querySelectorAll: () => [],
        querySelector: selector => selector === '[data-account-frame]' ? frame : null,
    } };
    accountController.updateAccountLinks.call(controller);
    assert.equal(frame.src, undefined);
    controller.state.activeTab = 'account';
    accountController.updateAccountLinks.call(controller);
    assert.equal(frame.src, dashboard + '?view=account');
    frame.src = dashboard + '#security-heading';
    accountController.updateAccountLinks.call(controller);
    assert.equal(frame.src, dashboard + '#security-heading');
});

test('account URLs follow the discovered manifest for a different agent alias, port and service path', async (t) => {
    const configured = '/base-agent-additional-server/identity-alias/9017/account-ui/';
    const plugins = { agentSettings: [{ key: 'userpersisto-settings', settingsUrl: configured }] };
    assert.equal(resolveAccountDashboardUrl(plugins), configured);
    const originalWindow = globalThis.window;
    globalThis.window = { assistOS: { rawRuntimePlugins: plugins } };
    t.after(() => { globalThis.window = originalWindow; });
    assert.equal(await loadAccountDashboardUrl(), configured);
    assert.equal(buildAccountPageUrl(configured, '', { view: 'account' }), configured + '?view=account');
    assert.equal(buildAccountPageUrl(configured, 'applications.html', { view: 'administration', showSignOut: '0' }), configured + 'applications.html?view=administration&showSignOut=0');
    const frame = { getAttribute() { return this.src; }, removeAttribute() { delete this.src; } };
    const controller = { state: { activeTab: 'account', accountDashboardUrl: configured }, element: {
        querySelectorAll: () => [],
        querySelector: selector => selector === '[data-account-status]' ? null : frame,
    } };
    accountController.updateAccountLinks.call(controller);
    assert.equal(frame.src, configured + '?view=account');
    delete frame.src;
    Object.assign(controller.state, { activeTab: 'users', accountSettingsAccess: true });
    accountController.updateAdministrationFrame.call(controller);
    assert.equal(frame.src, configured + 'applications.html?view=administration&showSignOut=0');
    let profileUrl;
    const access = await fetchAccountAccess(async url => { profileUrl = url; return response(['admin.users.manage']); }, configured);
    assert.equal(profileUrl, configured + 'api/profile');
    assert.deepEqual(access, { users: true, settings: false });
});

test('missing, duplicate and unsafe account declarations fail without guessing a service address', () => {
    assert.throws(() => resolveAccountDashboardUrl({}), /missing or ambiguous/);
    const declaration = { key: 'userpersisto-settings', settingsUrl: dashboard };
    assert.throws(() => resolveAccountDashboardUrl({ agentSettings: [declaration, declaration] }), /missing or ambiguous/);
    for (const settingsUrl of [undefined, 'https://elsewhere.test/account/', '//elsewhere.test/account/', '/\\elsewhere.test/account/', '/account/index.html', '/account/#fragment', '/account/\n']) {
        assert.throws(() => resolveAccountDashboardUrl({ agentSettings: [{ ...declaration, settingsUrl }] }));
    }
    assert.throws(() => buildAccountPageUrl(dashboard, '../outside'), /Unsupported account page/);
});

test('permission discovery ignores late replies after the Settings modal has closed', async (t) => {
    const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
    globalThis.window = { assistOS: { rawRuntimePlugins: { agentSettings: [{ key: 'userpersisto-settings', settingsUrl: dashboard }] } } };
    t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
    let resolve;
    const started = new Promise(done => { globalThis.fetch = () => new Promise(finish => { resolve = finish; done(); }); });
    const controller = { state: { usersAccess: false }, updateTabUI() { assert.fail('Closed Settings must not update'); } };
    const pending = usersController.refreshUsersAccess.call(controller);
    await started;
    controller.hardwareClosed = true;
    resolve(response(['admin.users.manage']));
    await pending;
    assert.equal(controller.state.usersAccess, false);
});

test('account discovery uses the existing tool catalog when Explorer has not loaded it yet', async (t) => {
    const originalWindow = globalThis.window;
    const calls = [];
    globalThis.window = { webSkel: { appServices: { async callTool(agent, tool, args) {
        calls.push({ agent, tool, args });
        return { content: [{ type: 'text', text: JSON.stringify({ agentSettings: [{ key: 'userpersisto-settings', settingsUrl: dashboard }] }) }] };
    } } } };
    t.after(() => { globalThis.window = originalWindow; });
    assert.equal(await loadAccountDashboardUrl(), dashboard);
    assert.deepEqual(calls, [{ agent: 'explorer', tool: 'collect_ide_plugins', args: {} }]);
});

test('missing account metadata shows an error and does not contact a guessed profile endpoint', async (t) => {
    const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
    globalThis.window = { assistOS: { rawRuntimePlugins: { agentSettings: [] } } };
    globalThis.fetch = async () => assert.fail('No profile address is known');
    t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
    const status = {}, controller = { state: { activeTab: 'account' }, element: {
        querySelectorAll: () => [],
        querySelector: selector => selector === '[data-account-status]' ? status : null,
    }, updateTabUI() { accountController.updateAccountLinks.call(this); } };
    await usersController.refreshUsersAccess.call(controller);
    assert.equal(controller.state.usersAccess, false);
    assert.equal(controller.state.accountSettingsAccess, false);
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /account integration is unavailable/);
});

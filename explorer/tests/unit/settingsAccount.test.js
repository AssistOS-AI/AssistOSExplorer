import test from 'node:test';
import assert from 'node:assert/strict';
import { accountController } from '../../web-components/modals/settings-modal/settings-account-controller.js';
import { runtimeSettingsController } from '../../web-components/modals/settings-modal/settings-runtime-controller.js';

function fixture(t, plugins = [{ agent: 'userPersistoAgent', id: 'userpersisto-settings', component: 'userpersisto-settings', settings: 'userpersisto-settings' }]) {
    const saved = { window: globalThis.window, document: globalThis.document, customElements: globalThis.customElements };
    const status = {}, retry = {}, mount = { replaceChildren(panel) { this.panel = panel; } };
    const attributes = {};
    const panel = { setAttribute(key, value) { attributes[key] = value; }, remove() { this.removed = true; }, webSkelPresenter: { afterUnload() { panel.cleaned = true; } } };
    globalThis.window = { assistOS: { rawRuntimePlugins: { application: { hidden: plugins } } } };
    globalThis.customElements = { get: () => true };
    globalThis.document = { createElement: () => panel };
    t.after(() => Object.assign(globalThis, saved));
    const controller = Object.assign({ state: { activeTab: 'account' }, accountSection: { querySelector: (selector) => ({ '[data-account-status]': status, '[data-account-retry]': retry, '[data-account-mount]': mount })[selector] } }, accountController);
    return { controller, panel, status, retry, mount, attributes };
}

test('My Account mounts for an ordinary user and disposes secrets on departure', async (t) => {
    const { controller, panel, status } = fixture(t);
    await controller.loadAccountPanel();
    assert.equal(controller.accountPanel, panel);
    assert.equal(status.textContent, '');
    controller.unloadAccountPanel();
    assert.equal(panel.cleaned, true);
    assert.equal(panel.removed, true);
    assert.equal(controller.accountPanel, null);
});

test('leaving My Account while loading prevents a stale panel from mounting', async (t) => {
    const { controller, mount } = fixture(t);
    const pending = controller.loadAccountPanel();
    controller.state.activeTab = 'theme';
    controller.unloadAccountPanel();
    await pending;
    assert.equal(mount.panel, undefined);
    assert.equal(controller.accountLoading, false);
});

test('missing account provider gives a retryable error', async (t) => {
    const { controller, status, retry } = fixture(t, []);
    await controller.loadAccountPanel();
    assert.match(status.textContent, /unavailable/);
    assert.equal(retry.hidden, false);
    assert.equal(controller.accountLoading, false);
});

test('former UserPersisto settings entry opens My Account without a standalone modal', async () => {
    const calls = [];
    await runtimeSettingsController.openAgentSettings.call({ switchTab: (...args) => calls.push(args) }, null, 'userpersisto-settings');
    assert.deepEqual(calls, [[null, 'account']]);
});


test('Applications mounts only after administrator access and tab selection, then clears on departure', async (t) => {
    const { controller, panel, attributes } = fixture(t);
    controller.applicationsSection = controller.accountSection;
    controller.state.activeTab = 'users';
    await controller.loadAccountPanel();
    assert.equal(controller.accountPanel, undefined);
    controller.state.usersAccess = true;
    await controller.loadAccountPanel();
    assert.equal(controller.accountPanel, undefined);
    controller.state.activeAdministrationTab = 'applications';
    await controller.loadAccountPanel();
    assert.equal(controller.accountPanel, panel);
    assert.equal(controller.accountScope, 'administration');
    assert.equal(attributes['data-initial-panel'], 'applications');
    controller.state.activeAdministrationTab = 'users';
    assert.equal(controller.getAccountScope(), null);
    controller.unloadAccountPanel();
    assert.equal(panel.cleaned, true);
});

test('switching away while Applications loads never mounts a stale panel', async (t) => {
    const { controller, mount } = fixture(t);
    controller.applicationsSection = controller.accountSection;
    Object.assign(controller.state, { activeTab: 'users', usersAccess: true, activeAdministrationTab: 'applications' });
    const pending = controller.loadAccountPanel();
    controller.state.activeAdministrationTab = 'users';
    controller.unloadAccountPanel();
    await pending;
    assert.equal(mount.panel, undefined);
    assert.equal(controller.accountLoading, false);
});

test('Administration rejects unknown tabs and unauthorized selection', async (t) => {
    const { controller } = fixture(t);
    let updates = 0;
    controller.updateTabUI = () => { updates++; };
    controller.switchAdministrationTab(null, 'applications');
    assert.equal(updates, 0);
    controller.state.usersAccess = true;
    for (const tab of ['policy', '', null, 'auth', 'provider']) controller.switchAdministrationTab(null, tab);
    assert.equal(updates, 0);
    controller.switchAdministrationTab(null, 'applications');
    assert.equal(controller.state.activeAdministrationTab, 'applications');
    assert.equal(updates, 1);
});

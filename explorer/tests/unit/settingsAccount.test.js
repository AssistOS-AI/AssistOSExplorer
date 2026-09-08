import test from 'node:test';
import assert from 'node:assert/strict';
import { accountController } from '../../web-components/modals/settings-modal/settings-account-controller.js';
import { runtimeSettingsController } from '../../web-components/modals/settings-modal/settings-runtime-controller.js';

function fixture(t, plugins = [{ agent: 'userPersistoAgent', id: 'userpersisto-settings', component: 'userpersisto-settings', settings: 'userpersisto-settings' }]) {
    const saved = { window: globalThis.window, document: globalThis.document, customElements: globalThis.customElements };
    const status = {}, retry = {}, mount = { replaceChildren(panel) { this.panel = panel; } };
    const panel = { setAttribute() {}, remove() { this.removed = true; }, webSkelPresenter: { afterUnload() { panel.cleaned = true; } } };
    globalThis.window = { assistOS: { rawRuntimePlugins: { application: { hidden: plugins } } } };
    globalThis.customElements = { get: () => true };
    globalThis.document = { createElement: () => panel };
    t.after(() => Object.assign(globalThis, saved));
    const controller = Object.assign({ state: { activeTab: 'account' }, accountSection: { querySelector: (selector) => ({ '[data-account-status]': status, '[data-account-retry]': retry, '[data-account-mount]': mount })[selector] } }, accountController);
    return { controller, panel, status, retry, mount };
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


test('Administration mounts account controls only after administrator access is verified', async (t) => {
    const { controller, panel } = fixture(t);
    controller.usersSection = controller.accountSection;
    controller.state.activeTab = 'users';
    await controller.loadAccountPanel();
    assert.equal(controller.accountPanel, undefined);
    controller.state.usersAccess = true;
    await controller.loadAccountPanel();
    assert.equal(controller.accountPanel, panel);
    assert.equal(controller.accountScope, 'administration');
});

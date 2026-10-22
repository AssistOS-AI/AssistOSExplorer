import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarController, defaultAvatarConfig } from '../../web-components/modals/settings-modal/settings-avatar-controller.js';
import { AvatarSettingsForm } from '../../shared/ui/avatar-settings-form/avatar-settings-form.js';

test('saving reads profile selections before disabling and rebuilding the form', async (t) => {
    const originals = ['window', 'assistOS', 'CustomEvent', 'BroadcastChannel'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    t.after(() => originals.forEach(([name, descriptor]) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    }));
    const stored = new Map();
    globalThis.assistOS = { user: { id: 'save-test', username: 'Tester' } };
    globalThis.window = {
        assistOS: globalThis.assistOS,
        dispatchEvent() {},
        localStorage: { setItem: (key, value) => stored.set(key, value) }
    };
    globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
    globalThis.BroadcastChannel = undefined;
    const draft = { ...defaultAvatarConfig('profile:save-test'), style: 'sketch', shape: 'rounded', palette: 'warm', size: '96' };
    let rendered = false;
    const context = {
        state: { profileAvatar: defaultAvatarConfig('profile:save-test'), profileAvatarEnabled: true },
        readAvatarControls() {
            assert.equal(rendered, false, 'Controls must be read before their replacement selects mount.');
            return draft;
        },
        renderAvatarSettings() { rendered = true; }
    };
    await avatarController.saveProfileAvatar.call(context);
    assert.equal(context.state.avatarStatus, 'Profile avatar saved in this browser.');
    const saved = JSON.parse(stored.get('assistOS.profileAvatar.settings'));
    for (const key of ['style', 'shape', 'palette', 'size']) {
        assert.equal(saved.config[key], draft[key]);
        assert.equal(context.state.profileAvatar[key], draft[key]);
    }
    assert.equal(context.state.avatarBusy, false);
});

test('saving agent selections captures the draft before rerendering', async (t) => {
    const originalWindow = globalThis.window;
    const originalEvent = globalThis.CustomEvent;
    t.after(() => { globalThis.window = originalWindow; globalThis.CustomEvent = originalEvent; });
    globalThis.window = { dispatchEvent() {} };
    globalThis.CustomEvent = class {};
    const draft = { ...defaultAvatarConfig('agent:test'), style: 'terminal', shape: 'square' };
    let rendered = false;
    let saved;
    const context = {
        state: { selectedAvatarAgentId: 'agent:test', selectedAgentAvatarEnabled: true },
        readAvatarControls() { assert.equal(rendered, false); return draft; },
        renderAvatarSettings() { rendered = true; },
        async callAvatarSettingsTool(name, payload) { if (name === 'update_avatar_settings_agent') saved = payload; },
        async loadAvatarSettingsData() {}
    };
    await avatarController.saveAgentAvatar.call(context);
    assert.equal(saved.config.style, 'terminal');
    assert.equal(saved.config.shape, 'square');
    assert.equal(context.state.avatarBusy, false);
});

test('form reads keep the draft values while replacement custom selects are not ready', () => {
    const unready = ['style', 'shape', 'palette'].map((key) => ({
        dataset: { avatarField: key }, matches: (selector) => selector === 'custom-select'
    }));
    const form = new AvatarSettingsForm({ querySelector: () => null, querySelectorAll: () => unready }, () => {});
    form.state.value = { ...defaultAvatarConfig('profile:test'), style: 'sketch', shape: 'rounded', palette: 'warm' };
    const config = form.getConfig();
    assert.equal(config.style, 'sketch');
    assert.equal(config.shape, 'rounded');
    assert.equal(config.palette, 'warm');
});

test('profile and agent form changes update their draft without rebuilding controls', () => {
    const context = {
        ...avatarController,
        state: {
            profileAvatar: defaultAvatarConfig('profile:test'),
            selectedAgentAvatar: defaultAvatarConfig('agent:test')
        },
        renderAvatarControls() { assert.fail('Editing must preserve the active form controls.'); }
    };
    context.handleAvatarControlsInput('profile', { detail: { config: { shape: 'rounded', size: '96' } } });
    context.handleAvatarControlsInput('agent', { detail: { config: { emotion: 'happy' } } });
    assert.equal(context.state.profileAvatar.shape, 'rounded');
    assert.equal(context.state.profileAvatar.size, '96');
    assert.equal(context.state.selectedAgentAvatar.emotion, 'happy');
    assert.equal(context.state.profileAvatar.agentId, 'profile:test');
    assert.equal(context.state.selectedAgentAvatar.agentId, 'agent:test');
});

test('profile enabled toggle updates only the preview and preserves the draft', () => {
    const preview = { innerHTML: '' };
    const form = new AvatarSettingsForm({}, () => {});
    const draft = defaultAvatarConfig('profile:test');
    draft.shape = 'rounded';
    form.state.value = draft;
    form.root = { querySelector(selector) {
        assert.equal(selector, '.avatar-settings-preview');
        return preview;
    } };
    form.renderForm = () => assert.fail('Preview changes must not rebuild form inputs.');
    const context = {
        state: { profileAvatarEnabled: false, avatarUser: { username: 'Alice' } },
        profileAvatarControlsEl: { webSkelPresenter: form }
    };
    avatarController.renderAvatarPreviews.call(context);
    assert.match(preview.innerHTML, />A<\/span>/);
    context.state.profileAvatarEnabled = true;
    avatarController.renderAvatarPreviews.call(context);
    assert.match(preview.innerHTML, /shape="rounded"/);
    assert.equal(form.state.value, draft);
    assert.equal(form.state.previewEnabled, true);
});

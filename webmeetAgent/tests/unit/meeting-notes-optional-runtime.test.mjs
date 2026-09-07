import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebmeetRoomSettingsModal } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-room-settings-modal/webmeet-room-settings-modal.js';

function settingsModal(previousEnabled = false, nextEnabled = true) {
    const modal = Object.create(WebmeetRoomSettingsModal.prototype);
    modal.titleInput = { value: 'Planning' };
    modal.roboTeamSettings = { meetingNotes: { enabled: previousEnabled } };
    modal.collectRoboTeamSettings = () => ({ meetingNotes: { enabled: nextEnabled } });
    modal.validateRoboTeamSettings = () => true;
    modal.updateTabVisibility = () => {};
    modal.updateRoboTeamTabVisibility = () => {};
    modal.showError = (message) => { modal.error = message; };
    return modal;
}

test('disabled secretary preserves settings until Marketplace enables it', async (t) => {
    let active = false;
    let saves = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/marketplace');
        assert.equal(options.credentials, 'include');
        return { ok: true, json: async () => ({ marketplace: { agents: [
            { ref: 'AchillesIDE/webmeetScribeAgent', active },
        ] } }) };
    });
    const previousAssistOS = globalThis.assistOS;
    globalThis.assistOS = { UI: { closeModal: () => { saves += 1; } } };
    t.after(() => { globalThis.assistOS = previousAssistOS; });
    const modal = settingsModal();
    await modal.saveSettings();
    assert.equal(saves, 0);
    assert.match(modal.error, /Enable webmeetScribeAgent in Marketplace/);
    assert.equal(modal.activeTab, 'roboteam');
    assert.equal(modal.activeRoboTeamTab, 'meetingNotes');
    active = true;
    await modal.saveSettings();
    assert.equal(saves, 1);
});

test('unknown Marketplace state and unrelated agent identities do not claim secretary is disabled', async (t) => {
    const modal = settingsModal();
    const results = [
        { ok: false },
        { ok: true, json: async () => ({ marketplace: { agents: [{ ref: 'Other/webmeetScribeAgent', active: false }] } }) },
        { ok: true, json: async () => ({ marketplace: { agents: [] } }) },
        { ok: true, json: async () => { throw new Error('unavailable'); } },
    ];
    for (const response of results) {
        const mock = t.mock.method(globalThis, 'fetch', async () => response);
        assert.equal(await modal.isSecretaryDisabled(), false);
        mock.mock.restore();
    }
});

test('disabling notes and saving already-enabled notes do not require Marketplace', async (t) => {
    let saves = 0;
    const previousAssistOS = globalThis.assistOS;
    globalThis.assistOS = { UI: { closeModal: () => { saves += 1; } } };
    t.after(() => { globalThis.assistOS = previousAssistOS; });
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('unexpected Marketplace request'); });
    await settingsModal(true, false).saveSettings();
    await settingsModal(true, true).saveSettings();
    assert.equal(saves, 2);
});

test('parallel save clicks submit once and clear the pending flag', async (t) => {
    let release;
    let saves = 0;
    const previousAssistOS = globalThis.assistOS;
    globalThis.assistOS = { UI: { closeModal: () => { saves += 1; } } };
    t.after(() => { globalThis.assistOS = previousAssistOS; });
    const modal = settingsModal();
    modal.isSecretaryDisabled = () => new Promise((resolve) => { release = resolve; });
    const firstSave = modal.saveSettings();
    await modal.saveSettings();
    release(false);
    await firstSave;
    await modal.saveSettings();
    assert.equal(saves, 1);
    assert.equal(modal.savePending, false);
});

test('closing the modal during an availability check cancels its pending save', async (t) => {
    let release;
    const results = [];
    const previousAssistOS = globalThis.assistOS;
    globalThis.assistOS = { UI: { closeModal: (element, result) => { results.push(result); } } };
    t.after(() => { globalThis.assistOS = previousAssistOS; });
    const modal = settingsModal();
    modal.isSecretaryDisabled = () => new Promise((resolve) => { release = resolve; });
    const save = modal.saveSettings();
    modal.closeModal();
    release(false);
    await save;
    assert.deepEqual(results, [null]);
    assert.equal(modal.savePending, false);
});

test('removing the modal while availability is pending does not submit settings', async (t) => {
    let release;
    const previousAssistOS = globalThis.assistOS;
    globalThis.assistOS = { UI: { closeModal: () => { assert.fail('closed modal submitted'); } } };
    t.after(() => { globalThis.assistOS = previousAssistOS; });
    const modal = settingsModal();
    modal.element = { isConnected: true };
    modal.isSecretaryDisabled = () => new Promise((resolve) => { release = resolve; });
    const save = modal.saveSettings();
    modal.element.isConnected = false;
    release(false);
    await save;
    assert.equal(modal.savePending, false);
});

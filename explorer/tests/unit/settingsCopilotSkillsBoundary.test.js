import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { SettingsModal } from '../../web-components/modals/settings-modal/settings-modal.js';

test('Settings has no Copilot tab or skill management controller', async () => {
    const modal = new SettingsModal({}, () => {}, { tab: 'copilot' });
    assert.equal(modal.state.activeTab, 'agents');
    assert.deepEqual(modal.getAllowedTabs(), ['account', 'agents', 'plugins', 'keymap', 'editor', 'theme', 'avatar']);
    assert.equal(modal.loadCopilotSettingsData, undefined);
    assert.equal(modal.toggleCopilotSkill, undefined);
    const base = new URL('../../web-components/modals/settings-modal/', import.meta.url);
    for (const file of ['settings-modal.js', 'settings-modal.html']) {
        const source = await fs.readFile(new URL(file, base), 'utf8');
        assert.doesNotMatch(source, /copilot|list_achilles_skills|set_achilles_skill_enabled/i);
    }
});

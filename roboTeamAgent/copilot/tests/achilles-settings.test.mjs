import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    clearSelectedModel, getCurrentSessionId, getDisabledSkills, getPermissionMode,
    getSelectedModel, setPermissionMode, setCurrentSessionId, setDisabledSkills,
    setSelectedModel, getAchillesSettingsPath,
} from '../src/lib/config/achillesSettings.mjs';

function workspace(t) {
    const dir = fs.mkdtempSync(join(tmpdir(), 'achilles-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('independent setting changes preserve each other and remain workspace scoped', async (t) => {
    const dir = workspace(t);
    const other = workspace(t);
    await setSelectedModel(dir, 'legacy/model');
    await Promise.all([
        setPermissionMode(dir, 'full-access'),
        setCurrentSessionId(dir, 'conversation-a'),
        setDisabledSkills(dir, ['beta', 'alpha', 'beta']),
    ]);
    assert.equal(getPermissionMode(dir), 'full-access');
    assert.equal(getCurrentSessionId(dir), 'conversation-a');
    assert.deepEqual(getDisabledSkills(dir), ['alpha', 'beta']);
    assert.equal(getSelectedModel(dir), 'legacy/model');
    assert.equal(getPermissionMode(other), 'full-access');
    await clearSelectedModel(dir);
    await setDisabledSkills(dir, []);
    assert.equal(getSelectedModel(dir), null);
    assert.deepEqual(getDisabledSkills(dir), []);
    assert.equal(getPermissionMode(dir), 'full-access');
    assert.equal(getCurrentSessionId(dir), 'conversation-a');
});

test('coding-agent models are not folder settings; invalid permission modes leave settings unchanged', async (t) => {
    const dir = workspace(t);
    await setSelectedModel(dir, 'legacy/soul-model');
    const settings = await import('../src/lib/config/achillesSettings.mjs');
    assert.equal(settings.getCodingAgentModels, undefined);
    assert.equal(settings.setCodingAgentModel, undefined);
    const before = fs.readFileSync(getAchillesSettingsPath(dir), 'utf8');
    await assert.rejects(setPermissionMode(dir, 'unrestricted'), /ask-for-approval/);
    assert.equal(fs.readFileSync(getAchillesSettingsPath(dir), 'utf8'), before);
    assert.equal(getSelectedModel(dir), 'legacy/soul-model');
});

test('malformed settings reads do not destroy persisted evidence', (t) => {
    const dir = workspace(t);
    const file = getAchillesSettingsPath(dir);
    fs.mkdirSync(join(dir, '.roboteam'), { recursive: true });
    fs.writeFileSync(file, '{invalid');
    assert.equal(getSelectedModel(dir), null);
    assert.equal(getPermissionMode(dir), 'full-access');
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});

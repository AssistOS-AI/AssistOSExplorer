import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    clearSelectedModel, getCurrentSessionId, getDisabledSkills, getPermissionMode,
    getSelectedModel, setPermissionMode, setCurrentSessionId, setDisabledSkills,
    setSelectedModel, getCodingAgentModels, setCodingAgentModel, getAchillesSettingsPath,
} from '../src/lib/achillesSettings.mjs';

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
    assert.equal(getPermissionMode(other), 'ask-for-approval');
    await clearSelectedModel(dir);
    await setDisabledSkills(dir, []);
    assert.equal(getSelectedModel(dir), null);
    assert.deepEqual(getDisabledSkills(dir), []);
    assert.equal(getPermissionMode(dir), 'full-access');
    assert.equal(getCurrentSessionId(dir), 'conversation-a');
});

test('native backend model selections never reinterpret or destroy a legacy model', async (t) => {
    const dir = workspace(t);
    await setSelectedModel(dir, 'legacy/soul-model');
    assert.deepEqual(getCodingAgentModels(dir), {});
    await Promise.all([
        setCodingAgentModel(dir, 'codex', 'native-codex'),
        setCodingAgentModel(dir, 'opencode', 'provider/native'),
        setCodingAgentModel(dir, 'pi', 'native-pi'),
    ]);
    assert.deepEqual(getCodingAgentModels(dir), {
        codex: 'native-codex', opencode: 'provider/native', pi: 'native-pi',
    });
    await setCodingAgentModel(dir, 'codex', null);
    assert.deepEqual(getCodingAgentModels(dir), { opencode: 'provider/native', pi: 'native-pi' });
    assert.equal(getSelectedModel(dir), 'legacy/soul-model');
    const before = fs.readFileSync(getAchillesSettingsPath(dir), 'utf8');
    await assert.rejects(setCodingAgentModel(dir, '__proto__', 'bad'), /supported coding backend/);
    await assert.rejects(setCodingAgentModel(dir, 'pi', ''), /model name/);
    await assert.rejects(setPermissionMode(dir, 'unrestricted'), /ask-for-approval/);
    assert.equal(fs.readFileSync(getAchillesSettingsPath(dir), 'utf8'), before);
});

test('malformed settings reads do not destroy persisted evidence', (t) => {
    const dir = workspace(t);
    const file = getAchillesSettingsPath(dir);
    fs.mkdirSync(join(dir, '.data', 'achilles-cli'), { recursive: true });
    fs.writeFileSync(file, '{invalid');
    assert.equal(getSelectedModel(dir), null);
    assert.equal(getPermissionMode(dir), 'ask-for-approval');
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});

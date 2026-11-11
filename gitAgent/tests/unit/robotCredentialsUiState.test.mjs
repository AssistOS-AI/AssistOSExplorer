import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
    NO_ROBOT,
    normalizeRobotTargets,
    pickRobotSelection,
    buildRobotOptions,
    describeRobotSelection,
    planAutomaticRobotSave,
    describeRobotSaveResult,
    describeRobotRemoveResult,
    formatSavedAt
} from '../../IDE-plugins/git-tool-button/components/git-robot-credentials/robot-credentials-state.js';

const componentDir = new URL('../../IDE-plugins/git-tool-button/components/git-robot-credentials/', import.meta.url);

function targets({ canAdmin = false, userId = 'alice', builder = { configured: false } } = {}) {
    return normalizeRobotTargets({
        ok: true,
        canAdmin,
        userId,
        robots: [
            { id: 'r2', name: 'builder', isDefault: false, credentials: builder },
            { id: 'r1', name: 'default', isDefault: true, credentials: { configured: false } }
        ]
    });
}

const bobCredentials = {
    configured: true, readable: true, githubLogin: 'bob-gh', savedBy: { id: 'bob', username: 'bob' }, savedAt: '2026-11-01T10:00:00.000Z'
};
const aliceCredentials = {
    configured: true, readable: true, githubLogin: 'alice-gh', savedBy: { id: 'alice', username: 'alice' }, savedAt: '2026-11-02T08:30:00.000Z'
};

test('the default robot is preselected and "Don\'t save to a robot" is always offered', () => {
    const list = targets();
    assert.equal(pickRobotSelection(list.robots, ''), 'default');
    assert.equal(pickRobotSelection(list.robots, 'builder'), 'builder');
    assert.equal(pickRobotSelection(list.robots, NO_ROBOT), NO_ROBOT);
    assert.equal(pickRobotSelection(list.robots, 'deleted-robot'), 'default');
    assert.equal(pickRobotSelection([], ''), NO_ROBOT);
    const options = buildRobotOptions(list.robots);
    assert.deepEqual(options.at(-1), { value: NO_ROBOT, name: "Don't save to a robot" });
    assert.deepEqual(options.map((option) => option.value), ['builder', 'default', NO_ROBOT]);
    assert.equal(options[1].name, 'default (default)');
});

test('RoboTeam unavailable hides the selector behind a note', () => {
    const unavailable = normalizeRobotTargets({ ok: false, code: 'ROBOTEAM_UNAVAILABLE', message: 'x' });
    assert.equal(unavailable.available, false);
    assert.match(unavailable.note, /RoboTeam is not available/);
    assert.match(unavailable.note, /sign-in still works/);
    assert.equal(normalizeRobotTargets(null).available, false);
    const description = describeRobotSelection({ targets: unavailable, selection: 'default', connected: true });
    assert.equal(description.canSave, false);
    assert.equal(description.canRemove, false);
    assert.deepEqual(planAutomaticRobotSave({ targets: unavailable, selection: 'default' }), { save: false, message: '' });
});

test('credentials of another user show login, saver and date; non-admins cannot overwrite', () => {
    const description = describeRobotSelection({ targets: targets({ builder: bobCredentials }), selection: 'builder', connected: true });
    assert.match(description.warning, /bob-gh/);
    assert.match(description.warning, /saved by bob/);
    assert.match(description.warning, /2026-11-01 10:00 UTC/);
    assert.equal(description.adminNote, 'Only an administrator can overwrite credentials saved by another user.');
    assert.equal(description.blocked, true);
    assert.equal(description.canSave, false);
    assert.equal(description.canRemove, false);
    const plan = planAutomaticRobotSave({ targets: targets({ builder: bobCredentials }), selection: 'builder' });
    assert.equal(plan.save, false);
    assert.match(plan.message, /Not saved to robot builder/);
});

test('administrators see the overwrite warning and may overwrite or remove', () => {
    const description = describeRobotSelection({ targets: targets({ canAdmin: true, builder: bobCredentials }), selection: 'builder', connected: true });
    assert.match(description.warning, /bob-gh/);
    assert.match(description.adminNote, /overwrite them because you are an administrator/);
    assert.equal(description.saveLabel, 'Overwrite robot credentials');
    assert.equal(description.canSave, true);
    assert.equal(description.canRemove, true);
    assert.deepEqual(planAutomaticRobotSave({ targets: targets({ canAdmin: true, builder: bobCredentials }), selection: 'builder' }), {
        save: true, robotName: 'builder', message: ''
    });
});

test('the saver may re-save and remove their own credentials without a warning', () => {
    const description = describeRobotSelection({ targets: targets({ builder: aliceCredentials }), selection: 'builder', connected: true });
    assert.equal(description.warning, '');
    assert.match(description.notice, /You saved the GitHub credentials of alice-gh/);
    assert.equal(description.canSave, true);
    assert.equal(description.canRemove, true);
    assert.equal(description.saveLabel, 'Save to robot');
});

test('Save to robot needs a stored GitHub credential; "Don\'t save" disables every robot action', () => {
    assert.equal(describeRobotSelection({ targets: targets(), selection: 'default', connected: false }).canSave, false);
    assert.equal(describeRobotSelection({ targets: targets(), selection: 'default', connected: true }).canSave, true);
    const none = describeRobotSelection({ targets: targets(), selection: NO_ROBOT, connected: true });
    assert.equal(none.robot, null);
    assert.equal(none.canSave, false);
    assert.equal(none.canRemove, false);
    assert.deepEqual(planAutomaticRobotSave({ targets: targets(), selection: NO_ROBOT }), { save: false, message: '' });
    assert.deepEqual(planAutomaticRobotSave({ targets: targets(), selection: 'default' }), { save: true, robotName: 'default', message: '' });
});

test('save and remove results become user-facing messages', () => {
    const saved = describeRobotSaveResult({ ok: true, robot: { name: 'default' }, metadata: { githubLogin: 'alice-gh' } }, 'default');
    assert.equal(saved.tone, 'success');
    assert.match(saved.text, /alice-gh saved to robot default/);
    assert.match(saved.text, /ploinky update/);
    const occupied = describeRobotSaveResult({ ok: false, code: 'ROBOT_CREDENTIALS_OCCUPIED', message: 'Robot builder already holds git credentials for GitHub user bob-gh.' }, 'builder');
    assert.equal(occupied.tone, 'warning');
    assert.match(occupied.text, /bob-gh/);
    assert.match(describeRobotSaveResult({ ok: false, code: 'ROBOTEAM_UNAVAILABLE' }, 'default').text, /RoboTeam is not available/);
    assert.equal(describeRobotRemoveResult({ ok: true, deleted: true }, 'builder').text, 'Git credentials removed from robot builder.');
    assert.equal(describeRobotRemoveResult({ ok: false, message: 'denied' }, 'builder').text, 'denied');
    assert.equal(formatSavedAt(''), 'an unknown date');
    assert.equal(formatSavedAt('not-a-date'), 'not-a-date');
});

test('the robot section follows the WebSkel action contract and states the required warnings', async () => {
    const html = await fs.readFile(new URL('git-robot-credentials.html', componentDir), 'utf8');
    const js = await fs.readFile(new URL('git-robot-credentials.js', componentDir), 'utf8');
    assert.match(html, /data-local-action="saveToRobot"/);
    assert.match(html, /data-local-action="removeFromRobot"/);
    assert.match(html, /data-presenter="custom-select"/);
    assert.match(html, /Anyone with access to a robot can use the git credentials saved in it\./);
    assert.match(html, /token limited to the repositories/);
    assert.match(html, /default robot are also used by <code>ploinky update<\/code>/);
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
    assert.doesNotMatch(js, /addEventListener\('click'/);
    assert.doesNotMatch(js, /\btoken\s*:/);
    const config = JSON.parse(await fs.readFile(new URL('../../IDE-plugins/git-tool-button/config.json', import.meta.url), 'utf8'));
    assert.ok(config.dependencies.some((entry) => entry.component === 'git-robot-credentials' && entry.presenter === 'GitRobotCredentials'));
    const promptHtml = await fs.readFile(new URL('../git-credentials-prompt/git-credentials-prompt.html', componentDir), 'utf8');
    assert.match(promptHtml, /<git-robot-credentials data-presenter="git-robot-credentials"><\/git-robot-credentials>/);
});

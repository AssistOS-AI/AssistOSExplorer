import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
    normalizeRobotTargets,
    showRobotAccess,
    describeRobotRow,
    planAutomaticRobotSave,
    describeRobotSaveResult,
    describeRobotRemoveResult,
    combineRobotResults,
    formatSavedAt
} from '../../IDE-plugins/git-tool-button/components/git-robot-credentials/robot-credentials-state.js';

const componentDir = new URL('../../IDE-plugins/git-tool-button/components/git-robot-credentials/', import.meta.url);

function targets({ canAdmin = true, userId = 'alice', builder = { configured: false } } = {}) {
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

test('the section is shown only to administrators', () => {
    assert.equal(showRobotAccess(targets()), true);
    assert.equal(showRobotAccess(targets({ canAdmin: false })), false);
    const refused = normalizeRobotTargets({ ok: false, code: 'ROBOT_CREDENTIALS_FORBIDDEN', message: 'Only administrators' });
    assert.equal(showRobotAccess(refused), false);
    assert.equal(showRobotAccess(normalizeRobotTargets({ ok: false, code: 'ROBOTEAM_UNAVAILABLE' })), false);
    assert.equal(showRobotAccess(normalizeRobotTargets(null)), false);
    assert.deepEqual(planAutomaticRobotSave({ targets: targets({ canAdmin: false }) }), { save: false, robotNames: [], message: '' });
    assert.deepEqual(planAutomaticRobotSave({ targets: refused }), { save: false, robotNames: [], message: '' });
});

test('every robot is listed with the default first; an administrator sign-in saves to the default robot', () => {
    const list = targets();
    assert.deepEqual(list.robots.map((robot) => robot.name), ['default', 'builder']);
    assert.equal(describeRobotRow(list.robots[0], list).label, 'default (default)');
    assert.equal(describeRobotRow(list.robots[0], list).isDefault, true);
    assert.equal(describeRobotRow(list.robots[1], list).status, 'No git credentials');
    assert.deepEqual(planAutomaticRobotSave({ targets: list }), { save: true, robotNames: ['default'], message: '' });
    assert.equal(planAutomaticRobotSave({ targets: normalizeRobotTargets({ ok: true, canAdmin: true, robots: [] }) }).save, false);
});

test('another user\'s credentials show login, saver and date and can be overwritten or removed', () => {
    const list = targets({ builder: bobCredentials });
    const row = describeRobotRow(list.robots[1], list, { connected: true });
    assert.match(row.status, /bob-gh/);
    assert.match(row.status, /saved by bob/);
    assert.match(row.status, /2026-11-01 10:00 UTC/);
    assert.equal(row.canSave, true);
    assert.equal(row.saveLabel, 'Overwrite credentials');
    assert.equal(row.canRemove, true);
});

test('sign-in never overwrites the default robot holding another user\'s credentials', () => {
    const list = normalizeRobotTargets({ ok: true, canAdmin: true, userId: 'alice', robots: [{ id: 'r1', name: 'default', credentials: bobCredentials }] });
    const plan = planAutomaticRobotSave({ targets: list });
    assert.equal(plan.save, false);
    assert.equal(plan.robotName, 'default');
    assert.match(plan.message, /Not saved to robot default: it holds the GitHub credentials of bob-gh, saved by bob/);
    assert.match(plan.message, /Use Overwrite credentials/);
});

test('the administrator\'s own credentials can be replaced and sign-in refreshes their default robot', () => {
    const list = targets({ builder: aliceCredentials });
    const row = describeRobotRow(list.robots[1], list, { connected: true });
    assert.match(row.status, /Your credentials \(GitHub alice-gh\)/);
    assert.equal(row.saveLabel, 'Replace credentials');
    assert.equal(row.canRemove, true);
    const own = normalizeRobotTargets({ ok: true, canAdmin: true, userId: 'alice', robots: [{ id: 'r1', name: 'default', credentials: aliceCredentials }] });
    assert.deepEqual(planAutomaticRobotSave({ targets: own }).robotNames, ['default']);
});

test('Add credentials needs a stored GitHub credential; Remove needs credentials on the robot', () => {
    const list = targets();
    const offline = describeRobotRow(list.robots[0], list, { connected: false });
    assert.equal(offline.canSave, false);
    assert.equal(offline.canRemove, false);
    const online = describeRobotRow(list.robots[0], list, { connected: true });
    assert.equal(online.canSave, true);
    assert.equal(online.saveLabel, 'Add credentials');
});

test('several robot outcomes combine into one message with the worst tone', () => {
    const combined = combineRobotResults([
        { tone: 'success', text: 'saved to default' },
        { tone: 'error', text: 'failed for builder' }
    ]);
    assert.equal(combined.tone, 'error');
    assert.equal(combined.text, 'saved to default\nfailed for builder');
    assert.equal(combineRobotResults([]), null);
});

test('save and remove results become user-facing messages', () => {
    const saved = describeRobotSaveResult({ ok: true, robot: { name: 'default' }, metadata: { githubLogin: 'alice-gh' } }, 'default');
    assert.equal(saved.tone, 'success');
    assert.match(saved.text, /alice-gh saved to robot default/);
    assert.match(saved.text, /ploinky update/);
    const forbidden = describeRobotSaveResult({ ok: false, code: 'ROBOT_CREDENTIALS_FORBIDDEN', message: 'Only administrators can configure the git credentials of robots.' }, 'builder');
    assert.equal(forbidden.tone, 'error');
    assert.match(forbidden.text, /Only administrators/);
    assert.match(describeRobotSaveResult({ ok: false, code: 'ROBOTEAM_UNAVAILABLE' }, 'default').text, /RoboTeam is not available/);
    assert.equal(describeRobotRemoveResult({ ok: true, deleted: true }, 'builder').text, 'Git credentials removed from robot builder.');
    assert.equal(describeRobotRemoveResult({ ok: false, message: 'denied' }, 'builder').text, 'denied');
    assert.equal(formatSavedAt(''), 'an unknown date');
    assert.equal(formatSavedAt('not-a-date'), 'not-a-date');
});

test('the robot section follows the WebSkel action contract and states the required warnings', async () => {
    const html = await fs.readFile(new URL('git-robot-credentials.html', componentDir), 'utf8');
    const js = await fs.readFile(new URL('git-robot-credentials.js', componentDir), 'utf8');
    assert.match(html, /data-role="list"/);
    assert.match(js, /'saveToRobot'/);
    assert.match(js, /'removeFromRobot'/);
    assert.match(js, /dataset\.localAction = action/);
    assert.match(js, /git-robot-credentials-link/);
    assert.doesNotMatch(html, /custom-select|class="secondary"|<button|checkbox/);
    assert.doesNotMatch(js, /checkbox/);
    assert.match(html, /Anyone with access to a robot can use the git credentials saved in it\./);
    assert.match(html, /token limited to the repositories/);
    assert.match(html, /default robot are also used by <code>ploinky update<\/code>/);
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
    assert.doesNotMatch(js, /addEventListener\('click'/);
    assert.doesNotMatch(js, /\btoken\s*:/);
    const config = JSON.parse(await fs.readFile(new URL('../../IDE-plugins/git-tool-button/config.json', import.meta.url), 'utf8'));
    assert.ok(config.dependencies.some((entry) => entry.component === 'git-robot-credentials' && entry.presenter === 'GitRobotCredentials'));
    const promptHtml = await fs.readFile(new URL('../git-credentials-prompt/git-credentials-prompt.html', componentDir), 'utf8');
    assert.match(promptHtml, /<git-robot-credentials data-presenter="git-robot-credentials" hidden><\/git-robot-credentials>/);
});

test('every robot section rule still matches after Explorer scopes the stylesheet', async () => {
    // Explorer prefixes each selector with the component tag; a comment before a selector breaks that prefix.
    const { scopeCssToComponent } = await import('../../../explorer/utils/pluginUtils.core.js');
    const css = await fs.readFile(new URL('git-robot-credentials.css', componentDir), 'utf8');
    const scoped = scopeCssToComponent(css, 'git-robot-credentials');
    const selectors = [...scoped.matchAll(/(?:^|})\s*([^{}@][^{}]*)\{/g)].flatMap((match) => match[1].split(',').map((part) => part.trim()));
    assert.ok(selectors.some((selector) => selector.includes('.git-robot-credentials-list')));
    for (const selector of selectors) {
        assert.doesNotMatch(selector, /\/\*|git-robot-credentials\s+git-robot-credentials/, selector);
    }
});

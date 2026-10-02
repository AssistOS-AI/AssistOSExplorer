import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_BASE_PATH } from '../../server/constants.mjs';
import { createConversationSettingsAction, createCurrentSessionEnvelope, createSelectedSessionEnvelope } from '../src/lib/webchat/webchatSessionState.mjs';

const ROBOT_ID = 'default-abc123';
const session = { sessionId: 'caa7d510-d4a7-4e82-bb74-4c1b2e1c74fd', workingDir: '/private/saved-cwd', messages: [] };

test('RoboTeam publishes its own Conversation skills page for the saved conversation and resolved robot id', () => {
    for (const create of [createCurrentSessionEnvelope, createSelectedSessionEnvelope]) {
        const payload = create(session, { robotId: ROBOT_ID });
        const url = new URL(payload.settingsAction.href, 'https://workspace.example');
        assert.equal(payload.settingsAction.label, 'Conversation skills');
        assert.equal(payload.settingsAction.href, `${PUBLIC_BASE_PATH}conversation-skills/${ROBOT_ID}/${session.sessionId}`);
        assert.equal(url.origin, 'https://workspace.example');
        assert.equal(url.pathname, `${PUBLIC_BASE_PATH}conversation-skills/${ROBOT_ID}/${session.sessionId}`);
        assert.equal(url.search, '');
        assert.equal(url.hash, '');
        assert.doesNotMatch(payload.settingsAction.href, /private|saved-cwd|explorer|copilot-robot|copilot-session/);
    }
});

test('the robot id defaults to the id RoboTeam resolved for this copilot process', () => {
    const previous = process.env.ROBOTEAM_COPILOT_ROBOT_ID;
    const previousName = process.env.ROBOTEAM_COPILOT_ROBOT_NAME;
    try {
        process.env.ROBOTEAM_COPILOT_ROBOT_ID = ROBOT_ID;
        process.env.ROBOTEAM_COPILOT_ROBOT_NAME = 'Research & Review';
        assert.equal(createCurrentSessionEnvelope(session).settingsAction.href, `${PUBLIC_BASE_PATH}conversation-skills/${ROBOT_ID}/${session.sessionId}`);
        delete process.env.ROBOTEAM_COPILOT_ROBOT_ID;
        assert.equal(createCurrentSessionEnvelope(session).settingsAction, undefined);
    } finally {
        if (previous === undefined) delete process.env.ROBOTEAM_COPILOT_ROBOT_ID; else process.env.ROBOTEAM_COPILOT_ROBOT_ID = previous;
        if (previousName === undefined) delete process.env.ROBOTEAM_COPILOT_ROBOT_NAME; else process.env.ROBOTEAM_COPILOT_ROBOT_NAME = previousName;
    }
});

test('missing or invalid robot/session context never advertises robot defaults as conversation settings', () => {
    for (const robotId of ['', ' ', '\nrobot', 'x'.repeat(65), 'ab', 'Default-abc123', '-abc123', 'abc/123', 'abc?x=1', 'abc#x', null, 5]) {
        assert.equal(createConversationSettingsAction(session, robotId), undefined, String(robotId));
    }
    for (const sessionId of ['../escape', '', undefined, `${session.sessionId}0`]) {
        assert.equal(createConversationSettingsAction({ ...session, sessionId }, ROBOT_ID), undefined, String(sessionId));
    }
    assert.equal(createConversationSettingsAction(undefined, ROBOT_ID), undefined);
});

test('boundary: robot ids of 2, 3, 64 and 65 characters', () => {
    const lengths = new Map([[2, undefined], [3, true], [64, true], [65, undefined]]);
    for (const [length, expected] of lengths) {
        const action = createConversationSettingsAction(session, 'a'.repeat(length));
        assert.equal(Boolean(action), Boolean(expected), `length ${length}`);
        if (expected) assert.equal(action.href, `${PUBLIC_BASE_PATH}conversation-skills/${'a'.repeat(length)}/${session.sessionId}`);
    }
});

test('a conversation bound to another robot never advertises a link that would fail', () => {
    const bound = (robotId) => ({ ...session, engine: { type: 'ala', robotId } });
    assert.ok(createConversationSettingsAction(bound(ROBOT_ID), ROBOT_ID));
    assert.equal(createConversationSettingsAction(bound('other-abc123'), ROBOT_ID), undefined);
    assert.equal(createCurrentSessionEnvelope(bound('other-abc123'), { robotId: ROBOT_ID }).settingsAction, undefined);
    assert.equal('settingsAction' in createSelectedSessionEnvelope(bound('other-abc123'), { robotId: ROBOT_ID }), false);
    assert.ok(createConversationSettingsAction({ ...session, engine: {} }, ROBOT_ID));
    assert.ok(createConversationSettingsAction({ ...session, engine: { robotId: null } }, ROBOT_ID));
});

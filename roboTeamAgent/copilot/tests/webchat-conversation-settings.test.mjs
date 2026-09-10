import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationSettingsAction, createCurrentSessionEnvelope, createSelectedSessionEnvelope } from '../src/lib/webchatSessionState.mjs';

const session = { sessionId: 'caa7d510-d4a7-4e82-bb74-4c1b2e1c74fd', workingDir: '/private/saved-cwd', messages: [] };

test('RoboTeam publishes the saved conversation and resolved robot in current and selected settings actions', () => {
    for (const create of [createCurrentSessionEnvelope, createSelectedSessionEnvelope]) {
        const payload = create(session, { robot: 'Research & Review' });
        const url = new URL(payload.settingsAction.href, 'https://workspace.example');
        assert.equal(payload.settingsAction.label, 'Conversation skills');
        assert.equal(url.pathname, '/explorer/index.html');
        assert.equal(url.searchParams.get('copilot-robot'), 'Research & Review');
        assert.equal(url.searchParams.get('copilot-session'), session.sessionId);
        assert.deepEqual([...url.searchParams.keys()].sort(), ['copilot-robot', 'copilot-session']);
        assert.equal(url.hash, '#file-exp/');
        assert.doesNotMatch(payload.settingsAction.href, /private|saved-cwd/);
    }
});

test('missing or invalid robot/session context never advertises robot defaults as conversation settings', () => {
    for (const robot of ['', ' ', '\nrobot', 'x'.repeat(81), null]) {
        assert.equal(createConversationSettingsAction(session, robot), undefined);
    }
    assert.equal(createConversationSettingsAction({ ...session, sessionId: '../escape' }, 'default'), undefined);
});

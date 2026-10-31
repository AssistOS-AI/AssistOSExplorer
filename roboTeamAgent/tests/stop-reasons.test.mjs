// The plain messages for the worker's own end reasons (stop-reasons.mjs), including the active-source rule (decision M-63, M-67 Q2), and the
// line matcher that keeps such a message as the task's error.
import assert from 'node:assert/strict';
import test from 'node:test';

import { STOP_MESSAGE_LINE, plainStopMessage } from '../server/worker-coordinator/stop-reasons.mjs';

const ACTIVE_SOURCE = {
    grant_inside_active_source: 'Not started: this folder holds source code that RoboTeam, the worker or Ploinky runs, so a robot cannot write to it. Pick another working folder, or add this one read-only.',
    grant_contains_active_source: 'Not started: this folder contains source code that RoboTeam, the worker or Ploinky runs. Pick a folder inside your project instead.',
    runtime_sources_unavailable: 'Not started: the worker could not confirm which folders hold running source code. Try again in a moment.',
    source_activated: 'Stopped: this folder now holds source code that RoboTeam, the worker or Ploinky runs, so the robot can no longer write to it. Pick another working folder, or add this one read-only.'
};

test('M-63: each active-source reason maps to its plain message, and STOP_MESSAGE_LINE matches each one on its own line', () => {
    for (const [reason, message] of Object.entries(ACTIVE_SOURCE)) {
        assert.equal(plainStopMessage(reason), message, reason);
        assert.equal(plainStopMessage(reason, { reason }), message, `${reason} with data`);
        const output = `ala: something earlier\n${message}\ntrailing line`;
        assert.equal(STOP_MESSAGE_LINE.exec(output)?.[0], message, reason);
    }
});

test('the existing worker stop messages are unchanged and still matched', () => {
    const existing = [
        [plainStopMessage('inactive_timeout', { minutes: 20 }), 'Stopped: no activity from the model for 20 minutes'],
        [plainStopMessage('deadline_exceeded'), 'Stopped: the task exceeded its maximum duration'],
        [plainStopMessage('model_unavailable'), 'Stopped: the selected Soul Gateway model is not available'],
        [plainStopMessage('model_channel_unavailable'), 'Stopped: Soul Gateway could not be reached for the model. Try again in a moment']
    ];
    for (const [actual, expected] of existing) {
        assert.equal(actual, expected);
        assert.equal(STOP_MESSAGE_LINE.exec(`x\n${actual}\ny`)?.[0], expected);
    }
});

test('other reasons have no plain message, and other "Not started:" or "Stopped:" lines are not taken as the task error', () => {
    for (const reason of ['grant_protected_component', 'grant_inside_protected_location', 'start_failed', 'source_activated_x', '', null]) {
        assert.equal(plainStopMessage(reason), null, String(reason));
    }
    for (const line of ['Not started: something else entirely', 'Not started: this folder holds source code', 'Stopped: by the user', `${ACTIVE_SOURCE.grant_inside_active_source} extra`]) {
        assert.equal(STOP_MESSAGE_LINE.exec(line), null, line);
    }
});

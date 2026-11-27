import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionAge } from '../../web-components/modals/coding-sessions-modal/session-age.js';

test('session ages follow CLI rounding and omit missing timestamps', () => {
    const now = 1800000000000;
    for (const [seconds, expected] of [[0, 'just now'], [60, '1 minute ago'], [120, '2 minutes ago'],
        [3600, '1 hour ago'], [7200, '2 hours ago'], [86400, '1 day ago'], [172800, '2 days ago'], [-10, 'just now']]) {
        assert.equal(sessionAge(now - seconds * 1000, now), expected);
    }
    for (const value of [undefined, null, NaN, 0, 'bad']) assert.equal(sessionAge(value, now), '');
});

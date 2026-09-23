import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    clearWebMeetResume,
    readWebMeetResume,
    writeWebMeetResume
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-session-store.js';

function withFakeStorage(run) {
    const previous = globalThis.sessionStorage;
    const map = new Map();
    globalThis.sessionStorage = {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key)
    };
    try {
        return run();
    } finally {
        if (previous === undefined) {
            delete globalThis.sessionStorage;
        } else {
            globalThis.sessionStorage = previous;
        }
    }
}

test('resume record tracks the open panel, active room, and media state', () => {
    withFakeStorage(() => {
        assert.equal(readWebMeetResume(), null);

        writeWebMeetResume({ open: true, roomId: 'room_11111111-1111-1111-1111-111111111111' });
        assert.deepEqual(readWebMeetResume(), {
            open: true,
            roomId: 'room_11111111-1111-1111-1111-111111111111',
            media: { microphone: false, camera: false }
        });

        writeWebMeetResume({ media: { microphone: true, camera: true } });
        assert.deepEqual(readWebMeetResume(), {
            open: true,
            roomId: 'room_11111111-1111-1111-1111-111111111111',
            media: { microphone: true, camera: true }
        });

        writeWebMeetResume({ roomId: '' });
        assert.deepEqual(readWebMeetResume(), {
            open: true,
            roomId: '',
            media: { microphone: true, camera: true }
        });

        clearWebMeetResume();
        assert.equal(readWebMeetResume(), null);
    });
});

test('resume record tolerates malformed and unavailable storage', () => {
    withFakeStorage(() => {
        globalThis.sessionStorage.setItem('webmeet.resume', '{not json');
        assert.equal(readWebMeetResume(), null);
    });

    const previous = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        get() { throw new Error('blocked'); }
    });
    try {
        assert.equal(readWebMeetResume(), null);
        assert.equal(writeWebMeetResume({ open: true }), null);
        clearWebMeetResume();
    } finally {
        delete globalThis.sessionStorage;
        if (previous !== undefined) {
            globalThis.sessionStorage = previous;
        }
    }
});

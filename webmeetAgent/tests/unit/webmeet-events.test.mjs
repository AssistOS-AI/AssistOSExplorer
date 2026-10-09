import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    isPersistentWebMeetEvent,
    isWorkspacePersistentWebMeetEvent,
    parseWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import {
    ROOM_EVENT_TYPES,
    WebMeetRoomEvents
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js';

test('WebMeet events encode as room:type:base64_payload and parse through the central contract', () => {
    const event = buildWebMeetEvent('meeting_1', WEBMEET_EVENT_TYPES.CHAT_REALTIME, {
        meetingId: 'meeting_1',
        message: {
            authorId: 'participant_1',
            message: 'hello'
        }
    });

    assert.match(event, /^meeting_1:chat:[A-Za-z0-9_-]+$/);

    const parsed = parseWebMeetEvent(event);
    assert.equal(parsed.room, 'meeting_1');
    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.CHAT_REALTIME);
    assert.equal(parsed.persistent, false);
    assert.equal(parsed.payload.message.message, 'hello');
    assert.match(parsed.id, /^event_/);
    assert.ok(Date.parse(parsed.createdAt));
});

test('WebMeet event definitions expose persistence by event type', () => {
    assert.equal(isPersistentWebMeetEvent(WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED), true);
    assert.equal(isWorkspacePersistentWebMeetEvent(WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED), true);
    assert.equal(isPersistentWebMeetEvent(WEBMEET_EVENT_TYPES.CHAT_REALTIME), false);
    assert.equal(isPersistentWebMeetEvent(WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED), false);
    assert.equal(isPersistentWebMeetEvent(WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED), false);
    assert.equal(isWorkspacePersistentWebMeetEvent(WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED), false);
    assert.equal(Object.hasOwn(WEBMEET_EVENT_TYPES, 'PARTICIPANT_AVATAR_UPDATED'), false);
});

test('WebMeet event builders reject missing required payload fields', () => {
    assert.throws(() => buildWebMeetEvent('meeting_1', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, {
        meetingId: 'meeting_1'
    }), /participantId/);
});

test('workspace meeting creation events map to dashboard room creation refresh events', () => {
    const codec = new WebMeetRoomEvents();

    assert.equal(
        codec.resolveRoomEventType(WEBMEET_EVENT_TYPES.MEETING_CREATED),
        ROOM_EVENT_TYPES.CREATED
    );
});

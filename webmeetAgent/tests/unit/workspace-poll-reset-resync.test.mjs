import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebMeetRoom } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    parseWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

const tick = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const invalidation = () => buildWebMeetEvent('rooms', WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED, { workspaceId: 'rooms' });

test('workspace poll after cursorReset adopts the blank-cursor history without replaying it', async (t) => {
    const previous = globalThis.window;
    const timers = new Map();
    let timerId = 0;
    globalThis.window = {
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    const responses = [];
    const requests = [];
    const room = new WebMeetRoom({
        getSession: () => null, setSession() {}, isGuestSession: () => false,
        connectLiveKit: async () => {}, disconnectLiveKit: async () => {},
        getRoom: () => null, getRoomAvatars: () => ({}), setRoomAvatar() {},
        applyRealtimeParticipantAvatar() {}, publishRealtimePayload: async () => {},
        getCurrentActorId: () => '', getSelectedWorkspaceId: () => 'rooms',
        runTool: async (_name, args) => { requests.push(args.afterId); return responses.shift(); }
    });
    t.after(() => { room.dispose(); globalThis.window = previous; });
    const dispatched = [];
    room.handleIncomingEvent = (_source, encoded) => {
        const parsed = parseWebMeetEvent(encoded);
        dispatched.push(parsed.id);
        return parsed;
    };
    let revalidations = 0;
    room.requestWorkspaceRevalidation = () => { revalidations += 1; };
    const fire = async () => {
        const [id, timer] = [...timers].find(([, entry]) => entry.delay === 0 || entry.delay === 5000);
        timers.delete(id);
        await timer.fn();
        await tick();
    };

    const history = [invalidation(), invalidation()];
    const historyIds = history.map((event) => parseWebMeetEvent(event).id);
    const fresh = invalidation();
    const freshId = parseWebMeetEvent(fresh).id;

    room.workspacePollId = 'rooms';
    room.lastWorkspaceEventId = 'stale-cursor';
    responses.push(
        { events: [], nextCursor: '', cursorReset: true },
        { events: history, nextCursor: historyIds[1], cursorReset: false },
        { events: [fresh], nextCursor: freshId, cursorReset: false }
    );
    room.startWorkspaceEvents();
    await fire();
    assert.equal(revalidations, 1, 'reset itself requests revalidation');
    assert.equal(room.lastWorkspaceEventId, '');
    await fire();
    assert.deepEqual(dispatched, [], 'historical events must not be dispatched after a reset');
    assert.equal(room.lastWorkspaceEventId, historyIds[1]);
    await fire();
    assert.deepEqual(requests, ['stale-cursor', '', historyIds[1]]);
    assert.deepEqual(dispatched, [freshId], 'events after the adopted cursor are delivered');
    assert.equal(room.lastWorkspaceEventId, freshId);
});

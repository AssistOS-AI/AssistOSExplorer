import test from 'node:test';
import assert from 'node:assert/strict';
import { WebMeetRoom } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js';
import { WebMeetRoomLiveKit } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-livekit.js';
import { WebmeetDashboard } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js';
import { WebmeetMediaController } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/webmeet-media-controller.js';
import { meetingActionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js';
import { roomSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js';
import { dashboardDataMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js';
import { dashboardRealtimeMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js';
import { buildWebMeetEvent, WEBMEET_EVENT_TYPES as TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const session = (id = 'A', participantIdentity = `participant-${id}`) => ({ meeting: { id, title: id }, participantIdentity });

function fixture(t, { media = null, disconnect = null, leave = null } = {}) {
    const previous = globalThis.window;
    const timers = new Map();
    const calls = [];
    let timerId = 0;
    let list = async () => ({ rooms: [{ id: 'A', status: 'active' }, { id: 'B', status: 'active' }] });
    globalThis.window = {
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, clearInterval() {}, removeEventListener() {},
        location: { href: 'https://fixture.test/' },
        localStorage: { getItem: () => null, setItem: (...args) => calls.push(['resume', ...args]) },
        webSkel: { appServices: { getClient: () => ({ callTool: async () => { calls.push(['list']); return list(); } }) } },
    };
    const dashboard = {
        ...meetingActionMethods, ...roomSessionMethods, ...dashboardDataMethods,
        ...dashboardRealtimeMethods,
        state: { session: session(), selectedMeetingId: 'A', meetings: [{ id: 'A' }], media: {}, meetingParticipantsById: {} },
        selectedMeeting: { id: 'A', title: 'A' },
        isGuestSession: () => false,
        getMeetingTitleById: () => 'A',
        renderAll: () => calls.push(['render']), renderMeetingSummary: () => calls.push(['summary']),
        setError: (message) => calls.push(['error', message]),
        setDisconnectingRoomTransition() {}, clearRoomTransitionMessage() {},
        removeParticipantFromMeetingList: (...args) => calls.push(['remove', ...args]),
        muteRoomPlaybackElements() {}, unsubscribeRemotePublications() {},
        resetRoomUiState: () => calls.push(['reset']),
        element: { removeEventListener() {} }, presenceController: { teardown() {} },
        unregisterMediaDeviceChangeHandler() {}, clearMediaSettingsElementRefs() {},
        uninstallJoinMaterialRefreshListeners() {},
        loadMeetingDetails: async () => {},
    };
    const room = { localParticipant: { identity: 'participant-A' }, disconnect: async () => { calls.push(['disconnect', 'A']); await disconnect?.promise; } };
    dashboard.room = room;
    dashboard.roomLiveKit = new WebMeetRoomLiveKit();
    dashboard.roomLiveKit.room = room;
    dashboard.roomLiveKit.restoreRtcPeerConnection = () => calls.push(['restore', 'A']);
    dashboard.mediaController = {
        stopAllLocalMedia: WebmeetMediaController.prototype.stopAllLocalMedia,
        hardStopMicrophoneTracks() {}, hardStopAllLocalPublishedTracks() {},
        stopProcessedMicrophoneCapture: async () => { calls.push(['media', 'A']); await media?.promise; },
        clearBackgroundEffect: async () => {},
        onMediaStateChange: () => calls.push(['media-state']),
    };
    dashboard.webMeetRoom = new WebMeetRoom({
        getSession: () => dashboard.state.session,
        setSession: (value) => { dashboard.state.session = value; calls.push(['session', value?.meeting?.id]); },
        isGuestSession: () => false,
        connectLiveKit: async () => calls.push(['connect']),
        disconnectLiveKit: (options) => dashboard.disconnectRoom(options),
        getRoom: () => dashboard.room,
        getRoomAvatars: () => ({}), setRoomAvatar() {}, applyRealtimeParticipantAvatar() {},
        publishRealtimePayload: async () => {}, getCurrentActorId: () => '',
        getSelectedWorkspaceId: () => 'rooms',
        runTool: async () => ({ events: [], nextCursor: '', cursorReset: false }),
        api: {
            joinMeeting: async (payload) => { calls.push(['join', payload.meetingId]); return session(payload.meetingId, payload.participantId); },
            leaveMeeting: async (payload) => { calls.push(['leave', payload]); await leave?.promise; },
        },
    });
    dashboard.bindRoomEventHandlers();
    t.after(() => { dashboard.webMeetRoom.dispose(); globalThis.window = previous; });
    return { dashboard, calls, timers, setList: (next) => { list = next; } };
}

for (const boundary of ['media', 'disconnect', 'leave']) {
    test(`replacement waits for ${boundary}; cleanup keeps the captured participant`, async (t) => {
        const pending = deferred();
        const { dashboard, calls } = fixture(t, { [boundary]: pending });
        const leaving = dashboard.leaveMeeting();
        await tick();
        const joining = dashboard.webMeetRoom.join({ meetingId: 'B', participantId: 'participant-B' });
        await tick();
        assert.equal(calls.some(([name]) => name === 'join'), false);
        pending.resolve();
        await Promise.all([leaving, joining]);
        assert.equal(dashboard.state.session.meeting.id, 'B');
        assert.deepEqual(calls.filter(([name]) => name === 'leave'), [['leave', { meetingId: 'A', participantId: 'participant-A' }]]);
        assert.ok(calls.findIndex(([name]) => name === 'join') > calls.findIndex(([name]) => name === 'leave'));
    });

    for (const rejection of [false, true]) {
        test(`unload during ${boundary} ${rejection ? 'rejection' : 'resolution'} cancels queued replacement and continuations`, async (t) => {
            const pending = deferred();
            const { dashboard, calls, timers } = fixture(t, { [boundary]: pending });
            const leaving = dashboard.leaveMeeting();
            await tick();
            const joining = dashboard.webMeetRoom.join({ meetingId: 'B' });
            WebmeetDashboard.prototype.afterUnload.call(dashboard);
            assert.equal(dashboard.webMeetRoom.disposed, true);
            const position = calls.length;
            if (rejection) pending.reject(new Error('fixture failure'));
            else pending.resolve();
            await Promise.all([leaving, joining]);
            await tick();
            assert.equal(calls.slice(position).some(([name]) => ['list', 'render', 'summary', 'resume', 'join', 'connect', 'reset', 'media-state', 'session'].includes(name)), false);
            assert.equal(timers.size, 0);
            assert.deepEqual(calls.filter(([name]) => name === 'leave'), [['leave', { meetingId: 'A', participantId: 'participant-A' }]]);
        });
    }
}

test('forced same-room replacement with reused participant generation survives old server leave', async (t) => {
    const pending = deferred();
    const { dashboard, calls } = fixture(t, { leave: pending });
    const leaving = dashboard.leaveMeeting();
    await tick();
    dashboard.webMeetRoom.installSession(session());
    dashboard.state.media = { microphone: true };
    const position = calls.length;
    pending.resolve();
    await leaving;
    assert.equal(dashboard.state.session.participantIdentity, 'participant-A');
    assert.deepEqual(dashboard.state.media, { microphone: true });
    assert.equal(calls.slice(position).some(([name]) => ['list', 'render', 'resume', 'session'].includes(name)), false);
});

test('unload reuses a queued cleanup behind another transition without losing resource release', async (t) => {
    const { dashboard, calls, timers } = fixture(t);
    const pending = deferred();
    const active = dashboard.webMeetRoom.runTransition(async () => pending.promise);
    await tick();
    const leaving = dashboard.leaveMeeting();
    WebmeetDashboard.prototype.afterUnload.call(dashboard);
    pending.resolve();
    await Promise.all([active, leaving]);
    assert.deepEqual(calls.filter(([name]) => name === 'leave'), [['leave', { meetingId: 'A', participantId: 'participant-A' }]]);
    assert.equal(calls.some(([name]) => ['list', 'render', 'resume'].includes(name)), false);
    assert.equal(timers.size, 0);
});

test('unload reuses nested cleanup without reacquiring its join transition or leaving twice', async (t) => {
    const pending = deferred();
    const { dashboard, calls } = fixture(t, { disconnect: pending });
    const switching = dashboard.webMeetRoom.runTransition(async (transition) => {
        await dashboard.unjoinCurrentSession({ transition });
        if (transition.isCurrent()) await dashboard.webMeetRoom.join({ meetingId: 'B' }, transition);
    });
    await tick();
    WebmeetDashboard.prototype.afterUnload.call(dashboard);
    pending.resolve();
    await switching;
    await tick();
    assert.deepEqual(calls.filter(([name]) => name === 'leave'), [['leave', { meetingId: 'A', participantId: 'participant-A' }]]);
    assert.equal(calls.some(([name]) => name === 'join'), false);
});

test('late join response after unload cannot install a session and releases only its returned participant', async (t) => {
    const { dashboard, calls } = fixture(t);
    const pending = deferred();
    dashboard.webMeetRoom.getApi = () => ({
        joinMeeting: () => pending.promise,
        leaveMeeting: async (payload) => calls.push(['late-leave', payload]),
    });
    const joining = dashboard.webMeetRoom.join({ meetingId: 'B' });
    await tick();
    dashboard.webMeetRoom.dispose();
    pending.resolve(session('B'));
    await joining;
    assert.equal(dashboard.state.session.meeting.id, 'A');
    assert.deepEqual(calls.filter(([name]) => name === 'late-leave'), [['late-leave', { meetingId: 'B', participantId: 'participant-B' }]]);
});

test('failed leave releases the transition gate and ordinary leave clears the session', async (t) => {
    const pending = deferred();
    const { dashboard, calls } = fixture(t, { leave: pending });
    const leaving = dashboard.leaveMeeting();
    await tick();
    pending.reject(new Error('offline'));
    await leaving;
    assert.equal(dashboard.state.session, null);
    assert.equal(dashboard.state.leavingMeeting, false);
    assert.ok(calls.some(([name]) => name === 'list'));
    await dashboard.webMeetRoom.join({ meetingId: 'B' });
    assert.equal(dashboard.state.session.meeting.id, 'B');
});

test('successful visibility refresh leaves missing or archived joined rooms, but failures and other hidden rooms do not', async (t) => {
    const { dashboard, calls, setList } = fixture(t);
    setList(async () => { throw new Error('transient'); });
    dashboard.webMeetRoom.requestWorkspaceRevalidation();
    await assert.rejects(() => dashboard.refreshMeetingsFromWorkspaceEvent(), /transient/);
    assert.equal(dashboard.webMeetRoom.workspaceReconciledVersion, 0);
    assert.equal(dashboard.state.session.meeting.id, 'A');
    setList(async () => ({ rooms: [{ id: 'A', status: 'active' }] }));
    await dashboard.refreshMeetingsFromWorkspaceEvent();
    assert.equal(calls.some(([name]) => name === 'leave'), false);
    setList(async () => ({ rooms: [{ id: 'A', status: 'archived' }] }));
    await dashboard.refreshMeetingsFromWorkspaceEvent();
    assert.equal(dashboard.state.session, null);
    assert.equal(calls.filter(([name]) => name === 'leave').length, 1);
});

test('a stale directory response cannot overwrite a newer refresh or evict a replacement', async (t) => {
    const { dashboard, setList } = fixture(t);
    const pending = deferred();
    setList(() => pending.promise);
    const refresh = dashboard.refreshMeetingsFromWorkspaceEvent();
    await tick();
    dashboard.webMeetRoom.installSession(session('B'));
    setList(async () => ({ rooms: [{ id: 'B', status: 'active' }] }));
    await dashboard.loadMeetings({ revalidateVisibility: true });
    pending.resolve({ rooms: [] });
    await refresh;
    assert.equal(dashboard.state.meetings[0].id, 'B');
    assert.equal(dashboard.state.session.meeting.id, 'B');
});

test('missing-room reconciliation cleans up, and same-room replacement is protected during revalidation', async (t) => {
    const { dashboard, setList, calls } = fixture(t);
    const pending = deferred();
    setList(() => pending.promise);
    const refresh = dashboard.refreshMeetingsFromWorkspaceEvent();
    await tick();
    dashboard.webMeetRoom.installSession(session('A', 'replacement-A'));
    pending.resolve({ rooms: [] });
    await refresh;
    assert.equal(dashboard.state.session.participantIdentity, 'replacement-A');
    assert.equal(calls.some(([name]) => name === 'leave'), false);
    setList(async () => ({ rooms: [] }));
    await dashboard.refreshMeetingsFromWorkspaceEvent();
    assert.equal(dashboard.state.session, null);
    assert.deepEqual(calls.filter(([name]) => name === 'leave'), [['leave', { meetingId: 'A', participantId: 'replacement-A' }]]);
});

test('malformed directory success and response after stop do not evict', async (t) => {
    const { dashboard, setList, calls } = fixture(t);
    setList(async () => ({}));
    await assert.rejects(() => dashboard.refreshMeetingsFromWorkspaceEvent(), /Invalid room directory/);
    const pending = deferred();
    setList(() => pending.promise);
    const refresh = dashboard.refreshMeetingsFromWorkspaceEvent();
    dashboard.stopWorkspaceEvents();
    pending.resolve({ rooms: [] });
    await refresh;
    assert.equal(dashboard.state.session.meeting.id, 'A');
    assert.equal(calls.some(([name]) => name === 'leave'), false);
});

test('workspace polling advances explicit cursors, retries pending invalidation, and never reschedules after stop', async (t) => {
    const { dashboard, timers, setList } = fixture(t);
    let result = { events: [], nextCursor: 'opaque-tail', cursorReset: false };
    const requests = [];
    dashboard.webMeetRoom.runTool = async (_name, args) => { requests.push(args); return result; };
    const fire = async (delay) => {
        const entry = [...timers].find(([, timer]) => timer.delay === delay);
        assert.ok(entry, `expected timer ${delay}`);
        timers.delete(entry[0]);
        await entry[1].fn();
        await tick();
    };
    setList(async () => { throw new Error('offline'); });
    dashboard.startWorkspaceEvents();
    await fire(0);
    await fire(100);
    assert.equal(dashboard.webMeetRoom.workspaceReconciledVersion, 0);
    assert.equal([...timers.values()].some(({ delay }) => delay === 100), false);
    setList(async () => ({ rooms: [{ id: 'A' }] }));
    await fire(5000);
    assert.equal(requests.at(-1).afterId, 'opaque-tail');
    await fire(100);
    assert.equal(dashboard.webMeetRoom.workspaceReconciledVersion, dashboard.webMeetRoom.workspaceInvalidationVersion);
    result = { events: [], nextCursor: '', cursorReset: true };
    await fire(5000);
    assert.equal(dashboard.webMeetRoom.lastWorkspaceEventId, '');
    const pending = deferred();
    dashboard.webMeetRoom.runTool = () => pending.promise;
    const polling = fire(5000);
    await tick();
    dashboard.stopWorkspaceEvents();
    dashboard.clearWorkspaceMeetingsRefreshTimer();
    pending.resolve(result);
    await polling;
    assert.equal(timers.size, 0);
    assert.throws(() => dashboard.webMeetRoom.handleIncomingEvent('livekit', buildWebMeetEvent('rooms', TYPES.WORKSPACE_ROOMS_INVALIDATED, { workspaceId: 'rooms' })), /untrusted/);
});

test('old LiveKit disconnect completion and callback preserve replacement adapter ownership', async (t) => {
    fixture(t);
    const pending = deferred();
    const callbacks = [];
    const restores = [];
    let index = 0;
    class Room {
        constructor() { this.index = ++index; this.handlers = new Map(); this.localParticipant = {}; this.remoteParticipants = new Map(); }
        on(type, fn) { this.handlers.set(type, fn); return this; }
        async connect() {}
        async disconnect() { if (this.index === 1) await pending.promise; }
    }
    const RoomEvent = new Proxy({}, { get: (_target, name) => name });
    const adapter = new WebMeetRoomLiveKit({
        ensureLiveKitClient: async () => ({ Room, RoomEvent, Track: {} }),
        buildRtcConfigForSession: () => null,
        installRtcPeerConnectionOverride: () => { const id = index + 1; return () => restores.push(id); },
    });
    const material = { participantToken: 'fixture-token', livekitUrl: 'wss://fixture.test' };
    await adapter.connect(material, { onDisconnected: ({ room }) => callbacks.push(room.index) });
    const old = adapter.room;
    const disconnecting = adapter.disconnect();
    await adapter.connect(material);
    const replacement = adapter.room;
    const restore = adapter.restoreRtcPeerConnection;
    old.handlers.get('Disconnected')();
    pending.resolve();
    await disconnecting;
    assert.equal(adapter.room, replacement);
    assert.equal(adapter.restoreRtcPeerConnection, restore);
    assert.deepEqual(callbacks, []);
    assert.deepEqual(restores, [1]);
});

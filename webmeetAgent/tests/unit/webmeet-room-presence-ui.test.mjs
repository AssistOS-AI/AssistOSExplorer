import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeetingListController } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-list-controller.js';

const root = path.resolve(import.meta.dirname, '../..');
const modalDir = path.join(root, 'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard');

async function readModalFile(relativePath) {
    return readFile(path.join(modalDir, relativePath), 'utf8');
}

test('LiveKit active speaker events are forwarded into participant roster state', async () => {
    const livekitController = await readModalFile('services/room/webmeet-room-livekit.js');
    const roomSessionMethods = await readModalFile('controllers/room-session-methods.js');
    const participantViewMethods = await readModalFile('controllers/participant-view-methods.js');

    assert.match(livekitController, /RoomEvent\.ActiveSpeakersChanged/);
    assert.match(livekitController, /onActiveSpeakersChanged/);
    assert.match(roomSessionMethods, /setActiveSpeakers\(participants,\s*Track\)/);
    assert.match(participantViewMethods, /activeSpeakerIds/);
    assert.match(participantViewMethods, /isSpeaking:\s*Boolean\(entry\.isSpeaking\)/);
});

test('authenticated refresh does not use cached pending leave state', async () => {
    const modal = await readModalFile('webmeet-dashboard.js');
    const presenceController = await readModalFile('controllers/meeting-presence-controller.js');

    assert.doesNotMatch(modal, /consumePendingMeetingLeaves/);
    assert.doesNotMatch(modal, /flushPendingAuthenticatedLeaves/);
    assert.doesNotMatch(presenceController, /pendingLeaves|PENDING_LEAVES_STORAGE_KEY|rememberPendingLeave/);
});

test('connected room keeps durable presence alive without roster polling', async () => {
    const modal = await readModalFile('webmeet-dashboard.js');
    const sessionMethods = await readModalFile('controllers/dashboard-session-methods.js');
    const roomSessionMethods = await readModalFile('controllers/room-session-methods.js');
    const presenceController = await readModalFile('controllers/meeting-presence-controller.js');
    const roomService = await readModalFile('services/room/webmeet-room.js');

    assert.doesNotMatch(modal, /shouldPing|runPresenceTool/);
    assert.doesNotMatch(sessionMethods, /startPresenceHeartbeat|sendPresencePing/);
    assert.doesNotMatch(roomSessionMethods, /startPresenceHeartbeat|loadMeetingDetails\(\{ includeParticipants: false \}\)/);
    assert.doesNotMatch(presenceController, /setInterval/);
    assert.match(roomService, /startPresenceHeartbeat/);
    assert.match(roomService, /sendPresenceHeartbeat/);
    assert.match(roomService, /getApi\(\)\.heartbeat/);
    assert.match(roomSessionMethods, /onDisconnected:[\s\S]*handleExternalLiveKitDisconnect\(\)[\s\S]*handleExternalRoomDisconnect\(\)/);
});

test('room connection prepares push-to-talk microphone permission before LiveKit connects', async () => {
    const roomSessionMethods = await readModalFile('controllers/room-session-methods.js');
    const connectRoom = roomSessionMethods.slice(
        roomSessionMethods.indexOf('async connectRoom'),
        roomSessionMethods.indexOf('\n        const remoteVideoRecoveryCounts', roomSessionMethods.indexOf('async connectRoom'))
    );

    assert.match(connectRoom, /await this\.chatComponent\?\.prepareRoboMicrophonePermission\?\.\(\)/);
    assert.ok(
        connectRoom.indexOf('await this.disconnectRoom({ transition })')
            < connectRoom.indexOf('prepareRoboMicrophonePermission'),
        'the previous room microphone must be released before requesting permission for the new room'
    );
});

test('workspace event polling is outside the active LiveKit room lifecycle', async () => {
    const actionMethods = await readModalFile('controllers/meeting-action-methods.js');
    const joinMeeting = actionMethods.slice(
        actionMethods.indexOf('async joinMeeting'),
        actionMethods.indexOf('\n    getCurrentAvatarOverrideUserId', actionMethods.indexOf('async joinMeeting'))
    );
    const unjoinCurrentSession = actionMethods.slice(
        actionMethods.indexOf('async unjoinCurrentSession'),
        actionMethods.indexOf('\n    async sendPublicChat', actionMethods.indexOf('async unjoinCurrentSession'))
    );

    assert.match(joinMeeting, /this\.stopWorkspaceEvents\(\)/);
    assert.ok(
        joinMeeting.indexOf('this.stopWorkspaceEvents()') < joinMeeting.indexOf('await this.webMeetRoom.join(payload, transition)'),
        'workspace polling must stop before joining the active LiveKit room'
    );
    assert.match(unjoinCurrentSession, /this\.startWorkspaceEvents\(\)/);
    assert.match(unjoinCurrentSession, /await this\.loadMeetings\(\)/);
    assert.ok(
        unjoinCurrentSession.indexOf('await this.loadMeetings()') < unjoinCurrentSession.indexOf('this.startWorkspaceEvents()'),
        'room list must refresh before workspace polling restarts'
    );
});

test('external LiveKit disconnect refreshes authenticated room list before rendering', async () => {
    const roomSessionMethods = await readModalFile('controllers/room-session-methods.js');
    const disconnectedHandler = roomSessionMethods.slice(
        roomSessionMethods.indexOf('onDisconnected: ({ room }) =>'),
        roomSessionMethods.indexOf('\n            onConnected:', roomSessionMethods.indexOf('onDisconnected: ({ room }) =>'))
    );
    const externalDisconnect = roomSessionMethods.slice(
        roomSessionMethods.indexOf('async handleExternalRoomDisconnect'),
        roomSessionMethods.indexOf('\n    resetRoomUiState', roomSessionMethods.indexOf('async handleExternalRoomDisconnect'))
    );
    const disconnectRoom = roomSessionMethods.slice(
        roomSessionMethods.indexOf('async disconnectRoom'),
        roomSessionMethods.indexOf('\n    async toggleMicrophone', roomSessionMethods.indexOf('async disconnectRoom'))
    );

    assert.match(disconnectedHandler, /this\.expectedLiveKitDisconnect/);
    assert.match(disconnectedHandler, /this\.handleExternalRoomDisconnect\(\)/);
    assert.match(externalDisconnect, /await this\.loadMeetings\(\)/);
    assert.match(externalDisconnect, /this\.startWorkspaceEvents\(\)/);
    assert.match(externalDisconnect, /this\.renderAll\(\)/);
    assert.ok(
        externalDisconnect.indexOf('await this.loadMeetings()') < externalDisconnect.indexOf('this.renderAll()'),
        'external disconnect must refresh room list before rendering'
    );
    assert.match(disconnectRoom, /this\.expectedLiveKitDisconnect = true/);
    assert.match(disconnectRoom, /this\.expectedLiveKitDisconnect = false/);
});

test('meeting details use LiveKit participants as the room presence source', async () => {
    const store = await readFile(path.join(root, 'lib/webmeetStore.mjs'), 'utf8');
    const roomParticipants = await readFile(path.join(root, 'lib/services/roomParticipants.mjs'), 'utf8');
    const livekitRuntime = await readFile(path.join(root, 'lib/runtime/livekitRuntime.mjs'), 'utf8');

    assert.match(livekitRuntime, /export async function listLiveKitRoomParticipants/);
    assert.match(livekitRuntime, /callLiveKitRoomApi\(context,\s*'ListParticipants'/);
    assert.match(roomParticipants, /projectLiveKitRoomParticipants/);
    assert.match(roomParticipants, /await listLiveKitRoomParticipants/);
    assert.match(roomParticipants, /options\.includeParticipants === false/);
    assert.match(roomParticipants, /await getRealtimeRoomParticipants/);
    assert.match(store, /export async function getMeeting/);
    assert.match(store, /getMeetingImpl/);
});

test('LiveKit mute handlers gate microphone state updates to microphone publications', async () => {
    const roomSessionMethods = await readModalFile('controllers/room-session-methods.js');
    const participantViewMethods = await readModalFile('controllers/participant-view-methods.js');
    const mediaController = await readModalFile('controllers/webmeet-media-controller.js');

    assert.match(roomSessionMethods, /this\.isMicrophonePublication\(publication,\s*Track,\s*participant\)/);
    assert.match(roomSessionMethods, /const isMicrophoneTrack = this\.isMicrophonePublication\(publication,\s*Track,\s*participant\)/);
    assert.match(roomSessionMethods, /else if \(isMicrophoneTrack\)/);
    assert.match(roomSessionMethods, /isMicrophoneTrack\s*&& participantId ===/);
    assert.match(participantViewMethods, /isMicrophonePublication\(publication,\s*Track,\s*participant = null\)/);
    assert.match(participantViewMethods, /getActiveCustomMicrophoneTrackForParticipant/);
    assert.match(mediaController, /isMicrophonePublication\(publication,\s*Track/);
});

test('active speaker updates do not mutate microphone status', async () => {
    const participantViewMethods = await readModalFile('controllers/participant-view-methods.js');
    const setActiveSpeakersBody = participantViewMethods.match(/setActiveSpeakers\([\s\S]*?\n    },\n\n    syncLocalMediaStateFromRoom/)?.[0] || '';

    assert.match(setActiveSpeakersBody, /activeSpeakerIds/);
    assert.doesNotMatch(setActiveSpeakersBody, /setParticipantMicState/);
    assert.doesNotMatch(setActiveSpeakersBody, /micOn\s*=/);
});

test('microphone publication helper is shared by participant and media controllers', async () => {
    const helper = await readModalFile('services/microphone-publication.js');
    const participantViewMethods = await readModalFile('controllers/participant-view-methods.js');
    const mediaController = await readModalFile('controllers/webmeet-media-controller.js');

    assert.match(helper, /export function isMicrophonePublication/);
    assert.match(helper, /allowLocalCustomFallback/);
    assert.match(participantViewMethods, /services\/microphone-publication\.js/);
    assert.match(mediaController, /services\/microphone-publication\.js/);
});

test('room notification sounds are local, generated, and setting controlled', async () => {
    const modal = await readModalFile('webmeet-dashboard.js');
    const sessionMethods = await readModalFile('controllers/dashboard-session-methods.js');
    const mediaSettings = await readModalFile('controllers/media-settings-methods.js');
    const soundService = await readModalFile('services/room-notification-sounds.js');

    assert.match(modal, /createRoomNotificationSoundService/);
    assert.match(sessionMethods, /playParticipantJoinSound/);
    assert.match(sessionMethods, /playParticipantLeaveSound/);
    assert.match(sessionMethods, /isLocalParticipantIdentity/);
    assert.match(modal, /roomNotificationSounds/);
    assert.match(mediaSettings, /roomNotificationSounds:\s*true/);
    assert.match(soundService, /createOscillator/);
    assert.match(soundService, /isJoin\s*\?\s*0\.18\s*:\s*0\.16/);
    assert.match(soundService, /frequency:\s*587\.33/);
    assert.match(soundService, /frequency:\s*880/);
    assert.match(soundService, /frequency:\s*783\.99/);
    assert.match(soundService, /frequency:\s*493\.88/);
    assert.match(soundService, /oscillator\.type = isJoin \? 'triangle' : 'sine'/);
    assert.doesNotMatch(soundService, /fetch\(/);
});

test('participant room list renders stable active speaker indicator markup', async () => {
    const meetingListController = await readModalFile('controllers/meeting-list-controller.js');
    const stylesheet = await readModalFile('webmeet-dashboard.css');

    assert.match(meetingListController, /is-speaking/);
    assert.match(meetingListController, /webmeet-room-participant-speaking/);
    assert.match(meetingListController, /aria-hidden="true"/);
    assert.match(stylesheet, /\.webmeet-room-participant-speaking/);
    assert.match(stylesheet, /@keyframes webmeet-speaking-pulse/);
});

test('room transitions expose a blocking overlay with dynamic status text', async () => {
    const modal = await readModalFile('webmeet-dashboard.js');
    const dashboardHtml = await readModalFile('webmeet-dashboard.html');
    const renderMethods = await readModalFile('controllers/dashboard-render-methods.js');
    const sessionMethods = await readModalFile('controllers/dashboard-session-methods.js');
    const actionMethods = await readModalFile('controllers/meeting-action-methods.js');

    assert.match(modal, /roomTransition:\s*\{\s*active:\s*false,\s*message:\s*''\s*\}/);
    assert.match(dashboardHtml, /id="webmeetRoomTransitionMessage"/);
    assert.match(renderMethods, /setConnectingRoomTransition/);
    assert.match(renderMethods, /setDisconnectingRoomTransition/);
    assert.match(renderMethods, /is-room-transitioning/);
    assert.match(sessionMethods, /setConnectingRoomTransition/);
    assert.match(actionMethods, /setDisconnectingRoomTransition/);
});

test('meeting list marks speaking participants without removing idle placeholders', () => {
    const controller = new MeetingListController();
    const element = { innerHTML: '' };
    controller.setElement(element);

    controller.render([{
        id: 'meeting-1',
        title: 'Room',
        roomType: 'team'
    }], 'meeting-1', {
        'meeting-1': [{
            id: 'participant-a',
            name: 'Alice',
            micOn: true,
            isSpeaking: true
        }, {
            id: 'participant-b',
            name: 'Bob',
            micOn: false,
            isSpeaking: false
        }]
    });

    assert.match(element.innerHTML, /webmeet-room-participant is-speaking/);
    assert.match(element.innerHTML, /webmeet-room-participant-speaking/);
    assert.match(element.innerHTML, /webmeet-room-participant-speaking is-idle/);
});

test('meeting list hides archived rooms unless admin enables them', () => {
    const controller = new MeetingListController();
    const element = { innerHTML: '' };
    const meetings = [{
        id: 'active-room',
        title: 'Active room',
        roomType: 'team'
    }, {
        id: 'archived-room',
        title: 'Archived room',
        roomType: 'team',
        status: 'archived'
    }];
    controller.setElement(element);

    controller.render(meetings, 'active-room', {}, true, '', false);
    assert.match(element.innerHTML, /Active room/);
    assert.doesNotMatch(element.innerHTML, /Archived room/);

    controller.render(meetings, 'active-room', {}, true, '', true);
    assert.match(element.innerHTML, /Archived rooms/);
    assert.match(element.innerHTML, /Archived room/);

    controller.render(meetings, 'active-room', {}, false, '', true);
    assert.doesNotMatch(element.innerHTML, /Archived room/);
});

test('meeting list sorts rooms alphabetically by name', () => {
    const controller = new MeetingListController();
    const element = { innerHTML: '' };
    const meetings = [{
        id: 'room-zebra',
        title: 'Zebra room',
        roomType: 'team'
    }, {
        id: 'room-alpha-2',
        title: 'Alpha 2',
        roomType: 'team'
    }, {
        id: 'room-alpha-10',
        title: 'Alpha 10',
        roomType: 'team'
    }, {
        id: 'room-beta-archived',
        title: 'Beta archived',
        roomType: 'team',
        status: 'archived'
    }, {
        id: 'room-alpha-archived',
        title: 'Alpha archived',
        roomType: 'team',
        status: 'archived'
    }];
    controller.setElement(element);

    controller.render(meetings, 'room-alpha-2', {}, true, '', true);

    const alpha2Index = element.innerHTML.indexOf('Alpha 2');
    const alpha10Index = element.innerHTML.indexOf('Alpha 10');
    const zebraIndex = element.innerHTML.indexOf('Zebra room');
    const archivedHeadingIndex = element.innerHTML.indexOf('Archived rooms');
    const alphaArchivedIndex = element.innerHTML.indexOf('Alpha archived');
    const betaArchivedIndex = element.innerHTML.indexOf('Beta archived');

    assert.ok(alpha2Index >= 0);
    assert.ok(alpha10Index > alpha2Index);
    assert.ok(zebraIndex > alpha10Index);
    assert.ok(archivedHeadingIndex > zebraIndex);
    assert.ok(alphaArchivedIndex > archivedHeadingIndex);
    assert.ok(betaArchivedIndex > alphaArchivedIndex);
});

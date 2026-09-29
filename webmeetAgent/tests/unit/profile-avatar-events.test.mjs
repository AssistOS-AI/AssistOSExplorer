import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    decryptPayload,
    deriveMasterKey,
    encryptPayload,
    unwrapDek
} from '../../lib/webmeetCrypto.mjs';
import {
    createMeeting,
    createStoreContext,
    getGuestMeetingDetails,
    getMeeting,
    joinGuestMeeting,
    joinMeeting,
    listWorkspaceEvents,
    recordProfileAvatarUpdated,
    updateGuestMeetingParticipantAvatar,
    updateMeetingParticipantAvatar
} from '../../lib/webmeetStore.mjs';
import { meetingActionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js';
import { dashboardRenderMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js';
import { dashboardSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js';
import { parseWebMeetEvent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { WEBMEET_AVATAR_PRESETS } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-avatar-override.js';
import { EMOTIONS } from '../../../explorer/shared/vendor/axi-face/src/state-machine.mjs';
import { withGuestParticipantOwner } from './participant-owner-fixture.mjs';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';

let tempRoot = '';
const originalDataDir = process.env.WEBMEET_DATA_DIR;
const originalMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
const originalLivekitApiKey = process.env.LIVEKIT_API_KEY;
const originalLivekitApiSecret = process.env.LIVEKIT_API_SECRET;

async function createWorkspace() {
    return { id: `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

async function joinTestGuest(context, args) {
    return await withGuestParticipantOwner(context, args.meetingId, () => (
        joinGuestMeeting(context, args)
    ), String(args.participantId || '').trim());
}

// Later guest room operations run as the same verified guest that joined.
async function asTestGuest(context, meetingId, guestId, callback) {
    return await withGuestParticipantOwner(context, meetingId, callback, guestId);
}

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webmeet-avatar-events-'));
    process.env.WEBMEET_DATA_DIR = path.join(tempRoot, 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret';
});

afterEach(() => {
    if (originalDataDir === undefined) {
        delete process.env.WEBMEET_DATA_DIR;
    } else {
        process.env.WEBMEET_DATA_DIR = originalDataDir;
    }
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
    } else {
        process.env.PLOINKY_WEBMEET_MASTER_KEY = originalMasterKey;
    }
    if (originalLivekitApiKey === undefined) {
        delete process.env.LIVEKIT_API_KEY;
    } else {
        process.env.LIVEKIT_API_KEY = originalLivekitApiKey;
    }
    if (originalLivekitApiSecret === undefined) {
        delete process.env.LIVEKIT_API_SECRET;
    } else {
        process.env.LIVEKIT_API_SECRET = originalLivekitApiSecret;
    }
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

function setLiveKitParticipants(context, participants) {
    context.listLiveKitParticipants = async () => participants;
}

function liveKitParticipant(identity, name, attributes = {}) {
    return {
        identity,
        name,
        kind: 'STANDARD',
        attributes
    };
}

function rewriteMeetingPayloadMembers(context, meetingId, transform) {
    const filePath = path.join(context.meetingsDir, `${meetingId}.json`);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const masterKey = deriveMasterKey(process.env.PLOINKY_WEBMEET_MASTER_KEY);
    const baseAad = {
        agentId: String(context.agentName || 'WebMeetAgent').trim() || 'WebMeetAgent',
        roomId: meetingId,
    };
    const buildAad = (recordType) => ({
        ...baseAad,
        recordType,
        schemaVersion: 2
    });
    const dek = unwrapDek(masterKey, record.dek, buildAad('room_dek'));
    const payload = decryptPayload(dek, record.payload, buildAad('room_payload'));
    payload.members = transform(Array.isArray(payload.members) ? payload.members : []);
    record.payload = encryptPayload(dek, payload, buildAad('room_payload'));
    record.encryption = {
        ...(record.encryption && typeof record.encryption === 'object' ? record.encryption : {}),
        aad: buildAad('room_payload')
    };
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

test("profile avatar updates are published as workspace events", async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };

    const event = await recordProfileAvatarUpdated(context, {
        workspaceId: workspace.id,
        userId: 'local:admin',
        authInfo
    });

    const parsedEvent = parseWebMeetEvent(event);
    assert.equal(parsedEvent.type, 'profile.avatar.updated');
    assert.equal(parsedEvent.payload.userId, 'local:admin');

    const events = await listWorkspaceEvents(context, workspace.id);
    assert.equal(events.length, 1);
    const parsedStoredEvent = parseWebMeetEvent(events[0]);
    assert.equal(parsedStoredEvent.type, 'profile.avatar.updated');
    assert.equal(parsedStoredEvent.payload.workspaceId, workspace.id);
    assert.equal(parsedStoredEvent.payload.userId, 'local:admin');
});

test("authenticated event list tools are exposed through MCP config and dispatch", async () => {
    const mcpConfig = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../mcp-config.json'),
        'utf8'
    );
    assert.match(mcpConfig, /"name": "webmeet_room_events_list"/);

    const toolSource = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../tools/webmeet_tool.mjs'),
        'utf8'
    );
    assert.match(toolSource, /case 'webmeet_room_events_list'/);
    assert.match(toolSource, /targetId\.startsWith\('room_'\)/);
    assert.match(toolSource, /listMeetingEvents\(context, targetId/);
    assert.match(toolSource, /listWorkspaceEvents\(context, targetId/);
});

test("join publishes workspace user id in participant state and LiveKit token attributes", async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:user-one',
            username: 'user-one',
            roles: []
        }
    };
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar room',
        authInfo: adminAuthInfo
    });

    const session = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'User One',
        participantId: 'participant-user-one',
        authInfo
    });

    assert.equal(session.participant.userId, 'local:user-one');
    assert.equal(session.participant.attributes.webmeetUserId, 'local:user-one');

    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    assert.equal(jwtPayload.attributes.webmeetUserId, 'local:user-one');
    assert.equal(jwtPayload.attributes.workspaceUserId, 'local:user-one');
    assert.equal(jwtPayload.attributes.ploinkyUserId, 'local:user-one');
    assert.equal(jwtPayload.video.canUpdateOwnMetadata, true);
});

test('participant avatar update returns a sanitized live projection without persisting roster avatar', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar projection room',
        authInfo
    });
    const session = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin',
        authInfo
    });

    const updated = await updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            fallbackLetter: 'A',
            config: {
                agentId: 'profile:local:admin',
                generated: true,
                size: '48',
                seed: 'profile:local:admin',
                style: 'robot-soft',
                palette: 'terminal'
            }
        },
        authInfo
    });

    assert.equal(updated.profileAvatar.enabled, true);
    assert.equal(updated.profileAvatar.config.size, '48');
    assert.equal(updated.profileAvatar.config.palette, 'terminal');

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar, null);

    const events = await listWorkspaceEvents(context, workspace.id);
    assert.equal(
        events.some((event) => parseWebMeetEvent(event).type === 'participant.avatar.updated'),
        false
    );
});

test("participant avatar projection rejects unsafe or invalid config fields", async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar validation room',
        authInfo
    });
    const session = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-validation',
        authInfo
    });

    await assert.rejects(() => updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:admin',
                src: 'javascript:alert(1)',
                generated: false
            }
        },
        authInfo
    }), /unsafe URL scheme/);

    await assert.rejects(() => updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:admin',
                emotion: 'surprised'
            }
        },
        authInfo
    }), /Invalid participant avatar emotion/);

    await assert.rejects(() => updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:admin',
                onload: 'alert(1)'
            }
        },
        authInfo
    }), /Unknown participant avatar config field/);
});

test('join does not persist avatar projection or token avatar attributes', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar join projection room',
        authInfo
    });

    const session = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-rejoin',
        avatar: {
            enabled: true,
            fallbackLetter: 'A',
            config: {
                agentId: 'profile:local:admin',
                generated: true,
                size: '48',
                seed: 'profile:local:admin',
                style: 'robot-soft',
                palette: 'terminal'
            }
        },
        authInfo
    });

    assert.equal(session.participant.profileAvatar, undefined);
    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    assert.equal(jwtPayload.attributes.webmeetProfileAvatar, undefined);

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar, null);
});

test('join ignores avatar payloads until a live avatar projection is published', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const authInfo = {
        user: {
            id: 'local:user',
            username: 'user',
            roles: ['user']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Default avatar projection room',
        authInfo: adminAuthInfo
    });

    const session = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'User',
        participantId: 'participant-user-default-avatar',
        avatar: {
            enabled: true,
            fallbackLetter: 'U',
            config: null
        },
        authInfo
    });

    assert.equal(session.participant.profileAvatar, undefined);

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'User')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar, null);
});

test('meeting details read avatar projection from LiveKit participant attributes', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Live avatar attribute room',
        authInfo
    });
    const session = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-live-avatar',
        authInfo
    });
    const liveAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        updatedAt: '2099-05-20T10:00:00.000Z',
        config: {
            agentId: 'profile:local:admin',
            generated: true,
            size: '32',
            seed: 'profile:local:admin',
            style: 'sketch',
            emotion: 'confused',
            complexity: 'high'
        }
    };

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin', {
        webmeetUserId: 'local:admin',
        userId: 'local:admin',
        workspaceUserId: 'local:admin',
        ploinkyUserId: 'local:admin',
        webmeetProfileAvatar: JSON.stringify(liveAvatar)
    })]);

    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar.config.size, '32');
    assert.equal(participant.profileAvatar.config.style, 'sketch');
    assert.equal(participant.profileAvatar.config.emotion, 'confused');
});

test("unauthenticated meeting join is rejected", async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Unauthenticated avatar payload room',
        authInfo: adminAuthInfo
    });

    await assert.rejects(() => joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Visitor',
        participantId: 'participant-visitor',
        avatar: {
            enabled: true,
            fallbackLetter: 'V',
            config: {
                agentId: 'profile:visitor',
                generated: true,
                seed: 'profile:visitor'
            }
        }
    }), /authentication is required/i);
});

test("guest meeting join does not publish authenticated avatar identity or projection", async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest avatar room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = await joinTestGuest(context, {
        meetingId: meeting.id,
        displayName: 'Guest Person',
        participantId: 'guest-person-1'
    });

    assert.equal(session.participant.guest, true);
    assert.equal(session.participant.userId, undefined);
    assert.equal(session.participant.attributes, undefined);
    assert.equal(session.participant.profileAvatar, undefined);

    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    assert.equal(jwtPayload.attributes, undefined);
    assert.equal(jwtPayload.video.canUpdateOwnMetadata, true);
});

test('guest participant avatar override is returned for live propagation without meeting-store persistence', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest avatar override room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = await joinTestGuest(context, {
        meetingId: meeting.id,
        displayName: 'Guest Person',
        participantId: 'guest-person-override'
    });

    const updated = await asTestGuest(context, meeting.id, 'guest-person-override', () => updateGuestMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            fallbackLetter: 'G',
            config: {
                generated: true,
                emotion: 'happy',
                seed: 'guest-person-override'
            }
        }
    }));

    assert.equal(updated.profileAvatar.enabled, true);
    assert.equal(updated.profileAvatar.config.emotion, 'happy');

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Guest Person')]);
    const details = await getMeeting(context, meeting.id, adminAuthInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.guest, true);
    assert.equal(participant.userId, undefined);
    assert.equal(participant.attributes?.webmeetUserId, undefined);
    assert.equal(participant.attributes?.workspaceUserId, undefined);
    assert.equal(participant.attributes?.ploinkyUserId, undefined);
    assert.equal(participant.profileAvatar, null);
});

test('guest meeting details allow a joined guest before LiveKit presence appears', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest bootstrap room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = await joinTestGuest(context, {
        meetingId: meeting.id,
        displayName: 'Guest Bootstrap',
        participantId: 'guest-bootstrap-1'
    });

    const details = await asTestGuest(context, meeting.id, 'guest-bootstrap-1', () => getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity
    }));

    assert.equal(details.meeting.id, meeting.id);
    assert.ok(Array.isArray(details.participants));
    assert.equal(details.participants[0]?.id, session.participantIdentity);
});

test('guest meeting details tolerate stored guest members that lost the guest flag', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest degraded membership room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = await joinTestGuest(context, {
        meetingId: meeting.id,
        displayName: 'Guest Degraded',
        participantId: 'guest-degraded-1'
    });

    rewriteMeetingPayloadMembers(context, meeting.id, (members) => members.map((member) => {
        if (String(member?.id || '').trim() !== session.participantIdentity) {
            return member;
        }
        return {
            id: member.id,
            displayName: member.displayName,
            joinedAt: member.joinedAt,
            lastSeenAt: member.lastSeenAt,
            attributes: member.attributes || {}
        };
    }));

    const details = await asTestGuest(context, meeting.id, 'guest-degraded-1', () => getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity
    }));

    assert.equal(details.meeting.id, meeting.id);
    assert.equal(details.participants[0]?.id, session.participantIdentity);
});

test('guest meeting details do not wipe stored members when LiveKit roster is temporarily empty', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest empty roster room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = await joinTestGuest(context, {
        meetingId: meeting.id,
        displayName: 'Guest Empty',
        participantId: 'guest-empty-1'
    });

    setLiveKitParticipants(context, []);

    const details = await asTestGuest(context, meeting.id, 'guest-empty-1', () => getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity
    }));

    assert.equal(details.participants[0]?.id, session.participantIdentity);

    const repeatDetails = await asTestGuest(context, meeting.id, 'guest-empty-1', () => getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity
    }));

    assert.equal(repeatDetails.participants[0]?.id, session.participantIdentity);
});

test("authenticated dashboard join keeps using the protected MCP tool path", async () => {
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-api.js'
        ),
        'utf8'
    );
    const joinMethod = actionSource.slice(actionSource.indexOf('async joinMeeting'), actionSource.indexOf('getCurrentAvatarOverrideUserId'));
    assert.match(joinMethod, /this\.webMeetRoom\.join\(payload\)/);
    assert.match(apiSource, /runTool\('webmeet_room_join'/);
    assert.doesNotMatch(joinMethod, /public-services\/webmeet/);
    assert.doesNotMatch(joinMethod, /\/meetings\/.*\/join/);
});

test("participant avatar refresh keeps using the protected MCP tool path", async () => {
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-api.js'
        ),
        'utf8'
    );
    const method = actionSource.slice(actionSource.indexOf('async publishCurrentParticipantAvatar'), actionSource.indexOf('async leaveMeeting'));
    assert.match(method, /this\.webMeetRoom\.publishAvatar\(avatar\)/);
    assert.match(apiSource, /runTool\('webmeet_participant_avatar_update'/);
    assert.doesNotMatch(method, /\/participants\/.*\/avatar/);
});

test("guest participant avatar refresh uses the scoped room MCP tool path", async () => {
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-api.js'
        ),
        'utf8'
    );
    const method = actionSource.slice(actionSource.indexOf('async publishCurrentParticipantAvatar'), actionSource.indexOf('async leaveMeeting'));
    assert.match(method, /this\.webMeetRoom\.publishAvatar\(avatar\)/);
    assert.match(apiSource, /runTool\('webmeet_participant_avatar_update'/);
    assert.match(apiSource, /avatar: requireObject\(avatar, 'avatar'\)/);
    assert.doesNotMatch(method, /if \(this\.isGuestSession\(\)\) return/);
});

test("authenticated dashboard join connects before publishing avatar best-effort", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const joinMethod = source.slice(source.indexOf('async joinMeeting'), source.indexOf('getCurrentAvatarOverrideUserId'));
    assert.match(joinMethod, /await this\.webMeetRoom\.join\(payload\)/);
    assert.match(joinMethod, /await this\.webMeetRoom\.connectLiveKit\(\)/);
    assert.match(joinMethod, /await this\.webMeetRoom\.refreshState\(\)/);
    assert.match(joinMethod, /this\.syncParticipantsFromRoom\(this\.room, window\.LivekitClient\?\.Track \|\| null\)/);
    // Best effort: a failed publish is reported and never aborts the join.
    assert.match(joinMethod, /try \{\s*await this\.publishCurrentParticipantAvatar\(\{ force: true \}\);\s*\} catch \(error\) \{/);
    assert.match(joinMethod, /WebMeet could not publish the avatar/);
    assert.ok(
        joinMethod.indexOf('await this.webMeetRoom.connectLiveKit()') < joinMethod.indexOf('await this.publishCurrentParticipantAvatar({ force: true })'),
        'avatar publish must happen after room connect'
    );
    assert.ok(
        joinMethod.indexOf('await this.webMeetRoom.connectLiveKit()') < joinMethod.indexOf('await this.webMeetRoom.refreshState()'),
        'presence reconciliation must happen after LiveKit connects'
    );
    assert.doesNotMatch(joinMethod, /initialAvatarState/);
    assert.doesNotMatch(joinMethod, /payload\.avatar/);
});

test("initial room connect skips avatar republish and waits for the canonical publish flow", async () => {
    const meetingActionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const roomSessionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );

    assert.match(meetingActionSource, /this\.state\.skipConnectedAvatarRepublishOnce = true;/);
    const connected = roomSessionSource.slice(
        roomSessionSource.indexOf('onConnected:'),
        roomSessionSource.indexOf('onConnectError:', roomSessionSource.indexOf('onConnected:'))
    );
    assert.match(connected, /const skipConnectedAvatarRepublishOnce = Boolean\(this\.state\.skipConnectedAvatarRepublishOnce\)/);
    assert.match(connected, /if \(!skipConnectedAvatarRepublishOnce\) \{/);
    assert.match(connected, /await this\.webMeetRoom\.requestAvatarState\(\)/);
});

test("connected meeting view does not open room EventSource directly", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );
    const realtimeSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    assert.doesNotMatch(source, /startMeetingEvents/);
    assert.doesNotMatch(source, /EventSource/);
    assert.doesNotMatch(realtimeSource, /startMeetingEvents/);
    assert.doesNotMatch(realtimeSource, /new EventSource/);
    assert.doesNotMatch(realtimeSource, /guest-sse/);
});

test("all WebMeet realtime transports normalize into the same internal event handler", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js'
        ),
        'utf8'
    );
    const roomSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );

    assert.match(roomSource, /emitWebMeetInternalEvent\('livekit'/);
    assert.match(dashboardSource, /emitNormalizedIncomingEvent\(source, encodedEvent, meta = \{\}\)/);
    assert.match(dashboardSource, /dispatchRoomEvent\(roomEventType/);
    assert.match(dashboardSource, /handleIncomingEvent\(source, encodedEvent, meta = \{\}\)/);
});

test("authenticated workspace view does not open protected HTTP EventSource directly", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('\n    startWorkspaceEvents()');
    const method = source.slice(startIndex, source.indexOf('\n    stopWorkspaceEvents()', startIndex));
    assert.doesNotMatch(method, /new EventSource/);
    assert.doesNotMatch(method, /services\/webmeet/);
    assert.doesNotMatch(method, /this\.stopWorkspaceEvents\(\);\s*return;/);
    assert.match(method, /this\.runTool\('webmeet_room_events_list'/);
    assert.match(method, /roomId: workspaceId/);
});

test("authenticated workspace meeting creation events refresh the room list", async () => {
    const realtimeSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const eventSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js'
        ),
        'utf8'
    );

    assert.match(eventSource, /MEETING_CREATED\]: ROOM_EVENT_TYPES\.CREATED/);
    assert.match(realtimeSource, /addEventListener\(ROOM_EVENT_TYPES\.CREATED/);
    assert.match(realtimeSource, /source === 'authenticated-workspace'[\s\S]*?this\.scheduleWorkspaceMeetingsRefresh\(\)/);
});

test("browser exit disconnects LiveKit and leaves through the room session without WebMeet HTTP keepalive", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
        ),
        'utf8'
    );
    const presenceSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-presence-controller.js'
        ),
        'utf8'
    );
    const sessionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );

    assert.match(dashboardSource, /cleanupLocalMedia: \(\) => this\.cleanupLocalLiveKitMediaForWindowExit\(\)/);
    assert.match(dashboardSource, /disconnectLiveKit: \(\) => this\.webMeetRoom\.disconnectLiveKit\(\)/);
    assert.match(dashboardSource, /leaveCurrentSession: \(\) => this\.webMeetRoom\.leaveCurrentSession\(\)/);
    assert.match(presenceSource, /window\.addEventListener\('pagehide'/);
    assert.match(presenceSource, /window\.addEventListener\('beforeunload'/);
    assert.match(presenceSource, /this\.cleanupLocalMedia\?\.\(\)/);
    assert.match(presenceSource, /this\.disconnectLiveKit\?\.\(\)/);
    assert.match(presenceSource, /this\.leaveCurrentSession\?\.\(/);
    assert.match(sessionSource, /cleanupLocalLiveKitMediaForWindowExit/);
    assert.match(sessionSource, /publication\?\.track\?\.stop\?\.\(\)/);
    assert.match(sessionSource, /publication\?\.track\?\.mediaStreamTrack\?\.stop\?\.\(\)/);
    assert.doesNotMatch(dashboardSource, /buildLeaveRequest:/);
    assert.doesNotMatch(presenceSource, /sendBeacon|keepalive|guest-leave|\/leave/);
});

test("LiveKit data channel applies participant avatar changes without snapshot resync overwrite", async () => {
    const roomSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    assert.match(roomSource, /emitWebMeetInternalEvent\('livekit', text/);
    assert.match(dashboardSource, /source === 'livekit' && parsed/);
    assert.match(dashboardSource, /this\.applyRealtimeParticipantAvatar\?\.\(payload \|\| parsed\.payload\)/);
    const livekitAvatarBranch = dashboardSource.slice(
        dashboardSource.indexOf("source === 'livekit' && parsed"),
        dashboardSource.indexOf('\n            if (source ===', dashboardSource.indexOf("source === 'livekit' && parsed"))
    );
    assert.doesNotMatch(livekitAvatarBranch, /syncParticipantsFromRoom/);
});

test("LiveKit data channel publishes reliable payloads with current client API", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js'
        ),
        'utf8'
    );
    const method = dashboardSource.slice(
        dashboardSource.indexOf('async publishRealtimePayload'),
        dashboardSource.indexOf('\n    emitNormalizedIncomingEvent', dashboardSource.indexOf('async publishRealtimePayload'))
    );

    assert.match(method, /const encodedEvent = this\.buildRealtimeEvent\(eventType, payload\)/);
    assert.match(method, /publishRealtimeToTransport\(encodedEvent\)/);
    assert.doesNotMatch(method, /DataPacket_Kind/);
});

test("LiveKit transport publishes encoded realtime events without double JSON encoding", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
        ),
        'utf8'
    );
    const transport = source.slice(
        source.indexOf('publishRealtimePayload: (payload) => {'),
        source.indexOf('getCurrentActorId:', source.indexOf('publishRealtimePayload: (payload) => {'))
    );
    assert.match(transport, /room\.publishData\(encoder\.encode\(payload\), \{ reliable: true \}\)/);
    assert.doesNotMatch(transport, /JSON\.stringify\(payload\)/);
});

test("LiveKit avatar updates are applied without reloading stale meeting details", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const livekitAvatarBranch = dashboardSource.slice(
        dashboardSource.indexOf("source === 'livekit' && parsed"),
        dashboardSource.indexOf('\n            if (source ===', dashboardSource.indexOf("source === 'livekit' && parsed"))
    );

    assert.match(livekitAvatarBranch, /this\.applyRealtimeParticipantAvatar\?\.\(payload \|\| parsed\.payload\)/);
    assert.doesNotMatch(livekitAvatarBranch, /loadMeetingDetails/);
});

test("LiveKit participant connection republishes local avatar state for late joiners without meeting refresh", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );
    const participantConnected = source.slice(
        source.indexOf('onParticipantConnected:'),
        source.indexOf('onParticipantDisconnected:', source.indexOf('onParticipantConnected:'))
    );
    assert.match(participantConnected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
    assert.match(participantConnected, /this\.webMeetRoom\.republishAvatarProjection\(\)\.catch/);
    assert.match(participantConnected, /this\.webMeetRoom\.requestAvatarState\(\)\.catch/);
    assert.doesNotMatch(participantConnected, /loadMeetingDetails/);

    const connected = source.slice(
        source.indexOf('onConnected:'),
        source.indexOf('onConnectError:', source.indexOf('onConnected:'))
    );
    assert.match(connected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
    assert.match(connected, /await this\.webMeetRoom\.republishAvatarProjection\(\)/);
    assert.match(connected, /await this\.webMeetRoom\.requestAvatarState\(\)/);
    assert.doesNotMatch(connected, /loadMeetingDetails/);
    assert.doesNotMatch(connected, /startPresenceHeartbeat/);
    assert.doesNotMatch(connected, /publishCurrentParticipantAvatar\?\.\(\{ force: true \}\)/);
});

test("local participant sync resolves the effective avatar before the first card render", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('syncParticipantsFromRoom(room, Track) {'),
        source.indexOf('\n    isParticipantSpeaking(', source.indexOf('syncParticipantsFromRoom(room, Track) {'))
    );

    assert.match(method, /buildWebMeetAvatarSource\(\{/);
    assert.match(method, /override: this\.state\.webMeetAvatarOverride \|\| null/);
    assert.match(method, /setRoomAvatarFor\(this, localIdentity, initialLocalAvatar\)/);
    assert.ok(
        method.indexOf('buildWebMeetAvatarSource({') < method.indexOf('const items = [{'),
        'local effective avatar must be resolved before local participant items are rendered'
    );
});

test("LiveKit participant attribute changes apply avatar projection before room resync", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-livekit.js'
        ),
        'utf8'
    );
    const roomSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
        ),
        'utf8'
    );

    assert.match(source, /RoomEvent\.ParticipantAttributesChanged/);
    assert.match(source, /hooks\.onParticipantAttributesChanged/);
    assert.match(roomSource, /onParticipantAttributesChanged/);
    assert.match(roomSource, /applyRealtimeParticipantAvatar\?\.\(\{/);
    assert.match(roomSource, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
});

test("participant avatar realtime payload includes sanitized avatar projection", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js'
        ),
        'utf8'
    );
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(source.indexOf('async publishAvatarProjection'), source.indexOf('async republishAvatarProjection'));
    assert.match(method, /type: WEBMEET_EVENT_TYPES\.PARTICIPANT_AVATAR_PROJECTED/);
    assert.match(source, /async publishAvatarProjection/);
    assert.match(source, /async republishAvatarProjection/);
    assert.match(source, /getCurrentPublishedAvatarProjection/);
    assert.match(source, /localParticipant\.setAttributes/);
    assert.match(source, /delete attributeProjection\.runtimeState/);
    assert.match(source, /webmeetProfileAvatar: JSON\.stringify\(attributeProjection\)/);
    assert.match(method, /userId/);
    assert.match(method, /profileAvatar/);
    assert.match(actionSource, /const profileAvatar = avatar && typeof avatar === 'object'/);
});

test("LiveKit avatar republish reuses the current live projection before recomputing profile state", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js'
        ),
        'utf8'
    );
    const currentStateMethod = source.slice(
        source.indexOf('getCurrentPublishedAvatarProjection()'),
        source.indexOf('async publishAvatarProjection', source.indexOf('getCurrentPublishedAvatarProjection()'))
    );
    const republishMethod = source.slice(
        source.indexOf('async republishAvatarProjection'),
        source.indexOf('async requestAvatarState', source.indexOf('async republishAvatarProjection'))
    );
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const joinMethod = actionSource.slice(actionSource.indexOf('async joinMeeting'), actionSource.indexOf('getCurrentAvatarOverrideUserId'));

    assert.match(currentStateMethod, /localParticipant\.attributes/);
    assert.match(currentStateMethod, /getRoomAvatars/);
    assert.doesNotMatch(currentStateMethod, /session\?\.participant\?\.profileAvatar/);
    assert.match(republishMethod, /getCurrentPublishedAvatarProjection/);
    assert.match(republishMethod, /publishAvatarProjection\(/);
    assert.doesNotMatch(republishMethod, /webmeet_participant_avatar_update/);
    assert.match(joinMethod, /try \{\s*await this\.publishCurrentParticipantAvatar\(\{ force: true \}\);\s*\} catch \(error\) \{/);
    assert.doesNotMatch(joinMethod, /initialAvatarState/);
    assert.doesNotMatch(joinMethod, /publishCurrentParticipantAvatar\(\{ force: true,[\s\S]*avatar: initialAvatar/);
});

test("participant avatar publish does not resync the room snapshot", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async publishCurrentParticipantAvatar'),
        source.indexOf('\n    async leaveMeeting', source.indexOf('async publishCurrentParticipantAvatar'))
    );

    assert.match(method, /await this\.webMeetRoom\.publishAvatarProjection\(profileAvatar, sourceAvatar\)/);
    assert.match(method, /this\.applyRealtimeParticipantAvatar\?\.\(/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
});

test("avatar changes outside a connected room are saved without publishing realtime data", async () => {
    let savedAvatar = null;
    let projectedAvatar = null;
    let localAvatar = null;
    const profileAvatar = {
        enabled: true,
        config: {
            agentId: 'profile:local-user',
            emotion: 'happy'
        }
    };
    const sourceAvatar = {
        enabled: true,
        config: profileAvatar.config,
        user: { id: 'local-user' }
    };
    const context = {
        state: {
            selectedMeetingId: 'room-1',
            session: {
                meeting: { id: 'room-1' },
                participantIdentity: 'participant-local'
            }
        },
        room: null,
        currentActor: { id: 'local-user' },
        async resolveCurrentParticipantAvatarProjection() {
            return { avatar: profileAvatar, sourceAvatar };
        },
        webMeetRoom: {
            async publishAvatar(avatar) {
                savedAvatar = avatar;
                return { profileAvatar: avatar };
            },
            async publishAvatarProjection(avatar) {
                projectedAvatar = avatar;
            }
        },
        applyRealtimeParticipantAvatar(payload) {
            localAvatar = payload;
        }
    };

    const result = await meetingActionMethods.publishCurrentParticipantAvatar.call(context, { force: true });

    assert.equal(result, null);
    assert.equal(savedAvatar, profileAvatar);
    assert.equal(projectedAvatar, null);
    assert.equal(localAvatar.meetingId, 'room-1');
    assert.equal(localAvatar.participantId, 'participant-local');
    assert.equal(localAvatar.profileAvatar.enabled, true);
    assert.deepEqual(localAvatar.profileAvatar.config, profileAvatar.config);
});

test("connected avatar publish keeps the effective voice runtime projection", async () => {
    const baseAvatar = {
        enabled: true,
        config: {
            agentId: 'profile:local-user',
            emotion: 'neutral',
            expressionMode: 'audio'
        }
    };
    const effectiveAvatar = {
        ...baseAvatar,
        runtimeState: {
            emotion: 'happy',
            intensity: 0.8,
            speaking: true
        }
    };
    const localApplications = [];
    const context = {
        state: {
            selectedMeetingId: 'room-1',
            session: {
                meeting: { id: 'room-1' },
                participantIdentity: 'participant-local'
            },
            roomAvatarsByParticipantId: {
                'participant-local': effectiveAvatar
            }
        },
        room: { localParticipant: {} },
        currentActor: { id: 'local-user' },
        async resolveCurrentParticipantAvatarProjection() {
            return {
                avatar: baseAvatar,
                sourceAvatar: {
                    enabled: true,
                    config: baseAvatar.config,
                    user: { id: 'local-user' }
                }
            };
        },
        webMeetRoom: {
            async publishAvatar(avatar) {
                return { profileAvatar: avatar };
            },
            async publishAvatarProjection() {
                return effectiveAvatar;
            }
        },
        applyRealtimeParticipantAvatar(payload) {
            localApplications.push(payload);
        }
    };

    const result = await meetingActionMethods.publishCurrentParticipantAvatar.call(context, { force: true });

    assert.deepEqual(result.profileAvatar, effectiveAvatar);
    assert.equal(localApplications.length, 0);
});

test("LiveKit avatar sync requests trigger live republish without backend writes", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const requestBranch = dashboardSource.slice(
        dashboardSource.indexOf("source === 'livekit' && type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST"),
        dashboardSource.indexOf("\n        if ([WEBMEET_EVENT_TYPES.AGENT_DETACHED", dashboardSource.indexOf("source === 'livekit' && type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST"))
    );

    assert.match(requestBranch, /requesterParticipantId/);
    assert.match(requestBranch, /localParticipantId/);
    assert.match(requestBranch, /webMeetRoom\.republishAvatarProjection\(\)\.catch/);
    assert.doesNotMatch(requestBranch, /publishCurrentParticipantAvatar\(/);
    assert.doesNotMatch(requestBranch, /webmeet_participant_avatar_update/);
});

test("profile avatar workspace events only refresh and republish current user room avatar projection", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const methodStart = dashboardSource.lastIndexOf('handleProfileAvatarWorkspaceEvent(event)');
    const method = dashboardSource.slice(
        methodStart,
        dashboardSource.indexOf('\n};', methodStart)
    );

    assert.match(method, /userId === currentUserId/);
    assert.match(method, /this\.participantLayoutController\?\.refreshAvatarForUser\?\.\(userId\)/);
    assert.match(method, /this\.publishCurrentParticipantAvatar\(\{ force: true \}\)/);
    assert.match(method, /loadCurrentWebMeetAvatarOverride/);
    assert.match(method, /if \(!currentOverride\)/);
    assert.ok(
        method.indexOf('this.participantLayoutController?.refreshAvatarForUser?.(userId)') > method.indexOf('userId === currentUserId'),
        'remote workspace profile events must not refresh remote participant avatars'
    );
});

test("avatar settings updates republish the joined participant avatar even without a user id in the event", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async handleAvatarSettingsUpdated');
    const method = source.slice(startIndex, source.indexOf('\n    handleProfileAvatarWorkspaceEvent', startIndex));
    assert.doesNotMatch(method, /selectedWorkspaceId/);
    assert.doesNotMatch(method, /if \(!userId\) return/);
    assert.match(method, /this\.state\.session\?\.participantIdentity/);
    assert.match(method, /normalizeAvatarConfig/);
    assert.match(method, /loadCurrentWebMeetAvatarOverride/);
    assert.match(method, /this\.state\.webMeetAvatarOverride = currentOverride/);
    assert.match(method, /applyRealtimeParticipantAvatar/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
    assert.match(method, /webMeetRoom\.publishAvatarProjection/);
    assert.match(method, /publishCurrentParticipantAvatar/);
    assert.match(method, /avatar: effectiveSourceAvatar/);
    assert.match(method, /skipRealtime: true/);
    assert.doesNotMatch(method, /config: event\.detail\.config/);
});

test("avatar settings updates from another logged-in user update the matching remote participant without publishing local state", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async handleAvatarSettingsUpdated');
    const method = source.slice(startIndex, source.indexOf('\n    handleProfileAvatarWorkspaceEvent', startIndex));
    assert.match(method, /eventUserId/);
    assert.match(method, /currentUserId/);
    const remoteBranch = method.slice(
        method.indexOf('eventUserId !== currentUserId'),
        method.indexOf('if (!this.state.session?.participantIdentity)', method.indexOf('eventUserId !== currentUserId'))
    );
    assert.match(remoteBranch, /applyRealtimeParticipantAvatar/);
    assert.match(remoteBranch, /userId: eventUserId/);
    assert.doesNotMatch(remoteBranch, /syncParticipantsFromRoom/);
    assert.doesNotMatch(remoteBranch, /publishCurrentParticipantAvatar/);
});

test("WebMeet avatar override is browser scoped and participates in effective avatar projection", async () => {
    const serviceSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-avatar-override.js'
        ),
        'utf8'
    );
    const meetingActionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );

    assert.match(serviceSource, /STORAGE_PREFIX = 'webmeet\.avatarOverride\.'/);
    assert.match(serviceSource, /window\?\.localStorage\?\.setItem/);
    assert.match(serviceSource, /window\?\.localStorage\?\.removeItem/);
    assert.match(serviceSource, /buildWebMeetAvatarSource/);
    assert.match(serviceSource, /sourceKind === 'fallback' \|\| sourceKind === 'error'/);
    assert.match(serviceSource, /const normalizedConfig = normalizeAvatarConfig\(\{/);
    assert.match(serviceSource, /buildWebMeetAvatarOverrideConfig/);
    assert.match(serviceSource, /\.\.\.baseConfig,[\s\S]*\.\.\.patch/);
    assert.match(meetingActionSource, /resolveCurrentWebMeetAvatarSource/);
    assert.match(meetingActionSource, /buildWebMeetAvatarSource/);
    assert.match(meetingActionSource, /const override = this\.loadCurrentWebMeetAvatarOverride\(\)/);
    // A guest's override is scoped to its own participant identity.
    assert.match(meetingActionSource, /if \(this\.isGuestSession\(\)\) \{[\s\S]*?return participantId \? `guest:\$\{participantId\}` : '';\s*\}/);
    assert.doesNotMatch(meetingActionSource, /this\.state\.webMeetAvatarOverride \|\| this\.loadCurrentWebMeetAvatarOverride\(\)/);
    assert.match(meetingActionSource, /await this\.resolveCurrentWebMeetAvatarSource\(\{[\s\S]*participantId[\s\S]*\}\)/);
    assert.match(meetingActionSource, /await this\.publishCurrentParticipantAvatar\(\{ force: true \}\)/);
    assert.doesNotMatch(meetingActionSource, /initialAvatarState/);
    assert.match(meetingActionSource, /WebMeet avatar override applied and published\./);
    assert.match(meetingActionSource, /WebMeet avatar override saved\. Join a room to publish it\./);
    assert.match(meetingActionSource, /this\.renderParticipantLayout\?\.\(\)/);
    assert.match(meetingActionSource, /this\.renderMeetingList\?\.\(\)/);
    // Source modes are the shared normalized AVATAR_SOURCE_MODES.
    assert.match(meetingActionSource, /AVATAR_SOURCE_MODES,\s*deriveAvatarSourceMode/);
    assert.match(meetingActionSource, /sourceMode: AVATAR_SOURCE_MODES\.PACK/);
    assert.match(serviceSource, /sourceMode/);
});

test("WebMeet quick avatar menu exposes every settings emotion", () => {
    assert.deepEqual(
        WEBMEET_AVATAR_PRESETS.map((preset) => preset.id),
        EMOTIONS
    );
    for (const preset of WEBMEET_AVATAR_PRESETS) {
        assert.deepEqual(Object.keys(preset.patch), ['emotion', 'expressionMode']);
        assert.equal(preset.patch.emotion, preset.id);
        assert.equal(preset.patch.expressionMode, 'manual');
    }
});

test("WebMeet avatar UI exposes settings and quick preset controls", async () => {
    const html = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html'
        ),
        'utf8'
    );
    const modalHtml = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-settings-modal/webmeet-settings-modal.html'
        ),
        'utf8'
    );
    const renderSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js'
        ),
        'utf8'
    );
    const css = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css'
        ),
        'utf8'
    );

    assert.doesNotMatch(modalHtml, /id="webmeetAvatarPresetSelect"/);
    assert.doesNotMatch(modalHtml, /State preset/);
    assert.doesNotMatch(modalHtml, /id="webmeetAvatarOverrideEnabled"/);
    assert.doesNotMatch(html, /id="webmeetMediaSettingsPanel"/);
    assert.match(modalHtml, /id="webmeetSettingsTabMedia"/);
    assert.match(modalHtml, /id="webmeetSettingsTabAvatar"/);
    assert.match(modalHtml, /data-local-action="setSettingsTab"/);
    assert.match(modalHtml, /id="webmeetAudioVideoSettingsTabPanel"/);
    assert.match(modalHtml, /id="webmeetAvatarSettingsTabPanel"/);
    assert.match(modalHtml, /data-settings-tab-panel="avatar" hidden/);
    assert.match(modalHtml, /id="webmeetMediaSettingsPanel" class="webmeet-settings-modal webmeet-media-settings"/);
    assert.match(modalHtml, /id="webmeetMediaSettingsPanel"[\s\S]*class="modal-header"/);
    assert.match(modalHtml, /id="webmeetMediaSettingsPanel"[\s\S]*class="modal-body"/);
    assert.match(modalHtml, /id="webmeetMediaSettingsPanel"[\s\S]*class="modal-footer modal-actions"/);
    assert.match(modalHtml, /data-local-action="closeMediaSettings"/);
    assert.match(modalHtml, /id="webmeetMediaSettingsActions"/);
    assert.match(modalHtml, /id="webmeetAvatarSettingsActions"/);
    assert.match(css, /\.webmeet-settings-section\[hidden\][\s\S]*display: none !important/);
    assert.match(css, /\.webmeet-settings-tabs[\s\S]*border-bottom: 1px solid var\(--border\)/);
    assert.match(css, /\.webmeet-media-settings \.modal-body[\s\S]*overflow: hidden/);
    assert.doesNotMatch(css, /\.webmeet-avatar-settings-fields/);
    assert.doesNotMatch(css, /\.preview-section/);
    assert.doesNotMatch(modalHtml, /webmeet-settings-close-button/);
    assert.doesNotMatch(modalHtml, /class="gray-button" data-local-action="closeMediaSettings"/);
    assert.match(modalHtml, /id="webmeetAvatarSettingsForm"/);
    assert.match(modalHtml, /<avatar-settings-form/);
    assert.doesNotMatch(modalHtml, /id="webmeetAvatarStyle"/);
    assert.doesNotMatch(modalHtml, /id="webmeetAvatarSrc"/);
    assert.doesNotMatch(modalHtml, /id="webmeetAvatarPackSrc"/);
    assert.doesNotMatch(modalHtml, /id="webmeetAvatarPreview"/);
    assert.match(modalHtml, /Reset to profile/);
    assert.match(modalHtml, /data-local-action="applyWebMeetAvatarSettings"/);
    assert.match(modalHtml, /data-local-action="resetWebMeetAvatarOverride"/);
    assert.match(html, /id="webmeetAvatarQuickButton"/);
    assert.match(html, /id="webmeetAvatarQuickMenu"/);
    assert.match(renderSource, /WEBMEET_AVATAR_PRESETS/);
    assert.match(renderSource, /showPreview: true/);
    assert.doesNotMatch(renderSource, /avatarPreviewLoadPromise/);
    assert.match(renderSource, /data-local-action="applyWebMeetAvatarPreset"/);
    assert.match(renderSource, /data-avatar-preset/);
    assert.match(renderSource, /avatarSettingsForm\.webSkelPresenter\.setData/);
    assert.match(renderSource, /sourceModes: \[/);
    assert.match(renderSource, /AVATAR_SOURCE_MODES\.GENERATED/);
    assert.match(renderSource, /AVATAR_SOURCE_MODES\.PACK/);
    assert.match(renderSource, /loadAxiFaceGeneratedFaceStyles/);
    assert.match(renderSource, /loadAxiFaceGeneratedFacePalettes/);
    assert.match(renderSource, /loadAxiFacePacks/);
    assert.match(renderSource, /getLoadedAxiFaceGeneratedFaceStyles/);
    assert.match(renderSource, /formatAvatarOptionLabel/);
    assert.match(renderSource, /hiddenFields: \[[\s\S]*'seed'[\s\S]*'assetMode'[\s\S]*'mode'[\s\S]*'thoughtMode'[\s\S]*'thought'[\s\S]*'animated'[\s\S]*'listen'[\s\S]*'complexity'[\s\S]*'src'[\s\S]*'theme'[\s\S]*\]/);
    assert.doesNotMatch(renderSource, /hiddenFields: \[[\s\S]*'palette'[\s\S]*\]/);
    assert.match(renderSource, /sourceModes: \[[\s\S]*AVATAR_SOURCE_MODES\.GENERATED[\s\S]*AVATAR_SOURCE_MODES\.PACK[\s\S]*\]/);
    assert.doesNotMatch(renderSource, />SVG source<\/button>/);
    assert.doesNotMatch(renderSource, /webmeet-avatar-preview-letter/);
    assert.doesNotMatch(renderSource, /AVATAR_STYLE_LABELS/);
    assert.doesNotMatch(renderSource, /resetWebMeetAvatarOverride">Profile avatar/);
});

test("WebMeet avatar metadata loader does not re-render forever when metadata is unavailable", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
        ),
        'utf8'
    );
    const renderSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js'
        ),
        'utf8'
    );

    assert.match(dashboardSource, /this\.avatarMetadataLoaded = false;/);
    assert.match(dashboardSource, /this\.avatarMetadataLoadFailed = false;/);
    assert.doesNotMatch(dashboardSource, /avatarPreviewRenderKey/);
    assert.doesNotMatch(dashboardSource, /avatarPreviewAxiFaceLoadFailed/);
    assert.doesNotMatch(dashboardSource, /afterRenderBound/);
    assert.match(dashboardSource, /this\.initialDashboardDataLoadStarted = false;/);
    assert.match(dashboardSource, /this\.dashboardReadyDispatched = false;/);
    assert.match(dashboardSource, /this\.initialMediaDevicesRefreshStarted = false;/);
    assert.match(renderSource, /const shouldLoadAvatarMetadata = !this\.avatarMetadataLoaded/);
    assert.match(renderSource, /&& !this\.avatarMetadataLoadFailed/);
    assert.match(renderSource, /&& !this\.avatarMetadataLoadPromise/);
    assert.match(renderSource, /this\.avatarMetadataLoaded = true;/);
    assert.match(renderSource, /this\.avatarMetadataLoadFailed = true;/);
    assert.match(renderSource, /showPreview: true/);
    assert.match(renderSource, /ensureAxiFaceLoaded/);
    assert.match(renderSource, /avatarRuntimeLoadPromise/);
    assert.doesNotMatch(renderSource, /const previewMarkup = renderWebMeetAvatarPreview\(previewConfig\);/);
    assert.doesNotMatch(renderSource, /avatarPreviewAxiFaceLoadFailed/);
});

test("WebMeet settings modal delegates avatar preview layout to the shared component", async () => {
    const mediaSettingsSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/media-settings-methods.js'
        ),
        'utf8'
    );

    assert.doesNotMatch(mediaSettingsSource, /webmeetAvatarPreview/);
    assert.doesNotMatch(mediaSettingsSource, /avatarPreviewRenderKey/);
});

test("Apply avatar closes the WebMeet settings panel after saving", async () => {
    let closeCalls = 0;
    let publishedOptions = null;
    const context = {
        state: {
            webMeetAvatarOverrideDraft: {
                config: {
                    sourceMode: 'generated',
                    style: 'robot-soft',
                    seed: 'profile:current-user'
                }
            },
            webMeetAvatarOverride: null
        },
        syncWebMeetAvatarSettingsDraftFromInputs() {},
        setCurrentWebMeetAvatarOverride(draft) {
            this.state.webMeetAvatarOverride = draft;
        },
        clearCurrentWebMeetAvatarOverride() {
            this.state.webMeetAvatarOverride = null;
        },
        async publishCurrentParticipantAvatar(options) {
            publishedOptions = options;
            return true;
        },
        renderAvatarControls() {},
        renderMeetingSummary() {},
        renderParticipantLayout() {},
        renderMeetingList() {},
        closeMediaSettings() {
            closeCalls += 1;
        },
        setError(message) {
            this.lastError = message;
        }
    };

    await meetingActionMethods.applyWebMeetAvatarSettings.call(context);

    assert.deepEqual(publishedOptions, { force: true });
    assert.equal(closeCalls, 1);
    assert.equal(context.lastError, 'WebMeet avatar override applied and published.');
});

test("WebMeet avatar settings preview renders a generated avatar without saved profile settings", async () => {
    const context = {
        state: {
            webMeetAvatarOverride: null,
            webMeetAvatarOverrideDraft: undefined,
            session: {
                participantIdentity: 'participant-local',
                participant: {}
            },
            axiFaceGeneratedFaceStyles: ['robot-soft'],
            axiFaceGeneratedFacePalettes: ['default'],
            axiFacePacks: [{ id: 'robot-soft', manifestSrc: '/axi-face/packs/robot-soft/manifest.json' }]
        },
        avatarSettingsForm: {
            webSkelPresenter: {
                setData(data) {
                    this.lastData = data;
                }
            }
        },
        loadCurrentWebMeetAvatarOverride() {
            return null;
        },
        getCurrentAvatarOverrideUserId() {
            return 'local:admin';
        }
    };

    dashboardRenderMethods.renderAvatarControls.call(context);

    assert.equal(context.avatarSettingsForm.webSkelPresenter.lastData.showPreview, true);
    assert.equal(context.avatarSettingsForm.webSkelPresenter.lastData.value.agentId, undefined);
});

test("Apply pack switches the quick menu selection to the chosen AxiFace pack", async () => {
    let publishedOptions = null;
    const context = {
        state: {
            session: {
                participantIdentity: 'room:local-user'
            },
            axiFacePacks: [
                {
                    id: 'robot-soft',
                    label: 'Robot Soft',
                    manifestSrc: '/explorer/shared/vendor/axi-face/packs/robot-soft/manifest.json'
                }
            ],
            webMeetAvatarOverride: null,
            webMeetAvatarOverrideDraft: null,
            avatarQuickMenuVisible: true
        },
        loadCurrentWebMeetAvatarOverride() {
            return null;
        },
        getCurrentAvatarOverrideUserId() {
            return 'local-user';
        },
        setCurrentWebMeetAvatarOverride(override) {
            this.state.webMeetAvatarOverride = override;
        },
        async publishCurrentParticipantAvatar(options) {
            publishedOptions = options;
            return true;
        },
        renderAvatarControls() {},
        renderMeetingSummary() {},
        renderParticipantLayout() {},
        renderMeetingList() {},
        setError(message) {
            this.lastError = message;
        }
    };

    await meetingActionMethods.applyWebMeetAvatarPack.call(context, {
        dataset: {
            avatarPackSrc: '/explorer/shared/vendor/axi-face/packs/robot-soft/manifest.json'
        }
    });

    assert.deepEqual(publishedOptions, { force: true });
    assert.equal(context.state.avatarQuickMenuVisible, false);
    assert.equal(context.state.webMeetAvatarOverride.config.sourceMode, 'pack');
    assert.equal(context.state.webMeetAvatarOverride.config.packSrc, '/explorer/shared/vendor/axi-face/packs/robot-soft/manifest.json');
    assert.equal(context.lastError, 'WebMeet avatar pack set to Robot Soft and published.');
});

test("dashboard guest session detection uses the session guest flag", async () => {
    assert.equal(
        dashboardSessionMethods.isGuestSession.call({
            state: {}
        }),
        false
    );
    assert.equal(
        dashboardSessionMethods.isGuestSession.call({
            state: {
                session: {
                    guest: true
                }
            }
        }),
        true
    );
});

test("guest room entry republishes the current avatar override after connecting", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js'
        ),
        'utf8'
    );

    assert.match(source, /async bootstrapGuestRoomEntry\(roomEntry = \{\}\)/);
    assert.match(source, /this\.state\.skipConnectedAvatarRepublishOnce = true;/);
    assert.match(source, /await this\.connectRoom\(\);/);
    assert.match(source, /try \{\s*await this\.publishCurrentParticipantAvatar\(\{ force: true \}\);\s*\} catch \(error\) \{/);
    assert.ok(
        source.indexOf('await this.connectRoom();') < source.indexOf('await this.publishCurrentParticipantAvatar({ force: true });', source.indexOf('async bootstrapGuestRoomEntry')),
        'the guest avatar is republished after the room connects'
    );
});

test("guest avatar override is keyed by participant identity", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const methodStart = source.indexOf('getCurrentAvatarOverrideUserId()');
    const methodEnd = source.indexOf('\n    loadCurrentWebMeetAvatarOverride()', methodStart);
    const methodSource = source.slice(methodStart, methodEnd);

    assert.match(methodSource, /if \(this\.isGuestSession\(\)\)/);
    assert.match(methodSource, /this\.state\.session\?\.participantIdentity/);
    assert.match(methodSource, /`guest:\$\{participantId\}`/);
    assert.doesNotMatch(methodSource, /return '';/);
});

test("guest room entry prepares route state before authenticated room loading", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js'
        ),
        'utf8'
    );
    const routeStateStart = source.indexOf('prepareInitialRouteState()');
    const loadInitialStart = source.indexOf('async loadInitialDashboardData()');
    const guestEntryIndex = source.indexOf('globalThis.__WEBMEET_GUEST_ENTRY__', loadInitialStart);
    const loadMeetingsIndex = source.indexOf('await this.loadMeetings()', loadInitialStart);

    assert.ok(routeStateStart >= 0);
    assert.ok(loadInitialStart > routeStateStart);
    assert.ok(guestEntryIndex > loadInitialStart);
    assert.ok(loadMeetingsIndex > guestEntryIndex);
    assert.doesNotMatch(source, /async bootstrap\(\)/);
    assert.doesNotMatch(source, /loadWorkspaces\(/);
    assert.match(source, /await this\.prepareGuestRoomEntry\(initialRoomId\);/);
    assert.match(source, /async prepareGuestRoomEntry\(roomId\)/);
    // Guest entry is the dedicated modal component; its result bootstraps the room.
    assert.match(source, /showModal\('webmeet-guest-entry-modal'/);
    assert.match(source, /await this\.bootstrapGuestRoomEntry\(\{ roomId: targetRoomId, displayName \}\)/);
    assert.match(source, /function normalizeRoomPayload\(payload = null\)/);
    assert.match(source, /const wrapped = payload\.meeting \|\| payload\.room;/);
    assert.match(source, /const roomId = String\(payload\.roomId \|\| payload\.id \|\| ''\)\.trim\(\);/);
    assert.match(source, /const meeting = normalizeRoomPayload\(details\);/);
    assert.match(source, /runWebMeetTool\('webmeet_room_public_get'/);
    assert.match(source, /runWebMeetTool\('webmeet_room_join_guest'/);
    assert.match(source, /readStoredGuestDisplayName\(\)/);
    assert.match(source, /storeGuestDisplayName\(displayName\)/);
});

test("webmeet dashboard uses the Rooms category without fake workspace state", async () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
        ),
        'utf8'
    );
    const renderSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js'
        ),
        'utf8'
    );
    const dataSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const htmlSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html'
        ),
        'utf8'
    );

    assert.doesNotMatch(dashboardSource, /workspaces:\s*\[/);
    assert.doesNotMatch(dashboardSource, /selectedWorkspaceId:/);
    assert.doesNotMatch(dataSource, /loadWorkspaces\(/);
    assert.doesNotMatch(renderSource, /renderWorkspaceList|state\.workspaces|selectedWorkspaceId/);
    assert.doesNotMatch(htmlSource, /webmeetWorkspaceList|webmeetCurrentWorkspace/);
    assert.match(renderSource, /renderRoomsCategory\(\)/);
    assert.match(renderSource, /WEBMEET_ROOMS_CATEGORY_NAME/);
});

test("authenticated direct room join keeps normal room access and ignores invalid room ids", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js'
        ),
        'utf8'
    );
    const methodStart = source.indexOf('async joinRoomFromExplorerHash(roomId)');
    const methodEnd = source.indexOf('\n    async bootstrapGuestRoomEntry', methodStart);
    const methodSource = source.slice(methodStart, methodEnd);

    assert.ok(methodStart >= 0);
    assert.match(methodSource, /runWebMeetTool\('webmeet_room_get'/);
    assert.doesNotMatch(methodSource, /runWebMeetTool\('webmeet_room_public_get'/);
    assert.match(methodSource, /includeParticipants: false/);
    assert.match(methodSource, /this\.state\.selectedMeetingId = this\.state\.meetings\[0\]\?\.id \|\| '';/);
    assert.match(methodSource, /return;/);
});

test("public guest room lookup is exposed as a dedicated MCP tool", async () => {
    const config = JSON.parse(fs.readFileSync(
        path.resolve(import.meta.dirname, '../../mcp-config.json'),
        'utf8'
    ));
    const toolSource = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../tools/webmeet_tool.mjs'),
        'utf8'
    );
    const storeSource = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../lib/webmeetStore.mjs'),
        'utf8'
    );

    assert.ok(config.tools.some((tool) => tool.name === 'webmeet_room_public_get'));
    assert.match(toolSource, /case 'webmeet_room_public_get':/);
    assert.match(toolSource, /case 'webmeet_room_public_get':[\s\S]*?const roomId = getRequiredString\(args, 'roomId'\);\s*assertPublicRoomInvocation\(authInfo, roomId\);\s*return await getPublicGuestMeeting\(context, roomId\);/);
    assert.match(storeSource, /export async function getPublicGuestMeeting\(context, meetingId\)/);
    assert.match(storeSource, /String\(record\?\.roomType \|\| ''\)\.trim\(\) !== 'guest'/);
});

test("guest room loader stays a bootstrapper while dashboard owns guest entry UI", async () => {
    const loaderSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../static-files/roomLoader.js'
        ),
        'utf8'
    );
    const htmlSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html'
        ),
        'utf8'
    );
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js'
        ),
        'utf8'
    );

    assert.doesNotMatch(loaderSource, /requestGuestDisplayNameFromLoader|__WEBMEET_GUEST_DISPLAY_NAME__/);
    assert.doesNotMatch(loaderSource, /createAgentClient/);
    assert.doesNotMatch(loaderSource, /setTimeout|showStartupTimeoutError|readyStatus|Taking too long|finish\('timeout'\)/);
    assert.match(loaderSource, /function createJsonRpcAgentClient\(agentId\)/);
    assert.match(loaderSource, /headers\.set\('accept', 'application\/json'\)/);
    assert.match(loaderSource, /send\('tools\/call'/);
    assert.match(loaderSource, /function closeStartupLoaders\(\)/);
    assert.match(loaderSource, /dialog\.spinner\.spinner-default-style/);
    assert.match(loaderSource, /closeStartupLoaders\(\);\s*webSkel\.changeToDynamicPage\('webmeet-dashboard', 'webmeet-dashboard'/);
    // The dashboard, not the loader, owns the guest entry UI (a modal component).
    assert.doesNotMatch(htmlSource, /webmeetGuestEntryForm/);
    assert.match(dashboardSource, /showModal\('webmeet-guest-entry-modal'/);
    assert.match(dashboardSource, /prepareGuestRoomEntry\(roomId\)/);
});

test("guest dashboard render registers shared avatar settings for guest avatar editing", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
        ),
        'utf8'
    );
    const beforeRenderStart = source.indexOf('async beforeRender()');
    const beforeRenderEnd = source.indexOf('\n    async afterRender()', beforeRenderStart);
    const beforeRenderSource = source.slice(beforeRenderStart, beforeRenderEnd);
    const afterRenderStart = source.indexOf('async afterRender()');
    const afterRenderEnd = source.indexOf('\n    registerActions()', afterRenderStart);
    const afterRenderSource = source.slice(afterRenderStart, afterRenderEnd);
    const constructorStart = source.indexOf('constructor(element, invalidate, hostContext)');
    const constructorEnd = source.indexOf('\n    _initComponents()', constructorStart);
    const constructorSource = source.slice(constructorStart, constructorEnd);

    assert.doesNotMatch(beforeRenderSource, /ensureAvatarSettingsFormRegistered\(\)/);
    assert.doesNotMatch(afterRenderSource, /ensureAvatarSettingsFormRegistered\(\)/);
    assert.doesNotMatch(constructorSource, /if \(!globalThis\.__WEBMEET_GUEST_ENTRY__\)/);
    assert.match(constructorSource, /ensureAvatarSettingsFormRegistered\(\)/);
});

test("dashboard ready means mounted UI, not completed initial data loading", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
        ),
        'utf8'
    );
    const afterRenderStart = source.indexOf('async afterRender()');
    const afterRenderEnd = source.indexOf('\n    registerActions()', afterRenderStart);
    const afterRenderSource = source.slice(afterRenderStart, afterRenderEnd);
    const readyIndex = afterRenderSource.indexOf("window.dispatchEvent(new CustomEvent('webmeet-dashboard-ready'))");
    const readyFlagIndex = afterRenderSource.indexOf('window.__WEBMEET_DASHBOARD_READY__ = true');
    const loadInitialIndex = afterRenderSource.indexOf('await this.loadInitialDashboardData?.()');
    const scheduleIndex = afterRenderSource.indexOf('window.requestAnimationFrame(loadInitialData)');
    const beforeRenderStart = source.indexOf('async beforeRender()');
    const beforeRenderEnd = source.indexOf('\n    async afterRender()', beforeRenderStart);
    const beforeRenderSource = source.slice(beforeRenderStart, beforeRenderEnd);
    const constructorStart = source.indexOf('constructor(element, invalidate, hostContext)');
    const constructorEnd = source.indexOf('\n    _initComponents()', constructorStart);
    const constructorSource = source.slice(constructorStart, constructorEnd);

    assert.ok(readyFlagIndex >= 0);
    assert.ok(readyIndex >= 0);
    assert.ok(readyIndex > readyFlagIndex);
    assert.ok(loadInitialIndex > readyIndex);
    assert.ok(scheduleIndex > loadInitialIndex);
    assert.doesNotMatch(source, /afterRenderBound/);
    assert.match(constructorSource, /this\.registerActions\(\);/);
    assert.match(constructorSource, /this\.registerWindowPresenceHandlers\(\);/);
    assert.match(constructorSource, /this\.registerMediaDeviceChangeHandler\(\);/);
    assert.match(constructorSource, /this\.element\.addEventListener\('keydown', this\.handleChatInputKeydown\);/);
    assert.match(constructorSource, /this\.element\.addEventListener\('avatar-settings-change', this\.handleWebMeetAvatarSettingsChangeEvent\);/);
    assert.match(afterRenderSource, /if \(!this\.dashboardReadyDispatched\) \{/);
    assert.match(afterRenderSource, /this\.dashboardReadyDispatched = true;/);
    assert.match(afterRenderSource, /if \(!this\.initialDashboardDataLoadStarted\) \{/);
    assert.match(afterRenderSource, /this\.initialDashboardDataLoadStarted = true;/);
    assert.match(afterRenderSource, /if \(!this\.initialMediaDevicesRefreshStarted\) \{/);
    assert.match(afterRenderSource, /this\.initialMediaDevicesRefreshStarted = true;/);
    assert.doesNotMatch(afterRenderSource, /addEventListener\('avatar-settings-change'/);
    assert.match(beforeRenderSource, /this\.prepareInitialRouteState\?\.\(\);/);
    assert.doesNotMatch(beforeRenderSource, /loadInitialDashboardData/);
    assert.match(afterRenderSource, /this\.renderAll\(\);/);
    assert.doesNotMatch(afterRenderSource, /this\.bootstrap\(\)/);
    assert.doesNotMatch(afterRenderSource, /\.finally\(\(\) => \{\s*window\.dispatchEvent\(new CustomEvent\('webmeet-dashboard-ready'\)\);/);
});

test("guest WebMeet avatar runtime avoids protected Explorer imports and uses public AxiFace assets", async () => {
    const participantCardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-participant-card/webmeet-participant-card.js'
        ),
        'utf8'
    );
    const runtimeSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-profile-avatar-runtime.js'
        ),
        'utf8'
    );

    assert.doesNotMatch(participantCardSource, /\/explorer\/services\/profile-avatar-client\.js/);
    assert.match(participantCardSource, /webmeet-profile-avatar-runtime\.js/);
    assert.match(runtimeSource, /isGuestWebMeetContext/);
    assert.match(runtimeSource, /\/explorer\/shared\/vendor\/axi-face/);
    assert.match(runtimeSource, /src\/axi-face\.mjs/);
    assert.doesNotMatch(runtimeSource, /export async function loadAxiFaceModule\(\) \{\s*if \(isGuestWebMeetContext\(\)\) return null;/);
    assert.doesNotMatch(runtimeSource, /export async function loadAxiFacePacks\(\) \{\s*if \(isGuestWebMeetContext\(\)\) return \[\];/);
    assert.doesNotMatch(runtimeSource, /export async function ensureAxiFaceLoaded\(\) \{\s*if \(isGuestWebMeetContext\(\)\) return;/);
    assert.match(runtimeSource, /return globalThis\.__WEBMEET_GUEST_ENTRY__ === true;/);
    assert.doesNotMatch(runtimeSource, /new URLSearchParams\(String\(window\?\.location\?\.search/);
    assert.doesNotMatch(runtimeSource, /params\.get\('roomId'\)/);
    assert.match(runtimeSource, /if \(isGuestWebMeetContext\(\)\) \{\s*return null;\s*\}/);
});

test("participant audio settings use the registered modal API and do not use browser prompts", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/media-settings-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async openParticipantAudioSettings'),
        source.indexOf('\n    }\n};', source.indexOf('async openParticipantAudioSettings'))
    );

    assert.match(method, /globalThis\.assistOS\?\.UI/);
    assert.match(method, /typeof globalThis\.assistOS\.UI\.showModal === 'function'/);
    assert.doesNotMatch(method, /prompt/);
    assert.doesNotMatch(method, /confirm/);
    assert.doesNotMatch(method, /await assistOS\.UI\.showModal/);
});

test('authenticated meeting refresh keeps a just-joined guest until LiveKit exposes the participant', async () => {
    const context = installEdgeJoinFixture(await createStoreContext(tempRoot));
    const workspace = await createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = await createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest pending LiveKit room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const adminSession = await joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-1',
        authInfo: adminAuthInfo
    });
    const guestSession = await joinTestGuest(context, {
        meetingId: meeting.id,
        displayName: 'Guest Pending',
        participantId: 'guest-pending-1'
    });

    setLiveKitParticipants(context, [liveKitParticipant(adminSession.participantIdentity, 'Admin')]);

    const adminDetails = await getMeeting(context, meeting.id, adminAuthInfo);
    // Room agents (RoboTeam) are participants too; the pending guest is what matters here.
    assert.deepEqual(adminDetails.participants.filter((entry) => entry.kind !== 'agent').map((entry) => entry.id).sort(), [
        guestSession.participantIdentity,
        adminSession.participantIdentity
    ].sort());

    const guestDetails = await asTestGuest(context, meeting.id, 'guest-pending-1', () => getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        participantId: guestSession.participantIdentity
    }));

    assert.equal(guestDetails.participants.some((entry) => entry.id === guestSession.participantIdentity), true);
});

test("WebMeet guest links use Explorer roomId entry without the public proxy", async () => {
    const explorerSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../../explorer/main.js'
        ),
        'utf8'
    );

    assert.match(explorerSource, /new URLSearchParams\(window\.location\.search \|\| ''\)\.get\('roomId'\)/);
    assert.match(explorerSource, /pageName = 'webmeet-dashboard'/);
    assert.match(explorerSource, /url = 'webmeet-dashboard'/);
    assert.doesNotMatch(explorerSource, /history\.replaceState\(window\.history\.state, '', `\/explorer\/index\.html/);
    assert.doesNotMatch(explorerSource, new RegExp(`guest${'Token'}`));
    assert.doesNotMatch(explorerSource, new RegExp(`guest${'-plugins'}`));
});

test("WebMeet tools use generic Ploinky MCP, not a room-specific server bridge", async () => {
    const apiClientSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-api-client.js'
        ),
        'utf8'
    );

    assert.match(apiClientSource, /getClient\?\.\(WEBMEET_AGENT_NAME\)/);
    assert.match(apiClientSource, /getWebMeetClient\(\)\.callTool\(toolName, /);
    assert.doesNotMatch(apiClientSource, /getToolBridgeRoomId/);
    assert.doesNotMatch(apiClientSource, /\/rooms\/.*\/tool/);
    assert.doesNotMatch(apiClientSource, new RegExp(`guest${'Token'}|params\\.get\\('token'\\)`));
});

test("legacy guest session manager is removed", async () => {
    const managerPath = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/guest-session-manager.js'
    );
    const indexSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/index.js'
        ),
        'utf8'
    );

    assert.equal(fs.existsSync(managerPath), false);
    assert.doesNotMatch(indexSource, /GuestSessionManager/);
});

test("guest page bootstraps WebMeet dashboard through normal runtime components", async () => {
    const explorerSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../../explorer/main.js'
        ),
        'utf8'
    );

    assert.match(explorerSource, /runtimePluginLoader\.fetchRuntimePlugins\(\)/);
    assert.match(explorerSource, /hasWebMeetRuntimePlugin\(runtimePlugins\)/);
    assert.doesNotMatch(explorerSource, /createRoomEntryRuntimePlugins/);
    assert.doesNotMatch(explorerSource, /\/workspace-files\/\$\{assetRootPath\}/);
    assert.doesNotMatch(explorerSource, /webmeet-guest-webskel/);
    assert.doesNotMatch(explorerSource, /public-services\/webmeet/);
});

test("workspace roster events reload meeting list before fetching meeting details", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async refreshWorkspaceRosterFromEvent');
    const method = source.slice(startIndex, source.indexOf('\n    async refreshMeetingDetailsFromRealtimeEvent', startIndex));
    assert.match(method, /await this\.loadMeetings\(\{[\s\S]*preserveConnectedRoomRoster: true/);
    assert.doesNotMatch(method, /await this\.loadParticipantsForMeetings\(\)/);
});

test("workspace roster refresh batches affected meeting ids", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('scheduleWorkspaceRosterRefresh(meetingId = \'\')'),
        source.indexOf('\n    clearWorkspaceMeetingsRefreshTimer', source.indexOf('scheduleWorkspaceRosterRefresh(meetingId = \'\')'))
    );
    assert.match(method, /this\.pendingWorkspaceRosterRefreshMeetingIds\.add\(normalizedMeetingId\)/);
    assert.match(method, /this\.refreshWorkspaceRosterFromEvent\(rosterMeetingIds\)/);
});

test("workspace roster events for the connected room resync the dashboard from LiveKit", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const helper = source.slice(
        source.indexOf('usesLiveRosterForWorkspaceEvent'),
        source.indexOf('\n\n    bindRoomEventHandlers', source.indexOf('usesLiveRosterForWorkspaceEvent'))
    );
    const joinedHandler = source.slice(
        source.indexOf('ROOM_EVENT_TYPES.PARTICIPANT_JOINED'),
        source.indexOf('ROOM_EVENT_TYPES.PARTICIPANT_LEFT')
    );
    const leftHandler = source.slice(
        source.indexOf('ROOM_EVENT_TYPES.PARTICIPANT_LEFT'),
        source.indexOf('ROOM_EVENT_TYPES.AVATAR_PROJECTED')
    );

    assert.match(helper, /this\.room \|\| this\.state\.roomState === 'Connected'/);
    assert.match(source, /syncConnectedRoomRosterFromWorkspaceEvent/);
    assert.match(source, /this\.syncParticipantsFromRoom\(this\.room\)/);
    assert.match(joinedHandler, /this\.usesLiveRosterForWorkspaceEvent\(parsed\.payload\)/);
    assert.match(leftHandler, /this\.usesLiveRosterForWorkspaceEvent\(parsed\.payload\)/);
    assert.match(joinedHandler, /this\.syncConnectedRoomRosterFromWorkspaceEvent\(\);\s+return;/);
    assert.match(leftHandler, /this\.syncConnectedRoomRosterFromWorkspaceEvent\(\);\s+return;/);
});

test("meeting detail refresh skips participant snapshots while the room is connected", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async refreshMeetingDetailsFromRealtimeEvent()'),
        source.indexOf('\n    runBestEffortRealtimeRefresh', source.indexOf('async refreshMeetingDetailsFromRealtimeEvent()'))
    );
    assert.match(method, /includeParticipants: false/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
});

test("meeting list refreshes do not require LiveKit participant snapshots", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const loadMeetingsMethod = source.slice(
        source.indexOf('async loadMeetings(options = {})'),
        source.indexOf('\n    async refreshMeetingsFromWorkspaceEvent', source.indexOf('async loadMeetings(options = {})'))
    );
    const loadParticipantsMethod = source.slice(
        source.indexOf('async loadParticipantsForMeetings(options = {})'),
        source.indexOf('\n    async loadMeetingDetails', source.indexOf('async loadParticipantsForMeetings(options = {})'))
    );
    assert.match(loadMeetingsMethod, /includeParticipants: false/);
    assert.match(loadParticipantsMethod, /includeParticipants: true/);
    assert.match(loadParticipantsMethod, /preserveConnectedRoomRoster/);
    assert.match(loadParticipantsMethod, /nextMap\[meeting\.id\] = connectedRoster/);
});

test("dashboard live roster sync preserves mic state when Track is unavailable", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('syncParticipantsFromRoom(room, Track)'),
        source.indexOf('\n\n    isParticipantSpeaking', source.indexOf('syncParticipantsFromRoom(room, Track)'))
    );
    assert.match(method, /view\.micOn = Track\s*\?\s*this\.isParticipantMicOn\(sourceParticipant, Track\)\s*:\s*Boolean\(view\.micOn\)/);
});

test("targeted roster refresh reuses cached non-target room rosters", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async loadParticipantsForMeetings(options = {})'),
        source.indexOf('\n    async loadMeetingDetails', source.indexOf('async loadParticipantsForMeetings(options = {})'))
    );
    assert.match(method, /const rosterMeetingIds = Array\.isArray\(options\.rosterMeetingIds\)/);
    assert.match(method, /if \(!shouldRefreshMeeting && hasCachedRoster\) \{/);
    assert.match(method, /if \(result\.status === 'fulfilled' && result\.value === null && previousRoster\.length\) \{/);
});

test("meeting_get requests go through the dashboard snapshot cache", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    assert.match(source, /async fetchMeetingSnapshot\(meetingId, options = \{\}\)/);
    assert.match(source, /this\.fetchMeetingSnapshot\(meetingId, \{\s*includeParticipants: true,/);
    assert.match(source, /this\.fetchMeetingSnapshot\(meeting\.id, \{ includeParticipants \}\)/);
});

test("missing meeting ids are removed from local roster state", async () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async loadParticipantsForMeetings');
    const method = source.slice(startIndex, source.indexOf('\n    async loadMeetingDetails', startIndex));
    assert.match(method, /missingMeetingIds/);
    assert.match(method, /isMissingMeetingError\(result\.reason\)/);
    assert.match(method, /this\.state\.meetings = meetings\.filter/);
});

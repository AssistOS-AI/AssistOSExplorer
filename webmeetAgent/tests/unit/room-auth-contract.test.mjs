import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseWebMeetEvent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import { PRINCIPALS, delegatedUserAuth, directUserAuth } from './verified-grant-fixture.mjs';
import {
    createGuestParticipantAuth,
    withGuestParticipantOwner
} from './participant-owner-fixture.mjs';

const ADMIN_AUTH = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
const USER_AUTH = { user: { id: 'local:user', username: 'user', roles: ['user'] } };
const GUEST_AUTH = { user: { id: 'guest:test', username: 'guest', roles: ['guest'] } };

test('WebMeet room list is dashboard-only and guest join is public-room-only', async () => {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-auth-contract-'));
    try {
        process.env.WEBMEET_DATA_DIR = root;
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const {
            createMeeting,
            createStoreContext,
            joinGuestMeeting,
            listMeetings
        } = await import('../../lib/webmeetStore.mjs');
        const context = installEdgeJoinFixture(await createStoreContext(root));
        const teamRoom = await createMeeting(context, { title: 'Team room', roomType: 'team', authInfo: ADMIN_AUTH });
        const publicRoom = await createMeeting(context, { title: 'Public room', roomType: 'guest', authInfo: ADMIN_AUTH });

        // Listing is decided on the verified signed actor; an unsigned user
        // object grants no directory access.
        assert.deepEqual(await listMeetings(context, '', USER_AUTH), []);
        const userRooms = await listMeetings(context, '', await directUserAuth(PRINCIPALS.explorerUser));
        assert.deepEqual(userRooms.map((entry) => entry.id).sort(), [publicRoom.id, teamRoom.id].sort());

        await assert.rejects(
            () => listMeetings(context, '', GUEST_AUTH),
            /sign in to view WebMeet rooms/
        );
        await assert.rejects(
            () => withGuestParticipantOwner(context, teamRoom.id, () => (
                joinGuestMeeting(context, { meetingId: teamRoom.id, displayName: 'Guest' })
            ), 'team-room-guest'),
            /does not support guest access/
        );
        const joined = await withGuestParticipantOwner(context, publicRoom.id, () => (
            joinGuestMeeting(context, { meetingId: publicRoom.id, displayName: 'Guest' })
        ), 'public-room-guest');
        assert.equal(joined.meeting.id, publicRoom.id);
        assert.equal(joined.participant.guest, true);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.WEBMEET_DATA_DIR;
        } else {
            process.env.WEBMEET_DATA_DIR = previousDataDir;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        } else {
            process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        }
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
});

test('public room scoped invocation can publish guest participant avatar through the shared avatar tool', async () => {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-avatar-auth-contract-'));
    try {
        process.env.WEBMEET_DATA_DIR = root;
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const {
            createMeeting,
            createStoreContext,
            joinGuestMeeting
        } = await import('../../lib/webmeetStore.mjs');
        const { dispatch } = await import('../../tools/webmeet_tool.mjs');
        const context = installEdgeJoinFixture(await createStoreContext(root));
        const publicRoom = await createMeeting(context, {
            title: 'Public avatar room',
            roomType: 'guest',
            authInfo: ADMIN_AUTH
        });
        const joined = await withGuestParticipantOwner(context, publicRoom.id, () => (
            joinGuestMeeting(context, {
                meetingId: publicRoom.id,
                displayName: 'Guest Avatar',
                participantId: 'guest-avatar-participant'
            })
        ), 'avatar-guest');
        const guestAuth = createGuestParticipantAuth(publicRoom.id, 'avatar-guest');

        const updated = await dispatch('webmeet_participant_avatar_update', {
            roomId: publicRoom.id,
            participantId: joined.participantIdentity,
            avatar: {
                enabled: true,
                fallbackLetter: 'G',
                config: {
                    generated: true,
                    emotion: 'happy',
                    seed: 'guest-avatar-participant'
                }
            }
        }, context, guestAuth);

        assert.equal(updated.ok, true);
        assert.equal(updated.participantId, joined.participantIdentity);
        assert.equal(updated.profileAvatar.enabled, true);
        assert.equal(updated.profileAvatar.config.emotion, 'happy');
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.WEBMEET_DATA_DIR;
        } else {
            process.env.WEBMEET_DATA_DIR = previousDataDir;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        } else {
            process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        }
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
});

async function withListingFixture(callback) {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-listing-contract-'));
    try {
        process.env.WEBMEET_DATA_DIR = root;
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const store = await import('../../lib/webmeetStore.mjs');
        const { dispatch } = await import('../../tools/webmeet_tool.mjs');
        const context = installEdgeJoinFixture(await store.createStoreContext(root));
        // Task-owned rooms: a team room, a guest room and an archived room, so an
        // empty store cannot satisfy the filtered-listing assertions.
        const teamRoom = await store.createMeeting(context, { title: 'Listing team room', roomType: 'team', authInfo: ADMIN_AUTH });
        const guestRoom = await store.createMeeting(context, { title: 'Listing guest room', roomType: 'guest', authInfo: ADMIN_AUTH });
        const archivedRoom = await store.createMeeting(context, { title: 'Listing archived room', roomType: 'team', authInfo: ADMIN_AUTH });
        await store.updateMeetingTitle(context, { meetingId: teamRoom.id, title: 'Listing team room renamed', authInfo: ADMIN_AUTH });
        await store.archiveMeeting({ ...context, listLiveKitParticipants: async () => [], closeLiveKitRoom: async () => ({ ok: true }) }, archivedRoom.id, ADMIN_AUTH);
        await callback({ store, dispatch, context, teamRoom, guestRoom, archivedRoom });
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
}

const listIds = (result) => result.rooms.map((room) => room.id).sort();

test('webmeet_room_list follows the verified listing entitlement matrix', async () => {
    await withListingFixture(async ({ dispatch, context, teamRoom, guestRoom, archivedRoom }) => {
        const list = async (authInfo) => dispatch('webmeet_room_list', {}, context, authInfo);
        // Positive controls: the store is non-empty and the fixture grants verify.
        const admin = await list(await directUserAuth({ ...PRINCIPALS.admin, capabilities: [] }));
        assert.deepEqual(listIds(admin), [teamRoom.id, guestRoom.id, archivedRoom.id].sort());
        assert.equal(admin.canManageRooms, true);
        const spacedAdmin = await list(await directUserAuth({ id: 'owner-3', roles: [' Admin '], capabilities: [] }));
        assert.equal(spacedAdmin.canManageRooms, true);
        const member = await list(await directUserAuth(PRINCIPALS.explorerUser));
        assert.deepEqual(listIds(member), [teamRoom.id, guestRoom.id].sort(), 'open rooms only');
        assert.equal(member.canManageRooms, false);
        assert.deepEqual(member.rooms.find((room) => room.id === teamRoom.id), {
            id: teamRoom.id, roomId: teamRoom.id, name: 'Listing team room renamed', title: 'Listing team room renamed',
            roomType: 'team', roomName: teamRoom.roomName, status: teamRoom.status,
            createdAt: teamRoom.createdAt, updatedAt: member.rooms.find((room) => room.id === teamRoom.id).updatedAt, archivedAt: null,
        }, 'listing projects only the room view allowlist');

        for (const [name, authInfo] of [
            ['selfRegistered', await directUserAuth(PRINCIPALS.selfRegistered)],
            ['non-admin named admin', await directUserAuth(PRINCIPALS.namedAdmin)],
            ['delegated admin with capability', await delegatedUserAuth({ agentId: 'agent:AchillesIDE/explorer', user: { id: 'owner-1', username: 'owner', roles: ['admin'], capabilities: ['explorer.access'] } })],
            ['unsigned admin', ADMIN_AUTH],
            ['unsigned capability', { user: { id: 'member-1', username: 'member', roles: ['user'] }, capabilities: ['explorer.access'] }],
        ]) {
            const result = await list(authInfo);
            assert.deepEqual(result, { rooms: [], canManageRooms: false }, name);
        }
        for (const authInfo of [await directUserAuth(PRINCIPALS.adminGuest), await directUserAuth({ id: 'guest-2', roles: ['GUEST'], capabilities: ['explorer.access'] })]) {
            await assert.rejects(() => list(authInfo), /Access denied/);
        }
        // Signed room scopes still restrict an entitled user.
        const scoped = await list(await directUserAuth({ ...PRINCIPALS.explorerUser, scope: [`webmeet:room:${teamRoom.id}`] }));
        assert.deepEqual(listIds(scoped), [teamRoom.id]);
        for (const prefix of ['webmeet:room:', 'public:webmeet:room:']) {
            const scopedAdmin = await directUserAuth({ ...PRINCIPALS.admin, scope: [`${prefix}${teamRoom.id}`] });
            assert.deepEqual(listIds(await list(scopedAdmin)), [teamRoom.id]);
            const archivedAdmin = await directUserAuth({ ...PRINCIPALS.admin, scope: [`${prefix}${archivedRoom.id}`] });
            assert.deepEqual(listIds(await list(archivedAdmin)), [archivedRoom.id]);
        }
    });
});

test('the workspace room feed requires verified listing entitlement and a plain workspace id', async () => {
    await withListingFixture(async ({ store, dispatch, context, teamRoom, archivedRoom }) => {
        const feed = async (authInfo, roomId = 'rooms') => dispatch('webmeet_room_events_list', { roomId }, context, authInfo);
        const memberAuth = await directUserAuth({ ...PRINCIPALS.explorerUser, tool: 'webmeet_room_events_list' });
        const allowed = await feed(memberAuth);
        assert.ok(allowed.events.length > 0, 'positive control reads the non-empty rooms feed');
        assert.ok(allowed.events.some((event) => parseWebMeetEvent(event)?.payload?.meetingId === teamRoom.id));
        assert.ok((await feed(await directUserAuth({ ...PRINCIPALS.admin, tool: 'webmeet_room_events_list' }))).events.length > 0);

        for (const [name, authInfo] of [
            ['selfRegistered', await directUserAuth({ ...PRINCIPALS.selfRegistered, tool: 'webmeet_room_events_list' })],
            ['non-admin named admin', await directUserAuth({ ...PRINCIPALS.namedAdmin, tool: 'webmeet_room_events_list' })],
            ['unsigned admin', ADMIN_AUTH],
            ['delegated admin', await delegatedUserAuth({ agentId: 'agent:AchillesIDE/explorer', user: { id: 'owner-1', username: 'admin', roles: ['admin'] }, tool: 'webmeet_room_events_list' })],
        ]) {
            await assert.rejects(() => feed(authInfo), /Access denied: Explorer access is required/, name);
        }
        const adminGuestAuth = await directUserAuth({ ...PRINCIPALS.adminGuest, tool: 'webmeet_room_events_list' });
        await assert.rejects(() => feed(adminGuestAuth), /Access denied/);

        // An archived room's own log has events; traversal from the workspace
        // branch must not reach it, even for an entitled user.
        assert.ok((await store.listMeetingEvents(context, archivedRoom.id)).length > 0);
        for (const roomId of [`../${archivedRoom.id}`, `rooms/../../${archivedRoom.id}`, '..', 'rooms/x', '.', 'a b']) {
            await assert.rejects(() => feed(memberAuth, roomId), /Invalid WebMeet workspace id/, roomId);
            await assert.rejects(() => store.listWorkspaceEvents(context, roomId), /Invalid WebMeet workspace id/, `store ${roomId}`);
        }
    });
});

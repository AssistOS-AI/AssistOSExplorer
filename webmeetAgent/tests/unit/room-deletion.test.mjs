import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseWebMeetEvent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { closeLiveKitRoom } from '../../lib/runtime/livekitRuntime.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord,
    mutateRoom
} from '../../lib/store/roomRecords.mjs';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import { PRINCIPALS, directUserAuth } from './verified-grant-fixture.mjs';

const ADMIN_AUTH = { user: { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] } };
const USER_AUTH = { user: { id: 'local:user', username: 'user', roles: ['user'] } };
const GUEST_AUTH = {
    user: { id: 'guest:test', username: 'guest', roles: ['guest'] },
    invocation: { scope: [] }
};

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function createFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-room-deletion-'));
    const previous = {
        dataDir: process.env.WEBMEET_DATA_DIR,
        workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT,
        masterKey: process.env.PLOINKY_WEBMEET_MASTER_KEY,
        livekitApiKey: process.env.LIVEKIT_API_KEY,
        livekitApiSecret: process.env.LIVEKIT_API_SECRET
    };
    process.env.WEBMEET_DATA_DIR = path.join(root, 'data');
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    process.env.PLOINKY_WEBMEET_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    process.env.LIVEKIT_API_KEY = 'test-livekit-api-key';
    process.env.LIVEKIT_API_SECRET = 'test-livekit-api-secret';

    const store = await import('../../lib/webmeetStore.mjs');
    const context = installEdgeJoinFixture(await store.createStoreContext(root));
    context.scriptaExplorerClient = async (tool, args) => {
        assert.equal(tool, 'scripta_crdt_ensure_folder');
        await fs.mkdir(path.resolve(root, String(args.folderPath || '').replace(/^\/+/, '')), {
            recursive: true
        });
        return { ok: true, folderPath: args.folderPath };
    };

    return {
        root,
        store,
        context,
        async cleanup() {
            if (previous.dataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
            else process.env.WEBMEET_DATA_DIR = previous.dataDir;
            if (previous.workspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
            else process.env.PLOINKY_WORKSPACE_ROOT = previous.workspaceRoot;
            if (previous.masterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
            else process.env.PLOINKY_WEBMEET_MASTER_KEY = previous.masterKey;
            if (previous.livekitApiKey === undefined) delete process.env.LIVEKIT_API_KEY;
            else process.env.LIVEKIT_API_KEY = previous.livekitApiKey;
            if (previous.livekitApiSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
            else process.env.LIVEKIT_API_SECRET = previous.livekitApiSecret;
            await fs.rm(root, { recursive: true, force: true });
        }
    };
}

async function roomWorkspaceDirectory(context, roomId) {
    const record = await loadRoomRecord(context, roomId);
    const payload = decryptRoomPayload(context, record);
    return path.resolve(
        context.workspaceRoot,
        String(payload?.scripta?.folderPath || '').replace(/^\/+/, '')
    );
}

test('administrator permanently deletes the complete WebMeet-owned room record set', async () => {
    const fixture = await createFixture();
    try {
        const { context, store } = fixture;
        const room = await store.createMeeting(context, {
            title: 'Delete all room data',
            roomType: 'team',
            authInfo: ADMIN_AUTH
        });
        const unrelatedRoom = await store.createMeeting(context, {
            title: 'Preserve unrelated room',
            roomType: 'team',
            authInfo: ADMIN_AUTH
        });
        await store.joinMeeting(context, {
            meetingId: room.id,
            displayName: 'Administrator',
            participantId: 'participant-admin',
            authInfo: ADMIN_AUTH
        });
        await store.appendMeetingChat(context, {
            meetingId: room.id,
            authorId: 'local:admin',
            authorName: 'Administrator',
            message: 'Delete this history',
            authInfo: ADMIN_AUTH
        });
        const upload = await store.authorizeResourceUpload(context, {
            roomId: room.id,
            filename: 'room-data.txt',
            mimeType: 'text/plain',
            size: 9,
            authInfo: ADMIN_AUTH
        });
        await fs.mkdir(path.dirname(upload.storagePath), { recursive: true });
        await fs.writeFile(upload.storagePath, 'room data');
        await store.commitResourceUpload(context, {
            ...upload,
            authInfo: ADMIN_AUTH
        });

        const before = await store.getMeeting(context, room.id, ADMIN_AUTH, { includeParticipants: false });
        const beforeChat = await store.listMeetingChat(context, room.id, ADMIN_AUTH);
        const beforeResources = await store.listRoomResources(context, room.id, ADMIN_AUTH);
        assert.equal(beforeChat.length, 1);
        assert.equal(
            before.participants.some((participant) => participant.id === 'participant-admin'),
            true
        );
        assert.ok(before.agents.length >= 1);
        assert.equal(beforeResources.resources.length, 1);

        const roomFile = path.join(context.meetingsDir, `${room.id}.json`);
        const roomEventsDir = path.join(context.eventsDir, room.id);
        const roomResourcesDir = path.join(context.resourcesDir, room.id);
        const roomWorkspaceDir = await roomWorkspaceDirectory(context, room.id);
        const unrelatedWorkspaceDir = await roomWorkspaceDirectory(context, unrelatedRoom.id);
        const liveKitCalls = [];
        // The listing assertion after deletion is meaningful only if the same
        // verified administrator listed the room before deletion.
        const listingAdmin = await directUserAuth(PRINCIPALS.admin);
        assert.equal((await store.listMeetings(context, '', listingAdmin)).some((entry) => entry.id === room.id), true);
        const deletingContext = {
            ...context,
            closeLiveKitRoom: async (roomName) => {
                assert.equal(await pathExists(roomFile), true, 'LiveKit invalidation must precede durable deletion');
                liveKitCalls.push(roomName);
                return { ok: true };
            }
        };

        const deleted = await store.deleteMeeting(deletingContext, {
            meetingId: room.id,
            confirmed: true,
            authInfo: ADMIN_AUTH
        });

        assert.deepEqual(liveKitCalls, [room.roomName]);
        assert.deepEqual(deleted, {
            ok: true,
            deleted: true,
            roomId: room.id
        });
        assert.equal(await pathExists(roomFile), false);
        assert.equal(await pathExists(roomEventsDir), false);
        assert.equal(await pathExists(roomResourcesDir), false);
        assert.equal(await pathExists(roomWorkspaceDir), false);
        assert.equal(await pathExists(unrelatedWorkspaceDir), true);
        assert.deepEqual(await fs.readdir(context.deletionsDir), []);
        assert.equal((await store.listMeetings(context, '', listingAdmin)).some((entry) => entry.id === room.id), false);
        await assert.rejects(
            () => store.getMeeting(context, room.id, ADMIN_AUTH),
            /Meeting not found/
        );

        const workspaceEvents = await store.listWorkspaceEvents(context, 'rooms');
        const parsedWorkspaceEvents = workspaceEvents.map(parseWebMeetEvent);
        assert.equal(
            parsedWorkspaceEvents.some((event) => event.payload.meetingId === room.id),
            false,
            'workspace event history must not retain the deleted room'
        );
        assert.equal(
            parsedWorkspaceEvents.some((event) => event.payload.meetingId === unrelatedRoom.id),
            true,
            'deleting one room must preserve unrelated workspace history'
        );
    } finally {
        await fixture.cleanup();
    }
});

test('non-empty room workspace directory fails closed and rolls staged durable data back', async () => {
    const fixture = await createFixture();
    try {
        const { context, store } = fixture;
        const room = await store.createMeeting(context, {
            title: 'Preserve Explorer content',
            authInfo: ADMIN_AUTH
        });
        const workspaceDirectory = await roomWorkspaceDirectory(context, room.id);
        const explorerDocument = path.join(workspaceDirectory, 'important.md');
        await fs.writeFile(explorerDocument, '# Preserve me\n');
        await store.appendMeetingChat(context, {
            meetingId: room.id,
            authorId: 'local:admin',
            authorName: 'Administrator',
            message: 'Must survive rollback',
            authInfo: ADMIN_AUTH
        });
        const upload = await store.authorizeResourceUpload(context, {
            roomId: room.id,
            filename: 'rollback.txt',
            mimeType: 'text/plain',
            size: 8,
            authInfo: ADMIN_AUTH
        });
        await fs.mkdir(path.dirname(upload.storagePath), { recursive: true });
        await fs.writeFile(upload.storagePath, 'rollback');
        await store.commitResourceUpload(context, {
            ...upload,
            authInfo: ADMIN_AUTH
        });

        await assert.rejects(
            () => store.deleteMeeting({
                ...context,
                closeLiveKitRoom: async () => ({ ok: true })
            }, {
                meetingId: room.id,
                confirmed: true,
                authInfo: ADMIN_AUTH
            }),
            /not empty; Explorer-owned content was preserved/
        );

        assert.equal(await pathExists(path.join(context.meetingsDir, `${room.id}.json`)), true);
        assert.equal(await pathExists(path.join(context.eventsDir, room.id)), true);
        assert.equal(await pathExists(path.join(context.resourcesDir, room.id)), true);
        assert.equal(await fs.readFile(explorerDocument, 'utf8'), '# Preserve me\n');
        assert.equal((await store.listMeetingChat(context, room.id, ADMIN_AUTH)).length, 1);
        assert.equal((await store.listRoomResources(context, room.id, ADMIN_AUTH)).resources.length, 1);
        assert.deepEqual(await fs.readdir(context.deletionsDir), []);
    } finally {
        await fixture.cleanup();
    }
});

test('room workspace cleanup rejects a different room directory and preserves both rooms', async () => {
    const fixture = await createFixture();
    try {
        const { context, store } = fixture;
        const targetRoom = await store.createMeeting(context, {
            title: 'Target room',
            authInfo: ADMIN_AUTH
        });
        const unrelatedRoom = await store.createMeeting(context, {
            title: 'Unrelated room',
            authInfo: ADMIN_AUTH
        });
        const targetWorkspaceDir = await roomWorkspaceDirectory(context, targetRoom.id);
        const unrelatedWorkspaceDir = await roomWorkspaceDirectory(context, unrelatedRoom.id);
        const unrelatedRecord = await loadRoomRecord(context, unrelatedRoom.id);
        const unrelatedPayload = decryptRoomPayload(context, unrelatedRecord);
        await mutateRoom(context, targetRoom.id, (_record, payload) => {
            payload.scripta.folderPath = unrelatedPayload.scripta.folderPath;
        });

        await assert.rejects(
            () => store.deleteMeeting({
                ...context,
                closeLiveKitRoom: async () => ({ ok: true })
            }, {
                meetingId: targetRoom.id,
                confirmed: true,
                authInfo: ADMIN_AUTH
            }),
            /workspace directory identity is invalid/
        );

        assert.equal(await pathExists(path.join(context.meetingsDir, `${targetRoom.id}.json`)), true);
        assert.equal(await pathExists(path.join(context.meetingsDir, `${unrelatedRoom.id}.json`)), true);
        assert.equal(await pathExists(targetWorkspaceDir), true);
        assert.equal(await pathExists(unrelatedWorkspaceDir), true);
        assert.deepEqual(await fs.readdir(context.deletionsDir), []);
    } finally {
        await fixture.cleanup();
    }
});

test('room workspace cleanup rejects a symlink without touching its target', async () => {
    const fixture = await createFixture();
    try {
        const { context, root, store } = fixture;
        const room = await store.createMeeting(context, {
            title: 'Symlink protected room',
            authInfo: ADMIN_AUTH
        });
        const workspaceDirectory = await roomWorkspaceDirectory(context, room.id);
        const unrelatedDirectory = path.join(root, 'unrelated-content');
        const marker = path.join(unrelatedDirectory, 'marker.txt');
        await fs.rm(workspaceDirectory, { recursive: true, force: true });
        await fs.mkdir(unrelatedDirectory, { recursive: true });
        await fs.writeFile(marker, 'untouched');
        await fs.symlink(unrelatedDirectory, workspaceDirectory);

        await assert.rejects(
            () => store.deleteMeeting({
                ...context,
                closeLiveKitRoom: async () => ({ ok: true })
            }, {
                meetingId: room.id,
                confirmed: true,
                authInfo: ADMIN_AUTH
            }),
            /workspace directory identity is invalid/
        );

        assert.equal((await fs.lstat(workspaceDirectory)).isSymbolicLink(), true);
        assert.equal(await fs.readFile(marker, 'utf8'), 'untouched');
        assert.equal(await pathExists(path.join(context.meetingsDir, `${room.id}.json`)), true);
        assert.deepEqual(await fs.readdir(context.deletionsDir), []);
    } finally {
        await fixture.cleanup();
    }
});

test('permanent room deletion rejects missing confirmation, ordinary users, guests, and invalid room ids', async () => {
    const fixture = await createFixture();
    try {
        const { context, store } = fixture;
        const room = await store.createMeeting(context, {
            title: 'Authorization protected room',
            authInfo: ADMIN_AUTH
        });
        let liveKitCalls = 0;
        const deletingContext = {
            ...context,
            closeLiveKitRoom: async () => {
                liveKitCalls += 1;
            }
        };

        await assert.rejects(
            () => store.deleteMeeting(deletingContext, {
                meetingId: room.id,
                confirmed: false,
                authInfo: ADMIN_AUTH
            }),
            /explicit confirmation/
        );
        await assert.rejects(
            () => store.deleteMeeting(deletingContext, {
                meetingId: room.id,
                confirmed: true,
                authInfo: USER_AUTH
            }),
            /only admin/
        );
        await assert.rejects(
            () => store.deleteMeeting(deletingContext, {
                meetingId: room.id,
                confirmed: true,
                authInfo: GUEST_AUTH
            }),
            /only admin/
        );
        await assert.rejects(
            () => store.deleteMeeting(deletingContext, {
                meetingId: '../../rooms',
                confirmed: true,
                authInfo: ADMIN_AUTH
            }),
            /Room not found/
        );

        assert.equal(liveKitCalls, 0);
        assert.equal(await pathExists(path.join(context.meetingsDir, `${room.id}.json`)), true);
    } finally {
        await fixture.cleanup();
    }
});

test('LiveKit invalidation failure leaves the durable room and its history intact', async () => {
    const fixture = await createFixture();
    try {
        const { context, store } = fixture;
        const room = await store.createMeeting(context, {
            title: 'Fail closed room',
            authInfo: ADMIN_AUTH
        });
        await store.appendMeetingChat(context, {
            meetingId: room.id,
            authorId: 'local:admin',
            authorName: 'Administrator',
            message: 'Must survive failed invalidation',
            authInfo: ADMIN_AUTH
        });
        const deletingContext = {
            ...context,
            closeLiveKitRoom: async () => {
                throw new Error('edge route unavailable');
            }
        };

        await assert.rejects(
            () => store.deleteMeeting(deletingContext, {
                meetingId: room.id,
                confirmed: true,
                authInfo: ADMIN_AUTH
            }),
            /edge route unavailable/
        );

        assert.equal(await pathExists(path.join(context.meetingsDir, `${room.id}.json`)), true);
        assert.equal((await store.listMeetingChat(context, room.id, ADMIN_AUTH)).length, 1);
        assert.equal((await store.listMeetingEvents(context, room.id)).length > 0, true);
        assert.equal(await pathExists(await roomWorkspaceDirectory(context, room.id)), true);
    } finally {
        await fixture.cleanup();
    }
});

test('strict LiveKit deletion accepts only a structured missing-room result', async () => {
    const missingRoomError = Object.assign(new Error('room does not exist'), {
        liveKitCode: 'not_found',
        httpStatus: 404
    });
    await assert.doesNotReject(
        () => closeLiveKitRoom({
            closeLiveKitRoom: async () => {
                throw missingRoomError;
            }
        }, 'webmeet-rooms-missing', { strict: true })
    );
    await assert.rejects(
        () => closeLiveKitRoom({
            closeLiveKitRoom: async () => {
                throw Object.assign(new Error('router route not found'), { httpStatus: 404 });
            }
        }, 'webmeet-rooms-missing', { strict: true }),
        /router route not found/
    );
});

test('webmeet_room_delete is an explicit confirmed MCP tool and preserves server-side authorization', async () => {
    const fixture = await createFixture();
    try {
        const config = JSON.parse(await fs.readFile(
            path.resolve(import.meta.dirname, '../../mcp-config.json'),
            'utf8'
        ));
        const tool = config.tools.find((entry) => entry.name === 'webmeet_room_delete');
        assert.ok(tool);
        assert.equal(tool.inputSchema.roomId?.optional, false);
        assert.equal(tool.inputSchema.confirmed?.optional, false);
        assert.equal(tool.inputSchema.confirmed?.type, 'boolean');

        const room = await fixture.store.createMeeting(fixture.context, {
            title: 'Dispatch authorization room',
            authInfo: ADMIN_AUTH
        });
        const { dispatch } = await import('../../tools/webmeet_tool.mjs');
        await assert.rejects(
            () => dispatch('webmeet_room_delete', {
                roomId: room.id,
                confirmed: true
            }, fixture.context, USER_AUTH),
            /only admin/
        );
        assert.equal(await pathExists(path.join(fixture.context.meetingsDir, `${room.id}.json`)), true);

        const dispatchResult = await dispatch('webmeet_room_delete', {
            roomId: room.id,
            confirmed: true
        }, {
            ...fixture.context,
            closeLiveKitRoom: async () => ({ ok: true })
        }, ADMIN_AUTH);
        assert.deepEqual(dispatchResult, {
            ok: true,
            deleted: true,
            roomId: room.id
        });
        assert.equal(await pathExists(path.join(fixture.context.meetingsDir, `${room.id}.json`)), false);
    } finally {
        await fixture.cleanup();
    }
});

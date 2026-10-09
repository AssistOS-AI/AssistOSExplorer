import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { withGuestParticipantOwner } from './participant-owner-fixture.mjs';
import { PRINCIPALS, directUserAuth } from './verified-grant-fixture.mjs';

// Room agent attach/detach are admin-only. The admin check must run before the
// presence cleanup, because that cleanup always rewrites (and re-encrypts) the
// room record and may schedule an empty-room agent detach.
const MASTER_KEY = crypto.randomBytes(32).toString('base64');
const ADMIN_AUTH = { id: 'local:admin', username: 'admin', roles: ['admin'] };

let tmpRoot;
let context;

async function freshContext() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-attach-order-'));
    await fs.mkdir(path.join(dir, '.ploinky'), { recursive: true });
    process.env.PLOINKY_WEBMEET_MASTER_KEY = MASTER_KEY;
    process.env.PLOINKY_WORKSPACE_ROOT = dir;
    process.env.WEBMEET_DATA_DIR = path.join(dir, '.data', 'webmeetAgent', 'data');
    process.env.LIVEKIT_API_KEY = 'test-livekit-api-key';
    process.env.LIVEKIT_API_SECRET = 'test-livekit-api-secret';
    const { createStoreContext } = await import('../../lib/webmeetStore.mjs');
    const storeContext = await createStoreContext(dir);
    // Room creation provisions a Scripta folder through Explorer; keep it local.
    storeContext.scriptaExplorerClient = async (_tool, args) => ({ ok: true, folderPath: args.folderPath });
    storeContext.resolveEdgeJoinMaterial = async () => ({
        livekitUrl: 'wss://router.test/base-agent-additional-server/liveKitServerAgent/7880/',
        rtcConfig: { iceTransportPolicy: 'all', iceServers: [] },
        turnExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        configurationGeneration: 'test-generation',
        publicationGeneration: 1,
    });
    return { dir, context: storeContext };
}

// A guest member keeps the room non-empty, so an admin attach does not schedule
// the empty-room detach timer that would race the admin detach check below.
async function createRoomWithGuestMember(title) {
    const { createMeeting, joinGuestMeeting } = await import('../../lib/webmeetStore.mjs');
    const meeting = await createMeeting(context, { title, roomType: 'guest', authInfo: ADMIN_AUTH });
    await withGuestParticipantOwner(context, meeting.id, () => (
        joinGuestMeeting(context, { meetingId: meeting.id, displayName: 'Order Guest' })
    ), `fixture-${crypto.randomUUID()}`);
    return meeting;
}

async function createEmptyRoom(title) {
    const { createMeeting } = await import('../../lib/webmeetStore.mjs');
    return createMeeting(context, { title, roomType: 'team', authInfo: ADMIN_AUTH });
}

function roomFile(meetingId) {
    return path.join(context.meetingsDir, `${meetingId}.json`);
}

async function roomDigest(meetingId) {
    return crypto.createHash('sha256').update(await fs.readFile(roomFile(meetingId))).digest('hex');
}

async function settle() {
    await new Promise(setImmediate);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise(setImmediate);
}

before(async () => {
    const result = await freshContext();
    tmpRoot = result.dir;
    context = result.context;
});

after(async () => {
    if (tmpRoot) {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
});

describe('room agent attach/detach authorize before presence cleanup', () => {
    for (const [label, createRoom] of [['occupied', createRoomWithGuestMember], ['empty', createEmptyRoom]]) {
        test(`non-admin attach leaves the ${label} room record byte-identical`, async () => {
            const { attachMeetingAgent } = await import('../../lib/webmeetStore.mjs');
            const meeting = await createRoom(`Attach ${label}`);
            await settle();
            const before = await roomDigest(meeting.id);
            const nonAdmin = await directUserAuth(PRINCIPALS.explorerUser);

            await assert.rejects(
                attachMeetingAgent(context, { meetingId: meeting.id, agentType: 'robo_team', mode: 'blackboard_demo', authInfo: nonAdmin }),
                /only admin can manage rooms/
            );
            await settle();

            assert.equal(await roomDigest(meeting.id), before, 'room record bytes changed');
        });

        test(`non-admin detach leaves the ${label} room record byte-identical`, async () => {
            const { detachMeetingAgent } = await import('../../lib/webmeetStore.mjs');
            const meeting = await createRoom(`Detach ${label}`);
            await settle();
            const before = await roomDigest(meeting.id);
            const nonAdmin = await directUserAuth(PRINCIPALS.explorerUser);

            await assert.rejects(
                detachMeetingAgent(context, { meetingId: meeting.id, agentId: 'agent-anything', authInfo: nonAdmin }),
                /only admin can manage rooms/
            );
            await settle();

            assert.equal(await roomDigest(meeting.id), before, 'room record bytes changed');
        });
    }

    test('admin attach and detach still work', async () => {
        const { attachMeetingAgent, detachMeetingAgent } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createRoomWithGuestMember('Admin attach');
        const admin = await directUserAuth(PRINCIPALS.admin);

        const attached = await attachMeetingAgent(context, {
            meetingId: meeting.id,
            agentType: 'robo_team',
            mode: 'blackboard_demo',
            authInfo: admin,
        });
        assert.ok(attached?.id, 'admin attach returns the attached agent');
        assert.equal(attached.status, 'active');

        const detached = await detachMeetingAgent(context, { meetingId: meeting.id, agentId: attached.id, authInfo: admin });
        assert.ok(detached, 'admin detach returns a result');
        await settle();
    });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../../lib/webmeetStore.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import { PRINCIPALS, directUserAuth } from './verified-grant-fixture.mjs';
import { buildWebMeetEvent, parseWebMeetEvent, WEBMEET_EVENT_TYPES as TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

async function fixture(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-feed-'));
    const previous = { WEBMEET_DATA_DIR: process.env.WEBMEET_DATA_DIR, PLOINKY_WEBMEET_MASTER_KEY: process.env.PLOINKY_WEBMEET_MASTER_KEY };
    process.env.WEBMEET_DATA_DIR = root;
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    try {
        const context = installEdgeJoinFixture(await store.createStoreContext(root));
        context.listLiveKitParticipants = async () => [];
        context.closeLiveKitRoom = async () => ({ ok: true });
        const admin = await directUserAuth(PRINCIPALS.admin);
        const member = await directUserAuth(PRINCIPALS.explorerUser);
        const a = await store.createMeeting(context, { title: 'Visible fixture name', authInfo: admin });
        const b = await store.createMeeting(context, { title: 'Hidden fixture name', authInfo: admin });
        await store.updateMeetingTitle(context, { meetingId: b.id, title: 'Hidden renamed fixture', authInfo: admin });
        const feed = (auth = member, afterId = '') => dispatch('webmeet_room_events_list', { roomId: 'rooms', afterId }, context, auth);
        await run({ context, admin, member, a, b, feed });
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('workspace feed uses current directory visibility and preserves visible creation bytes', async () => {
    await fixture(async ({ context, admin, a, b, feed }) => {
        await store.archiveMeeting(context, b.id, admin);
        const raw = await store.listWorkspaceEvents(context, 'rooms');
        const result = await feed();
        const decoded = result.events.map(parseWebMeetEvent);
        const creation = decoded.find((event) => event.type === TYPES.MEETING_CREATED && event.payload.meetingId === a.id);
        assert.equal(creation.payload.meeting.name, 'Visible fixture name');
        assert.equal(creation.payload.roomId, a.id);
        assert.ok(raw.includes(creation.encoded));
        const hidden = raw.map(parseWebMeetEvent).filter((event) => event.payload.meetingId === b.id);
        assert.ok(hidden.some((event) => event.payload.meeting?.status === 'active'));
        for (const old of hidden) {
            const projected = decoded.find((event) => event.id === old.id);
            assert.equal(projected.type, TYPES.WORKSPACE_ROOMS_INVALIDATED);
            assert.deepEqual(projected.payload, { id: old.id, createdAt: old.createdAt, workspaceId: 'rooms' });
        }
        assert.deepEqual(await store.listWorkspaceEvents(context, 'rooms'), raw);
        const administrator = await feed(admin);
        assert.deepEqual(administrator.events, raw);
        for (const prefix of ['webmeet:room:', 'public:webmeet:room:']) {
            const auth = await directUserAuth({ ...PRINCIPALS.admin, scope: [`${prefix}${a.id}`] });
            assert.deepEqual((await feed(auth)).events, result.events);
            await assert.rejects(() => store.getMeeting(context, b.id, auth, { includeParticipants: false }), /Meeting not found/);
            const scopeB = await directUserAuth({ ...PRINCIPALS.explorerUser, scope: [`${prefix}${b.id}`] });
            assert.ok((await feed(scopeB)).events.every((event) => parseWebMeetEvent(event).type === TYPES.WORKSPACE_ROOMS_INVALIDATED));
            const scopeBAdmin = await directUserAuth({ ...PRINCIPALS.admin, scope: [`${prefix}${b.id}`] });
            assert.equal((await store.getMeeting(context, b.id, scopeBAdmin, { includeParticipants: false })).meeting.id, b.id);
            const multi = await directUserAuth({ ...PRINCIPALS.admin, scope: [`${prefix}${a.id}`, `${prefix}${b.id}`] });
            assert.deepEqual((await feed(multi)).events, raw);
        }
        assert.deepEqual(await feed(undefined, result.nextCursor), { events: [], nextCursor: result.nextCursor, cursorReset: false });
        assert.deepEqual(await feed(undefined, 'deleted-cursor'), { events: [], nextCursor: '', cursorReset: true });
        assert.deepEqual(await store.listMeetingEvents(context, a.id, { afterId: 'missing' }), []);
    });
});

test('projection scans current records once, sees an archive committed after the slice, and resets a deleted cursor', async () => {
    await fixture(async ({ context, admin, a, b, feed }) => {
        const originalRead = fs.readFile;
        const originalReaddir = fs.readdir;
        const reads = new Map();
        let archiveBeforeRecords = true;
        fs.readdir = async (...args) => {
            if (args[0] === context.meetingsDir && archiveBeforeRecords) {
                archiveBeforeRecords = false;
                await store.archiveMeeting(context, b.id, admin);
                reads.clear();
            }
            return originalReaddir(...args);
        };
        fs.readFile = async (...args) => {
            if (path.dirname(String(args[0])) === context.meetingsDir) reads.set(String(args[0]), (reads.get(String(args[0])) || 0) + 1);
            return originalRead(...args);
        };
        let result;
        try {
            result = await feed();
            assert.deepEqual([...reads.values()], [1, 1]);
            assert.ok(result.events.map(parseWebMeetEvent).filter((event) => event.type === TYPES.MEETING_CREATED).every((event) => event.payload.meetingId === a.id));
            reads.clear();
            const tail = await feed();
            await feed(undefined, tail.nextCursor);
            assert.deepEqual([...reads.values()], [1, 1], 'empty increments do not scan records');
        } finally {
            fs.readFile = originalRead;
            fs.readdir = originalReaddir;
        }
        const directory = path.join(context.eventsDir, 'workspaces', 'rooms');
        for (const name of await fs.readdir(directory)) {
            const file = path.join(directory, name);
            if (parseWebMeetEvent(await fs.readFile(file, 'utf8')).id === result.nextCursor) await fs.rm(file);
        }
        assert.deepEqual(await feed(undefined, result.nextCursor), { events: [], nextCursor: '', cursorReset: true });
        const recovered = await feed();
        assert.ok(recovered.events.some((event) => parseWebMeetEvent(event).payload.meetingId === a.id));
        await store.updateMeetingTitle(context, { meetingId: a.id, title: 'Visible next change', authInfo: admin });
        assert.ok((await feed(undefined, recovered.nextCursor)).events.some((event) => parseWebMeetEvent(event).payload.title === 'Visible next change'));
    });
});

test('hidden-only increments advance, and current deletion hides surviving history', async () => {
    await fixture(async ({ context, admin, a, b, feed }) => {
        const first = await feed();
        await store.archiveMeeting(context, b.id, admin);
        const increment = await feed(undefined, first.nextCursor);
        assert.ok(increment.events.length);
        assert.ok(increment.events.every((event) => parseWebMeetEvent(event).type === TYPES.WORKSPACE_ROOMS_INVALIDATED));
        assert.notEqual(increment.nextCursor, first.nextCursor);
        await fs.rm(path.join(context.meetingsDir, `${a.id}.json`));
        assert.ok((await feed()).events.every((event) => parseWebMeetEvent(event).type === TYPES.WORKSPACE_ROOMS_INVALIDATED));
    });
});

test('ambiguous identities are hidden; profile projection allowlists fields; malformed logs fail closed', async () => {
    await fixture(async ({ context, a, b, feed }) => {
        const directory = path.join(context.eventsDir, 'workspaces', 'rooms');
        const write = (event) => fs.writeFile(path.join(directory, 'zz-fixture.event'), event);
        for (const extra of [{ roomId: b.id }, { meeting: { id: b.id } }, { meeting: { roomId: b.id } }, { meeting: { meetingId: b.id } }]) {
            await write(buildWebMeetEvent('rooms', TYPES.MEETING_CREATED, { workspaceId: 'rooms', meetingId: a.id, ...extra }));
            assert.equal(parseWebMeetEvent((await feed()).events.at(-1)).type, TYPES.WORKSPACE_ROOMS_INVALIDATED);
        }
        await write(buildWebMeetEvent('rooms', TYPES.PROFILE_AVATAR_UPDATED, { id: 'profile', createdAt: '2026-01-01', workspaceId: 'rooms', userId: 'user-fixture', meetingId: b.id, secret: 'must not escape' }));
        assert.deepEqual(parseWebMeetEvent((await feed()).events.at(-1)).payload, { id: 'profile', createdAt: '2026-01-01', workspaceId: 'rooms', userId: 'user-fixture' });
        await write(buildWebMeetEvent('rooms', TYPES.PROFILE_AVATAR_UPDATED, { workspaceId: 'rooms', userId: { meetingId: b.id } }));
        await assert.rejects(feed, /Invalid WebMeet workspace event/);
        await write(buildWebMeetEvent('other', TYPES.MEETING_CREATED, { workspaceId: 'rooms', meetingId: a.id }));
        await assert.rejects(feed, /Invalid WebMeet workspace event/);
        await write('rooms:unsupported:e30');
        await assert.rejects(feed, /Unsupported WebMeet event type/);
        await assert.rejects(() => store.listWorkspaceEventsForViewer(context, 'rooms'), /Access denied/);
    });
});

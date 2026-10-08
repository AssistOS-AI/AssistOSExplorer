import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listRoomEvents } from '../../lib/store/eventLogs.mjs';
import { appendEventLog } from '../../lib/webmeetQueue.mjs';
import {
    buildWebMeetEvent,
    getWebMeetEventId
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

// Frozen copy of the pre-change listEventLog, used as the oracle.
async function oracleListEventLog(eventsDir, afterId = '') {
    try { await fs.access(eventsDir); } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    const afterEventId = String(afterId || '').trim();
    let foundAfter = !afterEventId;
    const names = await fs.readdir(eventsDir);
    const events = await Promise.all(names
        .filter((name) => name.endsWith('.event'))
        .sort()
        .map(async (name) => {
            try {
                return (await fs.readFile(path.join(eventsDir, name), 'utf8')).trim();
            } catch (_) {
                return null;
            }
        }));
    return events
        .filter(Boolean)
        .filter((event) => {
            const eventId = getWebMeetEventId(event);
            if (!afterEventId) return true;
            if (foundAfter) return true;
            if (eventId === afterEventId) {
                foundAfter = true;
            }
            return false;
        })
        .filter((event) => getWebMeetEventId(event) !== afterEventId);
}

const ROOM = 'room-1';
let scratch;
let context;
let roomDir;

test.beforeEach(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'event-log-cursor-')));
    context = { eventsDir: path.join(scratch, 'events') };
    roomDir = path.join(context.eventsDir, ROOM);
    await fs.mkdir(roomDir, { recursive: true });
});

test.afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
});

function eventFor(id, createdAt, extra = {}) {
    return buildWebMeetEvent(ROOM, 'meeting.renamed', { id, createdAt, meetingId: ROOM, title: `t-${id}`, ...extra });
}

// Same naming as the real writer in webmeetQueue.mjs.
function writerName(createdAt, id) {
    return `${createdAt}-${id}.event`.replaceAll(':', '-');
}

async function writeEvent(id, createdAt, content = eventFor(id, createdAt)) {
    await fs.writeFile(path.join(roomDir, writerName(createdAt, id)), `${content}\n`);
}

async function buildHistory(count, { tieEvery = 0 } = {}) {
    const ids = [];
    for (let index = 0; index < count; index += 1) {
        const id = `event_${String(index).padStart(4, '0')}`;
        const slot = tieEvery ? Math.floor(index / tieEvery) : index;
        const createdAt = new Date(Date.UTC(2026, 9, 8, 0, 0, 0, slot)).toISOString();
        await writeEvent(id, createdAt);
        ids.push(id);
    }
    return ids;
}

async function compareWithOracle(cursors) {
    for (const cursor of cursors) {
        const expected = await oracleListEventLog(roomDir, cursor);
        const actual = await listRoomEvents(context, ROOM, { afterId: cursor });
        assert.deepEqual(actual, expected, `cursor ${JSON.stringify(cursor)}`);
    }
}

for (const count of [0, 1, 10, 100]) {
    test(`matches the oracle for ${count} events with duplicate timestamps`, async () => {
        const ids = await buildHistory(count, { tieEvery: 3 });
        const cursors = ['', '  ', 'not_present', ...ids.filter((_, index) => index % 7 === 0), ...ids.slice(-2)];
        await compareWithOracle(cursors);
    });
}

test('matches the oracle with duplicate cursor IDs, empty files, a non-ISO name and an .event directory', async () => {
    const ids = await buildHistory(10);
    await writeEvent(ids[3], '2026-10-08T00:00:00.500Z');
    await fs.writeFile(path.join(roomDir, writerName('2026-10-08T00:00:00.004Z', 'event_empty')), '');
    await fs.writeFile(path.join(roomDir, 'legacy.event'), `${eventFor('event_legacy', '2026-10-09T00:00:00.000Z')}\n`);
    await fs.mkdir(path.join(roomDir, 'dir.event'));
    await fs.writeFile(path.join(roomDir, 'ignored.txt'), 'not an event');
    await compareWithOracle(['', ...ids, 'event_legacy', 'missing']);
});

test('later malformed file throws for both the oracle and the new code', async () => {
    const ids = await buildHistory(5);
    await fs.writeFile(path.join(roomDir, writerName('2026-10-08T00:00:09.000Z', 'event_bad')), 'garbage\n');
    await assert.rejects(oracleListEventLog(roomDir, ids[1]));
    await assert.rejects(listRoomEvents(context, ROOM, { afterId: ids[1] }));
});

test('missing directory returns an empty list', async () => {
    assert.deepEqual(await listRoomEvents(context, 'nope', { afterId: 'x' }), []);
});

test('real writer output is resolved by the cursor', async () => {
    const previous = process.env.WEBMEET_DATA_DIR;
    const dataDir = path.join(scratch, 'data');
    process.env.WEBMEET_DATA_DIR = dataDir;
    try {
        const ids = [];
        for (let index = 0; index < 5; index += 1) {
            const id = `event_w${index}`;
            ids.push(id);
            await appendEventLog(scratch, ROOM, eventFor(id, new Date(Date.UTC(2026, 9, 8, 1, 0, index)).toISOString()));
        }
        const writerContext = { eventsDir: path.join(dataDir, 'events') };
        const events = await listRoomEvents(writerContext, ROOM, { afterId: ids[1] });
        assert.deepEqual(events.map(getWebMeetEventId), ids.slice(2));
    } finally {
        if (previous === undefined) delete process.env.WEBMEET_DATA_DIR; else process.env.WEBMEET_DATA_DIR = previous;
    }
});

test('divergence: malformed file before the cursor neither throws nor is read', async () => {
    const ids = await buildHistory(5);
    await fs.writeFile(path.join(roomDir, writerName('2026-10-07T00:00:00.000Z', 'event_old_bad')), 'garbage\n');
    await assert.rejects(oracleListEventLog(roomDir, ids[1]));
    const actual = await listRoomEvents(context, ROOM, { afterId: ids[1] });
    assert.deepEqual(actual.map(getWebMeetEventId), ids.slice(2));
});

test('divergence: cursor file listed but unreadable yields later events', async () => {
    const ids = await buildHistory(4);
    await fs.rm(path.join(roomDir, writerName('2026-10-08T00:00:00.001Z', ids[1])));
    await fs.mkdir(path.join(roomDir, writerName('2026-10-08T00:00:00.001Z', ids[1])));
    assert.deepEqual(await oracleListEventLog(roomDir, ids[1]), []);
    const actual = await listRoomEvents(context, ROOM, { afterId: ids[1] });
    assert.deepEqual(actual.map(getWebMeetEventId), ids.slice(2));
});

test('divergence: IDs differing only by colon versus dash are equal', async () => {
    await writeEvent('ev:one', '2026-10-08T00:00:00.000Z');
    await writeEvent('ev:two', '2026-10-08T00:00:00.001Z');
    assert.deepEqual(await oracleListEventLog(roomDir, 'ev-one'), []);
    const actual = await listRoomEvents(context, ROOM, { afterId: 'ev-one' });
    assert.deepEqual(actual.map(getWebMeetEventId), ['ev:two']);
});

test('out of contract: file name ID wins over content ID', async () => {
    await writeEvent('event_a', '2026-10-08T00:00:00.000Z');
    await writeEvent('event_b', '2026-10-08T00:00:00.001Z', eventFor('event_other', '2026-10-08T00:00:00.001Z'));
    await writeEvent('event_c', '2026-10-08T00:00:00.002Z');
    assert.deepEqual((await oracleListEventLog(roomDir, 'event_b')).map(getWebMeetEventId), []);
    const actual = await listRoomEvents(context, ROOM, { afterId: 'event_b' });
    assert.deepEqual(actual.map(getWebMeetEventId), ['event_c']);
});

async function measureReads(operation) {
    const originals = { readFile: fs.readFile, open: fs.open };
    const state = { reads: 0, inFlight: 0, peak: 0 };
    fs.readFile = async (...args) => {
        state.reads += 1;
        state.inFlight += 1;
        state.peak = Math.max(state.peak, state.inFlight);
        try { return await originals.readFile(...args); } finally { state.inFlight -= 1; }
    };
    fs.open = async (...args) => {
        state.reads += 1;
        return await originals.open(...args);
    };
    try {
        await operation();
    } finally {
        fs.readFile = originals.readFile;
        fs.open = originals.open;
    }
    return state;
}

test('read counts at N=100: latest 0, repeated latest 0, unknown 0, after-first N-1, no cursor N', async () => {
    const ids = await buildHistory(100);
    const list = (afterId) => listRoomEvents(context, ROOM, { afterId });
    for (let round = 0; round < 3; round += 1) {
        assert.equal((await measureReads(() => list(ids.at(-1)))).reads, 0, `latest round ${round}`);
    }
    assert.equal((await measureReads(() => list('not_present'))).reads, 0);
    assert.equal((await measureReads(() => list(ids[0]))).reads, 99);
    const full = await measureReads(() => list(''));
    assert.equal(full.reads, 100);
    assert.ok(full.peak > 1, `peak in-flight reads ${full.peak} must exceed 1`);
    assert.ok(full.peak <= 16, `peak in-flight reads ${full.peak} must not exceed 16`);
});

test('results keep index order under bounded concurrency', async () => {
    const ids = await buildHistory(100);
    const actual = await listRoomEvents(context, ROOM, { afterId: '' });
    assert.deepEqual(actual.map(getWebMeetEventId), ids);
});

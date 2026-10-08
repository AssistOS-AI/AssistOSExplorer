import fs from 'node:fs/promises';
import path from 'node:path';

import { appendEventLog, appendWorkspaceEventLog } from '../webmeetQueue.mjs';
import {
    buildWebMeetEvent,
    getWebMeetEventId,
    isPersistentWebMeetEvent,
    isWorkspacePersistentWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

const EVENT_READ_CONCURRENCY = 16;
const EVENT_FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-(.+)\.event$/;

async function readEventFile(eventsDir, name) {
    try {
        return (await fs.readFile(path.join(eventsDir, name), 'utf8')).trim();
    } catch (_) {
        return null;
    }
}

async function readEventFiles(eventsDir, names) {
    const results = new Array(names.length);
    let next = 0;
    const worker = async () => {
        while (next < names.length) {
            const index = next;
            next += 1;
            results[index] = await readEventFile(eventsDir, names[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(EVENT_READ_CONCURRENCY, names.length) }, worker));
    return results;
}

// Writers name files `${createdAt}-${eventId}.event` with ':' replaced by '-',
// so the sorted name carries both the order and the event ID. Names that do not
// follow that shape are resolved by reading and parsing the file.
async function findCursorPosition(eventsDir, names, afterEventId) {
    const key = afterEventId.replaceAll(':', '-');
    for (let index = 0; index < names.length; index += 1) {
        const match = EVENT_FILE_NAME_PATTERN.exec(names[index]);
        if (match) {
            if (match[1] === key) return index;
            continue;
        }
        const encoded = await readEventFile(eventsDir, names[index]);
        if (!encoded) continue;
        try {
            if (getWebMeetEventId(encoded) === afterEventId) return index;
        } catch (_) {
            // A file that cannot be parsed never matches the cursor.
        }
    }
    return -1;
}

async function listEventLog(eventsDir, afterId = '') {
    if (!(await pathExists(eventsDir))) return [];
    const afterEventId = String(afterId || '').trim();
    const names = (await fs.readdir(eventsDir))
        .filter((name) => name.endsWith('.event'))
        .sort();
    let start = 0;
    if (afterEventId) {
        const position = await findCursorPosition(eventsDir, names, afterEventId);
        if (position < 0) return [];
        start = position + 1;
    }
    const events = await readEventFiles(eventsDir, names.slice(start));
    return events
        .filter(Boolean)
        .filter((event) => getWebMeetEventId(event) !== afterEventId);
}

function createRoomEvent(roomId, type, data = {}) {
    return buildWebMeetEvent(roomId, type, {
        ...data,
        meetingId: String(data?.meetingId || roomId || '').trim()
    });
}

export async function recordRoomEvent(context, roomId, type, data = {}) {
    const event = createRoomEvent(roomId, type, data);
    if (!isPersistentWebMeetEvent(type)) {
        throw new Error(`WebMeet event type is not meeting-persistent: ${type}`);
    }
    await appendEventLog(context.workspaceRoot, roomId, event);
    if (isWorkspacePersistentWebMeetEvent(type)) {
        try {
            const record = await context.loadRoomRecord?.(roomId);
            if (record?.workspaceId) {
                const workspaceEvent = buildWebMeetEvent(record.workspaceId, type, {
                    ...data,
                    workspaceId: record.workspaceId
                });
                await appendWorkspaceEventLog(context.workspaceRoot, record.workspaceId, workspaceEvent);
            }
        } catch (_) {
            // Room creation records workspace events after the room file exists.
        }
    }
    return event;
}

export async function recordWorkspaceEvent(context, workspaceId, type, data = {}) {
    const event = buildWebMeetEvent(workspaceId, type, {
        ...data,
        workspaceId: String(data?.workspaceId || workspaceId || '').trim()
    });
    if (!isWorkspacePersistentWebMeetEvent(type)) {
        throw new Error(`WebMeet event type is not workspace-persistent: ${type}`);
    }
    await appendWorkspaceEventLog(context.workspaceRoot, workspaceId, event);
    return event;
}

export async function listRoomEvents(context, roomId, { afterId = '' } = {}) {
    const targetRoomId = String(roomId || '').trim();
    if (!targetRoomId) return [];
    return await listEventLog(path.join(context.eventsDir, targetRoomId), afterId);
}

export async function listWorkspaceEvents(context, workspaceId, { afterId = '' } = {}) {
    const targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) return [];
    return await listEventLog(path.join(context.eventsDir, 'workspaces', targetWorkspaceId), afterId);
}

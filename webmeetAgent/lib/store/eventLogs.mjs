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

async function listEventLog(eventsDir, afterId = '') {
    const afterEventId = String(afterId || '').trim();
    if (!(await pathExists(eventsDir))) return { events: [], cursorFound: !afterEventId };
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
    const selected = events
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
    return { events: selected, cursorFound: foundAfter };
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
    return (await listEventLog(path.join(context.eventsDir, targetRoomId), afterId)).events;
}

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidWorkspaceEventId(workspaceId) {
    return typeof workspaceId === 'string' && WORKSPACE_ID_PATTERN.test(workspaceId);
}

export async function listWorkspaceEvents(context, workspaceId, { afterId = '' } = {}) {
    return (await readWorkspaceEventSlice(context, workspaceId, { afterId })).events;
}

export async function readWorkspaceEventSlice(context, workspaceId, { afterId = '' } = {}) {
    const targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) return { events: [], cursorFound: !afterId };
    // Only plain workspace ids are accepted, and the resolved directory must
    // stay inside the workspace event root; nothing may reach a room's log.
    if (!isValidWorkspaceEventId(targetWorkspaceId)) {
        throw new Error('Invalid WebMeet workspace id.');
    }
    const workspacesRoot = path.resolve(context.eventsDir, 'workspaces');
    const eventsDir = path.resolve(workspacesRoot, targetWorkspaceId);
    if (path.dirname(eventsDir) !== workspacesRoot) {
        throw new Error('Invalid WebMeet workspace id.');
    }
    return await listEventLog(eventsDir, afterId);
}

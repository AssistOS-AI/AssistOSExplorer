import { canListMeetingRecord, isVerifiedListingEntitled } from '../store/accessPolicy.mjs';
import { readWorkspaceEventSlice } from '../store/eventLogs.mjs';
import { listRoomRecords } from '../store/roomRecords.mjs';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    parseWebMeetEvent,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

export async function listWorkspaceEventsForViewer(context, workspaceId, { afterId = '' } = {}, authInfo = null) {
    if (!isVerifiedListingEntitled(authInfo)) {
        throw new Error('Access denied: Explorer access is required.');
    }
    const targetWorkspaceId = String(workspaceId || '').trim();
    const cursor = String(afterId || '').trim();
    const slice = await readWorkspaceEventSlice(context, targetWorkspaceId, { afterId: cursor });
    if (cursor && !slice.cursorFound) {
        return { events: [], nextCursor: '', cursorReset: true };
    }
    if (!slice.events.length) return { events: [], nextCursor: cursor, cursorReset: false };

    // Read current records after the event slice, once per request. Snapshots in
    // old events are never visibility authority, and payloads need no decryption.
    const records = await listRoomRecords(context);
    const visible = new Set(records.filter((record) => canListMeetingRecord(record, authInfo))
        .map((record) => String(record.meetingId || record.roomId || '')));
    let nextCursor = cursor;
    const events = slice.events.map((encoded) => {
        const event = parseWebMeetEvent(encoded);
        const { payload } = event;
        if (!event.workspacePersistent || !event.id || !event.createdAt
            || event.room !== targetWorkspaceId || payload.workspaceId !== targetWorkspaceId) {
            throw new Error('Invalid WebMeet workspace event.');
        }
        nextCursor = event.id;
        const envelope = { id: event.id, createdAt: event.createdAt, workspaceId: targetWorkspaceId };
        if (event.type === WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED) {
            if (typeof payload.userId !== 'string' || !payload.userId.trim()) {
                throw new Error('Invalid WebMeet workspace event.');
            }
            return buildWebMeetEvent(targetWorkspaceId, event.type, { ...envelope, userId: payload.userId });
        }
        const identities = [payload.meetingId];
        if (Object.hasOwn(payload, 'roomId')) identities.push(payload.roomId);
        if (payload.meeting !== undefined) {
            if (!payload.meeting || typeof payload.meeting !== 'object' || Array.isArray(payload.meeting)) {
                identities.push(null);
            } else {
                for (const key of ['id', 'roomId', 'meetingId']) {
                    if (Object.hasOwn(payload.meeting, key)) identities.push(payload.meeting[key]);
                }
            }
        }
        const meetingId = payload.meetingId;
        if (typeof meetingId === 'string' && meetingId && visible.has(meetingId)
            && identities.every((identity) => identity === meetingId)) return encoded;
        return buildWebMeetEvent(targetWorkspaceId, WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED, envelope);
    });
    return { events, nextCursor, cursorReset: false };
}

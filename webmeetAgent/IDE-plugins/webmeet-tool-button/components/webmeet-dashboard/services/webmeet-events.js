const EVENT_PREFIX_SEPARATOR = ':';

function nowIso() {
    return new Date().toISOString();
}

function randomEventId() {
    if (globalThis.crypto?.randomUUID) {
        return `event_${globalThis.crypto.randomUUID()}`;
    }
    return `event_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export const WEBMEET_EVENT_TYPES = Object.freeze({
    WORKSPACE_ROOMS_INVALIDATED: 'workspace.rooms.invalidated',
    MEETING_CREATED: 'meeting.created',
    MEETING_RENAMED: 'meeting.renamed',
    MEETING_ARCHIVED: 'meeting.archived',
    PARTICIPANT_JOINED: 'participant.joined',
    PARTICIPANT_LEFT: 'participant.left',
    PARTICIPANT_TIMED_OUT: 'participant.timed_out',
    PARTICIPANT_AVATAR_PROJECTED: 'participant.avatar.projected',
    PARTICIPANT_AVATAR_REQUEST: 'participant.avatar.request',
    PROFILE_AVATAR_UPDATED: 'profile.avatar.updated',
    CHAT_MESSAGE_CREATED: 'chat.message.created',
    CHAT_MESSAGE_UPDATED: 'chat.message.updated',
    CHAT_REALTIME: 'chat',
    AGENT_DISPATCHED: 'agent.dispatched',
    AGENT_DETACHED: 'agent.detached',
    MEETING_NOTES_SETTINGS_CHANGED: 'meeting_notes.settings_changed',
    MEETING_NOTES_ACTIVITY: 'meeting_notes.activity',
    RESOURCE_CREATED: 'resource.created',
    RESOURCE_REMOVED: 'resource.removed',
    SCRIPTA_CONTEXT_CHANGED: 'scripta.context.changed',
    SCRIPTA_DOCUMENT_CHANGED: 'scripta.document.changed',
    SCRIPTA_VOTE_CHANGED: 'scripta.vote.changed',
    BLACKBOARD_UPDATED: 'blackboard.updated',
    BLACKBOARD_VISIBILITY_CHANGED: 'blackboard.visibility_changed',
    BLACKBOARD_COMMAND_STATUS: 'blackboard.command_status'
});

const EVENT_DEFINITIONS = Object.freeze({
    [WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED]: {
        persistent: false,
        workspacePersistent: false,
        required: ['workspaceId']
    },
    [WEBMEET_EVENT_TYPES.MEETING_CREATED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId']
    },
    [WEBMEET_EVENT_TYPES.MEETING_RENAMED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'title']
    },
    [WEBMEET_EVENT_TYPES.MEETING_ARCHIVED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'archivedAt']
    },
    [WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'participantId']
    },
    [WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'participantId']
    },
    [WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'participantId']
    },
    [WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED]: {
        persistent: false,
        workspacePersistent: false,
        required: ['meetingId', 'participantId', 'profileAvatar']
    },
    [WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST]: {
        persistent: false,
        workspacePersistent: false,
        required: ['meetingId', 'participantId']
    },
    [WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['workspaceId', 'userId']
    },
    [WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'chatMessageId']
    },
    [WEBMEET_EVENT_TYPES.CHAT_MESSAGE_UPDATED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'chatMessageId']
    },
    [WEBMEET_EVENT_TYPES.CHAT_REALTIME]: {
        persistent: false,
        workspacePersistent: false,
        required: ['meetingId', 'message']
    },
    [WEBMEET_EVENT_TYPES.AGENT_DISPATCHED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'agentId', 'agentType', 'mode']
    },
    [WEBMEET_EVENT_TYPES.AGENT_DETACHED]: {
        persistent: true,
        workspacePersistent: true,
        required: ['meetingId', 'agentId']
    },
    [WEBMEET_EVENT_TYPES.MEETING_NOTES_SETTINGS_CHANGED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId']
    },
    [WEBMEET_EVENT_TYPES.MEETING_NOTES_ACTIVITY]: {
        persistent: false,
        workspacePersistent: false,
        required: ['meetingId', 'phase']
    },
    [WEBMEET_EVENT_TYPES.RESOURCE_CREATED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'resourceId']
    },
    [WEBMEET_EVENT_TYPES.RESOURCE_REMOVED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'resourceId']
    },
    [WEBMEET_EVENT_TYPES.SCRIPTA_CONTEXT_CHANGED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'documentId', 'documentRevision']
    },
    [WEBMEET_EVENT_TYPES.SCRIPTA_DOCUMENT_CHANGED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'documentId', 'documentRevision']
    },
    [WEBMEET_EVENT_TYPES.SCRIPTA_VOTE_CHANGED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'documentId', 'documentRevision', 'participantId']
    },
    [WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED]: {
        persistent: true,
        workspacePersistent: false,
        required: ['meetingId', 'blackboardRevision', 'changeType']
    },
    [WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED]: {
        persistent: false,
        workspacePersistent: false,
        required: ['meetingId', 'participantId', 'visible']
    },
    [WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS]: {
        persistent: false,
        workspacePersistent: false,
        required: ['meetingId', 'boardId', 'commandId', 'participantId', 'state']
    }
});

function base64UrlEncode(text) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(text, 'utf8').toString('base64url');
    }
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}

function base64UrlDecode(encoded) {
    const normalized = String(encoded || '').replaceAll('-', '+').replaceAll('_', '/');
    const padded = `${normalized}${'='.repeat((4 - normalized.length % 4) % 4)}`;
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(padded, 'base64').toString('utf8');
    }
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function getWebMeetEventDefinition(type) {
    return EVENT_DEFINITIONS[String(type || '').trim()] || null;
}

export function isPersistentWebMeetEvent(type) {
    return getWebMeetEventDefinition(type)?.persistent === true;
}

export function isWorkspacePersistentWebMeetEvent(type) {
    return getWebMeetEventDefinition(type)?.workspacePersistent === true;
}

export function assertWebMeetEventPayload(type, payload = {}) {
    const eventType = String(type || '').trim();
    const definition = getWebMeetEventDefinition(eventType);
    if (!definition) {
        throw new Error(`Unsupported WebMeet event type: ${eventType}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`Invalid WebMeet event payload for ${eventType}.`);
    }
    for (const field of definition.required || []) {
        if (payload[field] === undefined || payload[field] === null || String(payload[field]).trim() === '') {
            throw new Error(`Missing WebMeet event payload field "${field}" for ${eventType}.`);
        }
    }
    if (eventType === WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS) {
        if (!['started', 'success', 'error'].includes(String(payload.state || ''))) {
            throw new Error('Invalid blackboard command status state.');
        }
        if (String(payload.errorMessage || '').length > 500) {
            throw new Error('Blackboard command status error message is too long.');
        }
    }
    return true;
}

export function buildWebMeetEvent(room, type, payload = {}) {
    const eventRoom = String(room || '').trim();
    const eventType = String(type || '').trim();
    if (!eventRoom || eventRoom.includes(EVENT_PREFIX_SEPARATOR)) {
        throw new Error('Invalid WebMeet event room.');
    }
    assertWebMeetEventPayload(eventType, payload);
    const eventPayload = {
        id: String(payload.id || randomEventId()).trim(),
        createdAt: String(payload.createdAt || nowIso()).trim(),
        ...payload
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(eventPayload));
    return `${eventRoom}${EVENT_PREFIX_SEPARATOR}${eventType}${EVENT_PREFIX_SEPARATOR}${encodedPayload}`;
}

export function parseWebMeetEvent(encodedEvent) {
    const raw = String(encodedEvent || '').trim();
    const firstSeparator = raw.indexOf(EVENT_PREFIX_SEPARATOR);
    const secondSeparator = firstSeparator >= 0 ? raw.indexOf(EVENT_PREFIX_SEPARATOR, firstSeparator + 1) : -1;
    if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) {
        throw new Error('Invalid WebMeet event format.');
    }
    const room = raw.slice(0, firstSeparator);
    const type = raw.slice(firstSeparator + 1, secondSeparator);
    const encodedPayload = raw.slice(secondSeparator + 1);
    if (!room || !type || !encodedPayload) {
        throw new Error('Invalid WebMeet event format.');
    }
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    assertWebMeetEventPayload(type, payload);
    return {
        encoded: raw,
        room,
        type,
        payload,
        id: String(payload.id || '').trim(),
        createdAt: String(payload.createdAt || '').trim(),
        persistent: isPersistentWebMeetEvent(type),
        workspacePersistent: isWorkspacePersistentWebMeetEvent(type)
    };
}

export function getWebMeetEventId(encodedEvent) {
    return parseWebMeetEvent(encodedEvent).id;
}

export function getWebMeetEventCreatedAt(encodedEvent) {
    return parseWebMeetEvent(encodedEvent).createdAt;
}

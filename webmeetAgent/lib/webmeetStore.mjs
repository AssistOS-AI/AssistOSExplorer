import crypto from 'node:crypto';

import { getWorkspacePaths } from './workspacePaths.mjs';
import {
    assertAdminAuthInfo,
    assertAuthenticatedAuthInfo,
    canViewMeetingRecord,
    canListMeetingRecord,
    isAdminAuthInfo,
    isGuestAuthInfo,
    isMeetingRecordOpen,
    isVerifiedListingEntitled,
    normalizeAuthInfo
} from './store/accessPolicy.mjs';
import {
    authorizeResourceDownload as authorizeResourceDownloadImpl,
    authorizeResourceUpload as authorizeResourceUploadImpl,
    commitResourceUpload as commitResourceUploadImpl,
    listRoomResources as listRoomResourcesImpl,
    removeRoomResource as removeRoomResourceImpl
} from './store/roomResources.mjs';
import {
    buildRoomView as buildMeetingView,
    createRoomRecord as createMeetingRecord,
    decryptRoomPayload as decryptMeetingPayload,
    ensureStoreDirs as ensureDirs,
    listRoomRecords,
    loadRoomRecord as loadMeetingRecord,
    mutateRoom as mutateMeeting,
    purgeExpiredRooms as purgeExpiredMeetings,
    deleteRoomRecord as permanentlyDeleteMeetingRecord,
    removeRoomRecord as rollbackMeetingRecord,
    recordWorkspaceEvent
} from './store/roomRecords.mjs';
import {
    listRoomEvents as listMeetingEventsImpl,
    listWorkspaceEvents as listWorkspaceEventsImpl
} from './store/eventLogs.mjs';
import { listWorkspaceEventsForViewer as listWorkspaceEventsForViewerImpl } from './services/workspaceEvents.mjs';
import {
    cleanupRoomPresence as cleanupMeetingPresenceImpl,
    getRoomDetails as getMeetingImpl,
    getGuestRoomDetails as getGuestMeetingDetailsImpl,
    heartbeatRoomPresence as heartbeatMeetingPresenceImpl,
    joinGuestRoom as joinGuestMeetingImpl,
    joinRoom as joinMeetingImpl,
    leaveGuestRoom as leaveGuestMeetingImpl,
    leaveRoom as leaveMeetingImpl,
    listRoomParticipants as listMeetingParticipantsImpl,
    removeRoomParticipant as removeMeetingParticipantImpl,
    updateGuestRoomParticipantAvatar as updateGuestMeetingParticipantAvatarImpl,
    updateRoomParticipantAvatar as updateMeetingParticipantAvatarImpl,
    updateRoomParticipantRole as updateMeetingParticipantRoleImpl
} from './services/roomParticipants.mjs';
import {
    appendGuestRoomChat as appendGuestMeetingChatImpl,
    appendRoomChat as appendMeetingChatImpl,
    listRoomChat as listMeetingChatImpl,
    updateRoomChat as updateMeetingChatImpl
} from './services/roomMessages.mjs';
import {
    archiveRoom as archiveMeetingImpl
} from './services/roomArchive.mjs';
import {
    deleteRoom as deleteMeetingImpl
} from './services/roomDeletion.mjs';
import {
    applyRoomBlackboardChange as applyRoomBlackboardChangeImpl,
    applyRoomBlackboardEvents as applyRoomBlackboardEventsImpl,
    applyRoomBlackboardWorkspaceAction as applyRoomBlackboardWorkspaceActionImpl,
    getRoomBlackboard as getRoomBlackboardImpl,
    getRoomBlackboardForCommand as getRoomBlackboardForCommandImpl,
    publishRoomAttachment as publishRoomAttachmentImpl,
    redoRoomBlackboard as redoRoomBlackboardImpl,
    undoRoomBlackboard as undoRoomBlackboardImpl
} from './blackboard/service.mjs';
import {
    ROBO_TEAM_AGENT_TYPE,
    ROBO_TEAM_MODE,
    ensureRoboTeamAgentPayload,
    getRoboTeamBlackboardRevision,
    ensureRoboTeamDemoBlackboard,
    ensureRoboTeamSettingsPayload,
    getRoboTeamSettings as getRoboTeamSettingsImpl,
    isRoboTeamEnabled,
    normalizeRoboTeamSettings,
    updateRoboTeamSettings as updateRoboTeamSettingsImpl
} from './roboTeam/service.mjs';
import {
    createScriptaDocument as createScriptaDocumentImpl,
    ensureScriptaDocuments as ensureScriptaDocumentsImpl,
    ensureScriptaRoomFolder as ensureScriptaRoomFolderImpl,
    focusScripta as focusScriptaImpl,
    getScriptaContext as getScriptaContextImpl,
    listScriptaWorkspaceEntries as listScriptaWorkspaceEntriesImpl,
    manageScriptaDocument as manageScriptaDocumentImpl,
    mutateScripta as mutateScriptaImpl,
    mergeScriptaDocumentMarkdown as mergeScriptaDocumentMarkdownImpl,
    navigateScripta as navigateScriptaImpl,
    openScriptaDocument as openScriptaDocumentImpl,
    openScriptaCollaboration as openScriptaCollaborationImpl,
    pullScriptaCollaboration as pullScriptaCollaborationImpl,
    applyScriptaCollaboration as applyScriptaCollaborationImpl,
    closeScriptaCollaboration as closeScriptaCollaborationImpl,
    repairScriptaBlackboardProjection as repairScriptaBlackboardProjectionImpl,
    getScriptaRoomFolderPath,
} from './scripta/service.mjs';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
} from '../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { sendLiveKitRoomData } from './runtime/livekitRuntime.mjs';
import { authorizeRoomParticipantId } from './store/participantAuthorization.mjs';
import { scriptaExplorer } from './scripta/explorer-crdt-client.mjs';
import {
    applyMeetingNotesDocument as applyMeetingNotesDocumentImpl,
    finalizeMeetingNotesSession as finalizeMeetingNotesSessionImpl,
    heartbeatMeetingNotesSession as heartbeatMeetingNotesSessionImpl,
    ensureMeetingSecretaryDispatch,
    ensureMeetingNotesWorkspace,
    startMeetingNotesSession as startMeetingNotesSessionImpl,
} from './meetingNotes/service.mjs';

const DEFAULT_ROOM_TITLE = 'General';

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

const roomResourceDeps = {
    loadMeetingRecord,
    decryptMeetingPayload,
    mutateMeeting,
    canViewMeetingRecord
};

function isActiveMeetingAgent(agent) {
    const status = String(agent?.status || '').trim().toLowerCase();
    return Boolean(agent)
        && String(agent.agentType || '').trim() !== ROBO_TEAM_AGENT_TYPE
        && String(agent.agentType || '').trim() !== 'meeting_secretary'
        && !agent.deletedAt
        && status !== 'detached'
        && status !== 'stopped';
}

function cloneJson(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
}

function projectMeetingAgentForViewer(agent = {}) {
    return {
        id: String(agent.id || '').trim(),
        participantIdentity: String(agent.participantIdentity || agent.participant?.identity || '').trim(),
        agentType: String(agent.agentType || '').trim(),
        mode: String(agent.mode || '').trim(),
        agentName: String(agent.agentName || agent.participant?.name || '').trim(),
        runtime: String(agent.runtime || 'ploinky').trim(),
        status: String(agent.status || '').trim(),
        createdAt: String(agent.createdAt || '').trim(),
        updatedAt: String(agent.updatedAt || '').trim(),
        deletedAt: agent.deletedAt || null
    };
}

function hasHumanMeetingMembers(payload) {
    return Array.isArray(payload?.members) && payload.members.length > 0;
}

async function markActiveAgentsDetached(context, meetingId, reason) {
    const detachedAgents = [];
    await mutateMeeting(context, meetingId, (_record, payload, stageEvent) => {
        if (hasHumanMeetingMembers(payload)) return;
        const activeAgents = Array.isArray(payload.agents)
            ? payload.agents.filter(isActiveMeetingAgent)
            : [];
        for (const agent of activeAgents) {
            const detachedAt = nowIso();
            Object.assign(agent, {
                status: 'detached',
                deletedAt: detachedAt,
                updatedAt: detachedAt,
                detachReason: reason
            });
            detachedAgents.push({ ...agent });
            stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DETACHED, {
                meetingId,
                agentId: agent.id || '',
                agentType: agent.agentType || '',
                mode: agent.mode || '',
                reason
            });
        }
    });
    return detachedAgents;
}

async function detachActiveAgentsWhenRoomHasNoHumans(context, meetingId, reason = 'no_human_participants') {
    const payload = decryptMeetingPayload(context, await loadMeetingRecord(context, meetingId));
    if (hasHumanMeetingMembers(payload)) {
        return [];
    }
    if (!Array.isArray(payload.agents) || !payload.agents.some(isActiveMeetingAgent)) {
        return [];
    }
    return await markActiveAgentsDetached(context, meetingId, reason);
}

const participantServiceDeps = {
    randomId,
    detachActiveAgentsWhenRoomHasNoHumans,
    ensureMeetingSecretaryDispatch
};

async function cleanupMeetingPresence(context, meetingId) {
    return await cleanupMeetingPresenceImpl(context, meetingId, participantServiceDeps);
}

const messageServiceDeps = {
    randomId,
    cleanupRoomPresence: cleanupMeetingPresence,
    getRoomDetails: getMeeting
};

const archiveServiceDeps = {
    detachActiveAgentsWhenRoomHasNoHumans
};

const deletionServiceDeps = {
    deleteRoomRecord: permanentlyDeleteMeetingRecord
};

export async function getMeeting(context, meetingId, authInfo = null, options = {}) {
    return await getMeetingImpl(context, meetingId, authInfo, options, participantServiceDeps);
}

export async function getPublicGuestMeeting(context, meetingId) {
    const record = await loadMeetingRecord(context, meetingId);
    if (!isMeetingRecordOpen(record) || String(record?.roomType || '').trim() !== 'guest') {
        throw new Error('Public room not found.');
    }
    return buildMeetingView(record);
}

export async function listMeetingEvents(context, meetingId, { afterId = '' } = {}) {
    return await listMeetingEventsImpl(context, meetingId, { afterId });
}

export async function listWorkspaceEvents(context, workspaceId, { afterId = '' } = {}) {
    return await listWorkspaceEventsImpl(context, workspaceId, { afterId });
}

export async function listWorkspaceEventsForViewer(context, workspaceId, options = {}, authInfo = null) {
    return await listWorkspaceEventsForViewerImpl(context, workspaceId, options, authInfo);
}

export async function getRoomBlackboard(context, { roomId, boardId = '', participantId = '', authInfo = null } = {}) {
    await repairScriptaBlackboardProjectionImpl(context, { roomId, participantId, authInfo });
    return await getRoomBlackboardImpl(context, { roomId, boardId, participantId, authInfo });
}

export async function getRoomBlackboardForCommand(context, { roomId, boardId = '', participantId = '', authInfo = null } = {}) {
    await repairScriptaBlackboardProjectionImpl(context, { roomId, participantId, authInfo });
    return await getRoomBlackboardForCommandImpl(context, { roomId, boardId, participantId, authInfo });
}

export async function applyRoomBlackboardWorkspaceAction(context, input = {}) {
    return await applyRoomBlackboardWorkspaceActionImpl(context, input);
}

export async function authorizeMeetingParticipant(context, {
    roomId,
    participantId = '',
    authInfo = null,
} = {}) {
    let record = await loadMeetingRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Meeting not found.');
    let payload = decryptMeetingPayload(context, record);
    const targetParticipantId = String(participantId || '').trim();
    let participant = (Array.isArray(payload.members) ? payload.members : [])
        .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
    if (!participant) {
        try {
            await getMeetingImpl(context, roomId, authInfo, { includeParticipants: true }, participantServiceDeps);
        } catch (_) {
            // The explicit participant_not_joined error below is stable even
            // when LiveKit reconciliation is temporarily unavailable.
        }
        record = await loadMeetingRecord(context, roomId);
        payload = decryptMeetingPayload(context, record);
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
    }
    if (!participant) {
        const error = new Error('Participant is not joined or is no longer connected to the room.');
        error.code = 'participant_not_joined';
        throw error;
    }
    const authorizedParticipantId = authorizeRoomParticipantId(payload, authInfo, targetParticipantId, record.meetingId);
    const auth = normalizeAuthInfo(authInfo);
    if (isAdminAuthInfo(authInfo)) {
        const memberUserId = String(participant.userId || participant.attributes?.webmeetUserId || '').trim();
        const authenticatedIds = new Set([auth.id, auth.principalId, auth.username, auth.email]
            .map((value) => String(value || '').trim()).filter(Boolean));
        if (!authenticatedIds.has(authorizedParticipantId) && !authenticatedIds.has(memberUserId)) {
            throw new Error('Access denied: cannot act as another participant.');
        }
    }
    await mutateMeeting(context, roomId, (_record, lockedPayload) => {
        const current = (Array.isArray(lockedPayload.members) ? lockedPayload.members : [])
            .find((entry) => String(entry?.id || '').trim() === authorizedParticipantId) || null;
        if (!current) {
            const error = new Error('Participant is not joined or is no longer connected to the room.');
            error.code = 'participant_not_joined';
            throw error;
        }
        current.lastSeenAt = nowIso();
    });
    return {
        participantId: authorizedParticipantId,
    };
}

export async function applyRoomBlackboardChange(context, { roomId, boardId = '', change, participantId = '', authInfo = null } = {}) {
    return await applyRoomBlackboardChangeImpl(context, { roomId, boardId, change, participantId, authInfo });
}

export async function applyRoomBlackboardEvents(context, input = {}) {
    return await applyRoomBlackboardEventsImpl(context, input);
}

export async function publishRoomAttachment(context, input = {}) {
    return await publishRoomAttachmentImpl(context, input);
}

export async function commitRoomMedia(context, { roomId, participantId = '', blobRef, authInfo = null } = {}) {
    const record = await loadMeetingRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const payload = decryptMeetingPayload(context, record);
    authorizeRoomParticipantId(payload, authInfo, participantId, roomId);
    return await scriptaExplorer.commitMedia(context, {
        roomId,
        roomFolderPath: getScriptaRoomFolderPath(record, payload),
        blobRef
    });
}

export async function undoRoomBlackboard(context, { roomId, boardId = '', participantId = '', authInfo = null } = {}) {
    return await undoRoomBlackboardImpl(context, { roomId, boardId, participantId, authInfo });
}

export async function redoRoomBlackboard(context, { roomId, boardId = '', participantId = '', authInfo = null } = {}) {
    return await redoRoomBlackboardImpl(context, { roomId, boardId, participantId, authInfo });
}

export async function getRoboTeamSettings(context, { roomId, authInfo = null } = {}) {
    return await getRoboTeamSettingsImpl(context, { roomId, authInfo });
}

export async function updateRoboTeamSettings(context, { roomId, settings, authInfo = null } = {}) {
    const result = await updateRoboTeamSettingsImpl(context, { roomId, settings, authInfo });
    let notesWorkspace = null;
    if (result.settings?.meetingNotes?.enabled) {
        notesWorkspace = await ensureMeetingNotesWorkspace(context, roomId);
        await ensureMeetingSecretaryDispatch(context, roomId);
    }
    const record = await loadMeetingRecord(context, roomId);
    await sendLiveKitRoomData(context, record.roomName, buildWebMeetEvent(
        roomId,
        WEBMEET_EVENT_TYPES.MEETING_NOTES_SETTINGS_CHANGED,
        { meetingId: roomId },
    )).catch(() => {});
    if (notesWorkspace?.created) {
        await sendLiveKitRoomData(context, record.roomName, buildWebMeetEvent(
            roomId,
            WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
            {
                meetingId: roomId,
                boardId: notesWorkspace.boardId,
                blackboardRevision: notesWorkspace.blackboardRevision,
                workspaceRevision: notesWorkspace.workspaceRevision,
                changeType: 'create',
                targetType: 'workspace',
                targetRef: notesWorkspace.boardId,
                reason: 'meeting_notes_workspace',
                objectKind: 'workspace',
            },
        )).catch(() => {});
    }
    return result;
}

export async function recordProfileAvatarUpdated(context, {
    workspaceId,
    userId,
    authInfo = null
} = {}) {
    const targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) {
        throw new Error('Missing workspace id.');
    }
    await listMeetings(context, targetWorkspaceId, authInfo);
    const normalizedAuth = normalizeAuthInfo(authInfo);
    const targetUserId = String(userId || normalizedAuth.id || '').trim();
    if (!targetUserId) {
        throw new Error('Missing profile avatar user id.');
    }
    if (!isAdminAuthInfo(authInfo) && normalizedAuth.id && normalizedAuth.id !== targetUserId) {
        throw new Error('Access denied: cannot publish another user profile avatar update.');
    }
    return recordWorkspaceEvent(context, targetWorkspaceId, WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED, {
        workspaceId: targetWorkspaceId,
        userId: targetUserId
    });
}

export async function createStoreContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    await ensureDirs(paths);
    await purgeExpiredMeetings(paths);
    return {
        ...paths,
        roomPrefix: String(process.env.WEBMEET_ROOM_PREFIX || 'webmeet').trim() || 'webmeet',
        agentName: String(process.env.WEBMEET_AGENT_NAME || 'WebMeetAgent').trim() || 'WebMeetAgent',
        livekitApiKey: String(process.env.LIVEKIT_API_KEY || '').trim(),
        livekitApiSecret: String(process.env.LIVEKIT_API_SECRET || '').trim()
    };
}

export async function listMeetings(context, _workspaceId = '', authInfo = null) {
    assertAuthenticatedAuthInfo(authInfo);
    if (isGuestAuthInfo(authInfo)) {
        throw new Error('Access denied: sign in to view WebMeet rooms.');
    }
    // An authenticated user without verified listing access sees no rooms.
    if (!isVerifiedListingEntitled(authInfo)) {
        return [];
    }
    const records = await listRoomRecords(context);
    return records
        .filter((entry) => canListMeetingRecord(entry, authInfo))
        .map(buildMeetingView);
}

export async function updateMeetingTitle(context, { meetingId, title, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const nextTitle = String(title || '').trim();
    if (!nextTitle) {
        throw new Error('Missing room title.');
    }
    let meeting = null;
    await mutateMeeting(context, meetingId, (record, _payload, stageEvent) => {
        record.name = nextTitle;
        record.title = nextTitle;
        stageEvent('meeting', WEBMEET_EVENT_TYPES.MEETING_RENAMED, {
            meetingId,
            title: nextTitle
        });
        stageEvent('workspace', WEBMEET_EVENT_TYPES.MEETING_RENAMED, {
            workspaceId: 'rooms',
            meetingId,
            title: nextTitle
        });
    });
    meeting = buildMeetingView(await loadMeetingRecord(context, meetingId));
    return meeting;
}

export async function createMeeting(context, { title = '', name = '', roomType = 'team', authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const roomName = String(name || title || DEFAULT_ROOM_TITLE).trim() || DEFAULT_ROOM_TITLE;
    const validRoomType = roomType === 'guest' ? 'guest' : 'team';
    const record = await createMeetingRecord(context, roomName, validRoomType);
    try {
        await mutateMeeting(context, record.meetingId, (_record, payload, stageEvent) => {
            ensureRoboTeamSettingsPayload(payload);
            const agent = ensureRoboTeamAgentPayload(payload, stageEvent, record.meetingId);
            const demoCreated = ensureRoboTeamDemoBlackboard(payload, record.meetingId);
            if (demoCreated) {
                stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
                    meetingId: record.meetingId,
                    blackboardRevision: getRoboTeamBlackboardRevision(payload),
                    changeType: 'create',
                    targetType: 'blackboard',
                    targetRef: '',
                    reason: 'robo_team_demo',
                    objectKind: 'blackboard'
                });
            }
            if (agent && isRoboTeamEnabled(payload.roboTeamSettings)) {
                stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, {
                    meetingId: record.meetingId,
                    agentId: agent.id,
                    agentType: ROBO_TEAM_AGENT_TYPE,
                    mode: ROBO_TEAM_MODE,
                    runtime: 'ploinky'
                });
            }
        });
        await ensureScriptaRoomFolderImpl(context, { roomId: record.meetingId, authInfo });
    } catch (error) {
        try {
            await rollbackMeetingRecord(context, record.meetingId);
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                `Meeting creation failed and room ${record.meetingId} could not be rolled back.`
            );
        }
        throw error;
    }
    const meeting = {
        id: record.roomId || record.meetingId,
        roomId: record.roomId || record.meetingId,
        name: record.name || record.title,
        title: record.name || record.title,
        roomType: record.roomType,
        roomName: record.roomName,
        status: record.status,
        createdAt: record.createdAt,
        archivedAt: record.archivedAt || null
    };
    return meeting;
}

export async function joinGuestMeeting(context, { meetingId, displayName, participantId }) {
    return await joinGuestMeetingImpl(context, { meetingId, displayName, participantId }, participantServiceDeps);
}

export async function getGuestMeetingDetails(context, { meetingId, participantId }) {
    return await getGuestMeetingDetailsImpl(context, { meetingId, participantId }, participantServiceDeps);
}

export async function leaveGuestMeeting(context, { meetingId, participantId }) {
    return await leaveGuestMeetingImpl(context, { meetingId, participantId }, participantServiceDeps);
}

export async function updateGuestMeetingParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null
} = {}) {
    return await updateGuestMeetingParticipantAvatarImpl(context, { meetingId, participantId, avatar });
}

export async function joinMeeting(context, { meetingId, displayName, participantId, avatar = null, authInfo = null }) {
    return await joinMeetingImpl(context, { meetingId, displayName, participantId, avatar, authInfo }, participantServiceDeps);
}

export async function updateMeetingParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null,
    authInfo = null
} = {}) {
    return await updateMeetingParticipantAvatarImpl(context, { meetingId, participantId, avatar, authInfo });
}

export async function leaveMeeting(context, { meetingId, participantId, authInfo = null, skipAccessCheck = false }) {
    return await leaveMeetingImpl(context, { meetingId, participantId, authInfo, skipAccessCheck }, participantServiceDeps);
}

export async function heartbeatMeetingPresence(context, { meetingId, participantId, authInfo = null }) {
    return await heartbeatMeetingPresenceImpl(context, { meetingId, participantId, authInfo }, participantServiceDeps);
}

export async function listMeetingParticipants(context, meetingId, authInfo = null) {
    return await listMeetingParticipantsImpl(context, meetingId, authInfo, participantServiceDeps);
}

export async function updateMeetingParticipantRole(context, { meetingId, participantId, role, authInfo = null }) {
    return await updateMeetingParticipantRoleImpl(context, { meetingId, participantId, role, authInfo });
}

export async function removeMeetingParticipant(context, { meetingId, participantId, authInfo = null }) {
    return await removeMeetingParticipantImpl(context, { meetingId, participantId, authInfo });
}

export async function listMeetingChat(context, meetingId, authInfo = null) {
    return await listMeetingChatImpl(context, meetingId, authInfo, messageServiceDeps);
}

export async function appendMeetingChat(context, { meetingId, authorId, authorName, message, kind = 'user', metadata = null, dedupeCommandId = '', authInfo = null, skipAccessCheck = false }) {
    return await appendMeetingChatImpl(context, { meetingId, authorId, authorName, message, kind, metadata, dedupeCommandId, authInfo, skipAccessCheck }, messageServiceDeps);
}

export async function updateMeetingChat(context, { meetingId, messageId, message, metadata, authInfo = null, skipAccessCheck = false }) {
    return await updateMeetingChatImpl(context, { meetingId, messageId, message, metadata, authInfo, skipAccessCheck }, messageServiceDeps);
}

export async function appendGuestMeetingChat(context, { meetingId, participantId, message }) {
    return await appendGuestMeetingChatImpl(context, { meetingId, participantId, message }, messageServiceDeps);
}

export async function attachMeetingAgent(context, { meetingId, agentType, mode, authInfo = null }) {
    // Authorize before the presence cleanup: that cleanup rewrites the room record.
    assertAdminAuthInfo(authInfo);
    await cleanupMeetingPresence(context, meetingId);
    if (String(agentType || '').trim() !== ROBO_TEAM_AGENT_TYPE || String(mode || '').trim() !== ROBO_TEAM_MODE) {
        throw new Error(`Unsupported Ploinky room agent "${agentType}:${mode}".`);
    }
    let agent = null;
    await mutateMeeting(context, meetingId, (_record, payload, stageEvent) => {
        const settings = ensureRoboTeamSettingsPayload(payload);
        settings.blackboard.enabled = true;
        settings.blackboard.visibility = 'all-participants';
        settings.blackboard.autoUpdateFromConversation = true;
        settings.blackboard.participantRequestsEnabled = true;
        agent = ensureRoboTeamAgentPayload(payload, stageEvent, meetingId);
        agent.deletedAt = null;
        agent.status = 'active';
        agent.updatedAt = nowIso();
        ensureRoboTeamDemoBlackboard(payload, meetingId);
        stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, {
            meetingId,
            agentId: agent.id,
            agentType,
            mode,
            runtime: 'ploinky'
        });
    });
    return agent;
}

export async function listMeetingAgents(context, meetingId, authInfo = null) {
    await cleanupMeetingPresence(context, meetingId);
    const record = await loadMeetingRecord(context, meetingId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    const payload = decryptMeetingPayload(context, record);
    const normalizedSettings = normalizeRoboTeamSettings(payload.roboTeamSettings);
    const settingsChanged = JSON.stringify(payload.roboTeamSettings || null) !== JSON.stringify(normalizedSettings);
    const hasRoboTeamAgent = Array.isArray(payload.agents)
        && payload.agents.some((entry) => String(entry?.agentType || '').trim() === ROBO_TEAM_AGENT_TYPE);
    let agents = [];
    if (settingsChanged || !hasRoboTeamAgent) {
        const mutation = await mutateMeeting(context, meetingId, (_record, mutablePayload, stageEvent) => {
            mutablePayload.roboTeamSettings = normalizeRoboTeamSettings(mutablePayload.roboTeamSettings);
            const agent = ensureRoboTeamAgentPayload(mutablePayload, stageEvent, meetingId);
            if (agent && isRoboTeamEnabled(mutablePayload.roboTeamSettings)) {
                agent.deletedAt = null;
                agent.status = 'active';
            }
            const demoCreated = ensureRoboTeamDemoBlackboard(mutablePayload, meetingId);
            if (demoCreated) {
                stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
                    meetingId,
                    blackboardRevision: getRoboTeamBlackboardRevision(mutablePayload),
                    changeType: 'create',
                    targetType: 'blackboard',
                    targetRef: '',
                    reason: 'robo_team_demo',
                    objectKind: 'blackboard'
                });
            }
        });
        agents = Array.isArray(mutation.payload.agents) ? cloneJson(mutation.payload.agents) : [];
    } else {
        agents = Array.isArray(payload.agents) ? cloneJson(payload.agents) : [];
    }
    if (isAdminAuthInfo(authInfo)) {
        return agents;
    }
    return agents.map(projectMeetingAgentForViewer);
}

export async function detachMeetingAgent(context, { meetingId, agentId, authInfo = null }) {
    // Authorize before the presence cleanup: that cleanup rewrites the room record.
    assertAdminAuthInfo(authInfo);
    await cleanupMeetingPresence(context, meetingId);
    const targetAgentId = String(agentId || '').trim();
    if (!targetAgentId) {
        throw new Error('Missing agentId.');
    }
    const record = await loadMeetingRecord(context, meetingId);
    const currentPayload = decryptMeetingPayload(context, record);
    const currentAgent = currentPayload.agents.find((entry) => (
        String(entry?.id || '') === targetAgentId && !entry.deletedAt
    ));
    if (!currentAgent) {
        throw new Error('Meeting agent not found.');
    }
    let detachedAgent = null;
    await mutateMeeting(context, meetingId, (_record, payload, stageEvent) => {
        const targetAgent = payload.agents.find((entry) => String(entry?.id || '') === targetAgentId);
        if (!targetAgent) return;
        Object.assign(targetAgent, {
            status: 'detached',
            deletedAt: nowIso(),
            updatedAt: nowIso(),
            runtime: 'ploinky'
        });
        if (String(targetAgent.agentType || '') === ROBO_TEAM_AGENT_TYPE) {
            const settings = ensureRoboTeamSettingsPayload(payload);
            settings.blackboard.enabled = false;
        }
        detachedAgent = { ...targetAgent };
        stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DETACHED, {
            meetingId,
            agentId: targetAgentId,
            agentType: targetAgent.agentType || '',
            mode: targetAgent.mode || ''
        });
    });
    return detachedAgent || { id: targetAgentId, status: 'detached' };
}

export async function archiveMeeting(context, meetingId, authInfo = null) {
    return await archiveMeetingImpl(context, meetingId, authInfo, archiveServiceDeps);
}

export async function deleteMeeting(context, { meetingId, confirmed = false, authInfo = null } = {}) {
    return await deleteMeetingImpl(context, {
        meetingId,
        confirmed,
        authInfo
    }, deletionServiceDeps);
}

export async function authorizeResourceUpload(context, { roomId, filename, mimeType = '', size = 0, authInfo = null }) {
    return await authorizeResourceUploadImpl(context, { roomId, filename, mimeType, size, authInfo }, roomResourceDeps);
}

export async function commitResourceUpload(context, {
    roomId,
    resourceId,
    filename,
    mimeType = '',
    size = 0,
    storagePath = '',
    visibility = 'room',
    authInfo = null
}) {
    const auth = normalizeAuthInfo(authInfo);
    return await commitResourceUploadImpl(context, {
        roomId,
        resourceId,
        filename,
        mimeType,
        size,
        storagePath,
        visibility,
        ownerUserId: auth.id || '',
        authInfo
    }, roomResourceDeps);
}

export async function authorizeResourceDownload(context, { roomId, resourceId, authInfo = null }) {
    return await authorizeResourceDownloadImpl(context, { roomId, resourceId, authInfo }, roomResourceDeps);
}

export async function listRoomResources(context, roomId, authInfo = null) {
    return await listRoomResourcesImpl(context, roomId, authInfo, roomResourceDeps);
}

export async function removeRoomResource(context, { roomId, resourceId, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    return await removeRoomResourceImpl(context, { roomId, resourceId, authInfo }, roomResourceDeps);
}

export async function ensureScriptaDocuments(context, input = {}) {
    return await ensureScriptaDocumentsImpl(context, input);
}

export async function getScriptaContext(context, input = {}) {
    return await getScriptaContextImpl(context, input);
}

export async function focusScripta(context, input = {}) {
    return await focusScriptaImpl(context, input);
}

export async function mutateScripta(context, input = {}) {
    return await mutateScriptaImpl(context, input);
}

export async function mergeScriptaDocumentMarkdown(context, input = {}) {
    return await mergeScriptaDocumentMarkdownImpl(context, input);
}

export async function createScriptaDocument(context, input = {}) {
    return await createScriptaDocumentImpl(context, input);
}

export async function openScriptaDocument(context, input = {}) {
    return await openScriptaDocumentImpl(context, input);
}

export async function manageScriptaDocument(context, input = {}) {
    return await manageScriptaDocumentImpl(context, input);
}

export async function navigateScripta(context, input = {}) {
    return await navigateScriptaImpl(context, input);
}

export async function listScriptaWorkspaceEntries(context, input = {}) {
    return await listScriptaWorkspaceEntriesImpl(context, input);
}

export async function openScriptaCollaboration(context, input = {}) {
    return await openScriptaCollaborationImpl(context, input);
}

export async function pullScriptaCollaboration(context, input = {}) {
    return await pullScriptaCollaborationImpl(context, input);
}

export async function applyScriptaCollaboration(context, input = {}) {
    return await applyScriptaCollaborationImpl(context, input);
}

export async function closeScriptaCollaboration(context, input = {}) {
    return await closeScriptaCollaborationImpl(context, input);
}

export async function startMeetingNotesSession(context, input = {}) {
    return await startMeetingNotesSessionImpl(context, input);
}

export async function applyMeetingNotesDocument(context, input = {}) {
    return await applyMeetingNotesDocumentImpl(context, input);
}

export async function heartbeatMeetingNotesSession(context, input = {}) {
    return await heartbeatMeetingNotesSessionImpl(context, input);
}

export async function finalizeMeetingNotesSession(context, input = {}) {
    return await finalizeMeetingNotesSessionImpl(context, input);
}

export {
    isAdminAuthInfo
};

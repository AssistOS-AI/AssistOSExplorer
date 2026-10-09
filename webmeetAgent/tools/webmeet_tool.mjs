import { pathToFileURL } from 'node:url';

import {
    archiveMeeting,
    applyMeetingNotesDocument,
    applyRoomBlackboardChange,
    applyRoomBlackboardEvents,
    applyRoomBlackboardWorkspaceAction,
    attachMeetingAgent,
    authorizeMeetingParticipant,
    appendGuestMeetingChat,
    appendMeetingChat,
    authorizeResourceDownload,
    authorizeResourceUpload,
    commitResourceUpload,
    createMeeting,
    createStoreContext,
    deleteMeeting,
    detachMeetingAgent,
    getRoboTeamSettings,
    getScriptaContext,
    getGuestMeetingDetails,
    getRoomBlackboard,
    getRoomBlackboardForCommand,
    getMeeting,
    getPublicGuestMeeting,
    finalizeMeetingNotesSession,
    heartbeatMeetingPresence,
    heartbeatMeetingNotesSession,
    joinGuestMeeting,
    joinMeeting,
    leaveMeeting,
    listMeetingParticipants,
    listRoomResources,
    listScriptaWorkspaceEntries,
    openScriptaCollaboration,
    pullScriptaCollaboration,
    publishRoomAttachment,
    applyScriptaCollaboration,
    closeScriptaCollaboration,
    commitRoomMedia,
    listMeetingAgents,
    listMeetingChat,
    listMeetingEvents,
    listMeetings,
    listWorkspaceEventsForViewer,
    removeMeetingParticipant,
    removeRoomResource,
    startMeetingNotesSession,
    redoRoomBlackboard,
    undoRoomBlackboard,
    updateMeetingChat,
    updateRoboTeamSettings,
    updateGuestMeetingParticipantAvatar,
    updateMeetingParticipantRole,
    updateMeetingParticipantAvatar,
    updateMeetingTitle
} from '../lib/webmeetStore.mjs';
import { withVerifiedGuestParticipantOwner } from '../lib/services/roomParticipants.mjs';
import {
    hasWebmeetRoomScope,
    isVerifiedAdminAuthInfo,
    isVerifiedListingEntitled
} from '../lib/store/accessPolicy.mjs';
import { isValidWorkspaceEventId } from '../lib/store/eventLogs.mjs';
import { executeBlackboardEvent } from '../lib/blackboard/event-service.mjs';
import { generateScriptaContent } from '../lib/scripta/content-generator.mjs';

async function loadInvocationAuth() {
    const candidates = [
        process.env.PLOINKY_INVOCATION_AUTH_MODULE,
        '/Agent/lib/invocation-auth.mjs',
        '../../shared/invocation-auth.mjs'
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            return await import(candidate);
        } catch (_) {}
    }
    throw new Error('Unable to load invocation-auth helper.');
}

const { authInfoFromInvocation } = await loadInvocationAuth();

const TOOL_NAME = String(process.env.TOOL_NAME || '').trim();
const SUPPORTED_AGENT_TYPES = new Set(['robo_team']);
const SUPPORTED_AGENT_MODES = new Set(['blackboard_demo']);
const GUEST_TOOL_ALLOWLIST = new Set([
    'webmeet_room_public_get',
    'webmeet_room_join_guest',
    'webmeet_room_guest_get',
    'webmeet_chat_send_guest',
    'webmeet_room_leave',
    'webmeet_presence_heartbeat',
    'webmeet_participant_avatar_update'
]);

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function readStdinFallback() {
    if (process.stdin.isTTY) {
        return '';
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    return data;
}

function unwrapInput(envelope) {
    let current = envelope;
    for (let i = 0; i < 6; i += 1) {
        if (!current || typeof current !== 'object') break;
        if (current.input && typeof current.input === 'object') {
            current = current.input;
            continue;
        }
        if (current.arguments && typeof current.arguments === 'object') {
            current = current.arguments;
            continue;
        }
        if (current.params?.arguments && typeof current.params.arguments === 'object') {
            current = current.params.arguments;
            continue;
        }
        if (current.params?.input && typeof current.params.input === 'object') {
            current = current.params.input;
            continue;
        }
        break;
    }
    return current && typeof current === 'object' ? current : {};
}

async function readEnvelope() {
    const raw = (await readStdinFallback()).trim();
    if (!raw) return {};
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
        return {};
    }
    return parsed;
}

function getRequiredString(args, key) {
    const value = String(args?.[key] || '').trim();
    if (!value) {
        throw new Error(`Missing required argument "${key}".`);
    }
    return value;
}

function getRequiredObject(args, key) {
    const value = args?.[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Missing required argument "${key}".`);
    }
    return value;
}

function extractInvocationGrant(envelope) {
    const metadata = envelope && typeof envelope === 'object' ? envelope.metadata : null;
    const grant = metadata && typeof metadata === 'object' ? metadata.invocation : null;
    return grant && typeof grant === 'object' ? grant : null;
}

function authInfoFromEnvelope(envelope) {
    const invocationGrant = extractInvocationGrant(envelope || {});
    return invocationGrant
        ? authInfoFromInvocation(invocationGrant, { invocationToken: envelope?.metadata?.invocationToken || '' })
        : null;
}

function deriveAuthChatAuthor(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') {
        return null;
    }
    const user = authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo;
    const agent = authInfo.agent && typeof authInfo.agent === 'object' ? authInfo.agent : null;
    const authorId = String(user.id || agent?.principalId || authInfo.principalId || user.username || user.email || '').trim();
    if (!authorId) {
        return null;
    }
    return {
        authorId,
        authorName: String(user.name || user.username || user.email || authorId).trim() || authorId
    };
}

function assertUserChatAuthor(args, authInfo = null) {
    const authAuthor = deriveAuthChatAuthor(authInfo);
    if (authAuthor) {
        return authAuthor;
    }
    throw new Error('Authentication is required to send meeting chat.');
}

function assertPublicRoomInvocation(authInfo, roomId) {
    const targetRoomId = String(roomId || '').trim();
    if (!hasWebmeetRoomScope(authInfo, targetRoomId)) {
        throw new Error('Public room join scope does not match this room.');
    }
}

function isPublicRoomInvocation(authInfo, roomId) {
    try {
        assertPublicRoomInvocation(authInfo, roomId);
        return true;
    } catch {
        return false;
    }
}

function isGuestInvocation(context = null) {
    const directInvocation = context?.invocation && typeof context.invocation === 'object'
        ? context.invocation
        : null;
    const invocation = directInvocation || extractInvocationGrant(context?.envelope || {});
    const subject = String(invocation?.sub || '').trim();
    return subject.startsWith('user:guest:') && invocation?.hasUserClaims === false;
}

function isGuestAuthInfo(authInfo = null) {
    const user = authInfo?.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo;
    const userId = String(user?.id || '').trim();
    const roles = Array.isArray(user?.roles)
        ? user.roles.map((role) => String(role || '').trim().toLowerCase())
        : [];
    const subject = String(authInfo?.invocation?.subject || '').trim();
    const actorKind = String(authInfo?.invocation?.actor?.kind || '').trim().toLowerCase();
    const callerKind = String(authInfo?.invocation?.caller?.kind || '').trim().toLowerCase();
    return userId.startsWith('guest:')
        || userId.startsWith('user:guest:')
        || roles.includes('guest')
        || subject.startsWith('user:guest:')
        || actorKind === 'guest'
        || callerKind === 'guest';
}

function isGuestParticipantInvocation(context, authInfo, roomId) {
    return !authInfo
        || isGuestAuthInfo(authInfo)
        || isPublicRoomInvocation(authInfo, roomId)
        || isGuestInvocation(context);
}

function assertGuestToolAllowed(toolName, context, authInfo) {
    if (!isGuestAuthInfo(authInfo) && !isGuestInvocation(context)) {
        return;
    }
    if (!GUEST_TOOL_ALLOWLIST.has(toolName)) {
        throw new Error(`Access denied: guest invocation cannot call "${toolName}".`);
    }
}

export async function dispatch(toolName, args, context, authInfo) {
    assertGuestToolAllowed(toolName, context, authInfo);
    switch (toolName) {
    case 'webmeet_room_list':
        return {
            rooms: await listMeetings(context, '', authInfo),
            canManageRooms: isVerifiedAdminAuthInfo(authInfo)
        };
    case 'webmeet_room_create':
        return await createMeeting(context, {
            name: getRequiredString(args, 'name'),
            roomType: String(args?.roomType || 'team').trim(),
            authInfo
        });
    case 'webmeet_room_join':
        {
            const roomId = getRequiredString(args, 'roomId');
            if (isPublicRoomInvocation(authInfo, roomId)) {
                return await withVerifiedGuestParticipantOwner(context, authInfo, roomId, async () => (
                    await joinGuestMeeting(context, {
                        meetingId: roomId,
                        displayName: getRequiredString(args, 'displayName'),
                        participantId: String(args?.participantId || '').trim()
                    })
                ));
            }
            return await joinMeeting(context, {
                meetingId: roomId,
                displayName: String(args?.displayName || '').trim(),
                participantId: String(args?.participantId || '').trim(),
                avatar: args?.avatar || null,
                authInfo
            });
        }
    case 'webmeet_room_join_guest':
        {
            const roomId = getRequiredString(args, 'roomId');
            return await withVerifiedGuestParticipantOwner(context, authInfo, roomId, async () => (
                await joinGuestMeeting(context, {
                    meetingId: roomId,
                    displayName: getRequiredString(args, 'displayName'),
                    participantId: String(args?.participantId || '').trim()
                })
            ));
        }
    case 'webmeet_room_leave':
        {
            const roomId = getRequiredString(args, 'roomId');
            const operation = async () => await leaveMeeting(context, {
                meetingId: roomId,
                participantId: getRequiredString(args, 'participantId'),
                authInfo
            });
            return isGuestParticipantInvocation(context, authInfo, roomId)
                ? await withVerifiedGuestParticipantOwner(context, authInfo, roomId, operation)
                : await operation();
        }
    case 'webmeet_presence_heartbeat':
        {
            const roomId = getRequiredString(args, 'roomId');
            const operation = async () => await heartbeatMeetingPresence(context, {
                meetingId: roomId,
                participantId: getRequiredString(args, 'participantId'),
                authInfo
            });
            return isGuestParticipantInvocation(context, authInfo, roomId)
                ? await withVerifiedGuestParticipantOwner(context, authInfo, roomId, operation)
                : await operation();
        }
    case 'webmeet_scribe_session_start':
        return await startMeetingNotesSession(context, {
            roomId: getRequiredString(args, 'roomId'),
            jobId: String(args?.jobId || '').trim(),
            authInfo,
        });
    case 'webmeet_scribe_notes_apply':
        return await applyMeetingNotesDocument(context, {
            roomId: getRequiredString(args, 'roomId'),
            sessionId: getRequiredString(args, 'sessionId'),
            analysisRevision: Number(args?.analysisRevision),
            markdown: getRequiredString(args, 'markdown'),
            baseStateBase64: String(args?.baseStateBase64 || ''),
            authInfo,
        });
    case 'webmeet_scribe_session_heartbeat':
        return await heartbeatMeetingNotesSession(context, {
            roomId: getRequiredString(args, 'roomId'),
            sessionId: getRequiredString(args, 'sessionId'),
            activity: String(args?.activity || ''),
            pendingSegmentCount: Number(args?.pendingSegmentCount || 0),
            includeDocumentSnapshot: args?.includeDocumentSnapshot === true,
            authInfo,
        });
    case 'webmeet_scribe_session_finalize':
        return await finalizeMeetingNotesSession(context, {
            roomId: getRequiredString(args, 'roomId'),
            sessionId: getRequiredString(args, 'sessionId'),
            authInfo,
        });
    case 'webmeet_participant_list':
        return await listMeetingParticipants(context, getRequiredString(args, 'roomId'), authInfo);
    case 'webmeet_participant_update_role':
        return await updateMeetingParticipantRole(context, {
            meetingId: getRequiredString(args, 'roomId'),
            participantId: getRequiredString(args, 'participantId'),
            role: getRequiredString(args, 'role'),
            authInfo
        });
    case 'webmeet_participant_remove':
        return await removeMeetingParticipant(context, {
            meetingId: getRequiredString(args, 'roomId'),
            participantId: getRequiredString(args, 'participantId'),
            authInfo
        });
    case 'webmeet_room_events_list':
        {
            const targetId = getRequiredString(args, 'roomId');
            if (targetId.startsWith('room_')) {
                await getMeeting(context, targetId, authInfo, { includeParticipants: false });
                return {
                    events: await listMeetingEvents(context, targetId, {
                        afterId: String(args?.afterId || '').trim()
                    })
                };
            }
            // The workspace feed carries room ids and titles, so it uses the
            // same verified listing entitlement as webmeet_room_list.
            if (!isVerifiedListingEntitled(authInfo)) {
                throw new Error('Access denied: Explorer access is required.');
            }
            if (targetId !== 'rooms' && !isValidWorkspaceEventId(targetId)) {
                throw new Error('Invalid WebMeet workspace id.');
            }
            return await listWorkspaceEventsForViewer(context, targetId, {
                afterId: String(args?.afterId || '').trim()
            }, authInfo);
        }
    case 'webmeet_participant_avatar_update':
        {
            const roomId = getRequiredString(args, 'roomId');
            const participantId = getRequiredString(args, 'participantId');
            if (isGuestParticipantInvocation(context, authInfo, roomId)) {
                return await withVerifiedGuestParticipantOwner(context, authInfo, roomId, async () => (
                    await updateGuestMeetingParticipantAvatar(context, {
                        meetingId: roomId,
                        participantId,
                        avatar: args?.avatar || null
                    })
                ));
            }
            return await updateMeetingParticipantAvatar(context, {
                meetingId: roomId,
                participantId,
                avatar: args?.avatar || null,
                authInfo
            });
        }
    case 'webmeet_room_get':
        return await getMeeting(context, getRequiredString(args, 'roomId'), authInfo, {
            includeParticipants: args?.includeParticipants !== false
        });
    case 'webmeet_room_guest_get':
        {
            const roomId = getRequiredString(args, 'roomId');
            const participantId = getRequiredString(args, 'participantId');
            return await withVerifiedGuestParticipantOwner(context, authInfo, roomId, async () => (
                await getGuestMeetingDetails(context, {
                    meetingId: roomId,
                    participantId
                })
            ));
        }
    case 'webmeet_room_public_get':
        {
            const roomId = getRequiredString(args, 'roomId');
            assertPublicRoomInvocation(authInfo, roomId);
            return await getPublicGuestMeeting(context, roomId);
        }
    case 'webmeet_blackboard_workspace_get':
        return await getRoomBlackboard(context, {
            roomId: getRequiredString(args, 'roomId'),
            participantId: String(args?.participantId || '').trim(),
            authInfo
        });
    case 'webmeet_blackboard_get':
        return await getRoomBlackboard(context, {
            roomId: getRequiredString(args, 'roomId'),
            boardId: String(args?.boardId || '').trim(),
            participantId: String(args?.participantId || '').trim(),
            authInfo
        });
    case 'webmeet_scripta_workspace_list':
        return await listScriptaWorkspaceEntries(context, {
            roomId: getRequiredString(args, 'roomId'),
            authInfo,
        });
    case 'webmeet_scripta_sync_open':
        return await openScriptaCollaboration(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            participantId: String(args?.participantId || '').trim(),
            clientId: getRequiredString(args, 'clientId'),
            authInfo,
        });
    case 'webmeet_scripta_sync_pull':
        return await pullScriptaCollaboration(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            participantId: String(args?.participantId || '').trim(),
            clientId: getRequiredString(args, 'clientId'),
            sessionId: getRequiredString(args, 'sessionId'),
            knownHeads: Array.isArray(args?.knownHeads) ? args.knownHeads : [],
            authInfo,
        });
    case 'webmeet_scripta_sync_apply':
        return await applyScriptaCollaboration(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            participantId: String(args?.participantId || '').trim(),
            clientId: getRequiredString(args, 'clientId'),
            sessionId: getRequiredString(args, 'sessionId'),
            operation: getRequiredString(args, 'operation'),
            args: args?.args && typeof args.args === 'object' ? args.args : {},
            changesBase64: Array.isArray(args?.changesBase64) ? args.changesBase64 : [],
            baseHeads: Array.isArray(args?.baseHeads) ? args.baseHeads : [],
            authInfo,
        });
    case 'webmeet_scripta_sync_close':
        return await closeScriptaCollaboration(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            participantId: String(args?.participantId || '').trim(),
            clientId: getRequiredString(args, 'clientId'),
            sessionId: getRequiredString(args, 'sessionId'),
            authInfo,
        });
    case 'webmeet_event_command': {
        const author = assertUserChatAuthor(args, authInfo);
        return await executeBlackboardEvent(context, {
            roomId: getRequiredString(args, 'roomId'),
            boardId: getRequiredString(args, 'boardId'),
            event: args?.event,
            source: String(args?.source || 'event').trim(),
            commandSource: String(args?.commandSource || 'chat').trim(),
            participantId: String(args?.participantId || '').trim() || author.authorId,
            selectedWidgetId: String(args?.selectedWidgetId || '').trim(),
            commandId: String(args?.commandId || '').trim(),
            authorName: author.authorName,
            authInfo
        }, {
            authorizeRoomParticipant: authorizeMeetingParticipant,
            appendMeetingChat,
            updateMeetingChat,
            getRoomBlackboard: getRoomBlackboardForCommand,
            getScriptaContext,
            applyRoomBlackboardEvents,
            applyRoomBlackboardWorkspaceAction,
            applyRoomBlackboardChange,
            undoRoomBlackboard,
            redoRoomBlackboard,
            reformulate: generateScriptaContent
        });
    }
    case 'webmeet_robo_team_get':
        return await getRoboTeamSettings(context, {
            roomId: getRequiredString(args, 'roomId'),
            authInfo
        });
    case 'webmeet_robo_team_update':
        return await updateRoboTeamSettings(context, {
            roomId: getRequiredString(args, 'roomId'),
            settings: args?.settings || {},
            authInfo
        });
    case 'webmeet_room_rename':
        return await updateMeetingTitle(context, {
            meetingId: getRequiredString(args, 'roomId'),
            title: getRequiredString(args, 'name'),
            authInfo
        });
    case 'webmeet_chat_list':
        return { messages: await listMeetingChat(context, getRequiredString(args, 'roomId'), authInfo) };
    case 'webmeet_chat_send':
        {
            const author = assertUserChatAuthor(args, authInfo);
            const appended = await appendMeetingChat(context, {
                meetingId: getRequiredString(args, 'roomId'),
                authorId: author.authorId,
                authorName: author.authorName,
                message: getRequiredString(args, 'message'),
                metadata: Array.isArray(args?.resourceIds) ? { resourceIds: args.resourceIds } : null,
                authInfo
            });
            return { ...appended, researchTask: null };
        }
    case 'webmeet_chat_send_guest':
        {
            const roomId = getRequiredString(args, 'roomId');
            const participantId = getRequiredString(args, 'participantId');
            const appended = await withVerifiedGuestParticipantOwner(context, authInfo, roomId, async () => (
                await appendGuestMeetingChat(context, {
                    meetingId: roomId,
                    participantId,
                    message: getRequiredString(args, 'message')
                })
            ));
            return { ...appended, researchTask: null };
        }
    case 'webmeet_attachment_publish':
        return await publishRoomAttachment(context, {
            roomId: getRequiredString(args, 'roomId'),
            boardId: getRequiredString(args, 'boardId'),
            participantId: getRequiredString(args, 'participantId'),
            blobRef: getRequiredObject(args, 'blobRef'),
            position: args?.position || null,
            authInfo
        });
    case 'webmeet_media_commit':
        return await commitRoomMedia(context, {
            roomId: getRequiredString(args, 'roomId'),
            participantId: getRequiredString(args, 'participantId'),
            blobRef: getRequiredObject(args, 'blobRef'),
            authInfo
        });
    case 'webmeet_agent_attach': {
        const meetingId = getRequiredString(args, 'roomId');
        const agentType = getRequiredString(args, 'agentType');
        const mode = getRequiredString(args, 'mode');
        if (!SUPPORTED_AGENT_TYPES.has(agentType)) {
            throw new Error(`Unsupported agentType "${agentType}".`);
        }
        if (!SUPPORTED_AGENT_MODES.has(mode)) {
            throw new Error(`Unsupported mode "${mode}".`);
        }
        return await attachMeetingAgent(context, { meetingId, agentType, mode, authInfo });
    }
    case 'webmeet_agent_list':
        return { agents: await listMeetingAgents(context, getRequiredString(args, 'roomId'), authInfo) };
    case 'webmeet_agent_detach':
        return await detachMeetingAgent(context, {
            meetingId: getRequiredString(args, 'roomId'),
            agentId: getRequiredString(args, 'agentId'),
            authInfo
        });
    case 'webmeet_room_archive':
        return await archiveMeeting(context, getRequiredString(args, 'roomId'), authInfo);
    case 'webmeet_room_delete':
        return await deleteMeeting(context, {
            meetingId: getRequiredString(args, 'roomId'),
            confirmed: args?.confirmed === true,
            authInfo
        });
    case 'webmeet_resource_authorize_upload':
        return await authorizeResourceUpload(context, {
            roomId: getRequiredString(args, 'roomId'),
            filename: getRequiredString(args, 'filename'),
            mimeType: String(args?.mimeType || '').trim(),
            size: Number(args?.size || 0),
            authInfo
        });
    case 'webmeet_resource_commit_upload':
        return await commitResourceUpload(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            filename: getRequiredString(args, 'filename'),
            mimeType: String(args?.mimeType || '').trim(),
            size: Number(args?.size || 0),
            storagePath: getRequiredString(args, 'storagePath'),
            authInfo
        });
    case 'webmeet_resource_authorize_download':
        return await authorizeResourceDownload(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            authInfo
        });
    case 'webmeet_resource_list':
        return await listRoomResources(context, getRequiredString(args, 'roomId'), authInfo);
    case 'webmeet_resource_remove':
        return await removeRoomResource(context, {
            roomId: getRequiredString(args, 'roomId'),
            resourceId: getRequiredString(args, 'resourceId'),
            authInfo
        });
    default:
        throw new Error(`Unsupported TOOL_NAME "${toolName}".`);
    }
}

async function main() {
    const envelope = await readEnvelope();
    const args = unwrapInput(envelope);
    const authInfo = authInfoFromEnvelope(envelope);
    const context = await createStoreContext();
    context.envelope = envelope;
    const result = await dispatch(TOOL_NAME, args, context, authInfo);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}

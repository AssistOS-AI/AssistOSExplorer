import { normalizeAvatarConfig } from '../services/webmeet-profile-avatar-runtime.js';
import { buildWebMeetAvatarSource } from '../services/webmeet-avatar-override.js';
import {
    WEBMEET_EVENT_TYPES,
    parseWebMeetEvent
} from '../services/webmeet-events.js';
import { ROOM_EVENT_TYPES } from '../services/room/webmeet-room-events.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';

export const dashboardRealtimeMethods = {
    usesLiveRosterForWorkspaceEvent(payload = {}) {
        const eventMeetingId = String(payload?.meetingId || '').trim();
        const activeMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        if (!eventMeetingId || !activeMeetingId || eventMeetingId !== activeMeetingId) {
            return false;
        }
        return Boolean(this.room || this.state.roomState === 'Connected');
    },

    syncConnectedRoomRosterFromWorkspaceEvent() {
        if (this.room) {
            this.syncParticipantsFromRoom(this.room);
            return;
        }
        this.renderMeetingList();
    },

    bindRoomEventHandlers() {
        if (this.roomEventHandlersBound) {
            return;
        }
        this.roomEventHandlersBound = true;
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.WORKSPACE_INVALIDATED, (event) => {
            if (event?.detail?.source === 'authenticated-workspace') this.scheduleWorkspaceMeetingsRefresh();
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.CREATED, (event) => {
            const source = String(event?.detail?.source || '').trim();
            if (source === 'authenticated-workspace') {
                this.scheduleWorkspaceMeetingsRefresh();
            }
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.PARTICIPANT_JOINED, (event) => {
            const detail = event?.detail || {};
            const source = String(detail.source || '').trim();
            const parsed = detail.parsed || null;
            if (!parsed) return;
            if (source === 'authenticated-workspace') {
                if (this.usesLiveRosterForWorkspaceEvent(parsed.payload)) {
                    this.syncConnectedRoomRosterFromWorkspaceEvent();
                    return;
                }
                this.scheduleWorkspaceRosterRefresh(parsed.payload?.meetingId);
                return;
            }
            void this.handleParticipantRosterEvent({ data: parsed.encoded });
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.PARTICIPANT_LEFT, (event) => {
            const detail = event?.detail || {};
            const source = String(detail.source || '').trim();
            const parsed = detail.parsed || null;
            if (!parsed) return;
            if (source === 'authenticated-workspace') {
                if (this.usesLiveRosterForWorkspaceEvent(parsed.payload)) {
                    this.syncConnectedRoomRosterFromWorkspaceEvent();
                    return;
                }
                this.scheduleWorkspaceRosterRefresh(parsed.payload?.meetingId);
                return;
            }
            void this.handleParticipantRosterEvent({ data: parsed.encoded });
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.ARCHIVED, (event) => {
            if (event?.detail?.source === 'authenticated-workspace') {
                this.webMeetRoom.requestWorkspaceRevalidation();
                return;
            }
            const payload = event?.detail?.payload || event?.detail?.parsed?.payload || {};
            const meetingId = String(payload?.meetingId || payload?.roomId || event?.detail?.parsed?.room || '').trim();
            const activeMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
            const appliesToCurrentRoom = !meetingId || !activeMeetingId || meetingId === activeMeetingId;
            if (!appliesToCurrentRoom) {
                this.scheduleWorkspaceMeetingsRefresh();
                return;
            }
            const archivedById = String(payload?.archivedById || '').trim();
            const archivedByName = String(payload?.archivedByName || '').trim();
            const currentActorId = String(this.webMeetRoom?.getCurrentActorId?.() || '').trim();
            const archivedByCurrentActor = Boolean(archivedById && currentActorId && archivedById === currentActorId);
            const message = archivedByCurrentActor
                ? ''
                : (archivedByName ? `Room was archived by ${archivedByName}.` : 'Room was archived by an admin.');
            (async () => {
                await this.leaveMeeting?.({ skipConfirmation: true }).catch(() => {});
                this.scheduleWorkspaceMeetingsRefresh();
                if (message) {
                    this.setError(message);
                }
            })();
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.AVATAR_PROJECTED, (event) => {
            const detail = event?.detail || {};
            const source = String(detail.source || '').trim();
            const parsed = detail.parsed || null;
            const payload = detail.payload && typeof detail.payload === 'object'
                ? detail.payload
                : null;
            if (source === 'livekit' && parsed) {
                this.applyRealtimeParticipantAvatar?.(payload || parsed.payload);
                this.renderParticipantLayout();
                this.renderMeetingList();
                return;
            }
            if (source === 'local-avatar' && payload) {
                this.applyRealtimeParticipantAvatar?.(payload);
                this.renderParticipantLayout();
                this.renderMeetingList();
            }
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.CHAT, (event) => {
            const detail = event?.detail || {};
            const payload = detail.payload && typeof detail.payload === 'object'
                ? detail.payload
                : null;
            if (!payload?.message) return;
            this.state.chat = Array.isArray(this.state.chat) ? this.state.chat : [];
            const messageId = String(payload.message?.id || '').trim();
            const existingIndex = messageId
                ? this.state.chat.findIndex((entry) => String(entry?.id || '').trim() === messageId)
                : -1;
            if (existingIndex >= 0) {
                this.state.chat[existingIndex] = payload.message;
                this.renderFeedLists();
                return;
            }
            this.state.chat.push(payload.message);
            this.renderFeedLists();
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.BLACKBOARD_UPDATED, (event) => {
            void this.handleBlackboardUpdatedEvent?.(event);
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS, (event) => {
            void this.updateRoboCommandStatus?.(event?.detail?.payload || {}, { publish: false });
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.TRANSCRIPT, () => {
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingDetailsFromRealtimeEvent());
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.AGENT_ATTACHED, (event) => {
            const source = String(event?.detail?.source || '').trim();
            if (source === 'authenticated-workspace') {
                this.scheduleWorkspaceRosterRefresh(event?.detail?.parsed?.payload?.meetingId);
                return;
            }
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingDetailsFromRealtimeEvent());
        });
        this.webMeetRoom.addEventListener(ROOM_EVENT_TYPES.RECORDING_STARTED, () => {
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingDetailsFromRealtimeEvent());
        });
    },

    async publishRealtimePayload(payload) {
        return this.webMeetRoom.publishRealtimePayload(payload);
    },

    startWorkspaceEvents() {
        this.webMeetRoom.startWorkspaceEvents();
    },

    stopWorkspaceEvents() {
        this.webMeetRoom.stopWorkspaceEvents();
        this.clearWorkspaceMeetingsRefreshTimer();
        this.clearWorkspaceRosterRefreshTimer();
        this.meetingListLoadSeq = (this.meetingListLoadSeq || 0) + 1;
    },

    emitWebMeetInternalEvent(source, eventData = '', meta = {}) {
        const parsed = this.webMeetRoom.handleIncomingEvent(source, eventData, meta);
        this.handleWebMeetInternalEvent({
            source,
            parsed,
            event: parsed?.encoded || ''
        });
        return parsed;
    },

    handleWebMeetInternalEvent(detail = {}) {
        const parsed = detail?.parsed || null;
        if (!parsed) return;
        const source = String(detail?.source || '').trim();
        const type = parsed.type;
        const payload = parsed.payload || {};
        const meetingId = String(payload?.meetingId || parsed.room || '').trim();
        const selectedMeetingId = String(this.selectedMeeting?.id || this.state.selectedMeetingId || '').trim();
        if (meetingId && selectedMeetingId && meetingId !== selectedMeetingId && source !== 'authenticated-workspace') {
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_RENAMED) {
            this.applyMeetingRename(
                payload?.meetingId,
                payload?.title,
                payload?.createdAt || ''
            );
            if (source === 'authenticated-workspace') {
                this.scheduleWorkspaceMeetingsRefresh();
            }
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_ARCHIVED) {
            // MEETING_ARCHIVED is already normalized and handled as ROOM_EVENT_TYPES.ARCHIVED.
            // Keeping this branch would process the same incoming event twice for LiveKit events.
            this.scheduleWorkspaceMeetingsRefresh();
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_NOTES_SETTINGS_CHANGED) {
            if (!meetingId || meetingId !== String(this.state.session?.meeting?.id || '').trim()) return;
            void runWebMeetTool('webmeet_room_get', {
                roomId: meetingId,
                includeParticipants: false,
            })
                .then((result) => {
                    const meetingNotes = result?.meetingNotes;
                    if (!meetingNotes || !this.state.session) return;
                    this.state.session.meetingNotes = {
                        ...(this.state.session.meetingNotes || {}),
                        ...meetingNotes,
                    };
                    this.meetingNotesTranscription?.sync?.();
                    this.renderMeetingSummary();
                })
                .catch(() => {});
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_NOTES_ACTIVITY) {
            if (!meetingId || meetingId !== String(this.state.session?.meeting?.id || '').trim()) return;
            this.state.meetingNotesActivity = {
                phase: String(payload?.phase || ''),
                pendingSegmentCount: Math.max(0, Number(payload?.pendingSegmentCount || 0)),
                analysisRevision: Math.max(0, Number(payload?.analysisRevision || 0)),
                updatedAt: String(parsed.createdAt || ''),
            };
            this.renderMeetingNotesTranscriptionStatus?.();
            return;
        }
        if (source === 'livekit' && type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST) {
            const requesterParticipantId = String(
                detail?.meta?.participantId
                || payload?.participantId
                || ''
            ).trim();
            const localParticipantId = String(this.state.session?.participantIdentity || this.room?.localParticipant?.identity || '').trim();
            if (!requesterParticipantId || !localParticipantId || requesterParticipantId === localParticipantId) {
                return;
            }
            void this.webMeetRoom.republishAvatarProjection().catch(() => {});
            return;
        }
        if ([WEBMEET_EVENT_TYPES.AGENT_DETACHED, WEBMEET_EVENT_TYPES.RESOURCE_CREATED, WEBMEET_EVENT_TYPES.RESOURCE_REMOVED, WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED].includes(type)) {
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingDetailsFromRealtimeEvent());
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED) {
            this.handleProfileAvatarWorkspaceEvent({ data: parsed.encoded });
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_CREATED) {
            this.scheduleWorkspaceMeetingsRefresh();
        }
    },

    async handleAvatarSettingsUpdated(event) {
        if (this.isGuestSession()) return;
        if (String(event?.detail?.type || '').trim() !== 'profile') return;
        const eventUserId = String(event?.detail?.userId || '').trim();
        const currentUserId = String(this.currentActor?.id || '').trim();
        const hasInlineAvatar = Object.prototype.hasOwnProperty.call(event?.detail || {}, 'enabled')
            || Object.prototype.hasOwnProperty.call(event?.detail || {}, 'config');
        if (eventUserId && currentUserId && eventUserId !== currentUserId) {
            if (!hasInlineAvatar) return;
            const profileAvatar = {
                enabled: event.detail.enabled !== false,
                config: normalizeAvatarConfig(event.detail.config, `profile:${eventUserId}`),
                fallbackLetter: '',
                updatedAt: new Date().toISOString()
            };
            this.applyRealtimeParticipantAvatar?.({
                meetingId: String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim(),
                userId: eventUserId,
                profileAvatar
            });
            this.renderParticipantLayout();
            this.renderMeetingList();
            return;
        }
        if (!this.state.session?.participantIdentity) return;
        try {
            const currentOverride = this.loadCurrentWebMeetAvatarOverride?.() || null;
            this.state.webMeetAvatarOverride = currentOverride;
            let effectiveSourceAvatar = null;
            if (hasInlineAvatar) {
                const participantId = String(this.state.session?.participantIdentity || '').trim();
                const userId = String(currentUserId || event?.detail?.config?.agentId?.replace(/^profile:/, '') || '').trim();
                const fallbackAvatarId = `profile:${userId || participantId}`;
                const profileSourceAvatar = {
                    enabled: event.detail.enabled !== false,
                    config: normalizeAvatarConfig(event.detail.config, fallbackAvatarId),
                    fallbackLetter: '',
                    user: userId ? { id: userId } : null,
                    updatedAt: new Date().toISOString()
                };
                effectiveSourceAvatar = buildWebMeetAvatarSource({
                    profileAvatar: profileSourceAvatar,
                    override: currentOverride,
                    userId,
                    participantId
                });
                const profileAvatar = this.webMeetRoom.buildAvatarProjection(effectiveSourceAvatar, participantId);
                this.applyRealtimeParticipantAvatar?.({
                    meetingId: String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim(),
                    participantId,
                    userId,
                    profileAvatar
                });
                this.renderParticipantLayout();
                this.renderMeetingList();
                await this.webMeetRoom.publishAvatarProjection(profileAvatar, effectiveSourceAvatar);
                this.syncVoiceResponsiveAvatar?.();
            }
            await this.publishCurrentParticipantAvatar(hasInlineAvatar
                ? {
                    force: true,
                    avatar: effectiveSourceAvatar,
                    skipRealtime: true
                }
                : { force: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || 'Avatar update failed.');
            this.setError(`Profile avatar was saved, but WebMeet could not publish the room avatar: ${message}`);
        }
    },

    handleProfileAvatarWorkspaceEvent(event) {
        const payload = parseWebMeetEvent(event?.data).payload;
        const userId = String(payload?.userId || '').trim();
        if (!userId) return;
        const currentUserId = String(this.currentActor?.id || '').trim();
        if (
            currentUserId
            && userId === currentUserId
            && this.state.session?.participantIdentity
            && !this.isGuestSession()
        ) {
            const currentOverride = this.loadCurrentWebMeetAvatarOverride?.() || null;
            this.state.webMeetAvatarOverride = currentOverride;
            if (!currentOverride) {
                this.participantLayoutController?.refreshAvatarForUser?.(userId);
            }
            void this.publishCurrentParticipantAvatar({ force: true }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error || 'Avatar update failed.');
                this.setError(`Profile avatar changed, but WebMeet could not publish the room avatar: ${message}`);
            });
        }
    }
};

import {
    buildStableParticipantId,
    createParticipantInstanceId,
    isAdminActor,
    readStoredGuestDisplayName,
    readRoomIdFromExplorerHash,
    readRoomIdFromUrl,
    storeGuestDisplayName,
    syncBrowserRoomUrl
} from '../services/dashboard-utils.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';
import { readWebMeetResume, writeWebMeetResume } from '../services/webmeet-session-store.js';

function normalizeRoomPayload(payload = null) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const wrapped = payload.meeting || payload.room;
    if (wrapped && typeof wrapped === 'object') {
        return wrapped;
    }
    const roomId = String(payload.roomId || payload.id || '').trim();
    return roomId ? payload : null;
}

export const dashboardSessionMethods = {
    prepareInitialRouteState() {
        const resume = readWebMeetResume();
        const initialRoomId = String(
            globalThis.__WEBMEET_INITIAL_ROOM_ID__
            || readRoomIdFromUrl()
            || (resume?.open ? resume.roomId : '')
            || ''
        ).trim();
        this.initialRoomId = initialRoomId;
        if (globalThis.__WEBMEET_GUEST_ENTRY__ && initialRoomId) {
            this.state.guestEntry = {
                active: true,
                roomId: initialRoomId,
                displayName: '',
                status: 'Checking room access...',
                joining: true,
                error: ''
            };
        }
    },

    async loadInitialDashboardData() {
        try {
            const initialRoomId = String(this.initialRoomId || globalThis.__WEBMEET_INITIAL_ROOM_ID__ || readRoomIdFromUrl() || '').trim();
            if (globalThis.__WEBMEET_GUEST_ENTRY__ && initialRoomId) {
                await this.prepareGuestRoomEntry(initialRoomId);
                return;
            }
            await this.loadMeetings();
            this.startWorkspaceEvents();
            if (initialRoomId) {
                await this.joinRoomFromExplorerHash(initialRoomId);
                return;
            }
            const hashRoomId = readRoomIdFromExplorerHash();
            if (hashRoomId) {
                await this.joinRoomFromExplorerHash(hashRoomId);
                return;
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

    async joinRoomFromExplorerHash(roomId) {
        const targetRoomId = String(roomId || '').trim();
        if (!targetRoomId) {
            return;
        }
        this.state.selectedMeetingId = targetRoomId;
        if (!this.state.meetings.some((entry) => String(entry.id || entry.roomId || '') === targetRoomId)) {
            const details = await runWebMeetTool('webmeet_room_get', {
                roomId: targetRoomId,
                includeParticipants: false
            }).catch(() => null);
            const meeting = details?.meeting || details?.room || null;
            if (!meeting) {
                this.state.selectedMeetingId = this.state.meetings[0]?.id || '';
                this.renderAll();
                return;
            }
            this.state.meetings = [
                ...this.state.meetings,
                {
                    ...meeting,
                    id: String(meeting.id || meeting.roomId || targetRoomId),
                    roomId: String(meeting.roomId || meeting.id || targetRoomId),
                    title: String(meeting.title || meeting.name || 'Room'),
                    name: String(meeting.name || meeting.title || 'Room')
                }
            ];
        }
        await this.loadMeetingDetails({ expectedMeetingId: targetRoomId });
        this.renderAll();
        await this.selectAndJoinMeeting({ dataset: { id: targetRoomId } });
    },

    async bootstrapGuestRoomEntry(roomEntry = {}) {
        const roomId = String(roomEntry.roomId || '').trim();
        const displayName = String(roomEntry.displayName || '').trim();
        if (!roomId) {
            throw new Error('Missing room id.');
        }
        if (!displayName) {
            throw new Error('Missing display name.');
        }
        this.state.guestEntry = {
            active: true,
            roomId,
            displayName,
            status: 'Joining room...',
            joining: true,
            error: ''
        };
        this.renderAll();
        const participantId = this.getStableParticipantId(displayName);
        storeGuestDisplayName(displayName);
        const session = await runWebMeetTool('webmeet_room_join_guest', {
            roomId,
            displayName,
            participantId
        });
        const detailsToolName = globalThis.__WEBMEET_GUEST_ENTRY__ ? 'webmeet_room_public_get' : 'webmeet_room_get';
        const details = await runWebMeetTool(detailsToolName, {
            roomId,
            includeParticipants: true
        }).catch(() => ({}));
        const meeting = session?.meeting || details?.meeting || details?.room || { id: roomId, roomId, title: roomId, name: roomId };
        const normalizedMeeting = {
            ...meeting,
            id: String(meeting.id || meeting.roomId || roomId),
            roomId: String(meeting.roomId || meeting.id || roomId),
            title: String(meeting.title || meeting.name || 'Room'),
            name: String(meeting.name || meeting.title || 'Room')
        };
        this.state.meetings = [normalizedMeeting];
        this.state.selectedMeetingId = normalizedMeeting.id;
        this.state.canManageRooms = Boolean(details?.canManageRooms);
        this.state.guestEntry = {
            active: false,
            roomId,
            displayName,
            status: '',
            joining: false,
            error: ''
        };
        this.renderAll();

        this.state.session = {
            ...session,
            meeting: session?.meeting || normalizedMeeting,
            guest: Boolean(session?.participant?.guest)
        };
        syncBrowserRoomUrl(roomId, { replace: true });
        writeWebMeetResume({ open: true, roomId });
        await this.loadParticipantsForMeetings();
        await this.loadMeetingDetails({ expectedMeetingId: normalizedMeeting.id });
        this.setConnectingRoomTransition(normalizedMeeting.title || 'room', { render: false });
        this.renderAll();
        try {
            this.state.skipConnectedAvatarRepublishOnce = true;
            await this.connectRoom();
            await this.restorePersistedMediaState?.();
            try {
                await this.publishCurrentParticipantAvatar({ force: true });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || 'Avatar publish failed.');
                this.setError(`WebMeet could not publish the avatar: ${message}`);
            }
        } finally {
            this.clearRoomTransitionMessage({ render: false });
            this.renderMeetingSummary();
        }
    },

    async prepareGuestRoomEntry(roomId) {
        const targetRoomId = String(roomId || '').trim();
        if (!targetRoomId) {
            this.showGuestAccessDenied();
            return;
        }
        this.state.guestEntry = {
            active: true,
            roomId: targetRoomId,
            displayName: readStoredGuestDisplayName(),
            status: 'Checking room access...',
            joining: true,
            error: ''
        };
        this.renderAll();
        try {
            const details = await runWebMeetTool('webmeet_room_public_get', {
                roomId: targetRoomId
            });
            const meeting = normalizeRoomPayload(details);
            if (!meeting || String(meeting.roomType || '').trim() !== 'guest') {
                this.showGuestAccessDenied();
                return;
            }
            await this.showGuestRoomEntry(targetRoomId, meeting);
        } catch (_) {
            this.showGuestAccessDenied();
        }
    },

    showGuestAccessDenied() {
        const showAccessDenied = globalThis.__WEBMEET_SHOW_ACCESS_DENIED__;
        if (typeof showAccessDenied === 'function') {
            showAccessDenied('This room is not available as a public room. Sign in to access WebMeet rooms.');
            return;
        }
        this.state.guestEntry = {
            active: true,
            roomId: '',
            displayName: '',
            status: 'This room is not available as a public room. Sign in to access WebMeet rooms.',
            joining: false,
            error: 'This room is not available as a public room. Sign in to access WebMeet rooms.'
        };
        this.renderAll();
    },

    async showGuestRoomEntry(roomId, meeting = null) {
        const targetRoomId = String(roomId || '').trim();
        const title = String(meeting?.title || meeting?.name || 'Public room').trim() || 'Public room';
        this.state.meetings = [{
            ...(meeting || {}),
            id: String(meeting?.id || meeting?.roomId || targetRoomId),
            roomId: String(meeting?.roomId || meeting?.id || targetRoomId),
            title,
            name: String(meeting?.name || title)
        }];
        this.state.selectedMeetingId = targetRoomId;
        this.state.canManageRooms = false;
        this.state.guestEntry = {
            active: false,
            roomId: targetRoomId,
            displayName: readStoredGuestDisplayName(),
            status: 'Enter your name to join this public room.',
            joining: false,
            error: ''
        };
        this.renderAll();
        const result = await assistOS.UI.showModal('webmeet-guest-entry-modal', {
            displayName: this.state.guestEntry.displayName,
            status: this.state.guestEntry.status
        }, true);
        const displayName = String(result?.displayName || '').trim();
        if (!displayName) {
            return;
        }
        try {
            await this.bootstrapGuestRoomEntry({ roomId: targetRoomId, displayName });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || 'Failed to join room.');
            this.state.guestEntry = {
                active: false,
                roomId: targetRoomId,
                displayName,
                status: message,
                joining: false,
                error: message
            };
            this.renderAll();
            this.setError(message);
        }
    },

    canManageRooms() {
        if (typeof this.state.canManageRooms === 'boolean') {
            return this.state.canManageRooms;
        }
        return isAdminActor(this.currentActor);
    },

    isGuestSession() {
        const session = this.state?.session;
        return session?.guest === true;
    },

    getGuestToken() {
        return '';
    },

    registerWindowPresenceHandlers() {
        this.presenceController.registerWindowHandlers();
    },

    unregisterWindowPresenceHandlers() {
        this.presenceController.unregisterWindowHandlers();
    },

    sendLeaveKeepalive(meetingId, participantId) {
        this.presenceController.sendLeaveKeepalive(meetingId, participantId);
    },

    getStableParticipantId(displayName = '') {
        if (this.cachedStableParticipantId) {
            return this.cachedStableParticipantId;
        }
        const userEmail = String(window?.assistOS?.user?.email || '').trim();
        const baseSeed = userEmail || (String(displayName || 'user').trim() || 'user');
        const sessionKey = 'webmeet.participant.instanceId';
        try {
            let instanceId = String(window?.sessionStorage?.getItem(sessionKey) || '').trim();
            if (!instanceId) {
                instanceId = createParticipantInstanceId();
                window?.sessionStorage?.setItem(sessionKey, instanceId);
            }
            const created = buildStableParticipantId(`${baseSeed}-${instanceId}`);
            this.cachedStableParticipantId = created;
            return created;
        } catch {
            this.cachedStableParticipantId = buildStableParticipantId(`${baseSeed}-${createParticipantInstanceId()}`);
            return this.cachedStableParticipantId;
        }
    },

    removeParticipantFromMeetingList(meetingId, participantId) {
        this.meetingListController.removeParticipantFromMeetingMap(
            this.state.meetingParticipantsById,
            meetingId,
            participantId
        );
    },

    async selectMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        this.state.selectedMeetingId = nextMeetingId;
        try {
            await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
        } finally {
            this.renderAll();
        }
    },

    async selectAndJoinMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        if (!nextMeetingId) return;
        if (this.state.joiningMeetingId) return;
        const nextMeeting = this.state.meetings.find((entry) => String(entry?.id || '').trim() === nextMeetingId);
        const isArchived = String(nextMeeting?.status || '').trim().toLowerCase() === 'archived'
            || Boolean(String(nextMeeting?.archivedAt || '').trim());
        if (isArchived) {
            await this.selectMeeting(element);
            return;
        }
        if (globalThis.__WEBMEET_GUEST_ENTRY__ && String(nextMeeting?.roomType || '').trim() === 'guest') {
            await this.showGuestRoomEntry(nextMeetingId, nextMeeting);
            return;
        }
        const currentMeetingId = String(this.state.session?.meeting?.id || '').trim();
        const currentlyJoined = Boolean(this.state.session?.participantIdentity);
        const switchingRoom = Boolean(currentlyJoined && currentMeetingId && currentMeetingId !== nextMeetingId);
        if (currentlyJoined && currentMeetingId === nextMeetingId) {
            this.state.selectedMeetingId = nextMeetingId;
            try {
                await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
            } finally {
                this.renderAll();
            }
            return;
        }

        if (switchingRoom) {
            const currentMeeting = this.state.meetings.find((entry) => entry.id === currentMeetingId);
            const nextMeeting = this.state.meetings.find((entry) => entry.id === nextMeetingId);
            const confirmed = window.confirm(
                `Leave "${currentMeeting?.title || 'current room'}" and join "${nextMeeting?.title || 'selected room'}"?`
            );
            if (!confirmed) {
                return;
            }
            this.setDisconnectingRoomTransition(currentMeeting?.title || 'room');
            await this.unjoinCurrentSession({ preserveDisplayName: true, manageTransition: false });
        }

        this.state.selectedMeetingId = nextMeetingId;
        this.state.joiningMeetingId = nextMeetingId;
        this.setConnectingRoomTransition(this.getMeetingTitleById(nextMeetingId, 'room'), { render: false });
        this.renderMeetingList();
        try {
            await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
            this.renderAll();
            if (!this.selectedMeeting) {
                this.clearRoomTransitionMessage();
                return;
            }
            const defaultName = String(this.state.session?.participant?.displayName || '').trim();
            await this.joinMeeting({ displayNameOverride: defaultName });
            this.setMobilePanel('room');
        } catch (error) {
            const message = String(error?.message || error || '').trim();
            if (message.includes('Unsupported state or unable to authenticate data')) {
                this.setError('Room data cannot be decrypted with the current WebMeet key. Restore the previous Ploinky master key or recreate the room.');
            } else {
                this.setError(message || 'Failed to join room.');
            }
        } finally {
            if (this.state.joiningMeetingId === nextMeetingId) {
                this.state.joiningMeetingId = '';
                this.renderMeetingList();
            }
            if (!this.state.session?.participantIdentity) {
                this.clearRoomTransitionMessage({ render: false });
                this.renderMeetingSummary();
            }
        }
    },

    async sendChat() {
        return this.chatComponent.sendChat();
    },

    async closeModal(target) {
        if (this.state.session?.participantIdentity) {
            await this.unjoinCurrentSession({ preserveDisplayName: false });
        }
        this.participantLayoutController?.dispose?.();
        this.roomNotificationSoundService?.teardown?.();
        window.removeEventListener('assistOS:avatar-settings-updated', this.handleAvatarSettingsUpdatedEvent);
        window.removeEventListener('webmeet:participant-audio-preview', this.handleParticipantAudioPreviewEvent);
        assistOS.UI.closeModal(target || this.element);
    },

    isLocalParticipantIdentity(participant) {
        const participantIdentity = String(participant?.identity || participant || '').trim();
        const localIdentity = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        return Boolean(participantIdentity && localIdentity && participantIdentity === localIdentity);
    },

    playParticipantJoinSound(participant) {
        if (!participant?.identity || this.isLocalParticipantIdentity(participant)) return;
        this.roomNotificationSoundService?.playJoin?.();
    },

    playParticipantLeaveSound(participant) {
        if (!participant?.identity || this.isLocalParticipantIdentity(participant)) return;
        this.roomNotificationSoundService?.playLeave?.();
    }
};

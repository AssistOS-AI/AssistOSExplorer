import { getCurrentActorDisplayName, requestGuestDisplayName, syncBrowserRoomUrl } from '../services/dashboard-utils.js';
import { readWebMeetResume, writeWebMeetResume } from '../services/webmeet-session-store.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';
import {
    getCurrentProfileAvatar,
    loadAxiFacePacks,
    normalizeAvatarConfig
} from '../services/webmeet-profile-avatar-runtime.js';
import {
    buildWebMeetAvatarSource,
    buildWebMeetAvatarOverrideConfig,
    clearWebMeetAvatarOverride,
    getWebMeetAvatarPreset,
    loadWebMeetAvatarOverride,
    saveWebMeetAvatarOverride
} from '../services/webmeet-avatar-override.js';
import { WEBMEET_EVENT_TYPES } from '../services/webmeet-events.js';
import {
    AVATAR_SOURCE_MODES,
    deriveAvatarSourceMode
} from '../services/avatar-settings-model.js';
import { applyPermanentRoomDeletion } from './permanent-room-deletion.js';

const runTool = runWebMeetTool;

export const meetingActionMethods = {
    async createMeeting() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can create rooms.');
            return;
        }

        const result = await assistOS.UI.showModal('create-room-modal', {}, true);
        if (!result || !result.roomTitle) return;

        const meeting = await runTool('webmeet_room_create', {
            name: result.roomTitle,
            roomType: result.roomType
        });

        if (result.roomType === 'guest' && meeting?.id) {
            const guestUrl = this.buildRoomLink(meeting.id);
            await assistOS.UI.showModal('confirm-action-modal', {
                message: `Public meeting created! Share this link:\n\n${guestUrl}\n\n(Click Yes to copy to clipboard)`
            }, true);
            try {
                await navigator.clipboard.writeText(guestUrl);
                this.setError('Public meeting link copied to clipboard!');
            } catch {
                this.setError(`Public meeting link: ${guestUrl}`);
            }
        }

        this.state.selectedMeetingId = meeting?.id || this.state.selectedMeetingId;
        await this.loadMeetings();
        this.renderAll();
    },

    buildRoomLink(meetingId) {
        const roomId = String(meetingId || '').trim();
        const agentName = String(globalThis.__WEBMEET_AGENT_NAME__ || 'webmeetAgent').trim() || 'webmeetAgent';
        const url = new URL(`/${encodeURIComponent(agentName)}/roomLoader.html`, window.location.origin);
        url.searchParams.set('roomId', roomId);
        return url.toString();
    },

    async copyRoomLink(target) {
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) {
            this.setError('Room unavailable.');
            return;
        }
        const roomLink = this.buildRoomLink(meeting.id);
        try {
            await navigator.clipboard.writeText(roomLink);
            this.setError('Room link copied to clipboard.');
        } catch {
            this.setError(`Room link: ${roomLink}`);
        }
    },

    async openRoomSettings(target) {
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) {
            this.setError('Room unavailable.');
            return;
        }
        if (!this.canManageRooms()) {
            this.setError('Only admin can manage room settings.');
            return;
        }
        const isArchived = String(meeting.status || '').trim().toLowerCase() === 'archived'
            || Boolean(String(meeting.archivedAt || '').trim());
        if (isArchived) {
            this.setError('Archived rooms cannot be modified.');
            return;
        }
        const roboTeamSettings = await this.loadRoboTeamSettings(meeting.id);
        if (!roboTeamSettings) {
            this.setError('RoboTeam settings are unavailable.');
            return;
        }
        const result = await assistOS.UI.showModal('webmeet-room-settings-modal', {
            'room-id': meeting.id,
            'room-title': meeting.title || meeting.name || 'Room',
            'room-link': this.buildRoomLink(meeting.id),
            'robo-team-settings': encodeURIComponent(JSON.stringify(roboTeamSettings))
        }, true);
        if (!result) return;

        if (await applyPermanentRoomDeletion(this, meeting, result, runTool)) {
            return;
        }

        if (result.archive === true) {
            await runTool('webmeet_room_archive', { roomId: meeting.id });
            const activeRoomId = String(this.state.session?.meeting?.id || '').trim();
            if (activeRoomId && activeRoomId === String(meeting.id || '').trim()) {
                void this.leaveMeeting?.({ skipConfirmation: true }).catch(() => {});
            }
            await this.loadMeetings();
            this.renderAll();
            this.setError('Room archived successfully.');
            return;
        }

        const nextName = String(result.name || '').trim();
        const currentName = String(meeting.title || meeting.name || '').trim();
        if (nextName && nextName !== currentName) {
            const updated = await runTool('webmeet_room_rename', { roomId: meeting.id, name: nextName });
            if (updated?.title && String(this.state.session?.meeting?.id || '').trim() === String(meeting.id || '').trim()) {
                try {
                    await this.publishRealtimePayload({
                        type: WEBMEET_EVENT_TYPES.MEETING_RENAMED,
                        meetingId: meeting.id,
                        title: updated.title,
                        updatedAt: updated.updatedAt || new Date().toISOString()
                    });
                } catch (_) {
                    // Persisted rename already succeeded; realtime delivery is best effort.
                }
            }
        }

        if (result.roboTeam) {
            await this.saveRoboTeamSettings(meeting.id, result.roboTeam);
        }

        await this.loadMeetings();
        this.renderAll();
    },

    async loadRoboTeamSettings(roomId) {
        const id = String(roomId || '').trim();
        if (!id) return null;
        const result = await runTool('webmeet_robo_team_get', { roomId: id });
        return result?.settings || null;
    },

    async saveRoboTeamSettings(roomId, settings) {
        const id = String(roomId || '').trim();
        if (!id || !settings) return;
        const result = await runTool('webmeet_robo_team_update', { roomId: id, settings });
        const meetingNotes = result?.settings?.meetingNotes || null;
        if (meetingNotes && String(this.state.session?.meeting?.id || '') === id) {
            this.state.session.meetingNotes = meetingNotes;
            this.meetingNotesTranscription?.sync?.();
            this.renderMeetingSummary();
            await this.publishRealtimePayload({
                type: WEBMEET_EVENT_TYPES.MEETING_NOTES_SETTINGS_CHANGED,
                meetingId: id,
            }).catch(() => {});
        }
        return result;
    },

    getMeetingFromActionTarget(target) {
        const source = target?.target || target;
        const meetingId = String(source?.dataset?.id || source?.closest?.('[data-id]')?.dataset?.id || '').trim();
        if (!meetingId) {
            return this.selectedMeeting;
        }
        return this.state.meetings.find((entry) => entry.id === meetingId) || null;
    },

    async joinMeeting(options = {}) {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        this.setConnectingRoomTransition(meeting.title || 'room');
        const displayName = String(options.displayNameOverride || getCurrentActorDisplayName()).trim();
        const participantId = this.getStableParticipantId(displayName);
        const payload = { meetingId: meeting.id, participantId };
        if (displayName) {
            payload.displayName = displayName;
        }
        this.stopWorkspaceEvents();
        try {
            try {
                await this.webMeetRoom.join(payload);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!displayName && /missing required argument "displayName"/i.test(message)) {
                    const guestDisplayName = await requestGuestDisplayName();
                    await this.webMeetRoom.join({
                        ...payload,
                        displayName: guestDisplayName
                    });
                } else {
                    throw error;
                }
            }
            syncBrowserRoomUrl(meeting.id);
            writeWebMeetResume({ open: true, roomId: meeting.id });
            await this.primeCurrentParticipantAvatarProjection({ force: true });
            this.state.skipConnectedAvatarRepublishOnce = true;
            await this.webMeetRoom.connectLiveKit();
            if (!this.isGuestSession()) {
                this.startWorkspaceEvents();
            }
            await this.restorePersistedMediaState();
            try {
                const details = await this.webMeetRoom.refreshState();
                if (Array.isArray(details?.agents)) {
                    this.state.agents = details.agents;
                }
                this.syncParticipantsFromRoom(this.room, window.LivekitClient?.Track || null);
            } catch (_) {
                // LiveKit is connected; state reconciliation can recover on the next roster refresh.
            }
            try {
                await this.publishCurrentParticipantAvatar({ force: true });
            } catch (error) {
                const stillJoined = String(this.state.session?.meeting?.id || '').trim() === String(meeting.id || '').trim()
                    && Boolean(String(this.state.session?.participantIdentity || '').trim());
                if (stillJoined) {
                    const message = error instanceof Error ? error.message : String(error || 'Avatar publish failed.');
                    this.setError(`WebMeet could not publish the avatar: ${message}`);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.roomState = message;
            this.setError(message);
            if (!this.isGuestSession()) {
                this.startWorkspaceEvents();
            }
            return;
        } finally {
            this.clearRoomTransitionMessage({ render: false });
            this.renderMeetingSummary();
        }
    },

    async restorePersistedMediaState() {
        const resume = readWebMeetResume();
        if (!resume) return;
        if (resume.media.microphone && !this.state.media.microphone) {
            await this.runMediaToggleWithLoading('microphone', () => this.mediaController.toggleMicrophone()).catch(() => {});
        }
        if (resume.media.camera && !this.state.media.camera) {
            await this.runMediaToggleWithLoading('camera', () => this.mediaController.toggleCamera()).catch(() => {});
        }
    },

    getCurrentAvatarOverrideUserId() {
        if (this.isGuestSession()) {
            const participantId = String(this.state.session?.participantIdentity || '').trim();
            return participantId ? `guest:${participantId}` : '';
        }
        return String(this.currentActor?.id || this.state.session?.participant?.userId || '').trim();
    },

    loadCurrentWebMeetAvatarOverride() {
        const userId = this.getCurrentAvatarOverrideUserId();
        return loadWebMeetAvatarOverride(userId);
    },

    setCurrentWebMeetAvatarOverride(override = null) {
        const userId = this.getCurrentAvatarOverrideUserId();
        const normalized = saveWebMeetAvatarOverride(userId, override);
        this.state.webMeetAvatarOverride = normalized;
        return normalized;
    },

    clearCurrentWebMeetAvatarOverride() {
        const userId = this.getCurrentAvatarOverrideUserId();
        clearWebMeetAvatarOverride(userId);
        this.state.webMeetAvatarOverride = null;
    },

    async resolveCurrentWebMeetAvatarSource(options = {}) {
        const participantId = String(options.participantId || this.state.session?.participantIdentity || '').trim();
        const userId = this.getCurrentAvatarOverrideUserId();
        const override = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = override;
        let profileAvatar = options.avatar && typeof options.avatar === 'object'
            ? options.avatar
            : null;
        if (!profileAvatar && override) {
            return buildWebMeetAvatarSource({
                profileAvatar: null,
                override,
                userId,
                participantId
            });
        }
        if (!profileAvatar) {
            try {
                profileAvatar = await getCurrentProfileAvatar({ force: Boolean(options.force) });
            } catch (error) {
                if (!override) throw error;
                profileAvatar = null;
            }
        }
        return buildWebMeetAvatarSource({
            profileAvatar,
            override,
            userId,
            participantId
        });
    },

    async resolveCurrentParticipantAvatarProjection(options = {}) {
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!participantId) return null;
        const sourceAvatar = options.avatar && typeof options.avatar === 'object'
            ? options.avatar
            : await this.resolveCurrentWebMeetAvatarSource({
                force: Boolean(options.force),
                participantId
            });
        if (!sourceAvatar) {
            return {
                sourceAvatar: null,
                avatar: {
                    enabled: false,
                    config: null,
                    fallbackLetter: ''
                }
            };
        }
        return {
            sourceAvatar,
            avatar: this.webMeetRoom.buildAvatarProjection(sourceAvatar, participantId)
        };
    },

    async primeCurrentParticipantAvatarProjection(options = {}) {
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!participantId) return null;
        let resolved = null;
        try {
            resolved = await this.resolveCurrentParticipantAvatarProjection(options);
        } catch (_) {
            resolved = {
                sourceAvatar: null,
                avatar: {
                    enabled: false,
                    config: null,
                    fallbackLetter: ''
                }
            };
        }
        if (!resolved?.avatar) return null;
        this.setRoomAvatar(participantId, resolved.avatar);
        if (this.state.session?.participant && typeof this.state.session.participant === 'object') {
            this.state.session = {
                ...this.state.session,
                participant: {
                    ...this.state.session.participant,
                    profileAvatar: resolved.avatar
                }
            };
        }
        const userId = String(
            resolved.sourceAvatar?.user?.id
            || resolved.avatar?.config?.agentId?.replace(/^profile:/, '')
            || this.currentActor?.id
            || ''
        ).trim();
        this.applyRealtimeParticipantAvatar?.({
            meetingId,
            participantId,
            userId,
            profileAvatar: resolved.avatar
        });
        return resolved;
    },

    async applyWebMeetAvatarPreset(target) {
        const source = target?.target || target;
        const presetId = String(source?.dataset?.avatarPreset || source?.closest?.('[data-avatar-preset]')?.dataset?.avatarPreset || '').trim();
        const preset = getWebMeetAvatarPreset(presetId);
        let profileAvatar = null;
        try {
            profileAvatar = await getCurrentProfileAvatar({ force: true });
        } catch (_) {
            profileAvatar = null;
        }
        const currentOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = currentOverride;
        const config = buildWebMeetAvatarOverrideConfig({
            profileAvatar,
            override: currentOverride,
            userId: this.getCurrentAvatarOverrideUserId(),
            participantId: this.state.session?.participantIdentity || '',
            patch: preset.patch
        });
        this.setCurrentWebMeetAvatarOverride({ config });
        this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        this.state.avatarQuickMenuVisible = false;
        this.state.avatarSubmenuVisible = false;
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.syncVoiceResponsiveAvatar?.();
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        this.setError(published
            ? `WebMeet avatar set to ${preset.label} and published.`
            : `WebMeet avatar preset saved. Join a room to publish ${preset.label}.`);
    },

    async applyWebMeetAvatarStyle(target) {
        const source = target?.target || target;
        const style = String(source?.dataset?.avatarStyle || source?.closest?.('[data-avatar-style]')?.dataset?.avatarStyle || '').trim();
        if (!style) return;
        let profileAvatar = null;
        try {
            profileAvatar = await getCurrentProfileAvatar({ force: true });
        } catch (_) {
            profileAvatar = null;
        }
        const currentOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = currentOverride;
        const config = buildWebMeetAvatarOverrideConfig({
            profileAvatar,
            override: currentOverride,
            userId: this.getCurrentAvatarOverrideUserId(),
            participantId: this.state.session?.participantIdentity || '',
            patch: { style, generated: true, src: '', packSrc: '' }
        });
        this.setCurrentWebMeetAvatarOverride({ config });
        this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        this.state.avatarQuickMenuVisible = false;
        this.state.avatarSubmenuVisible = false;
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        this.setError(published
            ? `WebMeet avatar style set to ${style} and published.`
            : `WebMeet avatar style saved. Join a room to publish ${style}.`);
    },

    async applyWebMeetAvatarPack(target) {
        const source = target?.target || target;
        const packSrc = String(source?.dataset?.avatarPackSrc || source?.closest?.('[data-avatar-pack-src]')?.dataset?.avatarPackSrc || '').trim();
        if (!packSrc) return;
        let profileAvatar = null;
        try {
            profileAvatar = await getCurrentProfileAvatar({ force: true });
        } catch (_) {
            profileAvatar = null;
        }
        const currentOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = currentOverride;
        const config = buildWebMeetAvatarOverrideConfig({
            profileAvatar,
            override: currentOverride,
            userId: this.getCurrentAvatarOverrideUserId(),
            participantId: this.state.session?.participantIdentity || '',
            patch: {
                sourceMode: AVATAR_SOURCE_MODES.PACK,
                generated: false,
                src: '',
                packSrc
            }
        });
        this.setCurrentWebMeetAvatarOverride({ config });
        this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        this.state.avatarQuickMenuVisible = false;
        this.state.avatarSubmenuVisible = false;
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        const packLabel = this.state.axiFacePacks.find((entry) => String(entry?.manifestSrc || '').trim() === packSrc)?.label
            || packSrc.split('/').slice(-2, -1)[0]
            || 'selected pack';
        this.setError(published
            ? `WebMeet avatar pack set to ${packLabel} and published.`
            : `WebMeet avatar pack saved as ${packLabel}. Join a room to publish it.`);
    },

    async resetWebMeetAvatarOverride() {
        this.clearCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverrideDraft = null;
        this.state.avatarQuickMenuVisible = false;
        this.state.avatarSubmenuVisible = false;
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        this.setError(published
            ? 'WebMeet avatar reset to profile avatar and published.'
            : 'WebMeet avatar reset to profile avatar. Join a room to publish it.');
    },

    toggleAvatarQuickMenu() {
        this.state.avatarQuickMenuVisible = !this.state.avatarQuickMenuVisible;
        if (!this.state.avatarQuickMenuVisible) {
            this.state.avatarSubmenuVisible = false;
        }
        this.renderAvatarControls?.();
    },

    toggleAvatarSubmenu() {
        this.state.avatarSubmenuVisible = !this.state.avatarSubmenuVisible;
        this.renderAvatarControls?.();
    },

    handleWebMeetAvatarSettingsChange(event = null) {
        const currentConfig = this.state.webMeetAvatarOverrideDraft?.config
            || this.state.webMeetAvatarOverride?.config
            || this.state.session?.participant?.profileAvatar?.config
            || {};
        const fallbackId = `profile:${this.getCurrentAvatarOverrideUserId() || this.state.session?.participantIdentity || 'current-user'}`;
        const nextConfig = event?.detail?.config || this.avatarSettingsForm?.webSkelPresenter?.getConfig?.() || currentConfig;
        this.state.webMeetAvatarOverrideDraft = {
            config: normalizeAvatarConfig({
                ...nextConfig,
                agentId: currentConfig.agentId || nextConfig.agentId || fallbackId,
                seed: nextConfig.seed || currentConfig.seed || currentConfig.agentId || fallbackId
            }, fallbackId)
        };
        this.renderAvatarControls?.();
    },

    syncWebMeetAvatarSettingsDraftFromInputs() {
        const currentOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = currentOverride;
        const currentConfig = this.state.webMeetAvatarOverrideDraft?.config
            || currentOverride?.config
            || this.state.session?.participant?.profileAvatar?.config
            || {};
        const fallbackId = `profile:${this.getCurrentAvatarOverrideUserId() || this.state.session?.participantIdentity || 'current-user'}`;
        const formConfig = this.avatarSettingsForm?.webSkelPresenter?.getConfig?.() || currentConfig;
        this.state.webMeetAvatarOverrideDraft = {
            config: normalizeAvatarConfig({
                ...formConfig,
                agentId: currentConfig.agentId || formConfig.agentId || fallbackId,
                seed: formConfig.seed || currentConfig.seed || currentConfig.agentId || fallbackId
            }, fallbackId)
        };
        this.renderAvatarControls?.();
    },

    async applyWebMeetAvatarSettings() {
        this.syncWebMeetAvatarSettingsDraftFromInputs();
        const draft = this.state.webMeetAvatarOverrideDraft;
        if (draft) {
            this.setCurrentWebMeetAvatarOverride(draft);
            this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        } else {
            this.clearCurrentWebMeetAvatarOverride();
            this.state.webMeetAvatarOverrideDraft = null;
        }
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.syncVoiceResponsiveAvatar?.();
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        this.closeMediaSettings?.();
        if (draft) {
            this.setError(published
                ? 'WebMeet avatar override applied and published.'
                : 'WebMeet avatar override saved. Join a room to publish it.');
            return;
        }
        this.setError(published
            ? 'WebMeet avatar reset to profile avatar and published.'
            : 'WebMeet avatar reset to profile avatar. Join a room to publish it.');
    },

    async publishCurrentParticipantAvatar(options = {}) {
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!meetingId || !participantId) return null;
        const resolved = await this.resolveCurrentParticipantAvatarProjection(options);
        if (!resolved?.avatar) return null;
        const { avatar, sourceAvatar } = resolved;
        const updated = await this.webMeetRoom.publishAvatar(avatar);
        const profileAvatar = avatar && typeof avatar === 'object'
            ? {
                ...avatar,
                ...(updated?.profileAvatar && typeof updated.profileAvatar === 'object'
                    ? { updatedAt: updated.profileAvatar.updatedAt || avatar.updatedAt }
                    : {})
            }
            : (updated?.profileAvatar || null);
        const userId = String(
            sourceAvatar?.user?.id
            || profileAvatar?.config?.agentId?.replace(/^profile:/, '')
            || this.currentActor?.id
            || ''
        ).trim();
        const realtimeRequested = options.skipRealtime !== true;
        let realtimePublished = !realtimeRequested;
        let effectiveProfileAvatar = profileAvatar;
        if (realtimeRequested && this.room?.localParticipant) {
            try {
                effectiveProfileAvatar = await this.webMeetRoom.publishAvatarProjection(profileAvatar, sourceAvatar)
                    || profileAvatar;
                realtimePublished = true;
            } catch (error) {
                if (this.room?.localParticipant) {
                    throw error;
                }
                // The room disconnected while the avatar was being published. The saved
                // projection will be published by the normal room-connect flow.
            }
        }
        if (!realtimePublished || !realtimeRequested) {
            const currentRuntimeState = this.state.roomAvatarsByParticipantId?.[participantId]?.runtimeState;
            const preserveRuntimeState = currentRuntimeState
                && String(profileAvatar?.config?.expressionMode || '').trim() !== 'manual';
            effectiveProfileAvatar = preserveRuntimeState
                ? { ...profileAvatar, runtimeState: currentRuntimeState }
                : profileAvatar;
            this.applyRealtimeParticipantAvatar?.({
                meetingId,
                participantId,
                userId,
                profileAvatar: effectiveProfileAvatar
            });
        }
        if (!realtimePublished) return null;
        return {
            profileAvatar: effectiveProfileAvatar,
            sourceAvatar,
            userId
        };
    },

    async leaveMeeting() {
        if (this.state.leavingMeeting) return;
        const wasGuestSession = this.isGuestSession();
        const currentMeetingTitle = this.getMeetingTitleById(
            this.state.session?.meeting?.id || this.state.selectedMeetingId,
            this.selectedMeeting?.title || 'room'
        );
        this.state.leavingMeeting = true;
        this.state.roomState = 'Disconnecting';
        this.setDisconnectingRoomTransition(currentMeetingTitle, { render: false });
        this.renderAll();
        try {
            await this.unjoinCurrentSession({ preserveDisplayName: false, manageTransition: false });
            // An explicit leave must not rejoin the room after a refresh, but WebMeet stays open.
            writeWebMeetResume({ roomId: '', media: { microphone: false, camera: false } });
            if (wasGuestSession && typeof this.hostContext?.onGuestExit === 'function') {
                this.hostContext.onGuestExit();
            }
        } finally {
            this.state.leavingMeeting = false;
            this.clearRoomTransitionMessage({ render: false });
            this.renderAll();
        }
    },

    async handleExpandedModalUserClose() {
        // Close is an explicit leave. It stops local media and disconnects before the frame is
        // removed. The server-side leave is best-effort and never blocks closing; the presence
        // keepalive also reports the leave during frame teardown.
        try {
            writeWebMeetResume({ roomId: '', media: { microphone: false, camera: false } });
        } catch (_) {
            // Resume cleanup is best-effort while the panel is torn down.
        }
        const meetingId = String(this.state.session?.meeting?.id || this.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        try {
            this.mediaController?.hardStopMicrophoneTracks?.();
            this.mediaController?.hardStopAllLocalPublishedTracks?.();
            await this.webMeetRoom?.disconnectLiveKit?.();
        } catch (_) {
            // Continue clearing local state even when LiveKit teardown reports an error.
        }
        try {
            void this.webMeetRoom?.leaveCurrentSession?.();
        } catch (_) {
            // The server reconciles membership from the LiveKit disconnect.
        }
        if (meetingId && participantId) {
            this.removeParticipantFromMeetingList(meetingId, participantId);
        }
        this.state.session = null;
        this.state.media = { microphone: false, camera: false, screen: false };
    },

    async unjoinCurrentSession(options = {}) {
        const preserveDisplayName = Boolean(options.preserveDisplayName);
        const manageTransition = options.manageTransition !== false;
        const previousMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const previousParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const preservedName = String(this.state.session?.participant?.displayName || '').trim();
        const wasGuestSession = this.isGuestSession();
        if (manageTransition) {
            this.setDisconnectingRoomTransition(
                this.getMeetingTitleById(previousMeetingId, this.selectedMeeting?.title || 'room'),
                { render: false }
            );
            this.renderMeetingSummary();
        }
        await this.webMeetRoom.disconnectLiveKit();

        if (previousMeetingId && previousParticipantId) {
            try {
                await this.webMeetRoom.leaveCurrentSession();
            } catch (error) {
                // Ignore leave failures during unload or room switching.
            }
        }

        this.removeParticipantFromMeetingList(previousMeetingId, previousParticipantId);
        this.state.session = preserveDisplayName && preservedName ? { participant: { displayName: preservedName } } : null;
        if (!wasGuestSession) {
            await this.loadMeetings();
            this.startWorkspaceEvents();
        }
        if (manageTransition) {
            this.clearRoomTransitionMessage({ render: false });
        }
        this.renderAll();
    },

    async sendPublicChat(meetingId, message) {
        return this.webMeetRoom.sendChat(meetingId, message);
    },

    async attachObserver() {
        await this.attachRoboTeam();
    },

    async attachAssistant() {
        await this.attachRoboTeam();
    },

    async attachScribe() {
        await this.attachRoboTeam();
    },

    async attachRoboTeam() {
        await this.attachAgent('robo_team', 'blackboard_demo');
    },

    async attachAgent(agentType, mode) {
        if (this.isGuestSession()) {
            this.setError('Only admin can attach meeting agents.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before enabling room agents.');
            return;
        }
        try {
            const agent = await runTool('webmeet_agent_attach', { meetingId: meeting.id, agentType, mode });
            await this.loadMeetingDetails();
            if (this.room && window.LivekitClient?.Track) {
                this.syncParticipantsFromRoom(this.room, window.LivekitClient.Track);
            }
            try {
                await this.publishRealtimePayload({
                    type: WEBMEET_EVENT_TYPES.AGENT_DISPATCHED,
                    meetingId: meeting.id,
                    agentId: agent?.id || '',
                    agentType,
                    mode
                });
            } catch (_) {
                // Persisted agent state already succeeded; realtime delivery is best effort.
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

    async detachAgent(target) {
        const source = target?.target || target;
        const agentId = String(source?.dataset?.agentId || source?.dataset?.id || '').trim();
        await this.detachAgentById(agentId);
    },

    async detachAgentFromCard(target) {
        const source = target?.target || target;
        const agentId = String(source?.dataset?.agentId || source?.closest?.('[data-agent-id]')?.dataset?.agentId || '').trim();
        await this.detachAgentById(agentId);
    },

    async detachAgentById(agentId) {
        if (this.isGuestSession() || !this.canManageRooms()) {
            this.setError('Only admin can disable meeting agents.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before disabling room agents.');
            return;
        }
        const id = String(agentId || '').trim();
        if (!id) {
            this.setError('Room agent unavailable.');
            return;
        }
        try {
            const stoppedAgent = await runTool('webmeet_agent_detach', { meetingId: meeting.id, agentId: id });
            await this.loadMeetingDetails();
            if (this.room && window.LivekitClient?.Track) {
                this.syncParticipantsFromRoom(this.room, window.LivekitClient.Track);
            }
            try {
                await this.publishRealtimePayload({
                    type: WEBMEET_EVENT_TYPES.AGENT_DETACHED,
                    meetingId: meeting.id,
                    agentId: id,
                    agentType: stoppedAgent?.agentType || '',
                    mode: stoppedAgent?.mode || ''
                });
            } catch (_) {
                // Persisted detach already succeeded; realtime delivery is best effort.
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

};

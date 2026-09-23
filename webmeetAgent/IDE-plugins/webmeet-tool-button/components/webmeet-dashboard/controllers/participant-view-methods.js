import { isMicrophonePublication } from '../services/microphone-publication.js';
import { buildWebMeetAvatarSource } from '../services/webmeet-avatar-override.js';
import { resumeRemoteAudioPlayback } from '../services/audio-playback-recovery.js';

function getParticipantUserIdFromParticipant(participant = null) {
    return String(
        participant?.userId
        || participant?.attributes?.ploinkyUserId
        || participant?.attributes?.workspaceUserId
        || participant?.attributes?.userId
        || participant?.attributes?.webmeetUserId
        || ''
    ).trim();
}

function parseLiveKitProfileAvatar(attributes = {}) {
    const raw = String(attributes?.webmeetProfileAvatar || '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch (_) {
        return null;
    }
}

function normalizeProfileAvatar(profileAvatar = null) {
    return profileAvatar && typeof profileAvatar === 'object' && !Array.isArray(profileAvatar)
        ? profileAvatar
        : null;
}

function normalizeRuntimeState(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const emotion = String(value.emotion || '').trim();
    if (!['neutral', 'listening', 'speaking', 'happy', 'confused', 'alert', 'sleepy'].includes(emotion)) {
        return null;
    }
    return {
        emotion,
        intensity: Math.min(1, Math.max(0, Number(value.intensity) || 0)),
        speaking: Boolean(value.speaking)
    };
}

function ensureRoomAvatarMap(owner) {
    if (!owner.state || typeof owner.state !== 'object') {
        owner.state = {};
    }
    if (
        !owner.state.roomAvatarsByParticipantId
        || typeof owner.state.roomAvatarsByParticipantId !== 'object'
        || Array.isArray(owner.state.roomAvatarsByParticipantId)
    ) {
        owner.state.roomAvatarsByParticipantId = {};
    }
    return owner.state.roomAvatarsByParticipantId;
}

function avatarSignature(profileAvatar = null) {
    try {
        return JSON.stringify(profileAvatar || null);
    } catch (_) {
        return '';
    }
}

function buildAvatarProjectionKey(profileAvatar = null, fallbackLetter = '') {
    const avatar = normalizeProfileAvatar(profileAvatar);
    if (!avatar) return '';
    const runtimeState = normalizeRuntimeState(avatar.runtimeState);
    const enabled = avatar.enabled !== false;
    const config = enabled && avatar.config && typeof avatar.config === 'object'
        ? avatar.config
        : null;
    return avatarSignature({
        enabled,
        config,
        runtimeState,
        fallbackLetter: String(avatar.fallbackLetter || fallbackLetter || '').trim()
    });
}

function applyProfileAvatarToView(owner, view, profileAvatar) {
    const avatar = normalizeProfileAvatar(profileAvatar);
    if (!view || !avatar) return false;
    view.avatarEnabled = avatar.enabled !== false;
    view.avatarRuntimeState = normalizeRuntimeState(avatar.runtimeState);
    view.avatarConfig = view.avatarEnabled && avatar.config && typeof avatar.config === 'object'
        ? avatar.config
        : null;
    view.avatarFallbackLetter = avatar.fallbackLetter || view.avatarFallbackLetter || '';
    view.avatarResolved = true;
    view.avatarSource = 'projected';
    view.avatarProjectionKey = buildAvatarProjectionKey(avatar, view.avatarFallbackLetter);
    owner.applyParticipantAvatarState?.(view);
    return true;
}

function setRoomAvatarFor(owner, participantId, profileAvatar) {
    const id = String(participantId || '').trim();
    const avatar = normalizeProfileAvatar(profileAvatar);
    if (!id || !avatar) return false;
    const roomAvatars = ensureRoomAvatarMap(owner);
    const previous = roomAvatars[id] || null;
    roomAvatars[id] = avatar;
    return avatarSignature(previous) !== avatarSignature(avatar);
}

function getRoomAvatarFor(owner, participantId) {
    const id = String(participantId || '').trim();
    if (!id) return null;
    return normalizeProfileAvatar(ensureRoomAvatarMap(owner)[id]);
}

function clearRoomAvatarFor(owner, participantId) {
    const id = String(participantId || '').trim();
    if (!id) return false;
    const roomAvatars = ensureRoomAvatarMap(owner);
    if (!Object.prototype.hasOwnProperty.call(roomAvatars, id)) return false;
    delete roomAvatars[id];
    return true;
}

const ROBO_TEAM_PARTICIPANT_ID = 'agent_robo_team';

function findRoboTeamAgent(owner, participantId = '', view = null) {
    const id = String(participantId || '').trim();
    const viewAgentId = String(view?.agentId || '').trim();
    const agents = Array.isArray(owner?.state?.agents) ? owner.state.agents : [];
    return agents.find((entry) => {
        const agentId = String(entry?.id || '').trim();
        const participantIdentity = String(entry?.participantIdentity || entry?.participant?.identity || '').trim();
        const agentType = String(entry?.agentType || '').trim();
        return agentType === 'robo_team'
            && (
                (viewAgentId && agentId === viewAgentId)
                || (id && participantIdentity === id)
            );
    }) || null;
}

function isRoboTeamParticipant(owner, participantId = '', view = null) {
    const id = String(participantId || '').trim();
    if (id === ROBO_TEAM_PARTICIPANT_ID) {
        return true;
    }
    return Boolean(findRoboTeamAgent(owner, id, view));
}

function getActionTarget(input = null) {
    return input?.target || input?.currentTarget || input;
}

function getLocalParticipantId(owner) {
    return String(
        owner.state.session?.participantIdentity
        || owner.state.session?.participant?.id
        || owner.state.session?.participant?.identity
        || owner.room?.localParticipant?.identity
        || ''
    ).trim();
}

export const participantViewMethods = {
    getParticipantUserId: getParticipantUserIdFromParticipant,

    setRoomAvatar(participantId, profileAvatar) {
        return setRoomAvatarFor(this, participantId, profileAvatar);
    },

    getRoomAvatar(participantId) {
        return getRoomAvatarFor(this, participantId);
    },

    clearRoomAvatar(participantId) {
        return clearRoomAvatarFor(this, participantId);
    },

    getEffectiveAvatarExpressionMode() {
        const participantId = getLocalParticipantId(this);
        const roomConfig = getRoomAvatarFor(this, participantId)?.config || null;
        const config = this.state.webMeetAvatarOverride?.config
            || roomConfig
            || this.state.session?.participant?.profileAvatar?.config
            || null;
        return String(config?.expressionMode || '').trim() === 'manual' ? 'manual' : 'audio';
    },

    syncVoiceResponsiveAvatar(Track = globalThis.LivekitClient?.Track || null, options = {}) {
        const localParticipantId = getLocalParticipantId(this);
        const activeSpeakerIds = this.state.activeSpeakerIds instanceof Set
            ? this.state.activeSpeakerIds
            : new Set();
        const room = this.room || null;
        const localParticipant = room?.localParticipant || null;
        const localMicrophoneTrack = localParticipant
            ? this.getParticipantMicrophoneTrack(localParticipant, Track)
            : null;
        const localMicrophoneAvailable = Boolean(
            localParticipant
            && this.isParticipantMicOn(localParticipant, Track)
        );
        const remoteSpeaking = Array.from(activeSpeakerIds).some((id) => {
            const participantId = String(id || '').trim();
            if (!participantId || participantId === localParticipantId) return false;
            const participant = room?.remoteParticipants?.get?.(participantId) || null;
            return Boolean(participant && this.isParticipantMicOn(participant, Track));
        });
        const liveKitState = {
            localSpeaking: Boolean(
                localMicrophoneAvailable
                && (
                    (localParticipantId && activeSpeakerIds.has(localParticipantId))
                    || localParticipant?.isSpeaking === true
                )
            ),
            remoteSpeaking
        };
        if (options.refreshMicrophone !== false) {
            liveKitState.microphoneAvailable = localMicrophoneAvailable;
            liveKitState.microphoneTrack = localMicrophoneTrack;
        }
        this.voiceResponsiveAvatarController?.setLiveKitState?.(liveKitState);
    },

    applyRealtimeParticipantAvatar(data = {}) {
        const participantId = String(data?.participantId || '').trim();
        const userId = String(data?.userId || '').trim();
        let profileAvatar = normalizeProfileAvatar(data?.profileAvatar);
        if (!profileAvatar || (!participantId && !userId)) return false;

        if (data?.preserveRuntimeState === true && participantId && !profileAvatar.runtimeState) {
            const currentRuntimeState = normalizeRuntimeState(
                getRoomAvatarFor(this, participantId)?.runtimeState
            );
            const expressionMode = String(profileAvatar.config?.expressionMode || '').trim();
            if (currentRuntimeState && expressionMode !== 'manual') {
                profileAvatar = { ...profileAvatar, runtimeState: currentRuntimeState };
            }
        }

        const sequence = Number(data?.sequence);
        if (participantId && Number.isSafeInteger(sequence) && sequence > 0) {
            const sequences = this.state.avatarProjectionSequencesByParticipantId
                || (this.state.avatarProjectionSequencesByParticipantId = {});
            const previousSequence = Number(sequences[participantId] || 0);
            if (sequence <= previousSequence) return false;
            sequences[participantId] = sequence;
        }

        const matchedParticipantIds = new Set();
        if (participantId) {
            matchedParticipantIds.add(participantId);
        }
        for (const entry of Array.isArray(this.state.participants) ? this.state.participants : []) {
            const entryUserId = getParticipantUserIdFromParticipant(entry);
            const matches = (participantId && String(entry?.id || entry?.identity || '').trim() === participantId)
                || (userId && entryUserId === userId);
            if (matches) {
                const id = String(entry?.id || entry?.identity || '').trim();
                if (id) matchedParticipantIds.add(id);
            }
        }
        const sessionParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const sessionUserId = String(this.currentActor?.id || this.state.session?.participant?.userId || '').trim();
        if (
            sessionParticipantId
            && (
                (participantId && sessionParticipantId === participantId)
                || (userId && sessionUserId && sessionUserId === userId)
            )
        ) {
            matchedParticipantIds.add(sessionParticipantId);
        }
        for (const view of this.participantLayoutController?.getViews?.() || []) {
            const viewUserId = String(view?.avatarUserId || '').trim();
            const matches = (participantId && String(view?.id || '').trim() === participantId)
                || (userId && viewUserId === userId);
            if (matches) {
                const id = String(view?.id || '').trim();
                if (id) matchedParticipantIds.add(id);
            }
        }
        let changed = false;
        for (const id of matchedParticipantIds) {
            const roomAvatarChanged = setRoomAvatarFor(this, id, profileAvatar);
            changed = roomAvatarChanged || changed;
            const view = this.participantLayoutController?.getParticipantView?.(id)
                || (this.participantLayoutController?.getViews?.() || [])
                    .find((entry) => String(entry?.id || '').trim() === id);
            const viewProjectionChanged = Boolean(
                view
                && view.avatarProjectionKey !== buildAvatarProjectionKey(profileAvatar, view.avatarFallbackLetter)
            );
            if (roomAvatarChanged || view?.avatarSource !== 'projected' || viewProjectionChanged) {
                changed = applyProfileAvatarToView(this, view, profileAvatar) || changed;
            }
        }
        return changed;
    },

    getParticipantDisplayName(participant) {
        return String(
            participant?.name
            || participant?.displayName
            || participant?.identity
            || 'Participant'
        ).trim() || 'Participant';
    },

    getAgentForParticipant(participant) {
        const identity = String(participant?.identity || '').trim();
        if (!identity) return null;
        const attributes = participant?.attributes && typeof participant.attributes === 'object'
            ? participant.attributes
            : {};
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const activeAgents = Array.isArray(this.state.agents)
            ? this.state.agents.filter((entry) => entry && !entry.deletedAt && String(entry.status || '').trim() !== 'stopped')
            : [];
        return activeAgents.find((entry) => {
            const participantIdentity = String(entry.participantIdentity || entry.participant?.identity || '').trim();
            if (participantIdentity && participantIdentity === identity) {
                return true;
            }
            if (String(attributes.webmeetAgent || '').toLowerCase() !== 'true') {
                return false;
            }
            if (meetingId && String(attributes.webmeetMeetingId || '').trim() !== meetingId) {
                return false;
            }
            const agentType = String(entry.agentType || '').trim();
            const agentMode = String(entry.mode || '').trim();
            return String(attributes.webmeetAgentType || '').trim() === agentType
                && String(attributes.webmeetAgentMode || '').trim() === agentMode;
        }) || null;
    },

    getParticipantAvatarUserId(participant) {
        if (participant?.kind === 'local') {
            return 'me';
        }
        const attributes = participant?.attributes && typeof participant.attributes === 'object'
            ? participant.attributes
            : {};
        const identity = String(participant?.identity || participant?.id || '').trim();
        const storedParticipant = Array.isArray(this.state.participants)
            ? this.state.participants.find((entry) => String(entry?.id || '').trim() === identity)
            : null;
        const storedAttributes = storedParticipant?.attributes && typeof storedParticipant.attributes === 'object'
            ? storedParticipant.attributes
            : {};
        const candidates = [
            attributes.ploinkyUserId,
            attributes.workspaceUserId,
            attributes.userId,
            attributes.webmeetUserId,
            storedAttributes.ploinkyUserId,
            storedAttributes.workspaceUserId,
            storedAttributes.userId,
            storedAttributes.webmeetUserId,
            storedParticipant?.userId
        ];
        return String(candidates.find((value) => String(value || '').trim()) || '').trim();
    },

    setVideoGridEmptyState(message) {
        this.participantLayoutController.setVideoGridEmptyState(message);
    },

    syncVideoGridVisibility() {
        this.participantLayoutController.syncVideoGridVisibility();
    },

    applyParticipantViewState(view) {
        this.participantLayoutController.applyParticipantViewState(view);
    },

    applyParticipantAvatarState(view) {
        this.participantLayoutController.applyParticipantAvatarState(view);
    },

    upsertParticipantView(participant) {
        const participantId = String(participant?.identity || participant?.id || '').trim();
        const profileAvatar = normalizeProfileAvatar(participant?.profileAvatar)
            || getRoomAvatarFor(this, participantId);
        return this.participantLayoutController.upsertParticipantView({
            ...(participant && typeof participant === 'object' ? participant : {}),
            ...(profileAvatar ? { profileAvatar } : {})
        });
    },

    renderParticipantLayout() {
        this.participantLayoutController.renderParticipantLayout();
        this.applyBlackboardFocusLayout?.();
    },

    setFocusedParticipant(participantId) {
        this.participantLayoutController.setFocusedParticipant(participantId);
    },

    async focusParticipantCard(target) {
        const actionTarget = getActionTarget(target);
        const participantId = String(actionTarget?.dataset?.participantId || actionTarget?.closest?.('[data-participant-id]')?.dataset?.participantId || '').trim();
        const view = participantId
            ? this.participantLayoutController?.getParticipantView?.(participantId)
            : null;
        const agent = findRoboTeamAgent(this, participantId, view);
        if (isRoboTeamParticipant(this, participantId, view)) {
            const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
            const actorParticipantId = getLocalParticipantId(this);
            if (!meetingId) return;
            if (!actorParticipantId) {
                this.setError?.('Join a meeting before opening the blackboard.');
                return;
            }
            const presenterId = String(agent?.participantIdentity || agent?.participant?.identity || participantId || ROBO_TEAM_PARTICIPANT_ID).trim();
            const presenterName = String(agent?.agentName || agent?.participant?.name || 'Robo Team').trim() || 'Robo Team';
            try {
                if (this.state.blackboard?.visible) {
                    this.collapseBlackboardFocus?.();
                    this.participantLayoutController?.renderParticipantLayout?.();
                    return;
                }
                await this.applyBlackboardVisibility?.({
                    meetingId,
                    participantId: actorParticipantId,
                    visible: true,
                    presenterId,
                    presenterName
                });
            } catch (error) {
                this.setError?.(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (this.state.blackboard?.visible) {
            this.collapseBlackboardFocus?.();
        }
        this.participantLayoutController.focusParticipantCard(actionTarget);
    },

    setParticipantMicState(participantId, isMicOn) {
        this.participantLayoutController.setParticipantMicState(participantId, isMicOn);
        const id = String(participantId || '').trim();
        if (!id) return;
        let updated = false;
        const nextMicState = Boolean(isMicOn);
        const map = this.state.meetingParticipantsById || {};
        for (const meetingId of Object.keys(map)) {
            const entries = Array.isArray(map[meetingId]) ? map[meetingId] : [];
            for (const entry of entries) {
                if (String(entry?.id || '').trim() !== id) continue;
                if (entry.micOn !== nextMicState) {
                    entry.micOn = nextMicState;
                    updated = true;
                }
            }
        }
        if (updated) {
            this.renderMeetingList();
        }
    },

    attachVideoTrack(participantId, trackSid, mediaElement) {
        this.participantLayoutController.attachVideoTrack(participantId, trackSid, mediaElement);
    },

    clearVideoTrack(trackSid) {
        this.participantLayoutController.clearVideoTrack(trackSid);
    },

    attachAudioTrack(participantId, trackSid, mediaElement) {
        this.participantLayoutController.attachAudioTrack(participantId, trackSid, mediaElement);
        this.remoteAudioNormalizer?.start?.(mediaElement, participantId);
    },

    removeTrack(trackSid) {
        const trackEntry = this.participantLayoutController.getTrackEntry(trackSid);
        if (trackEntry?.kind === 'audio' && trackEntry.element) {
            this.remoteAudioNormalizer?.stop?.(trackEntry.element);
        }
        this.participantLayoutController.removeTrack(trackSid);
    },

    removeParticipantView(participantId) {
        this.remoteAudioNormalizer?.stopParticipant?.(participantId);
        this.participantLayoutController.removeParticipantView(participantId);
    },

    getActiveCustomMicrophoneTrackForParticipant(participant = null) {
        const participantIdentity = String(participant?.identity || '').trim();
        const localIdentity = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        if (!participantIdentity || !localIdentity || participantIdentity !== localIdentity) {
            return null;
        }
        return this.mediaController?.activeMicrophoneCapture?.track || null;
    },

    isMicrophonePublication(publication, Track, participant = null) {
        return isMicrophonePublication(publication, Track, {
            allowLocalCustomFallback: true,
            activeMicrophoneTrack: this.getActiveCustomMicrophoneTrackForParticipant(participant)
        });
    },

    getParticipantMicrophoneTrack(participant, Track) {
        if (!participant?.trackPublications?.values) return false;
        for (const publication of participant.trackPublications.values()) {
            if (!publication) continue;
            const mediaStreamTrack = publication.track?.mediaStreamTrack || null;
            const trackUnavailable = publication.track?.isMuted === true
                || mediaStreamTrack?.enabled === false
                || String(mediaStreamTrack?.readyState || '').toLowerCase() === 'ended';
            if (
                this.isMicrophonePublication(publication, Track, participant)
                && !publication.isMuted
                && !trackUnavailable
            ) {
                return mediaStreamTrack || publication.track?.mediaStream?.getAudioTracks?.()[0] || null;
            }
        }
        return null;
    },

    isParticipantMicOn(participant, Track) {
        if (!participant?.trackPublications?.values) return false;
        for (const publication of participant.trackPublications.values()) {
            if (!publication) continue;
            const mediaStreamTrack = publication.track?.mediaStreamTrack || null;
            const trackUnavailable = publication.track?.isMuted === true
                || mediaStreamTrack?.enabled === false
                || String(mediaStreamTrack?.readyState || '').toLowerCase() === 'ended';
            if (
                this.isMicrophonePublication(publication, Track, participant)
                && !publication.isMuted
                && !trackUnavailable
            ) {
                return true;
            }
        }
        return false;
    },

    syncParticipantsFromRoom(room, Track) {
        if (!room) return;
        const currentParticipants = Array.isArray(this.state.participants) ? this.state.participants : [];
        const storedById = new Map(
            currentParticipants
                .map((entry) => [String(entry?.id || '').trim(), entry])
                .filter(([id]) => id)
        );
        const mergeStoredAttributes = (identity, livekitAttributes = {}) => {
            const stored = storedById.get(String(identity || '').trim()) || null;
            const storedAttributes = stored?.attributes && typeof stored.attributes === 'object'
                ? stored.attributes
                : {};
            const { webmeetProfileAvatar: _storedProfileAvatarAttribute, ...safeStoredAttributes } = storedAttributes;
            const userId = String(stored?.userId || '').trim();
            return {
                ...safeStoredAttributes,
                ...(userId ? {
                    webmeetUserId: userId,
                    userId,
                    workspaceUserId: userId,
                    ploinkyUserId: userId
                } : {}),
                ...(livekitAttributes && typeof livekitAttributes === 'object' ? livekitAttributes : {})
            };
        };
        const localIdentity = room.localParticipant?.identity || this.state.session?.participantIdentity || '';
        const isSpeaking = (identity) => this.isParticipantSpeaking?.(identity) === true;
        const localAttributes = mergeStoredAttributes(
            localIdentity,
            room.localParticipant?.attributes || {}
        );
        const sessionParticipant = this.state.session?.participant && typeof this.state.session.participant === 'object'
            ? this.state.session.participant
            : null;
        const sessionParticipantId = String(
            this.state.session?.participantIdentity
            || sessionParticipant?.identity
            || sessionParticipant?.id
            || ''
        ).trim();
        const storedLocalParticipant = storedById.get(String(localIdentity || '').trim()) || null;
        const sessionMatchesLocal = Boolean(localIdentity && sessionParticipantId === String(localIdentity || '').trim());
        const localStoredParticipant = storedLocalParticipant && sessionMatchesLocal
            ? {
                ...sessionParticipant,
                ...storedLocalParticipant,
                attributes: {
                    ...(sessionParticipant?.attributes && typeof sessionParticipant.attributes === 'object'
                        ? sessionParticipant.attributes
                        : {}),
                    ...(storedLocalParticipant.attributes && typeof storedLocalParticipant.attributes === 'object'
                        ? storedLocalParticipant.attributes
                        : {})
                }
            }
            : (storedLocalParticipant || (sessionMatchesLocal ? sessionParticipant : null) || null);
        const localUserId = String(
            localStoredParticipant?.userId
            || localAttributes.ploinkyUserId
            || localAttributes.workspaceUserId
            || localAttributes.userId
            || localAttributes.webmeetUserId
            || ''
        ).trim();
        const localProfileSourceAvatar = normalizeProfileAvatar(
            localStoredParticipant?.profileAvatar
            || sessionParticipant?.profileAvatar
        );
        const localLiveKitAvatar = parseLiveKitProfileAvatar(localAttributes);
        if (localIdentity) {
            const currentLocalRoomAvatar = getRoomAvatarFor(this, localIdentity);
            if (!currentLocalRoomAvatar) {
                const localSourceAvatar = buildWebMeetAvatarSource({
                    profileAvatar: localProfileSourceAvatar || localLiveKitAvatar,
                    override: this.state.webMeetAvatarOverride || null,
                    userId: localUserId,
                    participantId: localIdentity
                });
                const initialLocalAvatar = this.webMeetRoom?.buildAvatarProjection
                    ? this.webMeetRoom.buildAvatarProjection(localSourceAvatar, localIdentity)
                    : localSourceAvatar;
                if (initialLocalAvatar) {
                    setRoomAvatarFor(this, localIdentity, initialLocalAvatar);
                }
            }
        }
        const items = [{
            id: localIdentity,
            identity: localIdentity,
            displayName: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            name: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            attributes: localAttributes,
            userId: localUserId,
            profileAvatar: getRoomAvatarFor(this, localIdentity),
            isSpeaking: isSpeaking(localIdentity),
            kind: 'local'
        }];
        for (const participant of room.remoteParticipants.values()) {
            const identity = participant.identity || '';
            const attributes = mergeStoredAttributes(identity, participant.attributes || {});
            const storedParticipant = storedById.get(String(identity || '').trim()) || null;
            const liveKitAvatar = parseLiveKitProfileAvatar(attributes);
            if (liveKitAvatar && !getRoomAvatarFor(this, identity)) {
                setRoomAvatarFor(this, identity, liveKitAvatar);
            }
            const userId = String(
                storedParticipant?.userId
                || attributes.ploinkyUserId
                || attributes.workspaceUserId
                || attributes.userId
                || attributes.webmeetUserId
                || ''
            ).trim();
            items.push({
                id: identity,
                identity,
                displayName: participant.name || participant.identity || 'Remote',
                name: participant.name || participant.identity || 'Remote',
                attributes,
                userId,
                profileAvatar: getRoomAvatarFor(this, identity),
                isSpeaking: isSpeaking(identity),
                kind: 'remote'
            });
        }
        for (const storedParticipant of currentParticipants) {
            const identity = String(storedParticipant?.identity || storedParticipant?.id || '').trim();
            if (!identity || storedParticipant?.kind !== 'agent') continue;
            if (items.some((entry) => String(entry?.identity || entry?.id || '').trim() === identity)) continue;
            items.push({
                ...storedParticipant,
                id: identity,
                identity,
                displayName: String(storedParticipant?.displayName || storedParticipant?.name || identity).trim() || identity,
                name: String(storedParticipant?.name || storedParticipant?.displayName || identity).trim() || identity,
                kind: 'agent'
            });
        }
        for (const agent of Array.isArray(this.state.agents) ? this.state.agents : []) {
            if (!agent || agent.deletedAt || String(agent.status || '').trim() === 'detached') continue;
            const identity = String(agent.participantIdentity || agent.participant?.identity || '').trim();
            if (!identity || items.some((entry) => String(entry?.identity || entry?.id || '').trim() === identity)) continue;
            const name = String(agent.agentName || agent.participant?.name || agent.agentType || 'Robo Team').trim() || 'Robo Team';
            items.push({
                id: identity,
                identity,
                displayName: name,
                name,
                attributes: {
                    webmeetAgent: 'true',
                    webmeetMeetingId: String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim(),
                    webmeetAgentType: String(agent.agentType || '').trim(),
                    webmeetAgentMode: String(agent.mode || '').trim(),
                    webmeetAgentRuntime: String(agent.runtime || 'ploinky').trim()
                },
                kind: 'agent'
            });
        }
        const keep = new Set();
        for (const item of items) {
            const id = String(item.identity || '').trim();
            if (!id) continue;
            keep.add(id);
            const view = this.upsertParticipantView(item);
            if (!view) continue;
            const sourceParticipant = item.kind === 'local'
                ? room.localParticipant
                : (item.kind === 'agent' ? null : room.remoteParticipants.get(id));
            view.micOn = Track
                ? this.isParticipantMicOn(sourceParticipant, Track)
                : Boolean(view.micOn);
            this.applyParticipantViewState(view);
        }

        for (const participantId of this.participantLayoutController.getParticipantIds()) {
            if (!keep.has(participantId)) {
                this.removeParticipantView(participantId);
            }
        }

        this.state.participants = items;
        if (this.selectedMeeting?.id) {
            this.state.meetingParticipantsById[this.selectedMeeting.id] = items.map((entry) => ({
                id: entry.identity,
                name: entry.name,
                isAgent: Boolean(this.getAgentForParticipant(entry)),
                isSpeaking: Boolean(entry.isSpeaking),
                micOn: Boolean(
                    this.participantLayoutController
                        .getParticipantView?.(entry.identity)
                        ?.micOn
                )
            })).filter((entry) => entry.id);
            this.renderMeetingList();
        }
        this.renderParticipantLayout();
        this.syncLocalMediaStateFromRoom(Track);
        this.renderFeedLists();
    },

    isParticipantSpeaking(participantId) {
        const id = String(participantId || '').trim();
        return Boolean(id && this.state.activeSpeakerIds instanceof Set && this.state.activeSpeakerIds.has(id));
    },

    setActiveSpeakers(participants = [], Track = globalThis.LivekitClient?.Track || null) {
        const next = new Set();
        for (const participant of Array.isArray(participants) ? participants : []) {
            const identity = String(participant?.identity || '').trim();
            if (identity) next.add(identity);
        }
        this.state.activeSpeakerIds = next;
        this.syncVoiceResponsiveAvatar(Track, { refreshMicrophone: false });
        this.syncParticipantsFromRoom(this.room, Track);
    },

    syncLocalMediaStateFromRoom(TrackRef = null) {
        this.mediaController.syncLocalMediaStateFromRoom(TrackRef);
    },

    setMediaLoading(type, value) {
        const mediaType = String(type || '').trim();
        if (!Object.prototype.hasOwnProperty.call(this.state.mediaLoading, mediaType)) {
            return;
        }
        this.state.mediaLoading = {
            ...this.state.mediaLoading,
            [mediaType]: Boolean(value)
        };
        this.renderMeetingSummary();
    },

    async attemptAudioPlaybackRecovery() {
        const result = await resumeRemoteAudioPlayback(this.element);
        const blocked = result.total > 0 && result.blocked;
        if (this.state.audioPlaybackBlocked !== blocked) {
            this.state.audioPlaybackBlocked = blocked;
            this.updateAudioHealthIndicator();
        }
        return !blocked;
    },

    async enableSoundPlayback() {
        const recovered = await this.attemptAudioPlaybackRecovery();
        if (!recovered) {
            this.setError('Sound is blocked until you interact with the page. Press Enable sound again.');
        }
        return recovered;
    },

    async ensureRemoteAudioPlayback(mediaElement) {
        if (!mediaElement || typeof mediaElement.play !== 'function') return;
        try {
            await mediaElement.play();
            if (this.state.audioPlaybackBlocked) {
                this.state.audioPlaybackBlocked = false;
                this.updateAudioHealthIndicator();
            }
        } catch (_) {
            if (!this.state.audioPlaybackBlocked) {
                this.state.audioPlaybackBlocked = true;
                this.updateAudioHealthIndicator();
            }
        }
    },

    handleAudioRecoveryGestureEvent() {
        if (!this.state.audioPlaybackBlocked) return null;
        return this.attemptAudioPlaybackRecovery();
    },

    async handleAudioRecoveryResumeEvent() {
        if (globalThis.document?.visibilityState === 'hidden') return;
        await this.applyAudioOutputDeviceToAllTracks?.();
        await this.attemptAudioPlaybackRecovery();
        this.remoteAudioNormalizer?.resume?.();
    }

};

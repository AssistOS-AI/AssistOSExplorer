import { createWebMeetRoomApi } from './webmeet-room-api.js';
import { ROOM_EVENT_TYPES, WebMeetRoomEvents } from './webmeet-room-events.js';
import { WebMeetRoomState } from './webmeet-room-state.js';
import { WEBMEET_EVENT_TYPES } from '../webmeet-events.js';
import { normalizeAvatarConfig } from '../webmeet-profile-avatar-runtime.js';
import { normalizeAvatarRuntimeState } from '../audio-processing/voice-responsive-avatar.js';

const SERVER_BROADCAST_EVENT_TYPES = new Set([
    WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
    WEBMEET_EVENT_TYPES.MEETING_NOTES_SETTINGS_CHANGED,
    WEBMEET_EVENT_TYPES.MEETING_NOTES_ACTIVITY,
]);

function assertFunction(value, name) {
    if (typeof value !== 'function') {
        throw new Error(`Missing WebMeet room dependency: ${name}`);
    }
    return value;
}

function requireString(value, name) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error(`Missing WebMeet room field: ${name}`);
    }
    return normalized;
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Missing WebMeet room field: ${name}`);
    }
    return value;
}

function resolveRoomApi(options = {}) {
    if (options.api && typeof options.api === 'object') {
        return options.api;
    }
    return createWebMeetRoomApi({
        guest: options.isGuestSession(),
        runTool: options.runTool
    });
}

function resolveRoomApiFactory(options = {}) {
    if (options.api && typeof options.api === 'object') {
        return () => options.api;
    }
    return () => resolveRoomApi(options);
}

function resolveLiveKitAdapter(options = {}) {
    if (options.livekit && typeof options.livekit === 'object') {
        return options.livekit;
    }
    return {
        async connect(transition) {
            return options.connectLiveKit(transition);
        },
        async disconnect(params) {
            return options.disconnectLiveKit(params);
        }
    };
}

const PRESENCE_HEARTBEAT_INTERVAL_MS = 10_000;

export class WebMeetRoom extends EventTarget {
    constructor(options = {}) {
        super();
        this.getSession = assertFunction(options.getSession, 'getSession');
        this.setSession = assertFunction(options.setSession, 'setSession');
        this.isGuestSession = assertFunction(options.isGuestSession, 'isGuestSession');
        this.runTool = assertFunction(options.runTool, 'runTool');
        this.getRoom = assertFunction(options.getRoom, 'getRoom');
        this.getRoomAvatars = assertFunction(options.getRoomAvatars, 'getRoomAvatars');
        this.setRoomAvatar = assertFunction(options.setRoomAvatar, 'setRoomAvatar');
        this.applyRealtimeParticipantAvatar = assertFunction(options.applyRealtimeParticipantAvatar, 'applyRealtimeParticipantAvatar');
        this.publishRealtimeToTransport = assertFunction(options.publishRealtimePayload, 'publishRealtimePayload');
        this.getCurrentActorId = assertFunction(options.getCurrentActorId, 'getCurrentActorId');
        this.getSelectedWorkspaceId = assertFunction(options.getSelectedWorkspaceId, 'getSelectedWorkspaceId');
        this.getApi = resolveRoomApiFactory({
            api: options.api,
            isGuestSession: this.isGuestSession,
            runTool: this.runTool
        });
        this.livekit = resolveLiveKitAdapter({
            livekit: options.livekit,
            connectLiveKit: assertFunction(options.connectLiveKit, 'connectLiveKit'),
            disconnectLiveKit: assertFunction(options.disconnectLiveKit, 'disconnectLiveKit')
        });
        this.eventCodec = options.eventCodec instanceof WebMeetRoomEvents
            ? options.eventCodec
            : new WebMeetRoomEvents();
        this.stateModel = new WebMeetRoomState(options.initialState);
        this.workspaceEventsPollTimer = null;
        this.presenceHeartbeatTimer = null;
        this.presenceHeartbeatInFlight = false;
        this.lastWorkspaceEventId = '';
        this.workspacePollInitialized = false;
        this.workspacePollGeneration = 0;
        this.workspacePollId = '';
        this.workspaceInvalidationVersion = 0;
        this.workspaceReconciledVersion = 0;
        this.disposed = false;
        this.sessionGeneration = 0;
        this.transitionTail = Promise.resolve();
        this.cleanupTask = null;
        this.avatarProjectionSequence = Date.now() * 1000;
        this.pendingAvatarRuntimeState = null;
        this.hasPendingAvatarRuntimeState = false;
        this.avatarRuntimePublishTask = null;
        this.syncStateFromCurrentSession();
    }

    dispatchRoomEvent(type, detail = {}) {
        if (this.disposed) return;
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    captureSession() {
        const session = this.getSession();
        return {
            meetingId: String(session?.meeting?.id || ''),
            participantId: String(session?.participantIdentity || ''),
            api: this.getApi(),
            room: this.getRoom(),
            generation: this.sessionGeneration,
            guest: this.isGuestSession(),
            displayName: String(session?.participant?.displayName || ''),
        };
    }

    isSessionCurrent(capture) {
        const session = this.getSession();
        return !this.disposed && capture?.generation === this.sessionGeneration
            && capture.meetingId === String(session?.meeting?.id || '')
            && capture.participantId === String(session?.participantIdentity || '');
    }

    runTransition(operation, transition = null, { cleanup = false, allowDisposed = false } = {}) {
        if (transition?.owner === this) {
            const task = Promise.resolve().then(() => operation(transition));
            if (cleanup && !this.cleanupTask) this.trackCleanup(task);
            return task;
        }
        if (cleanup && this.cleanupTask) return this.cleanupTask;
        const task = this.transitionTail.then(async () => {
            if (this.disposed && !allowDisposed && !cleanup) return;
            const captured = this.captureSession();
            const context = {
                owner: this,
                captured,
                current: captured,
                isCurrent: () => this.isSessionCurrent(context.current),
            };
            return operation(context);
        });
        this.transitionTail = task.catch(() => {});
        if (cleanup) this.trackCleanup(task);
        return task;
    }

    trackCleanup(task) {
        this.cleanupTask = task;
        void task.finally(() => {
            if (this.cleanupTask === task) this.cleanupTask = null;
        }).catch(() => {});
    }

    installSession(session, transition = null, { replacement = true } = {}) {
        if (this.disposed || (transition && !transition.isCurrent())) return false;
        if (replacement) this.sessionGeneration += 1;
        this.setSession(session);
        this.syncStateFromCurrentSession();
        if (transition) transition.current = this.captureSession();
        return true;
    }

    dispose() {
        this.disposed = true;
        this.stopWorkspaceEvents();
        this.stopPresenceHeartbeat();
        this.workspaceReconciledVersion = this.workspaceInvalidationVersion;
    }

    requestWorkspaceRevalidation() {
        if (this.disposed) return;
        this.workspaceInvalidationVersion += 1;
        this.dispatchRoomEvent(ROOM_EVENT_TYPES.WORKSPACE_INVALIDATED, { source: 'authenticated-workspace' });
    }

    syncStateFromCurrentSession() {
        this.stateModel.hydrateFromSession(this.getSession(), this.isGuestSession());
    }

    getState() {
        this.syncStateFromCurrentSession();
        return this.stateModel.getSnapshot();
    }

    buildRealtimeEvent(type, payload = {}) {
        const state = this.getState();
        const roomId = requireString(
            payload.workspaceId || payload.meetingId || state.meetingId,
            'roomId'
        );
        return this.eventCodec.build(roomId, type, payload);
    }

    async publishRealtimePayload(payload = {}) {
        const eventType = String(payload?.type || '').trim();
        if (!eventType) {
            throw new Error('Missing realtime payload type.');
        }
        const encodedEvent = this.buildRealtimeEvent(eventType, payload);
        await this.publishRealtimeToTransport(encodedEvent);
        return encodedEvent;
    }

    emitNormalizedIncomingEvent(source, encodedEvent, meta = {}) {
        const parsed = this.eventCodec.parse(encodedEvent);
        this.assertIncomingEventAllowed(source, parsed, meta);
        const roomEventType = this.eventCodec.resolveRoomEventType(parsed.type);
        if (!roomEventType) {
            return parsed;
        }
        this.dispatchRoomEvent(roomEventType, {
            source: String(source || 'unknown').trim() || 'unknown',
            encodedEvent: parsed.encoded,
            parsed,
            payload: parsed.payload,
            meta: meta && typeof meta === 'object' ? meta : {}
        });
        return parsed;
    }

    assertIncomingEventAllowed(source, parsed, meta = {}) {
        if (parsed.type === WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED && source !== 'authenticated-workspace') {
            throw new Error('Rejected workspace invalidation from an untrusted source.');
        }
        if (String(source || '').trim() !== 'livekit') {
            return true;
        }
        const state = this.getState();
        const meetingId = String(state.meetingId || '').trim();
        const eventMeetingId = String(parsed?.payload?.meetingId || parsed?.room || '').trim();
        if (!meetingId || !eventMeetingId || eventMeetingId !== meetingId) {
            throw new Error('Rejected LiveKit event for a different meeting.');
        }
        const senderParticipantId = String(meta?.participantId || '').trim();
        if (!senderParticipantId) {
            if (
                SERVER_BROADCAST_EVENT_TYPES.has(parsed.type)
                && parsed?.payload?.changeType !== 'scripta-p-variant-edit-draft'
            ) {
                return true;
            }
            throw new Error('Rejected LiveKit event without sender participant.');
        }
        if (
            parsed.type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED
            || parsed.type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST
        ) {
            const payloadParticipantId = String(parsed?.payload?.participantId || '').trim();
            if (!payloadParticipantId || payloadParticipantId !== senderParticipantId) {
                throw new Error('Rejected LiveKit participant event with mismatched sender.');
            }
        }
        if (parsed.type === WEBMEET_EVENT_TYPES.CHAT_REALTIME) {
            const authorId = String(parsed?.payload?.message?.authorId || '').trim();
            if (!authorId || authorId !== senderParticipantId) {
                throw new Error('Rejected LiveKit chat event with mismatched sender.');
            }
        }
        if (parsed.type === WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS) {
            const statusParticipantId = String(parsed?.payload?.participantId || '').trim();
            if (!statusParticipantId || statusParticipantId !== senderParticipantId) {
                throw new Error('Rejected LiveKit blackboard command status with mismatched sender.');
            }
        }
        if (
            parsed.type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED
            && parsed?.payload?.changeType === 'scripta-p-variant-edit-draft'
        ) {
            const editorParticipantId = String(parsed?.payload?.editorParticipantId || '').trim();
            if (!editorParticipantId || editorParticipantId !== senderParticipantId) {
                throw new Error('Rejected LiveKit SCRIPTA draft with mismatched editor.');
            }
        }
        return true;
    }

    handleIncomingEvent(source, encodedEvent, meta = {}) {
        return this.emitNormalizedIncomingEvent(source, encodedEvent, meta);
    }

    startWorkspaceEvents() {
        this.stopWorkspaceEvents();
        if (this.disposed) return;
        const workspaceId = String(this.getSelectedWorkspaceId() || '').trim();
        const generation = this.workspacePollGeneration;
        if (this.workspacePollId !== workspaceId) {
            this.lastWorkspaceEventId = '';
            this.workspacePollId = workspaceId;
        }
        this.workspacePollInitialized = false;
        const current = () => !this.disposed && generation === this.workspacePollGeneration
            && !this.isGuestSession() && workspaceId === String(this.getSelectedWorkspaceId() || '').trim();
        const poll = async () => {
            try {
                if (!current()) {
                    return;
                }
                const selectedWorkspaceId = String(this.getSelectedWorkspaceId() || '').trim();
                if (!selectedWorkspaceId || selectedWorkspaceId !== workspaceId) {
                    return;
                }
                const payload = await this.runTool('webmeet_room_events_list', {
                    roomId: workspaceId,
                    afterId: this.lastWorkspaceEventId
                });
                if (!current()) return;
                if (!Array.isArray(payload?.events)) throw new Error('Invalid workspace events response.');
                const events = payload.events;
                // Parse the complete response before applying any lifecycle hints.
                const decoded = events.map((event) => this.eventCodec.parse(event));
                if (!this.workspacePollInitialized || payload.cursorReset === true) {
                    this.workspacePollInitialized = true;
                    this.requestWorkspaceRevalidation();
                } else {
                    for (const encodedEvent of events) {
                        const parsed = this.handleIncomingEvent('authenticated-workspace', encodedEvent);
                        if (parsed.type === WEBMEET_EVENT_TYPES.WORKSPACE_ROOMS_INVALIDATED) this.workspaceInvalidationVersion += 1;
                    }
                }
                this.lastWorkspaceEventId = typeof payload.nextCursor === 'string'
                    ? payload.nextCursor : (decoded.at(-1)?.id || this.lastWorkspaceEventId);
            } catch (_) {
                // Transport/codec failures retain pending reconciliation and cursor.
            } finally {
                if (current()) {
                    if (this.workspaceInvalidationVersion > this.workspaceReconciledVersion) {
                        this.dispatchRoomEvent(ROOM_EVENT_TYPES.WORKSPACE_INVALIDATED, { source: 'authenticated-workspace' });
                    }
                    this.workspaceEventsPollTimer = window.setTimeout(poll, 5000);
                }
            }
        };
        this.workspaceEventsPollTimer = window.setTimeout(poll, 0);
    }

    stopWorkspaceEvents() {
        this.workspacePollGeneration += 1;
        if (!this.workspaceEventsPollTimer) {
            return;
        }
        window.clearTimeout(this.workspaceEventsPollTimer);
        this.workspaceEventsPollTimer = null;
    }

    async join(payload = {}, transition = null) {
        if (!transition) return this.runTransition((context) => this.join(payload, context));
        if (!transition.isCurrent()) return;
        const api = this.getApi();
        const session = await api.joinMeeting(payload);
        if (!this.installSession(session, transition)) {
            if (session?.meeting?.id && session?.participantIdentity) {
                await api.leaveMeeting({ meetingId: session.meeting.id, participantId: session.participantIdentity }).catch(() => {});
            }
            return;
        }
        this.stateModel.hydrateFromSession(session, this.isGuestSession());
        const snapshot = this.stateModel.getSnapshot();
        this.dispatchRoomEvent(ROOM_EVENT_TYPES.JOINED, {
            source: 'room-lifecycle',
            payload: {
                meetingId: snapshot.meetingId,
                participantId: snapshot.participantId,
                session: snapshot.session
            }
        });
        return session;
    }

    async connectLiveKit(transition = null) {
        if (!transition) return this.runTransition((context) => this.connectLiveKit(context));
        if (!transition.isCurrent()) return;
        await this.livekit.connect(transition);
        if (!transition.isCurrent()) return;
        this.stateModel.setLiveKitState('connected');
        this.startPresenceHeartbeat();
    }

    async refreshJoinMaterial(transition = null) {
        if (!transition) return this.runTransition((context) => this.refreshJoinMaterial(context));
        if (!transition.isCurrent()) return;
        const state = this.getState();
        const currentSession = state.session || this.getSession();
        const meetingId = requireString(
            state.meetingId || currentSession?.meeting?.id,
            'meetingId'
        );
        const participantId = requireString(
            state.participantId || currentSession?.participantIdentity,
            'participantId'
        );
        const displayName = requireString(
            currentSession?.participant?.displayName
                || currentSession?.participant?.name
                || currentSession?.participantIdentity,
            'displayName'
        );
        const refreshed = await this.getApi().refreshJoinMaterial({
            meetingId,
            participantId,
            displayName
        });
        const nextSession = { ...currentSession, ...refreshed };
        if (!this.installSession(nextSession, transition, { replacement: false })) return;
        this.stateModel.hydrateFromSession(nextSession, this.isGuestSession());
        return nextSession;
    }

    async disconnectLiveKit(options = {}) {
        if (!options.transition) return this.runTransition((transition) => this.disconnectLiveKit({ ...options, transition }));
        this.stopPresenceHeartbeat();
        await this.livekit.disconnect(options);
        if (!options.transition.isCurrent()) return;
        this.stateModel.setLiveKitState('disconnected');
    }

    handleExternalLiveKitDisconnect() {
        this.stopPresenceHeartbeat();
        this.stateModel.setLiveKitState('disconnected');
    }

    async leaveCurrentSession(captured = this.captureSession()) {
        return captured.api.leaveMeeting({
            meetingId: requireString(captured.meetingId, 'meetingId'),
            participantId: requireString(captured.participantId, 'participantId')
        });
    }

    startPresenceHeartbeat() {
        this.stopPresenceHeartbeat();
        if (this.disposed) return;
        const captured = this.captureSession();
        const schedule = () => {
            this.presenceHeartbeatTimer = globalThis.setTimeout(async () => {
                try {
                    await this.sendPresenceHeartbeat();
                } catch (_) {
                    // The command path reconciles against LiveKit as a fallback;
                    // a transient heartbeat failure must not stop future beats.
                } finally {
                    if (this.isSessionCurrent(captured) && this.stateModel.getSnapshot().livekitState === 'connected') schedule();
                }
            }, PRESENCE_HEARTBEAT_INTERVAL_MS);
        };
        schedule();
    }

    stopPresenceHeartbeat() {
        if (this.presenceHeartbeatTimer !== null) globalThis.clearTimeout(this.presenceHeartbeatTimer);
        this.presenceHeartbeatTimer = null;
    }

    async sendPresenceHeartbeat() {
        if (this.presenceHeartbeatInFlight) return null;
        const state = this.getState();
        if (!state.meetingId || !state.participantId || state.livekitState !== 'connected') return null;
        this.presenceHeartbeatInFlight = true;
        try {
            return await this.getApi().heartbeat({ meetingId: state.meetingId, participantId: state.participantId });
        } finally {
            this.presenceHeartbeatInFlight = false;
        }
    }

    async leave(options = {}) {
        if (!options.transition) return this.runTransition((transition) => this.leave({ ...options, transition }), null, { cleanup: true });
        const { transition } = options;
        await this.disconnectLiveKit(options);
        await this.leaveCurrentSession(transition.captured);
        if (!transition.isCurrent()) return;
        const previous = this.getState();
        this.installSession(null, transition, { replacement: false });
        this.stateModel.clear();
        this.dispatchRoomEvent(ROOM_EVENT_TYPES.LEFT, {
            source: 'room-lifecycle',
            payload: {
                meetingId: previous.meetingId,
                participantId: previous.participantId
            }
        });
    }

    async refreshState() {
        const state = this.getState();
        if (state.guest) {
            const details = await this.getApi().loadRoomState({
                meetingId: requireString(state.meetingId, 'meetingId'),
                participantId: requireString(state.participantId, 'participantId')
            });
            this.stateModel.setParticipants(details?.participants);
            this.stateModel.setChat(details?.chat);
            this.stateModel.setAgents(details?.agents);
            this.stateModel.setResources(details?.resources);
            return details;
        }
        const details = await this.runTool('webmeet_room_get', {
            roomId: requireString(state.meetingId, 'roomId'),
            includeParticipants: false
        });
        this.stateModel.setParticipants(details?.participants);
        this.stateModel.setAgents(details?.agents);
        return details;
    }

    async destroy() {
        this.dispose();
        this.stateModel.clear();
    }

    async publishAvatar(avatar = null) {
        const state = this.getState();
        return this.getApi().publishAvatar({
            meetingId: requireString(state.meetingId, 'meetingId'),
            participantId: requireString(state.participantId, 'participantId'),
            avatar: requireObject(avatar, 'avatar')
        });
    }

    buildAvatarProjection(sourceAvatar = null, participantId = '') {
        if (!sourceAvatar || typeof sourceAvatar !== 'object' || Array.isArray(sourceAvatar)) {
            return {
                enabled: false,
                config: null,
                fallbackLetter: ''
            };
        }
        const source = sourceAvatar;
        const profileUserId = String(source.user?.id || '').trim();
        const fallbackAvatarId = `profile:${profileUserId || participantId}`;
        return {
            enabled: source.enabled !== false,
            config: source.enabled !== false && source.config && typeof source.config === 'object'
                ? normalizeAvatarConfig(source.config, fallbackAvatarId)
                : null,
            fallbackLetter: source.fallbackLetter || ''
        };
    }

    getCurrentPublishedAvatarProjection() {
        const state = this.getState();
        const participantId = requireString(state.participantId, 'participantId');
        const room = this.getRoom();
        const avatarState = this.getRoomAvatars();
        const roomAvatars = avatarState && typeof avatarState === 'object'
            ? avatarState
            : {};
        const localAttributes = room?.localParticipant?.attributes && typeof room.localParticipant.attributes === 'object'
            ? room.localParticipant.attributes
            : {};
        let profileAvatar = roomAvatars[participantId] && typeof roomAvatars[participantId] === 'object'
            ? roomAvatars[participantId]
            : null;
        const rawProfileAvatar = String(localAttributes.webmeetProfileAvatar || '').trim();
        if (!profileAvatar && rawProfileAvatar) {
            const parsed = JSON.parse(rawProfileAvatar);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                profileAvatar = parsed;
            }
        }
        if (!profileAvatar) return null;
        const userId = String(
            localAttributes.ploinkyUserId
            || localAttributes.workspaceUserId
            || localAttributes.userId
            || localAttributes.webmeetUserId
            || this.getCurrentActorId()
            || state.session?.participant?.userId
            || ''
        ).trim();
        return {
            profileAvatar,
            sourceAvatar: {
                enabled: profileAvatar.enabled !== false,
                config: profileAvatar.config || null,
                fallbackLetter: profileAvatar.fallbackLetter || '',
                user: userId ? { id: userId } : null
            }
        };
    }

    async publishAvatarProjection(profileAvatar = null, sourceAvatar = null, options = {}) {
        const state = this.getState();
        const meetingId = requireString(state.meetingId, 'meetingId');
        const participantId = requireString(state.participantId, 'participantId');
        const sequence = ++this.avatarProjectionSequence;
        const requestedProjection = { ...requireObject(profileAvatar, 'profileAvatar') };
        if (Object.prototype.hasOwnProperty.call(requestedProjection, 'runtimeState')) {
            const requestedRuntimeState = normalizeAvatarRuntimeState(requestedProjection.runtimeState);
            if (requestedRuntimeState) {
                requestedProjection.runtimeState = requestedRuntimeState;
            } else {
                delete requestedProjection.runtimeState;
            }
        }
        const currentRuntimeState = normalizeAvatarRuntimeState(
            this.getRoomAvatars()?.[participantId]?.runtimeState
        );
        const preserveRuntimeState = options.preserveRuntimeState !== false
            && String(requestedProjection.config?.expressionMode || '').trim() !== 'manual';
        const avatarProjection = preserveRuntimeState && currentRuntimeState && !requestedProjection.runtimeState
            ? { ...requestedProjection, runtimeState: currentRuntimeState }
            : requestedProjection;
        const avatarSource = sourceAvatar && typeof sourceAvatar === 'object' ? sourceAvatar : null;
        const userId = String(
            avatarSource?.user?.id
            || avatarProjection?.config?.agentId?.replace(/^profile:/, '')
            || this.getCurrentActorId()
            || ''
        ).trim();
        this.setRoomAvatar(participantId, avatarProjection);
        this.stateModel.setAvatar(participantId, avatarProjection);
        this.applyRealtimeParticipantAvatar({
            meetingId,
            participantId,
            userId,
            sequence,
            profileAvatar: avatarProjection
        });
        const localParticipant = this.getRoom()?.localParticipant || null;
        if (options.publishAttributes !== false && localParticipant && typeof localParticipant.setAttributes === 'function') {
            const attributeProjection = { ...avatarProjection };
            delete attributeProjection.runtimeState;
            const attributes = {
                ...(localParticipant.attributes && typeof localParticipant.attributes === 'object'
                    ? localParticipant.attributes
                    : {}),
                ...(userId ? {
                    webmeetUserId: userId,
                    userId,
                    workspaceUserId: userId,
                    ploinkyUserId: userId
                } : {}),
                webmeetProfileAvatar: JSON.stringify(attributeProjection)
            };
            try {
                await localParticipant.setAttributes(attributes);
            } catch (_) {
                // LiveKit metadata is a propagation hint; room state and realtime avatar payloads remain authoritative.
            }
        }
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED,
            meetingId,
            participantId,
            userId,
            sequence,
            profileAvatar: avatarProjection
        });
        this.dispatchRoomEvent(ROOM_EVENT_TYPES.AVATAR_PROJECTED, {
            source: 'local-avatar',
            payload: {
                meetingId,
                participantId,
                userId,
                sequence,
                profileAvatar: avatarProjection
            }
        });
        return avatarProjection;
    }

    async republishAvatarProjection() {
        const current = this.getCurrentPublishedAvatarProjection();
        if (!current?.profileAvatar) return;
        await this.publishAvatarProjection(current.profileAvatar, current.sourceAvatar || null, {
            publishAttributes: !current.profileAvatar.runtimeState
        });
    }

    async publishPendingAvatarRuntimeState() {
        let publishedAvatar = null;
        while (this.hasPendingAvatarRuntimeState) {
            const runtimeState = this.pendingAvatarRuntimeState;
            this.pendingAvatarRuntimeState = null;
            this.hasPendingAvatarRuntimeState = false;
            const current = this.getCurrentPublishedAvatarProjection();
            if (!current?.profileAvatar) continue;
            const profileAvatar = { ...current.profileAvatar };
            if (runtimeState) {
                profileAvatar.runtimeState = runtimeState;
            } else {
                delete profileAvatar.runtimeState;
            }
            await this.publishAvatarProjection(profileAvatar, current.sourceAvatar || null, {
                publishAttributes: false,
                preserveRuntimeState: false
            });
            publishedAvatar = profileAvatar;
        }
        return publishedAvatar;
    }

    publishAvatarRuntimeState(runtimeState = null) {
        const current = this.getCurrentPublishedAvatarProjection();
        if (!current?.profileAvatar) return Promise.resolve(null);
        this.pendingAvatarRuntimeState = normalizeAvatarRuntimeState(runtimeState);
        this.hasPendingAvatarRuntimeState = true;
        if (this.avatarRuntimePublishTask) return this.avatarRuntimePublishTask;
        this.avatarRuntimePublishTask = this.publishPendingAvatarRuntimeState()
            .finally(() => {
                this.avatarRuntimePublishTask = null;
            });
        return this.avatarRuntimePublishTask;
    }

    async requestAvatarState() {
        const state = this.getState();
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST,
            meetingId: requireString(state.meetingId, 'meetingId'),
            participantId: requireString(state.participantId, 'participantId')
        });
    }

    async sendChat(meetingId = '', message = '') {
        const state = this.getState();
        const targetMeetingId = String(meetingId || state.meetingId || '').trim();
        return this.getApi().sendChat({
            meetingId: requireString(targetMeetingId, 'meetingId'),
            participantId: requireString(state.participantId, 'participantId'),
            message: requireString(message, 'message')
        });
    }

    async loadGuestRoomState(meetingId = '') {
        const state = this.getState();
        const targetMeetingId = String(meetingId || state.meetingId || '').trim();
        return this.getApi().loadRoomState({
            meetingId: requireString(targetMeetingId, 'meetingId'),
            participantId: requireString(state.participantId, 'participantId')
        });
    }
}

import { MeetingPresenceController } from './controllers/meeting-presence-controller.js';
import { WebMeetRoomLiveKit } from './services/room/webmeet-room-livekit.js';
import { MeetingListController } from './controllers/meeting-list-controller.js';
import { ParticipantLayoutController } from './controllers/participant-layout-controller.js';
import { WebmeetMediaController } from './controllers/webmeet-media-controller.js';
import { mediaSettingsMethods } from './controllers/media-settings-methods.js';
import { participantViewMethods } from './controllers/participant-view-methods.js';
import { roomSessionMethods } from './controllers/room-session-methods.js';
import { meetingActionMethods } from './controllers/meeting-action-methods.js';
import { blackboardMethods } from './controllers/blackboard-methods.js';
import { dashboardRenderMethods } from './controllers/dashboard-render-methods.js';
import { dashboardChromeMethods } from './controllers/dashboard-chrome-methods.js';
import { dashboardDataMethods } from './controllers/dashboard-data-methods.js';
import { dashboardRealtimeMethods } from './controllers/dashboard-realtime-methods.js';
import { dashboardSessionMethods } from './controllers/dashboard-session-methods.js';
import { ChatComponent } from './service-components/index.js';
import {
    DEFAULT_HUM_FILTER,
    DEFAULT_MICROPHONE_GAIN,
    DEFAULT_OUTPUT_VOLUME,
    DEFAULT_VOICE_PROCESSING_MODE
} from './services/audio-processing/settings.js';
import {
    ensureBackgroundEffectsModule,
    ensureLiveKitClient,
    getBackgroundEffectsAssetPaths
} from './services/livekit-loader.js';
import { createRoomNotificationSoundService } from './services/room-notification-sounds.js';
import { createBrowserMeetingNotesTranscription } from './services/browser-meeting-notes-transcription.js';
import { RemoteAudioNormalizer } from './services/audio-processing/remote-audio-normalizer.js';
import { resumeRemoteAudioPlayback } from './services/audio-playback-recovery.js';
import { writeWebMeetResume } from './services/webmeet-session-store.js';
import { VoiceResponsiveAvatarController } from './services/audio-processing/voice-responsive-avatar.js';
import {
    logMediaDiagnostic,
    summarizeAudioMetrics
} from './services/media-diagnostics.js';
import { buildRtcConfigForSession, installRtcPeerConnectionOverride } from './services/rtc-config.js';
import { WebMeetRoom } from './services/room/webmeet-room.js';
import { WebMeetRoomEvents } from './services/room/webmeet-room-events.js';
import { runWebMeetTool } from './services/webmeet-api-client.js';
import {
    normalizeCurrentActor,
    WEBMEET_ROOMS_CATEGORY_ID
} from './services/dashboard-utils.js';

let avatarSettingsFormRegistrationPromise = null;

async function ensureParticipantCardRegistered() {
    const componentName = 'webmeet-participant-card';
    if (globalThis.customElements?.get?.(componentName)) return;
    const webSkel = globalThis.assistOS?.webSkel || globalThis.UI || globalThis.webSkel;
    if (typeof webSkel?.ensureComponentRegistered !== 'function') {
        throw new Error('WebMeet participant cards cannot be registered.');
    }
    await webSkel.ensureComponentRegistered(componentName);
    if (!globalThis.customElements?.get?.(componentName)) {
        throw new Error('WebMeet participant card registration did not complete.');
    }
}

function getSharedAvatarSettingsComponentBaseUrl() {
    return '/explorer/shared/ui/avatar-settings-form/avatar-settings-form';
}

async function fetchComponentText(url, description) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`${description} (${response.status})`);
    }
    return response.text();
}

async function ensureAvatarSettingsFormRegistered() {
    if (customElements.get('avatar-settings-form')) return;
    if (avatarSettingsFormRegistrationPromise) return avatarSettingsFormRegistrationPromise;
    avatarSettingsFormRegistrationPromise = (async () => {
        const baseUrl = getSharedAvatarSettingsComponentBaseUrl();
        const [template, css, module] = await Promise.all([
            fetchComponentText(`${baseUrl}.html`, 'Failed to load avatar settings template'),
            fetchComponentText(`${baseUrl}.css`, 'Failed to load avatar settings stylesheet'),
            import(`${baseUrl}.js?cacheBust=${Date.now()}`)
        ]);
        const webSkel = window.assistOS?.webSkel || window.UI;
        if (!webSkel?.defineComponent) {
            throw new Error('WebSkel is not available for avatar settings.');
        }
        await webSkel.defineComponent({
            name: 'avatar-settings-form',
            type: 'components',
            loadedTemplate: template,
            loadedCSSs: [css],
            presenterClassName: 'AvatarSettingsForm',
            presenterModule: module
        });
    })().catch((error) => {
        avatarSettingsFormRegistrationPromise = null;
        throw error;
    });
    return avatarSettingsFormRegistrationPromise;
}

export class WebmeetDashboard {
    constructor(element, invalidate, hostContext) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = hostContext || {};
        this.state = {
            meetings: [],
            chat: [],
            chatViewMode: 'normal',
            resources: [],
            agents: [],
            meetingParticipantsById: {},
            selectedMeetingId: '',
            joiningMeetingId: '',
            leavingMeeting: false,
            roomTransition: {
                active: false,
                message: ''
            },
            canManageRooms: false,
            showArchivedRooms: false,
            session: null,
            roomState: 'Disconnected',
            meetingNotesTranscriptionStatus: 'paused',
            meetingNotesActivity: null,
            media: {
                microphone: false,
                camera: false,
                screen: false
            },
            mediaDeafened: false,
            mediaDeafenRestoreMicrophone: false,
            mediaLoading: {
                microphone: false,
                camera: false,
                screen: false
            },
            mediaSettings: {
                audioInputDeviceId: '',
                videoInputDeviceId: '',
                audioOutputDeviceId: '',
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false,
                automaticParticipantVolume: true,
                microphoneGain: DEFAULT_MICROPHONE_GAIN,
                voiceProcessingMode: DEFAULT_VOICE_PROCESSING_MODE,
                humFilter: DEFAULT_HUM_FILTER,
                outputVolume: DEFAULT_OUTPUT_VOLUME,
                roomNotificationSounds: true,
                speechRecognitionLanguage: 'auto',
                cameraQuality: 'h720',
                screenShareQuality: 'h1080fps30',
                backgroundMode: 'none',
                backgroundBlurRadius: 12,
                backgroundImageDataUrl: '',
                backgroundImageName: ''
            },
            mediaDeviceWarnings: [],
            mediaSettingsPanelVisible: false,
            mediaSettingsApplying: false,
            mediaSettingsDraft: null,
            microphoneTest: {
                active: false,
                starting: false,
                recording: false,
                playing: false,
                status: 'Test your microphone before speaking.',
                statusState: 'idle',
                sampleStatus: 'No sample recorded.',
                sampleUrl: '',
                levelPercent: 0,
                clipping: false
            },
            activeSettingsTab: 'media',
            webMeetAvatarOverride: null,
            webMeetAvatarOverrideDraft: null,
            skipConnectedAvatarRepublishOnce: false,
            axiFacePacks: [],
            axiFaceGeneratedFaceStyles: [],
            axiFaceGeneratedFacePalettes: [],
            avatarQuickMenuVisible: false,
            avatarSubmenuVisible: false,
            roomAvatarsByParticipantId: {},
            avatarProjectionSequencesByParticipantId: {},
            participantAudioSettings: {},
            audioHealth: 'Good',
            audioCleanupStatus: 'voice-focus',
            audioNetworkUnstable: false,
            audioPlaybackBlocked: false,
            participants: [],
            activeSpeakerIds: new Set(),
            chatSidebarVisible: true,
            chatAddMenuVisible: false,
            activeMobilePanel: 'room',
            videoGridFullscreen: false,
            blackboard: {
                visible: false,
                presenterId: '',
                presenterName: ''
            },
            guestEntry: {
                active: false,
                roomId: '',
                displayName: '',
                status: '',
                joining: false,
                error: ''
            }
        };
        this.room = null;
        this.roboCommandStatuses = new Map();
        this.roboCommandStatusTimers = new Map();
        this.roboCommandDraftActive = false;
        this.blackboardPanelReady = false;
        this.workspaceMeetingsRefreshTimer = null;
        this.workspaceRosterRefreshTimer = null;
        this.audioWebRtcStatsTimer = null;
        this.microphoneTestSession = null;
        this.microphoneTestMetricsTimer = null;
        this.microphoneTestRestartTimer = null;
        this.avatarMetadataLoaded = false;
        this.avatarMetadataLoadFailed = false;
        this.avatarRuntimeLoadPromise = null;
        this.avatarRuntimeLoadFailed = false;
        this.initialDashboardDataLoadStarted = false;
        this.dashboardReadyDispatched = false;
        this.initialMediaDevicesRefreshStarted = false;
        this.handleParticipantAudioPreviewEvent = (event) => this.handleParticipantAudioPreview(event);
        this.handleAvatarSettingsUpdatedEvent = (event) => this.handleAvatarSettingsUpdated(event);
        this.handleWebMeetAvatarSettingsChangeEvent = (event) => this.handleWebMeetAvatarSettingsChange(event);
        this.handleChatInputKeydown = (event) => this.onChatInputKeydown(event);
        this.handleArchivedRoomsToggleChange = (event) => this.toggleArchivedRoomsVisibility(event);
        this.handleChatViewModeChange = (event) => {
            if (!event?.target?.matches?.('#webmeetChatViewMode')) return;
            this.state.chatViewMode = event.target.checked ? 'full' : 'normal';
            this.renderFeedLists();
        };
        this.handleSettingsModalReadyEvent = (event) => this.mountMediaSettingsModal(event);
        this.handleSettingsModalActionEvent = (event) => this.handleMediaSettingsModalAction(event);
        this.handleSettingsModalClosedEvent = (event) => this.handleMediaSettingsModalClosed(event);
        this.handleBlackboardPanelReadyEvent = (event) => {
            void this.handleBlackboardPanelReady?.(event);
        };
        this.handleBlackboardAttachmentUploadEvent = (event) => {
            const detail = event?.detail || {};
            event.stopPropagation?.();
            void this.chatComponent?.publishAttachments?.(detail.files, {
                boardId: detail.boardId,
                position: detail.position
            });
        };
        this.element.addEventListener('webmeet-blackboard-panel-ready', this.handleBlackboardPanelReadyEvent);
        this.element.addEventListener('webmeet-blackboard-attachment-upload', this.handleBlackboardAttachmentUploadEvent);
        this.element.addEventListener('click', this.handleClick);
        this.element.addEventListener('keydown', this.handleChatInputKeydown);
        this.element.addEventListener('change', this.handleArchivedRoomsToggleChange);
        this.element.addEventListener('change', this.handleChatViewModeChange);
        this.element.addEventListener('avatar-settings-change', this.handleWebMeetAvatarSettingsChangeEvent);
        window.addEventListener('webmeet:participant-audio-preview', this.handleParticipantAudioPreviewEvent);
        window.addEventListener('assistOS:avatar-settings-updated', this.handleAvatarSettingsUpdatedEvent);
        this.handleAudioRecoveryGesture = () => { void this.handleAudioRecoveryGestureEvent?.(); };
        this.handleAudioRecoveryResume = () => { void this.handleAudioRecoveryResumeEvent?.(); };
        this.element.addEventListener('pointerdown', this.handleAudioRecoveryGesture, { passive: true });
        this.element.addEventListener('keydown', this.handleAudioRecoveryGesture);
        globalThis.document?.addEventListener?.('visibilitychange', this.handleAudioRecoveryResume);
        window.addEventListener('focus', this.handleAudioRecoveryResume);
        this.lastAudioMetricsDiagnosticAt = 0;
        this.roomNotificationSoundService = createRoomNotificationSoundService({
            isEnabled: () => this.state.mediaSettings?.roomNotificationSounds !== false
        });
        this.roomNotificationSoundService?.bindUnlockEvents?.(this.element);
        this.roomLiveKit = new WebMeetRoomLiveKit({
            ensureLiveKitClient,
            buildRtcConfigForSession,
            installRtcPeerConnectionOverride,
            getAudioCaptureDefaults: () => this.mediaController.getMicrophoneEnableOptions(),
            getMediaQualitySettings: () => ({
                cameraQuality: this.normalizeCameraQuality(this.state.mediaSettings.cameraQuality),
                screenShareQuality: this.normalizeScreenShareQuality(this.state.mediaSettings.screenShareQuality)
            })
        });
        this.webMeetRoom = new WebMeetRoom({
            api: null,
            livekit: null,
            eventCodec: new WebMeetRoomEvents(),
            initialState: {},
            getSession: () => this.state.session,
            setSession: (session) => {
                this.state.session = session;
            },
            isGuestSession: () => this.isGuestSession(),
            getSelectedWorkspaceId: () => WEBMEET_ROOMS_CATEGORY_ID,
            connectLiveKit: () => this.connectRoom(),
            disconnectLiveKit: (options) => this.disconnectRoom(options),
            runTool: runWebMeetTool,
            getRoom: () => this.room,
            getRoomAvatars: () => this.state.roomAvatarsByParticipantId,
            setRoomAvatar: (participantId, avatar) => this.setRoomAvatar(participantId, avatar),
            applyRealtimeParticipantAvatar: (payload) => this.applyRealtimeParticipantAvatar(payload),
            publishRealtimePayload: (payload) => {
                const room = this.room?.localParticipant;
                if (!room || typeof payload !== 'string') {
                    throw new Error('Missing local participant realtime transport.');
                }
                const encoder = new TextEncoder();
                return room.publishData(encoder.encode(payload), { reliable: true });
            },
            getCurrentActorId: () => String(this.currentActor?.id || '').trim()
        });
        this.bindRoomEventHandlers();
        this.meetingListController = new MeetingListController();
        this.participantLayoutController = new ParticipantLayoutController({
            getParticipantDisplayName: (participant) => this.getParticipantDisplayName(participant),
            getAgentForParticipant: (participant) => this.getAgentForParticipant(participant),
            canDetachAgent: () => this.canManageRooms() && !this.isGuestSession(),
            getParticipantAudioState: (participant) => this.getParticipantAudioState(participant),
            getParticipantAvatarUserId: (participant) => this.getParticipantAvatarUserId(participant),
            getCurrentUserId: () => String(this.currentActor?.id || '').trim()
        });
        this.meetingDetailsLoadSeq = 0;
        this.meetingGetCache = new Map();
        this.pendingWorkspaceRosterRefreshMeetingIds = new Set();
        this.cachedStableParticipantId = '';
        this.chatSidebarWidth = this.loadChatSidebarWidth();
        this.handleMediaDeviceChange = null;
        this.mediaDevices = {
            audioInput: [],
            videoInput: [],
            audioOutput: []
        };
        this.presenceController = new MeetingPresenceController({
            getContext: () => ({
                meetingId: this.state.session?.meeting?.id,
                participantId: this.state.session?.participantIdentity
            }),
            cleanupLocalMedia: () => this.cleanupLocalLiveKitMediaForWindowExit(),
            disconnectLiveKit: () => this.webMeetRoom.disconnectLiveKit(),
            leaveCurrentSession: () => this.webMeetRoom.leaveCurrentSession()
        });
        this.mediaController = new WebmeetMediaController({
            getRoom: () => this.room,
            getTrack: () => window.LivekitClient?.Track || null,
            ensureBackgroundEffectsModule,
            getBackgroundEffectsAssetPaths,
            onMediaStateChange: (next, localParticipantId) => {
                this.state.media = next;
                writeWebMeetResume({ media: next });
                this.meetingNotesTranscription?.sync?.();
                if (localParticipantId) {
                    this.setParticipantMicState(localParticipantId, next.microphone);
                    const Track = window.LivekitClient?.Track || null;
                    if (!next.camera) {
                        this.participantLayoutController.clearParticipantVideoSources(localParticipantId, [
                            Track?.Source?.Camera,
                            'camera',
                            ''
                        ]);
                    }
                    if (!next.screen) {
                        this.participantLayoutController.clearParticipantVideoSources(localParticipantId, [
                            Track?.Source?.ScreenShare,
                            'screen_share',
                            'screen'
                        ]);
                    }
                }
            },
            onError: (message) => {
                this.setError(message);
            },
            onSettingsChange: (settings) => {
                this.state.mediaSettings = this.normalizeMediaSettings(settings);
                this.persistMediaSettings();
                this.renderMediaSettingsPanel();
            },
            onAudioMetrics: (metrics) => {
                this.state.audioHealth = this.state.audioNetworkUnstable
                    ? 'Network unstable'
                    : String(metrics?.health || 'Good');
                const now = Date.now();
                if (now - this.lastAudioMetricsDiagnosticAt >= 5000) {
                    this.lastAudioMetricsDiagnosticAt = now;
                    logMediaDiagnostic('local-audio-health', summarizeAudioMetrics({
                        ...metrics,
                        health: this.state.audioHealth
                    }));
                }
                this.updateAudioHealthIndicator();
            },
            onAudioCleanupStatusChange: (status) => {
                this.state.audioCleanupStatus = status;
                this.updateAudioHealthIndicator();
            },
            onAfterToggle: () => {
                this.renderMeetingSummary();
            }
        });
        this.meetingNotesTranscription = createBrowserMeetingNotesTranscription({
            getRoom: () => this.room,
            getEnabled: () => Boolean(this.state.session?.meetingNotes?.enabled),
            getMicrophoneEnabled: () => Boolean(this.state.media?.microphone),
            getLanguage: () => this.state.mediaSettings?.speechRecognitionLanguage || 'auto',
            onStatus: (status) => {
                this.state.meetingNotesTranscriptionStatus = status;
                this.renderMeetingNotesTranscriptionStatus?.();
            },
        });
        this.state.mediaSettings = this.loadMediaSettings();
        this.state.webMeetAvatarOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        this.mediaController.setSettings(this.state.mediaSettings);
        this.voiceResponsiveAvatarController = new VoiceResponsiveAvatarController({
            getRoom: () => this.room,
            getExpressionMode: () => this.getEffectiveAvatarExpressionMode?.(),
            onState: (runtimeState) => {
                void this.webMeetRoom.publishAvatarRuntimeState(runtimeState).catch(() => {});
            },
            onError: () => {
                // Voice expression is optional; LiveKit speaking/listening states remain available.
            }
        });
        void this.mediaController.preloadVoiceProcessing();
        this.remoteAudioNormalizer = new RemoteAudioNormalizer({
            isEnabled: () => this.state.mediaSettings?.automaticParticipantVolume !== false,
            hasManualOverride: (participantId) => this.hasParticipantAudioOverrideForParticipant(participantId),
            onMultiplierChange: (mediaElement) => this.applyOutputVolumePreviewToElement(mediaElement)
        });

        this._initComponents();
        this.registerActions();
        this.registerWindowPresenceHandlers();
        this.registerMediaDeviceChangeHandler();
        void ensureAvatarSettingsFormRegistered()
            .then(() => this.renderAvatarControls?.())
            .catch((error) => this.setError?.(error instanceof Error ? error.message : String(error)));
        this.invalidate();
    }

    _initComponents() {
        this.chatComponent = new ChatComponent({
            isGuestSession: () => this.isGuestSession(),
            sendPublicChat: (meetingId, message) => this.sendPublicChat(meetingId, message),
            getState: () => this.state,
            setState: (updates) => Object.assign(this.state, updates),
            setError: (msg) => this.setError(msg),
            getSelectedMeeting: () => this.selectedMeeting,
            getSession: () => this.state.session,
            renderFeedLists: () => this.renderFeedLists(),
            publishRealtimePayload: (payload) => this.publishRealtimePayload(payload),
            refreshBlackboard: (result, options) => this.refreshChatBlackboard(result, options),
            executeBlackboardClientAction: async (action = {}) => {
                if (action.type !== 'scripta-insert-group') throw new Error('Unsupported Blackboard client action.');
                await this.applyBlackboardVisibility({
                    meetingId: this.selectedMeeting?.id || '',
                    participantId: this.state.session?.participantIdentity || '',
                    visible: true,
                    presenterId: 'agent_robo_team',
                    presenterName: 'RoboTeam'
                });
                await new Promise((resolve, reject) => {
                    if (!this.blackboardPanel) return reject(new Error('Blackboard panel is not available.'));
                    this.blackboardPanel.dispatchEvent(new CustomEvent('webmeet-blackboard-insert-group-scripta', {
                        detail: { groupId: action.groupId, alt: action.alt, resolve, reject }
                    }));
                });
            },
            updateRoboCommandStatus: (status) => this.updateRoboCommandStatus(status, { publish: true }),
            updateRoboDraftState: (active) => this.setRoboCommandDraftActive(active),
            loadMeetingDetails: () => this.loadMeetingDetails(),
            getRoom: () => this.room,
            getActiveBoardId: () => this.blackboardAdapter?.boardId || '',
        });

    }

    async beforeRender() {
        await ensureParticipantCardRegistered();
        this.prepareInitialRouteState?.();
        return null;
    }

    async afterRender() {
        writeWebMeetResume({ open: true });
        globalThis.__onExpandedModalClose = () => this.handleExpandedModalUserClose();
        this.cacheElements();
        this.registerChatSidebarResizer();
        this.ensureHelpTooltipPositioning();
        this.registerMediaSettingsInputHandlers();
        this.renderMediaSettingsPanel();
        if (!this.initialMediaDevicesRefreshStarted) {
            this.initialMediaDevicesRefreshStarted = true;
            void this.refreshMediaDevices({ requestPermission: false, showToast: false });
        }
        this.renderAll();
        if (!this.dashboardReadyDispatched) {
            this.dashboardReadyDispatched = true;
            window.__WEBMEET_DASHBOARD_READY__ = true;
            window.dispatchEvent(new CustomEvent('webmeet-dashboard-ready'));
        }
        if (!this.initialDashboardDataLoadStarted) {
            this.initialDashboardDataLoadStarted = true;
            const loadInitialData = async () => {
                await this.loadInitialDashboardData?.();
            };
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(loadInitialData);
            } else {
                Promise.resolve().then(loadInitialData);
            }
        }
    }

    ensureHelpTooltipPositioning() {
        if (!this.element || this.element.dataset.webmeetHelpTooltipPositioning === 'true') return;
        const updateFromEvent = (event) => {
            const control = event.target?.closest?.('.webmeet-setting-help-control');
            if (control) this.positionHelpTooltip(control);
        };
        const updateActive = () => {
            const control = this.element.querySelector('.webmeet-setting-help-control:focus-within');
            if (control) this.positionHelpTooltip(control);
        };
        this.element.addEventListener('pointerenter', updateFromEvent, true);
        this.element.addEventListener('focusin', updateFromEvent, true);
        this.element.addEventListener('click', updateFromEvent, true);
        this.element.addEventListener('scroll', updateActive, true);
        window.addEventListener('resize', updateActive, { passive: true });
        this.element.dataset.webmeetHelpTooltipPositioning = 'true';
    }

    positionHelpTooltip(control) {
        if (!control || !globalThis.matchMedia?.('(max-width: 720px)')?.matches) return;
        const tooltip = control.querySelector('.webmeet-setting-help-tooltip');
        if (!tooltip) return;
        const viewportWidth = document.documentElement?.clientWidth || window.innerWidth || 0;
        const viewportHeight = document.documentElement?.clientHeight || window.innerHeight || 0;
        if (!viewportWidth || !viewportHeight) return;
        const margin = 12;
        const width = Math.max(0, Math.min(280, viewportWidth - margin * 2));
        tooltip.style.setProperty('--webmeet-help-tooltip-width', `${width}px`);
        const controlRect = control.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const tooltipHeight = tooltipRect.height || 80;
        const centeredLeft = controlRect.left + controlRect.width / 2 - width / 2;
        const left = Math.min(Math.max(margin, centeredLeft), Math.max(margin, viewportWidth - width - margin));
        let top = controlRect.bottom + 8;
        if (top + tooltipHeight + margin > viewportHeight) {
            top = Math.max(margin, controlRect.top - tooltipHeight - 8);
        }
        tooltip.style.setProperty('--webmeet-help-tooltip-left', `${Math.round(left)}px`);
        tooltip.style.setProperty('--webmeet-help-tooltip-top', `${Math.round(top)}px`);
    }

    registerActions() {
        if (this.hostContext && typeof this.hostContext.registerAction === 'function') {
            const actions = [
                'closeModal',
                'createMeeting',
                'openRoomSettings',
                'copyRoomLink',
                'joinMeeting',
                'leaveMeeting',
                'toggleMicrophone',
                'toggleDeafen',
                'enableSoundPlayback',
                'toggleCamera',
                'toggleScreenShare',
                'toggleVideoGridFullscreen',
                'toggleChatSidebar',
                'toggleChatAddMenu',
                'selectChatAddFile',
                'openChatAttachment',
                'downloadChatAttachment',
                'toggleMediaSettings',
                'closeMediaSettings',
                'setSettingsTab',
                'applyMediaSettings',
                'applyWebMeetAvatarSettings',
                'applyWebMeetAvatarPreset',
                'applyWebMeetAvatarStyle',
                'applyWebMeetAvatarPack',
                'resetWebMeetAvatarOverride',
                'toggleAvatarQuickMenu',
                'toggleAvatarSubmenu',
                'refreshMediaDevices',
                'openParticipantAudioSettings',
                'focusParticipantCard',
                'sendChat',
                'attachRoboTeam',
                'attachObserver',
                'attachAssistant',
                'attachScribe',
                'detachAgent',
                'detachAgentFromCard',
                'selectMeeting',
                'selectAndJoinMeeting'
            ];

            actions.forEach(action => {
                this.hostContext.registerAction(action, this[action].bind(this));
            });
        }
    }

    onChatInputKeydown(event) {
        if (this.state.chatAddMenuVisible && event.key === 'Escape') {
            event.preventDefault();
            this.closeChatAddMenu({ restoreFocus: true });
            return;
        }
        if (
            this.state.chatAddMenuVisible
            && event.target?.closest?.('#webmeetChatAddMenu')
            && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        ) {
            event.preventDefault();
            this.chatAddFileOption?.focus?.();
            return;
        }
        if (!event.target?.matches?.('#webmeetChatInput')) return;
        if (event.key !== 'Enter' || event.isComposing) return;
        if (event.shiftKey || event.altKey || event.ctrlKey) return;
        event.preventDefault();
        void this.sendChat();
    }

    handleClick = (event) => {
        if (
            this.state.chatAddMenuVisible
            && !event.target?.closest?.('.webmeet-chat-add-control')
        ) {
            this.closeChatAddMenu();
        }
        if (
            this.state.avatarQuickMenuVisible
            && !event.target?.closest?.('.webmeet-avatar-quick-action')
        ) {
            this.state.avatarQuickMenuVisible = false;
            this.renderAvatarControls?.();
        }

        const mobilePanelButton = event.target?.closest?.('[data-mobile-panel]');
        if (mobilePanelButton) {
            this.setMobilePanel(String(mobilePanelButton.dataset.mobilePanel || 'room').trim());
            return;
        }

        // Handle collapse/expand buttons
        const collapseButton = event.target?.closest?.('[data-collapse]');
        if (collapseButton) {
            const collapsibleId = String(collapseButton.dataset.collapse || '').trim();

            // Toggle button state
            collapseButton.classList.toggle('collapsed');

            const collapsibles = this.element.querySelectorAll(`[data-collapsible="${collapsibleId}"]`);
            const isCollapsed = collapseButton.classList.contains('collapsed');

            // Toggle collapsible elements
            collapsibles.forEach(el => {
                el.classList.toggle('expanded', !isCollapsed);
            });

            return;
        }
    };

    cacheElements() {
        this.roomCategoryList = this.element.querySelector('#webmeetRoomCategoryList');
        this.toastContainer = this.element.querySelector('#webmeetToastContainer');
        this.meetingList = this.element.querySelector('#webmeetMeetingList');
        this.meetingTitle = this.element.querySelector('#webmeetMeetingTitle');
        this.meetingMeta = this.element.querySelector('#webmeetMeetingMeta');
        this.meetingNotesStatus = this.element.querySelector('#webmeetMeetingNotesStatus');
        this.joinStatus = this.element.querySelector('#webmeetJoinStatus');
     //   this.activeRoomTitle = this.element.querySelector('#webmeetActiveRoomTitle');
        this.lifecycle = this.element.querySelector('#webmeetLifecycle');
        this.joinPayload = this.element.querySelector('#webmeetJoinPayload');
        this.chatList = this.element.querySelector('#webmeetChatList');
        this.chatComposer = this.element.querySelector('#webmeetChatComposer');
        this.chatInput = this.element.querySelector('#webmeetChatInput');
        this.chatActionButton = this.element.querySelector('#webmeetChatActionButton');
        this.chatAttachmentButton = this.element.querySelector('#webmeetChatAttachmentButton');
        this.chatFileInput = this.element.querySelector('#webmeetChatFileInput');
        this.chatAddMenu = this.element.querySelector('#webmeetChatAddMenu');
        this.chatAddFileOption = this.element.querySelector('#webmeetChatAddFileOption');
        this.chatDropOverlay = this.element.querySelector('#webmeetChatDropOverlay');
        this.chatSpeechStatus = this.element.querySelector('#webmeetChatSpeechStatus');
        this.chatViewMode = this.element.querySelector('#webmeetChatViewMode');
        this.roomConnectionState = this.element.querySelector('#webmeetRoomConnectionState');
        this.videoGrid = this.element.querySelector('#webmeetVideoGrid');
        this.videoGridEmpty = this.element.querySelector('#webmeetVideoEmpty');
        this.videoGridAll = this.element.querySelector('#webmeetVideoAll');
        this.videoGridThumbnails = this.element.querySelector('#webmeetVideoThumbnails');
        this.leaveButton = this.element.querySelector('#webmeetLeaveButton');
        this.exitOverlay = this.element.querySelector('#webmeetExitOverlay');
        this.roomTransitionMessage = this.element.querySelector('#webmeetRoomTransitionMessage');
        this.micButton = this.element.querySelector('#webmeetMicButton');
        this.deafenButton = this.element.querySelector('#webmeetDeafenButton');
        this.cameraButton = this.element.querySelector('#webmeetCameraButton');
        this.screenShareButton = this.element.querySelector('#webmeetScreenShareButton');
        this.blackboardButton = this.element.querySelector('#webmeetBlackboardButton');
        this.blackboardSurface = this.element.querySelector('#webmeetBlackboardSurface');
        this.blackboardPresenter = this.element.querySelector('#webmeetBlackboardPresenter');
        this.blackboardCommandStatus = this.element.querySelector('#webmeetBlackboardCommandStatus');
        this.blackboardPanel = this.element.querySelector('webmeet-blackboard-panel');
        this.videoGridFullscreenButton = this.element.querySelector('#webmeetVideoGridFullscreenButton');
        this.dashboardRoot = this.element.querySelector('.webmeet-dashboard');
        this.chatSidebar = this.element.querySelector('#webmeetChatSidebar');
        this.chatResizer = this.element.querySelector('#webmeetChatResizer');
        this.toggleChatButton = this.element.querySelector('#webmeetToggleChatButton');
        this.archivedRoomsToggle = this.element.querySelector('#webmeetArchivedRoomsToggle');
        this.showArchivedRoomsInput = this.element.querySelector('#webmeetShowArchivedRooms');
        this.createRoomButton = this.element.querySelector('#webmeetCreateRoomButton');
        this.mediaSettingsButton = this.element.querySelector('#webmeetMediaSettingsButton');
        this.cacheMediaSettingsElements();
        this.avatarSourceLabel = null;
        this.avatarSourceLabel = this.element.querySelector('#webmeetAvatarSourceLabel');
        this.avatarQuickButton = this.element.querySelector('#webmeetAvatarQuickButton');
        this.avatarQuickMenu = this.element.querySelector('#webmeetAvatarQuickMenu');
        this.audioHealthIndicator = this.element.querySelector('#webmeetAudioHealthIndicator');
        this.audioCleanupIndicator = this.element.querySelector('#webmeetAudioCleanupIndicator');
        this.enableSoundButton = this.element.querySelector('#webmeetEnableSoundButton');
        this.welcomeScreen = this.element.querySelector('#webmeetWelcomeScreen');
        this.meetingBar = this.element.querySelector('.webmeet-meeting-bar');
        this.mainContent = this.element.querySelector('.webmeet-main-content');
        this.mobileNav = this.element.querySelector('.webmeet-mobile-nav');
        this.mobileNavButtons = Array.from(this.element.querySelectorAll('[data-mobile-panel]'));
        this.meetingListController.setElement(this.meetingList);
        this.participantLayoutController.setElements({
            videoGrid: this.videoGrid,
            videoGridAll: this.videoGridAll,
            videoGridEmpty: this.videoGridEmpty,
            videoGridThumbnails: this.videoGridThumbnails
        });

        // Set elements on new modular components
        this.chatComponent?.setElements({
            chatComposer: this.chatComposer,
            chatInput: this.chatInput,
            chatActionButton: this.chatActionButton,
            chatAttachmentButton: this.chatAttachmentButton,
            chatFileInput: this.chatFileInput,
            chatDropOverlay: this.chatDropOverlay,
            chatSpeechStatus: this.chatSpeechStatus
        });

        this.applyChatAddMenuState();

        this.applyChatSidebarWidth();
        this.applyMobilePanelState();
        this.updateAudioHealthIndicator();
    }

    afterUnload() {
        if (globalThis.__onExpandedModalClose) {
            try { delete globalThis.__onExpandedModalClose; } catch (_) { globalThis.__onExpandedModalClose = null; }
        }
        this.element.removeEventListener('webmeet-blackboard-panel-ready', this.handleBlackboardPanelReadyEvent);
        this.element.removeEventListener('webmeet-blackboard-attachment-upload', this.handleBlackboardAttachmentUploadEvent);
        this.element.removeEventListener('click', this.handleClick);
        this.element.removeEventListener('submit', this.handleSubmitEvent);
        this.element.removeEventListener('keydown', this.handleChatInputKeydown);
        this.element.removeEventListener('change', this.handleArchivedRoomsToggleChange);
        this.element.removeEventListener('change', this.handleChatViewModeChange);
        this.element.removeEventListener('avatar-settings-change', this.handleWebMeetAvatarSettingsChangeEvent);
        this.chatComponent?.destroy?.();
        this.meetingNotesTranscription?.destroy?.();
        this.stopWorkspaceEvents();
        this.clearWorkspaceMeetingsRefreshTimer();
        this.clearWorkspaceRosterRefreshTimer();
        this.uninstallJoinMaterialRefreshListeners?.();
        window.clearInterval(this.audioWebRtcStatsTimer);
        this.audioWebRtcStatsTimer = null;
        void this.stopMicrophoneTest?.();
        this.unregisterMediaDeviceChangeHandler();
        window.removeEventListener('webmeet:settings-modal-ready', this.handleSettingsModalReadyEvent);
        window.removeEventListener('webmeet:settings-modal-action', this.handleSettingsModalActionEvent);
        window.removeEventListener('webmeet:settings-modal-closed', this.handleSettingsModalClosedEvent);
        this.clearMediaSettingsElementRefs();
        this.resetBlackboardUiState?.();
        this.remoteAudioNormalizer?.stopAll?.();
        this.voiceResponsiveAvatarController?.destroy?.();
        this.participantLayoutController?.dispose?.();
        this.roomNotificationSoundService?.teardown?.();
        window.removeEventListener('webmeet:participant-audio-preview', this.handleParticipantAudioPreviewEvent);
        this.element.removeEventListener('pointerdown', this.handleAudioRecoveryGesture);
        this.element.removeEventListener('keydown', this.handleAudioRecoveryGesture);
        globalThis.document?.removeEventListener?.('visibilitychange', this.handleAudioRecoveryResume);
        window.removeEventListener('focus', this.handleAudioRecoveryResume);
        this.presenceController.teardown();
        if (this.state.session?.participantIdentity) {
            void this.unjoinCurrentSession({ preserveDisplayName: false });
            return;
        }
        void this.disconnectRoom();
    }

    get selectedMeeting() {
        return this.state.meetings.find((entry) => entry.id === this.state.selectedMeetingId) || null;
    }

    updateAudioHealthIndicator() {
        const health = String(this.state.audioHealth || 'Good').trim() || 'Good';
        const healthKey = health.toLowerCase().replaceAll(' ', '-');
        const usingBrowserCleanup = this.state.audioCleanupStatus === 'browser';
        if (this.audioHealthIndicator) {
            this.audioHealthIndicator.dataset.health = healthKey;
            this.audioHealthIndicator.title = `Audio: ${health}`;
        }
        if (this.audioCleanupIndicator) {
            this.audioCleanupIndicator.classList.toggle('webmeet-hidden', !usingBrowserCleanup);
        }
        if (this.enableSoundButton) {
            const blocked = Boolean(this.state.audioPlaybackBlocked);
            this.enableSoundButton.classList.toggle('webmeet-hidden', !blocked);
            this.enableSoundButton.setAttribute('aria-hidden', blocked ? 'false' : 'true');
        }
        if (this.micButton) {
            const cleanupLabel = usingBrowserCleanup ? ' - Using browser audio cleanup' : '';
            const label = `Toggle Microphone - Audio: ${health}${cleanupLabel}`;
            this.micButton.title = label;
            this.micButton.setAttribute('aria-label', label);
        }
    }

    toggleArchivedRoomsVisibility(event) {
        if (!event?.target?.matches?.('#webmeetShowArchivedRooms')) return;
        if (!this.canManageRooms()) {
            this.state.showArchivedRooms = false;
            event.target.checked = false;
            return;
        }
        this.state.showArchivedRooms = event.target.checked === true;
        this.renderMeetingList();
    }

    get currentActor() {
        return normalizeCurrentActor();
    }

}

Object.assign(
    WebmeetDashboard.prototype,
    dashboardChromeMethods,
    dashboardDataMethods,
    dashboardRealtimeMethods,
    dashboardSessionMethods,
    participantViewMethods,
    roomSessionMethods,
    meetingActionMethods,
    blackboardMethods,
    dashboardRenderMethods,
    mediaSettingsMethods
);

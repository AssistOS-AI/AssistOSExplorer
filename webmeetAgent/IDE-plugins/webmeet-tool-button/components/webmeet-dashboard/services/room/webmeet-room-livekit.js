import { logMediaDiagnostic } from '../media-diagnostics.js';
import {
    getLiveKitProfileResolution,
    getMediaQualityProfile
} from '../../controllers/media-quality-profiles.js';

export const AUDIO_PUBLISH_DEFAULTS = Object.freeze({
    audioPreset: Object.freeze({ maxBitrate: 32000 }),
    dtx: true,
    red: true,
    forceStereo: false,
    stopMicTrackOnMute: true
});

export class WebMeetRoomLiveKit {
    constructor(options = {}) {
        this.ensureLiveKitClient = options.ensureLiveKitClient;
        this.buildRtcConfigForSession = options.buildRtcConfigForSession;
        this.installRtcPeerConnectionOverride = options.installRtcPeerConnectionOverride;
        this.getAudioCaptureDefaults = typeof options.getAudioCaptureDefaults === 'function'
            ? options.getAudioCaptureDefaults
            : (() => ({
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }));
        this.getMediaQualitySettings = typeof options.getMediaQualitySettings === 'function'
            ? options.getMediaQualitySettings
            : (() => ({
                cameraQuality: 'h720',
                screenShareQuality: 'h1080fps30'
            }));
        this.room = null;
        this.restoreRtcPeerConnection = null;
    }

    getQualityProfile(type, quality) {
        return getMediaQualityProfile(type, quality);
    }

    getVideoCaptureDefaults(livekit) {
        const settings = this.getMediaQualitySettings();
        const profile = this.getQualityProfile('camera', settings.cameraQuality);
        return {
            resolution: getLiveKitProfileResolution(livekit, 'camera', profile)
        };
    }

    getAudioPublishDefaults() {
        return {
            ...AUDIO_PUBLISH_DEFAULTS,
            audioPreset: { ...AUDIO_PUBLISH_DEFAULTS.audioPreset }
        };
    }

    getPublishDefaults() {
        const settings = this.getMediaQualitySettings();
        const profile = this.getQualityProfile('camera', settings.cameraQuality);
        return {
            ...this.getAudioPublishDefaults(),
            videoEncoding: { ...profile.encoding }
        };
    }

    getRoom() {
        return this.room;
    }

    captureDisconnect(room = this.room) {
        return { room, restore: room === this.room ? this.restoreRtcPeerConnection : null };
    }

    releaseOwner({ room, restore }) {
        if (this.restoreRtcPeerConnection === restore) {
            restore?.();
            this.restoreRtcPeerConnection = null;
        }
        if (this.room === room) this.room = null;
    }

    async connect(session, hooks = {}) {
        if (!session?.participantToken || !session?.livekitUrl) {
            throw new Error('Join payload missing media token');
        }
        const livekit = await this.ensureLiveKitClient();
        if (hooks.isCurrent && !hooks.isCurrent()) return;
        const { Room, RoomEvent, Track } = livekit;

        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = this.installRtcPeerConnectionOverride(session);
        const restore = this.restoreRtcPeerConnection;
        const audioCaptureDefaults = this.getAudioCaptureDefaults();
        const rtcConfig = this.buildRtcConfigForSession(session);

        const room = new Room({
            adaptiveStream: false,
            dynacast: false,
            audioCaptureDefaults,
            videoCaptureDefaults: this.getVideoCaptureDefaults(livekit),
            publishDefaults: this.getPublishDefaults(),
            stopLocalTrackOnUnpublish: true
        });
        this.room = room;
        const suppliedHooks = hooks;
        hooks = { ...suppliedHooks };
        for (const [name, callback] of Object.entries(suppliedHooks)) {
            if (!name.startsWith('on') || name === 'onDisconnected' || typeof callback !== 'function') continue;
            hooks[name] = (...args) => {
                if (this.room === room && (!suppliedHooks.isCurrent || suppliedHooks.isCurrent())) return callback(...args);
            };
        }
        hooks.onRoomCreated?.({ room, livekit, Track, RoomEvent });

        room
            .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                hooks.onTrackSubscribed?.(track, publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
                hooks.onTrackUnsubscribed?.(track, publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackPublished, (publication, participant) => {
                hooks.onRemoteTrackPublished?.(publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.LocalTrackPublished, (publication) => {
                hooks.onLocalTrackPublished?.(publication, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.LocalTrackUnpublished, (publication) => {
                hooks.onLocalTrackUnpublished?.(publication, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.ParticipantConnected, (participant) => {
                hooks.onParticipantConnected?.(participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.ParticipantDisconnected, (participant) => {
                hooks.onParticipantDisconnected?.(participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
                hooks.onActiveSpeakersChanged?.(participants, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackMuted, (publication, participant) => {
                hooks.onTrackMuted?.(publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackUnmuted, (publication, participant) => {
                hooks.onTrackUnmuted?.(publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.DataReceived, (payload, participant) => {
                hooks.onDataReceived?.(payload, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.ParticipantAttributesChanged, (changedAttributes, participant) => {
                hooks.onParticipantAttributesChanged?.(changedAttributes, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.Disconnected, () => {
                const owned = this.room === room;
                this.releaseOwner({ room, restore });
                if (owned && (!hooks.isCurrent || hooks.isCurrent())) hooks.onDisconnected?.({ room, livekit, Track, RoomEvent });
            });
        if (RoomEvent.ConnectionQualityChanged) {
            room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
                hooks.onConnectionQualityChanged?.(quality, participant, { room, livekit, Track, RoomEvent });
            });
        }

        const connectStartMs = Date.now();
        try {
            hooks.onConnecting?.({ room, livekit, Track, RoomEvent });
            const connectOptions = {
                autoSubscribe: true,
                ...(rtcConfig ? { rtcConfig } : {})
            };
            const iceUrlCount = (rtcConfig?.iceServers || []).reduce((sum, s) => {
                const u = s?.urls;
                return sum + (Array.isArray(u) ? u.length : (u ? 1 : 0));
            }, 0);
            const iceCategories = (rtcConfig?.iceServers || []).reduce((acc, s) => {
                for (const u of [].concat(s?.urls || [])) {
                    const lower = String(u || '').toLowerCase();
                    if (lower.startsWith('stun:')) acc.hasStun = true;
                    else if (lower.startsWith('turns:')) acc.hasTurns = true;
                    else if (lower.startsWith('turn:')) acc.hasTurn = true;
                }
                return acc;
            }, { hasStun: false, hasTurn: false, hasTurns: false });
            const livekitUrl = new URL(session.livekitUrl, window.location.href);
            if (livekitUrl.protocol === 'https:') livekitUrl.protocol = 'wss:';
            if (livekitUrl.protocol === 'http:') livekitUrl.protocol = 'ws:';
            if (!['ws:', 'wss:'].includes(livekitUrl.protocol)) {
                throw new Error('Join payload contains an invalid media URL');
            }
            logMediaDiagnostic('room-connect-start', {
                livekitHost: (() => {
                    try {
                        return livekitUrl.host;
                    } catch (_) {
                        return '';
                    }
                })(),
                hasRtcConfig: Boolean(rtcConfig),
                iceServerCount: Number(rtcConfig?.iceServers?.length || 0),
                iceUrlCount,
                ...iceCategories,
                iceTransportPolicy: rtcConfig?.iceTransportPolicy || '',
                roomOptions: {
                    adaptiveStream: false,
                    dynacast: false,
                    stopLocalTrackOnUnpublish: true
                },
                connectOptions: {
                    autoSubscribe: true,
                    hasRtcConfig: Boolean(rtcConfig)
                }
            });
            await room.connect(
                livekitUrl.toString(),
                session.participantToken,
                connectOptions
            );
            if ((hooks.isCurrent && !hooks.isCurrent()) || this.room !== room) {
                await this.disconnect({ room, restore });
                return;
            }
            logMediaDiagnostic('room-connect-complete', {
                localIdentity: room.localParticipant?.identity || '',
                remoteParticipantCount: Number(room.remoteParticipants?.size || 0),
                elapsedMs: Date.now() - connectStartMs,
            });
            hooks.onConnected?.({ room, livekit, Track, RoomEvent });
            return { room, livekit, Track, RoomEvent };
        } catch (error) {
            if (!hooks.isCurrent || hooks.isCurrent()) hooks.onConnectError?.(error, { room, livekit, Track, RoomEvent });
            logMediaDiagnostic('room-connect-error', {
                errorName: String(error?.name || ''),
                errorMessage: String(error?.message || '').slice(0, 200),
                elapsedMs: Date.now() - connectStartMs,
            });
            try {
                await room.disconnect();
            } catch (_) {
                // ignore disconnect after failed connect
            }
            this.releaseOwner({ room, restore });
            throw error;
        }
    }

    async disconnect(captured = this.captureDisconnect()) {
        const { room } = captured;
        if (!room) return;
        try {
            await room.disconnect();
        } catch (_) {
            // ignore disconnect failures
        }
        this.releaseOwner(captured);
    }

    teardown() {
        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = null;
        this.room = null;
    }
}

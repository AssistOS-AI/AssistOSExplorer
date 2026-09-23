import {
    logMediaDiagnostic,
    summarizePublication
} from '../services/media-diagnostics.js';
import {
    isEnhancedVoiceProcessingSupported,
    preloadVoiceProcessingWorklet
} from '../services/audio-processing/microphone-track-factory.js';
import {
    buildMicrophoneAudioConstraints,
    resolveMicrophoneProfile,
    summarizeAppliedAudioSettings
} from '../services/audio-processing/capture-constraints.js';
import { MicrophoneCaptureSession } from '../services/audio-processing/microphone-capture-session.js';
import {
    DEFAULT_HUM_FILTER,
    DEFAULT_MICROPHONE_GAIN,
    DEFAULT_OUTPUT_VOLUME,
    DEFAULT_VOICE_PROCESSING_MODE,
    normalizeHumFilter,
    normalizeMicrophoneGain,
    normalizeVoiceProcessingMode,
    usesAudioGraph
} from '../services/audio-processing/settings.js';
import { isMicrophonePublication } from '../services/microphone-publication.js';
import { getMediaQualityProfile } from './media-quality-profiles.js';

export class WebmeetMediaController {
    constructor(options = {}) {
        this.getRoom = typeof options.getRoom === 'function' ? options.getRoom : (() => null);
        this.getTrack = typeof options.getTrack === 'function' ? options.getTrack : (() => window.LivekitClient?.Track || null);
        this.ensureBackgroundEffectsModule = typeof options.ensureBackgroundEffectsModule === 'function'
            ? options.ensureBackgroundEffectsModule
            : null;
        this.getBackgroundEffectsAssetPaths = typeof options.getBackgroundEffectsAssetPaths === 'function'
            ? options.getBackgroundEffectsAssetPaths
            : (() => ({}));
        this.onMediaStateChange = typeof options.onMediaStateChange === 'function' ? options.onMediaStateChange : (() => {});
        this.onMicStateChange = typeof options.onMicStateChange === 'function' ? options.onMicStateChange : (() => {});
        this.onError = typeof options.onError === 'function' ? options.onError : (() => {});
        this.onAfterToggle = typeof options.onAfterToggle === 'function' ? options.onAfterToggle : (() => {});
        this.onSettingsChange = typeof options.onSettingsChange === 'function' ? options.onSettingsChange : (() => {});
        this.onAudioMetrics = typeof options.onAudioMetrics === 'function' ? options.onAudioMetrics : (() => {});
        this.onAudioCleanupStatusChange = typeof options.onAudioCleanupStatusChange === 'function'
            ? options.onAudioCleanupStatusChange
            : (() => {});
        this.settings = {
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
            cameraQuality: 'h720',
            screenShareQuality: 'h1080fps30',
            backgroundMode: 'none',
            backgroundBlurRadius: 12,
            backgroundImageDataUrl: '',
            backgroundImageName: ''
        };
        this.inFlight = false;
        this.captureSession = new MicrophoneCaptureSession({
            onError: (message) => this.onError(message)
        });
        this.audioCleanupStatus = 'voice-focus';
        this.backgroundProcessor = null;
        this.backgroundProcessorTrack = null;
        this.backgroundSyncPromise = null;
    }

    reset() {
        this.inFlight = false;
        this.setAudioCleanupStatus('voice-focus');
        this.stopProcessedMicrophoneCapture();
        void this.clearBackgroundEffect();
    }

    setSettings(next = {}) {
        this.settings = {
            ...this.settings,
            ...next
        };
    }

    replaceUnsupportedVoiceProcessingMode(mode, reason) {
        const normalizedMode = normalizeVoiceProcessingMode(mode);
        if (normalizeVoiceProcessingMode(this.settings.voiceProcessingMode) === normalizedMode) return;
        this.settings = {
            ...this.settings,
            voiceProcessingMode: normalizedMode
        };
        this.onSettingsChange(this.getSettings(), reason);
    }

    getSettings() {
        return { ...this.settings };
    }

    get activeMicrophoneCapture() {
        return this.captureSession?.activeCapture || null;
    }

    async preloadVoiceProcessing() {
        if (!isEnhancedVoiceProcessingSupported()) return false;
        try {
            await preloadVoiceProcessingWorklet();
            return true;
        } catch (_) {
            return false;
        }
    }

    setAudioCleanupStatus(status) {
        const normalizedStatus = String(status || '').trim() || 'voice-focus';
        if (this.audioCleanupStatus === normalizedStatus) return;
        this.audioCleanupStatus = normalizedStatus;
        this.onAudioCleanupStatusChange(normalizedStatus);
    }

    normalizeBackgroundMode(value) {
        const mode = String(value || '').trim();
        return ['none', 'blur', 'image'].includes(mode) ? mode : 'none';
    }

    normalizeBackgroundBlurRadius(value) {
        const radius = Number(value);
        if (!Number.isFinite(radius)) return 12;
        return Math.min(24, Math.max(4, Math.round(radius)));
    }

    getLocalCameraTrack(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!localParticipant?.trackPublications?.values) return null;
        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication?.track) continue;
            const isCameraSource = Track?.Source?.Camera
                ? publication.source === Track.Source.Camera
                : String(publication.source || '').toLowerCase() === 'camera';
            const isFallbackCameraVideo = publication.kind === Track?.Kind?.Video && !publication.source;
            if (isCameraSource || isFallbackCameraVideo) {
                return publication.track;
            }
        }
        return null;
    }

    getBackgroundProcessorOptions() {
        const mode = this.normalizeBackgroundMode(this.settings.backgroundMode);
        if (mode === 'blur') {
            return {
                mode: 'background-blur',
                blurRadius: this.normalizeBackgroundBlurRadius(this.settings.backgroundBlurRadius),
                assetPaths: this.getBackgroundEffectsAssetPaths()
            };
        }
        if (mode === 'image') {
            const imagePath = String(this.settings.backgroundImageDataUrl || '').trim();
            if (!imagePath) {
                throw new Error('Choose a background image before enabling virtual background.');
            }
            return {
                mode: 'virtual-background',
                imagePath,
                assetPaths: this.getBackgroundEffectsAssetPaths()
            };
        }
        return {
            mode: 'disabled',
            assetPaths: this.getBackgroundEffectsAssetPaths()
        };
    }

    async ensureBackgroundEffectsSupport() {
        if (!this.ensureBackgroundEffectsModule) {
            throw new Error('Background effects are not available in this build.');
        }
        const module = await this.ensureBackgroundEffectsModule();
        if (typeof module?.BackgroundProcessor !== 'function') {
            throw new Error('Background effects failed to load.');
        }
        if (typeof module?.supportsBackgroundProcessors === 'function' && !module.supportsBackgroundProcessors()) {
            throw new Error('This browser does not support background blur or virtual background in WebMeet.');
        }
        return module;
    }

    async clearBackgroundEffect(track = this.backgroundProcessorTrack || this.getLocalCameraTrack()) {
        const targetTrack = track || null;
        if (targetTrack && typeof targetTrack.stopProcessor === 'function') {
            try {
                await targetTrack.stopProcessor();
            } catch (_) {
                // keep local state cleanup even if the SDK already released the processor
            }
        }
        this.backgroundProcessor = null;
        this.backgroundProcessorTrack = null;
    }

    async applyBackgroundEffectToCamera() {
        const backgroundMode = this.normalizeBackgroundMode(this.settings.backgroundMode);
        const cameraTrack = this.getLocalCameraTrack();
        if (!cameraTrack) {
            this.backgroundProcessor = null;
            this.backgroundProcessorTrack = null;
            return;
        }
        if (backgroundMode === 'none') {
            await this.clearBackgroundEffect(cameraTrack);
            return;
        }
        if (typeof cameraTrack.setProcessor !== 'function') {
            throw new Error('This browser cannot apply camera background effects.');
        }
        const module = await this.ensureBackgroundEffectsSupport();
        const options = this.getBackgroundProcessorOptions();
        if (this.backgroundProcessor && this.backgroundProcessorTrack === cameraTrack && typeof this.backgroundProcessor.switchTo === 'function') {
            await this.backgroundProcessor.switchTo(options);
            return;
        }
        if (this.backgroundProcessorTrack && this.backgroundProcessorTrack !== cameraTrack) {
            await this.clearBackgroundEffect(this.backgroundProcessorTrack);
        }
        const processor = module.BackgroundProcessor(options);
        await cameraTrack.setProcessor(processor);
        this.backgroundProcessor = processor;
        this.backgroundProcessorTrack = cameraTrack;
    }

    async syncBackgroundEffect() {
        const next = Promise.resolve(this.backgroundSyncPromise)
            .catch(() => {})
            .then(() => this.applyBackgroundEffectToCamera());
        this.backgroundSyncPromise = next.finally(() => {
            if (this.backgroundSyncPromise === next) {
                this.backgroundSyncPromise = null;
            }
        });
        return this.backgroundSyncPromise;
    }

    getMicrophoneProfile(overrides = {}) {
        return resolveMicrophoneProfile({
            ...this.settings,
            voiceProcessingMode: overrides.voiceProcessingMode || this.settings.voiceProcessingMode
        });
    }

    getMicrophoneEnableOptions(overrides = {}) {
        const settings = {
            ...this.settings,
            ...overrides,
            voiceProcessingMode: overrides.voiceProcessingMode || this.settings.voiceProcessingMode
        };
        return buildMicrophoneAudioConstraints(settings, overrides);
    }

    summarizeAppliedMicrophoneSettings(mediaStreamTrack) {
        return summarizeAppliedAudioSettings(mediaStreamTrack);
    }

    getMicrophoneGain() {
        return normalizeMicrophoneGain(this.settings.microphoneGain);
    }

    usesProcessedMicrophoneTrack(settings = this.settings) {
        return usesAudioGraph({
            ...settings,
            microphoneGain: normalizeMicrophoneGain(settings.microphoneGain),
            voiceProcessingMode: normalizeVoiceProcessingMode(settings.voiceProcessingMode),
            humFilter: normalizeHumFilter(settings.humFilter)
        });
    }

    getCameraQualityProfile() {
        return getMediaQualityProfile('camera', this.settings.cameraQuality);
    }

    getScreenShareQualityOptions() {
        const profile = getMediaQualityProfile('screen', this.settings.screenShareQuality);
        return {
            resolution: { ...profile.resolution }
        };
    }

    getCameraPublishOptions() {
        const profile = this.getCameraQualityProfile();
        return {
            videoEncoding: { ...profile.encoding }
        };
    }

    getScreenSharePublishOptions() {
        const profile = getMediaQualityProfile('screen', this.settings.screenShareQuality);
        return {
            simulcast: false,
            videoEncoding: { ...profile.encoding }
        };
    }

    async stopProcessedMicrophoneCapture() {
        const session = this.captureSession;
        if (!session) {
            return;
        }
        const room = this.getRoom();
        await session.stop(async (capture) => {
            if (capture?.track && room?.localParticipant?.unpublishTrack) {
                await room.localParticipant.unpublishTrack(capture.track, true);
            }
        });
    }

    async enableDefaultMicrophone(
        room,
        voiceProcessingMode = normalizeVoiceProcessingMode(this.settings.voiceProcessingMode),
        overrides = {}
    ) {
        await this.stopProcessedMicrophoneCapture();
        const options = this.getMicrophoneEnableOptions({ ...overrides, voiceProcessingMode });
        try {
            await room.localParticipant.setMicrophoneEnabled(true, options);
        } catch (_) {
            await room.localParticipant.setMicrophoneEnabled(true);
        }
        this.setAudioCleanupStatus(normalizeVoiceProcessingMode(voiceProcessingMode) === 'off' ? 'off' : 'browser');
    }

    async enableProcessedMicrophone(room, settings = this.settings) {
        await room.localParticipant.setMicrophoneEnabled(false);
        await this.stopProcessedMicrophoneCapture();
        const capture = await this.captureSession.start({
            ...settings,
            onMetrics: (metrics) => this.onAudioMetrics(metrics)
        });
        if (!capture) {
            return;
        }
        const Track = this.getTrack();
        const publishOptions = Track?.Source?.Microphone
            ? { source: Track.Source.Microphone, name: 'microphone' }
            : { name: 'microphone' };
        await room.localParticipant.publishTrack(capture.track, publishOptions);
        this.captureSession.markPublished();
        this.setAudioCleanupStatus('voice-focus');
    }

    async enableMicrophone(room) {
        const mode = normalizeVoiceProcessingMode(this.settings.voiceProcessingMode);
        if (mode === 'auto') {
            if (isEnhancedVoiceProcessingSupported()) {
                try {
                    await preloadVoiceProcessingWorklet();
                    await this.enableProcessedMicrophone(room, {
                        ...this.settings,
                        voiceProcessingMode: 'auto',
                        microphoneGain: DEFAULT_MICROPHONE_GAIN,
                        humFilter: DEFAULT_HUM_FILTER
                    });
                    return;
                } catch (_) {
                    this.onError('Voice Focus is unavailable. Using browser audio cleanup.');
                }
            }
            await this.enableMicrophoneWithMode(room, 'standard', {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                microphoneGain: 1,
                humFilter: 'off'
            });
            this.setAudioCleanupStatus('browser');
            return;
        }
        if (mode === 'enhanced' && !isEnhancedVoiceProcessingSupported()) {
            this.replaceUnsupportedVoiceProcessingMode('standard', 'enhanced-unsupported');
            this.onError('Enhanced voice processing is unavailable in this browser. Using standard microphone processing.');
            await this.enableMicrophoneWithMode(room, 'standard');
            return;
        }
        if (mode === 'enhanced') {
            try {
                await this.enableProcessedMicrophone(room, { ...this.settings, voiceProcessingMode: 'enhanced' });
                return;
            } catch (_) {
                this.replaceUnsupportedVoiceProcessingMode('standard', 'enhanced-failed');
                this.onError('Enhanced voice processing failed. Using standard microphone processing.');
                await this.enableMicrophoneWithMode(room, 'standard');
                return;
            }
        }
        await this.enableMicrophoneWithMode(room, mode);
    }

    async enableMicrophoneWithMode(room, mode, overrides = {}) {
        const settings = { ...this.settings, ...overrides, voiceProcessingMode: mode };
        if (!this.usesProcessedMicrophoneTrack(settings)) {
            await this.enableDefaultMicrophone(room, mode, overrides);
            return;
        }
        try {
            await this.enableProcessedMicrophone(room, settings);
        } catch (error) {
            await this.enableDefaultMicrophone(room, mode, overrides);
            this.onError('Microphone processing is unavailable. Using standard microphone audio.');
        }
    }

    async disableMicrophone(room) {
        this.hardStopMicrophoneTracks();
        await this.stopProcessedMicrophoneCapture();
        await room.localParticipant.setMicrophoneEnabled(false);
        this.setAudioCleanupStatus('voice-focus');
    }

    setLocalMicrophoneMuted(muted) {
        const tracks = this.getLocalMicrophoneTracks();
        for (const track of tracks) {
            if (!track) continue;
            try {
                if (muted && typeof track.mute === 'function') {
                    track.mute();
                    continue;
                }
                if (!muted && typeof track.unmute === 'function') {
                    track.unmute();
                    continue;
                }
            } catch (_) {
                // fall through to direct MediaStreamTrack enabled toggle
            }
            try {
                if (track.mediaStreamTrack) {
                    track.mediaStreamTrack.enabled = !muted;
                }
            } catch (_) {
                // ignore best-effort mute errors
            }
        }
        const sourceTrack = this.activeMicrophoneCapture?.sourceStream?.getAudioTracks?.()?.[0] || null;
        if (sourceTrack) {
            try {
                sourceTrack.enabled = !muted;
            } catch (_) {
                // ignore best-effort source mute errors
            }
        }
        return tracks.length > 0 || Boolean(sourceTrack);
    }

    async muteMicrophone(room) {
        const mutedExistingTrack = this.setLocalMicrophoneMuted(true);
        if (!mutedExistingTrack) {
            await room.localParticipant.setMicrophoneEnabled(false);
        }
    }

    async unmuteMicrophone(room) {
        const unmutedExistingTrack = this.setLocalMicrophoneMuted(false);
        if (!unmutedExistingTrack) {
            await this.enableMicrophone(room);
        }
    }

    async restartMicrophone() {
        const room = this.getRoom();
        if (!room?.localParticipant || !this.isLocalSourceEnabled('microphone')) return;
        await this.runExclusiveToggle(async () => {
            await this.disableMicrophone(room);
            await this.enableMicrophone(room);
            await this.waitForLocalSourceState('microphone', true);
        });
    }

    getLocalMicrophoneTracks(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) return [];
        const tracks = [];
        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            if (!isMicrophonePublication(publication, Track, {
                allowLocalCustomFallback: true,
                activeMicrophoneTrack: this.activeMicrophoneCapture?.track || null
            })) continue;
            if (publication.track) {
                tracks.push(publication.track);
            }
        }
        return tracks;
    }

    hasActiveMicrophoneCapture(TrackRef = null) {
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            const readyState = String(mediaStreamTrack?.readyState || '').toLowerCase();
            const muted = track?.isMuted === true || mediaStreamTrack?.enabled === false;
            if (readyState === 'live' && !muted) {
                return true;
            }
        }
        return false;
    }

    getActiveMicrophoneMediaStreamTrack(TrackRef = null) {
        const sourceTrack = this.activeMicrophoneCapture?.sourceStream?.getAudioTracks?.()?.[0] || null;
        if (String(sourceTrack?.readyState || '').toLowerCase() === 'live') {
            return sourceTrack;
        }
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            if (String(mediaStreamTrack?.readyState || '').toLowerCase() === 'live') {
                return mediaStreamTrack;
            }
        }
        return null;
    }

    hardStopMicrophoneTracks(TrackRef = null) {
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            if (!track) continue;
            try {
                if (typeof track.stop === 'function') {
                    track.stop();
                    continue;
                }
            } catch (_) {
                // continue to fallback stop path
            }
            try {
                track.mediaStreamTrack?.stop?.();
            } catch (_) {
                // ignore best-effort stop errors
            }
        }
    }

    hardStopTrack(track) {
        if (!track) return;
        try {
            if (typeof track.stop === 'function') {
                track.stop();
                return;
            }
        } catch (_) {
            // continue to fallback stop path
        }
        try {
            track.mediaStreamTrack?.stop?.();
        } catch (_) {
            // ignore best-effort stop errors
        }
    }

    hardStopAllLocalPublishedTracks(room = this.getRoom()) {
        const publications = room?.localParticipant?.trackPublications?.values?.() || [];
        for (const publication of publications) {
            this.hardStopTrack(publication?.track || null);
        }
    }

    async stopAllLocalMedia(room = this.getRoom()) {
        this.hardStopMicrophoneTracks();
        await this.stopProcessedMicrophoneCapture();
        await this.clearBackgroundEffect();
        const localParticipant = room?.localParticipant || null;
        if (localParticipant) {
            for (const action of [
                () => localParticipant.setMicrophoneEnabled?.(false),
                () => localParticipant.setCameraEnabled?.(false),
                () => localParticipant.setScreenShareEnabled?.(false)
            ]) {
                try {
                    const result = action();
                    if (result && typeof result.then === 'function') {
                        await result;
                    }
                } catch (_) {
                    // keep shutting down the remaining local sources
                }
            }
        }
        this.hardStopAllLocalPublishedTracks(room);
        const localId = String(room?.localParticipant?.identity || '').trim();
        this.onMediaStateChange({ microphone: false, camera: false, screen: false }, localId);
    }

    async waitForMicrophoneHardStopped(timeoutMs = 1500) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            if (!this.hasActiveMicrophoneCapture()) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return !this.hasActiveMicrophoneCapture();
    }

    getCameraEnableOptions() {
        const videoDeviceId = String(this.settings.videoInputDeviceId || '').trim();
        const deviceId = videoDeviceId
            ? ({ exact: videoDeviceId })
            : undefined;
        return {
            deviceId,
            resolution: { ...this.getCameraQualityProfile().resolution }
        };
    }

    isLocalSourceEnabled(type, TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) {
            return false;
        }
        const sourceMap = {
            microphone: Track.Source?.Microphone,
            camera: Track.Source?.Camera,
            screen: Track.Source?.ScreenShare
        };
        const wantedSource = sourceMap[type];
        const wantedKind = type === 'microphone' ? Track.Kind.Audio : Track.Kind.Video;

        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            const sameKind = publication.kind === wantedKind;
            const sameSource = wantedSource ? publication.source === wantedSource : false;
            const sameCustomMic = type === 'microphone' && isMicrophonePublication(publication, Track, {
                allowLocalCustomFallback: true,
                activeMicrophoneTrack: this.activeMicrophoneCapture?.track || null
            });
            const mediaStreamTrack = publication.track?.mediaStreamTrack || null;
            const localTrackMuted = publication.track?.isMuted === true
                || (mediaStreamTrack && mediaStreamTrack.enabled === false);
            if (
                (sameSource || sameCustomMic || (type === 'camera' && sameKind && !publication.source))
                && !publication.isMuted
                && !localTrackMuted
            ) {
                return true;
            }
        }
        return false;
    }

    getLocalMediaStateFromRoom(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        const next = {
            microphone: false,
            camera: false,
            screen: false
        };
        if (!Track || !localParticipant?.trackPublications?.values) {
            return next;
        }
        next.microphone = this.isLocalSourceEnabled('microphone', Track) || this.hasActiveMicrophoneCapture(Track);
        next.camera = this.isLocalSourceEnabled('camera', Track);
        next.screen = this.isLocalSourceEnabled('screen', Track);
        return next;
    }

    async waitForLocalSourceState(type, enabled, timeoutMs = 1200) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            const current = this.isLocalSourceEnabled(type);
            if (current === enabled) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return false;
    }

    syncLocalMediaStateFromRoom(TrackRef = null) {
        const next = this.getLocalMediaStateFromRoom(TrackRef);
        const room = this.getRoom();
        const localId = String(room?.localParticipant?.identity || '').trim();
        this.onMediaStateChange(next, localId);
        return next;
    }

    async runExclusiveToggle(action) {
        if (this.inFlight) {
            return;
        }
        this.inFlight = true;
        try {
            await action();
        } catch (error) {
            this.onError(error instanceof Error ? error.message : String(error));
        } finally {
            this.syncLocalMediaStateFromRoom();
            this.onAfterToggle();
            this.inFlight = false;
        }
    }

    async toggleMicrophone() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before enabling the microphone.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const enable = !this.isLocalSourceEnabled('microphone');
            if (enable) {
                await this.unmuteMicrophone(room);
            } else {
                await this.muteMicrophone(room);
            }
            await this.waitForLocalSourceState('microphone', enable);
        });
    }

    async toggleCamera() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before enabling the camera.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const localParticipant = room.localParticipant;
            const shouldEnableCamera = !this.isLocalSourceEnabled('camera');
            if (shouldEnableCamera) {
                const options = this.getCameraEnableOptions();
                const publishOptions = this.getCameraPublishOptions();
                try {
                    await localParticipant.setCameraEnabled(true, options, publishOptions);
                } catch (_) {
                    await localParticipant.setCameraEnabled(true);
                    this.onError('Selected camera quality could not be used. WebMeet is using browser default camera settings.');
                }
                await this.waitForLocalSourceState('camera', true);
                await this.syncBackgroundEffect();
            } else {
                await this.clearBackgroundEffect();
                await localParticipant.setCameraEnabled(false);
                await this.waitForLocalSourceState('camera', false);
            }
        });
    }

    async toggleScreenShare() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before starting screen share.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const localParticipant = room.localParticipant;
            const shouldEnableScreen = !this.isLocalSourceEnabled('screen');
            const captureOptions = this.getScreenShareQualityOptions();
            const publishOptions = this.getScreenSharePublishOptions();
            logMediaDiagnostic('screen-share-toggle-requested', {
                enable: shouldEnableScreen,
                captureOptions,
                publishOptions
            });
            if (shouldEnableScreen) {
                await localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions);
            } else {
                await localParticipant.setScreenShareEnabled(false);
            }
            await this.waitForLocalSourceState('screen', shouldEnableScreen);
            logMediaDiagnostic('screen-share-toggle-completed', {
                enable: shouldEnableScreen,
                publications: Array.from(localParticipant.trackPublications?.values?.() || [])
                    .map((publication) => summarizePublication(publication))
            });
        });
    }
}

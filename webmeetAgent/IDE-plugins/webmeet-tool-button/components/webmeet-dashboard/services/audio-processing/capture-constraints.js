import { normalizeVoiceProcessingMode } from './settings.js';

export const MICROPHONE_PROFILES = Object.freeze(['standard', 'advanced']);
export const ADVANCED_PROFILE_MODES = Object.freeze(['auto', 'enhanced']);

function normalizeDeviceId(value) {
    return String(value || '').trim();
}

export function resolveMicrophoneProfile(settings = {}) {
    const mode = normalizeVoiceProcessingMode(settings.voiceProcessingMode);
    return ADVANCED_PROFILE_MODES.includes(mode) ? 'advanced' : 'standard';
}

export function getAudioContextConstructor() {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

export function isAdvancedVoiceProcessingSupported() {
    const browserNavigator = globalThis.navigator;
    return Boolean(
        browserNavigator?.mediaDevices?.getUserMedia
        && getAudioContextConstructor()
        && globalThis.AudioWorkletNode
    );
}

function resolveBoolean(overrideValue, fallback) {
    return overrideValue === undefined ? fallback : Boolean(overrideValue);
}

export function buildMicrophoneAudioConstraints(settings = {}, overrides = {}) {
    const profile = MICROPHONE_PROFILES.includes(overrides.profile)
        ? overrides.profile
        : resolveMicrophoneProfile(settings);
    const advanced = profile === 'advanced';
    const mode = normalizeVoiceProcessingMode(overrides.voiceProcessingMode || settings.voiceProcessingMode);
    const processingEnabled = mode !== 'off';
    const deviceId = normalizeDeviceId(overrides.deviceId === undefined ? settings.audioInputDeviceId : overrides.deviceId);

    const echoCancellation = resolveBoolean(
        overrides.echoCancellation,
        processingEnabled && settings.echoCancellation !== false
    );
    const noiseSuppression = resolveBoolean(
        overrides.noiseSuppression,
        processingEnabled && !advanced && settings.noiseSuppression !== false
    );
    const autoGainControl = resolveBoolean(
        overrides.autoGainControl,
        processingEnabled && (advanced || settings.autoGainControl === true)
    );
    const voiceIsolation = resolveBoolean(
        overrides.voiceIsolation,
        processingEnabled && settings.voiceIsolation === true
    );

    const audio = {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation,
        noiseSuppression,
        autoGainControl,
        voiceIsolation
    };
    if (deviceId) {
        audio.deviceId = { exact: deviceId };
    }
    return audio;
}

export function buildMicrophoneCaptureOptions(settings = {}, overrides = {}) {
    return {
        audio: buildMicrophoneAudioConstraints(settings, overrides),
        video: false
    };
}

const AUDIO_SETTING_KEYS = Object.freeze([
    'echoCancellation',
    'noiseSuppression',
    'autoGainControl',
    'voiceIsolation',
    'sampleRate',
    'channelCount'
]);

export function compareRequestedAndAppliedAudioSettings(requested = {}, applied = {}) {
    const differences = {};
    for (const key of AUDIO_SETTING_KEYS) {
        if (requested[key] === undefined) continue;
        const appliedValue = applied?.[key];
        if (appliedValue === undefined) {
            differences[key] = { requested: requested[key], applied: null };
            continue;
        }
        if (Boolean(appliedValue) !== Boolean(requested[key])) {
            differences[key] = { requested: requested[key], applied: appliedValue };
        }
    }
    return differences;
}

export function summarizeAppliedAudioSettings(mediaStreamTrack) {
    let settings = {};
    try {
        settings = mediaStreamTrack?.getSettings?.() || {};
    } catch (_) {
        settings = {};
    }
    return {
        deviceId: settings.deviceId ? '<redacted>' : undefined,
        sampleRate: Number.isFinite(Number(settings.sampleRate)) ? Number(settings.sampleRate) : undefined,
        channelCount: Number.isFinite(Number(settings.channelCount)) ? Number(settings.channelCount) : undefined,
        echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : undefined,
        noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : undefined,
        autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : undefined,
        voiceIsolation: typeof settings.voiceIsolation === 'boolean' ? settings.voiceIsolation : undefined
    };
}

export const VOICE_PROCESSING_MODES = Object.freeze(['auto', 'custom', 'enhanced', 'standard', 'off']);
export const HUM_FILTER_MODES = Object.freeze(['auto', 'off', '50', '60']);
export const DEFAULT_VOICE_PROCESSING_MODE = 'auto';
export const DEFAULT_MICROPHONE_GAIN = 0.8;
export const DEFAULT_OUTPUT_VOLUME = 0.8;
export const DEFAULT_HUM_FILTER = 'off';

export function normalizeVoiceProcessingMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return VOICE_PROCESSING_MODES.includes(mode) ? mode : DEFAULT_VOICE_PROCESSING_MODE;
}

export function normalizeHumFilter(value) {
    const mode = String(value || '').trim().toLowerCase().replace(/hz$/g, '');
    return HUM_FILTER_MODES.includes(mode) ? mode : DEFAULT_HUM_FILTER;
}

export function normalizeMicrophoneGain(value) {
    const gain = Number(value);
    if (!Number.isFinite(gain)) return DEFAULT_MICROPHONE_GAIN;
    return Math.min(2, Math.max(0, gain));
}

export function usesAudioGraph(settings = {}) {
    return ['auto', 'enhanced'].includes(normalizeVoiceProcessingMode(settings.voiceProcessingMode))
        || normalizeHumFilter(settings.humFilter) !== 'off'
        || Math.abs(normalizeMicrophoneGain(settings.microphoneGain) - 1) > 0.001;
}

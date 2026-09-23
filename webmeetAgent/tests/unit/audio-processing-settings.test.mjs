import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_HUM_FILTER,
    DEFAULT_MICROPHONE_GAIN,
    DEFAULT_VOICE_PROCESSING_MODE,
    normalizeHumFilter,
    normalizeMicrophoneGain,
    normalizeVoiceProcessingMode,
    usesAudioGraph
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/settings.js';

test('voice processing mode normalization defaults to auto', () => {
    assert.equal(DEFAULT_VOICE_PROCESSING_MODE, 'auto');
    assert.equal(normalizeVoiceProcessingMode('auto'), 'auto');
    assert.equal(normalizeVoiceProcessingMode('custom'), 'custom');
    assert.equal(normalizeVoiceProcessingMode('enhanced'), 'enhanced');
    assert.equal(normalizeVoiceProcessingMode('standard'), 'standard');
    assert.equal(normalizeVoiceProcessingMode('off'), 'off');
    assert.equal(normalizeVoiceProcessingMode(''), DEFAULT_VOICE_PROCESSING_MODE);
    assert.equal(normalizeVoiceProcessingMode('unknown'), DEFAULT_VOICE_PROCESSING_MODE);
});

test('hum filter normalization accepts auto, off, 50 and 60 hertz modes', () => {
    assert.equal(DEFAULT_HUM_FILTER, 'off');
    assert.equal(normalizeHumFilter('auto'), 'auto');
    assert.equal(normalizeHumFilter('off'), 'off');
    assert.equal(normalizeHumFilter('50'), '50');
    assert.equal(normalizeHumFilter('50hz'), '50');
    assert.equal(normalizeHumFilter('60HZ'), '60');
    assert.equal(normalizeHumFilter('120'), DEFAULT_HUM_FILTER);
});

test('microphone gain normalization clamps to supported range', () => {
    assert.equal(DEFAULT_MICROPHONE_GAIN, 0.8);
    assert.equal(normalizeMicrophoneGain(undefined), DEFAULT_MICROPHONE_GAIN);
    assert.equal(normalizeMicrophoneGain(-1), 0);
    assert.equal(normalizeMicrophoneGain(0.75), 0.75);
    assert.equal(normalizeMicrophoneGain(3), 2);
});

test('audio graph is used only when processing steps are requested', () => {
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'auto', humFilter: 'off', microphoneGain: 1 }), true);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'custom', humFilter: 'off', microphoneGain: 1 }), false);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'custom', humFilter: '60', microphoneGain: 1 }), true);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'standard', humFilter: 'off', microphoneGain: 1 }), false);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'enhanced', humFilter: 'off', microphoneGain: 1 }), true);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'standard', humFilter: '50', microphoneGain: 1 }), true);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'off', humFilter: 'off', microphoneGain: 1.2 }), true);
});

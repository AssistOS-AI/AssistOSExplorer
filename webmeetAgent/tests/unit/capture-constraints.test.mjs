import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildMicrophoneAudioConstraints,
    compareRequestedAndAppliedAudioSettings,
    resolveMicrophoneProfile,
    summarizeAppliedAudioSettings
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/capture-constraints.js';

test('microphone profile maps automatic modes to advanced and the rest to standard', () => {
    assert.equal(resolveMicrophoneProfile({ voiceProcessingMode: 'auto' }), 'advanced');
    assert.equal(resolveMicrophoneProfile({ voiceProcessingMode: 'enhanced' }), 'advanced');
    assert.equal(resolveMicrophoneProfile({ voiceProcessingMode: 'standard' }), 'standard');
    assert.equal(resolveMicrophoneProfile({ voiceProcessingMode: 'custom' }), 'standard');
    assert.equal(resolveMicrophoneProfile({ voiceProcessingMode: 'off' }), 'standard');
});

test('advanced capture keeps echo cancellation, disables browser noise suppression, and pins the device', () => {
    assert.deepEqual(buildMicrophoneAudioConstraints({
        voiceProcessingMode: 'auto',
        audioInputDeviceId: 'device-1',
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
    }), {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        voiceIsolation: false,
        deviceId: { exact: 'device-1' }
    });
});

test('standard capture follows the browser processing preferences', () => {
    assert.deepEqual(buildMicrophoneAudioConstraints({
        voiceProcessingMode: 'standard',
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
    }), {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        voiceIsolation: false
    });
});

test('capture overrides and the off mode control each constraint explicitly', () => {
    const overridden = buildMicrophoneAudioConstraints(
        { voiceProcessingMode: 'auto', audioInputDeviceId: 'x' },
        { noiseSuppression: true, deviceId: '' }
    );
    assert.equal(overridden.noiseSuppression, true);
    assert.equal(overridden.deviceId, undefined);

    const disabled = buildMicrophoneAudioConstraints({ voiceProcessingMode: 'off', echoCancellation: true });
    assert.equal(disabled.echoCancellation, false);
    assert.equal(disabled.noiseSuppression, false);
    assert.equal(disabled.autoGainControl, false);
    assert.equal(disabled.voiceIsolation, false);
});

test('requested settings are compared against the applied track settings', () => {
    assert.deepEqual(compareRequestedAndAppliedAudioSettings(
        { echoCancellation: true, noiseSuppression: false },
        { echoCancellation: true, noiseSuppression: false }
    ), {});
    assert.deepEqual(compareRequestedAndAppliedAudioSettings(
        { echoCancellation: true, noiseSuppression: false },
        { echoCancellation: false, noiseSuppression: false }
    ), {
        echoCancellation: { requested: true, applied: false }
    });
    assert.deepEqual(compareRequestedAndAppliedAudioSettings(
        { echoCancellation: true },
        {}
    ), {
        echoCancellation: { requested: true, applied: null }
    });
});

test('applied capture settings are summarized with a redacted device id', () => {
    assert.deepEqual(summarizeAppliedAudioSettings({
        getSettings: () => ({
            deviceId: 'raw-device',
            sampleRate: 48000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: true,
            voiceIsolation: false
        })
    }), {
        deviceId: '<redacted>',
        sampleRate: 48000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        voiceIsolation: false
    });
});

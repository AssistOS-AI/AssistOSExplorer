import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mediaSettingsMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/media-settings-methods.js';

function createHarness() {
    return { ...mediaSettingsMethods };
}

test('media device normalization removes browser virtual defaults and concrete duplicates', () => {
    const harness = createHarness();
    const devices = harness.normalizeEnumeratedMediaDevices([
        {
            kind: 'audioinput',
            deviceId: 'default',
            groupId: 'mic-group',
            label: 'Default - Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'communications',
            groupId: 'mic-group',
            label: 'Communications - Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'mic-1',
            groupId: 'mic-group',
            label: 'Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'mic-1-copy',
            groupId: 'mic-group',
            label: 'Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'mic-2',
            groupId: 'other-mic-group',
            label: 'USB Microphone'
        },
        {
            kind: 'audiooutput',
            deviceId: 'default',
            groupId: 'speaker-group',
            label: 'Default - Studio Speakers'
        },
        {
            kind: 'audiooutput',
            deviceId: 'speaker-1',
            groupId: 'speaker-group',
            label: 'Studio Speakers'
        },
        {
            kind: 'videoinput',
            deviceId: 'camera-1',
            groupId: 'camera-group',
            label: 'HD Camera'
        }
    ]);

    assert.deepEqual(
        devices.audioInput.map((device) => device.deviceId),
        ['mic-1', 'mic-2']
    );
    assert.deepEqual(
        devices.audioOutput.map((device) => device.deviceId),
        ['speaker-1']
    );
    assert.deepEqual(
        devices.videoInput.map((device) => device.deviceId),
        ['camera-1']
    );
});

test('device options render only concrete identifiable devices plus the system default', () => {
    const harness = createHarness();
    let rendered = null;
    const selectElement = {
        setAttribute() {},
        webSkelPresenter: { setOptions: (options) => { rendered = options; } },
        value: ''
    };
    harness.renderMediaDeviceOptions(selectElement, [
        { kind: 'audioinput', deviceId: '', label: '' },
        { kind: 'audioinput', deviceId: 'mic-1', label: '' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Microphone' }
    ], '', 'Microphone');

    assert.deepEqual(rendered, [
        { value: '', label: 'System default' },
        { value: 'mic-2', label: 'USB Microphone' }
    ]);
});

test('permission-gated device placeholders are not selectable', () => {
    const harness = createHarness();
    const devices = harness.normalizeEnumeratedMediaDevices([
        { kind: 'audioinput', deviceId: '', groupId: '', label: '' },
        { kind: 'audioinput', deviceId: '', groupId: '', label: '' },
        { kind: 'audioinput', deviceId: '', groupId: '', label: '' },
        { kind: 'audioinput', deviceId: 'mic-1', groupId: 'g1', label: 'USB Microphone' }
    ]);

    assert.deepEqual(devices.audioInput.map((device) => device.deviceId), ['mic-1']);
});

test('virtual and aggregate devices stay selectable and are flagged', () => {
    const harness = createHarness();
    const devices = harness.normalizeEnumeratedMediaDevices([
        { kind: 'audioinput', deviceId: 'blackhole', groupId: 'g1', label: 'BlackHole 2ch' },
        { kind: 'audioinput', deviceId: 'mic-1', groupId: 'g2', label: 'USB Microphone' }
    ]);

    assert.deepEqual(devices.audioInput.map((device) => device.deviceId), ['blackhole', 'mic-1']);
    assert.equal(devices.audioInput[0].virtual, true);
    assert.equal(devices.audioInput[1].virtual, false);
});

test('a selected virtual microphone raises a routing warning', () => {
    const harness = createHarness();
    harness.mediaDevices = {
        audioInput: [{ kind: 'audioinput', deviceId: 'blackhole', label: 'BlackHole 2ch', virtual: true }],
        audioOutput: []
    };
    const warnings = harness.getStaticMediaDeviceWarnings({
        audioInputDeviceId: 'blackhole',
        audioOutputDeviceId: '',
        microphoneGain: 0.8,
        outputVolume: 0.8,
        voiceProcessingMode: 'auto'
    });
    assert.ok(warnings.some((warning) => /virtual or aggregate/i.test(warning)));
});

test('media setting normalization treats saved default device ids as browser default selection', () => {
    const harness = createHarness();
    const settings = harness.normalizeMediaSettings({
        audioInputDeviceId: 'default',
        videoInputDeviceId: 'camera-1',
        audioOutputDeviceId: 'communications'
    });

    assert.equal(settings.audioInputDeviceId, '');
    assert.equal(settings.videoInputDeviceId, 'camera-1');
    assert.equal(settings.audioOutputDeviceId, '');
});

test('media setting normalization persists only supported speech recognition languages', () => {
    const harness = createHarness();

    assert.equal(
        harness.normalizeMediaSettings({ speechRecognitionLanguage: 'ro-RO' }).speechRecognitionLanguage,
        'ro-RO'
    );
    assert.equal(
        harness.normalizeMediaSettings({ speechRecognitionLanguage: 'invalid' }).speechRecognitionLanguage,
        'auto'
    );
    assert.equal(
        harness.normalizeMediaSettings({}).speechRecognitionLanguage,
        'auto'
    );
});

test('speech recognition language round-trips through the existing media settings storage', () => {
    const harness = createHarness();
    const values = new Map();
    const previousWindow = globalThis.window;
    globalThis.window = {
        localStorage: {
            getItem: (key) => values.get(key) || null,
            setItem: (key, value) => values.set(key, value)
        }
    };
    try {
        harness.state = {
            mediaSettings: harness.normalizeMediaSettings({ speechRecognitionLanguage: 'ro-RO' })
        };
        harness.persistMediaSettings();

        assert.equal(harness.loadMediaSettings().speechRecognitionLanguage, 'ro-RO');
        values.set('webmeet.mediaSettings', JSON.stringify({ speechRecognitionLanguage: 'unsupported' }));
        assert.equal(harness.loadMediaSettings().speechRecognitionLanguage, 'auto');
    } finally {
        if (previousWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = previousWindow;
        }
    }
});

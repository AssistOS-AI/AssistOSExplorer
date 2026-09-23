import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AUDIO_PUBLISH_DEFAULTS,
    WebMeetRoomLiveKit
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-livekit.js';

test('audio publish defaults favor voice clarity and packet-loss resilience', () => {
    assert.equal(AUDIO_PUBLISH_DEFAULTS.audioPreset.maxBitrate, 32000);
    assert.equal(AUDIO_PUBLISH_DEFAULTS.dtx, true);
    assert.equal(AUDIO_PUBLISH_DEFAULTS.red, true);
    assert.equal(AUDIO_PUBLISH_DEFAULTS.forceStereo, false);
    assert.equal(AUDIO_PUBLISH_DEFAULTS.stopMicTrackOnMute, true);
});

test('room publish defaults merge audio settings without mutating the shared preset', () => {
    const manager = new WebMeetRoomLiveKit({});
    const defaults = manager.getPublishDefaults();
    assert.equal(defaults.dtx, true);
    assert.equal(defaults.red, true);
    assert.equal(defaults.forceStereo, false);
    assert.equal(defaults.stopMicTrackOnMute, true);
    assert.ok(defaults.videoEncoding);
    assert.notEqual(defaults.audioPreset, AUDIO_PUBLISH_DEFAULTS.audioPreset);

    const audio = manager.getAudioPublishDefaults();
    audio.audioPreset.maxBitrate = 1;
    assert.equal(AUDIO_PUBLISH_DEFAULTS.audioPreset.maxBitrate, 32000);
});

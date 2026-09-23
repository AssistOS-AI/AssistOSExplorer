import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    summarizeAudioMetrics,
    summarizeAudioSettings,
    summarizeAudioWebRtcStats,
    summarizeIceTransport
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/media-diagnostics.js';

test('audio diagnostics expose only rounded aggregate metrics', () => {
    assert.deepEqual(summarizeAudioMetrics({
        rmsDb: -18.123,
        peakDb: -3.456,
        noiseFloorDb: -55.678,
        clipping: false,
        speaking: true,
        humFrequency: '50',
        adaptiveGain: 1.234,
        mode: 'auto',
        health: 'Good',
        samples: [0.1, 0.2]
    }), {
        rmsDb: -18.1,
        peakDb: -3.5,
        noiseFloorDb: -55.7,
        clipping: false,
        speaking: true,
        humFrequency: '50',
        adaptiveGain: 1.23,
        mode: 'auto',
        health: 'Good'
    });
});

test('audio WebRTC diagnostics summarize jitter, loss, concealment, and RTT', () => {
    assert.deepEqual(summarizeAudioWebRtcStats([
        { type: 'inbound-rtp', kind: 'audio', jitter: 0.01234, packetsLost: 3, concealedSamples: 120 },
        { type: 'outbound-rtp', kind: 'audio' },
        { type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.0876 },
        { type: 'inbound-rtp', kind: 'video', jitter: 1, packetsLost: 999 }
    ]), {
        inboundAudioStreams: 1,
        outboundAudioStreams: 1,
        jitterMs: 12.3,
        packetsLost: 3,
        concealedSamples: 120,
        roundTripTimeMs: 87.6
    });
});

test('audio WebRTC diagnostics accept RTCStatsReport map entries', () => {
    const reports = new Map([
        ['inbound-audio', { type: 'inbound-rtp', kind: 'audio', packetsLost: 2, concealedSamples: 4 }]
    ]);
    assert.equal(summarizeAudioWebRtcStats(reports).packetsLost, 2);
});

test('audio settings diagnostics summarize the effective capture profile', () => {
    assert.deepEqual(summarizeAudioSettings({
        profile: 'advanced',
        voiceProcessingMode: 'auto',
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        voiceIsolation: false,
        microphoneGain: 0.8,
        outputVolume: 0.8
    }), {
        profile: 'advanced',
        voiceProcessingMode: 'auto',
        humFilter: '',
        microphoneGain: 0.8,
        outputVolume: 0.8,
        automaticParticipantVolume: true,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        voiceIsolation: false
    });
});

test('ICE transport diagnostics distinguish direct and relay media paths', () => {
    const direct = summarizeIceTransport([
        { id: 'transport', type: 'transport', iceState: 'connected', dtlsState: 'connected' },
        { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' },
        { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
        { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }
    ]);
    assert.equal(direct.selected, 'direct');
    assert.equal(direct.relay, false);
    assert.equal(direct.localCandidateType, 'host');
    assert.equal(direct.iceState, 'connected');

    const relay = summarizeIceTransport([
        { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' },
        { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
        { id: 'remote', type: 'remote-candidate', candidateType: 'relay', protocol: 'udp' }
    ]);
    assert.equal(relay.selected, 'relay');
    assert.equal(relay.relay, true);

    assert.equal(summarizeIceTransport([]).selected, 'unknown');
});

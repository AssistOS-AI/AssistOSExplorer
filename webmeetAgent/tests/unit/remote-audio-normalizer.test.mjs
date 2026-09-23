import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RemoteAudioNormalizer } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/remote-audio-normalizer.js';

test('remote audio normalization adjusts quiet playback, respects manual overrides, and cleans up', async () => {
    const originalAudioContext = globalThis.AudioContext;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const changes = [];
    let closed = false;
    let disconnected = 0;

    class FakeAudioContext {
        constructor() {
            this.state = 'running';
        }

        createMediaStreamSource() {
            return {
                connect() {},
                disconnect() { disconnected += 1; }
            };
        }

        createAnalyser() {
            return {
                fftSize: 0,
                smoothingTimeConstant: 0,
                getFloatTimeDomainData(data) { data.fill(0.03); },
                disconnect() { disconnected += 1; }
            };
        }

        close() {
            closed = true;
            return Promise.resolve();
        }
    }

    let manualOverride = false;
    globalThis.AudioContext = FakeAudioContext;
    globalThis.setInterval = () => 42;
    globalThis.clearInterval = () => {};
    try {
        const normalizer = new RemoteAudioNormalizer({
            isEnabled: () => true,
            hasManualOverride: () => manualOverride,
            onMultiplierChange: (_element, multiplier, participantId) => changes.push({ multiplier, participantId })
        });
        const mediaElement = {
            isConnected: true,
            srcObject: { getAudioTracks: () => [{}] }
        };

        normalizer.start(mediaElement, 'participant-1');
        const entry = normalizer.entries.get(mediaElement);
        assert.ok(entry);

        normalizer.updateEntry(entry);
        assert.ok(normalizer.getMultiplier(mediaElement) > 1);
        assert.equal(changes.at(-1).participantId, 'participant-1');

        manualOverride = true;
        normalizer.refreshParticipant('participant-1');
        assert.equal(normalizer.getMultiplier(mediaElement), 1);

        normalizer.stop(mediaElement);
        await Promise.resolve();
        assert.equal(normalizer.entries.size, 0);
        assert.equal(closed, false, 'stopping one participant keeps the shared audio context');
        assert.equal(disconnected, 2);

        normalizer.stopAll();
        await Promise.resolve();
        assert.equal(closed, true, 'stopping all participants releases the shared audio context');
    } finally {
        globalThis.AudioContext = originalAudioContext;
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

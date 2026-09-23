import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MicrophoneCaptureSession } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/microphone-capture-session.js';

test('capture session publishes, stops, and releases the processed capture', async () => {
    let cleaned = 0;
    let unpublished = null;
    const capture = {
        track: { id: 'track-1' },
        cleanup: async () => { cleaned += 1; }
    };
    const session = new MicrophoneCaptureSession({
        createCapture: async () => capture
    });

    const result = await session.start({ voiceProcessingMode: 'auto' });
    assert.equal(result, capture);
    assert.equal(session.state, 'captured');
    assert.equal(session.activeCapture, capture);
    assert.equal(session.markPublished(), true);
    assert.equal(session.state, 'published');

    await session.stop(async (stoppedCapture) => {
        unpublished = stoppedCapture;
    });

    assert.equal(unpublished, capture);
    assert.equal(cleaned, 1);
    assert.equal(session.activeCapture, null);
    assert.equal(session.state, 'stopped');
});

test('a start that finishes after a stop cannot publish or leak its capture', async () => {
    let resolveCapture = () => {};
    const pending = new Promise((resolve) => { resolveCapture = resolve; });
    let cleaned = 0;
    const session = new MicrophoneCaptureSession({
        createCapture: () => pending
    });

    const startPromise = session.start({});
    const stopPromise = session.stop();
    resolveCapture({ track: { id: 'late' }, cleanup: async () => { cleaned += 1; } });

    assert.equal(await startPromise, null);
    await stopPromise;
    assert.equal(cleaned, 1);
    assert.equal(session.activeCapture, null);
    assert.equal(session.state, 'stopped');
    assert.equal(session.isActive(), false);
});

test('starting a new capture supersedes a pending one and reports start failures', async () => {
    let created = 0;
    const session = new MicrophoneCaptureSession({
        createCapture: async () => {
            created += 1;
            return { track: { id: `track-${created}` }, cleanup: async () => {} };
        }
    });
    await session.start({});
    await session.start({});
    assert.equal(created, 2);
    assert.equal(session.activeCapture.track.id, 'track-2');

    const failing = new MicrophoneCaptureSession({
        createCapture: async () => { throw new Error('capture failed'); }
    });
    await assert.rejects(() => failing.start({}), /capture failed/);
    assert.equal(failing.state, 'error');
});

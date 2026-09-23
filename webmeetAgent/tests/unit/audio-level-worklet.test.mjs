import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const audioDir = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing'
);

test('audio level analysis runs in an AudioWorklet with a main-thread fallback', async () => {
    const workletSource = await fs.readFile(path.join(audioDir, 'audio-level-worklet.js'), 'utf8');
    const analyzerSource = await fs.readFile(path.join(audioDir, 'audio-level-analyzer.js'), 'utf8');
    const factorySource = await fs.readFile(path.join(audioDir, 'microphone-track-factory.js'), 'utf8');

    assert.match(workletSource, /class WebmeetAudioLevelProcessor extends AudioWorkletProcessor/);
    assert.match(workletSource, /registerProcessor\('webmeet-audio-level-processor'/);
    assert.match(workletSource, /this\.port\.postMessage\(\{ type: 'metrics', metrics \}\)/);
    assert.match(workletSource, /humFrequency: 'off'/);

    assert.match(analyzerSource, /export async function createAudioLevelWorkletMonitor/);
    assert.match(analyzerSource, /new URL\('\.\/audio-level-worklet\.js', import\.meta\.url\)/);

    assert.match(factorySource, /createAudioLevelWorkletMonitor/);
    assert.match(factorySource, /\.catch\(\(\) => null\)/);
    assert.ok(
        factorySource.indexOf('createAudioLevelWorkletMonitor(audioContext, sourceNode') < factorySource.indexOf('createAudioLevelMonitor(audioContext, sourceNode'),
        'the worklet monitor is attempted before the analyser fallback'
    );
});

import {
    normalizeHumFilter,
    normalizeMicrophoneGain,
    normalizeVoiceProcessingMode
} from './settings.js';
import {
    buildMicrophoneAudioConstraints,
    getAudioContextConstructor,
    isAdvancedVoiceProcessingSupported,
    resolveMicrophoneProfile
} from './capture-constraints.js';
import {
    createAudioLevelMonitor,
    createAudioLevelWorkletMonitor
} from './audio-level-analyzer.js';

const WORKLET_MODULE_URL = new URL('./rnnoise-worklet.js', import.meta.url).href;
let workletPreloadPromise = null;

function getAudioContextCtor() {
    return getAudioContextConstructor();
}

export function isEnhancedVoiceProcessingSupported() {
    return isAdvancedVoiceProcessingSupported();
}

function connectIfPresent(sourceNode, targetNode) {
    if (!sourceNode || !targetNode) return targetNode || sourceNode;
    sourceNode.connect(targetNode);
    return targetNode;
}

function createBiquad(audioContext, type, frequency, q = null) {
    const node = audioContext.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    if (q !== null) {
        node.Q.value = q;
    }
    return node;
}

export async function preloadVoiceProcessingWorklet() {
    if (workletPreloadPromise) return workletPreloadPromise;
    const AudioContextRef = getAudioContextCtor();
    if (!AudioContextRef) {
        return Promise.resolve(false);
    }
    workletPreloadPromise = (async () => {
        const audioContext = new AudioContextRef({ sampleRate: 48000 });
        try {
            await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);
            return true;
        } finally {
            try { await audioContext.close?.(); } catch (_) {}
        }
    })().catch((error) => {
        workletPreloadPromise = null;
        throw error;
    });
    return workletPreloadPromise;
}

async function createRnnoiseNode(audioContext) {
    await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);
    const node = new AudioWorkletNode(audioContext, 'webmeet-rnnoise-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
    });
    try {
        await waitForWorkletReady(node);
    } catch (error) {
        disposeWorkletNode(node);
        throw error;
    }
    return node;
}

function disposeWorkletNode(node) {
    try { node?.port?.postMessage?.({ type: 'dispose' }); } catch (_) {}
    try { node?.disconnect?.(); } catch (_) {}
}

function waitForWorkletReady(node, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            node.port.onmessage = null;
            disposeWorkletNode(node);
            reject(new Error('RNNoise voice processing did not initialize in time.'));
        }, timeoutMs);
        node.port.onmessage = (event) => {
            if (settled) return;
            if (event.data?.type === 'ready') {
                settled = true;
                clearTimeout(timeout);
                node.port.onmessage = null;
                resolve();
                return;
            }
            if (event.data?.type === 'error') {
                settled = true;
                clearTimeout(timeout);
                node.port.onmessage = null;
                disposeWorkletNode(node);
                reject(new Error(event.data.message || 'RNNoise voice processing failed to initialize.'));
            }
        };
    });
}

export async function createProcessedMicrophoneTrack(settings = {}) {
    const browserNavigator = globalThis.navigator;
    if (!browserNavigator?.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not supported in this browser.');
    }
    const AudioContextRef = getAudioContextCtor();
    if (!AudioContextRef) {
        throw new Error('Audio processing is not supported in this browser.');
    }

    const mode = normalizeVoiceProcessingMode(settings.voiceProcessingMode);
    const profile = resolveMicrophoneProfile(settings);
    const enhanced = profile === 'advanced';
    const humFilter = normalizeHumFilter(settings.humFilter);
    const configuredGain = normalizeMicrophoneGain(settings.microphoneGain);

    const sourceStream = await browserNavigator.mediaDevices.getUserMedia({
        audio: buildMicrophoneAudioConstraints(settings, { profile }),
        video: false
    });
    const audioContext = new AudioContextRef({ sampleRate: 48000 });
    if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch (_) {}
    }

    const nodes = [];
    let rnnoiseNode = null;
    let levelMonitor = null;
    let processedTrack = null;
    let destination = null;
    try {
        const sourceNode = audioContext.createMediaStreamSource(sourceStream);
        nodes.push(sourceNode);
        let currentNode = sourceNode;

        if (enhanced) {
            const highPassNode = createBiquad(audioContext, 'highpass', 90, 0.707);
            nodes.push(highPassNode);
            currentNode = connectIfPresent(currentNode, highPassNode);

            rnnoiseNode = await createRnnoiseNode(audioContext);
            nodes.push(rnnoiseNode);
            currentNode = connectIfPresent(currentNode, rnnoiseNode);
        }

        if (humFilter === '50' || humFilter === '60') {
            const humFrequency = humFilter === '60' ? 60 : 50;
            const humNode = createBiquad(audioContext, 'notch', humFrequency, 18);
            nodes.push(humNode);
            currentNode = connectIfPresent(currentNode, humNode);
        }

        const gainNode = audioContext.createGain();
        gainNode.gain.value = configuredGain;
        nodes.push(gainNode);
        currentNode = connectIfPresent(currentNode, gainNode);

        const handleMetrics = (metrics) => {
            settings.onMetrics?.({
                ...metrics,
                adaptiveGain: 1,
                gateGain: 1,
                profile,
                mode
            });
        };
        levelMonitor = await createAudioLevelWorkletMonitor(audioContext, sourceNode, {
            onMetrics: handleMetrics
        }).catch(() => null);
        if (!levelMonitor) {
            levelMonitor = createAudioLevelMonitor(audioContext, sourceNode, {
                onMetrics: handleMetrics
            });
        }

        destination = audioContext.createMediaStreamDestination();
        currentNode.connect(destination);
        [processedTrack] = destination.stream.getAudioTracks();
        if (!processedTrack) {
            throw new Error('Processed microphone track could not be created.');
        }
        processedTrack.contentHint = 'speech';

        const cleanup = async () => {
            for (const track of [
                processedTrack,
                ...(destination?.stream?.getTracks?.() || []),
                ...(sourceStream?.getTracks?.() || [])
            ]) {
                try { track?.stop?.(); } catch (_) {}
            }
            for (const node of nodes) {
                try { node?.disconnect?.(); } catch (_) {}
            }
            levelMonitor?.stop?.();
            try { await audioContext?.close?.(); } catch (_) {}
        };

        return {
            track: processedTrack,
            sourceStream,
            processedStream: destination.stream,
            audioContext,
            cleanup,
            status: {
                mode,
                profile,
                rnnoise: Boolean(rnnoiseNode),
                adaptiveGain: false
            },
            getMetrics: () => levelMonitor?.getMetrics?.() || null
        };
    } catch (error) {
        for (const track of [
            processedTrack,
            ...(destination?.stream?.getTracks?.() || []),
            ...(sourceStream?.getTracks?.() || [])
        ]) {
            try { track?.stop?.(); } catch (_) {}
        }
        for (const node of nodes) {
            try { node?.disconnect?.(); } catch (_) {}
        }
        levelMonitor?.stop?.();
        try { await audioContext?.close?.(); } catch (_) {}
        throw error;
    }
}

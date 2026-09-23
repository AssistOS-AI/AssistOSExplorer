const MIN_DB = -96;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function linearToDb(value) {
    const normalized = Math.max(0.000001, Number(value) || 0);
    return Math.max(MIN_DB, 20 * Math.log10(normalized));
}

export function analyzeTimeDomainSamples(samples) {
    if (!samples?.length) {
        return { rms: 0, rmsDb: MIN_DB, peak: 0, peakDb: MIN_DB, clipping: false };
    }
    let sumSquares = 0;
    let peak = 0;
    let clippedSamples = 0;
    for (const sample of samples) {
        const value = Math.abs(Number(sample) || 0);
        sumSquares += value * value;
        peak = Math.max(peak, value);
        if (value >= 0.98) clippedSamples += 1;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    return {
        rms,
        rmsDb: linearToDb(rms),
        peak,
        peakDb: linearToDb(peak),
        clipping: clippedSamples / samples.length >= 0.002
    };
}

function getFrequencyMagnitude(frequencyData, sampleRate, frequency) {
    if (!frequencyData?.length || !sampleRate) return 0;
    const binFrequency = (sampleRate / 2) / frequencyData.length;
    const center = Math.round(frequency / binFrequency);
    let magnitude = -Infinity;
    const value = Number(frequencyData[Math.min(frequencyData.length - 1, Math.max(0, center))]);
    if (Number.isFinite(value)) magnitude = value;
    return Number.isFinite(magnitude) ? magnitude : MIN_DB;
}

export function detectHumFrequency(frequencyData, sampleRate) {
    if (!frequencyData?.length || !sampleRate) return 'off';
    const baselineFrequencies = [30, 35, 75, 80, 85, 90];
    const magnitudes = baselineFrequencies.map((frequency) => (
        getFrequencyMagnitude(frequencyData, sampleRate, frequency)
    ));
    const average = magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;
    const at50 = getFrequencyMagnitude(frequencyData, sampleRate, 50);
    const at60 = getFrequencyMagnitude(frequencyData, sampleRate, 60);
    const strongest = Math.max(at50, at60);
    if (strongest < average + 18 || strongest < -75) return 'off';
    return at60 > at50 ? '60' : '50';
}

export function classifyAudioHealth(metrics = {}) {
    if (metrics.networkUnstable) return 'Network unstable';
    if (metrics.clipping) return 'Clipping';
    if (Number(metrics.noiseFloorDb) > -42) return 'Noisy';
    if (metrics.speaking && Number(metrics.rmsDb) < -30) return 'Quiet';
    return 'Good';
}

export class AdaptiveGainController {
    constructor(options = {}) {
        this.targetDb = Number.isFinite(options.targetDb) ? options.targetDb : -18;
        this.minGain = Number.isFinite(options.minGain) ? options.minGain : 0.7;
        this.maxGain = Number.isFinite(options.maxGain) ? options.maxGain : 1.5;
        this.gain = 1;
        this.speakingFrames = 0;
    }

    update(metrics = {}) {
        if (metrics.clipping) {
            this.speakingFrames = 0;
            this.gain = clamp(this.gain * 0.78, this.minGain, this.maxGain);
            return this.gain;
        }
        if (!metrics.speaking) {
            this.speakingFrames = 0;
            return this.gain;
        }
        this.speakingFrames += 1;
        const errorDb = this.targetDb - Number(metrics.rmsDb || MIN_DB);
        if (Math.abs(errorDb) < 3) return this.gain;
        const desiredGain = clamp(10 ** (errorDb / 20), this.minGain, this.maxGain);
        const warmup = this.speakingFrames <= 12;
        const amount = desiredGain < this.gain
            ? (warmup ? 0.55 : 0.35)
            : (warmup ? 0.18 : 0.06);
        this.gain = clamp(this.gain + ((desiredGain - this.gain) * amount), this.minGain, this.maxGain);
        return this.gain;
    }
}

const AUDIO_LEVEL_WORKLET_URL = new URL('./audio-level-worklet.js', import.meta.url).href;

export async function createAudioLevelWorkletMonitor(audioContext, sourceNode, options = {}) {
    if (!globalThis.AudioWorkletNode || typeof audioContext?.audioWorklet?.addModule !== 'function') {
        throw new Error('Audio worklet analysis is not supported.');
    }
    await audioContext.audioWorklet.addModule(AUDIO_LEVEL_WORKLET_URL);
    const node = new globalThis.AudioWorkletNode(audioContext, 'webmeet-audio-level-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: {
            intervalMs: Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 200
        }
    });
    let latest = null;
    node.port.onmessage = (event) => {
        if (event.data?.type !== 'metrics' || !event.data.metrics) return;
        latest = event.data.metrics;
        options.onMetrics?.({ ...latest });
    };
    sourceNode.connect(node);
    return {
        node,
        getMetrics: () => (latest ? { ...latest } : null),
        stop() {
            try { node.port.onmessage = null; } catch (_) {}
            try { node.port.postMessage({ type: 'dispose' }); } catch (_) {}
            try { sourceNode.disconnect(node); } catch (_) {}
            try { node.disconnect(); } catch (_) {}
        }
    };
}

export function createAudioLevelMonitor(audioContext, sourceNode, options = {}) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.8;
    sourceNode.connect(analyser);
    const timeData = new Float32Array(analyser.fftSize);
    const frequencyData = new Float32Array(analyser.frequencyBinCount);
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 250;
    let noiseFloorDb = -60;
    let humCandidate = 'off';
    let humCandidateCount = 0;
    let stableHum = 'off';
    let latest = {
        rms: 0,
        rmsDb: MIN_DB,
        peak: 0,
        peakDb: MIN_DB,
        clipping: false,
        noiseFloorDb,
        speaking: false,
        humFrequency: stableHum,
        health: 'Good'
    };

    const sample = () => {
        analyser.getFloatTimeDomainData(timeData);
        analyser.getFloatFrequencyData(frequencyData);
        const levels = analyzeTimeDomainSamples(timeData);
        const speaking = levels.rmsDb > Math.max(-45, noiseFloorDb + 9);
        if (!speaking) {
            noiseFloorDb = clamp((noiseFloorDb * 0.92) + (levels.rmsDb * 0.08), -80, -25);
        }
        const detectedHum = detectHumFrequency(frequencyData, audioContext.sampleRate);
        if (detectedHum === humCandidate) {
            humCandidateCount += 1;
        } else {
            humCandidate = detectedHum;
            humCandidateCount = 1;
        }
        if (humCandidateCount >= 8) {
            stableHum = humCandidate;
        }
        latest = {
            ...levels,
            noiseFloorDb,
            speaking,
            humFrequency: stableHum
        };
        latest.health = classifyAudioHealth(latest);
        options.onMetrics?.({ ...latest });
        return latest;
    };

    const timer = globalThis.setInterval(sample, intervalMs);
    return {
        analyser,
        getMetrics: () => ({ ...latest }),
        stop() {
            globalThis.clearInterval(timer);
            try { analyser.disconnect(); } catch (_) {}
        }
    };
}

const MIN_DB = -96;
const DEFAULT_INTERVAL_MS = 200;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function linearToDb(value) {
    const normalized = Math.max(0.000001, Number(value) || 0);
    return Math.max(MIN_DB, 20 * Math.log10(normalized));
}

function classifyHealth(metrics = {}) {
    if (metrics.clipping) return 'Clipping';
    if (Number(metrics.noiseFloorDb) > -42) return 'Noisy';
    if (metrics.speaking && Number(metrics.rmsDb) < -30) return 'Quiet';
    return 'Good';
}

class WebmeetAudioLevelProcessor extends AudioWorkletProcessor {
    constructor(options = {}) {
        super();
        const processorOptions = options.processorOptions || {};
        const intervalMs = Number.isFinite(Number(processorOptions.intervalMs))
            ? Math.max(50, Number(processorOptions.intervalMs))
            : DEFAULT_INTERVAL_MS;
        this.samplesPerInterval = Math.max(1, Math.round((intervalMs / 1000) * sampleRate));
        this.intervalSampleCount = 0;
        this.sumSquares = 0;
        this.peak = 0;
        this.clippedSamples = 0;
        this.noiseFloorDb = -60;
        this.disposed = false;
        this.port.onmessage = (event) => {
            if (event.data?.type === 'dispose') {
                this.disposed = true;
            }
        };
    }

    accumulate(input) {
        for (let i = 0; i < input.length; i += 1) {
            const value = Math.abs(input[i]);
            this.sumSquares += value * value;
            if (value > this.peak) this.peak = value;
            if (value >= 0.98) this.clippedSamples += 1;
            this.intervalSampleCount += 1;
        }
    }

    emitMetrics() {
        const count = Math.max(1, this.intervalSampleCount);
        const rms = Math.sqrt(this.sumSquares / count);
        const rmsDb = linearToDb(rms);
        const peakDb = linearToDb(this.peak);
        const clipping = (this.clippedSamples / count) >= 0.002;
        const speaking = rmsDb > Math.max(-45, this.noiseFloorDb + 9);
        if (!speaking) {
            this.noiseFloorDb = clamp((this.noiseFloorDb * 0.92) + (rmsDb * 0.08), -80, -25);
        }
        const metrics = {
            rms,
            rmsDb,
            peak: this.peak,
            peakDb,
            clipping,
            noiseFloorDb: this.noiseFloorDb,
            speaking,
            humFrequency: 'off'
        };
        metrics.health = classifyHealth(metrics);
        this.port.postMessage({ type: 'metrics', metrics });
        this.intervalSampleCount = 0;
        this.sumSquares = 0;
        this.peak = 0;
        this.clippedSamples = 0;
    }

    process(inputs) {
        if (this.disposed) return false;
        const input = inputs[0]?.[0] || null;
        if (input && input.length) {
            this.accumulate(input);
            if (this.intervalSampleCount >= this.samplesPerInterval) {
                this.emitMetrics();
            }
        }
        return true;
    }
}

registerProcessor('webmeet-audio-level-processor', WebmeetAudioLevelProcessor);

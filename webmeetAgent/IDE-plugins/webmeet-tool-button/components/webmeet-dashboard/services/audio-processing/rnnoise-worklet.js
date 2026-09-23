import createRNNWasmModuleSync from '../../../../vendor/rnnoise/rnnoise-sync.js';

const RNNOISE_PCM_SCALE = 32768;
const RNNOISE_FRAME_SIZE = 480;
const F32_BYTES = 4;
const RING_CAPACITY = RNNOISE_FRAME_SIZE * 2;

class FloatRingBuffer {
    constructor(capacity) {
        this.buffer = new Float32Array(capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.size = 0;
    }

    get available() {
        return this.size;
    }

    get free() {
        return this.buffer.length - this.size;
    }

    push(value) {
        if (this.free <= 0) return false;
        this.buffer[this.writeIndex] = value;
        this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
        this.size += 1;
        return true;
    }

    shift() {
        if (this.size <= 0) return 0;
        const value = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
        this.size -= 1;
        return value;
    }

    clear() {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.size = 0;
    }
}

function clampSample(value) {
    return Math.max(-1, Math.min(1, value));
}

class RnnoiseProcessor extends AudioWorkletProcessor {
    constructor(options = {}) {
        super();
        this.frameSize = RNNOISE_FRAME_SIZE;
        this.inputRing = new FloatRingBuffer(RING_CAPACITY);
        this.outputRing = new FloatRingBuffer(RING_CAPACITY);
        this.frameScratch = new Float32Array(this.frameSize);
        this.rnnoiseModule = null;
        this.denoiseState = 0;
        this.inputPtr = 0;
        this.outputPtr = 0;
        this.ready = false;
        this.failed = false;
        this.disposed = false;
        this.port.onmessage = (event) => {
            if (event.data?.type === 'dispose') {
                this.dispose();
            }
        };
        this.init();
    }

    init() {
        try {
            const rnnoiseModule = createRNNWasmModuleSync();
            if (this.disposed) return;
            rnnoiseModule._rnnoise_init?.();
            const denoiseState = rnnoiseModule._rnnoise_create();
            const inputPtr = rnnoiseModule._malloc(this.frameSize * F32_BYTES);
            const outputPtr = rnnoiseModule._malloc(this.frameSize * F32_BYTES);
            if (!denoiseState || !inputPtr || !outputPtr) {
                throw new Error('Failed to allocate RNNoise worklet state.');
            }
            this.rnnoiseModule = rnnoiseModule;
            this.denoiseState = denoiseState;
            this.inputPtr = inputPtr;
            this.outputPtr = outputPtr;
            this.ready = true;
            this.port.postMessage({ type: 'ready' });
        } catch (error) {
            if (this.disposed) return;
            this.failed = true;
            this.port.postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    dispose() {
        this.disposed = true;
        this.ready = false;
        this.failed = true;
        this.inputRing.clear();
        this.outputRing.clear();
        try {
            if (this.rnnoiseModule && this.denoiseState) {
                this.rnnoiseModule._rnnoise_destroy(this.denoiseState);
            }
        } catch (_) {}
        try {
            if (this.rnnoiseModule && this.inputPtr) {
                this.rnnoiseModule._free(this.inputPtr);
            }
        } catch (_) {}
        try {
            if (this.rnnoiseModule && this.outputPtr) {
                this.rnnoiseModule._free(this.outputPtr);
            }
        } catch (_) {}
        this.rnnoiseModule = null;
        this.denoiseState = 0;
        this.inputPtr = 0;
        this.outputPtr = 0;
    }

    process(inputs, outputs) {
        if (this.disposed) return false;
        const input = inputs[0]?.[0] || null;
        const output = outputs[0]?.[0] || null;
        if (!output) return true;
        if (!input || this.failed || !this.ready || !this.rnnoiseModule || !this.denoiseState) {
            if (input) output.set(input);
            return true;
        }

        for (let i = 0; i < input.length; i += 1) {
            if (!this.inputRing.push(clampSample(input[i]))) break;
        }

        const inputIndex = this.inputPtr / F32_BYTES;
        const outputIndex = this.outputPtr / F32_BYTES;
        while (this.inputRing.available >= this.frameSize) {
            for (let i = 0; i < this.frameSize; i += 1) {
                this.frameScratch[i] = this.inputRing.shift() * RNNOISE_PCM_SCALE;
            }
            this.rnnoiseModule.HEAPF32.set(this.frameScratch, inputIndex);
            this.rnnoiseModule._rnnoise_process_frame(this.denoiseState, this.outputPtr, this.inputPtr);
            const denoised = this.rnnoiseModule.HEAPF32.subarray(outputIndex, outputIndex + this.frameSize);
            for (let i = 0; i < this.frameSize; i += 1) {
                if (!this.outputRing.push(clampSample(denoised[i] / RNNOISE_PCM_SCALE))) break;
            }
        }

        for (let i = 0; i < output.length; i += 1) {
            output[i] = this.outputRing.available > 0 ? this.outputRing.shift() : 0;
        }
        return true;
    }
}

registerProcessor('webmeet-rnnoise-processor', RnnoiseProcessor);

// The supervisor's reader for one orchestration domain's control stream (plan section 5.5). The domain's stdin, stdout
// and stderr were created by the supervisor; this module reads them with its own parser, never Node's IPC parser, and
// never asks for ancillary data. What the kernel then does with descriptors that a domain attaches to its writes
// (SCM_RIGHTS) is a property of the kernel, not of this reader: Linux discards them on a plain read(); the Darwin host
// used for the deterministic tests INSTALLS them into the reader's descriptor table (observed, see
// controlStreamReader.test.mjs). The Linux behaviour is an inference until G1 measures it in the Box; a design that
// cannot rely on it must not give the domain a socket (use pipe(2) pairs for the control streams).
//
// Bounds, all per execution and none shared (limits are constructor parameters; the values are PROVISIONAL, G5 sets them):
//   maxRecordBytes      a stdout record is at most this long, excluding its newline. Bytes past it are never retained:
//                       the execution ends with control_stream_violation.
//   malformed record    JSON that does not parse, is not an object, or fails validateRecord ends the execution with
//                       control_stream_violation.
//   maxBufferedBytes    records parsed but not yet persisted or delivered (onRecord's promise has not settled). At the
//                       budget the stream is paused, so the domain's writes block on a full pipe.
//   maxRecordsPerWindow within rateWindowMs. Past it the stream is paused until the window ends.
//   stallDeadlineMs     a pause that lasts this long ends the execution (control_stall).
//   stderrRingBytes     stderr is kept as a ring of the most recent bytes and is drained without parsing.
//   stdin               writes respect backpressure. A write blocked for stdinStallDeadlineMs ends the execution
//                       (stdin_stall); more than maxPendingStdinBytes queued ends it (stdin_overflow).
//
// onEnd(reason, detail) is called once. After it nothing is read or written, and the three streams are destroyed.

export class ByteRing {
    #buffer;
    #size;
    #filled = 0;
    #offset = 0;
    constructor(size) { this.#size = size; this.#buffer = Buffer.alloc(size); }
    write(chunk) {
        // Only the last `size` bytes of a chunk can matter.
        const tail = chunk.length > this.#size ? chunk.subarray(chunk.length - this.#size) : chunk;
        const first = Math.min(tail.length, this.#size - this.#offset);
        tail.copy(this.#buffer, this.#offset, 0, first);
        if (first < tail.length) tail.copy(this.#buffer, 0, first);
        this.#offset = (this.#offset + tail.length) % this.#size;
        this.#filled = Math.min(this.#size, this.#filled + tail.length);
    }
    contents() {
        if (this.#filled < this.#size) return Buffer.from(this.#buffer.subarray(0, this.#filled));
        return Buffer.concat([this.#buffer.subarray(this.#offset), this.#buffer.subarray(0, this.#offset)]);
    }
    get length() { return this.#filled; }
}

const NEWLINE = 0x0a;

export function createControlStreamReader({
    stdout, stderr, stdin, limits, validateRecord = () => null, onRecord, onEnd, timers = { setTimeout, clearTimeout, now: () => Date.now() }
}) {
    const ring = new ByteRing(limits.stderrRingBytes);
    const pauseReasons = new Set();
    const queue = [];
    let retained = [];
    let retainedBytes = 0;
    let pendingBytes = 0;
    let ended = false;
    let stallTimer = null;
    let rateTimer = null;
    let stdinTimer = null;
    let windowStart = timers.now();
    let windowCount = 0;
    let records = 0;
    let stderrBytes = 0;
    let peakRetained = 0;
    let peakPending = 0;
    let pauseCount = 0;

    function finish(reason, detail) {
        if (ended) return;
        ended = true;
        for (const timer of [stallTimer, rateTimer, stdinTimer]) if (timer !== null) timers.clearTimeout(timer);
        queue.length = 0;
        retained = [];
        for (const stream of [stdout, stderr, stdin]) { try { stream?.destroy(); } catch { /* already closed */ } }
        try { onEnd(reason, detail); } catch { /* the caller must not break the reader */ }
    }
    const violation = (code) => finish('control_stream_violation', code);

    function updatePause() {
        if (ended) return;
        if (pauseReasons.size > 0) {
            if (!stdout.isPaused()) { stdout.pause(); pauseCount += 1; }
            if (stallTimer === null) {
                stallTimer = timers.setTimeout(() => finish('control_stall', [...pauseReasons].sort().join('+')), limits.stallDeadlineMs);
                stallTimer.unref?.();
            }
        } else {
            if (stallTimer !== null) { timers.clearTimeout(stallTimer); stallTimer = null; }
            if (stdout.isPaused()) stdout.resume();
            drain();
        }
    }
    const setPause = (reason, on) => {
        const had = pauseReasons.has(reason);
        if (on) pauseReasons.add(reason); else pauseReasons.delete(reason);
        if (had !== on) updatePause();
    };

    function deliver(bytes) {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(bytes.parts, bytes.length).toString('utf8')); } catch { violation('malformed_record'); return; }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { violation('malformed_record'); return; }
        const problem = validateRecord(parsed);
        if (problem) { violation('invalid_record'); return; }
        records += 1;
        const now = timers.now();
        if (now - windowStart >= limits.rateWindowMs) { windowStart = now; windowCount = 0; }
        windowCount += 1;
        const size = bytes.length;
        pendingBytes += size;
        peakPending = Math.max(peakPending, pendingBytes);
        Promise.resolve().then(() => onRecord(parsed, size)).catch(() => {}).finally(() => {
            pendingBytes -= size;
            if (pendingBytes < limits.maxBufferedBytes) setPause('buffer', false);
        });
        if (pendingBytes >= limits.maxBufferedBytes) setPause('buffer', true);
        if (windowCount >= limits.maxRecordsPerWindow && rateTimer === null) {
            setPause('rate', true);
            rateTimer = timers.setTimeout(() => {
                rateTimer = null;
                windowStart = timers.now();
                windowCount = 0;
                setPause('rate', false);
            }, Math.max(1, windowStart + limits.rateWindowMs - now));
            rateTimer.unref?.();
        }
    }

    let eof = false;
    function settleEof() {
        if (eof && !ended && queue.length === 0 && pauseReasons.size === 0 && !draining) {
            finish('stdout_ended', retainedBytes > 0 ? 'partial_record' : 'clean');
        }
    }

    // Processes queued chunks until the stream is paused. At most one read chunk and one record are ever retained.
    let draining = false;
    function drain() {
        if (draining) return;
        draining = true;
        try {
            while (!ended && pauseReasons.size === 0 && queue.length > 0) {
                const chunk = queue.shift();
                let offset = 0;
                while (offset < chunk.length && !ended) {
                    if (pauseReasons.size > 0) { queue.unshift(chunk.subarray(offset)); return; }
                    const newline = chunk.indexOf(NEWLINE, offset);
                    const end = newline < 0 ? chunk.length : newline;
                    const part = end - offset;
                    if (retainedBytes + part > limits.maxRecordBytes) { violation('record_too_large'); return; }
                    if (part > 0) { retained.push(Buffer.from(chunk.subarray(offset, end))); retainedBytes += part; }
                    peakRetained = Math.max(peakRetained, retainedBytes);
                    if (newline < 0) { offset = chunk.length; break; }
                    const bytes = { parts: retained, length: retainedBytes };
                    retained = [];
                    retainedBytes = 0;
                    offset = newline + 1;
                    deliver(bytes);
                }
            }
        } finally { draining = false; }
        settleEof();
    }

    stdout.on('data', (chunk) => {
        if (ended) return;
        queue.push(chunk);
        drain();
    });
    // End-of-stream is acted on only once every queued chunk has been processed: a paused reader still owes the records
    // that arrived before the end.
    const onEof = () => {
        eof = true;
        drain();
        settleEof();
    };
    stdout.on('end', onEof);
    stdout.on('close', onEof);
    stdout.on('error', () => finish('stdout_error'));

    // stderr is drained, never parsed and never paused: the ring keeps the most recent bytes.
    stderr?.on('data', (chunk) => { if (!ended) { ring.write(chunk); stderrBytes += chunk.length; } });
    stderr?.on('error', () => {});

    stdin?.on('error', () => finish('stdin_error'));
    stdin?.on('drain', () => {
        if (stdinTimer !== null) { timers.clearTimeout(stdinTimer); stdinTimer = null; }
    });

    return {
        // Writes one control record to the domain's stdin. Resolves true when it was handed to the pipe.
        writeControl(record) {
            if (ended || !stdin || stdin.destroyed) return Promise.resolve(false);
            const data = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
            if (data.length - 1 > limits.maxRecordBytes) return Promise.reject(new RangeError('Control record is too large'));
            if (stdin.writableLength + data.length > limits.maxPendingStdinBytes) { finish('stdin_overflow'); return Promise.resolve(false); }
            return new Promise((resolve) => {
                const flushed = stdin.write(data, (error) => resolve(!error));
                if (!flushed && stdinTimer === null) {
                    stdinTimer = timers.setTimeout(() => finish('stdin_stall'), limits.stdinStallDeadlineMs);
                    stdinTimer.unref?.();
                }
            });
        },
        end: (reason = 'ended_by_supervisor') => finish(reason),
        stderrTail: () => ring.contents(),
        stats: () => ({
            ended, records, stderrBytes, retainedBytes, peakRetained, pendingBytes, peakPending, paused: [...pauseReasons],
            pauseCount, queuedChunks: queue.length
        })
    };
}

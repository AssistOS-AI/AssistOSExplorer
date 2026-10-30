// Length-prefixed frame codec for the supervisor <-> sandbox and supervisor <-> provider endpoint channels
// (plan section 5.5), Node side. A frame is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON
// that encode one object. The channel carries no descriptors.
//
// Bounds, all decided before a payload byte is retained:
//   - A length above maxFrameBytes (or zero) is refused from the four header bytes alone. Nothing is allocated for it.
//   - A frame that is not complete within partialFrameDeadlineMs of its first byte ends the channel. A trickle of
//     bytes does not extend the deadline.
//   - At most maxInFlight requests are outstanding on a channel at once (FrameChannel.admit).
// Every refusal is reported once through onViolation, after which the decoder ignores input.

export const HEADER_BYTES = 4;

export function encodeFrame(value, { maxFrameBytes }) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    if (payload.length === 0 || payload.length > maxFrameBytes) {
        throw new RangeError('Frame payload is outside the frame size bound');
    }
    const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, HEADER_BYTES);
    return frame;
}

export function createFrameDecoder({
    maxFrameBytes, partialFrameDeadlineMs, onFrame, onViolation,
    timers = { setTimeout, clearTimeout }
}) {
    const header = Buffer.alloc(HEADER_BYTES);
    let headerFilled = 0;
    let expected = -1;
    let parts = [];
    let received = 0;
    let timer = null;
    let dead = false;
    let frames = 0;
    let peakRetained = 0;

    const clearDeadline = () => { if (timer !== null) { timers.clearTimeout(timer); timer = null; } };
    const violate = (code) => {
        if (dead) return;
        dead = true;
        clearDeadline();
        parts = [];
        onViolation(code);
    };
    const startDeadline = () => {
        if (timer !== null) return;
        timer = timers.setTimeout(() => violate('partial_frame_deadline'), partialFrameDeadlineMs);
        timer.unref?.();
    };
    const retained = () => headerFilled + received;

    function complete() {
        const payload = parts.length === 1 ? parts[0] : Buffer.concat(parts, expected);
        parts = [];
        received = 0;
        expected = -1;
        headerFilled = 0;
        clearDeadline();
        let value;
        try { value = JSON.parse(payload.toString('utf8')); } catch { violate('malformed_frame'); return; }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) { violate('malformed_frame'); return; }
        frames += 1;
        onFrame(value);
    }

    function push(chunk) {
        let offset = 0;
        while (offset < chunk.length && !dead) {
            if (expected < 0) {
                startDeadline();
                const take = Math.min(HEADER_BYTES - headerFilled, chunk.length - offset);
                chunk.copy(header, headerFilled, offset, offset + take);
                headerFilled += take;
                offset += take;
                if (headerFilled < HEADER_BYTES) break;
                const length = header.readUInt32BE(0);
                if (length === 0) { violate('empty_frame'); return; }
                if (length > maxFrameBytes) { violate('oversize_frame'); return; }
                expected = length;
            } else {
                const take = Math.min(expected - received, chunk.length - offset);
                // Copy: a slice would keep the whole read buffer alive.
                parts.push(Buffer.from(chunk.subarray(offset, offset + take)));
                received += take;
                offset += take;
                if (received === expected) complete();
            }
            peakRetained = Math.max(peakRetained, retained());
        }
    }

    return {
        push,
        close() { dead = true; clearDeadline(); parts = []; },
        stats: () => ({ frames, peakRetained, dead })
    };
}

// A framed channel over a duplex socket. onFrame receives parsed objects; onViolation receives the refusal code and
// the socket is destroyed; onClose reports a close that was not caused by a violation.
export function createFrameChannel(socket, {
    maxFrameBytes, maxInFlight, partialFrameDeadlineMs, onFrame, onViolation, onClose, timers
}) {
    const inFlight = new Set();
    let violated = false;
    const fail = (code) => {
        if (violated) return;
        violated = true;
        decoder.close();
        socket.destroy();
        onViolation(code);
    };
    const decoder = createFrameDecoder({
        maxFrameBytes, partialFrameDeadlineMs, onFrame: (value) => { if (!violated) onFrame(value); },
        onViolation: fail, timers
    });
    socket.on('data', (chunk) => { if (!violated) decoder.push(chunk); });
    socket.on('close', () => { decoder.close(); if (!violated) onClose?.(); });
    socket.on('error', () => { /* the close event reports it */ });

    return {
        // `callback` runs once the frame has been flushed to the kernel (or has failed), or at once when nothing is written.
        send(value, callback) {
            if (violated || socket.destroyed || !socket.writable) { callback?.(); return false; }
            return socket.write(encodeFrame(value, { maxFrameBytes }), callback);
        },
        // Registers an outstanding request. More than maxInFlight at once is a violation by the peer.
        admit(id) {
            if (inFlight.size >= maxInFlight) { fail('in_flight_overflow'); return false; }
            inFlight.add(id);
            return true;
        },
        settle(id) { inFlight.delete(id); },
        inFlightCount: () => inFlight.size,
        stats: () => ({ ...decoder.stats(), inFlight: inFlight.size, violated, buffered: socket.writableLength }),
        destroy() { violated = true; decoder.close(); socket.destroy(); },
        // Flushes what was written, then closes. Resolves once the write side is finished or the socket is gone.
        end() {
            return new Promise((resolve) => {
                if (socket.destroyed) { resolve(); return; }
                // Bounded: a peer that never reads must not keep the caller waiting for the flush.
                const timer = setTimeout(() => { socket.destroy(); resolve(); }, 500);
                timer.unref?.();
                const done = () => { clearTimeout(timer); resolve(); };
                socket.once('close', done);
                socket.end(done);
            });
        }
    };
}

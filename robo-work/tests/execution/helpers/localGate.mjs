// The start-gate model of the execution MODEL CHECKS: the supervisor side writes one commit byte to a gate pipe, and the
// gated process side decides from what it reads. Only `0x43` commits; end-of-file, any other byte and any read error
// abort. This is test code: the production sandbox preparation has its own gate in server/sandbox/.

export const COMMIT_BYTE = 0x43;
export const GATE_COMMIT = 'commit';
export const GATE_ABORT = 'abort';

// Supervisor side. `stream` is the writable end of the gate pipe.
export function createGate(stream) {
    let settled = false;
    return {
        commit() {
            if (settled) return Promise.resolve(false);
            settled = true;
            return new Promise((resolve) => stream.write(Buffer.from([COMMIT_BYTE]), (error) => resolve(!error)));
        },
        // Releasing the gate without a commit byte is end-of-file: the gated process aborts.
        abort() {
            if (settled) return Promise.resolve(false);
            settled = true;
            return new Promise((resolve) => { stream.end(() => resolve(true)); stream.once('close', () => resolve(true)); });
        }
    };
}

// Gated side. `readSync(fd, buffer, offset, length, position)` returns the number of bytes read, 0 at end-of-file.
export function awaitGate(fd, { readSync }) {
    const byte = Buffer.alloc(1);
    let read;
    try { read = readSync(fd, byte, 0, 1, null); } catch { return GATE_ABORT; }
    if (read === 0) return GATE_ABORT;
    return byte[0] === COMMIT_BYTE ? GATE_COMMIT : GATE_ABORT;
}

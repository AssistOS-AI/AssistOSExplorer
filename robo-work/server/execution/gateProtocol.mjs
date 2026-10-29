// The start-gate protocol of the publication barrier (plan section 5.5, "Create gated"). Helper code reads an explicit
// commit byte from a gate pipe before the final exec. It aborts on end-of-file and on any other input, so a
// supervisor, keeper or endpoint that dies before commit leaves a helper that never reaches the final exec.
//
// The supervisor side writes the commit byte only after the identity tuple has been recorded (the Commit phase). The
// helper side is written for a blocking descriptor and reads exactly one byte.

import fs from 'node:fs';

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
        // Releasing the gate without a commit byte is end-of-file: the helper aborts.
        abort() {
            if (settled) return Promise.resolve(false);
            settled = true;
            return new Promise((resolve) => { stream.end(() => resolve(true)); stream.once('close', () => resolve(true)); });
        }
    };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Helper side. Blocks until the gate decides. `commit` only for the explicit commit byte; end-of-file, any other byte
// and any read error are `abort`.
export function awaitGate(fd, { readSync = fs.readSync } = {}) {
    const byte = Buffer.alloc(1);
    for (;;) {
        let read;
        try { read = readSync(fd, byte, 0, 1, null); } catch (error) {
            if (error.code === 'EAGAIN') { sleep(2); continue; }
            return GATE_ABORT;
        }
        if (read === 0) return GATE_ABORT;
        return byte[0] === COMMIT_BYTE ? GATE_COMMIT : GATE_ABORT;
    }
}

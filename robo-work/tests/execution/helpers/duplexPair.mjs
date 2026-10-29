import { Duplex } from 'node:stream';

// An in-memory pair of connected duplex streams that stand in for a Unix socket in unit tests.
export function duplexPair() {
    // Like a socket, closing one end ends the other: allowHalfOpen is off and destroying an end ends its peer's input.
    const make = () => new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, _encoding, callback) { this.peer.push(chunk); callback(); },
        final(callback) { this.peer.push(null); callback(); },
        destroy(error, callback) { this.peer.push(null); callback(error); }
    });
    const left = make();
    const right = make();
    left.peer = right;
    right.peer = left;
    return [left, right];
}

export function descriptorCount() {
    const fs = process.getBuiltinModule('node:fs');
    for (const directory of ['/proc/self/fd', '/dev/fd']) {
        try { return fs.readdirSync(directory).length - 1; } catch { /* next */ }
    }
    throw new Error('no descriptor directory to count');
}

export const waitFor = async (predicate, limitMs = 3000, stepMs = 5) => {
    for (let waited = 0; waited < limitMs; waited += stepMs) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return predicate();
};

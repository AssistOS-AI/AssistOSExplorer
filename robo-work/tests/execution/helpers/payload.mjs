import crypto from 'node:crypto';

// A known, non-repeating payload small enough to sit in the kernel's socket buffer before anyone reads it.
export function knownPayload(length = 2048) {
    const chunks = [];
    let size = 0;
    for (let counter = 0; size < length; counter += 1) {
        const block = crypto.createHash('sha256').update(`robo-work-s4-payload-${counter}`).digest();
        chunks.push(block);
        size += block.length;
    }
    return Buffer.concat(chunks).subarray(0, length);
}

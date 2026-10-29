import assert from 'node:assert/strict';
import test from 'node:test';

import { HEADER_BYTES, createFrameChannel, createFrameDecoder, encodeFrame } from '../../server/execution/frameCodec.mjs';
import { duplexPair, waitFor } from './helpers/duplexPair.mjs';

// PROVISIONAL test bounds; G5 fixes the production values.
const MAX = 1024;

function decoder(overrides = {}) {
    const frames = [];
    const violations = [];
    const instance = createFrameDecoder({
        maxFrameBytes: MAX, partialFrameDeadlineMs: 80, onFrame: (value) => frames.push(value),
        onViolation: (code) => violations.push(code), ...overrides
    });
    return { instance, frames, violations };
}

test('a frame round-trips whole, split byte by byte, and several frames in one chunk', () => {
    const a = encodeFrame({ id: 1, op: 'inventory' }, { maxFrameBytes: MAX });
    const b = encodeFrame({ id: 2, op: 'tempdir' }, { maxFrameBytes: MAX });
    const whole = decoder();
    whole.instance.push(Buffer.concat([a, b]));
    assert.deepEqual(whole.frames, [{ id: 1, op: 'inventory' }, { id: 2, op: 'tempdir' }]);
    const split = decoder();
    for (const byte of Buffer.concat([a, b])) split.instance.push(Buffer.from([byte]));
    assert.deepEqual(split.frames, whole.frames);
    assert.deepEqual([...whole.violations, ...split.violations], []);
});

test('a frame of exactly the maximum size is accepted and one byte more cannot be encoded', () => {
    const filler = 'x'.repeat(MAX - JSON.stringify({ a: '' }).length);
    const exact = encodeFrame({ a: filler }, { maxFrameBytes: MAX });
    assert.equal(exact.length, HEADER_BYTES + MAX);
    const { instance, frames } = decoder();
    instance.push(exact);
    assert.equal(frames.length, 1);
    assert.throws(() => encodeFrame({ a: `${filler}x` }, { maxFrameBytes: MAX }), RangeError);
});

test('an oversize length prefix is refused from the header alone, before any payload allocation', () => {
    const sizes = [];
    const realAlloc = Buffer.alloc;
    const realUnsafe = Buffer.allocUnsafe;
    const realConcat = Buffer.concat;
    Buffer.alloc = (size, ...rest) => { sizes.push(size); return realAlloc.call(Buffer, size, ...rest); };
    Buffer.allocUnsafe = (size) => { sizes.push(size); return realUnsafe.call(Buffer, size); };
    Buffer.concat = (list, total) => { sizes.push(total ?? list.reduce((sum, part) => sum + part.length, 0)); return realConcat.call(Buffer, list, total); };
    const { instance, violations } = decoder();
    try {
        const header = Buffer.alloc(HEADER_BYTES);
        header.writeUInt32BE(0xffffffff, 0);
        instance.push(header);
        // Everything that follows the refusal is ignored and never buffered.
        instance.push(Buffer.alloc(8192));
    } finally {
        Buffer.alloc = realAlloc;
        Buffer.allocUnsafe = realUnsafe;
        Buffer.concat = realConcat;
    }
    assert.deepEqual(violations, ['oversize_frame']);
    assert.ok(sizes.every((size) => size <= MAX + HEADER_BYTES || size === 8192), `allocated ${JSON.stringify(sizes)}`);
    assert.equal(sizes.some((size) => size >= 1_000_000), false, 'nothing was allocated for the advertised length');
    assert.ok(instance.stats().peakRetained <= HEADER_BYTES);
});

test('a zero length, malformed JSON and a non-object payload are each refused once', () => {
    const zero = decoder();
    zero.instance.push(Buffer.alloc(HEADER_BYTES));
    assert.deepEqual(zero.violations, ['empty_frame']);
    const framed = (text) => { const body = Buffer.from(text); const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); };
    for (const text of ['{not json', '[1,2]', '"text"', '7', 'null']) {
        const run = decoder();
        run.instance.push(framed(text));
        assert.deepEqual(run.violations, ['malformed_frame'], text);
        run.instance.push(encodeFrame({ ok: true }, { maxFrameBytes: MAX }));
        assert.equal(run.frames.length, 0, 'a dead decoder ignores later input');
    }
});

test('a partial frame that stalls ends the channel at the deadline, and a slow trickle does not extend it', async () => {
    const stalled = decoder();
    stalled.instance.push(Buffer.from([0, 0]));
    assert.equal(await waitFor(() => stalled.violations.length === 1, 1000), true);
    assert.deepEqual(stalled.violations, ['partial_frame_deadline']);

    // One byte every 25 ms against an 80 ms deadline. If every byte extended the deadline, no violation could come
    // while bytes are still arriving; the violation must come during the trickle, before the frame is complete.
    const trickle = decoder();
    const frame = encodeFrame({ id: 1, op: 'inventory' }, { maxFrameBytes: MAX });
    let pushed = 0;
    for (let index = 0; index < frame.length - 1 && trickle.violations.length === 0; index += 1) {
        trickle.instance.push(frame.subarray(index, index + 1));
        pushed += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(trickle.violations, ['partial_frame_deadline']);
    assert.ok(pushed < frame.length - 1, `the deadline fired after ${pushed} of ${frame.length} bytes, while the frame was still incomplete`);
    assert.equal(trickle.frames.length, 0);
});

test('a completed frame clears the deadline and idle time between frames is not a stall', async () => {
    const { instance, frames, violations } = decoder();
    instance.push(encodeFrame({ id: 1 }, { maxFrameBytes: MAX }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    instance.push(encodeFrame({ id: 2 }, { maxFrameBytes: MAX }));
    assert.equal(frames.length, 2);
    assert.deepEqual(violations, []);
});

function channelPair(overrides = {}) {
    const [near, far] = duplexPair();
    const log = { frames: [], violations: [], closed: 0 };
    const channel = createFrameChannel(near, {
        maxFrameBytes: MAX, maxInFlight: 3, partialFrameDeadlineMs: 500,
        onFrame: (value) => log.frames.push(value), onViolation: (code) => log.violations.push(code),
        onClose: () => { log.closed += 1; }, ...overrides
    });
    return { channel, far, near, log };
}

test('a channel bounds the requests in flight and a fourth outstanding request is a violation that destroys the socket', () => {
    const { channel, near, log } = channelPair();
    assert.equal(channel.admit(1), true);
    assert.equal(channel.admit(2), true);
    assert.equal(channel.admit(3), true);
    channel.settle(1);
    assert.equal(channel.admit(4), true, 'a settled request frees its slot');
    assert.equal(channel.admit(5), false);
    assert.deepEqual(log.violations, ['in_flight_overflow']);
    assert.equal(near.destroyed, true);
    assert.equal(channel.send({ id: 9 }), false, 'nothing is written after a violation');
});

test('a channel delivers frames both ways and reports an oversize prefix as a violation', async () => {
    const { channel, far, log } = channelPair();
    far.write(encodeFrame({ id: 1, op: 'inventory' }, { maxFrameBytes: MAX }));
    assert.equal(await waitFor(() => log.frames.length === 1), true);
    assert.equal(channel.send({ id: 1, ok: true }), true);
    const reply = far.read();
    assert.deepEqual(JSON.parse(reply.subarray(HEADER_BYTES).toString()), { id: 1, ok: true });
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(MAX + 1);
    far.write(header);
    assert.equal(await waitFor(() => log.violations.length === 1), true);
    assert.deepEqual(log.violations, ['oversize_frame']);
});

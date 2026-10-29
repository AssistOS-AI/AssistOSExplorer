// Node side of the frame `descriptors` parity vector shared with the native target helper
// (robo-work/native/crates/target-helper/tests/vectors/frame-descriptor-parity.json; the Rust side is
// tests/frame_descriptor_parity.rs). Each case re-signs the public synthetic transport frame with a replaced
// messageKind/descriptors value and requires validateTargetFrame to give exactly the pinned result.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalTargetJson } from '../../server/executionTarget/contract.mjs';
import { validateTargetFrame } from '../../server/executionTarget/transportContract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'transport-v1.json'), 'utf8'));
const parity = JSON.parse(fs.readFileSync(path.resolve(here, '../../native/crates/target-helper/tests/vectors/frame-descriptor-parity.json'), 'utf8'));
const bytes = (hex) => Buffer.from(hex, 'hex');
const vector = transport.frames[0];

function frameFor(entry) {
    const body = bytes(vector.bodyHex);
    const header = { ...vector.header, messageKind: entry.messageKind, descriptors: entry.descriptors };
    const text = canonicalTargetJson(header);
    assert.equal(text.ok, true, entry.name);
    const headerBytes = Buffer.from(text.value, 'utf8');
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(4 + headerBytes.length + body.length + 32, 0);
    prefix.writeUInt32BE(headerBytes.length, 4);
    const mac = crypto.createHmac('sha256', bytes(vector.keyHex)).update(bytes(transport.frameMacDomainHex)).update(prefix).update(headerBytes).update(body).digest();
    return Buffer.concat([prefix, headerBytes, body, mac]);
}

const state = {
    direction: vector.direction, sessionKey: bytes(transport.sessionKeyHex), claimsCanonical: transport.ticket.claimsCanonical,
    binding: transport.ticket.claims.binding,
    expected: {
        leaseId: vector.header.leaseId, reservationId: transport.ticket.expected.reservationId,
        operationId: transport.ticket.expected.operationId, requestDigest: transport.ticket.expected.requestDigest
    },
    channelEpoch: '1', nextSequence: '1', leaseState: 'active',
    ancillary: { count: 0, truncated: false, wellFormed: true, onFirstByte: true }
};

test('frame descriptors parity cases give the pinned Node result', () => {
    assert.equal(parity.version, 1);
    assert.ok(parity.cases.length >= 10);
    for (const entry of parity.cases) {
        const result = validateTargetFrame(frameFor(entry), state);
        assert.equal(result.ok ? 'ok' : result.error.code, entry.expected, entry.name);
    }
});

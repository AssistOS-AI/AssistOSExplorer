// PUBLIC SYNTHETIC known answers for T0 §8 / A1.7. No listener, minter, native helper or environment credentials.
// The portable JSON corpus pins independently calculated bytes; this test never regenerates its expected values.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { canonicalTargetJson, targetDigest } from '../../server/executionTarget/contract.mjs';
import { validateHelperTicketClaims, validateTargetFrame } from '../../server/executionTarget/transportContract.mjs';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/transport-v1.json', import.meta.url), 'utf8'));
const ticket = vectors.ticket;
const bytes = (hex) => Buffer.from(hex, 'hex');
const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest();

// Used only for negative/control variants, never to supply the known-answer expectations.
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sign(claimsText) {
    const input = `${Buffer.from(ticket.headerCanonical).toString('base64url')}.${Buffer.from(claimsText).toString('base64url')}`;
    return `${input}.${hmac(bytes(ticket.secretHex), input).toString('base64url')}`;
}

function ticketOptions(binding = ticket.claims.binding) {
    return {
        secret: bytes(ticket.secretHex), kid: ticket.header.kid, binding, expected: ticket.expected,
        channel: { currentEpoch: null, leaseState: 'active' }, challenge: ticket.challenge,
        nowMs: ticket.nowMs, nowMonoMs: ticket.nowMonoMs, replay: new Map(),
    };
}

function frameState(vector) {
    return {
        direction: vector.direction, sessionKey: bytes(vectors.sessionKeyHex), claimsCanonical: ticket.claimsCanonical,
        binding: ticket.claims.binding,
        expected: {
            leaseId: vector.header.leaseId, reservationId: ticket.expected.reservationId,
            operationId: ticket.expected.operationId, requestDigest: ticket.expected.requestDigest,
        },
        channelEpoch: '1', nextSequence: '1', leaseState: 'active',
        ancillary: { count: 0, truncated: false, wellFormed: true, onFirstByte: true },
    };
}

function refused(result, code) {
    assert.deepEqual(result, { ok: false, error: { code } });
}

test('public corpus pins target identity projection, canonical claims and raw SHA-256 salt', () => {
    assert.equal(vectors.version, 1);
    assert.deepEqual(vectors.targetIdentity.projectionKeys, [
        'agentPrincipal', 'boxGeneration', 'boxIdentity', 'containerId', 'enableGeneration',
        'helperIncarnation', 'runtimeInstanceId', 'workspaceId',
    ]);
    assert.deepEqual(vectors.targetIdentity.projection, Object.fromEntries(
        vectors.targetIdentity.projectionKeys.map((key) => [key, ticket.claims.binding.scope[key]]),
    ));
    for (const [value, canonicalJson, digest] of [
        [vectors.targetIdentity.projection, vectors.targetIdentity.canonicalJson, vectors.targetIdentity.sha256],
        [ticket.claims.binding, vectors.bindingCanonical, vectors.bindingDigest],
        [ticket.claims, ticket.claimsCanonical, ticket.claimsDigest],
    ]) {
        assert.deepEqual(canonicalTargetJson(value), { ok: true, value: canonicalJson });
        assert.deepEqual(targetDigest(value), { ok: true, value: digest });
        assert.equal(sha(Buffer.from(canonicalJson, 'utf8')), digest);
    }
    assert.equal(ticket.claims.aud, `ploinky:target-helper:${vectors.targetIdentity.sha256}`);
    assert.equal(ticket.hkdfSaltHex, ticket.claimsDigest);
    assert.equal(bytes(ticket.hkdfSaltHex).length, 32, 'salt is raw digest bytes, not 64 ASCII hex bytes');
});

test('literal HS256 compact JWS validates and replay, signature and canonical mutations refuse', () => {
    assert.deepEqual(canonicalTargetJson(ticket.header), { ok: true, value: ticket.headerCanonical });
    assert.equal(ticket.signingInput, `${Buffer.from(ticket.headerCanonical).toString('base64url')}.${Buffer.from(ticket.claimsCanonical).toString('base64url')}`);
    assert.equal(hmac(bytes(ticket.secretHex), ticket.signingInput).toString('hex'), ticket.signatureHex);
    assert.equal(ticket.compactJws, `${ticket.signingInput}.${bytes(ticket.signatureHex).toString('base64url')}`);
    const options = ticketOptions();
    assert.deepEqual(validateHelperTicketClaims(ticket.compactJws, options), { ok: true, value: ticket.claims });
    refused(validateHelperTicketClaims(ticket.compactJws, options), 'ticket_replayed');
    const signature = bytes(ticket.signatureHex);
    signature[0] ^= 1;
    const fresh = ticketOptions();
    refused(validateHelperTicketClaims(`${ticket.signingInput}.${signature.toString('base64url')}`, fresh), 'ticket_signature');
    refused(validateHelperTicketClaims(sign(` ${ticket.claimsCanonical}`), fresh), 'noncanonical_encoding');
    assert.equal(fresh.replay.size, 0, 'refusals do not consume replay capacity');
});

test('ticket audience includes each target/Box key and excludes every worker scope key', () => {
    for (const key of Object.keys(ticket.claims.binding.scope)) {
        const claims = structuredClone(ticket.claims);
        const original = claims.binding.scope[key];
        claims.binding.scope[key] = ['helperIncarnation', 'workerGeneration'].includes(key)
            ? Buffer.alloc(16, 99).toString('base64url') : key === 'containerId' ? 'd'.repeat(64) : `${original}-changed`;
        if (key === 'workerPrincipal') claims.sub = claims.binding.scope[key];
        // Re-sign and update the held binding, keeping the literal audience: only its projection can now disagree.
        const result = validateHelperTicketClaims(sign(canonical(claims)), ticketOptions(claims.binding));
        if (vectors.targetIdentity.projectionKeys.includes(key)) refused(result, 'ticket_binding');
        else assert.deepEqual(result, { ok: true, value: claims }, key);
    }
});

for (const vector of vectors.frames) {
    test(`${vector.direction}: fixed HKDF key, MAC input and full frame validate`, () => {
        const salt = bytes(ticket.hkdfSaltHex);
        const sessionKey = bytes(vectors.sessionKeyHex);
        const prk = hmac(salt, sessionKey);
        assert.equal(prk.toString('hex'), vectors.hkdfExtractHex);
        assert.equal(hmac(prk, Buffer.concat([Buffer.from(vector.direction, 'ascii'), Buffer.from([1])])).toString('hex'), vector.keyHex);
        assert.equal(Buffer.from(crypto.hkdfSync('sha256', sessionKey, salt, Buffer.from(vector.direction, 'ascii'), 32)).toString('hex'), vector.keyHex);
        assert.deepEqual(canonicalTargetJson(vector.header), { ok: true, value: vector.headerCanonical });
        const header = Buffer.from(vector.headerCanonical, 'utf8');
        const body = bytes(vector.bodyHex);
        const prefix = bytes(vector.prefixHex);
        assert.equal(header.length, vector.headerBytes);
        assert.equal(prefix.readUInt32BE(0), 4 + header.length + body.length + 32);
        assert.equal(prefix.readUInt32BE(4), header.length);
        assert.equal(vector.header.bodyBytes, body.length);
        assert.equal(vector.header.bodyDigest, sha(body));
        assert.equal(bytes(vectors.frameMacDomainHex).toString('ascii'), 'ploinky-target-frame-v1\0');
        assert.equal(Buffer.concat([bytes(vectors.frameMacDomainHex), prefix, header, body]).toString('hex'), vector.macInputHex);
        assert.equal(hmac(bytes(vector.keyHex), bytes(vector.macInputHex)).toString('hex'), vector.macHex);
        assert.equal(Buffer.concat([prefix, header, body, bytes(vector.macHex)]).toString('hex'), vector.encodedHex);
        assert.deepEqual(validateTargetFrame(bytes(vector.encodedHex), frameState(vector)), {
            ok: true, value: { header: vector.header, bodyOffset: 8 + vector.headerBytes, bodyLength: body.length, nextSequence: '2' },
        });
    });

    test(`${vector.direction}: byte tampering, wrong salt encoding and direction key refuse`, () => {
        const encoded = bytes(vector.encodedHex);
        for (let offset = 0; offset < encoded.length; offset += 1) {
            const changed = Buffer.from(encoded);
            changed[offset] ^= 1;
            const result = validateTargetFrame(changed, frameState(vector));
            assert.equal(result.ok, false, `authenticated byte ${offset}`);
            assert.ok(['frame_layout', 'capacity_exceeded', 'frame_authentication'].includes(result.error.code));
        }
        const other = vectors.frames.find((entry) => entry.direction !== vector.direction);
        const asciiSaltKey = Buffer.from(crypto.hkdfSync('sha256', bytes(vectors.sessionKeyHex), Buffer.from(ticket.claimsDigest, 'ascii'), Buffer.from(vector.direction), 32));
        for (const key of [bytes(other.keyHex), asciiSaltKey]) {
            assert.notEqual(key.toString('hex'), vector.keyHex);
            const wrongMac = hmac(key, bytes(vector.macInputHex));
            refused(validateTargetFrame(Buffer.concat([encoded.subarray(0, -32), wrongMac]), frameState(vector)), 'frame_authentication');
        }
        refused(validateTargetFrame(encoded, { ...frameState(vector), nextSequence: '2' }), 'frame_sequence');
        refused(validateTargetFrame(encoded, { ...frameState(vector), channelEpoch: '2' }), 'frame_binding');
        refused(validateTargetFrame(encoded, { ...frameState(vector), claimsCanonical: `${ticket.claimsCanonical}\n` }), 'frame_authentication');
    });
}

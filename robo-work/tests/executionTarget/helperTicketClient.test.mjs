// SYNTHETIC tests of the worker-side helper-ticket client (server/helperTicketClient.mjs). The Router is replaced by an
// in-memory fake that signs tickets the way the Ploinky minter does (canonical header and claims, HS256 under a synthetic
// per-incarnation key, A11.5 session key). The anchor to the real Ploinky minter is session-fixture-v1.json: Ploinky's
// minter test reproduces that compact JWS byte for byte (executionTargetHelperTicket.test.mjs), and here the client
// accepts exactly that ticket and the helper-side validator verifies it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalTargetJson } from '../../server/executionTarget/contract.mjs';
import { validateHelperTicketClaims } from '../../server/executionTarget/transportContract.mjs';
import { HELPER_TICKET_MINT_CODES, HELPER_TICKET_REQUEST_KEYS, createHelperTicketClient } from '../../server/helperTicketClient.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FIXTURE = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'native', 'crates', 'target-helper', 'tests', 'vectors', 'session-fixture-v1.json'), 'utf8'));

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const canon = (value) => canonicalTargetJson(value).value;
const SECRET = crypto.createHash('sha256').update('synthetic-incarnation-secret-not-real').digest();
const KID = 'hti1.AgICAgICAgICAgICAgICAg';
const NOW = 1_800_000_000_000;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const fixtureClaims = JSON.parse(Buffer.from(SESSION_FIXTURE.withFixtureKey.compactJws.split('.')[1], 'base64url').toString('utf8'));

function requestFrom(claims) {
    return {
        binding: claims.binding, leaseId: claims.leaseId, reservationId: claims.reservationId, operationId: claims.operationId,
        requestDigest: claims.requestDigest, helperNonce: claims.helperNonce, channelEpoch: claims.channelEpoch,
        previousChannelEpoch: claims.previousChannelEpoch, permissions: claims.permissions, ttlSeconds: claims.exp - claims.iat
    };
}

const REQUEST = Object.freeze(requestFrom(fixtureClaims));

function targetAudience(scope) {
    const target = {
        workspaceId: scope.workspaceId, boxIdentity: scope.boxIdentity, boxGeneration: scope.boxGeneration, agentPrincipal: scope.agentPrincipal,
        containerId: scope.containerId, runtimeInstanceId: scope.runtimeInstanceId, enableGeneration: scope.enableGeneration, helperIncarnation: scope.helperIncarnation
    };
    return `ploinky:target-helper:${crypto.createHash('sha256').update(canon(target)).digest('hex')}`;
}

// What the Router answers for `request`: a ticket signed like the Ploinky minter, optionally mutated before signing.
function mintLike(request, { claims: mutateClaims = (c) => c, header: mutateHeader = (h) => h, nowMs = NOW, kid = KID, secret = SECRET, value: mutateValue = (v) => v, encodeClaims = canon, encodeHeader = canon } = {}) {
    const iat = Math.floor(nowMs / 1000);
    const claims = mutateClaims({
        version: 1, iss: 'ploinky-router', sub: request.binding.scope.workerPrincipal, purpose: 'ploinky.target-helper.v1',
        aud: targetAudience(request.binding.scope), binding: request.binding, leaseId: request.leaseId, reservationId: request.reservationId,
        operationId: request.operationId, requestDigest: request.requestDigest, helperNonce: request.helperNonce,
        jti: b64(crypto.randomBytes(32)), iat, exp: iat + request.ttlSeconds, channelEpoch: request.channelEpoch,
        previousChannelEpoch: request.previousChannelEpoch, permissions: request.permissions, limitsDigest: request.binding.limitsDigest
    });
    const claimBytes = Buffer.from(encodeClaims(claims));
    const header = b64(Buffer.from(encodeHeader(mutateHeader({ alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid }))));
    const payload = b64(claimBytes);
    const mac = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const sessionKey = Buffer.from(crypto.hkdfSync('sha256', secret, crypto.createHash('sha256').update(claimBytes).digest(), 'ploinky-target-session-v1', 32));
    return mutateValue({ ticket: `${header}.${payload}.${b64(mac)}`, kid, jti: claims.jti, iat: claims.iat, exp: claims.exp, sessionKey: b64(sessionKey) });
}

function routerReturning(answer) {
    const sent = [];
    const transport = async (bytes) => {
        sent.push(bytes);
        return typeof answer === 'function' ? answer(JSON.parse(bytes.toString('utf8'))) : answer;
    };
    return { sent, transport };
}

const okAnswer = (value) => ({ status: 200, body: Buffer.from(JSON.stringify({ ok: true, value })) });

test('E1 the client sends exactly the ten-key request and returns a ticket that says what it asked for', async () => {
    const { sent, transport } = routerReturning((request) => okAnswer(mintLike(request)));
    const client = createHelperTicketClient({ transport, now: () => NOW + 1000 });
    const result = await client.mintTicket(REQUEST);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(Object.keys(result.value).sort(), ['exp', 'iat', 'jti', 'kid', 'sessionKey', 'ticket']);
    assert.equal(sent.length, 1);
    const body = JSON.parse(sent[0].toString('utf8'));
    assert.deepEqual(Object.keys(body).sort(), [...HELPER_TICKET_REQUEST_KEYS].sort());
    assert.deepEqual(body, REQUEST);
    // The accepted ticket is valid for the helper-side validator under the incarnation key.
    const validated = validateHelperTicketClaims(result.value.ticket, {
        secret: SECRET, kid: KID, binding: REQUEST.binding,
        expected: { reservationId: REQUEST.reservationId, leaseId: REQUEST.leaseId, operationId: REQUEST.operationId, requestDigest: REQUEST.requestDigest, helperNonce: REQUEST.helperNonce },
        channel: { currentEpoch: null, leaseState: 'active' }, challenge: { id: 'c-1', issuedMonoMs: 0 }, nowMonoMs: 1, nowMs: NOW + 1000, replay: new Map()
    });
    assert.equal(validated.ok, true, JSON.stringify(validated));
    assert.equal(Object.isFrozen(result) && Object.isFrozen(result.value), true);
});

test('E1 the client accepts the session-fixture-v1.json ticket the Ploinky minter reproduces, with its session key', async () => {
    const vector = SESSION_FIXTURE.withFixtureKey;
    const value = {
        ticket: vector.compactJws, kid: SESSION_FIXTURE.fixtureTicketKey.kid, jti: fixtureClaims.jti, iat: fixtureClaims.iat, exp: fixtureClaims.exp,
        sessionKey: Buffer.from(vector.sessionKeyHex, 'hex').toString('base64url')
    };
    const client = createHelperTicketClient({ transport: routerReturning(okAnswer(value)).transport, now: () => fixtureClaims.iat * 1000 });
    const result = await client.mintTicket(REQUEST);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.ticket, vector.compactJws);
    // The returned session key is HKDF of the fixture key over the claims digest (A11.5), as the helper derives it.
    const derived = crypto.hkdfSync('sha256', Buffer.from(SESSION_FIXTURE.fixtureTicketKey.secretHex, 'hex'),
        Buffer.from(SESSION_FIXTURE.inputs.claimsCanonicalSha256, 'hex'), SESSION_FIXTURE.sessionKeyInfo, 32);
    assert.equal(Buffer.from(result.value.sessionKey, 'base64url').toString('hex'), Buffer.from(derived).toString('hex'));
    // Another request (one field differs) does not accept that ticket.
    const other = await client.mintTicket({ ...REQUEST, operationId: 'CQkJCQkJCQkJCQkJCQkJCQ' });
    assert.deepEqual(other, { ok: false, error: { code: 'ticket_binding' } });
});

test('E1 a ticket that differs from the request in any bound field, or is malformed, is refused as ticket_binding', async () => {
    const id = (byte) => Buffer.alloc(16, byte).toString('base64url');
    const cases = {
        'binding scope': { claims: (c) => ({ ...c, binding: { ...c.binding, scope: { ...c.binding.scope, containerId: 'd'.repeat(64) } } }) },
        'binding robot': { claims: (c) => ({ ...c, binding: { ...c.binding, robotId: id(0x44) } }) },
        audience: { claims: (c) => ({ ...c, aud: `ploinky:target-helper:${'0'.repeat(64)}` }) },
        subject: { claims: (c) => ({ ...c, sub: 'agent:Synthetic/other' }) },
        issuer: { claims: (c) => ({ ...c, iss: 'someone-else' }) },
        purpose: { claims: (c) => ({ ...c, purpose: 'ploinky.coordinator.v1' }) },
        version: { claims: (c) => ({ ...c, version: 2 }) },
        leaseId: { claims: (c) => ({ ...c, leaseId: id(0x45) }) },
        reservationId: { claims: (c) => ({ ...c, reservationId: id(0x46) }) },
        operationId: { claims: (c) => ({ ...c, operationId: id(0x47) }) },
        requestDigest: { claims: (c) => ({ ...c, requestDigest: '0'.repeat(64) }) },
        helperNonce: { claims: (c) => ({ ...c, helperNonce: b64(Buffer.alloc(32, 0x48)) }) },
        channelEpoch: { claims: (c) => ({ ...c, channelEpoch: '2' }) },
        previousChannelEpoch: { claims: (c) => ({ ...c, previousChannelEpoch: '0' }) },
        'widened permissions': { claims: (c) => ({ ...c, permissions: [...c.permissions, 'zz'] }) },
        'narrowed permissions': { claims: (c) => ({ ...c, permissions: ['commit'] }) },
        limitsDigest: { claims: (c) => ({ ...c, limitsDigest: '0'.repeat(64) }) },
        'longer lifetime': { claims: (c) => ({ ...c, exp: c.iat + 31 }) },
        'extra claim': { claims: (c) => ({ ...c, extra: 1 }) },
        'missing claim': { claims: ({ jti, ...rest }) => ({ ...rest, jtiX: jti }) },
        'header kid differs from value kid': { header: (h) => ({ ...h, kid: 'hti1.other' }) },
        'header typ': { header: (h) => ({ ...h, typ: 'router-service' }) },
        'header alg': { header: (h) => ({ ...h, alg: 'none' }) },
        'header extra key': { header: (h) => ({ ...h, cty: 'x' }) },
        // Correct key sets, noncanonical bytes: only the byte-canonical check refuses these.
        'claims with whitespace': { encodeClaims: (c) => JSON.stringify(JSON.parse(canon(c)), null, 1) },
        'claims keys reordered': { encodeClaims: (c) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(canon(c))).reverse())) },
        'header keys reordered': { encodeHeader: (h) => JSON.stringify({ typ: h.typ, alg: h.alg, kid: h.kid }) },
        'value jti differs': { value: (v) => ({ ...v, jti: b64(Buffer.alloc(32, 1)) }) },
        'value exp differs': { value: (v) => ({ ...v, exp: v.exp + 1 }) },
        'value extra key': { value: (v) => ({ ...v, extra: 1 }) },
        'short session key': { value: (v) => ({ ...v, sessionKey: b64(Buffer.alloc(16, 1)) }) },
        // The last of 43 characters carries 4 data bits and 2 zero bits: setting a zero bit decodes to the same bytes.
        'noncanonical session key': { value: (v) => ({ ...v, sessionKey: `${v.sessionKey.slice(0, 42)}${B64URL[(B64URL.indexOf(v.sessionKey[42]) & ~3) | 1]}` }) },
        'two-part ticket': { value: (v) => ({ ...v, ticket: v.ticket.split('.').slice(0, 2).join('.') }) },
        'padded segment': { value: (v) => ({ ...v, ticket: v.ticket.replace('.', '=.') }) }
    };
    for (const [label, mutation] of Object.entries(cases)) {
        const value = mintLike(REQUEST, mutation);
        const client = createHelperTicketClient({ transport: routerReturning(okAnswer(value)).transport, now: () => NOW + 1000 });
        const result = await client.mintTicket(REQUEST);
        assert.deepEqual(result, { ok: false, error: { code: 'ticket_binding' } }, label);
        assert.equal(JSON.stringify(result).includes(value.sessionKey), false, label);
    }
    // A ticket over the token bound cannot fit the 64 KiB answer: the answer is refused unread (unknown outcome).
    const huge = mintLike(REQUEST, { value: (v) => ({ ...v, ticket: `${v.ticket}${'A'.repeat(65536)}` }) });
    const hugeClient = createHelperTicketClient({ transport: routerReturning(okAnswer(huge)).transport, now: () => NOW + 1000 });
    await assert.rejects(() => hugeClient.mintTicket(REQUEST), /^Error: helper_ticket_response_too_large$/);
    // Expired at receipt, or issued beyond the helper's future skew.
    const value = mintLike(REQUEST);
    for (const nowMs of [value.exp * 1000, value.exp * 1000 + 1, value.iat * 1000 - 2001]) {
        const client = createHelperTicketClient({ transport: routerReturning(okAnswer(value)).transport, now: () => nowMs });
        assert.deepEqual(await client.mintTicket(REQUEST), { ok: false, error: { code: 'ticket_binding' } }, String(nowMs));
    }
});

test('E1 refusals: minter codes pass through, unknown codes are reduced, definite Router refusals are terminal', async () => {
    const ask = async (answer) => createHelperTicketClient({ transport: routerReturning(answer).transport, now: () => NOW }).mintTicket(REQUEST);
    for (const code of HELPER_TICKET_MINT_CODES) {
        assert.deepEqual(await ask({ status: 200, body: JSON.stringify({ ok: false, error: { code } }) }), { ok: false, error: { code } }, code);
    }
    assert.deepEqual(await ask({ status: 200, body: JSON.stringify({ ok: false, error: { code: 'rm -rf / injected text' } }) }), { ok: false, error: { code: 'refused' } });
    assert.deepEqual(await ask({ status: 403, body: JSON.stringify({ ok: false, error: 'PRIVATE_CALLER_DENIED' }) }), { ok: false, error: { code: 'forbidden' } });
    assert.deepEqual(await ask({ status: 400, body: JSON.stringify({ error: 'invalid_request' }) }), { ok: false, error: { code: 'invalid_request' } });
    assert.deepEqual(await ask({ status: 400, body: JSON.stringify({ error: 'TARGET_HELPER_TICKET_REQUEST_INVALID' }) }), { ok: false, error: { code: 'invalid_request' } });
    assert.deepEqual(await ask({ status: 413, body: JSON.stringify({ error: 'request_too_large' }) }), { ok: false, error: { code: 'invalid_request' } });
    assert.deepEqual(await ask({ status: 429, body: JSON.stringify({ error: 'capacity_exceeded' }) }), { ok: false, error: { code: 'capacity_exceeded' } });
    // Unknown outcomes throw: a changed edge generation, an assertion refusal, a server error, malformed answers.
    for (const answer of [
        { status: 503, body: JSON.stringify({ ok: false, error: 'edge_generation_changed' }) },
        { status: 401, body: JSON.stringify({ ok: false, error: 'PRIVATE_ASSERTION_REJECTED' }) },
        { status: 403, body: JSON.stringify({ ok: false, error: 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE' }) },
        { status: 500, body: '{}' },
        { status: 200, body: 'not json' },
        { status: 200, body: JSON.stringify({ ok: 'yes' }) },
        { status: 200, body: JSON.stringify({ ok: false, error: 'flat' }) },
        { status: 200, body: JSON.stringify({ ok: true, value: {}, extra: 1 }) },
        { status: 200, body: Buffer.alloc(64 * 1024 + 1, 0x20) },
        null
    ]) {
        await assert.rejects(() => ask(answer), (error) => /^helper_ticket_/.test(error.message), JSON.stringify(answer)?.slice(0, 80));
    }
    const failing = createHelperTicketClient({ transport: async () => { throw new Error('transport down'); } });
    await assert.rejects(() => failing.mintTicket(REQUEST), /transport down/);
});

test('E1 malformed or oversized requests never leave the worker', async () => {
    const { sent, transport } = routerReturning(okAnswer({}));
    const client = createHelperTicketClient({ transport, now: () => NOW });
    const { ttlSeconds, ...missing } = REQUEST;
    for (const request of [null, [], 'x', { ...REQUEST, extra: 1 }, missing, { ...REQUEST, binding: null }, { ...REQUEST, ttlSeconds: '30' },
        { ...REQUEST, permissions: 'commit' }, { ...REQUEST, binding: { ...REQUEST.binding, pad: 'x'.repeat(64 * 1024) } }, { ...REQUEST, ttlSeconds: 30n }]) {
        assert.deepEqual(await client.mintTicket(request), { ok: false, error: { code: 'invalid_request' } });
    }
    assert.equal(sent.length, 0);
    assert.throws(() => createHelperTicketClient({}), TypeError);
    void ttlSeconds;
});

test('E1 errors and refusals never carry the ticket or the session key; the client keeps nothing', async () => {
    const value = mintLike(REQUEST);
    const needles = [value.ticket, value.ticket.split('.')[2], value.sessionKey];
    const answers = [
        okAnswer({ ...value, extra: 1 }),
        { status: 200, body: Buffer.from(`${JSON.stringify({ ok: true, value })}x`) },
        { status: 502, body: JSON.stringify({ ok: true, value }) }
    ];
    for (const answer of answers) {
        const client = createHelperTicketClient({ transport: routerReturning(answer).transport, now: () => NOW + 1000 });
        let surface;
        try {
            surface = JSON.stringify(await client.mintTicket(REQUEST));
        } catch (error) {
            surface = `${error.message}\n${error.stack}`;
        }
        for (const [index, needle] of needles.entries()) assert.equal(surface.includes(needle), false, `needle ${index}`);
    }
    // The client object exposes only mintTicket and holds no state between calls.
    const client = createHelperTicketClient({ transport: routerReturning(okAnswer(value)).transport, now: () => NOW + 1000 });
    await client.mintTicket(REQUEST);
    assert.deepEqual(Object.keys(client), ['mintTicket']);
    assert.equal(Object.isFrozen(client), true);
});

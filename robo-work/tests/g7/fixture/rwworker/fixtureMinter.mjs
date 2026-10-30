// PROOF-FIXTURE ONLY (slice P6b). Stand-in for the two management functions the live round trip needs and Ploinky does
// not provide yet: the Router helper-ticket mint route (the P4 minter is a library with no route) and the delivery of the
// per-helper-incarnation ticket secret (Ploinky's launch record carries only the journal store identity and the helper
// incarnation). It signs with the PUBLIC SYNTHETIC proof-fixture key that the fixture helper build compiles in
// (`native/crates/target-helper/tests/vectors/session-fixture-v1.json`). A worker holding the signing key departs from
// the authority model (it could mint its own tickets): everything produced with it is proof-fixture evidence only.
//
// It also implements the worker half of the session handshake (T0 amendment A11) (native `session.rs`): the session key the
// Router would hand to the worker with the ticket, and the possession proofs. Ticket shape and claims are exactly T0
// section 8 (`transportContract.mjs` validateHelperTicketClaims accepts every minted ticket; the self-test checks it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalTargetJson, digestOf } from '../../../../server/executionTarget/contract.mjs';

export const SESSION_VECTORS_URL = new URL('../../../../native/crates/target-helper/tests/vectors/session-fixture-v1.json', import.meta.url);
export const SESSION_KEY_INFO = 'ploinky-target-session-v1';
export const PROOF_DOMAIN = Buffer.from('ploinky-target-session-proof-v1\u0000', 'ascii');
export const TICKET_PERMISSIONS = Object.freeze(['commit', 'connect', 'input', 'lookup', 'prepare', 'release', 'renew', 'stop']);
const MAX_LIFETIME_SECONDS = 30;

function canonical(value, maxBytes = 64 * 1024) {
    const result = canonicalTargetJson(value, { maxBytes });
    if (!result.ok) throw new Error(`canonical encoding refused: ${result.error.code}`);
    return result.value;
}

// The PUBLIC SYNTHETIC proof-fixture ticket key {kid, secret}.
export function loadFixtureTicketKey(url = SESSION_VECTORS_URL) {
    const vectors = JSON.parse(fs.readFileSync(url, 'utf8'));
    const secret = Buffer.from(vectors.fixtureTicketKey.secretHex, 'hex');
    if (secret.length !== 32 || typeof vectors.fixtureTicketKey.kid !== 'string') throw new Error('fixture ticket key vector is malformed');
    return Object.freeze({ kid: vectors.fixtureTicketKey.kid, secret });
}

// The LiveScope target/Box projection the audience names (as transportContract.mjs targetIdentityDigest).
export function targetIdentityDigest(scope) {
    return digestOf({
        workspaceId: scope.workspaceId, boxIdentity: scope.boxIdentity, boxGeneration: scope.boxGeneration,
        agentPrincipal: scope.agentPrincipal, containerId: scope.containerId, runtimeInstanceId: scope.runtimeInstanceId,
        enableGeneration: scope.enableGeneration, helperIncarnation: scope.helperIncarnation
    });
}

// K = HKDF-SHA256(ikm = ticket secret, salt = SHA256(canonical claims), info = "ploinky-target-session-v1").
export function sessionKey(secret, claimsCanonical) {
    const salt = crypto.createHash('sha256').update(claimsCanonical, 'utf8').digest();
    return Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(SESSION_KEY_INFO, 'ascii'), 32));
}

// A11.1: the proofs bind the verified lease claim.
export function possessionProof(key, direction, claimsCanonical, helperNonce, challengeId, helperIncarnation, leaseId) {
    const claimsDigest = crypto.createHash('sha256').update(claimsCanonical, 'utf8').digest();
    return crypto.createHmac('sha256', key).update(PROOF_DOMAIN).update(direction, 'ascii').update(Buffer.from([0])).update(claimsDigest)
        .update(helperNonce, 'ascii').update(Buffer.from([0])).update(challengeId, 'ascii').update(Buffer.from([0]))
        .update(helperIncarnation, 'ascii').update(Buffer.from([0])).update(leaseId, 'ascii').digest();
}

// Mints one bootstrap/reattach ticket for `helperNonce`. Returns {ticket, claims, claimsCanonical, sessionKey}.
export function mintFixtureTicket({
    key, binding, reservationId, leaseId, operationId, requestDigest, helperNonce, channelEpoch = '1', previousChannelEpoch = null,
    permissions = ['commit', 'lookup', 'prepare'], nowMs = Date.now(), lifetimeSeconds = MAX_LIFETIME_SECONDS, randomBytes = crypto.randomBytes
}) {
    if (!key || !Buffer.isBuffer(key.secret) || key.secret.length < 32) throw new TypeError('mintFixtureTicket: key is required');
    if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_LIFETIME_SECONDS) throw new TypeError('lifetime');
    const sorted = [...permissions].sort();
    if (sorted.length === 0 || new Set(sorted).size !== sorted.length || !sorted.every((entry) => TICKET_PERMISSIONS.includes(entry))) throw new TypeError('permissions');
    const iat = Math.floor(nowMs / 1000);
    const claims = {
        version: 1, iss: 'ploinky-router', sub: binding.scope.workerPrincipal, purpose: 'ploinky.target-helper.v1',
        aud: `ploinky:target-helper:${targetIdentityDigest(binding.scope)}`, binding, reservationId, leaseId, operationId, requestDigest,
        helperNonce, jti: Buffer.from(randomBytes(32)).toString('base64url'), iat, exp: iat + lifetimeSeconds, channelEpoch,
        previousChannelEpoch, permissions: sorted, limitsDigest: binding.limitsDigest
    };
    const claimsCanonical = canonical(claims);
    const header = canonical({ alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid: key.kid });
    const signingInput = `${Buffer.from(header, 'utf8').toString('base64url')}.${Buffer.from(claimsCanonical, 'utf8').toString('base64url')}`;
    const signature = crypto.createHmac('sha256', key.secret).update(signingInput).digest('base64url');
    return { ticket: `${signingInput}.${signature}`, claims, claimsCanonical, sessionKey: sessionKey(key.secret, claimsCanonical) };
}

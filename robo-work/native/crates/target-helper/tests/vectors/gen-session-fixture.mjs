#!/usr/bin/env node
// Generates session-fixture-v1.json (slice P6b): the PUBLIC SYNTHETIC proof-fixture ticket key and known answers for the
// PROPOSED session handshake (session key and both possession proofs), computed here with node:crypto only (no robo-work
// module), from the canonical claims of the shared transport corpus. `tests/session_fixture.rs` replays them against the
// native `session` module; `robo-work/tests/g7/selftest/rwworker.test.mjs` regenerates the file and requires byte equality.
//
//   node gen-session-fixture.mjs <transport-v1.json> <out.json>
import crypto from 'node:crypto';
import fs from 'node:fs';

const [transportPath, outPath] = process.argv.slice(2);
if (!transportPath || !outPath) {
    process.stderr.write('usage: gen-session-fixture.mjs <transport-v1.json> <out.json>\n');
    process.exit(2);
}
const transport = JSON.parse(fs.readFileSync(transportPath, 'utf8'));
const claimsCanonical = transport.ticket.claimsCanonical;
// ASCII "PUBLIC SYNTHETIC proof-fixture v": public by construction, never a real key.
const fixtureSecret = Buffer.from('PUBLIC SYNTHETIC proof-fixture v', 'ascii');
const kid = 'proof-fixture-helper-ticket-v1';
const info = Buffer.from('ploinky-target-session-v1', 'ascii');
const domain = Buffer.from('ploinky-target-session-proof-v1\u0000', 'ascii');
const challengeId = 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI';
const helperNonce = transport.ticket.claims.helperNonce;
const helperIncarnation = transport.ticket.claims.binding.scope.helperIncarnation;
// A11.1: the proofs bind the verified lease claim.
const leaseId = transport.ticket.claims.leaseId;
if (typeof leaseId !== 'string') throw new Error('transport corpus predates A11.1 (no leaseId claim)');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const sessionKey = (secret) => Buffer.from(crypto.hkdfSync('sha256', secret, sha256(Buffer.from(claimsCanonical, 'utf8')), info, 32));
const proof = (key, direction) => crypto.createHmac('sha256', key).update(domain).update(direction, 'ascii').update(Buffer.from([0]))
    .update(sha256(Buffer.from(claimsCanonical, 'utf8'))).update(helperNonce, 'ascii').update(Buffer.from([0])).update(challengeId, 'ascii')
    .update(Buffer.from([0])).update(helperIncarnation, 'ascii').update(Buffer.from([0])).update(leaseId, 'ascii').digest('hex');

function answers(secret) {
    const key = sessionKey(secret);
    return { sessionKeyHex: key.toString('hex'), workerProofHex: proof(key, 'worker-to-target'), helperProofHex: proof(key, 'target-to-worker') };
}

const header = JSON.stringify({ alg: 'HS256', kid, typ: 'ploinky-target-helper+jwt' });
const signingInput = `${Buffer.from(header, 'utf8').toString('base64url')}.${Buffer.from(claimsCanonical, 'utf8').toString('base64url')}`;
const vectors = {
    version: 1,
    classification: 'PUBLIC SYNTHETIC TEST MATERIAL; the fixture key is public and only valid in a proof-fixture helper build',
    provenance: 'slice P6b session handshake (T0 amendment A11); node:crypto HKDF-SHA256 and HMAC-SHA256 over the transport-v1.json canonical claims',
    fixtureTicketKey: { kid, secretHex: fixtureSecret.toString('hex') },
    inputs: { claimsCanonicalSha256: sha256(Buffer.from(claimsCanonical, 'utf8')).toString('hex'), helperNonce, challengeId, helperIncarnation, leaseId },
    sessionKeyInfo: info.toString('ascii'),
    proofDomainHex: domain.toString('hex'),
    withFixtureKey: { ...answers(fixtureSecret), compactJws: `${signingInput}.${crypto.createHmac('sha256', fixtureSecret).update(signingInput).digest('base64url')}` },
    withTransportKey: answers(Buffer.from(transport.ticket.secretHex, 'hex'))
};
fs.writeFileSync(outPath, `${JSON.stringify(vectors, null, 2)}\n`);

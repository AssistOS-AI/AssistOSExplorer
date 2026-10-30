//! Slice P6b: the native session module against `tests/vectors/session-fixture-v1.json`, which
//! `gen-session-fixture.mjs` computes with node:crypto alone from the shared transport corpus. With the `proof-fixture`
//! feature, the compiled-in fixture ticket key must be exactly the vector's, and a ticket it signs must verify.

mod common;

use rw_target_helper::crypto::{hex, sha256};
use rw_target_helper::session;

fn vectors() -> rw_target_helper::canon::Value {
    common::load(&common::crate_dir().join("tests/vectors/session-fixture-v1.json"))
}

fn transport() -> rw_target_helper::canon::Value {
    common::load(&common::crate_dir().join("tests/vectors/transport-v1.json"))
}

fn check(secret: &[u8], answers: &rw_target_helper::canon::Value) {
    let corpus = transport();
    let ticket = corpus.get("ticket").unwrap();
    let claims = common::text(ticket, "claimsCanonical").as_bytes().to_vec();
    let inputs = vectors().get("inputs").cloned().unwrap();
    assert_eq!(hex(&sha256(&claims)), common::text(&inputs, "claimsCanonicalSha256"));
    let key = session::session_key(secret, &claims);
    assert_eq!(hex(&key), common::text(answers, "sessionKeyHex"));
    let proof = |direction| session::possession_proof(&key, direction, &claims, common::text(&inputs, "helperNonce"), common::text(&inputs, "challengeId"), common::text(&inputs, "helperIncarnation"), common::text(&inputs, "leaseId"));
    assert_eq!(hex(&proof(session::WORKER_TO_TARGET)), common::text(answers, "workerProofHex"));
    assert_eq!(hex(&proof(session::TARGET_TO_WORKER)), common::text(answers, "helperProofHex"));
}

#[test]
fn session_key_and_possession_proofs_match_the_node_vectors() {
    let vectors = vectors();
    assert_eq!(common::text(&vectors, "sessionKeyInfo").as_bytes(), session::SESSION_KEY_INFO);
    assert_eq!(common::unhex(common::text(&vectors, "proofDomainHex")), session::PROOF_DOMAIN);
    let fixture_secret = common::unhex(common::text(vectors.get("fixtureTicketKey").unwrap(), "secretHex"));
    check(&fixture_secret, vectors.get("withFixtureKey").unwrap());
    let transport_secret = common::unhex(common::text(transport().get("ticket").unwrap(), "secretHex"));
    check(&transport_secret, vectors.get("withTransportKey").unwrap());
}

#[test]
fn the_fixture_vector_key_is_public_ascii() {
    let vectors = vectors();
    let secret = common::unhex(common::text(vectors.get("fixtureTicketKey").unwrap(), "secretHex"));
    assert_eq!(secret, b"PUBLIC SYNTHETIC proof-fixture v");
}

#[cfg(feature = "proof-fixture")]
#[test]
fn the_compiled_fixture_key_is_the_vector_key_and_its_ticket_verifies() {
    use rw_target_helper::ticket::{self, ChannelState, Expected, ReplayStore, TicketOptions};
    let vectors = vectors();
    let key = session::proof_fixture::ticket_key();
    let vector_key = vectors.get("fixtureTicketKey").unwrap();
    assert_eq!(key.kid, common::text(vector_key, "kid"));
    assert_eq!(key.secret.expose(), common::unhex(common::text(vector_key, "secretHex")).as_slice());
    let corpus = transport();
    let ticket_vector = corpus.get("ticket").unwrap();
    let claims = ticket_vector.get("claims").unwrap();
    let expected = ticket_vector.get("expected").unwrap();
    let challenge = ticket_vector.get("challenge").unwrap();
    let mut replay = ReplayStore::new();
    let verified = ticket::verify_helper_ticket(
        common::text(vectors.get("withFixtureKey").unwrap(), "compactJws"),
        TicketOptions {
            secret: key.secret.expose(),
            kid: &key.kid,
            binding: claims.get("binding").unwrap(),
            expected: &Expected {
                reservation_id: common::text(expected, "reservationId").into(),
                lease_id: Some(common::text(expected, "leaseId").into()),
                operation_id: common::text(expected, "operationId").into(),
                request_digest: common::text(expected, "requestDigest").into(),
                helper_nonce: common::text(expected, "helperNonce").into(),
            },
            channel: &ChannelState { current_epoch: None, lease_active: true },
            challenge: &ticket::Challenge { id: common::text(challenge, "id").into(), issued_mono_ms: challenge.get("issuedMonoMs").and_then(|value| value.int()).unwrap() },
            now_ms: ticket_vector.get("nowMs").and_then(|value| value.int()).unwrap(),
            now_mono_ms: ticket_vector.get("nowMonoMs").and_then(|value| value.int()).unwrap(),
            clock_uncertainty_ms: 0,
            replay: &mut replay,
            replay_capacity: ticket::TICKET_REPLAY_ENTRIES,
        },
    );
    assert!(verified.is_ok(), "{verified:?}");
}

//! Session handshake between the worker-side peer and the target helper (slice P6b; T0 amendment A11). T0
//! section 8 fixes the ticket and the frame MAC keys but leaves the delivery of the 32-byte session key and its
//! possession proof open ("Fresh 32-byte session-key material travels only over authenticated management hops ... Bind
//! its possession proof to the canonical ticket digest, helper nonce and both management-peer identities").
//!
//! This is the smallest handshake consistent with `transportContract.mjs` and the shared `transport-v1.json` vectors:
//!
//! | Step | Direction | Message |
//! |---|---|---|
//! | 1 | target to worker | `challenge {version, kind, challengeId, helperNonce, helperIncarnation}`: two fresh 32-byte CSPRNG values, issued at accept; the challenge expires after 5 s of monotonic time |
//! | 2 | worker to target | `bootstrap {version, kind, ticket, proof}`: the Router ticket minted for `helperNonce` (its claims name the lease, A11.1) and the worker's possession proof |
//! | 3 | target to worker | `accepted {version, kind, proof}` (the helper's possession proof) or `refused {version, kind, code}`, then close |
//!
//! Session key: `K = HKDF-SHA256(ikm = per-helper-incarnation ticket secret, salt = SHA256(canonical ticket claims),
//! info = "ploinky-target-session-v1")`. The Router derives K when it mints the ticket and hands it to the worker with
//! the ticket over the authenticated Router-to-worker hop; the helper derives it from the same secret after the ticket
//! verified. K is therefore unique per ticket (the claims carry the fresh `jti` and `helperNonce`), never crosses the
//! mailbox, and is never in the JWS, argv, ALA or a persistent record. Proof:
//! `HMAC-SHA256(K, "ploinky-target-session-proof-v1\0" || direction || 0x00 || SHA256(claims) || helperNonce || 0x00 ||
//! challengeId || 0x00 || helperIncarnation || 0x00 || leaseId)`, `direction` being `worker-to-target` (worker proof) or `target-to-worker`
//! (helper proof). Both management-peer identities are bound through the claims digest: `sub` is the worker principal and
//! `aud` names the target identity digest (helper incarnation included). Frame keys are then exactly T0's direction keys
//! from K (`frame::direction_key`). The lease is the verified claim `leaseId`; the helper keys channel epochs and session
//! state only on it (A11.1). A ticket's epoch must be strictly greater than the epoch held for its lease, and the helper
//! records the new epoch only after `accepted` was sent (A11.2). Departures from T0 section 8 are recorded in A11.5.
//!
//! Handshake messages use the frame length prefix and nothing else: `u32be(length) canonicalJsonUtf8`, at most
//! [`HANDSHAKE_BYTES`], never with descriptors. They are not frames: no frame is accepted before `accepted`.

use crate::Code;
use crate::canon::{self, Value, obj, s};
use crate::contract::{is_id_text, is_nonce};
use crate::crypto::{Secret, b64url_decode, b64url_encode, ct_eq, hkdf_sha256_32, hmac_sha256, sha256};

pub const SESSION_KEY_INFO: &[u8] = b"ploinky-target-session-v1";
pub const PROOF_DOMAIN: &[u8] = b"ploinky-target-session-proof-v1\0";
pub const WORKER_TO_TARGET: &str = "worker-to-target";
pub const TARGET_TO_WORKER: &str = "target-to-worker";
/// A ticket is at most 65536 characters; the rest of a bootstrap message is small.
pub const HANDSHAKE_BYTES: usize = 128 * 1024;

/// The ticket verification key of one helper incarnation.
#[derive(Clone, Debug)]
pub struct TicketKey {
    pub kid: String,
    pub secret: Secret,
}

/// PUBLIC SYNTHETIC proof-fixture ticket key (feature `proof-fixture` only). Ploinky provisioning delivers the
/// per-helper-incarnation ticket secret to the helper (`crate::launch`), but registers no mint route yet, so a
/// proof-fixture run (`serve --proof-fixture-session`) shares this compile-time key between the fixture helper and the
/// worker-side fixture minter instead. A worker that holds the signing key departs from the authority
/// model (it could mint its own tickets): evidence produced with it is proof-fixture evidence only. The same bytes are in
/// `tests/vectors/session-fixture-v1.json` (checked by `tests/session_fixture.rs`).
#[cfg(feature = "proof-fixture")]
pub mod proof_fixture {
    pub const KID: &str = "proof-fixture-helper-ticket-v1";
    /// ASCII "PUBLIC SYNTHETIC proof-fixture v".
    pub const SECRET_HEX: &str = "5055424c49432053594e5448455449432070726f6f662d666978747572652076";

    pub fn ticket_key() -> super::TicketKey {
        let secret = crate::crypto::unhex(SECRET_HEX).unwrap_or_default();
        super::TicketKey { kid: KID.to_string(), secret: crate::crypto::Secret::new(secret) }
    }
}

fn need(condition: bool, code: Code) -> Result<(), Code> {
    if condition { Ok(()) } else { Err(code) }
}

/// The session key the Router hands to the worker and the helper derives after verifying the ticket.
pub fn session_key(ticket_secret: &[u8], claims_canonical: &[u8]) -> [u8; 32] {
    hkdf_sha256_32(ticket_secret, &sha256(claims_canonical), SESSION_KEY_INFO)
}

/// One possession proof (see the module documentation).
pub fn possession_proof(session_key: &[u8], direction: &str, claims_canonical: &[u8], helper_nonce: &str, challenge_id: &str, helper_incarnation: &str, lease_id: &str) -> [u8; 32] {
    let claims_digest = sha256(claims_canonical);
    hmac_sha256(
        session_key,
        &[
            PROOF_DOMAIN,
            direction.as_bytes(),
            b"\0",
            &claims_digest,
            helper_nonce.as_bytes(),
            b"\0",
            challenge_id.as_bytes(),
            b"\0",
            helper_incarnation.as_bytes(),
            b"\0",
            lease_id.as_bytes(),
        ],
    )
}

/// Constant-time check of a received base64url proof.
pub fn proof_matches(expected: &[u8; 32], received: &str) -> bool {
    match b64url_decode(received) {
        Some(bytes) => ct_eq(&bytes, expected),
        None => false,
    }
}

/// `u32be(length) canonicalJsonUtf8`.
pub fn encode_message(value: &Value) -> Result<Vec<u8>, Code> {
    let text = canon::canonical(value, HANDSHAKE_BYTES - 4)?;
    let mut out = Vec::with_capacity(4 + text.len());
    out.extend_from_slice(&(text.len() as u32).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    Ok(out)
}

/// Parses one received handshake message (the bytes include the length prefix). Descriptors are never accepted.
pub fn decode_message(bytes: &[u8], descriptors: usize) -> Result<Value, Code> {
    need(descriptors == 0, Code::DescriptorCount)?;
    need(bytes.len() >= 4 && bytes.len() <= HANDSHAKE_BYTES, Code::FrameLayout)?;
    let length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    need(length == bytes.len() - 4, Code::FrameLayout)?;
    let value = canon::parse_canonical(&bytes[4..], HANDSHAKE_BYTES)?;
    need(value.is_obj(), Code::InvalidRequest)?;
    need(value.get("version") == Some(&Value::Int(1)), Code::UnsupportedVersion)?;
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChallengeMessage {
    pub challenge_id: String,
    pub helper_nonce: String,
    pub helper_incarnation: String,
}

impl ChallengeMessage {
    pub fn to_value(&self) -> Value {
        obj(vec![
            ("version", Value::Int(1)),
            ("kind", s("challenge")),
            ("challengeId", s(&self.challenge_id)),
            ("helperNonce", s(&self.helper_nonce)),
            ("helperIncarnation", s(&self.helper_incarnation)),
        ])
    }

    pub fn parse(value: &Value) -> Result<ChallengeMessage, Code> {
        need(value.has_exact_keys(&["version", "kind", "challengeId", "helperNonce", "helperIncarnation"]) && value.str_at("kind") == Some("challenge"), Code::InvalidRequest)?;
        let field = |key: &str| value.get(key).cloned().unwrap_or(Value::Null);
        need(is_nonce(&field("challengeId")) && is_nonce(&field("helperNonce")), Code::InvalidRequest)?;
        let incarnation = value.str_at("helperIncarnation").unwrap_or_default();
        need(is_id_text(incarnation), Code::InvalidRequest)?;
        Ok(ChallengeMessage {
            challenge_id: value.str_at("challengeId").unwrap_or_default().to_string(),
            helper_nonce: value.str_at("helperNonce").unwrap_or_default().to_string(),
            helper_incarnation: incarnation.to_string(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootstrapMessage {
    pub ticket: String,
    pub proof: String,
}

impl BootstrapMessage {
    pub fn to_value(&self) -> Value {
        obj(vec![("version", Value::Int(1)), ("kind", s("bootstrap")), ("ticket", s(&self.ticket)), ("proof", s(&self.proof))])
    }

    pub fn parse(value: &Value) -> Result<BootstrapMessage, Code> {
        need(value.has_exact_keys(&["version", "kind", "ticket", "proof"]) && value.str_at("kind") == Some("bootstrap"), Code::InvalidRequest)?;
        let (Some(ticket), Some(proof)) = (value.str_at("ticket"), value.str_at("proof")) else {
            return Err(Code::InvalidRequest);
        };
        need(proof.len() == 43, Code::InvalidRequest)?;
        Ok(BootstrapMessage { ticket: ticket.to_string(), proof: proof.to_string() })
    }
}

pub fn accepted_message(proof: &[u8; 32]) -> Value {
    obj(vec![("version", Value::Int(1)), ("kind", s("accepted")), ("proof", s(&b64url_encode(proof)))])
}

pub fn refused_message(code: Code) -> Value {
    obj(vec![("version", Value::Int(1)), ("kind", s("refused")), ("code", s(code.as_str()))])
}

/// The canonical claim bytes of a compact ticket, without verifying it (the worker side needs them for the HKDF salt and
/// the frame header; the helper trusts claims only after `ticket::verify_helper_ticket`).
pub fn unverified_claims(ticket: &str) -> Result<(Vec<u8>, Value), Code> {
    let parts: Vec<&str> = ticket.split('.').collect();
    need(parts.len() == 3, Code::TicketFormat)?;
    let bytes = b64url_decode(parts[1]).ok_or(Code::TicketFormat)?;
    let claims = canon::parse_canonical(&bytes, canon::OBJECT_BYTES).map_err(|code| if code == Code::NoncanonicalEncoding { code } else { Code::TicketFormat })?;
    need(claims.is_obj(), Code::TicketFormat)?;
    Ok((bytes, claims))
}

/// A fresh 32-byte value from the kernel CSPRNG as canonical base64url.
pub fn random_nonce() -> Result<String, Code> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut random| random.read_exact(&mut bytes)).map_err(|_| Code::StateCorrupt)?;
    Ok(b64url_encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip_and_refuse_descriptors_or_bad_layout() {
        let challenge = ChallengeMessage {
            challenge_id: "ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE".into(),
            helper_nonce: "ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA".into(),
            helper_incarnation: "AgICAgICAgICAgICAgICAg".into(),
        };
        let bytes = encode_message(&challenge.to_value()).unwrap();
        let value = decode_message(&bytes, 0).unwrap();
        assert_eq!(ChallengeMessage::parse(&value).unwrap(), challenge);
        assert_eq!(decode_message(&bytes, 1), Err(Code::DescriptorCount));
        let mut short = bytes.clone();
        short.pop();
        assert_eq!(decode_message(&short, 0), Err(Code::FrameLayout));
        assert!(BootstrapMessage::parse(&value).is_err(), "a challenge is not a bootstrap");
    }

    #[test]
    fn proofs_are_direction_and_input_separated() {
        let key = [7u8; 32];
        let base = possession_proof(&key, WORKER_TO_TARGET, b"{}", "n", "c", "i", "l");
        assert_ne!(base, possession_proof(&key, TARGET_TO_WORKER, b"{}", "n", "c", "i", "l"));
        assert_ne!(base, possession_proof(&key, WORKER_TO_TARGET, b"{ }", "n", "c", "i", "l"));
        assert_ne!(base, possession_proof(&key, WORKER_TO_TARGET, b"{}", "m", "c", "i", "l"));
        assert_ne!(base, possession_proof(&key, WORKER_TO_TARGET, b"{}", "n", "d", "i", "l"));
        assert_ne!(base, possession_proof(&key, WORKER_TO_TARGET, b"{}", "n", "c", "j", "l"));
        assert_ne!(base, possession_proof(&key, WORKER_TO_TARGET, b"{}", "n", "c", "i", "m"), "the lease is bound");
        assert_ne!(base, possession_proof(&[8u8; 32], WORKER_TO_TARGET, b"{}", "n", "c", "i", "l"));
        assert!(proof_matches(&base, &b64url_encode(&base)));
        assert!(!proof_matches(&base, &b64url_encode(&[0u8; 32])));
        assert!(!proof_matches(&base, "not base64url!"));
    }
}

//! PUBLIC SYNTHETIC known answers for T0 section 8 / A1.7 (`tests/vectors/transport-v1.json`, a byte copy of
//! `robo-work/tests/executionTarget/fixtures/transport-v1.json`), ported from `transportVectors.test.mjs` and extended
//! with the encoder and further refusal cases. The corpus pins independently calculated bytes; nothing here regenerates
//! the expected values.

mod common;

use common::{load, text, unhex};
use rw_target_helper::Code;
use rw_target_helper::canon::{self, Value};
use rw_target_helper::crypto::{b64url_encode, hex, hkdf_extract, hmac_sha256, sha256_hex};
use rw_target_helper::frame::{self, Ancillary, ExpectedIds, FrameLimits, FrameState};
use rw_target_helper::ticket::{self, ChannelState, Challenge, Expected, ReplayStore, TicketOptions};

/// Order-insensitive comparison form: canonical text.
fn c(result: Result<Value, Code>) -> Result<String, Code> {
    result.map(|value| canon::canonical_text(&value).unwrap())
}

fn vectors() -> Value {
    load(&common::crate_dir().join("tests/vectors/transport-v1.json"))
}

#[test]
fn native_copy_is_byte_identical_to_the_shared_fixture() {
    let copy = std::fs::read(common::crate_dir().join("tests/vectors/transport-v1.json")).unwrap();
    let source_path = common::robo_work_dir().join("tests/executionTarget/fixtures/transport-v1.json");
    let source = std::fs::read(&source_path).unwrap_or_else(|error| panic!("the shared fixture must be present ({}): {error}", source_path.display()));
    assert_eq!(sha256_hex(&copy), sha256_hex(&source));
    assert_eq!(sha256_hex(&copy), "1d03e192fd459b9ab0c1d069212adb5f124b2c033d1949ee8d51b7c6ca2a55c7");
}

#[test]
fn corpus_pins_target_identity_projection_canonical_claims_and_raw_salt() {
    let v = vectors();
    assert_eq!(v.get("version"), Some(&Value::Int(1)));
    let identity = v.get("targetIdentity").unwrap();
    let ticket = v.get("ticket").unwrap();
    let claims = ticket.get("claims").unwrap();
    let binding = claims.get("binding").unwrap();
    let keys: Vec<&str> = identity.get("projectionKeys").unwrap().arr().unwrap().iter().map(|key| key.str().unwrap()).collect();
    assert_eq!(keys, ["agentPrincipal", "boxGeneration", "boxIdentity", "containerId", "enableGeneration", "helperIncarnation", "runtimeInstanceId", "workspaceId"]);
    for (value, canonical, digest) in [
        (identity.get("projection").unwrap(), text(identity, "canonicalJson"), text(identity, "sha256")),
        (binding, text(&v, "bindingCanonical"), text(&v, "bindingDigest")),
        (claims, text(ticket, "claimsCanonical"), text(ticket, "claimsDigest")),
    ] {
        assert_eq!(canon::canonical_text(value).unwrap(), canonical);
        assert_eq!(canon::digest_of(value).unwrap(), digest);
        assert_eq!(canon::canonical_text(&canon::parse_canonical(canonical.as_bytes(), canon::OBJECT_BYTES).unwrap()).unwrap(), canonical);
    }
    assert_eq!(rw_target_helper::contract::target_identity_digest(binding.get("scope").unwrap()).unwrap(), text(identity, "sha256"));
    assert_eq!(text(claims, "aud"), format!("ploinky:target-helper:{}", text(identity, "sha256")));
    assert_eq!(text(ticket, "hkdfSaltHex"), text(ticket, "claimsDigest"));
    assert_eq!(rw_target_helper::contract::validate_target_binding(binding), Ok(()));
}

struct TicketFixture {
    secret: Vec<u8>,
    kid: String,
    binding: Value,
    expected: Expected,
    challenge: Challenge,
    now_ms: i64,
    now_mono_ms: i64,
    header_canonical: String,
}

fn ticket_fixture(v: &Value) -> TicketFixture {
    let ticket = v.get("ticket").unwrap();
    let expected = ticket.get("expected").unwrap();
    let challenge = ticket.get("challenge").unwrap();
    TicketFixture {
        secret: unhex(text(ticket, "secretHex")),
        kid: text(ticket.get("header").unwrap(), "kid").to_string(),
        binding: ticket.get("claims").unwrap().get("binding").unwrap().clone(),
        expected: Expected {
            reservation_id: text(expected, "reservationId").into(),
            lease_id: Some(text(expected, "leaseId").into()),
            operation_id: text(expected, "operationId").into(),
            request_digest: text(expected, "requestDigest").into(),
            helper_nonce: text(expected, "helperNonce").into(),
        },
        challenge: Challenge { id: text(challenge, "id").into(), issued_mono_ms: challenge.get("issuedMonoMs").unwrap().int().unwrap() },
        now_ms: ticket.get("nowMs").unwrap().int().unwrap(),
        now_mono_ms: ticket.get("nowMonoMs").unwrap().int().unwrap(),
        header_canonical: text(ticket, "headerCanonical").into(),
    }
}

fn verify(fixture: &TicketFixture, token: &str, binding: &Value, channel: &ChannelState, replay: &mut ReplayStore) -> Result<Value, Code> {
    verify_at(fixture, token, binding, channel, replay, fixture.now_ms, fixture.now_mono_ms, ticket::TICKET_REPLAY_ENTRIES)
}

#[allow(clippy::too_many_arguments)]
fn verify_at(fixture: &TicketFixture, token: &str, binding: &Value, channel: &ChannelState, replay: &mut ReplayStore, now_ms: i64, now_mono_ms: i64, capacity: usize) -> Result<Value, Code> {
    ticket::verify_helper_ticket(token, TicketOptions {
        secret: &fixture.secret,
        kid: &fixture.kid,
        binding,
        expected: &fixture.expected,
        channel,
        challenge: &fixture.challenge,
        now_ms,
        now_mono_ms,
        clock_uncertainty_ms: 0,
        replay,
        replay_capacity: capacity,
    })
}

fn first_bootstrap() -> ChannelState {
    ChannelState { current_epoch: None, lease_active: true }
}

fn sign(fixture: &TicketFixture, claims_canonical: &str) -> String {
    ticket::sign_ticket_for_tests(&fixture.secret, &fixture.header_canonical, claims_canonical)
}

fn claims(v: &Value) -> Value {
    v.get("ticket").unwrap().get("claims").unwrap().clone()
}

#[test]
fn literal_hs256_compact_jws_validates_and_replay_signature_and_canonical_mutations_refuse() {
    let v = vectors();
    let fixture = ticket_fixture(&v);
    let ticket = v.get("ticket").unwrap();
    assert_eq!(canon::canonical_text(ticket.get("header").unwrap()).unwrap(), fixture.header_canonical);
    let signing_input = format!("{}.{}", b64url_encode(fixture.header_canonical.as_bytes()), b64url_encode(text(ticket, "claimsCanonical").as_bytes()));
    assert_eq!(signing_input, text(ticket, "signingInput"));
    assert_eq!(hex(&hmac_sha256(&fixture.secret, &[signing_input.as_bytes()])), text(ticket, "signatureHex"));
    assert_eq!(format!("{signing_input}.{}", b64url_encode(&unhex(text(ticket, "signatureHex")))), text(ticket, "compactJws"));
    let jws = text(ticket, "compactJws");
    let mut replay = ReplayStore::new();
    assert_eq!(c(verify(&fixture, jws, &fixture.binding, &first_bootstrap(), &mut replay)), c(Ok(claims(&v))));
    assert_eq!(replay.len(), 2);
    assert_eq!(verify(&fixture, jws, &fixture.binding, &first_bootstrap(), &mut replay), Err(Code::TicketReplayed));
    let mut fresh = ReplayStore::new();
    let mut signature = unhex(text(ticket, "signatureHex"));
    signature[0] ^= 1;
    assert_eq!(verify(&fixture, &format!("{signing_input}.{}", b64url_encode(&signature)), &fixture.binding, &first_bootstrap(), &mut fresh), Err(Code::TicketSignature));
    assert_eq!(verify(&fixture, &sign(&fixture, &format!(" {}", text(ticket, "claimsCanonical"))), &fixture.binding, &first_bootstrap(), &mut fresh), Err(Code::NoncanonicalEncoding));
    assert!(fresh.is_empty(), "refusals do not consume replay capacity");
}

#[test]
fn ticket_audience_includes_each_target_box_key_and_excludes_every_worker_scope_key() {
    let v = vectors();
    let fixture = ticket_fixture(&v);
    let projection = ["agentPrincipal", "boxGeneration", "boxIdentity", "containerId", "enableGeneration", "helperIncarnation", "runtimeInstanceId", "workspaceId"];
    let scope_keys: Vec<String> = fixture.binding.get("scope").unwrap().obj().unwrap().iter().map(|(key, _)| key.clone()).collect();
    assert_eq!(scope_keys.len(), 12);
    for key in &scope_keys {
        let mut changed = claims(&v);
        let mut binding = changed.get("binding").unwrap().clone();
        let mut scope = binding.get("scope").unwrap().clone();
        let original = text(&scope, key).to_string();
        let replacement = match key.as_str() {
            "helperIncarnation" | "workerGeneration" => b64url_encode(&[99u8; 16]),
            "containerId" => "d".repeat(64),
            _ => format!("{original}-changed"),
        };
        scope.set(key, Value::Str(replacement.clone()));
        binding.set("scope", scope);
        changed.set("binding", binding.clone());
        if key == "workerPrincipal" {
            changed.set("sub", Value::Str(replacement));
        }
        let token = sign(&fixture, &canon::canonical_text(&changed).unwrap());
        let result = verify(&fixture, &token, &binding, &first_bootstrap(), &mut ReplayStore::new());
        if projection.contains(&key.as_str()) {
            assert_eq!(result, Err(Code::TicketBinding), "{key}");
        } else {
            assert_eq!(c(result), c(Ok(changed)), "{key}");
        }
    }
}

#[test]
fn ticket_refusal_order_and_codes() {
    let v = vectors();
    let fixture = ticket_fixture(&v);
    let base = claims(&v);
    let sign_with = |mutate: &dyn Fn(&mut Value)| {
        let mut changed = base.clone();
        mutate(&mut changed);
        sign(&fixture, &canon::canonical_text(&changed).unwrap())
    };
    let check = |token: &str| verify(&fixture, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new());
    // Lifetime: 31 s, expiry at now (no extension), issuance 3 s in the future.
    assert_eq!(check(&sign_with(&|c| c.set("exp", Value::Int(1_800_000_031)))), Err(Code::TicketLifetime));
    let token = text(v.get("ticket").unwrap(), "compactJws");
    assert_eq!(verify_at(&fixture, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new(), 1_800_000_030_000, 101, 32768), Err(Code::TicketLifetime));
    assert_eq!(verify_at(&fixture, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new(), 1_799_999_997_999, 101, 32768), Err(Code::TicketLifetime));
    assert!(verify_at(&fixture, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new(), 1_799_999_998_000, 101, 32768).is_ok());
    // The monotonic challenge expires after 5 s whatever the wall clock says.
    assert_eq!(verify_at(&fixture, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new(), 1_800_000_001_000, 5100, 32768), Err(Code::TicketLifetime));
    assert!(verify_at(&fixture, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new(), 1_800_000_001_000, 5099, 32768).is_ok());
    // Purpose, version and keys.
    assert_eq!(check(&sign_with(&|c| c.set("purpose", Value::Str("ploinky.coordinator".into())))), Err(Code::TicketPurpose));
    assert_eq!(check(&sign_with(&|c| c.set("iss", Value::Str("other".into())))), Err(Code::TicketPurpose));
    assert_eq!(check(&sign_with(&|c| c.set("version", Value::Int(2)))), Err(Code::UnsupportedVersion));
    assert_eq!(check(&sign_with(&|c| c.set("extra", Value::Null))), Err(Code::TicketFormat));
    // Permissions: unsorted, duplicate, unknown, empty.
    for permissions in [vec!["stop", "commit"], vec!["commit", "commit"], vec!["admin"], vec![]] {
        let list = Value::Arr(permissions.iter().map(|entry| Value::Str(entry.to_string())).collect());
        assert_eq!(check(&sign_with(&|c| c.set("permissions", list.clone()))), Err(Code::TicketFormat), "{permissions:?}");
    }
    assert!(check(&sign_with(&|c| c.set("permissions", Value::Arr(vec![Value::Str("lookup".into())])))).is_ok());
    // Nonces must be canonical 43-character base64url of 32 bytes.
    assert_eq!(check(&sign_with(&|c| c.set("jti", Value::Str("AQ".into())))), Err(Code::TicketFormat));
    // Binding: widened reservation, other operation, other nonce, other limits.
    assert_eq!(check(&sign_with(&|c| c.set("reservationId", Value::Str(b64url_encode(&[9u8; 16]))))), Err(Code::TicketBinding));
    assert_eq!(check(&sign_with(&|c| c.set("helperNonce", Value::Str(b64url_encode(&[7u8; 32]))))), Err(Code::TicketBinding));
    assert_eq!(check(&sign_with(&|c| c.set("limitsDigest", Value::Str("f".repeat(64))))), Err(Code::TicketBinding));
    // A11.1: the lease is a required claim; another lease is not the expected one.
    assert_eq!(check(&sign_with(&|c| c.set("leaseId", Value::Str(b64url_encode(&[5u8; 16]))))), Err(Code::TicketBinding));
    assert_eq!(check(&sign_with(&|c| c.set("leaseId", Value::Str("short".into())))), Err(Code::TicketFormat));
    // A11.2 epochs: any positive epoch on first use, previous (when present) below it; then strictly greater than the
    // held epoch; a retired lease never reopens.
    assert!(check(&sign_with(&|c| c.set("channelEpoch", Value::Str("2".into())))).is_ok(), "first use need not be 1");
    assert_eq!(
        check(&sign_with(&|c| {
            c.set("channelEpoch", Value::Str("2".into()));
            c.set("previousChannelEpoch", Value::Str("2".into()));
        })),
        Err(Code::ChannelEpochConflict)
    );
    let reattach = sign_with(&|c| {
        c.set("channelEpoch", Value::Str("4".into()));
        c.set("previousChannelEpoch", Value::Str("3".into()));
    });
    let current = |epoch: &str| ChannelState { current_epoch: Some(epoch.into()), lease_active: true };
    assert!(verify(&fixture, &reattach, &fixture.binding, &current("3"), &mut ReplayStore::new()).is_ok());
    assert!(verify(&fixture, &reattach, &fixture.binding, &current("2"), &mut ReplayStore::new()).is_ok(), "a skipped epoch (lost accepted) is fine");
    assert_eq!(verify(&fixture, &reattach, &fixture.binding, &current("4"), &mut ReplayStore::new()), Err(Code::ChannelEpochConflict), "equal");
    assert_eq!(verify(&fixture, &reattach, &fixture.binding, &current("5"), &mut ReplayStore::new()), Err(Code::ChannelEpochConflict), "older");
    let retired = ChannelState { current_epoch: Some("3".into()), lease_active: false };
    assert_eq!(verify(&fixture, &reattach, &fixture.binding, &retired, &mut ReplayStore::new()), Err(Code::LeaseRetired));
    // Header: another algorithm, another token type, an extra key, another kid; malformed compact forms.
    let header = |text: &str| {
        let input = format!("{}.{}", b64url_encode(text.as_bytes()), b64url_encode(canon::canonical_text(&base).unwrap().as_bytes()));
        format!("{input}.{}", b64url_encode(&hmac_sha256(&fixture.secret, &[input.as_bytes()])))
    };
    assert_eq!(check(&header(r#"{"alg":"none","kid":"public-synthetic-helper-key","typ":"ploinky-target-helper+jwt"}"#)), Err(Code::TicketAlgorithm));
    assert_eq!(check(&header(r#"{"alg":"HS256","kid":"public-synthetic-helper-key","typ":"ploinky-coordinator+jwt"}"#)), Err(Code::TicketPurpose));
    assert_eq!(check(&header(r#"{"alg":"HS256","kid":"public-synthetic-helper-key","typ":"ploinky-target-helper+jwt","x":1}"#)), Err(Code::TicketFormat));
    assert_eq!(check(&header(r#"{"alg":"HS256","kid":"other-key","typ":"ploinky-target-helper+jwt"}"#)), Err(Code::TicketSignature));
    for malformed in ["", "a.b", "a.b.c.d", "a=.b.c", "!.b.c"] {
        assert_eq!(check(malformed), Err(Code::TicketFormat), "{malformed:?}");
    }
    // A short secret is a caller error.
    let mut short = ticket_fixture(&v);
    short.secret.truncate(31);
    assert_eq!(verify(&short, token, &fixture.binding, &first_bootstrap(), &mut ReplayStore::new()), Err(Code::InvalidRequest));
}

#[test]
fn replay_capacity_sweeps_expired_entries_and_never_evicts_live_ones() {
    let v = vectors();
    let fixture = ticket_fixture(&v);
    let token = text(v.get("ticket").unwrap(), "compactJws");
    let mut replay = ReplayStore::new();
    // Capacity 3 with 2 entries per ticket: the first accept fills 2; another live ticket cannot fit.
    assert!(verify_at(&fixture, token, &fixture.binding, &first_bootstrap(), &mut replay, fixture.now_ms, fixture.now_mono_ms, 3).is_ok());
    let base = claims(&v);
    let mut second = base.clone();
    second.set("jti", Value::Str(b64url_encode(&[0x42; 32])));
    let second_token = sign(&fixture, &canon::canonical_text(&second).unwrap());
    let other_challenge = TicketFixture { challenge: Challenge { id: "second-challenge".into(), issued_mono_ms: 100 }, ..ticket_fixture(&v) };
    assert_eq!(verify_at(&other_challenge, &second_token, &fixture.binding, &first_bootstrap(), &mut replay, fixture.now_ms, fixture.now_mono_ms, 3), Err(Code::CapacityExceeded));
    assert_eq!(replay.len(), 2);
}

fn frame_state<'a>(v: &'a Value, vector: &'a Value, session_key: &'a [u8], claims_canonical: &'a [u8], expected: &'a ExpectedIds) -> FrameState<'a> {
    FrameState {
        direction: text(vector, "direction"),
        session_key,
        claims_canonical,
        binding: v.get("ticket").unwrap().get("claims").unwrap().get("binding").unwrap(),
        expected,
        channel_epoch: "1",
        next_sequence: "1",
        lease_active: true,
        ancillary: Ancillary { count: 0, truncated: false, well_formed: true, on_first_byte: true },
        channel_manifest: None,
        limits: FrameLimits::default(),
    }
}

fn expected_ids(v: &Value, vector: &Value) -> ExpectedIds {
    let expected = v.get("ticket").unwrap().get("expected").unwrap();
    ExpectedIds {
        lease_id: text(vector.get("header").unwrap(), "leaseId").into(),
        reservation_id: text(expected, "reservationId").into(),
        operation_id: text(expected, "operationId").into(),
        request_digest: text(expected, "requestDigest").into(),
    }
}

#[test]
fn both_directions_fixed_hkdf_key_mac_input_encoder_bytes_and_validation() {
    let v = vectors();
    let ticket = v.get("ticket").unwrap();
    let session_key = unhex(text(&v, "sessionKeyHex"));
    let claims_canonical = text(ticket, "claimsCanonical").as_bytes().to_vec();
    let salt = unhex(text(ticket, "hkdfSaltHex"));
    assert_eq!(salt.len(), 32, "salt is raw digest bytes, not 64 ASCII hex bytes");
    assert_eq!(hex(&hkdf_extract(&salt, &session_key)), text(&v, "hkdfExtractHex"));
    assert_eq!(unhex(text(&v, "frameMacDomainHex")), frame::FRAME_MAC_DOMAIN);
    let frames = v.get("frames").unwrap().arr().unwrap();
    assert_eq!(frames.len(), 2);
    for vector in frames {
        let direction = text(vector, "direction");
        assert_eq!(hex(&frame::direction_key(&session_key, &claims_canonical, direction)), text(vector, "keyHex"), "{direction}");
        let header = vector.get("header").unwrap();
        assert_eq!(canon::canonical_text(header).unwrap(), text(vector, "headerCanonical"));
        let body = unhex(text(vector, "bodyHex"));
        let encoded = unhex(text(vector, "encodedHex"));
        let prefix = unhex(text(vector, "prefixHex"));
        assert_eq!(&encoded[..8], &prefix[..]);
        let mac_input = [frame::FRAME_MAC_DOMAIN, &prefix, text(vector, "headerCanonical").as_bytes(), &body].concat();
        assert_eq!(hex(&mac_input), text(vector, "macInputHex"));
        assert_eq!(hex(&hmac_sha256(&unhex(text(vector, "keyHex")), &[&mac_input])), text(vector, "macHex"));
        // The encoder reproduces the frame byte for byte from the header fields and body.
        let mut fields = header.clone();
        if let Value::Obj(entries) = &mut fields {
            entries.retain(|(key, _)| key != "bodyBytes" && key != "bodyDigest");
        }
        assert_eq!(frame::encode_frame(&fields, &body, &session_key, &claims_canonical, FrameLimits::default()).unwrap(), encoded, "{direction}");
        let expected = expected_ids(&v, vector);
        let state = frame_state(&v, vector, &session_key, &claims_canonical, &expected);
        let accepted = frame::validate_target_frame(&encoded, &state).unwrap();
        assert_eq!(canon::canonical_text(&accepted.header).unwrap(), canon::canonical_text(header).unwrap());
        assert_eq!(accepted.body_offset, 8 + vector.get("headerBytes").unwrap().int().unwrap() as usize);
        assert_eq!(accepted.body_length, body.len());
        assert_eq!(accepted.next_sequence, "2");
        assert_eq!(&encoded[accepted.body_offset..accepted.body_offset + accepted.body_length], &body[..]);
    }
}

#[test]
fn every_flipped_byte_wrong_keys_sequence_epoch_and_claims_refuse() {
    let v = vectors();
    let ticket = v.get("ticket").unwrap();
    let session_key = unhex(text(&v, "sessionKeyHex"));
    let claims_canonical = text(ticket, "claimsCanonical").as_bytes().to_vec();
    let frames = v.get("frames").unwrap().arr().unwrap();
    for vector in frames {
        let direction = text(vector, "direction");
        let encoded = unhex(text(vector, "encodedHex"));
        let expected = expected_ids(&v, vector);
        let state = frame_state(&v, vector, &session_key, &claims_canonical, &expected);
        for offset in 0..encoded.len() {
            let mut changed = encoded.clone();
            changed[offset] ^= 1;
            let result = frame::validate_target_frame(&changed, &state);
            assert!(matches!(result, Err(Code::FrameLayout | Code::CapacityExceeded | Code::FrameAuthentication)), "{direction} byte {offset}: {result:?}");
        }
        let other = frames.iter().find(|entry| text(entry, "direction") != direction).unwrap();
        let ascii_salt_key = rw_target_helper::crypto::hkdf_sha256_32(&session_key, text(ticket, "claimsDigest").as_bytes(), direction.as_bytes());
        let mac_input = unhex(text(vector, "macInputHex"));
        for key in [unhex(text(other, "keyHex")), ascii_salt_key.to_vec()] {
            assert_ne!(hex(&key), text(vector, "keyHex"));
            let mut wrong = encoded[..encoded.len() - 32].to_vec();
            wrong.extend_from_slice(&hmac_sha256(&key, &[&mac_input]));
            assert_eq!(frame::validate_target_frame(&wrong, &state), Err(Code::FrameAuthentication));
        }
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { next_sequence: "2", ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::FrameSequence));
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { channel_epoch: "2", ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::FrameBinding));
        let newline = [claims_canonical.clone(), b"\n".to_vec()].concat();
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { claims_canonical: &newline, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::FrameAuthentication));
        // The receiver's own direction: a frame for the other direction does not authenticate under this key.
        let reversed = text(other, "direction");
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { direction: reversed, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::FrameAuthentication));
        // A retired lease refuses after authentication; descriptors on a data frame or on a later byte refuse.
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { lease_active: false, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::LeaseRetired));
        for ancillary in [
            Ancillary { count: 1, truncated: false, well_formed: true, on_first_byte: true },
            Ancillary { count: 1, truncated: false, well_formed: true, on_first_byte: false },
            Ancillary { count: 0, truncated: true, well_formed: true, on_first_byte: true },
            Ancillary { count: 0, truncated: false, well_formed: false, on_first_byte: true },
        ] {
            assert_eq!(frame::validate_target_frame(&encoded, &FrameState { ancillary, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::DescriptorCount), "{ancillary:?}");
        }
        // Another expected lease or operation is a binding refusal.
        let other_lease = ExpectedIds { lease_id: b64url_encode(&[3u8; 16]), ..expected_ids(&v, vector) };
        assert_eq!(frame::validate_target_frame(&encoded, &frame_state(&v, vector, &session_key, &claims_canonical, &other_lease)), Err(Code::FrameBinding));
        // Frame bounds: a lower admitted frameBytes, a lower headerBytes.
        let tight = FrameLimits { frame_bytes: encoded.len() - 1, ..FrameLimits::default() };
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { limits: tight, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::CapacityExceeded));
        let header_tight = FrameLimits { header_bytes: 100, ..FrameLimits::default() };
        assert_eq!(frame::validate_target_frame(&encoded, &FrameState { limits: header_tight, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) }), Err(Code::CapacityExceeded));
    }
}

/// Frames the corpus does not contain, built with the encoder: descriptor manifests, open frames and body bounds.
#[test]
fn encoded_descriptor_open_and_body_bound_frames() {
    let v = vectors();
    let ticket = v.get("ticket").unwrap();
    let session_key = unhex(text(&v, "sessionKeyHex"));
    let claims_canonical = text(ticket, "claimsCanonical").as_bytes().to_vec();
    let vector = &v.get("frames").unwrap().arr().unwrap()[0];
    let expected = expected_ids(&v, vector);
    let mut fields = vector.get("header").unwrap().clone();
    if let Value::Obj(entries) = &mut fields {
        entries.retain(|(key, _)| key != "bodyBytes" && key != "bodyDigest");
    }
    let directory = |slot: i64| {
        canon::obj(vec![
            ("slot", Value::Int(slot)),
            ("descriptorId", Value::Str(b64url_encode(&[slot as u8 + 10; 16]))),
            ("role", Value::Str("grant-root".into())),
            ("kind", Value::Str("directory".into())),
            ("access", Value::Str("read".into())),
            ("identity", canon::obj(vec![("filesystemId", Value::Str("fs".into())), ("mountId", Value::Str("1".into())), ("device", Value::Str("2".into())), ("inode", Value::Str((slot + 3).to_string())), ("fileType", Value::Str("directory".into()))])),
            ("destination", Value::Str(format!("/projects/p{slot}"))),
            ("resourceId", Value::Str(b64url_encode(&[slot as u8 + 40; 16]))),
        ])
    };
    let build = |kind: &str, channel: Value, descriptors: Vec<Value>, body: &[u8]| {
        let mut header = fields.clone();
        header.set("messageKind", Value::Str(kind.into()));
        header.set("channelId", channel);
        header.set("descriptors", Value::Arr(descriptors));
        frame::encode_frame(&header, body, &session_key, &claims_canonical, FrameLimits::default()).unwrap()
    };
    let state = |count: usize| FrameState { ancillary: Ancillary { count, truncated: false, well_formed: true, on_first_byte: true }, ..frame_state(&v, vector, &session_key, &claims_canonical, &expected) };
    let two = build("prepare", Value::Null, vec![directory(0), directory(1)], b"{}");
    assert!(frame::validate_target_frame(&two, &state(2)).is_ok());
    assert_eq!(frame::validate_target_frame(&two, &state(1)), Err(Code::DescriptorCount));
    assert_eq!(frame::validate_target_frame(&two, &state(3)), Err(Code::DescriptorCount));
    let gap = build("prepare", Value::Null, vec![directory(0), directory(2)], b"{}");
    assert_eq!(frame::validate_target_frame(&gap, &state(2)), Err(Code::DescriptorCount));
    let data_with_descriptor = build("data", Value::Null, vec![directory(0)], b"x");
    assert_eq!(frame::validate_target_frame(&data_with_descriptor, &state(1)), Err(Code::DescriptorCount));
    let big = build("data", Value::Null, vec![], &vec![0u8; 65_537]);
    assert_eq!(frame::validate_target_frame(&big, &state(0)), Err(Code::CapacityExceeded));
    let max = build("data", Value::Null, vec![], &vec![0u8; 65_536]);
    assert!(frame::validate_target_frame(&max, &state(0)).is_ok());
    // An open naming a channel needs the admitted manifest and an enabled channel.
    let open = build("open", Value::Str("broker".into()), vec![], b"");
    assert_eq!(frame::validate_target_frame(&open, &state(0)), Err(Code::InvalidRequest));
    let channel = |kind: &str, enabled: bool| {
        let endpoint = if kind == "mcp" {
            canon::obj(vec![("transport", Value::Str("tcp".into())), ("host", Value::Str("127.0.0.1".into())), ("port", Value::Int(4000))])
        } else {
            canon::obj(vec![("transport", Value::Str("unix".into())), ("path", Value::Str(format!("/run/robo-work/channels/{kind}.sock")))])
        };
        let handler = match kind { "model" => "model-adapter", "broker" => "execution-broker", "mcp" => "execution-mcp", "human-input" => "execution-human-input", _ => "execution-task-failure" };
        if enabled {
            canon::obj(vec![("channelId", Value::Str(kind.into())), ("kind", Value::Str(kind.into())), ("enabled", Value::Bool(true)), ("required", Value::Bool(true)), ("endpoint", endpoint), ("handler", Value::Str(handler.into())), ("policyDigest", Value::Str("a".repeat(64))), ("finalExecTokenName", Value::Null)])
        } else {
            canon::obj(vec![("channelId", Value::Str(kind.into())), ("kind", Value::Str(kind.into())), ("enabled", Value::Bool(false)), ("required", Value::Bool(false)), ("endpoint", Value::Null), ("handler", Value::Null), ("policyDigest", Value::Null), ("finalExecTokenName", Value::Null)])
        }
    };
    let binding = ticket.get("claims").unwrap().get("binding").unwrap();
    let manifest = |broker: bool| {
        canon::obj(vec![
            ("version", Value::Int(1)),
            ("executionId", binding.get("executionId").unwrap().clone()),
            ("attemptId", binding.get("attemptId").unwrap().clone()),
            ("limitsDigest", Value::Str("b".repeat(64))),
            ("channels", Value::Arr(vec![channel("model", true), channel("broker", broker), channel("mcp", true), channel("human-input", false), channel("task-failure", false)])),
        ])
    };
    let enabled = manifest(true);
    let disabled = manifest(false);
    assert!(frame::validate_target_frame(&open, &FrameState { channel_manifest: Some(&enabled), ..state(0) }).is_ok());
    assert_eq!(frame::validate_target_frame(&open, &FrameState { channel_manifest: Some(&disabled), ..state(0) }), Err(Code::ChannelNotAdmitted));
    // A non-canonical header (whitespace) authenticates but is refused as non-canonical.
    let header_text = format!(" {}", canon::canonical_text(&{
        let mut header = fields.clone();
        header.set("bodyBytes", Value::Int(0));
        header.set("bodyDigest", Value::Str(sha256_hex(b"")));
        header
    }).unwrap());
    let mut raw = Vec::new();
    raw.extend_from_slice(&((4 + header_text.len() + 32) as u32).to_be_bytes());
    raw.extend_from_slice(&(header_text.len() as u32).to_be_bytes());
    raw.extend_from_slice(header_text.as_bytes());
    let key = frame::direction_key(&session_key, &claims_canonical, "worker-to-target");
    let mac = hmac_sha256(&key, &[frame::FRAME_MAC_DOMAIN, &raw[..8], header_text.as_bytes(), b""]);
    raw.extend_from_slice(&mac);
    assert_eq!(frame::validate_target_frame(&raw, &state(0)), Err(Code::NoncanonicalEncoding));
}

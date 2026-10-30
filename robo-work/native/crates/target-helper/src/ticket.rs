//! Helper bootstrap/reattach ticket verification (T0 base section 8 "Bootstrap ticket", A1.7), a port of
//! `transportContract.mjs` `validateHelperTicketClaims` with the same check order and codes:
//!
//! strict decode; header `alg`, `typ` (purpose domain), exact keys, `kid`; HMAC in constant time; canonical claims,
//! version and exact keys; issuer and purpose; lifetime (30 s, no expiry extension, 2 s future skew, 5 s monotonic
//! challenge); audience and binding; channel-epoch compare-and-set; replay last, only after every other check passed.
//!
//! Replay records hold only `jti:`/`challenge:` SHA-256 keys and their retain-until time; live entries are never evicted
//! and refusals consume nothing. The store is per helper incarnation: the audience binds the incarnation, so a ticket for
//! an earlier incarnation can never verify after a restart.

use std::collections::HashMap;

use crate::Code;
use crate::canon::{self, Value};
use crate::contract::{self, is_nonce, is_opaque_text, is_positive_u64_text};
use crate::crypto::{b64url_decode, ct_eq, hmac_sha256, sha256_hex};

pub const TICKET_TYPE: &str = "ploinky-target-helper+jwt";
pub const TICKET_PURPOSE: &str = "ploinky.target-helper.v1";
pub const TICKET_ISSUER: &str = "ploinky-router";
pub const TICKET_AUDIENCE_PREFIX: &str = "ploinky:target-helper:";
pub const TICKET_PERMISSIONS: [&str; 8] = ["commit", "connect", "input", "lookup", "prepare", "release", "renew", "stop"];
pub const MAX_TICKET_LIFETIME_SECONDS: i64 = 30;
pub const MAX_FUTURE_SKEW_MS: i64 = 2000;
pub const CHALLENGE_TIMEOUT_MS: i64 = 5000;
pub const REPLAY_MARGIN_MS: i64 = 2000;
pub const MAX_TOKEN_LENGTH: usize = 65536;
/// `TARGET_LIMITS_V1.ticketReplayEntries`.
pub const TICKET_REPLAY_ENTRIES: usize = 32768;
/// A11.1 adds the required `leaseId` claim.
pub const CLAIM_KEYS: [&str; 18] = [
    "version", "iss", "sub", "purpose", "aud", "binding", "reservationId", "leaseId", "operationId", "requestDigest", "helperNonce", "jti",
    "iat", "exp", "channelEpoch", "previousChannelEpoch", "permissions", "limitsDigest",
];

/// One-use replay records: replay-key digest -> retain-until (ms).
#[derive(Debug, Default)]
pub struct ReplayStore {
    entries: HashMap<String, i64>,
}

impl ReplayStore {
    pub fn new() -> Self {
        ReplayStore::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn live(&self, key: &str, now_ms: i64) -> bool {
        self.entries.get(key).is_some_and(|until| *until > now_ms)
    }

    fn sweep(&mut self, now_ms: i64) {
        self.entries.retain(|_, until| *until > now_ms);
    }
}

/// The ticket fields the helper expects for this operation.
#[derive(Clone, Debug)]
pub struct Expected {
    pub reservation_id: String,
    /// The lease the caller expects. The helper passes None: it keys session state on the verified claim (A11.1).
    pub lease_id: Option<String>,
    pub operation_id: String,
    pub request_digest: String,
    pub helper_nonce: String,
}

/// `channel`: the epoch currently held for the ticket's lease, None on first use. A11.2: a ticket is accepted only with a
/// strictly greater epoch.
#[derive(Clone, Debug)]
pub struct ChannelState {
    pub current_epoch: Option<String>,
    pub lease_active: bool,
}

#[derive(Clone, Debug)]
pub struct Challenge {
    pub id: String,
    pub issued_mono_ms: i64,
}

pub struct TicketOptions<'a> {
    /// Per-helper-incarnation signing secret (at least 32 bytes).
    pub secret: &'a [u8],
    pub kid: &'a str,
    /// The TargetBinding the helper already holds.
    pub binding: &'a Value,
    pub expected: &'a Expected,
    pub channel: &'a ChannelState,
    pub challenge: &'a Challenge,
    pub now_ms: i64,
    pub now_mono_ms: i64,
    pub clock_uncertainty_ms: i64,
    pub replay: &'a mut ReplayStore,
    pub replay_capacity: usize,
}

fn need(condition: bool, code: Code) -> Result<(), Code> {
    if condition { Ok(()) } else { Err(code) }
}

fn decode_segment(segment: &str) -> Result<Vec<u8>, Code> {
    need(!segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'), Code::TicketFormat)?;
    b64url_decode(segment).ok_or(Code::TicketFormat)
}

/// A strict canonical parse whose non-canonical refusal stays `noncanonical_encoding` and every other refusal becomes
/// `ticket_format`.
fn parse_segment(bytes: &[u8]) -> Result<Value, Code> {
    canon::parse_canonical(bytes, canon::OBJECT_BYTES).map_err(|code| {
        if code == Code::NoncanonicalEncoding { Code::NoncanonicalEncoding } else { Code::TicketFormat }
    })
}

/// Verifies one compact HS256 JWS and consumes its JTI and challenge exactly once. Returns the claims.
pub fn verify_helper_ticket(token: &str, options: TicketOptions<'_>) -> Result<Value, Code> {
    need(options.secret.len() >= 32 && is_opaque_text(options.kid), Code::InvalidRequest)?;
    let binding = options.binding;
    contract::validate_target_binding(binding)?;
    need(!token.is_empty() && token.encode_utf16().count() <= MAX_TOKEN_LENGTH, Code::TicketFormat)?;
    let parts: Vec<&str> = token.split('.').collect();
    need(parts.len() == 3, Code::TicketFormat)?;
    let header = parse_segment(&decode_segment(parts[0])?)?;
    need(header.is_obj(), Code::TicketFormat)?;
    need(header.str_at("alg") == Some("HS256"), Code::TicketAlgorithm)?;
    // Domain separation before anything else: another token type is never a helper ticket.
    need(header.str_at("typ") == Some(TICKET_TYPE), Code::TicketPurpose)?;
    need(header.has_exact_keys(&["alg", "typ", "kid"]), Code::TicketFormat)?;
    need(header.str_at("kid") == Some(options.kid), Code::TicketSignature)?;
    let signature = decode_segment(parts[2])?;
    let mac = hmac_sha256(options.secret, &[parts[0].as_bytes(), b".", parts[1].as_bytes()]);
    need(ct_eq(&signature, &mac), Code::TicketSignature)?;
    let claims = parse_segment(&decode_segment(parts[1])?)?;
    need(claims.is_obj(), Code::TicketFormat)?;
    need(claims.get("version") == Some(&Value::Int(1)), Code::UnsupportedVersion)?;
    need(claims.has_exact_keys(&CLAIM_KEYS), Code::TicketFormat)?;
    need(claims.str_at("iss") == Some(TICKET_ISSUER) && claims.str_at("purpose") == Some(TICKET_PURPOSE), Code::TicketPurpose)?;
    let (Some(iat), Some(exp)) = (claims.get("iat").and_then(Value::int), claims.get("exp").and_then(Value::int)) else {
        return Err(Code::TicketLifetime);
    };
    let (iat, exp) = (iat as i128, exp as i128);
    need(exp > iat && exp - iat <= MAX_TICKET_LIFETIME_SECONDS as i128, Code::TicketLifetime)?;
    let uncertainty = options.clock_uncertainty_ms;
    need((0..=MAX_FUTURE_SKEW_MS).contains(&uncertainty), Code::TicketLifetime)?;
    let now_ms = options.now_ms as i128;
    need(iat * 1000 <= now_ms + MAX_FUTURE_SKEW_MS as i128, Code::TicketLifetime)?;
    need(now_ms < exp * 1000, Code::TicketLifetime)?;
    let challenge = options.challenge;
    need(!challenge.id.is_empty(), Code::InvalidRequest)?;
    let elapsed = options.now_mono_ms as i128 - challenge.issued_mono_ms as i128;
    need(elapsed < CHALLENGE_TIMEOUT_MS as i128 && elapsed >= 0, Code::TicketLifetime)?;
    need(
        claims.get("jti").is_some_and(is_nonce) && claims.get("helperNonce").is_some_and(is_nonce) && claims.get("leaseId").is_some_and(contract::is_id),
        Code::TicketFormat,
    )?;
    let permissions = claims.get("permissions").and_then(Value::arr).unwrap_or_default();
    let mut previous: Option<&str> = None;
    let mut permissions_ok = claims.get("permissions").and_then(Value::arr).is_some() && !permissions.is_empty();
    for entry in permissions {
        match entry.str() {
            Some(text) if TICKET_PERMISSIONS.contains(&text) && previous.is_none_or(|last| last < text) => previous = Some(text),
            _ => permissions_ok = false,
        }
    }
    need(permissions_ok, Code::TicketFormat)?;
    let scope = binding.get("scope").ok_or(Code::InvalidRequest)?;
    let audience = format!("{TICKET_AUDIENCE_PREFIX}{}", contract::target_identity_digest(scope)?);
    need(claims.str_at("aud") == Some(audience.as_str()), Code::TicketBinding)?;
    let claimed_binding = claims.get("binding").ok_or(Code::TicketBinding)?;
    need(canon::digest_of(claimed_binding)? == canon::digest_of(binding)?, Code::TicketBinding)?;
    need(
        claims.str_at("sub").is_some() && claims.get("sub") == scope.get("workerPrincipal")
            && claims.str_at("limitsDigest").is_some() && claims.get("limitsDigest") == binding.get("limitsDigest"),
        Code::TicketBinding,
    )?;
    let expected = options.expected;
    need(
        claims.str_at("reservationId") == Some(expected.reservation_id.as_str())
            && claims.str_at("operationId") == Some(expected.operation_id.as_str())
            && claims.str_at("requestDigest") == Some(expected.request_digest.as_str())
            && claims.str_at("helperNonce") == Some(expected.helper_nonce.as_str())
            && expected.lease_id.as_deref().is_none_or(|lease| claims.str_at("leaseId") == Some(lease)),
        Code::TicketBinding,
    )?;
    // A stopped or expired lease cannot be reopened by any ticket.
    need(options.channel.lease_active, Code::LeaseRetired)?;
    let epoch = claims.get("channelEpoch").ok_or(Code::TicketFormat)?;
    let previous_epoch = claims.get("previousChannelEpoch").ok_or(Code::TicketFormat)?;
    need(is_positive_u64_text(epoch) && (previous_epoch.is_null() || is_positive_u64_text(previous_epoch)), Code::TicketFormat)?;
    // A11.2: strictly greater than the epoch held for the lease; a present `previousChannelEpoch` is below the new epoch.
    let number = |value: &Value| value.str().and_then(|text| text.parse::<u128>().ok());
    let epoch_number = number(epoch).ok_or(Code::TicketFormat)?;
    need(previous_epoch.is_null() || number(previous_epoch).is_some_and(|previous| previous < epoch_number), Code::ChannelEpochConflict)?;
    if let Some(current) = &options.channel.current_epoch {
        need(is_positive_u64_text(&Value::Str(current.clone())), Code::InvalidRequest)?;
        let current = current.parse::<u128>().map_err(|_| Code::InvalidRequest)?;
        need(epoch_number > current, Code::ChannelEpochConflict)?;
    }
    let jti_key = format!("jti:{}", sha256_hex(claims.str_at("jti").unwrap_or_default().as_bytes()));
    let challenge_key = format!("challenge:{}", sha256_hex(challenge.id.as_bytes()));
    for key in [&jti_key, &challenge_key] {
        need(!options.replay.live(key, options.now_ms), Code::TicketReplayed)?;
    }
    let capacity = options.replay_capacity;
    if options.replay.len() + 2 > capacity {
        options.replay.sweep(options.now_ms);
    }
    need(options.replay.len() + 2 <= capacity, Code::CapacityExceeded)?;
    let retain_until = i64::try_from(exp * 1000 + REPLAY_MARGIN_MS as i128).map_err(|_| Code::TicketLifetime)?;
    options.replay.entries.insert(jti_key, retain_until);
    options.replay.entries.insert(challenge_key, retain_until);
    Ok(claims)
}

/// Builds a compact HS256 ticket from canonical claim text. Test and fixture use only: the helper never mints tickets
/// (the Router minter is P4).
pub fn sign_ticket_for_tests(secret: &[u8], header_canonical: &str, claims_canonical: &str) -> String {
    use crate::crypto::b64url_encode;
    let input = format!("{}.{}", b64url_encode(header_canonical.as_bytes()), b64url_encode(claims_canonical.as_bytes()));
    let mac = hmac_sha256(secret, &[input.as_bytes()]);
    format!("{input}.{}", b64url_encode(&mac))
}

//! The target transport frame (T0 base section 8 "Native frame"): encoder and a port of `transportContract.mjs`
//! `validateTargetFrame` with the same check order and codes.
//!
//! ```text
//! u32be(totalRemainingBytes) u32be(headerBytes) canonicalHeaderUtf8 bodyBytes 32-byte HMAC-SHA256
//! ```
//!
//! The MAC input is `ploinky-target-frame-v1\0`, both length fields, the canonical header and the body. Each direction
//! has its own key: HKDF-SHA256 of the 32-byte session key, salt SHA256(canonical ticket claims) as raw bytes, info
//! exactly `worker-to-target` or `target-to-worker`. The MAC is checked before the header is parsed.

use crate::Code;
use crate::canon::{self, Value};
use crate::contract::{self, CHANNEL_KINDS, is_digest, is_id, is_operation_id, is_positive_u64_text};
use crate::crypto::{ct_eq, hkdf_sha256_32, hmac_sha256, sha256, sha256_hex};

pub const FRAME_MAC_DOMAIN: &[u8] = b"ploinky-target-frame-v1\0";
pub const DIRECTIONS: [&str; 2] = ["worker-to-target", "target-to-worker"];
pub const MESSAGE_KINDS: [&str; 18] = [
    "prepare", "prepared", "commit", "receipt", "lookup", "lookup-result", "open", "open-ok", "open-refused", "data", "ack", "half-close",
    "close", "renew-challenge", "renew", "stop", "release", "failure",
];
pub const HEADER_KEYS: [&str; 22] = [
    "version", "direction", "workspaceId", "boxIdentity", "boxGeneration", "workerGeneration", "executionId", "attemptId", "leaseId",
    "reservationId", "targetBindingDigest", "operationId", "requestDigest", "channelEpoch", "sequence", "messageKind", "channelId",
    "connectionId", "processId", "bodyBytes", "bodyDigest", "descriptors",
];
const MAC_BYTES: usize = 32;

/// The frame bounds the receiver enforces (`TARGET_LIMITS_V1` ceilings by default; admitted limits may be lower).
#[derive(Clone, Copy, Debug)]
pub struct FrameLimits {
    pub frame_bytes: usize,
    pub header_bytes: usize,
    pub data_bytes_per_frame: usize,
    pub descriptors_per_frame: usize,
}

impl Default for FrameLimits {
    fn default() -> Self {
        FrameLimits { frame_bytes: 589_824, header_bytes: 16_384, data_bytes_per_frame: 65_536, descriptors_per_frame: 8 }
    }
}

/// SCM_RIGHTS facts of this frame's `recvmsg` calls (produced by the mailbox receiver).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ancillary {
    pub count: usize,
    pub truncated: bool,
    pub well_formed: bool,
    pub on_first_byte: bool,
}

#[derive(Clone, Debug)]
pub struct ExpectedIds {
    pub lease_id: String,
    pub reservation_id: String,
    pub operation_id: String,
    pub request_digest: String,
}

pub struct FrameState<'a> {
    /// The direction this receiver accepts.
    pub direction: &'a str,
    pub session_key: &'a [u8],
    /// The canonical claim bytes of the accepted ticket.
    pub claims_canonical: &'a [u8],
    /// The TargetBinding the receiver already holds.
    pub binding: &'a Value,
    pub expected: &'a ExpectedIds,
    pub channel_epoch: &'a str,
    pub next_sequence: &'a str,
    pub lease_active: bool,
    pub ancillary: Ancillary,
    /// Required for an `open` frame that names a channel.
    pub channel_manifest: Option<&'a Value>,
    pub limits: FrameLimits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedFrame {
    pub header: Value,
    pub body_offset: usize,
    pub body_length: usize,
    pub next_sequence: String,
}

fn need(condition: bool, code: Code) -> Result<(), Code> {
    if condition { Ok(()) } else { Err(code) }
}

/// JavaScript `header.descriptors.length === 0`, evaluated before the array check exactly as Node does: `null` throws a
/// TypeError (reported `invalid_request`), a string or array compares its length, an object its own `length` member,
/// and any other value is `undefined` (false). `tests/vectors/frame-descriptor-parity.json` pins each case against Node.
fn js_length_is_zero(value: &Value) -> Result<bool, Code> {
    match value {
        Value::Null => Err(Code::InvalidRequest),
        Value::Arr(items) => Ok(items.is_empty()),
        Value::Str(text) => Ok(text.is_empty()),
        Value::Obj(_) => Ok(value.get("length") == Some(&Value::Int(0))),
        Value::Bool(_) | Value::Int(_) => Ok(false),
    }
}

/// The per-direction frame key.
pub fn direction_key(session_key: &[u8], claims_canonical: &[u8], direction: &str) -> [u8; 32] {
    hkdf_sha256_32(session_key, &sha256(claims_canonical), direction.as_bytes())
}

fn frame_mac(key: &[u8], prefix: &[u8], header: &[u8], body: &[u8]) -> [u8; 32] {
    hmac_sha256(key, &[FRAME_MAC_DOMAIN, prefix, header, body])
}

/// Encodes one frame. `header` carries every header key except `bodyBytes` and `bodyDigest`, which are set from `body`.
/// The result is refused unless it would itself validate structurally (canonical, within the bounds).
pub fn encode_frame(header: &Value, body: &[u8], session_key: &[u8], claims_canonical: &[u8], limits: FrameLimits) -> Result<Vec<u8>, Code> {
    need(session_key.len() == 32, Code::InvalidRequest)?;
    let mut header = header.clone();
    need(header.is_obj(), Code::InvalidRequest)?;
    header.set("bodyBytes", Value::Int(body.len() as i64));
    header.set("bodyDigest", Value::Str(sha256_hex(body)));
    need(header.has_exact_keys(&HEADER_KEYS), Code::InvalidRequest)?;
    let direction = header.str_at("direction").filter(|direction| DIRECTIONS.contains(direction)).ok_or(Code::InvalidRequest)?;
    let canonical = canon::canonical(&header, limits.header_bytes)?;
    let total = 8 + canonical.len() + body.len() + MAC_BYTES;
    need(total <= limits.frame_bytes, Code::CapacityExceeded)?;
    let mut frame = Vec::with_capacity(total);
    frame.extend_from_slice(&((total - 4) as u32).to_be_bytes());
    frame.extend_from_slice(&(canonical.len() as u32).to_be_bytes());
    frame.extend_from_slice(canonical.as_bytes());
    frame.extend_from_slice(body);
    let key = direction_key(session_key, claims_canonical, direction);
    let mac = frame_mac(&key, &frame[..8], canonical.as_bytes(), body);
    frame.extend_from_slice(&mac);
    Ok(frame)
}

/// Validates one received frame (`validateTargetFrame`). The caller holds the bytes; the body is
/// `bytes[body_offset..body_offset + body_length]`.
pub fn validate_target_frame(bytes: &[u8], state: &FrameState<'_>) -> Result<AcceptedFrame, Code> {
    let limits = state.limits;
    need(state.session_key.len() == 32, Code::InvalidRequest)?;
    need(DIRECTIONS.contains(&state.direction), Code::InvalidRequest)?;
    let binding = state.binding;
    contract::validate_target_binding(binding)?;
    need(bytes.len() <= limits.frame_bytes, Code::CapacityExceeded)?;
    need(bytes.len() >= 8 + MAC_BYTES, Code::FrameLayout)?;
    let read_u32 = |offset: usize| u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]) as usize;
    need(read_u32(0) == bytes.len() - 4, Code::FrameLayout)?;
    let header_length = read_u32(4);
    need(header_length <= limits.header_bytes, Code::CapacityExceeded)?;
    need(8 + header_length + MAC_BYTES <= bytes.len(), Code::FrameLayout)?;
    let ancillary = state.ancillary;
    // MSG_CTRUNC, malformed rights or rights anywhere but the first byte of the frame.
    need(!ancillary.truncated && ancillary.well_formed && (ancillary.count == 0 || ancillary.on_first_byte), Code::DescriptorCount)?;
    let header_bytes = &bytes[8..8 + header_length];
    let body = &bytes[8 + header_length..bytes.len() - MAC_BYTES];
    let key = direction_key(state.session_key, state.claims_canonical, state.direction);
    let mac = frame_mac(&key, &bytes[..8], header_bytes, body);
    need(ct_eq(&mac, &bytes[bytes.len() - MAC_BYTES..]), Code::FrameAuthentication)?;
    let header = canon::parse_canonical(header_bytes, limits.header_bytes)?;
    need(header.is_obj(), Code::InvalidRequest)?;
    need(header.get("version") == Some(&Value::Int(1)), Code::UnsupportedVersion)?;
    need(header.has_exact_keys(&HEADER_KEYS), Code::InvalidRequest)?;
    need(state.lease_active, Code::LeaseRetired)?;
    let expected = state.expected;
    let scope = binding.get("scope").ok_or(Code::InvalidRequest)?;
    let same = |key: &str, value: Option<&Value>| header.get(key).is_some() && header.get(key) == value;
    let text = |value: &str| Value::Str(value.to_string());
    need(header.str_at("direction") == Some(state.direction), Code::FrameBinding)?;
    need(
        same("workspaceId", scope.get("workspaceId")) && same("boxIdentity", scope.get("boxIdentity")) && same("boxGeneration", scope.get("boxGeneration"))
            && same("workerGeneration", scope.get("workerGeneration")) && same("executionId", binding.get("executionId"))
            && same("attemptId", binding.get("attemptId")),
        Code::FrameBinding,
    )?;
    need(
        same("leaseId", Some(&text(&expected.lease_id))) && same("reservationId", Some(&text(&expected.reservation_id)))
            && same("operationId", Some(&text(&expected.operation_id))) && same("requestDigest", Some(&text(&expected.request_digest))),
        Code::FrameBinding,
    )?;
    // The binding digest authorizes nothing by itself: it must equal the digest of the binding already held.
    need(header.str_at("targetBindingDigest") == Some(canon::digest_of(binding)?.as_str()), Code::FrameBinding)?;
    let field = |key: &str| header.get(key).unwrap_or(&Value::Null);
    need(is_positive_u64_text(field("channelEpoch")) && header.str_at("channelEpoch") == Some(state.channel_epoch), Code::FrameBinding)?;
    need(is_positive_u64_text(field("sequence")) && header.str_at("sequence") == Some(state.next_sequence), Code::FrameSequence)?;
    let kind = header.str_at("messageKind");
    need(kind.is_some_and(|kind| MESSAGE_KINDS.contains(&kind)), Code::InvalidRequest)?;
    let channel_id = field("channelId");
    need(channel_id.is_null() || channel_id.str().is_some_and(|channel| CHANNEL_KINDS.contains(&channel)), Code::InvalidRequest)?;
    need(field("connectionId").is_null() || is_id(field("connectionId")), Code::InvalidRequest)?;
    need(field("processId").is_null() || is_positive_u64_text(field("processId")), Code::InvalidRequest)?;
    need(
        is_id(field("leaseId")) && is_id(field("reservationId")) && is_operation_id(field("operationId")) && is_digest(field("requestDigest")),
        Code::InvalidRequest,
    )?;
    need(field("bodyBytes").int() == Some(body.len() as i64), Code::FrameLayout)?;
    need(is_digest(field("bodyDigest")) && header.str_at("bodyDigest") == Some(sha256_hex(body).as_str()), Code::FrameLayout)?;
    let descriptors = field("descriptors");
    if kind == Some("data") {
        need(body.len() <= limits.data_bytes_per_frame, Code::CapacityExceeded)?;
        need(js_length_is_zero(descriptors)? && ancillary.count == 0, Code::DescriptorCount)?;
    }
    let entries = descriptors.arr().ok_or(Code::InvalidRequest)?;
    need(entries.len() <= limits.descriptors_per_frame, Code::CapacityExceeded)?;
    contract::validate_descriptor_manifest(descriptors)?;
    need(entries.len() == ancillary.count, Code::DescriptorCount)?;
    if kind == Some("open") && !channel_id.is_null() {
        let manifest = state.channel_manifest.ok_or(Code::InvalidRequest)?;
        contract::validate_channel_manifest(manifest)?;
        let admitted = manifest.get("channels").and_then(Value::arr).unwrap_or_default().iter().any(|channel| {
            channel.get("channelId") == Some(channel_id) && channel.get("enabled") == Some(&Value::Bool(true))
        });
        need(admitted, Code::ChannelNotAdmitted)?;
    }
    let sequence: u128 = header.str_at("sequence").unwrap_or_default().parse().map_err(|_| Code::InvalidRequest)?;
    Ok(AcceptedFrame { header, body_offset: 8 + header_length, body_length: body.len(), next_sequence: (sequence + 1).to_string() })
}

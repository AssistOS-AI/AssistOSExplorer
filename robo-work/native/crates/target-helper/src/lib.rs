//! The RoboWork target helper (plan section 5.6, "Target helper and private descriptor seam" and "Receipts, fencing and
//! cleanup"; T0 contract freeze base + A1..A9, sections 2, 8, 9 and 10).
//!
//! | Module | Content | Node oracle |
//! |---|---|---|
//! | `crypto` | SHA-256, HMAC-SHA256, HKDF-SHA256, constant-time compare, strict base64url (std only) | node:crypto |
//! | `canon` | Canonical target JSON: encoder, digest and the strict canonical parser | `contract.mjs` `encode`, `StrictParser` |
//! | `contract` | Primitive types, `TargetBinding`, descriptor manifest and channel manifest validators | `contract.mjs` |
//! | `ticket` | Helper bootstrap ticket (HS256 JWS) verification with one-use JTI/challenge replay records | `transportContract.mjs` `validateHelperTicketClaims` |
//! | `frame` | Target frame encoder and validator (length prefix, canonical header, body, HKDF direction-key MAC) | `transportContract.mjs` `validateTargetFrame` |
//! | `journal` | Management-private durable operation journal (file-backed, flock single writer, atomic unique key) | `journalModel.mjs` (helper side) |
//! | `mailbox` | Linux AF_UNIX mailbox endpoint: bounded `recvmsg` frame receive with SCM_RIGHTS on the first byte only | T0 section 8 "Native frame" |
//! | `keeper` | Keeper launch: a stub that refuses until G1 | none |
//! | `launch` | The single-use per-helper-incarnation ticket-secret file (`serve --secret-file`): checked, read, unlinked, parsed | Ploinky `provisioning.mjs` (shared v1 vector) |
//! | `service` | Journal operations behind authenticated frames, gated on keeper availability | none |
//! | `session` | Session handshake per T0 amendment A11 (challenge, ticket, lease-bound session-key possession proofs); the proof-fixture ticket key | none (vectors: `tests/vectors/session-fixture-v1.json`) |
//! | `peer` | Linux: the helper's authenticated connection handler and the worker-side session (slice P6b) | `transportContract.mjs` `validateTargetFrame` (worker side) |
//!
//! Every refusal is one enumerated [`Code`]; no token, path, raw input or exception text leaves a validator.

pub mod canon;
pub mod contract;
pub mod crypto;
pub mod frame;
pub mod journal;
pub mod keeper;
pub mod launch;
#[cfg(target_os = "linux")]
pub mod mailbox;
#[cfg(target_os = "linux")]
pub mod peer;
pub mod service;
pub mod session;
pub mod ticket;

/// Refusal codes. The spellings are those of the Node enumerations (`TRANSPORT_ERROR_CODES`, `CONTRACT_ERROR_CODES`,
/// `JOURNAL_ERROR_CODES`), except `KeeperUnavailable`, which is helper-local (keeper launch is not wired before G1).
/// `ConnectRefused`/`ConnectTimeout` are the `TRANSPORT_ERROR_CODES` spellings, used by the worker peer when the mailbox
/// cannot be reached at all (nothing was sent).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Code {
    InvalidRequest,
    UnsupportedVersion,
    NoncanonicalEncoding,
    CapacityExceeded,
    TicketFormat,
    TicketAlgorithm,
    TicketSignature,
    TicketPurpose,
    TicketBinding,
    TicketLifetime,
    TicketReplayed,
    ChannelEpochConflict,
    LeaseRetired,
    FrameLayout,
    FrameAuthentication,
    FrameBinding,
    FrameSequence,
    DescriptorCount,
    DescriptorRole,
    DescriptorIdentity,
    ChannelNotAdmitted,
    RequiredChannelMissing,
    JournalUnavailable,
    OperationConflict,
    BindingMismatch,
    NotFound,
    OutcomeUnknown,
    AbsenceUnverified,
    DeliveryUnknown,
    StateCorrupt,
    KeeperUnavailable,
    ConnectRefused,
    ConnectTimeout,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidRequest => "invalid_request",
            Code::UnsupportedVersion => "unsupported_version",
            Code::NoncanonicalEncoding => "noncanonical_encoding",
            Code::CapacityExceeded => "capacity_exceeded",
            Code::TicketFormat => "ticket_format",
            Code::TicketAlgorithm => "ticket_algorithm",
            Code::TicketSignature => "ticket_signature",
            Code::TicketPurpose => "ticket_purpose",
            Code::TicketBinding => "ticket_binding",
            Code::TicketLifetime => "ticket_lifetime",
            Code::TicketReplayed => "ticket_replayed",
            Code::ChannelEpochConflict => "channel_epoch_conflict",
            Code::LeaseRetired => "lease_retired",
            Code::FrameLayout => "frame_layout",
            Code::FrameAuthentication => "frame_authentication",
            Code::FrameBinding => "frame_binding",
            Code::FrameSequence => "frame_sequence",
            Code::DescriptorCount => "descriptor_count",
            Code::DescriptorRole => "descriptor_role",
            Code::DescriptorIdentity => "descriptor_identity",
            Code::ChannelNotAdmitted => "channel_not_admitted",
            Code::RequiredChannelMissing => "required_channel_missing",
            Code::JournalUnavailable => "journal_unavailable",
            Code::OperationConflict => "operation_conflict",
            Code::BindingMismatch => "binding_mismatch",
            Code::NotFound => "not_found",
            Code::OutcomeUnknown => "outcome_unknown",
            Code::AbsenceUnverified => "absence_unverified",
            Code::DeliveryUnknown => "delivery_unknown",
            Code::StateCorrupt => "state_corrupt",
            Code::KeeperUnavailable => "keeper_unavailable",
            Code::ConnectRefused => "connect_refused",
            Code::ConnectTimeout => "connect_timeout",
        }
    }

    /// Every code, for spelling lookups.
    pub const ALL: [Code; 33] = [
        Code::InvalidRequest,
        Code::UnsupportedVersion,
        Code::NoncanonicalEncoding,
        Code::CapacityExceeded,
        Code::TicketFormat,
        Code::TicketAlgorithm,
        Code::TicketSignature,
        Code::TicketPurpose,
        Code::TicketBinding,
        Code::TicketLifetime,
        Code::TicketReplayed,
        Code::ChannelEpochConflict,
        Code::LeaseRetired,
        Code::FrameLayout,
        Code::FrameAuthentication,
        Code::FrameBinding,
        Code::FrameSequence,
        Code::DescriptorCount,
        Code::DescriptorRole,
        Code::DescriptorIdentity,
        Code::ChannelNotAdmitted,
        Code::RequiredChannelMissing,
        Code::JournalUnavailable,
        Code::OperationConflict,
        Code::BindingMismatch,
        Code::NotFound,
        Code::OutcomeUnknown,
        Code::AbsenceUnverified,
        Code::DeliveryUnknown,
        Code::StateCorrupt,
        Code::KeeperUnavailable,
        Code::ConnectRefused,
        Code::ConnectTimeout,
    ];

    /// The enumerated code with this spelling, if any (A11.6: worker tools never echo a helper's free text).
    pub fn from_spelling(text: &str) -> Option<Code> {
        Code::ALL.iter().copied().find(|code| code.as_str() == text)
    }

    /// `{ok:false,error:{code}}`.
    pub fn result_value(self) -> canon::Value {
        canon::obj(vec![("ok", canon::Value::Bool(false)), ("error", canon::obj(vec![("code", canon::s(self.as_str()))]))])
    }
}

impl std::fmt::Display for Code {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::error::Error for Code {}

/// `{ok:true,value}`.
pub fn ok_value(value: canon::Value) -> canon::Value {
    canon::obj(vec![("ok", canon::Value::Bool(true)), ("value", value)])
}

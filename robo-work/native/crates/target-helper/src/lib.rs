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
//! | `service` | Journal operations behind authenticated frames, gated on keeper availability | none |
//!
//! Every refusal is one enumerated [`Code`]; no token, path, raw input or exception text leaves a validator.

pub mod canon;
pub mod contract;
pub mod crypto;
pub mod frame;
pub mod journal;
pub mod keeper;
#[cfg(target_os = "linux")]
pub mod mailbox;
pub mod service;
pub mod ticket;

/// Refusal codes. The spellings are those of the Node enumerations (`TRANSPORT_ERROR_CODES`, `CONTRACT_ERROR_CODES`,
/// `JOURNAL_ERROR_CODES`), except `KeeperUnavailable`, which is helper-local (keeper launch is not wired before G1).
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
        }
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

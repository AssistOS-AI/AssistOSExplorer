//! Keeper channel limits of the v1 wire contract (keeper-wire-contract-delta-2026-10-28_claude.md §2, R1.2, R1.6;
//! mirror of the Node `server/execution/keeperLimits.mjs`). Every value is PROVISIONAL (G5). The keeper takes overrides
//! only through `--channel-limit name=value` and echoes the resolved keeper-side set, plus `rootLeaseTtlMs` from the
//! view limits, in `hello.limits`; the client refuses a hello whose limits differ from its own.
//!
//! BINDING NOTE: the exact `hello.limits` key set and the relationship checks are bound by the shared vectors
//! (`tests/vectors/keeper-wire.v1.json`, the S4 r9 copy; contract R2.5); `keeper_wire_vectors` checks the set below
//! against the vectors.

use crate::json::{MAX_SAFE_INTEGER, Value, int, obj};
use crate::limits::{LimitError, ViewLimits};

macro_rules! keeper_limits {
    ($($field:ident = $name:literal : $default:expr, hello: $hello:expr),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct KeeperLimits { $(pub $field: i64,)* }

        impl Default for KeeperLimits {
            fn default() -> Self { KeeperLimits { $($field: $default,)* } }
        }

        impl KeeperLimits {
            pub const NAMES: &'static [&'static str] = &[$($name,)*];
            fn slot(&mut self, name: &str) -> Option<&mut i64> {
                match name { $($name => Some(&mut self.$field),)* _ => None }
            }
            pub fn entries(&self) -> Vec<(&'static str, i64)> { vec![$(($name, self.$field),)*] }
            /// The keeper-side channel set echoed in `hello.limits` (without `rootLeaseTtlMs`).
            pub fn hello_entries(&self) -> Vec<(&'static str, i64)> {
                let mut out = Vec::new();
                $(if $hello { out.push(($name, self.$field)); })*
                out
            }
        }
    };
}

keeper_limits! {
    max_frame_bytes = "maxFrameBytes": 655_360, hello: true,
    max_in_flight = "maxInFlight": 16, hello: true,
    reserved_in_flight = "reservedInFlight": 2, hello: true,
    max_queued_requests = "maxQueuedRequests": 64, hello: false,
    partial_frame_deadline_ms = "partialFrameDeadlineMs": 5000, hello: true,
    hello_deadline_ms = "helloDeadlineMs": 5000, hello: false,
    request_deadline_ms = "requestDeadlineMs": 10_000, hello: false,
    create_deadline_ms = "createDeadlineMs": 15_000, hello: false,
    stop_extra_ms = "stopExtraMs": 5000, hello: false,
    keeper_exit_wait_ms = "keeperExitWaitMs": 2000, hello: false,
    pty_chunk_bytes = "ptyChunkBytes": 16_384, hello: true,
    pty_max_credit_bytes = "ptyMaxCreditBytes": 262_144, hello: true,
    stderr_ring_bytes = "stderrRingBytes": 65_536, hello: false,
    pty_input_window_frames = "ptyInputWindowFrames": 8, hello: true,
    pty_input_window_bytes = "ptyInputWindowBytes": 65_536, hello: true,
    pty_input_queue_bytes = "ptyInputQueueBytes": 262_144, hello: false,
    pty_input_stall_ms = "ptyInputStallMs": 30_000, hello: false,
    max_outbound_bytes = "maxOutboundBytes": 1_048_576, hello: true,
    max_ptys_per_keeper = "maxPtysPerKeeper": 1, hello: true,
}

/// The provider endpoint's limits (`executionLimits.mjs` ENDPOINT_LIMIT_DEFAULTS), used to validate `create.spec`
/// (endpoint config limit names, orchestration args and env, workload start requests). PROVISIONAL (G5); pinned by the
/// shared vectors (`limits.endpoint`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EndpointLimits {
    pub max_path_bytes: usize,
    pub max_args: usize,
    pub max_arg_bytes: usize,
    pub max_env_entries: usize,
    pub max_env_value_bytes: usize,
    pub max_folders: usize,
    pub max_exclusions: usize,
    pub max_request_bytes: usize,
}

impl Default for EndpointLimits {
    fn default() -> Self {
        EndpointLimits {
            max_path_bytes: 1024, max_args: 256, max_arg_bytes: 256 * 1024, max_env_entries: 64, max_env_value_bytes: 16 * 1024,
            max_folders: 32, max_exclusions: 64, max_request_bytes: 512 * 1024,
        }
    }
}

/// Every endpoint limit name with its default (the full ENDPOINT_LIMIT_DEFAULTS set: an endpoint `config.limits` key
/// must be one of these).
pub const ENDPOINT_LIMIT_DEFAULTS: &[(&str, i64)] = &[
    ("maxFrameBytes", 576 * 1024), ("maxInFlightRequests", 16), ("partialFrameDeadlineMs", 5000), ("maxMessageBytes", 640 * 1024),
    ("maxInboundQueue", 8), ("maxOutboundBacklogMessages", 64), ("maxOutboundBacklogBytes", 1024 * 1024), ("maxRequestBytes", 512 * 1024),
    ("maxArgs", 256), ("maxArgBytes", 256 * 1024), ("maxEnvEntries", 64), ("maxEnvValueBytes", 16 * 1024), ("maxFolders", 32),
    ("maxExclusions", 64), ("maxPathBytes", 1024), ("maxProcesses", 16), ("maxPendingConnects", 8), ("maxRelayConnections", 16),
    ("streamAcceptDeadlineMs", 5000), ("connectDeadlineMs", 5000),
];

/// The client-only keeper limits: in keeperLimits.mjs but never sent with `--channel-limit` and never echoed (RK-1).
pub const CLIENT_ONLY_LIMITS: &[&str] = &["pingIntervalMs"];

/// The endpoint's `maxRequestBytes` and `frameEnvelopeBytes` (executionLimits.mjs defaults: 512 KiB and
/// 3·(maxPathBytes + 16) + 256 with maxPathBytes 1024). A `create` carries one admitted start request.
pub const ENDPOINT_MAX_REQUEST_BYTES: i64 = 512 * 1024;
pub const ENDPOINT_FRAME_ENVELOPE_BYTES: i64 = 3 * (1024 + 16) + 256;

fn ceil_div(a: i64, b: i64) -> i64 {
    (a + b - 1) / b
}

/// The largest encoded PTY frame: `4·ceil(ptyChunkBytes/3) + 512`.
pub fn pty_frame_cap(limits: &KeeperLimits) -> i64 {
    4 * ceil_div(limits.pty_chunk_bytes, 3) + 512
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeeperLimitError {
    Unknown(String),
    NotPositive(&'static str),
    Relationship(&'static str),
}

/// Resolves overrides by name and applies the relationship checks of §2, R1.2 and R1.6.
pub fn resolve_keeper_limits(overrides: &[(&str, i64)], view: &ViewLimits) -> Result<KeeperLimits, KeeperLimitError> {
    let mut limits = KeeperLimits::default();
    for (name, value) in overrides {
        *limits.slot(name).ok_or_else(|| KeeperLimitError::Unknown((*name).to_string()))? = *value;
    }
    for (name, value) in limits.entries() {
        if value <= 0 || value > MAX_SAFE_INTEGER {
            return Err(KeeperLimitError::NotPositive(name));
        }
    }
    let rule = |ok: bool, name| if ok { Ok(()) } else { Err(KeeperLimitError::Relationship(name)) };
    rule(limits.max_frame_bytes >= ENDPOINT_MAX_REQUEST_BYTES + ENDPOINT_FRAME_ENVELOPE_BYTES + 1024, "maxFrameBytes_vs_request")?;
    rule(limits.max_frame_bytes >= view.max_mount_frame_bytes, "maxFrameBytes_vs_mount")?;
    rule(limits.max_frame_bytes >= pty_frame_cap(&limits), "maxFrameBytes_vs_pty")?;
    rule(limits.reserved_in_flight < limits.max_in_flight, "reservedInFlight_vs_maxInFlight")?;
    rule(limits.pty_max_credit_bytes >= limits.pty_chunk_bytes, "ptyMaxCreditBytes_vs_chunk")?;
    rule(limits.pty_input_window_bytes >= limits.pty_chunk_bytes, "ptyInputWindowBytes_vs_chunk")?;
    rule(limits.pty_input_queue_bytes >= limits.pty_input_window_bytes, "ptyInputQueueBytes_vs_window")?;
    // In i128 (review RK-6): absurd overrides cannot wrap and bypass the check.
    let wide = |value: i64| value as i128;
    let outbound_need = 4 * ((wide(limits.pty_max_credit_bytes) + 2) / 3)
        + ((wide(limits.pty_max_credit_bytes) + wide(limits.pty_chunk_bytes) - 1) / wide(limits.pty_chunk_bytes)) * 512
        + (wide(limits.max_in_flight) + wide(limits.pty_input_window_frames)) * 4096;
    rule(wide(limits.max_outbound_bytes) >= outbound_need, "maxOutboundBytes_vs_pty_and_replies")?;
    rule(wide(limits.max_frame_bytes) >= 4 * ((wide(limits.pty_chunk_bytes) + 2) / 3) + 512, "maxFrameBytes_vs_pty")?;
    Ok(limits)
}

/// `hello.limits`: the keeper-side channel set plus `rootLeaseTtlMs`.
pub fn hello_limits(limits: &KeeperLimits, view: &ViewLimits) -> Value {
    let mut entries: Vec<(&str, Value)> = limits.hello_entries().into_iter().map(|(name, value)| (name, int(value))).collect();
    entries.push(("rootLeaseTtlMs", int(view.root_lease_ttl_ms)));
    obj(entries)
}

pub fn map_view_error(error: LimitError) -> KeeperLimitError {
    match error {
        LimitError::Unknown(name) => KeeperLimitError::Unknown(name),
        LimitError::NotPositive(name) => KeeperLimitError::NotPositive(name),
        LimitError::RenewNotShorterThanTtl => KeeperLimitError::Relationship("rootLeaseRenewMs_vs_ttl"),
        LimitError::Malformed(name) => KeeperLimitError::Unknown(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_satisfy_every_relationship() {
        let limits = resolve_keeper_limits(&[], &ViewLimits::default()).unwrap();
        assert_eq!(limits.max_frame_bytes, 655_360);
        assert_eq!(limits.max_in_flight, 16);
        assert_eq!(limits.max_outbound_bytes, 1_048_576);
        // R1.6 arithmetic: 349528 + 8192 + 98304 = 456024 <= 1048576.
        assert_eq!(4 * ceil_div(262_144, 3) + ceil_div(262_144, 16_384) * 512 + (16 + 8) * 4096, 456_024);
        assert_eq!(pty_frame_cap(&limits), 4 * 5462 + 512);
    }

    #[test]
    fn relationship_and_name_refusals() {
        let view = ViewLimits::default();
        assert_eq!(resolve_keeper_limits(&[("maxFrameBytes", 65_536)], &view), Err(KeeperLimitError::Relationship("maxFrameBytes_vs_request")));
        assert_eq!(resolve_keeper_limits(&[("maxOutboundBytes", 262_144)], &view), Err(KeeperLimitError::Relationship("maxOutboundBytes_vs_pty_and_replies")));
        assert_eq!(resolve_keeper_limits(&[("ptyInputWindowBytes", 1024)], &view), Err(KeeperLimitError::Relationship("ptyInputWindowBytes_vs_chunk")));
        assert_eq!(resolve_keeper_limits(&[("nope", 1)], &view), Err(KeeperLimitError::Unknown("nope".into())));
        assert_eq!(resolve_keeper_limits(&[("maxInFlight", 0)], &view), Err(KeeperLimitError::NotPositive("maxInFlight")));
        // RK-6: values whose products would overflow i64 are refused, never wrapped.
        let huge = MAX_SAFE_INTEGER;
        assert!(resolve_keeper_limits(&[("maxInFlight", huge), ("ptyInputWindowFrames", huge), ("maxOutboundBytes", huge)], &view).is_err());
        let hello = hello_limits(&KeeperLimits::default(), &view);
        assert_eq!(hello.get("rootLeaseTtlMs").and_then(Value::as_safe_int), Some(3000));
        assert!(hello.get("requestDeadlineMs").is_none(), "client-only limits are not echoed");
    }
}

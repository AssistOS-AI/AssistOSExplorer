//! Named, explicit, positive limits for the keeper and the file server.
//!
//! Every value is PROVISIONAL: G5 has not fixed the reviewed limits. `ViewLimits` mirrors `VIEW_LIMIT_DEFAULTS` of
//! `robo-work/server/views/viewLimits.mjs` name for name and value for value, with the same resolution rules: unknown
//! names are refused, every value must be a positive safe integer, and `rootLeaseRenewMs` must be shorter than
//! `rootLeaseTtlMs`. The supervisor and the keeper must agree on these values (G5); the keeper takes overrides only
//! through its argv (`--view-limit name=value`), validated here.
//!
//! `KeeperChannelLimits` bounds the framed supervisor channel. The architect specification (contract table, "Keeper
//! frame") gives "u32 BE length (<= G5 max, provisionally 64 KiB)". The mount and lease frames are additionally bounded
//! by `maxMountFrameBytes` and their in-flight count by `maxMountInFlight` of the view limits.

use crate::json::MAX_SAFE_INTEGER;

pub const LIMITS_ARE_PROVISIONAL: bool = true;

macro_rules! view_limits {
    ($($field:ident = $name:literal : $default:expr),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct ViewLimits { $(pub $field: i64,)* }

        impl Default for ViewLimits {
            fn default() -> Self { ViewLimits { $($field: $default,)* } }
        }

        impl ViewLimits {
            pub const NAMES: &'static [&'static str] = &[$($name,)*];

            fn slot(&mut self, name: &str) -> Option<&mut i64> {
                match name { $($name => Some(&mut self.$field),)* _ => None }
            }

            pub fn entries(&self) -> Vec<(&'static str, i64)> {
                vec![$(($name, self.$field),)*]
            }
        }
    };
}

view_limits! {
    descriptor_cap = "descriptorCap": 1024,
    max_binding_chain_depth = "maxBindingChainDepth": 128,
    max_descendant_scan_entries = "maxDescendantScanEntries": 65536,
    max_component_bytes = "maxComponentBytes": 255,
    max_grant_path_bytes = "maxGrantPathBytes": 1024,
    max_grant_path_depth = "maxGrantPathDepth": 32,
    first_grant_root_slot = "firstGrantRootSlot": 8,
    max_views_per_keeper = "maxViewsPerKeeper": 8,
    max_mount_frame_bytes = "maxMountFrameBytes": 2048,
    max_mount_in_flight = "maxMountInFlight": 4,
    max_grant_id_bytes = "maxGrantIdBytes": 32,
    max_mountpoint_bytes = "maxMountpointBytes": 512,
    file_server_inherited_descriptors = "fileServerInheritedDescriptors": 5,
    rlimit_headroom = "rlimitHeadroom": 64,
    root_lease_renew_ms = "rootLeaseRenewMs": 1000,
    root_lease_ttl_ms = "rootLeaseTtlMs": 3000,
    root_revoke_grace_ms = "rootRevokeGraceMs": 2000,
    root_revoke_verify_ms = "rootRevokeVerifyMs": 2000,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LimitError {
    Unknown(String),
    NotPositive(&'static str),
    RenewNotShorterThanTtl,
    Malformed(String),
}

fn positive_safe(value: i64) -> bool {
    value > 0 && value <= MAX_SAFE_INTEGER
}

/// `resolveViewLimits(overrides)`.
pub fn resolve_view_limits(overrides: &[(&str, i64)]) -> Result<ViewLimits, LimitError> {
    let mut limits = ViewLimits::default();
    for (name, value) in overrides {
        let slot = limits.slot(name).ok_or_else(|| LimitError::Unknown((*name).to_string()))?;
        *slot = *value;
    }
    for (name, value) in limits.entries() {
        if !positive_safe(value) {
            return Err(LimitError::NotPositive(name));
        }
    }
    if limits.root_lease_renew_ms >= limits.root_lease_ttl_ms {
        return Err(LimitError::RenewNotShorterThanTtl);
    }
    Ok(limits)
}

/// Parses `name=value` (one keeper argv override).
pub fn parse_override(text: &str) -> Result<(String, i64), LimitError> {
    let (name, value) = text.split_once('=').ok_or_else(|| LimitError::Malformed(text.to_string()))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) || value.len() > 16 {
        return Err(LimitError::Malformed(text.to_string()));
    }
    let value: i64 = value.parse().map_err(|_| LimitError::Malformed(text.to_string()))?;
    Ok((name.to_string(), value))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeeperChannelLimits {
    pub max_frame_bytes: usize,
    pub max_in_flight: usize,
    pub partial_frame_deadline_ms: u64,
    /// Bound on reply bytes queued toward a supervisor that does not read (a peer violation beyond it).
    pub max_outbound_bytes: usize,
}

impl KeeperChannelLimits {
    pub fn provisional(view: &ViewLimits) -> Self {
        KeeperChannelLimits {
            max_frame_bytes: 64 * 1024,
            max_in_flight: view.max_mount_in_flight as usize,
            partial_frame_deadline_ms: 5000,
            max_outbound_bytes: 256 * 1024,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_mirror_view_limits_mjs() {
        // The exact VIEW_LIMIT_DEFAULTS of viewLimits.mjs (s5 r5), in declaration order.
        let expected: &[(&str, i64)] = &[
            ("descriptorCap", 1024), ("maxBindingChainDepth", 128), ("maxDescendantScanEntries", 65536),
            ("maxComponentBytes", 255), ("maxGrantPathBytes", 1024), ("maxGrantPathDepth", 32),
            ("firstGrantRootSlot", 8), ("maxViewsPerKeeper", 8), ("maxMountFrameBytes", 2048), ("maxMountInFlight", 4),
            ("maxGrantIdBytes", 32), ("maxMountpointBytes", 512), ("fileServerInheritedDescriptors", 5),
            ("rlimitHeadroom", 64), ("rootLeaseRenewMs", 1000), ("rootLeaseTtlMs", 3000), ("rootRevokeGraceMs", 2000),
            ("rootRevokeVerifyMs", 2000),
        ];
        assert_eq!(ViewLimits::default().entries(), expected.to_vec());
    }

    #[test]
    fn resolution_rules() {
        assert_eq!(resolve_view_limits(&[("rootLeaseRenewMs", 3000)]), Err(LimitError::RenewNotShorterThanTtl));
        assert_eq!(resolve_view_limits(&[("nope", 1)]), Err(LimitError::Unknown("nope".into())));
        assert_eq!(resolve_view_limits(&[("descriptorCap", 0)]), Err(LimitError::NotPositive("descriptorCap")));
        assert_eq!(resolve_view_limits(&[("descriptorCap", MAX_SAFE_INTEGER + 1)]), Err(LimitError::NotPositive("descriptorCap")));
        assert_eq!(resolve_view_limits(&[("rootLeaseTtlMs", 5000)]).unwrap().root_lease_ttl_ms, 5000);
        assert_eq!(parse_override("rootLeaseTtlMs=5000"), Ok(("rootLeaseTtlMs".into(), 5000)));
        for bad in ["x", "x=", "x=-1", "x=1.5", "x=99999999999999999"] {
            assert!(parse_override(bad).is_err(), "{bad}");
        }
    }
}

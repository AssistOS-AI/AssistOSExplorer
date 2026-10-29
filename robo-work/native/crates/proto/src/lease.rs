//! The keeper's fail-closed root lease (decision D-S5-6; plan section 5.4, row "Grant root and outside ancestors";
//! S5 decisions delta sections 5.2, 7.3 and 15).
//!
//! A port of `createRootLeaseKeeper` in `robo-work/server/views/rootLease.mjs` (S5 r5) with the same transitions and
//! codes. Time is injected (milliseconds of a monotonic clock).
//!
//! | Event | Effect |
//! |---|---|
//! | `mount_view` with `rootLease: { epoch: 1, ttlMs }` | `live`, `validUntil = now + ttlMs` |
//! | `renew` with a higher epoch, while live | `validUntil = now + ttlMs` |
//! | `renew` with an epoch <= the last | `stale_epoch`, unchanged |
//! | `revoke` at any epoch, while live | `revoking` with the frame's reason (a revoke only shortens the lease) |
//! | `now >= validUntil` | `revoking` with reason `lease_expired`, evaluated before any frame, so a late renew cannot revive it |
//! | any frame after revocation | `revoked`, unchanged (sticky) |
//! | `poll()` in `revoking` | `signal_revoke` once (SIGTERM: the server treats the root as protected and drains), then `kill` once (SIGKILL) `rootRevokeGraceMs` later unless the server exited first |
//! | `serverExited()` | `killed` |

use crate::json::Value;
use crate::limits::ViewLimits;
use crate::mount_frames::{LeaseVerdict, is_grant_id, validate_root_lease_frame};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseState {
    Live,
    Revoking,
    Killed,
}

impl LeaseState {
    pub fn as_str(self) -> &'static str {
        match self {
            LeaseState::Live => "live",
            LeaseState::Revoking => "revoking",
            LeaseState::Killed => "killed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseAction {
    /// SIGTERM to the file server.
    SignalRevoke,
    /// SIGKILL to the file server.
    Kill,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyResult {
    pub accepted: bool,
    pub code: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inspect {
    pub state: LeaseState,
    pub epoch: i64,
    pub valid_until: u64,
    pub reason: Option<String>,
}

#[derive(Debug)]
pub struct RootLeaseKeeper {
    grant_id: String,
    limits: ViewLimits,
    state: LeaseState,
    epoch: i64,
    valid_until: u64,
    reason: Option<String>,
    signalled_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseInitError {
    BadGrant,
    BadInitial,
}

impl RootLeaseKeeper {
    /// `initial` is the `mount_view` lease `{ epoch: 1, ttlMs }`, already validated by the mount validator; it is
    /// re-checked here (epoch 1, `1 <= ttlMs <= rootLeaseTtlMs`).
    pub fn new(grant_id: &str, initial_epoch: i64, initial_ttl_ms: i64, now_ms: u64, limits: ViewLimits) -> Result<Self, LeaseInitError> {
        if !is_grant_id(grant_id) {
            return Err(LeaseInitError::BadGrant);
        }
        if initial_epoch != 1 || initial_ttl_ms < 1 || initial_ttl_ms > limits.root_lease_ttl_ms {
            return Err(LeaseInitError::BadInitial);
        }
        Ok(RootLeaseKeeper {
            grant_id: grant_id.to_string(),
            limits,
            state: LeaseState::Live,
            epoch: 1,
            valid_until: now_ms.saturating_add(initial_ttl_ms as u64),
            reason: None,
            signalled_at: None,
        })
    }

    fn refresh(&mut self, now_ms: u64) {
        if self.state == LeaseState::Live && now_ms >= self.valid_until {
            self.state = LeaseState::Revoking;
            self.reason = Some("lease_expired".to_string());
        }
    }

    /// `apply(frame)` for a decoded `view_root_lease` frame.
    pub fn apply(&mut self, frame: &Value, now_ms: u64) -> ApplyResult {
        let answer = |accepted, code| ApplyResult { accepted, code };
        let parsed = match validate_root_lease_frame(frame, &self.limits) {
            Ok(parsed) => parsed,
            Err("bad_ttl") => return answer(false, "bad_ttl"),
            Err(_) => return answer(false, "bad_frame"),
        };
        if parsed.grant_id != self.grant_id {
            return answer(false, "wrong_grant");
        }
        self.refresh(now_ms);
        if self.state != LeaseState::Live {
            return answer(false, "revoked");
        }
        match parsed.verdict {
            LeaseVerdict::Revoke { reason } => {
                self.state = LeaseState::Revoking;
                self.reason = Some(reason);
                self.epoch = self.epoch.max(parsed.epoch);
                answer(true, "ok")
            }
            LeaseVerdict::Renew { ttl_ms } => {
                if parsed.epoch <= self.epoch {
                    return answer(false, "stale_epoch");
                }
                self.epoch = parsed.epoch;
                self.valid_until = now_ms.saturating_add(ttl_ms as u64);
                answer(true, "ok")
            }
        }
    }

    /// `poll()`: the actions to perform now, each emitted once over the lifetime of the lease.
    pub fn poll(&mut self, now_ms: u64) -> (LeaseState, Option<LeaseAction>) {
        self.refresh(now_ms);
        if self.state == LeaseState::Revoking {
            match self.signalled_at {
                None => {
                    self.signalled_at = Some(now_ms);
                    return (self.state, Some(LeaseAction::SignalRevoke));
                }
                Some(at) if now_ms >= at.saturating_add(self.limits.root_revoke_grace_ms as u64) => {
                    self.state = LeaseState::Killed;
                    return (self.state, Some(LeaseAction::Kill));
                }
                Some(_) => {}
            }
        }
        (self.state, None)
    }

    /// When `poll` must run next to meet the lease, absent new frames.
    pub fn next_deadline(&self) -> Option<u64> {
        match (self.state, self.signalled_at) {
            (LeaseState::Live, _) => Some(self.valid_until),
            (LeaseState::Revoking, None) => Some(0),
            (LeaseState::Revoking, Some(at)) => Some(at.saturating_add(self.limits.root_revoke_grace_ms as u64)),
            (LeaseState::Killed, _) => None,
        }
    }

    pub fn server_exited(&mut self) {
        if self.state == LeaseState::Live {
            self.reason = Some("server_exited".to_string());
        }
        self.state = LeaseState::Killed;
    }

    pub fn inspect(&self) -> Inspect {
        Inspect { state: self.state, epoch: self.epoch, valid_until: self.valid_until, reason: self.reason.clone() }
    }

    pub fn state(&self) -> LeaseState {
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{int, obj, text};

    fn renew(epoch: i64, ttl: i64) -> Value {
        obj(vec![("id", int(9)), ("op", text("view_root_lease")), ("grantId", text("g1")), ("epoch", int(epoch)), ("verdict", text("renew")), ("ttlMs", int(ttl))])
    }
    fn revoke(epoch: i64) -> Value {
        obj(vec![("id", int(9)), ("op", text("view_root_lease")), ("grantId", text("g1")), ("epoch", int(epoch)), ("verdict", text("revoke")), ("reason", text("root_unbound"))])
    }
    fn keeper(now: u64) -> RootLeaseKeeper {
        RootLeaseKeeper::new("g1", 1, 3000, now, ViewLimits::default()).unwrap()
    }

    #[test]
    fn fail_closed_expiry_then_signal_then_kill_each_once() {
        let mut lease = keeper(0);
        assert_eq!(lease.poll(2999), (LeaseState::Live, None));
        assert_eq!(lease.poll(3000), (LeaseState::Revoking, Some(LeaseAction::SignalRevoke)));
        assert_eq!(lease.inspect().reason.as_deref(), Some("lease_expired"));
        assert_eq!(lease.poll(4999), (LeaseState::Revoking, None));
        assert_eq!(lease.poll(5000), (LeaseState::Killed, Some(LeaseAction::Kill)));
        assert_eq!(lease.poll(9000), (LeaseState::Killed, None));
    }

    #[test]
    fn renew_extends_and_late_renew_cannot_revive() {
        let mut lease = keeper(0);
        assert_eq!(lease.apply(&renew(2, 3000), 1000), ApplyResult { accepted: true, code: "ok" });
        assert_eq!(lease.inspect().valid_until, 4000);
        assert_eq!(lease.apply(&renew(3, 3000), 4000), ApplyResult { accepted: false, code: "revoked" });
        assert_eq!(lease.state(), LeaseState::Revoking);
    }

    #[test]
    fn replay_and_ttl_rules() {
        let mut lease = keeper(0);
        assert!(lease.apply(&renew(2, 3000), 10).accepted);
        assert_eq!(lease.apply(&renew(2, 3000), 20).code, "stale_epoch");
        assert_eq!(lease.apply(&renew(1, 3000), 20).code, "bad_frame");
        assert_eq!(lease.apply(&renew(5, 3001), 20).code, "bad_ttl");
        assert_eq!(lease.apply(&renew(5, 0), 20).code, "bad_ttl");
        assert_eq!(lease.inspect().valid_until, 3010);
        let mut other = renew(5, 3000);
        if let Value::Object(entries) = &mut other {
            entries[2].1 = text("g2");
        }
        assert_eq!(lease.apply(&other, 20).code, "wrong_grant");
    }

    #[test]
    fn revoke_is_accepted_at_any_epoch_and_is_sticky() {
        let mut lease = keeper(0);
        assert!(lease.apply(&renew(7, 3000), 10).accepted);
        assert_eq!(lease.apply(&revoke(2), 20), ApplyResult { accepted: true, code: "ok" });
        assert_eq!(lease.inspect().epoch, 7);
        assert_eq!(lease.inspect().reason.as_deref(), Some("root_unbound"));
        assert_eq!(lease.apply(&renew(8, 3000), 30).code, "revoked");
        assert_eq!(lease.poll(30), (LeaseState::Revoking, Some(LeaseAction::SignalRevoke)));
    }

    #[test]
    fn server_exit_before_grace_suppresses_kill() {
        let mut lease = keeper(0);
        lease.apply(&revoke(2), 0);
        assert_eq!(lease.poll(0).1, Some(LeaseAction::SignalRevoke));
        lease.server_exited();
        assert_eq!(lease.poll(10_000), (LeaseState::Killed, None));
        let mut live = keeper(0);
        live.server_exited();
        assert_eq!(live.inspect().reason.as_deref(), Some("server_exited"));
    }

    #[test]
    fn naive_epochless_keeper_negative_control() {
        // A keeper that ignores epochs lets a replayed renew extend the lease; the real one refuses it.
        let replay = renew(2, 3000);
        let mut real = keeper(0);
        assert!(real.apply(&replay, 2000).accepted);
        assert!(!real.apply(&replay, 4000).accepted);
        assert_eq!(real.poll(5000).1, Some(LeaseAction::SignalRevoke));
        let mut naive_valid_until = 3000u64;
        for now in [2000u64, 4000] {
            if now < naive_valid_until {
                naive_valid_until = now + 3000;
            }
        }
        assert!(naive_valid_until > 5000, "the naive model keeps serving past the real expiry");
    }

    #[test]
    fn initial_lease_checks() {
        let limits = ViewLimits::default();
        assert_eq!(RootLeaseKeeper::new("g1", 2, 3000, 0, limits).unwrap_err(), LeaseInitError::BadInitial);
        assert_eq!(RootLeaseKeeper::new("g1", 1, 3001, 0, limits).unwrap_err(), LeaseInitError::BadInitial);
        assert_eq!(RootLeaseKeeper::new("G1", 1, 3000, 0, limits).unwrap_err(), LeaseInitError::BadGrant);
    }
}

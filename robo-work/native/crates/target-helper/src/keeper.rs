//! Target keeper launch (plan section 5.6: "creates one target keeper per execution"; slice P8).
//!
//! A [`KeeperLauncher`] is the journal's effect provider ([`Hooks`]) plus what the `serve` role needs around it:
//! availability before any journal write, a check of each new prepare before the journal persists it, and a
//! non-blocking report of executions whose processes ended (workload exit or keeper loss), which the service journals.
//!
//! | Launcher | Use |
//! |---|---|
//! | `supervisor::KeeperSupervisor` (Linux) | The production launcher: one `keeper serve` child per execution (see `supervisor`) |
//! | [`UnavailableUntilG1`] | Refuses every mutation `keeper_unavailable` before the journal (no keeper; tests) |
//! | [`ProofFixtureNoKeeper`] | PROOF-FIXTURE test launcher (feature `proof-fixture`): launches nothing |

use crate::Code;
use crate::canon::Value;
use crate::journal::{CrashPoint, HookFailure, Hooks, NoEffects, ResourceSpec};

/// How an execution's processes ended, as the launcher observed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EndKind {
    /// The workload exited (the keeper's one `exit` event): exit code or signal name.
    Exited { code: Option<i64>, signal: Option<String> },
    /// The keeper died or its channel failed; every process of the execution is verified absent.
    KeeperLost,
    /// The execution exceeded its output bound and must be stopped.
    OutputLimit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    /// The canonical OperationKey text (`journal::key_text`).
    pub key_text: String,
    pub kind: EndKind,
}

/// The launch capability the `serve` role consults around every journal mutation.
pub trait KeeperLauncher: Hooks {
    /// Whether gated creation can run at all for this helper incarnation.
    fn available(&self) -> Result<(), Code>;
    /// Checks a prepare that may create (a new key, or `retry`: a `reserved` record whose first create may have run)
    /// before the journal sees it, and keeps the workload for `Hooks::create`. Refusals here leave the journal untouched.
    fn admit_prepare(&mut self, _key_text: &str, _resources: &Value, _workload: Option<&Value>, _retry: bool) -> Result<(), Code> {
        Ok(())
    }
    /// Whether every process of the key's execution is verifiably gone. Only verified absence lets the service journal
    /// `exited` after a stop or record a resource release; `Ok(false)` leaves the record `stopping`. Launchers without
    /// processes answer `true`.
    fn absence_verified(&mut self, _key_text: &str) -> Result<bool, Code> {
        Ok(true)
    }
    /// Non-blocking: reads keeper channels and streams, and returns the executions that ended since the last call.
    fn take_ended(&mut self, _now_ms: i64) -> Vec<Ended> {
        Vec::new()
    }
    /// Descriptors whose readiness means `take_ended` has work (Linux `poll`).
    fn poll_fds(&self) -> Vec<i32> {
        Vec::new()
    }
    /// The record was settled `quarantined` (the operator's explicit acceptance of unknown state; absence is never
    /// claimed). The launcher may give up tracking the execution once its own child processes are reaped.
    fn quarantined(&mut self, _key_text: &str) {}
    /// Short label for the ready line.
    fn label(&self) -> &'static str;
    /// Whether `serve` reconciles every unsettled record before readiness (the keeper supervisor: a new helper process
    /// holds no keeper of any earlier one).
    fn reconcile_on_start(&self) -> bool {
        false
    }
}

/// A launcher that refuses every mutation before the journal: there is no keeper to launch.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableUntilG1;

impl Hooks for UnavailableUntilG1 {
    fn create(&mut self, key_text: &str, resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        NoEffects.create(key_text, resources)
    }
    fn release_gate(&mut self, key_text: &str) -> Result<(), HookFailure> {
        NoEffects.release_gate(key_text)
    }
    fn stop(&mut self, key_text: &str) -> Result<(), HookFailure> {
        NoEffects.stop(key_text)
    }
    fn release(&mut self, key_text: &str, resource_id: &str) -> Result<(), HookFailure> {
        NoEffects.release(key_text, resource_id)
    }
    fn crash_at(&mut self, point: CrashPoint) -> bool {
        NoEffects.crash_at(point)
    }
}

impl KeeperLauncher for UnavailableUntilG1 {
    fn available(&self) -> Result<(), Code> {
        Err(Code::KeeperUnavailable)
    }
    fn label(&self) -> &'static str {
        "unavailable"
    }
}

/// PROOF-FIXTURE ONLY (feature `proof-fixture`, slice P6b): reports gated creation as available so the journal round trip
/// (prepare, commit, lookup) can be exercised over the authenticated mailbox on a host without a keeper. It launches
/// nothing: its effects ([`crate::journal::FixtureEffects`]) return synthetic identity digests and accept the gate
/// release without any process, so a receipt it produces names no real keeper. Test-only since slice P8 (the rwtarget
/// launcher uses the keeper supervisor); never a production launcher, and the default build does not contain it.
#[cfg(feature = "proof-fixture")]
#[derive(Clone, Copy, Debug, Default)]
pub struct ProofFixtureNoKeeper;

#[cfg(feature = "proof-fixture")]
impl Hooks for ProofFixtureNoKeeper {
    fn create(&mut self, key_text: &str, resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        crate::journal::FixtureEffects.create(key_text, resources)
    }
    fn release_gate(&mut self, key_text: &str) -> Result<(), HookFailure> {
        crate::journal::FixtureEffects.release_gate(key_text)
    }
    fn stop(&mut self, key_text: &str) -> Result<(), HookFailure> {
        crate::journal::FixtureEffects.stop(key_text)
    }
    fn release(&mut self, key_text: &str, resource_id: &str) -> Result<(), HookFailure> {
        crate::journal::FixtureEffects.release(key_text, resource_id)
    }
}

#[cfg(feature = "proof-fixture")]
impl KeeperLauncher for ProofFixtureNoKeeper {
    fn available(&self) -> Result<(), Code> {
        Ok(())
    }
    fn label(&self) -> &'static str {
        "proof-fixture-no-keeper"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unavailable_launcher_refuses_and_its_effects_fail() {
        let mut launcher = UnavailableUntilG1;
        assert_eq!(launcher.available(), Err(Code::KeeperUnavailable));
        assert_eq!(Code::KeeperUnavailable.as_str(), "keeper_unavailable");
        assert!(launcher.create("k", &[]).is_err() && launcher.stop("k").is_err());
        assert!(launcher.take_ended(0).is_empty() && launcher.poll_fds().is_empty());
    }
}

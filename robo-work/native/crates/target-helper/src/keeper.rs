//! Target keeper launch (plan section 5.6: "creates one target keeper per execution").
//!
//! Not wired before G1: the keeper's Linux process launch and domain construction (`keeper/src/linux/os.rs`,
//! `domain.rs`) still fail closed and belong to the G1 writer. Until then the helper refuses every operation that would
//! create, release or stop target work **before** touching the journal, so no record exists whose gated create could not
//! run (the journal's `reserved` state means "create may have happened").

use crate::Code;

/// The launch capability the `serve` role consults before a `prepare`/`commit`/`stop`/`release` mutation.
pub trait KeeperLauncher {
    /// Whether gated creation can run at all for this helper incarnation.
    fn available(&self) -> Result<(), Code>;
}

/// The only launcher before G1.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableUntilG1;

impl KeeperLauncher for UnavailableUntilG1 {
    fn available(&self) -> Result<(), Code> {
        Err(Code::KeeperUnavailable)
    }
}

/// PROOF-FIXTURE ONLY (feature `proof-fixture`, slice P6b): reports gated creation as available so the journal round trip
/// (prepare, commit, lookup) can be exercised over the authenticated mailbox before G1. It launches nothing: its effects
/// ([`crate::journal::FixtureEffects`]) return synthetic identity digests and accept the gate release without any process,
/// so a receipt it produces names no real keeper. Never a production launcher; the default build does not contain it.
#[cfg(feature = "proof-fixture")]
#[derive(Clone, Copy, Debug, Default)]
pub struct ProofFixtureNoKeeper;

#[cfg(feature = "proof-fixture")]
impl KeeperLauncher for ProofFixtureNoKeeper {
    fn available(&self) -> Result<(), Code> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_refuses_until_g1() {
        assert_eq!(UnavailableUntilG1.available(), Err(Code::KeeperUnavailable));
        assert_eq!(Code::KeeperUnavailable.as_str(), "keeper_unavailable");
    }
}

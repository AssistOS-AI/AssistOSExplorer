//! The helper service core behind authenticated frames: journal operations gated on keeper availability.
//!
//! Before G1 the launcher refuses, so `prepare`, `commit`, `stop` and `release` refuse `keeper_unavailable` before any
//! journal access: no record is written whose gated create could not run. `lookup` (and `input`, which needs a running
//! record that cannot exist yet) go to the journal, so recovery reads keep their exact semantics, including
//! `journal_unavailable` for a lost or replaced journal.
//!
//! The effects the journal runs come with the launcher: [`TargetService::new`] always uses `NoEffects`; only the
//! proof-fixture build can pair `keeper::ProofFixtureNoKeeper` with `journal::FixtureEffects` ([`TargetService::proof_fixture`]).

use crate::Code;
use crate::canon::Value;
use crate::journal::{Hooks, Journal, NoEffects};
use crate::keeper::KeeperLauncher;

pub struct TargetService<L: KeeperLauncher> {
    journal: Journal,
    launcher: L,
    effects: Box<dyn Hooks>,
}

#[cfg(feature = "proof-fixture")]
impl TargetService<crate::keeper::ProofFixtureNoKeeper> {
    /// PROOF-FIXTURE ONLY: a service whose gated create and gate release succeed without launching anything.
    pub fn proof_fixture(journal: Journal) -> Self {
        TargetService { journal, launcher: crate::keeper::ProofFixtureNoKeeper, effects: Box::new(crate::journal::FixtureEffects) }
    }
}

impl<L: KeeperLauncher> TargetService<L> {
    pub fn new(journal: Journal, launcher: L) -> Self {
        TargetService { journal, launcher, effects: Box::new(NoEffects) }
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    pub fn prepare(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.prepare(request, now, self.effects.as_mut())
    }

    pub fn commit(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.commit(request, now, self.effects.as_mut())
    }

    pub fn stop(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.stop(request, now, self.effects.as_mut())
    }

    pub fn release(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.release(request, now, self.effects.as_mut())
    }

    pub fn lookup(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.journal.lookup(request, now)
    }

    pub fn input(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.journal.input(request, now)
    }
}

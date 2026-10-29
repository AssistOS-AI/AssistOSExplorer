//! The helper service core behind authenticated frames: journal operations gated on keeper availability.
//!
//! Before G1 the launcher refuses, so `prepare`, `commit`, `stop` and `release` refuse `keeper_unavailable` before any
//! journal access: no record is written whose gated create could not run. `lookup` (and `input`, which needs a running
//! record that cannot exist yet) go to the journal, so recovery reads keep their exact semantics, including
//! `journal_unavailable` for a lost or replaced journal.

use crate::Code;
use crate::canon::Value;
use crate::journal::{Journal, NoEffects};
use crate::keeper::KeeperLauncher;

pub struct TargetService<L: KeeperLauncher> {
    journal: Journal,
    launcher: L,
}

impl<L: KeeperLauncher> TargetService<L> {
    pub fn new(journal: Journal, launcher: L) -> Self {
        TargetService { journal, launcher }
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    pub fn prepare(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.prepare(request, now, &mut NoEffects)
    }

    pub fn commit(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.commit(request, now, &mut NoEffects)
    }

    pub fn stop(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.stop(request, now, &mut NoEffects)
    }

    pub fn release(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.release(request, now, &mut NoEffects)
    }

    pub fn lookup(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.journal.lookup(request, now)
    }

    pub fn input(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.journal.input(request, now)
    }
}

//! The helper service core behind authenticated frames: journal operations whose effects are the keeper launcher's.
//!
//! Every mutation first asks the launcher whether gated creation can run at all (`keeper_unavailable` refuses before any
//! journal access, so no record is written whose gated create could not run). A prepare that may create (a new key, or
//! a `reserved` record that may be retried) is also checked by the launcher before the journal persists it (resource
//! kinds, workload, `executionsPerTarget`). `lookup` (and `input`, which needs a running record) go to the journal, so
//! recovery reads keep their exact semantics, including `journal_unavailable` for a lost or replaced journal.
//!
//! Slice P8 adds what the serve loop journals on its own:
//!
//! | Trigger | Journal effect |
//! |---|---|
//! | Workload exit reported by the launcher | `observe_exit` once absence is verified |
//! | Keeper loss or output bound reported by the launcher | `stop`, then `observe_exit` once absence is verified |
//! | An explicit `stop` | `stop`; `observe_exit` (the reply is the `exited` receipt) only once absence is verified, else the `stopping` receipt |
//! | Startup ([`TargetService::reconcile_at_start`]) | every unsettled record of any incarnation: `stop` (delivered where possible), then `observe_exit` only once absence is verified |
//! | Lease expiry ([`TargetService::expire_lease`]) | every unsettled record of that lease: `stop`, then `observe_exit` once absence is verified |
//!
//! "Stop delivered, absence unverified" leaves the record in `stopping` (which blocks any later create): an execution
//! whose end could not be verified, an execution of another or an unknown PID namespace, a key without an attempt record
//! (it may have spawned) or an unverifiable attempt store. `release` with verified-absent evidence then refuses
//! `absence_unverified` before the journal. Releasing every resource as `quarantine` (the journal skips the release
//! effect) stays the operator path. A prepare the launcher cannot launch safely (unverifiable attempt store, unusable
//! runtime base) is refused `keeper_unavailable` before the journal write.
//!
//! A stopped record is never created again (the journal skips `create` for it), so a retried prepare after any of these
//! cannot launch a second tree.

use crate::Code;
use crate::canon::{Value, obj, s};
use crate::journal::{Journal, RecordView, key_text};
use crate::keeper::{EndKind, KeeperLauncher};

pub struct TargetService<L: KeeperLauncher> {
    journal: Journal,
    launcher: L,
}

#[cfg(feature = "proof-fixture")]
impl TargetService<crate::keeper::ProofFixtureNoKeeper> {
    /// PROOF-FIXTURE ONLY: a service whose gated create and gate release succeed without launching anything (tests).
    pub fn proof_fixture(journal: Journal) -> Self {
        TargetService { journal, launcher: crate::keeper::ProofFixtureNoKeeper }
    }
}

/// One thing the service journaled on its own (diagnostics: names and codes only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Journaled {
    pub key_text: String,
    pub cause: &'static str,
    /// The record state afterwards, or the refusal code.
    pub outcome: Result<String, Code>,
}

impl<L: KeeperLauncher> TargetService<L> {
    pub fn new(journal: Journal, launcher: L) -> Self {
        TargetService { journal, launcher }
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    pub fn launcher(&self) -> &L {
        &self.launcher
    }

    pub fn launcher_mut(&mut self) -> &mut L {
        &mut self.launcher
    }

    /// `prepare` without a workload (the journal round trip of the test launchers).
    pub fn prepare(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.prepare_workload(request, None, now)
    }

    /// `prepare` with the workload of the prepare body (slice P8).
    pub fn prepare_workload(&mut self, request: &Value, workload: Option<&Value>, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        // Only a prepare that may create is checked (and its workload kept); an identical retry of a created record
        // returns its receipt from the journal whatever the launcher's current capacity.
        let (may_create, retry) = match self.journal.peek(&key)? {
            None => (!self.journal_has_tombstone(&key)?, false),
            Some(view) => (view.state == "reserved" && !view.created && !view.stopped, true),
        };
        if may_create {
            let resources = request.get("resources").cloned().unwrap_or(Value::Null);
            self.launcher.admit_prepare(&text, &resources, workload, retry)?;
        }
        self.journal.prepare(request, now, &mut self.launcher)
    }

    fn journal_has_tombstone(&mut self, key: &Value) -> Result<bool, Code> {
        // A tombstone is not a record (`peek` is None) but lookup still names it.
        let probe = obj(vec![("key", key.clone()), ("targetBindingDigest", s(&"0".repeat(64)))]);
        let found = self.journal.lookup(&probe, 0)?;
        Ok(found.str_at("state") != Some("absent-with-proof"))
    }

    pub fn commit(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        self.journal.commit(request, now, &mut self.launcher)
    }

    /// `stop`; only when the launcher verifies the tree gone is the record journaled `exited` and that receipt returned,
    /// otherwise the `stopping` receipt.
    pub fn stop(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        let receipt = self.journal.stop(request, now, &mut self.launcher)?;
        if receipt.str_at("state") == Some("stopping") {
            let key = request.get("key").cloned().unwrap_or(Value::Null);
            if self.launcher.absence_verified(&key_text(&key)?)? {
                return self.journal.observe_exit(&obj(vec![("key", key)]), now);
            }
        }
        Ok(receipt)
    }

    /// `release`. Verified-absent evidence for a record with unreleased resources needs the launcher's own verified
    /// absence (`absence_unverified` otherwise, before the journal); all-`quarantine` evidence goes straight to the journal.
    pub fn release(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.launcher.available()?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let claims_absence = request
            .get("evidence")
            .and_then(|evidence| evidence.get("resources"))
            .and_then(Value::arr)
            .is_some_and(|entries| entries.iter().any(|entry| entry.str_at("kind") == Some("verified-absent")));
        if claims_absence {
            if let Some(view) = self.journal.peek(&key)? {
                let unreleased = view.resources.iter().any(|(_, _, state)| state != "released" && state != "quarantined");
                if unreleased && !self.launcher.absence_verified(&key_text(&key)?)? {
                    return Err(Code::AbsenceUnverified);
                }
            }
        }
        self.journal.release(request, now, &mut self.launcher)
    }

    pub fn lookup(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.journal.lookup(request, now)
    }

    pub fn input(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.journal.input(request, now)
    }

    /// The record's lease, if the key has a record.
    pub fn record_lease(&self, key: &Value) -> Result<Option<String>, Code> {
        Ok(self.journal.peek(key)?.map(|view| view.lease_id))
    }

    /// Stops (when asked) and journals `exited` only once absence is verified. Returns the record state afterwards
    /// (`stopping` or `running`: absence unverified).
    fn settle(&mut self, key: &Value, now: i64, stop_first: bool) -> Result<String, Code> {
        let mut state = None;
        if stop_first {
            let receipt = self.journal.stop(&obj(vec![("key", key.clone())]), now, &mut self.launcher)?;
            state = receipt.str_at("state").map(str::to_string);
        }
        if !self.launcher.absence_verified(&key_text(key)?)? {
            return match state {
                Some(state) => Ok(state),
                None => Ok(self.journal.peek(key)?.map(|view| view.state).unwrap_or_default()),
            };
        }
        let receipt = self.journal.observe_exit(&obj(vec![("key", key.clone())]), now)?;
        Ok(receipt.str_at("state").unwrap_or_default().to_string())
    }

    /// Journals what the launcher observed since the last call (non-blocking apart from bounded keeper teardown).
    pub fn pump(&mut self, now: i64) -> Vec<Journaled> {
        let ended = self.launcher.take_ended(now);
        let mut out = Vec::new();
        for item in ended {
            let key = match crate::canon::parse_canonical(item.key_text.as_bytes(), crate::canon::OBJECT_BYTES) {
                Ok(key) => key,
                Err(code) => {
                    out.push(Journaled { key_text: item.key_text, cause: "unparsable", outcome: Err(code) });
                    continue;
                }
            };
            let (cause, stop_first) = match item.kind {
                EndKind::Exited { .. } => ("workload_exit", false),
                EndKind::KeeperLost => ("keeper_lost", true),
                EndKind::OutputLimit => ("output_limit", true),
            };
            let outcome = self.settle(&key, now, stop_first);
            out.push(Journaled { key_text: item.key_text, cause, outcome });
        }
        out
    }

    fn settle_all(&mut self, records: Vec<RecordView>, now: i64, cause: &'static str) -> Vec<Journaled> {
        records
            .into_iter()
            .map(|view| {
                let outcome = self.settle(&view.key, now, !view.stopped);
                Journaled { key_text: view.key_text, cause, outcome }
            })
            .collect()
    }

    /// Startup, before readiness: every unsettled record is stopped (its absence verified by the launcher) and journaled
    /// exited. Records whose absence cannot be verified stay as they are and are reported.
    pub fn reconcile_at_start(&mut self, now: i64) -> Result<Vec<Journaled>, Code> {
        let records = self.journal.unsettled()?;
        Ok(self.settle_all(records, now, "startup_reconcile"))
    }

    /// A lease expired: only its unsettled records are stopped and journaled exited.
    pub fn expire_lease(&mut self, lease_id: &str, now: i64) -> Result<Vec<Journaled>, Code> {
        let records: Vec<RecordView> = self.journal.unsettled()?.into_iter().filter(|view| view.lease_id == lease_id).collect();
        Ok(self.settle_all(records, now, "lease_expired"))
    }

    pub fn poll_fds(&self) -> Vec<i32> {
        self.launcher.poll_fds()
    }
}

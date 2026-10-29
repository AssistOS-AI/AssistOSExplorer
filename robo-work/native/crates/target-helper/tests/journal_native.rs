//! File-backed journal properties the in-memory oracle cannot show: provisioning versus opening, the store lock, crash
//! reopen and head reconciliation, loss/replacement/tampering never read as absence, the byte budget, hook failures,
//! the documented differences from the model, and the pre-G1 service gate.

mod common;

use std::path::Path;
use std::time::Duration;

use rw_target_helper::Code;
use rw_target_helper::canon::{self, Value, obj, s};
use rw_target_helper::crypto::{b64url_encode, sha256_hex};
use rw_target_helper::journal::{HookFailure, Hooks, Journal, JournalLimits, RECORD_BUDGET_BYTES, ResourceSpec};
use rw_target_helper::keeper::UnavailableUntilG1;
use rw_target_helper::service::TargetService;

fn id(label: &str) -> String {
    b64url_encode(&rw_target_helper::crypto::sha256(format!("native-id:{label}").as_bytes())[..16])
}

fn dg(label: &str) -> String {
    sha256_hex(format!("native-digest:{label}").as_bytes())
}

fn key(label: &str) -> Value {
    obj(vec![
        ("workspaceId", s("ws-native")),
        ("workerGeneration", s(&id("gen"))),
        ("executionId", s(&id("exec"))),
        ("attemptId", s(&id("attempt"))),
        ("operationId", s(&id(&format!("op-{label}")))),
    ])
}

fn prepare_request(label: &str, store: &str) -> Value {
    prepare_request_with(label, store, 1)
}

fn prepare_request_with(label: &str, store: &str, resources: usize) -> Value {
    let resources = (0..resources)
        .map(|index| obj(vec![("resourceId", s(&id(&format!("{label}-r{index}")))), ("kind", s("process-tree")), ("locatorDigest", s(&dg(&format!("{label}-r{index}"))))]))
        .collect();
    obj(vec![
        ("key", key(label)),
        ("targetBindingDigest", s(&dg("binding"))),
        ("reservationId", s(&id("reservation"))),
        ("requestDigest", s(&dg(&format!("request-{label}")))),
        ("leaseId", s(&id(&format!("lease-{label}")))),
        ("journalStoreIdentity", s(store)),
        ("resources", Value::Arr(resources)),
    ])
}

fn verified_evidence(label: &str, receipt: &Value) -> Value {
    let resources = receipt
        .get("resources")
        .unwrap()
        .arr()
        .unwrap()
        .iter()
        .map(|resource| {
            obj(vec![
                ("resourceId", resource.get("resourceId").unwrap().clone()),
                ("kind", s("verified-absent")),
                ("evidenceDigest", s(&dg(&format!("absent-{label}-{}", resource.str_at("resourceId").unwrap())))),
            ])
        })
        .collect();
    obj(vec![("key", key(label)), ("evidence", obj(vec![("resources", Value::Arr(resources))]))])
}

fn lookup_request(label: &str) -> Value {
    obj(vec![("key", key(label)), ("targetBindingDigest", s(&dg("binding")))])
}

fn commit_request(label: &str, receipt: &Value) -> Value {
    obj(vec![
        ("key", key(label)),
        ("targetBindingDigest", s(&dg("binding"))),
        ("reservationId", s(&id("reservation"))),
        ("preparedReceiptSequence", receipt.get("receiptSequence").unwrap().clone()),
        ("preparedResourcesDigest", s(&canon::digest(receipt.get("resources").unwrap(), 1 << 20).unwrap())),
        ("workerCommitDigest", s(&dg(&format!("commit-{label}")))),
    ])
}

#[derive(Default)]
struct Recorder {
    creates: usize,
    gate_releases: usize,
    stops: usize,
    releases: Vec<String>,
    fail_create: bool,
    fail_gate: bool,
    /// Fail the release hook call with this zero-based index (counting every call).
    fail_release_call: Option<usize>,
    release_calls: usize,
}

impl Hooks for Recorder {
    fn create(&mut self, _key_text: &str, resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        if self.fail_create {
            return Err(HookFailure);
        }
        self.creates += 1;
        Ok(resources.iter().map(|resource| dg(&resource.resource_id)).collect())
    }
    fn release_gate(&mut self, _key_text: &str) -> Result<(), HookFailure> {
        if self.fail_gate {
            return Err(HookFailure);
        }
        self.gate_releases += 1;
        Ok(())
    }
    fn stop(&mut self, _key_text: &str) -> Result<(), HookFailure> {
        self.stops += 1;
        Ok(())
    }
    fn release(&mut self, _key_text: &str, resource_id: &str) -> Result<(), HookFailure> {
        let call = self.release_calls;
        self.release_calls += 1;
        if self.fail_release_call == Some(call) {
            return Err(HookFailure);
        }
        self.releases.push(resource_id.to_string());
        Ok(())
    }
}

const WAIT: Duration = Duration::from_millis(50);

fn provisioned(label: &str) -> (std::path::PathBuf, String) {
    let root = common::temp_dir(label);
    let store = Journal::create(&root).unwrap().journal_store_identity;
    (root, store)
}

fn open(root: &Path, store: &str) -> Result<Journal, Code> {
    Journal::open(root, store, &id("helper"), JournalLimits::default(), WAIT)
}

fn records(root: &Path) -> Vec<std::path::PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(root.join("journal/records")).unwrap().map(|entry| entry.unwrap().path()).collect();
    paths.sort();
    paths
}

#[test]
fn open_never_creates_and_provisioning_mints_a_fresh_identity_once() {
    let root = common::temp_dir("provision");
    assert_eq!(open(&root, &id("store")).err(), Some(Code::JournalUnavailable));
    assert!(!root.join("journal").exists(), "open created nothing");
    assert_eq!(Journal::create(&root.join("missing")).err(), Some(Code::JournalUnavailable));
    let first = Journal::create(&root).unwrap();
    let store = first.journal_store_identity.clone();
    assert!(rw_target_helper::contract::is_id_text(&store));
    // Provisioning again reports the existing store; it never mints over it.
    assert_eq!(Journal::create(&root).unwrap(), first);
    assert_ne!(Journal::create(&common::temp_dir("provision-other")).unwrap().journal_store_identity, store, "identities are fresh");
    assert_eq!(Journal::create_with_identity_for_tests(&root, &id("other")).err(), Some(Code::OperationConflict));
    assert_eq!(Journal::create_with_identity_for_tests(&root, "not-an-id").err(), Some(Code::InvalidRequest));
    assert_eq!(open(&root, &id("other")).err(), Some(Code::JournalUnavailable));
    assert_eq!(Journal::open(&root, &store, "bad", JournalLimits::default(), WAIT).err(), Some(Code::InvalidRequest));
    let lowered = JournalLimits { retention_ms: 1, ..JournalLimits::default() };
    assert_eq!(Journal::open(&root, &store, &id("helper"), lowered, WAIT).err(), Some(Code::InvalidRequest));
    // An interrupted creation is swept by the next one.
    let other_root = common::temp_dir("provision-swept");
    std::fs::create_dir(other_root.join(format!(".creating-{store}"))).unwrap();
    Journal::create(&other_root).unwrap();
    assert!(!other_root.join(format!(".creating-{store}")).exists());
    let journal = open(&root, &store).unwrap();
    assert_eq!((journal.size(), journal.revision()), (0, 0));
}

#[test]
fn one_handle_per_store_while_the_lock_is_held() {
    let (root, store) = provisioned("lock");
    let first = open(&root, &store).unwrap();
    assert_eq!(open(&root, &store).err(), Some(Code::JournalUnavailable));
    drop(first);
    assert!(open(&root, &store).is_ok());
}

#[test]
fn reopen_after_a_crash_keeps_records_revision_and_absence_proof() {
    let (root, store) = provisioned("reopen");
    let mut hooks = Recorder::default();
    let mut journal = open(&root, &store).unwrap();
    let prepared = journal.prepare(&prepare_request("a", &store), 10, &mut hooks).unwrap();
    journal.commit(&commit_request("a", &prepared), 11, &mut hooks).unwrap();
    let before = journal.lookup(&lookup_request("a"), 12).unwrap();
    let absent = journal.lookup(&lookup_request("never"), 12).unwrap();
    let revision = journal.revision();
    drop(journal);
    let mut journal = open(&root, &store).unwrap();
    assert_eq!(journal.revision(), revision);
    assert_eq!(journal.size(), 1);
    assert_eq!(journal.lookup(&lookup_request("a"), 12).unwrap(), before);
    assert_eq!(journal.lookup(&lookup_request("never"), 12).unwrap(), absent);
    // Dedupe survives the restart: no second create or gate release.
    journal.prepare(&prepare_request("a", &store), 13, &mut hooks).unwrap();
    journal.commit(&commit_request("a", &prepared), 13, &mut hooks).unwrap();
    assert_eq!((hooks.creates, hooks.gate_releases), (1, 1));
}

fn write_head(root: &Path, store: &str, revision: u64, entries: i64) {
    let head = obj(vec![("version", Value::Int(1)), ("journalStoreIdentity", s(store)), ("revision", s(&revision.to_string())), ("entries", Value::Int(entries))]);
    std::fs::write(root.join("journal/head.json"), canon::canonical_text(&head).unwrap()).unwrap();
}

#[test]
fn a_head_one_revision_behind_is_reconciled_anything_else_is_state_corrupt() {
    let (root, store) = provisioned("head");
    let mut journal = open(&root, &store).unwrap();
    journal.prepare(&prepare_request("a", &store), 1, &mut Recorder::default()).unwrap();
    journal.prepare(&prepare_request("b", &store), 1, &mut Recorder::default()).unwrap();
    let revision = journal.revision();
    drop(journal);
    // A crash after a new record was published and before the head was rewritten.
    write_head(&root, &store, revision - 1, 1);
    let journal = open(&root, &store).unwrap();
    assert_eq!((journal.revision(), journal.size()), (revision, 2));
    drop(journal);
    write_head(&root, &store, revision - 2, 2);
    assert_eq!(open(&root, &store).err(), Some(Code::StateCorrupt));
    write_head(&root, &store, revision, 3);
    assert_eq!(open(&root, &store).err(), Some(Code::StateCorrupt));
    write_head(&root, &store, revision, 2);
    // A stale temporary file of an interrupted write is swept at open.
    std::fs::write(root.join("journal/records/.tmp-1-1"), b"partial").unwrap();
    assert!(open(&root, &store).is_ok());
    assert!(!root.join("journal/records/.tmp-1-1").exists());
}

#[test]
fn deleted_copied_or_foreign_entries_are_state_corrupt_never_absence() {
    let (root, store) = provisioned("tamper");
    let mut journal = open(&root, &store).unwrap();
    journal.prepare(&prepare_request("a", &store), 1, &mut Recorder::default()).unwrap();
    journal.prepare(&prepare_request("b", &store), 1, &mut Recorder::default()).unwrap();
    let files = records(&root);
    assert_eq!(files.len(), 2);
    // Under a live handle: a vanished key file is state_corrupt, not absent-with-proof.
    let saved = std::fs::read(&files[0]).unwrap();
    std::fs::remove_file(&files[0]).unwrap();
    let vanished = [lookup_request("a"), lookup_request("b")].iter().map(|request| journal.lookup(request, 2)).collect::<Vec<_>>();
    assert!(vanished.contains(&Err(Code::StateCorrupt)), "{vanished:?}");
    drop(journal);
    assert_eq!(open(&root, &store).err(), Some(Code::StateCorrupt));
    std::fs::write(&files[0], &saved).unwrap();
    assert!(open(&root, &store).is_ok());
    // A copy under another key's name.
    let copy = root.join("journal/records").join(format!("{}.json", "0".repeat(64)));
    std::fs::write(&copy, &saved).unwrap();
    assert_eq!(open(&root, &store).err(), Some(Code::StateCorrupt));
    std::fs::remove_file(&copy).unwrap();
    // An entry of another store.
    let text = String::from_utf8(saved.clone()).unwrap().replace(&store, &id("elsewhere"));
    std::fs::write(&files[0], text).unwrap();
    assert_eq!(open(&root, &store).err(), Some(Code::StateCorrupt));
    std::fs::write(&files[0], &saved).unwrap();
    // A malformed entry.
    std::fs::write(&files[1], b"{}").unwrap();
    assert_eq!(open(&root, &store).err(), Some(Code::StateCorrupt));
}

#[test]
fn a_lost_journal_is_never_reprovisioned_under_its_old_identity() {
    let (root, store) = provisioned("reprovision");
    let mut hooks = Recorder::default();
    let mut journal = open(&root, &store).unwrap();
    journal.prepare(&prepare_request("k", &store), 1, &mut hooks).unwrap();
    drop(journal);
    std::fs::remove_dir_all(root.join("journal")).unwrap();
    // A fresh provisioning run (the CLI path) after the loss.
    let fresh = Journal::create(&root).unwrap();
    assert_ne!(fresh.journal_store_identity, store);
    // A fresh process expecting the old store cannot open the new one.
    assert_eq!(open(&root, &store).err(), Some(Code::JournalUnavailable));
    // The new store's absence proof names the new identity, never the old one, and the old request cannot run there.
    let mut journal = open(&root, &fresh.journal_store_identity).unwrap();
    let absent = journal.lookup(&lookup_request("k"), 2).unwrap();
    assert_eq!(absent.str_at("state"), Some("absent-with-proof"));
    assert_eq!(absent.str_at("journalStoreIdentity"), Some(fresh.journal_store_identity.as_str()));
    assert_eq!(journal.prepare(&prepare_request("k", &store), 2, &mut hooks), Err(Code::JournalUnavailable));
    assert_eq!(hooks.creates, 1);
}

#[test]
fn a_swapped_or_replaced_directory_is_journal_unavailable_even_with_the_same_identity() {
    let (root, store) = provisioned("swap");
    let mut journal = open(&root, &store).unwrap();
    journal.prepare(&prepare_request("a", &store), 1, &mut Recorder::default()).unwrap();
    std::fs::rename(root.join("journal"), root.join("moved")).unwrap();
    // Only a fixture can force the same identity; the handle still refuses by directory identity.
    Journal::create_with_identity_for_tests(&root, &store).unwrap();
    assert_eq!(journal.verify(), Err(Code::JournalUnavailable));
    assert_eq!(journal.lookup(&lookup_request("a"), 2), Err(Code::JournalUnavailable));
    assert_eq!(journal.prepare(&prepare_request("b", &store), 2, &mut Recorder::default()), Err(Code::JournalUnavailable));
    // A replaced records directory inside the same journal directory.
    let (root, store) = provisioned("swap-records");
    let journal = open(&root, &store).unwrap();
    std::fs::rename(root.join("journal/records"), root.join("journal/old-records")).unwrap();
    std::fs::create_dir(root.join("journal/records")).unwrap();
    assert_eq!(journal.verify(), Err(Code::JournalUnavailable));
}

#[test]
fn hook_failures_are_outcome_unknown_and_never_replay_a_gate_release() {
    let (root, store) = provisioned("hooks");
    let mut journal = open(&root, &store).unwrap();
    let mut hooks = Recorder { fail_create: true, ..Recorder::default() };
    assert_eq!(journal.prepare(&prepare_request("a", &store), 1, &mut hooks), Err(Code::OutcomeUnknown));
    let reserved = journal.lookup(&lookup_request("a"), 1).unwrap();
    assert_eq!(reserved.str_at("state"), Some("reserved"));
    hooks.fail_create = false;
    let prepared = journal.prepare(&prepare_request("a", &store), 2, &mut hooks).unwrap();
    assert_eq!((prepared.str_at("state"), hooks.creates), (Some("prepared"), 1));
    hooks.fail_gate = true;
    assert_eq!(journal.commit(&commit_request("a", &prepared), 3, &mut hooks), Err(Code::OutcomeUnknown));
    hooks.fail_gate = false;
    let committed = journal.commit(&commit_request("a", &prepared), 4, &mut hooks).unwrap();
    assert_eq!((committed.str_at("state"), committed.get("gateReleased")), (Some("running"), Some(&Value::Bool(true))));
    assert_eq!(hooks.gate_releases, 0, "an uncertain gate release is never replayed");
}

#[test]
fn a_stopped_operation_is_never_created_by_a_retried_prepare() {
    // Deliberate difference from journalModel.mjs, whose create() would run and report `prepared`.
    let (root, store) = provisioned("stopped");
    let mut journal = open(&root, &store).unwrap();
    let mut hooks = Recorder { fail_create: true, ..Recorder::default() };
    assert_eq!(journal.prepare(&prepare_request("a", &store), 1, &mut hooks), Err(Code::OutcomeUnknown));
    hooks.fail_create = false;
    let stopped = journal.stop(&obj(vec![("key", key("a"))]), 2, &mut hooks).unwrap();
    assert_eq!(stopped.str_at("state"), Some("stopping"));
    assert_eq!(hooks.stops, 1, "a possibly created operation is stopped");
    let retried = journal.prepare(&prepare_request("a", &store), 3, &mut hooks).unwrap();
    assert_eq!((retried.str_at("state"), hooks.creates), (Some("stopping"), 0));
}

#[test]
fn a_refused_input_on_a_new_connection_leaves_no_cursor() {
    // Deliberate difference from journalModel.mjs, which keeps a phantom {0, acknowledged} cursor.
    let (root, store) = provisioned("cursor");
    let mut journal = open(&root, &store).unwrap();
    let mut hooks = Recorder::default();
    let prepared = journal.prepare(&prepare_request("a", &store), 1, &mut hooks).unwrap();
    journal.commit(&commit_request("a", &prepared), 1, &mut hooks).unwrap();
    let input = obj(vec![("key", key("a")), ("connectionId", s(&id("conn"))), ("offset", s("5")), ("bytesDigest", s(&dg("bytes"))), ("byteLength", Value::Int(1))]);
    assert_eq!(journal.input(&input, 2), Err(Code::InvalidRequest));
    let receipt = journal.lookup(&lookup_request("a"), 2).unwrap();
    assert_eq!(receipt.get("receipt").unwrap().get("inputCursors"), Some(&Value::Arr(vec![])));
}

#[test]
fn the_byte_budget_refuses_new_work_and_never_evicts() {
    let root = common::temp_dir("bytes");
    let store = Journal::create(&root).unwrap().journal_store_identity;
    let limits = JournalLimits { journal_bytes: 2 * RECORD_BUDGET_BYTES as u64, ..JournalLimits::default() };
    let mut journal = Journal::open(&root, &store, &id("helper"), limits, WAIT).unwrap();
    let mut hooks = Recorder::default();
    journal.prepare(&prepare_request("a", &store), 1, &mut hooks).unwrap();
    journal.prepare(&prepare_request("b", &store), 1, &mut hooks).unwrap();
    assert_eq!(journal.prepare(&prepare_request("c", &store), 1, &mut hooks), Err(Code::CapacityExceeded));
    assert!(journal.prepare(&prepare_request("a", &store), 2, &mut hooks).is_ok(), "existing identical work reconciles");
    assert_eq!(journal.size(), 2);
}

#[test]
fn the_service_refuses_mutations_before_g1_without_touching_the_journal() {
    let (root, store) = provisioned("service");
    let mut service = TargetService::new(open(&root, &store).unwrap(), UnavailableUntilG1);
    assert_eq!(service.prepare(&prepare_request("a", &store), 1), Err(Code::KeeperUnavailable));
    assert_eq!(service.commit(&obj(vec![("key", key("a"))]), 1), Err(Code::KeeperUnavailable));
    assert_eq!(service.stop(&obj(vec![("key", key("a"))]), 1), Err(Code::KeeperUnavailable));
    assert_eq!(service.release(&obj(vec![("key", key("a"))]), 1), Err(Code::KeeperUnavailable));
    assert_eq!((service.journal().size(), service.journal().revision()), (0, 0));
    assert!(records(&root).is_empty());
    let absent = service.lookup(&lookup_request("a"), 1).unwrap();
    assert_eq!(absent.str_at("state"), Some("absent-with-proof"));
    assert_eq!(service.input(&obj(vec![("key", key("a"))]), 1), Err(Code::NotFound));
}

#[test]
fn a_replaced_lock_file_is_journal_unavailable() {
    let (root, store) = provisioned("lockswap");
    let mut journal = open(&root, &store).unwrap();
    assert_eq!(journal.verify(), Ok(()));
    std::fs::write(root.join("journal/lock.new"), b"").unwrap();
    std::fs::rename(root.join("journal/lock.new"), root.join("journal/lock")).unwrap();
    // Another opener could now lock the replacement; this handle no longer holds the journal's lock and refuses.
    assert_eq!(journal.verify(), Err(Code::JournalUnavailable));
    assert_eq!(journal.lookup(&lookup_request("a"), 1), Err(Code::JournalUnavailable));
    assert_eq!(journal.prepare(&prepare_request("a", &store), 1, &mut Recorder::default()), Err(Code::JournalUnavailable));
}

#[test]
fn a_release_retried_after_a_hook_failure_skips_resources_already_released() {
    let (root, store) = provisioned("release-retry");
    let mut hooks = Recorder::default();
    let mut journal = open(&root, &store).unwrap();
    let prepared = journal.prepare(&prepare_request_with("r", &store, 3), 1, &mut hooks).unwrap();
    journal.commit(&commit_request("r", &prepared), 2, &mut hooks).unwrap();
    journal.stop(&obj(vec![("key", key("r"))]), 3, &mut hooks).unwrap();
    let evidence = verified_evidence("r", &prepared);
    let revision = journal.revision();
    hooks.fail_release_call = Some(1);
    assert_eq!(journal.release(&evidence, 4, &mut hooks), Err(Code::OutcomeUnknown));
    assert_eq!(hooks.releases.len(), 1);
    assert_eq!(journal.revision(), revision, "progress writes do not advance the revision");
    // The progress survives a restart; the record is not settled yet.
    drop(journal);
    let mut journal = open(&root, &store).unwrap();
    let partial = journal.lookup(&lookup_request("r"), 5).unwrap();
    let receipt = partial.get("receipt").unwrap();
    assert_eq!(receipt.str_at("state"), Some("stopping"));
    let states: Vec<&str> = receipt.get("resources").unwrap().arr().unwrap().iter().map(|resource| resource.str_at("state").unwrap()).collect();
    assert_eq!(states.iter().filter(|state| **state == "released").count(), 1);
    hooks.fail_release_call = None;
    let settled = journal.release(&evidence, 6, &mut hooks).unwrap();
    assert_eq!(settled.str_at("state"), Some("exited"));
    assert!(settled.get("resources").unwrap().arr().unwrap().iter().all(|resource| resource.str_at("state") == Some("released")));
    let mut released = hooks.releases.clone();
    released.sort();
    released.dedup();
    assert_eq!((hooks.releases.len(), released.len()), (3, 3), "each resource's release hook succeeded exactly once");
    assert_eq!(journal.revision(), revision + 1, "one settling revision");
}

#[test]
fn input_is_refused_while_the_record_can_still_settle_and_settling_then_succeeds() {
    let root = common::fast_temp_dir("settle-budget");
    let store = Journal::create(&root).unwrap().journal_store_identity;
    let mut hooks = Recorder::default();
    let mut journal = open(&root, &store).unwrap();
    let prepared = journal.prepare(&prepare_request_with("b", &store, 4), 1, &mut hooks).unwrap();
    journal.commit(&commit_request("b", &prepared), 2, &mut hooks).unwrap();
    let connection = id("budget-conn");
    let mut accepted = 0u64;
    let refused = loop {
        assert!(accepted < 20_000, "the per-record budget never refused");
        let input = obj(vec![
            ("key", key("b")),
            ("connectionId", s(&connection)),
            ("offset", s(&accepted.to_string())),
            ("bytesDigest", s(&dg(&format!("chunk-{accepted}")))),
            ("byteLength", Value::Int(1)),
        ]);
        match journal.input(&input, 3) {
            Ok(reply) => {
                accepted += 1;
                journal.confirm_input(&key("b"), &connection, reply.str_at("acceptedThrough").unwrap()).unwrap();
            }
            Err(code) => break code,
        }
    };
    assert_eq!(refused, Code::CapacityExceeded);
    assert!(accepted > 1000, "accepted {accepted}");
    let receipt = journal.lookup(&lookup_request("b"), 4).unwrap();
    let cursors = receipt.get("receipt").unwrap().get("inputCursors").unwrap().arr().unwrap().to_vec();
    assert_eq!(cursors[0].str_at("acceptedThrough"), Some(accepted.to_string().as_str()), "the refused input changed nothing");
    // Every settling write still fits.
    assert_eq!(journal.stop(&obj(vec![("key", key("b"))]), 5, &mut hooks).unwrap().str_at("state"), Some("stopping"));
    assert_eq!(journal.observe_exit(&obj(vec![("key", key("b"))]), 6).unwrap().str_at("state"), Some("exited"));
    let settled = journal.release(&verified_evidence("b", &prepared), 7, &mut hooks).unwrap();
    assert_eq!(settled.str_at("state"), Some("exited"));
    assert_eq!(hooks.releases.len(), 4);
    let retired = journal.retire(&obj(vec![("key", key("b")), ("referenced", Value::Bool(false))]), 7 + 604_800_000).unwrap();
    assert_eq!(retired.str_at("state"), Some("exited"));
    drop(journal);
    std::fs::remove_dir_all(&root).ok();
}

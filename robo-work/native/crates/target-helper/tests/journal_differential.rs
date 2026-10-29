//! A46 / JRN differential: replays `tests/vectors/journal-differential.json` (generated from the Node oracle
//! `journalModel.mjs` by `gen-journal-differential.mjs`) against the file-backed journal.
//!
//! Each step's result, the effects it produced and the journal size must equal the oracle's. Oracle events map to real
//! storage events: a simulated crash drops the handle and reopens the store from disk; `loseJournal` moves the journal
//! directory away (the handle must then refuse and `open` must not recreate it); `replaceJournal` provisions a new store
//! at the same path (the old handle must refuse); `recreateHelper` reopens with the new incarnation.

mod common;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{load, text};
use rw_target_helper::canon::{self, Value, obj, s};
use rw_target_helper::crypto::sha256_hex;
use rw_target_helper::journal::{CrashPoint, HookFailure, Hooks, Journal, JournalLimits, ResourceSpec};
use rw_target_helper::{Code, ok_value};

/// The synthetic target world: created trees per (journal store, key), and every effect in order.
struct World {
    store: String,
    created: HashSet<(String, String)>,
    effects: Vec<Value>,
    fault: Option<String>,
    crashed: bool,
}

impl Hooks for World {
    fn create(&mut self, key_text: &str, resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        if self.created.insert((self.store.clone(), key_text.to_string())) {
            self.effects.push(obj(vec![("type", s("create")), ("key", s(key_text))]));
        }
        Ok(resources.iter().map(|resource| sha256_hex(format!("synthetic-identity:{}", resource.resource_id).as_bytes())).collect())
    }
    fn release_gate(&mut self, key_text: &str) -> Result<(), HookFailure> {
        self.effects.push(obj(vec![("type", s("gate-release")), ("key", s(key_text))]));
        Ok(())
    }
    fn stop(&mut self, key_text: &str) -> Result<(), HookFailure> {
        // Stopping a tree that was never created is nothing.
        if self.created.contains(&(self.store.clone(), key_text.to_string())) {
            self.effects.push(obj(vec![("type", s("stop")), ("key", s(key_text))]));
        }
        Ok(())
    }
    fn release(&mut self, key_text: &str, resource_id: &str) -> Result<(), HookFailure> {
        self.effects.push(obj(vec![("type", s("release")), ("key", s(key_text)), ("resourceId", s(resource_id))]));
        Ok(())
    }
    fn crash_at(&mut self, point: CrashPoint) -> bool {
        let crash = matches!(
            (self.fault.as_deref(), point),
            (Some("crash-after-persist"), CrashPoint::PrepareAfterPersist) | (Some("crash-after-intent"), CrashPoint::CommitAfterIntent)
        );
        self.crashed |= crash;
        crash
    }
}

const MUTATING: [&str; 7] = ["prepare", "commit", "input", "stop", "observeExit", "release", "retire"];

struct Harness {
    root: PathBuf,
    journal: Option<Journal>,
    incarnation: String,
    limits: JournalLimits,
    world: World,
    pending: Option<String>,
    clock: i64,
    lost: bool,
    moved: usize,
}

fn open(root: &Path, store: &str, incarnation: &str, limits: JournalLimits) -> Journal {
    Journal::open(root, store, incarnation, limits, Duration::from_millis(500)).expect("journal opens")
}

fn result_value(result: Result<Value, Code>) -> Value {
    match result {
        Ok(value) => ok_value(value),
        Err(code) => code.result_value(),
    }
}

fn canonical(value: &Value) -> String {
    canon::canonical(value, 1 << 22).expect("canonical")
}

impl Harness {
    fn new(options: &Value) -> Harness {
        let root = common::temp_dir("differential");
        let store = text(options, "journalStoreIdentity").to_string();
        let incarnation = text(options, "helperIncarnation").to_string();
        let mut limits = JournalLimits::default();
        let configured = options.get("limits").unwrap();
        if let Some(entries) = configured.get("journalEntries").and_then(Value::int) {
            limits.journal_entries = entries as usize;
        }
        if let Some(resources) = configured.get("resourcesPerOperation").and_then(Value::int) {
            limits.resources_per_operation = resources as usize;
        }
        Journal::create_with_identity_for_tests(&root, &store).expect("provision journal");
        let journal = open(&root, &store, &incarnation, limits);
        Harness {
            root,
            journal: Some(journal),
            incarnation,
            limits,
            world: World { store, created: HashSet::new(), effects: Vec::new(), fault: None, crashed: false },
            pending: None,
            clock: options.get("clockStart").and_then(Value::int).unwrap(),
            lost: false,
            moved: 0,
        }
    }

    fn journal(&mut self) -> &mut Journal {
        self.journal.as_mut().expect("open journal")
    }

    fn reopen(&mut self) {
        // Drop first: the store lock is released exactly as a crashed process releases it.
        self.journal = None;
        self.journal = Some(open(&self.root, &self.world.store, &self.incarnation, self.limits));
    }

    fn move_journal_away(&mut self, label: &str) {
        self.moved += 1;
        let from = self.root.join("journal");
        if from.exists() {
            std::fs::rename(&from, self.root.join(format!("{label}-{}", self.moved))).unwrap();
        }
    }

    fn run(&mut self, op: &str, request: &Value) -> Result<Value, Code> {
        let mutating = MUTATING.contains(&op);
        let mut fault = None;
        if mutating && self.pending.is_some() {
            // The oracle consumes a fault only when its journal is available.
            self.journal().verify()?;
            fault = self.pending.take();
        }
        if fault.as_deref() == Some("crash-before-durable") {
            return Err(Code::OutcomeUnknown);
        }
        self.world.fault = fault.clone();
        self.world.crashed = false;
        let now = self.clock;
        let journal = self.journal.as_mut().expect("open journal");
        let world = &mut self.world;
        let result = match op {
            "prepare" => journal.prepare(request, now, world),
            "commit" => journal.commit(request, now, world),
            "lookup" => journal.lookup(request, now),
            "input" => journal.input(request, now),
            "stop" => journal.stop(request, now, world),
            "observeExit" => journal.observe_exit(request, now),
            "release" => journal.release(request, now, world),
            "retire" => journal.retire(request, now),
            other => panic!("unknown op {other}"),
        };
        self.world.fault = None;
        if self.world.crashed {
            // A simulated crash: the process is gone; the next step runs against the store reopened from disk.
            assert_eq!(result, Err(Code::OutcomeUnknown));
            self.reopen();
            return result;
        }
        let lost_reply = fault.as_deref() == Some("lost-reply");
        if op == "input" {
            if let (Ok(reply), false) = (&result, lost_reply) {
                // The transport delivered the acknowledgement.
                let accepted = reply.str_at("acceptedThrough").unwrap().to_string();
                let connection = reply.str_at("connectionId").unwrap().to_string();
                self.journal().confirm_input(request.get("key").unwrap(), &connection, &accepted).unwrap();
            }
        }
        match result {
            Ok(_) if lost_reply => Err(Code::OutcomeUnknown),
            other => other,
        }
    }

    fn step(&mut self, scenario: &str, index: usize, step: &Value) {
        let label = format!("{scenario} step {index}");
        match text(step, "op") {
            "advance" => self.clock += step.get("ms").and_then(Value::int).unwrap(),
            "inject" => self.pending = Some(text(step, "fault").to_string()),
            "loseJournal" => {
                self.move_journal_away("lost");
                self.lost = true;
                assert_eq!(self.journal().verify(), Err(Code::JournalUnavailable), "{label}: the handle refuses a lost journal");
                let reopened = Journal::open(&self.root, &self.world.store, &self.incarnation, self.limits, Duration::from_millis(50));
                assert_eq!(reopened.err(), Some(Code::JournalUnavailable), "{label}: open never recreates a lost journal");
                assert!(!self.root.join("journal").exists(), "{label}: nothing was created");
            }
            "replaceJournal" => {
                let identity = text(step, "identity").to_string();
                self.move_journal_away("replaced");
                Journal::create_with_identity_for_tests(&self.root, &identity).expect("provision replacement");
                assert_eq!(self.journal().verify(), Err(Code::JournalUnavailable), "{label}: the old handle refuses the replacement");
                let old_store = self.world.store.clone();
                let reopened_old = Journal::open(&self.root, &old_store, &self.incarnation, self.limits, Duration::from_millis(50));
                assert_eq!(reopened_old.err(), Some(Code::JournalUnavailable), "{label}: the old identity does not open the new store");
                self.world.store = identity.clone();
                self.journal = Some(open(&self.root, &identity, &self.incarnation, self.limits));
                self.lost = false;
            }
            "recreateHelper" => {
                self.incarnation = text(step, "incarnation").to_string();
                self.reopen();
            }
            op => {
                let request = step.get("request").unwrap();
                let before = self.world.effects.len();
                let result = self.run(op, request);
                let actual = result_value(result);
                let expected = step.get("result").unwrap();
                assert_eq!(canonical(&actual), canonical(expected), "{label} ({op}) result");
                let effects = Value::Arr(self.world.effects[before..].to_vec());
                assert_eq!(canonical(&effects), canonical(step.get("effects").unwrap()), "{label} ({op}) effects");
                if !self.lost {
                    assert_eq!(self.journal().size() as i64, step.get("size").and_then(Value::int).unwrap(), "{label} ({op}) size");
                }
            }
        }
    }
}

#[test]
fn journal_matches_the_node_oracle_step_by_step() {
    let path = common::crate_dir().join("tests/vectors/journal-differential.json");
    let vector = load(&path);
    assert_eq!(vector.get("version"), Some(&Value::Int(1)));
    let modules = vector.get("oracleModules").unwrap().obj().unwrap();
    assert_eq!(modules.len(), 2);
    let scenarios = vector.get("scenarios").unwrap().arr().unwrap();
    assert!(scenarios.len() >= 10, "scenario count {}", scenarios.len());
    let mut operations = 0;
    let mut kinds = HashSet::new();
    for scenario in scenarios {
        let name = text(scenario, "name");
        let mut harness = Harness::new(scenario.get("options").unwrap());
        for (index, step) in scenario.get("steps").unwrap().arr().unwrap().iter().enumerate() {
            harness.step(name, index, step);
            kinds.insert(text(step, "op").to_string());
            if step.has("result") {
                operations += 1;
            }
        }
        std::fs::remove_dir_all(&harness.root).ok();
    }
    // Coverage of the vector itself: every operation and every oracle event occurs.
    for kind in ["prepare", "commit", "lookup", "input", "stop", "observeExit", "release", "retire", "advance", "inject", "loseJournal", "replaceJournal", "recreateHelper"] {
        assert!(kinds.contains(kind), "the vector exercises {kind}");
    }
    assert!(operations >= 150, "operation count {operations}");
}

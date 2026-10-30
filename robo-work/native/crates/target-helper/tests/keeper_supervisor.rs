//! Slice P8: the keeper supervisor behind the journal, with a scripted fake keeper speaking the v1 keeper protocol over
//! a socket pair (no process, so this runs without the capabilities a real keeper needs), and the real spawn of a child
//! with the exact keeper descriptor layout. The real keeper runs only in the live apparatus evidence.
#![cfg(target_os = "linux")]

mod common;

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rw_proto::frame::{DecodeEvent, FrameDecoder, encode_frame};
use rw_proto::json::{self as pj, Value as J};
use rw_target_helper::Code;
use rw_target_helper::canon::{Value, obj, s};
use rw_target_helper::crypto::{b64url_encode, sha256, sha256_hex};
use rw_target_helper::journal::{Journal, JournalLimits, key_text};
use rw_target_helper::keeper::{EndKind, KeeperLauncher};
use rw_target_helper::service::TargetService;
use rw_target_helper::supervisor::{
    Attempt, AttemptStore, HostIdentity, KeeperSpawner, KeeperSupervisor, Liveness, ProcIdentity, SpawnPlan, Spawned, attempt_absence, deliver_attempt_stop,
    identity_alive, identity_liveness, liveness_from, proc_stat, spawn_with_layout,
};

const STORE: &str = "AwMDAwMDAwMDAwMDAwMDAw";
const FAKE_PID: i64 = 2_147_483_000;

fn id(label: &str) -> String {
    b64url_encode(&sha256(format!("p8-id:{label}").as_bytes())[..16])
}

fn dg(label: &str) -> String {
    sha256_hex(label.as_bytes())
}

fn key(label: &str) -> Value {
    obj(vec![
        ("workspaceId", s("ws-p8")),
        ("workerGeneration", s(&id("gen"))),
        ("executionId", s(&id(&format!("exec-{label}")))),
        ("attemptId", s(&id("attempt"))),
        ("operationId", s(&id(&format!("op-{label}")))),
    ])
}

fn resources(label: &str, kinds: &[&str]) -> Value {
    Value::Arr(kinds.iter().enumerate().map(|(index, kind)| obj(vec![("resourceId", s(&id(&format!("{label}-r{index}")))), ("kind", s(kind)), ("locatorDigest", s(&dg(&format!("{label}-l{index}"))))])).collect())
}

fn prepare_request(label: &str, lease: &str, kinds: &[&str]) -> Value {
    obj(vec![
        ("key", key(label)),
        ("targetBindingDigest", s(&dg("binding"))),
        ("reservationId", s(&id("reservation"))),
        ("requestDigest", s(&dg(&format!("request-{label}")))),
        ("leaseId", s(&id(lease))),
        ("journalStoreIdentity", s(STORE)),
        ("resources", resources(label, kinds)),
    ])
}

fn workload() -> Value {
    obj(vec![("executable", s("sh")), ("args", Value::Arr(vec![s("-c"), s("echo hi")]))])
}

const KINDS: [&str; 4] = ["keeper", "namespace", "process-tree", "gate"];

fn commit_request(label: &str, receipt: &Value) -> Value {
    let resources = receipt.get("resources").cloned().unwrap();
    obj(vec![
        ("key", key(label)),
        ("targetBindingDigest", s(&dg("binding"))),
        ("reservationId", s(&id("reservation"))),
        ("workerCommitDigest", s(&dg("commit"))),
        ("preparedReceiptSequence", receipt.get("receiptSequence").cloned().unwrap()),
        ("preparedResourcesDigest", s(&rw_target_helper::canon::digest(&resources, 1 << 20).unwrap())),
    ])
}

fn lookup(service: &mut TargetService<KeeperSupervisor>, label: &str) -> Value {
    service.lookup(&obj(vec![("key", key(label)), ("targetBindingDigest", s(&dg("binding")))]), 1).unwrap()
}

// ---- the fake keeper -----------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
struct Script {
    /// Close the channel right after the workload commit (keeper loss).
    die_after_commit: bool,
    /// Emit the workload's exit right after its commit.
    exit_after_commit: Option<i64>,
    /// Refuse the workload create (`refused`: nothing was created).
    refuse_workload: bool,
    /// Fail the workload create after scheduling (`failure`: the keeper may have created something).
    fail_workload: bool,
    /// With `fail_workload`: only the first spawned keeper fails it.
    fail_workload_once: bool,
}

#[derive(Default)]
struct Shared {
    spawns: AtomicUsize,
    ops: Mutex<Vec<String>>,
}

struct FakeSpawner {
    script: Script,
    shared: Arc<Shared>,
}

fn send(stream: &mut UnixStream, frame: J) {
    let bytes = encode_frame(&frame, 1 << 20).unwrap();
    let _ = stream.write_all(&bytes);
}

fn ok(id: i64, value: J) -> J {
    pj::obj(vec![("id", pj::int(id)), ("ok", J::Bool(true)), ("value", value)])
}

fn fake_keeper(mut stream: UnixStream, marker: String, script: Script, shared: Arc<Shared>) {
    send(&mut stream, pj::obj(vec![("event", pj::text("hello")), ("protocol", pj::text("robo-work-keeper")), ("version", pj::int(1)), ("pid", pj::int(0)), ("startTime", pj::text("0")), ("marker", pj::text(&marker)), ("limits", J::Object(Vec::new()))]));
    let mut decoder = FrameDecoder::new(1 << 20, 60_000);
    let mut buffer = [0u8; 65536];
    let mut runtime_dir = PathBuf::new();
    let mut kinds: Vec<(String, String)> = Vec::new();
    let mut stdout_leaf = String::new();
    let mut workload = String::new();
    let mut output: Option<UnixStream> = None;
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        let mut frames = Vec::new();
        decoder.push(&buffer[..count], 0, &mut frames);
        for event in frames {
            let DecodeEvent::Frame(frame) = event else { return };
            let id = frame.get("id").and_then(J::as_safe_int).unwrap();
            let op = frame.get("op").and_then(J::as_str).unwrap().to_string();
            shared.ops.lock().unwrap().push(op.clone());
            match op.as_str() {
                "commit_keeper" | "end_process_trees" | "end_endpoint" | "abort_uncommitted" => send(&mut stream, ok(id, J::Object(Vec::new()))),
                "shutdown" => {
                    send(&mut stream, ok(id, J::Object(Vec::new())));
                    return;
                }
                "create" => {
                    let resource = frame.get("resource").and_then(J::as_str).unwrap().to_string();
                    let kind = frame.get("kind").and_then(J::as_str).unwrap().to_string();
                    kinds.push((resource.clone(), kind.clone()));
                    let identity = match kind.as_str() {
                        "runtime-dir" => {
                            runtime_dir = PathBuf::from(frame.get("locator").and_then(|locator| locator.get("path")).and_then(J::as_str).unwrap());
                            std::fs::create_dir_all(&runtime_dir).unwrap();
                            pj::obj(vec![("path", pj::text(&runtime_dir.to_string_lossy())), ("dev", pj::text("1")), ("ino", pj::text("2"))])
                        }
                        "netns" => pj::obj(vec![("netNs", pj::text("4026530001"))]),
                        "endpoint" => {
                            std::fs::create_dir_all(runtime_dir.join("streams")).unwrap();
                            pj::obj(vec![("pid", pj::int(FAKE_PID)), ("startTime", pj::text("1")), ("pidNs", pj::text("4026530002"))])
                        }
                        _ => {
                            if script.refuse_workload || script.fail_workload {
                                let (kind, error) = if script.refuse_workload { ("refused", "inventory_miss") } else { ("failure", "setup_failed") };
                                send(&mut stream, pj::obj(vec![("id", pj::int(id)), ("ok", J::Bool(false)), ("kind", pj::text(kind)), ("error", pj::text(error))]));
                                continue;
                            }
                            let spec = frame.get("spec").unwrap();
                            assert_eq!(spec.get("role").and_then(J::as_str), Some("workload"));
                            let request = spec.get("request").unwrap();
                            assert_eq!(request.get("env"), Some(&J::Object(Vec::new())), "no environment reaches the workload");
                            stdout_leaf = spec.get("streams").and_then(|streams| streams.get("stdout")).and_then(J::as_str).unwrap().rsplit('/').next().unwrap().to_string();
                            workload = resource.clone();
                            pj::obj(vec![("pid", pj::int(FAKE_PID + 1)), ("startTime", pj::text("2")), ("pidNs", pj::text("4026530003"))])
                        }
                    };
                    send(&mut stream, ok(id, pj::obj(vec![("resource", pj::text(&resource)), ("identity", identity)])));
                }
                "commit" => {
                    let resource = frame.get("resource").and_then(J::as_str).unwrap();
                    let kind = kinds.iter().find(|(known, _)| known == resource).map(|(_, kind)| kind.clone()).unwrap();
                    let state = if kind == "runtime-dir" || kind == "netns" { "committed" } else { "executed" };
                    if kind == "process-tree" {
                        let mut connection = UnixStream::connect(runtime_dir.join("streams").join(&stdout_leaf)).unwrap();
                        connection.write_all(b"workload-output\n").unwrap();
                        output = Some(connection);
                    }
                    send(&mut stream, ok(id, pj::obj(vec![("state", pj::text(state))])));
                    if kind == "process-tree" {
                        if script.die_after_commit {
                            return;
                        }
                        if let Some(code) = script.exit_after_commit {
                            output = None;
                            send(&mut stream, pj::obj(vec![("event", pj::text("exit")), ("resource", pj::text(&workload)), ("code", pj::int(code)), ("signal", J::Null)]));
                        }
                    }
                }
                "stop" => {
                    output = None;
                    send(&mut stream, pj::obj(vec![("event", pj::text("exit")), ("resource", pj::text(&workload)), ("code", J::Null), ("signal", pj::text("SIGTERM"))]));
                    send(&mut stream, ok(id, pj::obj(vec![("state", pj::text("exited"))])));
                }
                other => panic!("unexpected op {other}"),
            }
        }
        let _ = &output;
    }
}

impl KeeperSpawner for FakeSpawner {
    fn available(&self) -> bool {
        true
    }
    fn spawn(&mut self, plan: &SpawnPlan) -> std::io::Result<Spawned> {
        self.shared.spawns.fetch_add(1, Ordering::SeqCst);
        assert!(plan.home.is_dir() && plan.runtime_root.is_dir(), "the execution HOME and runtime root exist before the spawn");
        let (ours, theirs) = UnixStream::pair()?;
        let mut script = self.script;
        if script.fail_workload_once && self.shared.spawns.load(Ordering::SeqCst) > 1 {
            script.fail_workload = false;
        }
        let (shared, marker) = (self.shared.clone(), plan.reservation.clone());
        std::thread::spawn(move || fake_keeper(theirs, marker, script, shared));
        Ok(Spawned { channel: ours, peers: Vec::new(), process: None })
    }
}

struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    shared: Arc<Shared>,
}

fn fixture(label: &str) -> Fixture {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let root = common::temp_dir(label);
    Journal::create_with_identity_for_tests(&root, STORE).unwrap();
    // Short: stream socket paths below it must fit sun_path.
    let runtime = PathBuf::from(format!("/tmp/rwk-t{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&runtime);
    Fixture { root, runtime, shared: Arc::new(Shared::default()) }
}

fn service(fixture: &Fixture, incarnation: &str, script: Script) -> TargetService<KeeperSupervisor> {
    let journal = Journal::open(&fixture.root, STORE, &id(incarnation), JournalLimits::default(), Duration::from_millis(1000)).unwrap();
    let supervisor = KeeperSupervisor::new(Box::new(FakeSpawner { script, shared: fixture.shared.clone() }), &fixture.root, &fixture.runtime, &id(incarnation), STORE);
    TargetService::new(journal, supervisor)
}

fn pump_until(service: &mut TargetService<KeeperSupervisor>, wanted: usize) -> Vec<rw_target_helper::service::Journaled> {
    let mut out = Vec::new();
    for _ in 0..200 {
        out.extend(service.pump(2));
        if out.len() >= wanted {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    out
}

fn spawns(fixture: &Fixture) -> usize {
    fixture.shared.spawns.load(Ordering::SeqCst)
}

#[test]
fn prepare_creates_one_gated_keeper_commit_releases_it_stop_ends_it_and_release_settles() {
    let fixture = fixture("sup-round-trip");
    let mut service = service(&fixture, "helper-a", Script::default());
    let prepared = service.prepare_workload(&prepare_request("a", "lease-a", &KINDS), Some(&workload()), 1).unwrap();
    assert_eq!(prepared.str_at("state"), Some("prepared"));
    assert_eq!(prepared.get("gateReleased"), Some(&Value::Bool(false)));
    let identities: Vec<_> = prepared.get("resources").and_then(Value::arr).unwrap().iter().map(|resource| resource.str_at("identityDigest").unwrap().to_string()).collect();
    assert_eq!(identities.len(), 4);
    assert!(identities.iter().all(|digest| digest.len() == 64) && identities.windows(2).all(|pair| pair[0] != pair[1]));
    // The attempt record is durable and names the keeper's reservation.
    let attempt = AttemptStore::at(&fixture.root, STORE).get(&sha256_hex(key_text(&key("a")).unwrap().as_bytes())).unwrap().unwrap();
    assert_eq!(attempt.anchor.as_ref().map(|anchor| anchor.pid as i64), Some(FAKE_PID + 1));
    assert_eq!(attempt.helper_incarnation, id("helper-a"));
    assert_eq!(attempt.boot_id, HostIdentity::current().boot_id, "the attempt names this boot");
    assert!(attempt.boot_id.is_some() && !attempt.cgroup.is_empty());
    // An identical retry returns the recorded receipt: no second keeper.
    let again = service.prepare_workload(&prepare_request("a", "lease-a", &KINDS), Some(&workload()), 1).unwrap();
    assert_eq!(again.get("receiptSequence"), prepared.get("receiptSequence"));
    assert_eq!(spawns(&fixture), 1);
    let running = service.commit(&commit_request("a", &prepared), 1).unwrap();
    assert_eq!((running.str_at("state"), running.get("gateReleased")), (Some("running"), Some(&Value::Bool(true))));
    // The workload's output reaches the bounded output file.
    for _ in 0..100 {
        service.pump(2);
        if std::fs::read(service.launcher().output_path(&key_text(&key("a")).unwrap())).is_ok_and(|bytes| bytes == b"workload-output\n") {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(std::fs::read(service.launcher().output_path(&key_text(&key("a")).unwrap())).unwrap(), b"workload-output\n");
    let stopped = service.stop(&obj(vec![("key", key("a"))]), 1).unwrap();
    assert_eq!(stopped.str_at("state"), Some("exited"), "the stop verified the tree gone and journaled the exit");
    let ops = fixture.shared.ops.lock().unwrap().clone();
    let tail: Vec<&str> = ops.iter().rev().take(4).rev().map(String::as_str).collect();
    assert_eq!(tail, ["stop", "end_process_trees", "end_endpoint", "shutdown"]);
    // A retried prepare after the stop never launches again.
    let retried = service.prepare_workload(&prepare_request("a", "lease-a", &KINDS), Some(&workload()), 1).unwrap();
    assert_eq!(retried.str_at("state"), Some("exited"));
    assert_eq!(spawns(&fixture), 1);
    let evidence = Value::Arr(prepared.get("resources").and_then(Value::arr).unwrap().iter().map(|resource| obj(vec![("resourceId", resource.get("resourceId").cloned().unwrap()), ("kind", s("verified-absent")), ("evidenceDigest", s(&dg("absent")))])).collect());
    let released = service.release(&obj(vec![("key", key("a")), ("evidence", obj(vec![("resources", evidence)]))]), 1).unwrap();
    assert!(released.get("resources").and_then(Value::arr).unwrap().iter().all(|resource| resource.str_at("state") == Some("released")));
    let execution_dir = service.launcher().output_path(&key_text(&key("a")).unwrap()).parent().unwrap().to_path_buf();
    assert!(!execution_dir.exists(), "release removed the execution directory");
}

#[test]
fn keeper_loss_is_journaled_stop_then_exit_and_never_relaunched() {
    let fixture = fixture("sup-loss");
    let mut service = service(&fixture, "helper-b", Script { die_after_commit: true, ..Script::default() });
    let prepared = service.prepare_workload(&prepare_request("b", "lease-b", &KINDS), Some(&workload()), 1).unwrap();
    service.commit(&commit_request("b", &prepared), 1).unwrap();
    let journaled = pump_until(&mut service, 1);
    assert_eq!(journaled.len(), 1, "{journaled:?}");
    assert_eq!((journaled[0].cause, journaled[0].outcome.clone()), ("keeper_lost", Ok("exited".to_string())));
    let found = lookup(&mut service, "b");
    assert_eq!(found.str_at("state"), Some("exited"));
    assert!(service.pump(3).is_empty(), "reported once");
    let retried = service.prepare_workload(&prepare_request("b", "lease-b", &KINDS), Some(&workload()), 1).unwrap();
    assert_eq!(retried.str_at("state"), Some("exited"));
    assert_eq!(spawns(&fixture), 1);
}

#[test]
fn workload_exit_is_journaled_exited() {
    let fixture = fixture("sup-exit");
    let mut service = service(&fixture, "helper-c", Script { exit_after_commit: Some(0), ..Script::default() });
    let prepared = service.prepare_workload(&prepare_request("c", "lease-c", &KINDS), Some(&workload()), 1).unwrap();
    service.commit(&commit_request("c", &prepared), 1).unwrap();
    let journaled = pump_until(&mut service, 1);
    assert_eq!((journaled[0].cause, journaled[0].outcome.clone()), ("workload_exit", Ok("exited".to_string())));
    // The stop of an exited record is idempotent and creates nothing.
    assert_eq!(service.stop(&obj(vec![("key", key("c"))]), 1).unwrap().str_at("state"), Some("exited"));
    assert_eq!(spawns(&fixture), 1);
}

#[test]
fn a_restarted_helper_reconciles_every_unsettled_record_before_readiness_without_relaunching() {
    let fixture = fixture("sup-restart");
    let mut first = service(&fixture, "helper-d1", Script::default());
    let prepared = first.prepare_workload(&prepare_request("run", "lease-d", &KINDS), Some(&workload()), 1).unwrap();
    first.commit(&commit_request("run", &prepared), 1).unwrap();
    first.prepare_workload(&prepare_request("gated", "lease-d", &KINDS), Some(&workload()), 1).unwrap();
    assert_eq!(spawns(&fixture), 2);
    // The helper dies (the journal lock is released with it; its keepers die with it).
    drop(first);
    let mut second = service(&fixture, "helper-d2", Script::default());
    let settled = second.reconcile_at_start(5).unwrap();
    assert_eq!(settled.len(), 2);
    assert!(settled.iter().all(|item| item.cause == "startup_reconcile" && item.outcome == Ok("exited".to_string())), "{settled:?}");
    for label in ["run", "gated"] {
        assert_eq!(lookup(&mut second, label).str_at("state"), Some("exited"));
        let retried = second.prepare_workload(&prepare_request(label, "lease-d", &KINDS), Some(&workload()), 6).unwrap();
        assert_eq!(retried.str_at("state"), Some("exited"), "{label}: no relaunch");
    }
    // The gated record can no longer be committed.
    assert_eq!(second.commit(&commit_request("gated", &prepared), 7).err(), Some(Code::OperationConflict));
    assert_eq!(spawns(&fixture), 2);
    assert!(second.reconcile_at_start(8).unwrap().is_empty(), "nothing left to reconcile");
}

#[test]
fn a_failed_create_is_outcome_unknown_and_its_key_never_gets_a_second_keeper() {
    let fixture = fixture("sup-create-fail");
    let mut service = service(&fixture, "helper-e", Script { refuse_workload: true, ..Script::default() });
    assert_eq!(service.prepare_workload(&prepare_request("e", "lease-e", &KINDS), Some(&workload()), 1).err(), Some(Code::OutcomeUnknown));
    assert_eq!(lookup(&mut service, "e").str_at("state"), Some("reserved"));
    // The retry of a reserved record never creates (its first create may have spawned).
    assert_eq!(service.prepare_workload(&prepare_request("e", "lease-e", &KINDS), Some(&workload()), 1).err(), Some(Code::OutcomeUnknown));
    assert_eq!(spawns(&fixture), 1);
    assert_eq!(service.stop(&obj(vec![("key", key("e"))]), 1).unwrap().str_at("state"), Some("exited"));
}

#[test]
fn prepares_the_supervisor_cannot_serve_refuse_before_the_journal() {
    let fixture = fixture("sup-admission");
    let mut service = service(&fixture, "helper-f", Script::default());
    let revision = service.journal().revision();
    assert_eq!(service.prepare_workload(&prepare_request("f", "lease-f", &KINDS), None, 1).err(), Some(Code::InvalidRequest), "no workload");
    let bad = obj(vec![("executable", s("/bin/sh")), ("args", Value::Arr(vec![]))]);
    assert_eq!(service.prepare_workload(&prepare_request("f", "lease-f", &KINDS), Some(&bad), 1).err(), Some(Code::InvalidRequest), "a path is no inventory name");
    assert_eq!(service.prepare_workload(&prepare_request("f", "lease-f", &["keeper", "listener"]), Some(&workload()), 1).err(), Some(Code::InvalidRequest));
    assert_eq!(service.prepare_workload(&prepare_request("f", "lease-f", &["gate"]), Some(&workload()), 1).err(), Some(Code::InvalidRequest));
    assert_eq!(service.journal().revision(), revision, "nothing was written");
    assert_eq!(spawns(&fixture), 0);
    assert!(!fixture.runtime.exists(), "nothing created before a launch");
}

#[test]
fn executions_per_target_is_enforced_before_the_journal() {
    let fixture = fixture("sup-capacity");
    let journal = Journal::open(&fixture.root, STORE, &id("helper-g"), JournalLimits::default(), Duration::from_millis(1000)).unwrap();
    let supervisor = KeeperSupervisor::new(Box::new(FakeSpawner { script: Script::default(), shared: fixture.shared.clone() }), &fixture.root, &fixture.runtime, &id("helper-g"), STORE).with_capacity(1);
    let mut service = TargetService::new(journal, supervisor);
    service.prepare_workload(&prepare_request("g1", "lease-g", &KINDS), Some(&workload()), 1).unwrap();
    let revision = service.journal().revision();
    assert_eq!(service.prepare_workload(&prepare_request("g2", "lease-g", &KINDS), Some(&workload()), 1).err(), Some(Code::CapacityExceeded));
    assert_eq!(service.journal().revision(), revision);
    // The retry of the live key is still served.
    assert_eq!(service.prepare_workload(&prepare_request("g1", "lease-g", &KINDS), Some(&workload()), 1).unwrap().str_at("state"), Some("prepared"));
    // Once the first is stopped, capacity is free again.
    service.stop(&obj(vec![("key", key("g1"))]), 1).unwrap();
    assert_eq!(service.prepare_workload(&prepare_request("g2", "lease-g", &KINDS), Some(&workload()), 1).unwrap().str_at("state"), Some("prepared"));
    assert_eq!(spawns(&fixture), 2);
}

#[test]
fn lease_expiry_stops_only_that_leases_records() {
    let fixture = fixture("sup-lease");
    let mut service = service(&fixture, "helper-h", Script::default());
    for (label, lease) in [("h1", "lease-x"), ("h2", "lease-y")] {
        let prepared = service.prepare_workload(&prepare_request(label, lease, &KINDS), Some(&workload()), 1).unwrap();
        service.commit(&commit_request(label, &prepared), 1).unwrap();
    }
    let settled = service.expire_lease(&id("lease-x"), 2).unwrap();
    assert_eq!(settled.len(), 1);
    assert_eq!(lookup(&mut service, "h1").str_at("state"), Some("exited"));
    assert_eq!(lookup(&mut service, "h2").str_at("state"), Some("running"), "the other lease's execution keeps running");
}

#[test]
fn the_peer_retires_an_unrenewed_lease_and_ends_only_its_trees() {
    use rw_target_helper::crypto::Secret;
    use rw_target_helper::peer::{self, Clock, HelperState, LeaseClock};
    use rw_target_helper::session::TicketKey;
    struct Manual(std::cell::Cell<i64>);
    impl Clock for Manual {
        fn now_ms(&self) -> i64 {
            1_800_000_000_000 + self.0.get()
        }
        fn mono_ms(&self) -> i64 {
            self.0.get()
        }
    }
    let fixture = fixture("sup-peer-lease");
    let mut service = service(&fixture, "helper-i", Script::default());
    for (label, lease) in [("i1", "lease-p"), ("i2", "lease-q")] {
        let prepared = service.prepare_workload(&prepare_request(label, lease, &KINDS), Some(&workload()), 1).unwrap();
        service.commit(&commit_request(label, &prepared), 1).unwrap();
    }
    let mut state = HelperState::new(TicketKey { kid: "k".into(), secret: Secret::new(vec![1; 32]) }, &id("helper-i"), STORE);
    let clock = Manual(std::cell::Cell::new(1000));
    state.leases.insert(id("lease-p"), LeaseClock { deadline_mono_ms: 1000 + peer::LEASE_TTL_MS, retired: false, renewed_ms: clock.now_ms() });
    state.leases.insert(id("lease-q"), LeaseClock { deadline_mono_ms: 1000 + 10 * peer::LEASE_TTL_MS, retired: false, renewed_ms: clock.now_ms() });
    let mut events = Vec::new();
    peer::expire_leases(&mut state, &mut service, &clock, &mut |name, _| events.push(name.to_string()));
    assert!(events.is_empty(), "nothing expires before the deadline");
    clock.0.set(1000 + peer::LEASE_TTL_MS);
    peer::expire_leases(&mut state, &mut service, &clock, &mut |name, _| events.push(name.to_string()));
    assert_eq!(events, ["lease_expired", "journaled"]);
    assert!(state.leases[&id("lease-p")].retired && !state.leases[&id("lease-q")].retired);
    assert_eq!(lookup(&mut service, "i1").str_at("state"), Some("exited"));
    assert_eq!(lookup(&mut service, "i2").str_at("state"), Some("running"));
}

#[test]
fn ended_kinds_are_reported_with_the_key_text() {
    // The EndKind spellings the service maps (compile-time coverage of the public shape).
    let kinds = [EndKind::Exited { code: Some(0), signal: None }, EndKind::KeeperLost, EndKind::OutputLimit];
    assert_eq!(kinds.len(), 3);
    assert!(UnixStream::pair().is_ok());
    let _ = Path::new("/");
    let _: fn(&KeeperSupervisor) -> &'static str = <KeeperSupervisor as KeeperLauncher>::label;
}

#[test]
fn the_real_spawn_gives_the_child_exactly_the_keeper_descriptor_layout_and_an_empty_environment() {
    let dir = common::temp_dir("sup-layout");
    let log_path = dir.join("child.log");
    let log = std::fs::OpenOptions::new().write(true).create_new(true).open(&log_path).unwrap();
    let mut pairs = Vec::new();
    for _ in 0..5 {
        pairs.push(UnixStream::pair().unwrap());
    }
    let home = std::fs::File::open(&dir).unwrap();
    use std::os::fd::AsRawFd;
    let layout: Vec<i32> = pairs.iter().map(|(_, theirs)| theirs.as_raw_fd()).chain([home.as_raw_fd()]).collect();
    // A decoy without CLOEXEC must not leak into the child either.
    let decoy = std::fs::File::open("/dev/null").unwrap();
    // SAFETY: clearing FD_CLOEXEC on an owned descriptor.
    unsafe { libc::fcntl(decoy.as_raw_fd(), libc::F_SETFD, 0) };
    let script = "for n in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 64 65 66 67 68 69 70; do [ -e /proc/self/fd/$n ] && echo fd $n; done; echo ppid $PPID; echo envbytes $(wc -c < /proc/$$/environ)";
    let process = spawn_with_layout(Path::new("/bin/sh"), &["-c".to_string(), script.to_string()], &log, &layout).unwrap();
    // SAFETY: getpid has no preconditions.
    let parent = unsafe { libc::getpid() };
    let mut entry = libc::pollfd { fd: process.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    // SAFETY: one valid pollfd.
    assert_eq!(unsafe { libc::poll(&mut entry, 1, 10_000) }, 1, "the child exited");
    let text = std::fs::read_to_string(&log_path).unwrap();
    let fds: Vec<&str> = text.lines().filter(|line| line.starts_with("fd ")).collect();
    assert_eq!(fds, ["fd 0", "fd 1", "fd 2", "fd 3", "fd 4", "fd 5", "fd 6", "fd 7", "fd 8"], "{text}");
    assert!(text.contains(&format!("ppid {parent}")), "{text}");
    assert!(text.contains("envbytes 0"), "{text}");
    drop(decoy);
}

// ---- c2 (review B1, I2): stop delivered versus absence verified ------------------------------------------------------

/// A real child process (`sleep 60`) and its exact identity.
fn real_process(pid_ns: Option<String>) -> (std::process::Child, ProcIdentity) {
    let child = std::process::Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let pid = child.id() as i32;
    let start = proc_stat(pid).unwrap().1;
    (child, ProcIdentity { pid, start_time: start, pid_ns })
}

fn attempt(helper: ProcIdentity, boot_id: Option<String>, keeper: Option<ProcIdentity>, anchor: Option<ProcIdentity>) -> Attempt {
    Attempt {
        key_digest: dg("k"), marker: id("marker"), helper, helper_incarnation: id("old-helper"), boot_id, cgroup: "0::/test".into(), hostname: "test".into(),
        requested: [keeper.as_ref().map(|_| "keeper"), anchor.as_ref().map(|_| "workload")].into_iter().flatten().map(str::to_string).collect(), keeper,
        endpoint: None, anchor,
    }
}

#[test]
fn same_namespace_other_helper_attempts_are_verified_only_after_their_exact_survivors_are_gone() {
    let host = HostIdentity::current();
    let ns = host.helper.pid_ns.clone();
    assert!(ns.is_some() && host.boot_id.is_some());
    // A distinct, dead earlier helper process of this namespace.
    let (mut old_helper, old_identity) = real_process(ns.clone());
    old_helper.kill().unwrap();
    old_helper.wait().unwrap();
    assert!(old_identity.pid != host.helper.pid && !identity_alive(&old_identity));
    // Its keeper survives (a real, distinct process).
    let (mut keeper, keeper_identity) = real_process(ns.clone());
    let record = attempt(old_identity.clone(), host.boot_id.clone(), Some(keeper_identity.clone()), None);
    assert!(!attempt_absence(&record, &host, &identity_liveness), "a live survivor is not absence");
    deliver_attempt_stop(&record, &host, &identity_liveness);
    assert!(keeper.wait().unwrap().code().is_none(), "the survivor with the exact start time was killed");
    assert!(attempt_absence(&record, &host, &identity_liveness), "verified once every identity is gone");
    // Exactness: the right pid with another start time is not that process and is never signalled.
    let (mut other, other_identity) = real_process(ns.clone());
    let stale = ProcIdentity { start_time: "1".into(), ..other_identity.clone() };
    let record = attempt(old_identity, host.boot_id.clone(), Some(stale), None);
    deliver_attempt_stop(&record, &host, &identity_liveness);
    assert!(identity_alive(&other_identity), "a reused pid is never killed");
    assert!(attempt_absence(&record, &host, &identity_liveness));
    other.kill().unwrap();
    other.wait().unwrap();
}

#[test]
fn another_pid_namespace_or_an_unknown_one_is_never_verified_locally_and_another_boot_always_is() {
    let host = HostIdentity::current();
    let (mut live, live_identity) = real_process(Some("4026530001".into()));
    let foreign_helper = ProcIdentity { pid: live_identity.pid, start_time: live_identity.start_time.clone(), pid_ns: Some("4026530001".into()) };
    // Another namespace of this boot: even with every identity dead here, absence is unverified; and the stop delivers
    // nothing locally (a pid of another namespace is not a pid of this one).
    let dead = ProcIdentity { pid: FAKE_PID as i32, start_time: "9".into(), pid_ns: Some("4026530001".into()) };
    let record = attempt(foreign_helper.clone(), host.boot_id.clone(), Some(dead.clone()), Some(dead.clone()));
    assert!(!attempt_absence(&record, &host, &identity_liveness));
    let record_with_live = attempt(foreign_helper.clone(), host.boot_id.clone(), Some(live_identity.clone()), None);
    deliver_attempt_stop(&record_with_live, &host, &identity_liveness);
    assert!(identity_alive(&live_identity), "nothing is signalled across namespaces");
    // A keeper whose namespace differs from the (same-namespace) helper's: unverified.
    let mut odd = attempt(host.helper.clone(), host.boot_id.clone(), Some(dead.clone()), None);
    assert!(!attempt_absence(&odd, &host, &identity_liveness));
    // Unknown namespace on either side, or unknown boot: unverified.
    odd.keeper = None;
    odd.helper.pid_ns = None;
    assert!(!attempt_absence(&odd, &host, &identity_liveness), "attempt namespace unknown");
    let unknown_host = HostIdentity { helper: ProcIdentity { pid_ns: None, ..host.helper.clone() }, boot_id: host.boot_id.clone() };
    assert!(!attempt_absence(&attempt(host.helper.clone(), host.boot_id.clone(), None, None), &unknown_host, &identity_liveness), "host namespace unknown");
    assert!(!attempt_absence(&attempt(host.helper.clone(), None, None, None), &host, &identity_liveness), "boot unknown");
    // Another boot: every process of that boot ended.
    let rebooted = attempt(foreign_helper, Some("00000000-0000-0000-0000-000000000000".into()), Some(live_identity.clone()), None);
    assert!(attempt_absence(&rebooted, &host, &identity_liveness));
    live.kill().unwrap();
    live.wait().unwrap();
}

#[test]
fn a_record_of_another_pid_namespace_rests_stopping_and_release_refuses_until_quarantine() {
    let fixture = fixture("sup-foreign-ns");
    let mut first = service(&fixture, "helper-j1", Script::default());
    let prepared = first.prepare_workload(&prepare_request("j", "lease-j", &KINDS), Some(&workload()), 1).unwrap();
    first.commit(&commit_request("j", &prepared), 1).unwrap();
    drop(first);
    // The attempt as a replaced container (another PID namespace of this boot) would have left it.
    let store = AttemptStore::at(&fixture.root, STORE);
    let digest = sha256_hex(key_text(&key("j")).unwrap().as_bytes());
    let mut old = store.get(&digest).unwrap().unwrap();
    old.helper = ProcIdentity { pid: 23, start_time: "100".into(), pid_ns: Some("4026530009".into()) };
    old.keeper = Some(ProcIdentity { pid: 217, start_time: "101".into(), pid_ns: Some("4026530009".into()) });
    store.update(&old).unwrap();
    let mut second = service(&fixture, "helper-j2", Script::default());
    let settled = second.reconcile_at_start(5).unwrap();
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].outcome, Ok("stopping".to_string()), "stop delivered, absence unverified");
    assert_eq!(lookup(&mut second, "j").str_at("state"), Some("stopping"));
    // Still unsettled: the next start judges it again, without a second stop.
    assert_eq!(second.reconcile_at_start(6).unwrap()[0].outcome, Ok("stopping".to_string()));
    assert_eq!(second.stop(&obj(vec![("key", key("j"))]), 7).unwrap().str_at("state"), Some("stopping"));
    let resources = prepared.get("resources").and_then(Value::arr).unwrap().to_vec();
    let evidence = |kind: &str| obj(vec![("resources", Value::Arr(resources.iter().map(|resource| obj(vec![("resourceId", resource.get("resourceId").cloned().unwrap()), ("kind", s(kind)), ("evidenceDigest", s(&dg("e")))])).collect()))]);
    assert_eq!(second.release(&obj(vec![("key", key("j")), ("evidence", evidence("verified-absent"))]), 8).err(), Some(Code::AbsenceUnverified));
    // The operator path: quarantine (the journal records it without the release effect).
    let quarantined = second.release(&obj(vec![("key", key("j")), ("evidence", evidence("quarantine"))]), 9).unwrap();
    assert_eq!(quarantined.str_at("state"), Some("quarantined"));
    assert_eq!(spawns(&fixture), 1);
}

/// Journal effects that create nothing (a record whose key has no attempt in the supervisor's store).
struct NoAttemptHooks;

impl rw_target_helper::journal::Hooks for NoAttemptHooks {
    fn create(&mut self, _key_text: &str, resources: &[rw_target_helper::journal::ResourceSpec]) -> Result<Vec<String>, rw_target_helper::journal::HookFailure> {
        Ok(resources.iter().map(|resource| dg(&resource.resource_id)).collect())
    }
    fn release_gate(&mut self, _key_text: &str) -> Result<(), rw_target_helper::journal::HookFailure> {
        Ok(())
    }
    fn stop(&mut self, _key_text: &str) -> Result<(), rw_target_helper::journal::HookFailure> {
        Ok(())
    }
    fn release(&mut self, _key_text: &str, _resource_id: &str) -> Result<(), rw_target_helper::journal::HookFailure> {
        Ok(())
    }
}

fn evidence(prepared: &Value, kind: &str) -> Value {
    let resources = prepared.get("resources").and_then(Value::arr).unwrap().to_vec();
    obj(vec![("resources", Value::Arr(resources.iter().map(|resource| obj(vec![("resourceId", resource.get("resourceId").cloned().unwrap()), ("kind", s(kind)), ("evidenceDigest", s(&dg("e")))])).collect()))])
}

#[test]
fn an_unverifiable_attempt_store_refuses_a_prepare_before_the_journal_write() {
    let fixture = fixture("sup-witness");
    let witness = fixture.root.join("journal/keepers/witness.json");
    let original = std::fs::read(&witness).unwrap();
    assert_eq!(original, rw_target_helper::journal::store_witness_text(STORE).unwrap().as_bytes(), "provisioning witnessed the store");
    let mut service = service(&fixture, "helper-k", Script::default());
    let revision = service.journal().revision();
    std::fs::remove_file(&witness).unwrap();
    assert_eq!(service.prepare_workload(&prepare_request("k", "lease-k", &KINDS), Some(&workload()), 1).err(), Some(Code::KeeperUnavailable));
    std::fs::write(&witness, rw_target_helper::journal::store_witness_text(&id("other-store")).unwrap()).unwrap();
    assert_eq!(service.prepare_workload(&prepare_request("k", "lease-k", &KINDS), Some(&workload()), 1).err(), Some(Code::KeeperUnavailable));
    assert_eq!(service.journal().revision(), revision, "nothing was persisted");
    assert_eq!(lookup(&mut service, "k").str_at("state"), Some("absent-with-proof"));
    assert_eq!(spawns(&fixture), 0);
    std::fs::write(&witness, &original).unwrap();
    assert_eq!(service.prepare_workload(&prepare_request("k", "lease-k", &KINDS), Some(&workload()), 1).unwrap().str_at("state"), Some("prepared"));
}

#[test]
fn a_record_without_an_attempt_rests_stopping_then_quarantine_succeeds_and_release_refuses() {
    let fixture = fixture("sup-no-attempt");
    let mut journal = Journal::open(&fixture.root, STORE, &id("helper-l0"), JournalLimits::default(), Duration::from_millis(1000)).unwrap();
    // A record that may have spawned, but whose key has no attempt in this (verified) store.
    let prepared = journal.prepare(&prepare_request("l", "lease-l", &KINDS), 1, &mut NoAttemptHooks).unwrap();
    assert_eq!(prepared.str_at("state"), Some("prepared"));
    drop(journal);
    let mut service = service(&fixture, "helper-l", Script::default());
    let settled = service.reconcile_at_start(2).unwrap();
    assert_eq!(settled[0].outcome, Ok("stopping".to_string()), "stop delivered (stopped), absence unknown");
    assert_eq!(service.stop(&obj(vec![("key", key("l"))]), 3).unwrap().str_at("state"), Some("stopping"));
    assert_eq!(service.release(&obj(vec![("key", key("l")), ("evidence", evidence(&prepared, "verified-absent"))]), 4).err(), Some(Code::AbsenceUnverified));
    // Stopped: a retried prepare never creates.
    assert_eq!(service.prepare_workload(&prepare_request("l", "lease-l", &KINDS), Some(&workload()), 5).unwrap().str_at("state"), Some("stopping"));
    assert_eq!(service.release(&obj(vec![("key", key("l")), ("evidence", evidence(&prepared, "quarantine"))]), 6).unwrap().str_at("state"), Some("quarantined"));
    assert_eq!(spawns(&fixture), 0);
}

#[test]
fn a_requested_but_unrecorded_workload_anchor_is_unverified_and_its_execution_stays_tracked() {
    let fixture = fixture("sup-unrecorded");
    let mut service = service(&fixture, "helper-m", Script { fail_workload: true, ..Script::default() });
    assert_eq!(service.prepare_workload(&prepare_request("m", "lease-m", &KINDS), Some(&workload()), 1).err(), Some(Code::OutcomeUnknown));
    let attempt = AttemptStore::at(&fixture.root, STORE).get(&sha256_hex(key_text(&key("m")).unwrap().as_bytes())).unwrap().unwrap();
    assert_eq!(attempt.requested, vec!["endpoint".to_string(), "workload".to_string()], "requested before each create");
    assert!(attempt.endpoint.is_some() && attempt.anchor.is_none(), "the endpoint identity is recorded; the anchor never was");
    assert_eq!(service.launcher().describe()[0].3, "failed", "the execution is kept tracked");
    assert_eq!(service.stop(&obj(vec![("key", key("m"))]), 2).unwrap().str_at("state"), Some("stopping"));
    let resources = obj(vec![("resources", Value::Arr(prepare_request("m", "lease-m", &KINDS).get("resources").and_then(Value::arr).unwrap().iter().map(|resource| obj(vec![("resourceId", resource.get("resourceId").cloned().unwrap()), ("kind", s("verified-absent")), ("evidenceDigest", s(&dg("e")))])).collect()))]);
    assert_eq!(service.release(&obj(vec![("key", key("m")), ("evidence", resources)]), 3).err(), Some(Code::AbsenceUnverified));
    // A later helper process judges the same attempt from the record alone: still unverified.
    drop(service);
    let mut later = service_named(&fixture, "helper-m2");
    assert_eq!(later.reconcile_at_start(4).unwrap()[0].outcome, Ok("stopping".to_string()));
    assert_eq!(spawns(&fixture), 1);
}

fn service_named(fixture: &Fixture, incarnation: &str) -> TargetService<KeeperSupervisor> {
    service(fixture, incarnation, Script::default())
}

#[test]
fn an_exit_is_reported_only_after_its_absence_is_verified_and_then_exactly_once() {
    use std::sync::atomic::AtomicBool;
    let fixture = fixture("sup-latch");
    let allow = Arc::new(AtomicBool::new(false));
    let gate = allow.clone();
    let journal = Journal::open(&fixture.root, STORE, &id("helper-n"), JournalLimits::default(), Duration::from_millis(1000)).unwrap();
    let supervisor = KeeperSupervisor::new(Box::new(FakeSpawner { script: Script { exit_after_commit: Some(0), ..Script::default() }, shared: fixture.shared.clone() }), &fixture.root, &fixture.runtime, &id("helper-n"), STORE)
        .with_probe(Box::new(move |identity: &ProcIdentity| if gate.load(Ordering::SeqCst) { identity_liveness(identity) } else { Liveness::Unknown }));
    let mut service = TargetService::new(journal, supervisor);
    let prepared = service.prepare_workload(&prepare_request("n", "lease-n", &KINDS), Some(&workload()), 1).unwrap();
    service.commit(&commit_request("n", &prepared), 1).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    // The exit arrived but /proc answers nothing decidable: nothing is reported or journaled.
    assert!(service.pump(2).is_empty());
    assert_eq!(lookup(&mut service, "n").str_at("state"), Some("running"));
    // A retry of the failed verification probes once and never waits.
    let started = std::time::Instant::now();
    assert!(service.pump(2).is_empty());
    assert!(started.elapsed() < Duration::from_millis(1000), "retry took {:?}", started.elapsed());
    allow.store(true, Ordering::SeqCst);
    let journaled = service.pump(3);
    assert_eq!(journaled.len(), 1);
    assert_eq!((journaled[0].cause, journaled[0].outcome.clone()), ("workload_exit", Ok("exited".to_string())));
    assert!(service.pump(4).is_empty(), "reported once");
}

#[test]
fn liveness_is_gone_only_for_no_such_process_a_zombie_or_another_start_time() {
    let identity = ProcIdentity { pid: 4242, start_time: "1000".into(), pid_ns: None };
    let line = |state: &str, start: &str| format!("4242 (sh) {state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0");
    assert_eq!(liveness_from(Ok(line("S", "1000")), &identity), Liveness::Alive);
    assert_eq!(liveness_from(Ok(line("Z", "1000")), &identity), Liveness::Gone);
    assert_eq!(liveness_from(Ok(line("S", "1001")), &identity), Liveness::Gone, "the pid names another process");
    assert_eq!(liveness_from(Err(std::io::Error::from_raw_os_error(libc::ENOENT)), &identity), Liveness::Gone);
    assert_eq!(liveness_from(Err(std::io::Error::from_raw_os_error(libc::ESRCH)), &identity), Liveness::Gone);
    // Injected read errors are undecidable, never gone.
    for errno in [libc::EACCES, libc::EIO, libc::EMFILE, libc::EPERM] {
        assert_eq!(liveness_from(Err(std::io::Error::from_raw_os_error(errno)), &identity), Liveness::Unknown, "errno {errno}");
    }
    assert_eq!(liveness_from(Ok("garbage".into()), &identity), Liveness::Unknown);
    assert_eq!(liveness_from(Ok(line("S", "x")), &identity), Liveness::Unknown);
    for start in ["", "abc", "12a"] {
        let recorded = ProcIdentity { start_time: start.into(), ..identity.clone() };
        assert_eq!(liveness_from(Err(std::io::Error::from_raw_os_error(libc::ENOENT)), &recorded), Liveness::Unknown, "recorded start {start:?}");
    }
    // An undecidable identity is never verified absent, and a stop never signals it.
    let host = HostIdentity::current();
    let (mut live, live_identity) = real_process(host.helper.pid_ns.clone());
    let record = attempt(host.helper.clone(), host.boot_id.clone(), Some(live_identity.clone()), None);
    let unknown = |_: &ProcIdentity| Liveness::Unknown;
    assert!(!attempt_absence(&record, &host, &unknown));
    deliver_attempt_stop(&record, &host, &unknown);
    assert!(identity_alive(&live_identity), "an undecidable identity is never signalled");
    live.kill().unwrap();
    live.wait().unwrap();
}

#[test]
fn a_requested_role_without_an_identity_is_unverified_unless_the_boot_changed() {
    let host = HostIdentity::current();
    let mut record = attempt(host.helper.clone(), host.boot_id.clone(), None, None);
    record.requested = vec!["keeper".into(), "workload".into()];
    assert!(!attempt_absence(&record, &host, &identity_liveness));
    record.boot_id = Some("00000000-0000-0000-0000-000000000000".into());
    assert!(attempt_absence(&record, &host, &identity_liveness));
}

#[test]
fn quarantine_drops_an_unverifiable_execution_and_frees_its_slot_without_claiming_absence() {
    let fixture = fixture("sup-quarantine-slot");
    let journal = Journal::open(&fixture.root, STORE, &id("helper-q"), JournalLimits::default(), Duration::from_millis(1000)).unwrap();
    let supervisor = KeeperSupervisor::new(Box::new(FakeSpawner { script: Script { fail_workload: true, fail_workload_once: true, ..Script::default() }, shared: fixture.shared.clone() }), &fixture.root, &fixture.runtime, &id("helper-q"), STORE).with_capacity(1);
    let mut service = TargetService::new(journal, supervisor);
    // The workload anchor was requested but never recorded: the execution can never be verified and holds the one slot.
    assert_eq!(service.prepare_workload(&prepare_request("q1", "lease-q", &KINDS), Some(&workload()), 1).err(), Some(Code::OutcomeUnknown));
    assert_eq!(service.prepare_workload(&prepare_request("q2", "lease-q", &KINDS), Some(&workload()), 1).err(), Some(Code::CapacityExceeded));
    assert_eq!(service.stop(&obj(vec![("key", key("q1"))]), 2).unwrap().str_at("state"), Some("stopping"));
    for _ in 0..3 {
        service.pump(3);
    }
    assert_eq!(service.prepare_workload(&prepare_request("q2", "lease-q", &KINDS), Some(&workload()), 4).err(), Some(Code::CapacityExceeded), "without quarantine the slot stays held");
    assert_eq!(service.launcher().describe().len(), 1);
    let quarantine = obj(vec![("resources", Value::Arr(prepare_request("q1", "lease-q", &KINDS).get("resources").and_then(Value::arr).unwrap().iter().map(|resource| obj(vec![("resourceId", resource.get("resourceId").cloned().unwrap()), ("kind", s("quarantine"))])).collect()))]);
    assert_eq!(service.release(&obj(vec![("key", key("q1")), ("evidence", quarantine)]), 5).unwrap().str_at("state"), Some("quarantined"));
    assert!(service.launcher().describe().is_empty(), "the tracked execution was dropped");
    // Absence is still never claimed for the quarantined key.
    assert_eq!(service.launcher_mut().absence_verified(&key_text(&key("q1")).unwrap()), Ok(false));
    assert_eq!(lookup(&mut service, "q1").str_at("state"), Some("quarantined"));
    // The slot is free: a new key prepares.
    assert_eq!(service.prepare_workload(&prepare_request("q3", "lease-q3", &KINDS), Some(&workload()), 6).unwrap().str_at("state"), Some("prepared"));
    assert_eq!(spawns(&fixture), 2);
}

use super::*;
use rw_proto::json::{self, parse};
use rw_proto::keeper_frames;
use rw_proto::mount_frames::{validate_mount_reply, validate_root_lease_reply};

#[derive(Default)]
struct FakeOs {
    delay_create: bool,
    delay_commit: bool,
    pending_creates: Vec<(OperationId, Created)>,
    pending_commits: Vec<OperationId>,
    commit_latches: std::collections::HashMap<OperationId, CommitLatch>,
    completions: VecDeque<Completion>,
    cancelled: Vec<(OperationId, bool)>,
    discarded: Vec<OperationId>,
    owned_launch_fds: std::collections::HashMap<OperationId, Vec<std::os::fd::OwnedFd>>,
    stream_failure: bool,
    creates: Vec<(String, CreateKind)>,
    commits: Vec<String>,
    aborts: Vec<String>,
    stops: Vec<(String, i64)>,
    steps: Vec<EndStep>,
    writes: Vec<Vec<u8>>,
    /// Bytes the PTY master accepts per write call (0 = would block).
    write_capacity: usize,
    detached: Vec<String>,
    signals: Vec<(i64, Signal)>,
    killed_stages: Vec<String>,
    next_pid: i64,
    fail_create: Option<OsError>,
    fail_commit: Option<OsError>,
    fail_detach: bool,
    mounts: u32,
}

impl KeeperOs for FakeOs {
    fn begin_create(&mut self, operation: &OperationId, kind: CreateKind, marker: Option<&str>, locator: &Value, spec: &Spec, _deadline: u64) -> Progress<Result<Created, OsError>> {
        let result = self.create(&operation.handle, kind, marker, locator, spec);
        if self.delay_create {
            if let Ok(created) = result { self.pending_creates.push((operation.clone(), created)); return Progress::Pending; }
        }
        Progress::Ready(result)
    }
    fn begin_commit(&mut self, operation: &OperationId, kind: CreateKind, _deadline: u64) -> Progress<Result<CommitState, OsError>> {
        if self.delay_commit { self.pending_commits.push(operation.clone()); return Progress::Pending; }
        Progress::Ready(self.commit(&operation.handle, kind).map(|state| if state == "executed" { CommitState::Executed } else { CommitState::Committed }))
    }
    fn poll_completion(&mut self, _now_ms: u64) -> Option<Completion> { self.completions.pop_front() }
    fn take_commit_latch(&mut self, operation: &OperationId) -> Option<CommitLatch> { self.commit_latches.remove(operation) }
    fn cancel_launch(&mut self, operation: &OperationId, committed: bool) { self.commit_latches.remove(operation); self.owned_launch_fds.remove(operation); self.cancelled.push((operation.clone(), committed)); }
    fn discard_created(&mut self, operation: OperationId, _created: Created) { self.owned_launch_fds.remove(&operation); self.discarded.push(operation); }
    fn commit_failure_code(&self, _operation: &OperationId) -> &'static str { if self.stream_failure { "stream_connect_failed" } else { "exec_failed" } }
    fn create(&mut self, handle: &str, kind: CreateKind, _marker: Option<&str>, locator: &Value, _spec: &Spec) -> Result<Created, OsError> {
        if let Some(error) = self.fail_create {
            return Err(error);
        }
        self.creates.push((handle.to_string(), kind));
        self.next_pid += 1;
        let identity = match kind {
            CreateKind::RuntimeDir => WireIdentity::RuntimeDir { path: locator.get("path").and_then(Value::as_str).unwrap().to_string(), dev: 64769, ino: 12 },
            CreateKind::Netns => WireIdentity::Netns { net_ns: 4026532100 },
            CreateKind::Cgroup => WireIdentity::Cgroup { path: "/sys/fs/cgroup/x".into(), cgroup_id: 7 },
            CreateKind::Pty => WireIdentity::Pty { pty: handle.to_string(), devpts_dev: 99, index: 0 },
            _ => WireIdentity::Process { pid: 5000 + self.next_pid, start_time: 123, pid_ns: 4026532200 },
        };
        let pid = kind.process_bearing().then_some(5000 + self.next_pid);
        Ok(Created { identity, pid })
    }
    fn commit(&mut self, handle: &str, kind: CreateKind) -> Result<&'static str, OsError> {
        self.commits.push(handle.to_string());
        if let Some(error) = self.fail_commit {
            return Err(error);
        }
        Ok(if kind.process_bearing() { "executed" } else { "committed" })
    }
    fn abort(&mut self, handles: &[String]) {
        self.owned_launch_fds.retain(|owner, _| !handles.contains(&owner.handle));
        self.aborts.extend(handles.iter().cloned());
    }
    fn stop(&mut self, handle: &str, grace_ms: i64) {
        self.stops.push((handle.to_string(), grace_ms));
    }
    fn tempdir(&mut self) -> Result<String, OsError> {
        Ok("/tmp/ala-0123456789abcdef".into())
    }
    fn end_step(&mut self, step: EndStep) {
        self.steps.push(step);
    }
    fn pty_write(&mut self, _handle: &str, data: &[u8]) -> Result<usize, &'static str> {
        let count = data.len().min(self.write_capacity);
        if count > 0 {
            self.writes.push(data[..count].to_vec());
        }
        Ok(count)
    }
    fn pty_resize(&mut self, _handle: &str, _cols: i64, _rows: i64) -> Result<(), &'static str> {
        Ok(())
    }
    fn descriptor_count(&mut self) -> i64 {
        9
    }
    fn mount_view(&mut self, request: &MountRequest, resource: &str) -> Result<MountedIdentity, (RefusalKind, &'static str)> {
        Ok(MountedIdentity {
            resource: resource.to_string(), mount_id: 800, mountpoint: request.mountpoint.clone(), mount_namespace_inode: 4026532001,
            server_pid: 4242, server_start_time: 77, server_pid_namespace_inode: 4026531836,
        })
    }
    fn detach(&mut self, identity: &MountedIdentity) -> Result<(), &'static str> {
        if self.fail_detach {
            return Err("detach_failed");
        }
        self.detached.push(identity.resource.clone());
        Ok(())
    }
    fn signal(&mut self, pid: i64, signal: Signal) {
        self.signals.push((pid, signal));
    }
    fn kill_stage(&mut self, handle: &str) {
        self.owned_launch_fds.retain(|owner, _| owner.handle != handle);
        self.killed_stages.push(handle.to_string());
    }
    fn new_mount_handle(&mut self) -> String {
        self.mounts += 1;
        format!("m{:032x}", self.mounts)
    }
}

const ROOT: &str = "/run/robo-work";
const RUNTIME_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUNTIME_HANDLE: &str = "10000000000000000000000000000001";
const NETNS: &str = "10000000000000000000000000000002";
const PTY: &str = "10000000000000000000000000000003";
const MARKER: &str = "AAECAwQFBgcICQoLDA0ODw";
const TREE: &str = "000102030405060708090a0b0c0d0e0f";
/// The keeper's own S1 id, carried in every dependent locator (`keeper`).
const KEEPER: &str = "ABEiM0RVZneImaq7zN3u_w";
/// A valid DS006 start request (from the shared vectors' "create workload").
const START_REQUEST: &str = r#"{"processClass":"run","executable":"codex","args":["exec","hello"],"env":{"IS_SANDBOX":"1"},"home":"/home/robot","cwd":"/projects/g","folders":[{"path":"/projects/g","access":"read"}],"exclusions":[],"communication":{"kind":"streams","stdin":"ignore"},"lifecycle":{"stopGraceMs":2000},"network":"robot-egress","requirements":{"privateProc":true}}"#;

struct Rig {
    core: KeeperCore<FakeOs>,
    next_id: i64,
}

impl Rig {
    fn queue_tree(&mut self, handle: &str) -> OperationId {
        self.send(&format!(r#"{{"op":"create","resource":"{handle}","kind":"process-tree","marker":"{MARKER}","locator":{{"role":"process-tree","id":"66666666666666666666666666666666","keeper":"{KEEPER}","marker":"{MARKER}"}},"spec":{{"role":"workload","process":1,"request":{START_REQUEST},"streams":{{"stdout":"/s/1"}},"netns":"{NETNS}"}}}}"#));
        OperationId { handle: handle.into(), request_id: self.next_id }
    }

    fn new() -> Rig {
        let mut rig = Rig { core: KeeperCore::new(FakeOs { write_capacity: usize::MAX, ..FakeOs::default() }, Scope::Execution, ROOT, KEEPER, 1, KeeperLimits::default(), ViewLimits::default()), next_id: 0 };
        assert_eq!(rig.send(r#"{"op":"commit_keeper"}"#), Handled::Continue);
        rig.flush();
        rig
    }

    /// Sends a request with the next id (the `id` key is added).
    fn send(&mut self, body: &str) -> Handled {
        self.next_id += 1;
        let text = format!(r#"{{"id":{},{}"#, self.next_id, &body[1..]);
        let value = parse(text.as_bytes()).unwrap();
        self.core.handle_frame(&value, 0)
    }

    fn take(&mut self) -> Vec<Value> {
        self.core.take_outbound()
    }

    /// Takes the outbound frames and reports every reply as flushed.
    fn flush(&mut self) -> Vec<Value> {
        let out = self.take();
        for frame in &out {
            if let Some(id) = frame.get("id").and_then(Value::as_safe_int) {
                self.core.reply_flushed(id);
            }
        }
        out
    }

    fn last(&mut self) -> Value {
        self.flush().pop().expect("a reply")
    }

    fn setup_runtime(&mut self) {
        self.send(&format!(r#"{{"op":"create","resource":"{RUNTIME_HANDLE}","kind":"runtime-dir","marker":null,"locator":{{"path":"{ROOT}/x/{RUNTIME_ID}","keeper":"{KEEPER}"}},"spec":{{}}}}"#));
        self.send(&format!(r#"{{"op":"commit","resource":"{RUNTIME_HANDLE}"}}"#));
        self.flush();
    }

    fn setup_netns(&mut self) {
        self.send(&format!(r#"{{"op":"create","resource":"{NETNS}","kind":"netns","marker":null,"locator":{{"netns":"33333333333333333333333333333333","keeper":"{KEEPER}"}},"spec":{{}}}}"#));
        self.send(&format!(r#"{{"op":"commit","resource":"{NETNS}"}}"#));
        self.flush();
    }

    fn setup_pty(&mut self) {
        self.send(&format!(r#"{{"op":"create","resource":"{PTY}","kind":"pty","marker":null,"locator":{{"pty":"44444444444444444444444444444444","keeper":"{KEEPER}"}},"spec":{{"cols":80,"rows":24}}}}"#));
        self.send(&format!(r#"{{"op":"commit","resource":"{PTY}"}}"#));
        self.flush();
    }

    fn create_tree(&mut self) -> Value {
        self.send(&format!(
            r#"{{"op":"create","resource":"{TREE}","kind":"process-tree","marker":"{MARKER}","locator":{{"role":"process-tree","id":"66666666666666666666666666666666","keeper":"{KEEPER}","marker":"{MARKER}"}},"spec":{{"role":"workload","process":1,"request":{START_REQUEST},"streams":{{"stdout":"/s/1"}},"netns":"{NETNS}"}}}}"#
        ));
        self.last()
    }
}

#[test]
fn pending_create_abort_wins_before_and_after_queued_ready() {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    for queued_first in [false, true] {
        let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
        rig.core.os.delay_create = true;
        let operation = rig.queue_tree(TREE);
        let (partial, mut partial_peer) = UnixStream::pair().unwrap();
        rig.core.os.owned_launch_fds.insert(operation.clone(), vec![partial.into()]);
        assert!(rig.take().is_empty());
        assert_eq!(rig.core.resources[rig.core.find(TREE).unwrap()].state, State::Creating);
        let (owner, created) = rig.core.os.pending_creates.pop().unwrap();
        if queued_first { rig.core.os.completions.push_back(Completion::Created { operation: owner.clone(), result: Ok(created.clone()) }); }
        rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#));
        let out = rig.flush();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], error_reply(operation.request_id, ErrorKind::Failure, "setup_failed"));
        assert_eq!(out[1], ok_reply(rig.next_id, empty()));
        assert_eq!(rig.core.os.cancelled, vec![(operation.clone(), false)]);
        partial_peer.set_nonblocking(true).unwrap();
        assert_eq!(partial_peer.read(&mut [0]).unwrap(), 0, "partial acquisitions closed on cancel");
        let (late, mut late_peer) = UnixStream::pair().unwrap();
        rig.core.os.owned_launch_fds.insert(operation.clone(), vec![late.into()]);
        if !queued_first { rig.core.os.completions.push_back(Completion::Created { operation: owner, result: Ok(created) }); }
        rig.core.tick(1);
        assert!(rig.take().is_empty(), "no late create success or exit");
        assert_eq!(rig.core.os.discarded, vec![operation]);
        late_peer.set_nonblocking(true).unwrap();
        assert_eq!(late_peer.read(&mut [0]).unwrap(), 0, "late owned result closed rather than published");
        assert_eq!(rig.core.resources[rig.core.find(TREE).unwrap()].state, State::Aborted);
        rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#));
        assert_eq!(rig.flush().len(), 1);
        assert_eq!(rig.core.os.cancelled.len(), 1, "no repeated cleanup of a tombstone");
        assert_eq!(rig.core.ordinary_in_flight(), 0);
    }
}

#[test]
fn unknown_abort_and_stale_completion_cannot_cancel_or_complete_a_future_operation() {
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#)); rig.flush();
    rig.core.os.delay_create = true;
    let operation = rig.queue_tree(TREE);
    let (_, created) = rig.core.os.pending_creates.pop().unwrap();
    let stale = OperationId { request_id: operation.request_id - 2, ..operation.clone() };
    rig.core.os.completions.push_back(Completion::Created { operation: stale.clone(), result: Ok(created.clone()) });
    rig.core.os.completions.push_back(Completion::Exited { owner: stale.clone(), pid: created.pid.unwrap(), code: Some(0), signal: None });
    rig.core.tick(1);
    assert!(rig.take().is_empty());
    assert_eq!(rig.core.os.discarded, vec![stale]);
    assert!(rig.core.os.cancelled.is_empty());
    rig.core.os.completions.push_back(Completion::Created { operation: operation.clone(), result: Ok(created) });
    rig.core.tick(2);
    let out = rig.flush();
    assert_eq!(out.len(), 1); assert_eq!(out[0].get("id").and_then(Value::as_safe_int), Some(operation.request_id));
    assert_eq!(out[0].get("ok"), Some(&Value::Bool(true)));
}

#[test]
fn accepted_pending_commit_rejects_duplicates_and_abort_then_replies_before_exit() {
    for succeeds in [false, true] {
        let mut rig = Rig::new(); let pid = rig.tree_pid();
        let create_id = rig.core.resources[rig.core.find(TREE).unwrap()].create_request;
        rig.core.os.delay_commit = true;
        rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        let operation = rig.core.os.pending_commits[0].clone();
        assert!(rig.take().is_empty());
        assert!(rig.core.resources[rig.core.find(TREE).unwrap()].committed);
        rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        assert_eq!(error(&rig.last()), Some("already_committed"));
        rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}","ffffffffffffffffffffffffffffffff"]}}"#));
        assert_eq!(error(&rig.last()), Some("already_committed"));
        assert!(rig.core.os.cancelled.is_empty());
        rig.send(r#"{"op":"ping"}"#); assert_eq!(rig.last().get("ok"), Some(&Value::Bool(true)));
        let result = if succeeds { Ok(CommitLatch { state: CommitState::Executed, observed_at_ms: 1 }) } else { Err((ErrorKind::Failure, "exec_failed")) };
        rig.core.os.completions.push_back(Completion::Committed { operation: operation.clone(), result });
        rig.core.os.completions.push_back(Completion::Exited { owner: OperationId { handle: TREE.into(), request_id: create_id }, pid, code: Some(0), signal: None });
        rig.core.tick(1);
        let out = rig.flush();
        assert_eq!(out.len(), 2); assert_eq!(out[0].get("id").and_then(Value::as_safe_int), Some(operation.request_id));
        assert_eq!(out[0].get("ok"), Some(&Value::Bool(succeeds)));
        assert_eq!(out[1], exit_event(TREE, Some(0), None));
        assert!(!rig.core.child_exited(pid, Some(0), None));
        assert!(rig.take().is_empty());
        assert_eq!(rig.core.os.killed_stages.len(), usize::from(!succeeds));
        assert_eq!(rig.core.ordinary_in_flight(), 0);
    }
}

#[test]
fn death_during_pending_commit_is_failure_even_before_gate_release() {
    let mut rig = Rig::new(); let pid = rig.tree_pid();
    rig.core.os.delay_commit = true;
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    let operation = rig.core.os.pending_commits[0].clone();
    assert!(rig.core.child_exited(pid, Some(125), None));
    let out = rig.flush();
    assert_eq!(out, vec![error_reply(operation.request_id, ErrorKind::Failure, "exec_failed"), exit_event(TREE, Some(125), None)]);
    rig.core.os.completions.push_back(Completion::Committed { operation, result: Ok(CommitLatch { state: CommitState::Executed, observed_at_ms: 1 }) });
    rig.core.tick(1);
    assert!(rig.take().is_empty(), "late apparent success cannot change failed ownership");
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    assert_eq!(error(&rig.last()), Some("already_committed"));
}

#[test]
fn end_cancels_pending_create_and_preserves_accepted_commit_exit_obligation() {
    for committing in [false, true] {
        let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
        let pid;
        let operation;
        if committing {
            let created = rig.create_tree();
            pid = created.get("value").unwrap().get("identity").unwrap().get("pid").and_then(Value::as_safe_int).unwrap();
            rig.core.os.delay_commit = true; rig.core.os.stream_failure = true;
            rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
            operation = rig.core.os.pending_commits[0].clone();
        } else {
            rig.core.os.delay_create = true; operation = rig.queue_tree(TREE); pid = rig.core.os.pending_creates[0].1.pid.unwrap();
        }
        rig.send(r#"{"op":"end_process_trees"}"#);
        let out = rig.flush();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], error_reply(operation.request_id, ErrorKind::Failure, if committing { "stream_connect_failed" } else { "setup_failed" }));
        assert_eq!(out[1], ok_reply(rig.next_id, empty()));
        assert_eq!(rig.core.os.cancelled, vec![(operation, committing)]);
        assert_eq!(rig.core.child_exited(pid, None, Some("SIGKILL")), committing);
        assert_eq!(rig.flush(), if committing { vec![exit_event(TREE, None, Some("SIGKILL"))] } else { vec![] });
        rig.send(r#"{"op":"end_process_trees"}"#); rig.flush();
        assert_eq!(rig.core.os.cancelled.len(), 1);
    }
}

#[test]
fn deadlines_reject_late_ready_and_commit_success_without_restarting_budget() {
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns(); rig.core.os.delay_create = true;
    let operation = rig.queue_tree(TREE);
    assert_eq!(rig.core.next_deadline(), Some(5000));
    let (_, created) = rig.core.os.pending_creates.pop().unwrap();
    rig.core.os.completions.push_back(Completion::Created { operation: operation.clone(), result: Ok(created) });
    rig.core.tick(5000);
    assert_eq!(rig.flush(), vec![error_reply(operation.request_id, ErrorKind::Failure, "setup_failed")]);
    assert_eq!(rig.core.os.discarded, vec![operation]);
    let mut rig = Rig::new(); let pid = rig.tree_pid(); rig.core.os.delay_commit = true;
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    let operation = rig.core.os.pending_commits[0].clone();
    assert_eq!(rig.core.next_deadline(), Some(5000));
    rig.core.tick(4999); assert!(rig.take().is_empty());
    rig.core.os.completions.push_back(Completion::Committed { operation: operation.clone(), result: Ok(CommitLatch { state: CommitState::Executed, observed_at_ms: 5000 }) });
    rig.core.tick(5000);
    assert_eq!(rig.flush(), vec![error_reply(operation.request_id, ErrorKind::Failure, "exec_failed")]);
    assert!(rig.core.child_exited(pid, Some(0), None));
    assert_eq!(rig.flush(), vec![exit_event(TREE, Some(0), None)]);
}

#[test]
fn each_partial_stream_failure_closes_owned_fds_and_owes_one_exit() {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    // Failure connecting the first/second/third socket, then failure installing all three acquired sockets.
    for acquired in 0..=3 {
        let mut rig = Rig::new(); let pid = rig.tree_pid();
        let prior_commits = rig.core.os.commits.len();
        rig.core.os.delay_commit = true;
        rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        let operation = rig.core.os.pending_commits[0].clone();
        let (fds, mut peers): (Vec<_>, Vec<_>) = (0..acquired).map(|_| {
            let (fd, peer) = UnixStream::pair().unwrap(); (std::os::fd::OwnedFd::from(fd), peer)
        }).unzip();
        rig.core.os.owned_launch_fds.insert(operation.clone(), fds);
        rig.core.os.completions.push_back(Completion::Committed { operation: operation.clone(), result: Err((ErrorKind::Failure, "stream_connect_failed")) });
        rig.core.tick(1);
        assert_eq!(rig.flush(), vec![error_reply(operation.request_id, ErrorKind::Failure, "stream_connect_failed")]);
        assert_eq!(rig.core.os.commits.len(), prior_commits, "the gate-release adapter was never invoked");
        for peer in &mut peers { peer.set_nonblocking(true).unwrap(); assert_eq!(peer.read(&mut [0]).unwrap(), 0); }
        assert_eq!(rig.core.os.killed_stages, vec![TREE.to_string()]);
        assert!(rig.core.child_exited(pid, Some(125), None));
        assert_eq!(rig.flush(), vec![exit_event(TREE, Some(125), None)]);
        assert!(!rig.core.child_exited(pid, Some(125), None));
        assert!(rig.take().is_empty());
    }
}

#[test]
fn synchronous_create_failure_keeps_the_existing_retry_contract() {
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
    rig.core.os.fail_create = Some((ErrorKind::Failure, "setup_failed"));
    assert_eq!(error(&rig.create_tree()), Some("setup_failed"));
    assert!(rig.core.find(TREE).is_none());
    rig.core.os.fail_create = None;
    assert_eq!(rig.create_tree().get("ok"), Some(&Value::Bool(true)));
}

#[test]
fn review_latched_exec_survives_bounded_completion_drain_delay() {
    use crate::launch::{Launch, ChildBinding, ProcessIdentity, Observation, LaunchPhase};
    // 32 exercises the completion branch at the deadline; 64 leaves proof behind the drain during the expiry sweep.
    for backlog in [32, 64] {
        let mut rig = Rig::new();
        let pid = rig.tree_pid();
        rig.core.os.delay_commit = true;
        rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        let operation = rig.core.os.pending_commits[0].clone();
        let child = ProcessIdentity { pid: pid + 1, start_time: 2, pid_ns: 7 };
        let binding = ChildBinding { anchor: ProcessIdentity { pid, start_time: 1, pid_ns: 7 }, child, stage: (1, 20), intended: (1, 30) };
        let mut launch = Launch::new(0, &KeeperLimits::default()).unwrap();
        launch.ready(binding, 0).unwrap();
        launch.begin_commit(0, &KeeperLimits::default(), false).unwrap();
        launch.installed(1).unwrap();
        launch.observe(Observation { before: child, after: child, alive_before: true, alive_after: true, executable: Some(binding.intended) }, 4999);
        assert_eq!(launch.phase, LaunchPhase::Executed);
        let latch = launch.commit_latch().unwrap();
        assert_eq!(latch.observed_at_ms, 4999);
        rig.core.os.commit_latches.insert(operation.clone(), latch);
        for id in 0..backlog {
            rig.core.os.completions.push_back(Completion::Exited { owner: OperationId { handle: "unknown".into(), request_id: id }, pid: 999, code: Some(0), signal: None });
        }
        rig.core.os.completions.push_back(Completion::Committed { operation: operation.clone(), result: Ok(latch) });
        rig.core.tick(4999);
        assert!(rig.take().is_empty());
        launch.stage_died();
        assert_eq!(launch.phase, LaunchPhase::Executed);
        assert_eq!(launch.commit_latch(), Some(latch));
        rig.core.tick(5000);
        assert_eq!(rig.flush(), vec![ok_reply(operation.request_id, state_value("executed"))], "positive result was latched before the deadline; backlog {backlog}");
        assert!(rig.core.os.killed_stages.is_empty());
        assert!(rig.core.os.cancelled.is_empty());
        rig.core.tick(5001);
        assert!(rig.take().is_empty(), "the queued duplicate completion never replies twice");
        assert!(rig.core.child_exited(pid, Some(0), None));
        assert_eq!(rig.flush(), vec![exit_event(TREE, Some(0), None)]);
        assert!(!rig.core.child_exited(pid, Some(0), None));
    }
}

#[test]
fn review_duplicate_created_does_not_destroy_the_live_operation() {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
    rig.core.os.delay_create = true;
    let operation = rig.queue_tree(TREE);
    let (_, created) = rig.core.os.pending_creates.pop().unwrap();
    let (owned, mut peer) = UnixStream::pair().unwrap();
    peer.set_nonblocking(true).unwrap();
    rig.core.os.owned_launch_fds.insert(operation.clone(), vec![owned.into()]);
    rig.core.os.completions.push_back(Completion::Created { operation: operation.clone(), result: Ok(created.clone()) });
    rig.core.tick(1);
    assert_eq!(rig.flush().len(), 1);
    assert_eq!(peer.read(&mut [0]).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    rig.core.os.completions.push_back(Completion::Created { operation: operation.clone(), result: Ok(created.clone()) });
    rig.core.tick(2);
    assert!(rig.take().is_empty());
    let retained = matches!(peer.read(&mut [0]), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock);
    assert!(retained, "same-token duplicate discarded live custody: {:?}", rig.core.os.discarded);
    assert!(rig.core.os.discarded.is_empty());
    rig.commit_tree();
    rig.core.os.completions.push_back(Completion::Created { operation, result: Ok(created) });
    rig.core.tick(3);
    assert!(rig.take().is_empty());
    assert!(rig.core.os.discarded.is_empty());
    assert_eq!(peer.read(&mut [0]).unwrap_err().kind(), std::io::ErrorKind::WouldBlock, "committed ownership is retained too");
}

#[test]
fn review_pending_create_refusal_is_setup_failure() {
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
    rig.core.os.delay_create = true;
    let operation = rig.queue_tree(TREE);
    rig.core.os.completions.push_back(Completion::Created { operation: operation.clone(), result: Err((ErrorKind::Refused, "inventory_miss")) });
    rig.core.tick(1);
    assert_eq!(rig.flush(), vec![error_reply(operation.request_id, ErrorKind::Failure, "setup_failed")]);
}

#[test]
fn late_or_future_commit_proof_fails_and_cancelled_operations_never_resurrect() {
    for observed_at_ms in [4999, 5000, 5001, 6000] {
        let mut rig = Rig::new(); let pid = rig.tree_pid(); rig.core.os.delay_commit = true;
        rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        let operation = rig.core.os.pending_commits[0].clone();
        rig.core.os.completions.push_back(Completion::Committed { operation: operation.clone(), result: Ok(CommitLatch { state: CommitState::Executed, observed_at_ms }) });
        rig.core.tick(5001);
        let expected = if observed_at_ms < 5000 { ok_reply(operation.request_id, state_value("executed")) }
            else { error_reply(operation.request_id, ErrorKind::Failure, "exec_failed") };
        assert_eq!(rig.flush(), vec![expected], "observed at {observed_at_ms}");
        assert!(rig.core.child_exited(pid, Some(0), None));
        assert_eq!(rig.flush(), vec![exit_event(TREE, Some(0), None)]);
    }
    let mut rig = Rig::new(); let pid = rig.tree_pid(); rig.core.os.delay_commit = true;
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    let operation = rig.core.os.pending_commits[0].clone();
    rig.send(r#"{"op":"end_process_trees"}"#);
    let out = rig.flush();
    assert_eq!(out[0], error_reply(operation.request_id, ErrorKind::Failure, "exec_failed"));
    assert_eq!(out.len(), 2);
    let late = CommitLatch { state: CommitState::Executed, observed_at_ms: 4999 };
    rig.core.os.commit_latches.insert(operation.clone(), late);
    rig.core.os.completions.push_back(Completion::Committed { operation, result: Ok(late) });
    rig.core.tick(5000);
    assert!(rig.take().is_empty());
    assert_eq!(rig.core.resources[rig.core.find(TREE).unwrap()].state, State::CommitFailed);
    assert_eq!(rig.core.os.cancelled.len(), 1);
    assert!(rig.core.child_exited(pid, Some(0), None));
    assert_eq!(rig.flush(), vec![exit_event(TREE, Some(0), None)]);
}

#[test]
fn stale_and_cancelled_create_cleanup_never_aliases_a_live_operation() {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns(); rig.core.os.delay_create = true;
    let live = rig.queue_tree(TREE);
    let (_, created) = rig.core.os.pending_creates.pop().unwrap();
    let stale = OperationId { request_id: live.request_id - 1, ..live.clone() };
    let (live_fd, mut live_peer) = UnixStream::pair().unwrap();
    let (stale_fd, mut stale_peer) = UnixStream::pair().unwrap();
    rig.core.os.owned_launch_fds.insert(live.clone(), vec![live_fd.into()]);
    rig.core.os.owned_launch_fds.insert(stale.clone(), vec![stale_fd.into()]);
    rig.core.os.completions.push_back(Completion::Created { operation: live.clone(), result: Ok(created.clone()) });
    rig.core.tick(1); rig.flush();
    // Deliberately identical PID metadata is not authority for the stale token to close the live token's custody.
    rig.core.os.completions.push_back(Completion::Created { operation: stale.clone(), result: Ok(created.clone()) });
    rig.core.tick(2);
    assert!(rig.take().is_empty());
    stale_peer.set_nonblocking(true).unwrap(); live_peer.set_nonblocking(true).unwrap();
    assert_eq!(stale_peer.read(&mut [0]).unwrap(), 0);
    assert_eq!(live_peer.read(&mut [0]).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    assert_eq!(rig.core.os.discarded, vec![stale]);
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#)); rig.flush();
    assert_eq!(live_peer.read(&mut [0]).unwrap(), 0);
    for _ in 0..2 {
        rig.core.os.completions.push_back(Completion::Created { operation: live.clone(), result: Ok(created.clone()) });
        rig.core.tick(3);
        assert!(rig.take().is_empty());
    }
    assert!(rig.core.os.owned_launch_fds.is_empty());
    assert!(rig.core.os.killed_stages.is_empty(), "metadata never becomes raw-PID kill authority");
}

#[test]
fn every_scheduled_create_error_normalizes_and_closes_partial_custody() {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    for error in [(ErrorKind::Refused, "inventory_miss"), (ErrorKind::Failure, "stream_connect_failed"), (ErrorKind::Failure, "exec_failed")] {
        let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns(); rig.core.os.delay_create = true;
        let operation = rig.queue_tree(TREE);
        let (fd, mut peer) = UnixStream::pair().unwrap();
        rig.core.os.owned_launch_fds.insert(operation.clone(), vec![fd.into()]);
        rig.core.os.completions.push_back(Completion::Created { operation: operation.clone(), result: Err(error) });
        rig.core.tick(1);
        assert_eq!(rig.flush(), vec![error_reply(operation.request_id, ErrorKind::Failure, "setup_failed")]);
        peer.set_nonblocking(true).unwrap(); assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        assert_eq!(rig.core.os.cancelled, vec![(operation.clone(), false)]);
        let (_, created) = rig.core.os.pending_creates.pop().unwrap();
        assert!(!rig.core.child_exited(created.pid.unwrap(), Some(0), None));
        rig.core.os.completions.push_back(Completion::Created { operation, result: Ok(created) });
        rig.core.tick(2); assert!(rig.take().is_empty());
    }
    let mut rig = Rig::new(); rig.setup_runtime(); rig.setup_netns();
    rig.core.os.fail_create = Some((ErrorKind::Refused, "inventory_miss"));
    assert_eq!(rig.create_tree().get("kind").and_then(Value::as_str), Some("refused"));
    assert!(rig.core.os.cancelled.is_empty(), "pre-scheduling refusal remains unchanged");
}

#[test]
fn two_launch_completions_do_not_starve_ping_stop_or_cross_associate_results() {
    let mut rig = Rig::new(); let running_pid = rig.tree_pid(); rig.commit_tree();
    rig.core.os.delay_create = true;
    let first = rig.queue_tree("11111111111111111111111111111111");
    let second = rig.queue_tree("22222222222222222222222222222222");
    rig.send(r#"{"op":"ping"}"#); assert_eq!(rig.last().get("ok"), Some(&Value::Bool(true)));
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":0}}"#)); let stop_id = rig.next_id;
    assert_eq!(rig.core.os.stops, vec![(TREE.into(), 0)]);
    let (owner2, created2) = rig.core.os.pending_creates.pop().unwrap();
    let (owner1, created1) = rig.core.os.pending_creates.pop().unwrap();
    assert_eq!(owner1, first); assert_eq!(owner2, second);
    rig.core.os.completions.push_back(Completion::Created { operation: owner2, result: Ok(created2) });
    rig.core.os.completions.push_back(Completion::Created { operation: owner1, result: Ok(created1) });
    rig.core.tick(1);
    let out = rig.flush();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].get("id").and_then(Value::as_safe_int), Some(second.request_id));
    assert_eq!(out[0].get("value").unwrap().get("resource").and_then(Value::as_str), Some(second.handle.as_str()));
    assert_eq!(out[1].get("id").and_then(Value::as_safe_int), Some(first.request_id));
    assert!(rig.core.child_exited(running_pid, None, Some("SIGTERM")));
    assert_eq!(rig.flush(), vec![exit_event(TREE, None, Some("SIGTERM")), ok_reply(stop_id, state_value("exited"))]);
}

fn error(value: &Value) -> Option<&str> {
    value.get("error").and_then(Value::as_str)
}

#[test]
fn an_out_of_subtree_cgroup_create_through_handle_frame_is_a_violation() {
    let mut rig = Rig::new();
    rig.core.cgroup_subtree = Some("/sys/fs/cgroup/robo-work".into());
    let frame = format!(r#"{{"op":"create","resource":"20000000000000000000000000000000","kind":"cgroup","marker":null,"locator":{{"path":"/sys/fs/cgroup/other/x-22222222222222222222222222222222","keeper":"{KEEPER}"}},"spec":{{}}}}"#);
    assert_eq!(rig.send(&frame), Handled::Exit { code: 65, reason: "bad_frame" });
    assert!(rig.core.os.creates.is_empty());
}

#[test]
fn cgroup_decode_checks_structure_before_undelegated_refusal() {
    let frame = |path: &str| format!(r#"{{"op":"create","resource":"20000000000000000000000000000000","kind":"cgroup","marker":null,"locator":{{"path":"{path}","keeper":"{KEEPER}"}},"spec":{{}}}}"#);
    let subtree = "/sys/fs/cgroup/robo-work";
    let suffix = "22222222222222222222222222222222";
    for parent in ["/sys/fs/cgroup/other", "/sys/fs/cgroup/robo-workx", "/sys/fs/cgroup/robo-wor", "/sys/fs/cgroup/robo-work/child", "/sys/fs/cgroup"] {
        let mut rig = Rig::new();
        rig.core.cgroup_subtree = Some(subtree.into());
        assert_eq!(rig.send(&frame(&format!("{parent}/x-{suffix}"))), Handled::Exit { code: 65, reason: "bad_frame" }, "{parent}");
    }
    for parent in [subtree, "/sys/fs/cgroup/other"] {
        let mut rig = Rig::new();
        assert_eq!(rig.send(&frame(&format!("{parent}/x-{suffix}"))), Handled::Continue);
        assert_eq!(error(&rig.last()), Some("cgroup_not_delegated"));
        assert!(rig.core.os.creates.is_empty());
    }
    for path in [format!("{subtree}/../x-{suffix}"), format!("{subtree}/./x-{suffix}"), format!("{subtree}//x-{suffix}"),
        format!("{subtree}/x-{}", "a".repeat(31)), format!("{subtree}/x-{}", "a".repeat(33)), format!("{subtree}/x-{}", "A".repeat(32))] {
        for delegated in [false, true] {
            let mut rig = Rig::new();
            rig.core.cgroup_subtree = delegated.then(|| subtree.into());
            assert_eq!(rig.send(&frame(&path)), Handled::Exit { code: 65, reason: "bad_frame" }, "{path}");
        }
    }
    // 989-byte parent yields an exactly 1024-byte locator; 990 yields a structural violation.
    for size in [989, 990] {
        let parent = format!("/{}", "a".repeat(size - 1));
        let mut rig = Rig::new();
        rig.core.cgroup_subtree = Some(parent.clone());
        let got = rig.send(&frame(&format!("{parent}/x-{suffix}")));
        assert_eq!(got, if size == 989 { Handled::Continue } else { Handled::Exit { code: 65, reason: "bad_frame" } });
    }
}

#[test]
fn every_locator_is_bound_to_the_keepers_own_reservation() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../proto/tests/vectors/keeper-wire.v1.json")).unwrap();
    let data = parse(&bytes).unwrap();
    let Some(Value::Array(cases)) = data.get("requests") else { panic!() };
    for kind in ["runtime-dir", "cgroup", "netns", "pty", "endpoint", "process-tree"] {
        let frame = cases.iter().filter(|case| case.get("keeperVerdict").and_then(Value::as_str) == Some("ok"))
            .find_map(|case| case.get("frame").filter(|frame| frame.get("kind").and_then(Value::as_str) == Some(kind))).unwrap();
        for keeper in [KEEPER, MARKER] {
            let encoded = json::stringify(frame).replace(&format!(r#""keeper":"{KEEPER}""#), &format!(r#""keeper":"{keeper}""#));
            let frame = parse(encoded.as_bytes()).unwrap();
            let mut rig = Rig::new();
            rig.core.cgroup_subtree = Some("/sys/fs/cgroup/robo-work".into());
            rig.core.runtime_root = data.get("requestContext").unwrap().get("runtimeRoot").and_then(Value::as_str).unwrap().into();
            rig.core.orchestration_root = data.get("requestContext").unwrap().get("orchestrationRoot").and_then(Value::as_str).map(str::to_string);
            rig.core.admission = Admission::default();
            let got = rig.core.handle_frame(&frame, 0);
            if keeper == KEEPER {
                assert_eq!(got, Handled::Continue, "{kind}: matching reservation is structurally valid");
            } else {
                assert_eq!(got, Handled::Exit { code: 65, reason: "bad_frame" }, "{kind}: another keeper");
                assert!(rig.core.os.creates.is_empty(), "{kind}: refused before OS dispatch");
            }
        }
    }
}

#[test]
fn stop_on_a_created_or_aborted_stage_is_refused_resource_not_committed() {
    for aborted in [false, true] {
        let mut rig = Rig::new();
        let pid = rig.tree_pid();
        if aborted {
            rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#));
            rig.flush();
            assert!(!rig.core.child_exited(pid, None, Some("SIGKILL")), "aborted tombstone stays aborted");
        }
        let before = rig.core.resources[rig.core.find(TREE).unwrap()].state;
        for _ in 0..2 {
            assert_eq!(rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":0}}"#)), Handled::Continue);
            let out = rig.flush();
            assert_eq!(out.len(), 1, "no exit event follows a refused stop");
            assert_eq!(error(&out[0]), Some("resource_not_committed"));
            assert!(rig.core.os.stops.is_empty());
            assert_eq!(rig.core.resources[rig.core.find(TREE).unwrap()].state, before);
        }
    }
    let mut rig = Rig::new();
    let pid = rig.tree_pid();
    assert!(rig.core.child_exited(pid, Some(125), None));
    assert!(rig.take().is_empty(), "no event for an uncommitted stage exiting at its gate");
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":0}}"#));
    assert_eq!(rig.last().get("value").unwrap().get("state").and_then(Value::as_str), Some("exited"));
    assert!(rig.core.os.stops.is_empty());
}

#[test]
fn leases_bypass_mount_slots_but_remain_per_grant_and_channel_bounded() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.send(&mount_frame("app", 8));
    rig.flush();
    for _ in 0..4 {
        assert_eq!(rig.send(&format!(r#"{{"op":"unmount_view","resource":"m{:032x}"}}"#, 99)), Handled::Continue);
    }
    let lease = r#"{"op":"view_root_lease","grantId":"app","epoch":2,"verdict":"renew","ttlMs":3000}"#;
    assert_eq!(rig.send(lease), Handled::Continue, "renewal while four mount replies are unflushed");
    assert_eq!(rig.core.outbound.last().unwrap().get("ok"), Some(&Value::Bool(true)));
    assert_eq!(rig.send(lease), Handled::Exit { code: 65, reason: "lease_in_flight_overflow" });
    let lease_id = rig.next_id - 1;
    rig.core.reply_flushed(lease_id);
    assert_eq!(rig.send(lease), Handled::Continue, "settle frees this grant");
    assert_eq!(rig.send(&mount_frame("lib", 9)), Handled::Exit { code: 65, reason: "mount_in_flight_overflow" });
    let mut rig = Rig::new();
    let orphan = r#"{"op":"view_root_lease","grantId":"missing","epoch":2,"verdict":"renew","ttlMs":3000}"#;
    for _ in 0..2 {
        assert_eq!(rig.send(orphan), Handled::Continue);
        assert_eq!(error(&rig.last()), Some("wrong_grant"), "refusal settles too");
    }
}

fn input(seq: u64, data: &[u8]) -> String {
    format!(r#"{{"op":"pty_input","resource":"{PTY}","seq":"{seq}","data":"{}"}}"#, keeper_frames::base64_encode(data))
}

#[test]
fn keeper_gate_is_the_first_frame() {
    let mut core = KeeperCore::new(FakeOs::default(), Scope::Execution, ROOT, KEEPER, 1, KeeperLimits::default(), ViewLimits::default());
    let ping = parse(br#"{"id":1,"op":"ping"}"#).unwrap();
    assert_eq!(core.handle_frame(&ping, 0), Handled::Exit { code: 65, reason: "not_commit_keeper" });
    let mut rig = Rig::new();
    assert_eq!(rig.last_reply_for_ping(), r#"{"id":2,"ok":true,"value":{}}"#);
    assert_eq!(rig.send(r#"{"op":"commit_keeper"}"#), Handled::Exit { code: 65, reason: "unexpected_commit_keeper" });
}

impl Rig {
    fn last_reply_for_ping(&mut self) -> String {
        self.send(r#"{"op":"ping"}"#);
        json::stringify(&self.last())
    }
}

#[test]
fn ids_strictly_increase_and_malformed_frames_are_violations() {
    let mut rig = Rig::new();
    let replay = parse(br#"{"id":1,"op":"ping"}"#).unwrap();
    assert_eq!(rig.core.handle_frame(&replay, 0), Handled::Exit { code: 65, reason: "duplicate_id" });
    let mut rig = Rig::new();
    assert_eq!(rig.send(r#"{"op":"ping","extra":true}"#), Handled::Exit { code: 65, reason: "bad_frame" });
    let mut rig = Rig::new();
    assert_eq!(rig.send(r#"{"op":"frobnicate"}"#), Handled::Exit { code: 65, reason: "unknown_op" });
}

#[test]
fn conforming_mix_of_ordinary_requests_and_pty_input_never_overflows() {
    // N-A: 16 ordinary requests in flight plus 8 unreplied pty_input chunks are within the contract.
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_pty();
    rig.core.os.write_capacity = 0; // the terminal is not reading: every chunk stays unreplied
    for seq in 1..=8 {
        assert_eq!(rig.send(&input(seq, &[b'x'; 8192])), Handled::Continue, "chunk {seq}");
    }
    assert!(rig.take().is_empty(), "no chunk is acknowledged before its bytes are written");
    for _ in 0..16 {
        assert_eq!(rig.send(r#"{"op":"ping"}"#), Handled::Continue);
    }
    assert_eq!(rig.core.ordinary_in_flight(), 16);
    // One more ordinary request, or a ninth chunk, is beyond the contract.
    let mut over = Rig::new();
    over.setup_runtime();
    over.setup_pty();
    over.core.os.write_capacity = 0;
    for seq in 1..=8 {
        over.send(&input(seq, b"x"));
    }
    assert_eq!(over.send(&input(9, b"x")), Handled::Exit { code: 65, reason: "pty_input_window" });
    assert_eq!(rig.send(r#"{"op":"ping"}"#), Handled::Exit { code: 65, reason: "in_flight_overflow" });
}

#[test]
fn pty_window_bytes_and_flush_release_the_window() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_pty();
    rig.core.os.write_capacity = 0;
    for seq in 1..=4 {
        assert_eq!(rig.send(&input(seq, &[b'y'; 16384])), Handled::Continue);
    }
    // 65536 bytes outstanding: one more byte is beyond ptyInputWindowBytes.
    let mut copy = Rig::new();
    copy.setup_runtime();
    copy.setup_pty();
    copy.core.os.write_capacity = 0;
    for seq in 1..=4 {
        copy.send(&input(seq, &[b'y'; 16384]));
    }
    assert_eq!(copy.send(&input(5, b"z")), Handled::Exit { code: 65, reason: "pty_input_window" });
    // Once the master accepts the bytes and the acks are flushed, the window is free again.
    rig.core.os.write_capacity = usize::MAX;
    rig.core.pump_pty_input();
    let acks = rig.flush();
    assert_eq!(acks.len(), 4);
    assert_eq!(rig.send(&input(5, b"z")), Handled::Continue);
}

#[test]
fn pty_input_ack_after_write_replay_gap_and_close() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_pty();
    rig.core.os.write_capacity = 2;
    rig.send(&input(1, b"abcd"));
    let acks = rig.flush();
    assert_eq!(json::stringify(&acks[0]), format!(r#"{{"id":{},"ok":true,"value":{{"seq":"1"}}}}"#, rig.next_id), "two partial writes, then the ack");
    assert_eq!(rig.core.os.writes, vec![b"ab".to_vec(), b"cd".to_vec()]);
    rig.send(&input(1, b"abcd"));
    assert_eq!(rig.last().get("value").unwrap().get("seq").unwrap().as_str(), Some("1"));
    assert_eq!(rig.core.os.writes.len(), 2, "a replayed seq writes nothing");
    rig.send(&input(3, b"x"));
    assert_eq!(error(&rig.last()), Some("sequence_gap"));
    rig.core.os.write_capacity = 0;
    rig.send(&input(2, b"xy"));
    assert!(rig.take().is_empty(), "chunk 2 is queued, not written");
    rig.core.pty_closed(PTY);
    let out = rig.flush();
    assert_eq!(error(&out[0]), Some("pty_closed"));
    assert_eq!(out[0].get("kind").and_then(Value::as_str), Some("refused"), "no byte written");
    assert_eq!(out[1].get("event").and_then(Value::as_str), Some("pty_closed"));
    rig.send(&input(3, b"x"));
    assert_eq!(error(&rig.last()), Some("pty_closed"));
}

#[test]
fn a_replay_of_a_queued_seq_is_answered_when_the_original_write_completes() {
    // RK-2 (decided): no new refusal code; the replay gets the normal {seq} answer once the original chunk is written,
    // and the bytes are written once.
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_pty();
    rig.core.os.write_capacity = 0;
    rig.send(&input(1, b"abc"));
    let original = rig.next_id;
    rig.send(&input(1, b"abc"));
    let replay = rig.next_id;
    assert!(rig.take().is_empty(), "neither is acknowledged before the bytes reach the master");
    rig.core.os.write_capacity = usize::MAX;
    rig.core.pump_pty_input();
    let acks = rig.flush();
    let ids: Vec<i64> = acks.iter().map(|ack| ack.get("id").and_then(Value::as_safe_int).unwrap()).collect();
    assert_eq!(ids, vec![original, replay]);
    assert!(acks.iter().all(|ack| ack.get("value").unwrap().get("seq").and_then(Value::as_str) == Some("1")));
    assert_eq!(rig.core.os.writes, vec![b"abc".to_vec()], "written once");
}

#[test]
fn pty_output_is_bounded_by_credit_and_sequenced() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_pty();
    assert_eq!(rig.core.pty_read_budget(PTY), 0, "output starts with no credit");
    assert!(rig.core.pty_output(PTY, b"x").is_err());
    rig.send(&format!(r#"{{"op":"pty_credit","resource":"{PTY}","bytes":5}}"#));
    rig.flush();
    assert_eq!(rig.core.pty_read_budget(PTY), 5);
    rig.core.pty_output(PTY, b"hel").unwrap();
    rig.core.pty_output(PTY, b"lo").unwrap();
    assert!(rig.core.pty_output(PTY, b"!").is_err());
    let events = rig.take();
    assert_eq!(events[0].get("seq").and_then(Value::as_str), Some("1"));
    assert_eq!(events[1].get("seq").and_then(Value::as_str), Some("2"));
    assert_eq!(events[1].get("data").and_then(Value::as_str), Some("bG8="));
    // All credit is consumed: the maximum may be granted again, but not one byte beyond it.
    rig.send(&format!(r#"{{"op":"pty_credit","resource":"{PTY}","bytes":262144}}"#));
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}");
    rig.send(&format!(r#"{{"op":"pty_credit","resource":"{PTY}","bytes":1}}"#));
    assert_eq!(error(&rig.last()), Some("credit_overflow"));
}

#[test]
fn create_ordering_and_refusals() {
    let mut rig = Rig::new();
    rig.send(&format!(r#"{{"op":"create","resource":"{NETNS}","kind":"netns","marker":null,"locator":{{"netns":"33333333333333333333333333333333","keeper":"{KEEPER}"}},"spec":{{}}}}"#));
    assert_eq!(error(&rig.last()), Some("runtime_dir_missing"));
    rig.send(&format!(r#"{{"op":"create","resource":"{NETNS}","kind":"veth","marker":null,"locator":{{"netns":"33333333333333333333333333333333","keeper":"{KEEPER}"}},"spec":{{}}}}"#));
    assert_eq!(error(&rig.last()), Some("kind_not_supported"));
    assert_eq!(
        rig.send(&format!(r#"{{"op":"create","resource":"{RUNTIME_HANDLE}","kind":"runtime-dir","marker":null,"locator":{{"path":"/elsewhere/x/{RUNTIME_ID}","keeper":"{KEEPER}"}},"spec":{{}}}}"#)),
        Handled::Exit { code: 65, reason: "bad_frame" }
    );
    let mut rig = Rig::new();
    rig.setup_runtime();
    assert_eq!(error(&rig.create_tree()), Some("resource_not_committed"), "the workload's netns is not committed");
    rig.setup_netns();
    let created = rig.create_tree();
    assert_eq!(created.get("value").unwrap().sorted_keys().as_deref(), Some("identity,resource"));
    assert_eq!(created.get("value").unwrap().get("identity").unwrap().sorted_keys().as_deref(), Some("pid,pidNs,startTime"));
    assert_eq!(error(&rig.create_tree()), Some("duplicate_resource"));
    rig.send(r#"{"op":"end_process_trees"}"#);
    rig.flush();
    rig.core.cgroup_subtree = Some("/sys/fs/cgroup/rw".into());
    rig.send(&format!(r#"{{"op":"create","resource":"20000000000000000000000000000000","kind":"cgroup","marker":null,"locator":{{"path":"/sys/fs/cgroup/rw/x-22222222222222222222222222222222","keeper":"{KEEPER}"}},"spec":{{}}}}"#));
    assert_eq!(error(&rig.last()), Some("execution_ending"));
}

#[test]
fn commit_exit_and_stop_ordering() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_netns();
    let created = rig.create_tree();
    let pid = created.get("value").unwrap().get("identity").unwrap().get("pid").and_then(Value::as_safe_int).unwrap();
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    assert_eq!(rig.last().get("value").unwrap().get("state").and_then(Value::as_str), Some("executed"));
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    assert_eq!(error(&rig.last()), Some("already_committed"));
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":100}}"#));
    assert!(rig.take().is_empty(), "the stop reply waits for the exit");
    assert_eq!(rig.core.os.stops, vec![(TREE.to_string(), 100)]);
    assert!(rig.core.child_exited(pid, None, Some("SIGTERM")));
    let out = rig.flush();
    assert_eq!(out[0].get("event").and_then(Value::as_str), Some("exit"), "the exit event precedes the stop reply");
    assert_eq!(out[1].get("value").unwrap().get("state").and_then(Value::as_str), Some("exited"));
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":0}}"#));
    assert_eq!(rig.last().get("value").unwrap().get("state").and_then(Value::as_str), Some("exited"), "an exited process answers at once");
}

#[test]
fn a_stage_that_dies_at_its_gate_emits_no_exit_and_refuses_commit() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_netns();
    let created = rig.create_tree();
    let pid = created.get("value").unwrap().get("identity").unwrap().get("pid").and_then(Value::as_safe_int).unwrap();
    rig.core.child_exited(pid, Some(125), None);
    assert!(rig.take().is_empty(), "no exit event before commit");
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
    assert_eq!(error(&rig.last()), Some("gate_closed"));
}

#[test]
fn abort_uncommitted_rules() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_netns();
    rig.create_tree();
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{NETNS}","{TREE}"]}}"#));
    assert_eq!(error(&rig.last()), Some("already_committed"), "nothing is aborted when any listed handle is committed");
    assert!(rig.core.os.aborts.is_empty());
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}","ffffffffffffffffffffffffffffffff"]}}"#));
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}");
    assert_eq!(rig.core.os.aborts, vec![TREE.to_string()], "unknown handles are ignored");
}

#[test]
fn a_stage_that_exited_at_its_gate_is_still_uncommitted_for_abort() {
    // Review F-2(b).
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.setup_netns();
    let created = rig.create_tree();
    let pid = created.get("value").unwrap().get("identity").unwrap().get("pid").and_then(Value::as_safe_int).unwrap();
    rig.core.child_exited(pid, Some(125), None);
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#));
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}", "not already_committed");
    assert_eq!(rig.core.os.aborts, vec![TREE.to_string()], "its custody is released");
}

#[test]
fn an_aborted_runtime_dir_can_be_created_again_but_a_held_one_cannot() {
    // Review F-2(a): a second runtime-dir create while one is held is refused, never orphaning the first.
    let mut rig = Rig::new();
    let create = format!(r#"{{"op":"create","resource":"{RUNTIME_HANDLE}","kind":"runtime-dir","marker":null,"locator":{{"path":"{ROOT}/x/{RUNTIME_ID}","keeper":"{KEEPER}"}},"spec":{{}}}}"#);
    rig.send(&create);
    rig.flush();
    let second = create.replace(RUNTIME_HANDLE, "10000000000000000000000000000009").replace(RUNTIME_ID, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    rig.send(&second);
    assert_eq!(error(&rig.last()), Some("duplicate_role"));
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{RUNTIME_HANDLE}"]}}"#));
    rig.flush();
    assert_eq!(rig.core.os.aborts, vec![RUNTIME_HANDLE.to_string()], "the OS removes the uncommitted directory");
    rig.send(&second);
    assert!(rig.last().get("value").is_some(), "a new runtime-dir after the abort");
}

#[test]
fn a_failed_detach_still_stops_the_server() {
    // Review RK-5.
    let mut rig = Rig::new();
    rig.setup_runtime();
    let mountpoint = format!("{ROOT}/x/{RUNTIME_ID}/views/app");
    rig.send(&format!(
        r#"{{"op":"mount_view","grantId":"app","rootSlot":8,"expectedRootIdentity":{{"dev":"2049","ino":"77"}},"access":"write","mountpoint":"{mountpoint}","propagation":"private","allowOther":true,"descriptorCap":1024,"rlimitNofile":1100,"rootLease":{{"epoch":1,"ttlMs":3000}}}}"#
    ));
    rig.flush();
    rig.core.os.fail_detach = true;
    rig.send(r#"{"op":"release_views"}"#);
    rig.flush();
    assert_eq!(rig.core.os.signals, vec![(4242, Signal::Term)], "SIGTERM despite the failed detach");
}

#[test]
fn tempdir_inventory_end_steps_and_exit() {
    let mut rig = Rig::new();
    rig.send(r#"{"op":"tempdir"}"#);
    assert_eq!(error(&rig.last()), Some("runtime_dir_missing"));
    rig.setup_runtime();
    rig.send(r#"{"op":"tempdir"}"#);
    assert_eq!(rig.last().get("value").unwrap().get("path").and_then(Value::as_str), Some("/tmp/ala-0123456789abcdef"));
    rig.send(r#"{"op":"inventory"}"#);
    let inventory = rig.last();
    assert_eq!(inventory.get("value").unwrap().sorted_keys().as_deref(), Some("descriptors,resources"));
    for op in ["end_process_trees", "end_process_trees", "end_endpoint", "release_egress", "release_views"] {
        rig.send(&format!(r#"{{"op":"{op}"}}"#));
        assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}", "{op} (idempotent)");
    }
    assert_eq!(rig.core.exit_after_flush(), None);
    rig.send(r#"{"op":"remove_runtime"}"#);
    rig.flush();
    assert_eq!(rig.core.exit_after_flush(), Some(0));
}

#[test]
fn mount_view_uses_runtime_locator_and_keeper_handle() {
    let mut rig = Rig::new();
    let mountpoint = format!("{ROOT}/x/{RUNTIME_ID}/views/app");
    let mount = format!(
        r#"{{"op":"mount_view","grantId":"app","rootSlot":8,"expectedRootIdentity":{{"dev":"2049","ino":"77"}},"access":"write","mountpoint":"{mountpoint}","propagation":"private","allowOther":true,"descriptorCap":1024,"rlimitNofile":1100,"rootLease":{{"epoch":1,"ttlMs":3000}}}}"#
    );
    rig.send(&mount);
    assert_eq!(error(&rig.last()), Some("runtime_dir_missing"));
    rig.setup_runtime();
    let id = rig.next_id + 1;
    rig.send(&mount);
    let reply = rig.last();
    assert_eq!(validate_mount_reply(&reply, id, &mountpoint), Ok(()), "the m-handle also matches the frozen RESOURCE_ID [a-z0-9]{{8,64}}");
    let handle = reply.get("value").unwrap().get("resource").and_then(Value::as_str).unwrap().to_string();
    assert!(keeper_frames::is_mount_handle(&handle));
    rig.send(&format!(r#"{{"op":"commit","resource":"{handle}"}}"#));
    assert_eq!(rig.last().get("value").unwrap().get("state").and_then(Value::as_str), Some("committed"));
    let id = rig.next_id + 1;
    rig.send(r#"{"op":"view_root_lease","grantId":"app","epoch":2,"verdict":"revoke","reason":"root_unbound"}"#);
    let lease = rig.last();
    assert_eq!(validate_root_lease_reply(&lease, id), Ok(()));
    assert_eq!(rig.core.os.signals, vec![(4242, Signal::Term)]);
    rig.send(&format!(r#"{{"op":"unmount_view","resource":"{handle}"}}"#));
    assert_eq!(json::stringify(&rig.last()), format!(r#"{{"id":{},"ok":true,"value":{{}}}}"#, rig.next_id));
    rig.send(&mount);
    assert_eq!(error(&rig.last()), Some("duplicate_grant_id"), "S5 r7 snake_case, emitted directly by MountSet");
}

#[test]
fn mount_stage_two_bad_frame_is_a_violation_and_other_codes_refuse() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    let wrong = format!(
        r#"{{"op":"mount_view","grantId":"app","rootSlot":9,"expectedRootIdentity":{{"dev":"2049","ino":"77"}},"access":"write","mountpoint":"{ROOT}/x/{RUNTIME_ID}/views/app","propagation":"private","allowOther":true,"descriptorCap":1024,"rlimitNofile":1100,"rootLease":{{"epoch":1,"ttlMs":3000}}}}"#
    );
    rig.send(&wrong);
    assert_eq!(error(&rig.last()), Some("root_slot_out_of_range"));
    let bad_op = r#"{"op":"view_root_lease","grantId":"app","epoch":1,"verdict":"renew","ttlMs":3000}"#;
    assert_eq!(rig.send(bad_op), Handled::Exit { code: 65, reason: "bad_frame" }, "frozen bad_frame (epoch 1) is a violation");
}

#[test]
fn shutdown_runs_every_end_step_and_requests_exit() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.send(r#"{"op":"shutdown"}"#);
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}");
    assert_eq!(rig.core.os.steps, vec![EndStep::ProcessTrees, EndStep::Endpoint, EndStep::Egress, EndStep::Views, EndStep::Runtime]);
    assert_eq!(rig.core.exit_after_flush(), Some(0));
}

impl Rig {
    /// A committed runtime dir and netns, a created workload tree, and its pid.
    fn tree_pid(&mut self) -> i64 {
        self.setup_runtime();
        self.setup_netns();
        let created = self.create_tree();
        created.get("value").unwrap().get("identity").unwrap().get("pid").and_then(Value::as_safe_int).unwrap()
    }

    fn commit_tree(&mut self) -> Vec<Value> {
        self.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        self.flush()
    }
}

fn event(value: &Value) -> Option<&str> {
    value.get("event").and_then(Value::as_str)
}

#[test]
fn exactly_one_exit_follows_an_ok_commit_and_a_later_commit_is_already_committed() {
    let mut rig = Rig::new();
    let pid = rig.tree_pid();
    assert_eq!(rig.commit_tree()[0].get("value").unwrap().get("state").and_then(Value::as_str), Some("executed"));
    assert!(rig.core.child_exited(pid, Some(0), None));
    let out = rig.flush();
    assert_eq!(out.iter().filter(|frame| event(frame) == Some("exit")).count(), 1);
    assert!(!rig.core.child_exited(pid, Some(0), None), "a reaped init is not tracked twice");
    assert!(rig.take().is_empty(), "no second exit");
    // Review r6 (advisor): ok, then exit, then commit is `already_committed`, not `gate_closed`.
    assert_eq!(error(&rig.commit_tree()[0]), Some("already_committed"));
}

#[test]
fn a_failure_commit_kills_only_that_stage_by_handle_and_its_exit_follows_the_reply() {
    // Contract §4 `commit` (line 290): failure `exec_failed`, `stream_connect_failed` (an `exit` event follows). E-4.
    for code in ["exec_failed", "stream_connect_failed"] {
        let mut rig = Rig::new();
        let pid = rig.tree_pid();
        rig.core.os.fail_commit = Some((ErrorKind::Failure, code));
        let out = rig.commit_tree();
        assert_eq!(out.len(), 1, "{code}: the reply alone, the exit comes once the stage is reaped");
        assert_eq!(out[0].get("kind").and_then(Value::as_str), Some("failure"), "{code}");
        assert_eq!(error(&out[0]), Some(code));
        // Step 2: the stage is killed through its own handle (pidfd), never by a raw pid, and nothing else is signalled.
        assert_eq!(rig.core.os.killed_stages, vec![TREE.to_string()], "{code}");
        assert!(rig.core.os.signals.is_empty(), "{code}: no pid-addressed signal");
        assert!(rig.core.os.stops.is_empty() && rig.core.os.aborts.is_empty(), "{code}");
        // E-1: a second commit is refused and changes nothing (no second OS commit, no second kill).
        assert_eq!(error(&rig.commit_tree()[0]), Some("already_committed"), "{code}");
        assert_eq!(rig.core.os.commits.iter().filter(|handle| handle.as_str() == TREE).count(), 1, "{code}");
        assert_eq!(rig.core.os.killed_stages.len(), 1, "{code}");
        // E-2: the supervisor has committed it, so abort_uncommitted refuses and aborts nothing.
        rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE}"]}}"#));
        assert_eq!(error(&rig.last()), Some("already_committed"), "{code}");
        assert!(rig.core.os.aborts.is_empty(), "{code}");
        rig.send(r#"{"op":"inventory"}"#);
        let inventory = json::stringify(&rig.last());
        assert!(inventory.contains(r#""state":"commit_failed""#), "{code}: {inventory}");
        // Exactly one exit once reaped, and a later commit is still `already_committed` (not `gate_closed`).
        assert!(rig.core.child_exited(pid, None, Some("SIGKILL")));
        let out = rig.flush();
        assert_eq!(out.len(), 1, "{code}");
        assert_eq!(event(&out[0]), Some("exit"), "{code}");
        assert_eq!(out[0].get("resource").and_then(Value::as_str), Some(TREE), "{code}");
        assert!(!rig.core.child_exited(pid, None, Some("SIGKILL")));
        assert!(rig.take().is_empty(), "{code}: no second exit");
        assert_eq!(error(&rig.commit_tree()[0]), Some("already_committed"), "{code}");
    }
}

#[test]
fn a_commit_reply_and_its_exit_can_be_coalesced_in_order() {
    // R2.6 A1: one write carrying the commit reply and the exit, for `ok` and both failed-start codes.
    for outcome in [None, Some("exec_failed"), Some("stream_connect_failed")] {
        let mut rig = Rig::new();
        let pid = rig.tree_pid();
        rig.core.os.fail_commit = outcome.map(|code| (ErrorKind::Failure, code));
        rig.send(&format!(r#"{{"op":"commit","resource":"{TREE}"}}"#));
        // Reaped before the run loop flushed: both frames go out together, the reply first.
        assert!(rig.core.child_exited(pid, Some(127), None));
        let out = rig.flush();
        assert_eq!(out.len(), 2, "{outcome:?}");
        match outcome {
            None => assert_eq!(out[0].get("value").unwrap().get("state").and_then(Value::as_str), Some("executed")),
            Some(code) => assert_eq!(error(&out[0]), Some(code)),
        }
        assert_eq!(event(&out[1]), Some("exit"), "{outcome:?}");
        assert!(!rig.core.child_exited(pid, Some(127), None));
        assert!(rig.take().is_empty(), "{outcome:?}: no duplicate exit");
    }
}

/// A second workload tree, created and committed (`executed`): the bystander for "only the held stage".
const TREE2: &str = "000102030405060708090a0b0c0d0e1f";
const MARKER2: &str = "AAECAwQFBgcICQoLDA0OHw";

impl Rig {
    fn create_second_tree(&mut self) -> Value {
        self.send(&format!(
            r#"{{"op":"create","resource":"{TREE2}","kind":"process-tree","marker":"{MARKER2}","locator":{{"role":"process-tree","id":"77777777777777777777777777777777","keeper":"{KEEPER}","marker":"{MARKER2}"}},"spec":{{"role":"workload","process":2,"request":{START_REQUEST},"streams":{{"stdout":"/s/2"}},"netns":"{NETNS}"}}}}"#
        ));
        self.last()
    }
}

#[test]
fn stream_connect_failed_affects_only_the_held_stage_and_a_mixed_abort_list_is_refused() {
    // R2.6 A1: the failed stage alone is killed (by its handle); a mixed abort list naming it changes nothing.
    let mut rig = Rig::new();
    rig.tree_pid();
    let created = rig.create_second_tree();
    assert!(created.get("ok") == Some(&Value::Bool(true)), "{}", json::stringify(&created));
    rig.core.os.fail_commit = Some((ErrorKind::Failure, "stream_connect_failed"));
    assert_eq!(error(&rig.commit_tree()[0]), Some("stream_connect_failed"));
    assert_eq!(rig.core.os.killed_stages, vec![TREE.to_string()], "only the held stage");
    assert!(rig.core.os.signals.is_empty() && rig.core.os.stops.is_empty() && rig.core.os.aborts.is_empty());
    // TREE2 is still uncommitted; a list naming both refuses as a whole and aborts nothing.
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{TREE2}","{TREE}"]}}"#));
    assert_eq!(error(&rig.last()), Some("already_committed"));
    assert!(rig.core.os.aborts.is_empty(), "the uncommitted bystander is not aborted either");
    // The bystander still commits normally.
    rig.core.os.fail_commit = None;
    rig.send(&format!(r#"{{"op":"commit","resource":"{TREE2}"}}"#));
    assert_eq!(rig.last().get("value").unwrap().get("state").and_then(Value::as_str), Some("executed"));
    assert_eq!(rig.core.os.killed_stages, vec![TREE.to_string()]);
}

#[test]
fn no_exit_after_a_refused_commit_or_before_any_reply() {
    let mut rig = Rig::new();
    let pid = rig.tree_pid();
    assert!(rig.core.child_exited(pid, Some(125), None));
    assert!(rig.take().is_empty(), "before any commit reply: no exit");
    assert_eq!(error(&rig.commit_tree()[0]), Some("gate_closed"));
    assert!(rig.take().is_empty(), "after refused: no exit");
    assert!(rig.core.os.killed_stages.is_empty(), "a refused commit kills nothing");
}

#[test]
fn a_stop_on_a_failed_commit_stage_is_answered_exited_when_its_exit_comes_within_the_bound() {
    // E-3: a stop row outcome (`{state: 'exited'}` after the exit event), once, and nothing more at the bound.
    let mut rig = Rig::new();
    let pid = rig.tree_pid();
    rig.core.os.fail_commit = Some((ErrorKind::Failure, "stream_connect_failed"));
    rig.commit_tree();
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":100}}"#));
    assert!(rig.take().is_empty(), "the stop waits for the exit");
    let bound = 100 + (KeeperLimits::default().stop_extra_ms as u64) / 2;
    assert_eq!(rig.core.next_deadline(), Some(bound), "the run loop wakes for the bound");
    assert!(bound < 100 + KeeperLimits::default().stop_extra_ms as u64, "the keeper budget from receipt is smaller than the client's graceMs + stopExtraMs (R2.6: not a delivery guarantee)");
    assert!(rig.core.child_exited(pid, None, Some("SIGKILL")));
    let out = rig.flush();
    assert_eq!(out.len(), 2);
    assert_eq!(event(&out[0]), Some("exit"), "the exit precedes the stop reply");
    assert_eq!(out[1].get("value").unwrap().get("state").and_then(Value::as_str), Some("exited"));
    assert_eq!(rig.core.next_deadline(), None);
    rig.core.tick(bound + 1);
    assert!(rig.take().is_empty(), "no second reply at the bound");
}

#[test]
fn a_stop_on_a_failed_commit_stage_is_answered_at_its_bound_if_the_exit_never_comes() {
    // E-3, contract R2.2: the pending stop is never left unanswered.
    let mut rig = Rig::new();
    let pid = rig.tree_pid();
    rig.core.os.fail_commit = Some((ErrorKind::Failure, "exec_failed"));
    rig.commit_tree();
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":0}}"#));
    let id = rig.next_id;
    let bound = (KeeperLimits::default().stop_extra_ms as u64) / 2;
    rig.core.tick(bound - 1);
    assert!(rig.take().is_empty(), "no premature success, nothing before the bound");
    // R2.6 A2: the keeper keeps answering while the stop waits.
    rig.send(r#"{"op":"ping"}"#);
    let pong = rig.flush();
    assert_eq!(pong.len(), 1);
    assert_eq!(json::stringify(&pong[0]), format!(r#"{{"id":{},"ok":true,"value":{{}}}}"#, rig.next_id));
    rig.core.tick(bound);
    let out = rig.flush();
    assert_eq!(out.len(), 1, "exactly one stop_timeout");
    assert_eq!(json::stringify(&out[0]), format!(r#"{{"id":{id},"ok":false,"kind":"failure","error":"stop_timeout"}}"#));
    assert_eq!(rig.core.next_deadline(), None);
    rig.core.tick(bound + 10_000);
    assert!(rig.take().is_empty(), "no second stop_timeout");
    // The exit is still owed and still emitted once; the answered stop gets no second reply.
    assert!(rig.core.child_exited(pid, None, Some("SIGKILL")));
    let out = rig.flush();
    assert_eq!(out.len(), 1);
    assert_eq!(event(&out[0]), Some("exit"));
}

#[test]
fn a_stop_on_an_executed_process_is_answered_stop_timeout_at_the_same_bound() {
    // Contract R2.2 applies to executed processes too: same helper, same bound, the exit still follows, no second reply.
    let mut rig = Rig::new();
    let pid = rig.tree_pid();
    rig.commit_tree();
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":200}}"#));
    let id = rig.next_id;
    assert_eq!(rig.core.os.stops, vec![(TREE.to_string(), 200)], "an executed process is signalled");
    let bound = 200 + (KeeperLimits::default().stop_extra_ms as u64) / 2;
    assert_eq!(rig.core.next_deadline(), Some(bound));
    rig.core.tick(bound - 1);
    assert!(rig.take().is_empty(), "no premature success, nothing before the bound");
    // R2.6 A2: the keeper keeps answering while the stop waits.
    rig.send(r#"{"op":"ping"}"#);
    let pong = rig.flush();
    assert_eq!(pong.len(), 1);
    assert_eq!(json::stringify(&pong[0]), format!(r#"{{"id":{},"ok":true,"value":{{}}}}"#, rig.next_id));
    rig.core.tick(bound);
    let out = rig.flush();
    assert_eq!(json::stringify(&out[0]), format!(r#"{{"id":{id},"ok":false,"kind":"failure","error":"stop_timeout"}}"#));
    assert_eq!(out.len(), 1, "exactly one stop_timeout");
    rig.core.tick(bound + 10_000);
    assert!(rig.take().is_empty(), "no second stop_timeout");
    assert!(rig.core.child_exited(pid, None, Some("SIGKILL")));
    let out = rig.flush();
    assert_eq!(out.len(), 1, "the exit, and no second stop reply");
    assert_eq!(event(&out[0]), Some("exit"));
    // A stop after the exit answers at once.
    rig.send(&format!(r#"{{"op":"stop","resource":"{TREE}","graceMs":0}}"#));
    assert_eq!(rig.last().get("value").unwrap().get("state").and_then(Value::as_str), Some("exited"));
}

fn mount_frame(grant: &str, slot: i64) -> String {
    format!(
        r#"{{"op":"mount_view","grantId":"{grant}","rootSlot":{slot},"expectedRootIdentity":{{"dev":"2049","ino":"77"}},"access":"write","mountpoint":"{ROOT}/x/{RUNTIME_ID}/views/{grant}","propagation":"private","allowOther":true,"descriptorCap":1024,"rlimitNofile":1100,"rootLease":{{"epoch":1,"ttlMs":3000}}}}"#
    )
}

#[test]
fn abort_uncommitted_tears_down_an_uncommitted_view_and_refuses_a_committed_one() {
    // Review F-5 (frozen fakeKeeperProcess `abort_uncommitted`: removeMount for an `m…` entry).
    let mut rig = Rig { core: KeeperCore::new(FakeOs { write_capacity: usize::MAX, ..FakeOs::default() }, Scope::Execution, ROOT, KEEPER, 2, KeeperLimits::default(), ViewLimits::default()), next_id: 0 };
    rig.send(r#"{"op":"commit_keeper"}"#);
    rig.flush();
    rig.setup_runtime();
    rig.send(&mount_frame("app", 8));
    let unverified = rig.last().get("value").unwrap().get("resource").and_then(Value::as_str).unwrap().to_string();
    rig.send(&mount_frame("lib", 9));
    let committed = rig.last().get("value").unwrap().get("resource").and_then(Value::as_str).unwrap().to_string();
    rig.send(&format!(r#"{{"op":"commit","resource":"{committed}"}}"#));
    rig.flush();
    // A committed view in the list refuses the whole frame and changes nothing.
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{unverified}","{committed}"]}}"#));
    assert_eq!(error(&rig.last()), Some("already_committed"));
    assert!(rig.core.os.detached.is_empty() && rig.core.os.signals.is_empty());
    // The uncommitted view is detached and its server stopped at once, not left serving until its lease expires.
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{unverified}"]}}"#));
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}");
    assert_eq!(rig.core.os.detached, vec![unverified.clone()]);
    assert_eq!(rig.core.os.signals, vec![(4242, Signal::Term)]);
    let grace = ViewLimits::default().root_revoke_grace_ms as u64;
    rig.core.tick(grace);
    assert_eq!(rig.core.os.signals, vec![(4242, Signal::Term), (4242, Signal::Kill)], "KILL after the revoke grace");
    // Its handle is gone for every later op; the committed view is untouched.
    rig.send(&format!(r#"{{"op":"commit","resource":"{unverified}"}}"#));
    assert_eq!(error(&rig.last()), Some("unknown_resource"));
    rig.send(&format!(r#"{{"op":"unmount_view","resource":"{unverified}"}}"#));
    assert_eq!(error(&rig.last()), Some("unknown_resource"));
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{unverified}"]}}"#));
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}", "an aborted handle is now unknown and ignored");
    assert_eq!(rig.core.os.detached, vec![unverified.clone()], "no second teardown");
    rig.send(r#"{"op":"view_root_lease","grantId":"app","epoch":2,"verdict":"renew","ttlMs":3000}"#);
    assert_eq!(error(&rig.last()), Some("wrong_grant"), "the aborted view's lease is not renewable");
}

#[test]
fn a_detach_failure_during_abort_still_stops_the_server_and_answers() {
    let mut rig = Rig::new();
    rig.setup_runtime();
    rig.send(&mount_frame("app", 8));
    let handle = rig.last().get("value").unwrap().get("resource").and_then(Value::as_str).unwrap().to_string();
    rig.core.os.fail_detach = true;
    rig.send(&format!(r#"{{"op":"abort_uncommitted","resources":["{handle}"]}}"#));
    assert_eq!(json::stringify(rig.last().get("value").unwrap()), "{}", "the answer proves nothing (§4)");
    assert_eq!(rig.core.os.signals, vec![(4242, Signal::Term)], "RK-5: the server is stopped even when the detach failed");
}

#[test]
fn mount_ops_beyond_max_mount_in_flight_are_a_violation() {
    // R3 L1: only mount_view and unmount_view consume the four mount slots.
    let limit = ViewLimits::default().max_mount_in_flight;
    assert_eq!(limit, 4);
    let frames = [
        mount_frame("app", 8),
        format!(r#"{{"op":"unmount_view","resource":"m{:032x}"}}"#, 2),
        format!(r#"{{"op":"unmount_view","resource":"m{:032x}"}}"#, 1),
        format!(r#"{{"op":"unmount_view","resource":"m{:032x}"}}"#, 3),
    ];
    let mut rig = Rig::new();
    rig.setup_runtime();
    for frame in &frames {
        assert_eq!(rig.send(frame), Handled::Continue, "{frame}");
    }
    // Four unflushed mount replies: ordinary ops still pass (16 overall), a fifth mount op is a violation.
    assert_eq!(rig.send(r#"{"op":"ping"}"#), Handled::Continue);
    assert_eq!(rig.send(&mount_frame("lib", 9)), Handled::Exit { code: 65, reason: "mount_in_flight_overflow" });
    // Once a mount reply is flushed, the next mount op is admitted again.
    let mut rig = Rig::new();
    rig.setup_runtime();
    for frame in &frames {
        rig.send(frame);
    }
    rig.flush();
    for frame in &frames[1..] {
        assert_eq!(rig.send(frame), Handled::Continue);
    }
    assert_eq!(rig.send(&mount_frame("lib", 9)), Handled::Continue, "4 in flight again, not 5");
}

/// Review RK-8: the 70 vector requests through `KeeperCore::handle_frame` itself (the keeper's live decode context:
/// runtime root, orchestration root, mount stage 2 in dispatch), not only through the vector harness's `decode_request`.
#[test]
fn vector_requests_through_handle_frame_match_the_keeper_verdicts() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../proto/tests/vectors/keeper-wire.v1.json")).unwrap();
    let data = parse(&bytes).unwrap();
    let base = data.get("requestContext").unwrap();
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).unwrap().to_string();
    let Some(Value::Array(cases)) = data.get("requests") else { panic!("requests") };
    assert_eq!(cases.len(), 82);
    // Refusal codes produced by request decoding (the vector's `refused` verdicts): an `ok` case must never get one.
    let decode_refusals: Vec<String> =
        cases.iter().filter_map(|case| case.get("keeperVerdict").and_then(|verdict| verdict.get("refused")).and_then(Value::as_str).map(str::to_string)).collect();
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let frame = case.get("frame").unwrap();
        let mount = case.get("context").and_then(|context| context.get("mount")).unwrap_or(base.get("mount").unwrap());
        let scope = if mount.get("scope").and_then(Value::as_str) == Some("gui") { Scope::Gui } else { Scope::Execution };
        let root = text(base, "runtimeRoot");
        let grants = mount.get("grantCount").and_then(Value::as_safe_int).unwrap();
        let subtree = case.get("context").and_then(|context| context.get("cgroupSubtree")).or_else(|| base.get("cgroupSubtree")).and_then(Value::as_str).map(str::to_string);
        let core = KeeperCore::new(FakeOs { write_capacity: usize::MAX, ..FakeOs::default() }, scope, &root, &text(base, "keeperReservation"), grants, KeeperLimits::default(), ViewLimits::default())
            .with_orchestration_root(Some(text(base, "orchestrationRoot")))
            .with_cgroup_subtree(subtree);
        let mut rig = Rig { core, next_id: 0 };
        let is_gate = frame.get("op").and_then(Value::as_str) == Some("commit_keeper");
        if !is_gate {
            // The state the vector context implies: the keeper gate, a committed runtime dir for the reservation, and
            // the prior requests of the mount set.
            rig.send(r#"{"op":"commit_keeper"}"#);
            let path = format!("{root}/x/{}", text(mount, "reservationId"));
            rig.send(&format!(r#"{{"op":"create","resource":"{RUNTIME_HANDLE}","kind":"runtime-dir","marker":null,"locator":{{"path":"{path}","keeper":"{KEEPER}"}},"spec":{{}}}}"#));
            rig.send(&format!(r#"{{"op":"commit","resource":"{RUNTIME_HANDLE}"}}"#));
            if let Some(Value::Array(prior)) = mount.get("prior") {
                for request in prior {
                    let mut body = json::stringify(request);
                    let at = body.find(r#""op""#).unwrap();
                    body = format!("{{{}", &body[at..]);
                    rig.send(&body);
                }
            }
            let setup = rig.flush();
            assert!(setup.iter().all(|reply| reply.get("ok") == Some(&Value::Bool(true))), "{name}: setup {}", setup.iter().map(json::stringify).collect::<Vec<_>>().join(" "));
            // The case keeps its own id: restart id ordering and in-flight accounting (setup replies are flushed).
            rig.core.admission = Admission::new(&ViewLimits::default());
        }
        let handled = rig.core.handle_frame(frame, 0);
        let out = rig.core.take_outbound();
        let refused = out.iter().find(|reply| reply.get("kind").and_then(Value::as_str) == Some("refused")).and_then(error).map(str::to_string);
        let got = match (&handled, &refused) {
            (Handled::Exit { code: 65, reason }, _) => format!(r#"{{"violation":"{reason}"}}"#),
            (_, Some(code)) if decode_refusals.contains(code) => format!(r#"{{"refused":"{code}"}}"#),
            _ => "ok".to_string(),
        };
        let want = match case.get("keeperVerdict").unwrap() {
            Value::String(verdict) => verdict.clone(),
            other => json::stringify(other),
        };
        if got != want {
            failures.push(format!("{name}: got {got}, want {want} (handled {handled:?}, out {})", out.iter().map(json::stringify).collect::<Vec<_>>().join(" ")));
        }
    }
    assert!(failures.is_empty(), "{} verdicts differ through handle_frame:\n{}", failures.len(), failures.join("\n"));
}

impl Rig {
    /// A committed runtime dir and netns, then a workload tree created under `handle`; returns its pid.
    fn tree_pid_as(&mut self, handle: &str) -> i64 {
        self.setup_runtime();
        self.setup_netns();
        self.send(&format!(
            r#"{{"op":"create","resource":"{handle}","kind":"process-tree","marker":"{MARKER}","locator":{{"role":"process-tree","id":"66666666666666666666666666666666","keeper":"{KEEPER}","marker":"{MARKER}"}},"spec":{{"role":"workload","process":1,"request":{START_REQUEST},"streams":{{"stdout":"/s/1"}},"netns":"{NETNS}"}}}}"#
        ));
        let created = self.last();
        created.get("value").unwrap().get("identity").unwrap().get("pid").and_then(Value::as_safe_int).unwrap()
    }
}

/// S4 r9 `commitSequences` and `stopSequences` (R2.1, R2.2) driven through `KeeperCore`: the keeper emits exactly the
/// frames of each sequence up to (not including) the first one the client rejects, and nothing more.
#[test]
fn the_keeper_emits_exactly_the_accepted_commit_and_stop_sequences() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../proto/tests/vectors/keeper-wire.v1.json")).unwrap();
    let data = parse(&bytes).unwrap();
    let list = |value: &Value, key: &str| match value.get(key) {
        Some(Value::Array(items)) => items.clone(),
        other => panic!("{key}: {other:?}"),
    };
    let expected = |case: &Value| {
        let verdicts = list(case, "verdicts");
        let accepted = verdicts.iter().take_while(|verdict| verdict.as_str() == Some("ok")).count();
        list(case, "frames")[..accepted].iter().map(json::stringify).collect::<Vec<_>>()
    };
    let exit_of = |frames: &[Value]| frames.iter().find(|frame| frame.get("event").is_some()).cloned().unwrap();
    let mut checked = 0;
    for case in list(&data, "commitSequences") {
        let name = case.get("name").and_then(Value::as_str).unwrap().to_string();
        let request = case.get("request").unwrap();
        let handle = request.get("resource").and_then(Value::as_str).unwrap();
        let frames = list(&case, "frames");
        let exit = exit_of(&frames);
        let (code, signal) = (exit.get("code").and_then(Value::as_safe_int), exit.get("signal").and_then(Value::as_str));
        let mut rig = Rig::new();
        let pid = rig.tree_pid_as(handle);
        let reply = &frames[0];
        let refused = reply.get("kind").and_then(Value::as_str) == Some("refused");
        if refused {
            // `gate_closed`: the stage died at its gate before the commit.
            assert!(rig.core.child_exited(pid, code, signal));
        } else if reply.get("ok") == Some(&Value::Bool(false)) {
            let code = reply.get("error").and_then(Value::as_str).unwrap();
            rig.core.os.fail_commit = Some((ErrorKind::Failure, if code == "exec_failed" { "exec_failed" } else { "stream_connect_failed" }));
        }
        rig.flush();
        rig.core.admission = Admission::new(&ViewLimits::default());
        assert_eq!(rig.core.handle_frame(request, 0), Handled::Continue, "{name}");
        if !refused {
            assert!(rig.core.child_exited(pid, code, signal), "{name}");
        }
        assert!(!rig.core.child_exited(pid, code, signal), "{name}: an init is reaped once");
        let out: Vec<String> = rig.core.take_outbound().iter().map(json::stringify).collect();
        assert_eq!(out, expected(&case), "{name}");
        checked += 1;
    }
    for case in list(&data, "stopSequences") {
        let name = case.get("name").and_then(Value::as_str).unwrap().to_string();
        let request = case.get("request").unwrap();
        let handle = request.get("resource").and_then(Value::as_str).unwrap();
        let grace = request.get("graceMs").and_then(Value::as_safe_int).unwrap() as u64;
        let frames = list(&case, "frames");
        let exit = exit_of(&frames);
        let (code, signal) = (exit.get("code").and_then(Value::as_safe_int), exit.get("signal").and_then(Value::as_str));
        let outcome = case.get("context").unwrap().get("resources").and_then(|resources| match resources {
            Value::Array(items) => items[0].get("commitOutcome").and_then(Value::as_str).map(str::to_string),
            _ => None,
        });
        let mut rig = Rig::new();
        let pid = rig.tree_pid_as(handle);
        if outcome.as_deref() == Some("failure") {
            rig.core.os.fail_commit = Some((ErrorKind::Failure, "exec_failed"));
        }
        rig.send(&format!(r#"{{"op":"commit","resource":"{handle}"}}"#));
        rig.flush();
        rig.core.admission = Admission::new(&ViewLimits::default());
        assert_eq!(rig.core.handle_frame(request, 0), Handled::Continue, "{name}");
        let bound = grace + (KeeperLimits::default().stop_extra_ms as u64) / 2;
        rig.core.tick(bound - 1);
        assert!(rig.core.take_outbound().is_empty(), "{name}: nothing before the bound");
        rig.core.tick(bound);
        assert!(rig.core.child_exited(pid, code, signal), "{name}");
        // A second reap of the same init (the "two exits" case) produces nothing.
        assert!(!rig.core.child_exited(pid, code, signal), "{name}");
        let out: Vec<String> = rig.core.take_outbound().iter().map(json::stringify).collect();
        assert_eq!(out, expected(&case), "{name}");
        checked += 1;
    }
    assert_eq!(checked, 6);
}

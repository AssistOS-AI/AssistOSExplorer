//! The keeper's v1 dispatcher (keeper-wire-contract-delta-2026-10-28_claude.md §2-§5 and R1), pure and host-tested.
//! Kernel work is behind [`KeeperOs`]; `linux::os` implements it.
//!
//! | Rule | Where |
//! |---|---|
//! | First request must be `commit_keeper` (the keeper's own gate); anything else exits 65, EOF before it exits 66 | `handle_frame` |
//! | Request ids strictly increase; `id <= lastId` is the violation `duplicate_id` | `handle_frame` |
//! | Structural problems are violations (exit 65); well-formed but not permitted is a `refused` reply | `keeper_frames::decode_request`, ops |
//! | `maxInFlight` (16) counts every request except `pty_input` until its reply is flushed; the mount ops (`mount_view`, `unmount_view`, `view_root_lease`) are also bounded among themselves by `maxMountInFlight` (4); either breach is a violation (R1.6, R2.3) | `admit` |
//! | `pty_input` has its own per-pty window: at most `ptyInputWindowFrames` unreplied chunks and `ptyInputWindowBytes` unreplied bytes; beyond it is a violation; no deadline (R1.2, N-A) | `admit` |
//! | Exactly one `exit` event per process-bearing resource whose commit was answered `ok` or `failure` (§4: "an `exit` event follows" `exec_failed` and `stream_connect_failed`), always after that reply; none after `refused` or before any reply. `stop` replies after that resource's `exit` event | `commit`, `child_exited`, `stop` |
//! | A `failure` commit kills that stage by the identity held since create (`KeeperOs::kill_stage`, never a raw pid), so its `exit` follows (R2.1) | `commit` |
//! | A `stop` on an `executed` or `commit_failed` process not reaped within `graceMs + stopExtraMs/2` is answered `failure: stop_timeout`; the exit is still emitted later, with no second reply (R2.2) | `stop`, `tick`, `child_exited` |
//! | PTY output only within granted credit, seq contiguous from `"1"`; `pty_closed` once, nothing after | `pty_output`, `pty_closed` |
//! | Any end step makes later `create` refuse `execution_ending`; `remove_runtime` and `shutdown` reply, then exit 0 | ops |

use std::collections::VecDeque;

use rw_proto::json::{Value, int, obj, text};
use rw_proto::keeper_frames::{
    Admission, CreateKind, ErrorKind, Request, RequestContext, Spec, Verdict, WireIdentity, create_value, decode_request, empty, error_reply, exit_event,
    ok_reply, pty_closed_event, pty_output_event, seq_value, state_value, wire_code,
};
use rw_proto::keeper_limits::{EndpointLimits, KeeperLimits};
use rw_proto::lease::{LeaseAction, LeaseState, RootLeaseKeeper};
use rw_proto::limits::ViewLimits;
use rw_proto::mount_frames::{
    MountContext, MountRequest, MountSet, MountedIdentity, RefusalKind, Scope, lease_state_reply, mount_ok_reply, refusal_reply,
    validate_mount_request, validate_root_lease_frame,
};
use crate::launch::{CommitLatch, CommitState, Completion, OperationId, Progress, commit_deadline, create_deadline};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndStep {
    ProcessTrees,
    Endpoint,
    Egress,
    Views,
    Runtime,
}

/// What a successful `create` produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Created {
    pub identity: WireIdentity,
    /// The init pid of a process-bearing resource (supervisor PID namespace), for exit tracking.
    pub pid: Option<i64>,
}

pub type OsError = (ErrorKind, &'static str);

/// Everything the core needs from the kernel. Host tests use a fake; `linux::os::LinuxOs` is the real one.
pub trait KeeperOs {
    fn create(&mut self, handle: &str, kind: CreateKind, marker: Option<&str>, locator: &Value, spec: &Spec) -> Result<Created, OsError>;
    /// Releases the gate of a process-bearing resource (returns "executed" once the final exec succeeded) or commits a
    /// passive one ("committed").
    fn commit(&mut self, handle: &str, kind: CreateKind) -> Result<&'static str, OsError>;
    /// Nonblocking scheduling. Each full operation token owns at most one allocation; notification retries replay
    /// its immutable metadata and never allocate again. Ready Refused is allowed only before construction starts.
    /// Pending acknowledges scheduling; all subsequent create errors are setup_failed, regardless of adapter code.
    fn begin_create(&mut self, operation: &OperationId, kind: CreateKind, marker: Option<&str>, locator: &Value, spec: &Spec, _deadline: u64) -> Progress<Result<Created, OsError>> {
        Progress::Ready(self.create(&operation.handle, kind, marker, locator, spec))
    }
    fn begin_commit(&mut self, operation: &OperationId, kind: CreateKind, _deadline: u64) -> Progress<Result<CommitState, OsError>> {
        Progress::Ready(self.commit(&operation.handle, kind).and_then(|state| match state {
            "executed" => Ok(CommitState::Executed), "committed" => Ok(CommitState::Committed), _ => Err((ErrorKind::Failure, "exec_failed")),
        }))
    }
    /// At most one already-ready event; must not block. A latched exec result precedes its anchor's exit event.
    fn poll_completion(&mut self, _now_ms: u64) -> Option<Completion> { None }
    /// Nonblocking access to an authoritative positive latch, independent of completion queue position. Retain it
    /// until normal delivery or this take. Taking may leave a duplicate queue notification; it transfers no custody.
    /// Cancellation must remove it and reconcile the operation's objects; never fabricate/backdate a latch here.
    fn take_commit_latch(&mut self, _operation: &OperationId) -> Option<CommitLatch> { None }
    /// Cancel only this operation's held objects. The adapter retains a tombstone until kernel work reconciles.
    fn cancel_launch(&mut self, operation: &OperationId, committed: bool);
    /// Reconcile only objects owned by the full operation token. Created is metadata, not authority to signal a PID
    /// or close a descriptor. Unknown/already-reconciled tokens are no-ops; never fall back to handle/PID lookup.
    /// Live same-token notification replays are filtered by the core, and never come through this cleanup path.
    fn discard_created(&mut self, operation: OperationId, created: Created);
    /// A pending commit's current phase chooses the failure, without restarting its absolute deadline.
    fn commit_failure_code(&self, _operation: &OperationId) -> &'static str { "exec_failed" }
    /// Abandons uncommitted creations: gate EOF, SIGKILL by pidfd, drop namespaces, remove directories. A request only.
    fn abort(&mut self, handles: &[String]);
    /// SIGTERM now, SIGKILL after `grace_ms` (the OS keeps the smallest grace).
    fn stop(&mut self, handle: &str, grace_ms: i64);
    fn tempdir(&mut self) -> Result<String, OsError>;
    fn end_step(&mut self, step: EndStep);
    /// Non-blocking write to a PTY master; returns the bytes written (0 when it would block).
    fn pty_write(&mut self, handle: &str, data: &[u8]) -> Result<usize, &'static str>;
    fn pty_resize(&mut self, handle: &str, cols: i64, rows: i64) -> Result<(), &'static str>;
    fn descriptor_count(&mut self) -> i64;
    fn mount_view(&mut self, request: &MountRequest, resource: &str) -> Result<MountedIdentity, (RefusalKind, &'static str)>;
    fn detach(&mut self, identity: &MountedIdentity) -> Result<(), &'static str>;
    fn signal(&mut self, pid: i64, signal: Signal);
    /// SIGKILL of that stage's own process only, through the pidfd the keeper has held since `create`; never by a raw
    /// pid (pid reuse). Used after a `failure` commit so that the contract's `exit` event follows (§4 `commit`).
    fn kill_stage(&mut self, handle: &str);
    /// `'m'` + 32 lowercase hex.
    fn new_mount_handle(&mut self) -> String;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Creating,
    Created,
    Committing,
    Committed,
    Executed,
    /// A process-bearing commit answered `failure` (`exec_failed`, `stream_connect_failed`): the supervisor has committed
    /// it, the keeper has killed the stage, and its `exit` event is still owed.
    CommitFailed,
    Exited,
    Aborted,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Creating => "created",
            State::Created => "created",
            State::Committing => "committed",
            State::Committed => "committed",
            State::Executed => "executed",
            State::CommitFailed => "commit_failed",
            State::Exited => "exited",
            State::Aborted => "aborted",
        }
    }
}

/// One queued PTY input chunk: its request id, seq, bytes, bytes written so far, and the ids of replays of the same seq
/// received while it was still queued (RK-2: each gets the normal `{seq}` answer once the original write completes).
#[derive(Debug)]
struct PendingInput {
    id: i64,
    seq: u64,
    data: Vec<u8>,
    written: usize,
    replays: Vec<i64>,
}

#[derive(Debug)]
struct PtyState {
    last_applied: u64,
    last_queued: u64,
    pending: VecDeque<PendingInput>,
    credit: i64,
    out_seq: u64,
    closed: bool,
}

#[derive(Debug)]
struct Resource {
    handle: String,
    kind: CreateKind,
    state: State,
    role: Option<&'static str>,
    pid: Option<i64>,
    locator: Value,
    pty: Option<PtyState>,
    stop_waiters: Vec<StopWaiter>,
    /// Whether a `commit` was answered `ok` or `failure` (review F-2: "committed" is a fact about the commit, not the
    /// current state; a stage that exited at its gate is still uncommitted). After a `failure` the supervisor has
    /// committed the resource too (`state.commitResource` precedes the commit frame), so a second commit or an abort
    /// refuses `already_committed` (E-1, E-2).
    committed: bool,
    create_request: i64,
    pending: Option<PendingLaunch>,
}

#[derive(Debug)]
struct PendingLaunch { operation: OperationId, accepted_at: u64, deadline: u64 }

/// A `stop` waiting for its resource's `exit` event, answered `failure: stop_timeout` at `deadline` (R2.2).
#[derive(Debug)]
struct StopWaiter {
    id: i64,
    deadline: u64,
}

/// Contract R2.2: a `stop` whose target is not reaped within `graceMs + stopExtraMs/2` is answered
/// `failure: stop_timeout`; the keeper stays alive, a later `exit` is still emitted, and there is no second reply. The
/// same bound applies to `executed` and `commit_failed` processes. Never evidence of termination.
fn stop_bound_reply(id: i64) -> Value {
    error_reply(id, ErrorKind::Failure, "stop_timeout")
}

#[derive(Debug)]
struct View {
    identity: MountedIdentity,
    grant_id: String,
    lease: RootLeaseKeeper,
    committed: bool,
    server_exited: bool,
    detached: bool,
    kill_at: Option<u64>,
    killed: bool,
    /// Aborted by `abort_uncommitted` (review F-5): torn down, and its handle is unknown to every later op, as in the frozen
    /// reference keeper; kept only so its server's kill deadline and exit are still tracked.
    aborted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    AwaitingCommit,
    Running,
}

/// Result of handling one frame.
#[derive(Debug, PartialEq, Eq)]
pub enum Handled {
    Continue,
    /// Tear down and exit with this code (65 for a violation or a non-gate first frame, 0 after remove_runtime/shutdown).
    Exit { code: i32, reason: &'static str },
}

pub struct KeeperCore<O: KeeperOs> {
    pub os: O,
    limits: KeeperLimits,
    view_limits: ViewLimits,
    endpoint_limits: EndpointLimits,
    scope: Scope,
    runtime_root: String,
    keeper_reservation: String,
    cgroup_subtree: Option<String>,
    orchestration_root: Option<String>,
    phase: Phase,
    ending: bool,
    exit_after_flush: Option<i32>,
    resources: Vec<Resource>,
    views: Vec<View>,
    mount_set: MountSet,
    grant_count: i64,
    /// In-flight and per-pty input accounting, shared with the vector tests (keeperFrames `createKeeperAdmission`).
    admission: Admission,
    outbound: Vec<Value>,
}

impl<O: KeeperOs> KeeperCore<O> {
    pub fn new(os: O, scope: Scope, runtime_root: &str, keeper_reservation: &str, grant_count: i64, limits: KeeperLimits, view_limits: ViewLimits) -> Self {
        KeeperCore {
            os, limits, view_limits, endpoint_limits: EndpointLimits::default(), scope, runtime_root: runtime_root.to_string(), orchestration_root: None,
            keeper_reservation: keeper_reservation.to_string(), cgroup_subtree: None,
            phase: Phase::AwaitingCommit, ending: false, exit_after_flush: None, resources: Vec::new(), views: Vec::new(), mount_set: MountSet::default(),
            grant_count, admission: Admission::new(&view_limits), outbound: Vec::new(),
        }
    }

    /// `--orchestration-root`: orchestration scripts must lie under it (contract §4).
    pub fn with_orchestration_root(mut self, root: Option<String>) -> Self {
        self.orchestration_root = root;
        self
    }

    /// The supervisor-bound startup subtree. Absence is explicitly undelegated.
    pub fn with_cgroup_subtree(mut self, root: Option<String>) -> Self {
        self.cgroup_subtree = root;
        self
    }

    /// Frames (replies and events) to write, in order.
    pub fn take_outbound(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.outbound)
    }

    /// The exit code requested by `remove_runtime` or `shutdown`, once their reply has been flushed.
    pub fn exit_after_flush(&self) -> Option<i32> {
        self.exit_after_flush
    }

    fn reply(&mut self, id: i64, value: Value) {
        self.outbound.push(ok_reply(id, value));
    }

    fn refuse(&mut self, id: i64, code: &'static str) {
        self.outbound.push(error_reply(id, ErrorKind::Refused, code));
    }

    fn fail(&mut self, id: i64, kind: ErrorKind, code: &'static str) {
        self.outbound.push(error_reply(id, kind, code));
    }

    fn violation(&mut self, reason: &'static str) -> Handled {
        Handled::Exit { code: 65, reason }
    }

    /// The run loop calls this once a reply frame has been fully written.
    pub fn reply_flushed(&mut self, id: i64) {
        self.admission.settle(id);
    }

    /// One request frame. Order: structural validation (keeperFrames `validateKeeperRequest`; a violation exits 65),
    /// admission (ids strictly increasing, in-flight and per-pty windows), the keeper gate, then dispatch.
    pub fn handle_frame(&mut self, frame: &Value, now_ms: u64) -> Handled {
        let context = RequestContext {
            limits: &self.limits, view: &self.view_limits, endpoint: &self.endpoint_limits, runtime_root: Some(&self.runtime_root), cgroup_subtree: self.cgroup_subtree.as_deref(),
            keeper_reservation: &self.keeper_reservation,
            orchestration_root: self.orchestration_root.as_deref(), mount: None, prior: &[],
        };
        let verdict = decode_request(frame, &context);
        let (id, op, resource, pty_bytes) = match &verdict {
            Verdict::Violation(code) => return self.violation(code),
            Verdict::Refused { id, .. } => (*id, frame.get("op").and_then(Value::as_str).unwrap_or_default().to_string(), None, 0),
            Verdict::Ok(decoded) => match &decoded.request {
                Request::PtyInput { resource, data, .. } => (decoded.id, decoded.op.clone(), Some(resource.clone()), data.len()),
                _ => (decoded.id, decoded.op.clone(), None, 0),
            },
        };
        if let Err(code) = self.admission.admit(id, &op, resource.as_deref(), pty_bytes, frame.get("grantId").and_then(Value::as_str), &self.limits) {
            return self.violation(code);
        }
        let is_commit_keeper = matches!(&verdict, Verdict::Ok(decoded) if decoded.request == Request::CommitKeeper);
        if self.phase == Phase::AwaitingCommit {
            if !is_commit_keeper {
                return self.violation("not_commit_keeper");
            }
            self.phase = Phase::Running;
        } else if is_commit_keeper {
            return self.violation("unexpected_commit_keeper");
        }
        match verdict {
            Verdict::Ok(decoded) => self.dispatch(decoded.id, decoded.request, now_ms),
            Verdict::Refused { id, code } => {
                self.outbound.push(error_reply(id, ErrorKind::Refused, &code));
                Handled::Continue
            }
            Verdict::Violation(code) => self.violation(code),
        }
    }

    fn find(&self, handle: &str) -> Option<usize> {
        self.resources.iter().position(|resource| resource.handle == handle)
    }

    /// A live (not aborted) view by its `m…` handle.
    fn view_index(&self, handle: &str) -> Option<usize> {
        self.views.iter().position(|view| view.identity.resource == handle && !view.aborted)
    }

    fn committed_kind(&self, handle: &str, kind: CreateKind) -> bool {
        self.resources.iter().any(|resource| resource.handle == handle && resource.kind == kind && matches!(resource.state, State::Committed | State::Executed))
    }

    fn runtime_locator_id(&self) -> Option<String> {
        self.resources.iter().find(|resource| resource.kind == CreateKind::RuntimeDir && resource.state == State::Committed).and_then(|resource| {
            resource.locator.get("path").and_then(Value::as_str).and_then(|path| path.rsplit('/').next()).map(str::to_string)
        })
    }

    fn dispatch(&mut self, id: i64, request: Request, now_ms: u64) -> Handled {
        match request {
            Request::CommitKeeper | Request::Ping => self.reply(id, empty()),
            Request::Create { resource, kind, marker, locator, spec } => return self.create(id, resource, kind, marker, locator, spec, now_ms),
            Request::Commit { resource } => self.commit(id, &resource, now_ms),
            Request::AbortUncommitted { resources } => {
                // A committed view refuses the whole frame too (review F-5; frozen fakeKeeperProcess `abort_uncommitted`).
                let committed = resources.iter().any(|handle| {
                    self.find(handle).is_some_and(|index| self.resources[index].committed) || self.view_index(handle).is_some_and(|index| self.views[index].committed)
                });
                if committed {
                    self.refuse(id, "already_committed");
                } else {
                    for handle in &resources {
                        if let Some(index) = self.find(handle).filter(|index| self.resources[*index].state == State::Creating) {
                            self.cancel_pending(index);
                        }
                    }
                    // Every known uncommitted creation, including a stage that already exited at its gate (its gate pipe
                    // and namespace descriptors are still in custody until aborted).
                    let views: Vec<usize> = resources.iter().filter_map(|handle| self.view_index(handle)).collect();
                    let known: Vec<String> = resources
                        .into_iter()
                        .filter(|handle| self.find(handle).is_some_and(|index| matches!(self.resources[index].state, State::Created | State::Exited)))
                        .collect();
                    if !known.is_empty() {
                        self.os.abort(&known);
                    }
                    for handle in &known {
                        if let Some(index) = self.find(handle) {
                            self.resources[index].state = State::Aborted;
                        }
                    }
                    // Review F-5: an uncommitted view (for example one whose identity did not verify) is detached and its
                    // server stopped now (SIGTERM, KILL after the revoke grace; RK-5 even if the detach fails), not left
                    // serving until its initial lease expires. The answer proves nothing (§4), so a failed detach is not
                    // reported here; the supervisor's walk proves or quarantines the mount.
                    for index in views {
                        let _ = self.teardown_view(index, now_ms);
                        self.views[index].aborted = true;
                    }
                    self.reply(id, empty());
                }
            }
            Request::Stop { resource, grace_ms } => match self.find(&resource) {
                None => self.refuse(id, "unknown_resource"),
                Some(index) if !self.resources[index].kind.process_bearing() => self.refuse(id, "not_a_process"),
                Some(index) => match self.resources[index].state {
                    // R3 RV-1: an observed exit wins, including a stage that exited at its gate; otherwise Created
                    // and Aborted tombstones refuse resource_not_committed without signalling or changing state.
                    State::Exited => self.reply(id, state_value("exited")),
                    State::Executed | State::CommitFailed | State::Committing => {
                        // R2.2: answered after the exit event, or `stop_timeout` at graceMs + stopExtraMs/2. R2.6: this is
                        // a keeper response budget from receipt, smaller than the client's graceMs + stopExtraMs from its
                        // send; it does not guarantee delivery before the client deadline (a runtime gate).
                        let margin = (self.limits.stop_extra_ms / 2).max(0) as u64;
                        let deadline = now_ms.saturating_add(grace_ms.max(0) as u64).saturating_add(margin);
                        self.resources[index].stop_waiters.push(StopWaiter { id, deadline });
                        // A failed-commit stage was already killed at the failure (R2.1); an executed one is signalled.
                        if matches!(self.resources[index].state, State::Executed | State::Committing) {
                            self.os.stop(&resource, grace_ms);
                        }
                    }
                    _ => self.refuse(id, "resource_not_committed"),
                },
            },
            Request::Tempdir => {
                if self.runtime_locator_id().is_none() {
                    self.refuse(id, "runtime_dir_missing");
                } else {
                    match self.os.tempdir() {
                        Ok(path) => self.reply(id, obj(vec![("path", text(&path))])),
                        Err((kind, code)) => self.fail(id, kind, code),
                    }
                }
            }
            Request::EndProcessTrees => self.end(id, EndStep::ProcessTrees, now_ms),
            Request::EndEndpoint => self.end(id, EndStep::Endpoint, now_ms),
            Request::ReleaseEgress => self.end(id, EndStep::Egress, now_ms),
            Request::ReleaseViews => self.end(id, EndStep::Views, now_ms),
            Request::RemoveRuntime => {
                self.end(id, EndStep::Runtime, now_ms);
                self.exit_after_flush = Some(0);
            }
            Request::Shutdown => {
                self.shutdown();
                self.reply(id, empty());
                self.exit_after_flush = Some(0);
            }
            Request::Inventory => {
                let resources: Vec<Value> = self
                    .resources
                    .iter()
                    .filter(|resource| resource.state != State::Creating)
                    .map(|resource| obj(vec![("resource", text(&resource.handle)), ("kind", text(resource.kind.as_str())), ("state", text(resource.state.as_str()))]))
                    .chain(self.views.iter().map(|view| {
                        obj(vec![("resource", text(&view.identity.resource)), ("kind", text("mount")), ("state", text(if view.committed { "committed" } else { "created" }))])
                    }))
                    .collect();
                let descriptors = self.os.descriptor_count();
                self.reply(id, obj(vec![("resources", Value::Array(resources)), ("descriptors", int(descriptors))]));
            }
            Request::PtyInput { resource, seq, data } => self.pty_input(id, &resource, seq, data),
            Request::PtyResize { resource, cols, rows } => match self.pty_index(&resource) {
                None => self.refuse(id, "unknown_resource"),
                Some(index) if self.resources[index].pty.as_ref().is_some_and(|pty| pty.closed) => self.refuse(id, "pty_closed"),
                Some(_) => match self.os.pty_resize(&resource, cols, rows) {
                    Ok(()) => self.reply(id, empty()),
                    Err(_) => self.refuse(id, "pty_closed"),
                },
            },
            Request::PtyCredit { resource, bytes } => match self.pty_index(&resource) {
                None => self.refuse(id, "unknown_resource"),
                Some(index) => {
                    let max = self.limits.pty_max_credit_bytes;
                    let pty = self.resources[index].pty.as_mut().expect("pty state");
                    if pty.credit + bytes > max {
                        self.refuse(id, "credit_overflow");
                    } else {
                        pty.credit += bytes;
                        self.reply(id, empty());
                    }
                }
            },
            Request::MountView(frame) => return self.mount_view(id, &frame, now_ms),
            Request::UnmountView { resource } => match self.view_index(&resource) {
                None => self.refuse(id, "unknown_resource"),
                Some(index) => match self.teardown_view(index, now_ms) {
                    Ok(()) => self.reply(id, empty()),
                    Err(code) => self.fail(id, ErrorKind::Failure, code),
                },
            },
            Request::ViewRootLease(frame) => {
                let grant = match validate_root_lease_frame(&frame, &self.view_limits) {
                    Ok(parsed) => parsed.grant_id,
                    Err("bad_frame") => return self.violation("bad_frame"),
                    Err(code) => {
                        self.refuse(id, code);
                        return Handled::Continue;
                    }
                };
                match self.views.iter().position(|view| view.grant_id == grant && !view.aborted) {
                    None => self.refuse(id, "wrong_grant"),
                    Some(index) => {
                        let result = self.views[index].lease.apply(&frame, now_ms);
                        self.tick(now_ms);
                        if result.accepted {
                            let state = self.views[index].lease.state().as_str();
                            self.outbound.push(lease_state_reply(id, state));
                        } else {
                            self.refuse(id, result.code);
                        }
                    }
                }
            }
        }
        Handled::Continue
    }

    fn create(&mut self, id: i64, handle: String, kind: CreateKind, marker: Option<String>, locator: Value, spec: Spec, now_ms: u64) -> Handled {
        if self.ending {
            self.refuse(id, "execution_ending");
            return Handled::Continue;
        }
        if self.find(&handle).is_some() || self.views.iter().any(|view| view.identity.resource == handle) {
            self.refuse(id, "duplicate_resource");
            return Handled::Continue;
        }
        // The locator (path under --runtime-root/x/<32hex> for a runtime directory) was checked by the decoder.
        if kind == CreateKind::RuntimeDir {
            if self.resources.iter().any(|resource| resource.kind == CreateKind::RuntimeDir && resource.state != State::Aborted) {
                self.refuse(id, "duplicate_role");
                return Handled::Continue;
            }
        } else if self.runtime_locator_id().is_none() {
            self.refuse(id, "runtime_dir_missing");
            return Handled::Continue;
        }
        let role = match &spec {
            Spec::Orchestration { .. } => Some("orchestration"),
            Spec::Workload { .. } => Some("workload"),
            Spec::Terminal { .. } => Some("terminal"),
            Spec::Endpoint { .. } => Some("endpoint"),
            _ => None,
        };
        let references_ok = match &spec {
            Spec::Endpoint { netns, .. } => self.committed_kind(netns, CreateKind::Netns),
            Spec::Workload { netns, .. } => self.committed_kind(netns, CreateKind::Netns),
            Spec::Terminal { pty, netns, .. } => self.committed_kind(pty, CreateKind::Pty) && netns.as_ref().is_none_or(|netns| self.committed_kind(netns, CreateKind::Netns)),
            _ => true,
        };
        if !references_ok {
            self.refuse(id, "resource_not_committed");
            return Handled::Continue;
        }
        let unique_role = matches!(role, Some("orchestration") | Some("endpoint"));
        if unique_role && self.resources.iter().any(|resource| resource.role == role && resource.state != State::Aborted) {
            self.refuse(id, "duplicate_role");
            return Handled::Continue;
        }
        if kind == CreateKind::Pty
            && self.resources.iter().filter(|resource| resource.kind == CreateKind::Pty && resource.state != State::Aborted).count() as i64 >= self.limits.max_ptys_per_keeper
        {
            self.refuse(id, "pty_limit_reached");
            return Handled::Continue;
        }
        let deadline = match create_deadline(now_ms, &self.limits) {
            Ok(deadline) => deadline,
            Err(code) => { self.fail(id, ErrorKind::Failure, code); return Handled::Continue; }
        };
        let operation = OperationId { handle: handle.clone(), request_id: id };
        let index = self.resources.len();
        self.resources.push(Resource { handle, kind, state: State::Creating, role, pid: None, locator: locator.clone(), pty: None,
            stop_waiters: Vec::new(), committed: false, create_request: id, pending: Some(PendingLaunch { operation: operation.clone(), accepted_at: now_ms, deadline }) });
        if let Progress::Ready(result) = self.os.begin_create(&operation, kind, marker.as_deref(), &locator, &spec, deadline) {
            let failed_synchronously = result.is_err();
            self.finish_create(index, result);
            // Preserve the synchronous adapter's prior retry semantics: no pending work can complete after Ready.
            if failed_synchronously { self.resources.remove(index); }
        }
        Handled::Continue
    }

    fn finish_create(&mut self, index: usize, result: Result<Created, OsError>) {
        let pending = self.resources[index].pending.take().expect("creating operation");
        match result {
            Ok(created) => {
                let resource = &mut self.resources[index];
                resource.state = State::Created;
                resource.pid = created.pid;
                resource.pty = (resource.kind == CreateKind::Pty).then(|| PtyState { last_applied: 0, last_queued: 0, pending: VecDeque::new(), credit: 0, out_seq: 0, closed: false });
                let value = create_value(&resource.handle, &created.identity);
                self.reply(pending.operation.request_id, value);
            }
            Err((kind, code)) => {
                self.resources[index].state = State::Aborted;
                self.fail(pending.operation.request_id, kind, code);
            }
        }
    }

    fn commit(&mut self, id: i64, handle: &str, now_ms: u64) {
        if let Some(index) = self.view_index(handle) {
            if self.views[index].committed {
                self.refuse(id, "already_committed");
            } else {
                self.views[index].committed = true;
                self.reply(id, state_value("committed"));
            }
            return;
        }
        let Some(index) = self.find(handle) else {
            self.refuse(id, "unknown_resource");
            return;
        };
        match self.resources[index].state {
            State::Created => {}
            State::Creating => { self.refuse(id, "resource_not_committed"); return; }
            State::Exited if self.resources[index].kind.process_bearing() && !self.resources[index].committed => {
                // The stage died at its gate before commit.
                self.refuse(id, "gate_closed");
                return;
            }
            _ => {
                self.refuse(id, "already_committed");
                return;
            }
        }
        let kind = self.resources[index].kind;
        let operation = OperationId { handle: handle.to_string(), request_id: id };
        let deadline = commit_deadline(now_ms, &self.limits);
        self.resources[index].state = State::Committing;
        self.resources[index].committed = true;
        self.resources[index].pending = Some(PendingLaunch { operation: operation.clone(), accepted_at: now_ms, deadline: deadline.unwrap_or(now_ms) });
        let progress = match deadline {
            Ok(deadline) => self.os.begin_commit(&operation, kind, deadline),
            Err(code) => Progress::Ready(Err((ErrorKind::Failure, code))),
        };
        if let Progress::Ready(result) = progress { self.finish_commit(index, result, true); }
    }

    fn finish_commit(&mut self, index: usize, result: Result<CommitState, OsError>, immediate: bool) {
        let pending = self.resources[index].pending.take().expect("committing operation");
        let id = pending.operation.request_id;
        let handle = self.resources[index].handle.clone();
        let kind = self.resources[index].kind;
        // A refusal is possible only before asynchronous acceptance; accepted commits retain committed ownership.
        let result = if !immediate && result.as_ref().is_err_and(|(kind, _)| *kind == ErrorKind::Refused) {
            Err((ErrorKind::Failure, "exec_failed"))
        } else { result };
        match result {
            Ok(state) => {
                self.resources[index].state = if state == CommitState::Executed { State::Executed } else { State::Committed };
                self.resources[index].committed = true;
                self.reply(id, state_value(state.as_str()));
            }
            Err((error_kind, code)) if error_kind == ErrorKind::Failure && kind.process_bearing() => {
                // §4: after `exec_failed` or `stream_connect_failed` an `exit` event follows. The reply goes first; the
                // stage is then killed by its own identity, and `child_exited` emits the exit once it is reaped.
                self.resources[index].state = State::CommitFailed;
                self.resources[index].committed = true;
                self.fail(id, error_kind, code);
                self.os.kill_stage(&handle);
            }
            Err((error_kind, code)) => {
                let refused_before_acceptance = immediate && error_kind == ErrorKind::Refused;
                self.resources[index].state = if refused_before_acceptance { State::Created } else { State::CommitFailed };
                self.resources[index].committed = !refused_before_acceptance;
                self.fail(id, error_kind, code);
            }
        }
    }

    fn cancel_pending(&mut self, index: usize) {
        let Some(pending) = self.resources[index].pending.as_ref() else { return };
        let operation = pending.operation.clone();
        let committing = self.resources[index].state == State::Committing;
        // Mark cancellation before calling the adapter, which may arrange a late completion.
        if !committing {
            self.resources[index].state = State::Aborted;
            self.resources[index].pending = None;
            self.os.cancel_launch(&operation, false);
            self.fail(operation.request_id, ErrorKind::Failure, "setup_failed");
        } else {
            let code = self.os.commit_failure_code(&operation);
            self.os.cancel_launch(&operation, true);
            self.finish_commit(index, Err((ErrorKind::Failure, code)), false);
        }
    }

    /// Bounded drain leaves channel, stops and teardown runnable even if an adapter has more completions queued.
    pub fn poll_launches(&mut self, now_ms: u64) {
        for _ in 0..32 {
            let Some(completion) = self.os.poll_completion(now_ms) else { break };
            match completion {
                Completion::Created { operation, result } => {
                    if let Some(index) = self.find(&operation.handle).filter(|index| self.resources[*index].pending.as_ref()
                        .is_some_and(|pending| pending.operation == operation && now_ms >= pending.deadline)) { self.cancel_pending(index); }
                    let index = self.find(&operation.handle).filter(|index| self.resources[*index].state == State::Creating
                        && self.resources[*index].pending.as_ref().is_some_and(|pending| pending.operation == operation));
                    if let Some(index) = index {
                        match result {
                            Ok(created) => self.finish_create(index, Ok(created)),
                            Err(_) => self.cancel_pending(index),
                        }
                    } else if let Ok(created) = result {
                        if !self.created_already_published(&operation) { self.os.discard_created(operation, created); }
                    }
                }
                Completion::Committed { operation, result } => {
                    // Consume a separately retained copy, if any. Already-cancelled operations never resurrect.
                    let _ = self.os.take_commit_latch(&operation);
                    if let Some(index) = self.find(&operation.handle).filter(|index| self.resources[*index].state == State::Committing
                        && self.resources[*index].pending.as_ref().is_some_and(|pending| pending.operation == operation)) {
                        let pending = self.resources[index].pending.as_ref().unwrap();
                        let result = result.and_then(|latch| {
                            if latch.within(pending.accepted_at, pending.deadline, now_ms) { Ok(latch.state) }
                            else { Err((ErrorKind::Failure, "exec_failed")) }
                        });
                        self.finish_commit(index, result, false);
                    }
                }
                Completion::Exited { owner, pid, code, signal } => {
                    if let Some(index) = self.find(&owner.handle).filter(|index| self.resources[*index].create_request == owner.request_id) {
                        if self.resources[index].state == State::Creating { self.cancel_pending(index); }
                        else if self.resources[index].pid == Some(pid) { self.resource_exited(index, code, signal); }
                    }
                }
            }
        }
    }

    fn created_already_published(&self, operation: &OperationId) -> bool {
        self.find(&operation.handle).is_some_and(|index| self.resources[index].create_request == operation.request_id
            && !matches!(self.resources[index].state, State::Creating | State::Aborted))
    }

    fn expire_launch(&mut self, index: usize, now_ms: u64) {
        let Some(pending) = self.resources[index].pending.as_ref() else { return };
        if now_ms < pending.deadline { return; }
        if self.resources[index].state == State::Committing {
            if let Some(latch) = self.os.take_commit_latch(&pending.operation) {
                if latch.within(pending.accepted_at, pending.deadline, now_ms) {
                    self.finish_commit(index, Ok(latch.state), false);
                    return;
                }
            }
        }
        self.cancel_pending(index);
    }

    fn end(&mut self, id: i64, step: EndStep, now_ms: u64) {
        self.ending = true;
        for index in 0..self.resources.len() { self.cancel_pending(index); }
        // Views are detached before the runtime directory is removed, whatever order the supervisor used.
        if step == EndStep::Views || step == EndStep::Runtime {
            for index in 0..self.views.len() {
                let _ = self.teardown_view(index, now_ms);
            }
        }
        if step == EndStep::ProcessTrees {
            for index in 0..self.resources.len() {
                if self.resources[index].kind == CreateKind::Pty {
                    self.close_pty(index);
                }
            }
        }
        self.os.end_step(step);
        self.reply(id, empty());
    }

    fn pty_index(&self, handle: &str) -> Option<usize> {
        self.find(handle).filter(|index| self.resources[*index].kind == CreateKind::Pty && self.resources[*index].state == State::Committed)
    }

    fn pty_input(&mut self, id: i64, handle: &str, seq: u64, data: Vec<u8>) {
        let Some(index) = self.pty_index(handle) else {
            self.refuse(id, "unknown_resource");
            return;
        };
        let pty = self.resources[index].pty.as_mut().expect("pty state");
        if pty.closed {
            self.refuse(id, "pty_closed");
        } else if seq <= pty.last_applied {
            // Replay-safe: an applied seq is acknowledged again without a second write.
            self.reply(id, seq_value(seq));
        } else if seq <= pty.last_queued {
            // RK-2 (decided): a replay of a seq whose original chunk is queued but not yet completely written gets the
            // normal `{seq}` answer when that original write completes. The bytes are never written twice, and no code
            // outside the contract set is used.
            if let Some(entry) = pty.pending.iter_mut().find(|entry| entry.seq == seq) {
                entry.replays.push(id);
            }
        } else if seq != pty.last_queued + 1 {
            self.refuse(id, "sequence_gap");
        } else {
            pty.last_queued = seq;
            pty.pending.push_back(PendingInput { id, seq, data, written: 0, replays: Vec::new() });
            self.pump_pty(index);
        }
    }

    /// Writes queued PTY input without blocking. A chunk is acknowledged only after every byte reached the master.
    pub fn pump_pty_input(&mut self) {
        for index in 0..self.resources.len() {
            if self.resources[index].pty.is_some() {
                self.pump_pty(index);
            }
        }
    }

    fn pump_pty(&mut self, index: usize) {
        let handle = self.resources[index].handle.clone();
        loop {
            let Some(pty) = self.resources[index].pty.as_mut() else { return };
            let Some(entry) = pty.pending.front_mut() else { return };
            match self.os.pty_write(&handle, &entry.data[entry.written..]) {
                Ok(0) => return,
                Ok(count) => {
                    entry.written += count;
                    if entry.written == entry.data.len() {
                        let done = pty.pending.pop_front().expect("front");
                        pty.last_applied = done.seq;
                        for reply_id in std::iter::once(done.id).chain(done.replays) {
                            self.outbound.push(ok_reply(reply_id, seq_value(done.seq)));
                        }
                    }
                }
                Err(_) => {
                    self.close_pty(index);
                    return;
                }
            }
        }
    }

    /// How many output bytes the run loop may read from this PTY master now (credit-limited, at most one chunk).
    pub fn pty_read_budget(&self, handle: &str) -> usize {
        self.pty_index(handle)
            .and_then(|index| self.resources[index].pty.as_ref())
            .filter(|pty| !pty.closed)
            .map(|pty| pty.credit.min(self.limits.pty_chunk_bytes).max(0) as usize)
            .unwrap_or(0)
    }

    /// Output read from a master, within the budget. Emits `pty_output` with the next seq and consumes credit.
    pub fn pty_output(&mut self, handle: &str, data: &[u8]) -> Result<(), &'static str> {
        let budget = self.pty_read_budget(handle);
        if data.is_empty() || data.len() > budget {
            return Err("pty_output_over_credit");
        }
        let index = self.pty_index(handle).ok_or("unknown_resource")?;
        let pty = self.resources[index].pty.as_mut().expect("pty state");
        pty.credit -= data.len() as i64;
        pty.out_seq += 1;
        let seq = pty.out_seq;
        self.outbound.push(pty_output_event(handle, seq, data));
        Ok(())
    }

    fn close_pty(&mut self, index: usize) {
        let handle = self.resources[index].handle.clone();
        let Some(pty) = self.resources[index].pty.as_mut() else { return };
        if pty.closed {
            return;
        }
        pty.closed = true;
        let pending: Vec<_> = pty.pending.drain(..).collect();
        for entry in pending {
            let kind = if entry.written == 0 { ErrorKind::Refused } else { ErrorKind::Failure };
            for reply_id in std::iter::once(entry.id).chain(entry.replays) {
                self.outbound.push(error_reply(reply_id, kind, "pty_closed"));
            }
        }
        self.outbound.push(pty_closed_event(&handle));
    }

    /// The master reported end-of-file or an error.
    pub fn pty_closed(&mut self, handle: &str) {
        if let Some(index) = self.find(handle) {
            self.close_pty(index);
        }
    }

    pub fn pty_handles(&self) -> Vec<String> {
        self.resources.iter().filter(|resource| resource.pty.as_ref().is_some_and(|pty| !pty.closed)).map(|resource| resource.handle.clone()).collect()
    }

    fn mount_view(&mut self, id: i64, frame: &Value, now_ms: u64) -> Handled {
        let Some(locator_id) = self.runtime_locator_id() else {
            self.refuse(id, "runtime_dir_missing");
            return Handled::Continue;
        };
        let context = MountContext { scope: self.scope, runtime_root: self.runtime_root.clone(), reservation_id: locator_id, grant_count: self.grant_count };
        let request = match validate_mount_request(frame, &context, &self.view_limits) {
            Ok(request) => request,
            Err("bad_frame") => return self.violation("bad_frame"),
            Err(code) => {
                self.outbound.push(error_reply(id, ErrorKind::Refused, &wire_code(code)));
                return Handled::Continue;
            }
        };
        if let Err(code) = self.mount_set.check(&request, &self.view_limits) {
            self.outbound.push(error_reply(id, ErrorKind::Refused, &wire_code(code)));
            return Handled::Continue;
        }
        self.mount_set.record(&request);
        let Ok(lease) = RootLeaseKeeper::new(&request.grant_id, 1, request.lease_ttl_ms, now_ms, self.view_limits) else {
            self.refuse(id, "bad_root_lease");
            return Handled::Continue;
        };
        let resource = self.os.new_mount_handle();
        match self.os.mount_view(&request, &resource) {
            Ok(identity) => {
                self.outbound.push(mount_ok_reply(id, &identity));
                self.views.push(View { identity, grant_id: request.grant_id, lease, committed: false, server_exited: false, detached: false, kill_at: None, killed: false, aborted: false });
            }
            Err((kind, code)) => self.outbound.push(refusal_reply(id, kind, code)),
        }
        Handled::Continue
    }

    fn teardown_view(&mut self, index: usize, now_ms: u64) -> Result<(), &'static str> {
        let grace = self.view_limits.root_revoke_grace_ms as u64;
        let view = &mut self.views[index];
        let detached = if view.detached {
            Ok(())
        } else {
            let result = self.os.detach(&view.identity);
            view.detached = result.is_ok();
            result
        };
        // The server is stopped even when the detach failed (review RK-5): a view that cannot be detached must at least
        // stop serving (ENOTCONN); the supervisor's walk then proves or quarantines the mount.
        if !view.server_exited && view.kill_at.is_none() && !view.killed {
            self.os.signal(view.identity.server_pid, Signal::Term);
            view.kill_at = Some(now_ms.saturating_add(grace));
        }
        detached
    }

    /// Lease enforcement, teardown deadlines and bounded stops.
    pub fn tick(&mut self, now_ms: u64) {
        self.poll_launches(now_ms);
        for index in 0..self.resources.len() {
            self.expire_launch(index, now_ms);
        }
        for resource in &mut self.resources {
            let (due, waiting): (Vec<StopWaiter>, Vec<StopWaiter>) =
                std::mem::take(&mut resource.stop_waiters).into_iter().partition(|waiter| now_ms >= waiter.deadline);
            resource.stop_waiters = waiting;
            for waiter in due {
                self.outbound.push(stop_bound_reply(waiter.id));
            }
        }
        for view in &mut self.views {
            if view.server_exited || view.killed {
                continue;
            }
            match view.lease.poll(now_ms).1 {
                Some(LeaseAction::SignalRevoke) => self.os.signal(view.identity.server_pid, Signal::Term),
                Some(LeaseAction::Kill) => {
                    self.os.signal(view.identity.server_pid, Signal::Kill);
                    view.killed = true;
                }
                None => {}
            }
            if let Some(at) = view.kill_at {
                if now_ms >= at && !view.killed {
                    self.os.signal(view.identity.server_pid, Signal::Kill);
                    view.killed = true;
                }
            }
        }
    }

    pub fn next_deadline(&self) -> Option<u64> {
        let views = self.views.iter().filter(|view| !view.server_exited && !view.killed).flat_map(|view| [view.lease.next_deadline(), view.kill_at]).flatten();
        let stops = self.resources.iter().flat_map(|resource| resource.stop_waiters.iter().map(|waiter| waiter.deadline));
        let launches = self.resources.iter().filter_map(|resource| resource.pending.as_ref().map(|pending| pending.deadline));
        views.chain(stops).chain(launches).min()
    }

    /// A reaped child: a file server, or the init of a process-bearing resource. Emits `exit` (only after commit) and
    /// answers pending stops after it.
    pub fn child_exited(&mut self, pid: i64, code: Option<i64>, signal: Option<&str>) -> bool {
        for view in &mut self.views {
            if view.identity.server_pid == pid && !view.server_exited {
                view.server_exited = true;
                view.lease.server_exited();
                return true;
            }
        }
        let Some(index) = self.resources.iter().position(|resource| resource.pid == Some(pid) && !matches!(resource.state, State::Exited | State::Aborted)) else {
            return false;
        };
        self.resource_exited(index, code, signal)
    }

    fn resource_exited(&mut self, index: usize, code: Option<i64>, signal: Option<&str>) -> bool {
        if matches!(self.resources[index].state, State::Exited | State::Aborted) { return false; }
        if self.resources[index].state == State::Committing {
            self.finish_commit(index, Err((ErrorKind::Failure, "exec_failed")), false);
        }
        // The exit is owed after an `ok` or `failure` commit reply, never after `refused` or before any reply.
        let owes_exit = matches!(self.resources[index].state, State::Executed | State::CommitFailed);
        self.resources[index].state = State::Exited;
        if owes_exit {
            let handle = self.resources[index].handle.clone();
            self.outbound.push(exit_event(&handle, code, signal));
            for waiter in std::mem::take(&mut self.resources[index].stop_waiters) {
                self.outbound.push(ok_reply(waiter.id, state_value("exited")));
            }
        }
        true
    }

    /// EOF, a violation or `shutdown`: every end step in order, views detached and their servers killed.
    pub fn shutdown(&mut self) {
        self.ending = true;
        for index in 0..self.resources.len() { self.cancel_pending(index); }
        for step in [EndStep::ProcessTrees, EndStep::Endpoint, EndStep::Egress] {
            self.os.end_step(step);
        }
        for view in &mut self.views {
            if !view.detached {
                let _ = self.os.detach(&view.identity);
                view.detached = true;
            }
            if !view.server_exited && !view.killed {
                self.os.signal(view.identity.server_pid, Signal::Kill);
                view.killed = true;
            }
        }
        for step in [EndStep::Views, EndStep::Runtime] {
            self.os.end_step(step);
        }
    }

    pub fn live_servers(&self) -> Vec<i64> {
        self.views.iter().filter(|view| !view.server_exited).map(|view| view.identity.server_pid).collect()
    }

    pub fn lease_state(&self, grant: &str) -> Option<LeaseState> {
        self.views.iter().find(|view| view.grant_id == grant).map(|view| view.lease.state())
    }

    pub fn ordinary_in_flight(&self) -> usize {
        self.admission.in_flight()
    }
}

#[cfg(test)]
mod tests;

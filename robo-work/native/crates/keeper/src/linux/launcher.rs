//! Process-bearing construction on Linux (first-G1 plan; amendments A1 and A2): the adapter behind the core's pending
//! create/commit contract (`KeeperOs::begin_create`, `begin_commit`, `poll_completion`, `take_commit_latch`,
//! `cancel_launch`, `discard_created`, `commit_failure_code`).
//!
//! | Phase | What happens here |
//! |---|---|
//! | create | Builds the domain plan from the embedded image policy, the sealed environment memfd, the private SOCK_SEQPACKET stage channel (keeper end SO_PASSCRED) and the gate pipe, then clones the namespace anchor with a pidfd (`linux::domain`). Returns Pending |
//! | READY | Sender PID from SCM_CREDENTIALS only. It must be a direct child of the held anchor in the anchor's PID namespace, carry the marker, and run the pinned stage image; the keeper opens its pidfd and `/proc/<pid>` directory, re-reads its identity, and checks that the anchor runs the pinned Bubblewrap. Only then is `create` answered with the anchor identity |
//! | commit (workload) | Opens each stream leaf in the held endpoint stream directory with `O_PATH|O_NOFOLLOW`, requires a socket, connects through that pinned inode (`/proc/self/fd/N`), sends the sockets once in `INSTALL_STDIO`, closes the keeper's copies and waits for the credentialed `STDIO_INSTALLED` |
//! | release | Writes the one commit byte and closes the gate writer |
//! | observation | Reads `exe` relative to the held proc directory of the BOUND child, before and after with stable start time, PID namespace and pidfd liveness. Only the pinned intended image (different from the stage image) latches `executed`; EOF, exit codes and command lines never do |
//! | failures | Create failures answer `setup_failed`; stream failures `stream_connect_failed`; anything after release without a latched observation `exec_failed`. A committed failure kills the anchor through its pidfd and the one owed `exit` follows the reply |
//! | exit | The anchor is reaped only through its pidfd (`waitid(P_PIDFD)`); a latched or failed commit result is queued before its `Exited` |
//!
//! Signals go only through held pidfds. A reaped anchor's pidfd stays harmless (ESRCH), so a recycled PID is never hit.

use std::collections::VecDeque;
use std::ffi::CString;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use rw_proto::json::{Value, stringify};
use rw_proto::keeper_frames::{CreateKind, ErrorKind, Spec, WireIdentity};
use rw_proto::keeper_limits::KeeperLimits;

use crate::args::StageDomain;
use crate::bwrap::{BindFd, DomainSpec, ROBOT_ID, StageInvocation, bwrap_argv};
use crate::core::{Created, OsError};
use crate::domain_policy::{DomainRequest, HeldDirectory, MountSource, Role, StartupFacts, build_domain_plan};
use crate::launch::{
    ChildBinding, CommitLatch, Completion, Credentials, Exchange, Launch, LaunchPhase, Observation, OperationId, PinnedSocketFacts, ProcessIdentity,
    Progress, ReadyFacts, Record, receive, stream_leaf,
};
use crate::linux::domain::{AnchorPlan, Network, spawn_anchor};
use crate::linux::policy::HeldPolicy;
use crate::linux::sys::{self, Reaped, Received};
use crate::procfs::parse_stat;
use crate::stage::MAX_ENV_BYTES;

/// Stage descriptor slots inside the anchor (all above the final slots 0-4).
const CHANNEL_SLOT: RawFd = 5;
const GATE_SLOT: RawFd = 6;
const ENV_SLOT: RawFd = 7;
const FIRST_INSTALL_SLOT: RawFd = 8;
const FIRST_BIND_SLOT: RawFd = 16;
/// `sun_path` capacity: a stream path must fit where the endpoint binds it.
const SUN_PATH_CAPACITY: usize = 108;
/// Re-check interval while a stream connection is retried or an observation is pending.
const RETRY_MS: u64 = 2;

pub const STREAM_DIRECTORY: &str = "streams";

/// ALA channel custody consumed by endpoint and orchestration construction (`StartupCustody` fields).
#[derive(Default)]
pub struct ChannelCustody {
    pub endpoint: Option<OwnedFd>,
    pub control: Option<[OwnedFd; 3]>,
    /// `[endpoint end, orchestration end]` of the keeper-created provider socketpair.
    pub provider_endpoint: Option<OwnedFd>,
    pub provider_orchestration: Option<OwnedFd>,
}

/// The endpoint-private stream directory, held by descriptor since endpoint creation.
pub struct StreamDirectory {
    pub prefix: String,
    pub fd: OwnedFd,
    pub identity: (u64, u64),
}

/// Per-create inputs only the OS layer knows.
pub struct CreateContext<'a> {
    pub netns: Option<&'a OwnedFd>,
    pub runtime_dir: Option<RawFd>,
    pub orchestration_root: Option<String>,
}

struct Bound {
    child: ProcessIdentity,
    credentials: Credentials,
    pidfd: OwnedFd,
    procdir: OwnedFd,
}

struct Rec {
    op: OperationId,
    commit_op: Option<OperationId>,
    kind: CreateKind,
    role: Role,
    marker: String,
    model: Launch,
    anchor_pid: libc::pid_t,
    anchor_pidfd: OwnedFd,
    channel: Option<OwnedFd>,
    gate: Option<OwnedFd>,
    exchange: Exchange,
    bound: Option<Bound>,
    stage_identity: (u64, u64),
    intended: (u64, u64),
    /// Diagnostics only: identity, never a path, decides observation.
    intended_path: String,
    bwrap_identity: (u64, u64),
    /// `(slot, leaf)` of each requested standard stream.
    streams: Vec<(u8, String)>,
    connected: Vec<(u8, OwnedFd)>,
    eof: bool,
    created_sent: bool,
    commit_pending: bool,
    latch: Option<CommitLatch>,
    latch_taken: bool,
    cancelled: bool,
    reaped: Option<Reaped>,
    kill_at: Option<u64>,
    killed: bool,
}

pub struct Launcher {
    limits: KeeperLimits,
    pub policy: Option<HeldPolicy>,
    keeper_pidfd: Option<OwnedFd>,
    devnull: Option<OwnedFd>,
    pub home: Option<HeldDirectory>,
    pub channels: ChannelCustody,
    pub streams: Option<StreamDirectory>,
    records: Vec<Rec>,
    queue: VecDeque<Completion>,
}

fn setup() -> OsError {
    (ErrorKind::Failure, "setup_failed")
}

fn slot_of(stream: &str) -> Option<u8> {
    match stream { "stdin" => Some(0), "stdout" => Some(1), "stderr" => Some(2), _ => None }
}

fn read_stat_at(dir: RawFd, name: &str) -> Option<crate::procfs::StatRecord> {
    let bytes = sys::read_proc_file(dir, name, 4096).ok()?;
    parse_stat(std::str::from_utf8(&bytes).ok()?.trim_end())
}

fn proc_stat(pid: libc::pid_t) -> Option<crate::procfs::StatRecord> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat(text.trim_end())
}

fn pid_namespace(pid: libc::pid_t) -> Option<u64> {
    sys::fstatat(libc::AT_FDCWD, &format!("/proc/{pid}/ns/pid"), 0).ok().map(|stat| stat.st_ino as u64)
}

fn exe_identity(dir: RawFd) -> Option<(u64, u64)> {
    sys::fstatat(dir, "exe", 0).ok().map(|stat| sys::identity(&stat))
}

fn has_marker(cmdline: &[u8], marker: &str) -> bool {
    let parts: Vec<&[u8]> = cmdline.split(|byte| *byte == 0).collect();
    parts.windows(2).any(|pair| pair[0] == b"--reservation" && pair[1] == marker.as_bytes())
}

impl Launcher {
    pub fn new(limits: KeeperLimits) -> Self {
        let devnull = sys::cstr("/dev/null").ok().and_then(|path| {
            // SAFETY: valid C string.
            let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
            (fd >= 0).then(|| unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fd) })
        });
        // SAFETY: getpid has no preconditions. The keeper's own pidfd lets each namespace init verify the keeper is alive.
        let keeper_pidfd = sys::pidfd_open(unsafe { libc::getpid() }).ok();
        Launcher {
            limits, policy: None, keeper_pidfd, devnull, home: None, channels: ChannelCustody::default(), streams: None,
            records: Vec::new(), queue: VecDeque::new(),
        }
    }

    // ---- create ------------------------------------------------------------------------------------------------

    pub fn begin_create(&mut self, operation: &OperationId, kind: CreateKind, marker: Option<&str>, spec: &Spec, context: CreateContext<'_>)
        -> Progress<Result<Created, OsError>> {
        match self.construct(operation, kind, marker, spec, context) {
            Ok(()) => Progress::Pending,
            Err(error) => Progress::Ready(Err(error)),
        }
    }

    fn construct(&mut self, operation: &OperationId, kind: CreateKind, marker: Option<&str>, spec: &Spec, context: CreateContext<'_>) -> Result<(), OsError> {
        let marker = marker.filter(|marker| rw_proto::keeper_frames::is_origin_id(marker)).ok_or(setup())?.to_string();
        let held = self.policy.as_ref().ok_or(setup())?;
        let keeper_pidfd = self.keeper_pidfd.as_ref().ok_or(setup())?;
        let devnull = self.devnull.as_ref().ok_or(setup())?;
        let runtime_dir = context.runtime_dir.ok_or(setup())?;
        let runtime_temp = crate::linux::os::open_or_create_dir(runtime_dir, "tmp").map_err(|_| setup())?;
        let runtime_temp_identity = sys::identity(&sys::fstat(runtime_temp.as_raw_fd()).map_err(|_| setup())?);
        let ala = self.channels.endpoint.is_some() || self.channels.control.is_some();
        let facts = StartupFacts {
            runtime_temp: runtime_temp_identity, home: self.home.as_ref().map(|home| home.identity), orchestration_root: context.orchestration_root.clone(), ala_channels: ala,
        };
        let (request, role, streams, stream_bind): (DomainRequest, Role, Vec<(u8, String)>, Option<(String, bool)>) = match (kind, spec) {
            (CreateKind::ProcessTree, Spec::Workload { request, streams, .. }) => {
                let directory = self.streams.as_ref().ok_or(setup())?;
                let mut leaves = Vec::new();
                for (name, path) in streams {
                    let slot = slot_of(name).ok_or(setup())?;
                    let leaf = stream_leaf(path, &directory.prefix, SUN_PATH_CAPACITY).map_err(|_| setup())?;
                    leaves.push((slot, leaf.to_string()));
                }
                leaves.sort_by_key(|(slot, _)| *slot);
                if request.get("home").and_then(Value::as_str) != Some("/home/robot") {
                    return Err(setup());
                }
                (workload_request(request).ok_or(setup())?, Role::Workload, leaves, None)
            }
            (CreateKind::ProcessTree, Spec::Orchestration { script, args, env }) => {
                if self.channels.control.is_none() || self.channels.provider_orchestration.is_none() {
                    return Err(setup());
                }
                let request = DomainRequest {
                    role: Role::Orchestration, executable: String::new(), script: Some(script.clone()), args: args.clone(), environment: env.clone(),
                    cwd: "/tmp".into(), grants: 0, exclusions: 0, egress: false, private_proc: true, committed_netns: false, committed_pty: false,
                };
                (request, Role::Orchestration, Vec::new(), None)
            }
            (CreateKind::Endpoint, Spec::Endpoint { config, .. }) => {
                if self.channels.endpoint.is_none() || self.channels.provider_endpoint.is_none() || self.streams.is_some() {
                    return Err(setup());
                }
                let prefix = config.get("streamDirectory").and_then(Value::as_str).ok_or(setup())?.to_string();
                // providerEndpointMain.mjs requires Node's JSON IPC channel on fd 3; the variables reach only its final exec.
                let environment = vec![("NODE_CHANNEL_FD".to_string(), "3".to_string()), ("NODE_CHANNEL_SERIALIZATION_MODE".to_string(), "json".to_string())];
                let request = DomainRequest {
                    role: Role::Endpoint, executable: String::new(), script: None, args: vec![stringify(config)], environment,
                    cwd: "/tmp".into(), grants: 0, exclusions: 0, egress: false, private_proc: true, committed_netns: true, committed_pty: false,
                };
                (request, Role::Endpoint, Vec::new(), Some((prefix, true)))
            }
            // Terminal domains and PTY allocation are the S2 sub-checkpoint; refused before any construction.
            _ => return Err(setup()),
        };
        let plan = build_domain_plan(Some(&held.policy), &facts, &request)?;
        // Views: every source is a held descriptor.
        let mut binds: Vec<BindFd> = Vec::new();
        let mut sources: Vec<(RawFd, RawFd)> = Vec::new();
        let mut tmpfs: Vec<String> = Vec::new();
        let mut next_bind = FIRST_BIND_SLOT;
        let mut bind = |fd: RawFd, target: &str, read_only: bool, binds: &mut Vec<BindFd>, sources: &mut Vec<(RawFd, RawFd)>| {
            sources.push((fd, next_bind));
            binds.push(BindFd { fd: next_bind, target: target.to_string(), read_only });
            next_bind += 1;
        };
        for mount in &plan.mounts {
            match &mount.source {
                MountSource::ImageFile(path, identity, _) => {
                    let file = held.file(path).filter(|file| file.identity == *identity).ok_or(setup())?;
                    bind(file.fd.as_raw_fd(), &mount.target, true, &mut binds, &mut sources);
                }
                MountSource::Home(identity) => {
                    let home = self.home.as_ref().filter(|home| home.identity == *identity).ok_or(setup())?;
                    bind(home.fd.as_raw_fd(), &mount.target, false, &mut binds, &mut sources);
                }
                MountSource::RuntimeTemp(identity) => {
                    if *identity != runtime_temp_identity {
                        return Err(setup());
                    }
                    bind(runtime_temp.as_raw_fd(), &mount.target, false, &mut binds, &mut sources);
                }
                MountSource::PrivateTmp => tmpfs.push(mount.target.clone()),
                MountSource::PrivateProc => {}
                MountSource::PrivateDevpts => return Err(setup()),
            }
        }
        // The endpoint's private stream directory, created and held by the keeper, bound read-write at its configured
        // path. Workload streams are later connected through this held descriptor only.
        let mut new_streams: Option<StreamDirectory> = None;
        if let Some((prefix, _)) = &stream_bind {
            let fd = crate::linux::os::create_dir(runtime_dir, STREAM_DIRECTORY).map_err(|_| setup())?;
            let identity = sys::identity(&sys::fstat(fd.as_raw_fd()).map_err(|_| setup())?);
            new_streams = Some(StreamDirectory { prefix: prefix.clone(), fd, identity });
        }
        if let Some(directory) = &new_streams {
            bind(directory.fd.as_raw_fd(), &directory.prefix, false, &mut binds, &mut sources);
        }
        let stage_identity = held.policy.keeper.file.identity;
        let intended = plan.executable.file.identity;
        let bwrap_identity = held.policy.bwrap.file.identity;
        if intended == stage_identity {
            return Err(setup());
        }
        // Environment, applied only at the final exec.
        let block: Vec<u8> = plan.environment.iter().flat_map(|(name, value)| format!("{name}={value}\0").into_bytes()).collect();
        if block.len() > MAX_ENV_BYTES {
            return Err(setup());
        }
        let env = sys::sealed_memfd("rw-env", &block).map_err(|_| setup())?;
        let (keeper_end, stage_end) = sys::socketpair(libc::SOCK_SEQPACKET).map_err(|_| setup())?;
        sys::set_passcred(keeper_end.as_raw_fd()).map_err(|_| setup())?;
        sys::set_nonblocking(keeper_end.as_raw_fd(), true).map_err(|_| setup())?;
        let (gate_read, gate_write) = sys::pipe_cloexec().map_err(|_| setup())?;
        sys::set_nonblocking(gate_write.as_raw_fd(), true).map_err(|_| setup())?;
        // Inherited channels: moved by the stage to their final slots before READY.
        let mut installs: Vec<(i32, i32)> = Vec::new();
        let mut install_sources: Vec<(RawFd, RawFd)> = Vec::new();
        let mut consumed: Vec<OwnedFd> = Vec::new();
        let domain = match role {
            Role::Endpoint => {
                let provider = self.channels.provider_endpoint.take().ok_or(setup())?;
                let channel = match self.channels.endpoint.take() {
                    Some(channel) => channel,
                    None => {
                        self.channels.provider_endpoint = Some(provider);
                        return Err(setup());
                    }
                };
                consumed.push(provider);
                consumed.push(channel);
                StageDomain::Endpoint
            }
            Role::Orchestration => {
                let control = self.channels.control.take().ok_or(setup())?;
                let provider = match self.channels.provider_orchestration.take() {
                    Some(provider) => provider,
                    None => {
                        self.channels.control = Some(control);
                        return Err(setup());
                    }
                };
                let [c0, c1, c2] = control;
                consumed.extend([c0, c1, c2, provider]);
                StageDomain::Orchestration
            }
            _ => StageDomain::Workload,
        };
        let targets: &[i32] = match role { Role::Endpoint => &[3, 4], Role::Orchestration => &[0, 1, 2, 3], _ => &[] };
        for (index, (fd, target)) in consumed.iter().zip(targets).enumerate() {
            let slot = FIRST_INSTALL_SLOT + index as RawFd;
            install_sources.push((fd.as_raw_fd(), slot));
            installs.push((slot, *target));
        }
        let restore = |launcher: &mut Launcher, consumed: Vec<OwnedFd>| {
            let mut consumed = consumed.into_iter();
            match role {
                Role::Endpoint => {
                    launcher.channels.provider_endpoint = consumed.next();
                    launcher.channels.endpoint = consumed.next();
                }
                Role::Orchestration => {
                    let (c0, c1, c2) = (consumed.next(), consumed.next(), consumed.next());
                    if let (Some(c0), Some(c1), Some(c2)) = (c0, c1, c2) {
                        launcher.channels.control = Some([c0, c1, c2]);
                    }
                    launcher.channels.provider_orchestration = consumed.next();
                }
                _ => {}
            }
        };
        let spec = DomainSpec {
            uid: ROBOT_ID, gid: ROBOT_ID, binds, tmpfs, chdir: plan.cwd.clone(), new_session: true,
            stage: StageInvocation {
                keeper_path: held.policy.keeper.file.path.clone(), marker: marker.clone(), channel_fd: CHANNEL_SLOT, gate_fd: GATE_SLOT, env_fd: ENV_SLOT,
                domain, installs, nofile: plan.endpoint_nofile, final_argv: plan.argv.clone(),
            },
        };
        let argv = match bwrap_argv(&spec).map_err(|_| setup()).and_then(|argv| {
            argv.into_iter().map(|arg| CString::new(arg).map_err(|_| setup())).collect::<Result<Vec<_>, _>>()
        }) {
            Ok(argv) => argv,
            Err(error) => {
                restore(self, consumed);
                return Err(error);
            }
        };
        let mut descriptors: Vec<(RawFd, RawFd)> = vec![(stage_end.as_raw_fd(), CHANNEL_SLOT), (gate_read.as_raw_fd(), GATE_SLOT), (env.as_raw_fd(), ENV_SLOT)];
        descriptors.extend(install_sources);
        descriptors.extend(sources);
        let null = devnull.as_raw_fd();
        let network = match (role, context.netns) {
            (Role::Orchestration, _) => Network::NewLoopback,
            (_, Some(netns)) => Network::Join(netns),
            (_, None) => {
                restore(self, consumed);
                return Err(setup());
            }
        };
        // The launch model (and its create deadline) exists before any process does.
        let model = match Launch::new(sys::now_ms(), &self.limits) {
            Ok(model) => model,
            Err(_) => {
                restore(self, consumed);
                return Err(setup());
            }
        };
        let anchor = spawn_anchor(&AnchorPlan { argv, descriptors, stdio: [null, null, null], network, keeper_pidfd });
        let anchor = match anchor {
            Ok(anchor) => anchor,
            Err(_) => {
                restore(self, consumed);
                return Err(setup());
            }
        };
        // The child holds its copies now: the keeper's construction copies close (custody), including the consumed
        // endpoint/control/provider channels, whose only remaining holders are the stage and, after exec, the domain.
        drop((stage_end, gate_read, env, runtime_temp, consumed));
        if let Some(directory) = new_streams {
            self.streams = Some(directory);
        }
        self.records.push(Rec {
            op: operation.clone(), commit_op: None, kind, role, marker, model, anchor_pid: anchor.pid, anchor_pidfd: anchor.pidfd,
            channel: Some(keeper_end), gate: Some(gate_write), exchange: Exchange::default(), bound: None, stage_identity, intended,
            intended_path: plan.executable.file.path.clone(), bwrap_identity,
            streams, connected: Vec::new(), eof: false, created_sent: false, commit_pending: false, latch: None, latch_taken: false,
            cancelled: false, reaped: None, kill_at: None, killed: false,
        });
        Ok(())
    }

    // ---- commit ------------------------------------------------------------------------------------------------

    pub fn begin_commit(&mut self, operation: &OperationId) -> Progress<Result<crate::launch::CommitState, OsError>> {
        let now = sys::now_ms();
        let Some(index) = self.records.iter().position(|rec| rec.op.handle == operation.handle && rec.created_sent && !rec.cancelled) else {
            return Progress::Ready(Err((ErrorKind::Refused, "gate_closed")));
        };
        let limits = self.limits;
        let rec = &mut self.records[index];
        let child_dead = rec.bound.as_ref().is_none_or(|bound| sys::pidfd_exited(bound.pidfd.as_raw_fd()));
        if rec.reaped.is_some() || sys::pidfd_exited(rec.anchor_pidfd.as_raw_fd()) || child_dead {
            // A1.4: gated child death before commit acceptance refuses gate_closed; no committed exit.
            return Progress::Ready(Err((ErrorKind::Refused, "gate_closed")));
        }
        let streams = rec.role == Role::Workload;
        if let Err(code) = rec.model.begin_commit(now, &limits, streams) {
            return Progress::Ready(Err((ErrorKind::Refused, code)));
        }
        rec.commit_op = Some(operation.clone());
        rec.commit_pending = true;
        if streams {
            self.connect_streams(index, now);
        } else {
            self.release_gate(index, now);
        }
        Progress::Pending
    }

    fn fail_commit(&mut self, index: usize, stream_failure: bool) {
        let rec = &mut self.records[index];
        rec.model.fail(stream_failure);
        let code = match rec.model.phase { LaunchPhase::Failed(code) => code, _ => "exec_failed" };
        rec.connected.clear();
        rec.gate = None;
        if rec.commit_pending {
            rec.commit_pending = false;
            if let Some(op) = rec.commit_op.clone() {
                self.queue.push_back(Completion::Committed { operation: op, result: Err((ErrorKind::Failure, code)) });
            }
        }
        Self::kill(&mut self.records[index]);
    }

    fn connect_streams(&mut self, index: usize, now: u64) {
        let Some(directory) = self.streams.as_ref() else { return self.fail_commit(index, true) };
        let directory_fd = directory.fd.as_raw_fd();
        let directory_identity = directory.identity;
        let rec = &mut self.records[index];
        if rec.model.phase != LaunchPhase::Connecting {
            return;
        }
        let pending: Vec<(u8, String)> = rec.streams.iter().filter(|(slot, _)| !rec.connected.iter().any(|(known, _)| known == slot)).cloned().collect();
        for (slot, leaf) in pending {
            match connect_pinned(directory_fd, directory_identity, &leaf) {
                Ok(Some(socket)) => rec.connected.push((slot, socket)),
                Ok(None) => return, // backlog full: retried by the next pump, within the commit deadline
                Err(_) => return self.fail_commit(index, true),
            }
        }
        let rec = &mut self.records[index];
        if rec.model.streams_connected(now).is_err() {
            return self.fail_commit(index, true);
        }
        let mask = rec.connected.iter().fold(0u8, |mask, (slot, _)| mask | (1 << slot));
        let count = rec.connected.len() as u8;
        let rights: Vec<RawFd> = rec.connected.iter().map(|(_, fd)| fd.as_raw_fd()).collect();
        let sent = match (Record::InstallStdio { mask, count }.encode(), rec.channel.as_ref()) {
            (Ok(bytes), Some(channel)) => sys::send_record(channel.as_raw_fd(), &bytes, &rights).is_ok(),
            _ => false,
        };
        // The keeper's copies close once transferred (or on failure): no shadow copy suppresses EOF.
        rec.connected.clear();
        if !sent || rec.exchange.accept(Record::InstallStdio { mask, count }, true).is_err() {
            self.fail_commit(index, true);
        }
    }

    fn release_gate(&mut self, index: usize, now: u64) {
        let rec = &mut self.records[index];
        if rec.model.installed(now).is_err() {
            return self.fail_commit(index, true);
        }
        let Some(gate) = rec.gate.take() else { return self.fail_commit(index, false) };
        let byte = [rw_proto::gate::COMMIT_BYTE];
        // SAFETY: one byte into an empty pipe; never blocks (nonblocking writer).
        let written = unsafe { libc::write(gate.as_raw_fd(), byte.as_ptr() as *const libc::c_void, 1) };
        drop(gate);
        if written != 1 {
            // The stage is gone: no observation can latch; the death or the deadline answers exec_failed.
            rec.eof = true;
        }
    }

    fn observe(&mut self, index: usize, now: u64) {
        let rec = &mut self.records[index];
        if rec.model.phase != LaunchPhase::Observing || rec.latch.is_some() {
            return;
        }
        let Some(bound) = rec.bound.as_ref() else { return };
        let dir = bound.procdir.as_raw_fd();
        let identity_at = |dir: RawFd| -> Option<ProcessIdentity> {
            let stat = read_stat_at(dir, "stat")?;
            let pid_ns = sys::fstatat(dir, "ns/pid", 0).ok()?.st_ino as u64;
            Some(ProcessIdentity { pid: bound.child.pid, start_time: stat.start_time, pid_ns })
        };
        let alive_before = !sys::pidfd_exited(bound.pidfd.as_raw_fd());
        let before = identity_at(dir);
        let executable = exe_identity(dir);
        let after = identity_at(dir);
        let alive_after = !sys::pidfd_exited(bound.pidfd.as_raw_fd());
        let (Some(before), Some(after)) = (before, after) else { return };
        let observation = Observation { before, after, alive_before, alive_after, executable };
        // The model's own clock check uses the same CLOCK_MONOTONIC as the core's deadline.
        rec.model.observe(observation, now);
        if rec.model.phase == LaunchPhase::Executed {
            rec.latch = rec.model.commit_latch();
            if rec.commit_pending {
                rec.commit_pending = false;
                if let (Some(op), Some(latch)) = (rec.commit_op.clone(), rec.latch) {
                    self.queue.push_back(Completion::Committed { operation: op, result: Ok(latch) });
                }
            }
        }
    }

    // ---- READY binding -----------------------------------------------------------------------------------------

    fn bind_ready(rec: &mut Rec, credentials: Credentials) -> Result<Created, &'static str> {
        let pid = credentials.pid as libc::pid_t;
        if pid <= 0 || pid == rec.anchor_pid {
            return Err("setup_failed");
        }
        let anchor_stat = proc_stat(rec.anchor_pid).ok_or("setup_failed")?;
        let anchor_ns = pid_namespace(rec.anchor_pid).ok_or("setup_failed")?;
        let anchor = ProcessIdentity { pid: rec.anchor_pid as i64, start_time: anchor_stat.start_time, pid_ns: anchor_ns };
        // The anchor must be the unchanged image Bubblewrap (A1.1), still alive.
        let anchor_exe = sys::fstatat(libc::AT_FDCWD, &format!("/proc/{}/exe", rec.anchor_pid), 0).map(|stat| sys::identity(&stat)).ok();
        if anchor_exe != Some(rec.bwrap_identity) || sys::pidfd_exited(rec.anchor_pidfd.as_raw_fd()) {
            return Err("setup_failed");
        }
        let before_stat = proc_stat(pid).ok_or("setup_failed")?;
        let child_ns = pid_namespace(pid).ok_or("setup_failed")?;
        // Open the held references while the stage is blocked at its gate, then re-read through them.
        let pidfd = sys::pidfd_open(pid).map_err(|_| "setup_failed")?;
        let procdir = sys::openat_readable(libc::AT_FDCWD, &format!("/proc/{pid}"), true).map_err(|_| "setup_failed")?;
        let alive_before = !sys::pidfd_exited(pidfd.as_raw_fd());
        let after_stat = read_stat_at(procdir.as_raw_fd(), "stat").ok_or("setup_failed")?;
        let after_ns = sys::fstatat(procdir.as_raw_fd(), "ns/pid", 0).map(|stat| stat.st_ino as u64).map_err(|_| "setup_failed")?;
        let cmdline = sys::read_proc_file(procdir.as_raw_fd(), "cmdline", 256 * 1024).map_err(|_| "setup_failed")?;
        let executable = exe_identity(procdir.as_raw_fd());
        let alive_after = !sys::pidfd_exited(pidfd.as_raw_fd());
        let before = ProcessIdentity { pid: pid as i64, start_time: before_stat.start_time, pid_ns: child_ns };
        let after = ProcessIdentity { pid: pid as i64, start_time: after_stat.start_time, pid_ns: after_ns };
        let facts = ReadyFacts {
            sender: credentials, before, after,
            // A2.2: exactly a direct child of the committed anchor (no arbitrary descendant).
            descendant_of_anchor: before_stat.ppid == rec.anchor_pid as i64 && after_stat.ppid == rec.anchor_pid as i64,
            alive_before, alive_after, held_pidfd: true, held_proc_directory: true,
            marker: if has_marker(&cmdline, &rec.marker) { rec.marker.clone() } else { String::new() },
            executable,
        };
        let binding = ChildBinding::bind(anchor, &rec.marker, rec.stage_identity, rec.intended, &facts)?;
        rec.model.ready(binding, sys::now_ms())?;
        rec.bound = Some(Bound { child: binding.child, credentials, pidfd, procdir });
        Ok(Created { identity: WireIdentity::Process { pid: anchor.pid, start_time: anchor.start_time, pid_ns: anchor.pid_ns }, pid: Some(anchor.pid) })
    }

    fn handle_packet(&mut self, index: usize, packet: crate::launch::Packet, now: u64) {
        let workload = self.records[index].role == Role::Workload;
        let rec = &mut self.records[index];
        let expected = match rec.bound.as_ref() {
            Some(bound) => Some(bound.credentials),
            None => packet.credentials,
        };
        let Some(sender) = expected else { return self.protocol_failure(index) };
        let record = match receive(packet, true, sender) {
            Ok((record, _)) => record,
            Err(_) => return self.protocol_failure(index),
        };
        if rec.exchange.accept(record, workload).is_err() {
            return self.protocol_failure(index);
        }
        match record {
            Record::Ready => {
                if rec.created_sent || rec.cancelled {
                    return;
                }
                let result = Self::bind_ready(rec, sender);
                rec.created_sent = true;
                match result {
                    Ok(created) => self.queue.push_back(Completion::Created { operation: rec.op.clone(), result: Ok(created) }),
                    Err(_) => {
                        self.queue.push_back(Completion::Created { operation: rec.op.clone(), result: Err(setup()) });
                        Self::kill(rec);
                    }
                }
            }
            Record::Installed => self.release_gate(index, now),
            Record::Fail { step, .. } => {
                if !rec.created_sent {
                    rec.created_sent = true;
                    self.queue.push_back(Completion::Created { operation: rec.op.clone(), result: Err(setup()) });
                    Self::kill(rec);
                } else if rec.model.committed {
                    self.fail_commit(index, step == crate::linux::stage_exec::STEP_INSTALL);
                } else {
                    Self::kill(rec);
                }
            }
            Record::InstallStdio { .. } => self.protocol_failure(index),
        }
    }

    fn protocol_failure(&mut self, index: usize) {
        let rec = &mut self.records[index];
        if !rec.created_sent {
            rec.created_sent = true;
            self.queue.push_back(Completion::Created { operation: rec.op.clone(), result: Err(setup()) });
            Self::kill(rec);
        } else if rec.model.committed {
            let stream = matches!(rec.model.phase, LaunchPhase::Connecting | LaunchPhase::Installing);
            self.fail_commit(index, stream);
        } else {
            Self::kill(rec);
        }
    }

    fn kill(rec: &mut Rec) {
        rec.gate = None;
        rec.connected.clear();
        if rec.reaped.is_none() {
            let _ = sys::pidfd_signal(rec.anchor_pidfd.as_raw_fd(), libc::SIGKILL);
        }
        rec.killed = true;
    }

    // ---- event pump --------------------------------------------------------------------------------------------

    /// Nonblocking: drains private channels, retries stream connections, observes, reaps anchors through their
    /// pidfds and applies stop escalations. Queues completions in causal order.
    pub fn pump(&mut self, now: u64) {
        let mut index = 0;
        while index < self.records.len() {
            // 1. Private records.
            loop {
                let Some(channel) = self.records[index].channel.as_ref().map(|channel| channel.as_raw_fd()) else { break };
                match sys::recv_packet(channel, true) {
                    Ok(Received::Packet(packet)) => self.handle_packet(index, packet, now),
                    Ok(Received::WouldBlock) => break,
                    Ok(Received::Eof) | Err(_) => {
                        let rec = &mut self.records[index];
                        rec.eof = true;
                        rec.channel = None;
                        break;
                    }
                }
            }
            // 2. Progress: connection retries and observation (an EOF after release is only a cue, never proof).
            match self.records[index].model.phase {
                LaunchPhase::Connecting if self.records[index].commit_pending => self.connect_streams(index, now),
                LaunchPhase::Observing => self.observe(index, now),
                _ => {}
            }
            // 3. Stop escalation.
            let rec = &mut self.records[index];
            if rec.kill_at.is_some_and(|at| now >= at) && !rec.killed {
                Self::kill(rec);
            }
            // 4. Reap through the pidfd.
            if rec.reaped.is_none() {
                rec.reaped = sys::pidfd_reap(rec.anchor_pidfd.as_raw_fd());
            }
            if rec.reaped.is_some() && self.settle(index) {
                self.records.remove(index);
                continue;
            }
            index += 1;
        }
    }

    /// The anchor was reaped: queue what the core is owed, in order. Returns true when the record can go.
    fn settle(&mut self, index: usize) -> bool {
        let rec = &mut self.records[index];
        let Some(status) = rec.reaped else { return false };
        if rec.cancelled {
            return true;
        }
        if !rec.created_sent {
            rec.created_sent = true;
            self.queue.push_back(Completion::Created { operation: rec.op.clone(), result: Err(setup()) });
            return true;
        }
        if rec.commit_pending {
            // No positive observation was latched before the death: conservative exec_failed (or the stream phase
            // failure), with committed ownership and the owed exit after the reply.
            rec.commit_pending = false;
            rec.model.stage_died();
            let code = match rec.model.phase { LaunchPhase::Failed(code) => code, _ => "exec_failed" };
            eprintln!("keeper: {} ended without a positively observed {} ({code})", rec.op.handle, rec.intended_path);
            if let Some(op) = rec.commit_op.clone() {
                self.queue.push_back(Completion::Committed { operation: op, result: Err((ErrorKind::Failure, code)) });
            }
        }
        let (code, signal) = match status {
            Reaped::Exited(code) => (Some(code), None),
            Reaped::Signaled(number) => (None, Some(crate::linux::runloop::signal_name(number))),
        };
        self.queue.push_back(Completion::Exited { owner: rec.op.clone(), pid: rec.anchor_pid as i64, code, signal });
        true
    }

    pub fn poll_completion(&mut self, now: u64) -> Option<Completion> {
        if self.queue.is_empty() {
            self.pump(now);
        }
        self.queue.pop_front()
    }

    pub fn take_commit_latch(&mut self, operation: &OperationId) -> Option<CommitLatch> {
        let rec = self.records.iter_mut().find(|rec| rec.commit_op.as_ref() == Some(operation))?;
        if rec.latch_taken {
            return None;
        }
        let latch = rec.latch?;
        rec.latch_taken = true;
        Some(latch)
    }

    pub fn cancel_launch(&mut self, operation: &OperationId, committed: bool) {
        for rec in &mut self.records {
            if committed && rec.commit_op.as_ref() == Some(operation) {
                // The core answers the commit now; no later Committed for it. The anchor's exit is still owed.
                rec.commit_pending = false;
                rec.latch_taken = true;
            } else if !committed && &rec.op == operation {
                rec.cancelled = true;
                rec.channel = None;
                Self::kill(rec);
            }
        }
    }

    pub fn discard_created(&mut self, operation: &OperationId) {
        for rec in &mut self.records {
            if &rec.op == operation {
                rec.cancelled = true;
                rec.channel = None;
                Self::kill(rec);
            }
        }
    }

    pub fn commit_failure_code(&self, operation: &OperationId) -> &'static str {
        match self.records.iter().find(|rec| rec.commit_op.as_ref() == Some(operation)).map(|rec| rec.model.phase) {
            Some(LaunchPhase::Connecting | LaunchPhase::Installing) => "stream_connect_failed",
            _ => "exec_failed",
        }
    }

    /// Abandons uncommitted creations: gate EOF first (the stage aborts before any final exec), then SIGKILL by pidfd.
    pub fn abort(&mut self, handles: &[String]) {
        for rec in &mut self.records {
            if handles.contains(&rec.op.handle) && !rec.model.committed {
                rec.cancelled = true;
                rec.channel = None;
                Self::kill(rec);
            }
        }
    }

    /// SIGTERM to the anchor now (and to the bound child, whose image is the workload); SIGKILL of the anchor at the
    /// earliest requested deadline.
    pub fn stop(&mut self, handle: &str, grace_ms: i64) {
        let now = sys::now_ms();
        for rec in &mut self.records {
            if rec.op.handle == handle && rec.reaped.is_none() {
                let _ = sys::pidfd_signal(rec.anchor_pidfd.as_raw_fd(), libc::SIGTERM);
                if let Some(bound) = rec.bound.as_ref() {
                    let _ = sys::pidfd_signal(bound.pidfd.as_raw_fd(), libc::SIGTERM);
                }
                let at = now.saturating_add(grace_ms.max(0) as u64);
                rec.kill_at = Some(rec.kill_at.map_or(at, |known| known.min(at)));
            }
        }
    }

    pub fn kill_stage(&mut self, handle: &str) {
        for rec in &mut self.records {
            if rec.op.handle == handle {
                Self::kill(rec);
            }
        }
    }

    /// End steps and shutdown: process trees or the endpoint die through their held pidfds.
    pub fn kill_kind(&mut self, endpoint: bool) {
        for rec in &mut self.records {
            if (rec.kind == CreateKind::Endpoint) == endpoint {
                Self::kill(rec);
            }
        }
    }

    pub fn owns_child(&self, pid: libc::pid_t) -> bool {
        self.records.iter().any(|rec| rec.anchor_pid == pid && rec.reaped.is_none())
    }

    pub fn reap_owned(&mut self) {
        for rec in &mut self.records {
            if rec.reaped.is_none() {
                rec.reaped = sys::pidfd_reap(rec.anchor_pidfd.as_raw_fd());
            }
        }
    }

    pub fn live_anchors(&self) -> usize {
        self.records.iter().filter(|rec| rec.reaped.is_none()).count()
    }

    pub fn poll_fds(&self) -> Vec<RawFd> {
        let mut fds = Vec::new();
        for rec in &self.records {
            if let Some(channel) = &rec.channel {
                fds.push(channel.as_raw_fd());
            }
            if rec.reaped.is_none() {
                fds.push(rec.anchor_pidfd.as_raw_fd());
            }
        }
        fds
    }

    pub fn next_wakeup(&self, now: u64) -> Option<u64> {
        let retry = self.records.iter().any(|rec| matches!(rec.model.phase, LaunchPhase::Connecting | LaunchPhase::Observing) && rec.commit_pending);
        let kills = self.records.iter().filter(|rec| !rec.killed).filter_map(|rec| rec.kill_at);
        kills.chain(retry.then_some(now + RETRY_MS)).chain((!self.queue.is_empty()).then_some(now)).min()
    }
}

/// Connects to the socket named `leaf` inside the held directory through the pinned inode (A1.4): `O_PATH|O_NOFOLLOW`
/// open, socket type check, then `connect` to `/proc/self/fd/<n>`. A replaced or symlinked leaf cannot redirect it.
/// `Ok(None)`: the listener's backlog is full (retry).
pub fn connect_pinned(directory: RawFd, directory_identity: (u64, u64), leaf: &str) -> Result<Option<OwnedFd>, &'static str> {
    if sys::fstat(directory).map(|stat| sys::identity(&stat)).ok() != Some(directory_identity) {
        return Err("stream_connect_failed");
    }
    let name = sys::cstr(leaf).map_err(|_| "stream_connect_failed")?;
    // SAFETY: valid descriptor and C string; O_PATH|O_NOFOLLOW opens the entry itself, a symlink included.
    let pin = unsafe { libc::openat(directory, name.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if pin < 0 {
        return Err("stream_connect_failed");
    }
    // SAFETY: fresh descriptor.
    let pin = unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(pin) };
    let stat = sys::fstat(pin.as_raw_fd()).map_err(|_| "stream_connect_failed")?;
    let pinned = sys::identity(&stat);
    let is_socket = stat.st_mode & libc::S_IFMT == libc::S_IFSOCK;
    // SAFETY: plain socket creation.
    let socket = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK, 0) };
    if socket < 0 {
        return Err("stream_connect_failed");
    }
    // SAFETY: fresh descriptor.
    let socket = unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(socket) };
    if !is_socket {
        PinnedSocketFacts { directory: directory_identity, socket: pinned, no_follow_socket: false, connected_through_pin: false, connected_socket: (0, 0) }
            .validate(directory_identity)?;
    }
    let path = format!("/proc/self/fd/{}", pin.as_raw_fd());
    // SAFETY: zeroed sockaddr_un, then a path well inside sun_path.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(path.bytes()) {
        *slot = byte as libc::c_char;
    }
    let length = (std::mem::size_of::<libc::sa_family_t>() + path.len() + 1) as libc::socklen_t;
    // SAFETY: a valid sockaddr_un of the stated length.
    let result = unsafe { libc::connect(socket.as_raw_fd(), &address as *const libc::sockaddr_un as *const libc::sockaddr, length) };
    if result < 0 {
        return match sys::errno() {
            libc::EAGAIN => Ok(None),
            _ => Err("stream_connect_failed"),
        };
    }
    let after = sys::fstat(pin.as_raw_fd()).map(|stat| sys::identity(&stat)).map_err(|_| "stream_connect_failed")?;
    PinnedSocketFacts { directory: directory_identity, socket: pinned, no_follow_socket: is_socket, connected_through_pin: true, connected_socket: after }
        .validate(directory_identity)?;
    // The workload receives a blocking socket (O_NONBLOCK belongs to the shared open file description).
    sys::set_nonblocking(socket.as_raw_fd(), false).map_err(|_| "stream_connect_failed")?;
    Ok(Some(socket))
}

/// The DS006 start request as a domain request (first checkpoint: no grants, exclusions or egress; private /proc).
fn workload_request(request: &Value) -> Option<DomainRequest> {
    let strings = |key: &str| -> Option<Vec<String>> {
        match request.get(key)? {
            Value::Array(items) => items.iter().map(|item| item.as_str().map(str::to_string)).collect(),
            _ => None,
        }
    };
    let environment: Vec<(String, String)> = request.get("env")?.as_object()?.iter().map(|(name, value)| value.as_str().map(|text| (name.clone(), text.to_string()))).collect::<Option<_>>()?;
    let count = |key: &str| match request.get(key) { Some(Value::Array(items)) => Some(items.len()), _ => None };
    Some(DomainRequest {
        role: Role::Workload,
        executable: request.get("executable")?.as_str()?.to_string(),
        script: None,
        args: strings("args")?,
        environment,
        cwd: request.get("cwd")?.as_str()?.to_string(),
        grants: count("folders")?,
        exclusions: count("exclusions")?,
        egress: request.get("network").and_then(Value::as_str) != Some("none"),
        private_proc: request.get("requirements").and_then(|requirements| requirements.get("privateProc")).and_then(Value::as_bool) == Some(true),
        committed_netns: true,
        committed_pty: false,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn pinned_connection_reaches_only_the_opened_socket_inode() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        let base = std::env::temp_dir().join(format!("rw-keeper-pin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let listener = UnixListener::bind(base.join("s1")).unwrap();
        let decoy = UnixListener::bind(base.join("decoy")).unwrap();
        std::os::unix::fs::symlink(base.join("decoy"), base.join("link")).unwrap();
        std::fs::write(base.join("plain"), b"x").unwrap();
        let dir = sys::open_nofollow(libc::AT_FDCWD, base.to_str().unwrap(), true).unwrap();
        let identity = sys::identity(&sys::fstat(dir.as_raw_fd()).unwrap());
        let socket = connect_pinned(dir.as_raw_fd(), identity, "s1").unwrap().unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        let mut stream = std::os::unix::net::UnixStream::from(socket);
        stream.write_all(b"ping").unwrap();
        let mut buffer = [0u8; 4];
        accepted.read_exact(&mut buffer).unwrap();
        assert_eq!(&buffer, b"ping");
        for bad in ["link", "plain", "missing", "../s1"] {
            assert!(connect_pinned(dir.as_raw_fd(), identity, bad).is_err(), "{bad}");
        }
        assert!(connect_pinned(dir.as_raw_fd(), (identity.0, identity.1 + 1), "s1").is_err(), "a replaced directory refuses");
        decoy.set_nonblocking(true).unwrap();
        assert!(decoy.accept().is_err(), "the decoy behind the symlink was never connected");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn pinned_connection_survives_a_replacement_after_the_pin() {
        // Replacement race: once the leaf is pinned, renaming another socket over the name cannot redirect it. Exercised
        // by pinning, replacing, then connecting through the same O_PATH descriptor (the function's own sequence).
        use std::os::unix::net::UnixListener;
        let base = std::env::temp_dir().join(format!("rw-keeper-pin2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let original = UnixListener::bind(base.join("s")).unwrap();
        let pin = sys::open_nofollow(libc::AT_FDCWD, base.join("s").to_str().unwrap(), false);
        // open_nofollow uses O_PATH; a socket can be opened that way.
        let pin = pin.unwrap();
        let replacement = UnixListener::bind(base.join("r")).unwrap();
        std::fs::rename(base.join("r"), base.join("s")).unwrap();
        let socket = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
        let path = format!("/proc/self/fd/{}", pin.as_raw_fd());
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (slot, byte) in address.sun_path.iter_mut().zip(path.bytes()) {
            *slot = byte as libc::c_char;
        }
        let length = (std::mem::size_of::<libc::sa_family_t>() + path.len() + 1) as libc::socklen_t;
        let result = unsafe { libc::connect(socket, &address as *const libc::sockaddr_un as *const libc::sockaddr, length) };
        // The original listener's inode was unlinked by the rename; its bound socket is still reachable through the pin.
        assert_eq!(result, 0, "connect through the pinned inode: {}", std::io::Error::last_os_error());
        original.set_nonblocking(true).unwrap();
        replacement.set_nonblocking(true).unwrap();
        assert!(original.accept().is_ok(), "the pinned original received the connection");
        assert!(replacement.accept().is_err(), "the replacement never did");
        unsafe { libc::close(socket) };
        std::fs::remove_dir_all(&base).unwrap();
    }

    // ---- observation seam with real children (A1 adversarial observer mutants) ----------------------------------

    /// A child that shares the test process's descriptor table (CLONE_FILES): parallel tests assert EOF on their own
    /// sockets, so a test child must never hold copies of them, not even briefly after a fork.
    pub(crate) fn test_child() -> libc::pid_t {
        // SAFETY: fork-like clone (own memory copy, shared descriptor table); the child only pauses or execs.
        unsafe { libc::syscall(libc::SYS_clone, (libc::CLONE_FILES | libc::SIGCHLD) as libc::c_ulong, 0usize, 0usize, 0usize, 0usize) as libc::pid_t }
    }

    fn fork_paused() -> (libc::pid_t, OwnedFd) {
        let pid = test_child();
        if pid == 0 {
            loop {
                unsafe { libc::pause() };
            }
        }
        (pid, sys::pidfd_open(pid).unwrap())
    }

    /// A child that execs `program` with `argv` (argv[0] free), then stays alive while it runs.
    fn fork_exec(program: &str, argv: &[&str]) -> (libc::pid_t, OwnedFd) {
        let program = CString::new(program).unwrap();
        let argv: Vec<CString> = argv.iter().map(|arg| CString::new(*arg).unwrap()).collect();
        let mut pointers: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        let envp: [*const libc::c_char; 1] = [std::ptr::null()];
        // execve unshares the descriptor table and closes every CLOEXEC descriptor in the same call.
        let pid = test_child();
        if pid == 0 {
            unsafe {
                libc::execve(program.as_ptr(), pointers.as_ptr(), envp.as_ptr());
                libc::_exit(127);
            }
        }
        let pidfd = sys::pidfd_open(pid).unwrap();
        // Wait until the exec happened (exe changes away from the test binary).
        let own = sys::fstatat(libc::AT_FDCWD, "/proc/self/exe", 0).map(|stat| sys::identity(&stat)).unwrap();
        for _ in 0..500 {
            if sys::fstatat(libc::AT_FDCWD, &format!("/proc/{pid}/exe"), 0).map(|stat| sys::identity(&stat)).is_ok_and(|exe| exe != own) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        (pid, pidfd)
    }

    fn identity_of_path(path: &str) -> (u64, u64) {
        sys::identity(&sys::fstatat(libc::AT_FDCWD, path, 0).unwrap())
    }

    fn reap_all(pidfds: &[&OwnedFd]) {
        for pidfd in pidfds {
            let _ = sys::pidfd_signal(pidfd.as_raw_fd(), libc::SIGKILL);
            // Bounded: a child already reaped elsewhere never reports again.
            for _ in 0..500 {
                if sys::pidfd_reap(pidfd.as_raw_fd()).is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
    }

    /// A launcher holding one record already in Observing: the gate was released and the stage channel is at EOF.
    /// `child` is the bound exec child; `intended`/`intended_path` name the pinned image; the anchor is separate.
    fn observing(anchor: (libc::pid_t, OwnedFd), child: (libc::pid_t, &OwnedFd), intended: (u64, u64), intended_path: &str) -> Launcher {
        let marker = "AAECAwQFBgcICQoLDA0ODw";
        let stage = identity_of_path("/proc/self/exe");
        let now = sys::now_ms();
        // Every test child shares the test's PID namespace (a zombie no longer exposes its ns links).
        // SAFETY: getpid has no preconditions.
        let own_ns = pid_namespace(unsafe { libc::getpid() }).unwrap();
        let pid_ns = |_pid: libc::pid_t| own_ns;
        let start = |pid: libc::pid_t| proc_stat(pid).unwrap().start_time;
        let anchor_identity = ProcessIdentity { pid: anchor.0 as i64, start_time: start(anchor.0), pid_ns: pid_ns(anchor.0) };
        let child_identity = ProcessIdentity { pid: child.0 as i64, start_time: start(child.0), pid_ns: pid_ns(child.0) };
        let credentials = Credentials { pid: child.0 as i64, uid: 0, gid: 0 };
        // Model facts for the READY binding (the kernel-side READY checks are exercised by the Linux vehicle).
        let facts = ReadyFacts { sender: credentials, before: child_identity, after: child_identity, descendant_of_anchor: true, alive_before: true,
            alive_after: true, held_pidfd: true, held_proc_directory: true, marker: marker.into(), executable: Some(stage) };
        let binding = ChildBinding::bind(anchor_identity, marker, stage, intended, &facts).unwrap();
        let limits = KeeperLimits::default();
        let mut model = Launch::new(now, &limits).unwrap();
        model.ready(binding, now).unwrap();
        model.begin_commit(now, &limits, false).unwrap();
        model.installed(now).unwrap();
        let (keeper_end, stage_end) = sys::socketpair(libc::SOCK_SEQPACKET).unwrap();
        drop(stage_end);
        let procdir = sys::openat_readable(libc::AT_FDCWD, &format!("/proc/{}", child.0), true).unwrap();
        let operation = OperationId { handle: "00".repeat(16), request_id: 7 };
        let mut launcher = Launcher::new(limits);
        launcher.records.push(Rec {
            op: operation.clone(), commit_op: Some(OperationId { request_id: 9, ..operation }), kind: CreateKind::ProcessTree, role: Role::Workload,
            marker: marker.into(), model, anchor_pid: anchor.0, anchor_pidfd: anchor.1, channel: Some(keeper_end), gate: None, exchange: Exchange::default(),
            bound: Some(Bound { child: child_identity, credentials, pidfd: sys::dup_cloexec(child.1.as_raw_fd()).unwrap(), procdir }),
            stage_identity: stage, intended, intended_path: intended_path.into(), bwrap_identity: (0, 0), streams: Vec::new(), connected: Vec::new(),
            eof: false, created_sent: true, commit_pending: true, latch: None, latch_taken: false, cancelled: false, reaped: None, kill_at: None, killed: false,
        });
        launcher
    }

    fn committed(launcher: &mut Launcher) -> Vec<Result<CommitLatch, OsError>> {
        launcher.queue.iter().filter_map(|completion| match completion { Completion::Committed { result, .. } => Some(*result), _ => None }).collect()
    }

    const IMAGE: &str = "/bin/busybox";

    #[test]
    fn observation_latches_only_the_bound_childs_intended_image() {
        // The bound child really runs the intended image; the anchor runs another one (the test binary). Reading the
        // anchor instead of the bound child cannot latch.
        let anchor = fork_paused();
        let anchor_pidfd = sys::dup_cloexec(anchor.1.as_raw_fd()).unwrap();
        let child = fork_exec(IMAGE, &["sleep", "30"]);
        let mut launcher = observing(anchor, (child.0, &child.1), identity_of_path(IMAGE), IMAGE);
        launcher.pump(sys::now_ms());
        let results = committed(&mut launcher);
        assert_eq!(results.len(), 1, "one positive completion");
        assert!(matches!(results[0], Ok(CommitLatch { state: crate::launch::CommitState::Executed, .. })));
        reap_all(&[&anchor_pidfd, &child.1]);
    }

    #[test]
    fn eof_without_the_intended_image_never_latches() {
        // The stage channel is at EOF (as after any exec or death) but the bound child runs a different image.
        let anchor = fork_paused();
        let anchor_pidfd = sys::dup_cloexec(anchor.1.as_raw_fd()).unwrap();
        let child = fork_exec(IMAGE, &["sleep", "30"]);
        let unrelated = std::env::temp_dir().join(format!("rw-keeper-intended-{}", std::process::id()));
        std::fs::write(&unrelated, b"\x7fELF-not-running").unwrap();
        let mut launcher = observing(anchor, (child.0, &child.1), identity_of_path(unrelated.to_str().unwrap()), unrelated.to_str().unwrap());
        for _ in 0..5 {
            launcher.pump(sys::now_ms());
        }
        assert!(launcher.records[0].eof, "the channel EOF was seen");
        assert!(committed(&mut launcher).is_empty(), "EOF is a cue, never proof");
        reap_all(&[&anchor_pidfd, &child.1]);
        std::fs::remove_file(unrelated).unwrap();
    }

    #[test]
    fn a_matching_command_line_with_another_executable_never_latches() {
        // argv[0] of the bound child equals the intended path string, but its exe is a different file.
        let anchor = fork_paused();
        let anchor_pidfd = sys::dup_cloexec(anchor.1.as_raw_fd()).unwrap();
        let child = fork_exec(IMAGE, &["sleep", "30"]);
        let decoy = std::env::temp_dir().join(format!("rw-keeper-decoy-{}", std::process::id()));
        std::fs::write(&decoy, b"\x7fELF-decoy").unwrap();
        // The path the child's command line names ("sleep") is registered as the intended path; identity differs.
        let mut launcher = observing(anchor, (child.0, &child.1), identity_of_path(decoy.to_str().unwrap()), "sleep");
        for _ in 0..5 {
            launcher.pump(sys::now_ms());
        }
        assert!(committed(&mut launcher).is_empty(), "a command-line or pathname match is never an observation");
        reap_all(&[&anchor_pidfd, &child.1]);
        std::fs::remove_file(decoy).unwrap();
    }

    #[test]
    fn a_program_that_exits_before_observation_is_exec_failed_and_its_exit_follows() {
        // Deliberately missed rapid exec: the bound child is gone before the first observation; the anchor then dies.
        let anchor = fork_paused();
        let anchor_pidfd = sys::dup_cloexec(anchor.1.as_raw_fd()).unwrap();
        let child = fork_exec(IMAGE, &["true"]);
        for _ in 0..500 {
            if sys::pidfd_exited(child.1.as_raw_fd()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // Identity reads must happen while the child is still a zombie; observing() needs them, so reap afterwards.
        let mut launcher = observing(anchor, (child.0, &child.1), identity_of_path(IMAGE), IMAGE);
        launcher.pump(sys::now_ms());
        assert!(committed(&mut launcher).is_empty(), "no latch for a program that already exited");
        let _ = sys::pidfd_signal(anchor_pidfd.as_raw_fd(), libc::SIGKILL);
        for _ in 0..500 {
            launcher.pump(sys::now_ms());
            if !launcher.queue.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let kinds: Vec<&'static str> = launcher.queue.iter().map(|completion| match completion {
            Completion::Committed { result: Err((_, code)), .. } => code,
            Completion::Committed { result: Ok(_), .. } => "executed",
            Completion::Exited { .. } => "exit",
            Completion::Created { .. } => "created",
        }).collect();
        assert_eq!(kinds, vec!["exec_failed", "exit"], "conservative failure, then exactly one anchor exit");
        reap_all(&[&child.1]);
    }

    #[test]
    fn workload_requests_map_every_unenforced_property_for_refusal() {
        let request = rw_proto::json::parse(br#"{"processClass":"run","executable":"sleep","args":["30"],"env":{"A":"1"},"home":"/home/robot","cwd":"/home/robot","folders":[],"exclusions":[],"communication":{"kind":"streams","stdin":"ignore"},"lifecycle":{"stopGraceMs":2000},"network":"none","requirements":{"privateProc":true}}"#).unwrap();
        let mapped = workload_request(&request).unwrap();
        assert_eq!((mapped.executable.as_str(), mapped.args.clone(), mapped.grants, mapped.exclusions, mapped.egress, mapped.private_proc), ("sleep", vec!["30".to_string()], 0, 0, false, true));
        let egress = rw_proto::json::parse(&String::from_utf8(stringify(&request).into_bytes()).unwrap().replace(r#""network":"none""#, r#""network":"robot-egress""#).into_bytes()).unwrap();
        assert!(workload_request(&egress).unwrap().egress);
        assert!(has_marker(b"/usr/bin/bwrap\0stage\0--reservation\0AAECAwQFBgcICQoLDA0ODw\0", "AAECAwQFBgcICQoLDA0ODw"));
        assert!(!has_marker(b"stage\0--reservation=AAECAwQFBgcICQoLDA0ODw\0", "AAECAwQFBgcICQoLDA0ODw"));
    }
}

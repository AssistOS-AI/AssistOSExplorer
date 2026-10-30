//! The keeper supervisor (Linux, slice P8): one `keeper serve` child per execution, driven over the v1 keeper wire
//! protocol (`rw_proto::keeper_frames`, frame codec `rw_proto::frame`), behind the journal's [`Hooks`].
//!
//! # Per execution
//!
//! | Journal effect | Keeper sequence |
//! |---|---|
//! | `create` (prepare) | durable attempt record, spawn (`--ala 1`, descriptor layout 0-2, 3 channel, 4 endpoint, 5-7 control, 8 HOME; empty environment), `hello`, `commit_keeper`, `runtime-dir` and `netns` create+commit, `endpoint` create+commit, stdout/stderr listeners in the endpoint stream directory, gated `process-tree` workload create |
//! | `release_gate` (commit) | keeper `commit` of the workload: `executed`, or `exec_failed` (the gate was released; the exit follows) |
//! | `stop` | keeper `stop` (committed) or `abort_uncommitted` (gated), `end_process_trees`, `end_endpoint`, `shutdown`, keeper reaped through its pidfd (SIGKILL through the pidfd after a bounded wait), then every recorded identity verified absent |
//! | `release` | the execution's keeper is reaped and every recorded identity is verified absent; the execution directory is removed |
//!
//! Workload exit (the keeper's one `exit` event) and keeper loss (pidfd readable or channel EOF/violation) are reported by
//! [`KeeperLauncher::take_ended`]; the service journals them (`observe_exit`, or `stop` then `observe_exit`).
//!
//! # Never two keepers for one key
//!
//! Before it spawns, `create` durably writes an attempt record `<journal root>/journal/keepers/<sha256(keyText)>.json`
//! (temporary file, fsync, `link(2)` so an existing record is never replaced, directory fsync). The attempt store is
//! created with the journal store and witnessed by it (`keepers/witness.json` equals `journal-store.json`); a missing or
//! foreign store refuses every effect (`outcome_unknown`). A later `create` for a key that has an attempt record never
//! spawns, and neither does the retry of a `reserved` record (its first create may have spawned): both return the live
//! execution's identities or fail. Before each process-bearing create (the keeper spawn, the endpoint, the workload
//! anchor) the role is persisted as `requested`, and its identity (pid, start time, PID namespace) once the create
//! answered; a `refused` answer (nothing created) withdraws the role. The record also names the spawning helper process,
//! its incarnation, the kernel boot ID and the helper's cgroup and host name, so a later runtime attestation of the exact
//! old instance can be matched against it.
//!
//! # Stop delivered versus absence verified
//!
//! `stop` (the journal's `Hooks::stop`) delivers the stop; `KeeperLauncher::absence_verified` says whether every process
//! of the execution is verifiably gone. Only verified absence lets the service journal `exited` or release resources;
//! otherwise the record rests in `stopping` and `release` refuses `absence_unverified` (journal quarantine stays the
//! operator path).
//!
//! | Execution | Stop | Absence verified when |
//! |---|---|---|
//! | Tracked in this helper process (also after a failed setup) | stop/abort, end steps, shutdown, reap through the pidfd | the keeper is reaped, every requested role has a recorded identity, and each recorded identity (keeper, endpoint, workload anchor) is gone |
//! | An attempt of this boot and this PID namespace (this or an earlier helper process) | survivors with the exact recorded start time are killed through a pidfd | every requested role has a recorded identity and each is gone |
//! | An attempt of another boot (`/proc/sys/kernel/random/boot_id` differs) | nothing to deliver | always (a reboot ended every process) |
//! | An attempt of another PID namespace in this boot (a replaced container whose namespace inode was reused takes the row above: reuse implies the old namespace was destroyed), or a PID namespace or boot unknown on either side | nothing can be delivered locally | never locally (a future Router/Ploinky attestation of the exact old instance) |
//! | No attempt record for the key (it may have spawned), or an unverifiable attempt store | recorded as delivered (`stopping`, which blocks any later create) | never |
//!
//! "Gone" is decided by [`identity_liveness`]: `ENOENT`/`ESRCH`, a zombie or dead process, or another start time on a
//! successful read. Any other `/proc` error, an unparsable line, or an empty or non-numeric recorded start time is
//! `Unknown`, which never counts as gone and is never signalled. A new prepare is refused `keeper_unavailable` before
//! the journal write when the attempt store is unverifiable or the runtime base unusable. An end (workload exit or
//! keeper loss) is reported to the service only after its absence is verified; a failed verification is retried. A
//! quarantined execution keeps its descriptors until the helper restarts.
//!
//! Workload HOME is an execution-private directory under the runtime base (slice P9 replaces it with the imported robot
//! HOME). Workload output goes to a bounded per-execution file (the first [`OUTPUT_LOG_BYTES`]); more than
//! [`OUTPUT_LIMIT_BYTES`] ends the execution (`outputBytesPerExecution`).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rw_proto::frame::{DecodeEvent, FrameDecoder, encode_frame};
use rw_proto::json::{self as pj, Value as J};

use crate::Code;
use crate::canon::{self, Value, obj, s};
use crate::crypto::{b64url_encode, sha256, sha256_hex};
use crate::journal::{HookFailure, Hooks, ResourceSpec};
use crate::keeper::{EndKind, Ended, KeeperLauncher};
use crate::workload::{STOP_GRACE_MS, Workload, check_resource_kinds, parse_workload};

/// The keeper the rwtarget image carries at the keeper domain policy's fixed path.
pub const KEEPER_PATH: &str = "/usr/local/libexec/robo-work/keeper";
/// Per-container runtime base (short: stream socket paths must fit `sun_path`).
pub const RUNTIME_BASE: &str = "/tmp/rwk";
/// `executionsPerTarget`.
pub const EXECUTIONS_PER_TARGET: usize = 8;
pub const OUTPUT_LOG_BYTES: u64 = 1024 * 1024;
/// `outputBytesPerExecution`.
pub const OUTPUT_LIMIT_BYTES: u64 = 67_108_864;
pub const HELLO_WAIT: Duration = Duration::from_millis(10_000);
pub const REQUEST_WAIT: Duration = Duration::from_millis(20_000);
pub const EXIT_WAIT: Duration = Duration::from_millis(5_000);
pub const ABSENCE_WAIT: Duration = Duration::from_millis(3_000);
const STREAM_PREFIX: &str = "/run/endpoint/streams";
const MAX_FRAME_BYTES: usize = 655_360;
const ATTEMPT_BYTES: usize = 8192;

fn hook<T, E>(result: Result<T, E>) -> Result<T, HookFailure> {
    result.map_err(|_| HookFailure)
}


fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    let _ = File::open("/dev/urandom").and_then(|mut random| random.read_exact(&mut buffer));
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn origin_id() -> String {
    let mut buffer = [0u8; 16];
    let _ = File::open("/dev/urandom").and_then(|mut random| random.read_exact(&mut buffer));
    b64url_encode(&buffer)
}

fn now_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

// ---- process identities -------------------------------------------------------------------------------------------

/// pid, start time (`/proc/<pid>/stat` field 22) and optionally the PID namespace inode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcIdentity {
    pub pid: i32,
    pub start_time: String,
    pub pid_ns: Option<String>,
}

/// `(state, start time)` of a pid, if it can be read (diagnostics and spawn bookkeeping; absence decisions use
/// [`identity_liveness`]).
pub fn proc_stat(pid: i32) -> Option<(char, String)> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let tail = &text[text.rfind(')')? + 2..];
    let fields: Vec<&str> = tail.split(' ').collect();
    Some((fields.first()?.chars().next()?, fields.get(19)?.to_string()))
}

/// The liveness of one exact identity (pid and start time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// The process is gone: no such pid (`ENOENT`/`ESRCH`), a zombie or dead, or the pid now names another process
    /// (different start time).
    Gone,
    Alive,
    /// Not decidable: any other read error, an unparsable stat line, or an empty or non-numeric recorded start time.
    Unknown,
}

/// A liveness probe for exact identities (production: [`identity_liveness`]; tests inject one).
pub type Probe = dyn Fn(&ProcIdentity) -> Liveness;

fn start_time_valid(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Judges one `/proc/<pid>/stat` read for `identity` (the injectable core of [`identity_liveness`]).
pub fn liveness_from(read: io::Result<String>, identity: &ProcIdentity) -> Liveness {
    if identity.pid <= 0 || !start_time_valid(&identity.start_time) {
        return Liveness::Unknown;
    }
    let text = match read {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH) => return Liveness::Gone,
        Err(_) => return Liveness::Unknown,
    };
    let Some(close) = text.rfind(')') else { return Liveness::Unknown };
    let Some(tail) = text.get(close + 2..) else { return Liveness::Unknown };
    let fields: Vec<&str> = tail.split(' ').collect();
    match (fields.first().and_then(|state| state.chars().next()), fields.get(19)) {
        (Some(state), Some(start)) if start_time_valid(start) => {
            if *start != identity.start_time || state == 'Z' || state == 'X' { Liveness::Gone } else { Liveness::Alive }
        }
        _ => Liveness::Unknown,
    }
}

/// The liveness of `identity` from `/proc`.
pub fn identity_liveness(identity: &ProcIdentity) -> Liveness {
    liveness_from(fs::read_to_string(format!("/proc/{}/stat", identity.pid)), identity)
}

/// Whether exactly this process is verifiably still running (diagnostics; `Unknown` is not alive and not gone).
pub fn identity_alive(identity: &ProcIdentity) -> bool {
    identity_liveness(identity) == Liveness::Alive
}

/// Waits until the identity is verifiably gone; `Unknown` never counts as gone.
fn wait_absent(identity: &ProcIdentity, wait: Duration, probe: &Probe) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if probe(identity) == Liveness::Gone {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
    // SAFETY: pidfd_open(2) with no flags; the descriptor is owned immediately.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

fn pidfd_signal(pidfd: &OwnedFd, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: pidfd_send_signal(2) with a null siginfo and no flags.
    let result = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd.as_raw_fd(), signal, std::ptr::null::<libc::siginfo_t>(), 0) };
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// Kills a process that is not this helper's child, after re-checking its exact start time through a pidfd. True only
/// once it is verifiably gone; an undecidable identity is never signalled and never reported gone.
fn kill_exact(identity: &ProcIdentity, probe: &Probe) -> bool {
    match probe(identity) {
        Liveness::Gone => return true,
        Liveness::Unknown => return false,
        Liveness::Alive => {}
    }
    let Ok(pidfd) = pidfd_open(identity.pid) else { return probe(identity) == Liveness::Gone };
    // The pidfd pins the pid; signal only if it is still exactly this process.
    if probe(identity) == Liveness::Alive {
        let _ = pidfd_signal(&pidfd, libc::SIGKILL);
    }
    wait_absent(identity, ABSENCE_WAIT, probe)
}

fn ns_inode(path: &str) -> Option<String> {
    fs::metadata(path).ok().map(|metadata| metadata.ino().to_string())
}

/// The host facts an attempt is judged against: this helper process and the kernel boot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostIdentity {
    pub helper: ProcIdentity,
    pub boot_id: Option<String>,
}

impl HostIdentity {
    pub fn current() -> HostIdentity {
        HostIdentity { helper: helper_identity(), boot_id: boot_id() }
    }
}

fn boot_id() -> Option<String> {
    let text = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let text = text.trim();
    (text.len() == 36 && text.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')).then(|| text.to_string())
}

fn bounded_text(path: &str, max: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    text.trim().chars().filter(|character| !character.is_control() || *character == '\n').take(max).collect()
}

/// The process-bearing roles an attempt records: the keeper, the endpoint anchor and the workload anchor.
pub const ATTEMPT_ROLES: [&str; 3] = ["keeper", "endpoint", "workload"];

/// Whether every process an attempt names is verifiably gone, given a liveness probe for exact identities (see the
/// module table). Pure, so each branch is testable with real and synthetic identities. A role that was requested but
/// whose identity was never recorded is unverified (unless the boot changed).
pub fn attempt_absence(attempt: &Attempt, host: &HostIdentity, probe: &Probe) -> bool {
    match (&attempt.boot_id, &host.boot_id) {
        (Some(then), Some(now)) if then != now => return true,
        (Some(_), Some(_)) => {}
        _ => return false,
    }
    let same_namespace = attempt.helper.pid_ns.is_some() && attempt.helper.pid_ns == host.helper.pid_ns;
    if !same_namespace {
        return false;
    }
    // The keeper ran in the helper's namespace (the anchors' own PID namespaces are nested, so only the keeper's is
    // compared).
    if attempt.keeper.as_ref().is_some_and(|keeper| keeper.pid_ns.is_none() || keeper.pid_ns != host.helper.pid_ns) {
        return false;
    }
    if attempt.requested.iter().any(|role| attempt.identity(role).is_none()) {
        return false;
    }
    attempt.identities().into_iter().all(|identity| probe(identity) == Liveness::Gone)
}

/// Delivers a stop to an attempt's surviving processes where that is possible locally (this boot, this PID namespace):
/// each survivor with the exact recorded start time is killed through a pidfd.
pub fn deliver_attempt_stop(attempt: &Attempt, host: &HostIdentity, probe: &Probe) {
    let same_boot = attempt.boot_id.is_some() && attempt.boot_id == host.boot_id;
    let same_namespace = attempt.helper.pid_ns.is_some() && attempt.helper.pid_ns == host.helper.pid_ns;
    if same_boot && same_namespace {
        for identity in attempt.identities() {
            kill_exact(identity, probe);
        }
    }
}

/// This helper process: pid, start time and PID namespace.
pub fn helper_identity() -> ProcIdentity {
    // SAFETY: getpid has no preconditions.
    let pid = unsafe { libc::getpid() };
    ProcIdentity { pid, start_time: proc_stat(pid).map(|(_, start)| start).unwrap_or_default(), pid_ns: ns_inode("/proc/self/ns/pid") }
}

fn poll_one(fd: RawFd, timeout: Duration) -> io::Result<bool> {
    let mut entry = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    let millis = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
    loop {
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut entry, 1, millis) };
        if ready >= 0 {
            return Ok(ready > 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

// ---- spawning ------------------------------------------------------------------------------------------------------

/// What one keeper spawn needs.
#[derive(Clone, Debug)]
pub struct SpawnPlan {
    pub reservation: String,
    pub runtime_root: PathBuf,
    pub home: PathBuf,
    pub log: PathBuf,
}

/// A spawned keeper process (the helper's direct child).
#[derive(Debug)]
pub struct KeeperProcess {
    pub pid: i32,
    pub pidfd: OwnedFd,
    pub start_time: String,
}

/// The helper's ends of a spawned keeper: the fd-3 channel, the endpoint and control peers (kept open for the keeper's
/// lifetime) and the process (tests may supply a keeper without one).
#[derive(Debug)]
pub struct Spawned {
    pub channel: UnixStream,
    pub peers: Vec<UnixStream>,
    pub process: Option<KeeperProcess>,
}

pub trait KeeperSpawner {
    /// Whether a keeper can be spawned at all (the binary is present).
    fn available(&self) -> bool;
    fn spawn(&mut self, plan: &SpawnPlan) -> io::Result<Spawned>;
}

/// The production spawner: `keeper serve` as a direct child of the helper's main thread (the keeper's parent-death
/// signal is tied to the creating thread), with exactly the v1 descriptor layout and an empty environment.
#[derive(Clone, Debug)]
pub struct ProcessSpawner {
    pub keeper: PathBuf,
}

impl ProcessSpawner {
    pub fn new(keeper: &Path) -> Self {
        ProcessSpawner { keeper: keeper.to_path_buf() }
    }

    /// The keeper argv for `plan` (HOME identity `dev:ino`).
    pub fn argv(plan: &SpawnPlan, parent: i32, home_identity: (u64, u64)) -> Vec<String> {
        vec![
            "serve".into(), "--protocol".into(), "1".into(), "--reservation".into(), plan.reservation.clone(), "--parent-pid".into(), parent.to_string(),
            "--scope".into(), "execution".into(), "--runtime-root".into(), plan.runtime_root.to_string_lossy().into_owned(), "--ala".into(), "1".into(),
            "--grant-roots".into(), "0".into(), "--home-identity".into(), format!("{}:{}", home_identity.0, home_identity.1),
        ]
    }
}

/// Spawns `program` with `argv` so that the child holds exactly descriptors 0-2 (`/dev/null`, `log`, `log`) and
/// `layout[i]` at descriptor `3 + i`, with an empty environment. Returns the child's pid and a pidfd.
pub fn spawn_with_layout(program: &Path, argv: &[String], log: &File, layout: &[RawFd]) -> io::Result<KeeperProcess> {
    use std::os::unix::process::CommandExt;
    let devnull = File::open("/dev/null")?;
    let mut command = std::process::Command::new(program);
    command.args(argv).env_clear().stdin(devnull).stdout(log.try_clone()?).stderr(log.try_clone()?);
    let mut sources = [0 as RawFd; 8];
    let count = layout.len().min(8);
    sources[..count].copy_from_slice(&layout[..count]);
    // SAFETY: the closure runs between fork and exec and uses only async-signal-safe calls (fcntl, dup2, syscall) on
    // descriptors it captured by value; it allocates nothing.
    unsafe {
        command.pre_exec(move || {
            let mut high = [0 as RawFd; 8];
            for index in 0..count {
                let duplicate = libc::fcntl(sources[index], libc::F_DUPFD_CLOEXEC, 64);
                if duplicate < 0 {
                    return Err(io::Error::last_os_error());
                }
                high[index] = duplicate;
            }
            for index in 0..count {
                if libc::dup2(high[index], 3 + index as RawFd) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            let first = 3 + count as libc::c_uint;
            // Every other descriptor is closed at exec (std opens its own with CLOEXEC; this is the second line).
            if libc::syscall(libc::SYS_close_range, first, libc::c_uint::MAX, 4 as libc::c_uint) < 0 {
                for fd in first as RawFd..4096 {
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                }
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    let pid = child.id() as i32;
    // The child is unreaped, so its pid cannot be reused before the pidfd exists.
    let pidfd = pidfd_open(pid)?;
    drop(child);
    let start_time = proc_stat(pid).map(|(_, start)| start).unwrap_or_default();
    Ok(KeeperProcess { pid, pidfd, start_time })
}

impl KeeperSpawner for ProcessSpawner {
    fn available(&self) -> bool {
        fs::symlink_metadata(&self.keeper).is_ok_and(|metadata| metadata.file_type().is_file() && metadata.mode() & 0o111 != 0)
    }

    fn spawn(&mut self, plan: &SpawnPlan) -> io::Result<Spawned> {
        let (channel, channel_child) = UnixStream::pair()?;
        let mut peers = Vec::new();
        let mut children = Vec::new();
        for _ in 0..4 {
            let (ours, theirs) = UnixStream::pair()?;
            peers.push(ours);
            children.push(theirs);
        }
        let home = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(&plan.home)?;
        let metadata = home.metadata()?;
        let log = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&plan.log)?;
        // SAFETY: getpid has no preconditions.
        let parent = unsafe { libc::getpid() };
        let argv = ProcessSpawner::argv(plan, parent, (metadata.dev(), metadata.ino()));
        let layout = [channel_child.as_raw_fd(), children[0].as_raw_fd(), children[1].as_raw_fd(), children[2].as_raw_fd(), children[3].as_raw_fd(), home.as_raw_fd()];
        let process = spawn_with_layout(&self.keeper, &argv, &log, &layout)?;
        Ok(Spawned { channel, peers, process: Some(process) })
    }
}

// ---- the keeper channel --------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum ChannelError {
    Closed,
    Timeout,
    Violation,
    Io,
}

/// The supervisor side of one keeper's fd-3 channel: requests with strictly increasing ids, one at a time; events are
/// queued.
#[derive(Debug)]
pub struct KeeperChannel {
    stream: UnixStream,
    decoder: FrameDecoder,
    clock: Instant,
    next_id: i64,
    events: Vec<J>,
    pending: Vec<J>,
    closed: bool,
    failed: bool,
}

fn is_event(frame: &J) -> bool {
    frame.get("event").and_then(J::as_str).is_some() && !frame.has("id")
}

impl KeeperChannel {
    pub fn new(stream: UnixStream) -> io::Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(KeeperChannel { stream, decoder: FrameDecoder::new(MAX_FRAME_BYTES, 5000), clock: Instant::now(), next_id: 0, events: Vec::new(), pending: Vec::new(), closed: false, failed: false })
    }

    pub fn fd(&self) -> RawFd {
        self.stream.as_raw_fd()
    }

    pub fn is_down(&self) -> bool {
        self.closed || self.failed
    }

    /// Reads whatever is available without blocking; frames go to the event queue or the reply buffer.
    pub fn pump(&mut self) {
        let mut buffer = [0u8; 65536];
        while !self.is_down() {
            match self.stream.read(&mut buffer) {
                Ok(0) => self.closed = true,
                Ok(count) => {
                    let mut out = Vec::new();
                    self.decoder.push(&buffer[..count], now_ms(self.clock), &mut out);
                    for event in out {
                        match event {
                            DecodeEvent::Frame(frame) if is_event(&frame) => self.events.push(frame),
                            DecodeEvent::Frame(frame) => self.pending.push(frame),
                            DecodeEvent::Violation(_) => self.failed = true,
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => self.failed = true,
            }
        }
    }

    fn send(&mut self, frame: &J) -> Result<(), ChannelError> {
        let bytes = encode_frame(frame, MAX_FRAME_BYTES).map_err(|_| ChannelError::Violation)?;
        let mut offset = 0;
        let deadline = Instant::now() + REQUEST_WAIT;
        while offset < bytes.len() {
            match self.stream.write(&bytes[offset..]) {
                Ok(0) => return Err(ChannelError::Closed),
                Ok(count) => offset += count,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(ChannelError::Timeout);
                    }
                    let mut entry = libc::pollfd { fd: self.fd(), events: libc::POLLOUT, revents: 0 };
                    // SAFETY: one valid pollfd.
                    unsafe { libc::poll(&mut entry, 1, 100) };
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => {
                    self.failed = true;
                    return Err(ChannelError::Io);
                }
            }
        }
        Ok(())
    }

    /// Sends `{id, op, ...fields}` and waits for its reply (`{id, ok, ...}`); events that arrive meanwhile are queued.
    pub fn request(&mut self, op: &str, fields: Vec<(&str, J)>, wait: Duration) -> Result<J, ChannelError> {
        if self.is_down() {
            return Err(if self.closed { ChannelError::Closed } else { ChannelError::Violation });
        }
        self.next_id += 1;
        let id = self.next_id;
        let mut entries = vec![("id", pj::int(id)), ("op", pj::text(op))];
        entries.extend(fields);
        self.send(&pj::obj(entries))?;
        let deadline = Instant::now() + wait;
        loop {
            if let Some(index) = self.pending.iter().position(|frame| frame.get("id").and_then(J::as_safe_int) == Some(id)) {
                let reply = self.pending.remove(index);
                if !self.pending.is_empty() {
                    // A reply to no outstanding request: the keeper broke the protocol.
                    self.failed = true;
                }
                return Ok(reply);
            }
            if !self.pending.is_empty() {
                self.failed = true;
                return Err(ChannelError::Violation);
            }
            if self.is_down() {
                return Err(if self.closed { ChannelError::Closed } else { ChannelError::Violation });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(ChannelError::Timeout);
            }
            if poll_one(self.fd(), deadline - now).map_err(|_| ChannelError::Io)? {
                self.pump();
            }
        }
    }

    /// Waits for the first queued or arriving event matching `predicate` (it is removed from the queue).
    pub fn wait_event(&mut self, predicate: impl Fn(&J) -> bool, wait: Duration) -> Result<J, ChannelError> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(index) = self.events.iter().position(&predicate) {
                return Ok(self.events.remove(index));
            }
            if self.is_down() {
                return Err(if self.closed { ChannelError::Closed } else { ChannelError::Violation });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(ChannelError::Timeout);
            }
            if poll_one(self.fd(), deadline - now).map_err(|_| ChannelError::Io)? {
                self.pump();
            }
        }
    }

    pub fn take_events(&mut self) -> Vec<J> {
        std::mem::take(&mut self.events)
    }
}

fn ok_value(reply: &J) -> Option<&J> {
    (reply.get("ok") == Some(&J::Bool(true))).then(|| reply.get("value")).flatten()
}

fn error_code(reply: &J) -> Option<&str> {
    (reply.get("ok") == Some(&J::Bool(false))).then(|| reply.get("error").and_then(J::as_str)).flatten()
}

// ---- attempt records ----------------------------------------------------------------------------------------------

fn identity_value(identity: &Option<ProcIdentity>) -> Value {
    match identity {
        None => Value::Null,
        Some(identity) => obj(vec![
            ("pid", Value::Int(identity.pid as i64)),
            ("startTime", s(&identity.start_time)),
            ("pidNs", identity.pid_ns.as_deref().map_or(Value::Null, s)),
        ]),
    }
}

fn identity_from(value: Option<&Value>) -> Option<ProcIdentity> {
    let value = value?;
    Some(ProcIdentity {
        pid: value.get("pid").and_then(Value::int).filter(|pid| *pid > 0 && *pid <= i32::MAX as i64)? as i32,
        start_time: value.str_at("startTime")?.to_string(),
        pid_ns: value.str_at("pidNs").map(str::to_string),
    })
}

/// The durable per-key attempt record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub key_digest: String,
    pub marker: String,
    pub helper: ProcIdentity,
    pub helper_incarnation: String,
    /// `/proc/sys/kernel/random/boot_id` when the attempt was recorded.
    pub boot_id: Option<String>,
    /// The helper's `/proc/self/cgroup` and host name (container instance identity for a later attestation).
    pub cgroup: String,
    pub hostname: String,
    /// Process-bearing roles requested so far (persisted before each create), sorted: a subset of [`ATTEMPT_ROLES`].
    pub requested: Vec<String>,
    pub keeper: Option<ProcIdentity>,
    pub endpoint: Option<ProcIdentity>,
    /// The workload anchor.
    pub anchor: Option<ProcIdentity>,
}

const ATTEMPT_KEYS: [&str; 12] =
    ["version", "keyDigest", "marker", "helper", "helperIncarnation", "bootId", "cgroup", "hostname", "requested", "keeper", "endpoint", "anchor"];

impl Attempt {
    /// The recorded identity of a role.
    pub fn identity(&self, role: &str) -> Option<&ProcIdentity> {
        match role {
            "keeper" => self.keeper.as_ref(),
            "endpoint" => self.endpoint.as_ref(),
            "workload" => self.anchor.as_ref(),
            _ => None,
        }
    }

    /// Every recorded identity.
    pub fn identities(&self) -> Vec<&ProcIdentity> {
        [&self.keeper, &self.endpoint, &self.anchor].into_iter().flatten().collect()
    }

    fn value(&self) -> Value {
        obj(vec![
            ("version", Value::Int(1)),
            ("keyDigest", s(&self.key_digest)),
            ("marker", s(&self.marker)),
            ("helper", identity_value(&Some(self.helper.clone()))),
            ("helperIncarnation", s(&self.helper_incarnation)),
            ("bootId", self.boot_id.as_deref().map_or(Value::Null, s)),
            ("cgroup", s(&self.cgroup)),
            ("hostname", s(&self.hostname)),
            ("requested", Value::Arr(self.requested.iter().map(|role| s(role)).collect())),
            ("keeper", identity_value(&self.keeper)),
            ("endpoint", identity_value(&self.endpoint)),
            ("anchor", identity_value(&self.anchor)),
        ])
    }

    fn parse(bytes: &[u8]) -> Option<Attempt> {
        let value = canon::parse_canonical(bytes, ATTEMPT_BYTES).ok()?;
        if value.get("version") != Some(&Value::Int(1)) || !value.has_exact_keys(&ATTEMPT_KEYS) {
            return None;
        }
        let requested: Vec<String> = value.get("requested")?.arr()?.iter().map(|role| role.str().filter(|role| ATTEMPT_ROLES.contains(role)).map(str::to_string)).collect::<Option<_>>()?;
        Some(Attempt {
            key_digest: value.str_at("keyDigest")?.to_string(),
            marker: value.str_at("marker")?.to_string(),
            helper: identity_from(value.get("helper"))?,
            helper_incarnation: value.str_at("helperIncarnation")?.to_string(),
            boot_id: value.str_at("bootId").map(str::to_string),
            cgroup: value.str_at("cgroup")?.to_string(),
            hostname: value.str_at("hostname")?.to_string(),
            requested,
            keeper: identity_from(value.get("keeper")),
            endpoint: identity_from(value.get("endpoint")),
            anchor: identity_from(value.get("anchor")),
        })
    }
}

fn sync_dir(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

/// The attempt store: `<journal root>/journal/keepers/<keyDigest>.json`, witnessed by the journal store identity.
#[derive(Clone, Debug)]
pub struct AttemptStore {
    dir: PathBuf,
    witness: String,
}

impl AttemptStore {
    /// The store of journal store `store_identity` below `journal_root`; nothing is read until it is used.
    pub fn at(journal_root: &Path, store_identity: &str) -> AttemptStore {
        AttemptStore {
            dir: journal_root.join("journal").join(crate::journal::KEEPER_ATTEMPTS_DIRECTORY),
            witness: crate::journal::store_witness_text(store_identity).unwrap_or_default(),
        }
    }

    /// The store directory exists (not a link) and its witness names this journal store; anything else refuses.
    pub fn verify(&self) -> io::Result<()> {
        let metadata = fs::symlink_metadata(&self.dir)?;
        if !metadata.file_type().is_dir() {
            return Err(io::Error::other("attempt store is not a directory"));
        }
        let witness = fs::read(self.dir.join(crate::journal::KEEPER_ATTEMPTS_WITNESS))?;
        if self.witness.is_empty() || witness != self.witness.as_bytes() {
            return Err(io::Error::other("attempt store witness names another journal store"));
        }
        Ok(())
    }

    fn path(&self, key_digest: &str) -> PathBuf {
        self.dir.join(format!("{key_digest}.json"))
    }

    /// The attempt for a key in a verified store (`Ok(None)`: no attempt was recorded in this store).
    pub fn get(&self, key_digest: &str) -> io::Result<Option<Attempt>> {
        self.verify()?;
        match fs::read(self.path(key_digest)) {
            Ok(bytes) if bytes.len() <= ATTEMPT_BYTES => Attempt::parse(&bytes).filter(|attempt| attempt.key_digest == key_digest).map(Some).ok_or_else(|| io::Error::other("attempt record is damaged")),
            Ok(_) => Err(io::Error::other("attempt record is oversized")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write(&self, attempt: &Attempt, new: bool) -> io::Result<()> {
        let text = canon::canonical(&attempt.value(), ATTEMPT_BYTES).map_err(|_| io::Error::other("encode"))?;
        let temp = self.dir.join(format!(".tmp-{}", random_hex(8)));
        let result = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            if new {
                // link(2) never replaces an existing record.
                fs::hard_link(&temp, self.path(&attempt.key_digest))?;
                fs::remove_file(&temp)?;
            } else {
                fs::rename(&temp, self.path(&attempt.key_digest))?;
            }
            sync_dir(&self.dir)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    /// Records a new attempt; an existing record for the key refuses (`AlreadyExists`).
    pub fn create(&self, attempt: &Attempt) -> io::Result<()> {
        self.verify()?;
        self.write(attempt, true)
    }

    pub fn update(&self, attempt: &Attempt) -> io::Result<()> {
        self.verify()?;
        self.write(attempt, false)
    }
}

// ---- executions ----------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Gated,
    Running,
    /// The workload exited; the keeper was asked to shut down.
    Exited,
    /// The setup failed and the execution could not yet be verified gone (kept tracked, never dropped).
    Failed,
    /// The keeper is reaped and every recorded identity verified gone.
    Absent,
}

struct Execution {
    key_digest: String,
    dir: PathBuf,
    channel: KeeperChannel,
    _peers: Vec<UnixStream>,
    process: Option<KeeperProcess>,
    keeper: Option<ProcIdentity>,
    marker: String,
    netns_inode: String,
    workload: String,
    endpoint: Option<ProcIdentity>,
    anchor: Option<ProcIdentity>,
    /// Process-bearing roles requested (persisted in the attempt before each create).
    requested: Vec<String>,
    phase: Phase,
    listeners: Vec<UnixListener>,
    streams: Vec<UnixStream>,
    output: Option<File>,
    output_bytes: u64,
    /// An end (workload exit or keeper loss) observed but not yet verified; reported once absence is verified.
    pending: Option<EndKind>,
    /// The end was reported to the service (only after verified absence).
    reported: bool,
    output_limit_reported: bool,
}

impl Execution {
    fn identity(&self, role: &str) -> Option<&ProcIdentity> {
        match role {
            "keeper" => self.keeper.as_ref(),
            "endpoint" => self.endpoint.as_ref(),
            "workload" => self.anchor.as_ref(),
            _ => None,
        }
    }

    fn identity_digests(&self, key_text: &str, specs: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        let key = sha256_hex(key_text.as_bytes());
        let anchor = self.anchor.clone().ok_or(HookFailure)?;
        specs
            .iter()
            .map(|spec| {
                let identity = match spec.kind.as_str() {
                    "keeper" => {
                        let keeper = self.keeper.clone().unwrap_or(ProcIdentity { pid: 0, start_time: String::new(), pid_ns: None });
                        obj(vec![("pid", Value::Int(keeper.pid as i64)), ("startTime", s(&keeper.start_time)), ("marker", s(&self.marker))])
                    }
                    "namespace" => obj(vec![("netNs", s(&self.netns_inode))]),
                    "process-tree" => identity_value(&Some(anchor.clone())),
                    "gate" => obj(vec![("resource", s(&self.workload)), ("anchor", identity_value(&Some(anchor.clone())))]),
                    _ => return Err(HookFailure),
                };
                let value = obj(vec![("version", Value::Int(1)), ("kind", s(&spec.kind)), ("key", s(&key)), ("resourceId", s(&spec.resource_id)), ("identity", identity)]);
                hook(canon::digest_of(&value))
            })
            .collect()
    }

    /// Accepts stream connections and drains workload output (non-blocking).
    fn drain_streams(&mut self) {
        for listener in &self.listeners {
            while let Ok((stream, _)) = listener.accept() {
                if stream.set_nonblocking(true).is_ok() {
                    self.streams.push(stream);
                }
            }
        }
        let mut buffer = [0u8; 65536];
        let mut index = 0;
        while index < self.streams.len() {
            let mut closed = false;
            loop {
                match self.streams[index].read(&mut buffer) {
                    Ok(0) => {
                        closed = true;
                        break;
                    }
                    Ok(count) => {
                        let room = OUTPUT_LOG_BYTES.saturating_sub(self.output_bytes) as usize;
                        if let Some(file) = self.output.as_mut() {
                            let _ = file.write_all(&buffer[..count.min(room)]);
                        }
                        self.output_bytes = self.output_bytes.saturating_add(count as u64);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => {
                        closed = true;
                        break;
                    }
                }
            }
            if closed {
                self.streams.remove(index);
            } else {
                index += 1;
            }
        }
    }

    fn keeper_exited(&self) -> bool {
        match &self.process {
            Some(process) => poll_one(process.pidfd.as_raw_fd(), Duration::ZERO).unwrap_or(true),
            None => self.channel.is_down(),
        }
    }

    /// Reaps the keeper through its pidfd, killing it (through the pidfd) when it has not exited within `wait`.
    fn reap(&mut self, wait: Duration) -> bool {
        let Some(process) = self.process.as_ref() else { return true };
        let exited = poll_one(process.pidfd.as_raw_fd(), wait).unwrap_or(false);
        if !exited {
            let _ = pidfd_signal(&process.pidfd, libc::SIGKILL);
            if !poll_one(process.pidfd.as_raw_fd(), EXIT_WAIT).unwrap_or(false) {
                return false;
            }
        }
        // SAFETY: waitid(P_PIDFD) on this helper's own child, with a zeroed out-parameter.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        const P_PIDFD: libc::idtype_t = 3;
        let reaped = unsafe { libc::waitid(P_PIDFD, process.pidfd.as_raw_fd() as libc::id_t, &mut info, libc::WEXITED) } == 0;
        if reaped {
            self.process = None;
        }
        reaped
    }

    /// The keeper reaped and every recorded identity (keeper, endpoint, workload anchor) verifiably gone; a requested
    /// role whose identity was never recorded is unverified.
    fn verify_absent(&self, probe: &Probe) -> bool {
        if self.process.is_some() || self.requested.iter().any(|role| self.identity(role).is_none()) {
            return false;
        }
        [&self.keeper, &self.endpoint, &self.anchor].into_iter().flatten().all(|identity| wait_absent(identity, ABSENCE_WAIT, probe) || kill_exact(identity, probe))
    }

    /// Ends the execution: the workload tree (stop or abort), the endpoint and the keeper; reaps and verifies. On
    /// failure the execution stays tracked in its non-`Absent` phase.
    fn end(&mut self, probe: &Probe) -> bool {
        if !self.keeper_exited() && !self.channel.is_down() {
            match self.phase {
                Phase::Running => {
                    let _ = self.channel.request("stop", vec![("resource", pj::text(&self.workload)), ("graceMs", pj::int(STOP_GRACE_MS))], REQUEST_WAIT);
                }
                // A setup that failed before the workload create has no workload handle to abort.
                Phase::Gated | Phase::Failed if !self.workload.is_empty() => {
                    let _ = self.channel.request("abort_uncommitted", vec![("resources", J::Array(vec![pj::text(&self.workload)]))], REQUEST_WAIT);
                }
                _ => {}
            }
            let _ = self.channel.request("end_process_trees", vec![], REQUEST_WAIT);
            let _ = self.channel.request("end_endpoint", vec![], REQUEST_WAIT);
            let _ = self.channel.request("shutdown", vec![], REQUEST_WAIT);
        }
        self.drain_streams();
        let absent = self.reap(EXIT_WAIT) && self.verify_absent(probe);
        if absent {
            self.mark_absent();
        }
        absent
    }

    fn mark_absent(&mut self) {
        self.phase = Phase::Absent;
        self.listeners.clear();
        self.streams.clear();
    }
}

/// The production [`KeeperLauncher`].
pub struct KeeperSupervisor {
    spawner: Box<dyn KeeperSpawner>,
    attempts: AttemptStore,
    runtime_base: PathBuf,
    helper: ProcIdentity,
    host: HostIdentity,
    helper_incarnation: String,
    executions: HashMap<String, Execution>,
    /// Workload kept by `admit_prepare` for `create`, and whether the prepare retries a `reserved` record.
    staged: HashMap<String, (Workload, bool)>,
    capacity: usize,
    probe: Box<Probe>,
}

fn key_digest(key_text: &str) -> String {
    sha256_hex(key_text.as_bytes())
}

/// Copies an execution's recorded roles and identities into its attempt and persists it.
fn persist_attempt(attempts: &AttemptStore, attempt: &mut Attempt, execution: &Execution) -> Result<(), ()> {
    let mut requested = execution.requested.clone();
    requested.sort();
    requested.dedup();
    attempt.requested = requested;
    attempt.keeper = execution.keeper.clone();
    attempt.endpoint = execution.endpoint.clone();
    attempt.anchor = execution.anchor.clone();
    attempts.update(attempt).map_err(|_| ())
}

impl KeeperSupervisor {
    /// `journal_root` is the helper-only management directory (attempt records go to the journal store's witnessed
    /// `journal/keepers/`); `runtime_base` a per-container directory this helper creates 0700 at its first launch (an
    /// existing one must be a directory owned by this uid, not a link). Nothing is created before the first launch.
    pub fn new(spawner: Box<dyn KeeperSpawner>, journal_root: &Path, runtime_base: &Path, helper_incarnation: &str, store_identity: &str) -> KeeperSupervisor {
        let host = HostIdentity::current();
        KeeperSupervisor {
            spawner,
            attempts: AttemptStore::at(journal_root, store_identity),
            runtime_base: runtime_base.to_path_buf(),
            helper: host.helper.clone(),
            host,
            helper_incarnation: helper_incarnation.to_string(),
            executions: HashMap::new(),
            staged: HashMap::new(),
            capacity: EXECUTIONS_PER_TARGET,
            probe: Box::new(identity_liveness),
        }
    }

    /// Test seam: the liveness probe used for every absence decision.
    pub fn with_probe(mut self, probe: Box<Probe>) -> Self {
        self.probe = probe;
        self
    }

    fn ensure_runtime_base(&self) -> io::Result<()> {
        match fs::symlink_metadata(&self.runtime_base) {
            // SAFETY: geteuid has no preconditions.
            Ok(metadata) if metadata.file_type().is_dir() && metadata.uid() == unsafe { libc::geteuid() } => {
                fs::set_permissions(&self.runtime_base, fs::Permissions::from_mode(0o700))
            }
            Ok(_) => Err(io::Error::other("runtime base is not a private directory")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => fs::DirBuilder::new().mode(0o700).create(&self.runtime_base),
            Err(error) => Err(error),
        }
    }

    pub fn with_capacity(mut self, capacity: usize) -> Self {
        self.capacity = capacity;
        self
    }

    fn live(&self) -> usize {
        self.executions.values().filter(|execution| execution.phase != Phase::Absent).count()
    }

    /// The execution directory of a key (deterministic, so a second attempt in this container finds the first).
    fn execution_dir(&self, key_text: &str) -> PathBuf {
        let digest = sha256(format!("rw-target-execution\0{key_text}").as_bytes());
        let name: String = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect();
        self.runtime_base.join(name)
    }

    /// The per-execution output file (operator evidence; never read by the helper).
    pub fn output_path(&self, key_text: &str) -> PathBuf {
        self.execution_dir(key_text).join("o.log")
    }

    /// Spawns and sets up the keeper for `key_text` up to the gated workload create. Every execution that got as far
    /// as a spawn is tracked afterwards (`Gated` on success; on failure `Absent` only if ended and verified, else
    /// `Failed`).
    fn launch(&mut self, key_text: &str, workload: &Workload) -> Result<(), HookFailure> {
        let digest = key_digest(key_text);
        let dir = self.execution_dir(key_text);
        let marker = origin_id();
        let mut attempt = Attempt {
            key_digest: digest.clone(),
            marker: marker.clone(),
            helper: self.helper.clone(),
            helper_incarnation: self.helper_incarnation.clone(),
            boot_id: self.host.boot_id.clone(),
            cgroup: bounded_text("/proc/self/cgroup", 1024),
            hostname: bounded_text("/proc/sys/kernel/hostname", 255),
            // The keeper spawn is requested before anything runs.
            requested: vec!["keeper".to_string()],
            keeper: None,
            endpoint: None,
            anchor: None,
        };
        hook(self.ensure_runtime_base())?;
        // Durable before anything is spawned; an existing record means a previous attempt (never a second keeper).
        hook(self.attempts.create(&attempt))?;
        hook(fs::DirBuilder::new().mode(0o700).create(&dir))?;
        let runtime_root = dir.join("r");
        let home = dir.join("h");
        hook(fs::DirBuilder::new().mode(0o700).create(&runtime_root))?;
        hook(fs::DirBuilder::new().mode(0o700).create(&home))?;
        let plan = SpawnPlan { reservation: marker.clone(), runtime_root: runtime_root.clone(), home, log: dir.join("k.log") };
        // A failed spawn may still have forked: the attempt keeps "keeper" requested and unrecorded, so its absence
        // stays unverified.
        let spawned = hook(self.spawner.spawn(&plan))?;
        let keeper = spawned.process.as_ref().map(|process| ProcIdentity { pid: process.pid, start_time: process.start_time.clone(), pid_ns: self.helper.pid_ns.clone() });
        // A spawner that reports no process (tests) has no keeper identity to verify.
        let requested = if spawned.process.is_some() { vec!["keeper".to_string()] } else { Vec::new() };
        let channel = match KeeperChannel::new(spawned.channel) {
            Ok(channel) => channel,
            Err(_) => {
                if let Some(process) = &spawned.process {
                    let _ = pidfd_signal(&process.pidfd, libc::SIGKILL);
                }
                return Err(HookFailure);
            }
        };
        let mut execution = Execution {
            key_digest: digest,
            dir: dir.clone(),
            channel,
            _peers: spawned.peers,
            process: spawned.process,
            keeper,
            marker: marker.clone(),
            netns_inode: String::new(),
            workload: String::new(),
            endpoint: None,
            anchor: None,
            requested,
            phase: Phase::Gated,
            listeners: Vec::new(),
            streams: Vec::new(),
            output: None,
            output_bytes: 0,
            pending: None,
            reported: false,
            output_limit_reported: false,
        };
        let attempts = self.attempts.clone();
        let outcome = persist_attempt(&attempts, &mut attempt, &execution)
            .and_then(|()| setup(&mut execution, &marker, &runtime_root, workload, &mut |state: &Execution| persist_attempt(&attempts, &mut attempt, state)));
        if outcome.is_err() {
            execution.phase = Phase::Failed;
            execution.end(&*self.probe);
        }
        self.executions.insert(key_text.to_string(), execution);
        outcome.map_err(|()| HookFailure)
    }

    /// Whether every process of `key_text`'s execution is verifiably gone (the module table). A missing attempt or an
    /// unverifiable attempt store is never verified.
    fn absence(&self, key_text: &str) -> bool {
        if let Some(execution) = self.executions.get(key_text) {
            return execution.phase == Phase::Absent;
        }
        match self.attempts.get(&key_digest(key_text)) {
            Ok(Some(attempt)) => attempt_absence(&attempt, &self.host, &*self.probe),
            _ => false,
        }
    }
}

/// One process-bearing create: the role is persisted as requested first; a `refused` reply (nothing created) withdraws
/// it, any other failure (including a lost reply) leaves it requested and unrecorded.
fn create_process(execution: &mut Execution, role: &str, fields: Vec<(&str, J)>, persist: &mut dyn FnMut(&Execution) -> Result<(), ()>) -> Result<ProcIdentity, ()> {
    execution.requested.push(role.to_string());
    persist(execution)?;
    let reply = execution.channel.request("create", fields, REQUEST_WAIT).map_err(|_| ())?;
    let Some(value) = ok_value(&reply).cloned() else {
        if reply.get("kind").and_then(J::as_str) == Some("refused") {
            execution.requested.retain(|known| known != role);
            let _ = persist(execution);
        }
        return Err(());
    };
    let identity = value.get("identity").ok_or(())?;
    Ok(ProcIdentity {
        pid: identity.get("pid").and_then(J::as_safe_int).filter(|pid| *pid > 0 && *pid <= i32::MAX as i64).ok_or(())? as i32,
        start_time: identity.get("startTime").and_then(J::as_str).filter(|start| start_time_valid(start)).ok_or(())?.to_string(),
        pid_ns: identity.get("pidNs").and_then(J::as_str).map(str::to_string),
    })
}

/// hello, commit_keeper, runtime-dir, netns, endpoint, stream listeners and the gated workload. `persist` records the
/// execution's requested roles and identities in its attempt.
fn setup(execution: &mut Execution, marker: &str, runtime_root: &Path, workload: &Workload, persist: &mut dyn FnMut(&Execution) -> Result<(), ()>) -> Result<(), ()> {
    let hello = execution.channel.wait_event(|frame| frame.get("event").and_then(J::as_str) == Some("hello"), HELLO_WAIT).map_err(|_| ())?;
    if hello.get("marker").and_then(J::as_str) != Some(marker) {
        return Err(());
    }
    if let Some(keeper) = execution.keeper.as_mut() {
        let pid = hello.get("pid").and_then(J::as_safe_int).ok_or(())?;
        let start = hello.get("startTime").and_then(J::as_str).filter(|start| start_time_valid(start)).ok_or(())?;
        if pid != keeper.pid as i64 || (!keeper.start_time.is_empty() && start != keeper.start_time) {
            return Err(());
        }
        // The keeper's own start time, where the spawn could not read it.
        if keeper.start_time.is_empty() {
            keeper.start_time = start.to_string();
            persist(execution)?;
        }
    }
    let ok = |reply: Result<J, ChannelError>| -> Result<J, ()> { reply.ok().and_then(|reply| ok_value(&reply).cloned()).ok_or(()) };
    ok(execution.channel.request("commit_keeper", vec![], REQUEST_WAIT))?;
    let runtime_handle = random_hex(16);
    let runtime_dir = runtime_root.join("x").join(random_hex(16));
    let runtime_text = runtime_dir.to_string_lossy().into_owned();
    ok(execution.channel.request(
        "create",
        vec![("resource", pj::text(&runtime_handle)), ("kind", pj::text("runtime-dir")), ("marker", J::Null), ("locator", pj::obj(vec![("keeper", pj::text(marker)), ("path", pj::text(&runtime_text))])), ("spec", J::Object(Vec::new()))],
        REQUEST_WAIT,
    ))?;
    ok(execution.channel.request("commit", vec![("resource", pj::text(&runtime_handle))], REQUEST_WAIT))?;
    let netns = random_hex(16);
    let created = ok(execution.channel.request(
        "create",
        vec![("resource", pj::text(&netns)), ("kind", pj::text("netns")), ("marker", J::Null), ("locator", pj::obj(vec![("keeper", pj::text(marker)), ("netns", pj::text(&random_hex(16)))])), ("spec", J::Object(Vec::new()))],
        REQUEST_WAIT,
    ))?;
    execution.netns_inode = created.get("identity").and_then(|identity| identity.get("netNs")).and_then(J::as_str).ok_or(())?.to_string();
    ok(execution.channel.request("commit", vec![("resource", pj::text(&netns))], REQUEST_WAIT))?;
    let endpoint = random_hex(16);
    let endpoint_marker = origin_id();
    let endpoint_identity = create_process(
        execution,
        "endpoint",
        vec![
            ("resource", pj::text(&endpoint)),
            ("kind", pj::text("endpoint")),
            ("marker", pj::text(&endpoint_marker)),
            ("locator", pj::obj(vec![("id", pj::text(&random_hex(16))), ("keeper", pj::text(marker)), ("marker", pj::text(&endpoint_marker)), ("role", pj::text("endpoint"))])),
            ("spec", pj::obj(vec![("netns", pj::text(&netns)), ("config", pj::obj(vec![("limits", J::Object(Vec::new())), ("relays", J::Array(Vec::new())), ("streamDirectory", pj::text(STREAM_PREFIX))]))])),
        ],
        persist,
    )?;
    execution.endpoint = Some(endpoint_identity);
    persist(execution)?;
    let committed = ok(execution.channel.request("commit", vec![("resource", pj::text(&endpoint))], REQUEST_WAIT))?;
    if committed.get("state").and_then(J::as_str) != Some("executed") {
        return Err(());
    }
    // The endpoint's private stream directory now exists; the workload's stdout and stderr connect to these at commit.
    let streams = runtime_dir.join("streams");
    let mut leaves = Vec::new();
    for prefix in ["o", "e"] {
        let leaf = format!("{prefix}{}", random_hex(6));
        let listener = UnixListener::bind(streams.join(&leaf)).map_err(|_| ())?;
        listener.set_nonblocking(true).map_err(|_| ())?;
        execution.listeners.push(listener);
        leaves.push(leaf);
    }
    execution.output = OpenOptions::new().write(true).create_new(true).mode(0o600).open(execution.dir.join("o.log")).ok();
    let request = workload.start_request().map_err(|_| ())?;
    let resource = random_hex(16);
    let workload_marker = origin_id();
    // The handle is known before the create, so an abort can name it even when the reply is lost.
    execution.workload = resource.clone();
    let anchor = create_process(
        execution,
        "workload",
        vec![
            ("resource", pj::text(&resource)),
            ("kind", pj::text("process-tree")),
            ("marker", pj::text(&workload_marker)),
            ("locator", pj::obj(vec![("id", pj::text(&random_hex(16))), ("keeper", pj::text(marker)), ("marker", pj::text(&workload_marker)), ("role", pj::text("process-tree"))])),
            (
                "spec",
                pj::obj(vec![
                    ("role", pj::text("workload")),
                    ("process", pj::int(1)),
                    ("request", request),
                    ("streams", pj::obj(vec![("stdout", pj::text(&format!("{STREAM_PREFIX}/{}", leaves[0]))), ("stderr", pj::text(&format!("{STREAM_PREFIX}/{}", leaves[1])))])),
                    ("netns", pj::text(&netns)),
                ]),
            ),
        ],
        persist,
    )?;
    execution.anchor = Some(anchor);
    persist(execution)?;
    Ok(())
}

impl Hooks for KeeperSupervisor {
    fn create(&mut self, key_text: &str, resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        if let Some(execution) = self.executions.get(key_text) {
            // Idempotent: the live execution's identities.
            return if execution.phase == Phase::Gated || execution.phase == Phase::Running { execution.identity_digests(key_text, resources) } else { Err(HookFailure) };
        }
        let (workload, retry) = self.staged.remove(key_text).ok_or(HookFailure)?;
        // The retry of a `reserved` record: its first create may have spawned, so this one never does.
        if retry {
            return Err(HookFailure);
        }
        if hook(self.attempts.get(&key_digest(key_text)))?.is_some() {
            // A previous attempt (this or an earlier helper process): never a second keeper for one key.
            return Err(HookFailure);
        }
        if self.live() >= self.capacity {
            return Err(HookFailure);
        }
        self.launch(key_text, &workload)?;
        self.executions.get(key_text).ok_or(HookFailure)?.identity_digests(key_text, resources)
    }

    fn release_gate(&mut self, key_text: &str) -> Result<(), HookFailure> {
        let execution = self.executions.get_mut(key_text).ok_or(HookFailure)?;
        if execution.phase != Phase::Gated {
            return Err(HookFailure);
        }
        let reply = hook(execution.channel.request("commit", vec![("resource", pj::text(&execution.workload))], REQUEST_WAIT))?;
        let executed = ok_value(&reply).and_then(|value| value.get("state")).and_then(J::as_str) == Some("executed");
        // exec_failed: the gate was released and the program did not become the pinned image; its one exit follows.
        if executed || error_code(&reply) == Some("exec_failed") {
            execution.phase = Phase::Running;
            Ok(())
        } else {
            Err(HookFailure)
        }
    }

    /// Delivers the stop; it never fails once delivery was attempted. Absence is judged separately
    /// (`absence_verified`): an execution whose end could not be verified, an attempt of another PID namespace, a key
    /// without an attempt record (it may have spawned) and an unverifiable attempt store all rest `stopping`, which
    /// blocks any later create and leaves quarantine as the operator path.
    fn stop(&mut self, key_text: &str) -> Result<(), HookFailure> {
        if let Some(execution) = self.executions.get_mut(key_text) {
            if execution.phase != Phase::Absent {
                execution.end(&*self.probe);
            }
            return Ok(());
        }
        if let Ok(Some(attempt)) = self.attempts.get(&key_digest(key_text)) {
            deliver_attempt_stop(&attempt, &self.host, &*self.probe);
        }
        Ok(())
    }

    fn release(&mut self, key_text: &str, _resource_id: &str) -> Result<(), HookFailure> {
        if !self.absence(key_text) {
            return Err(HookFailure);
        }
        if let Some(execution) = self.executions.remove(key_text) {
            let _ = fs::remove_dir_all(&execution.dir);
        } else {
            let _ = fs::remove_dir_all(self.execution_dir(key_text));
        }
        Ok(())
    }
}

impl KeeperLauncher for KeeperSupervisor {
    fn available(&self) -> Result<(), Code> {
        if self.spawner.available() { Ok(()) } else { Err(Code::KeeperUnavailable) }
    }

    /// Before the journal write: the request shape, the workload, `executionsPerTarget`, a verifiable attempt store and
    /// a usable runtime base (otherwise `keeper_unavailable`: nothing is persisted that could not be launched safely).
    fn admit_prepare(&mut self, key_text: &str, resources: &Value, workload: Option<&Value>, retry: bool) -> Result<(), Code> {
        check_resource_kinds(resources)?;
        let workload = parse_workload(workload.ok_or(Code::InvalidRequest)?)?;
        workload.start_request()?;
        if !self.executions.contains_key(key_text) && self.live() >= self.capacity {
            return Err(Code::CapacityExceeded);
        }
        self.attempts.verify().map_err(|_| Code::KeeperUnavailable)?;
        self.ensure_runtime_base().map_err(|_| Code::KeeperUnavailable)?;
        self.staged.insert(key_text.to_string(), (workload, retry));
        Ok(())
    }

    fn absence_verified(&mut self, key_text: &str) -> Result<bool, Code> {
        Ok(self.absence(key_text))
    }

    /// Reports an execution's end only once its absence is verified (a failed verification is retried at every call).
    fn take_ended(&mut self, _now_ms: i64) -> Vec<Ended> {
        let mut ended = Vec::new();
        let probe = &*self.probe;
        for (key_text, execution) in self.executions.iter_mut() {
            if execution.reported || (execution.phase == Phase::Absent && execution.pending.is_none()) {
                continue;
            }
            execution.channel.pump();
            execution.drain_streams();
            if execution.pending.is_none() {
                let exit = execution.channel.take_events().into_iter().find(|event| event.get("event").and_then(J::as_str) == Some("exit") && event.get("resource").and_then(J::as_str) == Some(execution.workload.as_str()));
                if let Some(exit) = exit {
                    if execution.phase == Phase::Running || execution.phase == Phase::Gated {
                        execution.phase = Phase::Exited;
                        // The tree is gone: shut the keeper down.
                        let _ = execution.channel.request("end_endpoint", vec![], REQUEST_WAIT);
                        let _ = execution.channel.request("shutdown", vec![], REQUEST_WAIT);
                        execution.drain_streams();
                        let code = exit.get("code").and_then(J::as_safe_int);
                        let signal = exit.get("signal").and_then(J::as_str).map(str::to_string);
                        execution.pending = Some(EndKind::Exited { code, signal });
                    }
                } else if execution.output_bytes > OUTPUT_LIMIT_BYTES && !execution.output_limit_reported {
                    // A request to stop, not an end: reported at once.
                    execution.output_limit_reported = true;
                    ended.push(Ended { key_text: key_text.clone(), kind: EndKind::OutputLimit });
                    continue;
                } else if execution.phase != Phase::Absent && (execution.keeper_exited() || execution.channel.is_down()) {
                    execution.pending = Some(EndKind::KeeperLost);
                }
            }
            let Some(kind) = execution.pending.clone() else { continue };
            let absent = match kind {
                EndKind::Exited { .. } => execution.reap(EXIT_WAIT) && execution.verify_absent(probe),
                _ => execution.phase == Phase::Absent || execution.end(probe),
            };
            if absent {
                execution.mark_absent();
                execution.reported = true;
                ended.push(Ended { key_text: key_text.clone(), kind });
            }
        }
        ended.sort_by(|left, right| left.key_text.cmp(&right.key_text));
        ended
    }

    fn poll_fds(&self) -> Vec<i32> {
        let mut fds = Vec::new();
        for execution in self.executions.values().filter(|execution| execution.phase != Phase::Absent) {
            fds.push(execution.channel.fd());
            if let Some(process) = &execution.process {
                fds.push(process.pidfd.as_raw_fd());
            }
            fds.extend(execution.listeners.iter().map(AsRawFd::as_raw_fd));
            fds.extend(execution.streams.iter().map(AsRawFd::as_raw_fd));
        }
        fds
    }

    fn label(&self) -> &'static str {
        "keeper-supervisor"
    }

    fn reconcile_on_start(&self) -> bool {
        true
    }
}

impl KeeperSupervisor {
    /// Diagnostics: the tracked executions' keeper and anchor pids and phase (never secrets).
    pub fn describe(&self) -> Vec<(String, i32, i32, &'static str)> {
        let mut out: Vec<_> = self
            .executions
            .values()
            .map(|execution| {
                let phase = match execution.phase {
                    Phase::Gated => "gated",
                    Phase::Running => "running",
                    Phase::Exited => "exited",
                    Phase::Failed => "failed",
                    Phase::Absent => "absent",
                };
                (execution.key_digest.clone(), execution.keeper.as_ref().map_or(0, |keeper| keeper.pid), execution.anchor.as_ref().map_or(0, |anchor| anchor.pid), phase)
            })
            .collect();
        out.sort();
        out
    }
}

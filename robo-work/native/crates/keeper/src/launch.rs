//! Portable launch contract. All process/credential/image observations are supplied facts, not kernel proof.
//! Linux construction is deliberately not wired to this model until the image policy and fd inheritance are proven.

use std::os::fd::OwnedFd;

use crate::core::{Created, OsError};
use rw_proto::keeper_limits::KeeperLimits;

#[derive(Debug)]
pub enum Progress<T> { Ready(T), Pending }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitState { Executed, Committed }
impl CommitState {
    pub fn as_str(self) -> &'static str { match self { Self::Executed => "executed", Self::Committed => "committed" } }
}

/// Producer-latched completion time on the same monotonic clock as the request's original budget.
/// For Executed this is the instant positive bound-child image observation completed, never EOF or queue-drain time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitLatch { pub state: CommitState, pub observed_at_ms: u64 }
impl CommitLatch {
    pub fn within(self, accepted_at: u64, deadline: u64, now: u64) -> bool {
        accepted_at <= self.observed_at_ms && self.observed_at_ms < deadline && self.observed_at_ms <= now
    }
}

/// A handle alone is insufficient to associate late work. The original request id is part of every ownership key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OperationId { pub handle: String, pub request_id: i64 }

#[derive(Debug)]
pub enum Completion {
    /// Replayable metadata for the one allocation owned by this operation. A replay transfers no new object.
    Created { operation: OperationId, result: Result<Created, OsError> },
    Committed { operation: OperationId, result: Result<CommitLatch, OsError> },
    /// The owner is the CREATE operation, and the status belongs to the namespace anchor, not its exec child.
    Exited { owner: OperationId, pid: i64, code: Option<i64>, signal: Option<&'static str> },
}

pub fn create_deadline(now: u64, limits: &KeeperLimits) -> Result<u64, &'static str> {
    let budget = (limits.create_deadline_ms / 2).min(5000);
    if budget < 1 { return Err("setup_failed"); }
    now.checked_add(budget as u64).ok_or("setup_failed")
}

pub fn commit_deadline(now: u64, limits: &KeeperLimits) -> Result<u64, &'static str> {
    let budget = limits.request_deadline_ms / 2;
    if budget < 1 { return Err("exec_failed"); }
    now.checked_add(budget as u64).ok_or("exec_failed")
}

pub type ImageIdentity = (u64, u64);

/// Model facts for the later Linux pinned-socket connector. Path revalidation alone is never sufficient.
#[derive(Clone, Copy, Debug)]
pub struct PinnedSocketFacts {
    pub directory: ImageIdentity,
    pub socket: ImageIdentity,
    pub no_follow_socket: bool,
    pub connected_through_pin: bool,
    pub connected_socket: ImageIdentity,
}
impl PinnedSocketFacts {
    pub fn validate(self, expected_directory: ImageIdentity) -> Result<(), &'static str> {
        if self.directory == expected_directory && self.no_follow_socket && self.connected_through_pin && self.connected_socket == self.socket {
            Ok(())
        } else { Err("stream_connect_failed") }
    }
}

pub fn stream_leaf<'a>(path: &'a str, directory: &str, sun_path_capacity: usize) -> Result<&'a str, &'static str> {
    let leaf = path.strip_prefix(directory).and_then(|tail| tail.strip_prefix('/')).ok_or("setup_failed")?;
    if path.len() >= sun_path_capacity || leaf.is_empty() || leaf.contains('/') || leaf == "." || leaf == ".."
        || !rw_proto::provider_schema::is_path(Some(&rw_proto::json::text(path)), 1024) { return Err("setup_failed"); }
    Ok(leaf)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessIdentity { pub pid: i64, pub start_time: u64, pub pid_ns: u64 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Credentials { pub pid: i64, pub uid: u32, pub gid: u32 }

#[derive(Clone, Debug)]
pub struct ReadyFacts {
    pub sender: Credentials,
    pub before: ProcessIdentity,
    pub after: ProcessIdentity,
    pub descendant_of_anchor: bool,
    pub alive_before: bool,
    pub alive_after: bool,
    pub held_pidfd: bool,
    pub held_proc_directory: bool,
    pub marker: String,
    pub executable: Option<ImageIdentity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChildBinding {
    pub anchor: ProcessIdentity,
    pub child: ProcessIdentity,
    pub stage: ImageIdentity,
    pub intended: ImageIdentity,
}

impl ChildBinding {
    pub fn bind(anchor: ProcessIdentity, marker: &str, stage: ImageIdentity, intended: ImageIdentity, facts: &ReadyFacts) -> Result<Self, &'static str> {
        if !rw_proto::keeper_frames::is_origin_id(marker) || anchor.pid <= 0 || facts.before.pid <= 0 || anchor.pid == facts.before.pid || !facts.descendant_of_anchor
            || facts.sender.pid != facts.before.pid || facts.before != facts.after || facts.before.pid_ns != anchor.pid_ns
            || !facts.alive_before || !facts.alive_after || !facts.held_pidfd || !facts.held_proc_directory
            || facts.marker != marker || facts.executable != Some(stage) || intended == stage {
            return Err("setup_failed");
        }
        Ok(Self { anchor, child: facts.before, stage, intended })
    }

    pub fn observes_intended(&self, observation: &Observation) -> bool {
        observation.before == self.child && observation.after == self.child && observation.alive_before && observation.alive_after
            && observation.executable == Some(self.intended) && observation.executable != Some(self.stage)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Observation {
    pub before: ProcessIdentity,
    pub after: ProcessIdentity,
    pub alive_before: bool,
    pub alive_after: bool,
    /// fstat of exe opened relative to the held proc directory. No pathname/cmdline fallback exists.
    pub executable: Option<ImageIdentity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchPhase { Creating, Ready, Connecting, Installing, Observing, Executed, Failed(&'static str), Cancelled }

pub struct Launch {
    pub phase: LaunchPhase,
    deadline: u64,
    binding: Option<ChildBinding>,
    pub gate_released: bool,
    pub committed: bool,
    observed_at_ms: Option<u64>,
}

impl Launch {
    pub fn new(now: u64, limits: &KeeperLimits) -> Result<Self, &'static str> {
        Ok(Self { phase: LaunchPhase::Creating, deadline: create_deadline(now, limits)?, binding: None, gate_released: false, committed: false, observed_at_ms: None })
    }
    pub fn ready(&mut self, binding: ChildBinding, now: u64) -> Result<(), &'static str> {
        self.poll(now);
        if self.phase != LaunchPhase::Creating { return Err("setup_failed"); }
        self.binding = Some(binding);
        self.phase = LaunchPhase::Ready;
        Ok(())
    }
    pub fn begin_commit(&mut self, now: u64, limits: &KeeperLimits, streams: bool) -> Result<(), &'static str> {
        if self.committed { return Err("already_committed"); }
        if self.phase != LaunchPhase::Ready { return Err("gate_closed"); }
        self.deadline = commit_deadline(now, limits)?;
        self.committed = true;
        self.phase = if streams { LaunchPhase::Connecting } else { LaunchPhase::Installing };
        Ok(())
    }
    pub fn streams_connected(&mut self, now: u64) -> Result<(), &'static str> {
        self.poll(now);
        if self.phase != LaunchPhase::Connecting { return Err("stream_connect_failed"); }
        self.phase = LaunchPhase::Installing;
        Ok(())
    }
    pub fn installed(&mut self, now: u64) -> Result<(), &'static str> {
        self.poll(now);
        if self.phase != LaunchPhase::Installing { return Err("stream_connect_failed"); }
        self.phase = LaunchPhase::Observing;
        self.gate_released = true;
        Ok(())
    }
    pub fn observe(&mut self, observation: Observation, now: u64) {
        self.poll(now);
        if self.phase == LaunchPhase::Observing && self.binding.is_some_and(|bound| bound.observes_intended(&observation)) {
            self.phase = LaunchPhase::Executed;
            self.observed_at_ms = Some(now);
        }
    }
    /// Retained through subsequent death, so the adapter can expose the latch before a bounded event queue drains.
    pub fn commit_latch(&self) -> Option<CommitLatch> {
        self.observed_at_ms.map(|observed_at_ms| CommitLatch { state: CommitState::Executed, observed_at_ms })
    }
    /// EOF cannot establish exec. An unobserved rapid exec remains ambiguous and is never automatically retried.
    pub fn status_eof(&mut self, now: u64) {
        self.poll(now);
        if !self.committed { self.stage_died(); }
    }
    pub fn stage_died(&mut self) {
        if !matches!(self.phase, LaunchPhase::Executed | LaunchPhase::Cancelled | LaunchPhase::Failed(_)) {
            self.phase = LaunchPhase::Failed(if self.committed { "exec_failed" } else { "setup_failed" });
        }
    }
    pub fn fail(&mut self, stream_failure: bool) {
        if !matches!(self.phase, LaunchPhase::Executed | LaunchPhase::Cancelled | LaunchPhase::Failed(_)) {
            let stream_phase = matches!(self.phase, LaunchPhase::Connecting | LaunchPhase::Installing);
            self.phase = LaunchPhase::Failed(if !self.committed { "setup_failed" } else if stream_failure && stream_phase { "stream_connect_failed" } else { "exec_failed" });
        }
    }
    pub fn cancel(&mut self) {
        if self.committed { self.fail(matches!(self.phase, LaunchPhase::Connecting | LaunchPhase::Installing)); }
        else { self.phase = LaunchPhase::Cancelled; }
    }
    pub fn deadline(&self) -> Option<u64> {
        matches!(self.phase, LaunchPhase::Creating | LaunchPhase::Connecting | LaunchPhase::Installing | LaunchPhase::Observing).then_some(self.deadline)
    }
    pub fn poll(&mut self, now: u64) {
        if self.deadline().is_some_and(|deadline| now >= deadline) { self.fail(matches!(self.phase, LaunchPhase::Connecting | LaunchPhase::Installing)); }
    }
}

/// Twelve-byte private SOCK_SEQPACKET record; never used on the public keeper fd 3.
pub const RECORD_BYTES: usize = 12;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Record { Ready, InstallStdio { mask: u8, count: u8 }, Installed, Fail { step: u8, errno: u32 } }

impl Record {
    pub fn encode(self) -> Result<[u8; RECORD_BYTES], &'static str> {
        let mut bytes = [0; RECORD_BYTES];
        bytes[..3].copy_from_slice(b"RW\x01");
        match self {
            Self::Ready => bytes[3] = 1,
            Self::InstallStdio { mask, count } if mask <= 7 && count <= 3 && mask.count_ones() == count as u32 => { bytes[3] = 2; bytes[4] = mask; bytes[5] = count; }
            Self::Installed => bytes[3] = 3,
            Self::Fail { step, errno } if (1..=8).contains(&step) && (1..=4095).contains(&errno) => { bytes[3] = 4; bytes[6] = step; bytes[8..].copy_from_slice(&errno.to_le_bytes()); }
            _ => return Err("private_protocol"),
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != RECORD_BYTES || &bytes[..3] != b"RW\x01" { return Err("private_protocol"); }
        let record = match bytes[3] {
            1 => Self::Ready, 2 => Self::InstallStdio { mask: bytes[4], count: bytes[5] }, 3 => Self::Installed,
            4 => Self::Fail { step: bytes[6], errno: u32::from_le_bytes(bytes[8..12].try_into().unwrap()) },
            _ => return Err("private_protocol"),
        };
        if record.encode()?.as_slice() != bytes { return Err("private_protocol"); }
        Ok(record)
    }
}

pub struct ReceivedRight { pub fd: OwnedFd, pub is_stream_socket: bool }
pub struct Packet {
    pub bytes: Vec<u8>,
    pub credentials: Option<Credentials>,
    pub rights: Vec<ReceivedRight>,
    pub truncated: bool,
    pub ancillary_truncated: bool,
    pub unexpected_ancillary: bool,
}

/// Takes ownership before validating, so every rejected right closes exactly once through Drop.
pub fn receive(packet: Packet, from_stage: bool, sender: Credentials) -> Result<(Record, Vec<OwnedFd>), &'static str> {
    if packet.truncated || packet.ancillary_truncated || packet.unexpected_ancillary || packet.credentials != Some(sender) { return Err("private_protocol"); }
    let record = Record::decode(&packet.bytes)?;
    match (from_stage, record) {
        (true, Record::Ready | Record::Installed | Record::Fail { .. }) if packet.rights.is_empty() => Ok((record, Vec::new())),
        (false, Record::InstallStdio { count, .. }) if packet.rights.len() == count as usize && packet.rights.iter().all(|right| right.is_stream_socket) => {
            Ok((record, packet.rights.into_iter().map(|right| right.fd).collect()))
        }
        _ => Err("private_protocol"),
    }
}

#[derive(Default)]
pub struct Exchange { phase: u8 }
impl Exchange {
    /// Dynamic installation is only available to workload stages; inherited endpoint/orchestration stdio stays fixed.
    pub fn accept(&mut self, record: Record, workload: bool) -> Result<(), &'static str> {
        record.encode()?;
        self.phase = match (self.phase, record) {
            (0, Record::Ready) => 1,
            (1, Record::InstallStdio { .. }) if workload => 2,
            (2, Record::Installed) => 3,
            (0..=3, Record::Fail { .. }) => 4,
            _ => return Err("private_protocol"),
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;

    fn binding() -> ChildBinding {
        let anchor = ProcessIdentity { pid: 10, start_time: 1, pid_ns: 7 };
        let child = ProcessIdentity { pid: 11, start_time: 2, pid_ns: 7 };
        let facts = ReadyFacts { sender: Credentials { pid: 11, uid: 1000, gid: 1000 }, before: child, after: child,
            descendant_of_anchor: true, alive_before: true, alive_after: true, held_pidfd: true, held_proc_directory: true,
            marker: "AAECAwQFBgcICQoLDA0ODw".into(), executable: Some((1, 20)) };
        ChildBinding::bind(anchor, "AAECAwQFBgcICQoLDA0ODw", (1, 20), (1, 30), &facts).unwrap()
    }
    fn observation(bound: ChildBinding) -> Observation {
        Observation { before: bound.child, after: bound.child, alive_before: true, alive_after: true, executable: Some(bound.intended) }
    }
    fn observing() -> Launch {
        let mut launch = Launch::new(0, &KeeperLimits::default()).unwrap();
        launch.ready(binding(), 1).unwrap();
        launch.begin_commit(2, &KeeperLimits::default(), true).unwrap();
        launch.streams_connected(3).unwrap();
        launch.installed(4).unwrap();
        launch
    }

    #[test]
    fn eof_and_rapid_exec_exit_are_never_positive_observations() {
        let mut launch = observing();
        let mut stage = observation(binding());
        stage.executable = Some(binding().stage);
        launch.observe(stage, 5);
        launch.status_eof(6);
        assert_eq!(launch.phase, LaunchPhase::Observing);
        launch.poll(5002);
        assert_eq!(launch.phase, LaunchPhase::Failed("exec_failed"));
        assert!(launch.committed);
        let mut rapid = observing();
        rapid.status_eof(5);
        rapid.stage_died();
        assert_eq!(rapid.phase, LaunchPhase::Failed("exec_failed"), "a program may have run; no automatic resubmission");
        assert_eq!(rapid.begin_commit(6, &KeeperLimits::default(), true), Err("already_committed"));
    }

    #[test]
    fn only_the_bound_childs_live_intended_image_can_latch_success() {
        let bound = binding();
        let valid = observation(bound);
        for invalid in [Observation { before: bound.anchor, after: bound.anchor, ..valid },
            Observation { executable: Some((1, 99)), ..valid }, Observation { executable: None, ..valid },
            Observation { before: ProcessIdentity { start_time: 999, ..bound.child }, ..valid },
            Observation { after: ProcessIdentity { pid_ns: 999, ..bound.child }, ..valid },
            Observation { alive_before: false, ..valid }, Observation { alive_after: false, ..valid }] {
            let mut launch = observing();
            launch.observe(invalid, 5);
            assert_eq!(launch.phase, LaunchPhase::Observing, "{invalid:?}");
            launch.stage_died();
            assert_eq!(launch.phase, LaunchPhase::Failed("exec_failed"));
        }
        let mut launch = observing();
        launch.observe(valid, 5);
        launch.stage_died();
        launch.status_eof(9000);
        assert_eq!(launch.phase, LaunchPhase::Executed, "positive observation remains latched before subsequent death");
    }

    #[test]
    fn ready_requires_stable_descendant_stage_identity_and_held_references() {
        let bound = binding();
        let good = ReadyFacts { sender: Credentials { pid: bound.child.pid, uid: 1000, gid: 1000 }, before: bound.child, after: bound.child,
            descendant_of_anchor: true, alive_before: true, alive_after: true, held_pidfd: true, held_proc_directory: true,
            marker: "AAECAwQFBgcICQoLDA0ODw".into(), executable: Some(bound.stage) };
        for bad in [ReadyFacts { sender: Credentials { pid: 666, ..good.sender }, ..good.clone() },
            ReadyFacts { descendant_of_anchor: false, ..good.clone() }, ReadyFacts { marker: "wrong".into(), ..good.clone() },
            ReadyFacts { executable: Some(bound.intended), ..good.clone() }, ReadyFacts { held_pidfd: false, ..good.clone() },
            ReadyFacts { held_proc_directory: false, ..good.clone() }, ReadyFacts { alive_after: false, ..good.clone() },
            ReadyFacts { after: ProcessIdentity { start_time: 777, ..bound.child }, ..good.clone() }] {
            assert_eq!(ChildBinding::bind(bound.anchor, "AAECAwQFBgcICQoLDA0ODw", bound.stage, bound.intended, &bad), Err("setup_failed"));
        }
        assert_eq!(ChildBinding::bind(bound.anchor, "AAECAwQFBgcICQoLDA0ODw", bound.stage, bound.stage, &good), Err("setup_failed"));
    }

    #[test]
    fn one_deadline_covers_connect_install_release_and_observation() {
        let limits = KeeperLimits { request_deadline_ms: 10, create_deadline_ms: 8, ..KeeperLimits::default() };
        let mut launch = Launch::new(100, &limits).unwrap();
        assert_eq!(launch.deadline(), Some(104));
        launch.ready(binding(), 103).unwrap();
        launch.begin_commit(200, &limits, true).unwrap();
        assert_eq!(launch.deadline(), Some(205));
        launch.streams_connected(203).unwrap();
        assert_eq!(launch.deadline(), Some(205));
        launch.installed(204).unwrap();
        launch.observe(observation(binding()), 205);
        assert_eq!(launch.phase, LaunchPhase::Failed("exec_failed"));
        assert!(Launch::new(0, &KeeperLimits { create_deadline_ms: 1, ..limits }).is_err());
        assert!(commit_deadline(0, &KeeperLimits { request_deadline_ms: 1, ..limits }).is_err());
        assert!(create_deadline(u64::MAX, &limits).is_err());
    }

    #[test]
    fn commit_latch_uses_the_original_acceptance_interval_and_never_future_time() {
        for (observed_at_ms, valid) in [(0, false), (1, true), (9, true), (10, false), (11, false)] {
            let latch = CommitLatch { state: CommitState::Executed, observed_at_ms };
            assert_eq!(latch.within(1, 10, 20), valid, "{observed_at_ms}");
        }
        assert!(!CommitLatch { state: CommitState::Executed, observed_at_ms: 5 }.within(1, 10, 4));
    }

    #[test]
    fn create_cancel_and_commit_failures_preserve_phase_semantics() {
        let limits = KeeperLimits::default();
        let mut cancelled = Launch::new(0, &limits).unwrap();
        cancelled.cancel();
        assert!(cancelled.ready(binding(), 1).is_err());
        assert!(!cancelled.gate_released && !cancelled.committed);
        for connect in [false, true] {
            let mut launch = Launch::new(0, &limits).unwrap();
            launch.ready(binding(), 1).unwrap();
            launch.begin_commit(2, &limits, true).unwrap();
            if connect { launch.streams_connected(3).unwrap(); }
            launch.fail(true);
            launch.stage_died();
            assert_eq!(launch.phase, LaunchPhase::Failed("stream_connect_failed"));
            assert!(!launch.gate_released && launch.committed);
        }
        let mut launch = Launch::new(0, &limits).unwrap();
        launch.ready(binding(), 1).unwrap();
        launch.stage_died();
        assert_eq!(launch.begin_commit(2, &limits, false), Err("gate_closed"));
        let mut accepted = Launch::new(0, &limits).unwrap();
        accepted.ready(binding(), 1).unwrap();
        accepted.begin_commit(2, &limits, true).unwrap();
        accepted.stage_died();
        assert_eq!(accepted.phase, LaunchPhase::Failed("exec_failed"));
        let mut released = observing();
        released.fail(true);
        assert_eq!(released.phase, LaunchPhase::Failed("exec_failed"), "after release failure cannot be labelled a stream-install failure");
    }

    #[test]
    fn private_records_are_exact_bounded_and_ordered_without_a_pid_payload() {
        for record in [Record::Ready, Record::InstallStdio { mask: 0, count: 0 }, Record::InstallStdio { mask: 7, count: 3 }, Record::Installed, Record::Fail { step: 8, errno: 4095 }] {
            let encoded = record.encode().unwrap();
            assert_eq!(Record::decode(&encoded), Ok(record));
            for size in [0, 11, 13, 64] { assert!(Record::decode(&vec![0; size]).is_err()); }
            let mut spoof = encoded; spoof[7] = 11;
            assert!(Record::decode(&spoof).is_err(), "no sender pid or reserved payload bytes accepted");
        }
        for record in [Record::InstallStdio { mask: 7, count: 2 }, Record::InstallStdio { mask: 15, count: 4 }, Record::Fail { step: 0, errno: 1 }] { assert!(record.encode().is_err()); }
        let mut exchange = Exchange::default();
        assert!(exchange.accept(Record::Installed, true).is_err());
        exchange.accept(Record::Ready, true).unwrap();
        assert!(exchange.accept(Record::Ready, true).is_err());
        assert!(exchange.accept(Record::InstallStdio { mask: 7, count: 3 }, false).is_err());
        exchange.accept(Record::InstallStdio { mask: 7, count: 3 }, true).unwrap();
        exchange.accept(Record::Installed, true).unwrap();
        assert!(exchange.accept(Record::Installed, true).is_err());
    }

    #[test]
    fn rejected_ancillary_packets_close_every_owned_right() {
        let sender = Credentials { pid: 11, uid: 1000, gid: 1000 };
        // Failure at every partial acquisition count, wrong credential/type/count, truncation and forbidden rights.
        for count in 1..=3 {
            for defect in 0..7 {
                let pairs: Vec<_> = (0..count).map(|_| UnixStream::pair().unwrap()).collect();
                let (rights, mut peers): (Vec<_>, Vec<_>) = pairs.into_iter().map(|(fd, peer)| (ReceivedRight { fd: fd.into(), is_stream_socket: defect != 2 }, peer)).unzip();
                let record = if defect == 6 { Record::Ready } else { Record::InstallStdio { mask: 7, count: 3 } };
                let mut packet = Packet { bytes: record.encode().unwrap().to_vec(), credentials: Some(sender), rights,
                    truncated: defect == 3, ancillary_truncated: defect == 4, unexpected_ancillary: defect == 5 };
                if defect == 0 { packet.credentials = None; }
                if defect == 1 { packet.credentials = Some(Credentials { pid: 999, ..sender }); }
                assert!(receive(packet, defect == 6, sender).is_err());
                for peer in &mut peers { peer.set_nonblocking(true).unwrap(); assert_eq!(peer.read(&mut [0]).unwrap(), 0); }
            }
        }
        let (fd, mut peer) = UnixStream::pair().unwrap();
        let packet = Packet { bytes: Record::InstallStdio { mask: 2, count: 1 }.encode().unwrap().to_vec(), credentials: Some(sender),
            rights: vec![ReceivedRight { fd: fd.into(), is_stream_socket: true }], truncated: false, ancillary_truncated: false, unexpected_ancillary: false };
        let (_, accepted) = receive(packet, false, sender).unwrap();
        peer.set_nonblocking(true).unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        drop(accepted);
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    }

    #[test]
    fn socket_replacement_or_symlink_cannot_substitute_the_connected_object() {
        let held = PinnedSocketFacts { directory: (1, 2), socket: (1, 3), no_follow_socket: true, connected_through_pin: true, connected_socket: (1, 3) };
        assert_eq!(held.validate((1, 2)), Ok(()));
        for bad in [PinnedSocketFacts { no_follow_socket: false, ..held }, PinnedSocketFacts { connected_through_pin: false, ..held },
            PinnedSocketFacts { connected_socket: (1, 4), ..held }, PinnedSocketFacts { directory: (1, 9), ..held }] {
            assert_eq!(bad.validate((1, 2)), Err("stream_connect_failed"));
        }
        assert_eq!(stream_leaf("/private/sock", "/private", 14), Ok("sock"));
        assert!(stream_leaf("/private/sock", "/private", 13).is_err(), "space for terminating NUL");
        for bad in ["/private-other/sock", "/private/a/b", "/private/..", "/private/."] { assert!(stream_leaf(bad, "/private", 108).is_err()); }
    }
}

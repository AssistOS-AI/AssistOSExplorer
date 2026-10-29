//! The gated stage on Linux (`crate::stage`; first-G1 amendment A1.2/A1.3). Bubblewrap runs the keeper binary in
//! `stage` mode as its sandbox child, already in the execution user namespace with every capability dropped.
//!
//! | Step | Behaviour |
//! |---|---|
//! | Entry | Marks the private channel, gate and environment CLOEXEC; closes every other descriptor above 2 except the declared install sources |
//! | Layout | Moves each `--install from:to` descriptor to its final slot (endpoint 3/4, orchestration 0-3) and applies `--nofile` |
//! | Confinement | Sets no_new_privs, requires all five capability sets empty and installs the domain seccomp filter (endpoint: orchestration profile) |
//! | READY | One fixed-size record on the private SOCK_SEQPACKET channel. The keeper takes the sender from kernel credentials, never from a payload |
//! | Workload stdio | Receives `INSTALL_STDIO(mask,count)` with exactly `count` connected stream sockets, installs them on 0-2, closes every extra copy and answers `STDIO_INSTALLED` |
//! | Gate | Reads exactly one byte; only the commit byte proceeds. EOF or any other byte exits 125 before the final exec |
//! | Final exec | Reads the sealed environment memfd (bounded), then execs by absolute path. The channel closes at exec (CLOEXEC); a failed exec sends `FAIL(8, errno)` |
//!
//! A FAIL record never claims an execution happened, and the keeper never infers success from the channel's EOF.

use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use rw_confine::seccomp::{Domain, domain_profile};
use rw_proto::gate::{GateOutcome, await_gate};

use crate::args::{StageArgs, StageDomain};
use crate::launch::{Packet, Record};
use crate::linux::sys::{self, Received};
use crate::stage::{EXIT_ABORTED, MAX_ENV_BYTES, parse_env_block};

pub const STEP_LAYOUT: u8 = 1;
pub const STEP_RLIMIT: u8 = 2;
pub const STEP_NNP: u8 = 3;
pub const STEP_CAPABILITIES: u8 = 4;
pub const STEP_SECCOMP: u8 = 5;
pub const STEP_INSTALL: u8 = 6;
pub const STEP_ENVIRONMENT: u8 = 7;
pub const STEP_EXEC: u8 = 8;
pub const EXIT_EXEC_FAILED: i32 = 127;

fn fail(channel: RawFd, step: u8, errno: i32) -> i32 {
    let errno = (errno as u32).clamp(1, 4095);
    if let Ok(bytes) = (Record::Fail { step, errno }).encode() {
        let _ = sys::send_record(channel, &bytes, &[]);
    }
    if step == STEP_EXEC { EXIT_EXEC_FAILED } else { EXIT_ABORTED }
}

/// Stage-side validation of the keeper's one `INSTALL_STDIO` packet (the keeper is outside the stage's PID namespace,
/// so there is no credential to bind; the channel itself is the private, exclusive one). Rights are owned before any
/// check, so a rejection closes every one exactly once.
pub fn accept_install(packet: Packet) -> Result<(u8, Vec<OwnedFd>), &'static str> {
    if packet.truncated || packet.ancillary_truncated || packet.unexpected_ancillary {
        return Err("private_protocol");
    }
    match Record::decode(&packet.bytes)? {
        Record::InstallStdio { mask, count } if packet.rights.len() == count as usize && packet.rights.iter().all(|right| right.is_stream_socket) => {
            Ok((mask, packet.rights.into_iter().map(|right| right.fd).collect()))
        }
        _ => Err("private_protocol"),
    }
}

/// Descriptor numbers currently open (read through this process's own /proc view).
fn open_descriptors() -> Vec<RawFd> {
    let Ok(entries) = std::fs::read_dir("/proc/self/fd") else { return Vec::new() };
    let mut fds: Vec<RawFd> = entries.filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok()).collect();
    // read_dir holds one descriptor of its own while listing: keep only those still open now.
    // SAFETY: F_GETFD has no side effects.
    fds.retain(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } >= 0);
    fds.sort_unstable();
    fds
}

/// Never returns on success (the final exec replaces the image). Returns the exit code on any failure.
pub fn run(args: &StageArgs) -> i32 {
    let Some(channel) = args.channel_fd else { return EXIT_ABORTED };
    let Some(env_fd) = args.env_fd else { return EXIT_ABORTED };
    for fd in [channel, args.gate_fd, env_fd] {
        if sys::set_cloexec(fd).is_err() {
            return EXIT_ABORTED;
        }
    }
    // Entry: nothing but 0-2, the private descriptors and the declared install sources survives.
    let mut keep = vec![0, 1, 2, channel, args.gate_fd, env_fd];
    keep.extend(args.installs.iter().map(|(from, _)| *from));
    for fd in open_descriptors() {
        if !keep.contains(&fd) {
            // SAFETY: closing a descriptor this process owns and does not use.
            unsafe { libc::close(fd) };
        }
    }
    for (from, to) in &args.installs {
        // dup2 clears CLOEXEC on the target; the source closes afterwards.
        // SAFETY: descriptor numbers validated by the parser (sources above 4, targets 0-4, all distinct).
        if unsafe { libc::dup2(*from, *to) } < 0 {
            return fail(channel, STEP_LAYOUT, sys::errno());
        }
        unsafe { libc::close(*from) };
    }
    let mut expected = vec![0, 1, 2, channel, args.gate_fd, env_fd];
    expected.extend(args.installs.iter().map(|(_, to)| *to));
    expected.sort_unstable();
    expected.dedup();
    if open_descriptors() != expected {
        return fail(channel, STEP_LAYOUT, libc::EBADF);
    }
    if let Some(limit) = args.nofile {
        if rw_confine::linux::set_rlimit_nofile(limit).is_err() {
            return fail(channel, STEP_RLIMIT, sys::errno());
        }
    }
    if rw_confine::linux::set_no_new_privs().is_err() {
        return fail(channel, STEP_NNP, sys::errno());
    }
    match rw_confine::linux::read_capabilities() {
        Ok(sets) if sets.all_empty() => {}
        _ => return fail(channel, STEP_CAPABILITIES, libc::EPERM),
    }
    let domain = match args.domain { StageDomain::Workload => Domain::Workload, StageDomain::Orchestration | StageDomain::Endpoint => Domain::Orchestration };
    if rw_confine::linux::install_filter(&domain_profile(domain)).is_err() {
        return fail(channel, STEP_SECCOMP, sys::errno());
    }
    let Ok(ready) = Record::Ready.encode() else { return EXIT_ABORTED };
    if sys::send_record(channel, &ready, &[]).is_err() {
        return EXIT_ABORTED;
    }
    if args.domain == StageDomain::Workload {
        let packet = match sys::recv_packet(channel, false) {
            Ok(Received::Packet(packet)) => packet,
            _ => return EXIT_ABORTED,
        };
        let (mask, rights) = match accept_install(packet) {
            Ok(accepted) => accepted,
            Err(_) => return fail(channel, STEP_INSTALL, libc::EPROTO),
        };
        let slots: Vec<RawFd> = (0..3).filter(|slot| mask & (1 << slot) != 0).collect();
        for (slot, right) in slots.iter().zip(rights.iter()) {
            // SAFETY: installing a received socket on a standard slot.
            if unsafe { libc::dup2(right.as_raw_fd(), *slot) } < 0 {
                return fail(channel, STEP_INSTALL, sys::errno());
            }
        }
        drop(rights);
        let Ok(installed) = Record::Installed.encode() else { return EXIT_ABORTED };
        if sys::send_record(channel, &installed, &[]).is_err() {
            return EXIT_ABORTED;
        }
    }
    // SAFETY: the gate descriptor was inherited for this purpose and is used once.
    let mut gate = unsafe { std::fs::File::from_raw_fd(args.gate_fd) };
    if await_gate(&mut gate) != GateOutcome::Commit {
        return EXIT_ABORTED;
    }
    drop(gate);
    let block = match sys::read_bounded(env_fd, MAX_ENV_BYTES) {
        Ok(block) => block,
        Err(_) => return fail(channel, STEP_ENVIRONMENT, libc::E2BIG),
    };
    // SAFETY: closing the environment descriptor after its single use.
    unsafe { libc::close(env_fd) };
    let Ok(environment) = parse_env_block(&block) else { return fail(channel, STEP_ENVIRONMENT, libc::EINVAL) };
    let Ok(argv) = args.argv.iter().map(|arg| CString::new(arg.as_str())).collect::<Result<Vec<_>, _>>() else { return fail(channel, STEP_EXEC, libc::EINVAL) };
    let Ok(envp) = environment.iter().map(|(name, value)| CString::new(format!("{name}={value}"))).collect::<Result<Vec<_>, _>>() else {
        return fail(channel, STEP_ENVIRONMENT, libc::EINVAL);
    };
    // Review R8: Rust sets SIGPIPE to SIG_IGN and an ignored disposition survives execve; workloads start with the default.
    // SAFETY: resetting one signal disposition.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());
    let mut envp_ptrs: Vec<*const libc::c_char> = envp.iter().map(|entry| entry.as_ptr()).collect();
    envp_ptrs.push(std::ptr::null());
    // SAFETY: NUL-terminated pointer arrays to live CStrings; absolute program path (checked by the argv parser).
    unsafe { libc::execve(argv[0].as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr()) };
    let error = sys::errno();
    fail(channel, STEP_EXEC, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::ReceivedRight;
    use std::io::Read;
    use std::os::unix::net::UnixStream;

    fn packet(record: Record, rights: Vec<ReceivedRight>) -> Packet {
        Packet { bytes: record.encode().unwrap().to_vec(), credentials: None, rights, truncated: false, ancillary_truncated: false, unexpected_ancillary: false }
    }

    #[test]
    fn stage_accepts_exactly_the_declared_stream_sockets_and_closes_them_on_any_rejection() {
        let (a, mut a_peer) = UnixStream::pair().unwrap();
        let (mask, rights) = accept_install(packet(Record::InstallStdio { mask: 2, count: 1 }, vec![ReceivedRight { fd: a.into(), is_stream_socket: true }])).unwrap();
        assert_eq!((mask, rights.len()), (2, 1));
        drop(rights);
        a_peer.set_nonblocking(true).unwrap();
        assert_eq!(a_peer.read(&mut [0]).unwrap(), 0);
        for defect in 0..6 {
            let (b, mut b_peer) = UnixStream::pair().unwrap();
            let right = ReceivedRight { fd: b.into(), is_stream_socket: defect != 0 };
            let mut bad = packet(if defect == 1 { Record::Ready } else { Record::InstallStdio { mask: if defect == 2 { 3 } else { 1 }, count: if defect == 2 { 2 } else { 1 } } }, vec![right]);
            bad.truncated = defect == 3;
            bad.ancillary_truncated = defect == 4;
            bad.unexpected_ancillary = defect == 5;
            assert!(accept_install(bad).is_err(), "{defect}");
            b_peer.set_nonblocking(true).unwrap();
            assert_eq!(b_peer.read(&mut [0]).unwrap(), 0, "rejected right {defect} closed");
        }
    }
}

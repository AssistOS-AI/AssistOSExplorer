//! Thin Linux syscall wrappers for process-bearing construction (first-G1 plan; amendment A1). Every descriptor is an
//! `OwnedFd` from the moment the kernel returns it, so a partial failure closes exactly what it acquired.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use crate::launch::{Credentials, Packet, RECORD_BYTES, ReceivedRight};

pub fn last_error() -> io::Error {
    io::Error::last_os_error()
}

pub fn errno() -> i32 {
    last_error().raw_os_error().unwrap_or(libc::EIO)
}

pub fn cstr(text: &str) -> io::Result<CString> {
    CString::new(text).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn owned(fd: libc::c_int) -> io::Result<OwnedFd> {
    if fd < 0 {
        return Err(last_error());
    }
    // SAFETY: a fresh descriptor the kernel just returned, owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Milliseconds of CLOCK_MONOTONIC. The run loop, the core's deadlines and every launch latch use this one clock.
pub fn now_ms() -> u64 {
    // SAFETY: zeroed timespec out-parameter.
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) };
    (time.tv_sec as u64).saturating_mul(1000).saturating_add(time.tv_nsec as u64 / 1_000_000)
}

pub fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    // SAFETY: zeroed stat is a valid out-parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } < 0 {
        return Err(last_error());
    }
    Ok(stat)
}

pub fn identity(stat: &libc::stat) -> (u64, u64) {
    (stat.st_dev as u64, stat.st_ino as u64)
}

/// `fstatat(dir, name, flags)`.
pub fn fstatat(dir: RawFd, name: &str, flags: libc::c_int) -> io::Result<libc::stat> {
    let name = cstr(name)?;
    // SAFETY: valid descriptor number, C string and out-parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir, name.as_ptr(), &mut stat, flags) } < 0 {
        return Err(last_error());
    }
    Ok(stat)
}

pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor number.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(last_error());
    }
    Ok(())
}

pub fn set_nonblocking(fd: RawFd, nonblocking: bool) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor number.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(last_error());
    }
    let flags = if nonblocking { flags | libc::O_NONBLOCK } else { flags & !libc::O_NONBLOCK };
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags) } < 0 {
        return Err(last_error());
    }
    Ok(())
}

pub fn dup_cloexec(fd: RawFd) -> io::Result<OwnedFd> {
    // SAFETY: fcntl duplicating a descriptor number into a fresh CLOEXEC descriptor.
    owned(unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) })
}

/// Opens `path` with `O_PATH` without following any symlink in any component (`openat2` RESOLVE_NO_SYMLINKS and
/// RESOLVE_NO_MAGICLINKS). `directory` adds `O_DIRECTORY`.
pub fn open_nofollow(dir: RawFd, path: &str, directory: bool) -> io::Result<OwnedFd> {
    let path = cstr(path)?;
    // SAFETY: zeroed open_how, then filled.
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_PATH | libc::O_CLOEXEC | if directory { libc::O_DIRECTORY } else { 0 }) as u64;
    how.resolve = libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_MAGICLINKS;
    // SAFETY: valid C string and open_how of the size passed.
    owned(unsafe { libc::syscall(libc::SYS_openat2, dir, path.as_ptr(), &how as *const libc::open_how, std::mem::size_of::<libc::open_how>()) } as libc::c_int)
}

/// A readable descriptor of the very inode an `O_PATH` descriptor names (through its `/proc/self/fd` magic link).
pub fn reopen_readable(fd: RawFd) -> io::Result<OwnedFd> {
    let path = cstr(&format!("/proc/self/fd/{fd}"))?;
    // SAFETY: valid C string.
    let reopened = owned(unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOCTTY) })?;
    let (before, after) = (identity(&fstat(fd)?), identity(&fstat(reopened.as_raw_fd())?));
    if before != after {
        return Err(io::Error::other("reopened descriptor names another file"));
    }
    Ok(reopened)
}

pub fn openat_readable(dir: RawFd, name: &str, directory: bool) -> io::Result<OwnedFd> {
    let name = cstr(name)?;
    let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: valid descriptor and C string.
    owned(unsafe { libc::openat(dir, name.as_ptr(), flags) })
}

/// Reads at most `max` bytes from the start of a descriptor (pread loop). More than `max` is an error.
pub fn read_bounded(fd: RawFd, max: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        // SAFETY: valid buffer.
        let count = unsafe { libc::pread(fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len(), out.len() as libc::off_t) };
        if count < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return Err(last_error());
        }
        if count == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&chunk[..count as usize]);
        if out.len() > max {
            return Err(io::Error::other("bounded read exceeded"));
        }
    }
}

/// Plain sequential read of a /proc file through a held directory (they report size 0 and do not support pread on
/// every kernel).
pub fn read_proc_file(dir: RawFd, name: &str, max: usize) -> io::Result<Vec<u8>> {
    let file = openat_readable(dir, name, false)?;
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        // SAFETY: valid buffer.
        let count = unsafe { libc::read(file.as_raw_fd(), chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
        if count < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return Err(last_error());
        }
        if count == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&chunk[..count as usize]);
        if out.len() > max {
            return Err(io::Error::other("proc file too large"));
        }
    }
}

pub fn pipe_cloexec() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: valid out array.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(last_error());
    }
    Ok((owned(fds[0])?, owned(fds[1])?))
}

pub fn socketpair(kind: libc::c_int) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: valid out array.
    if unsafe { libc::socketpair(libc::AF_UNIX, kind | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) } < 0 {
        return Err(last_error());
    }
    Ok((owned(fds[0])?, owned(fds[1])?))
}

pub fn set_passcred(fd: RawFd) -> io::Result<()> {
    let one: libc::c_int = 1;
    // SAFETY: valid option value of the stated size.
    if unsafe { libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_PASSCRED, &one as *const libc::c_int as *const libc::c_void, 4) } < 0 {
        return Err(last_error());
    }
    Ok(())
}

pub fn socket_type(fd: RawFd) -> io::Result<libc::c_int> {
    let mut value: libc::c_int = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: valid out-parameters.
    if unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_TYPE, &mut value as *mut libc::c_int as *mut libc::c_void, &mut length) } < 0 {
        return Err(last_error());
    }
    Ok(value)
}

/// A sealed memfd holding `bytes` (write, grow, shrink and further sealing refused): the stage reads it only at the
/// final-exec boundary, and the keeper never blocks writing an environment into a pipe.
pub fn sealed_memfd(name: &str, bytes: &[u8]) -> io::Result<OwnedFd> {
    let name = cstr(name)?;
    // SAFETY: valid C string.
    let fd = owned(unsafe { libc::syscall(libc::SYS_memfd_create, name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) } as libc::c_int)?;
    let mut written = 0;
    while written < bytes.len() {
        // SAFETY: valid slice.
        let count = unsafe { libc::write(fd.as_raw_fd(), bytes[written..].as_ptr() as *const libc::c_void, bytes.len() - written) };
        if count < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return Err(last_error());
        }
        written += count as usize;
    }
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    // SAFETY: fcntl with integer arguments.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
        return Err(last_error());
    }
    Ok(fd)
}

pub fn pidfd_open(pid: libc::pid_t) -> io::Result<OwnedFd> {
    // SAFETY: integer arguments only.
    let fd = owned(unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int)?;
    set_cloexec(fd.as_raw_fd())?;
    Ok(fd)
}

/// Signals exactly the process a pidfd names (never a raw pid). ESRCH after it exited is not an error.
pub fn pidfd_signal(pidfd: RawFd, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: integer arguments; a null siginfo.
    if unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd, signal, std::ptr::null::<libc::siginfo_t>(), 0) } < 0 {
        let error = last_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(error);
    }
    Ok(())
}

/// True once the process a pidfd names has exited (the pidfd becomes readable).
pub fn pidfd_exited(pidfd: RawFd) -> bool {
    let mut entry = libc::pollfd { fd: pidfd, events: libc::POLLIN, revents: 0 };
    // SAFETY: one valid pollfd, zero timeout.
    let ready = unsafe { libc::poll(&mut entry, 1, 0) };
    ready > 0 && entry.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0
}

/// Wait status of one reaped child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reaped {
    Exited(i64),
    Signaled(i32),
}

/// Reaps the child a pidfd names without blocking. `None`: still running (or already reaped elsewhere).
pub fn pidfd_reap(pidfd: RawFd) -> Option<Reaped> {
    // SAFETY: zeroed siginfo out-parameter; P_PIDFD names exactly this child.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::waitid(libc::P_PIDFD, pidfd as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG) };
    if result < 0 {
        return None;
    }
    // SAFETY: si_pid/si_status are valid for a CLD_* siginfo; si_pid 0 means nothing was reaped.
    let (pid, status, code) = unsafe { (info.si_pid(), info.si_status(), info.si_code) };
    if pid == 0 {
        return None;
    }
    Some(if code == libc::CLD_EXITED { Reaped::Exited(status as i64) } else { Reaped::Signaled(status) })
}

/// The pid of one waitable child, without reaping it (`WNOWAIT`).
pub fn peek_child() -> Option<libc::pid_t> {
    // SAFETY: zeroed siginfo out-parameter.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::waitid(libc::P_ALL, 0, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    if result < 0 {
        return None;
    }
    // SAFETY: as above.
    let pid = unsafe { info.si_pid() };
    (pid > 0).then_some(pid)
}

/// `struct clone_args` (kernel ABI, version 0: 64 bytes).
#[repr(C)]
#[derive(Default)]
pub struct CloneArgs {
    pub flags: u64,
    pub pidfd: u64,
    pub child_tid: u64,
    pub parent_tid: u64,
    pub exit_signal: u64,
    pub stack: u64,
    pub stack_size: u64,
    pub tls: u64,
}

/// Sends one fixed-size private record, optionally with SCM_RIGHTS. Never used on keeper fd 3.
pub fn send_record(fd: RawFd, bytes: &[u8; RECORD_BYTES], rights: &[RawFd]) -> io::Result<()> {
    let mut iov = libc::iovec { iov_base: bytes.as_ptr() as *mut libc::c_void, iov_len: bytes.len() };
    // SAFETY: zeroed msghdr, then filled with valid pointers that outlive the call.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    let space = unsafe { libc::CMSG_SPACE((rights.len() * std::mem::size_of::<RawFd>()) as u32) } as usize;
    let mut control = vec![0u8; space.max(1)];
    if !rights.is_empty() {
        message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
        message.msg_controllen = space as _;
        // SAFETY: control has CMSG_SPACE bytes for exactly these rights.
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN((rights.len() * std::mem::size_of::<RawFd>()) as u32) as _;
            std::ptr::copy_nonoverlapping(rights.as_ptr(), libc::CMSG_DATA(header) as *mut RawFd, rights.len());
        }
    }
    loop {
        // SAFETY: a valid msghdr.
        let sent = unsafe { libc::sendmsg(fd, &message, libc::MSG_NOSIGNAL) };
        if sent < 0 && errno() == libc::EINTR {
            continue;
        }
        if sent < 0 {
            return Err(last_error());
        }
        if sent as usize != bytes.len() {
            return Err(io::Error::other("short private record"));
        }
        return Ok(());
    }
}

/// Outcome of one nonblocking private receive.
pub enum Received {
    Packet(Packet),
    WouldBlock,
    Eof,
}

/// Receives one private record with kernel credentials and up to three rights. Every received right is owned at once.
pub fn recv_packet(fd: RawFd, nonblocking: bool) -> io::Result<Received> {
    let mut buffer = [0u8; RECORD_BYTES + 1];
    let mut iov = libc::iovec { iov_base: buffer.as_mut_ptr() as *mut libc::c_void, iov_len: buffer.len() };
    let credentials_space = unsafe { libc::CMSG_SPACE(std::mem::size_of::<libc::ucred>() as u32) } as usize;
    let rights_space = unsafe { libc::CMSG_SPACE((4 * std::mem::size_of::<RawFd>()) as u32) } as usize;
    let mut control = vec![0u8; credentials_space + rights_space];
    // SAFETY: zeroed msghdr filled with valid pointers.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    message.msg_controllen = control.len() as _;
    let flags = libc::MSG_CMSG_CLOEXEC | if nonblocking { libc::MSG_DONTWAIT } else { 0 };
    let count = loop {
        // SAFETY: a valid msghdr.
        let count = unsafe { libc::recvmsg(fd, &mut message, flags) };
        if count < 0 && errno() == libc::EINTR {
            continue;
        }
        break count;
    };
    if count < 0 {
        let error = last_error();
        if matches!(error.raw_os_error(), Some(libc::EAGAIN)) {
            return Ok(Received::WouldBlock);
        }
        return Err(error);
    }
    let mut credentials = None;
    let mut rights: Vec<ReceivedRight> = Vec::new();
    let mut unexpected = false;
    // SAFETY: walking the control buffer the kernel filled, bounded by msg_controllen.
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            let data = libc::CMSG_DATA(header);
            let length = (*header).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
            match ((*header).cmsg_level, (*header).cmsg_type) {
                (libc::SOL_SOCKET, libc::SCM_RIGHTS) => {
                    for index in 0..length / std::mem::size_of::<RawFd>() {
                        let raw = std::ptr::read_unaligned((data as *const RawFd).add(index));
                        let fd = OwnedFd::from_raw_fd(raw);
                        let stream = fstat(fd.as_raw_fd()).is_ok_and(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFSOCK)
                            && socket_type(fd.as_raw_fd()).is_ok_and(|kind| kind == libc::SOCK_STREAM);
                        rights.push(ReceivedRight { fd, is_stream_socket: stream });
                    }
                }
                (libc::SOL_SOCKET, libc::SCM_CREDENTIALS) if length >= std::mem::size_of::<libc::ucred>() && credentials.is_none() => {
                    let value: libc::ucred = std::ptr::read_unaligned(data as *const libc::ucred);
                    credentials = Some(Credentials { pid: value.pid as i64, uid: value.uid, gid: value.gid });
                }
                _ => unexpected = true,
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    if count == 0 && rights.is_empty() {
        return Ok(Received::Eof);
    }
    Ok(Received::Packet(Packet {
        bytes: buffer[..(count as usize).min(RECORD_BYTES + 1)].to_vec(),
        credentials,
        rights,
        truncated: message.msg_flags & libc::MSG_TRUNC != 0 || count as usize > RECORD_BYTES,
        ancillary_truncated: message.msg_flags & libc::MSG_CTRUNC != 0,
        unexpected_ancillary: unexpected,
    }))
}

/// Brings the loopback interface of the caller's current network namespace up (no route, veth or forwarding change).
/// Async-signal-safe: usable between clone and exec.
///
/// # Safety
/// Only syscalls on stack data.
pub unsafe fn loopback_up() -> bool {
    unsafe {
        let socket = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
        if socket < 0 {
            return false;
        }
        let mut request: libc::ifreq = std::mem::zeroed();
        for (index, byte) in b"lo".iter().enumerate() {
            request.ifr_name[index] = *byte as libc::c_char;
        }
        let ok = libc::ioctl(socket, libc::SIOCGIFFLAGS as _, &mut request) == 0 && {
            request.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
            libc::ioctl(socket, libc::SIOCSIFFLAGS as _, &request) == 0
        };
        libc::close(socket);
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::{Record, receive};

    #[test]
    fn private_records_carry_kernel_credentials_and_reject_spoofed_payload_pids() {
        let (keeper, stage) = socketpair(libc::SOCK_SEQPACKET).unwrap();
        set_passcred(keeper.as_raw_fd()).unwrap();
        send_record(stage.as_raw_fd(), &Record::Ready.encode().unwrap(), &[]).unwrap();
        let Received::Packet(packet) = recv_packet(keeper.as_raw_fd(), true).unwrap() else { panic!("packet") };
        // SAFETY: getpid/getuid/getgid have no preconditions.
        let me = Credentials { pid: unsafe { libc::getpid() } as i64, uid: unsafe { libc::getuid() }, gid: unsafe { libc::getgid() } };
        assert_eq!(packet.credentials, Some(me), "the kernel supplies the sender, not the payload");
        let (record, rights) = receive(packet, true, me).unwrap();
        assert_eq!(record, Record::Ready);
        assert!(rights.is_empty());
        // A record whose payload is altered (a pid smuggled into reserved bytes) is refused by the decoder.
        let mut spoof = Record::Ready.encode().unwrap();
        spoof[8..12].copy_from_slice(&4242u32.to_le_bytes());
        send_record(stage.as_raw_fd(), &spoof, &[]).unwrap();
        let Received::Packet(packet) = recv_packet(keeper.as_raw_fd(), true).unwrap() else { panic!() };
        assert!(receive(packet, true, me).is_err());
        // Another credential than the bound one is refused.
        send_record(stage.as_raw_fd(), &Record::Ready.encode().unwrap(), &[]).unwrap();
        let Received::Packet(packet) = recv_packet(keeper.as_raw_fd(), true).unwrap() else { panic!() };
        assert!(receive(packet, true, Credentials { pid: me.pid + 1, ..me }).is_err());
        assert!(matches!(recv_packet(keeper.as_raw_fd(), true).unwrap(), Received::WouldBlock));
        drop(stage);
        assert!(matches!(recv_packet(keeper.as_raw_fd(), true).unwrap(), Received::Eof));
    }

    #[test]
    fn rights_transfer_and_rejection_close_every_received_copy() {
        use std::io::Read;
        use std::os::unix::net::UnixStream;
        let (keeper, stage) = socketpair(libc::SOCK_SEQPACKET).unwrap();
        let (a, mut a_peer) = UnixStream::pair().unwrap();
        let (b, mut b_peer) = UnixStream::pair().unwrap();
        let install = Record::InstallStdio { mask: 3, count: 2 }.encode().unwrap();
        send_record(keeper.as_raw_fd(), &install, &[a.as_raw_fd(), b.as_raw_fd()]).unwrap();
        drop((a, b));
        let Received::Packet(packet) = recv_packet(stage.as_raw_fd(), true).unwrap() else { panic!() };
        assert_eq!(packet.rights.len(), 2);
        assert!(packet.rights.iter().all(|right| right.is_stream_socket));
        // Rejected (wrong declared count): every right closes, so both peers see EOF.
        let mut wrong = packet;
        wrong.bytes = Record::InstallStdio { mask: 7, count: 3 }.encode().unwrap().to_vec();
        let credentials = wrong.credentials;
        assert!(receive(wrong, false, credentials.unwrap_or(Credentials { pid: 0, uid: 0, gid: 0 })).is_err());
        for peer in [&mut a_peer, &mut b_peer] {
            peer.set_nonblocking(true).unwrap();
            assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        }
        // A datagram-like right is not a stream socket.
        let (left, _right) = socketpair(libc::SOCK_SEQPACKET).unwrap();
        send_record(keeper.as_raw_fd(), &Record::InstallStdio { mask: 1, count: 1 }.encode().unwrap(), &[left.as_raw_fd()]).unwrap();
        let Received::Packet(packet) = recv_packet(stage.as_raw_fd(), true).unwrap() else { panic!() };
        assert!(!packet.rights[0].is_stream_socket);
    }

    #[test]
    fn pidfd_reaps_exactly_its_child_and_signals_never_reach_a_reaped_pid() {
        // A child sharing the descriptor table (no inherited copies of parallel tests' sockets); it only pauses.
        let pid = crate::linux::launcher::tests::test_child();
        if pid == 0 {
            unsafe {
                libc::pause();
                libc::_exit(0);
            }
        }
        let pidfd = pidfd_open(pid).unwrap();
        assert!(!pidfd_exited(pidfd.as_raw_fd()));
        assert_eq!(pidfd_reap(pidfd.as_raw_fd()), None);
        pidfd_signal(pidfd.as_raw_fd(), libc::SIGKILL).unwrap();
        let mut reaped = None;
        for _ in 0..500 {
            if let Some(status) = pidfd_reap(pidfd.as_raw_fd()) {
                reaped = Some(status);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(reaped, Some(Reaped::Signaled(libc::SIGKILL)));
        assert!(pidfd_exited(pidfd.as_raw_fd()));
        // After reaping, signalling through the pidfd is harmless (ESRCH is not an error) and cannot reach a reused pid.
        pidfd_signal(pidfd.as_raw_fd(), libc::SIGKILL).unwrap();
    }

    #[test]
    fn sealed_memfd_is_immutable_and_bounded_reads_refuse_more() {
        let fd = sealed_memfd("env", b"A=1\0B=2\0").unwrap();
        assert_eq!(read_bounded(fd.as_raw_fd(), 64).unwrap(), b"A=1\0B=2\0");
        assert!(read_bounded(fd.as_raw_fd(), 4).is_err());
        // SAFETY: a write attempt on a sealed memfd.
        let written = unsafe { libc::write(fd.as_raw_fd(), b"x".as_ptr() as *const libc::c_void, 1) };
        assert!(written < 0 && errno() == libc::EPERM);
    }

    #[test]
    fn nofollow_open_refuses_symlinks_in_any_component() {
        let base = std::env::temp_dir().join(format!("rw-keeper-sys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("real")).unwrap();
        std::fs::write(base.join("real/file"), b"x").unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        let root = base.to_str().unwrap();
        assert!(open_nofollow(libc::AT_FDCWD, &format!("{root}/real/file"), false).is_ok());
        assert!(open_nofollow(libc::AT_FDCWD, &format!("{root}/link/file"), false).is_err());
        assert!(open_nofollow(libc::AT_FDCWD, &format!("{root}/real"), true).is_ok());
        let held = open_nofollow(libc::AT_FDCWD, &format!("{root}/real/file"), false).unwrap();
        let readable = reopen_readable(held.as_raw_fd()).unwrap();
        assert_eq!(read_bounded(readable.as_raw_fd(), 8).unwrap(), b"x");
        std::fs::remove_dir_all(&base).unwrap();
    }
}

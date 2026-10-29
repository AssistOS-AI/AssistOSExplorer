//! The private AF_UNIX mailbox endpoint (plan section 5.6; T0 base section 8 "Native frame"). Linux only.
//!
//! Roles: the target helper binds and serves the mailbox Ploinky provisioned (`serve`); the worker connects to it as
//! the native worker-side peer (`worker-peer`). Descriptors travel only as SCM_RIGHTS attached to the first byte of a
//! frame. Every receive is `recvmsg` with a control buffer and `MSG_CMSG_CLOEXEC`, never `read(2)` (which would silently
//! discard stray rights). The first byte of each frame is received alone, so rights attached to any later byte are seen
//! in a later call; every other read is capped at the frame's remaining length, so nothing of the next frame (or its
//! rights) is consumed. Rights after the first byte, `MSG_CTRUNC`, a control message other than SCM_RIGHTS and a
//! malformed rights payload refuse the frame at once ([`RecvError::Ancillary`]): reading stops, every descriptor
//! received so far is closed, and the caller must close the connection (the stream is no longer framed). Received
//! descriptors are owned (`OwnedFd`), so dropping a frame the validator refuses closes every one of them too.
//!
//! Kernel peer credentials (`SO_PEERCRED`) are recorded for diagnostics only. They never authorize: numeric UIDs may
//! coincide across containers (plan: "Kernel peer credentials alone are insufficient").

use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::frame::Ancillary;

const FD_BYTES: usize = std::mem::size_of::<RawFd>();

/// Receive bounds for one frame.
#[derive(Clone, Copy, Debug)]
pub struct RecvLimits {
    /// The whole frame including its 4-byte length prefix (`frameBytes`).
    pub frame_bytes: usize,
    /// Control-buffer capacity in descriptors (`descriptorsPerFrame`); more attached descriptors set `truncated`.
    pub descriptors_per_frame: usize,
    /// Wait for the first byte of a frame; None waits indefinitely.
    pub idle_timeout: Option<Duration>,
    /// From the first byte to the last (`partialFrameTimeoutMs`).
    pub partial_timeout: Duration,
}

impl Default for RecvLimits {
    fn default() -> Self {
        RecvLimits { frame_bytes: 589_824, descriptors_per_frame: 8, idle_timeout: None, partial_timeout: Duration::from_millis(5000) }
    }
}

/// One complete frame as received. Dropping it closes every received descriptor.
#[derive(Debug)]
pub struct ReceivedFrame {
    pub bytes: Vec<u8>,
    pub descriptors: Vec<OwnedFd>,
    pub ancillary: Ancillary,
}

#[derive(Debug)]
pub enum RecvError {
    /// Orderly EOF before the first byte of a frame.
    Closed,
    /// EOF inside a frame.
    Truncated,
    /// The length prefix exceeds `frame_bytes`: the stream cannot be resynchronized; close the connection.
    Oversize,
    /// No first byte within `idle_timeout`, or the frame did not complete within `partial_timeout`.
    Timeout,
    /// Rights after the first byte, `MSG_CTRUNC` or malformed control data: refused at once, every received descriptor
    /// already closed; close the connection.
    Ancillary(Ancillary),
    Io(io::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerCredentials {
    pub pid: i32,
    pub uid: u32,
    pub gid: u32,
}

fn cvt(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(result) }
}

fn socket() -> io::Result<OwnedFd> {
    // SAFETY: plain socket(2); the descriptor is owned immediately.
    let fd = cvt(unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) })?;
    // SAFETY: a freshly created descriptor nobody else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn address(path: &Path) -> io::Result<(libc::sockaddr_un, libc::socklen_t)> {
    // SAFETY: an all-zero sockaddr_un is valid.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.len() >= addr.sun_path.len() || bytes.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "mailbox path length"));
    }
    for (slot, byte) in addr.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let length = std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1;
    Ok((addr, length as libc::socklen_t))
}

/// The helper's listening mailbox. The socket file is created by `bind` (an existing path is refused, never unlinked)
/// with mode 0600, and removed on drop only while it is still the same file.
#[derive(Debug)]
pub struct Listener {
    fd: OwnedFd,
    path: PathBuf,
    identity: (u64, u64),
}

impl Listener {
    pub fn bind(path: &Path) -> io::Result<Listener> {
        let fd = socket()?;
        let (addr, length) = address(path)?;
        // SAFETY: a valid sockaddr_un of `length` bytes.
        cvt(unsafe { libc::bind(fd.as_raw_fd(), &addr as *const libc::sockaddr_un as *const libc::sockaddr, length) })?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let metadata = std::fs::symlink_metadata(path)?;
        // SAFETY: listen(2) on an owned socket.
        cvt(unsafe { libc::listen(fd.as_raw_fd(), 8) })?;
        Ok(Listener { fd, path: path.to_path_buf(), identity: (metadata.dev(), metadata.ino()) })
    }

    pub fn accept(&self) -> io::Result<Connection> {
        loop {
            // SAFETY: accept4 with null address output.
            let fd = unsafe { libc::accept4(self.fd.as_raw_fd(), std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
            if fd >= 0 {
                // SAFETY: a new descriptor returned by accept4.
                return Ok(Connection { fd: unsafe { OwnedFd::from_raw_fd(fd) } });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path) {
            if (metadata.dev(), metadata.ino()) == self.identity {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

/// One connected mailbox stream.
#[derive(Debug)]
pub struct Connection {
    fd: OwnedFd,
}

impl std::os::fd::AsFd for Connection {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.fd.as_fd()
    }
}

/// An 8-byte aligned control buffer.
struct Control {
    words: Vec<u64>,
    len: usize,
}

impl Control {
    fn new(bytes: usize) -> Control {
        Control { words: vec![0u64; bytes.div_ceil(8).max(1)], len: bytes }
    }
    fn as_mut_ptr(&mut self) -> *mut libc::c_void {
        self.words.as_mut_ptr() as *mut libc::c_void
    }
}

fn rights_space(count: usize) -> usize {
    // SAFETY: CMSG_SPACE is a pure size computation.
    unsafe { libc::CMSG_SPACE((count * FD_BYTES) as libc::c_uint) as usize }
}

/// Per-frame receive facts.
#[derive(Default)]
struct Facts {
    count: usize,
    truncated: bool,
    malformed: bool,
    rights_after_first_byte: bool,
}

impl Facts {
    fn ancillary(&self) -> Ancillary {
        Ancillary { count: self.count, truncated: self.truncated, well_formed: !self.malformed, on_first_byte: !self.rights_after_first_byte }
    }

    fn violated(&self) -> bool {
        self.truncated || self.malformed || self.rights_after_first_byte
    }
}

impl Connection {
    pub fn connect(path: &Path) -> io::Result<Connection> {
        let fd = socket()?;
        let (addr, length) = address(path)?;
        // SAFETY: a valid sockaddr_un of `length` bytes.
        cvt(unsafe { libc::connect(fd.as_raw_fd(), &addr as *const libc::sockaddr_un as *const libc::sockaddr, length) })?;
        Ok(Connection { fd })
    }

    /// A connected pair (tests and in-process peers).
    pub fn pair() -> io::Result<(Connection, Connection)> {
        let mut fds = [0 as RawFd; 2];
        // SAFETY: valid output array of two descriptors.
        cvt(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) })?;
        // SAFETY: two new descriptors returned by socketpair.
        Ok(unsafe { (Connection { fd: OwnedFd::from_raw_fd(fds[0]) }, Connection { fd: OwnedFd::from_raw_fd(fds[1]) }) })
    }

    /// `SO_PEERCRED`: diagnostics only, never authorization.
    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        // SAFETY: an all-zero ucred is valid.
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: getsockopt into a correctly sized ucred.
        cvt(unsafe {
            libc::getsockopt(self.fd.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut credentials as *mut libc::ucred as *mut libc::c_void, &mut length)
        })?;
        Ok(PeerCredentials { pid: credentials.pid, uid: credentials.uid, gid: credentials.gid })
    }

    /// One `sendmsg` of `bytes`, with `descriptors` attached as one SCM_RIGHTS message when non-empty. Returns the bytes
    /// the kernel accepted. Low-level: [`Connection::send_frame`] is the normal sender.
    pub fn send_chunk(&self, bytes: &[u8], descriptors: &[BorrowedFd<'_>]) -> io::Result<usize> {
        let mut iov = libc::iovec { iov_base: bytes.as_ptr() as *mut libc::c_void, iov_len: bytes.len() };
        let mut control = Control::new(if descriptors.is_empty() { 0 } else { rights_space(descriptors.len()) });
        // SAFETY: zeroed msghdr, then pointers into live local buffers; the control message is built as cmsg(3) shows.
        unsafe {
            let mut message: libc::msghdr = std::mem::zeroed();
            message.msg_iov = &mut iov;
            message.msg_iovlen = 1;
            if !descriptors.is_empty() {
                message.msg_control = control.as_mut_ptr();
                message.msg_controllen = control.len as _;
                let header = libc::CMSG_FIRSTHDR(&message);
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN((descriptors.len() * FD_BYTES) as libc::c_uint) as _;
                let data = libc::CMSG_DATA(header) as *mut RawFd;
                for (index, descriptor) in descriptors.iter().enumerate() {
                    std::ptr::write_unaligned(data.add(index), descriptor.as_raw_fd());
                }
            }
            loop {
                let sent = libc::sendmsg(self.fd.as_raw_fd(), &message, libc::MSG_NOSIGNAL);
                if sent >= 0 {
                    return Ok(sent as usize);
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }

    /// Sends one frame; descriptors ride on its first byte (the first `sendmsg`).
    pub fn send_frame(&self, frame: &[u8], descriptors: &[BorrowedFd<'_>]) -> io::Result<()> {
        if frame.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty frame"));
        }
        let mut sent = self.send_chunk(frame, descriptors)?;
        while sent < frame.len() {
            sent += self.send_chunk(&frame[sent..], &[])?;
        }
        Ok(())
    }

    fn wait_readable(&self, deadline: Option<Instant>) -> Result<(), RecvError> {
        loop {
            let timeout = match deadline {
                None => -1,
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(RecvError::Timeout);
                    }
                    left.as_millis().clamp(1, i32::MAX as u128) as libc::c_int
                }
            };
            let mut poll = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
            if ready > 0 {
                return Ok(());
            }
            if ready == 0 {
                return Err(RecvError::Timeout);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(RecvError::Io(error));
            }
        }
    }

    /// One `recvmsg` into `buffer` (never more than its length). Rights are taken into `descriptors`.
    fn recv_once(&self, buffer: &mut [u8], frame_offset: usize, capacity: usize, descriptors: &mut Vec<OwnedFd>, facts: &mut Facts) -> Result<usize, RecvError> {
        let mut iov = libc::iovec { iov_base: buffer.as_mut_ptr() as *mut libc::c_void, iov_len: buffer.len() };
        let mut control = Control::new(rights_space(capacity));
        // SAFETY: zeroed msghdr with pointers into live local buffers; the kernel fills at most msg_controllen bytes.
        let (count, flags) = unsafe {
            let mut message: libc::msghdr = std::mem::zeroed();
            message.msg_iov = &mut iov;
            message.msg_iovlen = 1;
            message.msg_control = control.as_mut_ptr();
            message.msg_controllen = control.len as _;
            let count = loop {
                let count = libc::recvmsg(self.fd.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC);
                if count >= 0 {
                    break count;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(RecvError::Io(error));
                }
            };
            let mut header = libc::CMSG_FIRSTHDR(&message);
            while !header.is_null() {
                let length = (*header).cmsg_len as usize;
                let base = libc::CMSG_LEN(0) as usize;
                if (*header).cmsg_level == libc::SOL_SOCKET && (*header).cmsg_type == libc::SCM_RIGHTS && length >= base {
                    let payload = length - base;
                    if payload % FD_BYTES != 0 {
                        facts.malformed = true;
                    }
                    let data = libc::CMSG_DATA(header) as *const RawFd;
                    for index in 0..payload / FD_BYTES {
                        let fd = std::ptr::read_unaligned(data.add(index));
                        if fd >= 0 {
                            // The kernel installed this descriptor for us: own it at once so it is always closed.
                            descriptors.push(OwnedFd::from_raw_fd(fd));
                        } else {
                            facts.malformed = true;
                        }
                    }
                    if payload >= FD_BYTES && frame_offset != 0 {
                        facts.rights_after_first_byte = true;
                    }
                } else {
                    facts.malformed = true;
                }
                header = libc::CMSG_NXTHDR(&message, header);
            }
            (count as usize, message.msg_flags)
        };
        if flags & libc::MSG_CTRUNC != 0 {
            facts.truncated = true;
        }
        facts.count = descriptors.len();
        Ok(count)
    }

    fn fill(&self, buffer: &mut [u8], start: usize, capacity: usize, deadline: Instant, descriptors: &mut Vec<OwnedFd>, facts: &mut Facts) -> Result<(), RecvError> {
        let mut filled = 0;
        while filled < buffer.len() {
            self.wait_readable(Some(deadline))?;
            let count = self.recv_once(&mut buffer[filled..], start + filled, capacity, descriptors, facts)?;
            if facts.violated() {
                // Stop reading this frame; the caller's descriptors are dropped (closed) with the error.
                return Err(RecvError::Ancillary(facts.ancillary()));
            }
            if count == 0 {
                return Err(RecvError::Truncated);
            }
            filled += count;
        }
        Ok(())
    }

    /// Receives exactly one frame (`u32be(totalRemainingBytes)` and that many bytes).
    pub fn recv_frame(&self, limits: RecvLimits) -> Result<ReceivedFrame, RecvError> {
        let capacity = limits.descriptors_per_frame;
        let mut descriptors = Vec::new();
        let mut facts = Facts::default();
        let mut prefix = [0u8; 4];
        self.wait_readable(limits.idle_timeout.map(|idle| Instant::now() + idle))?;
        // The first byte alone: rights attached to it arrive with exactly this call.
        let first = self.recv_once(&mut prefix[..1], 0, capacity, &mut descriptors, &mut facts)?;
        if facts.violated() {
            return Err(RecvError::Ancillary(facts.ancillary()));
        }
        if first == 0 {
            return Err(RecvError::Closed);
        }
        let deadline = Instant::now() + limits.partial_timeout;
        self.fill(&mut prefix[1..], 1, capacity, deadline, &mut descriptors, &mut facts)?;
        let remaining = u32::from_be_bytes(prefix) as usize;
        if remaining > limits.frame_bytes.saturating_sub(4) {
            return Err(RecvError::Oversize);
        }
        let mut bytes = vec![0u8; 4 + remaining];
        bytes[..4].copy_from_slice(&prefix);
        self.fill(&mut bytes[4..], 4, capacity, deadline, &mut descriptors, &mut facts)?;
        Ok(ReceivedFrame { bytes, descriptors, ancillary: facts.ancillary() })
    }
}

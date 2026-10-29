//! The keeper's framed-channel I/O on fd 3, portable (contract §3 "No descriptors travel on fd 3"; R1.4).
//!
//! The writer issues only plain `write(2)` and the reader only plain `read(2)`: no `sendmsg`/`recvmsg` with control
//! data, so the keeper never attaches a descriptor, and on Linux a plain read discards any SCM_RIGHTS the peer
//! attaches. This module is NOT `cfg(target_os = "linux")`: `tests/channel_no_ancillary.rs` runs it on the host and
//! proves with `recvmsg` that no control message arrives (NC-3c mutant: a writer using `sendmsg` with SCM_RIGHTS).
//! The production run loop (`linux::runloop`) uses exactly this writer and reader.

use std::collections::VecDeque;
use std::io;
use std::os::fd::RawFd;

/// The single write syscall of the channel (the NC-3c mutant replaces this body).
fn raw_write(fd: RawFd, bytes: &[u8]) -> isize {
    // SAFETY: valid slice; plain write(2) with no ancillary data.
    unsafe { libc::write(fd, bytes.as_ptr() as *const libc::c_void, bytes.len()) as isize }
}

/// Plain read(2).
pub fn read(fd: RawFd, buffer: &mut [u8]) -> io::Result<usize> {
    // SAFETY: valid buffer.
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len()) };
    if count < 0 { Err(io::Error::last_os_error()) } else { Ok(count as usize) }
}

/// Outbound frames with their request ids (None for events), written in order, non-blocking-friendly.
#[derive(Debug, Default)]
pub struct ChannelWriter {
    queue: VecDeque<(Option<i64>, Vec<u8>, usize)>,
    bytes: usize,
}

impl ChannelWriter {
    pub fn new() -> Self {
        ChannelWriter::default()
    }

    pub fn enqueue(&mut self, id: Option<i64>, frame: Vec<u8>) {
        self.bytes += frame.len();
        self.queue.push_back((id, frame, 0));
    }

    /// Bytes queued and not yet accepted by the kernel.
    pub fn pending_bytes(&self) -> usize {
        self.bytes
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Writes as much as the kernel accepts. Returns the ids of replies that are now completely written. `WouldBlock`
    /// stops quietly; any other error is returned (the channel is gone).
    pub fn flush(&mut self, fd: RawFd) -> io::Result<Vec<i64>> {
        let mut done = Vec::new();
        while let Some((id, frame, written)) = self.queue.front_mut() {
            let count = raw_write(fd, &frame[*written..]);
            if count < 0 {
                let error = io::Error::last_os_error();
                if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) {
                    break;
                }
                return Err(error);
            }
            *written += count as usize;
            self.bytes -= count as usize;
            if *written == frame.len() {
                if let Some(id) = *id {
                    done.push(id);
                }
                self.queue.pop_front();
            }
        }
        Ok(done)
    }
}

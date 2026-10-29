//! The keeper's single-threaded event loop on Linux (v1 wire contract §2-§5). Compiled for musl and type-checked; NOT
//! executed in this pass.
//!
//! | Event | Effect |
//! |---|---|
//! | Frame | `KeeperCore::handle_frame` (ids, keeper gate, in-flight and PTY windows, dispatch) |
//! | Violation (decoder, structural, bounds) | Teardown, exit 65 |
//! | EOF on fd 3 | Teardown; exit 66 before `commit_keeper`, 0 after |
//! | Reaped child | `KeeperCore::child_exited` with its exit code or signal name |
//! | Outbound backlog above `maxOutboundBytes` | The supervisor is not reading: teardown, exit 65 |
//! | `remove_runtime` / `shutdown` reply flushed | exit 0 |
//! Writes go through `channel::ChannelWriter` (plain write(2), no ancillary data) and reads through `channel::read`.

use std::io;
use std::time::Instant;

use rw_proto::frame::{DecodeEvent, FrameDecoder, encode_frame};
use rw_proto::json::Value;
use rw_proto::keeper_limits::KeeperLimits;

use crate::args::CHANNEL_FD;
use crate::channel::{ChannelWriter, read};
use crate::core::{Handled, KeeperCore, KeeperOs};

fn signal_name(signal: i32) -> &'static str {
    match signal {
        libc::SIGKILL => "SIGKILL",
        libc::SIGTERM => "SIGTERM",
        libc::SIGINT => "SIGINT",
        libc::SIGHUP => "SIGHUP",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGILL => "SIGILL",
        libc::SIGFPE => "SIGFPE",
        _ => "SIGUNKNOWN",
    }
}

fn reap<O: KeeperOs>(core: &mut KeeperCore<O>) {
    loop {
        let mut status = 0;
        // SAFETY: valid out-parameter; WNOHANG never blocks. The keeper is a subreaper, so orphaned descendants are
        // reaped here too.
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid <= 0 {
            return;
        }
        let (code, signal) = if libc::WIFEXITED(status) {
            (Some(libc::WEXITSTATUS(status) as i64), None)
        } else if libc::WIFSIGNALED(status) {
            (None, Some(signal_name(libc::WTERMSIG(status))))
        } else {
            continue;
        };
        core.child_exited(pid as i64, code, signal);
    }
}

fn enqueue_outbound<O: KeeperOs>(core: &mut KeeperCore<O>, writer: &mut ChannelWriter, limits: &KeeperLimits) -> Result<(), &'static str> {
    for frame in core.take_outbound() {
        let id = if frame.has("event") { None } else { frame.get("id").and_then(Value::as_safe_int) };
        let bytes = encode_frame(&frame, limits.max_frame_bytes as usize).map_err(|_| "reply_too_large")?;
        writer.enqueue(id, bytes);
    }
    Ok(())
}

/// Runs until the channel ends. `hello` is the first frame written. Returns the process exit code.
pub fn run<O: KeeperOs>(core: &mut KeeperCore<O>, limits: KeeperLimits, hello: Value) -> i32 {
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    // SAFETY: fcntl on our own descriptor.
    unsafe {
        let flags = libc::fcntl(CHANNEL_FD, libc::F_GETFL);
        libc::fcntl(CHANNEL_FD, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let mut decoder = FrameDecoder::new(limits.max_frame_bytes as usize, limits.partial_frame_deadline_ms as u64);
    let mut writer = ChannelWriter::new();
    let mut committed = false;
    match encode_frame(&hello, limits.max_frame_bytes as usize) {
        Ok(bytes) => writer.enqueue(None, bytes),
        Err(_) => return 64,
    }
    let mut buffer = vec![0u8; 64 * 1024];
    let code = 'outer: loop {
        let current = now();
        let deadline = [decoder.deadline(), core.next_deadline(), Some(current + 200)].into_iter().flatten().min().unwrap_or(current + 200);
        let timeout = deadline.saturating_sub(current).min(200) as libc::c_int;
        let mut poll = libc::pollfd { fd: CHANNEL_FD, events: libc::POLLIN | if writer.is_empty() { 0 } else { libc::POLLOUT }, revents: 0 };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
        if ready < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            break if committed { 0 } else { 66 };
        }
        reap(core);
        let current = now();
        if poll.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            match read(CHANNEL_FD, &mut buffer) {
                Ok(0) => break if committed { 0 } else { 66 },
                Ok(count) => {
                    let mut events = Vec::new();
                    decoder.push(&buffer[..count], current, &mut events);
                    // Per-op caps use the re-encoded frame length, as keeperFrames `encodedBytes` does.
                    let _ = decoder.take_lengths();
                    for event in events {
                        match event {
                            DecodeEvent::Violation(_) => break 'outer 65,
                            DecodeEvent::Frame(frame) => {
                                if let Handled::Exit { code, .. } = core.handle_frame(&frame, current) {
                                    break 'outer code;
                                }
                                committed = true;
                            }
                        }
                    }
                }
                Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {}
                Err(_) => break if committed { 0 } else { 66 },
            }
        }
        let mut events = Vec::new();
        decoder.poll(current, &mut events);
        if !events.is_empty() {
            break 65;
        }
        core.pump_pty_input();
        core.tick(current);
        if enqueue_outbound(core, &mut writer, &limits).is_err() {
            break 65;
        }
        match writer.flush(CHANNEL_FD) {
            Ok(done) => {
                for id in done {
                    core.reply_flushed(id);
                }
            }
            Err(_) => break if committed { 0 } else { 66 },
        }
        if writer.pending_bytes() as i64 > limits.max_outbound_bytes {
            break 65;
        }
        if let Some(code) = core.exit_after_flush() {
            if writer.is_empty() {
                break code;
            }
        }
    };
    core.shutdown();
    let _ = enqueue_outbound(core, &mut writer, &limits);
    let _ = writer.flush(CHANNEL_FD);
    for _ in 0..50 {
        reap(core);
        if core.live_servers().is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    code
}

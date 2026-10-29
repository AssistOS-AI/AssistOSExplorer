//! NC-3c (R1.4): the keeper's channel writer attaches no control data. Portable: AF_UNIX socketpairs deliver
//! SCM_RIGHTS through recvmsg on Darwin and Linux alike, and the property depends on the writer's own syscall path.
//! Exactly two tests (AC-16 checks the count).

use std::os::fd::RawFd;

use rw_keeper::channel::ChannelWriter;
use rw_proto::frame::encode_frame;
use rw_proto::json::{int, obj, text};

fn socketpair() -> (RawFd, RawFd) {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: valid out array.
    assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
    (fds[0], fds[1])
}

/// One recvmsg with room for a control message. Returns (data, control length, flags).
fn recv_with_control(fd: RawFd) -> (Vec<u8>, usize, i32) {
    let mut data = vec![0u8; 4096];
    let mut control = [0u8; 256];
    let mut iov = libc::iovec { iov_base: data.as_mut_ptr() as *mut libc::c_void, iov_len: data.len() };
    // SAFETY: zeroed msghdr, then valid pointers into live buffers.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1 as _;
    message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    message.msg_controllen = control.len() as _;
    let count = unsafe { libc::recvmsg(fd, &mut message, 0) };
    assert!(count >= 0, "recvmsg failed: {}", std::io::Error::last_os_error());
    data.truncate(count as usize);
    // Any received descriptor is closed so the test leaks nothing.
    if message.msg_controllen as usize > 0 {
        // SAFETY: the kernel filled a control buffer of msg_controllen bytes.
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            if !header.is_null() && (*header).cmsg_type == libc::SCM_RIGHTS {
                let received = *(libc::CMSG_DATA(header) as *const RawFd);
                libc::close(received);
            }
        }
    }
    (data, message.msg_controllen as usize, message.msg_flags)
}

#[test]
fn detector_sees_scm_rights() {
    // The detector can fail: a sender that attaches one descriptor is seen.
    let (left, right) = socketpair();
    let payload = b"x";
    let mut iov = libc::iovec { iov_base: payload.as_ptr() as *mut libc::c_void, iov_len: 1 };
    let mut control = [0u8; 64];
    // SAFETY: building one SCM_RIGHTS control message in a local buffer, as cmsg(3) describes.
    unsafe {
        let mut message: libc::msghdr = std::mem::zeroed();
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1 as _;
        message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
        message.msg_controllen = libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) as _;
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
        *(libc::CMSG_DATA(header) as *mut RawFd) = left;
        assert_eq!(libc::sendmsg(left, &message, 0), 1, "sendmsg: {}", std::io::Error::last_os_error());
    }
    let (data, control_len, _flags) = recv_with_control(right);
    assert_eq!(data, b"x");
    assert!(control_len > 0, "the detector must report the attached descriptor");
    // SAFETY: closing our own descriptors.
    unsafe {
        libc::close(left);
        libc::close(right);
    }
}

#[test]
fn writer_attaches_no_control_data() {
    let (left, right) = socketpair();
    let mut writer = ChannelWriter::new();
    let mut expected = Vec::new();
    for id in 1..=3 {
        let frame = encode_frame(&obj(vec![("id", int(id)), ("ok", rw_proto::json::Value::Bool(true)), ("value", obj(vec![("state", text("live"))]))]), 65536).unwrap();
        expected.extend_from_slice(&frame);
        writer.enqueue(Some(id), frame);
    }
    assert_eq!(writer.flush(left).unwrap(), vec![1, 2, 3]);
    assert!(writer.is_empty());
    let mut received = Vec::new();
    while received.len() < expected.len() {
        let (data, control_len, flags) = recv_with_control(right);
        assert_eq!(control_len, 0, "the writer attached control data");
        assert_eq!(flags & libc::MSG_CTRUNC, 0, "truncated control data");
        assert!(!data.is_empty());
        received.extend_from_slice(&data);
    }
    assert_eq!(received, expected, "the exact frame bytes");
    // SAFETY: closing our own descriptors.
    unsafe {
        libc::close(left);
        libc::close(right);
    }
}

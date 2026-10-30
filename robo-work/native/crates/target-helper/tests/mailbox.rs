//! The AF_UNIX mailbox (Linux): SCM_RIGHTS only on a frame's first byte, MSG_CTRUNC, bounded reads, refusal closes
//! every received descriptor, and the `serve` / `worker-peer` roles of the binary.
//!
//! Descriptor-number checks (`F_GETFD` after close must be EBADF) are only meaningful while no other thread opens
//! descriptors, so every test in this binary holds one lock.

#![cfg(target_os = "linux")]

mod common;

use std::io::{BufRead, BufReader, Read};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use common::{load, text, unhex};
use rw_target_helper::Code;
use rw_target_helper::canon::Value;
use rw_target_helper::frame::{self, Ancillary, ExpectedIds, FrameLimits, FrameState};
use rw_target_helper::mailbox::{Connection, Listener, RecvError, RecvLimits};

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_open(fd: RawFd) -> bool {
    // SAFETY: F_GETFD has no side effects.
    unsafe { libc::fcntl(fd, libc::F_GETFD) >= 0 }
}

fn is_cloexec(fd: RawFd) -> bool {
    // SAFETY: F_GETFD has no side effects.
    unsafe { libc::fcntl(fd, libc::F_GETFD) & libc::FD_CLOEXEC != 0 }
}

fn null_files(count: usize) -> Vec<std::fs::File> {
    (0..count).map(|_| std::fs::File::open("/dev/null").unwrap()).collect()
}

fn frame_bytes(body: &[u8]) -> Vec<u8> {
    let mut frame = ((body.len()) as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(body);
    frame
}

fn limits() -> RecvLimits {
    RecvLimits { idle_timeout: Some(Duration::from_millis(2000)), partial_timeout: Duration::from_millis(500), ..RecvLimits::default() }
}

#[test]
fn rights_on_the_first_byte_are_received_counted_and_cloexec() {
    let _guard = serial();
    let (worker, target) = Connection::pair().unwrap();
    let files = null_files(2);
    let borrowed: Vec<BorrowedFd<'_>> = files.iter().map(|file| file.as_fd()).collect();
    let frame = frame_bytes(&[7u8; 100]);
    worker.send_frame(&frame, &borrowed).unwrap();
    let received = target.recv_frame(limits()).unwrap();
    assert_eq!(received.bytes, frame);
    assert_eq!(received.ancillary, Ancillary { count: 2, truncated: false, well_formed: true, on_first_byte: true });
    let numbers: Vec<RawFd> = received.descriptors.iter().map(|fd| fd.as_raw_fd()).collect();
    assert!(numbers.iter().all(|fd| is_open(*fd) && is_cloexec(*fd)));
    drop(received);
    assert!(numbers.iter().all(|fd| !is_open(*fd)), "dropping the frame closed every received descriptor");
    // Two frames back to back: reads never cross into the next frame or take its rights.
    worker.send_frame(&frame_bytes(b"one"), &[]).unwrap();
    worker.send_frame(&frame_bytes(b"two"), &[files[0].as_fd()]).unwrap();
    let first = target.recv_frame(limits()).unwrap();
    assert_eq!((first.bytes.as_slice(), first.ancillary.count), (frame_bytes(b"one").as_slice(), 0));
    let second = target.recv_frame(limits()).unwrap();
    assert_eq!((second.bytes.as_slice(), second.ancillary.count, second.ancillary.on_first_byte), (frame_bytes(b"two").as_slice(), 1, true));
}

fn open_descriptors() -> usize {
    std::fs::read_dir("/proc/self/fd").unwrap().count()
}

/// Bytes still queued on the receiving side (nonblocking peek), to show a refused frame was not read to its end.
fn queued(connection: &Connection) -> usize {
    let mut buffer = [0u8; 4096];
    // SAFETY: recv into a local buffer with MSG_PEEK | MSG_DONTWAIT; no descriptors are requested.
    let count = unsafe { libc::recv(connection.as_fd().as_raw_fd(), buffer.as_mut_ptr() as *mut libc::c_void, buffer.len(), libc::MSG_PEEK | libc::MSG_DONTWAIT) };
    count.max(0) as usize
}

#[test]
fn rights_on_a_later_byte_refuse_at_once_close_every_descriptor_and_stop_reading() {
    let _guard = serial();
    let files = null_files(1);
    let frame = frame_bytes(&[1u8; 64]);
    for split in [1usize, 5, 40] {
        let (worker, target) = Connection::pair().unwrap();
        let before = open_descriptors();
        assert_eq!(worker.send_chunk(&frame[..split], &[]).unwrap(), split);
        assert_eq!(worker.send_chunk(&frame[split..split + 10], &[files[0].as_fd()]).unwrap(), 10);
        assert_eq!(worker.send_chunk(&frame[split + 10..], &[]).unwrap(), frame.len() - split - 10);
        match target.recv_frame(limits()) {
            Err(RecvError::Ancillary(ancillary)) => {
                assert_eq!(ancillary, Ancillary { count: 1, truncated: false, well_formed: true, on_first_byte: false }, "split {split}");
            }
            other => panic!("split {split}: {other:?}"),
        }
        assert_eq!(open_descriptors(), before, "split {split}: the received descriptor was closed");
        // Nothing after the call that returned the rights was read: the third chunk (and, when the 3-byte length read
        // landed inside the second chunk, that chunk's rest) is still queued; the frame was never completed.
        let left = queued(&target);
        assert!(left >= frame.len() - split - 10 && left < frame.len() - split, "split {split}: {left} bytes left unread");
    }
}

#[test]
fn excess_rights_refuse_at_once_and_every_installed_descriptor_closes() {
    let _guard = serial();
    let (worker, target) = Connection::pair().unwrap();
    let files = null_files(9);
    let borrowed: Vec<BorrowedFd<'_>> = files.iter().map(|file| file.as_fd()).collect();
    let before = open_descriptors();
    worker.send_frame(&frame_bytes(b"xyz"), &borrowed).unwrap();
    match target.recv_frame(limits()) {
        Err(RecvError::Ancillary(ancillary)) => assert!(ancillary.truncated && ancillary.count <= 8, "{ancillary:?}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(open_descriptors(), before);
    // Only the first byte was read.
    assert_eq!(queued(&target), frame_bytes(b"xyz").len() - 1);
}

#[test]
fn bounded_reads_oversize_truncation_timeout_and_close() {
    let _guard = serial();
    let (worker, target) = Connection::pair().unwrap();
    let small = RecvLimits { frame_bytes: 64, ..limits() };
    worker.send_frame(&frame_bytes(&[0u8; 61]), &[]).unwrap();
    assert!(matches!(target.recv_frame(small), Err(RecvError::Oversize)));
    let (worker, target) = Connection::pair().unwrap();
    worker.send_chunk(&[0, 0, 0, 9, 1, 2], &[]).unwrap();
    assert!(matches!(target.recv_frame(limits()), Err(RecvError::Timeout)));
    drop(worker);
    let (worker, target) = Connection::pair().unwrap();
    worker.send_chunk(&[0, 0, 0, 9, 1, 2], &[]).unwrap();
    drop(worker);
    assert!(matches!(target.recv_frame(limits()), Err(RecvError::Truncated)));
    let (worker, target) = Connection::pair().unwrap();
    drop(worker);
    assert!(matches!(target.recv_frame(limits()), Err(RecvError::Closed)));
    let (_worker, target) = Connection::pair().unwrap();
    let idle = RecvLimits { idle_timeout: Some(Duration::from_millis(50)), ..limits() };
    assert!(matches!(target.recv_frame(idle), Err(RecvError::Timeout)));
}

#[test]
fn the_validator_refuses_received_rights_on_a_data_frame_and_the_descriptor_closes() {
    let _guard = serial();
    let vectors = load(&common::crate_dir().join("tests/vectors/transport-v1.json"));
    let vector = &vectors.get("frames").unwrap().arr().unwrap()[0];
    let ticket = vectors.get("ticket").unwrap();
    let encoded = unhex(text(vector, "encodedHex"));
    let session_key = unhex(text(&vectors, "sessionKeyHex"));
    let claims = text(ticket, "claimsCanonical").as_bytes().to_vec();
    let expected_values = ticket.get("expected").unwrap();
    let expected = ExpectedIds {
        lease_id: text(vector.get("header").unwrap(), "leaseId").into(),
        reservation_id: text(expected_values, "reservationId").into(),
        operation_id: text(expected_values, "operationId").into(),
        request_digest: text(expected_values, "requestDigest").into(),
    };
    let binding: &Value = ticket.get("claims").unwrap().get("binding").unwrap();
    let (worker, target) = Connection::pair().unwrap();
    let state = |ancillary| FrameState {
        direction: text(vector, "direction"),
        session_key: &session_key,
        claims_canonical: &claims,
        binding,
        expected: &expected,
        channel_epoch: "1",
        next_sequence: "1",
        lease_active: true,
        ancillary,
        channel_manifest: None,
        limits: FrameLimits::default(),
    };
    worker.send_frame(&encoded, &[]).unwrap();
    let clean = target.recv_frame(limits()).unwrap();
    assert!(frame::validate_target_frame(&clean.bytes, &state(clean.ancillary)).is_ok());
    let file = std::fs::File::open("/dev/null").unwrap();
    worker.send_frame(&encoded, &[file.as_fd()]).unwrap();
    let smuggled = target.recv_frame(limits()).unwrap();
    assert_eq!(frame::validate_target_frame(&smuggled.bytes, &state(smuggled.ancillary)), Err(Code::DescriptorCount));
    let number = smuggled.descriptors[0].as_raw_fd();
    drop(smuggled);
    assert!(!is_open(number));
}

#[test]
fn listener_binds_0600_refuses_an_existing_path_and_records_peer_credentials() {
    let _guard = serial();
    use std::os::unix::fs::PermissionsExt;
    let dir = common::temp_dir("listener");
    let path = dir.join("mailbox.sock");
    let listener = Listener::bind(&path).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(Listener::bind(&path).is_err());
    assert!(path.exists(), "a refused bind never unlinks the existing path");
    let worker = Connection::connect(&path).unwrap();
    let target = listener.accept().unwrap();
    // SAFETY: getuid/getpid have no side effects.
    let (uid, pid) = unsafe { (libc::getuid(), libc::getpid()) };
    let credentials = target.peer_credentials().unwrap();
    assert_eq!((credentials.uid, credentials.pid), (uid, pid));
    assert_eq!(worker.peer_credentials().unwrap().uid, uid);
    drop(listener);
    assert!(!path.exists(), "the listener removes its own socket");
    std::fs::write(&path, b"not ours").unwrap();
    assert!(Listener::bind(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"not ours");
}

#[test]
fn binary_roles_serve_and_worker_peer() {
    let _guard = serial();
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    let dir = common::temp_dir("roles");
    let journal_root = dir.join("journal-root");
    std::fs::create_dir(&journal_root).unwrap();
    let mailbox = dir.join("mailbox.sock");
    let incarnation = "AgICAgICAgICAgICAgICAg";
    let secret = dir.join("helper-secret");
    let serve_args = |journal: &std::path::Path, store: &str| {
        // Every serve consumes a fresh single-use secret file.
        write_secret(&secret, incarnation, &[0x11; 32]);
        vec!["serve".to_string(), "--mailbox".into(), mailbox.display().to_string(), "--journal-root".into(), journal.display().to_string(), "--store-identity".into(), store.into(), "--helper-incarnation".into(), incarnation.into(), "--secret-file".into(), secret.display().to_string()]
    };
    // serve never creates a journal.
    let missing = Command::new(binary).args(serve_args(&journal_root, "AwMDAwMDAwMDAwMDAwMDAw")).output().unwrap();
    assert_eq!(missing.status.code(), Some(75));
    assert!(!secret.exists(), "the secret is consumed before the journal is opened");
    assert_eq!(String::from_utf8_lossy(&missing.stdout).trim(), r#"{"error":{"code":"journal_unavailable"},"ok":false}"#);
    assert!(!journal_root.join("journal").exists());
    assert!(!mailbox.exists());
    let refused = Command::new(binary).args(["journal-init", "--root", &journal_root.display().to_string(), "--store-identity", "AwMDAwMDAwMDAwMDAwMDAw"]).output().unwrap();
    assert_eq!(refused.status.code(), Some(64), "provisioning never accepts a caller-chosen identity");
    let init = Command::new(binary).args(["journal-init", "--root", &journal_root.display().to_string()]).output().unwrap();
    assert!(init.status.success());
    let line = String::from_utf8(init.stdout).unwrap();
    assert!(line.starts_with(r#"{"ok":true,"value":{"device":""#), "{line}");
    let parsed = rw_target_helper::canon::parse_canonical(line.trim().as_bytes(), 4096).unwrap();
    let store = parsed.get("value").unwrap().str_at("journalStoreIdentity").unwrap().to_string();
    let store = store.as_str();
    let usage = Command::new(binary).args(["serve", "--mailbox"]).output().unwrap();
    assert_eq!(usage.status.code(), Some(64));
    let mut server = Command::new(binary).args(serve_args(&journal_root, store)).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(server.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), format!(r#"{{"ok":true,"value":{{"helperIncarnation":"{incarnation}","journalStoreIdentity":"{store}","keeperLauncher":"unavailable-until-g1","session":"helper-ticket-secret","state":"ready"}}}}"#));
    assert!(!secret.exists(), "consumed before ready");
    // A second helper incarnation cannot take the same journal while the first holds it.
    let second = Command::new(binary).args(serve_args(&journal_root, store)).output().unwrap();
    assert_eq!(second.status.code(), Some(75));
    let peer = Command::new(binary).args(["worker-peer", "--mailbox", &mailbox.display().to_string(), "--probe"]).output().unwrap();
    let peer_line = String::from_utf8_lossy(&peer.stdout).to_string();
    assert!(peer.status.success(), "{peer_line} {}", String::from_utf8_lossy(&peer.stderr));
    // The probe is no bootstrap: after the challenge the target refuses the handshake and closes.
    assert!(peer_line.contains(r#""closedByTarget":true,"refusedCode":"descriptor_count""#) && peer_line.contains(r#""targetPeer":{"gid":"#), "{peer_line}");
    server.kill().unwrap();
    server.wait().unwrap();
    let mut events = String::new();
    server.stderr.take().unwrap().read_to_string(&mut events).unwrap();
    assert!(events.contains(r#"{"event":"connection","peer":{"gid":"#), "{events}");
    assert!(events.contains(r#"{"code":"descriptor_count","event":"session_refused"}"#), "{events}");
}

/// Writes a v1 ticket-secret file (mode 0600) as Ploinky provisioning does.
fn write_secret(path: &std::path::Path, incarnation: &str, secret: &[u8]) {
    use std::os::unix::fs::PermissionsExt;
    let text = format!("version=1\nhelperIncarnation={incarnation}\nkid=hti1.{incarnation}\nsecret={}\n", rw_target_helper::crypto::b64url_encode(secret));
    let _ = std::fs::remove_file(path);
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn binary_serve_consumes_the_secret_before_journal_or_mailbox_and_refuses_unsafe_files_with_78() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = serial();
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    let dir = common::temp_dir("secret-serve");
    let incarnation = "AgICAgICAgICAgICAgICAg";
    let secret_bytes = [0x5au8; 32];
    let secret_text = rw_target_helper::crypto::b64url_encode(&secret_bytes);
    let secret_hex: String = secret_bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let journal_root = dir.join("journal-root");
    std::fs::create_dir(&journal_root).unwrap();
    let init = Command::new(binary).args(["journal-init", "--root", &journal_root.display().to_string()]).output().unwrap();
    let parsed = rw_target_helper::canon::parse_canonical(String::from_utf8(init.stdout).unwrap().trim().as_bytes(), 4096).unwrap();
    let store = parsed.get("value").unwrap().str_at("journalStoreIdentity").unwrap().to_string();
    let journal_files = || {
        let mut names: Vec<String> = std::fs::read_dir(journal_root.join("journal")).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().to_string()).collect();
        names.sort();
        names
    };
    let journal_before = journal_files();
    let mailbox = dir.join("m.sock");
    let secret = dir.join("helper-secret");
    let args = |path: &std::path::Path| {
        vec!["serve".to_string(), "--mailbox".into(), mailbox.display().to_string(), "--journal-root".into(), journal_root.display().to_string(), "--store-identity".into(), store.clone(), "--helper-incarnation".into(), incarnation.into(), "--secret-file".into(), path.display().to_string()]
    };
    let refuse = |label: &str, path: &std::path::Path, stays: bool| {
        let output = Command::new(binary).args(args(path)).output().unwrap();
        assert_eq!(output.status.code(), Some(78), "{label}");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), r#"{"error":{"code":"invalid_request"},"ok":false}"#, "{label}");
        let all = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(!all.contains(&secret_text) && !all.contains(&secret_hex) && !all.contains(&path.display().to_string()), "{label}: {all}");
        assert!(!mailbox.exists(), "{label}: no mailbox socket");
        assert_eq!(journal_files(), journal_before, "{label}: the journal store is untouched");
        assert_eq!(std::fs::symlink_metadata(path).is_ok(), stays, "{label}");
    };
    refuse("missing", &dir.join("absent"), false);
    // The secret is checked first: a refused secret with a missing journal is 78, never the journal's 75.
    let mut no_journal = args(&dir.join("absent"));
    no_journal[4] = dir.join("no-journal").display().to_string();
    assert_eq!(Command::new(binary).args(&no_journal).output().unwrap().status.code(), Some(78));
    write_secret(&secret, incarnation, &secret_bytes);
    let link = dir.join("link");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    refuse("symlink", &link, true);
    assert!(secret.exists(), "the link target is never consumed");
    std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o644)).unwrap();
    refuse("mode 0644", &secret, true);
    write_secret(&secret, "AwMDAwMDAwMDAwMDAwMDAw", &secret_bytes);
    refuse("other incarnation", &secret, false);
    // A valid file: consumed before the ready line, never echoed.
    write_secret(&secret, incarnation, &secret_bytes);
    let mut server = Command::new(binary).args(args(&secret)).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(server.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert!(ready.contains(r#""session":"helper-ticket-secret","state":"ready""#), "{ready}");
    assert!(!secret.exists(), "unlinked before ready");
    assert!(mailbox.exists());
    server.kill().unwrap();
    server.wait().unwrap();
    let mut events = String::new();
    server.stderr.take().unwrap().read_to_string(&mut events).unwrap();
    let all = format!("{ready}{events}");
    assert!(!all.contains(&secret_text) && !all.contains(&secret_hex), "{all}");
}

#[test]
fn connect_failures_map_to_connect_refusal_codes_never_to_journal_facts() {
    use rw_target_helper::mailbox::connect_error_code;
    let code = |errno: i32| connect_error_code(&std::io::Error::from_raw_os_error(errno)).as_str();
    for errno in [libc::ENOENT, libc::EACCES, libc::ECONNREFUSED, libc::EPERM, libc::ENOTDIR, libc::ENOTSOCK, libc::EINVAL] {
        assert_eq!(code(errno), "connect_refused", "errno {errno}");
    }
    assert_eq!(code(libc::ETIMEDOUT), "connect_timeout");
    assert_eq!(code(libc::EAGAIN), "connect_timeout");
    assert_eq!(connect_error_code(&std::io::Error::new(std::io::ErrorKind::InvalidInput, "mailbox path length")).as_str(), "connect_refused");
}

#[test]
fn binary_worker_peer_reports_a_missing_or_listenerless_mailbox_as_connect_refused() {
    let _guard = serial();
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    let dir = common::temp_dir("connect");
    let missing = dir.join("absent.sock");
    for mode in ["--probe", "--session"] {
        let output = Command::new(binary).args(["worker-peer", "--mailbox", &missing.display().to_string(), mode]).output().unwrap();
        assert_eq!(output.status.code(), Some(75));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), r#"{"error":{"code":"connect_refused"},"ok":false}"#, "{mode}");
    }
    // A stale socket path with no listener (ECONNREFUSED), as after a target replacement.
    let stale = dir.join("stale.sock");
    // std's listener leaves its socket file behind when dropped.
    std::os::unix::net::UnixListener::bind(&stale).map(drop).unwrap();
    assert!(stale.exists());
    let output = Command::new(binary).args(["worker-peer", "--mailbox", &stale.display().to_string(), "--probe"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), r#"{"error":{"code":"connect_refused"},"ok":false}"#);
}

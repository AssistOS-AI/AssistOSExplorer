//! The per-helper-incarnation ticket secret (helper-ticket-secret spec, decision D2): a single-use file that Ploinky
//! provisioning writes into the bound control directory (`control/helper-secret`, mode 0600) and that the helper reads
//! and unlinks itself before it opens its journal, so the secret never passes through launcher shell variables, argv or
//! the environment. Ploinky keeps the only other copy (the Router's, outside every bind source).
//!
//! File format v1 (exact bytes; Ploinky `provisioning.mjs` `ticketSecretFilePrefix`):
//!
//! ```text
//! version=1\nhelperIncarnation=<Id>\nkid=hti1.<Id>\nsecret=<43-character canonical base64url of 32 bytes>\n
//! ```
//!
//! Consumption order: `lstat` (regular file, not a symbolic link, permission bits exactly 0600, at most
//! [`SECRET_FILE_BYTES`]), open with `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK` (a FIFO swapped in cannot hang the open),
//! `fstat` (the same device and inode, still regular, 0600 and bounded), read, unlink, confirm the path is gone, then
//! parse. A file refused before the open and `fstat` checks stays in place (the launcher removes it); once opened and
//! checked it is always unlinked (best effort when reading it failed), so even a malformed or foreign secret is
//! single-use. The
//! incarnation in the file must equal `--helper-incarnation` and the key id must be `hti1.` + that incarnation. Every
//! refusal is `invalid_request`; no path, byte or partial value of the file is ever reported. The raw buffer is wiped
//! on every exit path and the decoded key lives only in a [`crate::crypto::Secret`] (redacted `Debug`, wiped on drop),
//! carried by [`crate::session::TicketKey`].

use crate::Code;
use crate::contract::is_id_text;
use crate::crypto::{Secret, b64url_decode};
use crate::session::TicketKey;

/// Largest accepted secret file (the v1 text is 120 bytes).
pub const SECRET_FILE_BYTES: usize = 256;
/// Key id prefix of a per-incarnation ticket secret (`hti1.<helperIncarnation>`).
pub const TICKET_KID_PREFIX: &str = "hti1.";
pub const TICKET_SECRET_BYTES: usize = 32;

/// A fixed buffer that is wiped when it goes out of scope.
struct Wiped<const N: usize>([u8; N]);

impl<const N: usize> Drop for Wiped<N> {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            // SAFETY: a valid, aligned pointer to an owned byte; volatile so the wipe is not elided.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

fn need(condition: bool) -> Result<(), Code> {
    if condition { Ok(()) } else { Err(Code::InvalidRequest) }
}

/// `key=value` of one line, the key matched exactly.
fn field<'a>(line: &'a [u8], key: &[u8]) -> Result<&'a [u8], Code> {
    need(line.len() > key.len() && line.starts_with(key) && line[key.len()] == b'=')?;
    Ok(&line[key.len() + 1..])
}

/// Parses the exact v1 bytes of a ticket-secret file for `helper_incarnation`.
pub fn parse_ticket_secret(bytes: &[u8], helper_incarnation: &str) -> Result<TicketKey, Code> {
    need(is_id_text(helper_incarnation))?;
    need(bytes.len() <= SECRET_FILE_BYTES && bytes.last() == Some(&b'\n'))?;
    let mut lines = bytes[..bytes.len() - 1].split(|byte| *byte == b'\n');
    let (Some(version), Some(incarnation), Some(kid), Some(secret), None) = (lines.next(), lines.next(), lines.next(), lines.next(), lines.next()) else {
        return Err(Code::InvalidRequest);
    };
    need(field(version, b"version")? == b"1")?;
    need(field(incarnation, b"helperIncarnation")? == helper_incarnation.as_bytes())?;
    let kid = field(kid, b"kid")?;
    need(kid.len() == TICKET_KID_PREFIX.len() + helper_incarnation.len() && kid.starts_with(TICKET_KID_PREFIX.as_bytes()) && &kid[TICKET_KID_PREFIX.len()..] == helper_incarnation.as_bytes())?;
    let text = field(secret, b"secret")?;
    need(text.len() == 43)?;
    // `b64url_decode` is strict: only the canonical unpadded spelling decodes. The decoded bytes go straight into a
    // `Secret`, so they are wiped even when the length check below refuses them.
    let decoded = Secret::new(std::str::from_utf8(text).ok().and_then(b64url_decode).ok_or(Code::InvalidRequest)?);
    need(decoded.expose().len() == TICKET_SECRET_BYTES)?;
    Ok(TicketKey { kid: format!("{TICKET_KID_PREFIX}{helper_incarnation}"), secret: decoded })
}

/// Opens `path` for reading without following a final symbolic link and without blocking: a FIFO swapped in after the
/// `lstat` cannot hang the open (the `fstat` check then refuses it).
#[cfg(unix)]
fn open_nonblocking(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(path)
}

/// Reads at most `raw.len()` bytes; `None` on a read error.
fn read_bounded(reader: &mut impl std::io::Read, raw: &mut [u8]) -> Option<usize> {
    let mut length = 0;
    while length < raw.len() {
        match reader.read(&mut raw[length..]) {
            Ok(0) => break,
            Ok(count) => length += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
    Some(length)
}

/// Reads, unlinks and parses the single-use ticket-secret file at `path` (see the module documentation for the order).
#[cfg(unix)]
pub fn consume_ticket_secret(path: &std::path::Path, helper_incarnation: &str) -> Result<TicketKey, Code> {
    consume_with(path, helper_incarnation, |file| file)
}

/// `consume_ticket_secret` with the reader of the held file supplied by `reader` (tests inject read failures).
#[cfg(unix)]
fn consume_with<R: std::io::Read>(path: &std::path::Path, helper_incarnation: &str, reader: impl FnOnce(std::fs::File) -> R) -> Result<TicketKey, Code> {
    use std::os::unix::fs::MetadataExt;

    let bounded = |metadata: &std::fs::Metadata| metadata.file_type().is_file() && metadata.mode() & 0o7777 == 0o600 && metadata.len() <= SECRET_FILE_BYTES as u64;
    let named = std::fs::symlink_metadata(path).map_err(|_| Code::InvalidRequest)?;
    need(!named.file_type().is_symlink() && bounded(&named))?;
    let file = open_nonblocking(path).map_err(|_| Code::InvalidRequest)?;
    let held = file.metadata().map_err(|_| Code::InvalidRequest)?;
    need(bounded(&held) && (held.dev(), held.ino()) == (named.dev(), named.ino()))?;
    // One byte more than the bound, so a file that grew after the checks is refused rather than truncated.
    let mut raw = Wiped([0u8; SECRET_FILE_BYTES + 1]);
    let mut reader = reader(file);
    let length = read_bounded(&mut reader, &mut raw.0);
    drop(reader);
    // The file was opened and checked, so it is consumed even when reading it failed (best effort on that path).
    let unlinked = std::fs::remove_file(path);
    let length = length.ok_or(Code::InvalidRequest)?;
    unlinked.map_err(|_| Code::InvalidRequest)?;
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(Code::InvalidRequest),
    }
    need(length <= SECRET_FILE_BYTES)?;
    parse_ticket_secret(&raw.0[..length], helper_incarnation)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INCARNATION: &str = "AgICAgICAgICAgICAgICAg";
    const VECTOR: &str = "version=1\nhelperIncarnation=AgICAgICAgICAgICAgICAg\nkid=hti1.AgICAgICAgICAgICAgICAg\nsecret=ERERERERERERERERERERERERERERERERERERERERERE\n";

    #[test]
    fn the_shared_vector_parses_and_the_key_never_prints() {
        let key = parse_ticket_secret(VECTOR.as_bytes(), INCARNATION).unwrap();
        assert_eq!(key.kid, "hti1.AgICAgICAgICAgICAgICAg");
        assert_eq!(key.secret.expose(), &[0x11u8; 32]);
        let debug = format!("{key:?}");
        assert!(debug.contains("redacted") && !debug.contains("17") && !debug.contains("ERER"), "{debug}");
    }

    #[test]
    fn any_deviation_from_the_exact_text_refuses() {
        let refused = |text: &str| parse_ticket_secret(text.as_bytes(), INCARNATION).is_err();
        assert!(refused(&VECTOR[..VECTOR.len() - 1]), "no trailing newline");
        assert!(refused(&VECTOR.replace('\n', "\r\n")));
        assert!(refused(&format!("{VECTOR}\n")), "an empty fifth line");
        assert!(refused(&format!("{VECTOR}extra=1\n")));
        assert!(refused(&VECTOR.replace("version=1", "version=2")));
        assert!(refused(&VECTOR.replace("version=1\n", "")));
        assert!(refused("helperIncarnation=AgICAgICAgICAgICAgICAg\nversion=1\nkid=hti1.AgICAgICAgICAgICAgICAg\nsecret=ERERERERERERERERERERERERERERERERERERERERERE\n"), "reordered");
        assert!(refused(&VECTOR.replace("kid=hti1.", "kid=hti2.")));
        assert!(refused(&VECTOR.replace("kid=hti1.AgICAgICAgICAgICAgICAg", "kid=hti1.AwMDAwMDAwMDAwMDAwMDAw")), "kid of another incarnation");
        assert!(refused(&VECTOR.replace("secret=", "secret =")));
        assert!(refused(&VECTOR.replace("ERERERERERERERERERERERERERERERERERERERERERE", "ERERERERERERERERERERERERERERERERERERERERERE=")), "padded");
        assert!(refused(&VECTOR.replace("ERERERERERERERERERERERERERERERERERERERERERE", "ERERERERERERERERERERERERERERERERERERERERERF")), "non-canonical trailing bits");
        assert!(refused(&VECTOR.replace("ERERERERERERERERERERERERERERERERERERERERERE", "ERERERERERERERERERERERERERERERERERERERERERE+")), "standard alphabet");
        for length in [16, 31, 33] {
            let other = crate::crypto::b64url_encode(&vec![0x11u8; length]);
            assert!(refused(&VECTOR.replace("ERERERERERERERERERERERERERERERERERERERERERE", &other)), "{length}-byte secret");
        }
        assert!(parse_ticket_secret(VECTOR.as_bytes(), "AwMDAwMDAwMDAwMDAwMDAw").is_err(), "another incarnation");
        assert!(parse_ticket_secret(VECTOR.as_bytes(), "not-an-id").is_err());
        let long = format!("{VECTOR}{}", "x".repeat(SECRET_FILE_BYTES));
        assert!(refused(&long));
    }

    #[cfg(unix)]
    fn temp(label: &str) -> std::path::PathBuf {
        let base = std::env::var_os("TMPDIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("rw-th-launch-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_never_blocks_the_open_and_is_refused() {
        use std::sync::mpsc;
        let path = temp("fifo").join("helper-secret");
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (send, receive) = mpsc::channel();
        let probe = path.clone();
        std::thread::spawn(move || {
            // The swap case: the open itself, with no writer on the FIFO, returns at once.
            let opened = open_nonblocking(&probe).map(|file| file.metadata().map(|meta| meta.file_type().is_file()));
            let consumed = consume_ticket_secret(&probe, INCARNATION);
            let _ = send.send((opened.ok().and_then(Result::ok), consumed.is_err()));
        });
        let (opened_is_file, refused) = receive.recv_timeout(std::time::Duration::from_secs(5)).expect("no hang on a FIFO");
        assert_eq!(opened_is_file, Some(false), "the non-blocking open returned a non-regular file");
        assert!(refused);
        assert!(path.exists(), "a refused FIFO is left for the launcher");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_error_still_consumes_the_file() {
        use std::os::unix::fs::PermissionsExt;
        struct Failing;
        impl std::io::Read for Failing {
            fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("injected"))
            }
        }
        let path = temp("read-error").join("helper-secret");
        std::fs::write(&path, VECTOR).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(consume_with(&path, INCARNATION, |_file| Failing).unwrap_err(), Code::InvalidRequest);
        assert!(std::fs::symlink_metadata(&path).is_err(), "unlinked on the read-error path");
    }

    #[test]
    fn bounded_reads_stop_at_the_buffer() {
        let mut raw = [0u8; 4];
        assert_eq!(read_bounded(&mut &b"abcdef"[..], &mut raw), Some(4));
        assert_eq!(&raw, b"abcd");
    }
}

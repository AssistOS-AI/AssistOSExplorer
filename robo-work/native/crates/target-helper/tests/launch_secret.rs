//! The single-use ticket-secret file (helper-ticket-secret spec, decision D2): `launch::consume_ticket_secret` checks,
//! reads, unlinks and parses it. A file refused before it was read stays in place for the launcher to remove; a file
//! that was read is always gone afterwards, whatever its content.
#![cfg(unix)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use rw_target_helper::Code;
use rw_target_helper::crypto::b64url_encode;
use rw_target_helper::launch::{SECRET_FILE_BYTES, consume_ticket_secret};

const INCARNATION: &str = "AgICAgICAgICAgICAgICAg";
/// The literal vector shared with Ploinky's `executionTargetProvisioning.test.mjs` (32 x 0x11).
const VECTOR: &str = "version=1\nhelperIncarnation=AgICAgICAgICAgICAgICAg\nkid=hti1.AgICAgICAgICAgICAgICAg\nsecret=ERERERERERERERERERERERERERERERERERERERERERE\n";

fn write(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}

#[test]
fn the_shared_vector_is_consumed_once_and_yields_the_incarnation_key() {
    let dir = common::temp_dir("secret-vector");
    let path = write(&dir, "helper-secret", VECTOR.as_bytes(), 0o600);
    let key = consume_ticket_secret(&path, INCARNATION).unwrap();
    assert_eq!(key.kid, "hti1.AgICAgICAgICAgICAgICAg");
    assert_eq!(key.secret.expose(), &[0x11u8; 32]);
    assert!(std::fs::symlink_metadata(&path).is_err(), "the file is unlinked");
    assert_eq!(consume_ticket_secret(&path, INCARNATION).unwrap_err(), Code::InvalidRequest, "single use");
    let debug = format!("{key:?}");
    assert!(!debug.contains("ERER") && debug.contains("redacted"), "{debug}");
}

#[test]
fn unsafe_files_refuse_before_reading_and_stay_in_place() {
    let dir = common::temp_dir("secret-unsafe");
    assert_eq!(consume_ticket_secret(&dir.join("absent"), INCARNATION).unwrap_err(), Code::InvalidRequest);
    // A symbolic link is never followed: the link and its target both survive.
    let target = write(&dir, "real", VECTOR.as_bytes(), 0o600);
    let link = dir.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert_eq!(consume_ticket_secret(&link, INCARNATION).unwrap_err(), Code::InvalidRequest);
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read(&target).unwrap(), VECTOR.as_bytes());
    for mode in [0o644, 0o640, 0o400, 0o700, 0o4600] {
        let path = write(&dir, &format!("mode-{mode:o}"), VECTOR.as_bytes(), mode);
        assert_eq!(consume_ticket_secret(&path, INCARNATION).unwrap_err(), Code::InvalidRequest, "mode {mode:o}");
        assert!(path.exists(), "mode {mode:o}: not consumed");
    }
    let oversized = write(&dir, "oversized", &vec![b'x'; SECRET_FILE_BYTES + 1], 0o600);
    assert_eq!(consume_ticket_secret(&oversized, INCARNATION).unwrap_err(), Code::InvalidRequest);
    assert!(oversized.exists());
    let directory = dir.join("directory");
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(consume_ticket_secret(&directory, INCARNATION).unwrap_err(), Code::InvalidRequest);
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(directory.is_dir());
}

#[test]
fn a_read_file_with_foreign_or_malformed_content_refuses_and_is_still_consumed() {
    let dir = common::temp_dir("secret-content");
    let cases: Vec<(&str, String)> = vec![
        ("other-incarnation", VECTOR.replace(INCARNATION, "AwMDAwMDAwMDAwMDAwMDAw")),
        ("kid-mismatch", VECTOR.replace("kid=hti1.AgICAgICAgICAgICAgICAg", "kid=hti1.AwMDAwMDAwMDAwMDAwMDAw")),
        ("short-secret", VECTOR.replace("ERERERERERERERERERERERERERERERERERERERERERE", &b64url_encode(&[0x11u8; 16]))),
        ("padded", VECTOR.replace("ERERERERERERERERERERERERERERERERERERERERERE", "ERERERERERERERERERERERERERERERERERERERERERE=")),
        ("reordered", "helperIncarnation=AgICAgICAgICAgICAgICAg\nversion=1\nkid=hti1.AgICAgICAgICAgICAgICAg\nsecret=ERERERERERERERERERERERERERERERERERERERERERE\n".to_string()),
        ("extra-line", format!("{VECTOR}extra=1\n")),
        ("no-newline", VECTOR.trim_end().to_string()),
        ("empty", String::new()),
    ];
    for (name, text) in cases {
        let path = write(&dir, name, text.as_bytes(), 0o600);
        assert_eq!(consume_ticket_secret(&path, INCARNATION).unwrap_err(), Code::InvalidRequest, "{name}");
        assert!(std::fs::symlink_metadata(&path).is_err(), "{name}: consumed");
    }
    // The expected incarnation must itself be an Id.
    let path = write(&dir, "bad-expected", VECTOR.as_bytes(), 0o600);
    assert_eq!(consume_ticket_secret(&path, "short").unwrap_err(), Code::InvalidRequest);
}

//! Source-level gates (plan section 5.4; brief "fuser and helpers"):
//!   - no code path in the native tree calls a fuser mount function or a setuid helper: the only session constructor
//!     is `Session::from_fd` on the keeper-provided descriptor;
//!   - fuser's permissive defaults (`open`, `opendir`, `statfs`, `release`, `releasedir`) are overridden by the glue;
//!   - the settings sample built from the glue's constants meets the FUSE settings specification.
//! The same gates run as `rg` commands in scripts/gates.sh, and the file server's seccomp filter kills the process on
//! execve, so the linked fuser mount-helper code (fuser::mnt::fuse_pure, which execs fusermount) cannot run.

use std::path::{Path, PathBuf};

fn native_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name != "target" && name != "vectors") {
                rust_sources(&path, out);
            }
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn code_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines().map(str::trim_start).filter(|line| !line.starts_with("//"))
}

#[test]
fn no_fuser_mount_function_or_helper_is_called() {
    let mut files = Vec::new();
    rust_sources(&native_root().join("crates"), &mut files);
    assert!(files.len() > 10, "{files:?}");
    let forbidden = ["fuser::mount", "spawn_mount", "Session::new(", "MountOption", "fusermount", "detect_fusermount", "fuse_pure", "AutoUnmount"];
    let this_file = Path::new(file!()).file_name().unwrap();
    let mut from_fd_calls = 0;
    for file in &files {
        if file.file_name() == Some(this_file) {
            continue;
        }
        let text = std::fs::read_to_string(file).unwrap();
        for line in code_lines(&text) {
            for pattern in forbidden {
                assert!(!line.contains(pattern), "{} contains {pattern}: {line}", file.display());
            }
            if line.contains("Session::from_fd(") {
                from_fd_calls += 1;
            }
        }
    }
    assert_eq!(from_fd_calls, 1, "exactly one Session::from_fd call site (file-server main)");
}

#[test]
fn permissive_fuser_defaults_are_overridden() {
    let glue = std::fs::read_to_string(native_root().join("crates/file-server/src/glue.rs")).unwrap();
    for method in ["fn open(", "fn opendir(", "fn statfs(", "fn release(", "fn releasedir(", "fn access(", "fn lookup(", "fn getattr(",
        "fn read(", "fn write(", "fn readdir(", "fn create(", "fn setattr(", "fn rename(", "fn link(", "fn mkdir(", "fn unlink(", "fn rmdir(",
        "fn symlink(", "fn readlink(", "fn mknod(", "fn ioctl(", "fn getxattr(", "fn setxattr(", "fn listxattr(", "fn removexattr(",
        "fn copy_file_range(", "fn fallocate(", "fn fsync(", "fn fsyncdir(", "fn flush(", "fn forget(", "fn init("] {
        assert!(glue.contains(method), "glue.rs does not override {method}");
    }
}

#[test]
fn settings_sample_meets_the_specification() {
    for read_only in [false, true] {
        let violations = rw_fsview::fuse_settings::find_settings_violations(&rw_file_server::settings::sample(read_only));
        assert!(violations.is_empty(), "{violations:?}");
    }
    // Negative control: a cached entry reply would be caught.
    let mut weakened = rw_file_server::settings::sample(false);
    weakened.entry_replies[0].secs = 1;
    assert!(!rw_fsview::fuse_settings::find_settings_violations(&weakened).is_empty());
}

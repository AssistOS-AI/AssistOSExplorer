//! The RoboWork per-grant file server (plan section 5.4).
//!
//! | Module | Status |
//! |---|---|
//! | `args`, `settings` | Pure, host-tested (settings checked against rw_fsview::fuse_settings) |
//! | `backing`, `glue`, `errno` | Linux only; compiled for musl and type-checked, not executed (G1/G6) |
//!
//! The only session constructor used is `fuser::Session::from_fd` with the keeper-provided `/dev/fuse` descriptor; no
//! fuser mount function, no fusermount and no setuid helper is reachable (tests/no_mount_helper.rs; the seccomp filter
//! also kills the process on execve).

pub mod args;
pub mod settings;

#[cfg(target_os = "linux")]
pub mod backing;
#[cfg(target_os = "linux")]
pub mod errno;
#[cfg(target_os = "linux")]
pub mod glue;

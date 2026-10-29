//! The RoboWork execution keeper (plan section 5.5; v1 wire contract keeper-wire-contract-delta-2026-10-28_claude.md).
//! Pure modules are host-tested; `linux` is type-checked for musl.
//!
//! | Module | Status |
//! |---|---|
//! | `args`, `procfs`, `core`, `channel`, `root_identity` | Implemented, host-tested. `core` dispatches every v1 op; `channel` is the fd-3 writer/reader (no ancillary data, tested on the host) |
//! | `bwrap`, `stage` | Pure builders/parsers, host-tested; the single-Bubblewrap invocation (A1.1 topology) and the stage's environment block |
//! | `image_policy`, `sha256` | The apparatus image-policy document and its digest, host-tested; embedded only with the `apparatus-policy` feature |
//! | `linux::os`, `linux::runloop` | Implemented. Process-bearing creation delegates to `linux::launcher`; PTY allocation still refuses `setup_failed` (S2) |
//! | `linux::launcher`, `linux::domain`, `linux::stage_exec`, `linux::policy`, `linux::sys` | First-G1 construction (pidfd anchor, private stage channel, positive exec observation); runtime evidence is per candidate |

pub mod args;
pub mod bwrap;
pub mod channel;
pub mod cgroup_subtree;
pub mod core;
pub mod domain_policy;
pub mod image_policy;
pub mod launch;
pub mod procfs;
pub mod root_identity;
pub mod sha256;
pub mod stage;

#[cfg(target_os = "linux")]
pub mod linux;

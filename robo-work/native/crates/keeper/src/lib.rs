//! The RoboWork execution keeper (plan section 5.5; v1 wire contract keeper-wire-contract-delta-2026-10-28_claude.md).
//! Pure modules are host-tested; `linux` is type-checked for musl.
//!
//! | Module | Status |
//! |---|---|
//! | `args`, `procfs`, `core`, `channel`, `root_identity` | Implemented, host-tested. `core` dispatches every v1 op; `channel` is the fd-3 writer/reader (no ancillary data, tested on the host) |
//! | `bwrap`, `stage` | Pure builders/parsers, host-tested; the construction mechanics are the native owner's (contract "Out of scope") and are PROVISIONAL until G1 |
//! | `linux::os`, `linux::runloop` | Implemented, type-checked only (runtime proof: G1/G6). Process-bearing creation and PTY allocation in `linux::os` refuse `setup_failed` in r3 (see the module) |
//! | `linux::domain`, `linux::stage_exec` | PROVISIONAL, type-checked only |

pub mod args;
pub mod bwrap;
pub mod channel;
pub mod cgroup_subtree;
pub mod core;
pub mod domain_policy;
pub mod launch;
pub mod procfs;
pub mod root_identity;
pub mod stage;

#[cfg(target_os = "linux")]
pub mod linux;

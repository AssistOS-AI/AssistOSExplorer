//! Confinement building blocks for the RoboWork keeper and file server (plan sections 5.0, 5.4 and 5.5).
//!
//! `seccomp` and `syscalls` are pure and host-tested (the BPF programs run through an interpreter). `linux` holds the
//! kernel-facing helpers (filter installation, capability drop, rlimits, no_new_privs); it is compiled only for Linux
//! and is type-checked on the musl target, never executed in this pass.

pub mod seccomp;
pub mod syscalls;

#[cfg(target_os = "linux")]
pub mod linux;

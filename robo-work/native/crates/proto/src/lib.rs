//! Shared, pure protocol code for the RoboWork execution keeper (plan sections 5.4 and 5.5).
//!
//! Everything here is platform-independent and host-tested; nothing touches the kernel. The wire formats are those of
//! the frozen Node side (`robo-work/server/execution/frameCodec.mjs`, `gateProtocol.mjs` and
//! `robo-work/server/views/mountFrames.mjs`, `rootLease.mjs`, `viewLimits.mjs`) and of the v1 keeper wire contract
//! (`keeper_frames`, `keeper_limits`; keeper-wire-contract-delta-2026-10-28_claude.md).

pub mod frame;
pub mod gate;
pub mod json;
pub mod keeper_frames;
pub mod keeper_limits;
pub mod lease;
pub mod limits;
pub mod mount_frames;
pub mod provider_schema;

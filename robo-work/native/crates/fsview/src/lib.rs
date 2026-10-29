//! Pure policy core of the RoboWork per-grant file server (plan section 5.4).
//!
//! Ports of the S5 Node reference modules in `robo-work/server/views/`: protectedNames.mjs (`names`, with the fold in
//! `fold`), operationPolicy.mjs (`policy`), descriptorLedger.mjs (`ledger`), d2Decision.mjs (`d2`), fuseSettings.mjs
//! (`fuse_settings`) and viewEngine.mjs (`engine`). Nothing here touches the kernel; the Linux backing and the fuser glue
//! live in `rw-file-server`.

pub mod d2;
pub mod engine;
pub mod fold;
pub mod fuse_settings;
pub mod ledger;
pub mod names;
pub mod policy;
#[rustfmt::skip]
pub mod unicode_tables;

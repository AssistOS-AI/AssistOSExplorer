//! The FUSE reply and INIT settings the glue uses (plan section 5.4, "Kernel caching"; review R4-6; D2). Pure, so the
//! host tests can check them against `rw_fsview::fuse_settings`. The glue (Linux) builds every reply from these
//! constants and maps the names to fuser's constants in `glue::fopen_flags`, which refuses an unknown name.

use std::time::Duration;

use rw_fsview::fuse_settings::{Delivery, NegativeLookup, Sample, Ttl};

/// Entry and negative-entry lifetime: zero, so no name answer comes from a kernel cache.
pub const ENTRY_TTL: Duration = Duration::ZERO;
/// Attribute lifetime: zero as well (stricter than the plan requires), so a node found under a protected name
/// returns no cached attributes either.
pub const ATTR_TTL: Duration = Duration::ZERO;

/// The INIT capabilities the server ends up requesting: fuser 0.18.0's Linux defaults (`INIT_FLAGS` =
/// FUSE_ASYNC_READ | FUSE_BIG_WRITES, plus FUSE_MAX_PAGES when the kernel offers it; vendored `lib.rs:107-124`). The
/// glue's `init` adds none. A test pins this list to the vendored source text.
pub const INIT_CAPABILITIES: &[&str] = &["FUSE_ASYNC_READ", "FUSE_BIG_WRITES", "FUSE_MAX_PAGES"];

/// Flags on every file open reply.
pub const OPEN_FLAGS: &[&str] = &["FOPEN_DIRECT_IO"];
/// Flags on every directory open reply.
pub const OPENDIR_FLAGS: &[&str] = &[];

/// Missing names are answered with ENOENT (never a zero-node entry).
pub const NEGATIVE_LOOKUP_ERRNO: &str = "ENOENT";

/// Mount options the keeper applies (crates/keeper/src/linux/os.rs: `allow_other` in the data string, MS_RDONLY for a
/// read grant, plus nosuid and nodev).
pub fn mount_options(read_only: bool) -> Vec<String> {
    let mut options = vec!["allow_other".to_string(), "nosuid".to_string(), "nodev".to_string()];
    if read_only {
        options.push("ro".to_string());
    }
    options
}

fn ttl(duration: Duration) -> Ttl {
    Ttl { secs: duration.as_secs(), nsecs: duration.subsec_nanos() }
}

/// The settings sample (fuseSettings.mjs shape) built from the constants above.
pub fn sample(read_only: bool) -> Sample {
    Sample {
        init_capabilities: Some(INIT_CAPABILITIES.iter().map(|name| name.to_string()).collect()),
        entry_replies: vec![ttl(ENTRY_TTL)],
        negative_lookup_replies: vec![NegativeLookup::Error(NEGATIVE_LOOKUP_ERRNO.to_string())],
        readdirplus_entries: vec![],
        open_replies: vec![OPEN_FLAGS.iter().map(|name| name.to_string()).collect()],
        opendir_replies: vec![OPENDIR_FLAGS.iter().map(|name| name.to_string()).collect()],
        // Reads reply with a copied buffer (ReplyData::data) after the post-read check; fuser has no splice reply.
        read_replies: vec![Delivery::Copy],
        mount_options: Some(mount_options(read_only)),
        grant_access: Some(if read_only { "read" } else { "write" }.to_string()),
    }
}

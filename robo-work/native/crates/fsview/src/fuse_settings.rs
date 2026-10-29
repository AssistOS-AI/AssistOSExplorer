//! The FUSE settings the filtered view must use (plan section 5.4, "Kernel caching"; review R4-6; decision D2), as a
//! specification and a checker. A port of `FUSE_VIEW_SETTINGS` and `findSettingsViolations` of
//! `robo-work/server/views/fuseSettings.mjs` (S5 r5).
//!
//! The file server's glue builds its INIT capability set, entry replies, negative-lookup replies, open flags and data
//! delivery through the functions in `rw-file-server`'s `settings` module; a test serialises those into a [`Sample`] and
//! requires `find_settings_violations` to return nothing. Names are the kernel's symbolic names; the glue maps its own
//! fuser constants to them.

pub const FORBIDDEN_INIT_CAPABILITIES: &[&str] = &[
    "FUSE_WRITEBACK_CACHE",
    "FUSE_PASSTHROUGH",
    "FUSE_CACHE_SYMLINKS",
    "FUSE_NO_OPEN_SUPPORT",
    "FUSE_NO_OPENDIR_SUPPORT",
    "FUSE_AUTO_INVAL_DATA",
    "FUSE_READDIRPLUS_AUTO",
    "FUSE_SPLICE_READ",
    "FUSE_SPLICE_WRITE",
    "FUSE_SPLICE_MOVE",
    "FUSE_DIRECT_IO_ALLOW_MMAP",
    "FUSE_DIRECT_IO_RELAX",
];

pub const PERMITTED_INIT_CAPABILITIES: &[&str] = &[
    "FUSE_ASYNC_READ", "FUSE_ATOMIC_O_TRUNC", "FUSE_BIG_WRITES", "FUSE_DONT_MASK", "FUSE_POSIX_LOCKS", "FUSE_FLOCK_LOCKS",
    "FUSE_PARALLEL_DIROPS", "FUSE_MAX_PAGES", "FUSE_ABORT_ERROR", "FUSE_HANDLE_KILLPRIV", "FUSE_HANDLE_KILLPRIV_V2",
    "FUSE_INIT_EXT", "FUSE_SETXATTR_EXT", "FUSE_ASYNC_DIO", "FUSE_DO_READDIRPLUS",
];

pub const READDIRPLUS_ENABLERS: &[&str] = &["FUSE_DO_READDIRPLUS", "FUSE_READDIRPLUS_AUTO"];
pub const OPEN_REQUIRED_FLAGS: &[&str] = &["FOPEN_DIRECT_IO"];
pub const OPEN_FORBIDDEN_FLAGS: &[&str] = &["FOPEN_KEEP_CACHE", "FOPEN_CACHE_DIR", "FOPEN_PASSTHROUGH"];
pub const OPENDIR_FORBIDDEN_FLAGS: &[&str] = &["FOPEN_KEEP_CACHE", "FOPEN_CACHE_DIR", "FOPEN_PASSTHROUGH"];
pub const MOUNT_REQUIRED_OPTIONS: &[&str] = &["allow_other"];
pub const READ_ONLY_GRANT_OPTION: &str = "ro";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ttl {
    pub secs: u64,
    pub nsecs: u32,
}

impl Ttl {
    pub const ZERO: Ttl = Ttl { secs: 0, nsecs: 0 };
    fn well_formed(self) -> bool {
        self.nsecs < 1_000_000_000
    }
    fn is_zero(self) -> bool {
        self.well_formed() && self.secs == 0 && self.nsecs == 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NegativeLookup {
    Error(String),
    Entry { node_id: u64, entry_valid: Ttl },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Copy,
    Splice,
    ZeroCopy,
}

#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub init_capabilities: Option<Vec<String>>,
    pub entry_replies: Vec<Ttl>,
    pub negative_lookup_replies: Vec<NegativeLookup>,
    pub readdirplus_entries: Vec<Ttl>,
    pub open_replies: Vec<Vec<String>>,
    pub opendir_replies: Vec<Vec<String>>,
    pub read_replies: Vec<Delivery>,
    pub mount_options: Option<Vec<String>>,
    pub grant_access: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub code: &'static str,
    pub location: String,
}

/// `findSettingsViolations(sample)`: empty means the sample meets the specification.
pub fn find_settings_violations(sample: &Sample) -> Vec<Violation> {
    let mut violations = Vec::new();
    let mut add = |code: &'static str, location: String| violations.push(Violation { code, location });

    let capabilities = sample.init_capabilities.as_ref();
    if capabilities.is_none() {
        add("missing_evidence", "init.capabilities".into());
    }
    for name in capabilities.into_iter().flatten() {
        if FORBIDDEN_INIT_CAPABILITIES.contains(&name.as_str()) {
            add("forbidden_init_capability", format!("init.capabilities:{name}"));
        } else if !PERMITTED_INIT_CAPABILITIES.contains(&name.as_str()) {
            add("unreviewed_init_capability", format!("init.capabilities:{name}"));
        }
    }

    if sample.entry_replies.is_empty() {
        add("missing_evidence", "entryReplies".into());
    }
    for (index, ttl) in sample.entry_replies.iter().enumerate() {
        if !ttl.well_formed() {
            add("entry_ttl_malformed", format!("entryReplies[{index}]"));
        } else if !ttl.is_zero() {
            add("entry_ttl_nonzero", format!("entryReplies[{index}]"));
        }
    }

    if sample.negative_lookup_replies.is_empty() {
        add("missing_evidence", "negativeLookupReplies".into());
    }
    for (index, reply) in sample.negative_lookup_replies.iter().enumerate() {
        match reply {
            NegativeLookup::Error(errno) if errno == "ENOENT" => {}
            NegativeLookup::Entry { node_id: 0, entry_valid } if entry_valid.is_zero() => {}
            NegativeLookup::Entry { node_id: 0, .. } => add("negative_entry_cached", format!("negativeLookupReplies[{index}]")),
            _ => add("negative_lookup_malformed", format!("negativeLookupReplies[{index}]")),
        }
    }

    let readdirplus_on = capabilities.is_some_and(|names| names.iter().any(|name| READDIRPLUS_ENABLERS.contains(&name.as_str())));
    if readdirplus_on && sample.readdirplus_entries.is_empty() {
        add("missing_evidence", "readdirplusEntries".into());
    }
    for (index, ttl) in sample.readdirplus_entries.iter().enumerate() {
        if !ttl.is_zero() {
            add("readdirplus_ttl_nonzero", format!("readdirplusEntries[{index}]"));
        }
    }

    if sample.open_replies.is_empty() {
        add("missing_evidence", "openReplies".into());
    }
    for (index, flags) in sample.open_replies.iter().enumerate() {
        for required in OPEN_REQUIRED_FLAGS {
            if !flags.iter().any(|flag| flag == required) {
                add("open_direct_io_missing", format!("openReplies[{index}]"));
            }
        }
        for forbidden in OPEN_FORBIDDEN_FLAGS {
            if flags.iter().any(|flag| flag == forbidden) {
                add("forbidden_open_flag", format!("openReplies[{index}]:{forbidden}"));
            }
        }
    }
    if sample.opendir_replies.is_empty() {
        add("missing_evidence", "opendirReplies".into());
    }
    for (index, flags) in sample.opendir_replies.iter().enumerate() {
        for forbidden in OPENDIR_FORBIDDEN_FLAGS {
            if flags.iter().any(|flag| flag == forbidden) {
                add("forbidden_opendir_flag", format!("opendirReplies[{index}]:{forbidden}"));
            }
        }
    }

    if sample.read_replies.is_empty() {
        add("missing_evidence", "readReplies".into());
    }
    for (index, delivery) in sample.read_replies.iter().enumerate() {
        if *delivery != Delivery::Copy {
            add("data_delivery_not_copy", format!("readReplies[{index}]"));
        }
    }

    match &sample.mount_options {
        None => add("missing_evidence", "mountOptions".into()),
        Some(options) => {
            for required in MOUNT_REQUIRED_OPTIONS {
                if !options.iter().any(|option| option == required) {
                    add("mount_option_missing", format!("mountOptions:{required}"));
                }
            }
        }
    }
    match sample.grant_access.as_deref() {
        Some("read") => {
            if let Some(options) = &sample.mount_options {
                if !options.iter().any(|option| option == READ_ONLY_GRANT_OPTION) {
                    add("read_only_grant_not_ro", "mountOptions".into());
                }
            }
        }
        Some("write") => {}
        _ => add("grant_access_malformed", "grantAccess".into()),
    }
    violations
}

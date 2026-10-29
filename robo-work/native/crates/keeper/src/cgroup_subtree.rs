//! Portable decision for the supervisor-bound cgroup-v2 subtree. Linux gathers these facts read-only before hello.
//! This validates custody only; creating cgroups remains disabled pending the separate Linux creation work.

use crate::root_identity::Identity;

pub const CGROUP2_SUPER_MAGIC: u64 = 0x63677270;

#[derive(Clone, Copy, Debug)]
pub struct ControlFile {
    pub regular: bool,
    pub uid: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Facts {
    pub canonical: bool,
    pub fs_magic: u64,
    pub directory: bool,
    pub identity: Identity,
    pub uid: u32,
    pub procs: Option<ControlFile>,
    pub subtree_control: Option<ControlFile>,
}

pub fn validate(recorded: Identity, euid: u32, facts: Facts) -> Result<(), &'static str> {
    if !facts.canonical || facts.fs_magic != CGROUP2_SUPER_MAGIC || !facts.directory {
        return Err("cgroup_subtree_invalid");
    }
    if facts.identity != recorded {
        return Err("cgroup_subtree_invalid");
    }
    let control_owned = |file: Option<ControlFile>| file.is_some_and(|file| file.regular && file.uid == euid);
    if facts.uid != euid || !control_owned(facts.procs) || !control_owned(facts.subtree_control) {
        return Err("cgroup_subtree_invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_facts_require_cgroup2_identity_and_owned_control_files() {
        let file = Some(ControlFile { regular: true, uid: 1000 });
        let good = Facts { canonical: true, fs_magic: CGROUP2_SUPER_MAGIC, directory: true, identity: (1, 2), uid: 1000, procs: file, subtree_control: file };
        assert_eq!(validate((1, 2), 1000, good), Ok(()));
        let bad = [
            Facts { canonical: false, ..good }, Facts { fs_magic: 0x01021994, ..good }, Facts { directory: false, ..good },
            Facts { identity: (9, 2), ..good }, Facts { identity: (1, 9), ..good }, Facts { uid: 0, ..good },
            Facts { procs: None, ..good }, Facts { subtree_control: None, ..good },
            Facts { procs: Some(ControlFile { regular: false, uid: 1000 }), ..good },
            Facts { subtree_control: Some(ControlFile { regular: false, uid: 1000 }), ..good },
            Facts { procs: Some(ControlFile { regular: true, uid: 0 }), ..good },
            Facts { subtree_control: Some(ControlFile { regular: true, uid: 0 }), ..good },
        ];
        for (index, facts) in bad.into_iter().enumerate() {
            assert_eq!(validate((1, 2), 1000, facts), Err("cgroup_subtree_invalid"), "invalid fact {index}: {facts:?}");
        }
    }
}

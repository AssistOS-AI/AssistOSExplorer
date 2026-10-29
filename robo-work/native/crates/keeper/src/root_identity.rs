//! Runtime-root identity (review RK-3, F-4). The keeper holds the runtime root by descriptor from startup and records its
//! `(dev, ino)`. Every use re-resolves the configured PATH without following a final symlink and requires that the path,
//! the held descriptor and the recorded identity all agree; otherwise path-based legs (mountinfo, mountpoints) would act
//! on a different directory than the descriptor-based ones. Portable: host-tested on any Unix.

use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// `(st_dev, st_ino)`.
pub type Identity = (u64, u64);

/// The identity of the directory at `path` now, without following a final symlink (a symlink or a non-directory is
/// `None`).
pub fn path_identity(path: &Path) -> Option<Identity> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    metadata.file_type().is_dir().then(|| (metadata.dev(), metadata.ino()))
}

/// The identity of an open directory handle.
pub fn handle_identity(file: &std::fs::File) -> Option<Identity> {
    file.metadata().ok().map(|metadata| (metadata.dev(), metadata.ino()))
}

/// Ok only if the held descriptor and the configured path are both still the directory recorded at startup.
pub fn verify_root(recorded: Identity, held: Option<Identity>, at_path: Option<Identity>) -> Result<(), &'static str> {
    if held == Some(recorded) && at_path == Some(recorded) { Ok(()) } else { Err("runtime_root_unavailable") }
}

/// The current path of a held directory from its `/proc/self/fd/N` link: absolute, and not an unlinked directory
/// (`" (deleted)"`). Used for the mountinfo leg so that it names the directory the descriptor holds, not a stale path.
pub fn held_path(link: &str) -> Option<&str> {
    (link.starts_with('/') && !link.ends_with(" (deleted)")).then_some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test-owned scratch directory under TMPDIR, removed at the end of the test.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let path = std::env::temp_dir().join(format!("rw-root-identity-{name}-{}", std::process::id()));
            std::fs::create_dir(&path).expect("fresh scratch directory");
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_runtime_root_renamed_or_replaced_after_startup_is_refused() {
        let scratch = Scratch::new("rename");
        let root = scratch.0.join("run");
        let moved = scratch.0.join("moved");
        std::fs::create_dir(&root).unwrap();
        let held = std::fs::File::open(&root).unwrap();
        let recorded = handle_identity(&held).unwrap();
        let check = || verify_root(recorded, handle_identity(&held), path_identity(&root));
        assert_eq!(check(), Ok(()), "unchanged");
        // Renamed: the descriptor still names it, the path does not.
        std::fs::rename(&root, &moved).unwrap();
        assert_eq!(handle_identity(&held), Some(recorded), "fstat of the held descriptor alone cannot see the rename (F-4)");
        assert_eq!(check(), Err("runtime_root_unavailable"));
        // Replaced by another directory at the same path.
        std::fs::create_dir(&root).unwrap();
        assert_eq!(check(), Err("runtime_root_unavailable"));
        std::fs::remove_dir(&root).unwrap();
        // Replaced by a symlink to the original directory: not followed.
        std::os::unix::fs::symlink(&moved, &root).unwrap();
        assert_eq!(check(), Err("runtime_root_unavailable"));
        std::fs::remove_file(&root).unwrap();
        // Restored: accepted again.
        std::fs::rename(&moved, &root).unwrap();
        assert_eq!(check(), Ok(()));
    }

    #[test]
    fn held_paths_must_be_absolute_and_not_deleted() {
        assert_eq!(held_path("/run/robo-work/x/a"), Some("/run/robo-work/x/a"));
        assert_eq!(held_path("/run/robo-work/x/a (deleted)"), None);
        assert_eq!(held_path("anon_inode:[pidfd]"), None);
        assert_eq!(verify_root((1, 2), None, Some((1, 2))), Err("runtime_root_unavailable"));
    }
}

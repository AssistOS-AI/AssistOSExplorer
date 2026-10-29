//! Loading the embedded apparatus image policy (first-G1 amendment A1.6) into held, checked descriptors.
//!
//! Only a keeper built with the `apparatus-policy` feature contains a policy: `include_str!` of the file named by the
//! build-time `RW_KEEPER_APPARATUS_POLICY_FILE`. There is no runtime path, flag or frame that selects one. A default
//! build has none and every process-bearing create refuses `setup_failed`.
//!
//! At startup, for every pinned file: open `source` with `O_PATH` and no symlink in any component, require a regular
//! file, hash its bytes (SHA-256) and compare with the pin, and record `(st_dev, st_ino)`. Executables must start with
//! the ELF magic (direct programs only; no script or launcher resolution). The keeper's own running image
//! (`/proc/self/exe`) must be the pinned keeper, because the stage runs that file. Any failure leaves the keeper without
//! a policy (fail closed), never with a partial one.

use std::collections::BTreeMap;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};

use crate::domain_policy::{Executable, ImagePolicy, PinnedFile};
use crate::image_policy::{ExeEntry, FileEntry, PolicyDocument, parse_policy};
use crate::linux::sys;
use crate::sha256::Sha256;

#[cfg(feature = "apparatus-policy")]
pub const EMBEDDED: Option<&str> = Some(include_str!(env!("RW_KEEPER_APPARATUS_POLICY_FILE")));
#[cfg(not(feature = "apparatus-policy"))]
pub const EMBEDDED: Option<&str> = None;

/// One pinned file held open (`O_PATH`) since startup, with its identity.
pub struct HeldFile {
    pub fd: OwnedFd,
    pub identity: (u64, u64),
}

pub struct HeldPolicy {
    pub policy: ImagePolicy,
    /// By view path.
    pub files: BTreeMap<String, HeldFile>,
}

impl HeldPolicy {
    pub fn file(&self, path: &str) -> Option<&HeldFile> {
        self.files.get(path)
    }
}

fn hash(fd: &OwnedFd) -> io::Result<([u8; 32], bool)> {
    let readable = sys::reopen_readable(fd.as_raw_fd())?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 1024 * 1024];
    let mut offset: i64 = 0;
    let mut elf = false;
    loop {
        // SAFETY: valid buffer.
        let count = unsafe { libc::pread(readable.as_raw_fd(), chunk.as_mut_ptr() as *mut libc::c_void, chunk.len(), offset as libc::off_t) };
        if count < 0 {
            if sys::errno() == libc::EINTR {
                continue;
            }
            return Err(sys::last_error());
        }
        if count == 0 {
            break;
        }
        if offset == 0 {
            elf = count >= 4 && &chunk[..4] == b"\x7fELF";
        }
        hasher.update(&chunk[..count as usize]);
        offset += count as i64;
    }
    Ok((hasher.finalize(), elf))
}

fn hold(entry: &FileEntry) -> Result<(HeldFile, bool, [u8; 32]), String> {
    let fd = sys::open_nofollow(libc::AT_FDCWD, &entry.source, false).map_err(|error| format!("{}: {error}", entry.source))?;
    let stat = sys::fstat(fd.as_raw_fd()).map_err(|error| format!("{}: {error}", entry.source))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(format!("{}: not a regular file", entry.source));
    }
    let (digest, elf) = hash(&fd).map_err(|error| format!("{}: {error}", entry.source))?;
    if entry.sha256.is_some_and(|pinned| pinned != digest) {
        return Err(format!("{}: digest differs from the pin", entry.source));
    }
    let identity = sys::identity(&stat);
    Ok((HeldFile { fd, identity }, elf, digest))
}

/// Opens, checks and holds every file of a parsed document.
pub fn hold_document(document: &PolicyDocument) -> Result<HeldPolicy, String> {
    let mut files: BTreeMap<String, HeldFile> = BTreeMap::new();
    let mut elf: BTreeMap<String, bool> = BTreeMap::new();
    let mut digests: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    for entry in document.files() {
        let (held, is_elf, digest) = hold(entry)?;
        elf.insert(entry.path.clone(), is_elf);
        digests.insert(entry.path.clone(), digest);
        files.insert(entry.path.clone(), held);
    }
    let pinned = |entry: &FileEntry| -> PinnedFile {
        PinnedFile { path: entry.path.clone(), sha256: digests[&entry.path], identity: files[&entry.path].identity, regular: true }
    };
    let executable = |exe: &ExeEntry| -> Executable {
        Executable {
            file: pinned(&exe.file),
            direct_elf: elf.get(&exe.file.path).copied().unwrap_or(false),
            closure_complete: true,
            runtime_files: exe.runtime.iter().map(pinned).collect(),
        }
    };
    let policy = ImagePolicy {
        node: executable(&document.node),
        keeper: executable(&document.keeper),
        bwrap: executable(&document.bwrap),
        inventory: document.inventory.iter().map(|(name, exe)| (name.clone(), executable(exe))).collect(),
        code: document.code.iter().map(|(role, list)| (*role, list.iter().map(pinned).collect())).collect(),
        endpoint_heap_mib: document.endpoint_heap_mib,
        endpoint_nofile: document.endpoint_nofile,
    };
    // The stage runs the keeper's own image: the running binary must be the pinned keeper file.
    let own = sys::fstatat(libc::AT_FDCWD, "/proc/self/exe", 0).map_err(|error| format!("/proc/self/exe: {error}"))?;
    if sys::identity(&own) != policy.keeper.file.identity {
        return Err("the running keeper is not the pinned keeper file".into());
    }
    Ok(HeldPolicy { policy, files })
}

/// The embedded policy, if this build has one. `Err` means a policy exists but does not match the image (fail closed).
pub fn load_embedded() -> Result<Option<HeldPolicy>, String> {
    let Some(document) = EMBEDDED else { return Ok(None) };
    let parsed = parse_policy(document.as_bytes()).map_err(str::to_string)?;
    hold_document(&parsed).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest_of(bytes: &[u8]) -> String {
        crate::sha256::hex(&crate::sha256::sha256(bytes))
    }

    #[test]
    fn holding_checks_regular_files_digests_and_symlink_free_sources() {
        let base = std::env::temp_dir().join(format!("rw-keeper-policy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("elf"), b"\x7fELF-synthetic").unwrap();
        std::fs::write(base.join("script"), b"#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink(base.join("elf"), base.join("link")).unwrap();
        let root = base.to_str().unwrap();
        let entry = |name: &str, bytes: &[u8]| FileEntry { path: format!("/view/{name}"), source: format!("{root}/{name}"), sha256: crate::sha256::digest_from_hex(&digest_of(bytes)) };
        let (held, elf, digest) = hold(&entry("elf", b"\x7fELF-synthetic")).unwrap();
        assert_eq!(crate::sha256::hex(&digest), digest_of(b"\x7fELF-synthetic"));
        let mut attested = entry("elf", b"");
        attested.sha256 = None;
        assert_eq!(hold(&attested).unwrap().2, digest, "a self-attested entry records the computed digest");
        assert!(elf);
        let stat = std::fs::metadata(base.join("elf")).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(held.identity, (stat.dev(), stat.ino()));
        let (_, script_elf, _) = hold(&entry("script", b"#!/bin/sh\n")).unwrap();
        assert!(!script_elf, "a script is never a direct executable");
        assert!(hold(&entry("elf", b"other bytes")).is_err(), "digest mismatch refuses");
        assert!(hold(&entry("link", b"\x7fELF-synthetic")).is_err(), "a symlinked source refuses");
        let mut directory = entry("elf", b"");
        directory.source = root.to_string();
        assert!(hold(&directory).is_err(), "a directory refuses");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_default_build_embeds_no_policy() {
        if cfg!(feature = "apparatus-policy") {
            assert!(EMBEDDED.is_some());
        } else {
            assert!(EMBEDDED.is_none());
            assert!(load_embedded().unwrap().is_none());
        }
    }
}

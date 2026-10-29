//! The Linux backing of the view engine (plan section 5.4, "Backing-side resolution"). Every resolution is relative to
//! a held directory descriptor that derives from the inherited grant root, one component at a time, never following a
//! link (`O_NOFOLLOW`, `AT_SYMLINK_NOFOLLOW`), never by path. Node descriptors are `O_PATH`. Compiled for musl and
//! type-checked; NOT executed in this pass.
//!
//! Linux detail (evidence-r9 diagnosis note): an `O_DIRECTORY|O_NOFOLLOW` open of a symlink fails with ENOTDIR, not
//! ELOOP. `open_at` maps ENOTDIR through `fstatat(AT_SYMLINK_NOFOLLOW)` and reports a link as ELOOP (the engine refuses
//! it as `binding_unproven`; the identity comparison after every open also catches a swap).
//!
//! Transient descriptors: `list_children` holds at most two at a time (the parent and the next component) and closes
//! them before returning. They are not counted by the engine's ledger; they sit inside the RLIMIT_NOFILE headroom that
//! `descriptorCapProblem` reserves, and EMFILE makes the scan `unknown`, which refuses.

use std::ffi::CString;

use rw_fsview::engine::{Backing, DirEntry, Entry, EntryKind, Errno, Identity, OpenMode, SetAttr};

use crate::errno::errno_name;

pub struct LinuxBacking {
    root: libc::c_int,
}

impl LinuxBacking {
    pub fn new(root: libc::c_int) -> Self {
        LinuxBacking { root }
    }
}

fn last_errno() -> Errno {
    errno_name(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO))
}

fn cname(name: &[u8]) -> Result<CString, Errno> {
    if name.is_empty() || name.contains(&b'/') {
        return Err("EINVAL");
    }
    CString::new(name).map_err(|_| "EINVAL")
}

fn kind_of(mode: libc::mode_t) -> EntryKind {
    match mode & libc::S_IFMT {
        libc::S_IFDIR => EntryKind::Dir,
        libc::S_IFREG => EntryKind::File,
        libc::S_IFLNK => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}

fn identity(stat: &libc::stat) -> Identity {
    Identity { dev: stat.st_dev as u64, ino: stat.st_ino as u64 }
}

fn fstatat(dir: libc::c_int, name: &CString) -> Result<Option<libc::stat>, Errno> {
    // SAFETY: zeroed stat out-parameter; valid C string.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } < 0 {
        let error = last_errno();
        return if error == "ENOENT" { Ok(None) } else { Err(error) };
    }
    Ok(Some(stat))
}

pub fn fstat(fd: libc::c_int) -> Result<libc::stat, Errno> {
    // SAFETY: zeroed stat out-parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } < 0 {
        return Err(last_errno());
    }
    Ok(stat)
}

fn close(fd: libc::c_int) {
    // SAFETY: closing a descriptor this backing opened.
    unsafe { libc::close(fd) };
}

/// Reads every entry of an open directory descriptor (from offset 0), without `.` and `..`. A DT_UNKNOWN type is
/// resolved with fstatat(AT_SYMLINK_NOFOLLOW) relative to the same descriptor.
fn read_dir(fd: libc::c_int) -> Result<Vec<DirEntry>, Errno> {
    // SAFETY: lseek on an owned descriptor.
    if unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0 {
        return Err(last_errno());
    }
    let mut entries = Vec::new();
    let mut buffer = vec![0u8; 32 * 1024];
    loop {
        // SAFETY: valid buffer; getdents64 fills linux_dirent64 records.
        let read = unsafe { libc::syscall(libc::SYS_getdents64, fd, buffer.as_mut_ptr(), buffer.len()) };
        if read < 0 {
            return Err(last_errno());
        }
        if read == 0 {
            return Ok(entries);
        }
        let mut offset = 0usize;
        while offset + 19 <= read as usize {
            // struct linux_dirent64 { u64 d_ino; i64 d_off; u16 d_reclen; u8 d_type; char d_name[]; }
            let reclen = u16::from_ne_bytes([buffer[offset + 16], buffer[offset + 17]]) as usize;
            if reclen < 19 || offset + reclen > read as usize {
                return Err("EIO");
            }
            let mut ino_bytes = [0u8; 8];
            ino_bytes.copy_from_slice(&buffer[offset..offset + 8]);
            let ino = u64::from_ne_bytes(ino_bytes);
            let kind = buffer[offset + 18];
            let name_bytes = &buffer[offset + 19..offset + reclen];
            let end = name_bytes.iter().position(|byte| *byte == 0).unwrap_or(name_bytes.len());
            let name = name_bytes[..end].to_vec();
            if name != b"." && name != b".." {
                let kind = match kind {
                    libc::DT_DIR => EntryKind::Dir,
                    libc::DT_REG => EntryKind::File,
                    libc::DT_LNK => EntryKind::Symlink,
                    libc::DT_UNKNOWN => match cname(&name).ok().and_then(|c| fstatat(fd, &c).ok().flatten()) {
                        Some(stat) => kind_of(stat.st_mode),
                        // Unknown kind: refuse rather than let a descendant scan miss a directory.
                        None => return Err("EIO"),
                    },
                    _ => EntryKind::Other,
                };
                entries.push((name, kind, ino));
            }
            offset += reclen;
        }
    }
}

impl Backing for LinuxBacking {
    type Desc = libc::c_int;
    type Attr = libc::stat;
    type StatFs = libc::statfs;

    fn root_descriptor(&self) -> libc::c_int {
        self.root
    }

    fn identity_at(&mut self, dir: libc::c_int, name: &[u8]) -> Result<Option<Entry>, Errno> {
        let name = cname(name)?;
        Ok(fstatat(dir, &name)?.map(|stat| Entry { identity: Some(identity(&stat)), kind: kind_of(stat.st_mode) }))
    }

    fn identity_of(&mut self, desc: libc::c_int) -> Option<Identity> {
        fstat(desc).ok().map(|stat| identity(&stat))
    }

    fn open_at(&mut self, dir: libc::c_int, name: &[u8], mode: OpenMode) -> Result<libc::c_int, Errno> {
        let name = if name == b"." { CString::new(".").map_err(|_| "EINVAL")? } else { cname(name)? };
        let flags = libc::O_NOFOLLOW | libc::O_CLOEXEC | match mode {
            OpenMode::Node { directory: true } => libc::O_PATH | libc::O_DIRECTORY,
            OpenMode::Node { directory: false } => libc::O_PATH,
            OpenMode::DirHandle => libc::O_RDONLY | libc::O_DIRECTORY,
            OpenMode::FileHandle { read, write, append } => {
                let access = match (read, write) { (true, true) => libc::O_RDWR, (false, true) => libc::O_WRONLY, _ => libc::O_RDONLY };
                // Never O_CREAT, O_EXCL or O_TRUNC; O_NONBLOCK so that a FIFO cannot block the server.
                access | libc::O_NONBLOCK | if append { libc::O_APPEND } else { 0 }
            }
        };
        // SAFETY: valid descriptor number and C string.
        let fd = unsafe { libc::openat(dir, name.as_ptr(), flags) };
        if fd >= 0 {
            return Ok(fd);
        }
        let error = last_errno();
        if error == "ENOTDIR" {
            if let Ok(Some(stat)) = fstatat(dir, &name) {
                if kind_of(stat.st_mode) == EntryKind::Symlink {
                    return Err("ELOOP");
                }
            }
        }
        Err(error)
    }

    fn close(&mut self, desc: libc::c_int) {
        if desc != self.root {
            close(desc);
        }
    }

    fn read(&mut self, desc: libc::c_int, offset: u64, length: u32) -> Result<Vec<u8>, Errno> {
        let mut buffer = vec![0u8; length as usize];
        // SAFETY: valid buffer of `length` bytes.
        let read = unsafe { libc::pread(desc, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len(), offset as libc::off_t) };
        if read < 0 {
            return Err(last_errno());
        }
        buffer.truncate(read as usize);
        Ok(buffer)
    }

    fn write(&mut self, desc: libc::c_int, offset: u64, data: &[u8]) -> Result<usize, Errno> {
        // SAFETY: valid slice.
        let written = unsafe { libc::pwrite(desc, data.as_ptr() as *const libc::c_void, data.len(), offset as libc::off_t) };
        if written < 0 { Err(last_errno()) } else { Ok(written as usize) }
    }

    fn list_dir(&mut self, desc: libc::c_int) -> Result<Vec<DirEntry>, Errno> {
        read_dir(desc)
    }

    fn list_children(&mut self, dir: libc::c_int, rel: &[Vec<u8>]) -> Result<Vec<(Vec<u8>, bool)>, Errno> {
        let mut current: Option<libc::c_int> = None;
        for component in rel {
            let name = cname(component)?;
            let parent = current.unwrap_or(dir);
            // SAFETY: valid descriptor and C string.
            let next = unsafe { libc::openat(parent, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            let error = last_errno();
            if let Some(fd) = current.take() {
                close(fd);
            }
            if next < 0 {
                return Err(error);
            }
            current = Some(next);
        }
        let Some(fd) = current else {
            // The directory itself: reopen it for reading (dir may be O_PATH).
            let dot = CString::new(".").map_err(|_| "EINVAL")?;
            // SAFETY: as above.
            let fd = unsafe { libc::openat(dir, dot.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            if fd < 0 {
                return Err(last_errno());
            }
            let result = read_dir(fd);
            close(fd);
            return result.map(|entries| entries.into_iter().map(|(name, kind, _)| (name, kind == EntryKind::Dir)).collect());
        };
        let result = read_dir(fd);
        close(fd);
        result.map(|entries| entries.into_iter().map(|(name, kind, _)| (name, kind == EntryKind::Dir)).collect())
    }

    fn create_at(&mut self, dir: libc::c_int, name: &[u8], directory: bool, mode: u32) -> Result<(), Errno> {
        let name = cname(name)?;
        if directory {
            // SAFETY: valid descriptor and C string.
            if unsafe { libc::mkdirat(dir, name.as_ptr(), mode as libc::mode_t) } < 0 {
                return Err(last_errno());
            }
            return Ok(());
        }
        // SAFETY: as above.
        let fd = unsafe { libc::openat(dir, name.as_ptr(), libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC, mode as libc::c_uint) };
        if fd < 0 {
            return Err(last_errno());
        }
        close(fd);
        Ok(())
    }

    fn remove_at(&mut self, dir: libc::c_int, name: &[u8], directory: bool) -> Result<(), Errno> {
        let name = cname(name)?;
        // SAFETY: valid descriptor and C string.
        if unsafe { libc::unlinkat(dir, name.as_ptr(), if directory { libc::AT_REMOVEDIR } else { 0 }) } < 0 {
            return Err(last_errno());
        }
        Ok(())
    }

    fn rename_at(&mut self, dir: libc::c_int, name: &[u8], new_dir: libc::c_int, new_name: &[u8], exchange: bool, noreplace: bool) -> Result<(), Errno> {
        let (name, new_name) = (cname(name)?, cname(new_name)?);
        let flags = if exchange { libc::RENAME_EXCHANGE } else if noreplace { libc::RENAME_NOREPLACE } else { 0 };
        // SAFETY: valid descriptors and C strings.
        if unsafe { libc::syscall(libc::SYS_renameat2, dir, name.as_ptr(), new_dir, new_name.as_ptr(), flags) } < 0 {
            return Err(last_errno());
        }
        Ok(())
    }

    fn link_at(&mut self, _source: libc::c_int, source_parent: libc::c_int, source_name: &[u8], new_dir: libc::c_int, new_name: &[u8]) -> Result<(), Errno> {
        let (source_name, new_name) = (cname(source_name)?, cname(new_name)?);
        // SAFETY: valid descriptors and C strings; flags 0 never follows a link.
        if unsafe { libc::linkat(source_parent, source_name.as_ptr(), new_dir, new_name.as_ptr(), 0) } < 0 {
            return Err(last_errno());
        }
        Ok(())
    }

    fn attributes(&mut self, desc: libc::c_int) -> Result<libc::stat, Errno> {
        fstat(desc)
    }

    fn readlink(&mut self, desc: libc::c_int) -> Result<Vec<u8>, Errno> {
        let empty = CString::new("").map_err(|_| "EINVAL")?;
        let mut buffer = vec![0u8; 4096];
        // SAFETY: readlinkat with an empty path reads the link an O_PATH descriptor refers to.
        let read = unsafe { libc::readlinkat(desc, empty.as_ptr(), buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) };
        if read < 0 {
            return Err(last_errno());
        }
        buffer.truncate(read as usize);
        Ok(buffer)
    }

    fn statfs(&mut self, desc: libc::c_int) -> Result<libc::statfs, Errno> {
        // SAFETY: zeroed out-parameter.
        let mut value: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(desc, &mut value) } < 0 {
            return Err(last_errno());
        }
        Ok(value)
    }

    fn symlink_at(&mut self, target: &[u8], dir: libc::c_int, name: &[u8]) -> Result<(), Errno> {
        let target = CString::new(target).map_err(|_| "EINVAL")?;
        let name = cname(name)?;
        // SAFETY: valid C strings and descriptor.
        if unsafe { libc::symlinkat(target.as_ptr(), dir, name.as_ptr()) } < 0 {
            return Err(last_errno());
        }
        Ok(())
    }

    fn set_attributes(&mut self, desc: libc::c_int, change: &SetAttr) -> Result<(), Errno> {
        let empty = CString::new("").map_err(|_| "EINVAL")?;
        if let Some(size) = change.size {
            // SAFETY: ftruncate on a writable handle the engine opened for this purpose.
            if unsafe { libc::ftruncate(desc, size as libc::off_t) } < 0 {
                return Err(last_errno());
            }
        }
        if let Some(mode) = change.mode {
            // fchmodat2 (Linux 6.6) with AT_EMPTY_PATH works on O_PATH descriptors; older kernels refuse (ENOSYS).
            // SAFETY: valid descriptor and empty C string.
            if unsafe { libc::syscall(libc::SYS_fchmodat2, desc, empty.as_ptr(), mode as libc::c_uint, libc::AT_EMPTY_PATH) } < 0 {
                return Err(last_errno());
            }
        }
        if change.atime_ns.is_some() || change.mtime_ns.is_some() {
            let spec = |value: Option<Option<i128>>| match value {
                None => libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
                Some(None) => libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_NOW },
                Some(Some(ns)) => libc::timespec { tv_sec: (ns.div_euclid(1_000_000_000)) as _, tv_nsec: (ns.rem_euclid(1_000_000_000)) as libc::c_long },
            };
            let times = [spec(change.atime_ns), spec(change.mtime_ns)];
            // SAFETY: valid descriptor, empty C string and two timespecs.
            if unsafe { libc::utimensat(desc, empty.as_ptr(), times.as_ptr(), libc::AT_EMPTY_PATH) } < 0 {
                return Err(last_errno());
            }
        }
        Ok(())
    }

    fn fsync(&mut self, desc: libc::c_int, datasync: bool) -> Result<(), Errno> {
        // SAFETY: fsync/fdatasync on an owned descriptor.
        let result = unsafe { if datasync { libc::fdatasync(desc) } else { libc::fsync(desc) } };
        if result < 0 { Err(last_errno()) } else { Ok(()) }
    }
}

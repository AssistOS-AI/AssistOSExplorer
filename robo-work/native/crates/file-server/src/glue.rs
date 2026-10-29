//! The fuser `Filesystem` implementation: every request goes through the view engine (policy, binding chain, post-read
//! check, descriptor cap). Linux only; compiled for musl and type-checked, NOT executed in this pass.
//!
//! fuser's default `open`, `opendir`, `statfs`, `release` and `releasedir` reply success without any check, so each is
//! overridden here (a host test greps this file for them). Operations not implemented reply with an explicit errno:
//! mknod EPERM, xattrs ENOTSUP (no reviewed set), ioctl ENOTTY, copy_file_range ENOSYS, fallocate EOPNOTSUPP,
//! RENAME_WHITEOUT EINVAL. Mutations on a read grant are EROFS before the engine runs (the mount is also `ro`).
//!
//! Root revocation: the keeper's SIGTERM is taken by the main thread (main.rs), which locks the engine (waiting for the
//! request in progress, so a write that completes is reported with its true result), calls `revoke_root`, sends the
//! best-effort invalidations and exits. `Shared::revoked` is also checked at the start of every request.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fuser::{
    AccessFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, KernelConfig, LockOwner,
    Notifier, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry,
    ReplyIoctl, ReplyOpen, ReplyStatfs, ReplyWrite, ReplyXattr, Request, TimeOrNow, WriteFlags, BsdFileFlags, IoctlFlags,
    CopyFileRangeFlags,
};
use rw_fsview::engine::{EntryKind, Reply, SetAttr, ViewEngine};
use rw_fsview::policy::NodeState;

use crate::backing::LinuxBacking;
use crate::errno::errno_value;
use crate::settings::{ATTR_TTL, ENTRY_TTL, OPENDIR_FLAGS, OPEN_FLAGS};

pub struct Shared {
    pub engine: Mutex<ViewEngine<LinuxBacking>>,
    pub revoked: AtomicBool,
    /// Invalidation intents go to a dedicated notifier thread through a bounded queue. The kernel's reverse
    /// inval_inode waits for page-cache folio locks; a page fault on a private mapping holds such a lock until its
    /// READ reply arrives, and that READ is served by the event-loop thread. Sending the notification from the event
    /// loop, or while holding the engine lock, could therefore hang the view. Intents are never a gate (D2).
    pub invalidations: Mutex<Option<SyncSender<u64>>>,
}

pub const INVALIDATION_QUEUE: usize = 4096;

impl Shared {
    pub fn new(engine: ViewEngine<LinuxBacking>) -> Arc<Self> {
        Arc::new(Shared { engine: Mutex::new(engine), revoked: AtomicBool::new(false), invalidations: Mutex::new(None) })
    }

    /// Starts the notifier thread. It holds no engine lock; a full queue drops intents (best effort).
    pub fn start_notifier(&self, notifier: Notifier) -> std::io::Result<()> {
        let (sender, receiver) = sync_channel::<u64>(INVALIDATION_QUEUE);
        std::thread::Builder::new().name("rw-inval".into()).spawn(move || {
            while let Ok(node) = receiver.recv() {
                let _ = notifier.inval_inode(INodeNo(node), 0, 0);
            }
        })?;
        if let Ok(mut slot) = self.invalidations.lock() {
            *slot = Some(sender);
        }
        Ok(())
    }

    /// Locks the engine; a poisoned lock (a panicked request) is taken over, because the engine's state is updated
    /// only after each backing call and the alternative is a hung view.
    pub fn lock(&self) -> MutexGuard<'_, ViewEngine<LinuxBacking>> {
        let mut engine = self.engine.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.revoked.load(Ordering::SeqCst) && engine.root_state() == NodeState::Ok {
            engine.revoke_root();
        }
        engine
    }

    /// Best-effort page invalidation intents (D2): handed to the notifier thread without blocking (`try_send`), so no
    /// kernel notification is ever written by the event loop or under the engine lock.
    pub fn flush_invalidations(&self, engine: &mut ViewEngine<LinuxBacking>) {
        let queued = engine.take_invalidations();
        if let Ok(guard) = self.invalidations.lock() {
            if let Some(sender) = guard.as_ref() {
                for node in queued {
                    let _ = sender.try_send(node);
                }
            }
        }
    }
}

/// Maps the settings' flag names to fuser constants; an unknown name panics at startup (`self_check`), never silently.
pub fn fopen_flags(names: &[&str]) -> Option<FopenFlags> {
    let mut flags = FopenFlags::empty();
    for name in names {
        flags |= match *name {
            "FOPEN_DIRECT_IO" => FopenFlags::FOPEN_DIRECT_IO,
            _ => return None,
        };
    }
    Some(flags)
}

pub struct Glue {
    shared: Arc<Shared>,
    read_only: bool,
    open_flags: FopenFlags,
    opendir_flags: FopenFlags,
}

fn error(code: &str) -> Errno {
    Errno::from_i32(errno_value(code))
}

fn time(seconds: i64, nanos: i64) -> SystemTime {
    if seconds >= 0 {
        UNIX_EPOCH + Duration::new(seconds as u64, nanos.clamp(0, 999_999_999) as u32)
    } else {
        UNIX_EPOCH - Duration::from_secs(seconds.unsigned_abs())
    }
}

fn file_type(mode: libc::mode_t) -> FileType {
    match mode & libc::S_IFMT {
        libc::S_IFDIR => FileType::Directory,
        libc::S_IFLNK => FileType::Symlink,
        libc::S_IFIFO => FileType::NamedPipe,
        libc::S_IFSOCK => FileType::Socket,
        libc::S_IFCHR => FileType::CharDevice,
        libc::S_IFBLK => FileType::BlockDevice,
        _ => FileType::RegularFile,
    }
}

fn kind_type(kind: EntryKind) -> FileType {
    match kind {
        EntryKind::Dir => FileType::Directory,
        EntryKind::Symlink => FileType::Symlink,
        _ => FileType::RegularFile,
    }
}

/// The view's inode number is the engine node id (the root is 1, FUSE_ROOT_ID); backing inode numbers never reach the
/// kernel as node ids.
fn attr(node: u64, stat: &libc::stat) -> FileAttr {
    FileAttr {
        ino: INodeNo(node),
        size: stat.st_size as u64,
        blocks: stat.st_blocks as u64,
        atime: time(stat.st_atime, stat.st_atime_nsec),
        mtime: time(stat.st_mtime, stat.st_mtime_nsec),
        ctime: time(stat.st_ctime, stat.st_ctime_nsec),
        crtime: UNIX_EPOCH,
        kind: file_type(stat.st_mode),
        perm: (stat.st_mode & 0o7777) as u16,
        nlink: stat.st_nlink as u32,
        uid: stat.st_uid,
        gid: stat.st_gid,
        rdev: stat.st_rdev as u32,
        blksize: stat.st_blksize as u32,
        flags: 0,
    }
}

fn to_ns(value: Option<TimeOrNow>) -> Option<Option<i128>> {
    value.map(|time| match time {
        TimeOrNow::Now => None,
        TimeOrNow::SpecificTime(at) => Some(match at.duration_since(UNIX_EPOCH) {
            Ok(after) => after.as_nanos() as i128,
            Err(before) => -(before.duration().as_nanos() as i128),
        }),
    })
}

impl Glue {
    pub fn new(shared: Arc<Shared>, read_only: bool) -> Self {
        Glue {
            shared,
            read_only,
            open_flags: fopen_flags(OPEN_FLAGS).expect("OPEN_FLAGS are mapped"),
            opendir_flags: fopen_flags(OPENDIR_FLAGS).expect("OPENDIR_FLAGS are mapped"),
        }
    }

    /// Lookup-style reply: a served node gets an entry with its attributes; if the attributes are refused the lookup
    /// count is given back.
    fn entry_for(engine: &mut ViewEngine<LinuxBacking>, node: u64, reply: ReplyEntry) {
        match engine.attributes(node) {
            Reply::Serve(stat) => reply.entry(&ENTRY_TTL, &attr(node, &stat), Generation(0)),
            other => {
                engine.forget(node, 1);
                reply.error(error(other.errno().unwrap_or("EIO")));
            }
        }
    }
}

impl Filesystem for Glue {
    fn init(&mut self, _req: &Request, _config: &mut KernelConfig) -> std::io::Result<()> {
        // No capability is added: the request stays fuser's Linux default (settings::INIT_CAPABILITIES).
        Ok(())
    }

    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let mut engine = self.shared.lock();
        match engine.lookup(parent.0, name.as_bytes()) {
            Reply::Serve(found) => Glue::entry_for(&mut engine, found.node_id, reply),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn forget(&self, _req: &Request, ino: INodeNo, nlookup: u64) {
        self.shared.lock().forget(ino.0, nlookup);
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let mut engine = self.shared.lock();
        match engine.attributes(ino.0) {
            Reply::Serve(stat) => reply.attr(&ATTR_TTL, &attr(ino.0, &stat)),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn setattr(
        &self, _req: &Request, ino: INodeNo, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>, size: Option<u64>,
        atime: Option<TimeOrNow>, mtime: Option<TimeOrNow>, _ctime: Option<SystemTime>, fh: Option<FileHandle>,
        _crtime: Option<SystemTime>, _chgtime: Option<SystemTime>, _bkuptime: Option<SystemTime>, _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        if uid.is_some() || gid.is_some() {
            return reply.error(Errno::EPERM);
        }
        let change = SetAttr { mode, size, atime_ns: to_ns(atime), mtime_ns: to_ns(mtime) };
        let mut engine = self.shared.lock();
        let result = match fh {
            Some(handle) => engine.setattr_handle(handle.0, &change),
            None => engine.setattr_node(ino.0, &change),
        };
        match result {
            Reply::Serve(outcome) if !outcome.tainted => match engine.attributes(ino.0) {
                Reply::Serve(stat) => reply.attr(&ATTR_TTL, &attr(ino.0, &stat)),
                other => reply.error(error(other.errno().unwrap_or("EIO"))),
            },
            // D2: the change took effect; it is reported as such, with the attributes the change produced.
            Reply::Serve(_) => match engine.raw_attributes_after_effect(ino.0) {
                Ok(stat) => reply.attr(&Duration::ZERO, &attr(ino.0, &stat)),
                Err(code) => reply.error(error(code)),
            },
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn readlink(&self, _req: &Request, ino: INodeNo, reply: ReplyData) {
        let mut engine = self.shared.lock();
        match engine.readlink(ino.0) {
            Reply::Serve(target) => reply.data(&target),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn mknod(&self, _req: &Request, _parent: INodeNo, _name: &OsStr, _mode: u32, _umask: u32, _rdev: u32, reply: ReplyEntry) {
        reply.error(Errno::EPERM);
    }

    fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, umask: u32, reply: ReplyEntry) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        match engine.create(parent.0, name.as_bytes(), true, mode & !umask) {
            Reply::Serve(created) => match created.node_id {
                Some(node) => Glue::entry_for(&mut engine, node, reply),
                // Created, but not trackable (tainted or not re-resolvable): the effect stands; the caller's outcome is
                // reported as an I/O error (forced-termination-style residual, recorded in the handoff).
                None => reply.error(Errno::EIO),
            },
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        self.remove(parent, name, false, reply);
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        self.remove(parent, name, true, reply);
    }

    fn symlink(&self, _req: &Request, parent: INodeNo, link_name: &OsStr, target: &Path, reply: ReplyEntry) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        match engine.symlink(parent.0, link_name.as_bytes(), target.as_os_str().as_bytes()) {
            Reply::Serve(created) => match created.node_id {
                Some(node) => Glue::entry_for(&mut engine, node, reply),
                None => reply.error(Errno::EIO),
            },
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn rename(&self, _req: &Request, parent: INodeNo, name: &OsStr, newparent: INodeNo, newname: &OsStr, flags: RenameFlags, reply: ReplyEmpty) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let exchange = flags.contains(RenameFlags::RENAME_EXCHANGE);
        let noreplace = flags.contains(RenameFlags::RENAME_NOREPLACE);
        if flags.contains(RenameFlags::RENAME_WHITEOUT) || (exchange && noreplace) || !(flags - RenameFlags::RENAME_EXCHANGE - RenameFlags::RENAME_NOREPLACE).is_empty() {
            return reply.error(Errno::EINVAL);
        }
        let mut engine = self.shared.lock();
        match engine.rename(parent.0, name.as_bytes(), newparent.0, newname.as_bytes(), exchange, noreplace) {
            Reply::Serve(()) => reply.ok(),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn link(&self, _req: &Request, ino: INodeNo, newparent: INodeNo, newname: &OsStr, reply: ReplyEntry) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        match engine.link(ino.0, newparent.0, newname.as_bytes()) {
            Reply::Serve(found) => Glue::entry_for(&mut engine, found.node_id, reply),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let (read, write) = match flags.acc_mode() {
            OpenAccMode::O_RDONLY => (true, false),
            OpenAccMode::O_WRONLY => (false, true),
            OpenAccMode::O_RDWR => (true, true),
        };
        if write && self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        if !matches!(engine.node_kind(ino.0), Some(EntryKind::File)) && engine.node_kind(ino.0) != Some(EntryKind::Dir) {
            // Symlinks are never opened through the view (O_NOFOLLOW); FIFOs, sockets and devices are not served.
            return reply.error(Errno::EACCES);
        }
        match engine.open(ino.0, read, write, flags.0 & libc::O_APPEND != 0) {
            Reply::Serve(fh) => reply.opened(FileHandle(fh), self.open_flags),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn read(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, size: u32, _flags: OpenFlags, _lock_owner: Option<LockOwner>, reply: ReplyData) {
        let mut engine = self.shared.lock();
        match engine.read(fh.0, offset, size) {
            Reply::Serve(data) => reply.data(&data),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn write(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, data: &[u8], _write_flags: WriteFlags, _flags: OpenFlags, _lock_owner: Option<LockOwner>, reply: ReplyWrite) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        match engine.write(fh.0, offset, data) {
            // Truthful even when tainted (D2): the bytes were written.
            Reply::Serve(outcome) => reply.written(outcome.written as u32),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn flush(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _lock_owner: LockOwner, reply: ReplyEmpty) {
        // Lifecycle, no data I/O (DR-3).
        reply.ok();
    }

    fn release(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _flags: OpenFlags, _lock_owner: Option<LockOwner>, _flush: bool, reply: ReplyEmpty) {
        self.shared.lock().release(fh.0);
        reply.ok();
    }

    fn fsync(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, datasync: bool, reply: ReplyEmpty) {
        let mut engine = self.shared.lock();
        match engine.fsync(fh.0, datasync) {
            Reply::Serve(()) => reply.ok(),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let mut engine = self.shared.lock();
        match engine.opendir(ino.0) {
            Reply::Serve(fh) => reply.opened(FileHandle(fh), self.opendir_flags),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn readdir(&self, _req: &Request, ino: INodeNo, fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        let mut engine = self.shared.lock();
        match engine.readdir(fh.0) {
            Reply::Serve((entries, _omitted)) => {
                let mut all: Vec<(u64, FileType, Vec<u8>)> = vec![(ino.0, FileType::Directory, b".".to_vec()), (ino.0, FileType::Directory, b"..".to_vec())];
                all.extend(entries.into_iter().map(|(name, kind, backing_ino)| (backing_ino.max(1), kind_type(kind), name)));
                for (index, (entry_ino, kind, name)) in all.iter().enumerate().skip(offset as usize) {
                    if reply.add(INodeNo(*entry_ino), (index + 1) as u64, *kind, OsStr::from_bytes(name)) {
                        break;
                    }
                }
                reply.ok();
            }
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn releasedir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _flags: OpenFlags, reply: ReplyEmpty) {
        self.shared.lock().release(fh.0);
        reply.ok();
    }

    fn fsyncdir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, datasync: bool, reply: ReplyEmpty) {
        let mut engine = self.shared.lock();
        match engine.fsync(fh.0, datasync) {
            Reply::Serve(()) => reply.ok(),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
    }

    fn statfs(&self, _req: &Request, ino: INodeNo, reply: ReplyStatfs) {
        let mut engine = self.shared.lock();
        match engine.statfs(ino.0) {
            Reply::Serve(value) => reply.statfs(
                value.f_blocks as u64, value.f_bfree as u64, value.f_bavail as u64, value.f_files as u64, value.f_ffree as u64,
                value.f_bsize as u32, 255, value.f_frsize as u32,
            ),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
    }

    fn setxattr(&self, _req: &Request, ino: INodeNo, _name: &OsStr, _value: &[u8], _flags: i32, _position: u32, reply: ReplyEmpty) {
        reply.error(self.xattr_errno(ino));
    }

    fn getxattr(&self, _req: &Request, ino: INodeNo, _name: &OsStr, _size: u32, reply: ReplyXattr) {
        reply.error(self.xattr_errno(ino));
    }

    fn listxattr(&self, _req: &Request, ino: INodeNo, _size: u32, reply: ReplyXattr) {
        reply.error(self.xattr_errno(ino));
    }

    fn removexattr(&self, _req: &Request, ino: INodeNo, _name: &OsStr, reply: ReplyEmpty) {
        reply.error(self.xattr_errno(ino));
    }

    fn access(&self, _req: &Request, ino: INodeNo, _mask: AccessFlags, reply: ReplyEmpty) {
        let mut engine = self.shared.lock();
        match engine.getattr(ino.0) {
            Reply::Serve(_) => reply.ok(),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
    }

    fn create(&self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, umask: u32, flags: i32, reply: ReplyCreate) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        let node = match engine.create(parent.0, name.as_bytes(), false, mode & !umask) {
            Reply::Serve(created) => match created.node_id {
                Some(node) => node,
                None => return reply.error(Errno::EIO),
            },
            other => return reply.error(error(other.errno().unwrap_or("EIO"))),
        };
        let (read, write) = match flags & libc::O_ACCMODE {
            libc::O_WRONLY => (false, true),
            libc::O_RDWR => (true, true),
            _ => (true, false),
        };
        let fh = match engine.open(node, read, write, flags & libc::O_APPEND != 0) {
            Reply::Serve(fh) => fh,
            other => {
                engine.forget(node, 1);
                return reply.error(error(other.errno().unwrap_or("EIO")));
            }
        };
        match engine.attributes(node) {
            Reply::Serve(stat) => reply.created(&ENTRY_TTL, &attr(node, &stat), Generation(0), FileHandle(fh), self.open_flags),
            other => {
                engine.release(fh);
                engine.forget(node, 1);
                reply.error(error(other.errno().unwrap_or("EIO")));
            }
        }
        self.shared.flush_invalidations(&mut engine);
    }

    fn ioctl(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _flags: IoctlFlags, _cmd: u32, _in_data: &[u8], _out_size: u32, reply: ReplyIoctl) {
        reply.error(Errno::ENOTTY);
    }

    fn fallocate(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _offset: u64, _length: u64, _mode: i32, reply: ReplyEmpty) {
        reply.error(Errno::from_i32(libc::EOPNOTSUPP));
    }

    fn copy_file_range(
        &self, _req: &Request, _ino_in: INodeNo, _fh_in: FileHandle, _offset_in: u64, _ino_out: INodeNo, _fh_out: FileHandle,
        _offset_out: u64, _len: u64, _flags: CopyFileRangeFlags, reply: ReplyWrite,
    ) {
        // DR-7: the kernel falls back to read and write, which carry the post-read check.
        reply.error(Errno::ENOSYS);
    }
}

impl Glue {
    fn remove(&self, parent: INodeNo, name: &OsStr, directory: bool, reply: ReplyEmpty) {
        if self.read_only {
            return reply.error(Errno::EROFS);
        }
        let mut engine = self.shared.lock();
        match engine.remove(parent.0, name.as_bytes(), directory) {
            Reply::Serve(()) => reply.ok(),
            other => reply.error(error(other.errno().unwrap_or("EIO"))),
        }
        self.shared.flush_invalidations(&mut engine);
    }

    /// xattr operations: the node policy first (a protected node answers ENOENT), then ENOTSUP (no reviewed set, DR-4).
    fn xattr_errno(&self, ino: INodeNo) -> Errno {
        let mut engine = self.shared.lock();
        match engine.getattr(ino.0) {
            Reply::Serve(_) => error("ENOTSUP"),
            other => error(other.errno().unwrap_or("EIO")),
        }
    }
}

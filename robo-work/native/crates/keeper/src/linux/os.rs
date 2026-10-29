//! `KeeperOs` on Linux: the filtered-view mount and the confined file-server spawn (plan section 5.4).
//!
//! Compiled and type-checked for x86_64-unknown-linux-musl; NOT executed in this pass. Every property below is a G1/G6
//! runtime obligation.
//!
//! mount_view, in order:
//!   1. The inherited grant-root slot must be a directory whose (st_dev, st_ino) equals `expectedRootIdentity`
//!      (`root_identity_mismatch` otherwise). The keeper never resolves a source path.
//!   2. The mountpoint (the locator derived from the reservation) and an empty sibling directory `.fsroot-<grant>` are
//!      created component by component under the runtime root, never following a link (`symlink_in_path`; on Linux an
//!      O_DIRECTORY|O_NOFOLLOW open of a symlink is ENOTDIR, which is mapped through lstat).
//!   3. `/dev/fuse` is opened and mounted with `allow_other`, `nosuid`, `nodev` (and `ro` for a read grant), by the
//!      keeper itself. No fusermount or setuid helper exists or runs.
//!   4. The file server is forked and, before its exec: parent-death SIGKILL; descriptors exactly 0, 1, 2, `/dev/fuse`
//!      (3) and the grant root (4); new mount, network, IPC and UTS namespaces; private propagation; an empty tmpfs root
//!      by pivot_root (no worker store, HOME, runtime directory or other grant reachable by path); RLIMIT_NOFILE; all
//!      five capability sets emptied; no_new_privs; then execveat of the binary through a descriptor opened before the
//!      pivot. The server installs its own seccomp filter first thing (execve blocked).
//!   5. The keeper closes its `/dev/fuse` copy and the grant-root slot (custody: G1 checks `/proc/<keeper>/fd`).
//!   6. Identity tuples: mount ID from mountinfo, mount-namespace inode, server pid, start time and PID-namespace inode.

use std::ffi::CString;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use std::collections::HashMap;

use rw_proto::json::Value;
use rw_proto::keeper_frames::{CreateKind, ErrorKind, Spec, WireIdentity};
use rw_proto::mount_frames::{MountRequest, MountedIdentity, RefusalKind};

use crate::args::FILE_SERVER_PATH;
use crate::args::CgroupSubtree;
use crate::cgroup_subtree::{self, ControlFile, Facts};
use crate::core::{Created, EndStep, KeeperOs, OsError, Signal};
use crate::procfs::{find_fuse_mount, mounts_at_or_below, parse_mountinfo, start_time_from_stat};
use crate::root_identity::{held_path, path_identity, verify_root};

pub struct LinuxOs {
    runtime_root: String,
    file_server: CString,
    keeper_pid: libc::pid_t,
    /// The runtime root, held by descriptor from startup (review RK-3: never re-resolved by path), and its identity.
    root: OwnedFd,
    root_identity: (u64, u64),
    /// The execution's runtime directory, once created.
    runtime_dir: Option<RuntimeDir>,
    /// Held network namespaces by handle (the keeper is their holder until release_egress, R3-5).
    netns: HashMap<String, OwnedFd>,
    cgroup_subtree: Option<HeldCgroupSubtree>,
    /// Future construction consumes this once. main does not supply it until image-policy integration is approved.
    _startup_custody: Option<crate::domain_policy::StartupCustody>,
}

/// Startup custody, retained until exit. R3 has no consumer beyond re-verification; it creates no cgroups.
pub struct HeldCgroupSubtree {
    path: String,
    fd: OwnedFd,
    identity: (u64, u64),
}

impl HeldCgroupSubtree {
    pub fn open(bound: &CgroupSubtree) -> io::Result<Self> {
        if std::fs::canonicalize(&bound.path).ok().as_deref() != Some(std::path::Path::new(&bound.path)) {
            return Err(io::Error::other("cgroup_subtree_invalid"));
        }
        let path = cstr(&bound.path)?;
        // SAFETY: valid C string; read-only directory descriptor, never follows the final component.
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fresh descriptor exclusively owned by this value.
        let held = Self { path: bound.path.clone(), fd: unsafe { OwnedFd::from_raw_fd(fd) }, identity: (bound.dev, bound.ino) };
        held.checked()?;
        Ok(held)
    }

    fn checked(&self) -> io::Result<RawFd> {
        let fd = self.fd.as_raw_fd();
        let stat = fstat(fd)?;
        // SAFETY: valid descriptor and zeroed out-parameter; fstatfs reads filesystem facts only.
        let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(fd, &mut fs) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let control = |name: &str| -> Option<ControlFile> {
            let name = cstr(name).ok()?;
            // SAFETY: valid directory fd, C string and out-parameter. Symlinks are inspected, never followed.
            let mut info: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstatat(fd, name.as_ptr(), &mut info, libc::AT_SYMLINK_NOFOLLOW) } < 0 {
                return None;
            }
            Some(ControlFile { regular: info.st_mode & libc::S_IFMT == libc::S_IFREG, uid: info.st_uid })
        };
        let identity = (stat.st_dev as u64, stat.st_ino as u64);
        let facts = Facts {
            canonical: std::fs::canonicalize(&self.path).ok().as_deref() == Some(std::path::Path::new(&self.path)),
            fs_magic: fs.f_type as u64, directory: stat.st_mode & libc::S_IFMT == libc::S_IFDIR,
            identity, uid: stat.st_uid, procs: control("cgroup.procs"), subtree_control: control("cgroup.subtree_control"),
        };
        // SAFETY: geteuid reads this process's effective user id.
        cgroup_subtree::validate(self.identity, unsafe { libc::geteuid() }, facts).map_err(io::Error::other)?;
        verify_root(self.identity, Some(identity), path_identity(std::path::Path::new(&self.path))).map_err(|_| io::Error::other("cgroup_subtree_invalid"))?;
        Ok(fd)
    }
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)
}

fn cstr(text: &str) -> io::Result<CString> {
    CString::new(text).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    // SAFETY: zeroed stat is a valid out-parameter; fd is a descriptor number.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stat)
}

fn stat_path(path: &str) -> io::Result<libc::stat> {
    let path = cstr(path)?;
    // SAFETY: valid C string and out-parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(path.as_ptr(), &mut stat) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stat)
}

/// Opens (creating if absent) one directory component below `dir`, never following a link. ENOTDIR from the
/// O_DIRECTORY|O_NOFOLLOW open is mapped through fstatat: a link there is `symlink_in_path`.
fn open_or_create_component(dir: RawFd, name: &str, mode: libc::mode_t) -> Result<OwnedFd, &'static str> {
    let cname = cstr(name).map_err(|_| "bad_component")?;
    // SAFETY: valid descriptor number and C string.
    if unsafe { libc::mkdirat(dir, cname.as_ptr(), mode) } < 0 && errno() != libc::EEXIST {
        return Err("mountpoint_create_failed");
    }
    // SAFETY: as above.
    let fd = unsafe { libc::openat(dir, cname.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        let error = errno();
        if error == libc::ENOTDIR || error == libc::ELOOP {
            // SAFETY: zeroed stat out-parameter.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstatat(dir, cname.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } == 0 && (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
                return Err("symlink_in_path");
            }
        }
        return Err("mountpoint_open_failed");
    }
    // SAFETY: fd is a fresh descriptor we own.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Walks `relative` (slash-separated) below an open directory, creating components.
fn walk_create(base: RawFd, relative: &str) -> Result<OwnedFd, &'static str> {
    let mut current: Option<OwnedFd> = None;
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return Err("bad_component");
        }
        let dir = current.as_ref().map_or(base, |fd| fd.as_raw_fd());
        current = Some(open_or_create_component(dir, part, 0o700)?);
    }
    current.ok_or("bad_component")
}

impl LinuxOs {
    pub fn new(runtime_root: &str) -> io::Result<Self> {
        // The root must be canonical (review RK-3: mountinfo paths are canonical, so a symlinked component would hide a
        // view below it from the removal check); main also refuses a non-canonical --runtime-root.
        if std::fs::canonicalize(runtime_root).ok().as_deref() != Some(std::path::Path::new(runtime_root)) {
            return Err(io::Error::other("the runtime root is not canonical"));
        }
        let path = cstr(runtime_root)?;
        // SAFETY: valid C string.
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fresh descriptor we own.
        let root = unsafe { OwnedFd::from_raw_fd(fd) };
        let stat = fstat(root.as_raw_fd())?;
        Ok(LinuxOs {
            runtime_root: runtime_root.to_string(), file_server: cstr(FILE_SERVER_PATH)?,
            // SAFETY: getpid has no preconditions.
            keeper_pid: unsafe { libc::getpid() },
            root, root_identity: (stat.st_dev as u64, stat.st_ino as u64), runtime_dir: None, netns: HashMap::new(), cgroup_subtree: None, _startup_custody: None,
        })
    }

    pub fn with_cgroup_subtree(mut self, subtree: Option<HeldCgroupSubtree>) -> Self {
        self.cgroup_subtree = subtree;
        self
    }

    pub fn with_startup_custody(mut self, custody: crate::domain_policy::StartupCustody) -> Self {
        self._startup_custody = Some(custody);
        self
    }

    /// The held runtime root, after checking that the held descriptor AND the configured path (re-resolved without
    /// following a final symlink) are both still the directory recorded at startup (review F-4: an `fstat` of the held
    /// descriptor alone always matches, so a renamed or replaced root went unnoticed by the path-based legs).
    fn checked_root(&self) -> Result<RawFd, &'static str> {
        let held = fstat(self.root.as_raw_fd()).ok().map(|stat| (stat.st_dev as u64, stat.st_ino as u64));
        verify_root(self.root_identity, held, path_identity(std::path::Path::new(&self.runtime_root)))?;
        Ok(self.root.as_raw_fd())
    }

    fn view_dirs(&self, request: &MountRequest) -> Result<(OwnedFd, OwnedFd), &'static str> {
        let base = self.checked_root()?;
        let relative = request.mountpoint.strip_prefix(&self.runtime_root).ok_or("mountpoint_not_locator")?;
        let (parent, leaf) = relative.rsplit_once('/').ok_or("mountpoint_not_locator")?;
        let parent_fd = walk_create(base, parent)?;
        let mountpoint = open_or_create_component(parent_fd.as_raw_fd(), leaf, 0o700)?;
        let fsroot = open_or_create_component(parent_fd.as_raw_fd(), &format!(".fsroot-{}", request.grant_id), 0o500)?;
        Ok((mountpoint, fsroot))
    }
}

const TMPFS_MAGIC: i64 = 0x0102_1994;

/// Everything the forked child needs, prepared before fork so that the child does no allocation.
struct ChildPlan {
    fuse: RawFd,
    root: RawFd,
    exe: RawFd,
    report: RawFd,
    devnull: RawFd,
    fsroot_path: CString,
    dot: CString,
    dotdot: CString,
    slash: CString,
    tmpfs: CString,
    tmpfs_data: CString,
    empty: CString,
    argv: Vec<CString>,
    rlimit_nofile: u64,
    keeper_pid: libc::pid_t,
}

/// Runs in the forked child. Writes the failing step's errno to `report` and exits 127 on any failure.
unsafe fn child_exec(plan: &ChildPlan) -> ! {
    unsafe {
        let fail = |step: i32| -> ! {
            let code: [i32; 2] = [step, errno()];
            libc::write(plan.report, code.as_ptr() as *const libc::c_void, 8);
            libc::_exit(127)
        };
        if rw_confine::linux::kill_on_parent_death(plan.keeper_pid).is_err() {
            fail(1);
        }
        // Move every source above the target range first, so no dup2 clobbers a source.
        let high = |fd: RawFd| libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 100);
        let (devnull, fuse, root, exe, report) = (high(plan.devnull), high(plan.fuse), high(plan.root), high(plan.exe), high(plan.report));
        if devnull < 0 || fuse < 0 || root < 0 || exe < 0 || report < 0 {
            fail(2);
        }
        // 0 = /dev/null, 1 and 2 = the keeper's stderr (diagnostics only), 3 = /dev/fuse, 4 = grant root.
        if libc::dup2(devnull, 0) < 0 || libc::dup2(2, 1) < 0 || libc::dup2(fuse, 3) < 0 || libc::dup2(root, 4) < 0
            || libc::dup2(exe, 5) < 0 || libc::dup2(report, 6) < 0
        {
            fail(3);
        }
        // 5 (the executable) and 6 (the report pipe) close at exec.
        libc::fcntl(5, libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(6, libc::F_SETFD, libc::FD_CLOEXEC);
        let report = 6;
        let fail = |step: i32| -> ! {
            let code: [i32; 2] = [step, errno()];
            libc::write(report, code.as_ptr() as *const libc::c_void, 8);
            libc::_exit(127)
        };
        if libc::syscall(libc::SYS_close_range, 7u32, u32::MAX, 0u32) < 0 {
            fail(4);
        }
        if libc::unshare(libc::CLONE_NEWNS | libc::CLONE_NEWNET | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS) < 0 {
            fail(5);
        }
        if libc::mount(std::ptr::null(), plan.slash.as_ptr(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()) < 0 {
            fail(6);
        }
        if libc::mount(plan.tmpfs.as_ptr(), plan.fsroot_path.as_ptr(), plan.tmpfs.as_ptr(),
            libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, plan.tmpfs_data.as_ptr() as *const libc::c_void) < 0
        {
            fail(7);
        }
        if libc::chdir(plan.fsroot_path.as_ptr()) < 0 {
            fail(8);
        }
        // Review R4/RK-4: the cwd must be the tmpfs just mounted, not a directory a same-UID writer substituted: a tmpfs,
        // the root of its own mount (its device differs from its parent's, which also holds when the runtime root is
        // itself on a tmpfs), empty (two links) and with the mode given at mount (0555).
        let mut fs: libc::statfs = std::mem::zeroed();
        let mut here: libc::stat = std::mem::zeroed();
        let mut up: libc::stat = std::mem::zeroed();
        if libc::statfs(plan.dot.as_ptr(), &mut fs) < 0 || fs.f_type as i64 != TMPFS_MAGIC
            || libc::stat(plan.dot.as_ptr(), &mut here) < 0 || libc::stat(plan.dotdot.as_ptr(), &mut up) < 0
            || here.st_dev == up.st_dev || here.st_nlink != 2 || here.st_mode & 0o7777 != 0o555
        {
            fail(14);
        }
        if libc::syscall(libc::SYS_pivot_root, plan.dot.as_ptr(), plan.dot.as_ptr()) < 0 {
            fail(8);
        }
        if libc::umount2(plan.dot.as_ptr(), libc::MNT_DETACH) < 0 || libc::chdir(plan.slash.as_ptr()) < 0 {
            fail(9);
        }
        if rw_confine::linux::set_rlimit_nofile(plan.rlimit_nofile).is_err() {
            fail(10);
        }
        if rw_confine::linux::drop_all_capabilities().is_err() {
            fail(11);
        }
        if rw_confine::linux::set_no_new_privs().is_err() {
            fail(12);
        }
        let mut argv: Vec<*const libc::c_char> = plan.argv.iter().map(|arg| arg.as_ptr()).collect();
        argv.push(std::ptr::null());
        let envp: [*const libc::c_char; 1] = [std::ptr::null()];
        libc::syscall(libc::SYS_execveat, 5, plan.empty.as_ptr(), argv.as_ptr(), envp.as_ptr(), libc::AT_EMPTY_PATH);
        fail(13)
    }
}

fn read_identity(pid: libc::pid_t) -> io::Result<(u64, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let start = start_time_from_stat(&stat).ok_or_else(|| io::Error::other("stat"))?;
    let pid_ns = stat_path(&format!("/proc/{pid}/ns/pid"))?.st_ino as u64;
    Ok((start, pid_ns))
}

impl LinuxOs {
    fn mount_view_impl(&mut self, request: &MountRequest, resource: &str) -> Result<MountedIdentity, (RefusalKind, &'static str)> {
        let refused = |code| (RefusalKind::Refused, code);
        let failure = |code| (RefusalKind::Failure, code);
        let root_fd = request.root_slot as RawFd;
        // The slot is consumed whatever happens: it is closed when this function returns (custody).
        // SAFETY: the slot was inherited at spawn for exactly this purpose and is used once (MountSet).
        let root = unsafe { OwnedFd::from_raw_fd(root_fd) };
        let stat = fstat(root.as_raw_fd()).map_err(|_| refused("root_slot_unavailable"))?;
        let (expected_dev, expected_ino) = (request.expected_dev.parse::<u64>(), request.expected_ino.parse::<u64>());
        if (stat.st_mode & libc::S_IFMT) != libc::S_IFDIR || Ok(stat.st_dev as u64) != expected_dev || Ok(stat.st_ino as u64) != expected_ino {
            return Err(refused("root_identity_mismatch"));
        }
        let (mountpoint, fsroot) = self.view_dirs(request).map_err(refused)?;
        // The empty root is addressed by its path in the child: the runtime directory is supervisor/keeper-private and
        // its components were just created or opened without following links. (A /proc/self/fd magic link would
        // resolve to the directory itself, not to the tmpfs mounted over it.)
        drop(fsroot);
        let parent_path = request.mountpoint.rsplit_once('/').map(|(parent, _)| parent).ok_or(failure("internal"))?;
        let fsroot_path = cstr(&format!("{parent_path}/.fsroot-{}", request.grant_id)).map_err(|_| failure("internal"))?;
        let dev_fuse = cstr("/dev/fuse").map_err(|_| failure("internal"))?;
        // SAFETY: valid C string.
        let fuse = unsafe { libc::open(dev_fuse.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
        if fuse < 0 {
            return Err(failure("dev_fuse_unavailable"));
        }
        // SAFETY: fresh descriptor we own; dropping it closes the keeper's copy (custody obligation).
        let fuse = unsafe { OwnedFd::from_raw_fd(fuse) };
        // SAFETY: getuid/getgid have no preconditions.
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        let data = format!("fd={},rootmode=40000,user_id={uid},group_id={gid},allow_other", fuse.as_raw_fd());
        let data = cstr(&data).map_err(|_| failure("internal"))?;
        let target = cstr(&format!("/proc/self/fd/{}", mountpoint.as_raw_fd())).map_err(|_| failure("internal"))?;
        let (source, fstype) = (cstr("rw-fsview").map_err(|_| failure("internal"))?, cstr("fuse").map_err(|_| failure("internal"))?);
        let mut flags = libc::MS_NOSUID | libc::MS_NODEV;
        if request.read_only {
            flags |= libc::MS_RDONLY;
        }
        // SAFETY: valid C strings; data is a NUL-terminated option string.
        if unsafe { libc::mount(source.as_ptr(), target.as_ptr(), fstype.as_ptr(), flags, data.as_ptr() as *const libc::c_void) } < 0 {
            return Err(failure("mount_failed"));
        }
        let detach_now = || {
            if let Ok(path) = cstr(&request.mountpoint) {
                // SAFETY: valid C string.
                unsafe { libc::umount2(path.as_ptr(), libc::MNT_DETACH) };
            }
        };
        let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
        let Some(mount_id) = find_fuse_mount(&parse_mountinfo(&mountinfo), &request.mountpoint).map(|entry| entry.mount_id) else {
            detach_now();
            return Err(failure("mount_identity_unavailable"));
        };
        let mount_ns = match stat_path("/proc/self/ns/mnt") {
            Ok(stat) => stat.st_ino as u64,
            Err(_) => {
                detach_now();
                return Err(failure("mount_identity_unavailable"));
            }
        };

        // Spawn the file server.
        let exe = {
            // SAFETY: valid C string.
            let fd = unsafe { libc::open(self.file_server.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
            if fd < 0 {
                detach_now();
                return Err(failure("file_server_unavailable"));
            }
            // SAFETY: fresh descriptor we own.
            unsafe { OwnedFd::from_raw_fd(fd) }
        };
        let devnull_path = cstr("/dev/null").map_err(|_| failure("internal"))?;
        // SAFETY: valid C string.
        let devnull = unsafe { libc::open(devnull_path.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
        if devnull < 0 {
            detach_now();
            return Err(failure("devnull_unavailable"));
        }
        // SAFETY: fresh descriptor we own.
        let devnull = unsafe { OwnedFd::from_raw_fd(devnull) };
        let mut pipe = [0 as RawFd; 2];
        // SAFETY: valid out array.
        if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
            detach_now();
            return Err(failure("pipe_failed"));
        }
        // SAFETY: fresh descriptors we own.
        let (report_read, report_write) = unsafe { (OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1])) };
        let argv = [
            self.file_server.to_str().unwrap_or("rw-file-server").to_string(),
            "--fuse-fd".into(), "3".into(), "--root-fd".into(), "4".into(),
            "--access".into(), (if request.read_only { "read" } else { "write" }).into(),
            "--descriptor-cap".into(), request.descriptor_cap.to_string(),
            "--grant".into(), request.grant_id.clone(),
        ];
        let plan = ChildPlan {
            fuse: fuse.as_raw_fd(), root: root.as_raw_fd(), exe: exe.as_raw_fd(), report: report_write.as_raw_fd(), devnull: devnull.as_raw_fd(),
            fsroot_path, dot: cstr(".").map_err(|_| failure("internal"))?, dotdot: cstr("..").map_err(|_| failure("internal"))?, slash: cstr("/").map_err(|_| failure("internal"))?,
            tmpfs: cstr("tmpfs").map_err(|_| failure("internal"))?, tmpfs_data: cstr("size=16k,mode=0555").map_err(|_| failure("internal"))?,
            empty: cstr("").map_err(|_| failure("internal"))?,
            argv: argv.iter().map(|arg| cstr(arg)).collect::<io::Result<Vec<_>>>().map_err(|_| failure("internal"))?,
            rlimit_nofile: request.rlimit_nofile as u64, keeper_pid: self.keeper_pid,
        };
        // SAFETY: the keeper is single-threaded (it never spawns threads), so fork is safe; the child only runs
        // child_exec, which uses prepared data.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            detach_now();
            return Err(failure("fork_failed"));
        }
        if pid == 0 {
            // SAFETY: in the child.
            unsafe { child_exec(&plan) }
        }
        drop(report_write);
        // Custody: the keeper's copies of /dev/fuse and of the grant root close here, after the hand-off.
        drop(fuse);
        drop(root);
        drop(exe);
        drop(devnull);
        let mut report = [0u8; 8];
        let mut reader = std::fs::File::from(report_read);
        let reported = reader.read(&mut report).unwrap_or(0);
        if reported != 0 {
            // SAFETY: the child is ours; reap it.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
            detach_now();
            return Err(failure("file_server_spawn_failed"));
        }
        let Ok((start_time, pid_ns)) = read_identity(pid) else {
            // SAFETY: as above.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            detach_now();
            return Err(failure("file_server_identity_unavailable"));
        };
        Ok(MountedIdentity {
            resource: resource.to_string(), mount_id, mountpoint: request.mountpoint.clone(), mount_namespace_inode: mount_ns,
            server_pid: pid as i64, server_start_time: start_time, server_pid_namespace_inode: pid_ns,
        })
    }

    fn detach_impl(&mut self, identity: &MountedIdentity) -> Result<(), &'static str> {
        let path = cstr(&identity.mountpoint).map_err(|_| "internal")?;
        // SAFETY: valid C string. UMOUNT_NOFOLLOW: a substituted link is never followed (review R4).
        if unsafe { libc::umount2(path.as_ptr(), libc::MNT_DETACH | libc::UMOUNT_NOFOLLOW) } < 0 && errno() != libc::EINVAL {
            return Err("detach_failed");
        }
        Ok(())
    }

    fn signal_impl(&mut self, pid: i64, signal: Signal) {
        let number = match signal { Signal::Term => libc::SIGTERM, Signal::Kill => libc::SIGKILL };
        // SAFETY: the pid is our own child, not yet reaped (the run loop reaps and reports exits before signalling
        // again), so it cannot have been reused.
        unsafe { libc::kill(pid as libc::pid_t, number) };
    }

    fn random_hex(&mut self) -> String {
        let mut bytes = [0u8; 16];
        // SAFETY: valid buffer.
        let filled = unsafe { libc::getrandom(bytes.as_mut_ptr() as *mut libc::c_void, bytes.len(), 0) };
        if filled != bytes.len() as isize {
            // Never reached after early boot; a time- and pid-derived value is still unique per keeper.
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            return format!("{:032x}", now ^ ((self.keeper_pid as u128) << 64));
        }
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

/// Creates `name` below `dir` with mode 0700 (EEXIST is an error: a runtime directory is created exactly once) and opens
/// it without following links.
fn create_private_dir(dir: RawFd, name: &str) -> Result<OwnedFd, OsError> {
    let cname = cstr(name).map_err(|_| (ErrorKind::Failure, "setup_failed"))?;
    // SAFETY: valid descriptor and C string.
    if unsafe { libc::mkdirat(dir, cname.as_ptr(), 0o700) } < 0 {
        return Err((ErrorKind::Failure, "setup_failed"));
    }
    open_or_create_component(dir, name, 0o700).map_err(|_| (ErrorKind::Failure, "setup_failed"))
}

/// The execution's runtime directory: its parent (`<runtime>/x`) and itself held by descriptor, with the identity
/// reported in the create reply.
struct RuntimeDir {
    handle: String,
    path: String,
    name: String,
    parent: OwnedFd,
    dir: OwnedFd,
    dev: u64,
    ino: u64,
}

/// Bound on directory nesting below the runtime directory. A deeper tree is NOT removed: the removal fails closed, the
/// directory stays, and the supervisor's walk records it quarantined (review F-1: an explicit, documented outcome).
pub const MAX_REMOVE_DEPTH: usize = 256;

/// Removes the runtime directory (step 6, or an aborted uncommitted one). Every leg fails closed: on any refusal or
/// error the directory stays and a diagnostic goes to stderr; the supervisor's own walk then proves it present and
/// quarantines it. Legs: (1) no mount at or below the path in `/proc/self/mountinfo`; (2) the contents are removed
/// relative to the held descriptor, byte-safe, never following a link, never crossing a device boundary; (3) the final
/// `unlinkat` happens only if the entry at `<runtime>/x/<id>` still has the reported `(dev, ino)` (review RK-3).
fn remove_runtime_dir(runtime: RuntimeDir, root: Result<RawFd, &'static str>) {
    let report = |reason: &str| eprintln!("keeper: runtime directory {} kept ({reason}); the supervisor walk decides", runtime.path);
    // Review F-4: the runtime root must still be the recorded directory at its configured path.
    if let Err(reason) = root {
        return report(reason);
    }
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    if mountinfo.is_empty() {
        return report("mountinfo unreadable");
    }
    // The mount check names the directory the descriptor holds (its /proc/self/fd link), not the reported path string.
    let link = std::fs::read_link(format!("/proc/self/fd/{}", runtime.dir.as_raw_fd())).ok();
    let Some(held) = link.as_ref().and_then(|link| link.to_str()).and_then(held_path) else {
        return report("the held directory has no current path");
    };
    if !mounts_at_or_below(&parse_mountinfo(&mountinfo), held).is_empty() {
        return report("a mount is still at or below it");
    }
    if let Err(error) = remove_children(runtime.dir.as_raw_fd(), runtime.dev, 0) {
        return report(&format!("contents: {error}"));
    }
    let Ok(name) = cstr(&runtime.name) else { return report("bad name") };
    // SAFETY: zeroed out-parameter; valid descriptor and C string.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(runtime.parent.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } < 0
        || (stat.st_dev as u64, stat.st_ino as u64) != (runtime.dev, runtime.ino)
    {
        return report("the entry is no longer the reported directory");
    }
    // SAFETY: valid descriptor and C string.
    if unsafe { libc::unlinkat(runtime.parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
        report(&format!("rmdir: {}", io::Error::last_os_error()));
    }
}

/// Removes every entry of the directory `dir` (any directory descriptor, including O_PATH). Names stay raw bytes from
/// `d_name` to `unlinkat` (review F-1: a name that is not valid UTF-8 is removed like any other). ENOENT is accepted only
/// for an entry that disappeared between listing and removal. A directory without owner rwx is first given it (the
/// keeper's UID owns everything a workload created; a foreign owner fails the removal). Depth is bounded by
/// [`MAX_REMOVE_DEPTH`] (fail closed).
fn remove_children(dir: RawFd, root_dev: u64, depth: usize) -> io::Result<()> {
    if depth > MAX_REMOVE_DEPTH {
        return Err(io::Error::other("tree deeper than MAX_REMOVE_DEPTH"));
    }
    let dot = cstr(".")?;
    // SAFETY: valid descriptor and C string; a readable descriptor of the same directory.
    let reading = unsafe { libc::openat(dir, dot.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if reading < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fresh descriptor; fdopendir takes ownership.
    let stream = unsafe { libc::fdopendir(reading) };
    if stream.is_null() {
        unsafe { libc::close(reading) };
        return Err(io::Error::last_os_error());
    }
    let mut names: Vec<CString> = Vec::new();
    loop {
        // SAFETY: a valid DIR stream.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        // SAFETY: d_name is NUL-terminated; the bytes are kept as they are.
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            names.push(name.to_owned());
        }
    }
    let parent = unsafe { libc::dirfd(stream) };
    let mut result = Ok(());
    for name in &names {
        if let Err(error) = remove_entry(parent, name, root_dev, depth) {
            result = Err(error);
            break;
        }
    }
    // SAFETY: closes the stream and its descriptor.
    unsafe { libc::closedir(stream) };
    result
}

fn remove_entry(parent: RawFd, name: &CString, root_dev: u64, depth: usize) -> io::Result<()> {
    // SAFETY: valid descriptor and C string; O_PATH|O_NOFOLLOW opens the entry itself, a link included.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOENT) { Ok(()) } else { Err(error) };
    }
    // SAFETY: fresh descriptor we own.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let stat = fstat(fd.as_raw_fd())?;
    let directory = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
    if directory {
        if stat.st_dev as u64 != root_dev {
            return Err(io::Error::other("mount boundary"));
        }
        if stat.st_mode & 0o700 != 0o700 {
            // chmod through the descriptor's /proc magic link changes exactly the opened directory.
            let path = cstr(&format!("/proc/self/fd/{}", fd.as_raw_fd()))?;
            // SAFETY: valid C string.
            if unsafe { libc::chmod(path.as_ptr(), (stat.st_mode & 0o7777) | 0o700) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        remove_children(fd.as_raw_fd(), root_dev, depth + 1)?;
    }
    drop(fd);
    // SAFETY: valid descriptor and C string.
    if unsafe { libc::unlinkat(parent, name.as_ptr(), if directory { libc::AT_REMOVEDIR } else { 0 }) } < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOENT) {
            return Err(error);
        }
    }
    Ok(())
}

impl LinuxOs {
    /// A new network namespace held by descriptor: a helper child unshares CLONE_NEWNET and waits; the keeper opens
    /// `/proc/<child>/ns/net`, then releases and reaps the helper. The namespace then has the keeper as its only holder.
    /// Loopback is left down here; bringing `lo` up is a G1 item.
    fn create_netns(&mut self) -> Result<(OwnedFd, u64), OsError> {
        let failure = (ErrorKind::Failure, "setup_failed");
        let mut ready = [0 as RawFd; 2];
        let mut release = [0 as RawFd; 2];
        // SAFETY: valid out arrays.
        if unsafe { libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC) } < 0 || unsafe { libc::pipe2(release.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
            return Err(failure);
        }
        // SAFETY: the keeper is single-threaded.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(failure);
        }
        if pid == 0 {
            // SAFETY: child: syscalls only.
            unsafe {
                let ok: u8 = if rw_confine::linux::kill_on_parent_death(self.keeper_pid).is_ok() && libc::unshare(libc::CLONE_NEWNET) == 0 { 1 } else { 0 };
                libc::write(ready[1], &ok as *const u8 as *const libc::c_void, 1);
                let mut byte = 0u8;
                libc::read(release[0], &mut byte as *mut u8 as *mut libc::c_void, 1);
                libc::_exit(0);
            }
        }
        // SAFETY: parent: closing the child's ends, reading its status.
        unsafe {
            libc::close(ready[1]);
            libc::close(release[0]);
        }
        let mut ok = 0u8;
        let read = unsafe { libc::read(ready[0], &mut ok as *mut u8 as *mut libc::c_void, 1) };
        let opened = if read == 1 && ok == 1 {
            let path = cstr(&format!("/proc/{pid}/ns/net")).map_err(|_| failure)?;
            // SAFETY: valid C string.
            let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
            if fd >= 0 { Some(unsafe { OwnedFd::from_raw_fd(fd) }) } else { None }
        } else {
            None
        };
        // SAFETY: release and reap the helper.
        unsafe {
            libc::close(release[1]);
            libc::close(ready[0]);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        let fd = opened.ok_or(failure)?;
        let inode = fstat(fd.as_raw_fd()).map_err(|_| failure)?.st_ino as u64;
        Ok((fd, inode))
    }
}

impl KeeperOs for LinuxOs {
    // No Linux asynchronous operation is scheduled in this foundation. The synchronous refusal adapter produces
    // neither completions nor operation-owned late objects. Actual launch integration must implement these contracts.
    fn cancel_launch(&mut self, _operation: &crate::launch::OperationId, _committed: bool) {}
    fn discard_created(&mut self, _operation: crate::launch::OperationId, _created: Created) {}
    fn create(&mut self, handle: &str, kind: CreateKind, _marker: Option<&str>, locator: &Value, _spec: &Spec) -> Result<Created, OsError> {
        let failure = (ErrorKind::Failure, "setup_failed");
        match kind {
            CreateKind::RuntimeDir => {
                let path = locator.get("path").and_then(Value::as_str).ok_or(failure)?.to_string();
                let id = path.rsplit('/').next().ok_or(failure)?.to_string();
                if self.runtime_dir.is_some() {
                    // The core refuses this first (duplicate_role); never orphan a held directory.
                    return Err((ErrorKind::Refused, "duplicate_role"));
                }
                let base = self.checked_root().map_err(|_| failure)?;
                let x = open_or_create_component(base, "x", 0o700).map_err(|_| failure)?;
                let dir = create_private_dir(x.as_raw_fd(), &id)?;
                let stat = fstat(dir.as_raw_fd()).map_err(|_| failure)?;
                let (dev, ino) = (stat.st_dev as u64, stat.st_ino as u64);
                let identity = WireIdentity::RuntimeDir { path: path.clone(), dev, ino };
                self.runtime_dir = Some(RuntimeDir { handle: handle.to_string(), path, name: id, parent: x, dir, dev, ino });
                Ok(Created { identity, pid: None })
            }
            CreateKind::Netns => {
                let (fd, inode) = self.create_netns()?;
                self.netns.insert(handle.to_string(), fd);
                Ok(Created { identity: WireIdentity::Netns { net_ns: inode }, pid: None })
            }
            CreateKind::Cgroup => {
                let refusal = (ErrorKind::Refused, "cgroup_not_delegated");
                self.cgroup_subtree.as_ref().ok_or(refusal)?.checked().map_err(|_| refusal)?;
                // Even a valid delegated subtree cannot create until the separately approved creation delta.
                Err(refusal)
            }
            // NOT IMPLEMENTED in r3 (no Linux execution was available to prove the construction): the endpoint and
            // process-tree domains (outer namespaces + the single bwrap stage + gated stage, linux::domain) and PTY
            // allocation in a private devpts instance. They fail closed with `setup_failed`.
            CreateKind::Endpoint | CreateKind::ProcessTree | CreateKind::Pty => Err(failure),
        }
    }

    fn commit(&mut self, _handle: &str, kind: CreateKind) -> Result<&'static str, OsError> {
        if kind.process_bearing() { Err((ErrorKind::Failure, "exec_failed")) } else { Ok("committed") }
    }

    fn abort(&mut self, handles: &[String]) {
        for handle in handles {
            // Dropping the descriptor releases an uncommitted namespace.
            self.netns.remove(handle);
            // Review F-2(a): an uncommitted runtime directory is removed, with the same safety legs as step 6.
            if self.runtime_dir.as_ref().is_some_and(|dir| &dir.handle == handle) {
                if let Some(dir) = self.runtime_dir.take() {
                    let root = self.checked_root();
                    remove_runtime_dir(dir, root);
                }
            }
        }
    }

    fn stop(&mut self, _handle: &str, _grace_ms: i64) {}

    /// PROVISIONAL (G1): process-bearing `create` fails closed with `setup_failed`, so no stage and no stage pidfd exist
    /// and there is nothing to kill. When process-bearing kinds land, this must `pidfd_send_signal(SIGKILL)` on the
    /// pidfd recorded for `handle` at create, never `kill(pid)`.
    fn kill_stage(&mut self, _handle: &str) {}

    fn tempdir(&mut self) -> Result<String, OsError> {
        let failure = (ErrorKind::Failure, "setup_failed");
        let Some(runtime) = &self.runtime_dir else { return Err((ErrorKind::Refused, "runtime_dir_missing")) };
        let dir = runtime.dir.as_raw_fd();
        let tmp = open_or_create_component(dir, "tmp", 0o700).map_err(|_| failure)?;
        let name = format!("ala-{}", &self.random_hex()[..16]);
        create_private_dir(tmp.as_raw_fd(), &name)?;
        Ok(format!("/tmp/{name}"))
    }

    fn end_step(&mut self, step: EndStep) {
        match step {
            EndStep::Egress => self.netns.clear(),
            EndStep::Runtime => {
                if let Some(dir) = self.runtime_dir.take() {
                    let root = self.checked_root();
                    remove_runtime_dir(dir, root);
                }
            }
            EndStep::ProcessTrees | EndStep::Endpoint | EndStep::Views => {}
        }
    }

    fn pty_write(&mut self, _handle: &str, _data: &[u8]) -> Result<usize, &'static str> {
        Err("pty_closed")
    }

    fn pty_resize(&mut self, _handle: &str, _cols: i64, _rows: i64) -> Result<(), &'static str> {
        Err("pty_closed")
    }

    fn descriptor_count(&mut self) -> i64 {
        std::fs::read_dir("/proc/self/fd").map(|entries| entries.count() as i64 - 1).unwrap_or(-1).max(0)
    }

    fn mount_view(&mut self, request: &MountRequest, resource: &str) -> Result<MountedIdentity, (RefusalKind, &'static str)> {
        self.mount_view_impl(request, resource)
    }

    fn detach(&mut self, identity: &MountedIdentity) -> Result<(), &'static str> {
        self.detach_impl(identity)
    }

    fn signal(&mut self, pid: i64, signal: Signal) {
        self.signal_impl(pid, signal)
    }

    fn new_mount_handle(&mut self) -> String {
        format!("m{}", self.random_hex())
    }
}

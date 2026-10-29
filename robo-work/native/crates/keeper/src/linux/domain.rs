//! The outer, non-Bubblewrap construction stage (first-G1 plan "Namespace and parent-death construction"; amendment
//! A1.1). The keeper creates the namespace anchor as its own DIRECT child with `clone3(CLONE_PIDFD | CLONE_NEWPID |
//! CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWNS [| CLONE_NEWNET])`, so the pidfd exists before the child can run, exit or
//! be reaped. There is no exiting intermediate and no adoption of an orphaned init.
//!
//! In the child, before anything else: `PR_SET_PDEATHSIG(SIGKILL)` (the parent is the keeper thread itself), then the
//! keeper's liveness is checked through an inherited keeper pidfd (a namespace init cannot compare `getppid()`: its
//! parent is outside its PID namespace and reads as 0). It then joins the committed execution network namespace by
//! descriptor, or brings `lo` up in its new one, makes propagation private, mounts a fresh `/proc` for its PID
//! namespace, places exactly the planned descriptors (everything else, the keeper pidfd and the namespace descriptor
//! included, is closed), and execs the image's unchanged `/usr/bin/bwrap` by absolute path with an empty environment.
//! Bubblewrap stays this process (the anchor and monitor); `--die-with-parent` binds the sandbox child to it, and the
//! anchor's death as PID-namespace init kills every member.
//!
//! Exit statuses 120-127 of the anchor identify the failing outer step (diagnostics only; any anchor death before
//! READY is `setup_failed`).

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use crate::bwrap::BWRAP;
use crate::linux::sys::{CloneArgs, last_error, loopback_up};

pub const EXIT_KEEPER_GONE: i32 = 120;
pub const EXIT_NETNS: i32 = 121;
pub const EXIT_PROPAGATION: i32 = 122;
pub const EXIT_PROC: i32 = 123;
pub const EXIT_DESCRIPTORS: i32 = 124;
pub const EXIT_EXEC: i32 = 126;

/// Network namespace of the domain.
pub enum Network<'a> {
    /// Join the committed execution network namespace held by the keeper.
    Join(&'a OwnedFd),
    /// A new loopback-only namespace (orchestration).
    NewLoopback,
}

/// Everything the child needs, prepared before clone so the child allocates nothing.
pub struct AnchorPlan<'a> {
    pub argv: Vec<CString>,
    /// `(source, target)`: the anchor's final descriptor table besides 0-2. Targets are distinct and above 4.
    pub descriptors: Vec<(RawFd, RawFd)>,
    /// Standard input, output and error of the anchor and, by inheritance, of the stage until it installs its own.
    pub stdio: [RawFd; 3],
    pub network: Network<'a>,
    pub keeper_pidfd: &'a OwnedFd,
}

pub struct Anchor {
    pub pid: libc::pid_t,
    pub pidfd: OwnedFd,
}

/// Upper bound of target descriptor numbers (scratch copies go just above the highest target, so the layout fits
/// any RLIMIT_NOFILE the keeper itself runs under).
const MAX_TARGET: RawFd = 400;

pub fn spawn_anchor(plan: &AnchorPlan<'_>) -> io::Result<Anchor> {
    if plan.argv.first().map(|program| program.as_bytes()) != Some(BWRAP.as_bytes()) {
        return Err(io::Error::other("the anchor execs only the image Bubblewrap"));
    }
    let mut targets: Vec<RawFd> = plan.descriptors.iter().map(|(_, target)| *target).collect();
    targets.sort_unstable();
    if targets.windows(2).any(|pair| pair[0] == pair[1]) || targets.iter().any(|target| *target <= 4 || *target >= MAX_TARGET)
        || plan.descriptors.len() > 256
    {
        return Err(io::Error::other("descriptor layout"));
    }
    let scratch = targets.last().copied().unwrap_or(4) + 1;
    let program = CString::new(BWRAP)?;
    let (slash, proc_source, proc_target) = (CString::new("/")?, CString::new("proc")?, CString::new("/proc")?);
    let mut pointers: Vec<*const libc::c_char> = plan.argv.iter().map(|arg| arg.as_ptr()).collect();
    pointers.push(std::ptr::null());
    let envp: [*const libc::c_char; 1] = [std::ptr::null()];
    let mut pidfd: RawFd = -1;
    let mut flags = libc::CLONE_PIDFD | libc::CLONE_NEWPID | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS | libc::CLONE_NEWNS;
    let join = match plan.network {
        Network::Join(fd) => Some(fd.as_raw_fd()),
        Network::NewLoopback => {
            flags |= libc::CLONE_NEWNET;
            None
        }
    };
    let args = CloneArgs { flags: flags as u64, pidfd: &mut pidfd as *mut RawFd as u64, exit_signal: libc::SIGCHLD as u64, ..CloneArgs::default() };
    let keeper_pidfd = plan.keeper_pidfd.as_raw_fd();
    // SAFETY: clone3 without CLONE_VM behaves like fork; the keeper is single-threaded and the child below only issues
    // syscalls on data prepared above, then execs or _exits.
    let mut pid = unsafe { libc::syscall(libc::SYS_clone3, &args as *const CloneArgs, std::mem::size_of::<CloneArgs>()) };
    if pid < 0 && crate::linux::sys::errno() == libc::ENOSYS {
        // A container seccomp profile may answer clone3 with ENOSYS. Legacy clone also returns the pidfd atomically
        // (CLONE_PIDFD stores it through the parent_tid argument); fork-like with a null stack.
        // SAFETY: as for clone3 above (x86_64 argument order: flags, newsp, parent_tid, child_tid, tls).
        pid = unsafe { libc::syscall(libc::SYS_clone, (flags | libc::SIGCHLD) as libc::c_ulong, 0usize, &mut pidfd as *mut RawFd, 0usize, 0usize) };
    }
    if pid < 0 {
        return Err(last_error());
    }
    if pid == 0 {
        // SAFETY: child side; see above.
        unsafe { anchor_child(plan, join, keeper_pidfd, scratch, &program, &pointers, &envp, &slash, &proc_source, &proc_target) }
    }
    if pidfd < 0 {
        return Err(io::Error::other("clone3 returned no pidfd"));
    }
    // SAFETY: the kernel returned this pidfd (CLOEXEC by definition of CLONE_PIDFD) for exactly this child.
    Ok(Anchor { pid: pid as libc::pid_t, pidfd: unsafe { OwnedFd::from_raw_fd(pidfd) } })
}

#[allow(clippy::too_many_arguments)]
unsafe fn anchor_child(plan: &AnchorPlan<'_>, join: Option<RawFd>, keeper_pidfd: RawFd, scratch: RawFd, program: &CString,
    pointers: &[*const libc::c_char], envp: &[*const libc::c_char; 1], slash: &CString, proc_source: &CString, proc_target: &CString) -> ! {
    unsafe {
        // 1. Parent death, then the keeper's liveness through its pidfd (readable once the keeper exited).
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) < 0 {
            libc::_exit(EXIT_KEEPER_GONE);
        }
        let mut entry = libc::pollfd { fd: keeper_pidfd, events: libc::POLLIN, revents: 0 };
        if libc::poll(&mut entry, 1, 0) != 0 {
            libc::_exit(EXIT_KEEPER_GONE);
        }
        // 2. Network.
        match join {
            Some(fd) => {
                if libc::setns(fd, libc::CLONE_NEWNET) < 0 {
                    libc::_exit(EXIT_NETNS);
                }
            }
            None => {
                if !loopback_up() {
                    libc::_exit(EXIT_NETNS);
                }
            }
        }
        // 3. Private propagation and a fresh /proc of this PID namespace.
        if libc::mount(std::ptr::null(), slash.as_ptr(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()) < 0 {
            libc::_exit(EXIT_PROPAGATION);
        }
        if libc::mount(proc_source.as_ptr(), proc_target.as_ptr(), proc_source.as_ptr(), libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, std::ptr::null()) < 0 {
            libc::_exit(EXIT_PROC);
        }
        // 4. Descriptors: move every source above every target, then place each one; close everything else.
        let count = plan.descriptors.len();
        let mut moved = [0 as RawFd; 256];
        for (index, (source, _)) in plan.descriptors.iter().enumerate() {
            let fd = libc::fcntl(*source, libc::F_DUPFD_CLOEXEC, scratch);
            if fd < 0 {
                libc::_exit(EXIT_DESCRIPTORS);
            }
            moved[index] = fd;
        }
        let mut stdio = [0 as RawFd; 3];
        for (slot, source) in plan.stdio.iter().enumerate() {
            let fd = libc::fcntl(*source, libc::F_DUPFD_CLOEXEC, scratch);
            if fd < 0 {
                libc::_exit(EXIT_DESCRIPTORS);
            }
            stdio[slot] = fd;
        }
        for (slot, fd) in stdio.iter().enumerate() {
            if libc::dup2(*fd, slot as RawFd) < 0 {
                libc::_exit(EXIT_DESCRIPTORS);
            }
        }
        for (index, (_, target)) in plan.descriptors.iter().enumerate().take(count) {
            if libc::dup2(moved[index], *target) < 0 {
                libc::_exit(EXIT_DESCRIPTORS);
            }
        }
        // Gaps between targets and everything above the highest one (scratch copies, the keeper pidfd, the namespace
        // descriptor and any inherited keeper descriptor) close here.
        let mut next = 3;
        let mut sorted = [0 as RawFd; 256];
        for (index, (_, target)) in plan.descriptors.iter().enumerate() {
            sorted[index] = *target;
        }
        sorted[..count].sort_unstable();
        for target in &sorted[..count] {
            if *target > next && libc::syscall(libc::SYS_close_range, next as u32, (*target - 1) as u32, 0u32) < 0 {
                libc::_exit(EXIT_DESCRIPTORS);
            }
            next = *target + 1;
        }
        if libc::syscall(libc::SYS_close_range, next as u32, u32::MAX, 0u32) < 0 {
            libc::_exit(EXIT_DESCRIPTORS);
        }
        // 5. Exactly one unchanged Bubblewrap, by absolute path, empty environment.
        libc::execve(program.as_ptr(), pointers.as_ptr(), envp.as_ptr());
        libc::_exit(EXIT_EXEC)
    }
}

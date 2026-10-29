//! x86_64 system-call numbers used by the seccomp profiles, written out so that the host (macOS) can build and test the
//! programs. On the musl target every value is checked against the vendored `libc` crate at compile time (below), so a
//! wrong number fails the Linux build.

macro_rules! syscalls {
    ($($name:ident = $value:expr => $libc:ident),* $(,)?) => {
        $(pub const $name: u32 = $value;)*
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        const _: () = { $(assert!(libc::$libc as u32 == $value, stringify!($name));)* };
    };
}

syscalls! {
    READ = 0 => SYS_read, WRITE = 1 => SYS_write, OPEN = 2 => SYS_open, CLOSE = 3 => SYS_close, STAT = 4 => SYS_stat,
    FSTAT = 5 => SYS_fstat, POLL = 7 => SYS_poll, LSEEK = 8 => SYS_lseek, MMAP = 9 => SYS_mmap, MPROTECT = 10 => SYS_mprotect,
    MUNMAP = 11 => SYS_munmap, BRK = 12 => SYS_brk, RT_SIGACTION = 13 => SYS_rt_sigaction, RT_SIGPROCMASK = 14 => SYS_rt_sigprocmask,
    RT_SIGRETURN = 15 => SYS_rt_sigreturn, RT_SIGTIMEDWAIT = 128 => SYS_rt_sigtimedwait, IOCTL = 16 => SYS_ioctl, PREAD64 = 17 => SYS_pread64, PWRITE64 = 18 => SYS_pwrite64,
    READV = 19 => SYS_readv, WRITEV = 20 => SYS_writev, SCHED_YIELD = 24 => SYS_sched_yield, MREMAP = 25 => SYS_mremap,
    MADVISE = 28 => SYS_madvise, NANOSLEEP = 35 => SYS_nanosleep, GETPID = 39 => SYS_getpid, SOCKET = 41 => SYS_socket,
    CONNECT = 42 => SYS_connect, CLONE = 56 => SYS_clone, FORK = 57 => SYS_fork, VFORK = 58 => SYS_vfork, EXECVE = 59 => SYS_execve,
    EXIT = 60 => SYS_exit, KILL = 62 => SYS_kill, FCNTL = 72 => SYS_fcntl, FSYNC = 74 => SYS_fsync, FDATASYNC = 75 => SYS_fdatasync,
    FTRUNCATE = 77 => SYS_ftruncate, CHDIR = 80 => SYS_chdir, FCHDIR = 81 => SYS_fchdir, FCHMOD = 91 => SYS_fchmod,
    FCHOWN = 93 => SYS_fchown, PTRACE = 101 => SYS_ptrace, GETUID = 102 => SYS_getuid, GETGID = 104 => SYS_getgid,
    GETEUID = 107 => SYS_geteuid, GETEGID = 108 => SYS_getegid, SIGALTSTACK = 131 => SYS_sigaltstack,
    PERSONALITY = 135 => SYS_personality, FSTATFS = 138 => SYS_fstatfs, PIVOT_ROOT = 155 => SYS_pivot_root, PRCTL = 157 => SYS_prctl,
    CHROOT = 161 => SYS_chroot, MOUNT = 165 => SYS_mount, UMOUNT2 = 166 => SYS_umount2, GETTID = 186 => SYS_gettid,
    FUTEX = 202 => SYS_futex, GETDENTS64 = 217 => SYS_getdents64, RESTART_SYSCALL = 219 => SYS_restart_syscall, SCHED_GETAFFINITY = 204 => SYS_sched_getaffinity, SET_TID_ADDRESS = 218 => SYS_set_tid_address,
    CLOCK_GETTIME = 228 => SYS_clock_gettime, CLOCK_NANOSLEEP = 230 => SYS_clock_nanosleep, EXIT_GROUP = 231 => SYS_exit_group,
    TGKILL = 234 => SYS_tgkill, TKILL = 200 => SYS_tkill, RT_SIGQUEUEINFO = 129 => SYS_rt_sigqueueinfo, RT_TGSIGQUEUEINFO = 297 => SYS_rt_tgsigqueueinfo, PIDFD_SEND_SIGNAL = 424 => SYS_pidfd_send_signal, ADD_KEY = 248 => SYS_add_key, REQUEST_KEY = 249 => SYS_request_key, KEYCTL = 250 => SYS_keyctl,
    OPENAT = 257 => SYS_openat, MKDIRAT = 258 => SYS_mkdirat, MKNODAT = 259 => SYS_mknodat, FCHOWNAT = 260 => SYS_fchownat,
    NEWFSTATAT = 262 => SYS_newfstatat, UNLINKAT = 263 => SYS_unlinkat, RENAMEAT = 264 => SYS_renameat, LINKAT = 265 => SYS_linkat,
    SYMLINKAT = 266 => SYS_symlinkat, READLINKAT = 267 => SYS_readlinkat, FCHMODAT = 268 => SYS_fchmodat, PPOLL = 271 => SYS_ppoll,
    UNSHARE = 272 => SYS_unshare, SET_ROBUST_LIST = 273 => SYS_set_robust_list, UTIMENSAT = 280 => SYS_utimensat,
    FALLOCATE = 285 => SYS_fallocate, PREADV = 295 => SYS_preadv, PWRITEV = 296 => SYS_pwritev, PRLIMIT64 = 302 => SYS_prlimit64,
    SETNS = 308 => SYS_setns, PROCESS_VM_READV = 310 => SYS_process_vm_readv, PROCESS_VM_WRITEV = 311 => SYS_process_vm_writev,
    RENAMEAT2 = 316 => SYS_renameat2, SECCOMP = 317 => SYS_seccomp, GETRANDOM = 318 => SYS_getrandom, BPF = 321 => SYS_bpf,
    EXECVEAT = 322 => SYS_execveat, USERFAULTFD = 323 => SYS_userfaultfd, PREADV2 = 327 => SYS_preadv2, PWRITEV2 = 328 => SYS_pwritev2,
    STATX = 332 => SYS_statx, RSEQ = 334 => SYS_rseq, IO_URING_SETUP = 425 => SYS_io_uring_setup, CLONE3 = 435 => SYS_clone3,
    OPENAT2 = 437 => SYS_openat2, PIDFD_GETFD = 438 => SYS_pidfd_getfd, FCHMODAT2 = 452 => SYS_fchmodat2,
}

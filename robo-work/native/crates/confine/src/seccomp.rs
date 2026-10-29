//! Classic-BPF seccomp programs for x86_64 (plan sections 5.0 and 5.4), built as pure data and checked on the host by
//! the interpreter in [`interpret`]. Installation is Linux-only (`crate::linux::install_filter`).
//!
//! Every program starts with the same prologue: a wrong architecture or an x32 system-call number kills the process.
//!
//! | Profile | Rules after the prologue |
//! |---|---|
//! | [`file_server_profile`] | allowlist: the `*at` family, file and FUSE-device I/O, memory, futex, signal handling for itself (no signal to any other process), time, exit; `prlimit64` only pid 0 with a NULL new limit; `fcntl` only F_GETFD/F_SETFD/F_GETFL/F_DUPFD_CLOEXEC and F_SETFL without O_ASYNC. `execve`/`execveat` kill the process (so the linked fusermount path can never run). `clone` only with `CLONE_THREAD` and no namespace flag (fuser's event loop is a thread). `clone3` is ENOSYS (its flags are behind a pointer). Everything else, including socket, unshare, setns, mount, ptrace, keyctl and ioctl, is EPERM. |
//! | [`domain_profile`] | denylist for confined orchestration and workload domains (arbitrary programs run there): keyring calls; `unshare`/`clone` with `CLONE_NEWUSER`; `clone3` ENOSYS; and for the orchestration domain also `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_getfd`. Everything else is allowed (capabilities, namespaces and views do the rest). |

use crate::syscalls as nr;

pub const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
pub const X32_SYSCALL_BIT: u32 = 0x4000_0000;

pub const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
pub const SECCOMP_RET_ALLOW: u32 = 0x7FFF_0000;

pub const EPERM: u32 = 1;
pub const ENOSYS: u32 = 38;

// Clone flags (linux/sched.h).
pub const CLONE_THREAD: u32 = 0x0001_0000;
pub const CLONE_NEWNS: u32 = 0x0002_0000;
pub const CLONE_NEWCGROUP: u32 = 0x0200_0000;
pub const CLONE_NEWUTS: u32 = 0x0400_0000;
pub const CLONE_NEWIPC: u32 = 0x0800_0000;
pub const CLONE_NEWUSER: u32 = 0x1000_0000;
pub const CLONE_NEWPID: u32 = 0x2000_0000;
pub const CLONE_NEWNET: u32 = 0x4000_0000;
pub const CLONE_NS_MASK: u32 = CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET;

// struct seccomp_data offsets.
pub const OFFSET_NR: u32 = 0;
pub const OFFSET_ARCH: u32 = 4;
pub const fn offset_arg_low(index: u32) -> u32 {
    16 + 8 * index
}
pub const fn offset_arg_high(index: u32) -> u32 {
    16 + 8 * index + 4
}

// BPF opcodes.
pub const BPF_LD_W_ABS: u16 = 0x00 | 0x00 | 0x20;
pub const BPF_JMP_JA: u16 = 0x05;
pub const BPF_JMP_JEQ_K: u16 = 0x05 | 0x10;
pub const BPF_JMP_JGE_K: u16 = 0x05 | 0x30;
pub const BPF_JMP_JSET_K: u16 = 0x05 | 0x40;
pub const BPF_ALU_AND_K: u16 = 0x04 | 0x50;
pub const BPF_RET_K: u16 = 0x06;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct SockFilter {
    pub code: u16,
    pub jt: u8,
    pub jf: u8,
    pub k: u32,
}

const fn stmt(code: u16, k: u32) -> SockFilter {
    SockFilter { code, jt: 0, jf: 0, k }
}
const fn jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter {
    SockFilter { code, jt, jf, k }
}

fn prologue(program: &mut Vec<SockFilter>) {
    program.push(stmt(BPF_LD_W_ABS, OFFSET_ARCH));
    program.push(jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
    program.push(stmt(BPF_LD_W_ABS, OFFSET_NR));
    program.push(jump(BPF_JMP_JGE_K, X32_SYSCALL_BIT, 0, 1));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
}

/// `if nr == number { return action }` (the accumulator holds nr on entry and on exit).
fn on_nr(program: &mut Vec<SockFilter>, number: u32, action: u32) {
    program.push(jump(BPF_JMP_JEQ_K, number, 0, 1));
    program.push(stmt(BPF_RET_K, action));
}

/// For `clone`: allow only a thread without namespace flags; otherwise EPERM. Clobbers and reloads the accumulator.
fn clone_thread_only(program: &mut Vec<SockFilter>) {
    // if nr != clone: skip the 9 instructions of the block (the accumulator still holds nr).
    program.push(jump(BPF_JMP_JEQ_K, nr::CLONE, 0, 9));
    program.push(stmt(BPF_LD_W_ABS, offset_arg_high(0)));
    program.push(jump(BPF_JMP_JEQ_K, 0, 1, 0));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    program.push(stmt(BPF_LD_W_ABS, offset_arg_low(0)));
    program.push(jump(BPF_JMP_JSET_K, CLONE_NS_MASK, 2, 0));
    program.push(jump(BPF_JMP_JSET_K, CLONE_THREAD, 2, 1));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    // A thread clone reaches this only through jt of the JSET CLONE_THREAD.
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
}

/// For `unshare` and `clone`: refuse CLONE_NEWUSER (EPERM), allow otherwise. A non-matching nr skips the block with
/// the accumulator unchanged.
fn refuse_newuser(program: &mut Vec<SockFilter>, number: u32) {
    program.push(jump(BPF_JMP_JEQ_K, number, 0, 4));
    program.push(stmt(BPF_LD_W_ABS, offset_arg_low(0)));
    program.push(jump(BPF_JMP_JSET_K, CLONE_NEWUSER, 0, 1));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
}

pub const FILE_SERVER_ALLOW: &[u32] = &[
    nr::READ, nr::WRITE, nr::READV, nr::WRITEV, nr::PREAD64, nr::PWRITE64, nr::PREADV, nr::PWRITEV, nr::PREADV2, nr::PWRITEV2,
    nr::CLOSE, nr::FSTAT, nr::NEWFSTATAT, nr::STATX, nr::LSEEK, nr::GETDENTS64, nr::OPENAT, nr::OPENAT2,
    nr::MKDIRAT, nr::MKNODAT, nr::UNLINKAT, nr::RENAMEAT, nr::RENAMEAT2, nr::LINKAT, nr::SYMLINKAT, nr::READLINKAT,
    nr::FCHMOD, nr::FCHMODAT, nr::FCHMODAT2, nr::RESTART_SYSCALL, nr::FCHOWN, nr::FCHOWNAT, nr::UTIMENSAT, nr::FTRUNCATE, nr::FALLOCATE, nr::FSYNC, nr::FDATASYNC,
    nr::FSTATFS, nr::MMAP, nr::MUNMAP, nr::MPROTECT, nr::MREMAP, nr::BRK, nr::MADVISE, nr::FUTEX, nr::SET_ROBUST_LIST,
    nr::RSEQ, nr::SET_TID_ADDRESS, nr::SIGALTSTACK, nr::RT_SIGRETURN, nr::RT_SIGTIMEDWAIT, nr::RT_SIGACTION, nr::RT_SIGPROCMASK, nr::EXIT, nr::EXIT_GROUP,
    nr::CLOCK_GETTIME, nr::CLOCK_NANOSLEEP, nr::NANOSLEEP, nr::SCHED_YIELD, nr::SCHED_GETAFFINITY, nr::GETRANDOM, nr::GETPID,
    nr::GETTID, nr::POLL, nr::PPOLL, nr::GETUID, nr::GETEUID, nr::GETGID, nr::GETEGID,
];

// fcntl commands (x86_64 asm-generic) and O_ASYNC.
pub const F_GETFD: u32 = 1;
pub const F_SETFD: u32 = 2;
pub const F_GETFL: u32 = 3;
pub const F_SETFL: u32 = 4;
pub const F_SETOWN: u32 = 8;
pub const F_SETSIG: u32 = 10;
pub const F_SETOWN_EX: u32 = 15;
pub const F_DUPFD_CLOEXEC: u32 = 1030;
pub const O_ASYNC: u32 = 0o20000;

/// `if nr == number { body }`; the body returns on every path. A non-matching nr skips it with the accumulator
/// unchanged.
fn guarded(program: &mut Vec<SockFilter>, number: u32, body: &[SockFilter]) {
    assert!(body.len() <= 255);
    program.push(jump(BPF_JMP_JEQ_K, number, 0, body.len() as u8));
    program.extend_from_slice(body);
}

/// prlimit64 only as musl `getrlimit` issues it (review I-1): pid 0 (itself) and a NULL new limit, so a compromised
/// server cannot change another process's limits even under a shared kernel UID.
fn prlimit_self_read_only(program: &mut Vec<SockFilter>) {
    let deny = SECCOMP_RET_ERRNO | EPERM;
    guarded(program, nr::PRLIMIT64, &[
        stmt(BPF_LD_W_ABS, offset_arg_low(0)),
        jump(BPF_JMP_JEQ_K, 0, 0, 6),
        stmt(BPF_LD_W_ABS, offset_arg_high(0)),
        jump(BPF_JMP_JEQ_K, 0, 0, 4),
        stmt(BPF_LD_W_ABS, offset_arg_low(2)),
        jump(BPF_JMP_JEQ_K, 0, 0, 2),
        stmt(BPF_LD_W_ABS, offset_arg_high(2)),
        jump(BPF_JMP_JEQ_K, 0, 1, 0),
        stmt(BPF_RET_K, deny),
        stmt(BPF_RET_K, SECCOMP_RET_ALLOW),
    ]);
}

/// fcntl only with the commands the binary and musl issue after the filter is installed (review I-1 (b)): F_GETFD,
/// F_SETFD, F_GETFL, F_DUPFD_CLOEXEC, and F_SETFL without O_ASYNC. F_SETOWN, F_SETSIG and every other command (a second
/// same-UID signalling path) are EPERM.
fn fcntl_narrow(program: &mut Vec<SockFilter>) {
    let deny = SECCOMP_RET_ERRNO | EPERM;
    guarded(program, nr::FCNTL, &[
        stmt(BPF_LD_W_ABS, offset_arg_high(1)),
        jump(BPF_JMP_JEQ_K, 0, 0, 8),
        stmt(BPF_LD_W_ABS, offset_arg_low(1)),
        jump(BPF_JMP_JEQ_K, F_GETFD, 7, 0),
        jump(BPF_JMP_JEQ_K, F_SETFD, 6, 0),
        jump(BPF_JMP_JEQ_K, F_GETFL, 5, 0),
        jump(BPF_JMP_JEQ_K, F_DUPFD_CLOEXEC, 4, 0),
        jump(BPF_JMP_JEQ_K, F_SETFL, 0, 2),
        stmt(BPF_LD_W_ABS, offset_arg_low(2)),
        jump(BPF_JMP_JSET_K, O_ASYNC, 0, 1),
        stmt(BPF_RET_K, deny),
        stmt(BPF_RET_K, SECCOMP_RET_ALLOW),
    ]);
}

/// The file server's filter. Signals: kill, tkill, tgkill, rt_(tg)sigqueueinfo and pidfd_send_signal are all EPERM
/// (default), so the server cannot signal any other process of its PID namespace (review I-1); musl `abort` uses tkill
/// and still ends the process through its fallback crash path.
pub fn file_server_profile() -> Vec<SockFilter> {
    let mut program = Vec::new();
    prologue(&mut program);
    on_nr(&mut program, nr::EXECVE, SECCOMP_RET_KILL_PROCESS);
    on_nr(&mut program, nr::EXECVEAT, SECCOMP_RET_KILL_PROCESS);
    on_nr(&mut program, nr::CLONE3, SECCOMP_RET_ERRNO | ENOSYS);
    clone_thread_only(&mut program);
    prlimit_self_read_only(&mut program);
    fcntl_narrow(&mut program);
    for number in FILE_SERVER_ALLOW {
        on_nr(&mut program, *number, SECCOMP_RET_ALLOW);
    }
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    program
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Orchestration,
    Workload,
}

pub const KEYRING_CALLS: &[u32] = &[nr::ADD_KEY, nr::REQUEST_KEY, nr::KEYCTL];
pub const ORCHESTRATION_EXTRA_DENY: &[u32] = &[nr::PTRACE, nr::PROCESS_VM_READV, nr::PROCESS_VM_WRITEV, nr::PIDFD_GETFD];

/// The confined domains' filter (plan section 5.0).
pub fn domain_profile(domain: Domain) -> Vec<SockFilter> {
    let mut program = Vec::new();
    prologue(&mut program);
    on_nr(&mut program, nr::CLONE3, SECCOMP_RET_ERRNO | ENOSYS);
    for number in KEYRING_CALLS {
        on_nr(&mut program, *number, SECCOMP_RET_ERRNO | EPERM);
    }
    if domain == Domain::Orchestration {
        for number in ORCHESTRATION_EXTRA_DENY {
            on_nr(&mut program, *number, SECCOMP_RET_ERRNO | EPERM);
        }
    }
    refuse_newuser(&mut program, nr::UNSHARE);
    refuse_newuser(&mut program, nr::CLONE);
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
    program
}

/// The seccomp_data the kernel presents: nr, arch, and six 64-bit arguments.
#[derive(Clone, Copy, Debug)]
pub struct SeccompData {
    pub nr: u32,
    pub arch: u32,
    pub args: [u64; 6],
}

impl SeccompData {
    pub fn x86_64(nr: u32, args: [u64; 6]) -> Self {
        SeccompData { nr, arch: AUDIT_ARCH_X86_64, args }
    }

    fn load(&self, offset: u32) -> Option<u32> {
        match offset {
            OFFSET_NR => Some(self.nr),
            OFFSET_ARCH => Some(self.arch),
            8 => Some(0),
            12 => Some(0),
            16..=63 if offset % 4 == 0 => {
                let index = ((offset - 16) / 8) as usize;
                let value = self.args[index];
                Some(if (offset - 16) % 8 == 0 { value as u32 } else { (value >> 32) as u32 })
            }
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    KillProcess,
    Errno(u32),
    Other(u32),
}

/// Runs a program the way the kernel's classic-BPF seccomp interpreter would, for the opcodes this module emits.
/// A malformed program (unknown opcode, jump out of range, bad load offset, falling off the end) is an error.
pub fn interpret(program: &[SockFilter], data: &SeccompData) -> Result<Verdict, String> {
    let mut accumulator: u32 = 0;
    let mut pc = 0usize;
    let mut steps = 0usize;
    while pc < program.len() {
        steps += 1;
        if steps > 4096 {
            return Err("too many steps".into());
        }
        let instruction = program[pc];
        let next = |offset: u8| pc + 1 + offset as usize;
        pc = match instruction.code {
            BPF_LD_W_ABS => {
                accumulator = data.load(instruction.k).ok_or_else(|| format!("bad load offset {} at {pc}", instruction.k))?;
                pc + 1
            }
            BPF_ALU_AND_K => {
                accumulator &= instruction.k;
                pc + 1
            }
            BPF_JMP_JA => pc + 1 + instruction.k as usize,
            BPF_JMP_JEQ_K => next(if accumulator == instruction.k { instruction.jt } else { instruction.jf }),
            BPF_JMP_JGE_K => next(if accumulator >= instruction.k { instruction.jt } else { instruction.jf }),
            BPF_JMP_JSET_K => next(if accumulator & instruction.k != 0 { instruction.jt } else { instruction.jf }),
            BPF_RET_K => {
                let value = instruction.k;
                return Ok(match value & 0xFFFF_0000 {
                    SECCOMP_RET_ALLOW => Verdict::Allow,
                    SECCOMP_RET_KILL_PROCESS => Verdict::KillProcess,
                    SECCOMP_RET_ERRNO => Verdict::Errno(value & 0xFFFF),
                    _ => Verdict::Other(value),
                });
            }
            other => return Err(format!("unsupported opcode {other:#x} at {pc}")),
        };
        if pc > program.len() {
            return Err("jump out of range".into());
        }
    }
    Err("fell off the end of the program".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(program: &[SockFilter], nr: u32, arg0: u64) -> Verdict {
        interpret(program, &SeccompData::x86_64(nr, [arg0, 0, 0, 0, 0, 0])).unwrap()
    }

    const THREAD_FLAGS: u64 = 0x003d_0f00; // what musl and glibc pass for pthread_create (CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM|SETTLS|PARENT_SETTID|CHILD_CLEARTID)

    #[test]
    fn file_server_allowlist_and_denials() {
        let program = file_server_profile();
        assert!(program.len() < 4096, "BPF_MAXINSNS");
        for number in FILE_SERVER_ALLOW {
            assert_eq!(run(&program, *number, 0), Verdict::Allow, "{number}");
        }
        assert_eq!(run(&program, nr::EXECVE, 0), Verdict::KillProcess);
        assert_eq!(run(&program, nr::EXECVEAT, 0), Verdict::KillProcess);
        assert_eq!(run(&program, nr::CLONE3, 0), Verdict::Errno(ENOSYS));
        for denied in [nr::SOCKET, nr::CONNECT, nr::UNSHARE, nr::SETNS, nr::MOUNT, nr::UMOUNT2, nr::PTRACE, nr::KEYCTL, nr::ADD_KEY,
            nr::IOCTL, nr::OPEN, nr::STAT, nr::CHDIR, nr::FCHDIR, nr::PIVOT_ROOT, nr::CHROOT, nr::KILL, nr::PRCTL, nr::SECCOMP, nr::BPF,
            nr::PROCESS_VM_READV, nr::PIDFD_GETFD, nr::FORK, nr::VFORK, nr::PERSONALITY, nr::USERFAULTFD, nr::IO_URING_SETUP] {
            assert_eq!(run(&program, denied, 0), Verdict::Errno(EPERM), "{denied}");
        }
    }

    fn run_args(program: &[SockFilter], nr: u32, args: [u64; 6]) -> Verdict {
        interpret(program, &SeccompData::x86_64(nr, args)).unwrap()
    }

    #[test]
    fn file_server_cannot_signal_or_rlimit_other_processes() {
        // Review I-1: every signal-sending call is refused; prlimit64 only for itself and read-only.
        let program = file_server_profile();
        for number in [nr::TGKILL, nr::TKILL, nr::KILL, nr::RT_SIGQUEUEINFO, nr::RT_TGSIGQUEUEINFO, nr::PIDFD_SEND_SIGNAL] {
            assert_eq!(run_args(&program, number, [1, 1, 9, 0, 0, 0]), Verdict::Errno(EPERM), "{number}");
        }
        assert_eq!(run_args(&program, nr::PRLIMIT64, [0, 7, 0, 0x7fff_0000, 0, 0]), Verdict::Allow, "getrlimit(RLIMIT_NOFILE)");
        assert_eq!(run_args(&program, nr::PRLIMIT64, [1, 7, 0, 0x7fff_0000, 0, 0]), Verdict::Errno(EPERM), "another pid");
        assert_eq!(run_args(&program, nr::PRLIMIT64, [1 << 32, 7, 0, 0, 0, 0]), Verdict::Errno(EPERM), "pid upper half");
        assert_eq!(run_args(&program, nr::PRLIMIT64, [0, 7, 0x7fff_1000, 0, 0, 0]), Verdict::Errno(EPERM), "a new limit");
        assert_eq!(run_args(&program, nr::PRLIMIT64, [0, 7, 1 << 40, 0, 0, 0]), Verdict::Errno(EPERM), "a new limit (upper half)");
    }

    #[test]
    fn fcntl_is_narrowed() {
        let program = file_server_profile();
        for cmd in [F_GETFD, F_SETFD, F_GETFL, F_DUPFD_CLOEXEC] {
            assert_eq!(run_args(&program, nr::FCNTL, [3, cmd as u64, 1, 0, 0, 0]), Verdict::Allow, "{cmd}");
        }
        assert_eq!(run_args(&program, nr::FCNTL, [3, F_SETFL as u64, 0o4000, 0, 0, 0]), Verdict::Allow, "O_NONBLOCK");
        assert_eq!(run_args(&program, nr::FCNTL, [3, F_SETFL as u64, (O_ASYNC | 0o4000) as u64, 0, 0, 0]), Verdict::Errno(EPERM), "O_ASYNC");
        for cmd in [F_SETOWN, F_SETSIG, F_SETOWN_EX, 0, 5, 6, 7, 1031] {
            assert_eq!(run_args(&program, nr::FCNTL, [3, cmd as u64, 1, 0, 0, 0]), Verdict::Errno(EPERM), "{cmd}");
        }
        assert_eq!(run_args(&program, nr::FCNTL, [3, (1u64 << 32) | F_GETFD as u64, 0, 0, 0, 0]), Verdict::Errno(EPERM), "cmd upper half");
    }

    #[test]
    fn probe_inputs_are_not_vacuous() {
        // Review X-1: this only proves the probe inputs reach an allow when unconditional rules precede the program (the
        // r2 rules). It says nothing about the rule bodies; those are proven by the saved body mutants M1-M4 of
        // scripts/negative-controls.sh, each of which must turn a named test above red.
        let mut r2 = Vec::new();
        prologue(&mut r2);
        for number in [nr::TGKILL, nr::PRLIMIT64, nr::FCNTL] {
            on_nr(&mut r2, number, SECCOMP_RET_ALLOW);
        }
        r2.extend_from_slice(&file_server_profile()[6..]);
        assert_eq!(run_args(&r2, nr::TGKILL, [1, 1, 9, 0, 0, 0]), Verdict::Allow);
        assert_eq!(run_args(&r2, nr::PRLIMIT64, [1, 7, 0x7fff_1000, 0, 0, 0]), Verdict::Allow);
        assert_eq!(run_args(&r2, nr::FCNTL, [3, F_SETOWN as u64, 1, 0, 0, 0]), Verdict::Allow);
    }

    #[test]
    fn clone_only_as_a_thread_without_namespaces() {
        let program = file_server_profile();
        assert_eq!(run(&program, nr::CLONE, THREAD_FLAGS), Verdict::Allow);
        assert_eq!(run(&program, nr::CLONE, 0x11), Verdict::Errno(EPERM), "fork-like clone (SIGCHLD)");
        assert_eq!(run(&program, nr::CLONE, THREAD_FLAGS | CLONE_NEWUSER as u64), Verdict::Errno(EPERM));
        assert_eq!(run(&program, nr::CLONE, THREAD_FLAGS | CLONE_NEWNS as u64), Verdict::Errno(EPERM));
        assert_eq!(run(&program, nr::CLONE, THREAD_FLAGS | (1u64 << 32)), Verdict::Errno(EPERM), "upper bits set");
    }

    #[test]
    fn prologue_kills_foreign_arch_and_x32() {
        for program in [file_server_profile(), domain_profile(Domain::Workload)] {
            let foreign = SeccompData { nr: nr::READ, arch: 0x4000_0003, args: [0; 6] };
            assert_eq!(interpret(&program, &foreign).unwrap(), Verdict::KillProcess);
            assert_eq!(run(&program, X32_SYSCALL_BIT | nr::READ, 0), Verdict::KillProcess);
        }
    }

    #[test]
    fn domain_profiles() {
        let workload = domain_profile(Domain::Workload);
        let orchestration = domain_profile(Domain::Orchestration);
        for program in [&workload, &orchestration] {
            for number in KEYRING_CALLS {
                assert_eq!(run(program, *number, 0), Verdict::Errno(EPERM));
            }
            assert_eq!(run(program, nr::CLONE3, 0), Verdict::Errno(ENOSYS));
            assert_eq!(run(program, nr::UNSHARE, CLONE_NEWUSER as u64), Verdict::Errno(EPERM));
            assert_eq!(run(program, nr::UNSHARE, (CLONE_NEWUSER | CLONE_NEWNS) as u64), Verdict::Errno(EPERM));
            assert_eq!(run(program, nr::CLONE, 0x11 | CLONE_NEWUSER as u64), Verdict::Errno(EPERM));
            assert_eq!(run(program, nr::CLONE, 0x11), Verdict::Allow);
            assert_eq!(run(program, nr::UNSHARE, CLONE_NEWNS as u64), Verdict::Allow, "capabilities, not seccomp, refuse this");
            assert_eq!(run(program, nr::EXECVE, 0), Verdict::Allow);
        }
        for number in ORCHESTRATION_EXTRA_DENY {
            assert_eq!(run(&orchestration, *number, 0), Verdict::Errno(EPERM));
            assert_eq!(run(&workload, *number, 0), Verdict::Allow);
        }
    }

    #[test]
    fn interpreter_negative_controls() {
        // A program that falls off the end, an unknown opcode and a bad offset are rejected, so a broken builder cannot
        // pass the tests above by accident.
        assert!(interpret(&[stmt(BPF_LD_W_ABS, 0)], &SeccompData::x86_64(0, [0; 6])).is_err());
        assert!(interpret(&[stmt(0xFFFF, 0)], &SeccompData::x86_64(0, [0; 6])).is_err());
        assert!(interpret(&[stmt(BPF_LD_W_ABS, 3), stmt(BPF_RET_K, 0)], &SeccompData::x86_64(0, [0; 6])).is_err());
        // A weakened file-server profile without the execve rule lets execve through to the default EPERM, not kill:
        let mut weakened = file_server_profile();
        let position = weakened.iter().position(|insn| insn.code == BPF_JMP_JEQ_K && insn.k == nr::EXECVE).unwrap();
        weakened[position].k = 0xFFFF;
        assert_ne!(run(&weakened, nr::EXECVE, 0), Verdict::KillProcess);
    }
}

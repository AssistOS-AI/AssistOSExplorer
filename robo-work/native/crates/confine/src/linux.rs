//! Linux-only confinement helpers. Compiled and type-checked for x86_64-unknown-linux-musl; NOT executed in this pass
//! (no namespace, privileged syscall or seccomp installation runs on the Mac). G1 measures the resulting properties.

use std::io;

use crate::seccomp::SockFilter;

fn check(result: libc::c_int) -> io::Result<()> {
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

pub fn set_no_new_privs() -> io::Result<()> {
    // SAFETY: prctl with integer arguments only.
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) })
}

pub fn no_new_privs_is_set() -> io::Result<bool> {
    // SAFETY: prctl with integer arguments only.
    let value = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) };
    if value < 0 { Err(io::Error::last_os_error()) } else { Ok(value == 1) }
}

/// Installs a seccomp filter on the calling thread (and, through inheritance, on threads created later). Requires
/// no_new_privs or CAP_SYS_ADMIN; callers set no_new_privs first.
pub fn install_filter(program: &[SockFilter]) -> io::Result<()> {
    if program.is_empty() || program.len() > 4096 {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let filters: Vec<libc::sock_filter> = program.iter().map(|insn| libc::sock_filter { code: insn.code, jt: insn.jt, jf: insn.jf, k: insn.k }).collect();
    let prog = libc::sock_fprog { len: filters.len() as libc::c_ushort, filter: filters.as_ptr() as *mut libc::sock_filter };
    // SAFETY: `prog` points at `filters`, which outlives the call; the kernel copies the program.
    check(unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER as libc::c_ulong, &prog as *const libc::sock_fprog as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) })
}

const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: libc::c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilitySets {
    pub effective: u64,
    pub permitted: u64,
    pub inheritable: u64,
    pub bounding: u64,
    pub ambient: u64,
}

impl CapabilitySets {
    pub fn all_empty(&self) -> bool {
        self.effective == 0 && self.permitted == 0 && self.inheritable == 0 && self.bounding == 0 && self.ambient == 0
    }
}

/// The highest capability number the kernel knows, probed with PR_CAPBSET_READ.
fn last_cap() -> u32 {
    let mut cap = 0u32;
    // SAFETY: prctl with integer arguments only.
    while cap < 64 && unsafe { libc::prctl(libc::PR_CAPBSET_READ, (cap + 1) as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) } >= 0 {
        cap += 1;
    }
    cap
}

pub fn read_capabilities() -> io::Result<CapabilitySets> {
    let mut header = CapHeader { version: LINUX_CAPABILITY_VERSION_3, pid: 0 };
    let mut data = [CapData::default(); 2];
    // SAFETY: capget with a v3 header and two data structs, as the ABI requires.
    let result = unsafe { libc::syscall(libc::SYS_capget, &mut header as *mut CapHeader, data.as_mut_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let join = |low: u32, high: u32| (low as u64) | ((high as u64) << 32);
    let mut bounding = 0u64;
    let mut ambient = 0u64;
    for cap in 0..=last_cap() {
        // SAFETY: prctl with integer arguments only.
        if unsafe { libc::prctl(libc::PR_CAPBSET_READ, cap as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) } == 1 {
            bounding |= 1 << cap;
        }
        // SAFETY: prctl with integer arguments only.
        if unsafe { libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_IS_SET as libc::c_ulong, cap as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) } == 1 {
            ambient |= 1 << cap;
        }
    }
    Ok(CapabilitySets {
        effective: join(data[0].effective, data[1].effective),
        permitted: join(data[0].permitted, data[1].permitted),
        inheritable: join(data[0].inheritable, data[1].inheritable),
        bounding,
        ambient,
    })
}

/// Empties all five capability sets: bounding (needs CAP_SETPCAP, so it goes first), ambient, then effective,
/// permitted and inheritable through capset. Verifies the result.
pub fn drop_all_capabilities() -> io::Result<()> {
    for cap in 0..=last_cap() {
        // SAFETY: prctl with integer arguments only.
        let result = unsafe { libc::prctl(libc::PR_CAPBSET_DROP, cap as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: prctl with integer arguments only.
    check(unsafe { libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) })?;
    let header = CapHeader { version: LINUX_CAPABILITY_VERSION_3, pid: 0 };
    let data = [CapData::default(); 2];
    // SAFETY: capset with a v3 header and two zeroed data structs.
    let result = unsafe { libc::syscall(libc::SYS_capset, &header as *const CapHeader, data.as_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if !read_capabilities()?.all_empty() {
        return Err(io::Error::other("capability sets not empty after drop"));
    }
    Ok(())
}

pub fn set_rlimit_nofile(limit: u64) -> io::Result<()> {
    let value = libc::rlimit { rlim_cur: limit as libc::rlim_t, rlim_max: limit as libc::rlim_t };
    // SAFETY: setrlimit with a valid struct.
    check(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &value) })
}

/// Parent-death SIGKILL, then a check that the parent is still the expected one (closes the race where the parent died
/// before prctl). The signal follows the thread that forked the caller (G1 records the behaviour under Node).
pub fn kill_on_parent_death(expected_parent: libc::pid_t) -> io::Result<()> {
    // SAFETY: prctl with integer arguments only.
    check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) })?;
    // SAFETY: getppid has no preconditions.
    if unsafe { libc::getppid() } != expected_parent {
        return Err(io::Error::other("parent already gone"));
    }
    Ok(())
}

pub fn set_child_subreaper() -> io::Result<()> {
    // SAFETY: prctl with integer arguments only.
    check(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) })
}

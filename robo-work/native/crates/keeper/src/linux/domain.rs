//! The outer, non-Bubblewrap construction stage (plan section 5.5, first construction checkpoint): the keeper forks a
//! child that enters new PID, IPC, UTS and mount namespaces (and, for an orchestration domain, a new loopback-only
//! network namespace), forks the PID-namespace init, which mounts a fresh `/proc` and execs exactly one unchanged
//! `/usr/bin/bwrap` with the argv of `crate::bwrap::bwrap_argv`.
//!
//! PROVISIONAL / UNWIRED: no frozen frame requests a domain; joining the execution network namespace by descriptor,
//! the gate and env pipes and the identity commit are part of the pending keeper wire contract. Type-checked only.

use std::ffi::CString;
use std::io;
use std::os::fd::RawFd;

use crate::bwrap::{BWRAP, DomainSpec, bwrap_argv};

pub struct Spawned {
    /// The PID-namespace init (it re-parents to the keeper, a child subreaper, when the intermediate exits).
    pub init_pid: libc::pid_t,
}

/// `netns`: Some(fd) joins the execution's network namespace (workload); None creates a new one (orchestration).
pub fn spawn_domain(spec: &DomainSpec, netns: Option<RawFd>, keeper_pid: libc::pid_t) -> io::Result<Spawned> {
    let argv = bwrap_argv(spec).map_err(io::Error::other)?;
    let argv: Vec<CString> = argv.into_iter().map(CString::new).collect::<Result<_, _>>().map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let program = CString::new(BWRAP).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let (proc_source, proc_target, slash) = (CString::new("proc")?, CString::new("/proc")?, CString::new("/")?);
    let mut pipe = [0 as RawFd; 2];
    // SAFETY: valid out array.
    if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the keeper is single-threaded.
    let intermediate = unsafe { libc::fork() };
    if intermediate < 0 {
        return Err(io::Error::last_os_error());
    }
    if intermediate == 0 {
        // SAFETY: child code; only syscalls and prepared data.
        unsafe {
            if rw_confine::linux::kill_on_parent_death(keeper_pid).is_err() {
                libc::_exit(120);
            }
            let mut flags = libc::CLONE_NEWPID | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS | libc::CLONE_NEWNS;
            match netns {
                Some(fd) => {
                    if libc::setns(fd, libc::CLONE_NEWNET) < 0 {
                        libc::_exit(121);
                    }
                }
                None => flags |= libc::CLONE_NEWNET,
            }
            if libc::unshare(flags) < 0 {
                libc::_exit(122);
            }
            let init = libc::fork();
            if init < 0 {
                libc::_exit(123);
            }
            if init > 0 {
                let bytes = init.to_ne_bytes();
                libc::write(pipe[1], bytes.as_ptr() as *const libc::c_void, bytes.len());
                libc::_exit(0);
            }
            // PID 1 of the new namespace: parent-death to the keeper is not inherited across the intermediate's exit,
            // so it is set again with the keeper as the expected parent after re-parenting is not guaranteed yet;
            // the intermediate's death delivers SIGKILL instead, which G1 must measure. Fresh /proc, private propagation.
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong);
            if libc::mount(std::ptr::null(), slash.as_ptr(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()) < 0 {
                libc::_exit(124);
            }
            if libc::mount(proc_source.as_ptr(), proc_target.as_ptr(), proc_source.as_ptr(), libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, std::ptr::null()) < 0 {
                libc::_exit(125);
            }
            let mut pointers: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
            pointers.push(std::ptr::null());
            let envp: [*const libc::c_char; 1] = [std::ptr::null()];
            libc::execve(program.as_ptr(), pointers.as_ptr(), envp.as_ptr());
            libc::_exit(126);
        }
    }
    // SAFETY: closing our write end; reading the init pid.
    unsafe { libc::close(pipe[1]) };
    let mut bytes = [0u8; 4];
    // SAFETY: valid buffer.
    let read = unsafe { libc::read(pipe[0], bytes.as_mut_ptr() as *mut libc::c_void, 4) };
    unsafe {
        libc::close(pipe[0]);
        libc::waitpid(intermediate, std::ptr::null_mut(), 0);
    }
    if read != 4 {
        return Err(io::Error::other("domain construction failed before the namespace init"));
    }
    Ok(Spawned { init_pid: libc::pid_t::from_ne_bytes(bytes) })
}

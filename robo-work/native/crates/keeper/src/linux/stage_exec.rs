//! The gated stage on Linux (see `crate::stage`). PROVISIONAL / UNWIRED, pending the keeper wire contract.

use std::ffi::CString;
use std::io::Read;
use std::os::fd::FromRawFd;

use rw_confine::seccomp::{Domain, domain_profile};
use rw_proto::gate::{GateOutcome, await_gate};

use crate::args::{StageArgs, StageDomain};
use crate::stage::{EXIT_ABORTED, MAX_ENV_BYTES, parse_env_block};

/// Never returns on success (the final exec replaces the image). Returns the exit code on any failure.
pub fn run(args: &StageArgs) -> i32 {
    // SAFETY: the gate descriptor was inherited for this purpose and is used once.
    let mut gate = unsafe { std::fs::File::from_raw_fd(args.gate_fd) };
    if await_gate(&mut gate) != GateOutcome::Commit {
        return EXIT_ABORTED;
    }
    drop(gate);
    let mut block = Vec::new();
    if let Some(env_fd) = args.env_fd {
        // SAFETY: inherited for this purpose, used once.
        let env = unsafe { std::fs::File::from_raw_fd(env_fd) };
        if env.take(MAX_ENV_BYTES as u64 + 1).read_to_end(&mut block).is_err() {
            return EXIT_ABORTED;
        }
    }
    let Ok(environment) = parse_env_block(&block) else { return EXIT_ABORTED };
    if rw_confine::linux::set_no_new_privs().is_err() {
        return EXIT_ABORTED;
    }
    match rw_confine::linux::read_capabilities() {
        Ok(sets) if sets.all_empty() => {}
        _ => return EXIT_ABORTED,
    }
    let domain = match args.domain { StageDomain::Orchestration => Domain::Orchestration, StageDomain::Workload => Domain::Workload };
    if rw_confine::linux::install_filter(&domain_profile(domain)).is_err() {
        return EXIT_ABORTED;
    }
    let Ok(argv) = args.argv.iter().map(|arg| CString::new(arg.as_str())).collect::<Result<Vec<_>, _>>() else { return EXIT_ABORTED };
    let Ok(envp) = environment.iter().map(|(name, value)| CString::new(format!("{name}={value}"))).collect::<Result<Vec<_>, _>>() else { return EXIT_ABORTED };
    // Review R8: Rust sets SIGPIPE to SIG_IGN and an ignored disposition survives execve; workloads start with the default.
    // SAFETY: resetting one signal disposition.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());
    let mut envp_ptrs: Vec<*const libc::c_char> = envp.iter().map(|entry| entry.as_ptr()).collect();
    envp_ptrs.push(std::ptr::null());
    // SAFETY: NUL-terminated pointer arrays to live CStrings; absolute program path (checked by the argv parser).
    unsafe { libc::execve(argv[0].as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr()) };
    127
}

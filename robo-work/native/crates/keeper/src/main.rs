//! `keeper serve ...` or `keeper stage ...` (see `args`). Linux only; on another host the binary parses its arguments
//! and refuses to run.

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let command = match rw_keeper::args::parse(&argv) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("keeper: {message}");
            std::process::exit(64);
        }
    };
    std::process::exit(run(command));
}

#[cfg(not(target_os = "linux"))]
fn run(_command: rw_keeper::args::Command) -> i32 {
    eprintln!("keeper: Linux only");
    69
}

#[cfg(target_os = "linux")]
fn run(command: rw_keeper::args::Command) -> i32 {
    use rw_keeper::args::Command;
    match command {
        Command::Stage(stage) => rw_keeper::linux::stage_exec::run(&stage),
        Command::Serve(serve) => serve_main(serve),
    }
}

/// Startup checks of the contract (§3, "At startup the keeper runs these checks in order. Any failure exits 64"), then
/// `hello` and the event loop, which blocks for `commit_keeper` (EOF exits 66, any other frame exits 65).
#[cfg(target_os = "linux")]
fn serve_main(serve: rw_keeper::args::ServeArgs) -> i32 {
    use rw_keeper::core::KeeperCore;
    use rw_keeper::linux::{os::{LinuxOs, HeldCgroupSubtree}, runloop};
    use rw_keeper::procfs::start_time_from_stat;
    use rw_proto::keeper_frames::hello_event;
    use rw_proto::keeper_limits::hello_limits;

    // 1. The /proc/self/fd set equals the declared layout exactly.
    let declared = serve.declared_fds();
    let mut actual: Vec<i32> = match std::fs::read_dir("/proc/self/fd") {
        Ok(entries) => entries.filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok()).collect(),
        Err(_) => return 64,
    };
    actual.sort_unstable();
    // read_dir holds one descriptor of its own while listing: drop the entry that is not in the layout and not open now.
    // SAFETY: F_GETFD has no side effects.
    actual.retain(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } >= 0);
    if actual != declared {
        eprintln!("keeper: descriptor layout {actual:?} differs from the declared {declared:?}");
        return 64;
    }
    // 2. Parent-death SIGKILL, then getppid() == --parent-pid. 3. Child subreaper.
    if rw_confine::linux::kill_on_parent_death(serve.parent_pid).is_err() || rw_confine::linux::set_child_subreaper().is_err() {
        return 64;
    }
    // 4. HOME identity.
    if let (Some((dev, ino)), Some(slot)) = (serve.home_identity, serve.home_slot()) {
        // SAFETY: zeroed out-parameter.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(slot, &mut stat) } < 0 || stat.st_mode & libc::S_IFMT != libc::S_IFDIR || stat.st_dev as u64 != dev || stat.st_ino as u64 != ino {
            return 64;
        }
    }
    // 4b. Bind the optional cgroup subtree by descriptor before hello. All checks are read-only.
    let subtree = match serve.cgroup_subtree.as_ref().map(HeldCgroupSubtree::open).transpose() {
        Ok(subtree) => subtree,
        Err(_) => return 64,
    };
    // 5. hello, then the gate.
    let Some(start_time) = std::fs::read_to_string("/proc/self/stat").ok().as_deref().and_then(start_time_from_stat) else { return 64 };
    // SAFETY: getpid has no preconditions.
    let pid = unsafe { libc::getpid() } as i64;
    let hello = hello_event(pid, start_time, &serve.reservation, hello_limits(&serve.limits, &serve.view_limits));
    let Ok(os) = LinuxOs::new(&serve.runtime_root) else { return 64 };
    // 6. Startup custody (first-G1 plan): consumed once by the OS layer. Keeper fd 3 is never part of it.
    let Some(custody) = startup_custody(&serve) else { return 64 };
    // The embedded apparatus image policy, if this build has one. A mismatch leaves the keeper without a policy, so
    // every process-bearing create refuses (fail closed); the keeper itself still serves.
    let policy = match rw_keeper::linux::policy::load_embedded() {
        Ok(policy) => policy,
        Err(reason) => {
            eprintln!("keeper: embedded image policy refused: {reason}");
            None
        }
    };
    let os = os.with_startup_custody(custody, policy).with_orchestration_root(serve.orchestration_root.clone());
    let mut core = KeeperCore::new(os.with_cgroup_subtree(subtree), serve.scope.mount_scope(), &serve.runtime_root, &serve.reservation, serve.grant_roots, serve.limits, serve.view_limits)
        .with_orchestration_root(serve.orchestration_root.clone())
        .with_cgroup_subtree(serve.cgroup_subtree.as_ref().map(|subtree| subtree.path.clone()));
    runloop::run(&mut core, serve.limits, hello)
}

/// Takes ownership of the validated startup descriptors (they were inherited without CLOEXEC; each becomes CLOEXEC so
/// no later fork inherits it by accident) and creates the provider socketpair once.
#[cfg(target_os = "linux")]
fn startup_custody(serve: &rw_keeper::args::ServeArgs) -> Option<rw_keeper::domain_policy::StartupCustody> {
    use std::os::fd::{FromRawFd, OwnedFd};
    use rw_keeper::args::{CONTROL_FDS, ENDPOINT_FD};
    use rw_keeper::domain_policy::{HeldDirectory, StartupCustody};
    use rw_keeper::linux::sys;
    let take = |fd: i32| -> Option<OwnedFd> {
        sys::set_cloexec(fd).ok()?;
        // SAFETY: a descriptor of the declared startup layout, checked above and owned by nobody else.
        Some(unsafe { OwnedFd::from_raw_fd(fd) })
    };
    let directory = |path: &str| -> Option<HeldDirectory> {
        let fd = sys::open_nofollow(libc::AT_FDCWD, path, true).ok()?;
        let identity = sys::identity(&sys::fstat(std::os::fd::AsRawFd::as_raw_fd(&fd)).ok()?);
        HeldDirectory::validate(fd, identity).ok()
    };
    let runtime = directory(&serve.runtime_root)?;
    let home = match (serve.home_identity, serve.home_slot()) {
        (Some(identity), Some(slot)) => Some(HeldDirectory::validate(take(slot)?, identity).ok()?),
        _ => None,
    };
    // The orchestration root is not opened here: scripts are admitted only as pinned image-policy code files below it
    // (`domain_policy`), and an unused descriptor must not add a startup failure.
    let orchestration = None;
    let (endpoint, control, provider) = if serve.ala {
        let endpoint = take(ENDPOINT_FD)?;
        let control = [take(CONTROL_FDS[0])?, take(CONTROL_FDS[1])?, take(CONTROL_FDS[2])?];
        let (endpoint_end, orchestration_end) = sys::socketpair(libc::SOCK_STREAM).ok()?;
        (Some(endpoint), Some(control), Some([endpoint_end, orchestration_end]))
    } else {
        (None, None, None)
    };
    Some(StartupCustody { runtime, home, orchestration, endpoint, control, provider, limits: serve.limits })
}

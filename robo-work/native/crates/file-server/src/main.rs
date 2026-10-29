//! `rw-file-server --fuse-fd 3 --root-fd 4 --access read|write --descriptor-cap N --grant <id>`, started only by the
//! keeper (crates/keeper/src/linux/os.rs), already without capabilities, with no_new_privs, in an empty mount
//! namespace without network. Linux only.

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match rw_file_server::args::parse(&argv) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("rw-file-server: {message}");
            std::process::exit(64);
        }
    };
    std::process::exit(run(args));
}

#[cfg(not(target_os = "linux"))]
fn run(_args: rw_file_server::args::ServerArgs) -> i32 {
    eprintln!("rw-file-server: Linux only");
    69
}

#[cfg(target_os = "linux")]
fn run(args: rw_file_server::args::ServerArgs) -> i32 {
    use std::os::fd::FromRawFd;
    use std::sync::atomic::Ordering;

    use rw_file_server::args::{FUSE_FD, ROOT_FD};
    use rw_file_server::backing::{LinuxBacking, fstat};
    use rw_file_server::glue::{Glue, Shared};
    use rw_fsview::engine::{EngineLimits, ViewEngine};

    // 1. Inherited authority is exactly 0, 1, 2, /dev/fuse (3) and the grant root (4) (plan section 5.4).
    for fd in 5..1024 {
        // SAFETY: F_GETFD on a descriptor number has no side effects.
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0 {
            eprintln!("rw-file-server: unexpected inherited descriptor {fd}");
            return 70;
        }
    }
    let fuse_ok = fstat(FUSE_FD).is_ok_and(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFCHR);
    let root_ok = fstat(ROOT_FD).is_ok_and(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFDIR);
    if !fuse_ok || !root_ok {
        eprintln!("rw-file-server: descriptor 3 must be /dev/fuse and 4 a directory");
        return 70;
    }
    // 2. SIGTERM (root revocation) is taken synchronously by this thread; every thread started later inherits the mask.
    // SAFETY: sigset manipulation on a local set.
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
    // 3. Seccomp before any request is parsed (execve kills; plan section 5.4 "Seccomp").
    if rw_confine::linux::set_no_new_privs().is_err() || rw_confine::linux::install_filter(&rw_confine::seccomp::file_server_profile()).is_err() {
        eprintln!("rw-file-server: seccomp installation failed");
        return 70;
    }
    // 4. The engine over the grant root, and the session over the keeper's /dev/fuse descriptor. Session::from_fd is
    //    the only constructor used; it performs the FUSE handshake and never mounts.
    let limits = EngineLimits { descriptor_cap: args.descriptor_cap, ..EngineLimits::default() };
    let engine = match ViewEngine::new(LinuxBacking::new(ROOT_FD), limits, true) {
        Ok(engine) => engine,
        Err(_) => return 70,
    };
    let shared = Shared::new(engine);
    // SAFETY: descriptor 3 was inherited for this purpose and is owned by the session from here on.
    let fuse = unsafe { std::os::fd::OwnedFd::from_raw_fd(FUSE_FD) };
    let session = match fuser::Session::from_fd(Glue::new(shared.clone(), args.read_only), fuse, fuser::SessionACL::All, fuser::Config::default()) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("rw-file-server: FUSE handshake failed: {error}");
            return 71;
        }
    };
    if shared.start_notifier(session.notifier()).is_err() {
        return 71;
    }
    let background = match session.spawn() {
        Ok(background) => background,
        Err(_) => return 71,
    };
    // 5. Wait for SIGTERM or the end of the session.
    let timeout = libc::timespec { tv_sec: 0, tv_nsec: 100_000_000 };
    loop {
        // SAFETY: valid set and timeout.
        let signal = unsafe { libc::sigtimedwait(&set, std::ptr::null_mut(), &timeout) };
        if signal == libc::SIGTERM {
            // Root revocation (D-S5-6): wait for the request in progress (a completed write keeps its true result), make
            // every node protected, send best-effort invalidations, exit. Later operations fail with ENOTCONN.
            shared.revoked.store(true, Ordering::SeqCst);
            {
                let mut engine = shared.lock();
                engine.revoke_root();
                shared.flush_invalidations(&mut engine);
            }
            // The engine lock is released, so the event loop keeps answering (refusing) requests, including a READ that
            // a page fault being invalidated waits for. Give the notifier thread a bounded moment, then exit.
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::process::exit(0);
        }
        if background.guard.is_finished() {
            return 0;
        }
    }
}

//! The single Bubblewrap construction stage (plan section 5.5, first construction checkpoint; first-G1 amendment A1.1),
//! argv builder (pure).
//!
//! The construction is: an outer stage that is not Bubblewrap (the keeper's own direct child, created in fresh PID, IPC,
//! UTS and mount namespaces, which joins or builds the network namespace and mounts a fresh `/proc`; `linux::domain`),
//! then exactly ONE invocation of the image's unchanged `/usr/bin/bwrap`, by absolute path (never renamed, copied or
//! looked up on PATH). Bubblewrap creates the user namespace, maps the workload identity, drops every capability
//! including the bounding set, denies further user namespaces and builds the final private view. It runs the keeper
//! binary in `stage` mode, which carries the reservation marker in argv, reports READY on the private stage channel,
//! waits for the commit byte and only then performs the final exec with the workload environment.
//!
//! A1.1 topology: the invocation does not ask Bubblewrap for another PID namespace (`--unshare-pid`, `--pidns`,
//! `--as-pid-1`, `--sync-fd` and lock files are never emitted). The outer namespace init therefore execs Bubblewrap and
//! stays its monitor; the sandbox child (the stage, then the intended executable) is its direct child in the same PID
//! namespace. With no new PID namespace Bubblewrap's `--proc` binds the outer stage's fresh `/proc`.
//!
//! Every view source is a descriptor the keeper opened and checked (`--ro-bind-fd` / `--bind-fd`); no source path is
//! resolved by Bubblewrap. The setup environment is empty (`--clearenv`; the anchor execs with an empty envp).

use crate::args::StageDomain;

pub const BWRAP: &str = "/usr/bin/bwrap";
/// The robot identity inside every execution user namespace (`1000 <keeper uid> 1`).
pub const ROBOT_ID: u32 = 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageInvocation {
    /// The keeper binary as seen inside the domain view (bound read-only from the pinned image file).
    pub keeper_path: String,
    pub marker: String,
    pub channel_fd: i32,
    pub gate_fd: i32,
    pub env_fd: i32,
    pub domain: StageDomain,
    pub installs: Vec<(i32, i32)>,
    pub nofile: Option<u64>,
    pub final_argv: Vec<String>,
}

/// One descriptor-anchored bind of the view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BindFd {
    pub fd: i32,
    pub target: String,
    pub read_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainSpec {
    pub uid: u32,
    pub gid: u32,
    pub binds: Vec<BindFd>,
    pub tmpfs: Vec<String>,
    pub chdir: String,
    /// False for a terminal domain, whose shell needs the PTY as its controlling terminal.
    pub new_session: bool,
    pub stage: StageInvocation,
}

fn absolute(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0') && path.split('/').all(|part| part != ".." && part != ".")
}

/// The complete argv of the one bwrap invocation (argv[0] is the program path).
pub fn bwrap_argv(spec: &DomainSpec) -> Result<Vec<String>, &'static str> {
    let stage = &spec.stage;
    if !absolute(&stage.keeper_path) || !absolute(&spec.chdir) {
        return Err("path_not_absolute");
    }
    if stage.final_argv.is_empty() || !absolute(&stage.final_argv[0]) {
        return Err("final_program_not_absolute");
    }
    if stage.final_argv.iter().any(|arg| arg.contains('\0')) {
        return Err("nul_in_argument");
    }
    if !rw_proto::keeper_frames::is_origin_id(&stage.marker) {
        return Err("bad_marker");
    }
    let private = [stage.channel_fd, stage.gate_fd, stage.env_fd];
    let mut used: Vec<i32> = private.to_vec();
    used.extend(stage.installs.iter().map(|(from, _)| *from));
    used.extend(spec.binds.iter().map(|bind| bind.fd));
    if used.iter().enumerate().any(|(index, fd)| *fd <= crate::args::MAX_INSTALL_TARGET || used[..index].contains(fd)) {
        return Err("descriptor_layout");
    }
    let mut argv: Vec<String> = vec![BWRAP.into()];
    let mut push = |items: &[&str]| argv.extend(items.iter().map(|item| item.to_string()));
    push(&["--unshare-user", "--disable-userns", "--uid", &spec.uid.to_string(), "--gid", &spec.gid.to_string()]);
    push(&["--cap-drop", "ALL", "--die-with-parent", "--clearenv"]);
    if spec.new_session {
        push(&["--new-session"]);
    }
    push(&["--proc", "/proc", "--dev", "/dev"]);
    for destination in &spec.tmpfs {
        if !absolute(destination) {
            return Err("path_not_absolute");
        }
        push(&["--tmpfs", destination]);
    }
    for bind in &spec.binds {
        if !absolute(&bind.target) || bind.target == "/" {
            return Err("path_not_absolute");
        }
        push(&[if bind.read_only { "--ro-bind-fd" } else { "--bind-fd" }, &bind.fd.to_string(), &bind.target]);
    }
    push(&["--chdir", &spec.chdir, "--"]);
    push(&[&stage.keeper_path, "stage", "--reservation", &stage.marker]);
    push(&["--channel-fd", &stage.channel_fd.to_string(), "--gate-fd", &stage.gate_fd.to_string(), "--env-fd", &stage.env_fd.to_string()]);
    push(&["--domain", stage.domain.as_str()]);
    for (from, to) in &stage.installs {
        push(&["--install", &format!("{from}:{to}")]);
    }
    if let Some(limit) = stage.nofile {
        push(&["--nofile", &limit.to_string()]);
    }
    push(&["--"]);
    argv.extend(stage.final_argv.iter().cloned());
    Ok(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "-_8AAAAAAAAAAAAAAAAAAA";

    fn spec() -> DomainSpec {
        DomainSpec {
            uid: ROBOT_ID, gid: ROBOT_ID,
            binds: vec![
                BindFd { fd: 20, target: "/usr/local/libexec/robo-work/keeper".into(), read_only: true },
                BindFd { fd: 21, target: "/usr/local/bin/node".into(), read_only: true },
                BindFd { fd: 22, target: "/home/robot".into(), read_only: false },
            ],
            tmpfs: vec![],
            chdir: "/home/robot".into(),
            new_session: true,
            stage: StageInvocation {
                keeper_path: "/usr/local/libexec/robo-work/keeper".into(), marker: MARKER.into(), channel_fd: 10, gate_fd: 11, env_fd: 12,
                domain: StageDomain::Workload, installs: vec![], nofile: None, final_argv: vec!["/usr/local/bin/node".into(), "fixture.mjs".into()],
            },
        }
    }

    #[test]
    fn exactly_one_unchanged_bwrap_by_absolute_path_and_the_a1_topology() {
        let argv = bwrap_argv(&spec()).unwrap();
        assert_eq!(argv[0], "/usr/bin/bwrap");
        assert_eq!(argv.iter().filter(|arg| arg.contains("bwrap")).count(), 1);
        for flag in ["--unshare-user", "--disable-userns", "--cap-drop", "--die-with-parent", "--clearenv", "--proc", "--dev", "--new-session"] {
            assert!(argv.iter().any(|arg| arg == flag), "{flag}");
        }
        // A1.1: Bubblewrap keeps the outer PID namespace and stays the monitor of one sandbox child.
        for forbidden in ["--unshare-pid", "--pidns", "--as-pid-1", "--sync-fd", "--lock-file", "--unshare-all", "--share-net", "--preserve-fds", "--bind", "--ro-bind"] {
            assert!(!argv.iter().any(|arg| arg == forbidden), "{forbidden}");
        }
        let cap = argv.iter().position(|arg| arg == "--cap-drop").unwrap();
        assert_eq!(argv[cap + 1], "ALL");
        let stage = argv.iter().position(|arg| arg == "stage").unwrap();
        assert_eq!(argv[stage - 1], "/usr/local/libexec/robo-work/keeper");
        assert!(argv.windows(2).any(|pair| pair[0] == "--reservation" && pair[1] == MARKER), "the marker is the next element, unchanged");
        assert!(argv.windows(3).any(|w| w[0] == "--ro-bind-fd" && w[1] == "21" && w[2] == "/usr/local/bin/node"));
        assert!(argv.windows(3).any(|w| w[0] == "--bind-fd" && w[1] == "22" && w[2] == "/home/robot"));
        assert_eq!(&argv[argv.len() - 2..], &["/usr/local/bin/node".to_string(), "fixture.mjs".to_string()]);
    }

    #[test]
    fn no_environment_values_and_validation() {
        let argv = bwrap_argv(&spec()).unwrap();
        assert!(!argv.iter().any(|arg| arg == "--setenv" || arg.contains('=')), "workload env is applied only at the final exec");
        let mut relative = spec();
        relative.stage.final_argv[0] = "node".into();
        assert_eq!(bwrap_argv(&relative), Err("final_program_not_absolute"));
        let mut escape = spec();
        escape.binds[0].target = "/run/../etc".into();
        assert_eq!(bwrap_argv(&escape), Err("path_not_absolute"));
        let mut root = spec();
        root.binds[0].target = "/".into();
        assert_eq!(bwrap_argv(&root), Err("path_not_absolute"));
        let mut terminal = spec();
        terminal.new_session = false;
        assert!(!bwrap_argv(&terminal).unwrap().iter().any(|arg| arg == "--new-session"));
        for clash in [3, 10, 11, 20] {
            let mut duplicate = spec();
            duplicate.binds[1].fd = clash;
            assert_eq!(bwrap_argv(&duplicate), Err("descriptor_layout"), "{clash}");
        }
    }

    #[test]
    fn endpoint_installs_and_descriptor_budget_reach_the_stage() {
        let mut endpoint = spec();
        endpoint.stage.domain = StageDomain::Endpoint;
        endpoint.stage.installs = vec![(13, 3), (14, 4)];
        endpoint.stage.nofile = Some(256);
        endpoint.tmpfs = vec!["/tmp".into()];
        let argv = bwrap_argv(&endpoint).unwrap();
        let stage = argv.iter().position(|arg| arg == "stage").unwrap();
        let tail = &argv[stage..];
        assert!(tail.windows(2).any(|w| w[0] == "--domain" && w[1] == "endpoint"));
        assert!(tail.windows(2).any(|w| w[0] == "--install" && w[1] == "13:3"));
        assert!(tail.windows(2).any(|w| w[0] == "--install" && w[1] == "14:4"));
        assert!(tail.windows(2).any(|w| w[0] == "--nofile" && w[1] == "256"));
        assert!(argv[..stage].windows(2).any(|w| w[0] == "--tmpfs" && w[1] == "/tmp"));
        // The stage argv round-trips through the stage parser.
        let parsed = crate::args::parse(&tail.to_vec()).unwrap();
        let crate::args::Command::Stage(parsed) = parsed else { panic!() };
        assert_eq!(parsed.installs, vec![(13, 3), (14, 4)]);
        assert_eq!(parsed.channel_fd, Some(10));
    }
}

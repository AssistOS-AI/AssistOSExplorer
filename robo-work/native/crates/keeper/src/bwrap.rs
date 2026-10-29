//! The single Bubblewrap construction stage (plan section 5.5, first construction checkpoint), argv builder (pure).
//!
//! The construction is: an outer stage that is not Bubblewrap (the keeper's own fork: PID, IPC, UTS, mount and network
//! namespace setup and a fresh `/proc`; `linux::domain`), then exactly ONE invocation of the image's unchanged
//! `/usr/bin/bwrap`, by absolute path (never renamed, copied or looked up on PATH), which creates the user namespace,
//! maps the workload identity, drops every capability including the bounding set, denies further user namespaces and
//! builds the final private views. Bubblewrap runs the keeper binary in `stage` mode, which carries the reservation
//! marker in argv, waits for the commit byte and only then performs the final exec with the workload environment.
//!
//! PROVISIONAL / UNWIRED: no frozen frame asks the keeper to build a domain. The spec type is an internal API, pending
//! the keeper wire contract; G1 decides whether this sequence works under each host's policy.

pub const BWRAP: &str = "/usr/bin/bwrap";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageInvocation {
    /// The keeper binary as seen inside the domain view (bound read-only).
    pub keeper_path: String,
    pub marker: String,
    pub gate_fd: i32,
    pub env_fd: Option<i32>,
    pub orchestration: bool,
    pub final_argv: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainSpec {
    pub uid: u32,
    pub gid: u32,
    pub ro_binds: Vec<(String, String)>,
    pub binds: Vec<(String, String)>,
    pub tmpfs: Vec<String>,
    pub chdir: String,
    /// False for a terminal domain, whose shell needs the PTY as its controlling terminal.
    pub new_session: bool,
    pub stage: StageInvocation,
}

fn absolute(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0') && path.split('/').all(|part| part != "..")
}

fn safe_arg(value: &str) -> bool {
    !value.contains('\0')
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
    if stage.final_argv.iter().any(|arg| !safe_arg(arg)) {
        return Err("nul_in_argument");
    }
    if !rw_proto::keeper_frames::is_origin_id(&stage.marker) {
        return Err("bad_marker");
    }
    let mut argv: Vec<String> = vec![BWRAP.into()];
    let mut push = |items: &[&str]| argv.extend(items.iter().map(|item| item.to_string()));
    push(&["--unshare-user", "--disable-userns", "--uid", &spec.uid.to_string(), "--gid", &spec.gid.to_string()]);
    push(&["--cap-drop", "ALL", "--die-with-parent", "--clearenv"]);
    if spec.new_session {
        push(&["--new-session"]);
    }
    for (source, destination) in &spec.ro_binds {
        if !absolute(source) || !absolute(destination) {
            return Err("path_not_absolute");
        }
        push(&["--ro-bind", source, destination]);
    }
    for (source, destination) in &spec.binds {
        if !absolute(source) || !absolute(destination) {
            return Err("path_not_absolute");
        }
        push(&["--bind", source, destination]);
    }
    for destination in &spec.tmpfs {
        if !absolute(destination) {
            return Err("path_not_absolute");
        }
        push(&["--tmpfs", destination]);
    }
    push(&["--proc", "/proc", "--dev", "/dev", "--chdir", &spec.chdir, "--"]);
    push(&[&stage.keeper_path, "stage", "--reservation", &stage.marker, "--gate-fd", &stage.gate_fd.to_string()]);
    if let Some(env_fd) = stage.env_fd {
        push(&["--env-fd", &env_fd.to_string()]);
    }
    push(&["--domain", if stage.orchestration { "orchestration" } else { "workload" }, "--"]);
    argv.extend(stage.final_argv.iter().cloned());
    Ok(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> DomainSpec {
        DomainSpec {
            uid: 1000, gid: 1000,
            ro_binds: vec![("/usr".into(), "/usr".into()), ("/opt/robo-work/bin/keeper".into(), "/opt/robo-work/bin/keeper".into())],
            binds: vec![("/run/robo-work/x/abcdef0123456789/home".into(), "/home/robot".into())],
            tmpfs: vec!["/tmp".into()],
            chdir: "/home/robot".into(),
            new_session: true,
            stage: StageInvocation {
                keeper_path: "/opt/robo-work/bin/keeper".into(), marker: "-_8AAAAAAAAAAAAAAAAAAA".into(), gate_fd: 5, env_fd: Some(6),
                orchestration: false, final_argv: vec!["/usr/bin/node".into(), "fixture.mjs".into()],
            },
        }
    }

    #[test]
    fn exactly_one_unchanged_bwrap_by_absolute_path() {
        let argv = bwrap_argv(&spec()).unwrap();
        assert_eq!(argv[0], "/usr/bin/bwrap");
        assert_eq!(argv.iter().filter(|arg| arg.contains("bwrap")).count(), 1);
        for flag in ["--unshare-user", "--disable-userns", "--cap-drop", "--die-with-parent", "--clearenv", "--proc", "--dev"] {
            assert!(argv.iter().any(|arg| arg == flag), "{flag}");
        }
        let cap = argv.iter().position(|arg| arg == "--cap-drop").unwrap();
        assert_eq!(argv[cap + 1], "ALL");
        // The marker is in the stage argv (found in /proc/<pid>/cmdline until the final exec), and the final program
        // comes last, after the stage's own "--".
        let stage = argv.iter().position(|arg| arg == "stage").unwrap();
        assert_eq!(argv[stage - 1], "/opt/robo-work/bin/keeper");
        assert!(argv[stage..].windows(2).any(|pair| pair[0] == "--reservation" && pair[1] == "-_8AAAAAAAAAAAAAAAAAAA"), "the marker is the next element, unchanged");
        assert_eq!(&argv[argv.len() - 2..], &["/usr/bin/node".to_string(), "fixture.mjs".to_string()]);
    }

    #[test]
    fn no_environment_values_and_validation() {
        let argv = bwrap_argv(&spec()).unwrap();
        assert!(!argv.iter().any(|arg| arg == "--setenv" || arg.contains('=')), "workload env is applied only at the final exec");
        let mut relative = spec();
        relative.stage.final_argv[0] = "node".into();
        assert_eq!(bwrap_argv(&relative), Err("final_program_not_absolute"));
        let mut escape = spec();
        escape.binds[0].0 = "/run/../etc".into();
        assert_eq!(bwrap_argv(&escape), Err("path_not_absolute"));
        let mut terminal = spec();
        terminal.new_session = false;
        assert!(!bwrap_argv(&terminal).unwrap().iter().any(|arg| arg == "--new-session"));
    }
}

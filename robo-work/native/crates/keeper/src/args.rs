//! Keeper argv (pure), v1 wire contract §3 "Keeper argv" and R1.6 rebinding:
//!
//! ```text
//! keeper serve --protocol 1 --reservation <marker> --parent-pid <supervisor pid>
//!              --scope execution|terminal|gui --runtime-root <abs> --ala 0|1 --grant-roots <g>
//!              [--home-identity <dev>:<ino>] [--orchestration-root <abs>]
//!              [--cgroup-subtree <dev>:<ino>:<abs>]
//!              --channel-limit <name>=<value> ... --view-limit <name>=<value> ...
//! keeper stage --reservation <marker> --gate-fd <n> [--env-fd <n>] [--channel-fd <n>]
//!              [--domain orchestration|workload|endpoint] [--install <from>:<to> ...] [--nofile <n>] -- <final argv...>
//! ```
//!
//! Every value is its own argv element and a value token is never interpreted as a flag, so a marker that starts with
//! `-` (S1 ids are base64url) is carried unchanged; `--reservation=<m>` is not accepted. The marker is the 22-character
//! S1 resource id (`isOriginId`). The channel is fixed at fd 3 (no `--channel-fd`); the file-server path is the
//! build-time constant [`FILE_SERVER_PATH`] (no `--file-server`).

use rw_proto::keeper_frames::is_origin_id;
use rw_proto::keeper_limits::{KeeperLimitError, KeeperLimits, map_view_error, resolve_keeper_limits};
use rw_proto::limits::{ViewLimits, parse_override, resolve_view_limits};
use rw_proto::mount_frames::Scope;

pub const CHANNEL_FD: i32 = 3;
pub const ENDPOINT_FD: i32 = 4;
pub const CONTROL_FDS: [i32; 3] = [5, 6, 7];
pub const FILE_SERVER_PATH: &str = "/usr/local/libexec/robo-work/rw-file-server";
pub const PROTOCOL_VERSION: &str = "1";

/// Leaves 35 bytes for `/x-` and its 32 lowercase hex characters within the 1024-byte locator limit.
pub const MAX_CGROUP_SUBTREE_BYTES: usize = 989;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CgroupSubtree {
    pub path: String,
    pub dev: u64,
    pub ino: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeeperScope {
    Execution,
    Terminal,
    Gui,
}

impl KeeperScope {
    /// The `viewMountpoint` scope: a terminal's views live in its execution mount namespace like an execution's.
    pub fn mount_scope(self) -> Scope {
        match self {
            KeeperScope::Gui => Scope::Gui,
            _ => Scope::Execution,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServeArgs {
    pub reservation: String,
    pub parent_pid: i32,
    pub scope: KeeperScope,
    pub runtime_root: String,
    pub ala: bool,
    pub grant_roots: i64,
    pub home_identity: Option<(u64, u64)>,
    pub orchestration_root: Option<String>,
    pub cgroup_subtree: Option<CgroupSubtree>,
    pub limits: KeeperLimits,
    pub view_limits: ViewLimits,
}

impl ServeArgs {
    /// The descriptors the spawn layout declares (§3 table): 0-3 always, 4-7 iff `--ala 1`, grant roots at 8.., HOME
    /// after them iff `--home-identity`.
    pub fn declared_fds(&self) -> Vec<i32> {
        let mut fds = vec![0, 1, 2, CHANNEL_FD];
        if self.ala {
            fds.push(ENDPOINT_FD);
            fds.extend(CONTROL_FDS);
        }
        let first = self.view_limits.first_grant_root_slot as i32;
        fds.extend(first..first + self.grant_roots as i32);
        if self.home_identity.is_some() {
            fds.push(first + self.grant_roots as i32);
        }
        fds
    }

    pub fn home_slot(&self) -> Option<i32> {
        self.home_identity.map(|_| (self.view_limits.first_grant_root_slot + self.grant_roots) as i32)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageDomain {
    Orchestration,
    Workload,
    /// The provider endpoint: orchestration seccomp profile, inherited channels on 3 and 4 (first-G1 plan, roles table).
    Endpoint,
}

impl StageDomain {
    pub fn as_str(self) -> &'static str {
        match self {
            StageDomain::Orchestration => "orchestration",
            StageDomain::Workload => "workload",
            StageDomain::Endpoint => "endpoint",
        }
    }
}

/// At most this many inherited descriptors are relocated by the stage (orchestration: three control channels and the
/// provider socket).
pub const MAX_STAGE_INSTALLS: usize = 4;
/// Relocation targets are final slots 0-4; sources are the transient slots the keeper chose above them.
pub const MAX_INSTALL_TARGET: i32 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageArgs {
    pub marker: String,
    pub gate_fd: i32,
    pub env_fd: Option<i32>,
    /// The private SOCK_SEQPACKET stage channel (A1.2). Required by the Linux stage; optional only in this parser.
    pub channel_fd: Option<i32>,
    pub domain: StageDomain,
    /// `(from, to)`: inherited descriptors the stage moves to their final slot before READY.
    pub installs: Vec<(i32, i32)>,
    /// RLIMIT_NOFILE soft and hard value applied before READY (the endpoint's fixed descriptor budget).
    pub nofile: Option<u64>,
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Serve(ServeArgs),
    Stage(StageArgs),
}

fn normalized_absolute(path: &str) -> bool {
    path.starts_with('/') && path.len() >= 2 && !path.ends_with('/')
        && path.split('/').skip(1).all(|part| !(part.is_empty() || part == "." || part == ".."))
        && !path.contains('\0')
}

fn fd(value: &str) -> Result<i32, String> {
    match value.parse::<i32>() {
        Ok(number) if (0..=65535).contains(&number) && value.bytes().all(|byte| byte.is_ascii_digit()) => Ok(number),
        _ => Err(format!("bad descriptor number: {value}")),
    }
}

fn decimal_u64(value: &str) -> Option<u64> {
    (!value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())).then(|| value.parse().ok()).flatten()
}

pub fn parse(argv: &[String]) -> Result<Command, String> {
    let (mode, rest) = argv.split_first().ok_or("missing mode (serve or stage)")?;
    match mode.as_str() {
        "serve" => parse_serve(rest).map(Command::Serve),
        "stage" => parse_stage(rest).map(Command::Stage),
        other => Err(format!("unknown mode: {other}")),
    }
}

fn take<'a>(rest: &'a [String], index: &mut usize, flag: &str) -> Result<&'a str, String> {
    *index += 1;
    rest.get(*index).map(String::as_str).ok_or_else(|| format!("{flag} needs a value"))
}

fn limit_error(error: KeeperLimitError) -> String {
    format!("{error:?}")
}

fn parse_serve(rest: &[String]) -> Result<ServeArgs, String> {
    let mut protocol = None;
    let mut reservation: Option<String> = None;
    let mut parent_pid = None;
    let mut scope = None;
    let mut runtime_root: Option<String> = None;
    let mut ala = None;
    let mut grants = None;
    let mut home_identity = None;
    let mut orchestration_root: Option<String> = None;
    let mut cgroup_subtree = None;
    let mut channel_overrides: Vec<(String, i64)> = Vec::new();
    let mut view_overrides: Vec<(String, i64)> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        let flag = rest[index].as_str();
        let value = take(rest, &mut index, flag)?;
        let once = |taken: bool| if taken { Err(format!("{flag} given twice")) } else { Ok(()) };
        match flag {
            "--protocol" => { once(protocol.is_some())?; protocol = Some(value.to_string()) }
            "--reservation" => { once(reservation.is_some())?; reservation = Some(value.to_string()) }
            "--parent-pid" => {
                once(parent_pid.is_some())?;
                parent_pid = Some(value.parse::<i32>().ok().filter(|pid| *pid > 0 && value.bytes().all(|byte| byte.is_ascii_digit())).ok_or("bad --parent-pid")?);
            }
            "--scope" => {
                once(scope.is_some())?;
                scope = Some(match value { "execution" => KeeperScope::Execution, "terminal" => KeeperScope::Terminal, "gui" => KeeperScope::Gui, _ => return Err("bad --scope".into()) });
            }
            "--runtime-root" => { once(runtime_root.is_some())?; runtime_root = Some(value.to_string()) }
            "--ala" => {
                once(ala.is_some())?;
                ala = Some(match value { "0" => false, "1" => true, _ => return Err("bad --ala".into()) });
            }
            "--grant-roots" => {
                once(grants.is_some())?;
                grants = Some(decimal_u64(value).ok_or("bad --grant-roots")? as i64);
            }
            "--home-identity" => {
                once(home_identity.is_some())?;
                let (dev, ino) = value.split_once(':').ok_or("bad --home-identity")?;
                home_identity = Some((decimal_u64(dev).ok_or("bad --home-identity")?, decimal_u64(ino).ok_or("bad --home-identity")?));
            }
            "--orchestration-root" => { once(orchestration_root.is_some())?; orchestration_root = Some(value.to_string()) }
            "--cgroup-subtree" => {
                once(cgroup_subtree.is_some())?;
                let mut parts = value.splitn(3, ':');
                let dev = parts.next().and_then(decimal_u64).ok_or("bad --cgroup-subtree")?;
                let ino = parts.next().and_then(decimal_u64).ok_or("bad --cgroup-subtree")?;
                let path = parts.next().filter(|path| normalized_absolute(path) && path.len() <= MAX_CGROUP_SUBTREE_BYTES).ok_or("bad --cgroup-subtree")?;
                cgroup_subtree = Some(CgroupSubtree { path: path.into(), dev, ino });
            }
            "--channel-limit" => channel_overrides.push(parse_override(value).map_err(|error| format!("{error:?}"))?),
            "--view-limit" => view_overrides.push(parse_override(value).map_err(|error| format!("{error:?}"))?),
            other => return Err(format!("unknown flag: {other}")),
        }
        index += 1;
    }
    if protocol.as_deref() != Some(PROTOCOL_VERSION) {
        return Err("--protocol 1 is required".into());
    }
    let reservation = reservation.ok_or("--reservation is required")?;
    if !is_origin_id(&reservation) {
        return Err("--reservation must be a 22-character base64url S1 id".into());
    }
    let runtime_root = runtime_root.ok_or("--runtime-root is required")?;
    if !normalized_absolute(&runtime_root) {
        return Err("--runtime-root must be a normalized absolute path".into());
    }
    if let Some(root) = &orchestration_root {
        if !normalized_absolute(root) {
            return Err("--orchestration-root must be a normalized absolute path".into());
        }
    }
    let view_borrowed: Vec<(&str, i64)> = view_overrides.iter().map(|(name, value)| (name.as_str(), *value)).collect();
    let view_limits = resolve_view_limits(&view_borrowed).map_err(|error| limit_error(map_view_error(error)))?;
    let channel_borrowed: Vec<(&str, i64)> = channel_overrides.iter().map(|(name, value)| (name.as_str(), *value)).collect();
    let limits = resolve_keeper_limits(&channel_borrowed, &view_limits).map_err(limit_error)?;
    let grant_roots = grants.ok_or("--grant-roots is required")?;
    if grant_roots > view_limits.max_views_per_keeper {
        return Err("--grant-roots exceeds maxViewsPerKeeper".into());
    }
    Ok(ServeArgs {
        reservation,
        parent_pid: parent_pid.ok_or("--parent-pid is required")?,
        scope: scope.ok_or("--scope is required")?,
        runtime_root,
        ala: ala.ok_or("--ala is required")?,
        grant_roots,
        home_identity,
        orchestration_root,
        cgroup_subtree,
        limits,
        view_limits,
    })
}

fn parse_stage(rest: &[String]) -> Result<StageArgs, String> {
    // The final argv follows the first "--" that is in flag position (a value token is never a separator).
    let mut index = 0;
    let (mut marker, mut gate_fd, mut env_fd, mut domain) = (None, None, None, None);
    let (mut channel_fd, mut nofile) = (None, None);
    let mut installs: Vec<(i32, i32)> = Vec::new();
    let final_argv = loop {
        let flag = rest.get(index).ok_or("stage needs -- before the final argv")?.as_str();
        if flag == "--" {
            break rest[index + 1..].to_vec();
        }
        let value = take(rest, &mut index, flag)?;
        match flag {
            "--reservation" if marker.is_none() => marker = Some(value.to_string()),
            "--gate-fd" if gate_fd.is_none() => gate_fd = Some(fd(value)?),
            "--env-fd" if env_fd.is_none() => env_fd = Some(fd(value)?),
            "--channel-fd" if channel_fd.is_none() => channel_fd = Some(fd(value)?),
            "--domain" if domain.is_none() => {
                domain = Some(match value {
                    "orchestration" => StageDomain::Orchestration,
                    "workload" => StageDomain::Workload,
                    "endpoint" => StageDomain::Endpoint,
                    _ => return Err("bad --domain".into()),
                });
            }
            "--install" => {
                let (from, to) = value.split_once(':').ok_or("bad --install")?;
                let (from, to) = (fd(from)?, fd(to)?);
                if to > MAX_INSTALL_TARGET || from <= MAX_INSTALL_TARGET || installs.len() >= MAX_STAGE_INSTALLS
                    || installs.iter().any(|(known_from, known_to)| *known_from == from || *known_to == to)
                {
                    return Err("bad --install".into());
                }
                installs.push((from, to));
            }
            "--nofile" if nofile.is_none() => {
                nofile = Some(decimal_u64(value).filter(|limit| (1..=1_048_576).contains(limit)).ok_or("bad --nofile")?);
            }
            other => return Err(format!("unknown or repeated flag: {other}")),
        }
        index += 1;
    };
    let marker = marker.ok_or("--reservation is required")?;
    if !is_origin_id(&marker) {
        return Err("--reservation must be a 22-character base64url S1 id".into());
    }
    if final_argv.is_empty() || !final_argv[0].starts_with('/') {
        return Err("the final argv must start with an absolute program path (no PATH lookup)".into());
    }
    let gate_fd = gate_fd.ok_or("--gate-fd is required")?;
    let private = [Some(gate_fd), env_fd, channel_fd];
    let private: Vec<i32> = private.into_iter().flatten().collect();
    if private.iter().enumerate().any(|(index, fd)| *fd <= MAX_INSTALL_TARGET || private[..index].contains(fd))
        || installs.iter().any(|(from, _)| private.contains(from))
    {
        return Err("stage descriptors must be distinct and above the final slots".into());
    }
    Ok(StageArgs { marker, gate_fd, env_fd, channel_fd, domain: domain.unwrap_or(StageDomain::Workload), installs, nofile, argv: final_argv })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    const MARKER_DASH: &str = "-_8AAAAAAAAAAAAAAAAAAA";

    fn serve() -> Vec<String> {
        args(&["serve", "--protocol", "1", "--reservation", MARKER_DASH, "--parent-pid", "4321", "--scope", "terminal", "--runtime-root", "/run/robo-work",
            "--ala", "0", "--grant-roots", "0", "--home-identity", "2049:77", "--channel-limit", "maxInFlight=16", "--view-limit", "rootLeaseTtlMs=3000"])
    }

    #[test]
    fn serve_accepts_a_dash_leading_marker_in_value_position() {
        let Command::Serve(parsed) = parse(&serve()).unwrap() else { panic!() };
        assert_eq!(parsed.reservation, MARKER_DASH);
        assert_eq!(parsed.parent_pid, 4321);
        assert_eq!(parsed.home_slot(), Some(8), "g = 0: HOME at slot 8 (M-2)");
        assert_eq!(parsed.declared_fds(), vec![0, 1, 2, 3, 8]);
        assert_eq!(parsed.scope.mount_scope(), Scope::Execution);
    }

    #[test]
    fn serve_layout_with_ala_and_grants() {
        let mut items = serve();
        items[12] = "1".into(); // --ala 1
        items[14] = "2".into(); // --grant-roots 2
        let Command::Serve(parsed) = parse(&items).unwrap() else { panic!() };
        assert_eq!(parsed.declared_fds(), vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn serve_refusals() {
        for (index, bad) in [(2, "2"), (4, "abcdef0123456789"), (4, "AAECAwQFBgcICQoLDA0ODx"), (6, "0"), (8, "batch"), (10, "/run/x/"), (12, "2"), (14, "9")] {
            let mut items = serve();
            items[index] = bad.to_string();
            assert!(parse(&items).is_err(), "{index} {bad}");
        }
        for removed in [["--channel-fd", "3"], ["--file-server", "/x"], ["--supervisor-pid", "1"]] {
            let mut items = serve();
            items.extend(args(&removed));
            assert!(parse(&items).is_err(), "{removed:?} is not part of v1");
        }
        let mut items = serve();
        items.extend(args(&["--channel-limit", "maxFrameBytes=65536"]));
        assert!(parse(&items).is_err(), "relationship check");
        let mut equals = serve();
        equals[3] = format!("--reservation={MARKER_DASH}");
        equals.remove(4);
        assert!(parse(&equals).is_err());
    }

    #[test]
    fn stage_marker_and_separator() {
        let good = args(&["stage", "--reservation", MARKER_DASH, "--gate-fd", "5", "--", "/usr/bin/node", "--", "fixture.mjs"]);
        let Command::Stage(stage) = parse(&good).unwrap() else { panic!() };
        assert_eq!(stage.marker, MARKER_DASH);
        assert_eq!(stage.argv, args(&["/usr/bin/node", "--", "fixture.mjs"]));
        assert!(parse(&args(&["stage", "--reservation", MARKER_DASH, "--gate-fd", "5", "--", "node"])).is_err());
        assert!(parse(&args(&["stage", "--reservation", "--", "--gate-fd", "5", "--", "/bin/true"])).is_err());
    }

    #[test]
    fn stage_private_channel_installs_and_descriptor_budget() {
        let base = ["stage", "--reservation", MARKER_DASH, "--channel-fd", "10", "--gate-fd", "11", "--env-fd", "12", "--domain", "endpoint"];
        let with = |extra: &[&str]| {
            let mut items: Vec<&str> = base.to_vec();
            items.extend_from_slice(extra);
            items.extend_from_slice(&["--", "/usr/local/bin/node", "main.mjs"]);
            parse(&args(&items))
        };
        let Command::Stage(stage) = with(&["--install", "13:3", "--install", "14:4", "--nofile", "256"]).unwrap() else { panic!() };
        assert_eq!((stage.channel_fd, stage.gate_fd, stage.env_fd), (Some(10), 11, Some(12)));
        assert_eq!(stage.domain, StageDomain::Endpoint);
        assert_eq!(stage.installs, vec![(13, 3), (14, 4)]);
        assert_eq!(stage.nofile, Some(256));
        for bad in [&["--install", "13:5"][..], &["--install", "3:4"], &["--install", "13:3", "--install", "13:4"], &["--install", "13:3", "--install", "14:3"],
            &["--install", "10:3"], &["--install", "13"], &["--nofile", "0"], &["--nofile", "1048577"], &["--nofile", "-1"],
            &["--install", "13:0", "--install", "14:1", "--install", "15:2", "--install", "16:3", "--install", "17:4"]] {
            assert!(with(bad).is_err(), "{bad:?}");
        }
        // Private descriptors must sit above the final slots and be distinct.
        assert!(parse(&args(&["stage", "--reservation", MARKER_DASH, "--channel-fd", "4", "--gate-fd", "11", "--", "/x"])).is_err());
        assert!(parse(&args(&["stage", "--reservation", MARKER_DASH, "--channel-fd", "11", "--gate-fd", "11", "--", "/x"])).is_err());
        assert!(parse(&args(&["stage", "--reservation", MARKER_DASH, "--channel-fd", "10", "--channel-fd", "12", "--gate-fd", "11", "--", "/x"])).is_err());
    }

    #[test]
    fn cgroup_subtree_argument_binds_identity_and_bounds_derived_paths() {
        let parse_bound = |value: &str| {
            let mut items = serve();
            items.extend(args(&["--cgroup-subtree", value]));
            parse(&items)
        };
        let Command::Serve(parsed) = parse_bound("1:2:/a:b").unwrap() else { panic!() };
        assert_eq!(parsed.cgroup_subtree, Some(CgroupSubtree { path: "/a:b".into(), dev: 1, ino: 2 }));
        assert!(parse_bound("18446744073709551615:18446744073709551615:/cg").is_ok());
        for size in [989, 990, 1024, 1025] {
            let path = format!("/{}", "a".repeat(size - 1));
            assert_eq!(parse_bound(&format!("1:2:{path}")).is_ok(), size == 989, "{size} bytes");
        }
        for value in ["", "1:2", "1:/cg", "1:2:cg", "1:2:/", "1:2:/cg/", "1:2:/cg//x", "1:2:/cg/../x", "1:2:/cg/./x", "1:2:/cg\0x",
            ":2:/cg", "1::/cg", "-1:2:/cg", "1:+2:/cg", "1.0:2:/cg", "18446744073709551616:2:/cg", "1:18446744073709551616:/cg"] {
            assert!(parse_bound(value).is_err(), "{value:?}");
        }
        let mut duplicate = serve();
        duplicate.extend(args(&["--cgroup-subtree", "1:2:/cg", "--cgroup-subtree", "1:2:/cg"]));
        assert!(parse(&duplicate).is_err());
        let mut equals = serve();
        equals.extend(args(&["--cgroup-subtree=1:2:/cg", "ignored"]));
        assert!(parse(&equals).is_err(), "equality form is not a v1 flag");
        let Command::Serve(plain) = parse(&serve()).unwrap() else { panic!() };
        assert_eq!(plain.cgroup_subtree, None);
    }
}

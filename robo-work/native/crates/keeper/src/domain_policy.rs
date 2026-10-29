//! Launch-policy types and pure validation. No production image closure is compiled into this foundation.
//! A missing policy always refuses. Synthetic host facts never qualify an image or authorize launch.

use std::collections::BTreeMap;
use std::fs::File;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;

use crate::core::OsError;
use crate::launch::ImageIdentity;
use crate::stage::{MAX_ENV_BYTES, parse_env_block};
use rw_proto::keeper_frames::ErrorKind;
use rw_proto::keeper_limits::KeeperLimits;

pub const NODE: &str = "/usr/local/bin/node";
pub const KEEPER: &str = "/usr/local/libexec/robo-work/keeper";
pub const ENDPOINT_MAIN: &str = "/opt/robo-work/server/execution/providerEndpointMain.mjs";
pub const ENDPOINT_HEAP_MIB: u32 = 48;
pub const ENDPOINT_NOFILE: u64 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role { Endpoint, Orchestration, Workload, Terminal }

#[derive(Clone, Debug)]
pub struct PinnedFile {
    pub path: String,
    pub sha256: [u8; 32],
    pub identity: ImageIdentity,
    /// Resolved image regular-file target, never a directory bind or unresolved symlink.
    pub regular: bool,
}

#[derive(Clone, Debug)]
pub struct Executable {
    pub file: PinnedFile,
    pub direct_elf: bool,
    pub closure_complete: bool,
    /// Exact loader and recursive DT_NEEDED closure resolved from the pinned image, empty only for static ELF.
    pub runtime_files: Vec<PinnedFile>,
}

#[derive(Clone, Debug)]
pub struct ImagePolicy {
    pub node: Executable,
    pub keeper: Executable,
    pub bwrap: Executable,
    pub inventory: BTreeMap<String, Executable>,
    pub code: BTreeMap<Role, Vec<PinnedFile>>,
    pub endpoint_heap_mib: u32,
    pub endpoint_nofile: u64,
}

fn normalized(path: &str) -> bool {
    rw_proto::provider_schema::is_path(Some(&rw_proto::json::text(path)), 4096)
}

impl PinnedFile {
    fn valid(&self) -> bool { self.regular && normalized(&self.path) && self.sha256 != [0; 32] }
}
impl Executable {
    fn valid(&self) -> bool {
        self.file.valid() && self.direct_elf && self.closure_complete && self.runtime_files.iter().all(PinnedFile::valid)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MountSource { ImageFile(String, ImageIdentity, [u8; 32]), Home(ImageIdentity), RuntimeTemp(ImageIdentity), PrivateTmp, PrivateProc, PrivateDevpts }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount { pub source: MountSource, pub target: String, pub read_only: bool }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescriptorSource { Stdio(u8), EndpointChannel, ProviderEndpoint, ProviderOrchestration, Control(u8), PtySlave }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DescriptorMap { pub source: DescriptorSource, pub target: u8 }

#[derive(Clone, Debug)]
pub struct StartupFacts {
    pub runtime_temp: ImageIdentity,
    pub home: Option<ImageIdentity>,
    pub orchestration_root: Option<String>,
    pub ala_channels: bool,
}

pub struct DomainRequest {
    pub role: Role,
    pub executable: String,
    pub script: Option<String>,
    pub args: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub cwd: String,
    pub grants: usize,
    pub exclusions: usize,
    pub egress: bool,
    pub private_proc: bool,
    pub committed_netns: bool,
    pub committed_pty: bool,
}

pub struct DomainPlan {
    pub role: Role,
    pub cwd: String,
    pub executable: Executable,
    pub stage: Executable,
    pub bwrap: Executable,
    pub argv: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub setup_environment: Vec<(String, String)>,
    pub mounts: Vec<Mount>,
    pub descriptors: Vec<DescriptorMap>,
    pub endpoint_nofile: Option<u64>,
    pub private_loopback: bool,
}

/// The policy is an internal image-build input, never a wire request or a runtime-selectable file.
pub fn build_domain_plan(policy: Option<&ImagePolicy>, startup: &StartupFacts, request: &DomainRequest) -> Result<DomainPlan, OsError> {
    let refused = |code| (ErrorKind::Refused, code);
    let setup = (ErrorKind::Failure, "setup_failed");
    let policy = policy.ok_or(setup)?;
    if !policy.node.valid() || !policy.keeper.valid() || !policy.bwrap.valid()
        || policy.node.file.path != NODE || policy.keeper.file.path != KEEPER || policy.bwrap.file.path != crate::bwrap::BWRAP
        || policy.endpoint_heap_mib != ENDPOINT_HEAP_MIB || policy.endpoint_nofile != ENDPOINT_NOFILE {
        return Err(setup);
    }
    if request.grants != 0 || request.exclusions != 0 || request.egress || !request.private_proc { return Err(setup); }
    if !normalized(&request.cwd) || request.args.len() > 256 || request.args.iter().any(|arg| arg.contains('\0'))
        || request.args.iter().map(String::len).sum::<usize>() > 256 * 1024 { return Err(setup); }
    let environment: Vec<u8> = request.environment.iter().flat_map(|(name, value)| format!("{name}={value}\0").into_bytes()).collect();
    if environment.len() > MAX_ENV_BYTES || parse_env_block(&environment).is_err()
        || request.environment.iter().any(|(name, value)| name.contains('=') || name.contains('\0') || value.contains('\0')) { return Err(setup); }
    let executable = match request.role {
        Role::Endpoint | Role::Orchestration => &policy.node,
        Role::Workload | Role::Terminal => policy.inventory.get(&request.executable).ok_or(refused("inventory_miss"))?,
    };
    if !executable.valid() || executable.file.identity == policy.keeper.file.identity { return Err(setup); }
    let mut files: Vec<&PinnedFile> = vec![&executable.file, &policy.keeper.file];
    files.extend(executable.runtime_files.iter());
    files.extend(policy.keeper.runtime_files.iter());
    let mut argv = vec![executable.file.path.clone()];
    if matches!(request.role, Role::Endpoint | Role::Orchestration) {
        if !startup.ala_channels { return Err(setup); }
        let code = policy.code.get(&request.role).filter(|files| !files.is_empty() && files.iter().all(PinnedFile::valid)).ok_or(setup)?;
        files.extend(code.iter());
        let script = if request.role == Role::Endpoint {
            argv.push(format!("--max-old-space-size={ENDPOINT_HEAP_MIB}"));
            ENDPOINT_MAIN
        } else {
            let root = startup.orchestration_root.as_deref().filter(|root| normalized(root)).ok_or(setup)?;
            let script = request.script.as_deref().filter(|script| normalized(script) && script.strip_prefix(root).is_some_and(|tail| tail.starts_with('/'))).ok_or(setup)?;
            script
        };
        if !code.iter().any(|file| file.path == script) { return Err(setup); }
        argv.push(script.into());
    }
    argv.extend(request.args.iter().cloned());
    let mut mounts = Vec::new();
    for file in files {
        if mounts.iter().any(|mount: &Mount| mount.target == file.path && mount.source != MountSource::ImageFile(file.path.clone(), file.identity, file.sha256)) { return Err(setup); }
        if !mounts.iter().any(|mount: &Mount| mount.target == file.path) {
            mounts.push(Mount { source: MountSource::ImageFile(file.path.clone(), file.identity, file.sha256), target: file.path.clone(), read_only: true });
        }
    }
    mounts.push(Mount { source: MountSource::PrivateProc, target: "/proc".into(), read_only: false });
    let workload = matches!(request.role, Role::Workload | Role::Terminal);
    if request.role != Role::Orchestration && !request.committed_netns { return Err(refused("resource_not_committed")); }
    if workload {
        mounts.push(Mount { source: MountSource::Home(startup.home.ok_or(setup)?), target: "/home/robot".into(), read_only: false });
        mounts.push(Mount { source: MountSource::RuntimeTemp(startup.runtime_temp), target: "/tmp".into(), read_only: false });
    } else {
        mounts.push(Mount { source: MountSource::PrivateTmp, target: "/tmp".into(), read_only: false });
    }
    let mut descriptors: Vec<DescriptorMap> = (0..=2).map(|target| DescriptorMap { source: DescriptorSource::Stdio(target), target }).collect();
    match request.role {
        Role::Endpoint => descriptors.extend([DescriptorMap { source: DescriptorSource::ProviderEndpoint, target: 3 }, DescriptorMap { source: DescriptorSource::EndpointChannel, target: 4 }]),
        Role::Orchestration => {
            descriptors = (0..=2).map(|target| DescriptorMap { source: DescriptorSource::Control(target), target }).collect();
            descriptors.push(DescriptorMap { source: DescriptorSource::ProviderOrchestration, target: 3 });
        }
        Role::Terminal => {
            if !request.committed_pty { return Err(refused("resource_not_committed")); }
            mounts.push(Mount { source: MountSource::PrivateDevpts, target: "/dev/pts".into(), read_only: false });
            descriptors = (0..=2).map(|target| DescriptorMap { source: DescriptorSource::PtySlave, target }).collect();
        }
        Role::Workload => {}
    }
    Ok(DomainPlan { role: request.role, cwd: request.cwd.clone(), executable: executable.clone(), stage: policy.keeper.clone(), bwrap: policy.bwrap.clone(), argv, environment: request.environment.clone(), setup_environment: Vec::new(),
        mounts, descriptors, endpoint_nofile: (request.role == Role::Endpoint).then_some(ENDPOINT_NOFILE), private_loopback: request.role == Role::Orchestration })
}

/// An already opened directory whose descriptor metadata agrees with the startup identity. No raw-fd constructor.
pub struct HeldDirectory { pub fd: OwnedFd, pub identity: ImageIdentity }
impl HeldDirectory {
    pub fn validate(fd: OwnedFd, expected: ImageIdentity) -> std::io::Result<Self> {
        let file = File::from(fd);
        let stat = file.metadata()?;
        if !stat.is_dir() || (stat.dev(), stat.ino()) != expected { return Err(std::io::Error::other("startup_identity_mismatch")); }
        Ok(Self { fd: file.into(), identity: expected })
    }
}

/// Consumed once by the future Linux construction adapter. Keeper fd 3 has no field and cannot be handed off here.
/// Option::take transfers custody once; drops close all untransferred channels and partial acquisitions.
pub struct StartupCustody {
    pub runtime: HeldDirectory,
    pub home: Option<HeldDirectory>,
    pub orchestration: Option<HeldDirectory>,
    pub endpoint: Option<OwnedFd>,
    pub control: Option<[OwnedFd; 3]>,
    pub provider: Option<[OwnedFd; 2]>,
    pub limits: KeeperLimits,
}

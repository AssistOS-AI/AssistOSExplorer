use rw_keeper::domain_policy::*;
use rw_proto::keeper_frames::ErrorKind;
use std::collections::BTreeMap;

fn file(path: &str, ino: u64) -> PinnedFile { PinnedFile { path: path.into(), sha256: [1; 32], identity: (1, ino), regular: true } }
fn executable(path: &str, ino: u64) -> Executable {
    Executable { file: file(path, ino), direct_elf: true, closure_complete: true, runtime_files: vec![file("/synthetic/loader", 80)] }
}
fn policy() -> ImagePolicy {
    // Synthetic host model only, never a compiled or deployable runtime-policy artifact.
    ImagePolicy { node: executable(NODE, 1), keeper: executable(KEEPER, 2), bwrap: executable("/usr/bin/bwrap", 3),
        inventory: BTreeMap::from([("node".into(), executable(NODE, 1)), ("sh".into(), executable("/synthetic/shell", 4))]),
        code: BTreeMap::from([(Role::Endpoint, vec![file(ENDPOINT_MAIN, 10)]), (Role::Orchestration, vec![file("/fixture/start.mjs", 11)])]),
        endpoint_heap_mib: 48, endpoint_nofile: 256 }
}
fn startup() -> StartupFacts { StartupFacts { runtime_temp: (2, 1), home: Some((2, 2)), orchestration_root: Some("/fixture".into()), ala_channels: true } }
fn request(role: Role) -> DomainRequest {
    DomainRequest { role, executable: "node".into(), script: Some("/fixture/start.mjs".into()), args: vec!["--version".into()], environment: vec![("LANG".into(), "C".into())],
        cwd: "/tmp".into(), grants: 0, exclusions: 0, egress: false, private_proc: true, committed_netns: true, committed_pty: true }
}

#[test]
fn each_role_has_exact_final_descriptors_and_no_construction_leaks() {
    for (role, slots) in [(Role::Endpoint, vec![0, 1, 2, 3, 4]), (Role::Orchestration, vec![0, 1, 2, 3]), (Role::Workload, vec![0, 1, 2]), (Role::Terminal, vec![0, 1, 2])] {
        let plan = build_domain_plan(Some(&policy()), &startup(), &request(role)).unwrap();
        assert_eq!(plan.descriptors.iter().map(|map| map.target).collect::<Vec<_>>(), slots);
        assert!(plan.setup_environment.is_empty());
        let home = plan.mounts.iter().any(|mount| matches!(mount.source, MountSource::Home(_)));
        assert_eq!(home, matches!(role, Role::Workload | Role::Terminal));
        assert!(plan.mounts.iter().filter(|mount| matches!(mount.source, MountSource::ImageFile(..))).all(|mount| mount.read_only));
        assert!(!plan.mounts.iter().any(|mount| ["/usr", "/bin", "/opt", "/home"].contains(&mount.target.as_str())));
        if role == Role::Endpoint { assert_eq!(plan.endpoint_nofile, Some(256)); assert!(plan.argv.contains(&"--max-old-space-size=48".into())); }
    }
}

#[test]
fn missing_policy_closure_and_unenforced_requirements_refuse() {
    assert!(build_domain_plan(None, &startup(), &request(Role::Workload)).is_err());
    for defect in 0..5 {
        let mut policy = policy();
        match defect { 0 => policy.node.file.sha256 = [0; 32], 1 => policy.node.closure_complete = false,
            2 => policy.node.runtime_files[0].regular = false, 3 => policy.endpoint_nofile = 257, _ => policy.keeper.direct_elf = false }
        assert!(build_domain_plan(Some(&policy), &startup(), &request(Role::Endpoint)).is_err());
    }
    for defect in 0..6 {
        let mut request = request(Role::Workload);
        match defect { 0 => request.grants = 1, 1 => request.exclusions = 1, 2 => request.egress = true,
            3 => request.private_proc = false, 4 => request.committed_netns = false, _ => request.executable = "/bin/evil".into() }
        assert!(build_domain_plan(Some(&policy()), &startup(), &request).is_err());
    }
    let mut req = request(Role::Workload); req.executable = "unknown".into();
    assert!(matches!(build_domain_plan(Some(&policy()), &startup(), &req), Err((ErrorKind::Refused, "inventory_miss"))));
    let mut req = request(Role::Orchestration); req.script = Some("/fixture-other/start.mjs".into());
    assert!(build_domain_plan(Some(&policy()), &startup(), &req).is_err());
}

#[test]
fn environment_bound_and_startup_directory_custody_are_checked() {
    let mut req = request(Role::Workload);
    req.environment = vec![("A".into(), "x".repeat(65533))];
    assert!(build_domain_plan(Some(&policy()), &startup(), &req).is_ok());
    req.environment[0].1.push('x');
    assert!(build_domain_plan(Some(&policy()), &startup(), &req).is_err());
    req.environment = vec![("A".into(), "one".into()), ("A".into(), "two".into())];
    assert!(build_domain_plan(Some(&policy()), &startup(), &req).is_err());
    use std::os::unix::fs::MetadataExt;
    let file = std::fs::File::open(std::env::temp_dir()).unwrap();
    let stat = file.metadata().unwrap();
    let held = HeldDirectory::validate(file.into(), (stat.dev(), stat.ino())).unwrap();
    assert_eq!(held.identity, (stat.dev(), stat.ino()));
    let wrong = std::fs::File::open(std::env::temp_dir()).unwrap();
    assert!(HeldDirectory::validate(wrong.into(), (stat.dev(), stat.ino().wrapping_add(1))).is_err());
}

#[test]
fn startup_channels_transfer_once_and_partial_ownership_closes_on_drop() {
    use std::io::Read;
    use std::os::unix::{fs::MetadataExt, net::UnixStream};
    use rw_proto::keeper_limits::KeeperLimits;
    let directory = std::fs::File::open(std::env::temp_dir()).unwrap();
    let info = directory.metadata().unwrap();
    let (endpoint, mut endpoint_peer) = UnixStream::pair().unwrap();
    let controls: Vec<_> = (0..3).map(|_| UnixStream::pair().unwrap()).collect();
    let (control, mut peers): (Vec<_>, Vec<_>) = controls.into_iter().map(|(fd, peer)| (std::os::fd::OwnedFd::from(fd), peer)).unzip();
    let mut custody = StartupCustody { runtime: HeldDirectory::validate(directory.into(), (info.dev(), info.ino())).unwrap(), home: None,
        orchestration: None, endpoint: Some(endpoint.into()), control: Some(control.try_into().unwrap()), provider: None, limits: KeeperLimits::default() };
    let transferred = custody.endpoint.take().unwrap();
    assert!(custody.endpoint.take().is_none());
    drop(custody);
    for peer in &mut peers { peer.set_nonblocking(true).unwrap(); assert_eq!(peer.read(&mut [0]).unwrap(), 0); }
    endpoint_peer.set_nonblocking(true).unwrap();
    assert_eq!(endpoint_peer.read(&mut [0]).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    drop(transferred);
    assert_eq!(endpoint_peer.read(&mut [0]).unwrap(), 0);
}

//! Keeper-side conformance against the shared vectors (`rw-proto/tests/vectors/keeper-wire.v1.json`, the S4 r9 byte
//! copy): the argv the Node client spawns the keeper with parses into the declared layout, every marker travels as the
//! element after `--reservation`, and `/proc/<pid>/stat` lines (hostile `comm` included) parse to the same identity.

use rw_keeper::args::{Command, KeeperScope, parse};
use rw_keeper::procfs::parse_stat;
use rw_proto::json::{self, Value};

fn vectors() -> Value {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../proto/tests/vectors/keeper-wire.v1.json")).unwrap();
    json::parse(&bytes).unwrap()
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        other => panic!("{key}: {other:?}"),
    }
}

#[test]
fn client_argv_parses_into_the_declared_layout() {
    let data = vectors();
    let names: Vec<String> = list(data.get("limits").unwrap(), "channelLimitNames").iter().map(|name| name.as_str().unwrap().to_string()).collect();
    let cases = list(&data, "argv");
    assert_eq!(cases.len(), 3);
    for case in cases {
        let name = case.get("name").and_then(Value::as_str).unwrap();
        let argv: Vec<String> = list(case, "argv").iter().map(|item| item.as_str().unwrap().to_string()).collect();
        let Command::Serve(serve) = parse(&argv).unwrap_or_else(|error| panic!("{name}: {error}")) else { panic!("{name}") };
        let options = case.get("options").unwrap();
        let ala = options.get("ala").and_then(Value::as_bool).unwrap();
        let grants = options.get("grantRoots").and_then(Value::as_safe_int).unwrap();
        assert_eq!(serve.ala, ala, "{name}");
        assert_eq!(serve.grant_roots, grants, "{name}");
        assert_eq!(serve.scope, match options.get("scope").and_then(Value::as_str) { Some("terminal") => KeeperScope::Terminal, Some("gui") => KeeperScope::Gui, _ => KeeperScope::Execution }, "{name}");
        let home = options.get("homeIdentity").map(|identity| (identity.get("dev").and_then(Value::as_str).unwrap().parse::<u64>().unwrap(), identity.get("ino").and_then(Value::as_str).unwrap().parse::<u64>().unwrap()));
        assert_eq!(serve.home_identity, home, "{name}");
        assert_eq!(serve.orchestration_root.as_deref(), options.get("orchestrationRoot").and_then(Value::as_str), "{name}");
        // The declared layout of contract section 3.
        let mut fds = vec![0, 1, 2, 3];
        if ala {
            fds.extend([4, 5, 6, 7]);
        }
        fds.extend((8..8 + grants as i32).collect::<Vec<_>>());
        if home.is_some() {
            fds.push(8 + grants as i32);
        }
        assert_eq!(serve.declared_fds(), fds, "{name}");
        // Exactly the 19 channel-limit names are passed (pingIntervalMs is client-only, RK-1).
        let passed: Vec<String> = argv.windows(2).filter(|pair| pair[0] == "--channel-limit").map(|pair| pair[1].split('=').next().unwrap().to_string()).collect();
        assert_eq!(passed, names, "{name}");
        // The marker is the next element after --reservation, unchanged.
        let at = argv.iter().position(|item| item == "--reservation").unwrap();
        assert_eq!(argv[at + 1], serve.reservation, "{name}");
    }
}

#[test]
fn markers_travel_as_the_element_after_reservation() {
    let data = vectors();
    for case in list(&data, "markers") {
        let marker = case.get("resourceId").and_then(Value::as_str).unwrap();
        let fragment: Vec<&str> = list(case, "keeperArgvFragment").iter().map(|item| item.as_str().unwrap()).collect();
        assert_eq!(fragment, vec!["--reservation", marker]);
        // The keeper accepts it in that position, including a marker that starts with '-'.
        let argv: Vec<String> = ["serve", "--protocol", "1", "--reservation", marker, "--parent-pid", "4000", "--scope", "execution", "--runtime-root", "/run/robo-work/runtime", "--ala", "0", "--grant-roots", "0"]
            .iter().map(|item| item.to_string()).collect();
        let Command::Serve(serve) = parse(&argv).unwrap() else { panic!() };
        assert_eq!(serve.reservation, marker);
    }
}

#[test]
fn proc_stat_lines_parse_identically() {
    let data = vectors();
    let cases = list(&data, "procStat");
    assert_eq!(cases.len(), 5);
    for case in cases {
        let line = case.get("line").and_then(Value::as_str).unwrap();
        let parsed = parse_stat(line);
        if case.get("parsed") == Some(&Value::Null) {
            assert_eq!(parsed, None, "{line}");
            continue;
        }
        let record = parsed.unwrap_or_else(|| panic!("{line}"));
        assert_eq!(Some(record.pid), case.get("pid").and_then(Value::as_safe_int), "{line}");
        assert_eq!(Some(record.ppid), case.get("ppid").and_then(Value::as_safe_int), "{line}");
        assert_eq!(Some(record.start_time.to_string().as_str()), case.get("startTime").and_then(Value::as_str), "{line}");
    }
}

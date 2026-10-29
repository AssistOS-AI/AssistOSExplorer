//! Conformance of the Rust keeper protocol against the shared vectors `tests/vectors/keeper-wire.v1.json` (contract §7,
//! AC-16). The file is a byte copy of the S4 r9 Node file (sha256 pinned by `s4-candidate-r9.manifest.sha256`, checked by
//! gate G09) and is never edited. Keeper-side argv, marker and `/proc` vectors are in `rw-keeper`'s
//! `tests/keeper_wire_vectors_keeper.rs`.

use rw_proto::frame::encode_frame;
use rw_proto::json::{self, Value};
use rw_proto::keeper_frames::{
    Admission, ErrorKind, RequestContext, Verdict, WireIdentity, base64_decode, decode_request, error_reply, handle_for_resource_id, hello_event,
    parse_seq, wire_code,
};
use rw_proto::keeper_limits::{
    CLIENT_ONLY_LIMITS, ENDPOINT_LIMIT_DEFAULTS, EndpointLimits, KeeperLimitError, KeeperLimits, hello_limits, pty_frame_cap, resolve_keeper_limits,
};
use rw_proto::limits::ViewLimits;
use rw_proto::mount_frames::{self, MountContext, MountRequest, MountedIdentity, Scope, lease_state_reply, mount_ok_reply};

fn vectors() -> Value {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/keeper-wire.v1.json")).unwrap();
    json::parse(&bytes).expect("the vectors parse with the strict parser")
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        other => panic!("{key}: {other:?}"),
    }
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn verdict_text(verdict: &Value) -> String {
    match verdict {
        Value::String(text) => text.clone(),
        other => json::stringify(other),
    }
}

#[test]
fn header_and_limits() {
    let data = vectors();
    assert_eq!(data.get("schema").and_then(Value::as_str), Some("robo-work.keeper-wire/1"));
    assert_eq!(data.get("protocol").and_then(Value::as_str), Some(rw_proto::keeper_frames::PROTOCOL));
    assert_eq!(data.get("version").and_then(Value::as_safe_int), Some(rw_proto::keeper_frames::VERSION));
    let limits = data.get("limits").unwrap();
    let keeper = KeeperLimits::default();
    let names: Vec<&str> = list(limits, "channelLimitNames").iter().map(s).collect();
    assert_eq!(names.len(), 19, "--channel-limit carries the 19 contract names (RK-1)");
    let mut native: Vec<&str> = KeeperLimits::NAMES.to_vec();
    native.sort_unstable();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(native, sorted, "the keeper resolves exactly the channel-limit names");
    for (name, value) in keeper.entries() {
        assert_eq!(limits.get("keeper").unwrap().get(name).and_then(Value::as_safe_int), Some(value), "{name}");
    }
    let client_only: Vec<&str> = list(limits, "clientOnly").iter().map(s).collect();
    assert_eq!(client_only, CLIENT_ONLY_LIMITS);
    for name in &client_only {
        assert_eq!(resolve_keeper_limits(&[(name, 5000)], &ViewLimits::default()), Err(KeeperLimitError::Unknown(name.to_string())), "{name} is never sent to the keeper");
    }
    // hello.limits: exactly the vector's keys, in its order, with its values (RK-1).
    let hello = hello_limits(&keeper, &ViewLimits::default());
    assert_eq!(json::stringify(&hello), json::stringify(limits.get("hello").unwrap()));
    let hello_keys: Vec<String> = hello.as_object().unwrap().iter().map(|(key, _)| key.clone()).collect();
    let want: Vec<String> = list(limits, "helloKeys").iter().map(|key| s(key).to_string()).collect();
    assert_eq!(hello_keys, want);
    // View and endpoint limits.
    for (name, value) in ViewLimits::default().entries() {
        assert_eq!(limits.get("view").unwrap().get(name).and_then(Value::as_safe_int), Some(value), "{name}");
    }
    let endpoint = limits.get("endpoint").unwrap().as_object().unwrap();
    assert_eq!(endpoint.len(), ENDPOINT_LIMIT_DEFAULTS.len());
    for ((name, value), (native_name, native_value)) in endpoint.iter().zip(ENDPOINT_LIMIT_DEFAULTS) {
        assert_eq!((name.as_str(), value.as_safe_int()), (*native_name, Some(*native_value)));
    }
    let derived = limits.get("derived").unwrap();
    assert_eq!(derived.get("ptyFrameCapBytes").and_then(Value::as_safe_int), Some(pty_frame_cap(&keeper)));
    assert_eq!(derived.get("ordinaryInFlight").and_then(Value::as_safe_int), Some(keeper.max_in_flight - keeper.reserved_in_flight));
    assert_eq!(derived.get("minimumOutboundBytes").and_then(Value::as_safe_int), Some(456_024));
}

#[test]
fn encode_is_byte_identical() {
    let data = vectors();
    let cases = list(&data, "encode");
    assert_eq!(cases.len(), 7);
    for case in cases {
        let frame = encode_frame(case.get("value").unwrap(), 655_360).unwrap();
        let hex: String = frame.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, s(case.get("frameHex").unwrap()), "{}", s(case.get("name").unwrap()));
    }
}

fn mount_context(value: &Value) -> (MountContext, Vec<MountRequest>) {
    let context = MountContext {
        scope: if value.get("scope").and_then(Value::as_str) == Some("gui") { Scope::Gui } else { Scope::Execution },
        runtime_root: s(value.get("runtimeRoot").unwrap()).to_string(),
        reservation_id: s(value.get("reservationId").unwrap()).to_string(),
        grant_count: value.get("grantCount").and_then(Value::as_safe_int).unwrap(),
    };
    // Prior requests of the set, as the validator would have accepted them (grantCount 8 admits any slot).
    let prior_context = MountContext { grant_count: 8, ..context.clone() };
    let prior = list(value, "prior").iter().map(|frame| mount_frames::validate_mount_request(frame, &prior_context, &ViewLimits::default()).unwrap()).collect();
    (context, prior)
}

#[test]
fn request_verdicts_match_node() {
    let data = vectors();
    let base = data.get("requestContext").unwrap();
    let (keeper, view, endpoint) = (KeeperLimits::default(), ViewLimits::default(), EndpointLimits::default());
    let cases = list(&data, "requests");
    assert_eq!(cases.len(), 82);
    let mut failures = Vec::new();
    for case in cases {
        let name = s(case.get("name").unwrap());
        let mount_value = case.get("context").and_then(|context| context.get("mount")).unwrap_or(base.get("mount").unwrap());
        let (mount, prior) = mount_context(mount_value);
        let context = RequestContext {
            limits: &keeper, view: &view, endpoint: &endpoint,
            runtime_root: base.get("runtimeRoot").and_then(Value::as_str),
            keeper_reservation: s(base.get("keeperReservation").unwrap()),
            cgroup_subtree: case.get("context").and_then(|context| context.get("cgroupSubtree")).or_else(|| base.get("cgroupSubtree")).and_then(Value::as_str),
            orchestration_root: base.get("orchestrationRoot").and_then(Value::as_str),
            mount: Some(&mount), prior: &prior,
        };
        let got = match decode_request(case.get("frame").unwrap(), &context) {
            Verdict::Ok(_) => "ok".to_string(),
            Verdict::Refused { code, .. } => format!(r#"{{"refused":"{code}"}}"#),
            Verdict::Violation(code) => format!(r#"{{"violation":"{code}"}}"#),
        };
        let want = verdict_text(case.get("keeperVerdict").unwrap());
        if got != want {
            failures.push(format!("{name}: got {got}, want {want}"));
        }
    }
    assert!(failures.is_empty(), "{} request verdicts differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn admission_matches_create_keeper_admission() {
    let data = vectors();
    let limits = KeeperLimits::default();
    let cases = list(&data, "admission");
    assert_eq!(cases.len(), 13, "R3 adds lease admission independent of mount slots and bounded per grant");
    for case in cases {
        let name = s(case.get("name").unwrap());
        let mut admission = Admission::default();
        for step in list(case, "steps") {
            if let Some(id) = step.get("settle").and_then(Value::as_safe_int) {
                admission.settle(id);
                continue;
            }
            let frame = step.get("frame").unwrap();
            let op = s(frame.get("op").unwrap());
            let bytes = frame.get("data").and_then(Value::as_str).and_then(base64_decode).map(|data| data.len()).unwrap_or(0);
            let got = match admission.admit(frame.get("id").and_then(Value::as_safe_int).unwrap(), op, frame.get("resource").and_then(Value::as_str), bytes, frame.get("grantId").and_then(Value::as_str), &limits) {
                Ok(()) => "ok".to_string(),
                Err(code) => format!(r#"{{"violation":"{code}"}}"#),
            };
            assert_eq!(got, verdict_text(step.get("verdict").unwrap()), "{name}: {}", json::stringify(frame));
        }
    }
}

fn dec(value: &Value) -> u64 {
    s(value).parse().unwrap()
}

#[test]
fn wire_identities_are_built_identically() {
    let data = vectors();
    let cases = list(&data, "identities");
    assert_eq!(cases.len(), 8);
    for case in cases {
        let kind = s(case.get("kind").unwrap());
        let wire = case.get("wire").unwrap();
        let built = match kind {
            "keeper" => {
                // The keeper's identity is the hello pid and startTime (committed without pidNs).
                let hello = hello_event(wire.get("pid").and_then(Value::as_safe_int).unwrap(), dec(wire.get("startTime").unwrap()), "AAECAwQFBgcICQoLDA0ODw", json::obj(vec![]));
                json::obj(vec![("pid", hello.get("pid").unwrap().clone()), ("startTime", hello.get("startTime").unwrap().clone())])
            }
            "endpoint" | "process-tree" => WireIdentity::Process { pid: wire.get("pid").and_then(Value::as_safe_int).unwrap(), start_time: dec(wire.get("startTime").unwrap()), pid_ns: dec(wire.get("pidNs").unwrap()) }.to_value(),
            "netns" => WireIdentity::Netns { net_ns: dec(wire.get("netNs").unwrap()) }.to_value(),
            "runtime-dir" => WireIdentity::RuntimeDir { path: s(wire.get("path").unwrap()).into(), dev: dec(wire.get("dev").unwrap()), ino: dec(wire.get("ino").unwrap()) }.to_value(),
            "cgroup" => WireIdentity::Cgroup { path: s(wire.get("path").unwrap()).into(), cgroup_id: dec(wire.get("cgroupId").unwrap()) }.to_value(),
            "pty" => WireIdentity::Pty { pty: s(wire.get("pty").unwrap()).into(), devpts_dev: dec(wire.get("devptsDev").unwrap()), index: wire.get("index").and_then(Value::as_safe_int).unwrap() }.to_value(),
            "mount" => {
                let (mount, server) = (wire.get("mount").unwrap(), wire.get("fileServer").unwrap());
                let identity = MountedIdentity {
                    resource: s(wire.get("resource").unwrap()).into(), mount_id: mount.get("mountId").and_then(Value::as_safe_int).unwrap(),
                    mountpoint: s(mount.get("mountpoint").unwrap()).into(), mount_namespace_inode: dec(mount.get("mountNamespaceInode").unwrap()),
                    server_pid: server.get("pid").and_then(Value::as_safe_int).unwrap(), server_start_time: dec(server.get("startTime").unwrap()),
                    server_pid_namespace_inode: dec(server.get("pidNamespaceInode").unwrap()),
                };
                mount_ok_reply(1, &identity).get("value").unwrap().clone()
            }
            other => panic!("unknown identity kind {other}"),
        };
        assert_eq!(json::stringify(&built), json::stringify(wire), "{kind}");
    }
}

#[test]
fn markers_map_to_handles() {
    let data = vectors();
    for case in list(&data, "markers") {
        let resource = s(case.get("resourceId").unwrap());
        assert_eq!(handle_for_resource_id(resource).as_deref(), Some(s(case.get("wireResource").unwrap())), "{resource}");
    }
}

#[test]
fn base64_and_sequences() {
    let data = vectors();
    for case in list(&data, "base64") {
        let text = s(case.get("text").unwrap());
        let max = case.get("maxBytes").and_then(Value::as_safe_int).unwrap() as usize;
        let got = base64_decode(text).filter(|bytes| !bytes.is_empty() && bytes.len() <= max);
        let want = case.get("bytes").and_then(Value::as_str);
        assert_eq!(got.is_some(), case.get("canonical") == Some(&Value::Bool(true)), "{text:?}");
        assert_eq!(got.map(|bytes| bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()), want.map(str::to_string), "{text:?}");
    }
    for case in list(&data, "sequences") {
        let text = s(case.get("text").unwrap());
        assert_eq!(parse_seq(text).is_some(), case.get("canonical") == Some(&Value::Bool(true)), "{text:?}");
    }
}

#[test]
fn wire_codes_match() {
    let data = vectors();
    let cases = list(&data, "wireCodes");
    assert_eq!(cases.len(), 18);
    for case in cases {
        assert_eq!(wire_code(s(case.get("frozen").unwrap())), s(case.get("wire").unwrap()));
    }
}

#[test]
fn keeper_built_events_equal_the_accepted_event_vectors() {
    // Every event the keeper emits, rebuilt from its vector fields, is byte-identical to an accepted vector frame.
    let data = vectors();
    let mut checked = 0;
    for case in list(&data, "events") {
        if case.get("clientVerdict").and_then(Value::as_str) != Some("ok") {
            continue;
        }
        let frame = case.get("frame").unwrap();
        let built = match s(frame.get("event").unwrap()) {
            "hello" => hello_event(frame.get("pid").and_then(Value::as_safe_int).unwrap(), dec(frame.get("startTime").unwrap()), s(frame.get("marker").unwrap()), hello_limits(&KeeperLimits::default(), &ViewLimits::default())),
            "exit" => rw_proto::keeper_frames::exit_event(s(frame.get("resource").unwrap()), frame.get("code").and_then(Value::as_safe_int), frame.get("signal").and_then(Value::as_str)),
            "pty_output" => rw_proto::keeper_frames::pty_output_event(s(frame.get("resource").unwrap()), dec(frame.get("seq").unwrap()), &base64_decode(s(frame.get("data").unwrap())).unwrap()),
            "pty_closed" => rw_proto::keeper_frames::pty_closed_event(s(frame.get("resource").unwrap())),
            other => panic!("{other}"),
        };
        assert_eq!(json::stringify(&built), json::stringify(frame), "{}", s(case.get("name").unwrap()));
        checked += 1;
    }
    assert_eq!(checked, 6, "every accepted event vector is rebuilt (r9 adds the exit after a failure commit, R2.1)");
}

#[test]
fn keeper_built_replies_equal_the_accepted_reply_vectors() {
    // Every reply the client accepts, rebuilt with the keeper's reply builders, is byte-identical.
    let data = vectors();
    let mut checked = 0;
    for case in list(&data, "replies") {
        if case.get("clientVerdict").and_then(Value::as_str) != Some("ok") {
            continue;
        }
        let (request, reply) = (case.get("request").unwrap(), case.get("reply").unwrap());
        let id = reply.get("id").and_then(Value::as_safe_int).unwrap();
        let built = if reply.get("ok") == Some(&Value::Bool(false)) {
            let kind = if reply.get("kind").and_then(Value::as_str) == Some("refused") { ErrorKind::Refused } else { ErrorKind::Failure };
            if s(request.get("op").unwrap()) == "mount_view" {
                mount_frames::refusal_reply(id, if kind == ErrorKind::Refused { mount_frames::RefusalKind::Refused } else { mount_frames::RefusalKind::Failure }, s(reply.get("error").unwrap()))
            } else {
                error_reply(id, kind, s(reply.get("error").unwrap()))
            }
        } else {
            let value = reply.get("value").unwrap();
            let rebuilt = match s(request.get("op").unwrap()) {
                "create" => {
                    let identity = value.get("identity").unwrap();
                    let wire = match s(request.get("kind").unwrap()) {
                        "runtime-dir" => WireIdentity::RuntimeDir { path: s(identity.get("path").unwrap()).into(), dev: dec(identity.get("dev").unwrap()), ino: dec(identity.get("ino").unwrap()) },
                        "netns" => WireIdentity::Netns { net_ns: dec(identity.get("netNs").unwrap()) },
                        "cgroup" => WireIdentity::Cgroup { path: s(identity.get("path").unwrap()).into(), cgroup_id: dec(identity.get("cgroupId").unwrap()) },
                        "pty" => WireIdentity::Pty { pty: s(identity.get("pty").unwrap()).into(), devpts_dev: dec(identity.get("devptsDev").unwrap()), index: identity.get("index").and_then(Value::as_safe_int).unwrap() },
                        _ => WireIdentity::Process { pid: identity.get("pid").and_then(Value::as_safe_int).unwrap(), start_time: dec(identity.get("startTime").unwrap()), pid_ns: dec(identity.get("pidNs").unwrap()) },
                    };
                    rw_proto::keeper_frames::create_value(s(value.get("resource").unwrap()), &wire)
                }
                "commit" | "stop" => rw_proto::keeper_frames::state_value(s(value.get("state").unwrap())),
                "tempdir" => json::obj(vec![("path", value.get("path").unwrap().clone())]),
                "pty_input" => rw_proto::keeper_frames::seq_value(dec(value.get("seq").unwrap())),
                "inventory" => value.clone(),
                "mount_view" => {
                    let (mount, server) = (value.get("mount").unwrap(), value.get("fileServer").unwrap());
                    let identity = MountedIdentity {
                        resource: s(value.get("resource").unwrap()).into(), mount_id: mount.get("mountId").and_then(Value::as_safe_int).unwrap(),
                        mountpoint: s(mount.get("mountpoint").unwrap()).into(), mount_namespace_inode: dec(mount.get("mountNamespaceInode").unwrap()),
                        server_pid: server.get("pid").and_then(Value::as_safe_int).unwrap(), server_start_time: dec(server.get("startTime").unwrap()),
                        server_pid_namespace_inode: dec(server.get("pidNamespaceInode").unwrap()),
                    };
                    mount_ok_reply(id, &identity).get("value").unwrap().clone()
                }
                "view_root_lease" => lease_state_reply(id, s(value.get("state").unwrap())).get("value").unwrap().clone(),
                _ => rw_proto::keeper_frames::empty(),
            };
            rw_proto::keeper_frames::ok_reply(id, rebuilt)
        };
        assert_eq!(json::stringify(&built), json::stringify(reply), "{}", s(case.get("name").unwrap()));
        if s(request.get("op").unwrap()) == "inventory" {
            // The keeper's inventory value shape: resources of {resource, kind, state} and an integer descriptor count.
            let value = reply.get("value").unwrap();
            assert_eq!(value.sorted_keys().as_deref(), Some("descriptors,resources"));
            assert!(value.get("descriptors").and_then(Value::as_safe_int).is_some(), "descriptors is an integer");
        }
        checked += 1;
    }
    assert_eq!(checked, 23, "every accepted reply vector is rebuilt (R3 adds resource_not_committed on stop)");
}

#[test]
fn commit_and_stop_sequences_are_present_and_rebuilt_byte_identically() {
    // R2.1, R2.2 (S4 r9). The keeper's behaviour against these sequences is driven through `KeeperCore` in rw-keeper's
    // `core::tests::the_keeper_emits_exactly_the_accepted_commit_and_stop_sequences`; here every frame of every
    // sequence is rebuilt with the keeper's builders.
    let data = vectors();
    for (key, count) in [("commitSequences", 3), ("stopSequences", 3)] {
        let cases = list(&data, key);
        assert_eq!(cases.len(), count, "{key}");
        for case in cases {
            let frames = list(case, "frames");
            assert_eq!(frames.len(), list(case, "verdicts").len(), "{}", s(case.get("name").unwrap()));
            for frame in frames {
                let built = if let Some(event) = frame.get("event") {
                    assert_eq!(s(event), "exit");
                    rw_proto::keeper_frames::exit_event(s(frame.get("resource").unwrap()), frame.get("code").and_then(Value::as_safe_int), frame.get("signal").and_then(Value::as_str))
                } else {
                    let id = frame.get("id").and_then(Value::as_safe_int).unwrap();
                    match frame.get("ok") {
                        Some(Value::Bool(true)) => rw_proto::keeper_frames::ok_reply(id, rw_proto::keeper_frames::state_value(s(frame.get("value").unwrap().get("state").unwrap()))),
                        _ => {
                            let kind = if s(frame.get("kind").unwrap()) == "refused" { ErrorKind::Refused } else { ErrorKind::Failure };
                            error_reply(id, kind, s(frame.get("error").unwrap()))
                        }
                    }
                };
                assert_eq!(json::stringify(&built), json::stringify(frame), "{}", s(case.get("name").unwrap()));
            }
        }
    }
}

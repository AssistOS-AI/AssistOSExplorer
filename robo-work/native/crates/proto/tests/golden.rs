//! Cross-checks the Rust keeper protocol against golden vectors recorded from the frozen Node modules
//! (`native/scripts/gen-node-vectors.mjs`, read-only imports of frameCodec.mjs, gateProtocol.mjs, mountFrames.mjs,
//! rootLease.mjs and viewLimits.mjs). Contract evidence for the wire formats only, not Linux runtime proof.

use rw_proto::frame::{DecodeEvent, FrameDecoder, encode_frame};
use rw_proto::gate::COMMIT_BYTE;
use rw_proto::json::{self, Value};
use rw_proto::lease::{LeaseAction, RootLeaseKeeper};
use rw_proto::limits::ViewLimits;
use rw_proto::mount_frames::{
    self, MountContext, MountSet, MountedIdentity, RefusalKind, Scope, validate_mount_reply, validate_mount_request,
    validate_root_lease_frame, validate_root_lease_reply, validate_unmount_request,
};

fn golden() -> Value {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/node-golden.json")).unwrap();
    json::parse(&bytes).expect("golden file parses with the strict parser")
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        other => panic!("{key}: {other:?}"),
    }
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap()).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn verdict(value: &Value) -> Result<(), String> {
    if value.get("ok") == Some(&Value::Bool(true)) {
        Ok(())
    } else {
        Err(value.get("code").and_then(Value::as_str).unwrap().to_string())
    }
}

fn context(value: &Value) -> MountContext {
    MountContext {
        scope: if value.get("scope").and_then(Value::as_str) == Some("gui") { Scope::Gui } else { Scope::Execution },
        runtime_root: value.get("runtimeRoot").and_then(Value::as_str).unwrap().to_string(),
        reservation_id: value.get("reservationId").and_then(Value::as_str).unwrap().to_string(),
        grant_count: value.get("grantCount").and_then(Value::as_safe_int).unwrap(),
    }
}

#[test]
fn commit_byte_and_view_limit_defaults() {
    let data = golden();
    assert_eq!(data.get("commitByte").and_then(Value::as_safe_int), Some(COMMIT_BYTE as i64));
    let defaults = data.get("viewLimitDefaults").and_then(Value::as_object).unwrap();
    let rust = ViewLimits::default().entries();
    assert_eq!(defaults.len(), rust.len());
    for ((name, value), (rust_name, rust_value)) in defaults.iter().zip(rust) {
        assert_eq!(name, rust_name);
        assert_eq!(value.as_safe_int(), Some(rust_value), "{name}");
    }
}

#[test]
fn encode_frame_is_byte_identical() {
    let data = golden();
    let cases = array(&data, "encodeCases");
    assert!(cases.len() >= 5);
    for case in cases {
        let value = case.get("value").unwrap();
        let frame = encode_frame(value, 65536).unwrap();
        assert_eq!(hex_encode(&frame), case.get("frameHex").and_then(Value::as_str).unwrap(), "{value:?}");
    }
}

#[test]
fn decoder_events_match_node() {
    let data = golden();
    for case in array(&data, "decoderCases") {
        let name = case.get("name").and_then(Value::as_str).unwrap();
        let max = case.get("maxFrameBytes").and_then(Value::as_safe_int).unwrap() as usize;
        let deadline = case.get("deadlineMs").and_then(Value::as_safe_int).unwrap() as u64;
        let mut decoder = FrameDecoder::new(max, deadline);
        let mut events = Vec::new();
        for step in array(case, "steps") {
            let at = step.get("at").or_else(|| step.get("poll")).and_then(Value::as_safe_int).unwrap() as u64;
            if let Some(due) = decoder.deadline() {
                if at >= due {
                    decoder.poll(due, &mut events);
                }
            }
            if let Some(hex) = step.get("hex").and_then(Value::as_str) {
                decoder.push(&hex_decode(hex), at, &mut events);
            }
        }
        let expected = array(case, "events");
        assert_eq!(events.len(), expected.len(), "{name}: {events:?}");
        for (got, want) in events.iter().zip(expected) {
            match got {
                DecodeEvent::Frame(value) => assert_eq!(Some(value), want.get("frame"), "{name}"),
                DecodeEvent::Violation(code) => assert_eq!(Some(*code), want.get("violation").and_then(Value::as_str), "{name}"),
            }
        }
    }
}

#[test]
fn mount_unmount_and_lease_validation_match_node() {
    let data = golden();
    let limits = ViewLimits::default();
    let base = context(data.get("mountContext").unwrap());
    let mut count = 0;
    for case in array(&data, "mountCases") {
        let got = validate_mount_request(case.get("frame").unwrap(), &base, &limits).map(|_| ()).map_err(str::to_string);
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{:?}", case.get("name"));
        count += 1;
    }
    for case in array(&data, "badContexts") {
        let got = validate_mount_request(case.get("frame").unwrap(), &context(case.get("context").unwrap()), &limits).map(|_| ()).map_err(str::to_string);
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{:?}", case.get("name"));
        count += 1;
    }
    for case in array(&data, "unmountCases") {
        let got = validate_unmount_request(case.get("frame").unwrap()).map(|_| ()).map_err(str::to_string);
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{:?}", case.get("frame"));
        count += 1;
    }
    for case in array(&data, "leaseCases") {
        let got = validate_root_lease_frame(case.get("frame").unwrap(), &limits).map(|_| ()).map_err(str::to_string);
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{:?}", case.get("name"));
        count += 1;
    }
    assert_eq!(count, 57, "every recorded case is checked");
}

#[test]
fn reply_validators_match_node_and_accept_rust_replies() {
    let data = golden();
    for case in array(&data, "sampleReplies") {
        let request = case.get("request").unwrap();
        let id = request.get("id").and_then(Value::as_safe_int).unwrap();
        let mountpoint = request.get("mountpoint").and_then(Value::as_str).unwrap();
        let got = validate_mount_reply(case.get("reply").unwrap(), id, mountpoint).map_err(str::to_string);
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{:?}", case.get("name"));
    }
    for case in array(&data, "leaseReplies") {
        let got = validate_root_lease_reply(case.get("reply").unwrap(), 3).map_err(str::to_string);
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{:?}", case.get("reply"));
    }
    // The replies the keeper builds pass the ported supervisor validators.
    let identity = MountedIdentity {
        resource: "0123456789abcdef0123456789abcdef".into(), mount_id: 812, mountpoint: "/run/x".into(),
        mount_namespace_inode: 4026532001, server_pid: 4242, server_start_time: 123456, server_pid_namespace_inode: 4026531836,
    };
    assert_eq!(validate_mount_reply(&mount_frames::mount_ok_reply(5, &identity), 5, "/run/x"), Ok(()));
    assert_eq!(validate_mount_reply(&mount_frames::refusal_reply(5, RefusalKind::Refused, "root_identity_mismatch"), 5, "/run/x"), Ok(()));
    assert_eq!(validate_root_lease_reply(&mount_frames::lease_state_reply(3, "revoking"), 3), Ok(()));
    assert_eq!(validate_root_lease_reply(&mount_frames::refusal_reply(3, RefusalKind::Refused, "stale_epoch"), 3), Ok(()));
}

fn lease_result_value(state: &str, action: Option<LeaseAction>) -> (String, Vec<String>) {
    let actions = match action {
        Some(LeaseAction::SignalRevoke) => vec!["signal_revoke".to_string()],
        Some(LeaseAction::Kill) => vec!["kill".to_string()],
        None => vec![],
    };
    (state.to_string(), actions)
}

#[test]
fn lease_timelines_match_create_root_lease_keeper() {
    let data = golden();
    let timelines = data.get("leaseTimelines").and_then(Value::as_object).unwrap();
    assert_eq!(timelines.len(), 6);
    for (name, steps) in timelines {
        let mut keeper = RootLeaseKeeper::new("app", 1, 3000, 0, ViewLimits::default()).unwrap();
        let Value::Array(steps) = steps else { panic!() };
        for step in steps {
            let at = step.get("at").and_then(Value::as_safe_int).unwrap() as u64;
            if let Some(frame) = step.get("apply") {
                let got = keeper.apply(frame, at);
                let want = step.get("result").unwrap();
                assert_eq!(Some(got.accepted), want.get("accepted").and_then(Value::as_bool), "{name} {step:?}");
                assert_eq!(Some(got.code), want.get("code").and_then(Value::as_str), "{name} {step:?}");
            } else if step.has("poll") {
                let (state, action) = keeper.poll(at);
                let want = step.get("result").unwrap();
                let want_actions: Vec<String> = array(want, "actions").iter().map(|item| item.as_str().unwrap().to_string()).collect();
                assert_eq!(lease_result_value(state.as_str(), action), (want.get("state").and_then(Value::as_str).unwrap().to_string(), want_actions), "{name} {step:?}");
            } else {
                keeper.server_exited();
            }
            let inspect = keeper.inspect();
            let want = step.get("inspect").unwrap();
            assert_eq!(Some(inspect.state.as_str()), want.get("state").and_then(Value::as_str), "{name} {step:?}");
            assert_eq!(Some(inspect.epoch), want.get("epoch").and_then(Value::as_safe_int), "{name}");
            assert_eq!(Some(inspect.valid_until as i64), want.get("validUntil").and_then(Value::as_safe_int), "{name}");
            assert_eq!(inspect.reason.as_deref(), want.get("reason").and_then(Value::as_str), "{name}");
        }
    }
}

#[test]
fn mount_set_codes_match_node_s5_r7() {
    // validateMountSet emits snake_case since S5 r7; the Rust MountSet must give the same code for the same set.
    let data = golden();
    let limits = ViewLimits::default();
    let mut names = Vec::new();
    for case in array(&data, "mountSetCases") {
        let name = case.get("name").and_then(Value::as_str).unwrap();
        let mut set = MountSet::default();
        let mut got: Result<(), String> = Ok(());
        for request in array(case, "requests") {
            let parsed = MountRequestLite::from(request);
            if let Err(code) = set.check(&parsed.0, &limits) {
                got = Err(code.to_string());
                break;
            }
            set.record(&parsed.0);
        }
        assert_eq!(got, verdict(case.get("verdict").unwrap()), "{name}");
        names.push(name.to_string());
    }
    assert_eq!(names.len(), 6);
    let codes: Vec<String> = array(&data, "mountSetCases").iter().filter_map(|case| case.get("verdict").unwrap().get("code").and_then(Value::as_str).map(str::to_string)).collect();
    assert_eq!(codes, vec!["duplicate_id", "duplicate_grant_id", "duplicate_root_slot", "duplicate_mountpoint", "bad_mount_set"]);
}

struct MountRequestLite(mount_frames::MountRequest);
impl MountRequestLite {
    fn from(value: &Value) -> Self {
        let get = |key: &str| value.get(key).unwrap();
        MountRequestLite(mount_frames::MountRequest {
            id: get("id").as_safe_int().unwrap(),
            grant_id: get("grantId").as_str().unwrap().to_string(),
            root_slot: get("rootSlot").as_safe_int().unwrap(),
            expected_dev: String::new(),
            expected_ino: String::new(),
            read_only: false,
            mountpoint: get("mountpoint").as_str().unwrap().to_string(),
            descriptor_cap: 0,
            rlimit_nofile: 0,
            lease_ttl_ms: 0,
        })
    }
}

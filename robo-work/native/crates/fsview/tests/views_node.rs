//! The D2 marker and the FUSE settings specification against the frozen Node modules (d2Decision.mjs and
//! fuseSettings.mjs, exported by scripts/gen-node-vectors.mjs into tests/vectors/node-views.json).

use rw_fsview::d2::D2_DECISION;
use rw_fsview::fuse_settings::*;
use rw_proto::json::{self, Value};

fn views() -> Value {
    json::parse(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/node-views.json")).unwrap()).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().map(|item| item.as_str().unwrap().to_string()).collect(),
        other => panic!("{other:?}"),
    }
}

fn owned(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| item.to_string()).collect()
}

#[test]
fn d2_marker_is_identical() {
    let data = views();
    let d2 = data.get("d2").unwrap();
    assert_eq!(d2.get("gate").and_then(Value::as_str), Some(D2_DECISION.gate));
    assert_eq!(d2.get("option").and_then(Value::as_str), Some(D2_DECISION.option));
    assert_eq!(d2.get("decided").and_then(Value::as_bool), Some(D2_DECISION.decided));
    assert_eq!(d2.get("recorded").and_then(Value::as_str), Some(D2_DECISION.recorded));
    assert_eq!(d2.get("proof").and_then(Value::as_str), Some(D2_DECISION.proof));
    for (key, list) in [("semantics", D2_DECISION.semantics), ("residuals", D2_DECISION.residuals), ("forbidden", D2_DECISION.forbidden), ("notClaimed", D2_DECISION.not_claimed), ("retained", D2_DECISION.retained)] {
        assert_eq!(strings(d2.get(key).unwrap()), owned(list), "{key}");
    }
    assert!(D2_DECISION.not_claimed.contains(&"atomic exclusion"));
}

#[test]
fn fuse_settings_lists_are_identical() {
    let data = views();
    let fuse = data.get("fuse").unwrap();
    let init = fuse.get("init").unwrap();
    assert_eq!(strings(init.get("forbiddenCapabilities").unwrap()), owned(FORBIDDEN_INIT_CAPABILITIES));
    assert_eq!(strings(init.get("permittedCapabilities").unwrap()), owned(PERMITTED_INIT_CAPABILITIES));
    assert_eq!(strings(fuse.get("readdirplus").unwrap().get("capabilitiesThatEnableIt").unwrap()), owned(READDIRPLUS_ENABLERS));
    let open = fuse.get("open").unwrap();
    assert_eq!(strings(open.get("requiredFlags").unwrap()), owned(OPEN_REQUIRED_FLAGS));
    assert_eq!(strings(open.get("forbiddenFlags").unwrap()), owned(OPEN_FORBIDDEN_FLAGS));
    assert_eq!(strings(fuse.get("opendir").unwrap().get("forbiddenFlags").unwrap()), owned(OPENDIR_FORBIDDEN_FLAGS));
    let mount = fuse.get("mount").unwrap();
    assert_eq!(strings(mount.get("requiredOptions").unwrap()), owned(MOUNT_REQUIRED_OPTIONS));
    assert_eq!(mount.get("readOnlyGrantRequiresOption").and_then(Value::as_str), Some(READ_ONLY_GRANT_OPTION));
}

fn ttl(value: &Value) -> Ttl {
    Ttl { secs: value.get("secs").and_then(Value::as_safe_int).unwrap() as u64, nsecs: value.get("nsecs").and_then(Value::as_safe_int).unwrap() as u32 }
}

fn sample_from(value: &Value) -> Sample {
    let list = |key: &str| match value.get(key) { Some(Value::Array(items)) => items.clone(), _ => vec![] };
    Sample {
        init_capabilities: value.get("init").and_then(|init| init.get("capabilities")).map(strings),
        entry_replies: list("entryReplies").iter().map(|reply| ttl(reply.get("entryValid").unwrap())).collect(),
        negative_lookup_replies: list("negativeLookupReplies").iter().map(|reply| match reply.get("kind").and_then(Value::as_str) {
            Some("error") => NegativeLookup::Error(reply.get("errno").and_then(Value::as_str).unwrap().to_string()),
            _ => NegativeLookup::Entry { node_id: reply.get("nodeId").and_then(Value::as_safe_int).unwrap() as u64, entry_valid: ttl(reply.get("entryValid").unwrap()) },
        }).collect(),
        readdirplus_entries: list("readdirplusEntries").iter().map(|entry| ttl(entry.get("entryValid").unwrap())).collect(),
        open_replies: list("openReplies").iter().map(|reply| strings(reply.get("openFlags").unwrap())).collect(),
        opendir_replies: list("opendirReplies").iter().map(|reply| strings(reply.get("openFlags").unwrap())).collect(),
        read_replies: list("readReplies").iter().map(|reply| match reply.get("delivery").and_then(Value::as_str) {
            Some("copy") => Delivery::Copy,
            Some("splice") => Delivery::Splice,
            _ => Delivery::ZeroCopy,
        }).collect(),
        mount_options: value.get("mountOptions").map(strings),
        grant_access: value.get("grantAccess").and_then(Value::as_str).map(str::to_string),
    }
}

#[test]
fn settings_checker_matches_node_on_samples() {
    let data = views();
    let samples = data.get("samples").and_then(Value::as_object).unwrap();
    assert_eq!(samples.len(), 9);
    for (name, case) in samples {
        let got: Vec<(String, String)> = find_settings_violations(&sample_from(case.get("sample").unwrap())).into_iter().map(|v| (v.code.to_string(), v.location)).collect();
        let Value::Array(want) = case.get("violations").unwrap() else { panic!() };
        let want: Vec<(String, String)> = want.iter().map(|v| (v.get("code").and_then(Value::as_str).unwrap().to_string(), v.get("where").and_then(Value::as_str).unwrap().to_string())).collect();
        assert_eq!(got, want, "{name}");
    }
}

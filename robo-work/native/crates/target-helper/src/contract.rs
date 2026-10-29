//! Primitive types and the validators the helper needs from `contract.mjs`: `TargetBinding` (base section 4), the frame
//! descriptor manifest and the channel manifest (base sections 7 and 8). Check order and codes follow the Node module
//! (its header comment): canonical encoding and size first, then per object the plain-object check, `version`, the
//! exact key set and each field in declared order.

use crate::Code;
use crate::canon::{self, Value};
use crate::crypto::b64url_decode;

type Check = Result<(), Code>;

fn need(condition: bool, code: Code) -> Check {
    if condition { Ok(()) } else { Err(code) }
}

fn invalid(condition: bool) -> Check {
    need(condition, Code::InvalidRequest)
}

// ---- Primitive types ---------------------------------------------------------------------------------------------

/// `Id`: canonical unpadded base64url of 16 bytes (22 characters, round trip).
pub fn is_id(value: &Value) -> bool {
    value.str().is_some_and(is_id_text)
}

pub fn is_id_text(text: &str) -> bool {
    text.len() == 22 && text.bytes().all(is_b64url_byte) && b64url_decode(text).is_some_and(|bytes| bytes.len() == 16)
}

fn is_b64url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// `OperationId`: exactly 22 `[A-Za-z0-9_-]` characters (no round-trip requirement).
pub fn is_operation_id(value: &Value) -> bool {
    value.str().is_some_and(|text| text.len() == 22 && text.bytes().all(is_b64url_byte))
}

/// 32 random bytes as canonical 43-character base64url (`helperNonce`, `jti`).
pub fn is_nonce(value: &Value) -> bool {
    value.str().is_some_and(|text| {
        text.len() == 43 && text.bytes().all(is_b64url_byte) && b64url_decode(text).is_some_and(|bytes| bytes.len() == 32)
    })
}

/// JavaScript `/[\u0000-\u001f\u007f-\u009f]/u`.
fn has_control(text: &str) -> bool {
    text.chars().any(|character| (character as u32) < 0x20 || (0x7f..=0x9f).contains(&(character as u32)))
}

/// JavaScript `/\s/u`: WhiteSpace plus LineTerminator.
fn js_space(character: char) -> bool {
    matches!(character as u32,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub fn is_opaque_identity(value: &Value) -> bool {
    value.str().is_some_and(is_opaque_text)
}

pub fn is_opaque_text(text: &str) -> bool {
    (1..=200).contains(&text.len()) && !has_control(text) && !text.chars().any(js_space)
}

fn is_ref(text: &str) -> bool {
    let parts: Vec<&str> = text.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            (1..=128).contains(&part.len())
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
                && *part != "."
                && *part != ".."
        })
}

pub fn is_principal(value: &Value) -> bool {
    value.str().is_some_and(|text| text.strip_prefix("agent:").is_some_and(is_ref))
}

pub fn is_digest(value: &Value) -> bool {
    value.str().is_some_and(is_digest_text)
}

pub fn is_digest_text(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_image_digest(value: &Value) -> bool {
    value.str().is_some_and(|text| text.strip_prefix("sha256:").is_some_and(is_digest_text))
}

pub fn is_counter(value: &Value) -> bool {
    value.int().is_some_and(|number| (0..=canon::MAX_SAFE).contains(&number))
}

pub fn is_positive_counter(value: &Value) -> bool {
    value.int().is_some_and(|number| (1..=canon::MAX_SAFE).contains(&number))
}

/// `U64Text`: `0` or a nonzero-leading decimal of at most 20 digits, at most 18446744073709551615.
pub fn is_u64_text(value: &Value) -> bool {
    value.str().is_some_and(is_u64_str)
}

pub fn is_u64_str(text: &str) -> bool {
    let shape = text == "0" || (!text.is_empty() && text.len() <= 20 && !text.starts_with('0') && text.bytes().all(|byte| byte.is_ascii_digit()));
    shape && text.parse::<u64>().is_ok()
}

pub fn is_positive_u64_text(value: &Value) -> bool {
    is_u64_text(value) && value.str() != Some("0")
}

fn is_container_id(value: &Value) -> bool {
    is_digest(value)
}

fn is_grant_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn is_lower_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn is_bounded_text(value: &Value, max: usize) -> bool {
    value.str().is_some_and(|text| (1..=max).contains(&text.len()) && !has_control(text))
}

/// Canonical credential-free repository identity: 1-512 bytes, no whitespace, no URL user information
/// (`/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/` refuses).
fn is_repository_identity(value: &Value) -> bool {
    if !is_bounded_text(value, 512) {
        return false;
    }
    let text = value.str().unwrap_or_default();
    if text.chars().any(js_space) {
        return false;
    }
    let bytes = text.as_bytes();
    if bytes.first().is_some_and(u8::is_ascii_alphabetic) {
        let scheme_end = bytes.iter().position(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))).unwrap_or(bytes.len());
        if text[scheme_end..].starts_with("://") {
            let authority = &text[scheme_end + 3..];
            let run = authority.split('/').next().unwrap_or_default();
            if run.contains('@') {
                return false;
            }
        }
    }
    true
}

/// `exact(value, keys, versioned)`: plain object, then `version === 1` when versioned, then exactly the keys.
fn exact(value: &Value, keys: &[&str], versioned: bool) -> Check {
    let Some(entries) = value.obj() else {
        return Err(Code::InvalidRequest);
    };
    if versioned {
        need(value.get("version") == Some(&Value::Int(1)), Code::UnsupportedVersion)?;
    }
    let allowed = |key: &str| keys.contains(&key) || (versioned && key == "version");
    invalid(entries.iter().all(|(key, _)| allowed(key)))?;
    invalid(keys.iter().all(|key| value.has(key)))?;
    invalid(!versioned || value.has("version"))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    value.get(key).unwrap_or(&NULL)
}

fn opaque(value: &Value) -> Check {
    invalid(is_opaque_identity(value))
}

fn id(value: &Value) -> Check {
    invalid(is_id(value))
}

fn digest(value: &Value) -> Check {
    invalid(is_digest(value))
}

fn principal(value: &Value) -> Check {
    invalid(is_principal(value))
}

fn positive(value: &Value) -> Check {
    invalid(is_positive_counter(value))
}

fn one_of(value: &Value, options: &[&str]) -> Check {
    invalid(value.str().is_some_and(|text| options.contains(&text)))
}

fn boolean(value: &Value) -> Check {
    invalid(value.bool().is_some())
}

/// `finish(value, check, maxBytes)`: the canonical encoding and size bound first, then the structural check.
fn finish(value: &Value, check: impl Fn(&Value) -> Check, max_bytes: usize) -> Check {
    canon::canonical(value, max_bytes)?;
    check(value)
}

// ---- Binding (base section 4) -------------------------------------------------------------------------------------

pub const LIVE_SCOPE_KEYS: [&str; 12] = [
    "workspaceId", "boxIdentity", "boxGeneration", "workerPrincipal", "workerRuntimeInstanceId", "workerEnableGeneration",
    "workerGeneration", "agentPrincipal", "containerId", "runtimeInstanceId", "enableGeneration", "helperIncarnation",
];

fn live_scope(value: &Value) -> Check {
    exact(value, &LIVE_SCOPE_KEYS, false)?;
    opaque(field(value, "workspaceId"))?;
    opaque(field(value, "boxIdentity"))?;
    opaque(field(value, "boxGeneration"))?;
    principal(field(value, "workerPrincipal"))?;
    opaque(field(value, "workerRuntimeInstanceId"))?;
    opaque(field(value, "workerEnableGeneration"))?;
    id(field(value, "workerGeneration"))?;
    principal(field(value, "agentPrincipal"))?;
    invalid(is_container_id(field(value, "containerId")))?;
    opaque(field(value, "runtimeInstanceId"))?;
    opaque(field(value, "enableGeneration"))?;
    id(field(value, "helperIncarnation"))
}

fn source_revision(value: &Value) -> Check {
    exact(value, &["algorithm", "value"], false)?;
    one_of(field(value, "algorithm"), &["git-sha1", "git-sha256"])?;
    let length = if field(value, "algorithm").str() == Some("git-sha1") { 40 } else { 64 };
    invalid(field(value, "value").str().is_some_and(|text| {
        text.len() == length && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }))
}

fn source_binding(value: &Value) -> Check {
    exact(
        value,
        &["repositorySourceMode", "sourceRepositoryIdentity", "sourceRevision", "sourceProtectionEpoch", "sourceSelectionDigest",
            "sourceClosureDigest", "sourceAcceptanceIdentity"],
        false,
    )?;
    one_of(field(value, "repositorySourceMode"), &["dev", "prod"])?;
    invalid(is_repository_identity(field(value, "sourceRepositoryIdentity")))?;
    source_revision(field(value, "sourceRevision"))?;
    positive(field(value, "sourceProtectionEpoch"))?;
    digest(field(value, "sourceSelectionDigest"))?;
    digest(field(value, "sourceClosureDigest"))?;
    opaque(field(value, "sourceAcceptanceIdentity"))
}

const BINDING_DIGEST_KEYS: [&str; 13] = [
    "helperExecutableDigest", "contractDigest", "inventoryDigest", "profileDigest", "limitsDigest", "qualificationRecordDigest",
    "effectiveSecurityDigest", "grantPolicyDigest", "inputManifestDigest", "skillViewManifestDigest",
    "nativeConfigProjectionDigest", "channelManifestDigest", "homeCompatibilityDigest",
];

fn target_binding(value: &Value) -> Check {
    let mut keys = vec!["scope", "source", "targetImageDigest", "contractVersion", "journalStoreIdentity", "robotId", "executionId",
        "attemptId", "configRevision"];
    keys.extend_from_slice(&BINDING_DIGEST_KEYS);
    exact(value, &keys, true)?;
    live_scope(field(value, "scope"))?;
    source_binding(field(value, "source"))?;
    invalid(is_image_digest(field(value, "targetImageDigest")))?;
    need(field(value, "contractVersion") == &Value::Int(1), Code::UnsupportedVersion)?;
    for key in BINDING_DIGEST_KEYS {
        digest(field(value, key))?;
    }
    id(field(value, "journalStoreIdentity"))?;
    id(field(value, "robotId"))?;
    id(field(value, "executionId"))?;
    id(field(value, "attemptId"))?;
    positive(field(value, "configRevision"))
}

/// `validateTargetBinding`.
pub fn validate_target_binding(value: &Value) -> Check {
    finish(value, target_binding, canon::OBJECT_BYTES)
}

/// The LiveScope target/Box projection named by the ticket audience (`targetIdentityDigest`).
pub fn target_identity_digest(scope: &Value) -> Result<String, Code> {
    let keys = ["workspaceId", "boxIdentity", "boxGeneration", "agentPrincipal", "containerId", "runtimeInstanceId", "enableGeneration",
        "helperIncarnation"];
    let projection = Value::Obj(keys.iter().map(|key| (key.to_string(), field(scope, key).clone())).collect());
    canon::digest_of(&projection)
}

// ---- Descriptor manifest (base section 8) -------------------------------------------------------------------------

pub const DESCRIPTOR_ROLES: [&str; 5] = ["home", "grant-root", "skill-overlay", "native-config-view", "connected-stream"];
const DESCRIPTORS_PER_FRAME_CEILING: usize = 8;
pub const HOME_DESTINATION: &str = "/home/robot";
pub const SKILL_DESTINATION: &str = "/run/robo-work/skills";
pub const NATIVE_CONFIG_DESTINATION: &str = "/run/robo-work/config/native";

fn fs_identity(value: &Value) -> Check {
    exact(value, &["filesystemId", "mountId", "device", "inode", "fileType"], false)?;
    opaque(field(value, "filesystemId"))?;
    for key in ["mountId", "device", "inode"] {
        invalid(is_u64_text(field(value, key)))?;
    }
    one_of(field(value, "fileType"), &["directory", "regular", "symlink"])
}

fn directory_identity(value: &Value) -> Check {
    fs_identity(value)?;
    need(field(value, "fileType").str() == Some("directory"), Code::DescriptorIdentity)
}

pub fn is_grant_destination(text: &str) -> bool {
    if let Some(grant) = text.strip_prefix("/projects/") {
        return is_grant_id(grant);
    }
    if let Some(export) = text.strip_prefix("/environment/") {
        return is_lower_id(export);
    }
    false
}

fn descriptor_entry(entry: &Value, index: usize) -> Check {
    invalid(entry.is_obj())?;
    need(entry.get("slot") == Some(&Value::Int(index as i64)), Code::DescriptorCount)?;
    exact(entry, &["slot", "descriptorId", "role", "kind", "access", "identity", "destination", "resourceId"], false)?;
    let role = field(entry, "role").str();
    need(role.is_some_and(|role| DESCRIPTOR_ROLES.contains(&role)), Code::DescriptorRole)?;
    id(field(entry, "descriptorId"))?;
    id(field(entry, "resourceId"))?;
    let role = role.unwrap_or_default();
    let kind = field(entry, "kind").str();
    let access = field(entry, "access").str();
    let destination = field(entry, "destination");
    if role == "connected-stream" {
        need(kind == Some("connected-stream") && access == Some("duplex") && destination.is_null(), Code::DescriptorRole)?;
        let identity = field(entry, "identity");
        exact(identity, &["socketCookie"], false)?;
        return invalid(is_u64_text(field(identity, "socketCookie")));
    }
    need(kind == Some("directory"), Code::DescriptorRole)?;
    let expected = match role {
        "home" => Some((HOME_DESTINATION, &["write"][..])),
        "skill-overlay" => Some((SKILL_DESTINATION, &["read"][..])),
        "native-config-view" => Some((NATIVE_CONFIG_DESTINATION, &["read"][..])),
        _ => None,
    };
    match expected {
        Some((path, accesses)) => need(
            destination.str() == Some(path) && access.is_some_and(|access| accesses.contains(&access)),
            Code::DescriptorRole,
        )?,
        None => need(
            destination.str().is_some_and(is_grant_destination) && matches!(access, Some("read" | "write")),
            Code::DescriptorRole,
        )?,
    }
    directory_identity(field(entry, "identity"))
}

fn descriptor_manifest(value: &Value) -> Check {
    let Some(entries) = value.arr() else {
        return Err(Code::InvalidRequest);
    };
    need(entries.len() <= DESCRIPTORS_PER_FRAME_CEILING, Code::CapacityExceeded)?;
    for (index, entry) in entries.iter().enumerate() {
        descriptor_entry(entry, index)?;
    }
    let mut ids: Vec<&str> = entries.iter().filter_map(|entry| entry.str_at("descriptorId")).collect();
    ids.sort_unstable();
    ids.dedup();
    invalid(ids.len() == entries.len())
}

/// `validateDescriptorManifest`: the ordered descriptor entries of one frame header.
pub fn validate_descriptor_manifest(value: &Value) -> Check {
    finish(value, descriptor_manifest, canon::OBJECT_BYTES)
}

// ---- Channel manifest (base section 7) ----------------------------------------------------------------------------

pub const CHANNEL_KINDS: [&str; 5] = ["model", "broker", "mcp", "human-input", "task-failure"];

fn channel_handler(kind: &str) -> &'static str {
    match kind {
        "model" => "model-adapter",
        "broker" => "execution-broker",
        "mcp" => "execution-mcp",
        "human-input" => "execution-human-input",
        _ => "execution-task-failure",
    }
}

fn channel_token(kind: &str) -> &'static str {
    match kind {
        "model" => "ROBOWORK_MODEL_TOKEN",
        "broker" => "ROBOWORK_BROKER_TOKEN",
        "mcp" => "ROBOWORK_MCP_TOKEN",
        "human-input" => "ROBOWORK_HUMAN_INPUT_TOKEN",
        _ => "ROBOWORK_TASK_FAILURE_TOKEN",
    }
}

fn channel_socket(kind: &str) -> &'static str {
    match kind {
        "model" => "/run/robo-work/channels/model.sock",
        "broker" => "/run/robo-work/channels/broker.sock",
        "human-input" => "/run/robo-work/channels/human-input.sock",
        _ => "/run/robo-work/channels/task-failure.sock",
    }
}

fn channel_endpoint(kind: &str, endpoint: &Value) -> Check {
    if kind == "mcp" {
        exact(endpoint, &["transport", "host", "port"], false)?;
        invalid(field(endpoint, "transport").str() == Some("tcp") && field(endpoint, "host").str() == Some("127.0.0.1"))?;
        invalid(field(endpoint, "port").int().is_some_and(|port| (1024..=65535).contains(&port)))
    } else {
        exact(endpoint, &["transport", "path"], false)?;
        invalid(field(endpoint, "transport").str() == Some("unix") && field(endpoint, "path").str() == Some(channel_socket(kind)))
    }
}

fn channel_manifest(value: &Value) -> Check {
    exact(value, &["executionId", "attemptId", "limitsDigest", "channels"], true)?;
    id(field(value, "executionId"))?;
    id(field(value, "attemptId"))?;
    digest(field(value, "limitsDigest"))?;
    let channels = field(value, "channels").arr();
    invalid(channels.is_some_and(|channels| channels.len() == CHANNEL_KINDS.len()))?;
    for (index, channel) in channels.unwrap_or_default().iter().enumerate() {
        exact(channel, &["channelId", "kind", "enabled", "required", "endpoint", "handler", "policyDigest", "finalExecTokenName"], false)?;
        let kind = CHANNEL_KINDS[index];
        invalid(field(channel, "kind").str() == Some(kind) && field(channel, "channelId").str() == Some(kind))?;
        boolean(field(channel, "enabled"))?;
        boolean(field(channel, "required"))?;
        if field(channel, "enabled") == &Value::Bool(false) {
            need(field(channel, "required") != &Value::Bool(true), Code::RequiredChannelMissing)?;
            invalid(["endpoint", "handler", "policyDigest", "finalExecTokenName"].iter().all(|key| field(channel, key).is_null()))?;
        } else {
            channel_endpoint(kind, field(channel, "endpoint"))?;
            invalid(field(channel, "handler").str() == Some(channel_handler(kind)))?;
            digest(field(channel, "policyDigest"))?;
            let token = field(channel, "finalExecTokenName");
            invalid(token.is_null() || token.str() == Some(channel_token(kind)))?;
        }
    }
    Ok(())
}

/// `validateChannelManifest` without `requirements`.
pub fn validate_channel_manifest(value: &Value) -> Check {
    finish(value, channel_manifest, canon::OBJECT_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canon::{obj, s};

    #[test]
    fn primitive_predicates() {
        assert!(is_id(&s("AQEBAQEBAQEBAQEBAQEBAQ")));
        // 22 characters whose last symbol carries non-zero trailing bits fail the round trip.
        assert!(!is_id(&s("AQEBAQEBAQEBAQEBAQEBAR")));
        assert!(is_operation_id(&s("AQEBAQEBAQEBAQEBAQEBAR")));
        assert!(!is_id(&s("AQEBAQEBAQEBAQEBAQEBA")));
        assert!(is_u64_text(&s("18446744073709551615")));
        assert!(!is_u64_text(&s("18446744073709551616")));
        assert!(!is_u64_text(&s("01")));
        assert!(is_positive_u64_text(&s("1")) && !is_positive_u64_text(&s("0")));
        assert!(is_opaque_identity(&s("ws-1")));
        for bad in ["", "a b", "a\u{feff}", "a\u{85}", "a\u{3000}", "a\u{7f}"] {
            assert!(!is_opaque_identity(&s(bad)), "{bad:?}");
        }
        assert!(is_opaque_identity(&s(&"é".repeat(100))));
        assert!(!is_opaque_identity(&s(&"é".repeat(101))));
        assert!(is_principal(&s("agent:Repo/agent.name_1")));
        for bad in ["agent:Repo", "agent:./x", "agent:a/..", "agent:a/b/c", "Repo/x"] {
            assert!(!is_principal(&s(bad)), "{bad}");
        }
        assert!(is_repository_identity(&s("https://example.invalid/x.git")));
        assert!(!is_repository_identity(&s("https://user@example.invalid/x.git")));
        assert!(is_repository_identity(&s("https://example.invalid/a@b")));
        assert!(!is_repository_identity(&s("git+ssh://git@host/x")));
        assert!(is_grant_destination("/projects/a-1") && is_grant_destination("/environment/state"));
        assert!(!is_grant_destination("/projects/A") && !is_grant_destination("/environment/1x") && !is_grant_destination("/projects/a/b"));
    }

    fn directory(role: &str, destination: Value, access: &str, slot: i64) -> Value {
        obj(vec![
            ("slot", Value::Int(slot)),
            ("descriptorId", s("AQEBAQEBAQEBAQEBAQEBAQ")),
            ("role", s(role)),
            ("kind", s("directory")),
            ("access", s(access)),
            ("identity", obj(vec![("filesystemId", s("fs")), ("mountId", s("1")), ("device", s("2")), ("inode", s("3")), ("fileType", s("directory"))])),
            ("destination", destination),
            ("resourceId", s("AgICAgICAgICAgICAgICAg")),
        ])
    }

    #[test]
    fn descriptor_manifest_roles_and_order() {
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![directory("home", s("/home/robot"), "write", 0)])), Ok(()));
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![directory("home", s("/home/robot"), "write", 1)])), Err(Code::DescriptorCount));
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![directory("home", s("/home/robot"), "read", 0)])), Err(Code::DescriptorRole));
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![directory("namespace", s("/home/robot"), "write", 0)])), Err(Code::DescriptorRole));
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![directory("grant-root", s("/projects/p1"), "read", 0)])), Ok(()));
        let mut regular = directory("grant-root", s("/projects/p1"), "read", 0);
        if let Value::Obj(entries) = &mut regular {
            entries[5].1.set("fileType", s("regular"));
        }
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![regular])), Err(Code::DescriptorIdentity));
        let duplicate = Value::Arr(vec![directory("home", s("/home/robot"), "write", 0), directory("skill-overlay", s(SKILL_DESTINATION), "read", 1)]);
        assert_eq!(validate_descriptor_manifest(&duplicate), Err(Code::InvalidRequest));
        let nine = Value::Arr((0..9).map(|slot| directory("home", s("/home/robot"), "write", slot)).collect());
        assert_eq!(validate_descriptor_manifest(&nine), Err(Code::CapacityExceeded));
        let stream = obj(vec![
            ("slot", Value::Int(0)), ("descriptorId", s("AQEBAQEBAQEBAQEBAQEBAQ")), ("role", s("connected-stream")),
            ("kind", s("connected-stream")), ("access", s("duplex")), ("identity", obj(vec![("socketCookie", s("77"))])),
            ("destination", Value::Null), ("resourceId", s("AgICAgICAgICAgICAgICAg")),
        ]);
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![stream.clone()])), Ok(()));
        let mut listener = stream;
        listener.set("access", s("read"));
        assert_eq!(validate_descriptor_manifest(&Value::Arr(vec![listener])), Err(Code::DescriptorRole));
    }
}

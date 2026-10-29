//! The v1 keeper wire schema, keeper side (keeper-wire-contract-delta-2026-10-28_claude.md §2-§4 and R1; Rust mirror of
//! the Node `server/execution/keeperFrames.mjs`). Framing is frameCodec's (u32 BE length + one JSON object).
//!
//! | Frame | Rule |
//! |---|---|
//! | Request | `{ id, op, ... }`, exact sorted key set per op, `id` a safe integer 1..=1e9 strictly increasing per channel |
//! | Ok reply | exactly `{ id, ok: true, value }`, `value` with the op's exact key set |
//! | Error reply | exactly `{ id, ok: false, kind: 'refused' \| 'failure', error }`, `error` matching `/^[a-z][a-z0-9_]{0,63}$/` |
//! | Event | `{ event, ... }` (`hello`, `exit`, `pty_output`, `pty_closed`), no `id` |
//!
//! Structural problems (unknown op, extra or missing key, wrong type, oversize for the op, non-canonical seq or base64)
//! are VIOLATIONS: the keeper tears down and exits 65. A well-formed request that is not permitted (unknown handle,
//! state conflict) is a `refused` reply, decided by the dispatcher. Mount and lease frames are validated in two stages
//! (R1.5 M-1): stage 1 exact keys and JSON types (any extra key, including a source-path key, is a violation); stage 2
//! the frozen validator, whose `bad_frame` is a violation and every other code a snake_case refusal.
//!
//! BINDING NOTE: the shared vectors `tests/vectors/keeper-wire.v1.json` (S4 r9) are authoritative. Details the contract
//! text leaves open are marked PROVISIONAL below and are checked by `keeper_wire_vectors` once the vectors exist.

use crate::json::{self, Value, int, obj, text};
use crate::keeper_limits::{ENDPOINT_LIMIT_DEFAULTS, EndpointLimits, KeeperLimits, pty_frame_cap};
use crate::limits::ViewLimits;
use crate::mount_frames::{MountContext, MountRequest, MountSet, validate_mount_request, validate_root_lease_frame, validate_unmount_request};
use crate::provider_schema::{is_path, start_request_ok, virtual_path_ok};

pub const PROTOCOL: &str = "robo-work-keeper";
pub const VERSION: i64 = 1;
pub const MAX_ID: i64 = 1_000_000_000;
pub const MAX_ABORT_HANDLES: usize = 64;
pub const MAX_GRACE_MS: i64 = 3_600_000;

// ---- codecs -------------------------------------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode_with(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        let symbols = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        for (index, symbol) in symbols.iter().enumerate() {
            if index <= chunk.len() {
                out.push(alphabet[*symbol as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn decode_with(text: &str, alphabet: &[u8; 64], pad: bool) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let body_len = if pad {
        if bytes.len() % 4 != 0 {
            return None;
        }
        bytes.len() - bytes.iter().rev().take(2).take_while(|byte| **byte == b'=').count()
    } else {
        bytes.len()
    };
    let mut values = Vec::with_capacity(body_len);
    for &byte in &bytes[..body_len] {
        values.push(alphabet.iter().position(|symbol| *symbol == byte)? as u32);
    }
    if body_len % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body_len * 3 / 4);
    for chunk in values.chunks(4) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (index, value)| acc | value << (18 - 6 * index));
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    // Canonical only: re-encoding must give the same text (rejects non-zero trailing bits and bad padding).
    if encode_with(&out, alphabet, pad) != text {
        return None;
    }
    Some(out)
}

/// Canonical padded standard base64 (PTY data).
pub fn base64_encode(bytes: &[u8]) -> String {
    encode_with(bytes, B64, true)
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    decode_with(text, B64, true)
}

/// `isOriginId` (stateProtocol.mjs): 22 base64url characters that decode canonically to 16 bytes.
pub fn is_origin_id(value: &str) -> bool {
    value.len() == 22 && decode_with(value, B64URL, false).is_some_and(|bytes| bytes.len() == 16)
}

/// Supervisor-assigned handle: `Buffer.from(resourceId, 'base64url').toString('hex')`.
pub fn handle_for_resource_id(resource_id: &str) -> Option<String> {
    if !is_origin_id(resource_id) {
        return None;
    }
    decode_with(resource_id, B64URL, false).map(|bytes| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn is_supervisor_handle(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Keeper-assigned mount handle: `'m'` + 32 lowercase hex.
pub fn is_mount_handle(value: &str) -> bool {
    value.len() == 33 && value.starts_with('m') && is_supervisor_handle(&value[1..])
}

/// A canonical unsigned decimal sequence string: no sign, no leading zero, at least `"1"`, at most u64::MAX.
pub fn parse_seq(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 20 || value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|seq| *seq >= 1)
}

pub fn is_canonical_decimal(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit()) && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok()
}

// ---- requests -----------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateKind {
    RuntimeDir,
    Netns,
    Endpoint,
    ProcessTree,
    Pty,
    Cgroup,
}

impl CreateKind {
    pub fn parse(text: &str) -> Option<CreateKind> {
        Some(match text {
            "runtime-dir" => CreateKind::RuntimeDir,
            "netns" => CreateKind::Netns,
            "endpoint" => CreateKind::Endpoint,
            "process-tree" => CreateKind::ProcessTree,
            "pty" => CreateKind::Pty,
            "cgroup" => CreateKind::Cgroup,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            CreateKind::RuntimeDir => "runtime-dir",
            CreateKind::Netns => "netns",
            CreateKind::Endpoint => "endpoint",
            CreateKind::ProcessTree => "process-tree",
            CreateKind::Pty => "pty",
            CreateKind::Cgroup => "cgroup",
        }
    }
    pub fn process_bearing(self) -> bool {
        matches!(self, CreateKind::Endpoint | CreateKind::ProcessTree)
    }
}

/// `create.spec`, by kind and role (contract §4; keeperFrames.mjs `specProblem`). Values the supervisor already validated
/// (the admitted start request, the endpoint config) are carried as JSON after their shape check.
#[derive(Clone, Debug, PartialEq)]
pub enum Spec {
    Empty,
    Pty { cols: i64, rows: i64 },
    Endpoint { netns: String, config: Value },
    Orchestration { script: String, args: Vec<String>, env: Vec<(String, String)> },
    Workload { process: i64, request: Value, streams: Vec<(String, String)>, netns: String },
    Terminal { pty: String, argv: Vec<String>, cwd: String, netns: Option<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    CommitKeeper,
    Create { resource: String, kind: CreateKind, marker: Option<String>, locator: Value, spec: Spec },
    Commit { resource: String },
    AbortUncommitted { resources: Vec<String> },
    Stop { resource: String, grace_ms: i64 },
    Tempdir,
    EndProcessTrees,
    EndEndpoint,
    ReleaseEgress,
    ReleaseViews,
    RemoveRuntime,
    Shutdown,
    Inventory,
    Ping,
    PtyInput { resource: String, seq: u64, data: Vec<u8> },
    PtyResize { resource: String, cols: i64, rows: i64 },
    PtyCredit { resource: String, bytes: i64 },
    /// Both stages passed (or, without a mount context, stage 1 only: the dispatcher then runs stage 2).
    MountView(Value),
    UnmountView { resource: String },
    ViewRootLease(Value),
}

impl Request {
    pub fn is_pty_input(&self) -> bool {
        matches!(self, Request::PtyInput { .. })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub id: i64,
    pub op: String,
    pub request: Request,
}

/// A structural violation code (`bad_frame`, `oversize_frame`, `unknown_op`).
pub type Violation = &'static str;

/// The verdict of one request frame (keeperFrames.mjs `validateKeeperRequest`): accepted, refused by the frame alone
/// (`kind_not_supported`, the frozen mount validators' codes in wire form, `bad_ttl`), or a violation.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Ok(Decoded),
    Refused { id: i64, code: String },
    Violation(Violation),
}

/// What the validator needs besides the frame. A missing cgroup subtree means undelegated, never unchecked.
#[derive(Clone, Debug)]
pub struct RequestContext<'a> {
    pub limits: &'a KeeperLimits,
    pub view: &'a ViewLimits,
    pub endpoint: &'a EndpointLimits,
    pub runtime_root: Option<&'a str>,
    pub keeper_reservation: &'a str,
    pub cgroup_subtree: Option<&'a str>,
    pub orchestration_root: Option<&'a str>,
    pub mount: Option<&'a MountContext>,
    /// Earlier mount requests of the same keeper (validateMountSet).
    pub prior: &'a [MountRequest],
}

/// The ledger's resource kinds (resourceLocators.mjs RESOURCE_KINDS): a create of one of these that v1 does not create
/// is refused `kind_not_supported`; any other kind string is a violation.
pub const RESOURCE_KINDS: &[&str] =
    &["keeper", "endpoint", "process-tree", "netns", "veth", "nft-table", "mount", "pty", "runtime-dir", "cgroup", "gui-container", "gui-view"];

/// `wireCode`: a frozen mount validator code in wire form (camelCase to snake_case; snake_case unchanged).
pub fn wire_code(code: &str) -> String {
    let mut out = String::with_capacity(code.len() + 4);
    for character in code.chars() {
        if character.is_ascii_uppercase() {
            out.push('_');
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

fn keys(frame: &Value) -> String {
    frame.sorted_keys().unwrap_or_default()
}

fn string(frame: &Value, key: &str) -> Option<String> {
    frame.get(key).and_then(Value::as_str).map(str::to_string)
}

fn count(frame: &Value, key: &str, min: i64, max: i64) -> Option<i64> {
    frame.get(key).and_then(Value::as_safe_int).filter(|value| *value >= min && *value <= max)
}

fn is_handle_value(value: &Value) -> bool {
    value.as_str().is_some_and(is_supervisor_handle)
}

/// `stringList(value, maxCount, maxBytes)`.
fn string_list(value: Option<&Value>, max_count: usize, max_bytes: usize) -> Option<Vec<String>> {
    match value {
        Some(Value::Array(items)) if items.len() <= max_count => {
            items.iter().map(|item| item.as_str().filter(|text| text.len() <= max_bytes).map(str::to_string)).collect()
        }
        _ => None,
    }
}

fn locator_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_supervisor_handle)
}

/// `locatorProblem(kind, locator, marker, context)`, negated.
fn locator_ok(kind: CreateKind, locator: &Value, marker: Option<&str>, context: &RequestContext<'_>) -> bool {
    if !locator.is_plain_object() || !locator.get("keeper").and_then(Value::as_str).is_some_and(is_origin_id) {
        return false;
    }
    if locator.get("keeper").and_then(Value::as_str) != Some(context.keeper_reservation) {
        return false;
    }
    let under = |root: Option<&str>, separator: &str| {
        keys(locator) == "keeper,path" && is_path(locator.get("path"), 1024) && {
            let path = locator.get("path").and_then(Value::as_str).unwrap_or_default();
            match path.rfind(separator) {
                Some(at) => is_supervisor_handle(&path[at + separator.len()..]) && root.is_none_or(|root| &path[..at] == root),
                None => false,
            }
        }
    };
    match kind {
        CreateKind::RuntimeDir => under(context.runtime_root, "/x/"),
        CreateKind::Cgroup => under(context.cgroup_subtree, "/x-"),
        CreateKind::Netns => keys(locator) == "keeper,netns" && locator_id(locator.get("netns")),
        CreateKind::Pty => keys(locator) == "keeper,pty" && locator_id(locator.get("pty")),
        CreateKind::Endpoint | CreateKind::ProcessTree => {
            keys(locator) == "id,keeper,marker,role" && locator.get("role").and_then(Value::as_str) == Some(kind.as_str())
                && locator_id(locator.get("id")) && locator.get("marker").and_then(Value::as_str) == marker
        }
    }
}

fn env_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=128).contains(&bytes.len()) && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_') && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn inventory_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len()) && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `specProblem(kind, spec, context)`, as a parsed spec.
fn spec_for(kind: CreateKind, spec: &Value, context: &RequestContext<'_>) -> Option<Spec> {
    if !spec.is_plain_object() {
        return None;
    }
    let endpoint = context.endpoint;
    match kind {
        CreateKind::RuntimeDir | CreateKind::Netns | CreateKind::Cgroup => keys(spec).is_empty().then_some(Spec::Empty),
        CreateKind::Pty => {
            (keys(spec) == "cols,rows").then_some(())?;
            Some(Spec::Pty { cols: count(spec, "cols", 1, 65535)?, rows: count(spec, "rows", 1, 65535)? })
        }
        CreateKind::Endpoint => {
            (keys(spec) == "config,netns").then_some(())?;
            let netns = string(spec, "netns").filter(|handle| is_supervisor_handle(handle))?;
            let config = spec.get("config").filter(|config| config.is_plain_object())?;
            (keys(config) == "limits,relays,streamDirectory" && is_path(config.get("streamDirectory"), endpoint.max_path_bytes)).then_some(())?;
            let limits_ok = config.get("limits").and_then(Value::as_object).is_some_and(|entries| {
                entries.iter().all(|(name, value)| {
                    ENDPOINT_LIMIT_DEFAULTS.iter().any(|(known, _)| known == name) && value.as_safe_int().is_some_and(|number| number >= 1)
                })
            });
            let relays_ok = match config.get("relays") {
                Some(Value::Array(relays)) => relays.len() <= 16 && relays.iter().all(|relay| {
                    relay.is_plain_object() && keys(relay) == "port,target" && count(relay, "port", 1, 65535).is_some()
                        && is_path(relay.get("target"), endpoint.max_path_bytes)
                }),
                _ => false,
            };
            (limits_ok && relays_ok).then(|| Spec::Endpoint { netns, config: config.clone() })
        }
        CreateKind::ProcessTree => match spec.get("role").and_then(Value::as_str) {
            Some("orchestration") => {
                (keys(spec) == "args,env,netns,role,script" && spec.get("netns") == Some(&Value::Null) && is_path(spec.get("script"), endpoint.max_path_bytes)).then_some(())?;
                let script = string(spec, "script")?;
                if let Some(root) = context.orchestration_root {
                    if !script.starts_with(&format!("{root}/")) {
                        return None;
                    }
                }
                let args = string_list(spec.get("args"), 256, endpoint.max_arg_bytes)?;
                let env = spec.get("env").and_then(Value::as_object)?;
                if env.len() > endpoint.max_env_entries {
                    return None;
                }
                let env: Option<Vec<(String, String)>> = env
                    .iter()
                    .map(|(name, value)| value.as_str().filter(|text| env_name_ok(name) && text.len() <= endpoint.max_env_value_bytes).map(|text| (name.clone(), text.to_string())))
                    .collect();
                Some(Spec::Orchestration { script, args, env: env? })
            }
            Some("workload") => {
                (keys(spec) == "netns,process,request,role,streams").then_some(())?;
                let netns = string(spec, "netns").filter(|handle| is_supervisor_handle(handle))?;
                let process = count(spec, "process", 1, 1_000_000)?;
                let streams = spec.get("streams").and_then(Value::as_object)?;
                let streams_ok = !streams.is_empty()
                    && streams.iter().all(|(name, path)| matches!(name.as_str(), "stderr" | "stdin" | "stdout") && virtual_path_ok(Some(path), endpoint.max_path_bytes));
                let request = spec.get("request")?;
                (streams_ok && start_request_ok(request, endpoint)).then_some(())?;
                let streams = streams.iter().map(|(name, path)| (name.clone(), path.as_str().unwrap_or_default().to_string())).collect();
                Some(Spec::Workload { process, request: request.clone(), streams, netns })
            }
            Some("terminal") => {
                (keys(spec) == "argv,cwd,netns,pty,role" && is_path(spec.get("cwd"), endpoint.max_path_bytes)).then_some(())?;
                let pty = string(spec, "pty").filter(|handle| is_supervisor_handle(handle))?;
                let netns = match spec.get("netns") {
                    Some(Value::Null) => None,
                    Some(value) if is_handle_value(value) => value.as_str().map(str::to_string),
                    _ => return None,
                };
                let argv = string_list(spec.get("argv"), 256, endpoint.max_arg_bytes).filter(|argv| !argv.is_empty() && inventory_name_ok(&argv[0]))?;
                Some(Spec::Terminal { pty, argv, cwd: string(spec, "cwd")?, netns })
            }
            _ => None,
        },
    }
}

const ID_OP: &str = "id,op";
const MOUNT_KEYS: &str = "access,allowOther,descriptorCap,expectedRootIdentity,grantId,id,mountpoint,op,propagation,rlimitNofile,rootLease,rootSlot";

/// Stage 1 of `mount_view`: exact keys and JSON types.
fn mount_stage1(frame: &Value) -> bool {
    let typed = |key: &str, kind: &str| match (kind, frame.get(key)) {
        ("string", Some(Value::String(_))) => true,
        ("integer", Some(value)) => value.as_safe_int().is_some(),
        ("object", Some(value)) => value.is_plain_object(),
        ("boolean", Some(Value::Bool(_))) => true,
        _ => false,
    };
    let identity = frame.get("expectedRootIdentity").cloned().unwrap_or(Value::Null);
    let lease = frame.get("rootLease").cloned().unwrap_or(Value::Null);
    keys(frame) == MOUNT_KEYS
        && [("grantId", "string"), ("rootSlot", "integer"), ("expectedRootIdentity", "object"), ("access", "string"), ("mountpoint", "string"),
            ("propagation", "string"), ("allowOther", "boolean"), ("descriptorCap", "integer"), ("rlimitNofile", "integer"), ("rootLease", "object")]
            .iter()
            .all(|(key, kind)| typed(key, kind))
        && keys(&identity) == "dev,ino" && identity.get("dev").and_then(Value::as_str).is_some() && identity.get("ino").and_then(Value::as_str).is_some()
        && keys(&lease) == "epoch,ttlMs" && lease.get("epoch").and_then(Value::as_safe_int).is_some() && lease.get("ttlMs").and_then(Value::as_safe_int).is_some()
}

/// Decodes and validates one request frame (keeperFrames.mjs `validateKeeperRequest`).
pub fn decode_request(frame: &Value, context: &RequestContext<'_>) -> Verdict {
    use Verdict::Violation as V;
    let Some(id) = frame.get("id").and_then(Value::as_safe_int).filter(|id| *id >= 1 && *id <= MAX_ID).filter(|_| frame.is_plain_object()) else {
        return V("bad_frame");
    };
    let Some(op) = frame.get("op").and_then(Value::as_str).map(str::to_string) else { return V("bad_frame") };
    let ok = |request: Request| Verdict::Ok(Decoded { id, op: op.clone(), request });
    let exact = |expected: &str| keys(frame) == expected;
    let handle = string(frame, "resource").filter(|value| is_supervisor_handle(value));
    let encoded = json::stringify(frame).len() as i64;
    match op.as_str() {
        "commit_keeper" | "ping" | "tempdir" | "end_process_trees" | "end_endpoint" | "release_egress" | "release_views" | "remove_runtime" | "shutdown"
        | "inventory" => {
            if !exact(ID_OP) {
                return V("bad_frame");
            }
            ok(match op.as_str() {
                "commit_keeper" => Request::CommitKeeper,
                "ping" => Request::Ping,
                "tempdir" => Request::Tempdir,
                "end_process_trees" => Request::EndProcessTrees,
                "end_endpoint" => Request::EndEndpoint,
                "release_egress" => Request::ReleaseEgress,
                "release_views" => Request::ReleaseViews,
                "remove_runtime" => Request::RemoveRuntime,
                "shutdown" => Request::Shutdown,
                _ => Request::Inventory,
            })
        }
        "create" => {
            let (Some(resource), Some(kind_text)) = (handle, string(frame, "kind")) else { return V("bad_frame") };
            if !exact("id,kind,locator,marker,op,resource,spec") {
                return V("bad_frame");
            }
            if !RESOURCE_KINDS.contains(&kind_text.as_str()) {
                return V("bad_frame");
            }
            let Some(kind) = CreateKind::parse(&kind_text) else {
                return Verdict::Refused { id, code: "kind_not_supported".into() };
            };
            let marker = match frame.get("marker") {
                Some(Value::String(marker)) if kind.process_bearing() && is_origin_id(marker) => Some(marker.clone()),
                Some(Value::Null) if !kind.process_bearing() => None,
                _ => return V("bad_frame"),
            };
            let locator = frame.get("locator").cloned().unwrap_or(Value::Null);
            if !locator_ok(kind, &locator, marker.as_deref(), context) {
                return V("bad_frame");
            }
            let Some(spec) = spec_for(kind, frame.get("spec").unwrap_or(&Value::Null), context) else { return V("bad_frame") };
            if kind == CreateKind::Cgroup && context.cgroup_subtree.is_none() {
                return Verdict::Refused { id, code: "cgroup_not_delegated".into() };
            }
            ok(Request::Create { resource, kind, marker, locator, spec })
        }
        "commit" => {
            let resource = string(frame, "resource").filter(|value| is_supervisor_handle(value) || is_mount_handle(value));
            match (exact("id,op,resource"), resource) {
                (true, Some(resource)) => ok(Request::Commit { resource }),
                _ => V("bad_frame"),
            }
        }
        "abort_uncommitted" => {
            let list = string_list(frame.get("resources"), MAX_ABORT_HANDLES, 64).filter(|list| {
                !list.is_empty() && list.iter().all(|value| is_supervisor_handle(value) || is_mount_handle(value))
                    && list.iter().collect::<std::collections::HashSet<_>>().len() == list.len()
            });
            match (exact("id,op,resources"), list) {
                (true, Some(resources)) => ok(Request::AbortUncommitted { resources }),
                _ => V("bad_frame"),
            }
        }
        "stop" => match (exact("graceMs,id,op,resource"), handle, count(frame, "graceMs", 0, MAX_GRACE_MS)) {
            (true, Some(resource), Some(grace_ms)) => ok(Request::Stop { resource, grace_ms }),
            _ => V("bad_frame"),
        },
        "pty_input" => {
            let seq = frame.get("seq").and_then(Value::as_str).and_then(parse_seq);
            let data = frame.get("data").and_then(Value::as_str).and_then(base64_decode).filter(|data| !data.is_empty() && data.len() as i64 <= context.limits.pty_chunk_bytes);
            let (true, Some(resource), Some(seq), Some(data)) = (exact("data,id,op,resource,seq"), handle, seq, data) else { return V("bad_frame") };
            if encoded > pty_frame_cap(context.limits) {
                return V("oversize_frame");
            }
            ok(Request::PtyInput { resource, seq, data })
        }
        "pty_resize" => match (exact("cols,id,op,resource,rows"), handle, count(frame, "cols", 1, 65535), count(frame, "rows", 1, 65535)) {
            (true, Some(resource), Some(cols), Some(rows)) => ok(Request::PtyResize { resource, cols, rows }),
            _ => V("bad_frame"),
        },
        "pty_credit" => match (exact("bytes,id,op,resource"), handle, count(frame, "bytes", 1, context.limits.pty_max_credit_bytes)) {
            (true, Some(resource), Some(bytes)) => ok(Request::PtyCredit { resource, bytes }),
            _ => V("bad_frame"),
        },
        "mount_view" => {
            if !mount_stage1(frame) {
                return V("bad_frame");
            }
            if encoded > context.view.max_mount_frame_bytes {
                return V("oversize_frame");
            }
            let Some(mount) = context.mount else { return ok(Request::MountView(frame.clone())) };
            let request = match validate_mount_request(frame, mount, context.view) {
                Ok(request) => request,
                Err("bad_frame") => return V("bad_frame"),
                Err(code) => return Verdict::Refused { id, code: wire_code(code) },
            };
            let mut set = MountSet::default();
            for prior in context.prior {
                set.record(prior);
            }
            if let Err(code) = set.check(&request, context.view) {
                return Verdict::Refused { id, code: wire_code(code) };
            }
            ok(Request::MountView(frame.clone()))
        }
        "unmount_view" => {
            let resource = string(frame, "resource").filter(|value| is_mount_handle(value));
            let (true, Some(resource)) = (exact("id,op,resource"), resource) else { return V("bad_frame") };
            if encoded > context.view.max_mount_frame_bytes {
                return V("oversize_frame");
            }
            if validate_unmount_request(frame).is_err() {
                return V("bad_frame");
            }
            ok(Request::UnmountView { resource })
        }
        "view_root_lease" => {
            let shape = match frame.get("verdict").and_then(Value::as_str) {
                Some("renew") => exact("epoch,grantId,id,op,ttlMs,verdict") && frame.get("ttlMs").and_then(Value::as_safe_int).is_some(),
                Some("revoke") => exact("epoch,grantId,id,op,reason,verdict") && frame.get("reason").and_then(Value::as_str).is_some(),
                _ => false,
            };
            if !shape || frame.get("grantId").and_then(Value::as_str).is_none() || frame.get("epoch").and_then(Value::as_safe_int).is_none() {
                return V("bad_frame");
            }
            if encoded > context.view.max_mount_frame_bytes {
                return V("oversize_frame");
            }
            match validate_root_lease_frame(frame, context.view) {
                Ok(_) => ok(Request::ViewRootLease(frame.clone())),
                Err("bad_ttl") => Verdict::Refused { id, code: "bad_ttl".into() },
                Err(_) => V("bad_frame"),
            }
        }
        _ => V("unknown_op"),
    }
}

/// R3 L1: lease renewals use the channel and per-grant bounds, independent of mount slots.
pub const MOUNT_OPS: [&str; 2] = ["mount_view", "unmount_view"];

/// The keeper's admission (keeperFrames.mjs `createKeeperAdmission`; R1.2, N-A, R2.3): ids rise strictly; every request
/// except `pty_input` counts toward `maxInFlight`; the mount ops also count toward `maxMountInFlight` (view limits);
/// `pty_input` counts only toward its pty's window (frames and raw bytes); `settle(id)` runs once the reply has been
/// written. A conforming supervisor never exceeds a bound, so every breach is a violation.
#[derive(Debug)]
pub struct Admission {
    last_id: i64,
    in_flight: std::collections::HashSet<i64>,
    max_mount_in_flight: usize,
    mount_in_flight: std::collections::HashSet<i64>,
    lease_of: std::collections::HashMap<i64, String>,
    lease_grants: std::collections::HashSet<String>,
    pty_windows: std::collections::HashMap<String, (usize, usize)>,
    pty_of: std::collections::HashMap<i64, (String, usize)>,
}

impl Default for Admission {
    fn default() -> Self {
        Admission::new(&ViewLimits::default())
    }
}

impl Admission {
    pub fn new(view: &ViewLimits) -> Self {
        Admission {
            last_id: 0, in_flight: Default::default(), max_mount_in_flight: view.max_mount_in_flight.max(0) as usize, mount_in_flight: Default::default(),
            pty_windows: Default::default(), pty_of: Default::default(), lease_of: Default::default(), lease_grants: Default::default(),
        }
    }

    pub fn admit(&mut self, id: i64, op: &str, resource: Option<&str>, pty_bytes: usize, lease_grant: Option<&str>, limits: &KeeperLimits) -> Result<(), Violation> {
        if id <= self.last_id {
            return Err("duplicate_id");
        }
        self.last_id = id;
        if op == "pty_input" {
            let resource = resource.unwrap_or_default().to_string();
            let window = self.pty_windows.entry(resource.clone()).or_insert((0, 0));
            if window.0 + 1 > limits.pty_input_window_frames as usize || window.1 + pty_bytes > limits.pty_input_window_bytes as usize {
                return Err("pty_input_window");
            }
            window.0 += 1;
            window.1 += pty_bytes;
            self.pty_of.insert(id, (resource, pty_bytes));
            return Ok(());
        }
        if self.in_flight.len() >= limits.max_in_flight as usize {
            return Err("in_flight_overflow");
        }
        let lease = (op == "view_root_lease").then(|| lease_grant.unwrap_or_default());
        if lease.is_some_and(|grant| self.lease_grants.contains(grant)) {
            return Err("lease_in_flight_overflow");
        }
        let mount = MOUNT_OPS.contains(&op);
        if mount && self.mount_in_flight.len() >= self.max_mount_in_flight {
            // R2.3. The code is native-chosen until the S4 r9 vectors pin it.
            return Err("mount_in_flight_overflow");
        }
        self.in_flight.insert(id);
        if let Some(grant) = lease {
            self.lease_grants.insert(grant.to_string());
            self.lease_of.insert(id, grant.to_string());
        }
        if mount {
            self.mount_in_flight.insert(id);
        }
        Ok(())
    }

    pub fn settle(&mut self, id: i64) {
        if let Some((resource, bytes)) = self.pty_of.remove(&id) {
            if let Some(window) = self.pty_windows.get_mut(&resource) {
                window.0 -= 1;
                window.1 -= bytes;
            }
            return;
        }
        self.in_flight.remove(&id);
        self.mount_in_flight.remove(&id);
        if let Some(grant) = self.lease_of.remove(&id) {
            self.lease_grants.remove(&grant);
        }
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.len()
    }
}

// ---- replies and events ---------------------------------------------------------------------------------------------

pub fn ok_reply(id: i64, value: Value) -> Value {
    obj(vec![("id", int(id)), ("ok", Value::Bool(true)), ("value", value)])
}

pub fn empty() -> Value {
    Value::Object(Vec::new())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Refused,
    Failure,
}

pub fn error_reply(id: i64, kind: ErrorKind, code: &str) -> Value {
    debug_assert!(crate::mount_frames::is_error_code(code), "{code}");
    obj(vec![
        ("id", int(id)),
        ("ok", Value::Bool(false)),
        ("kind", text(match kind { ErrorKind::Refused => "refused", ErrorKind::Failure => "failure" })),
        ("error", text(code)),
    ])
}

pub fn hello_event(pid: i64, start_time: u64, marker: &str, limits: Value) -> Value {
    obj(vec![
        ("event", text("hello")),
        ("protocol", text(PROTOCOL)),
        ("version", int(VERSION)),
        ("pid", int(pid)),
        ("startTime", text(&start_time.to_string())),
        ("marker", text(marker)),
        ("limits", limits),
    ])
}

pub fn exit_event(resource: &str, code: Option<i64>, signal: Option<&str>) -> Value {
    obj(vec![
        ("event", text("exit")),
        ("resource", text(resource)),
        ("code", code.map(int).unwrap_or(Value::Null)),
        ("signal", signal.map(text).unwrap_or(Value::Null)),
    ])
}

pub fn pty_output_event(resource: &str, seq: u64, data: &[u8]) -> Value {
    obj(vec![("event", text("pty_output")), ("resource", text(resource)), ("seq", text(&seq.to_string())), ("data", text(&base64_encode(data)))])
}

pub fn pty_closed_event(resource: &str) -> Value {
    obj(vec![("event", text("pty_closed")), ("resource", text(resource))])
}

/// Wire identities (§3 identity table). Inodes, devices and start times are canonical decimal strings; pids integers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WireIdentity {
    RuntimeDir { path: String, dev: u64, ino: u64 },
    Netns { net_ns: u64 },
    Cgroup { path: String, cgroup_id: u64 },
    Pty { pty: String, devpts_dev: u64, index: i64 },
    Process { pid: i64, start_time: u64, pid_ns: u64 },
}

impl WireIdentity {
    pub fn to_value(&self) -> Value {
        let decimal = |value: u64| text(&value.to_string());
        match self {
            WireIdentity::RuntimeDir { path, dev, ino } => obj(vec![("path", text(path)), ("dev", decimal(*dev)), ("ino", decimal(*ino))]),
            WireIdentity::Netns { net_ns } => obj(vec![("netNs", decimal(*net_ns))]),
            WireIdentity::Cgroup { path, cgroup_id } => obj(vec![("path", text(path)), ("cgroupId", decimal(*cgroup_id))]),
            WireIdentity::Pty { pty, devpts_dev, index } => obj(vec![("pty", text(pty)), ("devptsDev", decimal(*devpts_dev)), ("index", int(*index))]),
            WireIdentity::Process { pid, start_time, pid_ns } => obj(vec![("pid", int(*pid)), ("startTime", decimal(*start_time)), ("pidNs", decimal(*pid_ns))]),
        }
    }
}

pub fn create_value(resource: &str, identity: &WireIdentity) -> Value {
    obj(vec![("resource", text(resource)), ("identity", identity.to_value())])
}

pub fn state_value(state: &str) -> Value {
    obj(vec![("state", text(state))])
}

pub fn seq_value(seq: u64) -> Value {
    obj(vec![("seq", text(&seq.to_string()))])
}

/// Encoded length of a frame payload, as the decoder saw it.
pub fn encoded_len(value: &Value) -> usize {
    json::stringify(value).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_canonical() {
        for (bytes, text) in [(&b""[..], ""), (b"f", "Zg=="), (b"fo", "Zm8="), (b"foo", "Zm9v"), (b"\xff\xfe", "//4=")] {
            assert_eq!(base64_encode(bytes), text);
            assert_eq!(base64_decode(text).as_deref(), Some(bytes));
        }
        for bad in ["Zg", "Zh==", "Zm9=", "Zg=", "Z===", "Zm-v", "Zm9v\n", "=Zg="] {
            assert_eq!(base64_decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn origin_ids_and_handles() {
        let id = "AAECAwQFBgcICQoLDA0ODw";
        assert!(is_origin_id(id));
        assert_eq!(handle_for_resource_id(id).as_deref(), Some("000102030405060708090a0b0c0d0e0f"));
        assert!(is_origin_id("-_8AAAAAAAAAAAAAAAAAAA"));
        assert!(!is_origin_id("AAECAwQFBgcICQoLDA0ODx"), "non-zero trailing bits");
        assert!(!is_origin_id("AAECAwQFBgcICQoLDA0OD"));
        assert!(is_mount_handle("m000102030405060708090a0b0c0d0e0f"));
        assert!(!is_supervisor_handle("000102030405060708090A0B0C0D0E0F"));
    }

    #[test]
    fn sequences() {
        assert_eq!(parse_seq("1"), Some(1));
        assert_eq!(parse_seq("18446744073709551615"), Some(u64::MAX));
        for bad in ["0", "01", "18446744073709551616", "", "+1", "1.0", " 1"] {
            assert_eq!(parse_seq(bad), None, "{bad}");
        }
    }

    #[test]
    fn wire_codes() {
        assert_eq!(wire_code("duplicate_grantId"), "duplicate_grant_id");
        assert_eq!(wire_code("duplicate_root_slot"), "duplicate_root_slot");
    }

    #[test]
    fn mount_ops_are_bounded_among_themselves_by_max_mount_in_flight() {
        // R3 L1: leases do not consume mount slots.
        let limits = KeeperLimits::default();
        let mut admission = Admission::new(&ViewLimits::default());
        let mut id = 0;
        let mut next = |admission: &mut Admission, op: &str| {
            id += 1;
            (id, admission.admit(id, op, None, 0, Some("proj"), &limits))
        };
        for op in ["mount_view", "unmount_view", "mount_view", "unmount_view"] {
            assert_eq!(next(&mut admission, op).1, Ok(()), "{op}");
        }
        assert_eq!(next(&mut admission, "ping").1, Ok(()), "other ops are not mount-bounded");
        assert_eq!(next(&mut admission, "mount_view").1, Err("mount_in_flight_overflow"));
        admission.settle(2);
        assert_eq!(next(&mut admission, "mount_view").1, Ok(()), "a settled mount op frees its slot");
        assert_eq!(admission.in_flight(), 5);
        // A smaller configured bound is honoured.
        let mut small = Admission::new(&ViewLimits { max_mount_in_flight: 1, ..ViewLimits::default() });
        assert_eq!(small.admit(1, "mount_view", None, 0, None, &limits), Ok(()));
        assert_eq!(small.admit(2, "unmount_view", None, 0, None, &limits), Err("mount_in_flight_overflow"));
    }

    #[test]
    fn lease_admission_is_per_grant_and_channel_bounded_independently_of_mounts() {
        let limits = KeeperLimits::default();
        let mut admission = Admission::default();
        for id in 1..=4 {
            assert_eq!(admission.admit(id, "unmount_view", None, 0, None, &limits), Ok(()));
        }
        for id in 5..=12 {
            assert_eq!(admission.admit(id, "view_root_lease", None, 0, Some(&format!("g{id}")), &limits), Ok(()));
        }
        assert_eq!(admission.admit(13, "view_root_lease", None, 0, Some("g5"), &limits), Err("lease_in_flight_overflow"));
        for id in 14..=17 {
            assert_eq!(admission.admit(id, "ping", None, 0, None, &limits), Ok(()));
        }
        assert_eq!(admission.in_flight(), 16);
        assert_eq!(admission.admit(18, "view_root_lease", None, 0, Some("fresh"), &limits), Err("in_flight_overflow"));
        admission.settle(5);
        assert_eq!(admission.admit(19, "view_root_lease", None, 0, Some("g5"), &limits), Ok(()));
        admission.settle(19);
        assert_eq!(admission.admit(20, "unmount_view", None, 0, None, &limits), Err("mount_in_flight_overflow"));
        admission.settle(1);
        assert_eq!(admission.admit(21, "unmount_view", None, 0, None, &limits), Ok(()));
    }
}

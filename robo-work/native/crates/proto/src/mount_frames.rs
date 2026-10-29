//! The keeper's filtered-view frames (plan sections 5.4 and 5.5, review R4-7, decision D-S5-6), keeper side.
//!
//! A line-by-line port of the validators in `robo-work/server/views/mountFrames.mjs` (S5 r5) plus the reply
//! builders whose output that module's reply validators accept. Frames (inside the length-prefixed frames of
//! [`crate::frame`]):
//!
//! ```text
//! supervisor -> keeper  { id, op: 'mount_view', grantId, rootSlot, expectedRootIdentity: { dev, ino }, access,
//!                         mountpoint, propagation: 'private', allowOther: true, descriptorCap, rlimitNofile,
//!                         rootLease: { epoch: 1, ttlMs } }
//! supervisor -> keeper  { id, op: 'unmount_view', resource }
//! supervisor -> keeper  { id, op: 'view_root_lease', grantId, epoch, verdict: 'renew', ttlMs }
//!                       { id, op: 'view_root_lease', grantId, epoch, verdict: 'revoke', reason }
//! keeper -> supervisor  { id, ok: true, value: { resource, mount: { mountId, mountpoint, mountNamespaceInode },
//!                         fileServer: { pid, startTime, pidNamespaceInode } } }
//!                       { id, ok: true, value: { state: 'live' | 'revoking' | 'killed' } }
//!                       { id, ok: false, kind: 'refused' | 'failure', error }      (error is a code string)
//! ```
//!
//! A frame never carries a source path or a descriptor. The grant root arrives by inheritance at keeper spawn, at
//! slot `firstGrantRootSlot + index`; a mount request names the slot and the identity it expects there.
//!
//! The reply to `unmount_view` has no validator in the frozen Node module. The keeper answers `{ id, ok: true }` or a
//! refusal; that shape is a native-side choice that the supervisor slice must confirm (reported as a contract gap).

use crate::json::{self, Value, int, obj, text};
use crate::limits::ViewLimits;

pub const PROPAGATION: &str = "private";
pub const MAX_PID: i64 = 4_194_304;
const MOUNT_KEYS: &str = "access,allowOther,descriptorCap,expectedRootIdentity,grantId,id,mountpoint,op,propagation,rlimitNofile,rootLease,rootSlot";
const UNMOUNT_KEYS: &str = "id,op,resource";
const LEASE_RENEW_KEYS: &str = "epoch,grantId,id,op,ttlMs,verdict";
const LEASE_REVOKE_KEYS: &str = "epoch,grantId,id,op,reason,verdict";
const SOURCE_PATH_KEYS: &[&str] = &["source", "sourcePath", "path", "hostPath", "backingPath", "root", "rootPath", "target", "dir", "directory"];
pub const LEASE_STATES: &[&str] = &["live", "revoking", "killed"];

pub fn is_grant_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
        && bytes.iter().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `/^[a-z0-9]{8,64}$/u` (reservation and resource ids).
pub fn is_opaque_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9'))
}

/// `/^[0-9]{1,20}$/u`.
pub fn is_digits(value: &Value) -> bool {
    value.as_str().is_some_and(|text| (1..=20).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit()))
}

/// `/^[a-z][a-z0-9_]{0,63}$/u`.
pub fn is_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

pub fn is_count(value: Option<&Value>, minimum: i64, maximum: i64) -> bool {
    value.and_then(Value::as_safe_int).is_some_and(|number| number >= minimum && number <= maximum)
}

fn is_lease_ttl(value: Option<&Value>, limits: &ViewLimits) -> bool {
    is_count(value, 1, limits.root_lease_ttl_ms)
}

fn has_source_path_key(frame: &Value) -> bool {
    frame.as_object().is_some_and(|entries| entries.iter().any(|(key, _)| SOURCE_PATH_KEYS.contains(&key.as_str())))
}

fn grant_id_ok(value: Option<&Value>, limits: &ViewLimits) -> bool {
    value.and_then(Value::as_str).is_some_and(|grant| grant.len() as i64 <= limits.max_grant_id_bytes && is_grant_id(grant))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Execution,
    Gui,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountContext {
    pub scope: Scope,
    pub runtime_root: String,
    pub reservation_id: String,
    pub grant_count: i64,
}

/// `viewMountpoint({ scope, runtimeRoot, reservationId, grantId })`.
pub fn view_mountpoint(scope: Scope, runtime_root: &str, reservation_id: &str, grant_id: &str) -> Result<String, &'static str> {
    let normalized = runtime_root.starts_with('/')
        && runtime_root.len() >= 2
        && !runtime_root.ends_with('/')
        && runtime_root.split('/').enumerate().all(|(index, part)| index == 0 || !(part.is_empty() || part == "." || part == ".."));
    if !normalized {
        return Err("bad_runtime_root");
    }
    if !is_opaque_id(reservation_id) {
        return Err("bad_reservation_id");
    }
    if !is_grant_id(grant_id) {
        return Err("bad_grant_id");
    }
    Ok(match scope {
        Scope::Execution => format!("{runtime_root}/x/{reservation_id}/views/{grant_id}"),
        Scope::Gui => format!("{runtime_root}/gui/{reservation_id}/{grant_id}"),
    })
}

/// `descriptorCapProblem({ cap, rlimitNofile })`: None when acceptable.
pub fn descriptor_cap_problem(cap: i64, rlimit_nofile: i64, limits: &ViewLimits) -> Option<&'static str> {
    if cap <= 0 || cap > json::MAX_SAFE_INTEGER {
        return Some("cap_not_positive");
    }
    if rlimit_nofile <= 0 || rlimit_nofile > json::MAX_SAFE_INTEGER {
        return Some("rlimit_not_positive");
    }
    if cap + limits.file_server_inherited_descriptors + limits.rlimit_headroom > rlimit_nofile {
        return Some("cap_not_below_rlimit");
    }
    None
}

/// A validated `mount_view` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountRequest {
    pub id: i64,
    pub grant_id: String,
    pub root_slot: i64,
    pub expected_dev: String,
    pub expected_ino: String,
    pub read_only: bool,
    pub mountpoint: String,
    pub descriptor_cap: i64,
    pub rlimit_nofile: i64,
    pub lease_ttl_ms: i64,
}

/// `validateMountRequest(frame, context)`. Ok carries the parsed request; Err the refusal code.
pub fn validate_mount_request(frame: &Value, context: &MountContext, limits: &ViewLimits) -> Result<MountRequest, &'static str> {
    if !frame.is_plain_object() {
        return Err("bad_frame");
    }
    if has_source_path_key(frame) {
        return Err("source_path_not_allowed");
    }
    if frame.sorted_keys().as_deref() != Some(MOUNT_KEYS)
        || frame.get("op").and_then(Value::as_str) != Some("mount_view")
        || !is_count(frame.get("id"), 1, 1_000_000_000)
    {
        return Err("bad_frame");
    }
    if !grant_id_ok(frame.get("grantId"), limits) {
        return Err("bad_grant_id");
    }
    let grant_id = frame.get("grantId").and_then(Value::as_str).unwrap_or_default().to_string();
    let slots = if (1..=limits.max_views_per_keeper).contains(&context.grant_count) { context.grant_count } else { 0 };
    if !is_count(frame.get("rootSlot"), limits.first_grant_root_slot, limits.first_grant_root_slot + slots - 1) {
        return Err("root_slot_out_of_range");
    }
    let identity = frame.get("expectedRootIdentity").cloned().unwrap_or(Value::Null);
    if !identity.is_plain_object()
        || identity.sorted_keys().as_deref() != Some("dev,ino")
        || !identity.get("dev").is_some_and(is_digits)
        || !identity.get("ino").is_some_and(is_digits)
    {
        return Err("bad_root_identity");
    }
    let access = frame.get("access").and_then(Value::as_str);
    if access != Some("read") && access != Some("write") {
        return Err("bad_access");
    }
    if frame.get("propagation").and_then(Value::as_str) != Some(PROPAGATION) {
        return Err("propagation_not_private");
    }
    if frame.get("allowOther").and_then(Value::as_bool) != Some(true) {
        return Err("allow_other_required");
    }
    let expected = view_mountpoint(context.scope, &context.runtime_root, &context.reservation_id, &grant_id).map_err(|_| "bad_context")?;
    if expected.len() as i64 > limits.max_mountpoint_bytes {
        return Err("mountpoint_too_long");
    }
    if frame.get("mountpoint").and_then(Value::as_str) != Some(expected.as_str()) {
        return Err("mountpoint_not_locator");
    }
    let cap_ok = is_count(frame.get("descriptorCap"), 1, json::MAX_SAFE_INTEGER) && is_count(frame.get("rlimitNofile"), 1, json::MAX_SAFE_INTEGER);
    let cap = frame.get("descriptorCap").and_then(Value::as_safe_int).unwrap_or(0);
    let rlimit = frame.get("rlimitNofile").and_then(Value::as_safe_int).unwrap_or(0);
    if !cap_ok || descriptor_cap_problem(cap, rlimit, limits).is_some() {
        return Err("descriptor_cap_invalid");
    }
    let lease = frame.get("rootLease").cloned().unwrap_or(Value::Null);
    if !lease.is_plain_object()
        || lease.sorted_keys().as_deref() != Some("epoch,ttlMs")
        || lease.get("epoch").and_then(Value::as_safe_int) != Some(1)
        || !is_lease_ttl(lease.get("ttlMs"), limits)
    {
        return Err("bad_root_lease");
    }
    Ok(MountRequest {
        id: frame.get("id").and_then(Value::as_safe_int).unwrap_or(0),
        grant_id,
        root_slot: frame.get("rootSlot").and_then(Value::as_safe_int).unwrap_or(0),
        expected_dev: identity.get("dev").and_then(Value::as_str).unwrap_or_default().to_string(),
        expected_ino: identity.get("ino").and_then(Value::as_str).unwrap_or_default().to_string(),
        read_only: access == Some("read"),
        mountpoint: expected,
        descriptor_cap: cap,
        rlimit_nofile: rlimit,
        lease_ttl_ms: lease.get("ttlMs").and_then(Value::as_safe_int).unwrap_or(0),
    })
}

/// `validateUnmountRequest(frame)`. Ok carries the resource id.
pub fn validate_unmount_request(frame: &Value) -> Result<String, &'static str> {
    let resource = frame.get("resource").and_then(Value::as_str);
    if !frame.is_plain_object()
        || frame.sorted_keys().as_deref() != Some(UNMOUNT_KEYS)
        || frame.get("op").and_then(Value::as_str) != Some("unmount_view")
        || !is_count(frame.get("id"), 1, 1_000_000_000)
        || !resource.is_some_and(is_opaque_id)
    {
        return Err("bad_frame");
    }
    Ok(resource.unwrap_or_default().to_string())
}

/// The requests of one keeper together: bounded, and no two share an id, grant, slot or mountpoint
/// (`validateMountSet`, applied incrementally as requests arrive). Codes are S5 r7's snake_case
/// (`duplicate_id`, `duplicate_grant_id`, `duplicate_root_slot`, `duplicate_mountpoint`, `bad_mount_set`), pinned
/// against the Node strings by `tests/golden.rs`.
#[derive(Debug, Default)]
pub struct MountSet {
    ids: Vec<i64>,
    grants: Vec<String>,
    slots: Vec<i64>,
    mountpoints: Vec<String>,
}

impl MountSet {
    pub fn check(&self, request: &MountRequest, limits: &ViewLimits) -> Result<(), &'static str> {
        if self.ids.len() as i64 >= limits.max_views_per_keeper {
            return Err("bad_mount_set");
        }
        if self.ids.contains(&request.id) {
            return Err("duplicate_id");
        }
        if self.grants.contains(&request.grant_id) {
            return Err("duplicate_grant_id");
        }
        if self.slots.contains(&request.root_slot) {
            return Err("duplicate_root_slot");
        }
        if self.mountpoints.contains(&request.mountpoint) {
            return Err("duplicate_mountpoint");
        }
        Ok(())
    }

    pub fn record(&mut self, request: &MountRequest) {
        self.ids.push(request.id);
        self.grants.push(request.grant_id.clone());
        self.slots.push(request.root_slot);
        self.mountpoints.push(request.mountpoint.clone());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseVerdict {
    Renew { ttl_ms: i64 },
    Revoke { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseFrame {
    pub id: i64,
    pub grant_id: String,
    pub epoch: i64,
    pub verdict: LeaseVerdict,
}

/// `validateRootLeaseFrame(frame)`: codes `source_path_not_allowed`, `bad_frame`, `bad_ttl`.
pub fn validate_root_lease_frame(frame: &Value, limits: &ViewLimits) -> Result<LeaseFrame, &'static str> {
    if !frame.is_plain_object() {
        return Err("bad_frame");
    }
    if has_source_path_key(frame) {
        return Err("source_path_not_allowed");
    }
    if frame.get("op").and_then(Value::as_str) != Some("view_root_lease") || !is_count(frame.get("id"), 1, 1_000_000_000) {
        return Err("bad_frame");
    }
    if !grant_id_ok(frame.get("grantId"), limits) {
        return Err("bad_frame");
    }
    let epoch = match frame.get("epoch").and_then(Value::as_safe_int) {
        Some(epoch) if epoch >= 2 => epoch,
        _ => return Err("bad_frame"),
    };
    let id = frame.get("id").and_then(Value::as_safe_int).unwrap_or(0);
    let grant_id = frame.get("grantId").and_then(Value::as_str).unwrap_or_default().to_string();
    match frame.get("verdict").and_then(Value::as_str) {
        Some("renew") => {
            let ttl = frame.get("ttlMs").and_then(Value::as_safe_int);
            if frame.sorted_keys().as_deref() != Some(LEASE_RENEW_KEYS) || ttl.is_none() {
                return Err("bad_frame");
            }
            if !is_lease_ttl(frame.get("ttlMs"), limits) {
                return Err("bad_ttl");
            }
            Ok(LeaseFrame { id, grant_id, epoch, verdict: LeaseVerdict::Renew { ttl_ms: ttl.unwrap_or(0) } })
        }
        Some("revoke") => {
            let reason = frame.get("reason").and_then(Value::as_str);
            if frame.sorted_keys().as_deref() != Some(LEASE_REVOKE_KEYS) || !reason.is_some_and(is_error_code) {
                return Err("bad_frame");
            }
            Ok(LeaseFrame { id, grant_id, epoch, verdict: LeaseVerdict::Revoke { reason: reason.unwrap_or_default().to_string() } })
        }
        _ => Err("bad_frame"),
    }
}

/// Opaque identities the keeper commits for a mounted view (plan section 5.5, Commit row).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountedIdentity {
    pub resource: String,
    pub mount_id: i64,
    pub mountpoint: String,
    pub mount_namespace_inode: u64,
    pub server_pid: i64,
    pub server_start_time: u64,
    pub server_pid_namespace_inode: u64,
}

pub fn mount_ok_reply(id: i64, identity: &MountedIdentity) -> Value {
    obj(vec![
        ("id", int(id)),
        ("ok", Value::Bool(true)),
        ("value", obj(vec![
            ("resource", text(&identity.resource)),
            ("mount", obj(vec![
                ("mountId", int(identity.mount_id)),
                ("mountpoint", text(&identity.mountpoint)),
                ("mountNamespaceInode", text(&identity.mount_namespace_inode.to_string())),
            ])),
            ("fileServer", obj(vec![
                ("pid", int(identity.server_pid)),
                ("startTime", text(&identity.server_start_time.to_string())),
                ("pidNamespaceInode", text(&identity.server_pid_namespace_inode.to_string())),
            ])),
        ])),
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalKind {
    Refused,
    Failure,
}

/// `{ id, ok: false, kind, error }` with a code string, the refusal shape of the mount channel.
pub fn refusal_reply(id: i64, kind: RefusalKind, code: &str) -> Value {
    debug_assert!(is_error_code(code), "refusal codes must match ERROR_CODE: {code}");
    obj(vec![
        ("id", int(id)),
        ("ok", Value::Bool(false)),
        ("kind", text(match kind { RefusalKind::Refused => "refused", RefusalKind::Failure => "failure" })),
        ("error", text(code)),
    ])
}

pub fn lease_state_reply(id: i64, state: &str) -> Value {
    debug_assert!(LEASE_STATES.contains(&state));
    obj(vec![("id", int(id)), ("ok", Value::Bool(true)), ("value", obj(vec![("state", text(state))]))])
}

pub fn unmount_ok_reply(id: i64) -> Value {
    obj(vec![("id", int(id)), ("ok", Value::Bool(true))])
}

/// Port of `validateMountReply(reply, request)` (supervisor side), used to self-check the replies built here.
pub fn validate_mount_reply(reply: &Value, request_id: i64, request_mountpoint: &str) -> Result<(), &'static str> {
    if !reply.is_plain_object() || reply.get("id").and_then(Value::as_safe_int) != Some(request_id) {
        return Err("bad_reply");
    }
    if reply.get("ok") == Some(&Value::Bool(false)) {
        return refusal_shape_ok(reply);
    }
    let value = reply.get("value").cloned().unwrap_or(Value::Null);
    if reply.get("ok") != Some(&Value::Bool(true)) || reply.sorted_keys().as_deref() != Some("id,ok,value") || !value.is_plain_object()
        || value.sorted_keys().as_deref() != Some("fileServer,mount,resource")
    {
        return Err("bad_reply");
    }
    if !value.get("resource").and_then(Value::as_str).is_some_and(is_opaque_id) {
        return Err("bad_reply");
    }
    let mount = value.get("mount").cloned().unwrap_or(Value::Null);
    if !mount.is_plain_object() || mount.sorted_keys().as_deref() != Some("mountId,mountNamespaceInode,mountpoint")
        || !is_count(mount.get("mountId"), 1, 1 << 31)
        || mount.get("mountpoint").and_then(Value::as_str) != Some(request_mountpoint)
        || !mount.get("mountNamespaceInode").is_some_and(is_digits)
    {
        return Err("bad_mount_tuple");
    }
    let server = value.get("fileServer").cloned().unwrap_or(Value::Null);
    if !server.is_plain_object() || server.sorted_keys().as_deref() != Some("pid,pidNamespaceInode,startTime")
        || !is_count(server.get("pid"), 1, MAX_PID)
        || !server.get("startTime").is_some_and(is_digits)
        || !server.get("pidNamespaceInode").is_some_and(is_digits)
    {
        return Err("bad_process_tuple");
    }
    Ok(())
}

fn refusal_shape_ok(reply: &Value) -> Result<(), &'static str> {
    let kind = reply.get("kind").and_then(Value::as_str);
    let ok = reply.sorted_keys().as_deref() == Some("error,id,kind,ok")
        && (kind == Some("refused") || kind == Some("failure"))
        && reply.get("error").and_then(Value::as_str).is_some_and(is_error_code);
    if ok { Ok(()) } else { Err("bad_reply") }
}

/// Port of `validateRootLeaseReply(reply, request)`.
pub fn validate_root_lease_reply(reply: &Value, request_id: i64) -> Result<(), &'static str> {
    if !reply.is_plain_object() || reply.get("id").and_then(Value::as_safe_int) != Some(request_id) {
        return Err("bad_reply");
    }
    if reply.get("ok") == Some(&Value::Bool(false)) {
        return refusal_shape_ok(reply);
    }
    let value = reply.get("value").cloned().unwrap_or(Value::Null);
    if reply.get("ok") != Some(&Value::Bool(true)) || reply.sorted_keys().as_deref() != Some("id,ok,value") || !value.is_plain_object()
        || value.sorted_keys().as_deref() != Some("state")
        || !value.get("state").and_then(Value::as_str).is_some_and(|state| LEASE_STATES.contains(&state))
    {
        return Err("bad_reply");
    }
    Ok(())
}

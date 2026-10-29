//! The execution-provider start request schema (ALA DS006 v1), a port of `validateStartRequest` and `virtualPathProblem`
//! in `robo-work/server/execution/providerSchema.mjs` (S4 r8, unchanged in r9). The keeper applies it to a workload `create.spec.request`
//! (contract §4), exactly as the Node keeperFrames validator does.

use crate::json::{self, Value};
use crate::keeper_limits::EndpointLimits;

const MAX_PROCESS_CLASS_BYTES: usize = 32;
const MAX_ENV_NAME_BYTES: usize = 256;
const MAX_GRACE_MS: i64 = 3_600_000;
const MAX_LIFECYCLE_MS: i64 = 86_400_000;

/// `textProblem(value, maxBytes) === null`: a string without NUL of at most `max` UTF-8 bytes.
pub fn text_ok(value: Option<&Value>, max: usize) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !text.contains('\0') && text.len() <= max)
}

/// `virtualPathProblem(value, maxBytes) === null`.
pub fn virtual_path_ok(value: Option<&Value>, max: usize) -> bool {
    if !text_ok(value, max) {
        return false;
    }
    let text = value.and_then(Value::as_str).unwrap_or_default();
    if !text.starts_with('/') || text.chars().any(|c| (c as u32) <= 0x1f || c == '\u{7f}' || c == '\\') {
        return false;
    }
    text == "/" || text[1..].split('/').all(|segment| !(segment.is_empty() || segment == "." || segment == ".."))
}

/// keeperFrames `isPath`: a virtual path other than `/`.
pub fn is_path(value: Option<&Value>, max: usize) -> bool {
    value.and_then(Value::as_str) != Some("/") && virtual_path_ok(value, max)
}

fn count(value: Option<&Value>, min: i64, max: i64) -> bool {
    value.and_then(Value::as_safe_int).is_some_and(|number| number >= min && number <= max)
}

/// `exactKeys(object, required, optional)`.
fn exact_keys(object: &Value, required: &[&str], optional: &[&str]) -> bool {
    let Some(entries) = object.as_object() else { return false };
    required.iter().all(|key| object.has(key)) && entries.iter().all(|(key, _)| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn array(value: Option<&Value>) -> Option<&[Value]> {
    match value {
        Some(Value::Array(items)) => Some(items),
        _ => None,
    }
}

fn folder_ok(folder: &Value, limits: &EndpointLimits) -> bool {
    folder.is_plain_object() && exact_keys(folder, &["path", "access"], &[]) && text_ok(folder.get("path"), limits.max_path_bytes)
        && matches!(folder.get("access").and_then(Value::as_str), Some("read") | Some("write"))
}

fn communication_ok(communication: &Value) -> bool {
    if !communication.is_plain_object() {
        return false;
    }
    let shape = match communication.get("kind").and_then(Value::as_str) {
        Some("streams") => exact_keys(communication, &["kind", "stdin"], &[]),
        Some("service") => exact_keys(communication, &["kind", "endpoint", "stdin"], &[]) && communication.get("endpoint").and_then(Value::as_str) == Some("loopback-port"),
        _ => false,
    };
    shape && matches!(communication.get("stdin").and_then(Value::as_str), Some("pipe") | Some("ignore"))
}

fn lifecycle_ok(lifecycle: &Value) -> bool {
    if !lifecycle.is_plain_object() || !exact_keys(lifecycle, &["stopGraceMs"], &["deadlineMs", "ready"]) || !count(lifecycle.get("stopGraceMs"), 0, MAX_GRACE_MS) {
        return false;
    }
    if lifecycle.has("deadlineMs") && !count(lifecycle.get("deadlineMs"), 1, MAX_LIFECYCLE_MS) {
        return false;
    }
    match lifecycle.get("ready") {
        None => true,
        Some(ready) => ready.is_plain_object() && exact_keys(ready, &["condition", "timeoutMs"], &[])
            && ready.get("condition").and_then(Value::as_str) == Some("announced-endpoint") && count(ready.get("timeoutMs"), 1, MAX_LIFECYCLE_MS),
    }
}

/// `validateStartRequest(request, limits).ok`.
pub fn start_request_ok(request: &Value, limits: &EndpointLimits) -> bool {
    const FIELDS: &[&str] = &["processClass", "executable", "args", "env", "home", "cwd", "folders", "exclusions", "communication", "lifecycle", "network", "requirements"];
    if !request.is_plain_object() || !exact_keys(request, FIELDS, &[]) {
        return false;
    }
    if !text_ok(request.get("processClass"), MAX_PROCESS_CLASS_BYTES) {
        return false;
    }
    if request.get("executable").and_then(Value::as_str).is_none_or(str::is_empty) || !text_ok(request.get("executable"), limits.max_path_bytes) {
        return false;
    }
    let args_ok = array(request.get("args")).is_some_and(|args| args.len() <= limits.max_args && args.iter().all(|arg| text_ok(Some(arg), limits.max_arg_bytes)));
    let env_ok = request.get("env").and_then(Value::as_object).is_some_and(|env| {
        env.len() <= limits.max_env_entries
            && env.iter().all(|(name, value)| !name.is_empty() && !name.contains('\0') && name.len() <= MAX_ENV_NAME_BYTES && text_ok(Some(value), limits.max_env_value_bytes))
    });
    let folders_ok = array(request.get("folders")).is_some_and(|folders| folders.len() <= limits.max_folders && folders.iter().all(|folder| folder_ok(folder, limits)));
    let exclusions_ok = array(request.get("exclusions"))
        .is_some_and(|items| items.len() <= limits.max_exclusions && items.iter().all(|item| text_ok(Some(item), limits.max_path_bytes)));
    let requirements = request.get("requirements").cloned().unwrap_or(Value::Null);
    let requirements_ok = requirements.is_plain_object() && exact_keys(&requirements, &["privateProc"], &[]) && requirements.get("privateProc").and_then(Value::as_bool).is_some();
    args_ok && env_ok && text_ok(request.get("home"), limits.max_path_bytes) && text_ok(request.get("cwd"), limits.max_path_bytes) && folders_ok && exclusions_ok
        && request.get("communication").is_some_and(communication_ok) && request.get("lifecycle").is_some_and(lifecycle_ok)
        && text_ok(request.get("network"), MAX_PROCESS_CLASS_BYTES) && requirements_ok
        && json::stringify(request).len() <= limits.max_request_bytes
}

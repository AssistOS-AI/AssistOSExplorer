//! The execution workload of a `prepare` and the resource kinds a target keeper creates for it (slice P8).
//!
//! A prepare body may carry `workload: {executable, args}`: an image inventory name and its arguments. The body is the
//! ticketed request (its SHA-256 is the ticket's `requestDigest`), so the workload is Router-attested together with the
//! resources. The helper maps it onto the keeper's v1 start request (`provider_schema::start_request_ok`): no
//! environment, HOME `/home/robot`, no folders or exclusions, no network, private proc, stdout and stderr streamed to the
//! helper. Nothing in it selects a path, an environment value or a privilege.
//!
//! The resources a target keeper creates for one execution, and the identity each receipt names:
//!
//! | Kind | Identity digest over |
//! |---|---|
//! | `keeper` | the keeper process (pid, start time, reservation marker) |
//! | `namespace` | the execution's network namespace (`netNs` inode) |
//! | `process-tree` | the workload anchor (pid, start time, PID namespace) |
//! | `gate` | the gated workload resource (keeper handle and anchor identity) |
//!
//! A prepare must name exactly one `keeper` and at most one of each other kind; any other kind (descriptor, view,
//! listener, connection, cgroup) is not created by this slice and refuses `invalid_request` before the journal.

use crate::Code;
use crate::canon::Value;

pub const MAX_ARGS: usize = 64;
pub const MAX_ARG_BYTES: usize = 4096;
pub const MAX_ARGS_TOTAL_BYTES: usize = 64 * 1024;
/// Grace between the keeper's SIGTERM and SIGKILL of a stopped workload tree.
pub const STOP_GRACE_MS: i64 = 1000;
/// The resource kinds a target keeper creates (see the module table).
pub const KEEPER_RESOURCE_KINDS: [&str; 4] = ["keeper", "namespace", "process-tree", "gate"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workload {
    pub executable: String,
    pub args: Vec<String>,
}

fn inventory_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len()) && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Parses `{executable, args}` (exact keys). Any other shape is `invalid_request`; arguments over the bounds are
/// `capacity_exceeded`.
pub fn parse_workload(value: &Value) -> Result<Workload, Code> {
    if !value.has_exact_keys(&["executable", "args"]) {
        return Err(Code::InvalidRequest);
    }
    let executable = value.str_at("executable").filter(|name| inventory_name_ok(name)).ok_or(Code::InvalidRequest)?;
    let args = value.get("args").and_then(Value::arr).ok_or(Code::InvalidRequest)?;
    if args.len() > MAX_ARGS {
        return Err(Code::CapacityExceeded);
    }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(args.len());
    for arg in args {
        let text = arg.str().ok_or(Code::InvalidRequest)?;
        if text.contains('\0') {
            return Err(Code::InvalidRequest);
        }
        if text.len() > MAX_ARG_BYTES {
            return Err(Code::CapacityExceeded);
        }
        total += text.len();
        out.push(text.to_string());
    }
    if total > MAX_ARGS_TOTAL_BYTES {
        return Err(Code::CapacityExceeded);
    }
    Ok(Workload { executable: executable.to_string(), args: out })
}

impl Workload {
    /// The keeper start request (`provider_schema.mjs` shape), checked with the keeper's own validator.
    pub fn start_request(&self) -> Result<rw_proto::json::Value, Code> {
        use rw_proto::json::{Value as J, int, obj, text};
        let request = obj(vec![
            ("processClass", text("run")),
            ("executable", text(&self.executable)),
            ("args", J::Array(self.args.iter().map(|arg| text(arg)).collect())),
            ("env", J::Object(Vec::new())),
            ("home", text("/home/robot")),
            ("cwd", text("/home/robot")),
            ("folders", J::Array(Vec::new())),
            ("exclusions", J::Array(Vec::new())),
            ("communication", obj(vec![("kind", text("streams")), ("stdin", text("ignore"))])),
            ("lifecycle", obj(vec![("stopGraceMs", int(STOP_GRACE_MS))])),
            ("network", text("none")),
            ("requirements", obj(vec![("privateProc", J::Bool(true))])),
        ]);
        if rw_proto::provider_schema::start_request_ok(&request, &rw_proto::keeper_limits::EndpointLimits::default()) {
            Ok(request)
        } else {
            Err(Code::InvalidRequest)
        }
    }
}

/// The resource kinds of a prepare request, in request order, if this slice can create them: exactly one `keeper`, at
/// most one of each other keeper kind.
pub fn check_resource_kinds(resources: &Value) -> Result<Vec<(String, String)>, Code> {
    let entries = resources.arr().ok_or(Code::InvalidRequest)?;
    let mut out: Vec<(String, String)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry.str_at("resourceId").ok_or(Code::InvalidRequest)?;
        let kind = entry.str_at("kind").filter(|kind| KEEPER_RESOURCE_KINDS.contains(kind)).ok_or(Code::InvalidRequest)?;
        if out.iter().any(|(_, known)| known == kind) {
            return Err(Code::InvalidRequest);
        }
        out.push((id.to_string(), kind.to_string()));
    }
    if !out.iter().any(|(_, kind)| kind == "keeper") {
        return Err(Code::InvalidRequest);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canon::{obj, s};

    fn workload(executable: &str, args: Vec<&str>) -> Value {
        obj(vec![("executable", s(executable)), ("args", Value::Arr(args.into_iter().map(s).collect()))])
    }

    #[test]
    fn a_workload_maps_onto_a_valid_keeper_start_request_and_nothing_else() {
        let parsed = parse_workload(&workload("busybox", vec!["sh", "-c", "echo ok"])).unwrap();
        let request = parsed.start_request().unwrap();
        let text = rw_proto::json::stringify(&request);
        assert!(text.contains(r#""executable":"busybox""#) && text.contains(r#""env":{}"#) && text.contains(r#""network":"none""#), "{text}");
        assert!(text.contains(r#""privateProc":true"#) && text.contains(r#""home":"/home/robot""#));
    }

    #[test]
    fn malformed_or_oversized_workloads_refuse() {
        assert_eq!(parse_workload(&workload("../bin/sh", vec![])), Err(Code::InvalidRequest));
        assert_eq!(parse_workload(&workload("/bin/sh", vec![])), Err(Code::InvalidRequest));
        assert_eq!(parse_workload(&workload("", vec![])), Err(Code::InvalidRequest));
        assert_eq!(parse_workload(&workload("sh", vec!["a\0b"])), Err(Code::InvalidRequest));
        let mut extra = workload("sh", vec![]);
        extra.set("env", obj(vec![]));
        assert_eq!(parse_workload(&extra), Err(Code::InvalidRequest), "no environment field");
        assert_eq!(parse_workload(&obj(vec![("executable", s("sh"))])), Err(Code::InvalidRequest));
        let many: Vec<String> = (0..=MAX_ARGS).map(|index| index.to_string()).collect();
        assert_eq!(parse_workload(&workload("sh", many.iter().map(String::as_str).collect())), Err(Code::CapacityExceeded));
        let long = "x".repeat(MAX_ARG_BYTES + 1);
        assert_eq!(parse_workload(&workload("sh", vec![&long])), Err(Code::CapacityExceeded));
        let wide = "x".repeat(MAX_ARG_BYTES);
        let total: Vec<&str> = (0..17).map(|_| wide.as_str()).collect();
        assert_eq!(parse_workload(&workload("sh", total)), Err(Code::CapacityExceeded));
    }

    #[test]
    fn resource_kinds_need_one_keeper_and_only_keeper_kinds_once() {
        let resource = |id: &str, kind: &str| obj(vec![("resourceId", s(id)), ("kind", s(kind)), ("locatorDigest", s("00"))]);
        let ok = Value::Arr(vec![resource("a", "keeper"), resource("b", "gate"), resource("c", "process-tree"), resource("d", "namespace")]);
        assert_eq!(check_resource_kinds(&ok).unwrap().len(), 4);
        assert_eq!(check_resource_kinds(&Value::Arr(vec![resource("b", "gate")])), Err(Code::InvalidRequest), "no keeper");
        assert_eq!(check_resource_kinds(&Value::Arr(vec![resource("a", "keeper"), resource("b", "keeper")])), Err(Code::InvalidRequest));
        for kind in ["descriptor", "filtered-view", "listener", "connection", "cgroup"] {
            assert_eq!(check_resource_kinds(&Value::Arr(vec![resource("a", "keeper"), resource("b", kind)])), Err(Code::InvalidRequest), "{kind}");
        }
    }
}

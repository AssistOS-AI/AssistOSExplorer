//! The apparatus image-policy document (first-G1 amendment A1.6), pure and host-tested.
//!
//! The policy is an image-build input, never a wire request, a `serve` flag or a runtime-selectable file: a keeper built
//! with the `apparatus-policy` cargo feature embeds exactly one document at compile time (`RW_KEEPER_APPARATUS_POLICY`,
//! see `linux::policy`). A default build embeds none, and every process-bearing create then refuses `setup_failed`.
//!
//! ```text
//! { "version": 1,
//!   "node": EXE, "keeper": EXE, "bwrap": EXE,
//!   "inventory": { "<name>": EXE, ... },
//!   "code": { "endpoint": [FILE, ...], "orchestration": [FILE, ...] },
//!   "endpointHeapMib": 48, "endpointNofile": 256 }
//! EXE  = { "path": P, "source": P?, "sha256": H, "closure": "complete", "runtime": [FILE, ...] }
//! FILE = { "path": P, "source": P?, "sha256": H }
//! ```
//!
//! `path` is where the file appears in a domain view (and, for `keeper`/`bwrap`/`node`, the fixed image path). `source`
//! is the image's resolved regular file whose bytes appear there; it defaults to `path` and is opened without following
//! any symlink. `sha256` is 64 lowercase hex characters, except the keeper's own entry, which is the literal `"self"`: a
//! binary cannot embed its own digest, so the loader computes it from the held file, which must be the running keeper
//! (`/proc/self/exe`). `closure: "complete"` asserts that `runtime` lists the loader
//! and the recursive `DT_NEEDED` closure resolved from the pinned image (empty only for a static ELF). Nothing here
//! proves those facts; the Linux loader checks identity, type, digest and ELF magic, and G1 evidence records the rest.

use std::collections::BTreeMap;

use rw_proto::json::{Value, parse};

use crate::domain_policy::Role;
use crate::sha256::digest_from_hex;

pub const MAX_POLICY_BYTES: usize = 1024 * 1024;
pub const MAX_INVENTORY: usize = 64;
pub const MAX_RUNTIME_FILES: usize = 256;
pub const MAX_CODE_FILES: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub source: String,
    /// `None` only for the keeper's self-attested entry (`"self"`).
    pub sha256: Option<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExeEntry {
    pub file: FileEntry,
    pub runtime: Vec<FileEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyDocument {
    pub node: ExeEntry,
    pub keeper: ExeEntry,
    pub bwrap: ExeEntry,
    pub inventory: BTreeMap<String, ExeEntry>,
    pub code: BTreeMap<Role, Vec<FileEntry>>,
    pub endpoint_heap_mib: u32,
    pub endpoint_nofile: u64,
}

impl PolicyDocument {
    /// Every distinct file the policy pins, in a stable order (executables, their closures, then code).
    pub fn files(&self) -> Vec<&FileEntry> {
        let mut files: Vec<&FileEntry> = Vec::new();
        for file in self.all_entries() {
            if !files.iter().any(|known| known.path == file.path) {
                files.push(file);
            }
        }
        files
    }

    fn all_entries(&self) -> Vec<&FileEntry> {
        let mut all: Vec<&FileEntry> = Vec::new();
        for exe in [&self.node, &self.keeper, &self.bwrap].into_iter().chain(self.inventory.values()) {
            all.push(&exe.file);
            all.extend(exe.runtime.iter());
        }
        for code in self.code.values() {
            all.extend(code.iter());
        }
        all
    }
}

fn path_ok(value: &str) -> bool {
    rw_proto::provider_schema::is_path(Some(&rw_proto::json::text(value)), 4096)
}

fn exact(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|entries| {
        required.iter().all(|key| value.has(key)) && entries.iter().all(|(key, _)| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}

fn file_entry(value: &Value) -> Result<FileEntry, &'static str> {
    file_entry_with(value, false)
}

fn file_entry_with(value: &Value, allow_self: bool) -> Result<FileEntry, &'static str> {
    if !exact(value, &["path", "sha256"], &["source"]) {
        return Err("policy_file_keys");
    }
    let path = value.get("path").and_then(Value::as_str).filter(|path| path_ok(path)).ok_or("policy_file_path")?;
    let source = match value.get("source") {
        None => path,
        Some(source) => source.as_str().filter(|source| path_ok(source)).ok_or("policy_file_source")?,
    };
    let sha256 = match value.get("sha256").and_then(Value::as_str) {
        Some("self") if allow_self => None,
        other => Some(other.and_then(digest_from_hex).ok_or("policy_file_sha256")?),
    };
    Ok(FileEntry { path: path.to_string(), source: source.to_string(), sha256 })
}

fn file_list(value: Option<&Value>, max: usize) -> Result<Vec<FileEntry>, &'static str> {
    let Some(Value::Array(items)) = value else { return Err("policy_file_list") };
    if items.len() > max {
        return Err("policy_file_list_too_long");
    }
    let mut files: Vec<FileEntry> = Vec::new();
    for item in items {
        let file = file_entry(item)?;
        if files.iter().any(|known| known.path == file.path) {
            return Err("policy_duplicate_path");
        }
        files.push(file);
    }
    Ok(files)
}

fn exe_entry(value: Option<&Value>) -> Result<ExeEntry, &'static str> {
    exe_entry_with(value, false)
}

fn exe_entry_with(value: Option<&Value>, allow_self: bool) -> Result<ExeEntry, &'static str> {
    let value = value.ok_or("policy_missing_executable")?;
    if !exact(value, &["path", "sha256", "closure", "runtime"], &["source"]) || value.get("closure").and_then(Value::as_str) != Some("complete") {
        return Err("policy_executable_keys");
    }
    let file = file_entry_with(&Value::Object(
        value.as_object().unwrap_or_default().iter().filter(|(key, _)| matches!(key.as_str(), "path" | "sha256" | "source")).cloned().collect(),
    ), allow_self)?;
    let runtime = file_list(value.get("runtime"), MAX_RUNTIME_FILES)?;
    if runtime.iter().any(|entry| entry.path == file.path) {
        return Err("policy_duplicate_path");
    }
    Ok(ExeEntry { file, runtime })
}

fn inventory_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len()) && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Parses and validates the document's shape. Identity, type, digest and ELF checks are the Linux loader's.
pub fn parse_policy(bytes: &[u8]) -> Result<PolicyDocument, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_POLICY_BYTES {
        return Err("policy_size");
    }
    let document = parse(bytes).map_err(|_| "policy_json")?;
    if !exact(&document, &["version", "node", "keeper", "bwrap", "inventory", "code", "endpointHeapMib", "endpointNofile"], &[]) {
        return Err("policy_keys");
    }
    if document.get("version").and_then(Value::as_safe_int) != Some(1) {
        return Err("policy_version");
    }
    let node = exe_entry(document.get("node"))?;
    let keeper = exe_entry_with(document.get("keeper"), true)?;
    let bwrap = exe_entry(document.get("bwrap"))?;
    let entries = document.get("inventory").and_then(Value::as_object).ok_or("policy_inventory")?;
    if entries.len() > MAX_INVENTORY {
        return Err("policy_inventory_too_large");
    }
    let mut inventory = BTreeMap::new();
    for (name, value) in entries {
        if !inventory_name_ok(name) {
            return Err("policy_inventory_name");
        }
        inventory.insert(name.clone(), exe_entry(Some(value))?);
    }
    let code_value = document.get("code").ok_or("policy_code")?;
    if !exact(code_value, &[], &["endpoint", "orchestration"]) {
        return Err("policy_code_keys");
    }
    let mut code = BTreeMap::new();
    for (key, role) in [("endpoint", Role::Endpoint), ("orchestration", Role::Orchestration)] {
        if code_value.has(key) {
            code.insert(role, file_list(code_value.get(key), MAX_CODE_FILES)?);
        }
    }
    let heap = document.get("endpointHeapMib").and_then(Value::as_safe_int).filter(|value| (1..=65536).contains(value)).ok_or("policy_heap")?;
    let nofile = document.get("endpointNofile").and_then(Value::as_safe_int).filter(|value| (1..=1_048_576).contains(value)).ok_or("policy_nofile")?;
    let parsed = PolicyDocument { node, keeper, bwrap, inventory, code, endpoint_heap_mib: heap as u32, endpoint_nofile: nofile as u64 };
    // One view path names one file everywhere: a path pinned twice must name the same source and digest.
    let mut seen: BTreeMap<&str, (&str, Option<[u8; 32]>)> = BTreeMap::new();
    for file in parsed.all_entries() {
        if let Some((source, digest)) = seen.insert(&file.path, (&file.source, file.sha256)) {
            if source != file.source || digest != file.sha256 {
                return Err("policy_conflicting_path");
            }
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn exe(path: &str, extra: &str) -> String {
        format!(r#"{{"path":"{path}","sha256":"{H1}","closure":"complete","runtime":[{extra}]}}"#)
    }

    fn document(inventory: &str) -> String {
        format!(
            r#"{{"version":1,"node":{},"keeper":{},"bwrap":{},"inventory":{{{inventory}}},"code":{{"endpoint":[{{"path":"/opt/e.mjs","sha256":"{H2}"}}]}},"endpointHeapMib":48,"endpointNofile":256}}"#,
            exe("/usr/local/bin/node", &format!(r#"{{"path":"/lib/ld.so","source":"/usr/lib/ld-real.so","sha256":"{H2}"}}"#)),
            exe("/usr/local/libexec/robo-work/keeper", "").replace(H1, "self"),
            exe("/usr/bin/bwrap", ""),
        )
    }

    #[test]
    fn accepts_the_documented_shape_and_defaults_source_to_path() {
        let parsed = parse_policy(document(&format!(r#""sleep":{}"#, exe("/usr/bin/sleep", ""))).as_bytes()).unwrap();
        assert_eq!(parsed.node.runtime[0].source, "/usr/lib/ld-real.so");
        assert_eq!(parsed.keeper.file.source, parsed.keeper.file.path);
        assert_eq!(parsed.keeper.file.sha256, None, "the keeper's own digest is self-attested");
        assert!(parsed.node.file.sha256.is_some());
        assert_eq!(parsed.inventory["sleep"].file.path, "/usr/bin/sleep");
        assert_eq!(parsed.code[&Role::Endpoint].len(), 1);
        assert!(!parsed.code.contains_key(&Role::Orchestration));
        assert_eq!((parsed.endpoint_heap_mib, parsed.endpoint_nofile), (48, 256));
        assert_eq!(parsed.files().len(), 6);
    }

    #[test]
    fn refuses_unknown_keys_bad_digests_paths_names_and_conflicts() {
        let good = document("");
        assert!(parse_policy(good.as_bytes()).is_ok());
        for (from, to) in [
            (r#""version":1"#, r#""version":2"#),
            (r#""endpointHeapMib":48"#, r#""endpointHeapMib":0"#),
            (r#""closure":"complete""#, r#""closure":"partial""#),
            (H1, "1111"),
            ("/usr/bin/bwrap", "usr/bin/bwrap"),
            ("/usr/bin/bwrap", "/usr/bin/../bwrap"),
            (r#""code":{"#, r#""code":{"gui":[],"#),
            (r#""version":1,"#, r#""version":1,"extra":true,"#),
        ] {
            let bad = good.replacen(from, to, 1);
            assert_ne!(bad, good, "{from}");
            assert!(parse_policy(bad.as_bytes()).is_err(), "{from} -> {to}");
        }
        assert!(parse_policy(document(&format!(r#""-bad":{}"#, exe("/x", ""))).as_bytes()).is_err());
        // "self" is accepted only for the keeper entry.
        assert!(parse_policy(document(&format!(r#""x":{}"#, exe("/x", "").replace(H1, "self"))).as_bytes()).is_err());
        assert!(parse_policy(good.replacen(&format!(r#""path":"/usr/bin/bwrap","sha256":"{H1}""#), r#""path":"/usr/bin/bwrap","sha256":"self""#, 1).as_bytes()).is_err());
        // The same view path pinned to two different digests refuses.
        let conflict = document(&format!(r#""node2":{}"#, exe("/usr/local/bin/node", &format!(r#"{{"path":"/lib/ld.so","sha256":"{H1}"}}"#))));
        assert_eq!(parse_policy(conflict.as_bytes()), Err("policy_conflicting_path"));
        assert!(parse_policy(b"").is_err());
        assert!(parse_policy(&vec![b' '; MAX_POLICY_BYTES + 1]).is_err());
    }
}

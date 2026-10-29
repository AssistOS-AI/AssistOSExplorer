//! The per-operation allow/refuse policy of the filtered project view (plan section 5.4), as a pure function of
//! operation, operand names and binding-chain state. A port of `decideOperation`, `filterDirectoryEntries` and
//! `scanForProtectedDescendants` of `robo-work/server/views/operationPolicy.mjs` (S5 r5), checked against the shared
//! vectors `tests/views/vectors/operation-policy.json`.
//!
//! There is deliberately no input for "does the entry exist": an answer must not depend on it.

use crate::names::{is_protected_name, is_valid_component_name};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Serve,
    Absent,
    Refused,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Serve => "serve",
            Outcome::Absent => "absent",
            Outcome::Refused => "refused",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostCheck {
    /// The post-operation check must still find an ordinary binding or the data is dropped.
    DiscardDataOnFailure,
    /// The effect took place; a failed check taints the handle but the result is reported as it was.
    ReportTrueOutcome,
}

impl PostCheck {
    pub fn as_str(self) -> &'static str {
        match self {
            PostCheck::DiscardDataOnFailure => "discard_data_on_failure",
            PostCheck::ReportTrueOutcome => "report_true_outcome",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub outcome: Outcome,
    pub code: &'static str,
    /// Provisional errno hint (design question D-S5-5); `absent` is always ENOENT.
    pub errno_hint: Option<&'static str>,
    pub post_check: Option<PostCheck>,
    pub no_data_io: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    NameQuery,
    NodeQuery,
    NameCreate,
    NameRemove,
    Rename,
    Handle,
    Lifecycle,
    Forbidden,
    Xattr,
    Unsupported,
}

struct Spec {
    kind: Kind,
    names: &'static [&'static str],
    nodes: &'static [&'static str],
    post_check: Option<PostCheck>,
    directory: bool,
    refusal_code: &'static str,
}

const S: &[&str] = &["subject"];
const SS: &[&str] = &["subject", "source"];
const SNS: &[&str] = &["subject", "newParent", "source"];
const N: &[&str] = &["name"];
const NN: &[&str] = &["name", "newName"];
const NONE: &[&str] = &[];

const fn spec(kind: Kind, names: &'static [&'static str], nodes: &'static [&'static str]) -> Spec {
    Spec { kind, names, nodes, post_check: None, directory: false, refusal_code: "" }
}
const fn with_post(mut value: Spec, post: PostCheck) -> Spec {
    value.post_check = Some(post);
    value
}

/// `OPERATIONS[op]`: every operation the file server may receive. Anything else is `unknown_operation`.
fn operation(op: &str) -> Option<Spec> {
    use Kind::*;
    use PostCheck::*;
    Some(match op {
        "lookup" => spec(NameQuery, N, S),
        "getattr" | "access" | "statfs" | "open" | "opendir" => spec(NodeQuery, NONE, S),
        "readlink" => with_post(spec(NodeQuery, NONE, S), DiscardDataOnFailure),
        "create" | "mkdir" | "mknod" | "symlink" => spec(NameCreate, N, S),
        "tmpfile" => spec(NameCreate, NONE, S),
        "link" => spec(NameCreate, N, SS),
        "rename" | "rename_exchange" | "rename_whiteout" => spec(Rename, NN, SNS),
        "unlink" => spec(NameRemove, N, S),
        "rmdir" => Spec { directory: true, ..spec(NameRemove, N, S) },
        "read" | "readdir" | "readdirplus" | "mapping_fault" => with_post(spec(Handle, NONE, S), DiscardDataOnFailure),
        "write" | "fallocate" | "setattr" => with_post(spec(Handle, NONE, S), ReportTrueOutcome),
        "copy_file_range" => Spec { refusal_code: "copy_file_range_not_supported", ..spec(Unsupported, NONE, SS) },
        "lseek" | "fsync" | "fsyncdir" | "getlk" | "setlk" | "poll" => spec(Handle, NONE, S),
        "release" | "releasedir" | "forget" | "batch_forget" | "flush" | "interrupt" => spec(Lifecycle, NONE, NONE),
        "ioctl" => spec(Forbidden, NONE, S),
        "getxattr" | "setxattr" | "listxattr" | "removexattr" => spec(Xattr, NONE, S),
        _ => return None,
    })
}

pub fn is_known_operation(op: &str) -> bool {
    operation(op).is_some()
}

/// `ERRNO_BY_CODE`.
fn errno_by_code(code: &str) -> &'static str {
    match code {
        "protected_name" | "node_under_protected_component" => "ENOENT",
        "protected_operand" | "handle_observed_protected" | "hidden_descendants" | "hidden_descendants_unknown" => "EACCES",
        "binding_unproven" => "EIO",
        "invalid_name" | "invalid_request" => "EINVAL",
        "unknown_operation" | "copy_file_range_not_supported" => "ENOSYS",
        "ioctl_not_passed_through" => "ENOTTY",
        "xattr_not_reviewed" => "ENOTSUP",
        "descriptor_cap" => "EMFILE",
        _ => "EACCES",
    }
}

fn serve(spec: &Spec) -> Decision {
    Decision { outcome: Outcome::Serve, code: "allowed", errno_hint: None, post_check: spec.post_check, no_data_io: false }
}
pub fn refuse(code: &'static str) -> Decision {
    Decision { outcome: Outcome::Refused, code, errno_hint: Some(errno_by_code(code)), post_check: None, no_data_io: false }
}
pub fn absent(code: &'static str) -> Decision {
    Decision { outcome: Outcome::Absent, code, errno_hint: Some("ENOENT"), post_check: None, no_data_io: false }
}

/// A binding-chain state as given to the policy. `Other` stands for any value outside the three states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeState {
    Ok,
    Protected,
    Unproven,
}

impl NodeState {
    pub fn parse(text: &str) -> Option<NodeState> {
        match text {
            "ok" => Some(NodeState::Ok),
            "protected" => Some(NodeState::Protected),
            "unproven" => Some(NodeState::Unproven),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            NodeState::Ok => "ok",
            NodeState::Protected => "protected",
            NodeState::Unproven => "unproven",
        }
    }
}

/// `hiddenDescendants`: `false`, `true`, or anything else (which refuses as unknown).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hidden {
    No,
    Yes,
    Unknown,
}

#[derive(Clone, Debug, Default)]
pub struct PolicyInput<'a> {
    pub op: &'a str,
    /// role -> raw name bytes.
    pub names: Vec<(&'a str, &'a [u8])>,
    /// role -> state; `None` stands for a value outside the three states.
    pub nodes: Vec<(&'a str, Option<NodeState>)>,
    /// `typeof movesDirectory === 'boolean' ? movesDirectory : <not a boolean>`.
    pub moves_directory: Option<bool>,
    pub hidden_descendants: Option<Hidden>,
    pub attribute: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub struct PolicyOptions<'a> {
    pub reviewed_xattrs: &'a [&'a str],
    pub hardening: bool,
    pub max_component_bytes: usize,
}

impl Default for PolicyOptions<'_> {
    fn default() -> Self {
        PolicyOptions { reviewed_xattrs: &[], hardening: true, max_component_bytes: 255 }
    }
}

/// `decideOperation(input, options)`.
pub fn decide_operation(input: &PolicyInput<'_>, options: &PolicyOptions<'_>) -> Decision {
    let Some(spec) = operation(input.op) else { return refuse("unknown_operation") };
    if spec.kind == Kind::Lifecycle {
        return Decision { no_data_io: true, ..serve(&spec) };
    }
    if spec.kind == Kind::Unsupported {
        return refuse(spec.refusal_code);
    }
    if input.names.iter().any(|(role, _)| !spec.names.contains(role)) || input.nodes.iter().any(|(role, _)| !spec.nodes.contains(role)) {
        return refuse("invalid_request");
    }
    let mut saw_protected = false;
    let mut saw_unproven = false;
    for role in spec.nodes {
        match input.nodes.iter().find(|(name, _)| name == role).and_then(|(_, state)| *state) {
            None => return refuse("invalid_request"),
            Some(NodeState::Protected) => saw_protected = true,
            Some(NodeState::Unproven) => saw_unproven = true,
            Some(NodeState::Ok) => {}
        }
    }
    if saw_protected {
        if spec.kind == Kind::Handle {
            return refuse("handle_observed_protected");
        }
        let hides_existence = matches!(spec.kind, Kind::NameQuery | Kind::NodeQuery | Kind::NameRemove);
        return if hides_existence { absent("node_under_protected_component") } else { refuse("node_under_protected_component") };
    }
    if saw_unproven {
        return refuse("binding_unproven");
    }
    if spec.kind == Kind::Forbidden {
        return refuse("ioctl_not_passed_through");
    }
    if spec.kind == Kind::Xattr {
        return match input.attribute {
            Some(attribute) if options.reviewed_xattrs.contains(&attribute) => serve(&spec),
            _ => refuse("xattr_not_reviewed"),
        };
    }
    let mut any_protected = false;
    for role in spec.names {
        match input.names.iter().find(|(name, _)| name == role) {
            Some((_, name)) if is_valid_component_name(name, options.max_component_bytes) => {
                if is_protected_name(name, options.hardening) {
                    any_protected = true;
                }
            }
            _ => return refuse("invalid_name"),
        }
    }
    match spec.kind {
        Kind::NameQuery => if any_protected { absent("protected_name") } else { serve(&spec) },
        Kind::NodeQuery | Kind::Handle => serve(&spec),
        Kind::NameCreate => if any_protected { refuse("protected_operand") } else { serve(&spec) },
        Kind::NameRemove => {
            if any_protected {
                absent("protected_name")
            } else if spec.directory {
                hidden_verdict(input.hidden_descendants, &spec)
            } else {
                serve(&spec)
            }
        }
        Kind::Rename => {
            if any_protected {
                return refuse("protected_operand");
            }
            match input.moves_directory {
                None => refuse("invalid_request"),
                Some(true) => hidden_verdict(input.hidden_descendants, &spec),
                Some(false) => serve(&spec),
            }
        }
        _ => refuse("unknown_operation"),
    }
}

fn hidden_verdict(value: Option<Hidden>, spec: &Spec) -> Decision {
    match value {
        Some(Hidden::No) => serve(spec),
        Some(Hidden::Yes) => refuse("hidden_descendants"),
        _ => refuse("hidden_descendants_unknown"),
    }
}

/// `filterDirectoryEntries(entries)`: the visible names and the omitted count. `.` and `..` pass.
pub fn filter_directory_entries<T: AsRef<[u8]>>(entries: Vec<T>, hardening: bool) -> (Vec<T>, usize) {
    let mut visible = Vec::with_capacity(entries.len());
    let mut omitted = 0;
    for name in entries {
        let bytes = name.as_ref();
        if bytes == b"." || bytes == b".." || !is_protected_name(bytes, hardening) {
            visible.push(name);
        } else {
            omitted += 1;
        }
    }
    (visible, omitted)
}

#[derive(Clone, Debug)]
pub struct ScanChild<R> {
    pub name: Vec<u8>,
    pub is_directory: bool,
    pub reference: R,
}

/// `scanForProtectedDescendants`: a bounded walk that never follows links. `list` returns the children of a directory
/// reference or an error. The answer is Yes, No, or Unknown when the budget is exhausted or a listing fails.
pub fn scan_for_protected_descendants<R, F>(root: R, mut list: F, max_entries: usize, hardening: bool) -> Hidden
where
    F: FnMut(&R) -> Result<Vec<ScanChild<R>>, ()>,
{
    let mut pending = vec![root];
    let mut visited = 0usize;
    while let Some(reference) = pending.pop() {
        let Ok(children) = list(&reference) else { return Hidden::Unknown };
        for child in children {
            visited += 1;
            if visited > max_entries {
                return Hidden::Unknown;
            }
            if is_protected_name(&child.name, hardening) {
                return Hidden::Yes;
            }
            if child.is_directory {
                pending.push(child.reference);
            }
        }
    }
    Hidden::No
}

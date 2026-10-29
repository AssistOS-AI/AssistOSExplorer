//! The file server's per-request logic (plan section 5.4): node and handle tracking, the binding-chain and current-name
//! checks, the handle state machine, post-read check sequencing and descriptor-cap accounting.
//!
//! A port of `createViewEngine` in `robo-work/server/views/viewEngine.mjs` (S5 r5), operation for operation, over an
//! injected [`Backing`]. It implements decision D2 option (a) ([`crate::d2::D2_DECISION`]) and the D-S5-6 root
//! revocation ([`ViewEngine::revoke_root`], driven by the keeper's SIGTERM in the real server).
//!
//! Additions the Node model does not have, all needed by the FUSE glue and all routed through the same policy and chain
//! checks: `attributes` (getattr with the backing's stat), `readlink`, `statfs`, `symlink`, `setattr` on a handle or a
//! node, `fsync`. Each is marked "addition" below and follows the operation class the policy gives it.
//!
//! Backing contract (synchronous; descriptors are opaque; every lookup is no-follow and relative to a held directory
//! descriptor, never by path): see [`Backing`]. `identity_at`, `identity_of` and `list_children` must not open
//! descriptors that outlive the call.

use std::collections::{HashMap, HashSet};

use crate::ledger::{CapRefusal, DescriptorLedger};
use crate::names::is_protected_name;
use crate::policy::{
    Decision, Hidden, NodeState, Outcome, PolicyInput, PolicyOptions, ScanChild, decide_operation, filter_directory_entries,
    scan_for_protected_descendants,
};

pub const ROOT_NODE_ID: u64 = 1;

/// Device and inode of a backing object (plan section 5.4, "Current-name check"). An identity that cannot be obtained
/// is `None` and is never equal to anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Identity {
    pub dev: u64,
    pub ino: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub identity: Option<Identity>,
    pub kind: EntryKind,
}

/// One directory entry: name, kind and the backing inode number (reported as d_ino only).
pub type DirEntry = (Vec<u8>, EntryKind, u64);

/// An errno name, for example "EIO".
pub type Errno = &'static str;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    /// A node descriptor (O_PATH on Linux): identity and *at anchor only.
    Node { directory: bool },
    /// A directory handle for listing.
    DirHandle,
    /// A file handle. Never carries O_CREAT, O_EXCL or O_TRUNC: mutations reach the backing only through operations
    /// the policy classifies.
    FileHandle { read: bool, write: bool, append: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct SetAttr {
    pub mode: Option<u32>,
    pub size: Option<u64>,
    pub atime_ns: Option<Option<i128>>,
    pub mtime_ns: Option<Option<i128>>,
}

pub trait Backing {
    type Desc: Copy + Eq + std::fmt::Debug;
    type Attr: Clone + std::fmt::Debug;
    type StatFs: Clone + std::fmt::Debug;

    fn root_descriptor(&self) -> Self::Desc;
    /// `Ok(None)` for ENOENT.
    fn identity_at(&mut self, dir: Self::Desc, name: &[u8]) -> Result<Option<Entry>, Errno>;
    fn identity_of(&mut self, desc: Self::Desc) -> Option<Identity>;
    /// `name == b"."` reopens `dir` itself.
    fn open_at(&mut self, dir: Self::Desc, name: &[u8], mode: OpenMode) -> Result<Self::Desc, Errno>;
    fn close(&mut self, desc: Self::Desc);
    fn read(&mut self, desc: Self::Desc, offset: u64, length: u32) -> Result<Vec<u8>, Errno>;
    fn write(&mut self, desc: Self::Desc, offset: u64, data: &[u8]) -> Result<usize, Errno>;
    /// Entries without `.` and `..`: (name, kind, backing inode number for d_ino).
    fn list_dir(&mut self, desc: Self::Desc) -> Result<Vec<DirEntry>, Errno>;
    /// Children (name, is_directory) of the directory reached by `rel` from `dir`, without following links.
    fn list_children(&mut self, dir: Self::Desc, rel: &[Vec<u8>]) -> Result<Vec<(Vec<u8>, bool)>, Errno>;
    fn create_at(&mut self, dir: Self::Desc, name: &[u8], directory: bool, mode: u32) -> Result<(), Errno>;
    fn remove_at(&mut self, dir: Self::Desc, name: &[u8], directory: bool) -> Result<(), Errno>;
    fn rename_at(&mut self, dir: Self::Desc, name: &[u8], new_dir: Self::Desc, new_name: &[u8], exchange: bool, noreplace: bool) -> Result<(), Errno>;
    /// Links the source node, given by its descriptor and by its bound parent and name (Linux cannot link an O_PATH
    /// descriptor without CAP_DAC_READ_SEARCH, so the Linux backing links by parent and name; the binding chain of the
    /// source was verified just before).
    fn link_at(&mut self, source: Self::Desc, source_parent: Self::Desc, source_name: &[u8], new_dir: Self::Desc, new_name: &[u8]) -> Result<(), Errno>;
    // Additions used by the FUSE glue.
    fn attributes(&mut self, desc: Self::Desc) -> Result<Self::Attr, Errno>;
    fn readlink(&mut self, desc: Self::Desc) -> Result<Vec<u8>, Errno>;
    fn statfs(&mut self, desc: Self::Desc) -> Result<Self::StatFs, Errno>;
    fn symlink_at(&mut self, target: &[u8], dir: Self::Desc, name: &[u8]) -> Result<(), Errno>;
    fn set_attributes(&mut self, desc: Self::Desc, change: &SetAttr) -> Result<(), Errno>;
    fn fsync(&mut self, desc: Self::Desc, datasync: bool) -> Result<(), Errno>;
}

/// The outcome of one engine operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply<T> {
    Serve(T),
    /// Indistinguishable from a missing entry: ENOENT.
    Absent(&'static str),
    Refused { code: &'static str, errno: Errno },
    BackingError(Errno),
}

impl<T> Reply<T> {
    pub fn errno(&self) -> Option<Errno> {
        match self {
            Reply::Serve(_) => None,
            Reply::Absent(_) => Some("ENOENT"),
            Reply::Refused { errno, .. } => Some(errno),
            Reply::BackingError(errno) => Some(errno),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Reply::Serve(_) => "allowed",
            Reply::Absent(code) => code,
            Reply::Refused { code, .. } => code,
            Reply::BackingError(_) => "backing_error",
        }
    }

    pub fn is_serve(&self) -> bool {
        matches!(self, Reply::Serve(_))
    }
}

fn from_decision<T>(decision: Decision) -> Reply<T> {
    match decision.outcome {
        Outcome::Absent => Reply::Absent(decision.code),
        _ => Reply::Refused { code: decision.code, errno: decision.errno_hint.unwrap_or("EACCES") },
    }
}

fn refused<T>(code: &'static str, errno: Errno) -> Reply<T> {
    Reply::Refused { code, errno }
}

fn cap_refused<T>(_: CapRefusal) -> Reply<T> {
    refused(CapRefusal::CODE, CapRefusal::ERRNO)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LookupReply {
    pub node_id: u64,
    pub kind: EntryKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteReply {
    pub written: usize,
    /// The post-check found a protected name: the handle is now refused for everything, but the bytes written stand.
    pub tainted: bool,
    pub post_check: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateReply {
    pub node_id: Option<u64>,
    pub kind: Option<EntryKind>,
    pub tainted: bool,
}

#[derive(Debug)]
struct Node<D> {
    parent: Option<u64>,
    name: Vec<u8>,
    desc: D,
    token: Option<u64>,
    identity: Identity,
    kind: EntryKind,
    nlookup: u64,
    child_refs: u64,
    handle_refs: u64,
    broken: bool,
}

#[derive(Debug)]
struct Handle<D> {
    node: u64,
    desc: D,
    token: u64,
    directory: bool,
    observed: bool,
}

pub struct ViewEngine<B: Backing> {
    backing: B,
    ledger: DescriptorLedger,
    hardening: bool,
    max_component_bytes: usize,
    max_binding_chain_depth: usize,
    max_descendant_scan_entries: usize,
    reviewed_xattrs: Vec<&'static str>,
    nodes: HashMap<u64, Node<B::Desc>>,
    handles: HashMap<u64, Handle<B::Desc>>,
    child_index: HashMap<(u64, Vec<u8>), u64>,
    next_node_id: u64,
    next_handle: u64,
    invalidation_order: Vec<u64>,
    invalidation_set: HashSet<u64>,
}

#[derive(Clone, Copy, Debug)]
pub struct EngineLimits {
    pub descriptor_cap: usize,
    pub max_binding_chain_depth: usize,
    pub max_descendant_scan_entries: usize,
    pub max_component_bytes: usize,
}

impl Default for EngineLimits {
    /// The provisional VIEW_LIMIT_DEFAULTS values.
    fn default() -> Self {
        EngineLimits { descriptor_cap: 1024, max_binding_chain_depth: 128, max_descendant_scan_entries: 65536, max_component_bytes: 255 }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum EngineInitError {
    RootIdentityUnavailable,
}

impl<B: Backing> ViewEngine<B> {
    pub fn new(mut backing: B, limits: EngineLimits, hardening: bool) -> Result<Self, EngineInitError> {
        let root_desc = backing.root_descriptor();
        let identity = backing.identity_of(root_desc).ok_or(EngineInitError::RootIdentityUnavailable)?;
        let mut nodes = HashMap::new();
        nodes.insert(ROOT_NODE_ID, Node {
            parent: None, name: Vec::new(), desc: root_desc, token: None, identity, kind: EntryKind::Dir,
            nlookup: 1, child_refs: 0, handle_refs: 0, broken: false,
        });
        Ok(ViewEngine {
            backing,
            ledger: DescriptorLedger::new(limits.descriptor_cap),
            hardening,
            max_component_bytes: limits.max_component_bytes,
            max_binding_chain_depth: limits.max_binding_chain_depth,
            max_descendant_scan_entries: limits.max_descendant_scan_entries,
            reviewed_xattrs: Vec::new(),
            nodes,
            handles: HashMap::new(),
            child_index: HashMap::new(),
            next_node_id: ROOT_NODE_ID + 1,
            next_handle: 1,
            invalidation_order: Vec::new(),
            invalidation_set: HashSet::new(),
        })
    }

    pub fn backing(&self) -> &B {
        &self.backing
    }

    pub fn backing_mut(&mut self) -> &mut B {
        &mut self.backing
    }

    fn decide(&self, op: &str, names: Vec<(&str, &[u8])>, nodes: Vec<(&str, NodeState)>, moves: Option<bool>, hidden: Option<Hidden>) -> Decision {
        let input = PolicyInput {
            op,
            names,
            nodes: nodes.into_iter().map(|(role, state)| (role, Some(state))).collect(),
            moves_directory: moves,
            hidden_descendants: hidden,
            attribute: None,
        };
        let options = PolicyOptions { reviewed_xattrs: &self.reviewed_xattrs, hardening: self.hardening, max_component_bytes: self.max_component_bytes };
        decide_operation(&input, &options)
    }

    fn decide_node(&self, op: &str, state: NodeState) -> Decision {
        self.decide(op, vec![], vec![("subject", state)], None, None)
    }

    fn queue_invalidation(&mut self, id: u64) {
        if self.invalidation_set.insert(id) {
            self.invalidation_order.push(id);
        }
    }

    fn mark_broken(&mut self, id: u64) {
        let Some(node) = self.nodes.get_mut(&id) else { return };
        if node.broken {
            return;
        }
        node.broken = true;
        self.queue_invalidation(id);
    }

    fn mark_observed(&mut self, fh: u64) {
        let Some(handle) = self.handles.get_mut(&fh) else { return };
        if handle.observed {
            return;
        }
        handle.observed = true;
        let node = handle.node;
        self.queue_invalidation(node);
    }

    fn root_broken(&self) -> bool {
        self.nodes.get(&ROOT_NODE_ID).is_some_and(|root| root.broken)
    }

    /// The binding chain and current name (plan section 5.4): from the node up to the grant root, then top-down, each
    /// component must still be bound to the same object under its recorded name, re-resolved no-follow from the
    /// parent's held descriptor, with the identity of its held descriptor. Unbound is sticky ('protected'); a failure to
    /// get an answer is 'unproven' (refused now, not sticky). A revoked root makes every node protected first.
    fn chain_state(&mut self, id: u64) -> NodeState {
        if self.root_broken() {
            self.mark_broken(id);
            return NodeState::Protected;
        }
        let Some(node) = self.nodes.get(&id) else { return NodeState::Unproven };
        if node.broken {
            return NodeState::Protected;
        }
        let mut chain = Vec::new();
        let mut current = id;
        while let Some(parent) = self.nodes.get(&current).and_then(|node| node.parent) {
            chain.push(current);
            if chain.len() > self.max_binding_chain_depth {
                return NodeState::Unproven;
            }
            current = parent;
        }
        for &component_id in chain.iter().rev() {
            let (parent_desc, name, desc, recorded, broken) = {
                let component = &self.nodes[&component_id];
                let parent = &self.nodes[&component.parent.expect("chain components have parents")];
                (parent.desc, component.name.clone(), component.desc, component.identity, component.broken)
            };
            if broken || is_protected_name(&name, self.hardening) {
                self.mark_broken(id);
                return NodeState::Protected;
            }
            let entry = match self.backing.identity_at(parent_desc, &name) {
                Ok(entry) => entry,
                Err(_) => return NodeState::Unproven,
            };
            let held = self.backing.identity_of(desc);
            let Some(entry) = entry else {
                self.mark_broken(component_id);
                self.mark_broken(id);
                return NodeState::Protected;
            };
            let (Some(entry_identity), Some(held)) = (entry.identity, held) else { return NodeState::Unproven };
            if entry_identity != held || held != recorded {
                self.mark_broken(component_id);
                self.mark_broken(id);
                return NodeState::Protected;
            }
        }
        NodeState::Ok
    }

    fn release_node(&mut self, id: u64) {
        let mut current = id;
        loop {
            let Some(node) = self.nodes.get(&current) else { return };
            let Some(parent) = node.parent else { return };
            if node.nlookup != 0 || node.child_refs != 0 || node.handle_refs != 0 {
                return;
            }
            let node = self.nodes.remove(&current).expect("present");
            self.backing.close(node.desc);
            if let Some(token) = node.token {
                self.ledger.release(token);
            }
            let key = (parent, node.name);
            if self.child_index.get(&key) == Some(&current) {
                self.child_index.remove(&key);
            }
            if let Some(parent_node) = self.nodes.get_mut(&parent) {
                parent_node.child_refs -= 1;
            }
            current = parent;
        }
    }

    fn register_node(&mut self, parent: u64, name: &[u8], entry: Entry, token: u64) -> Reply<u64> {
        let parent_desc = self.nodes[&parent].desc;
        let desc = match self.backing.open_at(parent_desc, name, OpenMode::Node { directory: entry.kind == EntryKind::Dir }) {
            Ok(desc) => desc,
            Err(_) => {
                self.ledger.release(token);
                return refused("binding_unproven", "EIO");
            }
        };
        let held = self.backing.identity_of(desc);
        let Some(identity) = held.filter(|held| Some(*held) == entry.identity) else {
            self.backing.close(desc);
            self.ledger.release(token);
            return refused("binding_unproven", "EIO");
        };
        let id = self.next_node_id;
        self.next_node_id += 1;
        self.nodes.insert(id, Node {
            parent: Some(parent), name: name.to_vec(), desc, token: Some(token), identity, kind: entry.kind,
            nlookup: 1, child_refs: 0, handle_refs: 0, broken: false,
        });
        self.nodes.get_mut(&parent).expect("parent").child_refs += 1;
        self.child_index.insert((parent, name.to_vec()), id);
        Reply::Serve(id)
    }

    fn require_node(&self, id: u64) -> Result<(), Errno> {
        if self.nodes.contains_key(&id) { Ok(()) } else { Err("ESTALE") }
    }

    pub fn lookup(&mut self, parent: u64, name: &[u8]) -> Reply<LookupReply> {
        if self.require_node(parent).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let state = self.chain_state(parent);
        let verdict = self.decide("lookup", vec![("name", name)], vec![("subject", state)], None, None);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let parent_desc = self.nodes[&parent].desc;
        let entry = match self.backing.identity_at(parent_desc, name) {
            Ok(Some(entry)) => entry,
            Ok(None) => return Reply::Absent("not_found"),
            Err(_) => return refused("binding_unproven", "EIO"),
        };
        let Some(identity) = entry.identity else { return refused("binding_unproven", "EIO") };
        if let Some(&existing) = self.child_index.get(&(parent, name.to_vec())) {
            if let Some(node) = self.nodes.get_mut(&existing) {
                if !node.broken && node.identity == identity {
                    node.nlookup += 1;
                    return Reply::Serve(LookupReply { node_id: existing, kind: node.kind });
                }
            }
        }
        let token = match self.ledger.acquire("node") {
            Ok(token) => token,
            Err(refusal) => return cap_refused(refusal),
        };
        match self.register_node(parent, name, entry, token) {
            Reply::Serve(id) => Reply::Serve(LookupReply { node_id: id, kind: entry.kind }),
            Reply::Refused { code, errno } => refused(code, errno),
            _ => refused("binding_unproven", "EIO"),
        }
    }

    /// `forget(nodeId, count)`. Lifecycle: always served (DR-3). An over-count is clamped rather than thrown, because
    /// the kernel's count is authoritative and a panic would kill the server.
    pub fn forget(&mut self, id: u64, count: u64) {
        let Some(node) = self.nodes.get_mut(&id) else { return };
        if node.parent.is_none() {
            return;
        }
        node.nlookup = node.nlookup.saturating_sub(count.max(1));
        self.release_node(id);
    }

    pub fn getattr(&mut self, id: u64) -> Reply<(Identity, EntryKind)> {
        if self.require_node(id).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let state = self.chain_state(id);
        let verdict = self.decide_node("getattr", state);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let node = &self.nodes[&id];
        Reply::Serve((node.identity, node.kind))
    }

    /// Addition: getattr with the backing's attributes, checked like `getattr`, and the binding re-checked after the
    /// stat so that attributes of a node found under a protected name are never returned.
    pub fn attributes(&mut self, id: u64) -> Reply<B::Attr> {
        match self.getattr(id) {
            Reply::Serve(_) => {}
            Reply::Absent(code) => return Reply::Absent(code),
            Reply::Refused { code, errno } => return refused(code, errno),
            Reply::BackingError(errno) => return Reply::BackingError(errno),
        }
        let desc = self.nodes[&id].desc;
        let attr = match self.backing.attributes(desc) {
            Ok(attr) => attr,
            Err(errno) => return Reply::BackingError(errno),
        };
        let after = self.chain_state(id);
        let verdict = self.decide_node("getattr", after);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        Reply::Serve(attr)
    }

    fn open_handle(&mut self, id: u64, op: &'static str, mode: OpenMode) -> Reply<u64> {
        if self.require_node(id).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let directory = matches!(mode, OpenMode::DirHandle);
        let state = self.chain_state(id);
        let verdict = self.decide_node(op, state);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let (node_kind, node_desc, parent, name, identity) = {
            let node = &self.nodes[&id];
            (node.kind, node.desc, node.parent, node.name.clone(), node.identity)
        };
        if directory != (node_kind == EntryKind::Dir) {
            return refused("invalid_request", if directory { "ENOTDIR" } else { "EISDIR" });
        }
        let token = match self.ledger.acquire(if directory { "dir-handle" } else { "file-handle" }) {
            Ok(token) => token,
            Err(refusal) => return cap_refused(refusal),
        };
        let opened = match parent {
            // The grant root has no parent in the view: it is reopened relative to itself.
            None => self.backing.open_at(node_desc, b".", OpenMode::DirHandle),
            Some(parent) => {
                let parent_desc = self.nodes[&parent].desc;
                self.backing.open_at(parent_desc, &name, mode)
            }
        };
        let desc = match opened {
            Ok(desc) => desc,
            Err(_) => {
                self.ledger.release(token);
                return refused("binding_unproven", "EIO");
            }
        };
        let held = self.backing.identity_of(desc);
        // The new descriptor must be the node, and the binding must still hold after the open.
        if held != Some(identity) || self.chain_state(id) != NodeState::Ok {
            self.backing.close(desc);
            self.ledger.release(token);
            let state = if self.nodes[&id].broken { NodeState::Protected } else { NodeState::Unproven };
            return from_decision(self.decide_node(op, state));
        }
        let fh = self.next_handle;
        self.next_handle += 1;
        self.nodes.get_mut(&id).expect("node").handle_refs += 1;
        self.handles.insert(fh, Handle { node: id, desc, token, directory, observed: false });
        Reply::Serve(fh)
    }

    pub fn open(&mut self, id: u64, read: bool, write: bool, append: bool) -> Reply<u64> {
        self.open_handle(id, "open", OpenMode::FileHandle { read, write, append })
    }

    pub fn opendir(&mut self, id: u64) -> Reply<u64> {
        self.open_handle(id, "opendir", OpenMode::DirHandle)
    }

    /// `release` / `releasedir`: lifecycle, always served (DR-3).
    pub fn release(&mut self, fh: u64) {
        let Some(handle) = self.handles.remove(&fh) else { return };
        self.backing.close(handle.desc);
        self.ledger.release(handle.token);
        if let Some(node) = self.nodes.get_mut(&handle.node) {
            node.handle_refs -= 1;
        }
        self.release_node(handle.node);
    }

    fn handle_state(&mut self, fh: u64) -> NodeState {
        let handle = &self.handles[&fh];
        if handle.observed {
            return NodeState::Protected;
        }
        let node = handle.node;
        let state = self.chain_state(node);
        if state == NodeState::Protected {
            self.mark_observed(fh);
        }
        state
    }

    /// Read-class operations: handle state and pre-check, backing operation, post-check, then data. Data never leaves
    /// unless the post-check still finds an ordinary binding.
    fn read_class<T>(&mut self, op: &'static str, fh: u64, run: impl FnOnce(&mut B, B::Desc) -> Result<T, Errno>) -> Reply<T> {
        if !self.handles.contains_key(&fh) {
            return refused("invalid_request", "EBADF");
        }
        let before = self.handle_state(fh);
        let verdict = self.decide_node(op, before);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let desc = self.handles[&fh].desc;
        let data = match run(&mut self.backing, desc) {
            Ok(data) => data,
            Err(errno) => return Reply::BackingError(errno),
        };
        let after = self.handle_state(fh);
        let verdict = self.decide_node(op, after);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        Reply::Serve(data)
    }

    pub fn read(&mut self, fh: u64, offset: u64, length: u32) -> Reply<Vec<u8>> {
        self.read_class("read", fh, |backing, desc| backing.read(desc, offset, length))
    }

    /// A mapping fault is a read for the policy (D2 (a) admits no direct-I/O mapping opt-in).
    pub fn mapping_fault(&mut self, fh: u64, offset: u64, length: u32) -> Reply<Vec<u8>> {
        self.read_class("mapping_fault", fh, |backing, desc| backing.read(desc, offset, length))
    }

    /// Returns the visible entries and the omitted count.
    pub fn readdir(&mut self, fh: u64) -> Reply<(Vec<DirEntry>, usize)> {
        match self.handles.get(&fh) {
            None => return refused("invalid_request", "EBADF"),
            Some(handle) if !handle.directory => return refused("invalid_request", "ENOTDIR"),
            Some(_) => {}
        }
        match self.read_class("readdir", fh, |backing, desc| backing.list_dir(desc)) {
            Reply::Serve(entries) => {
                let names: Vec<Vec<u8>> = entries.iter().map(|(name, _, _)| name.clone()).collect();
                let (visible, omitted) = filter_directory_entries(names, self.hardening);
                // Set lookup (review R1): linear in the directory size, not quadratic.
                let visible: HashSet<Vec<u8>> = visible.into_iter().collect();
                let kept: Vec<DirEntry> = entries.into_iter().filter(|(name, _, _)| visible.contains(name)).collect();
                Reply::Serve((kept, omitted))
            }
            Reply::Absent(code) => Reply::Absent(code),
            Reply::Refused { code, errno } => refused(code, errno),
            Reply::BackingError(errno) => Reply::BackingError(errno),
        }
    }

    /// Write-class: the effect is reported as it was. A post-check that finds a protected name taints the handle for
    /// every later operation, but the result keeps the bytes written and is never reported as refused.
    pub fn write(&mut self, fh: u64, offset: u64, data: &[u8]) -> Reply<WriteReply> {
        self.write_class("write", fh, |backing, desc| backing.write(desc, offset, data))
    }

    fn write_class(&mut self, op: &'static str, fh: u64, run: impl FnOnce(&mut B, B::Desc) -> Result<usize, Errno>) -> Reply<WriteReply> {
        if !self.handles.contains_key(&fh) {
            return refused("invalid_request", "EBADF");
        }
        let before = self.handle_state(fh);
        let verdict = self.decide_node(op, before);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let desc = self.handles[&fh].desc;
        let written = match run(&mut self.backing, desc) {
            Ok(written) => written,
            Err(errno) => return Reply::BackingError(errno),
        };
        let after = self.handle_state(fh);
        let verdict = self.decide_node(op, after);
        let tainted = verdict.outcome != Outcome::Serve;
        Reply::Serve(WriteReply { written, tainted, post_check: if tainted { verdict.code } else { "ordinary" } })
    }

    /// Addition: setattr through an open handle (write class: truthful outcome, taint on a failed post-check).
    pub fn setattr_handle(&mut self, fh: u64, change: &SetAttr) -> Reply<WriteReply> {
        let change = sanitize(change);
        self.write_class("setattr", fh, |backing, desc| backing.set_attributes(desc, &change).map(|()| 0))
    }

    /// Addition: setattr on a node without a handle (chmod, truncate, utimens by path). The node's binding is checked
    /// before and after, like a write: an effect that happened is reported, never relabelled.
    pub fn setattr_node(&mut self, id: u64, change: &SetAttr) -> Reply<WriteReply> {
        if self.require_node(id).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let change = sanitize(change);
        let before = self.chain_state(id);
        let verdict = self.decide_node("setattr", before);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        // A size change needs a writable descriptor: open one for the duration, counted by the ledger.
        let result = if change.size.is_some() {
            match self.open_handle(id, "open", OpenMode::FileHandle { read: false, write: true, append: false }) {
                Reply::Serve(fh) => {
                    let desc = self.handles[&fh].desc;
                    let outcome = self.backing.set_attributes(desc, &change);
                    self.release(fh);
                    outcome
                }
                Reply::Absent(code) => return Reply::Absent(code),
                Reply::Refused { code, errno } => return refused(code, errno),
                Reply::BackingError(errno) => return Reply::BackingError(errno),
            }
        } else {
            let desc = self.nodes[&id].desc;
            self.backing.set_attributes(desc, &change)
        };
        if let Err(errno) = result {
            return Reply::BackingError(errno);
        }
        let after = self.chain_state(id);
        let verdict = self.decide_node("setattr", after);
        let tainted = verdict.outcome != Outcome::Serve;
        Reply::Serve(WriteReply { written: 0, tainted, post_check: if tainted { verdict.code } else { "ordinary" } })
    }

    /// The backing attributes of a node WITHOUT a policy check. Only for the reply to a write-class operation that took
    /// effect and tainted its node (D2: an effected write is reported truthfully, never relabelled as a refusal).
    pub fn raw_attributes_after_effect(&mut self, id: u64) -> Result<B::Attr, Errno> {
        let desc = self.nodes.get(&id).ok_or("ESTALE")?.desc;
        self.backing.attributes(desc)
    }

    /// Addition: fsync on a handle (handle class, no data).
    pub fn fsync(&mut self, fh: u64, datasync: bool) -> Reply<()> {
        self.read_class("fsync", fh, |backing, desc| backing.fsync(desc, datasync))
    }

    /// Addition: readlink (node query with the discard-on-failure post-check).
    pub fn readlink(&mut self, id: u64) -> Reply<Vec<u8>> {
        if self.require_node(id).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let before = self.chain_state(id);
        let verdict = self.decide_node("readlink", before);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        if self.nodes[&id].kind != EntryKind::Symlink {
            return refused("invalid_request", "EINVAL");
        }
        let desc = self.nodes[&id].desc;
        let target = match self.backing.readlink(desc) {
            Ok(target) => target,
            Err(errno) => return Reply::BackingError(errno),
        };
        let after = self.chain_state(id);
        let verdict = self.decide_node("readlink", after);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        Reply::Serve(target)
    }

    /// Addition: statfs (node query).
    pub fn statfs(&mut self, id: u64) -> Reply<B::StatFs> {
        if self.require_node(id).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let state = self.chain_state(id);
        let verdict = self.decide_node("statfs", state);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let desc = self.nodes[&id].desc;
        match self.backing.statfs(desc) {
            Ok(value) => Reply::Serve(value),
            Err(errno) => Reply::BackingError(errno),
        }
    }

    fn create_common(&mut self, parent: u64, name: &[u8], op: &'static str, act: impl FnOnce(&mut B, B::Desc) -> Result<(), Errno>) -> Reply<CreateReply> {
        if self.require_node(parent).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let state = self.chain_state(parent);
        let verdict = self.decide(op, vec![("name", name)], vec![("subject", state)], None, None);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        // Reserve the descriptor first: at the cap the create is refused before it has an effect.
        let token = match self.ledger.acquire("node") {
            Ok(token) => token,
            Err(refusal) => return cap_refused(refusal),
        };
        let parent_desc = self.nodes[&parent].desc;
        if let Err(errno) = act(&mut self.backing, parent_desc) {
            self.ledger.release(token);
            return Reply::BackingError(errno);
        }
        let entry = self.backing.identity_at(parent_desc, name).ok().flatten().filter(|entry| entry.identity.is_some());
        let Some(entry) = entry else {
            self.ledger.release(token);
            return Reply::Serve(CreateReply { node_id: None, kind: None, tainted: false });
        };
        let node = match self.register_node(parent, name, entry, token) {
            Reply::Serve(node) => node,
            // register_node released the token.
            _ => return Reply::Serve(CreateReply { node_id: None, kind: None, tainted: false }),
        };
        if self.chain_state(node) != NodeState::Ok {
            self.nodes.get_mut(&node).expect("node").nlookup = 0;
            self.release_node(node);
            return Reply::Serve(CreateReply { node_id: None, kind: None, tainted: true });
        }
        let kind = self.nodes[&node].kind;
        Reply::Serve(CreateReply { node_id: Some(node), kind: Some(kind), tainted: false })
    }

    /// `create(parentId, name, { directory })`. `mode` is sanitized (set-ID bits cleared).
    pub fn create(&mut self, parent: u64, name: &[u8], directory: bool, mode: u32) -> Reply<CreateReply> {
        let mode = mode & 0o1777;
        self.create_common(parent, name, if directory { "mkdir" } else { "create" }, |backing, dir| backing.create_at(dir, name, directory, mode))
    }

    /// Addition: symlink (name create). The target string is not checked (DR-6: links resolve in the robot's
    /// namespace, through the view, where protected names are absent).
    pub fn symlink(&mut self, parent: u64, name: &[u8], target: &[u8]) -> Reply<CreateReply> {
        self.create_common(parent, name, "symlink", |backing, dir| backing.symlink_at(target, dir, name))
    }

    pub fn link(&mut self, source: u64, new_parent: u64, new_name: &[u8]) -> Reply<LookupReply> {
        if self.require_node(source).is_err() || self.require_node(new_parent).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let parent_state = self.chain_state(new_parent);
        let source_state = self.chain_state(source);
        let verdict = self.decide("link", vec![("name", new_name)], vec![("subject", parent_state), ("source", source_state)], None, None);
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let (source_desc, parent_desc) = (self.nodes[&source].desc, self.nodes[&new_parent].desc);
        let Some(source_parent) = self.nodes[&source].parent else { return refused("invalid_request", "EPERM") };
        let (source_parent_desc, source_name) = (self.nodes[&source_parent].desc, self.nodes[&source].name.clone());
        if let Err(errno) = self.backing.link_at(source_desc, source_parent_desc, &source_name, parent_desc, new_name) {
            return Reply::BackingError(errno);
        }
        // The kernel counts the LINK entry reply as a lookup of the linked inode (glue obligation: reply with this id).
        let node = self.nodes.get_mut(&source).expect("source");
        node.nlookup += 1;
        Reply::Serve(LookupReply { node_id: source, kind: node.kind })
    }

    fn hidden_descendants_of(&mut self, parent: u64, name: &[u8]) -> Hidden {
        let parent_desc = self.nodes[&parent].desc;
        let max = self.max_descendant_scan_entries;
        let hardening = self.hardening;
        let backing = &mut self.backing;
        scan_for_protected_descendants(
            vec![name.to_vec()],
            |relative: &Vec<Vec<u8>>| {
                backing.list_children(parent_desc, relative).map_err(|_| ()).map(|children| {
                    children.into_iter().map(|(child, is_directory)| {
                        let mut reference = relative.clone();
                        reference.push(child.clone());
                        ScanChild { name: child, is_directory, reference }
                    }).collect()
                })
            },
            max,
            hardening,
        )
    }

    pub fn remove(&mut self, parent: u64, name: &[u8], directory: bool) -> Reply<()> {
        if self.require_node(parent).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let op = if directory { "rmdir" } else { "unlink" };
        let state = self.chain_state(parent);
        // The scan only runs when it can matter; a protected name or a bad parent is answered before it.
        let preliminary = self.decide(op, vec![("name", name)], vec![("subject", state)], None, Some(Hidden::No));
        if preliminary.outcome != Outcome::Serve {
            return from_decision(preliminary);
        }
        if directory {
            let hidden = self.hidden_descendants_of(parent, name);
            let verdict = self.decide(op, vec![("name", name)], vec![("subject", state)], None, Some(hidden));
            if verdict.outcome != Outcome::Serve {
                return from_decision(verdict);
            }
        }
        let parent_desc = self.nodes[&parent].desc;
        match self.backing.remove_at(parent_desc, name, directory) {
            Ok(()) => Reply::Serve(()),
            Err(errno) => Reply::BackingError(errno),
        }
    }

    /// A rename through the view keeps the recorded bindings in step; a rename by anybody else in the backing is
    /// detected by the binding chain instead.
    pub fn rename(&mut self, parent: u64, name: &[u8], new_parent: u64, new_name: &[u8], exchange: bool, noreplace: bool) -> Reply<()> {
        if self.require_node(parent).is_err() || self.require_node(new_parent).is_err() {
            return refused("invalid_request", "ESTALE");
        }
        let Some(&source) = self.child_index.get(&(parent, name.to_vec())) else { return refused("invalid_request", "ENOENT") };
        if !self.nodes.contains_key(&source) {
            return refused("invalid_request", "ENOENT");
        }
        let op = if exchange { "rename_exchange" } else { "rename" };
        let target = self.child_index.get(&(new_parent, new_name.to_vec())).copied().filter(|id| self.nodes.contains_key(id));
        let states = [self.chain_state(parent), self.chain_state(new_parent), self.chain_state(source)];
        let base_nodes = || vec![("subject", states[0]), ("newParent", states[1]), ("source", states[2])];
        let names = || vec![("name", name), ("newName", new_name)];
        let preliminary = self.decide(op, names(), base_nodes(), Some(false), None);
        if preliminary.outcome != Outcome::Serve {
            return from_decision(preliminary);
        }
        // The target of an exchange is resolved afresh, never taken from the tracked node.
        let fresh_target = if exchange {
            let new_parent_desc = self.nodes[&new_parent].desc;
            self.backing.identity_at(new_parent_desc, new_name).ok().flatten()
        } else {
            None
        };
        let target_identity = target.map(|id| self.nodes[&id].identity);
        let target_unsure = exchange && match fresh_target {
            None => true,
            Some(entry) => entry.identity.is_none()
                || !matches!(entry.kind, EntryKind::File | EntryKind::Dir | EntryKind::Symlink)
                || target_identity.is_some_and(|identity| Some(identity) != entry.identity),
        };
        let target_is_directory = exchange && fresh_target.is_some_and(|entry| entry.kind == EntryKind::Dir);
        let source_is_directory = self.nodes[&source].kind == EntryKind::Dir;
        let moves_directory = source_is_directory || target_is_directory || target_unsure;
        let mut hidden = Hidden::No;
        if source_is_directory {
            hidden = self.hidden_descendants_of(parent, name);
        }
        if target_is_directory || target_unsure {
            let other = self.hidden_descendants_of(new_parent, new_name);
            hidden = combine_hidden(hidden, other);
        }
        let verdict = self.decide(op, names(), base_nodes(), Some(moves_directory), Some(hidden));
        if verdict.outcome != Outcome::Serve {
            return from_decision(verdict);
        }
        let (parent_desc, new_parent_desc) = (self.nodes[&parent].desc, self.nodes[&new_parent].desc);
        if let Err(errno) = self.backing.rename_at(parent_desc, name, new_parent_desc, new_name, exchange, noreplace) {
            return Reply::BackingError(errno);
        }
        self.child_index.remove(&(parent, name.to_vec()));
        self.child_index.remove(&(new_parent, new_name.to_vec()));
        if let (Some(target), false) = (target, exchange) {
            // The replaced entry no longer exists under that name; its binding fails on next use.
            self.mark_broken(target);
        }
        self.move_node(source, new_parent, new_name);
        if let (Some(target), true) = (target, exchange) {
            if fresh_target.and_then(|entry| entry.identity) == target_identity {
                self.move_node(target, parent, name);
            } else {
                self.mark_broken(target);
            }
        }
        Reply::Serve(())
    }

    fn move_node(&mut self, id: u64, to_parent: u64, to_name: &[u8]) {
        let old_parent = self.nodes[&id].parent.expect("not the root");
        self.nodes.get_mut(&old_parent).expect("parent").child_refs -= 1;
        let node = self.nodes.get_mut(&id).expect("node");
        node.parent = Some(to_parent);
        node.name = to_name.to_vec();
        self.nodes.get_mut(&to_parent).expect("parent").child_refs += 1;
        self.child_index.insert((to_parent, to_name.to_vec()), id);
    }

    /// Root revocation (decision D-S5-6): what the file server does on the keeper's SIGTERM. Sticky. Every live node
    /// becomes protected and every open handle observed, so new requests are refused or absent with no backing call,
    /// data from an in-flight read is discarded by its post-check, and an in-flight write reports its true outcome.
    /// Each live node is queued for invalidation once. Lifecycle requests stay served. Returns whether it was already revoked.
    pub fn revoke_root(&mut self) -> bool {
        let already = self.root_broken();
        let ids: Vec<u64> = {
            let mut ids: Vec<u64> = self.nodes.keys().copied().collect();
            ids.sort_unstable();
            ids
        };
        for id in ids {
            self.mark_broken(id);
        }
        let mut fhs: Vec<u64> = self.handles.keys().copied().collect();
        fhs.sort_unstable();
        for fh in fhs {
            self.mark_observed(fh);
        }
        already
    }

    pub fn root_state(&self) -> NodeState {
        if self.root_broken() { NodeState::Protected } else { NodeState::Ok }
    }

    /// Best-effort invalidation intents, deduplicated, in first-detection order; clears the queue.
    pub fn take_invalidations(&mut self) -> Vec<u64> {
        self.invalidation_set.clear();
        std::mem::take(&mut self.invalidation_order)
    }

    pub fn chain_state_of(&mut self, id: u64) -> Option<NodeState> {
        if self.nodes.contains_key(&id) { Some(self.chain_state(id)) } else { None }
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len() - 1
    }

    pub fn handle_count(&self) -> usize {
        self.handles.len()
    }

    pub fn ledger(&self) -> &DescriptorLedger {
        &self.ledger
    }

    pub fn node_kind(&self, id: u64) -> Option<EntryKind> {
        self.nodes.get(&id).map(|node| node.kind)
    }

    /// Releases every handle and node (teardown); returns the descriptors closed.
    pub fn close_all(&mut self) -> usize {
        let mut closed = 0;
        for (_, handle) in self.handles.drain() {
            self.backing.close(handle.desc);
            closed += 1;
        }
        let ids: Vec<u64> = self.nodes.keys().copied().filter(|id| *id != ROOT_NODE_ID).collect();
        for id in ids {
            if let Some(node) = self.nodes.remove(&id) {
                self.backing.close(node.desc);
                closed += 1;
            }
        }
        closed
    }
}

fn sanitize(change: &SetAttr) -> SetAttr {
    // Set-ID bits never reach the backing (defence in depth beside the nosuid mount).
    SetAttr { mode: change.mode.map(|mode| mode & 0o1777), ..*change }
}

fn combine_hidden(left: Hidden, right: Hidden) -> Hidden {
    if left == Hidden::Yes || right == Hidden::Yes {
        Hidden::Yes
    } else if left == Hidden::No && right == Hidden::No {
        Hidden::No
    } else {
        Hidden::Unknown
    }
}

//! View-engine scenarios ported from the S5 Node tests (viewEngine.test.mjs, S5 decisions delta section 9.2), run
//! against an in-memory backing whose descriptors follow their inode across renames, as on Linux. Model evidence only:
//! no FUSE, no kernel.

use std::collections::{BTreeMap, HashMap};

use rw_fsview::engine::{Backing, EntryKind, Entry, Errno, Identity, OpenMode, Reply, SetAttr, ViewEngine, EngineLimits, ROOT_NODE_ID};
use rw_fsview::policy::NodeState;

#[derive(Clone, Debug)]
enum Kind {
    Dir(BTreeMap<Vec<u8>, u64>),
    File(Vec<u8>),
    Link(Vec<u8>),
}

type Hook = Box<dyn FnMut(&mut Fake)>;

#[derive(Default)]
struct Fake {
    inodes: HashMap<u64, Kind>,
    next_ino: u64,
    descs: HashMap<u64, u64>,
    next_desc: u64,
    calls: HashMap<&'static str, usize>,
    hooks: Vec<(&'static str, Hook)>,
    fail_identity_at: usize,
}

impl Fake {
    fn new() -> Self {
        let mut fake = Fake { next_ino: 2, next_desc: 100, ..Default::default() };
        fake.inodes.insert(1, Kind::Dir(BTreeMap::new()));
        fake.descs.insert(99, 1);
        fake
    }
    fn resolve(&self, path: &str) -> u64 {
        let mut ino = 1;
        for part in path.split('/').filter(|part| !part.is_empty()) {
            let Kind::Dir(children) = &self.inodes[&ino] else { panic!("not a dir: {path}") };
            ino = children[part.as_bytes()];
        }
        ino
    }
    fn split(path: &str) -> (&str, &str) {
        path.rsplit_once('/').unwrap_or(("", path))
    }
    fn add(&mut self, path: &str, kind: Kind) -> u64 {
        let (parent, name) = Fake::split(path);
        let parent = self.resolve(parent);
        let ino = self.next_ino;
        self.next_ino += 1;
        self.inodes.insert(ino, kind);
        let Kind::Dir(children) = self.inodes.get_mut(&parent).unwrap() else { panic!() };
        children.insert(name.as_bytes().to_vec(), ino);
        ino
    }
    fn mkdir(&mut self, path: &str) -> u64 {
        self.add(path, Kind::Dir(BTreeMap::new()))
    }
    fn write_file(&mut self, path: &str, data: &str) -> u64 {
        self.add(path, Kind::File(data.as_bytes().to_vec()))
    }
    /// Another writer's rename in the backing.
    fn mv(&mut self, from: &str, to: &str) {
        let (from_parent, from_name) = Fake::split(from);
        let (to_parent, to_name) = Fake::split(to);
        let (from_parent, to_parent) = (self.resolve(from_parent), self.resolve(to_parent));
        let Kind::Dir(children) = self.inodes.get_mut(&from_parent).unwrap() else { panic!() };
        let ino = children.remove(from_name.as_bytes()).unwrap();
        let Kind::Dir(children) = self.inodes.get_mut(&to_parent).unwrap() else { panic!() };
        children.insert(to_name.as_bytes().to_vec(), ino);
    }
    fn after(&mut self, op: &'static str, hook: impl FnMut(&mut Fake) + 'static) {
        self.hooks.push((op, Box::new(hook)));
    }
    fn count(&mut self, op: &'static str) {
        *self.calls.entry(op).or_default() += 1;
    }
    fn fire(&mut self, op: &'static str) {
        if let Some(index) = self.hooks.iter().position(|(name, _)| *name == op) {
            let (_, mut hook) = self.hooks.remove(index);
            hook(self);
        }
    }
    fn ino(&self, desc: u64) -> Result<u64, Errno> {
        self.descs.get(&desc).copied().ok_or("EBADF")
    }
    fn child(&self, dir: u64, name: &[u8]) -> Result<Option<u64>, Errno> {
        let Kind::Dir(children) = &self.inodes[&self.ino(dir)?] else { return Err("ENOTDIR") };
        Ok(children.get(name).copied())
    }
    fn kind_of(&self, ino: u64) -> EntryKind {
        match self.inodes[&ino] {
            Kind::Dir(_) => EntryKind::Dir,
            Kind::File(_) => EntryKind::File,
            Kind::Link(_) => EntryKind::Symlink,
        }
    }
    fn open_count(&self) -> usize {
        self.descs.len() - 1
    }
}

impl Backing for Fake {
    type Desc = u64;
    type Attr = (u64, EntryKind);
    type StatFs = u64;

    fn root_descriptor(&self) -> u64 {
        99
    }
    fn identity_at(&mut self, dir: u64, name: &[u8]) -> Result<Option<Entry>, Errno> {
        self.count("identityAt");
        if self.fail_identity_at > 0 {
            self.fail_identity_at -= 1;
            return Err("EACCES");
        }
        let found = self.child(dir, name)?.map(|ino| Entry { identity: Some(Identity { dev: 1, ino }), kind: self.kind_of(ino) });
        self.fire("identityAt");
        Ok(found)
    }
    fn identity_of(&mut self, desc: u64) -> Option<Identity> {
        self.ino(desc).ok().map(|ino| Identity { dev: 1, ino })
    }
    fn open_at(&mut self, dir: u64, name: &[u8], mode: OpenMode) -> Result<u64, Errno> {
        self.count("openAt");
        let ino = if name == b"." { self.ino(dir)? } else { self.child(dir, name)?.ok_or("ENOENT")? };
        if matches!(mode, OpenMode::DirHandle | OpenMode::Node { directory: true }) && self.kind_of(ino) != EntryKind::Dir {
            return Err("ENOTDIR");
        }
        let desc = self.next_desc;
        self.next_desc += 1;
        self.descs.insert(desc, ino);
        Ok(desc)
    }
    fn close(&mut self, desc: u64) {
        assert!(self.descs.remove(&desc).is_some(), "double close of {desc}");
    }
    fn read(&mut self, desc: u64, offset: u64, length: u32) -> Result<Vec<u8>, Errno> {
        self.count("read");
        let Kind::File(data) = &self.inodes[&self.ino(desc)?] else { return Err("EISDIR") };
        let start = (offset as usize).min(data.len());
        let out = data[start..(start + length as usize).min(data.len())].to_vec();
        self.fire("read");
        Ok(out)
    }
    fn write(&mut self, desc: u64, offset: u64, bytes: &[u8]) -> Result<usize, Errno> {
        self.count("write");
        let ino = self.ino(desc)?;
        let Kind::File(data) = self.inodes.get_mut(&ino).unwrap() else { return Err("EISDIR") };
        let end = offset as usize + bytes.len();
        if data.len() < end {
            data.resize(end, 0);
        }
        data[offset as usize..end].copy_from_slice(bytes);
        self.fire("write");
        Ok(bytes.len())
    }
    fn list_dir(&mut self, desc: u64) -> Result<Vec<rw_fsview::engine::DirEntry>, Errno> {
        self.count("listDir");
        let Kind::Dir(children) = &self.inodes[&self.ino(desc)?] else { return Err("ENOTDIR") };
        Ok(children.iter().map(|(name, ino)| (name.clone(), self.kind_of(*ino), *ino)).collect())
    }
    fn list_children(&mut self, dir: u64, rel: &[Vec<u8>]) -> Result<Vec<(Vec<u8>, bool)>, Errno> {
        self.count("listChildren");
        let mut ino = self.ino(dir)?;
        for part in rel {
            let Kind::Dir(children) = &self.inodes[&ino] else { return Err("ENOTDIR") };
            ino = *children.get(part).ok_or("ENOENT")?;
        }
        let Kind::Dir(children) = &self.inodes[&ino] else { return Err("ENOTDIR") };
        let out = children.iter().map(|(name, child)| (name.clone(), matches!(self.inodes[child], Kind::Dir(_)))).collect();
        self.fire("listChildren");
        Ok(out)
    }
    fn create_at(&mut self, dir: u64, name: &[u8], directory: bool, _mode: u32) -> Result<(), Errno> {
        self.count("createAt");
        let parent = self.ino(dir)?;
        let ino = self.next_ino;
        self.next_ino += 1;
        self.inodes.insert(ino, if directory { Kind::Dir(BTreeMap::new()) } else { Kind::File(Vec::new()) });
        let Kind::Dir(children) = self.inodes.get_mut(&parent).unwrap() else { return Err("ENOTDIR") };
        if children.contains_key(name) {
            return Err("EEXIST");
        }
        children.insert(name.to_vec(), ino);
        self.fire("createAt");
        Ok(())
    }
    fn remove_at(&mut self, dir: u64, name: &[u8], _directory: bool) -> Result<(), Errno> {
        self.count("removeAt");
        let parent = self.ino(dir)?;
        let Kind::Dir(children) = self.inodes.get_mut(&parent).unwrap() else { return Err("ENOTDIR") };
        children.remove(name).ok_or("ENOENT").map(|_| ())
    }
    fn rename_at(&mut self, dir: u64, name: &[u8], new_dir: u64, new_name: &[u8], exchange: bool, _noreplace: bool) -> Result<(), Errno> {
        self.count("renameAt");
        let (from, to) = (self.ino(dir)?, self.ino(new_dir)?);
        let Kind::Dir(children) = self.inodes.get_mut(&from).unwrap() else { return Err("ENOTDIR") };
        let moving = children.remove(name).ok_or("ENOENT")?;
        let Kind::Dir(children) = self.inodes.get_mut(&to).unwrap() else { return Err("ENOTDIR") };
        let replaced = children.insert(new_name.to_vec(), moving);
        if exchange {
            let other = replaced.ok_or("ENOENT")?;
            let Kind::Dir(children) = self.inodes.get_mut(&from).unwrap() else { return Err("ENOTDIR") };
            children.insert(name.to_vec(), other);
        }
        Ok(())
    }
    fn link_at(&mut self, source: u64, _source_parent: u64, _source_name: &[u8], new_dir: u64, new_name: &[u8]) -> Result<(), Errno> {
        let (ino, parent) = (self.ino(source)?, self.ino(new_dir)?);
        let Kind::Dir(children) = self.inodes.get_mut(&parent).unwrap() else { return Err("ENOTDIR") };
        children.insert(new_name.to_vec(), ino);
        Ok(())
    }
    fn attributes(&mut self, desc: u64) -> Result<(u64, EntryKind), Errno> {
        let ino = self.ino(desc)?;
        Ok((ino, self.kind_of(ino)))
    }
    fn readlink(&mut self, desc: u64) -> Result<Vec<u8>, Errno> {
        match &self.inodes[&self.ino(desc)?] {
            Kind::Link(target) => Ok(target.clone()),
            _ => Err("EINVAL"),
        }
    }
    fn statfs(&mut self, _desc: u64) -> Result<u64, Errno> {
        Ok(4096)
    }
    fn symlink_at(&mut self, target: &[u8], dir: u64, name: &[u8]) -> Result<(), Errno> {
        let parent = self.ino(dir)?;
        let ino = self.next_ino;
        self.next_ino += 1;
        self.inodes.insert(ino, Kind::Link(target.to_vec()));
        let Kind::Dir(children) = self.inodes.get_mut(&parent).unwrap() else { return Err("ENOTDIR") };
        children.insert(name.to_vec(), ino);
        Ok(())
    }
    fn set_attributes(&mut self, desc: u64, change: &SetAttr) -> Result<(), Errno> {
        let ino = self.ino(desc)?;
        if let (Some(size), Kind::File(data)) = (change.size, self.inodes.get_mut(&ino).unwrap()) {
            data.resize(size as usize, 0);
        }
        Ok(())
    }
    fn fsync(&mut self, _desc: u64, _datasync: bool) -> Result<(), Errno> {
        Ok(())
    }
}

fn engine_with(fake: Fake, cap: usize) -> ViewEngine<Fake> {
    ViewEngine::new(fake, EngineLimits { descriptor_cap: cap, ..EngineLimits::default() }, true).unwrap()
}

fn node(reply: Reply<rw_fsview::engine::LookupReply>) -> u64 {
    match reply {
        Reply::Serve(found) => found.node_id,
        other => panic!("{other:?}"),
    }
}

fn fh(reply: Reply<u64>) -> u64 {
    match reply {
        Reply::Serve(fh) => fh,
        other => panic!("{other:?}"),
    }
}

fn base() -> Fake {
    let mut fake = Fake::new();
    fake.mkdir("D");
    fake.write_file("D/a.txt", "hello");
    fake.write_file(".env", "SECRET=1");
    fake.mkdir(".ploinky");
    fake.write_file("notes.md", "n");
    fake
}

#[test]
fn name_rules_on_lookup_listing_and_create() {
    let mut engine = engine_with(base(), 64);
    assert!(engine.lookup(ROOT_NODE_ID, b"D").is_serve());
    assert_eq!(engine.lookup(ROOT_NODE_ID, b".env"), Reply::Absent("protected_name"));
    assert_eq!(engine.lookup(ROOT_NODE_ID, b".ENV."), Reply::Absent("protected_name"));
    assert_eq!(engine.lookup(ROOT_NODE_ID, b"missing"), Reply::Absent("not_found"));
    let dir = fh(engine.opendir(ROOT_NODE_ID));
    let Reply::Serve((entries, omitted)) = engine.readdir(dir) else { panic!() };
    let names: Vec<Vec<u8>> = entries.iter().map(|(name, _, _)| name.clone()).collect();
    assert_eq!(names, vec![b"D".to_vec(), b"notes.md".to_vec()]);
    assert_eq!(entries[0].1, EntryKind::Dir);
    assert_eq!(omitted, 2);
    assert_eq!(engine.create(ROOT_NODE_ID, b".env", false, 0o644).code(), "protected_operand");
    assert_eq!(engine.create(ROOT_NODE_ID, b".roboteam", true, 0o755).code(), "protected_operand");
    assert!(engine.create(ROOT_NODE_ID, b"new.txt", false, 0o644).is_serve());
    assert_eq!(engine.lookup(ROOT_NODE_ID, b"a/b").code(), "invalid_name");
}

#[test]
fn directory_renamed_to_protected_cuts_off_cwd_and_held_fd() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    let held = fh(engine.opendir(d));
    engine.backing_mut().mv("D", ".data");
    assert_eq!(engine.lookup(d, b"a.txt"), Reply::Absent("node_under_protected_component"));
    engine.backing_mut().write_file(".data/late.txt", "late");
    assert_eq!(engine.lookup(d, b"late.txt"), Reply::Absent("node_under_protected_component"));
    assert_eq!(engine.create(d, b"x", false, 0o644).code(), "node_under_protected_component");
    assert_eq!(engine.readdir(held).code(), "handle_observed_protected");
    assert_eq!(engine.getattr(d), Reply::Absent("node_under_protected_component"));
    // Sticky: renaming back does not restore it (D-S5-3).
    engine.backing_mut().mv(".data", "D");
    assert_eq!(engine.chain_state_of(d), Some(NodeState::Protected));
}

#[test]
fn directory_moved_under_protected_and_ordinary_rename() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    engine.backing_mut().mv("D", ".ploinky/D");
    assert_eq!(engine.lookup(d, b"a.txt"), Reply::Absent("node_under_protected_component"));
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    engine.backing_mut().mv("D", "E");
    assert_eq!(engine.chain_state_of(d), Some(NodeState::Protected), "an unprovable binding refuses (K1)");
}

#[test]
fn replacement_is_detected_by_identity() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    engine.backing_mut().mv("D", "D-old");
    engine.backing_mut().mkdir("D");
    assert_eq!(engine.chain_state_of(d), Some(NodeState::Protected));
}

#[test]
fn post_read_check_discards_data_and_handle_stays_refused() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    let file = node(engine.lookup(d, b"a.txt"));
    let handle = fh(engine.open(file, true, false, false));
    assert_eq!(engine.read(handle, 0, 5), Reply::Serve(b"hello".to_vec()), "negative control: served before the rename");
    engine.backing_mut().after("read", |fake| fake.mv("D/a.txt", "D/.env"));
    assert_eq!(engine.read(handle, 0, 5).code(), "handle_observed_protected");
    let reads = engine.backing().calls["read"];
    assert_eq!(engine.read(handle, 0, 5).code(), "handle_observed_protected");
    assert_eq!(engine.mapping_fault(handle, 0, 5).code(), "handle_observed_protected");
    assert_eq!(engine.backing().calls["read"], reads, "no backing read after observation");
    assert_eq!(engine.take_invalidations(), vec![file]);
}

#[test]
fn write_reports_true_outcome_and_taints() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    let file = node(engine.lookup(d, b"a.txt"));
    let handle = fh(engine.open(file, false, true, false));
    engine.backing_mut().after("write", |fake| fake.mv("D/a.txt", "D/master-key"));
    match engine.write(handle, 0, b"HELLO") {
        Reply::Serve(reply) => {
            assert_eq!(reply.written, 5);
            assert!(reply.tainted);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(engine.write(handle, 0, b"x").code(), "handle_observed_protected");
}

#[test]
fn root_revocation_refuses_everything_without_backing_calls() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    let file = node(engine.lookup(d, b"a.txt"));
    let read_handle = fh(engine.open(file, true, false, false));
    assert!(!engine.revoke_root());
    let before: HashMap<&str, usize> = engine.backing().calls.clone();
    assert_eq!(engine.chain_state_of(ROOT_NODE_ID), Some(NodeState::Protected));
    assert_eq!(engine.lookup(ROOT_NODE_ID, b"D"), Reply::Absent("node_under_protected_component"));
    assert_eq!(engine.getattr(file), Reply::Absent("node_under_protected_component"));
    assert_eq!(engine.read(read_handle, 0, 1).code(), "handle_observed_protected");
    assert_eq!(engine.write(read_handle, 0, b"x").code(), "handle_observed_protected");
    assert_eq!(engine.create(ROOT_NODE_ID, b"n", false, 0o644).code(), "node_under_protected_component");
    for op in ["read", "write", "identityAt"] {
        assert_eq!(engine.backing().calls.get(op), before.get(op), "{op}");
    }
    // Lifecycle stays served.
    engine.release(read_handle);
    engine.forget(file, 1);
    let mut queued = engine.take_invalidations();
    queued.sort_unstable();
    assert_eq!(queued, vec![ROOT_NODE_ID, d, file]);
    assert!(engine.take_invalidations().is_empty());
    assert!(engine.revoke_root(), "idempotent");
    assert!(engine.take_invalidations().is_empty(), "no new intents on a second revocation");
}

#[test]
fn d2_post_read_rename_and_write_after_revocation() {
    let mut fake = base();
    fake.write_file("f.txt", "abc");
    let mut engine = engine_with(fake, 64);
    let file = node(engine.lookup(ROOT_NODE_ID, b"f.txt"));
    let handle = fh(engine.open(file, true, true, false));
    // A revocation that lands while the backing read runs: modelled by breaking the root binding from the hook is not
    // possible (the engine is borrowed), so the read is followed by a rename of the file into a protected name, and the
    // revocation path is covered by root_revocation_refuses_everything_without_backing_calls.
    engine.backing_mut().after("read", |fake| fake.mv("f.txt", ".data"));
    assert_eq!(engine.read(handle, 0, 3).code(), "handle_observed_protected");
    let mut engine2 = engine_with(base(), 64);
    let f = node(engine2.lookup(ROOT_NODE_ID, b"notes.md"));
    let h = fh(engine2.open(f, false, true, false));
    engine2.revoke_root();
    assert_eq!(engine2.write(h, 0, b"z").code(), "handle_observed_protected");
}

#[test]
fn twin_engine_outcomes_do_not_depend_on_draining_invalidations() {
    let run = |drain: bool| {
        let mut engine = engine_with(base(), 64);
        let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
        let mut outcomes = Vec::new();
        engine.backing_mut().mv("D", ".data");
        outcomes.push(engine.lookup(d, b"a.txt").code());
        if drain {
            engine.take_invalidations();
        }
        engine.revoke_root();
        if drain {
            engine.take_invalidations();
        }
        outcomes.push(engine.lookup(ROOT_NODE_ID, b"notes.md").code());
        outcomes
    };
    assert_eq!(run(true), run(false));
}

#[test]
fn descriptor_cap_refuses_new_and_never_evicts() {
    let mut engine = engine_with(base(), 2);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    let _notes = node(engine.lookup(ROOT_NODE_ID, b"notes.md"));
    assert_eq!(engine.lookup(d, b"a.txt"), Reply::Refused { code: "descriptor_cap", errno: "EMFILE" });
    assert_eq!(engine.opendir(d), Reply::Refused { code: "descriptor_cap", errno: "EMFILE" });
    assert_eq!(engine.node_count(), 2);
    assert_eq!(engine.create(ROOT_NODE_ID, b"c.txt", false, 0o644), Reply::Refused { code: "descriptor_cap", errno: "EMFILE" });
    assert!(engine.backing().calls.get("createAt").is_none(), "refused before any effect");
    engine.forget(d, 1);
    assert!(engine.lookup(ROOT_NODE_ID, b"D").is_serve());
}

#[test]
fn descriptors_are_released_with_their_nodes() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    let file = node(engine.lookup(d, b"a.txt"));
    let handle = fh(engine.open(file, true, false, false));
    assert_eq!(engine.backing().open_count(), 3);
    engine.forget(d, 1);
    assert_eq!(engine.backing().open_count(), 3, "a child keeps its parent");
    engine.forget(file, 1);
    assert_eq!(engine.backing().open_count(), 3, "an open handle keeps its node");
    engine.release(handle);
    assert_eq!(engine.backing().open_count(), 0);
    assert_eq!(engine.ledger().in_use(), 0);
}

#[test]
fn dr1_hidden_descendants_and_exchange() {
    let mut fake = base();
    fake.mkdir("H");
    fake.write_file("H/.env", "x");
    fake.write_file("F.txt", "f");
    fake.mkdir("Clean");
    let mut engine = engine_with(fake, 64);
    assert_eq!(engine.remove(ROOT_NODE_ID, b"H", true).code(), "hidden_descendants");
    assert_eq!(engine.remove(ROOT_NODE_ID, b".env", false), Reply::Absent("protected_name"));
    let _h = node(engine.lookup(ROOT_NODE_ID, b"H"));
    let _f = node(engine.lookup(ROOT_NODE_ID, b"F.txt"));
    assert_eq!(engine.rename(ROOT_NODE_ID, b"H", ROOT_NODE_ID, b"F.txt", true, false).code(), "hidden_descendants");
    assert!(engine.backing().calls.get("renameAt").is_none());
    // The documented residual: an entry created after the scan read the directory is not seen.
    let _clean = node(engine.lookup(ROOT_NODE_ID, b"Clean"));
    engine.backing_mut().after("listChildren", |fake| {
        fake.write_file("Clean/.env", "x");
    });
    assert!(engine.rename(ROOT_NODE_ID, b"Clean", ROOT_NODE_ID, b"Moved", false, false).is_serve());
}

#[test]
fn unproven_is_refused_and_not_sticky() {
    let mut engine = engine_with(base(), 64);
    let d = node(engine.lookup(ROOT_NODE_ID, b"D"));
    engine.backing_mut().fail_identity_at = 1;
    assert_eq!(engine.lookup(d, b"a.txt"), Reply::Refused { code: "binding_unproven", errno: "EIO" });
    assert!(engine.lookup(d, b"a.txt").is_serve());
}

#[test]
fn setattr_mode_strips_set_id_bits_and_readlink_post_check() {
    let mut fake = base();
    fake.add("ln", Kind::Link(b"D/a.txt".to_vec()));
    let mut engine = engine_with(fake, 64);
    let link = node(engine.lookup(ROOT_NODE_ID, b"ln"));
    assert_eq!(engine.readlink(link), Reply::Serve(b"D/a.txt".to_vec()));
    let file = node(engine.lookup(ROOT_NODE_ID, b"notes.md"));
    assert!(engine.setattr_node(file, &SetAttr { size: Some(0), ..SetAttr::default() }).is_serve());
    engine.backing_mut().mv("notes.md", "x.secrets");
    // setattr is a handle-class operation in the policy (OPERATIONS.setattr), so a protected node answers as a handle.
    assert_eq!(engine.setattr_node(file, &SetAttr { mode: Some(0o4755), ..SetAttr::default() }).code(), "handle_observed_protected");
}
